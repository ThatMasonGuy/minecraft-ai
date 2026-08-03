import crypto from "node:crypto";
import { z } from "zod";
import {
  API_REQUEST_ROLES,
  API_TRIGGER_SOURCES,
  API_WORKLOAD_TYPES,
  type ApiUsageFilters
} from "./api-usage.js";
import type { PlanningAttribution } from "./agent.js";
import type { EpisodicMemory } from "./memory.js";
import { parseProjectPlanDraft } from "./project-plan.js";
import type { GatherBlocksWorkSpec } from "./types.js";
import { TaskSystem, TaskSystemError } from "./task-system.js";

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
  task: z.string().min(1).max(4_000),
  workloadType: z.enum(API_WORKLOAD_TYPES).default("development_test"),
  taskType: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).default("operator_plan"),
  taskId: z.string().min(1).max(128).optional(),
  tags: z
    .record(z.string().min(1).max(64), z.string().max(128))
    .refine((tags) => Object.keys(tags).length <= 16, "At most 16 tags are allowed")
    .default({})
});

const usageFilterSchema = z.object({
  from: optionalIsoDate(),
  to: optionalIsoDate(),
  model: optionalQueryString(),
  requestRole: optionalEnum(API_REQUEST_ROLES),
  workloadType: optionalEnum(API_WORKLOAD_TYPES),
  triggerSource: optionalEnum(API_TRIGGER_SOURCES),
  taskType: optionalQueryString(),
  taskId: optionalQueryString(),
  tag: optionalQueryString()
});

export class OperatorInputError extends Error {}

export interface OperatorControlOptions {
  memory: EpisodicMemory;
  tasks: TaskSystem;
  requestPlanning: (task: string, attribution: PlanningAttribution) => void;
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
      ...this.options.tasks.status()
    };
  }

  usage(input: unknown = {}): object {
    const filters = usageFilterSchema.parse(input) as ApiUsageFilters;
    return this.options.memory.apiUsageSummary("Australia/Brisbane", filters);
  }

  submitGather(input: unknown): object {
    const spec = operatorGatherTaskSchema.parse(input) as GatherBlocksWorkSpec;
    const beforeCalls = this.options.memory.apiUsageSummary().lifetime.calls;
    const order = this.runTask(() => this.options.tasks.submitGather(spec, "operator"));
    return {
      paidApiCalls: this.options.memory.apiUsageSummary().lifetime.calls - beforeCalls,
      workOrder: order
    };
  }

  submitProject(input: unknown): object {
    const draft = parseProjectPlanDraft(input);
    const beforeCalls = this.options.memory.apiUsageSummary().lifetime.calls;
    const project = this.runTask(() => this.options.tasks.submitProject(draft, "operator"));
    return {
      paidApiCalls: this.options.memory.apiUsageSummary().lifetime.calls - beforeCalls,
      project
    };
  }

  cancel(input: unknown): object {
    const { reason } = cancelSchema.parse(input);
    const cancelled = this.options.tasks.cancel(reason, "operator");
    return { cancelled };
  }

  requestPlan(input: unknown): object {
    const { task, workloadType, taskType, tags, taskId: suppliedTaskId } =
      planSchema.parse(input);
    if (
      this.options.tasks.hasActiveDeterministicTask()
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
    const taskId = suppliedTaskId ?? `operator:${crypto.randomUUID()}`;
    this.options.requestPlanning(`Local operator explicitly requested planning: ${task}`, {
      workloadType,
      triggerSource: "operator",
      taskType,
      taskId,
      tags
    });
    return {
      accepted: true,
      paid: true,
      attribution: { workloadType, taskType, taskId, tags },
      note:
        this.options.toolMode === "dry_run"
          ? "Dry-run mode uses one API request and records proposals without executing tools."
          : "Execute mode may use one initial API call plus configured tool continuations."
    };
  }

  private runTask<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof TaskSystemError) {
        throw new OperatorInputError(error.message);
      }
      throw error;
    }
  }
}

function optionalQueryString() {
  return z.preprocess(
    (value) => (Array.isArray(value) ? value[0] : value),
    z.string().min(1).optional()
  );
}

function optionalIsoDate() {
  return z.preprocess(
    (value) => (Array.isArray(value) ? value[0] : value),
    z.string().datetime({ offset: true }).optional()
  );
}

function optionalEnum<const Values extends readonly [string, ...string[]]>(
  values: Values
) {
  return z.preprocess(
    (value) => (Array.isArray(value) ? value[0] : value),
    z.enum(values).optional()
  );
}
