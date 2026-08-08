# Recovery Loop Stage 9 Handoff

## Implemented

Stage 9 consumes the durable Stage 8 pending-failure boundary inside the existing `recovery-loop run` command. A confirmed product failure is reproduced against its known-good anchor in a detached diagnostic worktree, localized conservatively when the evidence permits, and then handled in the fixed order of forward repair, clean unique-commit revert, and verified rescue-ref-plus-reset rollback. Ordinary goal-directed work cannot resume while localization, a recovery action, or post-action health validation remains pending.

The implementation includes:

- durable per-commit localization bounds, observations, prepare results, diagnostic results, and terminal status on `health.pendingFailure`;
- schema-v1 compatibility defaults for Stage 8 states that lack localization or pending-action fields;
- bounded first-parent localization with a configured default maximum of 64 commits;
- exact known-good and failing-head reproduction before midpoint search;
- two-of-three handling for conflicting product observations and fail-closed non-product boundaries;
- conservative regression windows for unbisectable, oversized, merge/nonlinear, and uncertain ranges;
- the unique localized commit and a bounded first-parent diff in the same Stage 6 recovery-role evidence;
- a durable `recovery.pendingAction` journal for revert/reset planning, exact result commit, validation attempts, environment attempts, abandonment, and thread rotation;
- controller-owned clean revert through the existing Git operation journal;
- verified rescue-ref creation before hard reset of only the autonomous branch/worktree;
- complete exact-head smoke/deep validation after revert and reset;
- delayed abandoned-range recording and thread rotation at the reset boundary;
- deterministic startup adoption/replay at the required diagnostic, revert, rescue, reset, and health-check interruption boundaries;
- Stage 9 localization, action, rollback, and abandonment measurements in the normal summary.

There is still one coding-agent role. The controller remains the sole owner of commits, reverts, rescue refs, resets, branches, worktrees, command health, pending-failure clearing, and known-good promotion. `run` remains the only resume entry point.

## Delayed failures and anchor semantics

For a confirmed product failure at durable head `H`, recovery first reads the exact `knownGoodCommit` `G` retained by Stage 5. If no anchor exists, localization is skipped; forward repair remains available, but exhaustion stops explicitly without inventing a reset target or rescue ref.

When `G` exists, the controller verifies that it is an ancestor of `H` before any historical command. A mismatch is a safety stop, not a localization guess. The controller records an initial proven window `[G, H]`, then reproduces the configured failing command at both endpoints. A configured prepare command runs in the same historical worktree at each candidate before its diagnostic command.

`G` must produce product-pass evidence and `H` must produce product-fail evidence. If `G` still fails after configured prepare, Stage 9 clears no health state and blames no commit. It records `anchor-failed` and stops as infrastructure/environment drift, nondeterminism, or stale health. If `H` no longer fails consistently, localization stops as flaky or at the exact infrastructure/safety boundary observed there.

The known-good anchor remains only a command-driven health fact. Localization cannot promote it, replace it, or treat a signature match as root-cause proof.

## Diagnostic worktree behavior

Historical commands run only in a reusable detached worktree under the recovery runtime root. The diagnostic path is rejected if it overlaps the autonomous worktree, escapes the allowed runtime root, belongs to another repository, or resolves to an attached branch. An existing valid detached worktree is hard-reset and cleaned with ignored files removed before reuse; a partial/stale diagnostic directory inside the allowed root is safely reconstructed.

Moving or creating that worktree persists a `diagnosing` workspace intent first. Each prepare or diagnostic command then uses the ordinary journaled check runner with:

- the autonomous exact HEAD as the durable operation base;
- the historical candidate as the target and result commit;
- argv-only execution, configured timeout, complete logs, result JSON, mutation detection, and classification;
- logs under the session diagnoses directory;
- an explicit restriction that only `diagnostic` and `prepare` categories may target a commit other than the active durable HEAD.

Each persisted observation names its role (`anchor`, `head`, or `midpoint`), exact commit, optional prepare attempt, ordered diagnostic attempts, signatures, classifications, and result paths. Reload validates that every result still names the exact configured argv, check ID, and historical commit. Localization never moves or dirties the autonomous worktree.

