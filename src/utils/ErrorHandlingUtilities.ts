import { randomUUID } from 'node:crypto';

import { assignOwn } from './SafeObject.js';

export type ErrorKind = 'transient' | 'permanent' | 'timeout' | 'unknown';
export interface ErrorClassification {
  kind: ErrorKind;
  retryable: boolean;
  code?: string | number;
  message: string;
}

function asRecord(error: unknown): Record<string, unknown> | undefined {
  return typeof error === 'object' && error !== null ? error as Record<string, unknown> : undefined;
}

export function errorClassifier(error: unknown): ErrorClassification {
  const record = asRecord(error);
  const message = error instanceof Error ? error.message : String(error);
  const code = record?.code;
  const status = record?.status ?? record?.statusCode;
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /\b(timeout|timed out)\b/i.test(message)) {
    return { kind: 'timeout', retryable: true, code: code as string | number | undefined, message };
  }
  if (
    code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE' || code === 'EAI_AGAIN' ||
    status === 408 || status === 425 || status === 429 ||
    (typeof status === 'number' && status >= 500) ||
    /\b(network|temporar|connection reset|rate.?limit|service unavailable)\b/i.test(message)
  ) {
    return { kind: 'transient', retryable: true, code: code as string | number | undefined, message };
  }
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { kind: 'permanent', retryable: false, code: status, message };
  }
  if (record?.name === 'AbortError') return { kind: 'permanent', retryable: false, message };
  return { kind: 'unknown', retryable: false, code: code as string | number | undefined, message };
}

export interface RetryWithBackoffOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
  onRetry?: (error: unknown, nextAttempt: number, delayMs: number) => void;
}

const abortReason = (signal: AbortSignal): unknown => signal.reason ?? Object.assign(new Error('Operation cancelled'), { name: 'AbortError' });
const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(abortReason(signal)); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = (): void => { clearTimeout(timer); reject(abortReason(signal!)); };
  signal?.addEventListener('abort', onAbort, { once: true });
});
const integerAtLeastOne = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
};

/** Retries an operation with bounded exponential delay and injectable timing/jitter. */
export async function retryWithExponentialBackoff<T>(
  operation: () => T | Promise<T>,
  options: RetryWithBackoffOptions = {}
): Promise<T> {
  const maxAttempts = integerAtLeastOne(options.maxAttempts ?? 3, 'maxAttempts');
  const baseDelayMs = options.baseDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? 0.2;
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0 || !Number.isFinite(maxDelayMs) || maxDelayMs < 0) throw new RangeError('Retry delays must be non-negative finite numbers');
  if (!Number.isFinite(factor) || factor < 1) throw new RangeError('factor must be at least 1');
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new RangeError('jitter must be between 0 and 1');
  const wait = options.sleep ?? sleep;
  const random = options.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    try { return await operation(); }
    catch (error) {
      if (attempt >= maxAttempts || options.shouldRetry?.(error, attempt) === false) throw error;
      const exponential = Math.min(maxDelayMs, baseDelayMs * factor ** (attempt - 1));
      const delay = Math.round(exponential * (1 - jitter + 2 * jitter * random()));
      options.onRetry?.(error, attempt + 1, delay);
      await wait(delay, options.signal);
    }
  }
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  successThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

export interface CircuitOpenError extends Error {
  code: 'CIRCUIT_OPEN';
  retryAt: number;
}

