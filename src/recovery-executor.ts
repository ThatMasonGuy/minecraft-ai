import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { EpisodicMemory } from "./memory.js";
import type { ExecutionScope } from "./execution-coordinator.js";
import type { MinecraftActions } from "./actions.js";
import type {
  ActivityUpdate,
  Position,
  ProjectPlan,
  ProjectStep
} from "./types.js";
import { isDroppedItemEntity } from "./defense-executor.js";

const require = createRequire(import.meta.url);
const { goals } = require(
  "mineflayer-pathfinder"
) as typeof import("mineflayer-pathfinder");
const { GoalNear, GoalXZ } = goals;

// Item age only advances while its chunk is ticking. A distant death site can
// remain recoverable well beyond five minutes of wall time.
const RECOVERY_LOADED_CHUNK_LIMIT_MS = 5 * 60_000;
const RECOVERY_NO_PROGRESS_LIMIT_MS = 60_000;
const SEARCH_RADIUS = 12;
const ARRIVAL_RADIUS = 8;
const CLEAR_CONFIRMATION_MS = 2_500;
const LOW_VALUE_RECOVERY_ITEMS = new Set([
  "andesite",
  "cobbled_deepslate",
  "cobblestone",
  "diorite",
  "dirt",
  "gravel",
  "granite",
  "netherrack",
  "sand",
  "stone",
  "tuff"
]);

export class RecoveryExecutor {
  private timer?: NodeJS.Timeout;
  private running = false;
  private noItemsSince?: number;
  private lastGoalAt = 0;
  private lastWaypointKey?: string;
  private trackedJobId?: number;
  private lastLifetimeCheckAt?: number;
  private closestDistance?: number;
  private lastProgressAt?: number;

  constructor(
    private readonly bot: Bot,
    private readonly memory: EpisodicMemory,
    private readonly actions: MinecraftActions,
    private readonly onActivity?: (activity: ActivityUpdate) => void,
    private readonly shouldPauseForDefense?: () => boolean,
    private readonly execution?: ExecutionScope
  ) {}

  start(): void {
    this.timer = setInterval(() => this.runTick(), 500);
    this.runTick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.execution?.release();
  }

  isActive(): boolean {
    return this.memory.activeRecoveryJob() !== undefined;
  }

  private runTick(): void {
    if (this.execution) {
      void this.execution.run(() => this.tick());
    } else {
      void this.tick();
    }
  }

