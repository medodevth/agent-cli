import { createHash } from 'node:crypto';

/** Compatibility shape for lightweight connection adapters. */
export interface DbConnection {
  [key: string]: unknown;
}

export interface DbConnectionAdapter<T extends object> {
  create: () => T | Promise<T>;
  destroy: (connection: T) => void | Promise<void>;
}

export interface DbPool<T extends object> {
  acquire: () => Promise<T>;
  release: (connection: T) => Promise<void>;
  close: () => Promise<void>;
  stats: () => { size: number; inUse: number; idle: number; waiting: number; closed: boolean };
}

/** 341. Bounded connection pool whose only database-specific work is injected. */
export function dbConnectionPool<T extends object>(
  adapter: DbConnectionAdapter<T>,
  options: { maxSize: number }
): DbPool<T> {
  if (!Number.isInteger(options.maxSize) || options.maxSize < 1) {
    throw new Error('maxSize must be a positive integer');
  }
  const idle: T[] = [];
  const checkedOut = new Set<T>();
  const destroyed = new WeakSet<object>();
  const waiters: Array<{ resolve: (connection: T) => void; reject: (error: Error) => void }> = [];
  const pendingCreations = new Set<Promise<void>>();
  let size = 0;
  let closed = false;

  const trackCreation = (creation: Promise<T>): Promise<T> => {
    const tracked = creation.then(() => undefined, () => undefined);
    pendingCreations.add(tracked);
    void tracked.then(() => pendingCreations.delete(tracked));
    return creation;
  };

  const createReservedConnection = async (): Promise<T> => {
    let connection: T;
    try {
      connection = await adapter.create();
    } catch (error) {
      size -= 1;
      dispatchWaiters();
      throw error;
    }
    if (closed) {
      size -= 1;
      await adapter.destroy(connection);
      throw new Error('Connection pool is closed');
    }
    if (checkedOut.has(connection) || idle.includes(connection)) {
      size -= 1;
      throw new Error('Connection adapter returned an already pooled connection');
    }
    checkedOut.add(connection);
    return connection;
  };

  const createForWaiter = (waiter: (typeof waiters)[number]): void => {
    size += 1;
    const creation = trackCreation(createReservedConnection());
    void creation.then(waiter.resolve, error => {
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
    });
  };

  function dispatchWaiters(): void {
    while (!closed && size < options.maxSize && waiters.length > 0) {
      const waiter = waiters.shift()!;
      createForWaiter(waiter);
    }
  }

  const acquire = async (): Promise<T> => {
    if (closed) throw new Error('Connection pool is closed');
    const reused = idle.pop();
    if (reused) {
      checkedOut.add(reused);
      return reused;
    }
    if (size < options.maxSize) {
      size += 1;
      return trackCreation(createReservedConnection());
    }
    return new Promise<T>((resolve, reject) => waiters.push({ resolve, reject }));
  };

  const release = async (connection: T): Promise<void> => {
    if (!checkedOut.delete(connection)) {
      if (closed && destroyed.has(connection)) return;
      throw new Error('Connection is not checked out or has already been released');
    }
    if (closed) {
      size -= 1;
      destroyed.add(connection);
      await adapter.destroy(connection);
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      checkedOut.add(connection);
      waiter.resolve(connection);
      return;
    }
    idle.push(connection);
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('Connection pool is closed'));
    const failures: unknown[] = [];
    await Promise.all(idle.splice(0).map(async connection => {
      size -= 1;
      destroyed.add(connection);
      try { await adapter.destroy(connection); } catch (error) { failures.push(error); }
    }));
    // Checked-out connections are destroyed only when their owner releases them;
    // close must not invalidate a connection while a caller is still using it.
    await Promise.all([...pendingCreations]);
    if (failures.length > 0) throw new AggregateError(failures, 'One or more pooled connections could not be destroyed');
  };

  return {
    acquire,
    release,
    close,
    stats: () => ({ size, inUse: checkedOut.size, idle: idle.length, waiting: waiters.length, closed }),
  };
}

export type DbQueryExecutor<T> = (sql: string, parameters?: readonly unknown[]) => T | Promise<T>;

export interface SqlToken {
  kind: 'word' | 'identifier' | 'placeholder' | 'literal' | 'symbol';
  value: string;
  position: number;
}

interface SqlAnalysis {
  tokens: SqlToken[];
  questionPlaceholders: number;
  numberedPlaceholders: number[];
  semicolonPositions: number[];
}

interface SqlScanOptions {
  allowComments?: boolean;
}