/** A per-instance CLOSED/OPEN/HALF_OPEN circuit breaker with a single probe at a time. */
export function circuitBreaker(options: CircuitBreakerOptions = {}): {
  execute<T>(operation: () => T | Promise<T>): Promise<T>;
  recordFailure(error?: unknown): void;
  recordSuccess(): void;
  reset(): void;
  getState(): { state: 'closed' | 'open' | 'half-open'; failures: number; successes: number; retryAt: number };
} {
  const threshold = integerAtLeastOne(options.failureThreshold ?? 5, 'failureThreshold');
  const successThreshold = integerAtLeastOne(options.successThreshold ?? 1, 'successThreshold');
  const cooldown = options.cooldownMs ?? 30_000;
  if (!Number.isFinite(cooldown) || cooldown < 0) throw new RangeError('cooldownMs must be non-negative and finite');
  const now = options.now ?? Date.now;
  let failures = 0;
  let successes = 0;
  let openedAt: number | undefined;
  let probeInFlight = false;
  const state = (): 'closed' | 'open' | 'half-open' => {
    if (openedAt === undefined) return 'closed';
    if (now() - openedAt < cooldown) return 'open';
    return 'half-open';
  };
  const recordFailure = (): void => {
    failures++;
    successes = 0;
    probeInFlight = false;
    if (failures >= threshold || openedAt !== undefined) openedAt = now();
  };
  const recordSuccess = (): void => {
    if (openedAt === undefined) { failures = 0; return; }
    successes++;
    probeInFlight = false;
    if (successes >= successThreshold) { failures = 0; successes = 0; openedAt = undefined; }
  };
  return {
    async execute<T>(operation: () => T | Promise<T>): Promise<T> {
      const currentState = state();
      if (currentState === 'open') {
        const error = new Error('Circuit breaker is open') as CircuitOpenError;
        error.code = 'CIRCUIT_OPEN';
        error.retryAt = openedAt! + cooldown;
        throw error;
      }
      if (currentState === 'half-open') {
        if (probeInFlight) {
          const error = new Error('Circuit breaker is testing recovery') as CircuitOpenError;
          error.code = 'CIRCUIT_OPEN';
          error.retryAt = now();
          throw error;
        }
        probeInFlight = true;
      }
      try { const result = await operation(); recordSuccess(); return result; }
      catch (error) { recordFailure(); throw error; }
    },
    recordFailure,
    recordSuccess,
    reset() { failures = 0; successes = 0; openedAt = undefined; probeInFlight = false; },
    getState() { return { state: state(), failures, successes, retryAt: openedAt === undefined ? 0 : openedAt + cooldown }; },
  };
}

export interface Provider<T> {
  name: string;
  run: () => T | Promise<T>;
}

/** Calls providers in order and returns the first success, preserving failure diagnostics. */
export async function fallbackProviderSwitcher<T>(providers: readonly Provider<T>[], options: {
  shouldFallback?: (error: unknown, provider: string) => boolean;
  onFallback?: (error: unknown, from: string, to: string) => void;
} = {}): Promise<{ provider: string; value: T }> {
  if (providers.length === 0) throw new Error('At least one provider is required');
  const errors: Array<{ provider: string; error: unknown }> = [];
  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index];
    try { return { provider: provider.name, value: await provider.run() }; }
    catch (error) {
      errors.push({ provider: provider.name, error });
      if (options.shouldFallback?.(error, provider.name) === false || index === providers.length - 1) {
        throw new AggregateError(errors.map(entry => entry.error), `All eligible providers failed: ${errors.map(entry => entry.provider).join(', ')}`, { cause: error });
      }
      options.onFallback?.(error, provider.name, providers[index + 1].name);
    }
  }
  throw new Error('Provider selection failed');
}

export interface ErrorContext {
  [key: string]: unknown;
}

/** Adds structured diagnostic context to extensible errors while preserving their identity. */
export function errorContextEnricher<T>(error: T, context: ErrorContext): T {
  const record = asRecord(error);
  if (!record) throw new TypeError('Only object errors can be enriched');
  const previous = asRecord(record.context) ?? {};
  Object.defineProperty(record, 'context', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: { ...previous, ...context },
  });
  return error;
}

/** Executes a primary operation and uses fallback only when it fails. */
export async function gracefulDegradation<T>(
  primary: () => T | Promise<T>,
  fallback: (error: unknown) => T | Promise<T>,
  options: { onDegraded?: (error: unknown) => void } = {}
): Promise<T> {
  try { return await primary(); }
  catch (error) { options.onDegraded?.(error); return fallback(error); }
}

/** Error boundary for async or synchronous operations; optional recovery may map failures. */
export async function errorBoundaryWrapper<T, R = T>(
  operation: () => T | Promise<T>,
  onError: (error: unknown) => R | Promise<R>
): Promise<T | R> {
  try { return await operation(); }
  catch (error) { return onError(error); }
}

export interface TimeoutError extends Error {
  code: 'ETIMEDOUT';
  operation?: string;
}

