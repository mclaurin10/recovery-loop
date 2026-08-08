# Adopting a project

This guide is the adopting-repository contract for Recovery Loop v0.1. The controller is an external CLI; do not copy its source or runtime state into the project being developed.

## Before initialization

The adopting repository must be a local, non-bare Git repository. Its operator checkout must be clean when the autonomous branch and worktree are created. The baseline may be any resolvable commit, but it must contain tracked versions of:

```text
RECOVERY_GOAL.md
.recovery-loop/config.json
```

Run `recovery-loop init` once to generate templates when either file is absent. Template generation exits before creating an autonomous branch or runtime state. Edit and commit both files, then run `init` again.

The controller never changes the operator branch or checkout after initialization. All coding work occurs on the configured branch in a linked worktree outside the operator checkout.

## Write the product goal

`RECOVERY_GOAL.md` is operator-owned authority. A useful goal includes:

- the desired end product or improvement;
- important starting state not obvious from the repository;
- concrete required outcomes;
- technology, compatibility, legal, and operational constraints;
- explicit non-goals;
- observable signals that may justify the agent reporting `goal_complete`;
- project-specific stop-only boundaries involving data, credentials, remote systems, or consequences outside ordinary Git recovery.

Describe outcomes rather than prescribing every implementation step. The single coding role is expected to choose technical work and make ordinary reversible engineering decisions autonomously.

The agent may not edit the goal. A protected-authority change is rejected before checkpointing, followed by one correction opportunity; persistent violation stops the loop.

## Configure the controller

The generated `.recovery-loop/config.json` is valid JSON with schema version 1. Unknown top-level fields fail validation so misspellings do not silently change policy.

The generated file is the canonical complete example:

```json
{
  "schemaVersion": 1,
  "goalFile": "RECOVERY_GOAL.md",
  "branch": "recovery-loop/work",
  "prepare": null,
  "checks": {
    "smoke": [
      {
        "id": "typecheck",
        "argv": ["pnpm", "typecheck"],
        "timeoutSeconds": 300
      }
    ],
    "deep": [
      {
        "id": "full-test",
        "argv": ["pnpm", "test"],
        "timeoutSeconds": 1800,
        "bisectable": true
      }
    ]
  },
  "deepPolicy": {
    "everyCheckpoints": 5,
    "maxMinutes": 30,
    "changedFileThreshold": 20,
    "changedLineThreshold": 1000,
    "triggerPaths": ["package.json", "pnpm-lock.yaml"],
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
  "protectedPaths": ["RECOVERY_GOAL.md", ".recovery-loop/config.json"],
  "agent": {
    "model": "gpt-5.6-sol",
    "reasoningEffort": "high",
    "networkAccess": false
  }
}
```

Review the model string against the authenticated Codex environment before initialization. Model names are configuration strings, not a closed controller enum.

### Paths and branch

- `goalFile` identifies the one tracked goal file.
- `branch` must begin with `recovery-loop/`; `recovery-loop/work` is the default.
- Trigger and protected paths use normalized repository-relative forward-slash paths with no traversal.
- A protected path ending in `/` protects that directory prefix; without the trailing slash it protects only the file with that exact name. For example, use `docs/` for the directory, not `docs`.
- The goal file and `.recovery-loop/config.json` are protected even if omitted from `protectedPaths`.

The configured branch must not already exist. The chosen worktree path must not exist and must be outside both the operator checkout and Git common directory. Initialization refuses unrelated existing resources rather than overwriting them.

### Commands

Every command is an argument array. Shell strings are invalid.

```json
{
  "id": "typecheck",
  "argv": ["pnpm", "typecheck"],
  "timeoutSeconds": 300
}
```

Command IDs must be unique across smoke and deep sets. Timeouts must be positive, finite, and no greater than 2,147,483.647 seconds. Commands run sequentially, without an implicit shell, in the autonomous worktree, and communicate health through process exit status.

On Windows, package-manager commands such as `pnpm`, `npm`, and `yarn` are commonly installed as `.cmd` shims. Modern Node.js does not execute those shims directly with `shell: false`. Configure an executable wrapper explicitly, for example `["node", "node_modules/typescript/bin/tsc", "--noEmit"]`, or use an intentional Windows command wrapper such as `["cmd.exe", "/d", "/s", "/c", "pnpm", "typecheck"]`. Review any `cmd.exe` wrapper as a shell command and do not interpolate agent-controlled text. A command that cannot start is recorded as an infrastructure result rather than crashing the controller.

Recovery Loop captures complete stdout/stderr in local session logs, retains bounded redacted tails for diagnosis, enforces the configured timeout, and verifies that tracked source did not change. Ignored build output is allowed; tracked mutation makes the result invalid and is removed from the checked worktree.

An elapsed command timeout is classified as infrastructure evidence. Recovery Loop cannot reliably distinguish an agent-introduced infinite loop from a stalled tool or environment at this boundary, so choose timeouts and check granularity with that limitation in mind.

Project commands are trusted operator configuration. They must:

- run noninteractively;
- be safe to repeat;
- avoid prompts for credentials;
- avoid deployment, publication, remote deletion, infrastructure changes, and production-service contact;
- avoid changing tracked source;
- finish within a realistic timeout;
- have deterministic enough behavior for health and localization to be meaningful.

Recovery Loop does not place project-owned commands in a complete operating-system sandbox. Do not configure a command merely because it exists in CI; inspect its side effects first.

### Smoke commands

