import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import type {
  CommandClassification,
  CommandResult,
  CommandSpec,
  PendingOperation,
  Phase,
} from "./contracts.js";
import type { GitRepository } from "./git-repository.js";
import {
  ByteTail,
  boundedRedactedTail,
  commandSignature,
  findSensitiveMaterial,
} from "./safety.js";
import type { StateStore } from "./state-store.js";
export type CommandCategory = "prepare" | "smoke" | "deep" | "diagnostic";
export interface CommandRunnerHooks {
  beforeOutputOpen?: (commandDirectory: string) => void | Promise<void>;
  afterSpawn?: (pid: number | null) => void | Promise<void>;
}
export interface CommandSetHooks {
  afterCommand?: (result: CommandResult, index: number) => void | Promise<void>;
}
export interface RunCommandOptions {
  repository: GitRepository;
  command: CommandSpec;
  commit: string;
  category: CommandCategory;
  logRoot: string;
  sequence: number;
  environment?: NodeJS.ProcessEnv;
  maximumTailBytes?: number;
  terminationGraceMs?: number;
  hooks?: CommandRunnerHooks;
}
export interface ConfirmationResult {
  attempts: CommandResult[];
  confirmedFailure: boolean;
  consensus: "pass" | "fail" | "uncertain";
  classification: CommandClassification;
  signature: string;
}
const SENSITIVE_ENVIRONMENT_NAME =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTHORIZATION|COOKIE|SESSION|AWS_|AZURE_|GITHUB_|GITLAB_|OPENAI_|NPM_|SSH_)/iu;
const UNSAFE_PROCESS_ENVIRONMENT = new Set([
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
]);
export function sanitizeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      !SENSITIVE_ENVIRONMENT_NAME.test(name) &&
      !UNSAFE_PROCESS_ENVIRONMENT.has(name.toUpperCase()) &&
      findSensitiveMaterial(value).length === 0
    ) {
      sanitized[name] = value;
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENVIRONMENT_NAME.test(name) || UNSAFE_PROCESS_ENVIRONMENT.has(name.toUpperCase())) {
      throw new Error(`unsafe command environment override: ${name}`);
    }
    if (findSensitiveMaterial(value).length > 0) {
      throw new Error(`command environment override contains sensitive material: ${name}`);
    }
    sanitized[name] = value;
  }
  sanitized.CI = "1";
  sanitized.NO_COLOR = "1";
  sanitized.FORCE_COLOR = "0";
  sanitized.GIT_TERMINAL_PROMPT = "0";
  return sanitized;
}
export async function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const commandDirectory = path.join(
    options.logRoot,
    `${String(options.sequence).padStart(5, "0")}-${safeSegment(options.command.id)}`,
  );
  const stdoutPath = path.join(commandDirectory, "stdout.log");
  const stderrPath = path.join(commandDirectory, "stderr.log");
  const resultPath = path.join(commandDirectory, "result.json");
  const tailBytes = options.maximumTailBytes ?? 16 * 1024;
  const stdoutTail = new ByteTail(tailBytes);
  const stderrTail = new ByteTail(tailBytes);
  try {
    await mkdir(commandDirectory, { recursive: true });
    await options.hooks?.beforeOutputOpen?.(commandDirectory);
  } catch (error) {
    return setupFailure(options, started, startedAt, error);
  }
  const actualHead = await options.repository.head();
  if (actualHead !== options.commit) {
    return writeResult(
      resultPath,
      makeResult(options, {
        started,
        startedAt,
        classification: "safety",
        exitCode: null,
        signal: null,
        timedOut: false,
        worktreeChanged: false,
        stdoutPath,
        stderrPath,
        stdoutTail: "",
        stderrTail: "",
        error: `command commit mismatch: expected ${options.commit}, found ${actualHead}`,
      }),
    );
  }
  if (await options.repository.hasTrackedChanges()) {
    return writeResult(
      resultPath,
      makeResult(options, {
        started,
        startedAt,
        classification: "safety",
        exitCode: null,
        signal: null,
        timedOut: false,
        worktreeChanged: true,
        stdoutPath,
        stderrPath,
        stdoutTail: "",
        stderrTail: "",
        error: "refusing to run a check against a dirty tracked worktree",
      }),
    );
  }
  const preexistingUntracked = new Set(
    (await options.repository.changedPaths(true))
      .filter((change) => !change.tracked)
      .map((change) => change.path),
  );
  let stdoutStream;
  let stderrStream;
  try {
    stdoutStream = createWriteStream(stdoutPath, { flags: "wx", mode: 0o600 });
    stderrStream = createWriteStream(stderrPath, { flags: "wx", mode: 0o600 });
    await Promise.all([waitForOpen(stdoutStream), waitForOpen(stderrStream)]);
  } catch (error) {
    stdoutStream?.destroy();
    stderrStream?.destroy();
    return setupFailure(options, started, startedAt, error);
  }
  let spawnError: Error | null = null;
  let outputError: Error | null = null;
  let timedOut = false;
  let signal: NodeJS.Signals | null = null;
  let exitCode: number | null = null;
  const [executable, ...args] = options.command.argv;
  if (executable === undefined) throw new Error("command argv must not be empty");
  const terminationGraceMs = options.terminationGraceMs ?? 1_000;
  let child: ChildProcess | null = null;
  try {
    child = spawn(executable, args, {
      cwd: options.repository.repositoryRoot,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: sanitizeEnvironment(process.env, options.environment),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    spawnError = error instanceof Error ? error : new Error(String(error));
  }
  if (child === null) {
    stdoutStream.end();
    stderrStream.end();
  } else {
    const spawnedChild = child;
    const completion = new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (!settled) { settled = true; resolve(); }
      };
      spawnedChild.once("error", (error) => { spawnError = error; finish(); });
      spawnedChild.once("exit", (code, exitedSignal) => {
        exitCode = code;
        signal = exitedSignal;
        finish();
      });
    });
    const childStdout = spawnedChild.stdout;
    const childStderr = spawnedChild.stderr;
    if (childStdout === null || childStderr === null) {
      outputError = new Error("command output pipes were not created");
      stdoutStream.end();
      stderrStream.end();
      await terminateProcessTree(spawnedChild, terminationGraceMs);
    } else {
      childStdout.on("data", (chunk: Buffer) => stdoutTail.append(chunk));
      childStderr.on("data", (chunk: Buffer) => stderrTail.append(chunk));
      childStdout.pipe(stdoutStream);
      childStderr.pipe(stderrStream);
    }
    stdoutStream.on("error", (error) => {
      outputError = error;
      void terminateProcessTree(spawnedChild, terminationGraceMs);
    });
    stderrStream.on("error", (error) => {
      outputError = error;
      void terminateProcessTree(spawnedChild, terminationGraceMs);
    });
    try {
      await options.hooks?.afterSpawn?.(spawnedChild.pid ?? null);
    } catch (error) {
      await terminateProcessTree(spawnedChild, terminationGraceMs);
      throw error;
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(spawnedChild, terminationGraceMs);
    }, Math.max(1, Math.round(options.command.timeoutSeconds * 1_000)));
    timeout.unref();
    await completion;
    clearTimeout(timeout);
  }
  const drained = await drainCommandOutput(child, stdoutStream, stderrStream, terminationGraceMs);
  if (!drained.forced) {
    for (const streamResult of drained.results) {
      if (streamResult.status === "rejected") {
        outputError =
          streamResult.reason instanceof Error
            ? streamResult.reason
            : new Error(String(streamResult.reason));
      }
    }
  }
  let worktreeChanged = false;
  let mutationError: string | null = null;
  const headAfter = await options.repository.head();
  if (headAfter !== options.commit) {
    worktreeChanged = true;
    mutationError = `check moved HEAD from ${options.commit} to ${headAfter}; manual canonicality recovery is required`;
  } else if (await options.repository.hasTrackedChanges()) {
    worktreeChanged = true;
    const patchPath = path.join(commandDirectory, "tracked-mutation.patch");
    try {
      const mutation = (await options.repository.git(["diff", "--binary", options.commit])).stdout;
      await writeFile(patchPath, mutation, { encoding: "utf8", mode: 0o600 });
      await restoreTrackedMutation(options.repository, options.commit, preexistingUntracked);
      mutationError = `check altered tracked source; patch saved at ${patchPath}`;
    } catch (error) {
      mutationError = `check altered tracked source and cleanup failed: ${errorMessage(error)}`;
    }
  }
  let classification: CommandClassification;
  let error: string | null = null;
  if (mutationError !== null) {
    classification = headAfter === options.commit ? "infrastructure" : "safety";
    error = mutationError;
  } else if (outputError !== null) {
    classification = "infrastructure";
    error = `command output could not be recorded: ${errorMessage(outputError)}`;
  } else if (spawnError !== null) {
    classification = "infrastructure";
    error = `command could not start: ${errorMessage(spawnError)}`;
  } else if (timedOut) {
    classification = "infrastructure";
    error = `command timed out after ${options.command.timeoutSeconds}s`;
  } else if (signal !== null) {
    classification = "infrastructure";
    error = `command terminated by ${String(signal)}`;
  } else if (exitCode === 0) {
    classification = "pass";
  } else {
    classification = "product";
  }
  const result = makeResult(options, {
    started,
    startedAt,
    classification,
    exitCode,
    signal,
    timedOut,
    worktreeChanged,
    stdoutPath,
    stderrPath,
    stdoutTail: boundedRedactedTail(stdoutTail),
    stderrTail: boundedRedactedTail(stderrTail),
    error,
  });
  return writeResult(resultPath, result);
}
export async function runCommandSet(options: {
  repository: GitRepository;
  commands: readonly CommandSpec[];
  commit: string;
  category: CommandCategory;
  logRoot: string;
  sequenceStart: number;
  environment?: NodeJS.ProcessEnv;
  stopOnFailure?: boolean;
}): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (let index = 0; index < options.commands.length; index += 1) {
    const command = options.commands[index];
    if (command === undefined) continue;
    const result = await runCommand({
      repository: options.repository,
      command,
      commit: options.commit,
      category: options.category,
      logRoot: options.logRoot,
      sequence: options.sequenceStart + index,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    });
    results.push(result);
    if ((options.stopOnFailure ?? true) && result.classification !== "pass") break;
  }
  return results;
}
export async function runJournaledCommandSet(options: {
  store: StateStore;
  repository: GitRepository;
  commands: readonly CommandSpec[];
  commit: string;
  activeHead?: string;
  category: CommandCategory;
  logRoot: string;
  sequenceStart: number;
  environment?: NodeJS.ProcessEnv;
  stopOnFailure?: boolean;
  hooks?: CommandSetHooks;
}): Promise<CommandResult[]> {
  const state = await options.store.readState();
  const activeHead = options.activeHead ?? options.commit;
  if (state.repository.expectedHead !== activeHead) {
    throw new Error(
      `active head ${activeHead} does not match durable expected head ${state.repository.expectedHead}`,
    );
  }
  if (activeHead !== options.commit && options.category !== "diagnostic" && options.category !== "prepare") {
    throw new Error("only diagnostic or prepare commands may target a historical commit");
  }
  const operationId = `op-${randomUUID()}`;
  const pending: PendingOperation = {
    id: operationId,
    kind: "check",
    unitId: options.category,
    baseCommit: activeHead,
    targetCommit: options.commit,
    observedHead: options.commit,
    rescueRef: null,
    childPid: null,
    summary: `${options.category} command set`,
    checkpointKind: null,
    startedAt: new Date().toISOString(),
  };
  await options.store.persistIntent(checkPhase(options.category), pending);
  const results: CommandResult[] = [];
  for (let index = 0; index < options.commands.length; index += 1) {
    const command = options.commands[index];
    if (command === undefined) continue;
    await options.store.appendEvent({
      type: "check-started",
      headCommit: options.commit,
      data: { checkId: command.id, category: options.category },
    });
    const result = await runCommand({
      repository: options.repository,
      command,
      commit: options.commit,
      category: options.category,
      logRoot: options.logRoot,
      sequence: options.sequenceStart + index,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      hooks: {
        afterSpawn: async (pid) => {
          await options.store.update((draft) => {
            if (draft.operation?.id !== operationId) {
              throw new Error("check operation changed while command was starting");
            }
            draft.operation.childPid = pid;
          });
        },
      },
    });
    results.push(result);
    await options.store.appendEvent({
      type: "check-completed",
      headCommit: options.commit,
      data: {
        checkId: command.id,
        category: options.category,
        classification: result.classification,
        durationMs: result.durationMs,
      },
    });
    await options.hooks?.afterCommand?.(result, index);
    if ((options.stopOnFailure ?? true) && result.classification !== "pass") break;
  }
  const elapsed = results.reduce((total, result) => total + result.durationMs, 0);
  await options.store.finishOperation(activeHead, (draft) => {
    draft.usage.checkMilliseconds += elapsed;
  });
  return results;
}
export async function confirmFailure(
  first: CommandResult,
  rerun: (attempt: 2 | 3) => Promise<CommandResult>,
  persistedAttempts: readonly CommandResult[] = [first],
): Promise<ConfirmationResult> {
  if (first.classification === "pass") throw new Error("failure confirmation requires a failing first result");
  if (persistedAttempts.length === 0 || persistedAttempts.length > 3) {
    throw new Error("failure confirmation requires one to three persisted attempts");
  }
  const attempts = [...persistedAttempts];
  if (
    attempts[0]?.checkId !== first.checkId ||
    attempts[0].commit !== first.commit ||
    attempts[0].signature !== first.signature
  ) {
    throw new Error("persisted confirmation history does not begin with the original failure");
  }
  if (attempts.length < 2) attempts.push(await rerun(2));
  const initialConsensus = findConsensus(attempts);
  if (initialConsensus !== null) return confirmation(attempts, initialConsensus);
  if (attempts.length < 3) attempts.push(await rerun(3));
  const finalConsensus = findConsensus(attempts);
  if (finalConsensus !== null) return confirmation(attempts, finalConsensus);
  return {
    attempts,
    confirmedFailure: false,
    consensus: "uncertain",
    classification: "flaky",
    signature: attempts.at(-1)?.signature ?? first.signature,
  };
}
function findConsensus(results: readonly CommandResult[]): CommandResult | "pass" | null {
  const passes = results.filter((result) => result.classification === "pass");
  if (passes.length >= 2) return "pass";
  const groups = new Map<string, CommandResult[]>();
  for (const result of results) {
    if (result.classification === "pass") continue;
    const key = `${result.classification}:${result.signature}`;
    const group = groups.get(key) ?? [];
    group.push(result);
    groups.set(key, group);
    if (group.length >= 2) return result;
  }
  return null;
}
function confirmation(
  attempts: CommandResult[],
  consensus: CommandResult | "pass",
): ConfirmationResult {
  if (consensus === "pass") {
    return {
      attempts,
      confirmedFailure: false,
      consensus: "pass",
      classification: "flaky",
      signature: attempts.find((result) => result.classification === "pass")?.signature ?? "",
    };
  }
  return {
    attempts,
    confirmedFailure: true,
    consensus: "fail",
    classification: consensus.classification,
    signature: consensus.signature,
  };
}
async function terminateProcessTree(child: ChildProcess, graceMs: number): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  const force = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The process group already exited.
    }
  }, graceMs);
  force.unref();
}
async function drainCommandOutput(
  child: ChildProcess | null,
  stdoutStream: WriteStream,
  stderrStream: WriteStream,
  graceMs: number,
): Promise<{ forced: boolean; results: PromiseSettledResult<void>[] }> {
  const completion = Promise.allSettled([finished(stdoutStream), finished(stderrStream)]);
  const completedNormally = await Promise.race([
    completion.then(() => true),
    delay(Math.max(1, graceMs)).then(() => false),
  ]);
  if (completedNormally) return { forced: false, results: await completion };
  if (child !== null) {
    await terminateProcessTree(child, graceMs);
    child.stdout?.unpipe(stdoutStream);
    child.stderr?.unpipe(stderrStream);
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  stdoutStream.end();
  stderrStream.end();
  const ended = await Promise.race([
    completion.then(() => true),
    delay(Math.max(1, graceMs)).then(() => false),
  ]);
  if (!ended) {
    stdoutStream.destroy();
    stderrStream.destroy();
  }
  return { forced: true, results: await completion };
}
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function restoreTrackedMutation(
  repository: GitRepository,
  commit: string,
  preexistingUntracked: ReadonlySet<string>,
): Promise<void> {
  const changed = await repository.changedPaths(false);
  await repository.git(["restore", `--source=${commit}`, "--staged", "--worktree", "--", "."]);
  for (const change of changed) {
    if (preexistingUntracked.has(change.path)) continue;
    const existed = await repository.git(["cat-file", "-e", `${commit}:${change.path}`], {
      allowFailure: true,
    });
    if (existed.exitCode === 0) continue;
    const absolute = path.join(repository.repositoryRoot, ...change.path.split("/"));
    try {
      const metadata = await lstat(absolute);
      if (metadata.isFile() || metadata.isSymbolicLink()) await rm(absolute, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (await repository.hasTrackedChanges()) {
    throw new Error("tracked source remained dirty after command cleanup");
  }
}
interface ResultParts {
  started: number;
  startedAt: string;
  classification: CommandClassification;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  worktreeChanged: boolean;
  stdoutPath: string | null;
  stderrPath: string | null;
  stdoutTail: string;
  stderrTail: string;
  error: string | null;
}
function makeResult(options: RunCommandOptions, parts: ResultParts): CommandResult {
  const finishedAt = new Date().toISOString();
  const result: CommandResult = {
    checkId: options.command.id,
    argv: options.command.argv,
    commit: options.commit,
    startedAt: parts.startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.now() - parts.started),
    exitCode: parts.exitCode,
    signal: parts.signal,
    timedOut: parts.timedOut,
    classification: parts.classification,
    signature: "",
    worktreeChanged: parts.worktreeChanged,
    stdoutPath: parts.stdoutPath,
    stderrPath: parts.stderrPath,
    stdoutTail: parts.stdoutTail,
    stderrTail: parts.stderrTail,
    error: parts.error,
  };
  result.signature = commandSignature({
    checkId: result.checkId,
    classification: result.classification,
    exitCode: result.exitCode,
    signal: result.signal,
    stdoutTail: result.stdoutTail,
    stderrTail: result.stderrTail,
    variablePaths: [options.repository.repositoryRoot, options.logRoot],
  });
  return result;
}
async function writeResult(resultPath: string, result: CommandResult): Promise<CommandResult> {
  try {
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return result;
  } catch (error) {
    const failed = {
      ...result,
      classification: "infrastructure" as const,
      error: `command result could not be recorded: ${errorMessage(error)}`,
    };
    failed.signature = commandSignature({
      checkId: failed.checkId,
      classification: failed.classification,
      exitCode: failed.exitCode,
      signal: failed.signal,
      stdoutTail: failed.stdoutTail,
      stderrTail: failed.stderrTail,
    });
    return failed;
  }
}
function setupFailure(
  options: RunCommandOptions,
  started: number,
  startedAt: string,
  error: unknown,
): CommandResult {
  return makeResult(options, {
    started,
    startedAt,
    classification: "infrastructure",
    exitCode: null,
    signal: null,
    timedOut: false,
    worktreeChanged: false,
    stdoutPath: null,
    stderrPath: null,
    stdoutTail: "",
    stderrTail: "",
    error: `command output setup failed: ${errorMessage(error)}`,
  });
}
function safeSegment(value: string): string {
  const safe = value.replaceAll(/[^a-zA-Z0-9._-]+/gu, "-");
  if (safe.length === 0 || safe === "." || safe === "..") throw new Error("unsafe command ID");
  return safe;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function waitForOpen(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("open", () => resolve());
    stream.once("error", reject);
  });
}
function checkPhase(category: CommandCategory): Phase {
  if (category === "deep") return "deep-checking";
  if (category === "diagnostic" || category === "prepare") return "diagnosing";
  return "smoke-checking";
}
