import path from "node:path";
import { config as loadEnv } from "dotenv";
import {
  createWorldStateSnapshot,
  listWorldStateSnapshots,
  restoreWorldStateSnapshot,
  type WorldStatePaths
} from "./world-state.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  const name = command === "list" ? undefined : args.shift();
  const flags = parseFlags(args);
  const rootDir = process.cwd();
  loadEnv({ path: path.join(rootDir, ".env"), quiet: true });
  if (flags["env-file"]) {
    loadEnv({
      path: path.resolve(rootDir, flags["env-file"]),
      override: true,
      quiet: true
    });
  }
  const paths = resolveCliPaths(rootDir, flags);

  if (command === "create" && name) {
    const manifest = await createWorldStateSnapshot(name, paths);
    print({ snapshot: manifest.name, createdAt: manifest.createdAt, roots: manifest.roots });
    return;
  }
  if (command === "restore" && name) {
    const result = restoreWorldStateSnapshot(name, {
      ...paths,
      confirm: flags.confirm === "true"
    });
    print({
      restored: result.manifest.name,
      safetyBackupDir: result.safetyBackupDir,
      retainedApiUsageCalls: result.retainedApiUsageCalls
    });
    return;
  }
  if (command === "list") {
    print(
      listWorldStateSnapshots(paths).map((manifest) => ({
        name: manifest.name,
        createdAt: manifest.createdAt,
        gitCommit: manifest.gitCommit,
        roots: manifest.roots
      }))
    );
    return;
  }
  throw new Error(usage());
}

function resolveCliPaths(
  rootDir: string,
  flags: Record<string, string>
): WorldStatePaths {
  return {
    rootDir,
    worldDir: flags["world-dir"] ?? process.env.WORLD_DATA_DIR ?? "./local-server",
    agentDir: flags["agent-dir"] ?? process.env.AGENT_DATA_DIR ?? "./data",
    snapshotDir:
      flags["snapshot-dir"] ??
      process.env.SNAPSHOT_DIR ??
      "./.minecraft-ai-snapshots"
  };
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (name === "confirm") {
      flags.confirm = "true";
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    flags[name] = value;
    index += 1;
  }
  return flags;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usage(): string {
  return [
    "Usage:",
    "  npm run world:snapshot -- create <name> [--env-file .env.test]",
    "  npm run world:snapshot -- restore <name> --confirm [--env-file .env.test]",
    "  npm run world:snapshot -- list [--env-file .env.test]",
    "Optional path flags: --world-dir, --agent-dir, --snapshot-dir"
  ].join("\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
