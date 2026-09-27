import * as fs from 'fs/promises';
import * as nodeFs from 'fs';
import * as path from 'path';
import { Tool, ToolContext, ToolResult } from '../types/index.js';
import { runCaptured, truncateOutput } from './ShellTool.js';
import { listWorkspaceFiles, readSource } from './CodeNavShared.js';

/**
 * Code Understanding & Navigation tools (group 2).
 * Regex/structure-based analysis with zero external dependencies:
 * works on TS/JS/Python/Go/Rust and general source files.
 */

type Input = Record<string, unknown>;
const str = (input: Input, key: string): string => String(input[key] ?? '');

// 12. get_symbols --------------------------------------------------------------

const SYMBOL_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'class', re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: 'method', re: /^\s+(?:public|private|protected|static|readonly|override|\s)*\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[\w<>[\]|,.\s]+)?\s*\{/ },
  { kind: 'const-fn', re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/ },
  { kind: 'type', re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
  { kind: 'py-def', re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/ },
  { kind: 'py-class', re: /^\s*class\s+([A-Za-z_][\w]*)/ },
];

export class GetSymbolsTool implements Tool {
  name = 'get_symbols';
  description = 'List symbols (classes, functions, methods, interfaces, types) declared in a source file with line numbers.';
  inputSchema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const source = await readSource(context.workspaceRoot, str(input, 'path'));
      const symbols: string[] = [];
      source.split('\n').forEach((line, idx) => {
        for (const { kind, re } of SYMBOL_PATTERNS) {
          const match = line.match(re);
          if (match) { symbols.push(`L${idx + 1} [${kind}] ${match[1]}`); break; }
        }
      });
      if (!symbols.length) return { success: true, output: `No symbols found in ${str(input, 'path')}` };
      return { success: true, output: `${str(input, 'path')} — ${symbols.length} symbol(s):\n` + symbols.slice(0, 120).join('\n'), metadata: { count: symbols.length } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 9. find_definition -----------------------------------------------------------

export class FindDefinitionTool implements Tool {
  name = 'find_definition';
  description = 'Find where a symbol (function/class/variable) is declared. Searches declaration patterns first, then any occurrence.';
  inputSchema = { type: 'object', properties: { symbol: { type: 'string' }, path: { type: 'string', description: 'optional file to search first' } }, required: ['symbol'] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const symbol = str(input, 'symbol');
      if (!symbol) return { success: false, error: 'symbol is required' };
      const files = await listWorkspaceFiles(ws, input.path ? [str(input, 'path')] : undefined, 800);
      const declRe = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|interface|type|const|let|var)\\s+${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      const useRe = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      const declarations: string[] = []; const references: string[] = [];
      for (const file of files) {
        const source = await readSource(ws, file);
        source.split('\n').forEach((line, idx) => {
          const hit = `${path.relative(ws, file)}:${idx + 1}: ${line.trim().slice(0, 140)}`;
          if (declRe.test(line)) declarations.push(hit);
          else if (useRe.test(line) && references.length < 40) references.push(hit);
        });
      }
      if (!declarations.length && !references.length) return { success: true, output: `Symbol '${symbol}' not found in workspace` };
      return { success: true, output:
        `Declarations of '${symbol}' (${declarations.length}):\n${declarations.slice(0, 20).join('\n') || '  (none)'}` +
        (references.length ? `\n\nOther occurrences (first ${Math.min(references.length, 15)}):\n${references.slice(0, 15).join('\n')}` : ''),
        metadata: { declarations: declarations.length } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 10. find_references ----------------------------------------------------------

export class FindReferencesTool implements Tool {
  name = 'find_references';
  description = 'Find every reference to a symbol across the workspace, grouped by file, excluding its declaration line.';
  inputSchema = { type: 'object', properties: { symbol: { type: 'string' }, path: { type: 'string', description: 'limit to one file/subdirectory' } }, required: ['symbol'] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const symbol = str(input, 'symbol');
      if (!symbol) return { success: false, error: 'symbol is required' };
      const files = await listWorkspaceFiles(ws, input.path ? [str(input, 'path')] : undefined, 800);
      const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const declRe = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|interface|type|const|let|var)\\s+${escaped}\\b`);
      const useRe = new RegExp(`\\b${escaped}\\b`);
      const byFile = new Map<string, number>(); const samples: string[] = [];
      for (const file of files) {
        const source = await readSource(ws, file);
        source.split('\n').forEach((line, idx) => {
          if (!useRe.test(line) || declRe.test(line)) return;
          byFile.set(file, (byFile.get(file) ?? 0) + 1);
          if (samples.length < 25) samples.push(`${path.relative(ws, file)}:${idx + 1}: ${line.trim().slice(0, 140)}`);
        });
      }
      if (!byFile.size) return { success: true, output: `No references to '${symbol}' found` };
      const summary = [...byFile.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([file, count]) => `${path.relative(ws, file)}: ${count}`);
      return { success: true, output: `'${symbol}' referenced ${[...byFile.values()].reduce((a, b) => a + b, 0)} time(s) in ${byFile.size} file(s):\n` + summary.join('\n') + `\n\nSamples:\n` + samples.join('\n'), metadata: { files: byFile.size } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 11. get_ast ------------------------------------------------------------------

export class GetAstTool implements Tool {
  name = 'get_ast';
  description = 'Structural outline of a file: nested symbol tree with brace-depth tracking (a dependency-free AST sketch).';
  inputSchema = { type: 'object', properties: { path: { type: 'string' }, maxDepth: { type: 'number' } }, required: ['path'] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const source = await readSource(context.workspaceRoot, str(input, 'path'));
      const maxDepth = Math.min(Number(input.maxDepth) || 4, 8);
      const lines = source.split('\n');
      const tree: string[] = [];
      let depth = 0;
      lines.forEach((line, idx) => {
        const stripped = line.trim();
        if (!stripped || stripped.startsWith('//') || stripped.startsWith('*')) return;
        for (const { kind, re } of SYMBOL_PATTERNS) {
          const match = line.match(re);
          if (match) {
            if (depth < maxDepth) tree.push(`${'  '.repeat(depth)}L${idx + 1} ${kind}: ${match[1]}`);
            break;
          }
        }
        const opens = (line.match(/[{([]/g) ?? []).length;
        const closes = (line.match(/[})\]]/g) ?? []).length;
        depth = Math.max(0, depth + opens - closes);
      });
      return { success: true, output: `${str(input, 'path')} outline (${tree.length} nodes):\n` + (tree.slice(0, 150).join('\n') || '(empty)'), metadata: { nodes: tree.length } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 13. get_call_graph -----------------------------------------------------------

export class GetCallGraphTool implements Tool {
  name = 'get_call_graph';
  description = 'For a given function, find which functions it calls and which functions call it (within the workspace).';
  inputSchema = { type: 'object', properties: { fn: { type: 'string' } }, required: ['fn'] };

  async execute(input: Input, context: ToolContext): Promise<ToolContext extends never ? never : ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const fn = str(input, 'fn');
      if (!fn) return { success: false, error: 'fn is required' };
      const files = await listWorkspaceFiles(ws, undefined, 800);
      const escaped = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const declRe = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|const|let|var)\\s+${escaped}\\b|^\\s+(?:async\\s+)?${escaped}\\s*\\([^)]*\\)\\s*\\{`);
      const callRe = new RegExp(`\\b${escaped}\\s*\\(`);
      const callers: string[] = []; const callees: string[] = [];
      let insideTarget = false; let braceDepth = 0;
      for (const file of files) {
        const source = await readSource(ws, file);
        const lines = source.split('\n');
        lines.forEach((line, idx) => {
          if (declRe.test(line)) insideTarget = true;
          if (insideTarget) {
            braceDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
            if (braceDepth <= 0 && idx > 0 && /\}/.test(line)) insideTarget = false;
            else {
              for (const m of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
                if (m[1] !== fn && !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(m[1]) && callees.length < 40) callees.push(`${path.relative(ws, file)}:${idx + 1} → ${m[1]}()`);
              }
            }
          } else if (callRe.test(line) && !declRe.test(line)) {
            callers.push(`${path.relative(ws, file)}:${idx + 1}: ${line.trim().slice(0, 120)}`);
          }
        });
        insideTarget = false; braceDepth = 0;
      }
      if (!callers.length && !callees.length) return { success: true, output: `No call relationships found for '${fn}'` };
      return { success: true, output:
        `Call graph for ${fn}():\n\nCALLED BY (${callers.length}):\n${callers.slice(0, 20).join('\n') || '  (none — entry point?)'}\n\nCALLS (${callees.length}):\n${callees.slice(0, 20).join('\n') || '  (none)'}`,
        metadata: { callers: callers.length, callees: callees.length } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 14. get_dependency_graph -----------------------------------------------------

export class GetDependencyGraphTool implements Tool {
  name = 'get_dependency_graph';
  description = 'Map import/require relationships between workspace files, optionally starting from one file (dependency fan-out).';
  inputSchema = { type: 'object', properties: { path: { type: 'string', description: 'start file (optional — omit for whole-project summary)' }, direction: { type: 'string', description: '"imports" (default) or "imported-by"' } }, required: [] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const direction = str(input, 'direction') || 'imports';
      const files = await listWorkspaceFiles(ws, input.path ? [str(input, 'path')] : undefined, 800);
      const edges = new Map<string, string[]>();
      const importRe = /(?:from\s+|require\(\s*|import\s+)(['"])([^'"]+)\1/g;
      for (const file of files) {
        const source = await readSource(ws, file);
        const specs: string[] = [];
        for (const m of source.matchAll(importRe)) {
          const spec = m[2];
          if (!spec.startsWith('.') && !spec.startsWith('@/')) continue; // local only
          const base = path.resolve(path.dirname(file), spec);
          const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, path.join(base, 'index.ts'), path.join(base, 'index.js')];
          const hit = candidates.find(c => { try { return nodeFs.existsSync(c); } catch { return false; } });
          if (hit) specs.push(path.relative(ws, hit));
        }
        if (specs.length) edges.set(path.relative(ws, file), [...new Set(specs)]);
      }
      if (input.path) {
        const start = path.relative(ws, files[0]);
        const list = edges.get(start) ?? [];
        const importedBy = [...edges.entries()].filter(([, targets]) => targets.includes(start)).map(([f]) => f);
        return { success: true, output: direction === 'imported-by'
          ? `${start} is imported by (${importedBy.length}):\n` + importedBy.map(f => `  ← ${f}`).join('\n')
          : `${start} imports (${list.length}):\n` + list.map(f => `  → ${f}`).join('\n'), metadata: { edges: direction === 'imported-by' ? importedBy.length : list.length } };
      }
      const total = [...edges.values()].reduce((a, b) => a + b.length, 0);
      const top = [...edges.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 15)
        .map(([f, targets]) => `${f} → ${targets.length} local import(s)`);
      const mostImported = new Map<string, number>();
      for (const targets of edges.values()) for (const t of targets) mostImported.set(t, (mostImported.get(t) ?? 0) + 1);
      const hot = [...mostImported.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([f, n]) => `${f}: imported by ${n} file(s)`);
      return { success: true, output: `Dependency map: ${edges.size} file(s), ${total} local import edge(s).\n\nMost connected files:\n` + top.join('\n') + `\n\nMost imported:\n` + hot.join('\n'), metadata: { files: edges.size, edges: total } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 15. explain_code -------------------------------------------------------------

export class ExplainCodeTool implements Tool {
  name = 'explain_code';
  description = 'Produce a structural explanation of a file or function: symbols, responsibilities inferred from names/strings/comments, exports and side effects. The calling agent adds the narrative itself.';
  inputSchema = { type: 'object', properties: { path: { type: 'string' }, symbol: { type: 'string', description: 'optional function/class to focus on' } }, required: ['path'] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const source = await readSource(ws, str(input, 'path'));
      const symbol = str(input, 'symbol');
      let body = source;
      if (symbol) {
        const idx = source.search(new RegExp(`(?:function|class|const|def)\\s+${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
        if (idx >= 0) body = source.slice(idx, idx + 4000); else return { success: false, error: `Symbol '${symbol}' not found in ${str(input, 'path')}` };
      }
      const lines = body.split('\n');
      const exports = lines.filter(l => /export\s+(default\s+)?(function|class|const|type|interface)/.test(l)).map(l => l.trim().slice(0, 120));
      const calls = [...new Set([...body.matchAll(/\b([a-z][\w$]*)\s*\(/g)].map(m => m[1]))].filter(c => !['if', 'for', 'while', 'switch', 'catch', 'return', 'function'].includes(c)).slice(0, 25);
      const strings = [...new Set([...body.matchAll(/['"]([^'"]{8,80})['"]/g)].map(m => m[1]))].slice(0, 12);
      const comments = lines.filter(l => /^\s*(\/\/|#|\/\*|\*)/.test(l)).map(l => l.trim().slice(0, 100)).slice(0, 10);
      const awaits = (body.match(/await\s+/g) ?? []).length;
      const throws = (body.match(/throw\s+/g) ?? []).length;
      return { success: true, output:
        `Explanation material for ${str(input, 'path')}${symbol ? ` :: ${symbol}` : ''}:\n` +
        `\nExports:\n${exports.slice(0, 10).map(e => '  ' + e).join('\n') || '  (none)'}` +
        `\nFunctions/methods called:\n${calls.map(c => '  ' + c + '()').join('\n') || '  (none)'}` +
        (awaits ? `\nAsync operations: ${awaits} await(s)` : '') +
        (throws ? `\nError paths: ${throws} throw(s)` : '') +
        `\nComments:\n${comments.map(c => '  ' + c).join('\n') || '  (none)'}` +
        `\nNotable string literals:\n${strings.map(s => '  "' + s + '"').join('\n') || '  (none)'}` };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 16. find_dead_code -----------------------------------------------------------

export class FindDeadCodeTool implements Tool {
  name = 'find_dead_code';
  description = 'Report exported functions/classes that are never referenced anywhere else in the workspace (candidate dead code).';
  inputSchema = { type: 'object', properties: { path: { type: 'string', description: 'limit scan to a subdirectory' } }, required: [] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const files = await listWorkspaceFiles(ws, input.path ? [str(input, 'path')] : undefined, 600);
      const exportRe = /^\s*export\s+(?:async\s+)?(?:function|class|const)\s+([A-Za-z_$][\w$]*)/gm;
      const allText = new Map<string, string>();
      for (const file of files) allText.set(file, await readSource(ws, file));
      const dead: string[] = []; let checked = 0;
      for (const [file, source] of allText) {
        for (const match of source.matchAll(exportRe)) {
          const name = match[1]; checked++;
          if (['index', 'main', 'default'].includes(name)) continue;
          const useRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
          let uses = 0;
          for (const [other, text] of allText) {
            if (other === file) continue;
            if (useRe.test(text)) { uses++; break; }
          }
          // also count intra-file uses beyond the declaration line
          const declIdx = source.indexOf(match[0]);
          if (useRe.test(source.slice(declIdx + match[0].length))) uses++;
          if (!uses) dead.push(`${path.relative(ws, file)}: export '${name}' is never referenced`);
        }
      }
      return { success: true, output: dead.length
        ? `${dead.length} potentially dead export(s) of ${checked} checked:\n` + dead.slice(0, 40).join('\n')
        : `No dead exports found (${checked} exports checked)`, metadata: { dead: dead.length, checked } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 17. codebase_summary ---------------------------------------------------------

export class CodebaseSummaryTool implements Tool {
  name = 'codebase_summary';
  description = 'Deep project overview: languages, directory purposes, entry points, dependency counts, test layout, and largest files.';
  inputSchema = { type: 'object', properties: {}, required: [] };

  async execute(_input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const files = await listWorkspaceFiles(ws, undefined, 1500);
      const byExt = new Map<string, number>();
      const byDir = new Map<string, number>();
      const sizes: Array<{ file: string; lines: number }> = [];
      for (const file of files) {
        const ext = path.extname(file) || '(none)';
        byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
        const topDir = path.relative(ws, path.dirname(file)).split(path.sep)[0] ?? '.';
        byDir.set(topDir, (byDir.get(topDir) ?? 0) + 1);
      }
      for (const file of files.slice(0, 400)) {
        try { sizes.push({ file: path.relative(ws, file), lines: (await readSource(ws, file)).split('\n').length }); } catch { /* skip */ }
      }
      sizes.sort((a, b) => b.lines - a.lines);
      const has = async (p: string) => { try { await fs.access(path.join(ws, p)); return true; } catch { return false; } };
      const entryPoints: string[] = [];
      for (const candidate of ['src/index.ts', 'src/main.ts', 'index.js', 'src/index.js', 'main.py', 'src/cli.ts']) {
        if (await has(candidate)) entryPoints.push(candidate);
      }
      const tests = files.filter(f => /(\.test\.|\.spec\.|__tests__)/.test(f)).length;
      let pkgInfo = '';
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(ws, 'package.json'), 'utf-8'));
        const deps = Object.keys(pkg.dependencies ?? {}); const devDeps = Object.keys(pkg.devDependencies ?? {});
        pkgInfo = `\npackage.json: ${deps.length} deps, ${devDeps.length} devDeps, scripts: ${Object.keys(pkg.scripts ?? {}).join(', ')}`;
      } catch { /* not a node project */ }
      return { success: true, output:
        `Codebase summary (${files.length} source files)\n` +
        `\nLanguages: ${[...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([e, n]) => `${e}×${n}`).join(', ')}` +
        `\nTop-level dirs: ${[...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([d, n]) => `${d}(${n})`).join(', ')}` +
        (entryPoints.length ? `\nEntry points: ${entryPoints.join(', ')}` : '') +
        (pkgInfo) +
        `\nTest files: ${tests}` +
        `\nLargest files:\n${sizes.slice(0, 10).map(s => `  ${s.file} (${s.lines} lines)`).join('\n')}`,
        metadata: { files: files.length, tests } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

export const CODE_NAV_TOOLS: Tool[] = [
  new FindDefinitionTool(), new FindReferencesTool(), new GetAstTool(), new GetCallGraphTool(),
  new GetDependencyGraphTool(), new GetSymbolsTool(), new ExplainCodeTool(),
  new FindDeadCodeTool(), new CodebaseSummaryTool(),
];

void truncateOutput; void runCaptured; // available for future sub-analyzers
