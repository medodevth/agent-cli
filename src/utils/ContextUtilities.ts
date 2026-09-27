export type ExactTokenizer = (text: string) => number;

/** A single context item. Session ownership is mandatory so callers can enforce isolation. */
export interface ContextEntry {
  id: string;
  sessionId: string;
  text: string;
  source?: string;
  filePath?: string;
  fileMtimeMs?: number;
  priority?: number;
  relevance?: number;
  createdAt?: number;
  updatedAt?: number;
  tags?: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ContextWindowFit {
  fits: boolean;
  usedTokens: number;
  maxTokens: number;
  reservedTokens: number;
  availableTokens: number;
  remainingTokens: number;
}

export interface ContextMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface SummarizeOldMessagesOptions {
  sessionId: string;
  keepRecent?: number;
  summarize?: (messages: readonly ContextMessage[]) => string;
}

export interface SummarizeOldMessagesResult {
  summary: string;
  retainedMessages: ContextMessage[];
  summarizedCount: number;
}

export interface ContextSessionOptions {
  sessionId: string;
  allowedSources?: readonly string[];
}

export interface InjectRelevantFilesOptions extends ContextSessionOptions {
  dependencyGraph: Readonly<Record<string, readonly string[]>>;
  files: Readonly<Record<string, string>>;
  changedFiles?: readonly string[];
  maxFiles?: number;
}

export interface ContextCheckpoint {
  sessionId: string;
  savedAt: number;
  entries: ContextEntry[];
}

export interface ContextChanged<T> {
  before: T;
  after: T;
}

export interface ContextDiff<T> {
  added: T[];
  removed: T[];
  changed: Array<ContextChanged<T>>;
  unchanged: T[];
}

export interface ContextBudgetAllocation {
  allocations: Record<string, number>;
  totalBudget: number;
  allocatedTokens: number;
  remainingTokens: number;
}

export interface CrossSessionLoadOptions {
  sessionId: string;
  allowedSessionIds: readonly string[];
}

export interface ContextSizeEstimate {
  exact: boolean;
  tokenCount: number;
  characterCount: number;
  availableTokens?: number;
  fits?: boolean;
}

function validateBudget(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function requireSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new TypeError('An explicit non-empty sessionId is required');
  }
}

function requireEntrySession(entry: ContextEntry): void {
  if (typeof entry.sessionId !== 'string' || entry.sessionId.trim().length === 0) {
    throw new TypeError(`Context entry ${entry.id || '(unknown)'} is missing a sessionId`);
  }
}

/** Count tokens with the provider's tokenizer; this function deliberately has no heuristic fallback. */
export function countTokensExact(text: string, tokenizer: ExactTokenizer): number {
  if (typeof tokenizer !== 'function') {
    throw new TypeError('A provider tokenizer is required for an exact token count');
  }
  const count = tokenizer(text);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError('Tokenizer must return a non-negative integer token count');
  }
  return count;
}

/** Check fit after reserving tokens for the model response. */
export function contextWindowFitChecker(
  context: string | readonly Pick<ContextEntry, 'text'>[],
  maxTokens: number,
  tokenizer: ExactTokenizer,
  reservedTokens = 0
): ContextWindowFit {
  validateBudget(maxTokens, 'maxTokens');
  validateBudget(reservedTokens, 'reservedTokens');
  const text = typeof context === 'string' ? context : context.map(entry => entry.text).join('\n');
  const usedTokens = countTokensExact(text, tokenizer);
  const availableTokens = maxTokens - reservedTokens;
  const remainingTokens = availableTokens - usedTokens;
  return {
    fits: remainingTokens >= 0,
    usedTokens,
    maxTokens,
    reservedTokens,
    availableTokens,
    remainingTokens,
  };
}

