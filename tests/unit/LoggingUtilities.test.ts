import {
  alertOnErrorThreshold,
  anomalyLogFlagger,
  debugModeToggle,
  errorStackFormatter,
  logCorrelationMapper,
  logExportForSupport,
  logLevelFilter,
  logQueryHelper,
  logRetentionCleaner,
  logRotation,
  logSamplingRateLimiter,
  logToConsole,
  logToFile,
  metricCounter,
  metricHistogram,
  openTelemetryExporter,
  redactedLogWriter,
  sessionReplayRecorder,
  spanTimer,
  structuredLogger,
  traceIdInjector,
  type LogEntry,
} from '../../src/utils/LoggingUtilities.js';

const makeEntry = (overrides: Partial<LogEntry> = {}): LogEntry => ({
  timestamp: '2025-01-01T00:00:00.000Z',
  level: 'info',
  message: 'ready',
  ...overrides,
});

describe('LoggingUtilities (500-functions category J)', () => {
  it('emits structured JSON records with an injected clock and level filter', () => {
    const output: string[] = [];
    const logger = structuredLogger({
      level: 'warn',
      clock: () => new Date('2025-01-02T03:04:05.000Z'),
      sink: line => { output.push(line); },
      fields: { service: 'agent' },
    });

    expect(logger.info('hidden')).toBeUndefined();
    logger.error('failed', { requestId: 'r-1' });
    expect(JSON.parse(output[0])).toMatchObject({
      timestamp: '2025-01-02T03:04:05.000Z',
      level: 'error',
      message: 'failed',
      service: 'agent',
      requestId: 'r-1',
    });
    expect(logger.records()).toHaveLength(1);
  });

  it('reports sink failures without losing the in-memory record', async () => {
    const failures: unknown[] = [];
    const logger = structuredLogger({ sink: async () => { throw new Error('sink offline'); }, onSinkError: failure => failures.push(failure) });
    logger.info('kept');
    await new Promise(resolve => setImmediate(resolve));
    expect(logger.records()).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  it('filters entries at or above the requested severity while preserving order', () => {
    const entries = [makeEntry({ level: 'debug' }), makeEntry({ level: 'warn' }), makeEntry({ level: 'error' })];
    expect(logLevelFilter(entries, 'warn').map(item => item.level)).toEqual(['warn', 'error']);
  });

  it('redacts secret fields and credential text before handing logs to a sink', () => {
    const output: Array<Record<string, unknown>> = [];
    const write = redactedLogWriter(record => { output.push(record); });
    write({ message: 'apiKey=sk-12345678901234567890', password: 'hunter2', nested: { authorization: 'Bearer private' } });
    expect(output).toHaveLength(1);
    expect(JSON.stringify(output[0])).not.toContain('hunter2');
    expect(JSON.stringify(output[0])).not.toContain('private');
    expect(JSON.stringify(output[0])).toContain('[REDACTED]');
  });

  it('returns a non-destructive rotation and retention plan', () => {
    const plan = logRotation(
      [
        { name: 'app.1.log', size: 50, modifiedAt: 1 },
        { name: 'app.log', size: 90, modifiedAt: 2 },
      ],
      { maxBytes: 100, maxFiles: 1, incomingBytes: 20 },
    );
    expect(plan).toEqual({ shouldRotate: true, prune: ['app.1.log'], retained: ['app.log'] });
  });

  it('injects trace identifiers without mutating the original record', () => {
    const record = Object.freeze({ message: 'work' });
    expect(traceIdInjector(record, 'trace-1', 'span-2')).toEqual({ message: 'work', traceId: 'trace-1', spanId: 'span-2' });
    expect(record).toEqual({ message: 'work' });
  });

  it('measures asynchronous span duration using the injected clock', async () => {
    let now = 10;
    const completions: unknown[] = [];
    const result = await spanTimer(async () => {
      now = 15;
      return 'done';
    }, { clock: () => now, onComplete: span => completions.push(span) });
    expect(result).toEqual({ result: 'done', durationMs: 5 });
    expect(completions).toEqual([{ durationMs: 5, succeeded: true }]);
  });

  it('counts, increments, adds and resets metric values', () => {
    const counter = metricCounter(2);
    expect(counter.increment()).toBe(3);
    expect(counter.add(4)).toBe(7);
    expect(counter.value()).toBe(7);
    expect(counter.reset()).toBe(0);
  });

  it('records histogram observations in cumulative buckets', () => {
    const histogram = metricHistogram([1, 5]);
    histogram.observe(0.5);
    histogram.observe(2);
    histogram.observe(9);
    expect(histogram.snapshot()).toEqual({
      count: 3,
      sum: 11.5,
      min: 0.5,
      max: 9,
      buckets: [
        { upperBound: 1, count: 1 },
        { upperBound: 5, count: 2 },
        { upperBound: Infinity, count: 3 },
      ],
    });
  });

  it('formats concise, redacted error stacks with a frame limit', () => {
    const error = new Error('failed apiKey=sk-12345678901234567890');
    error.name = 'RequestError';
    error.stack = 'RequestError: failed apiKey=sk-12345678901234567890\n    at run (/app/a.js:1:1)\n    at next (/app/b.js:2:2)';
    const formatted = errorStackFormatter(error, { maxFrames: 1 });
    expect(formatted).toContain('RequestError: failed');
    expect(formatted).toContain('at run');
    expect(formatted).not.toContain('at next');
    expect(formatted).not.toContain('sk-12345678901234567890');
  });

  it('routes file logs only through the explicitly injected append sink', async () => {
    const writes: Array<{ filePath: string; line: string }> = [];
    const write = logToFile('/logs/agent.jsonl', (filePath, line) => { writes.push({ filePath, line }); }, () => new Date('2025-02-03T04:05:06.000Z'));
    await write({ level: 'info', message: 'written' });
    expect(writes[0].filePath).toBe('/logs/agent.jsonl');
    expect(JSON.parse(writes[0].line)).toMatchObject({ level: 'info', message: 'written', timestamp: '2025-02-03T04:05:06.000Z' });
  });

  it('routes console logs only through the explicitly injected writer', async () => {
    const output: string[] = [];
    const write = logToConsole(line => { output.push(line); }, () => new Date('2025-02-03T04:05:06.000Z'));
    await write({ level: 'warn', message: 'visible' });
    expect(JSON.parse(output[0])).toMatchObject({ level: 'warn', message: 'visible', timestamp: '2025-02-03T04:05:06.000Z' });
  });

  it('exports OpenTelemetry-shaped batches only when explicitly flushed', async () => {
    const sent: Array<Array<{ severityText: string; body: { stringValue: string }; traceId?: string }>> = [];
    const exporter = openTelemetryExporter(batch => { sent.push(batch); });
    exporter.export(makeEntry({ level: 'error', message: 'failed', traceId: 'trace-1' }));
    expect(sent).toHaveLength(0);
    expect(await exporter.flush()).toBe(1);
    expect(sent[0][0]).toMatchObject({ severityText: 'ERROR', body: { stringValue: 'failed' }, traceId: 'trace-1' });
    expect(exporter.pending()).toBe(0);
  });

  it('records a bounded replay window and returns defensive snapshots', () => {
    const recorder = sessionReplayRecorder({ maxEvents: 2 });
    recorder.record({ type: 'click', target: 'a' });
    recorder.record({ type: 'input', value: 'b' });
    recorder.record({ type: 'submit' });
    const snapshot = recorder.snapshot();
    expect(snapshot.map(event => event.type)).toEqual(['input', 'submit']);
    snapshot[0].type = 'changed';
    expect(recorder.snapshot()[0].type).toBe('input');
  });

  it('limits logs per fixed window using an injected clock', () => {
    let now = 0;
    const limiter = logSamplingRateLimiter({ maxPerWindow: 2, windowMs: 100, clock: () => now });
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false);
    now = 100;
    expect(limiter.allow()).toBe(true);
  });

  it('flags high severity and repeated-message anomalies', () => {
    const flagged = anomalyLogFlagger(
      [makeEntry({ level: 'info', message: 'same' }), makeEntry({ level: 'warn', message: 'same' }), makeEntry({ level: 'error', message: 'failure' })],
      { repeatedMessageThreshold: 2 },
    );
    expect(flagged.map(item => item.anomalous)).toEqual([true, true, true]);
    expect(flagged[0].reasons).toContain('repeated-message');
    expect(flagged[2].reasons).toContain('error-level');
  });

  it('queries logs by severity, text, trace and result limit', () => {
    const entries = [
      makeEntry({ level: 'debug', message: 'start', traceId: 't1' }),
      makeEntry({ level: 'error', message: 'timeout', traceId: 't1' }),
      makeEntry({ level: 'error', message: 'timeout elsewhere', traceId: 't2' }),
    ];
    expect(logQueryHelper(entries, { minLevel: 'error', contains: 'timeout', traceId: 't1', limit: 1 })).toEqual([entries[1]]);
    expect(logQueryHelper(entries, { limit: 0 })).toEqual([]);
  });

  it('caps a limited query to the most recent matches', () => {
    const entries = [
      makeEntry({ level: 'info', message: 'first' }),
      makeEntry({ level: 'info', message: 'second' }),
      makeEntry({ level: 'info', message: 'third' }),
    ];
    expect(logQueryHelper(entries, { limit: 1 })).toEqual([entries[2]]);
    expect(logQueryHelper(entries, { limit: 2 })).toEqual([entries[1], entries[2]]);
    expect(logQueryHelper(entries, { limit: 9 })).toEqual(entries);
  });

  it('returns expired log records as a cleanup plan without deleting anything', () => {
    const records = [makeEntry({ timestamp: 800 }), makeEntry({ timestamp: 900 }), makeEntry({ timestamp: 950 })];
    const result = logRetentionCleaner(records, { retentionMs: 100, now: () => 1_000 });
    expect(result.expired).toEqual([records[0]]);
    expect(result.retained).toEqual([records[1], records[2]]);
  });

  it('alerts once when recent error count reaches its threshold', () => {
    const records = [
      makeEntry({ level: 'error', timestamp: 500 }),
      makeEntry({ level: 'error', timestamp: 980 }),
      makeEntry({ level: 'error', timestamp: 990 }),
    ];
    const alerts: unknown[] = [];
    const result = alertOnErrorThreshold(records, { threshold: 2, windowMs: 100, now: () => 1_000, onAlert: alert => alerts.push(alert) });
    expect(result).toMatchObject({ triggered: true, errorCount: 2, threshold: 2 });
    expect(alerts).toHaveLength(1);
  });

  it('maps related plugin log records by shared trace identifier', () => {
    const records = [makeEntry({ traceId: 'trace-a', plugin: 'one' }), makeEntry({ traceId: 'trace-a', plugin: 'two' }), makeEntry({ traceId: 'trace-b' })];
    const correlated = logCorrelationMapper(records);
    expect(correlated.get('trace-a')).toEqual(records.slice(0, 2));
    expect(correlated.get('trace-b')).toEqual([records[2]]);
  });

  it('toggles debug mode and supports setting an explicit state', () => {
    const debug = debugModeToggle(false);
    expect(debug.enabled()).toBe(false);
    expect(debug.toggle()).toBe(true);
    expect(debug.toggle(false)).toBe(false);
    expect(debug.enabled()).toBe(false);
  });

  it('exports a deterministic support bundle with secrets redacted', () => {
    const text = logExportForSupport(
      [makeEntry({ message: 'failed password=private-value', apiKey: 'sk-12345678901234567890' })],
      { clock: () => new Date('2025-02-03T04:05:06.000Z'), appVersion: '1.2.3' },
    );
    const bundle = JSON.parse(text);
    expect(bundle.generatedAt).toBe('2025-02-03T04:05:06.000Z');
    expect(bundle.appVersion).toBe('1.2.3');
    expect(JSON.stringify(bundle)).not.toContain('sk-12345678901234567890');
    expect(JSON.stringify(bundle)).not.toContain('private-value');
  });
});
