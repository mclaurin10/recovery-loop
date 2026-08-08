# Recovery Loop Stage 10 Handoff

## Implemented

Stage 10 completes the smallest usable Recovery Loop v0.1 operator product without widening its architecture or external-action boundary. The four planned commands now have complete help and production behavior; status and summaries present the current autonomous head, command-relative known-good anchor, agent completion belief, final command health, and external correctness as distinct facts; a fresh repository can be adopted from generated templates plus the README; deterministic release acceptance includes the operator surface; and an explicitly opt-in live production-controller canary is available for the pre-tag external validation boundary.

The implementation includes:

- complete root and per-command help for exactly `init`, `run`, `status`, and `check`;
- production `init` orchestration for template scaffolding, tracked config validation, isolated branch/worktree creation, durable state, optional prepare, and baseline smoke/deep health;
- production `check` orchestration for exact-head complete smoke sets and optional complete smoke-plus-deep sets without an agent;
- a schema-versioned status snapshot plus human rendering with head/anchor ancestry distance, command health, pending/localization evidence, recovery history, lock ownership, usage, recent events, and next action;
- byte-for-byte read-only `status` behavior with no lock acquisition;
- final run-summary rendering that separates agent completion belief, command health, and unevaluated external correctness;
- explicit `externalCorrectnessEvaluated: false` and `externalCorrectness: null` measurement fields in persisted session summaries;
- `README.md`, `docs/architecture.md`, and `docs/adopting-project.md` as the complete operator/adoption documentation set;
- updated agent-contract wording for provisional checkpoints, temporary broken history, and external-evaluation separation;
- a concrete generated model default while retaining model names as configuration strings and `networkAccess: false` as an exact validation boundary;
- a deterministic five-scenario Stage 10 operator acceptance file;
- an opt-in disposable live canary that uses the unchanged production controller and requires both a useful work checkpoint and a repair checkpoint;
- a `demo:live` package script gated by `RECOVERY_LOOP_RUN_LIVE_AGENT=1`;
- a final architecture, dependency, external-action, command-surface, documentation-claim, and production-size audit.

There is still one coding-agent role. The controller remains the sole owner of commits, reverts, rescue refs, resets, branch/worktree operations, command health, pending-failure clearing, and known-good promotion. No planning, review, localization, verifier, completion-judge, or separate repair agent was added.

## Final four-command surface

The compiled root help exposes only:

```text
recovery-loop init
recovery-loop run
recovery-loop status
recovery-loop check
```

Each command accepts only the implementation-plan flags:

```text
recovery-loop init [--base <revision>] [--worktree <path>]
recovery-loop run [--max-agent-turns <n>] [--max-checkpoints <n>] [--max-minutes <n>]
recovery-loop status [--json]
recovery-loop check [--deep]
```

No symmetry commands were added. In particular, there is no CLI command for planning, review, approval, integration, reconciliation, retention, canary operation, diagnosis, or rollback. Startup diagnosis and recovery remain ordinary `run` behavior. The live canary is a repository development script, not an installed Recovery Loop command.

## Initialization behavior

`init` opens the local non-bare repository and first calls the existing non-overwriting scaffold boundary. If either authority file is missing, it creates only the missing templates and exits. It creates no autonomous branch, worktree, state file, or controller lock in that scaffolding outcome. The output instructs the operator to edit, configure safe commands, commit the authority files, and rerun initialization.

When the authority files already exist, `init`:

1. resolves `--base` or current `HEAD`;
2. loads and validates the tracked config at that exact commit;
3. derives the configured or default external persistent-worktree path;
4. takes the mutating `init` lock;
5. calls the existing journaled workspace initializer;
6. creates only the configured `recovery-loop/` branch and linked worktree;
7. records and finishes a distinct initialization session;
8. runs configured prepare when present;
9. runs complete baseline smoke and deep sets through the existing journaled check runner;
10. reports the baseline, worktree, known-good anchor, and any pending failure.

Initialization retains the existing Git preflight: the operator checkout must be clean, tracked authority must exist at the selected baseline, an existing branch/worktree is not overwritten, and the operator branch/head is verified unchanged.

