/**
 * ShellUtilities — shell & process helpers (500-functions category F, 101-120).
 *
 * Argv-first execution (spawn with shell:false, never a shell string),
 * composed with the existing ShellSafety verdicts and LocalSandbox guards
 * instead of duplicating spawn logic. Pure helpers (checks, escaping,
 * exit-code interpretation) are dependency-free and unit-tested directly;
 * process helpers are tested against real short-lived commands.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseCommand } from '../tools/ShellTool.js';
import { ShellSafety } from '../security/ShellSafety.js';
import { LocalSandbox } from '../security/SecurityPipeline.js';

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Bytes piped to the child's stdin (used by pipelineComposer). */
  input?: string;
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class ExecError extends Error {
  stdout: string;
  stderr: string;
  exitCode: number;
  attempts = 1;
  timedOut = false;

  constructor(
    message: string,
    opts: { stdout?: string; stderr?: string; exitCode?: number; attempts?: number; timedOut?: boolean } = {},
  ) {
    super(message);
    this.name = 'ExecError';
    this.stdout = opts.stdout ?? '';
    this.stderr = opts.stderr ?? '';
    this.exitCode = opts.exitCode ?? 1;
    if (opts.attempts !== undefined) this.attempts = opts.attempts;
    this.timedOut = opts.timedOut ?? false;
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

function settleKill(child: ChildProcess): void {
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }, 5000).unref?.();
}

/** 101. Spawn with an argv array — never a shell string, shell:false always. */
export async function execSafe(
  program: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  if (!program) throw new Error('program is required');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<ExecResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(program, args, {
        cwd: options.cwd,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: options.env ? { ...process.env, ...options.env } : undefined,
      });
    } catch (error) {
      reject(new ExecError((error as Error).message, { stderr: (error as Error).message }));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (error: ExecError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      settleKill(child);
      reject(error);
    };
    const timeoutId = setTimeout(() => {
      fail(new ExecError(`Command timed out after ${timeoutMs}ms: ${program}`, { stdout, stderr, exitCode: 124, timedOut: true }));
    }, timeoutMs);
    const onAbort = (): void => {
      fail(new ExecError(`Command cancelled: ${program}`, { stdout, stderr, exitCode: 130 }));
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.input !== undefined && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    } else {
      child.stdin?.end();
    }
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.on('error', (error: Error) => {
      fail(new ExecError(`${program}: ${error.message}`, { stdout, stderr }));
    });
    child.on('close', (code: number | null) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        clearTimeout(timeoutId);
        options.signal?.removeEventListener('abort', onAbort);
        resolve({ stdout, stderr, exitCode: 0 });
      } else {
        fail(
          new ExecError(`Command failed with exit code ${code ?? 1}: ${program}`, {
            stdout,
            stderr,
            exitCode: code ?? 1,
          }),
        );
      }
    });
  });
}

export interface TimeoutOptions extends ExecOptions {
  timeoutMs: number;
}

/** 102. execSafe with a mandatory timeout; the error is flagged timedOut. */
export async function execWithTimeout(
  program: string,
  args: string[],
  options: TimeoutOptions,
): Promise<ExecResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive number');
  }
  return execSafe(program, args, options);
}

export interface RetryOptions extends ExecOptions {
  retries?: number;
  delayMs?: number;
}

export interface RetryResult extends ExecResult {
  attempts: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 103. Retry a failing command; throws the last ExecError with .attempts set. */
export async function execWithRetry(
  program: string,
  args: string[],
  options: RetryOptions = {},
): Promise<RetryResult> {
  const retries = options.retries ?? 3;
  const delayMs = options.delayMs ?? 100;
  if (!Number.isInteger(retries) || retries < 0) throw new Error('retries must be a non-negative integer');
  let lastError: ExecError | undefined;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const result = await execSafe(program, args, options);
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error as ExecError;
      lastError.attempts = attempt;
      if (attempt <= retries) await sleep(delayMs);
    }
  }
  throw lastError as ExecError;
}

