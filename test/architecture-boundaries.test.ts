import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve("src");

function sourceFiles(): string[] {
  return fs
    .readdirSync(SOURCE_ROOT, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => path.join(SOURCE_ROOT, entry));
}

describe("enclosed subsystem boundaries", () => {
  it("keeps locomotion, orientation, and control-state mutations in movement", () => {
    const allowed = new Set([
      path.join(SOURCE_ROOT, "movement-system.ts"),
      path.join(SOURCE_ROOT, "execution-coordinator.ts")
    ]);
    const forbidden = [
      /\.pathfinder\.(?:goto|setGoal|setMovements|stop)\s*\(/,
      /\.clearControlStates\s*\(/,
      /\.setControlState\s*\(/,
      /\.lookAt\s*\(/
    ];
    const violations = sourceFiles()
      .filter((file) => !allowed.has(file))
      .flatMap((file) => {
        const relative = path.relative(SOURCE_ROOT, file);
        return fs
          .readFileSync(file, "utf8")
          .split(/\r?\n/)
          .flatMap((line, index) =>
            forbidden.some((pattern) => pattern.test(line))
              ? [`${relative}:${index + 1}: ${line.trim()}`]
              : []
          );
      });

    expect(violations).toEqual([]);
  });

  it("keeps raw entity visibility and raycasts in sensing adapters", () => {
    const allowed = new Set([
      path.join(SOURCE_ROOT, "perception.ts"),
      path.join(SOURCE_ROOT, "viewer-server.ts")
    ]);
    const forbidden = [
      /(?:this\.)?bot\.entities/,
      /(?:this\.)?bot\.world\.raycast\s*\(/,
      /(?:this\.)?bot\.canSeeBlock\s*\(/
    ];
    const violations = sourceFiles()
      .filter((file) => !allowed.has(file))
      .flatMap((file) => {
        const relative = path.relative(SOURCE_ROOT, file);
        return fs
          .readFileSync(file, "utf8")
          .split(/\r?\n/)
          .flatMap((line, index) =>
            forbidden.some((pattern) => pattern.test(line))
              ? [`${relative}:${index + 1}: ${line.trim()}`]
              : []
          );
      });

    expect(violations).toEqual([]);
  });
});