A successful prepare plus complete smoke/deep pass establishes the baseline as known-good. A failed prepare is classified as infrastructure (or safety when applicable), complete smoke and deep observations are still collected, known-good is not promoted, and the exact prepare failure becomes the pending health boundary. An unhealthy baseline remains a valid initialized workspace with no fabricated rollback anchor.

The generated config now uses `gpt-5.6-sol` as its concrete default model string. This was selected through the current official OpenAI model resolver during Stage 10; it remains ordinary adopting-project configuration rather than a core enum. Operators are told to review the model against their authenticated environment. The pinned SDK dependency remains `@openai/codex-sdk` `0.147.0`.

## Manual check behavior

`check` acquires the single mutating lock but never constructs or invokes an agent gateway. It validates state/repository identity, refuses a pending revert/reset action, requires an idle or normally stopped journal, loads tracked configuration at the durable expected head, opens the configured persistent worktree, verifies exact branch/head identity and cleanliness, then calls the sole command-health authority.

Default behavior runs every configured smoke command. `--deep` records an explicit operator deep reason, runs every smoke command and every deep command, and can advance known-good or clear a pending command failure only through the unchanged complete exact-head promotion rules. Requested command failure is rendered, persisted, and exits nonzero.

A previously stopped session is temporarily made command-runnable and restored to `stopped` after a completed check. An interrupted journal remains intact for `run` rather than being erased by cleanup. A non-idle interrupted phase directs the operator to `run` for normal reconciliation.

Smoke-only success does not falsely clear a prior deep failure or establish known-good. Complete deep success remains the necessary health boundary.

## Read-only status and JSON

`status` still constructs only `GitRepository` and `StateStore` readers. It never calls `acquireLock`, `initialize`, `update`, event append, command execution, worktree mutation, or Git mutation.

The schema-versioned snapshot now reports:

- session ID, status, start, stop reason, and phase;
- autonomous branch, actual head, durable expected head, and match/mismatch;
- baseline;
- known-good anchor;
- known-good relation to actual head (`none`, `at-head`, `behind-head`, `not-ancestor`, or `head-missing`);
- commit distance from known-good to current head when ancestry permits;
- last smoke and deep command-set status plus latest command classification;
- complete current pending failure and localization state;
- pending recovery action, repair/cycle counts, reverts, hard rollbacks, abandoned ranges, and rescue refs;
- current lock snapshot, including malformed or valid owner information;
- agent/token/check usage, session checkpoint count, and elapsed time;
- the five most recent events;
- the next deterministic controller action.

Human rendering explicitly labels:

```text
current head (autonomous branch tip; may be unhealthy)
known-good anchor (last complete smoke+deep pass)
```

The existing real-runtime test still compares `state.json` byte-for-byte and the runtime directory entry list before and after `readStatusSnapshot`. Stage 10 acceptance repeats that invariant after healthy production initialization and also verifies that the snapshot is JSON-safe.

## Final summary semantics

The persisted measurement summary retains all Stage 7-9 counts and adds:

```json
{
  "agentCompletionBelief": true,
  "finalHeadReceivedDeepPass": true,
  "externalCorrectnessEvaluated": false,
  "externalCorrectness": null
}
```

The booleans above are independent. An agent may report completion without a final deep pass, a final head may receive configured command health without proving the full product, and Recovery Loop never fills the external-correctness field. There is still no internally calculated product-success score.

The human stop output renders the final current branch head, known-good anchor, agent completion claim, final configured command health, explicit lack of external correctness evaluation, recovery measurements, and the durable summary path.

## Documentation and fresh adoption

`README.md` is now the release entry point. It covers prerequisites, local installation, the two-pass scaffolding/initialization flow, the four commands, checkpoint-before-check philosophy, temporary broken branch history, current-head/known-good semantics, runtime layout, recovery order, safety boundaries, external-action prohibition, deterministic validation, and the opt-in live canary.

`docs/adopting-project.md` supplies the complete schema-v1 configuration example and explains every command/check/path/model/limit obligation, safe local command requirements, prepare behavior, deep scheduling, baseline health, status, evaluation, and operational recovery. A fresh operator can configure and initialize a repository from the README and generated templates without relying on implementation handoffs.

