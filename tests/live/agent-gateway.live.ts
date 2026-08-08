import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { CodexAgentGateway } from "../../src/agent-gateway.js";
import { runNormalController } from "../../src/controller.js";
import { initializeJournaledWorkspace } from "../../src/git-operations.js";
import { StateStore } from "../../src/state-store.js";
import { createTemporaryRepository } from "../support/temporary-repository.js";

const enabled = process.env.RECOVERY_LOOP_RUN_LIVE_AGENT === "1";
const model = process.env.RECOVERY_LOOP_LIVE_MODEL ?? "gpt-5.6-sol";

it.skipIf(!enabled)(
  "runs an opt-in useful checkpoint and repair checkpoint through the production controller",
  async () => {
    const fixture = await createTemporaryRepository();
    try {
      await fixture.write(fixture.projectPath, "RECOVERY_GOAL.md", `# Live canary goal

Create \`LIVE_FEATURE.md\` containing a short explanation that this is a useful
Recovery Loop checkpoint. Do not edit \`live-check.mjs\`, the tracked recovery
configuration, or this goal. When the requested file exists, report
\`goal_complete\` on the next unchanged turn.
`);
      await fixture.write(fixture.projectPath, "live-check.mjs", `import { execFileSync } from "node:child_process";
const message = execFileSync("git", ["show", "-s", "--format=%B", "HEAD"], { encoding: "utf8" });
if (message.includes("Recovery-Loop-Kind: work")) {
  console.error("LIVE_CANARY_RECOVERY: create LIVE_REPAIR.md explaining the repair checkpoint; do not edit live-check.mjs");
  process.exit(1);
}
`);
      const configPath = path.join(fixture.projectPath, ".recovery-loop", "config.json");
      const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      config.checks = {
        smoke: [{ id: "live-smoke", argv: [process.execPath, "live-check.mjs"], timeoutSeconds: 30 }],
        deep: [{ id: "live-deep", argv: [process.execPath, "-e", "process.exit(0)"], timeoutSeconds: 30, bisectable: true }],
      };
      config.protectedPaths = [
        "RECOVERY_GOAL.md",
        ".recovery-loop/config.json",
        "live-check.mjs",
      ];
      config.agent = { model, reasoningEffort: "high", networkAccess: false };
      await fixture.write(
        fixture.projectPath,
        ".recovery-loop/config.json",
        `${JSON.stringify(config, null, 2)}\n`,
      );
      const baseline = await fixture.commit(fixture.projectPath, "configure live recovery canary");
      const store = new StateStore(fixture.repository.gitCommonDir);
      const initialized = await initializeJournaledWorkspace({
        operatorRepository: fixture.repository,
        store,
        branch: "recovery-loop/work",
        worktreePath: fixture.worktreePath,
        baseline,
        sessionId: "rl-live-canary",
      });

      const result = await runNormalController({
        repository: fixture.repository,
        gateway: new CodexAgentGateway(),
        limits: { maxAgentTurns: 6, maxCheckpoints: 6, maxMinutes: 15 },
      });
      const events = (await store.readEvents()).events;
      const checkpoints = events.filter((event) => event.type === "checkpoint-created");
      expect(checkpoints.some((event) => event.data.kind === "work")).toBe(true);
      expect(checkpoints.some((event) => event.data.kind === "repair")).toBe(true);
      expect(result.summary.externalCorrectnessEvaluated).toBe(false);
      expect(typeof result.summary.repairCheckpoints).toBe("number");
      if (typeof result.summary.repairCheckpoints !== "number") {
        throw new Error("live summary omitted repair checkpoint count");
      }
      expect(result.summary.repairCheckpoints).toBeGreaterThanOrEqual(1);
      expect(await readFile(path.join(initialized.worktree.repositoryRoot, "LIVE_FEATURE.md"), "utf8"))
        .toContain("Recovery Loop");
      expect(await readFile(path.join(initialized.worktree.repositoryRoot, "LIVE_REPAIR.md"), "utf8"))
        .toContain("repair");
    } finally {
      await fixture.cleanup();
    }
  },
  20 * 60_000,
);
