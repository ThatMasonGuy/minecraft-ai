import type { Bot } from "mineflayer";
import type { InventorySystem } from "./inventory-system.js";
import type { MovementSystem } from "./movement-system.js";
import type { SensingSystem } from "./perception.js";
import type { Position } from "./types.js";
import type { TelemetrySystem } from "./telemetry-system.js";

export interface SurvivalSnapshot {
  health: number;
  food: number;
  oxygen: number;
  dangerous: boolean;
  combatReady: boolean;
}

export interface SurvivalSystemOptions {
  onDanger?: (snapshot: SurvivalSnapshot) => void;
  onVitals?: (snapshot: SurvivalSnapshot) => void;
}

export interface SurvivalSystem {
  start(): void;
  stop(): void;
  snapshot(): SurvivalSnapshot;
  suspendAutoCare(): void;
  resumeAutoCare(): void;
  isEating(): boolean;
  consume(itemName: string): Promise<boolean>;
  sleepAt(position: Position): Promise<boolean>;
  wake(): Promise<void>;
}

export class MineflayerSurvivalSystem implements SurvivalSystem {
  private dangerous = false;

  constructor(
    private readonly bot: Bot,
    private readonly telemetry: TelemetrySystem,
    private readonly sensing: SensingSystem,
    private readonly movement: MovementSystem,
    private readonly inventory: InventorySystem,
    private readonly options: SurvivalSystemOptions = {}
  ) {}

  start(): void {
    this.bot.autoEat.setOpts({
      minHunger: 16,
      minHealth: 14,
      priority: "saturation",
      returnToLastItem: true,
      offhand: false,
      bannedFood: [
        "chorus_fruit",
        "poisonous_potato",
        "pufferfish",
        "spider_eye"
      ]
    });
    this.bot.autoEat.enableAuto();
    const armoredBot = this.bot as Bot & {
      armorManager: { equipAll: () => Promise<void> };
    };
    void armoredBot.armorManager.equipAll().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[survival] Armour manager failed: ${message}`);
    });
    this.bot.on("health", this.onHealth);
    this.onHealth();
  }

  stop(): void {
    this.bot.removeListener("health", this.onHealth);
    this.bot.autoEat.disableAuto();
    this.bot.autoEat.cancelEat();
  }

  snapshot(): SurvivalSnapshot {
    const health = this.bot.health;
    const food = this.bot.food;
    const oxygen = this.bot.oxygenLevel;
    return {
      health,
      food,
      oxygen,
      dangerous: health <= 8 || food <= 6 || oxygen <= 4,
      combatReady: health >= 16 && food >= 16 && oxygen > 4
    };
  }

  suspendAutoCare(): void {
    this.bot.autoEat.disableAuto();
    this.bot.autoEat.cancelEat();
  }

  resumeAutoCare(): void {
    this.bot.autoEat.enableAuto();
  }

  isEating(): boolean {
    return Boolean(this.bot.autoEat.isEating);
  }

  consume(itemName: string): Promise<boolean> {
    return this.inventory.consume(itemName);
  }

  async sleepAt(position: Position): Promise<boolean> {
    const bed = this.sensing.blockAt(position, "visible");
    if (!bed || !bed.name.includes("bed")) return false;
    await this.movement.goNear(position, 2, 30_000);
    const visibleBed = this.sensing.blockAt(position, "visible");
    if (!visibleBed || !visibleBed.name.includes("bed")) return false;
    await this.bot.sleep(visibleBed);
    return true;
  }

  async wake(): Promise<void> {
    await this.bot.wake();
  }

  private readonly onHealth = (): void => {
    const snapshot = this.snapshot();
    this.telemetry.record({
      kind: "vitals",
      summary: `Health ${snapshot.health}, food ${snapshot.food}, oxygen ${snapshot.oxygen}`,
      payload: snapshot,
      position: this.bot.entity ? toPosition(this.bot.entity.position) : undefined,
      dimension: this.bot.game?.dimension ? String(this.bot.game.dimension) : undefined,
      importance: snapshot.dangerous ? 9 : 4
    });
    this.options.onVitals?.(snapshot);
    if (snapshot.dangerous && !this.dangerous) this.options.onDanger?.(snapshot);
    this.dangerous = snapshot.dangerous;
  };
}

function toPosition(position: Pick<Position, "x" | "y" | "z">): Position {
  return {
    x: Math.round(position.x * 100) / 100,
    y: Math.round(position.y * 100) / 100,
    z: Math.round(position.z * 100) / 100
  };
}
