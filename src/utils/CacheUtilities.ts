import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

export interface CacheRecord<T> {
  key: string;
  value: T;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  expiresAt?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

/** Minimal synchronous backing-store contract for deterministic in-memory caches. */
export interface CacheStorage<T> {
  get(key: string): CacheRecord<T> | undefined;
  set(key: string, record: CacheRecord<T>): void;
  delete(key: string): boolean;
  clear(): void;
  keys(): Iterable<string>;
}

export interface CacheStoreOptions<T> {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
  storage?: CacheStorage<T>;
}

export interface CacheSetOptions {
  ttlMs?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface CacheStore<T> {
  set(key: string, value: T, options?: CacheSetOptions): void;
  get(key: string): T | undefined;
  peek(key: string): T | undefined;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  keys(): string[];
  records(): CacheRecord<T>[];
  record(key: string): CacheRecord<T> | undefined;
  /** Return whether an existing record is expired; missing keys are treated as expired. */
  isExpired(key: string): boolean;
  /** Return remaining lifetime; missing and expired keys have zero lifetime. */
  remainingMs(key: string): number;
  readonly size: number;
  readonly maxEntries: number;
  now(): number;
}

class MapCacheStorage<T> implements CacheStorage<T> {
  private readonly values = new Map<string, CacheRecord<T>>();

  get(key: string): CacheRecord<T> | undefined {
    return this.values.get(key);
  }

  set(key: string, record: CacheRecord<T>): void {
    this.values.set(key, record);
  }

  delete(key: string): boolean {
    return this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }

  keys(): Iterable<string> {
    return this.values.keys();
  }
}

function validateNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function copyRecord<T>(record: CacheRecord<T>): CacheRecord<T> {
  return {
    ...record,
    ...(record.metadata === undefined ? {} : { metadata: { ...record.metadata } }),
  };
}

/** Create a bounded, TTL-aware cache. Reads update LRU time; expired values miss. */
export function responseCacheStore<T>(options: CacheStoreOptions<T> = {}): CacheStore<T> {
  const ttlMs = options.ttlMs;
  const maxEntries = options.maxEntries ?? 1000;
  const clock = options.now ?? Date.now;
  const storage = options.storage ?? new MapCacheStorage<T>();
  if (ttlMs !== undefined) validateNonNegativeFinite(ttlMs, 'ttlMs');
  validatePositiveInteger(maxEntries, 'maxEntries');
  if (typeof clock !== 'function') throw new TypeError('now must be a function');
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function' ||
      typeof storage.delete !== 'function' || typeof storage.clear !== 'function' || typeof storage.keys !== 'function') {
    throw new TypeError('storage must implement get, set, delete, clear and keys');
  }

  const currentTime = (): number => {
    const time = clock();
    if (!Number.isFinite(time)) throw new RangeError('Cache clock must return a finite number');
    return time;
  };
  const allKeys = (): string[] => [...storage.keys()];
  const removeIfExpired = (key: string, record: CacheRecord<T> | undefined, at: number): CacheRecord<T> | undefined => {
    if (record?.expiresAt !== undefined && record.expiresAt <= at) {
      storage.delete(key);
      return undefined;
    }
    return record;
  };
  const getLiveRecord = (key: string): CacheRecord<T> | undefined =>
    removeIfExpired(key, storage.get(key), currentTime());

