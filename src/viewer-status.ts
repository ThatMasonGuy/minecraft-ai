import type { Bot } from "mineflayer";
import type { InventorySystem } from "./inventory-system.js";
import type { EpisodicMemory } from "./memory.js";
import type { ActivityUpdate, Goal, WorkOrder } from "./types.js";

export interface HotbarItem {
  slot: number;
  name?: string;
  displayName?: string;
  count?: number;
}

export interface InventoryItem {
  slot: number;
  name?: string;
  displayName?: string;
  count?: number;
}

export interface PlayerInventory {
  occupiedSlotCount: number;
  totalItemCount: number;
  main: InventoryItem[];
  hotbar: HotbarItem[];
  equipment: {
    head: InventoryItem;
    chest: InventoryItem;
    legs: InventoryItem;
    feet: InventoryItem;
    offhand: InventoryItem;
  };
}

export interface ViewerSnapshot {
  generatedAt: string;
  connection: ActivityUpdate;
  activity: ActivityUpdate;
  combatActivity: ActivityUpdate;
  agentActivity: ActivityUpdate;
  workActivity: ActivityUpdate;
  primaryGoal?: Goal;
  otherActiveGoalCount: number;
  workOrder?: {
    id: number;
    itemName: string;
    progressCount: number;
    minimumCount: number;
    continuation: WorkOrder["spec"]["continuation"];
    minimumReached: boolean;
  };
  project?: {
    id: number;
    title: string;
    stepTitle: string;
    stepIndex: number;
    stepCount: number;
    progressCount: number;
    progressTotal: number;
  };
  player?: {
    username: string;
    health: number;
    food: number;
    foodSaturation: number;
    oxygen: number;
    underwater: boolean;
    experienceLevel: number;
    experienceProgress: number;
    selectedHotbarSlot: number;
    hotbar: HotbarItem[];
    inventory: PlayerInventory;
    position: { x: number; y: number; z: number };
    dimension: string;
    gameMode: string;
    timeOfDay: number;
  };
}

const now = () => new Date().toISOString();

export class ViewerStatusStore {
  private connection: ActivityUpdate = status(
    "connecting",
    "Connecting",
    "Waiting for the Minecraft server"
  );
  private agent: ActivityUpdate = status("idle", "Agent idle");
  private work: ActivityUpdate = status("idle", "No background work");
  private combat: ActivityUpdate = status("idle", "No immediate combat threat");

  setConnection(update: ActivityUpdate): void {
    this.connection = normalize(update, this.connection);
  }

  setAgent(update: ActivityUpdate): void {
    this.agent = normalize(update, this.agent);
  }

  setWork(update: ActivityUpdate): void {
    this.work = normalize(update, this.work);
  }

  setCombat(update: ActivityUpdate): void {
    this.combat = normalize(update, this.combat);
  }

  snapshot(
    memory: EpisodicMemory,
    bot?: Bot,
    inventorySystem?: InventorySystem
  ): ViewerSnapshot {
    const goals = memory.activeGoals();
    const workOrder = memory.activeWorkOrder();
    const project = memory.activeProject();
    const primaryGoal = selectPrimaryGoal(goals, workOrder, project?.goalId);

    return {
      generatedAt: now(),
      connection: this.connection,
      activity: selectActivity(
        this.connection,
        this.combat,
        this.agent,
        this.work,
        Boolean(workOrder)
          || Boolean(project)
          || Boolean(memory.activeRecoveryJob())
      ),
      combatActivity: this.combat,
      agentActivity: this.agent,
      workActivity: this.work,
      primaryGoal,
      otherActiveGoalCount: Math.max(0, goals.length - (primaryGoal ? 1 : 0)),
      workOrder: workOrder
        ? {
            id: workOrder.id,
            itemName: workOrder.spec.itemName,
            progressCount: workOrder.progressCount,
            minimumCount: workOrder.spec.minimumCount,
            continuation: workOrder.spec.continuation,
            minimumReached: Boolean(workOrder.minimumReachedAt)
          }
        : undefined,
      project: project
        ? projectSnapshot(project)
        : undefined,
      player:
        bot?.entity && inventorySystem
          ? playerSnapshot(bot, inventorySystem)
          : undefined
    };
  }
}

function projectSnapshot(
  project: NonNullable<ReturnType<EpisodicMemory["activeProject"]>>
): NonNullable<ViewerSnapshot["project"]> {
  const step = project.steps[project.currentStepIndex];
  let progressCount = project.currentStepIndex;
  let progressTotal = project.steps.length;
  if (step?.spec.kind === "place_blueprint") {
    const completed = Array.isArray(step.state.completed)
      ? step.state.completed.length
      : 0;
    progressCount = project.currentStepIndex + completed / step.spec.placements.length;
  }
  return {
    id: project.id,
    title: project.title,
    stepTitle: step?.title ?? "Finishing project",
    stepIndex: Math.min(project.currentStepIndex + 1, project.steps.length),
    stepCount: project.steps.length,
    progressCount,
    progressTotal
  };
}

