import type { CombatSystem } from "./combat-system.js";
import type { ExecutionScope } from "./execution-coordinator.js";
import type { InventoryItem, InventorySystem } from "./inventory-system.js";
import type { LootingSystem } from "./looting-system.js";
import type { MovementSystem } from "./movement-system.js";
import type { SensingSystem } from "./perception.js";
import type { SurvivalSnapshot, SurvivalSystem } from "./survival-system.js";
import type { TelemetrySystem } from "./telemetry-system.js";
import type { Position } from "./types.js";
import { spiralOffset } from "./navigation.js";

const SAFE_FOOD_EXCLUSIONS = new Set([
  "chorus_fruit",
  "poisonous_potato",
  "pufferfish",
  "rotten_flesh",
  "spider_eye"
]);
const EMERGENCY_FOOD = new Set(["rotten_flesh"]);

export class FoodProvisioningSystem {
  private timer?: NodeJS.Timeout;
  private running = false;
  private active = false;
  private origin?: Position;
  private nextWaypoint = 0;
  private targetId?: number;
  private lootClearedAt?: number;
  private lastState?: string;

  constructor(
    private readonly telemetry: TelemetrySystem,
    private readonly sensing: SensingSystem,
    private readonly movement: MovementSystem,
    private readonly inventory: InventorySystem,
    private readonly survival: SurvivalSystem,
    private readonly combat: CombatSystem,
    private readonly looting: LootingSystem,
    private readonly tickMs: number,
    private readonly execution?: ExecutionScope
  ) {}

  start(): void {
    this.timer = setInterval(() => this.runTick(), this.tickMs);
    this.runTick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.active = false;
    this.looting.endSession("food-provisioning");
    this.execution?.release();
  }

  isActive(): boolean {
    return this.active;
  }

