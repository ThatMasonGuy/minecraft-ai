import type { AcquisitionSystem } from "./acquisition-system.js";
import type { InventorySystem } from "./inventory-system.js";
import type { EpisodicMemory } from "./memory.js";
import {
  validateProjectSemantics
} from "./project-plan.js";
import type { ProjectSystem } from "./project-system.js";
import type { TaskLifecycle } from "./task-lifecycle.js";
import type { RecoverySystem } from "./recovery-system.js";
import type {
  GatherBlocksWorkSpec,
  ProjectPlan,
  ProjectPlanDraft,
  TaskOrigin,
  WorkOrder
} from "./types.js";

export interface TaskStatus {
  activeWorkOrder: WorkOrder | null;
  activeProject: ProjectPlan | null;
  recoveryActive: boolean;
}

export interface GatherDelegation {
  goalId?: number;
  itemName: string;
  minimumCount: number;
  continuation: GatherBlocksWorkSpec["continuation"];
  dimension: string;
}

export interface CancelledTask {
  type: "work_order" | "project";
  id: number;
}

export class TaskSystemError extends Error {}

export class TaskSystem implements TaskLifecycle {
  constructor(
    private readonly memory: EpisodicMemory,
    private readonly inventory: InventorySystem,
    private readonly acquisition: AcquisitionSystem,
    private readonly projects: ProjectSystem,
    private readonly recovery: RecoverySystem
  ) {
    this.acquisition.setTaskLifecycle(this);
    this.projects.setTaskLifecycle(this);
  }

  start(): void {
    this.recovery.start();
    this.acquisition.start();
    this.projects.start();
  }

  stop(): void {
    this.projects.stop();
    this.acquisition.stop();
    this.recovery.stop();
  }

  status(): TaskStatus {
    return {
      activeWorkOrder: this.memory.activeWorkOrder() ?? null,
      activeProject: this.memory.activeProject() ?? null,
      recoveryActive: this.recovery.isActive()
    };
  }

  hasActiveDeterministicTask(): boolean {
    const status = this.status();
    return Boolean(
      status.activeWorkOrder || status.activeProject || status.recoveryActive
    );
  }

  submitGather(
    spec: GatherBlocksWorkSpec,
    origin: TaskOrigin = "planner"
  ): WorkOrder {
    if (this.memory.activeProject()) {
      throw new TaskSystemError(
        "A project is active; cancel it before submitting a standalone work order"
      );
    }
    const order = this.memory.createGatherBlocksWorkOrder(
      spec,
      this.inventory.count(spec.itemName),
      origin
    );
    this.recordSubmission(origin, "gather", order.id, spec);
    return order;
  }

  submitProjectGather(
    spec: GatherBlocksWorkSpec,
    origin: TaskOrigin
  ): WorkOrder {
    const project = this.memory.activeProject();
    if (!project) {
      throw new TaskSystemError("Project material acquisition requires an active project");
    }
    const order = this.memory.createGatherBlocksWorkOrder(
      spec,
      this.inventory.count(spec.itemName),
      origin
    );
    this.recordSubmission(origin, "gather", order.id, {
      ...spec,
      parentProjectId: project.id
    });
    return order;
  }

  finishWorkOrder(
    id: number,
    status: "completed" | "blocked" | "cancelled",
    reason: string
  ): WorkOrder {
    return this.memory.updateWorkOrderStatus(id, status, reason);
  }

  delegateGather(
    request: GatherDelegation,
    origin: TaskOrigin = "planner"
  ): WorkOrder {
    const blockNames = deterministicGatherSources(request.itemName);
    if (blockNames.length === 0) {
      throw new TaskSystemError(
        `No deterministic gather-source rule exists for ${request.itemName}`
      );
    }
    const ownedStorage = this.memory.ownedContainers(request.dimension)[0];
    return this.submitGather(
      {
        goalId: request.goalId,
        itemName: request.itemName,
        blockNames,
        minimumCount: request.minimumCount,
        continuation: request.continuation,
        storage: ownedStorage
          ? { mode: "container", position: ownedStorage.position }
          : { mode: "inventory" }
      },
      origin
    );
  }

  submitProject(
    draft: ProjectPlanDraft,
    origin: TaskOrigin = "planner"
  ): ProjectPlan {
    const semanticErrors = validateProjectSemantics(draft);
    if (semanticErrors.length > 0) {
      throw new TaskSystemError(semanticErrors.join("; "));
    }
    const project = this.memory.createProjectPlan(draft, origin);
    this.recordSubmission(origin, "project", project.id, draft);
    return project;
  }

  cancel(reason: string, origin: TaskOrigin = "operator"): CancelledTask[] {
    const workOrder = this.memory.activeWorkOrder();
    const project = this.memory.activeProject();
    const cancelled: CancelledTask[] = [];
    if (workOrder) {
      this.memory.updateWorkOrderStatus(workOrder.id, "cancelled", reason);
      cancelled.push({ type: "work_order", id: workOrder.id });
    }
    if (project) {
      project.status = "cancelled";
      project.statusReason = reason;
      this.memory.saveProject(project);
      cancelled.push({ type: "project", id: project.id });
    }
    this.memory.record({
      kind: origin === "operator" ? "operator_task_cancelled" : "task_cancelled",
      summary:
        cancelled.length > 0
          ? `${origin} cancelled ${cancelled.length} active deterministic task(s)`
          : `${origin} requested cancellation with no active deterministic task`,
      payload: { reason, cancelled, origin },
      actor: origin,
      importance: 7
    });
    return cancelled;
  }

  private recordSubmission(
    origin: TaskOrigin,
    taskType: "gather" | "project",
    id: number,
    input: unknown
  ): void {
    this.memory.record({
      kind: origin === "operator" ? "operator_task" : "planner_task",
      summary: `${origin} submitted ${taskType} task ${id}`,
      payload: { taskType, taskId: id, input, origin },
      actor: origin,
      importance: 8
    });
  }
}

export function deterministicGatherSources(itemName: string): string[] {
  const explicit: Record<string, string[]> = {
    cobblestone: ["stone"],
    dirt: ["dirt", "grass_block"],
    coal: ["coal_ore", "deepslate_coal_ore"],
    raw_iron: ["iron_ore", "deepslate_iron_ore"],
    raw_copper: ["copper_ore", "deepslate_copper_ore"],
    raw_gold: ["gold_ore", "deepslate_gold_ore"],
    diamond: ["diamond_ore", "deepslate_diamond_ore"],
    emerald: ["emerald_ore", "deepslate_emerald_ore"],
    redstone: ["redstone_ore", "deepslate_redstone_ore"],
    lapis_lazuli: ["lapis_ore", "deepslate_lapis_ore"],
    flint: ["gravel"]
  };
  if (explicit[itemName]) return explicit[itemName];
  if (
    itemName.endsWith("_log") ||
    itemName.endsWith("_stem") ||
    itemName.endsWith("_wood") ||
    itemName.endsWith("_hyphae") ||
    ["sand", "gravel", "clay", "netherrack", "end_stone"].includes(itemName)
  ) {
    return [itemName];
  }
  return [];
}
