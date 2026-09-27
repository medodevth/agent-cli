import { jest } from '@jest/globals';
import {
  connectionStringMasker,
  dbAccessAuditLogger,
  dbBackupBeforeMigration,
  dbConnectionPool,
  dbConnectionRetry,
  dbHealthCheck,
  dbQueryTimeout,
  dbSeedDataLoader,
  indexUsageAnalyzer,
  migrationRunner,
  ormModelGenerator,
  queryPlanExplainer,
  queryResultCacher,
  queryResultPaginator,
  readOnlyQueryEnforcer,
  replicationLagMonitor,
  schemaIntrospector,
  slowQueryDetector,
  sqlInjectionSanitizer,
  transactionWrapper,
} from '../../src/utils/DatabaseUtilities.js';

describe('dbConnectionPool (341)', () => {
  it('reuses released connections and enforces the configured maximum', async () => {
    let created = 0;
    const pool = dbConnectionPool({
      create: async () => ({ id: ++created }),
      destroy: async () => undefined,
    }, { maxSize: 1 });

    const first = await pool.acquire();
    const waiting = pool.acquire();
    expect(pool.stats().waiting).toBe(1);
    expect(created).toBe(1);
    await pool.release(first);
    const second = await waiting;
    expect(second).toBe(first);
    expect(pool.stats()).toMatchObject({ size: 1, inUse: 1, idle: 0, closed: false });
    await pool.close();
    await pool.release(second);
    expect(pool.stats()).toMatchObject({ size: 0, inUse: 0, idle: 0, closed: true });
  });

  it('rejects double release and destroys idle and checked-out connections on close', async () => {
    const destroyed: number[] = [];
    let created = 0;
    const pool = dbConnectionPool({
      create: async () => ({ id: ++created }),
      destroy: async connection => { destroyed.push(connection.id); },
    }, { maxSize: 2 });
    const connection = await pool.acquire();
    await pool.release(connection);
    await expect(pool.release(connection)).rejects.toThrow(/not checked out|released/i);
    const checkedOut = await pool.acquire();
    const idle = await pool.acquire();
    await pool.release(idle);
    await pool.close();
    await pool.release(checkedOut);
    expect(destroyed).toEqual([2, 1]);
  });

  it('rejects queued acquisitions when closed', async () => {
    const pool = dbConnectionPool({ create: async () => ({}), destroy: async () => undefined }, { maxSize: 1 });
    const held = await pool.acquire();
    const waiting = pool.acquire();
    await pool.close();
    await expect(waiting).rejects.toThrow(/closed/i);
    await pool.release(held);
  });

  it('does not create a connection for a queued caller after a failed creation frees capacity', async () => {
    let createCalls = 0;
    const pool = dbConnectionPool({
      create: async () => {
        createCalls += 1;
        if (createCalls === 1) throw new Error('create failed');
        return { id: createCalls };
      },
      destroy: async () => undefined,
    }, { maxSize: 1 });
    const failed = pool.acquire();
    const waiting = pool.acquire();
    await expect(failed).rejects.toThrow('create failed');
    await expect(waiting).resolves.toEqual({ id: 2 });
    expect(createCalls).toBe(2);
    await pool.close();
  });
});

describe('readOnlyQueryEnforcer (342)', () => {
  it('passes parameterized reads to the injected adapter and rejects writes before execution', async () => {
    const calls: Array<{ sql: string; parameters?: readonly unknown[] }> = [];
    const query = readOnlyQueryEnforcer(async (sql, parameters) => {
      calls.push({ sql, parameters });
      return ['row'];
    });
    await expect(query('SELECT * FROM users WHERE id = ?', [7])).resolves.toEqual(['row']);
    await expect(query('DELETE FROM users WHERE id = ?', [7])).rejects.toThrow(/read-only/i);
    await expect(query('SELECT 1; DROP TABLE users')).rejects.toThrow(/single statement|multiple/i);
    await expect(query('WITH removed AS (DELETE FROM users RETURNING id) SELECT id FROM removed')).rejects.toThrow(/read-only/i);
    expect(calls).toEqual([{ sql: 'SELECT * FROM users WHERE id = ?', parameters: [7] }]);
  });
});

describe('sqlInjectionSanitizer (343)', () => {
  it('normalizes a single parameterized statement and checks binding counts', () => {
    expect(sqlInjectionSanitizer('  SELECT * FROM users WHERE id = ?;  ', [7])).toEqual({
      sql: 'SELECT * FROM users WHERE id = ?',
      parameters: [7],
    });
    expect(sqlInjectionSanitizer('SELECT * FROM users WHERE id = $1 AND tenant = $1', ['x'])).toEqual({
      sql: 'SELECT * FROM users WHERE id = $1 AND tenant = $1',
      parameters: ['x'],
    });
    expect(() => sqlInjectionSanitizer('SELECT * FROM users WHERE id = ?', [])).toThrow(/parameter/i);
    expect(() => sqlInjectionSanitizer('SELECT 1; DELETE FROM users')).toThrow(/single statement|multiple/i);
    expect(() => sqlInjectionSanitizer('SELECT 1 -- hidden comment')).toThrow(/comment/i);
    expect(sqlInjectionSanitizer("SELECT '?' AS value, $tag$;not a terminator$tag$ AS body;", [])).toMatchObject({ sql: "SELECT '?' AS value, $tag$;not a terminator$tag$ AS body" });
  });
});

