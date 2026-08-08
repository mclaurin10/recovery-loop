import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAgentGateway } from "../../src/agent-gateway.js";
import { runNormalController, type RunControllerHooks } from "../../src/controller.js";
import { initializeJournaledWorkspace } from "../../src/git-operations.js";
import type { GitRepository } from "../../src/git-repository.js";
import { StateStore } from "../../src/state-store.js";
import { ScriptedAgentSdk, type ScriptedAgentStep } from "../support/scripted-agent.js";
import {
  createTemporaryRepository,
  type TemporaryRepository,
} from "../support/temporary-repository.js";

const fixtures: TemporaryRepository[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())));

interface RestartFixture {
  fixture: TemporaryRepository;
  store: StateStore;
  worktree: GitRepository;
}
interface MutableConfig {
  checks: { smoke: unknown[]; deep: unknown[] };
  limits: { maxRepairTurnsPerFailure: number };
  deepPolicy: { everyCheckpoints: number; maxMinutes: number };
}

function response(outcome: "changed" | "no_change" | "goal_complete", summary: string) {
  return { outcome, summary, nextHint: null, blocker: null };
}
function passCommand(id: string) {
  return { id, timeoutSeconds: 5, argv: [process.execPath, "-e", "process.exit(0)"] };
}
function deepCommand() {
  return { id: "deep", timeoutSeconds: 5, bisectable: true,
    argv: [process.execPath, "-e",
      'const t=require("node:fs").readFileSync("source.txt","utf8");process.exit(t.includes("bad")?7:0)'] };
}
function edit(contents: string, summary: string, method: "start" | "resume" = "resume"): ScriptedAgentStep {
  return { method, response: response("changed", summary),
    action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), contents) };
}

