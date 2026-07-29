/**
 * Unit tests for MemoryCache edge cases and cacheFactory singleton behaviour.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.7, 4.8
 */

import { MemoryCache, createMemoryCache } from './memoryCache';
import { createCacheAdapter, getCacheBackend } from './cacheFactory';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a fresh MemoryCache with a controllable clock. */
function makeCache(startMs = 0) {
  let now = startMs;
  const clock = () => now;
  const advance = (ms: number) => { now += ms; };
  return { cache: new MemoryCache(clock), advance };
}

// ---------------------------------------------------------------------------
// Basic get / set / del
// ---------------------------------------------------------------------------

describe('MemoryCache — get on non-existent key', () => {
  it('returns null for a key that was never set', async () => {
    const { cache } = makeCache();
    const result = await cache.get('missing-key');
    expect(result).toBeNull();
  });

  it('returns null for an empty string key that was never set', async () => {
    const { cache } = makeCache();
    expect(await cache.get('')).toBeNull();
  });
});

describe('MemoryCache — set then get', () => {
  it('returns the stored value immediately after set', async () => {
    const { cache } = makeCache();
    await cache.set('greeting', 'hello', 60);
    expect(await cache.get('greeting')).toBe('hello');
  });

  it('returns the stored value for an empty-string value', async () => {
    const { cache } = makeCache();
    await cache.set('empty-val', '', 60);
    expect(await cache.get('empty-val')).toBe('');
  });

  it('overwrites an existing key with a new value', async () => {
    const { cache } = makeCache();
    await cache.set('k', 'first', 60);
    await cache.set('k', 'second', 60);
    expect(await cache.get('k')).toBe('second');
  });

  it('returns null after TTL has elapsed (lazy eviction)', async () => {
    const { cache, advance } = makeCache();
    await cache.set('ttl-key', 'value', 10); // 10 s TTL
    advance(10_000); // advance clock to exactly the expiry boundary
    expect(await cache.get('ttl-key')).toBeNull();
  });
});