  const store: CacheStore<T> = {
    set(key, value, setOptions = {}): void {
      if (typeof key !== 'string') throw new TypeError('Cache key must be a string');
      const ttl = setOptions.ttlMs ?? ttlMs;
      if (ttl !== undefined) validateNonNegativeFinite(ttl, 'ttlMs');
      const now = currentTime();
      const previous = storage.get(key);
      const record: CacheRecord<T> = {
        key,
        value,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        lastAccessedAt: now,
        ...(ttl === undefined ? {} : { expiresAt: now + ttl }),
        ...(setOptions.metadata === undefined ? {} : { metadata: { ...setOptions.metadata } }),
      };
      storage.set(key, record);
      const excess = cacheEvictionPolicy(store.records(), maxEntries);
      for (const evictKey of excess) storage.delete(evictKey);
    },
    get(key): T | undefined {
      const record = getLiveRecord(key);
      if (!record) return undefined;
      const touched = { ...record, lastAccessedAt: currentTime() };
      storage.set(key, touched);
      return touched.value;
    },
    peek(key): T | undefined {
      return getLiveRecord(key)?.value;
    },
    has(key): boolean {
      return getLiveRecord(key) !== undefined;
    },
    delete(key): boolean {
      return storage.delete(key);
    },
    clear(): void {
      storage.clear();
    },
    keys(): string[] {
      const now = currentTime();
      for (const key of allKeys()) removeIfExpired(key, storage.get(key), now);
      return allKeys();
    },
    records(): CacheRecord<T>[] {
      return allKeys().flatMap(key => {
        const record = storage.get(key);
        return record ? [copyRecord(record)] : [];
      });
    },
    record(key): CacheRecord<T> | undefined {
      const record = storage.get(key);
      return record ? copyRecord(record) : undefined;
    },
    isExpired(key): boolean {
      const record = storage.get(key);
      return record === undefined || record.expiresAt !== undefined && record.expiresAt <= currentTime();
    },
    remainingMs(key): number {
      const record = storage.get(key);
      if (record === undefined) return 0;
      if (record.expiresAt === undefined) return Infinity;
      return Math.max(0, record.expiresAt - currentTime());
    },
    get size(): number {
      return store.keys().length;
    },
    maxEntries,
    now: currentTime,
  };
  return store;
}

function normalizeForJson(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    return String(value);
  }
  if (typeof value === 'undefined') return null;
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) throw new TypeError('Cannot create a deterministic cache key from a circular value');
  seen.add(value);
  let normalized: unknown;
  if (Array.isArray(value)) {
    normalized = value.map(item => normalizeForJson(item, seen));
  } else if (value instanceof Map) {
    const pairs = [...value.entries()].map(([key, item]) => [normalizeForJson(key, seen), normalizeForJson(item, seen)] as const);
    pairs.sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])));
    normalized = { $map: pairs };
  } else if (value instanceof Set) {
    const items = [...value].map(item => normalizeForJson(item, seen));
    items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    normalized = { $set: items };
  } else {
    const object = value as Record<string, unknown>;
    normalized = Object.fromEntries(Object.keys(object).sort().map(key => [key, normalizeForJson(object[key], seen)]));
  }
  seen.delete(value);
  return normalized;
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(normalizeForJson(value, new Set())) ?? 'null';
}

/** Generate a namespace-prefixed SHA-256 key from a stable structural encoding. */
export function promptCacheKeyGenerator(
  prompt: unknown,
  options: { namespace?: string; version?: string } = {},
): string {
  const namespace = options.namespace ?? 'prompt';
  if (typeof namespace !== 'string' || namespace.trim() === '') throw new TypeError('namespace must be a non-empty string');
  const hash = createHash('sha256')
    .update(stableSerialize({ namespace, version: options.version ?? '', prompt }))
    .digest('hex');
  return `${namespace}:${hash}`;
}

export interface CacheHitRateSnapshot {
  hits: number;
  misses: number;
  total: number;
  hitRate: number;
}

export interface CacheHitRateTracker {
  record(hit: boolean): void;
  recordHit(): void;
  recordMiss(): void;
  snapshot(): CacheHitRateSnapshot;
  reset(): void;
}

/** Count cache outcomes and expose a resettable rate snapshot. */
export function cacheHitRateTracker(): CacheHitRateTracker {
  let hits = 0;
  let misses = 0;
  return {
    record(hit): void {
      if (typeof hit !== 'boolean') throw new TypeError('Cache outcome must be a boolean');
      if (hit) hits++;
      else misses++;
    },
    recordHit(): void { hits++; },
    recordMiss(): void { misses++; },
    snapshot(): CacheHitRateSnapshot {
      const total = hits + misses;
      return { hits, misses, total, hitRate: total === 0 ? 0 : hits / total };
    },
    reset(): void { hits = 0; misses = 0; },
  };
}

