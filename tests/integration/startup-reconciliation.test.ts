import { readFile, readdir, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { PendingOperation } from "../../src/contracts.js";
import { readStatusSnapshot } from "../../src/cli.js";
import {
  initializeJournaledWorkspace,
  interruptedOperation,
  journaledCheckpoint,
  journaledCleanRevert,
  journaledHardRollback,
  reconcileStartup,
} from "../../src/git-operations.js";
import { CanonicalityError, type GitRepository } from "../../src/git-repository.js";
import { assertCheckpointSafe, SafetyGuardError } from "../../src/safety.js";
import { StateStore } from "../../src/state-store.js";
import {
  createTemporaryRepository,
  type TemporaryRepository,
} from "../support/temporary-repository.js";

const fixtures: TemporaryRepository[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function journaledFixture(): Promise<{
  fixture: TemporaryRepository;
  store: StateStore;
  worktree: GitRepository;
}> {
  const fixture = await createTemporaryRepository();
  fixtures.push(fixture);
  const store = new StateStore(fixture.repository.gitCommonDir);
  const initialized = await initializeJournaledWorkspace({
    operatorRepository: fixture.repository,
    store,
    branch: "recovery-loop/work",
    worktreePath: fixture.worktreePath,
    sessionId: "rl-test",
  });
  return { fixture, store, worktree: initialized.worktree };
}

async function createCheckpoint(
  fixture: TemporaryRepository,
  store: StateStore,
  worktree: GitRepository,
  base: string,
  unitId: string,
) {
  await fixture.write(fixture.worktreePath, `${unitId}.txt`, `${unitId}\n`);
  return journaledCheckpoint(store, worktree, {
    branch: "recovery-loop/work",
    expectedBase: base,
    summary: `add ${unitId}`,
    sessionId: "rl-test",
    unitId,
    kind: "work",
  });
}

describe("workspace interruption boundaries", () => {
  it("finishes initialization after intent persisted but before Git mutation", async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const interruptedStore = new StateStore(fixture.repository.gitCommonDir, {
      afterIntentPersisted: () => {
        throw new Error("crash after workspace intent");
      },
    });
    await expect(
      initializeJournaledWorkspace({
        operatorRepository: fixture.repository,
        store: interruptedStore,
        branch: "recovery-loop/work",
        worktreePath: fixture.worktreePath,
        sessionId: "rl-test",
      }),
    ).rejects.toThrow("crash after workspace intent");
    expect(await fixture.repository.branchHead("recovery-loop/work")).toBeNull();

    const store = new StateStore(fixture.repository.gitCommonDir);
    const reconciled = await reconcileStartup(fixture.repository, store);
    expect(reconciled.action).toBe("workspace-recreated");
    expect(reconciled.state.phase).toBe("idle");
    expect(await fixture.repository.currentBranch()).toBe("main");
    expect(await fixture.repository.head()).toBe(fixture.baseline);
  });

  it("recreates the worktree after a crash immediately after branch creation", async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const store = new StateStore(fixture.repository.gitCommonDir);
    await expect(
      initializeJournaledWorkspace({
        operatorRepository: fixture.repository,
        store,
        branch: "recovery-loop/work",
        worktreePath: fixture.worktreePath,
        sessionId: "rl-test",
        hooks: {
          afterBranchCreated: () => {
            throw new Error("crash after branch");
          },
        },
      }),
    ).rejects.toThrow("crash after branch");
    expect(await fixture.repository.branchHead("recovery-loop/work")).toBe(fixture.baseline);
    const reconciled = await reconcileStartup(fixture.repository, store);
    expect(reconciled.action).toBe("workspace-recreated");
    expect(reconciled.state.repository.expectedHead).toBe(fixture.baseline);
  });

  it("reconstructs an idle worktree directory that disappeared", async () => {
    const { fixture, store } = await journaledFixture();
    await rm(fixture.worktreePath, { recursive: true, force: true });
    const reconciled = await reconcileStartup(fixture.repository, store);
    expect(reconciled.action).toBe("workspace-recreated");
    expect(reconciled.state.phase).toBe("idle");
  });

  it("preserves and reconciles a non-workspace operation when the worktree disappeared", async () => {
    const { fixture, store, worktree } = await journaledFixture();
    await fixture.write(fixture.worktreePath, "agent-commit.txt", "agent work\n");
    const agentHead = await fixture.commit(fixture.worktreePath, "agent-created commit");
    await store.update((draft) => {
      draft.phase = "agent-running";
      draft.operation = {
        id: "op-agent",
        kind: "agent",
        unitId: "unit-missing-worktree",
        baseCommit: fixture.baseline,
        targetCommit: null,
        observedHead: fixture.baseline,
        rescueRef: null,
        childPid: null,
        summary: "preserve interrupted agent work",
        checkpointKind: null,
        startedAt: "2026-08-07T20:00:00.000Z",
      };
    });
    await rm(fixture.worktreePath, { recursive: true, force: true });
    const reconciled = await reconcileStartup(fixture.repository, store, {
      guard: async () => undefined,
    });
    expect(reconciled.action).toBe("interrupted-work-checkpointed");
    expect(await worktree.branchHead("recovery-loop/rescue/rl-test-unit-missing-worktree-agent-history"))
      .toBe(agentHead);
    expect(await worktree.commitCount(`${fixture.baseline}..HEAD`)).toBe(1);
    expect(await worktree.commitMessage()).toContain("Recovery-Loop-Kind: interrupted");
  });
});

