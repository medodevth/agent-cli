import type { ChatChunk, ChatRequest, ChatResponse, ToolCall } from '../types/index.js';
import { validateToolInput } from './ValidationUtilities.js';

/** Provider identifiers are intentionally open-ended: compatible endpoints can be added without a release. */
export type ProviderName = string;
type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as AnyRecord)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function requireNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value || '{}') as unknown;
  } catch {
    return { _raw: value };
  }
}

function toolCall(id: unknown, name: unknown, input: unknown, fallbackId: string): ToolCall | undefined {
  if (typeof name !== 'string' || name.length === 0) return undefined;
  return {
    id: typeof id === 'string' && id.length > 0 ? id : fallbackId,
    name,
    input: parseToolInput(input),
  };
}

/**
 * 405. Normalize complete tool-call arrays from Anthropic, OpenAI-compatible
 * (including GLM), or Gemini responses. Invalid/incomplete entries are skipped.
 */
export function toolCallParser(provider: ProviderName, response: unknown): ToolCall[] {
  const root = asRecord(response);
  if (!root) return [];

  const canonical = asArray(root.toolCalls);
  if (canonical.length > 0) {
    return canonical.flatMap((item, index) => {
      const call = asRecord(item);
      if (!call) return [];
      const normalized = toolCall(call.id, call.name, call.input, `call_${index}`);
      return normalized ? [normalized] : [];
    });
  }

  const lowerProvider = provider.toLowerCase();
  if (lowerProvider === 'anthropic') {
    return asArray(root.content).flatMap((item, index) => {
      const block = asRecord(item);
      if (block?.type !== 'tool_use') return [];
      const normalized = toolCall(block.id, block.name, block.input, `call_${index}`);
      return normalized ? [normalized] : [];
    });
  }

  if (lowerProvider === 'gemini' || lowerProvider === 'google') {
    const candidates = asArray(root.candidates);
    const parts = candidates.flatMap(candidate => {
      const content = asRecord(asRecord(candidate)?.content);
      return asArray(content?.parts);
    });
    return parts.flatMap((part, index) => {
      const item = asRecord(part);
      const call = asRecord(item?.functionCall ?? item?.function_call);
      if (!call) return [];
      const normalized = toolCall(call.id, call.name, call.args ?? call.arguments, `call_${index}`);
      return normalized ? [normalized] : [];
    });
  }

  const choice = asRecord(asArray(root.choices)[0]);
  const message = asRecord(choice?.message ?? root.message);
  const entries = asArray(message?.tool_calls ?? root.tool_calls);
  return entries.flatMap((entry, index) => {
    const item = asRecord(entry);
    const fn = asRecord(item?.function);
    const normalized = toolCall(item?.id, fn?.name ?? item?.name, fn?.arguments ?? item?.input, `call_${index}`);
    return normalized ? [normalized] : [];
  });
}

function normalizedContent(provider: ProviderName, raw: AnyRecord): string {
  if (typeof raw.content === 'string') return raw.content;
  if (typeof raw.text === 'string') return raw.text;
  const lowerProvider = provider.toLowerCase();

  if (lowerProvider === 'gemini' || lowerProvider === 'google') {
    const candidates = asArray(raw.candidates);
    const parts = candidates.flatMap(candidate => asArray(asRecord(asRecord(candidate)?.content)?.parts));
    return parts.flatMap(part => {
      const text = asRecord(part)?.text;
      return typeof text === 'string' ? [text] : [];
    }).join('');
  }

  const content = asArray(raw.content);
  if (content.length > 0) {
    return content.flatMap(block => {
      const item = asRecord(block);
      if (typeof item?.text === 'string') return [item.text];
      if (typeof item?.content === 'string' && item.type === 'text') return [item.content];
      return [];
    }).join('');
  }

  const choice = asRecord(asArray(raw.choices)[0]);
  const message = asRecord(choice?.message);
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return asArray(message.content).flatMap(part => {
      const text = asRecord(part)?.text;
      return typeof text === 'string' ? [text] : [];
    }).join('');
  }
  return '';
}

