import { randomUUID } from "node:crypto";
import type { AgentGateway } from "./agent-gateway.js";
import { AgentTimeoutError, rotateAgentThread } from "./agent-gateway.js";
import { validateConfig, type RecoveryConfig } from "./config.js";
import type { PendingAgentResult, RecoveryState } from "./contracts.js";
import {
  reconcileStartup,
  type StartupReconcileResult,
} from "./git-operations.js";
import { GitRepository } from "./git-repository.js";
import {
  checkpointAndCheck,
  resumeInterruptedCheckSet,
  runScheduledChecks,
  type HealthControllerOptions,
} from "./health-controller.js";
import {
  processRecoveryResult,
  recoverPendingFailure,
  type RecoveryControllerOptions,
} from "./recovery.js";
import { assertCheckpointSafe, SafetyGuardError } from "./safety.js";
import { StateStore } from "./state-store.js";

export * from "./health-controller.js";

export type RunStopReason =
  | "goal-candidate-ready" | "recovery-pending" | "blocked" | "no-progress"
  | "max-agent-turns" | "max-checkpoints" | "max-wall-time" | "signal"
  | "agent-turn-timeout" | "agent-error" | "guard-rejected" | "repair-exhausted"
  | "recovery-flaky" | "recovery-infrastructure" | "recovery-safety";
export interface RunLimits { maxAgentTurns?: number; maxCheckpoints?: number; maxMinutes?: number }
export interface RunControllerHooks {
  afterStartup?: (result: StartupReconcileResult) => void | Promise<void>;
  afterCheckpointMutation?: () => void | Promise<void>;
}
export interface RunControllerOptions {
  repository: GitRepository;
  gateway: AgentGateway;
  store?: StateStore;
  limits?: RunLimits;
  signal?: AbortSignal;
  clock?: () => Date;
  hooks?: RunControllerHooks;
}
export interface RunControllerResult { summary: Record<string, unknown>; summaryPath: string }

interface LoopContext {
  operator: GitRepository; worktree: GitRepository; store: StateStore; gateway: AgentGateway;
  config: RecoveryConfig; maxCheckpoints: number; signal: AbortSignal; clock: () => Date;
  hooks?: RunControllerHooks;
}
interface ProcessResult { stop: RunStopReason | null; detail: string | null }
class WallTimeLimit extends Error {}

export async function runNormalController(options: RunControllerOptions): Promise<RunControllerResult> {
  const store = options.store ?? new StateStore(options.repository.gitCommonDir);
  const lock = await store.acquireLock("run");
  try { return await runLocked(options, store); }
  finally { await lock.release(); }
}

