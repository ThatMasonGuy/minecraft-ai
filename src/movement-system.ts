import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { Position } from "./types.js";
import type { InventorySystem } from "./inventory-system.js";
import type { SensingSystem } from "./perception.js";

const require = createRequire(import.meta.url);
const { goals, Movements } = require(
  "mineflayer-pathfinder"
) as typeof import("mineflayer-pathfinder");
const { GoalBlock, GoalFollow, GoalLookAtBlock, GoalNear, GoalNearXZ, GoalXZ } = goals;

const ESCAPE_RADII = [4, 6, 8, 10, 12];
const ESCAPE_DIRECTIONS = 16;
const ESCAPE_STALL_MS = 4_000;
const ESCAPE_PROGRESS_DISTANCE = 0.75;
const ESCAPE_REJECT_MS = 15_000;
const ESCAPE_GOAL_REACHED_DISTANCE = 1.5;
const ESCAPE_GOAL_ADVANTAGE = 0.5;
const HAZARDOUS_FEET_BLOCKS = new Set([
  "cactus",
  "campfire",
  "fire",
  "lava",
  "magma_block",
  "powder_snow",
  "soul_campfire",
  "sweet_berry_bush",
  "water",
  "withering_rose"
]);
const HAZARDOUS_FLOOR_BLOCKS = new Set([
  "cactus",
  "campfire",
  "fire",
  "lava",
  "magma_block",
  "powder_snow",
  "soul_campfire",
  "sweet_berry_bush",
  "water",
  "withering_rose"
]);

export interface MovementDanger {
  position: Pick<Position, "x" | "y" | "z">;
}

export interface TraversalPlacement {
  placeTraversalBlock(
    reference: Position,
    face: Position,
    itemName: string
  ): Promise<boolean>;
}

export interface EscapeRequest {
  dangers: MovementDanger[];
  safeDistance: number;
}

export type EscapeResult =
  | { status: "safe" }
  | { status: "moving"; destination: Position }
  | { status: "blocked"; detail: string };

export type NavigationResult =
  | { status: "reached"; position: Position }
  | {
      status: "blocked";
      position: Position;
      reason: "no_path" | "timeout" | "no_progress" | "wrong_destination";
      detail: string;
    };

/**
 * Public movement contract consumed by combat and other deterministic systems.
 * Callers choose the movement outcome; this system owns Pathfinder goals and
 * escape-route selection.
 */
export interface MovementSystem {
  setTraversalPlacement(placement: TraversalPlacement): void;
  configureBase(): void;
  follow(entity: Entity, range: number): void;
  approach(position: Position, range: number): void;
  approachXZ(position: Pick<Position, "x" | "z">): void;
  goNear(position: Position, range: number, timeoutMs?: number): Promise<void>;
  goToBlock(position: Position, timeoutMs?: number): Promise<void>;
  goToXZ(position: Pick<Position, "x" | "z">, timeoutMs?: number): Promise<void>;
  positionForBlock(position: Position, reach?: number, timeoutMs?: number): Promise<void>;
  face(position: Position | Vec3, force?: boolean): Promise<void>;
  stepToAdjacent(position: Position, jump?: boolean): Promise<void>;
  reachSurfaceArea(
    target: Pick<Position, "x" | "z">,
    range?: number,
    timeoutMs?: number,
    noProgressMs?: number
  ): Promise<NavigationResult>;
  reachExact(target: Position, timeoutMs?: number): Promise<NavigationResult>;
  hold(): void;
  escape(request: EscapeRequest): EscapeResult;
}

export type CombatMovementSystem = Pick<
  MovementSystem,
  "follow" | "approach" | "face" | "hold" | "escape"
>;

export class PathfinderMovementSystem implements MovementSystem {
  private mode: "idle" | "follow" | "approach" | "escape" = "idle";
  private targetKey?: string;
  private lastEscapeProgressAt = 0;
  private lastEscapePosition?: Position;
  private readonly rejectedEscapeTargets = new Map<string, number>();
  private traversalPlacement?: TraversalPlacement;

  constructor(
    private readonly bot: Bot,
    private readonly inventory: InventorySystem,
    private readonly sensing: SensingSystem
  ) {}

  configureBase(): void {
    const movements = new Movements(this.bot);
    configureGroundMovements(movements);
    this.bot.pathfinder.setMovements(movements);
  }

