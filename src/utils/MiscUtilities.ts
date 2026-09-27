import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Session } from '../types/index.js';
import { hasOwn, ownGet } from './SafeObject.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseSemver(version: string): [number, number, number] | undefined {
  const match = version.trim().match(/^[v=]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export interface VersionCompatibility {
  compatible: boolean;
  reason: string;
  current?: string;
  target?: string;
}

/** 481. Compare semantic versions using same-major compatibility; malformed versions fail closed. */
export function versionCompatibilityChecker(current: string, target: string): VersionCompatibility {
  const from = parseSemver(current);
  const to = parseSemver(target);
  if (!from || !to) return { compatible: false, reason: 'Both versions must be valid semantic versions', current, target };
  if (from[0] !== to[0]) return { compatible: false, reason: `Major version changes from ${from[0]} to ${to[0]} are not backward compatible`, current, target };
  return { compatible: true, reason: 'Versions share a major version', current, target };
}

export interface FeatureFlags {
  isEnabled(name: string): boolean;
  toggle(name: string): boolean;
  set(name: string, enabled: boolean): void;
  snapshot(): Record<string, boolean>;
}

/** 482. Manage local feature flags without mutating the caller's defaults. */
export function featureFlagToggle(defaults: Record<string, boolean> = {}): FeatureFlags {
  const flags = new Map(Object.entries(defaults));
  return {
    isEnabled(name) { return flags.get(name) ?? false; },
    toggle(name) {
      const value = !(flags.get(name) ?? false);
      flags.set(name, value);
      return value;
    },
    set(name, enabled) { flags.set(name, enabled); },
    snapshot() { return Object.fromEntries(flags); },
  };
}

export interface HealthCheckResult {
  status: 200 | 503;
  body: { status: 'healthy' | 'unhealthy'; checkedAt: string; checks: Record<string, 'healthy' | 'unhealthy'> };
}

/** 483. Framework-neutral health endpoint response from injected dependency checks. */
export async function healthCheckEndpoint(
  checks: Record<string, () => boolean | void | Promise<boolean | void>>,
  options: { now?: () => number; timeoutMs?: number } = {}
): Promise<HealthCheckResult> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  const results = await Promise.all(Object.entries(checks).map(async ([name, check]) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(check).then(value => ({ ok: value !== false })),
        new Promise<{ ok: false }>(resolve => { timer = setTimeout(() => resolve({ ok: false }), timeoutMs); }),
      ]);
      if (timer) clearTimeout(timer);
      return [name, outcome.ok ? 'healthy' as const : 'unhealthy' as const] as const;
    } catch {
      if (timer) clearTimeout(timer);
      return [name, 'unhealthy' as const] as const;
    }
  }));
  const normalizedChecks = Object.fromEntries(results) as Record<string, 'healthy' | 'unhealthy'>;
  const healthy = Object.values(normalizedChecks).every(status => status === 'healthy');
  return {
    status: healthy ? 200 : 503,
    body: {
      status: healthy ? 'healthy' : 'unhealthy',
      checkedAt: new Date(now()).toISOString(),
      checks: normalizedChecks,
    },
  };
}

export interface UpgradeMigration {
  from: string;
  to: string;
  migrate(data: Record<string, unknown>): Record<string, unknown>;
}

/** 484. Apply caller-provided, contiguous version migrations on a cloned object; never writes external state. */
export function gracefulUpgradeMigrator<T extends Record<string, unknown>>(
  data: T,
  fromVersion: string,
  toVersion: string,
  migrations: readonly UpgradeMigration[]
): { data: Record<string, unknown>; fromVersion: string; toVersion: string; applied: string[] } {
  if (!parseSemver(fromVersion) || !parseSemver(toVersion)) throw new Error('upgrade versions must be valid semantic versions');
  if (fromVersion === toVersion) return { data: structuredClone(data), fromVersion, toVersion, applied: [] };
  const byFrom = new Map<string, UpgradeMigration>();
  for (const migration of migrations) {
    if (!parseSemver(migration.from) || !parseSemver(migration.to)) throw new Error('migration versions must be valid semantic versions');
    if (byFrom.has(migration.from)) throw new Error(`multiple migrations start at ${migration.from}`);
    byFrom.set(migration.from, migration);
  }
  let currentVersion = fromVersion;
  let currentData: Record<string, unknown> = structuredClone(data);
  const applied: string[] = [];
  const seen = new Set([currentVersion]);
  while (currentVersion !== toVersion) {
    const migration = byFrom.get(currentVersion);
    if (!migration) throw new Error(`no migration found from ${currentVersion} toward ${toVersion}`);
    if (seen.has(migration.to)) throw new Error(`migration cycle detected at ${migration.to}`);
    const next = migration.migrate(structuredClone(currentData));
    if (asRecord(next) === undefined) throw new Error(`migration ${migration.from}->${migration.to} must return an object`);
    currentData = structuredClone(next);
    applied.push(`${migration.from}->${migration.to}`);
    currentVersion = migration.to;
    seen.add(currentVersion);
    if (applied.length > migrations.length) throw new Error('migration chain exceeds configured migrations');
  }
  return { data: currentData, fromVersion, toVersion, applied };
}

