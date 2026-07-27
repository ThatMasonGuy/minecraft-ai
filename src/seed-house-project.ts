import path from "node:path";
import { config } from "./config.js";
import { generatedBirchStarterHouse } from "./generated-projects.js";
import { EpisodicMemory } from "./memory.js";
import {
  parseProjectPlanDraft,
  validateProjectSemantics
} from "./project-plan.js";

const memory = new EpisodicMemory(path.join(config.dataDir, "memory.sqlite"));
try {
  const goal = memory.activeGoals()[0];
  if (!goal) throw new Error("There is no active goal to attach the project to");
  const draft = parseProjectPlanDraft(generatedBirchStarterHouse(goal.id));
  const semanticErrors = validateProjectSemantics(draft);
  if (semanticErrors.length > 0) {
    throw new Error(semanticErrors.join("; "));
  }
  const project = memory.createProjectPlan(draft);
  console.log(`Seeded project ${project.id}: ${project.title}`);
} finally {
  memory.close();
}