function scanSql(sql: string, options: SqlScanOptions = {}): SqlAnalysis {
  if (typeof sql !== 'string' || sql.trim() === '') throw new Error('SQL must be a non-empty string');
  const tokens: SqlToken[] = [];
  const semicolonPositions: number[] = [];
  const numberedPlaceholders: number[] = [];
  let questionPlaceholders = 0;
  let index = 0;

  const push = (kind: SqlToken['kind'], value: string, position: number): void => {
    tokens.push({ kind, value, position });
  };

  while (index < sql.length) {
    const char = sql[index];
    if (/\s/.test(char)) { index += 1; continue; }

    if (char === '-' && sql[index + 1] === '-') {
      if (!options.allowComments) throw new Error('SQL comments are not allowed');
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index += 1;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      if (!options.allowComments) throw new Error('SQL comments are not allowed');
      index += 2;
      let depth = 1;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') { depth += 1; index += 2; }
        else if (sql[index] === '*' && sql[index + 1] === '/') { depth -= 1; index += 2; }
        else index += 1;
      }
      if (depth !== 0) throw new Error('Unterminated SQL comment');
      continue;
    }

    if (char === "'") {
      const start = index++;
      let terminated = false;
      while (index < sql.length) {
        if (sql[index] === '\\' && index + 1 < sql.length) { index += 2; continue; }
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") { index += 2; continue; }
          index += 1;
          terminated = true;
          break;
        }
        index += 1;
      }
      if (!terminated) throw new Error(`Unterminated SQL string at ${start}`);
      push('literal', '?', start);
      continue;
    }

    if (char === '"' || char === '`' || char === '[') {
      const start = index;
      const closing = char === '[' ? ']' : char;
      index += 1;
      let terminated = false;
      while (index < sql.length) {
        if (sql[index] === closing) {
          if (sql[index + 1] === closing) { index += 2; continue; }
          index += 1;
          terminated = true;
          break;
        }
        index += 1;
      }
      if (!terminated) throw new Error(`Unterminated quoted SQL identifier at ${start}`);
      push('identifier', sql.slice(start, index), start);
      continue;
    }

    if (char === '$') {
      const dollarQuote = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index));
      if (dollarQuote) {
        const start = index;
        const delimiter = dollarQuote[0];
        const end = sql.indexOf(delimiter, index + delimiter.length);
        if (end === -1) throw new Error(`Unterminated dollar-quoted SQL string at ${start}`);
        index = end + delimiter.length;
        push('literal', '?', start);
        continue;
      }
      const placeholder = /^\$(\d+)/.exec(sql.slice(index));
      if (placeholder) {
        const number = Number(placeholder[1]);
        if (!Number.isSafeInteger(number) || number < 1) throw new Error('Numbered SQL placeholders start at $1');
        numberedPlaceholders.push(number);
        push('placeholder', '?', index);
        index += placeholder[0].length;
        continue;
      }
    }

    if (char === '?') {
      questionPlaceholders += 1;
      push('placeholder', '?', index);
      index += 1;
      continue;
    }

    if (char === ';') {
      semicolonPositions.push(index);
      push('symbol', ';', index);
      index += 1;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      const start = index++;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index])) index += 1;
      push('word', sql.slice(start, index), start);
      continue;
    }

    if (/[0-9]/.test(char) && (index === 0 || !/[A-Za-z_$]/.test(sql[index - 1]))) {
      const start = index;
      const numeric = /^(?:0[xX][0-9A-Fa-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(sql.slice(index));
      if (numeric) {
        index += numeric[0].length;
        push('literal', '?', start);
        continue;
      }
    }

    push('symbol', char, index);
    index += 1;
  }

  if (tokens.length === 0) throw new Error('SQL must contain a statement');
  if (questionPlaceholders > 0 && numberedPlaceholders.length > 0) {
    throw new Error('Do not mix positional and numbered SQL placeholders');
  }
  return { tokens, questionPlaceholders, numberedPlaceholders, semicolonPositions };
}

function normalizeSingleStatement(sql: string, analysis: SqlAnalysis): string {
  if (analysis.semicolonPositions.length > 1) throw new Error('Only a single SQL statement is allowed; multiple statements were found');
  if (analysis.semicolonPositions.length === 0) return sql.trim();
  const semicolon = analysis.semicolonPositions[0];
  if (analysis.tokens.at(-1)?.position !== semicolon) {
    throw new Error('Only a single SQL statement is allowed; multiple statements were found');
  }
  const statement = sql.slice(0, semicolon).trim();
  if (!statement) throw new Error('SQL must contain a statement before its trailing semicolon');
  return statement;
}

function validateBindings(analysis: SqlAnalysis, parameters: readonly unknown[]): void {
  if (analysis.questionPlaceholders > 0) {
    if (analysis.questionPlaceholders !== parameters.length) {
      throw new Error(`SQL parameter count mismatch: expected ${analysis.questionPlaceholders}, received ${parameters.length}`);
    }
    return;
  }
  if (analysis.numberedPlaceholders.length > 0) {
    const highest = Math.max(...analysis.numberedPlaceholders);
    const referenced = new Set(analysis.numberedPlaceholders);
    if (highest !== parameters.length || referenced.size !== highest) {
      throw new Error(`SQL parameter count mismatch: numbered placeholders must reference $1 through $${parameters.length}`);
    }
    return;
  }
  if (parameters.length > 0) throw new Error(`SQL parameter count mismatch: query has no placeholders for ${parameters.length} parameter(s)`);
}