/** 485. Topologically sort plugin dependency declarations; unknown dependencies and cycles are errors. */
export function pluginDependencyResolver(dependencies: Record<string, readonly string[]>): string[] {
  const names = Object.keys(dependencies);
  const nameSet = new Set(names);
  // Validate the entire declared graph; even a currently unreachable bad entry
  // must not be silently ignored.
  for (const [plugin, requires] of Object.entries(dependencies)) {
    for (const dependency of requires ?? []) {
      if (!nameSet.has(dependency)) throw new Error(`plugin '${plugin}' depends on unknown plugin '${dependency}'`);
    }
  }
  const temporary = new Set<string>();
  const permanent = new Set<string>();
  const result: string[] = [];
  const visit = (name: string, chain: string[]): void => {
    if (permanent.has(name)) return;
    if (temporary.has(name)) throw new Error(`plugin dependency cycle: ${[...chain, name].join(' -> ')}`);
    if (!hasOwn(dependencies, name)) throw new Error(`unknown plugin dependency '${name}'`);
    temporary.add(name);
    for (const dependency of ownGet(dependencies, name) ?? []) {
      if (!nameSet.has(dependency)) throw new Error(`plugin '${name}' depends on unknown plugin '${dependency}'`);
      visit(dependency, [...chain, name]);
    }
    temporary.delete(name);
    permanent.add(name);
    result.push(name);
  };
  for (const name of names) visit(name, []);
  return result;
}

export interface PluginHook {
  id: string;
  init?: () => void | Promise<void>;
  dispose?: () => void | Promise<void>;
}

export interface PluginLifecycle {
  initialize(): Promise<void>;
  dispose(): Promise<void>;
  status(): 'new' | 'initialized' | 'disposed' | 'failed';
}

/** 486. Run injected plugin init/dispose hooks once, disposing only successfully initialized hooks in reverse order. */
export function pluginLifecycleHooks(hooks: readonly PluginHook[]): PluginLifecycle {
  const ids = new Set<string>();
  for (const hook of hooks) {
    if (!hook.id || ids.has(hook.id)) throw new Error(`plugin hook ids must be unique and non-empty: '${hook.id}'`);
    ids.add(hook.id);
  }
  let state: 'new' | 'initialized' | 'disposed' | 'failed' = 'new';
  const initialized: PluginHook[] = [];
  // Disposes each hook at most once, in reverse init order, and drains the list
  // so a later dispose() cannot re-run hooks an init rollback already handled.
  const disposeInitialized = async (): Promise<unknown[]> => {
    const pending = [...initialized].reverse();
    initialized.length = 0;
    const errors: unknown[] = [];
    for (const hook of pending) {
      try { await hook.dispose?.(); } catch (error) { errors.push(error); }
    }
    return errors;
  };
  return {
    async initialize() {
      if (state === 'initialized') return;
      if (state !== 'new') throw new Error(`cannot initialize plugin lifecycle from ${state} state`);
      try {
        for (const hook of hooks) {
          await hook.init?.();
          initialized.push(hook);
        }
        state = 'initialized';
      } catch (error) {
        state = 'failed';
        const cleanupErrors = await disposeInitialized();
        if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], 'plugin initialization and rollback failed');
        throw error;
      }
    },
    async dispose() {
      if (state === 'disposed' || state === 'new') { state = 'disposed'; return; }
      const errors = await disposeInitialized();
      state = errors.length > 0 ? 'failed' : 'disposed';
      if (errors.length > 0) throw new AggregateError(errors, 'one or more plugin dispose hooks failed');
    },
    status() { return state; },
  };
}

