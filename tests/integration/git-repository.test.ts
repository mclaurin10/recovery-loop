import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GitRepository} from "../../src/git-repository.js";
import {
  CanonicalityError,
  WorkspaceExistsError,
} from "../../src/git-repository.js";
import {
  createTemporaryRepository,
  type TemporaryRepository,
} from "../support/temporary-repository.js";

const fixtures: TemporaryRepository[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function fixtureWithWorktree(): Promise<{
  fixture: TemporaryRepository;
  worktree: GitRepository;
}> {
  const fixture = await createTemporaryRepository();
  fixtures.push(fixture);
  const { worktree } = await fixture.repository.createAutonomousWorktree({
    branch: "recovery-loop/work",
    worktreePath: fixture.worktreePath,
  });
  return { fixture, worktree };
}

async function checkpoint(
  worktree: GitRepository,
  base: string,
  unitId: string,
  summary: string,
) {
  return worktree.checkpoint({
    branch: "recovery-loop/work",
    expectedBase: base,
    summary,
    sessionId: "rl-test",
    unitId,
    kind: "work",
  });
}

describe("Git workspace", () => {
  it("creates an isolated branch and persistent worktree without moving the operator checkout", async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    const operatorBranch = await fixture.repository.currentBranch();
    const operatorHead = await fixture.repository.head();
    const result = await fixture.repository.createAutonomousWorktree({
      branch: "recovery-loop/work",
      worktreePath: fixture.worktreePath,
    });
    expect(result.baselineCommit).toBe(operatorHead);
    expect(await result.worktree.currentBranch()).toBe("recovery-loop/work");
    expect(await fixture.repository.currentBranch()).toBe(operatorBranch);
    expect(await fixture.repository.head()).toBe(operatorHead);
    await fixture.repository.ensureClean();
  });

  it("refuses an existing branch and an existing worktree path", async () => {
    const fixture = await createTemporaryRepository();
    fixtures.push(fixture);
    await expect(
      fixture.repository.createAutonomousWorktree({
        branch: "recovery-loop/inside",
        worktreePath: path.join(fixture.projectPath, "nested-worktree"),
      }),
    ).rejects.toThrow("outside the operator checkout");
    await fixture.git(fixture.projectPath, ["branch", "recovery-loop/work", fixture.baseline]);
    await expect(
      fixture.repository.createAutonomousWorktree({
        branch: "recovery-loop/work",
        worktreePath: fixture.worktreePath,
      }),
    ).rejects.toBeInstanceOf(WorkspaceExistsError);
  });

  it("recreates a disappeared persistent worktree from the branch", async () => {
    const { fixture } = await fixtureWithWorktree();
    await rm(fixture.worktreePath, { recursive: true, force: true });
    const recreated = await fixture.repository.recreatePersistentWorktree(
      "recovery-loop/work",
      fixture.worktreePath,
    );
    expect(await recreated.head()).toBe(fixture.baseline);
    expect(await fixture.repository.currentBranch()).toBe("main");
  });

  it("uses a detached diagnostic worktree without moving the active branch", async () => {
    const { fixture, worktree } = await fixtureWithWorktree();
    await fixture.write(fixture.worktreePath, "source.txt", "checkpoint\n");
    const result = await checkpoint(worktree, fixture.baseline, "unit-1", "change source");
    expect(result).not.toBeNull();
    const activeHead = await worktree.head();
    const diagnosticPath = path.join(fixture.root, "diagnostic");
    const diagnostic = await fixture.repository.prepareDiagnosticWorktree(
      diagnosticPath,
      fixture.baseline,
    );
    expect(await diagnostic.head()).toBe(fixture.baseline);
    expect(await worktree.head()).toBe(activeHead);
    await fixture.repository.prepareDiagnosticWorktree(diagnosticPath, activeHead);
    expect(await diagnostic.head()).toBe(activeHead);
  });
});

describe("controller checkpoints", () => {
  it("commits dirty edits exactly once with controller identity and trailers", async () => {
    const { fixture, worktree } = await fixtureWithWorktree();
    await fixture.write(fixture.worktreePath, "source.txt", "useful edit\n");
    const result = await checkpoint(worktree, fixture.baseline, "unit-1", "change source");
    expect(result).not.toBeNull();
    expect(await worktree.commitCount(`${fixture.baseline}..HEAD`)).toBe(1);
    const metadata = await fixture.git(fixture.worktreePath, [
      "show",
      "-s",
      "--format=%an|%ae%n%B",
      "HEAD",
    ]);
    expect(metadata).toContain("Recovery Loop|recovery-loop@localhost");
    expect(metadata).toContain("Recovery-Loop-Session: rl-test");
    expect(metadata).toContain("Recovery-Loop-Unit: unit-1");
    expect(metadata).toContain("Recovery-Loop-Kind: work");
    expect(result?.statistics).toMatchObject({ files: 1, additions: 1, deletions: 1 });
    await worktree.ensureClean();
  });

  it("does not create empty commits", async () => {
    const { fixture, worktree } = await fixtureWithWorktree();
    expect(await checkpoint(worktree, fixture.baseline, "unit-empty", "nothing changed")).toBeNull();
    expect(await worktree.head()).toBe(fixture.baseline);
  });

  it("normalizes several agent-created descendant commits into one controller checkpoint", async () => {
    const { fixture, worktree } = await fixtureWithWorktree();
    await fixture.write(fixture.worktreePath, "one.txt", "one\n");
    await fixture.commit(fixture.worktreePath, "agent commit one");
    await fixture.write(fixture.worktreePath, "two.txt", "two\n");
    const agentHead = await fixture.commit(fixture.worktreePath, "agent commit two");
    await fixture.write(fixture.worktreePath, "three.txt", "dirty third edit\n");

    const result = await checkpoint(worktree, fixture.baseline, "unit-agent", "preserve useful edits");
    expect(result?.normalizedAgentHead).toBe(agentHead);
    expect(result?.rescueRef).toBe("recovery-loop/rescue/rl-test-unit-agent-agent-history");
    expect(await worktree.branchHead(result!.rescueRef!)).toBe(agentHead);
    expect(await worktree.commitCount(`${fixture.baseline}..HEAD`)).toBe(1);
    expect(await readFile(path.join(fixture.worktreePath, "three.txt"), "utf8")).toBe(
      "dirty third edit\n",
    );
  });

  it("stops on non-descendant branch movement", async () => {
    const { fixture, worktree } = await fixtureWithWorktree();
    const tree = await fixture.git(fixture.worktreePath, ["write-tree"]);
    const orphan = await fixture.git(fixture.worktreePath, ["commit-tree", tree, "-m", "orphan"]);
    await fixture.git(fixture.worktreePath, ["reset", "--hard", orphan]);
    await expect(
      checkpoint(worktree, fixture.baseline, "unit-rewrite", "should stop"),
    ).rejects.toBeInstanceOf(CanonicalityError);
    expect(await fixture.repository.currentBranch()).toBe("main");
    expect(await fixture.repository.head()).toBe(fixture.baseline);
  });
});

