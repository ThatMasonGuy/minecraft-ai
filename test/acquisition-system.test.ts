import { describe, expect, it, vi } from "vitest";
import {
  AcquisitionSystem,
  matchesGatherSource,
  spiralOffset
} from "../src/acquisition-system.js";

describe("spiralOffset", () => {
  it("produces adjacent expanding search waypoints", () => {
    const firstRing = Array.from({ length: 8 }, (_, index) =>
      spiralOffset(index)
    );
    expect(firstRing).toEqual([
      { x: 1, z: 0 },
      { x: 1, z: 1 },
      { x: 0, z: 1 },
      { x: -1, z: 1 },
      { x: -1, z: 0 },
      { x: -1, z: -1 },
      { x: 0, z: -1 },
      { x: 1, z: -1 }
    ]);
    expect(spiralOffset(8)).toEqual({ x: 2, z: -1 });
  });
});

describe("matchesGatherSource", () => {
  it("does not mix log species when progress tracks one item", () => {
    const order = {
      spec: {
        itemName: "birch_log",
        blockNames: ["birch_log", "oak_log"]
      }
    } as never;
    expect(matchesGatherSource(order, "birch_log")).toBe(true);
    expect(matchesGatherSource(order, "oak_log")).toBe(false);
  });
});

describe("resource-site reuse", () => {
  it("returns to a remembered tree and clears visible canopy before blind search", async () => {
    const order = {
      id: 79,
      spec: {
        itemName: "birch_log",
        blockNames: ["birch_log"],
        minimumCount: 22,
        continuation: "until_replaced",
        storage: { mode: "inventory" }
      },
      progressCount: 1,
      lastInventoryCount: 1
    };
    const site = {
      id: 4,
      blockName: "birch_log",
      position: { x: 34, y: 76, z: -95 },
      dimension: "overworld"
    };
    const reachSurfaceArea = vi.fn(async () => ({
      status: "reached",
      position: site.position
    }));
    const clearApproachVegetation = vi.fn(async () => ({
      status: "cleared",
      blockName: "birch_leaves",
      position: { x: 33, y: 77, z: -95 }
    }));
    const rememberedBlock = { name: "birch_log" };
    const system = new AcquisitionSystem(
      {
        activeWorkOrder: vi.fn(() => order),
        updateWorkOrderProgress: vi.fn(),
        knownResourceSites: vi.fn(() => [site]),
        rememberResourceSite: vi.fn(),
        depleteResourceSite: vi.fn()
      } as never,
      { record: vi.fn(), activity: vi.fn() } as never,
      {
        observe: vi.fn(() => ({
          observedAt: "2026-08-03T07:06:56.950Z",
          position: { x: 0, y: 64, z: 0 },
          dimension: "overworld",
          inventory: [{ name: "birch_log", count: 1 }],
          emptyInventorySlots: 20,
          visibleBlocks: []
        })),
        findVisibleBlocks: vi.fn(() => []),
        blockAt: vi.fn(() => rememberedBlock),
        canSeeBlock: vi.fn(() => false)
      } as never,
      { reachSurfaceArea } as never,
      {
        mineBlock: vi.fn(),
        clearApproachVegetation
      } as never,
      {} as never,
      { snapshot: vi.fn(() => ({ health: 20, food: 20 })) } as never,
      1_000,
      vi.fn()
    );

    await (system as unknown as { tick(): Promise<void> }).tick();

    expect(reachSurfaceArea).toHaveBeenCalledWith(site.position, 5);
    expect(clearApproachVegetation).toHaveBeenCalledWith(site.position);
  });
});
