export const STATE_SCHEMA_VERSION = 1 as const;
export const CONFIG_SCHEMA_VERSION = 1 as const;

export class ValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ValidationError";
    this.path = path;
  }
}

export type JsonObject = Record<string, unknown>;

export function expectObject(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(path, "expected an object");
  }
  return value as JsonObject;
}

export function expectExactKeys(
  object: JsonObject,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new ValidationError(`${path}.${key}`, "unknown key");
    }
  }
  for (const key of required) {
    if (!(key in object)) {
      throw new ValidationError(`${path}.${key}`, "missing required key");
    }
  }
}

export function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(path, "expected a string");
  }
  return value;
}

export function expectNonEmptyString(value: unknown, path: string): string {
  const string = expectString(value, path);
  if (string.trim().length === 0) {
    throw new ValidationError(path, "must not be empty");
  }
  if (string.includes("\0")) {
    throw new ValidationError(path, "must not contain NUL");
  }
  return string;
}

export function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ValidationError(path, "expected a boolean");
  }
  return value;
}

export function expectNullableString(value: unknown, path: string): string | null {
  return value === null ? null : expectString(value, path);
}

export function expectNonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ValidationError(path, "expected a non-negative safe integer");
  }
  return value as number;
}

export function expectPositiveInteger(value: unknown, path: string): number {
  const integer = expectNonNegativeInteger(value, path);
  if (integer === 0) {
    throw new ValidationError(path, "expected a positive safe integer");
  }
  return integer;
}

export function expectPositiveFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError(path, "expected a positive finite number");
  }
  return value;
}

export function expectStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(path, "expected an array");
  }
  return value.map((entry, index) => expectString(entry, `${path}[${index}]`));
}

export function expectEnum<const T extends readonly string[]>(
  value: unknown,
  path: string,
  values: T,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new ValidationError(path, `expected one of: ${values.join(", ")}`);
  }
  return value as T[number];
}

export interface CommandSpec {
  id: string;
  argv: readonly string[];
  timeoutSeconds: number;
  bisectable?: boolean;
}

export type CommandClassification =
  | "pass"
  | "product"
  | "infrastructure"
  | "flaky"
  | "safety";

export interface CommandResult {
  checkId: string;
  argv: readonly string[];
  commit: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  classification: CommandClassification;
  signature: string;
  worktreeChanged: boolean;
  stdoutPath: string | null;
  stderrPath: string | null;
  stdoutTail: string;
  stderrTail: string;
  error: string | null;
}

export const AGENT_OUTCOMES = ["changed", "no_change", "goal_complete", "blocked"] as const;
export type AgentOutcome = (typeof AGENT_OUTCOMES)[number];

export interface AgentResponse {
  outcome: AgentOutcome;
  summary: string;
  nextHint: string | null;
  blocker: string | null;
}

export function validateAgentResponse(value: unknown): AgentResponse {
  const object = expectObject(value, "agentResponse");
  expectExactKeys(object, "agentResponse", ["outcome", "summary", "nextHint", "blocker"]);
  const outcome = expectEnum(object.outcome, "agentResponse.outcome", AGENT_OUTCOMES);
  const summary = expectNonEmptyString(object.summary, "agentResponse.summary");
  const nextHint = expectNullableString(object.nextHint, "agentResponse.nextHint");
  const blocker = expectNullableString(object.blocker, "agentResponse.blocker");
  if (outcome === "blocked" && (blocker === null || blocker.trim().length === 0)) {
    throw new ValidationError("agentResponse.blocker", "is required for a blocked outcome");
  }
  if (outcome !== "blocked" && blocker !== null) {
    throw new ValidationError("agentResponse.blocker", "must be null unless outcome is blocked");
  }
  return { outcome, summary, nextHint, blocker };
}

export const PHASES = [
  "idle",
  "agent-running",
  "checkpointing",
  "smoke-checking",
  "deep-checking",
  "diagnosing",
  "repairing",
  "rolling-back",
  "stopped",
] as const;
export type Phase = (typeof PHASES)[number];

