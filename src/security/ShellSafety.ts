import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * ShellSafety — command-level safety layer for every shell invocation.
 *
 *   - command allowlist (by first token) instead of a pure blacklist
 *   - explicit dangerous-command blocklist (rm -rf /, dd, mkfs, fork bomb)
 *   - shell metacharacter injection block (;, |, &&, backtick, $(...))
 *   - spawn uses array argv (parseCommand) — this module rejects commands
 *     that would need a shell to interpret
 *   - ownership/permission mutation review (chmod 777, chown, chgrp)
 *   - network exfil review (curl, wget, nc, ssh, scp …) — flagged, needs
 *     higher approval, never silently allowed
 *   - append-only command log with timestamp + result (this module persists;
 *     the tool records exit codes)
 *   - rate limit per session (commands/minute)
 *   - read-only vs mutation classification (shared with permission modes)
 *   - dry-run: preview() renders exactly what would run + risk verdicts
 */

export interface ShellSafetyOptions {
  /**
   * Command allowlist (first token, case-sensitive as typed). Empty list =
   * allow any non-blocklisted command (allowlist off). When non-empty, only
   * listed commands run.
   */
  allowlist?: string[];
  /** Max commands per rolling window. Default 30 per minute. */
  maxCommandsPerMinute?: number;
  /** Persist an append-only command log under the workspace. Default true. */
  logCommands?: boolean;
  /** Whether network commands are allowed at all (after review). Default false. */
  allowNetworkCommands?: boolean;
  /** Whether mutation commands are allowed. Default true (permission gate still applies). */
  allowMutations?: boolean;
}

export interface ShellVerdict {
  ok: boolean;
  /** Why the command was blocked (empty when ok). */
  reason?: string;
  /** Matched rule ids (audit trail). */
  rules: string[];
  /** 'readonly' | 'mutation' | 'network' — used for permission routing. */
  category: 'readonly' | 'mutation' | 'network';
}

const READONLY_COMMANDS = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'echo', 'grep', 'find', 'which', 'wc',
  'git', // classified per subcommand below
  'node', 'npm', 'npx', 'yarn', 'pnpm', 'python', 'python3', 'make', 'jq',
]);

const READONLY_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame']);

const MUTATION_FIRST_TOKENS = new Set([
  'rm', 'mv', 'cp', 'mkdir', 'touch', 'chmod', 'chown', 'chgrp', 'ln', 'truncate', 'sed', 'tee',
]);

const NETWORK_COMMANDS = new Set(['curl', 'wget', 'nc', 'netcat', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'telnet', 'ping', 'ping6', 'dig', 'nslookup']);

/** Dangerous patterns — never run, in any mode. */
const DANGEROUS_PATTERNS: Array<{ id: string; pattern: RegExp; why: string }> = [
  { id: 'rmrf-root', pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)*(-[a-zA-Z]*r[a-zA-Z]*\s+)*(\/|~|\$HOME|\*)(\s|$)/, why: 'recursive delete of root/home/glob' },
  { id: 'dd', pattern: /\bdd\s+if=/, why: 'raw disk write tool' },
  { id: 'mkfs', pattern: /\bmkfs(\.\w+)?\b/, why: 'filesystem formatting' },
  { id: 'forkbomb', pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, why: 'fork bomb' },
  { id: 'shutdown', pattern: /\b(shutdown|reboot|halt|poweroff|init\s+[06])\b/, why: 'host power control' },
  { id: 'wipe', pattern: /\b(shred|wipefs|blkdiscard)\b/, why: 'destructive disk utility' },
  { id: 'dev-sd', pattern: /\/dev\/(sd[a-z]|nvme\d|disk|mapper)\b/, why: 'raw device access' },
  { id: 'history-wipe', pattern: /(>\s*\.?bash_history|history\s+-c|unset\s+HISTFILE)/, why: 'history tampering' },
];

