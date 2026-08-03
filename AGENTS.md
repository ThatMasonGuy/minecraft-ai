# Minecraft AI Agent Operating Contract

## Project objective

Build a Minecraft player that can perceive, plan, remember, and act autonomously through the project's supported runtime. Progress means a reusable improvement to that system. In-world advancement by itself is test evidence, not project progress.

The OpenAI-powered Minecraft agent is the planner. Enclosed deterministic systems are its execution layer. Codex is the engineer and test operator; Codex must not become a substitute Minecraft player.

## Planner granularity boundary

The planner may define outcomes, priorities, constraints, minimum success conditions, and replacement or stopping policy. It must never define motor instructions.

For creative construction, the planner may define bounded declarative design geometry such as a connected two-dimensional footprint, entrance topology, dimensions, and wall height. That geometry describes what to build. Deterministic systems still own where and how it is realized: world site, orientation, materials, individual placements, ordering, movement, retries, and verification.

- Never ask the planner to move or look at coordinates, mine or place an individual block, choose a block face, enumerate blueprint placements, craft/equip/consume one step at a time, manipulate a specific slot, or provide a sequence of equivalent low-level instructions.
- Low-level operations may exist only inside their owning deterministic subsystem. They must not exist in PlannerTools or appear in the planner's callable tool surface. Enforce this with narrow types and architecture tests; prompt text alone is not sufficient.
- The planner may delegate only through broad, typed tools such as a gathering outcome. Deterministic code owns source selection, navigation, interaction coordinates, retries, storage choice, decomposition, verification, and continuation.
- Explicit project JSON and compiled three-dimensional block blueprints are operator test fixtures only. Compact planner-authored design geometry is allowed only through a bounded compiler-owned schema; it must not contain world coordinates or compiled placements. Codex must not generate or submit fixture plans as a substitute for a missing high-level project compiler.
- When a broad outcome is unsupported, preserve it as a measurable goal and implement the reusable deterministic compiler or executor. Never temporarily bridge the gap with model-authored coordinates or step-by-step instructions.
- When reviewing a new planner tool, reject any schema that exposes world coordinates, block faces, inventory slots, or an ordered list of motor actions unless the user explicitly changes this architectural rule.

## Enclosed subsystem boundaries

Treat the systems in `ARCHITECTURE.md` as the canonical ownership registry. Each capability has exactly one implementation owner and is consumed through that owner's public API.

- A subsystem owns its policy, state machine, retries, verification, telemetry, and implementation details. Callers request an outcome through its public interface; they must not reproduce or reach into its internal steps.
- Shared capabilities belong to the subsystem that conceptually owns them. Combat may request `follow`, `hold`, or `escape` from movement, but must not calculate routes, construct Pathfinder goals, or maintain a second evasion implementation.
- Improvements to a shared subsystem must flow automatically to every caller. Do not copy movement, block-selection, placement, mining, inventory, or retry algorithms into consumers for local convenience.
- Cross-system dependencies must point one way through narrow interfaces and domain-shaped results. Avoid importing another subsystem's private helpers, state, concrete executor class, or transport-specific primitives.
- Runtime wiring may compose systems and arbitrate ownership, but it must not contain subsystem behavior. Planner and operator surfaces may start or query a system; they must not orchestrate its motor sequence.
- Tests should exercise each subsystem through its public contract with fakes for adjacent systems. Keep end-to-end tests for integration boundaries rather than using them as the only way to validate internal behavior.
- Before adding behavior, identify its owning subsystem. If ownership is ambiguous, define or repair the boundary before implementing the behavior.
- Do not add a generic executor, action module, convenience motor helper, or second implementation beside an existing system. Extend the owning API and route all consumers through it.
- Raw Mineflayer primitives must appear only in the architecture boundary test's approved owner. Update an allowlist only when ownership genuinely changes, never merely to make a new violation pass.
- New gameplay owners use the `*-system.ts` convention, expose outcome-shaped methods, accept adjacent systems through narrow interfaces, and receive only a capability-specific persistence port.
- `runtime.ts` is the composition root. It may construct systems, connect callbacks, and apply execution priority, but it must not absorb gameplay policy.
- `PlannerTools` is a boundary adapter, not a gameplay system. It must remain Bot-free and may expose only broad outcomes. Do not recreate `actions.ts`.
- Player combat is outside the combat subsystem's permitted behavior and must not be exposed through configuration, planner tools, or operator tools. A repeated player attack invokes the movement system's escape outcome without retaliation.

