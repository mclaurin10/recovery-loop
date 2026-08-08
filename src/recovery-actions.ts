import { runJournaledCommandSet } from "./check-runner.js";
import type {
  CommandResult,
  PendingFailure,
  PendingRecoveryAction,
  RecoveryState,
} from "./contracts.js";
import { journaledCleanRevert, journaledHardRollback } from "./git-operations.js";
import { runRecoveryChecks, type HealthControllerOptions } from "./health-controller.js";
import type { Stage9Context, Stage9Result } from "./recovery-fallback.js";

export async function beginFallbackRecovery(
  context: Stage9Context,
  failure: PendingFailure,
): Promise<Stage9Result> {
  const state = await context.store.readState();
  if (state.recovery.pendingAction !== null) return continueRecoveryAction(context);
  const current = requireFailure(state, failure.id);
  if (current.firstBadCommit !== null) {
    await planAction(context, current, "revert", current.firstBadCommit, null);
    return continueRecoveryAction(context);
  }
  return planResetOrStop(context, current, "a unique first-bad commit is unavailable");
}

export async function continueRecoveryAction(context: Stage9Context): Promise<Stage9Result> {
  let state = await context.store.readState();
  let action = state.recovery.pendingAction;
  if (action === null) return { stop: null, detail: null };
  if (action.status === "planned") {
    if (action.kind === "revert") {
      await journaledCleanRevert(context.store, context.worktree, {
        branch: context.config.branch,
        expectedHead: action.oldHead,
        targetCommit: action.targetCommit,
        sessionId: state.session.id,
        unitId: `revert-${action.failureId}`,
        ...(context.hooks?.afterRevertMutation === undefined
          ? {}
          : { hooks: { afterGitMutation: context.hooks.afterRevertMutation } }),
      });
      return { stop: null, detail: null };
    }
    if (action.rescueRef === null) throw new Error("planned reset has no rescue ref");
    await journaledHardRollback(context.store, context.worktree, {
      branch: context.config.branch,
      expectedHead: action.oldHead,
      targetCommit: action.targetCommit,
      rescueRef: action.rescueRef,
      hooks: {
        ...(context.hooks?.afterRescueVerified === undefined
          ? {}
          : { afterRescueVerified: context.hooks.afterRescueVerified }),
        ...(context.hooks?.afterReset === undefined ? {} : { afterReset: context.hooks.afterReset }),
      },
    });
    await context.hooks?.afterRollbackState?.();
    return { stop: null, detail: null };
  }
  if (action.status === "failed") {
    if (action.kind === "revert") {
      const failure = state.health.pendingFailure;
      if (failure === null) throw new Error("failed revert lost its pending failure");
      return planResetOrStop(context, failure, "clean revert conflicted or produced no commit");
    }
    return {
      stop: "recovery-infrastructure",
      detail: "restored known-good anchor did not regain complete command health after bounded environment recovery",
    };
  }
  if (action.resultCommit === null) throw new Error("recovery validation has no exact result commit");
  const head = await context.worktree.assertBranchIdentity(context.config.branch);
  if (head !== action.resultCommit || state.repository.expectedHead !== head) {
    return {
      stop: "recovery-safety",
      detail: "recovery action result no longer matches the durable branch head",
    };
  }
  const fullyHealthy = state.health.pendingFailure === null &&
    state.health.lastSmokePassCommit === head && state.health.lastDeepRunCommit === head &&
    state.health.knownGoodCommit === head;
  if (fullyHealthy) return finishSuccessfulAction(context, action);
  if (action.validationAttempts === 0) {
    await runRecoveryChecks(healthOptions(context), head);
    return { stop: null, detail: null };
  }
  state = await context.store.readState();
  action = state.recovery.pendingAction;
  if (action === null || state.health.pendingFailure === null) return { stop: null, detail: null };
  if (action.kind === "revert") {
    return planResetOrStop(
      context,
      state.health.pendingFailure,
      "clean revert failed complete smoke/deep health",
    );
  }
  await recordAbandonment(context, action);
  state = await context.store.readState();
  action = state.recovery.pendingAction;
  if (action === null) throw new Error("rollback action disappeared before validation completed");
  const restoredFailure = state.health.pendingFailure;
  if (restoredFailure === null) return { stop: null, detail: null };
  if (restoredFailure.classification === "safety") {
    return { stop: "recovery-safety", detail: "restored anchor crossed a safety boundary" };
  }
  if (restoredFailure.classification === "flaky") {
    return { stop: "recovery-flaky", detail: "restored anchor produced flaky health evidence" };
  }
  if (action.environmentAttempts === 0 && context.config.prepare !== null) {
    const prepared = await runActivePrepare(context, restoredFailure.checkId, head);
    await context.store.update((draft) => {
      const current = draft.recovery.pendingAction;
      if (current === null || current.kind !== "reset" || current.resultCommit !== head) {
        throw new Error("rollback action changed during environment prepare");
      }
      current.environmentAttempts = 1;
    }, context.clock().toISOString());
    if (prepared.classification !== "pass") {
      await markResetFailed(context);
      return {
        stop: "recovery-infrastructure",
        detail: prepared.error ?? "rollback prepare command failed",
      };
    }
    await runRecoveryChecks(healthOptions(context), head);
    return { stop: null, detail: null };
  }
  if (action.environmentAttempts === 1 && action.validationAttempts === 1) {
    await runRecoveryChecks(healthOptions(context), head);
    return { stop: null, detail: null };
  }
  await markResetFailed(context);
  return {
    stop: "recovery-infrastructure",
    detail: "known-good anchor failed after reset; environment drift or stale health did not converge",
  };
}

