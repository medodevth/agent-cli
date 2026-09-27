import { ChatMessage, ContentBlock } from '../types/index.js';

/**
 * ContextCompressor — the agent's "compression pipe".
 *
 * Long runs accumulate tool calls and results until the model's context
 * window fills and quality degrades. This compressor keeps the conversation
 * inside a token budget WITHOUT extra model calls:
 *
 *   - the most recent `keepRecent` messages stay verbatim (exact code and
 *     errors the agent is actively working with),
 *   - everything older is folded into ONE dense system-message digest:
 *     short chronological entries (task statements, tool calls with key
 *     args, outcomes) plus an explicit HANDOFF section,
 *   - an existing digest is merged into the new one (rolling), and the
 *     digest body is capped — oldest entries are dropped first.
 *
 * Everything is deterministic (no LLM round-trips), so compression is fast,
 * free, and safe to run before every provider call.
 */

export const DIGEST_MARKER = '=== CONVERSATION DIGEST ===';

export interface CompressionStats {
  triggered: boolean;
  messagesBefore: number;
  messagesAfter: number;
  estTokensBefore: number;
  estTokensAfter: number;
}

export interface CompressorOptions {
  /** Messages kept verbatim at the tail of the conversation. */
  keepRecent?: number;
  /** Hard cap for the digest body; oldest entries are trimmed beyond it. */
  maxDigestChars?: number;
  /** Max chars kept per text summary inside an entry. */
  entryTextChars?: number;
  /** Max chars for a single tool_result kept verbatim in the recent tail. */
  resultCapChars?: number;
}

const DEFAULTS = { keepRecent: 12, maxDigestChars: 6000, entryTextChars: 240, resultCapChars: 6000 };

export class ContextCompressor {
  private readonly keepRecent: number;
  private readonly maxDigestChars: number;
  private readonly entryTextChars: number;
  private readonly resultCapChars: number;

  constructor(options: CompressorOptions = {}) {
    this.keepRecent = Math.max(2, options.keepRecent ?? DEFAULTS.keepRecent);
    this.maxDigestChars = Math.max(1000, options.maxDigestChars ?? DEFAULTS.maxDigestChars);
    this.entryTextChars = Math.max(80, options.entryTextChars ?? DEFAULTS.entryTextChars);
    this.resultCapChars = Math.max(500, options.resultCapChars ?? DEFAULTS.resultCapChars);
  }

  /** Rough token estimate (~4 chars/token) over the string content of messages. */
  estimateTokens(messages: ChatMessage[]): number {
    let chars = 0;
    for (const message of messages) {
      if (typeof message.content === 'string') {
        chars += message.content.length;
      } else if (Array.isArray(message.content)) {
        for (const block of message.content as ContentBlock[]) {
          chars += (block.text?.length ?? 0) + (block.content?.length ?? 0) + 24;
        }
      }
      if (message.toolCalls) {
        for (const call of message.toolCalls) chars += JSON.stringify(call.input ?? {}).length + 32;
      }
    }
    return Math.ceil(chars / 4);
  }

  /**
   * Token budget is the only gate: tool_use batches mean few messages can
   * carry huge content, so counting messages is meaningless.
   */
  shouldCompress(messages: ChatMessage[], tokenBudget: number): boolean {
    if (messages.length < 2) return false;
    return this.estimateTokens(messages) > tokenBudget;
  }

