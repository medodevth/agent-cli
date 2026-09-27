import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface ConcurrencyTaskOptions {
  priority?: number;
  signal?: AbortSignal;
}

export interface TaskQueueOptions {
  concurrency?: number;
}

export interface ManagedTaskQueue {
  enqueue<T>(task: () => T | Promise<T>, options?: ConcurrencyTaskOptions): Promise<T>;
  close(options?: { cancelPending?: boolean }): Promise<void>;
  readonly size: number;
  readonly running: number;
  readonly closed: boolean;
}

interface QueuedTask<T> {
  run: () => T | Promise<T>;
  priority: number;
  order: number;
  signal?: AbortSignal;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  abortListener?: () => void;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error('Operation was cancelled'), { name: 'AbortError' });
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return chosen;
}

/** A bounded FIFO queue with stable priority ordering and cancellable waiting jobs. */
export function taskQueueManager(options: TaskQueueOptions = {}): ManagedTaskQueue {
  const concurrency = positiveInteger(options.concurrency, 1, 'concurrency');
  const pending: QueuedTask<unknown>[] = [];
  const closeWaiters: Array<() => void> = [];
  let active = 0;
  let sequence = 0;
  let accepting = true;

  const settleClose = (): void => {
    if (!accepting && pending.length === 0 && active === 0) {
      for (const resolve of closeWaiters.splice(0)) resolve();
    }
  };

  const drain = (): void => {
    while (active < concurrency && pending.length > 0) {
      const item = pending.shift()!;
      if (item.signal?.aborted) {
        item.reject(abortReason(item.signal));
        continue;
      }
      if (item.signal && item.abortListener) {
        item.signal.removeEventListener('abort', item.abortListener);
      }
      active++;
      Promise.resolve()
        .then(item.run)
        .then(item.resolve, item.reject)
        .finally(() => {
          active--;
          drain();
          settleClose();
        });
    }
    settleClose();
  };

  const manager: ManagedTaskQueue = {
    enqueue<T>(run: () => T | Promise<T>, taskOptions: ConcurrencyTaskOptions = {}): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (!accepting) {
          reject(new Error('Task queue is closed'));
          return;
        }
        if (taskOptions.signal?.aborted) {
          reject(abortReason(taskOptions.signal));
          return;
        }
        const priority = taskOptions.priority ?? 0;
        if (!Number.isFinite(priority)) {
          reject(new RangeError('Task priority must be finite'));
          return;
        }
        const item: QueuedTask<T> = {
          run,
          priority,
          order: sequence++,
          signal: taskOptions.signal,
          resolve,
          reject,
        };
        if (taskOptions.signal) {
          item.abortListener = () => {
            const index = pending.indexOf(item as QueuedTask<unknown>);
            if (index >= 0) {
              pending.splice(index, 1);
              reject(abortReason(taskOptions.signal!));
              settleClose();
            }
          };
          taskOptions.signal.addEventListener('abort', item.abortListener, { once: true });
        }
        pending.push(item as QueuedTask<unknown>);
        pending.sort((a, b) => b.priority - a.priority || a.order - b.order);
        drain();
      });
    },
    close(closeOptions = {}): Promise<void> {
      accepting = false;
      if (closeOptions.cancelPending) {
        for (const item of pending.splice(0)) {
          if (item.signal && item.abortListener) item.signal.removeEventListener('abort', item.abortListener);
          item.reject(new Error('Task queue closed before task started'));
        }
      } else {
        drain();
      }
      if (pending.length === 0 && active === 0) return Promise.resolve();
      return new Promise(resolve => closeWaiters.push(resolve));
    },
    get size() { return pending.length; },
    get running() { return active; },
    get closed() { return !accepting; },
  };
  return manager;
}

export interface DependencyTask<T> {
  id: string;
  dependsOn?: readonly string[];
  run: (signal?: AbortSignal) => T | Promise<T>;
}

