import { describe, expect, it } from "vitest";
import type { Bot } from "mineflayer";
import { MinecraftActions } from "../src/actions.js";
import type { EpisodicMemory } from "../src/memory.js";
import type { Perception } from "../src/perception.js";

describe("planner action boundary", () => {
  it("does not expose a model-controlled combat tool", () => {
    const actions = new MinecraftActions(
      {} as Bot,
      {} as EpisodicMemory,
      {} as Perception,
      32
    );
    const names = actions.definitions().map((definition) => definition.name);
    expect(names).not.toContain("attack_visible_non_player");
  });
});
