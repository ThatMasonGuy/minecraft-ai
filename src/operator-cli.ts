import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { loadOrCreateOperatorToken } from "./operator-auth.js";

const baseUrl =
  process.env.OPERATOR_URL ??
  `http://127.0.0.1:${process.env.OPERATOR_PORT ?? "3008"}`;
const operatorToken = loadOrCreateOperatorToken(
  path.resolve(process.env.DATA_DIR ?? "./data"),
  process.env.OPERATOR_TOKEN
);

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "status":
      return print(await request("GET", "/api/operator/status"));
    case "usage":
      return usageReport(args);
    case "gather":
      return submitGather(args);
    case "project":
      return submitProject(args);
    case "cancel":
      return print(
        await request("POST", "/api/operator/tasks/cancel", {
          reason: args.join(" ") || "Cancelled by local operator"
        })
      );
    case "plan":
      return submitPlan(args);
    default:
      throw new Error(usage());
  }
}

async function usageReport(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    query.set(toCamelCase(key), value);
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  print(await request("GET", `/api/operator/usage${suffix}`));
}

async function submitPlan(args: string[]): Promise<void> {
  if (args.length === 0) throw new Error("plan requires a high-level task");
  const options = args[0]?.startsWith("--") ? parseOptions(args) : {};
  const task = options.task ?? (Object.keys(options).length === 0 ? args.join(" ") : undefined);
  if (!task) throw new Error("plan requires --task <high-level task>");
  const tags = Object.fromEntries(
    (options.tags ?? "")
      .split(",")
      .filter(Boolean)
      .map((tag) => {
        const separator = tag.indexOf("=");
        if (separator < 1) throw new Error(`Tag must be key=value: ${tag}`);
        return [tag.slice(0, separator), tag.slice(separator + 1)];
      })
  );
  console.error("[operator] This is an explicitly paid planner request.");
  print(
    await request("POST", "/api/operator/plan", {
      task,
      workloadType: options.workload,
      taskType: options["task-type"],
      taskId: options["task-id"],
      tags
    })
  );
}

async function submitGather(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const itemName = required(options, "item");
  const blockNames = required(options, "blocks")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const minimumCount = Number(required(options, "minimum"));
  const continuation = options.continuation ?? "stop_at_minimum";
  const storage = options.container
    ? { mode: "container", position: parsePosition(options.container) }
    : { mode: "inventory" };
  print(
    await request("POST", "/api/operator/tasks/gather", {
      itemName,
      blockNames,
      minimumCount,
      continuation,
      storage
    })
  );
}

async function submitProject(args: string[]): Promise<void> {
  const file = args[0];
  if (!file) throw new Error("project requires a JSON file path");
  const draft = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  print(await request("POST", "/api/operator/tasks/project", draft));
}

async function request(
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${operatorToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}: ${JSON.stringify(payload)}`
    );
  }
  return payload;
}

function parseOptions(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --name value pairs, received: ${args.join(" ")}`);
    }
    parsed[flag.slice(2)] = value;
  }
  return parsed;
}

function required(options: Record<string, string>, name: string): string {
  const value = options[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_match, character: string) =>
    character.toUpperCase()
  );
}

function parsePosition(value: string): { x: number; y: number; z: number } {
  const parts = value.split(",").map(Number);
  const [x, y, z] = parts;
  if (parts.length !== 3 || [x, y, z].some((part) => !Number.isInteger(part))) {
    throw new Error("--container must be integer x,y,z coordinates");
  }
  return { x: x!, y: y!, z: z! };
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usage(): string {
  return [
    "Usage:",
    "  npm run operator -- status",
    "  npm run operator -- usage [--request-role follow_up] [--workload-type task_planning] [--trigger-source operator] [--task-type shelter] [--tag key=value]",
    "  npm run operator -- gather --item oak_log --blocks oak_log --minimum 16 [--continuation until_replaced] [--container x,y,z]",
    "  npm run operator -- project path/to/project.json",
    "  npm run operator -- cancel [reason]",
    "  npm run operator -- plan <high-level task>  # paid, default tags",
    "  npm run operator -- plan --task <high-level task> --workload task_planning --task-type shelter [--tags key=value,key2=value2]  # paid"
  ].join("\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