/** Invalidate only entries whose recorded file dependencies intersect a change set. */
export function cacheInvalidateOnFileChange<T>(cache: CacheStore<T>, changedFiles: readonly string[]): string[] {
  const changed = new Set(changedFiles);
  const invalidated: string[] = [];
  for (const record of cache.records()) {
    const metadata = record.metadata ?? {};
    const referenced = [metadata.filePaths, metadata.files, metadata.dependencies]
      .flatMap(value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
    if (referenced.some(filePath => changed.has(filePath))) {
      cache.delete(record.key);
      invalidated.push(record.key);
    }
  }
  return invalidated;
}

function createSpecializedStore<T>(options: CacheStoreOptions<T> | undefined, defaultMaxEntries: number): CacheStore<T> {
  const configured = options ?? {};
  return responseCacheStore({ ...configured, maxEntries: configured.maxEntries ?? defaultMaxEntries });
}

/** Dedicated in-memory store for generated vector embeddings. */
export function embeddingCacheStore<T>(options: CacheStoreOptions<T> = {}): CacheStore<T> {
  return createSpecializedStore(options, 5000);
}

/** Dedicated in-memory store for parsed syntax trees and AST summaries. */
export function astCacheStore<T>(options: CacheStoreOptions<T> = {}): CacheStore<T> {
  return createSpecializedStore(options, 2000);
}

/** Dedicated in-memory store for results keyed by stable test identity/input. */
export function testResultCache<T>(options: CacheStoreOptions<T> = {}): CacheStore<T> {
  return createSpecializedStore(options, 5000);
}

/** Dedicated in-memory store for resolved dependency graphs and package metadata. */
export function dependencyResolutionCache<T>(options: CacheStoreOptions<T> = {}): CacheStore<T> {
  return createSpecializedStore(options, 2000);
}

export interface CacheTTLController {
  isExpired(key: string): boolean;
  remainingMs(key: string): number | undefined;
  sweep(): string[];
}

/** Inspect TTL state and explicitly purge expired records. Expiration is exclusive: expiresAt is stale. */
export function cacheTTLManager<T>(cache: CacheStore<T>): CacheTTLController {
  return {
    isExpired(key): boolean {
      const record = cache.record(key);
      return record?.expiresAt !== undefined && record.expiresAt <= cache.now();
    },
    remainingMs(key): number | undefined {
      const record = cache.record(key);
      if (!record) return undefined;
      if (record.expiresAt === undefined) return Infinity;
      return Math.max(0, record.expiresAt - cache.now());
    },
    sweep(): string[] {
      const now = cache.now();
      const expired = cache.records().filter(record => record.expiresAt !== undefined && record.expiresAt <= now).map(record => record.key);
      for (const key of expired) cache.delete(key);
      return expired;
    },
  };
}

/** Return least-recently-used keys needed to reduce the cache to its target capacity. */
export function cacheEvictionPolicy<T>(
  input: readonly CacheRecord<T>[] | CacheStore<T>,
  maxEntries?: number,
): string[] {
  const records = Array.isArray(input) ? [...input] as CacheRecord<T>[] : (input as CacheStore<T>).records();
  const limit = maxEntries ?? (Array.isArray(input) ? records.length : (input as CacheStore<T>).maxEntries);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('maxEntries must be a non-negative safe integer');
  const amount = Math.max(0, records.length - limit);
  if (amount === 0) return [];
  return records.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt || a.createdAt - b.createdAt || a.key.localeCompare(b.key))
    .slice(0, amount)
    .map(record => record.key);
}

export type DistributedCacheUpdate<T> =
  | { type: 'set'; key: string; value: T; ttlMs?: number; metadata?: Readonly<Record<string, unknown>> }
  | { type: 'delete'; key: string };

