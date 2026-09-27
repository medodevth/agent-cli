/** Dependency-free structured logging, telemetry, metrics, and log helpers. */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogEntry = Record<string, unknown> & {
  timestamp: string | number | Date;
  level: LogLevel;
  message: string;
  traceId?: string;
  spanId?: string;
};
export type LogSink = (line: string) => void | Promise<void>;

export interface LogSinkError {
  error: unknown;
  line: string;
}

function reportSinkError(error: unknown, line: string, onSinkError?: (failure: LogSinkError) => void): void {
  onSinkError?.({ error, line });
}

const LEVEL_VALUE: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /password|passwd|secret|token|api[-_]?key|authorization|credential|private[-_]?key/i;
const SECRET_VALUE = /\b(?:Bearer\s+)?(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[bap]-?[A-Za-z0-9-]{8,})\b/gi;

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && LOG_LEVELS.includes(value as LogLevel);
}

function toIso(value: Date | number | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid log timestamp');
  return date.toISOString();
}

function redactValue(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[REDACTED]').replace(/(api[-_]?key|secret|token|password|passwd|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  if (Array.isArray(value)) return value.map(item => redactValue(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, redactValue(childValue, childKey)]));
  }
  return value;
}

function normalizeEntry(entry: Record<string, unknown>, clock: () => Date | number | string): LogEntry {
  const level = isLogLevel(entry.level) ? entry.level : 'info';
  const message = typeof entry.message === 'string' ? entry.message : String(entry.message ?? '');
  const timestamp = entry.timestamp === undefined ? toIso(clock()) : entry.timestamp;
  return { ...entry, timestamp, level, message } as LogEntry;
}

/** 181. Create a structured JSON logger with in-memory snapshots and an injected sink. */
export function structuredLogger(options: {
  level?: LogLevel;
  sink?: LogSink;
  clock?: () => Date | number | string;
  fields?: Record<string, unknown>;
  onSinkError?: (failure: LogSinkError) => void;
} = {}): Record<LogLevel, (message: string, fields?: Record<string, unknown>) => void> & { records: () => LogEntry[] } {
  const threshold = options.level ?? 'debug';
  const clock = options.clock ?? (() => new Date());
  const records: LogEntry[] = [];
  const logger = {} as Record<LogLevel, (message: string, fields?: Record<string, unknown>) => void> & { records: () => LogEntry[] };
  for (const level of LOG_LEVELS) {
    logger[level] = (message, fields = {}) => {
      if (LEVEL_VALUE[level] < LEVEL_VALUE[threshold]) return;
      const entry = normalizeEntry({ ...options.fields, ...fields, level, message }, clock);
      records.push(entry);
      const line = JSON.stringify(entry);
      try {
        const result = options.sink?.(line);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          void (result as Promise<void>).catch(error => reportSinkError(error, line, options.onSinkError));
        }
      } catch (error) {
        reportSinkError(error, line, options.onSinkError);
      }
    };
  }
  logger.records = () => records.map(entry => ({ ...entry }));
  return logger;
}

/** 182. Keep only log entries at or above the selected severity. */
export function logLevelFilter<T extends { level: LogLevel }>(entries: readonly T[], minimum: LogLevel): T[] {
  const cutoff = LEVEL_VALUE[minimum];
  return entries.filter(entry => LEVEL_VALUE[entry.level] >= cutoff);
}

/** 183. Redact credential-like fields and values before passing records to a sink. */
export function redactedLogWriter(sink: (record: Record<string, unknown>) => void | Promise<void>, replacement = '[REDACTED]', onSinkError?: (failure: LogSinkError) => void): (record: Record<string, unknown>) => void {
  return record => {
    const redact = (value: unknown, key = ''): unknown => {
      if (SECRET_KEY.test(key)) return replacement;
      if (typeof value === 'string') return value.replace(SECRET_VALUE, replacement).replace(/(api[-_]?key|secret|token|password|passwd|authorization)\s*[:=]\s*[^\s,;]+/gi, `$1=${replacement}`);
      if (Array.isArray(value)) return value.map(item => redact(item));
      if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
      return value;
    };
    const safeRecord = redact(record) as Record<string, unknown>;
    try {
      const result = sink(safeRecord);
      if (result && typeof (result as Promise<void>).catch === 'function') void (result as Promise<void>).catch(error => onSinkError?.({ error, line: JSON.stringify(safeRecord) }));
    } catch (error) {
      onSinkError?.({ error, line: JSON.stringify(safeRecord) });
    }
  };
}

export interface LogFileInfo { name: string; size: number; modifiedAt: number; }
export interface LogRotationPlan { shouldRotate: boolean; prune: string[]; retained: string[]; }

