import type {
  BlueprintPlacement,
  ProjectPlanDraft,
  RelativePosition
} from "./types.js";

export function generatedBirchStarterHouse(
  goalId: number
): ProjectPlanDraft {
  const wallPlacements: BlueprintPlacement[] = [];
  const doorway = { dx: 2, dz: 0 };
  for (let dy = 0; dy <= 2; dy += 1) {
    for (let dx = 0; dx <= 4; dx += 1) {
      for (let dz = 0; dz <= 4; dz += 1) {
        const boundary = dx === 0 || dx === 4 || dz === 0 || dz === 4;
        const doorwayGap =
          dx === doorway.dx && dz === doorway.dz && (dy === 0 || dy === 1);
        if (!boundary || doorwayGap) continue;
        wallPlacements.push(block(dx, dy, dz, "birch_planks"));
      }
    }
  }
  const roofPlacements: BlueprintPlacement[] = [];
  for (let dz = 0; dz <= 4; dz += 1) {
    for (let dx = 0; dx <= 4; dx += 1) {
      roofPlacements.push(block(dx, 3, dz, "birch_planks"));
    }
  }

  return {
    goalId,
    title: "Build a compact birch starter house",
    completionSummary:
      "A verified 5x5 birch shelter has enclosed walls, a complete roof, and a working doorway.",
    steps: [
      {
        id: "survey_site",
        title: "Surveying for a clear 5x5 build site",
        spec: {
          kind: "survey_site",
          width: 5,
          depth: 5,
          clearanceHeight: 4,
          maxWaypoints: 96,
          waypointSpacing: 6
        }
      },
      {
        id: "gather_birch",
        title: "Gathering birch for the house",
        spec: {
          kind: "acquire_item",
          itemName: "birch_log",
          targetCount: 23,
          sourceBlockNames: ["birch_log"]
        }
      },
      {
        id: "craft_planks",
        title: "Crafting the birch building palette",
        spec: {
          kind: "craft_item",
          itemName: "birch_planks",
          targetCount: 92
        }
      },
      {
        id: "craft_table",
        title: "Crafting a workbench",
        spec: {
          kind: "craft_item",
          itemName: "crafting_table",
          targetCount: 1
        }
      },
      {
        id: "place_table",
        title: "Installing the interior workbench",
        spec: {
          kind: "place_blueprint",
          placements: [block(2, 0, 2, "crafting_table")]
        }
      },
      {
        id: "craft_door",
        title: "Crafting the front door",
        spec: {
          kind: "craft_item",
          itemName: "birch_door",
          targetCount: 1,
          craftingTableAt: { dx: 2, dy: 0, dz: 2 }
        }
      },
      {
        id: "build_shell",
        title: "Building the walls, doorway, and roof",
        spec: {
          kind: "place_blueprint",
          placements: [
            ...wallPlacements,
            ...roofPlacements,
            {
              dx: doorway.dx,
              dy: 0,
              dz: doorway.dz,
              itemName: "birch_door",
              expectedBlockNames: ["birch_door"]
            }
          ]
        }
      },
      {
        id: "verify_house",
        title: "Verifying the finished shelter",
        spec: {
          kind: "verify_structure",
          checks: [
            { kind: "blueprint_complete" },
            {
              kind: "roofed_area",
              min: { dx: 1, dy: 0, dz: 1 },
              max: { dx: 3, dy: 0, dz: 3 },
              roofY: 3
            },
            {
              kind: "boundary_closed",
              min: { dx: 0, dy: 0, dz: 0 },
              max: { dx: 4, dy: 0, dz: 4 },
              minY: 0,
              maxY: 2,
              openings: [
                { dx: doorway.dx, dy: 0, dz: doorway.dz },
                { dx: doorway.dx, dy: 1, dz: doorway.dz }
              ]
            },
            {
              kind: "entrance",
              at: { dx: doorway.dx, dy: 0, dz: doorway.dz },
              blockNames: ["birch_door"]
            }
          ]
        }
      }
    ]
  };
}

