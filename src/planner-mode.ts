export const PLANNER_MODES = ["manual", "automatic"] as const;

export type PlannerMode = (typeof PLANNER_MODES)[number];

export interface PlanningCommand {
  matched: boolean;
  task?: string;
}

export function allowsAutomaticPlanning(mode: PlannerMode): boolean {
  return mode === "automatic";
}

export function parsePlanningCommand(message: string): PlanningCommand {
  const match = message.trim().match(/^!plan(?:\s+([\s\S]+))?$/i);
  if (!match) return { matched: false };

  const task = match[1]?.trim();
  return task ? { matched: true, task } : { matched: true };
}