`docs/architecture.md` maps actual production modules to the direct six concerns, documents authority and persistence, explains command-relative health and deterministic recovery, and records deliberate v0.1 limitations. It explicitly states that the Stage 10 operator module is presentation/direct command orchestration rather than another controller or agent.

All release-facing documentation says checkpoint history may be temporarily broken and that checkpoints are recovery points rather than approvals or verification claims. No release-facing documentation implies every checkpoint is approved or verified.

## Deterministic Stage 10 coverage

`tests/acceptance/operator-surface.test.ts` adds five real-temporary-repository scenarios:

1. missing authority is scaffolded without branch or runtime-state creation;
2. healthy initialization preserves the operator branch/head, establishes baseline health, and exposes a truthful JSON-safe read-only status snapshot;
3. manual complete smoke/deep checking invokes no agent and restores a stopped session phase;
4. failed baseline prepare becomes infrastructure pending health and cannot promote known-good even when smoke/deep themselves pass;
5. run-summary rendering keeps completion belief, command health, and external correctness separate.

The unit CLI suite now verifies complete help for all four commands and rejects every deferred command literal. The controller integration suite verifies the persisted external-correctness fields. Template coverage verifies the concrete generated model and disabled network setting.

The complete deterministic matrix retains all Stage 1-9 real-Git behavior, including delayed regression, exact/conservative localization, forward repair, clean revert, rescue-before-reset, abandoned direction, interruption convergence, protected authority, secrets, symlink/gitlink boundaries, controller ownership, command mutation handling, lock contention, and read-only status.

## Opt-in live canary

`pnpm demo:live` is gated by:

```text
RECOVERY_LOOP_RUN_LIVE_AGENT=1
```

Without that exact opt-in the Vitest case is skipped before creating a gateway or contacting a model provider. With opt-in, it:

1. creates a disposable real Git repository;
2. installs a tracked goal, guarded local canary predicate, safe smoke/deep config, and selected model;
3. initializes through the ordinary journaled workspace boundary;
4. invokes `runNormalController` with the production `CodexAgentGateway` and no test-only controller hooks;
5. requires a controller-owned `work` checkpoint;
6. uses the fixture's deterministic post-checkpoint predicate to enter ordinary confirmation/localization/recovery;
7. requires a controller-owned `repair` checkpoint;
8. asserts the requested useful and repair artifacts and measurement summary;
9. deletes the disposable repository.

The live canary was **not executed during this Stage 10 task**. Doing so would contact the configured external model provider, while the task explicitly preserved the external-contact prohibition and supplied no opt-in authorization. It remains a documented precondition for the first release tag and must be run by an operator who explicitly sets the gate in an authenticated environment. This is not represented as a passing result in the release evidence below.

The agent's command network, web search, approval, sandbox, and writable-directory restrictions remain unchanged during the live canary. It never pushes, merges, deploys, publishes, or contacts project services.

## Validation

Validation environment:

- Node.js `v25.9.0`
- pnpm `10.33.0`
- Git `2.54.0.windows.1`

Final required command results, run in the implementation-plan order:

