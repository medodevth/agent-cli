import {
  approvalQueueManager,
  approvalHistoryExporter,
  batchDiffGrouper,
  changeImpactSummarizer,
  commentToTaskConverter,
  consentAuditTrail,
  diffAnnotator,
  escalationOnNoResponse,
  feedbackPatternCollector,
  humanOverrideLogger,
  notifyOnCriticalChange,
  partialApprovalHandler,
  rejectReasonCategorizer,
  reviewChecklistGenerator,
  reviewDashboardAggregator,
  reviewSLATimer,
  reviewerAssignmentRotator,
  reviewerWorkloadBalancer,
  riskBasedReviewFlagger,
  signOffTracker,
} from '../../src/utils/ReviewUtilities.js';

describe('ReviewUtilities review workflows', () => {
  it('groups changed files by module and reports a concrete review impact', () => {
    const groups = batchDiffGrouper([
      { file: 'src/auth/login.ts', diff: '+checkToken' },
      { file: 'src/auth/session.ts', diff: '-unsafe' },
      { file: 'README.md', diff: '+usage' },
    ]);
    expect(groups.map(group => group.module)).toEqual(['README.md', 'src/auth']);
    expect(groups[1].files).toEqual(['src/auth/login.ts', 'src/auth/session.ts']);

    const impact = changeImpactSummarizer([
      { file: 'src/auth/login.ts', diff: '', additions: 4, deletions: 1 },
      { file: 'src/auth/session.ts', diff: '', additions: 2, deletions: 3 },
    ]);
    expect(impact).toMatchObject({ filesChanged: 2, additions: 6, deletions: 4 });
    expect(impact.summary).toMatch(/2 files/);
  });

  it('manages approval queue without mutating submitted entries', () => {
    const queue = approvalQueueManager();
    queue.enqueue({ id: 'r1', priority: 1 });
    queue.enqueue({ id: 'r2', priority: 4 });
    expect(queue.peek()?.id).toBe('r2');
    expect(queue.dequeue()?.id).toBe('r2');
    expect(queue.size).toBe(1);
    expect(queue.dequeue()?.id).toBe('r1');
    expect(queue.dequeue()).toBeUndefined();
  });

  it('turns actionable human comments into a trackable task', () => {
    expect(commentToTaskConverter('Please add a null check before saving.')).toMatchObject({
      title: 'Please add a null check before saving.',
      status: 'open',
      source: 'review-comment',
    });
    expect(commentToTaskConverter('  ')).toBeUndefined();
  });

  it('flags sensitive paths and high-impact changes for stricter review', () => {
    expect(riskBasedReviewFlagger([{ file: 'src/auth/login.ts', diff: '+password' }])).toMatchObject({
      level: 'high',
      requiresReview: true,
    });
    expect(riskBasedReviewFlagger([{ file: 'src/readme.md', diff: '+typo' }]).level).toBe('low');
  });

  it('tracks independent sign-offs and rotates reviewers fairly', () => {
    const signoffs = signOffTracker();
    signoffs.record({ reviewId: 'r1', reviewer: 'Ada', decision: 'approved', at: 10 });
    signoffs.record({ reviewId: 'r1', reviewer: 'Lin', decision: 'requested-changes', at: 11 });
    expect(signoffs.status('r1')).toMatchObject({ approved: ['Ada'], pending: [], requestedChanges: ['Lin'] });
    expect(signoffs.status('missing').approved).toEqual([]);

    const rotation = reviewerAssignmentRotator(['Ada', 'Lin']);
    expect(rotation.next()).toBe('Ada');
    expect(rotation.next()).toBe('Lin');
    expect(rotation.next()).toBe('Ada');
  });

  it('measures SLA deadlines and categorizes common rejection reasons', () => {
    expect(reviewSLATimer({ createdAt: 1000, now: 2500, slaMs: 2000 })).toMatchObject({
      elapsedMs: 1500,
      remainingMs: 500,
      breached: false,
    });
    expect(reviewSLATimer({ createdAt: 1000, now: 4000, slaMs: 2000 }).breached).toBe(true);
    expect(rejectReasonCategorizer('This introduces a security vulnerability')).toBe('security');
    expect(rejectReasonCategorizer('Please add unit tests')).toBe('testing');
    expect(rejectReasonCategorizer('Needs a clearer explanation')).toBe('other');
  });

  it('annotates diffs, collects feedback patterns, and exports history as JSON', () => {
    expect(diffAnnotator('src/auth.ts', '+check', 'Authentication boundary')).toMatchObject({
      file: 'src/auth.ts',
      diff: '+check',
      annotation: 'Authentication boundary',
    });
    const feedback = feedbackPatternCollector([
      { comment: 'Please add tests for this edge case' },
      { comment: 'Missing tests here' },
      { comment: 'Looks good' },
    ]);
    expect(feedback[0]).toMatchObject({ pattern: 'testing', count: 2 });
    expect(JSON.parse(approvalHistoryExporter([{ id: 'r1', decision: 'approved' }]))).toEqual([
      { id: 'r1', decision: 'approved' },
    ]);
  });

  it('escalates overdue work through injected callback only', async () => {
    const escalations: string[] = [];
    const result = await escalationOnNoResponse({
      reviewId: 'r1',
      elapsedMs: 20,
      timeoutMs: 10,
      escalate: async id => { escalations.push(id); },
    });
    expect(result.escalated).toBe(true);
    expect(escalations).toEqual(['r1']);
    expect((await escalationOnNoResponse({ reviewId: 'r2', elapsedMs: 2, timeoutMs: 10 })).escalated).toBe(false);
  });

  it('builds checklists and handles file-level partial approvals', () => {
    expect(reviewChecklistGenerator([{ file: 'src/auth.ts' }])).toEqual([
      'Review correctness and edge cases',
      'Check tests and verification evidence',
      'Review security-sensitive changes',
      'Confirm scope and documentation',
      'Inspect diff for src/auth.ts',
    ]);
    expect(partialApprovalHandler(['a.ts', 'b.ts'], ['a.ts'])).toEqual({
      approved: ['a.ts'],
      pending: ['b.ts'],
      rejected: [],
    });
  });

  it('balances workload, notifies injected handler for critical changes, and logs overrides', async () => {
    const assignments = reviewerWorkloadBalancer([
      { id: 'a', load: 3 }, { id: 'b', load: 1 }, { id: 'c', load: 0 },
    ], 2);
    expect(assignments).toEqual([{ reviewer: 'c', load: 0 }, { reviewer: 'b', load: 1 }]);

    const notices: string[] = [];
    expect(await notifyOnCriticalChange('secret rotation', async message => { notices.push(message); })).toBe(true);
    expect(notices).toEqual(['secret rotation']);
    expect(await notifyOnCriticalChange('docs typo')).toBe(false);

    expect(humanOverrideLogger({ actor: 'Ada', action: 'force-approve', reason: 'checked manually' })).toMatchObject({
      actor: 'Ada', action: 'force-approve', reason: 'checked manually',
    });
  });

  it('records consent and aggregates dashboard state without discarding pending reviews', () => {
    const trail = consentAuditTrail();
    trail.record({ subject: 'release-1', actor: 'Ada', consent: true, at: 42 });
    expect(trail.entries()).toHaveLength(1);
    expect(trail.entries()[0]).toMatchObject({ subject: 'release-1', actor: 'Ada', consent: true });

    expect(reviewDashboardAggregator([
      { id: 'a', status: 'approved' },
      { id: 'b', status: 'pending' },
      { id: 'c', status: 'rejected' },
      { id: 'd', status: 'pending' },
    ])).toEqual({ total: 4, pending: 2, approved: 1, rejected: 1, changesRequested: 0 });
  });

  it('categorizes no-response escalation, tracks workload, and exports a deterministic summary', () => {
    expect(reviewSLATimer({ createdAt: 0, now: 100, slaMs: 100 }).breached).toBe(false);
    expect(reviewerWorkloadBalancer([{ id: 'a', load: 0 }], 1)).toEqual([{ reviewer: 'a', load: 0 }]);
    expect(approvalHistoryExporter([])).toBe('[]');
    expect(reviewDashboardAggregator([])).toEqual({ total: 0, pending: 0, approved: 0, rejected: 0, changesRequested: 0 });
  });

  it('rejects duplicate reviewer sign-offs and requires a real reason for overrides', () => {
    const tracker = signOffTracker();
    tracker.record({ reviewId: 'r', reviewer: 'Ada', decision: 'approved', at: 1 });
    tracker.record({ reviewId: 'r', reviewer: 'Ada', decision: 'approved', at: 2 });
    expect(tracker.status('r').approved).toEqual(['Ada']);
    expect(() => humanOverrideLogger({ actor: 'Ada', action: 'approve', reason: ' ' })).toThrow(/reason/);
  });

  it('validates partial file decisions against the submitted batch', () => {
    expect(partialApprovalHandler(['a.ts', 'b.ts'], ['a.ts'], ['b.ts'])).toEqual({
      approved: ['a.ts'], pending: [], rejected: ['b.ts'],
    });
    expect(() => partialApprovalHandler(['a.ts'], ['other.ts'])).toThrow(/unknown file/);
  });

  it('groups directory modules and classifies critical-change notifications', async () => {
    expect(batchDiffGrouper([{ file: 'a.ts', diff: '+x' }, { file: 'b.ts', diff: '+y' }]).map(group => group.module)).toEqual(['a.ts', 'b.ts']);
    const notices: string[] = [];
    await notifyOnCriticalChange('payment path changed', async text => { notices.push(text); });
    expect(notices).toEqual(['payment path changed']);
  });
});
