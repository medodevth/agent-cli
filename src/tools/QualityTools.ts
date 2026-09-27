import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool, ToolContext, ToolResult } from '../types/index.js';
import { PathValidator } from './FileTools.js';
import { runCaptured, truncateOutput } from './ShellTool.js';

/**
 * Testing & Quality tools (group 3). Every tool runs a real command through
 * runCaptured (no shell interpolation) with a bounded timeout, then parses
 * the output into a compact structured summary for the model.
 */

type Input = Record<string, unknown>;
const str = (input: Input, key: string): string => String(input[key] ?? '');

async function detectTestCommand(ws: string): Promise<string> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(ws, 'package.json'), 'utf-8'));
    const scripts = pkg.scripts ?? {};
    if (scripts.test) return 'npm test';
  } catch { /* no package.json */ }
  if (await exists(path.join(ws, 'pytest.ini')) || await exists(path.join(ws, 'tests'))) return 'python -m pytest -q';
  return 'npm test';
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

const QUALITY_TIMEOUT = 300000; // 5 min for suites

/** Shared permission check for command-running tools. */
async function allowRun(context: ToolContext, description: string, risk: 'safe' | 'low' | 'medium'): Promise<ToolResult | null> {
  const permission = await context.permissions.check({ type: 'execute_command', description, risk });
  if (permission.allowed === false) return { success: false, error: `Permission denied: ${permission.reason}` };
  return null;
}

// 18. run_tests ----------------------------------------------------------------

export interface TestSummary { suite: string; passed: number; failed: number; skipped: number; }

export function parseTestOutput(stdout: string, stderr: string): TestSummary {
  const text = stdout + '\n' + stderr;
  const summary: TestSummary = { suite: 'unknown', passed: 0, failed: 0, skipped: 0 };
  // jest-style: "Tests: 5 passed, 5 total"
  let m = text.match(/Tests:\s*([^\n]+)/);
  if (m) {
    summary.suite = 'jest-like';
    const passed = m[1].match(/(\d+)\s+passed/); if (passed) summary.passed = Number(passed[1]);
    const failed = m[1].match(/(\d+)\s+failed/); if (failed) summary.failed = Number(failed[1]);
    const skipped = m[1].match(/(\d+)\s+(?:skipped|pending)/); if (skipped) summary.skipped = Number(skipped[1]);
    return summary;
  }
  // pytest-style: "5 passed in 0.42s" / "2 failed, 10 passed"
  m = text.match(/\d+\s+(?:failed|passed)/);
  if (m) {
    summary.suite = 'pytest-like';
    const failed = text.match(/(\d+)\s+failed/); if (failed) summary.failed = Number(failed[1]);
    const passed = text.match(/(\d+)\s+passed/); if (passed) summary.passed = Number(passed[1]);
    const skipped = text.match(/(\d+)\s+skipped/); if (skipped) summary.skipped = Number(skipped[1]);
    return summary;
  }
  // go test: "--- FAIL: TestX" / "ok  package"
  const goFails = (text.match(/--- FAIL:/g) ?? []).length;
  const goOks = (text.match(/^ok\s+/gm) ?? []).length;
  if (goFails || goOks) {
    summary.suite = 'go-test';
    summary.failed = goFails; summary.passed = goOks;
  }
  return summary;
}

