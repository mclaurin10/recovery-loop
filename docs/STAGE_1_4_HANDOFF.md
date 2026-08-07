# Recovery Loop Stages 1–4 Handoff

## Implemented

Recovery Loop now has the deterministic recovery substrate described by Stages 1–4 of `docs/IMPLEMENTATION_PLAN.md`:

- Node 24+ TypeScript ESM package, pnpm lockfile, CLI parsing, exact handwritten contracts, tracked configuration validation, and goal/config templates.
- A dedicated `recovery-loop/*` branch and persistent linked worktree that must live outside the operator checkout and Git common directory.
- Controller-authored linear checkpoint commits, empty-change handling, descendant agent-commit normalization, diagnostic worktrees, clean revert, rescue refs, and rescue-before-reset rollback.
- Atomic `state.json` publication, phase/operation intent journal, repository identity binding, append-only events, session output layout, and an exclusive single-controller lock.
- Startup convergence for interrupted workspace creation, dirty work, checkpoint creation, checks, revert, and hard rollback.
- Read-only `status` state inspection that neither takes the mutating lock nor creates runtime files.
- Pre-checkpoint guards for protected authority, unsafe Git state, changed symlinks/gitlinks, runtime paths, path escapes, private-key blocks, and high-confidence credential formats.
- Shell-free argv command execution, sanitized environment, bounded timeout/process-tree termination, complete private logs, redacted diagnostic tails, stable signatures, sequential command sets, and two-of-three confirmation.
- Detection of check-created tracked mutations, preservation as a diagnostic patch, and restoration of the checked commit.

The test suite uses temporary real Git repositories for workspace, commit, revert, reset, and interruption behavior.

## Important implementation choices

- `src/git-repository.ts` contains explicit-path raw Git primitives. `src/git-operations.ts` is the controller-facing journal boundary: it persists intent before workspace, checkpoint, revert, or reset side effects and persists the observed result afterward.
- `runJournaledCommandSet` is the equivalent journal boundary for command processes. A recorded live child PID causes startup to refuse duplicate execution; a dead or absent child yields a deterministic rerun action.
- Controller commits use a fixed local author/committer identity, disable signing and project hooks, and carry the three planned Recovery Loop trailers. Agent descendant commits are preserved under a rescue ref, then soft-reset and collapsed into one controller commit.
- Rescue creation is idempotent during restart. A matching rescue ref is accepted; a ref pointing elsewhere is a canonicality error. No hard rollback reaches `git reset --hard` before the rescue ref resolves to the old head.
- Raw stdout/stderr are complete diagnostic logs with restrictive file modes. Only bounded, redacted tails belong in semantic results and events.
- Event append failure does not roll back semantic state. State publication failure remains fatal.
- The repository has no runtime package dependencies. There are nine production modules and about 4,050 physical TypeScript lines. Four cohesive boundary modules are slightly above the approximate 600-line tripwire (629–664 physical lines, 598–626 nonblank lines); splitting their handwritten validation or crash-recovery branches would add indirection without reducing the conceptual surface.

## Validation

Validated on Windows with Node 25.9.0 (the package requires Node 24+), pnpm 10.33.0, and Git 2.54.0:

```text
pnpm typecheck
PASS

pnpm lint
PASS

pnpm build
PASS

pnpm test
PASS — 8 files, 82 tests

pnpm test:acceptance
PASS — 8 files, 82 tests
```

`test:acceptance` intentionally points at the Stage 1–4 unit and real-repository integration suites. The product-level delayed-regression acceptance scenarios depend on later stages and were not implemented early.

Interruption coverage includes:

- before and after atomic state rename;
- after workspace intent and after branch creation;
- after checkpoint intent and after commit;
- after agent-history rescue creation but before soft reset;
- after rollback rescue verification and after reset;
- before command spawn and during recorded command lifecycle;
- during lock creation and release.

## Known limitations

No unresolved Stage 1–4 defect was found by the final suite. Deliberate current limitations are:

- `init`, `run`, and `check` orchestration handlers remain explicit deferred handlers. `status` is implemented because its Stage 3 read-only semantics can be complete without a controller loop.
- Checks do not schedule themselves, promote `knownGoodCommit`, or create pending failures. Those are Stage 5 health-model responsibilities.
- There is no coding-agent SDK, work selection, prompt construction, forward repair, localization policy, or autonomous controller loop.
- Secret detection intentionally covers high-confidence formats, not arbitrary entropy or every provider format.
- Complete command logs may contain project-emitted sensitive text; they are local, mode-restricted diagnostics. Semantic tails are redacted.
- If a project check moves `HEAD`, the runner reports a safety/canonicality failure and leaves recovery to the journaled Git boundary. It only auto-restores ordinary tracked working-tree/index mutations.
- Low-level Git and process functions exist for composition and focused tests. Future controller code should use `src/git-operations.ts` and `runJournaledCommandSet` so intent ordering is not bypassed.

## Scope audit

The production tree contains no controller, agent gateway, recovery policy, check scheduler, forward repair, regression localizer, benchmark system, extra agent role, evidence artifact, or generic workflow machinery. The only future-facing state fields are the compact health/cadence fields required by the authoritative schema; no Stage 5 behavior acts on them.

## Next stage

Implement Stage 5 only: deterministic smoke/deep scheduling and the check-relative health model. Build it on the existing journaled checkpoint and command-set entry points, advance `knownGoodCommit` only after a clean exact-head full pass, and preserve the existing rule that checkpoints are created before checks.
