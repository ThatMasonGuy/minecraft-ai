import type { TelemetryPersistence } from "./persistence-ports.js";
import type { ActivityUpdate, MemoryEvent } from "./types.js";

export type TelemetryChannel =
  | "agent"
  | "combat"
  | "acquisition"
  | "project"
  | "recovery"
  | "survival"
  | "storage";

export interface TelemetrySystem {
  record(event: MemoryEvent): number;
  activity(channel: TelemetryChannel, update: ActivityUpdate): void;
}

export class PersistentTelemetrySystem implements TelemetrySystem {
  constructor(
    private readonly memory: TelemetryPersistence,
    private readonly sinks: Partial<
      Record<TelemetryChannel, (update: ActivityUpdate) => void>
    > = {}
  ) {}

  record(event: MemoryEvent): number {
    return this.memory.record(event);
  }

  activity(channel: TelemetryChannel, update: ActivityUpdate): void {
    this.sinks[channel]?.(update);
  }
}
