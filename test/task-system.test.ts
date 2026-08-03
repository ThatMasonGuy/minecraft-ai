import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EpisodicMemory } from "../src/memory.js";
import { TaskSystem, TaskSystemError } from "../src/task-system.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("enclosed task lifecycle", () => {
  it("starts workflow systems and owns broad gather submission and cancellation", () => {
    const { memory, tasks, acquisition, projects, recovery } = createTasks(6);
    tasks.start();
    expect(recovery.start).toHaveBeenCalledOnce();
    expect(acquisition.start).toHaveBeenCalledOnce();
    expect(projects.start).toHaveBeenCalledOnce();

    const order = tasks.delegateGather(
      {
        itemName: "raw_iron",
        minimumCount: 12,
        continuation: "until_replaced",
        dimension: "overworld"
      },
      "operator"
    );
    expect(order).toMatchObject({
      origin: "operator",
      lastInventoryCount: 6,
      spec: {
        blockNames: ["iron_ore", "deepslate_iron_ore"],
        minimumCount: 12
      }
    });
    expect(tasks.status().activeWorkOrder?.id).toBe(order.id);
    expect(tasks.cancel("test complete", "operator")).toEqual([
      { type: "work_order", id: order.id }
    ]);
    expect(tasks.hasActiveDeterministicTask()).toBe(false);

    tasks.stop();
    expect(projects.stop).toHaveBeenCalledOnce();
    expect(acquisition.stop).toHaveBeenCalledOnce();
    expect(recovery.stop).toHaveBeenCalledOnce();
    memory.close();
  });

  it("rejects standalone work while a project owns the task slot", () => {
    const { memory, tasks } = createTasks();
    tasks.submitProject(
      {
        title: "Verify supplies",
        completionSummary: "Supplies verified",
        steps: [
          {
            id: "verify",
            title: "Verify logs",
            spec: {
              kind: "verify_inventory",
              itemName: "oak_log",
              minimumCount: 1
            }
          }
        ]
      },
      "operator"
    );
    expect(() =>
      tasks.submitGather({
        itemName: "oak_log",
        blockNames: ["oak_log"],
        minimumCount: 1,
        continuation: "stop_at_minimum",
        storage: { mode: "inventory" }
      })
    ).toThrow(TaskSystemError);
    memory.close();
  });
});

function createTasks(inventoryCount = 0) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-ai-tasks-"));
  temporaryDirectories.push(directory);
  const memory = new EpisodicMemory(path.join(directory, "memory.sqlite"));
  const acquisition = { start: vi.fn(), stop: vi.fn(), setTaskLifecycle: vi.fn() };
  const projects = { start: vi.fn(), stop: vi.fn(), setTaskLifecycle: vi.fn() };
  const recovery = { start: vi.fn(), stop: vi.fn(), isActive: () => false };
  const tasks = new TaskSystem(
    memory,
    { record: (event) => memory.record(event), activity: () => undefined },
    { count: () => inventoryCount } as never,
    acquisition as never,
    projects as never,
    recovery as never
  );
  return { memory, tasks, acquisition, projects, recovery };
}
