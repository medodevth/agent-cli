import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * KnowledgeGraph — "the architect brain" (GraphRAG-style).
 *
 * Builds a cross-file knowledge graph of the codebase: files, exported and
 * local symbols, and the edges between them (imports, call sites, test
 * coverage links). It answers the question vector search cannot:
 *
 *   "If I change function X in auth.ts, what else breaks?"
 *   → impact(): direct callers, downstream transitive callers, affected
 *     tests, affected tables/routes detected by naming conventions.
 *
 * The graph is rebuilt incrementally per file (imports + symbol tables are
 * language-tolerant regex extraction) and persisted to
 * .agent/memory/graph/graph.json. Analysis runs silently alongside the
 * agent's work — the agent queries it like a senior engineer's mental map.
 */

export type NodeKind = 'file' | 'symbol' | 'test' | 'resource';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  filePath?: string;
  /** For resources: database/table/endpoint guess from naming. */
  resourceType?: 'database' | 'table' | 'endpoint' | 'env';
}

export interface GraphEdge {
  from: string;
  to: string;
  type: 'imports' | 'defines' | 'calls' | 'tests' | 'touches-resource';
}

interface GraphShape {
  version: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
  fileHashes: Record<string, string>;
}

const RESOURCE_PATTERNS: Array<{ pattern: RegExp; type: NonNullable<GraphNode['resourceType']> }> = [
  { pattern: /\b(db|database|mongo|postgres|mysql|sqlite|prisma|schema\.prisma)\b/i, type: 'database' },
  { pattern: /\b(table|collection|user_db|order_db)\b/i, type: 'table' },
  { pattern: /\/(api|routes?)\/|\b(GET|POST|PUT|DELETE)\s+\//, type: 'endpoint' },
  { pattern: /process\.env\.\w+|\benv\.\w+/i, type: 'env' },
];

export class KnowledgeGraph {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private fileHashes: Record<string, string> = {};
  private loaded = false;
  private seq = 0;

  constructor(private readonly graphPath = '.agent/memory/graph/graph.json') {}

  private storePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, this.graphPath);
  }

  private static hash(text: string): string {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return String(h);
  }

  private nodeId(kind: NodeKind, label: string, filePath?: string): string {
    return filePath ? `${kind}:${filePath}:${label}` : `${kind}:${label}`;
  }

  private ensureNode(node: Omit<GraphNode, 'id'>): string {
    const id = this.nodeId(node.kind, node.label, node.filePath);
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { ...node, id });
    }
    return id;
  }

  private addEdge(edge: GraphEdge): void {
    if (!this.edges.some(e => e.from === edge.from && e.to === edge.to && e.type === edge.type)) {
      this.edges.push(edge);
    }
  }

  async load(workspaceRoot: string): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.storePath(workspaceRoot), 'utf-8');
      const parsed = JSON.parse(raw) as GraphShape;
      if (parsed.version === 1) {
        this.nodes = new Map((parsed.nodes ?? []).map(n => [n.id, n]));
        this.edges = parsed.edges ?? [];
        this.fileHashes = parsed.fileHashes ?? {};
      }
    } catch {
      this.nodes = new Map();
      this.edges = [];
      this.fileHashes = {};
    }
    this.loaded = true;
  }

  private async persist(workspaceRoot: string): Promise<void> {
    const filePath = this.storePath(workspaceRoot);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const payload: GraphShape = {
      version: 1,
      nodes: [...this.nodes.values()],
      edges: this.edges,
      fileHashes: this.fileHashes,
    };
    await fs.writeFile(filePath, JSON.stringify(payload), 'utf-8');
  }

  // -------------------------------------------------------------------------
  // Indexing (per file, incremental)
  // -------------------------------------------------------------------------

  /** Extracts imports, defined symbols, calls and resource hints from one file. */
  async indexFile(workspaceRoot: string, filePath: string, content: string): Promise<void> {
    await this.load(workspaceRoot);
    const hash = KnowledgeGraph.hash(content);
    if (this.fileHashes[filePath] === hash) return;

    // Clear previous file-scoped data.
    const doomedNodes = [...this.nodes.values()].filter(
      n => n.filePath === filePath || (n.kind === 'symbol' && this.edges.some(e => e.from === this.nodeId('file', filePath) && e.to === n.id))
    );
    for (const node of doomedNodes) this.nodes.delete(node.id);
    this.edges = this.edges.filter(
      e => !e.from.startsWith(`file:${filePath}`) && !e.to.includes(`:${filePath}:`)
    );

    const fileId = this.ensureNode({ kind: 'file', label: filePath, filePath });
    const lines = content.split('\n');
    const localSymbols = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // imports: import ... from './x' | require('./x')
      const importMatch = line.match(/(?:from\s+|require\()['"](\.[^'"]+)['"]/) || line.match(/import\s*\(\s*['"](\.[^'"]+)['"]/);
      if (importMatch) {
        const resolved = this.resolveImport(filePath, importMatch[1]);
        const targetId = this.ensureNode({ kind: 'file', label: resolved, filePath: resolved });
        this.addEdge({ from: fileId, to: targetId, type: 'imports' });
      }
      // exported/defined symbols
      const defMatch = line.match(/(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|def|func|fn|interface|type)\s+(\w+)/);
      if (defMatch) {
        const symbolId = this.ensureNode({ kind: 'symbol', label: defMatch[1], filePath });
        this.addEdge({ from: fileId, to: symbolId, type: 'defines' });
        localSymbols.add(defMatch[1]);
      }
      // test files link to the symbol they exercise (name-based)
      if (/(\.test\.|\.spec\.|_test\.|__tests__)/.test(filePath)) {
        // test-local symbols: no cross-file links are emitted for test files
      }
      // resource hints
      for (const rule of RESOURCE_PATTERNS) {
        if (rule.pattern.test(line)) {
          const resourceLabel = (line.match(rule.pattern)?.[0] ?? '').slice(0, 40);
          const resourceId = this.ensureNode({ kind: 'resource', label: resourceLabel, resourceType: rule.type });
          this.addEdge({ from: fileId, to: resourceId, type: 'touches-resource' });
          break;
        }
      }
    }

    // calls: occurrences of known symbols (from the symbol table) in this file
    for (const [, node] of this.nodes) {
      if (node.kind !== 'symbol' || node.filePath === filePath) continue;
      const callPattern = new RegExp(`\\b${node.label}\\s*\\(`);
      if (callPattern.test(content)) {
        this.addEdge({ from: fileId, to: node.id, type: 'calls' });
      }
    }

    // test linking: foo.test.ts → symbol foo (name convention)
    const testLink = filePath.match(/(\w+)\.(test|spec)\.[jt]sx?$/);
    if (testLink) {
      const symbolId = this.nodes.get(this.nodeId('symbol', testLink[1]));
      if (symbolId) this.addEdge({ from: fileId, to: symbolId.id, type: 'tests' });
    }

    this.fileHashes[filePath] = hash;
    await this.persist(workspaceRoot);
  }

  private resolveImport(fromFile: string, spec: string): string {
    const dir = path.dirname(fromFile);
    const candidates = [
      path.normalize(path.join(dir, spec)),
      path.normalize(path.join(dir, spec + '.ts')),
      path.normalize(path.join(dir, spec + '.js')),
      path.normalize(path.join(dir, spec, 'index.ts')),
    ];
    return candidates[0].replace(/\\/g, '/');
  }

  // -------------------------------------------------------------------------
  // Impact analysis — the GraphRAG answer vectors can't give
  // -------------------------------------------------------------------------

  /**
   * "If I change symbol X, what breaks?" → direct + transitive callers,
   * affected tests, and touched resources (databases/tables/endpoints).
   */
  async impact(workspaceRoot: string, symbolName: string): Promise<{
    symbol?: { label: string; filePath?: string };
    directCallers: string[];
    transitiveCallers: string[];
    affectedTests: string[];
    affectedResources: Array<{ label: string; type: string }>;
    summary: string;
  }> {
    await this.load(workspaceRoot);
    const symbolNode = [...this.nodes.values()].find(n => n.kind === 'symbol' && n.label === symbolName);
    if (!symbolNode) {
      return { directCallers: [], transitiveCallers: [], affectedTests: [], affectedResources: [], summary: `symbol '${symbolName}' is not in the graph — index the workspace first` };
    }

    // Files calling this symbol.
    const callerFiles = this.edges
      .filter(e => e.type === 'calls' && e.to === symbolNode.id)
      .map(e => this.nodes.get(e.from))
      .filter((n): n is GraphNode => !!n && n.kind === 'file');

    // Files importing the defining file (import-level coupling).
    const defineFileEdges = this.edges.filter(e => e.type === 'defines' && e.to === symbolNode.id);
    const definingFile = defineFileEdges.length ? this.nodes.get(defineFileEdges[0].from) : undefined;
    const importers = definingFile
      ? this.edges.filter(e => e.type === 'imports' && e.to === definingFile.id).map(e => this.nodes.get(e.from)).filter((n): n is GraphNode => !!n)
      : [];

    const direct = [...new Set([...callerFiles, ...importers].map(n => n.label))];

    // Transitive: one hop through files importing the direct callers.
    const transitive = new Set<string>();
    for (const callerLabel of direct) {
      const callerNode = this.nodes.get(this.nodeId('file', callerLabel));
      if (!callerNode) continue;
      for (const edge of this.edges) {
        if (edge.type === 'imports' && edge.to === callerNode.id) {
          const upstream = this.nodes.get(edge.from);
          if (upstream && !direct.includes(upstream.label)) transitive.add(upstream.label);
        }
      }
    }

    // Tests linked to this symbol or to the defining file.
    const affectedTests = this.edges
      .filter(e => e.type === 'tests' && (e.to === symbolNode.id || (definingFile && e.to === definingFile.id)))
      .map(e => this.nodes.get(e.from))
      .filter((n): n is GraphNode => !!n && /(\.test\.|\.spec\.|__tests__)/.test(n.label))
      .map(n => n.label);

    // Resources touched by the defining file and direct callers.
    const touchedResources = new Map<string, string>();
    for (const fileLabel of [definingFile?.label, ...direct].filter(Boolean) as string[]) {
      const fileNode = this.nodes.get(this.nodeId('file', fileLabel));
      if (!fileNode) continue;
      for (const edge of this.edges) {
        if (edge.type === 'touches-resource' && edge.from === fileNode.id) {
          const resource = this.nodes.get(edge.to);
          if (resource) touchedResources.set(resource.label, resource.resourceType ?? 'unknown');
        }
      }
    }

    const parts: string[] = [`'${symbolName}' (${symbolNode.filePath ?? '?'})`];
    if (direct.length) parts.push(`directly used by ${direct.length} file(s)`);
    if (transitive.size) parts.push(`${transitive.size} transitive file(s)`);
    if (affectedTests.length) parts.push(`${affectedTests.length} test file(s)`);
    if (touchedResources.size) parts.push(`resources: ${[...touchedResources.keys()].slice(0, 4).join(', ')}`);
    if (direct.length + transitive.size + affectedTests.length === 0) parts.push('no indexed dependents found');

    return {
      symbol: { label: symbolNode.label, filePath: symbolNode.filePath },
      directCallers: direct,
      transitiveCallers: [...transitive],
      affectedTests,
      affectedResources: [...touchedResources.entries()].map(([label, type]) => ({ label, type })),
      summary: `IMPACT: ${parts.join(' · ')}`,
    };
  }

  get stats(): { nodes: number; edges: number; files: number } {
    return { nodes: this.nodes.size, edges: this.edges.length, files: Object.keys(this.fileHashes).length };
  }
}