export interface DependencyGraph {
  order: string[];
  layers: string[][];
  dependencies: Map<string, string[]>;
}

/** Validates a dependency DAG and returns a stable topological ordering and parallel layers. */
export function taskDependencyGraphResolver(
  tasks: readonly { id: string; dependsOn?: readonly string[] }[]
): DependencyGraph {
  const dependencies = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.id || typeof task.id !== 'string') throw new TypeError('Task id must be a non-empty string');
    if (dependencies.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    dependencies.set(task.id, [...(task.dependsOn ?? [])]);
  }
  for (const [id, deps] of dependencies) {
    for (const dependency of deps) {
      if (!dependencies.has(dependency)) throw new Error(`Task '${id}' depends on unknown task '${dependency}'`);
      if (dependency === id) throw new Error(`Dependency cycle detected: ${id} -> ${id}`);
    }
  }

  const remaining = new Map([...dependencies].map(([id, deps]) => [id, new Set(deps)]));
  const layers: string[][] = [];
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (ready.length === 0) {
      const cycleIds = [...remaining.keys()];
      throw new Error(`Dependency cycle detected among: ${cycleIds.join(', ')}`);
    }
    layers.push(ready);
    order.push(...ready);
    for (const id of ready) remaining.delete(id);
    for (const deps of remaining.values()) for (const id of ready) deps.delete(id);
  }
  return { order, layers, dependencies };
}

export interface DependencySchedulerOptions {
  concurrency?: number;
  signal?: AbortSignal;
}

/** Runs ready DAG nodes concurrently and prevents dependent work from running after failure. */
export async function dependencyAwareScheduler<T>(
  tasks: readonly DependencyTask<T>[],
  options: DependencySchedulerOptions = {}
): Promise<Map<string, T>> {
  const graph = taskDependencyGraphResolver(tasks);
  const concurrency = positiveInteger(options.concurrency, Math.max(1, tasks.length), 'concurrency');
  const byId = new Map(tasks.map(task => [task.id, task]));
  const status = new Map(tasks.map(task => [task.id, 'pending' as 'pending' | 'running' | 'fulfilled' | 'failed' | 'blocked']));
  const values = new Map<string, T>();
  const errors: unknown[] = [];
  const running = new Map<string, Promise<void>>();

  while ([...status.values()].some(value => value === 'pending' || value === 'running')) {
    let madeProgress = false;
    for (const id of graph.order) {
      if (status.get(id) !== 'pending') continue;
      if (options.signal?.aborted) {
        const error = abortReason(options.signal);
        status.set(id, 'blocked');
        errors.push(error);
        madeProgress = true;
        continue;
      }
      const deps = graph.dependencies.get(id)!;
      if (deps.some(dep => status.get(dep) === 'failed' || status.get(dep) === 'blocked')) {
        const error = new Error(`Task '${id}' was blocked because a dependency failed`);
        status.set(id, 'blocked');
        errors.push(error);
        madeProgress = true;
        continue;
      }
      if (deps.some(dep => status.get(dep) !== 'fulfilled') || running.size >= concurrency) continue;
      const task = byId.get(id)!;
      status.set(id, 'running');
      const promise = Promise.resolve()
        .then(() => task.run(options.signal))
        .then(value => { values.set(id, value); status.set(id, 'fulfilled'); }, error => { errors.push(error); status.set(id, 'failed'); })
        .finally(() => running.delete(id));
      running.set(id, promise);
      madeProgress = true;
    }
    if (running.size > 0) {
      await Promise.race(running.values());
      continue;
    }
    if (!madeProgress && [...status.values()].some(value => value === 'pending')) {
      throw new Error('Dependency scheduler could not make progress');
    }
  }

  if (errors.length > 0) {
    const aggregate = new AggregateError(errors, `${errors.length} task(s) failed or were blocked`);
    Object.defineProperty(aggregate, 'results', { value: values, enumerable: true });
    throw aggregate;
  }
  return values;
}

