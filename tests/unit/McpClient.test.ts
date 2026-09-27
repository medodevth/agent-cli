import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { McpClient } from '../../src/extensions/McpClient.js';
import { McpManager } from '../../src/extensions/McpManager.js';
import { ToolRegistry } from '../../src/tools/ToolRegistry.js';
import type { ToolContext } from '../../src/types/index.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/fake-mcp-server.mjs', import.meta.url));

const context = { workspaceRoot: process.cwd() } as unknown as ToolContext;

describe('mcp client over stdio', () => {
  let client: McpClient;

  beforeEach(async () => {
    client = new McpClient({ name: 'fake', command: process.execPath, args: [FIXTURE], enabled: true });
    await client.start();
  });
  afterEach(() => client.close());

  it('completes the handshake and lists tools, ignoring non-JSON noise', async () => {
    const tools = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'fail']);
    expect(tools[0].inputSchema).toBeDefined();
  });

  it('calls a tool and flattens its content blocks', async () => {
    await expect(client.callTool('echo', { text: 'hi' })).resolves.toEqual({ text: 'echo:hi', isError: false });
    await expect(client.callTool('fail', {})).resolves.toEqual({ text: 'tool exploded', isError: true });
  });

  it('surfaces a JSON-RPC error from the server', async () => {
    await expect(client.callTool('nope', {})).rejects.toThrow(/unknown tool nope/);
  });

  it('reports a closed server rather than hanging', async () => {
    client.close();
    await expect(client.listTools()).rejects.toThrow(/closed|exited/);
  });

  it('fails fast when the command does not exist', async () => {
    const broken = new McpClient({ name: 'missing', command: 'definitely-not-a-real-binary-xyz', args: [], enabled: true });
    await expect(broken.start()).rejects.toThrow(/missing/);
    broken.close();
  });
});

describe('mcp manager', () => {
  let dir: string;
  let manager: McpManager;
  let registry: ToolRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-manager-'));
    manager = new McpManager(join(dir, 'mcp.json'));
    registry = new ToolRegistry();
  });
  afterEach(() => {
    manager.disconnectAll(registry);
    rmSync(dir, { recursive: true, force: true });
  });

  it('connects a configured server and registers its tools namespaced', async () => {
    await manager.addServer({ name: 'fake', command: process.execPath, args: [FIXTURE], enabled: true }, registry);
    const status = manager.status();
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ name: 'fake', status: 'connected' });
    expect(status[0].tools.sort()).toEqual(['echo', 'fail']);
    expect(registry.list().map((t) => t.name).sort()).toEqual(['mcp__fake__echo', 'mcp__fake__fail']);
  });

  it('runs a registered MCP tool through the registry and returns its text', async () => {
    await manager.addServer({ name: 'fake', command: process.execPath, args: [FIXTURE], enabled: true }, registry);
    const tool = registry.get('mcp__fake__echo');
    expect(tool).toBeDefined();
    await expect(tool!.execute({ text: 'hello' }, context)).resolves.toEqual({ success: true, output: 'echo:hello' });
    // An isError result becomes a failed tool result, not a thrown exception.
    await expect(registry.get('mcp__fake__fail')!.execute({}, context)).resolves.toEqual({ success: false, error: 'tool exploded' });
  });

  it('records a failed start without throwing and keeps serving the rest', async () => {
    await manager.addServer({ name: 'good', command: process.execPath, args: [FIXTURE], enabled: true }, registry);
    await manager.addServer({ name: 'bad', command: 'definitely-not-a-real-binary-xyz', args: [], enabled: true }, registry);
    const status = manager.status();
    expect(status.find((s) => s.name === 'good')?.status).toBe('connected');
    const bad = status.find((s) => s.name === 'bad');
    expect(bad?.status).toBe('error');
    expect(bad?.error).toMatch(/bad/);
    expect(registry.has('mcp__good__echo')).toBe(true);
  });

  it('unregisters a server\'s tools when it is removed', async () => {
    await manager.addServer({ name: 'fake', command: process.execPath, args: [FIXTURE], enabled: true }, registry);
    await manager.removeServer('fake', registry);
    expect(manager.status()).toEqual([]);
    expect(registry.has('mcp__fake__echo')).toBe(false);
  });

  it('marks a disabled server as disabled and registers nothing', async () => {
    await manager.addServer({ name: 'off', command: process.execPath, args: [FIXTURE], enabled: false }, registry);
    expect(manager.status()[0]).toMatchObject({ status: 'disabled', tools: [] });
    expect(registry.list()).toHaveLength(0);
  });

  it('replaces an existing server when the same name is added again', async () => {
    await manager.addServer({ name: 'fake', command: process.execPath, args: [FIXTURE], enabled: true }, registry);
    await manager.addServer({ name: 'fake', command: process.execPath, args: [FIXTURE], enabled: true }, registry);
    expect(manager.readConfig()).toHaveLength(1);
    expect(registry.list()).toHaveLength(2); // no duplicates
  });
});