/** 343. Validate a single statement and parameter bindings without interpolating values into SQL. */
export function sqlInjectionSanitizer(
  sql: string,
  parameters: readonly unknown[] = []
): { sql: string; parameters: unknown[] } {
  if (!Array.isArray(parameters)) throw new Error('SQL parameters must be an array');
  const analysis = scanSql(sql);
  const statement = normalizeSingleStatement(sql, analysis);
  validateBindings(analysis, parameters);
  return { sql: statement, parameters: [...parameters] };
}

const MUTATING_SQL_WORDS = new Set([
  'ALTER', 'ATTACH', 'BEGIN', 'CALL', 'COMMIT', 'COPY', 'CREATE', 'DEALLOCATE', 'DELETE', 'DETACH',
  'DO', 'DROP', 'EXEC', 'EXECUTE', 'GRANT', 'INSERT', 'LOCK', 'MERGE', 'PRAGMA', 'PREPARE',
  'REINDEX', 'RELEASE', 'REPLACE', 'RESET', 'REVOKE', 'ROLLBACK', 'SAVEPOINT', 'SET', 'TRUNCATE',
  'UPDATE', 'VACUUM',
]);
const SIDE_EFFECT_SQL_FUNCTIONS = new Set(['NEXTVAL', 'SETVAL', 'PG_ADVISORY_LOCK', 'PG_TRY_ADVISORY_LOCK', 'LOAD_EXTENSION']);

function assertReadOnly(sql: string, parameters: readonly unknown[]): { sql: string; parameters: unknown[]; analysis: SqlAnalysis } {
  const safe = sqlInjectionSanitizer(sql, parameters);
  const analysis = scanSql(safe.sql);
  const words = analysis.tokens.filter(token => token.kind === 'word').map(token => token.value.toUpperCase());
  const first = words[0];
  if (!['SELECT', 'WITH', 'VALUES', 'SHOW'].includes(first ?? '')) {
    throw new Error('Read-only mode permits only SELECT, WITH, VALUES, or SHOW statements');
  }
  const mutating = words.find(word => MUTATING_SQL_WORDS.has(word));
  if (mutating) throw new Error(`Read-only query rejected mutating SQL keyword ${mutating}`);
  if (words.includes('INTO')) throw new Error('Read-only query rejected SELECT INTO');
  for (let index = 0; index < analysis.tokens.length - 1; index += 1) {
    const current = analysis.tokens[index];
    const next = analysis.tokens[index + 1];
    if (current.kind === 'word' && SIDE_EFFECT_SQL_FUNCTIONS.has(current.value.toUpperCase()) && next.value === '(') {
      throw new Error(`Read-only query rejected side-effect function ${current.value}`);
    }
    if (current.kind === 'word' && current.value.toUpperCase() === 'FOR' &&
      (['UPDATE', 'SHARE', 'NO'].includes(next.value.toUpperCase()) ||
        next.value.toUpperCase() === 'KEY' && analysis.tokens[index + 2]?.value.toUpperCase() === 'SHARE')) {
      throw new Error('Read-only query rejected a locking SELECT');
    }
  }
  return { ...safe, analysis };
}

/** 342. Wrap an injected executor with a fail-closed read-only SQL policy. */
export function readOnlyQueryEnforcer<T>(executor: DbQueryExecutor<T>): DbQueryExecutor<T> {
  if (typeof executor !== 'function') throw new Error('A query executor adapter is required');
  return async (sql, parameters = []) => {
    const safe = assertReadOnly(sql, parameters);
    return await executor(safe.sql, safe.parameters);
  };
}

export interface DatabaseMigration {
  id: string;
  [key: string]: unknown;
}

export interface MigrationAdapter<M extends DatabaseMigration> {
  getAppliedMigrations: () => readonly string[] | Promise<readonly string[]>;
  applyMigration: (migration: M) => void | Promise<void>;
}

export interface MigrationRunResult {
  applied: string[];
  skipped: string[];
  pending: string[];
  dryRun: boolean;
}

/** 344. Inspect migration state through an adapter; dryRun reports pending work without applying it. */
export async function migrationRunner<M extends DatabaseMigration>(
  migrations: readonly M[],
  adapter: MigrationAdapter<M>,
  options: { dryRun?: boolean } = {}
): Promise<MigrationRunResult> {
  const ids = migrations.map(migration => migration.id);
  if (ids.some(id => typeof id !== 'string' || id.trim() === '')) throw new Error('Migration ids must be non-empty strings');
  if (new Set(ids).size !== ids.length) throw new Error('Migration ids must be unique');
  if (typeof adapter?.getAppliedMigrations !== 'function' || typeof adapter.applyMigration !== 'function') {
    throw new Error('Migration database adapter is required');
  }
  const appliedIds = new Set(await adapter.getAppliedMigrations());
  const skipped = ids.filter(id => appliedIds.has(id));
  const pendingMigrations = migrations.filter(migration => !appliedIds.has(migration.id));
  const dryRun = options.dryRun ?? false;
  if (dryRun) return { applied: [], skipped, pending: pendingMigrations.map(migration => migration.id), dryRun: true };
  const applied: string[] = [];
  for (const migration of pendingMigrations) {
    await adapter.applyMigration(migration);
    applied.push(migration.id);
  }
  return { applied, skipped, pending: [], dryRun: false };
}

