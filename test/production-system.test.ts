import { describe, expect, it, vi } from "vitest";
import { MineflayerProductionSystem } from "../src/production-system.js";

describe("production authority", () => {
  it("owns recipe resolution and bounded craft execution", async () => {
    const recipe = { result: { count: 4 } };
    const bot = {
      registry: { itemsByName: { stick: { id: 10 } } },
      recipesFor: vi.fn(() => [recipe]),
      craft: vi.fn(async () => undefined)
    };
    const production = new MineflayerProductionSystem(
      bot as never,
      {} as never,
      {} as never,
      {} as never
    );

    expect(await production.produce({ itemName: "stick", count: 7 })).toEqual({
      status: "produced",
      itemName: "stick",
      producedCount: 8,
      executions: 2
    });
    expect(bot.craft).toHaveBeenCalledWith(recipe, 2, undefined);
  });

  it("returns an explicit unavailable outcome when ingredients are missing", async () => {
    const bot = {
      registry: { itemsByName: { stone_pickaxe: { id: 12 } } },
      recipesFor: vi.fn(() => []),
      craft: vi.fn()
    };
    const production = new MineflayerProductionSystem(
      bot as never,
      {} as never,
      {} as never,
      {} as never
    );
    expect(await production.craftOne("stone_pickaxe")).toMatchObject({
      status: "unavailable",
      itemName: "stone_pickaxe"
    });
    expect(bot.craft).not.toHaveBeenCalled();
  });
});
