import { spawn } from 'child_process';
import { Tool, ToolContext, ToolResult } from '../types/index.js';
import { LocalSandbox } from '../security/SecurityPipeline.js';
import { ShellSafety } from '../security/ShellSafety.js';

/** Shared shell-execution core used by every tool that needs to run a
 *  command (quality gates, git flow, build/deploy). Same semantics as
 *  ShellTool: no shell interpolation, timeout + abort support.
 *  Exported for reuse; NOT a tool itself.
 *
 *  NOTE: this core does NOT apply the local-sandbox wrapper by itself —
 *  callers that want OS-level isolation pass their own argv (see
 *  ShellTool.executeCommand). Shared tools run curated, low-risk commands
 *  (git status, npm test, …) and rely on their own risk assessment. */
export async function runShellCommand(
  command: string,
  options: { cwd: string; timeout?: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { program, args } = parseCommand(command);
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: options.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const kill = (message: string, code: number) => { if (settled) return; settled = true; clearTimeout(timeoutId); child.kill('SIGTERM'); setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 5000); reject({ message, stdout, stderr, exitCode: code }); };
    const timeoutId = setTimeout(() => kill('Command timed out', 124), options.timeout ?? 120000);
    const onAbort = () => kill('Command cancelled', 130);
    if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('error', error => { if (settled) return; settled = true; clearTimeout(timeoutId); reject({ message: error.message, stdout, stderr, exitCode: 1 }); });
    child.on('close', code => {
      if (settled) return; settled = true; clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve({ stdout, stderr, exitCode: 0 });
      else reject({ message: `Command failed with exit code ${code}`, stdout, stderr, exitCode: code || 1 });
    });
  });
}

/** Parses a command string into program + args (quote-aware, no shell). */
export function parseCommand(command: string): { program: string; args: string[] } {
  const tokens: string[] = []; let current = ''; let quote: '"' | "'" | null = null;
  for (const char of command.trim()) { if (quote) { if (char === quote) quote = null; else current += char; } else if (char === '"' || char === "'") quote = char; else if (/\s/.test(char)) { if (current) { tokens.push(current); current = ''; } } else current += char; }
  if (current) tokens.push(current); if (!tokens.length) throw new Error('Empty command');
  return { program: tokens[0], args: tokens.slice(1) };
}

/** Uniform result for command-running tools: capture stderr as data, not an exception. */
export async function runCaptured(command: string, options: { cwd: string; timeout?: number; signal?: AbortSignal }): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  try {
    const r = await runShellCommand(command, options);
    return { ok: true, ...r };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string; exitCode?: number };
    return { ok: false, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message ?? String(error), exitCode: failure.exitCode ?? 1 };
  }
}

/** Truncate long command output for tool results. */
export function truncateOutput(output: string, maxLines = 500): string {
  const lines = output.split('\n');
  return lines.length > maxLines ? lines.slice(0, maxLines).join('\n') + `\n\n[... truncated ${lines.length - maxLines} lines ...]` : output;
}

/** Input shape of run_command (mirrors its inputSchema). */
interface ShellExecInput { command?: string; timeout?: number }