/** Rejects a promise at the deadline and clears timer/listeners on all settle paths. */
export function timeoutErrorHandler<T>(
  operation: T | PromiseLike<T>,
  timeoutMs: number,
  label?: string,
  options: { signal?: AbortSignal } = {}
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return Promise.reject(new RangeError('timeoutMs must be non-negative and finite'));
  if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const error = new Error(label ? `Operation '${label}' timed out` : 'Operation timed out') as TimeoutError;
    error.name = 'TimeoutError';
    error.code = 'ETIMEDOUT';
    if (label !== undefined) error.operation = label;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(options.signal ? abortReason(options.signal) : new Error('Aborted')));
    const timer = setTimeout(() => finish(() => reject(error)), timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(value => finish(() => resolve(value)), reason => finish(() => reject(reason)));
  });
}

export interface PartialFailureResult<T, R> {
  results: Array<T | R | undefined>;
  recovered: number[];
  failures: Array<{ index: number; item: T; error: unknown }>;
}

/** Keeps successes, tries recovery per failed item, and returns unresolved failures by index. */
export async function partialFailureRecovery<T, R>(
  items: readonly T[],
  operation: (item: T, index: number) => R | Promise<R>,
  recover: (item: T, error: unknown, index: number) => R | Promise<R>
): Promise<PartialFailureResult<T, R>> {
  const results = new Array<R | undefined>(items.length);
  const recovered: number[] = [];
  const failures: Array<{ index: number; item: T; error: unknown }> = [];
  await Promise.all(items.map(async (item, index) => {
    try { results[index] = await operation(item, index); }
    catch (error) {
      try { results[index] = await recover(item, error, index); recovered.push(index); }
      catch (recoveryError) { failures.push({ index, item, error: new AggregateError([error, recoveryError], 'Primary and recovery operations failed') }); }
    }
  }));
  recovered.sort((a, b) => a - b);
  failures.sort((a, b) => a.index - b.index);
  return { results, recovered, failures };
}

export interface AggregatedErrorEntry {
  step: string;
  error: unknown;
}

/** Preserves named errors, creating a native AggregateError with stable structured entries. */
export function errorAggregator(entries: readonly AggregatedErrorEntry[]): AggregateError & {
  errors: AggregatedErrorEntry[];
  count: number;
} {
  const aggregate = new AggregateError(entries.map(entry => entry.error), `${entries.length} error(s) across ${entries.map(entry => entry.step).join(', ')}`) as AggregateError & { errors: AggregatedErrorEntry[]; count: number };
  Object.defineProperty(aggregate, 'errors', { value: entries.map(entry => ({ ...entry })), enumerable: true });
  Object.defineProperty(aggregate, 'count', { value: entries.length, enumerable: true });
  return aggregate;
}

/** Maps common operational failures to safe concise messages, never echoing raw secrets. */
export function userFriendlyErrorMessage(error: unknown): string {
  const record = asRecord(error);
  const code = record?.code;
  const status = record?.status ?? record?.statusCode;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'ETIMEDOUT' || /\b(timeout|timed out)\b/i.test(message)) return 'The operation timed out. Please try again.';
  if (code === 'CIRCUIT_OPEN') return 'The service is temporarily unavailable. Please try again shortly.';
  if (status === 401 || status === 403 || /\b(unauthorized|forbidden|permission denied)\b/i.test(message)) return 'You do not have permission to complete this action.';
  if (status === 429 || /\b(rate.?limit|too many requests)\b/i.test(message)) return 'The service is receiving too many requests. Please wait and retry.';
  if (/\b(validation|invalid|malformed|json)\b/i.test(message) || status === 400) return 'The provided input is invalid. Check its format and try again.';
  if (/\b(not found|enoent)\b/i.test(message) || status === 404) return 'The requested item could not be found.';
  return 'Something went wrong. Please try again or contact support.';
}

function redactSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return value
    .replace(/\b(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
  if (value instanceof Error) return { name: value.name, message: redactSecrets(value.message, seen), stack: value.stack ? redactSecrets(value.stack, seen) : undefined };
  if (Array.isArray(value)) return value.map(item => redactSecrets(item, seen));
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/api.?key|token|password|secret|credential|authorization/i.test(key)) assignOwn(out, key, '[REDACTED]');
    else assignOwn(out, key, redactSecrets(nested, seen));
  }
  seen.delete(value);
  return out;
}

