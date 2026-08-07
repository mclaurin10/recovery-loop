import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialState } from "../../src/contracts.js";
import {
  ControllerLockedError,
  StateStore,
  type ControllerLockRecord,
} from "../../src/state-store.js";

const roots: string[] = [];
const commit = "a".repeat(40);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storeFixture(): Promise<{ root: string; store: StateStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "recovery-loop-state-"));
  roots.push(root);
  const store = new StateStore(path.join(root, ".git"));
  await store.initialize(
    createInitialState({
      gitCommonDir: path.join(root, ".git"),
      baselineCommit: commit,
      branch: "recovery-loop/work",
      worktreePath: path.join(root, "worktree"),
      sessionId: "rl-test",
      now: "2026-08-07T20:00:00.000Z",
    }),
  );
  return { root, store };
}

describe("atomic state", () => {
  it("round-trips state and rejects an unknown schema", async () => {
    const { store } = await storeFixture();
    expect((await store.readState()).repository.expectedHead).toBe(commit);
    const invalid = { ...(await store.readState()), schemaVersion: 2 };
    await writeFile(store.statePath, JSON.stringify(invalid), "utf8");
    await expect(store.readState()).rejects.toThrow("unsupported schema version");
  });

  it("keeps the old state when interrupted before rename", async () => {
    const { root, store } = await storeFixture();
    const interrupted = new StateStore(path.join(root, ".git"), {
      beforeStateRename: () => {
        throw new Error("crash before rename");
      },
    });
    await expect(
      interrupted.update(
        (draft) => {
          draft.phase = "stopped";
        },
        "2026-08-07T20:01:00.000Z",
      ),
    ).rejects.toThrow("crash before rename");
    expect((await store.readState()).phase).toBe("idle");
    expect((await readdir(store.runtimeRoot)).some((name) => name.startsWith(".state.json.tmp-"))).toBe(
      true,
    );
  });

  it("publishes the new state atomically before an after-rename interruption", async () => {
    const { root, store } = await storeFixture();
    const interrupted = new StateStore(path.join(root, ".git"), {
      afterStateRename: () => {
        throw new Error("crash after rename");
      },
    });
    await expect(
      interrupted.update((draft) => {
        draft.phase = "stopped";
      }),
    ).rejects.toThrow("crash after rename");
    expect((await store.readState()).phase).toBe("stopped");
  });

  it("rejects state bound to another repository, branch, worktree, or baseline", async () => {
    const { root, store } = await storeFixture();
    await expect(
      store.assertRepositoryIdentity({
        gitCommonDir: path.join(root, "other.git"),
        branch: "recovery-loop/work",
        worktreePath: path.join(root, "worktree"),
      }),
    ).rejects.toThrow("different Git common directory");
    await expect(
      store.assertRepositoryIdentity({
        gitCommonDir: path.join(root, ".git"),
        branch: "recovery-loop/other",
        worktreePath: path.join(root, "worktree"),
      }),
    ).rejects.toThrow("branch mismatch");
  });
});

describe("event history", () => {
  it("appends small sequenced events and tolerates one incomplete final line", async () => {
    const { store } = await storeFixture();
    await store.appendEvent({ type: "session-started", headCommit: commit });
    await appendFile(store.eventsPath, '{"sequence":2', "utf8");
    const read = await store.readEvents();
    expect(read.events).toHaveLength(1);
    expect(read.events[0]?.sequence).toBe(1);
    expect(read.ignoredIncompleteFinalLine).toBe(true);
    expect(read.corruptLineNumbers).toEqual([]);
  });

  it("reports earlier corruption without overriding valid state", async () => {
    const { store } = await storeFixture();
    await writeFile(store.eventsPath, "not-json\n", "utf8");
    await store.appendEvent({ type: "checkpoint-created", headCommit: commit });
    const result = await store.readEvents();
    expect(result.corruptLineNumbers).toEqual([1]);
    expect(result.events).toHaveLength(1);
    expect((await store.readState()).eventSequence).toBe(1);
  });

  it("treats event append failure as nonsemantic after state remains durable", async () => {
    const { root, store } = await storeFixture();
    const failing = new StateStore(path.join(root, ".git"), {
      beforeEventAppend: () => {
        throw new Error("event disk error");
      },
    });
    const result = await failing.appendEvent({ type: "session-started", headCommit: commit });
    expect(result).toMatchObject({ written: false, error: "event disk error" });
    expect((await store.readState()).eventSequence).toBe(1);
  });
});

