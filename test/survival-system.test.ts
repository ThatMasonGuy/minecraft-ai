import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import { MineflayerSurvivalSystem } from "../src/survival-system.js";

describe("enclosed survival policy", () => {
  it("owns automatic care and edge-triggers dangerous-vitals escalation", async () => {
    const emitter = new EventEmitter();
    const autoEat = {
      setOpts: vi.fn(),
      enableAuto: vi.fn(),
      disableAuto: vi.fn(),
      cancelEat: vi.fn(),
      isEating: false
    };
    const bot = Object.assign(emitter, {
      health: 20,
      food: 20,
      oxygenLevel: 20,
      autoEat,
      armorManager: { equipAll: vi.fn(async () => undefined) },
      entity: { position: new Vec3(1, 64, 2) },
      game: { dimension: "overworld" }
    });
    const memory = { record: vi.fn() };
    const inventory = { consume: vi.fn(async () => true) };
    const onDanger = vi.fn();
    const system = new MineflayerSurvivalSystem(
      bot as never,
      memory as never,
      {} as never,
      {} as never,
      inventory as never,
      { onDanger }
    );

    system.start();
    expect(autoEat.setOpts).toHaveBeenCalledWith(
      expect.objectContaining({ minHunger: 16, minHealth: 14 })
    );
    expect(autoEat.enableAuto).toHaveBeenCalledTimes(1);

    bot.health = 8;
    emitter.emit("health");
    emitter.emit("health");
    expect(onDanger).toHaveBeenCalledTimes(1);
    expect(system.snapshot()).toMatchObject({ dangerous: true, combatReady: false });

    system.suspendAutoCare();
    system.resumeAutoCare();
    expect(autoEat.disableAuto).toHaveBeenCalledTimes(1);
    expect(autoEat.cancelEat).toHaveBeenCalledTimes(1);
    expect(autoEat.enableAuto).toHaveBeenCalledTimes(2);
    await expect(system.consume("bread")).resolves.toBe(true);
    expect(inventory.consume).toHaveBeenCalledWith("bread");

    system.stop();
    expect(autoEat.disableAuto).toHaveBeenCalledTimes(2);
  });
});
