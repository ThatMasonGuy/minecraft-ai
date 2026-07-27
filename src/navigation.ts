import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { Position } from "./types.js";

const require = createRequire(import.meta.url);
const { goals, Movements } = require(
  "mineflayer-pathfinder"
) as typeof import("mineflayer-pathfinder");
const { GoalBlock, GoalNearXZ } = goals;

export interface TraversalJournal {
  cells: Position[];
}

export type NavigationResult =
  | { status: "reached"; position: Position }
  | {
      status: "blocked";
      position: Position;
      reason: "no_path" | "timeout" | "no_progress" | "wrong_destination";
      detail: string;
    };

export interface ReverseTraversalTarget {
  cursor: number;
  target?: Position;
  complete: boolean;
}

export class DeterministicNavigator {
  constructor(private readonly bot: Bot) {}

  async reachSurfaceArea(
    target: Pick<Position, "x" | "z">,
    range = 4,
    timeoutMs = 45_000,
    noProgressMs = 6_000
  ): Promise<NavigationResult> {
    const previousMovements = this.bot.pathfinder.movements;
    const movements = new Movements(this.bot);
    movements.canDig = false;
    movements.canOpenDoors = true;
    movements.allow1by1towers = false;
    movements.allowParkour = true;
    movements.allowSprinting = true;
    this.bot.pathfinder.setMovements(movements);

    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    let bestDistance = horizontalDistance(this.bot.entity.position, target);
    let lastPathStatus = "waiting";
    let lastPathLength = 0;
    const onPathUpdate = (result: {
      status: string;
      path: unknown[];
    }): void => {
      lastPathStatus = result.status;
      lastPathLength = result.path.length;
    };
    this.bot.on("path_update", onPathUpdate);
    this.bot.pathfinder.setGoal(
      new GoalNearXZ(target.x, target.z, range)
    );
    try {
      while (Date.now() - startedAt < timeoutMs) {
        const position = floorPosition(this.bot.entity.position);
        const currentDistance = horizontalDistance(
          this.bot.entity.position,
          target
        );
        if (currentDistance <= range + 0.75) {
          return { status: "reached", position };
        }
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

  async reachExact(
    target: Position,
    timeoutMs = 8_000
  ): Promise<NavigationResult> {
    const started = floorPosition(this.bot.entity.position);
    if (
      isSingleStepVerticalRejoin(started, target) &&
      (await this.raiseOneBlockWithScaffold(started, target))
    ) {
      return {
        status: "reached",
        position: floorPosition(this.bot.entity.position)
      };
    }
    const startingDistance = distance(started, target);
    const previousMovements = this.bot.pathfinder.movements;
    const movements = new Movements(this.bot);
    movements.canDig = false;
    movements.canOpenDoors = true;
    movements.allow1by1towers = isSingleStepVerticalRejoin(
      started,
      target
    );
    movements.allowParkour = false;
    movements.allowSprinting = false;
    this.bot.pathfinder.setMovements(movements);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.bot.pathfinder.goto(
          new GoalBlock(target.x, target.y, target.z)
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.bot.pathfinder.stop();
            reject(new Error("navigation_timeout"));
          }, timeoutMs);
        })
      ]);
    } catch (error) {
      const position = floorPosition(this.bot.entity.position);
      const detail =
        error instanceof Error ? error.message : String(error);
      return {
        status: "blocked",
        position,
        reason:
          detail === "navigation_timeout"
            ? distance(position, target) < startingDistance
              ? "timeout"
              : "no_progress"
            : "no_path",
        detail
      };
    } finally {
      if (timer) clearTimeout(timer);
      this.bot.pathfinder.stop();
      this.bot.pathfinder.setMovements(previousMovements);
    }

    const position = floorPosition(this.bot.entity.position);
    if (samePosition(position, target)) {
      return { status: "reached", position };
    }
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

  private async raiseOneBlockWithScaffold(
    current: Position,
    target: Position
  ): Promise<boolean> {
    const currentVector = new Vec3(current.x, current.y, current.z);
    const support = this.bot.blockAt(currentVector.offset(0, -1, 0));
    const targetBlock = this.bot.blockAt(
      new Vec3(target.x, target.y, target.z)
    );
    const headBlock = this.bot.blockAt(
      new Vec3(target.x, target.y + 1, target.z)
    );
    const scaffold = this.bot.inventory
      .items()
      .find(
        (item) =>
          item.name === "dirt" ||
          item.name === "cobblestone"
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
      console.warn(
        `[navigation] Cannot scaffold one-block rejoin: support=` +
          `${support?.name ?? "unloaded"}, target=` +
          `${targetBlock?.name ?? "unloaded"}, head=` +
          `${headBlock?.name ?? "unloaded"}, scaffold=` +
          `${scaffold?.name ?? "missing"}`
      );
      return false;
    }

    this.bot.pathfinder.stop();
    this.bot.clearControlStates();
    await this.bot.equip(scaffold, "hand");
    await this.bot.lookAt(
      support.position.offset(0.5, 1, 0.5),
      true
    );
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
      await this.bot.placeBlock(support, new Vec3(0, 1, 0));
    } catch (error) {
      console.warn(
        `[navigation] One-block scaffold placement failed: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    } finally {
      this.bot.setControlState("jump", false);
    }

    const settleDeadline = Date.now() + 1_500;
    while (Date.now() < settleDeadline) {
      if (samePosition(floorPosition(this.bot.entity.position), target)) {
        return true;
      }
      await wait(50);
    }
    console.warn(
      `[navigation] One-block scaffold settled at ` +
        `${this.bot.entity.position.x.toFixed(2)},` +
        `${this.bot.entity.position.y.toFixed(2)},` +
        `${this.bot.entity.position.z.toFixed(2)}`
    );
    return false;
  }
}

export function appendTraversalCell(
  journal: TraversalJournal,
  position: Position,
  maximumCells = 8_192
): boolean {
  const cell = {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z)
  };
  const previous = journal.cells.at(-1);
  if (previous && samePosition(previous, cell)) return false;
  journal.cells.push(cell);
  if (journal.cells.length > maximumCells) {
    journal.cells.splice(0, journal.cells.length - maximumCells);
  }
  return true;
}

export function nextReverseTraversalTarget(
  journal: TraversalJournal,
  current: Position,
  cursor?: number,
  maximumJoinDistance = 2,
  stride = 1
): ReverseTraversalTarget | undefined {
  if (journal.cells.length === 0) return undefined;
  let joinedCursor = cursor;
  let rejoined = false;
  if (
    joinedCursor === undefined ||
    !journal.cells[joinedCursor] ||
    distance(current, journal.cells[joinedCursor]!) > maximumJoinDistance
  ) {
    const candidates = journal.cells
      .map((cell, index) => ({
        index,
        distance: distance(current, cell)
      }))
      .filter((candidate) => candidate.distance <= maximumJoinDistance)
      .sort(
        (a, b) =>
          a.distance - b.distance ||
          b.index - a.index
      );
    joinedCursor = candidates[0]?.index;
    rejoined = joinedCursor !== undefined;
  }
  if (joinedCursor === undefined) return undefined;
  if (rejoined && !samePosition(current, journal.cells[joinedCursor]!)) {
    return {
      cursor: joinedCursor,
      target: journal.cells[joinedCursor],
      complete: false
    };
  }
  if (joinedCursor === 0) {
    if (samePosition(current, journal.cells[0]!)) {
      return { cursor: 0, complete: true };
    }
    return {
      cursor: 0,
      target: journal.cells[0],
      complete: false
    };
  }
  const targetCursor = Math.max(0, joinedCursor - Math.max(1, stride));
  return {
    cursor: targetCursor,
    target: journal.cells[targetCursor],
    complete: false
  };
}

export function isSingleStepVerticalRejoin(
  current: Position,
  target: Position
): boolean {
  return (
    current.x === target.x &&
    current.z === target.z &&
    target.y === current.y + 1
  );
}

export function isCurrentSupportBlock(
  player: Position,
  block: Position
): boolean {
  return (
    Math.floor(player.x) === block.x &&
    Math.floor(player.z) === block.z &&
    Math.floor(player.y) - 1 === block.y
  );
}

function floorPosition(position: {
  x: number;
  y: number;
  z: number;
}): Position {
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z)
  };
}

function samePosition(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function distance(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
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