async function runLocked(options: RunControllerOptions, store: StateStore): Promise<RunControllerResult> {
  const clock = options.clock ?? (() => new Date());
  let state = await store.readState();
  if (state.phase === "stopped" || state.session.status === "stopped") {
    state = await beginNewSession(store, state, clock());
  }
  const config = effectiveConfig(await configAt(options.repository, state), options.limits);
  if (config.branch !== state.repository.branch) throw new Error("tracked config branch differs from durable state");
  const maxCheckpoints = options.limits?.maxCheckpoints ?? Number.MAX_SAFE_INTEGER;
  const linked = linkedSignal(options.signal, Date.parse(state.session.startedAt) + config.limits.maxWallMinutes * 60_000, clock);
  let worktree: GitRepository;
  try {
    await store.appendEvent({ type: "session-started", headCommit: state.repository.expectedHead, data: { command: "run" } });
    const guard = (repository: GitRepository): Promise<void> => checkpointGuard(repository, config, state.repository.expectedHead, state.repository.worktreePath);
    const startup = await reconcileStartup(options.repository, store, { guard });
    worktree = await GitRepository.open((await store.readState()).repository.worktreePath);
    if (startup.checkpoint?.normalizedAgentHead !== null && startup.checkpoint?.normalizedAgentHead !== undefined) {
      await rotateAgentThread(store, startup.checkpoint.commit, "agent-history-violation");
    }
    await resumeStartupCheck(startup, { store, repository: worktree, config, now: clock().toISOString() });
    if (startup.action === "resume-agent" || startup.action === "resume-repair") {
      const resumed = await store.readState();
      await store.finishOperation(resumed.repository.expectedHead);
    } else if (startup.action === "restart-diagnosis") {
      await store.finishOperation((await store.readState()).repository.expectedHead);
    }
    await options.hooks?.afterStartup?.(startup);
  } catch (error) {
    linked.dispose();
    if (error instanceof SafetyGuardError) {
      await appendGuardEvent(store, error);
      return await stopSession(options.repository, store, "guard-rejected", error.message, clock);
    }
    throw error;
  }
  const context: LoopContext = {
    operator: options.repository, worktree, store, gateway: options.gateway, config,
    maxCheckpoints, signal: linked.signal, clock,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  };
  try {
    while (true) {
      state = await store.readState();
      if (state.agent.pendingResult !== null) {
        const processed = state.agent.pendingResult.mode === "recovery"
          ? await processRecoveryResult(recoveryOptions(context), state.agent.pendingResult)
          : await processAgentResult(context, state.agent.pendingResult);
        if (processed.stop !== null && processed.stop !== "recovery-pending") {
          return await stopSession(context.operator, store, processed.stop, processed.detail, clock);
        }
        continue;
      }
      const abortStop = stopForAbort(context.signal);
      if (abortStop !== null) return await stopSession(context.operator, store, abortStop, null, clock);
      if (state.health.pendingFailure !== null) {
        const recovered = await recoverPendingFailure(recoveryOptions(context), state.health.pendingFailure);
        if (recovered.stop !== null) {
          return await stopSession(context.operator, store, recovered.stop, recovered.detail, clock);
        }
        continue;
      }
      const scheduled = await runScheduledChecks(healthOptions(context));
      if (scheduled?.pendingFailure !== null && scheduled?.pendingFailure !== undefined) {
        continue;
      }
      state = await store.readState();
      if (state.agent.turns >= config.limits.maxAgentTurns) return await stopSession(context.operator, store, "max-agent-turns", null, clock);
      if (await countSessionCheckpoints(context.operator, state) >= maxCheckpoints) return await stopSession(context.operator, store, "max-checkpoints", null, clock);
      const boundary = stopForAbort(context.signal);
      if (boundary !== null) return await stopSession(context.operator, store, boundary, null, clock);
      const unitId = `unit-${String(state.agent.turns + 1).padStart(5, "0")}`;
      try {
        await context.gateway.invoke({ store, repository: worktree, config, unitId, mode: "work", signal: context.signal });
      } catch (error) {
        const stopped = await settleFailedAgent(context, error);
        return await stopSession(context.operator, store, stopped.stop ?? "agent-error", stopped.detail, clock);
      }
    }
  } catch (error) {
    if (error instanceof SafetyGuardError) {
      await appendGuardEvent(store, error);
      return await stopSession(context.operator, store, "guard-rejected", error.message, clock);
    }
    throw error;
  } finally { linked.dispose(); }
}

