import type { Entity } from "prismarine-entity";

const HOSTILE_MOBS = new Set([
  "blaze",
  "bogged",
  "breeze",
  "cave_spider",
  "creaking",
  "creeper",
  "drowned",
  "elder_guardian",
  "endermite",
  "evoker",
  "ghast",
  "guardian",
  "hoglin",
  "husk",
  "magma_cube",
  "phantom",
  "piglin_brute",
  "pillager",
  "ravager",
  "shulker",
  "silverfish",
  "skeleton",
  "slime",
  "spider",
  "stray",
  "vex",
  "vindicator",
  "warden",
  "witch",
  "wither",
  "wither_skeleton",
  "zoglin",
  "zombie",
  "zombie_villager"
]);

export function normalizedEntityName(entity: Entity): string {
  return normalizeEntityName(
    entity.name ?? entity.displayName ?? "mob"
  );
}

export function displayEntityName(entity: Entity): string {
  return normalizedEntityName(entity).replaceAll("_", " ");
}

export function isPlayerEntity(
  entity: Pick<Entity, "type" | "username">
): boolean {
  return entity.type === "player" || Boolean(entity.username);
}

export function isPermittedMobTarget(
  entity: Pick<Entity, "type" | "username">
): boolean {
  return !isPlayerEntity(entity);
}

export function isRecognizedHostileName(name: string | undefined): boolean {
  return name ? HOSTILE_MOBS.has(normalizeEntityName(name)) : false;
}

export function isRecognizedHostile(entity: Entity): boolean {
  return (
    entity.isValid &&
    isPermittedMobTarget(entity) &&
    [entity.name, entity.displayName].some(isRecognizedHostileName)
  );
}

export function droppedItem(
  entity: Pick<Entity, "getDroppedItem">
): ReturnType<Entity["getDroppedItem"]> {
  try {
    return entity.getDroppedItem();
  } catch {
    return null;
  }
}

export function isDroppedItemEntity(
  entity: Pick<Entity, "getDroppedItem">
): boolean {
  return droppedItem(entity) !== null;
}

function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase().replaceAll(" ", "_");
}