async function runActivePrepare(
  context: Stage9Context,
  checkId: string,
  commit: string,
): Promise<CommandResult> {
  const prepare = context.config.prepare;
  if (prepare === null) throw new Error("active environment recovery has no prepare command");
  const state = await context.store.readState();
  const layout = await context.store.ensureSessionLayout(state.session.id);
  const results = await runJournaledCommandSet({
    store: context.store,
    repository: context.worktree,
    commands: [{ id: `prepare-${checkId}`, argv: prepare.argv, timeoutSeconds: prepare.timeoutSeconds }],
    commit,
    category: "prepare",
    logRoot: layout.checks,
    sequenceStart: state.eventSequence + 1,
  });
  const result = results[0];
  if (result === undefined) throw new Error("rollback prepare command produced no result");
  return result;
}

async function planResetOrStop(
  context: Stage9Context,
  failure: PendingFailure,
  reason: string,
): Promise<Stage9Result> {
  const target = failure.knownGoodCommit;
  if (target === null) {
    return {
      stop: "repair-exhausted",
      detail: `${reason}; no verified known-good anchor exists, so rollback is unavailable`,
    };
  }
  const state = await context.store.readState();
  const sequence = state.recovery.rollbackSequence + 1;
  const rescueRef = `recovery-loop/rescue/${safeRef(state.session.id)}-${String(sequence).padStart(4, "0")}`;
  await planAction(context, failure, "reset", target, rescueRef, sequence);
  return continueRecoveryAction(context);
}

async function planAction(
  context: Stage9Context,
  failure: PendingFailure,
  kind: PendingRecoveryAction["kind"],
  targetCommit: string,
  rescueRef: string | null,
  rollbackSequence?: number,
): Promise<void> {
  const state = await context.store.readState();
  const head = state.repository.expectedHead;
  await context.store.update((draft) => {
    const existing = draft.recovery.pendingAction;
    if (existing !== null && !(kind === "reset" && existing.kind === "revert")) {
      throw new Error("another recovery action is already pending");
    }
    draft.recovery.pendingAction = {
      failureId: failure.id,
      kind,
      status: "planned",
      oldHead: head,
      targetCommit,
      resultCommit: null,
      rescueRef,
      environmentAttempts: 0,
      validationAttempts: 0,
      abandonmentRecorded: false,
      threadRotated: false,
      startedAt: context.clock().toISOString(),
    };
    if (rollbackSequence !== undefined) draft.recovery.rollbackSequence = rollbackSequence;
  }, context.clock().toISOString());
}

