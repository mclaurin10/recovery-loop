import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateConfig } from "../../src/config.js";
import { GitRepository } from "../../src/git-repository.js";

export interface TemporaryRepository {
  root: string;
  projectPath: string;
  worktreePath: string;
  repository: GitRepository;
  baseline: string;
  git(repositoryPath: string, args: readonly string[], input?: string): Promise<string>;
  write(repositoryPath: string, relativePath: string, contents: string): Promise<void>;
  commit(repositoryPath: string, message: string): Promise<string>;
  cleanup(): Promise<void>;
}

function fixtureConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    goalFile: "RECOVERY_GOAL.md",
    branch: "recovery-loop/work",
    prepare: null,
    checks: {
      smoke: [{ id: "smoke", argv: [process.execPath, "-e", "process.exit(0)"], timeoutSeconds: 5 }],
      deep: [{ id: "deep", argv: [process.execPath, "-e", "process.exit(0)"], timeoutSeconds: 5 }],
    },
    deepPolicy: {
      everyCheckpoints: 5,
      maxMinutes: 30,
      changedFileThreshold: 20,
      changedLineThreshold: 1000,
      triggerPaths: ["package.json"],
      beforeGoalComplete: true,
      afterRecovery: true,
    },
    limits: {
      maxAgentTurns: 50,
      maxWallMinutes: 360,
      maxRepairTurnsPerFailure: 2,
      maxRecoveryCyclesPerSignature: 3,
      maxLocalizationCommits: 64,
      agentTurnSeconds: 3600,
    },
    protectedPaths: ["RECOVERY_GOAL.md", ".recovery-loop/config.json"],
    agent: { model: "test-model", reasoningEffort: "high", networkAccess: false },
  };
}

async function runGit(
  repositoryPath: string,
  args: readonly string[],
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repositoryPath, ...args], {
      shell: false,
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8").trim());
      else reject(new Error(Buffer.concat(stderr).toString("utf8") || `git exited ${code}`));
    });
    if (input !== undefined) child.stdin!.end(input);
  });
}

export async function createTemporaryRepository(): Promise<TemporaryRepository> {
  const root = await mkdtemp(path.join(tmpdir(), "recovery-loop-repo-"));
  const projectPath = path.join(root, "project");
  const worktreePath = path.join(root, "autonomous-worktree");
  await mkdir(path.join(projectPath, ".recovery-loop"), { recursive: true });
  await runGit(projectPath, ["init", "--initial-branch=main"]);
  await runGit(projectPath, ["config", "user.name", "Fixture User"]);
  await runGit(projectPath, ["config", "user.email", "fixture@example.invalid"]);
  await runGit(projectPath, ["config", "core.autocrlf", "false"]);
  await writeFile(path.join(projectPath, "RECOVERY_GOAL.md"), "# Test goal\n", "utf8");
  const config = fixtureConfig();
  validateConfig(config);
  await writeFile(
    path.join(projectPath, ".recovery-loop", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(projectPath, "source.txt"), "baseline\n", "utf8");
  await runGit(projectPath, ["add", "-A"]);
  await runGit(projectPath, ["commit", "-m", "fixture baseline"]);
  const repository = await GitRepository.open(projectPath);
  const baseline = await repository.head();

  const write = async (repositoryPath: string, relativePath: string, contents: string): Promise<void> => {
    const destination = path.join(repositoryPath, ...relativePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents, "utf8");
  };
  const commit = async (repositoryPath: string, message: string): Promise<string> => {
    await runGit(repositoryPath, ["add", "-A"]);
    await runGit(repositoryPath, ["commit", "-m", message]);
    return runGit(repositoryPath, ["rev-parse", "HEAD"]);
  };

  return {
    root,
    projectPath,
    worktreePath,
    repository,
    baseline,
    git: runGit,
    write,
    commit,
    cleanup: async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}
