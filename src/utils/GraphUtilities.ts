/** Graph and plan helpers (functions 421–440). */

import { createHash } from 'node:crypto';

export interface GraphNode {
  id: string;
  title?: string;
  description?: string;
  dependencies?: string[];
  status?: string;
  estimatedTokens?: number;
  estimatedMinutes?: number;
  risk?: number;
  module?: string;
  [key: string]: unknown;
}

export interface PlanGraph {
  title: string;
  description?: string;
  nodes: GraphNode[];
  [key: string]: unknown;
}

export type DependencyGraph = Record<string, string[]>;

function graphNodes(graph: DependencyGraph): string[] {
  return [...new Set([...Object.keys(graph), ...Object.values(graph).flat()])];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map(key => [
        key,
        stableValue((value as Record<string, unknown>)[key]),
      ]),
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

/** 421. Cluster ideas by cosine similarity, preserving input order. */
export function ideaClusterer(
  ideas: Array<{ id: string; title?: string; embedding: number[] }>,
  options: { similarityThreshold?: number } = {},
): Array<{ ideaIds: string[] }> {
  const threshold = options.similarityThreshold ?? 0.8;
  const parents = ideas.map((_, index) => index);
  const find = (index: number): number => {
    if (parents[index] !== index) parents[index] = find(parents[index]);
    return parents[index];
  };
  const join = (left: number, right: number): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parents[Math.max(a, b)] = Math.min(a, b);
  };
  const cosine = (a: number[], b: number[]): number => {
    const size = Math.max(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < size; i++) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      dot += x * y;
      normA += x * x;
      normB += y * y;
    }
    if (normA === 0 || normB === 0) return normA === normB ? 1 : 0;
    return dot / Math.sqrt(normA * normB);
  };
  for (let i = 0; i < ideas.length; i++) {
    for (let j = i + 1; j < ideas.length; j++) {
      if (cosine(ideas[i].embedding, ideas[j].embedding) >= threshold) join(i, j);
    }
  }
  const groups = new Map<number, string[]>();
  ideas.forEach((idea, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(idea.id);
    groups.set(root, group);
  });
  return [...groups.values()].map(ideaIds => ({ ideaIds }));
}

/** 422. Build a normalized adjacency map and report dangling references. */
export function dependencyGraphBuilder(
  entries: Array<{ id: string; dependencies?: string[] }>,
): {
  nodes: string[];
  adjacency: DependencyGraph;
  edges: Array<{ from: string; to: string }>;
  missingDependencies: Array<{ nodeId: string; dependencyId: string }>;
} {
  const declared = new Set(entries.map(entry => entry.id));
  const nodes: string[] = [];
  const adjacency: DependencyGraph = {};
  const edges: Array<{ from: string; to: string }> = [];
  const missingDependencies: Array<{ nodeId: string; dependencyId: string }> = [];
  const addNode = (id: string): void => {
    if (!nodes.includes(id)) nodes.push(id);
  };
  for (const entry of entries) {
    addNode(entry.id);
    const dependencies = unique(entry.dependencies ?? []);
    adjacency[entry.id] = dependencies;
    for (const dependencyId of dependencies) {
      addNode(dependencyId);
      edges.push({ from: entry.id, to: dependencyId });
      if (!declared.has(dependencyId)) missingDependencies.push({ nodeId: entry.id, dependencyId });
    }
  }
  for (const id of nodes) if (!(id in adjacency)) adjacency[id] = [];
  return { nodes, adjacency, edges, missingDependencies };
}

