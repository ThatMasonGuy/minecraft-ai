import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EpisodicMemory } from "../src/memory.js";
import { OperatorControl } from "../src/operator-control.js";
import { startOperatorServer } from "../src/operator-server.js";
import { TaskSystem } from "../src/task-system.js";

const TOKEN = "test-operator-token-that-is-long-enough";

describe("operator HTTP API", () => {
  it("submits deterministic work through the running-process interface", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-ai-operator-http-"));
    const memory = new EpisodicMemory(path.join(directory, "memory.sqlite"));
    const tasks = new TaskSystem(
      memory,
      { count: () => 3 } as never,
      {
        start: () => undefined,
        stop: () => undefined,
        setTaskLifecycle: () => undefined
      } as never,
      {
        start: () => undefined,
        stop: () => undefined,
        setTaskLifecycle: () => undefined
      } as never,
      {
        start: () => undefined,
        stop: () => undefined,
        isActive: () => false
      } as never
    );
    const control = new OperatorControl({
      memory,
      tasks,
      requestPlanning: () => undefined,
      plannerMode: "manual",
      toolMode: "dry_run",
      model: "gpt-5.6-luna"
    });
    const server = await startOperatorServer({
      host: "127.0.0.1",
      port: 0,
      control,
      token: TOKEN,
      plannerRateLimit: { windowMs: 60_000, limit: 1 }
    });

    try {
      const unauthorized = await fetch(`${server.url}/api/operator/status`);
      expect(unauthorized.status).toBe(401);

      const response = await fetch(`${server.url}/api/operator/tasks/gather`, {
        method: "POST",
        headers: authorizedHeaders(true),
        body: JSON.stringify({
          itemName: "oak_log",
          blockNames: ["oak_log"],
          minimumCount: 8
        })
      });
      const payload = (await response.json()) as {
        paidApiCalls: number;
        workOrder: { origin: string; lastInventoryCount: number };
      };
      expect(response.status).toBe(200);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(payload).toMatchObject({
        paidApiCalls: 0,
        workOrder: { origin: "operator", lastInventoryCount: 3 }
      });

      const usageResponse = await fetch(`${server.url}/api/operator/usage`, {
        headers: authorizedHeaders()
      });
      const usage = (await usageResponse.json()) as {
        lifetime: { calls: number };
      };
      expect(usage.lifetime.calls).toBe(0);

      memory.recordApiUsage({
        requestId: "follow-up-1",
        occurredAt: "2026-08-03T12:00:00.000Z",
        completedAt: "2026-08-03T12:00:01.000Z",
        provider: "openai",
        endpoint: "responses",
        requestedModel: "gpt-5.6-luna",
        responseModel: "gpt-5.6-luna",
        serviceTier: "default",
        phase: "tool continuation 1",
        attribution: {
          turnId: "turn-filter",
          requestRole: "follow_up",
          workloadType: "task_planning",
          triggerSource: "operator",
          taskType: "shelter",
          tags: { evaluation: "nightly" }
        },
        status: "completed",
        usage: { totalTokens: 100 },
        webSearchCalls: 0
      });
      const filteredResponse = await fetch(
        `${server.url}/api/operator/usage?requestRole=follow_up&workloadType=task_planning&tag=evaluation%3Dnightly`,
        { headers: authorizedHeaders() }
      );
      const filtered = (await filteredResponse.json()) as {
        filters: Record<string, string>;
        lifetime: { calls: number };
        topTurns: Array<{ turnId: string }>;
      };
      expect(filtered).toMatchObject({
        filters: {
          requestRole: "follow_up",
          workloadType: "task_planning",
          tag: "evaluation=nightly"
        },
        lifetime: { calls: 1 },
        topTurns: [{ turnId: "turn-filter" }]
      });

      const planRequest = () =>
        fetch(`${server.url}/api/operator/plan`, {
          method: "POST",
          headers: authorizedHeaders(true),
          body: JSON.stringify({ task: "Evaluate one bounded planner behavior" })
        });
      expect((await planRequest()).status).toBe(409);
      expect((await planRequest()).status).toBe(429);
    } finally {
      await server.close();
      memory.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

function authorizedHeaders(json = false): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    ...(json ? { "content-type": "application/json" } : {})
  };
}
