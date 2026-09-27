/**
 * MCP server manager: reads `.agent/mcp.json`, keeps the stdio clients alive and
 * turns each server's tools into ordinary registry tools.
 *
 * Tool names are namespaced `mcp__<server>__<tool>` so a server can never
 * shadow a built-in tool, and the prefix tells the model (and the user) where
 * the capability came from.
 */

import fs from 'fs';
import path from 'path';
import { JSONSchema, Tool, ToolContext, ToolResult } from '../types/index.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { McpClient, McpError, McpToolDefinition } from './McpClient.js';
import { McpServerConfig, McpServerInfo } from './types.js';

export const MCP_CONFIG_FILE = 'mcp.json';
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConfigError';
  }
}

/** Accept both `{ servers: {...} }` and Claude Desktop's `{ mcpServers: {...} }`. */
export function parseMcpConfig(raw: unknown): McpServerConfig[] {
  const body = (raw ?? {}) as Record<string, unknown>;
  const table = (body.servers ?? body.mcpServers ?? {}) as Record<string, unknown>;
  if (typeof table !== 'object' || table === null || Array.isArray(table)) {
    throw new McpConfigError('mcp.json must map server names to { command, args }');
  }
  const servers: McpServerConfig[] = [];
  for (const [name, value] of Object.entries(table)) {
    if (!NAME_RE.test(name)) throw new McpConfigError(`Invalid MCP server name '${name}'`);
    const entry = (value ?? {}) as Record<string, unknown>;
    if (typeof entry.command !== 'string' || !entry.command.trim()) {
      throw new McpConfigError(`MCP server '${name}' needs a command`);
    }
    const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    const env = typeof entry.env === 'object' && entry.env !== null
      ? Object.fromEntries(Object.entries(entry.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : undefined;
    servers.push({
      name,
      command: entry.command.trim(),
      args,
      env,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
      enabled: entry.enabled !== false,
    });
  }
  return servers;
}

/** `mcp__files__read` -> { server: 'files', tool: 'read' } (server names may contain dashes). */
export function splitMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const index = rest.indexOf('__');
  if (index <= 0) return null;
  return { server: rest.slice(0, index), tool: rest.slice(index + 2) };
}

/** One MCP tool, presented to the agent as a normal registry tool. */
export class McpTool implements Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;

  constructor(
    private readonly server: string,
    private readonly client: McpClient,
    definition: McpToolDefinition,
  ) {
    this.name = `mcp__${server}__${definition.name}`;
    this.description = `${definition.description || definition.name} (MCP server '${server}')`;
    const schema = definition.inputSchema as JSONSchema | undefined;
    this.inputSchema = schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} };
  }

  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const args = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const { tool } = splitMcpToolName(this.name) ?? { tool: this.name };
    try {
      const { text, isError } = await this.client.callTool(tool, args);
      return isError ? { success: false, error: text } : { success: true, output: text };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }
}

interface LiveServer {
  config: McpServerConfig;
  client: McpClient;
  tools: McpToolDefinition[];
}

export class McpManager {
  private servers = new Map<string, LiveServer>();
  private failures = new Map<string, string>();
  private connecting: Promise<void> | null = null;

  constructor(private readonly configPath: string) {}

  get file(): string {
    return this.configPath;
  }

