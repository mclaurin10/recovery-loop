import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import {
  ValidationError,
  expectExactKeys,
  expectNonEmptyString,
  expectObject,
  expectPositiveInteger,
  expectString,
  validateRecoveryState,
  type EventType,
  type PendingOperation,
  type Phase,
  type RecoveryEvent,
  type RecoveryState,
} from "./contracts.js";

export interface StateStoreHooks {
  beforeStateRename?: (temporaryPath: string, destinationPath: string) => void | Promise<void>;
  afterStateRename?: (destinationPath: string) => void | Promise<void>;
  afterIntentPersisted?: (state: RecoveryState) => void | Promise<void>;
  afterLockCreated?: (lockPath: string) => void | Promise<void>;
  beforeLockRelease?: (lockPath: string) => void | Promise<void>;
  beforeEventAppend?: (eventPath: string) => void | Promise<void>;
}

export interface ControllerLockRecord {
  token: string;
  pid: number;
  hostname: string;
  startedAt: string;
  command: string;
}

export type LockSnapshot =
  | { status: "none" }
  | { status: "valid"; record: ControllerLockRecord }
  | { status: "malformed"; error: string };

export class ControllerLockedError extends Error {
  readonly snapshot: Exclude<LockSnapshot, { status: "none" }>;

  constructor(message: string, snapshot: Exclude<LockSnapshot, { status: "none" }>) {
    super(message);
    this.name = "ControllerLockedError";
    this.snapshot = snapshot;
  }
}

export class ControllerLock {
  readonly record: ControllerLockRecord;
  readonly #store: StateStore;
  #released = false;

  constructor(store: StateStore, record: ControllerLockRecord) {
    this.#store = store;
    this.record = record;
  }

  async release(): Promise<boolean> {
    if (this.#released) return false;
    const released = await this.#store.releaseLock(this.record.token);
    if (released) this.#released = true;
    return released;
  }
}

export interface EventReadResult {
  events: RecoveryEvent[];
  corruptLineNumbers: number[];
  ignoredIncompleteFinalLine: boolean;
}

export interface EventWriteResult {
  event: RecoveryEvent;
  written: boolean;
  error: string | null;
}

export interface SessionLayout {
  root: string;
  agent: string;
  checks: string;
  diagnoses: string;
  summary: string;
}

export class StateStore {
  readonly runtimeRoot: string;
  readonly statePath: string;
  readonly lockPath: string;
  readonly eventsPath: string;
  readonly hooks: StateStoreHooks;

  constructor(gitCommonDir: string, hooks: StateStoreHooks = {}) {
    this.runtimeRoot = path.join(gitCommonDir, "recovery-loop");
    this.statePath = path.join(this.runtimeRoot, "state.json");
    this.lockPath = path.join(this.runtimeRoot, "controller.lock");
    this.eventsPath = path.join(this.runtimeRoot, "events.jsonl");
    this.hooks = hooks;
  }

