import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAgentGateway } from "../../src/agent-gateway.js";
import { runNormalController } from "../../src/controller.js";
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

interface Stage9Fixture {
  fixture: TemporaryRepository;
  store: StateStore;
  worktree: GitRepository;
}
interface MutableConfig {
  checks: { smoke: unknown[]; deep: unknown[] };
  limits: {
    maxRepairTurnsPerFailure: number;
    maxRecoveryCyclesPerSignature: number;
    maxLocalizationCommits: number;
  };
  deepPolicy: { everyCheckpoints: number; maxMinutes: number };
  prepare: unknown;
}

function response(outcome: "changed" | "no_change" | "goal_complete", summary: string) {
  return { outcome, summary, nextHint: null, blocker: null };
}
function passCommand(id: string) {
  return { id, timeoutSeconds: 5, argv: [process.execPath, "-e", "process.exit(0)"] };
}
function sourceCommand(id: string, rejected: string, bisectable = true) {
  return {
    id,
    timeoutSeconds: 5,
    bisectable,
    argv: [process.execPath, "-e",
      `const t=require("node:fs").readFileSync("source.txt","utf8");process.exit(t.includes(${JSON.stringify(rejected)})?7:0)`],
  };
}
function editSource(
  contents: string,
  summary: string,
  method: "start" | "resume" = "resume",
): ScriptedAgentStep {
  return {
    method,
    response: response("changed", summary),
    action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), contents),
  };
}

