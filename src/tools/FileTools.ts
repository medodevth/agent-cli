import * as fs from 'fs/promises';
import * as nodeFs from 'fs';
import * as path from 'path';
import { Tool, ToolContext, ToolResult, ToolError, WorkspaceError } from '../types/index.js';
import { BackupManager } from '../security/BackupManager.js';
import { ProtectedPaths } from '../security/ProtectedPaths.js';

/** Session-wide backup store used by write_file/edit_file (undo support).
 *  One instance per process is safe: paths are absolute keys. */
export const sessionBackups = new BackupManager();

/** Max distinct files one task may touch. Session-scoped. */
export const taskEditGuard = {
  maxFilesPerTask: 25,
  currentTask: '',
  /** Throws-free check: returns an error string when the cap is exceeded. */
  registerAndCheck(workspaceRoot: string, absolutePath: string): string | null {
    if (!this.currentTask) return null;
    const files = sessionBackups.filesChangedInTask(this.currentTask);
    const alreadyTouched = sessionBackups.trackedPaths.includes(absolutePath);
    if (!alreadyTouched && files >= this.maxFilesPerTask) {
      return `Task '${this.currentTask}' has already modified ${files} files (max ${this.maxFilesPerTask}). Split the work into smaller tasks.`;
    }
    sessionBackups.beforeWrite(workspaceRoot, absolutePath, this.currentTask).catch(() => undefined);
    return null;
  },
};

/** Input shapes of the file tools (mirror each tool's inputSchema). */
interface ListFilesInput { path?: string; recursive?: boolean; maxDepth?: number; excludePatterns?: string[] }
interface ReadFileInput { path: string; startLine?: number; endLine?: number }
interface WriteFileInput { path: string; content: string }
interface EditFileInput { path: string; oldText: string; newText: string; replaceAll?: boolean }

/** Shared workspace-path sanitizer for all file tools.
 *  Exported so sibling tool modules reuse the same rules. */
export class PathValidator {
  private static readonly DANGEROUS_PATTERNS = [
    /\.\./,
    /\0/,
    /%2e%2e/i,
    /%252e/i,
    /%5c/i,
    /\/{2,}/,
  ];

  static sanitizePath(userPath: string): string {
    if (!userPath || typeof userPath !== 'string') {
      throw new WorkspaceError('Invalid path: path must be a non-empty string');
    }

    let decoded = userPath;
    try {
      for (let i = 0; i < 3; i++) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
    } catch {
      throw new WorkspaceError('Invalid path: contains malformed URL encoding');
    }

    for (const pattern of PathValidator.DANGEROUS_PATTERNS) {
      if (pattern.test(decoded)) {
        throw new WorkspaceError(`Invalid path: contains dangerous pattern ${pattern.source}`);
      }
    }

    // eslint-disable-next-line no-control-regex
    const sanitized = decoded.replace(/[\x00-\x1f\x7f]/g, '');
    if (sanitized !== decoded) {
      throw new WorkspaceError('Invalid path: contains control characters');
    }

    return sanitized;
  }

