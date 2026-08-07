# Recovery Loop Stage 7 Handoff

## Implemented

Stage 7 adds the first usable normal autonomous `run` loop. `recovery-loop run` now composes the existing lock, startup journal, single coding-agent gateway, safety guard, controller-owned checkpoint boundary, Stage 5 health scheduler, durable state/events, and summary writer without adding a workflow framework or another agent role.

The implementation includes:

- the configured agent-turn and wall-time limits plus the CLI `--max-agent-turns`, `--max-checkpoints`, and `--max-minutes` bounds;
- exclusive `controller.lock` ownership for the entire reconciliation, work, check, stop, and summary operation;
- automatic resume through `run`, including worktree recreation, interrupted checkpoint adoption/completion, interrupted smoke/deep replay, and preservation of safe dirty agent work;
- one work-mode coding-agent invocation at a time, with work selection left entirely to the Stage 6 prompt;
- a durable `agent.pendingResult` record so a completed agent response cannot be lost between the gateway and controller processing;
- controller-owned checkpointing of every nonempty turn before checks, including descendant-commit rescue/normalization and Stage 6 thread rotation;
- smoke after every nonempty checkpoint and deep checks only when the unchanged Stage 5 scheduler says they are due;
- due deep checks at idle boundaries before another agent turn;
- deterministic `changed`, `no_change`, `goal_complete`, and `blocked` handling;
- two-useful-work-miss stopping with reset after any nonempty checkpoint;
- bounded signal, timeout, budget, blocker, completion, safety, and pending-failure stops;
- a measurement-only `runs/<session-id>/summary.json` at each normal or bounded stop.

The Stage 5 health policy remains in `src/health-controller.ts`; `src/controller.ts` is the direct Stage 7 loop and re-exports the established Stage 5 API. High-confidence scanning and diagnostic redaction now share the cohesive `src/safety.ts` module. This keeps the production tree at the plan's 11-module tripwire.

## Startup and resume semantics

`run` opens the current repository, binds a `StateStore` to its Git common directory, and acquires the mutating lock before changing runtime or Git state. It reads tracked configuration from the durable expected commit, so uncheckpointed agent edits cannot alter controller policy.

Startup invokes the existing `reconcileStartup` path before ordinary work. It can recreate the persistent worktree, adopt or finish an interrupted checkpoint, normalize descendant commits left by an interrupted agent, replay a complete interrupted smoke/deep set, or preserve dirty agent work as an `interrupted` checkpoint. A completed-but-unprocessed agent result remains in state and is consumed exactly once after reconciliation. The new nested state field is optional when reading older schema-v1 state and is always explicit in new writes.

If a prior bounded session is stopped, a new `run` starts a new measurement session while preserving repository health, cadence, thread identity, recovery state, and Git history. There is no separate resume command. A pending failure is never bypassed: the run stops at `recovery-pending` without invoking ordinary work.

## Outcomes, budgets, signals, and stopping

- `changed` and `no_change` are observations. Actual Git state decides whether useful work exists.
- Any nonempty safe result resets `consecutiveNoChange`, even if the prose says `no_change`.
- An empty `changed` or `no_change` result increments the miss streak. Two consecutive misses stop as `no-progress`.
- `blocked` is a hard terminal boundary after any safe edits have been checkpointed and checked.
- `goal_complete` is only the agent's belief. Any edits are checkpointed, required checks run at the resulting exact head, and `goal-candidate-ready` is emitted only when the required smoke/deep health observations pass.
- A failed completion, smoke, or deep observation remains a durable unconfirmed pending failure and stops as `recovery-pending`.
- Configured limits remain hard upper bounds; smaller CLI limits narrow the current run. Agent-turn timeout continues to be enforced by the unchanged Stage 6 gateway.
- SIGINT/SIGTERM cancel an active agent turn. Safe dirty edits are reconciled into an interrupted checkpoint and receive mandatory checks before the bounded signal stop. A signal observed after commit creation is deferred until journal completion and configured checks finish.

Stop reasons implemented by Stage 7 are `goal-candidate-ready`, `recovery-pending`, `blocked`, `no-progress`, `max-agent-turns`, `max-checkpoints`, `max-wall-time`, `signal`, `agent-turn-timeout`, `agent-error`, and `guard-rejected`.

## Checkpoint and check scheduling

