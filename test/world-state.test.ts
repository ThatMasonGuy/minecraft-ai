import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EpisodicMemory } from "../src/memory.js";
import {
  createWorldStateSnapshot,
  restoreWorldStateSnapshot
} from "../src/world-state.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("world and agent state snapshots", () => {
  it("restores checksummed world state and exact API ledger totals", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-ai-state-"));
    temporaryDirectories.push(rootDir);
    const worldDir = path.join(rootDir, "test-state", "world");
    const agentDir = path.join(rootDir, "test-state", "agent");
    const snapshotDir = path.join(rootDir, ".minecraft-ai-snapshots");
    fs.mkdirSync(worldDir, { recursive: true });
    fs.mkdirSync(path.join(agentDir, "auth"), { recursive: true });
    fs.writeFileSync(path.join(worldDir, "level.dat"), "baseline world", "utf8");
    fs.writeFileSync(path.join(agentDir, "auth", "credentials.json"), "current-auth", "utf8");

    let memory = new EpisodicMemory(path.join(agentDir, "memory.sqlite"));
    recordUsage(memory, "before-snapshot", 100);
    memory.close();

    const paths = {
      rootDir,
      worldDir,
      agentDir,
      snapshotDir,
      assertStopped: () => undefined
    };
    const manifest = createWorldStateSnapshot("baseline", paths);
    expect(manifest.files.agent.some((file) => file.path.startsWith("auth/"))).toBe(
      false
    );

    fs.writeFileSync(path.join(worldDir, "level.dat"), "mutated world", "utf8");
    fs.writeFileSync(path.join(agentDir, "auth", "credentials.json"), "new-auth", "utf8");
    memory = new EpisodicMemory(path.join(agentDir, "memory.sqlite"));
    recordUsage(memory, "after-snapshot", 200);
    expect(memory.apiUsageSummary().lifetime.calls).toBe(2);
    memory.close();

    const restored = restoreWorldStateSnapshot("baseline", {
      ...paths,
      confirm: true
    });
    expect(fs.readFileSync(path.join(worldDir, "level.dat"), "utf8")).toBe(
      "baseline world"
    );
    expect(
      fs.readFileSync(path.join(agentDir, "auth", "credentials.json"), "utf8")
    ).toBe("new-auth");
    expect(fs.existsSync(restored.safetyBackupDir)).toBe(true);
    expect(restored.retainedApiUsageCalls).toBe(1);

    memory = new EpisodicMemory(path.join(agentDir, "memory.sqlite"));
    expect(memory.apiUsageSummary().lifetime).toMatchObject({
      calls: 2,
      totalTokens: 300
    });
    memory.close();
  });

  it("refuses restore without explicit confirmation", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-ai-state-"));
    temporaryDirectories.push(rootDir);
    expect(() =>
      restoreWorldStateSnapshot("baseline", {
        rootDir,
        worldDir: "test-state/world",
        agentDir: "test-state/agent",
        snapshotDir: ".minecraft-ai-snapshots",
        assertStopped: () => undefined,
        confirm: false
      })
    ).toThrow("requires --confirm");
  });
});

function recordUsage(
  memory: EpisodicMemory,
  requestId: string,
  totalTokens: number
): void {
  const occurredAt = new Date().toISOString();
  memory.recordApiUsage({
    requestId,
    occurredAt,
    completedAt: occurredAt,
    provider: "openai",
    endpoint: "responses",
    requestedModel: "gpt-5.6-luna",
    responseModel: "gpt-5.6-luna",
    serviceTier: "default",
    phase: "snapshot-test",
    status: "completed",
    usage: {
      inputTokens: totalTokens - 10,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10,
      reasoningTokens: 0,
      totalTokens
    },
    webSearchCalls: 0
  });
}