  static async validateWorkspaceBoundary(
    targetPath: string,
    workspaceRoot: string
  ): Promise<string> {
    const absoluteWorkspace = path.resolve(workspaceRoot);
    const absoluteTarget = path.resolve(absoluteWorkspace, targetPath);

    let canonicalWorkspace: string;
    try {
      canonicalWorkspace = await fs.realpath(absoluteWorkspace);
    } catch (error) {
      throw new WorkspaceError(`Workspace root is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }

    let canonicalTarget: string;
    try {
      let pathToCheck = absoluteTarget;
      let relativeSuffix = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const exists = await fs
          .access(pathToCheck)
          .then(() => true)
          .catch(() => false);

        if (exists) {
          const canonical = await fs.realpath(pathToCheck);
          canonicalTarget = relativeSuffix
            ? path.join(canonical, relativeSuffix)
            : canonical;
          break;
        }

        const parent = path.dirname(pathToCheck);
        if (parent === pathToCheck) {
          throw new WorkspaceError('Cannot validate path: no parent directory exists');
        }

        const basename = path.basename(pathToCheck);
        relativeSuffix = relativeSuffix ? path.join(basename, relativeSuffix) : basename;
        pathToCheck = parent;
      }
    } catch (error) {
      if (error instanceof WorkspaceError) {
        throw error;
      }
      throw new WorkspaceError(`Cannot canonicalize path: ${error instanceof Error ? error.message : String(error)}`);
    }

    const normalizedWorkspace = path.normalize(canonicalWorkspace + path.sep);
    const normalizedTarget = path.normalize(canonicalTarget + path.sep);

    if (!normalizedTarget.startsWith(normalizedWorkspace)) {
      throw new WorkspaceError('Path is outside workspace boundary');
    }

    const relativePath = path.relative(canonicalWorkspace, canonicalTarget);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new WorkspaceError('Path traversal detected');
    }

    return canonicalTarget;
  }

  static async validatePath(userPath: string, workspaceRoot: string): Promise<string> {
    const sanitized = PathValidator.sanitizePath(userPath);
    return PathValidator.validateWorkspaceBoundary(sanitized, workspaceRoot);
  }
}

/** Compact before/after summary used as the write_file diff preview. */
export function buildDiffSummary(before: string, after: string): string {
  if (before === after) return '';
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const added = afterLines.filter(l => !beforeLines.includes(l)).length;
  const removed = beforeLines.filter(l => !afterLines.includes(l)).length;
  const firstChange = afterLines.findIndex((l, i) => beforeLines[i] !== l);
  const parts = [`diff: +${added} -${removed} lines`];
  if (firstChange >= 0) parts.push(`first change at L${firstChange + 1}`);
  return parts.join(', ');
}

async function assertInsideWorkspace(validatedPath: string, workspaceRoot: string): Promise<void> {
  const root = await fs.realpath(path.resolve(workspaceRoot));
  const normalizedRoot = path.normalize(root + path.sep);
  const normalizedTarget = path.normalize(validatedPath + path.sep);

  if (!normalizedTarget.startsWith(normalizedRoot)) {
    throw new WorkspaceError('Path is outside workspace boundary');
  }
}

export class ListFilesTool implements Tool {
  name = 'list_files';
  description =
    'List files and directories in the workspace. Use this to explore the project structure and find relevant files. Supports recursive listing with depth control and exclude patterns.';

  inputSchema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path from workspace root (default: ".")',
      },
      recursive: {
        type: 'boolean',
        description: 'List files recursively (default: true)',
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum depth for recursive listing (default: 10)',
      },
      excludePatterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Patterns to exclude (e.g., "node_modules", ".git")',
      },
    },
  };

  async execute(input: ListFilesInput, context: ToolContext): Promise<ToolResult> {
    try {
      const targetPath = input.path || '.';
      const recursive = input.recursive ?? true;
      const maxDepth = Math.min(Math.max(Number(input.maxDepth) || 10, 1), 50);
      const excludePatterns: string[] = input.excludePatterns || [
        'node_modules', '.git', 'dist', 'build', 'coverage', '.cache', '.tmp', '.DS_Store',
      ];

      const validatedPath = await PathValidator.validatePath(targetPath, context.workspaceRoot);

      try {
        await fs.access(validatedPath);
      } catch {
        throw new ToolError(`Path does not exist: ${targetPath}`);
      }

      const files = await this.listDirectory(
        validatedPath,
        context.workspaceRoot,
        recursive,
        maxDepth,
        excludePatterns,
        0
      );

      return {
        success: true,
        output: files.join('\n') || '(empty directory)',
        metadata: { count: files.length },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async listDirectory(
    dirPath: string,
    workspaceRoot: string,
    recursive: boolean,
    maxDepth: number,
    excludePatterns: string[],
    currentDepth: number
  ): Promise<string[]> {
    if (currentDepth > maxDepth) {
      return [];
    }

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
      const relativePath = path.relative(workspaceRoot, path.join(dirPath, entry.name));

      if (excludePatterns.some(pattern => relativePath.includes(pattern) || entry.name === pattern)) {
        continue;
      }

      if (entry.isDirectory()) {
        results.push(relativePath + '/');
        if (recursive) {
          const subFiles = await this.listDirectory(
            path.join(dirPath, entry.name),
            workspaceRoot,
            recursive,
            maxDepth,
            excludePatterns,
            currentDepth + 1
          );
          results.push(...subFiles);
        }
      } else {
        results.push(relativePath);
      }
    }

    return results.sort();
  }
}

export class ReadFileTool implements Tool {
  name = 'read_file';
  description =
    'Read text content from a file inside the current workspace. Use when you need to inspect source code, configuration, or documentation. Supports reading specific line ranges to avoid loading large files entirely.';

  inputSchema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path to the file from workspace root',
      },
      startLine: {
        type: 'number',
        description: 'Starting line number (1-indexed, optional)',
      },
      endLine: {
        type: 'number',
        description: 'Ending line number (inclusive, optional)',
      },
    },
    required: ['path'],
  };

  async execute(input: ReadFileInput, context: ToolContext): Promise<ToolResult> {
    try {
      const validatedPath = await PathValidator.validatePath(input.path, context.workspaceRoot);

      const stat = await fs.stat(validatedPath);
      if (!stat.isFile()) {
        throw new ToolError('Path is not a file');
      }

      if (await this.isBinaryFile(validatedPath)) {
        return {
          success: false,
          error: 'Cannot read binary file. Use appropriate tools for binary content.',
        };
      }

      const maxSize = 100000;
      let content: string;
      let totalLines: number;
      if (input.startLine !== undefined || input.endLine !== undefined) {
        const start = Math.max((Number(input.startLine) || 1) - 1, 0);
        const end = Math.max(Number(input.endLine) || start + 500, start + 1);
        if (end - start > 5000) throw new ToolError('Line range cannot exceed 5000 lines');
        const stream = nodeFs.createReadStream(validatedPath, { encoding: 'utf-8' });
        let lineNumber = 0;
        const selected: string[] = [];
        let selectedSize = 0;
        let pending = '';
        for await (const chunk of stream) {
          pending += chunk;
          const lines = pending.split('\n');
          pending = lines.pop() || '';
          for (const line of lines) {
            if (lineNumber >= start && lineNumber < end && selectedSize < maxSize) {
              selected.push(line);
              selectedSize += line.length + 1;
            }
            lineNumber++;
          }
        }
        if (pending) {
          if (lineNumber >= start && lineNumber < end && selectedSize < maxSize) selected.push(pending);
          lineNumber++;
        }
        content = selected.join('\n');
        totalLines = lineNumber;
      } else {
        content = await fs.readFile(validatedPath, 'utf-8');
        totalLines = content.split('\n').length;
      }

      if (content.length > maxSize) {
        content = content.substring(0, maxSize) + '\n\n[... truncated ...]';
      }

      return {
        success: true,
        output: content,
        metadata: {
          path: input.path,
          size: content.length,
          totalLines,
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { success: false, error: 'File does not exist' };
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async isBinaryFile(filePath: string): Promise<boolean> {
    const buffer = Buffer.alloc(512);
    const fd = await fs.open(filePath, 'r');
    try {
      await fd.read(buffer, 0, 512, 0);
      for (const byte of buffer) {
        if (byte === 0) {
          return true;
        }
      }
      return false;
    } finally {
      await fd.close();
    }
  }
}

export class WriteFileTool implements Tool {
  name = 'write_file';
  description =
    'Create a new file or overwrite an existing file with new content. Use when you need to create new files or completely replace file contents. For partial modifications, use edit_file instead.';

  inputSchema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path to the file from workspace root',
      },
      content: {
        type: 'string',
        description: 'Full content to write to the file',
      },
    },
    required: ['path', 'content'],
  };

  async execute(input: WriteFileInput, context: ToolContext): Promise<ToolResult> {
    try {      const validatedPath = await PathValidator.validatePath(input.path, context.workspaceRoot);
      await assertInsideWorkspace(validatedPath, context.workspaceRoot);

      // System/config paths require special (critical) approval.
      const protectedReason = ProtectedPaths.check(input.path);

      const permissionResult = await context.permissions.check({
        type: 'write_file',
        description: `Write file: ${input.path}${protectedReason ? ` [PROTECTED: ${protectedReason}]` : ''}`,
        target: input.path,
        risk: ProtectedPaths.riskFor(input.path),
      });

      if (permissionResult.allowed === false) {
        return {
          success: false,
          error: `Permission denied: ${permissionResult.reason}`,
        };
      }

      // Per-task file-count cap (mass destructive edit guard).
      const capError = taskEditGuard.registerAndCheck(context.workspaceRoot, validatedPath);
      if (capError) return { success: false, error: capError };

      await fs.mkdir(path.dirname(validatedPath), { recursive: true });
      let previousContent = '';
      try {
        previousContent = await fs.readFile(validatedPath, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      // Diff preview of the overwrite in metadata.
      const unifiedDiff = buildDiffSummary(previousContent, String(input.content));
      await fs.writeFile(validatedPath, input.content, 'utf-8');
      const oldLines = previousContent ? previousContent.split('\n').length : 0;
      const newLines = String(input.content).split('\n').length;

      return {
        success: true,
        output: `File written successfully: ${input.path}` + (unifiedDiff ? `\n${unifiedDiff}` : ''),
        metadata: {
          path: input.path,
          size: input.content.length,
          addedLines: Math.max(0, newLines - oldLines),
          removedLines: Math.max(0, oldLines - newLines),
          startLine: 1,
          protected: protectedReason ?? undefined,
          diff: unifiedDiff || undefined,
          undoable: true,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export class EditFileTool implements Tool {
  name = 'edit_file';
  description =
    'Edit specific parts of a file by replacing old content with new content. You must provide the exact old text to be replaced - this ensures accuracy. If the old text does not match exactly, the operation will fail to prevent incorrect edits.';

  inputSchema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path to the file from workspace root',
      },
      oldText: {
        type: 'string',
        description: 'Exact text to replace (must match exactly)',
      },
      newText: {
        type: 'string',
        description: 'New text to insert in place of old text',
      },
      replaceAll: {
        type: 'boolean',
        description: 'Replace all occurrences (default: false, requires unique match)',
      },
    },
    required: ['path', 'oldText', 'newText'],
  };

  async execute(input: EditFileInput, context: ToolContext): Promise<ToolResult> {
    try {
      const validatedPath = await PathValidator.validatePath(input.path, context.workspaceRoot);

      // System/config paths require special (critical) approval.
      const protectedReason = ProtectedPaths.check(input.path);

      const permissionResult = await context.permissions.check({
        type: 'write_file',
        description: `Edit file: ${input.path}${protectedReason ? ` [PROTECTED: ${protectedReason}]` : ''}`,
        target: input.path,
        risk: ProtectedPaths.riskFor(input.path),
      });

      if (permissionResult.allowed === false) {
        return {
          success: false,
          error: `Permission denied: ${permissionResult.reason}`,
        };
      }

      let stat;
      try {
        stat = await fs.stat(validatedPath);
      } catch {
        throw new ToolError('File does not exist');
      }

      if (!stat.isFile()) {
        throw new ToolError('Path is not a file');
      }

      // Per-task file-count cap.
      const capError = taskEditGuard.registerAndCheck(context.workspaceRoot, validatedPath);
      if (capError) return { success: false, error: capError };

      const content = await fs.readFile(validatedPath, 'utf-8');
      const occurrences = content.split(input.oldText).length - 1;

      if (occurrences === 0) {
        return {
          success: false,
          error: 'Old text not found in file. Cannot edit.',
        };
      }

      if (occurrences > 1 && !input.replaceAll) {
        return {
          success: false,
          error: `Old text appears ${occurrences} times. Use replaceAll: true or provide more specific text.`,
        };
      }

      const newContent = input.replaceAll
        ? content.split(input.oldText).join(input.newText)
        : content.replace(input.oldText, input.newText);

      await fs.writeFile(validatedPath, newContent, 'utf-8');
      const beforeLines = content.split('\n');
      const afterLines = newContent.split('\n');
      let firstChangedLine = 0;
      while (firstChangedLine < beforeLines.length && firstChangedLine < afterLines.length && beforeLines[firstChangedLine] === afterLines[firstChangedLine]) {
        firstChangedLine++;
      }
      const lineDelta = afterLines.length - beforeLines.length;

      return {
        success: true,
        output: `File edited successfully: ${input.path} (${occurrences} replacement${occurrences > 1 ? 's' : ''})`,
        metadata: {
          path: input.path,
          replacements: occurrences,
          startLine: firstChangedLine + 1,
          addedLines: Math.max(0, lineDelta),
          removedLines: Math.max(0, -lineDelta),
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
