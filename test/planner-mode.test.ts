import { describe, expect, it, vi } from "vitest";
import { AutonomousAgent } from "../src/agent.js";
import type { PlannerTools } from "../src/planner-tools.js";
import type { EpisodicMemory } from "../src/memory.js";
import type { Perception } from "../src/perception.js";
import {
  allowsAutomaticPlanning,
  parsePlanningCommand
} from "../src/planner-mode.js";
import type { TaskSystem } from "../src/task-system.js";

describe("planner mode", () => {
  it("allows automatic wakeups only in automatic mode", () => {
    expect(allowsAutomaticPlanning("manual")).toBe(false);
    expect(allowsAutomaticPlanning("automatic")).toBe(true);
  });

  it("starts manual mode without scheduling an automatic model turn", () => {
    const onActivity = vi.fn();
    const agent = new AutonomousAgent(
      {} as EpisodicMemory,
      {} as Perception,
      {} as PlannerTools,
      {} as TaskSystem,
      {
        apiKey: "test-key-that-is-long-enough",
        model: "test-model",
        reasoningEffort: "low",
      plannerMode: "manual",
      toolMode: "dry_run",
      webSearchEnabled: false,
        tickMs: 900_000,
        maxToolRounds: 1,
        maxOutputTokens: 64,
        dailyTokenBudget: 10_000,
        dailyTokenReserve: 1_000,
        identitySeed: "planner-mode-test",
        onActivity
      }
    );

    agent.start();

    expect(agent.wakeAutomatically("scheduled reflection")).toBe(false);
    expect(onActivity).toHaveBeenCalledWith({
      phase: "idle",
      label: "Manual planning mode",
      detail:
        "Automatic model wakeups are disabled; use !plan <task>; tools: dry_run"
    });
    agent.stop();
  });

  it("recognizes explicit one-off planning tasks", () => {
    expect(parsePlanningCommand("!plan gather 24 oak logs")).toEqual({
      matched: true,
      task: "gather 24 oak logs"
    });
    expect(parsePlanningCommand("  !PLAN   build a shelter  ")).toEqual({
      matched: true,
      task: "build a shelter"
    });
  });

  it("distinguishes missing tasks and ordinary chat", () => {
    expect(parsePlanningCommand("!plan")).toEqual({ matched: true });
    expect(parsePlanningCommand("hello there")).toEqual({ matched: false });
    expect(parsePlanningCommand("!planet")).toEqual({ matched: false });
  });
});
