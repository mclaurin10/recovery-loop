# Recovery Loop v0.1 — Implementation-Ready Design and Build Plan

## Reference inspection and design implications

The Milestone Loop Template is fundamentally an **admission-control system**. A read-only Planner creates a structured milestone; a Worker operates in an isolated clone; machine verification binds results to an exact candidate identity; an independent Reviewer judges the diff; and only then may the controller fast-forward the target branch. Its four verification tiers, command-owned receipts, protected authority set, and fail-closed aggregate are all organized around proving that a candidate has earned integration.

That philosophy creates extensive machinery: multiple agent roles and schemas; milestone proposal policy; protected-file baselines; candidate identity fences; verification manifests; evidence receipts; controller leases and compare-and-swap state; reconciliation of externally advanced history; artifact retention approval; and a broad CLI. The repository contract requires adopters to configure or supply most of those systems before the loop can make trusted progress.

Those systems are coherent for “proof before integration,” but they should not be weakened and copied into the new project. The greenfield sibling should carry forward only lower-level lessons that remain valuable under a recovery-first philosophy:

| Reference lesson                                                                   | Recovery Loop treatment                                                                  |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Keep autonomous work away from the operator’s normal checkout                      | Retain through one dedicated persistent Git worktree                                     |
| Make every meaningful edit recoverable                                             | Strengthen through commit-before-check checkpointing                                     |
| Persist enough state to resume after interruption                                  | Retain, but use one small state file rather than milestone history schemas               |
| Keep the model/provider boundary isolated                                          | Retain through one thin agent gateway, conceptually similar to the reference SDK adapter |
| Use conventional Git as the primary recovery substrate                             | Retain; branch, commits, reverts, reset, and rescue refs are authoritative               |
| Run commands with timeouts and captured output                                     | Retain without evidence receipts                                                         |
| Require Planner/Worker/Reviewer separation                                         | Reject                                                                                   |
| Require verification before checkpoint or integration                              | Reverse: checkpoint first, verify afterward                                              |
| Treat every commit as a completion claim                                           | Reject; commits are provisional recovery points                                          |
| Protect a large authority and verifier surface inside the target repository        | Avoid by installing the controller outside the target worktree                           |
| Use verification manifests, invariant registries, tier schemas, and receipt hashes | Reject for v0.1                                                                          |
| Maintain a separate reconciliation subsystem                                       | Reject; startup reconciliation is part of the ordinary controller                        |
| Maintain an approval-bound artifact-retention subsystem                            | Reject; keep small local logs and never auto-delete rescue refs                          |
| Internally judge final product success                                             | Reject; expose candidate completion and metrics to an external evaluator                 |

The resulting project should not contain classes or concepts named `Milestone`, `Planner`, `Reviewer`, `Admission`, `VerificationTier`, `Receipt`, or `ReconciliationController`. Introducing those concepts would be a warning that implementation is drifting back toward the reference philosophy.

---

# 1. Product definition

## 1.1 What the system is

**Recovery Loop** is a local autonomous software-development controller that gives one capable coding agent broad discretion to make progress on a dedicated Git branch.

Its core operating rule is:

> **Create a recoverable checkpoint, observe what happened, and repair or reverse failures when they become visible.**

A normal change is not required to prove itself before becoming part of the loop’s branch history. Instead:

1. The agent selects and implements one useful unit of work.
2. The controller commits it immediately as a provisional checkpoint.
3. Cheap checks evaluate that exact commit.
4. If no clear failure is observed, work continues.
5. Deeper checks run periodically and at meaningful risk boundaries.
6. A later-discovered regression causes diagnosis, forward repair, revert, or rollback.
7. The branch continues from a recoverable state.

The loop branch is the product of the system. It is not automatically merged into the operator’s original branch and is not automatically pushed.

## 1.2 Problem being solved

Current autonomous-development controllers commonly spend substantial compute and wall-clock time trying to prevent every questionable increment from entering canonical history. That can reduce velocity through duplicated reasoning, repeated repository inspection, broad test execution, role handoffs, structured evidence generation, and conservative state transitions.

Recovery Loop tests the opposite proposition:

> A coding agent may achieve more useful progress when ordinary mistakes are permitted but made cheap to preserve, detect, localize, and undo.

The optimization target is:

> **Useful verified-or-recoverable progress per unit of time and model compute.**

## 1.3 Intended users and use case

The initial release is for a technically capable developer or researcher who:

* has an existing local Git repository;
* can define a product goal and local check commands;
* wants one coding agent to work autonomously for multiple checkpoints;
* accepts that the autonomous branch may temporarily contain known-bad commits;
* wants ordinary coding regressions handled without routine human approval;
* wants the operator’s normal branch and checkout left untouched;
* may later compare this system with a prevention-heavy autonomous loop under a common external evaluator.

## 1.4 Governing philosophy

The following are design rules, not slogans:

1. **A checkpoint is a recovery point, not a correctness claim.**
2. **Run checks against committed states rather than making checks a prerequisite for preserving work.**
3. **A passing smoke check is enough to continue unless deeper verification is due.**
4. **A failing check changes the next activity from development to recovery; it does not invalidate the existence of the checkpoint.**
5. **Keep mistakes visible in history when forward repair is economical.**
6. **Prefer a normal revert over history rewriting when it preserves useful later work.**
7. **Before destructive rollback, preserve the abandoned head under a rescue ref.**
8. **Stop only when continuing would make recovery materially harder, destroy something outside source control, or leave canonical state ambiguous.**
9. **The controller owns Git history operations. The coding agent owns source edits and technical decisions.**
10. **Conversation history is optional; Git, tracked authority, runtime state, and event history are sufficient to resume.**

## 1.5 Explicit non-goals

Recovery Loop v0.1 will not implement:

* automatic merging into the operator’s branch;
* pushing, publishing, deployment, package release, or infrastructure changes;
* destructive external-service operations;
* multiple coding, planning, or review agents;
* independent semantic review of every checkpoint;
* cryptographic evidence receipts;
* immutable acceptance locks;
* hidden validation;
* production-readiness certification;
* a generic workflow engine;
* distributed or concurrent autonomous workers;
* multi-repository coordination;
* automatic benchmark judging;
* perfect secret detection;
* protection against a malicious host or malicious project-owned check command;
* automatic cleanup of rescue branches;
* arbitrary history surgery or automatic salvage of every abandoned commit;
* Windows support in v0.1 unless it falls out cheaply from the implementation.

## 1.6 Successful initial release

Recovery Loop v0.1 is successful when it can demonstrably:

1. Initialize against a local Git repository without changing the operator’s current branch.
2. Create and resume a dedicated autonomous worktree and branch.
3. Let one coding agent inspect the project and choose its next useful change.
4. Commit each nonempty agent turn before project checks run.
5. Run cheap checks after every checkpoint.
6. Continue after smoke success without requiring broader proof or independent review.
7. Run deeper checks according to checkpoint cadence, elapsed time, change risk, recovery boundaries, and completion claims.
8. Detect a regression introduced several commits earlier.
9. Confirm that the failure is reproducible rather than obviously flaky or infrastructural.
10. Localize the regression to a commit when the configured failing command is bisectable.
11. Attempt forward repair autonomously.
12. Fall back to a clean revert or rescue-ref-plus-reset when repair does not converge.
13. Recover from interruption during agent work, checkpoint creation, checking, and rollback.
14. Resume from repository and runtime state without conversation history.
15. Stop cleanly at narrow destructive, canonicality, or repeated-failure boundaries.
16. Produce a concise summary suitable for later external benchmarking.

A release should not be called complete merely because the happy path works.

---

# 2. Architectural design

## 2.1 Major components

Recovery Loop should have six substantive components.

### A. Controller

The controller owns the top-level loop:

* startup reconciliation;
* budget accounting;
* agent invocation;
* checkpoint creation;
* check scheduling;
* mode switching between development and recovery;
* terminal decisions;
* durable phase updates.

It is deliberately not a generic state-machine framework. A direct, readable control loop is preferred.

### B. Agent gateway

One adapter invokes the configured coding model through the selected SDK.

It owns:

* starting or resuming one coding-agent thread;
* applying sandbox and network policy;
* streaming model events to a local log;
* timeout handling;
* usage collection when the SDK exposes it;
* validating the agent’s small structured final response;
* falling back to a new thread when thread resumption fails.

Nothing else imports the SDK.

### C. Git workspace manager

This component owns:

* repository identity;
* the dedicated branch and worktree;
* checkpoint commits;
* normalization if the agent made its own commits;
* diff and changed-path inspection;
* known-good ancestry checks;
* diagnostic worktrees;
* clean reverts;
* rescue refs;
* hard rollback;
* startup reconciliation between state and actual Git history.

Git is the authoritative record of code state.

### D. Check runner and scheduler

The runner executes configured commands without a shell, using bounded timeouts and captured output.

The scheduler decides when to run:

* smoke checks;
* deep checks;
* a failing diagnostic predicate;
* an optional environment preparation command.

It does not decide whether a candidate may “integrate.” Check results are observations about already-checkpointed commits.

### E. Recovery engine

The recovery engine owns:

* failure confirmation;
* product/infrastructure/flaky classification;
* repeated-failure signatures;
* delayed-regression localization;
* recovery-agent prompts;
* repair-attempt limits;
* revert;
* rescue and hard rollback;
* recovery-cycle limits.

It should be a small deterministic policy module, not another autonomous agent.

### F. State and event store

This component owns:

* one atomically replaced `state.json`;
* one append-only diagnostic `events.jsonl`;
* per-agent and per-check logs;
* a simple single-controller lock;
* final session summaries.