function normalizeUsage(raw: AnyRecord): ChatResponse['usage'] {
  const usage = asRecord(raw.usage);
  if (!usage) return undefined;
  const inputTokens = finiteNumber(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = finiteNumber(usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens);
  const totalTokens = finiteNumber(usage.totalTokens ?? usage.total_tokens) ??
    (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

function finishReason(raw: AnyRecord, hasToolCalls: boolean): ChatResponse['finishReason'] {
  const choice = asRecord(asArray(raw.choices)[0]);
  const candidate = asRecord(asArray(raw.candidates)[0]);
  const reason = String(raw.finishReason ?? raw.stop_reason ?? raw.stopReason ?? choice?.finish_reason ?? candidate?.finishReason ?? '').toLowerCase();
  if (hasToolCalls || reason.includes('tool')) return 'tool_use';
  if (reason.includes('max_tokens') || reason === 'length' || reason === 'max_tokens') return 'max_tokens';
  if (reason === 'error') return 'error';
  return 'stop';
}

function normalizeProviderResponse(provider: ProviderName, response: unknown): ChatResponse {
  const raw = asRecord(response);
  if (!raw) throw new Error(`${provider} provider returned a non-object response`);
  const calls = toolCallParser(provider, raw);
  return {
    content: normalizedContent(provider, raw),
    toolCalls: calls.length > 0 ? calls : undefined,
    finishReason: finishReason(raw, calls.length > 0),
    usage: normalizeUsage(raw),
    rawResponse: response,
  };
}

export interface ProviderTransport {
  /** Inject the actual provider/API call. No model call is fabricated by this utility. */
  chat(request: ChatRequest): Promise<unknown>;
  /** Optional raw provider stream; provider-specific event parsing happens here. */
  stream?(request: ChatRequest): AsyncIterable<unknown> | Iterable<unknown>;
}

export interface ProviderAdapterOptions {
  model?: string;
  /**
   * Optional request mapper to produce native Anthropic/OpenAI/Gemini/GLM
   * payloads. The mapper and transport are injected; no credentials/network
   * behavior or native request format is fabricated here.
   */
  mapRequest?: (request: ChatRequest, provider: ProviderName, model?: string) => unknown;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<ChatChunk>;
}

/** 401. Build a canonical provider interface around caller-injected transport functions. */
export function providerAdapter(
  provider: ProviderName,
  transport: ProviderTransport,
  options: ProviderAdapterOptions = {}
): ProviderAdapter {
  const prepare = (request: ChatRequest): ChatRequest => {
    const mapped = options.mapRequest?.(request, provider, options.model);
    return mapped === undefined ? request : mapped as ChatRequest;
  };
  return {
    name: provider,
    async chat(request) {
      return normalizeProviderResponse(provider, await transport.chat(prepare(request)));
    },
    async *stream(request) {
      if (!transport.stream) throw new Error(`No streaming transport configured for provider '${provider}'`);
      yield* streamResponseParser(provider, transport.stream(prepare(request)));
    },
  };
}

export interface ComplexityModels {
  low: string;
  medium: string;
  high: string;
}

/** 402. Route a caller-scored [0,1] task to explicitly configured model tiers. */
export function modelRouterByComplexity(
  complexity: number,
  models: ComplexityModels,
  thresholds: { medium?: number; high?: number } = {}
): string {
  if (!Number.isFinite(complexity) || complexity < 0 || complexity > 1) {
    throw new Error('complexity must be a finite number between 0 and 1');
  }
  const medium = thresholds.medium ?? 0.35;
  const high = thresholds.high ?? 0.7;
  if (!Number.isFinite(medium) || !Number.isFinite(high) || medium < 0 || high > 1 || medium >= high) {
    throw new Error('complexity thresholds must satisfy 0 <= medium < high <= 1');
  }
  const selected = complexity < medium ? models.low : complexity < high ? models.medium : models.high;
  if (typeof selected !== 'string' || selected.trim() === '') throw new Error('all complexity tiers require a model name');
  return selected;
}

export interface FallbackResult<T> {
  model: string;
  value: T;
  attempts: number;
}

export class ModelFallbackError extends AggregateError {
  constructor(readonly models: string[], errors: unknown[]) {
    super(errors, `All ${models.length} configured model fallback(s) failed`);
    this.name = 'ModelFallbackError';
  }
}

/** 403. Call each configured model in order; preserve every failure if the chain is exhausted. */
export async function modelFallbackChain<T>(
  models: readonly string[],
  call: (model: string, attempt: number) => Promise<T>
): Promise<FallbackResult<T>> {
  if (models.length === 0) throw new Error('model fallback chain must contain at least one model');
  const errors: unknown[] = [];
  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    if (!model || model.trim() === '') throw new Error('model fallback entries must be non-empty');
    try {
      return { model, value: await call(model, index + 1), attempts: index + 1 };
    } catch (error) {
      errors.push(error);
    }
  }
  throw new ModelFallbackError([...models], errors);
}

interface PendingToolCall {
  id?: string;
  name?: string;
  arguments: string;
}

function eventObject(value: unknown): AnyRecord | undefined {
  if (typeof value !== 'string') return asRecord(value);
  const data = value.trim().replace(/^data:\s*/, '');
  if (data === '' || data === '[DONE]') return undefined;
  try {
    return asRecord(JSON.parse(data) as unknown);
  } catch {
    return { delta: value };
  }
}

/**
 * 404. Convert provider-specific stream events into canonical text/tool chunks.
 * OpenAI partial tool arguments are buffered until the stream ends so consumers
 * never receive a misleading half-JSON tool input.
 */
export async function* streamResponseParser(
  provider: ProviderName,
  source: AsyncIterable<unknown> | Iterable<unknown>
): AsyncIterable<ChatChunk> {
  const lowerProvider = provider.toLowerCase();
  const openAiCalls = new Map<number, PendingToolCall>();
  const anthropicCalls = new Map<number, PendingToolCall>();
  let nextToolIndex = 0;

  for await (const item of source) {
    const event = eventObject(item);
    if (!event) continue;

    if (typeof event.delta === 'string' && !event.choices && !event.type) {
      yield { delta: event.delta };
      continue;
    }

    if (lowerProvider === 'anthropic') {
      const delta = asRecord(event.delta);
      if (event.type === 'content_block_start') {
        const block = asRecord(event.content_block);
        if (block?.type === 'tool_use') {
          const index = finiteNumber(event.index) ?? nextToolIndex++;
          anthropicCalls.set(index, {
            id: typeof block.id === 'string' ? block.id : undefined,
            name: typeof block.name === 'string' ? block.name : undefined,
            // Anthropic starts tool input with {} before partial JSON deltas; the
            // start payload is a placeholder, not a prefix to the completed JSON.
            arguments: block.input === undefined || (asRecord(block.input) !== undefined && Object.keys(asRecord(block.input)!).length === 0)
              ? ''
              : JSON.stringify(block.input),
          });
        }
      } else if (event.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
        yield { delta: delta.text };
      } else if (event.type === 'content_block_delta' && delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const index = finiteNumber(event.index) ?? 0;
        const pending = anthropicCalls.get(index) ?? { arguments: '' };
        pending.arguments += delta.partial_json;
        anthropicCalls.set(index, pending);
      }
      continue;
    }

    if (lowerProvider === 'openai' || lowerProvider === 'glm' || lowerProvider.includes('compatible')) {
      const choice = asRecord(asArray(event.choices)[0]);
      const delta = asRecord(choice?.delta);
      if (typeof delta?.content === 'string' && delta.content.length > 0) yield { delta: delta.content };
      for (const rawCall of asArray(delta?.tool_calls)) {
        const call = asRecord(rawCall);
        if (!call) continue;
        const index = finiteNumber(call.index) ?? nextToolIndex++;
        const pending = openAiCalls.get(index) ?? { arguments: '' };
        if (typeof call.id === 'string') pending.id = call.id;
        const fn = asRecord(call.function);
        if (typeof fn?.name === 'string') pending.name = (pending.name ?? '') + fn.name;
        if (typeof fn?.arguments === 'string') pending.arguments += fn.arguments;
        openAiCalls.set(index, pending);
      }
      continue;
    }

    if (lowerProvider === 'gemini' || lowerProvider === 'google') {
      const candidates = asArray(event.candidates);
      for (const part of candidates.flatMap(candidate => asArray(asRecord(asRecord(candidate)?.content)?.parts))) {
        const itemRecord = asRecord(part);
        if (typeof itemRecord?.text === 'string') yield { delta: itemRecord.text };
        const call = asRecord(itemRecord?.functionCall ?? itemRecord?.function_call);
        if (call) {
          const normalized = toolCall(call.id, call.name, call.args ?? call.arguments, `call_${nextToolIndex++}`);
          if (normalized) yield { delta: '', toolCalls: [normalized] };
        }
      }
      continue;
    }

    if (typeof event.delta === 'string') yield { delta: event.delta };
    const calls = toolCallParser(provider, event);
    if (calls.length > 0) yield { delta: '', toolCalls: calls };
  }

  const completed = [...openAiCalls.values(), ...anthropicCalls.values()].flatMap((pending, index) => {
    const normalized = toolCall(pending.id, pending.name, pending.arguments || '{}', `call_${index}`);
    return normalized ? [normalized] : [];
  });
  if (completed.length > 0) yield { delta: '', toolCalls: completed };
}

export interface ApiKeyRotator {
  /** Returns the next available key, or undefined when all keys are cooling down. */
  next(): string | undefined;
  markFailed(key: string, cooldownMs?: number): void;
  markSuccess(key: string): void;
  availableCount(): number;
}

/** 406. Round-robin API-key selection with a bounded failure cooldown; never logs key values. */
export function apiKeyRotator(
  keys: readonly string[],
  options: { now?: () => number; cooldownMs?: number } = {}
): ApiKeyRotator {
  const uniqueKeys = [...new Set(keys.filter(key => typeof key === 'string' && key.length > 0))];
  const cooldownMs = options.cooldownMs ?? 30_000;
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) throw new Error('cooldownMs must be non-negative');
  const now = options.now ?? Date.now;
  const unavailableUntil = new Map<string, number>();
  let cursor = 0;
  const isAvailable = (key: string): boolean => {
    const until = unavailableUntil.get(key);
    if (until === undefined || until <= now()) {
      unavailableUntil.delete(key);
      return true;
    }
    return false;
  };
  return {
    next() {
      if (uniqueKeys.length === 0) return undefined;
      for (let checked = 0; checked < uniqueKeys.length; checked++) {
        const index = cursor % uniqueKeys.length;
        cursor = (index + 1) % uniqueKeys.length;
        if (isAvailable(uniqueKeys[index])) return uniqueKeys[index];
      }
      return undefined;
    },
    markFailed(key, overrideCooldownMs = cooldownMs) {
      if (!uniqueKeys.includes(key)) return;
      if (!Number.isFinite(overrideCooldownMs) || overrideCooldownMs < 0) throw new Error('cooldownMs must be non-negative');
      unavailableUntil.set(key, now() + overrideCooldownMs);
    },
    markSuccess(key) {
      unavailableUntil.delete(key);
    },
    availableCount() {
      return uniqueKeys.reduce((count, key) => count + (isAvailable(key) ? 1 : 0), 0);
    },
  };
}

export interface TokenRates {
  currency: string;
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
}

export interface ProviderCost {
  provider: ProviderName;
  model: string;
  currency: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  assumptions: string[];
}

/** 407. Calculate cost only from explicit caller-supplied per-million-token rates. */
export function costPerProviderCalculator(
  provider: ProviderName,
  model: string,
  usage: { inputTokens: number; outputTokens: number },
  rates: TokenRates
): ProviderCost {
  requireNonNegative(usage.inputTokens, 'inputTokens');
  requireNonNegative(usage.outputTokens, 'outputTokens');
  requireNonNegative(rates.inputPerMillionTokens, 'inputPerMillionTokens');
  requireNonNegative(rates.outputPerMillionTokens, 'outputPerMillionTokens');
  if (!rates.currency.trim()) throw new Error('currency must be specified');
  const cost = usage.inputTokens / 1_000_000 * rates.inputPerMillionTokens +
    usage.outputTokens / 1_000_000 * rates.outputPerMillionTokens;
  return {
    provider,
    model,
    currency: rates.currency,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cost,
    assumptions: [
      'Rates are caller-supplied currency amounts per one million tokens.',
      'Cost excludes taxes, discounts, cache pricing, and provider-specific non-token charges.',
    ],
  };
}

export interface ProviderHealthCheck {
  status: 'healthy' | 'unhealthy' | 'timeout';
  durationMs: number;
  error?: string;
}

export interface ProviderHealthReport {
  overall: 'healthy' | 'unhealthy';
  checkedAt: number;
  checks: Record<string, ProviderHealthCheck>;
}

/** 408. Run injected checks with timeouts; never make a provider request implicitly. */
export async function providerHealthCheck(
  checks: Record<string, () => boolean | void | Promise<boolean | void>>,
  options: { timeoutMs?: number; now?: () => number } = {}
): Promise<ProviderHealthReport> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const now = options.now ?? Date.now;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  const entries = await Promise.all(Object.entries(checks).map(async ([name, check]) => {
    const start = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(check).then(value => ({ kind: 'result' as const, value })),
        new Promise<{ kind: 'timeout' }>(resolve => {
          timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (outcome.kind === 'timeout') return [name, { status: 'timeout' as const, durationMs: Math.max(0, now() - start), error: `check timed out after ${timeoutMs}ms` }] as const;
      if (outcome.value === false) return [name, { status: 'unhealthy' as const, durationMs: Math.max(0, now() - start), error: 'check returned false' }] as const;
      return [name, { status: 'healthy' as const, durationMs: Math.max(0, now() - start) }] as const;
    } catch (error) {
      if (timer) clearTimeout(timer);
      return [name, { status: 'unhealthy' as const, durationMs: Math.max(0, now() - start), error: error instanceof Error ? error.message : String(error) }] as const;
    }
  }));
  const results = Object.fromEntries(entries) as Record<string, ProviderHealthCheck>;
  return {
    overall: Object.values(results).every(check => check.status === 'healthy') ? 'healthy' : 'unhealthy',
    checkedAt: now(),
    checks: results,
  };
}

export type NormalizedResponseFormat =
  | { type: 'text' }
  | { type: 'json' }
  | { type: 'json_schema'; name?: string; schema?: unknown };

/** 409. Normalize common OpenAI/Anthropic/Gemini structured-response descriptors. */
export function responseFormatNormalizer(format: unknown): NormalizedResponseFormat {
  const value = asRecord(format);
  if (!value) return { type: 'text' };
  const type = String(value.type ?? '').toLowerCase();
  const mimeType = String(value.responseMimeType ?? value.mime_type ?? '').toLowerCase();
  if (type === 'json_schema' || type === 'json-schema') {
    const nested = asRecord(value.json_schema ?? value.schema);
    const name = typeof nested?.name === 'string' ? nested.name : typeof value.name === 'string' ? value.name : undefined;
    const schema = nested?.schema ?? value.schema;
    return { type: 'json_schema', ...(name ? { name } : {}), ...(schema === undefined ? {} : { schema }) };
  }
  if (type === 'json' || type === 'json_object' || type === 'json_object_mode' || mimeType === 'application/json') {
    return { type: 'json' };
  }
  return { type: 'text' };
}

/** 410. Choose a task-specific temperature, always validating model API bounds [0,2]. */
export function temperatureConfigPerTask(
  task: string,
  config: { defaultTemperature: number; perTask?: Record<string, number> }
): number {
  const temperature = config.perTask?.[task] ?? config.defaultTemperature;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error(`temperature for '${task}' must be between 0 and 2`);
  }
  return temperature;
}

