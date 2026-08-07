import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandSetHooks } from "../../src/check-runner.js";
import { validateConfig, type RecoveryConfig } from "../../src/config.js";
import {
  checkBaseline,
  checkpointAndCheck,
  DEEP_CHECK_REASONS,
  recordRecoveryBoundary,
  resumeInterruptedCheckSet,
  runScheduledChecks,
  type HealthControllerOptions,
} from "../../src/controller.js";
import type { CommandSpec } from "../../src/contracts.js";
import {
  initializeJournaledWorkspace,
  reconcileStartup,
} from "../../src/git-operations.js";
import { GitRepository } from "../../src/git-repository.js";
import { StateStore } from "../../src/state-store.js";
import {
  createTemporaryRepository,
  type TemporaryRepository,
} from "../support/temporary-repository.js";

const fixtures: TemporaryRepository[] = [];
const baselineTime = "2026-08-07T20:00:00.000Z";
const laterTime = "2026-08-07T20:01:00.000Z";

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

interface HealthFixture {
  fixture: TemporaryRepository;
  store: StateStore;
  worktree: GitRepository;
}

interface ConfigOptions {
  smoke?: readonly CommandSpec[];
  deep?: readonly CommandSpec[];
  policy?: Partial<RecoveryConfig["deepPolicy"]>;
}

function nodeCommand(id: string, source = "process.exit(0)"): CommandSpec {
  return { id, argv: [process.execPath, "-e", source], timeoutSeconds: 5 };
}

function markerCommand(id: string, markerPath: string): CommandSpec {
  return nodeCommand(
    id,
    `require("node:fs").appendFileSync(${JSON.stringify(markerPath)}, ${JSON.stringify(`${id}\n`)})`,
  );
}