export interface ConfigHotSwapHooks {
  validate?: (config: Record<string, unknown>) => boolean | void | Promise<boolean | void>;
  apply?: (config: Record<string, unknown>, previous: Record<string, unknown>) => void | Promise<void>;
}

/** 487. Validate, clone, and apply a config update before replacing the caller-owned snapshot. */
export async function configHotSwap<T extends Record<string, unknown>>(
  current: T,
  update: Partial<T>,
  hooks: ConfigHotSwapHooks = {}
): Promise<{ previous: T; config: Record<string, unknown>; changedKeys: string[] }> {
  const previous = structuredClone(current);
  const next = { ...structuredClone(current), ...structuredClone(update) } as Record<string, unknown>;
  const valid = await hooks.validate?.(structuredClone(next));
  if (valid === false) throw new Error('config validation failed; active config was not changed');
  const changedKeys = [...new Set([...Object.keys(current), ...Object.keys(update)])]
    .filter(key => !isDeepEqual(current[key], next[key]));
  await hooks.apply?.(structuredClone(next), previous);
  return { previous, config: next, changedKeys };
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

export interface SessionFileOptions {
  rootDir: string;
}

function safeSessionPath(rootDir: string, filePath: string): string {
  if (!filePath || path.isAbsolute(filePath)) throw new Error('session path must be a non-empty relative path');
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, filePath);
  const relative = path.relative(root, resolved);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('session path escapes the configured root');
  }
  return resolved;
}

async function ensureNoSymlinkEscape(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  const components = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stats = await fs.lstat(current);
      if (stats.isSymbolicLink()) throw new Error('session path must not traverse symbolic links');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
}

function validateSession(value: unknown): Session {
  const session = asRecord(value);
  if (!session || typeof session.id !== 'string' || session.id.length === 0 ||
    typeof session.timestamp !== 'string' && !(session.timestamp instanceof Date) ||
    typeof session.workspace !== 'string' || !Array.isArray(session.messages) || !Array.isArray(session.toolCalls) ||
    !asRecord(session.state)) {
    throw new Error('invalid session document: expected id, timestamp, workspace, messages, toolCalls, and state');
  }
  const timestamp = session.timestamp instanceof Date ? session.timestamp : new Date(session.timestamp as string);
  if (Number.isNaN(timestamp.getTime())) throw new Error('invalid session timestamp');
  return { ...session, timestamp } as unknown as Session;
}