  private async tick(): Promise<void> {
    if (this.running || !this.bot.entity) return;
    const job = this.memory.activeRecoveryJob();
    if (!job) {
      this.resetLifetimeTracking();
      return;
    }
    if (!shouldRecoverInventory(job.expectedItems)) {
      this.finish(
        job.id,
        "cancelled",
        "Skipped recovery because only trivial bulk materials were dropped"
      );
      return;
    }
    if (!this.hasRecoveryWeaponAvailable(job.expectedItems)) {
      this.finish(
        job.id,
        "cancelled",
        "Unsafe unarmed recovery skipped; replaying the project supply chain"
      );
      return;
    }
    if (this.updateLoadedChunkLifetime(job)) return;
    if (String(this.bot.game?.dimension) !== job.dimension) {
      this.report("waiting", "Returning to death dimension", job.dimension);
      return;
    }
    const timeOfDay = this.bot.time.timeOfDay;
    const currentDistance = distanceBetween(
      this.bot.entity.position,
      job.position
    );
    if (
      this.closestDistance === undefined ||
      currentDistance < this.closestDistance - 2
    ) {
      this.closestDistance = currentDistance;
      this.lastProgressAt = Date.now();
    }
    const recoveryRoute = this.recoveryWaypoint(job.position);
    const onKnownUndergroundRoute =
      !recoveryRoute.surfaceOnly;
    if (
      this.bot.inventory.items().length === 0 &&
      this.bot.entity.position.y >= 50 &&
      timeOfDay >= 13_000 &&
      timeOfDay < 23_000 &&
      !onKnownUndergroundRoute &&
      distanceBetween(this.bot.entity.position, recoveryRoute) > 16
    ) {
      this.bot.pathfinder.stop();
      this.lastProgressAt = Date.now();
      this.report(
        "waiting",
        "Waiting for daylight",
        "Empty-handed recovery will resume when surface hostiles burn"
      );
      return;
    }
    if (this.shouldPauseForDefense?.()) {
      this.lastProgressAt = Date.now();
      this.report("waiting", "Recovery paused for self-defence");
      return;
    }

    this.running = true;
    try {
      if (await this.prepareRecoveryLoadout()) {
        this.lastProgressAt = Date.now();
        return;
      }
      const distance = distanceBetween(this.bot.entity.position, job.position);
      if (distance > ARRIVAL_RADIUS) {
        if (
          Date.now() - (this.lastProgressAt ?? Date.now()) >=
          RECOVERY_NO_PROGRESS_LIMIT_MS
        ) {
          this.finish(
            job.id,
            "cancelled",
            "Recovery abandoned after one minute of active routing without progress"
          );
          return;
        }
        this.noItemsSince = undefined;
        this.report(
          "working",
          "Recovering dropped inventory",
          `${Math.ceil(distance)} blocks from death site`
        );
        const waypoint = this.recoveryWaypoint(job.position);
        const waypointBlock = this.bot.blockAt(
          new Vec3(waypoint.x, waypoint.y, waypoint.z)
        );
        if (
          waypointBlock &&
          (waypointBlock.name === "crafting_table" ||
            waypointBlock.name === "furnace")
        ) {
          this.report(
            "working",
            "Clearing the recovery route",
            `Collecting obstructing ${waypointBlock.name.replaceAll("_", " ")}`
          );
          await this.bot.lookAt(
            waypointBlock.position.offset(0.5, 0.5, 0.5),
            true
          );
          if (this.bot.canDigBlock(waypointBlock)) {
            await this.bot.dig(waypointBlock);
          }
          return;
        }
        if (
          !waypoint.surfaceOnly &&
          distanceBetween(this.bot.entity.position.floored(), waypoint) <= 2
        ) {
          await this.stepToAdjacentWaypoint(waypoint);
          return;
        }
        const waypointKey = `${Math.floor(waypoint.x)},${Math.floor(
          waypoint.y
        )},${Math.floor(waypoint.z)}`;
        if (
          waypointKey !== this.lastWaypointKey ||
          Date.now() - this.lastGoalAt >= 10_000
        ) {
          this.lastGoalAt = Date.now();
          this.lastWaypointKey = waypointKey;
          this.bot.pathfinder.setGoal(
            waypoint.surfaceOnly
              ? new GoalXZ(waypoint.x, waypoint.z)
              : new GoalNear(waypoint.x, waypoint.y, waypoint.z, 0)
          );
        }
        return;
      }

      const item = nearestDroppedItem(this.bot, job.position);
      if (item) {
        this.noItemsSince = undefined;
        const dropped = safeDroppedItem(item);
        this.report(
          "working",
          "Collecting recovered items",
          dropped?.displayName ?? dropped?.name ?? "Dropped item"
        );
        if (Date.now() - this.lastGoalAt >= 400) {
          this.lastGoalAt = Date.now();
          this.lastWaypointKey = `item:${item.id}`;
          this.bot.pathfinder.setGoal(
            new GoalNear(item.position.x, item.position.y, item.position.z, 0)
          );
        }
        return;
      }

      this.noItemsSince ??= Date.now();
      this.report("waiting", "Checking death site", "Confirming all visible drops are collected");
      if (Date.now() - this.noItemsSince >= CLEAR_CONFIRMATION_MS) {
        this.finish(job.id, "completed", "Reached the death site and collected all visible drops");
      }
    } finally {
      this.running = false;
    }
  }