/** Compact the old portion of one session without ever reading another session's messages. */
export function summarizeOldMessages(
  messages: readonly ContextMessage[],
  options: SummarizeOldMessagesOptions
): SummarizeOldMessagesResult {
  requireSessionId(options.sessionId);
  const keepRecent = options.keepRecent ?? 4;
  validateBudget(keepRecent, 'keepRecent');
  const sessionMessages = messages.filter(message => message.sessionId === options.sessionId);
  const splitAt = Math.max(0, sessionMessages.length - keepRecent);
  const oldMessages = sessionMessages.slice(0, splitAt);
  const retainedMessages = sessionMessages.slice(splitAt).map(message => ({ ...message }));
  const summary = options.summarize
    ? options.summarize(oldMessages)
    : oldMessages
        .map(message => `${message.role}: ${message.content.trim()}`)
        .filter(line => line.length > 0)
        .join('\n');
  return { summary, retainedMessages, summarizedCount: oldMessages.length };
}

function tokenizeForRelevance(text: string): Set<string> {
  return new Set(
    text
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.filter(token => token.length > 1) ?? []
  );
}

function relevanceScore(text: string, queryTokens: ReadonlySet<string>): number {
  if (queryTokens.size === 0) return 1;
  const tokens = tokenizeForRelevance(text);
  let overlap = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) overlap += 1;
  }
  return overlap / queryTokens.size;
}

/** Keep only entries owned by the requested session and meeting the lexical relevance threshold. */
export function pruneIrrelevantContext<T extends ContextEntry>(
  entries: readonly T[],
  query: string,
  options: ContextSessionOptions & { minRelevance?: number }
): T[] {
  requireSessionId(options.sessionId);
  const minRelevance = options.minRelevance ?? 0.2;
  if (!Number.isFinite(minRelevance) || minRelevance < 0 || minRelevance > 1) {
    throw new RangeError('minRelevance must be between 0 and 1');
  }
  const queryTokens = tokenizeForRelevance(query);
  return entries.filter(entry => {
    requireEntrySession(entry);
    if (entry.sessionId !== options.sessionId) return false;
    if (options.allowedSources && entry.source && !options.allowedSources.includes(entry.source)) return false;
    const score = relevanceScore(entry.text, queryTokens);
    return score >= minRelevance;
  });
}

/** Add changed files and their transitive dependencies, preserving deterministic graph order. */
export function injectRelevantFiles(options: InjectRelevantFilesOptions): ContextEntry[] {
  requireSessionId(options.sessionId);
  const roots = options.changedFiles ?? Object.keys(options.files);
  const visited = new Set<string>();
  const ordered: string[] = [];
  const visit = (filePath: string): void => {
    if (visited.has(filePath) || !(filePath in options.files)) return;
    visited.add(filePath);
    ordered.push(filePath);
    for (const dependency of options.dependencyGraph[filePath] ?? []) visit(dependency);
  };
  for (const root of roots) visit(root);
  const limited = options.maxFiles === undefined ? ordered : ordered.slice(0, Math.max(0, options.maxFiles));
  return limited
    .filter(filePath => !options.allowedSources || options.allowedSources.includes(filePath))
    .map(filePath => ({
      id: `file:${filePath}`,
      sessionId: options.sessionId,
      text: options.files[filePath],
      source: filePath,
      filePath,
    }));
}

/** Rank entries by descending explicit priority, then relevance, while retaining stable ties. */
export function contextPriorityRanker<T extends ContextEntry>(
  entries: readonly T[],
  options: ContextSessionOptions = { sessionId: '' }
): T[] {
  requireSessionId(options.sessionId);
  return entries
    .map((entry, index) => {
      requireEntrySession(entry);
      return { entry, index };
    })
    .filter(({ entry }) => entry.sessionId === options.sessionId)
    .sort((a, b) =>
      (b.entry.priority ?? 0) - (a.entry.priority ?? 0) ||
      (b.entry.relevance ?? 0) - (a.entry.relevance ?? 0) ||
      a.index - b.index
    )
    .map(({ entry }) => entry);
}