  setTraversalPlacement(placement: TraversalPlacement): void {
    this.traversalPlacement = placement;
  }

  follow(entity: Entity, range: number): void {
    const key = `${entity.id}:${range}`;
    if (this.mode === "follow" && this.targetKey === key) return;
    this.bot.pathfinder.setGoal(new GoalFollow(entity, range), true);
    this.mode = "follow";
    this.targetKey = key;
  }

  approach(position: Position, range: number): void {
    const target = floorPosition(position);
    const key = `${target.x}:${target.y}:${target.z}:${range}`;
    if (this.mode === "approach" && this.targetKey === key) return;
    this.bot.pathfinder.setGoal(
      new GoalNear(target.x, target.y, target.z, range)
    );
    this.mode = "approach";
    this.targetKey = key;
  }

  approachXZ(position: Pick<Position, "x" | "z">): void {
    const key = `${Math.floor(position.x)}:${Math.floor(position.z)}`;
    if (this.mode === "approach" && this.targetKey === key) return;
    this.bot.pathfinder.setGoal(new GoalXZ(position.x, position.z));
    this.mode = "approach";
    this.targetKey = key;
  }

  async goNear(position: Position, range: number, timeoutMs = 45_000): Promise<void> {
    await this.withTimeout(
      this.bot.pathfinder.goto(
        new GoalNear(position.x, position.y, position.z, range)
      ),
      timeoutMs
    );
  }

  async goToBlock(position: Position, timeoutMs = 45_000): Promise<void> {
    await this.withTimeout(
      this.bot.pathfinder.goto(new GoalBlock(position.x, position.y, position.z)),
      timeoutMs
    );
  }

  async goToXZ(
    position: Pick<Position, "x" | "z">,
    timeoutMs = 45_000
  ): Promise<void> {
    await this.withTimeout(
      this.bot.pathfinder.goto(new GoalXZ(position.x, position.z)),
      timeoutMs
    );
  }

  async positionForBlock(
    position: Position,
    reach = 4.5,
    timeoutMs = 30_000
  ): Promise<void> {
    await this.withTimeout(
      this.bot.pathfinder.goto(
        new GoalLookAtBlock(
          new Vec3(position.x, position.y, position.z),
          this.bot.world,
          { reach }
        )
      ),
      timeoutMs
    );
  }

  async face(position: Position | Vec3, force = true): Promise<void> {
    await this.bot.lookAt(new Vec3(position.x, position.y, position.z), force);
  }

  async stepToAdjacent(position: Position, jump = false): Promise<void> {
    const target = new Vec3(position.x, position.y, position.z);
    const previousMovements = this.bot.pathfinder.movements;
    const movements = new Movements(this.bot);
    configureGroundMovements(movements);
    movements.allowSprinting = false;
    this.hold();
    this.bot.pathfinder.setMovements(movements);
    try {
      try {
        await this.withTimeout(
          this.bot.pathfinder.goto(
            new GoalBlock(position.x, position.y, position.z)
          ),
          4_000
        );
        if (this.bot.entity.position.floored().equals(target)) return;
      } catch {
        // Tight stair geometry can require a bounded direct-control finish.
      }
    } finally {
      this.bot.pathfinder.stop();
      this.bot.pathfinder.setMovements(previousMovements);
    }

    this.bot.clearControlStates();
    await this.bot.lookAt(target.offset(0.5, 1, 0.5), true);
    this.bot.setControlState("forward", true);
    if (jump) {
      await wait(100);
      this.bot.setControlState("jump", true);
    }
    try {
      const deadline = Date.now() + 3_000;
      let bestHorizontalDistance = Number.POSITIVE_INFINITY;
      while (
        Date.now() < deadline &&
        !this.bot.entity.position.floored().equals(target)
      ) {
        const horizontalDistance = Math.hypot(
          this.bot.entity.position.x - (target.x + 0.5),
          this.bot.entity.position.z - (target.z + 0.5)
        );
        bestHorizontalDistance = Math.min(bestHorizontalDistance, horizontalDistance);
        if (bestHorizontalDistance < 0.35 && horizontalDistance > 0.55) break;
        await wait(50);
      }
    } finally {
      this.bot.setControlState("forward", false);
      this.bot.setControlState("jump", false);
    }
    const reached = this.bot.entity.position.floored();
    if (!reached.equals(target)) {
      throw new Error(
        `adjacent movement reached ${reached.x},${reached.y},${reached.z}; ` +
          `expected ${target.x},${target.y},${target.z}`
      );
    }
  }

