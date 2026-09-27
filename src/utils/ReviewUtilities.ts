/**
 * ReviewUtilities — pure human-review workflow helpers for docs/500-functions.txt
 * category X (461–480). External notifications are opt-in callbacks; the module
 * performs no filesystem, network, clock, or terminal IO by itself.
 */

export interface DiffFile {
  file: string;
  diff: string;
  additions?: number;
  deletions?: number;
}

export interface DiffBatch {
  module: string;
  files: string[];
  diffs: Record<string, string>;
  additions: number;
  deletions: number;
}

function moduleForFile(file: string): string {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? normalized : normalized.slice(0, slash) || '/';
}

function countDiff(diff: string): { additions: number; deletions: number } {
  const lines = diff.split(/\r?\n/);
  return {
    additions: lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length,
    deletions: lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length,
  };
}

/** 461. Group changed files and their diffs by containing module/directory. */
export function batchDiffGrouper(files: DiffFile[]): DiffBatch[] {
  const grouped = new Map<string, DiffBatch>();
  for (const item of files) {
    const module = moduleForFile(item.file);
    let batch = grouped.get(module);
    if (!batch) {
      batch = { module, files: [], diffs: {}, additions: 0, deletions: 0 };
      grouped.set(module, batch);
    }
    if (batch.files.includes(item.file)) throw new Error(`duplicate diff file: ${item.file}`);
    const counts = countDiff(item.diff);
    batch.files.push(item.file);
    batch.diffs[item.file] = item.diff;
    batch.additions += item.additions ?? counts.additions;
    batch.deletions += item.deletions ?? counts.deletions;
  }
  return [...grouped.values()].map(batch => ({
    ...batch,
    files: [...batch.files].sort((a, b) => a.localeCompare(b)),
    diffs: Object.fromEntries(Object.entries(batch.diffs).sort(([a], [b]) => a.localeCompare(b))),
  })).sort((a, b) => a.module.localeCompare(b.module));
}

export interface ReviewQueueItem {
  id: string;
  priority?: number;
  createdAt?: number;
  [key: string]: unknown;
}

export interface ApprovalQueue {
  readonly size: number;
  enqueue: (item: ReviewQueueItem) => void;
  peek: () => ReviewQueueItem | undefined;
  dequeue: () => ReviewQueueItem | undefined;
  remove: (id: string) => boolean;
  snapshot: () => ReviewQueueItem[];
}

/** 462. Create an in-memory priority queue with stable FIFO tie ordering. */
export function approvalQueueManager(initial: ReviewQueueItem[] = []): ApprovalQueue {
  const queue: Array<{ item: ReviewQueueItem; order: number }> = [];
  let order = 0;
  const copy = (item: ReviewQueueItem): ReviewQueueItem => ({ ...item });
  const sort = (): void => { queue.sort((a, b) => (b.item.priority ?? 0) - (a.item.priority ?? 0) || a.order - b.order); };
  for (const item of initial) queue.push({ item: copy(item), order: order++ });
  sort();
  return {
    get size() { return queue.length; },
    enqueue(item) {
      if (!item.id.trim()) throw new Error('queue item id is required');
      if (queue.some(entry => entry.item.id === item.id)) throw new Error(`duplicate queue item id: ${item.id}`);
      queue.push({ item: copy(item), order: order++ });
      sort();
    },
    peek: () => queue.length ? copy(queue[0].item) : undefined,
    dequeue: () => queue.length ? copy(queue.shift()!.item) : undefined,
    remove(id) {
      const index = queue.findIndex(entry => entry.item.id === id);
      if (index < 0) return false;
      queue.splice(index, 1);
      return true;
    },
    snapshot: () => queue.map(entry => copy(entry.item)),
  };
}

export interface ReviewTask {
  id: string;
  title: string;
  body: string;
  status: 'open';
  source: 'review-comment';
}

/** 463. Turn a non-empty human review comment into an open agent task. */
export function commentToTaskConverter(comment: string, options: { id?: string; maxLength?: number } = {}): ReviewTask | undefined {
  const body = comment.trim();
  if (!body) return undefined;
  const maxLength = options.maxLength ?? 80;
  if (!Number.isInteger(maxLength) || maxLength < 1) throw new Error('maxLength must be a positive integer');
  const title = body.length > maxLength ? `${body.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…` : body;
  return {
    id: options.id ?? `review-comment-${stableHash(body)}`,
    title,
    body,
    status: 'open',
    source: 'review-comment',
  };
}

function stableHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

export interface RiskInput {
  file: string;
  diff?: string;
  additions?: number;
  deletions?: number;
  description?: string;
}

