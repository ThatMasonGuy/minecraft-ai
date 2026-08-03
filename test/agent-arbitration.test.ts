import { describe, expect, it } from "vitest";
import {
  allowsOperatorCooldownBypass,
  plannerRequestCooldownRemainingMs,
  requiredPlannerToolForTaskType,
  shouldDeferToDeterministicWork
} from "../src/agent.js";

describe("model decision arbitration", () => {
  it.each([
    { project: true, workOrder: false, recovery: false },
    { project: false, workOrder: true, recovery: false },
    { project: false, workOrder: false, recovery: true }
  ])("defers scheduled decisions while deterministic work is active", (active) => {
    expect(shouldDeferToDeterministicWork("scheduled reflection", active)).toBe(
      true
    );
    expect(
      shouldDeferToDeterministicWork("token budget became available", active)
    ).toBe(true);
  });

  it("does not let player chat wake the model while a project can progress", () => {
    expect(
      shouldDeferToDeterministicWork("Mason said in chat: stop", {
        project: true,
        workOrder: false,
        recovery: false
      })
    ).toBe(true);
  });

  it("allows a player to interrupt a standalone work order explicitly", () => {
    expect(
      shouldDeferToDeterministicWork("Mason said in chat: stop", {
        project: false,
        workOrder: true,
        recovery: false
      })
    ).toBe(false);
  });

  it("allows autonomous planning when no deterministic work exists", () => {
    expect(
      shouldDeferToDeterministicWork("scheduled reflection", {
        project: false,
        workOrder: false,
        recovery: false
      })
    ).toBe(false);
  });

  it("enforces the request interval from the latest completed API call", () => {
    const now = Date.parse("2026-08-03T06:20:00.000Z");
    expect(
      plannerRequestCooldownRemainingMs(
        [
          { completedAt: "2026-08-03T06:00:00.000Z" },
          { completedAt: "2026-08-03T06:10:00.000Z" }
        ],
        15 * 60_000,
        now
      )
    ).toBe(5 * 60_000);
    expect(
      plannerRequestCooldownRemainingMs(
        [{ completedAt: "2026-08-03T06:00:00.000Z" }],
        15 * 60_000,
        now
      )
    ).toBe(0);
  });

  it("forces explicit shelter planning onto the house delegation tool", () => {
    expect(requiredPlannerToolForTaskType("shelter")).toBe(
      "delegate_house_project"
    );
    expect(requiredPlannerToolForTaskType("house")).toBe(
      "delegate_house_project"
    );
    expect(requiredPlannerToolForTaskType("scheduled_reflection")).toBeUndefined();
  });

  it("allows only an explicitly tagged operator request to bypass cooldown", () => {
    expect(
      allowsOperatorCooldownBypass({
        workloadType: "task_planning",
        triggerSource: "operator",
        tags: { skip_cooldown: "true" }
      })
    ).toBe(true);
    expect(
      allowsOperatorCooldownBypass({
        workloadType: "reflection",
        triggerSource: "schedule",
        tags: { skip_cooldown: "true" }
      })
    ).toBe(false);
  });
});
