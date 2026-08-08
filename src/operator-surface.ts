import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import {
  scaffoldContract,
  TRACKED_CONFIG_PATH,
  validateConfig,
  type RecoveryConfig,
} from "./config.js";
import type {
  CommandClassification,
  PendingFailure,
  Phase,
  RecoveryEvent,
  RecoveryState,
} from "./contracts.js";
import { initializeJournaledWorkspace } from "./git-operations.js";
import { GitRepository } from "./git-repository.js";
import {
  checkBaseline,
  runManualChecks,
  type HealthObservation,
} from "./health-controller.js";
import { StateStore, type LockSnapshot } from "./state-store.js";

export interface InitCommandOptions {
  base?: string;
  worktree?: string;
}
export type InitResult =
  | { kind: "scaffolded"; repositoryRoot: string; created: string[] }
  | {
      kind: "initialized";
      repositoryRoot: string;
      branch: string;
      worktreePath: string;
      baselineCommit: string;
      knownGoodCommit: string | null;
      pendingFailure: PendingFailure | null;
    };
export async function initializeRepository(
  repositoryPath: string,
  command: InitCommandOptions,
): Promise<InitResult> {
  const repository = await GitRepository.open(repositoryPath);
  const scaffold = await scaffoldContract(repository.repositoryRoot);
  if (scaffold.created.length > 0) {
    return { kind: "scaffolded", repositoryRoot: repository.repositoryRoot, created: scaffold.created };
  }
  const baselineCommit = await repository.resolveCommit(command.base ?? "HEAD");
  const config = await trackedConfig(repository, baselineCommit);
  const worktreePath = resolveWorktreePath(repository.repositoryRoot, command.worktree);
  const store = new StateStore(repository.gitCommonDir);
  const lock = await store.acquireLock("init");
  try {
    const initialized = await initializeJournaledWorkspace({
      operatorRepository: repository,
      store,
      branch: config.branch,
      worktreePath,
      baseline: baselineCommit,
      sessionId: operatorSessionId("init"),
    });
    await store.appendEvent({
      type: "session-started",
      headCommit: baselineCommit,
      data: { command: "init" },
    });
    const health = await checkBaseline({
      store,
      repository: initialized.worktree,
      config,
      now: new Date().toISOString(),
    });
    const finishedAt = new Date().toISOString();
    await store.update((draft) => {
      draft.phase = "stopped";
      draft.operation = null;
      draft.session.status = "stopped";
      draft.session.finishedAt = finishedAt;
      draft.session.stopReason = "initialized";
    }, finishedAt);
    await store.appendEvent({
      type: "session-stopped",
      headCommit: baselineCommit,
      data: { reason: "initialized", detail: null },
    });
    const state = await store.readState();
    return {
      kind: "initialized",
      repositoryRoot: repository.repositoryRoot,
      branch: config.branch,
      worktreePath,
      baselineCommit,
      knownGoodCommit: state.health.knownGoodCommit,
      pendingFailure: health.pendingFailure,
    };
  } finally {
    await lock.release();
  }
}
export function renderInitResult(result: InitResult): string {
  if (result.kind === "scaffolded") {
    return [
      `created adopting-project templates: ${result.created.join(", ")}`,
      "edit both files, configure safe local commands, commit them, then run recovery-loop init again",
      "no autonomous branch or runtime state was created",
    ].join("\n");
  }
  return [
    `initialized branch: ${result.branch}`,
    `autonomous worktree: ${result.worktreePath}`,
    `baseline: ${result.baselineCommit}`,
    `known-good anchor: ${result.knownGoodCommit ?? "none (baseline checks did not fully pass)"}`,
    `pending failure: ${result.pendingFailure?.id ?? "none"}`,
    "next: inspect with recovery-loop status, then start or resume with recovery-loop run",
  ].join("\n");
}