export interface DbColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue?: unknown;
  primaryKey?: boolean;
  [key: string]: unknown;
}

export interface DbTableSchema {
  table: string;
  columns: DbColumn[];
}

const SQL_IDENTIFIER_PATH = /^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*$/;

function requireTableIdentifier(table: string): string {
  if (typeof table !== 'string' || !SQL_IDENTIFIER_PATH.test(table)) {
    throw new Error('Table name must be a dot-separated SQL identifier');
  }
  return table;
}

/** 345. Read table metadata through an injected schema adapter and return a defensive copy. */
export async function schemaIntrospector(
  table: string,
  describeTable: (table: string) => Promise<readonly DbColumn[]> | readonly DbColumn[]
): Promise<DbTableSchema> {
  const safeTable = requireTableIdentifier(table);
  if (typeof describeTable !== 'function') throw new Error('Schema introspection adapter is required');
  const columns = await describeTable(safeTable);
  if (!Array.isArray(columns)) throw new Error('Schema adapter must return a column array');
  const seen = new Set<string>();
  const snapshot = columns.map(column => {
    if (!column || typeof column.name !== 'string' || column.name.length === 0 || typeof column.dataType !== 'string' ||
      typeof column.nullable !== 'boolean') {
      throw new Error('Schema adapter returned invalid column metadata');
    }
    if (seen.has(column.name)) throw new Error(`Schema adapter returned duplicate column '${column.name}'`);
    seen.add(column.name);
    return structuredClone(column);
  });
  return { table: safeTable, columns: snapshot };
}

export interface QueryPage<T> {
  items: readonly T[];
  total: number;
}

export interface QueryPageRequest {
  limit: number;
  offset: number;
}

export interface QueryPageResult<T> {
  items: T[];
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
  nextOffset?: number;
}

/** 346. Fetch one bounded page through an injected query adapter, avoiding offsets that cannot progress. */
export async function queryResultPaginator<T>(
  fetchPage: (request: QueryPageRequest) => Promise<QueryPage<T>> | QueryPage<T>,
  options: QueryPageRequest & { maxLimit?: number }
): Promise<QueryPageResult<T>> {
  const maxLimit = options.maxLimit ?? 1_000;
  if (!Number.isInteger(maxLimit) || maxLimit < 1) throw new Error('maxLimit must be a positive integer');
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > maxLimit) {
    throw new Error(`limit must be an integer between 1 and ${maxLimit}`);
  }
  if (!Number.isSafeInteger(options.offset) || options.offset < 0) throw new Error('offset must be a non-negative safe integer');
  if (typeof fetchPage !== 'function') throw new Error('Page query adapter is required');
  const page = await fetchPage({ limit: options.limit, offset: options.offset });
  if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < 0) {
    throw new Error('Page query adapter returned an invalid page');
  }
  if (page.items.length > options.limit) throw new Error('Page query adapter exceeded the requested limit');
  if (page.items.length > 0 && options.offset + page.items.length > page.total) throw new Error('Page query adapter returned more items than its total');
  if (page.items.length === 0 && options.offset < page.total) {
    throw new Error('Page query adapter returned an empty page before the reported total');
  }
  const nextOffset = options.offset + page.items.length;
  const hasMore = nextOffset < page.total;
  return {
    items: [...page.items],
    limit: options.limit,
    offset: options.offset,
    total: page.total,
    hasMore,
    ...(hasMore ? { nextOffset } : {}),
  };
}

export interface TransactionAdapter<TTransaction> {
  begin: () => Promise<TTransaction> | TTransaction;
  commit: (transaction: TTransaction) => Promise<void> | void;
  rollback: (transaction: TTransaction) => Promise<void> | void;
}

/** 347. Run an operation in an adapter-provided transaction with commit/rollback guarantees. */
export async function transactionWrapper<TTransaction, TResult>(
  adapter: TransactionAdapter<TTransaction>,
  operation: (transaction: TTransaction) => TResult | Promise<TResult>
): Promise<TResult> {
  if (!adapter || typeof adapter.begin !== 'function' || typeof adapter.commit !== 'function' || typeof adapter.rollback !== 'function') {
    throw new Error('Transaction adapter must provide begin, commit, and rollback');
  }
  const transaction = await adapter.begin();
  try {
    const result = await operation(transaction);
    await adapter.commit(transaction);
    return result;
  } catch (error) {
    try {
      await adapter.rollback(transaction);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Transaction failed and rollback also failed', { cause: error });
    }
    throw error;
  }
}

