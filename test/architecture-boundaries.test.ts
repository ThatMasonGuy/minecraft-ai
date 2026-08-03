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
  it("keeps broad task submission and cancellation in TaskSystem", () => {
    const allowedSubmission = new Set([
      path.join(SOURCE_ROOT, "memory.ts"),
      path.join(SOURCE_ROOT, "task-system.ts"),
      path.join(SOURCE_ROOT, "seed-house-project.ts"),
      path.join(SOURCE_ROOT, "seed-mining-project.ts")
    ]);
    const allowedStatus = new Set([
      path.join(SOURCE_ROOT, "memory.ts"),
      path.join(SOURCE_ROOT, "task-system.ts")
    ]);
    const violations = sourceFiles().flatMap((file) => {
      const relative = path.relative(SOURCE_ROOT, file);
      return fs
        .readFileSync(file, "utf8")
        .split(/\r?\n/)
        .flatMap((line, index) => {
          const submission =
            /\.create(?:GatherBlocksWorkOrder|ProjectPlan)\s*\(/.test(line) &&
            !allowedSubmission.has(file);
          const status =
            /\.updateWorkOrderStatus\s*\(/.test(line) &&
            !allowedStatus.has(file);
          return submission || status
            ? [`${relative}:${index + 1}: ${line.trim()}`]
            : [];
        });
    });

    expect(violations).toEqual([]);
  });

  it("keeps deterministic workflows independent of the planner action adapter", () => {
    for (const name of [
      "acquisition-system.ts",
      "project-system.ts",
      "recovery-system.ts"
    ]) {
      const workflow = fs.readFileSync(path.join(SOURCE_ROOT, name), "utf8");
      expect(workflow).not.toMatch(/MinecraftActions|actions\.execute/);
    }
  });

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

  it("keeps carried inventory reads and mutations in inventory", () => {
    const allowed = new Set([path.join(SOURCE_ROOT, "inventory-system.ts")]);
    const forbidden = [
      /(?:this\.)?bot\.inventory/,
      /(?:this\.)?bot\.equip\s*\(/,
      /(?:this\.)?bot\.consume\s*\(/,
      /(?:this\.)?bot\.heldItem/,
      /(?:this\.)?bot\.pathfinder\.bestHarvestTool\s*\(/
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

  it("keeps dropped-item selection and collection events in looting", () => {
    const allowed = new Set([
      path.join(SOURCE_ROOT, "entity-classification.ts"),
      path.join(SOURCE_ROOT, "looting-system.ts")
    ]);
    const forbidden = [/isDroppedItemEntity/, /\.on\("playerCollect"/];
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

  it("keeps digging, diggability, and dig cancellation in mining", () => {
    const allowed = new Set([path.join(SOURCE_ROOT, "mining-system.ts")]);
    const forbidden = [
      /(?:this\.)?bot\.dig\s*\(/,
      /(?:this\.)?bot\.canDigBlock\s*\(/,
      /(?:this\.)?bot\.stopDigging\s*\(/
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

  it("keeps block placement in building", () => {
    const allowed = new Set([path.join(SOURCE_ROOT, "building-system.ts")]);
    const violations = sourceFiles()
      .filter((file) => !allowed.has(file))
      .flatMap((file) => {
        const relative = path.relative(SOURCE_ROOT, file);
        return fs
          .readFileSync(file, "utf8")
          .split(/\r?\n/)
          .flatMap((line, index) =>
            /(?:this\.)?bot\.placeBlock\s*\(/.test(line)
              ? [`${relative}:${index + 1}: ${line.trim()}`]
              : []
          );
      });

    expect(violations).toEqual([]);
  });

  it("keeps crafting recipes and furnace mutations in production", () => {
    const allowed = new Set([path.join(SOURCE_ROOT, "production-system.ts")]);
    const forbidden = [
      /(?:this\.)?bot\.craft\s*\(/,
      /(?:this\.)?bot\.recipesFor\s*\(/,
      /(?:this\.)?bot\.openFurnace\s*\(/
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

  it("keeps container transfers in storage", () => {
    const allowed = new Set([path.join(SOURCE_ROOT, "storage-system.ts")]);
    const violations = sourceFiles()
      .filter((file) => !allowed.has(file))
      .flatMap((file) => {
        const relative = path.relative(SOURCE_ROOT, file);
        return fs
          .readFileSync(file, "utf8")
          .split(/\r?\n/)
          .flatMap((line, index) =>
            /(?:this\.)?bot\.openContainer\s*\(/.test(line)
              ? [`${relative}:${index + 1}: ${line.trim()}`]
              : []
          );
      });

    expect(violations).toEqual([]);
  });

  it("keeps vital-state policy, automatic eating, and sleep mutations in survival", () => {
    const allowed = new Set([
      path.join(SOURCE_ROOT, "survival-system.ts"),
      path.join(SOURCE_ROOT, "perception.ts"),
      path.join(SOURCE_ROOT, "viewer-status.ts")
    ]);
    const forbidden = [
      /(?:this\.)?bot\.(?:health|food|oxygenLevel)/,
      /(?:this\.)?bot\.autoEat/,
      /(?:this\.)?bot\.(?:sleep|wake)\s*\(/
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

  it("keeps entity attacks and shield-use mutations in combat", () => {
    const allowed = new Set([path.join(SOURCE_ROOT, "combat-system.ts")]);
    const forbidden = [
      /(?:this\.)?bot\.attack\s*\(/,
      /(?:this\.)?bot\.(?:activateItem|deactivateItem)\s*\(/
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
