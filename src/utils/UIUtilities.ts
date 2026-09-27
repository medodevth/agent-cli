/**
 * UIUtilities — pure terminal-friendly renderers and injected input helpers
 * for the UI/TUI section of docs/500-functions.txt (361–380).
 *
 * These helpers never write to a terminal or read process input. Effects are
 * opt-in through callbacks so callers can compose them with Ink or another UI.
 */

export interface ProgressBarOptions {
  width?: number;
  filled?: string;
  empty?: string;
  showPercent?: boolean;
}

function requireWidth(width: number, label = 'width'): void {
  if (!Number.isInteger(width) || width < 1) throw new Error(`${label} must be a positive integer`);
}

function ratio(current: number, total: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, current / total));
}

/** 361. Render a deterministic, width-bounded progress bar. */
export function renderProgressBar(current: number, total: number, options: ProgressBarOptions = {}): string {
  const width = options.width ?? 20;
  requireWidth(width);
  const fill = Math.floor(ratio(current, total) * width);
  const bar = `${(options.filled ?? '█').repeat(fill)}${(options.empty ?? '░').repeat(width - fill)}`;
  const percentage = Math.round(ratio(current, total) * 100);
  return `[${bar}]${options.showPercent === false ? '' : ` ${percentage}%`}`;
}

export interface DiffViewOptions {
  /** Maximum changed/context lines to show; patch and hunk headers do not count. */
  maxLines?: number;
}

function pluralCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/** 362. Render a compact unified-diff view with counts and optional truncation. */
export function renderDiffView(diff: string, options: DiffViewOptions = {}): string {
  const maxLines = options.maxLines ?? Number.POSITIVE_INFINITY;
  if (maxLines !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxLines) || maxLines < 0)) {
    throw new Error('maxLines must be a non-negative integer');
  }
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  if (diff.endsWith('\n')) lines.pop();
  const additions = lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
  const deletions = lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length;
  const target = lines.find(line => line.startsWith('+++ '))?.slice(4).replace(/^b\//, '');
  const rendered: string[] = [`Diff: ${target || 'file'}`, `${pluralCount(additions, 'addition')}, ${pluralCount(deletions, 'deletion')}`];
  let visibleBodyLines = 0;
  let omittedBodyLines = 0;
  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@')) {
      rendered.push(line);
    } else if (visibleBodyLines < maxLines) {
      rendered.push(line);
      visibleBodyLines++;
    } else {
      omittedBodyLines++;
    }
  }
  if (omittedBodyLines > 0) rendered.push(`… ${pluralCount(omittedBodyLines, 'diff line')} omitted …`);
  return rendered.join('\n');
}

/** 363. Render token consumption against a context-window budget. */
export function renderTokenUsageBar(used: number, limit: number, options: ProgressBarOptions = {}): string {
  const formattedUsed = Number.isFinite(used) ? Math.max(0, used) : 0;
  const formattedLimit = Number.isFinite(limit) ? Math.max(0, limit) : 0;
  return `${renderProgressBar(used, limit, options)} (${formattedUsed.toLocaleString('en-US')}/${formattedLimit.toLocaleString('en-US')} tokens)`;
}

export interface ApprovalPromptIO {
  ask: (prompt: string) => string | boolean | Promise<string | boolean>;
}

/** 364. Ask through injected IO; only boolean true or the full word "yes" approves. */
export async function interactiveApprovalPrompt(message: string, io: ApprovalPromptIO): Promise<boolean> {
  const response = await io.ask(`${message} Type yes to approve: `);
  return response === true || (typeof response === 'string' && response.trim().toLowerCase() === 'yes');
}

export interface TreeNode {
  name: string;
  type?: 'directory' | 'file' | 'symlink' | 'other';
  children?: TreeNode[];
}

export interface TreeRenderOptions {
  maxDepth?: number;
}