State persistence is semantic because it is required for recovery. Rich telemetry is not.

## 2.2 Deliberately absent components

There is no:

* separate Planner;
* milestone proposal;
* policy adjudication pass;
* independent Reviewer;
* candidate admission gate;
* integration operation;
* verification manifest;
* receipt validator;
* artifact inventory;
* retention planner;
* separate reconciliation workflow;
* shadow verification selector;
* internal final judge.

The coding agent plans while working. The controller observes and recovers.

## 2.3 Normal lifecycle

```text
START OR RESUME
       |
       v
Reconcile state, branch, worktree, and interrupted operation
       |
       +---- unrecoverable ambiguity or destructive risk? ----> STOP
       |
       v
Pending confirmed failure?
       |
   yes |                                     no
       v                                      v
Recovery engine                        Invoke coding agent
       |                                      |
       |                               inspect / choose / edit
       |                                      |
       +---------------------------+----------+
                                   v
                          Create checkpoint commit
                                   |
                                   v
                              Smoke checks
                          /                     \
                    confirmed failure          no observed failure
                          |                     |
                          v                     v
                      recovery          Is deep check due?
                                           /       \
                                         yes        no
                                          |          |
                                          v          |
                                      Deep checks    |
                                     /         \     |
                                  failure       pass |
                                     |           |   |
                                     v           v   |
                                  recovery   advance  |
                                             known-  |
                                             good    |
                                               \     /
                                                v
                                             continue
```

The important inversion is:

> **The checkpoint is created before smoke verification.**

A failing smoke check therefore identifies a known-bad checkpoint rather than preventing the checkpoint from existing.

## 2.4 Startup flow

Every `run` begins with these steps:

1. Locate the repository and Git common directory.
2. Load and validate tracked configuration.
3. Acquire the single-controller lock.
4. Load `state.json`.
5. Validate that the configured branch, worktree, baseline, and Git common directory match state.
6. Inspect the actual autonomous branch ref and worktree.
7. Reconcile any interrupted operation according to the persisted phase.
8. Kill or reject any same-host stale command process that survived its controller.
9. Recreate the persistent worktree if its directory disappeared but the branch remains valid.
10. Remove or recreate an abandoned diagnostic worktree.
11. Validate that the goal and configuration files match the autonomous branch and have not been changed by a pending agent edit.
12. Resume pending recovery, otherwise begin ordinary work.

Startup never assumes that a log statement proves Git state. It inspects Git directly.

## 2.5 Work selection and implementation flow

One agent turn performs both planning and implementation.

The agent receives:

* the product goal;
* its authority and prohibitions;
* current branch and head;
* last deep-pass commit;
* recent commit summaries;
* current check health;
* recent abandoned or reverted direction, if relevant;
* the pending failure and localization evidence when in recovery;
* remaining time and turn budget.

It is instructed to:

1. inspect the repository;
2. identify one coherent, useful next improvement;
3. implement it;
4. add or update tests when useful;
5. run whatever local commands aid its reasoning;
6. stop after one checkpoint-sized outcome;
7. return a tiny structured summary.

There is no pre-turn proposal schema and no controller approval of the selected work.

## 2.6 Checkpoint flow

After the agent turn:

1. Record the expected pre-turn branch head.
2. Inspect actual `HEAD`, index, and working tree.
3. If the agent created descendant commits despite its contract:

   * create a rescue ref at the agent-created head;
   * soft-reset to the expected pre-turn head;
   * collapse the resulting changes into one controller-owned checkpoint.
4. If the agent rewrote the branch to a non-descendant:

   * preserve reachable heads where possible;
   * stop for canonical-state ambiguity.
5. Run narrow pre-commit safety guards.
6. If there are no changes:

   * do not create an empty commit;
   * process the agent’s `goal_complete`, `no_change`, or `blocked` outcome.
7. Otherwise stage all allowed changes and create one checkpoint commit.
8. Persist the new head.
9. Run smoke checks against that exact commit.
10. Mark the commit as smoke-passing or known-bad in state and events.

A checkpoint commit message uses:

```text
recovery-loop: <concise agent summary>

Recovery-Loop-Session: <session-id>
Recovery-Loop-Unit: <unit-id>
Recovery-Loop-Kind: work|repair|interrupted|revert
```

It must not include words such as `verified`, `approved`, or `complete` unless the text merely describes product behavior.

## 2.7 Deep-verification flow

A deep check is due when any of these is true:

* five smoke-passing checkpoints have accumulated since the last deep pass;
* 30 minutes have elapsed since the last deep execution;
* a configured high-risk path prefix changed;
* more than 20 files changed in one checkpoint;
* more than 1,000 added plus deleted lines changed in one checkpoint;
* a prior confirmed failure has just been repaired or reverted;
* the agent reports `goal_complete`;
* the operator invokes `recovery-loop check --deep`;
* the loop is about to stop normally and sufficient check budget remains.

These defaults are configurable.

A deep pass advances the **known-good anchor** to the exact checked commit. This means only:

> All configured smoke and deep commands passed at that commit.

It is not a universal correctness claim.

A deep failure starts recovery even if several later smoke-passing commits have accumulated since the previous known-good anchor.

## 2.8 Regression-discovery and diagnosis flow

For a newly failing command:

1. Re-run once.
2. If the two results conflict, run a third time.
3. Use two-of-three agreement:

   * two matching failures: confirmed failure;
   * two passes: flaky observation;
   * infrastructure errors without stable product output: infrastructure failure.
4. For a delayed deep failure:

   * run the same command at the known-good anchor in a diagnostic worktree;
   * if the anchor also fails, classify the problem as environmental, flaky, or a stale known-good assumption;
   * if the anchor passes and current head fails, perform limited binary-search localization.
5. Store the confirmed failure signature, relevant logs, known-good commit, current head, and localized first-bad commit or regression window.
6. Invoke the same coding-agent role in recovery mode.

## 2.9 Repair and rollback flow

The deterministic recovery order is:

1. **Forward repair first.**

   * Give the agent the failing command, bounded output, relevant diff, and localized commit.
   * Permit up to two repair turns for the same signature.
   * Each repair turn becomes another visible checkpoint.
2. **Clean revert second.**

   * If a unique first-bad commit is known, attempt `git revert --no-edit`.
   * Only accept a conflict-free revert.
   * Run smoke and all deep checks afterward.
3. **Rescue and hard rollback third.**

   * Create `recovery-loop/rescue/<session>-<sequence>` at the current head.
   * Atomically record the rescue ref and rollback target in state.
   * Reset the autonomous branch and worktree to the known-good anchor.
   * Re-run smoke and deep checks at the restored anchor.
4. **Abandon direction.**

   * Record the abandoned range and rescue ref.
   * Start a fresh agent thread.
   * Continue from the goal without automatically repeating the failed implementation strategy.
5. **Stop after repeated nonconvergence.**

   * Three recovery cycles for the same normalized failure signature are the default maximum.

Forward repair leaves the mistake and fix visible in history. Revert leaves the mistake and reversal visible. Only the last fallback rewrites the dedicated autonomous branch, and it preserves the former head first.

## 2.10 Interruption flow

The persisted phase is a crash journal, not an admission state machine.

| Persisted phase  | Startup behavior                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `idle`           | Validate clean expected worktree and continue                                                                                            |
| `agent-running`  | If dirty, checkpoint as `interrupted`; if unchanged, launch a fresh or resumed turn; if agent created descendant commits, normalize them |
| `checkpointing`  | Compare expected base and actual head; adopt an already-created commit or finish committing the dirty tree                               |
| `smoke-checking` | Re-run the full smoke set                                                                                                                |
| `deep-checking`  | Re-run the full deep set                                                                                                                 |
| `diagnosing`     | Discard and recreate the diagnostic worktree, then restart localization                                                                  |
| `repairing`      | Inspect whether a repair checkpoint exists; otherwise re-invoke recovery mode                                                            |
| `rolling-back`   | Verify the rescue ref exists, then complete or validate the recorded revert/reset                                                        |
| `stopped`        | Remain stopped until a new `run` is intentionally started and the stop reason permits it                                                 |

A hard-killed agent that left useful dirty work should therefore lose neither the edits nor the opportunity to evaluate them.

## 2.11 Terminal and escalation conditions

The loop stops rather than continuing when:

* the Git repository or expected branch cannot be established;
* the autonomous branch has moved to a non-descendant state not explained by the current operation;
* the operator and controller can no longer determine which ref is canonical;
* controller state is corrupt or belongs to a different repository;
* goal or controller configuration is persistently being altered by the agent;
* high-confidence credentials or a private key remain in the proposed checkpoint after one correction attempt;
* a changed symlink or gitlink creates an unsafe filesystem boundary;
* disk or filesystem failure prevents durable state or checkpoint creation;
* the configured check or prepare command demonstrably performs an external destructive operation;
* required credentials or an unavailable external service are genuinely necessary;
* the goal contains mutually contradictory requirements;
* repair, revert, and rollback cannot restore a usable state;
* the known-good anchor no longer reproduces its checks and environment recovery does not converge;
* the same failure signature exhausts its recovery-cycle limit;
* the agent returns no useful change twice in succession without claiming completion;
* a hard resource budget is exhausted.

Ordinary test failures, compilation failures, incomplete implementations, uncertain design choices, and later-discovered regressions are not escalation conditions.

---

# 3. Git and recovery semantics

## 3.1 Repository and worktree layout

Recovery Loop is installed as an external CLI. It is not copied into the adopting repository.

For a repository at:

```text
/work/project
```

the default autonomous resources are:

```text
/work/.project-recovery-loop/worktree/    persistent linked worktree
/work/project/.git/recovery-loop/         runtime state and logs
```