export class ShellTool implements Tool {
  name = 'shell';
  description = 'Execute a shell command in the workspace.';
  inputSchema = { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] };

  /** OS-level isolation wrapper for local (non-Docker) execution.
   *  Public so tests can swap in a stub. */
  localSandbox = new LocalSandbox();

  /** Command-level safety: allowlist/blocklist/metachar/rate-limit/log. */
  shellSafety = new ShellSafety();

  async execute(input: ShellExecInput, context: ToolContext): Promise<ToolResult> {
    const command = String(input.command || '');
    try {
      if (!command.trim()) return { success: false, error: 'Command is required' };

      // ---- Items 9–11, 16: allowlist / dangerous patterns / metachars /
      // per-minute rate limit — all before anything runs.
      const verdict = this.shellSafety.review(command);
      if (verdict.ok === false) {
        await this.shellSafety.logExecution(context.workspaceRoot, { command, exitCode: 'blocked', category: verdict.category, rules: verdict.rules });
        return { success: false, error: `Blocked by shell safety: ${verdict.reason}`, metadata: { command, blocked: 'shell-safety', rules: verdict.rules } };
      }
      if (this.shellSafety.consumeSlot() === false) {
        return { success: false, error: 'Rate limit: too many commands this minute (try again shortly)', metadata: { command, blocked: 'rate-limit' } };
      }

      // Permission/ownership mutations and network
      // commands always escalate to the permission manager as high risk.
      const escalation = ShellSafety.isPermissionMutation(command) || ShellSafety.isNetworkCommand(command);
      const risk = escalation ? this.escalate(this.assessCommandRisk(command)) : this.assessCommandRisk(command);

      // Refuse obvious out-of-workspace references before
      // anything else runs. Docker/local isolation enforces the rest.
      const escape = this.localSandbox.checkPathEscape(command);
      if (escape.ok === false) {
        await this.shellSafety.logExecution(context.workspaceRoot, { command, exitCode: 'blocked', category: verdict.category, rules: ['path-escape'] });
        return { success: false, error: `Blocked by local sandbox: ${escape.reason}`, metadata: { command, blocked: 'path-escape' } };
      }

      const permission = await context.permissions.check({ type: 'execute_command', description: `Execute: ${command}`, command, risk });
      if (permission.allowed === false) {
        await this.shellSafety.logExecution(context.workspaceRoot, { command, exitCode: 'blocked', category: verdict.category, rules: ['permission'] });
        return { success: false, error: `Permission denied: ${permission.reason}` };
      }
      const startedAt = Date.now();
      const result = await this.executeCommand(command, { cwd: context.workspaceRoot, timeout: Number(input.timeout) || 120000, signal: context.signal });
      // Append-only command log with timestamp + outcome.
      await this.shellSafety.logExecution(context.workspaceRoot, { command, exitCode: result.exitCode, durationMs: Date.now() - startedAt, category: verdict.category });
      return { success: true, output: this.formatOutput(result.stdout, result.stderr), metadata: { command, exitCode: result.exitCode, sandboxed: result.sandboxed, category: verdict.category } };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string; exitCode?: number };
      try { await this.shellSafety.logExecution(context.workspaceRoot, { command, exitCode: failure.exitCode ?? 1, category: 'mutation' }); } catch { /* best-effort */ }
      return { success: false, output: failure.stdout || '', error: failure.message || String(error), metadata: { command, exitCode: failure.exitCode || 1 } };
    }
  }

  /** Dry-run preview without executing. */
  dryRun(command: string): string {
    return this.shellSafety.preview(command);
  }

  private escalate(risk: 'safe' | 'low' | 'medium' | 'high' | 'critical'): 'safe' | 'low' | 'medium' | 'high' | 'critical' {
    const order: Array<'safe' | 'low' | 'medium' | 'high' | 'critical'> = ['safe', 'low', 'medium', 'high', 'critical'];
    const idx = order.indexOf(risk);
    return order[Math.min(idx + 1, order.length - 1)];
  }

  private parseCommand(command: string): { program: string; args: string[] } {
    const tokens: string[] = []; let current = ''; let quote: '"' | "'" | null = null;
    for (const char of command.trim()) { if (quote) { if (char === quote) quote = null; else current += char; } else if (char === '"' || char === "'") quote = char; else if (/\s/.test(char)) { if (current) { tokens.push(current); current = ''; } } else current += char; }
    if (current) tokens.push(current); if (!tokens.length) throw new Error('Empty command');
    return { program: tokens[0], args: tokens.slice(1) };
  }

  /**
   * Local execution with OS isolation:
   * the command runs via LocalSandbox.wrap() → ulimit resource caps,
   * optional `unshare -n` network namespace, optional setpriv demotion
   * from root — plus the mandatory timeout/abort handling below.
   */
  private async executeCommand(command: string, options: { cwd: string; timeout: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string; exitCode: number; sandboxed?: string }> {
    const { argv, guards } = await this.localSandbox.wrap(command);
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; let settled = false; let timedOut = false;
      const finishError = (message: string, exitCode: number) => { if (settled) return; settled = true; clearTimeout(timeoutId); reject({ message, stdout, stderr, exitCode }); };
      const kill = (message: string, code: number) => { if (settled) return; timedOut = code === 124; child.kill('SIGTERM'); setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 5000); finishError(message, code); };
      const timeoutId = setTimeout(() => kill('Command timed out', 124), options.timeout);
      const onAbort = () => kill('Command cancelled', 130);
      if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); }); child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
      child.on('error', error => finishError(error.message, 1));
      child.on('close', code => { if (settled) return; settled = true; clearTimeout(timeoutId); options.signal?.removeEventListener('abort', onAbort); if (timedOut) reject({ message: 'Command timed out', stdout, stderr, exitCode: 124 }); else if (code !== 0) reject({ message: `Command failed with exit code ${code}`, stdout, stderr, exitCode: code || 1 }); else resolve({ stdout, stderr, exitCode: code || 0, sandboxed: guards.join('+') }); });
    });
  }

  private assessCommandRisk(command: string): 'safe' | 'low' | 'medium' | 'high' | 'critical' { const cmd = command.trim().toLowerCase(); if (/rm\s+-rf\s+[~/]|sudo|dd\s+if=|mkfs|curl.*\|\s*sh|wget.*\|\s*sh/.test(cmd)) return 'critical'; if (/^rm\s+-r|chmod\s+-R|^chown|git\s+reset\s+--hard|git\s+clean\s+-[df]|docker\s+(run|rm)|npm\s+publish|pip\s+install/.test(cmd)) return 'high'; if (/^(rm|mv|cp|chmod|npm install|yarn install|git commit|git push|git rebase)/.test(cmd)) return 'medium'; if (/^(ls|pwd|cat|echo|git status|git diff|git log|npm test|npm run|node|python|grep|find|which)/.test(cmd)) return 'safe'; return 'low'; }
  private formatOutput(stdout: string, stderr: string): string { const parts = []; if (stdout.trim()) parts.push('STDOUT:\n' + this.truncateOutput(stdout)); if (stderr.trim()) parts.push('STDERR:\n' + this.truncateOutput(stderr)); return parts.join('\n\n') || '(no output)'; }
  private truncateOutput(output: string): string { const lines = output.split('\n'); return lines.length > 500 ? lines.slice(0, 500).join('\n') + `\n\n[... truncated ${lines.length - 500} lines ...]` : output; }
}
