/** Deterministic cost and token-use accounting over caller-supplied usage records. */

import { assignOwn, ownGet } from './SafeObject.js';

export interface UsageRecord {
  timestamp?: string | number | Date;
  provider?: string;
  model?: string;
  module?: string;
  team?: string;
  project?: string;
  ideaId?: string | number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cost?: number;
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  cachedInputCostPerToken?: number;
  retry?: boolean;
  retryNecessary?: boolean;
  unnecessaryRetry?: boolean;
  wasted?: boolean;
  contextTokens?: number;
  requiredContextTokens?: number;
  usefulOutputTokens?: number;
  [key: string]: unknown;
}

export interface UsageTotals {
  requestCount: number;
  tokens: number;
  cost: number;
}

function amount(value: number | undefined, field: string): number {
  const result = value ?? 0;
  if (!Number.isFinite(result) || result < 0) throw new Error(`${field} must be a non-negative finite number`);
  return result;
}

function inputTokensOf(record: UsageRecord): number {
  return amount(record.inputTokens, 'inputTokens');
}

function outputTokensOf(record: UsageRecord): number {
  return amount(record.outputTokens, 'outputTokens');
}

function tokenCountOf(record: UsageRecord): number {
  return inputTokensOf(record) + outputTokensOf(record);
}

function costOf(record: UsageRecord): number {
  if (record.cost !== undefined) return amount(record.cost, 'cost');
  const inputRate = amount(record.inputCostPerToken, 'inputCostPerToken');
  const outputRate = amount(record.outputCostPerToken, 'outputCostPerToken');
  return inputTokensOf(record) * inputRate + outputTokensOf(record) * outputRate;
}

function addTo<K extends string | number>(map: Record<string, UsageTotals>, key: K, record: UsageRecord): void {
  const name = String(key);
  const current = ownGet(map, name) ?? { requestCount: 0, tokens: 0, cost: 0 };
  current.requestCount += 1;
  current.tokens += tokenCountOf(record);
  current.cost += costOf(record);
  assignOwn(map, name, current);
}

function groupName(value: string | number | undefined): string {
  return value === undefined || value === '' ? 'unassigned' : String(value);
}

function sumCost(records: readonly UsageRecord[]): number {
  return records.reduce((total, record) => total + costOf(record), 0);
}

function sumTokens(records: readonly UsageRecord[]): number {
  return records.reduce((total, record) => total + tokenCountOf(record), 0);
}

