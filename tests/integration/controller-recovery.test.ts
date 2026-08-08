import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAgentGateway } from "../../src/agent-gateway.js";
import { runNormalController } from "../../src/controller.js";
import { initializeJournaledWorkspace } from "../../src/git-operations.js";
import type { GitRepository } from "../../src/git-repository.js";
import { StateStore } from "../../src/state-store.js";
import { ScriptedAgentSdk, type ScriptedAgentStep } from "../support/scripted-agent.js";
import { createTemporaryRepository, type TemporaryRepository } from "../support/temporary-repository.js";

const fixtures: TemporaryRepository[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())));

interface RecoveryFixture {
  fixture: TemporaryRepository;
  store: StateStore;
  worktree: GitRepository;
}
interface MutableConfig {
  checks: { smoke: unknown[]; deep: unknown[] };
  limits: { maxRepairTurnsPerFailure: number; maxRecoveryCyclesPerSignature: number;
    agentTurnSeconds: number };
  deepPolicy: { everyCheckpoints: number; maxMinutes: number };
  prepare: unknown;
}

function response(outcome: "changed" | "no_change" | "goal_complete" | "blocked", summary: string, blocker: string | null = null) {
  return { outcome, summary, nextHint: null, blocker };
}
function sourceCommand(id: string, rejectedText: string) {
  return { id, timeoutSeconds: 5, argv: [process.execPath, "-e",
    `const t=require("node:fs").readFileSync("source.txt","utf8");process.exit(t.includes(${JSON.stringify(rejectedText)})?7:0)`] };
}
function passCommand(id: string) {
  return { id, timeoutSeconds: 5, argv: [process.execPath, "-e", "process.exit(0)"] };
}
function sequencedSourceCommand(id: string, marker: string, outcomes: readonly ("pass" | "fail")[]) {
  const source = [
    'const fs=require("node:fs");const text=fs.readFileSync("source.txt","utf8");',
    'if(!text.includes("bad"))process.exit(0);',
    `let n=0;try{n=Number(fs.readFileSync(${JSON.stringify(marker)},"utf8"))}catch{}`,
    `n+=1;fs.writeFileSync(${JSON.stringify(marker)},String(n));`,
    `const outcomes=${JSON.stringify(outcomes)};process.exit(outcomes[Math.min(n-1,outcomes.length-1)]==="fail"?7:0);`,
  ].join("");
  return { id, timeoutSeconds: 5, argv: [process.execPath, "-e", source] };
}
async function createFixture(mutate: (config: MutableConfig) => void): Promise<RecoveryFixture> {
  const fixture = await createTemporaryRepository();
  fixtures.push(fixture);
  const configPath = path.join(fixture.projectPath, ".recovery-loop", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as MutableConfig;
  mutate(config);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fixture.commit(fixture.projectPath, "configure recovery scenario");
  const store = new StateStore(fixture.repository.gitCommonDir);
  const initialized = await initializeJournaledWorkspace({
    operatorRepository: fixture.repository,
    store,
    branch: "recovery-loop/work",
    worktreePath: fixture.worktreePath,
    sessionId: `rl-recovery-${fixtures.length}`,
  });
  return { fixture, store, worktree: initialized.worktree };
}
async function run(test: RecoveryFixture, steps: readonly ScriptedAgentStep[], signal?: AbortSignal) {
  const sdk = new ScriptedAgentSdk(steps);
  const result = await runNormalController({
    repository: test.fixture.repository,
    store: test.store,
    gateway: new CodexAgentGateway(sdk),
    ...(signal === undefined ? {} : { signal }),
  });
  try { sdk.assertFinished(); }
  catch (error) { throw new Error(`${(error as Error).message}; stop=${String(result.summary.stopReason)}; detail=${String(result.summary.stopDetail)}; pending=${JSON.stringify(result.summary.pendingFailure)}`); }
  return { result, sdk };
}
async function markerCount(marker: string): Promise<number> {
  try { return (await readFile(marker, "utf8")).trim().split(/\r?\n/u).filter(Boolean).length; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
}

describe("Stage 8 confirmed forward repair", () => {
  it("confirms an immediate smoke regression, checkpoints the repair, runs full health, and resumes work", async () => {
    const test = await createFixture((config) => {
      config.checks.smoke = [sourceCommand("smoke", "bad")];
      config.checks.deep = [passCommand("deep")];
      config.deepPolicy.everyCheckpoints = 99;
      config.deepPolicy.maxMinutes = 999;
    });
    const { result, sdk } = await run(test, [
      { method: "start", response: response("changed", "introduce a regression"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "bad\n") },
      { method: "resume", response: response("changed", "repair the regression"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "fixed\n") },
      { method: "resume", response: response("goal_complete", "the goal is now complete") },
    ]);
    const state = await test.store.readState();
    const messages = (await test.worktree.git(["log", `${state.repository.baselineCommit}..HEAD`, "--format=%B%x00"])).stdout;
    expect(result.summary).toMatchObject({
      stopReason: "goal-candidate-ready",
      confirmedRegressions: 1,
      regressionsRepaired: 1,
      confirmationAttempts: 2,
      repairTurns: 1,
      repairCheckpoints: 1,
      repairEvaluations: 1,
      pendingFailure: null,
      finalHeadReceivedDeepPass: true,
    });
    expect(state.health.knownGoodCommit).toBe(await test.worktree.head());
    expect(messages).toContain("Recovery-Loop-Kind: repair");
    expect(messages).toContain("Recovery-Loop-Kind: work");
    expect(sdk.calls[1]?.prompt).toContain('"checkId": "smoke"');
    expect(sdk.calls[1]?.prompt).toContain('"confirmationAttempts"');
    expect(sdk.calls[1]?.prompt).toContain(state.repository.baselineCommit);
    expect(sdk.calls[2]?.prompt).toContain("Choose and implement one coherent next improvement");
  }, 60_000);

  it("uses fail/pass/fail agreement before repairing the product", async () => {
    const test = await createFixture((config) => {
      const marker = path.join(fixtures.at(-1)!.root, "fail-pass-fail.txt");
      config.checks.smoke = [sequencedSourceCommand(
        "smoke",
        marker,
        ["fail", "pass", "fail", "fail", "fail"],
      )];
      config.checks.deep = [passCommand("deep")];
    });
    const { result } = await run(test, [
      { method: "start", response: response("changed", "create unstable-looking defect"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "bad\n") },
      { method: "resume", response: response("changed", "repair after two matching failures"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "fixed\n") },
      { method: "resume", response: response("goal_complete", "done") },
    ]);
    expect(result.summary).toMatchObject({ stopReason: "goal-candidate-ready",
      confirmationAttempts: 3, confirmedRegressions: 1, regressionsRepaired: 1 });
    const events = (await test.store.readEvents()).events;
    expect(events.filter((event) => event.type === "confirmation-attempted")
      .map((event) => event.data.classification)).toEqual(["product", "pass", "product"]);
  }, 60_000);

  it("classifies fail/pass/pass as flaky and never invokes recovery mode", async () => {
    const test = await createFixture((config) => {
      const marker = path.join(fixtures.at(-1)!.root, "fail-pass-pass.txt");
      config.checks.smoke = [sequencedSourceCommand("smoke", marker, ["fail", "pass", "pass"])];
      config.checks.deep = [passCommand("deep")];
    });
    const { result, sdk } = await run(test, [
      { method: "start", response: response("changed", "trigger one flaky observation"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "bad\n") },
      { method: "resume", response: response("goal_complete", "continue after controller classification") },
    ]);
    expect(result.summary).toMatchObject({ stopReason: "goal-candidate-ready",
      confirmationAttempts: 3, confirmedRegressions: 0, repairTurns: 0,
      flakyChecks: 1, pendingFailure: null });
    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls.every((call) => !call.prompt?.includes("Recovery evidence"))).toBe(true);
  }, 60_000);
});

describe("Stage 8 non-product classifications", () => {
  it("stops a repeated infrastructure failure without presenting it to the coding role", async () => {
    const test = await createFixture((config) => {
      config.checks.smoke = [{ id: "missing", argv: ["recovery-loop-no-such-executable"], timeoutSeconds: 5 }];
      config.checks.deep = [passCommand("deep")];
      config.prepare = null;
    });
    const { result, sdk } = await run(test, []);
    expect(result.summary).toMatchObject({ stopReason: "recovery-infrastructure",
      confirmedRegressions: 0, repairTurns: 0, pendingFailure: { classification: "infrastructure" } });
    expect(sdk.calls).toHaveLength(0);
  }, 60_000);

  it("stops a safety observation without invoking the coding role", async () => {
    const test = await createFixture((config) => {
      config.checks.smoke = [passCommand("smoke")];
      config.checks.deep = [passCommand("deep")];
    });
    const state = await test.store.readState();
    await test.store.update((draft) => {
      draft.health.pendingFailure = {
        id: "failure-safety",
        checkId: "smoke",
        classification: "safety",
        signature: "synthetic-safety",
        discoveredAtCommit: state.repository.expectedHead,
        confirmed: false,
        knownGoodCommit: null,
        firstBadCommit: null,
        regressionWindow: null,
        repairAttempts: 0,
        recoveryCycles: 0,
        latestResultPath: "",
        confirmationAttempts: [],
        lastRepairCommit: null,
        lastEvaluatedRepairCommit: null,
        environmentAttempts: 0,
        localization: null,
      };
      draft.recovery.activeFailureId = "failure-safety";
    });
    const { result, sdk } = await run(test, []);
    expect(result.summary).toMatchObject({ stopReason: "recovery-safety",
      confirmedRegressions: 0, repairTurns: 0 });
    expect(sdk.calls).toHaveLength(0);
  }, 60_000);

  it("runs one configured environment prepare attempt before resuming normal work", async () => {
    const test = await createFixture((config) => {
      const marker = path.join(fixtures.at(-1)!.root, "environment-ready.txt");
      config.checks.smoke = [{ id: "environment", timeoutSeconds: 2,
        argv: [process.execPath, "-e",
          `const fs=require("node:fs");if(!fs.existsSync(${JSON.stringify(marker)}))setTimeout(()=>{},10000);`] }];
      config.checks.deep = [passCommand("deep")];
      config.prepare = { argv: [process.execPath, "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)},"ready")`],
      timeoutSeconds: 5, triggerPaths: [] };
    });
    const { result, sdk } = await run(test, [
      { method: "start", response: response("goal_complete", "environment recovery completed") },
    ]);
    expect(result.summary).toMatchObject({ stopReason: "goal-candidate-ready",
      confirmedRegressions: 0, repairTurns: 0, environmentAttempts: 1, pendingFailure: null,
      recovery: { pendingEnvironmentAttempts: 0 } });
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0]?.prompt).toContain("Choose and implement one coherent next improvement");
  }, 60_000);
});

