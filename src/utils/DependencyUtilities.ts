/**
 * Dependency/package utilities (functions 301–320).
 *
 * Package managers, registries, filesystem access and credential handling are
 * adapter-injected. These helpers inspect supplied data or produce plans;
 * they never install, fetch, write or expose secrets on their own.
 */

import { createHash } from 'node:crypto';

import { ownGet } from './SafeObject.js';

export interface PackageRequest {
  name: string;
  version?: string;
  registry?: string;
  [key: string]: unknown;
}

export interface UnsupportedResult {
  supported: false;
  reason: string;
}

function unsupported(reason: string): UnsupportedResult {
  return { supported: false, reason };
}

function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function parseVersion(input: string): [number, number, number] | null {
  const match = input.trim().match(/^(?:[=v\s]*)?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareTuples(a: [number, number, number], b: [number, number, number]): number {
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

function rangeAllows(version: string, range: string): boolean {
  const candidate = parseVersion(version);
  const normalized = range.trim();
  if (!candidate || !normalized) return false;
  // A wildcard or dist-tag accepts every version: treating it as unsatisfiable
  // produced false-positive peer-dependency violations.
  if (normalized === '*' || normalized === 'latest') return true;
  if (/^\^\d+\.\d+\.\d+$/.test(normalized)) {
    const base = parseVersion(normalized.slice(1))!;
    // ^1.2.3 means >=1.2.3 <2.0.0, but ^0.2.3 means >=0.2.3 <0.3.0 and ^0.0.3 means >=0.0.3 <0.0.4.
    const upper: [number, number, number] = base[0] > 0 ? [base[0] + 1, 0, 0] : base[1] > 0 ? [0, base[1] + 1, 0] : [0, 0, base[2] + 1];
    return compareTuples(candidate, base) >= 0 && compareTuples(candidate, upper) < 0;
  }
  if (/^~\d+\.\d+\.\d+$/.test(normalized)) {
    const base = parseVersion(normalized.slice(1))!;
    return candidate[0] === base[0] && candidate[1] === base[1] && candidate[2] >= base[2];
  }
  if (/^\d+\.\d+\.\d+$/.test(normalized)) return compareVersions(version, normalized) === 0;
  const clauses = normalized.split(/\s+/).filter(Boolean);
  if (clauses.length > 1) {
    return clauses.every(clause => {
      const match = clause.match(/^(>=|>|<=|<|=)(\d+\.\d+\.\d+)$/);
      if (!match) return false;
      const comparison = compareVersions(version, match[2]);
      if (comparison === null) return false;
      return match[1] === '>=' ? comparison >= 0 : match[1] === '>' ? comparison > 0 : match[1] === '<=' ? comparison <= 0 : match[1] === '<' ? comparison < 0 : comparison === 0;
    });
  }
  return false;
}

/** 301. Install only by explicit package-manager adapter. */
export async function installPackage(
  request: PackageRequest,
  options: { install?: (request: PackageRequest) => Promise<unknown> | unknown } = {},
): Promise<unknown> {
  if (!options.install) return unsupported('Package installation requires an install adapter');
  if (!request.name.trim()) return { installed: false, error: 'Package name must not be empty' };
  return options.install({ ...request });
}

/** 302. Compare declared versions to metadata returned by an injected adapter. */
export async function checkOutdatedDeps(
  dependencies: Record<string, string>,
  options: { fetchMetadata?: (name: string, range: string) => Promise<{ latest?: string }> | { latest?: string } } = {},
): Promise<unknown> {
  if (!options.fetchMetadata) return unsupported('Outdated dependency checks require a fetchMetadata adapter');
  const report: Array<{ name: string; current: string; latest: string | null; outdated: boolean }> = [];
  for (const name of Object.keys(dependencies).sort()) {
    const metadata = await options.fetchMetadata(name, dependencies[name]);
    const latest = metadata.latest ?? null;
    report.push({ name, current: dependencies[name], latest, outdated: latest !== null && compareVersions(dependencies[name].replace(/^[^0-9]*/, ''), latest) !== 0 });
  }
  return report;
}

/** 303. Delegate vulnerability auditing; no registry or scanner is assumed. */
export async function auditVulnerabilities(
  dependencies: Record<string, string>,
  options: { audit?: (dependencies: Record<string, string>) => Promise<unknown> | unknown } = {},
): Promise<unknown> {
  if (!options.audit) return unsupported('Vulnerability auditing requires an audit adapter');
  return options.audit({ ...dependencies });
}

/** 304. Find one exact version satisfying all supported ranges. */
export function resolveVersionConflict(ranges: string[]): { resolved: boolean; version?: string; reason?: string } {
  if (ranges.length === 0) return { resolved: false, reason: 'No version ranges supplied' };
  const candidates = ranges.flatMap(range => {
    const match = range.match(/(?:\^|~|>=|<=|>|<|=)?(\d+\.\d+\.\d+)/g);
    return match ? match.map(value => value.replace(/^[^0-9]*/, '')) : [];
  }).filter((value, index, all) => all.indexOf(value) === index)
    .sort((a, b) => compareVersions(b, a) ?? 0);
  const version = candidates.find(candidate => ranges.every(range => rangeAllows(candidate, range)));
  return version ? { resolved: true, version } : { resolved: false, reason: 'No shared supported version satisfies all ranges' };
}

/** 305. Compare lockfile state and optionally write a caller-provided state. */
export async function lockfileSync(
  expected: Record<string, string>, actual: Record<string, string>,
  options: { writeLockfile?: (state: Record<string, string>) => Promise<void> } = {},
): Promise<{ inSync: boolean; changes: Array<{ name: string; expected?: string; actual?: string }>; written?: boolean; unsupported?: string }> {
  const changes = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
    .filter(name => ownGet(expected, name) !== ownGet(actual, name))
    .map(name => ({ name, ...(ownGet(expected, name) === undefined ? {} : { expected: ownGet(expected, name) }), ...(ownGet(actual, name) === undefined ? {} : { actual: ownGet(actual, name) }) }));
  if (changes.length === 0) return { inSync: true, changes, written: false };
  if (!options.writeLockfile) return { inSync: false, changes, written: false, unsupported: 'Lockfile writes require a writeLockfile adapter' };
  await options.writeLockfile({ ...expected });
  return { inSync: false, changes, written: true };
}

/** 306. Check package license metadata against an allowlist. */
export function licenseComplianceChecker(
  licenses: Record<string, string | null | undefined>, allowedLicenses: string[],
): { compliant: boolean; violations: Array<{ name: string; license: string | null; reason: string }> } {
  const allowed = new Set(allowedLicenses);
  const violations: Array<{ name: string; license: string | null; reason: string }> = [];
  for (const [name, license] of Object.entries(licenses).sort(([a], [b]) => a.localeCompare(b))) {
    if (!license) violations.push({ name, license: null, reason: 'license metadata is missing' });
    else if (!allowed.has(license)) violations.push({ name, license, reason: 'license is not allowed' });
  }
  return { compliant: violations.length === 0, violations };
}

/** 307. Identify declared names absent from all supplied source text. */
export function unusedDependencyFinder(
  dependencies: string[], sourceFiles: Record<string, string>,
): { used: string[]; unused: string[] } {
  const source = Object.values(sourceFiles).join('\n');
  const used = dependencies.filter(name => new RegExp(`(?:from|require\\s*\\(|import(?:\\s*\\()?)\\s*[\\"']${escapeRegExp(name)}(?:[\\"'/])`).test(source)).sort();
  return { used, unused: dependencies.filter(name => !used.includes(name)).sort() };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 308. Render a dependency graph as text and DOT while reporting simple cycles. */
export function dependencyGraphVisualizer(
  graph: Record<string, string[]>,
): { text: string; dot: string; cycles: string[][] } {
  const nodes = [...new Set([...Object.keys(graph), ...Object.values(graph).flat()])].sort();
  const edges = nodes.flatMap(from => (graph[from] ?? []).map(to => [from, to] as const)).sort(([a, b], [c, d]) => a.localeCompare(c) || b.localeCompare(d));
  const cycles: string[][] = [];
  const seenCycles = new Set<string>();
  for (const start of nodes) {
    const walk = (current: string, trail: string[]): void => {
      for (const next of graph[current] ?? []) {
        if (next === start && trail.length > 1) {
          const cycle = [...trail, start];
          const key = cycle.slice(0, -1).sort().join('>');
          if (!seenCycles.has(key)) { seenCycles.add(key); cycles.push(cycle); }
        } else if (!trail.includes(next) && trail.length < nodes.length) walk(next, [...trail, next]);
      }
    };
    walk(start, [start]);
  }
  cycles.sort((a, b) => a.join('>').localeCompare(b.join('>')));
  const text = nodes.length === 0 ? '(no dependencies)' : nodes.map(node => `${node}: ${(graph[node] ?? []).sort().join(', ') || '(none)'}`).join('\n');
  const dot = `digraph dependencies {\n${edges.map(([from, to]) => `  "${from}" -> "${to}";`).join('\n')}\n}`;
  return { text, dot, cycles };
}

/** 309. Calculate package file sizes through an injected byte reader. */
export async function packageSizeAnalyzer(
  files: string[], options: { readFile?: (file: string) => Promise<string | Uint8Array> | string | Uint8Array; maxBytes?: number } = {},
): Promise<{ entries: Array<{ file: string; bytes: number }>; totalBytes: number; withinLimit: boolean } | UnsupportedResult> {
  if (!options.readFile) return unsupported('Package size analysis requires a readFile adapter');
  const entries: Array<{ file: string; bytes: number }> = [];
  for (const file of files) {
    const value = await options.readFile(file);
    entries.push({ file, bytes: typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength });
  }
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  return { entries, totalBytes, withinLimit: options.maxBytes === undefined || totalBytes <= options.maxBytes };
}

/** 310. Validate installed versions against peer dependency ranges. */
export function peerDependencyValidator(
  peers: Record<string, string>, installed: Record<string, string>,
): Array<{ name: string; required: string; installed?: string }> {
  return Object.entries(peers).filter(([name, range]) => { const current = ownGet(installed, name); return !current || !rangeAllows(current, range); })
    .map(([name, required]) => ({ name, required, ...(ownGet(installed, name) === undefined ? {} : { installed: ownGet(installed, name) }) }));
}

/** 311. Resolve workspace references and report missing workspace names. */
export function monorepoWorkspaceResolver(
  workspaces: Record<string, string[]>,
): { resolved: Record<string, string[]>; missing: Array<{ workspace: string; dependency: string }> } {
  const names = new Set(Object.keys(workspaces));
  const resolved: Record<string, string[]> = {};
  const missing: Array<{ workspace: string; dependency: string }> = [];
  for (const workspace of Object.keys(workspaces).sort()) {
    resolved[workspace] = [];
    for (const dependency of workspaces[workspace]) {
      if (names.has(dependency)) resolved[workspace].push(dependency);
      else missing.push({ workspace, dependency });
    }
  }
  return { resolved, missing };
}

/** 312. Convert caret/tilde/exact specs to exact pins without network resolution. */
export function dependencyPinner(dependencies: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)).map(([name, spec]) => {
    const match = spec.match(/[~=^\s]*(\d+\.\d+\.\d+)/);
    return [name, match ? match[1] : spec];
  }));
}

/** 313. Generate a deterministic minimal SBOM component inventory. */
export function sbomGenerator(dependencies: Record<string, string>): {
  bomFormat: 'CycloneDX'; specVersion: '1.5'; components: Array<{ type: 'library'; name: string; version: string }>;
} {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    components: Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)).map(([name, version]) => ({ type: 'library' as const, name, version })),
  };
}

