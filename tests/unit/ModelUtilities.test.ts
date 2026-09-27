import {
  apiKeyRotator,
  contextWindowLimitPerProvider,
  costEstimateBeforeCall,
  costPerProviderCalculator,
  modelFallbackChain,
  modelRouterByComplexity,
  modelVersionPinner,
  multiModalInputHandler,
  providerAdapter,
  providerBenchmarkLogger,
  providerErrorNormalizer,
  providerHealthCheck,
  providerLatencyTracker,
  providerRateLimitTracker,
  responseFormatNormalizer,
  retryAcrossProviders,
  streamResponseParser,
  structuredOutputEnforcer,
  temperatureConfigPerTask,
  toolCallParser,
} from '../../src/utils/ModelUtilities.js';
import type { Session } from '../../src/types/index.js';

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

describe('ModelUtilities (401-420)', () => {
  it('providerAdapter normalizes provider responses from an injected transport', async () => {
    const calls: unknown[] = [];
    const adapter = providerAdapter('anthropic', {
      chat: async request => {
        calls.push(request);
        return {
          content: [{ type: 'text', text: 'hello' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 4, output_tokens: 2 },
        };
      },
    }, { model: 'claude-test', mapRequest: (_request, provider, model) => ({ provider, model, mapped: true }) });

    await expect(adapter.chat({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toMatchObject({
      content: 'hello',
      finishReason: 'stop',
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    });
    expect(calls).toEqual([{ provider: 'anthropic', model: 'claude-test', mapped: true }]);
  });

  it('modelRouterByComplexity selects configured tiers at boundaries', () => {
    const models = { low: 'fast', medium: 'balanced', high: 'reasoner' };
    expect(modelRouterByComplexity(0.2, models)).toBe('fast');
    expect(modelRouterByComplexity(0.5, models)).toBe('balanced');
    expect(modelRouterByComplexity(0.9, models)).toBe('reasoner');
  });

  it('modelFallbackChain tries configured models in order and returns the winner', async () => {
    const tried: string[] = [];
    const result = await modelFallbackChain(['primary', 'backup'], async model => {
      tried.push(model);
      if (model === 'primary') throw new Error('unavailable');
      return 'answer';
    });
    expect(tried).toEqual(['primary', 'backup']);
    expect(result).toEqual({ model: 'backup', value: 'answer', attempts: 2 });
  });

  it('streamResponseParser turns Anthropic text delta events into normalized chunks', async () => {
    const chunks = await collect(streamResponseParser('anthropic', [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
      { type: 'message_stop' },
    ]));
    expect(chunks).toEqual([{ delta: 'hello' }]);
  });

  it('streamResponseParser assembles Anthropic partial tool JSON without retaining the empty start object', async () => {
    const chunks = await collect(streamResponseParser('anthropic', [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{\"path\":\"file.txt\"}' } },
      { type: 'content_block_stop', index: 0 },
    ]));
    expect(chunks).toEqual([{ delta: '', toolCalls: [{ id: 'tool-1', name: 'read_file', input: { path: 'file.txt' } }] }]);
  });

  it('streamResponseParser handles OpenAI text and tool deltas without fabricated transport calls', async () => {
    const chunks = await collect(streamResponseParser('openai', [
      { choices: [{ delta: { content: 'hi', tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]));
    expect(chunks).toEqual([
      { delta: 'hi' },
      { delta: '', toolCalls: [{ id: 'call-1', name: 'read_file', input: { path: 'a.txt' } }] },
    ]);
  });

  it('toolCallParser normalizes Anthropic and OpenAI tool-call payloads', () => {
    expect(toolCallParser('anthropic', {
      content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } }],
    })).toEqual([{ id: 't1', name: 'read_file', input: { path: 'a' } }]);
    expect(toolCallParser('openai', {
      choices: [{ message: { tool_calls: [{ id: 't2', type: 'function', function: { name: 'write_file', arguments: '{"path":"b"}' } }] } }],
    })).toEqual([{ id: 't2', name: 'write_file', input: { path: 'b' } }]);
  });

  it('apiKeyRotator round-robins keys and skips a key during its cooldown', () => {
    let now = 100;
    const rotator = apiKeyRotator(['key-a', 'key-b'], { now: () => now, cooldownMs: 50 });
    expect(rotator.next()).toBe('key-a');
    expect(rotator.next()).toBe('key-b');
    expect(rotator.next()).toBe('key-a');
    rotator.markFailed('key-a');
    expect(rotator.next()).toBe('key-b');
    expect(rotator.next()).toBe('key-b');
    now = 151;
    expect(rotator.next()).toBe('key-a');
  });

  it('costPerProviderCalculator uses only caller-supplied rates and reports its formula', () => {
    expect(costPerProviderCalculator('openai', 'model-x', { inputTokens: 1_000_000, outputTokens: 500_000 }, {
      currency: 'USD', inputPerMillionTokens: 2, outputPerMillionTokens: 4,
    })).toMatchObject({ provider: 'openai', model: 'model-x', currency: 'USD', cost: 4, assumptions: expect.any(Array) });
  });

  it('providerHealthCheck runs injected checks and reports failures without throwing', async () => {
    const report = await providerHealthCheck({
      ready: async () => true,
      unavailable: async () => { throw new Error('offline'); },
    }, { timeoutMs: 100 });
    expect(report.checks.ready.status).toBe('healthy');
    expect(report.checks.unavailable.status).toBe('unhealthy');
    expect(report.overall).toBe('unhealthy');
  });

  it('responseFormatNormalizer maps provider JSON modes to one format', () => {
    expect(responseFormatNormalizer({ type: 'json_object' })).toEqual({ type: 'json' });
    expect(responseFormatNormalizer({ type: 'json_schema', json_schema: { name: 'result', schema: { type: 'object' } } })).toEqual({
      type: 'json_schema', name: 'result', schema: { type: 'object' },
    });
    expect(responseFormatNormalizer({ responseMimeType: 'application/json' })).toEqual({ type: 'json' });
  });

  it('temperatureConfigPerTask uses a task override and a validated fallback', () => {
    expect(temperatureConfigPerTask('coding', { defaultTemperature: 0.7, perTask: { coding: 0.1 } })).toBe(0.1);
    expect(temperatureConfigPerTask('unknown', { defaultTemperature: 0.6 })).toBe(0.6);
  });

  it('contextWindowLimitPerProvider looks up explicitly supplied limits without inventing defaults', () => {
    expect(contextWindowLimitPerProvider('openai', 'model-x', { openai: { 'model-x': 128000, default: 64000 } })).toBe(128000);
    expect(contextWindowLimitPerProvider('other', 'model-y', {})).toBeUndefined();
  });

  it('providerLatencyTracker summarizes samples by provider', () => {
    let now = 1000;
    const tracker = providerLatencyTracker({ now: () => now });
    tracker.record('openai', 20);
    now += 1;
    tracker.record('openai', 40);
    expect(tracker.snapshot('openai')).toMatchObject({ count: 2, averageMs: 30, p95Ms: 40 });
    expect(tracker.snapshot('unknown').count).toBe(0);
  });

  it('retryAcrossProviders retries a failed call on the next injected provider', async () => {
    const result = await retryAcrossProviders(['first', 'second'], async provider => {
      if (provider === 'first') throw new Error('down');
      return 'ok';
    });
    expect(result).toEqual({ provider: 'second', value: 'ok', attempts: 2 });
  });

  it('structuredOutputEnforcer parses JSON and enforces declared required fields', () => {
    expect(structuredOutputEnforcer('{"ok":true}', {
      type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } },
    })).toEqual({ valid: true, value: { ok: true }, errors: [] });
    expect(structuredOutputEnforcer('{bad json}').valid).toBe(false);
    expect(structuredOutputEnforcer('{}', { type: 'object', required: ['ok'] }).errors).toHaveLength(1);
  });

  it('multiModalInputHandler delegates image conversion to an explicit provider adapter', () => {
    const result = multiModalInputHandler('test', [
      { type: 'text', text: 'describe' },
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
    ], {
      test: {
        text: part => ({ text: part.text }),
        image: part => ({ imageData: part.data, mimeType: part.mimeType }),
      },
    });
    expect(result).toEqual([{ text: 'describe' }, { imageData: 'aGVsbG8=', mimeType: 'image/png' }]);
    expect(() => multiModalInputHandler('unknown', [{ type: 'pdf', mimeType: 'application/pdf', data: 'eA==' }], {})).toThrow(/unsupported/i);
  });

  it('providerRateLimitTracker calculates retry delay from the recorded reset time', () => {
    let now = 1_000;
    const tracker = providerRateLimitTracker({ now: () => now });
    tracker.record('openai', { limit: 10, remaining: 0, resetAt: 1_500 });
    expect(tracker.status('openai')).toMatchObject({ limited: true, retryAfterMs: 500 });
    now = 1_600;
    expect(tracker.status('openai').limited).toBe(false);
  });

  it('modelVersionPinner resolves aliases only through explicit pinned versions', () => {
    expect(modelVersionPinner('latest', { latest: 'model-2025-01-01' })).toBe('model-2025-01-01');
    expect(modelVersionPinner('model-locked', { locked: 'model-locked' })).toBe('model-locked');
    expect(() => modelVersionPinner('unknown', {})).toThrow(/pin/i);
  });

  it('providerErrorNormalizer classifies rate limits as retryable and redacts credentials', () => {
    expect(providerErrorNormalizer({ status: 429, message: 'slow down token Bearer private-token', stack: 'secret stack' })).toMatchObject({
      category: 'rate_limit', retryable: true, status: 429, message: 'slow down token [REDACTED]',
    });
    expect(providerErrorNormalizer({ status: 500, message: 'bad key sk-1234567890abcdef' }).message).not.toContain('sk-1234567890abcdef');
  });

  it('costEstimateBeforeCall states the tokenization assumption and estimates from text', () => {
    const estimate = costEstimateBeforeCall('openai', 'model-x', '12345678', 100, {
      currency: 'USD', inputPerMillionTokens: 1, outputPerMillionTokens: 2,
    });
    expect(estimate).toMatchObject({ estimatedInputTokens: 2, outputTokens: 100, currency: 'USD' });
    expect(estimate.assumptions.join(' ')).toMatch(/4 non-whitespace characters per token/i);
  });

  it('providerBenchmarkLogger records aggregate metrics but does not retain prompts', () => {
    let now = 1_000;
    const stored: unknown[] = [];
    const logger = providerBenchmarkLogger({ now: () => now, sink: record => stored.push(record) });
    const record = logger.record({ provider: 'openai', model: 'model-x', latencyMs: 80, inputTokens: 10, outputTokens: 5, prompt: 'private' });
    expect(record).toMatchObject({ provider: 'openai', model: 'model-x', recordedAt: 1_000 });
    expect(record).not.toHaveProperty('prompt');
    now += 1;
    expect(logger.list()).toHaveLength(1);
    expect(stored).toHaveLength(1);
  });
});