/** 348. Require a successful, caller-supplied backup before invoking a migration operation. */
export async function dbBackupBeforeMigration<TBackup, TResult>(
  backup: () => TBackup | Promise<TBackup>,
  migrate: (backupResult: TBackup) => TResult | Promise<TResult>
): Promise<{ backup: TBackup; result: TResult }> {
  if (typeof backup !== 'function' || typeof migrate !== 'function') throw new Error('Backup and migration adapters are required');
  const backupResult = await backup();
  if (backupResult === undefined || backupResult === null || backupResult === false || backupResult === '') {
    throw new Error('Backup adapter did not confirm a completed backup');
  }
  const result = await migrate(backupResult);
  return { backup: backupResult, result };
}

const SECRET_CONNECTION_KEYS = /(?:pass(?:word|wd)?|pwd|user(?:name)?|auth(?:orization)?|token|secret|api[_-]?key|access[_-]?key|credential|ssl[_-]?key|private[_-]?key)/i;

function maskUrlQuery(url: URL): void {
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_CONNECTION_KEYS.test(key)) url.searchParams.set(key, '[REDACTED]');
  }
}

/** 349. Mask usernames, passwords, and secret URL/DSN fields before a connection string is logged. */
export function connectionStringMasker(connectionString: string): string {
  if (typeof connectionString !== 'string') throw new Error('connectionString must be a string');
  const input = connectionString.trim();
  if (!input) return input;
  const jdbcPrefix = input.startsWith('jdbc:') ? 'jdbc:' : '';
  const candidate = jdbcPrefix ? input.slice(5) : input;
  try {
    const url = new URL(candidate);
    if (url.username) url.username = '[REDACTED]';
    if (url.password) url.password = '[REDACTED]';
    maskUrlQuery(url);
    return `${jdbcPrefix}${url.toString().replace(/%5BREDACTED%5D/gi, '[REDACTED]')}`;
  } catch {
    // Keyword/value DSNs are not URLs. Parse quoted values to preserve spaces safely.
  }
  const keywordPattern = /(^|\s)([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"]|"")*)"|'((?:[^']|'')*)'|([^\s]*))/g;
  let masked = input.replace(keywordPattern, (whole, prefix: string, key: string, doubleQuoted: string | undefined, singleQuoted: string | undefined) => {
    if (!SECRET_CONNECTION_KEYS.test(key)) return whole;
    const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : '';
    return `${prefix}${key}=${quote}[REDACTED]${quote}`;
  });
  masked = masked
    .replace(/(\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[REDACTED]@')
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|credential)\s*([=:])\s*(?:"[^"]*"|'[^']*'|[^\s&;]+)/gi, '$1$2[REDACTED]');
  return masked;
}

export class DbQueryTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(readonly timeoutMs: number) {
    super(`Database query exceeded ${timeoutMs}ms`);
    this.name = 'DbQueryTimeoutError';
  }
}

/** 350. Bound an injected query operation and abort adapters that honor AbortSignal. */
export function dbQueryTimeout<T>(
  operation: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
  options: { signal?: AbortSignal } = {}
): Promise<T> {
  if (typeof operation !== 'function') return Promise.reject(new Error('Query operation adapter is required'));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('timeoutMs must be a positive finite number'));
  if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error('Database query aborted'));

  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      const reason = options.signal?.reason ?? new Error('Database query aborted');
      controller.abort(reason);
      finish(() => reject(reason));
    };
    const timer = setTimeout(() => {
      const error = new DbQueryTimeoutError(timeoutMs);
      controller.abort(error);
      finish(() => reject(error));
    }, timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => operation(controller.signal)).then(
      result => finish(() => resolve(result)),
      error => finish(() => reject(error))
    );
  });
}

const TYPESCRIPT_RESERVED = new Set([
  'abstract', 'any', 'as', 'asserts', 'async', 'await', 'bigint', 'boolean', 'break', 'case', 'catch',
  'class', 'const', 'constructor', 'continue', 'debugger', 'declare', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements',
  'import', 'in', 'infer', 'instanceof', 'interface', 'is', 'keyof', 'let', 'module', 'namespace', 'never',
  'new', 'null', 'number', 'object', 'package', 'private', 'protected', 'public', 'readonly', 'require',
  'return', 'set', 'static', 'string', 'super', 'switch', 'symbol', 'this', 'throw', 'true', 'try', 'type',
  'typeof', 'undefined', 'unique', 'unknown', 'var', 'void', 'while', 'with', 'yield',
]);

function pascalCase(value: string): string {
  const words = value.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
  const name = words.map(word => word[0].toUpperCase() + word.slice(1)).join('');
  return /^[A-Za-z_$]/.test(name) ? name : `Model${name}`;
}

function safePropertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !TYPESCRIPT_RESERVED.has(name)
    ? name
    : `[${JSON.stringify(name)}]`;
}

