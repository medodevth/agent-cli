import express, { NextFunction, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { randomUUID, timingSafeEqual } from 'crypto';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { Agent } from './agent/Agent.js';
import { createProvider } from './createAgent.js';
import { createDefaultToolRegistry } from './tools/index.js';
import { Action, PermissionManager, PermissionResult, Config, ContentBlock } from './types/index.js';
import { ExtensionManager, ExtensionKind, isExtensionError } from './extensions/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.AGENT_SERVER_HOST || '127.0.0.1';
const API_KEY = process.env.AGENT_SERVER_API_KEY;
const RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.AGENT_SERVER_RATE_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX = Number.parseInt(process.env.AGENT_SERVER_RATE_MAX || '30', 10);
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const ALLOWED_ORIGINS = process.env.AGENT_SERVER_ORIGIN?.split(',').map(origin => origin.trim()).filter(Boolean);

app.use(cors(ALLOWED_ORIGINS ? { origin: ALLOWED_ORIGINS } : { origin: false }));
// Attachments travel in the request body as base64, so the JSON limit has to sit
// comfortably above the per-request attachment budget (see MAX_ATTACHMENT_BYTES).
app.use(express.json({ limit: '12mb' }));

// Baseline security headers, registered before the static handler so documents
// (not just API responses) actually receive them. The API keeps a locked-down
// policy; the web UI is a single self-contained document (inline style/script)
// served from this origin, so it needs a policy that lets those assets run.
const STRICT_CSP = "default-src 'none'; frame-ancestors 'none'";
const UI_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const isHtml = req.path === '/' || req.path.endsWith('.html');
  res.setHeader('Content-Security-Policy', isHtml ? UI_CSP : STRICT_CSP);
  next();
});

// Serve the web UI from <repo root>/public. Compiled output lives in dist/ and
// the sources in src/, so exactly one level up is the project root in both cases.
app.use(express.static(path.join(__dirname, '..', 'public')));
// Bare root opens the UI instead of 404.
app.get('/', (_req: Request, res: Response) => { res.redirect('/agent-ui.html'); });

// Request log with IP + timestamp (security-relevant endpoints).
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  console.log(`[agent-server] ${new Date().toISOString()} ${ip} ${req.method} ${req.path}`);
  res.setHeader('Cache-Control', 'no-store');
  next();
});

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function hasValidApiKey(supplied: string | undefined): boolean {
  if (!API_KEY || !supplied) return false;
  const expected = Buffer.from(API_KEY);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function securityMiddleware(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.header('authorization')?.replace(/^Bearer\s+/i, '') || req.header('x-api-key') || (typeof req.query.token === 'string' ? req.query.token : undefined);
  if (!API_KEY && !isLoopback(HOST)) {
    res.status(503).json({ error: 'Server authentication is not configured' });
    return;
  }
  if (API_KEY && !hasValidApiKey(supplied)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    next();
    return;
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT_MAX) {
    res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
    res.status(429).json({ error: 'Too many requests' });
    return;
  }
  next();
}

app.use('/api/agent', securityMiddleware);

class ServerPermissionManager implements PermissionManager {
  constructor(private readonly allowMutations: boolean) {}
  check(action: Action): PermissionResult {
    if (!this.allowMutations) {
      if (action.risk === 'safe' || (action.type === 'read_file' && action.risk === 'medium')) return { allowed: true };
      return { allowed: false, reason: 'Server is read-only; set AGENT_SERVER_ALLOW_MUTATIONS=true to enable writes' };
    }
    if (action.risk === 'critical') return { allowed: false, reason: 'Critical risk actions are never allowed by the server' };
    return { allowed: true };
  }
  async requestApproval(_action: Action): Promise<boolean> { return false; }
}

let agent: Agent | null = null;
let config: Config;
let requestInProgress = false;

/**
 * Skills, MCP servers and plugins all live under the workspace's `.agent`
 * directory, so the manager is created once from the process working directory
 * and reused across agent rebuilds.
 */
const extensions = new ExtensionManager(process.cwd());

export type ProviderName = 'anthropic' | 'openai';
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

const SETTINGS_DIR = path.join(process.cwd(), '.agent');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'ui-settings.json');

