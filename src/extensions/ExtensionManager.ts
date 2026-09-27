/**
 * Extension manager: one façade over the three stores.
 *
 * Everything the HTTP layer and the UI need goes through here, so the "install
 * from GitHub" path has a single implementation that sniffs what it downloaded
 * (a SKILL.md, a plugin.json, an mcp.json) and routes it to the right store.
 */

import fs from 'fs';
import path from 'path';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { fetchFromGitHubUrl, GitHubRef } from './GitHubFetcher.js';
import { McpConfigError, McpManager, parseMcpConfig } from './McpManager.js';
import { PluginError, PLUGIN_MANIFEST, PluginStore } from './PluginStore.js';
import { parseSkillFrontmatter, SkillError, SkillStore } from './SkillStore.js';
import { ExtensionKind, ExtensionSource, ExtensionsSnapshot, McpServerConfig, RemoteFile } from './types.js';

export interface InstallResult {
  kind: ExtensionKind;
  name: string;
  files: number;
  installed: string[];
  detail?: string;
}

export class ExtensionManager {
  readonly skills: SkillStore;
  readonly plugins: PluginStore;
  readonly mcp: McpManager;

  constructor(workspaceRoot: string) {
    const root = path.join(workspaceRoot, '.agent');
    this.skills = new SkillStore(path.join(root, 'skills'));
    this.plugins = new PluginStore(path.join(root, 'plugins'));
    this.mcp = new McpManager(path.join(root, 'mcp.json'));
  }

  snapshot(registry?: ToolRegistry): ExtensionsSnapshot {
    return {
      skills: this.skills.list(),
      mcp: this.mcp.status(),
      plugins: this.plugins.list(),
      tools: registry ? registry.list().map((t) => t.name) : [],
      dirs: { skills: this.skills.dir, plugins: this.plugins.dir, mcpConfig: this.mcp.file },
    };
  }

  /** Connect configured MCP servers and load installed plugins into the registry. */
  async activate(registry: ToolRegistry): Promise<void> {
    await this.mcp.connectAll(registry);
    for (const plugin of this.plugins.list()) {
      if (plugin.loaded) continue;
      try {
        await this.plugins.load(plugin.name, registry);
      } catch {
        // A broken plugin is reported in the listing; it must not block boot.
      }
    }
  }

  /** Full teardown, used when provider settings change and the agent is rebuilt. */
  deactivate(registry?: ToolRegistry): void {
    this.mcp.disconnectAll(registry);
    if (registry) {
      for (const plugin of this.plugins.list()) this.plugins.unload(plugin.name, registry);
    }
  }

  /**
   * Install from a GitHub URL. With no explicit `kind` the payload decides: a
   * SKILL.md means a skill, a plugin.json a plugin, an mcp.json one or more MCP
   * servers.
   */
  async installFromGitHub(
    url: string,
    opts: { kind?: ExtensionKind; name?: string; overwrite?: boolean; registry?: ToolRegistry } = {},
  ): Promise<InstallResult> {
    const { ref, files } = await fetchFromGitHubUrl(url);
    const kind = opts.kind ?? detectKind(files);
    if (!kind) {
      throw new InstallError(
        'Nothing installable at that URL: expected a SKILL.md (skill), a plugin.json (plugin) or an mcp.json (MCP servers)',
      );
    }
    const source: ExtensionSource = { kind: 'github', url, repo: `${ref.owner}/${ref.repo}`, path: ref.path, ref: ref.ref };
    const fallbackName = opts.name || defaultName(ref, files, kind);

    if (kind === 'skill') {
      const frontmatter = parseSkillFrontmatter(files.find((f) => f.path === 'SKILL.md')?.content ?? '');
      const name = opts.name || frontmatter.name || fallbackName;
      this.skills.install(name, files, source, { overwrite: opts.overwrite });
      return { kind, name, files: files.length, installed: this.skills.files(name) };
    }

    if (kind === 'plugin') {
      const name = opts.name || manifestName(files) || fallbackName;
      this.plugins.install(name, files, source, { overwrite: opts.overwrite });
      if (opts.registry) await this.plugins.load(name, opts.registry);
      return { kind, name, files: files.length, installed: [PLUGIN_MANIFEST] };
    }

    // MCP: merge the servers in the downloaded mcp.json into the workspace config.
    const incoming = parseMcpConfig(JSON.parse(files.find((f) => f.path.endsWith('mcp.json'))?.content ?? '{}'));
    if (incoming.length === 0) throw new InstallError('That mcp.json does not define any servers');
    const existing = this.mcp.readConfig();
    const merged = [...existing.filter((s) => !incoming.some((i) => i.name === s.name)), ...incoming];
    this.mcp.writeConfig(merged);
    for (const server of incoming) await this.mcp.reload(server.name, opts.registry);
    return {
      kind: 'mcp',
      name: incoming.map((s) => s.name).join(', '),
      files: files.length,
      installed: incoming.map((s) => s.name),
      detail: `added ${incoming.length} MCP server${incoming.length === 1 ? '' : 's'}`,
    };
  }

  /** Add one MCP server by hand (name + command), then connect it. */
  async addMcpServer(config: McpServerConfig, registry?: ToolRegistry): Promise<void> {
    await this.mcp.addServer(config, registry);
  }

  async remove(kind: ExtensionKind, name: string, registry?: ToolRegistry): Promise<void> {
    if (kind === 'skill') this.skills.remove(name);
    else if (kind === 'plugin') {
      this.plugins.unload(name, registry as ToolRegistry);
      this.plugins.remove(name);
    } else this.mcp.removeServer(name, registry);
  }

  /** Read a skill's SKILL.md for the viewer. */
  readSkill(name: string): string {
    return this.skills.read(name);
  }
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

/** Which store does this payload belong to? */
export function detectKind(files: RemoteFile[]): ExtensionKind | null {
  const paths = files.map((f) => f.path);
  if (paths.includes('SKILL.md')) return 'skill';
  if (paths.includes(PLUGIN_MANIFEST)) return 'plugin';
  if (paths.some((p) => p === 'mcp.json' || p.endsWith('/mcp.json'))) return 'mcp';
  return null;
}

function manifestName(files: RemoteFile[]): string | null {
  const manifest = files.find((f) => f.path === PLUGIN_MANIFEST);
  if (!manifest) return null;
  try {
    const parsed = JSON.parse(manifest.content) as { name?: string };
    return typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null;
  } catch {
    return null;
  }
}

/** Fall back to the last path segment, or the repo name for a repo root. */
function defaultName(ref: GitHubRef, files: RemoteFile[], kind: ExtensionKind): string {
  if (ref.path) return ref.path.split('/').filter(Boolean).pop() as string;
  const nested = files.find((f) => f.path.endsWith(kind === 'skill' ? 'SKILL.md' : PLUGIN_MANIFEST));
  if (nested && nested.path.includes('/')) return nested.path.split('/')[0];
  return ref.repo;
}

/** Re-exported so the HTTP layer can map store errors to status codes in one place. */
export const EXTENSION_ERRORS = [SkillError, PluginError, McpConfigError, InstallError];

export function isExtensionError(error: unknown): boolean {
  return EXTENSION_ERRORS.some((Ctor) => error instanceof Ctor);
}

/** Existence check used by the snapshot for "is this store empty yet". */
export function storeExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