  private async prepareRecoveryLoadout(): Promise<boolean> {
    const hasWeapon = this.bot.inventory
      .items()
      .some(
        (item) =>
          item.name.endsWith("_sword") ||
          item.name.endsWith("_axe")
      );
    if (hasWeapon) return false;
    const priorities = [
      "netherite_sword",
      "diamond_sword",
      "iron_sword",
      "stone_sword",
      "wooden_sword",
      "netherite_axe",
      "diamond_axe",
      "iron_axe",
      "stone_axe",
      "wooden_axe"
    ];
    const container = this.memory
      .ownedContainers(String(this.bot.game?.dimension))
      .find((candidate) =>
        priorities.some((name) => (candidate.contents[name] ?? 0) > 0)
      );
    if (!container) return false;
    const itemName = priorities.find(
      (name) => (container.contents[name] ?? 0) > 0
    );
    if (!itemName) return false;
    this.report(
      "working",
      "Preparing recovery loadout",
      `Retrieving ${itemName.replaceAll("_", " ")} from owned storage`
    );
    const result = await this.actions.execute(
      "withdraw_item_from_container",
      {
        x: container.position.x,
        y: container.position.y,
        z: container.position.z,
        item_name: itemName,
        count: 1
      }
    );
    if (!result.ok) {
      console.warn(`[recovery] Loadout unavailable: ${result.message}`);
    }
    return result.ok;
  }

  private hasRecoveryWeaponAvailable(
    droppedItems: Array<{ name: string; count: number }>
  ): boolean {
    const isWeapon = (name: string) =>
      name.endsWith("_sword") || name.endsWith("_axe");
    if (this.bot.inventory.items().some((item) => isWeapon(item.name))) {
      return true;
    }
    if (
      droppedItems.some(
        (item) => item.count > 0 && isWeapon(item.name)
      )
    ) {
      return true;
    }
    return this.memory
      .ownedContainers(String(this.bot.game?.dimension))
      .some((container) =>
        Object.entries(container.contents).some(
          ([name, count]) => count > 0 && isWeapon(name)
        )
      );
  }