The exact worktree path may be configured at initialization.

The tracked adopting-project contract is:

```text
RECOVERY_GOAL.md
.recovery-loop/config.json
```

Runtime state is stored under the Git common directory, not in the worktree, so an agent reset cannot remove it and it is not accidentally committed.

## 3.2 Initialization

`recovery-loop init` performs the following:

1. Verify that the current directory is a non-bare Git repository.
2. Require the operator’s current checkout to be clean for initialization only.
3. Require `RECOVERY_GOAL.md` and `.recovery-loop/config.json` to be tracked in the requested baseline commit.
4. Resolve the baseline commit, defaulting to current `HEAD`.
5. Create branch `recovery-loop/work` at the baseline.
6. Add the persistent linked worktree on that branch.
7. Create `.git/recovery-loop/`.
8. Initialize state atomically.
9. Run the optional prepare command.
10. Run smoke and deep checks at the baseline.
11. If all pass, set `knownGoodCommit` to the baseline.
12. If they fail, leave `knownGoodCommit` null and start the first future `run` in recovery mode.

An unhealthy baseline does not prevent initialization. It merely means that no verified rollback anchor yet exists.

If the authority files are missing, `init` writes templates into the operator’s checkout and exits without creating a branch. The operator fills and commits them, then runs `init` again.

## 3.3 Branch rules

* The autonomous branch defaults to `recovery-loop/work`.
* Only the controller may create commits, revert, reset, merge, rebase, tag, or manipulate worktrees on this branch.
* The coding agent may inspect Git but must not perform history operations.
* The controller never modifies the baseline branch.
* The controller never pushes.
* The autonomous branch is expected to remain linear in v0.1.
* Unexpected merge commits cause localization to degrade to a commit range; unexplained non-descendant movement stops the loop.
* The branch may temporarily be red.
* A current red head and an older known-good anchor are both legitimate states.

## 3.4 Checkpoint semantics

Every nonempty work or repair turn results in one controller-owned commit before project checks run.

Checkpoint states are diagnostic metadata:

| Label        | Meaning                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| `unchecked`  | Commit exists; checks have not completed                                          |
| `smoke-pass` | All configured smoke commands passed                                              |
| `known-bad`  | A configured command has a confirmed failure at or after this commit              |
| `deep-pass`  | Smoke and all deep commands passed; commit is the current known-good anchor       |
| `abandoned`  | Commit remains reachable from a rescue ref but was removed from the active branch |

These labels live in state and events. They do not require Git tags or notes in v0.1.

## 3.5 Known-good semantics

`knownGoodCommit` advances only after:

* the worktree is clean;
* branch head equals the checked commit;
* all smoke checks pass;
* all deep checks pass;
* the checks do not modify tracked files.

A known-good commit must be an ancestor of current branch head.

If it is not, the controller stops because its recovery anchor is no longer coherent.

## 3.6 Revert semantics

A specific revert is preferred when:

* a unique first-bad commit was localized;
* the current branch still contains later potentially useful commits;
* `git revert --no-edit <firstBad>` applies without conflict.

The revert commit is a normal checkpoint with kind `revert`.

No agent is used to resolve revert conflicts in v0.1. A conflict causes:

1. `git revert --abort`;
2. recording the failed revert;
3. escalation to rescue-and-reset.

## 3.7 Hard rollback semantics

Before any destructive reset:

1. Persist phase `rolling-back`.
2. Persist old head, target anchor, and intended rescue-ref name.
3. Create the rescue ref at old head.
4. Verify the rescue ref resolves to old head.
5. Reset the autonomous branch and worktree to the anchor.
6. Verify branch, index, and worktree state.
7. Run smoke and deep checks.
8. Record the abandoned range and rescue ref.
9. Return to `idle`.

The controller must never reset first and attempt to create the rescue ref afterward.

Rescue refs are ordinary branches:

```text
recovery-loop/rescue/<session-id>-<sequence>
```

They are never automatically deleted in v0.1.

## 3.8 Dirty working tree semantics

Dirty state is not automatically considered corruption.

* Dirty after an interrupted agent turn: checkpoint it as `interrupted`.
* Dirty after a controller check: the check violated the repository contract; save a patch for diagnosis, reset to the pre-check commit, and classify as infrastructure/configuration failure.
* Dirty while state says `idle`: treat as unexplained worktree mutation, create a rescue patch and checkpoint only if ancestry and safety guards remain coherent; otherwise stop.
* Dirty goal or config files: do not checkpoint. Re-prompt the agent once to restore them.
* Dirty state with unresolved merge, revert, cherry-pick, or rebase metadata: reconcile only if the persisted phase explains it; otherwise stop.

## 3.9 Agent-created commits

If the agent disregards its contract but creates only descendant commits:

1. Create a rescue ref at the agent head.
2. Soft-reset the branch to the recorded turn base.
3. Stage the combined resulting changes.
4. Create one controller checkpoint.
5. Record the protocol violation.
6. Rotate the agent thread after the checkpoint.

This preserves useful work without allowing agent-created history to become the controller’s unit model.

---

# 4. Verification strategy

## 4.1 Check categories

Recovery Loop has three check categories and one diagnostic use of a check.

| Category             | Purpose                                                                    | Timing                              | Can it prevent a checkpoint?                                   |
| -------------------- | -------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| Guard                | Prevent damage that is difficult to reverse or corrupts authority/recovery | Before commit                       | Yes                                                            |
| Smoke                | Detect obvious breakage cheaply                                            | After every checkpoint              | No; failure makes the checkpoint known-bad and starts recovery |
| Deep                 | Detect broader or delayed regressions                                      | Periodically and at risk boundaries | No; failure starts delayed-regression recovery                 |
| Diagnostic predicate | Confirm or localize one observed failure                                   | During recovery                     | Not applicable                                                 |

These must not be generalized into configurable “verification tiers.”

## 4.2 Guard checks

The built-in pre-commit guard verifies:

* branch and worktree identity;
* expected ancestry;
* no unexplained in-progress Git operation;
* goal and loop configuration unchanged;
* no changed symlink or gitlink;
* no path outside the worktree;
* no tracked `.git` or runtime-state content;
* no high-confidence private-key block;
* no high-confidence known credential token format;
* commit can be written durably.

A guard failure invokes one correction turn when ordinary edits can remove the problem. Persistent guard failure stops the loop.

Guard checks are narrow because they protect recovery itself or prevent damage outside ordinary source control.

## 4.3 Smoke checks

Adopting projects must configure at least one smoke command.

Good smoke commands normally include:

* compilation or type checking;
* a focused unit-test command;
* syntax or import validation;
* a fast build smoke test.

Smoke commands run sequentially for deterministic logs and simple resource control.

A smoke pass is sufficient to continue ordinary development when no deep trigger is due.

No receipt or independently hashed artifact is required. Exit status, bounded output, elapsed time, and unchanged Git state are enough.

## 4.4 Deep checks

Adopting projects must configure at least one deep command.

Deep checks may include:

* full test suites;
* integration tests;
* broader builds;
* static analysis;
* deterministic simulation or replay checks;
* browser or end-to-end tests;
* product-specific validation.

A deep check is a broader observation, not an integration gate.

A deep failure after earlier checkpoints is an expected operating case.

## 4.5 Failures that block checkpoint creation

Only these prevent a checkpoint:

* authority or runtime configuration modification;
* high-confidence credential/private-key content;
* changed symlink or gitlink;
* canonical branch ambiguity;
* unsafe Git operation state;
* path escape;
* inability to persist state or commit;
* clearly destructive external side effect.

The following do **not** prevent a checkpoint:

* failing tests;
* compilation errors;
* lint errors;
* an incomplete feature;
* an uncertain implementation choice;
* missing noncritical coverage;
* a newly discovered regression;
* a deep check that has not yet run.

## 4.6 Failure confirmation

For a nonzero command result:

```text
first run fails
    |
    v
second run
  |       |
same     different
  |         |
confirm   third run
             |
         two-of-three
```

Normalization for repeated signatures should include:

* check ID;
* result class;
* exit code or signal;
* normalized bounded stderr tail;
* normalized bounded stdout tail.

Strip timestamps, temporary paths, process IDs, and repeated whitespace before hashing.

Do not use the signature as proof that root causes are identical. It is a loop-detection aid.

## 4.7 Infrastructure and flaky outcomes

Classify as infrastructure when:

* executable cannot start;
* required file or dependency is missing;
* output cannot be recorded;
* timeout occurs without stable product-failure output;
* process termination fails;
* check alters tracked source unexpectedly;
* prepare command fails.

Retry infrastructure once.

If the result remains inconsistent, mark the check flaky and:

* do not promote a new known-good anchor;
* keep the last known-good anchor;
* continue only when two of three executions pass;
* schedule another deep run after at most one additional checkpoint;
* stop after three flaky episodes for the same check in one session.

## 4.8 Later regression detection

When a deep failure appears at head `H`, with known-good anchor `G`:

1. Confirm failure at `H`.
2. Verify `G` is an ancestor of `H`.
3. Run the same check at `G` in the diagnostic worktree.
4. If `G` passes and `H` fails, localize within `G..H`.
5. If `G` also fails:

   * do not blame a commit automatically;
   * classify environment drift, nondeterminism, or an invalid old health assumption;
   * enter environment-recovery mode.
6. After any repair or revert, run all smoke and deep checks before advancing the known-good anchor.

## 4.9 Limited binary-search localization

V0.1 includes a deliberately bounded localizer because recovery from delayed failures is central to the product.

Requirements:

