import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EpisodicMemory } from "../src/memory.js";
import {
  OperatorControl,
  OperatorInputError
} from "../src/operator-control.js";
import { TaskSystem } from "../src/task-system.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("OperatorControl", () => {
  it("submits a provenance-marked gather order without API usage", () => {
    const { control, memory } = createControl(() => 7);

    const result = control.submitGather({
      itemName: "oak_log",
      blockNames: ["oak_log"],
      minimumCount: 16,
      continuation: "until_replaced",
      storage: { mode: "inventory" }
    }) as {
      paidApiCalls: number;
      workOrder: { id: number; origin: string; lastInventoryCount: number };
    };

    expect(result.paidApiCalls).toBe(0);
    expect(result.workOrder).toMatchObject({
      origin: "operator",
      lastInventoryCount: 7
    });
    expect(memory.apiUsageSummary().lifetime.calls).toBe(0);
    expect(memory.activeWorkOrder()?.origin).toBe("operator");
    expect(memory.recent(5).some((event) => event.kind === "operator_task")).toBe(
      true
    );
    memory.close();
  });

  it("validates and persists operator projects without calling the planner", () => {
    const { control, memory } = createControl();
    const result = control.submitProject({
      title: "Verify supplies",
      completionSummary: "Required supplies are present",
      steps: [
        {
          id: "verify_logs",
          title: "Verify logs",
          spec: {
            kind: "verify_inventory",
            itemName: "oak_log",
            minimumCount: 4
          }
        }
      ]
    }) as { paidApiCalls: number; project: { origin: string } };

    expect(result).toMatchObject({
      paidApiCalls: 0,
      project: { origin: "operator" }
    });
    expect(memory.apiUsageSummary().lifetime.calls).toBe(0);
    memory.close();
  });

  it("rejects a project without deterministic verification", () => {
    const { control, memory } = createControl();
    expect(() =>
      control.submitProject({
        title: "Gather only",
        completionSummary: "Gathered",
        steps: [
          {
            id: "gather",
            title: "Gather",
            spec: {
              kind: "acquire_item",
              itemName: "oak_log",
              targetCount: 4,
              sourceBlockNames: ["oak_log"]
            }
          }
        ]
      })
    ).toThrow("deterministic verification");
    memory.close();
  });

  it("prevents a standalone work order from competing with an active project", () => {
    const { control, memory } = createControl();
    control.submitProject({
      title: "Verify supplies",
      completionSummary: "Required supplies are present",
      steps: [
        {
          id: "verify_logs",
          title: "Verify logs",
          spec: {
            kind: "verify_inventory",
            itemName: "oak_log",
            minimumCount: 4
          }
        }
      ]
    });

    expect(() =>
      control.submitGather({
        itemName: "oak_log",
        blockNames: ["oak_log"],
        minimumCount: 1
      })
    ).toThrow("A project is active");
    memory.close();
  });

  it("keeps paid planning explicit and separate from deterministic tasks", () => {
    const planning = vi.fn();
    const { control, memory } = createControl(undefined, planning);

    expect(
      control.requestPlan({
        task: "Propose a bounded test plan",
        workloadType: "task_planning",
        taskType: "shelter",
        tags: { evaluation: "boundary" }
      })
    ).toMatchObject({
      accepted: true,
      paid: true,
      attribution: {
        workloadType: "task_planning",
        taskType: "shelter",
        tags: { evaluation: "boundary" }
      }
    });
    expect(planning).toHaveBeenCalledOnce();
    expect(planning).toHaveBeenCalledWith(
      expect.stringContaining("Propose a bounded test plan"),
      expect.objectContaining({
        workloadType: "task_planning",
        triggerSource: "operator",
        taskType: "shelter",
        tags: { evaluation: "boundary" }
      })
    );

    control.submitGather({
      itemName: "oak_log",
      blockNames: ["oak_log"],
      minimumCount: 1
    });
    expect(() => control.requestPlan({ task: "Interrupt the active task" })).toThrow(
      OperatorInputError
    );
    expect(planning).toHaveBeenCalledOnce();
    memory.close();
  });

  it("cancels active operator tasks through the same process", () => {
    const { control, memory } = createControl();
    control.submitGather({
      itemName: "oak_log",
      blockNames: ["oak_log"],
      minimumCount: 1
    });

    const result = control.cancel({ reason: "Test finished" }) as {
      cancelled: Array<{ type: string; id: number }>;
    };
    expect(result.cancelled).toHaveLength(1);
    expect(result.cancelled[0]?.type).toBe("work_order");
    expect(memory.activeWorkOrder()).toBeUndefined();
    memory.close();
  });
});

function createControl(
  inventoryCount: ((itemName: string) => number) | undefined = () => 0,
  requestPlanning = vi.fn()
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-ai-operator-"));
  temporaryDirectories.push(directory);
  const memory = new EpisodicMemory(path.join(directory, "memory.sqlite"));
  const tasks = new TaskSystem(
    memory,
    { count: inventoryCount } as never,
    lifecycleStub() as never,
    lifecycleStub() as never,
    { ...lifecycleStub(), isActive: () => false } as never
  );
  const control = new OperatorControl({
    memory,
    tasks,
    requestPlanning,
    plannerMode: "manual",
    toolMode: "dry_run",
    model: "gpt-5.6-luna"
  });
  return { control, memory };
}

function lifecycleStub() {
  return {
    start: () => undefined,
    stop: () => undefined,
    setTaskLifecycle: () => undefined
  };
}