  private async stepToAdjacentWaypoint(waypoint: Position): Promise<void> {
    const target = new Vec3(waypoint.x, waypoint.y, waypoint.z);
    const current = this.bot.entity.position.floored();
    this.bot.pathfinder.stop();
    this.bot.clearControlStates();
    await this.bot.lookAt(target.offset(0.5, 1, 0.5), true);
    this.bot.setControlState("forward", true);
    this.bot.setControlState("jump", target.y > current.y);
    try {
      const deadline = Date.now() + 3_000;
      while (
        Date.now() < deadline &&
        !this.bot.entity.position.floored().equals(target)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      this.bot.setControlState("forward", false);
      this.bot.setControlState("jump", false);
    }
    this.lastWaypointKey = undefined;
  }

  private recoveryWaypoint(
    deathPosition: Position
  ): Position & { surfaceOnly?: boolean } {
    const project =
      this.memory.activeProject() ?? this.memory.latestProject();
    if (!project) {
      return deathPosition;
    }
    const segments = project.steps
      .slice(0, project.currentStepIndex + 1)
      .flatMap((step) => {
        if (step.spec.kind !== "prospect_resource") return [];
        const state = step.state as {
          traversal?: { cells?: Position[] };
        };
        return state.traversal?.cells?.length
          ? [{ cells: state.traversal.cells }]
          : [];
      });
    const entrance = segments[0]?.cells[0];
    if (!entrance) return deathPosition;

    const candidates = segments.flatMap((segment, segmentIndex) =>
      segment.cells.map((position, depth) => ({
        position,
        depth,
        segmentIndex,
        distance: distanceBetween(this.bot.entity.position, position)
      }))
    );
    const nearest = candidates.sort(
      (a, b) =>
        a.distance - b.distance ||
        b.segmentIndex - a.segmentIndex ||
        b.depth - a.depth
    )[0];
    if (!nearest || nearest.distance > 6) {
      if (this.bot.entity.position.y < 50) {
        return { ...deathPosition, surfaceOnly: true };
      }
      return { ...entrance, surfaceOnly: true };
    }

    const targetRouteCell = segments
      .flatMap((segment, segmentIndex) =>
        segment.cells.map((position, depth) => ({
          position,
          depth,
          segmentIndex,
          distance: distanceBetween(deathPosition, position)
        }))
      )
      .sort((a, b) => a.distance - b.distance)[0];
    const segment = segments[nearest.segmentIndex]!;
    const currentCell = this.bot.entity.position.floored();
    if (
      !currentCell.equals(
        new Vec3(
          nearest.position.x,
          nearest.position.y,
          nearest.position.z
        )
      ) &&
      nearest.distance <= 2
    ) {
      return nearest.position;
    }
    if (targetRouteCell && targetRouteCell.distance <= 6) {
      if (targetRouteCell.segmentIndex === nearest.segmentIndex) {
        if (targetRouteCell.depth === nearest.depth) return deathPosition;
        const direction =
          targetRouteCell.depth > nearest.depth ? 1 : -1;
        return (
          segment.cells[nearest.depth + direction] ?? deathPosition
        );
      }

      const endpointDepth = [0, segment.cells.length - 1].sort(
        (a, b) =>
          distanceBetween(segment.cells[a]!, targetRouteCell.position) -
          distanceBetween(segment.cells[b]!, targetRouteCell.position)
      )[0]!;
      if (nearest.depth !== endpointDepth) {
        const direction = endpointDepth > nearest.depth ? 1 : -1;
        return (
          segment.cells[nearest.depth + direction] ?? deathPosition
        );
      }

      const targetSegment = segments[targetRouteCell.segmentIndex]!;
      const bridge = targetSegment.cells
        .map((position, depth) => ({
          position,
          depth,
          distance: distanceBetween(this.bot.entity.position, position)
        }))
        .sort((a, b) => a.distance - b.distance)[0];
      if (bridge && bridge.distance <= 4) return bridge.position;
      return deathPosition;
    }

    const next = segment.cells[nearest.depth + 1];
    if (next) return next;
    const nextSegment = segments[nearest.segmentIndex + 1];
    if (!nextSegment) return deathPosition;
    const closestIndex = nextSegment.cells
      .map((position, index) => ({
        index,
        distance: distanceBetween(this.bot.entity.position, position)
      }))
      .sort((a, b) => a.distance - b.distance)[0]?.index;
    if (closestIndex === undefined) return deathPosition;
    return (
      nextSegment.cells[
        Math.min(nextSegment.cells.length - 1, closestIndex + 1)
      ] ?? deathPosition
    );
  }

  private finish(
    id: number,
    status: "completed" | "expired" | "cancelled",
    reason: string
  ): void {
    this.bot.pathfinder.stop();
    this.memory.updateRecoveryJobStatus(id, status, reason);
    if (!this.memory.activeRecoveryJob()) {
      const project =
        this.memory.activeProject() ?? this.memory.latestProject();
      if (project?.status === "blocked") {
        const step = project.steps[project.currentStepIndex];
        if (
          step &&
          project.statusReason?.includes("no pickaxe")
        ) {
          const recoveredPickaxe = this.bot.inventory
            .items()
            .some((item) => item.name.endsWith("_pickaxe"));
          if (recoveredPickaxe) {
            project.status = "active";
            project.statusReason = undefined;
            step.status = "pending";
            step.statusReason = undefined;
            this.memory.saveProject(project);
          } else if (rewindProjectForInventoryLoss(project)) {
            this.memory.saveProject(project);
            this.memory.record({
              kind: "project_recovery",
              summary:
                `${project.title}: replaying the planned material and tool ` +
                "chain after inventory loss",
              importance: 9
            });
          }
        }
      }
    }
    this.memory.record({
      kind: "recovery",
      summary: reason,
      position: {
        x: this.bot.entity.position.x,
        y: this.bot.entity.position.y,
        z: this.bot.entity.position.z
      },
      dimension: String(this.bot.game?.dimension),
      importance: status === "expired" ? 9 : 8
    });
    this.noItemsSince = undefined;
    this.lastWaypointKey = undefined;
    this.closestDistance = undefined;
    this.lastProgressAt = undefined;
    this.resetLifetimeTracking();
    this.report(
      "idle",
      status === "completed"
        ? "Inventory recovered"
        : status === "expired"
          ? "Recovery expired"
          : "Recovery skipped",
      reason
    );
  }

  private updateLoadedChunkLifetime(job: {
    id: number;
    position: Position;
    dimension: string;
    loadedChunkMs: number;
  }): boolean {
    const now = Date.now();
    if (this.trackedJobId !== job.id) {
      this.trackedJobId = job.id;
      this.lastLifetimeCheckAt = now;
      this.closestDistance = undefined;
      this.lastProgressAt = now;
    }
    const elapsedMs = Math.max(0, now - (this.lastLifetimeCheckAt ?? now));
    this.lastLifetimeCheckAt = now;

    const inDeathDimension =
      String(this.bot.game?.dimension) === job.dimension;
    const deathChunkLoaded =
      inDeathDimension &&
      this.bot.world.getColumnAt(
        new Vec3(job.position.x, job.position.y, job.position.z)
      ) !== null;
    if (!deathChunkLoaded || elapsedMs === 0) {
      return false;
    }

    const updated = this.memory.addRecoveryLoadedChunkTime(job.id, elapsedMs);
    if (updated.loadedChunkMs < RECOVERY_LOADED_CHUNK_LIMIT_MS) {
      return false;
    }

    this.finish(
      job.id,
      "expired",
      "Dropped items had five minutes of loaded-chunk time and have despawned"
    );
    return true;
  }

  private resetLifetimeTracking(): void {
    this.trackedJobId = undefined;
    this.lastLifetimeCheckAt = undefined;
  }

  private report(
    phase: ActivityUpdate["phase"],
    label: string,
    detail?: string
  ): void {
    this.onActivity?.({ phase, label, detail });
  }
}

export function shouldRecoverInventory(
  items: Array<{ name: string; count: number }>
): boolean {
  const totalCount = items.reduce(
    (total, item) => total + Math.max(0, item.count),
    0
  );
  return (
    totalCount >= 16 ||
    items.some(
      (item) =>
        item.count > 0 && !LOW_VALUE_RECOVERY_ITEMS.has(item.name)
    )
  );
}

export function rewindProjectForInventoryLoss(
  project: ProjectPlan
): boolean {
  if (!project.anchor) return false;
  const failedIndex = project.currentStepIndex;
  const firstProducerIndex = project.steps.findIndex(
    (step, index) =>
      index <= failedIndex && step.spec.kind === "acquire_item"
  );
  if (firstProducerIndex < 0) return false;

  const returnStepId = "return_after_inventory_loss";
  let returnIndex = project.steps.findIndex(
    (step) => step.id === returnStepId
  );
  let adjustedFailedIndex = failedIndex;
  if (returnIndex < 0) {
    project.steps.splice(firstProducerIndex, 0, {
      id: returnStepId,
      title: "Returning to the project site after inventory loss",
      spec: { kind: "use_site", position: project.anchor },
      status: "pending",
      state: {}
    });
    returnIndex = firstProducerIndex;
    adjustedFailedIndex += 1;
  } else {
    const returnStep = project.steps[returnIndex]!;
    returnStep.spec = { kind: "use_site", position: project.anchor };
    returnStep.status = "pending";
    returnStep.statusReason = undefined;
    returnStep.state = {};
  }

  for (
    let index = returnIndex + 1;
    index <= adjustedFailedIndex;
    index += 1
  ) {
    const step = project.steps[index];
    if (!step) continue;
    step.status = "pending";
    step.statusReason = undefined;
    if (
      step.spec.kind === "acquire_item"
    ) {
      step.state = {};
    } else if (step.spec.kind === "prospect_resource") {
      const traversal = (
        step.state as { traversal?: { cells?: Position[] } }
      ).traversal;
      step.state = traversal?.cells?.length
        ? { traversal }
        : {};
    }
  }
  project.currentStepIndex = returnIndex;
  project.status = "active";
  project.statusReason = undefined;
  return true;
}

function nearestDroppedItem(
  bot: Bot,
  deathPosition: { x: number; y: number; z: number }
): Entity | undefined {
  return Object.values(bot.entities)
    .filter(isDroppedItemEntity)
    .filter((entity) => distanceBetween(entity.position, deathPosition) <= SEARCH_RADIUS)
    .sort(
      (a, b) =>
        bot.entity.position.distanceTo(a.position) -
        bot.entity.position.distanceTo(b.position)
    )[0];
}

function safeDroppedItem(
  entity: Entity
): ReturnType<Entity["getDroppedItem"]> {
  try {
    return entity.getDroppedItem();
  } catch {
    return null;
  }
}

function distanceBetween(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
