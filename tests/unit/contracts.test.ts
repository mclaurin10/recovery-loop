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
    expect(() => validateRecoveryState({ ...state, schemaVersion: 2 })).toThrow(
      "unsupported schema version",
    );
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