export interface Mutex {
  acquire(signal?: AbortSignal): Promise<() => void>;
  runExclusive<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T>;
  readonly locked: boolean;
  readonly pending: number;
}

interface MutexWaiter {
  resolve: (release: () => void) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

/** Creates a fair FIFO mutex whose release handles are safe to call more than once. */
export function mutexLock(): Mutex {
  let held = false;
  const waiters: MutexWaiter[] = [];

  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (waiters.length > 0) {
        const next = waiters.shift()!;
        if (next.signal?.aborted) {
          if (next.signal && next.abortListener) next.signal.removeEventListener('abort', next.abortListener);
          next.reject(abortReason(next.signal));
          continue;
        }
        if (next.signal && next.abortListener) next.signal.removeEventListener('abort', next.abortListener);
        next.resolve(makeRelease());
        return;
      }
      held = false;
    };
  };

  return {
    acquire(signal?: AbortSignal): Promise<() => void> {
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      if (!held) {
        held = true;
        return Promise.resolve(makeRelease());
      }
      return new Promise((resolve, reject) => {
        const waiter: MutexWaiter = { resolve, reject, signal };
        if (signal) {
          waiter.abortListener = () => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
              reject(abortReason(signal));
            }
          };
          signal.addEventListener('abort', waiter.abortListener, { once: true });
        }
        waiters.push(waiter);
      });
    },
    async runExclusive<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
      const release = await this.acquire(signal);
      try { return await operation(); } finally { release(); }
    },
    get locked() { return held; },
    get pending() { return waiters.length; },
  };
}

export interface WorkerPoolOptions<T, R> {
  concurrency: number;
  worker: (item: T, index: number, signal?: AbortSignal) => R | Promise<R>;
}

export interface WorkerPool<T, R> {
  run(items: readonly T[], options?: { signal?: AbortSignal }): Promise<R[]>;
  readonly concurrency: number;
  readonly active: number;
}

/** Creates a worker pool with a shared concurrency bound across all submitted batches. */
export function workerPoolManager<T, R>(options: WorkerPoolOptions<T, R>): WorkerPool<T, R> {
  const concurrency = positiveInteger(options.concurrency, 1, 'concurrency');
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = async (signal?: AbortSignal): Promise<() => void> => {
    if (signal?.aborted) throw abortReason(signal);
    if (active < concurrency) {
      active++;
      return () => release();
    }
    await new Promise<void>((resolve, reject) => {
      let listener: (() => void) | undefined;
      const resume = (): void => {
        if (signal && listener) signal.removeEventListener('abort', listener);
        resolve();
      };
      if (signal) {
        listener = () => {
          const index = waiters.indexOf(resume);
          if (index >= 0) waiters.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', listener, { once: true });
      }
      waiters.push(resume);
    });
    if (signal?.aborted) throw abortReason(signal);
    active++;
    return () => release();
  };
  const release = (): void => {
    active--;
    waiters.shift()?.();
  };
  return {
    async run(items, runOptions = {}) {
      return Promise.all(items.map(async (item, index) => {
        const releaseSlot = await acquire(runOptions.signal);
        try { return await options.worker(item, index, runOptions.signal); } finally { releaseSlot(); }
      }));
    },
    concurrency,
    get active() { return active; },
  };
}

export interface RateLimiterOptions {
  maxRequests: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const realSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(abortReason(signal)); return; }
  const timer = setTimeout(done, ms);
  function done(): void { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }
  function onAbort(): void { clearTimeout(timer); reject(abortReason(signal!)); }
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** A FIFO sliding-window limiter; time and sleeping can be injected for deterministic tests. */
export function rateLimiter(options: RateLimiterOptions): {
  acquire(signal?: AbortSignal): Promise<void>;
  run<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T>;
  readonly queued: number;
} {
  const maxRequests = positiveInteger(options.maxRequests, 1, 'maxRequests');
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) throw new RangeError('intervalMs must be positive');
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const timestamps: number[] = [];
  const mutex = mutexLock();
  let logicalTime = Number.NEGATIVE_INFINITY;
  return {
    async acquire(signal) {
      await mutex.runExclusive(async () => {
        // The loop exits by returning after a timestamp is admitted.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (signal?.aborted) throw abortReason(signal);
          const current = Math.max(now(), logicalTime);
          while (timestamps.length > 0 && current - timestamps[0] >= options.intervalMs) timestamps.shift();
          if (timestamps.length < maxRequests) {
            timestamps.push(current);
            logicalTime = current;
            return;
          }
          const delay = Math.max(0, timestamps[0] + options.intervalMs - current);
          await sleep(delay, signal);
          logicalTime = Math.max(now(), current + delay);
        }
      }, signal);
    },
    async run<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
      await this.acquire(signal);
      return operation();
    },
    get queued() { return mutex.pending; },
  };
}

