import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { Position } from "./types.js";

const require = createRequire(import.meta.url);
const { goals } = require(
  "mineflayer-pathfinder"
) as typeof import("mineflayer-pathfinder");
const { GoalFollow, GoalNear } = goals;

const ESCAPE_RADII = [4, 6, 8, 10, 12];
const ESCAPE_DIRECTIONS = 16;
const ESCAPE_REPLAN_MS = 500;
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

export interface EscapeRequest {
  dangers: MovementDanger[];
  safeDistance: number;
}

export type EscapeResult =
  | { status: "safe" }
  | { status: "moving"; destination: Position }
  | { status: "blocked"; detail: string };

/**
 * Public movement contract consumed by combat and other deterministic systems.
 * Callers choose the movement outcome; this system owns Pathfinder goals and
 * escape-route selection.
 */
export interface MovementSystem {
  follow(entity: Entity, range: number): void;
  approach(position: Position, range: number): void;
  hold(): void;
  escape(request: EscapeRequest): EscapeResult;
}

export class PathfinderMovementSystem implements MovementSystem {
  private mode: "idle" | "follow" | "approach" | "escape" = "idle";
  private targetKey?: string;
  private lastEscapePlanAt = 0;

  constructor(private readonly bot: Bot) {}

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

  hold(): void {
    if (this.mode === "idle") return;
    this.bot.pathfinder.setGoal(null);
    this.bot.clearControlStates();
    this.mode = "idle";
    this.targetKey = undefined;
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
    if (
      this.mode === "escape" &&
      this.targetKey &&
      now - this.lastEscapePlanAt < ESCAPE_REPLAN_MS
    ) {
      const destination = parsePositionKey(this.targetKey);
      if (destination) return { status: "moving", destination };
    }

    const destination = selectEscapeDestination(
      current,
      request.dangers,
      (candidate) => this.isSafeDestination(candidate)
    );
    if (!destination) {
      this.hold();
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
    this.lastEscapePlanAt = now;
    return { status: "moving", destination };
  }

  private isSafeDestination(position: Position): boolean {
    const feetPosition = new Vec3(position.x, position.y, position.z);
    const feet = this.bot.blockAt(feetPosition);
    const head = this.bot.blockAt(feetPosition.offset(0, 1, 0));
    const floor = this.bot.blockAt(feetPosition.offset(0, -1, 0));
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
      const position = {
        x: Math.round(start.x + Math.cos(angle) * radius),
        y: start.y,
        z: Math.round(start.z + Math.sin(angle) * radius)
      };
      if (!isSafe(position)) continue;
      const distances = dangers.map((danger) =>
        distance(position, danger.position)
      );
      const minimum = Math.min(...distances);
      if (minimum <= currentMinimum + 0.5) continue;
      const average = distances.reduce((sum, value) => sum + value, 0) / distances.length;
      candidates.push({
        position,
        score: minimum * 10 + average - distance(start, position) * 0.05
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score)[0]?.position;
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