export function generatedMiningProgressionProject(
  goalId: number,
  rememberedSite: { x: number; y: number; z: number }
): ProjectPlanDraft {
  const tableAt = relative(2, 0, 2);
  const furnaceAt = relative(3, 0, 2);
  return {
    goalId,
    title: "Establish storage and prospect from coal to diamonds",
    completionSummary:
      "Owned storage and a lit mining progression produced a verified diamond sample without hidden-block knowledge.",
    steps: [
      {
        id: "reuse_home",
        title: "Returning to the remembered home workshop",
        spec: {
          kind: "use_site",
          position: rememberedSite
        }
      },
      {
        id: "gather_tool_wood",
        title: "Gathering wood for tools and lighting",
        spec: {
          kind: "acquire_item",
          itemName: "oak_log",
          targetCount: 5,
          sourceBlockNames: ["oak_log"]
        }
      },
      {
        id: "craft_tool_planks",
        title: "Preparing tool materials",
        spec: {
          kind: "craft_item",
          itemName: "oak_planks",
          targetCount: 20
        }
      },
      {
        id: "craft_chest",
        title: "Crafting owned storage",
        spec: {
          kind: "craft_item",
          itemName: "chest",
          targetCount: 1,
          craftingTableAt: tableAt
        }
      },
      {
        id: "craft_sticks",
        title: "Crafting tool handles",
        spec: { kind: "craft_item", itemName: "stick", targetCount: 16 }
      },
      {
        id: "install_storage",
        title: "Installing owned storage",
        spec: {
          kind: "place_blueprint",
          placements: [block(1, 0, 2, "chest")]
        }
      },
      {
        id: "craft_wood_sword",
        title: "Crafting an immediate defence weapon",
        spec: {
          kind: "craft_item",
          itemName: "wooden_sword",
          targetCount: 1,
          craftingTableAt: tableAt
        }
      },
      {
        id: "craft_wood_pickaxe",
        title: "Crafting the first pickaxe",
        spec: {
          kind: "craft_item",
          itemName: "wooden_pickaxe",
          targetCount: 1,
          craftingTableAt: tableAt
        }
      },
      {
        id: "gather_cobblestone",
        title: "Opening a shallow stone quarry",
        spec: {
          kind: "prospect_resource",
          itemName: "cobblestone",
          targetCount: 15,
          oreBlockNames: ["stone"],
          targetY: 68,
          maxTunnelBlocks: 64,
          branchLength: 6,
          branchSpacing: 4,
          torchSpacing: 8,
          heading: "east",
          craftingTableAt: tableAt
        }
      },
      {
        id: "craft_stone_pickaxe",
        title: "Upgrading to a stone pickaxe",
        spec: {
          kind: "craft_item",
          itemName: "stone_pickaxe",
          targetCount: 1,
          craftingTableAt: tableAt
        }
      },
      {
        id: "craft_spare_sword",
        title: "Crafting a spare recovery weapon",
        spec: {
          kind: "craft_item",
          itemName: "stone_sword",
          targetCount: 1,
          craftingTableAt: tableAt
        }
      },
      {
        id: "store_spare_sword",
        title: "Storing the spare recovery weapon",
        spec: {
          kind: "deposit_item",
          itemName: "stone_sword",
          minimumCount: 1,
          containerAt: relative(1, 0, 2)
        }
      },
      {
        id: "craft_active_sword",
        title: "Crafting an active defence weapon",
        spec: {
          kind: "craft_item",
          itemName: "stone_sword",
          targetCount: 1,
          craftingTableAt: tableAt
        }
      },
      {
        id: "prospect_coal",
        title: "Opening a coal branch mine",
        spec: {
          kind: "prospect_resource",
          itemName: "coal",
          targetCount: 11,
          oreBlockNames: ["coal_ore", "deepslate_coal_ore"],
          targetY: 48,
          maxTunnelBlocks: 320,
          branchLength: 8,
          branchSpacing: 4,
          torchSpacing: 8,
          heading: "north",
          craftingTableAt: tableAt
        }
      },
      {
        id: "craft_torches",
        title: "Crafting mine lighting",
        spec: {
          kind: "craft_item",
          itemName: "torch",
          targetCount: 32
        }
      },
      {
        id: "craft_furnace",
        title: "Crafting an ore furnace",
        spec: {
          kind: "craft_item",
          itemName: "furnace",
          targetCount: 1,
          craftingTableAt: tableAt
        }
      },
      {
        id: "install_furnace",
        title: "Installing the ore furnace",
        spec: {
          kind: "place_blueprint",
          placements: [
            block(furnaceAt.dx, furnaceAt.dy, furnaceAt.dz, "furnace")
          ]
        }
      },
      {
        id: "prospect_iron",
        title: "Branch mining for iron",
        spec: {
          kind: "prospect_resource",
          itemName: "raw_iron",
          targetCount: 8,
          oreBlockNames: ["iron_ore", "deepslate_iron_ore"],
          targetY: 16,
          maxTunnelBlocks: 512,
          branchLength: 10,
          branchSpacing: 4,
          torchSpacing: 8,
          heading: "north",
          craftingTableAt: tableAt
        }
      },
      {
        id: "smelt_iron",
        title: "Smelting the recovered iron",
        spec: {
          kind: "smelt_item",
          inputItemName: "raw_iron",
          fuelItemName: "coal",
          fuelCount: 1,
          outputItemName: "iron_ingot",
          targetCount: 8,
          furnaceAt
        }
      },
      {
        id: "craft_iron_pickaxe",
        title: "Crafting a diamond-capable pickaxe",
        spec: {
          kind: "craft_item",
          itemName: "iron_pickaxe",
          targetCount: 1,
          craftingTableAt: tableAt
        }
      },
      {
        id: "prospect_diamond",
        title: "Branch mining for diamonds",
        spec: {
          kind: "prospect_resource",
          itemName: "diamond",
          targetCount: 3,
          oreBlockNames: ["diamond_ore", "deepslate_diamond_ore"],
          targetY: -53,
          maxTunnelBlocks: 1_024,
          branchLength: 12,
          branchSpacing: 3,
          torchSpacing: 8,
          heading: "north",
          craftingTableAt: tableAt
        }
      },
      {
        id: "verify_diamonds",
        title: "Verifying the diamond sample",
        spec: {
          kind: "verify_inventory",
          itemName: "diamond",
          minimumCount: 3
        }
      },
      {
        id: "store_diamonds",
        title: "Securing the diamond sample in owned storage",
        spec: {
          kind: "deposit_item",
          itemName: "diamond",
          minimumCount: 3,
          containerAt: relative(1, 0, 2)
        }
      }
    ]
  };
}

function block(
  dx: number,
  dy: number,
  dz: number,
  itemName: string
): BlueprintPlacement {
  return {
    dx,
    dy,
    dz,
    itemName,
    expectedBlockNames: [itemName]
  };
}

export function relative(
  dx: number,
  dy: number,
  dz: number
): RelativePosition {
  return { dx, dy, dz };
}
