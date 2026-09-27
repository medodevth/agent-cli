import * as fs from 'fs/promises';
import * as nodeFs from 'fs';
import * as path from 'path';
import { Tool, ToolContext, ToolResult } from '../types/index.js';
import { PathValidator } from './FileTools.js';

/**
 * File & Filesystem tools (group 1) — move/rename with import updates,
 * delete, copy, diff, multi-file regex replace with preview, stat,
 * directory scaffolding, and a bounded file watcher.
 *
 * Safety: every path goes through PathValidator (workspace-confined);
 * destructive operations call permissions.check() before doing anything.
 */

type Input = Record<string, unknown>;

const str = (input: Input, key: string): string => String(input[key] ?? '');
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|vue|svelte)$/;

const IMPORT_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** Does an import specifier written in `importerDir` point at `targetAbs`?
 *  Matches extensionless specifiers ('./util' → ./util.ts) by candidate probing —
 *  crucial because the target file has usually ALREADY moved when we rewrite. */
function specPointsTo(importerDir: string, spec: string, targetAbs: string): boolean {
  if (!spec.startsWith('.') && !spec.startsWith('@/')) return false; // bare package
  const base = path.resolve(importerDir, spec);
  if (base === targetAbs) return true;
  return IMPORT_EXTS.slice(1).some(ext => base + ext === targetAbs);
}

/** Rebuilds the specifier so it keeps pointing at `newAbs` from `importerDir`,
 *  preserving the extensionless style when the original spec had no extension. */
function rewriteRelativeImport(spec: string, importerDir: string, newAbs: string): string {
  const hadExt = /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(spec);
  const base = hadExt ? newAbs : newAbs.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, '');
  let rel = path.relative(importerDir, base);
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel.split(path.sep).join('/');
}

async function updateImporters(ws: string, oldAbs: string, newAbs: string): Promise<string[]> {
  const changed: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!CODE_EXT.test(entry.name)) continue;
      let content: string;
      try { content = await fs.readFile(full, 'utf-8'); } catch { continue; }
      const fromDir = path.dirname(full);
      let updated = content; let touched = false;
      // import ... from 'spec'  /  require('spec')
      const re = /(from\s+|require\(\s*)(['"])([^'"]+)\2/g;
      updated = updated.replace(re, (match, prefix, quote, spec) => {
        if (!specPointsTo(fromDir, spec, oldAbs)) return match;
        touched = true;
        // New specifier is relative to the IMPORTER's directory (it stays put).
        return `${prefix}${quote}${rewriteRelativeImport(spec, fromDir, newAbs)}${quote}`;
      });
      if (touched) {
        await fs.writeFile(full, updated, 'utf-8');
        changed.push(path.relative(ws, full));
      }
    }
  };
  await walk(ws);
  return changed;
}

async function requirePermission(context: ToolContext, description: string, risk: 'medium' | 'high'): Promise<ToolResult | null> {
  const permission = await context.permissions.check({ type: risk === 'high' ? 'delete_file' : 'write_file', description, risk });
  if (permission.allowed === false) {
    return { success: false, error: `Permission denied: ${permission.reason}` };
  }
  return null;
}

function ok(output: string, metadata?: Record<string, unknown>): ToolResult {
  return { success: true, output, metadata };
}

// 1+2. move_file / rename_file -------------------------------------------------

export class MoveFileTool implements Tool {
  name = 'move_file';
  description = 'Move a file to a new location inside the workspace; automatically updates import specifiers in files that referenced the old path.';
  inputSchema = { type: 'object', properties: { from: { type: 'string', description: 'current path' }, to: { type: 'string', description: 'new path' } }, required: ['from', 'to'] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const from = path.resolve(ws, PathValidator.sanitizePath(str(input, 'from')));
      const to = path.resolve(ws, PathValidator.sanitizePath(str(input, 'to')));
      if (to === from) return ok('Source and destination are identical');
      await fs.mkdir(path.dirname(to), { recursive: true });
      const denied = await requirePermission(context, `Move ${str(input, 'from')} → ${str(input, 'to')}`, 'medium');
      if (denied) return denied;
      await fs.rename(from, to);
      const changed = await updateImporters(ws, from, to);
      return ok(`Moved to ${str(input, 'to')}` + (changed.length ? `\nUpdated imports in ${changed.length} file(s): ${changed.join(', ')}` : '\nNo referencing imports found'), { moved: true, importersUpdated: changed });
    } catch (error) { return this.err(error); }
  }
  private err(error: unknown): ToolResult { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}

