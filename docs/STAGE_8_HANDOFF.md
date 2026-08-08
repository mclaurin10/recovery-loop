# Recovery Loop Stage 8 Handoff

## Implemented

Stage 8 turns a durable smoke, deep, or completion failure into bounded forward repair inside the existing `recovery-loop run` command. A pending failure now preempts ordinary work, is confirmed and classified from exact command evidence, and is either cleared by command-driven health, stopped at a non-product boundary, or handled by the same single coding-agent role in recovery mode.

The implementation includes:

- a direct recovery policy in `src/recovery.ts`, as named by the Stage 8 plan;
- exact failing-result and configured-command validation before confirmation or agent invocation;
- resumable two-of-three confirmation with every attempt persisted at the failing commit;
- distinct product, flaky, infrastructure, and safety outcomes;
- one bounded configured environment-prepare attempt for infrastructure observations at current HEAD;
- the existing Stage 6 coding role and thread, invoked in recovery mode with exact bounded evidence;
- controller-owned `repair` checkpoints through the existing safety guard and journaled Git mutation path;
- existing descendant-commit normalization, rescue-ref creation, and thread rotation during repair;
- failing-predicate-first evaluation followed by complete smoke and deep sets at the same repair commit;
- full-pass-only failure clearing and unchanged Stage 5 known-good promotion;
- durable repair-attempt, recovery-cycle, same-signature, confirmation, environment, and evaluation state;
- bounded repair exhaustion with thread rotation and an explicit Stage 9 handoff;
- deterministic no-change, completion, blocker, timeout, cancellation, malformed-result, and restart behavior;
- recovery measurements in the normal session summary.

The controller lock, startup reconciliation, Git ownership, safety policy, check runner, cadence state, and exact-head health semantics remain the existing implementations. `run` is still the only resume entry point.

## Confirmation and classification

The original command result is attempt one. Recovery reloads that result from its durable result path, validates its complete schema, checks the configured command identity, and verifies the check ID, commit, classification, and signature against the pending failure. Missing, malformed, mismatched, or unbound evidence becomes a safety or infrastructure stop instead of agent input.

`confirmFailure` then applies the established policy:

- rerun once at the exact failing commit;
- if the first two observations disagree, rerun a third time;
- two matching non-pass classifications and signatures produce a confirmed failure;
- two passes classify the original observation as flaky;
- three observations without consensus remain flaky/uncertain and stop as `recovery-flaky`.

Each attempt has an ordinary command log and result file, is appended in order to `health.pendingFailure.confirmationAttempts`, and emits `confirmation-attempted`. Confirmation state can be reloaded after interruption without repeating an already-persisted attempt.

A confirmed product result emits `failure-confirmed`, advances the exact normalized signature recurrence counter, and may enter forward repair. Infrastructure results are never presented as product regressions. If `prepare` is configured, recovery runs it once at current HEAD and reruns the predicate only after prepare passes; otherwise, or if infrastructure remains, the session stops as `recovery-infrastructure`. Safety evidence stops as `recovery-safety` without invoking the coding role. A two-pass flaky consensus clears the observation and schedules complete health revalidation before ordinary work can resume; uncertain flakiness remains durable and stops.

Matching signatures are only recurrence measurements. They are not treated as proof of a shared root cause.

## Forward-repair sequencing

For a confirmed product failure, the controller invokes the existing gateway with `mode: recovery`. The prompt includes the exact command, normalized result, classification, exit/signal/timeout metadata, bounded stdout/stderr tails, complete log and result paths, current and known-good commits, any already-known regression window, persisted confirmation history, prior repair summaries, and the fallback posture. Network, web, login-shell, interaction, workspace, and authority restrictions are unchanged.

Agent prose remains observational. Processing is determined by repository state and command results:

1. Increment and persist the repair attempt before invoking the agent.
2. If the turn leaves safe nonempty work, checkpoint it as kind `repair` before evaluating it.
3. If the agent created descendant commits, preserve a rescue ref, normalize them into a controller-owned repair checkpoint, and rotate the thread through the existing Stage 6 boundary.
4. Run the original failing predicate first at the exact repair commit.
5. If it still produces a product failure, retain the repair checkpoint and continue only while the repair budget remains.
6. If it passes, run every configured smoke command and every configured deep command at that unchanged HEAD. Recovery does not short-circuit these complete sets after the first failure.
7. Clear the pending failure only after both complete sets pass and exact-head safety remains valid.
8. If another command fails, replace the pending boundary with that exact command result and remain in recovery.

