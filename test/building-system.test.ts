import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import { MineflayerBuildingSystem } from "../src/building-system.js";

describe("building authority", () => {
  it("owns placement, equipment, orientation, and verification", async () => {
    const reference = {
      name: "stone",
      boundingBox: "block",
      position: new Vec3(0, 63, 0)
    };
    const placed = {
      name: "torch",
      boundingBox: "empty",
      position: new Vec3(0, 64, 0)
    };
    let didPlace = false;
    const sensing = {
      blockAt: (position: { x: number; y: number; z: number }) =>
        position.y === 63 ? reference : didPlace ? placed : { name: "air", boundingBox: "empty" }
    };
    const bot = {
      entity: { position: new Vec3(2, 64, 0) },
      game: { dimension: "overworld" },
      placeBlock: vi.fn(async () => {
        didPlace = true;
      })
    };
    const inventory = {
      find: () => ({ name: "torch" }),
      equip: vi.fn(async () => true)
    };
    const movement = {
      face: vi.fn(async () => undefined),
      positionForBlock: vi.fn(async () => undefined)
    };
    const building = new MineflayerBuildingSystem(
      bot as never,
      { activeProject: () => undefined, registerOwnedContainer: vi.fn() } as never,
      sensing as never,
      movement as never,
      inventory as never,
      {} as never
    );

    expect(
      await building.placeAgainst(
        { x: 0, y: 63, z: 0 },
        { x: 0, y: 1, z: 0 },
        "torch"
      )
    ).toMatchObject({ status: "placed", itemName: "torch" });
    expect(inventory.equip).toHaveBeenCalled();
    expect(movement.face).toHaveBeenCalled();
    expect(bot.placeBlock).toHaveBeenCalledWith(reference, new Vec3(0, 1, 0));
  });

  it("reports missing carried materials without mutating the world", async () => {
    const bot = {
      entity: { position: new Vec3(0, 64, 0) },
      placeBlock: vi.fn()
    };
    const building = new MineflayerBuildingSystem(
      bot as never,
      {} as never,
      {} as never,
      {} as never,
      { find: () => undefined } as never,
      {} as never
    );
    expect(
      await building.placeAgainst(
        { x: 0, y: 63, z: 0 },
        { x: 0, y: 1, z: 0 },
        "cobblestone"
      )
    ).toMatchObject({ status: "blocked", detail: "cobblestone is missing" });
    expect(bot.placeBlock).not.toHaveBeenCalled();
  });
});
