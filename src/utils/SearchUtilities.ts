/**
 * Embedding and semantic-search utilities (functions 381–400).
 *
 * The default vectorizer is deterministic, local, and dependency-free: token
 * features are hashed into a signed 128-dimensional bag-of-words vector. It is
 * useful for offline lexical retrieval, but is not a substitute for a trained
 * semantic model. Pass an injected provider to use a real embedding service.
 * No API or filesystem calls are made by this module.
 */

export type Embedding = number[];
export type EmbeddingProvider = (text: string) => Embedding | Promise<Embedding>;

export interface EmbeddingRecord {
  id: string;
  path: string;
  text: string;
  embedding: Embedding;
  startLine?: number;
  endLine?: number;
  metadata?: Record<string, unknown>;
}

export interface EmbeddingIndex {
  records: EmbeddingRecord[];
  dimensions: number;
  updatedAt: number;
}

export interface SearchHit extends EmbeddingRecord {
  score: number;
  semanticScore?: number;
  keywordScore?: number;
}

export interface CodeFile { path: string; content: string }
export interface ChunkOptions { maxChars?: number; overlapLines?: number }

const DEFAULT_DIMENSIONS = 128;
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'find', 'for', 'from', 'function',
  'i', 'in', 'is', 'it', 'of', 'on', 'or', 'please', 'show', 'that', 'the', 'to',
  'what', 'where', 'which', 'with', 'you', 'does', 'how', 'me', 'this', 'all',
]);

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_$]+/gu) ?? [];
}

function normalizedQueryKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function validateVector(vector: number[], expectedDimensions?: number): number[] {
  if (!Array.isArray(vector) || vector.length === 0) throw new Error('Embedding must contain at least one dimension');
  if (expectedDimensions !== undefined && vector.length !== expectedDimensions) {
    throw new Error(`Embedding dimension mismatch: expected ${expectedDimensions}, received ${vector.length}`);
  }
  if (vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Embedding values must be finite numbers');
  }
  return [...vector];
}

function localVectorize(text: string, dimensions = DEFAULT_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of tokenize(text)) {
    // FNV-1a, then a second integer mix supplies a stable sign and bucket.
    let hash = 2166136261;
    for (let index = 0; index < token.length; index++) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = (hash >>> 0) % dimensions;
    const sign = (hash & 0x80000000) === 0 ? 1 : -1;
    vector[bucket] += sign;
  }
  const norm = Math.hypot(...vector);
  return norm === 0 ? vector : vector.map(value => value / norm);
}

/** 381. Generate a validated embedding using an injected provider or the documented local vectorizer. */
export async function generateEmbedding(
  text: string,
  options: { provider?: EmbeddingProvider; dimensions?: number } = {},
): Promise<Embedding> {
  if (typeof text !== 'string') throw new Error('Embedding input must be text');
  const dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
  if (!Number.isInteger(dimensions) || dimensions < 1) throw new Error('dimensions must be a positive integer');
  const raw = options.provider ? await options.provider(text) : localVectorize(text, dimensions);
  return validateVector(raw, options.provider ? undefined : dimensions);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  validateVector(left);
  validateVector(right, left.length);
  const leftNorm = Math.hypot(...left);
  const rightNorm = Math.hypot(...right);
  if (leftNorm === 0 || rightNorm === 0) return 0;
  const dot = left.reduce((sum, value, index) => sum + value * right[index], 0);
  return Math.max(-1, Math.min(1, dot / (leftNorm * rightNorm)));
}

function getRecords(recordsOrIndex: EmbeddingRecord[] | EmbeddingIndex): EmbeddingRecord[] {
  return Array.isArray(recordsOrIndex) ? recordsOrIndex : recordsOrIndex.records;
}

