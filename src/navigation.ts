import type { Position } from "./types.js";
export type { NavigationResult } from "./movement-system.js";

export interface TraversalJournal {
  cells: Position[];
}

export interface ReverseTraversalTarget {
  cursor: number;
  target?: Position;
  complete: boolean;
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

export function spiralOffset(index: number): { x: number; z: number } {
  const n = Math.max(1, Math.floor(index) + 2);
  const ring = Math.ceil((Math.sqrt(n) - 1) / 2);
  const sideLength = ring * 2;
  const maximum = (ring * 2 + 1) ** 2;
  const offset = maximum - n;

  if (offset < sideLength) return { x: ring - offset, z: -ring };
  if (offset < sideLength * 2) {
    return { x: -ring, z: -ring + (offset - sideLength) };
  }
  if (offset < sideLength * 3) {
    return { x: -ring + (offset - sideLength * 2), z: ring };
  }
  return { x: ring, z: ring - (offset - sideLength * 3) };
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
