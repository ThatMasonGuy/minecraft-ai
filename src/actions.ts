import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { z } from "zod";
import type { EpisodicMemory } from "./memory.js";
import type { Perception } from "./perception.js";
import {
  parseProjectPlanDraft,
  validateProjectSemantics
} from "./project-plan.js";
import {
  isCurrentSupportBlock
} from "./navigation.js";
import type { MovementSystem } from "./movement-system.js";
import type { ActionResult, PerceptionSnapshot } from "./types.js";
import { isRecognizedHostileName } from "./entity-classification.js";

export type AgentToolDefinition = {
  type: "function";
  name: string;
  description: string;
  strict: true;
  parameters: Record<string, unknown>;
};

export class MinecraftActions {
  private actionQueue: Promise<void> = Promise.resolve();
  constructor(
    private readonly bot: Bot,
    private readonly memory: EpisodicMemory,
    private readonly perception: Perception,
    private readonly movement: MovementSystem,
    private readonly maxMoveDistance: number
  ) {}

  definitions(): AgentToolDefinition[] {
    return [
      tool(
        "observe",
        "Refresh your first-person perception and own status. This does not reveal hidden blocks.",
        {}
      ),
      tool("speak", "Say something in Minecraft chat.", {
        message: stringSchema("Chat message, at most 240 characters")
      }),
      tool("wait", "Take no action for a short time.", {
        seconds: numberSchema("Whole seconds from 1 to 30")
      }),
      tool("look", "Turn your head using player yaw and pitch in degrees.", {
        yaw_degrees: numberSchema("Yaw in degrees"),
        pitch_degrees: numberSchema("Pitch from -90 to 90 degrees")
      }),
      tool(
        "move_to",
        "Walk to known coordinates using normal pathfinding. Each move is distance-limited and does not discover resources.",
        {
          x: numberSchema("Target X"),
          y: numberSchema("Target Y"),
          z: numberSchema("Target Z"),
          range: numberSchema("Acceptable distance from target, 1 to 8")
        }
      ),
      tool(
        "mine_visible_block",
        "Walk to and mine a block only if its exact coordinates were in your latest line-of-sight observation.",
        {
          x: numberSchema("Observed block X"),
          y: numberSchema("Observed block Y"),
          z: numberSchema("Observed block Z")
        }
      ),
      tool(
        "place_against_visible_block",
        "Place an inventory block against a visible reference block face.",
        {
          reference_x: numberSchema("Visible reference block X"),
          reference_y: numberSchema("Visible reference block Y"),
          reference_z: numberSchema("Visible reference block Z"),
          face_x: numberSchema("Face direction X: -1, 0, or 1"),
          face_y: numberSchema("Face direction Y: -1, 0, or 1"),
          face_z: numberSchema("Face direction Z: -1, 0, or 1"),
          item_name: stringSchema("Inventory item name to place")
        }
      ),
      tool("equip", "Equip an item currently in your inventory.", {
        item_name: stringSchema("Exact inventory item name"),
        destination: enumSchema(["hand", "off-hand", "head", "torso", "legs", "feet"])
      }),
      tool("consume", "Eat or drink an appropriate item from your inventory.", {
        item_name: stringSchema("Exact inventory food or drink item name")
      }),
      tool("craft", "Craft a known item with ingredients you possess and a visible table if required.", {
        item_name: stringSchema("Registry item name"),
        count: numberSchema("Desired number of output items, 1 to 64")
      }),
      tool(
        "approach_visible_entity",
        "Walk near an entity that is present in your latest visible-entity observation.",
        {
          entity_id: numberSchema("Visible entity id"),
          range: numberSchema("Distance to keep, 1 to 8")
        }
      ),
      tool(
        "sleep_in_visible_bed",
        "Walk to and sleep in a bed from the latest line-of-sight observation.",
        {
          x: numberSchema("Visible bed X"),
          y: numberSchema("Visible bed Y"),
          z: numberSchema("Visible bed Z")
        }
      ),
      tool("wake_from_bed", "Leave a bed after sleeping.", {}),
      tool("recall", "Search your persistent episodic memory by words.", {
        query: stringSchema("What you are trying to remember"),
        limit: numberSchema("Maximum results, 1 to 20")
      }),
      tool("recall_nearby", "Recall observed events near your current position.", {
        radius: numberSchema("Radius from 1 to 256 blocks"),
        limit: numberSchema("Maximum results, 1 to 30")
      }),
      tool("create_goal", "Create and prioritize one of your own persistent goals.", {
        title: stringSchema("Short goal"),
        rationale: stringSchema("Why this matters now"),
        priority: numberSchema("Priority from 1 to 100")
      }),
      tool("finish_goal", "Mark an active goal completed or abandoned.", {
        goal_id: numberSchema("Goal id"),
        status: enumSchema(["completed", "abandoned"]),
        summary: stringSchema("What happened and what was learned")
      }),
      tool(
        "set_project_plan",
        "Create or replace a persistent multi-step project. plan_json supports survey_site, acquire_item, craft_item, smelt_item, prospect_resource, place_blueprint, verify_inventory, and verify_structure steps. prospect_resource takes itemName, targetCount, oreBlockNames, targetY, maxTunnelBlocks, branchLength, branchSpacing, and torchSpacing; it physically excavates and never reveals hidden ore. The project executor continues without model calls.",
        {
          plan_json: stringSchema(
            "JSON object matching the persistent ProjectPlanDraft schema"
          )
        }
      ),
      tool(
        "delegate_gather",
        "Delegate a broad gathering outcome to deterministic source selection, navigation, mining, pickup, and storage. Never provide coordinates or motor steps.",
        {
          goal_id: numberSchema("Related active goal id, or 0 if none"),
          item_name: stringSchema("Registry item to gather"),
          minimum_count: numberSchema("Minimum new item count, 1 to 1000000"),
          continuation: enumSchema(["stop_at_minimum", "until_replaced"])
        }
      ),
      tool(
        "set_gather_work_order",
        "Delegate persistent block gathering to the deterministic executor. A minimum is a success milestone; continuation can stop there or keep gathering until replaced. Container storage requires a currently visible chest, trapped chest, or barrel.",
        {
          goal_id: numberSchema("Related active goal id, or 0 if none"),
          item_name: stringSchema("Inventory item whose total count is the completion target"),
          block_names: arrayOfStringsSchema(
            "Exact visible block names that yield the requested item"
          ),
          minimum_count: numberSchema(
            "Minimum newly gathered item count required for success, 1 to 1000000"
          ),
          continuation: enumSchema(["stop_at_minimum", "until_replaced"]),
          storage_mode: enumSchema(["inventory", "container"]),
          container_x: numberSchema(
            "Container X when storage_mode is container; otherwise 0"
          ),
          container_y: numberSchema(
            "Container Y when storage_mode is container; otherwise 0"
          ),
          container_z: numberSchema(
            "Container Z when storage_mode is container; otherwise 0"
          )
        }
      ),
      tool(
        "deposit_item_in_container",
        "Walk to a visible chest, trapped chest, or barrel and deposit all inventory stacks of one item through the normal container interface.",
        {
          x: numberSchema("Observed container X"),
          y: numberSchema("Observed container Y"),
          z: numberSchema("Observed container Z"),
          item_name: stringSchema("Exact inventory item name to deposit")
        }
      ),
      tool(
        "withdraw_item_from_container",
        "Walk to an owned visible container and withdraw a requested item.",
        {
          x: numberSchema("Observed container X"),
          y: numberSchema("Observed container Y"),
          z: numberSchema("Observed container Z"),
          item_name: stringSchema("Exact item name to withdraw"),
          count: numberSchema("Maximum number to withdraw, 1 to 64")
        }
      ),
      tool("cancel_work_order", "Cancel the current deterministic work order.", {
        reason: stringSchema("Why the work should stop")
      })
    ];
  }

