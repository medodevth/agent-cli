import {
  assertionMessageFormatter,
  benchmarkRunner,
  codeToTestMapper,
  coverageReportParser,
  e2eTestOrchestrator,
  flakyTestDetector,
  generateTestFromFunction,
  mockDependencyGenerator,
  mutationTestRunner,
  parallelTestRunner,
  regressionTestSelector,
  runSingleTest,
  runTestSuite,
  snapshotTestUpdater,
  testCoverageGateEnforcer,
  testDataFixtureLoader,
  testDiffComparator,
  testEnvironmentIsolator,
  testResultToPlanFeedback,
  testTimeoutHandler,
} from '../../src/utils/TestingUtilities.js';

describe('runSingleTest', () => {
  it('delegates the requested test to an explicit executor', async () => {
    const test = { id: 'unit:sum', title: 'adds values' };
    const result = await runSingleTest(test, {
      executeTest: async received => ({ id: received.id, status: 'passed', durationMs: 2 }),
    });
    expect(result).toMatchObject({ id: 'unit:sum', status: 'passed', durationMs: 2 });
  });

  it('returns an explicit unsupported result when no runner is injected', async () => {
    expect(await runSingleTest({ id: 'no-runner' })).toMatchObject({
      id: 'no-runner', status: 'unsupported', error: expect.stringContaining('adapter'),
    });
  });

  it('aborts a test after its configured timeout', async () => {
    const result = await runSingleTest({ id: 'slow' }, {
      timeoutMs: 5,
      executeTest: (_test, context) => new Promise(resolve => {
        context?.signal?.addEventListener('abort', () => resolve({ id: 'slow', status: 'passed' }));
      }),
    });
    expect(result.status).toBe('timed-out');
  });
});

describe('generateTestFromFunction', () => {
  it('turns an explicit example into a runnable assertion-backed test case', () => {
    const generated = generateTestFromFunction('sum', { source: 'return a + b', examples: [{ input: [2, 3], expected: 5 }] });
    expect(generated.id).toBe('generated:sum:1');
    expect(generated.assertions).toEqual([{ input: [2, 3], expected: 5 }]);
    expect(generated.executable).toBe(false);
  });
});

describe('runTestSuite', () => {
  it('runs every test through the injected executor and summarizes results', async () => {
    const report = await runTestSuite([{ id: 'a' }, { id: 'b' }], {
      executeTest: async test => ({ id: test.id, status: test.id === 'a' ? 'passed' : 'failed' }),
    });
    expect(report.results.map(result => result.status)).toEqual(['passed', 'failed']);
    expect(report.summary).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0, unsupported: 0 });
  });
});

describe('mockDependencyGenerator', () => {
  it('creates fresh deterministic stubs from a dependency contract', () => {
    const factory = mockDependencyGenerator({ clock: { now: { type: 'function', defaultValue: 0 } } });
    const first = factory.create();
    (first.clock.now as () => number)();
    const second = factory.create();
    expect((second.clock.now as () => number)()).toBe(0);
    expect(first).not.toBe(second);
  });
});

describe('coverageReportParser', () => {
  it('normalizes Istanbul file summaries and total percentages', () => {
    const report = coverageReportParser({
      'src/a.ts': { s: { 1: 1, 2: 0 }, statementMap: {}, f: {}, functionMap: {}, b: {}, branchMap: {} },
      total: { statements: { total: 2, covered: 1, skipped: 0, pct: 50 }, branches: { total: 0, covered: 0, skipped: 0, pct: 100 }, functions: { total: 0, covered: 0, skipped: 0, pct: 100 }, lines: { total: 2, covered: 1, skipped: 0, pct: 50 } },
    });
    expect(report.files).toEqual(['src/a.ts']);
    expect(report.totals.statements).toMatchObject({ total: 2, covered: 1, percent: 50 });
  });
});

describe('flakyTestDetector', () => {
  it('flags unstable histories by pass-rate threshold', () => {
    expect(flakyTestDetector({ 'suite/test': ['passed', 'failed', 'passed'] }, 0.8)).toEqual(['suite/test']);
  });
});

describe('testDiffComparator', () => {
  it('identifies added, removed and changed test outcomes', () => {
    expect(testDiffComparator([{ id: 'same', status: 'passed' }, { id: 'gone', status: 'passed' }], [
      { id: 'same', status: 'failed' }, { id: 'new', status: 'passed' },
    ])).toEqual({ added: ['new'], removed: ['gone'], changed: [{ id: 'same', before: 'passed', after: 'failed' }] });
  });
});

describe('snapshotTestUpdater', () => {
  it('plans missing and changed snapshots, but requires a write adapter to apply', async () => {
    const updates = await snapshotTestUpdater({ 'old.snap': 'before' }, { 'old.snap': 'after', 'new.snap': 'new' });
    expect(updates.planned).toEqual([{ path: 'new.snap', content: 'new', action: 'create' }, { path: 'old.snap', content: 'after', action: 'update' }]);
    expect(updates.applied).toBe(false);
    expect((await snapshotTestUpdater({}, {}, { writeSnapshot: async () => undefined })).applied).toBe(true);
  });
});

