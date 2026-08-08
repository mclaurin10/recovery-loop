# Coding-agent contract

Recovery Loop has one coding-agent role. The same role chooses and implements ordinary work and repairs confirmed failures; there is no Planner, Reviewer, approval agent, or independent completion judge.

The agent may inspect the autonomous worktree, choose one coherent checkpoint-sized improvement, edit source/tests/docs/local tooling, and run local diagnostic commands. It must not create or rewrite Git history, manipulate branches or worktrees, push or publish, contact external services, request credentials, edit `RECOVERY_GOAL.md` or `.recovery-loop/config.json`, modify runtime state, deploy, or write outside the autonomous worktree.

The production gateway runs Codex with the autonomous worktree as its working directory, `workspace-write` sandboxing, `never` approvals, command network disabled, web search disabled, no additional writable directories, and the configured model/effort strings. The controller remains responsible for checkpointing, descendant-commit normalization, safety guards, and checks.

## Turn outcomes

Every completed turn must return exactly:

```json
{
  "outcome": "changed | no_change | goal_complete | blocked",
  "summary": "one concise description",
  "nextHint": "optional direction or null",
  "blocker": "hard blocker or null"
}
```

- `changed` reports a useful source outcome. The Git boundary still inspects actual files and history.
- `no_change` reports that the turn found no useful edit.
- `goal_complete` is the agent's completion belief. It is only an observation and cannot advance health.
- `blocked` requires a nonempty blocker and is reserved for credentials, unavailable required external services, contradictory authority, or destructive risk.

The agent's statements about tests, correctness, or completion never count as check results. Only configured commands run by the existing check boundary can record smoke/deep observations or advance the known-good anchor.

## Threads and recovery

One persisted thread is resumed until a deterministic rotation boundary is reached: eight turns, hard rollback, an agent-created history violation, the configured repair-attempt limit, an explicit forced rotation, or SDK resume failure. A failed resume starts a fresh thread and reconstructs context from the goal, current Git history, durable state, recent events, health, abandoned ranges, and budgets. Conversation history is an optimization, never a recovery dependency.

Recovery mode adds the exact failing command, normalized result, complete log paths, known-good/current commits, localization evidence, prior repair summaries, and the controller's fallback posture to the same coding role.

## Checkpoints and external correctness

The controller commits safe nonempty work before it runs configured project checks. The autonomous branch may therefore be temporarily broken, and failed work or repair checkpoints may remain visible in history. A checkpoint is a recoverable source state, not an approval or verification claim.

The controller's known-good anchor is command-relative: it names the exact commit at which complete configured smoke and deep sets passed with a clean exact head. It is not an external correctness certification. Final summaries keep the agent's completion belief, final command health, and external evaluation separate; Recovery Loop performs no external product judgment.

Neither the agent nor the controller may automatically push, merge into the operator branch, open a pull request, deploy, publish, release, or contact project services. Those actions remain outside the loop and require a separate operator decision.
