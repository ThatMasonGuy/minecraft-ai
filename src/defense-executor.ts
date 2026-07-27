import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { EpisodicMemory } from "./memory.js";
import type { ActivityUpdate } from "./types.js";

const require = createRequire(import.meta.url);
const { goals } = require(
  "mineflayer-pathfinder"
) as typeof import("mineflayer-pathfinder");
const { GoalFollow, GoalNear } = goals;

const ATTACK_INTERVAL_MS = 550;
const MAX_PURSUIT_DISTANCE = 16;
const MAX_COMBAT_DURATION_MS = 20_000;
const THREAT_SCAN_INTERVAL_MS = 250;
const LOOT_COLLECTION_DURATION_MS = 8_000;
const LOOT_SEARCH_RADIUS = 8;
const HOSTILE_MOBS = new Set([
  "blaze",
  "bogged",
  "breeze",
  "cave_spider",
  "creaking",
  "creeper",
  "drowned",
  "elder_guardian",
  "endermite",
  "evoker",
  "ghast",
  "guardian",
  "hoglin",
  "husk",
  "magma_cube",
  "phantom",
  "piglin_brute",
  "pillager",
  "ravager",
  "shulker",
  "silverfish",
  "skeleton",
  "slime",
  "spider",
  "stray",
  "vex",
  "vindicator",
  "warden",
  "witch",
  "wither",
  "wither_skeleton",
  "zoglin",
  "zombie",
  "zombie_villager"
]);
const UNARMED_MELEE_TARGETS = new Set([
  "cave_spider",
  "drowned",
  "endermite",
  "husk",
  "silverfish",
  "slime",
  "spider",
  "zombie",
  "zombie_villager"
]);

export class DefenseExecutor {
  private timer?: NodeJS.Timeout;
  private target?: Entity;
  private origin?: Entity["position"];
  private lastDamageAt = 0;
  private lastAttackAt = 0;
  private followingTargetId?: number;
  private equippedForTargetId?: number;
  private lastThreatScanAt = 0;
  private lastEvasionAt = 0;
  private lootCollectionUntil = 0;
  private lootOrigin?: Entity["position"];
  private collectingItemId?: number;
  private lastLootGoalAt = 0;
  private noLootSince?: number;
  private ticking = false;
  private passiveScanSuppressedUntil = 0;

  constructor(
    private readonly bot: Bot,
    private readonly memory: EpisodicMemory,
    private readonly onActivity?: (activity: ActivityUpdate) => void
  ) {}

  start(): void {
    this.bot.on("entityHurt", this.onEntityHurt);
    this.bot.on("entityDead", this.onEntityGone);
    this.bot.on("entityGone", this.onEntityGone);
    this.bot.on("playerCollect", this.onPlayerCollect);
    this.timer = setInterval(() => void this.tick(), 200);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.bot.removeListener("entityHurt", this.onEntityHurt);
    this.bot.removeListener("entityDead", this.onEntityGone);
    this.bot.removeListener("entityGone", this.onEntityGone);
    this.bot.removeListener("playerCollect", this.onPlayerCollect);
    this.bot.autoEat?.enableAuto();
    if (this.target || this.collectingItemId !== undefined) {
      this.bot.pathfinder.stop();
    }
    this.target = undefined;
    this.collectingItemId = undefined;
    this.lastLootGoalAt = 0;
    this.lootCollectionUntil = 0;
  }

  isActive(): boolean {
    return Boolean(this.target) || this.lootCollectionUntil > Date.now();
  }

  private readonly onEntityHurt = (
    entity: Entity | undefined,
    source: Entity | undefined
  ): void => {
    if (!entity || entity.id !== this.bot.entity.id) return;
    const threat =
      source && isRecognizedHostile(source)
        ? source
        : this.findNearestVisibleThreat();
    if (!threat) return;
    this.engage(threat, "The player took damage");
  };

