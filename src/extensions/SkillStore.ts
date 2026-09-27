/**
 * Skill store: the workspace-local library of `SKILL.md` instructions.
 *
 * A skill is a directory of text (at minimum `SKILL.md`) that the agent can read
 * on demand. Installation writes files only, never executes them, so the store
 * stays safe to point at a public repo.
 */

import fs from 'fs';
import path from 'path';
import { ExtensionSource, RemoteFile, SkillInfo } from './types.js';

const MANIFEST = 'SKILL.md';
/** Directory name rules: keeps an installed skill addressable and path-safe. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillError';
  }
}

/** Validate a user- or repo-supplied name before it is ever joined to a path. */
export function assertSafeName(name: string): string {
  const trimmed = (name || '').trim();
  if (!NAME_RE.test(trimmed) || trimmed === '.' || trimmed === '..' || trimmed.includes('..')) {
    throw new SkillError(`Invalid name '${name}': use letters, digits, dot, dash or underscore (max 64 chars)`);
  }
  return trimmed;
}

/** Read `name:` / `description:` out of a SKILL.md YAML frontmatter block. */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^["']|["']$/g, '');
    if (kv[1] === 'name' && value) out.name = value;
    if (kv[1] === 'description' && value) out.description = value;
  }
  return out;
}

export class SkillStore {
  constructor(private readonly root: string) {}

  get dir(): string {
    return this.root;
  }

  /** Every installed skill, newest frontmatter metadata first-class. */
  list(): SkillInfo[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const skills: SkillInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(this.root, entry.name);
      const manifest = path.join(dir, MANIFEST);
      let text = '';
      try {
        text = fs.readFileSync(manifest, 'utf8');
      } catch {
        // A directory without SKILL.md is not a skill; ignore it.
        continue;
      }
      const meta = parseSkillFrontmatter(text);
      const stats = this.walk(dir);
      skills.push({
        name: entry.name,
        description: meta.description || firstParagraph(text),
        path: dir,
        files: stats.files,
        bytes: stats.bytes,
        source: this.readSource(dir),
      });
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Raw SKILL.md text, for the viewer in the UI. */
  read(name: string): string {
    const dir = this.skillDir(name);
    try {
      return fs.readFileSync(path.join(dir, MANIFEST), 'utf8');
    } catch {
      throw new SkillError(`Skill '${name}' has no ${MANIFEST}`);
    }
  }

  /** Files inside a skill, so the UI can show what came with it. */
  files(name: string): string[] {
    const dir = this.skillDir(name);
    const out: string[] = [];
    const walk = (current: string, prefix: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
        else out.push(rel);
      }
    };
    try {
      walk(dir, '');
    } catch {
      throw new SkillError(`Skill '${name}' is not installed`);
    }
    return out.sort();
  }

  /**
   * Write a downloaded skill into the store. Refuses traversal, refuses to
   * silently overwrite an existing skill unless `overwrite` is set.
   */
  install(name: string, files: RemoteFile[], source: ExtensionSource, opts: { overwrite?: boolean } = {}): SkillInfo {
    const safe = assertSafeName(name);
    if (!files.some((f) => f.path === MANIFEST)) {
      throw new SkillError(`A skill needs a ${MANIFEST} at its root`);
    }
    const dir = path.join(this.root, safe);
    if (fs.existsSync(dir) && !opts.overwrite) {
      throw new SkillError(`Skill '${safe}' is already installed (pass overwrite to replace it)`);
    }
    const staging = `${dir}.tmp-${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    for (const file of files) {
      const target = safeJoin(staging, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content, 'utf8');
    }
    this.writeSource(staging, source);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(this.root, { recursive: true });
    fs.renameSync(staging, dir);
    return this.list().find((s) => s.name === safe) as SkillInfo;
  }

  remove(name: string): void {
    const dir = this.skillDir(name);
    if (!fs.existsSync(dir)) throw new SkillError(`Skill '${name}' is not installed`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  private skillDir(name: string): string {
    return path.join(this.root, assertSafeName(name));
  }

  private walk(dir: string): { files: number; bytes: number } {
    let files = 0;
    let bytes = 0;
    const visit = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) visit(path.join(current, entry.name));
        else {
          files += 1;
          try {
            bytes += fs.statSync(path.join(current, entry.name)).size;
          } catch {
            /* raced with a delete; the count is informational only */
          }
        }
      }
    };
    try {
      visit(dir);
    } catch {
      /* unreadable skill: report zeros rather than failing the whole listing */
    }
    return { files, bytes };
  }

  private writeSource(dir: string, source: ExtensionSource): void {
    fs.writeFileSync(path.join(dir, '.source.json'), `${JSON.stringify(source, null, 2)}\n`, 'utf8');
  }

  private readSource(dir: string): ExtensionSource {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, '.source.json'), 'utf8')) as ExtensionSource;
      if (raw && (raw.kind === 'github' || raw.kind === 'local')) return raw;
    } catch {
      /* no provenance recorded */
    }
    return { kind: 'local' };
  }
}

/** Join and prove the result stays inside `root`. */
export function safeJoin(root: string, relative: string): string {
  const normalized = path.normalize(relative).replace(/^([/\\])+/, '');
  if (path.isAbsolute(relative) || normalized.split(/[/\\]/).includes('..')) {
    throw new SkillError(`Refusing to write outside the extension directory: ${relative}`);
  }
  const target = path.resolve(root, normalized);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new SkillError(`Refusing to write outside the extension directory: ${relative}`);
  }
  return target;
}

function firstParagraph(text: string): string {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').trim();
  const line = body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'));
  return (line || '').trim().slice(0, 200);
}