/** Apply a caller-supplied change batch, suitable for synchronizing worker-local caches. */
export function distributedCacheSync<T>(
  cache: CacheStore<T>,
  updates: readonly DistributedCacheUpdate<T>[],
): { applied: number; keys: string[] } {
  const keys: string[] = [];
  for (const update of updates) {
    if (update.type === 'set') cache.set(update.key, update.value, { ttlMs: update.ttlMs, metadata: update.metadata });
    else if (update.type === 'delete') cache.delete(update.key);
    else throw new TypeError(`Unsupported cache update type: ${String((update as { type?: unknown }).type)}`);
    keys.push(update.key);
  }
  return { applied: updates.length, keys };
}

export interface CacheWarmupEntry<T> {
  key: string;
  value: T;
  ttlMs?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

/** Pre-populate a cache with caller-provided stable entries; returns the number written. */
export function cacheWarmup<T>(cache: CacheStore<T>, entries: readonly CacheWarmupEntry<T>[]): number {
  for (const entry of entries) {
    cache.set(entry.key, entry.value, { ttlMs: entry.ttlMs, metadata: entry.metadata });
  }
  return entries.length;
}

export interface CacheSizeReport {
  entries: number;
  estimatedBytes: number;
  maxEntries: number;
  utilization: number;
}

/** Estimate serialized size and occupancy without inspecting objects through I/O. */
export function cacheSizeMonitor<T>(cache: CacheStore<T>): CacheSizeReport {
  const records = cache.records().filter(record => record.expiresAt === undefined || record.expiresAt > cache.now());
  const serialized = records.map(record => {
    try { return JSON.stringify(record) ?? String(record.value); }
    catch { return String(record.value); }
  }).join('');
  return {
    entries: records.length,
    estimatedBytes: Buffer.byteLength(serialized, 'utf8'),
    maxEntries: cache.maxEntries,
    utilization: cache.maxEntries === 0 ? 0 : records.length / cache.maxEntries,
  };
}

/** Report expired entries and any fresh entries rejected by an application predicate. */
export function staleCacheDetector<T>(
  cache: CacheStore<T>,
  isStale?: (record: CacheRecord<T>) => boolean,
): string[] {
  const now = cache.now();
  return cache.records().filter(record =>
    record.expiresAt !== undefined && record.expiresAt <= now || Boolean(isStale?.(record))
  ).map(record => record.key);
}

/** Gzip UTF-8 text into a tagged base64 string, or decode the tagged representation. */
export function cacheCompressionHelper(
  value: string | Uint8Array,
  options: { decompress?: boolean; encoding?: BufferEncoding } = {},
): string {
  if (options.decompress) {
    const encoded = typeof value === 'string' ? value : Buffer.from(value).toString(options.encoding ?? 'utf8');
    if (!encoded.startsWith('gzip:')) return encoded;
    try {
      return gunzipSync(Buffer.from(encoded.slice(5), 'base64')).toString(options.encoding ?? 'utf8');
    } catch (error) {
      throw new Error(`Invalid compressed cache value: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const bytes = typeof value === 'string' ? Buffer.from(value, options.encoding ?? 'utf8') : Buffer.from(value);
  return `gzip:${gzipSync(bytes).toString('base64')}`;
}

export interface PartialCacheMatch<T> {
  key: string;
  value: T;
  score: number;
}

function keyTokens(text: string): Set<string> {
  return new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
}

/** Find cache keys with sufficient lexical overlap, ordered by score then key. */
export function partialCacheMatcher<T>(
  cache: CacheStore<T>,
  query: string,
  options: { minScore?: number; limit?: number } = {},
): PartialCacheMatch<T>[] {
  const minScore = options.minScore ?? 0.6;
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) throw new RangeError('minScore must be between 0 and 1');
  if (options.limit !== undefined) validatePositiveInteger(options.limit, 'limit');
  const queryTokens = keyTokens(query);
  if (queryTokens.size === 0) return [];
  const matches: PartialCacheMatch<T>[] = [];
  for (const record of cache.records()) {
    if (record.expiresAt !== undefined && record.expiresAt <= cache.now()) continue;
    const tokens = keyTokens(record.key);
    let overlap = 0;
    for (const token of queryTokens) if (tokens.has(token)) overlap++;
    const score = overlap / queryTokens.size;
    if (score >= minScore) matches.push({ key: record.key, value: record.value, score });
  }
  matches.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return options.limit === undefined ? matches : matches.slice(0, options.limit);
}

export interface CacheCollisionReport<T> {
  key: string;
  exists: boolean;
  collision: boolean;
  existingValue?: T;
}

/** Detect attempts to reuse a cache key for a structurally different value. */
export function cacheKeyCollisionChecker<T>(cache: CacheStore<T>, key: string, candidate: T): CacheCollisionReport<T> {
  const record = cache.record(key);
  const exists = record !== undefined && (record.expiresAt === undefined || record.expiresAt > cache.now());
  if (!exists || !record) return { key, exists: false, collision: false };
  const collision = stableSerialize(record.value) !== stableSerialize(candidate);
  return { key, exists: true, collision, existingValue: record.value };
}

export interface CacheMissLoggerOptions {
  onMiss?: (key: string) => void;
}

/** Read a cached value and invoke the optional diagnostic callback only for misses. */
export function cacheMissLogger<T>(
  cache: CacheStore<T>,
  key: string,
  options: CacheMissLoggerOptions = {},
): { hit: true; value: T } | { hit: false } {
  if (cache.has(key)) return { hit: true, value: cache.get(key) as T };
  options.onMiss?.(key);
  return { hit: false };
}

export interface CacheBypassController {
  readonly enabled: boolean;
  set(enabled: boolean): void;
  shouldBypass(): boolean;
}

/** Control cache bypass explicitly, e.g. while debugging deterministic cache behavior. */
export function cacheBypassFlag(initial = false): CacheBypassController {
  if (typeof initial !== 'boolean') throw new TypeError('initial cache bypass flag must be boolean');
  let enabled = initial;
  return {
    get enabled(): boolean { return enabled; },
    set(value): void {
      if (typeof value !== 'boolean') throw new TypeError('cache bypass flag must be boolean');
      enabled = value;
    },
    shouldBypass(): boolean { return enabled; },
  };
}

export interface CacheMetrics {
  entries: number;
  estimatedBytes: number;
  maxEntries: number;
  utilization: number;
  hits: number;
  misses: number;
  total: number;
  hitRate: number;
}

/** Export stable cache occupancy and hit metrics as JSON or Prometheus text. */
export function cacheMetricsExporter<T>(
  cache: CacheStore<T>,
  tracker: CacheHitRateTracker = cacheHitRateTracker(),
  options: { format?: 'json' | 'prometheus' } = {},
): string {
  const format = options.format ?? 'json';
  const size = cacheSizeMonitor(cache);
  const stats = tracker.snapshot();
  const metrics: CacheMetrics = { ...size, ...stats };
  if (format === 'json') return JSON.stringify(metrics);
  if (format !== 'prometheus') throw new RangeError(`Unsupported cache metrics format: ${String(format)}`);
  return [
    '# TYPE cache_entries gauge',
    `cache_entries ${metrics.entries}`,
    '# TYPE cache_size_bytes gauge',
    `cache_size_bytes ${metrics.estimatedBytes}`,
    '# TYPE cache_utilization gauge',
    `cache_utilization ${metrics.utilization}`,
    '# TYPE cache_hits_total counter',
    `cache_hits_total ${metrics.hits}`,
    '# TYPE cache_misses_total counter',
    `cache_misses_total ${metrics.misses}`,
    '# TYPE cache_hit_rate gauge',
    `cache_hit_rate ${metrics.hitRate}`,
  ].join('\n');
}