/** 184. Plan size-based log rotation without performing file operations. */
export function logRotation(files: readonly LogFileInfo[], options: { maxBytes: number; maxFiles: number; incomingBytes?: number }): LogRotationPlan {
  if (!Number.isFinite(options.maxBytes) || options.maxBytes < 0 || !Number.isInteger(options.maxFiles) || options.maxFiles < 0) throw new Error('maxBytes and maxFiles must be non-negative');
  const ordered = [...files].sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name));
  const incomingBytes = options.incomingBytes ?? 0;
  const shouldRotate = files.reduce((total, file) => total + file.size, 0) + incomingBytes > options.maxBytes;
  const keepCount = shouldRotate ? Math.max(0, options.maxFiles) : files.length;
  const retained = ordered.slice(0, keepCount).map(file => file.name);
  const prune = shouldRotate ? ordered.slice(keepCount).map(file => file.name) : [];
  return { shouldRotate, prune, retained };
}

/** 185. Add trace/span IDs immutably, leaving existing IDs intact unless overridden. */
export function traceIdInjector<T extends Record<string, unknown>>(record: T, traceId: string, spanId?: string, overwrite = false): T & { traceId: string; spanId?: string } {
  const result: Record<string, unknown> = { ...record };
  if (overwrite || typeof result.traceId !== 'string') result.traceId = traceId;
  if (spanId !== undefined && (overwrite || typeof result.spanId !== 'string')) result.spanId = spanId;
  return result as T & { traceId: string; spanId?: string };
}

/** 186. Measure sync or async operation time using a deterministic clock. */
export function spanTimer<T>(operation: () => T | Promise<T>, options: { clock?: () => number; onComplete?: (span: { durationMs: number; succeeded: boolean }) => void } = {}): Promise<{ result: T; durationMs: number }> {
  return (async () => {
    const clock = options.clock ?? Date.now;
    const start = clock();
    try {
      const result = await operation();
      const durationMs = Math.max(0, clock() - start);
      options.onComplete?.({ durationMs, succeeded: true });
      return { result, durationMs };
    } catch (error) {
      const durationMs = Math.max(0, clock() - start);
      options.onComplete?.({ durationMs, succeeded: false });
      throw error;
    }
  })();
}

/** 187. In-memory monotonic metric counter. */
export function metricCounter(initialValue = 0): { increment: (amount?: number) => number; add: (amount: number) => number; value: () => number; reset: () => number } {
  if (!Number.isFinite(initialValue)) throw new Error('Initial counter value must be finite');
  let current = initialValue;
  const add = (amount: number): number => {
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Counter increment must be a non-negative finite number');
    current += amount;
    return current;
  };
  return { increment: (amount = 1) => add(amount), add, value: () => current, reset: () => (current = 0) };
}

/** 188. Record metric observations and cumulative histogram buckets. */
export function metricHistogram(bounds: readonly number[] = []): {
  observe: (value: number) => void;
  snapshot: () => { count: number; sum: number; min: number | null; max: number | null; buckets: Array<{ upperBound: number; count: number }> };
} {
  if (bounds.some(value => !Number.isFinite(value)) || [...bounds].some((value, index, list) => index > 0 && value <= list[index - 1])) throw new Error('Histogram bounds must be finite and strictly increasing');
  const values: number[] = [];
  return {
    observe(value) {
      if (!Number.isFinite(value)) throw new Error('Histogram observations must be finite');
      values.push(value);
    },
    snapshot() {
      return {
        count: values.length,
        sum: values.reduce((sum, value) => sum + value, 0),
        min: values.length ? Math.min(...values) : null,
        max: values.length ? Math.max(...values) : null,
        buckets: [...bounds.map(upperBound => ({ upperBound, count: values.filter(value => value <= upperBound).length })), { upperBound: Infinity, count: values.length }],
      };
    },
  };
}