/** Creates a JSON-safe diagnostic report, dropping likely secret-bearing context keys. */
export function errorReportGenerator(error: unknown, options: { id?: string; includeStack?: boolean } = {}): {
  id: string;
  name: string;
  message: string;
  code?: string | number;
  context?: Record<string, unknown>;
  stack?: string;
} {
  const record = asRecord(error);
  const context = asRecord(record?.context);
  const safeContext = context ? redactSecrets(context) as Record<string, unknown> : undefined;
  const name = error instanceof Error ? error.name : typeof record?.name === 'string' ? record.name : 'Error';
  const rawMessage = error instanceof Error ? error.message : typeof record?.message === 'string' ? record.message : String(error);
  const report: ReturnType<typeof errorReportGenerator> = {
    id: options.id ?? randomUUID(),
    name,
    message: String(redactSecrets(rawMessage)),
  };
  if (typeof record?.code === 'string' || typeof record?.code === 'number') report.code = record.code;
  if (safeContext && Object.keys(safeContext).length > 0) report.context = safeContext;
  if (options.includeStack !== false && error instanceof Error && error.stack) report.stack = String(redactSecrets(error.stack));
  return report;
}

/** Attempts recovery until success, policy stop, or the maximum attempt count. */
export async function autoRecoveryAttempt<T>(
  operation: (attempt: number) => T | Promise<T>,
  options: { maxAttempts?: number; shouldRetry?: (error: unknown, attempt: number) => boolean; onRetry?: (error: unknown, attempt: number) => void } = {}
): Promise<{ value: T; attempts: number; recovered: boolean }> {
  const maxAttempts = integerAtLeastOne(options.maxAttempts ?? 3, 'maxAttempts');
  let attempts = 0;
  let previousError: unknown;
  while (attempts < maxAttempts) {
    attempts++;
    try { return { value: await operation(attempts), attempts, recovered: attempts > 1 }; }
    catch (error) {
      previousError = error;
      if (attempts >= maxAttempts || options.shouldRetry?.(error, attempts) === false) throw error;
      options.onRetry?.(error, attempts + 1);
    }
  }
  throw previousError;
}

export interface ErrorRateMonitorOptions {
  windowMs: number;
  now?: () => number;
}

/** Records timestamps and reports count/rate over a sliding duration window. */
export function errorRateMonitor(options: ErrorRateMonitorOptions): {
  record(at?: number): void;
  getCount(): number;
  getRate(): number;
  getSnapshot(): { count: number; rate: number; windowMs: number };
  reset(): void;
} {
  if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) throw new RangeError('windowMs must be positive and finite');
  const now = options.now ?? Date.now;
  const events: number[] = [];
  const prune = (): void => {
    const threshold = now() - options.windowMs;
    while (events.length > 0 && events[0] <= threshold) events.shift();
  };
  return {
    record(at = now()) {
      if (!Number.isFinite(at)) throw new RangeError('Error timestamp must be finite');
      events.push(at);
      events.sort((a, b) => a - b);
      prune();
    },
    getCount() { prune(); return events.length; },
    getRate() { prune(); return events.length / (options.windowMs / 1000); },
    getSnapshot() { prune(); return { count: events.length, rate: events.length / (options.windowMs / 1000), windowMs: options.windowMs }; },
    reset() { events.length = 0; },
  };
}

export interface QuarantineEntry {
  id: string;
  failures: number;
  firstFailureAt: number;
  lastFailureAt: number;
  message?: string;
  payload?: unknown;
}

/** Quarantines repeatedly failing work and allows inspection and explicit retry/removal. */
export function poisonMessageQuarantine(options: { maxFailures?: number; now?: () => number } = {}): {
  recordFailure(id: string, error?: unknown, payload?: unknown): boolean;
  isQuarantined(id: string): boolean;
  get(id: string): QuarantineEntry | undefined;
  list(): QuarantineEntry[];
  release(id: string): boolean;
  clear(): void;
} {
  const maxFailures = integerAtLeastOne(options.maxFailures ?? 3, 'maxFailures');
  const now = options.now ?? Date.now;
  const failures = new Map<string, QuarantineEntry>();
  const quarantined = new Set<string>();
  return {
    recordFailure(id, error, payload) {
      if (!id) throw new TypeError('Message id is required');
      if (quarantined.has(id)) return true;
      const timestamp = now();
      const current = failures.get(id);
      const entry: QuarantineEntry = {
        id,
        failures: (current?.failures ?? 0) + 1,
        firstFailureAt: current?.firstFailureAt ?? timestamp,
        lastFailureAt: timestamp,
        ...(error !== undefined ? { message: error instanceof Error ? error.message : String(error) } : current?.message ? { message: current.message } : {}),
        ...(payload !== undefined ? { payload } : current?.payload !== undefined ? { payload: current.payload } : {}),
      };
      failures.set(id, entry);
      if (entry.failures >= maxFailures) quarantined.add(id);
      return quarantined.has(id);
    },
    isQuarantined: id => quarantined.has(id),
    get(id) { const entry = failures.get(id); return entry ? { ...entry } : undefined; },
    list() { return [...quarantined].map(id => failures.get(id)!).map(entry => ({ ...entry })); },
    release(id) { const removed = quarantined.delete(id); failures.delete(id); return removed; },
    clear() { failures.clear(); quarantined.clear(); },
  };
}

