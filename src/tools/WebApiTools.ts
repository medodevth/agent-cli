import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool, ToolContext, ToolResult } from '../types/index.js';
import { runCaptured, truncateOutput } from './ShellTool.js';

/**
 * API / Web Interaction tools (group 7). The http tool has a hard SSRF
 * guard: private/loopback/link-local targets are refused unless explicitly
 * allowed — the agent cannot be tricked into probing internal services.
 */

type Input = Record<string, unknown>;
const str = (input: Input, key: string): string => String(input[key] ?? '');

// 48. http_request -------------------------------------------------------------

const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i, /^127\./, /^0\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, /^\[::1\]$/, /^\[fc00/i, /^\[fd/i, /\.internal$/i, /^metadata\./i,
];

export function isBlockedHost(hostname: string): boolean {
  return BLOCKED_HOST_PATTERNS.some(re => re.test(hostname.trim()));
}

export class HttpRequestTool implements Tool {
  name = 'http_request';
  description = 'Make an HTTP request to debug or test an endpoint (method, headers, JSON body). Internal/private network targets are blocked by default.';
  inputSchema = { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string', description: 'default GET' }, headers: { type: 'object', additionalProperties: { type: 'string' } }, body: { type: 'string' }, allowPrivateHost: { type: 'boolean', description: 'explicitly allow localhost/private ranges' } }, required: ['url'] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const urlText = str(input, 'url');
      let parsed: URL;
      try { parsed = new URL(urlText); } catch { return { success: false, error: `Invalid URL: ${urlText}` }; }
      if (!['http:', 'https:'].includes(parsed.protocol)) return { success: false, error: `Blocked protocol: ${parsed.protocol} (http/https only)` };
      const allowPrivate = input.allowPrivateHost === true;
      if (isBlockedHost(parsed.hostname)) {
        if (!allowPrivate) {
          return { success: false, error: `Blocked: '${parsed.hostname}' looks like an internal/private host (SSRF guard). Pass allowPrivateHost=true only when testing your own local server.` };
        }
        const denied = await context.permissions.check({ type: 'execute_command', description: `HTTP request to private host ${parsed.hostname}`, risk: 'medium' });
        if (denied.allowed === false) return { success: false, error: `Permission denied: ${denied.reason}` };
      }
      const method = (str(input, 'method') || 'GET').toUpperCase();
      const headers: Record<string, string> = {};
      if (input.headers && typeof input.headers === 'object') {
        for (const [k, v] of Object.entries(input.headers as Record<string, unknown>)) headers[k] = String(v);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(parsed, {
          method,
          headers: { ...headers, ...(input.body && !headers['content-type'] ? { 'content-type': 'application/json' } : {}) },
          body: input.body !== undefined && method !== 'GET' && method !== 'HEAD' ? str(input, 'body') : undefined,
          signal: controller.signal,
        });
        const text = await response.text();
        const redacted = text.replace(/\b(sk|pk|ghp|AKIA)[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
        return { success: true, output:
          `${method} ${parsed.host}${parsed.pathname} → HTTP ${response.status} ${response.statusText}\n` +
          `Content-Type: ${response.headers.get('content-type') ?? '?'}\n\n` + truncateOutput(redacted, 40),
          metadata: { status: response.status, ok: response.ok } };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return { success: false, error: 'Request timed out after 30s' };
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

// 49. fetch_docs ---------------------------------------------------------------

export class FetchDocsTool implements Tool {
  name = 'fetch_docs';
  description = 'Fetch documentation or OpenAPI spec from a public URL (docs site / raw.githubusercontent) and extract readable text. Blocks private hosts.';
  inputSchema = { type: 'object', properties: { url: { type: 'string' }, maxChars: { type: 'number' } }, required: ['url'] };

  async execute(input: Input, _context: ToolContext): Promise<ToolResult> {
    try {
      const parsed = new URL(str(input, 'url'));
      if (!['http:', 'https:'].includes(parsed.protocol)) return { success: false, error: 'http/https only' };
      if (isBlockedHost(parsed.hostname)) return { success: false, error: `Blocked private host: ${parsed.hostname}` };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(parsed, { signal: controller.signal });
        const raw = await response.text();
        const isHtml = /<html|<!doctype/i.test(raw.slice(0, 200));
        const text = isHtml
          ? raw.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
          : raw;
        return { success: true, output: `Docs from ${parsed.host}${parsed.pathname} (${text.length} chars):\n\n` + text.slice(0, Math.min(Number(input.maxChars) || 6000, 15000)), metadata: { status: response.status, chars: text.length } };
      } finally { clearTimeout(timer); }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 50. web_search_for_error -----------------------------------------------------

export class WebSearchForErrorTool implements Tool {
  name = 'web_search_for_error';
  description = 'Turn a raw error into effective web search queries (error name, code, framework hint) and return them as ready-to-use search URLs. The agent can then fetch promising results with fetch_docs.';
  inputSchema = { type: 'object', properties: { error: { type: 'string' }, context: { type: 'string', description: 'framework/language hint, e.g. "next.js", "python"' } }, required: ['error'] };

  async execute(input: Input, _context: ToolContext): Promise<ToolResult> {
    try {
      const raw = str(input, 'error').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!raw) return { success: false, error: 'error text is required' };
      const ctx = str(input, 'context');
      const errorName = raw.match(/([A-Z][A-Za-z]+(?:Error|Exception))/)?.[1] ?? '';
      const errorCode = raw.match(/\b(TS\d{3,4}|E[A-Z]{2,}\b|ERR_[A-Z_]+)/)?.[1] ?? '';
      const queries: string[] = [];
      if (errorName && ctx) queries.push(`${ctx} ${errorName} fix`);
      if (errorName) queries.push(`${errorName} causes and solutions`);
      if (errorCode) queries.push(`${errorCode} ${ctx}`.trim());
      if (errorCode && errorName) queries.push(`${errorCode} ${errorName}`);
      queries.push(`"${raw.slice(0, 120)}"`);
      const encoded = [...new Set(queries)].slice(0, 5).map(q => `- https://www.google.com/search?q=${encodeURIComponent(q)}`);
      const stackHint = raw.split('\n')[0]?.slice(0, 160);
      return { success: true, output:
        `Search plan for: ${stackHint}\n\nQueries (newest docs first usually win):\n` + encoded.join('\n') +
        `\n\nTip: fetch the top result with fetch_docs and quote the relevant section before applying a fix.`,
        metadata: { queries: encoded.length } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

// 51. database_query -----------------------------------------------------------

export class DatabaseQueryTool implements Tool {
  name = 'database_query';
  description = 'Run a READ-ONLY query (sqlite3 / psql) to inspect schema or data. Write/DDL statements are refused — use migrations for changes.';
  inputSchema = { type: 'object', properties: { query: { type: 'string' }, database: { type: 'string', description: 'file path for sqlite, or connection URL name for psql (e.g. DATABASE_URL)' }, engine: { type: 'string', description: 'sqlite (default) | postgres' } }, required: ['query'] };

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    try {
      const ws = context.workspaceRoot;
      const query = str(input, 'query').trim().replace(/;\s*$/, '');
      if (!query) return { success: false, error: 'query is required' };
      if (/;\s*\S/.test(str(input, 'query'))) return { success: false, error: 'Multiple statements rejected — run one query at a time' };
      const forbidden = /^\s*(insert|update|delete|drop|alter|truncate|create|grant|revoke|vacuum|reindex|replace|merge|copy)\b/i;
      if (forbidden.test(query)) return { success: false, error: `Refused: '${query.split(/\s+/)[0]}' is a write operation — this tool is read-only. Use a migration or the shell tool through the security pipeline instead.` };
      const engine = str(input, 'engine') || (str(input, 'database').startsWith('postgres') || process.env.DATABASE_URL && str(input, 'database') === 'DATABASE_URL' ? 'postgres' : 'sqlite');
      const denied = await context.permissions.check({ type: 'execute_command', description: `Read-only DB query`, risk: 'medium' });
      if (denied.allowed === false) return { success: false, error: `Permission denied: ${denied.reason}` };
      let command: string;
      if (engine === 'postgres') {
        const target = str(input, 'database') || 'DATABASE_URL';
        command = `psql "${target === 'DATABASE_URL' ? '$DATABASE_URL' : target}" -c ${JSON.stringify(query + ' LIMIT 200')}`;
      } else {
        const dbFile = str(input, 'database') || 'data.db';
        const abs = path.resolve(ws, dbFile);
        if (!abs.startsWith(path.resolve(ws))) return { success: false, error: 'database file must live in the workspace' };
        if (!(await fs.stat(abs).then(() => true).catch(() => false))) return { success: false, error: `SQLite file not found: ${dbFile}` };
        command = `sqlite3 ${JSON.stringify(dbFile)} ${JSON.stringify(query + ' LIMIT 200')}`;
      }
      const r = await runCaptured(command, { cwd: ws, timeout: 30000, signal: context.signal });
      return { success: r.ok, output: r.ok ? truncateOutput(r.stdout, 60) || '(empty result)' : truncateOutput(r.stderr, 30), metadata: { engine, exitCode: r.exitCode } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

export const WEB_API_TOOLS: Tool[] = [
  new HttpRequestTool(), new FetchDocsTool(), new WebSearchForErrorTool(), new DatabaseQueryTool(),
];