/**
 * Runtime provider settings. The environment seeds them at boot and the settings
 * endpoint can override them for the lifetime of the process. Non-secret fields
 * (provider / model / base URL / thinking level) are remembered in
 * `.agent/ui-settings.json` so the UI comes back the way it was left; the
 * credential itself is never written to disk and never echoed to a client —
 * only whether one is present is reported.
 */
interface ProviderSettings { provider: ProviderName; model: string; baseUrl: string; apiKey: string; thinkingLevel: ThinkingLevel }

function readPersistedSettings(): Partial<ProviderSettings> {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Record<string, unknown>;
    const out: Partial<ProviderSettings> = {};
    if (raw.provider === 'anthropic' || raw.provider === 'openai') out.provider = raw.provider;
    if (typeof raw.model === 'string') out.model = raw.model;
    if (typeof raw.baseUrl === 'string') out.baseUrl = raw.baseUrl;
    if (raw.thinkingLevel === 'off' || raw.thinkingLevel === 'low' || raw.thinkingLevel === 'medium' || raw.thinkingLevel === 'high') out.thinkingLevel = raw.thinkingLevel;
    return out;
  } catch { return {}; }
}

/** Writes the non-secret subset back so a restart resumes the same channel. */
function persistSettings(settings: ProviderSettings): void {
  try {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl, thinkingLevel: settings.thinkingLevel,
    }, null, 2) + '\n', 'utf8');
  } catch (error) {
    console.error('Could not persist UI settings:', error);
  }
}

const persisted = readPersistedSettings();
const settings: ProviderSettings = {
  provider: persisted.provider ?? (process.env.AGENT_PROVIDER === 'openai' ? 'openai' : 'anthropic'),
  model: persisted.model || process.env.ANTHROPIC_MODEL || process.env.OPENAI_MODEL || '',
  baseUrl: persisted.baseUrl || process.env.ANTHROPIC_BASE_URL || process.env.OPENAI_BASE_URL || '',
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '',
  thinkingLevel: persisted.thinkingLevel ?? 'off',
};

function envKeyFor(provider: ProviderName): string {
  return provider === 'openai' ? process.env.OPENAI_API_KEY || '' : process.env.ANTHROPIC_API_KEY || '';
}

function publicSettings(): { provider: ProviderName; model: string; baseUrl: string; hasApiKey: boolean; thinkingLevel: ThinkingLevel } {
  return { provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl, hasApiKey: Boolean(settings.apiKey), thinkingLevel: settings.thinkingLevel };
}

/* ---------------- live activity feed (Server-Sent Events) ---------------- */

const MAX_BUFFERED_EVENTS = 50;
const eventBuffer: Array<Record<string, unknown>> = [];
const subscribers = new Set<Response>();

/**
 * How many times the model itself has been called (one per agent iteration that
 * reached the provider), plus the total tokens it reported. The agent counts
 * tokens but not calls, and "how many calls did that cost me" is the first thing
 * anyone asks of a metrics panel, so it is counted here where every provider
 * response passes through.
 */
let modelCalls = 0;

/** Fans one agent event out to every open SSE stream (and into the replay buffer). */
function broadcast(event: Record<string, unknown>): void {
  const payload = { at: Date.now(), ...event };
  eventBuffer.push(payload);
  if (eventBuffer.length > MAX_BUFFERED_EVENTS) eventBuffer.shift();
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of subscribers) {
    try { res.write(frame); } catch { subscribers.delete(res); }
  }
}

/** Mirrors the agent's own emitter into the feed (sanitised, no secrets). */
function attachAgentListeners(instance: Agent): void {
  instance.on('iteration', (n: number, max: number) => broadcast({ type: 'iteration', iteration: n, maxIterations: max }));
  instance.on('status', (status: string) => broadcast({ type: 'status', status }));
  instance.on('toolStart', (call: { id: string; name: string; input: unknown }) => broadcast({ type: 'toolStart', id: call.id, tool: call.name, input: call.input }));
  instance.on('toolEnd', (execution: { tool: string; duration?: number; retryCount?: number; result?: { success?: boolean; cached?: boolean; error?: string } }) => broadcast({
    type: 'toolEnd', tool: execution.tool, duration: execution.duration ?? null,
    retryCount: execution.retryCount ?? 0, success: execution.result?.success !== false,
    cached: execution.result?.cached === true, error: execution.result?.error ?? null,
  }));
  instance.on('tokenUsage', (usage: { inputTokens: number; outputTokens: number; totalTokens: number }) => {
    modelCalls += 1;
    broadcast({ type: 'tokenUsage', ...usage, session: instance.getUsage() });
  });
  instance.on('providerRetry', (info: { attempt: number; maxRetries: number; waitMs: number; error: string }) => broadcast({ type: 'providerRetry', ...info }));
  instance.on('contextCompressed', (stats: unknown) => broadcast({ type: 'contextCompressed', stats }));
  instance.on('specialtyRouted', (info: { entered?: unknown[]; exited?: unknown[]; active?: unknown[] }) => broadcast({ type: 'specialty', entered: info.entered ?? [], exited: info.exited ?? [], active: info.active ?? [] }));
  instance.on('securityAlert', (info: unknown) => broadcast({ type: 'securityAlert', info }));
}

