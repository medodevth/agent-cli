import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type ConfigValue = unknown;
export type ConfigObject = Record<string, ConfigValue>;
export type ConfigSource = ConfigObject | string;
export interface ConfigIssue { path: string; message: string; }
export interface ConfigValidationResult { valid: boolean; errors: ConfigIssue[]; value?: ConfigObject; }
export interface ConfigDiffEntry { path: string; before: ConfigValue; after: ConfigValue; kind: 'added' | 'removed' | 'changed'; }
export interface ConfigMigration { from: number; to: number; migrate: (config: ConfigObject) => ConfigObject | Promise<ConfigObject>; }
export interface ConfigWatcher { close: () => Promise<void>; }
export interface ConfigFileAdapter {
  readFile?: (filePath: string) => Promise<string>;
  writeFile?: (filePath: string, content: string, options?: { mode?: number }) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  copyFile?: (from: string, to: string) => Promise<void>;
  stat?: (filePath: string) => Promise<{ mode: number }>;
  watch?: (filePath: string, listener: () => void) => { close: () => void };
}

const defaultFiles: Required<Pick<ConfigFileAdapter, 'readFile' | 'writeFile' | 'rename' | 'copyFile' | 'stat'>> = {
  readFile: filePath => fs.readFile(filePath, 'utf8'),
  writeFile: async (filePath, content, options) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, { encoding: 'utf8', mode: options?.mode });
  },
  rename: (from, to) => fs.rename(from, to),
  copyFile: (from, to) => fs.copyFile(from, to),
  stat: async filePath => fs.stat(filePath),
};

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function asObject(value: unknown, label = 'config'): ConfigObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as ConfigObject;
}

function deepMerge(...layers: ConfigObject[]): ConfigObject {
  const result: ConfigObject = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      const previous = result[key];
      if (isPlainObject(previous) && isPlainObject(value)) result[key] = deepMerge(previous, value);
      else result[key] = clone(value);
    }
  }
  return result;
}

function isPlainObject(value: unknown): value is ConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getAt(object: ConfigObject, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((current, key) => isPlainObject(current) ? current[key] : undefined, object);
}

function setAt(object: ConfigObject, dottedPath: string, value: unknown): void {
  const parts = dottedPath.split('.');
  let current = object;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(current[part])) current[part] = {};
    current = current[part] as ConfigObject;
  }
  current[parts[parts.length - 1]] = value;
}

/** 163. Deep-merge global, project, environment and explicit layers in precedence order. */
export function mergeConfigLayers(...layers: ConfigObject[]): ConfigObject;
export function mergeConfigLayers(layers: ConfigObject[], environment?: ConfigObject, explicit?: ConfigObject): ConfigObject;
export function mergeConfigLayers(...args: ConfigObject[] | [ConfigObject[], ConfigObject?, ConfigObject?]): ConfigObject {
  const layers = Array.isArray(args[0]) ? args[0] : args as ConfigObject[];
  if (Array.isArray(args[0])) layers.push(...(args.slice(1) as ConfigObject[]).filter(Boolean));
  return deepMerge(...layers);
}

/** 164. Validate a config against a dependency-free JSON-schema subset. */
export function validateConfigSchema(config: unknown, schema: ConfigObject): ConfigValidationResult {
  const errors: ConfigIssue[] = [];
  const check = (value: unknown, current: ConfigObject, at: string): void => {
    const type = current.type as string | undefined;
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (type && type !== 'any' && actual !== type && !(type === 'integer' && typeof value === 'number' && Number.isInteger(value))) {
      errors.push({ path: at || '$', message: `Expected ${type}, got ${actual}` });
      return;
    }
    if (Array.isArray(current.enum) && !current.enum.some(item => Object.is(item, value))) errors.push({ path: at || '$', message: 'Value is not allowed' });
    if (typeof value === 'string') {
      if (typeof current.minLength === 'number' && value.length < current.minLength) errors.push({ path: at || '$', message: `String shorter than ${current.minLength}` });
      if (typeof current.pattern === 'string' && !new RegExp(current.pattern).test(value)) errors.push({ path: at || '$', message: 'String does not match pattern' });
    }
    if (typeof value === 'number') {
      if (typeof current.minimum === 'number' && value < current.minimum) errors.push({ path: at || '$', message: `Number below ${current.minimum}` });
      if (typeof current.maximum === 'number' && value > current.maximum) errors.push({ path: at || '$', message: `Number above ${current.maximum}` });
    }
    if (isPlainObject(value)) {
      const properties = isPlainObject(current.properties) ? current.properties : {};
      for (const required of Array.isArray(current.required) ? current.required : []) {
        if (!(required in value)) errors.push({ path: at ? `${at}.${required}` : required, message: 'Required field is missing' });
      }
      for (const [key, child] of Object.entries(properties)) if (key in value && isPlainObject(child)) check(value[key], child, at ? `${at}.${key}` : key);
      if (current.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in properties)) errors.push({ path: at ? `${at}.${key}` : key, message: 'Unknown field' });
    }
    if (Array.isArray(value) && isPlainObject(current.items)) value.forEach((item, index) => check(item, current.items as ConfigObject, `${at}[${index}]`));
  };
  check(config, schema, '');
  return errors.length === 0 ? { valid: true, errors: [], value: clone(asObject(config)) } : { valid: false, errors };
}