/** 314. Verify content against a declared sha256 or sha512 digest. */
export function packageIntegrityVerifier(content: string | Uint8Array, expected: string): { valid: boolean; algorithm?: string; actual?: string; reason?: string } {
  const match = expected.match(/^(sha256|sha512):([0-9a-f]+)$/i);
  if (!match) return { valid: false, reason: 'Expected digest format algorithm:hex' };
  const actual = createHash(match[1]).update(content).digest('hex');
  return { valid: actual === match[2].toLowerCase(), algorithm: match[1].toLowerCase(), actual };
}

/** 315. Authenticate via an adapter while stripping token/secret fields from its result. */
export async function privateRegistryAuth(
  registry: string,
  options: { authenticate?: (registry: string) => Promise<Record<string, unknown>> | Record<string, unknown> } = {},
): Promise<unknown> {
  if (!options.authenticate) return unsupported('Private registry authentication requires an authenticate adapter');
  const response = await options.authenticate(registry);
  return Object.fromEntries(Object.entries(response).filter(([key]) => !/(token|secret|password|credential|authorization)/i.test(key)));
}

/** 316. List all reachable transitive dependencies once. */
export function transitiveDependencyLister(root: string, graph: Record<string, string[]>): string[] {
  const result = new Set<string>();
  const pending = [...(ownGet(graph, root) ?? [])];
  while (pending.length) {
    const name = pending.shift()!;
    if (name === root || result.has(name)) continue;
    result.add(name);
    pending.push(...(ownGet(graph, name) ?? []));
  }
  return [...result].sort();
}