export interface StreamOptions extends ExecOptions {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/** 104. Stream stdout/stderr chunks to callbacks while capturing the full result. */
export async function streamProcessOutput(
  program: string,
  args: string[],
  options: StreamOptions = {},
): Promise<ExecResult> {
  if (!program) throw new Error('program is required');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<ExecResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(program, args, {
        cwd: options.cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.env ? { ...process.env, ...options.env } : undefined,
      });
    } catch (error) {
      reject(new ExecError((error as Error).message, { stderr: (error as Error).message }));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (error: ExecError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      settleKill(child);
      reject(error);
    };
    const timeoutId = setTimeout(() => {
      fail(new ExecError(`Command timed out after ${timeoutMs}ms: ${program}`, { stdout, stderr, exitCode: 124, timedOut: true }));
    }, timeoutMs);
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      options.onStderr?.(text);
    });
    child.on('error', (error: Error) => {
      fail(new ExecError(`${program}: ${error.message}`, { stdout, stderr }));
    });
    child.on('close', (code: number | null) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        clearTimeout(timeoutId);
        resolve({ stdout, stderr, exitCode: 0 });
      } else {
        fail(
          new ExecError(`Command failed with exit code ${code ?? 1}: ${program}`, {
            stdout,
            stderr,
            exitCode: code ?? 1,
          }),
        );
      }
    });
  });
}

/** 105. Kill a process and its group (negative-pid group kill first, then pid). */
export function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('pid must be a positive integer');
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    /* not a group leader (or already gone) — fall through to pid kill */
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export interface SandboxExecResult extends ExecResult {
  ok: boolean;
  reason?: string;
  rules?: string[];
  guards?: string[];
}

/** 106. Run through ShellSafety review + LocalSandbox guards; blocked commands never spawn. */
export async function sandboxExec(
  command: string,
  options: { cwd: string; timeoutMs?: number },
): Promise<SandboxExecResult> {
  if (!options.cwd) throw new Error('cwd is required');
  const safety = new ShellSafety();
  const verdict = safety.review(command);
  if (!verdict.ok) {
    return { ok: false, stdout: '', stderr: verdict.reason ?? 'blocked', exitCode: 1, reason: verdict.reason, rules: verdict.rules };
  }
  const sandbox = new LocalSandbox();
  const { argv, guards } = await sandbox.wrap(command);
  const program = argv[0] as string;
  const args = argv.slice(1);
  try {
    const result = await execSafe(program, args, { cwd: options.cwd, timeoutMs: options.timeoutMs });
    return { ok: true, ...result, guards };
  } catch (error) {
    const execError = error as ExecError;
    return {
      ok: false,
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? execError.message,
      exitCode: execError.exitCode ?? 1,
      guards,
    };
  }
}

export interface CheckResult {
  ok: boolean;
  program: string;
  reason?: string;
}

/** 107. Pure allowlist check on the command's first token. */
export function whitelistCommandCheck(command: string, allowlist: string[]): CheckResult {
  const { program } = parseCommand(command);
  if (allowlist.includes(program)) return { ok: true, program };
  return { ok: false, program, reason: `'${program}' is not on the command allowlist` };
}

export interface BlacklistPattern {
  id: string;
  pattern: RegExp;
  why?: string;
}

/** 108. Pure blocklist check; returns the first matching pattern id. */
export function blacklistPatternCheck(
  command: string,
  patterns: BlacklistPattern[],
): { blocked: boolean; id?: string; why?: string } {
  for (const entry of patterns) {
    if (entry.pattern.test(command)) return { blocked: true, id: entry.id, why: entry.why };
  }
  return { blocked: false };
}

const DESTRUCTIVE_PATTERNS: BlacklistPattern[] = [
  { id: 'rmrf-root', pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)*(-[a-zA-Z]*r[a-zA-Z]*\s+)*(\/|~|\$HOME|\*)(?:\s|$)/, why: 'recursive delete of root/home/glob' },
  { id: 'dd', pattern: /\bdd\s+if=/, why: 'raw disk write tool' },
  { id: 'mkfs', pattern: /\bmkfs(\.\w+)?\b/, why: 'filesystem formatting' },
  { id: 'forkbomb', pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, why: 'fork bomb' },
  { id: 'shutdown', pattern: /\b(shutdown|reboot|halt|poweroff|init\s+[06])\b/, why: 'host power control' },
  { id: 'wipe', pattern: /\b(shred|wipefs|blkdiscard)\b/, why: 'destructive disk utility' },
  { id: 'raw-device', pattern: /\/dev\/(sd[a-z]|nvme\d|disk|mapper)\b/, why: 'raw device access' },
];

/** 109. Heuristic destructive-command detector (same dangerous core as ShellSafety). */
export function detectDestructiveCommand(command: string): { destructive: boolean; id?: string; why?: string } {
  const hit = blacklistPatternCheck(command, DESTRUCTIVE_PATTERNS);
  if (hit.blocked) return { destructive: true, id: hit.id, why: hit.why };
  return { destructive: false };
}

