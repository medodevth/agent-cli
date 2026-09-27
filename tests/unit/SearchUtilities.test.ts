import {
  chunkCodeForEmbedding,
  crossFileSemanticLink,
  duplicateEmbeddingMerger,
  embeddingCacheChecker,
  embeddingDimensionReducer,
  embeddingIndexBuilder,
  embeddingProviderSwitcher,
  generateEmbedding,
  hybridSearchRankers,
  incrementalIndexUpdater,
  indexHealthChecker,
  indexRebuildScheduler,
  indexSizeMonitor,
  naturalLanguageToCodeQuery,
  queryToEmbeddingCache,
  relevanceScoreThresholder,
  searchResultExplainer,
  semanticCodeSearch,
  similarCodeFinder,
  vectorSimilaritySearch,
} from '../../src/utils/SearchUtilities.js';
import type { EmbeddingIndex, EmbeddingRecord } from '../../src/utils/SearchUtilities.js';

const provider = (text: string): number[] => {
  const normalized = text.toLowerCase();
  return [normalized.includes('cat') ? 1 : 0, normalized.includes('dog') ? 1 : 0];
};

function record(id: string, path: string, text: string, embedding: number[]): EmbeddingRecord {
  return { id, path, text, embedding };
}

const index: EmbeddingIndex = {
  dimensions: 2,
  updatedAt: 10,
  records: [
    record('a', 'src/cat.ts', 'cat parser', [1, 0]),
    record('b', 'src/dog.ts', 'dog handler', [0, 1]),
    record('c', 'test/cat.test.ts', 'cat test', [0.9, 0.1]),
  ],
};

