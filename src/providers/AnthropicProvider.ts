import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Message, ToolChoice } from '@anthropic-ai/sdk/resources/messages';
import { BaseAIProvider } from './AIProvider.js';
import { ChatRequest, ChatResponse, ChatChunk, ToolCall, ProviderError, ThinkingLevel } from '../types/index.js';

export class AnthropicProvider extends BaseAIProvider {
  name = 'anthropic';
  private client: Anthropic;
  private model: string;
  private thinkingLevel: ThinkingLevel;

  constructor(
    apiKey: string,
    options?: { baseUrl?: string; model?: string; client?: Anthropic; thinkingLevel?: ThinkingLevel }
  ) {
    super();
    this.model = options?.model || 'claude-3-5-sonnet-20241022';
    this.thinkingLevel = options?.thinkingLevel || 'off';
    this.client =
      options?.client ??
      new Anthropic({
        apiKey,
        baseURL: options?.baseUrl,
      });
  }

  /**
   * Token budget for the configured reasoning level, or null when thinking is
   * off. The Messages API requires budget >= 1024 and strictly less than
   * max_tokens, so callers size max_tokens from this.
   */
  private thinkingBudget(): number | null {
    if (this.thinkingLevel === 'low') return 1024;
    if (this.thinkingLevel === 'medium') return 4096;
    if (this.thinkingLevel === 'high') return 16384;
    return null;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    try {
      const budget = this.thinkingBudget();
      const params = {
        model: this.model,
        max_tokens: budget ? Math.max(request.maxTokens || 8192, budget + 4096) : (request.maxTokens || 8192),
        // Extended thinking is only accepted with temperature 1.
        temperature: budget ? 1 : (request.temperature || 0.7),
        system: this.buildSystemPrompt(request) || undefined,
        messages: this.formatMessages(request.messages),
        ...(budget ? { thinking: { type: 'enabled' as const, budget_tokens: budget } } : {}),
        ...(request.tools && request.tools.length > 0
          ? {
              tools: request.tools as unknown as Anthropic.Tool[],
              ...(request.toolChoice
                ? { tool_choice: this.mapToolChoice(request.toolChoice) }
                : {}),
            }
          : {}),
      };

      const response: Message = await this.client.messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming);

      const toolCalls: ToolCall[] = [];
      let content = '';

      for (const block of response.content) {
        if (block.type === 'text') {
          content += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }

      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason:
          response.stop_reason === 'tool_use'
            ? 'tool_use'
            : response.stop_reason === 'max_tokens'
              ? 'max_tokens'
              : 'stop',
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        },
      };
    } catch (error) {
      throw new ProviderError(
        `Anthropic API error: ${error instanceof Error ? error.message : String(error)}`,
        { originalError: error }
      );
    }
  }

  private formatMessages(messages: ChatRequest['messages']): MessageParam[] {
    return messages
      .filter(m => m.role !== 'system')
      .map(m => {
        if (typeof m.content === 'string') {
          return { role: m.role, content: m.content } as MessageParam;
        }

        const blocks: unknown[] = m.content.flatMap((block): unknown[] => {
          if (block.type === 'image' && block.source) {
            return [{ type: 'image' as const, source: { type: 'base64' as const, media_type: block.source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: block.source.data } }];
          }
          if (block.type === 'file') {
            return [{ type: 'text' as const, text: `[Attached file: ${block.fileName || 'file'}]\n${block.content || ''}` }];
          }
          if (block.type === 'tool_use') {
            return [{
              type: 'tool_use' as const,
              id: block.id ?? '',
              name: block.name ?? '',
              input: (block.input as Record<string, unknown>) ?? {},
            }];
          }
          if (block.type === 'tool_result') {
            return [{
              type: 'tool_result' as const,
              tool_use_id: block.tool_use_id ?? '',
              content: block.content ?? '',
              ...(block.is_error ? { is_error: true } : {}),
            }];
          }
          return [{ type: 'text' as const, text: block.text ?? '' }];
        });

        return { role: m.role, content: blocks } as unknown as MessageParam;
      });
  }

  private mapToolChoice(choice: ChatRequest['toolChoice']): ToolChoice {
    if (!choice || choice === 'auto') {
      return { type: 'auto' };
    }
    if (choice === 'any') {
      return { type: 'any' };
    }
    if (typeof choice === 'object' && 'name' in choice) {
      return { type: 'tool', name: choice.name };
    }
    return { type: 'auto' };
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    try {
      const budget = this.thinkingBudget();
      const params: Anthropic.MessageCreateParamsStreaming = {
        model: this.model,
        max_tokens: budget ? Math.max(request.maxTokens || 8192, budget + 4096) : (request.maxTokens || 8192),
        temperature: budget ? 1 : (request.temperature || 0.7),
        system: this.buildSystemPrompt(request) || undefined,
        messages: this.formatMessages(request.messages),
        ...(budget ? { thinking: { type: 'enabled' as const, budget_tokens: budget } } : {}),
        stream: true,
      } as Anthropic.MessageCreateParamsStreaming;

      const stream = await this.client.messages.create(params);

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { delta: event.delta.text };
        }
      }
    } catch (error) {
      throw new ProviderError(
        `Anthropic streaming error: ${error instanceof Error ? error.message : String(error)}`,
        { originalError: error }
      );
    }
  }
}