/** 110. Capture stdout+stderr as data — never throws on nonzero exit. */
export async function captureStdoutStderr(
  program: string,
  args: string[],
  options: ExecOptions = {},
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execSafe(program, args, options);
    return { ok: true, ...result };
  } catch (error) {
    const execError = error as ExecError;
    return {
      ok: false,
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? execError.message,
      exitCode: execError.exitCode ?? 1,
    };
  }
}

/** 111. Inject only allowlisted env vars over a base env (default: process.env). */
export function envVarInjector(
  vars: Record<string, string>,
  allowlist?: string[],
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const [key, value] of Object.entries(vars)) {
    if (!allowlist || allowlist.includes(key)) env[key] = value;
  }
  return env;
}

export interface ResourceLimits {
  cpuSeconds?: number;
  maxMemoryKb?: number;
  maxFileKb?: number;
  maxProcesses?: number;
}

/** 112. Build the ulimit prefix + human description (same caps as LocalSandbox). */
export function processResourceLimiter(limits: ResourceLimits = {}): { prefix: string; description: string } {
  const cpu = limits.cpuSeconds ?? 30;
  const memKb = limits.maxMemoryKb ?? 1024 * 1024;
  const fileKb = limits.maxFileKb ?? 256 * 1024;
  const procs = limits.maxProcesses ?? 128;
  const prefix = `ulimit -t ${cpu}; ulimit -v ${memKb}; ulimit -f ${fileKb}; ulimit -u ${procs}; ulimit -c 0;`;
  const description = `ulimit(cpu=${cpu}s,mem=${Math.round(memKb / 1024)}MB,file=${Math.round(fileKb / 1024)}MB,procs=${procs})`;
  return { prefix, description };
}

export interface HistoryEntry {
  command: string;
  exitCode: number | 'blocked';
  durationMs?: number;
  category?: string;
}

/** 113. Append one JSON command-history line (best-effort, never throws). */
export async function commandHistoryLogger(logFile: string, entry: HistoryEntry): Promise<void> {
  if (!logFile) throw new Error('logFile is required');
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n';
  try {
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    await fs.appendFile(logFile, line, 'utf-8');
  } catch {
    /* best-effort logging */
  }
}

const PROMPT_PATTERNS: RegExp[] = [
  /password\s*:\s*$/i,
  /\(\s*y\s*\/\s*n\s*\)/i,
  /\(yes\/no\)/i,
  /are you sure/i,
  /do you want to continue/i,
  /press (any key|enter)/i,
  /confirm/i,
  /\[y\/n\]/i,
  />\s*$/,
  />>>\s*$/,
  /\?\s*\(?\s*$/m,
];

/** 114. Heuristic: does trailing output look like an interactive prompt (would hang stdin)? */
export function interactivePromptDetector(output: string): boolean {
  const tail = output.slice(-300);
  return PROMPT_PATTERNS.some(pattern => pattern.test(tail));
}

export interface ExitInterpretation {
  ok: boolean;
  kind: string;
  message: string;
}

/** 115. Human-readable meaning of an exit code / termination signal. */
export function exitCodeInterpreter(exitCode: number, signal?: string): ExitInterpretation {
  if (signal) {
    return { ok: false, kind: 'signal', message: `Terminated by ${signal}${signal === 'SIGKILL' ? ' (killed — possibly OOM)' : ''}` };
  }
  switch (exitCode) {
    case 0:
      return { ok: true, kind: 'success', message: 'Command succeeded' };
    case 124:
      return { ok: false, kind: 'timeout', message: 'Command timed out (124)' };
    case 126:
      return { ok: false, kind: 'permission', message: 'Command not executable (126)' };
    case 127:
      return { ok: false, kind: 'not-found', message: 'Command not found (127)' };
    case 130:
      return { ok: false, kind: 'interrupted', message: 'Interrupted by Ctrl-C (130)' };
    case 137:
      return { ok: false, kind: 'killed', message: 'Killed — possibly out of memory (137)' };
    case 139:
      return { ok: false, kind: 'segfault', message: 'Segmentation fault (139)' };
    case 143:
      return { ok: false, kind: 'terminated', message: 'Terminated via SIGTERM (143)' };
    default:
      return { ok: false, kind: 'failure', message: `Command failed with exit code ${exitCode}` };
  }
}

/** 116. POSIX single-quote escaping for embedding one arg in a shell string. */
export function shellEscapeArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'"'"'`)}'`;
}