At least one smoke command is required. Smoke runs after every new checkpoint and should provide fast feedback. Good choices include type checking, compilation, focused unit tests, syntax/import validation, or a fast build smoke.

A checkpoint already exists when smoke starts. A smoke failure makes that commit known-bad and starts recovery; it does not erase the checkpoint. A smoke pass is sufficient to continue when no deep trigger is due.

### Deep commands

At least one deep command is required. Deep commands should detect broader or delayed regressions: full tests, integration tests, broader builds, static analysis, deterministic simulations, or local end-to-end suites.

Set `bisectable` to `true` only when running that command at historical commits provides a stable product pass/fail predicate. A flaky, externally dependent, or environment-sensitive command should not be marked bisectable. Commands not marked bisectable can still trigger recovery, but localization retains a proven regression window rather than claiming a unique first-bad commit.

### Prepare command

`prepare` may be `null`. Configure it when initialization or historical commits require a local environment step, such as installing locked dependencies:

```json
{
  "argv": ["pnpm", "install", "--frozen-lockfile"],
  "timeoutSeconds": 900,
  "triggerPaths": ["package.json", "pnpm-lock.yaml"]
}
```

The prepare command is subject to the same local-safety obligations. It runs before baseline smoke/deep checks and when configured recovery paths require environment preparation. A failed baseline prepare is recorded as infrastructure health, prevents known-good promotion, and does not become a false code-regression claim.

### Deep scheduling

Deep is due when any configured or fixed boundary applies:

- `everyCheckpoints` smoke-passing checkpoints accumulated since the last deep pass;
- `maxMinutes` elapsed since the last deep execution;
- a `triggerPaths` prefix changed;
- a checkpoint exceeded `changedFileThreshold` or `changedLineThreshold`;
- recovery completed when `afterRecovery` is true;
- the agent reported completion when `beforeGoalComplete` is true;
- the operator invoked `recovery-loop check --deep`;
- a normal stop is approaching and check budget remains.

Keep smoke cheap enough for every checkpoint and deep meaningful enough to establish a useful recovery anchor. Do not duplicate every deep command into smoke solely to make all commits green before they exist; that would defeat the recovery-first experiment.

### Limits

- `maxAgentTurns`: session bound for coding turns.
- `maxWallMinutes`: session wall-time bound.
- `maxRepairTurnsPerFailure`: forward-repair turns before revert/reset fallback.
- `maxRecoveryCyclesPerSignature`: recurrence bound for a normalized failure signature.
- `maxLocalizationCommits`: maximum first-parent search range.
- `agentTurnSeconds`: timeout for one SDK coding turn.

Timer-backed limits are capped to Node.js's safe timer range: `maxWallMinutes` and deep `maxMinutes` may not exceed 35,791, and `agentTurnSeconds` may not exceed 2,147,483.

`recovery-loop run` may impose lower limits on the current durable session with `--max-agent-turns`, `--max-checkpoints`, and `--max-minutes`. After a hard crash, the resumed run continues measuring the same session counters and original session start time. The flags cannot exceed tracked policy limits.

### Agent settings

`reasoningEffort` is one of `low`, `medium`, `high`, or `xhigh`. `networkAccess` must be `false` in v0.1; a true value fails configuration validation.

The gateway also fixes web search to disabled, approvals to `never`, sandbox mode to workspace-write, and additional writable directories to none. The coding role may inspect Git but may not commit, change refs, manipulate worktrees, push, publish, contact external services, request credentials, deploy, or alter infrastructure.

## Initialize and inspect baseline health

After committing the contract:

```text
recovery-loop init
recovery-loop status
```

Healthy initialization reports the baseline as both current head and known-good anchor. Unhealthy initialization reports no known-good anchor and an exact pending command failure. Both are valid initialized states; without an anchor, automatic hard rollback is unavailable until a later complete smoke/deep pass establishes one.

`status` is safe to call while another controller owns the lock. It reports the lock rather than taking it. `status --json` is appropriate for local inspection tooling and includes `schemaVersion: 1`.

## Run and evaluate the branch

```text
recovery-loop run
```

The branch history may contain a defect, later useful work, failed repairs, and a successful repair or revert. This visibility is intentional. Do not treat the newest checkpoint or an agent `goal_complete` response as an approved result.

Before using the branch outside Recovery Loop:

1. inspect `recovery-loop status` and the final session summary;
2. compare the current head with the known-good anchor;
3. inspect commit history, rescue refs, and any pending failure;
4. run independent project evaluation appropriate to the product;
5. make any push, pull-request, merge, release, deployment, or publication decision manually outside Recovery Loop.

Recovery Loop neither recommends nor performs that external action. Its final summary explicitly leaves external correctness unevaluated.

## Operational recovery notes

- `run` is the only resume operation. It reconstructs or continues interrupted agent, checkpoint, command, diagnosis, repair, revert, and reset work from state plus Git.
- `check` never invokes the coding agent. It refuses an unresolved pending revert/reset action and directs the operator to `run` first.
- Rescue refs use `recovery-loop/rescue/...` and are never automatically deleted.
- Runtime state lives under `.git/recovery-loop`; do not commit, edit, or delete it while a controller may resume.
- A malformed or foreign-host lock is not stolen automatically.
- The diagnostic worktree is disposable; the persistent autonomous worktree is not.
- If state or branch identity becomes ambiguous, preserve the repository and exact error rather than manually resetting refs.

For the implementation invariants behind these rules, see [Architecture](architecture.md) and [Coding-agent contract](agent-contract.md).