describe('MemoryCache — del', () => {
  it('removes the specific entry; subsequent get returns null', async () => {
    const { cache } = makeCache();
    await cache.set('to-delete', 'data', 60);
    await cache.del('to-delete');
    expect(await cache.get('to-delete')).toBeNull();
  });

  it('does not affect other entries when a specific key is deleted', async () => {
    const { cache } = makeCache();
    await cache.set('keep', 'keep-value', 60);
    await cache.set('remove', 'remove-value', 60);
    await cache.del('remove');
    expect(await cache.get('keep')).toBe('keep-value');
    expect(await cache.get('remove')).toBeNull();
  });

  it('is a no-op when the key does not exist (no error thrown)', async () => {
    const { cache } = makeCache();
    await expect(cache.del('ghost')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// invalidateByPrefix
// ---------------------------------------------------------------------------

describe('MemoryCache — invalidateByPrefix', () => {
  it('removes only availability-prefixed keys and leaves other keys intact', async () => {
    const { cache } = makeCache();

    await cache.set('availability:1', 'avail-1', 60);
    await cache.set('availability:2', 'avail-2', 60);
    await cache.set('calendar-rates:1', 'rates-1', 60);

    const removed = await cache.invalidateByPrefix('availability:');

    expect(removed).toBe(2);
    expect(await cache.get('availability:1')).toBeNull();
    expect(await cache.get('availability:2')).toBeNull();
    expect(await cache.get('calendar-rates:1')).toBe('rates-1');
  });

  it('returns 0 and leaves cache unchanged when no keys match the prefix', async () => {
    const { cache } = makeCache();
    await cache.set('calendar-rates:1', 'rates-1', 60);

    const removed = await cache.invalidateByPrefix('availability:');

    expect(removed).toBe(0);
    expect(await cache.get('calendar-rates:1')).toBe('rates-1');
  });

  it('removes all entries when the prefix matches every key', async () => {
    const { cache } = makeCache();
    await cache.set('availability:a', 'v1', 60);
    await cache.set('availability:b', 'v2', 60);

    const removed = await cache.invalidateByPrefix('availability:');

    expect(removed).toBe(2);
    expect(cache.size).toBe(0);
  });

  it('returns 0 on an empty cache', async () => {
    const { cache } = makeCache();
    expect(await cache.invalidateByPrefix('availability:')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LRU eviction
// ---------------------------------------------------------------------------

describe('MemoryCache — LRU eviction', () => {
  it('evicts the first (LRU) entry when 1001 unique entries are inserted', async () => {
    const { cache } = makeCache();

    // Insert 1001 unique entries in order without any reads (no LRU promotion)
    for (let i = 0; i <= 1000; i++) {
      await cache.set(`key-${i}`, `value-${i}`, 600);
    }

    // The cache must not exceed the 1000-entry cap
    expect(cache.size).toBe(1000);

    // key-0 was the LRU entry and must have been evicted
    expect(await cache.get('key-0')).toBeNull();

    // key-1000 was the most recently inserted and must still be present
    expect(await cache.get('key-1000')).toBe('value-1000');
  });

  it('does not evict when exactly 1000 unique entries are inserted', async () => {
    const { cache } = makeCache();

    for (let i = 0; i < 1000; i++) {
      await cache.set(`key-${i}`, `value-${i}`, 600);
    }

    expect(cache.size).toBe(1000);
    // First entry should still be present (no overflow)
    expect(await cache.get('key-0')).toBe('value-0');
  });

  it('promotes a read entry above LRU so it is not evicted first', async () => {
    const { cache } = makeCache();

    // Fill to capacity
    for (let i = 0; i < 1000; i++) {
      await cache.set(`key-${i}`, `value-${i}`, 600);
    }

    // Promote key-0 to MRU by reading it
    await cache.get('key-0');

    // Insert one more entry — key-1 (now LRU) should be evicted, not key-0
    await cache.set('key-1000', 'value-1000', 600);

    expect(await cache.get('key-0')).toBe('value-0');   // promoted — still present
    expect(await cache.get('key-1')).toBeNull();         // was LRU — evicted
    expect(await cache.get('key-1000')).toBe('value-1000');
  });
});

// ---------------------------------------------------------------------------
// Warm-start singleton (cacheFactory)
// ---------------------------------------------------------------------------

describe('cacheFactory — warm-start singleton', () => {
  it('createCacheAdapter("memory") returns the same object reference on repeated calls', () => {
    const first = createCacheAdapter('memory');
    const second = createCacheAdapter('memory');
    expect(first).toBe(second);
  });

  it('data set via one reference is accessible via a second reference to the same singleton', async () => {
    const ref1 = createCacheAdapter('memory');
    const ref2 = createCacheAdapter('memory');

    // Use a unique key to avoid cross-test pollution from the shared singleton
    const key = `warm-start-test-${Date.now()}-${Math.random()}`;
    await ref1.set(key, 'singleton-value', 60);

    expect(await ref2.get(key)).toBe('singleton-value');

    // Clean up to avoid polluting other tests
    await ref1.del(key);
  });

  it('getCacheBackend returns "memory" when CACHE_BACKEND is not set', () => {
    const original = process.env.CACHE_BACKEND;
    delete process.env.CACHE_BACKEND;
    expect(getCacheBackend()).toBe('memory');
    if (original !== undefined) {
      process.env.CACHE_BACKEND = original;
    }
  });

  it('getCacheBackend returns "redis" when CACHE_BACKEND=redis', () => {
    const original = process.env.CACHE_BACKEND;
    process.env.CACHE_BACKEND = 'redis';
    expect(getCacheBackend()).toBe('redis');
    if (original !== undefined) {
      process.env.CACHE_BACKEND = original;
    } else {
      delete process.env.CACHE_BACKEND;
    }
  });
});

// ---------------------------------------------------------------------------
// createMemoryCache factory
// ---------------------------------------------------------------------------

describe('createMemoryCache', () => {
  it('returns a fresh MemoryCache instance each time', () => {
    const a = createMemoryCache();
    const b = createMemoryCache();
    expect(a).not.toBe(b);
  });

  it('accepts a custom clock function', async () => {
    let t = 0;
    const cache = createMemoryCache(() => t);
    await cache.set('k', 'v', 5); // 5 s TTL
    t = 4_999;
    expect(await cache.get('k')).toBe('v');
    t = 5_000;
    expect(await cache.get('k')).toBeNull();
  });
});