export class RunTestsTool implements Tool {
  name = 'run_tests';
  description = 'Run the project test suite and return a parsed pass/fail summary plus the first failure details.';
  inputSchema = { type: 'object', properties: { command: { type: 'string', description: 'override test command' }, timeout: { type: 'number', description: 'seconds, default 300' } }, required: [] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const command = str(input, 'command') || await detectTestCommand(ws);
      const denied = await allowRun(context, `Run tests: ${command}`, 'low');
      if (denied) return denied;
      const r = await runCaptured(command, { cwd: ws, timeout: Number(input.timeout) ? Number(input.timeout) * 1000 : QUALITY_TIMEOUT, signal: context.signal });
      const summary = parseTestOutput(r.stdout, r.stderr);
      const failedBlock = extractFailureBlock(r.stdout + '\n' + r.stderr);
      const status = !r.ok ? 'FAILED' : 'PASSED';
      return { success: true, output:
        `Tests ${status} (${summary.suite}): ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped` +
        (failedBlock ? `\n\nFirst failure:\n${failedBlock}` : '') +
        `\n\nRaw tail:\n${truncateOutput((r.stdout + '\n' + r.stderr).trim(), 40)}`,
        metadata: { exitCode: r.exitCode, ...summary } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

function extractFailureBlock(text: string, maxLines = 25): string {
  const lines = text.split('\n');
  const idx = lines.findIndex(l => /✕|FAIL|AssertionError|Error:/.test(l));
  if (idx < 0) return '';
  return lines.slice(idx, idx + maxLines).join('\n').slice(0, 2000);
}

// 19. run_single_test ----------------------------------------------------------

export class RunSingleTestTool implements Tool {
  name = 'run_single_test';
  description = 'Run one test file (and optionally one test name pattern) for a tight feedback loop.';
  inputSchema = { type: 'object', properties: { file: { type: 'string' }, testName: { type: 'string', description: 'optional -t pattern' } }, required: ['file'] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const file = PathValidator.sanitizePath(str(input, 'file'));
      const testName = str(input, 'testName');
      const denied = await allowRun(context, `Run single test ${file}`, 'low');
      if (denied) return denied;
      const command = /\.py$/.test(file)
        ? `python -m pytest ${file}${testName ? ` -k "${testName}"` : ''} -q`
        : `npx jest ${file}${testName ? ` -t "${testName}"` : ''}`;
      const r = await runCaptured(command, { cwd: ws, timeout: 120000, signal: context.signal });
      const summary = parseTestOutput(r.stdout, r.stderr);
      return { success: true, output:
        `${file}${testName ? ` :: ${testName}` : ''} → ${r.ok ? 'PASSED' : 'FAILED'} (${summary.suite}: ${summary.passed}p/${summary.failed}f)` +
        (r.ok ? '' : `\n\n${extractFailureBlock(r.stdout + '\n' + r.stderr)}`),
        metadata: { exitCode: r.exitCode } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 20. generate_test ------------------------------------------------------------

export class GenerateTestTool implements Tool {
  name = 'generate_test';
  description = 'Scaffold a unit-test file for a source file: reads its symbols and emits a runnable skeleton with one describe/it per exported function (filled in by the agent).';
  inputSchema = { type: 'object', properties: { path: { type: 'string' }, outPath: { type: 'string', description: 'override output path' } }, required: ['path'] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const srcRel = PathValidator.sanitizePath(str(input, 'path'));
      const source = await fs.readFile(path.resolve(ws, srcRel), 'utf-8');
      const names = [...new Set([...source.matchAll(/^\s*export\s+(?:async\s+)?(?:function|class|const)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]))];
      if (!names.length) return { success: false, error: `No exported functions/classes found in ${srcRel}` };
      const outRel = str(input, 'outPath') || srcRel.replace(/\.(ts|tsx|js|jsx|mjs)$/, '.test.ts').replace(/^src\//, 'tests/');
      const outAbs = path.resolve(ws, outRel);
      try { await fs.access(outAbs); return { success: false, error: `Refusing to overwrite existing test file: ${outRel}` }; } catch { /* new file ok */ }
      const denied = await allowRun(context, `Create test scaffold ${outRel}`, 'medium');
      if (denied) return denied;
      const importPath = path.relative(path.dirname(outAbs), path.resolve(ws, srcRel)).split(path.sep).join('/').replace(/\.(ts|tsx|js|jsx|mjs)$/, '');
      const relImport = importPath.startsWith('.') ? importPath : './' + importPath;
      const body = [
        `// Scaffold generated by IRIS generate_test — fill in the assertions.`,
        `import { describe, it, expect } from '@jest/globals';`,
        `import { ${names.join(', ')} } from '${relImport}';`,
        ``,
        ...names.flatMap(name => [
          `describe('${name}', () => {`,
          `  it('works for the happy path', () => {`,
          `    expect(${name}).toBeDefined();`,
          `    // TODO: call ${name} with representative input and assert the result`,
          `  });`,
          `});`,
          ``,
        ]),
      ].join('\n');
      await fs.mkdir(path.dirname(outAbs), { recursive: true });
      await fs.writeFile(outAbs, body, 'utf-8');
      return { success: true, output: `Created ${outRel} with ${names.length} describe block(s): ${names.join(', ')}`, metadata: { outPath: outRel, symbols: names } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 21. coverage_report ----------------------------------------------------------

export class CoverageReportTool implements Tool {
  name = 'coverage_report';
  description = 'Run tests with coverage (nyc/istanbul-style or pytest-cov) and report overall coverage plus the least-covered files.';
  inputSchema = { type: 'object', properties: { timeout: { type: 'number' } }, required: [] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const denied = await allowRun(context, 'Run test coverage', 'low');
      if (denied) return denied;
      const isPy = !(await exists(path.join(ws, 'package.json')));
      const command = isPy ? 'python -m pytest --cov=. --cov-report=term -q' : 'npx jest --coverage --silent';
      const r = await runCaptured(command, { cwd: ws, timeout: (Number(input.timeout) || 600) * 1000, signal: context.signal });
      const text = r.stdout + '\n' + r.stderr;
      const pct = text.match(/All files[^\d]*(\d+(?:\.\d+)?)%/) ?? text.match(/TOTAL[^\d]*(\d+(?:\.\d+)?)%/);
      const worst = text.split('\n').filter(l => /\d+(?:\.\d+)?%/.test(l) && !/All files|TOTAL/.test(l))
        .sort((a, b) => pctOf(a) - pctOf(b)).slice(0, 10);
      return { success: true, output:
        (pct ? `Overall coverage: ${pct[1]}%\n\n` : 'Coverage run finished.\n\n') +
        (worst.length ? `Least covered files:\n${worst.join('\n')}` : truncateOutput(text, 30)),
        metadata: { exitCode: r.exitCode, coverage: pct?.[1] } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

function pctOf(line: string): number {
  const m = line.match(/(\d+(?:\.\d+)?)%/);
  return m ? Number(m[1]) : 100;
}

// 22. run_linter ---------------------------------------------------------------

export class RunLinterTool implements Tool {
  name = 'run_linter';
  description = 'Run the project linter (eslint / ruff / pylint) and summarize issue counts; optionally auto-fix.';
  inputSchema = { type: 'object', properties: { fix: { type: 'boolean' }, path: { type: 'string' } }, required: [] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const fix = input.fix === true;
      const denied = await allowRun(context, `Run linter${fix ? ' with auto-fix' : ''}`, fix ? 'medium' : 'low');
      if (denied) return denied;
      const target = str(input, 'path') || '.';
      const candidates = fix
        ? [`npx eslint ${target} --fix`, `python -m ruff check ${target} --fix`]
        : [`npx eslint ${target}`, `python -m ruff check ${target}`, `python -m pylint ${target} --exit-zero`];
      for (const command of candidates) {
        const r = await runCaptured(command, { cwd: ws, timeout: 180000, signal: context.signal });
        if (r.exitCode === 127 || /not found|No module named/.test(r.stderr)) continue; // linter absent
        const text = r.stdout + '\n' + r.stderr;
        const errors = (text.match(/\berror\b/gi) ?? []).length;
        const warnings = (text.match(/\bwarning\b/gi) ?? []).length;
        return { success: true, output:
          `Linter ${fix ? '(auto-fix) ' : ''}${r.ok ? 'clean ✓' : `found ${errors} error(s), ${warnings} warning(s)`}\n\n` + truncateOutput(text.trim(), 50),
          metadata: { exitCode: r.exitCode, errors, warnings, fixed: fix } };
      }
      return { success: false, error: 'No linter found (tried eslint, ruff, pylint)' };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 23. run_typecheck ------------------------------------------------------------

export class RunTypecheckTool implements Tool {
  name = 'run_typecheck';
  description = 'Run the type checker (tsc --noEmit / mypy) and list type errors compactly.';
  inputSchema = { type: 'object', properties: { timeout: { type: 'number' } }, required: [] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const denied = await allowRun(context, 'Run typecheck', 'low');
      if (denied) return denied;
      const candidates: Array<[string, RegExp]> = [
        ['npx tsc --noEmit', /not found/],
        ['python -m mypy .', /No module named/],
      ];
      for (const [command, absentRe] of candidates) {
        const r = await runCaptured(command, { cwd: ws, timeout: (Number(input.timeout) || 180) * 1000, signal: context.signal });
        if (r.exitCode === 127 || absentRe.test(r.stderr)) continue;
        const text = (r.stdout + '\n' + r.stderr).trim();
        const errCount = (text.match(/error TS\d+|error:/g) ?? []).length;
        return { success: true, output: errCount
          ? `Typecheck FAILED: ${errCount} error(s)\n` + truncateOutput(text, 50)
          : `Typecheck clean ✓`,
          metadata: { exitCode: r.exitCode, errors: errCount } };
      }
      return { success: false, error: 'No type checker found (tried tsc, mypy)' };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 24. run_formatter ------------------------------------------------------------

export class RunFormatterTool implements Tool {
  name = 'run_formatter';
  description = 'Format code with the project formatter (prettier / black / gofmt).';
  inputSchema = { type: 'object', properties: { path: { type: 'string' }, check: { type: 'boolean', description: 'check only, do not write' } }, required: [] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const target = str(input, 'path') || '.';
      const check = input.check === true;
      const denied = await allowRun(context, `${check ? 'Check' : 'Apply'} formatter on ${target}`, check ? 'low' : 'medium');
      if (denied) return denied;
      const candidates = check
        ? [`npx prettier --check ${target}`, `python -m black --check ${target}`]
        : [`npx prettier --write ${target}`, `python -m black ${target}`];
      for (const command of candidates) {
        const r = await runCaptured(command, { cwd: ws, timeout: 120000, signal: context.signal });
        if (r.exitCode === 127 || /not found|No module named/.test(r.stderr)) continue;
        const text = (r.stdout + '\n' + r.stderr).trim();
        return { success: true, output: (check ? 'Format check:\n' : 'Formatted:\n') + truncateOutput(text, 30), metadata: { exitCode: r.exitCode } };
      }
      return { success: false, error: 'No formatter found (tried prettier, black)' };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 25. static_analysis ----------------------------------------------------------

export class StaticAnalysisTool implements Tool {
  name = 'static_analysis';
  description = 'Run a security-focused static scan (semgrep / bandit if installed; built-in secret & danger-pattern scan otherwise).';
  inputSchema = { type: 'object', properties: { path: { type: 'string' } }, required: [] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const denied = await allowRun(context, 'Run security static analysis', 'low');
      if (denied) return denied;
      const target = str(input, 'path') || '.';
      for (const [command, absentRe] of [['semgrep scan --config auto --quiet', /not found/], ['python -m bandit -r ' + target, /No module named/]] as const) {
        const r = await runCaptured(command, { cwd: ws, timeout: 300000, signal: context.signal });
        if (r.exitCode === 127 || absentRe.test(r.stderr)) continue;
        return { success: true, output: 'Security scan results:\n' + truncateOutput((r.stdout + '\n' + r.stderr).trim(), 60), metadata: { tool: command.split(' ')[0], exitCode: r.exitCode } };
      }
      // Built-in fallback: secret + danger pattern scan (same rules as L1 guard).
      const patterns: Array<[string, RegExp]> = [
        ['hardcoded api key', /\b(sk|pk)-[A-Za-z0-9_-]{16,}\b/],
        ['github token', /\bghp_[A-Za-z0-9]{20,}\b/],
        ['aws key', /\bAKIA[0-9A-Z]{16}\b/],
        ['password literal', /password\s*[:=]\s*['"][^'"]{6,}['"]/i],
        ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
        ['eval usage', /\beval\s*\(/],
        ['shell true injection risk', /child_process[\s\S]{0,40}shell:\s*true/],
      ];
      const { listWorkspaceFiles } = await import('./CodeNavShared.js');
      const files = await listWorkspaceFiles(ws, undefined, 600);
      const findings: string[] = [];
      for (const file of files) {
        let source: string;
        try { source = await fs.readFile(file, 'utf-8'); } catch { continue; }
        const rel = path.relative(ws, file);
        for (const [label, re] of patterns) {
          const lines = source.split('\n');
          lines.forEach((line, i) => {
            if (re.test(line) && !/test|spec|\.md/i.test(rel)) findings.push(`${rel}:${i + 1} — ${label}`);
          });
        }
        if (findings.length > 60) break;
      }
      return { success: true, output: findings.length
        ? `Built-in scan: ${findings.length} finding(s):\n` + findings.slice(0, 40).join('\n')
        : 'Built-in scan: no secrets or danger patterns found ✓',
        metadata: { tool: 'builtin', findings: findings.length } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 26. mutation_test ------------------------------------------------------------

export class MutationTestTool implements Tool {
  name = 'mutation_test';
  description = 'Bounded mutation check: flips comparison/logic operators in one file, re-runs the test suite per mutant, and reports the kill score (how good the tests really are).';
  inputSchema = { type: 'object', properties: { file: { type: 'string' }, testCommand: { type: 'string' }, maxMutants: { type: 'number', description: 'default 8, max 20' } }, required: ['file'] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const fileRel = PathValidator.sanitizePath(str(input, 'file'));
      const abs = path.resolve(ws, fileRel);
      const original = await fs.readFile(abs, 'utf-8');
      const maxMutants = Math.min(Number(input.maxMutants) || 8, 20);
      const testCommand = str(input, 'testCommand') || await detectTestCommand(ws);
      const denied = await allowRun(context, `Mutation test ${fileRel} (max ${maxMutants} mutants)`, 'medium');
      if (denied) return denied;
      // Apply mutants one at a time with full restoration between runs.
      let killed = 0; let survived = 0; const details: string[] = [];
      const mutations: Array<[RegExp, string]> = [[/<=/g, '<'], [/>=/g, '>'], [/===/g, '!=='], [/&&/g, '||']];
      let applied = 0;
      outer: for (const [re, replacement] of mutations) {
        const sites = original.match(re) ?? [];
        for (let i = 0; i < sites.length; i++) {
          if (applied >= maxMutants) break outer;
          let occurrence = -1;
          const mutated = original.replace(re, match => { occurrence++; return occurrence === i ? replacement : match; });
          await fs.writeFile(abs, mutated, 'utf-8');
          const r = await runCaptured(testCommand, { cwd: ws, timeout: 180000 });
          if (r.ok) { survived++; details.push(`SURVIVED: ${re.source} → ${replacement} (site ${i + 1}) — test suite still green, tests may be weak here`); }
          else { killed++; }
          applied++;
        }
      }
      await fs.writeFile(abs, original, 'utf-8'); // always restore
      const total = killed + survived;
      return { success: true, output: total === 0
        ? 'No mutable operators found in target file'
        : `Mutation score: ${killed}/${total} killed (${Math.round((killed / total) * 100)}%)\n${details.slice(0, 10).join('\n')}`,
        metadata: { killed, survived, total, restored: true } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

export const QUALITY_TOOLS: Tool[] = [
  new RunTestsTool(), new RunSingleTestTool(), new GenerateTestTool(), new CoverageReportTool(),
  new RunLinterTool(), new RunTypecheckTool(), new RunFormatterTool(), new StaticAnalysisTool(),
  new MutationTestTool(),
];
