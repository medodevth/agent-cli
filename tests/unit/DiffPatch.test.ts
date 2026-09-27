import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { patchQueueManager } from '../../src/utils/PatchQueueUtilities.js';
import {
  applyPatch,
  binaryDiffDetector,
  contextLinesExpander,
  detectConflictMarkers,
  diffSizeLimiter,
  diffStat,
  diffSummaryForHuman,
  diffToCommitMessage,
  generateUnifiedDiff,
  hunkSelector,
  PatchQueueManager,
  patchValidator,
  previewDiffHTML,
  reversePatch,
  rollbackToSnapshot,
  semanticDiffAnalyzer,
  snapshotWorkspace,
  splitLargeDiff,
  threeWayMerge,
  whitespaceOnlyDiffDetector,
} from '../../src/utils/DiffPatch.js';

const BEFORE = 'line1\nline2\nline3\nline4\n';
const AFTER = 'line1\nline2 changed\nline3\nline4\nline5\n';

describe('generateUnifiedDiff (61)', () => {
  it('produces headers and +/- lines, empty string for identical inputs', () => {
    const diff = generateUnifiedDiff(BEFORE, AFTER, { fileName: 'demo.txt' });
    expect(diff).toContain('--- a/demo.txt');
    expect(diff).toContain('+++ b/demo.txt');
    expect(diff).toContain('-line2');
    expect(diff).toContain('+line2 changed');
    expect(diff).toContain('@@');
    expect(generateUnifiedDiff(BEFORE, BEFORE)).toBe('');
  });

  it('rejects negative context', () => {
    expect(() => generateUnifiedDiff(BEFORE, AFTER, { context: -1 })).toThrow(/context/);
  });
});

describe('applyPatch (62)', () => {
  it('round-trips a generated diff', () => {
    const diff = generateUnifiedDiff(BEFORE, AFTER);
    expect(applyPatch(BEFORE, diff)).toBe(AFTER);
  });

  it('returns the original for an empty patch', () => {
    expect(applyPatch(BEFORE, '   \n')).toBe(BEFORE);
  });

  it('throws when the patch does not match', () => {
    expect(() => applyPatch('totally different\n', generateUnifiedDiff(BEFORE, AFTER))).toThrow(
      /does not apply/
    );
  });
});

describe('reversePatch (63)', () => {
  it('undoes an applied patch', () => {
    const diff = generateUnifiedDiff(BEFORE, AFTER);
    const patched = applyPatch(BEFORE, diff);
    expect(reversePatch(patched, diff)).toBe(BEFORE);
  });
});

describe('previewDiffHTML (64)', () => {
  it('renders a self-contained html page with add/del classes', () => {
    const html = previewDiffHTML(generateUnifiedDiff(BEFORE, AFTER));
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('class="add"');
    expect(html).toContain('class="del"');
    expect(html).toContain('class="ctx"');
  });

  it('escapes html special chars', () => {
    const html = previewDiffHTML('+<b>hi</b> & bye\n');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('&amp;');
  });
});

describe('diffStat (65)', () => {
  it('counts added and removed lines', () => {
    expect(diffStat(generateUnifiedDiff(BEFORE, AFTER))).toEqual({ added: 2, removed: 1 });
    expect(diffStat('no diff here\n')).toEqual({ added: 0, removed: 0 });
  });
});

describe('threeWayMerge (66)', () => {
  it('merges non-overlapping edits without conflicts', () => {
    const base = 'a\nb\nc\n';
    const { merged, conflicts } = threeWayMerge(base, 'A\nb\nc\n', 'a\nb\nC\n');
    expect(conflicts).toBe(0);
    expect(merged).toBe('A\nb\nC\n');
  });

  it('marks overlapping edits as conflicts', () => {
    const { conflicts, merged } = threeWayMerge('a\n', 'A\n', 'a-changed\n');
    expect(conflicts).toBe(1);
    expect(merged).toContain('<<<<<<< ours');
    expect(merged).toContain('>>>>>>> theirs');
  });
});

describe('detectConflictMarkers (67)', () => {
  it('finds git conflict markers with line numbers', () => {
    const text = 'ok\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n';
    const found = detectConflictMarkers(text);
    expect(found.hasConflicts).toBe(true);
    expect(found.lines.length).toBeGreaterThan(0);
    expect(detectConflictMarkers('clean\nfile\n').hasConflicts).toBe(false);
  });
});

describe('patchValidator (68)', () => {
  it('accepts applicable patches and rejects bad ones', () => {
    const diff = generateUnifiedDiff(BEFORE, AFTER);
    expect(patchValidator(BEFORE, diff)).toEqual({ valid: true });
    const bad = patchValidator('other\n', diff);
    expect(bad.valid).toBe(false);
    expect(bad.reason).toBeDefined();
    expect(patchValidator(BEFORE, '')).toEqual({ valid: true });
  });
});

describe('splitLargeDiff (69)', () => {
  it('returns small diffs whole and splits big ones within limits', () => {
    const small = generateUnifiedDiff('a\n', 'b\n');
    expect(splitLargeDiff(small, 10000)).toEqual([small]);
    const big = `${'x'.repeat(500)}\n${'y'.repeat(500)}\n`;
    const chunks = splitLargeDiff(big, 400);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(big);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(400);
    expect(splitLargeDiff('', 10)).toEqual([]);
  });
});