/** 365. Render a file-tree structure with Unicode branches (does no filesystem IO). */
export function renderTree(tree: TreeNode | TreeNode[], options: TreeRenderOptions = {}): string {
  if (options.maxDepth !== undefined && (!Number.isInteger(options.maxDepth) || options.maxDepth < 0)) {
    throw new Error('maxDepth must be a non-negative integer');
  }
  const roots = Array.isArray(tree) ? tree : [tree];
  const output: string[] = [];
  const visit = (node: TreeNode, prefix: string, isLast: boolean, depth: number, root: boolean): void => {
    const connector = root ? '' : isLast ? '└── ' : '├── ';
    output.push(`${prefix}${connector}${node.name}`);
    if (!node.children || (options.maxDepth !== undefined && depth >= options.maxDepth)) return;
    const childPrefix = root ? '' : prefix + (isLast ? '    ' : '│   ');
    node.children.forEach((child, index) => visit(child, childPrefix, index === node.children!.length - 1, depth + 1, false));
  };
  roots.forEach((root, index) => visit(root, '', index === roots.length - 1, 0, roots.length === 1));
  return output.join('\n');
}

export interface TrajectoryEntry {
  action: string;
  description?: string;
  status?: 'completed' | 'done' | 'running' | 'pending' | 'failed' | 'skipped';
}

/** 366. Render ordered agent actions as a readable trajectory timeline. */
export function renderTrajectoryView(entries: TrajectoryEntry[]): string {
  const icon: Record<NonNullable<TrajectoryEntry['status']>, string> = {
    completed: '✓', done: '✓', running: '◌', pending: '○', failed: '✗', skipped: '–',
  };
  return entries.map((entry, index) => {
    const marker = entry.status ? `${icon[entry.status]} ` : '';
    return `${index + 1}. ${marker}${entry.action}${entry.description ? ` — ${entry.description}` : ''}`;
  }).join('\n');
}

const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'do',
  'else', 'export', 'extends', 'finally', 'for', 'from', 'function', 'if', 'implements', 'import',
  'in', 'interface', 'let', 'new', 'of', 'package', 'private', 'protected', 'public', 'return',
  'static', 'throw', 'try', 'type', 'var', 'while', 'yield', 'def', 'elif', 'except', 'lambda',
  'pass', 'raise', 'with', 'fn', 'use', 'mod', 'pub', 'mut', 'struct', 'enum', 'impl',
]);

function ansi(color: string, text: string): string {
  return `\u001b[${color}m${text}\u001b[0m`;
}