/** 423. Detect one deterministic closed cycle for every cyclic component. */
export function circularDependencyDetector(graph: DependencyGraph): {
  hasCycles: boolean;
  cycles: string[][];
} {
  const nodes = graphNodes(graph).sort((a, b) => a.localeCompare(b));
  let nextIndex = 0;
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (node: string): void => {
    index.set(node, nextIndex);
    lowLink.set(node, nextIndex++);
    stack.push(node);
    onStack.add(node);
    for (const neighbor of [...(graph[node] ?? [])].sort((a, b) => a.localeCompare(b))) {
      if (!index.has(neighbor)) {
        visit(neighbor);
        lowLink.set(node, Math.min(lowLink.get(node)!, lowLink.get(neighbor)!));
      } else if (onStack.has(neighbor)) {
        lowLink.set(node, Math.min(lowLink.get(node)!, index.get(neighbor)!));
      }
    }
    if (lowLink.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component.sort((a, b) => a.localeCompare(b)));
    }
  };
  for (const node of nodes) if (!index.has(node)) visit(node);

  const cycles: string[][] = [];
  for (const component of components) {
    const allowed = new Set(component);
    const start = component[0];
    const walk = (current: string, path: string[], visiting: Set<string>): string[] | undefined => {
      for (const neighbor of [...(graph[current] ?? [])].filter(id => allowed.has(id)).sort((a, b) => a.localeCompare(b))) {
        if (neighbor === start) return [...path, start];
        if (!visiting.has(neighbor)) {
          const result = walk(neighbor, [...path, neighbor], new Set([...visiting, neighbor]));
          if (result) return result;
        }
      }
      return undefined;
    };
    const cycle = walk(start, [start], new Set([start]));
    if (cycle) cycles.push(cycle);
  }
  cycles.sort((a, b) => a.join('\0').localeCompare(b.join('\0')));
  return { hasCycles: cycles.length > 0, cycles };
}

/** 424. Topologically order nodes after all of their prerequisites. */
export function topologicalSort(graph: DependencyGraph): string[] {
  const nodes = graphNodes(graph).sort((a, b) => a.localeCompare(b));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const result: string[] = [];
  const visit = (node: string, trail: string[]): void => {
    if (visiting.has(node)) {
      const start = trail.indexOf(node);
      throw new Error(`Cycle detected in dependency graph: ${[...trail.slice(start), node].join(' -> ')}`);
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dependency of [...(graph[node] ?? [])].sort((a, b) => a.localeCompare(b))) {
      visit(dependency, [...trail, node]);
    }
    visiting.delete(node);
    visited.add(node);
    result.push(node);
  };
  for (const node of nodes) visit(node, []);
  return result;
}

/** 425. Compare graph snapshots by node and edge additions/removals. */
export function graphDiffTracker(
  before: DependencyGraph,
  after: DependencyGraph,
): {
  addedNodes: string[];
  removedNodes: string[];
  addedEdges: Array<{ from: string; to: string }>;
  removedEdges: Array<{ from: string; to: string }>;
  changedNodes: string[];
} {
  const beforeNodes = new Set(graphNodes(before));
  const afterNodes = new Set(graphNodes(after));
  const edges = (graph: DependencyGraph): Array<{ from: string; to: string }> =>
    Object.keys(graph).flatMap(from => unique(graph[from] ?? []).map(to => ({ from, to })))
      .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const beforeEdges = edges(before);
  const afterEdges = edges(after);
  const edgeKey = (edge: { from: string; to: string }): string => `${edge.from}\0${edge.to}`;
  const beforeEdgeKeys = new Set(beforeEdges.map(edgeKey));
  const afterEdgeKeys = new Set(afterEdges.map(edgeKey));
  return {
    addedNodes: [...afterNodes].filter(node => !beforeNodes.has(node)).sort((a, b) => a.localeCompare(b)),
    removedNodes: [...beforeNodes].filter(node => !afterNodes.has(node)).sort((a, b) => a.localeCompare(b)),
    addedEdges: afterEdges.filter(edge => !beforeEdgeKeys.has(edgeKey(edge))),
    removedEdges: beforeEdges.filter(edge => !afterEdgeKeys.has(edgeKey(edge))),
    changedNodes: [],
  };
}