/** 382. Rank records by cosine similarity, with stable tie-breaking and optional filtering. */
export function vectorSimilaritySearch(
  queryEmbedding: number[],
  recordsOrIndex: EmbeddingRecord[] | EmbeddingIndex,
  options: { topK?: number; minScore?: number; excludeIds?: string[] } = {},
): SearchHit[] {
  validateVector(queryEmbedding);
  const topK = options.topK ?? 10;
  if (!Number.isInteger(topK) || topK < 0) throw new Error('topK must be a non-negative integer');
  const excluded = new Set(options.excludeIds ?? []);
  return getRecords(recordsOrIndex).flatMap(record => {
    if (excluded.has(record.id)) return [];
    const score = cosineSimilarity(queryEmbedding, record.embedding);
    if (score < (options.minScore ?? -1)) return [];
    return [{ ...record, embedding: [...record.embedding], score }];
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, topK);
}

export interface CodeChunk {
  id: string;
  path: string;
  text: string;
  startLine: number;
  endLine: number;
}

/** 383. Split source into bounded line-aware chunks; a long line is split into bounded segments. */
export function chunkCodeForEmbedding(
  content: string,
  path = '<memory>',
  options: ChunkOptions = {},
): CodeChunk[] {
  const maxChars = options.maxChars ?? 1200;
  const overlapLines = options.overlapLines ?? 0;
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('maxChars must be a positive integer');
  if (!Number.isInteger(overlapLines) || overlapLines < 0) throw new Error('overlapLines must be a non-negative integer');
  if (content.length === 0) return [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (content.endsWith('\n')) lines.pop();
  const segments: Array<{ text: string; line: number }> = [];
  lines.forEach((line, index) => {
    if (line.length <= maxChars) segments.push({ text: line, line: index + 1 });
    else {
      for (let offset = 0; offset < line.length; offset += maxChars) {
        segments.push({ text: line.slice(offset, offset + maxChars), line: index + 1 });
      }
    }
  });
  const chunks: CodeChunk[] = [];
  let cursor = 0;
  while (cursor < segments.length) {
    const start = cursor;
    let text = segments[cursor].text;
    cursor++;
    while (cursor < segments.length && text.length + 1 + segments[cursor].text.length <= maxChars) {
      text += `\n${segments[cursor].text}`;
      cursor++;
    }
    const startLine = segments[start].line;
    const endLine = segments[cursor - 1].line;
    const chunkNumber = chunks.length;
    chunks.push({ id: `${path}:${startLine}-${endLine}:${chunkNumber}`, path, text, startLine, endLine });
    if (cursor < segments.length && overlapLines > 0) {
      let overlapStart = cursor;
      const firstLine = segments[cursor].line;
      const minLine = Math.max(startLine + 1, firstLine - overlapLines);
      while (overlapStart > start && segments[overlapStart - 1].line >= minLine) overlapStart--;
      cursor = Math.max(start + 1, overlapStart);
    }
  }
  return chunks;
}

export interface IndexBuilderOptions {
  provider?: EmbeddingProvider;
  chunkOptions?: ChunkOptions;
  now?: () => number;
  dimensions?: number;
}

/** 384. Build a content index by chunking each supplied file and embedding every chunk. */
export async function embeddingIndexBuilder(files: CodeFile[], options: IndexBuilderOptions = {}): Promise<EmbeddingIndex> {
  const records: EmbeddingRecord[] = [];
  let dimensions = options.dimensions ?? 0;
  for (const file of files) {
    if (!file.path || typeof file.content !== 'string') throw new Error('Each file requires a path and text content');
    for (const chunk of chunkCodeForEmbedding(file.content, file.path, options.chunkOptions)) {
      const embedding = await generateEmbedding(chunk.text, { provider: options.provider, ...(options.dimensions ? { dimensions: options.dimensions } : {}) });
      if (dimensions && embedding.length !== dimensions) throw new Error('Embedding provider returned inconsistent dimensions');
      dimensions = embedding.length;
      records.push({ ...chunk, embedding });
    }
  }
  return { records, dimensions, updatedAt: (options.now ?? Date.now)() };
}

export interface IndexChanges { upsert?: CodeFile[]; remove?: string[] }

/** 385. Re-embed changed files and remove deleted paths while retaining all other indexed records. */
export async function incrementalIndexUpdater(
  index: EmbeddingIndex,
  changes: IndexChanges,
  options: IndexBuilderOptions = {},
): Promise<EmbeddingIndex> {
  const changedPaths = new Set((changes.upsert ?? []).map(file => file.path));
  const removedPaths = new Set(changes.remove ?? []);
  const retained = index.records.filter(record => !changedPaths.has(record.path) && !removedPaths.has(record.path));
  const replacements = await embeddingIndexBuilder(changes.upsert ?? [], {
    ...options,
    dimensions: options.dimensions ?? (index.dimensions || undefined),
  });
  const records = [...retained, ...replacements.records].sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
  const dimensions = records[0]?.embedding.length ?? index.dimensions;
  if (records.some(record => record.embedding.length !== dimensions)) throw new Error('Index contains inconsistent embedding dimensions');
  return { records, dimensions, updatedAt: (options.now ?? Date.now)() };
}

export interface SemanticSearchOptions extends IndexBuilderOptions { topK?: number; minScore?: number }

/** 386. Embed a text query and retrieve its nearest indexed code chunks. */
export async function semanticCodeSearch(query: string, index: EmbeddingIndex, options: SemanticSearchOptions = {}): Promise<SearchHit[]> {
  if (index.records.length === 0) return [];
  const embedding = await generateEmbedding(query, { provider: options.provider, ...(options.dimensions ? { dimensions: options.dimensions } : {}) });
  if (embedding.length !== index.dimensions) throw new Error(`Query embedding dimension mismatch: expected ${index.dimensions}, received ${embedding.length}`);
  return vectorSimilaritySearch(embedding, index, { topK: options.topK, minScore: options.minScore })
    .map(hit => ({ ...hit, semanticScore: hit.score }));
}

function keywordMatchScore(query: string, text: string, path: string): number {
  const terms = [...new Set(tokenize(query).filter(term => !STOP_WORDS.has(term)))];
  if (terms.length === 0) return 0;
  const searchable = new Set(tokenize(`${text} ${path}`));
  return terms.filter(term => searchable.has(term)).length / terms.length;
}

/** 387. Blend semantic similarity with normalized query-term overlap and rank by the combined score. */
export async function hybridSearchRankers(
  query: string,
  index: EmbeddingIndex,
  options: SemanticSearchOptions & { semanticWeight?: number; keywordWeight?: number } = {},
): Promise<SearchHit[]> {
  const semanticWeight = options.semanticWeight ?? 0.7;
  const keywordWeight = options.keywordWeight ?? 0.3;
  if (semanticWeight < 0 || keywordWeight < 0 || semanticWeight + keywordWeight <= 0) throw new Error('Search weights must be non-negative with a positive sum');
  const semantic = await semanticCodeSearch(query, index, { ...options, topK: index.records.length, minScore: undefined });
  const totalWeight = semanticWeight + keywordWeight;
  return semantic.map(hit => {
    const keywordScore = keywordMatchScore(query, hit.text, hit.path);
    return { ...hit, keywordScore, score: (hit.semanticScore! * semanticWeight + keywordScore * keywordWeight) / totalWeight };
  }).filter(hit => hit.score >= (options.minScore ?? -1))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, options.topK ?? 10);
}

export interface CacheCheckResult { hit: boolean; embedding?: number[] }

/** 388. Check a cache by normalized query key without computing a cache miss. */
export function embeddingCacheChecker(cache: Map<string, number[]> | Record<string, number[]>, query: string): CacheCheckResult {
  const key = normalizedQueryKey(query);
  const vector = cache instanceof Map ? cache.get(key) : cache[key];
  return vector ? { hit: true, embedding: [...vector] } : { hit: false };
}

/** 389. Find nearest indexed chunks to a source record or an indexed id/path. */
export async function similarCodeFinder(
  source: EmbeddingRecord | string,
  index: EmbeddingIndex,
  options: { topK?: number; minScore?: number } = {},
): Promise<SearchHit[]> {
  const record = typeof source === 'string' ? index.records.find(item => item.id === source || item.path === source) : source;
  if (!record) throw new Error(`Source record not found: ${source}`);
  return vectorSimilaritySearch(record.embedding, index, { ...options, excludeIds: [record.id] });
}

/** 390. Retrieve or compute a normalized-query embedding and cache successful results. */
export async function queryToEmbeddingCache(
  query: string,
  cache: Map<string, number[]> | Record<string, number[]>,
  options: { provider?: EmbeddingProvider; dimensions?: number } = {},
): Promise<number[]> {
  const key = normalizedQueryKey(query);
  const current = cache instanceof Map ? cache.get(key) : cache[key];
  if (current) return [...current];
  const embedding = await generateEmbedding(query, options);
  if (cache instanceof Map) cache.set(key, embedding);
  else cache[key] = embedding;
  return [...embedding];
}

/** 391. Detect dimension errors, empty vectors, duplicate ids, and missing text in an index. */
export function indexHealthChecker(index: EmbeddingIndex): {
  status: 'healthy' | 'unhealthy'; recordCount: number; dimensions: number;
  invalidVectorCount: number; duplicateIdCount: number; missingTextCount: number; issues: string[];
} {
  const ids = new Set<string>();
  let invalidVectorCount = 0;
  let duplicateIdCount = 0;
  let missingTextCount = 0;
  for (const record of index.records) {
    if (ids.has(record.id)) duplicateIdCount++;
    ids.add(record.id);
    if (record.embedding.length !== index.dimensions || record.embedding.some(value => !Number.isFinite(value)) || Math.hypot(...record.embedding) === 0) invalidVectorCount++;
    if (!record.text.trim()) missingTextCount++;
  }
  const issues = [
    ...(invalidVectorCount ? [`${invalidVectorCount} invalid vector(s)`] : []),
    ...(duplicateIdCount ? [`${duplicateIdCount} duplicate id(s)`] : []),
    ...(missingTextCount ? [`${missingTextCount} record(s) without text`] : []),
    ...(index.records.length > 0 && index.dimensions < 1 ? ['Index dimensions are not configured'] : []),
  ];
  return { status: issues.length ? 'unhealthy' : 'healthy', recordCount: index.records.length, dimensions: index.dimensions, invalidVectorCount, duplicateIdCount, missingTextCount, issues };
}

/** 392. Reduce dimensions by averaging deterministic contiguous buckets. */
export function embeddingDimensionReducer(embedding: number[], targetDimensions: number): number[] {
  validateVector(embedding);
  if (!Number.isInteger(targetDimensions) || targetDimensions < 1 || targetDimensions > embedding.length) {
    throw new Error('target dimension must be a positive integer no larger than the source dimension');
  }
  if (targetDimensions === embedding.length) return [...embedding];
  return Array.from({ length: targetDimensions }, (_, bucket) => {
    const start = Math.floor(bucket * embedding.length / targetDimensions);
    const end = Math.floor((bucket + 1) * embedding.length / targetDimensions);
    const values = embedding.slice(start, end);
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  });
}

export interface SemanticLink { sourceId: string; targetId: string; sourcePath: string; targetPath: string; score: number }

/** 393. Find above-threshold cosine links between chunks belonging to different files. */
export function crossFileSemanticLink(index: EmbeddingIndex, options: { threshold?: number; maxLinks?: number } = {}): SemanticLink[] {
  const threshold = options.threshold ?? 0.75;
  const maxLinks = options.maxLinks ?? Number.POSITIVE_INFINITY;
  if (threshold < -1 || threshold > 1) throw new Error('threshold must be between -1 and 1');
  if (maxLinks < 0 || (!Number.isInteger(maxLinks) && maxLinks !== Number.POSITIVE_INFINITY)) throw new Error('maxLinks must be a non-negative integer');
  const links: SemanticLink[] = [];
  for (let left = 0; left < index.records.length; left++) {
    for (let right = left + 1; right < index.records.length; right++) {
      const a = index.records[left]; const b = index.records[right];
      if (a.path === b.path) continue;
      const score = cosineSimilarity(a.embedding, b.embedding);
      if (score >= threshold) links.push({ sourceId: a.id, targetId: b.id, sourcePath: a.path, targetPath: b.path, score });
    }
  }
  return links.sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId) || a.targetId.localeCompare(b.targetId)).slice(0, maxLinks);
}

