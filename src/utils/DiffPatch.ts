/**
 * DiffPatch — diff & patch helpers (500-functions category D).
 *
 * Pure, dependency-free functions operating on in-memory text plus two
 * small filesystem helpers (snapshotWorkspace / rollbackToSnapshot) built
 * on FileUtilities. Git-backed functions (E) live in GitUtilities.
 * Unit-tested in tests/unit/DiffPatch.test.ts.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteFile, mergeDirectories } from './FileUtilities.js';

/** Split text into lines without creating a phantom line after trailing \n. */
function toLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

/** 61. Generate a unified diff between two texts (before -> after). */
export function generateUnifiedDiff(
  before: string,
  after: string,
  options?: { fileName?: string; context?: number }
): string {
  const fileName = options?.fileName ?? 'file';
  const context = options?.context ?? 3;
  if (!Number.isInteger(context) || context < 0)
    throw new Error('context must be a non-negative integer');
  if (before === after) return '';
  const a = toLines(before);
  const b = toLines(after);
  const hunks = computeHunks(a, b, context);
  const header = `--- a/${fileName}\n+++ b/${fileName}\n`;
  return (
    header +
    hunks
      .map(h => `@@ -${h.aStart + 1},${h.aCount} +${h.bStart + 1},${h.bCount} @@\n${h.body}`)
      .join('')
  );
}

interface Hunk {
  aStart: number;
  aCount: number;
  bStart: number;
  bCount: number;
  body: string;
}

/** Myers-free LCS hunk computation (fine for review-sized diffs). */
function computeHunks(a: string[], b: string[], context: number): Hunk[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  type Op = { kind: ' ' | '-' | '+'; aLine: number; bLine: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', aLine: i, bLine: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: '-', aLine: i, bLine: -1 });
      i++;
    } else {
      ops.push({ kind: '+', aLine: -1, bLine: j });
      j++;
    }
  }
  while (i < m) {
    ops.push({ kind: '-', aLine: i, bLine: -1 });
    i++;
  }
  while (j < n) {
    ops.push({ kind: '+', aLine: -1, bLine: j });
    j++;
  }
  const changeIdx = ops.map((op, idx) => (op.kind === ' ' ? -1 : idx)).filter(idx => idx >= 0);
  if (changeIdx.length === 0) return [];
  const groups: number[][] = [];
  let current: number[] = [changeIdx[0]];
  for (let k = 1; k < changeIdx.length; k++) {
    if (changeIdx[k] - changeIdx[k - 1] <= context * 2 + 1) current.push(changeIdx[k]);
    else {
      groups.push(current);
      current = [changeIdx[k]];
    }
  }
  groups.push(current);
  return groups.map(group => {
    const first = Math.max(0, group[0] - context);
    const last = Math.min(ops.length - 1, group[group.length - 1] + context);
    let body = '';
    let aCount = 0;
    let bCount = 0;
    for (let k = first; k <= last; k++) {
      const op = ops[k];
      body += `${op.kind}${op.kind === '-' ? a[op.aLine] : op.kind === '+' ? b[op.bLine] : a[op.aLine]}\n`;
      if (op.kind !== '+') aCount++;
      if (op.kind !== '-') bCount++;
    }
    const aStart = ops[first].kind === '+' ? ops[first].aLine + 1 : ops[first].aLine;
    const bStart = ops[first].kind === '-' ? ops[first].bLine + 1 : ops[first].bLine;
    return {
      aStart: Math.max(0, aStart),
      aCount,
      bStart: Math.max(0, bStart),
      bCount,
      body,
    };
  });
}

interface PatchHunk {
  aStart: number;
  aCount: number;
  bStart: number;
  bCount: number;
  lines: string[];
}