export interface BackpressureOptions {
  highWaterMark: number;
  lowWaterMark?: number;
}

/** Pauses producers above a high watermark and releases them at/below the low watermark. */
export function backpressureController(options: BackpressureOptions): {
  update(size: number): void;
  wait(signal?: AbortSignal): Promise<void>;
  close(reason?: unknown): void;
  readonly size: number;
  readonly pressured: boolean;
} {
  const high = options.highWaterMark;
  const low = options.lowWaterMark ?? Math.max(0, high - 1);
  if (!Number.isFinite(high) || high < 1 || !Number.isFinite(low) || low < 0 || low > high) {
    throw new RangeError('Watermarks must satisfy highWaterMark >= lowWaterMark >= 0');
  }
  let size = 0;
  let pressured = false;
  let closedReason: unknown;
  const waiters = new Set<{ resolve: () => void; reject: (reason?: unknown) => void; signal?: AbortSignal; listener?: () => void }>();
  const release = (): void => {
    for (const waiter of waiters) {
      if (waiter.signal && waiter.listener) waiter.signal.removeEventListener('abort', waiter.listener);
      waiter.resolve();
    }
    waiters.clear();
  };
  return {
    update(nextSize) {
      if (!Number.isFinite(nextSize) || nextSize < 0) throw new RangeError('Backpressure size must be non-negative');
      size = nextSize;
      if (!pressured && size >= high) pressured = true;
      else if (pressured && size <= low) { pressured = false; release(); }
    },
    wait(signal) {
      if (closedReason !== undefined) return Promise.reject(closedReason);
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      if (!pressured) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const waiter = { resolve, reject, signal, listener: undefined as (() => void) | undefined };
        if (signal) {
          waiter.listener = () => { waiters.delete(waiter); reject(abortReason(signal)); };
          signal.addEventListener('abort', waiter.listener, { once: true });
        }
        waiters.add(waiter);
      });
    },
    close(reason = new Error('Backpressure controller closed')) {
      if (closedReason !== undefined) return;
      closedReason = reason;
      for (const waiter of waiters) {
        if (waiter.signal && waiter.listener) waiter.signal.removeEventListener('abort', waiter.listener);
        waiter.reject(reason);
      }
      waiters.clear();
    },
    get size() { return size; },
    get pressured() { return pressured; },
  };
}

