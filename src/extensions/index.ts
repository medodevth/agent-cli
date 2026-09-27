/**
 * Extension surface: skills, MCP servers and plugins.
 *
 * `ExtensionManager` is the entry point; the individual stores and the GitHub
 * fetcher are exported for direct use and for tests.
 */

export * from './types.js';
export { SkillStore, SkillError, parseSkillFrontmatter, assertSafeName, safeJoin } from './SkillStore.js';
export { PluginStore, PluginError, PLUGIN_MANIFEST, registerPluginModule } from './PluginStore.js';
export { McpManager, McpTool, McpConfigError, parseMcpConfig, splitMcpToolName, MCP_CONFIG_FILE } from './McpManager.js';
export { McpClient, McpError } from './McpClient.js';
export { parseGitHubUrl, fetchGitHubFiles, fetchFromGitHubUrl, GitHubError } from './GitHubFetcher.js';
export { ExtensionManager, InstallError, detectKind, isExtensionError } from './ExtensionManager.js';
export type { McpToolDefinition } from './McpClient.js';
