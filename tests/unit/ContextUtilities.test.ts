import {
  countTokensExact,
  contextWindowFitChecker,
  injectRelevantFiles,
  contextPriorityRanker,
  slidingWindowContext,
  contextCheckpointSave,
  contextCheckpointRestore,
  mergeContextFromSubAgent,
  deduplicateContextEntries,
  contextFreshnessChecker,
  contextBudgetAllocator,
  extractRelevantSnippet,
  contextCompressionRatio,
  crossSessionContextLoader,
  contextDiffTracker,
  systemPromptComposer,
  fewShotExampleSelector,
  contextLeakDetector,
  contextSizeEstimatorBeforeCall,
  pruneIrrelevantContext,
  summarizeOldMessages,
} from '../../src/utils/ContextUtilities.js';

describe('ContextUtilities (K: token and context management)', () => {
  it('uses the injected provider tokenizer for exact token counts', () => {
    const calls: string[] = [];
    const tokenizer = (text: string): number => {
      calls.push(text);
      return text.trim().split(' ').filter(Boolean).length;
    };

    expect(countTokensExact('alpha beta  gamma', tokenizer)).toBe(3);
    expect(calls).toEqual(['alpha beta  gamma']);
  });

  it('rejects missing or invalid exact tokenizers instead of guessing', () => {
    expect(() => countTokensExact('text', undefined as never)).toThrow(/tokenizer/i);
    expect(() => countTokensExact('text', () => Number.NaN)).toThrow(/non-negative integer/i);
    expect(() => countTokensExact('text', () => -1)).toThrow(/non-negative integer/i);
  });

  it('checks context fit with reserved output budget using exact tokenizer counts', () => {
    const fit = contextWindowFitChecker('one two three', 5, text => text.split(/\s+/).filter(Boolean).length, 2);
    const overflow = contextWindowFitChecker('one two three four', 5, text => text.split(/\s+/).filter(Boolean).length, 2);

    expect(fit).toEqual({
      fits: true,
      usedTokens: 3,
      maxTokens: 5,
      reservedTokens: 2,
      availableTokens: 3,
      remainingTokens: 0,
    });
    expect(overflow.fits).toBe(false);
    expect(overflow.remainingTokens).toBe(-1);
  });

  it('compacts only older messages from the explicitly selected session', () => {
    const messages = [
      { id: 'a', sessionId: 's1', role: 'user', content: '  Need login.  ' },
      { id: 'b', sessionId: 's1', role: 'assistant', content: 'Use OAuth for login.' },
      { id: 'foreign', sessionId: 's2', role: 'user', content: 'private other session' },
      { id: 'c', sessionId: 's1', role: 'user', content: 'Keep this recent.' },
    ];

    const compacted = summarizeOldMessages(messages, { sessionId: 's1', keepRecent: 1 });

    expect(compacted.summary).toContain('Need login.');
    expect(compacted.summary).toContain('Use OAuth for login.');
    expect(compacted.summary).not.toContain('private other session');
    expect(compacted.retainedMessages.map(message => message.id)).toEqual(['c']);
    expect(compacted.summarizedCount).toBe(2);
  });

  it('prunes low-relevance and foreign-session context without reordering relevant entries', () => {
    const entries = [
      { id: 'a', sessionId: 's1', text: 'The login flow uses OAuth tokens.' },
      { id: 'b', sessionId: 's1', text: 'Database backup rotation.' },
      { id: 'foreign', sessionId: 's2', text: 'login password from another session' },
    ];

    expect(pruneIrrelevantContext(entries, 'login OAuth', { sessionId: 's1' }).map(entry => entry.id)).toEqual(['a']);
  });

  it('injects files reachable from changed files through the dependency graph', () => {
    const files = {
      'src/app.ts': 'imports ./auth.ts',
      'src/auth.ts': 'exports auth logic',
      'src/db.ts': 'exports storage',
      'src/unrelated.ts': 'irrelevant',
    };
    const injected = injectRelevantFiles({
      sessionId: 's1',
      changedFiles: ['src/app.ts'],
      dependencyGraph: { 'src/app.ts': ['src/auth.ts'], 'src/auth.ts': ['src/db.ts'] },
      files,
    });

    expect(injected.map(entry => entry.filePath)).toEqual(['src/app.ts', 'src/auth.ts', 'src/db.ts']);
    expect(injected.every(entry => entry.sessionId === 's1')).toBe(true);
  });

  it('ranks context by priority and relevance with stable input order for ties', () => {
    const entries = [
      { id: 'first', sessionId: 's1', text: 'first', priority: 2, relevance: 1 },
      { id: 'last', sessionId: 's1', text: 'last', priority: 1, relevance: 0.5 },
      { id: 'second', sessionId: 's1', text: 'second', priority: 2, relevance: 1 },
    ];

    expect(contextPriorityRanker(entries, { sessionId: 's1' }).map(entry => entry.id)).toEqual(['first', 'second', 'last']);
  });

  it('selects a token-budgeted sliding window of the most recent entries', () => {
    const entries = [
      { id: 'a', sessionId: 's1', text: 'old' },
      { id: 'b', sessionId: 's1', text: 'middle' },
      { id: 'c', sessionId: 's1', text: 'recent' },
    ];
    expect(slidingWindowContext(entries, 2, text => text.split(/\s+/).filter(Boolean).length, { sessionId: 's1' }).map(entry => entry.id)).toEqual(['b', 'c']);
  });

  it('saves and restores cloned checkpoints only for the named session', () => {
    const checkpoint = contextCheckpointSave('s1', [
      { id: 'a', sessionId: 's1', text: 'private s1' },
      { id: 'b', sessionId: 's2', text: 'private s2' },
    ], 100);

    expect(checkpoint.entries.map(entry => entry.id)).toEqual(['a']);
    expect(contextCheckpointRestore(checkpoint, 's2')).toEqual([]);
    const restored = contextCheckpointRestore(checkpoint, 's1');
    expect(restored).toEqual([{ id: 'a', sessionId: 's1', text: 'private s1' }]);
    expect(restored[0]).not.toBe(checkpoint.entries[0]);
  });

  it('rejects a checkpoint whose payload contains a foreign session entry', () => {
    expect(() => contextCheckpointRestore({
      sessionId: 's1',
      savedAt: 100,
      entries: [{ id: 'foreign', sessionId: 's2', text: 'must not leak' }],
    }, 's1')).toThrow(/checkpoint.*session|session.*checkpoint/i);
  });

  it('merges sub-agent context through an explicit allowlist and deduplicates by normalized text', () => {
    const merged = mergeContextFromSubAgent(
      [{ id: 'main', sessionId: 's1', text: 'Existing fact' }],
      [{ id: 'sub', sessionId: 'sub-1', text: ' existing   fact ' }, { id: 'new', sessionId: 'sub-1', text: 'New finding' }],
      { sessionId: 's1', allowedSessionIds: ['sub-1'] }
    );
    expect(merged.map(entry => entry.text)).toEqual(['Existing fact', 'New finding']);
    expect(merged.every(entry => entry.sessionId === 's1')).toBe(true);
  });

  it('deduplicates context case-insensitively without losing first-entry order', () => {
    expect(deduplicateContextEntries([
      { id: 'a', sessionId: 's1', text: 'Alpha  beta' },
      { id: 'b', sessionId: 's1', text: ' alpha beta ' },
      { id: 'c', sessionId: 's1', text: 'Gamma' },
    ]).map(entry => entry.id)).toEqual(['a', 'c']);
  });

  it('reports stale file-backed context against an injected mtime lookup', () => {
    expect(contextFreshnessChecker(
      [{ id: 'a', sessionId: 's1', text: 'x', filePath: 'a.ts', fileMtimeMs: 10 }],
      { sessionId: 's1', getFileMtimeMs: filePath => filePath === 'a.ts' ? 11 : undefined }
    )).toEqual([{ id: 'a', filePath: 'a.ts', fresh: false, expectedMtimeMs: 10, actualMtimeMs: 11 }]);
  });

  it('allocates integer budget proportionally and gives deterministic remainder to first tasks', () => {
    expect(contextBudgetAllocator(10, { first: 1, second: 1, third: 2 })).toEqual({
      allocations: { first: 3, second: 2, third: 5 }, totalBudget: 10, allocatedTokens: 10, remainingTokens: 0,
    });
  });

  it('extracts matching lines with surrounding context instead of injecting a whole file', () => {
    expect(extractRelevantSnippet('one\nlogin start\nsecret\nlogin end\nfive', 'login', { before: 1, after: 1 }))
      .toBe('one\nlogin start\nsecret\nlogin end\nfive');
    expect(extractRelevantSnippet('zero\none\ntarget\nthree\nfour\nfive', 'target', { before: 0, after: 1 }))
      .toBe('target\nthree');
  });

  it('calculates compression ratio from exact before and after token counts', () => {
    expect(contextCompressionRatio('one two three four', 'one two', text => text.split(/\s+/).filter(Boolean).length)).toEqual({
      beforeTokens: 4, afterTokens: 2, ratio: 0.5, savedTokens: 2,
    });
  });

  it('loads only allowlisted sessions and rejects the active session from cross-session lookup', () => {
    expect(crossSessionContextLoader([
      { id: 'a', sessionId: 's1', text: 'same' },
      { id: 'b', sessionId: 's2', text: 'allowed' },
      { id: 'c', sessionId: 's3', text: 'blocked' },
    ], { sessionId: 's1', allowedSessionIds: ['s2'] }).map(entry => entry.id)).toEqual(['b']);
  });

  it('tracks added, removed, and unchanged context IDs', () => {
    expect(contextDiffTracker(
      [{ id: 'a', sessionId: 's1', text: 'same' }, { id: 'b', sessionId: 's1', text: 'old' }],
      [{ id: 'a', sessionId: 's1', text: 'same' }, { id: 'c', sessionId: 's1', text: 'new' }],
      { sessionId: 's1' }
    )).toMatchObject({ added: [{ id: 'c' }], removed: [{ id: 'b' }], unchanged: [{ id: 'a' }] });
  });

  it('composes prompt sections in supplied order and omits empty sections', () => {
    expect(systemPromptComposer([{ name: 'rules', content: 'Be safe' }, { name: 'empty', content: '  ' }, { name: 'style', content: 'Be concise' }]))
      .toBe('## rules\nBe safe\n\n## style\nBe concise');
  });

  it('selects the highest scoring few-shot examples under a token budget', () => {
    const examples = [
      { id: 'low', input: 'low', output: 'x', score: 0.2 },
      { id: 'high', input: 'high', output: 'y', score: 0.9 },
      { id: 'mid', input: 'mid', output: 'z', score: 0.5 },
    ];
    expect(fewShotExampleSelector(examples, 4, text => text.split(/\s+/).filter(Boolean).length).map(example => example.id)).toEqual(['high', 'mid']);
  });

  it('detects entries from a different session and unsafe secret-like text', () => {
    const report = contextLeakDetector([
      { id: 'foreign', sessionId: 's2', text: 'api_key=abc' },
      { id: 'ok', sessionId: 's1', text: 'ordinary context' },
    ], { sessionId: 's1' });
    expect(report.leaks).toEqual([{ id: 'foreign', reason: 'foreign-session' }]);
    expect(report.sensitiveEntryIds).toEqual(['foreign']);
  });

  it('estimates size with the injected tokenizer and reports available capacity', () => {
    const tokenizer = (text: string): number => text.trim() ? text.trim().split(' ').length : 0;
    expect(contextSizeEstimatorBeforeCall('one two', tokenizer, 5)).toEqual({
      exact: true, tokenCount: 2, characterCount: 7, availableTokens: 3, fits: true,
    });
  });

  it('detects changed content by ID as well as added and removed entries', () => {
    expect(contextDiffTracker(
      [{ id: 'changed', sessionId: 's1', text: 'before' }, { id: 'same', sessionId: 's1', text: 'unchanged' }],
      [{ id: 'changed', sessionId: 's1', text: 'after' }, { id: 'same', sessionId: 's1', text: 'unchanged' }],
      { sessionId: 's1' }
    )).toEqual({
      added: [],
      removed: [],
      changed: [{ before: { id: 'changed', sessionId: 's1', text: 'before' }, after: { id: 'changed', sessionId: 's1', text: 'after' } }],
      unchanged: [{ id: 'same', sessionId: 's1', text: 'unchanged' }],
    });
  });

  it('isolates checkpoint snapshots from nested metadata mutation', () => {
    const entry = { id: 'a', sessionId: 's1', text: 'fact', metadata: { nested: { value: 1 } } };
    const checkpoint = contextCheckpointSave('s1', [entry], 100);
    (entry.metadata.nested as { value: number }).value = 2;
    expect(checkpoint.entries[0].metadata?.nested).toEqual({ value: 1 });

    const restored = contextCheckpointRestore(checkpoint, 's1');
    (restored[0].metadata!.nested as { value: number }).value = 3;
    expect(checkpoint.entries[0].metadata?.nested).toEqual({ value: 1 });
  });

  it('drops foreign-session preexisting entries during a sub-agent merge', () => {
    const merged = mergeContextFromSubAgent(
      [
        { id: 'owned', sessionId: 's1', text: 'current session' },
        { id: 'foreign', sessionId: 's2', text: 'must not leak' },
      ],
      [{ id: 'sub', sessionId: 'sub-1', text: 'approved finding' }],
      { sessionId: 's1', allowedSessionIds: ['sub-1'] }
    );
    expect(merged.map(entry => entry.id)).toEqual(['owned', 'sub']);
    expect(merged.every(entry => entry.sessionId === 's1')).toBe(true);
  });
});

