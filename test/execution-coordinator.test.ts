import { describe, expect, it, vi } from "vitest";
import { ExecutionCoordinator } from "../src/execution-coordinator.js";

function testBot() {
  const pathfinder = {
    goto: vi.fn(async () => undefined),
    setGoal: vi.fn(),
    setMovements: vi.fn(),
    stop: vi.fn(),
    bestHarvestTool: vi.fn(),
    movements: {}
  };
  const bot = { pathfinder };
  return { bot, pathfinder };
}

describe("ExecutionCoordinator", () => {
  it("requires an execution scope for Pathfinder mutations", () => {
    const { bot } = testBot();
    const coordinator = new ExecutionCoordinator(bot as never);

    expect(() => bot.pathfinder.stop()).toThrow(/execution-owner scope/);
    coordinator.dispose();
  });

  it("preempts lower-priority movement and blocks it until release", async () => {
    const { bot, pathfinder } = testBot();
    const coordinator = new ExecutionCoordinator(bot as never);
    let workActive = true;
    let combatActive = true;
    const work = coordinator.scope("work", () => workActive);
    const combat = coordinator.scope("combat", () => combatActive);

    expect(await work.run(async () => void bot.pathfinder.setGoal("work"))).toBe(true);
    expect(coordinator.owner()).toBe("work");
    expect(await combat.run(async () => void bot.pathfinder.setGoal("combat"))).toBe(true);
    expect(coordinator.owner()).toBe("combat");
    expect(pathfinder.stop).toHaveBeenCalledTimes(1);
    expect(await work.run(async () => void bot.pathfinder.setGoal("again"))).toBe(false);

    combatActive = false;
    combat.runSync(() => bot.pathfinder.stop());
    expect(coordinator.owner()).toBe("idle");
    expect(await work.run(async () => void bot.pathfinder.setGoal("resumed"))).toBe(true);
    expect(coordinator.owner()).toBe("work");

    workActive = false;
    work.release();
    coordinator.dispose();
  });

  it("allows read-only Pathfinder helpers outside executor scopes", () => {
    const { bot, pathfinder } = testBot();
    const coordinator = new ExecutionCoordinator(bot as never);

    bot.pathfinder.bestHarvestTool("stone");
    expect(pathfinder.bestHarvestTool).toHaveBeenCalledWith("stone");
    coordinator.dispose();
  });
});
