import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runJournaledCommandSet } from "./check-runner.js";
import type { RecoveryConfig } from "./config.js";
import {
  validateCommandResult,
  type CommandResult,
  type CommandSpec,
  type FailureAttempt,
  type LocalizationObservation,
  type LocalizationRole,
  type LocalizationVerdict,
  type PendingFailure,
  type PendingOperation,
  type RecoveryState,
} from "./contracts.js";
import type { GitRepository } from "./git-repository.js";
import type { StateStore } from "./state-store.js";

export type Stage9StopReason =
  | "repair-exhausted"
  | "recovery-flaky"
  | "recovery-infrastructure"
  | "recovery-safety";
export interface Stage9Result { stop: Stage9StopReason | null; detail: string | null }
export interface Stage9Hooks {
  afterDiagnosticWorktree?: (commit: string) => void | Promise<void>;
  afterHistoricalCommand?: (result: CommandResult) => void | Promise<void>;
  afterRevertMutation?: () => void | Promise<void>;
  afterRescueVerified?: () => void | Promise<void>;
  afterReset?: () => void | Promise<void>;
  afterRollbackState?: () => void | Promise<void>;
  afterRecoverySmokeCommand?: (result: CommandResult, index: number) => void | Promise<void>;
  afterRecoveryDeepCommand?: (result: CommandResult, index: number) => void | Promise<void>;
}
export interface Stage9Context {
  operator: GitRepository;
  worktree: GitRepository;
  store: StateStore;
  config: RecoveryConfig;
  clock: () => Date;
  hooks?: Stage9Hooks;
}
export function stage9Context(
  context: Omit<Stage9Context, "hooks"> & { stage9Hooks?: Stage9Hooks },
): Stage9Context {
  return {
    operator: context.operator,
    worktree: context.worktree,
    store: context.store,
    config: context.config,
    clock: context.clock,
    ...(context.stage9Hooks === undefined ? {} : { hooks: context.stage9Hooks }),
  };
}

