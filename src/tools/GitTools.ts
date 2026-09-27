import { execFile } from 'child_process';
import { promisify } from 'util';
import { Tool, ToolContext, ToolResult } from '../types/index.js';

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 10 * 1024 * 1024;

/** Input shapes of the git tools (mirror each tool's inputSchema). */
interface GitDiffInput { staged?: boolean; file?: string }
interface GitLogInput { limit?: number; file?: string }

export class GitStatusTool implements Tool {
  name = 'git_status';
  description =
    'Get the current git status of the workspace. Shows modified, added, deleted, and untracked files.';

  inputSchema = {
    type: 'object',
    properties: {},
  };

  async execute(_input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: context.workspaceRoot,
        maxBuffer: MAX_BUFFER,
      });

      if (!stdout.trim()) {
        return { success: true, output: 'Working tree is clean.' };
      }

      return { success: true, output: stdout };
    } catch {
      return {
        success: false,
        error: 'Not a git repository or git is not installed.',
      };
    }
  }
}

export class GitDiffTool implements Tool {
  name = 'git_diff';
  description =
    'Show git diff of changes in the workspace. Use this to see what has been modified before committing.';

  inputSchema = {
    type: 'object',
    properties: {
      staged: {
        type: 'boolean',
        description: 'Show staged changes only (default: false)',
      },
      file: {
        type: 'string',
        description: 'Specific file to show diff for (optional)',
      },
    },
  };

  async execute(input: GitDiffInput, context: ToolContext): Promise<ToolResult> {
    try {
      const args = ['diff'];
      if (input.staged) {
        args.push('--staged');
      }
      if (input.file) {
        args.push('--', String(input.file));
      }

      const { stdout } = await execFileAsync('git', args, {
        cwd: context.workspaceRoot,
        maxBuffer: MAX_BUFFER,
      });

      if (!stdout.trim()) {
        return { success: true, output: 'No changes.' };
      }

      return { success: true, output: truncateLines(stdout, 1000) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export class GitLogTool implements Tool {
  name = 'git_log';
  description =
    'Show recent git commit history. Useful for understanding recent changes and project history.';

  inputSchema = {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Number of commits to show (default: 10)',
      },
      file: {
        type: 'string',
        description: 'Show log for specific file (optional)',
      },
    },
  };

  async execute(input: GitLogInput, context: ToolContext): Promise<ToolResult> {
    try {
      const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 100);
      const args = ['log', '--oneline', '-n', String(limit)];

      if (input.file) {
        args.push('--', String(input.file));
      }

      const { stdout } = await execFileAsync('git', args, {
        cwd: context.workspaceRoot,
        maxBuffer: MAX_BUFFER,
      });

      if (!stdout.trim()) {
        return { success: true, output: 'No commits found.' };
      }

      return { success: true, output: stdout };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) {
    return text;
  }
  return (
    lines.slice(0, maxLines).join('\n') +
    `\n\n[... truncated ${lines.length - maxLines} lines ...]`
  );
}
