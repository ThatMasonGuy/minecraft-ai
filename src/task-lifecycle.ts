import type {
  GatherBlocksWorkSpec,
  TaskOrigin,
  WorkOrder
} from "./types.js";

export interface TaskLifecycle {
  submitProjectGather(
    spec: GatherBlocksWorkSpec,
    origin: TaskOrigin
  ): WorkOrder;
  finishWorkOrder(
    id: number,
    status: "completed" | "blocked" | "cancelled",
    reason: string
  ): WorkOrder;
}