/** Shell metacharacters that only make sense inside a real shell. */
const METACHARACTER_PATTERN = /[;&|`$<>\n]|\$\(|\|\|/;

export class ShellSafety {
  private readonly allowlist: Set<string>;
  private readonly maxPerMinute: number;
  private readonly logCommands: boolean;
  private readonly allowNetwork: boolean;
  private readonly allowMutations: boolean;
  /** Rolling per-session counter. */
  private windowStart = 0;
  private windowCount = 0;

  constructor(options: ShellSafetyOptions = {}) {
    this.allowlist = new Set(options.allowlist ?? []);
    this.maxPerMinute = Math.max(1, options.maxCommandsPerMinute ?? 30);
    this.logCommands = options.logCommands ?? true;
    this.allowNetwork = options.allowNetworkCommands ?? false;
    this.allowMutations = options.allowMutations ?? true;
  }

  /** Full pre-flight verdict. Call before spawning anything. */
  review(command: string): ShellVerdict {
    const trimmed = command.trim();
    if (!trimmed) return { ok: false, reason: 'empty command', rules: ['empty'], category: 'readonly' };

    // Dangerous patterns first (fast fail).
    for (const rule of DANGEROUS_PATTERNS) {
      if (rule.pattern.test(trimmed)) {
        return { ok: false, reason: `dangerous command (${rule.why})`, rules: [rule.id], category: this.classify(trimmed) };
      }
    }

    // Metacharacter injection: with spawn(shell:false) these are
    // either literal (harmless-ish but never what the model intends) or an
    // injection attempt. Block unless every token is plain.
    if (METACHARACTER_PATTERN.test(trimmed)) {
      // Allow metachars that are clearly inside a quoted argument value.
      const withoutQuoted = trimmed.replace(/"[^"]*"|'[^']*'/g, '""');
      if (METACHARACTER_PATTERN.test(withoutQuoted)) {
        return { ok: false, reason: 'shell metacharacters (;, |, &&, backtick, $()) are not allowed — commands run without a shell', rules: ['metachar'], category: this.classify(trimmed) };
      }
    }

    const tokens = tokenize(trimmed);
    const program = tokens[0] ?? '';

    // Allowlist.
    if (this.allowlist.size > 0 && !this.allowlist.has(program)) {
      return { ok: false, reason: `'${program}' is not on the command allowlist`, rules: ['allowlist'], category: this.classify(trimmed) };
    }

    // Read-only vs mutation split.
    const category = this.classify(trimmed);
    if (category === 'network' && !this.allowNetwork) {
      return { ok: false, reason: `network command '${program}' is disabled (allowNetworkCommands=false)`, rules: ['network-disabled'], category };
    }
    if (category === 'mutation' && !this.allowMutations) {
      return { ok: false, reason: `mutation command '${program}' is disabled (allowMutations=false)`, rules: ['mutation-disabled'], category };
    }

    return { ok: true, rules: [], category };
  }

  /** Ownership/permission mutations need explicit review. */
  static isPermissionMutation(command: string): boolean {
    return /\b(chmod|chown|chgrp|setfacl|umask)\b/.test(command) || /chmod\s+(-[a-zA-Z]+\s+)*[0-7]{3,4}/.test(command);
  }

  /** Network/exfil review. Returns the reason a net command needs review. */
  static isNetworkCommand(command: string): boolean {
    const program = tokenize(command.trim())[0] ?? '';
    return NETWORK_COMMANDS.has(program);
  }

  /** Rate limit per session. True = within budget. */
  consumeSlot(): boolean {
    const now = Date.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (this.windowCount >= this.maxPerMinute) return false;
    this.windowCount++;
    return true;
  }

  get remainingThisMinute(): number {
    const now = Date.now();
    if (now - this.windowStart >= 60_000) return this.maxPerMinute;
    return Math.max(0, this.maxPerMinute - this.windowCount);
  }

  /** Append-only command log (timestamp + command; exit code appended by the tool). */
  async logExecution(workspaceRoot: string, entry: { command: string; exitCode: number | 'blocked'; durationMs?: number; category: string; rules?: string[] }): Promise<void> {
    if (!this.logCommands) return;
    const logPath = path.join(workspaceRoot, '.agent', 'logs', 'commands.log');
    const stamp = new Date().toISOString();
    const line = JSON.stringify({ time: stamp, ...entry }) + '\n';
    try {
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.appendFile(logPath, line, 'utf-8');
    } catch {
      /* best-effort logging */
    }
  }

  /** Dry-run preview: what would run, with which verdicts. */
  preview(command: string): string {
    const verdict = this.review(command);
    const lines = [
      `DRY-RUN (nothing executed)`,
      `  command : ${command}`,
      `  program : ${tokenize(command.trim())[0] ?? '(none)'}`,
      `  argv    : ${JSON.stringify(tokenize(command.trim()))}   ← spawn(shell:false)`,
      `  category: ${verdict.category}`,
      `  verdict : ${verdict.ok ? 'ALLOW (subject to permission gate + sandbox)' : `BLOCK — ${verdict.reason}`}`,
    ];
    if (ShellSafety.isPermissionMutation(command)) lines.push('  review  : ownership/permission mutation — needs elevated approval');
    if (ShellSafety.isNetworkCommand(command)) lines.push('  review  : network command — exfil review required');
    return lines.join('\n');
  }

  /** Shared classification used by permission routing. */
  private classify(command: string): 'readonly' | 'mutation' | 'network' {
    const tokens = tokenize(command);
    const program = tokens[0] ?? '';
    if (NETWORK_COMMANDS.has(program)) return 'network';
    if (program === 'git') {
      const sub = (tokens[1] ?? '').toLowerCase();
      if (READONLY_GIT_SUBCOMMANDS.has(sub)) return 'readonly';
      return 'mutation';
    }
    if (MUTATION_FIRST_TOKENS.has(program)) return 'mutation';
    if (READONLY_COMMANDS.has(program)) return 'readonly';
    return 'mutation'; // unknown programs are treated as mutations (conservative)
  }
}

/** Quote-aware tokenizer (shared semantics with ShellTool.parseCommand). */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) { tokens.push(current); current = ''; }
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}
