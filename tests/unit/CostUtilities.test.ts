import {
  billingAlertWebhook,
  budgetThresholdAlerter,
  cacheSavingsCalculator,
  costAnomalyDetector,
  costComparisonAcrossModels,
  costEfficiencyScorer,
  costForecastEstimator,
  costPerIdeaTracker,
  costPerModuleCalculator,
  costProjectionForRemainingWork,
  costRollupByTeamOrProject,
  dailyCostSummary,
  freeQuotaTracker,
  invoiceReconciler,
  perProviderCostBreakdown,
  tokenUsageAggregator,
  tokenWasteFromContextBloat,
  usageQuotaEnforcer,
  usageReportExporter,
  wastedTokenDetector,
  type UsageRecord,
} from '../../src/utils/CostUtilities.js';

const usage: UsageRecord[] = [
  { timestamp: '2025-02-01T09:00:00Z', provider: 'alpha', model: 'small', module: 'planner', team: 'core', project: 'agent', ideaId: 'idea-1', inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, cost: 0.12 },
  { timestamp: '2025-02-01T10:00:00Z', provider: 'beta', model: 'large', module: 'builder', team: 'core', project: 'agent', ideaId: 'idea-1', inputTokens: 50, outputTokens: 50, cost: 0.3 },
  { timestamp: '2025-02-02T10:00:00Z', provider: 'alpha', model: 'small', module: 'planner', team: 'research', project: 'ideas', ideaId: 'idea-2', inputTokens: 80, outputTokens: 20, cost: 0.08, retry: true },
];