/** 317. Produce a dry-run upgrade plan; this function never installs. */
export function dependencyUpgradeSimulator(
  current: Record<string, string>, proposed: Record<string, string>,
): { dryRun: true; upgrades: Array<{ name: string; from: string; to: string }>; unsupported?: undefined } {
  return { dryRun: true, upgrades: Object.keys(proposed).filter(name => current[name] !== undefined && current[name] !== proposed[name]).sort().map(name => ({ name, from: current[name], to: proposed[name] })) };
}

/** 318. Fetch package metadata only through an explicit adapter. */
export async function packageMetadataFetcher(
  name: string,
  options: { fetchMetadata?: (name: string) => Promise<unknown> | unknown } = {},
): Promise<unknown> {
  if (!options.fetchMetadata) return unsupported('Package metadata fetching requires a fetchMetadata adapter');
  return options.fetchMetadata(name);
}

export interface DependencyPolicy {
  allowed?: string[];
  required?: string[];
  licenses?: Record<string, string | null | undefined>;
  allowedLicenses?: string[];
  versionRanges?: Record<string, string>;
}

/** 319. Enforce allowlist, required, license and version policies. */
export function dependencyPolicyEnforcer(
  dependencies: Record<string, string>, policy: DependencyPolicy,
): Array<Record<string, unknown>> {
  const violations: Array<Record<string, unknown>> = [];
  const allowed = policy.allowed ? new Set(policy.allowed) : null;
  for (const name of Object.keys(dependencies).sort()) {
    if (allowed && !allowed.has(name)) violations.push({ name, reason: 'dependency is not allowed' });
    const license = policy.licenses?.[name];
    if (license && policy.allowedLicenses && !policy.allowedLicenses.includes(license)) violations.push({ name, reason: 'license is not allowed', license });
    if (policy.versionRanges?.[name] && !rangeAllows(dependencies[name], policy.versionRanges[name])) violations.push({ name, reason: 'version is outside policy range', version: dependencies[name], required: policy.versionRanges[name] });
  }
  for (const name of [...(policy.required ?? [])].sort()) if (!(name in dependencies)) violations.push({ name, reason: 'required dependency is missing' });
  return violations;
}

/** 320. Restore prior state only through an explicit rollback adapter. */
export async function packageInstallRollback(options: {
  before: Record<string, string>;
  after: Record<string, string>;
  rollback?: (state: Record<string, string>) => Promise<void> | void;
}): Promise<{ rolledBack: boolean; supported?: false; reason?: string }> {
  if (!options.rollback) return { rolledBack: false, supported: false, reason: 'Rollback requires a rollback adapter' };
  await options.rollback({ ...options.before });
  return { rolledBack: true };
}
