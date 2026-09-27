import { jest } from '@jest/globals';
import {
  autoRecoveryAttempt,
  circuitBreaker,
  criticalErrorAlerter,
  errorAggregator,
  errorBoundaryWrapper,
  errorClassifier,
  errorContextEnricher,
  errorRateMonitor,
  errorReportGenerator,
  errorReplayForDebug,
  errorSeverityClassifier,
  fallbackProviderSwitcher,
  gracefulDegradation,

  partialFailureRecovery,
  poisonMessageQuarantine,
  retryWithExponentialBackoff,
  stackTraceSourceMapper,
  timeoutErrorHandler,
  userFriendlyErrorMessage,
  validationErrorCollector,
} from '../../src/utils/ErrorHandlingUtilities.js';

class FakeClock {
  time = 0;
  sleeps: number[] = [];
  now = (): number => this.time;
  sleep = async (ms: number): Promise<void> => { this.sleeps.push(ms); this.time += ms; };
}

describe('ErrorHandlingUtilities — retry and recovery', () => {
  it('retries transient operations with capped exponential delays', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const value = await retryWithExponentialBackoff(async () => {
      if (++calls < 3) throw new Error('temporary failure');
      return 'ok';
    }, { maxAttempts: 4, baseDelayMs: 5, maxDelayMs: 12, jitter: 0, sleep: clock.sleep, random: () => 0.5 });
    expect(value).toBe('ok');
    expect(calls).toBe(3);
    expect(clock.sleeps).toEqual([5, 10]);
  });

  it('opens a circuit after the failure threshold and allows recovery after cooldown', async () => {
    const clock = new FakeClock();
    const breaker = circuitBreaker({ failureThreshold: 2, cooldownMs: 10, now: clock.now });
    await expect(breaker.execute(async () => { throw new Error('broken'); })).rejects.toThrow('broken');
    await expect(breaker.execute(async () => { throw new Error('broken'); })).rejects.toThrow('broken');
    await expect(breaker.execute(async () => 'not called')).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    clock.time = 10;
    await expect(breaker.execute(async () => 'recovered')).resolves.toBe('recovered');
    expect(breaker.getState().state).toBe('closed');
  });

  it('classifies timeout and validation failures without assuming every error is transient', () => {
    expect(errorClassifier(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }))).toMatchObject({ kind: 'transient', retryable: true });
    expect(errorClassifier(Object.assign(new Error('invalid input'), { status: 400 }))).toMatchObject({ kind: 'permanent', retryable: false });
    expect(errorClassifier(new Error('request timed out'))).toMatchObject({ kind: 'timeout' });
  });

  it('switches providers after a failure and keeps trying in declared order', async () => {
    const attempted: string[] = [];
    const result = await fallbackProviderSwitcher([
      { name: 'primary', run: async () => { attempted.push('primary'); throw new Error('offline'); } },
      { name: 'secondary', run: async () => { attempted.push('secondary'); return 'served'; } },
    ]);
    expect(result).toMatchObject({ provider: 'secondary', value: 'served' });
    expect(attempted).toEqual(['primary', 'secondary']);
  });

  it('adds structured context without replacing the original error', () => {
    const original = new TypeError('bad state');
    const enriched = errorContextEnricher(original, { taskId: 'job-7', phase: 'commit' });
    expect(enriched).toBe(original);
    expect((enriched as TypeError & { context?: object }).context).toEqual({ taskId: 'job-7', phase: 'commit' });
  });

  it('degrades to a supplied fallback when the primary action fails', async () => {
    await expect(gracefulDegradation(async () => { throw new Error('offline'); }, async error => `cached:${(error as Error).message}`)).resolves.toBe('cached:offline');
  });

  it('returns a caller-provided fallback from an error boundary', async () => {
    await expect(errorBoundaryWrapper(async () => { throw new Error('oops'); }, error => `handled:${(error as Error).message}`)).resolves.toBe('handled:oops');
  });

  it('turns an expired deadline into a timeout error and clears the timer', async () => {
    jest.useFakeTimers();
    try {
      const pending = timeoutErrorHandler(new Promise<string>(() => {}), 25, 'provider call');
      const assertion = expect(pending).rejects.toMatchObject({ code: 'ETIMEDOUT', operation: 'provider call' });
      jest.advanceTimersByTime(25);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('recovers failed items while retaining successful partial results', async () => {
    const result = await partialFailureRecovery([1, 2, 3], async item => {
      if (item === 2) throw new Error('temporary');
      return item * 2;
    }, async item => item * 20);
    expect(result).toEqual({ results: [2, 40, 6], recovered: [1], failures: [] });
  });

  it('aggregates errors with their step names and preserves the original errors', () => {
    const first = new Error('a');
    const second = new Error('b');
    const combined = errorAggregator([{ step: 'read', error: first }, { step: 'write', error: second }]);
    expect(combined.errors).toEqual([{ step: 'read', error: first }, { step: 'write', error: second }]);
    expect(combined.message).toContain('2');
  });

  it('maps common failures to safe user-facing messages', () => {
    expect(userFriendlyErrorMessage(Object.assign(new Error('secret details'), { code: 'ETIMEDOUT' }))).toMatch(/timed out/i);
    expect(userFriendlyErrorMessage(new Error('invalid JSON payload'))).toMatch(/input|format/i);
    expect(userFriendlyErrorMessage(new Error('database password=secret'))).not.toContain('secret');
  });

  it('generates a serializable error report without leaking attached secrets', () => {
    const report = errorReportGenerator(Object.assign(new Error('failed token=abc123'), { context: { taskId: 't-1', apiKey: 'xyz' } }));
    expect(JSON.stringify(report)).not.toContain('abc123');
    expect(JSON.stringify(report)).not.toContain('xyz');
    expect(report).toMatchObject({ name: 'Error', context: { taskId: 't-1' } });
  });

  it('repeats a recovery action only up to its configured limit', async () => {
    let attempts = 0;
    const result = await autoRecoveryAttempt(async () => { attempts++; if (attempts === 1) throw new Error('transient'); return attempts; }, { maxAttempts: 3, shouldRetry: () => attempts < 2 });
    expect(result).toEqual({ value: 2, attempts: 2, recovered: true });
  });

  it('tracks error rates over a sliding time window using an injected clock', () => {
    const clock = new FakeClock();
    const monitor = errorRateMonitor({ windowMs: 10, now: clock.now });
    monitor.record(); monitor.record();
    clock.time = 10;
    monitor.record();
    expect(monitor.getRate()).toBe(100);
  });

  it('quarantines a poison message after repeated failures', () => {
    const quarantine = poisonMessageQuarantine({ maxFailures: 2 });
    expect(quarantine.recordFailure('m-1')).toBe(false);
    expect(quarantine.recordFailure('m-1')).toBe(true);
    expect(quarantine.get('m-1')).toMatchObject({ id: 'm-1', failures: 2 });
  });

  it('replays a captured failure with its original serialized input', async () => {
    const replay = errorReplayForDebug<{ a: number }>();
    replay.capture({ id: 'r-1', input: { a: 1 }, error: new Error('boom') });
    await expect(replay.replay('r-1', async input => input.a + 1)).resolves.toBe(2);
  });


  it('collects multiple validation issues before reporting them', () => {
    const collector = validationErrorCollector();
    collector.add('name', 'required').add('age', 'must be positive');
    expect(collector.getErrors()).toEqual([{ path: 'name', message: 'required' }, { path: 'age', message: 'must be positive' }]);
  });

  it('alerts once per critical error fingerprint and allows a later alert after reset', () => {
    const alerts: Error[] = [];
    const alerter = criticalErrorAlerter(error => { alerts.push(error); });
    const failure = new Error('disk unavailable');
    alerter.alert(failure);
    alerter.alert(failure);
    expect(alerts).toHaveLength(1);
    alerter.reset();
    alerter.alert(failure);
    expect(alerts).toHaveLength(2);
  });

  it('assigns severity based on impact and supports explicit codes', () => {
    expect(errorSeverityClassifier(Object.assign(new Error('fatal'), { severity: 'critical' }))).toBe('critical');
    expect(errorSeverityClassifier(Object.assign(new Error('bad input'), { status: 400 }))).toBe('warning');
    expect(errorSeverityClassifier(new Error('unexpected failure'))).toBe('error');
  });

  it('maps bundled stack frames through an injected source-map resolver', async () => {
    const failure = new Error('boom');
    failure.stack = 'Error: boom\n    at handler (dist/app.js:4:5)';
    const source = await stackTraceSourceMapper(failure, async frame => frame.file === 'dist/app.js' ? { file: 'src/app.ts', line: 12, column: 4 } : undefined);
    expect(source.frames[0]).toMatchObject({ file: 'src/app.ts', line: 12, column: 4 });
  });
});