export interface CodeQuery { original: string; terms: string[]; query: string }

/** 394. Convert a natural-language request into deduplicated, stop-word-filtered code-search terms. */
export function naturalLanguageToCodeQuery(input: string): CodeQuery {
  const terms = [...new Set(tokenize(input).filter(term => !STOP_WORDS.has(term)).map(term => {
    if (term.length > 5 && term.endsWith('ies')) return `${term.slice(0, -3)}y`;
    if (term.length > 6 && term.endsWith('sses')) return term.slice(0, -2);
    if (term.length > 4 && term.endsWith('ses')) return term.slice(0, -1);
    if (term.length > 4 && term.endsWith('es')) return term.slice(0, -2);
    if (term.length > 3 && term.endsWith('s')) return term.slice(0, -1);
    return term;
  }))];
  return { original: input, terms, query: terms.join(' ') };
}

/** 395. Decide whether to rebuild based on explicit force, index age, or changed-file count. */
export function indexRebuildScheduler(options: {
  lastRebuiltAt?: number; now?: number; changedFileCount?: number; maxAgeMs?: number;
  changeThreshold?: number; force?: boolean;
}): { scheduled: boolean; reason: 'forced' | 'max-age' | 'change-threshold' | 'not-needed' } {
  const now = options.now ?? Date.now();
  const last = options.lastRebuiltAt ?? now;
  const ageLimit = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const changes = options.changedFileCount ?? 0;
  const threshold = options.changeThreshold ?? 50;
  if (![now, last, ageLimit, changes, threshold].every(Number.isFinite) || ageLimit < 0 || changes < 0 || threshold < 1) {
    throw new Error('Rebuild scheduling values must be finite and non-negative (threshold must be positive)');
  }
  if (options.force) return { scheduled: true, reason: 'forced' };
  if (now - last >= ageLimit) return { scheduled: true, reason: 'max-age' };
  if (changes >= threshold) return { scheduled: true, reason: 'change-threshold' };
  return { scheduled: false, reason: 'not-needed' };
}

