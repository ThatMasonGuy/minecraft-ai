import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  estimateApiUsageCostUsdMicros,
  INITIAL_GPT_5_6_LUNA_PRICE,
  summarizeApiUsage,
  type ApiUsageRecord
} from "../src/api-usage.js";
import { EpisodicMemory } from "../src/memory.js";

const tempDirectories: string[] = [];
const initialAttribution = {
  turnId: "turn-1",
  requestRole: "initial" as const,
  workloadType: "task_planning" as const,
  triggerSource: "operator" as const,
  taskType: "shelter",
  taskId: "task-1",
  tags: { environment: "test" }
};

function createMemory(): EpisodicMemory {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-ai-usage-"));
  tempDirectories.push(directory);
  return new EpisodicMemory(path.join(directory, "memory.sqlite"));
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("API usage accounting", () => {
  it("calculates short- and long-context Luna estimates", () => {
    expect(
      estimateApiUsageCostUsdMicros(
        {
          inputTokens: 100_000,
          cachedInputTokens: 10_000,
          cacheWriteTokens: 10_000,
          outputTokens: 5_000,
          reasoningTokens: 1_000,
          totalTokens: 105_000
        },
        2,
        INITIAL_GPT_5_6_LUNA_PRICE
      )
    ).toBe(44_700);
    expect(
      estimateApiUsageCostUsdMicros(
        {
          inputTokens: 300_000,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 10_000,
          reasoningTokens: 2_000,
          totalTokens: 310_000
        },
        0,
        INITIAL_GPT_5_6_LUNA_PRICE
      )
    ).toBe(138_000);
  });

  it("leaves incomplete historical usage unpriced", () => {
    expect(
      estimateApiUsageCostUsdMicros(
        { totalTokens: 500 },
        0,
        INITIAL_GPT_5_6_LUNA_PRICE
      )
    ).toBeUndefined();
  });

  it("persists each response once with price and raw usage", () => {
    const memory = createMemory();
    const input = {
      requestId: "request-1",
      occurredAt: "2026-08-03T12:00:00.000Z",
      completedAt: "2026-08-03T12:00:01.250Z",
      provider: "openai" as const,
      endpoint: "responses" as const,
      requestedModel: "gpt-5.6-luna",
      responseId: "resp-1",
      responseModel: "gpt-5.6-luna",
      serviceTier: "default",
      phase: "initial decision",
      trigger: "operator compatibility test",
      reasoningEffort: "low",
      attribution: initialAttribution,
      status: "completed" as const,
      latencyMs: 1_250,
      usage: {
        inputTokens: 1_000,
        cachedInputTokens: 100,
        cacheWriteTokens: 200,
        outputTokens: 50,
        reasoningTokens: 20,
        totalTokens: 1_050
      },
      webSearchCalls: 1,
      rawUsage: { total_tokens: 1_050, future_field: 7 }
    };
    const first = memory.recordApiUsage(input);
    const duplicate = memory.recordApiUsage({
      ...input,
      requestId: "request-duplicate"
    });

    expect(duplicate.id).toBe(first.id);
    expect(memory.apiUsageRecords()).toHaveLength(1);
    expect(first).toMatchObject({
      responseModel: "gpt-5.6-luna",
      pricingStatus: "estimated",
      estimatedCostUsdMicros: 10_252,
      rawUsage: { total_tokens: 1_050, future_field: 7 }
    });
    expect(memory.tokenUsageSince("2026-08-03T00:00:00.000Z")).toBe(1_050);
    memory.close();
  });

  it("aggregates lifetime, Brisbane day, model, phase, and unknown cost", () => {
    const base: ApiUsageRecord = {
      id: 1,
      requestId: "one",
      occurredAt: "2026-08-03T13:30:00.000Z",
      completedAt: "2026-08-03T13:30:01.000Z",
      provider: "openai",
      endpoint: "responses",
      requestedModel: "gpt-5.6-luna",
      responseModel: "gpt-5.6-luna",
      serviceTier: "default",
      phase: "initial decision",
      attribution: initialAttribution,
      status: "completed",
      latencyMs: 1_000,
      usage: { totalTokens: 100 },
      webSearchCalls: 0,
      estimatedCostUsdMicros: 50,
      pricingStatus: "estimated"
    };
    const summary = summarizeApiUsage([
      base,
      {
        ...base,
        id: 2,
        requestId: "two",
        occurredAt: "2026-08-03T14:30:00.000Z",
        requestedModel: "older-model",
        responseModel: "older-model",
        phase: "tool continuation 1",
        attribution: {
          ...initialAttribution,
          requestRole: "follow_up" as const,
          parentRequestId: "one"
        },
        status: "failed",
        usage: undefined,
        estimatedCostUsdMicros: undefined,
        pricingStatus: "unknown"
      }
    ]);

    expect(summary.lifetime).toMatchObject({
      calls: 2,
      completedCalls: 1,
      failedCalls: 1,
      totalTokens: 100,
      pricedCalls: 1,
      unknownCostCalls: 1,
      estimatedCostUsdMicros: 50
    });
    expect(summary.byDay["2026-08-03"]?.calls).toBe(1);
    expect(summary.byDay["2026-08-04"]?.calls).toBe(1);
    expect(summary.byModel["gpt-5.6-luna"]?.calls).toBe(1);
    expect(summary.byPhase["tool continuation 1"]?.failedCalls).toBe(1);
    expect(summary.byRequestRole.follow_up?.calls).toBe(1);
    expect(summary.byWorkloadType.task_planning?.calls).toBe(2);
    expect(summary.byTriggerSource.operator?.calls).toBe(2);
    expect(summary.byTaskType.shelter?.calls).toBe(2);
    expect(summary.byTag["environment=test"]?.calls).toBe(2);
    expect(summary.topTurns[0]).toMatchObject({
      turnId: "turn-1",
      calls: 2,
      totalTokens: 100
    });
    const followUps = summarizeApiUsage(
      [base, { ...base, id: 2, requestId: "follow", attribution: { ...initialAttribution, requestRole: "follow_up" } }],
      "Australia/Brisbane",
      { requestRole: "follow_up", tag: "environment=test" }
    );
    expect(followUps.lifetime.calls).toBe(1);
    expect(followUps.filters).toMatchObject({
      requestRole: "follow_up",
      tag: "environment=test"
    });
  });

  it("keeps historical estimates stable when a new price takes effect", () => {
    const memory = createMemory();
    const usage = {
      inputTokens: 1_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 0,
      totalTokens: 1_100
    };
    const first = memory.recordApiUsage({
      requestId: "before-price-change",
      occurredAt: "2026-08-03T12:00:00.000Z",
      completedAt: "2026-08-03T12:00:01.000Z",
      provider: "openai",
      endpoint: "responses",
      requestedModel: "gpt-5.6-luna",
      responseId: "resp-before",
      responseModel: "gpt-5.6-luna",
      serviceTier: "default",
      phase: "initial decision",
      attribution: initialAttribution,
      status: "completed",
      usage,
      webSearchCalls: 0
    });
    memory.addApiPriceVersion({
      ...INITIAL_GPT_5_6_LUNA_PRICE,
      effectiveFrom: "2026-08-04T00:00:00.000Z",
      capturedAt: "2026-08-04T00:00:00.000Z",
      shortInputUsdPerMillion: 2,
      shortOutputUsdPerMillion: 12
    });
    const second = memory.recordApiUsage({
      requestId: "after-price-change",
      occurredAt: "2026-08-04T12:00:00.000Z",
      completedAt: "2026-08-04T12:00:01.000Z",
      provider: "openai",
      endpoint: "responses",
      requestedModel: "gpt-5.6-luna",
      responseId: "resp-after",
      responseModel: "gpt-5.6-luna",
      serviceTier: "default",
      phase: "initial decision",
      attribution: { ...initialAttribution, turnId: "turn-2" },
      status: "completed",
      usage,
      webSearchCalls: 0
    });

    expect(first.estimatedCostUsdMicros).toBe(320);
    expect(second.estimatedCostUsdMicros).toBe(3_200);
    expect(memory.apiUsageRecords()[0]?.estimatedCostUsdMicros).toBe(320);
    memory.close();
  });

  it("ranks the most expensive planner turns first", () => {
    const record = (turnId: string, cost: number): ApiUsageRecord => ({
      id: cost,
      requestId: `request-${turnId}`,
      occurredAt: "2026-08-03T12:00:00.000Z",
      completedAt: "2026-08-03T12:00:01.000Z",
      provider: "openai",
      endpoint: "responses",
      requestedModel: "gpt-5.6-luna",
      responseModel: "gpt-5.6-luna",
      phase: "initial decision",
      attribution: { ...initialAttribution, turnId },
      status: "completed",
      usage: { totalTokens: cost },
      webSearchCalls: 0,
      estimatedCostUsdMicros: cost,
      pricingStatus: "estimated"
    });
    const summary = summarizeApiUsage([
      record("cheap-turn", 10),
      record("expensive-turn", 500)
    ]);
    expect(summary.topTurns.map((turn) => turn.turnId)).toEqual([
      "expensive-turn",
      "cheap-turn"
    ]);
  });

  it("migrates pre-attribution ledgers without losing historical rows", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-ai-usage-migration-"));
    tempDirectories.push(directory);
    const databasePath = path.join(directory, "memory.sqlite");
    let memory = new EpisodicMemory(databasePath);
    memory.recordApiUsage({
      requestId: "legacy-shaped-row",
      occurredAt: "2026-08-03T12:00:00.000Z",
      completedAt: "2026-08-03T12:00:01.000Z",
      provider: "openai",
      endpoint: "responses",
      requestedModel: "gpt-5.6-luna",
      phase: "initial decision",
      attribution: initialAttribution,
      status: "completed",
      usage: { totalTokens: 10 },
      webSearchCalls: 0
    });
    memory.close();

    const database = new DatabaseSync(databasePath);
    database.exec("DROP INDEX idx_api_usage_turn");
    database.exec("DROP INDEX idx_api_usage_attribution");
    for (const column of [
      "turn_id",
      "request_role",
      "workload_type",
      "trigger_source",
      "task_type",
      "task_id",
      "parent_request_id",
      "tags_json"
    ]) {
      database.exec(`ALTER TABLE api_usage_ledger DROP COLUMN ${column}`);
    }
    database.close();

    memory = new EpisodicMemory(databasePath);
    expect(memory.apiUsageRecords()[0]?.attribution).toMatchObject({
      turnId: "legacy-shaped-row",
      requestRole: "initial",
      workloadType: "other",
      triggerSource: "legacy"
    });
    memory.close();
  });
});
