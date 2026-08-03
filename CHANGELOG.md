# Changelog

All notable changes to this project are recorded in this file.

## Unreleased

### Changed

- Replaced coded compact, standard, and spacious house choices with planner-authored connected footprint geometry; autonomous house identity and layout now come from planning while deterministic systems own safe realization.
- Replaced roaming project-site surveys with nearby scored candidate selection and bounded MiningSystem-owned site clearing; projects now prepare safe loaded terrain instead of repeatedly pathing through spiral waypoints in search of a pre-cleared rectangle.
- Enforced a hard 15-minute minimum between all planner API requests, stopped tool continuations once deterministic work is active, suppressed every model wake while a recoverable project is progressing, and routed only whole-project completion or irrecoverable blocking back to planning.
- Changed escape routing to retain a useful Pathfinder destination for the full route instead of replacing it every 500 milliseconds; evasion now replans only after reaching the route segment, losing its threat-separation advantage, or genuinely stalling.
- Added escape-route stall detection to MovementSystem so combat blacklists a Pathfinder destination that produces no positional progress and immediately replans toward an alternate safe cell.
- Hardened combat response so a healthy bot can fist-fight one ordinary zombie with a movement-aware kiting cadence, recently defeated entities cannot create phantom follow-up encounters, active encounters are visible in telemetry, ranged threats require either 24-block separation or sustained hard cover, safety must remain quiet before recovery begins, visible threats or fresh damage immediately resume evasion, and hostile classification no longer floods runtime traces through the deprecated `mobType` field.
- Documented the canonical subsystem ownership map and strengthened repository rules against duplicate implementations, generic action/executor layers, runtime gameplay policy, concrete persistence access, and planner motor capabilities; refreshed capability status for the enclosed production, storage, and looting systems.
- Added capability-specific persistence ports for acquisition, building, projects, recovery, storage, tasks, telemetry, and planner memory queries; subsystems no longer receive the full EpisodicMemory database API.
- Replaced the legacy MinecraftActions motor surface with PlannerTools, a Bot-free adapter exposing only communication, memory queries, goal lifecycle, broad gather delegation, and task cancellation; goal mutations now route through TaskSystem as well.
- Extracted outbound chat and whisper mutations into CommunicationSystem; runtime command responses and planner speech now use the same length-bounded API.
- Added TelemetrySystem as the single event and activity-emission API for enclosed subsystems, centralizing persistent journals and viewer-channel routing while retaining SQLite exclusively in the persistence implementation and stopped-stack maintenance tools.
- Completed SensingSystem ownership of loaded-world reads by routing movement collision checks and recovery chunk-lifetime probes through its block and chunk APIs; gameplay systems no longer read Mineflayer's world directly.
- Added TaskSystem as the sole runtime lifecycle API for broad gather delegation, durable project submission, project-owned acquisition, cancellation, active-task status, and workflow startup/shutdown; planner, operator, chat, project, and budget-continuity paths now submit through it.
- Promoted durable multi-step projects from an action-coupled executor to ProjectSystem; surveys, production, mining, traversal, building, food acquisition, storage, verification, and recovery now compose subsystem APIs, and all project world reads route through sensing.
- Routed project food hunting through CombatSystem's visible-mob engagement API, eliminating the parallel project attack loop while preserving the unconditional player-target rejection boundary.
- Promoted persistent gather work from an action-driven executor to AcquisitionSystem; source selection, finite or continuing search, mining, storage pressure, survival pauses, progress accounting, and escalation now compose enclosed subsystem APIs without planner tools.
- Promoted death-site recovery from an action-coupled executor to RecoverySystem; it now orchestrates only movement, sensing, inventory, looting, mining, and storage APIs, with no planner-action dependency or parallel block lookup.
- Extracted vital-state policy, automatic eating, armour upkeep, food consumption, sleeping, waking, danger escalation, and combat-readiness decisions into SurvivalSystem; combat and project workflows now consume survival outcomes instead of raw health or hunger state.
- Replaced the storage executor/action inversion with StorageSystem, which now owns proactive inventory-pressure storage, container selection, deposits, owned-container withdrawals, transfer verification, and persistent container accounting.
- Extracted recipe resolution, bounded crafting, crafting-table interaction, furnace loading, fuel policy, output collection, and production outcomes into ProductionSystem; actions and project workflows no longer call Mineflayer crafting or furnace primitives.
- Extracted blueprint placement, support selection, utility-block placement, traversal scaffolding, stair landings, material checks, retries, and placement verification into BuildingSystem; movement, actions, and project workflows no longer place blocks directly.
- Extracted block safety classification, tool-tier selection, dig retries/timeouts, protected-block rules, falling-block clearance, exact-cell excavation, and collection positioning into MiningSystem; actions, projects, and recovery no longer dig directly.
- Extracted dropped-item selection, filtering, collection routing, clear confirmation, and collection telemetry into LootingSystem; combat and death recovery now share the same deterministic collector.
- Centralized carried-item inspection, equipment, consumption, tool selection, capacity, food classification, full inventory layout, and cross-system item reservations behind InventorySystem.
- Defined a shared sensing-system contract for perception snapshots, visible entity resolution, loaded block inspection, and line-of-sight checks; combat, recovery, projects, and deterministic actions no longer maintain separate entity-visibility queries.
- Consolidated Pathfinder goals, route timeouts, exact-cell traversal, direct control, orientation, and escape routing behind the shared movement-system API; deterministic consumers no longer implement their own locomotion.
- Replaced the coupled self-defence executor with an enclosed combat system that owns encounter policy, equipment, server-tick attack cadence, strike spacing, shields, recovery, loot, and encounter telemetry while delegating every route to the shared movement system.
- Made player combat an unconditional safety boundary: players are never targeted, and a second hit from the same player within 30 seconds triggers a high-priority non-retaliatory escape.
- Moved an immediate wooden defence weapon ahead of quarrying in newly generated mining progressions.
- Enforced enclosed subsystem boundaries so shared capabilities such as movement are consumed through public interfaces instead of being reimplemented inside combat, mining, building, or other systems.
- Centralized deterministic executor priority and Pathfinder mutation ownership in an XState-backed runtime coordinator, so higher-priority safety work preempts lower-priority movement and unowned movement is rejected.
- Restricted the viewer's default bind to loopback and added HTTP security headers, automatic bearer authentication for the operator API, and rate limiting for paid planning requests.
- Replaced raw copying of the WAL-backed memory database in world snapshots with Node's native SQLite online-backup API.
- Updated Webpack past its published build-time SSRF advisories and forced patched UUID implementations in Mineflayer's Microsoft and legacy authentication dependency paths.

