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
- Persistent AI-authored project plans with deterministic execution and verification
- Local operator task submission that bypasses the planner and records task provenance
- Append-only episodic events, full observation payloads, FTS5 text recall, and spatial recall
- Remembered public chat and whispers
- First-person ray-sampled block perception and line-of-sight entity perception
- Walking, looking, visible-block mining, visible-reference placement, equipping, eating, crafting, sleeping, approaching visible entities, deterministic hostile-mob self-defence, chatting, and waiting
- Optional OpenAI-hosted web search for recipes, mechanics, strategies, and build ideas
- Docker restart policy and persistent auth/memory volume

Player combat and stealing are intentionally absent from the action surface. Both the defensive attack tool and automatic self-defence reject every player target. When a non-player entity damages the bot, the deterministic defender can equip a carried melee weapon, pursue only within a short radius, fight until the immediate threat passes, and then return control to ordinary work without requiring a model call. Movement pathfinding is also configured not to dig or pillar implicitly; destructive block changes must use explicit, perception-gated actions.

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
VIEWER_ENABLED=true
VIEWER_PORT=3007
VIEWER_DISTANCE=3
VIEWER_MAX_FPS=30
VIEWER_MAX_PIXEL_RATIO=1.25
OPERATOR_ENABLED=true
OPERATOR_HOST=127.0.0.1
OPERATOR_PORT=3008
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

Once the bot has spawned, the local operator interface accepts validated deterministic tasks without making an API call:

```powershell
npm run operator -- status
npm run operator -- usage
npm run operator -- gather --item oak_log --blocks oak_log --minimum 16
npm run operator -- project .\path\to\project.json
npm run operator -- cancel "Test finished"
```

Gather commands may add `--continuation until_replaced` and `--container x,y,z`. Project files use the same validated schema as planner-authored projects and must include deterministic verification. Operator-authored work is stored with `origin: operator`; it is test input, not evidence that the planner independently chose the task.

The planner remains a separate, visibly paid path. Use this only for a deliberate one-off model test:

```powershell
npm run operator -- plan "Create one bounded task to test tool selection"
```

The CLI prints a paid-call warning, and the endpoint rejects planning while deterministic work is active. Depending on `MAX_TOOL_ROUNDS`, one request can include the initial call plus tool-result continuations. The control API binds to loopback by default. Compose exposes it only at `127.0.0.1:3008`; do not publish it to an untrusted network.

## Run continuously with Docker

The Compose stack runs a private Paper 1.21.4 world and the restart-managed agent:

```powershell
docker compose up -d --build
docker compose logs -f agent
```

On first launch, open the Microsoft device-login link from the agent log. Once authenticated, watch the first-person dashboard at [http://localhost:3007](http://localhost:3007). It shows the agent's primary goal, current activity, deterministic work progress, position, health, hunger, oxygen, experience, and hotbar over its first-person world view. Use the Inventory button to inspect all 27 storage slots, the hotbar, armor, and offhand directly from the current Mineflayer state.

The dashboard defaults to a three-chunk view, 30 FPS, and a 1.25 browser pixel-ratio cap to avoid the heavy initial mesh and GPU load of Prismarine Viewer's defaults. Increase `VIEWER_DISTANCE`, `VIEWER_MAX_FPS`, or `VIEWER_MAX_PIXEL_RATIO` only when the browser has rendering headroom.

The `./data` bind mount contains `memory.sqlite` and the Microsoft authentication cache. The separate `./local-server` bind mount contains the Paper world. Back up both if the agent's life history and world matter.

## Memory model

SQLite runs in WAL mode. Every record contains a timestamp, kind, human-readable summary, optional full JSON payload, coordinates, dimension, actor, and importance. The agent receives recent summaries by default and can explicitly search:

- FTS5 recall for people, places, conversations, discoveries, and failures
- Coordinate-and-dimension recall for memories near its present location
- Active goals ordered by self-assigned priority

Observation payloads retain the exact bounded snapshot supplied to the model. That gives a strong episodic audit trail without pretending stale memories are current facts.

## Autonomy and cost

The planner uses `gpt-5.6-luna`, the cost-sensitive GPT-5.6 tier for high-volume workloads, while retaining Responses API function calling and web search. The existing `low` reasoning effort is preserved as the migration baseline. `PLANNER_MODE=manual` is the default for development: startup, scheduled reflection, ordinary chat, dangerous vitals, and executor events do not wake the model. Send `!plan <task>` in chat or a whisper to request one deliberate planning turn. Deterministic projects, work orders, recovery, storage, and safety behavior continue without scheduled model calls.

Set `PLANNER_MODE=automatic` only for an intentional autonomous run. Automatic mode preserves the existing startup, chat, vitals, executor, and scheduled wakeups; scheduled reflection defaults to once every 90 minutes through `AGENT_TICK_MS=5400000`, with up to two tool continuations.

The agent records exact API usage and checks a rolling 24-hour budget before every model call. By default, it stops spending at 850,000 processed tokens, reserving 150,000 tokens beneath the 1,000,000-token daily target for request-size variance. Configure this with `PLANNER_MODE`, `DAILY_TOKEN_BUDGET`, `DAILY_TOKEN_RESERVE`, `MAX_OUTPUT_TOKENS`, `AGENT_TICK_MS`, and `MAX_TOOL_ROUNDS`. Web search is available only when `WEB_SEARCH_ENABLED=true` and is billed when used.

API attempts are also written to an append-only SQLite ledger with requested and returned model identifiers, response IDs, phase and trigger, latency, status, all reported token dimensions, raw usage JSON, web-search calls, and immutable estimated cost. Price versions are effective-dated so later price changes do not rewrite historical estimates. Reports aggregate lifetime, Brisbane calendar day, model, and phase totals while keeping incomplete historical pricing explicitly unknown.

Use `npm run operator -- usage` for the same machine-readable lifetime, day, model, and phase aggregates while the runtime is connected. This report is read directly from the runtime's SQLite connection; external tools do not write to the database.

Model pauses do not stop ordinary work. The planner can persist a gathering work order with a minimum success count and either stop at that milestone or continue until replaced. The deterministic executor finishes connected trunks, searches nearby through physical movement, tracks cumulative yield across inventory deposits, and runs without API calls. Long-running orders can return to a known chest, trapped chest, or barrel when inventory space runs low, deposit the gathered item, and resume. It still pauses for unsafe survival conditions and stops when movement, storage, or the requested resource becomes genuinely unavailable.

Creative multi-stage goals use persistent project plans. The model authors the choices—a site policy, material palette, underground search geometry, relative blueprint, and completion contract—through `set_project_plan`. The deterministic project executor then surveys candidate sites through physical movement, calculates inventory shortfalls, delegates gathering, crafts to absolute targets, excavates staircases and branch mines without inspecting hidden blocks, returns to saved anchors, places blueprints, survives interruptions, and verifies observable outcomes. Death-site recovery and owned-container storage are also persistent deterministic responsibilities. Plans and progress survive restarts; no model call is required between phases.

Players can send `!stop` or `!pause` in chat to cancel the active deterministic work order immediately without spending model tokens.

## Current boundary

This is a functioning vertical slice, not yet a near-perfect survival player. The next capability layer should add perception-gated containers, furnaces, deliberate dropped-item pickup, richer visual scanning, and replay/evaluation tooling. Those actions should keep the same rule: the agent may act only on its own state, current perception, or remembered observations.

Useful upstream references:

- [Mineflayer](https://github.com/PrismarineJS/mineflayer)
- [Mineflayer Pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)
- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
