# Changelog

All notable changes to this project are recorded in this file.

## Unreleased

### Changed

- Enforced enclosed subsystem boundaries so shared capabilities such as movement are consumed through public interfaces instead of being reimplemented inside combat, mining, building, or other systems.
- Centralized deterministic executor priority and Pathfinder mutation ownership in an XState-backed runtime coordinator, so higher-priority safety work preempts lower-priority movement and unowned movement is rejected.
- Restricted the viewer's default bind to loopback and added HTTP security headers, automatic bearer authentication for the operator API, and rate limiting for paid planning requests.
- Replaced raw copying of the WAL-backed memory database in world snapshots with Node's native SQLite online-backup API.
- Updated Webpack past its published build-time SSRF advisories and forced patched UUID implementations in Mineflayer's Microsoft and legacy authentication dependency paths.

### Added

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
