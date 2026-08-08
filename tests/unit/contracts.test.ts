import { describe, expect, it } from "vitest";
import { createInitialState, validateAgentResponse, validateRecoveryState } from "../../src/contracts.js";

const commit = "a".repeat(40);

describe("compact contracts", () => {
  it("round-trips initial state and rejects unknown schemas", () => {
    const state = createInitialState({
      gitCommonDir: "/repo/.git",
      baselineCommit: commit,
      branch: "recovery-loop/work",
      worktreePath: "/worktree",
      sessionId: "rl-test",
      now: "2026-08-07T20:00:00.000Z",
    });
    expect(validateRecoveryState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    const legacy = JSON.parse(JSON.stringify(state)) as {
      agent: Record<string, unknown>;
      recovery: Record<string, unknown>;
    };
    delete legacy.agent.pendingResult;
    delete legacy.recovery.lastFailureSignature;
    expect(validateRecoveryState(legacy).agent.pendingResult).toBeNull();
    expect(validateRecoveryState(legacy).recovery.lastFailureSignature).toBeNull();
    expect(() => validateRecoveryState({ ...state, schemaVersion: 2 })).toThrow(
      "unsupported schema version",
    );
  });

  it("loads Stage 7 pending failures with explicit Stage 8 recovery defaults", () => {
    const state = createInitialState({
      gitCommonDir: "/repo/.git",
      baselineCommit: commit,
      branch: "recovery-loop/work",
      worktreePath: "/worktree",
      sessionId: "rl-test",
      now: "2026-08-07T20:00:00.000Z",
    });
    const legacyFailure = {
      id: "failure-1", checkId: "smoke", classification: "product", signature: "signature",
      discoveredAtCommit: commit, confirmed: false, knownGoodCommit: null,
      firstBadCommit: null, regressionWindow: null, repairAttempts: 0,
      recoveryCycles: 0, latestResultPath: "/logs/result.json",
    };
    const raw = JSON.parse(JSON.stringify(state)) as { health: Record<string, unknown> };
    raw.health.pendingFailure = legacyFailure;
    expect(validateRecoveryState(raw).health.pendingFailure).toMatchObject({
      confirmationAttempts: [], lastRepairCommit: null,
      lastEvaluatedRepairCommit: null, environmentAttempts: 0,
    });
  });

  it("validates only the four small agent outcomes", () => {
    expect(
      validateAgentResponse({
        outcome: "changed",
        summary: "add parser",
        nextHint: null,
        blocker: null,
      }),
    ).toMatchObject({ outcome: "changed" });
    expect(() =>
      validateAgentResponse({ outcome: "approved", summary: "x", nextHint: null, blocker: null }),
    ).toThrow("expected one of");
    expect(() =>
      validateAgentResponse({ outcome: "blocked", summary: "x", nextHint: null, blocker: null }),
    ).toThrow("is required");
  });
});