export async function ensureLocalizedFailure(
  context: Stage9Context,
  requested: PendingFailure,
): Promise<Stage9Result> {
  let failure = requireFailure(await context.store.readState(), requested.id);
  if (failure.localization?.status === "localized" || failure.localization?.status === "window") {
    return { stop: null, detail: null };
  }
  if (failure.localization?.status === "anchor-failed") {
    return { stop: "recovery-infrastructure", detail: failure.localization.reason };
  }
  if (failure.localization?.status === "aborted") {
    return stoppedLocalization(failure.localization.reason);
  }
  const knownGood = failure.knownGoodCommit;
  if (knownGood === null) return { stop: null, detail: null };
  const state = await context.store.readState();
  const head = state.repository.expectedHead;
  if (!(await context.worktree.isAncestor(knownGood, head))) {
    return abortLocalization(
      context,
      failure.id,
      "safety: known-good anchor is not an ancestor of the failing head",
      "recovery-safety",
    );
  }
  const chain = await context.worktree.firstParentChain(knownGood, head);
  const nonlinear = await context.worktree.hasMergeOnFirstParent(knownGood, head);
  if (failure.localization === null) {
    await context.store.update((draft) => {
      const current = requireFailure(draft, failure.id);
      current.firstBadCommit = null;
      current.regressionWindow = [knownGood, head];
      current.localization = {
        headCommit: head,
        lowerCommit: knownGood,
        upperCommit: head,
        status: "running",
        reason: null,
        nonlinear,
        environmentAttempts: 0,
        observations: [],
      };
    }, context.clock().toISOString());
    await context.store.appendEvent({
      type: "localization-started",
      headCommit: head,
      data: { failureId: failure.id, knownGoodCommit: knownGood, commits: chain.length - 1 },
    });
  } else if (
    failure.localization.headCommit !== head ||
    failure.localization.lowerCommit !== knownGood &&
      !(await context.worktree.isAncestor(failure.localization.lowerCommit, head))
  ) {
    return abortLocalization(
      context,
      failure.id,
      "safety: localization history no longer matches the durable branch",
      "recovery-safety",
    );
  }

  const anchor = await observeCandidate(context, failure.id, "anchor", knownGood, "pass");
  if (anchor === "fail") {
    await context.store.update((draft) => {
      const localization = requireLocalization(draft, failure.id);
      localization.status = "anchor-failed";
      localization.reason = context.config.prepare === null
        ? "known-good anchor now fails the product command; environment drift or stale health cannot be repaired without a configured prepare command"
        : "known-good anchor still fails after historical prepare; environment drift, nondeterminism, or stale health invalidated the rollback anchor";
    }, context.clock().toISOString());
    const current = requireFailure(await context.store.readState(), failure.id);
    await context.store.appendEvent({
      type: "localization-aborted",
      headCommit: head,
      data: { failureId: failure.id, reason: "anchor-failed", regressionWindow: current.regressionWindow },
    });
    return { stop: "recovery-infrastructure", detail: current.localization?.reason ?? "known-good anchor failed" };
  }
  if (anchor !== "pass") return abortForVerdict(context, failure.id, head, "anchor", anchor);

  const headVerdict = await observeCandidate(context, failure.id, "head", head, "fail");
  if (headVerdict !== "fail") {
    const verdict = headVerdict === "pass" ? "flaky" : headVerdict;
    return abortForVerdict(context, failure.id, head, "head", verdict);
  }
  if (chain.length < 2) {
    return abortLocalization(
      context,
      failure.id,
      "infrastructure: the known-good anchor and failing head resolve to the same commit",
      "recovery-infrastructure",
    );
  }
  if (chain.length - 1 > context.config.limits.maxLocalizationCommits) {
    await finishWindow(context, failure.id, knownGood, head, "localization range exceeds configured maximum");
    return { stop: null, detail: null };
  }
  const command = configuredCommand(context.config, failure.checkId);
  if (chain.length > 2 && command.bisectable !== true) {
    await finishWindow(context, failure.id, knownGood, head, "failing command is not configured as bisectable");
    return { stop: null, detail: null };
  }

  failure = requireFailure(await context.store.readState(), failure.id);
  let lower = failure.localization?.lowerCommit ?? knownGood;
  let upper = failure.localization?.upperCommit ?? head;
  let lowerIndex = chain.indexOf(lower);
  let upperIndex = chain.indexOf(upper);
  if (lowerIndex < 0 || upperIndex < 0 || lowerIndex >= upperIndex) {
    return abortLocalization(
      context,
      failure.id,
      "safety: persisted localization bounds are not a valid first-parent window",
      "recovery-safety",
    );
  }
  while (upperIndex - lowerIndex > 1) {
    const midpointIndex = Math.floor((lowerIndex + upperIndex) / 2);
    const midpoint = chain[midpointIndex];
    if (midpoint === undefined) throw new Error("localization midpoint is missing");
    const verdict = await observeCandidate(context, failure.id, "midpoint", midpoint, null);
    if (verdict === "pass") {
      lower = midpoint;
      lowerIndex = midpointIndex;
    } else if (verdict === "fail") {
      upper = midpoint;
      upperIndex = midpointIndex;
    } else {
      await context.store.update((draft) => {
        const localization = requireLocalization(draft, failure.id);
        localization.lowerCommit = lower;
        localization.upperCommit = upper;
        const current = requireFailure(draft, failure.id);
        current.regressionWindow = [lower, upper];
      }, context.clock().toISOString());
      return abortForVerdict(context, failure.id, head, `midpoint ${midpoint}`, verdict);
    }
    await context.store.update((draft) => {
      const localization = requireLocalization(draft, failure.id);
      localization.lowerCommit = lower;
      localization.upperCommit = upper;
      requireFailure(draft, failure.id).regressionWindow = [lower, upper];
    }, context.clock().toISOString());
  }
  if (nonlinear) {
    await finishWindow(context, failure.id, lower, upper, "merge or nonlinear first-parent history prevents a unique first-bad claim");
    return { stop: null, detail: null };
  }
  await context.store.update((draft) => {
    const current = requireFailure(draft, failure.id);
    const localization = requireLocalization(draft, failure.id);
    localization.lowerCommit = lower;
    localization.upperCommit = upper;
    localization.status = "localized";
    localization.reason = null;
    current.firstBadCommit = upper;
    current.regressionWindow = [lower, upper];
  }, context.clock().toISOString());
  await context.store.appendEvent({
    type: "regression-localized",
    headCommit: head,
    data: { failureId: failure.id, firstBadCommit: upper, regressionWindow: [lower, upper] },
  });
  return { stop: null, detail: null };
}

