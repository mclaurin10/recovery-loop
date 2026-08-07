import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_SCHEMA_VERSION,
  ValidationError,
  expectBoolean,
  expectExactKeys,
  expectNonEmptyString,
  expectObject,
  expectPositiveFiniteNumber,
  expectPositiveInteger,
  type CommandSpec,
} from "./contracts.js";
export interface PrepareConfig {
  argv: readonly string[];
  timeoutSeconds: number;
  triggerPaths: readonly string[];
}
export interface RecoveryConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  goalFile: string;
  branch: string;
  prepare: PrepareConfig | null;
  checks: {
    smoke: readonly CommandSpec[];
    deep: readonly CommandSpec[];
  };
  deepPolicy: {
    everyCheckpoints: number;
    maxMinutes: number;
    changedFileThreshold: number;
    changedLineThreshold: number;
    triggerPaths: readonly string[];
    beforeGoalComplete: boolean;
    afterRecovery: boolean;
  };
  limits: {
    maxAgentTurns: number;
    maxWallMinutes: number;
    maxRepairTurnsPerFailure: number;
    maxRecoveryCyclesPerSignature: number;
    maxLocalizationCommits: number;
    agentTurnSeconds: number;
  };
  protectedPaths: readonly string[];
  agent: {
    model: string;
    reasoningEffort: "low" | "medium" | "high" | "xhigh";
    networkAccess: false;
  };
}
const CONFIG_PATH = ".recovery-loop/config.json";
const CHECK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const WINDOWS_ABSOLUTE_PATTERN = /^[a-zA-Z]:[\\/]/;
export function validateRelativePath(value: unknown, valuePath: string): string {
  const candidate = expectNonEmptyString(value, valuePath);
  if (candidate.includes("\\")) {
    throw new ValidationError(valuePath, "must use forward slashes");
  }
  if (candidate.startsWith("/") || WINDOWS_ABSOLUTE_PATTERN.test(candidate)) {
    throw new ValidationError(valuePath, "must be relative");
  }
  const parts = candidate.split("/");
  const pathParts = candidate.endsWith("/") ? parts.slice(0, -1) : parts;
  if (pathParts.length === 0 || pathParts.some((part) => part === "" || part === "." || part === "..")) {
    throw new ValidationError(valuePath, "must be traversal-free and normalized");
  }
  return candidate;
}
function validateArgv(value: unknown, valuePath: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError(valuePath, "expected a non-empty argv array");
  }
  return value.map((argument, index) =>
    expectNonEmptyString(argument, `${valuePath}[${index}]`),
  );
}
function validateCommand(value: unknown, valuePath: string, deep: boolean): CommandSpec {
  const command = expectObject(value, valuePath);
  expectExactKeys(
    command,
    valuePath,
    ["id", "argv", "timeoutSeconds"],
    deep ? ["bisectable"] : [],
  );
  const id = expectNonEmptyString(command.id, `${valuePath}.id`);
  if (!CHECK_ID_PATTERN.test(id)) {
    throw new ValidationError(`${valuePath}.id`, "contains unsupported characters");
  }
  const base = {
    id,
    argv: validateArgv(command.argv, `${valuePath}.argv`),
    timeoutSeconds: expectPositiveFiniteNumber(command.timeoutSeconds, `${valuePath}.timeoutSeconds`),
  };
  if (deep && command.bisectable !== undefined) {
    return {
      ...base,
      bisectable: expectBoolean(command.bisectable, `${valuePath}.bisectable`),
    };
  }
  return base;
}
function validateCommandList(value: unknown, valuePath: string, deep: boolean): CommandSpec[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError(valuePath, "must contain at least one command");
  }
  return value.map((entry, index) => validateCommand(entry, `${valuePath}[${index}]`, deep));
}
function validatePathList(value: unknown, valuePath: string): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(valuePath, "expected an array");
  }
  const paths = value.map((entry, index) =>
    validateRelativePath(entry, `${valuePath}[${index}]`),
  );
  if (new Set(paths).size !== paths.length) {
    throw new ValidationError(valuePath, "contains duplicate paths");
  }
  return paths;
}
function validatePrepare(value: unknown): PrepareConfig | null {
  if (value === null || value === undefined) return null;
  const prepare = expectObject(value, "config.prepare");
  expectExactKeys(prepare, "config.prepare", ["argv", "timeoutSeconds", "triggerPaths"]);
  return {
    argv: validateArgv(prepare.argv, "config.prepare.argv"),
    timeoutSeconds: expectPositiveFiniteNumber(
      prepare.timeoutSeconds,
      "config.prepare.timeoutSeconds",
    ),
    triggerPaths: validatePathList(prepare.triggerPaths, "config.prepare.triggerPaths"),
  };
}
export function validateConfig(value: unknown): RecoveryConfig {
  const config = expectObject(value, "config");
  expectExactKeys(
    config,
    "config",
    [
      "schemaVersion",
      "goalFile",
      "branch",
      "checks",
      "deepPolicy",
      "limits",
      "protectedPaths",
      "agent",
    ],
    ["prepare"],
  );
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ValidationError(
      "config.schemaVersion",
      `unsupported schema version ${String(config.schemaVersion)}`,
    );
  }
  const goalFile = validateRelativePath(config.goalFile, "config.goalFile");
  if (goalFile.endsWith("/")) {
    throw new ValidationError("config.goalFile", "must identify a file");
  }
  const branch = expectNonEmptyString(config.branch, "config.branch");
  if (!branch.startsWith("recovery-loop/") || branch === "recovery-loop/") {
    throw new ValidationError("config.branch", "must start with recovery-loop/");
  }
  const checks = expectObject(config.checks, "config.checks");
  expectExactKeys(checks, "config.checks", ["smoke", "deep"]);
  const smoke = validateCommandList(checks.smoke, "config.checks.smoke", false);
  const deep = validateCommandList(checks.deep, "config.checks.deep", true);
  const allIds = [...smoke, ...deep].map((command) => command.id);
  if (new Set(allIds).size !== allIds.length) {
    throw new ValidationError("config.checks", "check IDs must be unique across smoke and deep");
  }
  const deepPolicy = expectObject(config.deepPolicy, "config.deepPolicy");
  expectExactKeys(deepPolicy, "config.deepPolicy", [
    "everyCheckpoints",
    "maxMinutes",
    "changedFileThreshold",
    "changedLineThreshold",
    "triggerPaths",
    "beforeGoalComplete",
    "afterRecovery",
  ]);
  const limits = expectObject(config.limits, "config.limits");
  expectExactKeys(limits, "config.limits", [
    "maxAgentTurns",
    "maxWallMinutes",
    "maxRepairTurnsPerFailure",
    "maxRecoveryCyclesPerSignature",
    "maxLocalizationCommits",
    "agentTurnSeconds",
  ]);
  const agent = expectObject(config.agent, "config.agent");
  expectExactKeys(agent, "config.agent", ["model", "reasoningEffort", "networkAccess"]);
  const networkAccess = expectBoolean(agent.networkAccess, "config.agent.networkAccess");
  if (networkAccess) {
    throw new ValidationError("config.agent.networkAccess", "must be false in v0.1");
  }
  const effort = expectNonEmptyString(agent.reasoningEffort, "config.agent.reasoningEffort");
  if (!["low", "medium", "high", "xhigh"].includes(effort)) {
    throw new ValidationError(
      "config.agent.reasoningEffort",
      "expected one of: low, medium, high, xhigh",
    );
  }
  const protectedPaths = validatePathList(config.protectedPaths, "config.protectedPaths");
  const completeProtectedPaths = [...new Set([...protectedPaths, goalFile, CONFIG_PATH])];
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    goalFile,
    branch,
    prepare: validatePrepare(config.prepare),
    checks: { smoke, deep },
    deepPolicy: {
      everyCheckpoints: expectPositiveInteger(
        deepPolicy.everyCheckpoints,
        "config.deepPolicy.everyCheckpoints",
      ),
      maxMinutes: expectPositiveInteger(deepPolicy.maxMinutes, "config.deepPolicy.maxMinutes"),
      changedFileThreshold: expectPositiveInteger(
        deepPolicy.changedFileThreshold,
        "config.deepPolicy.changedFileThreshold",
      ),
      changedLineThreshold: expectPositiveInteger(
        deepPolicy.changedLineThreshold,
        "config.deepPolicy.changedLineThreshold",
      ),
      triggerPaths: validatePathList(
        deepPolicy.triggerPaths,
        "config.deepPolicy.triggerPaths",
      ),
      beforeGoalComplete: expectBoolean(
        deepPolicy.beforeGoalComplete,
        "config.deepPolicy.beforeGoalComplete",
      ),
      afterRecovery: expectBoolean(
        deepPolicy.afterRecovery,
        "config.deepPolicy.afterRecovery",
      ),
    },
    limits: {
      maxAgentTurns: expectPositiveInteger(limits.maxAgentTurns, "config.limits.maxAgentTurns"),
      maxWallMinutes: expectPositiveInteger(limits.maxWallMinutes, "config.limits.maxWallMinutes"),
      maxRepairTurnsPerFailure: expectPositiveInteger(
        limits.maxRepairTurnsPerFailure,
        "config.limits.maxRepairTurnsPerFailure",
      ),
      maxRecoveryCyclesPerSignature: expectPositiveInteger(
        limits.maxRecoveryCyclesPerSignature,
        "config.limits.maxRecoveryCyclesPerSignature",
      ),
      maxLocalizationCommits: expectPositiveInteger(
        limits.maxLocalizationCommits,
        "config.limits.maxLocalizationCommits",
      ),
      agentTurnSeconds: expectPositiveInteger(
        limits.agentTurnSeconds,
        "config.limits.agentTurnSeconds",
      ),
    },
    protectedPaths: completeProtectedPaths,
    agent: {
      model: expectNonEmptyString(agent.model, "config.agent.model"),
      reasoningEffort: effort as RecoveryConfig["agent"]["reasoningEffort"],
      networkAccess: false,
    },
  };
}
export async function loadConfig(worktreePath: string): Promise<RecoveryConfig> {
  const configPath = path.join(worktreePath, ...CONFIG_PATH.split("/"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ValidationError(CONFIG_PATH, `invalid JSON: ${error.message}`);
    }
    throw error;
  }
  return validateConfig(parsed);
}
export const TRACKED_CONFIG_PATH = CONFIG_PATH;
export interface ScaffoldResult {
  created: string[];
}
export async function scaffoldContract(repositoryPath: string): Promise<ScaffoldResult> {
  const templateRoot = fileURLToPath(new URL("../templates/", import.meta.url));
  const targets = [
    { template: "RECOVERY_GOAL.md", relative: "RECOVERY_GOAL.md" },
    { template: "config.json", relative: CONFIG_PATH },
  ];
  const created: string[] = [];
  for (const target of targets) {
    const destination = path.join(repositoryPath, ...target.relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await writeFile(destination, await readFile(path.join(templateRoot, target.template)), {
        flag: "wx",
        mode: 0o600,
      });
      created.push(target.relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return { created };
}
