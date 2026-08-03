export type ApiUsageStatus =
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";

export const API_REQUEST_ROLES = ["initial", "follow_up"] as const;
export type ApiRequestRole = (typeof API_REQUEST_ROLES)[number];

export const API_WORKLOAD_TYPES = [
  "task_planning",
  "development_test",
  "reflection",
  "conversation",
  "survival",
  "executor_escalation",
  "budget_resume",
  "other"
] as const;
export type ApiWorkloadType = (typeof API_WORKLOAD_TYPES)[number];

export const API_TRIGGER_SOURCES = [
  "operator",
  "chat",
  "whisper",
  "schedule",
  "startup",
  "vitals",
  "executor",
  "budget",
  "internal",
  "legacy"
] as const;
export type ApiTriggerSource = (typeof API_TRIGGER_SOURCES)[number];

export interface ApiUsageAttribution {
  turnId: string;
  requestRole: ApiRequestRole;
  workloadType: ApiWorkloadType;
  triggerSource: ApiTriggerSource;
  taskType?: string;
  taskId?: string;
  parentRequestId?: string;
  tags: Record<string, string>;
}

export interface ApiTokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
}

export interface ApiUsageWrite {
  requestId: string;
  occurredAt: string;
  completedAt: string;
  provider: "openai";
  endpoint: "responses";
  requestedModel: string;
  responseId?: string;
  responseModel?: string;
  serviceTier?: string;
  phase: string;
  trigger?: string;
  reasoningEffort?: string;
  attribution: ApiUsageAttribution;
  status: ApiUsageStatus;
  latencyMs?: number;
  usage?: ApiTokenUsage;
  webSearchCalls: number;
  rawUsage?: unknown;
  errorClass?: string;
  errorMessage?: string;
}

export interface ApiUsageRecord extends ApiUsageWrite {
  id: number;
  responseId?: string;
  responseModel?: string;
  serviceTier?: string;
  trigger?: string;
  reasoningEffort?: string;
  usage?: ApiTokenUsage;
  rawUsage?: unknown;
  errorClass?: string;
  errorMessage?: string;
  priceVersionId?: number;
  estimatedCostUsdMicros?: number;
  pricingStatus: "estimated" | "unknown";
}

export interface ApiPriceVersion {
  id?: number;
  provider: "openai";
  model: string;
  serviceTier: string;
  effectiveFrom: string;
  effectiveTo?: string;
  longContextThreshold: number;
  shortInputUsdPerMillion: number;
  shortCachedInputUsdPerMillion: number;
  shortCacheWriteUsdPerMillion: number;
  shortOutputUsdPerMillion: number;
  longInputUsdPerMillion: number;
  longCachedInputUsdPerMillion: number;
  longCacheWriteUsdPerMillion: number;
  longOutputUsdPerMillion: number;
  webSearchUsdPerThousand: number;
  sourceUrl: string;
  capturedAt: string;
}

export interface ApiUsageAggregate {
  calls: number;
  completedCalls: number;
  failedCalls: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  webSearchCalls: number;
  estimatedCostUsdMicros: number;
  pricedCalls: number;
  unknownCostCalls: number;
}

export interface ApiUsageFilters {
  from?: string;
  to?: string;
  model?: string;
  requestRole?: ApiRequestRole;
  workloadType?: ApiWorkloadType;
  triggerSource?: ApiTriggerSource;
  taskType?: string;
  taskId?: string;
  tag?: string;
}

export interface ApiUsageTurnAggregate extends ApiUsageAggregate {
  turnId: string;
  workloadType: ApiWorkloadType;
  triggerSource: ApiTriggerSource;
  taskType?: string;
  taskId?: string;
  tags: Record<string, string>;
  firstOccurredAt: string;
  lastOccurredAt: string;
}

export interface ApiUsageSummary {
  timezone: string;
  filters: ApiUsageFilters;
  firstOccurredAt?: string;
  lastOccurredAt?: string;
  lifetime: ApiUsageAggregate;
  byDay: Record<string, ApiUsageAggregate>;
  byModel: Record<string, ApiUsageAggregate>;
  byPhase: Record<string, ApiUsageAggregate>;
  byRequestRole: Record<string, ApiUsageAggregate>;
  byWorkloadType: Record<string, ApiUsageAggregate>;
  byTriggerSource: Record<string, ApiUsageAggregate>;
  byTaskType: Record<string, ApiUsageAggregate>;
  byTag: Record<string, ApiUsageAggregate>;
  topTurns: ApiUsageTurnAggregate[];
}

