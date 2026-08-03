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
| Explicit Pathfinder ownership | Verified | Run the focused executor arbitration tests and confirm an active work order prevents competing project movement. | Unit coverage and checkpoint `25be189` |
| Manual planner mode | Verified | Start `AutonomousAgent` in manual mode and confirm startup and automatic wake requests do not schedule a model turn. | `test/planner-mode.test.ts`, checkpoint `03d3f99` |
| GPT-5.6 Luna planner compatibility | Unverified | Make one explicit manual planning request; confirm Responses API access, one valid tool path, returned model identity, and recorded usage. | Configuration only; no paid request made yet |
| Rolling API token budget | Verified | Insert usage either side of the rolling boundary and confirm spend and resume calculations include only the active 24-hour window. | `test/memory.test.ts` and prior live budget checkpoint |
| Permanent usage and cost ledger | Partial | Record mixed-model calls exactly once and reproduce daily/lifetime/model/phase totals using historical price versions. | Focused accounting, memory, operator-report, and snapshot/restore tests; provider reconciliation and live evidence remain |
| Zero-cost operator task submission | Verified | Submit a validated work order through the running process, confirm no API usage delta, and identify the resulting task as operator-issued. | `test/operator-control.test.ts`; focused validation after operator API implementation |
| Test-world snapshot and restore | Verified | Snapshot stopped test state, mutate world and agent data, restore checksummed state, preserve current auth, and retain post-snapshot API ledger history. | `test/world-state.test.ts`; focused snapshot/accounting validation |
| First-person viewer and inventory HUD | Verified | Connect the bot and confirm live first-person world state, full inventory, equipment, hotbar, and planner/work status render. | Viewer checkpoint `25be189` |
| Deterministic self-defence | Partial | Trigger one controlled hostile encounter and confirm single-owner defence engages and disengages without planner control. | Unit coverage; broader live survival behavior not revalidated |
| Death-site recovery | Partial | Use a controlled death with meaningful inventory and confirm one safety-gated recovery job restores reachable items or reports a bounded failure. | Recovery unit coverage; full live path remains incomplete |
| Food search and provisioning | Partial | From low reserves, acquire and retain sufficient safe food through perception-bounded behavior without manual assistance. | Implementation exists; completion contract not proven |
| Multi-stage quarry and hidden-resource projects | Partial | Execute a bounded project through surface setup, physical prospecting, material acquisition, recovery, and return without hidden-block knowledge. | Partial implementation checkpoint `25be189` |
| Perception-gated furnaces and richer containers | Planned | Interact only with a currently perceived target and verify resulting inventory/state through observation. | Not implemented |
| Deliberate dropped-item pickup | Planned | Perceive a dropped target, navigate into pickup range, and confirm inventory delta without hidden entity knowledge. | Not implemented |

## Evaluation rules

- Select only the row affected by the current change plus any directly changed shared dependency.
- Record the exact precondition, command or trigger, pass/fail observation, checkpoint commit, and whether an API call was used.
- Do not upgrade **Partial** or **Unverified** to **Verified** from unit tests when the completion contract explicitly requires live behavior.
- Do not downgrade still-applicable evidence merely because unrelated code changed.
- Operator-issued tasks and test setup are evidence inputs, not autonomous accomplishments.