describe('diffToCommitMessage (70)', () => {
  it('drafts a conventional message with scope and stats', () => {
    const msg = diffToCommitMessage(generateUnifiedDiff('a\n', 'b\n', { fileName: 'src/app.ts' }));
    expect(msg).toContain('feat(app.ts)');
    expect(msg).toContain('insertion');
  });
});

describe('hunkSelector (71)', () => {
  it('keeps only selected hunks', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n') + '\n';
    const after = before.replace('line2', 'line2x').replace('line25', 'line25x');
    const diff = generateUnifiedDiff(before, after, { context: 1 });
    const hunkCount = diff.split('\n').filter(l => l.startsWith('@@')).length;
    expect(hunkCount).toBeGreaterThanOrEqual(2);
    const one = hunkSelector(diff, [0]);
    expect(one.split('\n').filter(l => l.startsWith('@@'))).toHaveLength(1);
    expect(applyPatch(before, one)).toContain('line2x');
    expect(hunkSelector(diff, [99])).toBe('');
  });
});

describe('contextLinesExpander (72)', () => {
  it('widens context versus the default', () => {
    const narrow = generateUnifiedDiff(BEFORE, AFTER, { context: 0 });
    const wide = contextLinesExpander(BEFORE, AFTER, 5);
    expect(wide.length).toBeGreaterThanOrEqual(narrow.length);
    expect(applyPatch(BEFORE, wide)).toBe(AFTER);
  });
});

describe('binaryDiffDetector (73)', () => {
  it('flags NUL bytes and high control-char ratios', () => {
    expect(binaryDiffDetector('plain text\n')).toBe(false);
    expect(binaryDiffDetector('ab\0cd')).toBe(true);
  });
});

describe('diffSummaryForHuman (74)', () => {
  it('summarizes changes and the empty case', () => {
    expect(diffSummaryForHuman(generateUnifiedDiff(BEFORE, AFTER))).toContain('added');
    expect(diffSummaryForHuman('')).toBe('No changes.');
  });
});

describe('PatchQueueManager (75)', () => {
  it('enqueues, lists, applies and discards patches in order', () => {
    const queue = new PatchQueueManager();
    const id1 = queue.enqueue(generateUnifiedDiff('a\n', 'b\n'));
    const id2 = queue.enqueue(generateUnifiedDiff('b\n', 'c\n'));
    expect(queue.pending()).toEqual([id1, id2]);
    expect(queue.discard(id2)).toBe(true);
    expect(queue.pending()).toEqual([id1]);
    const applied = queue.applyNext('a\n');
    expect(applied).toEqual({ id: id1, result: 'b\n' });
    expect(() => queue.applyNext('a\n')).toThrow(/empty/);
    expect(() => queue.enqueue('  ')).toThrow(/empty/);
  });

  it('supports the documented factory API', () => {
    const queue = patchQueueManager();
    const id = queue.enqueue(generateUnifiedDiff('a\n', 'b\n'));
    expect(queue.pending()).toEqual([id]);
    expect(queue.applyNext('a\n')).toEqual({ id, result: 'b\n' });
  });
});

describe('snapshotWorkspace / rollbackToSnapshot (76-77)', () => {
  it('snapshots a directory tree and restores it', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cli-ws-'));
    const snapRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cli-snaps-'));
    await fs.writeFile(path.join(workspace, 'note.txt'), 'v1');
    const snapDir = await snapshotWorkspace(workspace, snapRoot);
    await fs.writeFile(path.join(workspace, 'note.txt'), 'v2');
    await rollbackToSnapshot(workspace, snapDir);
    await expect(fs.readFile(path.join(workspace, 'note.txt'), 'utf8')).resolves.toBe('v1');
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(snapRoot, { recursive: true, force: true });
  });
});

describe('diffSizeLimiter (78)', () => {
  it('accepts small diffs and rejects oversized ones', () => {
    expect(diffSizeLimiter('tiny', 10).ok).toBe(true);
    const rejected = diffSizeLimiter('x'.repeat(11), 10);
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toContain('11');
    expect(() => diffSizeLimiter('x', 0)).toThrow(/positive integer/);
  });
});

describe('whitespaceOnlyDiffDetector (79)', () => {
  it('detects whitespace-only changes', () => {
    expect(whitespaceOnlyDiffDetector('a  b\n', 'a b\n')).toBe(true);
    expect(whitespaceOnlyDiffDetector('a\n', 'a\n')).toBe(true);
    expect(whitespaceOnlyDiffDetector('a\n', 'b\n')).toBe(false);
  });
});

describe('semanticDiffAnalyzer (80)', () => {
  it('classifies logic changes versus format-only changes', () => {
    expect(semanticDiffAnalyzer('const a = 1;\n', 'const a = 2;\n').logicChanged).toBe(true);
    expect(semanticDiffAnalyzer('const a=1;\n', 'const  a  =  1;\n').logicChanged).toBe(false);
    expect(semanticDiffAnalyzer('const a = 1; // hi\n', 'const a = 1;\n').logicChanged).toBe(false);
    expect(semanticDiffAnalyzer('same\n', 'same\n')).toEqual({
      logicChanged: false,
      reasons: ['identical'],
    });
  });
});