  plannerDefinitions(): AgentToolDefinition[] {
    return this.definitions().filter((definition) =>
      HIGH_LEVEL_PLANNER_TOOLS.has(definition.name)
    );
  }

  async execute(name: string, rawArguments: unknown): Promise<ActionResult> {
    const run = this.actionQueue.then(async () => {
      try {
        const result = await this.dispatch(name, rawArguments);
        this.recordAction(name, rawArguments, result);
        return result;
      } catch (error) {
        const result = fail(error instanceof Error ? error.message : String(error));
        this.recordAction(name, rawArguments, result);
        return result;
      }
    });
    this.actionQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async dispatch(name: string, raw: unknown): Promise<ActionResult> {
    switch (name) {
      case "observe":
        return ok("Perception refreshed", this.perception.observe());
      case "speak": {
        const { message } = z.object({ message: z.string().min(1).max(240) }).parse(raw);
        this.bot.chat(message);
        return ok(`Said: ${message}`);
      }
      case "wait": {
        const { seconds } = z
          .object({ seconds: z.number().int().min(1).max(30) })
          .parse(raw);
        await delay(seconds * 1_000);
        return ok(`Waited ${seconds} seconds`);
      }
      case "look": {
        const args = z
          .object({
            yaw_degrees: z.number(),
            pitch_degrees: z.number().min(-90).max(90)
          })
          .parse(raw);
        await this.bot.look(
          (args.yaw_degrees * Math.PI) / 180,
          (args.pitch_degrees * Math.PI) / 180,
          true
        );
        return ok("Look direction changed", this.perception.observe());
      }
      case "move_to":
        return this.moveTo(raw);
      case "move_to_surface":
        return this.moveToSurface(raw);
      case "mine_visible_block":
        return this.mineVisible(raw);
      case "place_against_visible_block":
        return this.placeBlock(raw);
      case "equip":
        return this.equip(raw);
      case "consume":
        return this.consume(raw);
      case "craft":
        return this.craft(raw);
      case "approach_visible_entity":
        return this.approachEntity(raw);
      case "sleep_in_visible_bed":
        return this.sleepInVisibleBed(raw);
      case "wake_from_bed":
        if (!this.bot.isSleeping) return fail("Not currently sleeping");
        await this.bot.wake();
        return ok("Woke from bed", this.perception.observe());
      case "recall": {
        const { query, limit } = z
          .object({ query: z.string().min(1), limit: z.number().int().min(1).max(20) })
          .parse(raw);
        return ok(`Memory search for "${query}"`, this.memory.search(query, limit));
      }
      case "recall_nearby": {
        const { radius, limit } = z
          .object({
            radius: z.number().min(1).max(256),
            limit: z.number().int().min(1).max(30)
          })
          .parse(raw);
        const snapshot = this.requireSnapshot();
        return ok(
          `Memories within ${radius} blocks`,
          this.memory.near(snapshot.position, snapshot.dimension, radius, limit)
        );
      }
      case "create_goal": {
        const args = z
          .object({
            title: z.string().min(1).max(200),
            rationale: z.string().min(1).max(1_000),
            priority: z.number().min(1).max(100)
          })
          .parse(raw);
        const goal = this.memory.createGoal(args.title, args.rationale, args.priority);
        return ok(`Created goal ${goal.id}: ${goal.title}`, goal);
      }
      case "set_project_plan": {
        const { plan_json } = z
          .object({ plan_json: z.string().min(2).max(500_000) })
          .parse(raw);
        const draft = parseProjectPlanDraft(JSON.parse(plan_json));
        const semanticErrors = validateProjectSemantics(draft);
        if (semanticErrors.length > 0) {
          return fail(`Invalid project plan: ${semanticErrors.join("; ")}`);
        }
        const project = this.memory.createProjectPlan(draft);
        return ok(`Started project ${project.id}: ${project.title}`, project);
      }
      case "finish_goal": {
        const args = z
          .object({
            goal_id: z.number().int().positive(),
            status: z.enum(["completed", "abandoned"]),
            summary: z.string().min(1).max(2_000)
          })
          .parse(raw);
        const goal = this.memory.updateGoal(args.goal_id, { status: args.status });
        this.memory.record({
          kind: "goal_outcome",
          summary: `Goal "${goal.title}" ${args.status}: ${args.summary}`,
          payload: { goal, summary: args.summary },
          importance: 9
        });
        return ok(`Goal ${goal.id} marked ${args.status}`, goal);
      }
      case "set_gather_work_order": {
        const args = z
          .object({
            goal_id: z.number().int().min(0),
            item_name: z.string().min(1),
            block_names: z.array(z.string().min(1)).min(1).max(16),
            minimum_count: z.number().int().min(1).max(1_000_000),
            continuation: z.enum(["stop_at_minimum", "until_replaced"]),
            storage_mode: z.enum(["inventory", "container"]),
            container_x: z.number().int(),
            container_y: z.number().int(),
            container_z: z.number().int()
          })
          .parse(raw);
        const storage =
          args.storage_mode === "container"
            ? {
                mode: "container" as const,
                position: {
                  x: args.container_x,
                  y: args.container_y,
                  z: args.container_z
                }
              }
            : { mode: "inventory" as const };
        if (storage.mode === "container") {
          const container = this.perception.inspectVisibleBlock(
            storage.position.x,
            storage.position.y,
            storage.position.z
          );
          if (!container || !isStorageBlock(container.name)) {
            return fail("The configured storage container is not currently visible");
          }
        }
        const initialCount = inventoryCount(this.bot, args.item_name);
        const order = this.memory.createGatherBlocksWorkOrder({
          goalId: args.goal_id === 0 ? undefined : args.goal_id,
          itemName: args.item_name,
          blockNames: [...new Set(args.block_names)],
          minimumCount: args.minimum_count,
          continuation: args.continuation,
          storage
        }, initialCount);
        return ok(`Started deterministic work order ${order.id}`, order);
      }
      case "delegate_gather": {
        const args = z
          .object({
            goal_id: z.number().int().min(0),
            item_name: z.string().min(1).max(128),
            minimum_count: z.number().int().min(1).max(1_000_000),
            continuation: z.enum(["stop_at_minimum", "until_replaced"])
          })
          .parse(raw);
        const blockNames = deterministicGatherSources(args.item_name);
        if (blockNames.length === 0) {
          return fail(
            `No deterministic gather-source rule exists for ${args.item_name}`
          );
        }
        const dimension = String(this.bot.game?.dimension);
        const ownedStorage = this.memory.ownedContainers(dimension)[0];
        const storage = ownedStorage
          ? {
              mode: "container" as const,
              position: ownedStorage.position
            }
          : { mode: "inventory" as const };
        const initialCount = inventoryCount(this.bot, args.item_name);
        const order = this.memory.createGatherBlocksWorkOrder(
          {
            goalId: args.goal_id === 0 ? undefined : args.goal_id,
            itemName: args.item_name,
            blockNames,
            minimumCount: args.minimum_count,
            continuation: args.continuation,
            storage
          },
          initialCount
        );
        return ok(
          `Delegated ${args.minimum_count} ${args.item_name} to deterministic work order ${order.id}`,
          order
        );
      }
      case "deposit_item_in_container":
        return this.depositItemInContainer(raw);
      case "withdraw_item_from_container":
        return this.withdrawItemFromContainer(raw);
      case "cancel_work_order": {
        const { reason } = z
          .object({ reason: z.string().min(1).max(1_000) })
          .parse(raw);
        const order = this.memory.activeWorkOrder();
        if (!order) return fail("There is no active work order");
        const cancelled = this.memory.updateWorkOrderStatus(
          order.id,
          "cancelled",
          reason
        );
        return ok(`Cancelled work order ${order.id}`, cancelled);
      }
      default:
        return fail(`Unknown tool: ${name}`);
    }
  }

  private async moveTo(raw: unknown): Promise<ActionResult> {
    const args = z
      .object({
        x: z.number(),
        y: z.number(),
        z: z.number(),
        range: z.number().min(1).max(8)
      })
      .parse(raw);
    const current = this.bot.entity.position;
    const target = new Vec3(args.x, args.y, args.z);
    const distance = current.distanceTo(target);
    if (distance > this.maxMoveDistance) {
      return fail(
        `Target is ${distance.toFixed(1)} blocks away; maximum per move is ${this.maxMoveDistance}`
      );
    }
    await this.movement.goNear(args, args.range);
    return ok("Reached the target area", this.perception.observe());
  }

  private async moveToSurface(raw: unknown): Promise<ActionResult> {
    const args = z
      .object({
        x: z.number(),
        y: z.number(),
        z: z.number(),
        range: z.number().min(1).max(8).default(4)
      })
      .parse(raw);
    const current = this.bot.entity.position;
    const target = new Vec3(args.x, args.y, args.z);
    const distance = current.distanceTo(target);
    if (distance > this.maxMoveDistance) {
      return fail(
        `Target is ${distance.toFixed(1)} blocks away; maximum per move is ${this.maxMoveDistance}`
      );
    }
    await this.openNearbyExits();
    const navigation = await this.movement.reachSurfaceArea(
      target,
      args.range
    );
    if (navigation.status === "blocked") return fail(navigation.detail);
    return ok("Reached the surface target area", this.perception.observe());
  }

  private async openNearbyExits(): Promise<void> {
    const center = this.bot.entity.position.floored();
    for (let dx = -5; dx <= 5; dx += 1) {
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dz = -5; dz <= 5; dz += 1) {
          const block = this.bot.blockAt(center.offset(dx, dy, dz));
          if (
            !block ||
            (!block.name.endsWith("_door") &&
              !block.name.endsWith("_fence_gate")) ||
            !this.bot.canSeeBlock(block)
          ) {
            continue;
          }
          const properties = block.getProperties() as {
            open?: boolean;
            half?: string;
          };
          if (properties.open || properties.half === "upper") continue;
          try {
            await this.bot.activateBlock(block);
          } catch {
            // Another route may still be available; pathfinding decides that.
          }
        }
      }
    }
  }

  private async mineVisible(raw: unknown): Promise<ActionResult> {
    const args = blockPositionSchema.parse(raw);
    if (
      isCurrentSupportBlock(
        this.bot.entity.position.floored(),
        args
      )
    ) {
      return fail("Refusing to mine the block currently supporting the player");
    }
    if (!this.perception.isBlockCurrentlyVisible(args.x, args.y, args.z)) {
      return fail("That block was not present in the latest line-of-sight observation");
    }
    const position = new Vec3(args.x, args.y, args.z);
    let block = this.bot.blockAt(position);
    if (!block || !this.bot.canSeeBlock(block) || !this.bot.canDigBlock(block)) {
      await this.movement.positionForBlock(args);
      block = this.bot.blockAt(position);
    }
    if (!block || block.name === "air") return fail("The observed block is no longer there");
    if (!this.bot.canSeeBlock(block)) return fail("The block is no longer in line of sight");
    if (!this.bot.canDigBlock(block)) return fail(`Cannot dig ${block.name} from here`);
    const tool = this.bot.pathfinder.bestHarvestTool(block);
    if (tool) await this.bot.equip(tool, "hand");
    await withTimeout(
      this.bot.dig(block),
      10_000,
      () => this.bot.stopDigging()
    );
    try {
      await this.movement.goNear(
        { x: args.x, y: this.bot.entity.position.y, z: args.z },
        1,
        10_000
      );
    } catch {
      // Mining succeeded; collection is best-effort because drops can move or fall.
    }
    await delay(500);
    return ok(`Mined visible ${block.name}`, this.perception.observe());
  }

  private async placeBlock(raw: unknown): Promise<ActionResult> {
    const args = z
      .object({
        reference_x: z.number().int(),
        reference_y: z.number().int(),
        reference_z: z.number().int(),
        face_x: z.number().int().min(-1).max(1),
        face_y: z.number().int().min(-1).max(1),
        face_z: z.number().int().min(-1).max(1),
        item_name: z.string().min(1)
      })
      .refine(
        (value) =>
          Math.abs(value.face_x) + Math.abs(value.face_y) + Math.abs(value.face_z) === 1,
        "Face direction must have exactly one non-zero axis"
      )
      .parse(raw);
    if (
      !this.perception.isBlockCurrentlyVisible(
        args.reference_x,
        args.reference_y,
        args.reference_z
      )
    ) {
      return fail("The reference block is not in the latest line-of-sight observation");
    }
    const item = this.bot.inventory.items().find((entry) => entry.name === args.item_name);
    if (!item) return fail(`${args.item_name} is not in inventory`);
    const referencePosition = new Vec3(
      args.reference_x,
      args.reference_y,
      args.reference_z
    );
    await this.movement.positionForBlock({
      x: args.reference_x,
      y: args.reference_y,
      z: args.reference_z
    });
    const reference = this.bot.blockAt(referencePosition);
    if (!reference || !this.bot.canSeeBlock(reference)) {
      return fail("The reference block is no longer visible");
    }
    await this.bot.equip(item, "hand");
    await this.bot.placeBlock(
      reference,
      new Vec3(args.face_x, args.face_y, args.face_z)
    );
    if (isStorageBlock(args.item_name)) {
      this.memory.registerOwnedContainer(
        {
          x: args.reference_x + args.face_x,
          y: args.reference_y + args.face_y,
          z: args.reference_z + args.face_z
        },
        String(this.bot.game?.dimension),
        args.item_name
      );
    }
    return ok(`Placed ${args.item_name}`, this.perception.observe());
  }

  private async equip(raw: unknown): Promise<ActionResult> {
    const args = z
      .object({
        item_name: z.string().min(1),
        destination: z.enum(["hand", "off-hand", "head", "torso", "legs", "feet"])
      })
      .parse(raw);
    const item = this.bot.inventory.items().find((entry) => entry.name === args.item_name);
    if (!item) return fail(`${args.item_name} is not in inventory`);
    await this.bot.equip(item, args.destination);
    return ok(`Equipped ${args.item_name} to ${args.destination}`);
  }

  private async consume(raw: unknown): Promise<ActionResult> {
    const { item_name } = z.object({ item_name: z.string().min(1) }).parse(raw);
    const item = this.bot.inventory.items().find((entry) => entry.name === item_name);
    if (!item) return fail(`${item_name} is not in inventory`);
    await this.bot.equip(item, "hand");
    await this.bot.consume();
    return ok(`Consumed ${item_name}`, this.perception.observe());
  }

  private async craft(raw: unknown): Promise<ActionResult> {
    const { item_name, count } = z
      .object({
        item_name: z.string().min(1),
        count: z.number().int().min(1).max(64)
      })
      .parse(raw);
    const item = this.bot.registry.itemsByName[item_name];
    if (!item) return fail(`Unknown item: ${item_name}`);
    const snapshot = this.requireSnapshot();
    const tableObservation = snapshot.visibleBlocks.find(
      (block) => block.name === "crafting_table" && block.distance <= 5
    );
    const table = tableObservation
      ? this.bot.blockAt(
          new Vec3(tableObservation.x, tableObservation.y, tableObservation.z)
        )
      : null;
    const recipes = this.bot.recipesFor(item.id, null, count, table);
    const recipe = recipes[0];
    if (!recipe) {
      return fail(
        `No currently craftable recipe for ${item_name}; ingredients or a visible crafting table may be missing`
      );
    }
    const executions = Math.ceil(count / Math.max(1, recipe.result.count));
    await this.bot.craft(recipe, executions, table ?? undefined);
    return ok(
      `Crafted at least ${count} ${item_name} in ${executions} recipe execution(s)`,
      this.perception.observe()
    );
  }

  private async approachEntity(raw: unknown): Promise<ActionResult> {
    const { entity_id, range } = z
      .object({
        entity_id: z.number().int(),
        range: z.number().min(1).max(8)
      })
      .parse(raw);
    const visible = this.perception.visibleEntity(entity_id);
    if (!visible) return fail("That entity is not in the latest visible-entity observation");
    const entity = this.bot.entities[entity_id];
    if (!entity) return fail("That entity is no longer present");
    if (
      [entity.name, entity.displayName].some(isRecognizedHostileName)
    ) {
      return fail(
        "Combat movement is owned by the deterministic survival controller"
      );
    }
    await this.movement.goNear(entity.position, range, 30_000);
    return ok(`Approached ${visible.username ?? visible.name}`, this.perception.observe());
  }

  private async sleepInVisibleBed(raw: unknown): Promise<ActionResult> {
    const args = blockPositionSchema.parse(raw);
    if (!this.perception.isBlockCurrentlyVisible(args.x, args.y, args.z)) {
      return fail("That bed is not in the latest line-of-sight observation");
    }
    const position = new Vec3(args.x, args.y, args.z);
    const bed = this.bot.blockAt(position);
    if (!bed || !bed.name.includes("bed")) return fail("The observed block is not a bed");
    await this.movement.goNear(args, 2, 30_000);
    if (!this.bot.canSeeBlock(bed)) return fail("The bed is no longer visible");
    await this.bot.sleep(bed);
    return ok(`Sleeping in ${bed.name}`);
  }

  private async depositItemInContainer(raw: unknown): Promise<ActionResult> {
    const args = z
      .object({
        x: z.number().int(),
        y: z.number().int(),
        z: z.number().int(),
        item_name: z.string().min(1)
      })
      .parse(raw);
    const visible = this.perception.inspectVisibleBlock(args.x, args.y, args.z);
    if (!visible || !isStorageBlock(visible.name)) {
      return fail("The storage container is not currently visible");
    }
    const stacks = this.bot.inventory
      .items()
      .filter((item) => item.name === args.item_name);
    if (stacks.length === 0) return ok(`No ${args.item_name} to deposit`);

    const position = new Vec3(args.x, args.y, args.z);
    await this.movement.positionForBlock(args);
    const block = this.bot.blockAt(position);
    if (!block || !isStorageBlock(block.name) || !this.bot.canSeeBlock(block)) {
      return fail("The storage container is no longer visible");
    }

    const container = await this.bot.openContainer(block);
    const variants = new Map<string, { type: number; metadata: number | null }>();
    for (const stack of stacks) {
      variants.set(`${stack.type}:${stack.metadata}`, {
        type: stack.type,
        metadata: stack.metadata
      });
    }
    try {
      for (const variant of variants.values()) {
        await container.deposit(variant.type, variant.metadata, null);
      }
    } finally {
      container.close();
    }
    return ok(
      `Deposited all ${args.item_name} into ${visible.name}`,
      this.perception.observe()
    );
  }

  private async withdrawItemFromContainer(raw: unknown): Promise<ActionResult> {
    const args = z
      .object({
        x: z.number().int(),
        y: z.number().int(),
        z: z.number().int(),
        item_name: z.string().min(1),
        count: z.number().int().min(1).max(64)
      })
      .parse(raw);
    const owned = this.memory
      .ownedContainers(String(this.bot.game?.dimension))
      .find(
        (container) =>
          container.position.x === args.x &&
          container.position.y === args.y &&
          container.position.z === args.z
      );
    if (!owned) return fail("That container is not registered as owned");
    const position = new Vec3(args.x, args.y, args.z);
    await this.movement.positionForBlock(args);
    const block = this.bot.blockAt(position);
    if (!block || !isStorageBlock(block.name) || !this.bot.canSeeBlock(block)) {
      return fail("The owned storage container is unavailable");
    }
    const container = await this.bot.openContainer(block);
    try {
      const stack = container
        .containerItems()
        .find((item) => item.name === args.item_name);
      if (!stack) return fail(`Owned storage has no ${args.item_name}`);
      const count = Math.min(args.count, stack.count);
      await container.withdraw(
        stack.type,
        stack.metadata,
        count
      );
      this.memory.recordContainerWithdrawal(
        owned.id,
        args.item_name,
        count
      );
      return ok(`Withdrew ${count} ${args.item_name} from owned storage`);
    } finally {
      container.close();
    }
  }

  private requireSnapshot(): PerceptionSnapshot {
    return this.perception.last() ?? this.perception.observe();
  }

  private recordAction(name: string, args: unknown, result: ActionResult): void {
    const snapshot = this.perception.last();
    this.memory.record({
      kind: result.ok ? "action" : "action_failure",
      summary: `${name}: ${result.message}`,
      payload: { arguments: args, result },
      position: snapshot?.position,
      dimension: snapshot?.dimension,
      importance: result.ok ? 5 : 7
    });
  }
}