/** Return the newest entries that fit the token budget, retaining chronological order. */
export function slidingWindowContext<T extends ContextEntry>(
  entries: readonly T[],
  maxTokens: number,
  tokenizer: ExactTokenizer,
  options: ContextSessionOptions
): T[] {
  requireSessionId(options.sessionId);
  validateBudget(maxTokens, 'maxTokens');
  const sessionEntries = entries.filter(entry => {
    requireEntrySession(entry);
    return entry.sessionId === options.sessionId;
  });
  const selected: T[] = [];
  let used = 0;
  for (let index = sessionEntries.length - 1; index >= 0; index -= 1) {
    const entry = sessionEntries[index];
    const cost = countTokensExact(entry.text, tokenizer);
    if (used + cost > maxTokens) break;
    selected.unshift(entry);
    used += cost;
  }
  return selected;
}

/** Save a deep-enough immutable snapshot of one session's entries. */
export function contextCheckpointSave(
  sessionId: string,
  entries: readonly ContextEntry[],
  savedAt = Date.now()
): ContextCheckpoint {
  requireSessionId(sessionId);
  if (!Number.isFinite(savedAt)) throw new RangeError('savedAt must be finite');
  return {
    sessionId,
    savedAt,
    entries: entries
      .filter(entry => {
        requireEntrySession(entry);
        return entry.sessionId === sessionId;
      })
      .map(entry => ({
        ...entry,
        tags: entry.tags ? [...entry.tags] : undefined,
        metadata: entry.metadata ? structuredClone(entry.metadata) : undefined,
      })),
  };
}

function cloneContextEntry<T extends ContextEntry>(entry: T): T {
  return {
    ...entry,
    tags: entry.tags ? [...entry.tags] : undefined,
    metadata: entry.metadata ? structuredClone(entry.metadata) : undefined,
  };
}

/** Restore a checkpoint only when its owner matches the requesting session. */
export function contextCheckpointRestore(checkpoint: ContextCheckpoint, sessionId: string): ContextEntry[] {
  requireSessionId(sessionId);
  if (checkpoint.sessionId !== sessionId) return [];
  for (const entry of checkpoint.entries) {
    requireEntrySession(entry);
    if (entry.sessionId !== sessionId) throw new Error('Checkpoint contains an entry from a different session');
  }
  return checkpoint.entries.map(entry => ({
    ...entry,
    tags: entry.tags ? [...entry.tags] : undefined,
    metadata: entry.metadata ? structuredClone(entry.metadata) : undefined,
  }));
}

/** Merge sub-agent entries only from an explicit allowlist, rewriting ownership to the active session. */
export function mergeContextFromSubAgent<T extends ContextEntry>(
  existing: readonly T[],
  subAgentEntries: readonly T[],
  options: CrossSessionLoadOptions
): T[] {
  requireSessionId(options.sessionId);
  const allowed = new Set(options.allowedSessionIds);
  if (allowed.has(options.sessionId)) throw new Error('The active session cannot be an allowed sub-agent session');
  const activeEntries = existing.filter(entry => {
    requireEntrySession(entry);
    return entry.sessionId === options.sessionId;
  }).map(cloneContextEntry);
  const accepted = subAgentEntries.filter(entry => {
    requireEntrySession(entry);
    return allowed.has(entry.sessionId);
  }).map(entry => cloneContextEntry({ ...entry, sessionId: options.sessionId } as T));
  return deduplicateContextEntries([...activeEntries, ...accepted]);
}

