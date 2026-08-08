import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentGateway, RecoveryEvidence } from "./agent-gateway.js";
import { AgentTimeoutError, rotateAgentThread } from "./agent-gateway.js";
import { confirmFailure, runJournaledCommandSet, type ConfirmationResult } from "./check-runner.js";
import type { RecoveryConfig } from "./config.js";
import { validateCommandResult, type CommandResult, type CommandSpec,
  type FailureAttempt, type PendingAgentResult, type PendingFailure,
  type RecoveryState } from "./contracts.js";
import { journaledCheckpoint, reconcileStartup } from "./git-operations.js";
import type { GitRepository } from "./git-repository.js";
import { runRecoveryChecks, type HealthControllerOptions } from "./health-controller.js";
import { assertCheckpointSafe } from "./safety.js";
import type { StateStore } from "./state-store.js";

export type RecoveryStopReason =
  | "blocked" | "max-agent-turns" | "max-checkpoints" | "max-wall-time" | "signal"
  | "agent-turn-timeout" | "agent-error" | "repair-exhausted"
  | "recovery-flaky" | "recovery-infrastructure" | "recovery-safety";
export interface RecoveryProcessResult {
  stop: RecoveryStopReason | null; detail: string | null;
}
export interface RecoveryControllerOptions {
  operator: GitRepository; worktree: GitRepository; store: StateStore;
  gateway: AgentGateway; config: RecoveryConfig; maxCheckpoints: number;
  signal: AbortSignal; clock: () => Date;
  abortStop: () => "max-wall-time" | "signal" | null;
  afterCheckpointMutation?: () => void | Promise<void>;
}

export async function recoverPendingFailure(
  context: RecoveryControllerOptions,
  pending: PendingFailure,
): Promise<RecoveryProcessResult> {
  if (!pending.confirmed) return confirmPendingFailure(context, pending);
  if (pending.classification === "flaky") {
    return { stop: "recovery-flaky", detail: `failure ${pending.id} remained unstable` };
  }
  if (pending.classification === "infrastructure") {
    return recoverInfrastructure(context, pending);
  }
  if (pending.classification === "safety") {
    return { stop: "recovery-safety", detail: `failure ${pending.id} crossed a safety boundary` };
  }
  if (pending.recoveryCycles > context.config.limits.maxRecoveryCyclesPerSignature) {
    return exhaustRepair(context, pending, "same-signature recovery-cycle limit reached");
  }
  const state = await context.store.readState();
  const head = await context.worktree.assertBranchIdentity(context.config.branch);
  if (head !== state.repository.expectedHead) throw new Error("recovery head differs from durable state");
  if (head !== pending.discoveredAtCommit && pending.lastEvaluatedRepairCommit !== head) {
    return evaluateRepairCommit(context, pending, head);
  }
  if (pending.repairAttempts >= context.config.limits.maxRepairTurnsPerFailure) {
    return exhaustRepair(context, pending, "forward-repair turn limit reached");
  }
  if (state.agent.turns >= context.config.limits.maxAgentTurns) {
    return { stop: "max-agent-turns", detail: pending.id };
  }
  if (await countSessionCheckpoints(context.operator, state) >= context.maxCheckpoints) {
    return { stop: "max-checkpoints", detail: pending.id };
  }
  const abort = context.abortStop();
  if (abort !== null) return { stop: abort, detail: pending.id };
  let evidence: RecoveryEvidence;
  try {
    evidence = await buildRecoveryEvidence(context, pending, head);
  } catch (error) {
    await classifyEvidenceFailure(context.store, pending.id, head, errorMessage(error));
    return { stop: "recovery-safety", detail: errorMessage(error) };
  }
  const attempt = pending.repairAttempts + 1;
  await context.store.update((draft) => {
    const current = requireFailure(draft, pending.id);
    if (current.repairAttempts !== attempt - 1) throw new Error("repair attempt changed before invocation");
    current.repairAttempts = attempt;
  }, context.clock().toISOString());
  await context.store.appendEvent({ type: "repair-started", headCommit: head,
    data: { failureId: pending.id, attempt, signature: pending.signature } });
  try {
    await context.gateway.invoke({
      store: context.store,
      repository: context.worktree,
      config: context.config,
      unitId: `repair-${pending.id}-${attempt}`,
      mode: "recovery",
      recovery: evidence,
      signal: context.signal,
    });
    return { stop: null, detail: null };
  } catch (error) {
    return settleFailedRecoveryAgent(context, error);
  }
}

