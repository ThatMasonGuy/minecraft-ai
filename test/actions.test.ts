import { describe, expect, it } from "vitest";
import type { Bot } from "mineflayer";
import {
  deterministicGatherSources,
  MinecraftActions
} from "../src/actions.js";
import type { EpisodicMemory } from "../src/memory.js";
import type { Perception } from "../src/perception.js";
import type { MovementSystem } from "../src/movement-system.js";
import type { InventorySystem } from "../src/inventory-system.js";
import type { MiningSystem } from "../src/mining-system.js";
import type { BuildingSystem } from "../src/building-system.js";

describe("planner action boundary", () => {
  it("exposes only high-level outcome tools to the planner", () => {
    const actions = new MinecraftActions(
      {} as Bot,
      {} as EpisodicMemory,
      {} as Perception,
      {} as MovementSystem,
      {} as InventorySystem,
      {} as MiningSystem,
      {} as BuildingSystem,
      32
    );
    const names = actions.plannerDefinitions().map((definition) => definition.name);
    expect(names).toEqual([
      "speak",
      "recall",
      "recall_nearby",
      "create_goal",
      "finish_goal",
      "delegate_gather",
      "cancel_work_order"
    ]);
    expect(names).not.toContain("move_to");
    expect(names).not.toContain("mine_visible_block");
    expect(names).not.toContain("place_against_visible_block");
    expect(names).not.toContain("set_project_plan");
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