* only linear first-parent ranges;
* one configured failing check as predicate;
* known passing lower bound;
* known failing upper bound;
* reusable detached diagnostic worktree;
* optional prepare command at each candidate when configured dependency-trigger paths differ;
* product pass/fail result required at every midpoint;
* abort localization on flaky or infrastructure results;
* maximum 64 commits in the search range by default.

Algorithm:

```text
lower = known-good commit, confirmed pass
upper = current head, confirmed fail

while upper is not the child of lower:
    midpoint = middle commit in first-parent range
    checkout midpoint in diagnostic worktree
    prepare if required
    run failing check with confirmation

    pass -> lower = midpoint
    fail -> upper = midpoint
    uncertain -> abort localization

firstBad = upper
```

If localization aborts, the recovery agent receives the smallest proven regression window instead of a fabricated first-bad commit.

---

# 5. Persistent state

## 5.1 Storage locations

```text
.git/recovery-loop/
├── state.json
├── controller.lock
├── events.jsonl
├── runs/
│   └── <session-id>/
│       ├── agent/
│       ├── checks/
│       ├── diagnoses/
│       └── summary.json
└── diagnostic-worktree/     optional, disposable
```

The persistent autonomous worktree is outside `.git`; only runtime metadata and the diagnostic worktree are under the runtime root.

## 5.2 Minimal state schema

The initial state should resemble:

```json
{
  "schemaVersion": 1,
  "repository": {
    "gitCommonDir": "/work/project/.git",
    "baselineCommit": "40-hex",
    "branch": "recovery-loop/work",
    "worktreePath": "/work/.project-recovery-loop/worktree",
    "expectedHead": "40-hex"
  },
  "session": {
    "id": "rl-20260807-abc123",
    "startedAt": "2026-08-07T20:00:00.000Z",
    "status": "running",
    "stopReason": null
  },
  "phase": "idle",
  "operation": null,
  "agent": {
    "threadId": null,
    "turns": 0,
    "consecutiveNoChange": 0,
    "threadTurns": 0
  },
  "health": {
    "knownGoodCommit": null,
    "lastSmokePassCommit": null,
    "lastDeepRunCommit": null,
    "lastDeepRunAt": null,
    "pendingFailure": null
  },
  "cadence": {
    "smokePassingCheckpointsSinceDeep": 0,
    "deepRequired": true,
    "deepReasons": ["initial-baseline"]
  },
  "recovery": {
    "activeFailureId": null,
    "sameSignatureCycles": 0,
    "abandonedRanges": [],
    "rescueRefs": []
  },
  "usage": {
    "agentTurns": 0,
    "inputTokens": 0,
    "cachedInputTokens": 0,
    "outputTokens": 0,
    "reasoningTokens": 0,
    "checkMilliseconds": 0
  },
  "eventSequence": 0,
  "createdAt": "2026-08-07T20:00:00.000Z",
  "updatedAt": "2026-08-07T20:00:00.000Z"
}
```

`operation` is phase-specific and contains only data needed to finish or reconcile the current side effect:

```json
{
  "id": "op-42",
  "kind": "checkpoint",
  "unitId": "unit-12",
  "baseCommit": "40-hex",
  "targetCommit": null,
  "rescueRef": null,
  "childPid": null,
  "startedAt": "..."
}
```

A pending failure contains:

```json
{
  "id": "failure-7",
  "checkId": "full-test",
  "classification": "product",
  "signature": "sha256",
  "discoveredAtCommit": "40-hex",
  "confirmed": true,
  "knownGoodCommit": "40-hex-or-null",
  "firstBadCommit": "40-hex-or-null",
  "regressionWindow": ["older", "newer"],
  "repairAttempts": 0,
  "recoveryCycles": 0,
  "latestResultPath": ".git/recovery-loop/runs/..."
}
```

Do not persist:

* full repository plans;
* every old check result;
* copies of milestone objects;
* reviewer reports;
* artifact hashes;
* full conversation history;
* source snapshots already represented by Git.

## 5.3 Durability rules

* Write state to a unique temporary file.
* Flush the file.
* Atomically rename it over `state.json`.
* Persist intent before a Git or process side effect.
* Persist observed result after the side effect.
* Unknown schema versions stop with a clear error.
* Do not implement state migrations in v0.1.
* Event-log failure is nonsemantic when state remains writable.
* State-write failure is semantic and stops the loop.
* Ignore at most one incomplete final JSONL event after a crash; corruption earlier in the log is diagnostic but does not override valid state.

## 5.4 Single-controller lock

Use a small exclusive lock at:

```text
.git/recovery-loop/controller.lock
```

It contains:

```json
{
  "token": "uuid",
  "pid": 1234,
  "hostname": "host",
  "startedAt": "...",
  "command": "run"
}
```

Rules:

* create with exclusive file creation;
* one mutating controller only;
* `status` does not take the lock;
* if the owner PID is alive on the same host, refuse;
* if same-host PID is dead, atomically rename the stale lock and continue;
* never steal a malformed or foreign-host lock automatically;
* release only when the token still matches.

Do not implement lease revisions, state CAS, distributed locking, or elaborate retention of stale locks.

---

# 6. Agent contract

## 6.1 Authority

The coding agent follows, in order:

1. `RECOVERY_GOAL.md`;
2. the controller’s operating contract;
3. current failure evidence when in recovery mode;
4. repository documentation and code;
5. its own implementation judgment.

The goal is operator-owned. The agent may not amend it.

## 6.2 Agent responsibilities

The agent is authorized to:

* inspect the whole worktree;
* choose the highest-value useful next change;
* edit product code, tests, documentation, and local tooling;
* refactor when that is the best route to the goal;
* add or revise tests;
* run local commands for diagnosis;
* inspect prior commits and rescue refs;
* change implementation strategy;
* repair its own regressions;
* remove or replace earlier code;
* make ordinary reversible architectural decisions;
* continue without routine human approval.

It should choose one coherent checkpoint-sized outcome per turn, but this is a prompt-level sizing rule rather than a controller-enforced file-count gate.

## 6.3 Agent prohibitions

The agent must not:

* commit;
* reset, rebase, merge, revert, cherry-pick, or create branches/tags;
* manipulate worktrees;
* push or publish;
* modify `RECOVERY_GOAL.md`;
* modify `.recovery-loop/config.json`;
* modify `.git` or `.git/recovery-loop`;
* request, reveal, create, or commit credentials;
* contact external services;
* deploy or alter infrastructure;
* weaken tests solely to suppress a known failure;
* claim that a check passed when it did not observe it;
* ask for routine approval;
* treat technical uncertainty as a blocker.

The controller enforces only the subset needed to protect recovery and destructive boundaries. The rest remains an agent contract and an externally observable quality risk.

## 6.4 Work-mode prompt

The work prompt should convey:

```text
Choose and implement one coherent next improvement toward RECOVERY_GOAL.md.

You are not required to prove the entire change correct before returning.
The controller will checkpoint your edits first, then run configured checks.
A later failure is acceptable; it will trigger recovery.

Do not manipulate Git history, goal/config authority, credentials, external
services, or files outside this worktree. Make normal engineering decisions
autonomously. Stop after one checkpoint-sized useful outcome.
```

## 6.5 Recovery-mode prompt

Recovery mode adds:

* failing command and normalized outcome;
* paths to complete stdout and stderr;
* known-good commit;
* current head;
* localized first-bad commit or regression window;
* first-bad diff;
* previous failed repair summaries;
* whether the controller will fall back to revert or rollback after this turn.

It instructs the agent to fix the root cause rather than hide the failure.

## 6.6 Structured final response

Use one small output schema:

```json
{
  "outcome": "changed | no_change | goal_complete | blocked",
  "summary": "one concise description of the result",
  "nextHint": "optional useful next direction or null",
  "blocker": "hard blocker description or null"
}
```

Rules:

* `changed`: controller expects dirty source state.
* `no_change`: no useful edit was found this turn.
* `goal_complete`: agent believes the goal is satisfied; the controller runs deep checks.
* `blocked`: reserved for credentials, unavailable external services, contradictory authority, or destructive risk.

Do not ask the agent to return permitted paths, acceptance criteria, expected artifacts, test receipts, risk scores, or a milestone proposal.

## 6.7 Thread policy

* Reuse one thread to reduce repository rereads.
* Persist the thread ID.
* Start a fresh thread after:

  * hard rollback;
  * eight turns in one thread;
  * an agent-created history violation;
  * SDK resume failure;
  * repeated failed repair attempts.
* A new thread reconstructs context from repository, state summary, and recent events.
* Conversation history is never required for recovery.

---

# 7. Configuration and adopting-repository contract

## 7.1 Tracked configuration

Example `.recovery-loop/config.json`:

```json
{
  "schemaVersion": 1,
  "goalFile": "RECOVERY_GOAL.md",
  "branch": "recovery-loop/work",

  "prepare": {
    "argv": ["pnpm", "install", "--frozen-lockfile"],
    "timeoutSeconds": 900,
    "triggerPaths": [
      "package.json",
      "pnpm-lock.yaml"
    ]
  },

  "checks": {
    "smoke": [
      {
        "id": "typecheck",
        "argv": ["pnpm", "typecheck"],
        "timeoutSeconds": 300
      },
      {
        "id": "unit-smoke",
        "argv": ["pnpm", "test:smoke"],
        "timeoutSeconds": 300
      }
    ],
    "deep": [
      {
        "id": "full-test",
        "argv": ["pnpm", "test"],
        "timeoutSeconds": 1800,
        "bisectable": true
      },
      {
        "id": "build",
        "argv": ["pnpm", "build"],
        "timeoutSeconds": 900,
        "bisectable": false
      }
    ]
  },

  "deepPolicy": {
    "everyCheckpoints": 5,
    "maxMinutes": 30,
    "changedFileThreshold": 20,
    "changedLineThreshold": 1000,
    "triggerPaths": [
      "package.json",
      "pnpm-lock.yaml",
      "migrations/",
      ".github/workflows/"
    ],
    "beforeGoalComplete": true,
    "afterRecovery": true
  },

  "limits": {
    "maxAgentTurns": 50,
    "maxWallMinutes": 360,
    "maxRepairTurnsPerFailure": 2,
    "maxRecoveryCyclesPerSignature": 3,
    "maxLocalizationCommits": 64,
    "agentTurnSeconds": 3600
  },

  "protectedPaths": [
    "RECOVERY_GOAL.md",
    ".recovery-loop/config.json"
  ],

  "agent": {
    "model": "CONFIGURE_AT_INITIALIZATION",
    "reasoningEffort": "high",
    "networkAccess": false
  }
}
```

The initialization template should replace `CONFIGURE_AT_INITIALIZATION` with the default model supported by the SDK version pinned by the implementation. Model names must remain configuration strings rather than a hardcoded enum in core types.

## 7.2 Configuration rules

* Exactly one goal file.
* At least one smoke command.
* At least one deep command.
* Command arrays only; never shell strings.
* Unique check IDs.
* Positive finite timeouts.
* Relative, traversal-free trigger and protected paths.
* Goal and config automatically protected even if omitted.
* Branch must start with `recovery-loop/` in v0.1.
* `networkAccess` must be false in v0.1.
* Unknown top-level keys should fail validation to catch configuration mistakes.
* Missing optional `prepare` is valid.
* No five-file policy matrix, check manifest, invariant registry, or benchmark configuration.

## 7.3 Goal document

Template:

```markdown
# Recovery Loop Product Goal

## Objective

Describe the end product or improvement the autonomous branch should achieve.

## Current starting point

Describe important known state that cannot be inferred easily from the repository.

## Required outcomes

List concrete product behaviors or engineering outcomes.

## Constraints

List technology, compatibility, architectural, legal, or operational constraints.

## Non-goals

List work that must not be pursued.

## Completion signals

Describe observable indications that the agent may report `goal_complete`.

## Stop-only boundaries

List project-specific actions that would risk data, credentials, external
systems, or other consequences outside normal Git recovery.
```

This file is authoritative but not cryptographically locked. The controller simply refuses to checkpoint agent edits to it.

## 7.4 Adopting-repository obligations

An adopting project must provide:

1. A local, non-bare Git repository.
2. A committed goal and configuration.
3. Commands that run noninteractively.
4. Check commands that are safe to execute locally.
5. Check commands that communicate result through process exit status.
6. A prepare command when historical commits require dependency reinstallation for diagnosis.
7. No assumption that the loop will provide credentials.
8. No check command that deploys, publishes, deletes remote data, or alters production infrastructure.
9. Enough local tests or other commands for smoke and deep feedback to be meaningful.

It does not need:

* an acceptance manifest;
* evidence receipt producers;
* a special directory of completed milestones;
* an immutable contract lock;
* a separate agent instruction file;
* custom verifier code;
* generated schemas.

---

# 8. CLI and operator surface

The initial CLI should contain four commands.

## `recovery-loop init`

```text
recovery-loop init [--base <revision>] [--worktree <path>]
```

Semantics:

* scaffold missing goal/config templates and exit;
* otherwise validate the tracked contract;
* create the autonomous branch and worktree;
* initialize runtime state;
* run prepare, smoke, and deep checks;
* record a healthy or unhealthy baseline.

It must refuse to overwrite an existing unrelated branch or worktree.

## `recovery-loop run`

```text
recovery-loop run
  [--max-agent-turns <n>]
  [--max-checkpoints <n>]
  [--max-minutes <n>]
```

Semantics:

* acquire the lock;
* resume or start a session;
* reconcile interrupted state;
* recover pending failures;
* otherwise run ordinary agent/checkpoint/check cycles;
* stop on goal candidate, budget, hard boundary, or nonconvergence;
* write a final summary.

There is no separate `resume` command. `run` always resumes when state exists.

## `recovery-loop status`

```text
recovery-loop status [--json]
```

Read-only output:

* session and phase;
* branch and actual head;
* expected head;
* baseline;
* known-good anchor;
* distance from known-good to head;
* last smoke and deep outcomes;
* pending failure;
* localization result;
* repair/revert/rollback history;
* current lock owner;
* budgets consumed;
* most recent events;
* next controller action.

It does not initialize state, mutate Git, or acquire the mutating lock.

## `recovery-loop check`

```text
recovery-loop check [--deep]
```

Semantics:

* run smoke checks by default;
* `--deep` runs smoke plus deep;
* bind results to current autonomous branch head;
* update known-good state on a full pass;
* persist a pending failure on failure;
* never invoke the coding agent.

There should be no v0.1 commands named:

* `plan`;
* `review`;
* `approve`;
* `integrate`;
* `reconcile`;
* `retention`;
* `canary`;
* `doctor`;
* `rollback`.

Recovery and startup diagnosis are normal `run` behavior rather than separate operator workflows.

---

# 9. Observability

## 9.1 Console events

Emit concise lines such as:

```text
[work] unit-12 agent started at 5fd1a2c
[checkpoint] 6be7c91 recovery-loop: add cached query path
[smoke] typecheck PASS 14.2s
[smoke] unit-smoke PASS 21.8s
[deep] due: 5 checkpoints since 81c4b17
[deep] full-test FAIL 42.3s
[diagnose] failure confirmed; known-good 81c4b17 passes
[diagnose] first bad commit 93a77e0
[repair] attempt 1 checkpoint a0118fb
[deep] all checks PASS; known-good advanced to a0118fb
```

The operator should be able to understand the loop without reading JSON.

## 9.2 Event log

`events.jsonl` records small structured events:

* `session-started`;
* `startup-reconciled`;
* `agent-started`;
* `agent-completed`;
* `agent-failed`;
* `checkpoint-created`;
* `guard-rejected`;
* `check-started`;
* `check-completed`;
* `failure-observed`;
* `failure-confirmed`;
* `failure-classified`;
* `localization-started`;
* `regression-localized`;
* `localization-aborted`;
* `repair-started`;
* `revert-created`;
* `revert-failed`;
* `rescue-ref-created`;
* `rollback-completed`;
* `known-good-advanced`;
* `direction-abandoned`;
* `thread-rotated`;
* `session-stopped`.

Each event should contain sequence, timestamp, session ID, head commit, and only relevant event-specific fields.

## 9.3 Command logs

For each command:

```text
runs/<session>/checks/<sequence>-<check-id>/
├── result.json
├── stdout.log
└── stderr.log
```

`result.json` contains:

* check ID;
* argv;
* commit;
* start and finish time;
* duration;
* exit code;
* signal;
* timeout;
* classification;
* normalized signature;
* whether the worktree changed.

This is diagnostic output, not a receipt claiming independent proof.

## 9.4 Agent logs

For each turn:

```text
runs/<session>/agent/<turn-id>/
├── invocation.json
├── events.jsonl
└── final-response.json
```

Record requested model, effort, thread ID, mode, timing, usage, and final structured response. Do not store environment variables or credentials.

## 9.5 Final summary

At stop, write `summary.json` containing:

* baseline commit;
* final branch head;
* known-good anchor;
* stop reason;
* wall time;
* agent turns;
* token usage when available;
* checkpoints;
* smoke and deep executions;
* regressions observed;
* confirmed regressions;
* regressions repaired;
* reverts;
* hard rollbacks;
* rescue refs;
* flaky checks;
* human interventions;
* current pending failure;
* whether the agent reported goal completion;
* whether final head received a deep pass.

This summary is measurement data. It must not contain an internally calculated product-success score.

---

# 10. Failure analysis

