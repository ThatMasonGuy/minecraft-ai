import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import mineflayer, { type Bot } from "mineflayer";
import { loader as autoEat } from "mineflayer-auto-eat";
import { MinecraftActions } from "./actions.js";
import { AutonomousAgent } from "./agent.js";
import { CombatSystem } from "./combat-system.js";
import { config } from "./config.js";
import { ExecutionCoordinator } from "./execution-coordinator.js";
import {
  MineflayerInventorySystem,
  type InventorySystem
} from "./inventory-system.js";
import { MineflayerLootingSystem, type LootingSystem } from "./looting-system.js";
import { MineflayerMiningSystem } from "./mining-system.js";
import { MineflayerBuildingSystem } from "./building-system.js";
import { MineflayerProductionSystem } from "./production-system.js";
import type { EpisodicMemory } from "./memory.js";
import { PathfinderMovementSystem } from "./movement-system.js";
import { Perception } from "./perception.js";
import { parsePlanningCommand } from "./planner-mode.js";
import { OperatorControl } from "./operator-control.js";
import { loadOrCreateOperatorToken } from "./operator-auth.js";
import {
  startOperatorServer,
  type OperatorServer
} from "./operator-server.js";
import { ProjectSystem } from "./project-system.js";
import {
  RecoverySystem,
  shouldRecoverInventory
} from "./recovery-system.js";
import { MineflayerStorageSystem, type StorageSystem } from "./storage-system.js";
import { MineflayerSurvivalSystem, type SurvivalSystem } from "./survival-system.js";
import { startViewerServer, type ViewerServer } from "./viewer-server.js";
import { ViewerStatusStore } from "./viewer-status.js";
import { AcquisitionSystem } from "./acquisition-system.js";

const require = createRequire(import.meta.url);
const { pathfinder } = require(
  "mineflayer-pathfinder"
) as typeof import("mineflayer-pathfinder");
const armorManager = require(
  "mineflayer-armor-manager"
) as import("mineflayer").Plugin;
export class MinecraftRuntime {
  private bot?: Bot;
  private agent?: AutonomousAgent;
  private combatSystem?: CombatSystem;
  private lootingSystem?: LootingSystem;
  private acquisitionSystem?: AcquisitionSystem;
  private projectSystem?: ProjectSystem;
  private recoverySystem?: RecoverySystem;
  private storageSystem?: StorageSystem;
  private survivalSystem?: SurvivalSystem;
  private executionCoordinator?: ExecutionCoordinator;
  private inventorySystem?: InventorySystem;
  private reconnectTimer?: NodeJS.Timeout;
  private viewer?: ViewerServer;
  private operator?: OperatorServer;
  private stopping = false;
  private lastLivingInventory: Array<{ name: string; count: number }> = [];
  private readonly viewerStatus = new ViewerStatusStore();

  constructor(private readonly memory: EpisodicMemory) {}

