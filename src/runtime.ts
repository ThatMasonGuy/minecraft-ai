import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import mineflayer, { type Bot } from "mineflayer";
import { loader as autoEat } from "mineflayer-auto-eat";
import { MinecraftActions } from "./actions.js";
import { AutonomousAgent } from "./agent.js";
import { config } from "./config.js";
import { DefenseExecutor } from "./defense-executor.js";
import type { EpisodicMemory } from "./memory.js";
import { Perception } from "./perception.js";
import { parsePlanningCommand } from "./planner-mode.js";
import { OperatorControl } from "./operator-control.js";
import {
  startOperatorServer,
  type OperatorServer
} from "./operator-server.js";
import { ProjectExecutor } from "./project-executor.js";
import {
  RecoveryExecutor,
  shouldRecoverInventory
} from "./recovery-executor.js";
import { StorageExecutor } from "./storage-executor.js";
import { startViewerServer, type ViewerServer } from "./viewer-server.js";
import { ViewerStatusStore } from "./viewer-status.js";
import { WorkExecutor } from "./work-executor.js";

const require = createRequire(import.meta.url);
const { Movements, pathfinder } = require(
  "mineflayer-pathfinder"
) as typeof import("mineflayer-pathfinder");
const armorManager = require(
  "mineflayer-armor-manager"
) as import("mineflayer").Plugin;
export class MinecraftRuntime {
  private bot?: Bot;
  private agent?: AutonomousAgent;
  private defenseExecutor?: DefenseExecutor;
  private workExecutor?: WorkExecutor;
  private projectExecutor?: ProjectExecutor;
  private recoveryExecutor?: RecoveryExecutor;
  private storageExecutor?: StorageExecutor;
  private reconnectTimer?: NodeJS.Timeout;
  private viewer?: ViewerServer;
  private operator?: OperatorServer;
  private stopping = false;
  private vitalsDangerous = false;
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
    this.defenseExecutor?.stop();
    this.workExecutor?.stop();
    this.projectExecutor?.stop();
    this.recoveryExecutor?.stop();
    this.storageExecutor?.stop();
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
    this.vitalsDangerous = false;
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
      const movements = new Movements(bot);
      movements.canDig = false;
      movements.canOpenDoors = true;
      movements.allow1by1towers = false;
      movements.allowParkour = false;
      movements.allowSprinting = true;
      bot.pathfinder.setMovements(movements);
      bot.autoEat.setOpts({
        minHunger: 16,
        minHealth: 14,
        priority: "saturation",
        returnToLastItem: true,
        offhand: false,
        bannedFood: [
          "chorus_fruit",
          "poisonous_potato",
          "pufferfish",
          "spider_eye"
        ]
      });
      bot.autoEat.enableAuto();
      const armoredBot = bot as Bot & {
        armorManager: { equipAll: () => Promise<void> };
      };
      void armoredBot.armorManager.equipAll().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[survival] Armour manager failed: ${message}`);
      });
      this.defenseExecutor = new DefenseExecutor(
        bot,
        this.memory,
        (activity) => this.viewerStatus.setDefense(activity)
      );
      this.defenseExecutor.start();
      if (config.viewerEnabled) {
        this.viewer = startViewerServer(bot, {
          port: config.viewerPort,
          viewDistance: config.viewerDistance,
          maxFps: config.viewerMaxFps,
          maxPixelRatio: config.viewerMaxPixelRatio,
          status: () => this.viewerStatus.snapshot(this.memory, this.bot)
        });
      }
      await bot.waitForChunksToLoad();
      this.viewerStatus.setConnection({
        phase: "online",
        label: "Connected",
        detail: `Playing as ${bot.username}`
      });

      const perception = new Perception(bot, config.perceptionDistance);
      const actions = new MinecraftActions(
        bot,
        this.memory,
        perception,
        config.maxMoveDistance
      );
      this.recoveryExecutor = new RecoveryExecutor(
        bot,
        this.memory,
        actions,
        (activity) => this.viewerStatus.setWork(activity),
        () => this.defenseExecutor?.isActive() ?? false
      );
      this.recoveryExecutor.start();
      this.storageExecutor = new StorageExecutor(
        bot,
        this.memory,
        actions,
        (activity) => this.viewerStatus.setWork(activity),
        () =>
          (this.defenseExecutor?.isActive() ?? false) ||
          (this.recoveryExecutor?.isActive() ?? false)
      );
      this.storageExecutor.start();
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
          inventoryCount: (itemName) =>
            bot.inventory
              .items()
              .filter((item) => item.name === itemName)
              .reduce((total, item) => total + item.count, 0),
          requestPlanning: (task) => this.agent?.wake(task),
          plannerMode: config.plannerMode,
          toolMode: config.plannerToolMode,
          model: config.openaiModel
        });
        try {
          this.operator = await startOperatorServer({
            host: config.operatorHost,
            port: config.operatorPort,
            control
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
      this.workExecutor = new WorkExecutor(
        this.memory,
        perception,
        actions,
        config.workExecutorTickMs,
        (reason) => this.agent?.wakeAutomatically(reason),
        (activity) => {
          if (
            !this.recoveryExecutor?.isActive() &&
            !this.storageExecutor?.isActive() &&
            (activity.phase !== "idle" || !this.memory.activeProject())
          ) {
            this.viewerStatus.setWork(activity);
          }
        },
        () =>
          (this.defenseExecutor?.isActive() ?? false) ||
          (this.recoveryExecutor?.isActive() ?? false) ||
          (this.storageExecutor?.isActive() ?? false)
      );
      this.projectExecutor = new ProjectExecutor(
        bot,
        this.memory,
        perception,
        actions,
        config.workExecutorTickMs,
        (activity) => {
          if (
            !this.recoveryExecutor?.isActive() &&
            !this.storageExecutor?.isActive()
          ) {
            this.viewerStatus.setWork(activity);
          }
        },
        () =>
          (this.defenseExecutor?.isActive() ?? false) ||
          (this.recoveryExecutor?.isActive() ?? false) ||
          (this.storageExecutor?.isActive() ?? false)
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
      this.workExecutor.start();
      this.projectExecutor.start();
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
          `${username} said in chat: ${planning.task} (explicit !plan request)`
        );
        return;
      }
      this.agent?.wakeAutomatically(`${username} said in chat: ${message}`);
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
          `${username} whispered: ${planning.task} (explicit !plan request)`
        );
        return;
      }
      this.agent?.wakeAutomatically(`${username} whispered: ${message}`);
    });

    bot.on("health", () => {
      const livingInventory = aggregateInventory(bot);
      if (bot.health > 0 && livingInventory.length > 0) {
        this.lastLivingInventory = livingInventory;
      }
      this.memory.record({
        kind: "vitals",
        summary: `Health ${bot.health}, food ${bot.food}, oxygen ${bot.oxygenLevel}`,
        payload: { health: bot.health, food: bot.food, oxygen: bot.oxygenLevel },
        position: bot.entity ? toPosition(bot.entity.position) : undefined,
        dimension: bot.game?.dimension ? String(bot.game.dimension) : undefined,
        importance: bot.health <= 8 || bot.food <= 6 ? 9 : 4
      });
      const dangerous = bot.health <= 8 || bot.food <= 6;
      if (dangerous && !this.vitalsDangerous) {
        this.agent?.wakeAutomatically("survival status became dangerous");
      }
      this.vitalsDangerous = dangerous;
    });

    bot.on("death", () => {
      const position = bot.entity ? toPosition(bot.entity.position) : undefined;
      const dimension = bot.game?.dimension
        ? String(bot.game.dimension)
        : undefined;
      const currentItems = aggregateInventory(bot);
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
      this.defenseExecutor?.stop();
      this.workExecutor?.stop();
      this.projectExecutor?.stop();
      this.recoveryExecutor?.stop();
      this.storageExecutor?.stop();
      this.agent = undefined;
      this.defenseExecutor = undefined;
      this.workExecutor = undefined;
      this.projectExecutor = undefined;
      this.recoveryExecutor = undefined;
      this.storageExecutor = undefined;
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

function aggregateInventory(bot: Bot): Array<{ name: string; count: number }> {
  const totals = new Map<string, number>();
  for (const item of bot.inventory.items()) {
    totals.set(item.name, (totals.get(item.name) ?? 0) + item.count);
  }
  return [...totals.entries()].map(([name, count]) => ({ name, count }));
}