async function createFixture(cadence: number): Promise<RestartFixture> {
  const fixture = await createTemporaryRepository();
  fixtures.push(fixture);
  const configPath = path.join(fixture.projectPath, ".recovery-loop", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as MutableConfig;
  config.checks.smoke = [passCommand("smoke")];
  config.checks.deep = [deepCommand()];
  config.deepPolicy.everyCheckpoints = cadence;
  config.deepPolicy.maxMinutes = 999;
  config.limits.maxRepairTurnsPerFailure = 1;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fixture.commit(fixture.projectPath, "configure restart scenario");
  const store = new StateStore(fixture.repository.gitCommonDir);
  const initialized = await initializeJournaledWorkspace({
    operatorRepository: fixture.repository,
    store,
    branch: "recovery-loop/work",
    worktreePath: fixture.worktreePath,
    sessionId: `rl-stage9-restart-${fixtures.length}`,
  });
  return { fixture, store, worktree: initialized.worktree };
}

async function runWithCrashAndResume(
  test: RestartFixture,
  steps: readonly ScriptedAgentStep[],
  hooks: RunControllerHooks,
) {
  const sdk = new ScriptedAgentSdk(steps);
  await expect(runNormalController({
    repository: test.fixture.repository,
    store: test.store,
    gateway: new CodexAgentGateway(sdk),
    hooks,
  })).rejects.toThrow("injected Stage 9 crash");
  const interrupted = await test.store.readState();
  const result = await runNormalController({
    repository: test.fixture.repository,
    store: test.store,
    gateway: new CodexAgentGateway(sdk),
  });
  sdk.assertFinished();
  return { interrupted, result, events: (await test.store.readEvents()).events };
}

describe("Stage 9 localization restart", () => {
  it.each(["worktree", "command"] as const)(
    "restarts bounded localization after interruption during diagnostic %s handling",
    async (boundary) => {
      const test = await createFixture(1);
      let injected = false;
      const crash = (): void => {
        if (injected) return;
        injected = true;
        throw new Error("injected Stage 9 crash");
      };
      const hooks: RunControllerHooks = boundary === "worktree"
        ? { afterDiagnosticWorktree: crash }
        : { afterHistoricalCommand: crash };
      const { interrupted, result, events } = await runWithCrashAndResume(test, [
        edit("bad\n", "introduce direct regression", "start"),
        edit("fixed\n", "repair after restarted localization"),
        { method: "resume", response: response("goal_complete", "complete after restart") },
      ], hooks);
      expect(interrupted.phase).toBe("diagnosing");
      expect(interrupted.health.pendingFailure?.localization?.status).toBe("running");
      expect(result.summary).toMatchObject({
        stopReason: "goal-candidate-ready",
        regressionsLocalized: 1,
        pendingFailure: null,
      });
      expect(events.filter((event) => event.type === "regression-localized")).toHaveLength(1);
      expect(events.filter((event) => event.type === "localization-started")).toHaveLength(1);
    },
    90_000,
  );
});

describe("Stage 9 revert and reset restart", () => {
  it("adopts a clean revert commit after a crash before recovery state completion", async () => {
    const test = await createFixture(1);
    let injected = false;
    const { interrupted, result, events } = await runWithCrashAndResume(test, [
      edit("bad\n", "introduce revertable regression", "start"),
      { method: "resume", response: response("no_change", "repair exhausted") },
      { method: "start", response: response("goal_complete", "complete after adopted revert") },
    ], {
      afterRevertMutation: () => {
        if (injected) return;
        injected = true;
        throw new Error("injected Stage 9 crash");
      },
    });
    expect(interrupted.phase).toBe("rolling-back");
    expect(interrupted.operation?.kind).toBe("revert");
    expect(result.summary).toMatchObject({ stopReason: "goal-candidate-ready", reverts: 1 });
    expect(events.filter((event) => event.type === "revert-created")).toHaveLength(1);
    const messages = (await test.worktree.git(["log", "--format=%B%x00"])).stdout;
    expect(messages.match(/Recovery-Loop-Kind: revert/gu)).toHaveLength(1);
    expect((await test.store.readState()).recovery.pendingAction).toBeNull();
  }, 90_000);

  it("records a conflicting-revert outcome before a crash and continues to one rescue/reset", async () => {
    const test = await createFixture(2);
    let injected = false;
    const { interrupted, result, events } = await runWithCrashAndResume(test, [
      edit("bad-one\n", "bad first edit", "start"),
      edit("bad-two\n", "entangled second edit"),
      { method: "resume", response: response("no_change", "repair exhausted") },
      { method: "start", response: response("goal_complete", "continue after reset") },
    ], {
      afterRevertMutation: () => {
        if (injected) return;
        injected = true;
        throw new Error("injected Stage 9 crash");
      },
    });
    expect(interrupted.operation?.summary).toBe("revert-conflicted");
    expect(result.summary).toMatchObject({ stopReason: "goal-candidate-ready", hardRollbacks: 1 });
    expect(events.filter((event) => event.type === "rollback-completed")).toHaveLength(1);
    expect((await test.store.readState()).recovery.abandonedRanges).toHaveLength(1);
  }, 90_000);

  it.each(["rescue", "reset", "state"] as const)(
    "reconciles a crash after %s boundary without duplicating rescue/reset/abandonment",
    async (boundary) => {
      const test = await createFixture(2);
      let injected = false;
      const crash = (): void => {
        if (injected) return;
        injected = true;
        throw new Error("injected Stage 9 crash");
      };
      const hooks: RunControllerHooks = boundary === "rescue"
        ? { afterRescueVerified: crash }
        : boundary === "reset" ? { afterReset: crash } : { afterRollbackState: crash };
      const { interrupted, result, events } = await runWithCrashAndResume(test, [
        edit("bad-one\n", "bad first edit", "start"),
        edit("bad-two\n", "entangled second edit"),
        { method: "resume", response: response("no_change", "repair exhausted") },
        { method: "start", response: response("goal_complete", "continue from restored goal") },
      ], hooks);
      const interruptedAction = interrupted.recovery.pendingAction;
      expect(interruptedAction?.kind).toBe("reset");
      if (boundary === "rescue") {
        expect(interrupted.phase).toBe("rolling-back");
        expect(await test.worktree.head()).not.toBe(interruptedAction?.oldHead);
      }
      expect(result.summary).toMatchObject({
        stopReason: "goal-candidate-ready",
        hardRollbacks: 1,
        abandonedDirections: 1,
      });
      const state = await test.store.readState();
      expect(state.recovery.rescueRefs).toHaveLength(1);
      expect(state.recovery.abandonedRanges).toHaveLength(1);
      expect(events.filter((event) => event.type === "rollback-completed")).toHaveLength(1);
      expect(events.filter((event) => event.type === "direction-abandoned")).toHaveLength(1);
      expect(await test.worktree.branchHead(state.recovery.rescueRefs[0]!)).toBe(
        state.recovery.abandonedRanges[0]?.oldHead,
      );
    },
    90_000,
  );
});

describe("Stage 9 recovery-health replay", () => {
  it.each(["revert-smoke", "reset-deep"] as const)(
    "replays the complete exact-head health set after interruption during %s validation",
    async (boundary) => {
      const reset = boundary === "reset-deep";
      const test = await createFixture(reset ? 2 : 1);
      let injected = false;
      const crashWhenAction = async (kind: "revert" | "reset"): Promise<void> => {
        const action = (await test.store.readState()).recovery.pendingAction;
        if (injected || action?.kind !== kind) return;
        injected = true;
        throw new Error("injected Stage 9 crash");
      };
      const steps: ScriptedAgentStep[] = reset
        ? [
            edit("bad-one\n", "bad first edit", "start"),
            edit("bad-two\n", "entangled second edit"),
            { method: "resume", response: response("no_change", "repair exhausted") },
            { method: "start", response: response("goal_complete", "complete after reset replay") },
          ]
        : [
            edit("bad\n", "revertable bad edit", "start"),
            { method: "resume", response: response("no_change", "repair exhausted") },
            { method: "start", response: response("goal_complete", "complete after revert replay") },
          ];
      const hooks: RunControllerHooks = reset
        ? { afterRecoveryDeepCommand: () => crashWhenAction("reset") }
        : { afterRecoverySmokeCommand: () => crashWhenAction("revert") };
      const { interrupted, result, events } = await runWithCrashAndResume(test, steps, hooks);
      expect(interrupted.phase).toBe(reset ? "deep-checking" : "smoke-checking");
      expect(result.summary.stopReason).toBe("goal-candidate-ready");
      const actionCommit = interrupted.recovery.pendingAction?.resultCommit;
      expect(actionCommit).not.toBeNull();
      expect(events.some((event) =>
        event.type === "check-completed" && event.headCommit === actionCommit &&
        event.data.category === "smoke")).toBe(true);
      expect(events.some((event) =>
        event.type === "check-completed" && event.headCommit === actionCommit &&
        event.data.category === "deep")).toBe(true);
      expect((await test.store.readState()).health.knownGoodCommit).not.toBeNull();
    },
    90_000,
  );
});