/** 189. Format an Error (or arbitrary thrown value) as a redacted bounded stack. */
export function errorStackFormatter(error: unknown, options: { maxFrames?: number; redact?: boolean } = {}): string {
  const maxFrames = options.maxFrames ?? 20;
  if (!Number.isInteger(maxFrames) || maxFrames < 0) throw new Error('maxFrames must be a non-negative integer');
  const raw = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  const lines = raw.split(/\r?\n/);
  const frames = lines.slice(1).filter(line => /^\s*at\s/.test(line)).slice(0, maxFrames);
  let output = [lines[0], ...frames].join('\n');
  if (options.redact !== false) output = output.replace(SECRET_VALUE, '[REDACTED]').replace(/(api[-_]?key|secret|token|password|passwd|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  return output;
}

/** 190. Append JSON log records using only the injected file-writing adapter. */
export function logToFile(filePath: string, append: (filePath: string, line: string) => void | Promise<void>, clock: () => Date | number | string = () => new Date()): (record: Record<string, unknown>) => Promise<void> {
  if (!filePath) throw new Error('filePath is required');
  return async record => { await append(filePath, JSON.stringify(normalizeEntry(record, clock))); };
}

/** 190. Emit JSON log records using only the injected console-like writer. */
export function logToConsole(write: LogSink, clock: () => Date | number | string = () => new Date()): (record: Record<string, unknown>) => Promise<void> {
  return async record => { await write(JSON.stringify(normalizeEntry(record, clock))); };
}

export interface OtelLogRecord { timeUnixNano: string; severityNumber: number; severityText: string; body: { stringValue: string }; attributes: Array<{ key: string; value: { stringValue: string | boolean | number } }>; traceId?: string; spanId?: string; }

/** 191. Buffer OpenTelemetry-shaped records and send them only on explicit flush. */
export function openTelemetryExporter(transport: (batch: OtelLogRecord[]) => void | Promise<void>, options: { maxBatchSize?: number; clock?: () => number } = {}): { export: (entry: LogEntry) => void; flush: () => Promise<number>; pending: () => number } {
  const maxBatchSize = options.maxBatchSize ?? Infinity;
  if (!(maxBatchSize > 0)) throw new Error('maxBatchSize must be positive');
  const pending: OtelLogRecord[] = [];
  const clock = options.clock ?? Date.now;
  return {
    export(entry) {
      const attributes = Object.entries(entry).filter(([key, value]) => !['timestamp', 'level', 'message', 'traceId', 'spanId'].includes(key) && ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) => ({ key, value: { stringValue: value as string | number | boolean } }));
      pending.push({
        timeUnixNano: String(Math.trunc(new Date(entry.timestamp).getTime() * 1_000_000 || clock() * 1_000_000)),
        severityNumber: LEVEL_VALUE[entry.level],
        severityText: entry.level.toUpperCase(),
        body: { stringValue: entry.message },
        attributes,
        ...(entry.traceId ? { traceId: entry.traceId } : {}),
        ...(entry.spanId ? { spanId: entry.spanId } : {}),
      });
    },
    async flush() {
      let sent = 0;
      while (pending.length) {
        const batch = pending.splice(0, maxBatchSize);
        try {
          await transport(batch);
          sent += batch.length;
        } catch (error) {
          pending.unshift(...batch);
          throw error;
        }
      }
      return sent;
    },
    pending: () => pending.length,
  };
}

/** 192. Keep a bounded in-memory event replay, returning defensive copies. */
export function sessionReplayRecorder<T extends Record<string, unknown> = Record<string, unknown>>(options: { maxEvents?: number } = {}): { record: (event: T) => void; snapshot: () => T[]; clear: () => void } {
  const maxEvents = options.maxEvents ?? 1000;
  if (!Number.isInteger(maxEvents) || maxEvents < 0) throw new Error('maxEvents must be a non-negative integer');
  const events: T[] = [];
  return {
    record(event) { if (maxEvents === 0) return; events.push(structuredClone(event)); if (events.length > maxEvents) events.splice(0, events.length - maxEvents); },
    snapshot: () => structuredClone(events),
    clear: () => { events.length = 0; },
  };
}

/** 193. Fixed-window admission limiter, with a caller-supplied clock. */
export function logSamplingRateLimiter(options: { maxPerWindow: number; windowMs: number; clock?: () => number }): { allow: () => boolean; reset: () => void; remaining: () => number } {
  if (!Number.isInteger(options.maxPerWindow) || options.maxPerWindow < 0 || !Number.isFinite(options.windowMs) || options.windowMs <= 0) throw new Error('maxPerWindow and windowMs must be non-negative/positive');
  const clock = options.clock ?? Date.now;
  let windowStart = clock();
  let used = 0;
  const refresh = (): void => { const now = clock(); if (now < windowStart || now - windowStart >= options.windowMs) { windowStart = now; used = 0; } };
  return {
    allow() { refresh(); if (used >= options.maxPerWindow) return false; used += 1; return true; },
    reset() { windowStart = clock(); used = 0; },
    remaining() { refresh(); return Math.max(0, options.maxPerWindow - used); },
  };
}

export type FlaggedLog<T> = T & { anomalous: boolean; reasons: string[] };
/** 194. Flag errors and message-frequency spikes in a finite log batch. */
export function anomalyLogFlagger<T extends { level: LogLevel; message: string }>(entries: readonly T[], options: { repeatedMessageThreshold?: number } = {}): Array<FlaggedLog<T>> {
  const threshold = options.repeatedMessageThreshold ?? 3;
  if (!Number.isInteger(threshold) || threshold < 1) throw new Error('repeatedMessageThreshold must be a positive integer');
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.message, (counts.get(entry.message) ?? 0) + 1);
  return entries.map(entry => {
    const reasons: string[] = [];
    if (entry.level === 'error') reasons.push('error-level');
    if ((counts.get(entry.message) ?? 0) >= threshold) reasons.push('repeated-message');
    return { ...entry, anomalous: reasons.length > 0, reasons };
  });
}