function initializeAgent(): Agent {
  if (!settings.apiKey) throw new Error('An API key is required to start the agent server (set ANTHROPIC_API_KEY or configure one in the UI)');
  const apiKey = settings.apiKey;
  const model = settings.model;
  const baseUrl = settings.baseUrl || undefined;
  const allowMutations = process.env.AGENT_SERVER_ALLOW_MUTATIONS === 'true';
  config = {
    provider: settings.provider, model, apiKey, baseUrl,
    thinkingLevel: settings.thinkingLevel,
    permissionMode: allowMutations ? 'auto' : 'safe', maxIterations: 20, temperature: 0.7,
    workspaceRoot: process.cwd(), debug: false, enableToolRetry: true, maxToolRetries: 3,
    enableToolCache: true, toolTimeout: 30000, validateToolInputs: true, autoRecovery: true,
    strictToolCalling: true, toolRouterMaxTools: 12, toolQueueConcurrency: 1, serverApiKey: API_KEY,
  };
  agent = new Agent(createProvider(config, apiKey), createDefaultToolRegistry(), new ServerPermissionManager(allowMutations), config);
  attachAgentListeners(agent);
  // A fresh agent starts with empty usage totals, so the call counter restarts too.
  modelCalls = 0;
  // MCP servers are child processes: connect them in the background so a slow or
  // unreachable server cannot delay the HTTP listener coming up.
  void extensions.activate(agent.getToolRegistry()).catch((error) => {
    console.error('Extension activation failed:', error);
  });
  return agent;
}
function getAgent(): Agent { return agent || initializeAgent(); }
function publicError(error: unknown): string { return process.env.NODE_ENV === 'development' && error instanceof Error ? error.message : 'Agent request failed'; }

/* ---------------- attachments ---------------- */

const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const TEXT_ATTACHMENT_LIMIT = 200 * 1024;
const IMAGE_MIME = /^image\/(png|jpeg|jpg|gif|webp)$/i;

type RawAttachment = { name?: unknown; mimeType?: unknown; data?: unknown };

type ClientRunConfig = {
  retry?: boolean;
  cache?: boolean;
  validation?: boolean;
  recovery?: boolean;
  debug?: boolean;
};

type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

interface AgentRunResult {
  response: string;
  duration: number;
  toolExecutions: unknown[];
  stats: {
    totalCalls: number;
    successCalls: number;
    avgDuration: number;
    iterations: number;
    retries: number;
    cacheHits: number;
    modelCalls: number;
  };
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  toolUsage: Record<string, number>;
}

interface AgentRunJob {
  id: string;
  status: AgentRunStatus;
  createdAt: number;
  updatedAt: number;
  result?: AgentRunResult;
  error?: string;
}

// A request to a coding agent can take several model/tool rounds. Reverse
// proxies are allowed to give up on that HTTP connection, so retain the run in
// memory and let the UI poll its small status document instead of holding the
// original response open until the model finishes.
const runJobs = new Map<string, AgentRunJob>();
const MAX_RUN_JOBS = 50;
const RUN_JOB_TTL_MS = 30 * 60 * 1000;

function pruneRunJobs(now = Date.now()): void {
  for (const [id, job] of runJobs) {
    if (job.updatedAt < now - RUN_JOB_TTL_MS) runJobs.delete(id);
  }
  if (runJobs.size <= MAX_RUN_JOBS) return;
  const excess = Array.from(runJobs.values())
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, runJobs.size - MAX_RUN_JOBS);
  for (const job of excess) runJobs.delete(job.id);
}

