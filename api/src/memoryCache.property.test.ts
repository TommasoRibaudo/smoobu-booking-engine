/**
 * Property-based tests for MemoryCache
 *
 * Feature: infra-cost-optimization
 * Property 1: Cache TTL round-trip
 * Property 2: Size invariant with LRU eviction
 * Property 3: Delete and invalidateByPrefix correctness
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.7, 4.8
 */

import * as fc from 'fast-check';
import { MemoryCache } from './memoryCache';

describe('MemoryCache — Property 1: Cache TTL round-trip', () => {
  /**
   * Feature: infra-cost-optimization, Property 1: Cache TTL round-trip
   *
   * For any key-value pair stored with a given TTL:
   *   - get(key) before TTL elapsed returns the stored value
   *   - get(key) at TTL elapsed returns null
   *   - get(key) after TTL elapsed returns null
   *
   * Validates: Requirements 4.1, 4.2, 4.3
   */
  it('Property 1: Cache TTL round-trip — get before expiry returns value, get at/after expiry returns null', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.string(),
        fc.integer({ min: 1, max: 600 }),
        async (key, value, ttlSeconds) => {
          // Each run gets its own controllable clock and fresh cache instance
          let currentTime = 0;
          const now = () => currentTime;
          const cache = new MemoryCache(now);

          // Store the entry at time 0
          await cache.set(key, value, ttlSeconds);

          // Just before expiry: ttlSeconds * 1000 - 1 ms
          currentTime = ttlSeconds * 1000 - 1;
          const beforeExpiry = await cache.get(key);
          if (beforeExpiry !== value) {
            return false;
          }

          // At expiry: ttlSeconds * 1000 ms — entry should be gone
          currentTime = ttlSeconds * 1000;
          const atExpiry = await cache.get(key);
          if (atExpiry !== null) {
            return false;
          }

          // After expiry: ttlSeconds * 1000 + 1 ms — still gone
          currentTime = ttlSeconds * 1000 + 1;
          const afterExpiry = await cache.get(key);
          if (afterExpiry !== null) {
            return false;
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('MemoryCache — Property 2: Size invariant with LRU eviction', () => {
  /**
   * Feature: infra-cost-optimization, Property 2: Size invariant with LRU eviction
   *
   * For any sequence of set operations, the stored entry count never exceeds 1000.
   * When overflow occurs, the LRU entry is evicted.
   *
   * Validates: Requirements 4.7
   */
  it('Property 2a: cache.size never exceeds 1000 after any sequence of set operations', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            key: fc.string(),
            value: fc.string(),
            ttl: fc.integer({ min: 1, max: 600 }),
          }),
          { minLength: 0, maxLength: 1200 }
        ),
        async (ops) => {
          const cache = new MemoryCache();

          for (const op of ops) {
            await cache.set(op.key, op.value, op.ttl);
            if (cache.size > 1000) {
              return false;
            }
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 2b: when 1001+ unique keys are inserted in sequence, the first key is evicted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { minLength: 1001, maxLength: 1100 }),
        async (rawKeys) => {
          // Deduplicate while preserving insertion order
          const uniqueKeys = Array.from(new Set(rawKeys));

          // Need at least 1001 unique keys to trigger eviction
          if (uniqueKeys.length < 1001) {
            return true; // skip — not enough unique keys after dedup
          }

          const cache = new MemoryCache();
          const firstKey = uniqueKeys[0];

          // Insert all unique keys in order without any reads (no LRU promotion)
          for (const key of uniqueKeys) {
            await cache.set(key, 'v', 600);
          }

          // Size must not exceed 1000
          if (cache.size > 1000) {
            return false;
          }

          // The first key (LRU candidate) must have been evicted
          const result = await cache.get(firstKey);
          return result === null;
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('MemoryCache — Property 3: Delete and invalidateByPrefix correctness', () => {
  /**
   * Feature: infra-cost-optimization, Property 3: Delete and invalidateByPrefix correctness
   *
   * 3a: For any set of entries with known prefixes and any target prefix string,
   *     invalidateByPrefix(targetPrefix + ':') removes exactly the entries whose
   *     keys start with that prefix and returns the correct count.
   *
   * 3b: For any set of entries and a specific key, del(key) removes only that key
   *     and subsequent get(key) returns null, while other keys remain accessible.
   *
   * Validates: Requirements 4.3, 4.4, 4.8
   */

  it('Property 3a: invalidateByPrefix removes all and only matching entries and returns correct count', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            prefix: fc.string({ minLength: 1, maxLength: 5 }),
            suffix: fc.string(),
          }),
          { minLength: 1, maxLength: 50 }
        ),
        fc.string({ minLength: 1, maxLength: 5 }),
        async (entries, targetPrefix) => {
          const cache = new MemoryCache();

          // Build full keys as `${prefix}:${suffix}` for clear prefix boundaries.
          // Deduplicate: if the same key appears multiple times, last value wins.
          const keyValueMap = new Map<string, string>();
          for (const entry of entries) {
            const key = `${entry.prefix}:${entry.suffix}`;
            keyValueMap.set(key, `value-${entry.prefix}-${entry.suffix}`);
          }

          // Insert all deduplicated entries
          for (const [key, value] of keyValueMap) {
            await cache.set(key, value, 600);
          }

          const searchPrefix = `${targetPrefix}:`;

          // Determine expected matching and non-matching keys
          const matchingKeys: string[] = [];
          const nonMatchingKeys: string[] = [];
          for (const key of keyValueMap.keys()) {
            if (key.startsWith(searchPrefix)) {
              matchingKeys.push(key);
            } else {
              nonMatchingKeys.push(key);
            }
          }

          // Capture expected values for non-matching keys before invalidation
          const nonMatchingExpected = new Map<string, string>();
          for (const key of nonMatchingKeys) {
            nonMatchingExpected.set(key, keyValueMap.get(key)!);
          }

          // Perform invalidation
          const count = await cache.invalidateByPrefix(searchPrefix);

          // Count must equal the number of matching keys
          if (count !== matchingKeys.length) {
            return false;
          }

          // All matching keys must now return null
          for (const key of matchingKeys) {
            const result = await cache.get(key);
            if (result !== null) {
              return false;
            }
          }

          // All non-matching keys must still return their original values
          for (const [key, expectedValue] of nonMatchingExpected) {
            const result = await cache.get(key);
            if (result !== expectedValue) {
              return false;
            }
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 3b: del(key) removes only that specific entry; other entries remain accessible', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            key: fc.string(),
            value: fc.string(),
          }),
          { minLength: 1, maxLength: 50 }
        ),
        fc.integer({ min: 0, max: 49 }),
        async (entries, rawIdx) => {
          // Deduplicate: last value wins for duplicate keys
          const keyValueMap = new Map<string, string>();
          for (const entry of entries) {
            keyValueMap.set(entry.key, entry.value);
          }

          const uniqueEntries = Array.from(keyValueMap.entries());

          // Clamp index to the actual deduplicated array length
          const idx = rawIdx % uniqueEntries.length;
          const [targetKey] = uniqueEntries[idx];

          const cache = new MemoryCache();

          // Insert all deduplicated entries
          for (const [key, value] of uniqueEntries) {
            await cache.set(key, value, 600);
          }

          // Delete the target key
          await cache.del(targetKey);

          // Target key must return null
          const deletedResult = await cache.get(targetKey);
          if (deletedResult !== null) {
            return false;
          }

          // All other entries (with different keys) must still be accessible
          for (let i = 0; i < uniqueEntries.length; i++) {
            if (i === idx) continue;
            const [key, expectedValue] = uniqueEntries[i];
            // Skip if this key is the same as the target (can happen if dedup
            // produced a different index mapping — guard for safety)
            if (key === targetKey) continue;
            const result = await cache.get(key);
            if (result !== expectedValue) {
              return false;
            }
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
