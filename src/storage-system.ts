import type { Bot } from "mineflayer";
import type { ExecutionScope } from "./execution-coordinator.js";
import type { InventorySystem } from "./inventory-system.js";
import type { StoragePersistence } from "./persistence-ports.js";
import type { MovementSystem } from "./movement-system.js";
import type { SensingSystem } from "./perception.js";
import type { TelemetrySystem } from "./telemetry-system.js";
import type {
  ActivityUpdate,
  OwnedContainer,
  Position,
  ProjectPlan
} from "./types.js";

const INVENTORY_PRESSURE_SLOTS = 2;

export type StorageResult =
  | { status: "stored"; itemName: string; count: number; containerId?: number }
  | { status: "retrieved"; itemName: string; count: number; containerId: number }
  | { status: "nothing_to_store"; itemName: string }
  | { status: "blocked"; detail: string };

export interface StorageSystem {
  start(): void;
  stop(): void;
  isActive(): boolean;
  deposit(position: Position, itemName: string, requireVisible?: boolean): Promise<StorageResult>;
  withdraw(
    position: Position,
    itemName: string,
    count: number,
    requireVisible?: boolean
  ): Promise<StorageResult>;
}

export class MineflayerStorageSystem implements StorageSystem {
  private timer?: NodeJS.Timeout;
  private running = false;
  private active = false;

  constructor(
    private readonly bot: Bot,
    private readonly memory: StoragePersistence,
    private readonly telemetry: TelemetrySystem,
    private readonly sensing: SensingSystem,
    private readonly movement: MovementSystem,
    private readonly inventory: InventorySystem,
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

  async deposit(
    position: Position,
    itemName: string,
    requireVisible = false
  ): Promise<StorageResult> {
    const stacks = this.inventory.items().filter((item) => item.name === itemName);
    if (stacks.length === 0) return { status: "nothing_to_store", itemName };
    await this.movement.positionForBlock(position);
    const block = this.sensing.blockAt(position, requireVisible ? "visible" : "loaded");
    if (!block || !isStorageBlock(block.name)) {
      return { status: "blocked", detail: "storage container is unavailable" };
    }
    const before = this.inventory.count(itemName);
    const container = await this.bot.openContainer(block);
    const variants = new Map<string, { type: number; metadata: number | null }>();
    for (const stack of stacks) {
      variants.set(`${stack.type}:${stack.metadata}`, {
        type: stack.type,
        metadata: stack.metadata
      });
    }
    try {
      for (const variant of variants.values()) {
        await container.deposit(variant.type, variant.metadata, null);
      }
    } finally {
      container.close();
    }
    const stored = Math.max(0, before - this.inventory.count(itemName));
    if (stored === 0) return { status: "blocked", detail: "container accepted no items" };
    const owned = this.ownedAt(position);
    if (owned) {
      this.memory.recordContainerDeposit(owned.id, itemName, stored);
      this.telemetry.record({
        kind: "storage",
        summary: `Stored ${stored} ${itemName} in owned container ${owned.id}`,
        position: owned.position,
        dimension: owned.dimension,
        importance: 6
      });
    }
    return { status: "stored", itemName, count: stored, containerId: owned?.id };
  }

  async withdraw(
    position: Position,
    itemName: string,
    count: number,
    requireVisible = false
  ): Promise<StorageResult> {
    const owned = this.ownedAt(position);
    if (!owned) return { status: "blocked", detail: "container is not registered as owned" };
    await this.movement.positionForBlock(position);
    const block = this.sensing.blockAt(position, requireVisible ? "visible" : "loaded");
    if (!block || !isStorageBlock(block.name)) {
      return { status: "blocked", detail: "owned storage container is unavailable" };
    }
    const container = await this.bot.openContainer(block);
    try {
      const stack = container.containerItems().find((item) => item.name === itemName);
      if (!stack) return { status: "blocked", detail: `owned storage has no ${itemName}` };
      const retrieved = Math.min(count, stack.count);
      await container.withdraw(stack.type, stack.metadata, retrieved);
      this.memory.recordContainerWithdrawal(owned.id, itemName, retrieved);
      return {
        status: "retrieved",
        itemName,
        count: retrieved,
        containerId: owned.id
      };
    } finally {
      container.close();
    }
  }

  private runTick(): void {
    if (this.execution) void this.execution.run(() => this.tick());
    else void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.running || this.shouldPause?.() || !this.bot.entity) return;
    if (this.inventory.emptySlots() > INVENTORY_PRESSURE_SLOTS) {
      this.active = false;
      return;
    }
    const candidates = storageCandidates(
      this.inventory,
      this.memory.activeProject(),
      this.memory.activeWorkOrder()?.spec.itemName
    );
    const container = nearestContainer(
      this.bot.entity.position,
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
      const candidate = candidates[0]!;
      this.report(
        "working",
        "Storing inventory",
        `${candidate.count} ${candidate.name.replaceAll("_", " ")}`
      );
      const result = await this.deposit(container.position, candidate.name);
      if (result.status === "blocked") {
        this.report("waiting", "Storage unavailable", result.detail);
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

  private ownedAt(position: Position): OwnedContainer | undefined {
    return this.memory
      .ownedContainers(String(this.bot.game?.dimension))
      .find(
        (container) =>
          container.position.x === position.x &&
          container.position.y === position.y &&
          container.position.z === position.z
      );
  }

  private report(
    phase: ActivityUpdate["phase"],
    label: string,
    detail?: string
  ): void {
    this.telemetry.activity("storage", { phase, label, detail });
  }
}

function storageCandidates(
  inventory: InventorySystem,
  project: ProjectPlan | undefined,
  activeWorkItem?: string
): Array<{ name: string; count: number }> {
  const reserved = projectReservedItems(project);
  if (activeWorkItem) reserved.add(activeWorkItem);
  const counts = new Map<string, number>();
  for (const item of inventory.items()) {
    if (reserved.has(item.name) || isEssential(inventory, item.name)) continue;
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
      for (const placement of step.spec.placements) reserved.add(placement.itemName);
    }
  }
  return reserved;
}

function isEssential(inventory: InventorySystem, name: string): boolean {
  return (
    /(?:sword|pickaxe|axe|shovel|hoe|bow|crossbow|shield|helmet|chestplate|leggings|boots)$/.test(
      name
    ) || inventory.isFood(name)
  );
}

function nearestContainer(
  origin: Position,
  containers: OwnedContainer[]
): OwnedContainer | undefined {
  return containers.sort(
    (a, b) => distance(origin, a.position) - distance(origin, b.position)
  )[0];
}

function isStorageBlock(name: string): boolean {
  return name === "chest" || name === "trapped_chest" || name === "barrel";
}

function distance(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
