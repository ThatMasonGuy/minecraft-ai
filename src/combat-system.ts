import { randomUUID } from "node:crypto";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { ExecutionScope } from "./execution-coordinator.js";
import {
  displayEntityName,
  isPlayerEntity,
  isRecognizedHostile,
  normalizedEntityName
} from "./entity-classification.js";
import type {
  CombatMovementSystem,
  MovementDanger
} from "./movement-system.js";
import type { Position } from "./types.js";
import type { SensingSystem } from "./perception.js";
import type { InventorySystem } from "./inventory-system.js";
import type { LootingSystem } from "./looting-system.js";
import type { SurvivalSystem } from "./survival-system.js";
import type { TelemetrySystem } from "./telemetry-system.js";

const ATTACK_RANGE = 3.15;
const FOLLOW_RANGE = 2.7;
const STRIKE_SPACING_DISTANCE = 4.5;
const MOB_ESCAPE_DISTANCE = 10;
const RANGED_ESCAPE_DISTANCE = 24;
const PLAYER_ESCAPE_DISTANCE = 18;
const MAX_PURSUIT_DISTANCE = 16;
const PASSIVE_SCAN_INTERVAL_MS = 250;
const CONTACT_TIMEOUT_MS = 15_000;
const PLAYER_HIT_WINDOW_MS = 30_000;
const MINIMUM_ESCAPE_MS = 2_000;
const ESCAPE_QUIET_MS = 4_000;
const RECOVERY_TIMEOUT_MS = 12_000;
const POST_ESCAPE_SUPPRESSION_MS = 5_000;
const DEFEATED_TARGET_SUPPRESSION_MS = 5_000;
const LOOT_COLLECTION_MS = 8_000;
const LOOT_SEARCH_RADIUS = 8;
const COMBAT_LOOT_SESSION = "combat";

const ALWAYS_ESCAPE = new Set([
  "blaze",
  "breeze",
  "creeper",
  "elder_guardian",
  "evoker",
  "ghast",
  "guardian",
  "hoglin",
  "magma_cube",
  "phantom",
  "piglin_brute",
  "pillager",
  "ravager",
  "shulker",
  "vex",
  "vindicator",
  "warden",
  "witch",
  "wither",
  "zoglin"
]);
const RANGED_HOSTILES = new Set(["bogged", "skeleton", "stray"]);
const UNARMED_FIGHT_TARGETS = new Set(["zombie", "zombie_villager"]);
const LONG_RANGE_HOSTILES = new Set([
  ...RANGED_HOSTILES,
  "blaze",
  "breeze",
  "elder_guardian",
  "ghast",
  "guardian",
  "pillager",
  "shulker",
  "witch"
]);

export type CombatMode =
  | "idle"
  | "pursuing"
  | "striking"
  | "spacing"
  | "escaping"
  | "recovering"
  | "looting";

export interface CombatAssessment {
  targetName: string;
  health: number;
  armorPieces: number;
  nearbyHostiles: number;
  weaponName?: string;
  hasShield: boolean;
}

export type CombatDecision =
  | { action: "fight" }
  | { action: "escape"; reason: string };

export type CombatEngagementResult =
  | "engaged"
  | "busy"
  | "unavailable"
  | "rejected";

interface PlayerHitRecord {
  count: number;
  lastHitAt: number;
}

interface EncounterTelemetry {
  id: string;
  startedAt: number;
  trigger: string;
  targetName: string;
  targetType: "mob" | "player";
  initialHealth: number;
  minimumHealth: number;
  weaponName?: string;
  swings: number;
  confirmedHits: number;
}

interface CombatItem {
  name: string;
}