function typescriptTypeForDatabaseType(type: string): string {
  const normalized = type.toLowerCase().trim();
  if (/^(?:bool|boolean)$/.test(normalized)) return 'boolean';
  if (/^(?:tinyint|smallint|int|integer|serial|smallserial|mediumint|float|real|double|decimal|numeric|number|bigint|bigserial|money)(?:\b|\().*$/.test(`${normalized} `)) return 'number';
  if (/^(?:date|time|timestamp|datetime)(?:\b|\().*$/.test(`${normalized} `)) return 'Date';
  if (/^(?:json|jsonb|unknown|bytea|blob|binary|varbinary)(?:\b|\().*$/.test(`${normalized} `)) return 'unknown';
  if (/^(?:array|.*\[\])$/.test(normalized)) return 'unknown[]';
  if (/^(?:char|character|varchar|nvarchar|text|string|uuid|enum|citext)(?:\b|\().*$/.test(`${normalized} `)) return 'string';
  return 'unknown';
}

/** 351. Generate TypeScript interface text from schema metadata without loading an ORM or touching a database. */
export function ormModelGenerator(
  schema: DbTableSchema,
  options: { modelName?: string } = {}
): string {
  const table = requireTableIdentifier(schema.table);
  if (!Array.isArray(schema.columns)) throw new Error('Schema columns must be an array');
  const defaultName = pascalCase(table.split('.').at(-1) ?? 'Model');
  const modelName = options.modelName ?? defaultName;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(modelName) || TYPESCRIPT_RESERVED.has(modelName)) {
    throw new Error('modelName must be a non-reserved TypeScript identifier');
  }
  const seen = new Set<string>();
  const properties = schema.columns.map(column => {
    if (!column || typeof column.name !== 'string' || column.name.length === 0 || typeof column.dataType !== 'string' || typeof column.nullable !== 'boolean') {
      throw new Error('Schema contains invalid column metadata');
    }
    if (seen.has(column.name)) throw new Error(`Schema contains duplicate column '${column.name}'`);
    seen.add(column.name);
    const type = typescriptTypeForDatabaseType(column.dataType);
    const propertyName = safePropertyName(column.name);
    return `  ${propertyName}: ${type}${column.nullable ? ' | null' : ''};`;
  });
  return `/** Generated from ${table}. */\nexport interface ${modelName} {\n${properties.join('\n')}\n}\n`;
}

export interface IndexUsage {
  indexName: string;
  scans: number;
}

/** 352. Summarize caller-supplied index counters without querying or changing database state. */
export function indexUsageAnalyzer(indexes: readonly IndexUsage[]): {
  totalIndexes: number;
  totalScans: number;
  usedIndexes: string[];
  unusedIndexes: string[];
} {
  const seen = new Set<string>();
  let totalScans = 0;
  const usedIndexes: string[] = [];
  const unusedIndexes: string[] = [];
  for (const index of indexes) {
    if (!index || typeof index.indexName !== 'string' || index.indexName.trim() === '') throw new Error('indexName must be non-empty');
    if (!Number.isSafeInteger(index.scans) || index.scans < 0) throw new Error('index scans must be a non-negative safe integer');
    if (seen.has(index.indexName)) throw new Error(`duplicate index name '${index.indexName}'`);
    seen.add(index.indexName);
    totalScans += index.scans;
    (index.scans > 0 ? usedIndexes : unusedIndexes).push(index.indexName);
  }
  return { totalIndexes: indexes.length, totalScans, usedIndexes, unusedIndexes };
}

export interface SlowQuerySample {
  sql: string;
  durationMs: number;
}

export interface SlowQueryFinding extends SlowQuerySample {
  normalizedSql: string;
  fingerprint: string;
}

/** 353. Find threshold-crossing query samples and redact literals from output/fingerprints. */
export function slowQueryDetector(
  queries: readonly SlowQuerySample[],
  options: { thresholdMs: number }
): SlowQueryFinding[] {
  if (!Number.isFinite(options.thresholdMs) || options.thresholdMs < 0) throw new Error('thresholdMs must be a non-negative finite number');
  return queries.filter(query => {
    if (!query || typeof query.sql !== 'string' || !Number.isFinite(query.durationMs) || query.durationMs < 0) {
      throw new Error('Slow-query samples must contain SQL and a non-negative finite duration');
    }
    return query.durationMs >= options.thresholdMs;
  }).map(query => {
    const analysis = scanSql(query.sql, { allowComments: true });
    const normalizedSql = analysis.tokens.map(token => token.kind === 'literal' || token.kind === 'placeholder' ? '?' : token.value).join(' ');
    const fingerprint = createHash('sha256').update(normalizedSql).digest('hex');
    return { sql: normalizedSql, durationMs: query.durationMs, normalizedSql, fingerprint };
  });
}

export interface SeedDataAdapter {
  insertMany: (table: string, rows: readonly Record<string, unknown>[]) => Promise<number> | number;
}

/** 354. Plan seed inserts by default; apply requires an explicit flag and injected database adapter. */
export async function dbSeedDataLoader(
  table: string,
  rows: readonly Record<string, unknown>[],
  options: { apply?: boolean; adapter?: SeedDataAdapter } = {}
): Promise<{ table: string; plannedCount: number; insertedCount: number; applied: boolean }> {
  const safeTable = requireTableIdentifier(table);
  if (!Array.isArray(rows)) throw new Error('Seed rows must be an array');
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Each seed row must be an object');
  }
  if (options.apply !== true) return { table: safeTable, plannedCount: rows.length, insertedCount: 0, applied: false };
  if (!options.adapter || typeof options.adapter.insertMany !== 'function') throw new Error('Applying seed data requires an insertMany adapter');
  const insertedCount = await options.adapter.insertMany(safeTable, structuredClone(rows));
  if (!Number.isSafeInteger(insertedCount) || insertedCount < 0 || insertedCount > rows.length) {
    throw new Error('Seed adapter returned an invalid inserted row count');
  }
  return { table: safeTable, plannedCount: rows.length, insertedCount, applied: true };
}

export interface QueryPlanAdapter<TPlan> {
  explain: (sql: string, parameters: readonly unknown[], options: { analyze: false }) => TPlan | Promise<TPlan>;
}

/** 355. Explain a read-only parameterized query; ANALYZE is permanently disabled to avoid running it. */
export async function queryPlanExplainer<TPlan>(
  sql: string,
  parameters: readonly unknown[],
  adapter: QueryPlanAdapter<TPlan>
): Promise<TPlan> {
  const safe = assertReadOnly(sql, parameters);
  if (!adapter || typeof adapter.explain !== 'function') throw new Error('Query-plan adapter is required');
  return adapter.explain(safe.sql, safe.parameters, { analyze: false });
}

export interface DbHealthReport {
  status: 'healthy' | 'unhealthy';
  checkedAt: number;
  durationMs: number;
  error?: string;
}

/** 356. Run only a caller-supplied health probe and return a secret-safe status report. */
export async function dbHealthCheck(
  probe: () => boolean | void | Promise<boolean | void>,
  options: { now?: () => number } = {}
): Promise<DbHealthReport> {
  if (typeof probe !== 'function') throw new Error('Database health probe adapter is required');
  const now = options.now ?? Date.now;
  const started = now();
  let healthy = false;
  try { healthy = (await probe()) !== false; } catch { healthy = false; }
  const checkedAt = now();
  return {
    status: healthy ? 'healthy' : 'unhealthy',
    checkedAt,
    durationMs: Math.max(0, checkedAt - started),
    ...(healthy ? {} : { error: 'Database health probe failed' }),
  };
}

export interface ReplicationLagAdapter {
  getReplicationLagMs: () => number | null | undefined | Promise<number | null | undefined>;
}

/** 357. Classify lag reported by a replication adapter; does not assume units or probe a server. */
export async function replicationLagMonitor(
  adapter: ReplicationLagAdapter,
  options: { thresholdMs: number }
): Promise<{ status: 'healthy' | 'lagging' | 'unknown'; lagMs?: number; thresholdMs: number }> {
  if (!Number.isFinite(options.thresholdMs) || options.thresholdMs < 0) throw new Error('thresholdMs must be a non-negative finite number');
  if (!adapter || typeof adapter.getReplicationLagMs !== 'function') throw new Error('Replication-lag adapter is required');
  const lagMs = await adapter.getReplicationLagMs();
  if (lagMs === null || lagMs === undefined) return { status: 'unknown', thresholdMs: options.thresholdMs };
  if (!Number.isFinite(lagMs) || lagMs < 0) throw new Error('Replication lag must be a non-negative finite number');
  return { status: lagMs > options.thresholdMs ? 'lagging' : 'healthy', lagMs, thresholdMs: options.thresholdMs };
}

const TRANSIENT_DB_CODES = new Set([
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENETDOWN', 'ENETUNREACH', '57P01', '57P02', '57P03', '08000', '08003', '08006', '08001', '08004',
]);

function transientDatabaseError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && TRANSIENT_DB_CODES.has(code.toUpperCase());
}

/** 358. Retry a failed operation only when explicitly declared idempotent and the error is transient. */
export async function dbConnectionRetry<T>(
  operation: (attempt: number) => T | Promise<T>,
  options: {
    idempotent?: boolean;
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {}
): Promise<T> {
  if (typeof operation !== 'function') throw new Error('Database operation adapter is required');
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer');
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0 || !Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new Error('Retry delays must be non-negative finite numbers');
  }
  const attemptsAllowed = options.idempotent === true ? maxAttempts : 1;
  const sleep = options.sleep ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; ; attempt += 1) {
    try { return await operation(attempt); }
    catch (error) {
      if (attempt >= attemptsAllowed || !transientDatabaseError(error)) throw error;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(delay);
    }
  }
}

