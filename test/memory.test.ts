import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EpisodicMemory } from "../src/memory.js";
import { generatedBirchStarterHouse } from "../src/generated-projects.js";

const tempDirectories: string[] = [];

function createMemory(): EpisodicMemory {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-ai-memory-"));
  tempDirectories.push(directory);
  return new EpisodicMemory(path.join(directory, "memory.sqlite"));
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("EpisodicMemory", () => {
  it("records and retrieves searchable observations", () => {
    const memory = createMemory();
    memory.record({
      kind: "discovery",
      summary: "Found a village beside a river",
      position: { x: 120, y: 64, z: -30 },
      dimension: "overworld",
      importance: 9
    });
    memory.record({
      kind: "failure",
      summary: "Could not cross a lava pool",
      position: { x: 10, y: 12, z: 8 },
      dimension: "overworld"
    });

    const results = memory.search("village river", 5);
    expect(results).toHaveLength(1);
    expect(results[0]?.summary).toContain("village");
    memory.close();
  });

  it("retrieves spatial memories and persists goals", () => {
    const memory = createMemory();
    memory.record({
      kind: "place",
      summary: "Temporary shelter",
      position: { x: 4, y: 64, z: 4 },
      dimension: "overworld"
    });
    memory.record({
      kind: "place",
      summary: "Far landmark",
      position: { x: 500, y: 70, z: 500 },
      dimension: "overworld"
    });

    expect(
      memory.near({ x: 0, y: 64, z: 0 }, "overworld", 20, 10).map((event) => event.summary)
    ).toEqual(["Temporary shelter"]);

    const goal = memory.createGoal("Build a safe home", "Night is dangerous", 90);
    expect(memory.activeGoals()).toHaveLength(1);
    memory.updateGoal(goal.id, { status: "completed" });
    expect(memory.activeGoals()).toHaveLength(0);
    memory.close();
  });

  it("persists, orders, and depletes observed resource sites", () => {
    const memory = createMemory();
    const farther = memory.rememberResourceSite(
      "birch_log",
      { x: 30, y: 70, z: 0 },
      "overworld"
    );
    const nearer = memory.rememberResourceSite(
      "birch_log",
      { x: 5, y: 64, z: 0 },
      "overworld"
    );

    expect(
      memory
        .knownResourceSites(
          ["birch_log"],
          "overworld",
          { x: 0, y: 64, z: 0 }
        )
        .map((site) => site.id)
    ).toEqual([nearer.id, farther.id]);
    memory.depleteResourceSite("birch_log", nearer.position, "overworld");
    expect(
      memory.knownResourceSites(["birch_log"], "overworld").map((site) => site.id)
    ).toEqual([farther.id]);
    memory.close();
  });

  it("backfills resource sites from previously recorded visible observations", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-ai-memory-"));
    tempDirectories.push(directory);
    const databasePath = path.join(directory, "memory.sqlite");
    let memory = new EpisodicMemory(databasePath);
    memory.record({
      occurredAt: "2026-08-03T07:06:56.950Z",
      kind: "observation",
      summary: "Observed a birch forest",
      payload: {
        dimension: "overworld",
        visibleBlocks: [
          { name: "birch_log", x: 34, y: 76, z: -95, distance: 3 },
          { name: "birch_leaves", x: 34, y: 79, z: -95, distance: 4 }
        ]
      }
    });
    memory.close();

    memory = new EpisodicMemory(databasePath);
    expect(memory.knownResourceSites(["birch_log"], "overworld")).toEqual([
      expect.objectContaining({
        blockName: "birch_log",
        position: { x: 34, y: 76, z: -95 },
        firstObservedAt: "2026-08-03T07:06:56.950Z"
      })
    ]);
    expect(memory.knownResourceSites(["birch_leaves"], "overworld")).toEqual([]);
    memory.close();
  });

  it("totals recorded API tokens within a rolling window", () => {
    const memory = createMemory();
    memory.record({
      occurredAt: "2026-07-26T00:00:00.000Z",
      kind: "api_usage",
      summary: "Older response",
      payload: { usage: { total_tokens: 100 } }
    });
    memory.record({
      occurredAt: "2026-07-26T12:00:00.000Z",
      kind: "api_usage",
      summary: "Newer response",
      payload: { usage: { total_tokens: 250 } }
    });

    expect(memory.tokenUsageSince("2026-07-26T06:00:00.000Z")).toBe(250);
    expect(memory.tokenUsageSince("2026-07-25T00:00:00.000Z")).toBe(350);
    memory.close();
  });

  it("calculates when enough rolling-window tokens will expire", () => {
    const memory = createMemory();
    memory.record({
      occurredAt: "2026-07-26T08:00:00.000Z",
      kind: "api_usage",
      summary: "Oldest response",
      payload: { usage: { total_tokens: 300 } }
    });
    memory.record({
      occurredAt: "2026-07-26T10:30:00.000Z",
      kind: "api_usage",
      summary: "Newer response",
      payload: { usage: { total_tokens: 600 } }
    });

    expect(
      memory
        .tokenBudgetAvailableAt(
          850,
          24 * 60 * 60 * 1_000,
          new Date("2026-07-27T07:00:00.000Z")
        )
        .toISOString()
    ).toBe("2026-07-27T08:00:00.001Z");
    memory.close();
  });

  it("persists and supersedes deterministic work orders", () => {
    const memory = createMemory();
    const first = memory.createGatherBlocksWorkOrder({
      itemName: "oak_log",
      blockNames: ["oak_log"],
      minimumCount: 8,
      continuation: "stop_at_minimum",
      storage: { mode: "inventory" }
    }, 3);
    expect(memory.activeWorkOrder()?.id).toBe(first.id);
    expect(first).toMatchObject({
      progressCount: 0,
      lastInventoryCount: 3
    });

    const second = memory.createGatherBlocksWorkOrder({
      goalId: 2,
      itemName: "birch_log",
      blockNames: ["birch_log"],
      minimumCount: 12,
      continuation: "until_replaced",
      storage: {
        mode: "container",
        position: { x: 4, y: 64, z: 8 }
      }
    });
    expect(memory.activeWorkOrder()).toMatchObject({
      id: second.id,
      spec: {
        goalId: 2,
        itemName: "birch_log",
        minimumCount: 12,
        continuation: "until_replaced"
      }
    });

    const progressed = memory.updateWorkOrderProgress(
      second.id,
      12,
      4,
      "2026-07-26T12:00:00.000Z"
    );
    expect(progressed).toMatchObject({
      progressCount: 12,
      lastInventoryCount: 4,
      minimumReachedAt: "2026-07-26T12:00:00.000Z"
    });

    memory.updateWorkOrderStatus(second.id, "completed", "Target reached");
    expect(memory.activeWorkOrder()).toBeUndefined();
    memory.close();
  });

  it("persists and advances an AI-authored project plan", () => {
    const memory = createMemory();
    const goal = memory.createGoal("Build a house", "Create a safe home", 90);
    const project = memory.createProjectPlan(
      generatedBirchStarterHouse(goal.id)
    );
    expect(memory.activeProject()).toMatchObject({
      id: project.id,
      currentStepIndex: 0,
      status: "active"
    });
    project.anchor = { x: 10, y: 64, z: -5 };
    project.steps[0]!.status = "completed";
    project.currentStepIndex = 1;
    memory.saveProject(project);
    expect(memory.activeProject()).toMatchObject({
      anchor: { x: 10, y: 64, z: -5 },
      currentStepIndex: 1
    });
    memory.close();
  });

  it("persists death recovery and owned-container state", () => {
    const memory = createMemory();
    const recovery = memory.createRecoveryJob(
      { x: 12.5, y: 63, z: -8.5 },
      "overworld",
      [{ name: "iron_sword", count: 1 }]
    );
    expect(memory.activeRecoveryJob()).toMatchObject({
      id: recovery.id,
      expectedItems: [{ name: "iron_sword", count: 1 }],
      loadedChunkMs: 0
    });
    memory.addRecoveryLoadedChunkTime(recovery.id, 1_250);
    expect(memory.activeRecoveryJob()?.loadedChunkMs).toBe(1_250);
    memory.updateRecoveryJobStatus(recovery.id, "completed", "Items collected");
    expect(memory.activeRecoveryJob()).toBeUndefined();

    const container = memory.registerOwnedContainer(
      { x: 4, y: 64, z: 8 },
      "overworld",
      "chest",
      "Home storage"
    );
    memory.recordContainerDeposit(container.id, "cobblestone", 32);
    expect(memory.ownedContainers("overworld")).toMatchObject([
      {
        id: container.id,
        label: "Home storage",
        contents: { cobblestone: 32 }
      }
    ]);
    memory.recordContainerWithdrawal(container.id, "cobblestone", 5);
    expect(memory.ownedContainers("overworld")[0]?.contents).toEqual({
      cobblestone: 27
    });
    memory.close();
  });
});
