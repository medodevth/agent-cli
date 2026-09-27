/**
 * TextUtilities — string & text processing helpers (500-functions category B).
 *
 * Pure, dependency-free functions shared by prompts, logs, TUI output and
 * context handling. Every function is unit-tested in tests/unit/TextUtilities.test.ts.
 */

import { assignOwn } from './SafeObject.js';

/** 21. Truncate a string with an ellipsis, keeping whole words when possible. */
export function truncateWithEllipsis(text: string, maxLength: number, ellipsis = '…'): string {
  if (maxLength <= 0) return '';
  if (text.length <= maxLength) return text;
  const cut = maxLength - ellipsis.length;
  if (cut <= 0) return ellipsis.slice(0, maxLength);
  const slice = text.slice(0, cut);
  // If we landed exactly on a word boundary, keep the whole slice.
  if (text[cut] === ' ' || text[cut] === '\n' || text[cut] === '\t') return slice + ellipsis;
  const lastSpace = slice.lastIndexOf(' ');
  const kept = lastSpace > cut * 0.4 ? slice.slice(0, lastSpace) : slice;
  return kept + ellipsis;
}

/** 22. Remove ANSI escape sequences (colors, cursor moves, OSC hyperlinks). */
export function stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\][^\x07]*(?:\x07|\\)|\[[0-9;?]*[a-zA-Z]/g, '');
}

/** 23. Greedy word wrap that breaks overlong words; maxWidth >= 1. */
export function wordWrap(text: string, maxWidth: number): string[] {
  if (!Number.isInteger(maxWidth) || maxWidth < 1) throw new Error('maxWidth must be a positive integer');
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = '';
    const pushWord = (word: string): void => {
      if (current === '') {
        current = word;
      } else if ((current + ' ' + word).length <= maxWidth) {
        current += ' ' + word;
      } else {
        lines.push(current);
        current = word;
      }
    };
    for (const word of words) {
      if (word.length <= maxWidth) {
        pushWord(word);
        continue;
      }
      if (current !== '') {
        lines.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += maxWidth) lines.push(word.slice(i, i + maxWidth));
    }
    if (current !== '') lines.push(current);
  }
  return lines;
}

/** 24. Levenshtein edit distance (case-sensitive), O(min(m,n)) memory. */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let current0 = i;
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, current0 + 1, diag + cost);
      diag = temp;
      current0 = prev[j];
    }
  }
  return prev[b.length];
}

/** 25. Normalized similarity in [0,1]; 1 = identical. Case-insensitive. */
export function fuzzyMatch(a: string, b: string): number {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA === lowerB) return 1;
  const longest = Math.max(lowerA.length, lowerB.length);
  if (longest === 0) return 1;
  return 1 - levenshteinDistance(lowerA, lowerB) / longest;
}

function lookupPath(context: Record<string, unknown>, dotted: string): unknown {
  let current: unknown = context;
  for (const part of dotted.split('.')) {
    if (current === null || typeof current !== 'object' || !(part in (current as Record<string, unknown>))) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * 26. Interpolate {{ dotted.path }} placeholders. Unknown keys stay as-is.
 * Supports a default after a pipe: {{ name | fallback }}.
 */
export function templateInterpolate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^{}|]+?)(?:\|([^{}]*?))?\s*\}\}/g, (match, key: string, fallback: string | undefined) => {
    const value = lookupPath(context, key.trim());
    if (value === undefined || value === null) return fallback !== undefined ? fallback.trim() : match;
    return String(value);
  });
}

