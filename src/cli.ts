#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import { CodexAgentGateway } from "./agent-gateway.js";
import { MAX_TIMER_MINUTES } from "./config.js";
import { runNormalController } from "./controller.js";
import { GitRepository } from "./git-repository.js";
import {
  CheckCommandFailed,
  checkRepository,
  initializeRepository,
  readStatusSnapshot,
  renderCheckResult,
  renderInitResult,
  renderRunSummary,
  renderStatus,
} from "./operator-surface.js";
export {
  CheckCommandFailed,
  checkRepository,
  initializeRepository,
  readStatusSnapshot,
  renderCheckResult,
  renderInitResult,
  renderRunSummary,
  renderStatus,
  type InitCommandOptions,
  type InitResult,
  type ManualCheckResult,
  type StatusCheckOutcome,
  type StatusSnapshot,
} from "./operator-surface.js";

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
function positiveInteger(value: string, flag: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new CliUsageError(`${flag} requires a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CliUsageError(`${flag} is too large`);
  if (parsed > maximum) throw new CliUsageError(`${flag} must be at most ${maximum}`);
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
    values[key] = positiveInteger(
      requireValue(argv, index, flag),
      flag,
      flag === "--max-minutes" ? MAX_TIMER_MINUTES : Number.MAX_SAFE_INTEGER,
    );
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
  if (topic === "init") {
    return [
      "Usage: recovery-loop init [--base <revision>] [--worktree <path>]",
      "",
      "Create the dedicated autonomous branch, worktree, and runtime state.",
      "If the tracked contract is missing, write RECOVERY_GOAL.md and",
      ".recovery-loop/config.json templates and exit without creating a branch.",
      "",
      "Options:",
      "  --base <revision>  Baseline commit (default: current HEAD)",
      "  --worktree <path>  Persistent worktree outside the operator checkout",
      "  --help             Show this help",
      "",
      "Initialization requires a clean checkout and runs prepare (when configured),",
      "smoke, and deep commands. A failing baseline is recorded without inventing a",
      "known-good anchor.",
    ].join("\n");
  }
  if (topic === "run") {
    return [
      "Usage: recovery-loop run [--max-agent-turns <n>] [--max-checkpoints <n>] [--max-minutes <n>]",
      "",
      "Start or resume the single-agent recovery loop. Nonempty agent work is",
      "checkpointed before project checks run; failures enter recovery.",
      "",
      "Options:",
      "  --max-agent-turns <n>  Cap coding-agent turns in the current durable session",
      "  --max-checkpoints <n>  Cap checkpoints in the current durable session",
      "  --max-minutes <n>      Cap wall time from the durable session start",
      "  --help                 Show this help",
      "",
      "Recovery Loop never pushes, merges into the operator branch, deploys, or",
      "publishes. The autonomous branch may be temporarily broken between checks and",
      "recovery.",
    ].join("\n");
  }
  if (topic === "status") {
    return [
      "Usage: recovery-loop status [--json]",
      "",
      "Read state, Git refs, lock ownership, command health, recovery history,",
      "budgets, and recent events without taking the controller lock or mutating files.",
      "",
      "Options:",
      "  --json  Emit one stable JSON snapshot instead of human-readable text",
      "  --help  Show this help",
    ].join("\n");
  }
  if (topic === "check") {
    return [
      "Usage: recovery-loop check [--deep]",
      "",
      "Run configured commands at the exact autonomous branch head without invoking",
      "the coding agent. Smoke commands run by default; --deep runs complete smoke",
      "and deep sets and advances known-good only on a full exact-head pass.",
      "",
      "Options:",
      "  --deep  Run complete smoke and deep command sets",
      "  --help  Show this help",
    ].join("\n");
  }
  return [
    "Usage: recovery-loop <command> [options]",
    "",
    "A local, recovery-first controller for one coding agent on an isolated branch.",
    "Checkpoints are provisional recovery points, not approval or correctness claims.",
    "",
    "Commands:",
    "  init     Scaffold or create the dedicated recovery workspace",
    "  run      Start or resume autonomous work",
    "  status   Inspect current state without mutation",
    "  check    Run configured checks without invoking an agent",
    "",
    "Run 'recovery-loop <command> --help' for command details.",
    "Recovery Loop never pushes, merges, deploys, publishes, or contacts project",
    "services. Running the coding agent uses the configured model provider.",
  ].join("\n");
}
export async function dispatchCli(command: ParsedCommand, handlers: CliHandlers): Promise<void> {
  if (command.command === "help") {
    process.stdout.write(`${helpText(command.topic)}\n`);
    return;
  }
  await handlers[command.command](command as never);
}

const defaultHandlers: CliHandlers = {
  init: async (command) => {
    process.stdout.write(`${renderInitResult(await initializeRepository(process.cwd(), command))}\n`);
  },
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
      process.stdout.write(`${renderRunSummary(result.summary)}\nsummary file: ${result.summaryPath}\n`);
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
  check: async (command) => {
    const result = await checkRepository(process.cwd(), command.deep);
    process.stdout.write(`${renderCheckResult(result)}\n`);
    if (!result.requestedChecksPassed) throw new CheckCommandFailed();
  },
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