describe("checkpoint interruption boundaries", () => {
  it("finishes a checkpoint after persisted intent but before commit", async () => {
    const { fixture, store, worktree } = await journaledFixture();
    await fixture.write(fixture.worktreePath, "pending.txt", "pending\n");
    const interruptedStore = new StateStore(fixture.repository.gitCommonDir, {
      afterIntentPersisted: (state) => {
        if (state.operation?.kind === "checkpoint") throw new Error("crash after intent");
      },
    });
    await expect(
      journaledCheckpoint(interruptedStore, worktree, {
        branch: "recovery-loop/work",
        expectedBase: fixture.baseline,
        summary: "add pending file",
        sessionId: "rl-test",
        unitId: "unit-intent",
        kind: "work",
      }),
    ).rejects.toThrow("crash after intent");
    expect(await worktree.head()).toBe(fixture.baseline);
    const reconciled = await reconcileStartup(fixture.repository, store, { guard: async () => undefined });
    expect(reconciled.action).toBe("checkpoint-finished");
    expect(await worktree.commitCount(`${fixture.baseline}..HEAD`)).toBe(1);
    expect((await store.readState()).phase).toBe("idle");
  });

  it("revalidates an already-created checkpoint after commit but before result state", async () => {
    const { fixture, store, worktree } = await journaledFixture();
    await fixture.write(fixture.worktreePath, "committed.txt", "committed\n");
    await expect(
      journaledCheckpoint(store, worktree, {
        branch: "recovery-loop/work",
        expectedBase: fixture.baseline,
        summary: "add committed file",
        sessionId: "rl-test",
        unitId: "unit-commit",
        kind: "work",
        hooks: {
          afterGitMutation: () => {
            throw new Error("crash after commit");
          },
        },
      }),
    ).rejects.toThrow("crash after commit");
    const committedHead = await worktree.head();
    expect((await store.readState()).phase).toBe("checkpointing");
    let guarded = false;
    const reconciled = await reconcileStartup(fixture.repository, store, {
      guard: async () => { guarded = true; },
    });
    expect(reconciled.action).toBe("checkpoint-adopted");
    expect(guarded).toBe(true);
    expect((await store.readState()).repository.expectedHead).toBe(committedHead);
    expect(await worktree.commitCount(`${fixture.baseline}..HEAD`)).toBe(1);
  });

  it("rejects a forged checkpoint trailer when committed content violates the guard", async () => {
    const { fixture, store, worktree } = await journaledFixture();
    await store.update((draft) => {
      draft.phase = "checkpointing";
      draft.operation = interruptedOperation({
        baseCommit: fixture.baseline,
        unitId: "unit-forged",
        summary: "forged checkpoint",
        kind: "work",
      });
    });
    await fixture.write(fixture.worktreePath, "RECOVERY_GOAL.md", "agent-owned authority\n");
    const forged = await fixture.commit(
      fixture.worktreePath,
      [
        "forged controller commit",
        "",
        "Recovery-Loop-Session: rl-test",
        "Recovery-Loop-Unit: unit-forged",
        "Recovery-Loop-Kind: work",
      ].join("\n"),
    );
    await expect(reconcileStartup(fixture.repository, store, {
      guard: (_repository, expectedHead = fixture.baseline, committedBase) => assertCheckpointSafe(worktree, {
        expectedBranch: "recovery-loop/work",
        expectedBase: expectedHead,
        expectedWorktreePath: fixture.worktreePath,
        protectedPaths: ["RECOVERY_GOAL.md", ".recovery-loop/config.json"],
        ...(committedBase === undefined ? {} : { committedBase }),
      }),
    })).rejects.toBeInstanceOf(SafetyGuardError);
    expect(await worktree.head()).toBe(fixture.baseline);
    expect(await worktree.branchHead("recovery-loop/rescue/rl-test-unit-forged-agent-history"))
      .toBe(forged);
    expect((await store.readState()).phase).toBe("checkpointing");
  });

  it("normalizes a preexisting agent commit even when it forges checkpoint trailers", async () => {
    const { fixture, store, worktree } = await journaledFixture();
    await fixture.write(fixture.worktreePath, "safe-agent-work.txt", "safe agent work\n");
    const agentHead = await fixture.commit(
      fixture.worktreePath,
      [
        "forged controller checkpoint",
        "",
        "Recovery-Loop-Session: rl-test",
        "Recovery-Loop-Unit: unit-forged-safe",
        "Recovery-Loop-Kind: work",
      ].join("\n"),
    );
    const interruptedStore = new StateStore(fixture.repository.gitCommonDir, {
      afterIntentPersisted: (state) => {
        if (state.operation?.kind === "checkpoint") throw new Error("crash after forged intent");
      },
    });
    await expect(journaledCheckpoint(interruptedStore, worktree, {
      branch: "recovery-loop/work",
      expectedBase: fixture.baseline,
      summary: "normalize safe agent work",
      sessionId: "rl-test",
      unitId: "unit-forged-safe",
      kind: "work",
    })).rejects.toThrow("crash after forged intent");
    expect((await store.readState()).operation?.observedHead).toBe(agentHead);

    const reconciled = await reconcileStartup(fixture.repository, store, {
      guard: (_repository, expectedHead = fixture.baseline, committedBase) =>
        assertCheckpointSafe(worktree, {
          expectedBranch: "recovery-loop/work",
          expectedBase: expectedHead,
          expectedWorktreePath: fixture.worktreePath,
          protectedPaths: ["RECOVERY_GOAL.md", ".recovery-loop/config.json"],
          ...(committedBase === undefined ? {} : { committedBase }),
        }),
    });
    const rescueRef = "recovery-loop/rescue/rl-test-unit-forged-safe-agent-history";
    expect(reconciled.action).toBe("checkpoint-finished");
    expect(reconciled.checkpoint?.normalizedAgentHead).toBe(agentHead);
    expect(await worktree.branchHead(rescueRef)).toBe(agentHead);
    expect(await worktree.head()).not.toBe(agentHead);
    expect(await worktree.isControllerAuthoredCommit()).toBe(true);
  });

  it("preserves useful dirty work from an interrupted agent phase", async () => {
    const { fixture, store, worktree } = await journaledFixture();
    await fixture.write(fixture.worktreePath, "interrupted.txt", "useful edits\n");
    await store.update((draft) => {
      draft.phase = "agent-running";
      draft.operation = interruptedOperation({
        baseCommit: fixture.baseline,
        unitId: "unit-interrupted",
        summary: "preserve interrupted edits",
      });
    });
    const reconciled = await reconcileStartup(fixture.repository, store, {
      guard: async () => undefined,
    });
    expect(reconciled.action).toBe("interrupted-work-checkpointed");
    expect(await worktree.commitMessage()).toContain("Recovery-Loop-Kind: interrupted");
    expect((await store.readState()).phase).toBe("idle");
  });

  it("finishes agent-history normalization after rescue creation but before soft reset", async () => {
    const { fixture, store, worktree } = await journaledFixture();
    await fixture.write(fixture.worktreePath, "agent-commit.txt", "agent work\n");
    const agentHead = await fixture.commit(fixture.worktreePath, "agent-created commit");
    await expect(
      journaledCheckpoint(store, worktree, {
        branch: "recovery-loop/work",
        expectedBase: fixture.baseline,
        summary: "normalize agent work",
        sessionId: "rl-test",
        unitId: "unit-normalize",
        kind: "work",
        hooks: {
          afterRescueVerified: () => {
            throw new Error("crash after normalization rescue");
          },
        },
      }),
    ).rejects.toThrow("crash after normalization rescue");
    const rescueRef = "recovery-loop/rescue/rl-test-unit-normalize-agent-history";
    expect(await worktree.branchHead(rescueRef)).toBe(agentHead);
    expect(await worktree.head()).toBe(agentHead);
    const reconciled = await reconcileStartup(fixture.repository, store, {
      guard: async () => undefined,
    });
    expect(reconciled.action).toBe("checkpoint-finished");
    expect(await worktree.commitCount(`${fixture.baseline}..HEAD`)).toBe(1);
    expect(await worktree.branchHead(rescueRef)).toBe(agentHead);
  });

  it("turns unexplained non-descendant movement into a durable canonicality stop", async () => {
    const { fixture, store } = await journaledFixture();
    const tree = await fixture.git(fixture.worktreePath, ["write-tree"]);
    const orphan = await fixture.git(fixture.worktreePath, ["commit-tree", tree, "-m", "orphan"]);
    await fixture.git(fixture.worktreePath, ["reset", "--hard", orphan]);
    await expect(reconcileStartup(fixture.repository, store)).rejects.toBeInstanceOf(
      CanonicalityError,
    );
    const stopped = await store.readState();
    expect(stopped.phase).toBe("stopped");
    expect(stopped.session.stopReason).toContain("canonical branch ambiguity");
    expect(await fixture.repository.head()).toBe(fixture.baseline);
  });
});

