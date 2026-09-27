import { createHmac } from 'crypto';

export interface HttpRequest {
  url: string | URL;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body?: T;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export interface HttpRetryOptions {
  transport: HttpTransport;
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Retry idempotent/transient requests via an injected transport; performs no network I/O itself. */
export async function httpRequestWithRetry<T = unknown>(
  request: HttpRequest,
  options: HttpRetryOptions
): Promise<HttpResponse<T>> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }
  const method = (request.method ?? 'GET').toUpperCase();
  const retryable = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(method) ||
    Boolean(request.headers?.['idempotency-key'] ?? request.headers?.['Idempotency-Key']);
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 100);

  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = (await options.transport(request)) as HttpResponse<T>;
      if (attempt >= maxAttempts || !retryable || !httpErrorRetryClassifier(response.status)) {
        return response;
      }
    } catch (error) {
      if (attempt >= maxAttempts || !retryable) throw error;
    }
    await sleep(baseDelayMs * 2 ** (attempt - 1));
  }
}

export interface RequestSigningOptions {
  keyId: string;
  secret: string;
  timestamp?: string | number;
}

/** Sign method, URL, timestamp, and body with HMAC-SHA256; never transmits credentials. */
export function httpRequestSigner(
  request: HttpRequest,
  options: RequestSigningOptions
): HttpRequest {
  if (!options.keyId || !options.secret) throw new Error('keyId and secret are required');
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const url = new URL(request.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) requests can be signed');
  const body = request.body === undefined
    ? ''
    : typeof request.body === 'string' || Buffer.isBuffer(request.body)
      ? String(request.body)
      : JSON.stringify(request.body);
  const canonical = [
    (request.method ?? 'GET').toUpperCase(),
    url.toString(),
    timestamp,
    body,
  ].join('\n');
  const signature = createHmac('sha256', options.secret).update(canonical).digest('hex');
  const headers = { ...(request.headers ?? {}), authorization: `HMAC ${options.keyId}:${signature}`, 'x-request-timestamp': timestamp };
  return { ...request, headers };
}

export interface ApiValidationRule {
  statuses?: number[];
  requiredHeaders?: string[];
  body?: { type?: string; required?: string[] };
}

/** Validate response metadata and a small, dependency-free body contract. */
export function apiResponseValidator(response: HttpResponse, rule: ApiValidationRule): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (rule.statuses && !rule.statuses.includes(response.status)) errors.push(`Unexpected status ${response.status}`);
  const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]));
  for (const header of rule.requiredHeaders ?? []) if (!(header.toLowerCase() in headers)) errors.push(`Missing header ${header}`);
  if (rule.body?.type === 'object' && (typeof response.body !== 'object' || response.body === null || Array.isArray(response.body))) errors.push('Body must be an object');
  if (rule.body?.required && typeof response.body === 'object' && response.body !== null) {
    for (const field of rule.body.required) if (!(field in (response.body as Record<string, unknown>))) errors.push(`Missing body field ${field}`);
  }
  return { valid: errors.length === 0, errors };
}

export interface PaginationResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  nextOffset?: number;
}

/** Paginate an in-memory result without mutating the source. */
export function paginationHandler<T>(items: readonly T[], options: { limit: number; offset?: number }): PaginationResult<T> {
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('limit must be a positive integer');
  const offset = options.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
  const page = items.slice(offset, offset + options.limit);
  return { items: page, total: items.length, limit: options.limit, offset, ...(offset + page.length < items.length ? { nextOffset: offset + page.length } : {}) };
}

/** Select the greatest exact version supported by both sides using numeric dotted components. */
export function apiVersionNegotiator(clientVersions: string[], serverVersions: string[]): string | undefined {
  const server = new Set(serverVersions);
  return [...new Set(clientVersions)].filter(version => server.has(version)).sort((a, b) => compareVersions(b, a))[0];
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export interface CachePolicy {
  cacheable: boolean;
  noStore: boolean;
  maxAgeSeconds?: number;
  expiresAt?: number;
}

/** Interpret cache-control/expires without caching response bodies or performing I/O. */
export function httpCacheHeaderRespecter(headers: Record<string, string>, nowMs = Date.now()): CachePolicy {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const cacheControl = normalized['cache-control'] ?? '';
  const noStore = /(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl);
  const maxAgeMatch = cacheControl.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/i);
  const maxAgeSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : undefined;
  const expires = normalized.expires ? Date.parse(normalized.expires) : NaN;
  const expiresAt = maxAgeSeconds !== undefined ? nowMs + maxAgeSeconds * 1000 : Number.isFinite(expires) ? expires : undefined;
  return { cacheable: !noStore && (maxAgeSeconds !== undefined || Number.isFinite(expires)), noStore, ...(maxAgeSeconds !== undefined ? { maxAgeSeconds } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) };
}