/** Tracks a wait-for graph and returns a cycle when one is present. */
export function deadlockDetector(): {
  addWait(waiter: string, resource: string): void;
  removeWait(waiter: string, resource: string): void;
  findCycle(): string[] | undefined;
  hasDeadlock(): boolean;
  clear(): void;
} {
  const edges = new Map<string, Set<string>>();
  const findCycle = (): string[] | undefined => {
    const visited = new Set<string>();
    const active = new Map<string, number>();
    const stack: string[] = [];
    const visit = (node: string): string[] | undefined => {
      if (active.has(node)) return [...stack.slice(active.get(node)!), node];
      if (visited.has(node)) return undefined;
      visited.add(node);
      active.set(node, stack.length);
      stack.push(node);
      for (const next of edges.get(node) ?? []) {
        const found = visit(next);
        if (found) return found;
      }
      stack.pop();
      active.delete(node);
      return undefined;
    };
    for (const node of edges.keys()) {
      const found = visit(node);
      if (found) return found;
    }
    return undefined;
  };
  return {
    addWait(waiter, resource) {
      if (!waiter || !resource) throw new TypeError('Waiter and resource ids are required');
      let targets = edges.get(waiter);
      if (!targets) { targets = new Set(); edges.set(waiter, targets); }
      targets.add(resource);
    },
    removeWait(waiter, resource) {
      const targets = edges.get(waiter);
      targets?.delete(resource);
      if (targets?.size === 0) edges.delete(waiter);
    },
    findCycle,
    hasDeadlock: () => findCycle() !== undefined,
    clear: () => edges.clear(),
  };
}

/** Inserts into an already descending-priority array; equal priorities remain FIFO. */
export function priorityQueueInsert<T extends { priority?: number }>(
  queue: T[],
  item: T,
  priorityOf: (value: T) => number = value => value.priority ?? 0
): T[] {
  const priority = priorityOf(item);
  if (!Number.isFinite(priority)) throw new RangeError('Queue priority must be finite');
  let low = 0;
  let high = queue.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const existing = priorityOf(queue[middle]);
    if (!Number.isFinite(existing)) throw new RangeError('Existing queue priority must be finite');
    if (existing >= priority) low = middle + 1;
    else high = middle;
  }
  queue.splice(low, 0, item);
  return queue;
}

export interface BatchJobOptions {
  batchSize?: number;
  concurrency?: number;
  signal?: AbortSignal;
}

/** Runs jobs in sequential batches, bounding concurrency within each batch. */
export async function batchJobRunner<T>(
  jobs: readonly (() => T | Promise<T>)[],
  options: BatchJobOptions = {}
): Promise<T[]> {
  if (jobs.length === 0) return [];
  const batchSize = positiveInteger(options.batchSize, jobs.length, 'batchSize');
  const concurrency = Math.min(batchSize, positiveInteger(options.concurrency, batchSize, 'concurrency'));
  const results: T[] = [];
  for (let start = 0; start < jobs.length; start += batchSize) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    const batch = jobs.slice(start, start + batchSize);
    const batchResults = await parallelLimitEnforcer(batch, concurrency, { signal: options.signal });
    results.push(...batchResults);
  }
  return results;
}

const fileWriteLocks = new Map<string, { mutex: Mutex; users: number }>();

/** Serializes write callbacks by absolute path and removes idle lock entries afterwards. */
export async function concurrentFileWriteGuard<T>(filePath: string, write: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!filePath) throw new TypeError('filePath is required');
  const canonical = path.resolve(filePath);
  let entry = fileWriteLocks.get(canonical);
  if (!entry) { entry = { mutex: mutexLock(), users: 0 }; fileWriteLocks.set(canonical, entry); }
  entry.users++;
  try {
    return await entry.mutex.runExclusive(write, signal);
  } finally {
    entry.users--;
    if (entry.users === 0 && !entry.mutex.locked && entry.mutex.pending === 0) fileWriteLocks.delete(canonical);
  }
}

export interface CancellationToken {
  readonly signal: AbortSignal;
  readonly cancelled: boolean;
  readonly reason: unknown;
  cancel(reason?: unknown): void;
  throwIfCancelled(): void;
}

/** Creates an explicit cancellation token backed by AbortController. */
export function taskCancellationToken(parent?: AbortSignal): CancellationToken {
  const controller = new AbortController();
  const cancel = (reason: unknown = new Error('Task cancelled')): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const forward = (): void => cancel(parent ? abortReason(parent) : undefined);
  if (parent?.aborted) forward();
  else parent?.addEventListener('abort', forward, { once: true });
  return {
    signal: controller.signal,
    get cancelled() { return controller.signal.aborted; },
    get reason() { return controller.signal.reason; },
    cancel,
    throwIfCancelled() { if (controller.signal.aborted) throw abortReason(controller.signal); },
  };
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  signal?: AbortSignal;
  concurrency?: number;
}

