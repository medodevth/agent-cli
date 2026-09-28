import { promises as fs } from 'fs';
import path from 'path';
import type { Server } from 'http';
import { jest } from '@jest/globals';
import app from '../../src/agent-server.js';

/**
 * HTTP-level tests for the agent server. They boot the real express app on an
 * ephemeral port (never 3000) and talk to it with fetch, so routing, validation
 * and the SSE handshake are exercised for real.
 *
 * Two invariants matter beyond the happy path:
 *  1. The credential never leaves the process — no endpoint echoes it and the
 *     persisted settings file must not contain key material.
 *  2. Persisted settings are the non-secret subset only, so a restart resumes
 *     provider/model/thinking level without ever writing a secret to disk.
 */

const SETTINGS_FILE = path.join(process.cwd(), '.agent', 'ui-settings.json');

let server: Server;
let base: string;
let settingsBackup: string | null = null;

beforeAll(async () => {
  // The server persists the non-secret UI settings next to the workspace; keep
  // the developer's own file intact by restoring it after the run.
  try {
    settingsBackup = await fs.readFile(SETTINGS_FILE, 'utf8');
  } catch {
    settingsBackup = null;
  }
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  // Node's fetch keeps an idle TCP socket in its pool. Close idle and active
  // test connections explicitly so the HTTP-surface test cannot leak a handle.
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (settingsBackup === null) {
    await fs.rm(SETTINGS_FILE, { force: true });
  } else {
    await fs.writeFile(SETTINGS_FILE, settingsBackup, 'utf8');
  }
});

describe('agent server HTTP surface', () => {

  it('reports provider settings without ever returning the key', async () => {
    const res = await fetch(`${base}/api/agent/settings`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(['anthropic', 'openai']).toContain(body.provider);
    expect(['off', 'low', 'medium', 'high']).toContain(body.thinkingLevel);
    expect(typeof body.hasApiKey).toBe('boolean');
    expect(JSON.stringify(body)).not.toMatch(/apiKey"\s*:/);
  });

  it('rejects an unknown provider', async () => {
    const res = await fetch(`${base}/api/agent/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'gemini' }),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toMatch(/provider/);
  });

  it('rejects an unknown thinking level', async () => {
    const res = await fetch(`${base}/api/agent/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thinkingLevel: 'extreme' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a base url that is not http(s)', async () => {
    const res = await fetch(`${base}/api/agent/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'ftp://relay.example' }),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toMatch(/http/);
  });

  it('accepts a thinking level and remembers it on disk without secrets', async () => {
    const res = await fetch(`${base}/api/agent/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thinkingLevel: 'high', model: 'claude-sonnet-4', provider: 'anthropic' }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.thinkingLevel).toBe('high');
    expect(body.model).toBe('claude-sonnet-4');
    expect(body.provider).toBe('anthropic');

    const persisted = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
    expect(persisted.thinkingLevel).toBe('high');
    expect(persisted.model).toBe('claude-sonnet-4');
    expect(Object.keys(persisted).sort()).toEqual(['baseUrl', 'model', 'provider', 'thinkingLevel']);
  });

  it('streams activity as server-sent events', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/agent/events`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const frame = new TextDecoder().decode(value);
    expect(frame.startsWith('data: ')).toBe(true);
    expect(frame).toMatch(/"type":"hello"/);
    controller.abort();
  });

  it('validates the run request body', async () => {
    const empty = await fetch(`${base}/api/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    expect(empty.status).toBe(400);

    const badAttachments = await fetch(`${base}/api/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi', attachments: 'nope' }),
    });
    expect(badAttachments.status).toBe(400);
    const body: any = await badAttachments.json();
    expect(body.error).toMatch(/attachments/);

    const badConfig = await fetch(`${base}/api/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi', config: { retry: 'yes' } }),
    });
    expect(badConfig.status).toBe(400);
    const badConfigBody: any = await badConfig.json();
    expect(badConfigBody.error).toMatch(/config\.retry/);
  });

  it('starts an agent run as a short-lived job request', async () => {
    // Never allow a real provider call during this HTTP-surface test. The job
    // still proves that the POST returns immediately and can be polled.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await fetch(`${base}/api/agent/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearApiKey: true }),
      });
      const started = await fetch(`${base}/api/agent/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'do something' }),
      });
      expect(started.status).toBe(202);
      const body: any = await started.json();
      expect(typeof body.jobId).toBe('string');
      expect(['queued', 'running', 'failed']).toContain(body.status);

      const polled = await fetch(`${base}/api/agent/run/${body.jobId}`);
      expect(polled.status).toBe(200);
      const job: any = await polled.json();
      expect(job.jobId).toBe(body.jobId);
      expect(['queued', 'running', 'failed']).toContain(job.status);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('reports status with usage counters even before the agent exists', async () => {
    const res = await fetch(`${base}/api/agent/status`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.usage).toBeDefined();
    expect(typeof body.usage.totalTokens).toBe('number');
  });

  it('serves the UI document with a policy that allows its own fonts', async () => {
    const res = await fetch(`${base}/agent-ui.html`);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') || '';
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("script-src 'unsafe-inline'");
  });
});