/** 426. Serialize a plan into stable, human-readable approval text. */
export function planApprovalSerializer(plan: PlanGraph): string {
  const lines = [`# ${plan.title}`];
  if (plan.description) lines.push('', plan.description);
  lines.push('', '## Tasks');
  const known = new Set(plan.nodes.map(node => node.id));
  for (const node of plan.nodes) {
    lines.push(`- ${node.title ?? node.id} (${node.id})`);
    if (node.description) lines.push(`  ${node.description}`);
    const dependencies = (node.dependencies ?? []).filter(id => known.has(id));
    if (dependencies.length) lines.push(`  Depends on: ${dependencies.join(', ')}`);
    if (node.status) lines.push(`  Status: ${node.status}`);
  }
  return lines.join('\n');
}

/** 427. Hash a plan's canonical JSON and increment the prior version number. */
export function planVersioner(
  plan: PlanGraph,
  history: Array<{ version: number; hash: string }> = [],
): { version: number; hash: string } {
  const hash = createHash('sha256').update(stableStringify(plan)).digest('hex');
  return { version: Math.max(0, ...history.map(version => version.version)) + 1, hash };
}

/** 428. Estimate token/time scope per task and aggregate plan totals. */
export function scopeEstimator(plan: PlanGraph): {
  totalTokens: number;
  totalMinutes: number;
  perNode: Record<string, { tokens: number; minutes: number }>;
} {
  const perNode: Record<string, { tokens: number; minutes: number }> = {};
  for (const node of plan.nodes) {
    const text = [node.title ?? '', node.description ?? ''].join(' ').trim();
    const guessedTokens = Math.max(5, Math.ceil(text.length / 4));
    const tokens = typeof node.estimatedTokens === 'number' && node.estimatedTokens >= 0
      ? node.estimatedTokens
      : guessedTokens;
    const minutes = typeof node.estimatedMinutes === 'number' && node.estimatedMinutes >= 0
      ? node.estimatedMinutes
      : tokens / 40;
    perNode[node.id] = { tokens, minutes };
  }
  const totalTokens = Object.values(perNode).reduce((sum, estimate) => sum + estimate.tokens, 0);
  const totalMinutes = Math.round(Object.values(perNode).reduce((sum, estimate) => sum + estimate.minutes, 0));
  return { totalTokens, totalMinutes, perNode };
}

function cloneValue<T>(value: T, seen = new Map<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value;
  const object = value as object;
  if (seen.has(object)) return seen.get(object) as T;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(object, copy);
    for (const item of value) copy.push(cloneValue(item, seen));
    return copy as T;
  }
  const copy = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  seen.set(object, copy);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    copy[key] = cloneValue((value as Record<string, unknown>)[key], seen);
  }
  return copy as T;
}

function freezeDeep(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const key of Object.keys(value)) freezeDeep((value as Record<string, unknown>)[key], seen);
  Object.freeze(value);
}

/** 429. Deep-copy and recursively freeze an interface contract. */
export function interfaceContractFreezer<T>(contract: T): T {
  const copy = cloneValue(contract);
  freezeDeep(copy);
  return copy;
}