/** Parse unified diff body into hunks (headers optional-tolerant). */
function parsePatch(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | undefined;
  for (const rawLine of patch.split('\n')) {
    if (rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')) continue;
    const header = rawLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      current = {
        aStart: Number(header[1]) - 1,
        aCount: Number(header[2] ?? 1),
        bStart: Number(header[3]) - 1,
        bCount: Number(header[4] ?? 1),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) {
      if (rawLine === '' || rawLine.startsWith('diff ') || rawLine.startsWith('index ')) continue;
      current = { aStart: 0, aCount: 0, bStart: 0, bCount: 0, lines: [] };
      hunks.push(current);
    }
    if (rawLine.length === 0)
      continue; // trailing newline artifact, not a context line
    else if (rawLine[0] === ' ' || rawLine[0] === '-' || rawLine[0] === '+')
      current.lines.push(rawLine);
    else if (rawLine === '\\ No newline at end of file') continue;
  }
  return hunks;
}

/** Apply parsed hunks at exact offsets; undefined when a hunk mismatches. */
function applyHunksStrict(original: string[], hunks: PatchHunk[]): string[] | undefined {
  const out = [...original];
  let drift = 0;
  for (const hunk of hunks) {
    // Empty hunk (no body lines): nothing to verify or change.
    if (hunk.lines.length === 0) continue;
    // Header-less hunks (aStart 0, no context): locate by first -/space line.
    let at = hunk.aStart + drift;
    const anchor = hunk.lines.find(l => l[0] === ' ' || l[0] === '-');
    if (hunk.aStart === 0 && hunk.aCount === 0 && anchor) {
      const found = out.indexOf(anchor.slice(1));
      if (found < 0) return undefined;
      at = found;
    }
    const applied = applySingleHunk(out, hunk, at);
    if (!applied) return undefined;
    drift += applied.length - out.length;
    out.splice(0, out.length, ...applied);
  }
  return out;
}

/** 62. Apply a unified diff patch to original text (fuzzy with growing context). */
export function applyPatch(original: string, patch: string): string {
  if (!patch.trim()) return original;
  const hunks = parsePatch(patch);
  const originalLines = toLines(original);
  const strict = applyHunksStrict(originalLines, hunks);
  if (strict) return joinLines(strict, original);
  for (const fuzz of [3, 10, 40]) {
    for (const hunk of hunks) {
      void hunk;
    }
    const shifted = tryApplyWithFuzz(originalLines, hunks, fuzz);
    if (shifted) return joinLines(shifted, original);
  }
  throw new Error('patch does not apply cleanly to the given text');
}

function joinLines(lines: string[], original: string): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (original.endsWith('\n') ? '\n' : '');
}

/** Slide each hunk within ±fuzz lines looking for a context match. */
function tryApplyWithFuzz(
  original: string[],
  hunks: PatchHunk[],
  fuzz: number
): string[] | undefined {
  const out = [...original];
  for (const hunk of hunks) {
    let applied = false;
    for (let shift = 0; shift <= fuzz && !applied; shift++) {
      for (const candidate of [hunk.aStart + shift, hunk.aStart - shift]) {
        if (candidate < 0 || candidate > out.length) continue;
        const trial = applySingleHunk(out, hunk, candidate);
        if (trial) {
          out.splice(0, out.length, ...trial);
          applied = true;
          break;
        }
      }
    }
    if (!applied) return undefined;
  }
  return out;
}

function applySingleHunk(lines: string[], hunk: PatchHunk, at: number): string[] | undefined {
  const out = [...lines];
  const next: string[] = [];
  let cursor = at;
  for (const line of hunk.lines) {
    const kind = line[0];
    const text = line.slice(1);
    if (kind === ' ') {
      if (out[cursor] !== text) return undefined;
      next.push(out[cursor]);
      cursor++;
    } else if (kind === '-') {
      if (out[cursor] !== text) return undefined;
      cursor++;
    } else {
      next.push(text);
    }
  }
  out.splice(at, cursor - at, ...next);
  return out;
}

/** 63. Reverse a unified diff (swap - / + sides, then apply). */
export function reversePatch(patched: string, patch: string): string {
  if (!patch.trim()) return patched;
  const reversed = patch
    .split('\n')
    .map(line => {
      if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@')) return line;
      if (line.startsWith('-')) return `+${line.slice(1)}`;
      if (line.startsWith('+')) return `-${line.slice(1)}`;
      return line;
    })
    .join('\n')
    .replace(
      /^(@@ -\d+(?:,\d+)? \+)(\d+(?:,\d+)?)( @@.*)$/gm,
      (_m, left: string, _b: string, right: string) => {
        void _b;
        return `${left}${_b}${right}`;
      }
    );
  return applyPatch(patched, reversed);
}

