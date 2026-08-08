# Recovery Loop

Recovery Loop is a local, recovery-first autonomous development controller. One coding agent chooses and implements useful work on a dedicated Git branch and persistent worktree. The controller commits each nonempty turn first, then runs project-owned commands and repairs or reverses failures that become visible.

The central rule is:

> Create a recoverable checkpoint, observe what happened, and repair or reverse failures when they become visible.

Checkpoint commits are provisional recovery points. They are not approvals, completion certifications, or claims that every configured command passed. The autonomous branch may be temporarily broken. `status` therefore reports the current branch head separately from the last known-good anchor.

Recovery Loop has one coding-agent role. There is no planning agent, review agent, admission gate, or internal product judge. An agent completion claim, command health, and external correctness are separate facts:

- `goal_complete` means only that the coding agent believes the goal is satisfied.
- A known-good anchor means the complete configured smoke and deep command sets passed at that exact commit.
- Recovery Loop does not determine external or overall product correctness.

Recovery Loop never automatically pushes, merges into the operator branch, opens a pull request, deploys, publishes, releases, or contacts project services. The operator evaluates the autonomous branch and decides what happens outside it.

## Requirements

- Node.js 24 or newer
- pnpm 10
- Git
- A local, non-bare Git repository
- An authenticated Codex environment when `recovery-loop run` invokes the configured model
- Safe, deterministic, noninteractive local commands for smoke and deep feedback

The coding agent runs in the autonomous worktree with workspace-only writes, `never` approvals, command network disabled, web search disabled, and no additional writable directories. The model-provider connection used by the SDK is distinct from command network access inside the coding turn.

## Install from this repository

```text
pnpm install --frozen-lockfile
pnpm build
pnpm link --global
```

The package is deliberately not published by this project. You may instead invoke `dist/cli.js` directly after building.

## Adopt a repository

Start in the operator's normal checkout. It must be clean when the workspace is created.

```text
recovery-loop init
```

If the adopting contract is missing, the first invocation creates these files and exits without creating a branch or runtime state:

```text
RECOVERY_GOAL.md
.recovery-loop/config.json
```

Edit both files. Replace the example commands with safe commands that describe meaningful project health, review the configured model, and commit the two files. Then run initialization again:

```text
git add RECOVERY_GOAL.md .recovery-loop/config.json
git commit -m "configure Recovery Loop"
recovery-loop init
```

Initialization creates `recovery-loop/work` at the selected baseline and a persistent linked worktree outside the operator checkout. By default, a repository named `project` uses a sibling path named `.project-recovery-loop/worktree`. Use `--base <revision>` or `--worktree <path>` to choose explicit values.

Initialization runs the optional prepare command, then complete smoke and deep sets. A full pass establishes the baseline as known-good. A failing baseline is still initialized, but it has no known-good rollback anchor and begins future `run` work at the pending recovery boundary.

Inspect the result and start the controller:

```text
recovery-loop status
recovery-loop run
```

See [Adopting a project](docs/adopting-project.md) for every configuration field and check-command obligation.

## Commands

Recovery Loop intentionally has exactly four commands.

### `recovery-loop init`

```text
recovery-loop init [--base <revision>] [--worktree <path>]
```

Scaffolds missing authority files or initializes the branch, worktree, state, and baseline command health. It refuses an existing unrelated branch or worktree and never moves the operator checkout.

### `recovery-loop run`

```text
recovery-loop run
  [--max-agent-turns <n>]
  [--max-checkpoints <n>]
  [--max-minutes <n>]
```

Starts or resumes the durable loop. `run` reconciles interrupted state, finishes pending recovery before ordinary work, checkpoints nonempty agent turns before smoke checks, schedules deep checks, and stops at goal candidacy, a configured budget, repeated nonprogress, or a narrow hard boundary. There is no separate resume command.

### `recovery-loop status`

```text
recovery-loop status [--json]
```

Reads state, refs, current command health, localization, recovery history, lock ownership, budget consumption, and recent events. It does not acquire the mutating lock, initialize state, change Git, or write any file. Human output labels the current branch tip as potentially unhealthy and labels known-good as the last complete smoke-plus-deep pass. `--json` emits a schema-versioned snapshot with the same separation.