describe("single-controller lock", () => {
  it("refuses a live same-host owner and releases only the matching token", async () => {
    const { store } = await storeFixture();
    const lock = await store.acquireLock("run");
    await expect(store.acquireLock("check")).rejects.toBeInstanceOf(ControllerLockedError);
    expect(await store.releaseLock("wrong-token")).toBe(false);
    expect((await store.peekLock()).status).toBe("valid");
    expect(await lock.release()).toBe(true);
    expect(await lock.release()).toBe(false);
    expect(await store.peekLock()).toEqual({ status: "none" });
  });

  it("quarantines a dead same-host lock and continues", async () => {
    const { store } = await storeFixture();
    const dead: ControllerLockRecord = {
      token: "dead-token",
      pid: 2_000_000_000,
      hostname: hostname(),
      startedAt: "2026-08-07T20:00:00.000Z",
      command: "run",
    };
    await writeFile(store.lockPath, JSON.stringify(dead), "utf8");
    const acquired = await store.acquireLock("run");
    expect(acquired.record.token).not.toBe(dead.token);
    expect((await readdir(store.runtimeRoot)).some((name) => name.includes("stale-") && name.includes("dead-token")))
      .toBe(true);
    await acquired.release();
  });

  it("never steals foreign-host or malformed locks", async () => {
    const { store } = await storeFixture();
    await writeFile(
      store.lockPath,
      JSON.stringify({
        token: "foreign",
        pid: 123,
        hostname: "another-host",
        startedAt: "2026-08-07T20:00:00.000Z",
        command: "run",
      }),
      "utf8",
    );
    await expect(store.acquireLock("run")).rejects.toThrow("another host");
    await writeFile(store.lockPath, "not-json", "utf8");
    await expect(store.acquireLock("run")).rejects.toThrow("malformed");
    expect(await readFile(store.lockPath, "utf8")).toBe("not-json");
  });

  it("survives interruption during creation and release", async () => {
    const { root, store } = await storeFixture();
    const createCrash = new StateStore(path.join(root, ".git"), {
      afterLockCreated: () => {
        throw new Error("crash after lock creation");
      },
    });
    await expect(createCrash.acquireLock("run")).rejects.toThrow("crash after lock creation");
    const snapshot = await store.peekLock();
    expect(snapshot.status).toBe("valid");
    if (snapshot.status === "valid") await store.releaseLock(snapshot.record.token);

    const releaseHook = vi.fn(() => {
      throw new Error("crash before lock release");
    });
    const releaseCrash = new StateStore(path.join(root, ".git"), {
      beforeLockRelease: releaseHook,
    });
    const lock = await releaseCrash.acquireLock("run");
    await expect(lock.release()).rejects.toThrow("crash before lock release");
    expect((await store.peekLock()).status).toBe("valid");
    expect(releaseHook).toHaveBeenCalledOnce();
    await store.releaseLock(lock.record.token);
  });

  it("keeps status-style reads mutation-free", async () => {
    const { store } = await storeFixture();
    await mkdir(store.runtimeRoot, { recursive: true });
    const stateBefore = await readFile(store.statePath, "utf8");
    const filesBefore = await readdir(store.runtimeRoot);
    await store.readState();
    expect(await store.peekLock()).toEqual({ status: "none" });
    expect(await readFile(store.statePath, "utf8")).toBe(stateBefore);
    expect(await readdir(store.runtimeRoot)).toEqual(filesBefore);
    await expect(store.acquireLock("status")).rejects.toThrow("must not acquire");
  });
});

describe("session layout", () => {
  it("creates only the compact run directories and writes an atomic summary", async () => {
    const { store } = await storeFixture();
    const output = await store.writeSummary("rl-test", { stopReason: "budget" });
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ stopReason: "budget" });
    expect(await readdir(path.dirname(output))).toEqual(
      expect.arrayContaining(["agent", "checks", "diagnoses", "summary.json"]),
    );
  });
});
