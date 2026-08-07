# Recovery Loop Stage 5 Handoff

## Implemented

Stage 5 adds a small direct health and scheduling controller in `src/controller.ts`. It composes the existing Stage 1–4 boundaries rather than introducing an autonomous loop:

- Every nonempty work unit goes through `journaledCheckpoint` before its smoke set starts.
- Every smoke and deep set goes through `runJournaledCommandSet`.
- Smoke runs after each new checkpoint, and a smoke-only pass records the exact commit and permits continued work when no deep reason is due.
- Deep scheduling uses persisted cadence state, explicit caller-supplied time, configured path prefixes, Git change statistics, goal-completion boundaries, and recovery boundaries.
- Baseline checking always observes both smoke and deep sets. A full pass establishes the baseline anchor; any incomplete or failing set leaves `knownGoodCommit` null.
- Failed observations create an unconfirmed `pendingFailure` tied to the checked commit, command result path, signature, and previous anchor. They also set `recovery.activeFailureId`.
- Full exact-head health passes clear an outstanding observed failure, reset cadence, and advance the check-relative known-good anchor.
- Interrupted smoke and deep command sets can be resumed through an explicit Stage 5 entry point after startup reconciliation; the entire relevant set runs again with new log sequence numbers.
- Two narrow read-only Git queries report changed paths between commits and recover a checkpoint's first parent after restart.
- Command-set interruption hooks permit deterministic crash injection after any completed command while leaving the journaled phase intact.

No `init`, `run`, or `check` CLI orchestration was added. `status` remains the existing read-only implementation.

## Scheduling decisions

Deep reasons are persisted as small diagnostic strings. The scheduler preserves any explicit `cadence.deepRequired` state and adds configured reasons in deterministic order:

1. an already-persisted explicit reason;
2. smoke-passing checkpoint cadence;
3. elapsed time since the last completed deep execution;
4. a configured high-risk path;
5. changed-file size;
6. changed-line size;
7. goal completion;
8. a configured post-recovery boundary.

The exact rules are:

- Cadence becomes due when the persisted smoke-passing count is greater than or equal to `everyCheckpoints`.
- Elapsed time becomes due at or after `lastDeepRunAt + maxMinutes`.
- A path trigger matches the configured file exactly or a directory prefix. Near-miss filenames such as `package.json.backup` do not match `package.json`.
- In accordance with the authoritative plan's “more than” wording, file and added-plus-deleted line triggers require a value strictly greater than their configured threshold.
- Only a newly recorded smoke pass for a non-baseline checkpoint increments cadence. Reloads and reruns cannot double-count the same commit.
- A deep pass resets the smoke-passing count and clears all deep reasons. A failed, flaky, infrastructure, or safety result cannot reset or advance the anchor.
- The caller supplies scheduling time explicitly. Stage 5 does not create a timer or autonomous loop; Stage 7 will invoke the scheduler at ordinary controller boundaries.

Risk reasons are persisted before smoke execution. If a crash occurs after a checkpoint but before that update, `runScheduledChecks` derives paths and statistics from the committed first-parent diff before rerunning smoke.

## Promotion and failure decisions

`knownGoodCommit` advances only when all of these hold for one exact commit:

- the complete configured smoke set passed at that commit;
- the complete configured deep set passed at that commit;
- every result remained bound to that commit and reported no tracked-source mutation;
- the autonomous branch and `HEAD` still resolve to that commit;
- Git reports the worktree clean after the checks.

A pass records only this configured check-relative observation. It is not admission, independent review, or a general correctness claim.

Any non-pass classification, including a future flaky result supplied by the existing confirmation boundary, withholds promotion. Stage 5 records first failures as observations with `confirmed: false`; it does not decide reproducibility, root cause, repair, revert, or rollback. A deep failure at a later checkpoint therefore preserves the previous known-good anchor and records the previous-anchor-to-head regression window without localizing it.

## Tests

New deterministic coverage consists of five scheduler unit tests and sixteen real-temporary-repository integration tests. It covers:

- healthy and unhealthy baselines;
- smoke pass after checkpoint;
- smoke failure with the checkpoint retained in branch history;
- exact checkpoint cadence;
- exact elapsed-time boundary;
- high-risk path prefixes;
- changed-file and changed-line thresholds;
- goal-completion and persisted recovery-boundary reasons;
- later exact-head deep promotion;
- deep failure preserving the previous anchor;
- tracked mutation cleanup withholding promotion;
- state reload preserving cadence;
- complete smoke-set replay after interruption;
- complete deep-set replay after interruption.

Validation on Windows with Node 25.9.0, pnpm 10.33.0, and Git 2.54.0:

```text
pnpm typecheck
PASS

pnpm lint
PASS

pnpm test
PASS — 10 files, 103 tests

pnpm test:acceptance
PASS — 10 files, 103 tests

pnpm build
PASS
```

## Scope and size audit

The production tree now contains 10 TypeScript modules, 4,639 physical lines, and 4,333 nonblank lines. `src/controller.ts` is 571 physical lines and 533 nonblank lines. The total remains below the roughly 5,000-line target and the module count remains below the roughly 11-module tripwire.

The pre-existing handwritten boundary modules remain slightly above the approximate 600-line tripwire; the two read-only Git queries add 12 lines to `git-repository.ts`. Splitting that cohesive Git boundary would add another production module without reducing its authority or complexity.

The Stage 5 production diff contains no SDK, coding-agent gateway, prompt or thread handling, autonomous `run` loop, forward repair, confirmation policy, regression localization, revert/rollback policy, benchmark infrastructure, extra role, evidence receipt, admission gate, verification tier, or generic workflow/state-machine abstraction.

## Limitations

- Stage 5 functions are controller building blocks. They assume the future mutating caller owns the controller lock and has performed startup reconciliation before resuming an interrupted set.
- `init`, `run`, and `check` remain explicit deferred CLI handlers. Baseline and explicit health behavior are available through the direct Stage 5 API, not yet through the operator CLI.
- Pending failures are deliberately unconfirmed observations. The existing Stage 4 two-of-three primitive is not orchestrated here.
- No prepare-command policy, environment repair, forward repair, localization, revert, or rollback decision is made by this module.
- Scheduling does not wake itself on elapsed time. The future normal controller loop must call `runScheduledChecks` with its current deterministic time.
- Check-relative known-good state does not certify that tests are sufficient or that the product goal is correct.

## Stage 6 next

Stage 6 should add only the single coding-agent gateway described in `docs/IMPLEMENTATION_PLAN.md`:

- isolate the pinned SDK import in `src/agent-gateway.ts`;
- implement the small four-outcome response contract, work/recovery prompt construction, event streaming, timeout, usage, and thread rotation/resume behavior;
- provide a deterministic scripted gateway for tests;
- leave checkpoint ownership, scheduling, health, and promotion in the existing journaled Stage 5 APIs;
- do not build the normal autonomous controller loop until Stage 7 and do not begin recovery policy or localization work early.