async function retryOperation<T>(operation: () => T | Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = positiveInteger(options.maxAttempts, 3, 'maxAttempts');
  const baseDelayMs = options.baseDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const jitter = options.jitter ?? 0.2;
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0 || !Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new RangeError('Retry delays must be non-negative finite numbers');
  }
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new RangeError('jitter must be between 0 and 1');
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  let attempt = 0;
  // The loop exits by returning a result or throwing the final error.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    attempt++;
    try { return await operation(); } catch (error) {
      if (attempt >= maxAttempts || options.shouldRetry?.(error, attempt) === false) throw error;
      const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.max(0, Math.round(raw * (1 - jitter + 2 * jitter * random())));
      await sleep(delay, options.signal);
    }
  }
}

/** Retries each queued job with exponential backoff and bounded parallel execution. */
export function retryQueueWithBackoff<T>(jobs: readonly (() => T | Promise<T>)[], options: RetryOptions = {}): Promise<T[]> {
  const concurrency = positiveInteger(options.concurrency, Math.max(1, jobs.length), 'concurrency');
  return parallelLimitEnforcer(jobs.map(job => () => retryOperation(job, options)), concurrency, { signal: options.signal });
}

/** Runs asynchronous functions with an explicit maximum in-flight count. */
export async function parallelLimitEnforcer<T>(
  tasks: readonly (() => T | Promise<T>)[],
  limit: number,
  options: { signal?: AbortSignal } = {}
): Promise<T[]> {
  const concurrency = positiveInteger(limit, 1, 'limit');
  const results = new Array<T>(tasks.length);
  let next = 0;
  const workerCount = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    // The worker exits by returning when no task remains.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      const index = next++;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  }));
  return results;
}

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface JobRecord<T = unknown> {
  id: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  attempt: number;
  result?: T;
  error?: unknown;
}

/** Tracks job state with explicit legal transitions and an injectable clock. */
export function jobStatusTracker<T = unknown>(options: { now?: () => number } = {}): {
  register(id: string): JobRecord<T>;
  start(id: string): JobRecord<T>;
  succeed(id: string, result: T): JobRecord<T>;
  fail(id: string, error: unknown): JobRecord<T>;
  cancel(id: string, reason?: unknown): JobRecord<T>;
  get(id: string): JobRecord<T> | undefined;
  list(): JobRecord<T>[];
} {
  const now = options.now ?? Date.now;
  const jobs = new Map<string, JobRecord<T>>();
  const getMutable = (id: string): JobRecord<T> => {
    const job = jobs.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    return job;
  };
  const transition = (id: string, allowed: JobStatus[], status: JobStatus, update: Partial<JobRecord<T>> = {}): JobRecord<T> => {
    const job = getMutable(id);
    if (!allowed.includes(job.status)) throw new Error(`Invalid job status transition: ${job.status} -> ${status}`);
    Object.assign(job, update, { status, updatedAt: now() });
    return { ...job };
  };
  return {
    register(id) {
      if (!id) throw new TypeError('Job id is required');
      if (jobs.has(id)) throw new Error(`Job already registered: ${id}`);
      const timestamp = now();
      const record: JobRecord<T> = { id, status: 'pending', createdAt: timestamp, updatedAt: timestamp, attempt: 0 };
      jobs.set(id, record);
      return { ...record };
    },
    start(id) {
      const job = getMutable(id);
      const updated = transition(id, ['pending', 'failed'], 'running', { attempt: job.attempt + 1, result: undefined, error: undefined });
      return updated;
    },
    succeed(id, result) { return transition(id, ['running'], 'succeeded', { result, error: undefined }); },
    fail(id, error) { return transition(id, ['running'], 'failed', { error, result: undefined }); },
    cancel(id, reason = new Error('Job cancelled')) { return transition(id, ['pending', 'running'], 'cancelled', { error: reason }); },
    get(id) { const record = jobs.get(id); return record ? { ...record } : undefined; },
    list() { return [...jobs.values()].map(record => ({ ...record })); },
  };
}