function stableSerialize(value: unknown, stack = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Query parameters must contain only finite numbers');
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'undefined') return 'undefined';
  if (typeof value === 'bigint') return `bigint:${value.toString()}`;
  if (typeof value !== 'object') throw new Error(`Unsupported query parameter type: ${typeof value}`);
  if (stack.has(value)) throw new Error('Query parameters must not be circular');
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('Invalid date query parameter');
    return `date:${value.toISOString()}`;
  }
  if (Buffer.isBuffer(value)) return `buffer:${value.toString('base64')}`;
  stack.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map(item => stableSerialize(item, stack)).join(',')}]`;
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new Error('Query parameters must use plain objects');
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(record[key], stack)}`).join(',')}}`;
  } finally {
    stack.delete(value);
  }
}

export interface QueryResultCache<T> {
  query: DbQueryExecutor<T>;
  clear: () => void;
  stats: () => { size: number; hits: number; misses: number };
}

/** 359. Cache cloned, read-only query results in bounded memory with explicit TTL and injected time. */
export function queryResultCacher<T>(
  executor: DbQueryExecutor<T>,
  options: { ttlMs: number; maxEntries?: number; now?: () => number }
): QueryResultCache<T> {
  if (typeof executor !== 'function') throw new Error('Query executor adapter is required');
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) throw new Error('ttlMs must be a positive finite number');
  const maxEntries = options.maxEntries ?? 1_000;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('maxEntries must be a positive integer');
  const now = options.now ?? Date.now;
  const entries = new Map<string, { expiresAt: number; result: T }>();
  const pending = new Map<string, Promise<T>>();
  let hits = 0;
  let misses = 0;

  const query: DbQueryExecutor<T> = async (sql, parameters = []) => {
    const safe = assertReadOnly(sql, parameters);
    const payload = `${safe.sql}\n${stableSerialize(safe.parameters)}`;
    const key = createHash('sha256').update(payload).digest('hex');
    const currentTime = now();
    const found = entries.get(key);
    if (found && found.expiresAt > currentTime) {
      entries.delete(key);
      entries.set(key, found);
      hits += 1;
      return structuredClone(found.result);
    }
    if (found) entries.delete(key);
    const existing = pending.get(key);
    if (existing) {
      hits += 1;
      return structuredClone(await existing);
    }
    misses += 1;
    const request = (async (): Promise<T> => {
      const result = await executor(safe.sql, safe.parameters);
      const cloned = structuredClone(result);
      entries.set(key, { expiresAt: now() + options.ttlMs, result: cloned });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
      return cloned;
    })();
    pending.set(key, request);
    try { return structuredClone(await request); }
    finally { if (pending.get(key) === request) pending.delete(key); }
  };
  return {
    query,
    clear() { entries.clear(); },
    stats: () => ({ size: entries.size, hits, misses }),
  };
}

export interface DbAccessAuditRecord {
  actor?: string;
  operation: string;
  queryHash: string;
  success: boolean;
  timestamp: number;
  durationMs: number;
  errorCode?: string | number;
}

/** 360. Audit query outcomes with a hash and metadata only; SQL values/errors are never included. */
export function dbAccessAuditLogger<T>(
  executor: DbQueryExecutor<T>,
  log: (record: DbAccessAuditRecord) => void | Promise<void>,
  options: { actor?: string; now?: () => number } = {}
): DbQueryExecutor<T> {
  if (typeof executor !== 'function' || typeof log !== 'function') throw new Error('Query executor and audit logger adapters are required');
  const now = options.now ?? Date.now;
  return async (sql, parameters = []) => {
    const started = now();
    let queryHash: string;
    try { queryHash = createHash('sha256').update(sql).digest('hex'); }
    catch { queryHash = createHash('sha256').update('invalid-sql').digest('hex'); }
    let operation = 'UNKNOWN';
    try { operation = scanSql(sql, { allowComments: true }).tokens.find(token => token.kind === 'word')?.value.toUpperCase() ?? 'UNKNOWN'; }
    catch { /* invalid SQL is still recorded as UNKNOWN */ }

    const makeRecord = (success: boolean, error?: unknown): DbAccessAuditRecord => {
      const ended = now();
      const record: DbAccessAuditRecord = {
        ...(options.actor === undefined ? {} : { actor: options.actor }),
        operation,
        queryHash,
        success,
        timestamp: ended,
        durationMs: Math.max(0, ended - started),
      };
      if (error && typeof error === 'object' && 'code' in error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string' && code.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(code)) record.errorCode = code;
        else if (typeof code === 'number' && Number.isFinite(code)) record.errorCode = code;
      }
      return record;
    };

    let result: T;
    try {
      const safe = sqlInjectionSanitizer(sql, parameters);
      result = await executor(safe.sql, safe.parameters);
    } catch (error) {
      try { await log(makeRecord(false, error)); }
      catch (auditError) { throw new AggregateError([error, auditError], 'Database operation and audit logging failed', { cause: error }); }
      throw error;
    }
    try { await log(makeRecord(true)); }
    catch (auditError) {
      throw new Error('Database operation succeeded but its audit record could not be written', { cause: auditError });
    }
    return result;
  };
}
