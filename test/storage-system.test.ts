import { describe, expect, it, vi } from "vitest";
import { MineflayerStorageSystem } from "../src/storage-system.js";

describe("storage authority", () => {
  it("owns container transfer and durable owned-container accounting", async () => {
    let carried = [{ name: "cobblestone", count: 12, type: 1, metadata: 0 }];
    const container = {
      deposit: vi.fn(async () => {
        carried = [];
      }),
      close: vi.fn()
    };
    const bot = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      game: { dimension: "overworld" },
      openContainer: vi.fn(async () => container)
    };
    const memory = {
      ownedContainers: () => [
        {
          id: 7,
          position: { x: 2, y: 64, z: 0 },
          dimension: "overworld",
          blockName: "chest",
          contents: {}
        }
      ],
      recordContainerDeposit: vi.fn(),
      record: vi.fn()
    };
    const inventory = {
      items: () => carried,
      count: (name: string) =>
        carried.filter((item) => item.name === name).reduce((sum, item) => sum + item.count, 0)
    };
    const storage = new MineflayerStorageSystem(
      bot as never,
      memory as never,
      { blockAt: () => ({ name: "chest" }) } as never,
      { positionForBlock: vi.fn(async () => undefined) } as never,
      inventory as never
    );

    expect(
      await storage.deposit({ x: 2, y: 64, z: 0 }, "cobblestone")
    ).toEqual({
      status: "stored",
      itemName: "cobblestone",
      count: 12,
      containerId: 7
    });
    expect(memory.recordContainerDeposit).toHaveBeenCalledWith(7, "cobblestone", 12);
    expect(container.close).toHaveBeenCalledOnce();
  });

  it("rejects withdrawals from containers outside the owned registry", async () => {
    const bot = {
      game: { dimension: "overworld" },
      openContainer: vi.fn()
    };
    const storage = new MineflayerStorageSystem(
      bot as never,
      { ownedContainers: () => [] } as never,
      {} as never,
      {} as never,
      {} as never
    );
    expect(
      await storage.withdraw({ x: 1, y: 64, z: 1 }, "iron_ingot", 1)
    ).toMatchObject({ status: "blocked", detail: "container is not registered as owned" });
    expect(bot.openContainer).not.toHaveBeenCalled();
  });
});
