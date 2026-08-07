import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { CodexAgentGateway } from "../../src/agent-gateway.js";
import { loadConfig, type RecoveryConfig } from "../../src/config.js";
import { initializeJournaledWorkspace } from "../../src/git-operations.js";
import { StateStore } from "../../src/state-store.js";
import { createTemporaryRepository } from "../support/temporary-repository.js";

const enabled = process.env.RECOVERY_LOOP_RUN_LIVE_AGENT === "1";
const model = process.env.RECOVERY_LOOP_LIVE_MODEL ?? "";

it.skipIf(!enabled || model.length === 0)(
  "runs one opt-in real Codex SDK turn in a disposable autonomous worktree",
  async () => {
    const fixture = await createTemporaryRepository();
    try {
      const store = new StateStore(fixture.repository.gitCommonDir);
      const initialized = await initializeJournaledWorkspace({
        operatorRepository: fixture.repository,
        store,
        branch: "recovery-loop/work",
        worktreePath: fixture.worktreePath,
        sessionId: "rl-live-agent",
      });
      const baseConfig = await loadConfig(fixture.worktreePath);
      const config: RecoveryConfig = {
        ...baseConfig,
        limits: { ...baseConfig.limits, agentTurnSeconds: 120 },
        agent: { ...baseConfig.agent, model },
      };
      const result = await new CodexAgentGateway().invoke({
        store,
        repository: initialized.worktree,
        config,
        unitId: "live-smoke",
        mode: "work",
      });
      expect(result.threadId.length).toBeGreaterThan(0);
      expect(["changed", "no_change", "goal_complete", "blocked"]).toContain(result.response.outcome);
      expect(await readFile(path.join(result.logDirectory, "final-response.json"), "utf8")).toContain(result.response.outcome);
    } finally {
      await fixture.cleanup();
    }
  },
);