/** 195. Filter log records by level, text, trace, and most-recent-result cap. */
export function logQueryHelper<T extends { level: LogLevel; message: string; timestamp?: string | number | Date; traceId?: string }>(entries: readonly T[], query: { minLevel?: LogLevel; contains?: string; traceId?: string; limit?: number } = {}): T[] {
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 0)) throw new Error('limit must be a non-negative integer');
  const filtered = entries.filter(entry => (!query.minLevel || LEVEL_VALUE[entry.level] >= LEVEL_VALUE[query.minLevel]) && (query.contains === undefined || entry.message.toLowerCase().includes(query.contains.toLowerCase())) && (query.traceId === undefined || entry.traceId === query.traceId));
  if (query.limit === undefined) return filtered;
  return query.limit === 0 ? [] : filtered.slice(-query.limit);
}

/** 196. Split records into expired and retained sets without deleting source data. */
export function logRetentionCleaner<T extends { timestamp: string | number | Date }>(entries: readonly T[], options: { retentionMs: number; now?: () => number }): { expired: T[]; retained: T[] } {
  if (!Number.isFinite(options.retentionMs) || options.retentionMs < 0) throw new Error('retentionMs must be non-negative');
  const cutoff = (options.now ?? Date.now)() - options.retentionMs;
  const expired: T[] = [];
  const retained: T[] = [];
  for (const entry of entries) {
    const timestamp = new Date(entry.timestamp).getTime();
    if (!Number.isFinite(timestamp)) throw new Error(`Invalid log timestamp: ${String(entry.timestamp)}`);
    (timestamp < cutoff ? expired : retained).push(entry);
  }
  return { expired, retained };
}

/** 197. Count recent errors and invoke an injected alert only at threshold. */
export function alertOnErrorThreshold<T extends { level: LogLevel; timestamp: string | number | Date }>(entries: readonly T[], options: { threshold: number; windowMs: number; now?: () => number; onAlert?: (alert: { errorCount: number; threshold: number; windowMs: number }) => void }): { triggered: boolean; errorCount: number; threshold: number } {
  if (!Number.isInteger(options.threshold) || options.threshold < 1 || !Number.isFinite(options.windowMs) || options.windowMs < 0) throw new Error('threshold must be positive and windowMs non-negative');
  const now = (options.now ?? Date.now)();
  const count = entries.filter(entry => entry.level === 'error' && now - new Date(entry.timestamp).getTime() >= 0 && now - new Date(entry.timestamp).getTime() <= options.windowMs).length;
  const triggered = count >= options.threshold;
  if (triggered) options.onAlert?.({ errorCount: count, threshold: options.threshold, windowMs: options.windowMs });
  return { triggered, errorCount: count, threshold: options.threshold };
}

/** 198. Group log records by trace ID for cross-plugin correlation. */
export function logCorrelationMapper<T extends { traceId?: string }>(entries: readonly T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const entry of entries) {
    if (!entry.traceId) continue;
    const group = result.get(entry.traceId) ?? [];
    group.push(entry);
    result.set(entry.traceId, group);
  }
  return result;
}

/** 199. Stateful debug switch with toggle, explicit set, and query operations. */
export function debugModeToggle(initial = false): { enabled: () => boolean; toggle: (next?: boolean) => boolean } {
  let current = initial;
  return { enabled: () => current, toggle: (next?: boolean) => { current = next ?? !current; return current; } };
}

/** 200. Produce a portable JSON support export with credentials redacted. */
export function logExportForSupport<T extends Record<string, unknown>>(entries: readonly T[], options: { clock?: () => Date | number | string; appVersion?: string; redact?: (value: unknown) => unknown } = {}): string {
  const clock = options.clock ?? (() => new Date());
  const redact = options.redact ?? ((value: unknown) => redactValue(value));
  return JSON.stringify({ generatedAt: toIso(clock()), ...(options.appVersion ? { appVersion: options.appVersion } : {}), logs: entries.map(entry => redact(entry)) });
}
