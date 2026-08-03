import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import {
  isFallingBlockName,
  isProtectedExcavationBlockName,
  isReplaceableBlockName
} from "./block-classification.js";
import type { InventorySystem } from "./inventory-system.js";
import type { MovementSystem } from "./movement-system.js";
import type { SensingSystem } from "./perception.js";
import type { Position } from "./types.js";

export interface MineBlockRequest {
  position: Position;
  requireVisible?: boolean;
  allowProtected?: boolean;
  approach?: boolean;
  collectAfter?: boolean;
}

export type MiningResult =
  | { status: "mined"; blockName: string; position: Position }
  | { status: "already_clear"; position: Position }
  | { status: "blocked"; position: Position; detail: string };

export type SitePreparationResult =
  | { status: "ready"; excavated: number; remaining: 0 }
  | { status: "progress"; excavated: number; remaining: number }
  | { status: "blocked"; excavated: number; detail: string };

export interface MiningSystem {
  mineBlock(request: MineBlockRequest): Promise<MiningResult>;
  excavateAndEnter(target: Position, clearanceHeight?: number): Promise<number>;
  prepareBuildSite(request: {
    anchor: Position;
    width: number;
    depth: number;
    clearanceHeight: number;
    maxExcavations: number;
  }): Promise<SitePreparationResult>;
  canMine(position: Position): boolean;
}

export class MineflayerMiningSystem implements MiningSystem {
  constructor(
    private readonly bot: Bot,
    private readonly sensing: SensingSystem,
    private readonly movement: MovementSystem,
    private readonly inventory: InventorySystem
  ) {}

  async mineBlock(request: MineBlockRequest): Promise<MiningResult> {
    let block = this.sensing.blockAt(
      request.position,
      request.requireVisible ? "visible" : "loaded"
    );
    if (!block || isReplaceableBlockName(block.name)) {
      return { status: "already_clear", position: request.position };
    }
    if (block.name === "water" || block.name === "lava") {
      return { status: "blocked", position: request.position, detail: `unsafe ${block.name}` };
    }
    if (!request.allowProtected && isProtectedExcavationBlockName(block.name)) {
      return {
        status: "blocked",
        position: request.position,
        detail: `protected ${block.name}`
      };
    }
    if (request.approach !== false && !this.bot.canDigBlock(block)) {
      await this.movement.positionForBlock(request.position);
      block = this.sensing.blockAt(
        request.position,
        request.requireVisible ? "visible" : "loaded"
      );
    }
    if (!block || !this.bot.canDigBlock(block)) {
      return {
        status: "blocked",
        position: request.position,
        detail: `cannot dig ${block?.name ?? "unloaded block"}`
      };
    }

    const tool = lowestSufficientPickaxe(this.inventory, block.name) ??
      this.inventory.bestHarvestTool(block);
    if (tool) await this.inventory.equip(tool, "hand");
    try {
      await withTimeout(this.bot.dig(block), 10_000, () => this.bot.stopDigging());
    } catch (error) {
      return {
        status: "blocked",
        position: request.position,
        detail: error instanceof Error ? error.message : String(error)
      };
    }
    if (request.collectAfter !== false) {
      try {
        await this.movement.goNear(
          { x: request.position.x, y: this.bot.entity.position.y, z: request.position.z },
          1,
          10_000
        );
      } catch {
        // The block is mined; collection routing remains best effort here.
      }
    }
    return { status: "mined", blockName: block.name, position: request.position };
  }

  async excavateAndEnter(target: Position, clearanceHeight = 2): Promise<number> {
    let topY = target.y + clearanceHeight - 1;
    for (let extra = 0; extra < 8; extra += 1) {
      const above = this.sensing.blockAt({ x: target.x, y: topY + 1, z: target.z });
      if (!above || !isFallingBlockName(above.name)) break;
      topY += 1;
    }
    const positions = Array.from(
      { length: topY - target.y + 1 },
      (_, index) => ({ x: target.x, y: topY - index, z: target.z })
    );
    let excavated = 0;
    for (const position of positions) {
      const result = await this.mineBlock({
        position,
        approach: false,
        collectAfter: false
      });
      if (result.status === "blocked") throw new Error(result.detail);
      if (result.status === "mined") excavated += 1;
    }

    this.movement.hold();
    const targetVector = new Vec3(target.x, target.y, target.z);
    if (!this.bot.entity.position.floored().equals(targetVector)) {
      await this.movement.stepToAdjacent(
        target,
        target.y > Math.floor(this.bot.entity.position.y)
      );
    }
    const reached = this.bot.entity.position.floored();
    if (!reached.equals(targetVector)) {
      throw new Error(
        `movement stopped at ${reached.x},${reached.y},${reached.z} instead of ` +
          `${target.x},${target.y},${target.z}`
      );
    }
    await wait(400);
    const settled = this.bot.entity.position.floored();
    if (!settled.equals(targetVector)) {
      throw new Error(
        `physics settled at ${settled.x},${settled.y},${settled.z} instead of ` +
          `${target.x},${target.y},${target.z}`
      );
    }
    return excavated;
  }

