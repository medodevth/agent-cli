import { jest } from '@jest/globals';
import {
  batchJobRunner,
  backpressureController,
  concurrentFileWriteGuard,
  deadlockDetector,
  dependencyAwareScheduler,
  gracefulShutdownHandler,
  idempotencyKeyChecker,
  jobStatusTracker,
  mutexLock,
  parallelLimitEnforcer,
  priorityQueueInsert,
  queuePersistence,
  rateLimiter,
  resultAggregator,
  retryQueueWithBackoff,
  taskQueueManager,
  taskCancellationToken,
  taskDependencyGraphResolver,
  taskTimeoutManager,
  workerPoolManager,
} from '../../src/utils/ConcurrencyUtilities.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('ConcurrencyUtilities — queue and synchronization primitives', () => {
  it('runs queued tasks by priority while preserving FIFO ties', async () => {
    const queue = taskQueueManager({ concurrency: 1 });
    const started = deferred();
    const release = deferred();
    const order: string[] = [];
    const first = queue.enqueue(async () => { started.resolve(); await release.promise; order.push('first'); });
    await started.promise;
    const low = queue.enqueue(() => { order.push('low'); }, { priority: 1 });
    const high1 = queue.enqueue(() => { order.push('high1'); }, { priority: 5 });
    const high2 = queue.enqueue(() => { order.push('high2'); }, { priority: 5 });
    release.resolve();
    await Promise.all([first, low, high1, high2]);
    expect(order).toEqual(['first', 'high1', 'high2', 'low']);
  });

  it('schedules tasks only after their dependencies settle', async () => {
    const order: string[] = [];
    const result = await dependencyAwareScheduler([
      { id: 'compile', run: async () => { order.push('compile'); return 'built'; } },
      { id: 'tests', dependsOn: ['compile'], run: async () => { order.push('tests'); return 'passed'; } },
      { id: 'lint', run: async () => { order.push('lint'); return 'clean'; } },
    ], { concurrency: 2 });
    expect(order.indexOf('tests')).toBeGreaterThan(order.indexOf('compile'));
    expect(result.get('tests')).toBe('passed');
    expect(result.get('lint')).toBe('clean');
  });

  it('serializes exclusive sections through a FIFO mutex', async () => {
    const mutex = mutexLock();
    let running = 0;
    let maximum = 0;
    await Promise.all(Array.from({ length: 8 }, () => mutex.runExclusive(async () => {
      running++;
      maximum = Math.max(maximum, running);
      await Promise.resolve();
      running--;
    })));
    expect(maximum).toBe(1);
    expect(mutex.locked).toBe(false);
  });

  it('limits worker concurrency and preserves input result order', async () => {
    let running = 0;
    let maximum = 0;
    const pool = workerPoolManager({ concurrency: 2, worker: async (value: number) => {
      running++;
      maximum = Math.max(maximum, running);
      await new Promise(resolve => setTimeout(resolve, value === 1 ? 8 : 1));
      running--;
      return value * 10;
    } });
    await expect(pool.run([1, 2, 3, 4])).resolves.toEqual([10, 20, 30, 40]);
    expect(maximum).toBe(2);
  });

  it('enforces a request window using an injected clock and sleeper', async () => {
    let now = 0;
    const limiter = rateLimiter({ maxRequests: 2, intervalMs: 10, now: () => now, sleep: async ms => { now += ms; } });
    await limiter.acquire();
    await limiter.acquire();
    expect(now).toBe(0);
    await limiter.acquire();
    expect(now).toBe(10);
  });

  it('holds producers while pressured and resumes them at the low watermark', async () => {
    const controller = backpressureController({ highWaterMark: 3, lowWaterMark: 1 });
    controller.update(3);
    let resumed = false;
    const waiting = controller.wait().then(() => { resumed = true; });
    await Promise.resolve();
    expect(resumed).toBe(false);
    controller.update(2);
    await Promise.resolve();
    expect(resumed).toBe(false);
    controller.update(1);
    await waiting;
    expect(resumed).toBe(true);
  });

  it('detects a cycle in the wait-for graph and clears it when an edge is removed', () => {
    const detector = deadlockDetector();
    detector.addWait('worker-a', 'resource-b');
    detector.addWait('resource-b', 'worker-c');
    detector.addWait('worker-c', 'worker-a');
    expect(detector.findCycle()).toEqual(expect.arrayContaining(['worker-a', 'resource-b', 'worker-c']));
    detector.removeWait('worker-c', 'worker-a');
    expect(detector.findCycle()).toBeUndefined();
  });

  it('inserts into a stable descending-priority queue', () => {
    const queue = [{ name: 'first', priority: 4 }, { name: 'last', priority: 1 }];
    const returned = priorityQueueInsert(queue, { name: 'second', priority: 4 }, item => item.priority);
    expect(returned).toBe(queue);
    expect(queue.map(item => item.name)).toEqual(['first', 'second', 'last']);
  });

  it('runs batches with bounded concurrency and keeps results in input order', async () => {
    const order: number[] = [];
    const jobs = [1, 2, 3, 4].map(value => async () => {
      await new Promise(resolve => setTimeout(resolve, value === 1 ? 8 : 1));
      order.push(value);
      return value * 2;
    });
    await expect(batchJobRunner(jobs, { batchSize: 2, concurrency: 2 })).resolves.toEqual([2, 4, 6, 8]);
    expect(order).toHaveLength(4);
  });

  it('serializes concurrent writes to the same canonical file path', async () => {
    const started = deferred();
    const release = deferred();
    const order: string[] = [];
    let running = 0;
    let maximum = 0;
    const first = concurrentFileWriteGuard('/tmp/concurrency-utils/shared.txt', async () => {
      running++; maximum = Math.max(maximum, running); started.resolve(); await release.promise; order.push('first'); running--;
    });
    await started.promise;
    const second = concurrentFileWriteGuard('/tmp/concurrency-utils/shared.txt', async () => {
      running++; maximum = Math.max(maximum, running); order.push('second'); running--;
    });
    release.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
    expect(maximum).toBe(1);
  });

  it('cancels queued tasks with a usable cancellation token', async () => {
    const token = taskCancellationToken();
    expect(token.cancelled).toBe(false);
    token.cancel(new Error('stop now'));
    expect(token.cancelled).toBe(true);
    expect(token.signal.aborted).toBe(true);
    expect(() => token.throwIfCancelled()).toThrow('stop now');
  });

  it('retries failed queue jobs with injected capped backoff', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const values = await retryQueueWithBackoff([
      async () => { if (++attempts < 3) throw new Error('temporary'); return 'done'; },
      async () => 'other',
    ], { maxAttempts: 3, baseDelayMs: 2, maxDelayMs: 8, jitter: 0, sleep: async ms => { delays.push(ms); } });
    expect(values).toEqual(['done', 'other']);
    expect(attempts).toBe(3);
    expect(delays).toEqual([2, 4]);
  });

  it('never exceeds the shared parallel limit', async () => {
    let running = 0;
    let maximum = 0;
    const tasks = Array.from({ length: 7 }, (_, value) => async () => {
      running++;
      maximum = Math.max(maximum, running);
      await Promise.resolve();
      running--;
      return value;
    });
    await expect(parallelLimitEnforcer(tasks, 3)).resolves.toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(maximum).toBe(3);
  });

  it('tracks valid job status transitions and rejects invalid transitions', () => {
    const tracker = jobStatusTracker({ now: () => 123 });
    tracker.register('job-1');
    tracker.start('job-1');
    tracker.succeed('job-1', 'ok');
    expect(tracker.get('job-1')).toMatchObject({ status: 'succeeded', result: 'ok', updatedAt: 123 });
    expect(() => tracker.fail('job-1', new Error('too late'))).toThrow(/transition/i);
  });

  it('rejects an operation that exceeds its deadline and aborts its signal', async () => {
    jest.useFakeTimers();
    try {
      let aborted = false;
      const pending = taskTimeoutManager(signal => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; });
        signal.addEventListener('abort', () => reject(signal.reason));
      }), 30, { operation: 'compile' });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'ETIMEDOUT', operation: 'compile' });
      await Promise.resolve();
      jest.advanceTimersByTime(30);
      await assertion;
      expect(aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('collects settled outcomes without discarding successes or rejection reasons', async () => {
    const failure = new Error('one failed');
    const combined = await resultAggregator([Promise.resolve(1), Promise.reject(failure), Promise.resolve(3)]);
    expect(combined.results).toEqual([
      { status: 'fulfilled', value: 1 },
      { status: 'rejected', reason: failure },
      { status: 'fulfilled', value: 3 },
    ]);
    expect(combined.successes).toEqual([1, 3]);
    expect(combined.errors).toEqual([failure]);
  });

  it('persists a queue atomically through an injected storage adapter', async () => {
    const files = new Map<string, string>();
    const persistence = queuePersistence<{ id: number }>({
      filePath: '/queues/pending.json',
      adapter: {
        readFile: async file => { const value = files.get(file); if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return value; },
        writeFile: async (file, data) => { files.set(file, data); },
        rename: async (from, to) => { const data = files.get(from); if (data === undefined) throw new Error('missing temp'); files.set(to, data); files.delete(from); },
        rm: async file => { files.delete(file); },
        mkdir: async () => {},
      },
    });
    await persistence.save([{ id: 1 }, { id: 2 }]);
    await expect(persistence.load()).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    expect([...files.keys()]).toEqual(['/queues/pending.json']);
  });

  it('resolves a dependency graph into topological order and parallel layers', () => {
    const graph = taskDependencyGraphResolver([
      { id: 'compile' },
      { id: 'test', dependsOn: ['compile'] },
      { id: 'lint' },
    ]);
    expect(graph.order.indexOf('compile')).toBeLessThan(graph.order.indexOf('test'));
    expect(graph.layers).toEqual([expect.arrayContaining(['compile', 'lint']), ['test']]);
    expect(() => taskDependencyGraphResolver([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }])).toThrow(/cycle/i);
  });

  it('coalesces concurrent idempotency keys and returns the cached value', async () => {
    const checker = idempotencyKeyChecker<string>();
    let calls = 0;
    const work = async () => { calls++; await Promise.resolve(); return 'saved'; };
    const [first, second] = await Promise.all([checker.run('request-1', work), checker.run('request-1', work)]);
    expect(first).toBe('saved');
    expect(second).toBe('saved');
    expect(calls).toBe(1);
    await checker.run('request-1', work);
    expect(calls).toBe(1);
  });

  it('runs registered shutdown handlers once in reverse registration order', async () => {
    const order: string[] = [];
    const shutdown = gracefulShutdownHandler();
    shutdown.register('first', async () => { order.push('first'); });
    shutdown.register('second', async () => { order.push('second'); });
    await expect(shutdown.shutdown()).resolves.toMatchObject({ completed: ['second', 'first'], errors: [] });
    await shutdown.shutdown();
    expect(order).toEqual(['second', 'first']);
    expect(shutdown.isShuttingDown).toBe(true);
  });
});
