import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import {
  droppedItem,
  isDroppedItemEntity
} from "./entity-classification.js";
import type { EpisodicMemory } from "./memory.js";
import type { MovementSystem } from "./movement-system.js";
import type { SensingSystem } from "./perception.js";
import type { Position } from "./types.js";

export interface LootCollectionRequest {
  sessionId: string;
  origin: Position;
  radius: number;
  clearConfirmationMs?: number;
  includeItem?: (itemName: string) => boolean;
}

export type LootCollectionResult =
  | { status: "moving"; entityId: number; itemName?: string; displayName?: string }
  | { status: "confirming_clear" }
  | { status: "clear"; collectedCount: number };

interface LootSession {
  noLootSince?: number;
  collectedCount: number;
}

export interface LootingSystem {
  start(): void;
  stop(): void;
  collectStep(request: LootCollectionRequest): LootCollectionResult;
  endSession(sessionId: string): void;
}

export class MineflayerLootingSystem implements LootingSystem {
  private readonly sessions = new Map<string, LootSession>();

  constructor(
    private readonly bot: Bot,
    private readonly memory: EpisodicMemory,
    private readonly sensing: SensingSystem,
    private readonly movement: Pick<MovementSystem, "approach">
  ) {}

  start(): void {
    this.bot.on("playerCollect", this.onPlayerCollect);
  }

  stop(): void {
    this.bot.removeListener("playerCollect", this.onPlayerCollect);
    this.sessions.clear();
  }

  collectStep(request: LootCollectionRequest): LootCollectionResult {
    const session = this.sessions.get(request.sessionId) ?? { collectedCount: 0 };
    this.sessions.set(request.sessionId, session);
    const current = this.bot.entity.position;
    const target = this.sensing
      .visibleEntitiesRaw(request.radius)
      .filter(isDroppedItemEntity)
      .filter((entity) => distance(request.origin, entity.position) <= request.radius)
      .filter((entity) => distance(current, entity.position) <= request.radius)
      .map((entity) => ({ entity, item: droppedItem(entity) }))
      .filter(({ item }) =>
        item && request.includeItem ? request.includeItem(item.name) : true
      )
      .sort(
        (a, b) => distance(current, a.entity.position) - distance(current, b.entity.position)
      )[0];

    if (!target) {
      session.noLootSince ??= Date.now();
      if (Date.now() - session.noLootSince >= (request.clearConfirmationMs ?? 1_500)) {
        return { status: "clear", collectedCount: session.collectedCount };
      }
      return { status: "confirming_clear" };
    }

    session.noLootSince = undefined;
    this.movement.approach(toPosition(target.entity.position), 0);
    return {
      status: "moving",
      entityId: target.entity.id,
      itemName: target.item?.name,
      displayName: target.item?.displayName
    };
  }

  endSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private readonly onPlayerCollect = (collector: Entity, collected: Entity): void => {
    if (collector.id !== this.bot.entity.id) return;
    const item = droppedItem(collected);
    if (!item) return;
    for (const session of this.sessions.values()) {
      session.collectedCount += item.count;
      session.noLootSince = undefined;
    }
    this.memory.record({
      kind: "loot",
      summary: `Collected dropped ${item.name}`,
      payload: { itemName: item.name, count: item.count },
      position: toPosition(this.bot.entity.position),
      dimension: String(this.bot.game.dimension ?? "unknown"),
      importance: 5
    });
  };
}

function distance(
  a: Pick<Position, "x" | "y" | "z">,
  b: Pick<Position, "x" | "y" | "z">
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function toPosition(position: Pick<Position, "x" | "y" | "z">): Position {
  return { x: position.x, y: position.y, z: position.z };
}
