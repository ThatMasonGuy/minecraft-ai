# Capability and Evaluation Catalogue

This catalogue defines the current capability boundary and the smallest credible validation for each subsystem. Update it when a capability or its evidence changes.

Status meanings:

- **Verified**: the listed evidence passed against the current implementation or a still-applicable checkpoint.
- **Partial**: meaningful behavior exists, but the listed completion contract is not fully proven.
- **Unverified**: implemented or configured, but the relevant integration evidence has not been collected.
- **Planned**: not implemented yet.

| Capability | Status | Targeted validation | Last evidence |
| --- | --- | --- | --- |
| Perception-bounded observation and memory | Verified | Observe a loaded area and confirm the snapshot contains only current visible state while recalled observations remain marked as memory. | Local Paper integration checkpoint `25be189` |
| Persistent deterministic gather work orders | Verified | Start one visible-resource order, pause model planning, and confirm minimum progress and continuation survive without further model calls. | Local Paper integration checkpoint `25be189` |
| Work-order storage and resume | Verified | Fill available inventory during one gather order, deposit the target item into known owned storage, and resume the same order. | Local Paper integration checkpoint `25be189` |
| Explicit Pathfinder ownership | Verified | Run the focused execution-coordinator and architecture tests and confirm active systems cannot compete for movement. | `test/execution-coordinator.test.ts`; `test/architecture-boundaries.test.ts` |
| Manual planner mode | Verified | Start `AutonomousAgent` in manual mode and confirm startup and automatic wake requests do not schedule a model turn. | `test/planner-mode.test.ts`, checkpoint `03d3f99` |
| Planner tool dry-run | Verified | Make one explicit manual request, confirm a structured tool proposal is persisted, and confirm no action execution or continuation request occurs. | Live manual dry run on 2026-08-03; `wait({ seconds: 1 })` persisted with no `[action]` log or second request |
| GPT-5.6 Luna planner compatibility | Verified | Make one explicit manual planning request; confirm Responses API access, one valid tool path, returned model identity, and recorded usage. | Live manual dry run on 2026-08-03; one completed Luna request and one valid `wait` proposal |
| Rolling API token budget | Verified | Insert usage either side of the rolling boundary and confirm spend and resume calculations include only the active 24-hour window. | `test/memory.test.ts` and prior live budget checkpoint |
| Permanent usage and cost ledger | Partial | Record mixed-model calls exactly once and reproduce daily/lifetime/model/phase totals using historical price versions. | Focused accounting, operator-report, snapshot/restore, and live Luna evidence; provider-billing reconciliation remains |
| Cost attribution and offender drill-down | Verified | Record one initial request and follow-up under the same turn, then filter and aggregate by role, workload, trigger, task, and tag while ranking turn cost. | `test/api-usage.test.ts`, `test/memory.test.ts`, and operator filter validation |
| High-level-only planner boundary | Verified | Inspect PlannerTools and confirm it is Bot-free, imports no motor systems, and exposes no world coordinates, individual placements, or motor actions while bounded creative geometry and broad delegation remain available. | `test/planner-tools.test.ts`; `test/architecture-boundaries.test.ts`; checkpoint `c7e8f7a` |
| High-level deterministic project compilation | Unverified | Request a supported coordinate-free project outcome and confirm deterministic code chooses perceived or remembered materials/site, persists a validated linked plan, and begins execution without another model call. | Live planning/compilation passed on 2026-08-03; deterministic completion was paused at the failed legacy survey and awaits revalidation with nearby site preparation |
| Enclosed subsystem ownership | Verified | Run the architecture boundary suite and confirm every raw movement, sensing, inventory, combat, mining, building, production, storage, survival, communication, task, telemetry, and persistence primitive has one approved owner. | `test/architecture-boundaries.test.ts`; `ARCHITECTURE.md` |
| Zero-cost operator task submission | Verified | Submit a validated work order through the running process, confirm no API usage delta, and identify the resulting task as operator-issued. | `test/operator-control.test.ts`; focused validation after operator API implementation |
| Test-world snapshot and restore | Verified | Snapshot stopped test state, mutate world and agent data, restore checksummed state, preserve current auth, and retain post-snapshot API ledger history. | `test/world-state.test.ts`; focused snapshot/accounting validation |
| First-person viewer and inventory HUD | Verified | Connect the bot and confirm live first-person world state, full inventory, equipment, hotbar, and planner/work status render. | Viewer checkpoint `25be189` |
| Deterministic self-defence | Partial | Trigger one controlled hostile encounter and confirm single-owner defence engages and disengages without planner control. | Unit coverage; broader live survival behavior not revalidated |
| Death-site recovery | Partial | Use a controlled death with meaningful inventory and confirm one safety-gated recovery job restores reachable items or reports a bounded failure. | Recovery unit coverage; full live path remains incomplete |
| Food search and provisioning | Partial | From low reserves, acquire and retain sufficient safe food through perception-bounded behavior without manual assistance. | Implementation exists; completion contract not proven |
| Multi-stage quarry and hidden-resource projects | Partial | Execute a bounded project through surface setup, physical prospecting, material acquisition, recovery, and return without hidden-block knowledge. | Partial implementation checkpoint `25be189` |
| Perception-gated furnaces and owned containers | Partial | Interact only through ProductionSystem or StorageSystem and verify resulting inventory and accounting. | Focused production/storage unit coverage; live integration not revalidated |
| Deliberate dropped-item pickup | Partial | Perceive a dropped target, route through LootingSystem, and confirm collection telemetry without hidden entity knowledge. | Focused looting unit coverage; live integration not revalidated |

