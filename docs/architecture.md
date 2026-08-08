# Recovery Loop architecture

## Design center

Recovery Loop preserves work before it evaluates ordinary project health:

```text
single coding turn
       |
       v
controller-owned checkpoint
       |
       v
smoke commands ---- failure ----> confirmation and recovery
       |
       v
deep command due? -- failure ----> localization and recovery
       |
       v
continue
```

A checkpoint is a recovery point, not an admission, approval, verification, or correctness claim. The active autonomous branch may be temporarily broken. Command failures change the next controller action; they do not retroactively prevent an ordinary checkpoint from existing.

There is no privileged integration event. Recovery Loop never automatically changes the operator branch, pushes, merges, deploys, publishes, releases, or contacts project services.

## Authority boundaries

Recovery Loop has one coding-agent role. The same role chooses ordinary work and repairs confirmed product failures.

The coding agent owns:

- repository inspection and technical judgment;
- selection of one coherent next improvement;
- source, test, documentation, and local-tool edits;
- local diagnostic commands;
- forward-repair implementation.

The controller owns:

- the autonomous branch and persistent worktree;
- checkpoint, revert, rescue-ref, and reset operations;
- safety guards;
- command execution, timeouts, and logs;
- check scheduling and command-relative health;
- failure confirmation and conservative localization;
- durable phase/operation state and the single-controller lock;
- terminal reasons and measurement-only summaries.

Only `src/agent-gateway.ts` imports `@openai/codex-sdk`. It runs the configured model in the autonomous worktree with workspace-only writes, `never` approvals, command network disabled, web search disabled, and no additional writable directories. Conversation history is an optimization; Git, tracked authority, runtime state, and recent events reconstruct a fresh thread.

## Components and code ownership

The production files remain direct policy modules rather than a generic workflow framework:

| Concern | Primary files |
| --- | --- |
| Argument parsing and four-command dispatch | `src/cli.ts` |
| Initialization, status/JSON rendering, manual checks, summary presentation | `src/operator-surface.ts` |
| Tracked configuration and templates | `src/config.ts`, `templates/*` |
| Compact validated runtime contracts | `src/contracts.ts` |
| Normal controller loop and final measurement summary | `src/controller.ts` |
| Sole coding-agent SDK boundary | `src/agent-gateway.ts` |
| Git inspection and low-level recovery primitives | `src/git-repository.ts` |
| Journaled Git mutation and startup convergence | `src/git-operations.ts` |
| Journaled argv-only command execution | `src/check-runner.ts` |
| Command scheduling and known-good authority | `src/health-controller.ts` |
| Confirmation and forward repair | `src/recovery.ts` |
| Historical localization and fallback selection | `src/recovery-fallback.ts` |
| Revert/reset validation and abandonment policy | `src/recovery-actions.ts` |
| Narrow pre-commit safety boundaries | `src/safety.ts` |
| Atomic state, append-only events, layouts, and lock | `src/state-store.ts` |

The Stage 10 operator module is presentation and command orchestration, not another controller or agent. It calls the same journaled Git and command-health boundaries used by `run`.

## Repository and state layout

For an operator checkout at `/work/project`, the default persistent resources are:

```text
/work/project                         operator checkout; never moved by the loop
/work/.project-recovery-loop/worktree persistent autonomous branch worktree
/work/project/.git/recovery-loop      runtime state, logs, summaries, diagnostics
```

The tracked adopting-project contract is only:

```text
RECOVERY_GOAL.md
.recovery-loop/config.json
```

The runtime root contains one atomically replaced `state.json`, an append-only `events.jsonl`, one exclusive `controller.lock`, per-session command/agent logs, summaries, and an optional disposable diagnostic worktree. State is bound to the Git common directory, baseline, autonomous branch, and worktree path.

`state.phase` and the small phase-specific `operation` record form a crash journal. Intent is persisted before Git or process side effects; observed results are persisted afterward. On startup, `run` inspects Git directly and either converges the recorded operation or stops at canonical ambiguity. Event text never overrides Git or valid state.

## Git semantics

Initialization creates `recovery-loop/work` at a resolved baseline and adds a linked worktree without moving the operator branch or head. The autonomous history is expected to remain linear.

After each nonempty coding turn, the controller:

