import { z } from "zod";
import type { EpisodicMemory } from "./memory.js";
import {
  parseProjectPlanDraft,
  validateProjectSemantics
} from "./project-plan.js";
import type { GatherBlocksWorkSpec, ProjectPlanDraft } from "./types.js";

const positionSchema = z.object({
  x: z.number().int(),
  y: z.number().int().min(-64).max(320),
  z: z.number().int()
});

export const operatorGatherTaskSchema = z.object({
  goalId: z.number().int().positive().optional(),
  itemName: z.string().min(1).max(128),
  blockNames: z.array(z.string().min(1).max(128)).min(1).max(32),
  minimumCount: z.number().int().min(1).max(100_000),
  continuation: z
    .enum(["stop_at_minimum", "until_replaced"])
    .default("stop_at_minimum"),
  storage: z
    .discriminatedUnion("mode", [
      z.object({ mode: z.literal("inventory") }),
      z.object({ mode: z.literal("container"), position: positionSchema })
    ])
    .default({ mode: "inventory" })
});

const cancelSchema = z.object({
  reason: z.string().min(1).max(500).default("Cancelled by local operator")
});

const planSchema = z.object({
  task: z.string().min(1).max(4_000)
});

export class OperatorInputError extends Error {}

export interface OperatorControlOptions {
  memory: EpisodicMemory;
  inventoryCount: (itemName: string) => number;
  requestPlanning: (task: string) => void;
  plannerMode: "manual" | "automatic";
  toolMode: "dry_run" | "execute";
  model: string;
}

export class OperatorControl {
  constructor(private readonly options: OperatorControlOptions) {}

  status(): object {
    return {
      plannerMode: this.options.plannerMode,
      toolMode: this.options.toolMode,
      model: this.options.model,
      activeWorkOrder: this.options.memory.activeWorkOrder() ?? null,
      activeProject: this.options.memory.activeProject() ?? null
    };
  }

  usage(): object {
    return this.options.memory.apiUsageSummary();
  }

  submitGather(input: unknown): object {
    const spec = operatorGatherTaskSchema.parse(input) as GatherBlocksWorkSpec;
    if (this.options.memory.activeProject()) {
      throw new OperatorInputError(
        "A project is active; cancel it before submitting a standalone work order"
      );
    }
    const beforeCalls = this.options.memory.apiUsageSummary().lifetime.calls;
    const order = this.options.memory.createGatherBlocksWorkOrder(
      spec,
      this.options.inventoryCount(spec.itemName),
      "operator"
    );
    this.options.memory.record({
      kind: "operator_task",
      summary: `Operator submitted gather work order ${order.id}: ${spec.minimumCount} ${spec.itemName}`,
      payload: { taskType: "gather", workOrderId: order.id, spec },
      actor: "operator",
      importance: 8
    });
    return {
      paidApiCalls: this.options.memory.apiUsageSummary().lifetime.calls - beforeCalls,
      workOrder: order
    };
  }

  submitProject(input: unknown): object {
    const draft = parseProjectPlanDraft(input);
    assertProjectSemantics(draft);
    const beforeCalls = this.options.memory.apiUsageSummary().lifetime.calls;
    const project = this.options.memory.createProjectPlan(draft, "operator");
    this.options.memory.record({
      kind: "operator_task",
      summary: `Operator submitted project ${project.id}: ${project.title}`,
      payload: { taskType: "project", projectId: project.id, draft },
      actor: "operator",
      importance: 8
    });
    return {
      paidApiCalls: this.options.memory.apiUsageSummary().lifetime.calls - beforeCalls,
      project
    };
  }

  cancel(input: unknown): object {
    const { reason } = cancelSchema.parse(input);
    const workOrder = this.options.memory.activeWorkOrder();
    const project = this.options.memory.activeProject();
    const cancelled: Array<{ type: "work_order" | "project"; id: number }> = [];
    if (workOrder) {
      this.options.memory.updateWorkOrderStatus(workOrder.id, "cancelled", reason);
      cancelled.push({ type: "work_order", id: workOrder.id });
    }
    if (project) {
      project.status = "cancelled";
      project.statusReason = reason;
      this.options.memory.saveProject(project);
      cancelled.push({ type: "project", id: project.id });
    }
    this.options.memory.record({
      kind: "operator_task_cancelled",
      summary:
        cancelled.length > 0
          ? `Operator cancelled ${cancelled.length} active deterministic task(s)`
          : "Operator requested cancellation with no active deterministic task",
      payload: { reason, cancelled },
      actor: "operator",
      importance: 7
    });
    return { cancelled };
  }

  requestPlan(input: unknown): object {
    const { task } = planSchema.parse(input);
    if (
      this.options.memory.activeProject() ||
      this.options.memory.activeWorkOrder()
    ) {
      throw new OperatorInputError(
        "A deterministic task is active; cancel it before requesting paid planning"
      );
    }
    this.options.memory.record({
      kind: "operator_planning_request",
      summary: `Operator explicitly requested one paid planning turn: ${task.slice(0, 300)}`,
      payload: { task },
      actor: "operator",
      importance: 8
    });
    this.options.requestPlanning(
      `Local operator explicitly requested planning: ${task}`
    );
    return {
      accepted: true,
      paid: true,
      note:
        this.options.toolMode === "dry_run"
          ? "Dry-run mode uses one API request and records proposals without executing tools."
          : "Execute mode may use one initial API call plus configured tool continuations."
    };
  }
}

function assertProjectSemantics(draft: ProjectPlanDraft): void {
  const errors = validateProjectSemantics(draft);
  if (errors.length > 0) throw new OperatorInputError(errors.join("; "));
}
