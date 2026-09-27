import {
  confirmDialog,
  interactiveApprovalPrompt,
  keyboardShortcutHandler,
  notificationToast,
  renderCostDashboard,
  renderDiffView,
  renderErrorPanel,
  renderMarkdownInTerminal,
  renderPluginList,
  renderProgressBar,
  renderQuickHelp,
  renderSpinner,
  renderTable,
  renderTrajectoryView,
  renderTokenUsageBar,
  renderTree,
  scrollableLogPane,
  statusBarUpdater,
  syntaxHighlighter,
  themeLoader,
} from '../../src/utils/UIUtilities.js';

describe('UIUtilities progress and approval renderers', () => {
  it('renders bounded progress with deterministic percentage and width', () => {
    expect(renderProgressBar(3, 5, { width: 5 })).toBe('[███░░] 60%');
    expect(renderProgressBar(8, 4, { width: 4 })).toBe('[████] 100%');
    expect(renderProgressBar(-2, 0, { width: 2 })).toBe('[░░] 0%');
  });

  it('renders token usage with a clamped bar and readable counts', () => {
    expect(renderTokenUsageBar(250, 1000, { width: 10 })).toBe('[██░░░░░░░░] 25% (250/1,000 tokens)');
    expect(renderTokenUsageBar(1200, 1000, { width: 4 })).toContain('100%');
  });

  it('summarizes a diff and truncates only the displayed body', () => {
    const diff = '--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\n context';
    const rendered = renderDiffView(diff, { maxLines: 2 });
    expect(rendered).toContain('app.ts');
    expect(rendered).toContain('1 addition');
    expect(rendered).toContain('1 deletion');
    expect(rendered).toContain('… 1 diff line omitted …');
    expect(renderDiffView(diff)).toContain('+new');
  });

  it('asks only through injected IO and accepts explicit yes only', async () => {
    const prompts: string[] = [];
    const approved = await interactiveApprovalPrompt('Apply changes?', {
      ask: async prompt => { prompts.push(prompt); return ' YES '; },
    });
    expect(approved).toBe(true);
    expect(prompts).toEqual(['Apply changes? Type yes to approve: ']);

    expect(await interactiveApprovalPrompt('Apply?', { ask: async () => 'y' })).toBe(false);
    expect(await interactiveApprovalPrompt('Apply?', { ask: async () => false })).toBe(false);
    expect(await interactiveApprovalPrompt('Apply?', { ask: async () => true })).toBe(true);
  });

  it('renders a nested file tree with stable connector branches', () => {
    expect(renderTree({
      name: 'src',
      children: [
        { name: 'index.ts', type: 'file' },
        { name: 'utils', children: [{ name: 'text.ts', type: 'file' }] },
      ],
    })).toBe('src\n├── index.ts\n└── utils\n    └── text.ts');
  });

  it('renders a trajectory as an ordered status timeline', () => {
    expect(renderTrajectoryView([
      { action: 'Plan', description: 'Read the task', status: 'completed' },
      { action: 'Edit', description: 'Update the file', status: 'running' },
    ])).toBe('1. ✓ Plan — Read the task\n2. ◌ Edit — Update the file');
  });

  it('highlights recognized syntax and leaves unknown languages untouched', () => {
    const highlighted = syntaxHighlighter('const answer = true;', 'typescript');
    expect(highlighted).toContain('\u001b[36mconst\u001b[0m');
    expect(highlighted).toContain('\u001b[35mtrue\u001b[0m');
    expect(syntaxHighlighter('const x = 1;', 'unknown')).toBe('const x = 1;');
  });

  it('renders common Markdown structures as readable terminal text', () => {
    const rendered = renderMarkdownInTerminal('# Title\n\n**bold** and `code`\n\n- item');
    expect(rendered).toContain('Title');
    expect(rendered).toContain('bold and code');
    expect(rendered).toContain('• item');
    expect(rendered).not.toContain('**');
  });

  it('matches normalized keyboard shortcuts and returns mapped actions', () => {
    expect(keyboardShortcutHandler({ key: 'c', ctrl: true }, { 'Ctrl+C': 'quit' })).toBe('quit');
    expect(keyboardShortcutHandler('Escape', { 'Ctrl+C': 'quit' })).toBeUndefined();
    const invoked: string[] = [];
    keyboardShortcutHandler('Enter', { enter: () => { invoked.push('submit'); return 'done'; } });
    expect(invoked).toEqual(['submit']);
  });

  it('renders an error panel with a safe hint and message', () => {
    const panel = renderErrorPanel(new TypeError('Invalid path'), { hint: 'Check the workspace root' });
    expect(panel).toContain('TypeError');
    expect(panel).toContain('Invalid path');
    expect(panel).toContain('Check the workspace root');
  });

  it('updates status immutably and slices logs by an explicit viewport', () => {
    const status = { state: 'idle', count: 2 };
    const next = statusBarUpdater(status, { state: 'busy' });
    expect(next).toEqual({ state: 'busy', count: 2 });
    expect(status.state).toBe('idle');
    expect(scrollableLogPane(['a', 'b', 'c'], { offset: 1, height: 2 })).toEqual({
      lines: ['b', 'c'], offset: 1, total: 3, canScrollUp: true, canScrollDown: false,
    });
  });

  it('renders cost and plugin summaries from supplied data', () => {
    expect(renderCostDashboard({ totalCost: 1.25, budget: 2, byModel: { 'model-a': 1.25 } })).toMatch(/1\.25/);
    const plugins = renderPluginList([
      { name: 'zeta', enabled: false, version: '2.0' },
      { name: 'alpha', enabled: true },
    ]);
    expect(plugins.indexOf('alpha')).toBeLessThan(plugins.indexOf('zeta'));
    expect(plugins).toContain('enabled');
    expect(plugins).toContain('disabled');
  });

  it('confirms only explicit consent and loads isolated light/dark themes', async () => {
    expect(await confirmDialog('Delete files?', { ask: async () => 'yes' })).toBe(true);
    expect(await confirmDialog('Delete files?', { ask: async () => 'y' })).toBe(false);
    const dark = themeLoader('dark');
    const light = themeLoader('light');
    expect(dark.mode).toBe('dark');
    expect(dark.colors.background).not.toBe(light.colors.background);
    dark.colors.background = 'mutated';
    expect(themeLoader('dark').colors.background).not.toBe('mutated');
  });

  it('renders a deterministic spinner frame and only notifies through an injected callback', () => {
    expect(renderSpinner(1, { frames: ['.', 'o'], label: 'Loading' })).toBe('o Loading');
    const delivered: string[] = [];
    expect(notificationToast('Saved', { level: 'success' })).toBe('✓ Saved');
    expect(notificationToast('Saved', { level: 'success', onNotify: value => delivered.push(value) })).toBe('✓ Saved');
    expect(delivered).toEqual(['✓ Saved']);
  });

  it('renders aligned tabular results and customizable quick help', () => {
    const table = renderTable([{ name: 'Ada', active: true }, { name: 'Lin', active: false }], {
      columns: ['name', 'active'],
    });
    expect(table).toContain('name');
    expect(table).toContain('Ada');
    expect(table).toContain('false');
    expect(renderQuickHelp([{ key: 'Ctrl+C', description: 'Exit' }])).toContain('Ctrl+C  Exit');
  });
});
