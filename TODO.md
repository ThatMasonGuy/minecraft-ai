# Project TODO

## Enclosure-aware combat escape corridors

Priority: high

Replace endpoint-only evasion scoring with a route-aware breakout planner for multi-threat encirclement. The current movement system samples destinations up to 12 blocks away and accepts only endpoints whose minimum threat distance improves on the bot's current position. It does not score the danger crossed along the route or deliberately pass through the least-dangerous gap when every escape initially moves closer to a threat.

Observed deterministic geometry failures:

- A sufficiently wide or dense ring can reject every sampled destination, causing the bot to hold in the middle until the ring collapses inward.
- A tight ring can produce a distant valid endpoint whose straight corridor passes effectively through a mob; a 12-mob radius-3 simulation selected a route with only 0.29 blocks of minimum corridor clearance.
- The planner cannot currently distinguish a controlled temporary reduction in separation from a genuinely unsafe destination.

### Required behavior

- Detect enclosure and angular gaps using only currently perceived threats; do not introduce hidden-entity or unloaded-world knowledge.
- Score the complete candidate corridor or Pathfinder route, including minimum threat clearance, terrain/path cost, ranged line of sight, and whether the route crosses melee reach.
- When no monotonically improving route exists, allow a bounded temporary reduction in separation to break through the least-dangerous visible gap.
- Commit through the selected breakout corridor with hysteresis, while still replanning immediately when a new visible threat invalidates it or the route stalls.
- Preserve subsystem ownership: CombatSystem supplies threat context and requests escape; MovementSystem alone selects and executes the route.
- Provide an explicit blocked/enclosed outcome when no survivable corridor exists so CombatSystem can choose a defensive shove or another bounded survival response instead of silently holding.

### Verification

- Add deterministic ring tests across multiple mob counts and radii, including cases where safety requires temporarily moving closer to one threat.
- Assert that the chosen route maximizes corridor safety rather than endpoint distance alone and never freezes when a viable breakout gap exists.
- Add a bounded live test with a controlled visible ring of tagged mobs; success requires autonomous breakout, no manual steering, and trace evidence of the selected corridor and minimum clearance.
- Keep the planner in manual/dry-run mode and make no paid model calls during movement verification.

### Completion criteria

- The bot escapes both tight and wide incomplete rings through the safest visible gap.
- A complete ring produces an intentional least-risk breakout or explicit enclosed response, not indefinite holding.
- Newly perceived threats can invalidate the breakout before the old path completes.
- Route telemetry explains why a corridor was selected and whether temporary proximity loss was required.

## Durable API usage and cost accounting

Priority: high

Build a permanent, auditable ledger for every paid API operation so operating cost can be reported by lifetime, calendar day, rolling period, model, and workload. Existing `api_usage` events and the rolling token guard must keep working throughout the migration.

Progress: the append-only request ledger, legacy-event backfill, versioned Luna prices, immutable per-request estimates, rolling token-budget integration, raw usage retention, idempotency, hierarchical turn/task attribution, initial-versus-follow-up cost separation, filtered offender reports, checksummed snapshot/restore retention, and one live Luna accounting proof are implemented. Remaining work in this item is provider billing/export reconciliation and success-linked cost-per-completed-task reporting.

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
