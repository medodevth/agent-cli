import {
  apiResponseValidator,
  apiVersionNegotiator,
  corsConfigValidator,
  graphqlQueryBuilder,
  httpCacheHeaderRespecter,
  apiDocFetcher,
  httpRequestSigner,
  httpRequestWithRetry,
  httpTimeoutConfig,
  internalIPBlocklist,
  requestLoggerMiddleware,
  webhookDispatcher,
  websocketConnectionManager,
  mockServerForTesting,
  paginationHandler,
  rateLimitAwareFetch,
  requestDeduplication,
  sslCertValidator,
  proxyConfigLoader,
} from '../../src/utils/HttpUtilities.js';

describe('webhookDispatcher (324)', () => {
  it('dispatches only through an injected transport and returns delivery details', async () => {
    await expect(webhookDispatcher({ url: 'https://hooks.example.test', payload: { event: 'created' } }, {
      transport: async request => ({ status: 202, headers: {}, body: request.body }),
    })).resolves.toMatchObject({ delivered: true, status: 202 });
  });
});

describe('websocketConnectionManager (336)', () => {
  it('tracks lifecycle through an injected websocket transport', async () => {
    const events: string[] = [];
    const manager = websocketConnectionManager({
      connect: async () => ({ send: (message: string) => events.push(`send:${message}`), close: () => events.push('close') }),
    });
    await manager.connect();
    manager.send('hello');
    manager.close();
    expect(events).toEqual(['send:hello', 'close']);
  });
});

describe('requestLoggerMiddleware (340)', () => {
  it('redacts sensitive headers before passing a request to the logger', async () => {
    const entries: Array<Record<string, unknown>> = [];
    await requestLoggerMiddleware({ url: 'https://api.example.test', headers: { authorization: 'secret', accept: 'json' } }, async () => ({ status: 200, headers: {} }), entry => entries.push(entry as unknown as Record<string, unknown>));
    expect(entries[0].headers).toEqual({ authorization: '[REDACTED]', accept: 'json' });
  });
});

describe('apiDocFetcher (334)', () => {
  it('fetches and bounds injected documentation content without opening a URL itself', async () => {
    await expect(apiDocFetcher('https://docs.example.test/api', {
      fetcher: async url => `# API for ${url}`,
      maxChars: 10,
    })).resolves.toEqual({ url: 'https://docs.example.test/api', content: '# API for ' });
  });
});

describe('mockServerForTesting (333)', () => {
  it('matches injected routes and returns 404 for unregistered requests', async () => {
    const server = mockServerForTesting([{ method: 'GET', path: '/health', response: { status: 200, headers: {}, body: 'ok' } }]);
    await expect(server.transport({ url: 'https://test.local/health', method: 'GET' })).resolves.toMatchObject({ status: 200, body: 'ok' });
    await expect(server.transport({ url: 'https://test.local/missing', method: 'GET' })).resolves.toMatchObject({ status: 404 });
    server.close();
  });
});

describe('httpTimeoutConfig (326)', () => {
  it('produces validated per-request timeout abort signals', () => {
    const timeout = httpTimeoutConfig(25);
    expect(timeout.signal.aborted).toBe(false);
    expect(() => httpTimeoutConfig(-1)).toThrow(/positive/i);
    timeout.dispose();
  });
});

describe('httpRequestSigner (322)', () => {
  it('creates a stable HMAC authorization header without sending the request', () => {
    const signed = httpRequestSigner(
      { url: 'https://api.example.test/v1', method: 'post', body: { ok: true } },
      { keyId: 'client-a', secret: 'test-secret', timestamp: '1700000000' }
    );
    expect(signed.headers?.authorization).toMatch(/^HMAC client-a:[a-f0-9]{64}$/);
    expect(signed.headers?.['x-request-timestamp']).toBe('1700000000');
  });
});

describe('apiResponseValidator (325)', () => {
  it('validates success status, required headers, and body shape', () => {
    expect(apiResponseValidator(
      { status: 200, headers: { 'content-type': 'application/json' }, body: { id: 1 } },
      { statuses: [200], requiredHeaders: ['content-type'], body: { type: 'object', required: ['id'] } }
    ).valid).toBe(true);
    expect(apiResponseValidator({ status: 500, headers: {}, body: null }, { statuses: [200] }).valid).toBe(false);
  });
});

describe('paginationHandler (331)', () => {
  it('slices data safely and reports a next offset', () => {
    expect(paginationHandler([1, 2, 3, 4], { limit: 2, offset: 1 })).toEqual({
      items: [2, 3], total: 4, limit: 2, offset: 1, nextOffset: 3,
    });
  });
});