export async function localizedFirstBadDiff(
  context: Stage9Context,
  failure: PendingFailure,
): Promise<string | null> {
  if (failure.firstBadCommit === null) return null;
  const diff = await context.worktree.commitDiff(failure.firstBadCommit);
  const maximum = 24 * 1024;
  return diff.length <= maximum ? diff : `${diff.slice(0, maximum)}\n...[diff truncated]`;
}

async function observeCandidate(
  context: Stage9Context,
  failureId: string,
  role: LocalizationRole,
  commit: string,
  expectation: "pass" | "fail" | null,
): Promise<LocalizationVerdict> {
  await ensureObservation(context, failureId, role, commit);
  let observation = requireObservation(await context.store.readState(), failureId, role, commit);
  if (observation.verdict !== "pending") return observation.verdict;
  const diagnostic = await prepareDiagnostic(context, commit);
  if (context.config.prepare !== null) {
    const prepare: CommandSpec = {
      id: `prepare-${configuredCommand(context.config, requireFailure(await context.store.readState(), failureId).checkId).id}`,
      argv: context.config.prepare.argv,
      timeoutSeconds: context.config.prepare.timeoutSeconds,
    };
    const prepared = await runHistoricalCommand(context, diagnostic, prepare, commit, "prepare");
    await persistPrepareAttempt(context, failureId, role, commit, prepared);
    if (prepared.classification !== "pass") {
      const verdict = prepared.classification === "safety" ? "safety" : "infrastructure";
      await persistVerdict(context, failureId, role, commit, verdict);
      return verdict;
    }
  }
  observation = requireObservation(await context.store.readState(), failureId, role, commit);
  const command = configuredCommand(
    context.config,
    requireFailure(await context.store.readState(), failureId).checkId,
  );
  const attempts = await Promise.all(observation.attempts.map((attempt) =>
    loadHistoricalResult(context, attempt.resultPath, command, commit)));
  if (attempts.length === 0) {
    const first = await runHistoricalCommand(context, diagnostic, command, commit, "diagnostic");
    await persistDiagnosticAttempt(context, failureId, role, commit, first, 1);
    attempts.push(first);
  }
  const firstBoundary = nonProductVerdict(attempts);
  if (firstBoundary !== null) {
    await persistVerdict(context, failureId, role, commit, firstBoundary);
    return firstBoundary;
  }
  if (attempts[0]?.classification === "pass" && expectation !== "fail") {
    await persistVerdict(context, failureId, role, commit, "pass");
    return "pass";
  }
  while (attempts.length < 3) {
    const consensus = productConsensus(attempts);
    if (consensus !== null) {
      await persistVerdict(context, failureId, role, commit, consensus);
      return consensus;
    }
    const next = await runHistoricalCommand(context, diagnostic, command, commit, "diagnostic");
    await persistDiagnosticAttempt(context, failureId, role, commit, next, attempts.length + 1);
    attempts.push(next);
    const boundary = nonProductVerdict([next]);
    if (boundary !== null) {
      await persistVerdict(context, failureId, role, commit, boundary);
      return boundary;
    }
  }
  const verdict = productConsensus(attempts) ?? "flaky";
  await persistVerdict(context, failureId, role, commit, verdict);
  return verdict;
}

async function prepareDiagnostic(context: Stage9Context, commit: string): Promise<GitRepository> {
  const state = await context.store.readState();
  const operation: PendingOperation = {
    id: `op-${randomUUID()}`,
    kind: "workspace",
    unitId: "diagnostic-worktree",
    baseCommit: state.repository.expectedHead,
    targetCommit: commit,
    observedHead: commit,
    rescueRef: null,
    childPid: null,
    summary: `prepare diagnostic worktree at ${commit}`,
    checkpointKind: null,
    startedAt: context.clock().toISOString(),
  };
  await context.store.persistIntent("diagnosing", operation);
  const diagnosticPath = path.join(context.store.runtimeRoot, "diagnostic-worktree");
  if (pathsEqual(diagnosticPath, state.repository.worktreePath)) {
    throw new Error("diagnostic worktree path overlaps the autonomous worktree");
  }
  const diagnostic = await context.operator.prepareDiagnosticWorktree(
    diagnosticPath,
    commit,
    context.store.runtimeRoot,
  );
  await context.hooks?.afterDiagnosticWorktree?.(commit);
  await context.store.finishOperation(state.repository.expectedHead);
  return diagnostic;
}