export interface StatusCheckOutcome {
  commit: string;
  timestamp: string | null;
  completeSetPassed: boolean;
  latestCheckId: string | null;
  latestClassification: CommandClassification | null;
}
export interface StatusSnapshot {
  schemaVersion: 1;
  sessionId: string;
  sessionStatus: "running" | "stopped";
  sessionStartedAt: string;
  stopReason: string | null;
  phase: Phase;
  branch: string;
  actualHead: string | null;
  expectedHead: string;
  headMatchesExpected: boolean;
  baselineCommit: string;
  knownGoodCommit: string | null;
  knownGoodRelation: "none" | "at-head" | "behind-head" | "not-ancestor" | "head-missing";
  commitsSinceKnownGood: number | null;
  lastSmoke: StatusCheckOutcome | null;
  lastDeep: StatusCheckOutcome | null;
  pendingFailure: PendingFailure | null;
  recovery: {
    pendingAction: RecoveryState["recovery"]["pendingAction"];
    repairAttempts: number;
    recoveryCycles: number;
    reverts: number;
    hardRollbacks: number;
    abandonedRanges: RecoveryState["recovery"]["abandonedRanges"];
    rescueRefs: string[];
  };
  lock: LockSnapshot;
  usage: RecoveryState["usage"] & {
    checkpoints: number;
    sessionElapsedMilliseconds: number;
  };
  recentEvents: Array<{
    sequence: number;
    type: RecoveryEvent["type"];
    timestamp: string;
    headCommit: string;
  }>;
  nextAction: string;
}
export async function readStatusSnapshot(repositoryPath: string): Promise<StatusSnapshot> {
  const repository = await GitRepository.open(repositoryPath);
  const store = new StateStore(repository.gitCommonDir);
  const state = await store.readState();
  if (normalizePath(state.repository.gitCommonDir) !== normalizePath(repository.gitCommonDir)) {
    throw new Error("state belongs to a different repository");
  }
  const events = (await store.readEvents()).events;
  const actualHead = await repository.branchHead(state.repository.branch);
  const position = await knownGoodPosition(repository, state.health.knownGoodCommit, actualHead);
  const elapsedEnd = state.session.status === "stopped"
    ? Date.parse(state.session.finishedAt ?? state.updatedAt)
    : Date.now();
  return {
    schemaVersion: 1,
    sessionId: state.session.id,
    sessionStatus: state.session.status,
    sessionStartedAt: state.session.startedAt,
    stopReason: state.session.stopReason,
    phase: state.phase,
    branch: state.repository.branch,
    actualHead,
    expectedHead: state.repository.expectedHead,
    headMatchesExpected: actualHead === state.repository.expectedHead,
    baselineCommit: state.repository.baselineCommit,
    knownGoodCommit: state.health.knownGoodCommit,
    knownGoodRelation: position.relation,
    commitsSinceKnownGood: position.distance,
    lastSmoke: lastCheckOutcome("smoke", state, events),
    lastDeep: lastCheckOutcome("deep", state, events),
    pendingFailure: state.health.pendingFailure,
    recovery: {
      pendingAction: state.recovery.pendingAction,
      repairAttempts: state.health.pendingFailure?.repairAttempts ?? 0,
      recoveryCycles: state.health.pendingFailure?.recoveryCycles ?? 0,
      reverts: events.filter((event) => event.type === "revert-created").length,
      hardRollbacks: events.filter((event) => event.type === "rollback-completed").length,
      abandonedRanges: state.recovery.abandonedRanges,
      rescueRefs: state.recovery.rescueRefs,
    },
    lock: await store.peekLock(),
    usage: {
      ...state.usage,
      checkpoints: await countSessionCheckpoints(repository, state, actualHead),
      sessionElapsedMilliseconds: Math.max(0, elapsedEnd - Date.parse(state.session.startedAt)),
    },
    recentEvents: events.slice(-5).map((event) => ({
      sequence: event.sequence,
      type: event.type,
      timestamp: event.timestamp,
      headCommit: event.headCommit,
    })),
    nextAction: nextAction(state),
  };
}
export function renderStatus(snapshot: StatusSnapshot): string {
  const localization = snapshot.pendingFailure?.localization;
  const lines = [
    `session: ${snapshot.sessionId} (${snapshot.sessionStatus})`,
    `phase: ${snapshot.phase}`,
    `branch: ${snapshot.branch}`,
    `current head (autonomous branch tip; may be unhealthy): ${snapshot.actualHead ?? "missing"}`,
    `durable expected head: ${snapshot.expectedHead} (${snapshot.headMatchesExpected ? "matches" : "MISMATCH"})`,
    `baseline: ${snapshot.baselineCommit}`,
    `known-good anchor (last complete smoke+deep pass): ${snapshot.knownGoodCommit ?? "none"}`,
    `head distance from known-good: ${snapshot.commitsSinceKnownGood ?? "unavailable"} (${snapshot.knownGoodRelation})`,
    `last smoke set: ${renderCheckOutcome(snapshot.lastSmoke)}`,
    `last deep set: ${renderCheckOutcome(snapshot.lastDeep)}`,
    `pending failure: ${renderPendingFailure(snapshot.pendingFailure)}`,
    `localization: ${localization === null || localization === undefined ? "none" : `${localization.status}; first bad ${snapshot.pendingFailure?.firstBadCommit ?? "not uniquely known"}`}`,
    `recovery history: ${snapshot.recovery.reverts} revert(s), ${snapshot.recovery.hardRollbacks} hard rollback(s), ${snapshot.recovery.rescueRefs.length} rescue ref(s)`,
    `lock: ${renderLock(snapshot.lock)}`,
    `budgets consumed: ${snapshot.usage.agentTurns} agent turn(s), ${snapshot.usage.checkpoints} checkpoint(s), ${snapshot.usage.checkMilliseconds} ms of checks`,
    `next: ${snapshot.nextAction}`,
    "recent events:",
    ...(snapshot.recentEvents.length === 0
      ? ["  none"]
      : snapshot.recentEvents.map((event) =>
          `  #${event.sequence} ${event.timestamp} ${event.type} ${event.headCommit}`)),
  ];
  return lines.join("\n");
}