describe('migrationRunner (344)', () => {
  it('plans pending migrations and applies only unapplied migrations in input order', async () => {
    const events: string[] = [];
    const adapter = {
      getAppliedMigrations: async () => ['001-init'],
      applyMigration: async (migration: { id: string }) => { events.push(migration.id); },
    };
    const migrations = [{ id: '001-init' }, { id: '002-users' }, { id: '003-indexes' }];
    await expect(migrationRunner(migrations, adapter, { dryRun: true })).resolves.toEqual({
      applied: [], skipped: ['001-init'], pending: ['002-users', '003-indexes'], dryRun: true,
    });
    expect(events).toEqual([]);
    await expect(migrationRunner(migrations, adapter)).resolves.toEqual({
      applied: ['002-users', '003-indexes'], skipped: ['001-init'], pending: [], dryRun: false,
    });
    expect(events).toEqual(['002-users', '003-indexes']);
  });
});

describe('schemaIntrospector (345)', () => {
  it('validates the requested table and returns a defensive schema snapshot', async () => {
    const columns = [{ name: 'id', dataType: 'integer', nullable: false }];
    const inspect = jest.fn(async () => columns);
    const schema = await schemaIntrospector('public.users', inspect);
    expect(schema).toEqual({ table: 'public.users', columns });
    schema.columns[0].name = 'changed';
    expect(columns[0].name).toBe('id');
    await expect(schemaIntrospector('users; DROP TABLE secrets', inspect)).rejects.toThrow(/identifier/i);
    expect(inspect).toHaveBeenCalledTimes(1);
  });
});

describe('queryResultPaginator (346)', () => {
  it('requests a bounded page and reports whether another page exists', async () => {
    const fetchPage = jest.fn(async (page: { limit: number; offset: number }) => ({
      items: Array.from({ length: page.limit }, (_, index) => page.offset + index),
      total: 5,
    }));
    await expect(queryResultPaginator(fetchPage, { limit: 2, offset: 2 })).resolves.toEqual({
      items: [2, 3], limit: 2, offset: 2, total: 5, hasMore: true, nextOffset: 4,
    });
    expect(fetchPage).toHaveBeenCalledWith({ limit: 2, offset: 2 });
    await expect(queryResultPaginator(fetchPage, { limit: 0, offset: 0 })).rejects.toThrow(/limit/i);
  });
});

describe('transactionWrapper (347)', () => {
  it('commits successful work and rolls back failed work', async () => {
    const events: string[] = [];
    const adapter = {
      begin: async () => ({ id: 'tx-1' }),
      commit: async () => { events.push('commit'); },
      rollback: async () => { events.push('rollback'); },
    };
    await expect(transactionWrapper(adapter, async tx => tx.id)).resolves.toBe('tx-1');
    const failure = new Error('operation failed');
    await expect(transactionWrapper(adapter, async () => { throw failure; })).rejects.toBe(failure);
    expect(events).toEqual(['commit', 'rollback']);
  });
});

describe('dbBackupBeforeMigration (348)', () => {
  it('runs the migration only after an injected backup succeeds', async () => {
    const events: string[] = [];
    await expect(dbBackupBeforeMigration(
      async () => { events.push('backup'); return 'backup-id'; },
      async () => { events.push('migration'); return 'done'; },
    )).resolves.toEqual({ backup: 'backup-id', result: 'done' });
    expect(events).toEqual(['backup', 'migration']);

    const migration = jest.fn(async () => 'unexpected');
    await expect(dbBackupBeforeMigration(async () => { throw new Error('backup failed'); }, migration)).rejects.toThrow('backup failed');
    expect(migration).not.toHaveBeenCalled();
  });
});

describe('connectionStringMasker (349)', () => {
  it('redacts URI credentials and password-like key/value fields', () => {
    const uri = connectionStringMasker('postgresql://alice:secret@db.example.test/app?password=also-secret&sslmode=require');
    expect(uri).not.toContain('alice');
    expect(uri).not.toContain('secret');
    expect(uri).toContain('db.example.test');
    expect(uri).toContain('sslmode=require');
    const keyword = connectionStringMasker("host=db user=alice password='two words' dbname=app");
    expect(keyword).not.toContain('alice');
    expect(keyword).not.toContain('two words');
    expect(keyword).toContain('host=db');
    expect(connectionStringMasker('Server=db;Initial Catalog=app;Password=case-secret')).not.toContain('case-secret');
  });
});