/** 411. Read a known context-window limit; unknown models return undefined rather than a guessed default. */
export function contextWindowLimitPerProvider(
  provider: ProviderName,
  model: string,
  limits: Record<string, Record<string, number | undefined> | undefined>
): number | undefined {
  const providerLimits = limits[provider];
  const limit = providerLimits?.[model] ?? providerLimits?.default;
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`invalid context window limit for ${provider}/${model}`);
  return limit;
}

export interface LatencySummary {
  count: number;
  averageMs: number;
  minMs?: number;
  maxMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  lastMs?: number;
}

export interface ProviderLatencyTracker {
  record(provider: ProviderName, durationMs: number): void;
  start(provider: ProviderName): () => number;
  snapshot(provider: ProviderName): LatencySummary;
  reset(provider?: ProviderName): void;
}

/** 412. Collect bounded provider latency samples and deterministic percentile summaries. */
export function providerLatencyTracker(options: { now?: () => number; maxSamples?: number } = {}): ProviderLatencyTracker {
  const now = options.now ?? Date.now;
  const maxSamples = options.maxSamples ?? 500;
  if (!Number.isInteger(maxSamples) || maxSamples <= 0) throw new Error('maxSamples must be a positive integer');
  const samples = new Map<ProviderName, number[]>();
  return {
    record(provider, durationMs) {
      requireNonNegative(durationMs, 'durationMs');
      const list = samples.get(provider) ?? [];
      list.push(durationMs);
      if (list.length > maxSamples) list.splice(0, list.length - maxSamples);
      samples.set(provider, list);
    },
    start(provider) {
      const startedAt = now();
      return () => {
        const duration = Math.max(0, now() - startedAt);
        this.record(provider, duration);
        return duration;
      };
    },
    snapshot(provider) {
      const list = [...(samples.get(provider) ?? [])];
      if (list.length === 0) return { count: 0, averageMs: 0 };
      const sorted = [...list].sort((a, b) => a - b);
      const percentile = (fraction: number): number => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
      return {
        count: list.length,
        averageMs: list.reduce((total, value) => total + value, 0) / list.length,
        minMs: sorted[0],
        maxMs: sorted[sorted.length - 1],
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        lastMs: list[list.length - 1],
      };
    },
    reset(provider) {
      if (provider === undefined) samples.clear();
      else samples.delete(provider);
    },
  };
}