/** 367. Best-effort ANSI syntax highlighting for common code languages. */
export function syntaxHighlighter(code: string, language: string): string {
  const normalized = language.trim().toLowerCase();
  const supported = new Set(['ts', 'typescript', 'tsx', 'js', 'javascript', 'jsx', 'py', 'python', 'json', 'sh', 'bash', 'rs', 'rust', 'go']);
  if (!supported.has(normalized)) return code;
  const tokenPattern = /(\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b[A-Za-z_$][\w$]*\b|\b\d+(?:\.\d+)?\b)/g;
  return code.replace(tokenPattern, token => {
    if (token.startsWith('//') || token.startsWith('#')) return ansi('90', token);
    if (/^["'`]/.test(token)) return ansi('32', token);
    if (/^(?:true|false|null|undefined|None|True|False|NaN|Infinity)$/.test(token)) return ansi('35', token);
    if (/^\d/.test(token)) return ansi('33', token);
    if (KEYWORDS.has(token)) return ansi('36', token);
    return token;
  });
}

function renderInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 <$2>')
    .replace(/(`+)(.*?)\1/g, '$2')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/~~(.*?)~~/g, '$1');
}

/** 368. Render common Markdown constructs into plain terminal-readable text. */
export function renderMarkdownInTerminal(markdown: string): string {
  const output: string[] = [];
  let inFence = false;
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      output.push(line);
      continue;
    }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) {
      output.push(renderInlineMarkdown(heading[1]));
      continue;
    }
    const list = line.match(/^(\s*)(?:[-+*]|\d+[.)])\s+(.*)$/);
    if (list) {
      output.push(`${list[1]}• ${renderInlineMarkdown(list[2])}`);
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      output.push(`│ ${renderInlineMarkdown(quote[1])}`);
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      output.push('─'.repeat(3));
      continue;
    }
    output.push(renderInlineMarkdown(line));
  }
  return output.join('\n');
}

export interface KeyboardShortcutInput {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

function normalizeKey(key: string): string {
  const lower = key.trim().toLowerCase();
  if (lower === 'escape') return 'esc';
  if (lower === 'return') return 'enter';
  if (lower === ' ') return 'space';
  return lower;
}

function normalizeShortcut(shortcut: string): string {
  const parts = shortcut.split('+').map(part => part.trim().toLowerCase()).filter(Boolean);
  const modifiers = ['ctrl', 'control', 'alt', 'shift', 'meta', 'cmd', 'command'];
  const has = (names: string[]): boolean => parts.some(part => names.includes(part));
  const key = parts.find(part => !modifiers.includes(part));
  const normalizedKey = normalizeKey(key ?? '');
  const prefix = [
    has(['ctrl', 'control']) ? 'ctrl' : '',
    has(['alt']) ? 'alt' : '',
    has(['shift']) ? 'shift' : '',
    has(['meta', 'cmd', 'command']) ? 'meta' : '',
  ].filter(Boolean);
  return [...prefix, normalizedKey].filter(Boolean).join('+');
}

/** 369. Resolve a keypress against shortcut bindings (string or callback values). */
export function keyboardShortcutHandler<T>(
  input: string | KeyboardShortcutInput,
  shortcuts: Record<string, T | (() => T)>,
): T | undefined {
  const shortcut = typeof input === 'string'
    ? normalizeShortcut(input)
    : normalizeShortcut([
      input.ctrl ? 'ctrl' : '', input.alt ? 'alt' : '', input.shift ? 'shift' : '', input.meta ? 'meta' : '', input.key,
    ].filter(Boolean).join('+'));
  const bindingKey = Object.keys(shortcuts).find(key => normalizeShortcut(key) === shortcut);
  if (bindingKey === undefined) return undefined;
  const binding = shortcuts[bindingKey];
  return typeof binding === 'function' ? (binding as () => T)() : binding;
}

export interface ErrorPanelOptions {
  title?: string;
  hint?: string;
  details?: string;
}

/** 370. Render an error and optional recovery hint without printing it. */
export function renderErrorPanel(error: unknown, options: ErrorPanelOptions = {}): string {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  const lines = [`✖ ${options.title ?? 'Error'}`, `${name}: ${message}`];
  if (options.hint) lines.push(`Hint: ${options.hint}`);
  if (options.details) lines.push(options.details);
  return lines.join('\n');
}

/** 371. Create an immutable status update, suitable for a UI state reducer. */
export function statusBarUpdater<T extends Record<string, unknown>>(
  current: T,
  update: Partial<T>,
): T {
  return { ...current, ...update };
}

export interface ScrollableLogPaneOptions {
  offset: number;
  height: number;
}

export interface ScrollableLogPaneResult {
  lines: string[];
  offset: number;
  total: number;
  canScrollUp: boolean;
  canScrollDown: boolean;
}

/** 372. Select a clamped viewport from log lines without terminal cursor control. */
export function scrollableLogPane(lines: string[], options: ScrollableLogPaneOptions): ScrollableLogPaneResult {
  requireWidth(options.height, 'height');
  const maxOffset = Math.max(0, lines.length - options.height);
  const offset = Math.min(maxOffset, Math.max(0, Math.floor(Number.isFinite(options.offset) ? options.offset : 0)));
  return {
    lines: lines.slice(offset, offset + options.height),
    offset,
    total: lines.length,
    canScrollUp: offset > 0,
    canScrollDown: offset < maxOffset,
  };
}

export interface CostDashboardData {
  totalCost: number;
  budget?: number;
  byModel?: Record<string, number>;
}

function formatCost(cost: number): string {
  return `$${(Number.isFinite(cost) ? cost : 0).toFixed(2)}`;
}

/** 373. Render supplied cost totals and optional per-model breakdown. */
export function renderCostDashboard(data: CostDashboardData): string {
  const lines = [`Total cost: ${formatCost(data.totalCost)}`];
  if (data.budget !== undefined) lines.push(`Budget: ${formatCost(data.budget)}`);
  for (const [model, cost] of Object.entries(data.byModel ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${model}: ${formatCost(cost)}`);
  }
  return lines.join('\n');
}

/** 374. Ask through injected IO; approving requires an explicit full-word yes. */
export async function confirmDialog(message: string, io: ApprovalPromptIO): Promise<boolean> {
  const response = await io.ask(`${message} Type yes to confirm: `);
  return response === true || (typeof response === 'string' && response.trim().toLowerCase() === 'yes');
}

export interface PluginListItem {
  name: string;
  enabled: boolean;
  version?: string;
  description?: string;
}

/** 375. Render installed plugins in stable alphabetical order. */
export function renderPluginList(plugins: PluginListItem[]): string {
  return [...plugins]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(plugin => `${plugin.enabled ? '● enabled' : '○ disabled'}  ${plugin.name}${plugin.version ? ` v${plugin.version}` : ''}${plugin.description ? ` — ${plugin.description}` : ''}`)
    .join('\n');
}

export interface Theme {
  mode: 'light' | 'dark';
  colors: { background: string; foreground: string; accent: string; muted: string; error: string; success: string };
}

const THEMES: Record<Theme['mode'], Theme> = {
  dark: { mode: 'dark', colors: { background: '#111827', foreground: '#f9fafb', accent: '#c084fc', muted: '#9ca3af', error: '#f87171', success: '#34d399' } },
  light: { mode: 'light', colors: { background: '#ffffff', foreground: '#111827', accent: '#7e22ce', muted: '#6b7280', error: '#b91c1c', success: '#047857' } },
};

/** 376. Load a fresh built-in light/dark theme and optionally apply color overrides. */
export function themeLoader(mode: Theme['mode'] = 'dark', overrides: Partial<Theme['colors']> = {}): Theme {
  return { mode, colors: { ...THEMES[mode].colors, ...overrides } };
}

export interface SpinnerOptions {
  frames?: string[];
  label?: string;
}

/** 377. Render a chosen spinner frame; no timer or terminal writer is started. */
export function renderSpinner(frame: number, options: SpinnerOptions = {}): string {
  const frames = options.frames?.length ? options.frames : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const selected = frames[((Math.floor(Number.isFinite(frame) ? frame : 0) % frames.length) + frames.length) % frames.length];
  return options.label ? `${selected} ${options.label}` : selected;
}

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';
export interface NotificationOptions {
  level?: NotificationLevel;
  onNotify?: (notice: string) => void;
}

/** 378. Format a toast; deliver it only when a caller injects a callback. */
export function notificationToast(message: string, options: NotificationOptions = {}): string {
  const icons: Record<NotificationLevel, string> = { info: 'ℹ', success: '✓', warning: '⚠', error: '✖' };
  const notice = `${icons[options.level ?? 'info']} ${message}`;
  options.onNotify?.(notice);
  return notice;
}

export interface RenderTableOptions {
  columns?: string[];
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 379. Render object rows as an aligned plain-text table. */
export function renderTable(rows: Array<Record<string, unknown>>, options: RenderTableOptions = {}): string {
  const columns = options.columns ? [...options.columns] : [...new Set(rows.flatMap(row => Object.keys(row)))];
  if (columns.length === 0) return '';
  const matrix = [columns, ...rows.map(row => columns.map(column => cellText(row[column])))];
  const widths = columns.map((column, index) => Math.max(column.length, ...matrix.slice(1).map(row => row[index].length)));
  const formatRow = (row: string[]): string => row.map((cell, index) => cell.padEnd(widths[index])).join(' | ').trimEnd();
  const header = formatRow(matrix[0]);
  const rule = widths.map(width => '─'.repeat(width)).join('─┼─');
  return [header, rule, ...matrix.slice(1).map(formatRow)].join('\n');
}

export interface QuickHelpItem {
  key: string;
  description: string;
}

const DEFAULT_HELP: QuickHelpItem[] = [
  { key: 'Ctrl+C', description: 'Exit' },
  { key: 'Esc', description: 'Cancel' },
  { key: 'Enter', description: 'Confirm' },
];

/** 380. Render concise key/command help with an optional caller-supplied list. */
export function renderQuickHelp(items: QuickHelpItem[] = DEFAULT_HELP): string {
  return items.map(item => `${item.key}  ${item.description}`).join('\n');
}