### `recovery-loop check`

```text
recovery-loop check [--deep]
```

Runs configured commands at the exact durable autonomous head without invoking the agent. The default runs the complete smoke set. `--deep` runs complete smoke and deep sets; only a full exact-head pass can advance known-good and clear a pending command failure. A failed invocation preserves the pending failure and exits nonzero.

Use `recovery-loop --help` or `recovery-loop <command> --help` for complete command help.

## How the loop behaves

1. Reconcile the runtime journal, autonomous ref, and persistent worktree.
2. Finish any pending diagnosis, repair, revert, or rollback before ordinary work.
3. Invoke the single coding role for one useful unit.
4. Create one controller-owned checkpoint before project checks run.
5. Run smoke commands at that exact commit.
6. Run deep commands only when cadence, elapsed time, change risk, recovery, completion, or an explicit operator request requires them.
7. On confirmed failure, reproduce and localize conservatively, attempt forward repair, then try a clean revert, then create and verify a rescue ref before hard rollback.
8. Continue from a recoverable state or stop with exact pending evidence.

Failed work and failed repair checkpoints normally remain visible. A clean revert preserves later useful commits. Hard rollback is the last fallback and preserves the abandoned old head under `recovery-loop/rescue/<session>-<sequence>` before resetting only the autonomous branch.

See [Architecture](docs/architecture.md) for authority, state, check scheduling, and recovery details.

## Runtime data and summaries

Tracked adopting-project authority consists only of:

```text
RECOVERY_GOAL.md
.recovery-loop/config.json
```

Runtime data lives under the Git common directory:

```text
.git/recovery-loop/
  state.json
  controller.lock
  events.jsonl
  runs/<session>/agent/
  runs/<session>/checks/
  runs/<session>/diagnoses/
  runs/<session>/summary.json
```

`state.json` is atomically replaced and is semantic recovery state. `events.jsonl` and command/agent logs are diagnostic. A final summary records measurements such as checkpoints, command executions, repairs, reverts, rollbacks, usage, the final head, the known-good anchor, the agent's completion belief, and whether the final head received a deep pass. It explicitly records that external correctness was not evaluated and never assigns a product-success score.

## Safety and operating limits

Ordinary compilation failures, failing tests, incomplete changes, and later regressions are expected recovery inputs and may enter branch history. Checkpoint creation is blocked only at boundaries that threaten recovery or consequences outside ordinary source control, including protected authority edits, high-confidence credentials or private keys, changed symlinks or gitlinks, path escape, unsafe Git operation state, canonical branch ambiguity, and inability to persist a commit or state.

Adopting-project commands run locally and are trusted operator configuration. They must not deploy, publish, delete remote data, alter infrastructure, require credentials, or contact production services. Recovery Loop does not provide a general sandbox for project-owned checks.

Rescue refs are never deleted automatically. Runtime state cannot be reconstructed perfectly if it is manually removed. Localization is bounded, first-parent, and conservative: uncertain evidence produces a regression window, never a fabricated first-bad commit.

## Opt-in live canary

Ordinary and acceptance tests use a deterministic scripted SDK seam and make no model or network call. Before the first release tag, an operator may explicitly run the disposable production-controller canary:

```powershell
$env:RECOVERY_LOOP_RUN_LIVE_AGENT = "1"
$env:RECOVERY_LOOP_LIVE_MODEL = "gpt-5.6-sol" # optional override
pnpm demo:live
```

The canary contacts the configured model provider, creates a temporary real Git repository, and requires the production controller to produce both a useful work checkpoint and a repair checkpoint. The agent's command network and web search remain disabled. The temporary repository is removed afterward. The canary never pushes, merges, deploys, or publishes.

## Development and release acceptance

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm test:acceptance
pnpm build
```

The deterministic suite uses temporary real Git repositories and covers normal checkpointing, delayed regressions, forward repair, clean revert, verified rescue/reset, interruption recovery, destructive boundaries, initialization, status, JSON-safe snapshots, and manual checks. The live canary is opt-in and is not part of ordinary CI.

For the exact coding-role authority, see [Coding-agent contract](docs/agent-contract.md).