A recovery response claiming `goal_complete`, “fixed,” or “tests passed” cannot clear health. A nonempty `no_change` or `goal_complete` response is still checkpointed and evaluated. Empty no-change/completion results consume an attempt. A valid hard `blocked` response stops with the confirmed failure intact. Malformed responses stop as `agent-error`; gateway timeouts stop as `agent-turn-timeout`.

Failed repair commits remain visible on the autonomous branch and keep the controller author/trailers. No repair is squashed away merely because its predicate still fails.

## Repair budgets, rotation, and stopping

`health.pendingFailure.repairAttempts` is incremented exactly once per recovery invocation. At most `limits.maxRepairTurnsPerFailure` turns are allowed for one pending failure boundary. Reaching that limit rotates/clears the Stage 6 thread and stops durably as `repair-exhausted` if the last repair did not establish full health.

For each newly confirmed product boundary, `recovery.lastFailureSignature` and `recovery.sameSignatureCycles` record consecutive normalized-signature recurrence. The pending failure mirrors the active cycle in `recoveryCycles`. A recurrence beyond `limits.maxRecoveryCyclesPerSignature` rotates the thread and stops as `repair-exhausted` before another repair turn.

The bounded stop preserves:

- the active pending failure and exact latest result path;
- confirmation attempt history and classification;
- repair-attempt and recovery-cycle counts;
- last repair and last evaluated repair commits;
- the branch history containing every failed repair checkpoint;
- known-good, cadence, rescue-ref, and prior recovery state.

It does not invoke revert, reset, localization, salvage, or direction-abandonment policy.

## Post-repair health and known-good semantics

Predicate success is only rapid feedback. It is not repair success. `runRecoveryChecks` executes the complete configured smoke and deep sets at the repair commit and uses the existing Stage 5 result application and promotion rules.

Known-good advances only when the unchanged exact HEAD has a complete passing smoke observation and complete passing deep observation. An unhealthy baseline does not cause recovery to invent an anchor. A predicate pass followed by another smoke/deep failure leaves known-good unchanged, creates the accurate next pending boundary, and continues recovery rather than returning to ordinary work.

The pending failure is cleared only by a complete exact-head pass. Agent text, signature similarity, a partial check set, or the passing predicate alone cannot clear it.

## Interruption and restart

SIGINT/SIGTERM cancels an active recovery turn through the existing gateway signal path. Any safe nonempty edits are reconciled through the journaled checkpoint path as kind `repair`, not ordinary work. The session stops as `signal` only after canonical state is recovered.

Startup reconciliation can adopt a repair commit created before a crash, finish the pending journal operation, and evaluate that exact commit once. `lastRepairCommit` and `lastEvaluatedRepairCommit` prevent duplicate repair evaluation. A completed-but-unprocessed gateway result retains its `mode`, so restart dispatches it to recovery processing rather than the normal work handler. Persisted confirmation attempts are likewise resumed rather than discarded.

At every restart, a pending failure is processed before the ordinary work path. There is no separate resume command and no window in which unrelated feature work can bypass active recovery.

## Summary and status semantics

The Stage 7 summary remains measurement-only and now includes:

- confirmation attempt count;
- confirmed regressions and repaired regressions;
- recovery agent turns and repair checkpoints;
- repair evaluations and recovery cycles;
- environment attempts;
- product, flaky, infrastructure, and safety classification counts;
- flaky observations;
- active signature and same-signature recurrence;
- pending repair, cycle, confirmation, and environment counts;
- the complete current pending failure.

Existing checkpoint, check, token, wall-time, rescue, rollback/revert measurement, and completion-belief fields remain. There is still no product-success score.

`status` is unchanged and strictly read-only. Stage 8 did not modify its CLI path or state-store behavior, and existing byte-for-byte tests continue to cover it.

## Deterministic coverage

The new real-Git Stage 8 integration suite contains 17 scenarios covering:

