/**
 * CacheAdapter interface — backend-agnostic cache contract.
 * Implemented by both MemoryCache (in-Lambda) and the Redis adapter.
 */
export interface CacheAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  invalidateByPrefix(prefix: string): Promise<number>;
}

interface CacheEntry {
  value: string;
  expiresAtMs: number;
}

const MAX_ENTRIES = 1000;

/**
 * In-Lambda bounded LRU TTL cache.
 *
 * Uses a Map<string, CacheEntry> whose insertion order tracks recency.
 * On every read or write the entry is deleted and re-inserted so it moves
 * to the "most recently used" tail of the Map.  The head of the Map is
 * therefore always the least-recently-used entry and is the first candidate
 * for eviction when the cap is reached.
 *
 * TTL is enforced lazily: expired entries are detected on `get()` and
 * removed at that point; no background sweep is needed.
 */
export class MemoryCache implements CacheAdapter {
  private readonly store = new Map<string, CacheEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Current number of live entries (includes entries that may be expired but not yet evicted). */
  get size(): number {
    return this.store.size;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }

    // Lazy TTL eviction
    if (this.now() >= entry.expiresAtMs) {
      this.store.delete(key);
      return null;
    }

    // Move to MRU position (tail of Map)
    this.store.delete(key);
    this.store.set(key, entry);

    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    const expiresAtMs = this.now() + ttlSeconds * 1_000;

    // If the key already exists, remove it first so the re-insert below
    // always places it at the MRU tail regardless of prior position.
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= MAX_ENTRIES) {
      // Evict the LRU entry (first key in insertion order)
      const lruKey = this.store.keys().next().value;
      if (lruKey !== undefined) {
        this.store.delete(lruKey);
      }
    }

    this.store.set(key, { value, expiresAtMs });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async invalidateByPrefix(prefix: string): Promise<number> {
    let count = 0;
    for (const key of Array.from(this.store.keys())) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        count += 1;
      }
    }
    return count;
  }
}

/**
 * Factory function that returns a new MemoryCache instance.
 * The module-level singleton pattern (for warm-start persistence) is
 * managed by cacheFactory.ts; this factory is kept simple and testable.
 */
export function createMemoryCache(now?: () => number): MemoryCache {
  return new MemoryCache(now);
}