  private engage(threat: Entity, reason: string): void {
    this.lastDamageAt = Date.now();
    if (this.target?.id === threat.id) return;

    this.bot.autoEat?.disableAuto();
    this.bot.autoEat?.cancelEat();
    this.target = threat;
    this.origin = this.bot.entity.position.clone();
    this.followingTargetId = undefined;
    this.equippedForTargetId = undefined;
    void this.equipBestWeapon().catch(() => {
      // The combat tick retries equipment deterministically.
    });
    setTimeout(() => {
      if (this.target?.id !== threat.id) return;
      this.equippedForTargetId = undefined;
      void this.equipBestWeapon().catch(() => {
        // The combat tick retries equipment deterministically.
      });
    }, 150);
    const name = entityName(threat);
    this.onActivity?.({
      phase: "acting",
      label: `Defending against ${name}`,
      detail: reason
    });
    this.memory.record({
      kind: "defense",
      summary: `Defending against ${name}: ${reason}`,
      payload: { entityId: threat.id, entityName: threat.name },
      position: toPosition(this.bot.entity.position),
      dimension: String(this.bot.game.dimension ?? "unknown"),
      importance: 8
    });
  }

  private readonly onEntityGone = (entity: Entity): void => {
    if (entity.id === this.target?.id) {
      this.disengage(`${entityName(entity)} is no longer a threat`, true);
    }
    if (entity.id === this.collectingItemId) {
      this.bot.pathfinder.stop();
      this.collectingItemId = undefined;
      this.lastLootGoalAt = 0;
    }
  };

