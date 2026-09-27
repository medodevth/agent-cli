import * as fs from 'fs/promises';
import * as path from 'path';

/** Walk the workspace (bounded) collecting source files, skipping build/vcs dirs.
 *  When `roots` are given, only files under those roots (relative to ws) are returned. */
export async function listWorkspaceFiles(
  ws: string,
  roots?: string[],
  maxFiles = 800,
): Promise<string[]> {
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.agent', '.cache']);
  const out: string[] = [];
  const startDirs = roots?.length
    ? roots.map(r => path.resolve(ws, r))
    : [ws];
  async function walk(dir: string): Promise<void> {
    if (out.length >= maxFiles) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      out.push(full);
    }
  }
  for (const dir of startDirs) await walk(dir);
  return out;
}

/** Read a workspace file as UTF-8 text with path confinement + friendly errors. */
export async function readSource(ws: string, relPath: string): Promise<string> {
  if (!relPath) throw new Error('path is required');
  const abs = path.resolve(ws, relPath);
  if (!abs.startsWith(path.resolve(ws) + path.sep) && abs !== path.resolve(ws)) {
    throw new Error(`Path escapes workspace: ${relPath}`);
  }
  try {
    return await fs.readFile(abs, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new Error(`File not found: ${relPath}`);
    throw error;
  }
}