export const INITIAL_GPT_5_6_LUNA_PRICE: ApiPriceVersion = {
  provider: "openai",
  model: "gpt-5.6-luna",
  serviceTier: "default",
  effectiveFrom: "2026-08-03T00:00:00.000Z",
  longContextThreshold: 272_000,
  shortInputUsdPerMillion: 0.2,
  shortCachedInputUsdPerMillion: 0.02,
  shortCacheWriteUsdPerMillion: 0.25,
  shortOutputUsdPerMillion: 1.2,
  longInputUsdPerMillion: 0.4,
  longCachedInputUsdPerMillion: 0.04,
  longCacheWriteUsdPerMillion: 0.5,
  longOutputUsdPerMillion: 1.8,
  webSearchUsdPerThousand: 10,
  sourceUrl: "https://developers.openai.com/api/docs/pricing",
  capturedAt: "2026-08-03T00:00:00.000Z"
};

export function estimateApiUsageCostUsdMicros(
  usage: ApiTokenUsage,
  webSearchCalls: number,
  price: ApiPriceVersion
): number | undefined {
  if (
    usage.inputTokens === undefined ||
    usage.cachedInputTokens === undefined ||
    usage.cacheWriteTokens === undefined ||
    usage.outputTokens === undefined
  ) {
    return undefined;
  }
  const longContext = usage.inputTokens > price.longContextThreshold;
  const uncachedInputTokens = Math.max(
    0,
    usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens
  );
  const inputRate = longContext
    ? price.longInputUsdPerMillion
    : price.shortInputUsdPerMillion;
  const cachedRate = longContext
    ? price.longCachedInputUsdPerMillion
    : price.shortCachedInputUsdPerMillion;
  const cacheWriteRate = longContext
    ? price.longCacheWriteUsdPerMillion
    : price.shortCacheWriteUsdPerMillion;
  const outputRate = longContext
    ? price.longOutputUsdPerMillion
    : price.shortOutputUsdPerMillion;

  // One token at a USD-per-million rate has the same numeric value in
  // micro-dollars, which keeps the stored estimate integral and reproducible.
  const tokenCostUsdMicros =
    uncachedInputTokens * inputRate +
    usage.cachedInputTokens * cachedRate +
    usage.cacheWriteTokens * cacheWriteRate +
    usage.outputTokens * outputRate;
  const webSearchCostUsdMicros =
    Math.max(0, webSearchCalls) * price.webSearchUsdPerThousand * 1_000;
  return Math.round(tokenCostUsdMicros + webSearchCostUsdMicros);
}

export function summarizeApiUsage(
  records: ApiUsageRecord[],
  timezone = "Australia/Brisbane",
  filters: ApiUsageFilters = {}
): ApiUsageSummary {
  const sorted = records.filter((record) => matchesFilters(record, filters)).sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt)
  );
  const summary: ApiUsageSummary = {
    timezone,
    filters,
    firstOccurredAt: sorted[0]?.occurredAt,
    lastOccurredAt: sorted.at(-1)?.occurredAt,
    lifetime: emptyAggregate(),
    byDay: {},
    byModel: {},
    byPhase: {},
    byRequestRole: {},
    byWorkloadType: {},
    byTriggerSource: {},
    byTaskType: {},
    byTag: {},
    topTurns: []
  };

  const turns = new Map<string, ApiUsageTurnAggregate>();

  for (const record of sorted) {
    addRecord(summary.lifetime, record);
    const day = dayKey(record.occurredAt, timezone);
    const model = record.responseModel ?? record.requestedModel ?? "unknown";
    const phase = record.phase || "unknown";
    addRecord((summary.byDay[day] ??= emptyAggregate()), record);
    addRecord((summary.byModel[model] ??= emptyAggregate()), record);
    addRecord((summary.byPhase[phase] ??= emptyAggregate()), record);
    addRecord(
      (summary.byRequestRole[record.attribution.requestRole] ??= emptyAggregate()),
      record
    );
    addRecord(
      (summary.byWorkloadType[record.attribution.workloadType] ??= emptyAggregate()),
      record
    );
    addRecord(
      (summary.byTriggerSource[record.attribution.triggerSource] ??= emptyAggregate()),
      record
    );
    const taskType = record.attribution.taskType ?? "untagged";
    addRecord((summary.byTaskType[taskType] ??= emptyAggregate()), record);
    for (const [key, value] of Object.entries(record.attribution.tags)) {
      addRecord((summary.byTag[`${key}=${value}`] ??= emptyAggregate()), record);
    }
    const existingTurn = turns.get(record.attribution.turnId);
    const turn = existingTurn ?? createTurnAggregate(record);
    addRecord(turn, record);
    turn.lastOccurredAt = record.occurredAt;
    turns.set(record.attribution.turnId, turn);
  }

  summary.topTurns = [...turns.values()]
    .sort(
      (left, right) =>
        right.estimatedCostUsdMicros - left.estimatedCostUsdMicros ||
        right.totalTokens - left.totalTokens ||
        right.calls - left.calls
    )
    .slice(0, 20);

  return summary;
}