  private runTick(): void {
    if (this.execution) {
      void this.execution.run(() => this.tick());
    } else {
      void this.tick();
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    const vitals = this.survival.snapshot();
    const safeReserve = this.safeFoodItems().reduce(
      (total, item) => total + item.count,
      0
    );
    if (!needsFoodProvisioning(vitals, safeReserve)) {
      this.reset();
      return;
    }

    this.active = true;
    this.running = true;
    try {
      const consumable = selectProvisioningFood(
        this.inventory.items(),
        this.inventory,
        vitals
      );
      if (consumable && vitals.food < 20) {
        this.report(
          "Eating for survival",
          `${vitals.health.toFixed(1)} health, ${vitals.food} hunger`
        );
        await this.survival.consume(consumable.name);
        return;
      }

      if (vitals.health < 12 && vitals.food >= 18) {
        this.movement.hold();
        this.report(
          "Recovering before foraging",
          `${vitals.health.toFixed(1)} health with enough hunger to regenerate`
        );
        return;
      }

      if (!this.lootClearedAt || Date.now() - this.lootClearedAt > 5_000) {
        const here = this.currentPosition();
        const loot = this.looting.collectStep({
          sessionId: "food-provisioning",
          origin: here,
          radius: 16,
          includeItem: (itemName) => this.inventory.isFood(itemName)
        });
        if (loot.status !== "clear") {
          this.report(
            "Collecting food drops",
            loot.status === "moving"
              ? `Collecting ${loot.itemName ?? "food"}`
              : "Checking nearby drops"
          );
          return;
        }
        this.looting.endSession("food-provisioning");
        this.lootClearedAt = Date.now();
      }

      if (this.targetId !== undefined) {
        const remembered = this.sensing.entityById(this.targetId);
        if (remembered?.isValid) {
          const result = this.combat.engageVisiblePassiveMob(
            remembered.id,
            "FoodProvisioningSystem requested a visible passive food source"
          );
          if (result === "engaged" || result === "busy") return;
        }
        this.targetId = undefined;
        this.lootClearedAt = undefined;
      }

      const target = this.sensing
        .visibleEntitiesRaw(32)
        .filter((entity) => foodAnimalPriority(entity.name ?? "") > 0)
        .sort(
          (left, right) =>
            foodAnimalPriority(right.name ?? "") -
              foodAnimalPriority(left.name ?? "") ||
            distance(this.currentPosition(), left.position) -
              distance(this.currentPosition(), right.position)
        )[0];
      if (target) {
        this.targetId = target.id;
        this.report(
          `Hunting visible ${target.name ?? "animal"}`,
          `${safeReserve}/3 safe food items held`
        );
        this.combat.engageVisiblePassiveMob(
          target.id,
          "FoodProvisioningSystem requested a visible passive food source"
        );
        return;
      }

      this.origin ??= this.currentPosition();
      const offset = spiralOffset(this.nextWaypoint);
      this.nextWaypoint += 1;
      const targetArea = {
        x: this.origin.x + offset.x * 12,
        z: this.origin.z + offset.z * 12
      };
      this.report(
        "Searching for visible food animals",
        `Waypoint ${this.nextWaypoint}; ${safeReserve}/3 reserve items`
      );
      const result = await this.movement.reachSurfaceArea(
        targetArea,
        4,
        45_000,
        8_000
      );
      if (result.status === "blocked") {
        this.telemetry.record({
          kind: "food_provisioning",
          summary: `Food search route blocked: ${result.detail}`,
          importance: 7
        });
      }
    } catch (error) {
      this.telemetry.record({
        kind: "food_provisioning",
        summary: `Food provisioning failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        importance: 8
      });
    } finally {
      this.running = false;
    }
  }

  private safeFoodItems(): InventoryItem[] {
    return this.inventory
      .items()
      .filter((item) => this.inventory.isFood(item.name))
      .filter((item) => !SAFE_FOOD_EXCLUSIONS.has(item.name));
  }

  private currentPosition(): Position {
    const snapshot = this.sensing.last() ?? this.sensing.observe();
    return snapshot.position;
  }

  private reset(): void {
    if (!this.active) return;
    this.active = false;
    this.origin = undefined;
    this.nextWaypoint = 0;
    this.targetId = undefined;
    this.lootClearedAt = undefined;
    this.looting.endSession("food-provisioning");
    this.report("Food reserves ready", "Returning control to ordinary work");
  }

  private report(label: string, detail: string): void {
    const key = `${label}:${detail}`;
    if (this.lastState === key) return;
    this.lastState = key;
    this.telemetry.activity("survival", {
      phase: this.active ? "working" : "idle",
      label,
      detail
    });
    console.log(`[food] ${label}: ${detail}`);
  }
}

export function needsFoodProvisioning(
  vitals: Pick<SurvivalSnapshot, "health" | "food">,
  safeReserve: number
): boolean {
  if (vitals.health <= 0) return false;
  return vitals.food <= 17 || safeReserve < 3;
}

export function selectProvisioningFood(
  items: InventoryItem[],
  inventory: Pick<InventorySystem, "isFood">,
  vitals: Pick<SurvivalSnapshot, "health" | "food">
): InventoryItem | undefined {
  const food = items.filter((item) => inventory.isFood(item.name));
  const safe = food
    .filter((item) => !SAFE_FOOD_EXCLUSIONS.has(item.name))
    .sort((left, right) => foodPriority(right.name) - foodPriority(left.name))[0];
  if (safe) return safe;
  if (vitals.health <= 8 || vitals.food <= 6) {
    return food.find((item) => EMERGENCY_FOOD.has(item.name));
  }
  return undefined;
}

export function foodAnimalPriority(name: string): number {
  switch (name) {
    case "cow":
    case "mooshroom":
      return 5;
    case "pig":
      return 4;
    case "sheep":
      return 3;
    case "chicken":
      return 2;
    case "rabbit":
      return 1;
    default:
      return 0;
  }
}

function foodPriority(name: string): number {
  if (name.startsWith("cooked_")) return 6;
  if (["bread", "baked_potato", "golden_carrot"].includes(name)) return 5;
  if (["beef", "porkchop", "mutton", "rabbit"].includes(name)) return 4;
  return 2;
}

function distance(
  left: Pick<Position, "x" | "y" | "z">,
  right: Pick<Position, "x" | "y" | "z">
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}