/** 441. Aggregate input, output, cached tokens, and number of requests. */
export function tokenUsageAggregator(records: readonly UsageRecord[]): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  requestCount: number;
} {
  const totals = records.reduce<{ inputTokens: number; outputTokens: number; cachedInputTokens: number }>((sum, record) => {
    sum.inputTokens += inputTokensOf(record);
    sum.outputTokens += outputTokensOf(record);
    sum.cachedInputTokens += amount(record.cachedInputTokens, 'cachedInputTokens');
    return sum;
  }, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  return { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, cachedInputTokens: totals.cachedInputTokens, totalTokens: totals.inputTokens + totals.outputTokens, requestCount: records.length };
}

/** 442. Sum usage charges by module and return the grand total. */
export function costPerModuleCalculator(records: readonly UsageRecord[]): { totalCost: number; byModule: Record<string, number> } {
  const byModule: Record<string, number> = {};
  for (const record of records) {
    const name = groupName(record.module);
    assignOwn(byModule, name, (ownGet(byModule, name) ?? 0) + costOf(record));
  }
  return { totalCost: sumCost(records), byModule };
}

/** 443. Check a spend amount against a budget ratio and alert via an optional callback. */
export function budgetThresholdAlerter(
  spent: number,
  budget: number,
  options: { threshold?: number; onAlert?: (alert: { spent: number; budget: number; ratio: number; remaining: number }) => void } = {},
): { triggered: boolean; spent: number; budget: number; ratio: number; remaining: number } {
  amount(spent, 'spent');
  amount(budget, 'budget');
  const threshold = options.threshold ?? 0.8;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('threshold must be between 0 and 1');
  const ratio = budget === 0 ? (spent === 0 ? 0 : Infinity) : spent / budget;
  const remaining = Math.max(0, budget - spent);
  const triggered = budget === 0 ? spent > 0 : ratio >= threshold;
  if (triggered) options.onAlert?.({ spent, budget, ratio, remaining });
  return { triggered, spent, budget, ratio, remaining };
}

const REPORT_COLUMNS = [
  'timestamp', 'provider', 'model', 'module', 'team', 'project', 'ideaId',
  'inputTokens', 'outputTokens', 'cachedInputTokens', 'cost',
] as const;

function csvValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 444. Serialize usage records as JSON or deterministic CSV; performs no I/O. */
export function usageReportExporter(records: readonly UsageRecord[], options: { format?: 'json' | 'csv' } = {}): string {
  const format = options.format ?? 'json';
  if (format === 'json') return JSON.stringify(records);
  if (format !== 'csv') throw new Error(`Unsupported usage report format: ${String(format)}`);
  const allKeys = new Set(records.flatMap(record => Object.keys(record)));
  const columns = [
    ...REPORT_COLUMNS.filter(column => allKeys.has(column)),
    ...[...allKeys].filter(key => !(REPORT_COLUMNS as readonly string[]).includes(key)).sort(),
  ];
  // Include the stable standard schema even when records are empty or omit optional values.
  const headers = records.length === 0 ? [...REPORT_COLUMNS] : columns;
  const rows = records.map(record => headers.map(column => csvValue(record[column])).join(','));
  return [headers.join(','), ...rows].join('\n');
}

/** 445. Extrapolate final and remaining spend from current progress (0 < p <= 1). */
export function costForecastEstimator(currentCost: number, progress: number): {
  currentCost: number;
  progress: number;
  projectedTotalCost: number;
  remainingCost: number;
} {
  amount(currentCost, 'currentCost');
  if (!Number.isFinite(progress) || progress <= 0 || progress > 1) throw new Error('progress must be greater than 0 and at most 1');
  const projectedTotalCost = currentCost / progress;
  return { currentCost, progress, projectedTotalCost, remainingCost: projectedTotalCost - currentCost };
}

/** 446. Aggregate request volume, tokens, and cost by provider. */
export function perProviderCostBreakdown(records: readonly UsageRecord[]): Record<string, { requestCount: number; tokens: number; cost: number }> {
  const byProvider: Record<string, UsageTotals> = {};
  for (const record of records) addTo(byProvider, groupName(record.provider), record);
  return byProvider;
}

/** 447. Find explicitly wasted requests and retries not marked as necessary. */
export function wastedTokenDetector(records: readonly UsageRecord[]): {
  records: UsageRecord[];
  count: number;
  wastedTokens: number;
  wastedCost: number;
} {
  const wasted = records.filter(record => record.wasted === true || record.unnecessaryRetry === true || (record.retry === true && record.retryNecessary !== true));
  return { records: [...wasted], count: wasted.length, wastedTokens: sumTokens(wasted), wastedCost: sumCost(wasted) };
}

/** 448. Estimate savings from cached input tokens and a price per cached token. */
export function cacheSavingsCalculator(records: readonly UsageRecord[], ratePerToken?: number): { cachedTokens: number; savings: number } {
  if (ratePerToken !== undefined) amount(ratePerToken, 'ratePerToken');
  const cachedTokens = records.reduce((sum, record) => sum + amount(record.cachedInputTokens, 'cachedInputTokens'), 0);
  const savings = ratePerToken === undefined
    ? records.reduce((sum, record) => sum + amount(record.cachedInputTokens, 'cachedInputTokens') * amount(record.cachedInputCostPerToken ?? record.inputCostPerToken, 'cachedInputCostPerToken'), 0)
    : cachedTokens * ratePerToken;
  return { cachedTokens, savings };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 449. Return outlier costs relative to the leave-one-out median baseline. */
export function costAnomalyDetector<T extends UsageRecord>(records: readonly T[], options: { multiplier?: number; minimumExpectedCost?: number } = {}): Array<T & { expectedCost: number; anomalyRatio: number }> {
  const multiplier = options.multiplier ?? 3;
  const minimumExpectedCost = amount(options.minimumExpectedCost, 'minimumExpectedCost');
  if (!Number.isFinite(multiplier) || multiplier <= 0) throw new Error('multiplier must be positive');
  return records.flatMap((record, index) => {
    const actualCost = costOf(record);
    const baseline = median(records.filter((_, otherIndex) => otherIndex !== index).map(costOf));
    const expectedCost = Math.max(baseline, minimumExpectedCost);
    const anomalous = expectedCost === 0 ? actualCost > 0 : actualCost > expectedCost * multiplier;
    if (!anomalous) return [];
    return [{ ...record, expectedCost, anomalyRatio: expectedCost === 0 ? Infinity : actualCost / expectedCost }];
  });
}

function utcDay(timestamp: string | number | Date | undefined): string {
  if (timestamp === undefined) return 'unknown';
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid usage timestamp: ${String(timestamp)}`);
  return date.toISOString().slice(0, 10);
}

/** 450. Aggregate daily request counts, tokens, and costs in UTC. */
export function dailyCostSummary(records: readonly UsageRecord[]): Record<string, UsageTotals> {
  const result: Record<string, UsageTotals> = {};
  for (const record of records) addTo(result, utcDay(record.timestamp), record);
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

/** 451. Track spend and usage grouped by idea identifier. */
export function costPerIdeaTracker(records: readonly UsageRecord[]): { totalCost: number; ideas: Record<string, UsageTotals> } {
  const ideas: Record<string, UsageTotals> = {};
  for (const record of records) addTo(ideas, groupName(record.ideaId), record);
  return { totalCost: sumCost(records), ideas };
}

/** 452. Deliver a billing alert through a caller-provided transport only. */
export function billingAlertWebhook<T, R>(payload: T, transport: (payload: T) => R | Promise<R>): Promise<Awaited<R>> {
  return Promise.resolve(transport(payload));
}

/** 453. Score useful output tokens per total tokens and cost per useful token. */
export function costEfficiencyScorer(records: readonly UsageRecord[]): {
  score: number;
  usefulOutputTokens: number;
  totalTokens: number;
  costPerUsefulOutputToken: number;
} {
  const usefulOutputTokens = records.reduce((sum, record) => sum + amount(record.usefulOutputTokens, 'usefulOutputTokens'), 0);
  const totalTokens = sumTokens(records);
  const totalCost = sumCost(records);
  return {
    score: totalTokens === 0 ? 0 : usefulOutputTokens / totalTokens,
    usefulOutputTokens,
    totalTokens,
    costPerUsefulOutputToken: usefulOutputTokens === 0 ? 0 : totalCost / usefulOutputTokens,
  };
}

/** 454. Report whether observed use remains within a hard numeric quota. */
export function usageQuotaEnforcer(used: number, quota: number): {
  allowed: boolean;
  used: number;
  quota: number;
  remaining: number;
  exceededBy: number;
} {
  amount(used, 'used');
  amount(quota, 'quota');
  const exceededBy = Math.max(0, used - quota);
  return { allowed: exceededBy === 0, used, quota, remaining: Math.max(0, quota - used), exceededBy };
}

/** 455. Compare model volume, spend, and normalized cost per 1,000 tokens. */
export function costComparisonAcrossModels(records: readonly UsageRecord[]): Record<string, UsageTotals & { costPerThousandTokens: number }> {
  const grouped: Record<string, UsageTotals> = {};
  for (const record of records) addTo(grouped, groupName(record.model), record);
  return Object.fromEntries(Object.entries(grouped).map(([model, totals]) => [model, {
    ...totals,
    costPerThousandTokens: totals.tokens === 0 ? 0 : totals.cost * 1000 / totals.tokens,
  }]));
}

/** 456. Estimate excess context tokens from measured versus required context. */
export function tokenWasteFromContextBloat(records: readonly UsageRecord[]): { wastedTokens: number; wastedCost: number; records: number } {
  let wastedTokens = 0;
  let wastedCost = 0;
  let affectedRecords = 0;
  for (const record of records) {
    if (record.contextTokens === undefined || record.requiredContextTokens === undefined) continue;
    const excess = Math.max(0, amount(record.contextTokens, 'contextTokens') - amount(record.requiredContextTokens, 'requiredContextTokens'));
    if (excess === 0) continue;
    wastedTokens += excess;
    wastedCost += excess * amount(record.inputCostPerToken, 'inputCostPerToken');
    affectedRecords += 1;
  }
  return { wastedTokens, wastedCost, records: affectedRecords };
}

/** 457. Roll costs up by team or project. */
export function costRollupByTeamOrProject(records: readonly UsageRecord[], dimension: 'team' | 'project'): Record<string, UsageTotals> {
  if (dimension !== 'team' && dimension !== 'project') throw new Error('dimension must be team or project');
  const result: Record<string, UsageTotals> = {};
  for (const record of records) addTo(result, groupName(record[dimension] as string | undefined), record);
  return result;
}

/** 458. Track how much token usage remains free and what becomes billable. */
export function freeQuotaTracker(records: readonly UsageRecord[], freeTokenQuota: number): {
  quota: number;
  used: number;
  freeTokensRemaining: number;
  billableTokens: number;
  exceeded: boolean;
} {
  amount(freeTokenQuota, 'freeTokenQuota');
  const used = sumTokens(records);
  const freeTokensRemaining = Math.max(0, freeTokenQuota - used);
  const billableTokens = Math.max(0, used - freeTokenQuota);
  return { quota: freeTokenQuota, used, freeTokensRemaining, billableTokens, exceeded: billableTokens > 0 };
}

/** 459. Project remaining and total costs from current usage and work progress. */
export function costProjectionForRemainingWork(records: readonly UsageRecord[], progress: number): {
  currentCost: number;
  progress: number;
  projectedRemainingCost: number;
  projectedTotalCost: number;
} {
  const currentCost = sumCost(records);
  if (!Number.isFinite(progress) || progress <= 0 || progress > 1) throw new Error('progress must be greater than 0 and at most 1');
  const projectedTotalCost = currentCost / progress;
  return { currentCost, progress, projectedRemainingCost: projectedTotalCost - currentCost, projectedTotalCost };
}

/** 460. Compare usage-derived charges with an invoice within an absolute tolerance. */
export function invoiceReconciler(records: readonly UsageRecord[], invoiceCost: number, options: { tolerance?: number } = {}): {
  expectedCost: number;
  invoiceCost: number;
  variance: number;
  withinTolerance: boolean;
} {
  amount(invoiceCost, 'invoiceCost');
  const tolerance = amount(options.tolerance ?? 0.01, 'tolerance');
  const expectedCost = sumCost(records);
  const variance = Math.round((invoiceCost - expectedCost + Number.EPSILON) * 1e12) / 1e12;
  return { expectedCost, invoiceCost, variance, withinTolerance: Math.abs(variance) <= tolerance };
}
