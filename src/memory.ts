import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  GatherBlocksWorkSpec,
  Goal,
  MemoryEvent,
  OwnedContainer,
  Position,
  ProjectPlan,
  ProjectPlanDraft,
  RecoveryJob,
  WorkOrder
} from "./types.js";

interface EventRow {
  id: number;
  occurred_at: string;
  kind: string;
  summary: string;
  payload_json: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  dimension: string | null;
  actor: string | null;
  importance: number;
}

interface GoalRow {
  id: number;
  title: string;
  rationale: string;
  priority: number;
  status: Goal["status"];
  created_at: string;
  updated_at: string;
}

interface WorkOrderRow {
  id: number;
  kind: WorkOrder["kind"];
  spec_json: string;
  status: WorkOrder["status"];
  status_reason: string | null;
  progress_count: number;
  last_inventory_count: number;
  minimum_reached_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectRow {
  id: number;
  goal_id: number | null;
  title: string;
  completion_summary: string;
  status: ProjectPlan["status"];
  status_reason: string | null;
  current_step_index: number;
  anchor_json: string | null;
  steps_json: string;
  created_at: string;
  updated_at: string;
}

interface RecoveryJobRow {
  id: number;
  x: number;
  y: number;
  z: number;
  dimension: string;
  expected_items_json: string;
  loaded_chunk_ms: number;
  status: RecoveryJob["status"];
  status_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface OwnedContainerRow {
  id: number;
  x: number;
  y: number;
  z: number;
  dimension: string;
  block_name: string;
  label: string | null;
  contents_json: string;
  status: OwnedContainer["status"];
  created_at: string;
  updated_at: string;
}

export class EpisodicMemory {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT,
        x REAL,
        y REAL,
        z REAL,
        dimension TEXT,
        actor TEXT,
        importance INTEGER NOT NULL DEFAULT 5
      );

      CREATE INDEX IF NOT EXISTS idx_events_time ON events(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_position ON events(dimension, x, z);

      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        summary,
        kind,
        actor,
        content='events',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, summary, kind, actor)
        VALUES (new.id, new.summary, new.kind, coalesce(new.actor, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, summary, kind, actor)
        VALUES ('delete', old.id, old.summary, old.kind, coalesce(old.actor, ''));
      END;

      CREATE TABLE IF NOT EXISTS goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        priority INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'abandoned')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_goals_status_priority
      ON goals(status, priority DESC, updated_at DESC);

      CREATE TABLE IF NOT EXISTS work_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK(status IN ('active', 'completed', 'blocked', 'cancelled')),
        status_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_work_orders_status
      ON work_orders(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id INTEGER,
        title TEXT NOT NULL,
        completion_summary TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK(status IN ('active', 'completed', 'blocked', 'cancelled')),
        status_reason TEXT,
        current_step_index INTEGER NOT NULL DEFAULT 0,
        anchor_json TEXT,
        steps_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(goal_id) REFERENCES goals(id)
      );