describe('testTimeoutHandler', () => {
  it('races a test promise against a timeout and reports duration', async () => {
    expect(await testTimeoutHandler(Promise.resolve(42), 50)).toMatchObject({ timedOut: false, result: 42 });
    expect(await testTimeoutHandler(new Promise(() => undefined), 2)).toMatchObject({ timedOut: true });
  });
});

describe('parallelTestRunner', () => {
  it('runs tests with bounded concurrency while preserving input order', async () => {
    let active = 0;
    let peak = 0;
    const results = await parallelTestRunner([{ id: 'a' }, { id: 'b' }, { id: 'c' }], {
      concurrency: 2,
      executeTest: async test => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 1));
        active--;
        return { id: test.id, status: 'passed' };
      },
    });
    expect(peak).toBe(2);
    expect(results.map(result => result.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('regressionTestSelector', () => {
  it('matches changed files to the smallest relevant test set', () => {
    expect(regressionTestSelector(['src/a.ts'], { 'src/a.ts': ['a.test.ts'], 'src/b.ts': ['b.test.ts'] })).toEqual(['a.test.ts']);
  });
});

describe('mutationTestRunner', () => {
  it('marks mutations killed by a failing execution and requires an adapter', async () => {
    const result = await mutationTestRunner(['mut-1', 'mut-2'], {
      executeMutation: async id => ({ id, status: id === 'mut-1' ? 'failed' : 'passed' }),
    });
    expect(result.killed).toEqual(['mut-1']);
    expect(result.survived).toEqual(['mut-2']);
    expect((await mutationTestRunner(['mut-1'])).unsupported).toBe(true);
  });
});

describe('testDataFixtureLoader', () => {
  it('loads fixtures only via the injected reader', async () => {
    const fixture = await testDataFixtureLoader('fixtures/user.json', { readFixture: async () => '{"id":3}' });
    expect(fixture).toEqual({ id: 3 });
    const missing = await testDataFixtureLoader('missing');
    expect((missing as { error: string }).error).toContain('adapter');
  });
});

describe('assertionMessageFormatter', () => {
  it('formats stable assertion diagnostics including expected and actual values', () => {
    expect(assertionMessageFormatter({ message: 'mismatch', expected: { a: 1 }, actual: { a: 2 }, path: 'user.a' })).toContain('at user.a');
    expect(assertionMessageFormatter({ message: 'mismatch', expected: 1, actual: 2 })).toContain('expected: 1');
  });
});

describe('testEnvironmentIsolator', () => {
  it('merges isolated env values without mutating the process environment', async () => {
    const result = await testEnvironmentIsolator({ TOKEN: 'base' }, { TOKEN: 'local', MODE: 'test' }, async env => env);
    expect(result).toEqual({ TOKEN: 'local', MODE: 'test' });
    expect(process.env.MODE).toBeUndefined();
  });
});

describe('e2eTestOrchestrator', () => {
  it('runs setup, steps and teardown through injected hooks in order', async () => {
    const events: string[] = [];
    const result = await e2eTestOrchestrator({
      setup: async () => { events.push('setup'); return 7; },
      steps: [async context => { events.push(`step:${context}`); return 'ok'; }],
      teardown: async context => { events.push(`teardown:${context}`); },
    });
    expect(events).toEqual(['setup', 'step:7', 'teardown:7']);
    expect(result.results).toEqual(['ok']);
  });
});

describe('testResultToPlanFeedback', () => {
  it('turns failing tests into actionable feedback and retains passing tests', () => {
    expect(testResultToPlanFeedback([{ id: 'bad', status: 'failed', error: 'assertion' }, { id: 'ok', status: 'passed' }])).toEqual({ needsRevision: true, passed: ['ok'], failures: [{ testId: 'bad', reason: 'assertion' }] });
  });
});

describe('codeToTestMapper', () => {
  it('maps matching test suffixes and exposes unmapped source files', () => {
    expect(codeToTestMapper(['src/math.ts', 'src/other.ts'], ['src/math.test.ts'])).toEqual({ mappings: { 'src/math.ts': ['src/math.test.ts'], 'src/other.ts': [] }, unmapped: ['src/other.ts'] });
  });
});

describe('testCoverageGateEnforcer', () => {
  it('compares every requested coverage metric with its threshold', () => {
    expect(testCoverageGateEnforcer({ lines: 80, branches: 60 }, { lines: 75, branches: 70 })).toEqual({ passed: false, failures: [{ metric: 'branches', actual: 60, required: 70 }] });
  });
});

describe('benchmarkRunner', () => {
  it('measures repeated calls and reports average/min/max', () => {
    let calls = 0;
    const report = benchmarkRunner(() => ++calls, { iterations: 3 });
    expect(calls).toBe(3);
    expect(report.iterations).toBe(3);
    expect(report.averageMs).toBeGreaterThanOrEqual(0);
    expect(report.minMs).toBeLessThanOrEqual(report.maxMs);
  });
});
