import { describe, expect, it, vi } from "vitest";
import { MineflayerInventorySystem } from "../src/inventory-system.js";

function inventoryWith(items: Array<{ name: string; count: number; slot: number }>) {
  const slots = Array.from({ length: 46 });
  for (const item of items) slots[item.slot] = item;
  const bot = {
    inventory: {
      items: () => items,
      emptySlotCount: () => 30,
      slots,
      inventoryStart: 9,
      hotbarStart: 36
    },
    registry: { foodsByName: { bread: {} } },
    heldItem: undefined,
    getEquipmentDestSlot: () => 45,
    equip: vi.fn(async () => undefined),
    consume: vi.fn(async () => undefined),
    pathfinder: { bestHarvestTool: vi.fn(() => undefined) }
  };
  return { bot, inventory: new MineflayerInventorySystem(bot as never) };
}

describe("inventory authority", () => {
  it("reserves stock without double-allocating it", () => {
    const { inventory } = inventoryWith([
      { name: "cobblestone", count: 12, slot: 9 }
    ]);

    expect(
      inventory.reserve("building:1", [{ itemName: "cobblestone", count: 8 }])
    ).toMatchObject({ status: "reserved" });
    expect(inventory.availableCount("cobblestone")).toBe(4);
    expect(
      inventory.reserve("crafting:1", [{ itemName: "cobblestone", count: 5 }])
    ).toEqual({
      status: "unavailable",
      itemName: "cobblestone",
      requested: 5,
      available: 4
    });
    inventory.release("building:1");
    expect(inventory.availableCount("cobblestone")).toBe(12);
  });

  it("owns equipment and consumption mutations", async () => {
    const bread = { name: "bread", count: 2, slot: 36 };
    const { bot, inventory } = inventoryWith([bread]);

    expect(await inventory.consume("bread")).toBe(true);
    expect(bot.equip).toHaveBeenCalledWith(bread, "hand");
    expect(bot.consume).toHaveBeenCalledOnce();
    expect(inventory.foodCount()).toBe(2);
  });
});