export class RenameFileTool extends MoveFileTool {
  override name = 'rename_file';
  override description = 'Rename a file (same directory move); import specifiers pointing at the old name are updated automatically.';
  override inputSchema = { type: 'object', properties: { from: { type: 'string', description: 'current path' }, to: { type: 'string', description: 'new name (may be bare filename or path)' } }, required: ['from', 'to'] } as typeof MoveFileTool.prototype.inputSchema;
}

// 3. delete_file ---------------------------------------------------------------

export class DeleteFileTool implements Tool {
  name = 'delete_file';
  description = 'Delete a file or empty directory inside the workspace. Always asks for permission according to the current permission mode.';
  inputSchema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const target = path.resolve(context.workspaceRoot, PathValidator.sanitizePath(str(input, 'path')));
      const stat = await fs.stat(target);
      const denied = await requirePermission(context, `Delete ${str(input, 'path')}`, 'high');
      if (denied) return denied;
      if (stat.isDirectory()) {
        await fs.rmdir(target); // fails when non-empty by design
        return ok(`Removed empty directory ${str(input, 'path')}`);
      }
      await fs.unlink(target);
      return ok(`Deleted ${str(input, 'path')} (${stat.size} bytes)`, { deletedSize: stat.size });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOTEMPTY') return { success: false, error: 'Directory is not empty — delete files individually instead' };
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

// 4. copy_file -----------------------------------------------------------------

export class CopyFileTool implements Tool {
  name = 'copy_file';
  description = 'Copy a file to a new path inside the workspace (creates parent directories).';
  inputSchema = { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const from = path.resolve(context.workspaceRoot, PathValidator.sanitizePath(str(input, 'from')));
      const to = path.resolve(context.workspaceRoot, PathValidator.sanitizePath(str(input, 'to')));
      const denied = await requirePermission(context, `Copy ${str(input, 'from')} → ${str(input, 'to')}`, 'medium');
      if (denied) return denied;
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
      return ok(`Copied to ${str(input, 'to')}`);
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 5. diff_files ----------------------------------------------------------------

function diffLines(a: string, b: string): string[] {
  const alines = a.split('\n'); const blines = b.split('\n');
  const out: string[] = [];
  const max = Math.max(alines.length, blines.length);
  for (let i = 0; i < max; i++) {
    if (alines[i] === blines[i]) continue;
    if (alines[i] !== undefined) out.push(`-L${i + 1}: ${alines[i]}`);
    if (blines[i] !== undefined) out.push(`+L${i + 1}: ${blines[i]}`);
  }
  return out;
}

export class DiffFilesTool implements Tool {
  name = 'diff_files';
  description = 'Compare two files line-by-line, or compare a file against its version in another git branch (pass branch + path).';
  inputSchema = { type: 'object', properties: { fileA: { type: 'string' }, fileB: { type: 'string', description: 'second file (omit when using branch mode)' }, branch: { type: 'string', description: 'git branch to diff against (branch mode)' }, path: { type: 'string', description: 'file path for branch mode' } }, required: [] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      let aContent: string; let bContent: string; let label: string;
      if (str(input, 'branch')) {
        const file = PathValidator.sanitizePath(str(input, 'path'));
        aContent = await fs.readFile(path.resolve(ws, file), 'utf-8');
        const { runCaptured } = await import('./ShellTool.js');
        const r = await runCaptured(`git show ${str(input, 'branch')}:${file}`, { cwd: ws, timeout: 15000 });
        if (!r.ok) return { success: false, error: `Cannot read ${file} from branch ${str(input, 'branch')}: ${r.stderr.slice(0, 200)}` };
        bContent = r.stdout;
        label = `${file} (working tree) vs ${str(input, 'branch')}`;
      } else {
        const a = path.resolve(ws, PathValidator.sanitizePath(str(input, 'fileA')));
        const b = path.resolve(ws, PathValidator.sanitizePath(str(input, 'fileB')));
        [aContent, bContent] = await Promise.all([fs.readFile(a, 'utf-8'), fs.readFile(b, 'utf-8')]);
        label = `${str(input, 'fileA')} vs ${str(input, 'fileB')}`;
      }
      const diffs = diffLines(aContent, bContent);
      if (!diffs.length) return ok(`${label}\nIdentical.`);
      return ok(`${label}\n${diffs.length} differing line(s):\n${diffs.slice(0, 80).join('\n')}${diffs.length > 80 ? `\n[... ${diffs.length - 80} more]` : ''}`, { diffCount: diffs.length });
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

// 6. find_and_replace ----------------------------------------------------------

export class FindAndReplaceTool implements Tool {
  name = 'find_and_replace';
  description = 'Regex find-and-replace across multiple files. Pass dryRun=true (default) to preview matches without writing; use maxFiles to bound scope.';
  inputSchema = { type: 'object', properties: { pattern: { type: 'string', description: 'regex source' }, flags: { type: 'string', description: 'regex flags, default "g"' }, replacement: { type: 'string' }, include: { type: 'string', description: 'file glob, e.g. "src/**/*.ts"' }, dryRun: { type: 'boolean' }, maxFiles: { type: 'number' } }, required: ['pattern', 'replacement'] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const pattern = str(input, 'pattern');
      if (!pattern) return { success: false, error: 'pattern is required' };
      const flags = str(input, 'flags') || 'g';
      const regex = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
      const dryRun = input.dryRun !== false; // default true — preview first
      const maxFiles = Math.min(Number(input.maxFiles) || 50, 200);
      const include = str(input, 'include');
      const { runCaptured } = await import('./ShellTool.js');
      const base = include ? path.dirname(include) : '.';
      const name = include ? path.basename(include) : '*';
      const list = await runCaptured(`find ${base === '.' ? '.' : base} -type f -name "${name}"`, { cwd: ws, timeout: 15000 });
      const files = list.stdout.split('\n').filter(f => CODE_EXT.test(f) && !f.includes('node_modules')).slice(0, maxFiles);
      const results: string[] = []; let totalMatches = 0; let modified = 0;
      for (const rel of files) {
        let content: string;
        try { content = await fs.readFile(path.resolve(ws, rel), 'utf-8'); } catch { continue; }
        const matches = content.match(regex);
        if (!matches?.length) continue;
        totalMatches += matches.length;
        const updated = content.replace(regex, str(input, 'replacement'));
        if (!dryRun) {
          const denied = await requirePermission(context, `Replace in ${rel} (${matches.length} match(es))`, 'medium');
          if (denied) return denied;
          await fs.writeFile(path.resolve(ws, rel), updated, 'utf-8');
          modified++;
        }
        results.push(`${rel}: ${matches.length} match(es)`);
      }
      const header = dryRun ? `PREVIEW (dryRun) — ${totalMatches} match(es) in ${results.length} file(s). Re-run with dryRun=false to apply.` : `Applied: ${totalMatches} replacement(s) across ${modified} file(s).`;
      return ok(`${header}\n${results.slice(0, 40).join('\n')}`, { totalMatches, files: results.length, dryRun });
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 7. file_stat -----------------------------------------------------------------

export class FileStatTool implements Tool {
  name = 'file_stat';
  description = 'Show file metadata: size, created/modified times, permissions, and line count.';
  inputSchema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const target = path.resolve(context.workspaceRoot, PathValidator.sanitizePath(str(input, 'path')));
      const stat = await fs.stat(target);
      let lines: number | null = null;
      if (stat.isFile() && stat.size < 2_000_000) {
        try { lines = (await fs.readFile(target, 'utf-8')).split('\n').length; } catch { /* binary */ }
      }
      const parts = [
        `path: ${str(input, 'path')}`,
        `type: ${stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'}`,
        `size: ${stat.size} bytes`,
        `modified: ${stat.mtime.toISOString()}`,
        `permissions: ${(stat.mode & 0o777).toString(8)}`,
      ];
      if (lines !== null) parts.push(`lines: ${lines}`);
      return ok(parts.join('\n'), { size: stat.size, mtime: stat.mtime.toISOString(), lines });
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 8. create_directory_structure ------------------------------------------------

const SCAFFOLD_TEMPLATES: Record<string, string[]> = {
  'ts-lib': ['src/index.ts', 'src/types.ts', 'tests/index.test.ts', 'README.md'],
  'node-cli': ['src/index.ts', 'src/cli.ts', 'bin/run.js', 'tests/cli.test.ts'],
  'feature': ['src/components/', 'src/hooks/', 'src/utils/', 'tests/'],
  'docs': ['docs/architecture.md', 'docs/api.md', 'docs/decisions/'],
};

export class CreateDirectoryStructureTool implements Tool {
  name = 'create_directory_structure';
  description = 'Scaffold a directory tree from a named template (ts-lib | node-cli | feature | docs) or from an explicit list of paths (entries).';
  inputSchema = { type: 'object', properties: { root: { type: 'string', description: 'base directory inside the workspace' }, template: { type: 'string' }, entries: { type: 'array', items: { type: 'string' } } }, required: ['root'] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const root = path.resolve(context.workspaceRoot, PathValidator.sanitizePath(str(input, 'root')));
      const template = str(input, 'template');
      const entries = Array.isArray(input.entries) && input.entries.length
        ? (input.entries as unknown[]).map(String)
        : SCAFFOLD_TEMPLATES[template];
      if (!entries) {
        return { success: false, error: `Unknown template '${template}'. Available: ${Object.keys(SCAFFOLD_TEMPLATES).join(', ')} — or pass entries: [...]` };
      }
      const denied = await requirePermission(context, `Scaffold ${entries.length} path(s) under ${str(input, 'root')}`, 'medium');
      if (denied) return denied;
      const created: string[] = [];
      for (const entry of entries) {
        const target = path.join(root, entry);
        if (entry.endsWith('/')) { await fs.mkdir(target, { recursive: true }); created.push(entry + ' (dir)'); }
        else { await fs.mkdir(path.dirname(target), { recursive: true }); try { await fs.writeFile(target, '', { flag: 'wx' }); created.push(entry); } catch { /* exists */ } }
      }
      return ok(`Created under ${str(input, 'root')}:\n${created.map(c => '  ' + c).join('\n')}`, { created: created.length });
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 9. watch_files ---------------------------------------------------------------

export class WatchFilesTool implements Tool {
  name = 'watch_files';
  description = 'Watch a directory for file changes for a bounded number of seconds and report what changed (for dev loops / auto-test).';
  inputSchema = { type: 'object', properties: { path: { type: 'string' }, seconds: { type: 'number', description: 'how long to watch, default 10, max 60' }, pattern: { type: 'string', description: 'filename suffix filter, e.g. ".ts"' } }, required: ['path'] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const target = path.resolve(context.workspaceRoot, PathValidator.sanitizePath(str(input, 'path')));
      const seconds = Math.min(Math.max(Number(input.seconds) || 10, 1), 60);
      const suffix = str(input, 'pattern');
      const events: string[] = [];
      const watcher = watchDir(target);
      const timer = new Promise<void>(resolve => setTimeout(resolve, seconds * 1000));
      const collect = (async () => {
        for await (const event of watcher.stream) {
          const file = String(event.filename ?? '');
          if (suffix && !file.endsWith(suffix)) continue;
          events.push(`${event.eventType}: ${file}`);
          if (events.length >= 50) break;
        }
      })();
      await Promise.race([timer, collect]);
      await watcher.close();
      return ok(events.length
        ? `${events.length} change(s) in ${seconds}s:\n` + events.slice(0, 30).join('\n')
        : `No changes in ${target} within ${seconds}s`, { events: events.length, recursive: watcher.recursive });
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// Event-based fs.watch wrapped as a simple async event source. Recursive
// watching is only available on some platforms/runtimes (Linux needs Node
// 20+), so it degrades to a top-level watch instead of failing the call.
type WatchEvent = { eventType: string; filename: string | null };

function watchDir(target: string) {
  let watcher: nodeFs.FSWatcher;
  let recursive = true;
  try {
    watcher = nodeFs.watch(target, { recursive: true });
  } catch {
    recursive = false;
    watcher = nodeFs.watch(target);
  }

  const queue: WatchEvent[] = [];
  const waiters: Array<(event: WatchEvent | null) => void> = [];
  let closed = false;

  watcher.on('change', (eventType: string, filename: string | Buffer | null) => {
    const event: WatchEvent = { eventType, filename: filename ? String(filename) : null };
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else queue.push(event);
  });

  const stop = () => {
    if (closed) return;
    closed = true;
    watcher.close();
    while (waiters.length) waiters.shift()!(null);
  };

  const iterator: AsyncIterator<WatchEvent> = {
    next: () => {
      const queued = queue.shift();
      if (queued) return Promise.resolve({ value: queued, done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise(resolve => waiters.push(event =>
        resolve(event ? { value: event, done: false } : { value: undefined, done: true })));
    },
    return: () => { stop(); return Promise.resolve({ value: undefined, done: true }); },
  };

  return { recursive, stream: { [Symbol.asyncIterator]: () => iterator }, close: async () => stop() };
}

// Grouped export for registry assembly.
export const FS_OPS_TOOLS: Tool[] = [
  new MoveFileTool(), new RenameFileTool(), new DeleteFileTool(), new CopyFileTool(),
  new DiffFilesTool(), new FindAndReplaceTool(), new FileStatTool(),
  new CreateDirectoryStructureTool(), new WatchFilesTool(),
];
