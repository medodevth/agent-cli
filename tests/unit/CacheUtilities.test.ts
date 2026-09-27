import {
  astCacheStore,
  cacheBypassFlag,
  cacheCompressionHelper,
  cacheEvictionPolicy,
  cacheHitRateTracker,
  cacheInvalidateOnFileChange,
  cacheKeyCollisionChecker,
  cacheMetricsExporter,
  cacheMissLogger,
  cacheSizeMonitor,
  cacheTTLManager,
  dependencyResolutionCache,
  distributedCacheSync,
  embeddingCacheStore,
  partialCacheMatcher,
  promptCacheKeyGenerator,
  responseCacheStore,
  staleCacheDetector,
  testResultCache,
  cacheWarmup,
} from '../../src/utils/CacheUtilities.js';
import type { CacheStore } from '../../src/utils/CacheUtilities.js';

function exerciseNamedStore<T>(factory: (options?: { now?: () => number }) => CacheStore<T>): void {
  const cache = factory({ now: () => 7 });
  cache.set('k', 'value' as T);
  expect(cache.get('k')).toBe('value');
}

describe('cache key generation and hit tracking', () => {
  it('creates stable namespaced keys from structured prompts', () => {
    const left = promptCacheKeyGenerator({ prompt: 'hello', model: 'm1' });
    const reordered = promptCacheKeyGenerator({ model: 'm1', prompt: 'hello' });
    const changed = promptCacheKeyGenerator({ prompt: 'hello!', model: 'm1' });
    expect(left).toBe(reordered);
    expect(left).not.toBe(changed);
    expect(left).toMatch(/^prompt:[a-f0-9]{64}$/);
  });

  it('tracks hits, misses, rates and reset deterministically', () => {
    const tracker = cacheHitRateTracker();
    tracker.record(true);
    tracker.record(false);
    tracker.record(true);
    expect(tracker.snapshot()).toEqual({ hits: 2, misses: 1, total: 3, hitRate: 2 / 3 });
    tracker.reset();
    expect(tracker.snapshot()).toEqual({ hits: 0, misses: 0, total: 0, hitRate: 0 });
  });
});

describe('response cache TTL and eviction', () => {
  it('expires entries at the exact TTL boundary and reports remaining time', () => {
    let now = 100;
    const cache = responseCacheStore<number>({ ttlMs: 10, now: () => now });
    cache.set('answer', 42);
    const ttl = cacheTTLManager(cache);
    expect(ttl.remainingMs('answer')).toBe(10);
    now = 109;
    expect(cache.get('answer')).toBe(42);
    now = 110;
    expect(ttl.isExpired('answer')).toBe(true);
    expect(cache.get('answer')).toBeUndefined();
  });

  it('treats a key that was never written as expired, matching the store contract', () => {
    const cache = responseCacheStore<number>({ ttlMs: 10, now: () => 100 });
    expect(cache.isExpired('missing')).toBe(true);
    expect(cacheTTLManager(cache).isExpired('missing')).toBe(true);
  });

  it('chooses least-recently-used entries first and enforces the capacity', () => {
    let now = 0;
    const cache = responseCacheStore<string>({ maxEntries: 2, now: () => now++ });
    cache.set('a', 'A');
    cache.set('b', 'B');
    expect(cache.get('a')).toBe('A');
    expect(cacheEvictionPolicy(cache.records(), 1)).toEqual(['b']);
    cache.set('c', 'C');
    expect(cache.keys()).toEqual(['a', 'c']);
  });
});

describe('cache store variants and invalidation', () => {
  it('provides functional embedding, AST, test-result and dependency-resolution stores', () => {
    exerciseNamedStore(embeddingCacheStore);
    exerciseNamedStore(astCacheStore);
    exerciseNamedStore(testResultCache);
    exerciseNamedStore(dependencyResolutionCache);
  });

  it('invalidates entries that reference changed files and keeps unrelated entries', () => {
    const cache = responseCacheStore<string>();
    cache.set('uses-a', 'old', { metadata: { filePaths: ['src/a.ts'] } });
    cache.set('uses-b', 'safe', { metadata: { filePaths: ['src/b.ts'] } });
    expect(cacheInvalidateOnFileChange(cache, ['src/a.ts'])).toEqual(['uses-a']);
    expect(cache.keys()).toEqual(['uses-b']);
  });
});

describe('cache synchronization, warmup and observation', () => {
  it('applies deterministic distributed updates and deletes', () => {
    const cache = responseCacheStore<string>();
    expect(distributedCacheSync(cache, [
      { type: 'set', key: 'a', value: 'A' },
      { type: 'set', key: 'b', value: 'B' },
      { type: 'delete', key: 'a' },
    ])).toEqual({ applied: 3, keys: ['a', 'b', 'a'] });
    expect(cache.keys()).toEqual(['b']);
  });

  it('warms a cache and reports count and estimated size', () => {
    const cache = responseCacheStore<string>();
    expect(cacheWarmup(cache, [{ key: 'a', value: 'alpha' }, { key: 'b', value: 'beta' }])).toBe(2);
    expect(cacheSizeMonitor(cache)).toMatchObject({ entries: 2, estimatedBytes: expect.any(Number), maxEntries: 1000, utilization: 0.002 });
  });

  it('finds stale items using expiry and a caller predicate', () => {
    let now = 0;
    const cache = responseCacheStore<string>({ now: () => now });
    cache.set('expired', 'x', { ttlMs: 5 });
    cache.set('stale-by-version', 'y');
    now = 5;
    expect(staleCacheDetector(cache, record => record.value === 'y')).toEqual(['expired', 'stale-by-version']);
  });
});