export class CombatSystem {
  private mode: CombatMode = "idle";
  private target?: Entity;
  private playerAggressor?: Entity;
  private encounter?: EncounterTelemetry;
  private ticking = false;
  private lastScanAt = 0;
  private lastContactAt = 0;
  private lastSwingAt = 0;
  private nextAttackAt = 0;
  private escapeStartedAt = 0;
  private recoveryStartedAt = 0;
  private passiveScanSuppressedUntil = 0;
  private shieldRaised = false;
  private playerHits = new Map<string, PlayerHitRecord>();
  private recentlyDefeated = new Map<number, number>();
  private lootUntil = 0;
  private lootOrigin?: Entity["position"];

  constructor(
    private readonly bot: Bot,
    private readonly telemetry: TelemetrySystem,
    private readonly movement: CombatMovementSystem,
    private readonly sensing: SensingSystem,
    private readonly inventory: InventorySystem,
    private readonly looting: LootingSystem,
    private readonly survival: SurvivalSystem,
    private readonly execution?: ExecutionScope
  ) {}

  start(): void {
    this.bot.on("physicsTick", this.scopedPhysicsTick);
    this.bot.on("entityHurt", this.scopedEntityHurt);
    this.bot.on("entityDead", this.scopedEntityDead);
    this.bot.on("entityGone", this.scopedEntityGone);
    this.bot.on("death", this.scopedDeath);
  }

  stop(): void {
    this.bot.removeListener("physicsTick", this.scopedPhysicsTick);
    this.bot.removeListener("entityHurt", this.scopedEntityHurt);
    this.bot.removeListener("entityDead", this.scopedEntityDead);
    this.bot.removeListener("entityGone", this.scopedEntityGone);
    this.bot.removeListener("death", this.scopedDeath);
    const cleanup = () => this.resetToIdle("Combat system stopped", false);
    if (this.execution) this.execution.runSync(cleanup);
    else cleanup();
  }

  isActive(): boolean {
    return this.mode !== "idle";
  }

  currentMode(): CombatMode {
    return this.mode;
  }

  engageVisibleMob(entityId: number, reason: string): CombatEngagementResult {
    if (this.isActive()) return "busy";
    const target = this.sensing.entityById(entityId);
    if (!target || !target.isValid || !this.sensing.hasLineOfSight(target)) {
      return "unavailable";
    }
    if (isPlayerEntity(target)) return "rejected";
    this.beginMobEncounter(target, reason);
    const decision = this.assess(target, this.visibleHostiles());
    if (decision.action === "escape") {
      this.startEscape(target, decision.reason);
    }
    return "engaged";
  }

  private readonly scopedPhysicsTick = (): void => {
    if (this.execution) void this.execution.run(() => this.tick());
    else void this.tick();
  };

  private readonly scopedEntityHurt = (
    entity: Entity | undefined,
    source: Entity | undefined
  ): void => {
    this.runOwnedSync(() => this.onEntityHurt(entity, source));
  };

  private readonly scopedEntityDead = (entity: Entity): void => {
    this.runOwnedSync(() => this.onEntityDead(entity));
  };

  private readonly scopedEntityGone = (entity: Entity): void => {
    this.runOwnedSync(() => this.onEntityGone(entity));
  };

  private readonly scopedDeath = (): void => {
    this.runOwnedSync(() => {
      this.finishEncounter("defeat", "The bot died during the encounter");
      this.resetToIdle("Respawning after combat defeat", false);
    });
  };

  private runOwnedSync(task: () => void): void {
    if (this.execution) this.execution.runSync(task);
    else task();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.expirePlayerHitRecords();
      this.expireRecentlyDefeated();
      if (this.encounter) {
        this.encounter.minimumHealth = Math.min(
          this.encounter.minimumHealth,
          this.survival.snapshot().health
        );
      }
      switch (this.mode) {
        case "idle":
          await this.tickIdle();
          break;
        case "pursuing":
        case "striking":
        case "spacing":
          await this.tickFight();
          break;
        case "escaping":
          await this.tickEscape();
          break;
        case "recovering":
          this.tickRecovery();
          break;
        case "looting":
          await this.tickLooting();
          break;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.telemetry.activity("combat", {
        phase: "error",
        label: "Combat system error",
        detail
      });
      this.finishEncounter("error", detail);
      this.startEscape(undefined, `Combat system error: ${detail}`);
    } finally {
      this.ticking = false;
    }
  }