  start(): void {
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    this.agent?.stop();
    this.combatSystem?.stop();
    this.lootingSystem?.stop();
    this.acquisitionSystem?.stop();
    this.projectSystem?.stop();
    this.recoverySystem?.stop();
    this.storageSystem?.stop();
    this.survivalSystem?.stop();
    this.executionCoordinator?.dispose();
    this.executionCoordinator = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.viewer) void this.viewer.close();
    this.viewer = undefined;
    if (this.operator) void this.operator.close();
    this.operator = undefined;
    this.bot?.quit("Agent shutting down");
  }

  private connect(): void {
    if (this.stopping) return;
    console.log(
      `[runtime] Connecting ${config.minecraft.username} to ${config.minecraft.host}:${config.minecraft.port}`
    );
    this.viewerStatus.setConnection({
      phase: "connecting",
      label: "Connecting",
      detail: `${config.minecraft.host}:${config.minecraft.port}`
    });

    const bot = mineflayer.createBot({
      host: config.minecraft.host,
      port: config.minecraft.port,
      username: config.minecraft.username,
      auth: config.minecraft.auth,
      version: config.minecraft.version,
      profilesFolder: path.join(config.dataDir, "auth")
    });
    this.bot = bot;
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(autoEat);
    bot.loadPlugin(armorManager);
    this.attachLifecycle(bot);
  }

  private attachLifecycle(bot: Bot): void {
    bot.once("spawn", async () => {
      const inventorySystem = new MineflayerInventorySystem(bot);
      this.inventorySystem = inventorySystem;
      const movementSystem = new PathfinderMovementSystem(bot, inventorySystem);
      movementSystem.configureBase();
      const perception = new Perception(
        bot,
        config.perceptionDistance,
        inventorySystem
      );
      const miningSystem = new MineflayerMiningSystem(
        bot,
        perception,
        movementSystem,
        inventorySystem
      );
      const buildingSystem = new MineflayerBuildingSystem(
        bot,
        this.memory,
        perception,
        movementSystem,
        inventorySystem,
        miningSystem
      );
      const productionSystem = new MineflayerProductionSystem(
        bot,
        perception,
        movementSystem,
        inventorySystem
      );
      const survivalSystem = new MineflayerSurvivalSystem(
        bot,
        this.memory,
        perception,
        movementSystem,
        inventorySystem,
        {
          onDanger: () =>
            this.agent?.wakeAutomatically("survival status became dangerous", {
              workloadType: "survival",
              triggerSource: "vitals",
              taskType: "danger_vitals"
            }),
          onVitals: (snapshot) => {
            const livingInventory = aggregateInventory(inventorySystem);
            if (snapshot.health > 0 && livingInventory.length > 0) {
              this.lastLivingInventory = livingInventory;
            }
          }
        }
      );
      this.survivalSystem = survivalSystem;
      movementSystem.setTraversalPlacement(buildingSystem);
      const lootingSystem = new MineflayerLootingSystem(
        bot,
        this.memory,
        perception,
        movementSystem
      );
      this.lootingSystem = lootingSystem;
      lootingSystem.start();
      const executionCoordinator = new ExecutionCoordinator(bot);
      this.executionCoordinator = executionCoordinator;
      survivalSystem.start();
      const combatSystem = new CombatSystem(
        bot,
        this.memory,
        movementSystem,
        perception,
        inventorySystem,
        lootingSystem,
        survivalSystem,
        (activity) => this.viewerStatus.setCombat(activity),
        executionCoordinator.scope(
          "combat",
          () => this.combatSystem?.isActive() ?? false
        )
      );
      this.combatSystem = combatSystem;
      combatSystem.start();
      if (config.viewerEnabled) {
        this.viewer = startViewerServer(bot, {
          host: config.viewerHost,
          port: config.viewerPort,
          viewDistance: config.viewerDistance,
          maxFps: config.viewerMaxFps,
          maxPixelRatio: config.viewerMaxPixelRatio,
          status: () =>
            this.viewerStatus.snapshot(this.memory, this.bot, inventorySystem)
        });
      }
      await bot.waitForChunksToLoad();
      this.viewerStatus.setConnection({
        phase: "online",
        label: "Connected",
        detail: `Playing as ${bot.username}`
      });

      const storageSystem = new MineflayerStorageSystem(
        bot,
        this.memory,
        perception,
        movementSystem,
        inventorySystem,
        (activity) => this.viewerStatus.setWork(activity),
        () =>
          (this.combatSystem?.isActive() ?? false) ||
          (this.recoverySystem?.isActive() ?? false),
        executionCoordinator.scope(
          "storage",
          () => this.storageSystem?.isActive() ?? false
        )
      );
      this.storageSystem = storageSystem;
      const actions = new MinecraftActions(
        bot,
        this.memory,
        perception,
        movementSystem,
        inventorySystem,
        miningSystem,
        buildingSystem,
        productionSystem,
        storageSystem,
        survivalSystem,
        config.maxMoveDistance
      );
      this.recoverySystem = new RecoverySystem(
        bot,
        this.memory,
        movementSystem,
        perception,
        inventorySystem,
        lootingSystem,
        miningSystem,
        storageSystem,
        (activity) => this.viewerStatus.setWork(activity),
        () => this.combatSystem?.isActive() ?? false,
        executionCoordinator.scope(
          "recovery",
          () => this.recoverySystem?.isActive() ?? false
        )
      );
      this.recoverySystem.start();
      storageSystem.start();
      this.agent = new AutonomousAgent(this.memory, perception, actions, {
        apiKey: config.openaiApiKey,
        model: config.openaiModel,
        reasoningEffort: config.reasoningEffort,
        plannerMode: config.plannerMode,
        toolMode: config.plannerToolMode,
        webSearchEnabled: config.webSearchEnabled,
        tickMs: config.tickMs,
        maxToolRounds: config.maxToolRounds,
        maxOutputTokens: config.maxOutputTokens,
        dailyTokenBudget: config.dailyTokenBudget,
        dailyTokenReserve: config.dailyTokenReserve,
        identitySeed: `${config.minecraft.host}:${config.minecraft.port}:${config.minecraft.username}`,
        onActivity: (activity) => this.viewerStatus.setAgent(activity)
      });
      if (config.operatorEnabled) {
        const control = new OperatorControl({
          memory: this.memory,
          inventoryCount: (itemName) => inventorySystem.count(itemName),
          requestPlanning: (task, attribution) =>
            this.agent?.wake(task, attribution),
          plannerMode: config.plannerMode,
          toolMode: config.plannerToolMode,
          model: config.openaiModel
        });
        try {
          this.operator = await startOperatorServer({
            host: config.operatorHost,
            port: config.operatorPort,
            control,
            token: loadOrCreateOperatorToken(
              config.dataDir,
              config.operatorToken
            )
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.memory.record({
            kind: "operator_server_error",
            summary: `Local operator server failed to start: ${message}`,
            importance: 9
          });
          console.error(`[operator] Failed to start: ${message}`);
        }
      }
      this.acquisitionSystem = new AcquisitionSystem(
        this.memory,
        perception,
        movementSystem,
        miningSystem,
        storageSystem,
        survivalSystem,
        config.workExecutorTickMs,
        (reason) =>
          this.agent?.wakeAutomatically(reason, {
            workloadType: "executor_escalation",
            triggerSource: "executor",
            taskType: "work_order"
          }),
        (activity) => {
          if (
            !this.recoverySystem?.isActive() &&
            !this.storageSystem?.isActive() &&
            (activity.phase !== "idle" || !this.memory.activeProject())
          ) {
            this.viewerStatus.setWork(activity);
          }
        },
        () =>
          (this.combatSystem?.isActive() ?? false) ||
          (this.recoverySystem?.isActive() ?? false) ||
          (this.storageSystem?.isActive() ?? false),
        executionCoordinator.scope(
          "work",
          () => this.memory.activeWorkOrder() !== undefined
        )
      );
      this.projectSystem = new ProjectSystem(
        bot,
        this.memory,
        perception,
        movementSystem,
        inventorySystem,
        miningSystem,
        buildingSystem,
        productionSystem,
        storageSystem,
        survivalSystem,
        combatSystem,
        config.workExecutorTickMs,
        (activity) => {
          if (
            !this.recoverySystem?.isActive() &&
            !this.storageSystem?.isActive()
          ) {
            this.viewerStatus.setWork(activity);
          }
        },
        () =>
          (this.combatSystem?.isActive() ?? false) ||
          (this.recoverySystem?.isActive() ?? false) ||
          (this.storageSystem?.isActive() ?? false),
        executionCoordinator.scope(
          "project",
          () => this.memory.activeProject() !== undefined
        )
      );

      const snapshot = perception.observe();
      this.memory.record({
        kind: "spawn",
        summary: `Spawned in ${snapshot.dimension} at ${snapshot.position.x}, ${snapshot.position.y}, ${snapshot.position.z}`,
        payload: snapshot,
        position: snapshot.position,
        dimension: snapshot.dimension,
        importance: 8
      });
      console.log(`[runtime] Spawned as ${bot.username}`);
      console.log(
        `[planner] Mode ${config.plannerMode}` +
          (config.plannerMode === "manual"
            ? "; automatic model wakeups disabled; use !plan <task>"
            : `; scheduled reflection every ${config.tickMs}ms`) +
          `; tools ${config.plannerToolMode}`
      );
      this.agent.start();
      this.acquisitionSystem.start();
      this.projectSystem.start();
    });

    bot.on("chat", (username, message) => {
      if (username === bot.username) return;
      this.memory.record({
        kind: "conversation",
        summary: `${username} said: ${message}`,
        payload: { username, message, channel: "chat" },
        position: bot.entity ? toPosition(bot.entity.position) : undefined,
        dimension: bot.game?.dimension ? String(bot.game.dimension) : undefined,
        actor: username,
        importance: 8
      });
      const command = message.trim().toLowerCase();
      if (command === "!stop" || command === "!pause") {
        const order = this.memory.activeWorkOrder();
        if (order) {
          this.memory.updateWorkOrderStatus(
            order.id,
            "cancelled",
            `Stopped by ${username}`
          );
          bot.chat(`Paused work order ${order.id}.`);
        } else {
          bot.chat("There is no active work order.");
        }
        return;
      }
      const planning = parsePlanningCommand(message);
      if (planning.matched) {
        if (!planning.task) {
          bot.chat("Usage: !plan <task>");
          return;
        }
        this.agent?.wake(
          `${username} said in chat: ${planning.task} (explicit !plan request)`,
          {
            workloadType: "task_planning",
            triggerSource: "chat",
            taskType: "player_request",
            tags: { player: username }
          }
        );
        return;
      }
      this.agent?.wakeAutomatically(`${username} said in chat: ${message}`, {
        workloadType: "conversation",
        triggerSource: "chat",
        taskType: "conversation",
        tags: { player: username }
      });
    });

    bot.on("whisper", (username, message) => {
      this.memory.record({
        kind: "conversation",
        summary: `${username} whispered: ${message}`,
        payload: { username, message, channel: "whisper" },
        position: bot.entity ? toPosition(bot.entity.position) : undefined,
        dimension: bot.game?.dimension ? String(bot.game.dimension) : undefined,
        actor: username,
        importance: 8
      });
      const planning = parsePlanningCommand(message);
      if (planning.matched) {
        if (!planning.task) {
          bot.whisper(username, "Usage: !plan <task>");
          return;
        }
        this.agent?.wake(
          `${username} whispered: ${planning.task} (explicit !plan request)`,
          {
            workloadType: "task_planning",
            triggerSource: "whisper",
            taskType: "player_request",
            tags: { player: username }
          }
        );
        return;
      }
      this.agent?.wakeAutomatically(`${username} whispered: ${message}`, {
        workloadType: "conversation",
        triggerSource: "whisper",
        taskType: "conversation",
        tags: { player: username }
      });
    });

    bot.on("death", () => {
      const position = bot.entity ? toPosition(bot.entity.position) : undefined;
      const dimension = bot.game?.dimension
        ? String(bot.game.dimension)
        : undefined;
      const currentItems = this.inventorySystem
        ? aggregateInventory(this.inventorySystem)
        : [];
      const expectedItems =
        currentItems.length > 0 ? currentItems : this.lastLivingInventory;
      this.memory.record({
        kind: "death",
        summary: "Died",
        payload: { expectedItems },
        position,
        dimension,
        importance: 10
      });
      if (
        position &&
        dimension &&
        shouldRecoverInventory(expectedItems)
      ) {
        const recovery = this.memory.createRecoveryJob(
          position,
          dimension,
          expectedItems
        );
        console.log(
          `[recovery] Queued death-site recovery ${recovery.id} at ${position.x}, ${position.y}, ${position.z}`
        );
      } else if (expectedItems.length > 0) {
        console.log(
          "[recovery] Skipped death-site recovery for trivial bulk materials"
        );
      }
      this.lastLivingInventory = [];
    });

    bot.on("playerJoined", (player) => {
      this.memory.record({
        kind: "player_joined",
        summary: `${player.username} joined the server`,
        actor: player.username,
        importance: 5
      });
    });

    bot.on("playerLeft", (player) => {
      this.memory.record({
        kind: "player_left",
        summary: `${player.username} left the server`,
        actor: player.username,
        importance: 5
      });
    });

    bot.on("kicked", (reason) => {
      const summary = typeof reason === "string" ? reason : JSON.stringify(reason);
      this.memory.record({
        kind: "kicked",
        summary: `Kicked from server: ${summary.slice(0, 1_000)}`,
        importance: 9
      });
      console.error(`[runtime] Kicked: ${summary}`);
    });

    bot.on("error", (error) => {
      this.memory.record({
        kind: "connection_error",
        summary: error.message,
        importance: 8
      });
      console.error(`[runtime] ${error.message}`);
      this.viewerStatus.setConnection({
        phase: "error",
        label: "Connection error",
        detail: error.message
      });
    });

    bot.once("end", (reason) => {
      this.agent?.stop();
      this.combatSystem?.stop();
      this.acquisitionSystem?.stop();
      this.projectSystem?.stop();
      this.recoverySystem?.stop();
      this.storageSystem?.stop();
      this.survivalSystem?.stop();
      this.executionCoordinator?.dispose();
      this.agent = undefined;
      this.combatSystem = undefined;
      this.acquisitionSystem = undefined;
      this.projectSystem = undefined;
      this.recoverySystem = undefined;
      this.storageSystem = undefined;
      this.survivalSystem = undefined;
      this.executionCoordinator = undefined;
      const operator = this.operator;
      this.operator = undefined;
      if (operator) {
        void operator.close().catch((error: unknown) => {
          console.warn(
            `[operator] Cleanup after disconnect failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
      }
      if (this.bot === bot) this.bot = undefined;
      const viewer = this.viewer;
      this.viewer = undefined;
      if (viewer) {
        void viewer.close().catch((error: unknown) => {
          console.warn(
            `[viewer] Cleanup after disconnect failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
      }
      this.viewerStatus.setConnection({
        phase: "connecting",
        label: "Disconnected",
        detail: String(reason)
      });
      this.memory.record({
        kind: "disconnected",
        summary: `Disconnected: ${reason}`,
        importance: 8
      });
      if (!this.stopping) {
        console.log(`[runtime] Reconnecting in ${config.reconnectDelayMs}ms`);
        this.reconnectTimer = setTimeout(() => this.connect(), config.reconnectDelayMs);
      }
    });
  }
}

function toPosition(position: { x: number; y: number; z: number }) {
  return {
    x: Math.round(position.x * 100) / 100,
    y: Math.round(position.y * 100) / 100,
    z: Math.round(position.z * 100) / 100
  };
}

function aggregateInventory(
  inventory: InventorySystem
): Array<{ name: string; count: number }> {
  const totals = new Map<string, number>();
  for (const item of inventory.items()) {
    totals.set(item.name, (totals.get(item.name) ?? 0) + item.count);
  }
  return [...totals.entries()].map(([name, count]) => ({ name, count }));
}