export interface RiskFlag {
  level: 'low' | 'medium' | 'high';
  score: number;
  requiresReview: boolean;
  reasons: string[];
}

/** 464. Flag high-risk file paths, keywords, and oversized changes for review. */
export function riskBasedReviewFlagger(changes: RiskInput[]): RiskFlag {
  let score = 0;
  const reasons = new Set<string>();
  for (const change of changes) {
    const file = change.file.toLowerCase().replace(/\\/g, '/');
    const content = `${change.diff ?? ''} ${change.description ?? ''}`.toLowerCase();
    if (/(^|\/)(auth|authentication|authorization|security|crypto|payment|payments|billing)(\/|\.|$)/.test(file)) {
      score += 3;
      reasons.add('sensitive module');
    }
    if (/\b(password|secret|token|credential|permission|privilege|payment|charge|refund|delete|drop table)\b/.test(content)) {
      score += 3;
      reasons.add('sensitive operation or data');
    }
    const changed = (change.additions ?? 0) + (change.deletions ?? 0);
    if (changed >= 500) {
      score += 2;
      reasons.add('large change');
    }
  }
  const level = score >= 3 ? 'high' : score > 0 ? 'medium' : 'low';
  return { level, score, requiresReview: score >= 1, reasons: [...reasons].sort() };
}

export interface SignOff {
  reviewId: string;
  reviewer: string;
  decision: 'approved' | 'rejected' | 'requested-changes';
  at?: number | string;
  comment?: string;
}

export interface SignOffStatus {
  approved: string[];
  rejected: string[];
  requestedChanges: string[];
  pending: string[];
}

export interface SignOffTracker {
  record: (signOff: SignOff) => void;
  status: (reviewId: string, requiredReviewers?: string[]) => SignOffStatus;
  history: (reviewId?: string) => SignOff[];
}

/** 465. Record reviewer decisions and compute pending sign-offs per review. */
export function signOffTracker(): SignOffTracker {
  const entries: SignOff[] = [];
  return {
    record(signOff) {
      if (!signOff.reviewId.trim() || !signOff.reviewer.trim()) throw new Error('reviewId and reviewer are required');
      const previous = entries.findIndex(entry => entry.reviewId === signOff.reviewId && entry.reviewer === signOff.reviewer);
      if (previous >= 0) entries.splice(previous, 1);
      entries.push({ ...signOff });
    },
    status(reviewId, requiredReviewers = []) {
      const latest = new Map<string, SignOff>();
      for (const entry of entries) if (entry.reviewId === reviewId) latest.set(entry.reviewer, entry);
      const byDecision = (decision: SignOff['decision']): string[] => [...latest.values()]
        .filter(entry => entry.decision === decision).map(entry => entry.reviewer).sort((a, b) => a.localeCompare(b));
      const known = new Set(latest.keys());
      return {
        approved: byDecision('approved'),
        rejected: byDecision('rejected'),
        requestedChanges: byDecision('requested-changes'),
        pending: [...new Set(requiredReviewers)].filter(reviewer => !known.has(reviewer)).sort((a, b) => a.localeCompare(b)),
      };
    },
    history: reviewId => entries.filter(entry => reviewId === undefined || entry.reviewId === reviewId).map(entry => ({ ...entry })),
  };
}

/** 466. Create a deterministic round-robin reviewer assignment cursor. */
export function reviewerAssignmentRotator(reviewers: string[]): { next: () => string | undefined; reset: () => void } {
  const unique = [...new Set(reviewers.map(name => name.trim()).filter(Boolean))];
  let index = 0;
  return {
    next() {
      if (!unique.length) return undefined;
      const reviewer = unique[index % unique.length];
      index++;
      return reviewer;
    },
    reset() { index = 0; },
  };
}

export interface ReviewSLATimerInput {
  createdAt: number;
  now: number;
  slaMs: number;
}
export interface ReviewSLATimerResult {
  elapsedMs: number;
  remainingMs: number;
  breached: boolean;
  dueAt: number;
}

/** 467. Calculate elapsed time and SLA breach state from explicitly supplied times. */
export function reviewSLATimer(input: ReviewSLATimerInput): ReviewSLATimerResult {
  if (![input.createdAt, input.now, input.slaMs].every(Number.isFinite) || input.slaMs < 0) throw new Error('timestamps must be finite and SLA must be non-negative');
  const elapsedMs = Math.max(0, input.now - input.createdAt);
  const dueAt = input.createdAt + input.slaMs;
  return { elapsedMs, remainingMs: Math.max(0, dueAt - input.now), breached: input.now > dueAt, dueAt };
}

export interface DiffAnnotation {
  file: string;
  diff: string;
  annotation: string;
  author?: string;
}

