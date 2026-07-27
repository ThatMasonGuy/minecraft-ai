import { describe, expect, it } from "vitest";
import {
  rewindProjectForInventoryLoss,
  shouldRecoverInventory
} from "../src/recovery-executor.js";
import type { ProjectPlan } from "../src/types.js";

describe("recovery continuity", () => {
  it("does not spend a recovery window on a few trivial blocks", () => {
    expect(
      shouldRecoverInventory([
        { name: "cobbled_deepslate", count: 2 }
      ])
    ).toBe(false);
    expect(
      shouldRecoverInventory([{ name: "cobblestone", count: 16 }])
    ).toBe(true);
    expect(
      shouldRecoverInventory([{ name: "iron_pickaxe", count: 1 }])
    ).toBe(true);
  });

  it("returns to the project site and replays its authored supply chain", () => {
    const project: ProjectPlan = {
      id: 4,
      title: "Mine diamonds",
      completionSummary: "Three diamonds recovered",
      status: "blocked",
      statusReason: "Prospecting has no pickaxe",
      currentStepIndex: 3,
      anchor: { x: 10, y: 70, z: -4 },
      steps: [
        {
          id: "install_storage",
          title: "Install storage",
          spec: { kind: "place_blueprint", placements: [] },
          status: "completed",
          state: { completed: [] }
        },
        {
          id: "gather_wood",
          title: "Gather wood",
          spec: {
            kind: "acquire_item",
            itemName: "oak_log",
            targetCount: 3,
            sourceBlockNames: ["oak_log"]
          },
          status: "completed",
          state: { workOrderId: 7 }
        },
        {
          id: "craft_pick",
          title: "Craft pickaxe",
          spec: {
            kind: "craft_item",
            itemName: "wooden_pickaxe",
            targetCount: 1
          },
          status: "completed",
          state: {}
        },
        {
          id: "prospect",
          title: "Prospect",
          spec: {
            kind: "prospect_resource",
            itemName: "diamond",
            targetCount: 3,
            oreBlockNames: ["diamond_ore"],
            targetY: -53,
            maxTunnelBlocks: 128,
            branchLength: 8,
            branchSpacing: 4,
            torchSpacing: 8,
            heading: "north"
          },
          status: "blocked",
          state: { routeIndex: 81 }
        }
      ],
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z"
    };

    expect(rewindProjectForInventoryLoss(project)).toBe(true);
    expect(project.status).toBe("active");
    expect(project.currentStepIndex).toBe(1);
    expect(project.steps[1]).toMatchObject({
      id: "return_after_inventory_loss",
      status: "pending",
      spec: {
        kind: "use_site",
        position: { x: 10, y: 70, z: -4 }
      }
    });
    expect(project.steps.slice(2).map((step) => step.status)).toEqual([
      "pending",
      "pending",
      "pending"
    ]);
    expect(project.steps[2]?.state).toEqual({});
    expect(project.steps[4]?.state).toEqual({});
  });
});