export interface ManualCheckResult {
  deepRequested: boolean;
  observation: HealthObservation;
  requestedChecksPassed: boolean;
  knownGoodCommit: string | null;
  pendingFailure: PendingFailure | null;
}
export async function checkRepository(
  repositoryPath: string,
  deepRequested: boolean,
): Promise<ManualCheckResult> {
  const operator = await GitRepository.open(repositoryPath);
  const store = new StateStore(operator.gitCommonDir);
  const lock = await store.acquireLock("check");
  let restoreStopped = false;
  try {
    let state = await store.readState();
    await store.assertRepositoryIdentity({
      gitCommonDir: operator.gitCommonDir,
      branch: state.repository.branch,
      worktreePath: state.repository.worktreePath,
      baselineCommit: state.repository.baselineCommit,
    });
    if (state.recovery.pendingAction !== null) {
      throw new Error("a recovery action is pending; run recovery-loop run before manual checks");
    }
    restoreStopped = state.phase === "stopped" || state.session.status === "stopped";
    if (state.phase !== "idle" && state.phase !== "stopped") {
      throw new Error(`cannot check while phase is ${state.phase}; run recovery-loop run to reconcile it`);
    }
    if (state.phase === "stopped") {
      state = await store.update((draft) => {
        draft.phase = "idle";
      });
    }
    const config = await trackedConfig(operator, state.repository.expectedHead);
    if (config.branch !== state.repository.branch) {
      throw new Error("tracked recovery config branch differs from durable state");
    }
    const worktree = await GitRepository.open(state.repository.worktreePath);
    const head = await worktree.assertBranchIdentity(config.branch);
    if (head !== state.repository.expectedHead) {
      throw new Error(`actual head ${head} does not match durable head ${state.repository.expectedHead}`);
    }
    await worktree.ensureClean(true);
    const observation = await runManualChecks({
      store,
      repository: worktree,
      config,
      now: new Date().toISOString(),
    }, deepRequested);
    const latest = await store.readState();
    return {
      deepRequested,
      observation,
      requestedChecksPassed: requestedChecksPassed(observation, deepRequested),
      knownGoodCommit: latest.health.knownGoodCommit,
      pendingFailure: latest.health.pendingFailure,
    };
  } finally {
    if (restoreStopped) {
      const current = await store.readState().catch(() => null);
      if (current?.phase === "idle" && current.operation === null) {
        await store.update((draft) => {
          draft.phase = "stopped";
        });
      }
    }
    await lock.release();
  }
}
export function renderCheckResult(result: ManualCheckResult): string {
  return [
    `checked commit: ${result.observation.commit}`,
    `smoke: ${renderCommandResults(result.observation.smokeResults)}`,
    `deep: ${result.observation.deepResults === null ? "not requested" : renderCommandResults(result.observation.deepResults)}`,
    `known-good anchor: ${result.knownGoodCommit ?? "none"}`,
    `pending failure: ${result.pendingFailure?.id ?? "none"}`,
  ].join("\n");
}
export function renderRunSummary(summary: Readonly<Record<string, unknown>>): string {
  const completion = summary.agentCompletionBelief === true ? "reported by agent" : "not reported";
  const commandHealth = summary.finalHeadReceivedDeepPass === true
    ? "complete smoke+deep pass at current head"
    : "no complete deep pass at current head";
  return [
    `session: ${summaryValue(summary.sessionId, "unknown")}`,
    `stop reason: ${summaryValue(summary.stopReason, "unknown")}`,
    `current branch head: ${summaryValue(summary.finalCommit, "unknown")}`,
    `known-good anchor: ${summaryValue(summary.knownGoodCommit, "none")}`,
    `agent completion claim: ${completion}`,
    `final command health: ${commandHealth}`,
    "external correctness: not evaluated by Recovery Loop",
    `checkpoints: ${summaryValue(summary.checkpoints, "0")}; repairs: ${summaryValue(summary.repairCheckpoints, "0")}; reverts: ${summaryValue(summary.reverts, "0")}; hard rollbacks: ${summaryValue(summary.hardRollbacks, "0")}`,
  ].join("\n");
}
export class CheckCommandFailed extends Error {
  constructor() {
    super("one or more requested checks failed; failure state was preserved");
    this.name = "CheckCommandFailed";
  }
}