/** Remove duplicate session entries by normalized content, retaining the first occurrence. */
export function deduplicateContextEntries<T extends ContextEntry>(entries: readonly T[]): T[] {
  const seen = new Set<string>();
  return entries.filter(entry => {
    requireEntrySession(entry);
    const key = `${entry.sessionId}\u0000${entry.text.trim().replace(/\s+/g, ' ').toLocaleLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(entry => ({ ...entry }));
}

export interface ContextFreshnessResult {
  id: string;
  filePath: string;
  fresh: boolean;
  expectedMtimeMs: number;
  actualMtimeMs?: number;
}

/** Check file-backed entries against an injected clock/filesystem lookup. */
export function contextFreshnessChecker(
  entries: readonly ContextEntry[],
  options: ContextSessionOptions & { getFileMtimeMs: (filePath: string) => number | undefined }
): ContextFreshnessResult[] {
  requireSessionId(options.sessionId);
  return entries.filter(entry => entry.sessionId === options.sessionId && entry.filePath !== undefined && entry.fileMtimeMs !== undefined)
    .map(entry => {
      const actualMtimeMs = options.getFileMtimeMs(entry.filePath!);
      return { id: entry.id, filePath: entry.filePath!, fresh: actualMtimeMs === entry.fileMtimeMs, expectedMtimeMs: entry.fileMtimeMs!, actualMtimeMs };
    });
}

/** Allocate an integer token budget according to weights using largest-remainder rounding. */
export function contextBudgetAllocator(totalBudget: number, weights: Readonly<Record<string, number>>): ContextBudgetAllocation {
  validateBudget(totalBudget, 'totalBudget');
  const names = Object.keys(weights);
  const totalWeight = names.reduce((sum, name) => {
    const weight = weights[name];
    if (!Number.isFinite(weight) || weight < 0) throw new RangeError('Budget weights must be finite and non-negative');
    return sum + weight;
  }, 0);
  if (names.length === 0 || totalWeight <= 0) return { allocations: {}, totalBudget, allocatedTokens: 0, remainingTokens: totalBudget };
  const raw = names.map(name => ({ name, base: Math.floor(totalBudget * weights[name] / totalWeight), remainder: totalBudget * weights[name] / totalWeight % 1 }));
  let assigned = raw.reduce((sum, item) => sum + item.base, 0);
  raw.sort((a, b) => b.remainder - a.remainder || names.indexOf(a.name) - names.indexOf(b.name));
  for (let index = 0; assigned < totalBudget; index += 1, assigned += 1) raw[index % raw.length].base += 1;
  const allocations = Object.fromEntries(names.map(name => [name, raw.find(item => item.name === name)!.base]));
  return { allocations, totalBudget, allocatedTokens: assigned, remainingTokens: totalBudget - assigned };
}

/** Extract matching lines and bounded neighboring lines. */
export function extractRelevantSnippet(
  text: string,
  query: string | RegExp,
  options: { before?: number; after?: number } = {}
): string {
  const before = options.before ?? 2;
  const after = options.after ?? 2;
  validateBudget(before, 'before');
  validateBudget(after, 'after');
  const lines = text.split(/\r?\n/);
  const matcher = typeof query === 'string' ? (line: string) => line.toLocaleLowerCase().includes(query.toLocaleLowerCase()) : (line: string) => {
    query.lastIndex = 0;
    return query.test(line);
  };
  const selected = new Set<number>();
  lines.forEach((line, index) => {
    if (matcher(line)) for (let lineIndex = Math.max(0, index - before); lineIndex <= Math.min(lines.length - 1, index + after); lineIndex += 1) selected.add(lineIndex);
  });
  return [...selected].sort((a, b) => a - b).map(index => lines[index]).join('\n');
}

export interface ContextCompressionResult { beforeTokens: number; afterTokens: number; ratio: number; savedTokens: number; }

/** Measure compaction using the provider tokenizer, not character estimates. */
export function contextCompressionRatio(before: string, after: string, tokenizer: ExactTokenizer): ContextCompressionResult {
  const beforeTokens = countTokensExact(before, tokenizer);
  const afterTokens = countTokensExact(after, tokenizer);
  return { beforeTokens, afterTokens, ratio: beforeTokens === 0 ? 1 : afterTokens / beforeTokens, savedTokens: beforeTokens - afterTokens };
}

/** Load cross-session entries only when every source session is explicitly allowlisted. */
export function crossSessionContextLoader<T extends ContextEntry>(entries: readonly T[], options: CrossSessionLoadOptions): T[] {
  requireSessionId(options.sessionId);
  const allowed = new Set(options.allowedSessionIds);
  if (allowed.has(options.sessionId)) throw new Error('The active session cannot be loaded as cross-session context');
  return entries.filter(entry => {
    requireEntrySession(entry);
    return entry.sessionId !== options.sessionId && allowed.has(entry.sessionId);
  }).map(entry => ({ ...entry }));
}

/** Compare session-owned context by ID and content. */
export function contextDiffTracker<T extends ContextEntry>(before: readonly T[], after: readonly T[], options: ContextSessionOptions): ContextDiff<T> {
  requireSessionId(options.sessionId);
  const oldEntries = before.filter(entry => entry.sessionId === options.sessionId);
  const newEntries = after.filter(entry => entry.sessionId === options.sessionId);
  const oldById = new Map(oldEntries.map(entry => [entry.id, entry]));
  const newById = new Map(newEntries.map(entry => [entry.id, entry]));
  const added = newEntries.filter(entry => !oldById.has(entry.id)).map(cloneContextEntry);
  const removed = oldEntries.filter(entry => !newById.has(entry.id)).map(cloneContextEntry);
  const changed = newEntries.flatMap(afterEntry => {
    const beforeEntry = oldById.get(afterEntry.id);
    return beforeEntry && beforeEntry.text !== afterEntry.text
      ? [{ before: cloneContextEntry(beforeEntry), after: cloneContextEntry(afterEntry) }]
      : [];
  });
  const unchanged = newEntries.filter(entry => oldById.get(entry.id)?.text === entry.text).map(cloneContextEntry);
  return { added, removed, changed, unchanged };
}

export interface PromptSection { name: string; content: string; }

/** Compose named non-empty prompt sections deterministically. */
export function systemPromptComposer(sections: readonly PromptSection[]): string {
  return sections.filter(section => section.content.trim().length > 0).map(section => `## ${section.name}\n${section.content.trim()}`).join('\n\n');
}

export interface FewShotExample { id: string; input: string; output: string; score?: number; }

/** Select highest-scoring examples that fit a token budget, preserving score ties by input order. */
export function fewShotExampleSelector<T extends FewShotExample>(examples: readonly T[], maxTokens: number, tokenizer: ExactTokenizer): T[] {
  validateBudget(maxTokens, 'maxTokens');
  const ranked = examples.map((example, index) => ({ example, index })).sort((a, b) => (b.example.score ?? 0) - (a.example.score ?? 0) || a.index - b.index);
  const selected: T[] = [];
  let used = 0;
  for (const { example } of ranked) {
    const cost = countTokensExact(`${example.input}\n${example.output}`, tokenizer);
    if (used + cost > maxTokens) continue;
    selected.push(example);
    used += cost;
  }
  return selected;
}

export interface ContextLeakReport { leaks: Array<{ id: string; reason: string }>; sensitiveEntryIds: string[]; }

/** Detect foreign-session entries and common secret markers before a context call. */
export function contextLeakDetector(entries: readonly ContextEntry[], options: ContextSessionOptions): ContextLeakReport {
  requireSessionId(options.sessionId);
  const leaks: Array<{ id: string; reason: string }> = [];
  const sensitiveEntryIds: string[] = [];
  const secretPattern = /(?:api[_-]?key|secret|password|token)\s*[:=]/i;
  for (const entry of entries) {
    requireEntrySession(entry);
    if (entry.sessionId !== options.sessionId) leaks.push({ id: entry.id, reason: 'foreign-session' });
    if (secretPattern.test(entry.text)) sensitiveEntryIds.push(entry.id);
  }
  return { leaks, sensitiveEntryIds };
}

/** Estimate pre-call size through an exact provider tokenizer. */
export function contextSizeEstimatorBeforeCall(text: string, tokenizer: ExactTokenizer, maxTokens?: number): ContextSizeEstimate {
  const tokenCount = countTokensExact(text, tokenizer);
  const estimate: ContextSizeEstimate = { exact: true, tokenCount, characterCount: text.length };
  if (maxTokens !== undefined) {
    validateBudget(maxTokens, 'maxTokens');
    estimate.availableTokens = maxTokens - tokenCount;
    estimate.fits = estimate.availableTokens >= 0;
  }
  return estimate;
}