## API cost attribution

- Every new paid request must carry a stable turn ID, `initial` or `follow_up` request role, workload type, trigger source, optional task type/task ID, and bounded string tags.
- All continuations from one planner turn must retain the same turn/task attribution and point to the preceding internal request ID. Never count a follow-up as an unrelated full task.
- Add a new workload or task type when a materially distinct cost center appears; do not overload free-text trigger descriptions as the only attribution.
- Cost reports must remain filterable by model, request role, workload, trigger, task type, task ID, time range, and tag, and must expose the highest-cost turns.
- Legacy rows may be marked `legacy` or `other`; new requests must not be untagged. Review the largest cost rollups before optimizing token use so work targets measured offenders.

## Development mode: model calls are opt-in

Development mode is the default whenever Codex is changing, debugging, or locally testing the project.

- Disable the scheduled planner/API interval before starting a development runtime. This applies regardless of whether the configured cadence is 15 minutes, 90 minutes, or another value.
- A large interval is not an acceptable substitute for a real disabled state. If the runtime lacks an explicit way to disable scheduled planning, implement that control before conducting extended live development.
- Keep deterministic executors running when useful. Disabling scheduled model calls must not disable already-persisted work orders, projects, recovery, storage, or safety behavior.
- During development, Codex or the user should give the Minecraft agent explicit high-level tasks through a supported interface. The resulting deterministic work must continue without repeated model involvement wherever the architecture supports it.
- Manual, one-off API calls are allowed when deliberately testing planning, task generation, prompts, schemas, tool selection, or rules around generated tasks.
- Keep planner tools in `dry_run` mode when the test concerns task generation or tool selection. Enable tool execution only when executing the proposed action or persisting the proposed task is itself inside the declared test boundary.
- Startup, scheduled, chat, vitals, completion, and error wakeups must not cause surprise API spending in development mode. Only the trigger being deliberately tested may invoke the model.
- Before an intentional model call, state the behavior under test and its pass condition. Use the smallest useful number of calls and inspect recorded token usage afterward.
- Do not re-enable autonomous scheduled planning after a development session unless the user explicitly asks for an autonomous evaluation or live run.

## Autonomous evaluation mode

Scheduled or event-driven planning may be enabled only for an explicit autonomous evaluation or live run.

Before enabling it, define:

1. the capability being evaluated;
2. the permitted model triggers and token budget;
3. the observable pass, fail, and stop conditions; and
4. the maximum run duration or other bounded checkpoint.

At the end of the evaluation, return the project to development mode unless the user explicitly requests continued autonomous operation.

## No manual gameplay substitution

Codex may launch, stop, observe, and instrument the Minecraft runtime. Codex may also perform clearly identified test setup when that setup is not the capability under evaluation.

Codex must not obtain apparent progress by:

- manually steering movement, camera, combat, mining, crafting, or inventory actions;
- feeding the agent a stream of step-by-step motor instructions;
- injecting hidden coordinates, unloaded-chunk knowledge, or unseen resource locations;
- teleporting, spawning resources, granting items, or changing game rules to bypass a missing capability; or
- manually completing an objective that the autonomous system was meant to complete.

Any exceptional manual intervention must be necessary for test setup or safety, explicitly disclosed, and excluded from autonomous success claims.

## Development and verification loop

Every live-game test should follow this loop:

1. Declare the system behavior being tested and the pass/fail evidence.
2. Launch the minimum required runtime in development mode.
3. Issue one explicit high-level task or one deliberate planning call, if needed.
4. Observe logs, persisted state, perception, executor ownership, and in-world behavior.
5. When the system fails, capture evidence and fix the reusable executor, state machine, planner rule, or interface.
6. Rerun the same test without compensating manually.
7. Stop or checkpoint the runtime when sufficient evidence has been collected.

If Codex notices that it is spending time helping the character play rather than improving or evaluating the system, stop the gameplay activity and return to diagnosis and implementation.

## Targeted validation

Validation should reduce meaningful uncertainty about the change being made. Do not repeatedly test unrelated behavior merely because a broader test exists.

