import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import {
  attackCooldownMs,
  CombatSystem,
  decideCombat,
  selectBestWeapon
} from "../src/combat-system.js";
import {
  isDroppedItemEntity,
  isPermittedMobTarget,
  isRecognizedHostileName
} from "../src/entity-classification.js";

describe("combat policy", () => {
  it("refuses voluntary unarmed zombie combat", () => {
    expect(
      decideCombat({
        targetName: "zombie",
        health: 20,
        armorPieces: 0,
        nearbyHostiles: 1,
        hasShield: false
      })
    ).toMatchObject({ action: "escape", reason: expect.stringMatching(/weapon/) });
  });

  it("fights one melee hostile when equipped and healthy", () => {
    expect(
      decideCombat({
        targetName: "zombie",
        health: 20,
        armorPieces: 0,
        nearbyHostiles: 1,
        weaponName: "stone_sword",
        hasShield: false
      })
    ).toEqual({ action: "fight" });
  });

  it("escapes ranged, explosive, and multi-target fights it cannot control", () => {
    expect(
      decideCombat({
        targetName: "skeleton",
        health: 20,
        armorPieces: 4,
        nearbyHostiles: 1,
        weaponName: "diamond_sword",
        hasShield: false
      }).action
    ).toBe("escape");
    expect(
      decideCombat({
        targetName: "creeper",
        health: 20,
        armorPieces: 4,
        nearbyHostiles: 1,
        weaponName: "diamond_sword",
        hasShield: true
      }).action
    ).toBe("escape");
    expect(
      decideCombat({
        targetName: "zombie",
        health: 20,
        armorPieces: 4,
        nearbyHostiles: 2,
        weaponName: "diamond_sword",
        hasShield: true
      }).action
    ).toBe("escape");
  });
});

describe("combat equipment", () => {
  it("selects by combat value instead of inventory order or item category", () => {
    expect(
      selectBestWeapon([
        { name: "wooden_sword" },
        { name: "stone_axe" },
        { name: "diamond_sword" }
      ])?.name
    ).toBe("diamond_sword");
  });

  it("uses server-tick-aligned cooldowns for the equipped weapon", () => {
    expect(attackCooldownMs("wooden_axe")).toBeGreaterThan(
      attackCooldownMs("stone_sword")
    );
    expect(attackCooldownMs("stone_sword")).toBeGreaterThan(
      attackCooldownMs(undefined)
    );
  });
});

describe("combat target safety", () => {
  it("never permits a player as a mob combat target", () => {
    expect(
      isPermittedMobTarget({ type: "player", username: "Mason" })
    ).toBe(false);
    expect(isRecognizedHostileName("zombie")).toBe(true);
    expect(isRecognizedHostileName("player")).toBe(false);
  });

  it("recognizes only actual dropped-item entities as loot", () => {
    expect(
      isDroppedItemEntity({ getDroppedItem: () => ({ name: "arrow" }) as never })
    ).toBe(true);
    expect(isDroppedItemEntity({ getDroppedItem: () => null })).toBe(false);
  });
});

