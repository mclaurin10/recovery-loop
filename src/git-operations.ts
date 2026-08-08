import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import type { CheckpointKind, PendingOperation, RecoveryState } from "./contracts.js";
import { createInitialState } from "./contracts.js";
import {
  CanonicalityError,
  GitRepository,
  type CheckpointRequest,
  type CheckpointResult,
  type RevertResult,
  type RollbackResult,
} from "./git-repository.js";
import { isRecordedProcessAlive, type StateStore } from "./state-store.js";
export interface OperationHooks {
  afterGitMutation?: (kind: PendingOperation["kind"]) => void | Promise<void>;
  afterRescueVerified?: () => void | Promise<void>;
  afterReset?: () => void | Promise<void>;
}
export interface JournaledCheckpointRequest extends CheckpointRequest {
  hooks?: OperationHooks;
}
export interface StartupReconcileOptions {
  guard?: (
    repository: GitRepository,
    expectedHead?: string,
    committedBase?: string,
  ) => Promise<void>;
  hooks?: OperationHooks;
}
export type StartupAction =
  | "ready"
  | "workspace-recreated"
  | "checkpoint-finished"
  | "checkpoint-adopted"
  | "interrupted-work-checkpointed"
  | "rerun-smoke"
  | "rerun-deep"
  | "restart-diagnosis"
  | "resume-agent"
  | "resume-repair"
  | "rollback-finished"
  | "revert-finished"
  | "revert-conflicted"
  | "stopped"
  | "dirty-worktree";
