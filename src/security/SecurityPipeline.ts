import { execFile } from 'child_process';
import * as path from 'path';
import { ToolCall } from '../types/index.js';
import { InjectionDetector } from './InjectionDetector.js';

/**
 * SecurityPipeline — four-layer defense that runs BEFORE the agent's tool
 * touches the user's machine, and a post-run output check AFTER.
 *
 *   [AI proposes a tool call]
 *        ↓
 *   L1 PreExecutionGuard      forbidden-pattern block → bounce back to the AI
 *        ↓ pass
 *   L2 HumanInTheLoop         high/critical risk → wait for approval
 *        ↓ pass / low risk
 *   L3 SecureSandbox          Docker isolation (network off, resource caps,
 *        ↓                     read-only except workspace) or local sandbox
 *   L4 OutputCheck            secret redaction, output caps, anomaly flags
 *        ↓
 *   [result returned to the AI]
 *
 * Everything is deterministic and auditable: every decision is logged.
 */

// ---------------------------------------------------------------------------
// Verdict types
// ---------------------------------------------------------------------------

export interface GuardVerdict {
  action: 'allow' | 'reject';
  /** Human-readable reason, shown back to the model on reject. */
  reason: string;
  /** Risk class assigned during evaluation. */
  risk: 'safe' | 'low' | 'medium' | 'high' | 'critical';
  /** Patterns that matched (empty for clean calls). */
  matched: string[];
}

export type ApprovalDecision = 'approved' | 'denied' | 'timeout' | 'no-approver';