export interface ProviderRetryResult<T> {
  provider: ProviderName;
  value: T;
  attempts: number;
}

export class ProviderRetryError extends AggregateError {
  constructor(readonly providers: ProviderName[], errors: unknown[]) {
    super(errors, `All ${providers.length} provider attempt(s) failed`);
    this.name = 'ProviderRetryError';
  }
}

/** 413. Escalate a single injected operation across providers in order; no implicit network or retry delay. */
export async function retryAcrossProviders<T>(
  providers: readonly ProviderName[],
  operation: (provider: ProviderName, attempt: number) => Promise<T>,
  options: { shouldRetry?: (error: unknown, provider: ProviderName) => boolean; onFailure?: (error: unknown, provider: ProviderName) => void } = {}
): Promise<ProviderRetryResult<T>> {
  if (providers.length === 0) throw new Error('at least one provider is required');
  const errors: unknown[] = [];
  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index];
    if (!provider.trim()) throw new Error('provider names must be non-empty');
    try {
      return { provider, value: await operation(provider, index + 1), attempts: index + 1 };
    } catch (error) {
      errors.push(error);
      options.onFailure?.(error, provider);
      if (options.shouldRetry && !options.shouldRetry(error, provider)) throw error;
    }
  }
  throw new ProviderRetryError([...providers], errors);
}