describe("Stage 8 repair sequencing and replacement failures", () => {
  it("preserves a failed first repair and succeeds on the second controller-owned repair", async () => {
    const test = await createFixture((config) => {
      config.checks.smoke = [sourceCommand("smoke", "bad")];
      config.checks.deep = [passCommand("deep")];
    });
    const { result, sdk } = await run(test, [
      { method: "start", response: response("changed", "introduce bad source"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "bad\n") },
      { method: "resume", response: response("changed", "first repair remains incomplete"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "still bad\n") },
      { method: "resume", response: response("changed", "second repair fixes the predicate"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "fixed\n") },
      { method: "resume", response: response("goal_complete", "complete after repair") },
    ]);
    const state = await test.store.readState();
    const log = (await test.worktree.git(["log", `${state.repository.baselineCommit}..HEAD`, "--format=%an%x09%B%x00"])).stdout;
    expect(result.summary).toMatchObject({ stopReason: "goal-candidate-ready",
      repairTurns: 2, repairCheckpoints: 2, repairEvaluations: 2,
      regressionsRepaired: 1, pendingFailure: null });
    expect((log.match(/Recovery-Loop-Kind: repair/gu) ?? [])).toHaveLength(2);
    expect(log).not.toContain("Fixture User");
    expect(sdk.calls[2]?.prompt).toContain("first repair remains incomplete");
  }, 60_000);

  it("runs the predicate first, then replaces it with a deep failure until a full pass", async () => {
    const test = await createFixture((config) => {
      const marker = path.join(fixtures.at(-1)!.root, "deep-tail.txt");
      config.checks.smoke = [sourceCommand("primary", "primary-bad")];
      config.checks.deep = [sourceCommand("deep", "deep-bad"), {
        id: "deep-tail", timeoutSeconds: 5,
        argv: [process.execPath, "-e",
          `require("node:fs").appendFileSync(${JSON.stringify(marker)},${JSON.stringify("ran\n")})`],
      }];
    });
    const marker = path.join(test.fixture.root, "deep-tail.txt");
    const baseline = (await test.store.readState()).repository.baselineCommit;
    let knownGoodBeforeDeepRepair: string | null | undefined;
    const { result, sdk } = await run(test, [
      { method: "start", response: response("changed", "break the primary predicate"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "primary-bad\n") },
      { method: "resume", response: response("changed", "fix primary but expose deep regression"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "deep-bad\n") },
      { method: "resume", response: response("changed", "repair the replacement deep failure"),
        action: async ({ workingDirectory }) => {
          knownGoodBeforeDeepRepair = (await test.store.readState()).health.knownGoodCommit;
          expect(await markerCount(marker)).toBe(2);
          await writeFile(path.join(workingDirectory, "source.txt"), "fixed\n");
        } },
      { method: "resume", response: response("goal_complete", "all command-owned health is restored") },
    ]);
    expect(knownGoodBeforeDeepRepair).toBe(baseline);
    expect(result.summary).toMatchObject({ stopReason: "goal-candidate-ready",
      confirmedRegressions: 2, repairTurns: 2, repairCheckpoints: 2,
      regressionsRepaired: 1, pendingFailure: null });
    expect(sdk.calls[1]?.prompt).toContain('"checkId": "primary"');
    expect(sdk.calls[2]?.prompt).toContain('"checkId": "deep"');
    expect((await test.store.readState()).health.knownGoodCommit).toBe(await test.worktree.head());
  }, 60_000);

  it("repairs an unhealthy baseline without inventing a known-good anchor", async () => {
    const test = await createFixture((config) => {
      config.checks.smoke = [sourceCommand("smoke", "baseline")];
      config.checks.deep = [passCommand("deep")];
    });
    const { result, sdk } = await run(test, [
      { method: "start", response: response("changed", "repair the unhealthy baseline"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "fixed\n") },
      { method: "resume", response: response("goal_complete", "baseline recovery is complete") },
    ]);
    expect(sdk.calls[0]?.prompt).toContain('"knownGoodCommit": null');
    expect(result.summary).toMatchObject({ stopReason: "goal-candidate-ready",
      repairTurns: 1, repairCheckpoints: 1, regressionsRepaired: 1, pendingFailure: null });
    expect((await test.store.readState()).health.knownGoodCommit).toBe(await test.worktree.head());
  }, 60_000);
});