/** 117. Pipe stages together: stdout[i] becomes stdin[i+1]; rejects on first failing stage. */
export async function pipelineComposer(
  stages: string[][],
  options: ExecOptions = {},
): Promise<ExecResult> {
  if (stages.length === 0) throw new Error('at least one stage is required');
  let input: string | undefined;
  let last: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i] as string[];
    const program = stage[0] as string;
    if (!program) throw new Error(`stage ${i} has no program`);
    try {
      last = await execSafe(program, stage.slice(1), { ...options, input });
    } catch (error) {
      const execError = error as ExecError;
      throw new ExecError(`Pipeline stage ${i} (${program}) failed: ${execError.message}`, {
        stdout: execError.stdout,
        stderr: execError.stderr,
        exitCode: execError.exitCode,
      });
    }
    input = last.stdout;
  }
  return last;
}

export interface BackgroundJob {
  id: number;
  program: string;
  args: string[];
  pid?: number;
  status: 'running' | 'exited' | 'killed' | 'failed';
  exitCode?: number;
}

export interface BackgroundJobManager {
  start(program: string, args?: string[], options?: ExecOptions): BackgroundJob;
  list(): BackgroundJob[];
  get(id: number): BackgroundJob | undefined;
  kill(id: number, signal?: NodeJS.Signals): boolean;
  wait(id: number, timeoutMs?: number): Promise<BackgroundJob>;
}

interface JobRecord {
  job: BackgroundJob;
  child: ChildProcess;
  waiters: Array<{ resolve: (job: BackgroundJob) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>;
}

/** 118. Track detached-friendly background jobs: start/list/kill/wait. */
export function backgroundJobManager(): BackgroundJobManager {
  let nextId = 1;
  const jobs = new Map<number, JobRecord>();

  const finish = (record: JobRecord, status: BackgroundJob['status'], exitCode?: number): void => {
    record.job.status = status;
    if (exitCode !== undefined) record.job.exitCode = exitCode;
    for (const waiter of record.waiters.splice(0)) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve({ ...record.job });
    }
  };

  return {
    start(program: string, args: string[] = [], options: ExecOptions = {}): BackgroundJob {
      if (!program) throw new Error('program is required');
      const id = nextId++;
      const job: BackgroundJob = { id, program, args, status: 'running' };
      const child = spawn(program, args, {
        cwd: options.cwd,
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: options.env ? { ...process.env, ...options.env } : undefined,
      });
      job.pid = child.pid;
      const record: JobRecord = { job, child, waiters: [] };
      jobs.set(id, record);
      child.on('error', () => finish(record, 'failed', 1));
      child.on('exit', (code: number | null, signal: string | null) => {
        if (code === 0) finish(record, 'exited', 0);
        else if (signal) finish(record, 'killed', code ?? 1);
        else finish(record, 'failed', code ?? 1);
      });
      return { ...job };
    },

    list(): BackgroundJob[] {
      return [...jobs.values()].map(record => ({ ...record.job }));
    },

    get(id: number): BackgroundJob | undefined {
      const record = jobs.get(id);
      return record ? { ...record.job } : undefined;
    },

    kill(id: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
      const record = jobs.get(id);
      if (!record || record.job.status !== 'running') return false;
      try {
        record.child.kill(signal);
        return true;
      } catch {
        return false;
      }
    },

    wait(id: number, timeoutMs?: number): Promise<BackgroundJob> {
      const record = jobs.get(id);
      if (!record) return Promise.reject(new Error(`Unknown job id: ${id}`));
      if (record.job.status !== 'running') return Promise.resolve({ ...record.job });
      return new Promise<BackgroundJob>((resolve, reject) => {
        const waiter: { resolve: (job: BackgroundJob) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout } = { resolve, reject };
        if (timeoutMs !== undefined) {
          waiter.timer = setTimeout(() => {
            const index = record.waiters.indexOf(waiter);
            if (index >= 0) record.waiters.splice(index, 1);
            reject(new Error(`Timed out waiting for job ${id} after ${timeoutMs}ms`));
          }, timeoutMs);
          waiter.timer.unref?.();
        }
        record.waiters.push(waiter);
      });
    },
  };
}

/** 119. Liveness probe: true when the pid exists (EPERM counts as alive). */
export function processHealthCheck(pid: number): { alive: boolean; pid: number } {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('pid must be a positive integer');
  try {
    process.kill(pid, 0);
    return { alive: true, pid };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return { alive: true, pid };
    return { alive: false, pid };
  }
}

/** 120. Preview what would run: ShellSafety verdict + parsed argv, nothing executes. */
export function dryRunCommandPreview(command: string): string {
  const safety = new ShellSafety();
  return safety.preview(command);
}