/**
 * Turns client-supplied attachments into provider content blocks. Images stay
 * base64 (both providers accept inline images); anything else is inlined as text
 * when it decodes as UTF-8 text, and otherwise summarised by name and size so the
 * model at least knows the file exists.
 */
function toContentBlocks(raw: RawAttachment[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const item of raw.slice(0, MAX_ATTACHMENTS)) {
    const name = typeof item.name === 'string' ? path.basename(item.name).slice(0, 200) : 'attachment';
    const mimeType = typeof item.mimeType === 'string' ? item.mimeType : 'application/octet-stream';
    if (typeof item.data !== 'string' || !item.data) continue;
    const buffer = Buffer.from(item.data, 'base64');
    if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) continue;
    if (IMAGE_MIME.test(mimeType)) {
      const media = mimeType.toLowerCase() === 'image/jpg' ? 'image/jpeg' : mimeType.toLowerCase();
      blocks.push({ type: 'image', fileName: name, mimeType: media, source: { type: 'base64', media_type: media, data: buffer.toString('base64') } });
      continue;
    }
    const isText = !buffer.includes(0) && buffer.length <= TEXT_ATTACHMENT_LIMIT;
    const body = isText ? buffer.toString('utf8') : `[binary file, ${buffer.length} bytes — read it with the file tools if needed]`;
    blocks.push({ type: 'file', fileName: name, mimeType, content: body });
  }
  return blocks;
}

async function executeAgentRun(
  job: AgentRunJob,
  message: string,
  clientConfig: ClientRunConfig | undefined,
  contentBlocks: ContentBlock[]
): Promise<void> {
  let currentAgent: Agent | null = null;
  job.status = 'running';
  job.updatedAt = Date.now();
  try {
    currentAgent = getAgent();
    if (clientConfig) {
      currentAgent.updateConfig({
        enableToolRetry: clientConfig.retry ?? true,
        enableToolCache: clientConfig.cache ?? true,
        validateToolInputs: clientConfig.validation ?? true,
        autoRecovery: clientConfig.recovery ?? true,
        debug: clientConfig.debug ?? false,
      });
    }
    const startTime = Date.now();
    const response = await currentAgent.run(message, contentBlocks);
    const state = currentAgent.getState();
    const report = currentAgent.getPerformanceMonitor().generateReport();
    const toolUsage: Record<string, number> = {};
    state.history.forEach(exec => { toolUsage[exec.tool] = (toolUsage[exec.tool] || 0) + 1; });
    const retries = state.history.reduce((sum, exec) => sum + (exec.retryCount ?? 0), 0);
    const cacheHits = state.history.filter(exec => exec.result?.cached).length;
    job.result = {
      response,
      duration: Date.now() - startTime,
      toolExecutions: state.history.slice(-10),
      stats: {
        totalCalls: report.overview.totalExecutions,
        successCalls: report.overview.totalSuccess,
        avgDuration: report.overview.avgExecutionTime,
        iterations: state.iterationCount,
        retries,
        cacheHits,
        modelCalls,
      },
      usage: currentAgent.getUsage(),
      toolUsage,
    };
    job.status = 'completed';
  } catch (error) {
    const cancelled = currentAgent?.killed === true;
    console.error('Agent error:', error);
    job.status = cancelled ? 'cancelled' : 'failed';
    job.error = cancelled ? 'Agent run was cancelled' : publicError(error);
  } finally {
    job.updatedAt = Date.now();
    // A kill switch is intentionally sticky inside Agent. Once the cancelled
    // run has fully unwound, reset the session so a later request can start a
    // fresh run instead of failing with AGENT_KILLED forever.
    if (job.status === 'cancelled') currentAgent?.reset();
    requestInProgress = false;
    pruneRunJobs();
    broadcast({ type: 'runComplete', jobId: job.id, status: job.status });
  }
}


