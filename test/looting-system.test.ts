import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import { MineflayerLootingSystem } from "../src/looting-system.js";

describe("looting authority", () => {
  it("selects and routes to the nearest permitted visible drop", () => {
    const emitter = new EventEmitter();
    const near = {
      id: 2,
      position: new Vec3(2, 64, 0),
      getDroppedItem: () => ({ name: "rotten_flesh", displayName: "Rotten Flesh", count: 1 })
    };
    const far = {
      id: 3,
      position: new Vec3(5, 64, 0),
      getDroppedItem: () => ({ name: "iron_ingot", displayName: "Iron Ingot", count: 1 })
    };
    const bot = Object.assign(emitter, {
      entity: { id: 1, position: new Vec3(0, 64, 0) },
      game: { dimension: "overworld" }
    });
    const movement = { approach: vi.fn() };
    const looting = new MineflayerLootingSystem(
      bot as never,
      { record: vi.fn() } as never,
      { visibleEntitiesRaw: () => [near, far] } as never,
      movement as never
    );

    expect(
      looting.collectStep({
        sessionId: "test",
        origin: { x: 0, y: 64, z: 0 },
        radius: 8,
        includeItem: (name) => name !== "rotten_flesh"
      })
    ).toMatchObject({ status: "moving", entityId: 3, itemName: "iron_ingot" });
    expect(movement.approach).toHaveBeenCalledWith(far.position, 0);
  });

  it("owns collection confirmation and durable loot events", () => {
    const emitter = new EventEmitter();
    const bot = Object.assign(emitter, {
      entity: { id: 1, position: new Vec3(0, 64, 0) },
      game: { dimension: "overworld" }
    });
    const memory = { record: vi.fn() };
    const looting = new MineflayerLootingSystem(
      bot as never,
      memory as never,
      { visibleEntitiesRaw: () => [] } as never,
      { approach: vi.fn() } as never
    );
    looting.start();
    emitter.emit("playerCollect", bot.entity, {
      getDroppedItem: () => ({ name: "bone", count: 2 })
    });
    expect(memory.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "loot", payload: { itemName: "bone", count: 2 } })
    );
    expect(
      looting.collectStep({
        sessionId: "clear",
        origin: { x: 0, y: 64, z: 0 },
        radius: 8,
        clearConfirmationMs: 0
      })
    ).toEqual({ status: "clear", collectedCount: 0 });
    looting.stop();
  });
});