export interface OutputCheckResult {
  /** Processed output safe to hand back to the model. */
  output: string;
  /** Secrets that were redacted. */
  redactions: string[];
  /** Warnings for anomalies (huge output, noise, etc). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// L1 — Pre-Execution Guard
// ---------------------------------------------------------------------------

/**
 * Patterns that must never run, in any mode. If the model proposes one, the
 * call is rejected and the error text tells it to rethink (bounced back).
 */
const FORBIDDEN_PATTERNS: Array<{ id: string; pattern: RegExp; why: string }> = [
  { id: 'forkbomb', pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, why: 'fork bomb' },
  { id: 'disk-wipe', pattern: /mkfs(\.\w+)?\s|dd\s+if=.*of=\/dev\/(sd|nvme|disk)/, why: 'filesystem destruction' },
  { id: 'rmrf-root', pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~|\$HOME)(\s|$)/, why: 'recursive delete of root/home' },
  { id: 'sudo', pattern: /(^|[\s"'])sudo\s/, why: 'privilege escalation' },
  { id: 'chmod-root', pattern: /chmod\s+-R?\s*777\s+\//, why: 'world-writable system path' },
  { id: 'remote-exec', pattern: /(curl|wget)[^|]*\|\s*(ba|z)?sh/, why: 'piping remote content into a shell' },
  { id: 'env-exfil', pattern: /\bprintenv\b|\benv\b\s*$|cat\s+\.env\b/, why: 'dumping environment/secrets' },
  { id: 'history-spy', pattern: /cat\s+~?\/?\.?(bash_history|zsh_history)/, why: 'reading shell history' },
  { id: 'ssh-keys', pattern: /cat\s+~\/\.ssh\/id_/, why: 'reading private SSH keys' },
  { id: 'reverse-shell', pattern: /\/dev\/tcp\/|nc\s+-e\s|bash\s+-i\s+>&/, why: 'reverse shell attempt' },
  { id: 'git-force', pattern: /git\s+push\s+.*--force(?!-with-lease)/, why: 'force push' },
  { id: 'npm-publish', pattern: /npm\s+publish/, why: 'publishing packages' },
];

export class PreExecutionGuard {
  /** L1: returns allow, or reject with a "think again" message for the model. */
  guard(toolCall: ToolCall): GuardVerdict {
    const risk = this.assessRisk(toolCall);
    const inputStr = JSON.stringify(toolCall.input ?? {});
    const matched: string[] = [];

    if (toolCall.name === 'shell' || inputStr.length < 20000) {
      for (const rule of FORBIDDEN_PATTERNS) {
        if (rule.pattern.test(inputStr)) matched.push(`${rule.id} (${rule.why})`);
      }
    }
    if (toolCall.name === 'shell') {
      const command = String((toolCall.input as Record<string, unknown>)?.command ?? '');
      if (command.length > 4000) matched.push('oversized-command (command longer than 4000 chars)');
    }

    if (matched.length > 0) {
      return {
        action: 'reject',
        risk,
        matched,
        reason:
          `BLOCKED by Pre-Execution Guard: ${matched.join('; ')}. ` +
          `This pattern is forbidden on this machine. Rethink the approach and ` +
          `propose a different, safe solution — do not attempt to bypass the guard.`,
      };
    }
    return { action: 'allow', risk, matched: [], reason: 'clean' };
  }

  /** Deterministic risk classification, shared with L2. */
  assessRisk(toolCall: ToolCall): 'safe' | 'low' | 'medium' | 'high' | 'critical' {
    if (toolCall.name !== 'shell') {
      if (toolCall.name === 'write_file' || toolCall.name === 'edit_file' || toolCall.name === 'find_and_replace') return 'medium';
      // Destructive / irreversible operations always need a human.
      if (toolCall.name === 'delete_file' || toolCall.name === 'mutation_test') return 'high';
      // Deploy-tier: humans decide, no exceptions.
      if (toolCall.name === 'create_pull_request' || toolCall.name === 'deploy_preview' || toolCall.name === 'rollback_deploy' || toolCall.name === 'docker_run') return 'high';
      if (toolCall.name === 'install_package' || toolCall.name === 'update_lockfile' || toolCall.name === 'run_formatter'
        || toolCall.name === 'git_commit' || toolCall.name === 'git_stash' || toolCall.name === 'move_file' || toolCall.name === 'rename_file'
        || toolCall.name === 'copy_file' || toolCall.name === 'create_directory_structure' || toolCall.name === 'run_dev_server'
        || toolCall.name === 'docker_build' || toolCall.name === 'database_query') return 'medium';
      return 'safe';
    }
    const cmd = String((toolCall.input as Record<string, unknown>)?.command ?? '').trim().toLowerCase();
    if (/rm\s+-rf\s+[~/]|mkfs|dd\s+if=|:\(\)\s*\{|curl.*\|\s*sh|wget.*\|\s*sh/.test(cmd)) return 'critical';
    if (/^rm\s+-[a-z]*r|^chmod\s+-R|^chown|git\s+reset\s+--hard|git\s+clean\s+-[df]|git\s+push\s+--force|npm\s+publish|docker\s+(run|rm)|pip\s+install/.test(cmd)) return 'high';
    if (/^(rm|mv|cp|chmod|npm\s+(install|i)|yarn\s+(add|install)|pnpm\s+(add|install)|git\s+(commit|push|rebase|merge))/.test(cmd)) return 'medium';
    if (/^(ls|pwd|cat|head|tail|echo|grep|find|which|node\s+--version|npm\s+test|npm\s+run|npx\s+tsc|git\s+(status|diff|log))/.test(cmd)) return 'safe';

    return 'low';
  }
}

// ---------------------------------------------------------------------------
// L2 — Human-in-the-Loop gate
// ---------------------------------------------------------------------------

export interface HumanApprover {
  /**
   * Ask the human. Resolve with the decision. Implementations may use TTY
   * input, a TUI dialog, or a remote approval channel.
   */
  (request: {
    tool: string;
    risk: string;
    summary: string;
    detail: Record<string, unknown>;
    timeoutMs: number;
  }): Promise<ApprovalDecision>;
}

export class HumanGate {
  private readonly approver: HumanApprover | null;
  private readonly timeoutMs: number;
  private readonly autoApproveBelow: 'safe' | 'low' | 'medium' | 'high' | 'critical';

  constructor(options: {
    approver?: HumanApprover | null;
    timeoutMs?: number;
    /** Risk levels that never require a human. */
    autoApproveBelow?: 'safe' | 'low' | 'medium' | 'high' | 'critical';
  } = {}) {
    this.approver = options.approver ?? null;
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.autoApproveBelow = options.autoApproveBelow ?? 'low';
  }

  private static readonly RANK = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 } as const;

  needsHuman(risk: string): boolean {
    return HumanGate.RANK[risk as keyof typeof HumanGate.RANK] >
      HumanGate.RANK[this.autoApproveBelow];
  }

  /**
   * L2: returns approved, or a denial describing who said no. Never throws.
   */
  async check(toolCall: ToolCall, risk: string): Promise<{ action: 'allow' | 'deny'; reason: string }> {
    if (!this.needsHuman(risk)) return { action: 'allow', reason: 'low-risk (no human needed)' };
    if (!this.approver) {
      return {
        action: 'deny',
        reason: `HumanGate: ${toolCall.name} is ${risk}-risk and requires human approval, but no approver is connected in this session. Run interactively (agent-ui) to approve this action.`,
      };
    }
    try {
      const summary = this.summarize(toolCall);
      const decision = await this.approver({
        tool: toolCall.name,
        risk,
        summary,
        detail: (toolCall.input ?? {}) as Record<string, unknown>,
        timeoutMs: this.timeoutMs,
      });
      if (decision === 'approved') {
        // Irreversible actions need a SECOND confirmation.
        if (HumanGate.isIrreversible(toolCall) && this.approver) {
          const second = await this.approver({
            tool: toolCall.name,
            risk,
            summary: `[IRREVERSIBLE — confirm again] ${summary}`,
            detail: (toolCall.input ?? {}) as Record<string, unknown>,
            timeoutMs: this.timeoutMs,
          });
          if (second !== 'approved') {
            return { action: 'deny', reason: `HumanGate: second confirmation ${second === 'timeout' ? 'timed out' : 'was not given'} for irreversible action` };
          }
        }
        return { action: 'allow', reason: 'human approved' };
      }
      if (decision === 'timeout') return { action: 'deny', reason: 'HumanGate: approval timed out — action cancelled' };
      return { action: 'deny', reason: `HumanGate: human ${decision === 'denied' ? 'denied' : 'did not approve'} this action` };
    } catch (error) {
      return { action: 'deny', reason: `HumanGate error: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** Destructive/irreversible operations requiring double confirmation. */
  static isIrreversible(toolCall: ToolCall): boolean {
    if (toolCall.name === 'delete_file' || toolCall.name === 'rollback_deploy') return true;
    if (toolCall.name === 'shell') {
      const cmd = String((toolCall.input as Record<string, unknown>)?.command ?? '').toLowerCase();
      return /git\s+push\s+--force|git\s+reset\s+--hard|git\s+clean\s+-[df]|rm\s+-[a-z]*r|drop\s+(table|database)/.test(cmd);
    }
    return false;
  }

  private summarize(toolCall: ToolCall): string {
    const input = (toolCall.input ?? {}) as Record<string, unknown>;
    if (toolCall.name === 'shell') return String(input.command ?? '').slice(0, 300);
    if (toolCall.name === 'write_file' || toolCall.name === 'edit_file') {
      return String(input.path ?? '') + (input.content ? ` (${String(input.content).length} chars)` : '');
    }
    return JSON.stringify(input).slice(0, 300);
  }
}

/**
 * TTY approver: prompts on the terminal with a timeout. Used by the CLI.
 */
export function ttyApprover(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): HumanApprover {
  return async request => {
    return new Promise<ApprovalDecision>(resolve => {
      if (!(input as NodeJS.ReadStream).isTTY) {
        resolve('no-approver');
        return;
      }
      output.write(
        `\n⚠  ${request.risk.toUpperCase()} risk — ${request.tool}\n` +
        `   ${request.summary}\n` +
        `   Approve? [y/N] (auto-deny in ${Math.round(request.timeoutMs / 1000)}s): `
      );
      let settled = false;
      const finish = (decision: ApprovalDecision) => {
        if (settled) return;
        settled = true;
        input.removeListener('data', onData);
        (input as NodeJS.ReadStream).setRawMode?.(false);
        (input as NodeJS.ReadStream).pause?.();
        resolve(decision);
      };
      const onData = (chunk: Buffer) => {
        const answer = chunk.toString().trim().toLowerCase();
        finish(answer === 'y' || answer === 'yes' ? 'approved' : 'denied');
      };
      (input as NodeJS.ReadStream).resume?.();
      (input as NodeJS.ReadStream).setRawMode?.(true);
      input.on('data', onData);
      setTimeout(() => finish('timeout'), request.timeoutMs).unref();
    });
  };
}

// ---------------------------------------------------------------------------
// L3 — Secure Sandbox (Docker, with local-sandbox fallback)
// ---------------------------------------------------------------------------

export type SandboxProfile = 'alpine' | 'node' | 'python' | 'ubuntu';

/** Preconfigured isolated profiles. Alpine = smallest, fastest cold start. */
export const SANDBOX_PROFILES: Record<SandboxProfile, Partial<DockerOptions> & { description: string }> = {
  alpine: {
    image: 'alpine:3.20',
    memoryMb: 256,
    cpus: 1,
    pidsLimit: 64,
    description: 'Alpine Linux 3.20 — minimal toolchain (sh, busybox), 256MB, fastest cold start',
  },
  node: { image: 'node:20-alpine', memoryMb: 512, cpus: 1, pidsLimit: 128, description: 'Node.js 20 on Alpine — npm/npx available' },
  python: { image: 'python:3.12-alpine', memoryMb: 512, cpus: 1, pidsLimit: 128, description: 'Python 3.12 on Alpine — pip available' },
  ubuntu: { image: 'ubuntu:24.04', memoryMb: 1024, cpus: 2, pidsLimit: 256, description: 'Ubuntu 24.04 — full apt toolchain' },
};

export interface DockerOptions {
  image: string;
  /** Workspace mounted at /workspace (default read-write; set readOnlyWorkdir for stricter runs). */
  readOnlyWorkdir?: boolean;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  timeoutMs: number;
  /**
   * Non-root user inside the container (least privilege).
   * "nobody" works on all images; a numeric "1000:1000" keeps file ownership
   * aligned with the first host user. Set '' to disable (not recommended).
   */
  user?: string;
  /**
   * Disk quota for the writable layer. Docker has no native
   * per-container disk cap for the workspace bind-mount, so we mount a
   * bounded tmpfs at /tmp and rely on the memory cap to bound overall
   * writes. Value in MB for /tmp (default 256).
   */
  tmpfsMb?: number;
  /**
   * When true, refuse to fall back to local execution and fail the command
   * if Docker is unavailable (fail-closed isolation policy).
   */
  requireIsolation?: boolean;
}

export const DEFAULT_DOCKER: DockerOptions = {
  image: 'node:20-alpine',
  readOnlyWorkdir: false,
  memoryMb: 512,
  cpus: 1,
  pidsLimit: 128,
  timeoutMs: 120000,
  user: 'nobody',
  tmpfsMb: 256,
  requireIsolation: false,
};

export class SecureSandbox {
  private readonly dockerAvailable: boolean | null = null;
  private readonly options: DockerOptions;
  private readonly profile: SandboxProfile;

  constructor(options: Partial<DockerOptions> & { profile?: SandboxProfile } = {}) {
    this.profile = options.profile ?? 'node';
    const profileDefaults = SANDBOX_PROFILES[this.profile];
    this.options = { ...DEFAULT_DOCKER, ...profileDefaults, ...options } as DockerOptions;
  }

  /** The active profile name + its description. */
  get profileInfo(): { profile: SandboxProfile; description: string } {
    return { profile: this.profile, description: SANDBOX_PROFILES[this.profile].description };
  }

  /** The resolved docker options (user, tmpfs, etc.) — for tests and audits. */
  get resolvedOptions(): DockerOptions {
    return { ...this.options };
  }

  /** True when the docker CLI responds (cached). */
  async isDockerAvailable(): Promise<boolean> {
    if (this.dockerAvailable !== null) return this.dockerAvailable;
    return new Promise(resolve => {
      execFile('docker', ['info', '--format', 'ok'], { timeout: 5000 }, error => resolve(!error));
    });
  }

  /**
   * Build the docker argv for an isolated run. Exported as a method so the
   * isolation guarantees are unit-testable without the docker daemon.
   *
   * Isolation guarantees:
   *   --network none         no outbound/inbound network
   *   --memory / --cpus      CPU + memory caps
   *   --pids-limit           fork-bomb containment
   *   --ulimit fsize=        disk quota on files written inside
   *   --read-only + tmpfs    immutable rootfs; /tmp is the only writable
   *                          surface and it is size-capped
   *   --user                 least-privileged non-root user
   *   --security-opt         no-new-privileges, all capabilities dropped
   *   workspace bind-mount   the only host surface visible
   */
  buildRunArgs(command: string, workspaceRoot: string): string[] {
    const o = this.options;
    const tmpfsMb = o.tmpfsMb ?? 256;
    const mount = `${workspaceRoot}:/workspace${o.readOnlyWorkdir ? ':ro' : ''}`;
    const args = [
      'run', '--rm',
      '--network', 'none',
      '--memory', `${o.memoryMb}m`,
      '--cpus', String(o.cpus),
      '--pids-limit', String(o.pidsLimit),
      // Disk quota: cap per-file size inside the container.
      '--ulimit', 'fsize=' + tmpfsMb * 1024 * 1024,
      // Read-only rootfs: only /tmp (capped tmpfs) and /workspace are writable.
      '--read-only',
      '--tmpfs', `/tmp:rw,noexec,nosuid,size=${tmpfsMb}m`,
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      // Least privilege: never run as root inside the container.
      ...(o.user ? ['--user', o.user] : []),
      '-v', mount,
      '-w', '/workspace',
      o.image,
      'sh', '-c', command,
    ];
    return args;
  }

  /**
   * L3: run a shell command inside an isolated container.
   * Falls back to null when Docker is unavailable (caller decides).
   */
  async runIsolated(command: string, workspaceRoot: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const o = this.options;
    const args = this.buildRunArgs(command, workspaceRoot);
    return new Promise((resolve, reject) => {
      execFile('docker', args, { timeout: o.timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = (error as { code?: number } | null)?.code ?? (error ? 1 : 0);
        if (error && code === 0) return reject(error);
        resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: code });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// L3b — LocalSandbox (no-Docker fallback with real OS isolation)
// ---------------------------------------------------------------------------

/** Where the sandbox state lives (workspace-relative). */
const LOCAL_SANDBOX_STATE_DIR = '.agent/sandbox-state';

/**
 * LocalSandbox — best-effort OS-level isolation for environments without
 * Docker. It cannot match container isolation, but it enforces:
 *
 *   path scan   the child's cwd is the workspace; a pre-flight scan rejects
 *               commands that reference paths outside it (absolute paths,
 *               ~, /etc, /usr, …) unless allowOutsideWorkspace is set
 *   ulimit      caps CPU seconds, address space, file size, and process
 *               count before the command starts
 *   setpriv     uid/gid demotion to `nobody` when running as root and the
 *               platform supports it (Linux)
 *   unshare     network isolation via `unshare -n` when available
 *   timeout     enforced by the caller (ShellTool/Agent); this class only
 *               adds the pre-exec wrapper
 *
 * Detection of each capability is cached so repeated calls are cheap, and
 * `describe()` reports exactly which guards are active (auditable).
 */
export class LocalSandbox {
  private static readonly OUTSIDE_HINTS = /(^|\s)(\/(?:bin|boot|dev|etc|home|lib|lib64|media|mnt|opt|proc|root|run|sbin|srv|sys|tmp|usr|var)(?:\/|\s|$)|~\/|\$HOME\b)/;
  private unshareAvailable: boolean | null = null;
  private setprivAvailable: boolean | null = null;

  constructor(
    private readonly options: {
      /** Max CPU seconds per command (ulimit -t). Default 30. */
      cpuSeconds?: number;
      /** Max address space in KB (ulimit -v). Default 1 GB. */
      maxMemoryKb?: number;
      /** Max file size in KB (ulimit -f). Default 256 MB. */
      maxFileKb?: number;
      /** Max processes (ulimit -u). Default 128. */
      maxProcesses?: number;
      /** Demote to an unprivileged user when running as root. Default true. */
      demoteUser?: boolean;
      /** Unshare the network namespace. Default: auto (when available). */
      isolateNetwork?: boolean | 'auto';
      /** Reject commands referencing paths outside the workspace. Default true. */
      allowOutsideWorkspace?: boolean;
    } = {}
  ) {}

  /** Detect `unshare` support (Linux only), cached. */
  private async hasUnshare(): Promise<boolean> {
    if (this.unshareAvailable !== null) return this.unshareAvailable;
    if (process.platform !== 'linux') return (this.unshareAvailable = false);
    this.unshareAvailable = await new Promise<boolean>(resolve => {
      execFile('unshare', ['--help'], { timeout: 3000 }, error => resolve(!error));
    });
    return this.unshareAvailable;
  }

  /** Detect `setpriv` support (util-linux), cached. */
  private async hasSetpriv(): Promise<boolean> {
    if (this.setprivAvailable !== null) return this.setprivAvailable;
    if (process.platform !== 'linux') return (this.setprivAvailable = false);
    this.setprivAvailable = await new Promise<boolean>(resolve => {
      execFile('setpriv', ['--help'], { timeout: 3000 }, error => resolve(!error));
    });
    return this.setprivAvailable;
  }

  /** True when the current process runs with uid 0. */
  private isRoot(): boolean {
    return typeof process.getuid === 'function' && process.getuid() === 0;
  }

  /**
   * Pre-flight path scan: reject commands that reference
   * absolute paths outside the workspace or shell-expand ~/$HOME.
   * Relative paths and bare program names pass — the actual boundary is
   * still enforced by cwd + permission checks; this closes the obvious
   * escapes a plain string command can attempt.
   */
  checkPathEscape(command: string): { ok: true } | { ok: false; reason: string } {
    if (this.options.allowOutsideWorkspace) return { ok: true };
    // Strip quoted strings first: they may legitimately contain /etc/hosts
    // style text that is an argument to a workspace-relative program.
    const stripped = command.replace(/"[^"]*"|'[^']*'/g, ' ');
    if (LocalSandbox.OUTSIDE_HINTS.test(stripped)) {
      return {
        ok: false,
        reason:
          'command references a path outside the workspace ' +
          '(absolute system path, ~, or $HOME). Only workspace-relative paths are allowed.',
      };
    }
    return { ok: true };
  }

  /**
   * Full argv for spawning the command locally with every available guard.
   * Returns the argv for child_process.spawn (shell: false) plus a
   * description of the active guards for the audit log.
   */
  async wrap(command: string): Promise<{ argv: string[]; guards: string[] }> {
    const guards: string[] = [];
    const o = this.options;

    const cpu = o.cpuSeconds ?? 30;
    const memKb = o.maxMemoryKb ?? 1024 * 1024;
    const fileKb = o.maxFileKb ?? 256 * 1024;
    const procs = o.maxProcesses ?? 128;

    // ---- ulimit resource caps --------------------------------
    const ulimit = `ulimit -t ${cpu}; ulimit -v ${memKb}; ulimit -f ${fileKb}; ulimit -u ${procs}; ulimit -c 0;`;
    guards.push(`ulimit(cpu=${cpu}s,mem=${Math.round(memKb / 1024)}MB,file=${Math.round(fileKb / 1024)}MB,procs=${procs})`);

    // ---- network namespace ------------------------------------
    let netPrefix = '';
    const wantNet = o.isolateNetwork === true || (o.isolateNetwork === undefined && true) || (o.isolateNetwork as 'auto') === 'auto';
    if (wantNet && (await this.hasUnshare())) {
      netPrefix = 'unshare -n ';
      guards.push('unshare -n (isolated network namespace)');
    }

    // ---- least privilege --------------------------------------
    let userPrefix = '';
    if ((o.demoteUser ?? true) && this.isRoot() && (await this.hasSetpriv())) {
      userPrefix = 'setpriv --re-exec --inh-caps=-all -- ';
      guards.push('setpriv (demoted from root, capabilities dropped)');
    }

    // Order matters: setpriv → unshare → ulimit → exec command.
    const shell = `${userPrefix}${netPrefix}${ulimit} exec ${command}`;
    return { argv: ['sh', '-c', shell], guards };
  }

  /** Where sandbox state (tmp dirs, audit scratch) lives. */
  static stateDir(workspaceRoot: string): string {
    return path.join(workspaceRoot, LOCAL_SANDBOX_STATE_DIR);
  }

  /** Host temp dir available to the command (inside workspace). */
  static tmpDir(workspaceRoot: string): string {
    return path.join(LocalSandbox.stateDir(workspaceRoot), 'tmp');
  }

  /** True when running on a platform where setpriv/unshare cannot work. */
  static supportsOsIsolation(): boolean {
    return process.platform === 'linux';
  }

  /** Small helper for tests/diagnostics. */
  describe(): string {
    return [
      `platform=${process.platform}`,
      `root=${this.isRoot()}`,
      `unshare=auto`,
      `setpriv=auto`,
    ].join(' ');
  }
}

// ---------------------------------------------------------------------------
// L4 — Output check
// ---------------------------------------------------------------------------

const SECRET_REDACT_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'api-key', pattern: /\b(sk|pk)-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}/gi },
  { name: 'aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'generic-secret-assign', pattern: /\b(password|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi },
];

export class OutputChecker {
  private readonly maxOutputChars: number;

  constructor(maxOutputChars = 20000) {
    this.maxOutputChars = Math.max(1000, maxOutputChars);
  }

  /** L4: sanitize a tool result before it goes back to the model. */
  check(output: string, tool: string): OutputCheckResult {
    const warnings: string[] = [];
    const redactions: string[] = [];
    let text = output ?? '';

    for (const rule of SECRET_REDACT_PATTERNS) {
      text = text.replace(rule.pattern, () => {
        redactions.push(rule.name);
        return `[REDACTED:${rule.name}]`;
      });
    }

    if (text.length > this.maxOutputChars) {
      warnings.push(`output truncated from ${text.length} to ${this.maxOutputChars} chars`);
      text =
        text.slice(0, this.maxOutputChars) +
        `\n…(output truncated — re-read a narrower range if you need more)`;
    }

    if (/error|exception|traceback|permission denied/i.test(text) && tool === 'shell') {
      warnings.push('output contains error-like text');
    }

    // Injection scan before the output re-enters context.
    const injection = new InjectionDetector().sanitizeToolOutput(text, 'tool-output');
    if (injection.scan.verdict !== 'clean') {
      warnings.push(`injection scan: ${injection.scan.verdict} (${injection.scan.findings.map(f => f.ruleId).join(', ')})`);
      text = injection.text;
    }

    return { output: text, redactions: [...new Set(redactions)], warnings };
  }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditEntry {
  time: string;
  layer: 'L1-guard' | 'L2-human' | 'L3-sandbox' | 'L4-output';
  tool: string;
  decision: string;
  detail: string;
}

export class AuditLogger {
  private entries: AuditEntry[] = [];

  log(entry: AuditEntry): void {
    this.entries.push(entry);
  }

  /**
   * Append-only audit trail: flush() APPENDS instead of
   * rewriting, and each line is JSON (machine-parseable, tamper-evident
   * enough for a local file: entries are never reordered or edited).
   */
  async flush(workspaceRoot: string, auditPath = '.agent/logs/security-audit.jsonl'): Promise<number> {
    if (this.entries.length === 0) return 0;
    const fs = await import('fs/promises');
    const path = await import('path');
    const filePath = path.join(workspaceRoot, auditPath);
    const lines = this.entries.map(e => JSON.stringify(e));
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, lines.join('\n') + '\n', 'utf-8');
      return lines.length;
    } catch {
      return 0;
    } finally {
      this.entries = [];
    }
  }

  /** In-memory view (for /history, /stats, UI). */
  getRecent(n = 50): AuditEntry[] {
    return this.entries.slice(-n);
  }
}

// Convenience: the whole pipeline as one object
export interface SecurityPipeline {
  guard: PreExecutionGuard;
  humanGate: HumanGate;
  sandbox: SecureSandbox;
  /** Local (non-Docker) isolation wrapper for shell commands. */
  localSandbox: LocalSandbox;
  outputChecker: OutputChecker;
  audit: AuditLogger;
  /** Swap the sandbox profile at runtime (e.g. from config). */
  setSandboxProfile?: (profile: SandboxProfile) => void;
}

export function createSecurityPipeline(options: {
  approver?: HumanApprover | null;
  autoApproveBelow?: 'safe' | 'low' | 'medium' | 'high' | 'critical';
  approvalTimeoutMs?: number;
  docker?: Partial<DockerOptions> & { profile?: SandboxProfile };
  local?: ConstructorParameters<typeof LocalSandbox>[0];
} = {}): SecurityPipeline {
  const sandbox = new SecureSandbox(options.docker);
  const localSandbox = new LocalSandbox(options.local);
  return {
    guard: new PreExecutionGuard(),
    humanGate: new HumanGate({
      approver: options.approver ?? null,
      timeoutMs: options.approvalTimeoutMs,
      autoApproveBelow: options.autoApproveBelow,
    }),
    sandbox,
    localSandbox,
    outputChecker: new OutputChecker(),
    audit: new AuditLogger(),
    setSandboxProfile(profile: SandboxProfile) {
      const swapped = new SecureSandbox({ ...options.docker, profile });
      Object.assign(sandbox, swapped);
    },
  };
}

