import { describe, expect, it } from "vitest";
import { selectBuildSiteCandidate } from "../src/project-system.js";

describe("project build-site selection", () => {
  it("prefers clearing a nearby obstruction over roaming to a perfect site", () => {
    const candidate = selectBuildSiteCandidate({
      center: { x: 0, y: 64, z: 0 },
      width: 3,
      depth: 3,
      clearanceHeight: 3,
      searchRadius: 3,
      maxObstructions: 8,
      blockAt: ({ x, y, z }) => {
        if (y === 63) return { name: "grass_block", boundingBox: "block" };
        if (x === 0 && y === 64 && z === 0) {
          return { name: "oak_log", boundingBox: "block" };
        }
        return { name: "air", boundingBox: "empty" };
      },
      canMine: () => true
    });

    expect(candidate).toEqual({
      anchor: { x: -1, y: 64, z: -1 },
      obstructions: 1,
      score: 1
    });
  });

  it("rejects unsafe or protected clearance instead of destroying it", () => {
    const candidate = selectBuildSiteCandidate({
      center: { x: 0, y: 64, z: 0 },
      width: 3,
      depth: 3,
      clearanceHeight: 3,
      searchRadius: 0,
      maxObstructions: 8,
      blockAt: ({ y }) =>
        y === 63
          ? { name: "grass_block", boundingBox: "block" }
          : { name: "chest", boundingBox: "block" },
      canMine: () => true
    });

    expect(candidate).toBeUndefined();
  });

  it("finds a nearby level surface even when the bot is above its build elevation", () => {
    const candidate = selectBuildSiteCandidate({
      center: { x: 0, y: 67, z: 0 },
      width: 3,
      depth: 3,
      clearanceHeight: 3,
      searchRadius: 0,
      maxObstructions: 8,
      blockAt: ({ y }) =>
        y === 63
          ? { name: "grass_block", boundingBox: "block" }
          : { name: "air", boundingBox: "empty" },
      canMine: () => true
    });

    expect(candidate).toEqual({
      anchor: { x: -1, y: 64, z: -1 },
      obstructions: 0,
      score: 6
    });
  });
});
