#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import { CodexAgentGateway } from "./agent-gateway.js";
import { runNormalController } from "./controller.js";
import { GitRepository } from "./git-repository.js";
import { StateStore, type LockSnapshot } from "./state-store.js";
import type { PendingFailure, Phase } from "./contracts.js";
export type ParsedCommand =
  | { command: "init"; base?: string; worktree?: string }
  | {
      command: "run";
      maxAgentTurns?: number;
      maxCheckpoints?: number;
      maxMinutes?: number;
    }
  | { command: "status"; json: boolean }
  | { command: "check"; deep: boolean }
  | { command: "help"; topic?: "init" | "run" | "status" | "check" };
export interface CliHandlers {
  init(command: Extract<ParsedCommand, { command: "init" }>): Promise<void>;
  run(command: Extract<ParsedCommand, { command: "run" }>): Promise<void>;
  status(command: Extract<ParsedCommand, { command: "status" }>): Promise<void>;
  check(command: Extract<ParsedCommand, { command: "check" }>): Promise<void>;
}
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}
function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliUsageError(`${flag} requires a value`);
  }
  return value;
}
function positiveInteger(value: string, flag: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new CliUsageError(`${flag} requires a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CliUsageError(`${flag} is too large`);
  }
  return parsed;
}
function rejectDuplicate(seen: Set<string>, flag: string): void {
  if (seen.has(flag)) throw new CliUsageError(`${flag} may only be specified once`);
  seen.add(flag);
}
function parseInit(argv: readonly string[]): ParsedCommand {
  let base: string | undefined;
  let worktree: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") {
      if (argv.length !== 1) throw new CliUsageError("--help cannot be combined with other flags");
      return { command: "help", topic: "init" };
    }
    if (flag === "--base") {
      rejectDuplicate(seen, flag);
      base = requireValue(argv, index, flag);
      index += 1;
    } else if (flag === "--worktree") {
      rejectDuplicate(seen, flag);
      worktree = requireValue(argv, index, flag);
      index += 1;
    } else {
      throw new CliUsageError(`unknown init flag: ${flag ?? ""}`);
    }
  }
  return {
    command: "init",
    ...(base === undefined ? {} : { base }),
    ...(worktree === undefined ? {} : { worktree }),
  };
}
function parseRun(argv: readonly string[]): ParsedCommand {
  const values: Partial<Record<"maxAgentTurns" | "maxCheckpoints" | "maxMinutes", number>> = {};
  const flags: ReadonlyMap<string, keyof typeof values> = new Map([
    ["--max-agent-turns", "maxAgentTurns"],
    ["--max-checkpoints", "maxCheckpoints"],
    ["--max-minutes", "maxMinutes"],
  ] as const);
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) throw new CliUsageError("missing run flag");
    if (flag === "--help") {
      if (argv.length !== 1) throw new CliUsageError("--help cannot be combined with other flags");
      return { command: "help", topic: "run" };
    }
    const key = flags.get(flag);
    if (key === undefined) throw new CliUsageError(`unknown run flag: ${flag}`);
    rejectDuplicate(seen, flag);
    values[key] = positiveInteger(requireValue(argv, index, flag), flag);
    index += 1;
  }
  return { command: "run", ...values };
}
function parseBooleanFlag(
  command: "status" | "check",
  argv: readonly string[],
  flag: "--json" | "--deep",
): ParsedCommand {
  if (argv.length === 1 && argv[0] === "--help") return { command: "help", topic: command };
  if (argv.length === 0) {
    return command === "status" ? { command, json: false } : { command, deep: false };
  }
  if (argv.length === 1 && argv[0] === flag) {
    return command === "status" ? { command, json: true } : { command, deep: true };
  }
  throw new CliUsageError(`unknown ${command} flag: ${argv[0] ?? ""}`);
}
export function parseCli(argv: readonly string[]): ParsedCommand {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    if (rest.length > 0) throw new CliUsageError("help does not accept positional arguments");
    return { command: "help" };
  }
  if (command === "init") return parseInit(rest);
  if (command === "run") return parseRun(rest);
  if (command === "status") return parseBooleanFlag("status", rest, "--json");
  if (command === "check") return parseBooleanFlag("check", rest, "--deep");
  throw new CliUsageError(`unknown command: ${command}`);
}
export function helpText(topic?: "init" | "run" | "status" | "check"): string {
  if (topic === "init") return "Usage: recovery-loop init [--base <revision>] [--worktree <path>]";
  if (topic === "run") {
    return "Usage: recovery-loop run [--max-agent-turns <n>] [--max-checkpoints <n>] [--max-minutes <n>]";
  }
  if (topic === "status") return "Usage: recovery-loop status [--json]";
  if (topic === "check") return "Usage: recovery-loop check [--deep]";
  return [
    "Usage: recovery-loop <command> [options]",
    "",
    "Commands:",
    "  init     Create or resume the dedicated recovery workspace",
    "  run      Start or resume autonomous work",
    "  status   Read current state without mutation",
    "  check    Run configured checks without invoking an agent",
  ].join("\n");
}
export async function dispatchCli(command: ParsedCommand, handlers: CliHandlers): Promise<void> {
  if (command.command === "help") {
    process.stdout.write(`${helpText(command.topic)}\n`);
    return;
  }
  await handlers[command.command](command as never);
}
const unavailable = async (command: string): Promise<void> => {
  throw new Error(`${command} orchestration is intentionally deferred beyond the Stage 1-4 substrate`);
};
export interface StatusSnapshot {
  sessionId: string;
  sessionStatus: "running" | "stopped";
  phase: Phase;
  branch: string;
  actualHead: string | null;
  expectedHead: string;
  baselineCommit: string;
  knownGoodCommit: string | null;
  pendingFailure: PendingFailure | null;
  lock: LockSnapshot;
  recentEvents: Array<{ sequence: number; type: string; timestamp: string }>;
  nextAction: string;
}
export async function readStatusSnapshot(repositoryPath: string): Promise<StatusSnapshot> {
  const repository = await GitRepository.open(repositoryPath);
  const store = new StateStore(repository.gitCommonDir);
  const state = await store.readState();
  if (normalizePath(state.repository.gitCommonDir) !== normalizePath(repository.gitCommonDir)) {
    throw new Error("state belongs to a different repository");
  }
  const events = await store.readEvents();
  return {
    sessionId: state.session.id,
    sessionStatus: state.session.status,
    phase: state.phase,
    branch: state.repository.branch,
    actualHead: await repository.branchHead(state.repository.branch),
    expectedHead: state.repository.expectedHead,
    baselineCommit: state.repository.baselineCommit,
    knownGoodCommit: state.health.knownGoodCommit,
    pendingFailure: state.health.pendingFailure,
    lock: await store.peekLock(),
    recentEvents: events.events.slice(-5).map((event) => ({
      sequence: event.sequence,
      type: event.type,
      timestamp: event.timestamp,
    })),
    nextAction: nextAction(state.phase),
  };
}
function nextAction(phase: Phase): string {
  if (phase === "smoke-checking") return "rerun smoke commands";
  if (phase === "deep-checking") return "rerun deep commands";
  if (phase === "checkpointing") return "reconcile checkpoint operation";
  if (phase === "rolling-back") return "reconcile rollback operation";
  if (phase === "agent-running") return "preserve interrupted work or resume agent";
  if (phase === "repairing") return "preserve interrupted repair or resume repair";
  if (phase === "diagnosing") return "restart diagnosis";
  if (phase === "stopped") return "remain stopped until run is invoked intentionally";
  return "continue from idle";
}
function normalizePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function renderStatus(snapshot: StatusSnapshot): string {
  return [
    `session: ${snapshot.sessionId} (${snapshot.sessionStatus})`,
    `phase: ${snapshot.phase}`,
    `branch: ${snapshot.branch}`,
    `actual head: ${snapshot.actualHead ?? "missing"}`,
    `expected head: ${snapshot.expectedHead}`,
    `baseline: ${snapshot.baselineCommit}`,
    `known-good: ${snapshot.knownGoodCommit ?? "none"}`,
    `pending failure: ${snapshot.pendingFailure?.id ?? "none"}`,
    `next: ${snapshot.nextAction}`,
  ].join("\n");
}
const defaultHandlers: CliHandlers = {
  init: async () => unavailable("init"),
  run: async (command) => {
    const controller = new AbortController();
    const interrupt = (): void => controller.abort(new Error("SIGINT"));
    const terminate = (): void => controller.abort(new Error("SIGTERM"));
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    try {
      const repository = await GitRepository.open(process.cwd());
      const result = await runNormalController({
        repository,
        gateway: new CodexAgentGateway(),
        limits: {
          ...(command.maxAgentTurns === undefined ? {} : { maxAgentTurns: command.maxAgentTurns }),
          ...(command.maxCheckpoints === undefined ? {} : { maxCheckpoints: command.maxCheckpoints }),
          ...(command.maxMinutes === undefined ? {} : { maxMinutes: command.maxMinutes }),
        },
        signal: controller.signal,
      });
      process.stdout.write(`recovery-loop stopped: ${String(result.summary.stopReason)}\nsummary: ${result.summaryPath}\n`);
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
  },
  status: async (command) => {
    const snapshot = await readStatusSnapshot(process.cwd());
    process.stdout.write(
      command.json ? `${JSON.stringify(snapshot, null, 2)}\n` : `${renderStatus(snapshot)}\n`,
    );
  },
  check: async () => unavailable("check"),
};
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    await dispatchCli(parseCli(argv), defaultHandlers);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`recovery-loop: ${message}\n`);
    return error instanceof CliUsageError ? 2 : 1;
  }
}
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main();
}