app.post('/api/agent/run', (req, res) => {
  const { message, config: clientConfig, attachments } = req.body ?? {};
  if (typeof message !== 'string' || !message.trim()) { res.status(400).json({ error: 'Message must be a non-empty string' }); return; }
  if (message.length > 100_000) { res.status(413).json({ error: 'Message is too large (maximum 100000 characters)' }); return; }
  if (clientConfig !== undefined && (typeof clientConfig !== 'object' || clientConfig === null || Array.isArray(clientConfig))) { res.status(400).json({ error: 'config must be an object' }); return; }
  if (clientConfig) {
    const keys: Array<keyof ClientRunConfig> = ['retry', 'cache', 'validation', 'recovery', 'debug'];
    for (const key of keys) {
      if (clientConfig[key] !== undefined && typeof clientConfig[key] !== 'boolean') {
        res.status(400).json({ error: `config.${key} must be a boolean` });
        return;
      }
    }
  }
  if (attachments !== undefined && !Array.isArray(attachments)) { res.status(400).json({ error: 'attachments must be an array' }); return; }
  if (requestInProgress) { res.status(409).json({ error: 'Another agent request is already in progress' }); return; }

  const contentBlocks = Array.isArray(attachments) ? toContentBlocks(attachments as RawAttachment[]) : [];
  const now = Date.now();
  const job: AgentRunJob = { id: randomUUID(), status: 'queued', createdAt: now, updatedAt: now };
  runJobs.set(job.id, job);
  pruneRunJobs(now);
  requestInProgress = true;
  void executeAgentRun(job, message, clientConfig as ClientRunConfig | undefined, contentBlocks);
  res.status(202).json({ jobId: job.id, status: job.status });
});

app.get('/api/agent/run/:jobId', (req, res) => {
  pruneRunJobs();
  const job = runJobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Run not found or expired' }); return; }
  const payload: Record<string, unknown> = {
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  if (job.status === 'completed') payload.result = job.result;
  if (job.status === 'failed' || job.status === 'cancelled') payload.error = job.error || 'Agent request failed';
  res.json(payload);
});

app.get('/api/agent/status', (_req, res) => {
  const provider = { model: settings.model, provider: settings.provider, thinkingLevel: settings.thinkingLevel };
  if (!agent) { res.json({ status: 'not_initialized', tools: [], ...provider, modelCalls: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }); return; }
  const state = agent.getState();
  res.json({
    status: state.status, ...provider,
    tools: agent.getToolRegistry().list().map(t => ({ name: t.name, description: t.description })),
    iterations: state.iterationCount, historyLength: state.history.length, usage: agent.getUsage(),
    modelCalls,
  });
});

/**
 * Live activity feed (Server-Sent Events). The browser subscribes with
 * EventSource, which cannot send headers, so a configured API key travels as a
 * query parameter here; everything else about the endpoint matches the rest of
 * the authenticated /api/agent surface.
 */
app.get('/api/agent/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  subscribers.add(res);
  res.write(`data: ${JSON.stringify({ type: 'hello', at: Date.now(), replay: eventBuffer.slice(-10), status: agent ? agent.getState().status : 'idle' })}\n\n`);
  const keepAlive = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { /* stream closed */ } }, 20000);
  // Never hold the event loop open on account of an idle subscriber.
  keepAlive.unref?.();
  req.on('close', () => { clearInterval(keepAlive); subscribers.delete(res); });
});

/** Provider settings (base URL / model / API key) as configured for this process. */
app.get('/api/agent/settings', (_req, res) => { res.json(publicSettings()); });

