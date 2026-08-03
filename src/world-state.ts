import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { EpisodicMemory } from "./memory.js";

export interface SnapshotFile {
  path: string;
  size: number;
  sha256: string;
}

export interface WorldStateManifest {
  version: 1;
  name: string;
  createdAt: string;
  gitCommit?: string;
  sources: { world: string; agent: string };
  excluded: { agent: string[] };
  files: { world: SnapshotFile[]; agent: SnapshotFile[] };
  roots: { worldSha256: string; agentSha256: string };
}

export interface WorldStatePaths {
  rootDir: string;
  worldDir: string;
  agentDir: string;
  snapshotDir: string;
}

export interface WorldStateOperationOptions extends WorldStatePaths {
  assertStopped?: () => void;
}

const AGENT_EXCLUSIONS = new Set(["auth", "operator-token"]);

export function createWorldStateSnapshot(
  name: string,
  options: WorldStateOperationOptions
): WorldStateManifest {
  assertSnapshotName(name);
  const paths = resolvePaths(options);
  (options.assertStopped ?? (() => assertComposeStopped(paths.rootDir)))();
  assertDirectory(paths.worldDir, "world data");
  assertDirectory(paths.agentDir, "agent data");
  checkpointMemory(paths.agentDir);
  migrateMemory(paths.agentDir);

  fs.mkdirSync(paths.snapshotDir, { recursive: true });
  const target = path.join(paths.snapshotDir, name);
  if (fs.existsSync(target)) throw new Error(`Snapshot already exists: ${name}`);
  fs.mkdirSync(target, { recursive: false });

  try {
    const worldTarget = path.join(target, "world");
    const agentTarget = path.join(target, "agent");
    copyTree(paths.worldDir, worldTarget);
    copyTree(paths.agentDir, agentTarget, AGENT_EXCLUSIONS);
    const worldFiles = inventoryTree(worldTarget);
    const agentFiles = inventoryTree(agentTarget);
    const manifest: WorldStateManifest = {
      version: 1,
      name,
      createdAt: new Date().toISOString(),
      gitCommit: currentGitCommit(paths.rootDir),
      sources: {
        world: relativeDisplay(paths.rootDir, paths.worldDir),
        agent: relativeDisplay(paths.rootDir, paths.agentDir)
      },
      excluded: { agent: [...AGENT_EXCLUSIONS] },
      files: { world: worldFiles, agent: agentFiles },
      roots: {
        worldSha256: rootDigest(worldFiles),
        agentSha256: rootDigest(agentFiles)
      }
    };
    fs.writeFileSync(
      path.join(target, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    return manifest;
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

export function restoreWorldStateSnapshot(
  name: string,
  options: WorldStateOperationOptions & { confirm: boolean }
): {
  manifest: WorldStateManifest;
  safetyBackupDir: string;
  retainedApiUsageCalls: number;
} {
  if (!options.confirm) {
    throw new Error("Restore requires --confirm because it replaces active state");
  }
  assertSnapshotName(name);
  const paths = resolvePaths(options);
  (options.assertStopped ?? (() => assertComposeStopped(paths.rootDir)))();
  checkpointMemory(paths.agentDir);
  migrateMemory(paths.agentDir);

  const source = path.join(paths.snapshotDir, name);
  const manifest = readAndVerifySnapshot(source);
  if (manifest.name !== name) {
    throw new Error(`Snapshot manifest name mismatch: ${manifest.name}`);
  }

  const backupBase = resolveInside(
    paths.rootDir,
    path.join(paths.rootDir, ".minecraft-ai-restore-backups"),
    "restore backup directory"
  );
  assertDisjoint(paths.worldDir, backupBase, "world and restore backup directories");
  assertDisjoint(paths.agentDir, backupBase, "agent and restore backup directories");
  fs.mkdirSync(backupBase, { recursive: true });
  const backup = path.join(
    backupBase,
    `pre-restore-${safeTimestamp()}-${name}`
  );
  fs.mkdirSync(backup, { recursive: false });

  const worldExisted = fs.existsSync(paths.worldDir);
  const agentExisted = fs.existsSync(paths.agentDir);
  const backupWorld = path.join(backup, "world");
  const backupAgent = path.join(backup, "agent");
  try {
    if (worldExisted) fs.renameSync(paths.worldDir, backupWorld);
    if (agentExisted) fs.renameSync(paths.agentDir, backupAgent);
    copyTree(path.join(source, "world"), paths.worldDir);
    copyTree(path.join(source, "agent"), paths.agentDir);

    const currentAuth = path.join(backupAgent, "auth");
    if (fs.existsSync(currentAuth)) {
      copyTree(currentAuth, path.join(paths.agentDir, "auth"));
    }
    const currentOperatorToken = path.join(backupAgent, "operator-token");
    if (fs.existsSync(currentOperatorToken)) {
      fs.copyFileSync(
        currentOperatorToken,
        path.join(paths.agentDir, "operator-token")
      );
    }
    verifyTree(paths.worldDir, manifest.files.world, "restored world");
    verifyTree(
      paths.agentDir,
      manifest.files.agent,
      "restored agent",
      AGENT_EXCLUSIONS
    );
    const retainedApiUsageCalls = mergeApiUsageHistory(
      path.join(backupAgent, "memory.sqlite"),
      path.join(paths.agentDir, "memory.sqlite")
    );
    fs.writeFileSync(
      path.join(backup, "restore.json"),
      `${JSON.stringify(
        {
          restoredAt: new Date().toISOString(),
          snapshot: name,
          retainedApiUsageCalls
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    return { manifest, safetyBackupDir: backup, retainedApiUsageCalls };
  } catch (error) {
    rollbackRestore(
      paths,
      { worldExisted, agentExisted, backupWorld, backupAgent }
    );
    throw error;
  }
}

function mergeApiUsageHistory(
  previousDatabasePath: string,
  restoredDatabasePath: string
): number {
  if (!fs.existsSync(previousDatabasePath)) return 0;
  const migrated = new EpisodicMemory(restoredDatabasePath);
  migrated.close();

  const database = new DatabaseSync(restoredDatabasePath);
  const escapedPreviousPath = previousDatabasePath.replaceAll("'", "''");
  try {
    database.exec(`ATTACH DATABASE '${escapedPreviousPath}' AS previous`);
    const sourceTable = database
      .prepare(`
        SELECT 1 AS present
        FROM previous.sqlite_master
        WHERE type = 'table' AND name = 'api_usage_ledger'
      `)
      .get() as { present?: number } | undefined;
    if (!sourceTable?.present) return 0;
    const before = database
      .prepare("SELECT count(*) AS calls FROM api_usage_ledger")
      .get() as { calls: number };
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(`
        INSERT OR IGNORE INTO api_price_versions (
          provider, model, service_tier, effective_from, effective_to,
          long_context_threshold, short_input_usd_per_million,
          short_cached_input_usd_per_million,
          short_cache_write_usd_per_million, short_output_usd_per_million,
          long_input_usd_per_million, long_cached_input_usd_per_million,
          long_cache_write_usd_per_million, long_output_usd_per_million,
          web_search_usd_per_thousand, source_url, captured_at
        )
        SELECT
          provider, model, service_tier, effective_from, effective_to,
          long_context_threshold, short_input_usd_per_million,
          short_cached_input_usd_per_million,
          short_cache_write_usd_per_million, short_output_usd_per_million,
          long_input_usd_per_million, long_cached_input_usd_per_million,
          long_cache_write_usd_per_million, long_output_usd_per_million,
          web_search_usd_per_thousand, source_url, captured_at
        FROM previous.api_price_versions;

        INSERT OR IGNORE INTO api_usage_ledger (
          request_id, occurred_at, completed_at, provider, endpoint,
          requested_model, response_id, response_model, service_tier, phase,
          trigger, reasoning_effort, turn_id, request_role, workload_type,
          trigger_source, task_type, task_id, parent_request_id, tags_json,
          status, latency_ms, input_tokens,
          cached_input_tokens, cache_write_tokens, output_tokens,
          reasoning_tokens, total_tokens, web_search_calls, raw_usage_json,
          error_class, error_message, price_version_id,
          estimated_cost_usd_micros, pricing_status, created_at
        )
        SELECT
          usage.request_id, usage.occurred_at, usage.completed_at,
          usage.provider, usage.endpoint, usage.requested_model,
          usage.response_id, usage.response_model, usage.service_tier,
          usage.phase, usage.trigger, usage.reasoning_effort,
          usage.turn_id, usage.request_role, usage.workload_type,
          usage.trigger_source, usage.task_type, usage.task_id,
          usage.parent_request_id, usage.tags_json, usage.status,
          usage.latency_ms, usage.input_tokens, usage.cached_input_tokens,
          usage.cache_write_tokens, usage.output_tokens,
          usage.reasoning_tokens, usage.total_tokens, usage.web_search_calls,
          usage.raw_usage_json, usage.error_class, usage.error_message,
          (
            SELECT target_price.id
            FROM previous.api_price_versions source_price
            JOIN api_price_versions target_price
              ON target_price.provider = source_price.provider
             AND target_price.model = source_price.model
             AND target_price.service_tier = source_price.service_tier
             AND target_price.effective_from = source_price.effective_from
            WHERE source_price.id = usage.price_version_id
            LIMIT 1
          ),
          usage.estimated_cost_usd_micros, usage.pricing_status,
          usage.created_at
        FROM previous.api_usage_ledger usage;
      `);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const after = database
      .prepare("SELECT count(*) AS calls FROM api_usage_ledger")
      .get() as { calls: number };
    return Number(after.calls) - Number(before.calls);
  } finally {
    database.close();
  }
}

export function listWorldStateSnapshots(
  options: Pick<WorldStatePaths, "rootDir" | "snapshotDir">
): WorldStateManifest[] {
  const rootDir = path.resolve(options.rootDir);
  const snapshotDir = resolveInside(
    rootDir,
    options.snapshotDir,
    "snapshot directory"
  );
  if (!fs.existsSync(snapshotDir)) return [];
  return fs
    .readdirSync(snapshotDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readAndVerifySnapshot(path.join(snapshotDir, entry.name)))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function assertComposeStopped(rootDir: string): void {
  const result = spawnSync(
    "docker",
    ["compose", "ps", "--status", "running", "--services"],
    { cwd: rootDir, encoding: "utf8", windowsHide: true }
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not prove the Compose stack is stopped: ${
        result.error?.message ?? result.stderr.trim() ?? "docker compose failed"
      }`
    );
  }
  const services = result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (services.length > 0) {
    throw new Error(
      `Stop the Compose stack before state maintenance; running: ${services.join(
        ", "
      )}`
    );
  }
}

function resolvePaths(options: WorldStatePaths): WorldStatePaths {
  const rootDir = path.resolve(options.rootDir);
  const worldDir = resolveInside(rootDir, options.worldDir, "world directory");
  const agentDir = resolveInside(rootDir, options.agentDir, "agent directory");
  const snapshotDir = resolveInside(
    rootDir,
    options.snapshotDir,
    "snapshot directory"
  );
  assertDisjoint(worldDir, agentDir, "world and agent directories");
  assertDisjoint(worldDir, snapshotDir, "world and snapshot directories");
  assertDisjoint(agentDir, snapshotDir, "agent and snapshot directories");
  return { rootDir, worldDir, agentDir, snapshotDir };
}

function resolveInside(rootDir: string, candidate: string, label: string): string {
  const resolved = path.resolve(rootDir, candidate);
  const relative = path.relative(rootDir, resolved);
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a specific path inside the workspace`);
  }
  return resolved;
}

function assertDisjoint(left: string, right: string, label: string): void {
  const relative = path.relative(left, right);
  const reverse = path.relative(right, left);
  if (
    !relative ||
    !reverse ||
    (!relative.startsWith("..") && !path.isAbsolute(relative)) ||
    (!reverse.startsWith("..") && !path.isAbsolute(reverse))
  ) {
    throw new Error(`${label} must not overlap`);
  }
}

function assertDirectory(directory: string, label: string): void {
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Missing ${label} directory: ${directory}`);
  }
}

function assertSnapshotName(name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
    throw new Error(
      "Snapshot name must be 1-64 letters, numbers, dots, underscores, or hyphens"
    );
  }
}

function checkpointMemory(agentDir: string): void {
  const databasePath = path.join(agentDir, "memory.sqlite");
  if (!fs.existsSync(databasePath)) return;
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 1000");
    const result = database
      .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
      .get() as { busy?: number };
    if (Number(result.busy ?? 0) !== 0) {
      throw new Error("SQLite is busy; stop every agent process before snapshotting");
    }
  } finally {
    database.close();
  }
}

