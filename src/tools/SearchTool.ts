import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool, ToolContext, ToolResult } from '../types/index.js';

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.cache']);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.tar', '.gz',
  '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.avi', '.mov', '.sqlite', '.db', '.wasm',
]);

interface SearchResult {
  file: string;
  line: number;
  content: string;
}

/** Input shape of search_code (mirrors its inputSchema). */
interface SearchInput { pattern?: string; regex?: boolean; caseSensitive?: boolean; directory?: string; filePattern?: string; maxResults?: number }

export class SearchCodeTool implements Tool {
  name = 'search_code';
  description =
    'Search for text patterns in files within the workspace. Use this to find function definitions, variable usage, imports, or any text pattern. Supports regex patterns, file filtering, and glob-style file patterns.';

  inputSchema = {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Text or regex pattern to search for',
      },
      filePattern: {
        type: 'string',
        description: 'File glob pattern (e.g., "*.ts", "src/**/*.js")',
      },
      directory: {
        type: 'string',
        description: 'Directory to search in (relative to workspace root, default: ".")',
      },
      regex: {
        type: 'boolean',
        description: 'Treat pattern as regex (default: false)',
      },
      caseSensitive: {
        type: 'boolean',
        description: 'Case sensitive search (default: true)',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return (default: 100)',
      },
    },
    required: ['pattern'],
  };

  async execute(input: SearchInput, context: ToolContext): Promise<ToolResult> {
    try {
      const pattern = String(input.pattern || '');
      if (!pattern) {
        return { success: false, error: 'Search pattern is required' };
      }

      const directory = input.directory || '.';
      const isRegex = input.regex ?? false;
      const caseSensitive = input.caseSensitive ?? true;
      const maxResults = Math.min(Math.max(Number(input.maxResults) || 100, 1), 1000);

      const searchDir = path.resolve(context.workspaceRoot, directory);
      const normalizedRoot = path.resolve(context.workspaceRoot) + path.sep;
      if (!searchDir.startsWith(normalizedRoot) && searchDir !== path.resolve(context.workspaceRoot)) {
        return { success: false, error: 'Search directory is outside workspace' };
      }

      let searchPattern: RegExp | null = null;
      if (isRegex) {
        try {
          searchPattern = new RegExp(pattern, caseSensitive ? '' : 'i');
        } catch (error) {
          return { success: false, error: `Invalid regex: ${error instanceof Error ? error.message : String(error)}` };
        }
      }

      const fileMatcher = this.buildFileMatcher(input.filePattern);

      const results: SearchResult[] = [];
      await this.searchDirectory(
        searchDir,
        context.workspaceRoot,
        pattern,
        searchPattern,
        caseSensitive,
        fileMatcher,
        results,
        maxResults
      );

      if (results.length === 0) {
        return { success: true, output: 'No matches found.' };
      }

      return {
        success: true,
        output: this.formatResults(results),
        metadata: {
          matchCount: results.length,
          truncated: results.length >= maxResults,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private buildFileMatcher(filePattern?: string): ((relativePath: string, fileName: string) => boolean) | null {
    if (!filePattern) {
      return null;
    }

    const normalized = filePattern.replace(/^\.\//, '');
    const regex = this.globToRegex(normalized);

    return (relativePath: string, fileName: string) => {
      return regex.test(relativePath) || regex.test(fileName);
    };
  }

  private globToRegex(glob: string): RegExp {
    let source = '';
    for (let i = 0; i < glob.length; i++) {
      const char = glob[i];
      if (char === '*') {
        if (glob[i + 1] === '*') {
          i++;
          if (glob[i + 1] === '/') {
            i++;
          }
          source += '.*';
        } else {
          source += '[^/]*';
        }
      } else if (char === '?') {
        source += '[^/]';
      } else {
        source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
    }
    return new RegExp(`^${source}$`);
  }

  private async searchDirectory(
    dirPath: string,
    workspaceRoot: string,
    pattern: string,
    searchPattern: RegExp | null,
    caseSensitive: boolean,
    fileMatcher: ((relativePath: string, fileName: string) => boolean) | null,
    results: SearchResult[],
    maxResults: number
  ): Promise<void> {
    if (results.length >= maxResults) {
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) {
        break;
      }

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          await this.searchDirectory(
            fullPath,
            workspaceRoot,
            pattern,
            searchPattern,
            caseSensitive,
            fileMatcher,
            results,
            maxResults
          );
        }
      } else if (entry.isFile()) {
        const relativePath = path.relative(workspaceRoot, fullPath);

        if (fileMatcher && !fileMatcher(relativePath, entry.name)) {
          continue;
        }

        if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          continue;
        }

        try {
          const stats = await fs.stat(fullPath);
          if (stats.size > 1024 * 1024) {
            continue;
          }

          await this.searchFile(
            fullPath,
            relativePath,
            pattern,
            searchPattern,
            caseSensitive,
            results,
            maxResults
          );
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  private async searchFile(
    filePath: string,
    relativePath: string,
    pattern: string,
    searchPattern: RegExp | null,
    caseSensitive: boolean,
    results: SearchResult[],
    maxResults: number
  ): Promise<void> {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (results.length >= maxResults) {
        break;
      }

      const line = lines[i];
      let matches = false;

      if (searchPattern) {
        matches = searchPattern.test(line);
        searchPattern.lastIndex = 0;
      } else {
        const searchLine = caseSensitive ? line : line.toLowerCase();
        const searchTerm = caseSensitive ? pattern : pattern.toLowerCase();
        matches = searchLine.includes(searchTerm);
      }

      if (matches) {
        results.push({
          file: relativePath,
          line: i + 1,
          content: line.trim(),
        });
      }
    }
  }

  private formatResults(results: SearchResult[]): string {
    const grouped = new Map<string, Array<{ line: number; content: string }>>();

    for (const result of results) {
      if (!grouped.has(result.file)) {
        grouped.set(result.file, []);
      }
      grouped.get(result.file)!.push({
        line: result.line,
        content: result.content,
      });
    }

    const output: string[] = [];

    for (const [file, matches] of grouped) {
      output.push(`\n${file}:`);
      for (const match of matches) {
        output.push(`  ${match.line}: ${match.content}`);
      }
    }

    return output.join('\n');
  }
}
