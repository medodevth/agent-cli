import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { FS_OPS_TOOLS } from '../../src/tools/FsOpsTools.js';
import { CODE_NAV_TOOLS } from '../../src/tools/CodeNavTools.js';
import { QUALITY_TOOLS, parseTestOutput } from '../../src/tools/QualityTools.js';
import { GIT_FLOW_TOOLS } from '../../src/tools/GitFlowTools.js';
import { DEPENDENCY_TOOLS } from '../../src/tools/DependencyTools.js';
import { BUILD_DEPLOY_TOOLS, parseBuildErrors as pbe } from '../../src/tools/BuildDeployTools.js';
import { WEB_API_TOOLS, isBlockedHost } from '../../src/tools/WebApiTools.js';
import { Tool, ToolContext, ToolResult } from '../../src/types/index.js';

async function tmpWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'iris-tools-'));
}

function context(ws: string): ToolContext {
  return {
    workspaceRoot: ws,
    permissions: { check: async () => ({ allowed: true }), requestApproval: async () => true },
    currentState: { status: 'idle', history: [], conversationMessages: [], iterationCount: 0, metadata: {} },
  } as unknown as ToolContext;
}

function find(tools: Tool[], name: string): Tool {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool;
}

async function run(tool: Tool, input: Record<string, unknown>, ws: string): Promise<ToolResult> {
  return tool.execute(input, context(ws));
}

describe('FsOpsTools', () => {
  it('move_file relocates and rewrites relative imports', async () => {
    const ws = await tmpWorkspace();
    await fs.mkdir(path.join(ws, 'src'), { recursive: true });
    await fs.writeFile(path.join(ws, 'src', 'util.ts'), 'export const add = (a: number, b: number) => a + b;\n');
    await fs.writeFile(path.join(ws, 'src', 'app.ts'), `import { add } from './util';\nconsole.log(add(1, 2));\n`);
    const result = await run(find(FS_OPS_TOOLS, 'move_file'), { from: 'src/util.ts', to: 'src/lib/util.ts' }, ws);
    expect(result.success).toBe(true);
    const app = await fs.readFile(path.join(ws, 'src', 'app.ts'), 'utf-8');
    expect(app).toContain("'./lib/util'");
    expect(await fs.stat(path.join(ws, 'src', 'lib', 'util.ts'))).toBeTruthy();
  });

  it('delete_file removes a file and refuses non-empty directories', async () => {
    const ws = await tmpWorkspace();
    await fs.writeFile(path.join(ws, 'gone.txt'), 'bye');
    const ok = await run(find(FS_OPS_TOOLS, 'delete_file'), { path: 'gone.txt' }, ws);
    expect(ok.success).toBe(true);
    await fs.mkdir(path.join(ws, 'full'));
    await fs.writeFile(path.join(ws, 'full', 'x.txt'), 'x');
    const blocked = await run(find(FS_OPS_TOOLS, 'delete_file'), { path: 'full' }, ws);
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('not empty');
  });

  it('copy_file copies content', async () => {
    const ws = await tmpWorkspace();
    await fs.writeFile(path.join(ws, 'a.txt'), 'content');
    const result = await run(find(FS_OPS_TOOLS, 'copy_file'), { from: 'a.txt', to: 'deep/b.txt' }, ws);
    expect(result.success).toBe(true);
    expect(await fs.readFile(path.join(ws, 'deep', 'b.txt'), 'utf-8')).toBe('content');
  });

  it('diff_files reports differences', async () => {
    const ws = await tmpWorkspace();
    await fs.writeFile(path.join(ws, 'a.txt'), 'line1\nline2\n');
    await fs.writeFile(path.join(ws, 'b.txt'), 'line1\nCHANGED\n');
    const result = await run(find(FS_OPS_TOOLS, 'diff_files'), { fileA: 'a.txt', fileB: 'b.txt' }, ws);
    expect(result.success).toBe(true);
    expect(result.output).toContain('CHANGED');
  });

  it('find_and_replace previews by default then applies', async () => {
    const ws = await tmpWorkspace();
    await fs.mkdir(path.join(ws, 'src'), { recursive: true });
    await fs.writeFile(path.join(ws, 'src', 'x.ts'), 'const oldName = 1;\n');
    const preview = await run(find(FS_OPS_TOOLS, 'find_and_replace'), { pattern: 'oldName', replacement: 'newName', include: 'src/*.ts' }, ws);
    expect(preview.output).toContain('PREVIEW');
    expect(await fs.readFile(path.join(ws, 'src', 'x.ts'), 'utf-8')).toContain('oldName');
    const apply = await run(find(FS_OPS_TOOLS, 'find_and_replace'), { pattern: 'oldName', replacement: 'newName', include: 'src/*.ts', dryRun: false }, ws);
    expect(apply.success).toBe(true);
    expect(await fs.readFile(path.join(ws, 'src', 'x.ts'), 'utf-8')).toContain('newName');
  });

  it('file_stat reports size and lines', async () => {
    const ws = await tmpWorkspace();
    await fs.writeFile(path.join(ws, 'f.txt'), 'a\nb\nc\n');
    const result = await run(find(FS_OPS_TOOLS, 'file_stat'), { path: 'f.txt' }, ws);
    expect(result.output).toContain('lines: 4'); // trailing newline
    expect(result.output).toContain('size: 6 bytes');
  });

  it('create_directory_structure scaffolds from template', async () => {
    const ws = await tmpWorkspace();
    const result = await run(find(FS_OPS_TOOLS, 'create_directory_structure'), { root: 'pkg', template: 'ts-lib' }, ws);
    expect(result.success).toBe(true);
    expect(await fs.access(path.join(ws, 'pkg', 'src', 'index.ts')).then(() => true).catch(() => false)).toBe(true);
  });

  it('watch_files returns when nothing changes', async () => {
    const ws = await tmpWorkspace();
    await fs.mkdir(path.join(ws, 'src'), { recursive: true });
    const result = await run(find(FS_OPS_TOOLS, 'watch_files'), { path: 'src', seconds: 1 }, ws);
    expect(result.success).toBe(true);
    expect(result.output).toContain('No changes');
  });
});