## Localization algorithm and uncertainty

After endpoint reproduction, Stage 9 constructs the bounded `G..H` first-parent chain.

1. A direct child needs no midpoint; passing `G` and failing `H` establish `H` as first bad when the range is linear.
2. A range above `limits.maxLocalizationCommits` remains the proven endpoint window.
3. A multi-commit command not marked `bisectable` remains the proven endpoint window.
4. Otherwise, recovery tests the midpoint and narrows the durable lower-pass/upper-fail bounds until adjacent.
5. On a linear range, the adjacent upper commit becomes `firstBadCommit`.
6. If a merge occurs on the first-parent path, the same search may narrow the evidence, but the result remains a window and never becomes a unique first-bad claim.

A first product pass is sufficient when no conflicting observation exists. A product failure is confirmed by matching evidence; conflicting pass/fail observations use up to three attempts. Stable matching failures establish fail, stable passes establish pass, and mixed evidence remains flaky/uncertain under the conservative Stage 8 confirmation posture. Any flaky, infrastructure, safety, source-mutation, timeout, or other non-product midpoint aborts the search immediately. The last already-proven lower/upper bounds remain durable, and `firstBadCommit` is explicitly null.

The same coding role receives `firstBadCommit`, the proven `regressionWindow`, all exact failing evidence, and a bounded diff for the unique first-bad commit. The diff is capped at 24 KiB in the prompt; complete history remains available in Git. No localizer, planner, repair, reviewer, or verifier agent was added.

## Forward repair, revert, and rollback order

Localization enriches Stage 8 recovery evidence; it does not replace forward repair. The deterministic order is:

1. Invoke the existing coding role for at most `maxRepairTurnsPerFailure` controller-owned forward-repair attempts.
2. After exhaustion, rotate the nonconverging thread and attempt a clean revert only when `firstBadCommit` is uniquely known.
3. If unique localization is unavailable, the revert conflicts, or its complete health validation fails, plan rescue-ref-plus-reset rollback to the verified known-good anchor.
4. After reset and a complete health evaluation, record the abandoned direction and rotate before any ordinary work.
5. Preserve the existing same-signature recovery-cycle bound and stop after configured repeated nonconvergence.

If no known-good anchor exists at step 3, recovery stops as `repair-exhausted` with the complete pending failure and failed-repair history intact.

## Clean revert

The revert target is the unique `firstBadCommit`; arbitrary range reverts are not attempted. Before Git mutation, Stage 9 persists a `revert` pending action and the existing `rolling-back` Git intent with the exact old HEAD, target commit, branch, session, and operation identity.

The existing controller identity and trailers own the revert commit. Later commits remain in place, so unrelated later work stays visible. A conflict triggers `git revert --abort` plus bounded tracked cleanup, leaves the autonomous branch clean at the exact pre-revert HEAD, durably marks the conflict before the crash hook, and records one `revert-failed` event. A successful commit records one `revert-created` event tied to the operation ID.

Recovery then runs every configured smoke command and every configured deep command at the exact revert commit. A complete pass clears the pending failure and advances known-good only through the unchanged Stage 5 health controller. Any failing check becomes the accurate current pending failure and triggers the reset fallback; the failed repair/revert history is then retained by the rescue ref.

## Rescue, hard rollback, and abandoned directions

A reset action is persisted before mutation with an incremented durable rollback sequence. Its ref is named:

```text
recovery-loop/rescue/<safe-session-id>-<four-digit-sequence>
```

The ref is created at the exact current autonomous HEAD and resolved again before reset. An existing ref is reusable only if it points to that same old HEAD. The target must be an ancestor and must equal the pending failure's verified known-good anchor. Only the configured autonomous branch and its persistent worktree are reset; the operator checkout and branch are never moved.

After reset, the action records the exact restored commit and enters validation. Complete smoke and deep sets run there even though the commit passed historically. If the restored anchor fails and prepare is configured, Stage 9 permits one active prepare attempt and one complete health replay. A remaining safety, flaky, or infrastructure failure stops accurately with the action and pending health evidence intact.