  private async tickIdle(): Promise<void> {
    const now = Date.now();
    if (now < this.passiveScanSuppressedUntil) return;
    if (now - this.lastScanAt < PASSIVE_SCAN_INTERVAL_MS) return;
    this.lastScanAt = now;
    const threats = this.visibleHostiles();
    const target = threats[0];
    if (!target) return;
    this.beginMobEncounter(target, "A visible hostile entered combat range");
    const decision = this.assess(target, threats);
    if (decision.action === "escape") {
      this.startEscape(target, decision.reason);
      return;
    }
    await this.prepareToFight();
    this.mode = "pursuing";
  }

  private async tickFight(): Promise<void> {
    const target = this.target;
    if (!target || !target.isValid) {
      this.finishEncounter("target_lost", "The target is no longer visible");
      this.resetToIdle("The immediate threat passed");
      return;
    }

    const threats = this.visibleHostiles();
    const decision = this.assess(target, threats);
    if (decision.action === "escape") {
      this.startEscape(target, decision.reason);
      return;
    }

    const distance = this.bot.entity.position.distanceTo(target.position);
    if (distance > MAX_PURSUIT_DISTANCE) {
      this.finishEncounter("disengaged", "The target left the pursuit boundary");
      this.resetToIdle("Stopped at the combat pursuit limit");
      return;
    }
    if (Date.now() - this.lastContactAt > CONTACT_TIMEOUT_MS) {
      this.finishEncounter("disengaged", "No combat contact was confirmed");
      this.resetToIdle("The immediate threat passed");
      return;
    }

    await this.prepareToFight();
    if (this.mode === "spacing") {
      if (
        distance >= STRIKE_SPACING_DISTANCE ||
        Date.now() >= this.nextAttackAt - 125
      ) {
        this.mode = "pursuing";
      } else {
        this.raiseShield();
        this.movement.escape({
          dangers: threats.map(toMovementDanger),
          safeDistance: STRIKE_SPACING_DISTANCE
        });
        return;
      }
    }

    if (distance > ATTACK_RANGE) {
      this.raiseShield();
      this.movement.follow(target, FOLLOW_RANGE);
      this.mode = "pursuing";
      return;
    }

    if (Date.now() < this.nextAttackAt) {
      this.raiseShield();
      if (distance < 2.7) {
        this.mode = "spacing";
        this.movement.escape({
          dangers: threats.map(toMovementDanger),
          safeDistance: STRIKE_SPACING_DISTANCE
        });
      } else {
        this.movement.hold();
      }
      return;
    }

    await this.performAttack(target);
  }

  private async tickEscape(): Promise<void> {
    this.survival.resumeAutoCare();
    const dangers = this.currentEscapeDangers();
    const safeDistance = this.escapeSafeDistance();
    const result = this.movement.escape({ dangers, safeDistance });
    const elapsed = Date.now() - this.escapeStartedAt;
    const quietFor = Date.now() - this.lastContactAt;
    const safeByCover = this.hasCoverFromRangedThreat();

    if (
      (result.status === "safe" || safeByCover) &&
      elapsed >= MINIMUM_ESCAPE_MS &&
      quietFor >= ESCAPE_QUIET_MS
    ) {
      this.mode = "recovering";
      this.recoveryStartedAt = Date.now();
      this.movement.hold();
      this.telemetry.activity("combat", {
        phase: "waiting",
        label: "Recovering after escape",
        detail: "Holding a safe gap before returning to ordinary work"
      });
      return;
    }

    if (result.status === "blocked") {
      this.telemetry.activity("combat", {
        phase: "acting",
        label: "Escaping combat",
        detail: result.detail
      });
      await this.tryDefensiveShove();
    }
  }

