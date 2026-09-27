import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool, ToolContext, ToolResult } from '../types/index.js';
import { runCaptured, truncateOutput } from './ShellTool.js';

/**
 * Dependency & Package Management tools (group 5). npm-first with pip/cargo
 * fallbacks where meaningful. Installs are medium risk; everything passes
 * through the permission manager and the security pipeline.
 */

type Input = Record<string, unknown>;

async function allow(context: ToolContext, description: string, risk: 'low' | 'medium' | 'high'): Promise<ToolResult | null> {
  const permission = await context.permissions.check({ type: 'execute_command', description, risk });
  if (permission.allowed === false) return { success: false, error: `Permission denied: ${permission.reason}` };
  return null;
}

async function detectManager(ws: string): Promise<'npm' | 'pnpm' | 'yarn' | 'pip' | 'cargo'> {
  if (await exists(path.join(ws, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(path.join(ws, 'yarn.lock'))) return 'yarn';
  if (await exists(path.join(ws, 'package.json'))) return 'npm';
  if (await exists(path.join(ws, 'requirements.txt')) || await exists(path.join(ws, 'pyproject.toml'))) return 'pip';
  if (await exists(path.join(ws, 'Cargo.toml'))) return 'cargo';
  return 'npm';
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

// 35. install_package ----------------------------------------------------------

export class InstallPackageTool implements Tool {
  name = 'install_package';
  description = 'Install a package with the detected package manager (npm/pnpm/yarn/pip/cargo). Pass dev=true for dev-dependencies.';
  inputSchema = { type: 'object', properties: { packages: { type: 'array', items: { type: 'string' } }, dev: { type: 'boolean' } }, required: ['packages'] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const packages = Array.isArray(input.packages) ? (input.packages as unknown[]).map(String) : [];
      if (!packages.length) return { success: false, error: 'packages list is required' };
      // Lightweight guard: reject clearly suspicious specs early.
      for (const pkg of packages) {
        if (!/^[@A-Za-z0-9_./-][@A-Za-z0-9_./~-]*(@[\w.^~<>=-]+)?$/.test(pkg)) {
          return { success: false, error: `Suspicious package spec rejected: ${pkg}` };
        }
      }
      const manager = await detectManager(ws);
      const dev = input.dev === true;
      const commands: Record<string, string> = {
        npm: `npm install ${dev ? '--save-dev ' : ''}${packages.join(' ')}`,
        pnpm: `pnpm add ${dev ? '-D ' : ''}${packages.join(' ')}`,
        yarn: `yarn add ${dev ? '--dev ' : ''}${packages.join(' ')}`,
        pip: `pip install ${packages.join(' ')}`,
        cargo: `cargo add ${packages.join(' ')}`,
      };
      const command = commands[manager];
      const denied = await allow(context, `Install ${packages.join(', ')} via ${manager}`, 'medium');
      if (denied) return denied;
      const r = await runCaptured(command, { cwd: ws, timeout: 300000, signal: context.signal });
      return { success: r.ok, output: r.ok
        ? `Installed via ${manager}: ${packages.join(', ')}` + (r.stdout.trim() ? `\n${truncateOutput(r.stdout.trim(), 15)}` : '')
        : truncateOutput(r.stderr, 30), metadata: { manager, exitCode: r.exitCode } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 36. check_outdated_deps ------------------------------------------------------

export class CheckOutdatedDepsTool implements Tool {
  name = 'check_outdated_deps';
  description = 'List outdated dependencies with current → wanted → latest versions.';
  inputSchema = { type: 'object', properties: {}, required: [] };

  async execute(_input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const manager = await detectManager(ws);
      const denied = await allow(context, 'Check outdated dependencies', 'low');
      if (denied) return denied;
      const commands: Record<string, string> = { npm: 'npm outdated', pnpm: 'pnpm outdated', yarn: 'yarn outdated', pip: 'pip list --outdated', cargo: 'cargo search --limit 0' };
      const r = await runCaptured(commands[manager], { cwd: ws, timeout: 120000 });
      const text = (r.stdout + '\n' + r.stderr).trim();
      // npm outdated exits 1 when outdated packages exist — that is success for us.
      const lines = text.split('\n').filter(Boolean);
      return { success: true, output: lines.length
        ? `Outdated (${manager}):\n` + truncateOutput(text, 50)
        : `All dependencies up to date ✓ (${manager})`, metadata: { manager, count: Math.max(0, lines.length - 1) } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 37. audit_vulnerabilities ----------------------------------------------------

export class AuditVulnerabilitiesTool implements Tool {
  name = 'audit_vulnerabilities';
  description = 'Scan dependencies for known vulnerabilities (npm audit / pip-audit / cargo audit) and summarize by severity.';
  inputSchema = { type: 'object', properties: {}, required: [] };

  async execute(_input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const denied = await allow(context, 'Audit dependency vulnerabilities', 'low');
      if (denied) return denied;
      const manager = await detectManager(ws);
      const candidates: Array<[string, string]> = manager === 'pip'
        ? [['pip-audit', ''], ['python -m pip_audit', '']]
        : manager === 'cargo'
          ? [['cargo audit', '']]
          : [[`${manager} audit --json`, '']];
      for (const [command] of candidates) {
        const r = await runCaptured(command, { cwd: ws, timeout: 180000 });
        if (r.exitCode === 127 || /not found|Unknown command/i.test(r.stderr)) continue;
        const text = r.stdout.trim();
        let summary = text;
        if (text.startsWith('{')) {
          try {
            const json = JSON.parse(text);
            const vulns = json.metadata?.vulnerabilities ?? json.vulnerabilities ?? {};
            summary = `Vulnerabilities by severity: ${JSON.stringify(vulns)}`;
          } catch { /* raw text */ }
        }
        const sev = (text.match(/severity/gi) ?? []).length;
        return { success: true, output: (r.ok ? 'Audit clean ✓' : 'Vulnerabilities found:') + `\n${truncateOutput(summary, 60)}`, metadata: { manager, severities: sev, exitCode: r.exitCode } };
      }
      return { success: false, error: 'No audit tool available (tried npm/pnpm/yarn audit, pip-audit, cargo audit)' };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 38. resolve_conflict_deps ----------------------------------------------------

export class ResolveConflictDepsTool implements Tool {
  name = 'resolve_conflict_deps';
  description = 'Diagnose dependency version conflicts: npm ls reports with dedupe suggestion, or pip check output. Read-only analysis first.';
  inputSchema = { type: 'object', properties: {}, required: [] };

  async execute(_input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const denied = await allow(context, 'Diagnose dependency conflicts', 'low');
      if (denied) return denied;
      const manager = await detectManager(ws);
      if (manager === 'pip') {
        const r = await runCaptured('pip check', { cwd: ws, timeout: 60000 });
        return { success: r.ok, output: r.ok ? 'No dependency conflicts ✓' : truncateOutput(r.stdout + r.stderr, 50) };
      }
      if (manager === 'cargo') {
        const r = await runCaptured('cargo tree --duplicates', { cwd: ws, timeout: 120000 });
        return { success: true, output: r.ok ? truncateOutput(r.stdout, 50) || 'No duplicate dependencies ✓' : truncateOutput(r.stderr, 30) };
      }
      const r = await runCaptured(`${manager} ls`, { cwd: ws, timeout: 120000 });
      const problems = (r.stdout + r.stderr).split('\n').filter(l => /UNMET|invalid|deduped/.test(l)).slice(0, 30);
      return { success: true, output: problems.length
        ? `Dependency issues (${problems.length}):\n${problems.join('\n')}\n\nSuggestion: run with fix=true to attempt ${manager} dedupe.`
        : 'Dependency tree looks consistent ✓', metadata: { issues: problems.length } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 39. update_lockfile ----------------------------------------------------------

export class UpdateLockfileTool implements Tool {
  name = 'update_lockfile';
  description = 'Sync the lockfile with the manifest (npm/pnpm/yarn install, pip freeze, cargo update --workspace --dry-run default).';
  inputSchema = { type: 'object', properties: { aggressive: { type: 'boolean', description: 'allow upgrading locked versions' } }, required: [] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const denied = await allow(context, 'Sync lockfile', 'medium');
      if (denied) return denied;
      const manager = await detectManager(ws);
      const commands: Record<string, string> = manager === 'pip'
        ? { pip: 'pip freeze > requirements.txt' }
        : manager === 'cargo'
          ? { cargo: input.aggressive === true ? 'cargo update' : 'cargo update --workspace --dry-run' }
          : { [manager]: input.aggressive === true ? `${manager} install` : `${manager} install --lockfile-only` };
      const command = commands[manager];
      const r = await runCaptured(command, { cwd: ws, timeout: 300000 });
      return { success: r.ok, output: r.ok ? `Lockfile synced via: ${command}` : truncateOutput(r.stderr, 30), metadata: { manager, exitCode: r.exitCode } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 40. check_license_compliance -------------------------------------------------

const LICENSE_ALLOWED = ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Unlicense', 'CC0-1.0', 'Python-2.0', 'MPL-2.0'];
const LICENSE_REVIEW = ['LGPL-2.0', 'LGPL-2.1', 'LGPL-3.0', 'EPL-1.0', 'EPL-2.0', 'CDDL-1.0'];
const LICENSE_FORBIDDEN = ['GPL-1.0', 'GPL-2.0', 'GPL-3.0', 'AGPL-1.0', 'AGPL-3.0', 'SSPL-1.0', 'GPL-2.0-or-later', 'GPL-3.0-or-later'];

export class CheckLicenseComplianceTool implements Tool {
  name = 'check_license_compliance';
  description = 'Check dependency licenses against a policy: allowed (MIT/Apache/BSD…), review (LGPL/EPL), forbidden (GPL/AGPL/SSPL).';
  inputSchema = { type: 'object', properties: {}, required: [] };

  async execute(_input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const denied = await allow(context, 'Check license compliance', 'low');
      if (denied) return denied;
      const manager = await detectManager(ws);
      if (manager === 'pip') {
        const r = await runCaptured('pip-licenses --format=json', { cwd: ws, timeout: 120000 });
        if (!r.ok) return { success: false, error: 'pip-licenses is not installed (pip install pip-licenses)' };
        const rows = JSON.parse(r.stdout) as Array<{ Name: string; License: string }>;
        return summarize(rows.map(row => ({ name: row.Name, license: row.License })));
      }
      const r = await runCaptured('npm ls --json --depth=0', { cwd: ws, timeout: 120000 });
      if (!r.ok) return { success: false, error: truncateOutput(r.stderr, 20) };
      const tree = JSON.parse(r.stdout) as { dependencies?: Record<string, { license?: string }> };
      const rows: Array<{ name: string; license: string }> = [];
      const checked = await runCaptured('npx license-checker --json --production', { cwd: ws, timeout: 180000 });
      if (checked.ok) {
        const all = JSON.parse(checked.stdout) as Record<string, { licenses: string }>;
        for (const [pkg, info] of Object.entries(all)) rows.push({ name: pkg.split('@')[0], license: info.licenses ?? 'UNKNOWN' });
      } else {
        for (const [name, info] of Object.entries(tree.dependencies ?? {})) rows.push({ name, license: info.license ?? 'UNKNOWN' });
      }
      return summarize(rows);
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

function summarize(rows: Array<{ name: string; license: string }>): ToolResult {
  const forbidden: string[] = []; const review: string[] = []; const unknown: string[] = [];
  for (const { name, license } of rows) {
    if (LICENSE_FORBIDDEN.some(l => license.includes(l))) forbidden.push(`${name} (${license})`);
    else if (LICENSE_REVIEW.some(l => license.includes(l))) review.push(`${name} (${license})`);
    else if (!license || license === 'UNKNOWN') unknown.push(name);
  }
  const clean = rows.length - forbidden.length - review.length - unknown.length;
  return { success: forbidden.length === 0, output:
    `License compliance: ${rows.length} package(s) — ${clean} allowed` +
    (review.length ? `\n\nREVIEW (${review.length}):\n  ` + review.slice(0, 15).join('\n  ') : '') +
    (forbidden.length ? `\n\nFORBIDDEN (${forbidden.length}) — do not ship:\n  ` + forbidden.slice(0, 15).join('\n  ') : '') +
    (unknown.length ? `\n\nUNKNOWN license (${unknown.length}) — verify manually:\n  ` + unknown.slice(0, 15).join(', ') : ''),
    metadata: { total: rows.length, forbidden: forbidden.length, review: review.length, policy: { allowed: LICENSE_ALLOWED.length, review: LICENSE_REVIEW.length, forbidden: LICENSE_FORBIDDEN.length } } };
}

export const DEPENDENCY_TOOLS: Tool[] = [
  new InstallPackageTool(), new CheckOutdatedDepsTool(), new AuditVulnerabilitiesTool(),
  new ResolveConflictDepsTool(), new UpdateLockfileTool(), new CheckLicenseComplianceTool(),
];
