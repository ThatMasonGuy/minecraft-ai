# Minecraft AI

A persistent autonomous Minecraft player built with Mineflayer, SQLite episodic memory, and the OpenAI Responses API.

This is deliberately an embodied agent, not a server plugin:

- It joins through the normal Minecraft protocol as a player.
- It chooses and persists its own goals.
- Its model context contains sampled line-of-sight blocks, visible entities, its own inventory/vitals, recalled observations, and action results.
- Mining and placement require an exact block from the latest line-of-sight observation.
- It cannot query hidden ores, structures, unloaded chunks, server internals, or other players' inventories.
- General Minecraft knowledge can come from hosted web search, but search cannot reveal this world's state.
- Conversations, observations, goal outcomes, failures, and action results survive restarts in SQLite.

## What works now

- Automatic connection and reconnection
- Optimized first-person dashboard with live goals, activity, work progress, vitals, and hotbar
- Microsoft or offline-mode authentication
- Event-driven and scheduled autonomous decision turns
- Persistent goals with model-chosen priorities
- Persistent deterministic project plans with explicit operator-fixture provenance
- Local operator task submission that bypasses the planner and records task provenance
- Append-only episodic events, full observation payloads, FTS5 text recall, and spatial recall
- Remembered public chat and whispers
- First-person ray-sampled block perception and line-of-sight entity perception
- Walking, looking, visible-block mining, visible-reference placement, equipping, eating, crafting, sleeping, approaching visible entities, enclosed deterministic combat and escape handling, chatting, and waiting
- Optional OpenAI-hosted web search for recipes, mechanics, strategies, and build ideas
- Docker restart policy and persistent auth/memory volume

Deterministic behavior is divided into enclosed systems with one owner for each raw Minecraft capability. See [ARCHITECTURE.md](ARCHITECTURE.md) for the ownership map and enforced dependency direction. PlannerTools is intentionally Bot-free: it can communicate, recall, manage goals, delegate a broad gather outcome, or cancel a task, but it cannot move, look, mine, place, craft, equip, fight, or address coordinates.

Player combat and stealing are intentionally absent from the action surface and cannot be enabled by configuration. The combat system never attacks a player; if the same player hits the bot twice within 30 seconds, it preempts ordinary work and delegates an eighteen-block escape to the shared movement system.

Hostile-mob combat is an enclosed deterministic subsystem. It owns threat assessment, equipment, tick-aligned weapon cooldowns, pursuit, strike spacing, shield use, escape decisions, recovery, loot collection, and bounded encounter-level telemetry. It refuses voluntary unarmed combat, explosive threats, uncontrolled groups, and unshielded ranged engagements. All routing—including follow, approach, hold, and multi-threat escape—is requested through the shared movement interface, so movement improvements apply to combat without a second evasion implementation. Movement pathfinding does not dig or pillar implicitly; destructive block changes remain explicit and perception-gated.

## Configure

The OpenAI key is already stored locally in `.env` and is ignored by Git.

Add or change these non-secret values in `.env` as needed:

```dotenv
MC_HOST=localhost
MC_PORT=25565
MC_USERNAME=minecraft-ai
MC_AUTH=microsoft
MC_VERSION=1.21.4
OPENAI_MODEL=gpt-5.6-luna
PLANNER_MODE=manual
PLANNER_TOOL_MODE=dry_run
WEB_SEARCH_ENABLED=false
VIEWER_ENABLED=true
VIEWER_HOST=127.0.0.1
VIEWER_PORT=3007
VIEWER_DISTANCE=3
VIEWER_MAX_FPS=30
VIEWER_MAX_PIXEL_RATIO=1.25
OPERATOR_ENABLED=true
OPERATOR_HOST=127.0.0.1
OPERATOR_PORT=3008
# Optional; otherwise persisted privately under DATA_DIR/operator-token.
# OPERATOR_TOKEN=
```

Use `MC_AUTH=microsoft` for a licensed Java Edition account. On first launch, follow the Microsoft device-login message printed in the terminal. Its refresh token is retained under `data/auth/` so restarts do not require a fresh login.

Use `MC_AUTH=offline` only on a server intentionally configured for offline mode. The default Minecraft version is auto-detected; set `MC_VERSION` only when the server or proxy requires a fixed version.

All options and defaults are documented in `.env.example`.

## Run locally

Requires Node.js 22 or newer:

```powershell
npm install
npm run check
npm test
npm run dev
```

The current defaults connect to `localhost:25565`. Stop with `Ctrl+C`.

Once the bot has spawned, the local operator interface accepts validated deterministic tasks without making an API call. It requires a bearer token stored automatically in `DATA_DIR/operator-token`; the bundled CLI reads that token without printing it:

```powershell
npm run operator -- status
npm run operator -- usage
npm run operator -- gather --item oak_log --blocks oak_log --minimum 16
npm run operator -- project .\path\to\project.json
npm run operator -- cancel "Test finished"
```

Gather commands may add `--continuation until_replaced` and `--container x,y,z`. Detailed project files are operator test fixtures for deterministic-system evaluation, must include deterministic verification, and must not be generated by the planner. Operator-authored work is stored with `origin: operator`; it is test input, not evidence that the planner independently chose the task.

The planner remains a separate, visibly paid path. Use this only for a deliberate one-off model test:

```powershell
npm run operator -- plan "Create one bounded task to test tool selection"
```

The CLI prints a paid-call warning, and the endpoint rejects planning while deterministic work is active. The development default is `PLANNER_TOOL_MODE=dry_run`: one API request is made, proposed tools and arguments are recorded, and nothing is executed or continued. Set `PLANNER_TOOL_MODE=execute` only when tool execution is deliberately part of the test; execute mode may make the initial request plus up to `MAX_TOOL_ROUNDS` continuations. The control API binds to loopback by default. Compose exposes it only at `127.0.0.1:3008`; do not publish it to an untrusted network.

## Run continuously with Docker

The Compose stack runs a private Paper 1.21.4 world and the restart-managed agent:

```powershell
docker compose up -d --build
docker compose logs -f agent
```