export interface StructuredOutputResult {
  valid: boolean;
  value?: unknown;
  errors: string[];
}

/** 414. Parse JSON and optionally validate it against the project's dependency-free schema subset. */
export function structuredOutputEnforcer(text: string, schema?: Record<string, unknown>): StructuredOutputResult {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    return { valid: false, errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!schema) return { valid: true, value, errors: [] };
  const report = validateToolInput(value, schema);
  return {
    valid: report.valid,
    ...(report.valid ? { value: report.sanitized } : {}),
    errors: report.errors.map(issue => `${issue.path}: ${issue.message}`),
  };
}

export type MultiModalPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string; filename?: string }
  | { type: 'pdf'; mimeType: string; data: string; filename?: string };

export interface MultiModalAdapter {
  text?(part: Extract<MultiModalPart, { type: 'text' }>): unknown;
  image?(part: Extract<MultiModalPart, { type: 'image' }>): unknown;
  pdf?(part: Extract<MultiModalPart, { type: 'pdf' }>): unknown;
}

/** 415. Delegate content conversion to explicit provider adapters; never reads files or invents encodings. */
export function multiModalInputHandler(
  provider: ProviderName,
  parts: readonly MultiModalPart[],
  adapters: Record<ProviderName, MultiModalAdapter | undefined>
): unknown[] {
  const adapter = adapters[provider];
  if (!adapter) throw new Error(`unsupported multimodal provider '${provider}'`);
  return parts.map(part => {
    if (part.type === 'text') {
      if (!adapter.text) throw new Error(`provider '${provider}' has no text content adapter`);
      return adapter.text(part);
    }
    if (!part.data) throw new Error(`${part.type} data must not be empty`);
    if (part.type === 'image' && !part.mimeType.startsWith('image/')) throw new Error('image MIME type must start with image/');
    if (part.type === 'pdf' && part.mimeType !== 'application/pdf') throw new Error('PDF MIME type must be application/pdf');
    const convert = part.type === 'image' ? adapter.image : adapter.pdf;
    if (!convert) throw new Error(`provider '${provider}' does not support ${part.type} input`);
    return convert(part as never);
  });
}