export const OPERATION_KINDS = ["workspace", "checkpoint", "revert", "reset", "check", "agent"] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const CHECKPOINT_KINDS = ["work", "repair", "interrupted", "revert"] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

export interface PendingOperation {
  id: string;
  kind: OperationKind;
  unitId: string | null;
  baseCommit: string;
  targetCommit: string | null;
  observedHead: string | null;
  rescueRef: string | null;
  childPid: number | null;
  summary: string | null;
  checkpointKind: CheckpointKind | null;
  startedAt: string;
}

export interface PendingFailure {
  id: string;
  checkId: string;
  classification: Exclude<CommandClassification, "pass">;
  signature: string;
  discoveredAtCommit: string;
  confirmed: boolean;
  knownGoodCommit: string | null;
  firstBadCommit: string | null;
  regressionWindow: [string, string] | null;
  repairAttempts: number;
  recoveryCycles: number;
  latestResultPath: string;
}

export interface AbandonedRange {
  oldHead: string;
  targetCommit: string;
  rescueRef: string;
  recordedAt: string;
}

export interface RecoveryState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  repository: {
    gitCommonDir: string;
    baselineCommit: string;
    branch: string;
    worktreePath: string;
    expectedHead: string;
  };
  session: {
    id: string;
    startedAt: string;
    status: "running" | "stopped";
    stopReason: string | null;
  };
  phase: Phase;
  operation: PendingOperation | null;
  agent: {
    threadId: string | null;
    turns: number;
    consecutiveNoChange: number;
    threadTurns: number;
  };
  health: {
    knownGoodCommit: string | null;
    lastSmokePassCommit: string | null;
    lastDeepRunCommit: string | null;
    lastDeepRunAt: string | null;
    pendingFailure: PendingFailure | null;
  };
  cadence: {
    smokePassingCheckpointsSinceDeep: number;
    deepRequired: boolean;
    deepReasons: string[];
  };
  recovery: {
    activeFailureId: string | null;
    sameSignatureCycles: number;
    abandonedRanges: AbandonedRange[];
    rescueRefs: string[];
  };
  usage: {
    agentTurns: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    checkMilliseconds: number;
  };
  eventSequence: number;
  createdAt: string;
  updatedAt: string;
}

export type EventType =
  | "session-started"
  | "startup-reconciled"
  | "agent-started"
  | "agent-completed"
  | "agent-failed"
  | "thread-rotated"
  | "checkpoint-created"
  | "guard-rejected"
  | "check-started"
  | "check-completed"
  | "failure-observed"
  | "known-good-advanced"
  | "rescue-ref-created"
  | "revert-created"
  | "revert-failed"
  | "rollback-completed"
  | "session-stopped";

export interface RecoveryEvent {
  sequence: number;
  timestamp: string;
  sessionId: string;
  headCommit: string;
  type: EventType;
  data: Record<string, unknown>;
}

const HASH_PATTERN = /^[0-9a-f]{40,64}$/;

function expectCommit(value: unknown, path: string): string {
  const commit = expectString(value, path);
  if (!HASH_PATTERN.test(commit)) {
    throw new ValidationError(path, "expected a full hexadecimal object ID");
  }
  return commit;
}

function expectNullableCommit(value: unknown, path: string): string | null {
  return value === null ? null : expectCommit(value, path);
}

function expectIsoDate(value: unknown, path: string): string {
  const date = expectString(value, path);
  if (!Number.isFinite(Date.parse(date))) {
    throw new ValidationError(path, "expected an ISO date-time");
  }
  return date;
}

