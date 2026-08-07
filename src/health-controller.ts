import { createHash } from "node:crypto";
import path from "node:path";
import {
  runJournaledCommandSet,
  type CommandSetHooks,
} from "./check-runner.js";
import type { RecoveryConfig } from "./config.js";
import type {
  CommandClassification,
  CommandResult,
  CommandSpec,
  PendingFailure,
  RecoveryState,
} from "./contracts.js";
import {
  journaledCheckpoint,
  type JournaledCheckpointRequest,
} from "./git-operations.js";
import type {
  ChangeStatistics,
  CheckpointResult,
  GitRepository,
} from "./git-repository.js";
import type { StateStore } from "./state-store.js";
export const DEEP_CHECK_REASONS = {
  initialBaseline: "initial-baseline",
  checkpointCadence: "checkpoint-cadence",
  elapsedTime: "elapsed-time",
  highRiskPath: "high-risk-path",
  changedFiles: "changed-files",
  changedLines: "changed-lines",
  goalCompletion: "goal-completion",
  recoveryBoundary: "recovery-boundary",
  explicitState: "explicit-state",
  retry: "deep-retry",
} as const;
export interface DeepScheduleInput {
  now: string;
  changedPaths?: readonly string[];
  statistics?: ChangeStatistics;
  goalComplete?: boolean;
  recoveryBoundary?: boolean;
}
export interface DeepSchedule {
  due: boolean;
  reasons: string[];
}
export interface HealthControllerOptions {
  store: StateStore;
  repository: GitRepository;
  config: RecoveryConfig;
  now: string;
  commandSetHooks?: {
    smoke?: CommandSetHooks;
    deep?: CommandSetHooks;
  };
}
export interface HealthObservation {
  commit: string;
  smokeResults: CommandResult[];
  deepResults: CommandResult[] | null;
  deepReasons: string[];
  knownGoodPromoted: boolean;
  pendingFailure: PendingFailure | null;
}
export interface CheckpointHealthObservation {
  checkpoint: CheckpointResult | null;
  observation: HealthObservation | null;
}
export interface CheckpointAndCheckOptions extends HealthControllerOptions {
  checkpoint: JournaledCheckpointRequest;
  goalComplete?: boolean;
  recoveryBoundary?: boolean;
}
interface FailureSource {
  checkId: string;
  classification: Exclude<CommandClassification, "pass">;
  signature: string;
  resultPath: string;
}
interface DeepRunResult {
  results: CommandResult[];
  reasons: string[];
  promoted: boolean;
}
export function evaluateDeepSchedule(
  state: RecoveryState,
  config: RecoveryConfig,
  input: DeepScheduleInput,
): DeepSchedule {
  const now = timestamp(input.now);
  const reasons: string[] = [];
  const add = (reason: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (state.cadence.deepRequired) {
    for (const reason of state.cadence.deepReasons) add(reason);
    if (state.cadence.deepReasons.length === 0) add(DEEP_CHECK_REASONS.explicitState);
  }
  if (
    state.cadence.smokePassingCheckpointsSinceDeep >=
    config.deepPolicy.everyCheckpoints
  ) {
    add(DEEP_CHECK_REASONS.checkpointCadence);
  }
  if (
    state.health.lastDeepRunAt !== null &&
    Date.parse(now) - Date.parse(state.health.lastDeepRunAt) >=
      config.deepPolicy.maxMinutes * 60_000
  ) {
    add(DEEP_CHECK_REASONS.elapsedTime);
  }
  if (
    input.changedPaths?.some((changedPath) =>
      config.deepPolicy.triggerPaths.some((trigger) => pathMatchesTrigger(changedPath, trigger)),
    ) === true
  ) {
    add(DEEP_CHECK_REASONS.highRiskPath);
  }
  if (
    input.statistics !== undefined &&
    input.statistics.files > config.deepPolicy.changedFileThreshold
  ) {
    add(DEEP_CHECK_REASONS.changedFiles);
  }
  if (
    input.statistics !== undefined &&
    input.statistics.additions + input.statistics.deletions >
      config.deepPolicy.changedLineThreshold
  ) {
    add(DEEP_CHECK_REASONS.changedLines);
  }
  if (input.goalComplete === true && config.deepPolicy.beforeGoalComplete) {
    add(DEEP_CHECK_REASONS.goalCompletion);
  }
  if (input.recoveryBoundary === true && config.deepPolicy.afterRecovery) {
    add(DEEP_CHECK_REASONS.recoveryBoundary);
  }
  return { due: reasons.length > 0, reasons };
}
export async function checkBaseline(
  options: HealthControllerOptions,
): Promise<HealthObservation> {
  const now = timestamp(options.now);
  const state = await options.store.readState();
  if (state.repository.expectedHead !== state.repository.baselineCommit) {
    throw new Error("baseline checks require the autonomous branch to remain at its baseline");
  }
  await options.store.update((draft) => {
    draft.cadence.deepRequired = true;
    draft.cadence.deepReasons = [DEEP_CHECK_REASONS.initialBaseline];
  }, now);
  return runAfterSmoke(options, state.repository.baselineCommit, false, true);
}
export async function checkpointAndCheck(
  options: CheckpointAndCheckOptions,
): Promise<CheckpointHealthObservation> {
  await persistSchedule(options, {
    now: options.now,
    ...(options.goalComplete === undefined ? {} : { goalComplete: options.goalComplete }),
    ...(options.recoveryBoundary === undefined
      ? {}
      : { recoveryBoundary: options.recoveryBoundary }),
  });
  const checkpoint = await journaledCheckpoint(
    options.store,
    options.repository,
    options.checkpoint,
  );
  if (checkpoint === null) {
    return { checkpoint, observation: await runScheduledChecks(options) };
  }
  await persistCheckpointRisk(options, checkpoint.previousHead, checkpoint.commit, checkpoint.statistics);
  const observation = await runAfterSmoke(options, checkpoint.commit, true, false);
  return { checkpoint, observation };
}
export async function recordRecoveryBoundary(
  options: HealthControllerOptions,
): Promise<DeepSchedule> {
  return persistSchedule(options, { now: options.now, recoveryBoundary: true });
}
export async function runScheduledChecks(
  options: HealthControllerOptions,
): Promise<HealthObservation | null> {
  const state = await options.store.readState();
  if (state.phase !== "idle") {
    throw new Error(`scheduled checks require idle state, found ${state.phase}`);
  }
  const commit = await options.repository.assertBranchIdentity(options.config.branch);
  if (commit !== state.repository.expectedHead) {
    throw new Error(`actual head ${commit} does not match durable head ${state.repository.expectedHead}`);
  }
  if (state.health.pendingFailure?.discoveredAtCommit === commit) return null;
  if (state.health.lastSmokePassCommit !== commit) {
    await persistDerivedCheckpointRisk(options, commit);
    const baseline = commit === state.repository.baselineCommit;
    return runAfterSmoke(options, commit, !baseline, baseline);
  }
  const schedule = await persistSchedule(options, { now: options.now });
  if (!schedule.due) return null;
  const deep = await runDeep(options, commit);
  return observation(options.store, commit, [], deep);
}
export async function resumeInterruptedCheckSet(
  options: HealthControllerOptions,
  category: "smoke" | "deep",
): Promise<HealthObservation> {
  const state = await options.store.readState();
  const expectedPhase = category === "smoke" ? "smoke-checking" : "deep-checking";
  if (state.phase !== expectedPhase || state.operation?.kind !== "check") {
    throw new Error(`no interrupted ${category} command set is recorded`);
  }
  if (state.operation.childPid !== null && processIsAlive(state.operation.childPid)) {
    throw new Error(
      `recorded command PID ${state.operation.childPid} is still alive; refusing to run a duplicate command`,
    );
  }
  const commit = state.operation.baseCommit;
  if (commit !== state.repository.expectedHead) {
    throw new Error(`interrupted ${category} set is not bound to the durable head`);
  }
  if (category === "deep") {
    const deep = await runDeep(options, commit);
    return observation(options.store, commit, [], deep);
  }
  await persistDerivedCheckpointRisk(options, commit);
  const baseline = commit === state.repository.baselineCommit;
  return runAfterSmoke(
    options,
    commit,
    !baseline && state.health.lastSmokePassCommit !== commit,
    baseline,
  );
}
async function runAfterSmoke(
  options: HealthControllerOptions,
  commit: string,
  countsForCadence: boolean,
  baselineRequiresDeep: boolean,
): Promise<HealthObservation> {
  const smokeResults = await runSmoke(options, commit, countsForCadence);
  const smokePassed = commandSetPassed(smokeResults, options.config.checks.smoke, commit);
  const state = await options.store.readState();
  if (!smokePassed && !baselineRequiresDeep) {
    return observation(options.store, commit, smokeResults, null);
  }
  if (!baselineRequiresDeep && !state.cadence.deepRequired) {
    return observation(options.store, commit, smokeResults, null);
  }
  const deep = await runDeep(options, commit);
  return observation(options.store, commit, smokeResults, deep);
}
async function runSmoke(
  options: HealthControllerOptions,
  commit: string,
  countsForCadence: boolean,
): Promise<CommandResult[]> {
  const now = timestamp(options.now);
  const results = await runCommandSet(options, "smoke", commit, options.config.checks.smoke);
  const passed = commandSetPassed(results, options.config.checks.smoke, commit);
  const failure = firstFailure(results);
  await options.store.update((draft) => {
    if (passed) {
      if (draft.health.lastSmokePassCommit !== commit) {
        draft.health.lastSmokePassCommit = commit;
        if (countsForCadence) draft.cadence.smokePassingCheckpointsSinceDeep += 1;
      }
      applySchedule(draft, evaluateDeepSchedule(draft, options.config, { now }));
      return;
    }
    if (failure !== null) setPendingFailure(draft, commit, failure);
  }, now);
  if (failure !== null) await appendFailureEvent(options.store, commit, failure);
  return results;
}
async function runDeep(
  options: HealthControllerOptions,
  commit: string,
): Promise<DeepRunResult> {
  const now = timestamp(options.now);
  const before = await options.store.readState();
  const reasons = before.cadence.deepReasons.slice();
  const results = await runCommandSet(options, "deep", commit, options.config.checks.deep);
  const commandsPassed = commandSetPassed(results, options.config.checks.deep, commit);
  let boundaryFailure: FailureSource | null = null;
  if (commandsPassed) {
    try {
      const actual = await options.repository.assertBranchIdentity(options.config.branch);
      if (actual !== commit) {
        boundaryFailure = syntheticFailure("exact-head", `expected ${commit}, found ${actual}`);
      } else if ((await options.repository.changedPaths(true)).length > 0) {
        boundaryFailure = syntheticFailure("worktree-cleanliness", "worktree is not clean");
      }
    } catch (error) {
      boundaryFailure = syntheticFailure(
        "exact-head",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const commandFailure = firstFailure(results);
  const missingSmokeFailure =
    commandsPassed &&
    boundaryFailure === null &&
    before.health.lastSmokePassCommit !== commit &&
    before.health.pendingFailure === null
      ? syntheticFailure("smoke-observation", "no complete smoke pass is recorded at this commit")
      : null;
  const failure = commandFailure ?? boundaryFailure ?? missingSmokeFailure;
  let promoted = false;
  await options.store.update((draft) => {
    draft.health.lastDeepRunCommit = commit;
    draft.health.lastDeepRunAt = now;
    const fullPass =
      commandsPassed &&
      boundaryFailure === null &&
      draft.health.lastSmokePassCommit === commit;
    if (fullPass) {
      promoted = draft.health.knownGoodCommit !== commit;
      draft.health.knownGoodCommit = commit;
      draft.health.pendingFailure = null;
      draft.recovery.activeFailureId = null;
      draft.cadence.smokePassingCheckpointsSinceDeep = 0;
      draft.cadence.deepRequired = false;
      draft.cadence.deepReasons = [];
      return;
    }
    if (failure !== null && draft.health.pendingFailure === null) {
      setPendingFailure(draft, commit, failure);
    }
    draft.cadence.deepRequired = true;
    draft.cadence.deepReasons = unique([...draft.cadence.deepReasons, DEEP_CHECK_REASONS.retry]);
  }, now);
  if (promoted) {
    await options.store.appendEvent({
      type: "known-good-advanced",
      headCommit: commit,
      data: { reasons },
    });
  } else if (failure !== null) {
    await appendFailureEvent(options.store, commit, failure);
  }
  return { results, reasons, promoted };
}
async function runCommandSet(
  options: HealthControllerOptions,
  category: "smoke" | "deep",
  commit: string,
  commands: readonly CommandSpec[],
): Promise<CommandResult[]> {
  const state = await options.store.readState();
  const layout = await options.store.ensureSessionLayout(state.session.id);
  const hooks = options.commandSetHooks?.[category];
  return runJournaledCommandSet({
    store: options.store,
    repository: options.repository,
    commands,
    commit,
    category,
    logRoot: layout.checks,
    sequenceStart: state.eventSequence + 1,
    ...(hooks === undefined ? {} : { hooks }),
  });
}
async function persistCheckpointRisk(
  options: HealthControllerOptions,
  base: string,
  commit: string,
  statistics: ChangeStatistics,
): Promise<DeepSchedule> {
  return persistSchedule(options, {
    now: options.now,
    changedPaths: await options.repository.changedPathsBetween(base, commit),
    statistics,
  });
}
async function persistDerivedCheckpointRisk(
  options: HealthControllerOptions,
  commit: string,
): Promise<void> {
  const state = await options.store.readState();
  if (
    commit === state.repository.baselineCommit ||
    state.health.lastSmokePassCommit === commit
  ) {
    return;
  }
  const parent = await options.repository.firstParent(commit);
  if (parent === null) return;
  await persistCheckpointRisk(
    options,
    parent,
    commit,
    await options.repository.changeStatistics(parent, commit),
  );
}
async function persistSchedule(
  options: HealthControllerOptions,
  input: DeepScheduleInput,
): Promise<DeepSchedule> {
  const now = timestamp(input.now);
  let schedule: DeepSchedule = { due: false, reasons: [] };
  await options.store.update((draft) => {
    schedule = evaluateDeepSchedule(draft, options.config, { ...input, now });
    applySchedule(draft, schedule);
  }, now);
  return schedule;
}
function applySchedule(state: RecoveryState, schedule: DeepSchedule): void {
  state.cadence.deepRequired = schedule.due;
  state.cadence.deepReasons = schedule.reasons;
}
async function observation(
  store: StateStore,
  commit: string,
  smokeResults: CommandResult[],
  deep: DeepRunResult | null,
): Promise<HealthObservation> {
  const state = await store.readState();
  return {
    commit,
    smokeResults,
    deepResults: deep?.results ?? null,
    deepReasons: deep?.reasons ?? state.cadence.deepReasons.slice(),
    knownGoodPromoted: deep?.promoted ?? false,
    pendingFailure: state.health.pendingFailure,
  };
}
function commandSetPassed(
  results: readonly CommandResult[],
  commands: readonly CommandSpec[],
  commit: string,
): boolean {
  return (
    results.length === commands.length &&
    results.every(
      (result, index) =>
        result.checkId === commands[index]?.id &&
        result.commit === commit &&
        result.classification === "pass" &&
        !result.worktreeChanged,
    )
  );
}
function firstFailure(results: readonly CommandResult[]): FailureSource | null {
  const result = results.find(
    (candidate) => candidate.classification !== "pass" || candidate.worktreeChanged,
  );
  if (result === undefined || result.classification === "pass") return null;
  const resultFile =
    result.stdoutPath === null ? "" : path.join(path.dirname(result.stdoutPath), "result.json");
  return {
    checkId: result.checkId,
    classification: result.classification,
    signature: result.signature,
    resultPath: resultFile,
  };
}
function syntheticFailure(checkId: string, detail: string): FailureSource {
  return {
    checkId,
    classification: "safety",
    signature: createHash("sha256").update(`${checkId}\0${detail}`).digest("hex"),
    resultPath: "",
  };
}
function setPendingFailure(
  state: RecoveryState,
  commit: string,
  failure: FailureSource,
): void {
  const existing = state.health.pendingFailure;
  const sameObservation =
    existing?.discoveredAtCommit === commit &&
    existing.checkId === failure.checkId &&
    existing.signature === failure.signature;
  const pending: PendingFailure = {
    id: sameObservation ? existing.id : `failure-${state.eventSequence + 1}`,
    checkId: failure.checkId,
    classification: failure.classification,
    signature: failure.signature,
    discoveredAtCommit: commit,
    confirmed: false,
    knownGoodCommit: state.health.knownGoodCommit,
    firstBadCommit: null,
    regressionWindow:
      state.health.knownGoodCommit === null || state.health.knownGoodCommit === commit
        ? null
        : [state.health.knownGoodCommit, commit],
    repairAttempts: sameObservation ? existing.repairAttempts : 0,
    recoveryCycles: sameObservation ? existing.recoveryCycles : 0,
    latestResultPath: failure.resultPath,
  };
  state.health.pendingFailure = pending;
  state.recovery.activeFailureId = pending.id;
}
async function appendFailureEvent(
  store: StateStore,
  commit: string,
  failure: FailureSource,
): Promise<void> {
  await store.appendEvent({
    type: "failure-observed",
    headCommit: commit,
    data: {
      checkId: failure.checkId,
      classification: failure.classification,
      signature: failure.signature,
      confirmed: false,
    },
  });
}
function pathMatchesTrigger(changedPath: string, trigger: string): boolean {
  const changed = changedPath.replaceAll("\\", "/");
  if (trigger.endsWith("/")) return changed.startsWith(trigger);
  return changed === trigger || changed.startsWith(`${trigger}/`);
}
function timestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`invalid scheduling time: ${value}`);
  return new Date(milliseconds).toISOString();
}
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
