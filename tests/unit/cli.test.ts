import { describe, expect, it, vi } from "vitest";
import { CliUsageError, dispatchCli, helpText, parseCli, type CliHandlers } from "../../src/cli.js";

describe("CLI parsing", () => {
  it("parses the four commands and their bounded flags", () => {
    expect(parseCli(["init", "--base", "HEAD~1", "--worktree", "C:/work"])).toEqual({
      command: "init",
      base: "HEAD~1",
      worktree: "C:/work",
    });
    expect(parseCli([
      "run",
      "--max-agent-turns",
      "3",
      "--max-checkpoints",
      "2",
      "--max-minutes",
      "10",
    ])).toEqual({ command: "run", maxAgentTurns: 3, maxCheckpoints: 2, maxMinutes: 10 });
    expect(parseCli(["status", "--json"])).toEqual({ command: "status", json: true });
    expect(parseCli(["check", "--deep"])).toEqual({ command: "check", deep: true });
  });

  it("rejects unknown commands, flags, duplicate flags, and bad integers", () => {
    expect(() => parseCli(["approve"])).toThrow(CliUsageError);
    expect(() => parseCli(["status", "--write"])).toThrow("unknown status flag");
    expect(() => parseCli(["init", "--base", "HEAD", "--base", "main"])).toThrow(
      "may only be specified once",
    );
    expect(() => parseCli(["run", "--max-minutes", "0"])).toThrow("positive integer");
  });

  it("dispatches to one explicit handler", async () => {
    const handlers: CliHandlers = {
      init: vi.fn(async () => undefined),
      run: vi.fn(async () => undefined),
      status: vi.fn(async () => undefined),
      check: vi.fn(async () => undefined),
    };
    await dispatchCli(parseCli(["check", "--deep"]), handlers);
    expect(handlers.check).toHaveBeenCalledWith({ command: "check", deep: true });
    expect(handlers.run).not.toHaveBeenCalled();
  });

  it("keeps the command surface compact", () => {
    expect(helpText()).toContain("init");
    expect(helpText()).not.toContain("approve");
    expect(parseCli(["run", "--help"])).toEqual({ command: "help", topic: "run" });
  });

  it("provides complete help for exactly the four release commands", () => {
    for (const command of ["init", "run", "status", "check"] as const) {
      const help = helpText(command);
      expect(help).toContain(`Usage: recovery-loop ${command}`);
      expect(help).toContain("--help");
      expect(parseCli([command, "--help"])).toEqual({ command: "help", topic: command });
    }
    const root = helpText();
    expect(root.match(/^ {2}\w+/gmu)).toHaveLength(4);
    for (const deferred of ["plan", "review", "approve", "integrate", "reconcile", "retention", "canary", "doctor", "rollback"]) {
      expect(root).not.toContain(`  ${deferred}`);
    }
  });
});