function validatePendingOperation(value: unknown, path: string): PendingOperation | null {
  if (value === null) return null;
  const object = expectObject(value, path);
  expectExactKeys(object, path, [
    "id",
    "kind",
    "unitId",
    "baseCommit",
    "targetCommit",
    "observedHead",
    "rescueRef",
    "childPid",
    "summary",
    "checkpointKind",
    "startedAt",
  ]);
  const checkpointKind =
    object.checkpointKind === null
      ? null
      : expectEnum(object.checkpointKind, `${path}.checkpointKind`, CHECKPOINT_KINDS);
  const childPid =
    object.childPid === null ? null : expectPositiveInteger(object.childPid, `${path}.childPid`);
  return {
    id: expectNonEmptyString(object.id, `${path}.id`),
    kind: expectEnum(object.kind, `${path}.kind`, OPERATION_KINDS),
    unitId:
      object.unitId === null ? null : expectNonEmptyString(object.unitId, `${path}.unitId`),
    baseCommit: expectCommit(object.baseCommit, `${path}.baseCommit`),
    targetCommit: expectNullableCommit(object.targetCommit, `${path}.targetCommit`),
    observedHead: expectNullableCommit(object.observedHead, `${path}.observedHead`),
    rescueRef:
      object.rescueRef === null
        ? null
        : expectNonEmptyString(object.rescueRef, `${path}.rescueRef`),
    childPid,
    summary:
      object.summary === null ? null : expectNonEmptyString(object.summary, `${path}.summary`),
    checkpointKind,
    startedAt: expectIsoDate(object.startedAt, `${path}.startedAt`),
  };
}

function validatePendingFailure(value: unknown, path: string): PendingFailure | null {
  if (value === null) return null;
  const object = expectObject(value, path);
  expectExactKeys(object, path, [
    "id",
    "checkId",
    "classification",
    "signature",
    "discoveredAtCommit",
    "confirmed",
    "knownGoodCommit",
    "firstBadCommit",
    "regressionWindow",
    "repairAttempts",
    "recoveryCycles",
    "latestResultPath",
  ]);
  const failureClasses = ["product", "infrastructure", "flaky", "safety"] as const;
  let regressionWindow: [string, string] | null = null;
  if (object.regressionWindow !== null) {
    if (!Array.isArray(object.regressionWindow) || object.regressionWindow.length !== 2) {
      throw new ValidationError(`${path}.regressionWindow`, "expected two commits or null");
    }
    regressionWindow = [
      expectCommit(object.regressionWindow[0], `${path}.regressionWindow[0]`),
      expectCommit(object.regressionWindow[1], `${path}.regressionWindow[1]`),
    ];
  }
  return {
    id: expectNonEmptyString(object.id, `${path}.id`),
    checkId: expectNonEmptyString(object.checkId, `${path}.checkId`),
    classification: expectEnum(object.classification, `${path}.classification`, failureClasses),
    signature: expectNonEmptyString(object.signature, `${path}.signature`),
    discoveredAtCommit: expectCommit(object.discoveredAtCommit, `${path}.discoveredAtCommit`),
    confirmed: expectBoolean(object.confirmed, `${path}.confirmed`),
    knownGoodCommit: expectNullableCommit(object.knownGoodCommit, `${path}.knownGoodCommit`),
    firstBadCommit: expectNullableCommit(object.firstBadCommit, `${path}.firstBadCommit`),
    regressionWindow,
    repairAttempts: expectNonNegativeInteger(object.repairAttempts, `${path}.repairAttempts`),
    recoveryCycles: expectNonNegativeInteger(object.recoveryCycles, `${path}.recoveryCycles`),
    latestResultPath: expectString(object.latestResultPath, `${path}.latestResultPath`),
  };
}

function validateAbandonedRange(value: unknown, path: string): AbandonedRange {
  const object = expectObject(value, path);
  expectExactKeys(object, path, ["oldHead", "targetCommit", "rescueRef", "recordedAt"]);
  return {
    oldHead: expectCommit(object.oldHead, `${path}.oldHead`),
    targetCommit: expectCommit(object.targetCommit, `${path}.targetCommit`),
    rescueRef: expectNonEmptyString(object.rescueRef, `${path}.rescueRef`),
    recordedAt: expectIsoDate(object.recordedAt, `${path}.recordedAt`),
  };
}