async function confirmPendingFailure(
  context: RecoveryControllerOptions,
  pending: PendingFailure,
): Promise<RecoveryProcessResult> {
  let command: CommandSpec;
  let first: CommandResult;
  try {
    command = configuredCommand(context.config, pending.checkId);
    first = await loadBoundResult(context, pending.latestResultPath, command, pending.discoveredAtCommit);
    if (first.classification !== pending.classification || first.signature !== pending.signature) {
      throw new Error("pending failure does not match its exact original command result");
    }
  } catch (error) {
    const classification = pending.classification === "infrastructure" ? "infrastructure" : "safety";
    await classifyEvidenceFailure(context.store, pending.id, pending.discoveredAtCommit,
      errorMessage(error), classification);
    return { stop: classification === "infrastructure" ? "recovery-infrastructure" : "recovery-safety",
      detail: errorMessage(error) };
  }
  if (first.classification === "safety") {
    await context.store.update((draft) => {
      const current = requireFailure(draft, pending.id);
      current.classification = "safety";
    }, context.clock().toISOString());
    await context.store.appendEvent({ type: "failure-classified", headCommit: first.commit,
      data: { failureId: pending.id, classification: "safety", confirmed: false } });
    return { stop: "recovery-safety", detail: first.error };
  }
  if (pending.confirmationAttempts.length === 0) {
    await persistConfirmationAttempt(context, pending.id, first, 1, pending.latestResultPath);
  }
  const refreshed = requireFailure(await context.store.readState(), pending.id);
  let attempts: CommandResult[];
  try {
    attempts = await Promise.all(refreshed.confirmationAttempts.map(async (attempt, index) => {
      if (attempt.attempt !== index + 1) throw new Error("confirmation attempt sequence is not contiguous");
      return loadBoundResult(context, attempt.resultPath, command, pending.discoveredAtCommit);
    }));
  } catch (error) {
    await classifyEvidenceFailure(context.store, pending.id, pending.discoveredAtCommit, errorMessage(error));
    return { stop: "recovery-safety", detail: errorMessage(error) };
  }
  let confirmation: ConfirmationResult;
  try {
    confirmation = await confirmFailure(first, async (attempt) => {
      const result = await runRecoveryCommand(context, command, pending.discoveredAtCommit, "diagnostic");
      const resultPath = requiredResultPath(result);
      await persistConfirmationAttempt(context, pending.id, result, attempt, resultPath);
      return result;
    }, attempts);
  } catch (error) {
    await classifyEvidenceFailure(context.store, pending.id, pending.discoveredAtCommit,
      errorMessage(error), "infrastructure");
    return { stop: "recovery-infrastructure", detail: errorMessage(error) };
  }
  const classification = confirmation.classification === "pass"
    ? "flaky"
    : confirmation.classification;
  let cycle = 0;
  await context.store.update((draft) => {
    const current = requireFailure(draft, pending.id);
    current.classification = classification;
    current.signature = confirmation.signature;
    current.confirmed = confirmation.confirmedFailure;
    const latest = current.confirmationAttempts.at(-1);
    if (latest !== undefined) current.latestResultPath = latest.resultPath;
    if (confirmation.confirmedFailure && classification === "product") {
      const same = draft.recovery.lastFailureSignature === confirmation.signature;
      draft.recovery.lastFailureSignature = confirmation.signature;
      draft.recovery.sameSignatureCycles = same ? draft.recovery.sameSignatureCycles + 1 : 1;
      current.recoveryCycles = draft.recovery.sameSignatureCycles;
      cycle = current.recoveryCycles;
    }
  }, context.clock().toISOString());
  await context.store.appendEvent({ type: "failure-classified", headCommit: pending.discoveredAtCommit,
    data: { failureId: pending.id, classification,
      consensus: confirmation.consensus, confirmed: confirmation.confirmedFailure,
      attempts: confirmation.attempts.length } });
  if (confirmation.confirmedFailure && classification === "product") {
    await context.store.appendEvent({ type: "failure-confirmed", headCommit: pending.discoveredAtCommit,
      data: { failureId: pending.id, signature: confirmation.signature, recoveryCycle: cycle } });
    return { stop: null, detail: null };
  }
  if (classification === "flaky" && confirmation.consensus === "pass") {
    await clearFlakyObservation(context, pending.id);
    return { stop: null, detail: null };
  }
  if (classification === "flaky") {
    return { stop: "recovery-flaky", detail: `failure ${pending.id} had no stable two-of-three result` };
  }
  if (classification === "infrastructure") {
    return recoverInfrastructure(context, requireFailure(await context.store.readState(), pending.id));
  }
  return { stop: "recovery-safety", detail: `failure ${pending.id} was classified as safety` };
}

