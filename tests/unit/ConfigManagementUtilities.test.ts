import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { jest } from '@jest/globals';
import {
  configBackupOnChange,
  configDiffOnUpgrade,
  configExportSanitized,
  configHotReload,
  configLinter,
  configMigrationRunner,
  configProfileSwitcher,
  configSecretResolver,
  configVersionChecker,
  configWatcher,
  dotEnvLoader,
  getConfigDefault,
  getEffectiveConfig,
  mergeConfigLayers,
  pluginConfigNamespacer,
  resetConfigToDefault,
  runtimeOverrideParser,
  validateConfigSchema,
} from '../../src/utils/ConfigManagementUtilities.js';

describe('ConfigManagementUtilities layering and validation', () => {
  it('deep-merges layers with later values taking precedence', () => {
    expect(mergeConfigLayers(
      { model: 'base', nested: { first: true, keep: 1 } },
      { nested: { first: false, second: 2 } },
      { model: 'override' },
    )).toEqual({ model: 'override', nested: { first: false, keep: 1, second: 2 } });
  });

  it('validates required fields, types, nested properties and unknown fields', () => {
    const report = validateConfigSchema(
      { provider: 'anthropic', extra: true },
      { type: 'object', required: ['provider'], additionalProperties: false, properties: { provider: { type: 'string' }, maxIterations: { type: 'integer', minimum: 1 } } },
    );
    expect(report.valid).toBe(false);
    expect(report.errors.map(error => error.path)).toContain('extra');
  });

  it('hot reloads a validated clone and publishes changes through the callback', async () => {
    const changes: unknown[] = [];
    const current = { version: 1 };
    await expect(configHotReload(current, async () => ({ version: 2 }), {
      schema: { type: 'object', required: ['version'], properties: { version: { type: 'integer' } } },
      onChange: next => changes.push(next),
    })).resolves.toEqual({ version: 2 });
    expect(changes).toEqual([{ version: 2 }]);
    await expect(configHotReload(current, async () => ({ version: 'bad' }), { schema: { type: 'object', properties: { version: { type: 'integer' } } } })).rejects.toThrow('Invalid hot-reloaded config');
  });

  it('returns cloned defaults and effective config without aliasing inputs', () => {
    const defaults = { retry: { count: 3 } };
    const result = getConfigDefault(defaults, 'retry', {});
    (result as { count: number }).count = 9;
    expect(defaults.retry.count).toBe(3);
    const effective = getEffectiveConfig({ nested: { a: 1 } }, { nested: { b: 2 } });
    expect(effective).toEqual({ nested: { a: 1, b: 2 } });
  });
});

describe('ConfigManagementUtilities upgrade and secret handling', () => {
  it('reports added, removed and changed config paths', () => {
    expect(configDiffOnUpgrade({ old: true, same: 1 }, { same: 2, added: 'x' })).toEqual([
      { path: 'old', before: true, after: undefined, kind: 'removed' },
      { path: 'same', before: 1, after: 2, kind: 'changed' },
      { path: 'added', before: undefined, after: 'x', kind: 'added' },
    ]);
  });

  it('resolves environment secrets before an injected vault', async () => {
    const vault = jest.fn(async () => 'vault-secret');
    await expect(configSecretResolver('env:API_KEY', { env: {}, vault })).resolves.toBe('vault-secret');
    await expect(configSecretResolver('API_KEY', { env: { API_KEY: 'env-secret' }, vault })).resolves.toBe('env-secret');
    expect(vault).toHaveBeenCalledTimes(1);
  });

  it('selects a named profile and rejects unknown profiles', () => {
    expect(configProfileSwitcher({ mode: 'base' }, { prod: { mode: 'production', debug: false } }, 'prod')).toEqual({ mode: 'production', debug: false });
    expect(() => configProfileSwitcher({}, {}, 'missing')).toThrow('Unknown config profile');
  });

  it('parses dotenv without mutating process.env and can expand prior values', () => {
    expect(dotEnvLoader('BASE=one\nexport FULL="${BASE}-two"\n# comment', { expand: true })).toEqual({ BASE: 'one', FULL: 'one-two' });
  });

  it('sanitizes exported secrets recursively', () => {
    expect(configExportSanitized({ apiKey: 'secret', nested: { password: 'pw', visible: true } })).toEqual({ apiKey: '[REDACTED]', nested: { password: '[REDACTED]', visible: true } });
  });

  it('lints hardcoded secret values and accepts env references', () => {
    expect(configLinter({ apiKey: 'hardcoded' }).map(issue => issue.path)).toEqual(['apiKey']);
    expect(configLinter({ apiKey: '${API_KEY}' })).toEqual([]);
  });
});

describe('ConfigManagementUtilities runtime and persistence', () => {
  it('namespaces plugin values and parses typed runtime overrides', () => {
    expect(pluginConfigNamespacer('search', { enabled: true, limit: 2 })).toEqual({ 'search.enabled': true, 'search.limit': 2 });
    expect(runtimeOverrideParser(['--model=gpt', '--limits.max=3', '--no-debug', '--tags=["a","b"]'])).toEqual({ model: 'gpt', limits: { max: 3 }, debug: false, tags: ['a', 'b'] });
  });

  it('backs up an existing config before change with an injected file adapter', async () => {
    const calls: string[][] = [];
    const backup = await configBackupOnChange('/etc/agent.json', {
      backupPath: '/tmp/agent.json.bak',
      files: {
        stat: async () => ({ mode: 0o600 }),
        copyFile: async (from, to) => { calls.push([from, to]); },
      },
    });
    expect(backup).toBe('/tmp/agent.json.bak');
    expect(calls).toEqual([['/etc/agent.json', '/tmp/agent.json.bak']]);
  });

  it('runs contiguous migrations to the requested version', async () => {
    await expect(configMigrationRunner({ value: 1 }, 1, 3, [
      { from: 1, to: 2, migrate: config => ({ ...config, value: Number(config.value) + 1 }) },
      { from: 2, to: 3, migrate: config => ({ ...config, value: Number(config.value) + 1 }) },
    ])).resolves.toEqual({ config: { value: 3 }, version: 3 });
  });

  it('watches through an injected adapter and debounces events', async () => {
    let listener: (() => void) | undefined;
    const changed = jest.fn(() => undefined);
    const watcher = configWatcher('/tmp/config.json', changed, {
      debounceMs: 5,
      files: { watch: (_file, callback) => { listener = callback; return { close: jest.fn() }; } },
    });
    listener?.();
    listener?.();
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(changed).toHaveBeenCalledTimes(1);
    await watcher.close();
  });

  it('checks supported config versions and resets to defaults while preserving selected paths', () => {
    expect(configVersionChecker(2, { current: 2 })).toMatchObject({ compatible: true, version: 2 });
    expect(configVersionChecker(3, { current: 2 }).compatible).toBe(false);
    expect(configVersionChecker(1, { current: 2 }).compatible).toBe(false);
    expect(configVersionChecker(3, { current: 1, minimum: 1, maximum: 5 })).toMatchObject({ compatible: true, version: 3 });
    expect(configVersionChecker(6, { current: 1, minimum: 1, maximum: 5 }).compatible).toBe(false);
    expect(resetConfigToDefault({ model: 'default', debug: false }, { model: 'custom', debug: true }, { preserve: ['debug'] })).toEqual({ model: 'default', debug: true });
  });
});
