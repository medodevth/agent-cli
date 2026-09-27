import { Agent } from './agent/Agent.js';
import { AIProvider } from './providers/AIProvider.js';
import { AnthropicProvider } from './providers/AnthropicProvider.js';
import { OpenAIProvider } from './providers/OpenAIProvider.js';
import { createDefaultToolRegistry } from './tools/index.js';
import { DefaultPermissionManager } from './security/PermissionManager.js';
import { Config } from './types/index.js';

/** Picks the provider implementation named in the config. */
export function createProvider(config: Config, apiKey: string): AIProvider {
  if (config.provider === 'anthropic') {
    return new AnthropicProvider(apiKey, { baseUrl: config.baseUrl, model: config.model, thinkingLevel: config.thinkingLevel });
  }
  if (config.provider === 'openai') {
    return new OpenAIProvider(apiKey, { baseUrl: config.baseUrl, model: config.model, thinkingLevel: config.thinkingLevel });
  }
  throw new Error(`Unsupported provider: ${config.provider}`);
}

/** Builds a fully wired Agent: provider + tools + permissions from one config. */
export function createAgent(config: Config, apiKey: string): Agent {
  return new Agent(
    createProvider(config, apiKey),
    createDefaultToolRegistry(),
    new DefaultPermissionManager(config.permissionMode),
    config
  );
}