export interface TaskTimeoutError extends Error {
  code: 'ETIMEDOUT';
  operation?: string;
}

function makeTimeoutError(operation?: string): TaskTimeoutError {
  const error = new Error(operation ? `Operation '${operation}' timed out` : 'Operation timed out') as TaskTimeoutError;
  error.name = 'TimeoutError';
  error.code = 'ETIMEDOUT';
  if (operation !== undefined) error.operation = operation;
  return error;
}

/** Runs an operation with a deadline, abort signal, and timer cleanup. */
export function taskTimeoutManager<T>(
  operation: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
  options: { operation?: string; signal?: AbortSignal } = {}
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return Promise.reject(new RangeError('timeoutMs must be non-negative and finite'));
  if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeoutError = makeTimeoutError(options.operation);
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onAbort = (): void => {
      const reason = options.signal ? abortReason(options.signal) : new Error('Operation aborted');
      controller.abort(reason);
      finish(() => reject(reason));
    };
    const timer = setTimeout(() => {
      controller.abort(timeoutError);
      finish(() => reject(timeoutError));
    }, timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

/** Collects every promise outcome and convenient success/error projections. */
export async function resultAggregator<T>(values: Iterable<T | PromiseLike<T>>): Promise<{
  results: PromiseSettledResult<T>[];
  successes: T[];
  errors: unknown[];
  fulfilledCount: number;
  rejectedCount: number;
}> {
  const results = await Promise.allSettled([...values]);
  const successes: T[] = [];
  const errors: unknown[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') successes.push(result.value);
    else errors.push(result.reason);
  }
  return { results, successes, errors, fulfilledCount: successes.length, rejectedCount: errors.length };
}

export interface QueueStorageAdapter {
  readFile(filePath: string): Promise<string | Buffer>;
  writeFile(filePath: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(filePath: string): Promise<void>;
  mkdir(directory: string): Promise<void>;
}

export interface QueuePersistenceOptions {
  filePath: string;
  adapter?: QueueStorageAdapter;
}

const defaultQueueAdapter: QueueStorageAdapter = {
  readFile: async file => fs.readFile(file, 'utf8'),
  writeFile: async (file, data) => { await fs.writeFile(file, data, { encoding: 'utf8', mode: 0o600 }); },
  rename: async (from, to) => { await fs.rename(from, to); },
  rm: async file => { await fs.rm(file, { force: true }); },
  mkdir: async directory => { await fs.mkdir(directory, { recursive: true }); },
};

/** Saves queue snapshots through an injected atomic-write adapter and restores JSON arrays. */
export function queuePersistence<T>(options: QueuePersistenceOptions): {
  save(items: readonly T[]): Promise<void>;
  load(): Promise<T[]>;
  clear(): Promise<void>;
} {
  if (!options.filePath) throw new TypeError('filePath is required');
  const adapter = options.adapter ?? defaultQueueAdapter;
  const target = path.resolve(options.filePath);
  return {
    async save(items) {
      const directory = path.dirname(target);
      await adapter.mkdir(directory);
      const temp = `${target}.${randomUUID()}.tmp`;
      try {
        await adapter.writeFile(temp, JSON.stringify(items));
        await adapter.rename(temp, target);
      } finally {
        await adapter.rm(temp).catch(() => undefined);
      }
    },
    async load() {
      let text: string | Buffer;
      try { text = await adapter.readFile(target); }
      catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(String(text)); }
      catch (error) { throw new Error(`Queue persistence file contains invalid JSON: ${(error as Error).message}`, { cause: error }); }
      if (!Array.isArray(parsed)) throw new TypeError('Persisted queue must be a JSON array');
      return parsed as T[];
    },
    async clear() { await adapter.rm(target); },
  };
}

export interface IdempotencyOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/** Coalesces in-flight operations per idempotency key and caches successful results. */
export function idempotencyKeyChecker<T>(options: IdempotencyOptions = {}): {
  run(key: string, operation: () => T | Promise<T>): Promise<T>;
  has(key: string): boolean;
  get(key: string): T | undefined;
  delete(key: string): boolean;
  clear(): void;
  readonly size: number;
} {
  const now = options.now ?? Date.now;
  const maxEntries = positiveInteger(options.maxEntries, 1000, 'maxEntries');
  if (options.ttlMs !== undefined && (!Number.isFinite(options.ttlMs) || options.ttlMs < 0)) throw new RangeError('ttlMs must be non-negative');
  const entries = new Map<string, { promise: Promise<T>; settled: boolean; value?: T; expiresAt?: number }>();
  const prune = (): void => {
    const timestamp = now();
    for (const [key, entry] of entries) {
      if (entry.settled && entry.expiresAt !== undefined && entry.expiresAt <= timestamp) entries.delete(key);
    }
  };
  return {
    run(key, operation) {
      if (!key) return Promise.reject(new TypeError('Idempotency key is required'));
      prune();
      const existing = entries.get(key);
      if (existing) return existing.promise;
      const promise = Promise.resolve().then(operation);
      const entry: { promise: Promise<T>; settled: boolean; value?: T; expiresAt?: number } = { promise, settled: false };
      entries.set(key, entry);
      promise.then(value => {
        entry.value = value;
        entry.settled = true;
        if (options.ttlMs !== undefined) entry.expiresAt = now() + options.ttlMs;
        prune();
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
      }, () => { if (entries.get(key) === entry) entries.delete(key); });
      return promise;
    },
    has(key) { prune(); return entries.has(key); },
    get(key) { prune(); return entries.get(key)?.value; },
    delete(key) { return entries.delete(key); },
    clear() { entries.clear(); },
    get size() { prune(); return entries.size; },
  };
}

export interface ShutdownHandler {
  name: string;
  handler: (signal: AbortSignal) => void | Promise<void>;
  timeoutMs?: number;
}

/** Runs registered shutdown handlers once in reverse order, collecting individual failures. */
export function gracefulShutdownHandler(options: { timeoutMs?: number } = {}): {
  register(name: string, handler: ShutdownHandler['handler'], timeoutMs?: number): void;
  shutdown(): Promise<{ completed: string[]; errors: Array<{ name: string; error: unknown }> }>;
  readonly isShuttingDown: boolean;
} {
  const handlers: ShutdownHandler[] = [];
  let shuttingDown = false;
  let resultPromise: Promise<{ completed: string[]; errors: Array<{ name: string; error: unknown }> }> | undefined;
  return {
    register(name, handler, timeoutMs) {
      if (shuttingDown) throw new Error('Shutdown has already started');
      if (!name || typeof handler !== 'function') throw new TypeError('A handler name and function are required');
      if (handlers.some(item => item.name === name)) throw new Error(`Duplicate shutdown handler: ${name}`);
      handlers.push({ name, handler, timeoutMs });
    },
    shutdown() {
      if (resultPromise) return resultPromise;
      shuttingDown = true;
      resultPromise = (async () => {
        const completed: string[] = [];
        const errors: Array<{ name: string; error: unknown }> = [];
        for (const entry of [...handlers].reverse()) {
          try {
            const timeout = entry.timeoutMs ?? options.timeoutMs;
            if (timeout === undefined) await entry.handler(new AbortController().signal);
            else await taskTimeoutManager(entry.handler, timeout, { operation: `shutdown:${entry.name}` });
            completed.push(entry.name);
          } catch (error) { errors.push({ name: entry.name, error }); }
        }
        return { completed, errors };
      })();
      return resultPromise;
    },
    get isShuttingDown() { return shuttingDown; },
  };
}