/** 165. Reload a config source on demand, validating before publishing it. */
export function configHotReload<T extends ConfigObject>(
  current: T,
  loader: () => Promise<ConfigObject> | ConfigObject,
  options: { schema?: ConfigObject; onChange?: (next: T, previous: T) => void } = {}
): Promise<T> {
  return Promise.resolve(loader()).then(nextRaw => {
    if (options.schema) {
      const validation = validateConfigSchema(nextRaw, options.schema);
      if (!validation.valid) throw new Error(`Invalid hot-reloaded config: ${validation.errors.map(error => `${error.path} ${error.message}`).join('; ')}`);
    }
    const next = clone(nextRaw) as T;
    options.onChange?.(next, current);
    return next;
  });
}

/** 166. Return a cloned default value, or the fallback when the path has no default. */
export function getConfigDefault<T>(defaults: ConfigObject, dottedPath: string, fallback?: T): T | undefined {
  const value = getAt(defaults, dottedPath);
  return value === undefined ? fallback : clone(value) as T;
}

/** 167. Describe added, removed and changed config paths. */
export function configDiffOnUpgrade(before: ConfigObject, after: ConfigObject): ConfigDiffEntry[] {
  const entries: ConfigDiffEntry[] = [];
  const walk = (left: unknown, right: unknown, at: string): void => {
    if (isPlainObject(left) && isPlainObject(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) walk(left[key], right[key], at ? `${at}.${key}` : key);
      return;
    }
    if (left === undefined && right !== undefined) entries.push({ path: at, before: undefined, after: clone(right), kind: 'added' });
    else if (left !== undefined && right === undefined) entries.push({ path: at, before: clone(left), after: undefined, kind: 'removed' });
    else if (JSON.stringify(left) !== JSON.stringify(right)) entries.push({ path: at, before: clone(left), after: clone(right), kind: 'changed' });
  };
  walk(before, after, '');
  return entries;
}

/** 168. Resolve a secret from environment first, then an injected vault adapter. */
export async function configSecretResolver(
  reference: string,
  options: { env?: NodeJS.ProcessEnv; vault?: (name: string) => Promise<string | undefined> | string | undefined } = {}
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const name = reference.startsWith('env:') ? reference.slice(4) : reference;
  if (env[name] !== undefined) return env[name];
  return options.vault?.(name);
}

/** 169. Select a named profile and deep-merge it over the base config. */
export function configProfileSwitcher(base: ConfigObject, profiles: Record<string, ConfigObject>, profile: string): ConfigObject {
  if (!(profile in profiles)) throw new Error(`Unknown config profile: ${profile}`);
  return deepMerge(base, profiles[profile]);
}

/** 170. Parse dotenv assignments without mutating process.env. */
export function dotEnvLoader(content: string, options: { expand?: boolean } = {}): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (options.expand) value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced: string, plain: string) => values[braced ?? plain] ?? process.env[braced ?? plain] ?? '');
    values[match[1]] = value;
  }
  return values;
}

/** 171. Clone a config while masking likely secret keys and values. */
export function configExportSanitized(config: ConfigObject, options: { replacement?: string; secretKeys?: RegExp } = {}): ConfigObject {
  const replacement = options.replacement ?? '[REDACTED]';
  const keyPattern = options.secretKeys ?? /(?:api[-_]?key|token|secret|password|passwd|private[-_]?key|credential)/i;
  const visit = (value: unknown, key = ''): unknown => {
    if (keyPattern.test(key)) return replacement;
    if (Array.isArray(value)) return value.map(item => visit(item));
    if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, visit(child, childKey)]));
    return value;
  };
  return visit(config) as ConfigObject;
}

/** 172. Lint config keys and values with explicit rules; no implicit writes. */
export function configLinter(config: ConfigObject, rules: Array<(config: ConfigObject) => ConfigIssue[]> = []): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (key.trim() !== key || key.length === 0) issues.push({ path: key, message: 'Key contains leading/trailing whitespace or is empty' });
    if (keyPatternIsSecret(key) && typeof value === 'string' && value.trim() !== '' && !/^\$\{[^}]+\}$/.test(value) && !/^env:/i.test(value)) issues.push({ path: key, message: 'Secret should reference environment or a vault' });
  }
  for (const rule of rules) issues.push(...rule(config));
  return issues;
}

function keyPatternIsSecret(key: string): boolean { return /(?:api[-_]?key|token|secret|password|passwd|private[-_]?key|credential)/i.test(key); }

/** 173. Prefix plugin settings in a namespace without mutating the source. */
export function pluginConfigNamespacer(pluginName: string, config: ConfigObject, options: { separator?: string } = {}): ConfigObject {
  if (!/^[A-Za-z0-9._-]+$/.test(pluginName)) throw new Error('Invalid plugin name');
  const separator = options.separator ?? '.';
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [`${pluginName}${separator}${key}`, clone(value)]));
}