  private tickRecovery(): void {
    const hostiles = this.visibleHostiles();
    const playerTooClose =
      this.playerAggressor?.isValid &&
      this.bot.entity.position.distanceTo(this.playerAggressor.position) <
        PLAYER_ESCAPE_DISTANCE;
    if (hostiles.length > 0 || playerTooClose) {
      const threat = playerTooClose ? this.playerAggressor : hostiles[0];
      this.startEscape(
        threat,
        "A threat remained visible during combat recovery"
      );
      return;
    }

    this.movement.hold();
    this.survival.resumeAutoCare();
    const recovered = this.survival.snapshot().combatReady;
    const timedOut = Date.now() - this.recoveryStartedAt >= RECOVERY_TIMEOUT_MS;
    if (!recovered && !timedOut) return;

    this.finishEncounter(
      "escaped",
      recovered
        ? "Reached safety and recovered combat readiness"
        : "Reached safety; recovery window elapsed"
    );
    this.passiveScanSuppressedUntil = Date.now() + POST_ESCAPE_SUPPRESSION_MS;
    this.resetToIdle("Safe after combat escape");
  }

  private async tickLooting(): Promise<void> {
    const threat = this.visibleHostiles()[0];
    if (threat) {
      this.finishLooting();
      this.beginMobEncounter(threat, "A hostile interrupted post-combat recovery");
      const decision = this.assess(threat, this.visibleHostiles());
      if (decision.action === "escape") this.startEscape(threat, decision.reason);
      else {
        await this.prepareToFight();
        this.mode = "pursuing";
      }
      return;
    }

    if (Date.now() >= this.lootUntil || !this.lootOrigin) {
      this.finishLooting();
      return;
    }
    const result = this.looting.collectStep({
      sessionId: COMBAT_LOOT_SESSION,
      origin: toPosition(this.lootOrigin),
      radius: LOOT_SEARCH_RADIUS
    });
    if (result.status === "clear") {
      this.finishLooting();
      return;
    }
    if (result.status !== "moving") return;
    this.telemetry.activity("combat", {
      phase: "acting",
      label: "Collecting combat drops",
      detail: result.displayName ?? result.itemName ?? "Nearby drops"
    });
  }

  private onEntityHurt(
    entity: Entity | undefined,
    source: Entity | undefined
  ): void {
    if (!entity) return;
    if (entity.id === this.bot.entity.id) {
      if (source && isPlayerEntity(source)) {
        this.onPlayerAggression(source);
        return;
      }
      const threat =
        source && isRecognizedHostile(source)
          ? source
          : this.visibleHostiles()[0];
      if (!threat) return;
      this.lastContactAt = Date.now();
      if (this.mode === "escaping") return;
      if (this.mode === "recovering") {
        this.startEscape(threat, "The bot took damage while recovering");
        return;
      }
      if (this.target && this.target.id !== threat.id) {
        this.startEscape(
          this.target,
          "An additional hostile joined the encounter"
        );
        return;
      }
      if (this.target?.id !== threat.id) {
        this.beginMobEncounter(threat, "The bot took hostile damage");
      }
      const decision = this.assess(threat, this.visibleHostiles());
      if (decision.action === "escape") this.startEscape(threat, decision.reason);
      return;
    }

    if (
      entity.id === this.target?.id &&
      Date.now() - this.lastSwingAt <= 750
    ) {
      this.lastContactAt = Date.now();
      if (this.encounter) this.encounter.confirmedHits += 1;
    }
  }