function migrateMemory(agentDir: string): void {
  const databasePath = path.join(agentDir, "memory.sqlite");
  if (!fs.existsSync(databasePath)) return;
  const memory = new EpisodicMemory(databasePath);
  memory.close();
}

function copyTree(source: string, target: string, excluded = new Set<string>()): void {
  assertDirectory(source, "source");
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not supported in state: ${sourcePath}`);
    }
    if (entry.isDirectory()) copyTree(sourcePath, targetPath);
    else if (entry.isFile()) fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    else throw new Error(`Unsupported state entry: ${sourcePath}`);
  }
}

function inventoryTree(
  root: string,
  excluded = new Set<string>(),
  relativeDirectory = ""
): SnapshotFile[] {
  const files: SnapshotFile[] = [];
  for (const entry of fs.readdirSync(path.join(root, relativeDirectory), {
    withFileTypes: true
  })) {
    if (!relativeDirectory && excluded.has(entry.name)) continue;
    const relativePath = path.join(relativeDirectory, entry.name);
    const fullPath = path.join(root, relativePath);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not supported in state: ${fullPath}`);
    }
    if (entry.isDirectory()) {
      files.push(...inventoryTree(root, excluded, relativePath));
    } else if (entry.isFile()) {
      const data = fs.readFileSync(fullPath);
      files.push({
        path: relativePath.replaceAll(path.sep, "/"),
        size: data.byteLength,
        sha256: createHash("sha256").update(data).digest("hex")
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function readAndVerifySnapshot(directory: string): WorldStateManifest {
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as WorldStateManifest;
  if (manifest.version !== 1) {
    throw new Error(`Unsupported snapshot manifest version: ${String(manifest.version)}`);
  }
  verifyTree(path.join(directory, "world"), manifest.files.world, "snapshot world");
  verifyTree(path.join(directory, "agent"), manifest.files.agent, "snapshot agent");
  if (rootDigest(manifest.files.world) !== manifest.roots.worldSha256) {
    throw new Error("Snapshot world root digest does not match its manifest");
  }
  if (rootDigest(manifest.files.agent) !== manifest.roots.agentSha256) {
    throw new Error("Snapshot agent root digest does not match its manifest");
  }
  return manifest;
}

function verifyTree(
  directory: string,
  expected: SnapshotFile[],
  label: string,
  excluded = new Set<string>()
): void {
  const actual = inventoryTree(directory, excluded);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} checksum inventory does not match the manifest`);
  }
}

function rootDigest(files: SnapshotFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  }
  return hash.digest("hex");
}

function rollbackRestore(
  paths: WorldStatePaths,
  backup: {
    worldExisted: boolean;
    agentExisted: boolean;
    backupWorld: string;
    backupAgent: string;
  }
): void {
  for (const target of [paths.worldDir, paths.agentDir]) {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
  if (backup.worldExisted && fs.existsSync(backup.backupWorld)) {
    fs.renameSync(backup.backupWorld, paths.worldDir);
  }
  if (backup.agentExisted && fs.existsSync(backup.backupAgent)) {
    fs.renameSync(backup.backupAgent, paths.agentDir);
  }
}

function currentGitCommit(rootDir: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function relativeDisplay(rootDir: string, target: string): string {
  return path.relative(rootDir, target).replaceAll(path.sep, "/");
}

function safeTimestamp(): string {
  return new Date().toISOString().replaceAll(":", "-");
}