  private readonly onPlayerCollect = (
    collector: Entity,
    collected: Entity
  ): void => {
    if (collector.id !== this.bot.entity.id) return;
    const item = droppedItem(collected);
    if (!item) return;
    this.memory.record({
      kind: "loot",
      summary: `Collected dropped ${item.name}`,
      payload: { itemName: item.name, count: item.count },
      position: toPosition(this.bot.entity.position),
      dimension: String(this.bot.game.dimension ?? "unknown"),
      importance: 5
    });
  };

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!this.target) {
        const now = Date.now();
        if (now < this.passiveScanSuppressedUntil) return;
        if (now - this.lastThreatScanAt < THREAT_SCAN_INTERVAL_MS) return;
        this.lastThreatScanAt = now;
        const visibleThreat = this.findNearestVisibleThreat();
        if (!visibleThreat) {
          await this.collectPostCombatLoot();
          return;
        }
        this.engage(visibleThreat, "A visible hostile entered defensive range");
      }

      const target = this.target;
      if (!target) return;
      if (
        !target.isValid ||
        Date.now() - this.lastDamageAt > MAX_COMBAT_DURATION_MS
      ) {
        this.disengage("The immediate threat passed");
        return;
      }
      if (
        this.origin &&
        this.bot.entity.position.distanceTo(this.origin) > MAX_PURSUIT_DISTANCE
      ) {
        this.disengage("Stopped at the defensive pursuit limit");
        return;
      }

      const distance = this.bot.entity.position.distanceTo(target.position);
      if (distance > MAX_PURSUIT_DISTANCE) {
        this.disengage("The attacker moved out of defensive range");
        return;
      }

      if (entityName(target) === "creeper") {
        this.evadeCreeper(target, distance);
        return;
      }

      if (this.bot.autoEat?.isEating) return;

      if (
        (!this.hasWeapon() && !this.canFightUnarmed(target)) ||
        this.bot.health <= 8
      ) {
        this.evadeThreat(target, distance);
        return;
      }

      if (
        this.equippedForTargetId !== target.id ||
        weaponPriority(this.bot.heldItem?.name ?? "") === 0
      ) {
        await this.equipBestWeapon();
        this.equippedForTargetId = target.id;
      }

      if (distance > 3.4) {
        if (this.followingTargetId !== target.id) {
          this.bot.pathfinder.setGoal(new GoalFollow(target, 2.5), true);
          this.followingTargetId = target.id;
        }
        return;
      }

      if (this.followingTargetId !== undefined) {
        this.bot.pathfinder.stop();
        this.followingTargetId = undefined;
      }
      if (Date.now() - this.lastAttackAt < ATTACK_INTERVAL_MS) return;

      await this.bot.lookAt(
        target.position.offset(0, Math.max(0.5, target.height / 2), 0),
        true
      );
      this.bot.attack(target);
      this.lastAttackAt = Date.now();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onActivity?.({
        phase: "error",
        label: "Self-defence error",
        detail: message
      });
      this.disengage(`Self-defence failed: ${message}`);
    } finally {
      this.ticking = false;
    }
  }

  private findNearestVisibleThreat(): Entity | undefined {
    const origin = this.bot.entity.position;
    return Object.values(this.bot.entities)
      .filter((entity) => entity.id !== this.bot.entity.id)
      .filter(isRecognizedHostile)
      .filter((entity) => {
        const distance = origin.distanceTo(entity.position);
        return distance <= threatAcquisitionRange(entityName(entity));
      })
      .filter((entity) => this.hasLineOfSight(entity))
      .sort(
        (a, b) =>
          threatPriority(entityName(b)) - threatPriority(entityName(a)) ||
          origin.distanceTo(a.position) - origin.distanceTo(b.position)
      )[0];
  }

  private hasLineOfSight(entity: Entity): boolean {
    const origin = this.bot.entity.position.offset(
      0,
      this.bot.entity.height,
      0
    );
    const target = entity.position.offset(0, Math.max(0.5, entity.height / 2), 0);
    const direction = target.minus(origin);
    const distance = direction.norm();
    if (distance === 0) return true;
    const hit = this.bot.world.raycast(
      origin,
      direction.scaled(1 / distance),
      distance
    );
    return hit === null || origin.distanceTo(hit.intersect) >= distance - 0.2;
  }

  private async collectPostCombatLoot(): Promise<void> {
    if (Date.now() >= this.lootCollectionUntil || !this.lootOrigin) {
      this.finishLootCollection();
      return;
    }

    const origin = this.bot.entity.position;
    const droppedItem = Object.values(this.bot.entities)
      .filter(isDroppedItemEntity)
      .filter(
        (entity) =>
          this.lootOrigin!.distanceTo(entity.position) <= LOOT_SEARCH_RADIUS &&
          origin.distanceTo(entity.position) <= LOOT_SEARCH_RADIUS
      )
      .filter((entity) => this.hasLineOfSight(entity))
      .sort(
        (a, b) =>
          origin.distanceTo(a.position) - origin.distanceTo(b.position)
      )[0];

    if (!droppedItem) {
      this.noLootSince ??= Date.now();
      if (Date.now() - this.noLootSince >= 1_500) {
        this.finishLootCollection();
      }
      return;
    }

    this.noLootSince = undefined;
    const now = Date.now();
    if (
      this.collectingItemId === droppedItem.id &&
      now - this.lastLootGoalAt < 500
    ) {
      return;
    }
    this.collectingItemId = droppedItem.id;
    this.lastLootGoalAt = now;
    const item = droppedItemEntityItem(droppedItem);
    this.onActivity?.({
      phase: "acting",
      label: "Collecting dropped loot",
      detail: item?.displayName ?? item?.name ?? "Nearby combat drops"
    });
    this.bot.pathfinder.setGoal(
      new GoalNear(
        droppedItem.position.x,
        droppedItem.position.y,
        droppedItem.position.z,
        0
      )
    );
  }

  private finishLootCollection(): void {
    if (!this.lootCollectionUntil && this.collectingItemId === undefined) return;
    if (this.collectingItemId !== undefined) this.bot.pathfinder.stop();
    this.lootCollectionUntil = 0;
    this.lootOrigin = undefined;
    this.collectingItemId = undefined;
    this.lastLootGoalAt = 0;
    this.noLootSince = undefined;
    this.onActivity?.({
      phase: "idle",
      label: "No immediate threat",
      detail: "Post-combat area is clear"
    });
  }

  private evadeCreeper(target: Entity, distance: number): void {
    if (distance >= 7) {
      this.disengage("Created distance from the creeper");
      return;
    }
    if (Date.now() - this.lastEvasionAt < 600) return;
    const destination =
      boundedPassableEvasionDestination(
        this.bot.entity.position,
        target.position,
        7,
        (position) => this.isWalkableEvasionCell(position)
      ) ??
      boundedEvasionDestination(
        this.bot.entity.position,
        target.position,
        7
      );
    this.bot.pathfinder.setGoal(
      new GoalNear(destination.x, destination.y, destination.z, 1)
    );
    this.followingTargetId = target.id;
    this.lastEvasionAt = Date.now();
  }

  private evadeThreat(target: Entity, distance: number): void {
    if (distance >= 8) {
      this.disengage("Created distance while unfit to fight");
      return;
    }
    if (Date.now() - this.lastEvasionAt < 600) return;
    const destination =
      boundedPassableEvasionDestination(
        this.bot.entity.position,
        target.position,
        6,
        (position) => this.isWalkableEvasionCell(position)
      ) ??
      boundedEvasionDestination(
        this.bot.entity.position,
        target.position,
        6
      );
    this.bot.pathfinder.setGoal(
      new GoalNear(destination.x, destination.y, destination.z, 1)
    );
    this.followingTargetId = target.id;
    this.lastEvasionAt = Date.now();
    this.onActivity?.({
      phase: "acting",
      label: `Evading ${entityName(target)}`,
      detail: this.hasWeapon()
        ? "Health is too low to continue fighting"
        : "No effective weapon is available"
    });
  }

  private hasWeapon(): boolean {
    return this.bot.inventory
      .items()
      .some((item) => weaponPriority(item.name) > 0);
  }

  private isWalkableEvasionCell(position: {
    x: number;
    y: number;
    z: number;
  }): boolean {
    const feetPosition = new Vec3(
      position.x,
      position.y,
      position.z
    );
    const feet = this.bot.blockAt(feetPosition);
    const head = this.bot.blockAt(feetPosition.offset(0, 1, 0));
    const floor = this.bot.blockAt(feetPosition.offset(0, -1, 0));
    return (
      Boolean(feet && feet.boundingBox === "empty") &&
      Boolean(head && head.boundingBox === "empty") &&
      Boolean(floor && floor.boundingBox !== "empty")
    );
  }

  private canFightUnarmed(target: Entity): boolean {
    return (
      this.bot.health > 12 &&
      UNARMED_MELEE_TARGETS.has(normalizeEntityName(entityName(target)))
    );
  }

  private async equipBestWeapon(): Promise<void> {
    const weapon = this.bot.inventory
      .items()
      .filter((item) => weaponPriority(item.name) > 0)
      .sort((a, b) => weaponPriority(b.name) - weaponPriority(a.name))[0];
    if (weapon) await this.bot.equip(weapon, "hand");
  }

  private disengage(reason: string, collectLoot = false): void {
    if (!this.target) return;
    const name = entityName(this.target);
    this.bot.pathfinder.stop();
    this.target = undefined;
    this.origin = undefined;
    this.followingTargetId = undefined;
    this.equippedForTargetId = undefined;
    this.bot.autoEat?.enableAuto();
    if (reason.includes("Created distance")) {
      this.passiveScanSuppressedUntil = Date.now() + 5_000;
    }
    if (collectLoot) {
      this.lootOrigin = this.bot.entity.position.clone();
      this.lootCollectionUntil = Date.now() + LOOT_COLLECTION_DURATION_MS;
      this.noLootSince = undefined;
    }
    this.onActivity?.({
      phase: "idle",
      label: "No immediate threat",
      detail: reason
    });
    this.memory.record({
      kind: "defense",
      summary: `Stopped defending against ${name}: ${reason}`,
      position: toPosition(this.bot.entity.position),
      dimension: String(this.bot.game.dimension ?? "unknown"),
      importance: 6
    });
  }
}