  /** Configured servers, including ones that failed to start. */
  readConfig(): McpServerConfig[] {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new McpConfigError(`Could not read ${this.configPath}: ${(error as Error).message}`);
    }
    return parseMcpConfig(raw);
  }

  writeConfig(servers: McpServerConfig[]): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    const table: Record<string, unknown> = {};
    for (const server of servers) {
      table[server.name] = {
        command: server.command,
        args: server.args,
        ...(server.env ? { env: server.env } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
        enabled: server.enabled,
      };
    }
    fs.writeFileSync(this.configPath, `${JSON.stringify({ servers: table }, null, 2)}\n`, 'utf8');
  }

  /** Add or replace a server, then connect it. */
  async addServer(config: McpServerConfig, registry?: ToolRegistry): Promise<McpServerInfo> {
    if (!NAME_RE.test(config.name)) throw new McpConfigError(`Invalid MCP server name '${config.name}'`);
    if (!config.command.trim()) throw new McpConfigError('A command is required');
    const existing = this.readConfig().filter((s) => s.name !== config.name);
    this.writeConfig([...existing, { ...config, command: config.command.trim() }]);
    await this.reload(config.name, registry);
    return this.status().find((s) => s.name === config.name) as McpServerInfo;
  }

  async removeServer(name: string, registry?: ToolRegistry): Promise<void> {
    const remaining = this.readConfig().filter((s) => s.name !== name);
    if (remaining.length === this.readConfig().length) throw new McpConfigError(`MCP server '${name}' is not configured`);
    this.writeConfig(remaining);
    this.disconnect(name, registry);
  }

  /** Drop a server's tools from the registry and stop its process. */
  disconnect(name: string, registry?: ToolRegistry): void {
    const live = this.servers.get(name);
    if (!live) return;
    for (const tool of live.tools) registry?.unregister(`mcp__${name}__${tool.name}`);
    live.client.close();
    this.servers.delete(name);
    this.failures.delete(name);
  }

  /** Stop everything (used on settings change and by tests). */
  disconnectAll(registry?: ToolRegistry): void {
    for (const name of Array.from(this.servers.keys())) this.disconnect(name, registry);
  }

  /** Connect every enabled server, or just `only`. Failures are recorded, not thrown. */
  async reload(only?: string, registry?: ToolRegistry): Promise<void> {
    let configs: McpServerConfig[];
    try {
      configs = this.readConfig();
    } catch (error) {
      if (only) throw error;
      return; // a malformed file must not take the whole server down
    }
    const targets = only ? configs.filter((c) => c.name === only) : configs;
    if (only && targets.length === 0) throw new McpConfigError(`MCP server '${only}' is not configured`);

    for (const config of targets) this.disconnect(config.name, registry);

    const connect = async (config: McpServerConfig): Promise<void> => {
      if (!config.enabled) {
        this.failures.delete(config.name);
        return;
      }
      const client = new McpClient(config);
      try {
        await client.start();
        const tools = await client.listTools();
        for (const definition of tools) {
          const tool = new McpTool(config.name, client, definition);
          if (registry && !registry.has(tool.name)) registry.register(tool);
        }
        this.servers.set(config.name, { config, client, tools });
        this.failures.delete(config.name);
      } catch (error) {
        client.close();
        this.failures.set(config.name, error instanceof McpError ? error.message : (error as Error).message);
      }
    };

    await Promise.all(targets.map(connect));
  }

  /** Connect on boot without blocking the HTTP listener. */
  connectAll(registry?: ToolRegistry): Promise<void> {
    if (!this.connecting) {
      this.connecting = this.reload(undefined, registry).finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  /** Resolve once any in-flight boot connection has settled (used by tests). */
  async ready(): Promise<void> {
    await this.connecting;
  }

  /** Everything configured, annotated with live status. */
  status(): McpServerInfo[] {
    let configs: McpServerConfig[];
    try {
      configs = this.readConfig();
    } catch {
      configs = Array.from(this.servers.values()).map((s) => s.config);
    }
    return configs.map((config) => {
      const live = this.servers.get(config.name);
      const error = this.failures.get(config.name);
      return {
        ...config,
        status: live ? 'connected' : !config.enabled ? 'disabled' : error ? 'error' : 'stopped',
        tools: live ? live.tools.map((t) => t.name) : [],
        ...(error ? { error } : {}),
      };
    });
  }

  /** Names currently registered for a server (used when tearing it down). */
  toolNames(server: string): string[] {
    return (this.servers.get(server)?.tools ?? []).map((t) => `mcp__${server}__${t.name}`);
  }
}
