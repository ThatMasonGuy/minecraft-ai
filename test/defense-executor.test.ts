import { describe, expect, it } from "vitest";
import {
  boundedEvasionDestination,
  boundedPassableEvasionDestination,
  isPermittedDefenseSource,
  isDroppedItemEntity,
  isRecognizedHostileName
} from "../src/defense-executor.js";

describe("defensive target safety", () => {
  it("never permits a player source", () => {
    expect(
      isPermittedDefenseSource({ type: "player", username: "another_player" })
    ).toBe(false);
  });

  it("permits a non-player mob that actually caused damage", () => {
    expect(
      isPermittedDefenseSource({ type: "hostile", username: undefined })
    ).toBe(true);
  });

  it.each(["zombie", "Skeleton", "phantom", "cave spider"])(
    "recognizes %s as an autonomous survival threat",
    (name) => {
      expect(isRecognizedHostileName(name)).toBe(true);
    }
  );

  it.each(["pig", "cow", "villager", "player"])(
    "does not proactively attack %s",
    (name) => {
      expect(isRecognizedHostileName(name)).toBe(false);
    }
  );

  it("recognizes only actual dropped-item entities as loot", () => {
    expect(isDroppedItemEntity({ getDroppedItem: () => ({ name: "arrow" }) as never }))
      .toBe(true);
    expect(isDroppedItemEntity({ getDroppedItem: () => null })).toBe(false);
    expect(
      isDroppedItemEntity({
        getDroppedItem: () => {
          throw new Error("metadata not ready");
        }
      })
    ).toBe(false);
  });

  it("bounds deterministic evasion instead of chaining an open-ended escape", () => {
    const destination = boundedEvasionDestination(
      { x: 10, y: 64, z: 10 },
      { x: 7, y: 64, z: 6 },
      6
    );
    expect(
      Math.hypot(destination.x - 10, destination.z - 10)
    ).toBeCloseTo(6);
    expect(destination.y).toBe(64);
  });

  it("selects an open corridor instead of evading into a wall", () => {
    const openCells = new Set([
      "9,64,10",
      "8,64,10",
      "7,64,10",
      "11,64,10"
    ]);
    expect(
      boundedPassableEvasionDestination(
        { x: 10, y: 64, z: 10 },
        { x: 12, y: 64, z: 10 },
        6,
        (position) =>
          openCells.has(`${position.x},${position.y},${position.z}`)
      )
    ).toEqual({ x: 7, y: 64, z: 10 });
  });
});