async function processAgentResult(context: LoopContext, pending: PendingAgentResult): Promise<ProcessResult> {
  const before = await context.store.readState();
  const expectedBase = before.repository.expectedHead;
  const result = await checkpointAndCheck({
    ...healthOptions(context),
    checkpoint: {
      branch: context.config.branch, expectedBase, summary: pending.response.summary,
      sessionId: before.session.id, unitId: pending.unitId, kind: "work",
      guard: () => checkpointGuard(context.worktree, context.config, expectedBase, before.repository.worktreePath),
      ...(context.hooks?.afterCheckpointMutation === undefined ? {} : {
        hooks: { afterGitMutation: (kind) => kind === "checkpoint" ? context.hooks!.afterCheckpointMutation!() : undefined },
      }),
    },
    ...(pending.response.outcome === "goal_complete" ? { goalComplete: true } : {}),
  });
  const useful = result.checkpoint !== null || before.repository.expectedHead !== pending.baseCommit;
  if (result.checkpoint?.normalizedAgentHead !== null && result.checkpoint?.normalizedAgentHead !== undefined) {
    await rotateAgentThread(context.store, result.checkpoint.commit, "agent-history-violation");
  }
  const updated = await context.store.update((draft) => {
    if (draft.agent.pendingResult?.turnId !== pending.turnId) throw new Error("pending agent result changed while it was handled");
    draft.agent.pendingResult = null;
    if (useful) draft.agent.consecutiveNoChange = 0;
    else if (pending.response.outcome !== "goal_complete" && pending.response.outcome !== "blocked") draft.agent.consecutiveNoChange += 1;
  }, context.clock().toISOString());
  if (updated.health.pendingFailure !== null) return { stop: "recovery-pending", detail: updated.health.pendingFailure.id };
  if (pending.response.outcome === "blocked") return { stop: "blocked", detail: pending.response.blocker };
  if (pending.response.outcome === "goal_complete") {
    const head = updated.repository.expectedHead;
    const checksPassed = updated.health.lastSmokePassCommit === head &&
      (!context.config.deepPolicy.beforeGoalComplete || updated.health.knownGoodCommit === head);
    return checksPassed ? { stop: "goal-candidate-ready", detail: null }
      : { stop: "recovery-pending", detail: "completion checks did not establish required health" };
  }
  const abort = stopForAbort(context.signal);
  if (abort !== null) return { stop: abort, detail: null };
  return updated.agent.consecutiveNoChange >= 2 ? { stop: "no-progress", detail: null } : { stop: null, detail: null };
}

async function settleFailedAgent(context: LoopContext, error: unknown): Promise<ProcessResult> {
  const state = await context.store.readState();
  const guard = (repository: GitRepository): Promise<void> => checkpointGuard(repository, context.config, state.repository.expectedHead, state.repository.worktreePath);
  const startup = await reconcileStartup(context.operator, context.store, { guard });
  if (startup.checkpoint?.normalizedAgentHead !== null && startup.checkpoint?.normalizedAgentHead !== undefined) {
    await rotateAgentThread(context.store, startup.checkpoint.commit, "agent-history-violation");
  }
  if (startup.action === "resume-agent" || startup.action === "resume-repair") {
    await context.store.finishOperation((await context.store.readState()).repository.expectedHead);
  } else if (startup.action === "interrupted-work-checkpointed" || startup.action === "checkpoint-finished" || startup.action === "checkpoint-adopted") {
    await runScheduledChecks(healthOptions(context));
  }
  const settled = await context.store.readState();
  if (settled.health.pendingFailure !== null) return { stop: "recovery-pending", detail: settled.health.pendingFailure.id };
  const abort = stopForAbort(context.signal);
  if (abort !== null) return { stop: abort, detail: errorMessage(error) };
  return error instanceof AgentTimeoutError
    ? { stop: "agent-turn-timeout", detail: error.message }
    : { stop: "agent-error", detail: errorMessage(error) };
}

async function resumeStartupCheck(result: StartupReconcileResult, options: HealthControllerOptions): Promise<void> {
  if (result.action === "rerun-smoke") await resumeInterruptedCheckSet(options, "smoke");
  else if (result.action === "rerun-deep") await resumeInterruptedCheckSet(options, "deep");
}
function healthOptions(context: LoopContext): HealthControllerOptions {
  return { store: context.store, repository: context.worktree, config: context.config, now: context.clock().toISOString() };
}
function recoveryOptions(context: LoopContext): RecoveryControllerOptions {
  return {
    operator: context.operator,
    worktree: context.worktree,
    store: context.store,
    gateway: context.gateway,
    config: context.config,
    maxCheckpoints: context.maxCheckpoints,
    signal: context.signal,
    clock: context.clock,
    abortStop: () => stopForAbort(context.signal),
    ...(context.hooks?.afterCheckpointMutation === undefined
      ? {}
      : { afterCheckpointMutation: context.hooks.afterCheckpointMutation }),
  };
}
async function checkpointGuard(repository: GitRepository, config: RecoveryConfig, expectedBase: string, worktreePath: string): Promise<void> {
  await assertCheckpointSafe(repository, {
    expectedBranch: config.branch, expectedBase, protectedPaths: config.protectedPaths,
    expectedWorktreePath: worktreePath,
  });
}