1. compares the actual branch head with the recorded turn base;
2. preserves and normalizes descendant commits if the agent violated the no-commit contract;
3. stops on unexplained non-descendant movement;
4. applies narrow safety guards;
5. stages allowed changes and creates one controller-authored checkpoint;
6. persists the exact new head;
7. runs smoke commands against that committed head.

Agent-created descendant history is preserved under a rescue ref, soft-reset to the turn base, and collapsed into one controller checkpoint. Non-descendant movement is not guessed through.

## Command health

Commands are arrays of executable plus arguments. They are spawned without a shell, sequentially, with bounded timeouts, complete stdout/stderr logs, redacted diagnostic tails, and mutation detection. A command that changes tracked source cannot silently establish health.

The three command roles are intentionally fixed:

- **Guard:** runs before checkpointing only for recovery integrity or hard-to-reverse damage.
- **Smoke:** runs after every new checkpoint and is cheap enough to guide the next action.
- **Deep:** runs periodically and at risk, recovery, completion, elapsed-time, or explicit operator boundaries.

One failing deep command may also be used as the diagnostic predicate. This does not create a general hierarchy of configurable verification levels.

`knownGoodCommit` advances only when the exact clean autonomous head receives a complete smoke pass and complete deep pass. It means only that those configured commands passed at that commit. A newer smoke-passing head and an older known-good anchor are a normal state.

`recovery-loop check` uses the same journaled runner and health authority. The default runs all smoke commands. `--deep` runs complete smoke and deep sets and can advance known-good only through the same exact-head rules. It never invokes the coding agent.

## Recovery order

For a new command failure, the controller persists exact evidence and uses two-of-three confirmation when observations conflict. Product, flaky, infrastructure, and safety outcomes remain distinct.

For a delayed product regression with known-good `G` and failing head `H`:

1. verify `G` is an ancestor of `H`;
2. reproduce the predicate at both endpoints in a detached diagnostic worktree;
3. search a bounded linear first-parent range only when the command is bisectable;
4. stop localization at any uncertain, flaky, infrastructure, or safety midpoint;
5. retain the smallest proven regression window and claim a unique first-bad commit only when evidence establishes it.

Recovery then follows one deterministic order:

1. Give the same coding role exact failure/localization evidence for bounded forward-repair turns.
2. If a unique first-bad commit is known and repair is exhausted, attempt a clean controller-owned revert.
3. If revert is unavailable, conflicts, or fails complete health, persist a reset plan, create and verify a rescue ref at the old head, then reset only the autonomous branch/worktree to the known-good anchor.
4. Run complete smoke and deep sets after a repair, revert, or reset before clearing failure or advancing known-good.
5. Record abandoned history and rotate the coding thread before normal work resumes after hard rollback.

Failed repair commits remain visible. A clean revert preserves useful later work. Hard rollback removes commits only from the active autonomous branch after the old head is reachable from a named rescue branch. Rescue refs are never automatically deleted.

## Operator status and summary semantics

`status` is strictly read-only. It takes no lock and performs only state reads and Git inspection. It reports:

- current branch head and durable expected head;
- baseline and known-good anchor as separate commits;
- ancestry/distance from known-good to head;
- latest smoke/deep command-set health;
- pending failure and localization state;
- repair, revert, rollback, abandoned-range, and rescue history;
- current lock owner;
- consumed agent/check budgets;
- recent events and the next controller action.

Final summaries are measurement data. They report the agent's completion belief separately from whether the final head received a complete deep pass, and explicitly record that Recovery Loop did not evaluate external correctness. No product-success score exists.

## Hard boundaries and deliberate limitations

The controller stops when continuing would make recovery materially harder or risk effects outside ordinary Git recovery: durable-state failure, canonical ambiguity, persistent protected-authority edits, high-confidence secrets/private keys, unsafe symlink/gitlink changes, path escape, an unexplained Git operation, destructive project commands, unavailable required external services, or bounded recovery nonconvergence.

The v0.1 design deliberately does not include multiple agents, independent semantic review, remote CI, automatic branch integration, automatic publication, automatic rescue cleanup, generic provider plugins, a workflow/state-machine library, state migrations, a database, a benchmark judge, or a dashboard.

Project-owned checks are trusted local configuration and do not receive a general-purpose sandbox. Secret detection is intentionally high-confidence rather than complete. Localization is bounded and first-parent. Runtime-state deletion can remove information that Git alone cannot fully reconstruct. These are documented operating limits, not hidden correctness claims.