describe('dbQueryTimeout (350)', () => {
  it('returns completed work and aborts timed-out adapter work', async () => {
    await expect(dbQueryTimeout(async () => 'ok', 100)).resolves.toBe('ok');
    jest.useFakeTimers();
    try {
      let aborted = false;
      const pending = dbQueryTimeout(signal => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
      }), 20);
      const assertion = expect(pending).rejects.toMatchObject({ code: 'ETIMEDOUT' });
      await jest.advanceTimersByTimeAsync(20);
      await assertion;
      expect(aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('ormModelGenerator (351)', () => {
  it('generates a safe TypeScript interface from introspected column metadata', () => {
    const model = ormModelGenerator({ table: 'public.people', columns: [
      { name: 'id', dataType: 'bigint', nullable: false },
      { name: 'display-name', dataType: 'varchar', nullable: true },
      { name: 'payload', dataType: 'custom_type', nullable: false },
    ] });
    expect(model).toContain('export interface People');
    expect(model).toContain('id: number;');
    expect(model).toMatch(/display-name.*string \| null/);
    expect(model).toContain('payload: unknown;');
    expect(() => ormModelGenerator({ table: 'users', columns: [] }, { modelName: 'Bad; Injected' })).toThrow(/modelName/i);
  });
});

describe('indexUsageAnalyzer (352)', () => {
  it('separates unused indexes and totals observed scans', () => {
    expect(indexUsageAnalyzer([
      { indexName: 'users_pkey', scans: 10 },
      { indexName: 'users_legacy_idx', scans: 0 },
    ])).toEqual({ totalIndexes: 2, totalScans: 10, usedIndexes: ['users_pkey'], unusedIndexes: ['users_legacy_idx'] });
    expect(() => indexUsageAnalyzer([{ indexName: 'broken', scans: -1 }])).toThrow(/scans/i);
  });
});

describe('slowQueryDetector (353)', () => {
  it('flags threshold-crossing queries with literal-redacted stable fingerprints', () => {
    const slow = slowQueryDetector([
      { sql: "SELECT * FROM users WHERE email = 'first-secret'", durationMs: 50 },
      { sql: "SELECT * FROM users WHERE email = 'second-secret'", durationMs: 10 },
    ], { thresholdMs: 50 });
    expect(slow).toHaveLength(1);
    expect(slow[0].normalizedSql).toBe('SELECT * FROM users WHERE email = ?');
    expect(slow[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(slow)).not.toContain('first-secret');
  });
});

describe('dbSeedDataLoader (354)', () => {
  it('plans by default and writes only after explicit opt-in through an adapter', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    await expect(dbSeedDataLoader('public.users', rows)).resolves.toMatchObject({
      table: 'public.users', plannedCount: 2, insertedCount: 0, applied: false,
    });
    await expect(dbSeedDataLoader('users', rows, { apply: true })).rejects.toThrow(/adapter/i);
    const insertMany = jest.fn(async (_table: string, records: readonly Record<string, unknown>[]) => records.length);
    await expect(dbSeedDataLoader('users', rows, { apply: true, adapter: { insertMany } })).resolves.toMatchObject({
      plannedCount: 2, insertedCount: 2, applied: true,
    });
    expect(insertMany).toHaveBeenCalledTimes(1);
  });
});

describe('queryPlanExplainer (355)', () => {
  it('explains only read-only parameterized queries without ANALYZE', async () => {
    const explain = jest.fn(async () => [{ plan: 'index scan' }]);
    await expect(queryPlanExplainer('SELECT * FROM users WHERE id = ?', [1], { explain })).resolves.toEqual([{ plan: 'index scan' }]);
    expect(explain).toHaveBeenCalledWith('SELECT * FROM users WHERE id = ?', [1], { analyze: false });
    await expect(queryPlanExplainer('UPDATE users SET active = ?', [false], { explain })).rejects.toThrow(/read-only/i);
    await expect(queryPlanExplainer('SELECT * FROM users; DELETE FROM users', [], { explain })).rejects.toThrow(/single statement|multiple/i);
    expect(explain).toHaveBeenCalledTimes(1);
  });
});

describe('dbHealthCheck (356)', () => {
  it('reports health from an explicitly supplied probe and contains failures', async () => {
    await expect(dbHealthCheck(async () => true, { now: () => 100 })).resolves.toMatchObject({ status: 'healthy', checkedAt: 100 });
    await expect(dbHealthCheck(async () => { throw new Error('password=do-not-leak'); }, { now: () => 100 })).resolves.toMatchObject({ status: 'unhealthy' });
    const report = await dbHealthCheck(async () => { throw new Error('password=do-not-leak'); });
    expect(JSON.stringify(report)).not.toContain('do-not-leak');
  });

  it('reports an unhealthy result on an invalid or backwards-moving injected clock', async () => {
    const times = [10, 5];
    await expect(dbHealthCheck(async () => true, { now: () => times.shift() ?? 5 })).resolves.toMatchObject({
      status: 'healthy', checkedAt: 5, durationMs: 0,
    });
  });
});

describe('replicationLagMonitor (357)', () => {
  it('compares adapter-supplied replication lag with the configured threshold', async () => {
    await expect(replicationLagMonitor({ getReplicationLagMs: async () => 25 }, { thresholdMs: 50 })).resolves.toEqual({ status: 'healthy', lagMs: 25, thresholdMs: 50 });
    await expect(replicationLagMonitor({ getReplicationLagMs: async () => 80 }, { thresholdMs: 50 })).resolves.toMatchObject({ status: 'lagging' });
    await expect(replicationLagMonitor({ getReplicationLagMs: async () => null }, { thresholdMs: 50 })).resolves.toMatchObject({ status: 'unknown' });
  });
});

describe('dbConnectionRetry (358)', () => {
  it('retries only explicitly idempotent work on transient connection errors', async () => {
    let attempts = 0;
    const delays: number[] = [];
    await expect(dbConnectionRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      return 'connected';
    }, { idempotent: true, maxAttempts: 3, baseDelayMs: 5, sleep: async ms => { delays.push(ms); } })).resolves.toBe('connected');
    expect(attempts).toBe(2);
    expect(delays).toEqual([5]);

    let writes = 0;
    await expect(dbConnectionRetry(async () => { writes += 1; throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }, { maxAttempts: 3 })).rejects.toThrow('reset');
    expect(writes).toBe(1);
  });
});

describe('queryResultCacher (359)', () => {
  it('caches read results by query and bindings, expires entries, and rejects writes', async () => {
    let now = 0;
    let calls = 0;
    const cache = queryResultCacher(async () => ({ rows: [{ value: ++calls }] }), { ttlMs: 10, now: () => now });
    const first = await cache.query('SELECT value FROM items WHERE id = ?', [1]);
    (first.rows as Array<{ value: number }>).push({ value: 99 });
    const second = await cache.query('SELECT value FROM items WHERE id = ?', [1]);
    expect(second).toEqual({ rows: [{ value: 1 }] });
    expect(calls).toBe(1);
    await cache.query('SELECT value FROM items WHERE id = ?', [2]);
    expect(calls).toBe(2);
    now = 11;
    await cache.query('SELECT value FROM items WHERE id = ?', [1]);
    expect(calls).toBe(3);
    await expect(cache.query('DELETE FROM items WHERE id = ?', [1])).rejects.toThrow(/read-only/i);
  });

  it('coalesces concurrent identical reads and caps the cache at its configured size', async () => {
    let calls = 0;
    let release!: (value: { result: number }) => void;
    const pending = new Promise<{ result: number }>(resolve => { release = resolve; });
    const cache = queryResultCacher(async () => { calls += 1; return pending; }, { ttlMs: 100, maxEntries: 1 });
    const first = cache.query('SELECT value FROM items WHERE id = ?', [1]);
    const second = cache.query('SELECT value FROM items WHERE id = ?', [1]);
    await Promise.resolve();
    expect(calls).toBe(1);
    release({ result: 1 });
    await expect(Promise.all([first, second])).resolves.toEqual([{ result: 1 }, { result: 1 }]);
    await cache.query('SELECT value FROM items WHERE id = ?', [2]);
    expect(cache.stats()).toMatchObject({ size: 1, hits: 1, misses: 2 });
  });
});

describe('dbAccessAuditLogger (360)', () => {
  it('records safe query metadata, never parameter values, and logs failures before rethrowing', async () => {
    const records: Array<Record<string, unknown>> = [];
    const query = dbAccessAuditLogger(async (sql: string) => {
      if (sql.startsWith('DELETE')) throw Object.assign(new Error('password=private'), { code: 'ECONNRESET' });
      return 'ok';
    }, record => { records.push(record as unknown as Record<string, unknown>); }, { actor: 'agent', now: () => 123 });
    await expect(query('SELECT * FROM users WHERE token = ?', ['secret-value'])).resolves.toBe('ok');
    await expect(query('DELETE FROM users WHERE id = ?', [4])).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ actor: 'agent', operation: 'SELECT', success: true, timestamp: 123 });
    expect(records[1]).toMatchObject({ operation: 'DELETE', success: false });
    expect(JSON.stringify(records)).not.toContain('secret-value');
    expect(JSON.stringify(records)).not.toContain('private');
    expect(records[0].queryHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
