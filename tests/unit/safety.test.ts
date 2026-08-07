import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRepository } from "../../src/git-repository.js";
import {
  assertCheckpointSafe,
  runSafetyGuard,
  SafetyGuardError,
  type SafetyGuardOptions,
} from "../../src/safety.js";
import {
  ByteTail,
  boundedRedactedTail,
  commandSignature,
  findSensitiveMaterial,
  redact,
} from "../../src/safety.js";
import {
  createTemporaryRepository,
  type TemporaryRepository,
} from "../support/temporary-repository.js";

const fixtures: TemporaryRepository[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function guardedFixture(): Promise<{
  fixture: TemporaryRepository;
  worktree: GitRepository;
  guard: SafetyGuardOptions;
}> {
  const fixture = await createTemporaryRepository();
  fixtures.push(fixture);
  const { worktree } = await fixture.repository.createAutonomousWorktree({
    branch: "recovery-loop/work",
    worktreePath: fixture.worktreePath,
  });
  return {
    fixture,
    worktree,
    guard: {
      expectedBranch: "recovery-loop/work",
      expectedBase: fixture.baseline,
      expectedWorktreePath: fixture.worktreePath,
      protectedPaths: ["RECOVERY_GOAL.md", ".recovery-loop/config.json"],
    },
  };
}

describe("checkpoint safety guard", () => {
  it("allows ordinary reversible source edits", async () => {
    const { fixture, worktree, guard } = await guardedFixture();
    await fixture.write(fixture.worktreePath, "feature.ts", "export const answer = 42;\n");
    await expect(runSafetyGuard(worktree, guard)).resolves.toEqual({ safe: true, violations: [] });
  });

  it.each(["RECOVERY_GOAL.md", ".recovery-loop/config.json"])(
    "rejects protected authority edits to %s before commit",
    async (protectedPath) => {
      const { fixture, worktree, guard } = await guardedFixture();
      await fixture.write(fixture.worktreePath, protectedPath, "agent-owned replacement\n");
      const result = await runSafetyGuard(worktree, guard);
      expect(result.safe).toBe(false);
      expect(result.violations).toContainEqual(
        expect.objectContaining({ code: "protected-path", path: protectedPath }),
      );
      await expect(
        worktree.checkpoint({
          branch: "recovery-loop/work",
          expectedBase: fixture.baseline,
          summary: "attempt authority edit",
          sessionId: "rl-test",
          unitId: "unit-guard",
          kind: "work",
          guard: async () => assertCheckpointSafe(worktree, guard),
        }),
      ).rejects.toBeInstanceOf(SafetyGuardError);
      expect(await worktree.head()).toBe(fixture.baseline);
    },
  );

  it("rejects private-key blocks and known credential token formats", async () => {
    const { fixture, worktree, guard } = await guardedFixture();
    await fixture.write(
      fixture.worktreePath,
      "private.pem",
      "-----BEGIN PRIVATE KEY-----\nnot-a-real-key-but-unsafe\n-----END PRIVATE KEY-----\n",
    );
    await fixture.write(
      fixture.worktreePath,
      "token.txt",
      `github=${"ghp_" + "A".repeat(36)}\naws=${"AKIA" + "B".repeat(16)}\n`,
    );
    const result = await runSafetyGuard(worktree, guard);
    expect(result.violations.filter((entry) => entry.code === "sensitive-material")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "private.pem" }),
        expect.objectContaining({ path: "token.txt" }),
      ]),
    );
    expect(await worktree.head()).toBe(fixture.baseline);
  });

  it("does not flag ordinary hashes or generic high-entropy identifiers", async () => {
    const { fixture, worktree, guard } = await guardedFixture();
    await fixture.write(
      fixture.worktreePath,
      "hashes.txt",
      `${"0123456789abcdef".repeat(8)}\n${"ZXcvbnMASDFGHJKLqwerty1234567890".repeat(2)}\n`,
    );
    expect((await runSafetyGuard(worktree, guard)).violations).toEqual([]);
  });

  it("rejects changed symlinks and gitlinks", async () => {
    const { fixture, worktree, guard } = await guardedFixture();
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
    const result = await runSafetyGuard(worktree, guard);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "symlink", path: "escape-link" }),
        expect.objectContaining({ code: "gitlink", path: "nested-repository" }),
      ]),
    );
  });

  it("rejects runtime-state paths and unexplained Git operation metadata", async () => {
    const { fixture, worktree, guard } = await guardedFixture();
    await fixture.write(fixture.worktreePath, ".recovery-loop/state.json", "{}\n");
    const mergeHeadPath = (
      await worktree.git(["rev-parse", "--git-path", "MERGE_HEAD"])
    ).stdout.trim();
    await writeFile(mergeHeadPath, fixture.baseline, "utf8");
    const result = await runSafetyGuard(worktree, guard);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "runtime-content", path: ".recovery-loop/state.json" }),
        expect.objectContaining({ code: "git-operation", path: "MERGE_HEAD" }),
      ]),
    );
    await rm(mergeHeadPath, { force: true });
  });
});

describe("redaction and stable failure signatures", () => {
  it("redacts high-confidence material from bounded diagnostic tails", () => {
    const token = `ghp_${"C".repeat(36)}`;
    const tail = new ByteTail(80);
    tail.append(`prefix ${"x".repeat(100)} token=${token}`);
    const output = boundedRedactedTail(tail);
    expect(output).not.toContain(token);
    expect(output).toContain("[REDACTED GITHUB-TOKEN]");
    expect(Buffer.byteLength(tail.text())).toBeLessThanOrEqual(80);
    expect(findSensitiveMaterial(token)).toHaveLength(1);
    expect(redact(token)).not.toContain(token);
  });

  it("normalizes timestamps, process IDs, and variable paths before hashing", () => {
    const common = {
      checkId: "test",
      classification: "product" as const,
      exitCode: 1,
      signal: null,
      variablePaths: [path.resolve("temporary-one")],
    };
    const first = commandSignature({
      ...common,
      stdoutTail: `failed at 2026-08-07T20:00:00.000Z pid=123 ${path.resolve("temporary-one")}`,
      stderrTail: "same failure",
    });
    const second = commandSignature({
      ...common,
      stdoutTail: `failed at 2026-08-07T20:01:22.000Z pid=999 ${path.resolve("temporary-one")}`,
      stderrTail: "same   failure",
    });
    expect(first).toBe(second);
  });
});
