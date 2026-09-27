import {
  auditVulnerabilities, checkOutdatedDeps, dependencyGraphVisualizer, dependencyPinner,
  dependencyPolicyEnforcer, dependencyUpgradeSimulator, installPackage, licenseComplianceChecker,
  lockfileSync, monorepoWorkspaceResolver, packageIntegrityVerifier, packageInstallRollback,
  packageMetadataFetcher, packageSizeAnalyzer, peerDependencyValidator, privateRegistryAuth,
  resolveVersionConflict, sbomGenerator, transitiveDependencyLister, unusedDependencyFinder,
} from '../../src/utils/DependencyUtilities.js';

describe('installPackage', () => {
  it('only invokes a supplied installer and refuses execution without one', async () => {
    const result = await installPackage({ name: 'left-pad', version: '^1.0.0' }, {
      install: async request => ({ installed: true, request }),
    });
    expect(result).toMatchObject({ installed: true, request: { name: 'left-pad', version: '^1.0.0' } });
    expect(await installPackage({ name: 'left-pad' })).toMatchObject({ supported: false });
  });
});

describe('checkOutdatedDeps', () => {
  it('compares declared and registry versions without fetching implicitly', async () => {
    const report = await checkOutdatedDeps({ a: '^1.0.0', b: '2.0.0' }, {
      fetchMetadata: async name => ({ latest: name === 'a' ? '1.2.0' : '3.0.0' }),
    });
    expect(report).toEqual([
      { name: 'a', current: '^1.0.0', latest: '1.2.0', outdated: true },
      { name: 'b', current: '2.0.0', latest: '3.0.0', outdated: true },
    ]);
    expect(await checkOutdatedDeps({ a: '1.0.0' })).toMatchObject({ supported: false });
  });
});

describe('auditVulnerabilities', () => {
  it('passes dependency data to an explicit auditor', async () => {
    expect(await auditVulnerabilities({ a: '1.0.0' }, { audit: async dependencies => ({ count: Object.keys(dependencies).length }) })).toEqual({ count: 1 });
    expect(await auditVulnerabilities({})).toMatchObject({ supported: false });
  });
});

describe('resolveVersionConflict', () => {
  it('chooses the highest shared semver version when ranges allow one', () => {
    expect(resolveVersionConflict(['^1.2.0', '>=1.4.0 <2.0.0'])).toEqual({ resolved: true, version: '1.4.0' });
    expect(resolveVersionConflict(['^1.0.0', '^2.0.0']).resolved).toBe(false);
    expect(resolveVersionConflict(['latest', '*']).resolved).toBe(false);
  });
});

describe('lockfileSync', () => {
  it('computes drift and writes only through an injected adapter', async () => {
    const result = await lockfileSync({ a: '1.0.0' }, { a: '1.1.0' });
    expect(result.inSync).toBe(false);
    expect(result.changes).toEqual([{ name: 'a', expected: '1.0.0', actual: '1.1.0' }]);
    const writes: unknown[] = [];
    await lockfileSync({ a: '1.0.0' }, { a: '1.1.0' }, { writeLockfile: async value => { writes.push(value); } });
    expect(writes).toEqual([{ a: '1.0.0' }]);
  });
});

describe('licenseComplianceChecker', () => {
  it('reports forbidden and missing license metadata', () => {
    expect(licenseComplianceChecker({ a: 'MIT', b: 'GPL-3.0', c: null }, ['MIT'])).toEqual({ compliant: false, violations: [
      { name: 'b', license: 'GPL-3.0', reason: 'license is not allowed' },
      { name: 'c', license: null, reason: 'license metadata is missing' },
    ] });
  });
});

describe('unusedDependencyFinder', () => {
  it('matches declared packages to supplied source text', () => {
    expect(unusedDependencyFinder(['react', 'lodash'], { 'src/a.ts': "import React from 'react'" })).toEqual({ used: ['react'], unused: ['lodash'] });
  });
});

describe('dependencyGraphVisualizer', () => {
  it('renders a stable tree and reports cycles rather than recursing forever', () => {
    const result = dependencyGraphVisualizer({ a: ['b'], b: ['a'] });
    expect(result.cycles).toEqual([['a', 'b', 'a']]);
    expect(result.text).toContain('a');
    expect(result.dot).toContain('"a" -> "b"');
  });
  it('renders an empty dependency graph', () => expect(dependencyGraphVisualizer({}).text).toBe('(no dependencies)'));
});

describe('packageSizeAnalyzer', () => {
  it('measures provided files via an injected reader and honors an optional limit', async () => {
    const report = await packageSizeAnalyzer(['a.js', 'b.js'], { readFile: async file => file === 'a.js' ? '12345' : 'abc', maxBytes: 6 });
    expect((report as { totalBytes: number; withinLimit: boolean }).totalBytes).toBe(8);
    expect((report as { totalBytes: number; withinLimit: boolean }).withinLimit).toBe(false);
    expect(await packageSizeAnalyzer(['a.js'])).toMatchObject({ supported: false });
  });
});