function expectNullableDate(value: unknown, path: string): string | null {
  return value === null ? null : expectIsoDate(value, path);
}

export function validateRecoveryState(value: unknown): RecoveryState {
  const state = expectObject(value, "state");
  expectExactKeys(state, "state", [
    "schemaVersion",
    "repository",
    "session",
    "phase",
    "operation",
    "agent",
    "health",
    "cadence",
    "recovery",
    "usage",
    "eventSequence",
    "createdAt",
    "updatedAt",
  ]);
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new ValidationError(
      "state.schemaVersion",
      `unsupported schema version ${String(state.schemaVersion)}`,
    );
  }

  const repository = expectObject(state.repository, "state.repository");
  expectExactKeys(repository, "state.repository", [
    "gitCommonDir",
    "baselineCommit",
    "branch",
    "worktreePath",
    "expectedHead",
  ]);
  const session = expectObject(state.session, "state.session");
  expectExactKeys(session, "state.session", ["id", "startedAt", "status", "stopReason"]);
  const agent = expectObject(state.agent, "state.agent");
  expectExactKeys(agent, "state.agent", [
    "threadId",
    "turns",
    "consecutiveNoChange",
    "threadTurns",
  ]);
  const health = expectObject(state.health, "state.health");
  expectExactKeys(health, "state.health", [
    "knownGoodCommit",
    "lastSmokePassCommit",
    "lastDeepRunCommit",
    "lastDeepRunAt",
    "pendingFailure",
  ]);
  const cadence = expectObject(state.cadence, "state.cadence");
  expectExactKeys(cadence, "state.cadence", [
    "smokePassingCheckpointsSinceDeep",
    "deepRequired",
    "deepReasons",
  ]);
  const recovery = expectObject(state.recovery, "state.recovery");
  expectExactKeys(recovery, "state.recovery", [
    "activeFailureId",
    "sameSignatureCycles",
    "abandonedRanges",
    "rescueRefs",
  ]);
  const usage = expectObject(state.usage, "state.usage");
  expectExactKeys(usage, "state.usage", [
    "agentTurns",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningTokens",
    "checkMilliseconds",
  ]);

  if (!Array.isArray(recovery.abandonedRanges)) {
    throw new ValidationError("state.recovery.abandonedRanges", "expected an array");
  }
  const usageValue = {
    agentTurns: expectNonNegativeInteger(usage.agentTurns, "state.usage.agentTurns"),
    inputTokens: expectNonNegativeInteger(usage.inputTokens, "state.usage.inputTokens"),
    cachedInputTokens: expectNonNegativeInteger(
      usage.cachedInputTokens,
      "state.usage.cachedInputTokens",
    ),
    outputTokens: expectNonNegativeInteger(usage.outputTokens, "state.usage.outputTokens"),
    reasoningTokens: expectNonNegativeInteger(
      usage.reasoningTokens,
      "state.usage.reasoningTokens",
    ),
    checkMilliseconds: expectNonNegativeInteger(
      usage.checkMilliseconds,
      "state.usage.checkMilliseconds",
    ),
  };

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    repository: {
      gitCommonDir: expectNonEmptyString(repository.gitCommonDir, "state.repository.gitCommonDir"),
      baselineCommit: expectCommit(repository.baselineCommit, "state.repository.baselineCommit"),
      branch: expectNonEmptyString(repository.branch, "state.repository.branch"),
      worktreePath: expectNonEmptyString(repository.worktreePath, "state.repository.worktreePath"),
      expectedHead: expectCommit(repository.expectedHead, "state.repository.expectedHead"),
    },
    session: {
      id: expectNonEmptyString(session.id, "state.session.id"),
      startedAt: expectIsoDate(session.startedAt, "state.session.startedAt"),
      status: expectEnum(session.status, "state.session.status", ["running", "stopped"] as const),
      stopReason: expectNullableString(session.stopReason, "state.session.stopReason"),
    },
    phase: expectEnum(state.phase, "state.phase", PHASES),
    operation: validatePendingOperation(state.operation, "state.operation"),
    agent: {
      threadId: expectNullableString(agent.threadId, "state.agent.threadId"),
      turns: expectNonNegativeInteger(agent.turns, "state.agent.turns"),
      consecutiveNoChange: expectNonNegativeInteger(
        agent.consecutiveNoChange,
        "state.agent.consecutiveNoChange",
      ),
      threadTurns: expectNonNegativeInteger(agent.threadTurns, "state.agent.threadTurns"),
    },
    health: {
      knownGoodCommit: expectNullableCommit(
        health.knownGoodCommit,
        "state.health.knownGoodCommit",
      ),
      lastSmokePassCommit: expectNullableCommit(
        health.lastSmokePassCommit,
        "state.health.lastSmokePassCommit",
      ),
      lastDeepRunCommit: expectNullableCommit(
        health.lastDeepRunCommit,
        "state.health.lastDeepRunCommit",
      ),
      lastDeepRunAt: expectNullableDate(health.lastDeepRunAt, "state.health.lastDeepRunAt"),
      pendingFailure: validatePendingFailure(health.pendingFailure, "state.health.pendingFailure"),
    },
    cadence: {
      smokePassingCheckpointsSinceDeep: expectNonNegativeInteger(
        cadence.smokePassingCheckpointsSinceDeep,
        "state.cadence.smokePassingCheckpointsSinceDeep",
      ),
      deepRequired: expectBoolean(cadence.deepRequired, "state.cadence.deepRequired"),
      deepReasons: expectStringArray(cadence.deepReasons, "state.cadence.deepReasons"),
    },
    recovery: {
      activeFailureId: expectNullableString(
        recovery.activeFailureId,
        "state.recovery.activeFailureId",
      ),
      sameSignatureCycles: expectNonNegativeInteger(
        recovery.sameSignatureCycles,
        "state.recovery.sameSignatureCycles",
      ),
      abandonedRanges: recovery.abandonedRanges.map((entry, index) =>
        validateAbandonedRange(entry, `state.recovery.abandonedRanges[${index}]`),
      ),
      rescueRefs: expectStringArray(recovery.rescueRefs, "state.recovery.rescueRefs"),
    },
    usage: usageValue,
    eventSequence: expectNonNegativeInteger(state.eventSequence, "state.eventSequence"),
    createdAt: expectIsoDate(state.createdAt, "state.createdAt"),
    updatedAt: expectIsoDate(state.updatedAt, "state.updatedAt"),
  };
}