async function runHistoricalCommand(
  context: Stage9Context,
  diagnostic: GitRepository,
  command: CommandSpec,
  commit: string,
  category: "diagnostic" | "prepare",
): Promise<CommandResult> {
  const state = await context.store.readState();
  const layout = await context.store.ensureSessionLayout(state.session.id);
  const results = await runJournaledCommandSet({
    store: context.store,
    repository: diagnostic,
    commands: [command],
    commit,
    activeHead: state.repository.expectedHead,
    category,
    logRoot: layout.diagnoses,
    sequenceStart: state.eventSequence + 1,
    ...(context.hooks?.afterHistoricalCommand === undefined
      ? {}
      : { hooks: { afterCommand: context.hooks.afterHistoricalCommand } }),
  });
  const result = results[0];
  if (result === undefined || results.length !== 1) throw new Error("historical command produced no result");
  return result;
}

async function ensureObservation(
  context: Stage9Context,
  failureId: string,
  role: LocalizationRole,
  commit: string,
): Promise<void> {
  await context.store.update((draft) => {
    const localization = requireLocalization(draft, failureId);
    if (localization.observations.some((entry) => entry.role === role && entry.commit === commit)) return;
    localization.observations.push({
      role,
      commit,
      verdict: "pending",
      prepareAttempt: null,
      attempts: [],
    });
  }, context.clock().toISOString());
}

async function persistPrepareAttempt(
  context: Stage9Context,
  failureId: string,
  role: LocalizationRole,
  commit: string,
  result: CommandResult,
): Promise<void> {
  const resultPath = requiredResultPath(result);
  await context.store.update((draft) => {
    const observation = requireObservation(draft, failureId, role, commit);
    observation.prepareAttempt ??= attemptRecord(result, 1, resultPath);
    const localization = requireLocalization(draft, failureId);
    localization.environmentAttempts = Math.max(localization.environmentAttempts, 1);
  }, context.clock().toISOString());
}

async function persistDiagnosticAttempt(
  context: Stage9Context,
  failureId: string,
  role: LocalizationRole,
  commit: string,
  result: CommandResult,
  attempt: number,
): Promise<void> {
  const resultPath = requiredResultPath(result);
  await context.store.update((draft) => {
    const observation = requireObservation(draft, failureId, role, commit);
    const existing = observation.attempts.find((entry) => entry.attempt === attempt);
    if (existing !== undefined) {
      if (existing.resultPath !== resultPath) throw new Error("historical attempt changed after persistence");
      return;
    }
    if (observation.attempts.length !== attempt - 1) {
      throw new Error("historical attempts must be persisted in order");
    }
    observation.attempts.push(attemptRecord(result, attempt, resultPath));
  }, context.clock().toISOString());
}

async function persistVerdict(
  context: Stage9Context,
  failureId: string,
  role: LocalizationRole,
  commit: string,
  verdict: LocalizationVerdict,
): Promise<void> {
  await context.store.update((draft) => {
    requireObservation(draft, failureId, role, commit).verdict = verdict;
  }, context.clock().toISOString());
}

async function finishWindow(
  context: Stage9Context,
  failureId: string,
  lower: string,
  upper: string,
  reason: string,
): Promise<void> {
  await context.store.update((draft) => {
    const current = requireFailure(draft, failureId);
    const localization = requireLocalization(draft, failureId);
    localization.lowerCommit = lower;
    localization.upperCommit = upper;
    localization.status = "window";
    localization.reason = reason;
    current.firstBadCommit = null;
    current.regressionWindow = [lower, upper];
  }, context.clock().toISOString());
  await context.store.appendEvent({
    type: "localization-aborted",
    headCommit: upper,
    data: { failureId, reason, regressionWindow: [lower, upper] },
  });
}

async function abortForVerdict(
  context: Stage9Context,
  failureId: string,
  head: string,
  location: string,
  verdict: LocalizationVerdict,
): Promise<Stage9Result> {
  const classification = verdict === "safety" ? "safety"
    : verdict === "infrastructure" ? "infrastructure" : "flaky";
  const stop = classification === "safety" ? "recovery-safety"
    : classification === "infrastructure" ? "recovery-infrastructure" : "recovery-flaky";
  return abortLocalization(
    context,
    failureId,
    `${classification}: ${location} produced ${verdict} evidence`,
    stop,
    head,
  );
}