/** 468. Attach explanatory context to a diff without changing its contents. */
export function diffAnnotator(file: string, diff: string, annotation: string, author?: string): DiffAnnotation {
  if (!file.trim()) throw new Error('file is required');
  if (!annotation.trim()) throw new Error('annotation is required');
  return { file, diff, annotation: annotation.trim(), ...(author ? { author } : {}) };
}

export interface FeedbackComment {
  comment: string;
  category?: string;
}
export interface FeedbackPattern {
  pattern: string;
  count: number;
  examples: string[];
}

/** 469. Aggregate common feedback themes into sorted counts and examples. */
export function feedbackPatternCollector(comments: FeedbackComment[]): FeedbackPattern[] {
  const matchers: Array<[string, RegExp]> = [
    ['security', /security|auth|permission|credential|secret/],
    ['testing', /test|coverage|assertion|spec/],
    ['correctness', /bug|incorrect|edge case|null|undefined|error|logic/],
    ['documentation', /doc|readme|comment|explain/],
    ['style', /format|style|naming|lint|readab/],
  ];
  const groups = new Map<string, FeedbackPattern>();
  for (const item of comments) {
    const text = item.comment.trim();
    if (!text) continue;
    const category = item.category?.trim().toLowerCase() || matchers.find(([, pattern]) => pattern.test(text.toLowerCase()))?.[0] || 'other';
    const group = groups.get(category) ?? { pattern: category, count: 0, examples: [] };
    group.count++;
    if (group.examples.length < 3) group.examples.push(text);
    groups.set(category, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));
}

/** 470. Export review history as stable, human-readable JSON. */
export function approvalHistoryExporter(history: unknown[]): string {
  return JSON.stringify(history, null, 2);
}

export interface EscalationOptions {
  reviewId: string;
  elapsedMs: number;
  timeoutMs: number;
  escalate?: (reviewId: string) => void | Promise<void>;
}
export interface EscalationResult {
  escalated: boolean;
  reason?: string;
}

/** 471. Invoke an escalation callback only when the explicit timeout is exceeded. */
export async function escalationOnNoResponse(options: EscalationOptions): Promise<EscalationResult> {
  if (!Number.isFinite(options.elapsedMs) || !Number.isFinite(options.timeoutMs) || options.elapsedMs < 0 || options.timeoutMs < 0) {
    throw new Error('elapsedMs and timeoutMs must be finite non-negative numbers');
  }
  if (options.elapsedMs <= options.timeoutMs) return { escalated: false };
  if (!options.escalate) return { escalated: false, reason: 'escalation callback not provided' };
  await options.escalate(options.reviewId);
  return { escalated: true };
}

/** 472. Generate a default checklist with optional file-specific checklist entries. */
export function reviewChecklistGenerator(changes: Array<{ file: string; risk?: string }> = []): string[] {
  const checklist = [
    'Review correctness and edge cases',
    'Check tests and verification evidence',
    'Review security-sensitive changes',
    'Confirm scope and documentation',
  ];
  for (const change of [...changes].sort((a, b) => a.file.localeCompare(b.file))) {
    checklist.push(`Inspect diff for ${change.file}`);
  }
  return checklist;
}

export interface ChangeImpact {
  filesChanged: number;
  additions: number;
  deletions: number;
  modules: string[];
  summary: string;
}

/** 473. Summarize the scope of a set of file-level changes. */
export function changeImpactSummarizer(changes: DiffFile[]): ChangeImpact {
  const files = new Set(changes.map(change => change.file));
  const additions = changes.reduce((sum, change) => sum + Math.max(0, change.additions ?? countDiff(change.diff).additions), 0);
  const deletions = changes.reduce((sum, change) => sum + Math.max(0, change.deletions ?? countDiff(change.diff).deletions), 0);
  const modules = [...new Set(changes.map(change => moduleForFile(change.file)))].sort((a, b) => a.localeCompare(b));
  const fileNoun = files.size === 1 ? 'file' : 'files';
  const moduleNoun = modules.length === 1 ? 'module' : 'modules';
  return {
    filesChanged: files.size,
    additions,
    deletions,
    modules,
    summary: `${files.size} ${fileNoun} changed across ${modules.length} ${moduleNoun}; +${additions} / -${deletions} lines.`,
  };
}

export type RejectReasonCategory = 'security' | 'correctness' | 'testing' | 'scope' | 'documentation' | 'style' | 'other';