async function finishSuccessfulAction(
  context: Stage9Context,
  action: PendingRecoveryAction,
): Promise<Stage9Result> {
  if (action.kind === "reset") await recordAbandonment(context, action);
  let cleared = false;
  await context.store.update((draft) => {
    const current = draft.recovery.pendingAction;
    if (current === null || current.kind !== action.kind || current.resultCommit !== action.resultCommit) return;
    draft.recovery.pendingAction = null;
    cleared = true;
  }, context.clock().toISOString());
  if (cleared && action.resultCommit !== null) {
    await context.store.appendEvent({
      type: "failure-repaired",
      headCommit: action.resultCommit,
      data: { failureId: action.failureId, method: action.kind },
    });
  }
  return { stop: null, detail: null };
}

async function recordAbandonment(
  context: Stage9Context,
  requested: PendingRecoveryAction,
): Promise<void> {
  if (requested.kind !== "reset" || requested.rescueRef === null || requested.resultCommit === null) {
    throw new Error("only a completed reset can record an abandoned direction");
  }
  let recorded = false;
  let rotated = false;
  let oldThreadId: string | null = null;
  await context.store.update((draft) => {
    const action = draft.recovery.pendingAction;
    if (action === null || action.kind !== "reset" || action.rescueRef !== requested.rescueRef) {
      throw new Error("rollback action changed before abandonment recording");
    }
    if (!action.abandonmentRecorded) {
      if (!draft.recovery.rescueRefs.includes(action.rescueRef!)) {
        draft.recovery.rescueRefs.push(action.rescueRef!);
      }
      if (!draft.recovery.abandonedRanges.some((range) => range.rescueRef === action.rescueRef)) {
        draft.recovery.abandonedRanges.push({
          oldHead: action.oldHead,
          targetCommit: action.targetCommit,
          rescueRef: action.rescueRef!,
          recordedAt: context.clock().toISOString(),
        });
      }
      action.abandonmentRecorded = true;
      recorded = true;
    }
    if (!action.threadRotated) {
      oldThreadId = draft.agent.threadId;
      draft.agent.threadId = null;
      draft.agent.threadTurns = 0;
      action.threadRotated = true;
      rotated = true;
    }
  }, context.clock().toISOString());
  if (recorded) {
    await context.store.appendEvent({
      type: "direction-abandoned",
      headCommit: requested.resultCommit,
      data: {
        oldHead: requested.oldHead,
        targetCommit: requested.targetCommit,
        rescueRef: requested.rescueRef,
      },
    });
  }
  if (rotated) {
    await context.store.appendEvent({
      type: "thread-rotated",
      headCommit: requested.resultCommit,
      data: { reason: "hard-rollback", oldThreadId },
    });
  }
}

async function markResetFailed(context: Stage9Context): Promise<void> {
  await context.store.update((draft) => {
    const action = draft.recovery.pendingAction;
    if (action === null || action.kind !== "reset") throw new Error("no reset action is pending");
    action.status = "failed";
  }, context.clock().toISOString());
}

function requireFailure(state: RecoveryState, failureId: string): PendingFailure {
  const failure = state.health.pendingFailure;
  if (failure === null || failure.id !== failureId || state.recovery.activeFailureId !== failureId) {
    throw new Error(`active pending failure changed: expected ${failureId}`);
  }
  return failure;
}

function healthOptions(context: Stage9Context): HealthControllerOptions {
  return {
    store: context.store,
    repository: context.worktree,
    config: context.config,
    now: context.clock().toISOString(),
    commandSetHooks: {
      ...(context.hooks?.afterRecoverySmokeCommand === undefined
        ? {}
        : { smoke: { afterCommand: context.hooks.afterRecoverySmokeCommand } }),
      ...(context.hooks?.afterRecoveryDeepCommand === undefined
        ? {}
        : { deep: { afterCommand: context.hooks.afterRecoveryDeepCommand } }),
    },
  };
}

function safeRef(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/gu, "-");
}