describe('CodeNavTools', () => {
  it('get_symbols lists declarations with lines', async () => {
    const ws = await tmpWorkspace();
    await fs.mkdir(path.join(ws, 'src'), { recursive: true });
    await fs.writeFile(path.join(ws, 'src', 'm.ts'), 'export class Foo {}\nexport function bar() {}\nconst baz = () => 1;\n');
    const result = await run(find(CODE_NAV_TOOLS, 'get_symbols'), { path: 'src/m.ts' }, ws);
    expect(result.output).toContain('[class] Foo');
    expect(result.output).toContain('[function] bar');
  });

  it('find_definition and find_references locate a symbol', async () => {
    const ws = await tmpWorkspace();
    await fs.mkdir(path.join(ws, 'src'), { recursive: true });
    await fs.writeFile(path.join(ws, 'src', 'a.ts'), 'export function helper() { return 1; }\n');
    await fs.writeFile(path.join(ws, 'src', 'b.ts'), "import { helper } from './a';\nconst x = helper();\n");
    const def = await run(find(CODE_NAV_TOOLS, 'find_definition'), { symbol: 'helper' }, ws);
    expect(def.output).toMatch(/a\.ts:\d+/);
    const refs = await run(find(CODE_NAV_TOOLS, 'find_references'), { symbol: 'helper' }, ws);
    expect(refs.output).toContain('b.ts');
  });

  it('get_dependency_graph maps local imports', async () => {
    const ws = await tmpWorkspace();
    await fs.mkdir(path.join(ws, 'src'), { recursive: true });
    await fs.writeFile(path.join(ws, 'src', 'a.ts'), 'export const x = 1;\n');
    await fs.writeFile(path.join(ws, 'src', 'b.ts'), "import { x } from './a';\nconsole.log(x);\n");
    const result = await run(find(CODE_NAV_TOOLS, 'get_dependency_graph'), {}, ws);
    expect(result.output).toContain('b.ts');
  });

  it('find_dead_code flags unused exports', async () => {
    const ws = await tmpWorkspace();
    await fs.mkdir(path.join(ws, 'src'), { recursive: true });
    await fs.writeFile(path.join(ws, 'src', 'a.ts'), 'export function used() { return 1; }\nexport function unusedFn() { return 2; }\n');
    await fs.writeFile(path.join(ws, 'src', 'b.ts'), "import { used } from './a';\nconsole.log(used());\n");
    const result = await run(find(CODE_NAV_TOOLS, 'find_dead_code'), {}, ws);
    expect(result.output).toContain('unusedFn');
    expect(result.output).not.toMatch(/used'.*never/);
  });

  it('codebase_summary reports structure', async () => {
    const ws = await tmpWorkspace();
    await fs.mkdir(path.join(ws, 'src'), { recursive: true });
    await fs.writeFile(path.join(ws, 'src', 'index.ts'), 'console.log(1);\n');
    const result = await run(find(CODE_NAV_TOOLS, 'codebase_summary'), {}, ws);
    expect(result.output).toContain('Codebase summary');
    expect(result.output).toContain('src(');
  });
});

describe('QualityTools parsers', () => {
  it('parseTestOutput understands jest and pytest summaries', () => {
    const jest = parseTestOutput('Tests: 5 passed, 5 total', '');
    expect(jest).toMatchObject({ suite: 'jest-like', passed: 5 });
    const pytest = parseTestOutput('', '2 failed, 10 passed in 1.2s');
    expect(pytest).toMatchObject({ suite: 'pytest-like', failed: 2, passed: 10 });
  });

  it('parseBuildErrors extracts TS and bundler errors', () => {
    const errors = pbe('src/foo.ts(12,3): error TS2304: Cannot find name x\nERROR in ./src/bar.ts\nModule not found\n');
    expect(errors[0]).toContain('src/foo.ts:12:3');
    expect(errors.join(' ')).toContain('TS2304');
    expect(pbe('src/x.ts:3:9 - error TS2345: bad')[0]).toContain('src/x.ts:3:9');
  });

  it('generate_test scaffolds a runnable test file', async () => {
    const ws = await tmpWorkspace();
    await fs.mkdir(path.join(ws, 'src'), { recursive: true });
    await fs.writeFile(path.join(ws, 'src', 'calc.ts'), 'export function mul(a: number, b: number) { return a * b; }\n');
    const result = await run(find(QUALITY_TOOLS, 'generate_test'), { path: 'src/calc.ts' }, ws);
    expect(result.success).toBe(true);
    const testFile = await fs.readFile(path.join(ws, 'tests', 'calc.test.ts'), 'utf-8');
    expect(testFile).toContain('describe(\'mul\'');
    // refuses to overwrite
    const again = await run(find(QUALITY_TOOLS, 'generate_test'), { path: 'src/calc.ts' }, ws);
    expect(again.success).toBe(false);
  });
});

describe('GitFlowTools', () => {
  it('git_branch lists branches in a real git repo', async () => {
    const ws = await tmpWorkspace();
    await runCapturedInit(ws);
    const result = await run(find(GIT_FLOW_TOOLS, 'git_branch'), { action: 'list' }, ws);
    expect(result.success).toBe(true);
    expect(/main|master/.test(result.output ?? '')).toBe(true);
  });

  it('git_commit dryRun drafts a message without committing', async () => {
    const ws = await tmpWorkspace();
    await runCapturedInit(ws);
    await fs.writeFile(path.join(ws, 'new.txt'), 'hello\n');
    const result = await run(find(GIT_FLOW_TOOLS, 'git_commit'), { dryRun: true }, ws);
    expect(result.success).toBe(true);
    expect(result.output).toContain('DRY RUN');
    const log = await runGit(ws, 'git status --short');
    expect(log).toContain('A  new.txt'); // staged but NOT committed
  });

  async function runCapturedInit(ws: string): Promise<void> {
    const { runCaptured } = await import('../../src/tools/ShellTool.js');
    await runCaptured('git init -b main', { cwd: ws });
    await runCaptured('git config user.email t@t', { cwd: ws });
    await runCaptured('git config user.name t', { cwd: ws });
    await fs.writeFile(path.join(ws, 'seed.txt'), 'seed\n');
    await runCaptured('git add -A', { cwd: ws });
    await runCaptured('git commit -m init', { cwd: ws });
  }
  async function runGit(ws: string, command: string): Promise<string> {
    const { runCaptured } = await import('../../src/tools/ShellTool.js');
    const r = await runCaptured(command, { cwd: ws });
    return r.stdout;
  }
});

describe('DependencyTools', () => {
  it('install_package rejects suspicious specs', async () => {
    const ws = await tmpWorkspace();
    const result = await run(find(DEPENDENCY_TOOLS, 'install_package'), { packages: ['left-pad; rm -rf /'] }, ws);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Suspicious');
  });

  // Hits the live npm registry, so it needs far more headroom than the 15s
  // suite default once other suites are competing for CPU.
  it('check_outdated_deps works on a package.json workspace', async () => {
    const ws = await tmpWorkspace();
    await fs.writeFile(path.join(ws, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0', dependencies: { ms: '^2.0.0' } }));
    const result = await run(find(DEPENDENCY_TOOLS, 'check_outdated_deps'), {}, ws);
    expect(result.success).toBe(true); // may report outdated or up-to-date, must not crash
  }, 90_000);
});

describe('BuildDeployTools', () => {
  it('check_env_vars compares without leaking values', async () => {
    const ws = await tmpWorkspace();
    await fs.writeFile(path.join(ws, '.env.example'), 'API_KEY=\nDB_HOST=\n');
    await fs.writeFile(path.join(ws, '.env'), 'API_KEY=supersecret\nEXTRA=1\n');
    const result = await run(find(BUILD_DEPLOY_TOOLS, 'check_env_vars'), {}, ws);
    expect(result.output).toContain('MISSING');
    expect(result.output).toContain('DB_HOST');
    expect(result.output).not.toContain('supersecret');
  });

  it('run_build parses errors on a broken build', async () => {
    const ws = await tmpWorkspace();
    await fs.writeFile(path.join(ws, 'bad.js'), 'syntax error here(((\n');
    const result = await run(find(BUILD_DEPLOY_TOOLS, 'run_build'), { command: 'node bad.js' }, ws);
    expect(result.success).toBe(true); // tool itself succeeds and reports
    expect(result.output).toContain('FAILED');
  });
});

describe('WebApiTools', () => {
  it('isBlockedHost refuses private ranges', () => {
    expect(isBlockedHost('localhost')).toBe(true);
    expect(isBlockedHost('127.0.0.1')).toBe(true);
    expect(isBlockedHost('192.168.1.5')).toBe(true);
    expect(isBlockedHost('169.254.169.254')).toBe(true);
    expect(isBlockedHost('example.com')).toBe(false);
  });

  it('http_request blocks SSRF targets by default', async () => {
    const ws = await tmpWorkspace();
    const result = await run(find(WEB_API_TOOLS, 'http_request'), { url: 'http://169.254.169.254/latest/meta-data/' }, ws);
    expect(result.success).toBe(false);
    expect(result.error).toContain('SSRF');
  });

  it('database_query refuses write statements', async () => {
    const ws = await tmpWorkspace();
    const result = await run(find(WEB_API_TOOLS, 'database_query'), { query: 'DELETE FROM users' }, ws);
    expect(result.success).toBe(false);
    expect(result.error).toContain('read-only');
  });

  it('web_search_for_error builds targeted queries', async () => {
    const ws = await tmpWorkspace();
    const result = await run(find(WEB_API_TOOLS, 'web_search_for_error'), { error: 'TypeError: Cannot read properties of undefined (reading id) TS2345', context: 'react' }, ws);
    expect(result.output).toContain('google.com/search');
  });
});

describe('registry totals', () => {
  it('registers all 43 new tools', () => {
    expect(FS_OPS_TOOLS.length).toBe(9);
    expect(CODE_NAV_TOOLS.length).toBe(9);
    expect(QUALITY_TOOLS.length).toBe(9);
    expect(GIT_FLOW_TOOLS.length).toBe(8);
    expect(DEPENDENCY_TOOLS.length).toBe(6);
    expect(BUILD_DEPLOY_TOOLS.length).toBe(7);
    expect(WEB_API_TOOLS.length).toBe(4);
  });
});