/** 430. Report disallowed cross-module dependencies in a plan. */
export function moduleBoundaryValidator(
  plan: PlanGraph,
  options: { allowedDependencies?: Record<string, string[]> } = {},
): {
  valid: boolean;
  violations: Array<{
    from: string;
    to: string;
    fromModule: string;
    toModule: string;
    reason: string;
  }>;
} {
  const byId = new Map(plan.nodes.map(node => [node.id, node]));
  const violations: Array<{
    from: string;
    to: string;
    fromModule: string;
    toModule: string;
    reason: string;
  }> = [];
  for (const node of plan.nodes) {
    if (!node.module) continue;
    for (const dependencyId of node.dependencies ?? []) {
      const dependency = byId.get(dependencyId);
      if (!dependency?.module || dependency.module === node.module) continue;
      if (options.allowedDependencies?.[node.module]?.includes(dependency.module)) continue;
      violations.push({
        from: node.id,
        to: dependencyId,
        fromModule: node.module,
        toModule: dependency.module,
        reason: 'cross-module dependency is not allowed',
      });
    }
  }
  return { valid: violations.length === 0, violations };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 431. Export a dependency graph as Mermaid or simple escaped SVG. */
export function graphVisualizationExporter(
  graph: DependencyGraph,
  options: { format?: 'mermaid' | 'svg' } = {},
): string {
  const nodes = graphNodes(graph).sort((a, b) => a.localeCompare(b));
  const edges = Object.keys(graph).flatMap(from => (graph[from] ?? []).map(to => [from, to] as const))
    .sort(([a, b], [c, d]) => a.localeCompare(c) || b.localeCompare(d));
  if (options.format === 'svg') {
    const labels = nodes.map((node, index) =>
      `<text x="20" y="${30 + index * 24}">${escapeHtml(node)}</text>`,
    ).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${Math.max(40, 24 * nodes.length + 20)}">${labels}</svg>`;
  }
  const lines = ['graph TD'];
  for (const [from, to] of edges) lines.push(`  ${from} --> ${to}`);
  const connected = new Set(edges.flat());
  for (const node of nodes) if (!connected.has(node)) lines.push(`  ${node}`);
  return lines.join('\n');
}

/** 432. Convert a plan into an ordered list of actionable tasks. */
export function planToTaskListConverter(
  plan: PlanGraph,
): Array<{ id: string; title: string; description: string; dependencies: string[]; status: string }> {
  const byId = new Map(plan.nodes.map(node => [node.id, node]));
  const known = new Set(byId.keys());
  const adjacency: DependencyGraph = Object.fromEntries(plan.nodes.map(node => [
    node.id,
    (node.dependencies ?? []).filter(id => known.has(id)),
  ]));
  return topologicalSort(adjacency).map(id => {
    const node = byId.get(id)!;
    return {
      id,
      title: node.title ?? id,
      description: node.description ?? '',
      dependencies: [...(node.dependencies ?? [])],
      status: node.status ?? 'pending',
    };
  });
}

/** 433. Score declared risk and graph centrality, flagging high-risk tasks. */
export function riskScoreCalculator(
  plan: PlanGraph,
  options: { highRiskThreshold?: number } = {},
): { scores: Record<string, number>; highRiskNodes: string[]; overall: number } {
  const ids = new Set(plan.nodes.map(node => node.id));
  const incoming = new Map<string, number>();
  for (const node of plan.nodes) {
    for (const dependency of node.dependencies ?? []) {
      if (ids.has(dependency)) incoming.set(dependency, (incoming.get(dependency) ?? 0) + 1);
    }
  }
  const denominator = Math.max(1, plan.nodes.length - 1);
  const scores: Record<string, number> = {};
  for (const node of plan.nodes) {
    const risk = Math.max(0, Math.min(1, typeof node.risk === 'number' ? node.risk : 0));
    const degree = (incoming.get(node.id) ?? 0) + (node.dependencies ?? []).filter(id => ids.has(id)).length;
    const centrality = Math.min(1, degree / denominator);
    scores[node.id] = Math.min(1, risk * 0.8 + centrality * 0.2);
  }
  const values = Object.values(scores);
  const overall = values.length ? values.reduce((sum, score) => sum + score, 0) / values.length : 0;
  const threshold = options.highRiskThreshold ?? 0.6;
  return { scores, highRiskNodes: plan.nodes.filter(node => scores[node.id] >= threshold).map(node => node.id), overall };
}

/** 434. Return a new plan with one node's status changed. */
export function graphNodeStatusUpdater<T extends PlanGraph>(plan: T, nodeId: string, status: string): T {
  if (!plan.nodes.some(node => node.id === nodeId)) throw new Error(`Node '${nodeId}' not found`);
  return {
    ...plan,
    nodes: plan.nodes.map(node => node.id === nodeId ? { ...node, status } : { ...node }),
  } as T;
}

/** 435. Compare actual plan nodes, statuses and dependency edges to a baseline. */
export function planDriftDetector(planned: PlanGraph, actual: PlanGraph): {
  inSync: boolean;
  missingNodes: string[];
  unexpectedNodes: string[];
  statusChanges: Array<{ id: string; planned: string | undefined; actual: string | undefined }>;
  graphDiff: ReturnType<typeof graphDiffTracker>;
} {
  const actualIds = new Set(actual.nodes.map(node => node.id));
  const plannedIds = new Set(planned.nodes.map(node => node.id));
  const missingNodes = planned.nodes.filter(node => !actualIds.has(node.id)).map(node => node.id);
  const unexpectedNodes = actual.nodes.filter(node => !plannedIds.has(node.id)).map(node => node.id);
  const actualById = new Map(actual.nodes.map(node => [node.id, node]));
  const statusChanges = planned.nodes.flatMap(node => {
    const found = actualById.get(node.id);
    return found && node.status !== found.status
      ? [{ id: node.id, planned: node.status, actual: found.status }]
      : [];
  });
  const graphOf = (plan: PlanGraph): DependencyGraph => Object.fromEntries(
    plan.nodes.map(node => [node.id, [...(node.dependencies ?? [])]]),
  );
  const graphDiff = graphDiffTracker(graphOf(planned), graphOf(actual));
  const inSync = missingNodes.length === 0 && unexpectedNodes.length === 0
    && statusChanges.length === 0 && graphDiff.addedEdges.length === 0 && graphDiff.removedEdges.length === 0;
  return { inSync, missingNodes, unexpectedNodes, statusChanges, graphDiff };
}

/** 436. Extract the transitive dependency closure of selected graph roots. */
export function subgraphExtractor(
  graph: DependencyGraph,
  roots: string[],
): { nodes: Array<{ id: string }>; edges: Array<{ from: string; to: string }> } {
  const included = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const node = pending.shift()!;
    if (included.has(node)) continue;
    included.add(node);
    pending.push(...(graph[node] ?? []));
  }
  const ordered = graphNodes(graph).filter(node => included.has(node));
  for (const root of roots) if (!ordered.includes(root)) ordered.push(root);
  const edges = ordered.flatMap(from => (graph[from] ?? [])
    .filter(to => included.has(to)).map(to => ({ from, to })));
  return { nodes: ordered.map(id => ({ id })), edges };
}

