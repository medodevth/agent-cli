/**
 * SecretScanner — secrets must never leave the agent in the clear.
 *
 *   - redact secrets from logs and tool output before display
 *   - detect API key / token patterns in code the agent is about to commit
 *   - strip hard-coded credentials from anything destined for a prompt
 *   - mask secrets in error messages and stack traces
 *
 * Pattern list mirrors OutputChecker's redaction rules but adds entropy
 * filtering, .env-style assignments, and a `scanForCommit` API used by the
 * git_commit tool's pre-commit check.
 */

export interface SecretFinding {
  kind: string;
  /** Redacted preview (never the raw secret). */
  preview: string;
  line?: number;
}

/** One regex per secret family. `[REDACT:<kind>]` is the replacement form. */
const PATTERNS: Array<{ kind: string; pattern: RegExp; minEntropy?: number }> = [
  { kind: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'openai-key', pattern: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { kind: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'aws-secret', pattern: /[a-z0-9/+]{40}/g, minEntropy: 3.0 },
  { kind: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}/gi },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  { kind: 'generic-api-key-assign', pattern: /\b(api[_-]?key|apikey|secret|token|password|passwd|pwd|auth)\b\s*[:=]\s*['"]?[A-Za-z0-9+/_-]{12,}['"]?/gi },
  { kind: 'env-style-secret', pattern: /^\s*(AWS_SECRET_ACCESS_KEY|STRIPE_SECRET_KEY|SENDGRID_API_KEY|MAIL_PASSWORD|DB_PASSWORD|REDIS_PASSWORD)\s*=\s*\S+/gm },
];

/** Common false positives (placeholders, docs examples). Note: bare "example"
 *  is intentionally NOT ignored — AWS's documented example key ends with it. */
const PLACEHOLDER_VALUES = /(\bxxx+\b|your-|your_|your key|your[-_]?token|<[^>]+>|\$\{[^}]+\}|\{\{[^}]+\}\}|placeholder|dummy|changeme|redacted|\[REDACTED|process\.env|os\.environ|\bvoid\b|\bnull\b|\bundefined\b)/i;

/** Shannon entropy, lower-bounded to skip obvious junk like "aaaaaaaaaaaa". */
function shannonEntropy(text: string): number {
  const freq = new Map<string, number>();
  for (const ch of text) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export class SecretScanner {
  /**
   * Replace every detected secret with a typed marker.
   * Used for logs, memory writes, error messages, and tool output.
   */
  redact(text: string): { text: string; found: string[] } {
    if (!text) return { text: text ?? '', found: [] };
    const found = new Set<string>();
    let out = text;
    for (const rule of PATTERNS) {
      out = out.replace(rule.pattern, match => {
        // Entropy filter for generic assignments to avoid redacting prose.
        if (rule.minEntropy) {
          const value = match.split(/[:=]/).pop() ?? '';
          if (shannonEntropy(value) < rule.minEntropy) return match;
        }
        if (PLACEHOLDER_VALUES.test(match) && rule.kind !== 'private-key-block') return match;
        found.add(rule.kind);
        return `[REDACTED:${rule.kind}]`;
      });
    }
    return { text: out, found: [...found] };
  }

  /** Error/stack masking. */
  maskError(message: string): string {
    return this.redact(message).text;
  }

  /**
   * Scan full text (a file or a diff) for secrets that must not
   * be committed. Returns findings with 1-based line numbers.
   */
  scanForCommit(content: string): SecretFinding[] {
    const findings: SecretFinding[] = [];
    const lines = content.split('\n');
    for (const rule of PATTERNS) {
      const perLine = rule.pattern.flags.includes('m') || rule.kind === 'env-style-secret' || rule.kind === 'private-key-block';
      if (perLine) {
        // Multi-line or line-anchored: scan whole content, then map index → line.
        const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
        let m: RegExpExecArray | null;
        while ((m = regex.exec(content)) !== null) {
          if (PLACEHOLDER_VALUES.test(m[0]) && rule.kind !== 'private-key-block') continue;
          const before = content.slice(0, m.index);
          const line = before.split('\n').length;
          findings.push({ kind: rule.kind, preview: `[REDACTED:${rule.kind}]`, line });
          if (m.index === regex.lastIndex) regex.lastIndex++;
        }
      } else {
        for (let i = 0; i < lines.length; i++) {
          const lineRegex = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', ''));
          const m = lineRegex.exec(lines[i]);
          if (!m) continue;
          if (PLACEHOLDER_VALUES.test(m[0])) continue;
          findings.push({ kind: rule.kind, preview: `[REDACTED:${rule.kind}]`, line: i + 1 });
        }
      }
    }
    return findings;
  }

  /**
   * Pre-commit gate: scan every staged/changed file's content.
   * Returns human-readable blockers (empty = safe to commit).
   */
  async scanFilesForCommit(files: Array<{ path: string; content: string }>): Promise<string[]> {
    const blockers: string[] = [];
    for (const file of files) {
      const findings = this.scanForCommit(file.content);
      for (const f of findings) {
        blockers.push(`${file.path}:${f.line ?? '?'} — suspected ${f.kind}`);
      }
    }
    return blockers;
  }

  /** Strip hard-coded credentials from text destined for prompts. */
  sanitizeForPrompt(text: string): string {
    return this.redact(text).text;
  }
}