export async function processRecoveryResult(
  context: RecoveryControllerOptions,
  pendingResult: PendingAgentResult,
): Promise<RecoveryProcessResult> {
  const before = await context.store.readState();
  const failure = before.health.pendingFailure;
  if (failure === null) throw new Error("recovery result has no pending failure");
  const expectedBase = before.repository.expectedHead;
  const checkpoint = await journaledCheckpoint(context.store, context.worktree, {
    branch: context.config.branch,
    expectedBase,
    summary: pendingResult.response.summary,
    sessionId: before.session.id,
    unitId: pendingResult.unitId,
    kind: "repair",
    guard: () => checkpointGuard(context.worktree, context.config, expectedBase, before.repository.worktreePath),
    ...(context.afterCheckpointMutation === undefined ? {} : {
      hooks: { afterGitMutation: (kind) => kind === "checkpoint" ? context.afterCheckpointMutation!() : undefined },
    }),
  });
  const head = (await context.store.readState()).repository.expectedHead;
  const useful = checkpoint !== null || head !== pendingResult.baseCommit;
  if (checkpoint?.normalizedAgentHead !== null && checkpoint?.normalizedAgentHead !== undefined) {
    await rotateAgentThread(context.store, checkpoint.commit, "agent-history-violation");
  }
  await context.store.update((draft) => {
    if (draft.agent.pendingResult?.turnId !== pendingResult.turnId) {
      throw new Error("pending recovery result changed while it was handled");
    }
    draft.agent.pendingResult = null;
    if (useful && draft.health.pendingFailure?.id === failure.id) {
      draft.health.pendingFailure.lastRepairCommit = head;
    }
  }, context.clock().toISOString());
  let evaluated: RecoveryProcessResult = { stop: null, detail: null };
  if (useful) evaluated = await evaluateRepairCommit(context, failure, head);
  if (evaluated.stop !== null) return evaluated;
  if (pendingResult.response.outcome === "blocked") {
    return { stop: "blocked", detail: pendingResult.response.blocker };
  }
  const current = (await context.store.readState()).health.pendingFailure;
  if (current !== null && current.repairAttempts >= context.config.limits.maxRepairTurnsPerFailure) {
    return exhaustRepair(context, current, "forward-repair turn limit reached");
  }
  return { stop: null, detail: null };
}

async function evaluateRepairCommit(
  context: RecoveryControllerOptions,
  failure: PendingFailure,
  commit: string,
): Promise<RecoveryProcessResult> {
  const message = await context.worktree.commitMessage(commit);
  if (!message.includes("Recovery-Loop-Kind: repair")) {
    await classifyEvidenceFailure(context.store, failure.id, commit, "unevaluated recovery head is not a repair checkpoint");
    return { stop: "recovery-safety", detail: "recovery head is not a controller repair checkpoint" };
  }
  const command = configuredCommand(context.config, failure.checkId);
  const result = await runRecoveryCommand(context, command, commit, "diagnostic");
  const resultPath = optionalResultPath(result);
  const boundaryClassification = result.classification === "infrastructure" ||
    result.classification === "flaky" || result.classification === "safety"
    ? result.classification
    : null;
  await context.store.update((draft) => {
    const current = requireFailure(draft, failure.id);
    current.lastRepairCommit = commit;
    current.lastEvaluatedRepairCommit = commit;
    if (resultPath !== null) current.latestResultPath = resultPath;
    if (boundaryClassification !== null) {
      current.classification = boundaryClassification;
      current.confirmed = false;
      current.discoveredAtCommit = commit;
      current.confirmationAttempts = resultPath === null ? [] : [attemptRecord(result, 1, resultPath)];
    }
  }, context.clock().toISOString());
  await context.store.appendEvent({ type: "repair-evaluated", headCommit: commit,
    data: { failureId: failure.id, attempt: failure.repairAttempts,
      classification: result.classification, signature: result.signature, resultPath } });
  if (result.classification === "pass") {
    const observation = await runRecoveryChecks(recoveryHealthOptions(context), commit);
    if (observation.pendingFailure === null) {
      await context.store.appendEvent({ type: "failure-repaired", headCommit: commit,
        data: { failureId: failure.id, signature: failure.signature,
          repairAttempts: failure.repairAttempts } });
    }
    return { stop: null, detail: null };
  }
  if (result.classification === "product") {
    const current = requireFailure(await context.store.readState(), failure.id);
    return current.repairAttempts >= context.config.limits.maxRepairTurnsPerFailure
      ? exhaustRepair(context, current, "failing predicate still fails at the repair limit")
      : { stop: null, detail: null };
  }
  return result.classification === "infrastructure"
    ? { stop: "recovery-infrastructure", detail: result.error }
    : { stop: "recovery-safety", detail: result.error };
}

