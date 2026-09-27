/**
 * Shared shapes for the extension surface: skills, MCP servers and plugins.
 *
 * The UI, the HTTP endpoints and the stores all speak these types so a new
 * extension kind only has to be described once.
 */

export type ExtensionKind = 'skill' | 'mcp' | 'plugin';

/** Where an installed extension came from, for display and re-install. */
export interface ExtensionSource {
  kind: 'local' | 'github';
  /** Full URL the extension was installed from, when it came from GitHub. */
  url?: string;
  /** `owner/repo` shorthand, plus the subdirectory inside it. */
  repo?: string;
  path?: string;
  ref?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  /** Absolute path of the skill directory (or the file, for loose skills). */
  path: string;
  files: number;
  bytes: number;
  source: ExtensionSource;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled: boolean;
}

export type McpStatus = 'connected' | 'error' | 'stopped' | 'disabled';

export interface McpServerInfo extends McpServerConfig {
  status: McpStatus;
  /** Tool names this server exposes (bare names, not namespaced). */
  tools: string[];
  error?: string;
}

export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  entry: string;
  path: string;
  /** Whether the entry module has been imported into this process. */
  loaded: boolean;
  /** Names the plugin contributed to the tool registry. */
  tools: string[];
  error?: string;
  source: ExtensionSource;
}

export interface ExtensionsSnapshot {
  skills: SkillInfo[];
  mcp: McpServerInfo[];
  plugins: PluginInfo[];
  /** Registered tool names, so the UI can show what the agent can actually call. */
  tools: string[];
  /** Where each store reads from, so the UI can point the user at the files. */
  dirs: { skills: string; plugins: string; mcpConfig: string };
}

/** A file downloaded from GitHub, ready to be written into a store. */
export interface RemoteFile {
  /** Path relative to the installed extension root. */
  path: string;
  content: string;
}