export function selectPrimaryGoal(
  goals: Goal[],
  workOrder?: WorkOrder,
  projectGoalId?: number
): Goal | undefined {
  if (projectGoalId !== undefined) {
    const projectGoal = goals.find((goal) => goal.id === projectGoalId);
    if (projectGoal) return projectGoal;
  }
  if (workOrder?.spec.goalId !== undefined) {
    const workGoal = goals.find((goal) => goal.id === workOrder.spec.goalId);
    if (workGoal) return workGoal;
  }
  return goals[0];
}

function playerSnapshot(
  bot: Bot,
  inventorySystem: InventorySystem
): NonNullable<ViewerSnapshot["player"]> {
  const inventory = inventorySnapshot(inventorySystem);
  const hotbar = inventory.hotbar;

  return {
    username: bot.username,
    health: finite(bot.health, 0),
    food: finite(bot.food, 0),
    foodSaturation: finite(bot.foodSaturation, 0),
    oxygen: finite(bot.oxygenLevel, 0),
    underwater: isHeadSubmerged(bot),
    experienceLevel: finite(bot.experience?.level, 0),
    experienceProgress: finite(bot.experience?.progress, 0),
    selectedHotbarSlot: finite(bot.quickBarSlot, 0),
    hotbar,
    inventory,
    position: {
      x: Math.round(bot.entity.position.x),
      y: Math.round(bot.entity.position.y),
      z: Math.round(bot.entity.position.z)
    },
    dimension: String(bot.game?.dimension ?? "unknown"),
    gameMode: String(bot.game?.gameMode ?? "unknown"),
    timeOfDay: finite(bot.time?.timeOfDay, 0)
  };
}

function inventorySnapshot(inventorySystem: InventorySystem): PlayerInventory {
  const layout = inventorySystem.layout();
  const main = layout.main.map((item, index) => itemSnapshot(item, index));
  const hotbar = layout.hotbar.map((item, slot) => itemSnapshot(item, slot));
  const equipment = {
    head: itemSnapshot(layout.equipment.head, 5),
    chest: itemSnapshot(layout.equipment.chest, 6),
    legs: itemSnapshot(layout.equipment.legs, 7),
    feet: itemSnapshot(layout.equipment.feet, 8),
    offhand: itemSnapshot(layout.equipment.offhand, 45)
  };
  const occupied = [...main, ...hotbar, ...Object.values(equipment)].filter(
    (item) => item.name
  );

  return {
    occupiedSlotCount: occupied.length,
    totalItemCount: occupied.reduce((sum, item) => sum + (item.count ?? 0), 0),
    main,
    hotbar,
    equipment
  };
}

function itemSnapshot(
  item: ReturnType<InventorySystem["items"]>[number] | undefined,
  slot: number
): InventoryItem {
  return item
    ? {
        slot,
        name: item.name,
        displayName: item.displayName,
        count: item.count
      }
    : { slot };
}

export function selectActivity(
  connection: ActivityUpdate,
  combat: ActivityUpdate,
  agent: ActivityUpdate,
  work: ActivityUpdate,
  hasActiveWorkOrder: boolean
): ActivityUpdate {
  if (connection.phase !== "online") return connection;
  if (combat.phase === "acting" || combat.phase === "waiting" || combat.phase === "error") {
    return combat;
  }
  if (
    hasActiveWorkOrder &&
    (work.phase === "working" || work.phase === "waiting" || work.phase === "error")
  ) {
    return work;
  }
  if (agent.phase === "thinking" || agent.phase === "acting" || agent.phase === "error") {
    return agent;
  }
  if (agent.phase === "paused" || agent.phase === "stopped") return agent;
  return agent.phase === "idle" ? agent : connection;
}

function normalize(
  update: ActivityUpdate,
  previous?: ActivityUpdate
): ActivityUpdate {
  const unchanged =
    previous?.phase === update.phase &&
    previous.label === update.label &&
    previous.detail === update.detail;
  return {
    ...update,
    since: update.since ?? (unchanged ? previous.since : undefined) ?? now()
  };
}

function status(
  phase: ActivityUpdate["phase"],
  label: string,
  detail?: string
): ActivityUpdate {
  return normalize({ phase, label, detail });
}

function finite(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

export function isBreathHudVisible(
  oxygen: number,
  underwater: boolean
): boolean {
  return underwater && oxygen < 20;
}

function isHeadSubmerged(bot: Bot): boolean {
  const eyePosition = bot.entity.position.offset(0, 1.62, 0);
  const block = bot.blockAt(eyePosition);
  if (!block) return false;
  return (
    block.name === "water" ||
    block.name === "bubble_column" ||
    block.name === "kelp" ||
    block.name === "kelp_plant" ||
    block.name === "seagrass" ||
    block.name === "tall_seagrass"
  );
}