/** 396. Select an active named embedding provider, validating every result. */
export function embeddingProviderSwitcher(
  providers: Record<string, EmbeddingProvider>,
  initialProvider: string,
): { setProvider(name: string): void; getProvider(): string; embed(text: string): Promise<number[]> } {
  if (!providers[initialProvider]) throw new Error(`Unknown embedding provider: ${initialProvider}`);
  let active = initialProvider;
  return {
    setProvider(name) {
      if (!providers[name]) throw new Error(`Unknown embedding provider: ${name}`);
      active = name;
    },
    getProvider: () => active,
    embed: async text => validateVector(await providers[active](text)),
  };
}

/** 397. Keep results whose selected ranking score meets the inclusive threshold. */
export function relevanceScoreThresholder<T extends { score?: number; semanticScore?: number }>(results: T[], threshold: number): T[] {
  if (!Number.isFinite(threshold)) throw new Error('threshold must be finite');
  return results.filter(result => (result.score ?? result.semanticScore ?? 0) >= threshold);
}

/** 398. Merge near-identical vectors into deterministic first-seen representatives. */
export function duplicateEmbeddingMerger(
  records: EmbeddingRecord[],
  options: { threshold?: number } = {},
): { records: EmbeddingRecord[]; groups: string[][] } {
  const threshold = options.threshold ?? 0.98;
  if (threshold < -1 || threshold > 1) throw new Error('threshold must be between -1 and 1');
  const parent = records.map((_, index) => index);
  const root = (value: number): number => parent[value] === value ? value : (parent[value] = root(parent[value]));
  for (let left = 0; left < records.length; left++) {
    for (let right = left + 1; right < records.length; right++) {
      if (cosineSimilarity(records[left].embedding, records[right].embedding) >= threshold) parent[root(right)] = root(left);
    }
  }
  const groupsByRoot = new Map<number, EmbeddingRecord[]>();
  records.forEach((record, index) => {
    const key = root(index);
    groupsByRoot.set(key, [...(groupsByRoot.get(key) ?? []), record]);
  });
  const groups: string[][] = [];
  const merged: EmbeddingRecord[] = [];
  for (const group of groupsByRoot.values()) {
    if (group.length > 1) groups.push(group.map(record => record.id));
    const representative = group[0];
    const embedding = Array.from({ length: representative.embedding.length }, (_, dimension) =>
      group.reduce((sum, record) => sum + record.embedding[dimension], 0) / group.length);
    merged.push({ ...representative, embedding });
  }
  return { records: merged, groups };
}