async function stopSession(operator: GitRepository, store: StateStore, reason: RunStopReason, detail: string | null, clock: () => Date): Promise<RunControllerResult> {
  const finishedAt = clock().toISOString();
  await store.update((draft) => {
    draft.phase = "stopped"; draft.operation = null; draft.session.status = "stopped"; draft.session.stopReason = reason;
  }, finishedAt);
  let state = await store.readState();
  const finalCommit = await operator.branchHead(state.repository.branch) ?? state.repository.expectedHead;
  await store.appendEvent({ type: "session-stopped", headCommit: finalCommit, data: { reason, detail } });
  state = await store.readState();
  const events = (await store.readEvents()).events.filter((event) => event.sessionId === state.session.id);
  const count = (type: string): number => events.filter((event) => event.type === type).length;
  const rescueRefs = [...new Set([...state.recovery.rescueRefs, ...events.map((event) => event.data.rescueRef).filter((value): value is string => typeof value === "string")])];
  const summary: Record<string, unknown> = {
    schemaVersion: 1, sessionId: state.session.id, startedAt: state.session.startedAt, finishedAt,
    baselineCommit: state.repository.baselineCommit, finalCommit, knownGoodCommit: state.health.knownGoodCommit,
    stopReason: reason, stopDetail: detail,
    wallTimeMilliseconds: Math.max(0, Date.parse(finishedAt) - Date.parse(state.session.startedAt)),
    agentTurns: state.usage.agentTurns,
    tokenUsage: { inputTokens: state.usage.inputTokens, cachedInputTokens: state.usage.cachedInputTokens,
      outputTokens: state.usage.outputTokens, reasoningTokens: state.usage.reasoningTokens },
    checkpoints: await countSessionCheckpoints(operator, state),
    smokeExecutions: events.filter((event) => event.type === "check-completed" && event.data.category === "smoke").length,
    deepExecutions: events.filter((event) => event.type === "check-completed" && event.data.category === "deep").length,
    diagnosticExecutions: events.filter((event) => event.type === "check-completed" &&
      (event.data.category === "diagnostic" || event.data.category === "prepare")).length,
    checkMilliseconds: state.usage.checkMilliseconds,
    regressionsObserved: count("failure-observed"), confirmedRegressions: count("failure-confirmed"),
    regressionsRepaired: count("failure-repaired"), reverts: count("revert-created"), hardRollbacks: count("rollback-completed"),
    confirmationAttempts: count("confirmation-attempted"), repairTurns: count("repair-started"),
    repairCheckpoints: events.filter((event) => event.type === "checkpoint-created" && event.data.kind === "repair").length,
    repairEvaluations: count("repair-evaluated"), recoveryCycles: count("failure-confirmed"),
    environmentAttempts: events.filter((event) => event.type === "failure-classified" &&
      typeof event.data.environmentAttempt === "number").length,
    recoveryClassifications: Object.fromEntries(["product", "flaky", "infrastructure", "safety"]
      .map((classification) => [classification, events.filter((event) =>
        event.type === "failure-classified" && event.data.classification === classification).length])),
    rescueRefs,
    flakyChecks: events.filter((event) =>
      (event.type === "check-completed" || event.type === "failure-classified") &&
      event.data.classification === "flaky").length,
    humanInterventions: 0,
    recovery: { activeFailureId: state.recovery.activeFailureId, sameSignatureCycles: state.recovery.sameSignatureCycles,
      lastFailureSignature: state.recovery.lastFailureSignature,
      abandonedRanges: state.recovery.abandonedRanges.length, rescueRefs: state.recovery.rescueRefs.length,
      pendingRepairAttempts: state.health.pendingFailure?.repairAttempts ?? 0,
      pendingRecoveryCycles: state.health.pendingFailure?.recoveryCycles ?? 0,
      pendingConfirmationAttempts: state.health.pendingFailure?.confirmationAttempts.length ?? 0,
      pendingEnvironmentAttempts: state.health.pendingFailure?.environmentAttempts ?? 0 },
    pendingFailure: state.health.pendingFailure,
    agentCompletionBelief: events.some((event) => event.type === "agent-completed" && event.data.outcome === "goal_complete"),
    finalHeadReceivedDeepPass: state.health.knownGoodCommit === finalCommit && state.health.lastDeepRunCommit === finalCommit,
  };
  return { summary, summaryPath: await store.writeSummary(state.session.id, summary) };
}

