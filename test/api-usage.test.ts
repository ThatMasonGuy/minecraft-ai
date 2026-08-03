import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  estimateApiUsageCostUsdMicros,
  INITIAL_GPT_5_6_LUNA_PRICE,
  summarizeApiUsage,
  type ApiUsageRecord
} from "../src/api-usage.js";
import { EpisodicMemory } from "../src/memory.js";

const tempDirectories: string[] = [];

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
      status: "completed",
      usage,
      webSearchCalls: 0
    });

    expect(first.estimatedCostUsdMicros).toBe(320);
    expect(second.estimatedCostUsdMicros).toBe(3_200);
    expect(memory.apiUsageRecords()[0]?.estimatedCostUsdMicros).toBe(320);
    memory.close();
  });
});