describe('cache key analysis and diagnostics', () => {
  it('matches cache keys partially by deterministic token overlap', () => {
    const cache = responseCacheStore<number>();
    cache.set('user:alice:profile', 1);
    cache.set('user:bob:profile', 2);
    cache.set('project:alice', 3);
    expect(partialCacheMatcher(cache, 'alice profile').map(match => match.key)).toEqual(['user:alice:profile']);
  });

  it('distinguishes a same-value key from a key collision with different content', () => {
    const cache = responseCacheStore<{ answer: number }>();
    cache.set('k', { answer: 42 });
    expect(cacheKeyCollisionChecker(cache, 'k', { answer: 42 }).collision).toBe(false);
    expect(cacheKeyCollisionChecker(cache, 'k', { answer: 7 })).toMatchObject({ exists: true, collision: true });
  });

  it('logs cache misses only and returns cached values for hits', () => {
    const cache = responseCacheStore<string>();
    const misses: string[] = [];
    cache.set('hit', 'value');
    expect(cacheMissLogger(cache, 'hit', { onMiss: key => misses.push(key) })).toEqual({ hit: true, value: 'value' });
    expect(cacheMissLogger(cache, 'missing', { onMiss: key => misses.push(key) })).toEqual({ hit: false });
    expect(misses).toEqual(['missing']);
  });

  it('round-trips compressed strings and leaves plain strings decodable', () => {
    const source = 'repeatable cache payload '.repeat(20);
    const packed = cacheCompressionHelper(source);
    expect(packed).toMatch(/^gzip:/);
    expect(cacheCompressionHelper(packed, { decompress: true })).toBe(source);
    expect(cacheCompressionHelper('plain', { decompress: true })).toBe('plain');
  });
});

describe('cache bypass and metrics', () => {
  it('allows a caller-controlled debug bypass flag', () => {
    const bypass = cacheBypassFlag();
    expect(bypass.shouldBypass()).toBe(false);
    bypass.set(true);
    expect(bypass.shouldBypass()).toBe(true);
    expect(bypass.enabled).toBe(true);
  });

  it('exports deterministic JSON and Prometheus cache metrics', () => {
    const cache = responseCacheStore<string>();
    const tracker = cacheHitRateTracker();
    cache.set('a', 'A');
    tracker.record(true);
    tracker.record(false);
    expect(JSON.parse(cacheMetricsExporter(cache, tracker))).toMatchObject({ entries: 1, hits: 1, misses: 1, hitRate: 0.5 });
    expect(cacheMetricsExporter(cache, tracker, { format: 'prometheus' })).toContain('cache_hit_rate 0.5');
  });
});

describe('validation and edge cases', () => {
  it('rejects invalid limits, TTLs, namespaces, and compression data', () => {
    expect(() => responseCacheStore({ maxEntries: 0 })).toThrow(/maxEntries/);
    expect(() => responseCacheStore({ ttlMs: -1 })).toThrow(/ttlMs/);
    expect(() => promptCacheKeyGenerator('x', { namespace: ' ' })).toThrow(/namespace/);
    expect(() => cacheCompressionHelper('gzip:not-valid', { decompress: true })).toThrow(/Invalid compressed/);
  });

  it('counts an expired cache value as a miss and does not mutate exposed records', () => {
    let now = 0;
    const cache = responseCacheStore<string>({ now: () => now });
    cache.set('a', 'value', { ttlMs: 2, metadata: { filePaths: ['src/a.ts'] } });
    const exposed = cache.record('a')!;
    (exposed.metadata as Record<string, unknown>).filePaths = ['src/changed.ts'];
    expect(cache.record('a')!.metadata!.filePaths).toEqual(['src/a.ts']);
    now = 2;
    expect(cacheMissLogger(cache, 'a')).toEqual({ hit: false });
    expect(cacheTTLManager(cache).sweep()).toEqual([]);
  });

  it('handles partially overlapping keys and an empty cache deterministically', () => {
    const cache = responseCacheStore<string>({ maxEntries: 2 });
    cache.set('alpha beta', 'one');
    cache.set('alpha gamma', 'two');
    expect(partialCacheMatcher(cache, 'alpha beta', { minScore: 0.5 }).map(match => match.key)).toEqual(['alpha beta', 'alpha gamma']);
    expect(cacheSizeMonitor(responseCacheStore<string>())).toEqual({ entries: 0, estimatedBytes: 0, maxEntries: 1000, utilization: 0 });
  });
});