/** 474. Categorize a human rejection comment using conservative keyword groups. */
export function rejectReasonCategorizer(reason: string): RejectReasonCategory {
  const text = reason.toLowerCase();
  const categories: Array<[RejectReasonCategory, RegExp]> = [
    ['security', /security|vulnerab|auth|permission|secret|credential/],
    ['correctness', /bug|incorrect|wrong|crash|edge case|logic|null|undefined/],
    ['testing', /test|coverage|assertion|spec/],
    ['scope', /scope|out of scope|unrelated|too broad/],
    ['documentation', /doc|readme|comment|explain/],
    ['style', /style|format|lint|naming|readab/],
  ];
  return categories.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other';
}

export interface PartialApprovalResult {
  approved: string[];
  pending: string[];
  rejected: string[];
}

/** 475. Partition a submitted file batch into approved, pending, and rejected subsets. */
export function partialApprovalHandler(
  files: string[],
  approved: string[],
  rejected: string[] = [],
): PartialApprovalResult {
  const batch = new Set(files);
  if (batch.size !== files.length) throw new Error('files must not contain duplicates');
  const approvedSet = new Set(approved);
  const rejectedSet = new Set(rejected);
  for (const file of [...approvedSet, ...rejectedSet]) if (!batch.has(file)) throw new Error(`unknown file decision: ${file}`);
  for (const file of approvedSet) if (rejectedSet.has(file)) throw new Error(`file cannot be both approved and rejected: ${file}`);
  return {
    approved: files.filter(file => approvedSet.has(file)),
    pending: files.filter(file => !approvedSet.has(file) && !rejectedSet.has(file)),
    rejected: files.filter(file => rejectedSet.has(file)),
  };
}

export interface ReviewerLoad {
  id: string;
  load: number;
}

/** 476. Assign to the least-loaded reviewers, ties resolved lexically. */
export function reviewerWorkloadBalancer<T extends ReviewerLoad>(reviewers: T[], count = 1): Array<{ reviewer: string; load: number }> {
  if (!Number.isInteger(count) || count < 0) throw new Error('count must be a non-negative integer');
  return [...reviewers]
    .filter(reviewer => Number.isFinite(reviewer.load) && reviewer.load >= 0)
    .sort((a, b) => a.load - b.load || a.id.localeCompare(b.id))
    .slice(0, count)
    .map(reviewer => ({ reviewer: reviewer.id, load: reviewer.load }));
}

/** 477. Notify only critical content and only through an injected callback. */
export async function notifyOnCriticalChange(
  change: string | RiskInput | RiskInput[],
  notify?: (message: string) => void | Promise<void>,
): Promise<boolean> {
  const inputs: RiskInput[] = typeof change === 'string'
    ? [{ file: '', description: change }]
    : Array.isArray(change) ? change : [change];
  const critical = riskBasedReviewFlagger(inputs).level === 'high';
  if (!critical || !notify) return false;
  const message = typeof change === 'string' ? change : `Critical review required for ${inputs.map(item => item.file).join(', ')}`;
  await notify(message);
  return true;
}

export interface HumanOverride {
  actor: string;
  action: string;
  reason: string;
  at?: number | string;
  reviewId?: string;
}

/** 478. Validate and return an auditable human override entry. */
export function humanOverrideLogger(override: HumanOverride): HumanOverride {
  if (!override.actor.trim()) throw new Error('override actor is required');
  if (!override.action.trim()) throw new Error('override action is required');
  if (!override.reason.trim()) throw new Error('override reason is required');
  return { ...override };
}

export interface ConsentEntry {
  subject: string;
  actor: string;
  consent: boolean;
  at?: number | string;
  purpose?: string;
}

export interface ConsentAuditTrail {
  record: (entry: ConsentEntry) => void;
  entries: (subject?: string) => ConsentEntry[];
}

/** 479. Keep an immutable in-memory record of explicit consent decisions. */
export function consentAuditTrail(initial: ConsentEntry[] = []): ConsentAuditTrail {
  const entries = initial.map(entry => ({ ...entry }));
  return {
    record(entry) {
      if (!entry.subject.trim() || !entry.actor.trim()) throw new Error('consent subject and actor are required');
      entries.push({ ...entry });
    },
    entries(subject) {
      return entries.filter(entry => subject === undefined || entry.subject === subject).map(entry => ({ ...entry }));
    },
  };
}

export interface ReviewRecord {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'changes-requested';
}
export interface ReviewDashboard {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  changesRequested: number;
}

/** 480. Aggregate review statuses into a compact dashboard count object. */
export function reviewDashboardAggregator(reviews: ReviewRecord[]): ReviewDashboard {
  const dashboard: ReviewDashboard = { total: reviews.length, pending: 0, approved: 0, rejected: 0, changesRequested: 0 };
  for (const review of reviews) {
    if (review.status === 'changes-requested') dashboard.changesRequested++;
    else dashboard[review.status]++;
  }
  return dashboard;
}
