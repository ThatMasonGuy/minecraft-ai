import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { MinecraftActions } from "./actions.js";
import type { EpisodicMemory } from "./memory.js";
import type { ExecutionScope } from "./execution-coordinator.js";
import type { ActivityUpdate, OwnedContainer, ProjectPlan } from "./types.js";

const require = createRequire(import.meta.url);
const { goals } = require(
  "mineflayer-pathfinder"
) as typeof import("mineflayer-pathfinder");
const { GoalNear } = goals;

const INVENTORY_PRESSURE_SLOTS = 2;

export class StorageExecutor {
  private timer?: NodeJS.Timeout;
  private running = false;
  private active = false;

  constructor(
    private readonly bot: Bot,
    private readonly memory: EpisodicMemory,
    private readonly actions: MinecraftActions,
    private readonly onActivity?: (activity: ActivityUpdate) => void,
    private readonly shouldPause?: () => boolean,
    private readonly execution?: ExecutionScope
  ) {}

  start(): void {
    this.timer = setInterval(() => this.runTick(), 1_000);
    this.runTick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
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
    if (this.running || this.shouldPause?.() || !this.bot.entity) return;
    const emptySlots = this.bot.inventory.emptySlotCount();
    if (emptySlots > INVENTORY_PRESSURE_SLOTS) {
      this.active = false;
      return;
    }

    const candidates = storageCandidates(
      this.bot,
      this.memory.activeProject(),
      this.memory.activeWorkOrder()?.spec.itemName
    );
    const container = nearestContainer(
      this.bot,
      this.memory.ownedContainers(String(this.bot.game?.dimension))
    );
    if (!container || candidates.length === 0) {
      this.active = false;
      return;
    }

    this.active = true;
    if (this.execution && !this.execution.claim()) return;
    this.running = true;
    try {
      const distance = distanceBetween(
        this.bot.entity.position,
        container.position
      );
      if (distance > 4.5) {
        this.report(
          "working",
          "Returning to owned storage",
          `${Math.ceil(distance)} blocks to ${container.label ?? container.blockName}`
        );
        await this.bot.pathfinder.goto(
          new GoalNear(
            container.position.x,
            container.position.y,
            container.position.z,
            2
          )
        );
        return;
      }

      const candidate = candidates[0]!;
      this.report(
        "working",
        "Storing inventory",
        `${candidate.count} ${candidate.name.replaceAll("_", " ")}`
      );
      const before = inventoryCount(this.bot, candidate.name);
      const result = await this.actions.execute("deposit_item_in_container", {
        x: container.position.x,
        y: container.position.y,
        z: container.position.z,
        item_name: candidate.name
      });
      const deposited = Math.max(
        0,
        before - inventoryCount(this.bot, candidate.name)
      );
      if (deposited > 0) {
        this.memory.recordContainerDeposit(
          container.id,
          candidate.name,
          deposited
        );
        this.memory.record({
          kind: "storage",
          summary: `Stored ${deposited} ${candidate.name} in owned container ${container.id}`,
          position: container.position,
          dimension: container.dimension,
          importance: 6
        });
      }
      if (!result.ok || deposited === 0) {
        this.report("waiting", "Storage unavailable", result.message);
        this.active = false;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.report("waiting", "Storage interrupted", message);
      this.active = false;
    } finally {
      this.running = false;
    }
  }

  private report(
    phase: ActivityUpdate["phase"],
    label: string,
    detail?: string
  ): void {
    this.onActivity?.({ phase, label, detail });
  }
}

function storageCandidates(
  bot: Bot,
  project: ProjectPlan | undefined,
  activeWorkItem?: string
): Array<{ name: string; count: number }> {
  const reserved = projectReservedItems(project);
  if (activeWorkItem) reserved.add(activeWorkItem);
  const counts = new Map<string, number>();
  for (const item of bot.inventory.items()) {
    if (reserved.has(item.name) || isEssential(bot, item.name)) continue;
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function projectReservedItems(project: ProjectPlan | undefined): Set<string> {
  const reserved = new Set<string>();
  if (!project) return reserved;
  for (const step of project.steps.slice(project.currentStepIndex)) {
    if ("itemName" in step.spec) reserved.add(step.spec.itemName);
    if (step.spec.kind === "smelt_item") {
      reserved.add(step.spec.inputItemName);
      reserved.add(step.spec.fuelItemName);
      reserved.add(step.spec.outputItemName);
    }
    if (step.spec.kind === "place_blueprint") {
      for (const placement of step.spec.placements) {
        reserved.add(placement.itemName);
      }
    }
  }
  return reserved;
}

function isEssential(bot: Bot, name: string): boolean {
  if (
    /(?:sword|pickaxe|axe|shovel|hoe|bow|crossbow|shield|helmet|chestplate|leggings|boots)$/.test(
      name
    )
  ) {
    return true;
  }
  const registry = bot.registry as typeof bot.registry & {
    foodsByName?: Record<string, unknown>;
  };
  return Boolean(registry.foodsByName?.[name]);
}

function nearestContainer(
  bot: Bot,
  containers: OwnedContainer[]
): OwnedContainer | undefined {
  return containers.sort(
    (a, b) =>
      distanceBetween(bot.entity.position, a.position) -
      distanceBetween(bot.entity.position, b.position)
  )[0];
}

function inventoryCount(bot: Bot, itemName: string): number {
  return bot.inventory
    .items()
    .filter((item) => item.name === itemName)
    .reduce((total, item) => total + item.count, 0);
}

function distanceBetween(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
