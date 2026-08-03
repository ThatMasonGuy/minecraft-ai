import { z } from "zod";
import type { CommunicationSystem } from "./communication-system.js";
import type { PlannerMemoryQueries } from "./persistence-ports.js";
import type { SensingSystem } from "./perception.js";
import type { TaskSystem } from "./task-system.js";
import type { TelemetrySystem } from "./telemetry-system.js";
import type { ActionResult } from "./types.js";
import { HIGH_LEVEL_PROJECT_KINDS } from "./project-compiler.js";

export interface PlannerToolDefinition {
  type: "function";
  name: string;
  description: string;
  strict: true;
  parameters: Record<string, unknown>;
}

const HIGH_LEVEL_PLANNER_TOOLS = new Set([
  "speak",
  "recall",
  "recall_nearby",
  "create_goal",
  "finish_goal",
  "delegate_gather",
  "delegate_project",
  "cancel_work_order"
]);

export function isHighLevelPlannerTool(name: string): boolean {
  return HIGH_LEVEL_PLANNER_TOOLS.has(name);
}

export { deterministicGatherSources } from "./task-system.js";

export class PlannerTools {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly memory: PlannerMemoryQueries,
    private readonly sensing: SensingSystem,
    private readonly tasks: TaskSystem,
    private readonly communication: CommunicationSystem,
    private readonly telemetry: TelemetrySystem
  ) {}

  plannerDefinitions(): PlannerToolDefinition[] {
    return [
      tool("speak", "Say something in Minecraft chat.", {
        message: stringSchema("Chat message, at most 240 characters")
      }),
      tool("recall", "Search remembered observations and outcomes.", {
        query: stringSchema("Memory search query"),
        limit: numberSchema("Maximum results from 1 to 20")
      }),
      tool("recall_nearby", "Recall observations near the current position.", {
        radius: numberSchema("Search radius from 1 to 256 blocks"),
        limit: numberSchema("Maximum results from 1 to 30")
      }),
      tool("create_goal", "Create a broad durable goal.", {
        title: stringSchema("Short goal title"),
        rationale: stringSchema("Why this outcome matters"),
        priority: numberSchema("Priority from 1 to 100")
      }),
      tool("finish_goal", "Mark a broad goal completed or abandoned.", {
        goal_id: numberSchema("Existing goal id"),
        status: enumSchema(["completed", "abandoned"]),
        summary: stringSchema("Outcome summary")
      }),
      tool(
        "delegate_gather",
        "Delegate a broad gathering outcome to the deterministic acquisition system. Do not specify coordinates or movement steps.",
        {
          goal_id: numberSchema("Related goal id, or 0 for none"),
          item_name: stringSchema("Desired inventory item"),
          minimum_count: numberSchema("Minimum total to gather"),
          continuation: enumSchema(["stop_at_minimum", "until_replaced"])
        }
      ),
      tool(
        "delegate_project",
        "Start a supported durable multi-stage project. The deterministic compiler owns site selection, materials, steps, coordinates, verification, and retries.",
        {
          goal_id: numberSchema(
            "Related goal id, or 0 to create and link the default measurable goal"
          ),
          outcome: enumSchema([...HIGH_LEVEL_PROJECT_KINDS])
        }
      ),
      tool("cancel_work_order", "Cancel the active deterministic task.", {
        reason: stringSchema("Why the task should stop")
      })
    ];
  }

  async execute(name: string, rawArguments: unknown): Promise<ActionResult> {
    const run = this.queue.then(async () => {
      let result: ActionResult;
      try {
        result = await this.dispatch(name, rawArguments);
      } catch (error) {
        result = fail(error instanceof Error ? error.message : String(error));
      }
      this.telemetry.record({
        kind: result.ok ? "planner_tool" : "planner_tool_failure",
        summary: `${name}: ${result.message}`,
        payload: { arguments: rawArguments, result },
        position: this.sensing.last()?.position,
        dimension: this.sensing.last()?.dimension,
        importance: result.ok ? 5 : 7
      });
      return result;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async dispatch(name: string, raw: unknown): Promise<ActionResult> {
    switch (name) {
      case "speak": {
        const { message } = z.object({ message: z.string().min(1).max(240) }).parse(raw);
        this.communication.say(message);
        return ok(`Said: ${message}`);
      }
      case "recall": {
        const { query, limit } = z
          .object({ query: z.string().min(1), limit: z.number().int().min(1).max(20) })
          .parse(raw);
        return ok(`Memory search for "${query}"`, this.memory.search(query, limit));
      }
      case "recall_nearby": {
        const { radius, limit } = z
          .object({
            radius: z.number().min(1).max(256),
            limit: z.number().int().min(1).max(30)
          })
          .parse(raw);
        const snapshot = this.sensing.last() ?? this.sensing.observe();
        return ok(
          `Memories within ${radius} blocks`,
          this.memory.near(snapshot.position, snapshot.dimension, radius, limit)
        );
      }
      case "create_goal": {
        const args = z
          .object({
            title: z.string().min(1).max(200),
            rationale: z.string().min(1).max(1_000),
            priority: z.number().min(1).max(100)
          })
          .parse(raw);
        const goal = this.tasks.createGoal(args.title, args.rationale, args.priority);
        return ok(`Created goal ${goal.id}: ${goal.title}`, goal);
      }
      case "finish_goal": {
        const args = z
          .object({
            goal_id: z.number().int().positive(),
            status: z.enum(["completed", "abandoned"]),
            summary: z.string().min(1).max(2_000)
          })
          .parse(raw);
        const goal = this.tasks.finishGoal(args.goal_id, args.status, args.summary);
        return ok(`Goal ${goal.id} marked ${args.status}`, goal);
      }
      case "delegate_gather": {
        const args = z
          .object({
            goal_id: z.number().int().min(0),
            item_name: z.string().min(1).max(128),
            minimum_count: z.number().int().min(1).max(1_000_000),
            continuation: z.enum(["stop_at_minimum", "until_replaced"])
          })
          .parse(raw);
        const snapshot = this.sensing.last() ?? this.sensing.observe();
        const order = this.tasks.delegateGather(
          {
            goalId: args.goal_id === 0 ? undefined : args.goal_id,
            itemName: args.item_name,
            minimumCount: args.minimum_count,
            continuation: args.continuation,
            dimension: snapshot.dimension
          },
          "planner"
        );
        return ok(
          `Delegated ${args.minimum_count} ${args.item_name} to deterministic work order ${order.id}`,
          order
        );
      }
      case "delegate_project": {
        const args = z
          .object({
            goal_id: z.number().int().min(0),
            outcome: z.enum(HIGH_LEVEL_PROJECT_KINDS)
          })
          .parse(raw);
        const snapshot = this.sensing.last() ?? this.sensing.observe();
        const project = this.tasks.delegateProject(
          {
            goalId: args.goal_id === 0 ? undefined : args.goal_id,
            kind: args.outcome,
            dimension: snapshot.dimension,
            visibleBlocks: snapshot.visibleBlocks.map(({ name, distance }) => ({
              name,
              distance
            })),
            inventory: snapshot.inventory.map(({ name, count }) => ({ name, count }))
          },
          "planner"
        );
        return ok(
          `Started deterministic ${args.outcome} project ${project.id}`,
          project
        );
      }
      case "cancel_work_order": {
        const { reason } = z
          .object({ reason: z.string().min(1).max(1_000) })
          .parse(raw);
        if (!this.tasks.hasActiveDeterministicTask()) {
          return fail("There is no active deterministic task");
        }
        return ok("Cancelled active deterministic task", this.tasks.cancel(reason, "planner"));
      }
      default:
        return fail(`Unknown planner tool: ${name}`);
    }
  }
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>
): PlannerToolDefinition {
  return {
    type: "function",
    name,
    description,
    strict: true,
    parameters: {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false
    }
  };
}

function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function numberSchema(description: string): Record<string, unknown> {
  return { type: "number", description };
}

function enumSchema(values: string[]): Record<string, unknown> {
  return { type: "string", enum: values };
}

function ok(message: string, data?: unknown): ActionResult {
  return { ok: true, message, data };
}

function fail(message: string): ActionResult {
  return { ok: false, message };
}