app.put('/api/agent/settings', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const invalid = (message: string): null => { res.status(400).json({ error: message }); return null; };
  // Returns the trimmed string, or null for "absent" — a validation failure has
  // already sent its response by then, so the caller only checks `null`.
  const readField = (field: keyof ProviderSettings, max: number): string | null => {
    const value = body[field];
    if (value === undefined) return null;
    if (typeof value !== 'string') return invalid(`${field} must be a string`);
    const trimmed = value.trim();
    if (trimmed.length > max) return invalid(`${field} is too long (max ${max} characters)`);
    if (/[\r\n]/.test(trimmed)) return invalid(`${field} must not contain line breaks`);
    return trimmed;
  };

  const model = readField('model', 200);
  if (res.headersSent) return;
  const baseUrl = readField('baseUrl', 500);
  if (res.headersSent) return;
  const apiKey = readField('apiKey', 500);
  if (res.headersSent) return;
  if (body.clearApiKey !== undefined && typeof body.clearApiKey !== 'boolean') { invalid('clearApiKey must be a boolean'); return; }
  if (body.provider !== undefined && body.provider !== 'anthropic' && body.provider !== 'openai') { invalid('provider must be "anthropic" or "openai"'); return; }
  if (body.thinkingLevel !== undefined && typeof body.thinkingLevel !== 'string') { invalid('thinkingLevel must be a string'); return; }
  if (typeof body.thinkingLevel === 'string' && !['off', 'low', 'medium', 'high'].includes(body.thinkingLevel)) { invalid('thinkingLevel must be "off", "low", "medium" or "high"'); return; }
  if (baseUrl) {
    let parsed: URL;
    try { parsed = new URL(baseUrl); } catch { invalid('baseUrl must be a valid absolute URL'); return; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { invalid('baseUrl must use http or https'); return; }
  }

  if (body.provider === 'anthropic' || body.provider === 'openai') {
    // Switching channels drops a key that belonged to the other one, unless the
    // environment already carries a key for the new provider.
    if (body.provider !== settings.provider) settings.apiKey = envKeyFor(body.provider);
    settings.provider = body.provider;
  }
  if (model !== null) settings.model = model;
  if (baseUrl !== null) settings.baseUrl = baseUrl;
  if (apiKey) settings.apiKey = apiKey;
  if (typeof body.thinkingLevel === 'string') settings.thinkingLevel = body.thinkingLevel as ThinkingLevel;
  if (body.clearApiKey === true) settings.apiKey = '';

  // Rebuild lazily so the next request uses the new endpoint/model/credentials.
  // The rebuilt agent gets a fresh registry, so MCP servers and plugins have to
  // be detached from the old one first or their child processes would leak.
  if (agent) extensions.deactivate(agent.getToolRegistry());
  agent = null;
  persistSettings(settings);
  res.json(publicSettings());
});
app.get('/api/agent/report', (_req, res) => { if (!agent) { res.json({ error: 'Agent not initialized' }); return; } const report = agent.getPerformanceMonitor().generateReport(); res.json({ overview: report.overview, slowestTools: report.slowestTools, mostUnreliable: report.mostUnreliable, recommendations: report.recommendations, usage: agent.getUsage(), modelCalls }); });
app.get('/api/agent/metrics/:toolName', (req, res) => { if (!agent) { res.json({ error: 'Agent not initialized' }); return; } const metrics = agent.getPerformanceMonitor().getToolMetrics(req.params.toolName); if (!metrics) { res.status(404).json({ error: 'Tool not found' }); return; } res.json({ ...metrics, errorTypes: Array.from(metrics.errorTypes.entries()) }); });
app.get('/api/agent/export', (_req, res) => { if (!agent) { res.json({ error: 'Agent not initialized' }); return; } res.setHeader('Content-Type', 'application/json'); res.setHeader('Content-Disposition', `attachment; filename=agent-metrics-${Date.now()}.json`); res.send(agent.exportPerformanceData()); });
app.post('/api/agent/clear', (_req, res) => {
  if (requestInProgress) {
    agent?.kill('Run cancelled by reset request');
    res.status(202).json({ success: true, cancelling: true });
    return;
  }
  if (!agent) { res.status(404).json({ error: 'Agent not initialized' }); return; }
  agent.reset();
  modelCalls = 0;
  broadcast({ type: 'reset' });
  res.json({ success: true });
});
app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

/* ---------------- extensions: skills, MCP servers, plugins ---------------- */

const EXTENSION_KINDS: ExtensionKind[] = ['skill', 'mcp', 'plugin'];

/** Everything the Extensions panel renders, in one round trip. */
app.get('/api/agent/extensions', (_req, res) => {
  res.json(extensions.snapshot(agent?.getToolRegistry()));
});

/** Raw SKILL.md, for the viewer. */
app.get('/api/agent/extensions/skills/:name', (req, res) => {
  try {
    res.json({ name: req.params.name, content: extensions.readSkill(req.params.name), files: extensions.skills.files(req.params.name) });
  } catch (error) {
    res.status(404).json({ error: (error as Error).message });
  }
});

/**
 * Install from GitHub. The body decides what gets installed: an explicit `kind`,
 * or whatever the downloaded files look like (SKILL.md / plugin.json / mcp.json).
 */
