import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { ProjectPersistence } from "./persistence-ports.js";
import type { ExecutionScope } from "./execution-coordinator.js";
import type { Perception } from "./perception.js";
import {
  absolutePosition,
  relativeKey,
  structureCheckLabel
} from "./project-plan.js";
import {
  appendTraversalCell,
  isCurrentSupportBlock,
  nextReverseTraversalTarget,
  type TraversalJournal
} from "./navigation.js";
import type { MovementSystem } from "./movement-system.js";
import type { InventorySystem } from "./inventory-system.js";
import type { MiningSystem } from "./mining-system.js";
import type { BuildingSystem } from "./building-system.js";
import type { ProductionSystem } from "./production-system.js";
import type { StorageSystem } from "./storage-system.js";
import type { SurvivalSystem } from "./survival-system.js";
import type { CombatSystem } from "./combat-system.js";
import type { TaskLifecycle } from "./task-lifecycle.js";
import {
  isProtectedExcavationBlockName,
  isReplaceableBlockName
} from "./block-classification.js";
export { isProtectedExcavationBlockName } from "./block-classification.js";
import { rewindProjectForInventoryLoss } from "./recovery-system.js";
import type {
  ActivityUpdate,
  BlueprintPlacement,
  Position,
  ProjectPlan,
  ProjectStep,
  RelativePosition,
  StructureCheck
} from "./types.js";
import { spiralOffset } from "./acquisition-system.js";
import type { TelemetrySystem } from "./telemetry-system.js";

interface SurveyState {
  origin?: Position;
  nextWaypoint?: number;
  candidate?: Position;
  preparedBlocks?: number;
  rejectedCandidates?: string[];
}

interface AcquireState {
  workOrderId?: number;
}

interface PlacementState {
  completed?: number[];
  failures?: Record<string, number>;
}

interface ProspectState {
  surfaceOrigin?: Position;
  descentIndex?: number;
  descentHeading?: "north" | "south" | "east" | "west";
  descentFailures?: number;
  tunnelOrigin?: Position;
  route?: Position[];
  routeIndex?: number;
  excavatedBlocks?: number;
  failures?: number;
  rebases?: number;
  routeHeading?: "north" | "south" | "east" | "west";
  portableTable?: Position;
  traversal?: TraversalJournal;
  returnCursor?: number;
  returnFailures?: number;
  returnStride?: number;
  forageOrigin?: Position;
  forageWaypoint?: number;
  forageTargetId?: number;
  forageTargetPosition?: Position;
  lastForageAttackAt?: number;
}

type EmergencyToolResult = "crafted" | "working" | "impossible";
const MAX_PROSPECT_REBASES = 8;

