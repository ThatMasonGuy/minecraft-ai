import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type {
  PerceptionSnapshot,
  Position,
  VisibleBlock,
  VisibleEntity
} from "./types.js";
import type { InventorySystem } from "./inventory-system.js";

export type SensedBlock = NonNullable<ReturnType<Bot["blockAt"]>>;

export interface SensingSystem {
  observe(): PerceptionSnapshot;
  last(): PerceptionSnapshot | undefined;
  isBlockCurrentlyVisible(x: number, y: number, z: number): boolean;
  visibleEntity(id: number): VisibleEntity | undefined;
  inspectVisibleBlock(x: number, y: number, z: number): VisibleBlock | undefined;
  findVisibleBlocks(
    blockNames: string[],
    maxDistance?: number,
    count?: number
  ): VisibleBlock[];
  blockAt(
    position: Pick<Position, "x" | "y" | "z">,
    visibility?: "loaded" | "visible"
  ): SensedBlock | undefined;
  canSeeBlock(block: SensedBlock): boolean;
  visibleEntitiesRaw(maxDistance?: number): Entity[];
  entityById(id: number): Entity | undefined;
  hasLineOfSight(entity: Entity): boolean;
  isLoaded(position: Pick<Position, "x" | "y" | "z">): boolean;
}

export class MineflayerSensingSystem implements SensingSystem {
  private lastSnapshot?: PerceptionSnapshot;

  constructor(
    private readonly bot: Bot,
    private readonly maxDistance: number,
    private readonly inventory: InventorySystem
  ) {}