export interface StartupReconcileResult {
  action: StartupAction;
  state: RecoveryState;
  checkpoint: CheckpointResult | null;
}
export async function initializeJournaledWorkspace(options: {
  operatorRepository: GitRepository;
  store: StateStore;
  branch: string;
  worktreePath: string;
  baseline?: string;
  sessionId: string;
  hooks?: OperationHooks & {
    afterBranchCreated?: () => void | Promise<void>;
    afterWorktreeCreated?: () => void | Promise<void>;
  };
}): Promise<{ state: RecoveryState; worktree: GitRepository }> {
  const baselineCommit = await options.operatorRepository.preflightAutonomousWorktree({
    ...(options.baseline === undefined ? {} : { baseline: options.baseline }),
    branch: options.branch,
    worktreePath: options.worktreePath,
  });
  const startedAt = new Date().toISOString();
  const state = createInitialState({
    gitCommonDir: options.operatorRepository.gitCommonDir,
    baselineCommit,
    branch: options.branch,
    worktreePath: options.worktreePath,
    sessionId: options.sessionId,
    now: startedAt,
  });
  state.phase = "checkpointing";
  state.operation = operation({
    kind: "workspace",
    baseCommit: baselineCommit,
    targetCommit: baselineCommit,
    observedHead: baselineCommit,
    startedAt,
  });
  await options.store.initialize(state);
  await options.store.hooks.afterIntentPersisted?.(state);
  const result = await options.operatorRepository.createAutonomousWorktree({
    baseline: baselineCommit,
    branch: options.branch,
    worktreePath: options.worktreePath,
    hooks: {
      ...(options.hooks?.afterBranchCreated === undefined
        ? {}
        : { afterBranchCreated: options.hooks.afterBranchCreated }),
      ...(options.hooks?.afterWorktreeCreated === undefined
        ? {}
        : { afterWorktreeCreated: options.hooks.afterWorktreeCreated }),
    },
  });
  await options.hooks?.afterGitMutation?.("workspace");
  const finished = await options.store.finishOperation(baselineCommit);
  return { state: finished, worktree: result.worktree };
}
export async function journaledCheckpoint(
  store: StateStore,
  repository: GitRepository,
  request: JournaledCheckpointRequest,
): Promise<CheckpointResult | null> {
  const state = await store.readState();
  if (state.repository.expectedHead !== request.expectedBase) {
    throw new CanonicalityError(
      state.repository.expectedHead,
      request.expectedBase,
      "checkpoint request disagrees with durable expected head",
    );
  }
  const observedHead = await repository.assertBranchIdentity(request.branch);
  if (
    observedHead !== request.expectedBase &&
    !(await repository.isAncestor(request.expectedBase, observedHead))
  ) {
    await stopForCanonicality(store, request.expectedBase, observedHead);
  }
  const rescueRef =
    observedHead === request.expectedBase
      ? null
      : (request.normalizationRescueRef ?? normalizationRef(request.sessionId, request.unitId));
  const intent = operation({
    kind: "checkpoint",
    unitId: request.unitId,
    baseCommit: request.expectedBase,
    observedHead,
    rescueRef,
    summary: request.summary,
    checkpointKind: request.kind,
  });
  await store.persistIntent("checkpointing", intent);
  const checkpoint = await repository.checkpoint({
    ...request,
    ...(rescueRef === null ? {} : { normalizationRescueRef: rescueRef }),
    ...(request.hooks?.afterRescueVerified === undefined
      ? {}
      : { afterNormalizationRescueVerified: request.hooks.afterRescueVerified }),
  });
  await request.hooks?.afterGitMutation?.("checkpoint");
  const head = checkpoint?.commit ?? request.expectedBase;
  await store.finishOperation(head);
  if (checkpoint !== null) {
    await store.appendEvent({
      type: "checkpoint-created",
      headCommit: checkpoint.commit,
      data: {
        unitId: request.unitId,
        kind: request.kind,
        normalizedAgentHead: checkpoint.normalizedAgentHead,
        rescueRef: checkpoint.rescueRef,
      },
    });
  }
  return checkpoint;
}
export async function journaledCleanRevert(
  store: StateStore,
  repository: GitRepository,
  options: {
    branch: string;
    expectedHead: string;
    targetCommit: string;
    sessionId: string;
    unitId: string;
    hooks?: OperationHooks;
  },
): Promise<RevertResult | null> {
  const intent = operation({
    kind: "revert",
    unitId: options.unitId,
    baseCommit: options.expectedHead,
    targetCommit: options.targetCommit,
    observedHead: options.expectedHead,
    summary: `revert ${options.targetCommit.slice(0, 12)}`,
    checkpointKind: "revert",
  });
  await store.persistIntent("rolling-back", intent);
  const result = await repository.cleanRevert(options);
  await store.update((draft) => {
    if (draft.operation?.id !== intent.id || draft.operation.kind !== "revert") {
      throw new Error("revert operation changed while recording its Git outcome");
    }
    draft.operation.observedHead = result?.commit ?? options.expectedHead;
    if (result === null) draft.operation.summary = "revert-conflicted";
  });
  await options.hooks?.afterGitMutation?.("revert");
  await finishRevert(store, result, intent);
  await appendRevertEventOnce(store, intent, result?.commit ?? options.expectedHead, result !== null);
  return result;
}
export async function journaledHardRollback(
  store: StateStore,
  repository: GitRepository,
  options: {
    branch: string;
    expectedHead: string;
    targetCommit: string;
    rescueRef: string;
    hooks?: OperationHooks;
  },
): Promise<RollbackResult> {
  await store.persistIntent(
    "rolling-back",
    operation({
      kind: "reset",
      baseCommit: options.expectedHead,
      targetCommit: options.targetCommit,
      observedHead: options.expectedHead,
      rescueRef: options.rescueRef,
    }),
  );
  const result = await repository.hardRollback({
    branch: options.branch,
    expectedHead: options.expectedHead,
    targetCommit: options.targetCommit,
    rescueRef: options.rescueRef,
    hooks: {
      ...(options.hooks?.afterRescueVerified === undefined
        ? {}
        : { afterRescueVerified: options.hooks.afterRescueVerified }),
      ...(options.hooks?.afterReset === undefined ? {} : { afterReset: options.hooks.afterReset }),
    },
  });
  await options.hooks?.afterGitMutation?.("reset");
  await finishRollback(store, result);
  return result;
}
export async function reconcileStartup(
  repositoryWithCommonDir: GitRepository,
  store: StateStore,
  options: StartupReconcileOptions = {},
): Promise<StartupReconcileResult> {
  let state = await store.readState();
  if (!samePath(state.repository.gitCommonDir, repositoryWithCommonDir.gitCommonDir)) {
    throw new Error("state belongs to a different repository");
  }
  let worktree: GitRepository;
  let workspaceRecreated = false;
  if (!(await pathExists(state.repository.worktreePath))) {
    const branchHead = await repositoryWithCommonDir.branchHead(state.repository.branch);
    if (
      branchHead === null &&
      state.phase === "checkpointing" &&
      state.operation?.kind === "workspace"
    ) {
      await repositoryWithCommonDir.createAutonomousWorktree({
        baseline: state.repository.baselineCommit,
        branch: state.repository.branch,
        worktreePath: state.repository.worktreePath,
      });
      await options.hooks?.afterGitMutation?.("workspace");
      state = await store.finishOperation(state.repository.baselineCommit);
      return { action: "workspace-recreated", state, checkpoint: null };
    }
    if (branchHead === null) throw new Error(`autonomous branch is missing: ${state.repository.branch}`);
    if (
      state.phase === "checkpointing" &&
      state.operation?.kind === "workspace" &&
      branchHead !== state.repository.baselineCommit
    ) {
      throw new CanonicalityError(state.repository.baselineCommit, branchHead, "workspace branch moved during init");
    }
    worktree = await repositoryWithCommonDir.recreatePersistentWorktree(
      state.repository.branch,
      state.repository.worktreePath,
    );
    await options.hooks?.afterGitMutation?.("workspace");
    if (state.phase === "checkpointing" && state.operation?.kind === "workspace") {
      state = await store.finishOperation(branchHead);
      return { action: "workspace-recreated", state, checkpoint: null };
    }
    workspaceRecreated = true;
  }
  worktree = await GitRepository.open(state.repository.worktreePath);
  await store.assertRepositoryIdentity({
    gitCommonDir: worktree.gitCommonDir,
    branch: state.repository.branch,
    worktreePath: worktree.repositoryRoot,
    baselineCommit: state.repository.baselineCommit,
  });
  const actualHead = await worktree.assertBranchIdentity(state.repository.branch);
  if (
    state.health.knownGoodCommit !== null &&
    !(await worktree.isAncestor(state.health.knownGoodCommit, actualHead))
  ) {
    throw new CanonicalityError(
      state.health.knownGoodCommit,
      actualHead,
      "known-good commit is not an ancestor of the active head",
    );
  }
  if (state.phase === "checkpointing") {
    if (state.operation?.kind === "workspace") {
      if (actualHead !== state.repository.baselineCommit) {
        throw new CanonicalityError(
          state.repository.baselineCommit,
          actualHead,
          "workspace init did not remain at baseline",
        );
      }
      state = await store.finishOperation(actualHead);
      return { action: "ready", state, checkpoint: null };
    }
    return continueCheckpoint(store, worktree, state, options);
  }
  if (state.phase === "rolling-back") {
    return continueRollback(store, worktree, state, options);
  }
  const agentMayHaveMovedHead =
    state.phase === "agent-running" ||
    state.phase === "repairing" ||
    (state.phase === "idle" && state.agent.pendingResult !== null);
  if (
    actualHead !== state.repository.expectedHead &&
    (!agentMayHaveMovedHead || !(await worktree.isAncestor(state.repository.expectedHead, actualHead)))
  ) {
    await stopForCanonicality(store, state.repository.expectedHead, actualHead);
  }
  if (state.phase === "smoke-checking") {
    rejectLiveRecordedCommand(state);
    return { action: "rerun-smoke", state, checkpoint: null };
  }
  if (state.phase === "deep-checking") {
    rejectLiveRecordedCommand(state);
    return { action: "rerun-deep", state, checkpoint: null };
  }
  if (state.phase === "diagnosing") {
    rejectLiveRecordedCommand(state);
    return { action: "restart-diagnosis", state, checkpoint: null };
  }
  if (state.phase === "stopped") {
    return { action: "stopped", state, checkpoint: null };
  }
  if (state.phase === "agent-running" || state.phase === "repairing") {
    if (
      actualHead === state.repository.expectedHead &&
      (await worktree.changedPaths(true)).length === 0
    ) {
      return {
        action: state.phase === "repairing" ? "resume-repair" : "resume-agent",
        state,
        checkpoint: null,
      };
    }
    if (options.guard === undefined) {
      return { action: "dirty-worktree", state, checkpoint: null };
    }
    const unitId = state.operation?.unitId ?? `interrupted-${state.eventSequence + 1}`;
    const checkpoint = await journaledCheckpoint(store, worktree, {
      branch: state.repository.branch,
      expectedBase: state.repository.expectedHead,
      summary: state.operation?.summary ?? "preserve interrupted work",
      sessionId: state.session.id,
      unitId,
      kind: state.phase === "repairing" ? "repair" : "interrupted",
      guard: async () => options.guard!(worktree),
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    });
    return {
      action: "interrupted-work-checkpointed",
      state: await store.readState(),
      checkpoint,
    };
  }
  if (
    (await worktree.changedPaths(true)).length > 0 ||
    (state.agent.pendingResult !== null && actualHead !== state.repository.expectedHead)
  ) {
    if (options.guard === undefined) return { action: "dirty-worktree", state, checkpoint: null };
    const completed = state.agent.pendingResult;
    const checkpoint = await journaledCheckpoint(store, worktree, {
      branch: state.repository.branch,
      expectedBase: state.repository.expectedHead,
      summary: completed?.response.summary ?? "preserve unexplained recoverable worktree edits",
      sessionId: state.session.id,
      unitId: completed?.unitId ?? `interrupted-${state.eventSequence + 1}`,
      kind: completed === null
        ? "interrupted"
        : completed.mode === "recovery" ? "repair" : "work",
      guard: async () => options.guard!(worktree),
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    });
    return {
      action: "interrupted-work-checkpointed",
      state: await store.readState(),
      checkpoint,
    };
  }
  return { action: workspaceRecreated ? "workspace-recreated" : "ready", state, checkpoint: null };
}
async function continueCheckpoint(
  store: StateStore,
  repository: GitRepository,
  state: RecoveryState,
  options: StartupReconcileOptions,
): Promise<StartupReconcileResult> {
  const pending = state.operation;
  if (pending === null || pending.kind !== "checkpoint") {
    throw new Error("checkpointing phase has no checkpoint operation");
  }
  const actual = await repository.assertBranchIdentity(state.repository.branch);
  if (
    actual !== pending.baseCommit &&
    !(await repository.isAncestor(pending.baseCommit, actual))
  ) {
    await stopForCanonicality(store, pending.baseCommit, actual);
  }
  if (actual !== pending.baseCommit) {
    const count = await repository.commitCount(`${pending.baseCommit}..${actual}`);
    const message = await repository.commitMessage(actual);
    if (count === 1 && operationTrailerMatches(message, state, pending)) {
      if (options.guard === undefined) {
        throw new Error("checkpoint adoption requires a configured safety guard");
      }
      await options.guard(repository, actual, pending.baseCommit);
      const finished = await store.finishOperation(actual);
      await store.appendEvent({
        type: "checkpoint-created",
        headCommit: actual,
        data: { unitId: pending.unitId, kind: pending.checkpointKind, reconciled: true },
      });
      return { action: "checkpoint-adopted", state: finished, checkpoint: null };
    }
  }
  const checkpoint = await continuePendingCheckpoint(store, repository, state, pending, options);
  return {
    action: "checkpoint-finished",
    state: await store.readState(),
    checkpoint,
  };
}
async function continuePendingCheckpoint(
  store: StateStore,
  repository: GitRepository,
  state: RecoveryState,
  pending: PendingOperation,
  options: StartupReconcileOptions,
): Promise<CheckpointResult | null> {
  if (
    pending.unitId === null ||
    pending.summary === null ||
    pending.checkpointKind === null
  ) {
    throw new Error("checkpoint operation is missing durable commit metadata");
  }
  const checkpoint = await repository.checkpoint({
    branch: state.repository.branch,
    expectedBase: pending.baseCommit,
    summary: pending.summary,
    sessionId: state.session.id,
    unitId: pending.unitId,
    kind: pending.checkpointKind,
    ...(pending.rescueRef === null ? {} : { normalizationRescueRef: pending.rescueRef }),
    ...(options.guard === undefined ? {} : { guard: async () => options.guard!(repository) }),
    ...(options.hooks?.afterRescueVerified === undefined
      ? {}
      : { afterNormalizationRescueVerified: options.hooks.afterRescueVerified }),
  });
  await options.hooks?.afterGitMutation?.("checkpoint");
  await store.finishOperation(checkpoint?.commit ?? pending.baseCommit);
  if (checkpoint !== null) {
    await store.appendEvent({
      type: "checkpoint-created",
      headCommit: checkpoint.commit,
      data: {
        unitId: pending.unitId,
        kind: pending.checkpointKind,
        reconciled: true,
        normalizedAgentHead: checkpoint.normalizedAgentHead,
        rescueRef: checkpoint.rescueRef,
      },
    });
  }
  return checkpoint;
}
async function continueRollback(
  store: StateStore,
  repository: GitRepository,
  state: RecoveryState,
  options: StartupReconcileOptions,
): Promise<StartupReconcileResult> {
  const pending = state.operation;
  if (pending === null || (pending.kind !== "reset" && pending.kind !== "revert")) {
    throw new Error("rolling-back phase has no reset or revert operation");
  }
  const actual = await repository.assertBranchIdentity(state.repository.branch);
  if (pending.kind === "reset") {
    if (pending.targetCommit === null || pending.rescueRef === null) {
      throw new Error("reset operation is missing target or rescue ref");
    }
    const rescueHead = await repository.branchHead(pending.rescueRef);
    if (actual === pending.targetCommit) {
      if (rescueHead !== pending.baseCommit || (await repository.hasTrackedChanges())) {
        throw new CanonicalityError(
          pending.baseCommit,
          rescueHead ?? "missing",
          "reset completed without a valid rescue ref",
        );
      }
      const result = {
        oldHead: pending.baseCommit,
        targetCommit: pending.targetCommit,
        rescueRef: pending.rescueRef,
      };
      await finishRollback(store, result);
      return { action: "rollback-finished", state: await store.readState(), checkpoint: null };
    }
    if (actual !== pending.baseCommit) {
      throw new CanonicalityError(pending.baseCommit, actual, "head moved during interrupted reset");
    }
    const result = await repository.hardRollback({
      branch: state.repository.branch,
      expectedHead: pending.baseCommit,
      targetCommit: pending.targetCommit,
      rescueRef: pending.rescueRef,
      hooks: {
        ...(options.hooks?.afterRescueVerified === undefined
          ? {}
          : { afterRescueVerified: options.hooks.afterRescueVerified }),
        ...(options.hooks?.afterReset === undefined ? {} : { afterReset: options.hooks.afterReset }),
      },
    });
    await finishRollback(store, result);
    return { action: "rollback-finished", state: await store.readState(), checkpoint: null };
  }
  if (pending.targetCommit === null || pending.unitId === null) {
    throw new Error("revert operation is missing target or unit ID");
  }
  if (pending.summary === "revert-conflicted") {
    const finished = await finishRevert(store, null, pending);
    await appendRevertEventOnce(store, pending, pending.baseCommit, false);
    return { action: "revert-conflicted", state: finished, checkpoint: null };
  }
  if (actual !== pending.baseCommit) {
    const count = await repository.commitCount(`${pending.baseCommit}..${actual}`);
    const message = await repository.commitMessage(actual);
    if (count === 1 && operationTrailerMatches(message, state, pending)) {
      const finished = await finishRevert(
        store,
        { commit: actual, revertedCommit: pending.targetCommit },
        pending,
      );
      await appendRevertEventOnce(store, pending, actual, true);
      return { action: "revert-finished", state: finished, checkpoint: null };
    }
    throw new CanonicalityError(pending.baseCommit, actual, "unexpected head during revert");
  }
  if (await repository.hasTrackedChanges()) {
    await repository.git(["revert", "--abort"], { allowFailure: true });
    if (await repository.hasTrackedChanges()) await repository.git(["reset", "--merge", "HEAD"]);
  }
  const result = await repository.cleanRevert({
    branch: state.repository.branch,
    expectedHead: pending.baseCommit,
    targetCommit: pending.targetCommit,
    sessionId: state.session.id,
    unitId: pending.unitId,
  });
  await options.hooks?.afterGitMutation?.("revert");
  const finished = await finishRevert(store, result, pending);
  await appendRevertEventOnce(store, pending, result?.commit ?? pending.baseCommit, result !== null);
  return {
    action: result === null ? "revert-conflicted" : "revert-finished",
    state: finished,
    checkpoint: null,
  };
}
async function finishRollback(store: StateStore, result: RollbackResult): Promise<void> {
  await store.finishOperation(result.targetCommit, (draft) => {
    const action = draft.recovery.pendingAction;
    if (
      action !== null && action.kind === "reset" && action.oldHead === result.oldHead &&
      action.targetCommit === result.targetCommit && action.rescueRef === result.rescueRef
    ) {
      action.status = "validating";
      action.resultCommit = result.targetCommit;
      return;
    }
    if (!draft.recovery.rescueRefs.includes(result.rescueRef)) {
      draft.recovery.rescueRefs.push(result.rescueRef);
    }
    const alreadyRecorded = draft.recovery.abandonedRanges.some(
      (range) => range.rescueRef === result.rescueRef,
    );
    if (!alreadyRecorded) {
      draft.recovery.abandonedRanges.push({
        oldHead: result.oldHead,
        targetCommit: result.targetCommit,
        rescueRef: result.rescueRef,
        recordedAt: new Date().toISOString(),
      });
    }
  });
  await store.appendEvent({
    type: "rollback-completed",
    headCommit: result.targetCommit,
    data: { oldHead: result.oldHead, rescueRef: result.rescueRef },
  });
}
async function finishRevert(
  store: StateStore,
  result: RevertResult | null,
  pending: PendingOperation,
): Promise<RecoveryState> {
  return store.finishOperation(result?.commit ?? pending.baseCommit, (draft) => {
    const action = draft.recovery.pendingAction;
    if (
      action === null || action.kind !== "revert" || action.oldHead !== pending.baseCommit ||
      action.targetCommit !== pending.targetCommit
    ) {
      return;
    }
    action.status = result === null ? "failed" : "validating";
    action.resultCommit = result?.commit ?? null;
  });
}
async function appendRevertEventOnce(
  store: StateStore,
  pending: PendingOperation,
  headCommit: string,
  succeeded: boolean,
): Promise<void> {
  const type = succeeded ? "revert-created" : "revert-failed";
  const existing = (await store.readEvents()).events.some((event) =>
    event.type === type && event.data.operationId === pending.id);
  if (existing) return;
  await store.appendEvent({
    type,
    headCommit,
    data: { targetCommit: pending.targetCommit, operationId: pending.id },
  });
}
function operation(
  values: Partial<PendingOperation> & Pick<PendingOperation, "kind" | "baseCommit">,
): PendingOperation {
  return {
    id: values.id ?? `op-${randomUUID()}`,
    kind: values.kind,
    unitId: values.unitId ?? null,
    baseCommit: values.baseCommit,
    targetCommit: values.targetCommit ?? null,
    observedHead: values.observedHead ?? null,
    rescueRef: values.rescueRef ?? null,
    childPid: values.childPid ?? null,
    summary: values.summary ?? null,
    checkpointKind: values.checkpointKind ?? null,
    startedAt: values.startedAt ?? new Date().toISOString(),
  };
}
function normalizationRef(sessionId: string, unitId: string): string {
  const safe = (value: string): string => value.replaceAll(/[^a-zA-Z0-9._-]+/gu, "-");
  return `recovery-loop/rescue/${safe(sessionId)}-${safe(unitId)}-agent-history`;
}
function operationTrailerMatches(
  message: string,
  state: RecoveryState,
  pending: PendingOperation,
): boolean {
  return (
    pending.unitId !== null &&
    message.includes(`Recovery-Loop-Session: ${state.session.id}`) &&
    message.includes(`Recovery-Loop-Unit: ${pending.unitId}`) &&
    (pending.checkpointKind === null ||
      message.includes(`Recovery-Loop-Kind: ${pending.checkpointKind}`))
  );
}
async function stopForCanonicality(
  store: StateStore,
  expected: string,
  actual: string,
): Promise<never> {
  await store.update((draft) => {
    draft.phase = "stopped";
    draft.session.status = "stopped";
    draft.session.stopReason = `canonical branch ambiguity: expected ${expected}, actual ${actual}`;
  });
  throw new CanonicalityError(expected, actual, "unexplained non-descendant branch movement");
}
async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function samePath(left: string, right: string): boolean {
  const a = new URL(`file:///${left.replaceAll("\\", "/")}`).pathname.toLowerCase();
  const b = new URL(`file:///${right.replaceAll("\\", "/")}`).pathname.toLowerCase();
  return process.platform === "win32" ? a === b : left === right;
}
export function interruptedOperation(options: {
  baseCommit: string;
  unitId: string;
  summary: string;
  kind?: CheckpointKind;
}): PendingOperation {
  return operation({
    kind: "checkpoint",
    baseCommit: options.baseCommit,
    unitId: options.unitId,
    summary: options.summary,
    checkpointKind: options.kind ?? "interrupted",
  });
}
function rejectLiveRecordedCommand(state: RecoveryState): void {
  const pid = state.operation?.kind === "check" ? state.operation.childPid : null;
  if (pid === null) return;
  if (!isRecordedProcessAlive(pid, state.operation!.startedAt)) return;
  throw new Error(`recorded command PID ${pid} is still alive; refusing to run a duplicate command`);
}
