import { describe, expect, it } from "vitest";
import { continuityGatherPlan, formatWaitDuration } from "../src/agent.js";

describe("agent status formatting", () => {
  it("formats token-budget waits compactly", () => {
    expect(formatWaitDuration(30_000)).toBe("1m");
    expect(formatWaitDuration(60 * 60_000)).toBe("1h");
    expect(formatWaitDuration(2 * 60 * 60_000 + 14 * 60_000)).toBe("2h 14m");
  });

  it("turns a paused shelter goal into measurable material work", () => {
    expect(
      continuityGatherPlan(
        {
          title: "Build a starter house",
          rationale: "Create a safe place to regroup"
        },
        {
          visibleBlocks: [
            { name: "oak_log", x: 1, y: 64, z: 1, distance: 3 },
            { name: "grass_block", x: 2, y: 63, z: 1, distance: 2 }
          ]
        }
      )
    ).toEqual({
      itemName: "oak_log",
      blockNames: ["oak_log"],
      minimumCount: 24
    });
  });

  it("does not invent unrelated work for an unsupported goal", () => {
    expect(
      continuityGatherPlan(
        { title: "Meet a villager", rationale: "Make a friend" },
        {
          visibleBlocks: [
            { name: "oak_log", x: 1, y: 64, z: 1, distance: 3 }
          ]
        }
      )
    ).toBeUndefined();
  });
});