  async prepareBuildSite(request: {
    anchor: Position;
    width: number;
    depth: number;
    clearanceHeight: number;
    maxExcavations: number;
  }): Promise<SitePreparationResult> {
    const obstructions: Position[] = [];
    for (let dx = 0; dx < request.width; dx += 1) {
      for (let dz = 0; dz < request.depth; dz += 1) {
        const x = request.anchor.x + dx;
        const z = request.anchor.z + dz;
        const ground = this.sensing.blockAt({ x, y: request.anchor.y - 1, z });
        if (!isSolidGround(ground?.name, ground?.boundingBox)) {
          return {
            status: "blocked",
            excavated: 0,
            detail: `build floor is unsupported at ${x},${request.anchor.y - 1},${z}`
          };
        }
        for (let dy = 0; dy < request.clearanceHeight; dy += 1) {
          const position = { x, y: request.anchor.y + dy, z };
          const block = this.sensing.blockAt(position);
          if (!block) {
            return {
              status: "blocked",
              excavated: 0,
              detail: `build clearance is unloaded at ${position.x},${position.y},${position.z}`
            };
          }
          if (isReplaceableBlockName(block.name)) continue;
          if (
            block.name === "water" ||
            block.name === "lava" ||
            isProtectedExcavationBlockName(block.name)
          ) {
            return {
              status: "blocked",
              excavated: 0,
              detail: `build clearance contains protected or unsafe ${block.name}`
            };
          }
          obstructions.push(position);
        }
      }
    }

    if (obstructions.length === 0) {
      return { status: "ready", excavated: 0, remaining: 0 };
    }
    if (request.maxExcavations <= 0 || obstructions.length > request.maxExcavations) {
      return {
        status: "blocked",
        excavated: 0,
        detail:
          `site needs ${obstructions.length} more excavations but ` +
          `${request.maxExcavations} are allowed`
      };
    }

    const target = obstructions.sort(
      (left, right) => distanceSquared(left, this.bot.entity.position) -
        distanceSquared(right, this.bot.entity.position)
    )[0]!;
    const result = await this.mineBlock({
      position: target,
      collectAfter: false
    });
    if (result.status === "blocked") {
      return { status: "blocked", excavated: 0, detail: result.detail };
    }
    const excavated = result.status === "mined" ? 1 : 0;
    return {
      status: "progress",
      excavated,
      remaining: Math.max(0, obstructions.length - excavated)
    };
  }

  canMine(position: Position): boolean {
    const block = this.sensing.blockAt(position);
    return Boolean(block && this.bot.canDigBlock(block));
  }
}

function isSolidGround(
  name: string | undefined,
  boundingBox: string | undefined
): boolean {
  return Boolean(
    name &&
      boundingBox === "block" &&
      name !== "water" &&
      name !== "lava" &&
      !isReplaceableBlockName(name)
  );
}

function distanceSquared(left: Position, right: Position): number {
  return (
    (left.x - right.x) ** 2 +
    (left.y - right.y) ** 2 +
    (left.z - right.z) ** 2
  );
}

function lowestSufficientPickaxe(inventory: InventorySystem, blockName: string) {
  const minimumRank =
    blockName.includes("diamond_ore") ||
    blockName.includes("emerald_ore") ||
    blockName.includes("gold_ore") ||
    blockName.includes("redstone_ore")
      ? 2
      : blockName.includes("iron_ore") ||
          blockName.includes("lapis_ore") ||
          blockName.includes("copper_ore")
        ? 1
        : 0;
  const ranks: Record<string, number> = {
    wooden_pickaxe: 0,
    golden_pickaxe: 0,
    stone_pickaxe: 1,
    iron_pickaxe: 2,
    diamond_pickaxe: 3,
    netherite_pickaxe: 4
  };
  return inventory
    .items()
    .filter((item) => ranks[item.name] !== undefined && ranks[item.name]! >= minimumRank)
    .sort((a, b) => ranks[a.name]! - ranks[b.name]!)[0];
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  onTimeout: () => void
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`Mining timed out after ${milliseconds}ms`));
        }, milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
