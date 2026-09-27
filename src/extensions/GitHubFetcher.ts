/**
 * Download extension files from GitHub.
 *
 * Deliberately API-only (no git clone, no tarball): a directory listing plus one
 * raw download per file is enough for the small text extensions this loads
 * (skills, plugin manifests, MCP configs), it needs no tar on the host, and it
 * works the same on every platform. GITHUB_TOKEN / GH_TOKEN raises the rate
 * limit when the user has one; anonymous requests still work for public repos.
 */

import { RemoteFile } from './types.js';

export interface GitHubRef {
  owner: string;
  repo: string;
  /** Branch, tag or commit. Defaults to the repo's default branch. */
  ref?: string;
  /** Directory inside the repo. Empty means the repo root. */
  path: string;
}

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 200;
const REQUEST_TIMEOUT_MS = 20_000;

export class GitHubError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GitHubError';
  }
}

/**
 * Parse the URL shapes people actually paste: a repo, a `tree`/`blob` deep link,
 * an SSH remote, or the bare `owner/repo` shorthand.
 */
export function parseGitHubUrl(input: string): GitHubRef {
  const raw = (input || '').trim();
  if (!raw) throw new GitHubError('A GitHub URL or owner/repo is required');

  // git@github.com:owner/repo.git
  const ssh = raw.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2], path: '' };

  const withoutProtocol = raw.replace(/^https?:\/\//, '').replace(/^www\./, '');
  if (withoutProtocol.startsWith('github.com/')) {
    const parts = withoutProtocol.slice('github.com/'.length).split('/').filter(Boolean);
    return fromParts(parts);
  }

  // owner/repo[/path...]
  const shorthand = raw.replace(/\.git$/, '').split('/').filter(Boolean);
  if (shorthand.length >= 2 && !raw.includes('://')) return fromParts(shorthand);

  throw new GitHubError(`Not a GitHub repository reference: ${raw}`);
}

function fromParts(parts: string[]): GitHubRef {
  if (parts.length < 2) throw new GitHubError(`Not a GitHub repository reference: ${parts.join('/')}`);
  const owner = parts[0];
  const repo = parts[1];
  // /tree/<ref>/<path...> and /blob/<ref>/<path...> carry an explicit ref; a
  // plain /owner/repo/<path> is treated as a path on the default branch.
  if (parts.length >= 4 && (parts[2] === 'tree' || parts[2] === 'blob')) {
    return { owner, repo, ref: parts[3], path: parts.slice(4).join('/') };
  }
  return { owner, repo, path: parts.slice(2).join('/') };
}

interface ContentEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  size?: number;
  download_url?: string | null;
}

function authHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'agent-cli-extensions',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function request(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: authHeaders(), signal: controller.signal });
    if (res.status === 403 || res.status === 429) {
      throw new GitHubError(
        'GitHub rate limit reached. Set GITHUB_TOKEN to raise the limit, or try again later.',
        res.status,
      );
    }
    if (res.status === 404) throw new GitHubError('Repository or path not found on GitHub', 404);
    if (!res.ok) throw new GitHubError(`GitHub responded ${res.status}`, res.status);
    return res;
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    if ((error as { name?: string }).name === 'AbortError') throw new GitHubError('GitHub request timed out');
    throw new GitHubError(`Could not reach GitHub: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Recursively list a directory of a repo, following the API's per-directory pages. */
async function listDirectory(ref: GitHubRef, dir: string, out: ContentEntry[]): Promise<void> {
  const suffix = dir ? `/${dir}` : '';
  const query = ref.ref ? `?ref=${encodeURIComponent(ref.ref)}` : '';
  const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/contents${suffix}${query}`;
  const res = await request(url);
  const body: unknown = await res.json();
  const entries = (Array.isArray(body) ? body : [body]) as ContentEntry[];
  for (const entry of entries) {
    if (entry.type === 'dir') {
      await listDirectory(ref, entry.path, out);
    } else if (entry.type === 'file') {
      out.push(entry);
    }
  }
}

/**
 * Download every text file under the reference, with paths relative to the
 * requested directory. Binary and oversized files are skipped rather than
 * corrupting the install.
 */
export async function fetchGitHubFiles(ref: GitHubRef, opts: { maxFiles?: number } = {}): Promise<RemoteFile[]> {
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  const entries: ContentEntry[] = [];
  await listDirectory(ref, ref.path, entries);
  if (entries.length === 0) {
    throw new GitHubError(`No files found at ${ref.owner}/${ref.repo}${ref.path ? '/' + ref.path : ''}`);
  }
  if (entries.length > maxFiles) {
    throw new GitHubError(`Refusing to install ${entries.length} files (limit ${maxFiles})`);
  }

  const prefix = ref.path ? `${ref.path}/` : '';
  const files: RemoteFile[] = [];
  for (const entry of entries) {
    if ((entry.size ?? 0) > MAX_FILE_BYTES) continue;
    if (!entry.download_url) continue;
    const res = await request(entry.download_url);
    const text = await res.text();
    // A NUL byte means binary; extensions here are text-only.
    if (text.includes('\u0000')) continue;
    files.push({ path: entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path, content: text });
  }
  if (files.length === 0) throw new GitHubError('No text files found to install');
  return files;
}

/** Convenience: parse + download in one step. */
export async function fetchFromGitHubUrl(url: string, opts: { maxFiles?: number } = {}): Promise<{ ref: GitHubRef; files: RemoteFile[] }> {
  const ref = parseGitHubUrl(url);
  const files = await fetchGitHubFiles(ref, opts);
  return { ref, files };
}