async function beginNewSession(store: StateStore, previous: RecoveryState, now: Date): Promise<RecoveryState> {
  const timestamp = now.toISOString();
  return store.update((draft) => {
    draft.session = { id: sessionId(now), startedAt: timestamp, status: "running", stopReason: null };
    draft.phase = "idle"; draft.operation = null;
    draft.agent.turns = 0; draft.agent.consecutiveNoChange = 0;
    draft.usage = { agentTurns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, checkMilliseconds: 0 };
    if (previous.agent.pendingResult === null) draft.agent.pendingResult = null;
  }, timestamp);
}
async function configAt(repository: GitRepository, state: RecoveryState): Promise<RecoveryConfig> {
  const raw = (await repository.git(["show", `${state.repository.expectedHead}:.recovery-loop/config.json`])).stdout;
  try { return validateConfig(JSON.parse(raw)); }
  catch (error) { throw new Error(`tracked recovery config is invalid: ${errorMessage(error)}`, { cause: error }); }
}
function effectiveConfig(config: RecoveryConfig, limits: RunLimits | undefined): RecoveryConfig {
  return { ...config, limits: { ...config.limits,
    maxAgentTurns: Math.min(config.limits.maxAgentTurns, limits?.maxAgentTurns ?? Number.MAX_SAFE_INTEGER),
    maxWallMinutes: Math.min(config.limits.maxWallMinutes, limits?.maxMinutes ?? Number.MAX_SAFE_INTEGER),
  } };
}
async function countSessionCheckpoints(repository: GitRepository, state: RecoveryState): Promise<number> {
  const output = (await repository.git(["log", state.repository.branch, "--format=%B%x00"])).stdout;
  const trailer = `Recovery-Loop-Session: ${state.session.id}`;
  return output.split("\0").filter((message) => message.includes(trailer)).length;
}
async function appendGuardEvent(store: StateStore, error: SafetyGuardError): Promise<void> {
  const state = await store.readState();
  await store.appendEvent({ type: "guard-rejected", headCommit: state.repository.expectedHead,
    data: { violations: error.violations.map((violation) => ({ code: violation.code, path: violation.path })) } });
}
function linkedSignal(external: AbortSignal | undefined, deadline: number, clock: () => Date): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const forward = (): void => controller.abort(external?.reason);
  if (external?.aborted === true) forward(); else external?.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => controller.abort(new WallTimeLimit("session wall-time limit reached")), Math.max(0, deadline - clock().getTime()));
  timer.unref();
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); external?.removeEventListener("abort", forward); } };
}
function stopForAbort(signal: AbortSignal): "max-wall-time" | "signal" | null {
  if (!signal.aborted) return null;
  return signal.reason instanceof WallTimeLimit ? "max-wall-time" : "signal";
}
function sessionId(now: Date): string { return `rl-${now.toISOString().replaceAll(/\D/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