/** 437. Three-way merge plan nodes and report conflicting field edits. */
export function graphMergeOnConflict(
  base: PlanGraph,
  ours: PlanGraph,
  theirs: PlanGraph,
  options: { conflictResolution?: 'ours' | 'theirs' | 'error' } = {},
): {
  graph: PlanGraph;
  conflicts: Array<{ nodeId: string; field: string; base: unknown; ours: unknown; theirs: unknown }>;
} {
  const baseById = new Map(base.nodes.map(node => [node.id, node]));
  const oursById = new Map(ours.nodes.map(node => [node.id, node]));
  const theirsById = new Map(theirs.nodes.map(node => [node.id, node]));
  const ids = unique([...ours.nodes.map(node => node.id), ...theirs.nodes.map(node => node.id), ...base.nodes.map(node => node.id)]);
  const conflicts: Array<{ nodeId: string; field: string; base: unknown; ours: unknown; theirs: unknown }> = [];
  const mergedNodes: GraphNode[] = [];
  const resolution = options.conflictResolution ?? 'ours';

  for (const id of ids) {
    const b = baseById.get(id);
    const o = oursById.get(id);
    const t = theirsById.get(id);
    if (!b) {
      if (o && t) {
        const merged: GraphNode = { id };
        for (const field of unique([...Object.keys(o), ...Object.keys(t)])) {
          const hasO = Object.hasOwn(o, field);
          const hasT = Object.hasOwn(t, field);
          if (hasO && hasT && !sameValue(o[field], t[field])) {
            conflicts.push({ nodeId: id, field, base: undefined, ours: o[field], theirs: t[field] });
            merged[field] = resolution === 'theirs' ? t[field] : o[field];
          } else if (hasO) merged[field] = o[field];
          else if (hasT) merged[field] = t[field];
        }
        mergedNodes.push(merged);
      } else if (o || t) mergedNodes.push({ ...(o ?? t)! });
      continue;
    }
    if (!o && !t) continue;
    if (!o || !t) {
      const surviving = (o ?? t)!;
      if (sameValue(surviving, b)) continue;
      conflicts.push({ nodeId: id, field: '$node', base: b, ours: o, theirs: t });
      if ((resolution === 'ours' && o) || (resolution === 'theirs' && t)) mergedNodes.push({ ...(resolution === 'ours' ? o : t)! });
      continue;
    }
    const merged: GraphNode = { id };
    const fields = unique([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)]).filter(field => field !== 'id');
    for (const field of fields) {
      const hasB = Object.hasOwn(b, field);
      const hasO = Object.hasOwn(o, field);
      const hasT = Object.hasOwn(t, field);
      const bv = b[field];
      const ov = o[field];
      const tv = t[field];
      const oChanged = hasO !== hasB || !sameValue(ov, bv);
      const tChanged = hasT !== hasB || !sameValue(tv, bv);
      if (oChanged && tChanged && (hasO !== hasT || !sameValue(ov, tv))) {
        conflicts.push({ nodeId: id, field, base: bv, ours: ov, theirs: tv });
        if (resolution === 'theirs' ? hasT : hasO) merged[field] = resolution === 'theirs' ? tv : ov;
      } else if (oChanged ? hasO : hasT) {
        merged[field] = oChanged ? ov : tv;
      } else if (hasB) {
        merged[field] = bv;
      }
    }
    mergedNodes.push(merged);
  }
  if (resolution === 'error' && conflicts.length > 0) throw new Error(`Merge conflict in ${conflicts.length} field(s)`);
  const graph: PlanGraph = { ...base, ...theirs, ...ours, nodes: mergedNodes };
  return { graph, conflicts };
}

