export interface Position {
  x: number;
  y: number;
  z: number;
}

export interface VisibleBlock extends Position {
  name: string;
  distance: number;
}

export interface VisibleEntity extends Position {
  id: number;
  name: string;
  kind: string;
  username?: string;
  distance: number;
}

export interface InventoryEntry {
  name: string;
  count: number;
  slot: number;
}

export interface PerceptionSnapshot {
  observedAt: string;
  position: Position;
  yawDegrees: number;
  pitchDegrees: number;
  dimension: string;
  health: number;
  food: number;
  oxygen: number;
  isRaining: boolean;
  timeOfDay: number;
  inventory: InventoryEntry[];
  emptyInventorySlots: number;
  visibleBlocks: VisibleBlock[];
  visibleEntities: VisibleEntity[];
}

export interface MemoryEvent {
  id?: number;
  occurredAt?: string;
  kind: string;
  summary: string;
  payload?: unknown;
  position?: Position;
  dimension?: string;
  actor?: string;
  importance?: number;
}

export interface RecoveryJob {
  id: number;
  position: Position;
  dimension: string;
  expectedItems: Array<{ name: string; count: number }>;
  loadedChunkMs: number;
  status: "active" | "completed" | "expired" | "cancelled";
  statusReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OwnedContainer {
  id: number;
  position: Position;
  dimension: string;
  blockName: string;
  label?: string;
  contents: Record<string, number>;
  status: "active" | "missing";
  createdAt: string;
  updatedAt: string;
}

export interface Goal {
  id: number;
  title: string;
  rationale: string;
  priority: number;
  status: "active" | "completed" | "abandoned";
  createdAt: string;
  updatedAt: string;
}

export interface GatherBlocksWorkSpec {
  goalId?: number;
  itemName: string;
  blockNames: string[];
  minimumCount: number;
  continuation: "stop_at_minimum" | "until_replaced";
  storage:
    | { mode: "inventory" }
    | { mode: "container"; position: Position };
}

export interface WorkOrder {
  id: number;
  kind: "gather_blocks";
  spec: GatherBlocksWorkSpec;
  status: "active" | "completed" | "blocked" | "cancelled";
  statusReason?: string;
  progressCount: number;
  lastInventoryCount: number;
  minimumReachedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RelativePosition {
  dx: number;
  dy: number;
  dz: number;
}

export interface BlueprintPlacement extends RelativePosition {
  itemName: string;
  expectedBlockNames: string[];
}

export type ProjectStepSpec =
  | {
      kind: "use_site";
      position: Position;
    }
  | {
      kind: "survey_site";
      width: number;
      depth: number;
      clearanceHeight: number;
      maxWaypoints: number;
      waypointSpacing: number;
    }
  | {
      kind: "acquire_item";
      itemName: string;
      targetCount: number;
      sourceBlockNames: string[];
    }
  | {
      kind: "craft_item";
      itemName: string;
      targetCount: number;
      craftingTableAt?: RelativePosition;
    }
  | {
      kind: "smelt_item";
      inputItemName: string;
      fuelItemName: string;
      fuelCount: number;
      outputItemName: string;
      targetCount: number;
      furnaceAt: RelativePosition;
    }
  | {
      kind: "prospect_resource";
      itemName: string;
      targetCount: number;
      oreBlockNames: string[];
      targetY: number;
      maxTunnelBlocks: number;
      branchLength: number;
      branchSpacing: number;
      torchSpacing: number;
      heading: "north" | "south" | "east" | "west";
      craftingTableAt?: RelativePosition;
    }
  | {
      kind: "place_blueprint";
      placements: BlueprintPlacement[];
    }
  | {
      kind: "verify_structure";
      checks: StructureCheck[];
    }
  | {
      kind: "verify_inventory";
      itemName: string;
      minimumCount: number;
    }
  | {
      kind: "deposit_item";
      itemName: string;
      minimumCount: number;
      containerAt: RelativePosition;
    };

export type StructureCheck =
  | { kind: "blueprint_complete" }
  | {
      kind: "roofed_area";
      min: RelativePosition;
      max: RelativePosition;
      roofY: number;
    }
  | {
      kind: "boundary_closed";
      min: RelativePosition;
      max: RelativePosition;
      minY: number;
      maxY: number;
      openings: RelativePosition[];
    }
  | {
      kind: "entrance";
      at: RelativePosition;
      blockNames: string[];
    };

export interface ProjectStep {
  id: string;
  title: string;
  spec: ProjectStepSpec;
  status: "pending" | "in_progress" | "completed" | "blocked";
  state: Record<string, unknown>;
  statusReason?: string;
}

export interface ProjectPlanDraft {
  goalId?: number;
  title: string;
  completionSummary: string;
  steps: Array<Pick<ProjectStep, "id" | "title" | "spec">>;
}

export interface ProjectPlan {
  id: number;
  goalId?: number;
  title: string;
  completionSummary: string;
  status: "active" | "completed" | "blocked" | "cancelled";
  statusReason?: string;
  currentStepIndex: number;
  anchor?: Position;
  steps: ProjectStep[];
  createdAt: string;
  updatedAt: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

export type ActivityPhase =
  | "connecting"
  | "online"
  | "thinking"
  | "acting"
  | "working"
  | "waiting"
  | "paused"
  | "idle"
  | "stopped"
  | "error";

export interface ActivityUpdate {
  phase: ActivityPhase;
  label: string;
  detail?: string;
  since?: string;
}