On first launch, open the Microsoft device-login link from the agent log. Once authenticated, watch the first-person dashboard at [http://localhost:3007](http://localhost:3007). It shows the agent's primary goal, current activity, deterministic work progress, position, health, hunger, oxygen, experience, and hotbar over its first-person world view. Use the Inventory button to inspect all 27 storage slots, the hotbar, armor, and offhand directly from the current Mineflayer state.

The dashboard defaults to a three-chunk view, 30 FPS, and a 1.25 browser pixel-ratio cap to avoid the heavy initial mesh and GPU load of Prismarine Viewer's defaults. Increase `VIEWER_DISTANCE`, `VIEWER_MAX_FPS`, or `VIEWER_MAX_PIXEL_RATIO` only when the browser has rendering headroom.

The `./data` bind mount contains `memory.sqlite` and the Microsoft authentication cache. The separate `./local-server` bind mount contains the Paper world. Back up both if the agent's life history and world matter.

## Reproducible test-world state

Keep live history separate from destructive evaluation setup by using the test-state template:

```powershell
Copy-Item .env.test.example .env.test
docker compose --env-file .env --env-file .env.test up -d --build
# Run a bounded test, then stop every writer before maintenance.
docker compose --env-file .env --env-file .env.test down
npm run world:snapshot -- create clean-baseline --env-file .env.test
```

List or restore snapshots with:

```powershell
npm run world:snapshot -- list --env-file .env.test
npm run world:snapshot -- restore clean-baseline --confirm --env-file .env.test
```

The workflow refuses maintenance while Compose services are running, uses SQLite's native online-backup API for `memory.sqlite`, restricts all state paths to specific directories inside the workspace, and records a SHA-256 manifest for every captured file. Authentication state and the operator bearer token are deliberately excluded from snapshots; restore preserves the current `data/auth` contents and `data/operator-token`. A restore first moves the current world and agent directories into `.minecraft-ai-restore-backups/`, verifies the restored state, and reports that recovery path.

API usage history is never rewound by a test restore. After restoring the snapshotted planner/executor state, the workflow merges any newer append-only usage and price records from the safety backup into the restored database. Stop any separately launched `npm run dev` process as well as Compose before using these commands.

## Memory model

SQLite runs in WAL mode. Every record contains a timestamp, kind, human-readable summary, optional full JSON payload, coordinates, dimension, actor, and importance. The agent receives recent summaries by default and can explicitly search:

- FTS5 recall for people, places, conversations, discoveries, and failures
- Coordinate-and-dimension recall for memories near its present location
- Active goals ordered by self-assigned priority

Observation payloads retain the exact bounded snapshot supplied to the model. That gives a strong episodic audit trail without pretending stale memories are current facts.

## Autonomy and cost

The planner uses `gpt-5.6-luna`, the cost-sensitive GPT-5.6 tier for high-volume workloads, while retaining Responses API function calling and optional web search. The existing `low` reasoning effort is preserved as the migration baseline. `PLANNER_MODE=manual` and `PLANNER_TOOL_MODE=dry_run` are the development defaults: startup, scheduled reflection, ordinary chat, dangerous vitals, and executor events do not wake the model; an explicit request records proposed tools without executing them. Send `!plan <task>` in chat, a whisper, or the operator CLI to request one deliberate planning turn. Deterministic projects, work orders, recovery, storage, and safety behavior continue without scheduled model calls.

Set both `PLANNER_MODE=automatic` and `PLANNER_TOOL_MODE=execute` only for an intentional autonomous run. Automatic mode preserves startup, terminal executor, and scheduled wakeups; scheduled reflection defaults to once every 90 minutes through `AGENT_TICK_MS=5400000`. Every paid request, including a tool continuation, is separated from the previous completed request by at least 15 minutes through `PLANNER_MIN_REQUEST_INTERVAL_MS=900000`; configuration rejects lower values. Active deterministic projects suppress chat, schedule, vitals, child-work-order, and other planner wakeups until the project completes or exhausts its deterministic recovery paths.

The agent records exact API usage and checks a rolling 24-hour budget before every model call. By default, it stops spending at 850,000 processed tokens, reserving 150,000 tokens beneath the 1,000,000-token daily target for request-size variance. Configure this with `PLANNER_MODE`, `PLANNER_TOOL_MODE`, `DAILY_TOKEN_BUDGET`, `DAILY_TOKEN_RESERVE`, `MAX_OUTPUT_TOKENS`, `AGENT_TICK_MS`, and `MAX_TOOL_ROUNDS`. Web search is disabled by default; it is available only when `WEB_SEARCH_ENABLED=true` and is billed when used.

API attempts are also written to an append-only SQLite ledger with requested and returned model identifiers, response IDs, phase and trigger, latency, status, all reported token dimensions, raw usage JSON, web-search calls, and immutable estimated cost. Every new request also records its planner turn, initial-versus-follow-up role, workload type, trigger source, task type/ID, parent request, and arbitrary bounded tags. Price versions are effective-dated so later price changes do not rewrite historical estimates. Reports aggregate lifetime, Brisbane calendar day, model, phase, request role, workload, trigger, task type, and tag while keeping incomplete historical pricing explicitly unknown.

Use `npm run operator -- usage` for the machine-readable aggregates and the twenty highest-cost planner turns while the runtime is connected. Drill down with filters such as `--request-role follow_up`, `--workload-type task_planning`, `--trigger-source operator`, `--task-type shelter`, `--task-id <id>`, `--model gpt-5.6-luna`, `--from <UTC ISO timestamp>`, or `--tag evaluation=boundary`. Filters can be combined. Explicit planner requests can be attributed at creation time:

```powershell
npm run operator -- plan --task "Develop a safe shelter outcome" --workload task_planning --task-type shelter --tags evaluation=nightly
```

The report is read directly from the runtime's SQLite connection; external tools do not write to the database.

Model pauses do not stop ordinary work. The planner can delegate a broad gathering outcome with an item, minimum success count, and continuation policy. TaskSystem hands that outcome to AcquisitionSystem, which composes movement, mining, storage, sensing, inventory, and survival APIs without further model calls. It pauses for unsafe survival conditions and stops when movement, storage, or the requested resource becomes genuinely unavailable.

The planner is structurally barred from coordinates, individual movement/mining/placement/crafting/container actions, and explicit project blueprints. Its callable surface contains communication, memory, goal management, cancellation, broad deterministic gathering, and coordinate-free supported project outcomes. `delegate_project` currently compiles `starter_shelter` and `diamond_progression` with a bounded `compact` (5x5), `standard` (7x7), or `spacious` (9x9) scale. Scale is a high-level outcome constraint; deterministic code derives every placement and material count, prefers a perceived or remembered wood family, otherwise targets a bounded oak search without claiming a hidden source, reuses owned storage or prepares a nearby site, and creates a linked default goal when requested. Operator-fixture project JSON remains test-only. Unsupported creative outcomes remain measurable goals until the deterministic compiler gains that capability; they must never be bridged with model-authored motor steps.

Players can send `!stop` or `!pause` in chat to cancel active deterministic work immediately without spending model tokens.

## Current boundary

This is a functioning vertical slice, not yet a near-perfect survival player. Containers, furnaces, dropped-item collection, survival, combat, recovery, and durable projects now have enclosed implementations, but several still need bounded live integration evidence. The next capability layer should expand high-level project compilation, acquisition strategies, richer visual scanning, and replay/evaluation tooling while preserving the same rule: the agent may act only on its own state, current perception, or remembered observations.

Useful upstream references:

- [Mineflayer](https://github.com/PrismarineJS/mineflayer)
- [Mineflayer Pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)
- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