/** 438. Find the longest weighted prerequisite path in a DAG. */
export function criticalPathFinder(
  graph: DependencyGraph,
  options: { durations?: Record<string, number> } = {},
): { path: string[]; duration: number } {
  const order = topologicalSort(graph);
  const best = new Map<string, { path: string[]; duration: number }>();
  for (const node of order) {
    let prefix: { path: string[]; duration: number } = { path: [], duration: 0 };
    for (const dependency of graph[node] ?? []) {
      const candidate = best.get(dependency);
      if (candidate && candidate.duration > prefix.duration) prefix = candidate;
    }
    const duration = options.durations?.[node] ?? 1;
    best.set(node, { path: [...prefix.path, node], duration: prefix.duration + duration });
  }
  let result: { path: string[]; duration: number } = { path: [], duration: 0 };
  for (const candidate of best.values()) if (candidate.duration > result.duration) result = candidate;
  return result;
}

/** 439. Select the latest dependency-closed completed work as a rollback point. */
export function planRollbackPoint(plan: PlanGraph): {
  rollbackNodeId: string | null;
  completedNodeIds: string[];
  pendingNodeIds: string[];
  snapshot: PlanGraph;
} {
  const byId = new Map(plan.nodes.map(node => [node.id, node]));
  const completed = (status: string | undefined): boolean =>
    status === 'done' || status === 'completed' || status === 'complete' || status === 'success';
  const safe = new Set<string>();
  for (const node of plan.nodes) {
    if (!completed(node.status)) continue;
    if ((node.dependencies ?? []).every(id => safe.has(id))) safe.add(node.id);
  }
  const completedNodeIds = plan.nodes.filter(node => safe.has(node.id)).map(node => node.id);
  const pendingNodeIds = plan.nodes.filter(node => !safe.has(node.id)).map(node => node.id);
  const rollbackNodeId = completedNodeIds.length ? completedNodeIds[completedNodeIds.length - 1] : null;
  const snapshotNodes = plan.nodes.filter(node => safe.has(node.id)).map(node => ({ ...node, dependencies: (node.dependencies ?? []).filter(id => safe.has(id)) }));
  const snapshot: PlanGraph = { ...plan, nodes: snapshotNodes };
  // Keep the lookup referenced here to make dangling dependency handling explicit.
  void byId;
  return { rollbackNodeId, completedNodeIds, pendingNodeIds, snapshot };
}

/** 440. Convert a dependency map to prerequisite-first injection order. */
export function graphToDependencyInjectionOrder(graph: DependencyGraph): string[] {
  return topologicalSort(graph);
}
