import {
  circularDependencyDetector,
  criticalPathFinder,
  dependencyGraphBuilder,
  graphDiffTracker,
  graphMergeOnConflict,
  graphNodeStatusUpdater,
  graphToDependencyInjectionOrder,
  graphVisualizationExporter,
  ideaClusterer,
  interfaceContractFreezer,
  moduleBoundaryValidator,
  planApprovalSerializer,
  planDriftDetector,
  planRollbackPoint,
  planToTaskListConverter,
  planVersioner,
  riskScoreCalculator,
  scopeEstimator,
  subgraphExtractor,
  topologicalSort,
  type GraphNode,
  type PlanGraph,
} from '../../src/utils/GraphUtilities.js';

const plan = (nodes: GraphNode[], title = 'Demo plan'): PlanGraph => ({ title, nodes });

describe('ideaClusterer', () => {
  it('groups similar embeddings deterministically and keeps unrelated ideas separate', () => {
    const clusters = ideaClusterer([
      { id: 'db-a', title: 'database index', embedding: [1, 0] },
      { id: 'db-b', title: 'database query', embedding: [0.99, 0.01] },
      { id: 'ui', title: 'terminal interface', embedding: [0, 1] },
    ], { similarityThreshold: 0.9 });
    expect(clusters.map(cluster => cluster.ideaIds)).toEqual([['db-a', 'db-b'], ['ui']]);
  });
});

describe('dependencyGraphBuilder', () => {
  it('normalizes dependencies and reports dangling references', () => {
    expect(dependencyGraphBuilder([
      { id: 'app', dependencies: ['lib', 'missing'] },
      { id: 'lib', dependencies: [] },
    ])).toEqual({
      nodes: ['app', 'lib', 'missing'],
      adjacency: { app: ['lib', 'missing'], lib: [], missing: [] },
      edges: [{ from: 'app', to: 'lib' }, { from: 'app', to: 'missing' }],
      missingDependencies: [{ nodeId: 'app', dependencyId: 'missing' }],
    });
  });
});

describe('circularDependencyDetector', () => {
  it('returns a deterministic closed cycle path for each cyclic component', () => {
    expect(circularDependencyDetector({ a: ['b'], b: ['a'], c: [] })).toEqual({
      hasCycles: true,
      cycles: [['a', 'b', 'a']],
    });
    expect(circularDependencyDetector({ a: ['b'], b: [] }).hasCycles).toBe(false);
  });
});

describe('topologicalSort', () => {
  it('puts prerequisites before dependents and raises a typed cycle error', () => {
    expect(topologicalSort({ app: ['db'], db: [] })).toEqual(['db', 'app']);
    expect(() => topologicalSort({ a: ['b'], b: ['a'] })).toThrow(/cycle/i);
  });
});

describe('graphDiffTracker', () => {
  it('reports node and edge additions/removals between graph snapshots', () => {
    expect(graphDiffTracker({ a: ['b'], b: [] }, { a: ['c'], c: [] })).toEqual({
      addedNodes: ['c'], removedNodes: ['b'],
      addedEdges: [{ from: 'a', to: 'c' }], removedEdges: [{ from: 'a', to: 'b' }],
      changedNodes: [],
    });
  });
});

describe('planApprovalSerializer', () => {
  it('creates stable human-readable approval text with task and dependency details', () => {
    const text = planApprovalSerializer({
      title: 'Release', description: 'Ship safely',
      nodes: [{ id: 'deploy', title: 'Deploy', dependencies: ['test'] }, { id: 'test', title: 'Run tests' }],
    });
    expect(text).toContain('# Release');
    expect(text).toContain('Ship safely');
    expect(text).toContain('deploy');
    expect(text).toContain('test');
  });
});

describe('planVersioner', () => {
  it('creates a stable content hash and increments from prior versions', () => {
    const document = plan([{ id: 'a', title: 'Task A' }]);
    const first = planVersioner(document);
    expect(first.version).toBe(1);
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(planVersioner(document).hash).toBe(first.hash);
    expect(planVersioner(plan([{ id: 'a', title: 'Changed' }]), [first]).version).toBe(2);
  });
});