async function abortLocalization(
  context: Stage9Context,
  failureId: string,
  reason: string,
  stop: Exclude<Stage9StopReason, "repair-exhausted">,
  head?: string,
): Promise<Stage9Result> {
  let window: [string, string] | null = null;
  await context.store.update((draft) => {
    const current = requireFailure(draft, failureId);
    if (current.localization !== null) {
      current.localization.status = "aborted";
      current.localization.reason = reason;
      window = [current.localization.lowerCommit, current.localization.upperCommit];
      current.regressionWindow = window;
      current.firstBadCommit = null;
    }
  }, context.clock().toISOString());
  const state = await context.store.readState();
  await context.store.appendEvent({
    type: "localization-aborted",
    headCommit: head ?? state.repository.expectedHead,
    data: { failureId, reason, regressionWindow: window },
  });
  return { stop, detail: reason };
}

function stoppedLocalization(reason: string | null): Stage9Result {
  const detail = reason ?? "localization previously aborted on uncertain evidence";
  if (detail.startsWith("safety:")) return { stop: "recovery-safety", detail };
  if (detail.startsWith("infrastructure:")) return { stop: "recovery-infrastructure", detail };
  return { stop: "recovery-flaky", detail };
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

function requireLocalization(state: RecoveryState, failureId: string) {
  const localization = requireFailure(state, failureId).localization;
  if (localization === null) throw new Error("pending failure has no localization state");
  return localization;
}

function requireObservation(
  state: RecoveryState,
  failureId: string,
  role: LocalizationRole,
  commit: string,
): LocalizationObservation {
  const observation = requireLocalization(state, failureId).observations
    .find((entry) => entry.role === role && entry.commit === commit);
  if (observation === undefined) throw new Error(`missing ${role} observation at ${commit}`);
  return observation;
}

function nonProductVerdict(results: readonly CommandResult[]): LocalizationVerdict | null {
  const boundary = results.find((result) =>
    result.classification === "infrastructure" || result.classification === "safety" ||
    result.classification === "flaky");
  return boundary === undefined ? null : boundaryVerdict(boundary.classification);
}

function boundaryVerdict(classification: CommandResult["classification"]): LocalizationVerdict {
  if (classification === "safety") return "safety";
  if (classification === "infrastructure") return "infrastructure";
  return "flaky";
}

function productConsensus(results: readonly CommandResult[]): "pass" | "fail" | "flaky" | null {
  const passes = results.filter((result) => result.classification === "pass").length;
  const failures = results.filter((result) => result.classification === "product").length;
  if (passes >= 2) return failures > 0 ? "flaky" : "pass";
  const groups = new Map<string, number>();
  for (const result of results) {
    if (result.classification !== "product") continue;
    const count = (groups.get(result.signature) ?? 0) + 1;
    if (count >= 2) return "fail";
    groups.set(result.signature, count);
  }
  return null;
}

function attemptRecord(result: CommandResult, attempt: number, resultPath: string): FailureAttempt {
  return {
    attempt,
    commit: result.commit,
    classification: result.classification,
    signature: result.signature,
    resultPath,
  };
}

async function loadHistoricalResult(
  context: Stage9Context,
  resultPath: string,
  command: CommandSpec,
  commit: string,
): Promise<CommandResult> {
  const resolved = path.resolve(resultPath);
  const relative = path.relative(context.store.runtimeRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("historical result is outside the recovery runtime root");
  }
  const result = validateCommandResult(JSON.parse(await readFile(resolved, "utf8")), "historicalResult");
  if (result.commit !== commit || result.checkId !== command.id ||
    result.argv.length !== command.argv.length ||
    result.argv.some((argument, index) => argument !== command.argv[index])) {
    throw new Error("historical result is not bound to the exact command and commit");
  }
  return result;
}

function requiredResultPath(result: CommandResult): string {
  if (result.stdoutPath === null) throw new Error("historical command result could not be persisted");
  return path.join(path.dirname(result.stdoutPath), "result.json");
}

function pathsEqual(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