describe("rollback interruption boundaries", () => {
  it("completes reset after a crash following rescue verification", async () => {
    const { fixture, store, worktree } = await journaledFixture();
    const changed = await createCheckpoint(fixture, store, worktree, fixture.baseline, "unit-change");
    const rescueRef = "recovery-loop/rescue/rl-test-reset-1";
    await expect(
      journaledHardRollback(store, worktree, {
        branch: "recovery-loop/work",
        expectedHead: changed!.commit,
        targetCommit: fixture.baseline,
        rescueRef,
        hooks: {
          afterRescueVerified: () => {
            throw new Error("crash after rescue");
          },
        },
      }),
    ).rejects.toThrow("crash after rescue");
    expect(await worktree.head()).toBe(changed!.commit);
    expect(await worktree.branchHead(rescueRef)).toBe(changed!.commit);
    const reconciled = await reconcileStartup(fixture.repository, store);
    expect(reconciled.action).toBe("rollback-finished");
    expect(await worktree.head()).toBe(fixture.baseline);
    expect((await store.readState()).recovery.rescueRefs).toContain(rescueRef);
  });

  it("adopts a completed reset after a crash before state update", async () => {
    const { fixture, store, worktree } = await journaledFixture();
    const changed = await createCheckpoint(fixture, store, worktree, fixture.baseline, "unit-change");
    const rescueRef = "recovery-loop/rescue/rl-test-reset-2";
    await expect(
      journaledHardRollback(store, worktree, {
        branch: "recovery-loop/work",
        expectedHead: changed!.commit,
        targetCommit: fixture.baseline,
        rescueRef,
        hooks: {
          afterReset: () => {
            throw new Error("crash after reset");
          },
        },
      }),
    ).rejects.toThrow("crash after reset");
    expect(await worktree.head()).toBe(fixture.baseline);
    const reconciled = await reconcileStartup(fixture.repository, store);
    expect(reconciled.action).toBe("rollback-finished");
    expect((await store.readState()).repository.expectedHead).toBe(fixture.baseline);
    expect(await worktree.branchHead(rescueRef)).toBe(changed!.commit);
  });

  it("adopts a clean revert created before result-state persistence", async () => {
    const { fixture, store, worktree } = await journaledFixture();
    const bad = await createCheckpoint(fixture, store, worktree, fixture.baseline, "unit-bad");
    await expect(
      journaledCleanRevert(store, worktree, {
        branch: "recovery-loop/work",
        expectedHead: bad!.commit,
        targetCommit: bad!.commit,
        sessionId: "rl-test",
        unitId: "unit-revert",
        hooks: {
          afterGitMutation: () => {
            throw new Error("crash after revert");
          },
        },
      }),
    ).rejects.toThrow("crash after revert");
    const revertHead = await worktree.head();
    const reconciled = await reconcileStartup(fixture.repository, store);
    expect(reconciled.action).toBe("revert-finished");
    expect((await store.readState()).repository.expectedHead).toBe(revertHead);
  });
});