/** 64. Render a minimal self-contained HTML preview of a unified diff. */
export function previewDiffHTML(diff: string): string {
  const rows = diff
    .split('\n')
    .map(line => {
      const esc = escapeHtml(line);
      if (line.startsWith('+') && !line.startsWith('+++')) return `<div class="add">${esc}</div>`;
      if (line.startsWith('-') && !line.startsWith('---')) return `<div class="del">${esc}</div>`;
      if (line.startsWith('@@')) return `<div class="hunk">${esc}</div>`;
      return `<div class="ctx">${esc}</div>`;
    })
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>.add{background:#e6ffec}.del{background:#ffebe9}.hunk{color:#57606a}</style></head><body><pre class="diff">\n${rows}\n</pre></body></html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 65. Count added / removed lines in a unified diff. */
export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

/** 66. Best-effort three-way merge of base/ours/theirs line sets. */
export function threeWayMerge(
  base: string,
  ours: string,
  theirs: string
): { merged: string; conflicts: number } {
  const b = toLines(base);
  const o = toLines(ours);
  const t = toLines(theirs);
  const maxLen = Math.max(b.length, o.length, t.length);
  const out: string[] = [];
  let conflicts = 0;
  for (let idx = 0; idx < maxLen; idx++) {
    const baseLine = b[idx];
    const ourLine = o[idx];
    const theirLine = t[idx];
    if (ourLine === theirLine) {
      if (ourLine !== undefined) out.push(ourLine);
    } else if (ourLine === baseLine) {
      if (theirLine !== undefined) out.push(theirLine);
    } else if (theirLine === baseLine) {
      if (ourLine !== undefined) out.push(ourLine);
    } else {
      conflicts++;
      out.push(
        '<<<<<<< ours',
        ...(ourLine === undefined ? [] : [ourLine]),
        '=======',
        ...(theirLine === undefined ? [] : [theirLine]),
        '>>>>>>> theirs'
      );
    }
  }
  const trailing = base.endsWith('\n') || ours.endsWith('\n') || theirs.endsWith('\n') ? '\n' : '';
  return { merged: out.length === 0 ? '' : out.join('\n') + trailing, conflicts };
}

/** 67. Detect unresolved git conflict markers in text. */
export function detectConflictMarkers(text: string): { hasConflicts: boolean; lines: number[] } {
  const lines: number[] = [];
  text.split('\n').forEach((line, idx) => {
    if (/^(<{7} .|={7}$|>{7} |\|{7} )/.test(line)) lines.push(idx + 1);
  });
  return { hasConflicts: lines.length > 0, lines };
}

/** 68. Check whether a patch would apply without modifying anything. */
export function patchValidator(
  original: string,
  patch: string
): { valid: boolean; reason?: string } {
  if (!patch.trim()) return { valid: true };
  try {
    applyPatch(original, patch);
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 69. Split a large diff into per-file chunks for review. */
export function splitLargeDiff(diff: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1)
    throw new Error('maxChars must be a positive integer');
  if (diff.length <= maxChars) return diff === '' ? [] : [diff];
  const chunks: string[] = [];
  const parts = diff.split(/(?=^diff --git |^--- )/m).filter(p => p !== '');
  let current = '';
  for (const part of parts) {
    if ((current + part).length > maxChars && current !== '') {
      chunks.push(current);
      current = '';
    }
    if (part.length > maxChars) {
      for (let off = 0; off < part.length; off += maxChars)
        chunks.push(part.slice(off, off + maxChars));
    } else {
      current += part;
    }
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

/** 70. Draft a conventional-commit message from a diff's stat + touched files. */
export function diffToCommitMessage(diff: string): string {
  const { added, removed } = diffStat(diff);
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    const match = line.match(/^[+-]{3} [ab]\/(.+)$/) ?? line.match(/^diff --git a\/(.+) b\/.+$/);
    if (match) files.add(match[1]);
  }
  const onlyFile = files.size === 1 ? [...files][0].split('/').pop() : undefined;
  const scope = files.size === 1 ? `(${onlyFile})` : files.size > 1 ? `(${files.size} files)` : '';
  const action =
    added > 0 && removed === 0 ? 'add' : removed > 0 && added === 0 ? 'remove' : 'update';
  const headline = `feat${scope}: ${action} ${added} insertion${added === 1 ? '' : 's'}, ${removed} deletion${removed === 1 ? '' : 's'}`;
  const fileList = [...files].slice(0, 5).join(', ');
  return fileList ? `${headline}\n\n${fileList}` : headline;
}

/** 71. Keep only selected hunks (0-based) from a unified diff. */
export function hunkSelector(diff: string, selected: number[]): string {
  const header: string[] = [];
  const hunks: string[][] = [];
  let current: string[] | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      current = [line];
      hunks.push(current);
    } else if (current) current.push(line);
    else header.push(line);
  }
  const picked = selected.filter(idx => idx >= 0 && idx < hunks.length).map(idx => hunks[idx]);
  if (picked.length === 0) return '';
  return [...header, ...picked.flat()].join('\n').replace(/\n$/, '');
}

/** 72. Regenerate a diff with wider context lines. */
export function contextLinesExpander(before: string, after: string, context: number): string {
  return generateUnifiedDiff(before, after, { context });
}

/** 73. Heuristic binary-content detection for diff payloads. */
export function binaryDiffDetector(content: string): boolean {
  if (content.includes('\0')) return true;
  const sample = content.slice(0, 8000);
  if (sample.length === 0) return false;
  let suspicious = 0;
  for (const ch of sample) {
    const code = ch.charCodeAt(0);
    if (code < 9 || (code > 13 && code < 32) || code === 127) suspicious++;
  }
  return suspicious / sample.length > 0.3;
}

/** 74. Human-readable one-paragraph summary of a diff. */
export function diffSummaryForHuman(diff: string): string {
  const { added, removed } = diffStat(diff);
  if (added === 0 && removed === 0) return 'No changes.';
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    const match = line.match(/^[+-]{3} [ab]\/(.+)$/);
    if (match) files.add(match[1]);
  }
  const filePart =
    files.size === 0 ? '' : ` across ${files.size} file${files.size === 1 ? '' : 's'}`;
  return `Changed ${added} line${added === 1 ? '' : 's'} added and ${removed} line${removed === 1 ? '' : 's'} removed${filePart}.`;
}

/** 75. FIFO queue of pending patches with apply/discard helpers. */
export class PatchQueueManager {
  private queue: Array<{ id: string; patch: string }> = [];
  private nextId = 1;

  static create(): PatchQueueManager {
    return new PatchQueueManager();
  }

  /** Return a new independent queue (factory form listed in 500-functions.txt). */
  static patchQueueManager(): PatchQueueManager {
    return PatchQueueManager.create();
  }

  enqueue(patch: string): string {
    if (!patch.trim()) throw new Error('patch must not be empty');
    const id = `patch-${this.nextId++}`;
    this.queue.push({ id, patch });
    return id;
  }

  pending(): string[] {
    return this.queue.map(entry => entry.id);
  }

  discard(id: string): boolean {
    const idx = this.queue.findIndex(entry => entry.id === id);
    if (idx < 0) return false;
    this.queue.splice(idx, 1);
    return true;
  }

  applyNext(original: string): { id: string; result: string } {
    const entry = this.queue.shift();
    if (!entry) throw new Error('patch queue is empty');
    return { id: entry.id, result: applyPatch(original, entry.patch) };
  }
}

/** 77. Copy a workspace directory tree into a timestamped snapshot folder. */
export async function snapshotWorkspace(workspace: string, snapshotRoot?: string): Promise<string> {
  const root = snapshotRoot ?? path.join(os.tmpdir(), 'agent-cli-snapshots');
  const dest = path.join(root, `snapshot-${Date.now()}`);
  await fs.mkdir(dest, { recursive: true });
  await mergeDirectories(workspace, dest);
  return dest;
}

/** 76. Restore a workspace from a snapshot created by snapshotWorkspace(). */
export async function rollbackToSnapshot(workspace: string, snapshotDir: string): Promise<void> {
  await mergeDirectories(snapshotDir, workspace, { overwrite: true });
}

/** 78. Reject diffs larger than maxChars (returns the reason instead of throwing). */
export function diffSizeLimiter(diff: string, maxChars: number): { ok: boolean; reason?: string } {
  if (!Number.isInteger(maxChars) || maxChars < 1)
    throw new Error('maxChars must be a positive integer');
  if (diff.length <= maxChars) return { ok: true };
  return { ok: false, reason: `diff is ${diff.length} chars, limit is ${maxChars}` };
}

/** 79. True when a diff only touches whitespace (indentation, trailing spaces, blank lines). */
export function whitespaceOnlyDiffDetector(before: string, after: string): boolean {
  if (before === after) return true;
  const norm = (text: string): string =>
    toLines(text)
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(line => line !== '')
      .join('\n');
  return norm(before) === norm(after) && before !== after;
}

/** 80. Heuristic logic-vs-format classifier for a before/after pair. */
export function semanticDiffAnalyzer(
  before: string,
  after: string
): { logicChanged: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (before === after) return { logicChanged: false, reasons: ['identical'] };
  const strip = (text: string): string => {
    const noStrings = text
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    return noStrings
      .split('\n')
      .map(line => {
        const noComment = line.replace(/\/\/.*$/, '');
        return noComment.replace(/\s+/g, '').trim();
      })
      .filter(line => line !== '')
      .join('\n');
  };
  const beforeStripped = strip(before);
  const afterStripped = strip(after);
  if (beforeStripped !== afterStripped) {
    reasons.push('code tokens differ beyond whitespace/comments');
    return { logicChanged: true, reasons };
  }
  if (whitespaceOnlyDiffDetector(before, after)) reasons.push('only whitespace changed');
  else reasons.push('only comments or formatting changed');
  return { logicChanged: false, reasons };
}

/** Re-export for snapshot round-trip tests. */
export { atomicWriteFile };
