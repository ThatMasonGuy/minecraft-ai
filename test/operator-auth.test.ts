import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateOperatorToken } from "../src/operator-auth.js";

describe("operator token storage", () => {
  it("creates and reuses a private persistent token", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minecraft-ai-token-"));
    try {
      const first = loadOrCreateOperatorToken(directory);
      const second = loadOrCreateOperatorToken(directory);
      expect(first).toHaveLength(64);
      expect(second).toBe(first);
      expect(fs.readFileSync(path.join(directory, "operator-token"), "utf8").trim()).toBe(first);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects weak configured tokens", () => {
    expect(() => loadOrCreateOperatorToken("unused", "too-short")).toThrow(
      /at least 32 characters/
    );
  });
});
