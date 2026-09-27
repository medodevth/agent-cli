import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  apiDeprecationWarner,
  backwardCompatShim,
  changelogGenerator,
  configHotSwap,
  crashRecoveryLoader,
  documentationAutoGenerator,
  featureFlagToggle,
  gracefulUpgradeMigrator,
  healthCheckEndpoint,
  localizationLoader,
  onboardingWizard,
  pluginDependencyResolver,
  pluginLifecycleHooks,
  pluginSandboxIsolator,
  selfDiagnosticRunner,
  sessionExporter,
  sessionImporter,
  systemResourceMonitor,
  telemetryOptOutHandler,
  versionCompatibilityChecker,
} from '../../src/utils/MiscUtilities.js';
import type { Session } from '../../src/types/index.js';

function makeSession(): Session {
  return {
    id: 'session-1',
    timestamp: new Date('2025-01-01T00:00:00.000Z'),
    workspace: '/workspace',
    messages: [{ role: 'user', content: 'hello' }],
    toolCalls: [],
    state: { status: 'completed' },
  };
}

describe('MiscUtilities (481-500)', () => {
  it('versionCompatibilityChecker allows compatible minor updates and rejects major breaks', () => {
    expect(versionCompatibilityChecker('1.2.0', '1.9.4').compatible).toBe(true);
    expect(versionCompatibilityChecker('1.2.0', '2.0.0').compatible).toBe(false);
    expect(versionCompatibilityChecker('invalid', '2.0.0').compatible).toBe(false);
  });

  it('featureFlagToggle changes a flag without mutating the supplied defaults', () => {
    const flags = featureFlagToggle({ search: false });
    expect(flags.isEnabled('search')).toBe(false);
    expect(flags.toggle('search')).toBe(true);
    flags.set('search', false);
    flags.set('new-ui', true);
    expect(flags.snapshot()).toEqual({ search: false, 'new-ui': true });
  });

  it('healthCheckEndpoint returns a safe 503 response when a dependency is down', async () => {
    const result = await healthCheckEndpoint({ database: async () => true, cache: async () => false });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ status: 'unhealthy', checks: { database: 'healthy', cache: 'unhealthy' } });
  });

  it('gracefulUpgradeMigrator applies a contiguous sequence of injected migrations', () => {
    const result = gracefulUpgradeMigrator({ count: 1 }, '1.0.0', '1.2.0', [
      { from: '1.0.0', to: '1.1.0', migrate: data => ({ count: Number(data.count) + 1 }) },
      { from: '1.1.0', to: '1.2.0', migrate: data => ({ count: Number(data.count) * 2 }) },
    ]);
    expect(result).toEqual({ data: { count: 4 }, fromVersion: '1.0.0', toVersion: '1.2.0', applied: ['1.0.0->1.1.0', '1.1.0->1.2.0'] });
    expect(() => gracefulUpgradeMigrator({}, '1.0.0', '1.2.0', [])).toThrow(/migration/i);
  });

  it('pluginDependencyResolver returns dependency-first order and rejects cycles', () => {
    expect(pluginDependencyResolver({ app: ['db'], db: ['core'], core: [] })).toEqual(['core', 'db', 'app']);
    expect(() => pluginDependencyResolver({ a: ['b'], b: ['a'] })).toThrow(/cycle/i);
    expect(() => pluginDependencyResolver({ a: [], unused: ['missing'] })).toThrow(/unknown plugin/i);
  });

  it('pluginLifecycleHooks initializes once and disposes in reverse order', async () => {
    const calls: string[] = [];
    const lifecycle = pluginLifecycleHooks([
      { id: 'a', init: async () => { calls.push('init-a'); }, dispose: async () => { calls.push('dispose-a'); } },
      { id: 'b', init: async () => { calls.push('init-b'); }, dispose: async () => { calls.push('dispose-b'); } },
    ]);
    await lifecycle.initialize();
    await lifecycle.initialize();
    await lifecycle.dispose();
    expect(calls).toEqual(['init-a', 'init-b', 'dispose-b', 'dispose-a']);
  });

  it('configHotSwap validates and applies a new immutable config snapshot', async () => {
    const previous = { mode: 'safe', retries: 1 };
    const applied: unknown[] = [];
    const result = await configHotSwap(previous, { retries: 3 }, {
      validate: config => Number(config.retries) <= 5,
      apply: config => { applied.push(config); },
    });
    expect(result).toEqual({ previous, config: { mode: 'safe', retries: 3 }, changedKeys: ['retries'] });
    expect(applied).toEqual([{ mode: 'safe', retries: 3 }]);
    await expect(configHotSwap(previous, { retries: 9 }, { validate: () => false })).rejects.toThrow(/validation/i);
    expect(previous.retries).toBe(1);
  });

  it('sessionExporter atomically writes a session inside its allowed root and sessionImporter reads it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'misc-session-'));
    try {
      const file = await sessionExporter(makeSession(), 'session.json', { rootDir: root });
      const imported = await sessionImporter('session.json', { rootDir: root });
      expect(file).toBe(path.join(root, 'session.json'));
      expect(imported).toMatchObject({ id: 'session-1', workspace: '/workspace', messages: [{ content: 'hello' }] });
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('session export rejects a destination symlink rather than replacing its target', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'misc-session-link-'));
    const outside = path.join(root, 'outside.json');
    try {
      await fs.writeFile(outside, 'do not overwrite');
      await fs.symlink(outside, path.join(root, 'linked.json'));
      await expect(sessionExporter(makeSession(), 'linked.json', { rootDir: root })).rejects.toThrow(/symbolic link/i);
      await expect(fs.readFile(outside, 'utf8')).resolves.toBe('do not overwrite');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('session export and import reject traversal paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'misc-session-safe-'));
    try {
      await expect(sessionExporter(makeSession(), '../outside.json', { rootDir: root })).rejects.toThrow(/path/i);
      await expect(sessionImporter('../outside.json', { rootDir: root })).rejects.toThrow(/path/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('crashRecoveryLoader picks the newest valid checkpoint from an injected store', async () => {
    const selected = await crashRecoveryLoader(async () => [
      { id: 'old', savedAt: '2025-01-01T00:00:00.000Z', state: { step: 1 } },
      { id: 'invalid', savedAt: 'bad-date', state: {} },
      { id: 'new', savedAt: '2025-01-02T00:00:00.000Z', state: { step: 2 } },
    ]);
    expect(selected?.id).toBe('new');
  });

  it('telemetryOptOutHandler persists the opt-out choice without sending telemetry', async () => {
    const writes: boolean[] = [];
    const result = await telemetryOptOutHandler(true, { saveOptOut: async value => { writes.push(value); } });
    expect(result).toEqual({ optOut: true, telemetryEnabled: false, persisted: true });
    expect(writes).toEqual([true]);
  });

  it('localizationLoader falls back by locale and interpolates message variables', () => {
    const t = localizationLoader('fr-CA', {
      en: { greeting: 'Hello, {name}', onlyEnglish: 'Fallback' },
      fr: { greeting: 'Bonjour, {name}' },
    }, 'en');
    expect(t('greeting', { name: 'Ada' })).toBe('Bonjour, Ada');
    expect(t('onlyEnglish')).toBe('Fallback');
    expect(t('missing.key')).toBe('missing.key');
  });

  it('systemResourceMonitor reports injected system load and memory measurements', () => {
    expect(systemResourceMonitor(() => ({ cpuLoad1m: 2, cpuCoreCount: 4, totalMemoryBytes: 1000, freeMemoryBytes: 250, processRssBytes: 100, processHeapUsedBytes: 50 }))).toMatchObject({
      cpuLoad1m: 2, cpuLoadPerCore: 0.5, memoryUsedPercent: 75, processRssBytes: 100,
    });
  });

  it('pluginSandboxIsolator fails closed without a verified container backend', async () => {
    await expect(pluginSandboxIsolator({ id: 'unsafe' })).resolves.toMatchObject({ isolated: false });
    await expect(pluginSandboxIsolator({ id: 'plugin' }, {
      boundary: 'container', verified: true,
      run: async plugin => ({ plugin }),
    })).resolves.toMatchObject({ isolated: true, boundary: 'container', value: { plugin: { id: 'plugin' } } });
    await expect(pluginSandboxIsolator({ id: 'plugin' }, {
      boundary: 'same-process', verified: true,
      run: async () => 'not isolated',
    } as never)).resolves.toMatchObject({ isolated: false });
  });

  it('apiDeprecationWarner emits each feature warning once and includes its replacement', () => {
    const warnings: string[] = [];
    const warner = apiDeprecationWarner(message => warnings.push(message));
    expect(warner.warn('old-api', { since: '1.0', replacement: 'new-api' })).toMatch(/new-api/);
    expect(warner.warn('old-api', { since: '1.0', replacement: 'new-api' })).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it('backwardCompatShim applies matching migrations to a copy and reports them', () => {
    const original = { oldName: 'value' };
    const result = backwardCompatShim(original, [{
      id: 'rename-oldName',
      applies: data => 'oldName' in data,
      migrate: data => ({ name: data.oldName }),
    }]);
    expect(result).toEqual({ value: { name: 'value' }, applied: ['rename-oldName'] });
    expect(original).toEqual({ oldName: 'value' });
  });

  it('documentationAutoGenerator extracts exported API docs from JSDoc comments', () => {
    const docs = documentationAutoGenerator(`/** Adds two values. */\nexport function add(a: number, b: number): number { return a + b; }`);
    expect(docs).toContain('### function add(a: number, b: number): number');
    expect(docs).toContain('Adds two values.');
  });

  it('changelogGenerator groups injected changes into deterministic sections', () => {
    const changelog = changelogGenerator('1.0.0', '1.1.0', [
      { type: 'feat', description: 'add router' },
      { type: 'fix', description: 'avoid retry loop' },
      { type: 'feat', description: 'breaking config', breaking: true },
    ]);
    expect(changelog).toContain('# 1.1.0');
    expect(changelog).toContain('## Breaking Changes');
    expect(changelog).toContain('## Added');
    expect(changelog).toContain('## Fixed');
  });

  it('onboardingWizard validates answers and retries through an injected prompt', async () => {
    const answers: unknown[] = ['bad', 'good'];
    const result = await onboardingWizard([
      { id: 'workspace', validate: value => value === 'good' ? true : 'workspace must be good' },
    ], async () => answers.shift());
    expect(result).toEqual({ workspace: 'good' });
  });

  it('selfDiagnosticRunner records passing and throwing checks without aborting', async () => {
    const report = await selfDiagnosticRunner({
      config: () => true,
      provider: () => { throw new Error('not configured'); },
    });
    expect(report.overall).toBe('failed');
    expect(report.checks.config.status).toBe('passed');
    expect(report.checks.provider).toMatchObject({ status: 'failed', error: 'not configured' });
  });
});
