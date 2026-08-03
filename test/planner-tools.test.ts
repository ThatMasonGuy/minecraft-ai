import { describe, expect, it, vi } from "vitest";
import {
  deterministicGatherSources,
  PlannerTools
} from "../src/planner-tools.js";
import type { EpisodicMemory } from "../src/memory.js";
import type { Perception } from "../src/perception.js";
import type { TaskSystem } from "../src/task-system.js";
import type { CommunicationSystem } from "../src/communication-system.js";
import type { TelemetrySystem } from "../src/telemetry-system.js";

describe("planner tool boundary", () => {
  it("exposes only high-level outcome tools to the planner", () => {
    const actions = new PlannerTools(
      {} as EpisodicMemory,
      {} as Perception,
      {} as TaskSystem,
      {} as CommunicationSystem,
      {} as TelemetrySystem
    );
    const names = actions.plannerDefinitions().map((definition) => definition.name);
    expect(names).toEqual([
      "speak",
      "recall",
      "recall_nearby",
      "create_goal",
      "finish_goal",
      "delegate_gather",
      "delegate_project",
      "cancel_work_order"
    ]);
    expect(names).not.toContain("move_to");
    expect(names).not.toContain("mine_visible_block");
    expect(names).not.toContain("place_against_visible_block");
    expect(names).not.toContain("set_project_plan");
    expect(JSON.stringify(actions.plannerDefinitions())).not.toMatch(
      /move_to|mine_visible|place_against|coordinate_[xyz]/
    );
  });

  it("delegates a project outcome without exposing its compiled plan", async () => {
    const delegateProject = vi.fn(() => ({ id: 17 }));
    const record = vi.fn(() => 1);
    const tools = new PlannerTools(
      {} as EpisodicMemory,
      {
        last: () => ({
          dimension: "overworld",
          position: { x: 4, y: 70, z: -2 },
          visibleBlocks: [
            { name: "spruce_log", distance: 5, x: 0, y: 0, z: 0 }
          ],
          inventory: [{ name: "stick", count: 2, slot: 0 }]
        })
      } as never,
      { delegateProject } as never,
      {} as CommunicationSystem,
      { record, activity: vi.fn() } as TelemetrySystem
    );

    await expect(
      tools.execute("delegate_project", {
        goal_id: 0,
        outcome: "starter_shelter",
        scale: "standard"
      })
    ).resolves.toMatchObject({ ok: true, data: { id: 17 } });
    expect(delegateProject).toHaveBeenCalledWith(
      {
        goalId: undefined,
        kind: "starter_shelter",
        scale: "standard",
        dimension: "overworld",
        visibleBlocks: [{ name: "spruce_log", distance: 5 }],
        inventory: [{ name: "stick", count: 2 }]
      },
      "planner"
    );

    const definition = tools
      .plannerDefinitions()
      .find((candidate) => candidate.name === "delegate_project");
    expect(JSON.stringify(definition?.parameters)).not.toMatch(
      /coordinate|position|blueprint|steps|\b[xyz]\b/
    );
  });

  it("delegates a broad gather outcome without issuing motor instructions", async () => {
    const delegateGather = vi.fn(() => ({ id: 9 }));
    const record = vi.fn(() => 1);
    const tools = new PlannerTools(
      {} as EpisodicMemory,
      {
        last: () => ({ dimension: "overworld", position: { x: 0, y: 64, z: 0 } })
      } as never,
      { delegateGather } as never,
      {} as CommunicationSystem,
      { record, activity: vi.fn() } as TelemetrySystem
    );

    await expect(
      tools.execute("delegate_gather", {
        goal_id: 0,
        item_name: "oak_log",
        minimum_count: 16,
        continuation: "until_replaced"
      })
    ).resolves.toMatchObject({ ok: true, data: { id: 9 } });
    expect(delegateGather).toHaveBeenCalledWith(
      {
        goalId: undefined,
        itemName: "oak_log",
        minimumCount: 16,
        continuation: "until_replaced",
        dimension: "overworld"
      },
      "planner"
    );
    expect(record).toHaveBeenCalledOnce();
  });

  it("maps broad gather outcomes to deterministic source rules", () => {
    expect(deterministicGatherSources("oak_log")).toEqual(["oak_log"]);
    expect(deterministicGatherSources("raw_iron")).toEqual([
      "iron_ore",
      "deepslate_iron_ore"
    ]);
    expect(deterministicGatherSources("wooden_pickaxe")).toEqual([]);
  });
});
