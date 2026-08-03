import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { isReplaceableBlockName } from "./block-classification.js";
import type { InventorySystem } from "./inventory-system.js";
import type { BuildingPersistence } from "./persistence-ports.js";
import type { MiningSystem } from "./mining-system.js";
import type { MovementSystem, TraversalPlacement } from "./movement-system.js";
import type { SensedBlock, SensingSystem } from "./perception.js";
import { absolutePosition } from "./project-plan.js";
import type { BlueprintPlacement, Position } from "./types.js";

export type PlacementResult =
  | { status: "placed"; itemName: string; position: Position; block: SensedBlock }
  | { status: "already_present"; itemName: string; position: Position; block: SensedBlock }
  | { status: "blocked"; itemName: string; position: Position; detail: string };

export interface BuildingSystem extends TraversalPlacement {
  placeAgainst(
    reference: Position,
    face: Position,
    itemName: string,
    requireVisible?: boolean
  ): Promise<PlacementResult>;
  placeAt(anchor: Position, placement: BlueprintPlacement): Promise<PlacementResult>;
  placeOnFloor(position: Position, itemName: string): Promise<PlacementResult>;
  placeNearby(itemName: string, origin?: Position, radius?: number): Promise<PlacementResult>;
  buildStairLanding(position: Position): Promise<boolean>;
}

export class MineflayerBuildingSystem implements BuildingSystem {
  constructor(
    private readonly bot: Bot,
    private readonly memory: BuildingPersistence,
    private readonly sensing: SensingSystem,
    private readonly movement: MovementSystem,
    private readonly inventory: InventorySystem,
    private readonly mining: MiningSystem
  ) {}

  async placeAgainst(
    referencePosition: Position,
    face: Position,
    itemName: string,
    requireVisible = false
  ): Promise<PlacementResult> {
    const target = {
      x: referencePosition.x + face.x,
      y: referencePosition.y + face.y,
      z: referencePosition.z + face.z
    };
    const item = this.inventory.find(itemName);
    if (!item) return blocked(itemName, target, `${itemName} is missing`);
    if (requireVisible) await this.movement.positionForBlock(referencePosition);
    const reference = this.sensing.blockAt(
      referencePosition,
      requireVisible ? "visible" : "loaded"
    );
    if (!reference) return blocked(itemName, target, "reference block is unavailable");
    await this.inventory.equip(item, "hand");
    await this.movement.face({ x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 });
    try {
      await this.bot.placeBlock(reference, new Vec3(face.x, face.y, face.z));
    } catch (error) {
      return blocked(
        itemName,
        target,
        error instanceof Error ? error.message : String(error)
      );
    }
    return this.verify(itemName, target);
  }

