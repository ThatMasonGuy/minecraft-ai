import { describe, expect, it } from "vitest";
import type { Goal, WorkOrder } from "../src/types.js";
import {
  isBreathHudVisible,
  selectActivity,
  selectPrimaryGoal
} from "../src/viewer-status.js";

const goals: Goal[] = [
  {
    id: 1,
    title: "Build a shelter",
    rationale: "Survive the night",
    priority: 100,
    status: "active",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z"
  },
  {
    id: 2,
    title: "Gather oak",
    rationale: "Supply the build",
    priority: 80,
    status: "active",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z"
  }
];

describe("selectPrimaryGoal", () => {
  it("shows the goal attached to active deterministic work", () => {
    const workOrder: WorkOrder = {
      id: 4,
      kind: "gather_blocks",
      origin: "planner",
      spec: {
        goalId: 2,
        itemName: "oak_log",
        blockNames: ["oak_log"],
        minimumCount: 8,
        continuation: "stop_at_minimum",
        storage: { mode: "inventory" }
      },
      status: "active",
      progressCount: 3,
      lastInventoryCount: 3,
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z"
    };

    expect(selectPrimaryGoal(goals, workOrder)?.id).toBe(2);
  });

  it("falls back to the highest-priority active goal", () => {
    expect(selectPrimaryGoal(goals)?.id).toBe(1);
  });
});

describe("breath HUD", () => {
  it("ignores a stale reduced oxygen value while the player's head is in air", () => {
    expect(isBreathHudVisible(8, false)).toBe(false);
  });

  it("shows reduced air while the player's head is actually submerged", () => {
    expect(isBreathHudVisible(8, true)).toBe(true);
  });
});

describe("activity selection", () => {
  it("keeps deterministic work visible while a planner wake is checking budget", () => {
    expect(
      selectActivity(
        { phase: "online", label: "Connected" },
        { phase: "idle", label: "No threat" },
        { phase: "paused", label: "Paused by token budget" },
        { phase: "working", label: "Mining tunnel" },
        true
      )
    ).toMatchObject({ phase: "working", label: "Mining tunnel" });
  });
});
