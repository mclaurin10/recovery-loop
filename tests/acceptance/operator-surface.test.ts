import { access, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkRepository,
  initializeRepository,
  readStatusSnapshot,
  renderRunSummary,
  renderStatus,
} from "../../src/cli.js";
import { StateStore } from "../../src/state-store.js";
import {
  createTemporaryRepository,
  type TemporaryRepository,
} from "../support/temporary-repository.js";

const fixtures: TemporaryRepository[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => fixture.cleanup()));
});
async function fixture(): Promise<TemporaryRepository> {
  const created = await createTemporaryRepository();
  fixtures.push(created);
  return created;
}

describe("Stage 10 operator surface", () => {
  it("scaffolds missing authority and exits without branch or runtime state", async () => {
    const test = await fixture();
    await rm(path.join(test.projectPath, "RECOVERY_GOAL.md"));
    await rm(path.join(test.projectPath, ".recovery-loop", "config.json"));

    const result = await initializeRepository(test.projectPath, {});

    expect(result).toMatchObject({
      kind: "scaffolded",
      created: ["RECOVERY_GOAL.md", ".recovery-loop/config.json"],
    });
    const generated = JSON.parse(
      await readFile(path.join(test.projectPath, ".recovery-loop", "config.json"), "utf8"),
    ) as { checks: { smoke: Array<{ argv: string[] }>; deep: Array<{ argv: string[] }> } };
    const expectedPrefix = process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", "pnpm"]
      : ["pnpm"];
    expect(generated.checks.smoke[0]?.argv.slice(0, expectedPrefix.length)).toEqual(expectedPrefix);
    expect(generated.checks.deep[0]?.argv.slice(0, expectedPrefix.length)).toEqual(expectedPrefix);
    expect(await test.repository.branchHead("recovery-loop/work")).toBeNull();
    await expect(access(path.join(test.repository.gitCommonDir, "recovery-loop", "state.json")))
      .rejects.toThrow();
  });

  it("initializes a healthy isolated baseline and exposes truthful read-only status", async () => {
    const test = await fixture();
    const operatorBranch = await test.repository.currentBranch();
    const operatorHead = await test.repository.head();
    const result = await initializeRepository(test.projectPath, { worktree: test.worktreePath });
    expect(result).toMatchObject({
      kind: "initialized",
      branch: "recovery-loop/work",
      baselineCommit: operatorHead,
      knownGoodCommit: operatorHead,
      pendingFailure: null,
    });
    expect(await test.repository.currentBranch()).toBe(operatorBranch);
    expect(await test.repository.head()).toBe(operatorHead);

    const store = new StateStore(test.repository.gitCommonDir);
    await store.update((draft) => {
      draft.session.startedAt = "2026-08-07T20:00:00.000Z";
      draft.session.finishedAt = "2026-08-07T20:00:05.000Z";
    });
    const stateBefore = await readFile(store.statePath, "utf8");
    const namesBefore = await readdir(store.runtimeRoot);
    const status = await readStatusSnapshot(test.projectPath);
    expect(status).toMatchObject({
      schemaVersion: 1,
      actualHead: operatorHead,
      expectedHead: operatorHead,
      headMatchesExpected: true,
      knownGoodCommit: operatorHead,
      knownGoodRelation: "at-head",
      commitsSinceKnownGood: 0,
      lastSmoke: { commit: operatorHead, completeSetPassed: true },
      lastDeep: { commit: operatorHead, completeSetPassed: true },
      pendingFailure: null,
      sessionStatus: "stopped",
      stopReason: "initialized",
      phase: "stopped",
      lock: { status: "none" },
      usage: { sessionElapsedMilliseconds: 5_000 },
    });
    expect(renderStatus(status)).toContain("current head (autonomous branch tip; may be unhealthy)");
    expect(renderStatus(status)).toContain("known-good anchor (last complete smoke+deep pass)");
    expect(JSON.parse(JSON.stringify(status))).toEqual(status);
    expect(await readFile(store.statePath, "utf8")).toBe(stateBefore);
    expect(await readdir(store.runtimeRoot)).toEqual(namesBefore);
  });

  it("runs manual smoke and deep sets without an agent and restores stopped phase", async () => {
    const test = await fixture();
    const initialized = await initializeRepository(test.projectPath, { worktree: test.worktreePath });
    expect(initialized.kind).toBe("initialized");
    const store = new StateStore(test.repository.gitCommonDir);
    await store.update((draft) => {
      draft.phase = "stopped";
      draft.session.status = "stopped";
      draft.session.stopReason = "operator-test";
    });

    const result = await checkRepository(test.projectPath, true);

    expect(result.requestedChecksPassed).toBe(true);
    expect(result.observation.smokeResults).toHaveLength(1);
    expect(result.observation.deepResults).toHaveLength(1);
    expect((await store.readState()).phase).toBe("stopped");
    expect((await store.peekLock()).status).toBe("none");
  });

  it("records a failed baseline prepare as infrastructure without promoting known-good", async () => {
    const test = await fixture();
    const configPath = path.join(test.projectPath, ".recovery-loop", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.prepare = {
      argv: [process.execPath, "-e", "process.exit(7)"],
      timeoutSeconds: 5,
      triggerPaths: ["package.json"],
    };
    await test.write(test.projectPath, ".recovery-loop/config.json", `${JSON.stringify(config, null, 2)}\n`);
    await test.commit(test.projectPath, "configure failing baseline prepare");

    const result = await initializeRepository(test.projectPath, { worktree: test.worktreePath });

    expect(result).toMatchObject({
      kind: "initialized",
      knownGoodCommit: null,
      pendingFailure: {
        checkId: "prepare-baseline",
        classification: "infrastructure",
      },
    });
    const events = (await new StateStore(test.repository.gitCommonDir).readEvents()).events;
    expect(events.filter((event) => event.type === "check-completed").map((event) => event.data.category))
      .toEqual(["prepare", "smoke", "deep"]);
  });

  it("renders completion belief, command health, and external correctness separately", () => {
    const rendered = renderRunSummary({
      sessionId: "rl-release",
      stopReason: "goal-candidate-ready",
      finalCommit: "a".repeat(40),
      knownGoodCommit: "a".repeat(40),
      agentCompletionBelief: true,
      finalHeadReceivedDeepPass: true,
      checkpoints: 2,
      repairCheckpoints: 1,
      reverts: 0,
      hardRollbacks: 0,
    });
    expect(rendered).toContain("agent completion claim: reported by agent");
    expect(rendered).toContain("final command health: complete smoke+deep pass at current head");
    expect(rendered).toContain("external correctness: not evaluated by Recovery Loop");
  });
});