describe("Stage 8 repair boundaries", () => {
  it("normalizes an agent-created descendant repair commit and rotates the thread", async () => {
    const test = await createFixture((config) => {
      config.checks.smoke = [sourceCommand("smoke", "bad")];
      config.checks.deep = [passCommand("deep")];
    });
    const { result, sdk } = await run(test, [
      { method: "start", response: response("changed", "introduce defect"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "bad\n") },
      { method: "resume", response: response("changed", "repair with prohibited descendant commit"),
        action: async ({ workingDirectory }) => {
          await writeFile(path.join(workingDirectory, "source.txt"), "fixed\n");
          await test.fixture.commit(workingDirectory, "agent-owned repair commit");
        } },
      { method: "start", response: response("goal_complete", "finish on the rotated thread") },
    ]);
    const state = await test.store.readState();
    const authors = (await test.worktree.git(["log", `${state.repository.baselineCommit}..HEAD`, "--format=%an"])).stdout;
    expect(result.summary).toMatchObject({ stopReason: "goal-candidate-ready",
      repairCheckpoints: 1, regressionsRepaired: 1 });
    expect(result.summary.rescueRefs).toEqual([expect.stringContaining("agent-history")]);
    expect(sdk.calls.map((call) => call.method)).toEqual(["start", "resume", "start"]);
    expect(authors).not.toContain("Fixture User");
  }, 60_000);

  it("honors a hard blocked recovery result without clearing command health", async () => {
    const test = await createFixture((config) => {
      config.checks.smoke = [sourceCommand("smoke", "bad")];
      config.checks.deep = [passCommand("deep")];
    });
    const { result } = await run(test, [
      { method: "start", response: response("changed", "introduce defect"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "bad\n") },
      { method: "resume", response: response("blocked", "required external service is unavailable",
        "required external service is unavailable") },
    ]);
    expect(result.summary).toMatchObject({ stopReason: "blocked", repairTurns: 1,
      repairCheckpoints: 0, pendingFailure: { confirmed: true, repairAttempts: 1 } });
  }, 60_000);

  it("counts no-change and optimistic prose, rotates, and cleanly reverts after repair exhaustion", async () => {
    const test = await createFixture((config) => {
      config.checks.smoke = [sourceCommand("smoke", "bad")];
      config.checks.deep = [passCommand("deep")];
      config.limits.maxRepairTurnsPerFailure = 2;
    });
    const { result, sdk } = await run(test, [
      { method: "start", response: response("changed", "introduce defect"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "bad\n") },
      { method: "resume", response: response("goal_complete", "the failure is fixed and tests pass") },
      { method: "resume", response: response("no_change", "no repair edit found") },
      { method: "start", response: response("goal_complete", "complete after controller revert") },
    ]);
    const state = await test.store.readState();
    expect(result.summary).toMatchObject({ stopReason: "goal-candidate-ready",
      repairTurns: 2, repairCheckpoints: 0, reverts: 1, pendingFailure: null });
    expect(state.health.knownGoodCommit).toBe(await test.worktree.head());
    expect(sdk.calls.slice(1, 3).every((call) => call.prompt?.includes("Recovery evidence"))).toBe(true);
    expect(sdk.calls[3]?.prompt).toContain("Choose and implement one coherent next improvement");
    expect((await test.store.readEvents()).events.some((event) =>
      event.type === "thread-rotated" && event.data.reason === "repair-attempt-limit")).toBe(true);
  }, 60_000);

  it("keeps a confirmed failure durable after a malformed recovery response", async () => {
    const test = await createFixture((config) => {
      config.checks.smoke = [sourceCommand("smoke", "bad")];
      config.checks.deep = [passCommand("deep")];
    });
    const { result } = await run(test, [
      { method: "start", response: response("changed", "introduce defect"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "bad\n") },
      { method: "resume", finalResponseText: "not valid JSON" },
    ]);
    expect(result.summary).toMatchObject({ stopReason: "agent-error", repairTurns: 1,
      repairCheckpoints: 0, pendingFailure: { confirmed: true, repairAttempts: 1 } });
  }, 60_000);

  it("keeps a confirmed failure durable after a recovery timeout", async () => {
    const test = await createFixture((config) => {
      config.checks.smoke = [sourceCommand("smoke", "bad")];
      config.checks.deep = [passCommand("deep")];
      config.limits.agentTurnSeconds = 1;
    });
    const { result } = await run(test, [
      { method: "start", response: response("changed", "introduce defect"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "bad\n") },
      { method: "resume", waitForAbort: true },
    ]);
    expect(result.summary).toMatchObject({ stopReason: "agent-turn-timeout", repairTurns: 1,
      repairCheckpoints: 0, pendingFailure: { confirmed: true, repairAttempts: 1 } });
  }, 60_000);

  it("enforces recurring same-signature recovery cycles", async () => {
    const test = await createFixture((config) => {
      config.checks.smoke = [sourceCommand("smoke", "bad")];
      config.checks.deep = [passCommand("deep")];
      config.limits.maxRecoveryCyclesPerSignature = 1;
    });
    const { result } = await run(test, [
      { method: "start", response: response("changed", "introduce first defect"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "bad\n") },
      { method: "resume", response: response("changed", "repair first defect"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "fixed\n") },
      { method: "resume", response: response("changed", "reintroduce the same defect"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "bad\n") },
    ]);
    expect(result.summary).toMatchObject({ stopReason: "repair-exhausted",
      confirmedRegressions: 2, regressionsRepaired: 1,
      recovery: { sameSignatureCycles: 2 },
      pendingFailure: { recoveryCycles: 2, repairAttempts: 0 } });
  }, 60_000);
});