function weaponPriority(name: string): number {
  if (name === "trident") return 100;
  if (name.endsWith("_sword")) return 80;
  if (name.endsWith("_axe")) return 60;
  return 0;
}

function entityName(entity: Entity): string {
  return (entity.displayName ?? entity.name ?? entity.mobType ?? "mob")
    .replaceAll("_", " ")
    .toLowerCase();
}

export function isPermittedDefenseSource(
  source: Pick<Entity, "type" | "username">
): boolean {
  return source.type !== "player" && !source.username;
}

export function isRecognizedHostileName(name: string | undefined): boolean {
  return name ? HOSTILE_MOBS.has(normalizeEntityName(name)) : false;
}

export function isDroppedItemEntity(
  entity: Pick<Entity, "getDroppedItem">
): boolean {
  return droppedItem(entity) !== null;
}

function droppedItem(
  entity: Pick<Entity, "getDroppedItem">
): ReturnType<Entity["getDroppedItem"]> {
  try {
    return entity.getDroppedItem();
  } catch {
    return null;
  }
}

function droppedItemEntityItem(
  entity: Pick<Entity, "getDroppedItem">
): ReturnType<Entity["getDroppedItem"]> {
  return droppedItem(entity);
}

function isRecognizedHostile(entity: Entity): boolean {
  return (
    isPermittedDefenseSource(entity) &&
    [entity.name, entity.displayName].some(isRecognizedHostileName)
  );
}

