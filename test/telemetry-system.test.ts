import { describe, expect, it, vi } from "vitest";
import { PersistentTelemetrySystem } from "../src/telemetry-system.js";

describe("telemetry authority", () => {
  it("persists events and routes activity by channel", () => {
    const record = vi.fn(() => 17);
    const work = vi.fn();
    const combat = vi.fn();
    const telemetry = new PersistentTelemetrySystem(
      { record },
      { acquisition: work, combat }
    );

    expect(
      telemetry.record({ kind: "test", summary: "Recorded once", importance: 4 })
    ).toBe(17);
    telemetry.activity("acquisition", { phase: "working", label: "Gathering" });
    telemetry.activity("combat", { phase: "acting", label: "Escaping" });

    expect(record).toHaveBeenCalledOnce();
    expect(work).toHaveBeenCalledWith({ phase: "working", label: "Gathering" });
    expect(combat).toHaveBeenCalledWith({ phase: "acting", label: "Escaping" });
  });
});
