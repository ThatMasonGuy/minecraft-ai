import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  estimateApiUsageCostUsdMicros,
  INITIAL_GPT_5_6_LUNA_PRICE,
  summarizeApiUsage,
  type ApiPriceVersion,
  type ApiTokenUsage,
  type ApiUsageRecord,
  type ApiUsageFilters,
  type ApiUsageSummary,
  type ApiUsageWrite
} from "./api-usage.js";
import type {
  GatherBlocksWorkSpec,
  Goal,
  MemoryEvent,
  OwnedContainer,
  Position,
  ProjectPlan,
  ProjectPlanDraft,
  RecoveryJob,
  ResourceSite,
  TaskOrigin,
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
  origin: TaskOrigin;
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
  origin: TaskOrigin;
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

interface ResourceSiteRow {
  id: number;
  block_name: string;
  x: number;
  y: number;
  z: number;
  dimension: string;
  status: ResourceSite["status"];
  first_observed_at: string;
  last_observed_at: string;
}

interface ApiPriceVersionRow {
  id: number;
  provider: string;
  model: string;
  service_tier: string;
  effective_from: string;
  effective_to: string | null;
  long_context_threshold: number;
  short_input_usd_per_million: number;
  short_cached_input_usd_per_million: number;
  short_cache_write_usd_per_million: number;
  short_output_usd_per_million: number;
  long_input_usd_per_million: number;
  long_cached_input_usd_per_million: number;
  long_cache_write_usd_per_million: number;
  long_output_usd_per_million: number;
  web_search_usd_per_thousand: number;
  source_url: string;
  captured_at: string;
}

interface ApiUsageRow {
  id: number;
  request_id: string;
  occurred_at: string;
  completed_at: string;
  provider: string;
  endpoint: string;
  requested_model: string;
  response_id: string | null;
  response_model: string | null;
  service_tier: string | null;
  phase: string;
  trigger: string | null;
  reasoning_effort: string | null;
  turn_id: string | null;
  request_role: ApiUsageRecord["attribution"]["requestRole"] | null;
  workload_type: ApiUsageRecord["attribution"]["workloadType"] | null;
  trigger_source: ApiUsageRecord["attribution"]["triggerSource"] | null;
  task_type: string | null;
  task_id: string | null;
  parent_request_id: string | null;
  tags_json: string | null;
  status: ApiUsageRecord["status"];
  latency_ms: number | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  web_search_calls: number;
  raw_usage_json: string | null;
  error_class: string | null;
  error_message: string | null;
  price_version_id: number | null;
  estimated_cost_usd_micros: number | null;
  pricing_status: ApiUsageRecord["pricingStatus"];
}

export class EpisodicMemory {
  private readonly db: DatabaseSync;
  private suppressApiUsageEvent = false;

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
        origin TEXT NOT NULL DEFAULT 'planner',
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
        origin TEXT NOT NULL DEFAULT 'planner',
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

      CREATE TABLE IF NOT EXISTS resource_sites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        block_name TEXT NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        z INTEGER NOT NULL,
        dimension TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'depleted')),
        first_observed_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        UNIQUE(dimension, block_name, x, y, z)
      );

      CREATE INDEX IF NOT EXISTS idx_resource_sites_lookup
      ON resource_sites(status, dimension, block_name, last_observed_at DESC);

      CREATE TABLE IF NOT EXISTS api_price_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        service_tier TEXT NOT NULL,
        effective_from TEXT NOT NULL,
        effective_to TEXT,
        long_context_threshold INTEGER NOT NULL,
        short_input_usd_per_million REAL NOT NULL,
        short_cached_input_usd_per_million REAL NOT NULL,
        short_cache_write_usd_per_million REAL NOT NULL,
        short_output_usd_per_million REAL NOT NULL,
        long_input_usd_per_million REAL NOT NULL,
        long_cached_input_usd_per_million REAL NOT NULL,
        long_cache_write_usd_per_million REAL NOT NULL,
        long_output_usd_per_million REAL NOT NULL,
        web_search_usd_per_thousand REAL NOT NULL,
        source_url TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        UNIQUE(provider, model, service_tier, effective_from)
      );

      CREATE INDEX IF NOT EXISTS idx_api_prices_lookup
      ON api_price_versions(
        provider, model, service_tier, effective_from DESC
      );

      CREATE TABLE IF NOT EXISTS api_usage_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        provider TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        requested_model TEXT NOT NULL,
        response_id TEXT,
        response_model TEXT,
        service_tier TEXT,
        phase TEXT NOT NULL,
        trigger TEXT,
        reasoning_effort TEXT,
        turn_id TEXT,
        request_role TEXT,
        workload_type TEXT,
        trigger_source TEXT,
        task_type TEXT,
        task_id TEXT,
        parent_request_id TEXT,
        tags_json TEXT,
        status TEXT NOT NULL
          CHECK(status IN ('completed', 'incomplete', 'failed', 'cancelled')),
        latency_ms INTEGER,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        cache_write_tokens INTEGER,
        output_tokens INTEGER,
        reasoning_tokens INTEGER,
        total_tokens INTEGER,
        web_search_calls INTEGER NOT NULL DEFAULT 0,
        raw_usage_json TEXT,
        error_class TEXT,
        error_message TEXT,
        price_version_id INTEGER,
        estimated_cost_usd_micros INTEGER,
        pricing_status TEXT NOT NULL CHECK(pricing_status IN ('estimated', 'unknown')),
        created_at TEXT NOT NULL,
        FOREIGN KEY(price_version_id) REFERENCES api_price_versions(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_api_usage_response_id
      ON api_usage_ledger(provider, response_id)
      WHERE response_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_api_usage_time
      ON api_usage_ledger(occurred_at ASC, id ASC);

      CREATE INDEX IF NOT EXISTS idx_api_usage_model_time
      ON api_usage_ledger(response_model, occurred_at ASC);

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
      "work_orders",
      "origin",
      "TEXT NOT NULL DEFAULT 'planner'"
    );
    this.ensureColumn(
      "projects",
      "origin",
      "TEXT NOT NULL DEFAULT 'planner'"
    );
    this.ensureColumn("api_usage_ledger", "turn_id", "TEXT");
    this.ensureColumn("api_usage_ledger", "request_role", "TEXT");
    this.ensureColumn("api_usage_ledger", "workload_type", "TEXT");
    this.ensureColumn("api_usage_ledger", "trigger_source", "TEXT");
    this.ensureColumn("api_usage_ledger", "task_type", "TEXT");
    this.ensureColumn("api_usage_ledger", "task_id", "TEXT");
    this.ensureColumn("api_usage_ledger", "parent_request_id", "TEXT");
    this.ensureColumn("api_usage_ledger", "tags_json", "TEXT");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_api_usage_turn
      ON api_usage_ledger(turn_id, occurred_at ASC);

      CREATE INDEX IF NOT EXISTS idx_api_usage_attribution
      ON api_usage_ledger(workload_type, request_role, trigger_source, occurred_at ASC);
    `);
    this.ensureColumn(
      "recovery_jobs",
      "loaded_chunk_ms",
      "INTEGER NOT NULL DEFAULT 0"
    );
    this.seedApiPrice(INITIAL_GPT_5_6_LUNA_PRICE);
    this.backfillLegacyApiUsageEvents();
    this.backfillResourceSitesFromObservations();
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
    const eventId = Number(result.lastInsertRowid);
    if (event.kind === "api_usage") {
      this.backfillLegacyApiUsageEvent(eventId, now, event.payload);
    }
    return eventId;
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

  recordApiUsage(input: ApiUsageWrite): ApiUsageRecord {
    const existing = this.apiUsageByRequestId(input.requestId);
    if (existing) return existing;
    const existingResponse = input.responseId
      ? this.apiUsageByResponseId(input.provider, input.responseId)
      : undefined;
    if (existingResponse) return existingResponse;

    const price = this.findApiPrice(
      input.provider,
      input.responseModel ?? input.requestedModel,
      input.serviceTier,
      input.occurredAt
    );
    const estimatedCostUsdMicros =
      price && input.usage
        ? estimateApiUsageCostUsdMicros(
            input.usage,
            input.webSearchCalls,
            price
          )
        : undefined;
    this.db
      .prepare(`
        INSERT INTO api_usage_ledger (
          request_id, occurred_at, completed_at, provider, endpoint,
          requested_model, response_id, response_model, service_tier,
          phase, trigger, reasoning_effort, turn_id, request_role,
          workload_type, trigger_source, task_type, task_id,
          parent_request_id, tags_json, status, latency_ms,
          input_tokens, cached_input_tokens, cache_write_tokens,
          output_tokens, reasoning_tokens, total_tokens, web_search_calls,
          raw_usage_json, error_class, error_message,
          price_version_id, estimated_cost_usd_micros, pricing_status,
          created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `)
      .run(
        input.requestId,
        input.occurredAt,
        input.completedAt,
        input.provider,
        input.endpoint,
        input.requestedModel,
        input.responseId ?? null,
        input.responseModel ?? null,
        input.serviceTier ?? null,
        input.phase,
        input.trigger ?? null,
        input.reasoningEffort ?? null,
        input.attribution.turnId,
        input.attribution.requestRole,
        input.attribution.workloadType,
        input.attribution.triggerSource,
        input.attribution.taskType ?? null,
        input.attribution.taskId ?? null,
        input.attribution.parentRequestId ?? null,
        JSON.stringify(input.attribution.tags),
        input.status,
        input.latencyMs ?? null,
        input.usage?.inputTokens ?? null,
        input.usage?.cachedInputTokens ?? null,
        input.usage?.cacheWriteTokens ?? null,
        input.usage?.outputTokens ?? null,
        input.usage?.reasoningTokens ?? null,
        input.usage?.totalTokens ?? null,
        Math.max(0, Math.round(input.webSearchCalls)),
        input.rawUsage === undefined ? null : JSON.stringify(input.rawUsage),
        input.errorClass ?? null,
        input.errorMessage?.slice(0, 2_000) ?? null,
        price?.id ?? null,
        estimatedCostUsdMicros ?? null,
        estimatedCostUsdMicros === undefined ? "unknown" : "estimated",
        new Date().toISOString()
      );

    const record = this.apiUsageByRequestId(input.requestId);
    if (!record) throw new Error(`API usage ${input.requestId} was not recorded`);
    const usage = input.usage;
    const cost =
      estimatedCostUsdMicros === undefined
        ? "cost unknown"
        : `estimated $${(estimatedCostUsdMicros / 1_000_000).toFixed(6)}`;
    if (!this.suppressApiUsageEvent) {
      this.record({
        occurredAt: input.occurredAt,
        kind: "api_usage",
        summary:
          `${input.provider} ${input.phase} [${input.responseModel ?? input.requestedModel}] ` +
          `${usage?.totalTokens ?? "unknown"} tokens, ${cost}`,
        payload: {
          requestId: input.requestId,
          responseId: input.responseId,
          model: input.responseModel,
          requestedModel: input.requestedModel,
          serviceTier: input.serviceTier,
          phase: input.phase,
          reasoningEffort: input.reasoningEffort,
          attribution: input.attribution,
          status: input.status,
          latencyMs: input.latencyMs,
          webSearchCalls: input.webSearchCalls,
          usage: input.rawUsage ?? input.usage,
          estimatedCostUsdMicros,
          pricingStatus: record.pricingStatus
        },
        importance: input.status === "failed" ? 7 : 3
      });
    }
    return record;
  }

  addApiPriceVersion(price: ApiPriceVersion): ApiPriceVersion {
    this.seedApiPrice(price);
    const row = this.db
      .prepare(`
        SELECT * FROM api_price_versions
        WHERE provider = ? AND model = ? AND service_tier = ?
          AND effective_from = ?
      `)
      .get(
        price.provider,
        price.model,
        price.serviceTier,
        price.effectiveFrom
      ) as ApiPriceVersionRow | undefined;
    if (!row) throw new Error(`API price version for ${price.model} was not recorded`);
    return toApiPriceVersion(row);
  }

  apiUsageRecords(occurredAt?: string): ApiUsageRecord[] {
    const rows = (occurredAt
      ? this.db
          .prepare(`
            SELECT * FROM api_usage_ledger
            WHERE occurred_at >= ?
            ORDER BY occurred_at ASC, id ASC
          `)
          .all(occurredAt)
      : this.db
          .prepare(`
            SELECT * FROM api_usage_ledger
            ORDER BY occurred_at ASC, id ASC
          `)
          .all()) as unknown as ApiUsageRow[];
    return rows.map(toApiUsageRecord);
  }

  apiUsageSummary(
    timezone = "Australia/Brisbane",
    filters: ApiUsageFilters = {}
  ): ApiUsageSummary {
    return summarizeApiUsage(this.apiUsageRecords(), timezone, filters);
  }

  tokenUsageSince(occurredAt: string): number {
    const row = this.db
      .prepare(`
        SELECT COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM api_usage_ledger
        WHERE occurred_at >= ?
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
          total_tokens
        FROM api_usage_ledger
        WHERE occurred_at >= ?
          AND total_tokens IS NOT NULL
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

  rememberResourceSite(
    blockName: string,
    position: Position,
    dimension: string,
    observedAt = new Date().toISOString()
  ): ResourceSite {
    const coordinates = floorPosition(position);
    this.db
      .prepare(`
        INSERT INTO resource_sites(
          block_name, x, y, z, dimension, status,
          first_observed_at, last_observed_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(dimension, block_name, x, y, z) DO UPDATE SET
          status = 'active',
          last_observed_at = excluded.last_observed_at
      `)
      .run(
        blockName,
        coordinates.x,
        coordinates.y,
        coordinates.z,
        dimension,
        observedAt,
        observedAt
      );
    return this.resourceSite(blockName, coordinates, dimension);
  }

  knownResourceSites(
    blockNames: string[],
    dimension: string,
    origin?: Position,
    limit = 30
  ): ResourceSite[] {
    const names = [...new Set(blockNames)].filter(Boolean);
    if (names.length === 0) return [];
    const placeholders = names.map(() => "?").join(", ");
    const distanceOrder = origin
      ? "((x - ?) * (x - ?) + (z - ?) * (z - ?)) ASC,"
      : "";
    const parameters: Array<string | number> = [dimension, ...names];
    if (origin) {
      parameters.push(origin.x, origin.x, origin.z, origin.z);
    }
    parameters.push(Math.max(1, Math.min(limit, 200)));
    const rows = this.db
      .prepare(`
        SELECT * FROM resource_sites
        WHERE status = 'active'
          AND dimension = ?
          AND block_name IN (${placeholders})
        ORDER BY ${distanceOrder} last_observed_at DESC, id DESC
        LIMIT ?
      `)
      .all(...parameters) as unknown as ResourceSiteRow[];
    return rows.map(toResourceSite);
  }

  depleteResourceSite(
    blockName: string,
    position: Position,
    dimension: string
  ): void {
    const coordinates = floorPosition(position);
    this.db
      .prepare(`
        UPDATE resource_sites
        SET status = 'depleted', last_observed_at = ?
        WHERE dimension = ? AND block_name = ? AND x = ? AND y = ? AND z = ?
      `)
      .run(
        new Date().toISOString(),
        dimension,
        blockName,
        coordinates.x,
        coordinates.y,
        coordinates.z
      );
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

  createProjectPlan(
    draft: ProjectPlanDraft,
    origin: TaskOrigin = "planner"
  ): ProjectPlan {
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
            goal_id, title, origin, completion_summary, status, status_reason,
            current_step_index, anchor_json, steps_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'active', NULL, 0, NULL, ?, ?, ?)
        `)
        .run(
          draft.goalId ?? null,
          draft.title,
          origin,
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
    initialInventoryCount = 0,
    origin: TaskOrigin = "planner"
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
          kind, origin, spec_json, status, status_reason,
          progress_count, last_inventory_count, minimum_reached_at,
          created_at, updated_at
        ) VALUES ('gather_blocks', ?, ?, 'active', NULL, 0, ?, NULL, ?, ?)
      `)
      .run(origin, JSON.stringify(spec), initialInventoryCount, now, now);
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

  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    this.db.close();
  }

  private backfillResourceSitesFromObservations(): void {
    const rows = this.db
      .prepare(`
        SELECT occurred_at, payload_json
        FROM events
        WHERE kind = 'observation' AND payload_json IS NOT NULL
        ORDER BY occurred_at ASC, id ASC
      `)
      .all() as unknown as Array<{
        occurred_at: string;
        payload_json: string;
      }>;
    if (rows.length === 0) return;
    const insert = this.db.prepare(`
      INSERT INTO resource_sites(
        block_name, x, y, z, dimension, status,
        first_observed_at, last_observed_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(dimension, block_name, x, y, z) DO NOTHING
    `);
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        continue;
      }
      const snapshot = asRecord(payload);
      const dimension = readString(snapshot.dimension);
      if (!dimension || !Array.isArray(snapshot.visibleBlocks)) continue;
      for (const candidate of snapshot.visibleBlocks) {
        const block = asRecord(candidate);
        const blockName = readString(block.name);
        const x = readNumber(block.x);
        const y = readNumber(block.y);
        const z = readNumber(block.z);
        if (
          !blockName ||
          !isMemorableResourceName(blockName) ||
          x === undefined ||
          y === undefined ||
          z === undefined
        ) {
          continue;
        }
        insert.run(
          blockName,
          Math.floor(x),
          Math.floor(y),
          Math.floor(z),
          dimension,
          row.occurred_at,
          row.occurred_at
        );
      }
    }
  }

  private seedApiPrice(price: ApiPriceVersion): void {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO api_price_versions (
          provider, model, service_tier, effective_from, effective_to,
          long_context_threshold,
          short_input_usd_per_million,
          short_cached_input_usd_per_million,
          short_cache_write_usd_per_million,
          short_output_usd_per_million,
          long_input_usd_per_million,
          long_cached_input_usd_per_million,
          long_cache_write_usd_per_million,
          long_output_usd_per_million,
          web_search_usd_per_thousand,
          source_url, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        price.provider,
        price.model,
        price.serviceTier,
        price.effectiveFrom,
        price.effectiveTo ?? null,
        price.longContextThreshold,
        price.shortInputUsdPerMillion,
        price.shortCachedInputUsdPerMillion,
        price.shortCacheWriteUsdPerMillion,
        price.shortOutputUsdPerMillion,
        price.longInputUsdPerMillion,
        price.longCachedInputUsdPerMillion,
        price.longCacheWriteUsdPerMillion,
        price.longOutputUsdPerMillion,
        price.webSearchUsdPerThousand,
        price.sourceUrl,
        price.capturedAt
      );
  }

  private findApiPrice(
    provider: string,
    model: string,
    serviceTier: string | undefined,
    occurredAt: string
  ): ApiPriceVersion | undefined {
    if (!serviceTier) return undefined;
    const row = this.db
      .prepare(`
        SELECT * FROM api_price_versions
        WHERE provider = ?
          AND model = ?
          AND service_tier = ?
          AND effective_from <= ?
          AND (effective_to IS NULL OR effective_to > ?)
        ORDER BY effective_from DESC, id DESC
        LIMIT 1
      `)
      .get(
        provider,
        model,
        serviceTier,
        occurredAt,
        occurredAt
      ) as ApiPriceVersionRow | undefined;
    return row ? toApiPriceVersion(row) : undefined;
  }

  private apiUsageByRequestId(requestId: string): ApiUsageRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM api_usage_ledger WHERE request_id = ?")
      .get(requestId) as ApiUsageRow | undefined;
    return row ? toApiUsageRecord(row) : undefined;
  }

  private apiUsageByResponseId(
    provider: string,
    responseId: string
  ): ApiUsageRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT * FROM api_usage_ledger
        WHERE provider = ? AND response_id = ?
      `)
      .get(provider, responseId) as ApiUsageRow | undefined;
    return row ? toApiUsageRecord(row) : undefined;
  }

  private backfillLegacyApiUsageEvents(): void {
    const rows = this.db
      .prepare(`
        SELECT id, occurred_at, payload_json
        FROM events
        WHERE kind = 'api_usage'
        ORDER BY id ASC
      `)
      .all() as unknown as Array<{
      id: number;
      occurred_at: string;
      payload_json: string | null;
    }>;
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = row.payload_json ? JSON.parse(row.payload_json) : undefined;
      } catch {
        payload = undefined;
      }
      this.backfillLegacyApiUsageEvent(row.id, row.occurred_at, payload);
    }
  }

  private backfillLegacyApiUsageEvent(
    eventId: number,
    occurredAt: string,
    payload: unknown
  ): void {
    const object = asRecord(payload);
    const rawUsage = asRecord(object.usage);
    const requestId = readString(object.requestId) ?? `legacy-event-${eventId}`;
    if (this.apiUsageByRequestId(requestId)) return;
    const responseId = readString(object.responseId);
    if (responseId && this.apiUsageByResponseId("openai", responseId)) return;
    const requestedModel =
      readString(object.requestedModel) ??
      readString(object.model) ??
      "unknown";
    const responseModel = readString(object.model);
    const totalTokens = readNumber(rawUsage.total_tokens);
    const inputDetails = asRecord(rawUsage.input_tokens_details);
    const outputDetails = asRecord(rawUsage.output_tokens_details);
    const usage: ApiTokenUsage | undefined =
      totalTokens === undefined
        ? undefined
        : {
            inputTokens: readNumber(rawUsage.input_tokens),
            cachedInputTokens: readNumber(inputDetails.cached_tokens),
            cacheWriteTokens: readNumber(inputDetails.cache_write_tokens),
            outputTokens: readNumber(rawUsage.output_tokens),
            reasoningTokens: readNumber(outputDetails.reasoning_tokens),
            totalTokens
          };
    const statusValue = readString(object.status);
    const status: ApiUsageWrite["status"] =
      statusValue === "failed" ||
      statusValue === "cancelled" ||
      statusValue === "incomplete"
        ? statusValue
        : "completed";
    this.suppressApiUsageEvent = true;
    try {
      this.recordApiUsage({
        requestId,
        occurredAt,
        completedAt: occurredAt,
        provider: "openai",
        endpoint: "responses",
        requestedModel,
        responseId,
        responseModel,
        serviceTier: readString(object.serviceTier),
        phase: readString(object.phase) ?? "legacy event",
        reasoningEffort: readString(object.reasoningEffort),
        attribution: {
          turnId: readString(object.turnId) ?? requestId,
          requestRole: readString(object.requestRole) === "follow_up" ? "follow_up" : "initial",
          workloadType: "other",
          triggerSource: "legacy",
          taskType: readString(object.taskType),
          taskId: readString(object.taskId),
          parentRequestId: readString(object.parentRequestId),
          tags: {}
        },
        status,
        latencyMs: readNumber(object.latencyMs),
        usage,
        webSearchCalls: readNumber(object.webSearchCalls) ?? 0,
        rawUsage: rawUsage.total_tokens === undefined ? undefined : rawUsage
      });
    } finally {
      this.suppressApiUsageEvent = false;
    }
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

  private resourceSite(
    blockName: string,
    position: Position,
    dimension: string
  ): ResourceSite {
    const row = this.db
      .prepare(`
        SELECT * FROM resource_sites
        WHERE dimension = ? AND block_name = ? AND x = ? AND y = ? AND z = ?
      `)
      .get(
        dimension,
        blockName,
        position.x,
        position.y,
        position.z
      ) as ResourceSiteRow | undefined;
    if (!row) throw new Error(`Resource site ${blockName} does not exist`);
    return toResourceSite(row);
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

function toApiPriceVersion(row: ApiPriceVersionRow): ApiPriceVersion {
  return {
    id: row.id,
    provider: "openai",
    model: row.model,
    serviceTier: row.service_tier,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to ?? undefined,
    longContextThreshold: row.long_context_threshold,
    shortInputUsdPerMillion: row.short_input_usd_per_million,
    shortCachedInputUsdPerMillion: row.short_cached_input_usd_per_million,
    shortCacheWriteUsdPerMillion: row.short_cache_write_usd_per_million,
    shortOutputUsdPerMillion: row.short_output_usd_per_million,
    longInputUsdPerMillion: row.long_input_usd_per_million,
    longCachedInputUsdPerMillion: row.long_cached_input_usd_per_million,
    longCacheWriteUsdPerMillion: row.long_cache_write_usd_per_million,
    longOutputUsdPerMillion: row.long_output_usd_per_million,
    webSearchUsdPerThousand: row.web_search_usd_per_thousand,
    sourceUrl: row.source_url,
    capturedAt: row.captured_at
  };
}

function toApiUsageRecord(row: ApiUsageRow): ApiUsageRecord {
  const hasUsage = row.total_tokens !== null;
  return {
    id: row.id,
    requestId: row.request_id,
    occurredAt: row.occurred_at,
    completedAt: row.completed_at,
    provider: "openai",
    endpoint: "responses",
    requestedModel: row.requested_model,
    responseId: row.response_id ?? undefined,
    responseModel: row.response_model ?? undefined,
    serviceTier: row.service_tier ?? undefined,
    phase: row.phase,
    trigger: row.trigger ?? undefined,
    reasoningEffort: row.reasoning_effort ?? undefined,
    attribution: {
      turnId: row.turn_id ?? row.request_id,
      requestRole:
        row.request_role ??
        (row.phase.startsWith("tool continuation") ? "follow_up" : "initial"),
      workloadType: row.workload_type ?? "other",
      triggerSource: row.trigger_source ?? "legacy",
      taskType: row.task_type ?? undefined,
      taskId: row.task_id ?? undefined,
      parentRequestId: row.parent_request_id ?? undefined,
      tags: row.tags_json
        ? (JSON.parse(row.tags_json) as Record<string, string>)
        : {}
    },
    status: row.status,
    latencyMs: row.latency_ms ?? undefined,
    usage: hasUsage
      ? {
          inputTokens: row.input_tokens ?? undefined,
          cachedInputTokens: row.cached_input_tokens ?? undefined,
          cacheWriteTokens: row.cache_write_tokens ?? undefined,
          outputTokens: row.output_tokens ?? undefined,
          reasoningTokens: row.reasoning_tokens ?? undefined,
          totalTokens: row.total_tokens!
        }
      : undefined,
    webSearchCalls: row.web_search_calls,
    rawUsage: row.raw_usage_json
      ? JSON.parse(row.raw_usage_json)
      : undefined,
    errorClass: row.error_class ?? undefined,
    errorMessage: row.error_message ?? undefined,
    priceVersionId: row.price_version_id ?? undefined,
    estimatedCostUsdMicros: row.estimated_cost_usd_micros ?? undefined,
    pricingStatus: row.pricing_status
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
    origin: row.origin,
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
    origin: row.origin,
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

function toResourceSite(row: ResourceSiteRow): ResourceSite {
  return {
    id: row.id,
    blockName: row.block_name,
    position: { x: row.x, y: row.y, z: row.z },
    dimension: row.dimension,
    status: row.status,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at
  };
}

function floorPosition(position: Position): Position {
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z)
  };
}

function isMemorableResourceName(name: string): boolean {
  return (
    name.endsWith("_log") ||
    name.endsWith("_stem") ||
    name.endsWith("_ore") ||
    name === "ancient_debris"
  );
}

function clampPriority(priority: number): number {
  return Math.max(1, Math.min(100, Math.round(priority)));
}