async function recoverInfrastructure(
  context: RecoveryControllerOptions,
  failure: PendingFailure,
): Promise<RecoveryProcessResult> {
  if (context.config.prepare === null || failure.environmentAttempts >= 1) {
    return { stop: "recovery-infrastructure",
      detail: `failure ${failure.id} remained infrastructural after its bounded retry` };
  }
  const head = (await context.store.readState()).repository.expectedHead;
  await context.store.update((draft) => {
    requireFailure(draft, failure.id).environmentAttempts += 1;
  }, context.clock().toISOString());
  const prepare: CommandSpec = {
    id: `prepare-${failure.checkId}`,
    argv: context.config.prepare.argv,
    timeoutSeconds: context.config.prepare.timeoutSeconds,
  };
  const prepared = await runRecoveryCommand(context, prepare, head, "prepare");
  await context.store.appendEvent({ type: "failure-classified", headCommit: head,
    data: { failureId: failure.id, classification: "infrastructure",
      environmentAttempt: 1, prepareClassification: prepared.classification } });
  if (prepared.classification !== "pass") {
    return { stop: "recovery-infrastructure",
      detail: prepared.error ?? `prepare command exited ${String(prepared.exitCode)}` };
  }
  const command = configuredCommand(context.config, failure.checkId);
  const result = await runRecoveryCommand(context, command, head, "diagnostic");
  const resultPath = optionalResultPath(result);
  if (result.classification === "pass") {
    await clearFlakyObservation(context, failure.id);
    return { stop: null, detail: null };
  }
  const failureClassification = result.classification;
  await context.store.update((draft) => {
    const current = requireFailure(draft, failure.id);
    current.classification = failureClassification;
    current.signature = result.signature;
    current.confirmed = false;
    current.discoveredAtCommit = head;
    current.confirmationAttempts = resultPath === null ? [] : [attemptRecord(result, 1, resultPath)];
    if (resultPath !== null) current.latestResultPath = resultPath;
  }, context.clock().toISOString());
  if (result.classification === "product") return { stop: null, detail: null };
  return result.classification === "infrastructure"
    ? { stop: "recovery-infrastructure", detail: result.error }
    : { stop: "recovery-safety", detail: result.error };
}

async function settleFailedRecoveryAgent(
  context: RecoveryControllerOptions,
  error: unknown,
): Promise<RecoveryProcessResult> {
  const state = await context.store.readState();
  const guard = (repository: GitRepository): Promise<void> => checkpointGuard(
    repository,
    context.config,
    state.repository.expectedHead,
    state.repository.worktreePath,
  );
  const startup = await reconcileStartup(context.operator, context.store, { guard });
  if (startup.checkpoint?.normalizedAgentHead !== null && startup.checkpoint?.normalizedAgentHead !== undefined) {
    await rotateAgentThread(context.store, startup.checkpoint.commit, "agent-history-violation");
  }
  if (startup.action === "resume-repair") {
    await context.store.finishOperation((await context.store.readState()).repository.expectedHead);
  }
  let evaluation: RecoveryProcessResult = { stop: null, detail: null };
  const reconciled = await context.store.readState();
  const pending = reconciled.health.pendingFailure;
  if (
    pending !== null &&
    reconciled.repository.expectedHead !== pending.discoveredAtCommit &&
    pending.lastEvaluatedRepairCommit !== reconciled.repository.expectedHead
  ) {
    evaluation = await evaluateRepairCommit(context, pending, reconciled.repository.expectedHead);
  }
  const after = await context.store.readState();
  if (
    after.health.pendingFailure !== null &&
    after.health.pendingFailure.repairAttempts >= context.config.limits.maxRepairTurnsPerFailure
  ) {
    await rotateAgentThread(context.store, after.repository.expectedHead, "repair-attempt-limit");
  }
  const abort = context.abortStop();
  if (abort !== null) return { stop: abort, detail: errorMessage(error) };
  if (evaluation.stop !== null) return evaluation;
  return error instanceof AgentTimeoutError
    ? { stop: "agent-turn-timeout", detail: error.message }
    : { stop: "agent-error", detail: errorMessage(error) };
}

