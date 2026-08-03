import { z } from "zod";

export interface HouseDesign {
  designName: string;
  footprintRows: string[];
  wallHeight: number;
}

export interface FootprintCell {
  dx: number;
  dz: number;
}

export interface HouseDesignAnalysis {
  width: number;
  depth: number;
  cells: FootprintCell[];
  cellKeys: Set<string>;
  boundaryCells: FootprintCell[];
  interiorCells: FootprintCell[];
  door: FootprintCell;
}

export const houseDesignSchema = z
  .object({
    designName: z.string().min(1).max(80),
    footprintRows: z
      .array(z.string().regex(/^[.#D]+$/).min(3).max(15))
      .min(3)
      .max(15),
    wallHeight: z.number().int().min(3).max(6)
  })
  .superRefine((design, context) => {
    for (const message of validateFootprint(design.footprintRows)) {
      context.addIssue({
        code: "custom",
        path: ["footprintRows"],
        message
      });
    }
  });

export function parseHouseDesign(input: unknown): HouseDesign {
  return houseDesignSchema.parse(input);
}

export function analyzeHouseDesign(input: HouseDesign): HouseDesignAnalysis {
  const design = parseHouseDesign(input);
  const cells: FootprintCell[] = [];
  let door: FootprintCell | undefined;
  for (const [dz, row] of design.footprintRows.entries()) {
    for (const [dx, marker] of [...row].entries()) {
      if (marker === ".") continue;
      const cell = { dx, dz };
      cells.push(cell);
      if (marker === "D") door = cell;
    }
  }
  const cellKeys = new Set(cells.map(cellKey));
  const boundaryCells = cells.filter((cell) =>
    neighbours(cell).some((neighbour) => !cellKeys.has(cellKey(neighbour)))
  );
  const interiorCells = cells.filter((cell) =>
    neighbours(cell).every((neighbour) => cellKeys.has(cellKey(neighbour)))
  );
  return {
    width: design.footprintRows[0]!.length,
    depth: design.footprintRows.length,
    cells,
    cellKeys,
    boundaryCells,
    interiorCells,
    door: door!
  };
}

function validateFootprint(rows: string[]): string[] {
  const errors: string[] = [];
  const width = rows[0]?.length ?? 0;
  if (rows.some((row) => row.length !== width)) {
    errors.push("All footprint rows must have the same width");
    return errors;
  }

  const cells: FootprintCell[] = [];
  const doors: FootprintCell[] = [];
  for (const [dz, row] of rows.entries()) {
    for (const [dx, marker] of [...row].entries()) {
      if (marker === ".") continue;
      const cell = { dx, dz };
      cells.push(cell);
      if (marker === "D") doors.push(cell);
    }
  }
  if (cells.length < 9) errors.push("Footprint must contain at least 9 occupied cells");
  if (cells.length > 200) errors.push("Footprint may contain at most 200 occupied cells");
  if (doors.length !== 1) errors.push("Footprint must contain exactly one D entrance cell");
  if (cells.length === 0) return errors;

  const keys = new Set(cells.map(cellKey));
  const visited = new Set<string>();
  const queue = [cells[0]!];
  while (queue.length > 0) {
    const cell = queue.shift()!;
    const key = cellKey(cell);
    if (visited.has(key)) continue;
    visited.add(key);
    for (const neighbour of neighbours(cell)) {
      if (keys.has(cellKey(neighbour))) queue.push(neighbour);
    }
  }
  if (visited.size !== cells.length) {
    errors.push("Every occupied footprint cell must be orthogonally connected");
  }

  const interior = cells.filter((cell) =>
    neighbours(cell).every((neighbour) => keys.has(cellKey(neighbour)))
  );
  if (interior.length === 0) {
    errors.push("Footprint must contain at least one interior cell");
  }
  const door = doors[0];
  if (door) {
    const adjacent = neighbours(door);
    if (!adjacent.some((neighbour) => keys.has(cellKey(neighbour)))) {
      errors.push("Entrance must connect to the occupied footprint");
    }
    if (!adjacent.some((neighbour) => !keys.has(cellKey(neighbour)))) {
      errors.push("Entrance must be on the exterior boundary");
    }
  }
  return errors;
}

function neighbours(cell: FootprintCell): FootprintCell[] {
  return [
    { dx: cell.dx - 1, dz: cell.dz },
    { dx: cell.dx + 1, dz: cell.dz },
    { dx: cell.dx, dz: cell.dz - 1 },
    { dx: cell.dx, dz: cell.dz + 1 }
  ];
}

function cellKey(cell: FootprintCell): string {
  return `${cell.dx},${cell.dz}`;
}