  private onPlayerAggression(player: Entity): void {
    const now = Date.now();
    const key = player.username ?? String(player.id);
    const previous = this.playerHits.get(key);
    const count =
      previous && now - previous.lastHitAt <= PLAYER_HIT_WINDOW_MS
        ? previous.count + 1
        : 1;
    this.playerHits.set(key, { count, lastHitAt: now });

    if (count < 2) {
      this.telemetry.record({
        kind: "combat_warning",
        summary: `${player.username ?? "A player"} hit the bot; player combat remains disabled`,
        payload: { player: player.username, hitCount: count },
        position: toPosition(this.bot.entity.position),
        dimension: String(this.bot.game.dimension ?? "unknown"),
        actor: player.username,
        importance: 8
      });
      return;
    }

    if (this.encounter) {
      this.finishEncounter(
        "interrupted",
        "A player attacked twice; combat policy requires escape"
      );
    }
    this.playerAggressor = player;
    this.beginEncounter(
      player.username ?? "player",
      "player",
      "A player hit the bot twice"
    );
    this.startEscape(
      player,
      `${player.username ?? "A player"} hit twice; escaping without retaliation`
    );
  }

  private onEntityDead(entity: Entity): void {
    if (entity.id !== this.target?.id) return;
    this.recentlyDefeated.set(
      entity.id,
      Date.now() + DEFEATED_TARGET_SUPPRESSION_MS
    );
    this.finishEncounter("victory", `${displayEntityName(entity)} was defeated`);
    this.target = undefined;
    if (this.mode === "escaping" || this.mode === "recovering") return;
    this.beginLooting();
  }

  private onEntityGone(entity: Entity): void {
    if (entity.id === this.target?.id) {
      this.finishEncounter("target_lost", `${displayEntityName(entity)} left perception`);
      this.target = undefined;
      if (this.mode !== "escaping" && this.mode !== "recovering") {
        this.resetToIdle("The immediate threat passed");
      }
    }
    if (entity.id === this.playerAggressor?.id) {
      this.playerAggressor = undefined;
    }
  }

  private beginMobEncounter(target: Entity, trigger: string): void {
    if (this.target?.id === target.id && this.encounter) return;
    if (this.encounter) {
      this.finishEncounter("switched_target", "A more immediate threat took priority");
    }
    this.target = target;
    this.playerAggressor = undefined;
    this.mode = "pursuing";
    this.beginEncounter(displayEntityName(target), "mob", trigger);
    this.lastContactAt = Date.now();
  }

  private beginEncounter(
    targetName: string,
    targetType: "mob" | "player",
    trigger: string
  ): void {
    this.encounter = {
      id: randomUUID(),
      startedAt: Date.now(),
      trigger,
      targetName,
      targetType,
      initialHealth: this.survival.snapshot().health,
      minimumHealth: this.survival.snapshot().health,
      swings: 0,
      confirmedHits: 0
    };
    this.execution?.claim();
    this.telemetry.activity("combat", {
      phase: "acting",
      label: `Responding to ${targetName}`,
      detail: trigger
    });
    this.telemetry.record({
      kind: "combat",
      summary: `Combat response started for ${targetName}: ${trigger}`,
      payload: {
        encounterId: this.encounter.id,
        targetName,
        targetType,
        trigger
      },
      position: toPosition(this.bot.entity.position),
      dimension: String(this.bot.game.dimension ?? "unknown"),
      importance: targetType === "player" ? 10 : 8
    });
  }

  private finishEncounter(outcome: string, detail: string): void {
    const encounter = this.encounter;
    if (!encounter) return;
    this.telemetry.record({
      kind: "combat",
      summary: `Combat response ended for ${encounter.targetName}: ${outcome}`,
      payload: {
        encounterId: encounter.id,
        targetName: encounter.targetName,
        targetType: encounter.targetType,
        trigger: encounter.trigger,
        outcome,
        detail,
        durationMs: Date.now() - encounter.startedAt,
        initialHealth: encounter.initialHealth,
        minimumHealth: encounter.minimumHealth,
        endingHealth: this.survival.snapshot().health,
        weaponName: encounter.weaponName,
        swings: encounter.swings,
        confirmedHits: encounter.confirmedHits
      },
      position: toPosition(this.bot.entity.position),
      dimension: String(this.bot.game.dimension ?? "unknown"),
      importance: outcome === "victory" || outcome === "escaped" ? 7 : 9
    });
    this.encounter = undefined;
  }