async function buildRecoveryEvidence(
  context: RecoveryControllerOptions,
  failure: PendingFailure,
  currentCommit: string,
): Promise<RecoveryEvidence> {
  const command = configuredCommand(context.config, failure.checkId);
  const result = await loadBoundResult(context, failure.latestResultPath, command, currentCommit);
  if (result.classification !== "product") {
    throw new Error(`recovery agent evidence is ${result.classification}, not a product failure`);
  }
  if (result.stdoutPath === null || result.stderrPath === null) {
    throw new Error("product failure evidence is missing complete command-log paths");
  }
  const events = (await context.store.readEvents()).events;
  const prefix = `repair-${failure.id}-`;
  const previousRepairSummaries = events
    .filter((event) => event.type === "agent-completed" && event.data.mode === "recovery" &&
      typeof event.data.unitId === "string" && event.data.unitId.startsWith(prefix) &&
      typeof event.data.summary === "string")
    .map((event) => event.data.summary as string);
  return {
    checkId: failure.checkId,
    failingCommand: command.argv,
    normalizedOutcome: `${result.classification}; exit=${String(result.exitCode)}; signal=${String(result.signal)}; signature=${result.signature}`,
    failedCommit: failure.discoveredAtCommit,
    currentCommit,
    knownGoodCommit: failure.knownGoodCommit,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdoutTail: result.stdoutTail,
    stderrTail: result.stderrTail,
    error: result.error,
    resultPath: failure.latestResultPath,
    stdoutPath: result.stdoutPath,
    stderrPath: result.stderrPath,
    confirmationAttempts: failure.confirmationAttempts,
    firstBadCommit: failure.firstBadCommit,
    regressionWindow: failure.regressionWindow,
    firstBadDiff: null,
    previousRepairSummaries,
    fallbackAfterTurn: `forward repair only; stop at the Stage 9 boundary after ${context.config.limits.maxRepairTurnsPerFailure} repair turns`,
  };
}

async function runRecoveryCommand(
  context: RecoveryControllerOptions,
  command: CommandSpec,
  commit: string,
  category: "diagnostic" | "prepare",
): Promise<CommandResult> {
  const state = await context.store.readState();
  if (state.repository.expectedHead !== commit) throw new Error("recovery command is not bound to durable HEAD");
  const layout = await context.store.ensureSessionLayout(state.session.id);
  const results = await runJournaledCommandSet({
    store: context.store,
    repository: context.worktree,
    commands: [command],
    commit,
    category,
    logRoot: layout.checks,
    sequenceStart: state.eventSequence + 1,
  });
  const result = results[0];
  if (result === undefined || results.length !== 1) throw new Error("recovery command produced no result");
  return result;
}

async function loadBoundResult(
  context: RecoveryControllerOptions,
  resultPath: string,
  command: CommandSpec,
  commit: string,
): Promise<CommandResult> {
  if (resultPath.length === 0) throw new Error("pending failure has no durable command result");
  const resolved = path.resolve(resultPath);
  const relative = path.relative(context.store.runtimeRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("pending failure result is outside the recovery runtime root");
  }
  const result = validateCommandResult(JSON.parse(await readFile(resolved, "utf8")), "failureResult");
  if (result.checkId !== command.id || result.commit !== commit ||
    result.argv.length !== command.argv.length ||
    result.argv.some((argument, index) => argument !== command.argv[index])) {
    throw new Error("command result is not bound to the configured failing command and exact commit");
  }
  const recordedPath = optionalResultPath(result);
  if (recordedPath !== null && path.resolve(recordedPath) !== resolved) {
    throw new Error("command result path does not match its complete log directory");
  }
  return result;
}

