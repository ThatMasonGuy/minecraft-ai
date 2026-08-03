import type {
  GatherBlocksWorkSpec,
  Goal,
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
  finishGoal(
    id: number,
    status: "completed" | "abandoned",
    summary: string
  ): Goal;
}
