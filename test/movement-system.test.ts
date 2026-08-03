import { describe, expect, it } from "vitest";
import { selectEscapeDestination } from "../src/movement-system.js";

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
});
