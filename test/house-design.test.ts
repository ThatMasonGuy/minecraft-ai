import { describe, expect, it } from "vitest";
import {
  analyzeHouseDesign,
  parseHouseDesign
} from "../src/house-design.js";
import { generatedHouseProject } from "../src/generated-projects.js";
import { validateProjectSemantics } from "../src/project-plan.js";

const lShapedLodge = {
  designName: "L-shaped workshop lodge",
  footprintRows: [
    "###D###",
    "#######",
    "#######",
    "###....",
    "###....",
    "###...."
  ],
  wallHeight: 4
};

describe("planner-authored house design", () => {
  it("accepts a connected arbitrary footprint with one exterior entrance", () => {
    const design = parseHouseDesign(lShapedLodge);
    const analysis = analyzeHouseDesign(design);

    expect(analysis).toMatchObject({
      width: 7,
      depth: 6,
      door: { dx: 3, dz: 0 }
    });
    expect(analysis.cells).toHaveLength(30);
    expect(analysis.interiorCells.length).toBeGreaterThan(0);
  });

  it("compiles the authored shape rather than selecting a layout preset", () => {
    const plan = generatedHouseProject(undefined, "spruce", lShapedLodge);
    const survey = plan.steps.find((step) => step.id === "survey_site");
    const shell = plan.steps.find((step) => step.id === "build_shell");

    expect(plan.title).toBe("Build L-shaped workshop lodge in spruce");
    expect(survey?.spec).toMatchObject({
      kind: "survey_site",
      width: 7,
      depth: 6,
      clearanceHeight: 5
    });
    expect(shell?.spec.kind).toBe("place_blueprint");
    if (shell?.spec.kind === "place_blueprint") {
      const roof = shell.spec.placements.filter((placement) => placement.dy === 4);
      expect(roof).toHaveLength(30);
      expect(roof).toContainEqual(
        expect.objectContaining({ dx: 0, dz: 5, itemName: "spruce_planks" })
      );
      expect(roof).not.toContainEqual(expect.objectContaining({ dx: 6, dz: 5 }));
      expect(shell.spec.placements).toContainEqual(
        expect.objectContaining({
          dx: 3,
          dy: 0,
          dz: 0,
          itemName: "spruce_door"
        })
      );
    }
    expect(validateProjectSemantics(plan)).toEqual([]);
  });

  it("rejects disconnected footprints and ambiguous entrances", () => {
    expect(() =>
      parseHouseDesign({
        designName: "Disconnected",
        footprintRows: ["D##...", "###...", "......", "...###", "...###"],
        wallHeight: 3
      })
    ).toThrow(/orthogonally connected/);
    expect(() =>
      parseHouseDesign({
        designName: "Two doors",
        footprintRows: ["##D##", "#####", "#####", "#####", "##D##"],
        wallHeight: 3
      })
    ).toThrow(/exactly one D/);
  });
});