function threatAcquisitionRange(name: string): number {
  if (name === "phantom" || name === "skeleton" || name === "stray") return 16;
  if (name === "creeper") return 7;
  return 10;
}

function threatPriority(name: string): number {
  if (name === "creeper") return 100;
  if (name === "phantom") return 90;
  if (name === "skeleton" || name === "stray") return 80;
  return 50;
}

export function boundedEvasionDestination(
  current: { x: number; y: number; z: number },
  threat: { x: number; y: number; z: number },
  distance: number
): { x: number; y: number; z: number } {
  const awayX = current.x - threat.x;
  const awayZ = current.z - threat.z;
  const horizontalLength = Math.hypot(awayX, awayZ) || 1;
  return {
    x: current.x + (awayX / horizontalLength) * distance,
    y: current.y,
    z: current.z + (awayZ / horizontalLength) * distance
  };
}

export function boundedPassableEvasionDestination(
  origin: { x: number; y: number; z: number },
  threat: { x: number; y: number; z: number },
  maximumDistance: number,
  isPassable: (position: { x: number; y: number; z: number }) => boolean
): { x: number; y: number; z: number } | undefined {
  const start = {
    x: Math.floor(origin.x),
    y: Math.floor(origin.y),
    z: Math.floor(origin.z)
  };
  const candidates: Array<{
    position: { x: number; y: number; z: number };
    threatDistance: number;
    steps: number;
  }> = [];
  for (const direction of [
    { x: 1, z: 0 },
    { x: -1, z: 0 },
    { x: 0, z: 1 },
    { x: 0, z: -1 }
  ]) {
    for (let steps = 1; steps <= maximumDistance; steps += 1) {
      const position = {
        x: start.x + direction.x * steps,
        y: start.y,
        z: start.z + direction.z * steps
      };
      if (!isPassable(position)) break;
      candidates.push({
        position,
        threatDistance: Math.hypot(
          position.x - threat.x,
          position.y - threat.y,
          position.z - threat.z
        ),
        steps
      });
    }
  }
  return candidates.sort(
    (a, b) =>
      b.threatDistance - a.threatDistance ||
      b.steps - a.steps
  )[0]?.position;
}

function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase().replaceAll(" ", "_");
}

function toPosition(position: Entity["position"]) {
  return {
    x: Math.round(position.x * 100) / 100,
    y: Math.round(position.y * 100) / 100,
    z: Math.round(position.z * 100) / 100
  };
}
