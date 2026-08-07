# Stage 6 Handoff: Coding-Agent Gateway

Stage 6 adds one narrow coding-agent boundary. It does not add the autonomous `run` loop, automatic checkpoints or checks, repair policy, regression localization, rollback, or any additional agent role.

## Implemented

- `src/agent-gateway.ts` is the only production module that imports the coding-agent SDK.
- `@openai/codex-sdk` is pinned exactly at `0.147.0` in `package.json` and the pnpm lockfile.
- `CodexAgentGateway` runs one coding role in the durable autonomous worktree and supports:
  - work mode, where the coding agent selects and implements the next useful repository change;
  - recovery mode, where the same coding agent receives exact failure evidence and repairs it;
  - new threads, resumed threads, deterministic rotation, and resume-failure fallback;
  - streamed event persistence, timeout/cancellation, usage capture, and validated final responses.
- The four-outcome response contract is enforced locally after SDK schema enforcement: `changed`, `no_change`, `goal_complete`, and `blocked`. Invalid JSON, unknown fields/outcomes, missing fields, and invalid blocker combinations are rejected.
- `decideThreadAction` exposes deterministic start/resume/rotation decisions without implementing the Stage 7 loop. Rotation occurs for a forced request, hard rollback, an agent-history violation, the configured repeated-repair boundary, or eight completed turns on one thread.
- The existing durable state and event journal record agent intent, phase, thread identity, turn counts, usage, completion, failure, and rotation.
- `docs/agent-contract.md` documents the single-role prompt contract and the controller/agent authority boundary.

## SDK and containment decisions

The gateway uses the stable TypeScript SDK package `@openai/codex-sdk@0.147.0`. Model names remain ordinary configuration strings; the gateway does not introduce a model enum or hardcoded model default.

Each invocation uses the most restrictive SDK-supported settings compatible with editing source in the worktree:

- working directory: the configured durable autonomous worktree, after repository/branch/HEAD identity checks;
- sandbox: `workspace-write` (`read-only` cannot perform the required source edits);
- approval policy: `never`, so execution is noninteractive;
- network access: disabled;
- web search: disabled through both SDK-supported controls;
- additional writable directories: none;
- login-shell environment capture: disabled;
- subprocess environment inheritance: SDK `core` variables only, with normal sensitive-variable exclusions retained;
- apps, goals, hooks, memories, multi-agent support, the network proxy, remote plugins, and automatic skill/MCP dependency installation: disabled in invocation configuration;
- configured MCP servers and plugins: empty at this boundary.

The gateway never passes process environment variables or credentials into invocation metadata. Persisted SDK events, errors, and final responses are recursively sanitized for environment/credential field names and common secret-shaped values. Prompts are not copied into invocation metadata.

## Invocation, logging, timeout, and usage semantics

Every turn receives a unique directory under:

```text
runs/<session-id>/agent/<turn-id>/
  invocation.json
  events.jsonl
  final-response.json
```

`invocation.json` records the SDK/version, mode, requested model and effort, worktree, containment settings, timeout, requested thread action and rotation reason, resulting thread ID, timing, terminal status, and usage. It deliberately excludes environment variables, credentials, and the prompt. `events.jsonl` receives each streamed SDK event as it arrives, tagged with the fresh/resume attempt. `final-response.json` is written only after the response passes the local contract validator.

The configured agent timeout and caller cancellation share an abort controller. A separate abort race prevents a non-cooperative SDK stream from hanging the controller after cancellation. Timeout, cancellation, malformed output, and other failures remain journaled as incomplete agent operations so the existing startup reconciliation path can resolve them after a crash or restart.

SDK usage is captured from `turn.completed`. Input, cached-input, output, and cache-write tokens are written to the invocation record. The first three are accumulated in the existing durable-state counters; the Stage 1 state schema has no cache-write aggregate counter, so that value remains per invocation.

## Thread semantics

- A fresh invocation starts a thread and persists its ID immediately when `thread.started` is observed.
- An ordinary invocation resumes the persisted thread.
- A requested or boundary-triggered rotation clears the old thread and starts a new one with reconstructed goal, repository, durable-state, recent-event, recent-commit, known-good, failure, abandoned-range, and remaining-budget context.
- If `resumeThread` or the resumed stream fails before `turn.started`, the gateway records the failed resume attempt and deterministically retries once on a fresh reconstructed thread.
- Once a resumed turn has started, the gateway does not replay it on another thread because doing so could duplicate edits.
- Timeout and caller cancellation never trigger a fallback retry.

