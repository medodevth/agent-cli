/**
 * Testing utilities (functions 281–300).
 *
 * Execution, file access and mutation are deliberately adapter-injected. The
 * helpers do not spawn test runners, change process state, or write snapshots.
 */

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'timed-out' | 'unsupported';

export interface TestCase {
  id: string;
  [key: string]: unknown;
}

export interface TestResult {
  id: string;
  status: TestStatus;
  durationMs?: number;
  error?: string;
  details?: unknown;
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  unsupported: number;
}

export type TestExecutor = (
  test: TestCase,
  context?: { signal?: AbortSignal; environment?: Record<string, string> },
) => TestResult | Promise<TestResult>;

export interface RunSingleTestOptions {
  executeTest?: TestExecutor;
  timeoutMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 282. Execute exactly one test through an explicitly supplied adapter. */
export async function runSingleTest(
  test: TestCase,
  options: RunSingleTestOptions = {},
): Promise<TestResult> {
  if (!options.executeTest) {
    return { id: test.id, status: 'unsupported', error: 'Test execution requires an executeTest adapter' };
  }
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const execution = Promise.resolve().then(() => options.executeTest!(test, { signal: controller.signal }));
    if (options.timeoutMs === undefined) {
      const result = await execution;
      return { ...result, id: test.id, durationMs: result.durationMs ?? Date.now() - started };
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      return { id: test.id, status: 'failed', error: 'timeoutMs must be a positive finite number' };
    }
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), options.timeoutMs);
    });
    const result = await Promise.race([execution, timeout]);
    if (result === null) {
      controller.abort();
      return { id: test.id, status: 'timed-out', durationMs: Date.now() - started, error: `Test exceeded ${options.timeoutMs}ms` };
    }
    return { ...result, id: test.id, durationMs: result.durationMs ?? Date.now() - started };
  } catch (error) {
    return { id: test.id, status: 'failed', durationMs: Date.now() - started, error: errorMessage(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 281. Run tests via an adapter and return a stable, explicit summary. */
export async function runTestSuite(
  tests: TestCase[],
  options: RunSingleTestOptions = {},
): Promise<{ results: TestResult[]; summary: TestSummary }> {
  const results = await Promise.all(tests.map(test => runSingleTest(test, options)));
  return { results, summary: summarizeTestResults(results) };
}

function summarizeTestResults(results: TestResult[]): TestSummary {
  return {
    total: results.length,
    passed: results.filter(result => result.status === 'passed').length,
    failed: results.filter(result => result.status === 'failed' || result.status === 'timed-out').length,
    skipped: results.filter(result => result.status === 'skipped').length,
    unsupported: results.filter(result => result.status === 'unsupported').length,
  };
}

export interface FunctionExample {
  input: unknown[];
  expected: unknown;
  description?: string;
}

/** 283. Convert provided examples to a declarative, non-executable test spec. */
export function generateTestFromFunction(
  functionName: string,
  specification: { source?: string; examples: FunctionExample[] },
): TestCase & { assertions: FunctionExample[]; executable: false } {
  if (!functionName.trim()) throw new Error('functionName must not be empty');
  if (!Array.isArray(specification.examples)) throw new Error('examples must be an array');
  return {
    id: `generated:${functionName}:${specification.examples.length}`,
    name: functionName,
    source: specification.source,
    assertions: specification.examples.map(example => ({ ...example, input: [...example.input] })),
    executable: false,
  };
}

export interface MockMethodContract {
  type?: 'function' | 'value';
  defaultValue?: unknown;
  implementation?: (...args: unknown[]) => unknown;
}

/** 284. Build a fresh set of controlled, dependency-free stubs per create(). */
export function mockDependencyGenerator(
  contract: Record<string, Record<string, MockMethodContract>>,
): { create: () => Record<string, Record<string, unknown>> } {
  return {
    create: () => Object.fromEntries(Object.entries(contract).map(([dependency, methods]) => [
      dependency,
      Object.fromEntries(Object.entries(methods).map(([name, method]) => [
        name,
        method.type === 'value'
          ? method.defaultValue
          : (...args: unknown[]) => method.implementation ? method.implementation(...args) : method.defaultValue,
      ])),
    ])),
  };
}

export interface CoverageMetric {
  total: number;
  covered: number;
  percent: number;
}

export interface CoverageReport {
  files: string[];
  totals: Record<string, CoverageMetric>;
}

/** 285. Normalize an Istanbul coverage-summary style object. */
export function coverageReportParser(input: unknown): CoverageReport {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Coverage report must be an object');
  const report = input as Record<string, unknown>;
  const rawTotals = report.total && typeof report.total === 'object' ? report.total as Record<string, unknown> : {};
  const totals: Record<string, CoverageMetric> = {};
  for (const metric of ['statements', 'branches', 'functions', 'lines']) {
    const raw = rawTotals[metric];
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const total = Number(entry.total);
    const covered = Number(entry.covered);
    const percent = Number(entry.pct);
    if (![total, covered].every(Number.isFinite) || total < 0 || covered < 0 || covered > total) {
      throw new Error(`Invalid coverage metric: ${metric}`);
    }
    totals[metric] = { total, covered, percent: Number.isFinite(percent) ? percent : (total === 0 ? 100 : covered / total * 100) };
  }
  return { files: Object.keys(report).filter(key => key !== 'total').sort(), totals };
}

/** 286. Mark tests whose observed pass ratio falls below the configurable threshold. */
export function flakyTestDetector(
  history: Record<string, Array<TestStatus | boolean>>,
  minPassRate = 0.9,
): string[] {
  if (!Number.isFinite(minPassRate) || minPassRate < 0 || minPassRate > 1) throw new Error('minPassRate must be between 0 and 1');
  return Object.entries(history).filter(([, outcomes]) => outcomes.length > 1 &&
    outcomes.filter(outcome => outcome === true || outcome === 'passed').length / outcomes.length < minPassRate)
    .map(([id]) => id).sort();
}

/** 287. Compare a baseline with a new result set by stable test id. */
export function testDiffComparator(
  before: TestResult[], after: TestResult[],
): { added: string[]; removed: string[]; changed: Array<{ id: string; before: TestStatus; after: TestStatus }> } {
  const oldById = new Map(before.map(result => [result.id, result.status]));
  const newById = new Map(after.map(result => [result.id, result.status]));
  return {
    added: [...newById.keys()].filter(id => !oldById.has(id)).sort(),
    removed: [...oldById.keys()].filter(id => !newById.has(id)).sort(),
    changed: [...oldById].filter(([id, status]) => newById.has(id) && newById.get(id) !== status)
      .map(([id, status]) => ({ id, before: status, after: newById.get(id)! })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export interface SnapshotUpdate {
  path: string;
  content: string;
  action: 'create' | 'update';
}

/** 288. Plan snapshot writes; apply only through an explicitly supplied writer. */
export async function snapshotTestUpdater(
  current: Record<string, string>,
  proposed: Record<string, string>,
  options: { writeSnapshot?: (path: string, content: string) => Promise<void> } = {},
): Promise<{ planned: SnapshotUpdate[]; applied: boolean; unsupported?: string }> {
  const planned = Object.entries(proposed).filter(([file, content]) => current[file] !== content)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, content]) => ({ path: file, content, action: current[file] === undefined ? 'create' as const : 'update' as const }));
  if (!options.writeSnapshot) return { planned, applied: false, unsupported: 'Applying snapshot updates requires a writeSnapshot adapter' };
  for (const update of planned) await options.writeSnapshot(update.path, update.content);
  return { planned, applied: true };
}

/** 289. Bound a promise and report whether it completed before the deadline. */
export async function testTimeoutHandler<T>(
  operation: Promise<T>, timeoutMs: number,
): Promise<{ timedOut: boolean; result?: T; durationMs: number }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive finite number');
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
    const result = await Promise.race([operation, timeout]);
    return result === null ? { timedOut: true, durationMs: Date.now() - start } : { timedOut: false, result, durationMs: Date.now() - start };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 290. Execute tests concurrently up to a caller-selected limit. */
export async function parallelTestRunner(
  tests: TestCase[],
  options: RunSingleTestOptions & { concurrency?: number } = {},
): Promise<TestResult[]> {
  const concurrency = options.concurrency ?? (tests.length || 1);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');
  const results = new Array<TestResult>(tests.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tests.length) }, async () => {
    while (next < tests.length) {
      const index = next++;
      results[index] = await runSingleTest(tests[index], options);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 291. Select tests mapped directly to changed source paths. */
export function regressionTestSelector(
  changedFiles: string[],
  sourceToTests: Record<string, string[]>,
): string[] {
  return [...new Set(changedFiles.flatMap(file => sourceToTests[file] ?? []))].sort();
}

/** 292. Run mutation cases with an injected executor; never create mutations itself. */
export async function mutationTestRunner(
  mutations: string[],
  options: { executeMutation?: (mutationId: string) => Promise<TestResult> | TestResult } = {},
): Promise<{ killed: string[]; survived: string[]; errors: Array<{ id: string; error: string }>; unsupported?: boolean }> {
  if (!options.executeMutation) return { killed: [], survived: [], errors: [], unsupported: true };
  const results = await Promise.all(mutations.map(async id => {
    try { return await options.executeMutation!(id); }
    catch (error) { return { id, error: errorMessage(error) }; }
  }));
  return {
    killed: results.filter(result => 'status' in result && result.status === 'failed').map(result => result.id).sort(),
    survived: results.filter(result => 'status' in result && result.status === 'passed').map(result => result.id).sort(),
    errors: results.filter(result => 'error' in result).map(result => ({ id: result.id, error: result.error! })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** 293. Load and parse fixture data through an injected reader, never disk directly. */
export async function testDataFixtureLoader(
  fixturePath: string,
  options: { readFixture?: (path: string) => Promise<string | unknown> | string | unknown } = {},
): Promise<unknown> {
  if (!options.readFixture) return { error: 'Fixture loading requires a readFixture adapter' };
  try {
    const value = await options.readFixture(fixturePath);
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
  } catch (error) { return { error: errorMessage(error), path: fixturePath }; }
}

/** 294. Produce a compact, deterministic assertion diagnostic. */
export function assertionMessageFormatter(input: {
  message: string;
  expected?: unknown;
  actual?: unknown;
  path?: string;
}): string {
  const lines = [input.path ? `${input.message} at ${input.path}` : input.message];
  if ('expected' in input) lines.push(`expected: ${formatValue(input.expected)}`);
  if ('actual' in input) lines.push(`actual:   ${formatValue(input.actual)}`);
  return lines.join('\n');
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

/** 295. Run a callback with a merged env object without touching process.env. */
export async function testEnvironmentIsolator<T>(
  base: Record<string, string>, overrides: Record<string, string>,
  execute: (environment: Record<string, string>) => Promise<T> | T,
): Promise<T> {
  return execute({ ...base, ...overrides });
}

/** 296. Coordinate e2e lifecycle hooks and always call teardown after setup. */
export async function e2eTestOrchestrator<TContext, TResult>(options: {
  setup: () => Promise<TContext> | TContext;
  steps: Array<(context: TContext) => Promise<TResult> | TResult>;
  teardown: (context: TContext) => Promise<void> | void;
}): Promise<{ results: TResult[]; error?: string }> {
  let context: TContext | undefined;
  let setupCompleted = false;
  const results: TResult[] = [];
  let error: string | undefined;
  try {
    context = await options.setup();
    setupCompleted = true;
    for (const step of options.steps) results.push(await step(context));
  } catch (caught) { error = errorMessage(caught); }
  finally {
    if (setupCompleted) {
      try { await options.teardown(context as TContext); }
      catch (caught) { error = error ? `${error}; teardown: ${errorMessage(caught)}` : `teardown: ${errorMessage(caught)}`; }
    }
  }
  return { results, ...(error === undefined ? {} : { error }) };
}

/** 297. Convert results into a concise plan feedback payload. */
export function testResultToPlanFeedback(results: TestResult[]): {
  needsRevision: boolean; passed: string[]; failures: Array<{ testId: string; reason: string }>;
} {
  const failed = results.filter(result => result.status === 'failed' || result.status === 'timed-out');
  return {
    needsRevision: failed.length > 0,
    passed: results.filter(result => result.status === 'passed').map(result => result.id),
    failures: failed.map(result => ({ testId: result.id, reason: result.error ?? `Test status: ${result.status}` })),
  };
}

/** 298. Match source files to common adjacent test naming conventions. */
export function codeToTestMapper(
  sourceFiles: string[], testFiles: string[],
): { mappings: Record<string, string[]>; unmapped: string[] } {
  const available = [...testFiles].sort();
  const mappings: Record<string, string[]> = {};
  for (const source of sourceFiles) {
    const base = source.replace(/\.[^.]+$/, '');
    const candidates = new Set([`${base}.test.`, `${base}.spec.`, `${base}Test.`]);
    mappings[source] = available.filter(test => [...candidates].some(prefix => test.startsWith(prefix)));
  }
  return { mappings, unmapped: sourceFiles.filter(source => mappings[source].length === 0) };
}

/** 299. Enforce minimum coverage numbers by metric. */
export function testCoverageGateEnforcer(
  actual: Record<string, number>, required: Record<string, number>,
): { passed: boolean; failures: Array<{ metric: string; actual: number | null; required: number }> } {
  const failures = Object.entries(required).filter(([metric, threshold]) =>
    !Number.isFinite(threshold) || threshold < 0 || threshold > 100 || !Number.isFinite(actual[metric]) || actual[metric] < threshold)
    .map(([metric, threshold]) => ({ metric, actual: Number.isFinite(actual[metric]) ? actual[metric] : null, required: threshold }))
    .sort((a, b) => a.metric.localeCompare(b.metric));
  return { passed: failures.length === 0, failures };
}

/** 300. Synchronously benchmark an in-process callback using high-resolution time. */
export function benchmarkRunner<T>(
  operation: () => T,
  options: { iterations?: number } = {},
): { iterations: number; averageMs: number; minMs: number; maxMs: number; lastResult: T } {
  const iterations = options.iterations ?? 10;
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error('iterations must be a positive integer');
  const durations: number[] = [];
  let lastResult!: T;
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    lastResult = operation();
    durations.push(performance.now() - start);
  }
  return {
    iterations,
    averageMs: durations.reduce((sum, duration) => sum + duration, 0) / iterations,
    minMs: Math.min(...durations),
    maxMs: Math.max(...durations),
    lastResult,
  };
}