describe('CostUtilities (500-functions category W)', () => {
  it('aggregates token totals and request counts', () => {
    expect(tokenUsageAggregator(usage)).toMatchObject({ inputTokens: 230, outputTokens: 90, totalTokens: 320, cachedInputTokens: 40, requestCount: 3 });
  });

  it('calculates costs grouped by module', () => {
    expect(costPerModuleCalculator(usage)).toEqual({ totalCost: 0.5, byModule: { planner: 0.2, builder: 0.3 } });
  });

  it('alerts when spend reaches a configurable budget fraction', () => {
    const alerts: unknown[] = [];
    expect(budgetThresholdAlerter(80, 100, { threshold: 0.75, onAlert: alert => alerts.push(alert) })).toMatchObject({ triggered: true, ratio: 0.8, remaining: 20 });
    expect(alerts).toHaveLength(1);
    expect(budgetThresholdAlerter(40, 100).triggered).toBe(false);
  });

  it('exports a deterministic JSON or escaped CSV usage report', () => {
    const csv = usageReportExporter([{ ...usage[0], module: 'plan,review' }], { format: 'csv' });
    expect(csv.split('\n')).toHaveLength(2);
    expect(csv).toContain('"plan,review"');
    expect(JSON.parse(usageReportExporter(usage, { format: 'json' }))).toHaveLength(3);
  });

  it('estimates total cost at the current spend rate for completed progress', () => {
    expect(costForecastEstimator(30, 0.25)).toEqual({ currentCost: 30, progress: 0.25, projectedTotalCost: 120, remainingCost: 90 });
  });

  it('breaks down request, token and spend totals by provider', () => {
    expect(perProviderCostBreakdown(usage)).toEqual({
      alpha: { requestCount: 2, tokens: 220, cost: 0.2 },
      beta: { requestCount: 1, tokens: 100, cost: 0.3 },
    });
  });

  it('finds retry or explicitly wasted records and totals their usage', () => {
    const waste = wastedTokenDetector(usage);
    expect(waste).toMatchObject({ count: 1, wastedTokens: 100, wastedCost: 0.08 });
    expect(waste.records).toEqual([usage[2]]);
    expect(wastedTokenDetector([{ retry: true, retryNecessary: true, inputTokens: 10 }]).count).toBe(0);
  });

  it('calculates savings from cached prompt tokens and a per-token rate', () => {
    expect(cacheSavingsCalculator(usage, 0.002)).toEqual({ cachedTokens: 40, savings: 0.08 });
  });

  it('flags records that exceed the historical median by the configured multiple', () => {
    const items: UsageRecord[] = [
      { cost: 1, model: 'm' }, { cost: 1, model: 'm' }, { cost: 10, model: 'm' },
    ];
    expect(costAnomalyDetector(items, { multiplier: 3 }).map(item => item.cost)).toEqual([10]);
  });

  it('summarizes cost by UTC calendar day', () => {
    expect(dailyCostSummary(usage)).toEqual({
      '2025-02-01': { requestCount: 2, tokens: 220, cost: 0.42 },
      '2025-02-02': { requestCount: 1, tokens: 100, cost: 0.08 },
    });
  });

  it('tracks total tokens and cost for each idea', () => {
    expect(costPerIdeaTracker(usage)).toEqual({
      totalCost: 0.5,
      ideas: {
        'idea-1': { requestCount: 2, tokens: 220, cost: 0.42 },
        'idea-2': { requestCount: 1, tokens: 100, cost: 0.08 },
      },
    });
  });

  it('sends billing alerts only through the injected transport', async () => {
    const sent: unknown[] = [];
    const result = await billingAlertWebhook({ budget: 100, spent: 120 }, async payload => { sent.push(payload); return 'accepted'; });
    expect(result).toBe('accepted');
    expect(sent).toEqual([{ budget: 100, spent: 120 }]);
  });

  it('scores useful output token efficiency without division-by-zero errors', () => {
    expect(costEfficiencyScorer([{ inputTokens: 80, outputTokens: 20, usefulOutputTokens: 10, cost: 0.2 }])).toEqual({ score: 0.1, usefulOutputTokens: 10, totalTokens: 100, costPerUsefulOutputToken: 0.02 });
    expect(costEfficiencyScorer([]).score).toBe(0);
  });

  it('enforces quota boundaries and reports remaining quota', () => {
    expect(usageQuotaEnforcer(75, 100)).toEqual({ allowed: true, used: 75, quota: 100, remaining: 25, exceededBy: 0 });
    expect(usageQuotaEnforcer(101, 100).allowed).toBe(false);
  });

  it('compares model costs, volume and unit efficiency', () => {
    expect(costComparisonAcrossModels(usage)).toEqual({
      small: { requestCount: 2, tokens: 220, cost: 0.2, costPerThousandTokens: 0.9090909090909091 },
      large: { requestCount: 1, tokens: 100, cost: 0.3, costPerThousandTokens: 3 },
    });
  });

  it('estimates wasted context tokens and their cost', () => {
    expect(tokenWasteFromContextBloat([{ inputTokens: 100, contextTokens: 100, requiredContextTokens: 60, inputCostPerToken: 0.01 }])).toEqual({ wastedTokens: 40, wastedCost: 0.4, records: 1 });
    expect(tokenWasteFromContextBloat([{ contextTokens: 20, requiredContextTokens: 40 }]).wastedTokens).toBe(0);
  });

  it('rolls costs up by team or project with request and token counts', () => {
    expect(costRollupByTeamOrProject(usage, 'team')).toEqual({
      core: { requestCount: 2, tokens: 220, cost: 0.42 },
      research: { requestCount: 1, tokens: 100, cost: 0.08 },
    });
  });

  it('tracks remaining free allowance before reporting billable overage', () => {
    expect(freeQuotaTracker(usage, 250)).toEqual({ quota: 250, used: 320, freeTokensRemaining: 0, billableTokens: 70, exceeded: true });
  });

  it('projects the cost of remaining work from current progress', () => {
    expect(costProjectionForRemainingWork(usage.slice(0, 2), 0.5)).toEqual({ currentCost: 0.42, progress: 0.5, projectedRemainingCost: 0.42, projectedTotalCost: 0.84 });
  });

  it('reconciles usage costs with the invoiced total and tolerance', () => {
    expect(invoiceReconciler(usage, 0.51, { tolerance: 0.02 })).toEqual({ expectedCost: 0.5, invoiceCost: 0.51, variance: 0.01, withinTolerance: true });
    expect(invoiceReconciler(usage, 0.7, { tolerance: 0.02 }).withinTolerance).toBe(false);
  });
});
