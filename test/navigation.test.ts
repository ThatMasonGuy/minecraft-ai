import { describe, expect, it } from "vitest";
import {
  appendTraversalCell,
  isCurrentSupportBlock,
  isSingleStepVerticalRejoin,
  nextReverseTraversalTarget
} from "../src/navigation.js";

describe("deterministic traversal journals", () => {
  it("records actual settled cells without duplicating stationary ticks", () => {
    const journal = { cells: [] };
    expect(
      appendTraversalCell(journal, { x: 10.8, y: 64, z: -3.2 })
    ).toBe(true);
    expect(
      appendTraversalCell(journal, { x: 10.2, y: 64.9, z: -3.8 })
    ).toBe(false);
    expect(
      appendTraversalCell(journal, { x: 10.5, y: 63, z: -4.1 })
    ).toBe(true);
    expect(journal.cells).toEqual([
      { x: 10, y: 64, z: -4 },
      { x: 10, y: 63, z: -5 }
    ]);
  });

  it("reverses the route that was actually traversed", () => {
    const journal = {
      cells: [
        { x: 4, y: 70, z: 4 },
        { x: 4, y: 69, z: 3 },
        { x: 5, y: 68, z: 3 }
      ]
    };
    expect(
      nextReverseTraversalTarget(journal, { x: 5, y: 68, z: 3 })
    ).toEqual({
      cursor: 1,
      target: { x: 4, y: 69, z: 3 },
      complete: false
    });
    expect(
      nextReverseTraversalTarget(
        journal,
        { x: 4, y: 69, z: 3 },
        1
      )
    ).toEqual({
      cursor: 0,
      target: { x: 4, y: 70, z: 4 },
      complete: false
    });
    expect(
      nextReverseTraversalTarget(
        journal,
        { x: 4, y: 70, z: 4 },
        0
      )
    ).toEqual({ cursor: 0, complete: true });
  });

  it("refuses to invent a route when the player is off journal", () => {
    const journal = {
      cells: [
        { x: 0, y: 64, z: 0 },
        { x: 1, y: 63, z: 0 }
      ]
    };
    expect(
      nextReverseTraversalTarget(
        journal,
        { x: 20, y: 12, z: 20 }
      )
    ).toBeUndefined();
  });

  it("rejoins the nearest recorded cell before reversing the route", () => {
    const journal = {
      cells: [
        { x: 22, y: 78, z: -35 },
        { x: 23, y: 77, z: -35 },
        { x: 24, y: 76, z: -35 },
        { x: 25, y: 75, z: -35 }
      ]
    };
    expect(
      nextReverseTraversalTarget(
        journal,
        { x: 26, y: 74, z: -35 },
        undefined,
        2,
        8
      )
    ).toEqual({
      cursor: 3,
      target: { x: 25, y: 75, z: -35 },
      complete: false
    });
  });

  it("can skip validated checkpoints while preserving reverse order", () => {
    const journal = {
      cells: Array.from({ length: 12 }, (_, index) => ({
        x: index,
        y: 64,
        z: 0
      }))
    };
    expect(
      nextReverseTraversalTarget(
        journal,
        { x: 11, y: 64, z: 0 },
        11,
        2,
        8
      )
    ).toEqual({
      cursor: 3,
      target: { x: 3, y: 64, z: 0 },
      complete: false
    });
  });

  it("only permits a scaffold rejoin for one vertical block", () => {
    expect(
      isSingleStepVerticalRejoin(
        { x: 4, y: 63, z: 9 },
        { x: 4, y: 64, z: 9 }
      )
    ).toBe(true);
    expect(
      isSingleStepVerticalRejoin(
        { x: 4, y: 63, z: 9 },
        { x: 4, y: 65, z: 9 }
      )
    ).toBe(false);
    expect(
      isSingleStepVerticalRejoin(
        { x: 4, y: 63, z: 9 },
        { x: 5, y: 64, z: 9 }
      )
    ).toBe(false);
  });

  it("identifies only the block directly supporting the player", () => {
    const player = { x: 25, y: 74, z: -35 };
    expect(
      isCurrentSupportBlock(player, { x: 25, y: 73, z: -35 })
    ).toBe(true);
    expect(
      isCurrentSupportBlock(player, { x: 24, y: 73, z: -35 })
    ).toBe(false);
  });
});