  async reachSurfaceArea(
    target: Pick<Position, "x" | "z">,
    range = 4,
    timeoutMs = 45_000,
    noProgressMs = 6_000
  ): Promise<NavigationResult> {
    const previousMovements = this.bot.pathfinder.movements;
    const movements = new Movements(this.bot);
    configureGroundMovements(movements);
    this.bot.pathfinder.setMovements(movements);

    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    let bestDistance = horizontalDistance(this.bot.entity.position, target);
    let lastPathStatus = "waiting";
    let lastPathLength = 0;
    const onPathUpdate = (result: { status: string; path: unknown[] }): void => {
      lastPathStatus = result.status;
      lastPathLength = result.path.length;
    };
    this.bot.on("path_update", onPathUpdate);
    this.bot.pathfinder.setGoal(new GoalNearXZ(target.x, target.z, range));
    try {
      while (Date.now() - startedAt < timeoutMs) {
        const position = floorPosition(this.bot.entity.position);
        const currentDistance = horizontalDistance(this.bot.entity.position, target);
        if (currentDistance <= range + 0.75) return { status: "reached", position };
        if (currentDistance < bestDistance - 0.2) {
          bestDistance = currentDistance;
          lastProgressAt = Date.now();
        } else if (Date.now() - lastProgressAt >= noProgressMs) {
          return {
            status: "blocked",
            position,
            reason: "no_progress",
            detail:
              `Made no surface-route progress for ` +
              `${Math.ceil(noProgressMs / 1_000)} seconds ` +
              `(path ${lastPathStatus}, ${lastPathLength} nodes)`
          };
        }
        await wait(250);
      }
      return {
        status: "blocked",
        position: floorPosition(this.bot.entity.position),
        reason: "timeout",
        detail: `Surface route timed out after ${Math.ceil(timeoutMs / 1_000)} seconds`
      };
    } finally {
      this.bot.removeListener("path_update", onPathUpdate);
      this.bot.pathfinder.stop();
      this.bot.pathfinder.setMovements(previousMovements);
    }
  }

  async reachExact(target: Position, timeoutMs = 8_000): Promise<NavigationResult> {
    const started = floorPosition(this.bot.entity.position);
    if (
      isSingleStepVerticalRejoin(started, target) &&
      (await this.raiseOneBlockWithScaffold(started, target))
    ) {
      return { status: "reached", position: floorPosition(this.bot.entity.position) };
    }
    const startingDistance = distance(started, target);
    try {
      await this.goToBlock(target, timeoutMs);
    } catch (error) {
      const position = floorPosition(this.bot.entity.position);
      const detail = error instanceof Error ? error.message : String(error);
      return {
        status: "blocked",
        position,
        reason:
          detail === "movement_timeout"
            ? distance(position, target) < startingDistance
              ? "timeout"
              : "no_progress"
            : "no_path",
        detail
      };
    }
    const position = floorPosition(this.bot.entity.position);
    if (samePosition(position, target)) return { status: "reached", position };
    return {
      status: "blocked",
      position,
      reason:
        distance(position, target) < startingDistance
          ? "wrong_destination"
          : "no_progress",
      detail:
        `Reached ${position.x},${position.y},${position.z}; expected ` +
        `${target.x},${target.y},${target.z}`
    };
  }

  hold(): void {
    if (this.mode === "idle") return;
    this.bot.pathfinder.setGoal(null);
    this.bot.clearControlStates();
    this.mode = "idle";
    this.targetKey = undefined;
    this.resetEscapeTracking();
  }

  escape(request: EscapeRequest): EscapeResult {
    const current = this.bot.entity.position;
    if (request.dangers.length === 0) {
      this.hold();
      return { status: "safe" };
    }
    if (minimumDangerDistance(current, request.dangers) >= request.safeDistance) {
      this.hold();
      return { status: "safe" };
    }

    const now = Date.now();
    this.updateEscapeProgress(current, now);
    if (this.mode === "escape" && this.targetKey) {
      const destination = parsePositionKey(this.targetKey);
      if (
        destination &&
        isUsefulEscapeDestination(current, destination, request.dangers)
      ) {
        return { status: "moving", destination };
      }
      this.targetKey = undefined;
    }

    const destination = selectEscapeDestination(
      current,
      request.dangers,
      (candidate) =>
        !this.isRejectedEscapeTarget(candidate, now) &&
        this.isSafeDestination(candidate)
    );
    if (!destination) {
      this.bot.pathfinder.setGoal(null);
      this.bot.clearControlStates();
      this.mode = "escape";
      this.targetKey = undefined;
      return {
        status: "blocked",
        detail: "No loaded, passable escape destination increased threat separation"
      };
    }

    this.bot.pathfinder.setGoal(
      new GoalNear(destination.x, destination.y, destination.z, 1)
    );
    this.mode = "escape";
    this.targetKey = positionKey(destination);
    return { status: "moving", destination };
  }

