import type { Bot } from "mineflayer";
import type { InventoryEntry } from "./types.js";

export type InventoryItem = ReturnType<Bot["inventory"]["items"]>[number];
export type EquipmentDestination = Parameters<Bot["equip"]>[1];
export type HarvestBlock = Parameters<Bot["pathfinder"]["bestHarvestTool"]>[0];

export interface ItemRequirement {
  itemName: string;
  count: number;
}

export interface InventoryLayout {
  main: Array<InventoryItem | undefined>;
  hotbar: Array<InventoryItem | undefined>;
  equipment: {
    head?: InventoryItem;
    chest?: InventoryItem;
    legs?: InventoryItem;
    feet?: InventoryItem;
    offhand?: InventoryItem;
  };
}

export type ReservationResult =
  | { status: "reserved"; owner: string; requirements: ItemRequirement[] }
  | { status: "unavailable"; itemName: string; requested: number; available: number };

export interface InventorySystem {
  items(): InventoryItem[];
  snapshot(): InventoryEntry[];
  layout(): InventoryLayout;
  count(itemName: string): number;
  foodCount(excludedNames?: ReadonlySet<string>): number;
  isFood(itemName: string): boolean;
  emptySlots(): number;
  find(itemName: string): InventoryItem | undefined;
  findFirst(predicate: (item: InventoryItem) => boolean): InventoryItem | undefined;
  heldItem(): InventoryItem | undefined;
  equipment(destination: EquipmentDestination): InventoryItem | undefined;
  equip(item: InventoryItem | string, destination: EquipmentDestination): Promise<boolean>;
  consume(itemName: string): Promise<boolean>;
  bestHarvestTool(block: HarvestBlock): InventoryItem | undefined;
  reserve(owner: string, requirements: ItemRequirement[]): ReservationResult;
  release(owner: string): void;
  availableCount(itemName: string, excludingOwner?: string): number;
}

export class MineflayerInventorySystem implements InventorySystem {
  private readonly reservations = new Map<string, ItemRequirement[]>();

  constructor(private readonly bot: Bot) {}

  items(): InventoryItem[] {
    return this.bot.inventory.items();
  }

  snapshot(): InventoryEntry[] {
    return this.items().map((item) => ({
      name: item.name,
      count: item.count,
      slot: item.slot,
      durabilityUsed:
        typeof item.durabilityUsed === "number" ? item.durabilityUsed : undefined
    }));
  }

  layout(): InventoryLayout {
    const inventory = this.bot.inventory;
    return {
      main: Array.from(
        { length: inventory.hotbarStart - inventory.inventoryStart },
        (_, index) => inventory.slots[inventory.inventoryStart + index] ?? undefined
      ),
      hotbar: Array.from(
        { length: 9 },
        (_, slot) => inventory.slots[inventory.hotbarStart + slot] ?? undefined
      ),
      equipment: {
        head: inventory.slots[5] ?? undefined,
        chest: inventory.slots[6] ?? undefined,
        legs: inventory.slots[7] ?? undefined,
        feet: inventory.slots[8] ?? undefined,
        offhand: inventory.slots[45] ?? undefined
      }
    };
  }

  count(itemName: string): number {
    return this.items()
      .filter((item) => item.name === itemName)
      .reduce((total, item) => total + item.count, 0);
  }

  foodCount(excludedNames: ReadonlySet<string> = new Set()): number {
    return this.items().reduce(
      (total, item) =>
        !excludedNames.has(item.name) && this.bot.registry.foodsByName[item.name]
          ? total + item.count
          : total,
      0
    );
  }

  isFood(itemName: string): boolean {
    return Boolean(this.bot.registry.foodsByName[itemName]);
  }

  emptySlots(): number {
    return this.bot.inventory.emptySlotCount();
  }

  find(itemName: string): InventoryItem | undefined {
    return this.items().find((item) => item.name === itemName);
  }

  findFirst(predicate: (item: InventoryItem) => boolean): InventoryItem | undefined {
    return this.items().find(predicate);
  }

  heldItem(): InventoryItem | undefined {
    return this.bot.heldItem ?? undefined;
  }

  equipment(destination: EquipmentDestination): InventoryItem | undefined {
    if (destination === null) return undefined;
    const slot = this.bot.getEquipmentDestSlot(destination);
    return this.bot.inventory.slots[slot] ?? undefined;
  }

  async equip(
    item: InventoryItem | string,
    destination: EquipmentDestination
  ): Promise<boolean> {
    const selected = typeof item === "string" ? this.find(item) : item;
    if (!selected) return false;
    await this.bot.equip(selected, destination);
    return true;
  }

  async consume(itemName: string): Promise<boolean> {
    const item = this.find(itemName);
    if (!item) return false;
    await this.bot.equip(item, "hand");
    await this.bot.consume();
    return true;
  }

  bestHarvestTool(block: HarvestBlock): InventoryItem | undefined {
    return this.bot.pathfinder.bestHarvestTool(block) ?? undefined;
  }

  reserve(owner: string, requirements: ItemRequirement[]): ReservationResult {
    const normalized = requirements
      .filter((requirement) => requirement.count > 0)
      .map((requirement) => ({
        itemName: requirement.itemName,
        count: Math.floor(requirement.count)
      }));
    for (const requirement of normalized) {
      const available = this.availableCount(requirement.itemName, owner);
      if (available < requirement.count) {
        return {
          status: "unavailable",
          itemName: requirement.itemName,
          requested: requirement.count,
          available
        };
      }
    }
    this.reservations.set(owner, normalized);
    return { status: "reserved", owner, requirements: normalized };
  }

  release(owner: string): void {
    this.reservations.delete(owner);
  }

  availableCount(itemName: string, excludingOwner?: string): number {
    let reserved = 0;
    for (const [owner, requirements] of this.reservations) {
      if (owner === excludingOwner) continue;
      reserved += requirements
        .filter((requirement) => requirement.itemName === itemName)
        .reduce((total, requirement) => total + requirement.count, 0);
    }
    return Math.max(0, this.count(itemName) - reserved);
  }
}