export class ProjectSystem {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastState?: string;
  private taskLifecycle?: TaskLifecycle;
  private readonly reportedTerminalProjects = new Set<string>();
  constructor(
    private readonly bot: Bot,
    private readonly memory: ProjectPersistence,
    private readonly telemetry: TelemetrySystem,
    private readonly perception: Perception,
    private readonly movement: MovementSystem,
    private readonly inventory: InventorySystem,
    private readonly mining: MiningSystem,
    private readonly building: BuildingSystem,
    private readonly production: ProductionSystem,
    private readonly storage: StorageSystem,
    private readonly survival: SurvivalSystem,
    private readonly combat: CombatSystem,
    private readonly tickMs: number,
    private readonly onTerminal?: (
      status: "completed" | "blocked",
      project: ProjectPlan
    ) => void,
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

  isActive(): boolean {
    return this.memory.activeProject() !== undefined;
  }

  setTaskLifecycle(taskLifecycle: TaskLifecycle): void {
    this.taskLifecycle = taskLifecycle;
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
    let project = this.memory.activeProject() ?? this.resumeRecoverableProject();
    if (!project) {
      const latest = this.memory.latestProject();
      if (latest?.status === "blocked") {
        this.reportTerminal("blocked", latest);
      }
      return;
    }
    let step = project.steps[project.currentStepIndex];
    if (!step) {
      this.completeProject(project);
      return;
    }
    if (this.shouldPauseForDefense?.()) {
      this.report("waiting", "Project paused for combat safety", step.title);
      return;
    }

    this.running = true;
    try {
      if (step.status === "pending") {
        step.status = "in_progress";
        project = this.memory.saveProject(project);
        step = project.steps[project.currentStepIndex]!;
      }
      this.report(
        "working",
        step.title,
        `Project ${project.currentStepIndex + 1}/${project.steps.length}`
      );
      this.log(
        `${project.id}:${project.currentStepIndex}`,
        `[project] ${project.title}: ${step.title}`
      );

      switch (step.spec.kind) {
        case "use_site":
          await this.executeUseSite(project, step.spec);
          break;
        case "survey_site":
          await this.executeSurvey(project, step, step.spec);
          break;
        case "acquire_item":
          await this.executeAcquire(project, step, step.spec);
          break;
        case "craft_item":
          await this.executeCraft(project, step, step.spec);
          break;
        case "smelt_item":
          await this.executeSmelt(project, step, step.spec);
          break;
        case "prospect_resource":
          await this.executeProspect(project, step, step.spec);
          break;
        case "place_blueprint":
          await this.executePlacements(project, step, step.spec);
          break;
        case "verify_structure":
          await this.executeVerification(project, step, step.spec);
          break;
        case "verify_inventory":
          this.executeInventoryVerification(project, step.spec);
          break;
        case "deposit_item":
          await this.executeDeposit(project, step, step.spec);
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[project] ${message}`);
      this.report("error", "Project step failed", message);
    } finally {
      this.running = false;
    }
  }

  private async executeUseSite(
    project: ProjectPlan,
    spec: Extract<ProjectStep["spec"], { kind: "use_site" }>
  ): Promise<void> {
    const distance = Math.hypot(
      this.bot.entity.position.x - spec.position.x,
      this.bot.entity.position.y - spec.position.y,
      this.bot.entity.position.z - spec.position.z
    );
    if (distance > 4.5) {
      const traversal = await this.followRecordedTraversal(project);
      if (traversal === "progress") return;
      if (traversal === "blocked") {
        this.blockProject(
          project,
          "Recorded return route to the project site is blocked"
        );
        return;
      }
    }
    if (distance > 16) {
      this.report(
        "working",
        "Returning to remembered project site",
        `${Math.ceil(distance)} blocks away`
      );
      await this.movement.goNear(spec.position, 4);
    }
    project.anchor = spec.position;
    this.finishStep(
      project,
      `Reused remembered site at ${spec.position.x}, ${spec.position.y}, ${spec.position.z}`
    );
  }

  private async executeSurvey(
    project: ProjectPlan,
    step: ProjectStep,
    spec: Extract<ProjectStep["spec"], { kind: "survey_site" }>
  ): Promise<void> {
    const state = step.state as SurveyState;
    state.origin ??= floorPosition(this.bot.entity.position);
    state.preparedBlocks ??= 0;
    state.rejectedCandidates ??= [];
    const maxPreparation =
      spec.maxSitePreparationBlocks ??
      spec.width * spec.depth * spec.clearanceHeight;

    if (!state.candidate) {
      const selected = selectBuildSiteCandidate({
        center: floorPosition(this.bot.entity.position),
        width: spec.width,
        depth: spec.depth,
        clearanceHeight: spec.clearanceHeight,
        searchRadius:
          spec.searchRadius ?? Math.max(spec.width, spec.depth) + 3,
        maxObstructions: maxPreparation,
        rejected: new Set(state.rejectedCandidates),
        blockAt: (position) => this.perception.blockAt(new Vec3(
          position.x,
          position.y,
          position.z
        )),
        canMine: (position) => this.mining.canMine(position)
      });
      if (!selected) {
        this.blockProject(
          project,
          `No safe preparable ${spec.width}x${spec.depth} site is loaded nearby`
        );
        return;
      }
      state.candidate = selected.anchor;
      state.preparedBlocks = 0;
      this.memory.saveProject(project);
      this.report(
        "working",
        `Preparing a nearby ${spec.width}x${spec.depth} build site`,
        `${selected.obstructions} blocks need clearing; no survey roaming`
      );
    }

    const result = await this.mining.prepareBuildSite({
      anchor: state.candidate,
      width: spec.width,
      depth: spec.depth,
      clearanceHeight: spec.clearanceHeight,
      maxExcavations: Math.max(0, maxPreparation - state.preparedBlocks)
    });
    if (result.status === "blocked") {
      state.rejectedCandidates.push(positionKey(state.candidate));
      state.candidate = undefined;
      state.preparedBlocks = 0;
      this.memory.saveProject(project);
      this.report("waiting", "Rejected unsafe build site", result.detail);
      return;
    }
    if (result.status === "progress") {
      state.preparedBlocks += result.excavated;
      this.memory.saveProject(project);
      this.report(
        "working",
        "Clearing the selected build site",
        `${state.preparedBlocks}/${maxPreparation} cleared; ${result.remaining} visible obstructions remain`
      );
      return;
    }

    project.anchor = state.candidate;
    this.finishStep(
      project,
      `Prepared build site at ${state.candidate.x}, ${state.candidate.y}, ${state.candidate.z} ` +
        `after clearing ${state.preparedBlocks} blocks`
    );
  }

  private async executeAcquire(
    project: ProjectPlan,
    step: ProjectStep,
    spec: Extract<ProjectStep["spec"], { kind: "acquire_item" }>
  ): Promise<void> {
    const current = this.inventory.count(spec.itemName);
    if (current >= spec.targetCount) {
      const state = step.state as AcquireState;
      if (state.workOrderId !== undefined) {
        const order = this.memory.workOrder(state.workOrderId);
        if (order.status === "active") {
          this.requireTaskLifecycle().finishWorkOrder(
            order.id,
            "completed",
            `Project material target reached with ${current} ${spec.itemName}`
          );
        }
      }
      this.finishStep(project, `Inventory contains ${current} ${spec.itemName}`);
      return;
    }

    const state = step.state as AcquireState;
    if (state.workOrderId !== undefined) {
      const order = this.memory.workOrder(state.workOrderId);
      if (order.status === "blocked") {
        if (order.spec.continuation === "stop_at_minimum") {
          state.workOrderId = undefined;
          this.memory.saveProject(project);
          return;
        }
        this.blockProject(
          project,
          order.statusReason ?? "Material gathering blocked"
        );
        return;
      }
      // AcquisitionSystem owns movement until its active operation settles.
      // Navigating the project return route here would replace its Pathfinder
      // goal and make both deterministic systems cancel one another.
      if (order.status === "active") return;
    }

    const activeOrder = this.memory.activeWorkOrder();
    if (activeOrder) {
      if (
        state.workOrderId === undefined &&
        activeOrder.spec.itemName === spec.itemName &&
        activeOrder.spec.blockNames.every((name) =>
          spec.sourceBlockNames.includes(name)
        )
      ) {
        state.workOrderId = activeOrder.id;
        this.memory.saveProject(project);
      }
      // Work orders have exclusive use of movement. Even an unrelated order
      // must finish or be replaced by its owner before project navigation.
      return;
    }

    const surfaceSource = spec.sourceBlockNames.some(
      (name) =>
        name.endsWith("_log") ||
        name.endsWith("_stem") ||
        name.endsWith("_leaves")
    );
    if (surfaceSource && project.anchor) {
      const traversal = await this.followRecordedTraversal(project);
      if (traversal === "progress") {
        if (state.workOrderId !== undefined) {
          const existing = this.memory.workOrder(state.workOrderId);
          if (existing.status === "active") {
            this.requireTaskLifecycle().finishWorkOrder(
              existing.id,
              "cancelled",
              "Returning to the surface before gathering"
            );
          }
          state.workOrderId = undefined;
          this.memory.saveProject(project);
        }
        return;
      }
      if (traversal === "blocked") {
        this.blockProject(
          project,
          "Recorded return route is blocked and requires replanning"
        );
        return;
      }
    }
    if (
      surfaceSource &&
      project.anchor &&
      this.bot.entity.position.y < project.anchor.y - 8
    ) {
      if (state.workOrderId !== undefined) {
        const existing = this.memory.workOrder(state.workOrderId);
        if (existing.status === "active") {
          this.requireTaskLifecycle().finishWorkOrder(
            existing.id,
            "cancelled",
            "Returning to the surface before gathering"
          );
        }
        state.workOrderId = undefined;
        this.memory.saveProject(project);
      }
      this.report(
        "working",
        `Returning to the surface for ${spec.itemName.replaceAll("_", " ")}`,
        `Currently at Y ${Math.floor(this.bot.entity.position.y)}`
      );
      this.blockProject(
        project,
        "No validated traversal journal connects the mine to the surface"
      );
      return;
    }

    const order = this.requireTaskLifecycle().submitProjectGather(
      {
        goalId: project.goalId,
        itemName: spec.itemName,
        blockNames: spec.sourceBlockNames,
        minimumCount: spec.targetCount - current,
        continuation: "until_replaced",
        storage: { mode: "inventory" }
      },
      project.origin
    );
    state.workOrderId = order.id;
    this.memory.saveProject(project);
  }

  private requireTaskLifecycle(): TaskLifecycle {
    if (!this.taskLifecycle) {
      throw new Error("ProjectSystem has no TaskSystem lifecycle connection");
    }
    return this.taskLifecycle;
  }

  private async followRecordedTraversal(
    project: ProjectPlan
  ): Promise<"progress" | "complete" | "blocked" | "unavailable"> {
    const current = floorPosition(this.bot.entity.position);
    for (const candidateStep of project.steps) {
      if (candidateStep.spec.kind !== "prospect_resource") continue;
      const state = candidateStep.state as ProspectState;
      if (!state.traversal?.cells.length) continue;
      const next = nextReverseTraversalTarget(
        state.traversal,
        current,
        state.returnCursor,
        2,
        state.returnStride ?? 8
      );
      if (!next) continue;
      if (next.complete) {
        state.returnCursor = undefined;
        state.returnFailures = 0;
        state.returnStride = 8;
        this.memory.saveProject(project);
        return "complete";
      }

      this.report(
        "working",
        "Following the recorded traversal back to the surface",
        `Checkpoint ${next.cursor + 1}/${state.traversal.cells.length}`
      );
      const result = await this.movement.reachExact(next.target!);
      if (result.status === "reached") {
        state.returnCursor = next.cursor;
        state.returnFailures = 0;
        state.returnStride = 8;
        this.memory.saveProject(project);
        return "progress";
      }

      if ((state.returnStride ?? 8) > 1) {
        state.returnStride = Math.max(
          1,
          Math.floor((state.returnStride ?? 8) / 2)
        );
      } else {
        state.returnFailures = (state.returnFailures ?? 0) + 1;
      }
      this.memory.saveProject(project);
      console.warn(
        `[navigation] Recorded checkpoint blocked: ${result.reason}: ` +
          result.detail
      );
      return (state.returnFailures ?? 0) >= 3
        ? "blocked"
        : "progress";
    }
    return "unavailable";
  }

  private async executeCraft(
    project: ProjectPlan,
    step: ProjectStep,
    spec: Extract<ProjectStep["spec"], { kind: "craft_item" }>
  ): Promise<void> {
    const current = this.inventory.count(spec.itemName);
    if (current >= spec.targetCount) {
      this.finishStep(project, `Crafted ${current} ${spec.itemName}`);
      return;
    }
    const plannedTable = spec.craftingTableAt
      ? this.blockAtRelative(project, spec.craftingTableAt)
      : null;
    const nearbyTable = this.findNearbyCraftingTable(4);
    const rememberedTable = this.rememberedPortableCraftingTable(project);
    let table: ReturnType<Bot["blockAt"]> | undefined =
      spec.craftingTableAt
        ? plannedTable ?? nearbyTable ?? rememberedTable ?? undefined
        : undefined;
    if (
      spec.craftingTableAt &&
      (!table || table.name !== "crafting_table")
    ) {
      table = await this.restoreCraftingTable(project);
    }
    if (
      spec.craftingTableAt &&
      (!table || table.name !== "crafting_table")
    ) {
      this.blockProject(project, "Required crafting table is not at the planned location");
      return;
    }
    if (table) {
      try {
        if (
          distanceBetween(this.bot.entity.position, table.position) >
          4.5
        ) {
          const traversal = await this.followRecordedTraversal(project);
          if (traversal === "progress") return;
          if (traversal === "blocked") {
            throw new Error(
              "Recorded route to the crafting area is blocked"
            );
          }
        }
        if (
          distanceBetween(this.bot.entity.position, table.position) >
          8
        ) {
          const navigation =
            await this.movement.reachSurfaceArea(
              table.position,
              4
            );
          if (navigation.status === "blocked") {
            throw new Error(navigation.detail);
          }
          return;
        }
        await this.movement.positionForBlock(table.position, 4, 20_000);
        if (
          distanceBetween(
            this.bot.entity.position,
            table.position
          ) > 4.5 ||
          !this.perception.canSeeBlock(table)
        ) {
          throw new Error(
            "Pathfinder stopped without reaching interaction range"
          );
        }
      } catch (error) {
        console.warn(
          "[project] Remembered crafting table is unreachable; " +
            "preparing a local replacement"
        );
        table = await this.restoreCraftingTable(project);
        if (
          !table &&
          this.reopenCraftMaterialProducer(
            project,
            step,
            {
              kind: "craft_item",
              itemName: "crafting_table",
              targetCount: 1
            },
            0,
            null
          )
        ) {
          return;
        }
        if (!table) throw error;
      }
    }
    if (table) {
      table = this.perception.blockAt(table.position) ?? table;
      await this.movement.face(table.position.offset(0.5, 0.5, 0.5));
      console.log(
        `[project] Using crafting table at ${table.position.x}, ` +
          `${table.position.y}, ${table.position.z} from ` +
          `${this.bot.entity.position.x.toFixed(1)}, ` +
          `${this.bot.entity.position.y.toFixed(1)}, ` +
          `${this.bot.entity.position.z.toFixed(1)}`
      );
    }
    const result = await this.production.craftOne(
      spec.itemName,
      table ?? undefined
    );
    if (result.status === "unavailable") {
      if (
        this.reopenCraftMaterialProducer(
          project,
          step,
          spec,
          current,
          table ?? null
        )
      ) {
        return;
      }
      this.blockProject(project, result.detail);
      return;
    }
  }

  private async restoreCraftingTable(
    project: ProjectPlan
  ): Promise<ReturnType<Bot["blockAt"]> | undefined> {
    let carried = this.inventory
      .items()
      .find((item) => item.name === "crafting_table");
    if (!carried) {
      const result = await this.production.craftOne("crafting_table");
      if (result.status === "produced") {
        carried = this.inventory
          .items()
          .find((item) => item.name === "crafting_table");
      }
    }
    if (!carried || !project.anchor) return undefined;

    const placed = await this.building.placeNearby("crafting_table");
    if (placed.status === "blocked") return undefined;
    const relative = {
      dx: placed.position.x - project.anchor.x,
      dy: placed.position.y - project.anchor.y,
      dz: placed.position.z - project.anchor.z
    };
    for (const candidate of project.steps) {
      if (
        candidate.spec.kind === "craft_item" ||
        candidate.spec.kind === "prospect_resource"
      ) {
        if (candidate.spec.craftingTableAt) {
          candidate.spec.craftingTableAt = relative;
        }
      }
    }
    this.memory.saveProject(project);
    console.log(
      `[project] Restored crafting table at ` +
        `${placed.position.x}, ${placed.position.y}, ${placed.position.z}`
    );
    return placed.block;
  }

  private reopenCraftMaterialProducer(
    project: ProjectPlan,
    craftStep: ProjectStep,
    spec: Extract<ProjectStep["spec"], { kind: "craft_item" }>,
    currentOutput: number,
    table: ReturnType<Bot["blockAt"]>
  ): boolean {
    const item = this.bot.registry.itemsByName[spec.itemName];
    if (!item) return false;
    const recipes = this.bot.recipesAll(item.id, null, table ?? null);
    const currentStepIndex = project.steps.indexOf(craftStep);
    for (const recipe of recipes) {
      const executions = Math.ceil(
        (spec.targetCount - currentOutput) /
          Math.max(1, recipe.result.count)
      );
      const ingredients = Array.isArray(recipe.delta)
        ? recipe.delta.filter((ingredient) => ingredient.count < 0)
        : Array.isArray(recipe.ingredients)
          ? recipe.ingredients
          : Array.isArray(recipe.inShape)
            ? recipe.inShape.flat().filter((ingredient) => Boolean(ingredient))
            : [];
      for (const ingredient of ingredients) {
        if (!ingredient) continue;
        const ingredientName = this.bot.registry.items[ingredient.id]?.name;
        if (!ingredientName) continue;
        const required = Math.abs(ingredient.count) * executions;
        const available = this.inventory
          .items()
          .filter((inventoryItem) => inventoryItem.type === ingredient.id)
          .reduce((total, inventoryItem) => total + inventoryItem.count, 0);
        const missing = Math.max(0, required - available);
        if (missing === 0) continue;
        for (let index = currentStepIndex - 1; index >= 0; index -= 1) {
          const producer = project.steps[index]!;
          if (
            (producer.spec.kind !== "acquire_item" &&
              producer.spec.kind !== "craft_item" &&
              producer.spec.kind !== "prospect_resource") ||
            producer.spec.itemName !== ingredientName
          ) {
            continue;
          }
          producer.spec.targetCount = available + missing;
          producer.status = "pending";
          producer.statusReason = undefined;
          if (
            producer.spec.kind === "prospect_resource" &&
            typeof (producer.state as ProspectState).failures === "number"
          ) {
            (producer.state as ProspectState).failures = 0;
          }
          craftStep.status = "pending";
          craftStep.statusReason = undefined;
          project.currentStepIndex = index;
          project.status = "active";
          project.statusReason = undefined;
          this.memory.saveProject(project);
          console.log(
            `[project] Reopened ${producer.title} for ${missing} more ` +
              `${ingredientName} required by ${craftStep.title}`
          );
          return true;
        }
      }
    }
    return false;
  }

  private async executeSmelt(
    project: ProjectPlan,
    _step: ProjectStep,
    spec: Extract<ProjectStep["spec"], { kind: "smelt_item" }>
  ): Promise<void> {
    const current = this.inventory.count(spec.outputItemName);
    if (current >= spec.targetCount) {
      this.finishStep(
        project,
        `Smelted ${current} ${spec.outputItemName}`
      );
      return;
    }
    let furnaceBlock = this.blockAtRelative(project, spec.furnaceAt);
    if (
      (!furnaceBlock || furnaceBlock.name !== "furnace") &&
      this.inventory.count("furnace") > 0 &&
      project.anchor
    ) {
      const placed = await this.building.placeNearby("furnace");
      if (placed.status !== "blocked") {
        spec.furnaceAt = {
          dx: placed.position.x - project.anchor.x,
          dy: placed.position.y - project.anchor.y,
          dz: placed.position.z - project.anchor.z
        };
        this.memory.saveProject(project);
        furnaceBlock = placed.block;
        console.log(
          `[project] Restored displaced furnace at ` +
            `${placed.position.x}, ${placed.position.y}, ${placed.position.z}`
        );
      }
    }
    if (!furnaceBlock || furnaceBlock.name !== "furnace") {
      this.blockProject(project, "Required furnace is not at the planned location");
      return;
    }
    const result = await this.production.smeltStep({
      furnace: furnaceBlock,
      inputItemName: spec.inputItemName,
      fuelItemName: spec.fuelItemName,
      fuelCount: spec.fuelCount,
      outputItemName: spec.outputItemName,
      targetCount: spec.targetCount
    });
    if (result.status === "blocked") {
      this.blockProject(project, result.detail);
      return;
    }
    if (result.status !== "output_collected") {
      this.report(
        "waiting",
        `Smelting ${spec.outputItemName.replaceAll("_", " ")}`,
        `${current}/${spec.targetCount}`
      );
    }
  }

  private async executeProspect(
    project: ProjectPlan,
    step: ProjectStep,
    spec: Extract<ProjectStep["spec"], { kind: "prospect_resource" }>
  ): Promise<void> {
    const count = this.inventory.count(spec.itemName);
    if (count >= spec.targetCount) {
      this.finishStep(
        project,
        `Prospecting produced ${count} ${spec.itemName}`
      );
      return;
    }

    const state = step.state as ProspectState;
    state.surfaceOrigin ??= floorPosition(this.bot.entity.position);
    state.traversal ??= {
      cells: [{ ...state.surfaceOrigin }]
    };
    state.routeIndex ??= 0;
    state.excavatedBlocks ??= 0;
    state.failures ??= 0;
    state.descentIndex ??= 1;
    state.descentHeading ??= spec.heading;
    state.descentFailures ??= 0;
    const descentHeading = state.descentHeading;

    if (await this.ensureMiningFood(project, state)) return;

    if (!this.hasPickaxe()) {
      const upgrade = await this.craftEmergencyStonePickaxe(
        project,
        spec.craftingTableAt,
        state,
        descentHeading
      );
      if (upgrade === "working") return;
      if (upgrade === "crafted") {
        this.report(
          "working",
          "Upgraded worn mining tool",
          "Crafted a stone pickaxe and will resume the saved tunnel"
        );
        return;
      }
      this.blockProject(
        project,
        "Prospecting has no pickaxe and cannot craft a stone replacement"
      );
      return;
    }

    const visibleOre = this.findVisibleOre(spec.oreBlockNames);
    if (visibleOre) {
      this.report(
        "working",
        `Mining visible ${visibleOre.name.replaceAll("_", " ")}`,
        `${count}/${spec.targetCount} ${spec.itemName.replaceAll("_", " ")}`
      );
      const result = await this.mining.mineBlock({
        position: { x: visibleOre.x, y: visibleOre.y, z: visibleOre.z },
        requireVisible: true
      });
      if (result.status === "blocked") throw new Error(result.detail);
      if (result.status === "already_clear") return;
      state.excavatedBlocks += 1;
      this.memory.saveProject(project);
      return;
    }

    if (!state.tunnelOrigin) {
      this.calibrateStaircaseHeight(state, descentHeading);
    }
    const totalDescent = state.tunnelOrigin
      ? Math.max(0, (state.descentIndex ?? 1) - 1)
      : Math.max(0, state.surfaceOrigin.y - spec.targetY);
    if (state.descentIndex <= totalDescent) {
      const descentIndex = state.descentIndex;
      const previousDepth = descentIndex - 1;
      const previous = {
        x:
          state.surfaceOrigin.x +
          headingVector(descentHeading).x * previousDepth,
        y: state.surfaceOrigin.y - previousDepth,
        z:
          state.surfaceOrigin.z +
          headingVector(descentHeading).z * previousDepth
      };
      const currentCell = this.bot.entity.position.floored();
      const previousBlock = this.perception.blockAt(
        new Vec3(previous.x, previous.y, previous.z)
      );
      if (
        previousBlock &&
        isSolid(previousBlock.name, previousBlock.boundingBox)
      ) {
        const landing = {
          x: previous.x,
          y: previous.y + 1,
          z: previous.z
        };
        try {
          await this.enterStairLanding(landing);
          state.surfaceOrigin.y += 1;
        } catch (error) {
          const safeCell = this.bot.entity.position.floored();
          const floor = this.perception.blockAt(safeCell.offset(0, -1, 0));
          if (!floor || !isSolid(floor.name, floor.boundingBox)) throw error;
          const direction = headingVector(descentHeading);
          state.surfaceOrigin = {
            x: safeCell.x - direction.x * previousDepth,
            y: safeCell.y + previousDepth,
            z: safeCell.z - direction.z * previousDepth
          };
          console.log(
            `[prospect] Rebased staircase cursor to safe cell ` +
              `${safeCell.x}, ${safeCell.y}, ${safeCell.z}`
          );
        }
        this.memory.saveProject(project);
        return;
      }
      if (
        !currentCell.equals(
          new Vec3(previous.x, previous.y, previous.z)
        ) &&
        distanceBetween(currentCell, previous) <= 3
      ) {
        this.report(
          "working",
          "Returning to the saved staircase cursor",
          `Preparing step ${descentIndex}/${totalDescent}`
        );
        try {
          await this.stepToAdjacentCell(
            previous,
            previous.y > currentCell.y
          );
        } catch (error) {
          if (
            previous.y < currentCell.y &&
            (await this.building.buildStairLanding(previous))
          ) {
            state.surfaceOrigin.y += 1;
            this.memory.saveProject(project);
            return;
          }
          throw error;
        }
        return;
      }
      const next = {
        x:
          state.surfaceOrigin.x +
          headingVector(descentHeading).x * descentIndex,
        y: Math.max(
          spec.targetY,
          state.surfaceOrigin.y - descentIndex
        ),
        z:
          state.surfaceOrigin.z +
          headingVector(descentHeading).z * descentIndex
      };
      this.report(
        "working",
        `Excavating staircase to Y ${spec.targetY}`,
        `Step ${descentIndex}/${totalDescent}`
      );
      if (distanceBetween(this.bot.entity.position, next) > 5) {
        await this.movement.goNear(next, 2);
      }
      try {
        state.excavatedBlocks += await this.mining.excavateAndEnter(next, 3);
        appendTraversalCell(
          state.traversal,
          floorPosition(this.bot.entity.position)
        );
        state.descentIndex += 1;
        state.descentFailures = 0;
        this.memory.saveProject(project);
      } catch (error) {
        const settled = this.bot.entity.position.floored();
        if (
          settled.y === next.y &&
          distanceBetween(settled, next) <= 2
        ) {
          const direction = headingVector(descentHeading);
          state.surfaceOrigin = {
            x: settled.x - direction.x * descentIndex,
            y: settled.y + descentIndex,
            z: settled.z - direction.z * descentIndex
          };
          appendTraversalCell(state.traversal, settled);
          state.descentIndex += 1;
          state.descentFailures = 0;
          this.memory.saveProject(project);
          console.log(
            `[prospect] Accepted safe staircase drift at ` +
              `${settled.x}, ${settled.y}, ${settled.z}`
          );
          return;
        }
        state.descentFailures = (state.descentFailures ?? 0) + 1;
        if (state.descentFailures >= 3) {
          const safeCell = this.bot.entity.position.floored();
          const nextHeading = rotateHeading(descentHeading);
          const nextDirection = headingVector(nextHeading);
          state.descentHeading = nextHeading;
          state.surfaceOrigin = {
            x: safeCell.x - nextDirection.x * previousDepth,
            y: safeCell.y + previousDepth,
            z: safeCell.z - nextDirection.z * previousDepth
          };
          state.descentFailures = 0;
          this.memory.saveProject(project);
          console.log(
            `[prospect] Rebased blocked descent at ${safeCell.x}, ` +
              `${safeCell.y}, ${safeCell.z}; now heading ${nextHeading}`
          );
          return;
        }
        this.memory.saveProject(project);
        throw error;
      }
      return;
    }

    if (!state.tunnelOrigin) {
      state.tunnelOrigin = {
        x:
          state.surfaceOrigin.x +
          headingVector(descentHeading).x * totalDescent,
        y: spec.targetY,
        z:
          state.surfaceOrigin.z +
          headingVector(descentHeading).z * totalDescent
      };
      if (distanceBetween(this.bot.entity.position, state.tunnelOrigin) > 3) {
        await this.movement.goNear(state.tunnelOrigin, 1);
      }
      appendTraversalCell(
        state.traversal,
        floorPosition(this.bot.entity.position)
      );
      state.route = createBranchMineRoute(
        state.tunnelOrigin,
        spec.maxTunnelBlocks,
        spec.branchLength,
        spec.branchSpacing,
        state.routeHeading ?? descentHeading
      );
      state.routeIndex = 0;
      this.memory.saveProject(project);
    }

    const route = state.route ?? [];
    const next = route[state.routeIndex];
    if (!next) {
      const settled = this.bot.entity.position.floored();
      const floor = this.perception.blockAt(settled.offset(0, -1, 0));
      if (
        floor &&
        isSolid(floor.name, floor.boundingBox) &&
        (state.rebases ?? 0) < MAX_PROSPECT_REBASES
      ) {
        this.rebaseProspectRoute(project, state, spec, settled);
        this.telemetry.record({
          kind: "project_progress",
          summary:
            `${project.title}: continuing ${spec.itemName} prospecting ` +
            `after a complete search pattern found none`,
          position: floorPosition(this.bot.entity.position),
          dimension: String(this.bot.game?.dimension ?? "unknown"),
          importance: 6
        });
        return;
      }
      this.blockProject(
        project,
        `Exhausted ${Math.max(1, state.rebases ?? 0) + 1} bounded ` +
          `search patterns without reaching ${spec.targetCount} ${spec.itemName}`
      );
      return;
    }

    const routeCursor =
      state.routeIndex === 0
        ? state.tunnelOrigin
        : route[state.routeIndex - 1];
    if (routeCursor && distanceBetween(this.bot.entity.position, routeCursor) > 2) {
      this.report(
        "working",
        "Returning to the saved branch-mine cursor",
        `Route ${state.routeIndex + 1}/${route.length}`
      );
      await this.movement.goNear(routeCursor, 1, 20_000);
      return;
    }

    this.report(
      "working",
      `Branch mining at Y ${spec.targetY}`,
      `${count}/${spec.targetCount} ${spec.itemName.replaceAll("_", " ")}; ` +
        `route ${state.routeIndex + 1}/${route.length}`
    );
    try {
      const excavated = await this.mining.excavateAndEnter(next);
      appendTraversalCell(
        state.traversal,
        floorPosition(this.bot.entity.position)
      );
      state.excavatedBlocks += excavated;
      if (
        (state.routeIndex + 1) % spec.torchSpacing === 0 &&
        state.routeIndex > 0
      ) {
        await this.building.placeOnFloor(route[state.routeIndex - 1]!, "torch");
      }
      state.routeIndex += 1;
      state.failures = 0;
      this.memory.saveProject(project);
    } catch (error) {
      const settled = this.bot.entity.position.floored();
      const floor = this.perception.blockAt(settled.offset(0, -1, 0));
      if (
        Math.abs(settled.y - next.y) <= 2 &&
        Math.hypot(settled.x - next.x, settled.z - next.z) <= 2 &&
        floor &&
        isSolid(floor.name, floor.boundingBox) &&
        (state.rebases ?? 0) < MAX_PROSPECT_REBASES
      ) {
        state.failures = (state.failures ?? 0) + 1;
        if (state.failures < 3) {
          this.memory.saveProject(project);
          console.warn(
            `[prospect] Retrying opened route cell ${next.x}, ${next.y}, ` +
              `${next.z} (${state.failures}/3)`
          );
          return;
        }
        this.rebaseProspectRoute(project, state, spec, settled);
        return;
      }
      state.failures += 1;
      this.memory.saveProject(project);
      if (state.failures >= 3) {
        const message = error instanceof Error ? error.message : String(error);
        this.blockProject(project, `Prospecting route is blocked: ${message}`);
      } else {
        throw error;
      }
    }
  }

  private resumeRecoverableProject(): ProjectPlan | undefined {
    const project = this.memory.latestProject();
    if (
      !project ||
      project.status !== "blocked"
    ) {
      return undefined;
    }
    const step = project.steps[project.currentStepIndex];
    if (!step) return undefined;
    if (
      project.statusReason?.includes("no pickaxe") &&
      !this.hasPickaxe() &&
      rewindProjectForInventoryLoss(project)
    ) {
      const resumed = this.memory.saveProject(project);
      this.telemetry.record({
        kind: "project_recovery",
        summary:
          `${project.title}: replaying its authored supply chain after ` +
          "inventory loss",
        importance: 9
      });
      return resumed;
    }
    if (
      step.spec.kind === "craft_item" &&
      project.statusReason?.startsWith("No current recipe for ")
    ) {
      const state = step.state as { recoveryAttempts?: number };
      if ((state.recoveryAttempts ?? 0) >= 3) return undefined;
      state.recoveryAttempts = (state.recoveryAttempts ?? 0) + 1;
      step.status = "pending";
      step.statusReason = undefined;
      project.status = "active";
      project.statusReason = undefined;
      const resumed = this.memory.saveProject(project);
      this.telemetry.record({
        kind: "project_recovery",
        summary:
          `${project.title}: retrying ${step.title} through its planned ` +
          `material producers (${state.recoveryAttempts}/3)`,
        importance: 8
      });
      return resumed;
    }
    if (
      step.spec.kind !== "prospect_resource" ||
      !project.statusReason?.startsWith("Prospecting route is blocked:")
    ) {
      return undefined;
    }
    const state = step.state as ProspectState;
    if ((state.rebases ?? 0) >= MAX_PROSPECT_REBASES) return undefined;
    const settled = this.bot.entity.position.floored();
    const floor = this.perception.blockAt(settled.offset(0, -1, 0));
    if (!floor || !isSolid(floor.name, floor.boundingBox)) return undefined;

    this.rebaseProspectRoute(project, state, step.spec, settled);
    step.status = "pending";
    step.statusReason = undefined;
    project.status = "active";
    project.statusReason = undefined;
    const resumed = this.memory.saveProject(project);
    this.telemetry.record({
      kind: "project_recovery",
      summary:
        `${project.title}: rebased a blocked prospect route at ` +
        `${settled.x}, ${settled.y}, ${settled.z}`,
      importance: 8
    });
    return resumed;
  }

  private rebaseProspectRoute(
    project: ProjectPlan,
    state: ProspectState,
    spec: Extract<ProjectStep["spec"], { kind: "prospect_resource" }>,
    settled: Vec3
  ): void {
    state.tunnelOrigin = {
      x: settled.x,
      y: settled.y,
      z: settled.z
    };
    state.routeHeading = rotateHeading(
      state.routeHeading ?? spec.heading
    );
    state.route = createBranchMineRoute(
      state.tunnelOrigin,
      spec.maxTunnelBlocks,
      spec.branchLength,
      spec.branchSpacing,
      state.routeHeading
    );
    state.routeIndex = 0;
    state.failures = 0;
    state.rebases = (state.rebases ?? 0) + 1;
    if (state.traversal) {
      appendTraversalCell(state.traversal, settled);
    }
    this.memory.saveProject(project);
    console.log(
      `[prospect] Rebased branch route at ${settled.x}, ${settled.y}, ` +
        `${settled.z}, now heading ${state.routeHeading} ` +
        `(${state.rebases}/${MAX_PROSPECT_REBASES})`
    );
  }

  private findVisibleOre(oreBlockNames: string[]) {
    this.perception.observe();
    const origin = this.bot.entity.position.floored();
    const candidates = [];
    for (let dx = -5; dx <= 5; dx += 1) {
      for (let dy = -3; dy <= 3; dy += 1) {
        for (let dz = -5; dz <= 5; dz += 1) {
          const visible = this.perception.inspectVisibleBlock(
            origin.x + dx,
            origin.y + dy,
            origin.z + dz
          );
          if (
            visible &&
            oreBlockNames.includes(visible.name) &&
            !isCurrentSupportBlock(origin, visible)
          ) {
            candidates.push(visible);
          }
        }
      }
    }
    const nearest = candidates.sort((a, b) => {
      const aBlock = this.perception.blockAt(new Vec3(a.x, a.y, a.z));
      const bBlock = this.perception.blockAt(new Vec3(b.x, b.y, b.z));
      const aReachable = aBlock ? this.mining.canMine(a) : false;
      const bReachable = bBlock ? this.mining.canMine(b) : false;
      if (aReachable !== bReachable) return aReachable ? -1 : 1;
      return a.distance - b.distance;
    })[0];
    if (!nearest) return undefined;
    const block = this.perception.blockAt(
      new Vec3(nearest.x, nearest.y, nearest.z)
    );
    return block && this.mining.canMine(nearest) ? nearest : undefined;
  }

  private async ensureMiningFood(
    project: ProjectPlan,
    state: ProspectState
  ): Promise<boolean> {
    if (
      this.survival.snapshot().food >= 18 &&
      safeFoodCount(this.inventory) >= 3
    ) {
      state.forageOrigin = undefined;
      state.forageWaypoint = undefined;
      state.forageTargetId = undefined;
      state.forageTargetPosition = undefined;
      return false;
    }

    if (
      state.surfaceOrigin &&
      distanceBetween(this.bot.entity.position, state.surfaceOrigin) > 4
    ) {
      const traversal = await this.followRecordedTraversal(project);
      if (traversal === "progress") return true;
      if (traversal === "blocked") {
        this.blockProject(
          project,
          "Food reserves are low and the recorded surface route is blocked"
        );
        return true;
      }
    }

    const snapshot = this.perception.observe();
    const visibleFoodTarget = snapshot.visibleEntities
      .filter((entity) => foodAnimalPriority(entity.name) > 0)
      .map((visible) => this.perception.entityById(visible.id))
      .filter(
        (entity): entity is Entity =>
          entity !== undefined &&
          entity.isValid &&
          entity.height >= 0.8
      )
      .sort(
        (a, b) =>
          foodAnimalPriority(b.name ?? "") -
            foodAnimalPriority(a.name ?? "") ||
          this.bot.entity.position.distanceTo(a.position) -
            this.bot.entity.position.distanceTo(b.position)
      )[0];
    const rememberedTarget = state.forageTargetId
      ? this.perception.entityById(state.forageTargetId)
      : undefined;
    const target =
      rememberedTarget?.isValid
        ? rememberedTarget
        : visibleFoodTarget;

    if (!target && state.forageTargetPosition) {
      if (
        distanceBetween(
          this.bot.entity.position,
          state.forageTargetPosition
        ) > 2
      ) {
        this.report(
          "working",
          "Collecting food drops",
          "Returning to the last visible animal"
        );
        await this.movement.goNear(state.forageTargetPosition, 1, 15_000);
        return true;
      }
      state.forageTargetId = undefined;
      state.forageTargetPosition = undefined;
      this.memory.saveProject(project);
      await delay(750);
      return true;
    }

    if (target) {
      state.forageTargetId = target.id;
      state.forageTargetPosition = floorPosition(target.position);
      this.memory.saveProject(project);
      this.report(
        "working",
        `Hunting visible ${target.name ?? "animal"} for food`,
        `${safeFoodCount(this.inventory)}/3 reserve items`
      );
      const engagement = this.combat.engageVisibleMob(
        target.id,
        "A project requested visible food acquisition"
      );
      if (engagement === "unavailable" || engagement === "rejected") {
        state.forageTargetId = undefined;
        state.forageTargetPosition = undefined;
        this.memory.saveProject(project);
      }
      return true;
    }

    state.forageOrigin ??=
      project.anchor ??
      state.surfaceOrigin ??
      floorPosition(this.bot.entity.position);
    state.forageWaypoint ??= 0;
    const offset = spiralOffset(state.forageWaypoint);
    state.forageWaypoint += 1;
    this.memory.saveProject(project);
    const waypoint = {
      x: state.forageOrigin.x + offset.x * 12,
      y: Math.floor(this.bot.entity.position.y),
      z: state.forageOrigin.z + offset.z * 12
    };
    this.report(
      "working",
      "Searching visibly for food animals",
      `Waypoint ${state.forageWaypoint}`
    );
    const movement = await this.movement.reachSurfaceArea(waypoint, 4);
    if (movement.status === "blocked") {
      console.warn(
        `[project] Food search movement failed: ${movement.detail}`
      );
    }
    return true;
  }

  private calibrateStaircaseHeight(
    state: ProspectState,
    heading: "north" | "south" | "east" | "west"
  ): void {
    if (!state.surfaceOrigin || !state.descentIndex) return;
    const current = this.bot.entity.position.floored();
    const forward = headingVector(heading);
    const side = { x: forward.z, z: -forward.x };
    const dx = current.x - state.surfaceOrigin.x;
    const dz = current.z - state.surfaceOrigin.z;
    const depth = dx * forward.x + dz * forward.z;
    const lateral = Math.abs(dx * side.x + dz * side.z);
    if (
      lateral > 1 ||
      depth < 0 ||
      depth > state.descentIndex ||
      Math.abs(current.y + depth - state.surfaceOrigin.y) > 2
    ) {
      return;
    }
    const inferredSurfaceY = current.y + depth;
    if (inferredSurfaceY !== state.surfaceOrigin.y) {
      console.log(
        `[prospect] Calibrated staircase surface Y from ` +
          `${state.surfaceOrigin.y} to ${inferredSurfaceY}`
      );
      state.surfaceOrigin.y = inferredSurfaceY;
    }
  }

  private hasPickaxe(): boolean {
    return this.inventory
      .items()
      .some((item) => item.name.endsWith("_pickaxe"));
  }

  private async craftEmergencyStonePickaxe(
    project: ProjectPlan,
    relativeTable: RelativePosition | undefined,
    state: ProspectState,
    _heading: "north" | "south" | "east" | "west"
  ): Promise<EmergencyToolResult> {
    if (this.inventory.count("stick") < 2) {
      await this.production.craftOne("stick");
    }
    if (
      this.inventory.count("cobblestone") < 3 ||
      this.inventory.count("stick") < 2 ||
      !state.surfaceOrigin
    ) {
      return "impossible";
    }
    const current = this.bot.entity.position.floored();
    const awayFromSurface =
      distanceBetween(current, state.surfaceOrigin) > 4;
    let localTable = this.findNearbyCraftingTable(4);
    if (!localTable) {
      const rememberedTable = this.rememberedPortableCraftingTable(project);
      if (rememberedTable) {
        if (distanceBetween(this.bot.entity.position, rememberedTable.position) > 4) {
          this.report(
            "working",
            "Returning to the portable workshop",
            `${Math.ceil(
              distanceBetween(this.bot.entity.position, rememberedTable.position)
            )} blocks away`
          );
          await this.movement.goNear(rememberedTable.position, 3);
          return "working";
        }
        localTable = rememberedTable;
      }
    }
    if (!localTable && awayFromSurface) {
      localTable = await this.installPortableCraftingTable();
      if (localTable) {
        state.portableTable = {
          x: localTable.position.x,
          y: localTable.position.y,
          z: localTable.position.z
        };
        this.memory.saveProject(project);
      }
    }
    if (localTable) {
      const result = await this.production.craftOne("stone_pickaxe", localTable);
      if (result.status === "unavailable") return "impossible";
      return this.hasPickaxe() ? "crafted" : "impossible";
    }
    if (!project.anchor) return "impossible";
    if (awayFromSurface) {
      const traversal = await this.followRecordedTraversal(project);
      if (traversal === "progress" || traversal === "complete") {
        return "working";
      }
      return "impossible";
    }
    await this.movement.goNear(project.anchor, 4, 20_000);
    let table = relativeTable
      ? this.blockAtRelative(project, relativeTable)
      : undefined;
    if (!table || table.name !== "crafting_table") {
      for (let dx = -4; dx <= 4 && !table; dx += 1) {
        for (let dz = -4; dz <= 4 && !table; dz += 1) {
          const candidate = this.perception.blockAt(
            new Vec3(project.anchor.x + dx, project.anchor.y, project.anchor.z + dz)
          );
          if (candidate?.name === "crafting_table") table = candidate;
        }
      }
    }
    if (!table || table.name !== "crafting_table") return "impossible";
    const result = await this.production.craftOne("stone_pickaxe", table);
    if (result.status === "unavailable") return "impossible";
    return this.hasPickaxe() ? "crafted" : "impossible";
  }

  private rememberedPortableCraftingTable(project: ProjectPlan) {
    for (const step of project.steps) {
      const position = (step.state as ProspectState).portableTable;
      if (!position) continue;
      const block = this.perception.blockAt(
        new Vec3(position.x, position.y, position.z)
      );
      if (block?.name === "crafting_table") return block;
    }
    return undefined;
  }

  private findNearbyCraftingTable(radius: number) {
    const origin = this.bot.entity.position.floored();
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          const block = this.perception.blockAt(origin.offset(dx, dy, dz));
          if (block?.name === "crafting_table") return block;
        }
      }
    }
    return undefined;
  }

  private async installPortableCraftingTable() {
    let tableItem = this.inventory
      .items()
      .find((item) => item.name === "crafting_table");
    if (!tableItem) {
      const result = await this.production.craftOne("crafting_table");
      if (result.status === "unavailable") return undefined;
      tableItem = this.inventory
        .items()
        .find((item) => item.name === "crafting_table");
    }
    if (!tableItem) return undefined;

    const placed = await this.building.placeNearby("crafting_table");
    if (placed.status === "blocked") return undefined;
    console.log(
      `[prospect] Installed portable crafting table at ` +
        `${placed.position.x}, ${placed.position.y}, ${placed.position.z}`
    );
    return placed.block;
  }

  private async stepToAdjacentCell(
    target: Position,
    jump: boolean
  ): Promise<void> {
    await this.movement.stepToAdjacent(target, jump);
  }

  private async enterStairLanding(position: Position): Promise<void> {
    const current = this.bot.entity.position.floored();
    if (
      current.y === position.y &&
      Math.abs(current.x - position.x) + Math.abs(current.z - position.z) === 1
    ) {
      await this.stepToAdjacentCell(position, false);
      return;
    }
    await this.moveToExactCell(position);
  }

  private async moveToExactCell(position: Position): Promise<void> {
    await this.movement.goNear(position, 0, 12_000);
    const reached = this.bot.entity.position.floored();
    if (!reached.equals(new Vec3(position.x, position.y, position.z))) {
      throw new Error(
        `exact movement reached ${reached.x},${reached.y},${reached.z} ` +
          `instead of ${position.x},${position.y},${position.z}`
      );
    }
  }

  private executeInventoryVerification(
    project: ProjectPlan,
    spec: Extract<ProjectStep["spec"], { kind: "verify_inventory" }>
  ): void {
    const count = this.inventory.count(spec.itemName);
    if (count < spec.minimumCount) {
      this.blockProject(
        project,
        `Inventory verification failed: ${count}/${spec.minimumCount} ${spec.itemName}`
      );
      return;
    }
    this.finishStep(
      project,
      `Verified ${count} ${spec.itemName} in inventory`
    );
  }

  private async executeDeposit(
    project: ProjectPlan,
    step: ProjectStep,
    spec: Extract<ProjectStep["spec"], { kind: "deposit_item" }>
  ): Promise<void> {
    const state = step.state as { deposited?: number };
    if ((state.deposited ?? 0) >= spec.minimumCount) {
      this.finishStep(
        project,
        `Stored ${state.deposited} ${spec.itemName} in owned storage`
      );
      return;
    }
    if (!project.anchor) {
      this.blockProject(project, "Storage deposit has no project anchor");
      return;
    }
    const position = absolutePosition(project.anchor, spec.containerAt);
    const initialDistance = distanceBetween(
      this.bot.entity.position,
      position
    );
    if (initialDistance > 4.5) {
      const traversal = await this.followRecordedTraversal(project);
      if (traversal === "progress") return;
      if (traversal === "blocked") {
        this.blockProject(
          project,
          "Recorded return route to storage is blocked"
        );
        return;
      }
    }

    const distance = distanceBetween(this.bot.entity.position, position);
    if (distance > 16) {
      this.report(
        "working",
        "Returning to the storage site",
        `${Math.ceil(distance)} blocks from the owned container`
      );
      const result = await this.movement.reachSurfaceArea(project.anchor, 4);
      if (result.status === "blocked") throw new Error(result.detail);
      return;
    }
    if (distance > 4.5) {
      this.report(
        "working",
        "Returning to owned storage",
        `${Math.ceil(distance)} blocks away`
      );
      await this.movement.goNear(position, 2, 30_000);
      return;
    }

    this.perception.observe();
    const before = this.inventory.count(spec.itemName);
    if (before < spec.minimumCount - (state.deposited ?? 0)) {
      this.blockProject(
        project,
        `Storage deposit requires ${spec.minimumCount} ${spec.itemName}; ` +
          `${before} remain in inventory`
      );
      return;
    }
    const result = await this.storage.deposit(position, spec.itemName);
    if (result.status === "blocked") {
      throw new Error(result.detail);
    }
    const deposited = Math.max(
      0,
      before - this.inventory.count(spec.itemName)
    );
    if (deposited === 0) {
      throw new Error(`No ${spec.itemName} was transferred to storage`);
    }
    state.deposited = (state.deposited ?? 0) + deposited;
    const container = this.memory
      .ownedContainers(String(this.bot.game?.dimension))
      .find(
        (candidate) =>
          candidate.position.x === position.x &&
          candidate.position.y === position.y &&
          candidate.position.z === position.z
      );
    if (container) {
      this.memory.recordContainerDeposit(
        container.id,
        spec.itemName,
        deposited
      );
    }
    this.memory.saveProject(project);
  }

  private async executePlacements(
    project: ProjectPlan,
    step: ProjectStep,
    spec: Extract<ProjectStep["spec"], { kind: "place_blueprint" }>
  ): Promise<void> {
    if (!project.anchor) {
      this.blockProject(project, "Blueprint has no selected anchor");
      return;
    }
    const state = step.state as PlacementState;
    state.completed ??= [];
    state.failures ??= {};
    const completed = new Set(state.completed);

    for (const [index, placement] of spec.placements.entries()) {
      if (completed.has(index)) continue;
      const target = absolutePosition(project.anchor, placement);
      const existing = this.perception.blockAt(new Vec3(target.x, target.y, target.z));
      if (existing && placement.expectedBlockNames.includes(existing.name)) {
        state.completed.push(index);
        this.memory.saveProject(project);
        return;
      }
      try {
        if (
          placement.itemName === "furnace" &&
          distanceBetween(this.bot.entity.position, target) > 16
        ) {
          const previousLocation = relativeKey(placement);
          const placed = await this.building.placeNearby("furnace");
          if (placed.status !== "blocked") {
            placement.dx = placed.position.x - project.anchor.x;
            placement.dy = placed.position.y - project.anchor.y;
            placement.dz = placed.position.z - project.anchor.z;
            for (const laterStep of project.steps.slice(project.currentStepIndex + 1)) {
              if (
                laterStep.spec.kind === "smelt_item" &&
                relativeKey(laterStep.spec.furnaceAt) === previousLocation
              ) {
                laterStep.spec.furnaceAt = {
                  dx: placement.dx,
                  dy: placement.dy,
                  dz: placement.dz
                };
              }
            }
            state.completed.push(index);
            delete state.failures[String(index)];
            this.memory.saveProject(project);
            console.log(
              `[project] Relocated utility furnace to ` +
                `${placed.position.x}, ${placed.position.y}, ${placed.position.z}`
            );
            return;
          }
        }
        const result = await this.building.placeAt(project.anchor, placement);
        if (result.status === "blocked") throw new Error(result.detail);
        state.completed.push(index);
        delete state.failures[String(index)];
        this.memory.saveProject(project);
      } catch (error) {
        const key = String(index);
        state.failures[key] = (state.failures[key] ?? 0) + 1;
        this.memory.saveProject(project);
        const message = error instanceof Error ? error.message : String(error);
        if (state.failures[key] >= 5) {
          this.blockProject(
            project,
            `Could not place ${placement.itemName} at ${relativeKey(placement)}: ${message}`
          );
        }
      }
      return;
    }
    this.finishStep(project, `Placed ${spec.placements.length} planned blocks`);
  }

  private async executeVerification(
    project: ProjectPlan,
    step: ProjectStep,
    spec: Extract<ProjectStep["spec"], { kind: "verify_structure" }>
  ): Promise<void> {
    if (!project.anchor) {
      this.blockProject(project, "Verification has no project anchor");
      return;
    }
    for (const check of spec.checks) {
      const error = this.verifyCheck(project, check);
      if (error) {
        this.blockProject(project, `${structureCheckLabel(check)} failed: ${error}`);
        return;
      }
    }
    this.finishStep(project, "All deterministic structure checks passed");
  }

  private verifyCheck(
    project: ProjectPlan,
    check: StructureCheck
  ): string | undefined {
    const anchor = project.anchor!;
    if (check.kind === "blueprint_complete") {
      for (const step of project.steps) {
        if (step.spec.kind !== "place_blueprint") continue;
        for (const placement of step.spec.placements) {
          const block = this.blockAtRelative(project, placement);
          if (!block || !placement.expectedBlockNames.includes(block.name)) {
            return `${relativeKey(placement)} is ${block?.name ?? "unloaded"}`;
          }
        }
      }
      return undefined;
    }
    if (check.kind === "roofed_area") {
      for (let dx = check.min.dx; dx <= check.max.dx; dx += 1) {
        for (let dz = check.min.dz; dz <= check.max.dz; dz += 1) {
          const block = this.perception.blockAt(
            new Vec3(anchor.x + dx, anchor.y + check.roofY, anchor.z + dz)
          );
          if (!isSolid(block?.name, block?.boundingBox)) {
            return `roof gap at ${dx},${check.roofY},${dz}`;
          }
        }
      }
      return undefined;
    }
    if (check.kind === "boundary_closed") {
      const openings = new Set(check.openings.map(relativeKey));
      for (let dy = check.minY; dy <= check.maxY; dy += 1) {
        for (let dx = check.min.dx; dx <= check.max.dx; dx += 1) {
          for (let dz = check.min.dz; dz <= check.max.dz; dz += 1) {
            const boundary =
              dx === check.min.dx ||
              dx === check.max.dx ||
              dz === check.min.dz ||
              dz === check.max.dz;
            if (!boundary || openings.has(`${dx},${dy},${dz}`)) continue;
            const block = this.perception.blockAt(
              new Vec3(anchor.x + dx, anchor.y + dy, anchor.z + dz)
            );
            if (!isSolid(block?.name, block?.boundingBox)) {
              return `boundary gap at ${dx},${dy},${dz}`;
            }
          }
        }
      }
      return undefined;
    }
    const block = this.blockAtRelative(project, check.at);
    return block && check.blockNames.includes(block.name)
      ? undefined
      : `expected ${check.blockNames.join("/")} at ${relativeKey(check.at)}`;
  }

  private blockAtRelative(project: ProjectPlan, position: RelativePosition) {
    if (!project.anchor) return null;
    const absolute = absolutePosition(project.anchor, position);
    return this.perception.blockAt(new Vec3(absolute.x, absolute.y, absolute.z));
  }

  private finishStep(project: ProjectPlan, reason: string): void {
    const step = project.steps[project.currentStepIndex];
    if (!step) return;
    step.status = "completed";
    step.statusReason = reason;
    project.currentStepIndex += 1;
    this.memory.saveProject(project);
    this.telemetry.record({
      kind: "project_step",
      summary: `${project.title}: ${step.title} completed - ${reason}`,
      importance: 7
    });
  }

  private completeProject(project: ProjectPlan): void {
    project.status = "completed";
    project.statusReason = project.completionSummary;
    this.memory.saveProject(project);
    if (project.goalId !== undefined) {
      this.requireTaskLifecycle().finishGoal(
        project.goalId,
        "completed",
        project.completionSummary
      );
    }
    this.telemetry.record({
      kind: "project_outcome",
      summary: `${project.title} completed: ${project.completionSummary}`,
      importance: 10
    });
    this.report("idle", "Project complete", project.completionSummary);
    console.log(`[project] Completed ${project.title}`);
    this.reportTerminal("completed", project);
  }

  private blockProject(project: ProjectPlan, reason: string): void {
    const step = project.steps[project.currentStepIndex];
    if (step) {
      step.status = "blocked";
      step.statusReason = reason;
    }
    project.status = "blocked";
    project.statusReason = reason;
    this.memory.saveProject(project);
    this.telemetry.record({
      kind: "project_outcome",
      summary: `${project.title} blocked: ${reason}`,
      importance: 9
    });
    this.report("error", "Project blocked", reason);
  }

  private reportTerminal(
    status: "completed" | "blocked",
    project: ProjectPlan
  ): void {
    const key = `${project.id}:${status}:${project.updatedAt}`;
    if (this.reportedTerminalProjects.has(key)) return;
    this.reportedTerminalProjects.add(key);
    this.onTerminal?.(status, project);
  }

  private report(
    phase: ActivityUpdate["phase"],
    label: string,
    detail?: string
  ): void {
    this.telemetry.activity("project", { phase, label, detail });
  }

  private log(key: string, message: string): void {
    if (this.lastState === key) return;
    this.lastState = key;
    console.log(message);
  }
}

export function foodAnimalPriority(name: string): number {
  switch (name.toLowerCase()) {
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

export interface BuildSiteCandidate {
  anchor: Position;
  obstructions: number;
  score: number;
}

export function selectBuildSiteCandidate(options: {
  center: Position;
  width: number;
  depth: number;
  clearanceHeight: number;
  searchRadius: number;
  maxObstructions: number;
  rejected?: Set<string>;
  blockAt: (position: Position) =>
    | { name: string; boundingBox?: string }
    | null
    | undefined;
  canMine: (position: Position) => boolean;
}): BuildSiteCandidate | undefined {
  let best: BuildSiteCandidate | undefined;
  for (let centerDx = -options.searchRadius; centerDx <= options.searchRadius; centerDx += 1) {
    for (let centerDz = -options.searchRadius; centerDz <= options.searchRadius; centerDz += 1) {
      const anchor = {
        x: options.center.x + centerDx - Math.floor(options.width / 2),
        y: options.center.y,
        z: options.center.z + centerDz - Math.floor(options.depth / 2)
      };
      if (options.rejected?.has(positionKey(anchor))) continue;
      let obstructions = 0;
      let valid = true;
      for (let dx = 0; dx < options.width && valid; dx += 1) {
        for (let dz = 0; dz < options.depth && valid; dz += 1) {
          const x = anchor.x + dx;
          const z = anchor.z + dz;
          const ground = options.blockAt({ x, y: anchor.y - 1, z });
          if (!isSolid(ground?.name, ground?.boundingBox)) {
            valid = false;
            break;
          }
          for (let dy = 0; dy < options.clearanceHeight; dy += 1) {
            const position = { x, y: anchor.y + dy, z };
            const block = options.blockAt(position);
            if (!block) {
              valid = false;
              break;
            }
            if (isReplaceableBlockName(block.name)) continue;
            if (
              block.name === "water" ||
              block.name === "lava" ||
              isProtectedExcavationBlockName(block.name) ||
              !options.canMine(position)
            ) {
              valid = false;
              break;
            }
            obstructions += 1;
            if (obstructions > options.maxObstructions) {
              valid = false;
              break;
            }
          }
        }
      }
      if (!valid) continue;
      const distance = Math.hypot(centerDx, centerDz);
      const candidate = {
        anchor,
        obstructions,
        score: distance * 4 + obstructions
      };
      if (!best || candidate.score < best.score) best = candidate;
    }
  }
  return best;
}

function positionKey(position: Position): string {
  return `${position.x},${position.y},${position.z}`;
}

function safeFoodCount(inventory: InventorySystem): number {
  const banned = new Set([
    "chorus_fruit",
    "poisonous_potato",
    "pufferfish",
    "rotten_flesh",
    "spider_eye"
  ]);
  return inventory.foodCount(banned);
}

function isSolid(
  name: string | undefined,
  boundingBox: string | undefined
): boolean {
  return Boolean(
    name &&
      !isReplaceableBlockName(name) &&
      name !== "water" &&
      name !== "lava" &&
      boundingBox === "block"
  );
}

function floorPosition(position: Vec3): Position {
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z)
  };
}

export function createBranchMineRoute(
  origin: Position,
  maxTunnelBlocks: number,
  branchLength: number,
  branchSpacing: number,
  heading: "north" | "south" | "east" | "west" = "south"
): Position[] {
  const route: Position[] = [];
  const forwardVector = headingVector(heading);
  const sideVector = { x: forwardVector.z, z: -forwardVector.x };
  let uniqueCells = 0;
  for (let forward = 1; uniqueCells < maxTunnelBlocks; forward += 1) {
    route.push({
      x: origin.x + forwardVector.x * forward,
      y: origin.y,
      z: origin.z + forwardVector.z * forward
    });
    uniqueCells += 1;
    if (forward % branchSpacing !== 0) continue;
    for (const direction of [-1, 1]) {
      let reached = 0;
      for (
        let side = 1;
        side <= branchLength && uniqueCells < maxTunnelBlocks;
        side += 1
      ) {
        route.push({
          x:
            origin.x +
            forwardVector.x * forward +
            sideVector.x * direction * side,
          y: origin.y,
          z:
            origin.z +
            forwardVector.z * forward +
            sideVector.z * direction * side
        });
        reached = side;
        uniqueCells += 1;
      }
      for (let side = reached - 1; side >= 0; side -= 1) {
        route.push({
          x:
            origin.x +
            forwardVector.x * forward +
            sideVector.x * direction * side,
          y: origin.y,
          z:
            origin.z +
            forwardVector.z * forward +
            sideVector.z * direction * side
        });
      }
    }
  }
  return route;
}

function headingVector(
  heading: "north" | "south" | "east" | "west"
): { x: number; z: number } {
  switch (heading) {
    case "north":
      return { x: 0, z: -1 };
    case "east":
      return { x: 1, z: 0 };
    case "west":
      return { x: -1, z: 0 };
    case "south":
      return { x: 0, z: 1 };
  }
}

function rotateHeading(
  heading: "north" | "south" | "east" | "west"
): "north" | "south" | "east" | "west" {
  switch (heading) {
    case "north":
      return "east";
    case "east":
      return "south";
    case "south":
      return "west";
    case "west":
      return "north";
  }
}

function distanceBetween(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
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
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`Movement timed out after ${milliseconds / 1_000} seconds`));
        }, milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