export interface RateLimitObservation {
  limit: number;
  remaining: number;
  resetAt: number;
}

export interface RateLimitStatus extends Partial<RateLimitObservation> {
  limited: boolean;
  retryAfterMs: number;
}

export interface ProviderRateLimitTracker {
  record(provider: ProviderName, observation: RateLimitObservation): void;
  status(provider: ProviderName): RateLimitStatus;
  clear(provider?: ProviderName): void;
}

/** 416. Track caller-observed rate-limit headers and compute bounded retry-after time. */
export function providerRateLimitTracker(options: { now?: () => number } = {}): ProviderRateLimitTracker {
  const now = options.now ?? Date.now;
  const observations = new Map<ProviderName, RateLimitObservation>();
  return {
    record(provider, observation) {
      if (!Number.isFinite(observation.limit) || observation.limit < 0 || !Number.isFinite(observation.remaining) || observation.remaining < 0 || !Number.isFinite(observation.resetAt)) {
        throw new Error('rate-limit values must be finite and non-negative (resetAt is an epoch timestamp)');
      }
      observations.set(provider, { ...observation });
    },
    status(provider) {
      const observation = observations.get(provider);
      if (!observation) return { limited: false, retryAfterMs: 0 };
      const limited = observation.remaining <= 0 && observation.resetAt > now();
      return { ...observation, limited, retryAfterMs: limited ? Math.max(0, observation.resetAt - now()) : 0 };
    },
    clear(provider) {
      if (provider === undefined) observations.clear();
      else observations.delete(provider);
    },
  };
}