  private updateEscapeProgress(
    current: Pick<Position, "x" | "y" | "z">,
    now: number
  ): void {
    for (const [key, expiresAt] of this.rejectedEscapeTargets) {
      if (expiresAt <= now) this.rejectedEscapeTargets.delete(key);
    }
    const position = toPosition(current);
    if (this.mode !== "escape" || !this.lastEscapePosition) {
      this.lastEscapePosition = position;
      this.lastEscapeProgressAt = now;
      return;
    }
    if (distance(position, this.lastEscapePosition) >= ESCAPE_PROGRESS_DISTANCE) {
      this.lastEscapePosition = position;
      this.lastEscapeProgressAt = now;
      return;
    }
    if (
      this.targetKey &&
      now - this.lastEscapeProgressAt >= ESCAPE_STALL_MS
    ) {
      this.rejectedEscapeTargets.set(
        this.targetKey,
        now + ESCAPE_REJECT_MS
      );
      this.bot.pathfinder.setGoal(null);
      this.targetKey = undefined;
      this.lastEscapePosition = position;
      this.lastEscapeProgressAt = now;
    }
  }

  private isRejectedEscapeTarget(position: Position, now: number): boolean {
    return (this.rejectedEscapeTargets.get(positionKey(position)) ?? 0) > now;
  }

  private resetEscapeTracking(): void {
    this.lastEscapeProgressAt = 0;
    this.lastEscapePosition = undefined;
    this.rejectedEscapeTargets.clear();
  }

