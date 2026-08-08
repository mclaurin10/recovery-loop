import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAgentGateway } from "../../src/agent-gateway.js";
import { loadConfig } from "../../src/config.js";
import { checkBaseline, runNormalController } from "../../src/controller.js";
import { initializeJournaledWorkspace } from "../../src/git-operations.js";
import type { GitRepository } from "../../src/git-repository.js";
import { StateStore } from "../../src/state-store.js";
import { ScriptedAgentSdk, type ScriptedAgentStep } from "../support/scripted-agent.js";
import { createTemporaryRepository, type TemporaryRepository } from "../support/temporary-repository.js";

const fixtures: TemporaryRepository[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())));

interface Initialized {
  fixture: TemporaryRepository;
  store: StateStore;
  worktree: GitRepository;
}
interface MutableTestConfig {
  checks: { smoke: unknown[]; deep: unknown[] };
  deepPolicy: { everyCheckpoints: number; maxMinutes: number; [key: string]: unknown };
  [key: string]: unknown;
}
function response(outcome: "changed" | "no_change" | "goal_complete" | "blocked", summary: string, blocker: string | null = null) {
  return { outcome, summary, nextHint: null, blocker };
}
async function fixture(): Promise<TemporaryRepository> {
  const created = await createTemporaryRepository();
  fixtures.push(created);
  return created;
}
async function initialize(created: TemporaryRepository): Promise<Initialized> {
  const store = new StateStore(created.repository.gitCommonDir);
  const result = await initializeJournaledWorkspace({
    operatorRepository: created.repository,
    store,
    branch: "recovery-loop/work",
    worktreePath: created.worktreePath,
    sessionId: `rl-run-${fixtures.length}`,
  });
  return { fixture: created, store, worktree: result.worktree };
}
async function updateConfig(created: TemporaryRepository, mutate: (config: MutableTestConfig) => void): Promise<void> {
  const configPath = path.join(created.projectPath, ".recovery-loop", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as MutableTestConfig;
  mutate(config);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await created.commit(created.projectPath, "configure controller test");
}
function markerCommand(id: string, marker: string) {
  return { id, argv: [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "${id}\\n")`], timeoutSeconds: 5 };
}
async function markerCount(marker: string): Promise<number> {
  try { return (await readFile(marker, "utf8")).trim().split(/\r?\n/u).filter(Boolean).length; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
}
async function run(initialized: Initialized, steps: readonly ScriptedAgentStep[], options: Parameters<typeof runNormalController>[0]["limits"] = {}) {
  const sdk = new ScriptedAgentSdk(steps);
  const result = await runNormalController({
    repository: initialized.fixture.repository,
    store: initialized.store,
    gateway: new CodexAgentGateway(sdk),
    limits: options,
  });
  sdk.assertFinished();
  return { result, sdk };
}

describe("Stage 7 normal controller cycles", () => {
  it("creates controller checkpoints, smokes each one, honors deep cadence, and completes at exact HEAD", async () => {
    const created = await fixture();
    const smokeMarker = path.join(created.root, "smoke.txt");
    const deepMarker = path.join(created.root, "deep.txt");
    await updateConfig(created, (config) => {
      config.checks.smoke = [markerCommand("smoke", smokeMarker)];
      config.checks.deep = [markerCommand("deep", deepMarker)];
      config.deepPolicy.everyCheckpoints = 2;
      config.deepPolicy.maxMinutes = 999;
    });
    const test = await initialize(created);
    const steps: ScriptedAgentStep[] = [
      { method: "start", response: response("changed", "add first unit"), action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "one.txt"), "one\n") },
      { method: "resume", response: response("changed", "add second unit"), action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "two.txt"), "two\n") },
      { method: "resume", response: response("goal_complete", "add final unit"), action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "three.txt"), "three\n") },
    ];
    const { result } = await run(test, steps);
    const state = await test.store.readState();
    expect(result.summary).toMatchObject({
      stopReason: "goal-candidate-ready", checkpoints: 3, smokeExecutions: 4,
      deepExecutions: 3, agentTurns: 3, agentCompletionBelief: true,
      finalHeadReceivedDeepPass: true, externalCorrectnessEvaluated: false,
      externalCorrectness: null, pendingFailure: null,
    });
    expect(await markerCount(smokeMarker)).toBe(4);
    expect(await markerCount(deepMarker)).toBe(3);
    expect(state.health.knownGoodCommit).toBe(await test.worktree.head());
    const authors = (await test.worktree.git(["log", `${state.repository.baselineCommit}..HEAD`, "--format=%an"])).stdout.trim().split(/\r?\n/u);
    expect(authors).toEqual(["Recovery Loop", "Recovery Loop", "Recovery Loop"]);
    expect(JSON.parse(await readFile(result.summaryPath, "utf8"))).toEqual(result.summary);
    expect(result.summary).not.toHaveProperty("productSuccess");
  }, 60_000);

  it("runs an already-due deep set without new work before invoking the agent", async () => {
    const created = await fixture();
    const deepMarker = path.join(created.root, "due-deep.txt");
    await updateConfig(created, (config) => { config.checks.deep = [markerCommand("deep", deepMarker)]; });
    const test = await initialize(created);
    const config = await loadConfig(created.worktreePath);
    await checkBaseline({ store: test.store, repository: test.worktree, config, now: "2026-08-07T20:00:00.000Z" });
    await test.store.update((draft) => { draft.cadence.deepRequired = true; draft.cadence.deepReasons = ["operator-due"]; });
    let observedBeforeTurn = 0;
    const { result } = await run(test, [{
      method: "start", response: response("goal_complete", "no further edits needed"),
      action: async () => { observedBeforeTurn = await markerCount(deepMarker); },
    }]);
    expect(observedBeforeTurn).toBe(2);
    expect(await markerCount(deepMarker)).toBe(3);
    expect(result.summary.stopReason).toBe("goal-candidate-ready");
  });

  it("normalizes descendant agent commits and rotates the Stage 6 thread boundary", async () => {
    const created = await fixture();
    const test = await initialize(created);
    const { result, sdk } = await run(test, [
      {
        method: "start", threadId: "violating-thread", response: response("changed", "preserve useful committed edit"),
        action: async ({ workingDirectory }) => {
          await writeFile(path.join(workingDirectory, "committed-by-agent.txt"), "useful\n");
          await created.commit(workingDirectory, "agent-created commit");
        },
      },
      {
        method: "start", threadId: "rotated-thread", response: response("goal_complete", "finish after rotation"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "after-rotation.txt"), "fresh thread\n"),
      },
    ]);
    expect(result.summary.stopReason).toBe("goal-candidate-ready");
    expect(result.summary.rescueRefs).toEqual([expect.stringContaining("agent-history")]);
    expect(sdk.calls.map((call) => call.method)).toEqual(["start", "start"]);
    const state = await test.store.readState();
    expect((await test.worktree.git(["log", `${state.repository.baselineCommit}..HEAD`, "--format=%an"])).stdout).not.toContain("Fixture User");
    expect((await test.worktree.git(["branch", "--list", "recovery-loop/rescue/*-agent-history"])).stdout).toContain("agent-history");
    const events = (await test.store.readEvents()).events;
    expect(events.some((event) => event.type === "thread-rotated" && event.data.reason === "agent-history-violation")).toBe(true);
  }, 60_000);

  it("persists a failing completion check and cleanly reverts at the Stage 9 boundary", async () => {
    const created = await fixture();
    await updateConfig(created, (config) => {
      config.checks.deep = [{
        id: "deep", timeoutSeconds: 5,
        argv: [process.execPath, "-e", "const t=require('node:fs').readFileSync('source.txt','utf8');process.exit(t.includes('bad')?7:0)"],
      }];
    });
    const test = await initialize(created);
    const { result } = await run(test, [
      {
        method: "start", response: response("goal_complete", "all configured checks passed"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "bad\n"),
      },
      { method: "resume", response: response("no_change", "first repair found no safe edit") },
      { method: "resume", response: response("no_change", "second repair found no safe edit") },
      { method: "start", response: response("goal_complete", "complete after controller revert") },
    ]);
    const state = await test.store.readState();
    expect(result.summary).toMatchObject({ stopReason: "goal-candidate-ready", agentCompletionBelief: true,
      finalHeadReceivedDeepPass: true, confirmedRegressions: 1, repairTurns: 2, reverts: 1,
      pendingFailure: null });
    expect(state.phase).toBe("stopped");
    expect(state.health.pendingFailure).toBeNull();
    expect(state.health.knownGoodCommit).toBe(await test.worktree.head());
    expect(await test.worktree.commitCount(`${state.repository.baselineCommit}..HEAD`)).toBe(2);
  }, 60_000);

  it("treats a valid hard blocker as terminal without inventing recovery work", async () => {
    const created = await fixture();
    const test = await initialize(created);
    const { result } = await run(test, [{
      method: "start", response: response("blocked", "required external service is unavailable", "required external service is unavailable"),
    }]);
    expect(result.summary).toMatchObject({ stopReason: "blocked", stopDetail: "required external service is unavailable", checkpoints: 0 });
    expect((await test.store.readState()).health.pendingFailure).toBeNull();
  });
});

describe("Stage 7 bounded stops and interruption", () => {
  it("enforces agent-turn and checkpoint limits", async () => {
    const turns = await initialize(await fixture());
    const turnRun = await run(turns, [{ method: "start", response: response("no_change", "nothing useful yet") }], { maxAgentTurns: 1 });
    expect(turnRun.result.summary).toMatchObject({ stopReason: "max-agent-turns", agentTurns: 1, checkpoints: 0 });

    const checkpoints = await initialize(await fixture());
    const checkpointRun = await run(checkpoints, [{
      method: "start", response: response("changed", "one bounded checkpoint"),
      action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "bounded.txt"), "bounded\n"),
    }], { maxCheckpoints: 1 });
    expect(checkpointRun.result.summary).toMatchObject({ stopReason: "max-checkpoints", checkpoints: 1, agentTurns: 1 });
  });

  it("enforces the wall-time limit before another agent turn", async () => {
    const test = await initialize(await fixture());
    await test.store.update((draft) => { draft.session.startedAt = "2026-08-07T20:00:00.000Z"; });
    const sdk = new ScriptedAgentSdk([]);
    const result = await runNormalController({
      repository: test.fixture.repository, store: test.store, gateway: new CodexAgentGateway(sdk),
      limits: { maxMinutes: 1 }, clock: () => new Date("2026-08-07T20:01:00.000Z"),
    });
    sdk.assertFinished();
    expect(result.summary).toMatchObject({ stopReason: "max-wall-time", agentTurns: 0 });
  });

  it("stops after two useful-work misses and resets the streak after a checkpoint", async () => {
    const test = await initialize(await fixture());
    const { result } = await run(test, [
      { method: "start", response: response("no_change", "first miss") },
      { method: "resume", response: response("changed", "useful reset"), action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "reset.txt"), "useful\n") },
      { method: "resume", response: response("no_change", "miss after useful work") },
      { method: "resume", response: response("changed", "claimed change without edits") },
    ]);
    expect(result.summary).toMatchObject({ stopReason: "no-progress", agentTurns: 4, checkpoints: 1 });
    expect((await test.store.readState()).agent.consecutiveNoChange).toBe(2);
  });

  it("cancels an active agent turn, preserves useful edits, and continues safely on the next run", async () => {
    const test = await initialize(await fixture());
    const abort = new AbortController();
    const sdk = new ScriptedAgentSdk([{
      method: "start", threadId: "interrupted-thread", waitForAbort: true,
      action: async ({ workingDirectory }) => {
        await writeFile(path.join(workingDirectory, "interrupted.txt"), "preserve me\n");
        abort.abort(new Error("SIGINT"));
      },
    }]);
    const interrupted = await runNormalController({
      repository: test.fixture.repository, store: test.store, gateway: new CodexAgentGateway(sdk), signal: abort.signal,
    });
    sdk.assertFinished();
    const interruptedState = await test.store.readState();
    expect(interrupted.summary).toMatchObject({ stopReason: "signal", checkpoints: 1 });
    expect(await readFile(path.join(test.fixture.worktreePath, "interrupted.txt"), "utf8")).toBe("preserve me\n");
    expect(interruptedState.health.lastSmokePassCommit).toBe(await test.worktree.head());

    const resumed = await run(test, [{ method: "resume", response: response("goal_complete", "interrupted work satisfies the goal") }]);
    expect(resumed.result.summary).toMatchObject({ stopReason: "goal-candidate-ready", finalHeadReceivedDeepPass: true });
  });

  it("defers SIGINT observed after checkpoint creation until mandatory checks finish", async () => {
    const test = await initialize(await fixture());
    const abort = new AbortController();
    const sdk = new ScriptedAgentSdk([{
      method: "start", response: response("changed", "checkpoint before signal"),
      action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "after-checkpoint.txt"), "saved\n"),
    }]);
    const result = await runNormalController({
      repository: test.fixture.repository, store: test.store, gateway: new CodexAgentGateway(sdk), signal: abort.signal,
      hooks: { afterCheckpointMutation: () => abort.abort(new Error("SIGINT")) },
    });
    sdk.assertFinished();
    const state = await test.store.readState();
    expect(result.summary).toMatchObject({ stopReason: "signal", checkpoints: 1, smokeExecutions: 2 });
    expect(state.health.lastSmokePassCommit).toBe(await test.worktree.head());
    expect(state.operation).toBeNull();
  });

  it("reconciles a crash after commit exactly once before continuing", async () => {
    const test = await initialize(await fixture());
    const firstSdk = new ScriptedAgentSdk([{
      method: "start", threadId: "crashed-thread", response: response("changed", "checkpoint survives crash"),
      action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "crash.txt"), "once\n"),
    }]);
    await expect(runNormalController({
      repository: test.fixture.repository, store: test.store, gateway: new CodexAgentGateway(firstSdk),
      hooks: { afterCheckpointMutation: () => { throw new Error("crash after checkpoint"); } },
    })).rejects.toThrow("crash after checkpoint");
    firstSdk.assertFinished();
    expect((await test.store.readState()).phase).toBe("checkpointing");

    const resumed = await run(test, [{ method: "resume", response: response("goal_complete", "finish after reconciliation") }]);
    const state = await test.store.readState();
    expect(resumed.result.summary.stopReason).toBe("goal-candidate-ready");
    expect(await test.worktree.commitCount(`${state.repository.baselineCommit}..HEAD`)).toBe(1);
    const checkpointEvents = (await test.store.readEvents()).events.filter((event) => event.type === "checkpoint-created");
    expect(checkpointEvents).toHaveLength(1);
  });

  it("reconciles a stopped session journal before creating the next session", async () => {
    const test = await initialize(await fixture());
    const before = await test.store.readState();
    await test.store.update((draft) => {
      draft.session.status = "stopped";
      draft.session.stopReason = "operator-check";
      draft.phase = "smoke-checking";
      draft.operation = {
        id: "op-live-smoke",
        kind: "check",
        unitId: "smoke",
        baseCommit: before.repository.expectedHead,
        targetCommit: before.repository.expectedHead,
        observedHead: before.repository.expectedHead,
        rescueRef: null,
        childPid: process.pid,
        summary: "smoke command set",
        checkpointKind: null,
        startedAt: new Date().toISOString(),
      };
    });
    await expect(runNormalController({
      repository: test.fixture.repository,
      store: test.store,
      gateway: new CodexAgentGateway(new ScriptedAgentSdk([])),
    })).rejects.toThrow(`recorded command PID ${process.pid} is still alive`);
    const after = await test.store.readState();
    expect(after.session.id).toBe(before.session.id);
    expect(after.phase).toBe("smoke-checking");
    expect(after.operation?.id).toBe("op-live-smoke");
  });

  it("refuses lock contention and leaves the active owner intact", async () => {
    const test = await initialize(await fixture());
    const lock = await test.store.acquireLock("run");
    try {
      await expect(runNormalController({
        repository: test.fixture.repository, store: test.store,
        gateway: new CodexAgentGateway(new ScriptedAgentSdk([])),
      })).rejects.toThrow(`controller is already running as PID ${process.pid}`);
      expect((await test.store.peekLock()).status).toBe("valid");
    } finally { await lock.release(); }
  });
});