  /**
   * Compresses old turns into a rolling digest. Returns the new message
   * array: [digest system message, ...recent messages verbatim].
   */
  compress(messages: ChatMessage[]): { messages: ChatMessage[]; stats: CompressionStats } {
    const estBefore = this.estimateTokens(messages);
    const countBefore = messages.length;

    // Split off an existing digest (if any) so it can be merged.
    let priorDigestBody = '';
    const working = [...messages];
    const digestIndex = working.findIndex(
      m => m.role === 'system' && typeof m.content === 'string' && m.content.includes(DIGEST_MARKER)
    );
    if (digestIndex >= 0) {
      const prior = working[digestIndex].content as string;
      priorDigestBody = prior.split(DIGEST_MARKER)[1]?.trim() ?? '';
      working.splice(digestIndex, 1);
    }

    const keepCount = Math.min(this.keepRecent, working.length - 1);
    const cutoff = Math.max(0, working.length - keepCount);
    const oldMessages = working.slice(0, cutoff);
    const recentMessages = working.slice(cutoff).map(m => this.truncateBigResults(m));

    // Few messages, huge content: nothing old to fold — capping oversized
    // tool results in the tail is the compression that still makes progress.
    if (oldMessages.length === 0) {
      const result = recentMessages;
      return {
        messages: result,
        stats: {
          triggered: true,
          messagesBefore: countBefore,
          messagesAfter: result.length,
          estTokensBefore: estBefore,
          estTokensAfter: this.estimateTokens(result),
        },
      };
    }

    const newEntries: string[] = [];
    for (const message of oldMessages) newEntries.push(...this.entriesFor(message));

    // Rolling merge: prior digest entries first (they are older), capped to
    // half the budget so fresh context always dominates.
    const priorCap = Math.floor(this.maxDigestChars / 2);
    const priorTrimmed =
      priorDigestBody.length > priorCap
        ? '(earlier entries trimmed)\n' + priorDigestBody.slice(priorDigestBody.length - priorCap)
        : priorDigestBody;

    const body = [priorTrimmed, ...newEntries].filter(Boolean).join('\n').trim();
    const finalBody =
      body.length > this.maxDigestChars
        ? '(earlier entries trimmed)\n' + body.slice(body.length - this.maxDigestChars)
        : body;

    const digestMessage: ChatMessage = {
      role: 'system',
      content: this.renderDigest(finalBody),
      timestamp: new Date(),
    };

    const result = [digestMessage, ...recentMessages];
    void this.entryTextChars;
    return {
      messages: result,
      stats: {
        triggered: true,
        messagesBefore: countBefore,
        messagesAfter: result.length,
        estTokensBefore: estBefore,
        estTokensAfter: this.estimateTokens(result),
      },
    };
  }

  // -------------------------------------------------------------------------

  private renderDigest(body: string): string {
    return `${DIGEST_MARKER}
Older conversation condensed below. Treat entries as established facts —
do not redo tool calls whose results are already recorded here.

${body}

HANDOFF: continue from the latest entry. If the task appears unfinished,
resume exactly where it stopped; if finished, report per the completion contract.`;
  }

  private entriesFor(message: ChatMessage): string[] {
    const lines: string[] = [];
    if (typeof message.content === 'string') {
      const text = this.oneLine(message.content);
      if (text) {
        if (message.role === 'user') lines.push(`USER: ${text}`);
        else if (message.role === 'assistant') lines.push(`AGENT: ${text}`);
      }
    } else if (Array.isArray(message.content)) {
      const results: string[] = [];
      for (const block of message.content as ContentBlock[]) {
        if (block.type === 'tool_result') {
          const outcome = block.is_error
            ? `ERROR ${this.oneLine(block.content ?? '').slice(0, 100)}`
            : `ok (${block.content?.length ?? 0} ch)`;
          results.push(`${block.name ?? block.tool_use_id ?? '?'}=${outcome}`);
        } else if (block.type === 'text' && block.text?.trim()) {
          const text = this.oneLine(block.text);
          if (text) lines.push(`${message.role === 'user' ? 'USER' : 'AGENT'}: ${text}`);
        }
      }
      if (results.length) lines.push(`RESULTS: ${results.join(' | ')}`);
    }
    if (message.toolCalls?.length) {
      const calls = message.toolCalls
        .map(call => `${call.name}(${this.keyArgs(call.input)})`)
        .join(', ');
      lines.push(`AGENT CALLED: ${calls}`);
    }
    return lines;
  }

  private keyArgs(input: unknown): string {
    if (input === null || input === undefined || typeof input !== 'object') {
      return this.oneLine(String(input ?? '')).slice(0, 60);
    }
    const parts: string[] = [];
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (parts.length >= 2) break;
      const text = this.oneLine(String(value)).slice(0, 60);
      parts.push(`${key}=${text}`);
    }
    return parts.join(', ');
  }

  /** Caps any single tool_result still kept verbatim in the recent tail. */
  private truncateBigResults(message: ChatMessage): ChatMessage {
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const blocks = (message.content as ContentBlock[]).map(block => {
      if (block.type === 'tool_result' && (block.content?.length ?? 0) > this.resultCapChars) {
        changed = true;
        return {
          ...block,
          content:
            block.content!.slice(0, this.resultCapChars) +
            `…(truncated, ${block.content!.length} chars total — re-read a line range if needed)`,
        };
      }
      return block;
    });
    return changed ? { ...message, content: blocks } : message;
  }

  private oneLine(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > this.entryTextChars ? flat.slice(0, this.entryTextChars - 1) + '…' : flat;
  }
}