describe("Stage 8 repair interruption and restart", () => {
  it("preserves cancelled repair edits as a repair checkpoint and resumes safely", async () => {
    const test = await createFixture((config) => {
      config.checks.smoke = [sourceCommand("smoke", "bad")];
      config.checks.deep = [passCommand("deep")];
    });
    const abort = new AbortController();
    const interrupted = await run(test, [
      { method: "start", response: response("changed", "introduce defect"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "bad\n") },
      { method: "resume", waitForAbort: true, action: async ({ workingDirectory }) => {
        await writeFile(path.join(workingDirectory, "source.txt"), "fixed\n");
        abort.abort(new Error("SIGINT"));
      } },
    ], abort.signal);
    const interruptedState = await test.store.readState();
    expect(interrupted.result.summary).toMatchObject({ stopReason: "signal",
      repairTurns: 1, repairCheckpoints: 1, regressionsRepaired: 1, pendingFailure: null });
    expect(await test.worktree.commitMessage()).toContain("Recovery-Loop-Kind: repair");
    expect(interruptedState.health.knownGoodCommit).toBe(await test.worktree.head());

    const resumed = await run(test, [
      { method: "resume", response: response("goal_complete", "continue after interrupted repair") },
    ]);
    expect(resumed.result.summary.stopReason).toBe("goal-candidate-ready");
  }, 60_000);

  it("adopts a repair commit after a crash and evaluates it exactly once on restart", async () => {
    const test = await createFixture((config) => {
      config.checks.smoke = [sourceCommand("smoke", "bad")];
      config.checks.deep = [passCommand("deep")];
    });
    const firstSdk = new ScriptedAgentSdk([
      { method: "start", response: response("changed", "introduce defect"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "bad\n") },
      { method: "resume", response: response("changed", "repair before controller crash"),
        action: ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "fixed\n") },
    ]);
    let checkpointMutations = 0;
    await expect(runNormalController({
      repository: test.fixture.repository,
      store: test.store,
      gateway: new CodexAgentGateway(firstSdk),
      hooks: { afterCheckpointMutation: () => {
        checkpointMutations += 1;
        if (checkpointMutations === 2) throw new Error("crash after repair commit");
      } },
    })).rejects.toThrow("crash after repair commit");
    firstSdk.assertFinished();
    expect((await test.store.readState()).phase).toBe("checkpointing");

    const resumed = await run(test, [
      { method: "resume", response: response("goal_complete", "finish after repair reconciliation") },
    ]);
    const events = (await test.store.readEvents()).events;
    expect(resumed.result.summary).toMatchObject({ stopReason: "goal-candidate-ready",
      regressionsRepaired: 1, pendingFailure: null });
    expect(events.filter((event) => event.type === "repair-evaluated")).toHaveLength(1);
    expect(events.filter((event) => event.type === "checkpoint-created" && event.data.kind === "repair")).toHaveLength(1);
  }, 60_000);
});