  async placeAt(anchor: Position, placement: BlueprintPlacement): Promise<PlacementResult> {
    const target = absolutePosition(anchor, placement);
    const targetVector = new Vec3(target.x, target.y, target.z);
    let existing = this.sensing.blockAt(target);
    if (existing?.name === placement.itemName) {
      return { status: "already_present", itemName: placement.itemName, position: target, block: existing };
    }
    if (existing && !isReplaceableBlockName(existing.name)) {
      return blocked(placement.itemName, target, `target contains ${existing.name}`);
    }
    if (existing && existing.name !== "air") {
      const clearing = await this.mining.mineBlock({
        position: target,
        approach: false,
        collectAfter: false
      });
      if (clearing.status === "blocked") {
        return blocked(placement.itemName, target, clearing.detail);
      }
      existing = this.sensing.blockAt(target);
    }

    if (this.bot.entity.position.floored().equals(targetVector)) {
      await this.movement.goNear(
        { x: anchor.x - 2, y: anchor.y, z: anchor.z - 2 },
        1
      );
    }
    const references = [
      { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
      { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
      { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
      { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
      { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
      { offset: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) }
    ]
      .map((candidate) => ({
        ...candidate,
        block: this.sensing.blockAt(targetVector.plus(candidate.offset))
      }))
      .find((candidate) => isSolid(candidate.block));
    if (!references?.block) {
      return blocked(placement.itemName, target, "no adjacent support block");
    }
    await this.movement.goNear(
      { x: target.x, y: Math.min(target.y, anchor.y), z: target.z },
      3
    );
    const item = this.inventory.find(placement.itemName);
    if (!item) return blocked(placement.itemName, target, `${placement.itemName} is missing`);
    await this.inventory.equip(item, "hand");
    await this.movement.face(targetVector.offset(0.5, 0.5, 0.5));
    try {
      await this.bot.placeBlock(references.block, references.face);
    } catch (error) {
      return blocked(
        placement.itemName,
        target,
        error instanceof Error ? error.message : String(error)
      );
    }
    const result = this.verify(placement.itemName, target);
    if (result.status === "placed" && isStorageBlock(placement.itemName)) {
      this.memory.registerOwnedContainer(
        target,
        String(this.bot.game?.dimension),
        placement.itemName,
        `${placement.itemName.replaceAll("_", " ")} for ${this.memory.activeProject()?.title ?? "project"}`
      );
    }
    return result;
  }

  async placeOnFloor(position: Position, itemName: string): Promise<PlacementResult> {
    const body = this.sensing.blockAt(position);
    const floor = this.sensing.blockAt({ x: position.x, y: position.y - 1, z: position.z });
    if (!body || !isReplaceableBlockName(body.name) || !isSolid(floor)) {
      return blocked(itemName, position, "target does not have a clear body and solid floor");
    }
    if (!floor) return blocked(itemName, position, "floor is unavailable");
    return this.placeAgainst(
      { x: floor.position.x, y: floor.position.y, z: floor.position.z },
      { x: 0, y: 1, z: 0 },
      itemName
    );
  }

  async placeNearby(
    itemName: string,
    origin: Position = toPosition(this.bot.entity.position.floored()),
    radius = 3
  ): Promise<PlacementResult> {
    if (!this.inventory.find(itemName)) {
      return blocked(itemName, origin, `${itemName} is missing`);
    }
    for (const dy of [0, 1, -1]) {
      for (let distance = 1; distance <= radius; distance += 1) {
        for (let dx = -distance; dx <= distance; dx += 1) {
          const dz = distance - Math.abs(dx);
          for (const signedZ of dz === 0 ? [0] : [dz, -dz]) {
            const result = await this.placeOnFloor(
              { x: origin.x + dx, y: origin.y + dy, z: origin.z + signedZ },
              itemName
            );
            if (result.status !== "blocked") return result;
          }
        }
      }
    }
    return blocked(itemName, origin, `no valid nearby placement for ${itemName}`);
  }

  async buildStairLanding(position: Position): Promise<boolean> {
    const result = await this.placeOnFloor(position, "cobblestone");
    if (result.status === "blocked") return false;
    await this.movement.stepToAdjacent(
      { x: position.x, y: position.y + 1, z: position.z },
      true
    );
    return true;
  }

  async placeTraversalBlock(
    reference: Position,
    face: Position,
    itemName: string
  ): Promise<boolean> {
    return (await this.placeAgainst(reference, face, itemName)).status !== "blocked";
  }

  private verify(itemName: string, position: Position): PlacementResult {
    const placed = this.sensing.blockAt(position);
    if (!placed || placed.name !== itemName) {
      return blocked(
        itemName,
        position,
        `placement verification found ${placed?.name ?? "unloaded block"}`
      );
    }
    return { status: "placed", itemName, position, block: placed };
  }
}

function isSolid(block: SensedBlock | undefined): block is SensedBlock {
  return Boolean(block && block.boundingBox !== "empty");
}

function isStorageBlock(name: string): boolean {
  return name === "chest" || name === "trapped_chest" || name === "barrel";
}

function blocked(itemName: string, position: Position, detail: string): PlacementResult {
  return { status: "blocked", itemName, position, detail };
}

function toPosition(position: Pick<Position, "x" | "y" | "z">): Position {
  return { x: position.x, y: position.y, z: position.z };
}
