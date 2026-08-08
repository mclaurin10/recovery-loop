import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentCancelledError,
  AgentResponseError,
  AgentTimeoutError,
  CodexAgentGateway,
  type AgentInvocation,
  type RecoveryEvidence,
} from "../../src/agent-gateway.js";
import { checkBaseline, checkpointAndCheck } from "../../src/controller.js";
import { loadConfig, type RecoveryConfig } from "../../src/config.js";
import { initializeJournaledWorkspace, journaledCheckpoint } from "../../src/git-operations.js";
import { assertCheckpointSafe, SafetyGuardError } from "../../src/safety.js";
import { StateStore } from "../../src/state-store.js";
import {
  createTemporaryRepository,
  type TemporaryRepository,
} from "../support/temporary-repository.js";
import { ScriptedAgentSdk } from "../support/scripted-agent.js";

const fixtures: TemporaryRepository[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

interface GatewayFixture {
  fixture: TemporaryRepository;
  store: StateStore;
  worktree: Awaited<ReturnType<typeof initializeJournaledWorkspace>>["worktree"];
  config: RecoveryConfig;
}

async function createGatewayFixture(): Promise<GatewayFixture> {
  const fixture = await createTemporaryRepository();
  fixtures.push(fixture);
  const store = new StateStore(fixture.repository.gitCommonDir);
  const initialized = await initializeJournaledWorkspace({
    operatorRepository: fixture.repository,
    store,
    branch: "recovery-loop/work",
    worktreePath: fixture.worktreePath,
    sessionId: "rl-agent",
  });
  return {
    fixture,
    store,
    worktree: initialized.worktree,
    config: await loadConfig(fixture.worktreePath),
  };
}

function response(
  outcome: "changed" | "no_change" | "goal_complete" | "blocked",
  summary = `${outcome} result`,
) {
  return {
    outcome,
    summary,
    nextHint: outcome === "goal_complete" ? null : "next useful direction",
    blocker: outcome === "blocked" ? "required external service is unavailable" : null,
  };
}

function invocation(
  fixture: GatewayFixture,
  overrides: Partial<Pick<AgentInvocation, "mode" | "recovery" | "signal" | "threadBoundaries">> = {},
  config = fixture.config,
): AgentInvocation {
  return {
    store: fixture.store,
    repository: fixture.worktree,
    config,
    unitId: "unit-agent",
    mode: overrides.mode ?? "work",
    ...(overrides.recovery === undefined ? {} : { recovery: overrides.recovery }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    ...(overrides.threadBoundaries === undefined
      ? {}
      : { threadBoundaries: overrides.threadBoundaries }),
  };
}

describe("deterministic coding-agent invocation", () => {
  it("edits source in work mode, persists events and usage, and applies locked-down SDK options", async () => {
    const test = await createGatewayFixture();
    const secret = `sk-proj-${"A".repeat(40)}`;
    const ordinaryCredential = "plain-text-password";
    const sdk = new ScriptedAgentSdk([{
      method: "start",
      threadId: "thread-created",
      response: response("changed", "add a source improvement"),
      usage: { inputTokens: 101, cachedInputTokens: 20, cacheWriteInputTokens: 7, outputTokens: 30, reasoningTokens: 11 },
      action: async ({ workingDirectory }) => {
        await writeFile(path.join(workingDirectory, "feature.txt"), "agent edit\n", "utf8");
      },
      extraEvents: [{
        type: "item.completed",
        item: {
          id: "command-1",
          type: "command_execution",
          command: `tool --api-key ${secret} --password ${ordinaryCredential}`,
          aggregated_output: secret,
          status: "completed",
          environment: { OPENAI_API_KEY: secret },
        },
      }],
    }]);
    const result = await new CodexAgentGateway(sdk).invoke(invocation(test));

    expect(await readFile(path.join(test.fixture.worktreePath, "feature.txt"), "utf8")).toBe("agent edit\n");
    expect(result).toMatchObject({
      response: { outcome: "changed" },
      threadId: "thread-created",
      resumed: false,
      fallbackToFreshThread: false,
      usage: { inputTokens: 101, cachedInputTokens: 20, outputTokens: 30, reasoningTokens: 11 },
    });
    const call = sdk.calls[0];
    expect(call?.threadOptions).toEqual({
      model: "test-model",
      modelReasoningEffort: "high",
      workingDirectory: test.fixture.worktreePath,
      sandboxMode: "workspace-write",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      webSearchEnabled: false,
      approvalPolicy: "never",
      skipGitRepoCheck: false,
      additionalDirectories: [],
    });
    expect(call?.prompt).toContain("Choose and implement one coherent next improvement");
    expect(call?.outputSchema).toMatchObject({ additionalProperties: false });

    const invocationLog = JSON.parse(await readFile(path.join(result.logDirectory, "invocation.json"), "utf8")) as Record<string, unknown>;
    expect(invocationLog).toMatchObject({
      status: "completed",
      requestedModel: "test-model",
      requestedEffort: "high",
      threadId: "thread-created",
      approvalPolicy: "never",
      networkAccess: false,
    });
    expect(invocationLog).not.toHaveProperty("environment");
    const eventLog = await readFile(path.join(result.logDirectory, "events.jsonl"), "utf8");
    expect(eventLog).toContain("thread.started");
    expect(eventLog).toContain("[REDACTED");
    expect(eventLog).not.toContain(secret);
    expect(eventLog).not.toContain(ordinaryCredential);
    expect(eventLog).not.toContain("OPENAI_API_KEY");
    expect(JSON.parse(await readFile(path.join(result.logDirectory, "final-response.json"), "utf8"))).toEqual(response("changed", "add a source improvement"));

    const state = await test.store.readState();
    expect(state.phase).toBe("idle");
    expect(state.agent).toMatchObject({ threadId: "thread-created", turns: 1, threadTurns: 1 });
    expect(state.usage).toMatchObject({ agentTurns: 1, inputTokens: 101, cachedInputTokens: 20, outputTokens: 30, reasoningTokens: 11 });
    expect(state.health.knownGoodCommit).toBeNull();
    expect((await test.store.readEvents()).events.map((event) => event.type)).toEqual(expect.arrayContaining(["agent-started", "agent-completed"]));
    sdk.assertFinished();
  });

  it.each(["no_change", "goal_complete", "blocked"] as const)(
    "accepts a valid %s outcome without turning prose into health state",
    async (outcome) => {
      const test = await createGatewayFixture();
      const sdk = new ScriptedAgentSdk([{ method: "start", response: response(outcome) }]);
      const result = await new CodexAgentGateway(sdk).invoke(invocation(test));
      const state = await test.store.readState();
      expect(result.response.outcome).toBe(outcome);
      expect(state.health.knownGoodCommit).toBeNull();
      expect(state.health.lastSmokePassCommit).toBeNull();
      expect(state.cadence.deepReasons).toEqual(["initial-baseline"]);
      sdk.assertFinished();
    },
  );

  it("rejects malformed structured output and preserves the interrupted agent phase", async () => {
    const test = await createGatewayFixture();
    const sdk = new ScriptedAgentSdk([{ method: "start", finalResponseText: "not json" }]);
    await expect(new CodexAgentGateway(sdk).invoke(invocation(test))).rejects.toBeInstanceOf(AgentResponseError);
    const state = await test.store.readState();
    expect(state.phase).toBe("agent-running");
    expect(state.operation?.kind).toBe("agent");
    expect(state.usage.agentTurns).toBe(1);
    expect((await test.store.readEvents()).events.at(-1)?.type).toBe("agent-failed");
    sdk.assertFinished();
  });

  it("enforces the configured timeout", async () => {
    const test = await createGatewayFixture();
    const sdk = new ScriptedAgentSdk([{ method: "start", waitForAbort: true }]);
    const timeoutConfig: RecoveryConfig = {
      ...test.config,
      limits: { ...test.config.limits, agentTurnSeconds: 1 },
    };
    await expect(new CodexAgentGateway(sdk).invoke(invocation(test, {}, timeoutConfig))).rejects.toBeInstanceOf(AgentTimeoutError);
    expect((await test.store.readState()).phase).toBe("agent-running");
    const log = await readOnlyInvocationLog(test);
    expect(log.status).toBe("timed_out");
    sdk.assertFinished();
  });

  it("honors caller cancellation independently of the timeout", async () => {
    const test = await createGatewayFixture();
    const sdk = new ScriptedAgentSdk([{ method: "start", waitForAbort: true }]);
    const abort = new AbortController();
    const pending = new CodexAgentGateway(sdk).invoke(invocation(test, { signal: abort.signal }));
    setTimeout(() => abort.abort(), 20);
    await expect(pending).rejects.toBeInstanceOf(AgentCancelledError);
    const log = await readOnlyInvocationLog(test);
    expect(log.status).toBe("cancelled");
    sdk.assertFinished();
  });

  it("uses the same coding role in recovery mode with exact supplied evidence", async () => {
    const test = await createGatewayFixture();
    const evidence: RecoveryEvidence = {
      checkId: "full-test",
      failingCommand: ["pnpm", "test"],
      normalizedOutcome: "exit 1: negative-number regression",
      failedCommit: test.fixture.baseline,
      currentCommit: test.fixture.baseline,
      knownGoodCommit: test.fixture.baseline,
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdoutTail: "negative-number regression",
      stderrTail: "",
      error: null,
      resultPath: "runs/rl-agent/checks/1/result.json",
      stdoutPath: "runs/rl-agent/checks/1/stdout.log",
      stderrPath: "runs/rl-agent/checks/1/stderr.log",
      confirmationAttempts: [],
      firstBadCommit: null,
      regressionWindow: [test.fixture.baseline, test.fixture.baseline],
      firstBadDiff: null,
      previousRepairSummaries: [],
      fallbackAfterTurn: "the controller may revert or roll back after the repair limit",
    };
    const sdk = new ScriptedAgentSdk([{
      method: "start",
      response: response("changed", "repair the parser"),
      action: async ({ workingDirectory }) => writeFile(path.join(workingDirectory, "repair.txt"), "repair\n", "utf8"),
    }]);
    await new CodexAgentGateway(sdk).invoke(invocation(test, { mode: "recovery", recovery: evidence }));
    expect(sdk.calls[0]?.prompt).toContain("single Recovery Loop coding agent");
    expect(sdk.calls[0]?.prompt).toContain("negative-number regression");
    expect(sdk.calls[0]?.prompt).toContain("runs/rl-agent/checks/1/stderr.log");
    sdk.assertFinished();
  });
});

describe("thread creation, resumption, and rotation", () => {
  it("creates and then successfully resumes the persisted thread", async () => {
    const test = await createGatewayFixture();
    const sdk = new ScriptedAgentSdk([
      { method: "start", threadId: "thread-persisted", response: response("no_change") },
      { method: "resume", threadId: "thread-persisted", response: response("goal_complete") },
    ]);
    const gateway = new CodexAgentGateway(sdk);
    await gateway.invoke(invocation(test));
    await test.store.update((draft) => { draft.agent.pendingResult = null; });
    const resumed = await gateway.invoke(invocation(test));
    expect(sdk.calls.map((call) => call.method)).toEqual(["start", "resume"]);
    expect(sdk.calls[1]?.resumedThreadId).toBe("thread-persisted");
    expect(resumed.resumed).toBe(true);
    expect((await test.store.readState()).agent).toMatchObject({ threadId: "thread-persisted", threadTurns: 2 });
    sdk.assertFinished();
  });

  it("falls back to a fresh thread with reconstructed repository and state context", async () => {
    const test = await createGatewayFixture();
    const sdk = new ScriptedAgentSdk([
      { method: "start", threadId: "thread-old", response: response("no_change") },
      { method: "resume", errorAfterThreadStarted: new Error("thread no longer exists") },
      { method: "start", threadId: "thread-fresh", response: response("no_change") },
    ]);
    const gateway = new CodexAgentGateway(sdk);
    await gateway.invoke(invocation(test));
    await test.store.update((draft) => { draft.agent.pendingResult = null; });
    const result = await gateway.invoke(invocation(test));
    expect(result).toMatchObject({ threadId: "thread-fresh", resumed: false, fallbackToFreshThread: true });
    expect(sdk.calls.map((call) => call.method)).toEqual(["start", "resume", "start"]);
    expect(sdk.calls[2]?.prompt).toContain('"freshThreadReason": "resume-failed"');
    expect(sdk.calls[2]?.prompt).toContain(test.fixture.baseline);
    expect(sdk.calls[2]?.prompt).toContain("# Test goal");
    expect((await test.store.readState()).agent).toMatchObject({ threadId: "thread-fresh", threadTurns: 1 });
    const rotation = (await test.store.readEvents()).events.find((event) => event.type === "thread-rotated");
    expect(rotation?.data.reason).toBe("resume-failed");
    sdk.assertFinished();
  });

  it("honors a forced rotation without attempting resumption", async () => {
    const test = await createGatewayFixture();
    const sdk = new ScriptedAgentSdk([
      { method: "start", threadId: "thread-old", response: response("no_change") },
      { method: "start", threadId: "thread-new", response: response("no_change") },
    ]);
    const gateway = new CodexAgentGateway(sdk);
    await gateway.invoke(invocation(test));
    await test.store.update((draft) => { draft.agent.pendingResult = null; });
    await gateway.invoke(invocation(test, { threadBoundaries: { force: true } }));
    expect(sdk.calls.map((call) => call.method)).toEqual(["start", "start"]);
    expect(sdk.calls[1]?.prompt).toContain('"freshThreadReason": "forced"');
    const rotations = (await test.store.readEvents()).events.filter((event) => event.type === "thread-rotated");
    expect(rotations.at(-1)?.data.reason).toBe("forced");
    expect((await test.store.readState()).agent.threadId).toBe("thread-new");
    sdk.assertFinished();
  });
});

describe("existing Git, safety, and check authority remains outside the agent", () => {
  it("normalizes an agent-created descendant commit through the journaled Git boundary", async () => {
    const test = await createGatewayFixture();
    let agentHead = "";
    const sdk = new ScriptedAgentSdk([{
      method: "start",
      response: response("changed", "agent committed despite its contract"),
      action: async ({ workingDirectory }) => {
        await test.fixture.write(workingDirectory, "agent-commit.txt", "useful work\n");
        agentHead = await test.fixture.commit(workingDirectory, "agent-owned commit");
      },
    }]);
    await new CodexAgentGateway(sdk).invoke(invocation(test));
    const state = await test.store.readState();
    const checkpoint = await journaledCheckpoint(test.store, test.worktree, {
      branch: test.config.branch,
      expectedBase: state.repository.expectedHead,
      summary: "preserve normalized agent work",
      sessionId: state.session.id,
      unitId: "normalized",
      kind: "work",
    });
    const rescueRef = "recovery-loop/rescue/rl-agent-normalized-agent-history";
    expect(checkpoint?.normalizedAgentHead).toBe(agentHead);
    expect(checkpoint?.commit).not.toBe(agentHead);
    expect(await test.worktree.branchHead(rescueRef)).toBe(agentHead);
    expect(await test.worktree.commitCount(`${test.fixture.baseline}..HEAD`)).toBe(1);
    expect(await test.worktree.commitMessage()).toContain("Recovery-Loop-Unit: normalized");
    sdk.assertFinished();
  });

  it("rejects a protected authority edit before creating a checkpoint", async () => {
    const test = await createGatewayFixture();
    const sdk = new ScriptedAgentSdk([{
      method: "start",
      response: response("changed", "incorrectly edit authority"),
      action: async ({ workingDirectory }) => writeFile(path.join(workingDirectory, "RECOVERY_GOAL.md"), "# changed by agent\n", "utf8"),
    }]);
    await new CodexAgentGateway(sdk).invoke(invocation(test));
    const state = await test.store.readState();
    await expect(journaledCheckpoint(test.store, test.worktree, {
      branch: test.config.branch,
      expectedBase: state.repository.expectedHead,
      summary: "must not commit authority",
      sessionId: state.session.id,
      unitId: "protected",
      kind: "work",
      guard: async () => assertCheckpointSafe(test.worktree, {
        expectedBranch: test.config.branch,
        expectedBase: state.repository.expectedHead,
        protectedPaths: test.config.protectedPaths,
        expectedWorktreePath: test.fixture.worktreePath,
      }),
    })).rejects.toBeInstanceOf(SafetyGuardError);
    expect(await test.worktree.head()).toBe(test.fixture.baseline);
    expect(await test.worktree.commitCount(`${test.fixture.baseline}..HEAD`)).toBe(0);
    sdk.assertFinished();
  });

  it("lets command results, never agent prose, determine smoke and deep health", async () => {
    const test = await createGatewayFixture();
    const smoke = {
      id: "smoke",
      argv: [process.execPath, "-e", 'process.exit(require("node:fs").readFileSync("source.txt", "utf8").includes("broken") ? 9 : 0)'],
      timeoutSeconds: 5,
    };
    const config: RecoveryConfig = { ...test.config, checks: { ...test.config.checks, smoke: [smoke] } };
    await checkBaseline({ store: test.store, repository: test.worktree, config, now: "2026-08-07T20:00:00.000Z" });
    const sdk = new ScriptedAgentSdk([{
      method: "start",
      response: response("changed", "all smoke and deep checks PASS"),
      action: async ({ workingDirectory }) => writeFile(path.join(workingDirectory, "source.txt"), "broken\n", "utf8"),
    }]);
    const turn = await new CodexAgentGateway(sdk).invoke(invocation(test, {}, config));
    expect((await test.store.readState()).health.knownGoodCommit).toBe(test.fixture.baseline);
    const state = await test.store.readState();
    const checked = await checkpointAndCheck({
      store: test.store,
      repository: test.worktree,
      config,
      now: "2026-08-07T20:01:00.000Z",
      checkpoint: {
        branch: config.branch,
        expectedBase: state.repository.expectedHead,
        summary: turn.response.summary,
        sessionId: state.session.id,
        unitId: "prose-is-not-health",
        kind: "work",
      },
    });
    expect(checked.checkpoint).not.toBeNull();
    expect(checked.observation?.smokeResults[0]?.classification).toBe("product");
    expect((await test.store.readState()).health.pendingFailure?.checkId).toBe("smoke");
    expect((await test.store.readState()).health.knownGoodCommit).toBe(test.fixture.baseline);
    sdk.assertFinished();
  });
});

async function readOnlyInvocationLog(test: GatewayFixture): Promise<Record<string, unknown>> {
  const layout = await test.store.ensureSessionLayout("rl-agent");
  const directories = await readdir(layout.agent);
  expect(directories).toHaveLength(1);
  const directory = directories[0];
  if (directory === undefined) throw new Error("missing agent log directory");
  return JSON.parse(await readFile(path.join(layout.agent, directory, "invocation.json"), "utf8")) as Record<string, unknown>;
}
