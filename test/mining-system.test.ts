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
});
