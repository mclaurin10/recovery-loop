import { describe, expect, it } from "vitest";
import { validateConfig, type RecoveryConfig } from "../../src/config.js";
import {
  DEEP_CHECK_REASONS,
  evaluateDeepSchedule,
} from "../../src/controller.js";
import { createInitialState, type RecoveryState } from "../../src/contracts.js";

const commit = "a".repeat(40);
const initialTime = "2026-08-07T20:00:00.000Z";

function config(overrides: Partial<RecoveryConfig["deepPolicy"]> = {}): RecoveryConfig {
  return validateConfig({
    schemaVersion: 1,
    goalFile: "RECOVERY_GOAL.md",
    branch: "recovery-loop/work",
    prepare: null,
    checks: {
      smoke: [{ id: "smoke", argv: ["node", "smoke.js"], timeoutSeconds: 5 }],
      deep: [{ id: "deep", argv: ["node", "deep.js"], timeoutSeconds: 5 }],
    },
    deepPolicy: {
      everyCheckpoints: overrides.everyCheckpoints ?? 5,
      maxMinutes: overrides.maxMinutes ?? 30,
      changedFileThreshold: overrides.changedFileThreshold ?? 20,
      changedLineThreshold: overrides.changedLineThreshold ?? 1000,
      triggerPaths: overrides.triggerPaths ?? ["package.json", "migrations/"],
      beforeGoalComplete: overrides.beforeGoalComplete ?? true,
      afterRecovery: overrides.afterRecovery ?? true,
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

function healthyState(): RecoveryState {
  const state = createInitialState({
    gitCommonDir: "/repo/.git",
    baselineCommit: commit,
    branch: "recovery-loop/work",
    worktreePath: "/worktree",
    sessionId: "rl-schedule",
    now: initialTime,
  });
  state.health.knownGoodCommit = commit;
  state.health.lastSmokePassCommit = commit;
  state.health.lastDeepRunCommit = commit;
  state.health.lastDeepRunAt = initialTime;
  state.cadence.deepRequired = false;
  state.cadence.deepReasons = [];
  return state;
}

describe("deterministic deep scheduling", () => {
  it("triggers at the exact smoke-passing checkpoint cadence", () => {
    const state = healthyState();
    const policy = config({ everyCheckpoints: 3 });
    state.cadence.smokePassingCheckpointsSinceDeep = 2;
    expect(evaluateDeepSchedule(state, policy, { now: initialTime }).due).toBe(false);
    state.cadence.smokePassingCheckpointsSinceDeep = 3;
    expect(evaluateDeepSchedule(state, policy, { now: initialTime })).toEqual({
      due: true,
      reasons: [DEEP_CHECK_REASONS.checkpointCadence],
    });
  });

  it("triggers when the elapsed-time boundary is reached", () => {
    const state = healthyState();
    const policy = config({ maxMinutes: 30 });
    expect(
      evaluateDeepSchedule(state, policy, { now: "2026-08-07T20:29:59.999Z" }).due,
    ).toBe(false);
    expect(
      evaluateDeepSchedule(state, policy, { now: "2026-08-07T20:30:00.000Z" }),
    ).toEqual({ due: true, reasons: [DEEP_CHECK_REASONS.elapsedTime] });
  });

  it("matches configured high-risk files and directory prefixes without near misses", () => {
    const state = healthyState();
    const policy = config();
    expect(
      evaluateDeepSchedule(state, policy, {
        now: initialTime,
        changedPaths: ["package.json.backup", "src/migrations.ts"],
      }).due,
    ).toBe(false);
    expect(
      evaluateDeepSchedule(state, policy, {
        now: initialTime,
        changedPaths: ["migrations/001.sql"],
      }).reasons,
    ).toEqual([DEEP_CHECK_REASONS.highRiskPath]);
  });

  it("uses the authoritative more-than semantics for file and line thresholds", () => {
    const state = healthyState();
    const policy = config({ changedFileThreshold: 2, changedLineThreshold: 10 });
    expect(
      evaluateDeepSchedule(state, policy, {
        now: initialTime,
        statistics: { files: 2, additions: 6, deletions: 4, binaryFiles: 0 },
      }).due,
    ).toBe(false);
    expect(
      evaluateDeepSchedule(state, policy, {
        now: initialTime,
        statistics: { files: 3, additions: 8, deletions: 3, binaryFiles: 0 },
      }).reasons,
    ).toEqual([DEEP_CHECK_REASONS.changedFiles, DEEP_CHECK_REASONS.changedLines]);
  });

  it("honors goal, recovery, and explicit persisted boundaries in stable order", () => {
    const state = healthyState();
    state.cadence.deepRequired = true;
    state.cadence.deepReasons = ["operator-boundary"];
    expect(
      evaluateDeepSchedule(state, config(), {
        now: initialTime,
        goalComplete: true,
        recoveryBoundary: true,
      }),
    ).toEqual({
      due: true,
      reasons: [
        "operator-boundary",
        DEEP_CHECK_REASONS.goalCompletion,
        DEEP_CHECK_REASONS.recoveryBoundary,
      ],
    });
  });
});