describe("revert and rollback", () => {
  it("creates a clean controller-owned revert while preserving later work", async () => {
    const { fixture, worktree } = await fixtureWithWorktree();
    await fixture.write(fixture.worktreePath, "source.txt", "bad change\n");
    const bad = await checkpoint(worktree, fixture.baseline, "unit-bad", "change source");
    await fixture.write(fixture.worktreePath, "later.txt", "useful later work\n");
    const later = await checkpoint(worktree, bad!.commit, "unit-later", "add later work");
    const reverted = await worktree.cleanRevert({
      branch: "recovery-loop/work",
      expectedHead: later!.commit,
      targetCommit: bad!.commit,
      sessionId: "rl-test",
      unitId: "unit-revert",
    });
    expect(reverted).not.toBeNull();
    expect(await readFile(path.join(fixture.worktreePath, "source.txt"), "utf8")).toBe("baseline\n");
    expect(await readFile(path.join(fixture.worktreePath, "later.txt"), "utf8")).toBe(
      "useful later work\n",
    );
    expect(await worktree.commitMessage()).toContain("Recovery-Loop-Kind: revert");
  });

  it("aborts a conflicting revert and leaves the branch clean at its old head", async () => {
    const { fixture, worktree } = await fixtureWithWorktree();
    await fixture.write(fixture.worktreePath, "source.txt", "bad change\n");
    const bad = await checkpoint(worktree, fixture.baseline, "unit-bad", "change source");
    await fixture.write(fixture.worktreePath, "source.txt", "entangled later change\n");
    const later = await checkpoint(worktree, bad!.commit, "unit-later", "entangle source");
    const reverted = await worktree.cleanRevert({
      branch: "recovery-loop/work",
      expectedHead: later!.commit,
      targetCommit: bad!.commit,
      sessionId: "rl-test",
      unitId: "unit-revert",
    });
    expect(reverted).toBeNull();
    expect(await worktree.head()).toBe(later!.commit);
    expect(await worktree.hasTrackedChanges()).toBe(false);
  });

  it("verifies rescue before reset and resumes after interruption at that boundary", async () => {
    const { fixture, worktree } = await fixtureWithWorktree();
    await fixture.write(fixture.worktreePath, "source.txt", "checkpoint\n");
    const changed = await checkpoint(worktree, fixture.baseline, "unit-1", "change source");
    const rescueRef = "recovery-loop/rescue/rl-test-1";
    await expect(
      worktree.hardRollback({
        branch: "recovery-loop/work",
        expectedHead: changed!.commit,
        targetCommit: fixture.baseline,
        rescueRef,
        hooks: {
          afterRescueVerified: async () => {
            expect(await worktree.branchHead(rescueRef)).toBe(changed!.commit);
            expect(await worktree.head()).toBe(changed!.commit);
            throw new Error("simulated crash after rescue");
          },
        },
      }),
    ).rejects.toThrow("simulated crash");
    expect(await worktree.head()).toBe(changed!.commit);
    const result = await worktree.hardRollback({
      branch: "recovery-loop/work",
      expectedHead: changed!.commit,
      targetCommit: fixture.baseline,
      rescueRef,
    });
    expect(result.oldHead).toBe(changed!.commit);
    expect(await worktree.head()).toBe(fixture.baseline);
    expect(await worktree.branchHead(rescueRef)).toBe(changed!.commit);
  });
});

describe("unsafe modes", () => {
  it("reports changed symlinks and gitlinks from the index", async () => {
    const { fixture, worktree } = await fixtureWithWorktree();
    const linkBlob = await fixture.git(fixture.worktreePath, ["hash-object", "-w", "--stdin"], "../outside");
    await fixture.git(fixture.worktreePath, [
      "update-index",
      "--add",
      "--cacheinfo",
      `120000,${linkBlob},escape-link`,
    ]);
    await fixture.git(fixture.worktreePath, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${fixture.baseline},nested-repository`,
    ]);
    const unsafe = await worktree.unsafeModeChanges();
    expect(unsafe).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "escape-link", kind: "symlink" }),
        expect.objectContaining({ path: "nested-repository", kind: "gitlink" }),
      ]),
    );
    await expect(access(fixture.projectPath)).resolves.toBeUndefined();
  });
});
