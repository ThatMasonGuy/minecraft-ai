import { describe, expect, it, vi } from "vitest";
import {
  FoodProvisioningSystem,
  foodAnimalPriority,
  needsFoodProvisioning,
  selectProvisioningFood
} from "../src/food-provisioning-system.js";

function item(name: string, count = 1) {
  return { name, count } as never;
}

describe("enclosed food provisioning", () => {
  it("activates before unsafe hunger can strand ordinary work", () => {
    expect(needsFoodProvisioning({ health: 0.5, food: 17 }, 0)).toBe(true);
    expect(needsFoodProvisioning({ health: 20, food: 20 }, 3)).toBe(false);
  });

  it("uses risky food only as a critical emergency fallback", () => {
    const inventory = { isFood: () => true };
    expect(
      selectProvisioningFood(
        [item("rotten_flesh")],
        inventory,
        { health: 7, food: 17 }
      )?.name
    ).toBe("rotten_flesh");
    expect(
      selectProvisioningFood(
        [item("rotten_flesh")],
        inventory,
        { health: 16, food: 17 }
      )
    ).toBeUndefined();
  });

  it("consumes held emergency food before attempting movement", async () => {
    const consume = vi.fn(async () => true);
    const movement = { hold: vi.fn(), reachSurfaceArea: vi.fn() };
    const system = new FoodProvisioningSystem(
      { record: vi.fn(), activity: vi.fn() } as never,
      {
        last: vi.fn(() => ({ position: { x: 0, y: 64, z: 0 } })),
        observe: vi.fn(),
        visibleEntitiesRaw: vi.fn(() => []),
        entityById: vi.fn()
      } as never,
      movement as never,
      {
        items: vi.fn(() => [item("rotten_flesh")]),
        isFood: vi.fn(() => true)
      } as never,
      {
        snapshot: vi.fn(() => ({ health: 2, food: 17, oxygen: 20 })),
        consume
      } as never,
      { engageVisiblePassiveMob: vi.fn() } as never,
      { collectStep: vi.fn(), endSession: vi.fn() } as never,
      500
    );

    await (system as unknown as { tick(): Promise<void> }).tick();

    expect(consume).toHaveBeenCalledWith("rotten_flesh");
    expect(movement.reachSurfaceArea).not.toHaveBeenCalled();
  });

  it("selects passive food sources without treating hostiles as food", () => {
    expect(foodAnimalPriority("cow")).toBeGreaterThan(
      foodAnimalPriority("chicken")
    );
    expect(foodAnimalPriority("zombie")).toBe(0);
  });
});