export interface ReplayEntry<T = unknown> {
  id: string;
  input: T;
  error: unknown;
  capturedAt: number;
}

/** Holds bounded, cloned failing inputs for deterministic local debugging replay. */
export function errorReplayForDebug<T = unknown>(options: { maxEntries?: number; now?: () => number } = {}): {
  capture(entry: { id?: string; input: T; error: unknown }): ReplayEntry<T>;
  get(id: string): ReplayEntry<T> | undefined;
  list(): ReplayEntry<T>[];
  replay<R>(id: string, handler: (input: T, priorError: unknown) => R | Promise<R>): Promise<R>;
  delete(id: string): boolean;
  clear(): void;
} {
  const maxEntries = integerAtLeastOne(options.maxEntries ?? 100, 'maxEntries');
  const now = options.now ?? Date.now;
  const entries = new Map<string, ReplayEntry<T>>();
  const clone = (value: unknown): unknown => {
    try { return structuredClone(value); } catch { return value; }
  };
  return {
    capture(input) {
      const entry: ReplayEntry<T> = { id: input.id ?? randomUUID(), input: clone(input.input) as T, error: input.error, capturedAt: now() };
      if (entries.has(entry.id)) entries.delete(entry.id);
      entries.set(entry.id, entry);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
      return { ...entry, input: clone(entry.input) as T };
    },
    get(id) { const entry = entries.get(id); return entry ? { ...entry, input: clone(entry.input) as T } : undefined; },
    list() { return [...entries.values()].map(entry => ({ ...entry, input: clone(entry.input) as T })); },
    async replay(id, handler) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`No captured error replay exists for '${id}'`);
      return handler(clone(entry.input) as T, entry.error);
    },
    delete: id => entries.delete(id),
    clear: () => entries.clear(),
  };
}

export interface ValidationIssue {
  path: string;
  message: string;
  code?: string;
}

/** Collects multiple validation issues and exports a stable immutable snapshot. */
export function validationErrorCollector(): {
  add(path: string, message: string, code?: string): ReturnType<typeof validationErrorCollector>;
  getErrors(): ValidationIssue[];
  hasErrors(): boolean;
  clear(): void;
  toError(): Error & { issues: ValidationIssue[] };
} {
  const errors: ValidationIssue[] = [];
  const api = {
    add(path: string, message: string, code?: string) {
      if (!message) throw new TypeError('Validation message is required');
      errors.push({ path: path || '$', message, ...(code ? { code } : {}) });
      return api;
    },
    getErrors() { return errors.map(error => ({ ...error })); },
    hasErrors: () => errors.length > 0,
    clear() { errors.length = 0; },
    toError() {
      const err = new Error(`${errors.length} validation error(s): ${errors.map(issue => `${issue.path} ${issue.message}`).join('; ')}`) as Error & { issues: ValidationIssue[] };
      err.name = 'ValidationError';
      err.issues = errors.map(issue => ({ ...issue }));
      return err;
    },
  };
  return api;
}