export interface CorsConfig {
  origins: string[];
  credentials?: boolean;
}

/** Validate CORS origin syntax and prevent wildcard credential exposure. */
export function corsConfigValidator(config: CorsConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(config.origins) || config.origins.length === 0) errors.push('At least one origin is required');
  for (const origin of config.origins ?? []) {
    if (origin !== '*') {
      try { const parsed = new URL(origin); if (!['http:', 'https:'].includes(parsed.protocol)) errors.push(`Invalid origin ${origin}`); }
      catch { errors.push(`Invalid origin ${origin}`); }
    }
  }
  if (config.credentials === true && config.origins?.includes('*')) errors.push('Wildcard origin cannot be used with credentials');
  return { valid: errors.length === 0, errors };
}

/** Parse and classify an URL host for SSRF protection; DNS resolution remains the caller's responsibility. */
export function internalIPBlocklist(value: string): { blocked: boolean; reason?: string } {
  let url: URL;
  try { url = new URL(value); } catch { return { blocked: true, reason: 'Invalid URL' }; }
  if (!['http:', 'https:'].includes(url.protocol)) return { blocked: true, reason: 'Only HTTP(S) is allowed' };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host.endsWith('.internal')) return { blocked: true, reason: 'Local or internal hostname' };
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (match) {
    const octets = match.slice(1).map(Number);
    const [a, b] = octets;
    if (octets.some(valuePart => valuePart > 255) || a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return { blocked: true, reason: 'Private or invalid IPv4 address' };
  }
  return { blocked: false };
}

export interface GraphqlQueryOptions {
  operation: 'query' | 'mutation';
  name: string;
  fields: string[];
  variables?: Record<string, unknown>;
}

/** Build a constrained GraphQL operation; field/name tokens are validated to prevent injection. */
export function graphqlQueryBuilder(options: GraphqlQueryOptions): { query: string; variables: Record<string, unknown> } {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.name) || options.fields.some(field => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field))) throw new Error('GraphQL names must be identifiers');
  const variables = options.variables ?? {};
  const definitions = Object.keys(variables).map(key => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('GraphQL variable names must be identifiers');
    return `$${key}: ${graphqlTypeOf(variables[key])}!`;
  });
  const argumentsText = Object.keys(variables).map(key => `${key}: $${key}`).join(', ');
  return { query: `${options.operation} ${options.name}(${definitions.join(', ')}) { ${options.name}${argumentsText ? `(${argumentsText})` : ''} { ${options.fields.join(' ')} } }`, variables };
}

function graphqlTypeOf(value: unknown): string {
  if (typeof value === 'boolean') return 'Boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Int' : 'Float';
  return 'String';
}


export interface WebhookDispatchInput {
  url: string;
  payload: unknown;
  headers?: Record<string, string>;
}

/** Deliver a webhook through an injected HTTP transport; does not make network calls itself. */
export async function webhookDispatcher(input: WebhookDispatchInput, options: { transport: HttpTransport }): Promise<{ delivered: boolean; status: number; response: HttpResponse }> {
  const response = await options.transport({ url: input.url, method: 'POST', headers: { 'content-type': 'application/json', ...(input.headers ?? {}) }, body: input.payload });
  return { delivered: response.status >= 200 && response.status < 300, status: response.status, response };
}

export interface WebSocketTransport {
  connect: () => Promise<{ send: (message: string) => void; close: () => void }>;
}

/** Manage websocket lifecycle through an injected transport; no protocol implementation or socket is assumed. */
export function websocketConnectionManager(transport: WebSocketTransport): { connect: () => Promise<void>; send: (message: string) => void; close: () => void } {
  let socket: { send: (message: string) => void; close: () => void } | undefined;
  return {
    connect: async () => { if (!socket) socket = await transport.connect(); },
    send: message => { if (!socket) throw new Error('Websocket is not connected'); socket.send(message); },
    close: () => { socket?.close(); socket = undefined; },
  };
}

export interface RequestLogEntry {
  url: string;
  method: string;
  headers: Record<string, string>;
  status: number;
}

/** Log request metadata with credential headers redacted before invoking the injected handler. */
export async function requestLoggerMiddleware(request: HttpRequest, next: HttpTransport, logger: (entry: RequestLogEntry) => void): Promise<HttpResponse> {
  const response = await next(request);
  const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([key, value]) => [/^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(key) ? key : key, /^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(key) ? '[REDACTED]' : value]));
  logger({ url: String(request.url), method: (request.method ?? 'GET').toUpperCase(), headers, status: response.status });
  return response;
}

export interface ApiDocFetcherOptions {
  fetcher: (url: string) => Promise<string>;
  maxChars?: number;
}