async function createFixture(mutate: (config: MutableConfig, fixture: TemporaryRepository) => void): Promise<Stage9Fixture> {
  const fixture = await createTemporaryRepository();
  fixtures.push(fixture);
  const configPath = path.join(fixture.projectPath, ".recovery-loop", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as MutableConfig;
  mutate(config, fixture);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fixture.commit(fixture.projectPath, "configure Stage 9 scenario");
  const store = new StateStore(fixture.repository.gitCommonDir);
  const initialized = await initializeJournaledWorkspace({
    operatorRepository: fixture.repository,
    store,
    branch: "recovery-loop/work",
    worktreePath: fixture.worktreePath,
    sessionId: `rl-stage9-${fixtures.length}`,
  });
  return { fixture, store, worktree: initialized.worktree };
}

async function run(test: Stage9Fixture, steps: readonly ScriptedAgentStep[]) {
  const sdk = new ScriptedAgentSdk(steps);
  const result = await runNormalController({
    repository: test.fixture.repository,
    store: test.store,
    gateway: new CodexAgentGateway(sdk),
  });
  sdk.assertFinished();
  return { result, sdk };
}

describe("Stage 9 delayed localization", () => {
  it("localizes the second of five commits on first-parent history and forwards exact evidence to the same repair role", async () => {
    const test = await createFixture((config) => {
      config.checks.smoke = [passCommand("smoke")];
      config.checks.deep = [sourceCommand("deep", "latent-bad")];
      config.deepPolicy.everyCheckpoints = 5;
      config.deepPolicy.maxMinutes = 999;
    });
    const { result, sdk } = await run(test, [
      { ...editSource("baseline\ngood-one\n", "add first safe change"), method: "start" },
      editSource("baseline\ngood-one\nlatent-bad\n", "introduce delayed regression"),
      editSource("baseline\ngood-one\nlatent-bad\nthree\n", "add third change"),
      editSource("baseline\ngood-one\nlatent-bad\nthree\nfour\n", "add fourth change"),
      editSource("baseline\ngood-one\nlatent-bad\nthree\nfour\nfive\n", "add fifth change"),
      {
        method: "resume",
        response: response("changed", "repair the localized second commit regression"),
        action: ({ workingDirectory }) => writeFile(
          path.join(workingDirectory, "source.txt"),
          "baseline\ngood-one\nrepaired\nthree\nfour\nfive\n",
        ),
      },
      { method: "resume", response: response("goal_complete", "complete after localized repair") },
    ]);
    const events = (await test.store.readEvents()).events;
    const workCommits = events.filter((event) =>
      event.type === "checkpoint-created" && event.data.kind === "work");
    const localized = events.find((event) => event.type === "regression-localized");
    expect(workCommits).toHaveLength(5);
    expect(localized?.data.firstBadCommit).toBe(workCommits[1]?.headCommit);
    expect(localized?.data.regressionWindow).toEqual([
      workCommits[0]?.headCommit,
      workCommits[1]?.headCommit,
    ]);
    expect(sdk.calls[5]?.prompt).toContain(`"firstBadCommit": "${workCommits[1]?.headCommit}"`);
    expect(sdk.calls[5]?.prompt).toContain("latent-bad");
    expect(result.summary).toMatchObject({
      stopReason: "goal-candidate-ready",
      localizationsStarted: 1,
      regressionsLocalized: 1,
      regressionsRepaired: 1,
      reverts: 0,
      hardRollbacks: 0,
      pendingFailure: null,
    });
  }, 90_000);

  it("runs configured prepare at historical commits and detects a direct-child first bad commit", async () => {
    const test = await createFixture((config) => {
      const script = [
        'const fs=require("node:fs");',
        'const diagnostic=process.cwd().includes("diagnostic-worktree");',
        'if(diagnostic&&!fs.existsSync("historical-ready.txt"))process.exit(9);',
        'const t=fs.readFileSync("source.txt","utf8");process.exit(t.includes("direct-bad")?7:0);',
      ].join("");
      config.checks.smoke = [passCommand("smoke")];
      config.checks.deep = [{ id: "deep", timeoutSeconds: 5, bisectable: true,
        argv: [process.execPath, "-e", script] }];
      config.deepPolicy.everyCheckpoints = 1;
      config.prepare = {
        argv: [process.execPath, "-e", 'require("node:fs").writeFileSync("historical-ready.txt","yes")'],
        timeoutSeconds: 5,
        triggerPaths: ["source.txt"],
      };
    });
    const { result, sdk } = await run(test, [
      { ...editSource("direct-bad\n", "introduce direct child defect"), method: "start" },
      {
        method: "resume",
        response: response("changed", "repair direct child"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "direct-fixed\n"),
      },
      { method: "resume", response: response("goal_complete", "done") },
    ]);
    const events = (await test.store.readEvents()).events;
    const bad = events.find((event) =>
      event.type === "checkpoint-created" && event.data.kind === "work")?.headCommit;
    expect(events.find((event) => event.type === "regression-localized")?.data.firstBadCommit).toBe(bad);
    expect(events.filter((event) =>
      event.type === "check-completed" && event.data.category === "prepare").length).toBeGreaterThan(0);
    expect(sdk.calls[1]?.prompt).toContain(`"firstBadCommit": "${bad}"`);
    expect(result.summary.stopReason).toBe("goal-candidate-ready");
  }, 90_000);

  it("does not blame a commit when the known-good anchor now fails", async () => {
    const test = await createFixture((config, fixture) => {
      const drift = path.join(fixture.root, "environment-drift.txt");
      config.checks.smoke = [passCommand("smoke")];
      config.checks.deep = [{ id: "deep", timeoutSeconds: 5, bisectable: true,
        argv: [process.execPath, "-e",
          `process.exit(require("node:fs").existsSync(${JSON.stringify(drift)})?7:0)`] }];
      config.deepPolicy.everyCheckpoints = 1;
      config.prepare = null;
    });
    const drift = path.join(test.fixture.root, "environment-drift.txt");
    const { result, sdk } = await run(test, [{
      method: "start",
      response: response("changed", "make a safe change before environment drift"),
      action: async ({ workingDirectory }) => {
        await writeFile(path.join(workingDirectory, "source.txt"), "safe\n");
        await writeFile(drift, "drift\n");
      },
    }]);
    const state = await test.store.readState();
    expect(result.summary.stopReason).toBe("recovery-infrastructure");
    expect(state.health.pendingFailure).toMatchObject({
      firstBadCommit: null,
      localization: { status: "anchor-failed" },
    });
    expect((await test.store.readEvents()).events.some((event) =>
      event.type === "regression-localized")).toBe(false);
    expect(sdk.calls).toHaveLength(1);
  }, 90_000);

  it("aborts on a flaky midpoint and preserves the smallest proven window", async () => {
    const test = await createFixture((config, fixture) => {
      const counter = path.join(fixture.root, "midpoint-counter.txt");
      const script = [
        'const fs=require("node:fs");const t=fs.readFileSync("source.txt","utf8");',
        'if(t.includes("stable-bad"))process.exit(7);',
        'if(!t.includes("mid-flaky"))process.exit(0);',
        `let n=0;try{n=Number(fs.readFileSync(${JSON.stringify(counter)},"utf8"))}catch{}`,
        `n++;fs.writeFileSync(${JSON.stringify(counter)},String(n));`,
        'process.exit(n===1?7:0);',
      ].join("");
      config.checks.smoke = [passCommand("smoke")];
      config.checks.deep = [{ id: "deep", timeoutSeconds: 5, bisectable: true,
        argv: [process.execPath, "-e", script] }];
      config.deepPolicy.everyCheckpoints = 5;
      config.deepPolicy.maxMinutes = 999;
    });
    const { result, sdk } = await run(test, [
      { ...editSource("safe-one\n", "safe one"), method: "start" },
      editSource("mid-flaky\n", "flaky midpoint"),
      editSource("stable-bad\nthree\n", "stable bad three"),
      editSource("stable-bad\nfour\n", "stable bad four"),
      editSource("stable-bad\nfive\n", "stable bad five"),
    ]);
    const state = await test.store.readState();
    expect(result.summary.stopReason).toBe("recovery-flaky");
    expect(state.health.pendingFailure).toMatchObject({
      firstBadCommit: null,
      localization: { status: "aborted" },
    });
    expect(state.health.pendingFailure?.localization?.reason).toContain("midpoint");
    expect(state.health.pendingFailure?.regressionWindow).not.toBeNull();
    expect(sdk.calls).toHaveLength(5);
  }, 90_000);

  it.each(["infrastructure", "safety"] as const)(
    "aborts localization when a midpoint produces %s evidence",
    async (boundary) => {
      const test = await createFixture((config) => {
        const script = boundary === "infrastructure"
          ? [
              'const t=require("node:fs").readFileSync("source.txt","utf8");',
              'if(t.includes("mid-boundary")){setTimeout(()=>{},10000)}',
              'else{process.exit(t.includes("stable-bad")?7:0)}',
            ].join("")
          : [
              'const t=require("node:fs").readFileSync("source.txt","utf8");',
              'if(t.includes("mid-boundary"))require("node:child_process").execFileSync("git",["checkout","HEAD^"]);',
              'process.exit(t.includes("stable-bad")?7:0);',
            ].join("");
        config.checks.smoke = [passCommand("smoke")];
        config.checks.deep = [{ id: "deep", timeoutSeconds: boundary === "infrastructure" ? 1 : 5,
          bisectable: true, argv: [process.execPath, "-e", script] }];
        config.deepPolicy.everyCheckpoints = 5;
        config.deepPolicy.maxMinutes = 999;
      });
      const { result } = await run(test, [
        { ...editSource("safe-one\n", "safe one"), method: "start" },
        editSource("mid-boundary\n", `${boundary} midpoint`),
        editSource("stable-bad\nthree\n", "stable bad three"),
        editSource("stable-bad\nfour\n", "stable bad four"),
        editSource("stable-bad\nfive\n", "stable bad five"),
      ]);
      const state = await test.store.readState();
      expect(result.summary.stopReason).toBe(
        boundary === "safety" ? "recovery-safety" : "recovery-infrastructure",
      );
      expect(state.health.pendingFailure).toMatchObject({
        firstBadCommit: null,
        localization: { status: "aborted" },
      });
      expect(state.health.pendingFailure?.localization?.reason).toContain(boundary);
      if (boundary === "infrastructure") {
        const resumed = await run(test, [
          editSource("fixed after retained window\n", "repair after transient localization timeout"),
          { method: "resume", response: response("goal_complete", "complete after retained-window repair") },
        ]);
        expect(resumed.result.summary).toMatchObject({
          stopReason: "goal-candidate-ready",
          regressionsRepaired: 1,
          pendingFailure: null,
        });
      }
    },
    120_000,
  );

  it("degrades merge history to the smallest proven first-parent window without inventing precision", async () => {
    const test = await createFixture((config) => {
      config.checks.smoke = [passCommand("smoke")];
      config.checks.deep = [sourceCommand("deep", "merge-bad")];
      config.deepPolicy.everyCheckpoints = 99;
      config.deepPolicy.maxMinutes = 999;
    });
    await run(test, [{ method: "start", response: response("goal_complete", "establish baseline health") }]);
    const baseline = (await test.store.readState()).health.knownGoodCommit!;
    await writeFile(path.join(test.fixture.worktreePath, "source.txt"), "merge-bad\n");
    const bad = await test.fixture.commit(test.fixture.worktreePath, "manual bad first-parent commit");
    const badTree = await test.fixture.git(test.fixture.worktreePath, ["rev-parse", `${bad}^{tree}`]);
    const baselineTree = await test.fixture.git(test.fixture.worktreePath, ["rev-parse", `${baseline}^{tree}`]);
    const side = await test.fixture.git(
      test.fixture.worktreePath,
      ["commit-tree", baselineTree, "-p", baseline],
      "side parent\n",
    );
    const merge = await test.fixture.git(
      test.fixture.worktreePath,
      ["commit-tree", badTree, "-p", bad, "-p", side],
      "nonlinear merge\n",
    );
    await test.fixture.git(test.fixture.worktreePath, ["update-ref", "refs/heads/recovery-loop/work", merge]);
    await test.fixture.git(test.fixture.worktreePath, ["reset", "--hard", merge]);
    await test.store.update((draft) => {
      draft.repository.expectedHead = merge;
      draft.cadence.deepRequired = true;
      draft.cadence.deepReasons = ["merge-window-test"];
    });
    const sdk = new ScriptedAgentSdk([{
      method: "resume",
      response: {
        outcome: "blocked",
        summary: "preserve merge-window evidence",
        nextHint: null,
        blocker: "contradictory fixture authority",
      },
    }]);
    const result = await runNormalController({
      repository: test.fixture.repository,
      store: test.store,
      gateway: new CodexAgentGateway(sdk),
    });
    sdk.assertFinished();
    const state = await test.store.readState();
    expect(result.summary.stopReason).toBe("blocked");
    expect(state.health.pendingFailure).toMatchObject({
      firstBadCommit: null,
      regressionWindow: [baseline, bad],
      localization: {
        status: "window",
        nonlinear: true,
      },
    });
    expect(state.health.pendingFailure?.localization?.reason).toContain("nonlinear");
    expect(sdk.calls[0]?.prompt).toContain(`"regressionWindow": [\n    "${baseline}",\n    "${bad}"`);
  }, 90_000);
});

describe("Stage 9 revert and rescue rollback", () => {
  it("uses clean revert only after two failed repairs and runs full health at the revert commit", async () => {
    const test = await createFixture((config) => {
      config.checks.smoke = [passCommand("smoke")];
      config.checks.deep = [sourceCommand("deep", "revert-bad")];
      config.deepPolicy.everyCheckpoints = 3;
      config.deepPolicy.maxMinutes = 999;
      config.limits.maxRepairTurnsPerFailure = 2;
    });
    const { result } = await run(test, [
      { method: "start", response: response("changed", "safe first change"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "safe.txt"), "safe\n") },
      editSource("revert-bad\n", "bad second change"),
      { method: "resume", response: response("changed", "useful later change"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "later.txt"), "preserved\n") },
      { method: "resume", response: response("no_change", "first repair did not converge") },
      { method: "resume", response: response("no_change", "second repair did not converge") },
      { method: "start", response: response("goal_complete", "continue after clean revert") },
    ]);
    const state = await test.store.readState();
    const events = (await test.store.readEvents()).events;
    const revert = events.find((event) => event.type === "revert-created");
    expect(result.summary).toMatchObject({
      stopReason: "goal-candidate-ready",
      repairTurns: 2,
      reverts: 1,
      hardRollbacks: 0,
      pendingFailure: null,
    });
    expect(await readFile(path.join(test.fixture.worktreePath, "later.txt"), "utf8")).toBe("preserved\n");
    expect(state.health.knownGoodCommit).toBe(revert?.headCommit);
    expect(events.some((event) =>
      event.type === "check-completed" && event.headCommit === revert?.headCommit &&
      event.data.category === "smoke")).toBe(true);
    expect(events.some((event) =>
      event.type === "check-completed" && event.headCommit === revert?.headCommit &&
      event.data.category === "deep")).toBe(true);
  }, 90_000);

  it("aborts a conflicting revert, verifies a rescue ref, resets, records abandonment, rotates, and continues", async () => {
    const test = await createFixture((config) => {
      config.checks.smoke = [passCommand("smoke")];
      config.checks.deep = [sourceCommand("deep", "bad")];
      config.deepPolicy.everyCheckpoints = 2;
      config.deepPolicy.maxMinutes = 999;
      config.limits.maxRepairTurnsPerFailure = 2;
    });
    const operatorHead = await test.fixture.repository.head();
    const { result } = await run(test, [
      { ...editSource("bad-one\n", "first bad edit"), method: "start" },
      editSource("bad-two-entangled\n", "entangle later work"),
      { method: "resume", response: response("no_change", "first repair failed") },
      { method: "resume", response: response("no_change", "second repair failed") },
      { method: "start", response: response("changed", "choose an alternate healthy direction"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "alternate\n") },
      { method: "resume", response: response("goal_complete", "alternate direction complete") },
    ]);
    const state = await test.store.readState();
    const events = (await test.store.readEvents()).events;
    const abandoned = state.recovery.abandonedRanges[0];
    expect(result.summary).toMatchObject({
      stopReason: "goal-candidate-ready",
      reverts: 0,
      hardRollbacks: 1,
      abandonedDirections: 1,
      pendingFailure: null,
    });
    expect(abandoned).toBeDefined();
    expect(await test.worktree.branchHead(abandoned!.rescueRef)).toBe(abandoned!.oldHead);
    expect(await test.worktree.isAncestor(abandoned!.oldHead, await test.worktree.head())).toBe(false);
    expect(await test.fixture.repository.head()).toBe(operatorHead);
    const direction = events.find((event) => event.type === "direction-abandoned");
    const rotation = events.find((event) =>
      event.type === "thread-rotated" && event.data.reason === "hard-rollback");
    const continued = events.find((event) =>
      event.type === "agent-started" && event.data.mode === "work" &&
      event.sequence > (rotation?.sequence ?? Number.MAX_SAFE_INTEGER));
    expect(direction?.data.rescueRef).toBe(abandoned!.rescueRef);
    expect(rotation?.sequence).toBeGreaterThan(direction?.sequence ?? 0);
    expect(continued).toBeDefined();
    expect(events.some((event) =>
      event.type === "check-completed" && event.headCommit === abandoned!.targetCommit &&
      event.data.category === "smoke")).toBe(true);
    expect(events.some((event) =>
      event.type === "check-completed" && event.headCommit === abandoned!.targetCommit &&
      event.data.category === "deep")).toBe(true);
  }, 90_000);

  it("discovers and repairs another command failure after a successful revert", async () => {
    const test = await createFixture((config) => {
      config.checks.smoke = [passCommand("smoke")];
      config.checks.deep = [sourceCommand("deep", "bad")];
      config.deepPolicy.everyCheckpoints = 1;
      config.deepPolicy.maxMinutes = 999;
      config.limits.maxRepairTurnsPerFailure = 1;
    });
    const { result } = await run(test, [
      { ...editSource("bad-first\n", "introduce first regression"), method: "start" },
      { method: "resume", response: response("no_change", "exhaust first repair") },
      editSource("bad-second\n", "introduce a later independent regression", "start"),
      editSource("fixed-second\n", "repair the later regression"),
      { method: "resume", response: response("goal_complete", "complete after second recovery") },
    ]);
    expect(result.summary).toMatchObject({
      stopReason: "goal-candidate-ready",
      confirmedRegressions: 2,
      regressionsRepaired: 2,
      regressionsLocalized: 2,
      reverts: 1,
      pendingFailure: null,
    });
  }, 90_000);

  it("stops explicitly without inventing a rollback target when no known-good anchor exists", async () => {
    const test = await createFixture((config) => {
      const command = sourceCommand("smoke", "baseline", false);
      config.checks.smoke = [{ id: command.id, timeoutSeconds: command.timeoutSeconds, argv: command.argv }];
      config.checks.deep = [passCommand("deep")];
      config.limits.maxRepairTurnsPerFailure = 2;
      config.prepare = null;
    });
    const { result } = await run(test, [
      { method: "start", response: response("no_change", "first repair cannot establish an anchor") },
      { method: "resume", response: response("no_change", "second repair cannot establish an anchor") },
    ]);
    const state = await test.store.readState();
    expect(result.summary).toMatchObject({ stopReason: "repair-exhausted", hardRollbacks: 0 });
    expect(state.health.knownGoodCommit).toBeNull();
    expect(state.recovery.rescueRefs).toEqual([]);
    expect(state.health.pendingFailure).not.toBeNull();
  }, 90_000);
});
