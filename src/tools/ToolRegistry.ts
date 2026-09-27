/**
 * Tool Registry - manages all available tools
 *
 * A centralized registry for managing tools that the agent can execute.
 * Provides registration, lookup, and schema generation capabilities.
 *
 * @example
 * ```typescript
 * const registry = new ToolRegistry();
 * registry.register(new ReadFileTool());
 * registry.register(new WriteFileTool());
 *
 * const tool = registry.get('read_file');
 * const schemas = registry.getSchemas();
 * ```
 */

import { Tool, ToolError, ToolSchema } from '../types/index.js';

/**
 * Central registry for managing agent tools
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  /**
   * Registers a new tool in the registry
   *
   * @param tool - The tool to register
   * @throws {ToolError} If a tool with the same name is already registered
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new ToolError(`Tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Retrieves a tool by name
   *
   * @param name - The name of the tool to retrieve
   * @returns The tool if found, undefined otherwise
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Returns all registered tools
   *
   * @returns Array of all registered tools
   */
  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Checks if a tool with the given name is registered
   *
   * @param name - The name of the tool to check
   * @returns True if the tool exists, false otherwise
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Unregisters a tool by name
   *
   * @param name - The name of the tool to remove
   * @returns True if the tool was removed, false if it didn't exist
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Gets tool schemas in a format suitable for AI provider tool definitions
   *
   * @returns Array of tool schemas with name, description, and input schema
   */
  getSchemas(): ToolSchema[] {
    return this.list().map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as ToolSchema['input_schema'],
    }));
  }
}