| Command | Result |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm test` | PASS - 17 files, 179 tests, 653.01 seconds |
| `pnpm test:acceptance` | PASS - 17 files, 179 tests, 639.99 seconds |
| `pnpm build` | PASS |

`git diff --check` also passed. The compiled `dist/cli.js` root help and all four per-command help paths were executed successfully after the final build.

No live model, provider network, project-service network, credential, push, pull, merge, deployment, publication, or release operation occurred during deterministic validation.

## Architecture and scope audit

Final production counts:

- 15 TypeScript modules;
- 7,625 physical lines;
- 7,547 nonblank lines.

Stage 9 ended at 14 modules, 7,060 physical lines, and 6,988 nonblank lines. Stage 10 adds one module, 565 physical lines, and 559 nonblank lines.

Stage 10-specific production changes are:

- `src/operator-surface.ts`: 463 physical / 459 nonblank lines for direct `init`, `status`, `check`, and human-summary orchestration/rendering;
- `src/cli.ts`: 292 physical / 290 nonblank lines, up 19/17 lines while adding complete help and final dispatch;
- `src/health-controller.ts`: 674 physical / 674 nonblank lines, up 81 lines for baseline prepare health and the explicit complete manual-check entry point;
- `src/controller.ts`: 370 physical / 360 nonblank lines, up 2/2 lines for explicit external-correctness measurements.

The repository remains above the plan's rough 11-module, 600-line-per-module, and 5,000-line production tripwires. The required concrete Stage 10 justification is:

1. Stage 9 already ended at 14 modules and 7,060 physical lines because restart-safe localization and revert/reset action policy were kept as cohesive direct modules rather than a workflow framework.
2. A first Stage 10 implementation placed the complete operator surface in `src/cli.ts` and measured 727 physical lines. Splitting pure parsing/dispatch from direct operator orchestration/rendering produces a 292-line CLI and a 463-line operator module. The split adds no role, provider, workflow, state machine, persistence layer, or command; it prevents one oversized mixed presentation/orchestration file.
3. Manual and initialization command health stays inside `src/health-controller.ts`, the sole existing known-good authority. Its 81-line growth avoids duplicating exact-head smoke/deep promotion, pending-failure, prepare classification, and command-journal policy in the operator module. Moving that behavior merely to satisfy a physical count would create architectural health leakage.
4. Stage 10 adds only 565 physical production lines while making both deferred commands real, completing the planned status/JSON surface, and preserving exact health semantics. Further compression would primarily erase explicit output contracts, state restoration, or failure classification rather than remove a subsystem.

The final module table is:

| Module | Physical | Nonblank |
| --- | ---: | ---: |
| `agent-gateway.ts` | 367 | 367 |
| `check-runner.ts` | 624 | 624 |
| `cli.ts` | 292 | 290 |
| `config.ts` | 307 | 307 |
| `contracts.ts` | 848 | 848 |
| `controller.ts` | 370 | 360 |
| `git-operations.ts` | 721 | 721 |
| `git-repository.ts` | 669 | 669 |
| `health-controller.ts` | 674 | 674 |
| `operator-surface.ts` | 463 | 459 |
| `recovery.ts` | 621 | 598 |
| `recovery-actions.ts` | 329 | 318 |
| `recovery-fallback.ts` | 605 | 577 |
| `safety.ts` | 319 | 319 |
| `state-store.ts` | 416 | 416 |

Static leakage results:

- no `Milestone`, `Planner`, `Reviewer`, `Admission`, `VerificationTier`, `Receipt`, or `ReconciliationController` vocabulary exists in production TypeScript;
- no extra/deferred CLI command literal exists in `src/cli.ts`;
- no production Git invocation performs push, pull, merge, rebase, cherry-pick, tag creation, or publication/integration;
- production process creation remains limited to Git, configured local argv commands, and Windows process-tree termination;
- no production HTTP, HTTPS, `fetch`, `curl`, deployment, or publication client exists;
- `@openai/codex-sdk` `0.147.0` remains the only runtime dependency;
- `src/agent-gateway.ts` remains the sole production SDK import;
- the gateway's `workspace-write`, `never`, network-disabled, web-disabled, and empty-additional-directory settings are unchanged from Stage 9;
- model strings remain configuration values;
- there is one coding role and no generic provider/plugin abstraction, abstract base class, workflow/state-machine library, database, dashboard, benchmark judge, product-success score, or external-service integration;
- `pnpm-lock.yaml` did not change.

## Final v0.1 boundary

Stage 10 does not add any later-roadmap feature. There is no automatic target-branch integration, push, pull request, deployment, publication, release, remote CI, external evaluator, dashboard, adaptive scheduler, multiple agent, debate, semantic review, general dependency analysis, automatic rescue cleanup, automatic abandoned-work salvage, provider framework, distributed execution, state migration, or artifact-retention subsystem.

The completed deterministic product can be adopted, initialized, inspected, run, manually checked, interrupted, resumed, localized, repaired, reverted, and rescue-reset entirely on local Git state with one coding role. Its current head may be broken; its known-good anchor is only configured command health; its final summary is measurement, not certification; and every external use or release decision remains with the operator.

The only outstanding pre-tag activity is the explicitly opt-in external live canary described above. It is outside deterministic completion and was intentionally not contacted automatically.
