# Changelog

All notable changes to this project are recorded in this file.

## Unreleased

### Added

- Added a manual planner mode with explicit `!plan <task>` turns so development does not generate scheduled or incidental API traffic.
- Added repository operating rules for autonomous testing, targeted validation, frequent Git checkpoints, attribution, and changelog maintenance.
- Added a permanent API usage and cost-accounting specification covering lifetime, daily, per-model, and per-workload reporting.
- Added an append-only API usage ledger with legacy backfill, immutable price-version estimates, raw usage retention, request idempotency, failed-attempt records, and lifetime/day/model/phase aggregation.
- Added a loopback-only operator API and CLI for zero-cost deterministic gather/project submission, cancellation, status, and usage reporting, with a separate explicitly paid planner endpoint.
- Added durable planner/operator provenance to work orders and projects so operator test inputs cannot be presented as autonomous choices.

### Changed

- Changed the planner model from `gpt-5.4-mini` to `gpt-5.6-luna` while preserving Responses API tools and low reasoning effort.
- Extended API usage events to record both requested and returned model identifiers plus reasoning effort.
- Forced planner requests onto standard processing so recorded Luna estimates use an explicit service tier rather than an account-dependent default.