function createTurnAggregate(record: ApiUsageRecord): ApiUsageTurnAggregate {
  return {
    ...emptyAggregate(),
    turnId: record.attribution.turnId,
    workloadType: record.attribution.workloadType,
    triggerSource: record.attribution.triggerSource,
    taskType: record.attribution.taskType,
    taskId: record.attribution.taskId,
    tags: record.attribution.tags,
    firstOccurredAt: record.occurredAt,
    lastOccurredAt: record.occurredAt
  };
}

function matchesFilters(
  record: ApiUsageRecord,
  filters: ApiUsageFilters
): boolean {
  const model = record.responseModel ?? record.requestedModel;
  if (filters.from && record.occurredAt < filters.from) return false;
  if (filters.to && record.occurredAt >= filters.to) return false;
  if (filters.model && model !== filters.model) return false;
  if (filters.requestRole && record.attribution.requestRole !== filters.requestRole) {
    return false;
  }
  if (
    filters.workloadType &&
    record.attribution.workloadType !== filters.workloadType
  ) {
    return false;
  }
  if (
    filters.triggerSource &&
    record.attribution.triggerSource !== filters.triggerSource
  ) {
    return false;
  }
  if (filters.taskType && record.attribution.taskType !== filters.taskType) {
    return false;
  }
  if (filters.taskId && record.attribution.taskId !== filters.taskId) return false;
  if (filters.tag) {
    const separator = filters.tag.indexOf("=");
    const key = separator < 0 ? filters.tag : filters.tag.slice(0, separator);
    const value = separator < 0 ? undefined : filters.tag.slice(separator + 1);
    if (!(key in record.attribution.tags)) return false;
    if (value !== undefined && record.attribution.tags[key] !== value) return false;
  }
  return true;
}

function emptyAggregate(): ApiUsageAggregate {
  return {
    calls: 0,
    completedCalls: 0,
    failedCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    webSearchCalls: 0,
    estimatedCostUsdMicros: 0,
    pricedCalls: 0,
    unknownCostCalls: 0
  };
}

function addRecord(aggregate: ApiUsageAggregate, record: ApiUsageRecord): void {
  aggregate.calls += 1;
  if (record.status === "completed") aggregate.completedCalls += 1;
  if (record.status === "failed" || record.status === "cancelled") {
    aggregate.failedCalls += 1;
  }
  aggregate.inputTokens += record.usage?.inputTokens ?? 0;
  aggregate.cachedInputTokens += record.usage?.cachedInputTokens ?? 0;
  aggregate.cacheWriteTokens += record.usage?.cacheWriteTokens ?? 0;
  aggregate.outputTokens += record.usage?.outputTokens ?? 0;
  aggregate.reasoningTokens += record.usage?.reasoningTokens ?? 0;
  aggregate.totalTokens += record.usage?.totalTokens ?? 0;
  aggregate.webSearchCalls += record.webSearchCalls;
  if (record.estimatedCostUsdMicros === undefined) {
    aggregate.unknownCostCalls += 1;
  } else {
    aggregate.pricedCalls += 1;
    aggregate.estimatedCostUsdMicros += record.estimatedCostUsdMicros;
  }
}

function dayKey(occurredAt: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(occurredAt));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