describe('scopeEstimator', () => {
  it('totals explicit token and time estimates and estimates missing token counts from text', () => {
    expect(scopeEstimator(plan([
      { id: 'a', description: 'write tests', estimatedTokens: 100, estimatedMinutes: 5 },
      { id: 'b', description: 'build module' },
    ]))).toMatchObject({ totalTokens: 105, totalMinutes: 5, perNode: { a: { tokens: 100, minutes: 5 }, b: { tokens: 5, minutes: 0.125 } } });
  });
});

describe('interfaceContractFreezer', () => {
  it('returns a detached, recursively frozen contract', () => {
    const contract = { name: 'Store', methods: [{ name: 'get', returns: 'Item' }] };
    const frozen = interfaceContractFreezer(contract);
    expect(frozen).not.toBe(contract);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.methods)).toBe(true);
    expect(Object.isFrozen(frozen.methods[0])).toBe(true);
    expect(() => (frozen.methods as Array<{ name: string }>).push({ name: 'set' })).toThrow();
    expect(contract.methods).toHaveLength(1);
  });
});

describe('moduleBoundaryValidator', () => {
  it('reports cross-module dependencies that are not explicitly allowed', () => {
    const result = moduleBoundaryValidator(plan([
      { id: 'ui', module: 'frontend', dependencies: ['db'] },
      { id: 'db', module: 'storage' },
    ]));
    expect(result.valid).toBe(false);
    expect(result.violations).toEqual([{ from: 'ui', to: 'db', fromModule: 'frontend', toModule: 'storage', reason: 'cross-module dependency is not allowed' }]);
    expect(moduleBoundaryValidator(plan([
      { id: 'ui', module: 'frontend', dependencies: ['db'] }, { id: 'db', module: 'storage' },
    ]), { allowedDependencies: { frontend: ['storage'] } }).valid).toBe(true);
  });
});

describe('graphVisualizationExporter', () => {
  it('exports deterministic Mermaid and escaped SVG graph representations', () => {
    const graph = { a: ['b'], b: [] };
    expect(graphVisualizationExporter(graph)).toContain('graph TD');
    expect(graphVisualizationExporter(graph, { format: 'mermaid' })).toContain('a --> b');
    expect(graphVisualizationExporter({ '<root>': [] }, { format: 'svg' })).toContain('&lt;root&gt;');
  });
});

describe('planToTaskListConverter', () => {
  it('converts plan nodes to prerequisite-first actionable tasks', () => {
    expect(planToTaskListConverter(plan([
      { id: 'ship', title: 'Ship it', dependencies: ['test'] },
      { id: 'test', title: 'Run tests', status: 'pending' },
    ]))).toEqual([
      { id: 'test', title: 'Run tests', description: '', dependencies: [], status: 'pending' },
      { id: 'ship', title: 'Ship it', description: '', dependencies: ['test'], status: 'pending' },
    ]);
  });
});

describe('riskScoreCalculator', () => {
  it('combines declared node risk with graph centrality and flags high-risk nodes', () => {
    const result = riskScoreCalculator(plan([
      { id: 'core', risk: 0.7 }, { id: 'app', dependencies: ['core'] }, { id: 'docs' },
    ]));
    expect(result.scores.core).toBeGreaterThan(result.scores.docs);
    expect(result.highRiskNodes).toContain('core');
    expect(result.overall).toBeGreaterThan(0);
  });
});

describe('graphNodeStatusUpdater', () => {
  it('updates one existing node without mutating the input graph', () => {
    const original = plan([{ id: 'a', status: 'pending' }, { id: 'b', status: 'pending' }]);
    const updated = graphNodeStatusUpdater(original, 'a', 'done');
    expect(updated.nodes.find(node => node.id === 'a')?.status).toBe('done');
    expect(original.nodes.find(node => node.id === 'a')?.status).toBe('pending');
    expect(() => graphNodeStatusUpdater(original, 'missing', 'done')).toThrow(/not found/i);
  });
});

