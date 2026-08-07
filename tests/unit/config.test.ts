import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  scaffoldContract,
  validateConfig,
  validateRelativePath,
} from "../../src/config.js";
import { ValidationError } from "../../src/contracts.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function validConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    goalFile: "RECOVERY_GOAL.md",
    branch: "recovery-loop/work",
    prepare: null,
    checks: {
      smoke: [{ id: "typecheck", argv: ["pnpm", "typecheck"], timeoutSeconds: 30 }],
      deep: [
        { id: "tests", argv: ["pnpm", "test"], timeoutSeconds: 60, bisectable: true },
      ],
    },
    deepPolicy: {
      everyCheckpoints: 5,
      maxMinutes: 30,
      changedFileThreshold: 20,
      changedLineThreshold: 1000,
      triggerPaths: ["package.json", "src/"],
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
    protectedPaths: [],
    agent: { model: "configured-model", reasoningEffort: "high", networkAccess: false },
  };
}

function nested(config: Record<string, unknown>, key: string): Record<string, unknown> {
  return config[key] as Record<string, unknown>;
}

describe("validateConfig", () => {
  it("accepts the compact contract and automatically protects authority", () => {
    const result = validateConfig(validConfig());
    expect(result.protectedPaths).toEqual([
      "RECOVERY_GOAL.md",
      ".recovery-loop/config.json",
    ]);
    expect(result.prepare).toBeNull();
  });

  it("rejects unknown top-level and nested keys", () => {
    const top = validConfig();
    top.extra = true;
    expect(() => validateConfig(top)).toThrow("config.extra: unknown key");

    const command = validConfig();
    const checks = nested(command, "checks");
    (checks.smoke as Record<string, unknown>[])[0]!.shell = true;
    expect(() => validateConfig(command)).toThrow("config.checks.smoke[0].shell: unknown key");
  });

  it("rejects shell strings and empty command sets", () => {
    const shell = validConfig();
    const checks = nested(shell, "checks");
    (checks.smoke as Record<string, unknown>[])[0]!.argv = "pnpm test";
    expect(() => validateConfig(shell)).toThrow("expected a non-empty argv array");

    const empty = validConfig();
    nested(empty, "checks").deep = [];
    expect(() => validateConfig(empty)).toThrow("must contain at least one command");
  });

  it("rejects duplicate IDs across both command categories", () => {
    const config = validConfig();
    const checks = nested(config, "checks");
    (checks.deep as Record<string, unknown>[])[0]!.id = "typecheck";
    expect(() => validateConfig(config)).toThrow("check IDs must be unique");
  });

  it.each(["../outside", "/absolute", "C:/absolute", "src\\file.ts", "a//b", "./a"])(
    "rejects unsafe path %s",
    (unsafe) => {
      expect(() => validateRelativePath(unsafe, "path")).toThrow(ValidationError);
    },
  );

  it("rejects invalid limits, branches, and network access", () => {
    const limit = validConfig();
    nested(limit, "limits").maxAgentTurns = 0;
    expect(() => validateConfig(limit)).toThrow("expected a positive safe integer");

    const branch = validConfig();
    branch.branch = "main";
    expect(() => validateConfig(branch)).toThrow("must start with recovery-loop/");

    const network = validConfig();
    nested(network, "agent").networkAccess = true;
    expect(() => validateConfig(network)).toThrow("must be false in v0.1");

    const timeout = validConfig();
    const checks = nested(timeout, "checks");
    (checks.smoke as Record<string, unknown>[])[0]!.timeoutSeconds = Number.POSITIVE_INFINITY;
    expect(() => validateConfig(timeout)).toThrow("positive finite number");
  });

  it("validates optional prepare commands and their trigger paths", () => {
    const config = validConfig();
    config.prepare = {
      argv: ["pnpm", "install", "--frozen-lockfile"],
      timeoutSeconds: 0.5,
      triggerPaths: ["package.json", "pnpm-lock.yaml"],
    };
    expect(validateConfig(config).prepare?.argv).toEqual([
      "pnpm",
      "install",
      "--frozen-lockfile",
    ]);
  });
});

describe("scaffoldContract", () => {
  it("creates exact templates without overwriting them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recovery-loop-template-"));
    temporaryPaths.push(root);
    const first = await scaffoldContract(root);
    expect(first.created).toEqual(["RECOVERY_GOAL.md", ".recovery-loop/config.json"]);
    expect(validateConfig(JSON.parse(await readFile(path.join(root, ".recovery-loop/config.json"), "utf8"))))
      .toBeDefined();
    expect(await readFile(path.join(root, "RECOVERY_GOAL.md"), "utf8")).toMatchInlineSnapshot(`
      "# Recovery Loop Product Goal

      ## Objective

      Describe the end product or improvement the autonomous branch should achieve.

      ## Current starting point

      Describe important known state that cannot be inferred easily from the repository.

      ## Required outcomes

      List concrete product behaviors or engineering outcomes.

      ## Constraints

      List technology, compatibility, architectural, legal, or operational constraints.

      ## Non-goals

      List work that must not be pursued.

      ## Completion signals

      Describe observable indications that the agent may report \`goal_complete\`.

      ## Stop-only boundaries

      List project-specific actions that would risk data, credentials, external
      systems, or other consequences outside normal Git recovery.
      "
    `);

    const second = await scaffoldContract(root);
    expect(second.created).toEqual([]);
  });
});