The old head, target, and rescue ref are added once to `recovery.abandonedRanges`/`recovery.rescueRefs` only after a complete post-reset health evaluation has occurred. `direction-abandoned` is emitted once and the coding thread is rotated before ordinary work can continue. Pre-reset work remains reachable from the named rescue ref; Stage 9 does not cherry-pick or silently salvage parts of an abandoned direction.

## Crash and restart reconciliation

Startup continues to reconcile the single durable operation journal before entering the controller loop. Stage 9 adds these deterministic cases:

- a diagnostic worktree intent is cleared and reconstructed from durable localization bounds;
- an interrupted historical prepare/diagnostic command is treated as `restart-diagnosis`, with recorded results reused only after exact binding validation;
- a revert commit present after a crash is adopted only when it is the one controller-trailed descendant of the recorded old HEAD;
- a conflict marker recorded before interruption finishes the revert as failed without attempting another conflicting mutation;
- an already-verified rescue ref is reused only when it still resolves to the exact old HEAD;
- an already-completed reset is adopted only when the branch is at the exact target, the rescue ref still reaches the old HEAD, and the worktree is clean;
- a reset whose state update completed resumes directly at post-reset health validation;
- interrupted revert/reset smoke or deep validation replays the complete set at the exact action commit.

`recovery.pendingAction` survives every boundary and orders reconciliation ahead of pending-failure processing and ordinary work. Action kind/status, exact old/target/result commits, rescue ref, validation count, environment count, abandonment flag, and thread-rotation flag make re-entry idempotent. Tests assert one revert commit/event, one rollback event, one rescue ref, one abandoned range, and one direction-abandoned event across the injected restart boundaries.

## Post-recovery health and known-good behavior

Revert/reset success is not inferred from Git success. `runRecoveryChecks` remains the authority and always executes complete smoke and deep sets at the unchanged exact action commit. The health controller increments the matching action's durable validation count in the same update that applies the complete deep result, making interrupted-set replay deterministic.

Known-good advances and `health.pendingFailure`/`recovery.activeFailureId` clear only when every smoke and deep command passes and exact-head/worktree safety holds. Agent prose, localization, a revert commit, rescue verification, reset completion, or a partial check set cannot establish health. Once full health passes, the action is cleared, `failure-repaired` records the controller method (`revert` or `reset`), and ordinary work may resume. A later independent command failure enters the same confirmation/localization/recovery path normally.

## Summary and status behavior

The Stage 7 measurement-only summary now adds:

- `localizationsStarted`, `regressionsLocalized`, and `localizationsAborted`;
- `abandonedDirections`;
- durable `rollbackSequence` and the complete current `pendingAction` under `recovery`;
- the existing diagnostic execution, revert, hard-rollback, rescue-ref, pending-failure, and exact-head health measurements.

The full pending failure includes its localization observations and proven bounds, so a stop remains inspectable. `agentCompletionBelief` remains separate from `finalHeadReceivedDeepPass`; no product-success score was added.

`status` is unchanged and strictly read-only. The existing real-runtime test still compares the state file byte-for-byte and the runtime directory entry list before and after status, while also verifying that no lock is taken.

## Deterministic coverage

Two new real-temporary-repository acceptance files add 20 Stage 9 scenarios. They cover:

- a delayed regression introduced by the second of five commits and exact bounded first-parent localization;
- direct-child first-bad detection and prepare at historical candidates;
- a now-failing known-good anchor without false blame;
- flaky, infrastructure, and safety midpoint aborts;
- a merge/nonlinear range reduced to a proven window without false precision;
- localized commit/window/diff evidence reaching the same Stage 6 recovery role;
- forward repair after localization;
- two exhausted repairs followed by clean revert and full health, while preserving later useful work;
- conflicting revert followed by verified rescue/reset, abandoned-range recording, thread rotation, and continued goal work;
- another failure discovered and repaired after successful revert;
- no-anchor exhaustion without a fabricated rescue/reset target;
- interruption during diagnostic worktree and historical command handling;
- crash after a revert commit and durable revert-conflict cleanup;
- crash after rescue verification, after reset, and after rollback state completion;
- complete smoke/deep replay after interrupted revert/reset validation;
- exact old-head reachability from the rescue ref and no operator-branch movement.

