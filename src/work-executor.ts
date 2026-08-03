import type { MinecraftActions } from "./actions.js";
import type { EpisodicMemory } from "./memory.js";
import type { ExecutionScope } from "./execution-coordinator.js";
import type { StorageSystem } from "./storage-system.js";
import type { Perception } from "./perception.js";
import type {
  ActivityUpdate,
  PerceptionSnapshot,
  VisibleBlock,
  WorkOrder
} from "./types.js";

interface TrunkColumn {
  x: number;
  z: number;
  aroundY: number;
}

interface SearchState {
  origin: { x: number; y: number; z: number };
  nextWaypoint: number;
}

const FINITE_SEARCH_WAYPOINTS = 12;
const SEARCH_GRID_SIZE = 8;

export class WorkExecutor {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastState?: string;
  private readonly consecutiveFailures = new Map<number, number>();
  private readonly trunkColumns = new Map<number, TrunkColumn>();
  private readonly searchStates = new Map<number, SearchState>();
  private readonly excludedSources = new Map<number, Set<string>>();
  private readonly storageFailures = new Map<number, number>();

  constructor(
    private readonly memory: EpisodicMemory,
    private readonly perception: Perception,
    private readonly actions: MinecraftActions,
    private readonly storage: StorageSystem,
    private readonly tickMs: number,
    private readonly requestReplan: (reason: string) => void,
    private readonly onActivity?: (activity: ActivityUpdate) => void,
    private readonly shouldPauseForDefense?: () => boolean,
    private readonly execution?: ExecutionScope
  ) {}

  start(): void {
    this.timer = setInterval(() => this.runTick(), this.tickMs);
    this.runTick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.execution?.release();
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
    let order = this.memory.activeWorkOrder();
    if (!order) {
      this.logState("idle", "[work] No active deterministic work order");
      this.reportActivity("idle", "No background work");
      return;
    }
    if (this.shouldPauseForDefense?.()) {
      this.reportActivity(
        "waiting",
        "Work paused for combat safety",
        `Work order ${order.id} will resume when the threat passes`
      );
      return;
    }

    this.running = true;
    try {
      const snapshot = this.perception.observe();
      if (snapshot.health <= 4 || snapshot.food <= 6) {
        this.reportActivity(
          "waiting",
          "Work paused for survival",
          `Health ${snapshot.health}, food ${snapshot.food}`
        );
        this.logState(
          `unsafe:${order.id}`,
          `[work] Work order ${order.id} waiting for safe vitals ` +
            `(health ${snapshot.health}, food ${snapshot.food})`
        );
        return;
      }
      this.reportActivity(
        "working",
        `Gathering ${order.spec.itemName}`,
        `${order.progressCount}/${order.spec.minimumCount} gathered`
      );
      this.logState(
        `running:${order.id}`,
        `[work] Executing work order ${order.id}: gather at least ` +
          `${order.spec.minimumCount} ${order.spec.itemName} ` +
          `(${order.spec.continuation})`
      );

      const gatheredItemName = order.spec.itemName;
      const currentCount = snapshot.inventory
        .filter((item) => item.name === gatheredItemName)
        .reduce((sum, item) => sum + item.count, 0);
      const gained = Math.max(0, currentCount - order.lastInventoryCount);
      if (gained > 0 || currentCount !== order.lastInventoryCount) {
        order = this.memory.updateWorkOrderProgress(
          order.id,
          order.progressCount + gained,
          currentCount
        );
      }

      if (
        order.progressCount >= order.spec.minimumCount &&
        !order.minimumReachedAt
      ) {
        const reachedAt = new Date().toISOString();
        order = this.memory.updateWorkOrderProgress(
          order.id,
          order.progressCount,
          currentCount,
          reachedAt
        );
        const summary =
          `Work order ${order.id} reached its minimum: gathered ` +
          `${order.progressCount}/${order.spec.minimumCount} ` +
          `${order.spec.itemName}`;
        this.memory.record({
          kind: "work_order_milestone",
          summary,
          importance: 8
        });
        console.log(`[work] ${summary}`);
      }

      if (
        order.minimumReachedAt &&
        order.spec.continuation === "stop_at_minimum"
      ) {
        this.complete(
          order.id,
          `Minimum reached after gathering ${order.progressCount} ${order.spec.itemName}`
        );
        return;
      }

      if (snapshot.emptyInventorySlots <= 2) {
        if (order.spec.storage.mode === "container") {
          await this.storeGatheredItems(order);
        } else {
          this.block(
            order.id,
            `Inventory has ${snapshot.emptyInventorySlots} empty slots and no storage container is configured`
          );
        }
        return;
      }

      const source = this.chooseSource(order, snapshot);
      if (!source) {
        await this.exploreForSource(order, snapshot);
        return;
      }

      const result = await this.actions.execute("mine_visible_block", {
        x: source.x,
        y: source.y,
        z: source.z
      });
      if (!result.ok) {
        this.retrySource(order.id, source, result.message);
      } else {
        this.consecutiveFailures.delete(order.id);
        this.trunkColumns.set(order.id, {
          x: source.x,
          z: source.z,
          aroundY: source.y
        });
        console.log(
          `[work] ${result.message} at ${source.x}, ${source.y}, ${source.z}`
        );
      }
    } finally {
      this.running = false;
    }
  }