/** 27. URL/filename-safe slug. */
export function slugify(text: string): string {
  const ascii = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  return ascii
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export interface CodeBlock {
  language: string;
  code: string;
}

/** 28. Extract fenced code blocks from markdown (``` or ~~~). */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const fence = /(^|\n)(`{3,}|~{3,})[ \t]*([^\n]*)\n([\s\S]*?)\n\2(?=\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(markdown)) !== null) {
    blocks.push({ language: match[3].trim().split(/\s+/)[0] ?? '', code: match[4].replace(/\n$/, '') });
  }
  return blocks;
}

/** 29. Replace known secret patterns (API keys, tokens, private keys, passwords). */
export function redactSecretsInText(text: string, replacement = '[REDACTED]'): string {
  const patterns: RegExp[] = [
    /\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{16,}|xox[bap]-?[A-Za-z0-9-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AIza[0-9A-Za-z\-_]{20,}|AKIA[0-9A-Z]{12,}[A-Z0-9/+=]{20,})/g,
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b(?=\s*[:=]\s*\S)/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /(?<=(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*['"]?)[^'"\s,}]+/gi,
  ];
  let result = text;
  for (const pattern of patterns) result = result.replace(pattern, replacement);
  return result;
}

/** 30. Mask emails, phone-like runs, and long digit runs (cards/IDs). */
export function maskPII(text: string): string {
  return text
    .replace(/\b([A-Za-z0-9._%+-])([A-Za-z0-9._%+-]*?)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '$1***@$3')
    .replace(/(?<!\d)(?:\+?\d[\s\-.]?){7,}\d(?!\d)/g, match =>
      match.length >= 7 ? `${match[0]}***${match[match.length - 1]}` : '***',
    );
}

/** 31. Collapse runs of whitespace inside each line, trim blank edges. */
export function normalizeWhitespace(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

/** 32. Split text on token-budget boundaries (approx chars/token). */
export function splitByToken(text: string, maxTokens: number, charsPerToken = 4): string[] {
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error('maxTokens must be positive');
  if (!Number.isInteger(charsPerToken) || charsPerToken <= 0) throw new Error('charsPerToken must be positive');
  const maxChars = maxTokens * charsPerToken;
  if (text.length <= maxChars) return text === '' ? [] : [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end);
      if (newline > start + maxChars * 0.5) end = newline + 1;
      else {
        const space = text.lastIndexOf(' ', end);
        if (space > start + maxChars * 0.5) end = space + 1;
      }
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/** 33. Rough token estimate: ceil(non-space chars / charsPerToken). */
export function countTokensApprox(text: string, charsPerToken = 4): number {
  const meaningful = text.replace(/\s/g, '').length;
  if (meaningful === 0) return 0;
  return Math.max(1, Math.ceil(meaningful / charsPerToken));
}

const LANGUAGE_HINTS: Array<{ language: string; patterns: RegExp[] }> = [
  { language: 'typescript', patterns: [/\binterface\s+\w+/, /:\s*(string|number|boolean)\s*[;=]/, /from\s+['"]\.\//] },
  { language: 'javascript', patterns: [/\bmodule\.exports\b/, /require\(['"]/, /console\.log\(/] },
  { language: 'python', patterns: [/^\s*def\s+\w+\s*\(/m, /^\s*import\s+\w+/m, /:\s*$/m] },
  { language: 'rust', patterns: [/\bfn\s+\w+\s*\(/, /let\s+mut\s+\w+/, /println!\(/] },
  { language: 'go', patterns: [/^\s*package\s+\w+/m, /func\s+\w+\s*\(/, /fmt\.Print/] },
  { language: 'shell', patterns: [/^#!\/bin\/(ba)?sh/m, /\becho\s+["']/, /\bfi\b/] },
];

/** 34. Best-effort language guess from content (fences checked first). */
export function detectLanguageFromContent(content: string): string {
  const fence = content.match(/^```(\w+)/m);
  if (fence) return fence[1].toLowerCase();
  let best = 'unknown';
  let bestScore = 0;
  for (const { language, patterns } of LANGUAGE_HINTS) {
    const score = patterns.reduce((sum, pattern) => sum + (pattern.test(content) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = language;
    }
  }
  return best;
}

/** 35. Strip scripts/event handlers/javascript: URLs; keep plain text readable. */
export function sanitizeHtmlOutput(html: string): string {
  let result = html.replace(/<script[\s\S]*?<\/script\s*>/gi, '').replace(/<style[\s\S]*?<\/style\s*>/gi, '');
  result = result.replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  result = result.replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'>\s]*/gi, '$1=$2#blocked');
  return result;
}

/** 36. JSON.parse with a typed fallback — never throws. */
export function jsonSafeParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** 37. Minimal safe YAML subset (flat key: value, lists, nesting); fallback on error. */
export function yamlSafeParse<T>(text: string, fallback: T): T {
  try {
    const lines = text.split('\n');
    const root: Record<string, unknown> = {};
    const stack: Array<{ indent: number; container: Record<string, unknown> | unknown[]; key?: string }> = [
      { indent: -1, container: root },
    ];
    const parseScalar = (raw: string): unknown => {
      const value = raw.trim();
      if (value === '' || value === 'null' || value === '~') return null;
      if (value === 'true') return true;
      if (value === 'false') return false;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
      }
      const num = Number(value);
      if (value !== '' && !Number.isNaN(num)) return num;
      return value;
    };
    for (const rawLine of lines) {
      if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
      const indent = rawLine.match(/^ */)?.[0].length ?? 0;
      const trimmed = rawLine.trim();
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
      const parent = stack[stack.length - 1];
      if (trimmed.startsWith('- ')) {
        const value = parseScalar(trimmed.slice(2));
        if (Array.isArray(parent.container)) {
          parent.container.push(value);
        } else if (
          parent.key !== undefined &&
          stack.length >= 2 &&
          typeof parent.container === 'object' &&
          parent.container !== null &&
          Object.keys(parent.container).length === 0
        ) {
          // A `key:` line with no inline value followed by list items is a list,
          // not a map — swap the placeholder object for an array.
          const arr: unknown[] = [value];
          (stack[stack.length - 2].container as Record<string, unknown>)[parent.key] = arr;
          parent.container = arr;
          parent.key = undefined;
          stack.push({ indent, container: arr });
        } else {
          return fallback;
        }
        continue;
      }
      const colon = trimmed.indexOf(':');
      if (colon === -1) return fallback;
      const key = trimmed.slice(0, colon).trim();
      const rest = trimmed.slice(colon + 1).trim();
      if (!key) return fallback;
      if (Array.isArray(parent.container)) return fallback;
      const obj = parent.container as Record<string, unknown>;
      if (rest === '') {
        const nested: Record<string, unknown> = {};
        assignOwn(obj, key, nested);
        stack.push({ indent, container: nested, key });
      } else {
        assignOwn(obj, key, parseScalar(rest));
      }
    }
    return root as T;
  } catch {
    return fallback;
  }
}

/** 38. Extract http(s) URLs, trimming trailing punctuation. */
export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"'`]+/g) ?? [];
  return matches.map(url => url.replace(/[.,;:!?)\]]+$/g, ''));
}

/** 39. Line diff with common prefix/suffix trimming: - removed, + added, ' ' same. */
export function diffTextLines(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const out: string[] = [];
  for (let i = 0; i < prefix; i++) out.push(' ' + a[i]);
  for (let i = prefix; i < a.length - suffix; i++) out.push('-' + a[i]);
  for (let i = prefix; i < b.length - suffix; i++) out.push('+' + b[i]);
  for (let i = a.length - suffix; i < a.length; i++) out.push(' ' + a[i]);
  return out;
}

/** 40. Minimal English pluralizer for log messages (count + noun). */
export function pluralize(count: number, singular: string, plural?: string): string {
  const word =
    count === 1
      ? singular
      : (plural ?? (/[sxz]$|ch$|sh$/i.test(singular) ? singular + 'es' : /[^aeiou]y$/i.test(singular) ? singular.slice(0, -1) + 'ies' : singular + 's'));
  return `${count} ${word}`;
}