| Failure mode                                            | Disposition                               | v0.1 behavior                                                                                                  | Status                                  |
| ------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Agent introduces an ordinary code defect                | Acceptable/recoverable                    | Commit it, detect through smoke or deep checks, repair or reverse                                              | Mitigate now                            |
| Regression appears several commits later                | Acceptable/recoverable                    | Confirm at head, verify anchor, binary-search localize, repair/revert/reset                                    | Mitigate now                            |
| Agent crashes after editing                             | Acceptable/recoverable                    | On restart, checkpoint safe dirty work as `interrupted`                                                        | Mitigate now                            |
| Controller crashes after commit but before state update | Acceptable/recoverable                    | Reconcile actual descendant head with recorded base and adopt commit                                           | Mitigate now                            |
| Controller crashes during check                         | Acceptable/recoverable                    | Re-run the entire relevant check set                                                                           | Mitigate now                            |
| Controller crashes after rescue ref but before reset    | Acceptable/recoverable                    | Validate rescue ref and complete recorded rollback                                                             | Mitigate now                            |
| Baseline is already failing                             | Acceptable but no rollback anchor         | Initialize with null known-good and start in recovery mode                                                     | Mitigate now                            |
| Check is flaky                                          | Recoverable with uncertainty              | Two-of-three confirmation, withhold known-good promotion, accelerate next deep run                             | Mitigate now                            |
| Check executable missing or times out                   | Infrastructure failure                    | Retry once, invoke environment repair when appropriate, then stop                                              | Mitigate now                            |
| Check changes tracked source                            | Configuration/infrastructure defect       | Preserve patch, reset to checked commit, report command violation                                              | Mitigate now                            |
| Agent changes goal/config                               | Recovery-boundary violation               | Refuse checkpoint, one correction turn, then stop                                                              | Mitigate now                            |
| Agent writes a high-confidence secret                   | Destructive-risk boundary                 | Refuse checkpoint, one removal turn, then stop                                                                 | Mitigate now                            |
| Agent manipulates Git but stays descendant              | Recoverable protocol violation            | Rescue, soft-reset, consolidate to one controller checkpoint, rotate thread                                    | Mitigate now                            |
| Autonomous branch moves to unexplained non-descendant   | Must stop                                 | Preserve reachable refs and report canonical ambiguity                                                         | Mitigate now                            |
| State file corrupt or belongs to another repository     | Must stop                                 | No speculative reconstruction; preserve files and report exact mismatch                                        | Mitigate now                            |
| Disk full prevents durable state or commit              | Must stop                                 | Do not proceed without a reliable recovery record                                                              | Mitigate now                            |
| Repair repeats without progress                         | Must stop after bounded recovery          | Two repair turns, revert, rollback, maximum three cycles per signature                                         | Mitigate now                            |
| Revert conflicts                                        | Recoverable                               | Abort revert and use rescue-ref-plus-reset                                                                     | Mitigate now                            |
| Old known-good anchor now fails                         | Potential environment drift               | Diagnose environment; do not falsely blame a code commit                                                       | Mitigate now                            |
| Agent weakens a test and makes checks pass              | May survive internally                    | Test edits trigger deep check but are not independently adjudicated; external evaluation remains authoritative | Deliberate v0.1 limitation              |
| Project-owned check has destructive remote side effects | Potentially unrecoverable                 | Contract forbids it; static generic enforcement is limited                                                     | Document now; stronger sandbox deferred |
| Secret detector misses an unknown format                | Potentially unrecoverable if later pushed | Loop never pushes; high-confidence scanner only                                                                | Deliberate limitation                   |
| Diagnostic command is not bisectable                    | Recoverable without exact localization    | Give agent a bounded regression range; repair first, rollback if needed                                        | Mitigate now                            |
| Nonlinear history or merge commits                      | Recoverable with reduced precision        | Skip unique binary search, diagnose range                                                                      | Mitigate now                            |
| Runtime state is manually deleted                       | Recovery information lost                 | Branch survives, but automatic known-good reconstruction is not guaranteed                                     | Event replay/reconstruction deferred    |
| Controller implementation contains a Git bug            | Serious                                   | Rescue-before-reset invariant, extensive temp-repo tests, no push or baseline-branch mutation                  | Mitigate now                            |

The most important deliberate tradeoff is that the loop does not independently prove that the agent preserved test quality. That risk is visible and appropriate for a system whose purpose is to measure whether cheaper recovery can outperform heavy prevention.

---

# 11. Repository structure

```text
recovery-loop/
├── README.md
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── vitest.config.ts
│
├── src/
│   ├── cli.ts                 command parsing and dispatch
│   ├── config.ts              tracked config loading and validation
│   ├── contracts.ts           compact runtime types and validators
│   ├── controller.ts          normal loop and crash-phase reconciliation
│   ├── agent-gateway.ts       sole SDK adapter and prompt construction
│   ├── git-repository.ts      branch, worktree, commit, revert, reset, refs
│   ├── check-runner.ts        process execution, logs, confirmation
│   ├── recovery.ts            failure policy and binary-search localizer
│   ├── state-store.ts         atomic state, lock, event append
│   ├── safety.ts              guard checks and high-confidence secret scan
│   └── redaction.ts           console/event diagnostic redaction
│
├── templates/
│   ├── RECOVERY_GOAL.md
│   └── config.json
│
├── tests/
│   ├── unit/
│   │   ├── config.test.ts
│   │   ├── state-store.test.ts
│   │   ├── check-runner.test.ts
│   │   ├── safety.test.ts
│   │   └── recovery-policy.test.ts
│   ├── integration/
│   │   ├── git-repository.test.ts
│   │   ├── startup-reconciliation.test.ts
│   │   ├── controller-work.test.ts
│   │   └── controller-recovery.test.ts
│   ├── acceptance/
│   │   ├── delayed-regression.test.ts
│   │   ├── revert-and-rollback.test.ts
│   │   ├── interrupted-run.test.ts
│   │   └── destructive-boundary.test.ts
│   └── support/
│       ├── temporary-repository.ts
│       ├── scripted-agent.ts
│       └── interruption-hooks.ts
│
└── docs/
    ├── architecture.md
    ├── adopting-project.md
    └── agent-contract.md
```

## Size constraints

Treat these as architectural tripwires:

* no more than roughly 11 production modules;
* no production module above roughly 600 lines without a clear reason;
* target under 5,000 lines of production TypeScript;
* one runtime SDK dependency plus only narrowly justified utilities;
* no runtime schema framework unless handwritten validation proves materially worse;
* no abstract base classes;
* no generic workflow/state-machine library;
* no plugin framework;
* no database.

Tests may exceed production code because Git and interruption semantics require adversarial coverage.

---

# 12. Implementation sequence

## Stage 1 — Greenfield scaffold and compact contracts

### Objective

Create a runnable TypeScript CLI repository with the product vocabulary and architectural boundaries fixed before adding behavior.

### Scope

* Node.js 24, TypeScript ESM, pnpm, Vitest.
* CLI binary entry.
* Compact types for configuration, state, events, agent response, command result.
* Handwritten exact validators.
* Goal and config templates.
* SDK isolated behind an interface but not yet invoked.

### Key files

```text
package.json
src/cli.ts
src/contracts.ts
src/config.ts
templates/*
tests/unit/config.test.ts
```

### Required behavior

* `recovery-loop init`, `run`, `status`, and `check` parse.
* Unknown commands and flags fail clearly.
* Config rejects unknown keys, shell strings, duplicate check IDs, empty smoke/deep arrays, unsafe paths, and invalid limits.
* Core types do not contain milestone, reviewer, receipt, tier, or integration concepts.

### Validation

* unit tests for every configuration boundary;
* CLI parsing tests;
* snapshot of generated templates;
* production build and typecheck.

### Dependencies

None.

### Completion criteria

* Package installs and builds.
* All four commands dispatch to explicit not-yet-implemented handlers.
* Config validator is exact and small.
* No copied code or schemas from the reference repository.

---

## Stage 2 — Git workspace and checkpoint primitives

### Objective

Establish the recovery substrate before introducing an agent.

### Scope

* repository inspection;
* Git common-directory resolution;
* branch creation;
* persistent worktree creation and recreation;
* clean checkpoint commits;
* diff inspection;
* changed-file and line statistics;
* rescue refs;
* clean revert;
* hard reset;
* diagnostic worktree;
* agent-created descendant-commit normalization.

### Key files

```text
src/git-repository.ts
tests/integration/git-repository.test.ts
tests/support/temporary-repository.ts
```

### Required behavior

* Never use shell command strings.
* Every Git command includes an explicit repository/worktree path.
* Initialization leaves the operator’s branch unchanged.
* Checkpoint commit is exactly one controller commit.
* Empty changes produce no commit.
* Rescue ref is verified before reset.
* Revert conflicts abort cleanly.
* Diagnostic worktree can inspect arbitrary commits without moving the autonomous branch.
* Non-descendant unexpected movement produces a typed canonicality error.

### Validation

Temporary-repository tests must cover:

* normal branch/worktree creation;
* branch already exists;
* worktree disappears and is recreated;
* agent leaves dirty edits;
* agent creates one or several descendant commits;
* agent rewrites history;
* clean revert;
* conflicting revert;
* rescue-before-reset ordering;
* reset interruption after rescue;
* changed symlink and gitlink inspection;
* operator branch unchanged throughout.

### Dependencies

Stage 1.

### Completion criteria

A scripted sequence can create three checkpoints, revert the middle one, hard-reset after creating a rescue ref, and reconstruct the worktree from branch state.

---

## Stage 3 — Durable state, event history, and lock

### Objective

Make every Git operation resumable without constructing a large controller schema.

### Scope

* atomic `state.json`;
* exclusive controller lock;
* append-only events;
* phase and operation journal;
* startup validation;
* state/repository identity binding;
* final summary directory layout.

### Key files

```text
src/state-store.ts
src/contracts.ts
tests/unit/state-store.test.ts
tests/integration/startup-reconciliation.test.ts
```

### Required behavior

* State intent is written before Git side effects.
* State result is written after side effects.
* Same-host dead locks can be quarantined.
* Live, foreign-host, and malformed locks are not stolen.
* `status` reads without locking or mutation.
* Interrupted final JSONL line is tolerated.
* Unknown state schema stops.
* State from another repository stops.
* Event failure does not rewrite semantic state.

### Validation

Inject failures:

* before temporary-state rename;
* after intent persistence;
* after Git commit but before result persistence;
* after rescue creation;
* after reset but before state update;
* during lock creation;
* during lock release.

### Dependencies

Stages 1–2.

### Completion criteria

Opening the controller after every injected interruption converges to one unambiguous branch head and phase, or produces a deliberate canonicality stop.

---

## Stage 4 — Guard and command execution

### Objective

Provide cheap, trustworthy-enough feedback without receipts or broad verification machinery.

### Scope

* bounded process runner;
* stdout/stderr/result files;
* process timeout and termination;
* sanitized environment;
* smoke and deep execution;
* prepare command;
* Git cleanliness check after commands;
* high-confidence secret and key scanning;
* changed symlink/gitlink rejection;
* failure signature normalization;
* two-of-three confirmation.

### Key files

```text
src/check-runner.ts
src/safety.ts
src/redaction.ts
tests/unit/check-runner.test.ts
tests/unit/safety.test.ts
```

### Required behavior

