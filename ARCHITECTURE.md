# System Architecture

This file is the ownership map for deterministic behavior. A raw Minecraft operation, policy, retry loop, or state machine belongs to exactly one owner. Other code requests an outcome through that owner's public API.

## Canonical owners

| Owner | File | Exclusive responsibility |
| --- | --- | --- |
| MovementSystem | `src/movement-system.ts` | Pathfinder configuration and goals, direct controls, facing, exact traversal, surface routing, follow, hold, and escape routing |
| SensingSystem | `src/perception.ts` | Current observations, visibility, line of sight, entity resolution, loaded block reads, and loaded-chunk checks |
| InventorySystem | `src/inventory-system.ts` | Carried inventory reads, reservations, equipment, consumption, tool selection, capacity, and inventory layout |
| LootingSystem | `src/looting-system.ts` | Dropped-item selection, collection routing, clear confirmation, and pickup events |
| CombatSystem | `src/combat-system.ts` | Non-player target policy, threat assessment, weapons, shields, attack cadence, spacing, disengagement, recovery, and combat loot requests |
| MiningSystem | `src/mining-system.ts` | Diggability, tool tier, protected-block policy, digging, cancellation, excavation, and mining verification |
| BuildingSystem | `src/building-system.ts` | Block placement, supports, blueprints, traversal placement, retries, and placement verification |
| ProductionSystem | `src/production-system.ts` | Recipe resolution, crafting, furnaces, fuel, output collection, and production outcomes |
| StorageSystem | `src/storage-system.ts` | Owned containers, deposits, withdrawals, capacity pressure, transfer verification, and container accounting |
| SurvivalSystem | `src/survival-system.ts` | Vitals policy, automatic eating, armour upkeep, consumption, sleep, wake, danger edges, and combat readiness |
| CommunicationSystem | `src/communication-system.ts` | Outbound chat and whispers |
| AcquisitionSystem | `src/acquisition-system.ts` | Persistent gather execution, source search, survival pauses, storage cycles, progress, and bounded escalation |
| ProjectSystem | `src/project-system.ts` | Durable multi-stage project execution and verification through lower-level system APIs |
| RecoverySystem | `src/recovery-system.ts` | Safety-gated death-site routing, loadout preparation, loot recovery, expiry, and project rewind |
| TaskSystem | `src/task-system.ts` | Goal, project, work-order, and child-task lifecycle; workflow startup and shutdown |
| TelemetrySystem | `src/telemetry-system.ts` | Persistent subsystem events and activity-channel routing |
| Persistence | `src/memory.ts`, `src/persistence-ports.ts` | SQLite implementation and capability-specific persistence contracts |
| ExecutionCoordinator | `src/execution-coordinator.ts` | Priority, preemption, and exclusive movement ownership across active systems |
| PlannerTools | `src/planner-tools.ts` | Bot-free planner boundary for communication, recall, goals, broad delegation, and cancellation |

## Dependency direction

PlannerTools and operator control submit broad outcomes to TaskSystem. TaskSystem owns AcquisitionSystem, ProjectSystem, and RecoverySystem lifecycles. Those workflows compose Survival, Combat, Looting, Storage, Production, Building, Mining, Inventory, Sensing, and Movement APIs. Telemetry and narrow persistence ports are infrastructure dependencies; they do not issue gameplay operations.

Combat requests movement outcomes such as follow, hold, and escape. It never creates a path. ProjectSystem may request CombatSystem to engage a visible non-player mob, but it never attacks. Building may satisfy MovementSystem's traversal-placement callback, but movement never places a block directly. These are intentional API dependencies, not shared ownership.

## Enforcement

`test/architecture-boundaries.test.ts` rejects raw pathfinding outside MovementSystem, world reads outside SensingSystem, inventory access outside InventorySystem, digging outside MiningSystem, placement outside BuildingSystem, production outside ProductionSystem, container transfer outside StorageSystem, survival mutations outside SurvivalSystem, attacks outside CombatSystem, outbound chat outside CommunicationSystem, task lifecycle writes outside TaskSystem, subsystem-local telemetry, concrete persistence imports, and planner motor capabilities.

When adding behavior:

1. Select its existing owner from the table.
2. Add or extend an outcome-shaped public API on that owner.
3. Call that API from consumers instead of copying internal logic.
4. Add a focused contract test and, when applicable, a raw-primitive boundary assertion.
5. Update this map only if the ownership model itself changes.
