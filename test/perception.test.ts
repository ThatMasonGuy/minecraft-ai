import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import { Perception, resolveRaycastBlock } from "../src/perception.js";

describe("resolveRaycastBlock", () => {
  it("accepts prismarine-world's runtime Block shape", () => {
    const position = new Vec3(4, 70, -9);
    const blockAt = vi.fn();

    expect(
      resolveRaycastBlock(
        { blockAt } as never,
        { name: "oak_log", position, intersect: position }
      )
    ).toEqual({ name: "oak_log", position });
    expect(blockAt).not.toHaveBeenCalled();
  });

  it("returns only currently visible matches from targeted resource sensing", () => {
    const visiblePosition = new Vec3(4, 70, -9);
    const hiddenPosition = new Vec3(6, 70, -9);
    const visibleBlock = { name: "birch_log", position: visiblePosition };
    const hiddenBlock = { name: "birch_log", position: hiddenPosition };
    const bot = {
      entity: { position: new Vec3(4, 69, -6), height: 1.62 },
      registry: { blocksByName: { birch_log: { id: 17 } } },
      findBlocks: vi.fn(() => [visiblePosition, hiddenPosition]),
      blockAt: vi.fn((position: Vec3) =>
        position.equals(visiblePosition) ? visibleBlock : hiddenBlock
      ),
      canSeeBlock: vi.fn((block: unknown) => block === visibleBlock)
    };
    const perception = new Perception(bot as never, 32, {
      snapshot: () => [],
      emptySlots: () => 36
    } as never);

    expect(perception.findVisibleBlocks(["birch_log"])).toEqual([
      expect.objectContaining({ name: "birch_log", x: 4, y: 70, z: -9 })
    ]);
  });

  it("also accepts the coordinate-only declared shape", () => {
    const position = new Vec3(4, 70, -9);
    const blockAt = vi.fn(() => ({
      name: "birch_log",
      position
    }));

    expect(
      resolveRaycastBlock(
        { blockAt } as never,
        { x: 4, y: 70, z: -9, intersect: position }
      )
    ).toEqual({ name: "birch_log", position });
    expect(blockAt).toHaveBeenCalledWith(position);
  });

  it("inspects a known coordinate only when the block is actually visible", () => {
    const position = new Vec3(4, 70, -9);
    const block = { name: "oak_log", position };
    const bot = {
      entity: { position: new Vec3(4, 69, -6), height: 1.62 },
      blockAt: vi.fn(() => block),
      canSeeBlock: vi.fn(() => true)
    };
    const perception = new Perception(bot as never, 32, {
      snapshot: () => [],
      emptySlots: () => 36
    } as never);

    expect(perception.inspectVisibleBlock(4, 70, -9)).toMatchObject({
      name: "oak_log",
      x: 4,
      y: 70,
      z: -9
    });
    expect(bot.canSeeBlock).toHaveBeenCalledWith(block);

    bot.canSeeBlock.mockReturnValue(false);
    expect(perception.inspectVisibleBlock(4, 71, -9)).toBeUndefined();
  });
});