export interface InitialStateOptions {
  gitCommonDir: string;
  baselineCommit: string;
  branch: string;
  worktreePath: string;
  sessionId: string;
  now?: string;
}

export function createInitialState(options: InitialStateOptions): RecoveryState {
  const now = options.now ?? new Date().toISOString();
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    repository: {
      gitCommonDir: options.gitCommonDir,
      baselineCommit: options.baselineCommit,
      branch: options.branch,
      worktreePath: options.worktreePath,
      expectedHead: options.baselineCommit,
    },
    session: {
      id: options.sessionId,
      startedAt: now,
      status: "running",
      stopReason: null,
    },
    phase: "idle",
    operation: null,
    agent: {
      threadId: null,
      turns: 0,
      consecutiveNoChange: 0,
      threadTurns: 0,
    },
    health: {
      knownGoodCommit: null,
      lastSmokePassCommit: null,
      lastDeepRunCommit: null,
      lastDeepRunAt: null,
      pendingFailure: null,
    },
    cadence: {
      smokePassingCheckpointsSinceDeep: 0,
      deepRequired: true,
      deepReasons: ["initial-baseline"],
    },
    recovery: {
      activeFailureId: null,
      sameSignatureCycles: 0,
      abandonedRanges: [],
      rescueRefs: [],
    },
    usage: {
      agentTurns: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      checkMilliseconds: 0,
    },
    eventSequence: 0,
    createdAt: now,
    updatedAt: now,
  };
}