The complete suite also retains real-Git coverage for lock contention, status byte-for-byte read-only behavior, authority guards, source mutation, journal reconciliation, command logs/results, and all Stage 1-8 behavior. Every ordinary/CI test uses `ScriptedAgentSdk`; no real model, network, web, credentials, push, merge, deploy, publish, or external-service operation occurs.

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
| `pnpm test` | PASS - 16 files, 173 tests, 623.02 seconds |
| `pnpm test:acceptance` | PASS - 16 files, 173 tests, 649.12 seconds |
| `pnpm build` | PASS |

`git diff --check` also passed. `pnpm test:acceptance` explicitly includes `tests/acceptance`; it and `pnpm test` both exercised the 20 new Stage 9 acceptance tests.

## Architecture and scope audit

- Production contains 14 TypeScript modules, 7,060 physical lines, and 6,988 nonblank lines.
- Stage 8 ended at 12 modules, 5,810 physical lines, and 5,779 nonblank lines; Stage 9 adds 2 modules, 1,250 physical lines, and 1,209 nonblank lines.
- `src/recovery.ts` is 621 physical/598 nonblank lines and remains the direct confirmation/forward-repair policy.
- `src/recovery-fallback.ts` is 605 physical/577 nonblank lines and contains historical localization, exact evidence binding, uncertainty handling, and the small shared Stage 9 context.
- `src/recovery-actions.ts` is 329 physical/318 nonblank lines and contains only deterministic revert/reset/validation/abandonment policy.
- `src/controller.ts` is 368 physical/358 nonblank lines and remains the direct outer loop.
- `src/health-controller.ts` is 593 physical/nonblank lines and remains the sole command-health and known-good authority.
- `src/agent-gateway.ts` remains the sole production SDK import site and the Stage 6 sandbox/network/web/noninteractive settings are byte-for-byte unchanged.
- There is exactly one coding-agent role and no localizer, planner, reviewer, verifier, separate repair agent, provider/plugin abstraction, or generic workflow/state-machine framework.
- Production contains no Stage 10 CLI/help/status-rendering/README/release work, push, merge, deployment, publication, external-service action, receipt/admission layer, verification tier, or product-success score.

The repository remains beyond the plan's target-under-5,000 tripwire. The concrete Stage 9 exception is the durable, restart-safe per-commit localization record plus the revert/reset action journal and exact-head validation policy. Those concerns were split into two cohesive direct-policy modules instead of adding roughly 900 lines to `src/recovery.ts` or creating a reusable workflow framework. The core recovery/localization modules remain below 600 nonblank lines; the action module is about 320. Further compression would primarily erase exact result validation, explicit uncertainty branches, or crash-boundary state that the Stage 9 contract requires.

## Limitations and precise Stage 10 boundary

Localization is deliberately first-parent and bounded. Ranges above the configured maximum, commands not marked bisectable, and merge/nonlinear histories produce only a proven window. Any uncertain midpoint stops localization rather than speculating. Historical prepare is a configured project command, not dependency inference. The reusable diagnostic worktree is retained under recovery runtime state for deterministic restart/reuse. Prompt diff context is truncated at 24 KiB. Abandoned work is preserved by rescue ref but is not selectively salvaged.

Stage 9 does not finish the operator product surface. Stage 10 begins with final CLI/help behavior, status rendering and JSON output, final summary presentation, README/adoption/architecture documentation, release acceptance, production-size review, and the explicitly opt-in disposable live-agent canary. Stage 10 must preserve the existing separation between current HEAD and known-good, agent completion belief and external correctness, temporary broken branch history and verified health, and the prohibition on automatic push/merge. None of that Stage 10 work is implemented here.