describe('apiVersionNegotiator (330)', () => {
  it('chooses the highest mutually supported semantic version', () => {
    expect(apiVersionNegotiator(['1.2', '2.0', '1.10'], ['1.2', '1.10'])).toBe('1.10');
  });
});

describe('httpCacheHeaderRespecter (337)', () => {
  it('uses cache-control and expires headers to derive freshness', () => {
    expect(httpCacheHeaderRespecter({ 'cache-control': 'public, max-age=60' }, 1000)).toEqual({
      cacheable: true, maxAgeSeconds: 60, expiresAt: 61000, noStore: false,
    });
    expect(httpCacheHeaderRespecter({ 'cache-control': 'no-store' }, 1000).cacheable).toBe(false);
  });
});

describe('corsConfigValidator (338)', () => {
  it('rejects wildcard origins combined with credentials', () => {
    expect(corsConfigValidator({ origins: ['*'], credentials: true }).valid).toBe(false);
    expect(corsConfigValidator({ origins: ['https://example.test'], credentials: true }).valid).toBe(true);
  });
});

describe('internalIPBlocklist (339)', () => {
  it('blocks private IPv4 and localhost while allowing a public hostname', () => {
    expect(internalIPBlocklist('http://10.1.2.3/x').blocked).toBe(true);
    expect(internalIPBlocklist('https://example.com').blocked).toBe(false);
  });
});

describe('graphqlQueryBuilder (335)', () => {
  it('builds a query and encodes variables separately', () => {
    expect(graphqlQueryBuilder({ operation: 'query', name: 'GetItem', fields: ['id', 'name'], variables: { id: 'x' } }))
      .toEqual({ query: 'query GetItem($id: String!) { GetItem(id: $id) { id name } }', variables: { id: 'x' } });
  });
});

describe('rateLimitAwareFetch (323)', () => {
  it('waits for Retry-After before retrying 429 through injected transport', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const result = await rateLimitAwareFetch(
      { url: 'https://api.example.test', method: 'GET' },
      {
        transport: async () => ++attempts === 1
          ? { status: 429, headers: { 'retry-after': '2' } }
          : { status: 200, headers: {} },
        sleep: async delay => { delays.push(delay); },
        maxAttempts: 2,
      }
    );
    expect(result.status).toBe(200);
    expect(delays).toEqual([2000]);
  });
});

describe('requestDeduplication (329)', () => {
  it('coalesces concurrent identical calls and forgets completed results', async () => {
    let calls = 0;
    const dedupe = requestDeduplication(async (value: string) => { calls += 1; await Promise.resolve(); return value; });
    await expect(Promise.all([dedupe('same'), dedupe('same')])).resolves.toEqual(['same', 'same']);
    await dedupe('same');
    expect(calls).toBe(2);
  });
});

describe('sslCertValidator (327)', () => {
  it('validates certificate dates and hostnames using supplied certificate facts', () => {
    expect(sslCertValidator({ validFrom: '2024-01-01', validTo: '2030-01-01', subjectAltNames: ['api.example.test'] }, 'api.example.test', Date.parse('2026-01-01')).valid).toBe(true);
    expect(sslCertValidator({ validFrom: '2024-01-01', validTo: '2025-01-01', subjectAltNames: ['api.example.test'] }, 'api.example.test', Date.parse('2026-01-01')).valid).toBe(false);
  });
});

describe('proxyConfigLoader (328)', () => {
  it('accepts only explicitly allowlisted proxy origins', () => {
    expect(proxyConfigLoader('https://proxy.example.test:8443', ['proxy.example.test']).valid).toBe(true);
    expect(proxyConfigLoader('http://127.0.0.1:8080', ['proxy.example.test']).valid).toBe(false);
  });
});

describe('httpRequestWithRetry (321)', () => {
  it('retries transient failures through an injected transport only', async () => {
    const attempts: number[] = [];
    const result = await httpRequestWithRetry(
      { url: 'https://api.example.test/items', method: 'GET' },
      {
        transport: async () => {
          attempts.push(attempts.length + 1);
          return attempts.length === 1
            ? { status: 503, headers: {} }
            : { status: 200, body: ['item'], headers: {} };
        },
        maxAttempts: 2,
        sleep: async () => undefined,
      }
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual(['item']);
    expect(attempts).toEqual([1, 2]);
  });
});
