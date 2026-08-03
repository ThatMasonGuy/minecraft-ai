import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EpisodicMemory } from "../src/memory.js";
import { OperatorControl } from "../src/operator-control.js";
import { startOperatorServer } from "../src/operator-server.js";

describe("operator HTTP API", () => {
  it("submits deterministic work through the running-process interface", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-ai-operator-http-"));
    const memory = new EpisodicMemory(path.join(directory, "memory.sqlite"));
    const control = new OperatorControl({
      memory,
      inventoryCount: () => 3,
      requestPlanning: () => undefined,
      plannerMode: "manual",
      toolMode: "dry_run",
      model: "gpt-5.6-luna"
    });
    const server = await startOperatorServer({
      host: "127.0.0.1",
      port: 0,
      control
    });

    try {
      const response = await fetch(`${server.url}/api/operator/tasks/gather`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
      expect(payload).toMatchObject({
        paidApiCalls: 0,
        workOrder: { origin: "operator", lastInventoryCount: 3 }
      });

      const usageResponse = await fetch(`${server.url}/api/operator/usage`);
      const usage = (await usageResponse.json()) as {
        lifetime: { calls: number };
      };
      expect(usage.lifetime.calls).toBe(0);
    } finally {
      await server.close();
      memory.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
