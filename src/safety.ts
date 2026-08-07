import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { CommandClassification } from "./contracts.js";
import type { GitRepository } from "./git-repository.js";
const SENSITIVE_PATTERNS = [
  { label: "private-key", expression: /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----[\s\S]*?-----END (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/giu },
  { label: "private-key", expression: /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----/giu },
  { label: "aws-access-key", expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu },
  { label: "github-token", expression: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/gu },
  { label: "github-token", expression: /\bgithub_pat_[A-Za-z0-9_]{40,255}\b/gu },
  { label: "gitlab-token", expression: /\bglpat-[A-Za-z0-9_-]{20,255}\b/gu },
  { label: "slack-token", expression: /\bxox[baprs]-[A-Za-z0-9-]{20,255}\b/gu },
  { label: "stripe-live-key", expression: /\b[rs]k_live_[A-Za-z0-9]{20,255}\b/gu },
  { label: "openai-key", expression: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,255}\b/gu },
  { label: "credential-url", expression: /\b(?:https?|postgres(?:ql)?|mysql):\/\/[^\s/:@]{1,128}:[^\s/@]{8,256}@/giu },
] as const;
export interface SensitiveMatch { label: string; excerpt: string }
export function findSensitiveMaterial(text: string): SensitiveMatch[] {
  const matches: SensitiveMatch[] = [];
  for (const pattern of SENSITIVE_PATTERNS) for (const match of text.matchAll(pattern.expression)) {
    const value = match[0];
    if (value !== undefined) matches.push({ label: pattern.label, excerpt: value.slice(0, 20) });
  }
  return matches;
}
export function redact(text: string, additionalSecrets: readonly string[] = []): string {
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) result = result.replace(pattern.expression, `[REDACTED ${pattern.label.toUpperCase()}]`);
  for (const secret of additionalSecrets) if (secret.length >= 4) result = result.replaceAll(secret, "[REDACTED]");
  return result;
}
export class ByteTail {
  readonly maximumBytes: number;
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  constructor(maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) throw new Error("tail size must be a positive integer");
    this.maximumBytes = maximumBytes;
  }
  append(chunk: Buffer | string): void {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (incoming.length >= this.maximumBytes) this.#buffer = incoming.subarray(-this.maximumBytes);
    else {
      const combined = Buffer.concat([this.#buffer, incoming]);
      this.#buffer = combined.length > this.maximumBytes ? combined.subarray(-this.maximumBytes) : combined;
    }
  }
  text(): string { return this.#buffer.toString("utf8"); }
}
export function boundedRedactedTail(tail: ByteTail, additionalSecrets: readonly string[] = []): string {
  return redact(tail.text(), additionalSecrets);
}
export function normalizeDiagnostic(text: string, variablePaths: readonly string[] = []): string {
  let normalized = redact(text);
  for (const variablePath of [...variablePaths].sort((a, b) => b.length - a.length)) {
    if (variablePath.length > 0) normalized = normalized.replaceAll(variablePath, "<PATH>");
  }
  return normalized.replaceAll(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu, "<TIME>")
    .replaceAll(/\b(?:pid|process)[=:# ]+\d+\b/giu, "pid=<PID>")
    .replaceAll(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s:'"]+[\\/])*(?:tmp|temp)[\\/][^\s:'"]+/giu, "<TEMP_PATH>")
    .replaceAll(/\s+/gu, " ").trim();
}
export function commandSignature(input: {
  checkId: string; classification: CommandClassification; exitCode: number | null;
  signal: NodeJS.Signals | null; stdoutTail: string; stderrTail: string;
  variablePaths?: readonly string[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    checkId: input.checkId, classification: input.classification, exitCode: input.exitCode,
    signal: input.signal, stdout: normalizeDiagnostic(input.stdoutTail, input.variablePaths),
    stderr: normalizeDiagnostic(input.stderrTail, input.variablePaths),
  })).digest("hex");
}
export type SafetyViolationCode =
  | "branch-identity"
  | "unexpected-head"
  | "git-operation"
  | "protected-path"
  | "unsafe-path"
  | "symlink"
  | "gitlink"
  | "runtime-content"
  | "sensitive-material"
  | "unscannable-file"
  | "persistence";
export interface SafetyViolation {
  code: SafetyViolationCode;
  message: string;
  path: string | null;
}
export interface SafetyGuardResult {
  safe: boolean;
  violations: SafetyViolation[];
}
export interface SafetyGuardOptions {
  expectedBranch: string;
  expectedBase: string;
  protectedPaths: readonly string[];
  expectedWorktreePath?: string;
  maximumScanBytes?: number;
}
export class SafetyGuardError extends Error {
  readonly violations: readonly SafetyViolation[];
  constructor(violations: readonly SafetyViolation[]) {
    super(`checkpoint guard rejected changes: ${violations.map((item) => item.message).join("; ")}`);
    this.name = "SafetyGuardError";
    this.violations = violations;
  }
}
const GIT_OPERATION_PATHS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "rebase-apply",
  "rebase-merge",
  "sequencer",
] as const;
const RUNTIME_PATHS = [
  ".git",
  ".recovery-loop/state.json",
  ".recovery-loop/controller.lock",
  ".recovery-loop/events.jsonl",
  ".recovery-loop/runs/",
  ".recovery-loop/diagnostic-worktree/",
] as const;
export async function runSafetyGuard(
  repository: GitRepository,
  options: SafetyGuardOptions,
): Promise<SafetyGuardResult> {
  const violations: SafetyViolation[] = [];
  const currentBranch = await repository.currentBranch();
  const head = await repository.head();
  const branchHead = await repository.branchHead(options.expectedBranch);
  if (currentBranch !== options.expectedBranch || branchHead !== head) {
    violations.push({
      code: "branch-identity",
      message: `expected checked-out branch ${options.expectedBranch}`,
      path: null,
    });
  }
  if (head !== options.expectedBase) {
    violations.push({
      code: "unexpected-head",
      message: `expected checkpoint base ${options.expectedBase}, found ${head}`,
      path: null,
    });
  }
  if (
    options.expectedWorktreePath !== undefined &&
    !pathsEqual(repository.repositoryRoot, options.expectedWorktreePath)
  ) {
    violations.push({
      code: "branch-identity",
      message: `worktree identity mismatch: ${repository.repositoryRoot}`,
      path: null,
    });
  }
  for (const operationPath of GIT_OPERATION_PATHS) {
    const rawPath = (await repository.git(["rev-parse", "--git-path", operationPath])).stdout.trim();
    const absolute = path.isAbsolute(rawPath) ? rawPath : path.join(repository.repositoryRoot, rawPath);
    if (await exists(absolute)) {
      violations.push({
        code: "git-operation",
        message: `unexplained Git operation metadata exists: ${operationPath}`,
        path: operationPath,
      });
    }
  }
  const changes = await repository.changedPaths(true);
  const protectedPaths = new Set(options.protectedPaths);
  for (const change of changes) {
    for (const changedName of [change.path, change.originalPath].filter(
      (value): value is string => value !== null,
    )) {
      if (!isContainedRelativePath(changedName, repository.repositoryRoot)) {
        violations.push({
          code: "unsafe-path",
          message: `changed path escapes the worktree: ${changedName}`,
          path: changedName,
        });
      }
      if (matchesProtectedPath(changedName, protectedPaths)) {
        violations.push({
          code: "protected-path",
          message: `protected authority file changed: ${changedName}`,
          path: changedName,
        });
      }
      if (RUNTIME_PATHS.some((runtimePath) => pathRuleMatches(changedName, runtimePath))) {
        violations.push({
          code: "runtime-content",
          message: `runtime state must not be checkpointed: ${changedName}`,
          path: changedName,
        });
      }
    }
  }
  for (const mode of await repository.unsafeModeChanges(options.expectedBase)) {
    violations.push({
      code: mode.kind,
      message: `changed ${mode.kind} is not allowed: ${mode.path}`,
      path: mode.path,
    });
  }
  const maximumScanBytes = options.maximumScanBytes ?? 10 * 1024 * 1024;
  for (const change of changes) {
    if (!isContainedRelativePath(change.path, repository.repositoryRoot)) continue;
    const absolute = path.join(repository.repositoryRoot, ...change.path.split("/"));
    let metadata;
    try {
      metadata = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      violations.push({
        code: "unscannable-file",
        message: `cannot inspect changed file ${change.path}`,
        path: change.path,
      });
      continue;
    }
    if (!metadata.isFile()) continue;
    if (metadata.size > maximumScanBytes) {
      violations.push({
        code: "unscannable-file",
        message: `changed file exceeds the safety scan limit: ${change.path}`,
        path: change.path,
      });
      continue;
    }
    let proposedText: string;
    if (!change.tracked) {
      const contents = await readFile(absolute);
      if (contents.includes(0)) continue;
      proposedText = contents.toString("utf8");
    } else {
      const diff = (
        await repository.git([
          "diff",
          "--no-ext-diff",
          "--unified=0",
          options.expectedBase,
          "--",
          change.path,
        ])
      ).stdout;
      proposedText = diff
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .map((line) => line.slice(1))
        .join("\n");
    }
    const sensitive = findSensitiveMaterial(proposedText);
    for (const match of sensitive) {
      violations.push({
        code: "sensitive-material",
        message: `high-confidence ${match.label} detected in ${change.path}`,
        path: change.path,
      });
    }
  }
  try {
    await access(repository.gitCommonDir, fsConstants.W_OK);
  } catch {
    violations.push({
      code: "persistence",
      message: `Git common directory is not writable: ${repository.gitCommonDir}`,
      path: null,
    });
  }
  return { safe: violations.length === 0, violations: deduplicate(violations) };
}
export async function assertCheckpointSafe(
  repository: GitRepository,
  options: SafetyGuardOptions,
): Promise<void> {
  const result = await runSafetyGuard(repository, options);
  if (!result.safe) throw new SafetyGuardError(result.violations);
}
function matchesProtectedPath(candidate: string, protectedPaths: ReadonlySet<string>): boolean {
  for (const protectedPath of protectedPaths) {
    if (pathRuleMatches(candidate, protectedPath)) return true;
  }
  return false;
}
function pathRuleMatches(candidate: string, rule: string): boolean {
  if (rule.endsWith("/")) return candidate.startsWith(rule);
  return candidate === rule;
}
function isContainedRelativePath(candidate: string, worktree: string): boolean {
  if (candidate.includes("\0") || path.isAbsolute(candidate)) return false;
  const absolute = path.resolve(worktree, ...candidate.split("/"));
  const relative = path.relative(path.resolve(worktree), absolute);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function pathsEqual(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function deduplicate(violations: readonly SafetyViolation[]): SafetyViolation[] {
  const seen = new Set<string>();
  return violations.filter((violation) => {
    const key = `${violation.code}:${violation.path ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
