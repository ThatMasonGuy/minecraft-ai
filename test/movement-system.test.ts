import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import {
  escapeCandidateYOffsets,
  PathfinderMovementSystem,
  selectEscapeDestination
} from "../src/movement-system.js";

describe("movement escape routing", () => {
  it("selects a passable destination that increases separation", () => {
    const destination = selectEscapeDestination(
      { x: 0, y: 64, z: 0 },
      [{ position: { x: 2, y: 64, z: 0 } }],
      () => true
    );

    expect(destination).toBeDefined();
    expect(destination!.x).toBeLessThan(0);
    expect(Math.hypot(destination!.x - 2, destination!.z)).toBeGreaterThan(2);
  });

  it("escapes the combined danger field instead of only the current target", () => {
    const destination = selectEscapeDestination(
      { x: 0, y: 64, z: 0 },
      [
        { position: { x: 3, y: 64, z: 0 } },
        { position: { x: 0, y: 64, z: 3 } }
      ],
      () => true
    );

    expect(destination).toBeDefined();
    expect(destination!.x).toBeLessThan(0);
    expect(destination!.z).toBeLessThan(0);
  });

  it("returns no route when every candidate is unsafe", () => {
    expect(
      selectEscapeDestination(
        { x: 0, y: 64, z: 0 },
        [{ position: { x: 1, y: 64, z: 0 } }],
        () => false
      )
    ).toBeUndefined();
  });

  it("finds a dry escape landing above the current water level", () => {
    const destination = selectEscapeDestination(
      { x: 0, y: 62, z: 0 },
      [{ position: { x: 2, y: 62, z: 0 } }],
      (position) => position.y === 64
    );

    expect(destination).toMatchObject({ y: 64 });
    expect(destination!.x).toBeLessThan(0);
    expect(escapeCandidateYOffsets(2)).toEqual([0, 1, -1, 2, -2]);
  });

  it("abandons an escape destination that makes no positional progress", () => {
    vi.useFakeTimers();
    try {
      const setGoal = vi.fn();
      const bot = {
        entity: { position: new Vec3(0, 64, 0) },
        pathfinder: { setGoal },
        clearControlStates: vi.fn()
      };
      const sensing = {
        blockAt: (position: { y: number }) => ({
          name: position.y === 63 ? "stone" : "air",
          boundingBox: position.y === 63 ? "block" : "empty"
        })
      };
      const movement = new PathfinderMovementSystem(
        bot as never,
        {} as never,
        sensing as never
      );
      const request = {
        dangers: [{ position: { x: 2, y: 64, z: 0 } }],
        safeDistance: 24
      };

      const first = movement.escape(request);
      expect(first.status).toBe("moving");
      vi.advanceTimersByTime(4_001);
      const second = movement.escape(request);

      expect(second.status).toBe("moving");
      expect(second).not.toEqual(first);
      expect(setGoal).toHaveBeenCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps one useful escape goal while movement is making progress", () => {
    vi.useFakeTimers();
    try {
      const setGoal = vi.fn();
      const position = new Vec3(0, 64, 0);
      const bot = {
        entity: { position },
        pathfinder: { setGoal },
        clearControlStates: vi.fn()
      };
      const sensing = {
        blockAt: (block: { y: number }) => ({
          name: block.y === 63 ? "stone" : "air",
          boundingBox: block.y === 63 ? "block" : "empty"
        })
      };
      const movement = new PathfinderMovementSystem(
        bot as never,
        {} as never,
        sensing as never
      );
      const request = {
        dangers: [{ position: { x: 2, y: 64, z: 0 } }],
        safeDistance: 24
      };

      const first = movement.escape(request);
      expect(first.status).toBe("moving");
      position.x = -1;
      vi.advanceTimersByTime(750);
      const second = movement.escape(request);
      position.x = -2;
      vi.advanceTimersByTime(750);
      const third = movement.escape(request);

      expect(second).toEqual(first);
      expect(third).toEqual(first);
      expect(setGoal).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