/** 488. Atomically export a session JSON document with an owner-only mode inside the configured root. */
export async function sessionExporter(
  session: Session,
  filePath: string,
  options: SessionFileOptions
): Promise<string> {
  const root = path.resolve(options.rootDir);
  const target = safeSessionPath(root, filePath);
  const payload = validateSession(session);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await ensureNoSymlinkEscape(root, target);
  const temporary = path.join(parent, `.${path.basename(target)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    // Avoid following a pre-existing destination symlink or replacing an
    // unexpected non-file target when exporting confidential session state.
    try {
      const existing = await fs.lstat(target);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('session destination must be a regular file, not a symlink');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(payload, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
    return target;
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 489. Import and validate a JSON session only from a caller-configured root; network sources are not accepted. */
export async function sessionImporter(filePath: string, options: SessionFileOptions): Promise<Session> {
  const root = path.resolve(options.rootDir);
  const target = safeSessionPath(root, filePath);
  await ensureNoSymlinkEscape(root, target);
  let content: string;
  try { content = await fs.readFile(target, 'utf8'); }
  catch (error) { throw new Error(`unable to read session file: ${error instanceof Error ? error.message : String(error)}`); }
  let parsed: unknown;
  try { parsed = JSON.parse(content) as unknown; }
  catch { throw new Error('invalid session JSON'); }
  return validateSession(parsed);
}

export interface RecoveryCheckpoint {
  id: string;
  savedAt: string;
  state: Record<string, unknown>;
}

/** 490. Load the newest well-formed recovery checkpoint from an injected store. */
export async function crashRecoveryLoader(
  load: () => readonly RecoveryCheckpoint[] | Promise<readonly RecoveryCheckpoint[]>
): Promise<RecoveryCheckpoint | undefined> {
  const entries = await load();
  const valid = entries.filter(entry => Boolean(entry) && typeof entry.id === 'string' && entry.id.length > 0 &&
    Number.isFinite(Date.parse(entry.savedAt)) && asRecord(entry.state) !== undefined);
  const selected = [...valid].sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))[0];
  return selected ? structuredClone(selected) : undefined;
}

export interface TelemetryOptOutResult {
  optOut: boolean;
  telemetryEnabled: boolean;
  persisted: boolean;
}

/** 491. Set a telemetry preference through injected persistence; opt-out never sends telemetry. */
export async function telemetryOptOutHandler(
  optOut: boolean,
  store: { saveOptOut(value: boolean): void | Promise<void> }
): Promise<TelemetryOptOutResult> {
  await store.saveOptOut(optOut);
  return { optOut, telemetryEnabled: !optOut, persisted: true };
}

export type MessageCatalog = Record<string, string>;

/** 492. Load locale dictionaries with language fallback and safe {placeholder} interpolation. */
export function localizationLoader(
  locale: string,
  catalogs: Record<string, MessageCatalog>,
  fallbackLocale = 'en'
): (key: string, variables?: Record<string, string | number>) => string {
  const baseLocale = locale.toLowerCase().split(/[-_]/)[0];
  const selected = catalogs[locale] ?? catalogs[baseLocale] ?? {};
  const fallback = catalogs[fallbackLocale] ?? {};
  return (key, variables = {}) => {
    const template = ownGet(selected, key) ?? ownGet(fallback, key) ?? key;
    return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (whole, name: string) =>
      Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : whole
    );
  };
}

export interface SystemResourceSnapshot {
  cpuLoad1m: number;
  cpuCoreCount: number;
  cpuLoadPerCore: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  memoryUsedPercent: number;
  processRssBytes: number;
  processHeapUsedBytes: number;
}

/** 493. Sample live Node process and host memory/load; caller may inject a snapshot for tests/platform overrides. */
export function systemResourceMonitor(
  source: () => { cpuLoad1m: number; cpuCoreCount: number; totalMemoryBytes: number; freeMemoryBytes: number; processRssBytes: number; processHeapUsedBytes: number } = () => ({
    cpuLoad1m: os.loadavg()[0] ?? 0,
    cpuCoreCount: os.cpus().length || 1,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    processRssBytes: process.memoryUsage().rss,
    processHeapUsedBytes: process.memoryUsage().heapUsed,
  })
): SystemResourceSnapshot {
  const raw = source();
  const cpuLoad1m = Math.max(0, raw.cpuLoad1m);
  const cpuCoreCount = Math.max(1, Math.floor(raw.cpuCoreCount));
  const totalMemoryBytes = Math.max(0, raw.totalMemoryBytes);
  const freeMemoryBytes = Math.max(0, Math.min(totalMemoryBytes, raw.freeMemoryBytes));
  const memoryUsedPercent = totalMemoryBytes === 0 ? 0 : (totalMemoryBytes - freeMemoryBytes) / totalMemoryBytes * 100;
  return {
    cpuLoad1m,
    cpuCoreCount,
    cpuLoadPerCore: cpuLoad1m / cpuCoreCount,
    totalMemoryBytes,
    freeMemoryBytes,
    memoryUsedPercent,
    processRssBytes: Math.max(0, raw.processRssBytes),
    processHeapUsedBytes: Math.max(0, raw.processHeapUsedBytes),
  };
}

export interface PluginExecutionBackend<T> {
  boundary: string;
  verified: boolean;
  run(plugin: unknown): T | Promise<T>;
}

export type PluginIsolationResult<T> =
  | { isolated: true; boundary: string; value: T }
  | { isolated: false; boundary: 'none'; reason: string };

/**
 * 494. Run only inside a caller-injected, attested process boundary. This utility
 * cannot create a sandbox; same-process execution is explicitly not isolation.
 */
export async function pluginSandboxIsolator<T>(
  plugin: unknown,
  backend?: PluginExecutionBackend<T>
): Promise<PluginIsolationResult<T>> {
  if (!backend) return { isolated: false, boundary: 'none', reason: 'No verified isolation backend configured; plugin was not run' };
  if (!backend.verified || backend.boundary === 'same-process' || backend.boundary.trim() === '') {
    return { isolated: false, boundary: 'none', reason: 'Isolation backend is not independently verified; plugin was not run' };
  }
  return { isolated: true, boundary: backend.boundary, value: await backend.run(plugin) };
}

export interface DeprecationDetails {
  since?: string;
  removal?: string;
  replacement?: string;
}

/** 495. Emit an injected one-time deprecation warning without console or telemetry side effects. */
export function apiDeprecationWarner(
  emit: (message: string) => void = () => undefined
): { warn(feature: string, details?: DeprecationDetails): string | undefined; clear(): void } {
  const warned = new Set<string>();
  return {
    warn(feature, details = {}) {
      if (warned.has(feature)) return undefined;
      warned.add(feature);
      const clauses = [
        details.since ? `deprecated since ${details.since}` : 'deprecated',
        details.removal ? `scheduled for removal in ${details.removal}` : undefined,
        details.replacement ? `use ${details.replacement} instead` : undefined,
      ].filter(Boolean);
      const message = `${feature}: ${clauses.join('; ')}`;
      emit(message);
      return message;
    },
    clear() { warned.clear(); },
  };
}

export interface CompatibilityMigration {
  id: string;
  applies(value: Record<string, unknown>): boolean;
  migrate(value: Record<string, unknown>): Record<string, unknown>;
}

/** 496. Apply explicit compatibility migrations to cloned JSON-like data. */
export function backwardCompatShim<T extends Record<string, unknown>>(
  input: T,
  migrations: readonly CompatibilityMigration[]
): { value: Record<string, unknown>; applied: string[] } {
  let value = structuredClone(input) as Record<string, unknown>;
  const applied: string[] = [];
  for (const migration of migrations) {
    if (!migration.id || typeof migration.applies !== 'function' || typeof migration.migrate !== 'function') {
      throw new Error('compatibility migrations require id, applies, and migrate functions');
    }
    if (!migration.applies(structuredClone(value))) continue;
    const next = migration.migrate(structuredClone(value));
    if (asRecord(next) === undefined) throw new Error(`compatibility migration '${migration.id}' must return an object`);
    value = structuredClone(next);
    applied.push(migration.id);
  }
  return { value, applied };
}

export interface GeneratedDocEntry {
  name: string;
  signature: string;
  description: string;
  kind: 'function' | 'class' | 'interface' | 'type';
}

/** 497. Extract exported TypeScript declarations and adjacent JSDoc from source text into Markdown. */
export function documentationAutoGenerator(source: string): string {
  const entries: GeneratedDocEntry[] = [];
  const pattern = /(?:\/\*\*([\s\S]*?)\*\/\s*)?export\s+(?:declare\s+)?(async\s+)?(function|class|interface|type)\s+(\w+)([^\n{;]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const comment = match[1] ?? '';
    const kind = match[3] as GeneratedDocEntry['kind'];
    const name = match[4];
    const tail = match[5].trim();
    const prefix = match[2] ? 'async ' : '';
    const signature = `${prefix}${kind} ${name}${tail}`.replace(/\s+/g, ' ').trim();
    const description = comment.split('\n').map(line => line.replace(/^\s*\*?\s?/, '').trim()).filter(line => line && !line.startsWith('@')).join(' ');
    entries.push({ name, signature, description, kind });
  }
  const sections = entries.map(entry => `### ${entry.signature}\n\n${entry.description || '_No JSDoc description provided._'}`);
  return sections.length > 0 ? `# API Reference\n\n${sections.join('\n\n')}` : '# API Reference\n\n_No exported declarations found._';
}

export interface ChangelogEntry {
  type: string;
  description: string;
  breaking?: boolean;
  scope?: string;
}

/** 498. Create deterministic release notes from caller-supplied commit metadata. */
export function changelogGenerator(
  previousVersion: string,
  version: string,
  entries: readonly ChangelogEntry[]
): string {
  if (!version.trim()) throw new Error('version is required');
  const titleFor = (type: string): string => {
    const value = type.toLowerCase();
    if (value === 'feat' || value === 'feature') return 'Added';
    if (value === 'fix' || value === 'bugfix') return 'Fixed';
    if (value === 'perf' || value === 'performance') return 'Performance';
    if (value === 'docs' || value === 'documentation') return 'Documentation';
    if (value === 'refactor' || value === 'chore' || value === 'test') return 'Maintenance';
    return 'Other Changes';
  };
  const breaking = entries.filter(entry => entry.breaking);
  const regular = entries.filter(entry => !entry.breaking);
  const groups = new Map<string, string[]>();
  for (const entry of regular) {
    const title = titleFor(entry.type);
    const bucket = groups.get(title) ?? [];
    bucket.push(`- ${entry.scope ? `**${entry.scope}:** ` : ''}${entry.description}`);
    groups.set(title, bucket);
  }
  const sections: string[] = [];
  if (breaking.length > 0) sections.push(`## Breaking Changes\n${breaking.map(entry => `- ${entry.scope ? `**${entry.scope}:** ` : ''}${entry.description}`).join('\n')}`);
  for (const title of ['Added', 'Fixed', 'Performance', 'Documentation', 'Maintenance', 'Other Changes']) {
    const changes = groups.get(title);
    if (changes?.length) sections.push(`## ${title}\n${changes.join('\n')}`);
  }
  return [`# ${version}`, previousVersion ? `\n_Changes since ${previousVersion}._` : '', ...sections.map(section => `\n${section}`)].join('\n').trim();
}

export interface OnboardingQuestion {
  id: string;
  prompt?: string;
  validate(value: unknown): true | string | Promise<true | string>;
}

/** 499. Ask setup questions via injected prompt and validate/re-prompt without reading stdin. */
export async function onboardingWizard(
  questions: readonly OnboardingQuestion[],
  prompt: (question: OnboardingQuestion, previousError?: string) => unknown | Promise<unknown>,
  options: { maxAttemptsPerQuestion?: number } = {}
): Promise<Record<string, unknown>> {
  const maxAttempts = options.maxAttemptsPerQuestion ?? 5;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttemptsPerQuestion must be a positive integer');
  const results: Record<string, unknown> = {};
  const ids = new Set<string>();
  for (const question of questions) {
    if (!question.id || ids.has(question.id)) throw new Error(`onboarding question ids must be unique and non-empty: '${question.id}'`);
    ids.add(question.id);
    let previousError: string | undefined;
    let accepted = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const value = await prompt(question, previousError);
      const validation = await question.validate(value);
      if (validation === true) {
        results[question.id] = value;
        accepted = true;
        break;
      }
      previousError = validation;
    }
    if (!accepted) throw new Error(`onboarding answer '${question.id}' was invalid after ${maxAttempts} attempt(s): ${previousError ?? 'no valid answer'}`);
  }
  return results;
}