- Identify the code paths, contracts, and failure modes affected by the current change, then run the smallest test or check that provides credible evidence for them.
- Do not rerun an unchanged capability because another subsystem changed. For example, adding or changing death recovery does not require revalidating block placement unless the placement path, shared movement ownership, inventory restoration, or another relevant dependency was affected.
- Reuse fresh validation evidence from the current development session or checkpoint when the tested code and its dependencies have not changed.
- Documentation and operating-policy-only changes normally need content review and `git diff --check`, not TypeScript compilation, the full unit suite, a viewer build, or live Minecraft testing.
- Run focused unit tests before broader suites. Expand validation only when the focused result exposes uncertainty, the change is cross-cutting, shared infrastructure changed, or a regression would be difficult to detect locally.
- Reserve the full check/test/build sequence for changes that span multiple runtime layers, alter shared contracts or build configuration, prepare a major push/release, or when the user explicitly requests it.
- Live Minecraft tests must name the exact capability under test and stop after sufficient pass/fail evidence is collected. Do not replay previously proven gameplay sequences without a relevant regression risk.
- Do not make paid model calls as routine smoke tests. Invoke the API only when model access, prompting, planning, tool selection, usage accounting, or another model-dependent contract is specifically under test.
- Stop testing when the relevant risk is covered. More repetitions are not inherently stronger evidence.

## Git checkpointing

Treat local Git commits as frequent rollback checkpoints, not only as declarations that a feature is complete.

- Create a local commit after each coherent improvement or change. Do not wait for an entire feature, milestone, or autonomous capability to be complete.
- A checkpoint may contain partial feature work when the committed state is internally coherent and valuable to return to. Make the partial or unverified boundary clear in the commit message and handoff.
- Run validation proportionate to the change before committing when practical. If something remains failing, blocked, or intentionally untested, record that explicitly rather than withholding a useful checkpoint or presenting it as verified.
- Prefer small, single-purpose commits. Do not mix unrelated cleanup, generated state, or user changes into the checkpoint.
- Inspect the working tree before staging. Preserve unrelated user edits and stage only the intended files.
- Never commit credentials, authentication state, `.env`, Minecraft world data, SQLite runtime state, build output, or other ignored/generated artifacts.
- Create an additional checkpoint before a risky refactor, schema migration, destructive maintenance operation, or extended autonomous evaluation when there are uncommitted changes worth preserving.
- Do not rewrite, squash, amend, reset, or discard checkpoint history unless the user explicitly asks.
- A local checkpoint does not imply a GitHub push. Do not push routine checkpoints. Push after a major integrated change or during wrap-up/cleanup only when the user asks or clearly authorizes it.

## Attribution

- Never credit AI, Codex, ChatGPT, OpenAI, a model, or an automated agent as the author or creator of project work.
- Do not add AI co-author trailers, `Generated-by` notices, badges, acknowledgements, commit-message credit, release-note credit, source comments, or public-facing AI attribution.
- Use the repository's normal human author identity and project/team voice. When attribution is required, credit the user, project, or human team as appropriate.
- Describe tools and model behavior only when technically relevant to operating or debugging the Minecraft agent, not as authorship credit.

## Changelog

- Maintain `CHANGELOG.md` as the durable human-readable record of project changes.
- Before every checkpoint commit, review the staged diff and update the `Unreleased` section for any behavior, capability, data schema, operator workflow, configuration default, dependency, compatibility, or developer-process change.
- Write changelog entries in project/team voice and describe the outcome. Never credit AI or tooling.
- Group entries under `Added`, `Changed`, `Fixed`, `Deprecated`, `Removed`, or `Security` as appropriate.
- Keep entries concise but specific enough to identify the affected subsystem and operational impact.
- Pure typo, formatting, comment, or test-only changes that do not alter behavior or supported coverage may omit a changelog entry. State that judgment in the checkpoint handoff when it is not obvious.
- Do not rewrite released history. Move accumulated `Unreleased` entries into a dated version section only when the user asks to prepare a release.

## Completion and reporting

- Report code paths changed, validation performed, model calls made, token usage when available, and autonomous evidence observed.
- Clearly distinguish autonomous behavior, deterministic behavior, model-planned behavior, test setup, and manual intervention.
- Do not call a capability complete because the saved world happens to contain the desired result.
- A capability passes only when it is reproducible through supported interfaces without Codex acting as the motor layer.
- Preserve the perception boundary: use current perception and remembered observations only, never omniscient world or hidden-resource data.
- Preserve explicit movement ownership. Concurrent executors must not compete for Pathfinder control.
