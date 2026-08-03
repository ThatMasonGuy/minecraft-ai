import { describe, expect, it, vi } from "vitest";
import { ProjectSystem } from "../src/project-system.js";
import type { ProjectPlan } from "../src/types.js";

function project(overrides: Partial<ProjectPlan> = {}): ProjectPlan {
  return {
    id: 41,
    title: "Test deterministic project",
    origin: "planner",
    completionSummary: "The outcome is verified.",
    status: "active",
    currentStepIndex: 0,
    steps: [],
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:01:00.000Z",
    ...overrides
  };
}

function systemWith(
  memory: Record<string, unknown>,
  onTerminal = vi.fn()
): { system: ProjectSystem; onTerminal: typeof onTerminal } {
  const system = new ProjectSystem(
    {} as never,
    memory as never,
    { record: vi.fn(), activity: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    3_000,
    onTerminal
  );
  system.setTaskLifecycle({ finishGoal: vi.fn() } as never);
  return { system, onTerminal };
}

async function tick(system: ProjectSystem): Promise<void> {
  await (system as unknown as { tick(): Promise<void> }).tick();
}

describe("project terminal planning handoff", () => {
  it("reports whole-project completion exactly when deterministic work ends", async () => {
    const active = project();
    const memory = {
      activeProject: vi.fn(() => active),
      latestProject: vi.fn(() => active),
      saveProject: vi.fn((value: ProjectPlan) => value)
    };
    const fixture = systemWith(memory);

    await tick(fixture.system);

    expect(fixture.onTerminal).toHaveBeenCalledOnce();
    expect(fixture.onTerminal).toHaveBeenCalledWith("completed", active);
  });

  it("reports a blocked project only after deterministic recovery declines it", async () => {
    const blocked = project({
      status: "blocked",
      statusReason: "Inventory verification failed",
      steps: [
        {
          id: "verify",
          title: "Verify inventory",
          status: "blocked",
          statusReason: "Inventory verification failed",
          state: {},
          spec: {
            kind: "verify_inventory",
            itemName: "diamond",
            minimumCount: 3
          }
        }
      ]
    });
    const memory = {
      activeProject: vi.fn(() => undefined),
      latestProject: vi.fn(() => blocked),
      saveProject: vi.fn((value: ProjectPlan) => value)
    };
    const fixture = systemWith(memory);

    await tick(fixture.system);
    await tick(fixture.system);

    expect(fixture.onTerminal).toHaveBeenCalledOnce();
    expect(fixture.onTerminal).toHaveBeenCalledWith("blocked", blocked);
  });
});
