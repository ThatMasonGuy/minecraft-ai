import path from "node:path";
import { config } from "./config.js";
import { generatedMiningProgressionProject } from "./generated-projects.js";
import { EpisodicMemory } from "./memory.js";
import {
  parseProjectPlanDraft,
  validateProjectSemantics
} from "./project-plan.js";

const memory = new EpisodicMemory(path.join(config.dataDir, "memory.sqlite"));
try {
  const rememberedSite = memory.latestCompletedProject()?.anchor;
  if (!rememberedSite) {
    throw new Error("No completed project site is available to reuse");
  }
  for (const activeGoal of memory.activeGoals()) {
    memory.updateGoal(activeGoal.id, { status: "abandoned" });
  }
  const goal = memory.createGoal(
    "Establish owned storage and recover three diamonds",
    "Exercise durable storage, tool progression, smelting, lighting, and perception-bounded underground prospecting",
    100
  );
  const draft = parseProjectPlanDraft(
    generatedMiningProgressionProject(goal.id, rememberedSite)
  );
  const semanticErrors = validateProjectSemantics(draft);
  if (semanticErrors.length > 0) {
    throw new Error(semanticErrors.join("; "));
  }
  const project = memory.createProjectPlan(draft);
  console.log(`Seeded project ${project.id}: ${project.title}`);
} finally {
  memory.close();
}
