import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import { MineflayerMiningSystem } from "../src/mining-system.js";

function miningHarness(blockName: string) {
  const block = { name: blockName, position: new Vec3(2, 64, 0) };
  const wooden = { name: "wooden_pickaxe" };
  const iron = { name: "iron_pickaxe" };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    canDigBlock: vi.fn(() => true),
    dig: vi.fn(async () => undefined),
    stopDigging: vi.fn()
  };
  const inventory = {
    items: () => [wooden, iron],
    bestHarvestTool: vi.fn(() => iron),
    equip: vi.fn(async () => true)
  };
  const movement = {
    positionForBlock: vi.fn(async () => undefined),
    goNear: vi.fn(async () => undefined),
    hold: vi.fn(),
    stepToAdjacent: vi.fn(async () => undefined)
  };
  const mining = new MineflayerMiningSystem(
    bot as never,
    { blockAt: () => block } as never,
    movement as never,
    inventory as never
  );
  return { block, bot, inventory, movement, mining };
}

describe("mining authority", () => {
  it("selects the lowest sufficient pickaxe and owns the dig mutation", async () => {
    const { bot, inventory, mining } = miningHarness("diamond_ore");
    const result = await mining.mineBlock({
      position: { x: 2, y: 64, z: 0 },
      collectAfter: false
    });

    expect(result).toMatchObject({ status: "mined", blockName: "diamond_ore" });
    expect(inventory.equip).toHaveBeenCalledWith(
      expect.objectContaining({ name: "iron_pickaxe" }),
      "hand"
    );
    expect(bot.dig).toHaveBeenCalledOnce();
  });

  it("refuses to excavate protected utility blocks by default", async () => {
    const { bot, mining } = miningHarness("crafting_table");
    expect(
      await mining.mineBlock({ position: { x: 2, y: 64, z: 0 } })
    ).toMatchObject({ status: "blocked", detail: "protected crafting_table" });
    expect(bot.dig).not.toHaveBeenCalled();
  });

  it("clears a bounded build volume one verified obstruction at a time", async () => {
    let cleared = false;
    const obstruction = {
      name: "oak_log",
      boundingBox: "block",
      position: new Vec3(0, 64, 0)
    };
    const air = {
      name: "air",
      boundingBox: "empty",
      position: new Vec3(0, 64, 0)
    };
    const ground = {
      name: "grass_block",
      boundingBox: "block",
      position: new Vec3(0, 63, 0)
    };
    const bot = {
      entity: { position: new Vec3(2, 64, 0) },
      canDigBlock: vi.fn(() => true),
      dig: vi.fn(async () => {
        cleared = true;
      }),
      stopDigging: vi.fn()
    };
    const mining = new MineflayerMiningSystem(
      bot as never,
      {
        blockAt: ({ y }: { y: number }) =>
          y === 63 ? ground : cleared ? air : obstruction
      } as never,
      {
        positionForBlock: vi.fn(async () => undefined),
        goNear: vi.fn(async () => undefined)
      } as never,
      {
        items: () => [],
        bestHarvestTool: () => undefined,
        equip: vi.fn()
      } as never
    );
    const request = {
      anchor: { x: 0, y: 64, z: 0 },
      width: 1,
      depth: 1,
      clearanceHeight: 1,
      maxExcavations: 1
    };

    await expect(mining.prepareBuildSite(request)).resolves.toEqual({
      status: "progress",
      excavated: 1,
      remaining: 0
    });
    await expect(mining.prepareBuildSite(request)).resolves.toEqual({
      status: "ready",
      excavated: 0,
      remaining: 0
    });
  });

  it("refuses to prepare a build site over unsupported ground", async () => {
    const { mining } = miningHarness("air");
    await expect(
      mining.prepareBuildSite({
        anchor: { x: 0, y: 64, z: 0 },
        width: 1,
        depth: 1,
        clearanceHeight: 2,
        maxExcavations: 4
      })
    ).resolves.toMatchObject({
      status: "blocked",
      detail: expect.stringContaining("unsupported")
    });
  });
});