describe('planDriftDetector', () => {
  it('reports missing, unexpected, status-drifted nodes and edge changes', () => {
    const result = planDriftDetector(
      plan([{ id: 'a', dependencies: ['b'], status: 'pending' }, { id: 'b', status: 'done' }]),
      plan([{ id: 'a', dependencies: ['c'], status: 'done' }, { id: 'c', status: 'done' }, { id: 'extra' }]),
    );
    expect(result.inSync).toBe(false);
    expect(result.missingNodes).toEqual(['b']);
    expect(result.unexpectedNodes).toEqual(['c', 'extra']);
    expect(result.statusChanges).toEqual([{ id: 'a', planned: 'pending', actual: 'done' }]);
    expect(result.graphDiff.addedEdges).toEqual([{ from: 'a', to: 'c' }]);
  });
});

describe('subgraphExtractor', () => {
  it('extracts the dependency closure of requested roots', () => {
    const extracted = subgraphExtractor({ app: ['auth'], auth: ['db'], db: [], docs: [] }, ['app']);
    expect(extracted.nodes.map(node => node.id)).toEqual(['app', 'auth', 'db']);
  });
});

describe('graphMergeOnConflict', () => {
  it('merges independent edits and exposes conflicting field edits with a stable resolution', () => {
    const base = plan([{ id: 'a', title: 'Original', description: 'base' }]);
    const ours = plan([{ id: 'a', title: 'Ours', description: 'base' }, { id: 'b' }]);
    const theirs = plan([{ id: 'a', title: 'Theirs', description: 'theirs' }]);
    const merged = graphMergeOnConflict(base, ours, theirs);
    expect(merged.graph.nodes.find(node => node.id === 'a')).toMatchObject({ title: 'Ours', description: 'theirs' });
    expect(merged.graph.nodes.map(node => node.id)).toContain('b');
    expect(merged.conflicts).toEqual([{ nodeId: 'a', field: 'title', base: 'Original', ours: 'Ours', theirs: 'Theirs' }]);
    expect(() => graphMergeOnConflict(base, ours, theirs, { conflictResolution: 'error' })).toThrow(/conflict/i);
  });

  it('propagates a deletion when the other branch left the base node unchanged', () => {
    const base = plan([{ id: 'keep', title: 'Keep' }, { id: 'remove', title: 'Remove' }]);
    const ours = plan([{ id: 'keep', title: 'Keep' }]);
    const theirs = plan([{ id: 'keep', title: 'Keep' }, { id: 'remove', title: 'Remove' }]);
    const merged = graphMergeOnConflict(base, ours, theirs);
    expect(merged.graph.nodes.map(node => node.id)).toEqual(['keep']);
    expect(merged.conflicts).toEqual([]);
  });
});

describe('criticalPathFinder', () => {
  it('finds the longest weighted prerequisite path and rejects cyclic graphs', () => {
    const result = criticalPathFinder({
      start: [], left: ['start'], right: ['start'], finish: ['left', 'right'],
    }, { durations: { start: 2, left: 3, right: 4, finish: 1 } });
    expect(result).toEqual({ path: ['start', 'right', 'finish'], duration: 7 });
    expect(() => criticalPathFinder({ a: ['b'], b: ['a'] })).toThrow(/cycle/i);
  });
});

describe('planRollbackPoint', () => {
  it('selects the latest safe completed node and snapshots dependency-closed completed work', () => {
    const result = planRollbackPoint(plan([
      { id: 'base', status: 'done' },
      { id: 'feature', status: 'done', dependencies: ['base'] },
      { id: 'deploy', status: 'pending', dependencies: ['feature'] },
    ]));
    expect(result.rollbackNodeId).toBe('feature');
    expect(result.completedNodeIds).toEqual(['base', 'feature']);
    expect(result.pendingNodeIds).toEqual(['deploy']);
    expect(result.snapshot.nodes.map(node => node.id)).toEqual(['base', 'feature']);
  });
});

describe('graphToDependencyInjectionOrder', () => {
  it('orders services after the dependencies they require', () => {
    expect(graphToDependencyInjectionOrder({ app: ['db', 'auth'], db: [], auth: ['db'] })).toEqual(['db', 'auth', 'app']);
  });
});