const HIGH_LEVEL_PLANNER_TOOLS = new Set([
  "speak",
  "recall",
  "recall_nearby",
  "create_goal",
  "finish_goal",
  "delegate_gather",
  "cancel_work_order"
]);

export function isHighLevelPlannerTool(name: string): boolean {
  return HIGH_LEVEL_PLANNER_TOOLS.has(name);
}

export function deterministicGatherSources(itemName: string): string[] {
  const explicit: Record<string, string[]> = {
    cobblestone: ["stone"],
    dirt: ["dirt", "grass_block"],
    coal: ["coal_ore", "deepslate_coal_ore"],
    raw_iron: ["iron_ore", "deepslate_iron_ore"],
    raw_copper: ["copper_ore", "deepslate_copper_ore"],
    raw_gold: ["gold_ore", "deepslate_gold_ore"],
    diamond: ["diamond_ore", "deepslate_diamond_ore"],
    emerald: ["emerald_ore", "deepslate_emerald_ore"],
    redstone: ["redstone_ore", "deepslate_redstone_ore"],
    lapis_lazuli: ["lapis_ore", "deepslate_lapis_ore"],
    flint: ["gravel"]
  };
  if (explicit[itemName]) return explicit[itemName];
  if (
    itemName.endsWith("_log") ||
    itemName.endsWith("_stem") ||
    itemName.endsWith("_wood") ||
    itemName.endsWith("_hyphae") ||
    ["sand", "gravel", "clay", "netherrack", "end_stone"].includes(itemName)
  ) {
    return [itemName];
  }
  return [];
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>
): AgentToolDefinition {
  return {
    type: "function",
    name,
    description,
    strict: true,
    parameters: {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false
    }
  };
}

function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function numberSchema(description: string): Record<string, unknown> {
  return { type: "number", description };
}

function enumSchema(values: string[]): Record<string, unknown> {
  return { type: "string", enum: values };
}

function arrayOfStringsSchema(description: string): Record<string, unknown> {
  return {
    type: "array",
    description,
    items: { type: "string" }
  };
}

const blockPositionSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int()
});

function ok(message: string, data?: unknown): ActionResult {
  return { ok: true, message, data };
}

function fail(message: string): ActionResult {
  return { ok: false, message };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function inventoryCount(bot: Bot, itemName: string): number {
  return bot.inventory
    .items()
    .filter((item) => item.name === itemName)
    .reduce((sum, item) => sum + item.count, 0);
}

function isStorageBlock(name: string): boolean {
  return name === "chest" || name === "trapped_chest" || name === "barrel";
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  onTimeout: () => void
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`Action timed out after ${milliseconds / 1_000} seconds`));
        }, milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