  private assess(target: Entity, threats: Entity[]): CombatDecision {
    const weapon = selectBestWeapon(this.inventory.items());
    return decideCombat({
      targetName: normalizedEntityName(target),
      health: this.survival.snapshot().health,
      armorPieces: equippedArmorPieces(this.inventory),
      nearbyHostiles: threats.filter(
        (entity) => this.bot.entity.position.distanceTo(entity.position) <= 8
      ).length,
      weaponName: weapon?.name,
      hasShield: hasInventoryItem(this.inventory, "shield")
    });
  }

  private async prepareToFight(): Promise<void> {
    this.survival.suspendAutoCare();
    const weapon = selectBestWeapon(this.inventory.items());
    if (!weapon) return;
    if (this.inventory.heldItem()?.name !== weapon.name) {
      await this.inventory.equip(weapon, "hand");
    }
    const shield = this.inventory.find("shield");
    if (shield && !this.hasEquippedShield()) {
      await this.inventory.equip(shield, "off-hand");
    }
    if (this.encounter) this.encounter.weaponName = weapon.name;
  }

  private async performAttack(target: Entity): Promise<void> {
    this.mode = "striking";
    this.movement.hold();
    this.lowerShield();
    await this.movement.face(
      target.position.offset(0, Math.max(0.5, target.height / 2), 0)
    );
    if (
      !target.isValid ||
      this.bot.entity.position.distanceTo(target.position) > ATTACK_RANGE + 0.25
    ) {
      this.mode = "pursuing";
      return;
    }
    this.bot.attack(target);
    this.lastSwingAt = Date.now();
    this.lastContactAt = this.lastSwingAt;
    const weaponName = this.inventory.heldItem()?.name;
    this.nextAttackAt = this.lastSwingAt + attackCooldownMs(weaponName);
    if (this.encounter) {
      this.encounter.swings += 1;
      this.encounter.weaponName = weaponName;
    }
    this.mode = "spacing";
  }

  private startEscape(aggressor: Entity | undefined, reason: string): void {
    if (aggressor && isPlayerEntity(aggressor)) {
      this.playerAggressor = aggressor;
      this.target = undefined;
    } else if (aggressor && isRecognizedHostile(aggressor)) {
      this.target = aggressor;
    }
    this.mode = "escaping";
    this.escapeStartedAt = Date.now();
    this.lowerShield();
    this.survival.resumeAutoCare();
    this.execution?.claim();
    this.telemetry.activity("combat", {
      phase: "acting",
      label: this.playerAggressor
        ? "Escaping player aggression"
        : "Escaping unsafe combat",
      detail: reason
    });
  }

  private currentEscapeDangers(): MovementDanger[] {
    const entities = this.visibleHostiles();
    if (this.target?.isValid) entities.push(this.target);
    if (this.playerAggressor?.isValid) entities.push(this.playerAggressor);
    const unique = new Map<number, Entity>();
    for (const entity of entities) unique.set(entity.id, entity);
    return [...unique.values()].map(toMovementDanger);
  }

  private escapeSafeDistance(): number {
    if (this.playerAggressor?.isValid) return PLAYER_ESCAPE_DISTANCE;
    const threats = this.visibleHostiles();
    if (this.target?.isValid) threats.push(this.target);
    return threats.some((entity) =>
      LONG_RANGE_HOSTILES.has(normalizedEntityName(entity))
    )
      ? RANGED_ESCAPE_DISTANCE
      : MOB_ESCAPE_DISTANCE;
  }

  private hasCoverFromRangedThreat(): boolean {
    if (!this.target?.isValid) return false;
    if (!LONG_RANGE_HOSTILES.has(normalizedEntityName(this.target))) return false;
    return !this.hasLineOfSight(this.target) && this.visibleHostiles().length === 0;
  }