app.post('/api/agent/extensions/install', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.url !== 'string' || !body.url.trim()) { res.status(400).json({ error: 'url is required' }); return; }
  if (body.kind !== undefined && !EXTENSION_KINDS.includes(body.kind as ExtensionKind)) {
    res.status(400).json({ error: 'kind must be "skill", "mcp" or "plugin"' }); return;
  }
  if (body.name !== undefined && typeof body.name !== 'string') { res.status(400).json({ error: 'name must be a string' }); return; }
  try {
    const result = await extensions.installFromGitHub(body.url.trim(), {
      kind: body.kind as ExtensionKind | undefined,
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined,
      overwrite: body.overwrite === true,
      registry: getAgent().getToolRegistry(),
    });
    broadcast({ type: 'extensions', action: 'install', kind: result.kind, name: result.name });
    res.json({ ...result, snapshot: extensions.snapshot(agent?.getToolRegistry()) });
  } catch (error) {
    res.status(isExtensionError(error) ? 400 : 502).json({ error: (error as Error).message });
  }
});

/** Add one MCP server by hand, then connect it. */
app.post('/api/agent/extensions/mcp', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.name !== 'string' || !body.name.trim()) { res.status(400).json({ error: 'name is required' }); return; }
  if (typeof body.command !== 'string' || !body.command.trim()) { res.status(400).json({ error: 'command is required' }); return; }
  if (body.args !== undefined && !Array.isArray(body.args)) { res.status(400).json({ error: 'args must be an array of strings' }); return; }
  if (body.env !== undefined && (typeof body.env !== 'object' || body.env === null || Array.isArray(body.env))) {
    res.status(400).json({ error: 'env must be an object of strings' }); return;
  }
  try {
    await extensions.addMcpServer({
      name: body.name.trim(),
      command: body.command.trim(),
      args: Array.isArray(body.args) ? body.args.map(String) : [],
      env: body.env as Record<string, string> | undefined,
      enabled: body.enabled !== false,
    }, getAgent().getToolRegistry());
    broadcast({ type: 'extensions', action: 'mcp-added', name: body.name });
    res.json({ snapshot: extensions.snapshot(agent?.getToolRegistry()) });
  } catch (error) {
    res.status(isExtensionError(error) ? 400 : 500).json({ error: (error as Error).message });
  }
});

/** Reconnect one server (or all of them) after editing its config by hand. */
app.post('/api/agent/extensions/mcp/reload', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.name !== undefined && typeof body.name !== 'string') { res.status(400).json({ error: 'name must be a string' }); return; }
  try {
    await extensions.mcp.reload(body.name as string | undefined, getAgent().getToolRegistry());
    res.json({ snapshot: extensions.snapshot(agent?.getToolRegistry()) });
  } catch (error) {
    res.status(isExtensionError(error) ? 400 : 500).json({ error: (error as Error).message });
  }
});

app.delete('/api/agent/extensions/:kind/:name', async (req, res) => {
  const kind = req.params.kind as ExtensionKind;
  if (!EXTENSION_KINDS.includes(kind)) { res.status(400).json({ error: 'kind must be "skill", "mcp" or "plugin"' }); return; }
  try {
    await extensions.remove(kind, req.params.name, getAgent().getToolRegistry());
    broadcast({ type: 'extensions', action: 'removed', kind, name: req.params.name });
    res.json({ snapshot: extensions.snapshot(agent?.getToolRegistry()) });
  } catch (error) {
    res.status(isExtensionError(error) ? 400 : 500).json({ error: (error as Error).message });
  }
});

/** Load a plugin that is installed but not yet imported (or retry a failed one). */
app.post('/api/agent/extensions/plugins/:name/load', async (req, res) => {
  try {
    const plugin = await extensions.plugins.load(req.params.name, getAgent().getToolRegistry());
    res.json({ plugin, snapshot: extensions.snapshot(agent?.getToolRegistry()) });
  } catch (error) {
    res.status(isExtensionError(error) ? 400 : 500).json({ error: (error as Error).message });
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Server error:', err);
  const tooLarge = typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large';
  res.status(tooLarge ? 413 : 500).json({ error: tooLarge ? 'Request body is too large (12mb maximum)' : 'Internal server error' });
});

if (process.env.NODE_ENV !== 'test') app.listen(PORT, HOST, () => { console.log(`Agent CLI Web Server running at http://localhost:${PORT}`); try { initializeAgent(); } catch (error) { console.error('Failed to initialize agent:', error); } });
export default app;