  private complete(id: number, reason: string): void {
    this.consecutiveFailures.delete(id);
    this.trunkColumns.delete(id);
    this.searchStates.delete(id);
    this.excludedSources.delete(id);
    this.storageFailures.delete(id);
    this.memory.updateWorkOrderStatus(id, "completed", reason);
    this.memory.record({
      kind: "work_order_outcome",
      summary: `Work order ${id} completed: ${reason}`,
      importance: 8
    });
    console.log(`[work] Work order ${id} completed: ${reason}`);
    this.reportActivity("idle", "Work order complete", reason);
    this.requestReplan(`deterministic work order ${id} completed: ${reason}`);
  }

  private block(id: number, reason: string): void {
    this.consecutiveFailures.delete(id);
    this.trunkColumns.delete(id);
    this.searchStates.delete(id);
    this.excludedSources.delete(id);
    this.storageFailures.delete(id);
    this.memory.updateWorkOrderStatus(id, "blocked", reason);
    this.memory.record({
      kind: "work_order_outcome",
      summary: `Work order ${id} blocked: ${reason}`,
      importance: 8
    });
    console.warn(`[work] Work order ${id} blocked: ${reason}`);
    this.reportActivity("error", "Work order blocked", reason);
    this.requestReplan(`deterministic work order ${id} became blocked: ${reason}`);
  }

  private chooseSource(
    order: WorkOrder,
    snapshot: PerceptionSnapshot
  ): VisibleBlock | undefined {
    const column = this.trunkColumns.get(order.id);
    if (column) {
      const connected: VisibleBlock[] = [];
      for (let y = column.aroundY - 4; y <= column.aroundY + 8; y += 1) {
        const block = this.perception.inspectVisibleBlock(column.x, y, column.z);
        if (
          block &&
          matchesGatherSource(order, block.name) &&
          !this.isExcluded(order.id, block)
        ) {
          connected.push(block);
        }
      }
      connected.sort((a, b) => a.y - b.y);
      if (connected[0]) return connected[0];
    }

    return snapshot.visibleBlocks.find((block) =>
      matchesGatherSource(order, block.name) &&
      !this.isExcluded(order.id, block)
    );
  }

  private async exploreForSource(
    order: WorkOrder,
    snapshot: PerceptionSnapshot
  ): Promise<void> {
    const state = this.searchStates.get(order.id) ?? {
      origin: snapshot.position,
      nextWaypoint: 0
    };
    this.searchStates.set(order.id, state);

    if (
      order.spec.continuation === "stop_at_minimum" &&
      state.nextWaypoint >= FINITE_SEARCH_WAYPOINTS
    ) {
      this.block(
        order.id,
        `No requested source block found after searching ${FINITE_SEARCH_WAYPOINTS} nearby waypoints`
      );
      return;
    }
    const offset = spiralOffset(state.nextWaypoint);
    state.nextWaypoint += 1;

    const target = {
      x: Math.round(state.origin.x + offset.x * SEARCH_GRID_SIZE),
      y: Math.round(snapshot.position.y),
      z: Math.round(state.origin.z + offset.z * SEARCH_GRID_SIZE)
    };
    const searchExtent =
      order.spec.continuation === "until_replaced"
        ? "ongoing"
        : String(FINITE_SEARCH_WAYPOINTS);
    console.log(
      `[work] No source visible; searching waypoint ` +
        `${state.nextWaypoint}/${searchExtent} at ` +
        `${target.x}, ${target.y}, ${target.z}`
    );
    this.reportActivity(
      "working",
      `Searching for ${order.spec.itemName}`,
      `Waypoint ${state.nextWaypoint}/${searchExtent}`
    );
    const result = await this.actions.execute("move_to_surface", {
      x: target.x,
      y: target.y,
      z: target.z,
      range: 4
    });
    if (!result.ok) {
      console.warn(`[work] Search movement failed: ${result.message}`);
    }
  }