* Commands use `spawn` with argv, never a shell.
* Run sequentially.
* Timeout terminates the process group on supported POSIX platforms.
* Complete output is logged; bounded redacted tails enter state/events.
* A check that changes tracked files is invalid and its mutation is removed.
* Guard checks run before commit.
* Smoke/deep checks bind to exact `HEAD`.
* Failure classification distinguishes product, infrastructure, flaky, and safety.
* Passing commands do not create evidence receipts.

### Validation

Cover:

* pass;
* nonzero exit;
* missing executable;
* timeout;
* child process;
* very large output;
* output-write failure;
* tracked mutation;
* ignored generated files;
* fail/pass/fail and fail/pass/pass confirmation;
* secret detection;
* false-positive-resistant ordinary high-entropy text;
* private-key block;
* protected goal/config edit.

### Dependencies

Stages 1–3.

### Completion criteria

A committed test repository can be checked repeatedly with deterministic results and no check is capable of silently altering the checked source state.

---

## Stage 5 — Check scheduling and health model

### Objective

Implement verification as feedback and define the check-relative known-good anchor.

### Scope

* smoke after every checkpoint;
* deep cadence;
* elapsed-time trigger;
* path and change-size triggers;
* goal-completion trigger;
* known-good promotion;
* unhealthy baseline;
* check-driven pending failure.

### Key files

```text
src/controller.ts
src/check-runner.ts
src/contracts.ts
tests/unit/recovery-policy.test.ts
tests/integration/controller-work.test.ts
```

### Required behavior

* A checkpoint exists before smoke begins.
* Smoke failure leaves checkpoint in history.
* Smoke success permits continued work without deep proof unless due.
* Deep pass promotes exact head.
* Deep failure preserves prior anchor.
* An unhealthy baseline initializes with no anchor.
* Check scheduling is deterministic from state, config, time, and changed paths.

### Validation

Test:

* smoke pass and continue;
* smoke fail and enter recovery;
* five-checkpoint deep trigger;
* elapsed-time trigger;
* high-risk path trigger;
* line/file threshold;
* completion trigger;
* pass at baseline;
* failed baseline;
* deep pass at later commit;
* state reload preserving cadence.

### Dependencies

Stages 1–4.

### Completion criteria

A scripted non-agent controller can advance through checkpoints with cheap checks, periodically establish anchors, and enter recovery after both immediate and delayed failure.

---

## Stage 6 — One coding-agent gateway

### Objective

Connect a single autonomous coding role without introducing planning or reviewing roles.

### Scope

* agent interface;
* SDK implementation;
* work and recovery prompts;
* one simple output schema;
* thread persistence and rotation;
* event streaming;
* timeout and usage;
* scripted fake implementation for tests.

### Key files

```text
src/agent-gateway.ts
src/contracts.ts
tests/support/scripted-agent.ts
tests/integration/controller-work.test.ts
docs/agent-contract.md
```

### Required behavior

* Only `agent-gateway.ts` imports the SDK.
* SDK version is pinned.
* Agent runs in the autonomous worktree.
* Network is disabled.
* Use the most restrictive SDK-supported noninteractive approval mode.
* Work prompt lets the agent choose the task.
* Recovery prompt supplies exact failure evidence.
* Final response validates against four outcomes.
* Resume failure creates a fresh thread with reconstructed context.
* Agent-created commits are normalized by the Git component rather than trusted.
* Agent final prose never determines check success.

### Validation

With the scripted gateway:

* change source;
* return no change;
* report completion;
* report hard blocker;
* time out;
* malformed response;
* resume thread;
* force thread rotation;
* create prohibited Git commits;
* edit protected authority.

A live SDK smoke test should be opt-in and excluded from ordinary CI.

### Dependencies

Stages 1–5.

### Completion criteria

A real or scripted agent can make one useful checkpoint and the controller—not the agent—owns the resulting commit.

---

## Stage 7 — Normal autonomous controller loop

### Objective

Connect startup, agent, checkpoint, smoke, deep scheduling, budgets, completion, and interruption into the first usable loop.

### Scope

* full `run`;
* startup reconciliation;
* agent/checkpoint loop;
* no-change handling;
* goal-completion handling;
* resource limits;
* SIGINT/SIGTERM handling;
* final summary;
* read-only status.

### Key files

```text
src/controller.ts
src/cli.ts
tests/integration/controller-work.test.ts
```

### Required behavior

Pseudocode:

```ts
while (!budget.exhausted()) {
  reconcileStartup();

  if (state.health.pendingFailure) {
    await recover();
    continue;
  }

  if (deepCheckDueWithoutNewWork()) {
    await runDeepChecks();
    continue;
  }

  const turn = await agent.work(buildContext());
  const checkpoint = await checkpointTurn(turn);

  if (checkpoint) {
    const smoke = await runSmoke(checkpoint);
    if (smoke.failed) {
      recordPendingFailure(smoke);
      continue;
    }
  }

  if (turn.outcome === "goal_complete") {
    const deep = await runAllChecks();
    if (deep.passed) stop("goal-candidate-ready");
    else recordPendingFailure(deep);
  } else if (deepIsDue()) {
    const deep = await runDeepChecks();
    if (deep.failed) recordPendingFailure(deep);
  }

  handleNoChangeOrBlocked(turn);
}
```

### Validation

* multiple useful checkpoints;
* no deep check on every smoke-passing commit;
* deep trigger at exact cadence;
* goal completion with pass;
* goal completion with failure and recovery transition;
* budget stop;
* repeated no-change stop;
* Ctrl-C during agent turn;
* Ctrl-C after checkpoint;
* restart and continue.

### Dependencies

Stages 1–6.

### Completion criteria

The loop can perform several autonomous development units with one persistent agent thread and no Planner, Reviewer, or integration gate.

---

## Stage 8 — Forward repair and repeated-failure control

### Objective

Make ordinary failures problems the loop solves rather than terminal states.

### Scope

* failure confirmation;
* recovery prompt;
* repair checkpoints;
* repair-attempt counter;
* signature recurrence;
* environment-recovery mode;
* post-repair full checks.

### Key files

```text
src/recovery.ts
src/controller.ts
tests/integration/controller-recovery.test.ts
```

### Required behavior

* Confirm product failure before repair.
* Repair first, even when a revert might be possible.
* Each failed repair remains in history.
* Run the failing predicate first after repair for rapid feedback.
* Once predicate passes, run all smoke and deep checks.
* Clear failure only after full pass.
* Rotate thread after repair limit.
* Do not perform unrelated feature work while a confirmed failure is active.
* Stop after configured same-signature recovery cycles.

### Validation

* immediate smoke regression fixed on first repair;
* repair introduces another regression;
* first repair fails, second passes;
* repair clears predicate but another deep check fails;
* no known-good baseline;
* environment command fails at both head and anchor;
* recurring signature exhausts cycles.

### Dependencies

Stages 1–7.

### Completion criteria

An agent-generated bad checkpoint can be diagnosed, repaired through one or more visible commits, promoted to known-good, and followed by new feature work.

---

## Stage 9 — Delayed localization, revert, and rollback

### Objective

Complete the core recovery model for mistakes discovered several commits later.

### Scope

* diagnostic worktree;
* confirmed anchor pass/head fail;
* bounded manual binary search;
* first-bad evidence;
* clean automatic revert;
* rescue-ref-plus-reset;
* rollback interruption recovery;
* abandoned-range context.

### Key files

```text
src/recovery.ts
src/git-repository.ts
tests/integration/controller-recovery.test.ts
tests/acceptance/delayed-regression.test.ts
tests/acceptance/revert-and-rollback.test.ts
```

### Required behavior

* Never run localization in the autonomous worktree.
* Never claim a first-bad commit after an uncertain midpoint.
* Prefer repair before revert.
* Prefer clean revert before hard reset.
* Verify rescue ref before reset.
* Run full checks after revert or reset.
* Continue normal work after successful recovery.
* Preserve abandoned work under a named rescue branch.

### Validation

* regression at second of five commits;
* exact binary-search localization;
* prepare command required at historical commit;
* flaky midpoint aborts localization;
* merge range degrades to window;
* forward repair succeeds;
* repair limit then clean revert succeeds;
* revert conflict then rescue/reset succeeds;
* crash after rescue but before reset;
* crash after reset but before state update;
* old head remains reachable.

### Dependencies

Stages 1–8.

### Completion criteria

The system passes the delayed-regression, revert, and hard-rollback acceptance scenarios described below.

---

## Stage 10 — Operator surface, documentation, and release acceptance

### Objective

Finish the smallest usable product and prove that it embodies the intended philosophy.

### Scope

* final CLI behavior;
* status rendering;
* JSON output;
* final summaries;
* README;
* architecture and adopting-project docs;
* deterministic acceptance suite;
* optional live-agent canary;
* production code-size review.

### Key files

```text
src/cli.ts
README.md
docs/*
tests/acceptance/*
package.json
```

### Required behavior

* All four commands have complete help.
* Status explains current head separately from known-good anchor.
* Summary separates agent completion claim from external correctness.
* Documentation explicitly says that branch history may be temporarily broken.
* No documentation implies every checkpoint is approved or verified.
* No command surface is added for architectural symmetry.
* No automatic push or merge exists.

