import { describe, expect, it } from "vitest";
import { shouldDeferToDeterministicWork } from "../src/agent.js";

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

  it("allows a player to interrupt deterministic work explicitly", () => {
    expect(
      shouldDeferToDeterministicWork("Mason said in chat: stop", {
        project: true,
        workOrder: false,
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
});