describe("non-mutating reconciliation decisions", () => {
  it("reads CLI status without taking a lock or changing runtime files", async () => {
    const { fixture, store } = await journaledFixture();
    const namesBefore = await readdir(store.runtimeRoot);
    const stateBefore = await readFile(store.statePath, "utf8");
    const status = await readStatusSnapshot(fixture.projectPath);
    expect(status).toMatchObject({
      phase: "idle",
      branch: "recovery-loop/work",
      actualHead: fixture.baseline,
      expectedHead: fixture.baseline,
      knownGoodCommit: null,
    });
    expect(status.lock).toEqual({ status: "none" });
    expect(await readdir(store.runtimeRoot)).toEqual(namesBefore);
    expect(await readFile(store.statePath, "utf8")).toBe(stateBefore);
  });

  it.each([
    ["smoke-checking", "rerun-smoke"],
    ["deep-checking", "rerun-deep"],
    ["diagnosing", "restart-diagnosis"],
  ] as const)("returns %s interruption as %s", async (phase, action) => {
    const { fixture, store } = await journaledFixture();
    const checkOperation: PendingOperation = {
      id: "op-check",
      kind: "check",
      unitId: null,
      baseCommit: fixture.baseline,
      targetCommit: fixture.baseline,
      observedHead: fixture.baseline,
      rescueRef: null,
      childPid: null,
      summary: null,
      checkpointKind: null,
      startedAt: "2026-08-07T20:00:00.000Z",
    };
    await store.update((draft) => {
      draft.phase = phase;
      draft.operation = checkOperation;
    });
    const reconciled = await reconcileStartup(fixture.repository, store);
    expect(reconciled.action).toBe(action);
    expect((await store.readState()).phase).toBe(phase);
  });

  it("refuses to duplicate a recorded check process that is still alive", async () => {
    const { fixture, store } = await journaledFixture();
    const checkOperation: PendingOperation = {
      id: "op-live-check",
      kind: "check",
      unitId: "deep",
      baseCommit: fixture.baseline,
      targetCommit: fixture.baseline,
      observedHead: fixture.baseline,
      rescueRef: null,
      childPid: process.pid,
      summary: "deep command set",
      checkpointKind: null,
      startedAt: "2026-08-07T20:00:00.000Z",
    };
    await store.update((draft) => {
      draft.phase = "deep-checking";
      draft.operation = checkOperation;
    });
    await expect(reconcileStartup(fixture.repository, store)).rejects.toThrow(
      `recorded command PID ${process.pid} is still alive`,
    );
    expect((await store.readState()).phase).toBe("deep-checking");
  });

  it("reruns a pre-reboot command journal even when its PID has been recycled", async () => {
    const { fixture, store } = await journaledFixture();
    await store.update((draft) => {
      draft.phase = "smoke-checking";
      draft.operation = {
        id: "op-recycled-check",
        kind: "check",
        unitId: "smoke",
        baseCommit: fixture.baseline,
        targetCommit: fixture.baseline,
        observedHead: fixture.baseline,
        rescueRef: null,
        childPid: process.pid,
        summary: "smoke command set",
        checkpointKind: null,
        startedAt: "2000-01-01T00:00:00.000Z",
      };
    });
    const reconciled = await reconcileStartup(fixture.repository, store);
    expect(reconciled.action).toBe("rerun-smoke");
  });
});