describe('SearchUtilities (381-400)', () => {
  it('generates deterministic normalized local vectors and accepts an injected provider', async () => {
    const first = await generateEmbedding('parse user input');
    expect(first).toEqual(await generateEmbedding('parse user input'));
    expect(Math.hypot(...first)).toBeCloseTo(1);
    await expect(generateEmbedding('hello', { provider: async () => [3, 4] })).resolves.toEqual([3, 4]);
    await expect(generateEmbedding('hello', { provider: () => [Number.NaN] })).rejects.toThrow(/finite/);
  });

  it('ranks vectors by cosine similarity and validates dimensions', () => {
    expect(vectorSimilaritySearch([1, 0], index.records, { topK: 2 }).map(hit => hit.id)).toEqual(['a', 'c']);
    expect(() => vectorSimilaritySearch([1], index.records)).toThrow(/dimension/i);
  });

  it('chunks code within character limits and records source line spans', () => {
    const chunks = chunkCodeForEmbedding('one\ntwo\nthree\nfour', 'src/file.ts', { maxChars: 7, overlapLines: 1 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toMatchObject({ path: 'src/file.ts', text: 'one\ntwo', startLine: 1, endLine: 2 });
    expect(chunks[1].text).toContain('two');
    expect(chunks.every(chunk => chunk.text.length <= 7)).toBe(true);
  });

  it('builds a searchable index by embedding chunks from files', async () => {
    const built = await embeddingIndexBuilder([{ path: 'src/cat.ts', content: 'cat code' }], {
      provider,
      chunkOptions: { maxChars: 100 },
    });
    expect(built).toMatchObject({ dimensions: 2, records: [{ path: 'src/cat.ts', embedding: [1, 0] }] });
  });

  it('updates only requested files and removes deleted paths', async () => {
    const original = await embeddingIndexBuilder([
      { path: 'keep.ts', content: 'dog' }, { path: 'change.ts', content: 'cat' },
    ], { provider });
    const updated = await incrementalIndexUpdater(original, {
      upsert: [{ path: 'change.ts', content: 'dog revised' }], remove: ['keep.ts'],
    }, { provider });
    expect(updated.records).toHaveLength(1);
    expect(updated.records[0]).toMatchObject({ path: 'change.ts', text: 'dog revised', embedding: [0, 1] });
    expect(original.records).toHaveLength(2);
  });

  it('performs semantic search with an injected embedding provider', async () => {
    const hits = await semanticCodeSearch('cat behavior', index, { provider, topK: 1 });
    expect(hits[0]).toMatchObject({ id: 'a', semanticScore: 1 });
  });

  it('combines semantic and keyword signals in hybrid ranking', async () => {
    const hits = await hybridSearchRankers('dog handler', index, { provider, topK: 1 });
    expect(hits[0]).toMatchObject({ id: 'b', score: 1, keywordScore: 1 });
  });

  it('checks normalized cache keys without computing a missing vector', () => {
    const cache = new Map<string, number[]>([['cat query', [1, 0]]]);
    expect(embeddingCacheChecker(cache, ' cat   query ')).toEqual({ hit: true, embedding: [1, 0] });
    expect(embeddingCacheChecker(cache, 'new query')).toEqual({ hit: false });
  });

  it('finds code with a similar embedding while excluding the source record', async () => {
    const hits = await similarCodeFinder(index.records[0], index, { topK: 2 });
    expect(hits.map(hit => hit.id)).toEqual(['c', 'b']);
  });

  it('computes and reuses query embeddings from an injected cache', async () => {
    const cache = new Map<string, number[]>();
    let embeddingCalls = 0;
    const embed = (text: string): number[] => { embeddingCalls++; return provider(text); };
    await expect(queryToEmbeddingCache('CAT', cache, { provider: embed })).resolves.toEqual([1, 0]);
    await expect(queryToEmbeddingCache(' cat ', cache, { provider: embed })).resolves.toEqual([1, 0]);
    expect(embeddingCalls).toBe(1);
  });

  it('reports malformed vectors and duplicate ids as index health issues', () => {
    const broken: EmbeddingIndex = { ...index, records: [...index.records, record('a', 'bad.ts', 'bad', [1])] };
    expect(indexHealthChecker(broken)).toMatchObject({ status: 'unhealthy', recordCount: 4, invalidVectorCount: 1, duplicateIdCount: 1 });
  });

  it('reduces a vector dimension by deterministic contiguous pooling', () => {
    expect(embeddingDimensionReducer([1, 3, 5, 7], 2)).toEqual([2, 6]);
    expect(() => embeddingDimensionReducer([1, 2], 3)).toThrow(/dimension/i);
  });

  it('links semantically similar chunks across distinct files only', () => {
    expect(crossFileSemanticLink(index, { threshold: 0.8 })).toEqual([
      expect.objectContaining({ sourceId: 'a', targetId: 'c', score: expect.any(Number) }),
    ]);
  });

  it('extracts useful code terms from a natural-language request', () => {
    expect(naturalLanguageToCodeQuery('Please find the function that parses HTTP requests')).toMatchObject({
      original: 'Please find the function that parses HTTP requests',
      terms: ['parse', 'http', 'request'],
    });
  });

  it('schedules index rebuilds on force, age, or changed-file threshold', () => {
    expect(indexRebuildScheduler({ lastRebuiltAt: 100, now: 120, changedFileCount: 1 })).toMatchObject({ scheduled: false });
    expect(indexRebuildScheduler({ lastRebuiltAt: 100, now: 200, maxAgeMs: 50 })).toMatchObject({ scheduled: true, reason: 'max-age' });
    expect(indexRebuildScheduler({ lastRebuiltAt: 100, now: 101, maxAgeMs: 1000, changedFileCount: 3, changeThreshold: 3 })).toMatchObject({ scheduled: true, reason: 'change-threshold' });
  });

  it('switches between named embedding providers and reports an unknown provider', async () => {
    const switcher = embeddingProviderSwitcher({ cat: provider, zeros: () => [0, 0] }, 'cat');
    await expect(switcher.embed('cat')).resolves.toEqual([1, 0]);
    switcher.setProvider('zeros');
    await expect(switcher.embed('cat')).resolves.toEqual([0, 0]);
    expect(() => switcher.setProvider('missing')).toThrow(/unknown/i);
  });

  it('filters search results at an inclusive relevance threshold', () => {
    const results = [{ ...index.records[0], score: 0.8 }, { ...index.records[1], score: 0.4 }];
    expect(relevanceScoreThresholder(results, 0.5).map(hit => hit.id)).toEqual(['a']);
  });

  it('merges vectors above the duplicate similarity threshold', () => {
    const merged = duplicateEmbeddingMerger([
      record('one', 'a.ts', 'same', [1, 0]), record('two', 'b.ts', 'same copy', [1, 0]), record('three', 'c.ts', 'other', [0, 1]),
    ]);
    expect(merged.records.map(item => item.id)).toEqual(['one', 'three']);
    expect(merged.groups).toEqual([['one', 'two']]);
  });

  it('explains semantic and keyword contributions to a search result', () => {
    const explanation = searchResultExplainer('cat parser', { ...index.records[0], score: 1, semanticScore: 1, keywordScore: 1 });
    expect(explanation).toMatchObject({ id: 'a', path: 'src/cat.ts', matchedTerms: ['cat', 'parser'] });
    expect(explanation.explanation).toMatch(/semantic/i);
  });

  it('monitors vector count and estimated index size against a byte limit', () => {
    expect(indexSizeMonitor(index, { maxBytes: 1 })).toMatchObject({ recordCount: 3, dimensions: 2, withinLimit: false, estimatedBytes: expect.any(Number) });
  });
});