describe("player aggression escape", () => {
  it("does not retaliate and delegates escape to movement after the second hit", async () => {
    const emitter = new EventEmitter();
    const botEntity = {
      id: 1,
      height: 1.8,
      position: new Vec3(0, 64, 0)
    };
    const player = {
      id: 2,
      type: "player",
      username: "attacker",
      isValid: true,
      position: new Vec3(2, 64, 0)
    };
    const bot = Object.assign(emitter, {
      entity: botEntity,
      entities: { 1: botEntity, 2: player },
      health: 20,
      food: 20,
      game: { dimension: "overworld" },
      inventory: { items: () => [], slots: [] },
      autoEat: {
        enableAuto: vi.fn(),
        disableAuto: vi.fn(),
        cancelEat: vi.fn(),
        isEating: false
      },
      world: { raycast: vi.fn(() => null) },
      attack: vi.fn(),
      activateItem: vi.fn(),
      deactivateItem: vi.fn(),
      getEquipmentDestSlot: vi.fn(() => 45),
      heldItem: undefined
    });
    const movement = {
      follow: vi.fn(),
      approach: vi.fn(),
      face: vi.fn(async () => undefined),
      hold: vi.fn(),
      escape: vi.fn(() => ({
        status: "moving" as const,
        destination: { x: -10, y: 64, z: 0 }
      }))
    };
    const memory = { record: vi.fn(), activity: vi.fn() };
    const sensing = {
      visibleEntitiesRaw: () => [player],
      hasLineOfSight: () => true
    };
    const inventory = {
      items: () => [],
      find: () => undefined,
      heldItem: () => undefined,
      equipment: () => undefined,
      equip: vi.fn(async () => false)
    };
    const combat = new CombatSystem(
      bot as never,
      memory as never,
      movement,
      sensing as never,
      inventory as never,
      { collectStep: vi.fn(), endSession: vi.fn() } as never,
      {
        snapshot: () => ({
          health: 20,
          food: 20,
          oxygen: 20,
          dangerous: false,
          combatReady: true
        }),
        suspendAutoCare: vi.fn(),
        resumeAutoCare: vi.fn(),
        isEating: () => false
      } as never
    );
    combat.start();

    emitter.emit("entityHurt", botEntity, player);
    expect(combat.currentMode()).toBe("idle");
    expect(bot.attack).not.toHaveBeenCalled();

    emitter.emit("entityHurt", botEntity, player);
    expect(combat.currentMode()).toBe("escaping");
    emitter.emit("physicsTick");
    await vi.waitFor(() => expect(movement.escape).toHaveBeenCalled());

    expect(bot.attack).not.toHaveBeenCalled();
    expect(movement.escape).toHaveBeenCalledWith({
      dangers: [{ position: player.position }],
      safeDistance: 18
    });
    combat.stop();
  });
});