All normal commits flow through `journaledCheckpoint` via `checkpointAndCheck`; the coding agent never owns canonical history. The guard binds the expected branch, base, worktree, and protected paths before staging. Descendant agent commits receive a verified rescue ref, are soft-reset and consolidated into one controller checkpoint, and cause a durable `agent-history-violation` thread rotation.

`checkpointAndCheck` preserves Stage 5 sequencing: checkpoint, smoke, then a scheduled deep set only when cadence, elapsed time, path/size risk, completion, recovery, or persisted state requires it. The top of the loop also calls `runScheduledChecks`, which permits a due deep set without a new work turn. Check success, pending failure, cadence, and known-good promotion remain determined solely by command results bound to exact Git state; agent prose never changes health.

## Summary and status semantics

Each normal or bounded stop appends `session-stopped`, atomically writes session state as stopped, and writes `summary.json`. The summary contains:

- baseline, final, and known-good commits;
- stop reason/detail and wall time;
- agent turns and token usage;
- controller checkpoint, smoke, deep, and check-time counts;
- observed/confirmed/repaired regression counters;
- revert, rollback, rescue-ref, flaky-check, and human-intervention measurements;
- active failure, same-signature, abandoned-range, rescue, repair-attempt, and recovery-cycle data;
- the complete pending failure;
- the agent's completion belief;
- whether final HEAD received an exact deep pass.

It contains no product-success score. `status` is unchanged and strictly read-only: it takes no mutating lock, creates no state, changes no Git state, and writes no runtime file.

## Deterministic coverage

The Stage 7 integration suite uses the Stage 6 scripted SDK seam and real temporary Git repositories. It adds 12 scenarios covering:

- three useful checkpoint/check cycles with controller commit identity;
- smoke after every checkpoint, no deep on every smoke pass, and exact two-checkpoint cadence;
- a due deep set without new work;
- descendant-commit normalization, rescue-ref reporting, and fresh-thread rotation;
- passing and failing goal completion at exact HEAD;
- durable pending-failure transition independent of optimistic agent prose;
- hard `blocked` stopping;
- agent-turn, checkpoint, and wall-time budgets;
- two misses with reset after useful work;
- cancellation during an agent turn and after checkpoint creation;
- crash-after-commit reconciliation without duplicate commits/events;
- lock contention.

Existing tests continue to cover protected authority rejection and byte-for-byte read-only status behavior. Ordinary tests make no model calls and require no network or credentials.

## Validation

Validation environment:

- Node.js `v25.9.0`
- pnpm `10.33.0`
- Git `2.54.0.windows.1`

Final command results:

| Command | Result |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm test` | PASS — 13 files, 135 tests |
| `pnpm test:acceptance` | PASS — 13 files, 135 tests |
| `pnpm build` | PASS |

The two composite Stage 7 real-Git scenarios use a 60-second test ceiling; all other tests retain the existing 30-second ceiling. Production agent timeout behavior still uses `agentTurnSeconds`.

## Architecture and scope audit

- Production contains 11 TypeScript modules, 4,996 physical lines, and 4,986 nonblank lines.
- `src/controller.ts` is 287 physical lines and contains the direct normal loop.
- `src/health-controller.ts` is 533 lines and preserves the Stage 5 scheduler/health implementation.
- `src/agent-gateway.ts` remains the sole production SDK import site.
- Model names remain configuration strings; network-disabled, web-disabled, noninteractive, workspace-only SDK settings are unchanged.
- There is still exactly one coding-agent role and no Planner, Reviewer, verifier, or repair agent.
- There is no provider/plugin abstraction, workflow/state-machine framework, admission/receipt layer, benchmark judge, push, merge, deployment, or external-service action.
- `init` and standalone `check` orchestration remain deferred; `status` remains read-only.

## Limitations and Stage 8 boundary

Stage 7 records the first failing smoke/deep/completion observation exactly as Stage 5 defines it and stops at the durable recovery boundary. It does not confirm reproducibility, classify repeated observations beyond the existing command result, invoke recovery mode, attempt forward repair, retry repairs, localize a regression, reproduce known-good, revert, roll back, or abandon a direction.

Stage 8 should begin from `health.pendingFailure` and `recovery.activeFailureId`, orchestrate confirmation and the same coding role's recovery prompt, create visible repair checkpoints, enforce repair/signature cycle bounds, and require a full exact-head health pass before clearing the failure. It must not allow ordinary work while that failure remains active. Regression localization, clean revert, rescue/reset policy, and direction abandonment remain Stage 9 or later.
