import { describe, expect, it } from "vitest";
import {
  CODEX_CONFIG_OVERRIDES,
  MAX_AGENT_THREAD_TURNS,
  decideThreadAction,
} from "../../src/agent-gateway.js";

describe("coding-agent thread policy", () => {
  it("disables SDK capabilities that could create extra roles or external actions", () => {
    expect(CODEX_CONFIG_OVERRIDES).toMatchObject({
      allow_login_shell: false,
      mcp_servers: {},
      plugins: {},
      shell_environment_policy: { inherit: "core", ignore_default_excludes: false },
      features: {
        apps: false,
        goals: false,
        hooks: false,
        multi_agent: false,
        network_proxy: false,
        remote_plugin: false,
        skill_mcp_dependency_install: false,
      },
    });
  });

  it("starts, resumes, and rotates at the exact turn boundary", () => {
    expect(decideThreadAction({ threadId: null, threadTurns: 0 }, {}, 2)).toEqual({
      action: "start",
      reason: "no-thread",
      rotated: false,
    });
    expect(decideThreadAction({ threadId: "thread-1", threadTurns: 7 }, {}, 2)).toEqual({
      action: "resume",
      reason: null,
      rotated: false,
    });
    expect(
      decideThreadAction(
        { threadId: "thread-1", threadTurns: MAX_AGENT_THREAD_TURNS },
        {},
        2,
      ),
    ).toEqual({ action: "start", reason: "turn-limit", rotated: true });
  });

  it.each([
    [{ force: true }, "forced"],
    [{ hardRollback: true }, "hard-rollback"],
    [{ agentHistoryViolation: true }, "agent-history-violation"],
    [{ repairAttempts: 2 }, "repair-attempt-limit"],
  ] as const)("exposes the configured %s rotation boundary", (boundaries, reason) => {
    expect(decideThreadAction({ threadId: "thread-1", threadTurns: 1 }, boundaries, 2)).toEqual({
      action: "start",
      reason,
      rotated: true,
    });
  });
});