export interface SearchExplanation {
  id: string; path: string; score: number; semanticScore?: number; keywordScore?: number;
  matchedTerms: string[]; explanation: string;
}

/** 399. Explain a match with its component scores and terms found in indexed text/path. */
export function searchResultExplainer(query: string, result: SearchHit): SearchExplanation {
  const terms = [...new Set(tokenize(query).filter(term => !STOP_WORDS.has(term)))];
  const searchable = new Set(tokenize(`${result.text} ${result.path}`));
  const matchedTerms = terms.filter(term => searchable.has(term));
  const semantic = result.semanticScore ?? result.score;
  const keyword = result.keywordScore ?? keywordMatchScore(query, result.text, result.path);
  const explanation = `Semantic similarity ${semantic.toFixed(3)}; keyword match ${keyword.toFixed(3)}; matched terms: ${matchedTerms.length ? matchedTerms.join(', ') : 'none'}.`;
  return { id: result.id, path: result.path, score: result.score, ...(result.semanticScore === undefined ? {} : { semanticScore: result.semanticScore }), ...(result.keywordScore === undefined ? {} : { keywordScore: result.keywordScore }), matchedTerms, explanation };
}

/** 400. Estimate in-memory index bytes and compare them with an optional size budget. */
export function indexSizeMonitor(index: EmbeddingIndex, options: { maxBytes?: number } = {}): {
  recordCount: number; dimensions: number; estimatedBytes: number; maxBytes?: number; withinLimit: boolean;
} {
  const estimatedBytes = index.records.reduce((total, record) => total + record.embedding.length * 8 +
    Buffer.byteLength(record.id + record.path + record.text, 'utf8') + 64, 0);
  const maxBytes = options.maxBytes;
  if (maxBytes !== undefined && (!Number.isFinite(maxBytes) || maxBytes < 0)) throw new Error('maxBytes must be finite and non-negative');
  return { recordCount: index.records.length, dimensions: index.dimensions, estimatedBytes,
    ...(maxBytes === undefined ? {} : { maxBytes }), withinLimit: maxBytes === undefined || estimatedBytes <= maxBytes };
}
