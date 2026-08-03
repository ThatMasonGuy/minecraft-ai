import type { Bot } from "mineflayer";
import type { InventorySystem } from "./inventory-system.js";
import type { MovementSystem } from "./movement-system.js";
import type { SensedBlock, SensingSystem } from "./perception.js";
import type { Position } from "./types.js";

export interface ProduceRequest {
  itemName: string;
  count: number;
  craftingTable?: Position | SensedBlock;
  maximumExecutions?: number;
}

export type ProductionResult =
  | { status: "produced"; itemName: string; producedCount: number; executions: number }
  | { status: "unavailable"; itemName: string; detail: string };

export interface SmeltRequest {
  furnace: Position | SensedBlock;
  inputItemName: string;
  fuelItemName: string;
  fuelCount: number;
  outputItemName: string;
  targetCount: number;
}

export type SmeltResult =
  | { status: "output_collected" }
  | { status: "smelting" }
  | { status: "loaded" }
  | { status: "blocked"; detail: string };

export interface ProductionSystem {
  produce(request: ProduceRequest): Promise<ProductionResult>;
  craftOne(itemName: string, craftingTable?: Position | SensedBlock): Promise<ProductionResult>;
  smeltStep(request: SmeltRequest): Promise<SmeltResult>;
}

export class MineflayerProductionSystem implements ProductionSystem {
  constructor(
    private readonly bot: Bot,
    private readonly sensing: SensingSystem,
    private readonly movement: MovementSystem,
    private readonly inventory: InventorySystem
  ) {}

  async produce(request: ProduceRequest): Promise<ProductionResult> {
    const item = this.bot.registry.itemsByName[request.itemName];
    if (!item) {
      return unavailable(request.itemName, `unknown item ${request.itemName}`);
    }
    const table = this.resolveBlock(request.craftingTable);
    if (request.craftingTable && (!table || table.name !== "crafting_table")) {
      return unavailable(request.itemName, "crafting table is unavailable");
    }
    if (table) {
      await this.movement.positionForBlock(toPosition(table.position), 4, 20_000);
    }
    const recipe = this.bot.recipesFor(item.id, null, request.count, table ?? null)[0] ??
      this.bot.recipesFor(item.id, null, 1, table ?? null)[0];
    if (!recipe) {
      return unavailable(
        request.itemName,
        `no currently craftable recipe for ${request.itemName}`
      );
    }
    const requiredExecutions = Math.ceil(
      request.count / Math.max(1, recipe.result.count)
    );
    const executions = Math.min(
      requiredExecutions,
      request.maximumExecutions ?? requiredExecutions
    );
    await this.bot.craft(recipe, executions, table ?? undefined);
    return {
      status: "produced",
      itemName: request.itemName,
      producedCount: executions * Math.max(1, recipe.result.count),
      executions
    };
  }

  craftOne(
    itemName: string,
    craftingTable?: Position | SensedBlock
  ): Promise<ProductionResult> {
    return this.produce({
      itemName,
      count: 1,
      craftingTable,
      maximumExecutions: 1
    });
  }

  async smeltStep(request: SmeltRequest): Promise<SmeltResult> {
    const furnaceBlock = this.resolveBlock(request.furnace);
    if (!furnaceBlock || furnaceBlock.name !== "furnace") {
      return { status: "blocked", detail: "required furnace is unavailable" };
    }
    await this.movement.goNear(toPosition(furnaceBlock.position), 2);
    const furnace = await this.bot.openFurnace(furnaceBlock);
    try {
      if (furnace.outputItem()) {
        await furnace.takeOutput();
        return { status: "output_collected" };
      }
      if (furnace.inputItem()) return { status: "smelting" };
      const input = this.inventory.find(request.inputItemName);
      const fuel = this.inventory.find(request.fuelItemName);
      if (!input) {
        return {
          status: "blocked",
          detail: `missing smelting input ${request.inputItemName}`
        };
      }
      if (!fuel && !furnace.fuelItem()) {
        return {
          status: "blocked",
          detail: `missing furnace fuel ${request.fuelItemName}`
        };
      }
      const missing = Math.max(1, request.targetCount - this.inventory.count(request.outputItemName));
      await furnace.putInput(
        input.type,
        input.metadata,
        Math.min(missing, input.count)
      );
      if (!furnace.fuelItem() && fuel) {
        await furnace.putFuel(
          fuel.type,
          fuel.metadata,
          Math.min(request.fuelCount, fuel.count)
        );
      }
      return { status: "loaded" };
    } finally {
      furnace.close();
    }
  }

  private resolveBlock(block?: Position | SensedBlock): SensedBlock | undefined {
    if (!block) return undefined;
    if ("boundingBox" in block) return block;
    return this.sensing.blockAt(block);
  }
}

function unavailable(itemName: string, detail: string): ProductionResult {
  return { status: "unavailable", itemName, detail };
}

function toPosition(position: Pick<Position, "x" | "y" | "z">): Position {
  return { x: position.x, y: position.y, z: position.z };
}
