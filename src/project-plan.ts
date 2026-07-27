import { z } from "zod";
import type {
  BlueprintPlacement,
  ProjectPlanDraft,
  RelativePosition,
  StructureCheck
} from "./types.js";

const coordinate = z.number().int().min(-64).max(64);
const relativePositionSchema = z.object({
  dx: coordinate,
  dy: coordinate,
  dz: coordinate
});
const placementSchema = relativePositionSchema.extend({
  itemName: z.string().min(1).max(128),
  expectedBlockNames: z.array(z.string().min(1).max(128)).min(1).max(8)
});
const structureCheckSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("blueprint_complete") }),
  z.object({
    kind: z.literal("roofed_area"),
    min: relativePositionSchema,
    max: relativePositionSchema,
    roofY: coordinate
  }),
  z.object({
    kind: z.literal("boundary_closed"),
    min: relativePositionSchema,
    max: relativePositionSchema,
    minY: coordinate,
    maxY: coordinate,
    openings: z.array(relativePositionSchema).max(32)
  }),
  z.object({
    kind: z.literal("entrance"),
    at: relativePositionSchema,
    blockNames: z.array(z.string().min(1).max(128)).min(1).max(8)
  })
]);
const stepSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("use_site"),
    position: z.object({
      x: z.number().int(),
      y: z.number().int().min(-64).max(320),
      z: z.number().int()
    })
  }),
  z.object({
    kind: z.literal("survey_site"),
    width: z.number().int().min(3).max(15),
    depth: z.number().int().min(3).max(15),
    clearanceHeight: z.number().int().min(2).max(8),
    maxWaypoints: z.number().int().min(1).max(256),
    waypointSpacing: z.number().int().min(3).max(24)
  }),
  z.object({
    kind: z.literal("acquire_item"),
    itemName: z.string().min(1).max(128),
    targetCount: z.number().int().min(1).max(100_000),
    sourceBlockNames: z.array(z.string().min(1).max(128)).min(1).max(32)
  }),
  z.object({
    kind: z.literal("craft_item"),
    itemName: z.string().min(1).max(128),
    targetCount: z.number().int().min(1).max(100_000),
    craftingTableAt: relativePositionSchema.optional()
  }),
  z.object({
    kind: z.literal("smelt_item"),
    inputItemName: z.string().min(1).max(128),
    fuelItemName: z.string().min(1).max(128),
    fuelCount: z.number().int().min(1).max(64),
    outputItemName: z.string().min(1).max(128),
    targetCount: z.number().int().min(1).max(100_000),
    furnaceAt: relativePositionSchema
  }),
  z.object({
    kind: z.literal("prospect_resource"),
    itemName: z.string().min(1).max(128),
    targetCount: z.number().int().min(1).max(100_000),
    oreBlockNames: z.array(z.string().min(1).max(128)).min(1).max(16),
    targetY: z.number().int().min(-60).max(300),
    maxTunnelBlocks: z.number().int().min(8).max(4_096),
    branchLength: z.number().int().min(2).max(64),
    branchSpacing: z.number().int().min(2).max(32),
    torchSpacing: z.number().int().min(4).max(32),
    heading: z.enum(["north", "south", "east", "west"]),
    craftingTableAt: relativePositionSchema.optional()
  }),
  z.object({
    kind: z.literal("place_blueprint"),
    placements: z.array(placementSchema).min(1).max(2_048)
  }),
  z.object({
    kind: z.literal("verify_structure"),
    checks: z.array(structureCheckSchema).min(1).max(64)
  }),
  z.object({
    kind: z.literal("verify_inventory"),
    itemName: z.string().min(1).max(128),
    minimumCount: z.number().int().min(1).max(100_000)
  }),
  z.object({
    kind: z.literal("deposit_item"),
    itemName: z.string().min(1).max(128),
    minimumCount: z.number().int().min(1).max(100_000),
    containerAt: relativePositionSchema
  })
]);

export const projectPlanDraftSchema = z
  .object({
    goalId: z.number().int().positive().optional(),
    title: z.string().min(1).max(200),
    completionSummary: z.string().min(1).max(1_000),
    steps: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
          title: z.string().min(1).max(200),
          spec: stepSpecSchema
        })
      )
      .min(1)
      .max(64)
  })
  .superRefine((plan, context) => {
    const ids = new Set<string>();
    for (const [index, step] of plan.steps.entries()) {
      if (ids.has(step.id)) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "id"],
          message: `Duplicate step id: ${step.id}`
        });
      }
      ids.add(step.id);
    }
  });

export function parseProjectPlanDraft(input: unknown): ProjectPlanDraft {
  return projectPlanDraftSchema.parse(input) as ProjectPlanDraft;
}

export function relativeKey(position: RelativePosition): string {
  return `${position.dx},${position.dy},${position.dz}`;
}

export function countBlueprintItems(
  placements: BlueprintPlacement[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const placement of placements) {
    counts[placement.itemName] = (counts[placement.itemName] ?? 0) + 1;
  }
  return counts;
}

export function validateProjectSemantics(draft: ProjectPlanDraft): string[] {
  const errors: string[] = [];
  const placed = new Set<string>();
  for (const step of draft.steps) {
    if (step.spec.kind !== "place_blueprint") continue;
    for (const placement of step.spec.placements) {
      const key = relativeKey(placement);
      if (placed.has(key)) errors.push(`Multiple blocks target ${key}`);
      placed.add(key);
    }
  }
  const hasVerification = draft.steps.some(
    (step) =>
      step.spec.kind === "verify_structure" ||
      step.spec.kind === "verify_inventory"
  );
  if (!hasVerification) errors.push("A project must include deterministic verification");
  return errors;
}

export function absolutePosition(
  anchor: { x: number; y: number; z: number },
  relative: RelativePosition
): { x: number; y: number; z: number } {
  return {
    x: anchor.x + relative.dx,
    y: anchor.y + relative.dy,
    z: anchor.z + relative.dz
  };
}

export function structureCheckLabel(check: StructureCheck): string {
  return check.kind.replaceAll("_", " ");
}
