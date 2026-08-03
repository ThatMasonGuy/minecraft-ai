import {
  generatedMiningProgressionProject,
  generatedStarterHouseProject,
  SUPPORTED_WOOD_FAMILIES,
  type SupportedWoodFamily
} from "./generated-projects.js";
import type {
  InventoryEntry,
  OwnedContainer,
  ProjectPlanDraft
} from "./types.js";

export const HIGH_LEVEL_PROJECT_KINDS = [
  "starter_shelter",
  "diamond_progression"
] as const;

export type HighLevelProjectKind = (typeof HIGH_LEVEL_PROJECT_KINDS)[number];

export interface HighLevelProjectRequest {
  goalId?: number;
  kind: HighLevelProjectKind;
  dimension: string;
  visibleBlocks: Array<{ name: string; distance: number }>;
  inventory: Array<Pick<InventoryEntry, "name" | "count">>;
}

export interface ProjectCompilationContext {
  ownedContainers: OwnedContainer[];
}

export function compileHighLevelProject(
  request: HighLevelProjectRequest,
  context: ProjectCompilationContext
): ProjectPlanDraft {
  const woodFamily =
    selectKnownWoodFamily(request, context.ownedContainers) ?? "oak";

  switch (request.kind) {
    case "starter_shelter":
      return generatedStarterHouseProject(request.goalId, woodFamily);
    case "diamond_progression": {
      const rememberedSite = context.ownedContainers.find(
        (container) =>
          container.status === "active" && container.dimension === request.dimension
      )?.position;
      return generatedMiningProgressionProject(
        request.goalId,
        rememberedSite,
        woodFamily
      );
    }
  }
}

export function defaultGoalForProject(kind: HighLevelProjectKind): {
  title: string;
  rationale: string;
  priority: number;
} {
  switch (kind) {
    case "starter_shelter":
      return {
        title: "Establish a verified starter shelter",
        rationale:
          "Create an enclosed, roofed, accessible base through deterministic gathering, production, building, and verification.",
        priority: 80
      };
    case "diamond_progression":
      return {
        title: "Establish storage and recover three diamonds",
        rationale:
          "Build durable storage and tool progression, then prospect physically until three diamonds are verified and secured.",
        priority: 90
      };
  }
}

function selectKnownWoodFamily(
  request: HighLevelProjectRequest,
  containers: OwnedContainer[]
): SupportedWoodFamily | undefined {
  const visible = [...request.visibleBlocks]
    .sort((left, right) => left.distance - right.distance)
    .map((block) => woodFamilyForItem(block.name))
    .find((family) => family !== undefined);
  if (visible) return visible;

  const carried = request.inventory
    .filter((item) => item.count > 0)
    .map((item) => woodFamilyForItem(item.name))
    .find((family) => family !== undefined);
  if (carried) return carried;

  for (const container of containers) {
    if (container.status !== "active" || container.dimension !== request.dimension) {
      continue;
    }
    for (const [itemName, count] of Object.entries(container.contents)) {
      if (count <= 0) continue;
      const family = woodFamilyForItem(itemName);
      if (family) return family;
    }
  }
  return undefined;
}

function woodFamilyForItem(name: string): SupportedWoodFamily | undefined {
  return SUPPORTED_WOOD_FAMILIES.find(
    (family) =>
      name === `${family}_log` ||
      name === `${family}_wood` ||
      name === `${family}_planks`
  );
}