  observe(): PerceptionSnapshot {
    if (!this.bot.entity) throw new Error("The bot has not spawned");

    const snapshot: PerceptionSnapshot = {
      observedAt: new Date().toISOString(),
      position: roundPosition(this.bot.entity.position),
      yawDegrees: round((this.bot.entity.yaw * 180) / Math.PI),
      pitchDegrees: round((this.bot.entity.pitch * 180) / Math.PI),
      dimension: String(this.bot.game.dimension ?? "unknown"),
      health: this.bot.health,
      food: this.bot.food,
      oxygen: this.bot.oxygenLevel,
      isRaining: this.bot.isRaining,
      timeOfDay: this.bot.time.timeOfDay,
      inventory: this.inventory.snapshot(),
      emptyInventorySlots: this.inventory.emptySlots(),
      visibleBlocks: this.sampleVisibleBlocks(),
      visibleEntities: this.visibleEntities()
    };
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  last(): PerceptionSnapshot | undefined {
    return this.lastSnapshot;
  }

  isBlockCurrentlyVisible(x: number, y: number, z: number): boolean {
    return (
      this.lastSnapshot?.visibleBlocks.some(
        (block) => block.x === x && block.y === y && block.z === z
      ) ?? false
    );
  }

  visibleEntity(id: number): VisibleEntity | undefined {
    return this.lastSnapshot?.visibleEntities.find((entity) => entity.id === id);
  }

  visibleEntitiesRaw(maxDistance = this.maxDistance): Entity[] {
    if (!this.bot.entity) return [];
    const origin = this.bot.entity.position;
    return Object.values(this.bot.entities)
      .filter((entity) => entity.id !== this.bot.entity.id)
      .filter((entity) => origin.distanceTo(entity.position) <= maxDistance)
      .filter((entity) => this.hasLineOfSight(entity));
  }

  entityById(id: number): Entity | undefined {
    return this.visibleEntitiesRaw().find((entity) => entity.id === id);
  }

  hasLineOfSight(entity: Entity): boolean {
    return this.hasLineOfSightToEntity(entity);
  }

  inspectVisibleBlock(x: number, y: number, z: number): VisibleBlock | undefined {
    const position = new Vec3(x, y, z);
    const origin = this.bot.entity.position.offset(0, this.bot.entity.height, 0);
    if (origin.distanceTo(position) > this.maxDistance) return undefined;

    const block = this.bot.blockAt(position);
    if (!block || block.name === "air" || !this.bot.canSeeBlock(block)) {
      return undefined;
    }

    const visible = {
      name: block.name,
      x: block.position.x,
      y: block.position.y,
      z: block.position.z,
      distance: round(origin.distanceTo(block.position))
    };
    if (this.lastSnapshot) {
      this.lastSnapshot.visibleBlocks = [
        ...this.lastSnapshot.visibleBlocks.filter(
          (candidate) =>
            candidate.x !== visible.x ||
            candidate.y !== visible.y ||
            candidate.z !== visible.z
        ),
        visible
      ].sort((a, b) => a.distance - b.distance);
    }
    return visible;
  }

  findVisibleBlocks(
    blockNames: string[],
    maxDistance = this.maxDistance,
    count = 64
  ): VisibleBlock[] {
    const blockIds = blockNames
      .map((name) => this.bot.registry.blocksByName[name]?.id)
      .filter((id): id is number => id !== undefined);
    if (blockIds.length === 0 || count <= 0) return [];
    const origin = this.bot.entity.position.offset(0, this.bot.entity.height, 0);
    const visible = new Map<string, VisibleBlock>();
    const positions = this.bot.findBlocks({
      matching: blockIds,
      maxDistance: Math.min(this.maxDistance, maxDistance),
      count: Math.max(256, count * 8)
    });
    for (const position of positions) {
      const block = this.bot.blockAt(position);
      if (!block || !this.bot.canSeeBlock(block)) continue;
      const key = `${position.x},${position.y},${position.z}`;
      visible.set(key, {
        name: block.name,
        x: position.x,
        y: position.y,
        z: position.z,
        distance: round(origin.distanceTo(position))
      });
    }
    return [...visible.values()]
      .sort((left, right) => left.distance - right.distance)
      .slice(0, count);
  }

  blockAt(
    position: Pick<Position, "x" | "y" | "z">,
    visibility: "loaded" | "visible" = "loaded"
  ): SensedBlock | undefined {
    const block = this.bot.blockAt(new Vec3(position.x, position.y, position.z));
    if (!block) return undefined;
    if (visibility === "visible" && !this.bot.canSeeBlock(block)) return undefined;
    return block;
  }

  canSeeBlock(block: SensedBlock): boolean {
    return this.bot.canSeeBlock(block);
  }

  isLoaded(position: Pick<Position, "x" | "y" | "z">): boolean {
    return (
      this.bot.world.getColumnAt(
        new Vec3(position.x, position.y, position.z)
      ) !== null
    );
  }

  private sampleVisibleBlocks(): VisibleBlock[] {
    const origin = this.bot.entity.position.offset(0, this.bot.entity.height, 0);
    const seen = new Map<string, VisibleBlock>();
    const horizontalRays = 32;
    const verticalAngles = [-65, -45, -30, -15, 0, 15, 30, 45, 65];

    for (let horizontal = 0; horizontal < horizontalRays; horizontal += 1) {
      const yaw = (horizontal / horizontalRays) * Math.PI * 2;
      for (const pitchDegrees of verticalAngles) {
        const pitch = (pitchDegrees * Math.PI) / 180;
        const direction = new Vec3(
          -Math.sin(yaw) * Math.cos(pitch),
          -Math.sin(pitch),
          -Math.cos(yaw) * Math.cos(pitch)
        );
        const hit = this.bot.world.raycast(origin, direction, this.maxDistance);
        if (!hit) continue;
        const block = resolveRaycastBlock(this.bot, hit);
        if (!block) continue;
        const position = block.position;
        const key = `${position.x},${position.y},${position.z}`;
        seen.set(key, {
          name: block.name,
          x: position.x,
          y: position.y,
          z: position.z,
          distance: round(origin.distanceTo(position))
        });
      }
    }

    return [...seen.values()].sort((a, b) => a.distance - b.distance);
  }

  private visibleEntities(): VisibleEntity[] {
    const origin = this.bot.entity.position;
    return Object.values(this.bot.entities)
      .filter((entity) => entity.id !== this.bot.entity.id)
      .filter((entity) => origin.distanceTo(entity.position) <= this.maxDistance)
      .filter((entity) => this.hasLineOfSightToEntity(entity))
      .map((entity) => ({
        id: entity.id,
        name: entity.name ?? entity.displayName ?? entity.type ?? "unknown",
        kind: entity.type ?? "unknown",
        username: entity.username,
        ...roundPosition(entity.position),
        distance: round(origin.distanceTo(entity.position))
      }))
      .sort((a, b) => a.distance - b.distance);
  }

  private hasLineOfSightToEntity(entity: {
    position: Vec3;
    height?: number;
  }): boolean {
    const origin = this.bot.entity.position.offset(0, this.bot.entity.height, 0);
    const target = entity.position.offset(0, (entity.height ?? 1.6) / 2, 0);
    const direction = target.minus(origin);
    const distance = direction.norm();
    if (distance === 0) return true;
    const hit = this.bot.world.raycast(origin, direction.scaled(1 / distance), distance);
    return hit === null || origin.distanceTo(hit.intersect) >= distance - 0.2;
  }
}

export { MineflayerSensingSystem as Perception };

export function resolveRaycastBlock(
  bot: Pick<Bot, "blockAt">,
  hit: unknown
): { name: string; position: Vec3 } | undefined {
  const value = hit as {
    name?: unknown;
    position?: unknown;
    x?: unknown;
    y?: unknown;
    z?: unknown;
  };

  // prismarine-world currently returns a full Block at runtime even though its
  // declaration describes a coordinate-only RaycastResult.
  if (
    typeof value.name === "string" &&
    value.position instanceof Vec3
  ) {
    return { name: value.name, position: value.position };
  }

  if (
    typeof value.x !== "number" ||
    typeof value.y !== "number" ||
    typeof value.z !== "number"
  ) {
    return undefined;
  }
  const position = new Vec3(value.x, value.y, value.z);
  const block = bot.blockAt(position);
  return block ? { name: block.name, position: block.position } : undefined;
}

function roundPosition(position: Vec3): { x: number; y: number; z: number } {
  return {
    x: round(position.x),
    y: round(position.y),
    z: round(position.z)
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
