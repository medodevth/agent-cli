/**
 * Minimal MCP client over stdio.
 *
 * Speaks the Model Context Protocol's stdio transport: newline-delimited
 * JSON-RPC 2.0 on the child's stdin/stdout. Only what the agent needs is
 * implemented — initialize, tools/list, tools/call — so an installed MCP server
 * shows up as ordinary tools in the registry.
 *
 * Docs: https://modelcontextprotocol.io/specification
 */

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { McpServerConfig } from './types.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 20_000;
const INIT_TIMEOUT_MS = 20_000;

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
}

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpError';
  }
}

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stderr = '';
  private exited = false;
  private exitInfo: { code: number | null; signal: string | null } | null = null;

  constructor(private readonly config: McpServerConfig) {}

  get name(): string {
    return this.config.name;
  }

  get running(): boolean {
    return this.child !== null && !this.exited;
  }

  /** Spawn the server and complete the initialize handshake. */
  async start(): Promise<void> {
    if (this.running) return;
    this.exited = false;
    this.exitInfo = null;
    this.stderr = '';

    const env = { ...process.env, ...(this.config.env ?? {}) };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.config.command, this.config.args, {
        cwd: this.config.cwd || process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new McpError(`Could not start '${this.config.command}': ${(error as Error).message}`);
    }
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Keep the tail only: MCP servers are chatty on stderr and this is for
      // diagnosing a failure, not for logging their normal output.
      this.stderr = (this.stderr + chunk).slice(-2000);
    });
    child.on('error', (error: Error) => this.failAll(new McpError(`MCP server '${this.config.name}' failed: ${error.message}`)));
    child.on('exit', (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      this.failAll(new McpError(this.exitMessage()));
    });

    try {
      await this.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'agent-cli', version: '0.2.0' },
      }, INIT_TIMEOUT_MS);
      this.notify('notifications/initialized', {});
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private exitMessage(): string {
    const info = this.exitInfo;
    const detail = info
      ? `exited (code ${info.code ?? 'null'}${info.signal ? `, signal ${info.signal}` : ''})`
      : 'closed';
    const tail = this.stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
    return `MCP server '${this.config.name}' ${detail}${tail ? `: ${tail}` : ''}`;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = (await this.request('tools/list', {})) as { tools?: McpToolDefinition[] } | undefined;
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  /** Call a tool and flatten MCP content blocks into one text result. */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const result = (await this.request('tools/call', { name, arguments: args })) as
      | { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
      | undefined;
    const parts = (result?.content ?? [])
      .map((block) => (typeof block?.text === 'string' ? block.text : block?.type ? `[${block.type}]` : ''))
      .filter(Boolean);
    return { text: parts.join('\n') || '(no output)', isError: result?.isError === true };
  }

  close(): void {
    this.failAll(new McpError(`MCP server '${this.config.name}' closed`));
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handleLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // not a JSON-RPC frame (some servers print banners)
    }
    if (typeof message.id !== 'number') return; // a notification or server request
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new McpError(`MCP error ${message.error.code}: ${message.error.message}`));
    else entry.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const child = this.child;
    if (!child || this.exited) return Promise.reject(new McpError(this.exitMessage()));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`MCP server '${this.config.name}' did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new McpError(`Could not write to MCP server '${this.config.name}': ${error.message}`));
      });
    });
  }

  private notify(method: string, params: unknown): void {
    try {
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {
      /* the server is gone; the next request reports it */
    }
  }
}