## Evaluation rules

- Select only the row affected by the current change plus any directly changed shared dependency.
- Record the exact precondition, command or trigger, pass/fail observation, checkpoint commit, and whether an API call was used.
- Do not upgrade **Partial** or **Unverified** to **Verified** from unit tests when the completion contract explicitly requires live behavior.
- Do not downgrade still-applicable evidence merely because unrelated code changed.
- Operator-issued tasks and test setup are evidence inputs, not autonomous accomplishments.

## Evidence log

### 2026-08-03 — High-level project execution paused at site selection

- Preconditions: planner `manual`, tools temporarily `execute`, web search disabled, no active work order or project, and one explicit operator-triggered call permitted.
- Trigger: request exactly one `delegate_project` call for a starter shelter with no coordinates, blueprint, or separate goal-only action.
- Planning result: one `gpt-5.6-luna` request created linked goal 13 and planner-origin project 10, compiling a complete eight-step birch shelter plan with deterministic structure verification.
- Cost: one initial request, 4,960 total tokens, zero reasoning tokens, zero web searches, no follow-up request, and estimated cost `$0.001266`.
- Execution result: the legacy site survey advanced through 37 six-block spiral waypoints, logged a no-progress surface-route failure, and did not select a site before the user paused the evaluation.
- Stop state: agent container stopped, project 10 remains active at step 0, Minecraft server remains available, and local planner configuration was returned to development defaults.
- Classification: planner selection, compiler persistence, and no-continuation arbitration passed; end-to-end project completion did not pass and must be rerun against the nearby scored-site preparation implementation.

### 2026-08-03 — GPT-5.6 Luna single-request dry run

- Preconditions: planner `manual`, tools `dry_run`, web search disabled, no active work order or project.
- Trigger: one explicit operator request to propose exactly `wait({ seconds: 1 })` and make no other change.
- Result: requested and returned model `gpt-5.6-luna`, standard service tier, completed status, and exactly one persisted tool proposal with the requested argument.
- Isolation: no tool was executed, no tool-result continuation was requested, no web search ran, and the stack was stopped after evidence collection.
- Ledger delta: one call; 7,625 input tokens, 7,622 cache-write tokens, 32 output tokens including 13 reasoning tokens, 7,657 total tokens, and zero hosted-tool calls.
- Estimated cost: 1,945 USD micro-dollars (`$0.001945`) using the effective-dated Luna standard price record.
- Classification: model-proposed dry-run evidence only; no gameplay or autonomous accomplishment occurred.
