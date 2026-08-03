# Project TODO

## Durable API usage and cost accounting

Priority: high

Build a permanent, auditable ledger for every paid API operation so operating cost can be reported by lifetime, calendar day, rolling period, model, and workload. Existing `api_usage` events and the rolling token guard must keep working throughout the migration.

Progress: the append-only request ledger, legacy-event backfill, versioned Luna prices, immutable per-request estimates, rolling token-budget integration, raw usage retention, idempotency, lifetime/day/model/phase aggregation, operator-facing API/CLI report, and checksummed snapshot/restore retention are implemented. Remaining work in this item is provider reconciliation and live-call evidence.

### Required data

- Store one immutable record for every API request, including failed and cancelled requests where usage or fees are returned.
- Record request time, response ID, provider, endpoint, requested model, returned model, model snapshot when available, planner trigger, turn/phase, reasoning mode and effort, latency, status, and error class.
- Preserve all reported usage dimensions instead of only `total_tokens`: uncached input, cached input, cache writes, output, reasoning, total tokens, and any newly introduced usage fields.
- Record billable hosted-tool activity and per-call fees, including web search, separately from token charges.
- Use response IDs or another provider-scoped idempotency key to prevent double counting.
- Never interpret unavailable historical fields as zero. Mark them unknown so lifetime totals expose their confidence and coverage.

### Price history and estimates

- Maintain a versioned price catalog keyed by provider, model or model snapshot, operation, currency, and effective date range.
- Record the official source URL and capture time for every price revision. Never overwrite an old price when rates change.
- Calculate each request against the price effective when it occurred, including cached-input discounts, cache-write multipliers, long-context tiers, batch discounts, and hosted-tool fees where applicable.
- Store both the price version used and the calculated amount so historical estimates remain reproducible after future price changes.
- Backfill existing `api_usage` events by their recorded model and timestamp. Surface incomplete or ambiguous backfill separately from confirmed cost.

Initial verified Luna pricing reference as of 2026-08-03: standard short-context `gpt-5.6-luna` usage lists USD $0.20 input, $0.02 cached input, $0.25 cache writes, and $1.20 output per million tokens. Long-context requests above 272K input tokens list $0.40 input, $0.04 cached input, $0.50 cache writes, and $1.80 output per million tokens for the full request. Hosted tools remain separate; web search currently lists $10 per 1,000 calls plus search-content tokens billed at model rates. Sources: https://developers.openai.com/api/docs/models/gpt-5.6-luna and https://developers.openai.com/api/docs/pricing

### Reporting

- Provide lifetime, per-day, rolling-24-hour, per-model, and per-phase totals for requests, tokens, hosted-tool calls, and estimated cost.
- Use an explicit reporting timezone and retain UTC timestamps. Default human-facing daily reports to `Australia/Brisbane` unless configured otherwise.
- Show model mix, cached-token rate, reasoning-token share, average cost per planner turn, and cost per successfully completed task or project where attribution is possible.
- Expose the same aggregates through a machine-readable API and the viewer dashboard or a small CLI report.
- Include price coverage, unknown-cost counts, and last usage timestamp beside every total.

### Durability and verification

- Treat the ledger as append-only project history. Do not prune it with ordinary episodic-memory retention or world resets.
- Add safe backup/export and restore procedures so "lifetime" survives database replacement, host migration, and schema upgrades.
- Add migrations and tests for multi-model aggregation, price changes over time, duplicate response IDs, cached and reasoning tokens, tool fees, partial historical data, timezone day boundaries, and lifetime totals after restart.
- Reconcile sample periods against OpenAI Platform usage/billing exports before treating estimated dollars as authoritative.

### Completion criteria

- A fresh API call appears exactly once with the returned model and every reported usage field.
- Reports correctly aggregate mixed-model history by day, lifetime, model, and phase.
- Historical estimates remain unchanged after a new price version is added.
- Backups restore the full ledger and reproduce identical lifetime totals.
- The viewer or CLI clearly distinguishes confirmed usage, estimated cost, unknown historical cost, and provider-billed totals.