describe('peerDependencyValidator', () => {
  it('reports installed versions outside peer ranges', () => {
    expect(peerDependencyValidator({ react: '^18.0.0' }, { react: '19.0.0' })).toEqual([{ name: 'react', required: '^18.0.0', installed: '19.0.0' }]);
  });
});

describe('monorepoWorkspaceResolver', () => {
  it('resolves dependency names to workspaces and reports missing names', () => {
    expect(monorepoWorkspaceResolver({ app: ['lib'], lib: [] })).toEqual({ resolved: { app: ['lib'], lib: [] }, missing: [] });
    expect(monorepoWorkspaceResolver({ app: ['absent'] })).toEqual({ resolved: { app: [] }, missing: [{ workspace: 'app', dependency: 'absent' }] });
  });
});

describe('dependencyPinner', () => {
  it('normalizes package version specs to exact pins', () => {
    expect(dependencyPinner({ a: '^1.2.3', b: '~2.0.0', c: '3.0.0' })).toEqual({ a: '1.2.3', b: '2.0.0', c: '3.0.0' });
  });
});

describe('sbomGenerator', () => {
  it('creates a sorted CycloneDX-like component inventory', () => {
    expect(sbomGenerator({ b: '2.0.0', a: '1.0.0' })).toMatchObject({ components: [
      { name: 'a', version: '1.0.0', type: 'library' }, { name: 'b', version: '2.0.0', type: 'library' },
    ] });
  });
});

describe('packageIntegrityVerifier', () => {
  it('verifies SHA-256 digests without reading local files', () => {
    expect(packageIntegrityVerifier('hello', 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824').valid).toBe(true);
    expect(packageIntegrityVerifier('hello', 'sha256:bad').valid).toBe(false);
  });
});

describe('privateRegistryAuth', () => {
  it('requires an explicit auth adapter and never returns credential material', async () => {
    const calls: string[] = [];
    const result = await privateRegistryAuth('https://registry.example', { authenticate: async registry => { calls.push(registry); return { authenticated: true, token: 'secret' }; } });
    expect(calls).toEqual(['https://registry.example']);
    expect(result).toEqual({ authenticated: true });
    expect(await privateRegistryAuth('https://registry.example')).toMatchObject({ supported: false });
  });
});

describe('transitiveDependencyLister', () => {
  it('returns each reachable package once and excludes the root', () => expect(transitiveDependencyLister('a', { a: ['b', 'c'], b: ['c'], c: [] })).toEqual(['b', 'c']));
});

describe('dependencyUpgradeSimulator', () => {
  it('produces a dry-run plan without invoking an installer', () => {
    expect(dependencyUpgradeSimulator({ a: '1.0.0' }, { a: '2.0.0' })).toEqual({ dryRun: true, upgrades: [{ name: 'a', from: '1.0.0', to: '2.0.0' }], unsupported: undefined });
  });
});

describe('packageMetadataFetcher', () => {
  it('fetches only through an injected metadata adapter', async () => {
    expect(await packageMetadataFetcher('pkg', { fetchMetadata: async () => ({ version: '1.0.0' }) })).toEqual({ version: '1.0.0' });
    expect(await packageMetadataFetcher('pkg')).toMatchObject({ supported: false });
  });
});

describe('dependencyPolicyEnforcer', () => {
  it('reports missing, disallowed and license violations', () => {
    expect(dependencyPolicyEnforcer({ a: '1.2.0', b: '2.0.0', c: '1.0.0' }, {
      allowed: ['a', 'c'], licenses: { a: 'MIT', b: 'MIT', c: 'GPL-3.0' }, allowedLicenses: ['MIT'], required: ['a', 'b', 'missing'], versionRanges: { a: '^1.0.0' },
    })).toEqual([
      { name: 'b', reason: 'dependency is not allowed' },
      { name: 'c', reason: 'license is not allowed', license: 'GPL-3.0' },
      { name: 'missing', reason: 'required dependency is missing' },
    ]);
  });
});

describe('packageInstallRollback', () => {
  it('restores prior package state through an injected rollback adapter', async () => {
    const restored: unknown[] = [];
    const result = await packageInstallRollback({ before: { a: '1.0.0' }, after: { a: '2.0.0' }, rollback: async state => { restored.push(state); } });
    expect(restored).toEqual([{ a: '1.0.0' }]);
    expect(result).toEqual({ rolledBack: true });
    expect(await packageInstallRollback({ before: {}, after: {} })).toMatchObject({ rolledBack: false, supported: false });
  });
});
