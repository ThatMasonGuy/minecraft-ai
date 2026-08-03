# Minecraft AI Agent Operating Contract

## Project objective

Build a Minecraft player that can perceive, plan, remember, and act autonomously through the project's supported runtime. Progress means a reusable improvement to that system. In-world advancement by itself is test evidence, not project progress.

The OpenAI-powered Minecraft agent is the planner. Deterministic executors are its motor layer. Codex is the engineer and test operator; Codex must not become a substitute Minecraft player.

## Development mode: model calls are opt-in

Development mode is the default whenever Codex is changing, debugging, or locally testing the project.

- Disable the scheduled planner/API interval before starting a development runtime. This applies regardless of whether the configured cadence is 15 minutes, 90 minutes, or another value.
- A large interval is not an acceptable substitute for a real disabled state. If the runtime lacks an explicit way to disable scheduled planning, implement that control before conducting extended live development.
- Keep deterministic executors running when useful. Disabling scheduled model calls must not disable already-persisted work orders, projects, recovery, storage, or safety behavior.
- During development, Codex or the user should give the Minecraft agent explicit high-level tasks through a supported interface. The resulting deterministic work must continue without repeated model involvement wherever the architecture supports it.
- Manual, one-off API calls are allowed when deliberately testing planning, task generation, prompts, schemas, tool selection, or rules around generated tasks.
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

## Completion and reporting

- Report code paths changed, validation performed, model calls made, token usage when available, and autonomous evidence observed.
- Clearly distinguish autonomous behavior, deterministic behavior, model-planned behavior, test setup, and manual intervention.
- Do not call a capability complete because the saved world happens to contain the desired result.
- A capability passes only when it is reproducible through supported interfaces without Codex acting as the motor layer.
- Preserve the perception boundary: use current perception and remembered observations only, never omniscient world or hidden-resource data.
- Preserve explicit movement ownership. Concurrent executors must not compete for Pathfinder control.