### Added

- Added a bounded planner-authored house design language for arbitrary connected footprints, entrance placement, names, and wall heights; deterministic compilation now derives site preparation, materials, workbench location, shell placements, and verification from the authored geometry instead of selecting a coded layout.
- Added a coordinate-free high-level project compiler and `delegate_project` planner tool for verified starter shelters and full diamond progressions; deterministic code now owns material/site selection, complete plan generation, goal linking, and validation.
- Added architecture enforcement against importing the concrete persistence implementation into enclosed subsystems.
- Added planner-tool delegation coverage and enforcement that rejects motor-system imports, coordinate-level tools, a revived actions module, or goal mutations outside TaskSystem.
- Added architecture enforcement against outbound chat mutations outside CommunicationSystem.
- Added focused telemetry routing coverage and architecture enforcement against subsystem-local event/UI callbacks or SQLite access outside persistence infrastructure.
- Added architecture enforcement against direct loaded-block or chunk-column reads outside SensingSystem and read-only viewer presentation.
- Added focused task-lifecycle and operator integration coverage plus enforcement against task creation or cancellation outside TaskSystem, excluding explicit offline seed commands.
- Added combat API coverage for explicit non-player engagements plus architecture enforcement against attacks or shield mutations outside CombatSystem.
- Added focused survival-policy coverage plus enforcement against raw health, hunger, oxygen, automatic-eating, sleep, or wake access outside SurvivalSystem and read-only presentation adapters.
- Added storage transfer and ownership coverage plus enforcement against direct container access outside StorageSystem.
- Added production recipe and unavailable-material coverage plus enforcement against crafting or furnace access outside ProductionSystem.
- Added building placement and missing-material coverage plus enforcement against block placement outside BuildingSystem.
- Added mining authority coverage and enforcement that rejects digging or diggability logic outside MiningSystem.
- Added focused looting selection and collection-event coverage plus enforcement against parallel dropped-item collectors.
- Added deterministic inventory reservation coverage and architecture enforcement that rejects raw carried-inventory access outside InventorySystem.
- Added an architecture boundary test that rejects locomotion, orientation, and control-state mutations outside the movement subsystem.
- Added deterministic combat policy coverage for unarmed, ranged, explosive, multi-hostile, weapon-selection, cooldown, and repeated-player-aggression behavior.
- Added a shared movement-system interface with reusable follow, approach, hold, and multi-threat escape routing outcomes for deterministic subsystems.
- Added a manual planner mode with explicit `!plan <task>` turns so development does not generate scheduled or incidental API traffic.
- Added repository operating rules for autonomous testing, targeted validation, frequent Git checkpoints, attribution, and changelog maintenance.
- Added a permanent API usage and cost-accounting specification covering lifetime, daily, per-model, and per-workload reporting.
- Added an append-only API usage ledger with legacy backfill, immutable price-version estimates, raw usage retention, request idempotency, failed-attempt records, and lifetime/day/model/phase aggregation.
- Added a loopback-only operator API and CLI for zero-cost deterministic gather/project submission, cancellation, status, and usage reporting, with a separate explicitly paid planner endpoint.
- Added durable planner/operator provenance to work orders and projects so operator test inputs cannot be presented as autonomous choices.
- Added checksummed stopped-stack test-world snapshots and recoverable restores that preserve authentication and merge newer permanent API usage history.
- Added configurable Compose host paths and a separate test-state environment template so evaluations do not mutate the long-lived world by default.
- Added hierarchical API cost attribution with turn IDs, initial/follow-up roles, workload and trigger types, task IDs, arbitrary tags, combined report filters, and highest-cost turn ranking.
- Added a high-level gathering delegation tool whose deterministic implementation selects source blocks, storage, and motor behavior.

### Changed

- Changed the planner model from `gpt-5.4-mini` to `gpt-5.6-luna` while preserving Responses API tools and low reasoning effort.
- Changed development planning to dry-run proposed tools by default, preventing action execution and paid continuations during prompt or task-generation tests; hosted web search is now opt-in.
- Extended API usage events to record both requested and returned model identifiers plus reasoning effort.
- Forced planner requests onto standard processing so recorded Luna estimates use an explicit service tier rather than an account-dependent default.
- Removed coordinate-level actions and explicit blueprint authoring from the planner tool surface; unsupported broad goals now wait for deterministic compiler support instead of being micromanaged by the model.