### Validation

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm test:acceptance
pnpm build
```

Also perform one opt-in live-agent run on a disposable repository before the first release tag.

### Dependencies

All previous stages.

### Completion criteria

* Required automated acceptance scenarios pass.
* Live canary creates at least one useful checkpoint and one repair checkpoint.
* Source remains within the architectural size tripwires or records a concrete justification.
* A fresh operator can adopt the loop using only README and generated templates.

---

# 13. End-to-end acceptance

The acceptance suite must operate on temporary real Git repositories. It may use a deterministic scripted `AgentGateway` so controller semantics remain repeatable and free of model cost.

## Scenario A — Delayed regression and forward repair

### Fixture

A small TypeScript expression library has:

* smoke check: typecheck plus basic positive-number tests;
* deep check: full suite including negative numbers and edge cases;
* goal: add multiplication, division, and modulo support.

### Scripted work

1. Baseline passes smoke and deep; anchor is `G0`.
2. Agent checkpoint `C1` adds multiplication correctly.
3. Smoke passes.
4. Agent checkpoint `C2` refactors parsing but introduces a latent negative-number regression not covered by smoke.
5. Smoke passes.
6. Agent checkpoint `C3` adds division in a separate file.
7. Smoke passes.
8. Deep cadence becomes due.
9. Deep test fails on negative-number parsing.
10. Controller confirms current failure.
11. Diagnostic worktree confirms `G0` passes.
12. Binary search identifies `C2`.
13. Recovery agent creates repair checkpoint `R1`.
14. Failing predicate passes.
15. All smoke and deep checks pass.
16. `R1` becomes known-good.
17. Agent creates `C4` adding modulo.
18. Smoke passes and the loop continues.

### Required assertions

* `C2` and `C3` entered branch history before the deep failure.
* No Reviewer or admission step occurred.
* `C2` was localized automatically.
* The repair, not a reset, restored health.
* The branch contains the defect and fix.
* The useful later division change survived.
* New work continued after recovery.

## Scenario B — Repair exhaustion and clean revert

### Fixture

A bad optimization commit changes one parser function. A subsequent useful commit adds unrelated documentation or functionality.

### Scripted work

1. Deep-pass anchor `G0`.
2. Bad commit `B1`.
3. Useful later commit `U1`.
4. Deep check discovers regression.
5. Localizer identifies `B1`.
6. Two recovery turns fail to correct it.
7. Controller cleanly reverts `B1`.
8. Full checks pass.
9. `U1` remains in branch history and behavior.
10. Agent continues with another useful checkpoint.

### Required assertions

* Two repair commits are preserved.
* Revert occurs only after repair limit.
* Revert is a new commit, not reset.
* Later useful work remains.
* Known-good advances to the revert head.

## Scenario C — Conflicting revert and hard rollback

### Fixture

Later work modifies the same lines as the first-bad commit so automatic revert conflicts.

### Scripted work

1. Anchor `G0`.
2. Bad commit `B1`.
3. Entangled later commit `E1`.
4. Deep failure and localization.
5. Repair limit exhausted.
6. `git revert B1` conflicts and is aborted.
7. Controller records intended rescue ref.
8. Rescue ref is created at old head.
9. Autonomous branch resets to `G0`.
10. Full checks pass.
11. Agent receives the abandoned range and chooses a different implementation.
12. New checkpoint succeeds.

### Required assertions

* No reset happens before rescue verification.
* Old `B1..E1` history remains reachable from rescue branch.
* Active branch equals `G0` immediately after reset.
* Work resumes autonomously.
* Stop was not required merely because rollback occurred.

## Scenario D — Interruption recovery

Inject process interruption at four boundaries:

1. after the agent writes files but before checkpoint;
2. after checkpoint commit but before state records the head;
3. during a deep check;
4. after rescue-ref creation but before hard reset.

After reopening:

* dirty agent work becomes an `interrupted` checkpoint;
* already-created checkpoint is adopted once, not duplicated;
* deep check is rerun;
* rollback finishes from the persisted intent;
* state and branch converge.

## Scenario E — Destructive boundary

The scripted agent attempts, in separate runs, to:

* modify `RECOVERY_GOAL.md`;
* commit a PEM private key;
* introduce a changed symlink pointing outside the worktree.

Required behavior:

* no offending checkpoint is created;
* the agent gets one correction turn;
* successful correction allows continuation;
* persistent violation stops with an exact explanation;
* no baseline or operator branch is modified.

## Required commands

```text
pnpm test:acceptance
```

Optional real-agent validation:

```text
pnpm demo:live
```

The live demo uses a disposable fixture and the same production controller. It is not an alternative implementation path and should not contain test-only recovery logic.

---

# 14. Deferred roadmap

| Idea                                                    | Why deferred                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Adaptive, learned verification scheduling               | Static cadence and risk triggers are sufficient to test the central hypothesis |
| Multiple repair agents or debate                        | Would reintroduce agent handoffs and blur the single-agent experiment          |
| Independent periodic audit agent                        | Potentially valuable, but deterministic deep checks should be evaluated first  |
| General automatic commit dependency analysis            | Clean revert plus rescue/reset covers initial recovery                         |
| Automatic cherry-picking from abandoned rescue branches | Risky and not required to preserve the work                                    |
| Sophisticated multi-check causal localization           | V0.1 localizes one primary failing predicate                                   |
| Flake probability modeling                              | Two-of-three and bounded recurrence are enough initially                       |
| Distributed execution                                   | Conflicts with the small local-controller objective                            |
| Remote CI integration                                   | Local checks are adequate for the first comparison                             |
| Automatic push, pull request, or merge                  | External publication is deliberately outside the recovery boundary             |
| Full sandbox for project-owned check commands           | Requires platform-specific containment and broader threat modeling             |
| Extensible secret-scanner plugins                       | High-confidence built-ins plus no push are adequate for v0.1                   |
| Runtime-state reconstruction from Git events alone      | Atomic state is simpler; corruption remains a stop condition                   |
| State schema migrations                                 | One initial schema and explicit incompatibility are preferable                 |
| Artifact retention policies                             | Runtime output is small; no automatic deletion is needed                       |
| Benchmark runner and final judge                        | Metrics accommodation is enough; keep evaluation external                      |
| Rich dashboards or tracing                              | Console, status, events, and summary are sufficient                            |
| Windows process-tree and filesystem support             | Add after POSIX semantics are stable                                           |
| Provider abstraction beyond the narrow agent interface  | The interface permits future work without implementing unused providers now    |

---

# Final design test

## 1. Is this genuinely philosophically different from the Milestone Loop?

Yes. The most important operation has been reversed:

* Milestone Loop: verify and review a candidate, then integrate.
* Recovery Loop: commit a provisional checkpoint, then observe and recover.

There is no privileged integration event inside Recovery Loop. The autonomous branch’s ordinary history contains progress, mistakes, repairs, and reversals.

## 2. Is verification primarily feedback rather than admission control?

Yes.

* Smoke and deep checks run after checkpoint creation.
* A failure changes what the loop does next.
* A pass is sufficient to continue at the configured depth.
* Only narrow recovery-integrity guards can prevent a checkpoint.

## 3. Is the system safer because recovery is cheap?

Yes.

The primary safety mechanisms are:

* isolated autonomous branch and worktree;
* frequent commits;
* check-relative known-good anchors;
* diagnostic worktree;
* automatic localization;
* forward repair;
* clean revert;
* rescue refs before hard reset;
* interruption journal.

It does not depend on proving every checkpoint before it exists.

## 4. Can major pieces be removed while preserving the model?

Most mature-controller machinery already has been removed.

The remaining substantial pieces each protect the central experiment:

* worktree: isolates operator work;
* checkpoint manager: makes mistakes recoverable;
* checks: detect mistakes;
* recovery engine: makes detection useful;
* state journal: survives interruption;
* one agent gateway: performs autonomous development.

Removing the limited localizer would materially weaken recovery from mistakes discovered several commits later. Removing rescue refs would make rollback destructive. Both therefore earn their complexity.

## 5. Can a fresh agent understand and resume from repository state alone?

Yes.

The agent receives:

* tracked goal and configuration;
* current Git history;
* known-good and failure state from `.git/recovery-loop/state.json`;
* recent event summaries;
* check logs;
* abandoned ranges and rescue refs.

No conversation transcript is required.

## 6. Can the loop recover from a mistake found several changes later?

Yes.

It verifies the known-good lower bound, confirms current failure, binary-searches the commit range when possible, attempts forward repair, then reverts or rolls back while preserving the former head.

This is a release acceptance requirement, not a roadmap item.

## 7. Are destructive actions treated differently from ordinary mistakes?

Yes.

Compilation failures and regressions are committed and repaired.

Credentials, authority corruption, path escapes, external destructive operations, ambiguous refs, and loss of durable recovery state block or stop because proceeding could make recovery significantly harder or impossible.

## 8. Does the coding agent have enough freedom?

Yes.

The agent chooses work, implementation, architecture, tests, refactors, and repair strategy. It does not need a separate Planner’s proposal or a Reviewer’s permission. The controller owns only history, checks, resource limits, and destructive boundaries.

## 9. Is the initial repository materially smaller and simpler?

It should be.

The design has:

* one agent role;
* one controller;
* one tracked config;
* one goal document;
* one state file;
* one event log;
* two configured check classes;
* four CLI commands;
* roughly 11 production modules;
* no verification schemas, receipts, review objects, reconciliation history, retention planner, or benchmark subsystem.

The production-code target is under roughly 5,000 lines.

## 10. Is every substantial subsystem earning its complexity?

Yes:

* **Git manager:** recovery substrate.
* **State journal:** interruption recovery.
* **Check runner:** detection.
* **Scheduler:** avoids full verification on every change.
* **Recovery engine:** defining product capability.
* **Agent gateway:** autonomous implementation.
* **Safety guard:** narrow protection for genuinely difficult-to-reverse damage.
* **Event history:** enough diagnosis to understand progress and rollback.

No other major subsystem belongs in v0.1.