/** 417. Resolve a model alias only from explicit pins; already-pinned concrete identifiers pass unchanged. */
export function modelVersionPinner(model: string, pins: Record<string, string>): string {
  if (typeof model !== 'string' || model.trim() === '') throw new Error('model must be a non-empty string');
  if (typeof pins[model] === 'string' && pins[model].trim() !== '') return pins[model];
  if (Object.values(pins).includes(model)) return model;
  throw new Error(`model '${model}' has no explicit version pin`);
}

export type ProviderErrorCategory = 'rate_limit' | 'authentication' | 'invalid_request' | 'server' | 'network' | 'timeout' | 'unknown';

export interface NormalizedProviderError {
  provider: ProviderName;
  category: ProviderErrorCategory;
  retryable: boolean;
  message: string;
  status?: number;
  code?: string;
}

/** 418. Normalize heterogeneous provider error shapes; omit stack and arbitrary response bodies. */
export function providerErrorNormalizer(error: unknown, provider = 'unknown'): NormalizedProviderError {
  const root = asRecord(error);
  const response = asRecord(root?.response);
  const status = finiteNumber(root?.status ?? root?.statusCode ?? response?.status);
  const code = typeof root?.code === 'string' ? root.code : undefined;
  const rawMessage = error instanceof Error ? error.message : typeof root?.message === 'string' ? root.message : String(error);
  // Provider exception messages may quote secrets; scrub common credentials before logging/display.
  const message = rawMessage.replace(/\s+/g, ' ').trim().replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|Bearer\s+[^\s,;]+)/gi, '[REDACTED]').slice(0, 500) || 'Provider request failed';
  const lower = `${code ?? ''} ${message}`.toLowerCase();
  let category: ProviderErrorCategory = 'unknown';
  if (status === 429 || lower.includes('rate limit') || lower.includes('too many requests')) category = 'rate_limit';
  else if (status === 401 || status === 403 || lower.includes('unauthorized') || lower.includes('invalid api key')) category = 'authentication';
  else if (status === 408 || lower.includes('timeout') || lower.includes('timed out')) category = 'timeout';
  else if (status !== undefined && status >= 500 || status === 529) category = 'server';
  else if (status === 400 || status === 404 || status === 422) category = 'invalid_request';
  else if (lower.includes('network') || lower.includes('econn') || lower.includes('connection')) category = 'network';
  const retryable = category === 'rate_limit' || category === 'server' || category === 'network' || category === 'timeout';
  return { provider, category, retryable, message, ...(status === undefined ? {} : { status }), ...(code ? { code } : {}) };
}