Both work and recovery use this same coding role. Recovery mode requires exact failed check, command, exit, output-tail, and attempt evidence. Agent prose and the declared outcome are observations only: neither can set smoke/deep check success or advance known-good state.

## Git and safety authority

The gateway does not create checkpoints or own commits, branches, resets, worktrees, reverts, rollback, or other Git-history operations. Tests exercise its output through the existing journaled Git boundary:

- an agent-created descendant commit is normalized into the controller-owned checkpoint and rescue-ref path;
- an edit to protected authority (`RECOVERY_GOAL.md`) is rejected before checkpoint creation;
- a response claiming checks passed cannot make a failing smoke command pass or advance known-good state.

This preserves Stage 5 scheduling, health, pending-failure, and known-good behavior unchanged.

## Tests

Normal tests use a narrow deterministic scripted SDK fake and make no model calls. The Stage 6 suite adds 20 tests covering:

- work-mode source edits;
- `no_change`, `goal_complete`, and valid `blocked` responses;
- malformed structured output;
- timeout and caller cancellation;
- streamed event/log persistence and credential redaction;
- usage collection;
- thread creation, successful resumption, resume fallback, and forced/boundary rotation;
- network-disabled, web-disabled, noninteractive, workspace-only SDK options and disabled auxiliary features;
- exact recovery evidence supplied to the same coding role;
- descendant-commit normalization through the existing journaled checkpoint boundary;
- protected-authority rejection before checkpoint;
- check results remaining independent of agent prose.

`tests/live/agent-gateway.live.ts` is an opt-in disposable-repository smoke test. It is outside the normal Vitest include pattern and requires both `RECOVERY_LOOP_RUN_LIVE_AGENT=1` and `RECOVERY_LOOP_LIVE_MODEL`. `pnpm test:agent-live` was verified to skip when those variables are absent; no paid model execution is part of CI.

Final validation on Node.js `v25.9.0`, pnpm `10.33.0`, and Git `2.54.0.windows.1`:

| Command | Result |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm test` | PASS — 12 files, 123 tests |
| `pnpm test:acceptance` | PASS — 12 files, 123 tests |
| `pnpm build` | PASS |

The Vitest per-test/hook ceiling is 30 seconds so parallel real-Git tests remain reliable on Windows; production agent timeout behavior still uses `agentTimeoutSeconds` and is tested at its one-second minimum.

## Architecture audit

- Production remains at 11 TypeScript modules and 4,999 physical lines (4,691 nonblank lines).
- `src/agent-gateway.ts` is 356 physical lines, below the per-module ceiling.
- The SDK package has one production import site.
- `init`, `run`, and `check` remain deferred CLI commands; `status` remains read-only.
- There is no autonomous loop, work selector outside the prompt, automatic checkpoint/check cycle, failure-confirmation orchestration, forward-repair policy, regression localization, revert policy, benchmark layer, generic provider/workflow framework, evidence receipt/admission tier, or external-service action.

## Limitations

- Stage 6 exposes a single-turn gateway; a caller must still sequence turns, checkpoints, and checks.
- Resume fallback is intentionally limited to failures before a resumed turn starts.
- OS sandboxing and process termination are provided by the pinned SDK/CLI boundary; the deterministic suite verifies the requested SDK options and controller-side timeout behavior. Real-SDK execution remains explicitly opt-in.
- Secret sanitization is defense in depth, not a substitute for keeping secrets out of agent output.
- Cache-write token usage is not aggregated because the established durable-state schema has no corresponding counter.

## Stage 7 starting point

Stage 7 should implement the normal autonomous loop under the existing controller lock and startup reconciliation. It should call this gateway for one turn, treat the validated outcome as an observation, route changed work through the existing safety and journaled checkpoint boundary, and schedule smoke/deep checks using the unchanged Stage 5 policy. It should also feed history-normalization results into the exposed rotation decision and honor budgets and signals.

Stage 7 should not absorb recovery policy, repeated-failure confirmation, regression localization, or rollback; those remain later stages in the implementation plan.
