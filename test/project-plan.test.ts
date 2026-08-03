import { describe, expect, it } from "vitest";
import {
  generatedBirchStarterHouse,
  generatedMiningProgressionProject,
  generatedStarterHouseProject
} from "../src/generated-projects.js";
import {
  parseProjectPlanDraft,
  validateProjectSemantics
} from "../src/project-plan.js";
import {
  createBranchMineRoute,
  foodAnimalPriority,
  isProtectedExcavationBlockName
} from "../src/project-system.js";

describe("project plans", () => {
  it("protects infrastructure from prospect excavation", () => {
    expect(isProtectedExcavationBlockName("birch_door")).toBe(true);
    expect(isProtectedExcavationBlockName("chest")).toBe(true);
    expect(isProtectedExcavationBlockName("crafting_table")).toBe(true);
    expect(isProtectedExcavationBlockName("stone")).toBe(false);
  });

  it("prioritizes visible food animals deterministically", () => {
    expect(foodAnimalPriority("cow")).toBeGreaterThan(
      foodAnimalPriority("chicken")
    );
    expect(foodAnimalPriority("zombie")).toBe(0);
  });

  it("accepts the generated starter-house project", () => {
    const plan = parseProjectPlanDraft(generatedBirchStarterHouse(3));
    expect(validateProjectSemantics(plan)).toEqual([]);
    expect(plan.steps.map((step) => step.spec.kind)).toEqual([
      "survey_site",
      "acquire_item",
      "craft_item",
      "craft_item",
      "place_blueprint",
      "craft_item",
      "place_blueprint",
      "verify_structure"
    ]);
  });

  it("derives a complete materialized shell rather than prose steps", () => {
    const plan = generatedBirchStarterHouse(3);
    const shell = plan.steps.find((step) => step.id === "build_shell");
    expect(shell?.spec.kind).toBe("place_blueprint");
    if (shell?.spec.kind !== "place_blueprint") return;
    expect(shell.spec.placements).toHaveLength(72);
    expect(
      shell.spec.placements.filter((placement) => placement.dy === 3)
    ).toHaveLength(25);
  });

  it.each([
    { scale: "compact" as const, width: 5, logTarget: 21 },
    { scale: "standard" as const, width: 7, logTarget: 33 },
    { scale: "spacious" as const, width: 9, logTarget: 47 }
  ])("compiles the $scale shelter scale deterministically", ({ scale, width, logTarget }) => {
    const plan = generatedStarterHouseProject(3, "birch", scale);
    const survey = plan.steps.find((step) => step.id === "survey_site");
    const gather = plan.steps.find((step) => step.id === "gather_wood");
    const shell = plan.steps.find((step) => step.id === "build_shell");

    expect(survey?.spec).toMatchObject({
      kind: "survey_site",
      width,
      depth: width,
      maxSitePreparationBlocks: width * width * 4
    });
    expect(gather?.spec).toMatchObject({
      kind: "acquire_item",
      targetCount: logTarget
    });
    expect(shell?.spec.kind).toBe("place_blueprint");
    if (shell?.spec.kind === "place_blueprint") {
      expect(
        shell.spec.placements.filter((placement) => placement.dy === 3)
      ).toHaveLength(width * width);
    }
    expect(validateProjectSemantics(plan)).toEqual([]);
  });

  it("accepts a perception-bounded prospecting project", () => {
    const plan = parseProjectPlanDraft({
      title: "Prospect for iron",
      completionSummary: "Returned with iron ore",
      steps: [
        {
          id: "prospect",
          title: "Open a branch mine",
          spec: {
            kind: "prospect_resource",
            itemName: "raw_iron",
            targetCount: 8,
            oreBlockNames: ["iron_ore", "deepslate_iron_ore"],
            targetY: 16,
            maxTunnelBlocks: 128,
            branchLength: 8,
            branchSpacing: 4,
            torchSpacing: 8,
            heading: "north",
            craftingTableAt: { dx: 2, dy: 0, dz: 2 }
          }
        },
        {
          id: "verify",
          title: "Count recovered iron",
          spec: {
            kind: "verify_inventory",
            itemName: "raw_iron",
            minimumCount: 8
          }
        }
      ]
    });
    expect(validateProjectSemantics(plan)).toEqual([]);
  });

  it("creates a contiguous branch-mine route with a bounded excavation count", () => {
    const route = createBranchMineRoute(
      { x: 10, y: -53, z: 20 },
      20,
      3,
      4
    );
    expect(route.length).toBeGreaterThanOrEqual(20);
    for (let index = 1; index < route.length; index += 1) {
      const previous = route[index - 1]!;
      const current = route[index]!;
      expect(
        Math.abs(current.x - previous.x) +
          Math.abs(current.y - previous.y) +
          Math.abs(current.z - previous.z)
      ).toBe(1);
    }
  });

  it("accepts the generated storage-to-diamond progression", () => {
    const plan = parseProjectPlanDraft(
      generatedMiningProgressionProject(7, { x: 10, y: 64, z: -5 })
    );
    expect(validateProjectSemantics(plan)).toEqual([]);
    expect(plan.steps.map((step) => step.spec.kind)).toContain("smelt_item");
    expect(plan.steps.filter((step) => step.spec.kind === "prospect_resource"))
      .toHaveLength(4);
    expect(
      plan.steps.findIndex((step) => step.id === "craft_tool_planks")
    ).toBeLessThan(
      plan.steps.findIndex((step) => step.id === "craft_chest")
    );
    expect(
      plan.steps.findIndex((step) => step.id === "craft_stone_pickaxe")
    ).toBeLessThan(
      plan.steps.findIndex((step) => step.id === "prospect_coal")
    );
    expect(
      plan.steps.findIndex((step) => step.id === "craft_wood_sword")
    ).toBeLessThan(
      plan.steps.findIndex((step) => step.id === "gather_cobblestone")
    );
    expect(plan.steps.at(-1)?.spec).toMatchObject({
      kind: "deposit_item",
      itemName: "diamond",
      minimumCount: 3
    });
  });
});
