import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionContentPart, ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { BaseAIProvider } from './AIProvider.js';
import {
  ChatRequest,
  ChatResponse,
  ChatChunk,
  ToolCall,
  ProviderError,
  ContentBlock,
  ThinkingLevel,
} from '../types/index.js';

export class OpenAIProvider extends BaseAIProvider {
  name = 'openai';
  private client: OpenAI;
  private model: string;
  private thinkingLevel: ThinkingLevel;

  constructor(
    apiKey: string,
    options?: { baseUrl?: string; model?: string; client?: OpenAI; thinkingLevel?: ThinkingLevel }
  ) {
    super();
    this.model = options?.model || 'gpt-4-turbo-preview';
    this.thinkingLevel = options?.thinkingLevel || 'off';
    this.client =
      options?.client ??
      new OpenAI({
        apiKey,
        baseURL: options?.baseUrl,
      });
  }

  /** Maps the shared reasoning level onto OpenAI's `reasoning_effort` knob. */
  private reasoningEffort(): 'low' | 'medium' | 'high' | null {
    if (this.thinkingLevel === 'low') return 'low';
    if (this.thinkingLevel === 'medium') return 'medium';
    if (this.thinkingLevel === 'high') return 'high';
    return null;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    try {
      const effort = this.reasoningEffort();
      const params: ChatCompletionCreateParamsNonStreaming = {
        model: this.model,
        messages: this.toApiMessages(request),
        // Reasoning models reject a custom temperature, so it is dropped when on.
        ...(effort ? {} : { temperature: request.temperature || 0.7 }),
        max_tokens: request.maxTokens || 8192,
        ...(effort ? { reasoning_effort: effort } : {}),
        ...(request.tools && request.tools.length > 0
          ? {
              tools: this.mapTools(request.tools),
              ...(request.toolChoice
                ? { tool_choice: this.mapToolChoice(request.toolChoice) as 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } } }
                : {}),
            }
          : {}),
      };

      const response = await this.client.chat.completions.create(params);

      const choice = response.choices[0];
      const content = choice?.message?.content || '';
      const toolCalls: ToolCall[] = [];

      if (choice?.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          if (tc.type === 'function') {
            toolCalls.push({
              id: tc.id,
              name: tc.function.name,
              input: this.parseArguments(tc.function.arguments),
            });
          }
        }
      }

      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason:
          choice?.finish_reason === 'tool_calls'
            ? 'tool_use'
            : choice?.finish_reason === 'length'
              ? 'max_tokens'
              : 'stop',
        usage: response.usage
          ? {
              inputTokens: response.usage.prompt_tokens,
              outputTokens: response.usage.completion_tokens,
              totalTokens: response.usage.total_tokens,
            }
          : undefined,
      };
    } catch (error) {
      throw new ProviderError(
        `OpenAI API error: ${error instanceof Error ? error.message : String(error)}`,
        { originalError: error }
      );
    }
  }

  private mapTools(tools: NonNullable<ChatRequest['tools']>): ChatCompletionTool[] {
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  private toApiMessages(request: ChatRequest): ChatCompletionMessageParam[] {
    const messages: ChatCompletionMessageParam[] = [];

    const systemPrompt = this.buildSystemPrompt(request);
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of request.messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: typeof msg.content === 'string' && msg.content ? msg.content : null,
          tool_calls: msg.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input ?? {}),
            },
          })),
        });
        continue;
      }

      if (msg.role === 'user' && typeof msg.content !== 'string') {
        const toolResults = msg.content.filter(b => b.type === 'tool_result');
        const textParts = msg.content
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '');
        const fileNotes = msg.content
          .filter(b => b.type === 'file')
          .map(b => `[Attached file: ${b.fileName || 'file'}]\n${b.content || ''}`);
        const images = msg.content
          .filter(b => b.type === 'image' && b.source)
          .map(b => ({
            type: 'image_url' as const,
            image_url: { url: `data:${b.source!.media_type};base64,${b.source!.data}` },
          }));

        for (const block of toolResults) {
          messages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id ?? '',
            content: block.content ?? '',
          });
        }

        const textBody = textParts.concat(fileNotes).filter(Boolean).join('\n');
        if (images.length) {
          const parts: ChatCompletionContentPart[] = [];
          if (textBody) parts.push({ type: 'text', text: textBody });
          parts.push(...images);
          messages.push({ role: 'user' as const, content: parts });
        } else if (textBody) {
          messages.push({ role: 'user', content: textBody });
        }
        continue;
      }

      messages.push({
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : this.flattenContent(msg.content),
      });
    }

    return messages;
  }

  private flattenContent(content: ContentBlock[]): string {
    return content
      .map(block => {
        if (block.type === 'text') return block.text ?? '';
        if (block.type === 'tool_result') return block.content ?? '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  private parseArguments(args: string): unknown {
    try {
      return JSON.parse(args || '{}');
    } catch {
      return { _raw: args };
    }
  }

  private mapToolChoice(choice: ChatRequest['toolChoice']): unknown {
    if (!choice || choice === 'auto') {
      return 'auto';
    }
    if (choice === 'any') {
      return 'required';
    }
    if (choice === 'none') {
      return 'none';
    }
    if (typeof choice === 'object' && 'name' in choice) {
      return {
        type: 'function',
        function: { name: choice.name },
      };
    }
    return 'auto';
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    try {
      const effort = this.reasoningEffort();
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages: this.toApiMessages(request),
        ...(effort ? {} : { temperature: request.temperature || 0.7 }),
        max_tokens: request.maxTokens || 8192,
        ...(effort ? { reasoning_effort: effort } : {}),
        stream: true,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          yield { delta: delta.content };
        }
      }
    } catch (error) {
      throw new ProviderError(
        `OpenAI streaming error: ${error instanceof Error ? error.message : String(error)}`,
        { originalError: error }
      );
    }
  }
}