/** Deduplicates high-severity alerts by fingerprint, with manual lifecycle reset. */
export function criticalErrorAlerter(
  notify: (error: Error, fingerprint: string) => void | Promise<void>,
  options: { fingerprint?: (error: Error) => string } = {}
): {
  alert(error: Error): boolean;
  reset(fingerprint?: string): void;
  readonly alertedCount: number;
} {
  const alerted = new Set<string>();
  const fingerprint = options.fingerprint ?? (error => `${error.name}:${error.message}`);
  return {
    alert(error) {
      if (!(error instanceof Error)) throw new TypeError('Critical alert requires an Error instance');
      const key = fingerprint(error);
      if (alerted.has(key)) return false;
      alerted.add(key);
      try {
        const result = notify(error, key);
        if (result && typeof (result as Promise<void>).then === 'function') {
          void (result as Promise<void>).catch(() => { /* alert dispatch is best-effort; key deduplicates repeated storms */ });
        }
      } catch { /* alert dispatch is best-effort and must not hide the original failure */ }
      return true;
    },
    reset(key) { if (key === undefined) alerted.clear(); else alerted.delete(key); },
    get alertedCount() { return alerted.size; },
  };
}

export type ErrorSeverity = 'critical' | 'error' | 'warning' | 'info';

/** Classifies severity from explicit metadata, HTTP status, and common fatal patterns. */
export function errorSeverityClassifier(error: unknown): ErrorSeverity {
  const record = asRecord(error);
  const explicit = record?.severity;
  if (explicit === 'critical' || explicit === 'error' || explicit === 'warning' || explicit === 'info') return explicit;
  const status = record?.status ?? record?.statusCode;
  if (status === 401 || status === 403 || status === 404 || (typeof status === 'number' && status >= 400 && status < 500)) return 'warning';
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(out of memory|data loss|corrupt|disk full|fatal|unrecoverable)\b/i.test(message)) return 'critical';
  if (/\b(deprecated|fallback|retry|temporary)\b/i.test(message)) return 'info';
  return 'error';
}

export interface StackFrame {
  file: string;
  line: number;
  column: number;
  functionName?: string;
  [key: string]: unknown;
}
export interface MappedStackFrame extends StackFrame {
  generatedFile?: string;
  generatedLine?: number;
  generatedColumn?: number;
}
export interface SourceMappedError {
  name: string;
  message: string;
  frames: MappedStackFrame[];
  unmapped: StackFrame[];
}

function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  const patterns = [
    /^\s*at\s+(.*?)\s+\((.+):(\d+):(\d+)\)\s*$/,
    /^\s*at\s+(.+):(\d+):(\d+)\s*$/,
    /^\s*at\s+(.*?)\s+\((.+):(\d+)\)\s*$/,
    /^\s*at\s+(.+):(\d+)\s*$/,
    /^\s*([^@]+)@(.+):(\d+):(\d+)\s*$/,
    /^\s*@(.+):(\d+):(\d+)\s*$/,
  ];
  for (const row of stack.split('\n').slice(1)) {
    let matched = patterns[0].exec(row);
    if (matched) { frames.push({ functionName: matched[1], file: matched[2], line: Number(matched[3]), column: Number(matched[4]) }); continue; }
    matched = patterns[1].exec(row);
    if (matched) { frames.push({ file: matched[1], line: Number(matched[2]), column: Number(matched[3]) }); continue; }
    matched = patterns[2].exec(row);
    if (matched) { frames.push({ functionName: matched[1], file: matched[2], line: Number(matched[3]), column: 0 }); continue; }
    matched = patterns[3].exec(row);
    if (matched) { frames.push({ file: matched[1], line: Number(matched[2]), column: 0 }); continue; }
    matched = patterns[4].exec(row);
    if (matched) { frames.push({ functionName: matched[1], file: matched[2], line: Number(matched[3]), column: Number(matched[4]) }); continue; }
    matched = patterns[5].exec(row);
    if (matched) frames.push({ file: matched[1], line: Number(matched[2]), column: Number(matched[3]) });
  }
  return frames;
}

/** Parses common JS stack formats and rewrites generated frames via an injected source-map resolver. */
export async function stackTraceSourceMapper(
  error: Error,
  resolve: (frame: StackFrame) => StackFrame | null | undefined | Promise<StackFrame | null | undefined>
): Promise<SourceMappedError> {
  const frames = parseStack(error.stack);
  const mapped: MappedStackFrame[] = [];
  const unmapped: StackFrame[] = [];
  for (const frame of frames) {
    const source = await resolve(frame);
    if (source) mapped.push({ ...source, generatedFile: frame.file, generatedLine: frame.line, generatedColumn: frame.column });
    else { mapped.push({ ...frame }); unmapped.push({ ...frame }); }
  }
  return { name: error.name, message: error.message, frames: mapped, unmapped };
}