  private async tryDefensiveShove(): Promise<void> {
    if (this.survival.isEating()) return;
    const threat = this.visibleHostiles()
      .filter(
        (entity) => this.bot.entity.position.distanceTo(entity.position) <= 2.8
      )
      .sort(
        (a, b) =>
          this.bot.entity.position.distanceTo(a.position) -
          this.bot.entity.position.distanceTo(b.position)
      )[0];
    if (!threat || Date.now() < this.nextAttackAt) return;
    await this.movement.face(
      threat.position.offset(0, Math.max(0.5, threat.height / 2), 0)
    );
    this.bot.attack(threat);
    this.lastSwingAt = Date.now();
    this.nextAttackAt =
      this.lastSwingAt + attackCooldownMs(this.inventory.heldItem()?.name);
    if (this.encounter) this.encounter.swings += 1;
  }

  private visibleHostiles(): Entity[] {
    const origin = this.bot.entity.position;
    return this.sensing
      .visibleEntitiesRaw(MAX_PURSUIT_DISTANCE)
      .filter(isRecognizedHostile)
      .filter(
        (entity) => (this.recentlyDefeated.get(entity.id) ?? 0) <= Date.now()
      )
      .filter(
        (entity) =>
          origin.distanceTo(entity.position) <=
          threatAcquisitionRange(normalizedEntityName(entity))
      )
      .filter((entity) => this.hasLineOfSight(entity))
      .sort(
        (a, b) =>
          threatPriority(normalizedEntityName(b)) -
            threatPriority(normalizedEntityName(a)) ||
          origin.distanceTo(a.position) - origin.distanceTo(b.position)
      );
  }

  private hasLineOfSight(entity: Entity): boolean {
    return this.sensing.hasLineOfSight(entity);
  }

  private beginLooting(): void {
    this.lowerShield();
    this.survival.resumeAutoCare();
    this.mode = "looting";
    this.lootOrigin = this.bot.entity.position.clone();
    this.lootUntil = Date.now() + LOOT_COLLECTION_MS;
    this.looting.endSession(COMBAT_LOOT_SESSION);
  }

  private finishLooting(): void {
    this.lootUntil = 0;
    this.lootOrigin = undefined;
    this.looting.endSession(COMBAT_LOOT_SESSION);
    this.resetToIdle("Post-combat area is clear");
  }

  private resetToIdle(detail: string, report = true): void {
    this.movement.hold();
    this.lowerShield();
    this.survival.resumeAutoCare();
    this.mode = "idle";
    this.target = undefined;
    this.playerAggressor = undefined;
    this.escapeStartedAt = 0;
    this.recoveryStartedAt = 0;
    this.nextAttackAt = 0;
    if (report) {
      this.telemetry.activity("combat", {
        phase: "idle",
        label: "No immediate combat threat",
        detail
      });
    }
    this.execution?.release();
  }

  private raiseShield(): void {
    if (this.shieldRaised || !this.hasEquippedShield()) return;
    this.bot.activateItem(true);
    this.shieldRaised = true;
  }

  private lowerShield(): void {
    if (!this.shieldRaised) return;
    this.bot.deactivateItem();
    this.shieldRaised = false;
  }

  private hasEquippedShield(): boolean {
    return this.inventory.equipment("off-hand")?.name === "shield";
  }

  private expirePlayerHitRecords(): void {
    const cutoff = Date.now() - PLAYER_HIT_WINDOW_MS;
    for (const [key, record] of this.playerHits) {
      if (record.lastHitAt < cutoff) this.playerHits.delete(key);
    }
  }

  private expireRecentlyDefeated(): void {
    const now = Date.now();
    for (const [entityId, expiresAt] of this.recentlyDefeated) {
      if (expiresAt <= now) this.recentlyDefeated.delete(entityId);
    }
  }
}

