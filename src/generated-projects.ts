import type {
  BlueprintPlacement,
  ProjectPlanDraft,
  RelativePosition
} from "./types.js";
import {
  analyzeHouseDesign,
  type HouseDesign
} from "./house-design.js";

export const SUPPORTED_WOOD_FAMILIES = [
  "oak",
  "spruce",
  "birch",
  "jungle",
  "acacia",
  "dark_oak",
  "mangrove",
  "cherry",
  "pale_oak"
] as const;

export type SupportedWoodFamily = (typeof SUPPORTED_WOOD_FAMILIES)[number];

export const PROJECT_SCALES = ["compact", "standard", "spacious"] as const;
export type ProjectScale = (typeof PROJECT_SCALES)[number];

export function generatedBirchStarterHouse(
  goalId: number
): ProjectPlanDraft {
  return generatedStarterHouseProject(goalId, "birch");
}

export function generatedStarterHouseProject(
  goalId: number | undefined,
  woodFamily: SupportedWoodFamily,
  scale: ProjectScale = "compact"
): ProjectPlanDraft {
  const { width, depth } = projectScaleDimensions(scale);
  const rows = Array.from({ length: depth }, () => "#".repeat(width));
  const doorX = Math.floor(width / 2);
  rows[0] = `${"#".repeat(doorX)}D${"#".repeat(width - doorX - 1)}`;
  return generatedHouseProject(goalId, woodFamily, {
    designName: `${scale} starter house`,
    footprintRows: rows,
    wallHeight: 3
  });
}

export function generatedHouseProject(
  goalId: number | undefined,
  woodFamily: SupportedWoodFamily,
  design: HouseDesign
): ProjectPlanDraft {
  const analysis = analyzeHouseDesign(design);
  const { width, depth } = analysis;
  const roofY = design.wallHeight;
  const logName = `${woodFamily}_log`;
  const planksName = `${woodFamily}_planks`;
  const doorName = `${woodFamily}_door`;
  const woodLabel = woodFamily.replaceAll("_", " ");
  const wallPlacements: BlueprintPlacement[] = [];
  const doorway = analysis.door;
  for (let dy = 0; dy < design.wallHeight; dy += 1) {
    for (const cell of analysis.boundaryCells) {
        const { dx, dz } = cell;
        const doorwayGap =
          dx === doorway.dx && dz === doorway.dz && (dy === 0 || dy === 1);
        if (doorwayGap) continue;
        wallPlacements.push(block(dx, dy, dz, planksName));
    }
  }
  const roofPlacements: BlueprintPlacement[] = [];
  for (const { dx, dz } of analysis.cells) {
    roofPlacements.push(block(dx, roofY, dz, planksName));
  }
  const plankTarget = wallPlacements.length + roofPlacements.length + 10;
  const logTarget = Math.ceil(plankTarget / 4);
  const workbench = [...analysis.interiorCells].sort(
    (left, right) =>
      Math.hypot(left.dx - width / 2, left.dz - depth / 2) -
      Math.hypot(right.dx - width / 2, right.dz - depth / 2)
  )[0]!;

  return {
    goalId,
    title: `Build ${design.designName} in ${woodLabel}`,
    completionSummary:
      `The planner-designed ${design.designName} has a verified connected ${width}x${depth} bounding footprint, enclosed walls, a complete roof, and a working doorway.`,
    steps: [
      {
        id: "survey_site",
        title: `Preparing a ${width}x${depth} build site`,
        spec: {
          kind: "survey_site",
          width,
          depth,
          clearanceHeight: design.wallHeight + 1,
          maxWaypoints: 96,
          waypointSpacing: 6,
          searchRadius: 8,
          maxSitePreparationBlocks:
            width * depth * (design.wallHeight + 1)
        }
      },
      {
        id: "gather_wood",
        title: `Gathering ${woodLabel} for the house`,
        spec: {
          kind: "acquire_item",
          itemName: logName,
          targetCount: logTarget,
          sourceBlockNames: [logName]
        }
      },
      {
        id: "craft_planks",
        title: `Crafting the ${woodLabel} building palette`,
        spec: {
          kind: "craft_item",
          itemName: planksName,
          targetCount: plankTarget
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
          placements: [block(workbench.dx, 0, workbench.dz, "crafting_table")]
        }
      },
      {
        id: "craft_door",
        title: "Crafting the front door",
        spec: {
          kind: "craft_item",
          itemName: doorName,
          targetCount: 1,
          craftingTableAt: { dx: workbench.dx, dy: 0, dz: workbench.dz }
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
              itemName: doorName,
              expectedBlockNames: [doorName]
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
              kind: "entrance",
              at: { dx: doorway.dx, dy: 0, dz: doorway.dz },
              blockNames: [doorName]
            }
          ]
        }
      }
    ]
  };
}

export function generatedMiningProgressionProject(
  goalId: number | undefined,
  rememberedSite?: { x: number; y: number; z: number },
  woodFamily: SupportedWoodFamily = "oak",
  scale: ProjectScale = "compact"
): ProjectPlanDraft {
  const { width, depth } = projectScaleDimensions(scale);
  const logName = `${woodFamily}_log`;
  const planksName = `${woodFamily}_planks`;
  const initialSteps: ProjectPlanDraft["steps"] = rememberedSite
    ? [
        {
          id: "reuse_home",
          title: "Returning to the remembered home workshop",
          spec: {
            kind: "use_site",
            position: rememberedSite
          }
        }
      ]
    : [
        {
          id: "survey_workshop",
          title: "Surveying a safe workshop site",
          spec: {
            kind: "survey_site",
            width,
            depth,
            clearanceHeight: 4,
            maxWaypoints: 96,
            waypointSpacing: 6,
            searchRadius: 8,
            maxSitePreparationBlocks: width * depth * 4
          }
        }
      ];
  const tableAt = relative(2, 0, 2);
  const furnaceAt = relative(3, 0, 2);
  return {
    goalId,
    title: "Establish storage and prospect from coal to diamonds",
    completionSummary:
      "Owned storage and a lit mining progression produced a verified diamond sample without hidden-block knowledge.",
    steps: [
      ...initialSteps,
      {
        id: "gather_tool_wood",
        title: "Gathering wood for tools and lighting",
        spec: {
          kind: "acquire_item",
          itemName: logName,
          targetCount: 5,
          sourceBlockNames: [logName]
        }
      },
      {
        id: "craft_tool_planks",
        title: "Preparing tool materials",
        spec: {
          kind: "craft_item",
          itemName: planksName,
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

export function projectScaleDimensions(scale: ProjectScale): {
  width: number;
  depth: number;
} {
  switch (scale) {
    case "compact":
      return { width: 5, depth: 5 };
    case "standard":
      return { width: 7, depth: 7 };
    case "spacious":
      return { width: 9, depth: 9 };
  }
}
