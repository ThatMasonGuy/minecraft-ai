import { describe, expect, it } from "vitest";
import {
  compileHighLevelProject,
  compileHouseProject
} from "../src/project-compiler.js";
import { validateProjectSemantics } from "../src/project-plan.js";
import type { OwnedContainer } from "../src/types.js";

const noContainers = { ownedContainers: [] };

describe("high-level deterministic project compiler", () => {
  it("materializes a verified shelter from the nearest perceived wood family", () => {
    const plan = compileHouseProject(
      {
        design: {
          designName: "spruce cross-house",
          footprintRows: ["..#D#..", "..###..", "#######", "#######", "..###.."],
          wallHeight: 3
        },
        dimension: "overworld",
        visibleBlocks: [
          { name: "oak_log", distance: 9 },
          { name: "spruce_log", distance: 3 }
        ],
        inventory: []
      },
      noContainers
    );

    expect(plan.title).toBe("Build spruce cross-house in spruce");
    expect(validateProjectSemantics(plan)).toEqual([]);
    expect(plan.steps.find((step) => step.id === "gather_wood")?.spec).toEqual({
      kind: "acquire_item",
      itemName: "spruce_log",
      targetCount: expect.any(Number),
      sourceBlockNames: ["spruce_log"]
    });
    expect(plan.steps.at(-1)?.spec.kind).toBe("verify_structure");
  });

  it("uses remembered owned storage as an internal mining site without planner coordinates", () => {
    const container: OwnedContainer = {
      id: 2,
      position: { x: 12, y: 68, z: -7 },
      dimension: "overworld",
      blockName: "chest",
      contents: { birch_log: 2 },
      status: "active",
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z"
    };
    const request = {
      kind: "diamond_progression" as const,
      dimension: "overworld",
      visibleBlocks: [],
      inventory: []
    };
    const plan = compileHighLevelProject(request, {
      ownedContainers: [container]
    });

    expect(request).not.toHaveProperty("position");
    expect(plan.steps[0]?.spec).toEqual({
      kind: "use_site",
      position: container.position
    });
    expect(plan.steps.find((step) => step.id === "gather_tool_wood")?.spec).toEqual({
      kind: "acquire_item",
      itemName: "birch_log",
      targetCount: 5,
      sourceBlockNames: ["birch_log"]
    });
    expect(validateProjectSemantics(plan)).toEqual([]);
  });

  it("surveys a new workshop when no owned site is remembered", () => {
    const plan = compileHighLevelProject(
      {
        kind: "diamond_progression",
        dimension: "overworld",
        visibleBlocks: [{ name: "oak_log", distance: 4 }],
        inventory: []
      },
      noContainers
    );

    expect(plan.steps[0]?.spec).toMatchObject({
      kind: "survey_site",
      width: 5,
      depth: 5
    });
    expect(validateProjectSemantics(plan)).toEqual([]);
  });

  it("falls back to a bounded oak search without claiming a hidden source", () => {
    const plan = compileHouseProject(
      {
        design: {
          designName: "oak fallback house",
          footprintRows: ["##D##", "#####", "#####", "#####", "#####"],
          wallHeight: 3
        },
        dimension: "overworld",
        visibleBlocks: [{ name: "stone", distance: 2 }],
        inventory: []
      },
      noContainers
    );

    expect(plan.steps.find((step) => step.id === "gather_wood")?.spec).toEqual({
      kind: "acquire_item",
      itemName: "oak_log",
      targetCount: 21,
      sourceBlockNames: ["oak_log"]
    });
  });
});