/** 174. Parse CLI overrides (`--a.b=value`, `--flag`, `--no-flag`) into typed values. */
export function runtimeOverrideParser(args: string[]): ConfigObject {
  const result: ConfigObject = {};
  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    const raw = arg.slice(2);
    if (raw.startsWith('no-') && !raw.includes('=')) { setAt(result, raw.slice(3), false); continue; }
    const equal = raw.indexOf('=');
    const key = equal === -1 ? raw : raw.slice(0, equal);
    const text = equal === -1 ? 'true' : raw.slice(equal + 1);
    let value: unknown = text;
    if (text === 'true') value = true;
    else if (text === 'false') value = false;
    else if (text === 'null') value = null;
    else if (text !== '' && Number.isFinite(Number(text))) value = Number(text);
    else { try { value = JSON.parse(text); } catch { /* retain string */ } }
    setAt(result, key, value);
  }
  return result;
}

/** 175. Copy a previous config to a timestamped backup before a change. */
export async function configBackupOnChange(
  configPath: string,
  options: { backupPath?: string; files?: ConfigFileAdapter; now?: () => Date } = {}
): Promise<string | undefined> {
  const files = { ...defaultFiles, ...(options.files ?? {}) };
  try {
    await files.stat(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const backupPath = options.backupPath ?? `${configPath}.${(options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-')}.bak`;
  await files.copyFile(configPath, backupPath);
  return backupPath;
}

/** 176. Apply ordered migrations from the current version to the target version. */
export async function configMigrationRunner(
  config: ConfigObject,
  fromVersion: number,
  targetVersion: number,
  migrations: ConfigMigration[]
): Promise<{ config: ConfigObject; version: number }> {
  if (fromVersion > targetVersion) throw new Error('fromVersion cannot exceed targetVersion');
  let current = clone(config);
  let version = fromVersion;
  const ordered = [...migrations].sort((a, b) => a.from - b.from);
  while (version < targetVersion) {
    const migration = ordered.find(candidate => candidate.from === version && candidate.to <= targetVersion);
    if (!migration) throw new Error(`No migration from version ${version}`);
    current = await migration.migrate(current);
    version = migration.to;
  }
  return { config: current, version };
}

/** 177. Return the effective merged config as a defensive clone. */
export function getEffectiveConfig(...layers: ConfigObject[]): ConfigObject { return deepMerge(...layers); }

/** 178. Watch a config path using an injected watcher or fs.watch and debounce reload callbacks. */
export function configWatcher(
  configPath: string,
  onChange: () => void | Promise<void>,
  options: { files?: ConfigFileAdapter; debounceMs?: number } = {}
): ConfigWatcher {
  const debounceMs = options.debounceMs ?? 50;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listener = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void onChange(); }, debounceMs);
  };
  const watch = options.files?.watch ?? ((filePath: string, callback: () => void) => {
    const watcher = fs.watch(filePath) as unknown as { on: (event: string, callback: () => void) => void; close: () => void };
    watcher.on('change', callback);
    return { close: () => watcher.close() };
  });
  const handle = watch(configPath, listener);
  return { close: async () => { if (timer) clearTimeout(timer); handle.close(); } };
}

/** 179. Check a config version against supported bounds. */
export function configVersionChecker(version: unknown, options: { current: number; minimum?: number; maximum?: number } = { current: 1 }): { compatible: boolean; version?: number; reason?: string } {
  if (typeof version !== 'number' || !Number.isInteger(version)) return { compatible: false, reason: 'Config version must be an integer' };
  if (options.minimum !== undefined && version < options.minimum) return { compatible: false, version, reason: `Config version ${version} is older than supported minimum ${options.minimum}` };
  if (options.maximum !== undefined && version > options.maximum) return { compatible: false, version, reason: `Config version ${version} is newer than supported maximum ${options.maximum}` };
  return version === options.current ? { compatible: true, version } : { compatible: false, version, reason: `Config version ${version} does not match current version ${options.current}` };
}

/** 180. Return a defensive copy of defaults, optionally preserving selected runtime keys. */
export function resetConfigToDefault(
  defaults: ConfigObject,
  current?: ConfigObject,
  options: { preserve?: string[] } = {}
): ConfigObject {
  const result = clone(defaults);
  for (const key of options.preserve ?? []) {
    const value = current ? getAt(current, key) : undefined;
    if (value !== undefined) setAt(result, key, clone(value));
  }
  return result;
}

/** Load JSON from a path without exposing a network or process side effect. */
export async function loadConfigFile(filePath: string, files: Pick<ConfigFileAdapter, 'readFile'> = defaultFiles): Promise<ConfigObject> {
  return asObject(JSON.parse(await (files.readFile ?? defaultFiles.readFile)(filePath)), 'Config file');
}

/** Export a canonical JSON config representation. */
export function serializeConfig(config: ConfigObject): string { return JSON.stringify(config, null, 2) + '\n'; }
