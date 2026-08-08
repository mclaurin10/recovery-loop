import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  confirmFailure,
  runCommand,
  runCommandSet,
  runJournaledCommandSet,
  sanitizeEnvironment,
} from "../../src/check-runner.js";
import { createInitialState, type CommandResult, type CommandSpec } from "../../src/contracts.js";
import { reconcileStartup } from "../../src/git-operations.js";
import type { GitRepository } from "../../src/git-repository.js";
import { StateStore } from "../../src/state-store.js";
import {
  createTemporaryRepository,
  type TemporaryRepository,
} from "../support/temporary-repository.js";

const fixtures: TemporaryRepository[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function checkedFixture(): Promise<{
  fixture: TemporaryRepository;
  worktree: GitRepository;
  logRoot: string;
}> {
  const fixture = await createTemporaryRepository();
  fixtures.push(fixture);
  const { worktree } = await fixture.repository.createAutonomousWorktree({
    branch: "recovery-loop/work",
    worktreePath: fixture.worktreePath,
  });
  return { fixture, worktree, logRoot: path.join(fixture.root, "check-logs") };
}

function nodeCommand(id: string, source: string, timeoutSeconds = 5): CommandSpec {
  return { id, argv: [process.execPath, "-e", source], timeoutSeconds };
}

describe("bounded argv-only command execution", () => {
  it("records complete stdout, stderr, metadata, and a passing result", async () => {
    const { fixture, worktree, logRoot } = await checkedFixture();
    const result = await runCommand({
      repository: worktree,
      command: nodeCommand(
        "passing",
        'process.stdout.write("hello stdout"); process.stderr.write("hello stderr")',
      ),
      commit: fixture.baseline,
      category: "smoke",
      logRoot,
      sequence: 1,
    });
    expect(result).toMatchObject({
      classification: "pass",
      exitCode: 0,
      timedOut: false,
      worktreeChanged: false,
      stdoutTail: "hello stdout",
      stderrTail: "hello stderr",
    });
    expect(await readFile(result.stdoutPath!, "utf8")).toBe("hello stdout");
    expect(await readFile(result.stderrPath!, "utf8")).toBe("hello stderr");
    const saved = JSON.parse(
      await readFile(path.join(path.dirname(result.stdoutPath!), "result.json"), "utf8"),
    ) as CommandResult;
    expect(saved.signature).toBe(result.signature);
    expect(saved.commit).toBe(fixture.baseline);
  });

  it("classifies a nonzero exit as a product failure", async () => {
    const { fixture, worktree, logRoot } = await checkedFixture();
    const result = await runCommand({
      repository: worktree,
      command: nodeCommand("failure", 'console.error("assertion failed"); process.exit(7)'),
      commit: fixture.baseline,
      category: "deep",
      logRoot,
      sequence: 1,
    });
    expect(result).toMatchObject({ classification: "product", exitCode: 7, timedOut: false });
    expect(result.signature).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("classifies a missing executable as infrastructure failure", async () => {
    const { fixture, worktree, logRoot } = await checkedFixture();
    const result = await runCommand({
      repository: worktree,
      command: { id: "missing", argv: ["recovery-loop-definitely-missing-executable"], timeoutSeconds: 2 },
      commit: fixture.baseline,
      category: "smoke",
      logRoot,
      sequence: 1,
    });
    expect(result.classification).toBe("infrastructure");
    expect(result.error).toContain("could not start");
  });

  it("records a synchronous spawn rejection as infrastructure failure", async () => {
    const { fixture, worktree, logRoot } = await checkedFixture();
    const result = await runCommand({
      repository: worktree,
      command: { id: "invalid-executable", argv: ["invalid\0executable"], timeoutSeconds: 2 },
      commit: fixture.baseline,
      category: "smoke",
      logRoot,
      sequence: 1,
    });
    expect(result).toMatchObject({ classification: "infrastructure", exitCode: null });
    expect(result.error).toContain("could not start");
    await expect(readFile(path.join(path.dirname(result.stdoutPath!), "result.json"), "utf8"))
      .resolves.toContain('"classification": "infrastructure"');
  });

  it("bounds output draining when a surviving grandchild retains the pipes", async () => {
    const { fixture, worktree, logRoot } = await checkedFixture();
    const grandchild = "setTimeout(() => {}, 2000)";
    const parent = [
      'const { spawn } = require("node:child_process");',
      `spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: ["ignore", process.stdout, process.stderr] }).unref();`,
    ].join("");
    const started = Date.now();
    const result = await runCommand({
      repository: worktree,
      command: nodeCommand("leaked-grandchild", parent),
      commit: fixture.baseline,
      category: "smoke",
      logRoot,
      sequence: 1,
      terminationGraceMs: 50,
    });
    expect(result.classification).toBe("pass");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("times out and terminates a spawned child process", async () => {
    const { fixture, worktree, logRoot } = await checkedFixture();
    const marker = path.join(fixture.root, "late-child-marker.txt");
    const childSource = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 700)`;
    const parentSource = [
      'const { spawn } = require("node:child_process");',
      `spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: "ignore" });`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const result = await runCommand({
      repository: worktree,
      command: nodeCommand("timeout", parentSource, 0.15),
      commit: fixture.baseline,
      category: "smoke",
      logRoot,
      sequence: 1,
      terminationGraceMs: 50,
    });
    expect(result).toMatchObject({ classification: "infrastructure", timedOut: true });
    await new Promise((resolve) => setTimeout(resolve, 900));
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("logs very large output completely while retaining bounded redacted tails", async () => {
    const { fixture, worktree, logRoot } = await checkedFixture();
    const token = `ghp_${"D".repeat(36)}`;
    const result = await runCommand({
      repository: worktree,
      command: nodeCommand(
        "large-output",
        `process.stdout.write("x".repeat(1000000) + " " + ${JSON.stringify(token)}); process.stderr.write("e".repeat(250000))`,
      ),
      commit: fixture.baseline,
      category: "deep",
      logRoot,
      sequence: 1,
      maximumTailBytes: 1024,
    });
    expect((await stat(result.stdoutPath!)).size).toBeGreaterThan(1_000_000);
    expect((await stat(result.stderrPath!)).size).toBe(250_000);
    expect(Buffer.byteLength(result.stdoutTail)).toBeLessThanOrEqual(1024);
    expect(result.stdoutTail).not.toContain(token);
    expect(await readFile(result.stdoutPath!, "utf8")).toContain(token);
  });

  it("reports output setup failure without starting a command", async () => {
    const { fixture, worktree, logRoot } = await checkedFixture();
    const result = await runCommand({
      repository: worktree,
      command: nodeCommand("no-log", "process.exit(99)"),
      commit: fixture.baseline,
      category: "smoke",
      logRoot,
      sequence: 1,
      hooks: {
        beforeOutputOpen: () => {
          throw new Error("simulated log failure");
        },
      },
    });
    expect(result).toMatchObject({
      classification: "infrastructure",
      exitCode: null,
      stdoutPath: null,
      stderrPath: null,
    });
    expect(result.error).toContain("simulated log failure");
  });

  it("detects, preserves, and removes a check's tracked-source mutation", async () => {
    const { fixture, worktree, logRoot } = await checkedFixture();
    const result = await runCommand({
      repository: worktree,
      command: nodeCommand(
        "mutating-check",
        'require("node:fs").writeFileSync("source.txt", "mutated by check\\n")',
      ),
      commit: fixture.baseline,
      category: "deep",
      logRoot,
      sequence: 1,
    });
    expect(result).toMatchObject({ classification: "infrastructure", worktreeChanged: true });
    expect(result.error).toContain("tracked-mutation.patch");
    expect(await readFile(path.join(fixture.worktreePath, "source.txt"), "utf8")).toBe("baseline\n");
    expect(await worktree.hasTrackedChanges()).toBe(false);
    const patchContents = await readFile(
      path.join(path.dirname(result.stdoutPath!), "tracked-mutation.patch"),
      "utf8",
    );
    expect(patchContents).toContain("mutated by check");
  });

  it("classifies and removes nonignored untracked output created by a check", async () => {
    const { fixture, worktree, logRoot } = await checkedFixture();
    const generated = path.join(fixture.worktreePath, "generated-by-check.txt");
    const result = await runCommand({
      repository: worktree,
      command: nodeCommand(
        "untracked-output",
        'require("node:fs").writeFileSync("generated-by-check.txt", "generated\\n")',
      ),
      commit: fixture.baseline,
      category: "smoke",
      logRoot,
      sequence: 1,
    });
    expect(result).toMatchObject({ classification: "infrastructure", worktreeChanged: true });
    expect(result.error).toContain("nonignored untracked output");
    await expect(access(generated)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await worktree.changedPaths(true)).toEqual([]);
  });

  it("allows ignored generated output and keeps checks bound to exact HEAD", async () => {
    const { fixture, worktree, logRoot } = await checkedFixture();
    await fixture.write(fixture.worktreePath, ".gitignore", "ignored.tmp\n");
    const checkpoint = await worktree.checkpoint({
      branch: "recovery-loop/work",
      expectedBase: fixture.baseline,
      summary: "ignore generated output",
      sessionId: "rl-test",
      unitId: "unit-ignore",
      kind: "work",
    });
    const result = await runCommand({
      repository: worktree,
      command: nodeCommand(
        "generated-output",
        'require("node:fs").writeFileSync("ignored.tmp", "generated")',
      ),
      commit: checkpoint!.commit,
      category: "smoke",
      logRoot,
      sequence: 1,
    });
    expect(result.classification).toBe("pass");
    expect(await worktree.head()).toBe(checkpoint!.commit);
    expect(await worktree.hasTrackedChanges()).toBe(false);
    expect(await readFile(path.join(fixture.worktreePath, "ignored.tmp"), "utf8")).toBe(
      "generated",
    );
  });

  it("runs command sets sequentially and stops at the first failure", async () => {
    const { fixture, worktree, logRoot } = await checkedFixture();
    const results = await runCommandSet({
      repository: worktree,
      commands: [
        nodeCommand("first", 'console.log("first")'),
        nodeCommand("second", "process.exit(2)"),
        nodeCommand("third", 'console.log("must not run")'),
      ],
      commit: fixture.baseline,
      category: "smoke",
      logRoot,
      sequenceStart: 10,
    });
    expect(results.map((result) => result.checkId)).toEqual(["first", "second"]);
    expect(results.map((result) => result.classification)).toEqual(["pass", "product"]);
  });

  it("persists check intent before spawn and clears it only after the set completes", async () => {
    const { fixture, worktree, logRoot } = await checkedFixture();
    const store = new StateStore(fixture.repository.gitCommonDir);
    await store.initialize(
      createInitialState({
        gitCommonDir: fixture.repository.gitCommonDir,
        baselineCommit: fixture.baseline,
        branch: "recovery-loop/work",
        worktreePath: fixture.worktreePath,
        sessionId: "rl-check",
      }),
    );
    const results = await runJournaledCommandSet({
      store,
      repository: worktree,
      commands: [nodeCommand("journaled-pass", "process.exit(0)")],
      commit: fixture.baseline,
      category: "smoke",
      logRoot,
      sequenceStart: 1,
    });
    expect(results[0]?.classification).toBe("pass");
    const state = await store.readState();
    expect(state.phase).toBe("idle");
    expect(state.operation).toBeNull();
    expect(state.usage.checkMilliseconds).toBeGreaterThan(0);
    expect((await store.readEvents()).events.map((event) => event.type)).toEqual([
      "check-started",
      "check-completed",
    ]);
  });

  it("leaves a rerunnable phase when interrupted after intent but before spawn", async () => {
    const { fixture, worktree, logRoot } = await checkedFixture();
    const plainStore = new StateStore(fixture.repository.gitCommonDir);
    await plainStore.initialize(
      createInitialState({
        gitCommonDir: fixture.repository.gitCommonDir,
        baselineCommit: fixture.baseline,
        branch: "recovery-loop/work",
        worktreePath: fixture.worktreePath,
        sessionId: "rl-check",
      }),
    );
    const interruptedStore = new StateStore(fixture.repository.gitCommonDir, {
      afterIntentPersisted: () => {
        throw new Error("crash before command spawn");
      },
    });
    await expect(
      runJournaledCommandSet({
        store: interruptedStore,
        repository: worktree,
        commands: [nodeCommand("must-not-run", "process.exit(99)")],
        commit: fixture.baseline,
        category: "deep",
        logRoot,
        sequenceStart: 1,
      }),
    ).rejects.toThrow("crash before command spawn");
    expect((await plainStore.readState()).phase).toBe("deep-checking");
    const reconciled = await reconcileStartup(fixture.repository, plainStore);
    expect(reconciled.action).toBe("rerun-deep");
  });
});

describe("environment and confirmation", () => {
  it("removes credential-bearing environment variables and rejects unsafe overrides", () => {
    const environment = sanitizeEnvironment({
      PATH: process.env.PATH,
      ORDINARY_SETTING: "visible",
      RECOVERY_TEST_TOKEN: "hidden",
      AWS_SECRET_ACCESS_KEY: "hidden",
      NODE_OPTIONS: "--require=bad.js",
    });
    expect(environment.ORDINARY_SETTING).toBe("visible");
    expect(environment.RECOVERY_TEST_TOKEN).toBeUndefined();
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(environment.NODE_OPTIONS).toBeUndefined();
    expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
    expect(() => sanitizeEnvironment({}, { API_TOKEN: "value" })).toThrow("unsafe");
  });

  it("confirms fail/pass/fail and treats fail/pass/pass as flaky pass consensus", async () => {
    const failure = fakeResult("product", "failure-signature");
    const pass = fakeResult("pass", "pass-signature");
    const failPassFail = await confirmFailure(failure, async (attempt) =>
      attempt === 2 ? pass : failure,
    );
    expect(failPassFail).toMatchObject({
      confirmedFailure: true,
      consensus: "fail",
      classification: "product",
    });
    expect(failPassFail.attempts).toHaveLength(3);

    const failPassPass = await confirmFailure(failure, async () => pass);
    expect(failPassPass).toMatchObject({
      confirmedFailure: false,
      consensus: "pass",
      classification: "flaky",
    });
    expect(failPassPass.attempts).toHaveLength(3);

    const resumedAttempts: number[] = [];
    const resumed = await confirmFailure(failure, async (attempt) => {
      resumedAttempts.push(attempt);
      return failure;
    }, [failure, pass]);
    expect(resumed).toMatchObject({ confirmedFailure: true, consensus: "fail" });
    expect(resumedAttempts).toEqual([3]);
  });
});

function fakeResult(classification: "pass" | "product", signature: string): CommandResult {
  return {
    checkId: "test",
    argv: ["test"],
    commit: "a".repeat(40),
    startedAt: "2026-08-07T20:00:00.000Z",
    finishedAt: "2026-08-07T20:00:01.000Z",
    durationMs: 1_000,
    exitCode: classification === "pass" ? 0 : 1,
    signal: null,
    timedOut: false,
    classification,
    signature,
    worktreeChanged: false,
    stdoutPath: null,
    stderrPath: null,
    stdoutTail: "",
    stderrTail: "",
    error: null,
  };
}