  private async withTimeout(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.bot.pathfinder.stop();
            reject(new Error("movement_timeout"));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async raiseOneBlockWithScaffold(
    current: Position,
    target: Position
  ): Promise<boolean> {
    const currentVector = new Vec3(current.x, current.y, current.z);
    const support = this.sensing.blockAt(currentVector.offset(0, -1, 0));
    const targetBlock = this.sensing.blockAt(new Vec3(target.x, target.y, target.z));
    const headBlock = this.sensing.blockAt(new Vec3(target.x, target.y + 1, target.z));
    const scaffold = this.inventory.findFirst(
      (item) => item.name === "dirt" || item.name === "cobblestone"
    );
    if (
      !support ||
      support.boundingBox === "empty" ||
      !targetBlock ||
      targetBlock.boundingBox !== "empty" ||
      !headBlock ||
      headBlock.boundingBox !== "empty" ||
      !scaffold
    ) {
      return false;
    }

    this.hold();
    await this.inventory.equip(scaffold, "hand");
    await this.bot.lookAt(support.position.offset(0.5, 1, 0.5), true);
    this.bot.setControlState("jump", true);
    try {
      const jumpDeadline = Date.now() + 1_000;
      while (
        Date.now() < jumpDeadline &&
        this.bot.entity.position.y < current.y + 0.45
      ) {
        await wait(25);
      }
      if (this.bot.entity.position.y < current.y + 0.45) return false;
      if (
        !this.traversalPlacement ||
        !(await this.traversalPlacement.placeTraversalBlock(
          toPosition(support.position),
          { x: 0, y: 1, z: 0 },
          scaffold.name
        ))
      ) {
        return false;
      }
    } catch {
      return false;
    } finally {
      this.bot.setControlState("jump", false);
    }

    const settleDeadline = Date.now() + 1_500;
    while (Date.now() < settleDeadline) {
      if (samePosition(floorPosition(this.bot.entity.position), target)) return true;
      await wait(50);
    }
    return false;
  }

  private isSafeDestination(position: Position): boolean {
    const feetPosition = new Vec3(position.x, position.y, position.z);
    const feet = this.sensing.blockAt(feetPosition);
    const head = this.sensing.blockAt(feetPosition.offset(0, 1, 0));
    const floor = this.sensing.blockAt(feetPosition.offset(0, -1, 0));
    return Boolean(
      feet &&
        head &&
        floor &&
        feet.boundingBox === "empty" &&
        head.boundingBox === "empty" &&
        floor.boundingBox !== "empty" &&
        !HAZARDOUS_FEET_BLOCKS.has(feet.name) &&
        !HAZARDOUS_FEET_BLOCKS.has(head.name) &&
        !HAZARDOUS_FLOOR_BLOCKS.has(floor.name)
    );
  }
}

function isUsefulEscapeDestination(
  current: Pick<Position, "x" | "y" | "z">,
  destination: Position,
  dangers: MovementDanger[]
): boolean {
  if (distance(current, destination) <= ESCAPE_GOAL_REACHED_DISTANCE) {
    return false;
  }
  return (
    minimumDangerDistance(destination, dangers) >=
    minimumDangerDistance(current, dangers) + ESCAPE_GOAL_ADVANTAGE
  );
}

export function selectEscapeDestination(
  origin: Pick<Position, "x" | "y" | "z">,
  dangers: MovementDanger[],
  isSafe: (position: Position) => boolean
): Position | undefined {
  if (dangers.length === 0) return floorPosition(origin);
  const start = floorPosition(origin);
  const currentMinimum = minimumDangerDistance(start, dangers);
  const candidates: Array<{ position: Position; score: number }> = [];

  for (const radius of ESCAPE_RADII) {
    for (let index = 0; index < ESCAPE_DIRECTIONS; index += 1) {
      const angle = (index / ESCAPE_DIRECTIONS) * Math.PI * 2;
      const horizontal = {
        x: Math.round(start.x + Math.cos(angle) * radius),
        z: Math.round(start.z + Math.sin(angle) * radius)
      };
      for (const yOffset of escapeCandidateYOffsets()) {
        const position = { ...horizontal, y: start.y + yOffset };
        if (!isSafe(position)) continue;
        const distances = dangers.map((danger) =>
          distance(position, danger.position)
        );
        const minimum = Math.min(...distances);
        if (minimum <= currentMinimum + 0.5) continue;
        const average = distances.reduce((sum, value) => sum + value, 0) / distances.length;
        candidates.push({
          position,
          score:
            minimum * 10 +
            average -
            horizontalDistance(start, position) * 0.05 -
            Math.abs(yOffset) * 0.2
        });
        break;
      }
    }
  }

  return candidates.sort((a, b) => b.score - a.score)[0]?.position;
}

export function escapeCandidateYOffsets(maxOffset = 6): number[] {
  const offsets = [0];
  for (let offset = 1; offset <= maxOffset; offset += 1) {
    offsets.push(offset, -offset);
  }
  return offsets;
}

function configureGroundMovements(movements: InstanceType<typeof Movements>): void {
  movements.canDig = false;
  movements.canOpenDoors = true;
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  movements.allowSprinting = true;
  // Water remains traversable, but dry routes and prompt shore exits are
  // strongly preferred over repeated short swims and direction reversals.
  (movements as InstanceType<typeof Movements> & { liquidCost: number }).liquidCost = 8;
}

function minimumDangerDistance(
  position: Pick<Position, "x" | "y" | "z">,
  dangers: MovementDanger[]
): number {
  return Math.min(
    ...dangers.map((danger) => distance(position, danger.position))
  );
}

function distance(
  a: Pick<Position, "x" | "y" | "z">,
  b: Pick<Position, "x" | "y" | "z">
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function floorPosition(
  position: Pick<Position, "x" | "y" | "z">
): Position {
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z)
  };
}

function positionKey(position: Position): string {
  return `${position.x}:${position.y}:${position.z}`;
}

function parsePositionKey(key: string): Position | undefined {
  const [x, y, z] = key.split(":").map(Number);
  if (![x, y, z].every(Number.isFinite)) return undefined;
  return { x: x!, y: y!, z: z! };
}

function samePosition(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function isSingleStepVerticalRejoin(current: Position, target: Position): boolean {
  return (
    current.x === target.x &&
    current.z === target.z &&
    target.y === current.y + 1
  );
}

function horizontalDistance(
  a: Pick<Position, "x" | "z">,
  b: Pick<Position, "x" | "z">
): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function toPosition(position: Pick<Position, "x" | "y" | "z">): Position {
  return { x: position.x, y: position.y, z: position.z };
}
