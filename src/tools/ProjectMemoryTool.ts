import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool, ToolContext, ToolResult } from '../types/index.js';

const MEMORY_FILES = {
  session: '.agent/memory/session.md',
  project: '.agent/memory/project.md',
  global: '.agent/memory/global.md',
} as const;
type MemoryLayer = keyof typeof MEMORY_FILES;
const SECRET_PATTERN = /(api[_-]?key|access[_-]?token|secret|password|private[_-]?key)\s*[:=]/i;

export class ProjectMemoryTool implements Tool {
  name = 'project_memory';
  description =
    'Read or update non-secret memory in three layers: session (temporary task context), project (workspace architecture and conventions), and global (user-wide preferences). Defaults to project. Never store credentials or tokens.';

  inputSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'append', 'replace', 'note'], description: "read/append/replace a layer, or 'note' to record a structured note" },
      layer: { type: 'string', enum: ['session', 'project', 'global'], description: 'Memory scope (default: project)' },
      noteKind: { type: 'string', enum: ['project', 'user'], description: "For action='note': project understanding or user preference" },
      content: { type: 'string', description: 'Memory content for append/replace/note' },
    },
    required: ['action'],
  };

  /** Optional structured-note sink wired by the Agent (NoteSystem). */
  noteSink?: { note(kind: 'project' | 'user', content: string): boolean };

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const value = input as { action?: string; content?: string; layer?: MemoryLayer; noteKind?: 'project' | 'user' };

    if (value.action === 'note') {
      if (!this.noteSink) return { success: false, error: 'note action unavailable in this context' };
      if (!value.content?.trim()) return { success: false, error: 'content is required for note' };
      const kind = value.noteKind === 'user' ? 'user' : 'project';
      const ok = this.noteSink.note(kind, value.content);
      if (!ok) return { success: false, error: 'note rejected: empty, too long, or secret-like content' };
      return { success: true, output: `${kind} note recorded (written at end of run)` };
    }

    const layer: MemoryLayer = value.layer || 'project';
    if (!(layer in MEMORY_FILES)) return { success: false, error: 'layer must be session, project, or global' };
    const memoryPath = layer === 'global'
      ? path.join(process.env.HOME || process.env.USERPROFILE || '/root', '.agent', 'memory', 'global.md')
      : path.join(context.workspaceRoot, MEMORY_FILES[layer]);
    const memoryLabel = layer === 'global' ? '~/.agent/memory/global.md' : MEMORY_FILES[layer];

    try {
      if (value.action === 'read') {
        const content = await fs.readFile(memoryPath, 'utf-8');
        return { success: true, output: content || `(${layer} memory is empty)` };
      }

      if (value.action !== 'append' && value.action !== 'replace') {
        return { success: false, error: 'action must be read, append, or replace' };
      }
      if (typeof value.content !== 'string' || value.content.trim().length === 0) {
        return { success: false, error: 'content is required for append or replace' };
      }
      if (SECRET_PATTERN.test(value.content)) {
      return { success: false, error: 'Memory cannot contain credentials or secret-like values' };
      }

    const permission = context.permissions.check({
        type: 'write_file',
        description: `${value.action} ${layer} memory`,
        target: memoryPath,
        risk: 'low',
      });
      if (!permission.allowed) {
        const reason = 'reason' in permission ? permission.reason : 'write was not allowed';
        return { success: false, error: `Permission denied: ${reason}` };
      }

      await fs.mkdir(path.dirname(memoryPath), { recursive: true });
      if (value.action === 'replace') {
        await fs.writeFile(memoryPath, value.content.trim() + '\n', 'utf-8');
      } else {
        await fs.appendFile(memoryPath, `\n${value.content.trim()}\n`, 'utf-8');
      }
      return { success: true, output: `${layer} memory updated: ${memoryLabel}` };
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (value.action === 'read' && errno.code === 'ENOENT') {
        return { success: true, output: `(no ${layer} memory yet)` };
      }
      return { success: false, error: errno.message };
    }
  }
}