export interface CostEstimate extends ProviderCost {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

/** 419. Estimate a prompt before a call with an explicit 4 non-whitespace chars/token assumption. */
export function costEstimateBeforeCall(
  provider: ProviderName,
  model: string,
  inputText: string,
  outputTokens: number,
  rates: TokenRates
): CostEstimate {
  requireNonNegative(outputTokens, 'outputTokens');
  const meaningfulCharacters = inputText.replace(/\s/g, '').length;
  const estimatedInputTokens = meaningfulCharacters === 0 ? 0 : Math.max(1, Math.ceil(meaningfulCharacters / 4));
  const cost = costPerProviderCalculator(provider, model, { inputTokens: estimatedInputTokens, outputTokens }, rates);
  return {
    ...cost,
    estimatedInputTokens,
    estimatedOutputTokens: outputTokens,
    assumptions: [
      'Input token estimate assumes 4 non-whitespace characters per token; this is a rough estimate, not a provider tokenizer result.',
      `Output is budgeted at exactly ${outputTokens} tokens; actual generation may use fewer.`,
      ...cost.assumptions,
    ],
  };
}

export interface ProviderBenchmarkInput {
  provider: ProviderName;
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  success?: boolean;
  prompt?: string;
  [key: string]: unknown;
}

export interface ProviderBenchmarkRecord {
  provider: ProviderName;
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  success: boolean;
  recordedAt: number;
}

export interface ProviderBenchmarkLogger {
  record(input: ProviderBenchmarkInput): ProviderBenchmarkRecord;
  list(): ProviderBenchmarkRecord[];
  clear(): void;
}

/** 420. Keep bounded outcome/latency/token metrics; never persist prompts or arbitrary input properties. */
export function providerBenchmarkLogger(options: {
  now?: () => number;
  maxRecords?: number;
  sink?: (record: ProviderBenchmarkRecord) => void;
} = {}): ProviderBenchmarkLogger {
  const now = options.now ?? Date.now;
  const maxRecords = options.maxRecords ?? 1_000;
  if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new Error('maxRecords must be a positive integer');
  const records: ProviderBenchmarkRecord[] = [];
  return {
    record(input) {
      if (!input.provider.trim() || !input.model.trim()) throw new Error('provider and model must be non-empty');
      requireNonNegative(input.latencyMs, 'latencyMs');
      if (input.inputTokens !== undefined) requireNonNegative(input.inputTokens, 'inputTokens');
      if (input.outputTokens !== undefined) requireNonNegative(input.outputTokens, 'outputTokens');
      const record: ProviderBenchmarkRecord = {
        provider: input.provider,
        model: input.model,
        latencyMs: input.latencyMs,
        ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
        ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
        success: input.success ?? true,
        recordedAt: now(),
      };
      records.push(record);
      if (records.length > maxRecords) records.splice(0, records.length - maxRecords);
      try { options.sink?.({ ...record }); } catch { /* diagnostic sinks must not break a model call */ }
      return { ...record };
    },
    list() { return records.map(record => ({ ...record })); },
    clear() { records.length = 0; },
  };
}
