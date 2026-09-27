import express, { NextFunction, Request, Response } from 'express';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { Agent } from './agent/Agent.js';
import { AnthropicProvider } from './providers/AnthropicProvider.js';
import { createDefaultToolRegistry } from './tools/index.js';
import { Action, PermissionManager, PermissionResult, Config } from './types/index.js';

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
app.use(express.json({ limit: '1mb' }));
// Serve the web UI from <repo root>/public. Compiled output lives in dist/ and
// the sources in src/, so exactly one level up is the project root in both cases.
app.use(express.static(path.join(__dirname, '..', 'public')));

// Baseline security headers (CSP when a web UI is served).
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Request log with IP + timestamp (security-relevant endpoints).
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  console.log(`[agent-server] ${new Date().toISOString()} ${ip} ${req.method} ${req.path}`);
  next();
});

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function securityMiddleware(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.header('authorization')?.replace(/^Bearer\s+/i, '') || req.header('x-api-key');
  if (!API_KEY && !isLoopback(HOST)) {
    res.status(503).json({ error: 'Server authentication is not configured' });
    return;
  }
  if (API_KEY && supplied !== API_KEY) {
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

function initializeAgent(): Agent {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required to start the agent server');
  // Honour the env contract the SDK and the CLI already use, so a relay or proxy
  // endpoint (and the model name it serves) works without editing this file.
  const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
  const baseUrl = process.env.ANTHROPIC_BASE_URL || undefined;
  const allowMutations = process.env.AGENT_SERVER_ALLOW_MUTATIONS === 'true';
  config = {
    provider: 'anthropic', model, apiKey,
    permissionMode: allowMutations ? 'auto' : 'safe', maxIterations: 20, temperature: 0.7,
    workspaceRoot: process.cwd(), debug: false, enableToolRetry: true, maxToolRetries: 3,
    enableToolCache: true, toolTimeout: 30000, validateToolInputs: true, autoRecovery: true,
    strictToolCalling: true, toolRouterMaxTools: 12, toolQueueConcurrency: 1, serverApiKey: API_KEY,
  };
  agent = new Agent(new AnthropicProvider(apiKey, { model, baseUrl }), createDefaultToolRegistry(), new ServerPermissionManager(allowMutations), config);
  return agent;
}
function getAgent(): Agent { return agent || initializeAgent(); }
function publicError(error: unknown): string { return process.env.NODE_ENV === 'development' && error instanceof Error ? error.message : 'Agent request failed'; }

app.post('/api/agent/run', async (req, res) => {
  try {
    const { message, config: clientConfig } = req.body;
    if (typeof message !== 'string' || !message.trim()) { res.status(400).json({ error: 'Message must be a non-empty string' }); return; }
    if (message.length > 100_000) { res.status(413).json({ error: 'Message is too large (maximum 100000 characters)' }); return; }
    if (clientConfig !== undefined && (typeof clientConfig !== 'object' || clientConfig === null || Array.isArray(clientConfig))) { res.status(400).json({ error: 'config must be an object' }); return; }
    if (requestInProgress) { res.status(409).json({ error: 'Another agent request is already in progress' }); return; }
    requestInProgress = true;
    const currentAgent = getAgent();
    if (clientConfig) currentAgent.updateConfig({
      enableToolRetry: clientConfig.retry ?? true, enableToolCache: clientConfig.cache ?? true,
      validateToolInputs: clientConfig.validation ?? true, autoRecovery: clientConfig.recovery ?? true,
      debug: clientConfig.debug ?? false,
    });
    const startTime = Date.now();
    const response = await currentAgent.run(message);
    const state = currentAgent.getState();
    const report = currentAgent.getPerformanceMonitor().generateReport();
    const toolUsage: Record<string, number> = {};
    state.history.forEach(exec => { toolUsage[exec.tool] = (toolUsage[exec.tool] || 0) + 1; });
    res.json({ response, duration: Date.now() - startTime, toolExecutions: state.history.slice(-10), stats: { totalCalls: report.overview.totalExecutions, successCalls: report.overview.totalSuccess, avgDuration: report.overview.avgExecutionTime, iterations: state.iterationCount }, toolUsage });
  } catch (error) {
    console.error('Agent error:', error);
    res.status(500).json({ error: publicError(error), ...(process.env.NODE_ENV === 'development' && error instanceof Error ? { stack: error.stack } : {}) });
  } finally { requestInProgress = false; }
});

app.get('/api/agent/status', (_req, res) => { if (!agent) { res.json({ status: 'not_initialized', tools: [] }); return; } const state = agent.getState(); res.json({ status: state.status, tools: agent.getToolRegistry().list().map(t => ({ name: t.name, description: t.description })), iterations: state.iterationCount, historyLength: state.history.length }); });
app.get('/api/agent/report', (_req, res) => { if (!agent) { res.json({ error: 'Agent not initialized' }); return; } const report = agent.getPerformanceMonitor().generateReport(); res.json({ overview: report.overview, slowestTools: report.slowestTools, mostUnreliable: report.mostUnreliable, recommendations: report.recommendations }); });
app.get('/api/agent/metrics/:toolName', (req, res) => { if (!agent) { res.json({ error: 'Agent not initialized' }); return; } const metrics = agent.getPerformanceMonitor().getToolMetrics(req.params.toolName); if (!metrics) { res.status(404).json({ error: 'Tool not found' }); return; } res.json({ ...metrics, errorTypes: Array.from(metrics.errorTypes.entries()) }); });
app.get('/api/agent/export', (_req, res) => { if (!agent) { res.json({ error: 'Agent not initialized' }); return; } res.setHeader('Content-Type', 'application/json'); res.setHeader('Content-Disposition', `attachment; filename=agent-metrics-${Date.now()}.json`); res.send(agent.exportPerformanceData()); });
app.post('/api/agent/clear', (_req, res) => { if (!agent) { res.status(404).json({ error: 'Agent not initialized' }); return; } agent.reset(); res.json({ success: true }); });
app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); });

if (process.env.NODE_ENV !== 'test') app.listen(PORT, HOST, () => { console.log(`Agent CLI Web Server running at http://localhost:${PORT}`); try { initializeAgent(); } catch (error) { console.error('Failed to initialize agent:', error); } });
export default app;