async function persistConfirmationAttempt(
  context: RecoveryControllerOptions,
  failureId: string,
  result: CommandResult,
  attempt: number,
  resultPath: string,
): Promise<void> {
  let added = false;
  await context.store.update((draft) => {
    const failure = requireFailure(draft, failureId);
    const existing = failure.confirmationAttempts.find((entry) => entry.attempt === attempt);
    if (existing !== undefined) {
      if (existing.resultPath !== resultPath || existing.commit !== result.commit) {
        throw new Error("confirmation attempt changed after persistence");
      }
      return;
    }
    if (failure.confirmationAttempts.length !== attempt - 1) {
      throw new Error("confirmation attempts must be persisted in order");
    }
    failure.confirmationAttempts.push(attemptRecord(result, attempt, resultPath));
    failure.latestResultPath = resultPath;
    added = true;
  }, context.clock().toISOString());
  if (added) {
    await context.store.appendEvent({ type: "confirmation-attempted", headCommit: result.commit,
      data: { failureId, attempt, classification: result.classification,
        signature: result.signature, resultPath } });
  }
}

async function clearFlakyObservation(context: RecoveryControllerOptions, failureId: string): Promise<void> {
  await context.store.update((draft) => {
    requireFailure(draft, failureId);
    draft.health.pendingFailure = null;
    draft.recovery.activeFailureId = null;
    draft.cadence.deepRequired = true;
    if (!draft.cadence.deepReasons.includes("deep-retry")) draft.cadence.deepReasons.push("deep-retry");
  }, context.clock().toISOString());
}

async function classifyEvidenceFailure(
  store: StateStore,
  failureId: string,
  commit: string,
  detail: string,
  classification: "infrastructure" | "safety" = "safety",
): Promise<void> {
  await store.update((draft) => {
    const failure = requireFailure(draft, failureId);
    failure.classification = classification;
    failure.confirmed = false;
  });
  await store.appendEvent({ type: "failure-classified", headCommit: commit,
    data: { failureId, classification, confirmed: false, detail } });
}

async function exhaustRepair(
  context: RecoveryControllerOptions,
  failure: PendingFailure,
  detail: string,
): Promise<RecoveryProcessResult> {
  const head = (await context.store.readState()).repository.expectedHead;
  await rotateAgentThread(context.store, head, "repair-attempt-limit");
  return { stop: "repair-exhausted",
    detail: `${detail}; pending failure ${failure.id} is preserved for Stage 9` };
}

function configuredCommand(config: RecoveryConfig, checkId: string): CommandSpec {
  const command = [...config.checks.smoke, ...config.checks.deep]
    .find((candidate) => candidate.id === checkId);
  if (command === undefined) throw new Error(`pending failure check is not configured: ${checkId}`);
  return command;
}

function requireFailure(state: RecoveryState, failureId: string): PendingFailure {
  const failure = state.health.pendingFailure;
  if (failure === null || failure.id !== failureId || state.recovery.activeFailureId !== failureId) {
    throw new Error(`active pending failure changed: expected ${failureId}`);
  }
  return failure;
}

function attemptRecord(
  result: CommandResult,
  attempt: number,
  resultPath: string,
): FailureAttempt {
  return { attempt, commit: result.commit, classification: result.classification,
    signature: result.signature, resultPath };
}

function optionalResultPath(result: CommandResult): string | null {
  return result.stdoutPath === null ? null : path.join(path.dirname(result.stdoutPath), "result.json");
}

function requiredResultPath(result: CommandResult): string {
  const resultPath = optionalResultPath(result);
  if (resultPath === null) throw new Error("command result could not be persisted");
  return resultPath;
}


function recoveryHealthOptions(context: RecoveryControllerOptions): HealthControllerOptions {
  return { store: context.store, repository: context.worktree,
    config: context.config, now: context.clock().toISOString() };
}
async function checkpointGuard(
  repository: GitRepository, config: RecoveryConfig, expectedBase: string, worktreePath: string,
): Promise<void> {
  await assertCheckpointSafe(repository, { expectedBranch: config.branch, expectedBase,
    protectedPaths: config.protectedPaths, expectedWorktreePath: worktreePath });
}
async function countSessionCheckpoints(
  repository: GitRepository, state: RecoveryState,
): Promise<number> {
  const output = (await repository.git(["log", state.repository.branch, "--format=%B%x00"])).stdout;
  const trailer = `Recovery-Loop-Session: ${state.session.id}`;
  return output.split("\0").filter((message) => message.includes(trailer)).length;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