  private async storeGatheredItems(order: WorkOrder): Promise<void> {
    if (order.spec.storage.mode !== "container") return;
    const position = order.spec.storage.position;
    console.log(
      `[work] Inventory pressure detected; returning to container at ` +
        `${position.x}, ${position.y}, ${position.z}`
    );
    this.reportActivity(
      "working",
      `Storing ${order.spec.itemName}`,
      `Returning to ${position.x}, ${position.y}, ${position.z}`
    );
    const movement = await this.actions.execute("move_to", {
      ...position,
      range: 3
    });
    if (!movement.ok) {
      this.retryStorage(order.id, movement.message);
      return;
    }

    const deposit = await this.storage.deposit(position, order.spec.itemName);
    if (deposit.status === "blocked") {
      this.retryStorage(order.id, deposit.detail);
      return;
    }

    const snapshot = this.perception.observe();
    const remaining = snapshot.inventory
      .filter((item) => item.name === order.spec.itemName)
      .reduce((sum, item) => sum + item.count, 0);
    this.memory.updateWorkOrderProgress(
      order.id,
      order.progressCount,
      remaining
    );
    this.storageFailures.delete(order.id);
    console.log(
      `[work] Stored ${deposit.status === "stored" ? deposit.count : 0} ` +
        `${order.spec.itemName}; resuming gather order ${order.id}`
    );
  }

  private retryStorage(id: number, reason: string): void {
    const failures = (this.storageFailures.get(id) ?? 0) + 1;
    this.storageFailures.set(id, failures);
    if (failures >= 3) {
      this.block(id, `Could not store gathered items after ${failures} attempts: ${reason}`);
      return;
    }
    console.warn(`[work] Storage retry ${failures}/3 after: ${reason}`);
  }

  private isExcluded(orderId: number, block: VisibleBlock): boolean {
    return this.excludedSources.get(orderId)?.has(blockKey(block)) ?? false;
  }

  private retrySource(id: number, source: VisibleBlock, reason: string): void {
    const failures = (this.consecutiveFailures.get(id) ?? 0) + 1;
    this.consecutiveFailures.set(id, failures);
    if (failures >= 3) {
      const excluded = this.excludedSources.get(id) ?? new Set<string>();
      excluded.add(blockKey(source));
      this.excludedSources.set(id, excluded);
      this.consecutiveFailures.delete(id);
      this.trunkColumns.delete(id);
      console.warn(
        `[work] Skipping inaccessible source at ${source.x}, ${source.y}, ` +
          `${source.z} after ${failures} attempts: ${reason}`
      );
      return;
    }
    console.warn(
      `[work] Work order ${id} retry ${failures}/3 after: ${reason}`
    );
  }

  private logState(state: string, message: string): void {
    if (this.lastState === state) return;
    this.lastState = state;
    console.log(message);
  }

  private reportActivity(
    phase: ActivityUpdate["phase"],
    label: string,
    detail?: string
  ): void {
    this.onActivity?.({ phase, label, detail });
  }
}

export function matchesGatherSource(
  order: Pick<WorkOrder, "spec">,
  blockName: string
): boolean {
  if (
    order.spec.itemName.endsWith("_log") ||
    order.spec.itemName.endsWith("_stem")
  ) {
    return blockName === order.spec.itemName;
  }
  return order.spec.blockNames.includes(blockName);
}

function blockKey(block: Pick<VisibleBlock, "x" | "y" | "z">): string {
  return `${block.x},${block.y},${block.z}`;
}

export function spiralOffset(index: number): { x: number; z: number } {
  const n = Math.max(1, Math.floor(index) + 2);
  const ring = Math.ceil((Math.sqrt(n) - 1) / 2);
  const sideLength = ring * 2;
  const maximum = (ring * 2 + 1) ** 2;
  const offset = maximum - n;

  if (offset < sideLength) return { x: ring - offset, z: -ring };
  if (offset < sideLength * 2) {
    return { x: -ring, z: -ring + (offset - sideLength) };
  }
  if (offset < sideLength * 3) {
    return { x: -ring + (offset - sideLength * 2), z: ring };
  }
  return { x: ring, z: ring - (offset - sideLength * 3) };
}