describe("combat escape recovery", () => {
  it("keeps ranged separation and resumes escape when recovery takes damage", async () => {
    vi.useFakeTimers();
    try {
      const emitter = new EventEmitter();
      const botEntity = {
        id: 1,
        height: 1.8,
        position: new Vec3(0, 64, 0)
      };
      const skeleton = {
        id: 3,
        type: "hostile",
        name: "skeleton",
        displayName: "Skeleton",
        username: undefined,
        isValid: true,
        height: 1.99,
        position: new Vec3(12, 64, 0)
      };
      const bot = Object.assign(emitter, {
        entity: botEntity,
        entities: { 1: botEntity, 3: skeleton },
        game: { dimension: "overworld" },
        attack: vi.fn(),
        activateItem: vi.fn(),
        deactivateItem: vi.fn()
      });
      const movement = {
        follow: vi.fn(),
        approach: vi.fn(),
        face: vi.fn(async () => undefined),
        hold: vi.fn(),
        escape: vi.fn(() => ({ status: "safe" as const }))
      };
      const combat = new CombatSystem(
        bot as never,
        { record: vi.fn(), activity: vi.fn() } as never,
        movement,
        {
          visibleEntitiesRaw: () => [skeleton],
          hasLineOfSight: () => true
        } as never,
        {
          items: () => [],
          find: () => undefined,
          heldItem: () => undefined,
          equipment: () => undefined,
          equip: vi.fn(async () => false)
        } as never,
        { collectStep: vi.fn(), endSession: vi.fn() } as never,
        {
          snapshot: () => ({
            health: 20,
            food: 20,
            oxygen: 20,
            dangerous: false,
            combatReady: true
          }),
          suspendAutoCare: vi.fn(),
          resumeAutoCare: vi.fn(),
          isEating: () => false
        } as never
      );
      combat.start();

      emitter.emit("physicsTick");
      expect(combat.currentMode()).toBe("escaping");
      await Promise.resolve();
      emitter.emit("physicsTick");
      await Promise.resolve();
      expect(movement.escape).toHaveBeenLastCalledWith({
        dangers: [{ position: skeleton.position }],
        safeDistance: 24
      });

      vi.advanceTimersByTime(4_001);
      emitter.emit("physicsTick");
      await Promise.resolve();
      expect(combat.currentMode()).toBe("recovering");

      emitter.emit("entityHurt", botEntity, skeleton);
      expect(combat.currentMode()).toBe("escaping");
      expect(bot.attack).not.toHaveBeenCalled();
      combat.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("combat API ownership", () => {
  it("accepts a visible non-player target and rejects player targeting", () => {
    const emitter = new EventEmitter();
    const botEntity = { id: 1, height: 1.8, position: new Vec3(0, 64, 0) };
    const cow = {
      id: 4,
      type: "mob",
      name: "cow",
      displayName: "Cow",
      isValid: true,
      height: 1.4,
      position: new Vec3(3, 64, 0)
    };
    const player = {
      id: 5,
      type: "player",
      name: "player",
      displayName: "Player",
      username: "friend",
      isValid: true,
      height: 1.8,
      position: new Vec3(2, 64, 0)
    };
    const entities = new Map([
      [cow.id, cow],
      [player.id, player]
    ]);
    const combat = new CombatSystem(
      Object.assign(emitter, {
        entity: botEntity,
        game: { dimension: "overworld" },
        attack: vi.fn(),
        activateItem: vi.fn(),
        deactivateItem: vi.fn()
      }) as never,
      { record: vi.fn(), activity: vi.fn() } as never,
      { hold: vi.fn() } as never,
      {
        entityById: (id: number) => entities.get(id),
        hasLineOfSight: () => true,
        visibleEntitiesRaw: () => []
      } as never,
      {
        items: () => [{ name: "wooden_sword" }],
        equipment: () => undefined,
        find: () => undefined,
        heldItem: () => undefined
      } as never,
      { collectStep: vi.fn(), endSession: vi.fn() } as never,
      {
        snapshot: () => ({
          health: 20,
          food: 20,
          oxygen: 20,
          dangerous: false,
          combatReady: true
        })
      } as never
    );

    expect(combat.engageVisibleMob(player.id, "test request")).toBe("rejected");
    expect(combat.engageVisibleMob(cow.id, "food acquisition")).toBe("engaged");
    expect(combat.currentMode()).toBe("pursuing");
  });
});

describe("enclosed combat movement", () => {
  it("owns the strike cycle while delegating pursuit and spacing outcomes", async () => {
    const emitter = new EventEmitter();
    const weapon = { name: "stone_sword" };
    const botEntity = {
      id: 1,
      height: 1.8,
      position: new Vec3(0, 64, 0)
    };
    const zombie = {
      id: 3,
      type: "hostile",
      name: "zombie",
      displayName: "Zombie",
      username: undefined,
      isValid: true,
      height: 1.95,
      position: new Vec3(2.9, 64, 0)
    };
    const bot = Object.assign(emitter, {
      entity: botEntity,
      entities: { 1: botEntity, 3: zombie },
      health: 20,
      food: 20,
      game: { dimension: "overworld" },
      inventory: { items: () => [weapon], slots: [] },
      heldItem: weapon,
      autoEat: {
        enableAuto: vi.fn(),
        disableAuto: vi.fn(),
        cancelEat: vi.fn(),
        isEating: false
      },
      world: { raycast: vi.fn(() => null) },
      lookAt: vi.fn(async () => undefined),
      equip: vi.fn(async () => undefined),
      attack: vi.fn(),
      activateItem: vi.fn(),
      deactivateItem: vi.fn(),
      getEquipmentDestSlot: vi.fn(() => 45)
    });
    const movement = {
      follow: vi.fn(),
      approach: vi.fn(),
      face: vi.fn(async () => undefined),
      hold: vi.fn(),
      escape: vi.fn(() => ({
        status: "moving" as const,
        destination: { x: -8, y: 64, z: 0 }
      }))
    };
    const combat = new CombatSystem(
      bot as never,
      { record: vi.fn(), activity: vi.fn() } as never,
      movement,
      {
        visibleEntitiesRaw: () => [zombie],
        hasLineOfSight: () => true
      } as never,
      {
        items: () => [weapon],
        find: () => undefined,
        heldItem: () => weapon,
        equipment: () => undefined,
        equip: vi.fn(async () => true)
      } as never,
      { collectStep: vi.fn(), endSession: vi.fn() } as never,
      {
        snapshot: () => ({
          health: 20,
          food: 20,
          oxygen: 20,
          dangerous: false,
          combatReady: true
        }),
        suspendAutoCare: vi.fn(),
        resumeAutoCare: vi.fn(),
        isEating: () => false
      } as never
    );
    combat.start();

    emitter.emit("physicsTick");
    await vi.waitFor(() => expect(combat.currentMode()).toBe("pursuing"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    emitter.emit("physicsTick");
    await vi.waitFor(() => expect(bot.attack).toHaveBeenCalledWith(zombie));
    expect(combat.currentMode()).toBe("spacing");

    await new Promise((resolve) => setTimeout(resolve, 0));
    emitter.emit("physicsTick");
    await vi.waitFor(() => expect(movement.escape).toHaveBeenCalled());
    expect(movement.escape).toHaveBeenCalledWith({
      dangers: [{ position: zombie.position }],
      safeDistance: 4.5
    });
    combat.stop();
  });
});
