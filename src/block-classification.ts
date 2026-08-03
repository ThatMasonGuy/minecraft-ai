const REPLACEABLE_BLOCKS = new Set([
  "air",
  "cave_air",
  "void_air",
  "grass",
  "short_grass",
  "tall_grass",
  "fern",
  "large_fern",
  "dead_bush",
  "snow"
]);

export function isReplaceableBlockName(name: string): boolean {
  return REPLACEABLE_BLOCKS.has(name);
}

export function isFallingBlockName(name: string): boolean {
  return name === "sand" || name === "red_sand" || name === "gravel";
}

export function isProtectedExcavationBlockName(name: string): boolean {
  return (
    name.endsWith("_door") ||
    name.endsWith("_trapdoor") ||
    name.endsWith("_fence_gate") ||
    name.endsWith("_bed") ||
    name === "chest" ||
    name === "trapped_chest" ||
    name === "barrel" ||
    name === "crafting_table" ||
    name === "furnace" ||
    name === "blast_furnace" ||
    name === "smoker"
  );
}