export interface DiagnosticCheckResult {
  status: 'passed' | 'failed';
  durationMs: number;
  error?: string;
}

export interface DiagnosticReport {
  overall: 'passed' | 'failed';
  startedAt: number;
  durationMs: number;
  checks: Record<string, DiagnosticCheckResult>;
}

/** 500. Run injected harness checks independently and return safe status/error summaries. */
export async function selfDiagnosticRunner(
  checks: Record<string, () => boolean | void | Promise<boolean | void>>,
  options: { now?: () => number } = {}
): Promise<DiagnosticReport> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const entries = await Promise.all(Object.entries(checks).map(async ([name, check]) => {
    const start = now();
    try {
      const result = await check();
      if (result === false) return [name, { status: 'failed' as const, durationMs: Math.max(0, now() - start), error: 'check returned false' }] as const;
      return [name, { status: 'passed' as const, durationMs: Math.max(0, now() - start) }] as const;
    } catch (error) {
      return [name, { status: 'failed' as const, durationMs: Math.max(0, now() - start), error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) }] as const;
    }
  }));
  const results = Object.fromEntries(entries) as Record<string, DiagnosticCheckResult>;
  const durationMs = Math.max(0, now() - startedAt);
  return {
    overall: Object.values(results).every(check => check.status === 'passed') ? 'passed' : 'failed',
    startedAt,
    durationMs,
    checks: results,
  };
}