      CREATE INDEX IF NOT EXISTS idx_projects_status
      ON projects(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS recovery_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        x REAL NOT NULL,
        y REAL NOT NULL,
        z REAL NOT NULL,
        dimension TEXT NOT NULL,
        expected_items_json TEXT NOT NULL,
        loaded_chunk_ms INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL
          CHECK(status IN ('active', 'completed', 'expired', 'cancelled')),
        status_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_recovery_jobs_status
      ON recovery_jobs(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS owned_containers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        z INTEGER NOT NULL,
        dimension TEXT NOT NULL,
        block_name TEXT NOT NULL,
        label TEXT,
        contents_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK(status IN ('active', 'missing')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(dimension, x, y, z)
      );

      CREATE INDEX IF NOT EXISTS idx_owned_containers_status
      ON owned_containers(status, dimension, updated_at DESC);
    `);
    this.ensureColumn(
      "work_orders",
      "progress_count",
      "INTEGER NOT NULL DEFAULT 0"
    );
    this.ensureColumn(
      "work_orders",
      "last_inventory_count",
      "INTEGER NOT NULL DEFAULT 0"
    );
    this.ensureColumn("work_orders", "minimum_reached_at", "TEXT");
    this.ensureColumn(
      "recovery_jobs",
      "loaded_chunk_ms",
      "INTEGER NOT NULL DEFAULT 0"
    );
  }

  record(event: MemoryEvent): number {
    const now = event.occurredAt ?? new Date().toISOString();
    const position = event.position;
    const result = this.db
      .prepare(`
        INSERT INTO events (
          occurred_at, kind, summary, payload_json,
          x, y, z, dimension, actor, importance
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        now,
        event.kind,
        event.summary,
        event.payload === undefined ? null : JSON.stringify(event.payload),
        position?.x ?? null,
        position?.y ?? null,
        position?.z ?? null,
        event.dimension ?? null,
        event.actor ?? null,
        event.importance ?? 5
      );
    return Number(result.lastInsertRowid);
  }

  recent(limit = 30): MemoryEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events ORDER BY occurred_at DESC, id DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 200))) as unknown as EventRow[];
    return rows.map(toMemoryEvent);
  }

  search(query: string, limit = 12): MemoryEvent[] {
    const terms = query
      .trim()
      .split(/\s+/)
      .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ""))
      .filter(Boolean)
      .slice(0, 10);

    if (terms.length === 0) return this.recent(limit);
    const ftsQuery = terms.map((term) => `"${term}"*`).join(" OR ");
    const rows = this.db
      .prepare(`
        SELECT e.*
        FROM events_fts f
        JOIN events e ON e.id = f.rowid
        WHERE events_fts MATCH ?
        ORDER BY bm25(events_fts), e.importance DESC, e.occurred_at DESC
        LIMIT ?
      `)
      .all(ftsQuery, Math.max(1, Math.min(limit, 50))) as unknown as EventRow[];
    return rows.map(toMemoryEvent);
  }

  near(position: Position, dimension: string, radius: number, limit = 20): MemoryEvent[] {
    const rows = this.db
      .prepare(`
        SELECT *,
          ((x - ?) * (x - ?) + (y - ?) * (y - ?) + (z - ?) * (z - ?)) AS distance_sq
        FROM events
        WHERE dimension = ?
          AND x IS NOT NULL
          AND x BETWEEN ? AND ?
          AND y BETWEEN ? AND ?
          AND z BETWEEN ? AND ?
        ORDER BY distance_sq ASC, importance DESC, occurred_at DESC
        LIMIT ?
      `)
      .all(
        position.x,
        position.x,
        position.y,
        position.y,
        position.z,
        position.z,
        dimension,
        position.x - radius,
        position.x + radius,
        position.y - radius,
        position.y + radius,
        position.z - radius,
        position.z + radius,
        Math.max(1, Math.min(limit, 100))
      ) as unknown as EventRow[];
    return rows.map(toMemoryEvent);
  }

  activeGoals(): Goal[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM goals
        WHERE status = 'active'
        ORDER BY priority DESC, updated_at DESC
      `)
      .all() as unknown as GoalRow[];
    return rows.map(toGoal);
  }

  tokenUsageSince(occurredAt: string): number {
    const row = this.db
      .prepare(`
        SELECT COALESCE(
          SUM(CAST(json_extract(payload_json, '$.usage.total_tokens') AS INTEGER)),
          0
        ) AS total_tokens
        FROM events
        WHERE kind = 'api_usage'
          AND occurred_at >= ?
      `)
      .get(occurredAt) as { total_tokens: number };
    return Number(row.total_tokens);
  }

  tokenBudgetAvailableAt(
    spendLimit: number,
    windowMs: number,
    now = new Date()
  ): Date {
    const windowStart = new Date(now.getTime() - windowMs).toISOString();
    const rows = this.db
      .prepare(`
        SELECT
          occurred_at,
          CAST(json_extract(payload_json, '$.usage.total_tokens') AS INTEGER)
            AS total_tokens
        FROM events
        WHERE kind = 'api_usage'
          AND occurred_at >= ?
        ORDER BY occurred_at ASC, id ASC
      `)
      .all(windowStart) as unknown as Array<{
        occurred_at: string;
        total_tokens: number;
      }>;

    let used = rows.reduce(
      (total, row) => total + Number(row.total_tokens ?? 0),
      0
    );
    if (used < spendLimit) return now;

    for (const row of rows) {
      used -= Number(row.total_tokens ?? 0);
      if (used < spendLimit) {
        return new Date(
          new Date(row.occurred_at).getTime() + windowMs + 1
        );
      }
    }

    return new Date(now.getTime() + windowMs);
  }

  activeWorkOrder(): WorkOrder | undefined {
    const row = this.db
      .prepare(`
        SELECT * FROM work_orders
        WHERE status = 'active'
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `)
      .get() as WorkOrderRow | undefined;
    return row ? toWorkOrder(row) : undefined;
  }

  activeRecoveryJob(): RecoveryJob | undefined {
    const row = this.db
      .prepare(`
        SELECT * FROM recovery_jobs
        WHERE status = 'active'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `)
      .get() as RecoveryJobRow | undefined;
    return row ? toRecoveryJob(row) : undefined;
  }

  createRecoveryJob(
    position: Position,
    dimension: string,
    expectedItems: RecoveryJob["expectedItems"]
  ): RecoveryJob {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`
        INSERT INTO recovery_jobs(
          x, y, z, dimension, expected_items_json,
          status, status_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)
      `)
      .run(
        position.x,
        position.y,
        position.z,
        dimension,
        JSON.stringify(expectedItems),
        now,
        now
      );
    return this.recoveryJob(Number(result.lastInsertRowid));
  }

  updateRecoveryJobStatus(
    id: number,
    status: RecoveryJob["status"],
    reason?: string
  ): RecoveryJob {
    this.db
      .prepare(`
        UPDATE recovery_jobs
        SET status = ?, status_reason = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(status, reason ?? null, new Date().toISOString(), id);
    return this.recoveryJob(id);
  }

  addRecoveryLoadedChunkTime(id: number, elapsedMs: number): RecoveryJob {
    this.db
      .prepare(`
        UPDATE recovery_jobs
        SET loaded_chunk_ms = loaded_chunk_ms + ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        Math.max(0, Math.round(elapsedMs)),
        new Date().toISOString(),
        id
      );
    return this.recoveryJob(id);
  }

  ownedContainers(dimension?: string): OwnedContainer[] {
    const rows = (
      dimension
        ? this.db
            .prepare(`
              SELECT * FROM owned_containers
              WHERE status = 'active' AND dimension = ?
              ORDER BY updated_at DESC, id DESC
            `)
            .all(dimension)
        : this.db
            .prepare(`
              SELECT * FROM owned_containers
              WHERE status = 'active'
              ORDER BY updated_at DESC, id DESC
            `)
            .all()
    ) as unknown as OwnedContainerRow[];
    return rows.map(toOwnedContainer);
  }

  registerOwnedContainer(
    position: Position,
    dimension: string,
    blockName: string,
    label?: string
  ): OwnedContainer {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO owned_containers(
          x, y, z, dimension, block_name, label,
          contents_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '{}', 'active', ?, ?)
        ON CONFLICT(dimension, x, y, z) DO UPDATE SET
          block_name = excluded.block_name,
          label = coalesce(excluded.label, owned_containers.label),
          status = 'active',
          updated_at = excluded.updated_at
      `)
      .run(
        Math.floor(position.x),
        Math.floor(position.y),
        Math.floor(position.z),
        dimension,
        blockName,
        label ?? null,
        now,
        now
      );
    const row = this.db
      .prepare(`
        SELECT * FROM owned_containers
        WHERE dimension = ? AND x = ? AND y = ? AND z = ?
      `)
      .get(
        dimension,
        Math.floor(position.x),
        Math.floor(position.y),
        Math.floor(position.z)
      ) as unknown as OwnedContainerRow;
    return toOwnedContainer(row);
  }

  recordContainerDeposit(id: number, itemName: string, count: number): OwnedContainer {
    const row = this.db
      .prepare("SELECT * FROM owned_containers WHERE id = ?")
      .get(id) as OwnedContainerRow | undefined;
    if (!row) throw new Error(`Owned container ${id} does not exist`);
    const contents = JSON.parse(row.contents_json) as Record<string, number>;
    contents[itemName] = (contents[itemName] ?? 0) + count;
    this.db
      .prepare(`
        UPDATE owned_containers
        SET contents_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(JSON.stringify(contents), new Date().toISOString(), id);
    const updated = this.db
      .prepare("SELECT * FROM owned_containers WHERE id = ?")
      .get(id) as unknown as OwnedContainerRow;
    return toOwnedContainer(updated);
  }

  recordContainerWithdrawal(
    id: number,
    itemName: string,
    count: number
  ): OwnedContainer {
    const row = this.db
      .prepare("SELECT * FROM owned_containers WHERE id = ?")
      .get(id) as OwnedContainerRow | undefined;
    if (!row) throw new Error(`Owned container ${id} does not exist`);
    const contents = JSON.parse(row.contents_json) as Record<string, number>;
    contents[itemName] = Math.max(
      0,
      (contents[itemName] ?? 0) - Math.max(0, count)
    );
    if (contents[itemName] === 0) delete contents[itemName];
    this.db
      .prepare(`
        UPDATE owned_containers
        SET contents_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(JSON.stringify(contents), new Date().toISOString(), id);
    const updated = this.db
      .prepare("SELECT * FROM owned_containers WHERE id = ?")
      .get(id) as unknown as OwnedContainerRow;
    return toOwnedContainer(updated);
  }

  workOrder(id: number): WorkOrder {
    return this.workOrderById(id);
  }

  activeProject(): ProjectPlan | undefined {
    const row = this.db
      .prepare(`
        SELECT * FROM projects
        WHERE status = 'active'
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `)
      .get() as ProjectRow | undefined;
    return row ? toProjectPlan(row) : undefined;
  }

  latestProject(): ProjectPlan | undefined {
    const row = this.db
      .prepare(`
        SELECT * FROM projects
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `)
      .get() as ProjectRow | undefined;
    return row ? toProjectPlan(row) : undefined;
  }

  latestCompletedProject(): ProjectPlan | undefined {
    const row = this.db
      .prepare(`
        SELECT * FROM projects
        WHERE status = 'completed'
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `)
      .get() as ProjectRow | undefined;
    return row ? toProjectPlan(row) : undefined;
  }

  project(id: number): ProjectPlan {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(id) as ProjectRow | undefined;
    if (!row) throw new Error(`Project ${id} does not exist`);
    return toProjectPlan(row);
  }

  createProjectPlan(draft: ProjectPlanDraft): ProjectPlan {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          UPDATE projects
          SET status = 'cancelled',
              status_reason = 'Superseded by a newer project',
              updated_at = ?
          WHERE status = 'active'
        `)
        .run(now);
      this.db
        .prepare(`
          UPDATE work_orders
          SET status = 'cancelled',
              status_reason = 'Superseded by a project plan',
              updated_at = ?
          WHERE status = 'active'
        `)
        .run(now);
      const steps = draft.steps.map((step) => ({
        ...step,
        status: "pending" as const,
        state: {}
      }));
      const result = this.db
        .prepare(`
          INSERT INTO projects(
            goal_id, title, completion_summary, status, status_reason,
            current_step_index, anchor_json, steps_json, created_at, updated_at
          ) VALUES (?, ?, ?, 'active', NULL, 0, NULL, ?, ?, ?)
        `)
        .run(
          draft.goalId ?? null,
          draft.title,
          draft.completionSummary,
          JSON.stringify(steps),
          now,
          now
        );
      this.db.exec("COMMIT");
      return this.project(Number(result.lastInsertRowid));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveProject(plan: ProjectPlan): ProjectPlan {
    this.db
      .prepare(`
        UPDATE projects
        SET status = ?,
            status_reason = ?,
            current_step_index = ?,
            anchor_json = ?,
            steps_json = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        plan.status,
        plan.statusReason ?? null,
        plan.currentStepIndex,
        plan.anchor ? JSON.stringify(plan.anchor) : null,
        JSON.stringify(plan.steps),
        new Date().toISOString(),
        plan.id
      );
    return this.project(plan.id);
  }

  createGatherBlocksWorkOrder(
    spec: GatherBlocksWorkSpec,
    initialInventoryCount = 0
  ): WorkOrder {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE work_orders
        SET status = 'cancelled',
            status_reason = 'Superseded by a newer work order',
            updated_at = ?
        WHERE status = 'active'
      `)
      .run(now);
    const result = this.db
      .prepare(`
        INSERT INTO work_orders(
          kind, spec_json, status, status_reason,
          progress_count, last_inventory_count, minimum_reached_at,
          created_at, updated_at
        ) VALUES ('gather_blocks', ?, 'active', NULL, 0, ?, NULL, ?, ?)
      `)
      .run(JSON.stringify(spec), initialInventoryCount, now, now);
    return this.workOrderById(Number(result.lastInsertRowid));
  }

  updateWorkOrderProgress(
    id: number,
    progressCount: number,
    lastInventoryCount: number,
    minimumReachedAt?: string
  ): WorkOrder {
    this.db
      .prepare(`
        UPDATE work_orders
        SET progress_count = ?,
            last_inventory_count = ?,
            minimum_reached_at = coalesce(minimum_reached_at, ?),
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        Math.max(0, Math.round(progressCount)),
        Math.max(0, Math.round(lastInventoryCount)),
        minimumReachedAt ?? null,
        new Date().toISOString(),
        id
      );
    return this.workOrderById(id);
  }

  updateWorkOrderStatus(
    id: number,
    status: WorkOrder["status"],
    reason: string
  ): WorkOrder {
    this.db
      .prepare(`
        UPDATE work_orders
        SET status = ?, status_reason = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(status, reason, new Date().toISOString(), id);
    return this.workOrderById(id);
  }

  createGoal(title: string, rationale: string, priority: number): Goal {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`
        INSERT INTO goals(title, rationale, priority, status, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `)
      .run(title, rationale, clampPriority(priority), now, now);
    return this.goalById(Number(result.lastInsertRowid));
  }

  updateGoal(
    id: number,
    changes: Partial<Pick<Goal, "title" | "rationale" | "priority" | "status">>
  ): Goal {
    const current = this.goalById(id);
    const next = {
      title: changes.title ?? current.title,
      rationale: changes.rationale ?? current.rationale,
      priority: clampPriority(changes.priority ?? current.priority),
      status: changes.status ?? current.status
    };
    this.db
      .prepare(`
        UPDATE goals
        SET title = ?, rationale = ?, priority = ?, status = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.title,
        next.rationale,
        next.priority,
        next.status,
        new Date().toISOString(),
        id
      );
    return this.goalById(id);
  }

  close(): void {
    this.db.close();
  }

  private goalById(id: number): Goal {
    const row = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as
      | GoalRow
      | undefined;
    if (!row) throw new Error(`Goal ${id} does not exist`);
    return toGoal(row);
  }

  private workOrderById(id: number): WorkOrder {
    const row = this.db
      .prepare("SELECT * FROM work_orders WHERE id = ?")
      .get(id) as WorkOrderRow | undefined;
    if (!row) throw new Error(`Work order ${id} does not exist`);
    return toWorkOrder(row);
  }

  private recoveryJob(id: number): RecoveryJob {
    const row = this.db
      .prepare("SELECT * FROM recovery_jobs WHERE id = ?")
      .get(id) as RecoveryJobRow | undefined;
    if (!row) throw new Error(`Recovery job ${id} does not exist`);
    return toRecoveryJob(row);
  }

  private ensureColumn(table: string, column: string, declaration: string): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as unknown as Array<{ name: string }>;
    if (columns.some((candidate) => candidate.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

function toMemoryEvent(row: EventRow): MemoryEvent {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload_json ? JSON.parse(row.payload_json) : undefined,
    position:
      row.x === null || row.y === null || row.z === null
        ? undefined
        : { x: row.x, y: row.y, z: row.z },
    dimension: row.dimension ?? undefined,
    actor: row.actor ?? undefined,
    importance: row.importance
  };
}

function toGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    title: row.title,
    rationale: row.rationale,
    priority: row.priority,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toWorkOrder(row: WorkOrderRow): WorkOrder {
  const raw = JSON.parse(row.spec_json) as Partial<GatherBlocksWorkSpec> & {
    targetCount?: number;
  };
  const spec: GatherBlocksWorkSpec = {
    goalId: raw.goalId,
    itemName: raw.itemName ?? "unknown",
    blockNames: raw.blockNames ?? [],
    minimumCount: raw.minimumCount ?? raw.targetCount ?? 1,
    continuation: raw.continuation ?? "stop_at_minimum",
    storage: raw.storage ?? { mode: "inventory" }
  };
  return {
    id: row.id,
    kind: row.kind,
    spec,
    status: row.status,
    statusReason: row.status_reason ?? undefined,
    progressCount: row.progress_count,
    lastInventoryCount: row.last_inventory_count,
    minimumReachedAt: row.minimum_reached_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toProjectPlan(row: ProjectRow): ProjectPlan {
  return {
    id: row.id,
    goalId: row.goal_id ?? undefined,
    title: row.title,
    completionSummary: row.completion_summary,
    status: row.status,
    statusReason: row.status_reason ?? undefined,
    currentStepIndex: row.current_step_index,
    anchor: row.anchor_json
      ? (JSON.parse(row.anchor_json) as Position)
      : undefined,
    steps: JSON.parse(row.steps_json) as ProjectPlan["steps"],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toRecoveryJob(row: RecoveryJobRow): RecoveryJob {
  return {
    id: row.id,
    position: { x: row.x, y: row.y, z: row.z },
    dimension: row.dimension,
    expectedItems: JSON.parse(row.expected_items_json) as RecoveryJob["expectedItems"],
    loadedChunkMs: row.loaded_chunk_ms,
    status: row.status,
    statusReason: row.status_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toOwnedContainer(row: OwnedContainerRow): OwnedContainer {
  return {
    id: row.id,
    position: { x: row.x, y: row.y, z: row.z },
    dimension: row.dimension,
    blockName: row.block_name,
    label: row.label ?? undefined,
    contents: JSON.parse(row.contents_json) as Record<string, number>,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function clampPriority(priority: number): number {
  return Math.max(1, Math.min(100, Math.round(priority)));
}