- immediate confirmed smoke regression fixed by the first repair;
- fail/fail, fail/pass/fail, and fail/pass/pass confirmation;
- infrastructure, bounded prepare recovery, and safety boundaries without product misrepresentation;
- a failed first repair followed by a passing second repair;
- predicate-first evaluation and a different deep failure after predicate success;
- complete post-repair smoke/deep execution and known-good promotion;
- an unhealthy baseline with no invented known-good anchor;
- preservation and controller ownership of failed repair checkpoints;
- exact recovery evidence reaching the same coding role;
- descendant-commit rescue/normalization and thread rotation;
- hard blockers, empty no-change, optimistic prose, malformed responses, and timeouts;
- repair-attempt exhaustion and same-signature cycle exhaustion;
- cancellation with useful repair edits;
- crash-after-repair-commit adoption and exactly-once evaluation.

Existing real-Git suites continue to cover command logs/results, state/events, summaries, no ordinary work past a pending boundary, lock contention, authority guards, startup journals, and read-only status. All ordinary tests use the deterministic Stage 6 SDK seam and make no real model, network, or credential calls.

Vitest is capped at two file workers. The process-heavy temporary-Git suites otherwise saturate Windows subprocess creation when the recovery and normal-controller files overlap, causing harness timeouts unrelated to assertions. Two workers preserve file concurrency while keeping individual tests within their existing ceilings.

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
| `pnpm test` | PASS - 14 files, 153 tests |
| `pnpm test:acceptance` | PASS - 14 files, 153 tests |
| `pnpm build` | PASS |

`pnpm test:acceptance` completed in 395.40 seconds with the two-worker cap.

## Architecture and scope audit

- Production contains 12 TypeScript modules, 5,810 physical lines, and 5,779 nonblank lines.
- `src/recovery.ts` is 595 physical lines and contains the direct Stage 8 policy explicitly named in the implementation plan.
- `src/controller.ts` is 339 lines and remains the direct outer run loop; folding recovery into it would produce a roughly 900-line mixed policy.
- `src/health-controller.ts` is 585 lines and remains the Stage 5 scheduler/health authority.
- `src/agent-gateway.ts` remains the sole production SDK import site.
- There is still exactly one coding-agent role and no planner, reviewer, verifier, or separate repair agent.
- There is no provider/plugin abstraction or generic workflow/state-machine framework.
- Model names and the Stage 6 network-disabled, web-disabled, noninteractive, workspace-only settings are unchanged.
- `status` is untouched; there is no push, merge, deployment, external-service action, benchmark judge, receipt/admission layer, or product-success score.

This is one module and 814 physical lines above the Stage 7 result. It exceeds the plan's target-under-5,000 line tripwire and records the required concrete justification: the plan explicitly identifies `src/recovery.ts` as a Stage 8 key file, and the added code is durable exact-evidence validation, restart-safe confirmation, direct repair policy, and summary/state plumbing rather than a new abstraction layer. Keeping the cohesive 595-line recovery policy separate preserves both the roughly-600-line module boundary and a readable 339-line controller. Further compression would primarily collapse validation and interruption boundaries or obscure the direct policy.

The Stage 9 audit found no new localization, first-bad discovery, revert, rollback, salvage, or abandonment orchestration. Stage 9-shaped state fields and lower-level journaled rollback primitives predate this stage and remain uncalled by the Stage 8 controller/recovery path. Stage 8 leaves `firstBadCommit` unset and does not reproduce known-good as a diagnostic anchor.

## Limitations and precise Stage 9 boundary

Stage 8 repairs only the current exact-head failure. It does not localize delayed regressions, reproduce the known-good anchor, bisect a range, discover a first bad commit, automatically revert, perform rescue-ref-plus-reset rollback, abandon a direction, or salvage/cherry-pick work. Infrastructure handling is deliberately narrow: at most one configured prepare attempt and predicate rerun at current HEAD.

The durable Stage 9 entry is a session stopped as `repair-exhausted` with `health.pendingFailure` still present and `recovery.activeFailureId` naming it. The pending record supplies the exact failing check/result, discovered commit, classification/signature, confirmation attempts, repair-attempt count, recovery-cycle count, last repair commit, and last evaluated repair commit. Repository state supplies current HEAD and known-good (which may be null); branch history and rescue refs preserve all Stage 8 work. The Stage 6 thread has been rotated so a later policy does not inherit a nonconverging repair conversation.

Stage 9 should consume that durable boundary to perform its own anchor reproduction, delayed localization, revert, or rescue/reset decisions. It must not infer a shared cause from signature equality, clear the pending failure without complete command health, or discard the visible failed-repair history. None of that Stage 9 behavior is implemented here.
