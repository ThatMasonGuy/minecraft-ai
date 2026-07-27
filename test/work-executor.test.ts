import { describe, expect, it } from "vitest";
import { matchesGatherSource, spiralOffset } from "../src/work-executor.js";

describe("spiralOffset", () => {
  it("produces adjacent expanding search waypoints", () => {
    const firstRing = Array.from({ length: 8 }, (_, index) =>
      spiralOffset(index)
    );
    expect(firstRing).toEqual([
      { x: 1, z: 0 },
      { x: 1, z: 1 },
      { x: 0, z: 1 },
      { x: -1, z: 1 },
      { x: -1, z: 0 },
      { x: -1, z: -1 },
      { x: 0, z: -1 },
      { x: 1, z: -1 }
    ]);
    expect(spiralOffset(8)).toEqual({ x: 2, z: -1 });
  });
});

describe("matchesGatherSource", () => {
  it("does not mix log species when progress tracks one item", () => {
    const order = {
      spec: {
        itemName: "birch_log",
        blockNames: ["birch_log", "oak_log"]
      }
    } as never;
    expect(matchesGatherSource(order, "birch_log")).toBe(true);
    expect(matchesGatherSource(order, "oak_log")).toBe(false);
  });
});
