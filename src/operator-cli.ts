import "dotenv/config";
import fs from "node:fs";

const baseUrl =
  process.env.OPERATOR_URL ??
  `http://127.0.0.1:${process.env.OPERATOR_PORT ?? "3008"}`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "status":
      return print(await request("GET", "/api/operator/status"));
    case "usage":
      return print(await request("GET", "/api/operator/usage"));
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
      if (args.length === 0) throw new Error("plan requires a high-level task");
      console.error("[operator] This is an explicitly paid planner request.");
      return print(
        await request("POST", "/api/operator/plan", { task: args.join(" ") })
      );
    default:
      throw new Error(usage());
  }
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
    headers: body === undefined ? undefined : { "content-type": "application/json" },
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
    "  npm run operator -- usage",
    "  npm run operator -- gather --item oak_log --blocks oak_log --minimum 16 [--continuation until_replaced] [--container x,y,z]",
    "  npm run operator -- project path/to/project.json",
    "  npm run operator -- cancel [reason]",
    "  npm run operator -- plan <high-level task>  # paid"
  ].join("\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
