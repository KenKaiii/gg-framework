/**
 * Blocking wait on a background process: the alternative to a guessed
 * `sleep N`, so the agent resumes the instant the process actually exits.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProcessManager } from "./process-manager.js";

const managers: ProcessManager[] = [];
const tempDirs: string[] = [];

async function manager(): Promise<ProcessManager> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gg-process-wait-"));
  tempDirs.push(directory);
  const instance = new ProcessManager({ bgDir: directory });
  managers.push(instance);
  return instance;
}

afterEach(async () => {
  for (const instance of managers.splice(0)) instance.shutdownAll();
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("ProcessManager.waitForExitOrWake", () => {
  it("returns as soon as the process exits, well before the timeout", async () => {
    const pm = await manager();
    const { id } = await pm.start("sleep 1; echo done", process.cwd());
    const startedAt = Date.now();

    expect(await pm.waitForExitOrWake(id, 30_000)).toBe("exited");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    // Exit state is settled by the time the wait resolves, so the read that
    // follows reports "exited", not a stale "running".
    expect((await pm.readOutput(id)).isRunning).toBe(false);
  });

  it("reports a timeout while leaving the process running", async () => {
    const pm = await manager();
    const { id } = await pm.start("sleep 30", process.cwd());

    expect(await pm.waitForExitOrWake(id, 1000)).toBe("timeout");
    expect((await pm.readOutput(id)).isRunning).toBe(true);
  });

  it("returns immediately for an already-exited process and unknown ids", async () => {
    const pm = await manager();
    const { id } = await pm.start("echo quick", process.cwd());
    await pm.waitForExitOrWake(id, 30_000);

    expect(await pm.waitForExitOrWake(id, 30_000)).toBe("exited");
    expect(await pm.waitForExitOrWake("nope1234", 30_000)).toBe("unknown");
  });
});

describe("ProcessManager.waitForExitOrWake cancellation", () => {
  it("gives up the wait when the caller aborts, leaving the process alive", async () => {
    const pm = await manager();
    const { id } = await pm.start("sleep 30", process.cwd());
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    expect(await pm.waitForExitOrWake(id, 30_000, controller.signal)).toBe("timeout");
    expect((await pm.readOutput(id)).isRunning).toBe(true);
  });

  it("returns at once when the signal is already aborted", async () => {
    const pm = await manager();
    const { id } = await pm.start("sleep 30", process.cwd());

    expect(await pm.waitForExitOrWake(id, 30_000, AbortSignal.abort())).toBe("timeout");
  });
});

describe("ProcessManager spawn failure", () => {
  it("does not crash the host when the child fails to spawn, and still settles", async () => {
    const pm = await manager();
    const { id } = await pm.start("echo hi", process.cwd(), {
      file: "definitely-not-a-real-binary-xyz",
      args: [],
      isCmdFallback: false,
    });

    // An 'error' with no listener would be rethrown as an uncaught exception;
    // reaching this assertion at all proves it was handled.
    expect(await pm.waitForExitOrWake(id, 30_000)).toBe("exited");
    expect((await pm.readOutput(id)).isRunning).toBe(false);
  });

  it("never signals a pid for a child that failed to spawn", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gg-process-wait-"));
    tempDirs.push(directory);
    const signalled: unknown[] = [];
    const pm = new ProcessManager({
      bgDir: directory,
      kill: (pid) => {
        signalled.push(pid);
        return true;
      },
      killProcessTree: (pid) => void signalled.push(pid),
    });
    managers.push(pm);

    const { id, pid } = await pm.start("echo hi", process.cwd(), {
      file: "definitely-not-a-real-binary-xyz",
      args: [],
      isCmdFallback: false,
    });

    expect(pid).toBe(0);
    expect(await pm.stop(id)).toMatch(/failed to start|already exited/);
    pm.shutdownAll();
    expect(signalled).toEqual([]);
  });
});
