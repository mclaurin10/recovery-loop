import { spawn } from "node:child_process";
import { access, lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import type { CheckpointKind } from "./contracts.js";
interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
interface RunGitOptions {
  input?: string;
  environment?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
}
const UNSAFE_GIT_ENVIRONMENT = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG_COUNT",
]);
export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;
  constructor(args: readonly string[], result: GitResult) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    super(`git ${args.join(" ")} failed: ${detail}`);
    this.name = "GitCommandError";
    this.args = args;
    this.exitCode = result.exitCode;
    this.stderr = result.stderr;
  }
}
export class CanonicalityError extends Error {
  readonly expectedBase: string;
  readonly actualHead: string;
  constructor(expectedBase: string, actualHead: string, detail: string) {
    super(`canonical branch ambiguity: ${detail}; expected base ${expectedBase}, actual head ${actualHead}`);
    this.name = "CanonicalityError";
    this.expectedBase = expectedBase;
    this.actualHead = actualHead;
  }
}
export class WorkspaceExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceExistsError";
  }
}
async function runGitAt(
  repositoryPath: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repositoryPath, ...args], {
      shell: false,
      windowsHide: true,
      env: gitEnvironment(options.environment),
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: exitCode ?? 1,
      };
      if (result.exitCode !== 0 && options.allowFailure !== true) {
        reject(new GitCommandError(args, result));
      } else {
        resolve(result);
      }
    });
    if (options.input !== undefined) child.stdin!.end(options.input);
  });
}
function gitEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase();
    if (
      value !== undefined &&
      !UNSAFE_GIT_ENVIRONMENT.has(upper) &&
      !upper.startsWith("GIT_CONFIG_KEY_") &&
      !upper.startsWith("GIT_CONFIG_VALUE_")
    ) {
      environment[name] = value;
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    const upper = name.toUpperCase();
    if (
      UNSAFE_GIT_ENVIRONMENT.has(upper) ||
      upper.startsWith("GIT_CONFIG_KEY_") ||
      upper.startsWith("GIT_CONFIG_VALUE_")
    ) {
      throw new Error(`unsafe Git environment override: ${name}`);
    }
    if (value !== undefined) environment[name] = value;
  }
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}
function normalizeAbsolute(candidate: string): string {
  return path.normalize(path.resolve(candidate));
}
function samePath(left: string, right: string): boolean {
  const a = normalizeAbsolute(left);
  const b = normalizeAbsolute(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function trimLine(output: string): string {
  return output.trimEnd().split(/\r?\n/u).at(-1) ?? "";
}
function safeRelativePath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.includes("\0") || path.isAbsolute(candidate)) return false;
  const normalized = candidate.replaceAll("\\", "/");
  return !normalized.split("/").some((part) => part === ".." || part === "");
}
export interface RepositoryIdentity {
  repositoryRoot: string;
  gitCommonDir: string;
  bare: boolean;
}
export interface ChangedPath {
  path: string;
  status: string;
  originalPath: string | null;
  tracked: boolean;
}
export interface ChangeStatistics {
  files: number;
  additions: number;
  deletions: number;
  binaryFiles: number;
}
export interface UnsafeModeChange {
  path: string;
  kind: "symlink" | "gitlink";
  oldMode: string | null;
  newMode: string | null;
}
export interface CheckpointRequest {
  branch: string;
  expectedBase: string;
  summary: string;
  sessionId: string;
  unitId: string;
  kind: CheckpointKind;
  normalizationRescueRef?: string;
  guard?: () => Promise<void>;
  afterNormalizationRescueVerified?: () => void | Promise<void>;
}
export interface CheckpointResult {
  commit: string;
  previousHead: string;
  normalizedAgentHead: string | null;
  rescueRef: string | null;
  statistics: ChangeStatistics;
}
export interface RollbackHooks {
  afterRescueVerified?: () => void | Promise<void>;
  afterReset?: () => void | Promise<void>;
}
export interface RollbackResult {
  oldHead: string;
  targetCommit: string;
  rescueRef: string;
}
export interface RevertResult {
  commit: string;
  revertedCommit: string;
}
const CONTROLLER_ENVIRONMENT: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "Recovery Loop",
  GIT_AUTHOR_EMAIL: "recovery-loop@localhost",
  GIT_COMMITTER_NAME: "Recovery Loop",
  GIT_COMMITTER_EMAIL: "recovery-loop@localhost",
};
export class GitRepository {
  readonly repositoryRoot: string;
  readonly gitCommonDir: string;
  private constructor(identity: RepositoryIdentity) {
    this.repositoryRoot = identity.repositoryRoot;
    this.gitCommonDir = identity.gitCommonDir;
  }
  static async inspect(repositoryPath: string): Promise<RepositoryIdentity> {
    const requested = normalizeAbsolute(repositoryPath);
    const bareResult = await runGitAt(requested, ["rev-parse", "--is-bare-repository"]);
    const bare = trimLine(bareResult.stdout) === "true";
    if (bare) {
      const common = trimLine(
        (await runGitAt(requested, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
          .stdout,
      );
      return { repositoryRoot: requested, gitCommonDir: normalizeAbsolute(common), bare };
    }
    const root = trimLine((await runGitAt(requested, ["rev-parse", "--show-toplevel"])).stdout);
    const common = trimLine(
      (await runGitAt(requested, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout,
    );
    return {
      repositoryRoot: normalizeAbsolute(root),
      gitCommonDir: normalizeAbsolute(common),
      bare,
    };
  }
  static async open(repositoryPath: string): Promise<GitRepository> {
    const identity = await GitRepository.inspect(repositoryPath);
    if (identity.bare) throw new Error("Recovery Loop requires a non-bare Git repository");
    return new GitRepository(identity);
  }
  async git(args: readonly string[], options?: RunGitOptions): Promise<GitResult> {
    return runGitAt(this.repositoryRoot, args, options);
  }
  async head(): Promise<string> {
    return trimLine((await this.git(["rev-parse", "HEAD"])).stdout);
  }
  async resolveCommit(revision: string): Promise<string> {
    return trimLine((await this.git(["rev-parse", "--verify", `${revision}^{commit}`])).stdout);
  }
  async currentBranch(): Promise<string | null> {
    const result = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      allowFailure: true,
    });
    return result.exitCode === 0 ? trimLine(result.stdout) : null;
  }
  async branchHead(branch: string): Promise<string | null> {
    const result = await this.git(["show-ref", "--verify", "--hash", `refs/heads/${branch}`], {
      allowFailure: true,
    });
    return result.exitCode === 0 ? trimLine(result.stdout) : null;
  }
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.git(["merge-base", "--is-ancestor", ancestor, descendant], {
      allowFailure: true,
    });
    if (result.exitCode !== 0 && result.exitCode !== 1) throw new GitCommandError([], result);
    return result.exitCode === 0;
  }
  async commitCount(range: string): Promise<number> {
    const output = trimLine((await this.git(["rev-list", "--count", range])).stdout);
    return Number.parseInt(output, 10);
  }
  async commitMessage(commit = "HEAD"): Promise<string> {
    return (await this.git(["show", "-s", "--format=%B", commit])).stdout;
  }
  async isControllerAuthoredCommit(commit = "HEAD"): Promise<boolean> {
    const identity = (
      await this.git(["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", commit])
    ).stdout.trimEnd().split("\0");
    return identity.length === 4 &&
      identity[0] === CONTROLLER_ENVIRONMENT.GIT_AUTHOR_NAME &&
      identity[1] === CONTROLLER_ENVIRONMENT.GIT_AUTHOR_EMAIL &&
      identity[2] === CONTROLLER_ENVIRONMENT.GIT_COMMITTER_NAME &&
      identity[3] === CONTROLLER_ENVIRONMENT.GIT_COMMITTER_EMAIL;
  }
  async ensureClean(includeUntracked = true): Promise<void> {
    const changes = await this.changedPaths(includeUntracked);
    if (changes.length > 0) {
      throw new Error(`worktree is not clean: ${changes.map((entry) => entry.path).join(", ")}`);
    }
  }
  async changedPaths(includeUntracked = true): Promise<ChangedPath[]> {
    const result = await this.git([
      "status",
      "--porcelain=v1",
      "-z",
      includeUntracked ? "--untracked-files=all" : "--untracked-files=no",
    ]);
    const records = result.stdout.split("\0");
    const changes: ChangedPath[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record === undefined || record.length < 4) continue;
      const status = record.slice(0, 2);
      const candidate = record.slice(3);
      let originalPath: string | null = null;
      if (status.includes("R") || status.includes("C")) {
        originalPath = records[index + 1] ?? null;
        index += 1;
      }
      if (!safeRelativePath(candidate)) {
        throw new CanonicalityError(await this.head(), await this.head(), `unsafe status path ${candidate}`);
      }
      changes.push({ path: candidate, status, originalPath, tracked: status !== "??" });
    }
    return changes;
  }
  async hasTrackedChanges(): Promise<boolean> {
    return (await this.changedPaths(false)).length > 0;
  }
  async changeStatistics(base = "HEAD", target?: string): Promise<ChangeStatistics> {
    const args = ["diff", "--numstat", base];
    if (target !== undefined) args.push(target);
    const result = await this.git(args);
    const paths = new Set<string>();
    let additions = 0;
    let deletions = 0;
    let binaryFiles = 0;
    for (const line of result.stdout.split(/\r?\n/u)) {
      if (line.length === 0) continue;
      const [added, deleted, ...nameParts] = line.split("\t");
      const name = nameParts.join("\t");
      if (added === undefined || deleted === undefined || name.length === 0) continue;
      paths.add(name);
      if (added === "-" || deleted === "-") {
        binaryFiles += 1;
      } else {
        additions += Number.parseInt(added, 10);
        deletions += Number.parseInt(deleted, 10);
      }
    }
    if (target === undefined) {
      for (const change of await this.changedPaths(true)) {
        if (change.tracked || paths.has(change.path)) continue;
        paths.add(change.path);
        const absolute = path.join(this.repositoryRoot, ...change.path.split("/"));
        const metadata = await lstat(absolute);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          binaryFiles += 1;
          continue;
        }
        const contents = await readFile(absolute);
        if (contents.includes(0)) {
          binaryFiles += 1;
        } else {
          additions += contents.length === 0 ? 0 : contents.toString("utf8").split(/\r?\n/u).length;
        }
      }
    }
    return { files: paths.size, additions, deletions, binaryFiles };
  }
  async changedPathsBetween(base: string, target: string): Promise<string[]> {
    const result = await this.git(["diff", "--name-only", "--no-renames", "-z", base, target]);
    return [...new Set(result.stdout.split("\0").filter((entry) => entry.length > 0))].sort();
  }
  async firstParent(commit: string): Promise<string | null> {
    const result = await this.git(["rev-parse", "--verify", `${commit}^1`], {
      allowFailure: true,
    });
    return result.exitCode === 0 ? trimLine(result.stdout) : null;
  }
  async firstParentChain(ancestor: string, descendant: string): Promise<string[]> {
    if (!(await this.isAncestor(ancestor, descendant))) {
      throw new CanonicalityError(ancestor, descendant, "localization anchor is not an ancestor");
    }
    const output = (await this.git([
      "rev-list", "--first-parent", "--reverse", `${ancestor}..${descendant}`,
    ])).stdout;
    const commits = output.split(/\r?\n/u).filter((entry) => entry.length > 0);
    if (commits.at(-1) !== descendant && ancestor !== descendant) {
      throw new CanonicalityError(ancestor, descendant, "first-parent history did not reach head");
    }
    return [ancestor, ...commits];
  }
  async hasMergeOnFirstParent(ancestor: string, descendant: string): Promise<boolean> {
    const output = (await this.git([
      "rev-list", "--first-parent", "--parents", `${ancestor}..${descendant}`,
    ])).stdout;
    return output.split(/\r?\n/u).some((line) => line.trim().split(/\s+/u).length > 2);
  }
  async commitDiff(commit: string): Promise<string> {
    const parent = await this.firstParent(commit);
    if (parent === null) return (await this.git(["show", "--no-color", "--format=fuller", commit])).stdout;
    return (await this.git([
      "diff", "--no-ext-diff", "--no-color", "--find-renames", parent, commit,
    ])).stdout;
  }
  async unsafeModeChanges(base = "HEAD"): Promise<UnsafeModeChange[]> {
    const unsafe: UnsafeModeChange[] = [];
    for (const change of await this.changedPaths(true)) {
      const oldMode = await this.modeAt(base, change.path);
      const indexMode = await this.indexMode(change.path);
      let worktreeSymlink = false;
      try {
        worktreeSymlink = (await lstat(path.join(this.repositoryRoot, ...change.path.split("/")))).isSymbolicLink();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const newMode = worktreeSymlink ? "120000" : indexMode;
      const modes = [oldMode, newMode];
      if (modes.includes("160000")) {
        unsafe.push({ path: change.path, kind: "gitlink", oldMode, newMode });
      } else if (modes.includes("120000")) {
        unsafe.push({ path: change.path, kind: "symlink", oldMode, newMode });
      }
    }
    return unsafe;
  }
  async unsafeModeChangesBetween(base: string, target: string): Promise<UnsafeModeChange[]> {
    const unsafe: UnsafeModeChange[] = [];
    for (const changedPath of await this.changedPathsBetween(base, target)) {
      const oldMode = await this.modeAt(base, changedPath);
      const newMode = await this.modeAt(target, changedPath);
      const modes = [oldMode, newMode];
      if (modes.includes("160000")) {
        unsafe.push({ path: changedPath, kind: "gitlink", oldMode, newMode });
      } else if (modes.includes("120000")) {
        unsafe.push({ path: changedPath, kind: "symlink", oldMode, newMode });
      }
    }
    return unsafe;
  }
  private async modeAt(revision: string, filePath: string): Promise<string | null> {
    const result = await this.git(["ls-tree", revision, "--", filePath], { allowFailure: true });
    const match = /^(\d{6})\s/u.exec(result.stdout);
    return match?.[1] ?? null;
  }
  private async indexMode(filePath: string): Promise<string | null> {
    const result = await this.git(["ls-files", "-s", "--", filePath]);
    const match = /^(\d{6})\s/u.exec(result.stdout);
    return match?.[1] ?? null;
  }
  async createAutonomousWorktree(options: {
    baseline?: string;
    branch: string;
    worktreePath: string;
    requireTrackedContract?: boolean;
    hooks?: {
      afterBranchCreated?: () => void | Promise<void>;
      afterWorktreeCreated?: () => void | Promise<void>;
    };
  }): Promise<{ baselineCommit: string; worktree: GitRepository }> {
    const baselineCommit = await this.preflightAutonomousWorktree(options);
    const operatorBranch = await this.currentBranch();
    const operatorHead = await this.head();
    await this.git(["branch", options.branch, baselineCommit]);
    await options.hooks?.afterBranchCreated?.();
    await this.git(["worktree", "add", options.worktreePath, options.branch]);
    await options.hooks?.afterWorktreeCreated?.();
    if ((await this.currentBranch()) !== operatorBranch || (await this.head()) !== operatorHead) {
      throw new CanonicalityError(operatorHead, await this.head(), "operator checkout changed during initialization");
    }
    return { baselineCommit, worktree: await GitRepository.open(options.worktreePath) };
  }
  async preflightAutonomousWorktree(options: {
    baseline?: string;
    branch: string;
    worktreePath: string;
    requireTrackedContract?: boolean;
  }): Promise<string> {
    await this.ensureClean(true);
    if (!options.branch.startsWith("recovery-loop/") || options.branch === "recovery-loop/") {
      throw new Error("autonomous branch must start with recovery-loop/");
    }
    await this.git(["check-ref-format", `refs/heads/${options.branch}`]);
    const resolvedWorktree = path.resolve(options.worktreePath);
    if (
      isPathWithin(resolvedWorktree, this.repositoryRoot) ||
      isPathWithin(resolvedWorktree, this.gitCommonDir)
    ) {
      throw new Error("autonomous worktree must be outside the operator checkout and Git common directory");
    }
    const baselineCommit = await this.resolveCommit(options.baseline ?? "HEAD");
    if ((await this.branchHead(options.branch)) !== null) {
      throw new WorkspaceExistsError(`branch already exists: ${options.branch}`);
    }
    try {
      await access(options.worktreePath);
      throw new WorkspaceExistsError(`worktree path already exists: ${options.worktreePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (options.requireTrackedContract !== false) {
      for (const required of ["RECOVERY_GOAL.md", ".recovery-loop/config.json"]) {
        const tracked = await this.git(["cat-file", "-e", `${baselineCommit}:${required}`], {
          allowFailure: true,
        });
        if (tracked.exitCode !== 0) {
          throw new Error(`${required} must be tracked at baseline ${baselineCommit}`);
        }
      }
    }
    return baselineCommit;
  }
  async recreatePersistentWorktree(branch: string, worktreePath: string): Promise<GitRepository> {
    if ((await this.branchHead(branch)) === null) throw new Error(`branch does not exist: ${branch}`);
    if (
      isPathWithin(path.resolve(worktreePath), this.repositoryRoot) ||
      isPathWithin(path.resolve(worktreePath), this.gitCommonDir)
    ) {
      throw new Error("persistent worktree must be outside the operator checkout and Git common directory");
    }
    try {
      await stat(worktreePath);
      throw new WorkspaceExistsError(`worktree path already exists: ${worktreePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.git(["worktree", "prune"]);
    await this.git(["worktree", "add", worktreePath, branch]);
    return GitRepository.open(worktreePath);
  }
  async assertBranchIdentity(branch: string): Promise<string> {
    const current = await this.currentBranch();
    const head = await this.head();
    const branchHead = await this.branchHead(branch);
    if (current !== branch || branchHead !== head) {
      throw new CanonicalityError(branchHead ?? head, head, `expected checked-out branch ${branch}`);
    }
    return head;
  }
  async createRescueRef(refName: string, commit: string): Promise<void> {
    if (!refName.startsWith("recovery-loop/rescue/")) {
      throw new Error(`rescue ref must start with recovery-loop/rescue/: ${refName}`);
    }
    await this.git(["check-ref-format", `refs/heads/${refName}`]);
    if ((await this.branchHead(refName)) !== null) throw new Error(`rescue ref already exists: ${refName}`);
    await this.git(["update-ref", `refs/heads/${refName}`, commit]);
    const resolved = await this.branchHead(refName);
    if (resolved !== commit) {
      throw new CanonicalityError(commit, resolved ?? "missing", `rescue ref ${refName} failed verification`);
    }
  }
  async checkpoint(request: CheckpointRequest): Promise<CheckpointResult | null> {
    let actualHead = await this.assertBranchIdentity(request.branch);
    let normalizedAgentHead: string | null = null;
    let rescueRef: string | null = null;
    if (actualHead !== request.expectedBase) {
      if (!(await this.isAncestor(request.expectedBase, actualHead))) {
        throw new CanonicalityError(
          request.expectedBase,
          actualHead,
          "autonomous branch moved to a non-descendant",
        );
      }
      normalizedAgentHead = actualHead;
      rescueRef =
        request.normalizationRescueRef ??
        `recovery-loop/rescue/${request.sessionId}-${request.unitId}-agent-history`;
      const existingRescue = await this.branchHead(rescueRef);
      if (existingRescue === null) {
        await this.createRescueRef(rescueRef, actualHead);
      } else if (existingRescue !== actualHead) {
        throw new CanonicalityError(actualHead, existingRescue, "normalization rescue ref points elsewhere");
      }
      await request.afterNormalizationRescueVerified?.();
      await this.git(["reset", "--soft", request.expectedBase]);
      actualHead = await this.head();
      if (actualHead !== request.expectedBase) {
        throw new CanonicalityError(request.expectedBase, actualHead, "soft reset did not restore turn base");
      }
    }
    await request.guard?.();
    await this.git(["add", "-A"]);
    const staged = await this.git(["diff", "--cached", "--quiet"], { allowFailure: true });
    if (staged.exitCode === 0) return null;
    if (staged.exitCode !== 1) throw new GitCommandError(["diff", "--cached", "--quiet"], staged);
    const message = checkpointMessage(request);
    await this.commit(message);
    const commit = await this.head();
    const parents = trimLine((await this.git(["rev-list", "--parents", "-n", "1", commit])).stdout)
      .split(" ")
      .slice(1);
    if (parents.length !== 1 || parents[0] !== request.expectedBase) {
      throw new CanonicalityError(request.expectedBase, commit, "checkpoint is not one linear controller commit");
    }
    return {
      commit,
      previousHead: request.expectedBase,
      normalizedAgentHead,
      rescueRef,
      statistics: await this.changeStatistics(request.expectedBase, commit),
    };
  }
  private async commit(message: string): Promise<void> {
    const hooksPath = path.join(this.gitCommonDir, "recovery-loop", "empty-hooks");
    await mkdir(hooksPath, { recursive: true });
    await this.git(
      ["-c", `core.hooksPath=${hooksPath}`, "-c", "commit.gpgSign=false", "commit", "--no-verify", "-m", message],
      { environment: CONTROLLER_ENVIRONMENT },
    );
  }
  async cleanRevert(options: {
    branch: string;
    expectedHead: string;
    targetCommit: string;
    sessionId: string;
    unitId: string;
  }): Promise<RevertResult | null> {
    const actual = await this.assertBranchIdentity(options.branch);
    if (actual !== options.expectedHead) {
      throw new CanonicalityError(options.expectedHead, actual, "head moved before revert");
    }
    if (!(await this.isAncestor(options.targetCommit, actual))) {
      throw new CanonicalityError(options.targetCommit, actual, "revert target is not on active history");
    }
    const revert = await this.git(["revert", "--no-commit", options.targetCommit], {
      allowFailure: true,
      environment: CONTROLLER_ENVIRONMENT,
    });
    if (revert.exitCode !== 0) {
      await this.git(["revert", "--abort"], { allowFailure: true });
      if (await this.hasTrackedChanges()) {
        await this.git(["reset", "--merge", "HEAD"]);
      }
      return null;
    }
    const staged = await this.git(["diff", "--cached", "--quiet"], { allowFailure: true });
    if (staged.exitCode === 0) return null;
    await this.commit(
      checkpointMessage({
        summary: `revert ${options.targetCommit.slice(0, 12)}`,
        sessionId: options.sessionId,
        unitId: options.unitId,
        kind: "revert",
      }),
    );
    return { commit: await this.head(), revertedCommit: options.targetCommit };
  }
  async hardRollback(options: {
    branch: string;
    expectedHead: string;
    targetCommit: string;
    rescueRef: string;
    hooks?: RollbackHooks;
  }): Promise<RollbackResult> {
    const actual = await this.assertBranchIdentity(options.branch);
    if (actual !== options.expectedHead) {
      throw new CanonicalityError(options.expectedHead, actual, "head moved before rollback");
    }
    if (!(await this.isAncestor(options.targetCommit, actual))) {
      throw new CanonicalityError(options.targetCommit, actual, "rollback target is not an ancestor");
    }
    const existingRescue = await this.branchHead(options.rescueRef);
    if (existingRescue === null) {
      await this.createRescueRef(options.rescueRef, actual);
    } else if (existingRescue !== actual) {
      throw new CanonicalityError(actual, existingRescue, "existing rescue ref points elsewhere");
    }
    if ((await this.branchHead(options.rescueRef)) !== actual) {
      throw new CanonicalityError(actual, "missing", "rescue ref not verified before reset");
    }
    await options.hooks?.afterRescueVerified?.();
    await this.git(["reset", "--hard", options.targetCommit]);
    await options.hooks?.afterReset?.();
    const restored = await this.assertBranchIdentity(options.branch);
    if (restored !== options.targetCommit || (await this.hasTrackedChanges())) {
      throw new CanonicalityError(options.targetCommit, restored, "rollback did not converge cleanly");
    }
    return { oldHead: actual, targetCommit: options.targetCommit, rescueRef: options.rescueRef };
  }
  async prepareDiagnosticWorktree(
    worktreePath: string,
    commit: string,
    allowedRoot?: string,
  ): Promise<GitRepository> {
    const target = await this.resolveCommit(commit);
    const resolvedPath = path.resolve(worktreePath);
    if (samePath(resolvedPath, this.repositoryRoot)) {
      throw new Error("diagnostic worktree cannot replace the repository worktree");
    }
    if (allowedRoot !== undefined && !isPathWithin(resolvedPath, path.resolve(allowedRoot))) {
      throw new Error("diagnostic worktree must remain inside its recovery runtime root");
    }
    let existing: RepositoryIdentity | null = null;
    try {
      existing = await GitRepository.inspect(resolvedPath);
    } catch {
      existing = null;
    }
    if (existing !== null) {
      if (!samePath(existing.gitCommonDir, this.gitCommonDir)) {
        throw new WorkspaceExistsError(`diagnostic path belongs to another repository: ${resolvedPath}`);
      }
      const diagnostic = await GitRepository.open(resolvedPath);
      if ((await diagnostic.currentBranch()) === null) {
        await diagnostic.git(["reset", "--hard", target]);
        await diagnostic.git(["clean", "-ffdx"]);
        if ((await diagnostic.head()) !== target) throw new Error("diagnostic worktree did not reach target");
        return diagnostic;
      }
    }
    try {
      await access(resolvedPath, fsConstants.F_OK);
      if (allowedRoot === undefined) {
        throw new WorkspaceExistsError(
          `diagnostic path is not an existing detached worktree: ${resolvedPath}`,
        );
      }
      await this.git(["worktree", "remove", "--force", resolvedPath], { allowFailure: true });
      await rm(resolvedPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.git(["worktree", "prune"]);
    await this.git(["worktree", "add", "--detach", resolvedPath, target]);
    const diagnostic = await GitRepository.open(resolvedPath);
    if ((await diagnostic.currentBranch()) !== null || (await diagnostic.head()) !== target) {
      throw new Error("diagnostic worktree is not detached at the requested historical commit");
    }
    return diagnostic;
  }
}
function checkpointMessage(
  request: Pick<CheckpointRequest, "summary" | "sessionId" | "unitId" | "kind">,
): string {
  const summary = request.summary.replaceAll(/[\r\n]+/gu, " ").trim();
  if (summary.length === 0) throw new Error("checkpoint summary must not be empty");
  return [
    `recovery-loop: ${summary}`,
    "",
    `Recovery-Loop-Session: ${request.sessionId}`,
    `Recovery-Loop-Unit: ${request.unitId}`,
    `Recovery-Loop-Kind: ${request.kind}`,
  ].join("\n");
}
export function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (
    !path.isAbsolute(relative) &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".."
  );
}
export async function canonicalPath(candidate: string): Promise<string> {
  try {
    return normalizeAbsolute(await realpath(candidate));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return normalizeAbsolute(candidate);
  }
}