async function trackedConfig(repository: GitRepository, commit: string): Promise<RecoveryConfig> {
  const raw = (await repository.git(["show", `${commit}:${TRACKED_CONFIG_PATH}`])).stdout;
  try {
    return validateConfig(JSON.parse(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`tracked recovery config is invalid: ${message}`, { cause: error });
  }
}
function resolveWorktreePath(repositoryRoot: string, configured: string | undefined): string {
  if (configured !== undefined) return path.resolve(repositoryRoot, configured);
  return path.join(
    path.dirname(repositoryRoot),
    `.${path.basename(repositoryRoot)}-recovery-loop`,
    "worktree",
  );
}
function operatorSessionId(command: string): string {
  const timestamp = new Date().toISOString().replaceAll(/\D/gu, "").slice(0, 14);
  return `rl-${command}-${timestamp}-${randomUUID().slice(0, 8)}`;
}
async function knownGoodPosition(
  repository: GitRepository,
  knownGood: string | null,
  actualHead: string | null,
): Promise<{
  relation: StatusSnapshot["knownGoodRelation"];
  distance: number | null;
}> {
  if (knownGood === null) return { relation: "none", distance: null };
  if (actualHead === null) return { relation: "head-missing", distance: null };
  if (knownGood === actualHead) return { relation: "at-head", distance: 0 };
  if (!(await repository.isAncestor(knownGood, actualHead))) {
    return { relation: "not-ancestor", distance: null };
  }
  return {
    relation: "behind-head",
    distance: await repository.commitCount(`${knownGood}..${actualHead}`),
  };
}
function lastCheckOutcome(
  category: "smoke" | "deep",
  state: RecoveryState,
  events: readonly RecoveryEvent[],
): StatusCheckOutcome | null {
  const event = [...events].reverse().find((candidate) =>
    candidate.type === "check-completed" && candidate.data.category === category);
  const stateCommit = category === "smoke"
    ? state.health.lastSmokePassCommit
    : state.health.lastDeepRunCommit;
  const commit = event?.headCommit ?? stateCommit;
  if (commit === null || commit === undefined) return null;
  const classification = event?.data.classification;
  return {
    commit,
    timestamp: event?.timestamp ?? (category === "deep" ? state.health.lastDeepRunAt : null),
    completeSetPassed: category === "smoke"
      ? state.health.lastSmokePassCommit === commit
      : state.health.lastDeepRunCommit === commit && state.health.knownGoodCommit === commit,
    latestCheckId: typeof event?.data.checkId === "string" ? event.data.checkId : null,
    latestClassification: isClassification(classification) ? classification : null,
  };
}
function isClassification(value: unknown): value is CommandClassification {
  return typeof value === "string" &&
    ["pass", "product", "infrastructure", "flaky", "safety"].includes(value);
}
async function countSessionCheckpoints(
  repository: GitRepository,
  state: RecoveryState,
  actualHead: string | null,
): Promise<number> {
  if (actualHead === null) return 0;
  const output = (await repository.git([
    "log",
    `${state.repository.baselineCommit}..${state.repository.branch}`,
    "--format=%B%x00",
  ])).stdout;
  const trailer = `Recovery-Loop-Session: ${state.session.id}`;
  return output.split("\0").filter((message) => message.includes(trailer)).length;
}
function requestedChecksPassed(observation: HealthObservation, deepRequested: boolean): boolean {
  const passes = (results: readonly { classification: CommandClassification; worktreeChanged: boolean }[]): boolean =>
    results.length > 0 && results.every((result) => result.classification === "pass" && !result.worktreeChanged);
  return passes(observation.smokeResults) &&
    (!deepRequested || (observation.deepResults !== null && passes(observation.deepResults)));
}
function renderCommandResults(results: HealthObservation["smokeResults"]): string {
  return results.map((result) => `${result.checkId}=${result.classification}`).join(", ") || "no results";
}
function renderCheckOutcome(outcome: StatusCheckOutcome | null): string {
  if (outcome === null) return "not run";
  const status = outcome.completeSetPassed ? "PASS" : "not passing as a complete set";
  const latest = outcome.latestCheckId === null
    ? ""
    : `; latest ${outcome.latestCheckId}=${outcome.latestClassification ?? "unknown"}`;
  return `${status} at ${outcome.commit}${latest}`;
}
function renderPendingFailure(failure: PendingFailure | null): string {
  if (failure === null) return "none";
  return `${failure.id}; ${failure.checkId}=${failure.classification}; confirmed=${String(failure.confirmed)}; discovered at ${failure.discoveredAtCommit}`;
}
function renderLock(lock: LockSnapshot): string {
  if (lock.status === "none") return "none";
  if (lock.status === "malformed") return `malformed (${lock.error})`;
  return `${lock.record.command} PID ${lock.record.pid} on ${lock.record.hostname} since ${lock.record.startedAt}`;
}
function summaryValue(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : fallback;
}
function nextAction(state: RecoveryState): string {
  const phase = state.phase;
  if (phase === "smoke-checking") return "rerun smoke commands";
  if (phase === "deep-checking") return "rerun deep commands";
  if (phase === "checkpointing") return "reconcile checkpoint operation";
  if (phase === "rolling-back") return "reconcile rollback operation";
  if (phase === "agent-running") return "preserve interrupted work or resume agent";
  if (phase === "repairing") return "preserve interrupted repair or resume repair";
  if (phase === "diagnosing") return "restart diagnosis";
  if (phase === "stopped") return "remain stopped until run is invoked intentionally";
  if (state.recovery.pendingAction !== null) return `resume ${state.recovery.pendingAction.kind} recovery action`;
  if (state.health.pendingFailure !== null) return "confirm, localize, or repair the pending failure";
  if (state.cadence.deepRequired) return "run the due deep command set";
  return "invoke the coding agent for one checkpoint-sized unit";
}
function normalizePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
