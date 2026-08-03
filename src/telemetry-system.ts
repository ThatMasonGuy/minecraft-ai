import type { EpisodicMemory } from "./memory.js";
import type { ActivityUpdate, MemoryEvent } from "./types.js";

export type TelemetryChannel =
  | "agent"
  | "combat"
  | "acquisition"
  | "project"
  | "recovery"
  | "storage";

export interface TelemetrySystem {
  record(event: MemoryEvent): number;
  activity(channel: TelemetryChannel, update: ActivityUpdate): void;
}

export class PersistentTelemetrySystem implements TelemetrySystem {
  constructor(
    private readonly memory: Pick<EpisodicMemory, "record">,
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