  async initialize(state: RecoveryState): Promise<void> {
    await mkdir(this.runtimeRoot, { recursive: true });
    try {
      await readFile(this.statePath);
      throw new Error(`state already exists: ${this.statePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.writeState(state);
  }

  async readState(): Promise<RecoveryState> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.statePath, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new ValidationError("state", `invalid JSON: ${error.message}`);
      }
      throw error;
    }
    return validateRecoveryState(parsed);
  }

  async writeState(state: RecoveryState): Promise<void> {
    const validated = validateRecoveryState(structuredClone(state));
    await mkdir(this.runtimeRoot, { recursive: true });
    const temporaryPath = path.join(
      this.runtimeRoot,
      `.state.json.tmp-${process.pid}-${randomUUID()}`,
    );
    const file = await open(temporaryPath, "wx", 0o600);
    let closed = false;
    try {
      await file.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await file.sync();
      await file.close();
      closed = true;
      await this.hooks.beforeStateRename?.(temporaryPath, this.statePath);
      await rename(temporaryPath, this.statePath);
      await this.hooks.afterStateRename?.(this.statePath);
      await syncDirectory(this.runtimeRoot);
    } finally {
      if (!closed) await file.close().catch(() => undefined);
    }
  }

  async update(mutator: (draft: RecoveryState) => void, now = new Date().toISOString()): Promise<RecoveryState> {
    const draft = structuredClone(await this.readState());
    mutator(draft);
    draft.updatedAt = now;
    await this.writeState(draft);
    return draft;
  }

  async persistIntent(phase: Phase, operation: PendingOperation): Promise<RecoveryState> {
    if (phase === "idle" || phase === "stopped") {
      throw new Error(`cannot persist an operation in phase ${phase}`);
    }
    const state = await this.update((draft) => {
      draft.phase = phase;
      draft.operation = operation;
    });
    await this.hooks.afterIntentPersisted?.(state);
    return state;
  }

  async finishOperation(expectedHead: string, update?: (draft: RecoveryState) => void): Promise<RecoveryState> {
    return this.update((draft) => {
      draft.repository.expectedHead = expectedHead;
      draft.phase = "idle";
      draft.operation = null;
      update?.(draft);
    });
  }

  async assertRepositoryIdentity(identity: {
    gitCommonDir: string;
    branch: string;
    worktreePath: string;
    baselineCommit?: string;
  }): Promise<RecoveryState> {
    const state = await this.readState();
    if (!pathsEqual(state.repository.gitCommonDir, identity.gitCommonDir)) {
      throw new Error(
        `state belongs to a different Git common directory: ${state.repository.gitCommonDir}`,
      );
    }
    if (state.repository.branch !== identity.branch) {
      throw new Error(`state branch mismatch: ${state.repository.branch} != ${identity.branch}`);
    }
    if (!pathsEqual(state.repository.worktreePath, identity.worktreePath)) {
      throw new Error(`state worktree mismatch: ${state.repository.worktreePath}`);
    }
    if (
      identity.baselineCommit !== undefined &&
      state.repository.baselineCommit !== identity.baselineCommit
    ) {
      throw new Error(`state baseline mismatch: ${state.repository.baselineCommit}`);
    }
    return state;
  }

  async appendEvent(input: {
    type: EventType;
    headCommit: string;
    data?: Record<string, unknown>;
  }): Promise<EventWriteResult> {
    const state = await this.update((draft) => {
      draft.eventSequence += 1;
    });
    const event: RecoveryEvent = {
      sequence: state.eventSequence,
      timestamp: new Date().toISOString(),
      sessionId: state.session.id,
      headCommit: input.headCommit,
      type: input.type,
      data: input.data ?? {},
    };
    try {
      await this.hooks.beforeEventAppend?.(this.eventsPath);
      await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      return { event, written: true, error: null };
    } catch (error) {
      return {
        event,
        written: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async readEvents(): Promise<EventReadResult> {
    let contents: string;
    try {
      contents = await readFile(this.eventsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { events: [], corruptLineNumbers: [], ignoredIncompleteFinalLine: false };
      }
      throw error;
    }
    const lines = contents.split("\n");
    const incompleteFinal = !contents.endsWith("\n");
    const events: RecoveryEvent[] = [];
    const corruptLineNumbers: number[] = [];
    let ignoredIncompleteFinalLine = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.length === 0) continue;
      try {
        events.push(validateEvent(JSON.parse(line), `events line ${index + 1}`));
      } catch {
        if (incompleteFinal && index === lines.length - 1) {
          ignoredIncompleteFinalLine = true;
        } else {
          corruptLineNumbers.push(index + 1);
        }
      }
    }
    return { events, corruptLineNumbers, ignoredIncompleteFinalLine };
  }

  async acquireLock(command: string): Promise<ControllerLock> {
    if (command === "status") throw new Error("status must not acquire the mutating controller lock");
    await mkdir(this.runtimeRoot, { recursive: true });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const record: ControllerLockRecord = {
        token: randomUUID(),
        pid: process.pid,
        hostname: hostname(),
        startedAt: new Date().toISOString(),
        command,
      };
      try {
        const file = await open(this.lockPath, "wx", 0o600);
        try {
          await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        await this.hooks.afterLockCreated?.(this.lockPath);
        return new ControllerLock(this, record);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const snapshot = await this.peekLock();
      if (snapshot.status === "none") continue;
      if (snapshot.status === "malformed") {
        throw new ControllerLockedError("controller lock is malformed and will not be stolen", snapshot);
      }
      const owner = snapshot.record;
      if (owner.hostname !== hostname()) {
        throw new ControllerLockedError("controller lock belongs to another host", snapshot);
      }
      if (isPidAlive(owner.pid)) {
        throw new ControllerLockedError(`controller is already running as PID ${owner.pid}`, snapshot);
      }
      const staleName = path.join(
        this.runtimeRoot,
        `controller.lock.stale-${Date.now()}-${owner.token}`,
      );
      try {
        await rename(this.lockPath, staleName);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    throw new Error("controller lock changed repeatedly while acquiring it");
  }

  async peekLock(): Promise<LockSnapshot> {
    let contents: string;
    try {
      contents = await readFile(this.lockPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "none" };
      throw error;
    }
    try {
      return { status: "valid", record: validateLock(JSON.parse(contents)) };
    } catch (error) {
      return { status: "malformed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async releaseLock(token: string): Promise<boolean> {
    const snapshot = await this.peekLock();
    if (snapshot.status !== "valid" || snapshot.record.token !== token) return false;
    await this.hooks.beforeLockRelease?.(this.lockPath);
    try {
      await unlink(this.lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async ensureSessionLayout(sessionId: string): Promise<SessionLayout> {
    if (!/^[a-zA-Z0-9._-]+$/u.test(sessionId)) throw new Error("unsafe session ID");
    const root = path.join(this.runtimeRoot, "runs", sessionId);
    const agent = path.join(root, "agent");
    const checks = path.join(root, "checks");
    const diagnoses = path.join(root, "diagnoses");
    await Promise.all([
      mkdir(agent, { recursive: true }),
      mkdir(checks, { recursive: true }),
      mkdir(diagnoses, { recursive: true }),
    ]);
    return { root, agent, checks, diagnoses, summary: path.join(root, "summary.json") };
  }

  async writeSummary(sessionId: string, summary: Record<string, unknown>): Promise<string> {
    const layout = await this.ensureSessionLayout(sessionId);
    const temporary = `${layout.summary}.tmp-${process.pid}-${randomUUID()}`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(summary, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, layout.summary);
    await syncDirectory(layout.root);
    return layout.summary;
  }
}

function validateLock(value: unknown): ControllerLockRecord {
  const object = expectObject(value, "lock");
  expectExactKeys(object, "lock", ["token", "pid", "hostname", "startedAt", "command"]);
  const startedAt = expectString(object.startedAt, "lock.startedAt");
  if (!Number.isFinite(Date.parse(startedAt))) {
    throw new ValidationError("lock.startedAt", "expected an ISO date-time");
  }
  return {
    token: expectNonEmptyString(object.token, "lock.token"),
    pid: expectPositiveInteger(object.pid, "lock.pid"),
    hostname: expectNonEmptyString(object.hostname, "lock.hostname"),
    startedAt,
    command: expectNonEmptyString(object.command, "lock.command"),
  };
}

function validateEvent(value: unknown, valuePath: string): RecoveryEvent {
  const object = expectObject(value, valuePath);
  expectExactKeys(object, valuePath, [
    "sequence",
    "timestamp",
    "sessionId",
    "headCommit",
    "type",
    "data",
  ]);
  const sequence = expectPositiveInteger(object.sequence, `${valuePath}.sequence`);
  const timestamp = expectString(object.timestamp, `${valuePath}.timestamp`);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new ValidationError(`${valuePath}.timestamp`, "expected an ISO date-time");
  }
  const data = expectObject(object.data, `${valuePath}.data`);
  return {
    sequence,
    timestamp,
    sessionId: expectNonEmptyString(object.sessionId, `${valuePath}.sessionId`),
    headCommit: expectNonEmptyString(object.headCommit, `${valuePath}.headCommit`),
    type: expectNonEmptyString(object.type, `${valuePath}.type`) as EventType,
    data,
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function pathsEqual(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
