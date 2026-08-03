import type { EpisodicMemory } from "./memory.js";

export type AcquisitionPersistence = Pick<
  EpisodicMemory,
  "activeWorkOrder" | "updateWorkOrderProgress"
>;

export type BuildingPersistence = Pick<
  EpisodicMemory,
  "activeProject" | "registerOwnedContainer"
>;

export type ProjectPersistence = Pick<
  EpisodicMemory,
  | "activeProject"
  | "activeWorkOrder"
  | "latestProject"
  | "ownedContainers"
  | "recordContainerDeposit"
  | "saveProject"
  | "workOrder"
>;

export type RecoveryPersistence = Pick<
  EpisodicMemory,
  | "activeProject"
  | "activeRecoveryJob"
  | "addRecoveryLoadedChunkTime"
  | "latestProject"
  | "ownedContainers"
  | "saveProject"
  | "updateRecoveryJobStatus"
>;

export type StoragePersistence = Pick<
  EpisodicMemory,
  | "activeProject"
  | "activeWorkOrder"
  | "ownedContainers"
  | "recordContainerDeposit"
  | "recordContainerWithdrawal"
>;

export type TaskPersistence = Pick<
  EpisodicMemory,
  | "activeProject"
  | "activeWorkOrder"
  | "createGatherBlocksWorkOrder"
  | "createGoal"
  | "createProjectPlan"
  | "ownedContainers"
  | "saveProject"
  | "updateGoal"
  | "updateWorkOrderStatus"
>;

export type TelemetryPersistence = Pick<EpisodicMemory, "record">;

export type PlannerMemoryQueries = Pick<EpisodicMemory, "search" | "near">;