/** Fetch docs only through a caller-supplied adapter, with an explicit output bound. */
export async function apiDocFetcher(url: string, options: ApiDocFetcherOptions): Promise<{ url: string; content: string }> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) documentation URLs are allowed');
  const maxChars = options.maxChars ?? 6000;
  if (!Number.isInteger(maxChars) || maxChars < 0) throw new Error('maxChars must be a non-negative integer');
  const content = await options.fetcher(parsed.toString());
  return { url: parsed.toString(), content: content.slice(0, maxChars) };
}

export interface MockServerRoute {
  method: string;
  path: string;
  response: HttpResponse;
}

/** Create an in-memory transport for tests; it binds no sockets and performs no I/O. */
export function mockServerForTesting(routes: MockServerRoute[]): { transport: HttpTransport; close: () => void } {
  let closed = false;
  const transport: HttpTransport = async request => {
    if (closed) throw new Error('Mock server is closed');
    const url = new URL(request.url);
    const route = routes.find(candidate => candidate.method.toUpperCase() === (request.method ?? 'GET').toUpperCase() && candidate.path === url.pathname);
    return route?.response ?? { status: 404, headers: {}, body: { error: 'Not found' } };
  };
  return { transport, close: () => { closed = true; } };
}

export interface RateLimitFetchOptions extends HttpRetryOptions {
  maxAttempts?: number;
}

/** Retry a request after server-provided Retry-After seconds, using only injected transport/sleep. */
export async function rateLimitAwareFetch<T = unknown>(request: HttpRequest, options: RateLimitFetchOptions): Promise<HttpResponse<T>> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer');
  const method = (request.method ?? 'GET').toUpperCase();
  const retryable = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(method) || Boolean(request.headers?.['idempotency-key'] ?? request.headers?.['Idempotency-Key']);
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    const response = await options.transport(request) as HttpResponse<T>;
    if (!retryable || attempt >= maxAttempts || !httpErrorRetryClassifier(response.status)) return response;
    const rawRetryAfter = response.headers['retry-after'] ?? response.headers['Retry-After'];
    const seconds = Number(rawRetryAfter);
    const dateDelay = rawRetryAfter && !Number.isFinite(seconds) ? Date.parse(rawRetryAfter) - Date.now() : NaN;
    const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Number.isFinite(dateDelay) && dateDelay >= 0 ? dateDelay : (options.baseDelayMs ?? 100) * 2 ** (attempt - 1);
    await sleep(delay);
  }
}

/** Deduplicate concurrent calls by stable JSON arguments; completed calls are not cached. */
export function requestDeduplication<A extends unknown[], R>(operation: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  const pending = new Map<string, Promise<R>>();
  return (...args: A): Promise<R> => {
    const key = JSON.stringify(args);
    const existing = pending.get(key);
    if (existing) return existing;
    const result = operation(...args);
    pending.set(key, result);
    void result.finally(() => pending.delete(key)).catch(() => undefined);
    return result;
  };
}

export interface CertificateFacts {
  validFrom: string | number;
  validTo: string | number;
  subjectAltNames: string[];
}

/** Validate injected certificate facts; does not fetch certificates or disable TLS verification. */
export function sslCertValidator(certificate: CertificateFacts, hostname: string, nowMs = Date.now()): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const from = typeof certificate.validFrom === 'number' ? certificate.validFrom : Date.parse(certificate.validFrom);
  const to = typeof certificate.validTo === 'number' ? certificate.validTo : Date.parse(certificate.validTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || nowMs < from || nowMs > to) errors.push('Certificate is outside its validity period');
  const matches = certificate.subjectAltNames.some(name => name.toLowerCase() === hostname.toLowerCase() || (name.startsWith('*.') && hostname.toLowerCase().endsWith(name.slice(1).toLowerCase())));
  if (!matches) errors.push('Hostname is not present in subject alternative names');
  return { valid: errors.length === 0, errors };
}

/** Parse proxy configuration without accepting credentials or private proxy hosts by default. */
export function proxyConfigLoader(value: string, allowlistedHosts: string[] = []): { valid: boolean; url?: URL; error?: string } {
  let url: URL;
  try { url = new URL(value); } catch { return { valid: false, error: 'Invalid proxy URL' }; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return { valid: false, error: 'Proxy must be HTTP(S) without embedded credentials' };
  if (!allowlistedHosts.includes(url.hostname)) return { valid: false, error: 'Proxy host is not allowlisted' };
  return { valid: true, url };
}

export interface TimeoutConfig {
  signal: AbortSignal;
  dispose: () => void;
}

/** Create a timeout signal with explicit timer cleanup. */
export function httpTimeoutConfig(timeoutMs: number): TimeoutConfig {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

/** Classify HTTP status codes commonly safe to retry after transient failures. */
export function httpErrorRetryClassifier(error: number | { status?: number }): boolean {
  const status = typeof error === 'number' ? error : error.status;
  return status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500 && status <= 599);
}