export function decideCombat(assessment: CombatAssessment): CombatDecision {
  const targetName = normalizeName(assessment.targetName);
  if (ALWAYS_ESCAPE.has(targetName)) {
    return { action: "escape", reason: `${targetName} requires an escape response` };
  }
  if (
    (!assessment.weaponName || !weaponProfile(assessment.weaponName)) &&
    !UNARMED_FIGHT_TARGETS.has(targetName)
  ) {
    return { action: "escape", reason: "No effective melee weapon is carried" };
  }
  const minimumHealth = assessment.armorPieces >= 3 ? 10 : 13;
  if (assessment.health <= minimumHealth) {
    return {
      action: "escape",
      reason: `Health ${assessment.health.toFixed(1)} is below the safe fight threshold`
    };
  }
  if (assessment.nearbyHostiles > 1) {
    return {
      action: "escape",
      reason: `${assessment.nearbyHostiles} nearby hostiles exceed the single-target combat policy`
    };
  }
  if (RANGED_HOSTILES.has(targetName) && !assessment.hasShield) {
    return {
      action: "escape",
      reason: `No shield is available for the ranged ${targetName}`
    };
  }
  return { action: "fight" };
}

export function selectBestWeapon<T extends CombatItem>(items: T[]): T | undefined {
  return items
    .map((item, index) => ({ item, index, profile: weaponProfile(item.name) }))
    .filter(
      (entry): entry is { item: T; index: number; profile: WeaponProfile } =>
        Boolean(entry.profile)
    )
    .sort(
      (a, b) =>
        b.profile.score - a.profile.score ||
        b.profile.damage - a.profile.damage ||
        a.index - b.index
    )[0]?.item;
}

export function attackCooldownMs(weaponName: string | undefined): number {
  if (!weaponName) return 725;
  const attacksPerSecond = weaponProfile(weaponName)?.speed ?? 4;
  return Math.ceil(20 / attacksPerSecond) * 50 + 25;
}

interface WeaponProfile {
  damage: number;
  speed: number;
  score: number;
}

function weaponProfile(name: string | undefined): WeaponProfile | undefined {
  if (!name) return undefined;
  const explicit: Record<string, [number, number]> = {
    trident: [9, 1.1],
    wooden_axe: [7, 0.8],
    golden_axe: [7, 1],
    copper_axe: [9, 0.9],
    stone_axe: [9, 0.8],
    iron_axe: [9, 0.9],
    diamond_axe: [9, 1],
    netherite_axe: [10, 1]
  };
  const swordDamage: Record<string, number> = {
    wooden_sword: 4,
    golden_sword: 4,
    copper_sword: 5,
    stone_sword: 5,
    iron_sword: 6,
    diamond_sword: 7,
    netherite_sword: 8
  };
  const values = explicit[name] ??
    (swordDamage[name] ? [swordDamage[name]!, 1.6] : undefined);
  if (!values) return undefined;
  const [damage, speed] = values;
  return { damage, speed, score: damage * speed };
}

function equippedArmorPieces(inventory: InventorySystem): number {
  return (["head", "torso", "legs", "feet"] as const).filter(
    (destination) => Boolean(inventory.equipment(destination))
  ).length;
}

function hasInventoryItem(inventory: InventorySystem, name: string): boolean {
  return Boolean(inventory.find(name) || inventory.equipment("off-hand")?.name === name);
}

function threatAcquisitionRange(name: string): number {
  if (name === "phantom" || RANGED_HOSTILES.has(name)) return 16;
  if (name === "creeper") return 7;
  return 10;
}

function threatPriority(name: string): number {
  if (name === "creeper") return 100;
  if (name === "phantom") return 90;
  if (RANGED_HOSTILES.has(name)) return 80;
  return 50;
}

function toMovementDanger(entity: Entity): MovementDanger {
  return { position: entity.position };
}

function toPosition(position: Entity["position"]): Position {
  return {
    x: Math.round(position.x * 100) / 100,
    y: Math.round(position.y * 100) / 100,
    z: Math.round(position.z * 100) / 100
  };
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replaceAll(" ", "_");
}