function config(options: ConfigOptions = {}): RecoveryConfig {
  const policy = options.policy ?? {};
  return validateConfig({
    schemaVersion: 1,
    goalFile: "RECOVERY_GOAL.md",
    branch: "recovery-loop/work",
    prepare: null,
    checks: {
      smoke: options.smoke ?? [nodeCommand("smoke")],
      deep: options.deep ?? [nodeCommand("deep")],
    },
    deepPolicy: {
      everyCheckpoints: policy.everyCheckpoints ?? 99,
      maxMinutes: policy.maxMinutes ?? 999,
      changedFileThreshold: policy.changedFileThreshold ?? 99,
      changedLineThreshold: policy.changedLineThreshold ?? 9999,
      triggerPaths: policy.triggerPaths ?? ["risk/"],
      beforeGoalComplete: policy.beforeGoalComplete ?? true,
      afterRecovery: policy.afterRecovery ?? true,
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
  });
}

async function createHealthFixture(): Promise<HealthFixture> {
  const fixture = await createTemporaryRepository();
  fixtures.push(fixture);
  const store = new StateStore(fixture.repository.gitCommonDir);
  const initialized = await initializeJournaledWorkspace({
    operatorRepository: fixture.repository,
    store,
    branch: "recovery-loop/work",
    worktreePath: fixture.worktreePath,
    sessionId: "rl-health",
  });
  return { fixture, store, worktree: initialized.worktree };
}

function context(
  health: HealthFixture,
  recoveryConfig: RecoveryConfig,
  now = laterTime,
  commandSetHooks?: HealthControllerOptions["commandSetHooks"],
): HealthControllerOptions {
  return {
    store: health.store,
    repository: health.worktree,
    config: recoveryConfig,
    now,
    ...(commandSetHooks === undefined ? {} : { commandSetHooks }),
  };
}

async function establishHealthyBaseline(
  health: HealthFixture,
  recoveryConfig: RecoveryConfig,
): Promise<void> {
  const result = await checkBaseline(context(health, recoveryConfig, baselineTime));
  expect(result.pendingFailure).toBeNull();
  expect((await health.store.readState()).health.knownGoodCommit).toBe(
    health.fixture.baseline,
  );
}

async function checkpoint(
  health: HealthFixture,
  recoveryConfig: RecoveryConfig,
  options: {
    unitId: string;
    files: Record<string, string>;
    now?: string;
    goalComplete?: boolean;
    recoveryBoundary?: boolean;
    commandSetHooks?: HealthControllerOptions["commandSetHooks"];
  },
) {
  for (const [relativePath, contents] of Object.entries(options.files)) {
    await health.fixture.write(health.fixture.worktreePath, relativePath, contents);
  }
  const state = await health.store.readState();
  return checkpointAndCheck({
    ...context(
      health,
      recoveryConfig,
      options.now ?? laterTime,
      options.commandSetHooks,
    ),
    checkpoint: {
      branch: recoveryConfig.branch,
      expectedBase: state.repository.expectedHead,
      summary: `add ${options.unitId}`,
      sessionId: state.session.id,
      unitId: options.unitId,
      kind: "work",
    },
    ...(options.goalComplete === undefined ? {} : { goalComplete: options.goalComplete }),
    ...(options.recoveryBoundary === undefined
      ? {}
      : { recoveryBoundary: options.recoveryBoundary }),
  });
}

async function markerCount(markerPath: string): Promise<number> {
  try {
    const contents = await readFile(markerPath, "utf8");
    return contents.split(/\r?\n/u).filter((line) => line.length > 0).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

describe("baseline and checkpoint health", () => {
  it("establishes a healthy baseline only after smoke and deep pass", async () => {
    const health = await createHealthFixture();
    const result = await checkBaseline(context(health, config(), baselineTime));
    const state = await health.store.readState();
    expect(result).toMatchObject({
      commit: health.fixture.baseline,
      knownGoodPromoted: true,
      pendingFailure: null,
    });
    expect(result.smokeResults).toHaveLength(1);
    expect(result.deepResults).toHaveLength(1);
    expect(state.health).toMatchObject({
      knownGoodCommit: health.fixture.baseline,
      lastSmokePassCommit: health.fixture.baseline,
      lastDeepRunCommit: health.fixture.baseline,
      lastDeepRunAt: baselineTime,
      pendingFailure: null,
    });
    expect(state.cadence).toEqual({
      smokePassingCheckpointsSinceDeep: 0,
      deepRequired: false,
      deepReasons: [],
    });
  });

  it("records an unhealthy baseline without inventing a rollback anchor", async () => {
    const health = await createHealthFixture();
    const unhealthy = config({
      smoke: [nodeCommand("smoke", "process.exit(9)")],
    });
    const result = await checkBaseline(context(health, unhealthy, baselineTime));
    const state = await health.store.readState();
    expect(result.deepResults?.[0]?.classification).toBe("pass");
    expect(state.health.knownGoodCommit).toBeNull();
    expect(state.health.pendingFailure).toMatchObject({
      checkId: "smoke",
      classification: "product",
      discoveredAtCommit: health.fixture.baseline,
      confirmed: false,
      knownGoodCommit: null,
    });
  });

  it("checkpoints nonempty work before smoke and continues after a smoke-only pass", async () => {
    const health = await createHealthFixture();
    const recoveryConfig = config();
    await establishHealthyBaseline(health, recoveryConfig);
    const result = await checkpoint(health, recoveryConfig, {
      unitId: "smoke-pass",
      files: { "feature.txt": "checkpointed before smoke\n" },
    });
    const state = await health.store.readState();
    expect(result.checkpoint?.commit).toBe(await health.worktree.head());
    expect(result.observation?.smokeResults[0]?.classification).toBe("pass");
    expect(result.observation?.deepResults).toBeNull();
    expect(state.health.lastSmokePassCommit).toBe(result.checkpoint?.commit);
    expect(state.health.knownGoodCommit).toBe(health.fixture.baseline);
    expect(state.cadence.smokePassingCheckpointsSinceDeep).toBe(1);
  });

  it("leaves a smoke-failing checkpoint in history and creates an observation failure", async () => {
    const health = await createHealthFixture();
    const smokeSource = [
      'const text = require("node:fs").readFileSync("source.txt", "utf8");',
      'process.exit(text.includes("smoke-bad") ? 7 : 0);',
    ].join(" ");
    const recoveryConfig = config({ smoke: [nodeCommand("smoke", smokeSource)] });
    await establishHealthyBaseline(health, recoveryConfig);
    const result = await checkpoint(health, recoveryConfig, {
      unitId: "smoke-fail",
      files: { "source.txt": "smoke-bad\n" },
    });
    const state = await health.store.readState();
    expect(await health.worktree.commitCount(`${health.fixture.baseline}..HEAD`)).toBe(1);
    expect(await health.worktree.head()).toBe(result.checkpoint?.commit);
    expect(result.observation?.deepResults).toBeNull();
    expect(state.health.knownGoodCommit).toBe(health.fixture.baseline);
    expect(state.health.pendingFailure).toMatchObject({
      checkId: "smoke",
      classification: "product",
      discoveredAtCommit: result.checkpoint?.commit,
      confirmed: false,
      knownGoodCommit: health.fixture.baseline,
    });
  });
});

describe("deep triggers at real Git and command boundaries", () => {
  it("runs deep at the exact configured checkpoint cadence", async () => {
    const health = await createHealthFixture();
    const marker = path.join(health.fixture.root, "cadence-deep.txt");
    const recoveryConfig = config({
      deep: [markerCommand("deep", marker)],
      policy: { everyCheckpoints: 2 },
    });
    await establishHealthyBaseline(health, recoveryConfig);
    const first = await checkpoint(health, recoveryConfig, {
      unitId: "cadence-1",
      files: { "one.txt": "one\n" },
    });
    expect(first.observation?.deepResults).toBeNull();
    expect(await markerCount(marker)).toBe(1);
    const second = await checkpoint(health, recoveryConfig, {
      unitId: "cadence-2",
      files: { "two.txt": "two\n" },
    });
    expect(second.observation?.deepReasons).toContain(DEEP_CHECK_REASONS.checkpointCadence);
    expect(await markerCount(marker)).toBe(2);
    expect((await health.store.readState()).health.knownGoodCommit).toBe(
      second.checkpoint?.commit,
    );
  });

  it("runs deep when elapsed time reaches the configured maximum", async () => {
    const health = await createHealthFixture();
    const marker = path.join(health.fixture.root, "elapsed-deep.txt");
    const recoveryConfig = config({
      deep: [markerCommand("deep", marker)],
      policy: { maxMinutes: 30 },
    });
    await establishHealthyBaseline(health, recoveryConfig);
    const result = await checkpoint(health, recoveryConfig, {
      unitId: "elapsed",
      files: { "elapsed.txt": "elapsed\n" },
      now: "2026-08-07T20:30:00.000Z",
    });
    expect(result.observation?.deepReasons).toContain(DEEP_CHECK_REASONS.elapsedTime);
    expect(await markerCount(marker)).toBe(2);
  });

  it("runs deep for a configured high-risk path", async () => {
    const health = await createHealthFixture();
    const marker = path.join(health.fixture.root, "risk-deep.txt");
    const recoveryConfig = config({ deep: [markerCommand("deep", marker)] });
    await establishHealthyBaseline(health, recoveryConfig);
    const result = await checkpoint(health, recoveryConfig, {
      unitId: "risk",
      files: { "risk/schema.sql": "create table example;\n" },
    });
    expect(result.observation?.deepReasons).toContain(DEEP_CHECK_REASONS.highRiskPath);
    expect(await markerCount(marker)).toBe(2);
  });

  it("runs deep only after the changed-file threshold is exceeded", async () => {
    const health = await createHealthFixture();
    const marker = path.join(health.fixture.root, "files-deep.txt");
    const recoveryConfig = config({
      deep: [markerCommand("deep", marker)],
      policy: { changedFileThreshold: 1 },
    });
    await establishHealthyBaseline(health, recoveryConfig);
    const result = await checkpoint(health, recoveryConfig, {
      unitId: "many-files",
      files: { "a.txt": "a\n", "b.txt": "b\n" },
    });
    expect(result.observation?.deepReasons).toContain(DEEP_CHECK_REASONS.changedFiles);
    expect(await markerCount(marker)).toBe(2);
  });

  it("runs deep only after the added-plus-deleted line threshold is exceeded", async () => {
    const health = await createHealthFixture();
    const marker = path.join(health.fixture.root, "lines-deep.txt");
    const recoveryConfig = config({
      deep: [markerCommand("deep", marker)],
      policy: { changedLineThreshold: 3 },
    });
    await establishHealthyBaseline(health, recoveryConfig);
    const result = await checkpoint(health, recoveryConfig, {
      unitId: "many-lines",
      files: { "lines.txt": "one\ntwo\nthree\nfour\n" },
    });
    expect(result.observation?.deepReasons).toContain(DEEP_CHECK_REASONS.changedLines);
    expect(await markerCount(marker)).toBe(2);
  });

  it("runs deep for goal completion and persisted recovery boundaries", async () => {
    const health = await createHealthFixture();
    const marker = path.join(health.fixture.root, "boundary-deep.txt");
    const recoveryConfig = config({ deep: [markerCommand("deep", marker)] });
    await establishHealthyBaseline(health, recoveryConfig);
    const goal = await checkpoint(health, recoveryConfig, {
      unitId: "goal",
      files: { "goal.txt": "candidate complete\n" },
      goalComplete: true,
    });
    expect(goal.observation?.deepReasons).toContain(DEEP_CHECK_REASONS.goalCompletion);

    const ordinary = await checkpoint(health, recoveryConfig, {
      unitId: "post-goal",
      files: { "post-goal.txt": "ordinary\n" },
    });
    expect(ordinary.observation?.deepResults).toBeNull();
    await recordRecoveryBoundary(context(health, recoveryConfig, laterTime));
    const recovery = await runScheduledChecks(context(health, recoveryConfig, laterTime));
    expect(recovery?.deepReasons).toContain(DEEP_CHECK_REASONS.recoveryBoundary);
    expect(await markerCount(marker)).toBe(3);
  });
});

describe("known-good promotion and durable cadence", () => {
  it("promotes an exact later head after every smoke and deep command passes", async () => {
    const health = await createHealthFixture();
    const recoveryConfig = config({
      smoke: [nodeCommand("smoke-one"), nodeCommand("smoke-two")],
      deep: [nodeCommand("deep-one"), nodeCommand("deep-two")],
    });
    await establishHealthyBaseline(health, recoveryConfig);
    const result = await checkpoint(health, recoveryConfig, {
      unitId: "later-pass",
      files: { "later.txt": "later\n" },
      goalComplete: true,
    });
    expect(result.observation?.smokeResults).toHaveLength(2);
    expect(result.observation?.deepResults).toHaveLength(2);
    expect(result.observation?.knownGoodPromoted).toBe(true);
    expect((await health.store.readState()).health.knownGoodCommit).toBe(
      result.checkpoint?.commit,
    );
  });

  it("preserves the previous anchor after a deep failure", async () => {
    const health = await createHealthFixture();
    const deepSource = [
      'const text = require("node:fs").readFileSync("source.txt", "utf8");',
      'process.exit(text.includes("deep-bad") ? 8 : 0);',
    ].join(" ");
    const recoveryConfig = config({ deep: [nodeCommand("deep", deepSource)] });
    await establishHealthyBaseline(health, recoveryConfig);
    const result = await checkpoint(health, recoveryConfig, {
      unitId: "deep-fail",
      files: { "source.txt": "deep-bad\n" },
      goalComplete: true,
    });
    const state = await health.store.readState();
    expect(result.observation?.smokeResults[0]?.classification).toBe("pass");
    expect(result.observation?.deepResults?.[0]?.classification).toBe("product");
    expect(state.health.knownGoodCommit).toBe(health.fixture.baseline);
    expect(state.health.pendingFailure).toMatchObject({
      checkId: "deep",
      discoveredAtCommit: result.checkpoint?.commit,
      knownGoodCommit: health.fixture.baseline,
      confirmed: false,
    });
  });

  it("withholds promotion when a deep command alters tracked source", async () => {
    const health = await createHealthFixture();
    const mutationSource = [
      'const fs = require("node:fs");',
      'const text = fs.readFileSync("source.txt", "utf8");',
      'if (text.includes("mutate")) fs.appendFileSync("source.txt", "changed by check\\n");',
    ].join(" ");
    const recoveryConfig = config({ deep: [nodeCommand("deep", mutationSource)] });
    await establishHealthyBaseline(health, recoveryConfig);
    const result = await checkpoint(health, recoveryConfig, {
      unitId: "mutation",
      files: { "source.txt": "mutate\n" },
      goalComplete: true,
    });
    const state = await health.store.readState();
    expect(result.observation?.deepResults?.[0]).toMatchObject({
      classification: "infrastructure",
      worktreeChanged: true,
    });
    expect(state.health.knownGoodCommit).toBe(health.fixture.baseline);
    expect(state.health.pendingFailure?.classification).toBe("infrastructure");
    expect(await health.worktree.hasTrackedChanges()).toBe(false);
    expect(await readFile(path.join(health.fixture.worktreePath, "source.txt"), "utf8")).toBe(
      "mutate\n",
    );
  });

  it("reloads state without losing smoke-passing checkpoint cadence", async () => {
    const health = await createHealthFixture();
    const marker = path.join(health.fixture.root, "reload-deep.txt");
    const recoveryConfig = config({
      deep: [markerCommand("deep", marker)],
      policy: { everyCheckpoints: 3 },
    });
    await establishHealthyBaseline(health, recoveryConfig);
    await checkpoint(health, recoveryConfig, {
      unitId: "reload-1",
      files: { "reload-1.txt": "one\n" },
    });
    await checkpoint(health, recoveryConfig, {
      unitId: "reload-2",
      files: { "reload-2.txt": "two\n" },
    });
    expect((await health.store.readState()).cadence.smokePassingCheckpointsSinceDeep).toBe(2);

    const reloaded: HealthFixture = {
      fixture: health.fixture,
      store: new StateStore(health.fixture.repository.gitCommonDir),
      worktree: await GitRepository.open(health.fixture.worktreePath),
    };
    const third = await checkpoint(reloaded, recoveryConfig, {
      unitId: "reload-3",
      files: { "reload-3.txt": "three\n" },
    });
    expect(third.observation?.deepReasons).toContain(DEEP_CHECK_REASONS.checkpointCadence);
    expect(await markerCount(marker)).toBe(2);
    expect((await reloaded.store.readState()).cadence.smokePassingCheckpointsSinceDeep).toBe(0);
  });
});

describe("interrupted check-set replay", () => {
  it("reruns the entire smoke set after interruption", async () => {
    const health = await createHealthFixture();
    const firstMarker = path.join(health.fixture.root, "smoke-first.txt");
    const secondMarker = path.join(health.fixture.root, "smoke-second.txt");
    const recoveryConfig = config({
      smoke: [
        markerCommand("smoke-first", firstMarker),
        markerCommand("smoke-second", secondMarker),
      ],
    });
    await establishHealthyBaseline(health, recoveryConfig);
    const interrupt: CommandSetHooks = {
      afterCommand: (_result, index) => {
        if (index === 0) throw new Error("interrupt smoke set");
      },
    };
    await expect(
      checkpoint(health, recoveryConfig, {
        unitId: "interrupt-smoke",
        files: { "interrupt-smoke.txt": "checkpoint survives\n" },
        commandSetHooks: { smoke: interrupt },
      }),
    ).rejects.toThrow("interrupt smoke set");
    expect((await health.store.readState()).phase).toBe("smoke-checking");
    expect(await health.worktree.commitCount(`${health.fixture.baseline}..HEAD`)).toBe(1);
    expect(await markerCount(firstMarker)).toBe(2);
    expect(await markerCount(secondMarker)).toBe(1);

    const reconciled = await reconcileStartup(health.fixture.repository, health.store);
    expect(reconciled.action).toBe("rerun-smoke");
    const resumed = await resumeInterruptedCheckSet(
      context(health, recoveryConfig, laterTime),
      "smoke",
    );
    expect(resumed.smokeResults).toHaveLength(2);
    expect(await markerCount(firstMarker)).toBe(3);
    expect(await markerCount(secondMarker)).toBe(2);
  });

  it("reruns the entire deep set after interruption", async () => {
    const health = await createHealthFixture();
    const firstMarker = path.join(health.fixture.root, "deep-first.txt");
    const secondMarker = path.join(health.fixture.root, "deep-second.txt");
    const recoveryConfig = config({
      deep: [
        markerCommand("deep-first", firstMarker),
        markerCommand("deep-second", secondMarker),
      ],
      policy: { everyCheckpoints: 1 },
    });
    await establishHealthyBaseline(health, recoveryConfig);
    const interrupt: CommandSetHooks = {
      afterCommand: (_result, index) => {
        if (index === 0) throw new Error("interrupt deep set");
      },
    };
    await expect(
      checkpoint(health, recoveryConfig, {
        unitId: "interrupt-deep",
        files: { "interrupt-deep.txt": "checkpoint survives\n" },
        commandSetHooks: { deep: interrupt },
      }),
    ).rejects.toThrow("interrupt deep set");
    const interruptedHead = await health.worktree.head();
    expect((await health.store.readState()).phase).toBe("deep-checking");
    expect((await health.store.readState()).health.knownGoodCommit).toBe(
      health.fixture.baseline,
    );
    expect(await markerCount(firstMarker)).toBe(2);
    expect(await markerCount(secondMarker)).toBe(1);

    const reconciled = await reconcileStartup(health.fixture.repository, health.store);
    expect(reconciled.action).toBe("rerun-deep");
    const resumed = await resumeInterruptedCheckSet(
      context(health, recoveryConfig, laterTime),
      "deep",
    );
    expect(resumed.deepResults).toHaveLength(2);
    expect(await markerCount(firstMarker)).toBe(3);
    expect(await markerCount(secondMarker)).toBe(2);
    expect((await health.store.readState()).health.knownGoodCommit).toBe(interruptedHead);
  });
});
