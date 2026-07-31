import { spawn, type SpawnOptions } from "node:child_process";
import { describe, it, expect, afterEach, vi } from "vitest";
import os from "node:os";
import { localProcessLifecycle } from "../tools/operations.js";
import { PersistentShell } from "./persistent-shell.js";

const isWindows = os.platform() === "win32";
const d = describe.skipIf(isWindows);

d("PersistentShell", () => {
  let shell: PersistentShell | null = null;

  afterEach(() => {
    shell?.kill();
    shell = null;
  });

  function make(): PersistentShell {
    shell = new PersistentShell(os.tmpdir(), { ...process.env, TERM: "dumb" }, 1024 * 1024);
    return shell;
  }

  const signal = () => new AbortController().signal;

  it("spawns the session shell as a detached process-group owner", async () => {
    const spawnProcess = vi.fn((command: string, args: string[], options: SpawnOptions) =>
      spawn(command, args, options),
    );
    shell = new PersistentShell(os.tmpdir(), { ...process.env, TERM: "dumb" }, 1024 * 1024, {
      ...localProcessLifecycle,
      spawn: spawnProcess,
    });

    await shell.run("true", 10_000, signal());

    expect(spawnProcess).toHaveBeenCalledWith(
      "bash",
      ["--norc", "--noprofile"],
      expect.objectContaining({ detached: true }),
    );
  });

  it("runs a command and returns output + exit code", async () => {
    const sh = make();
    const res = await sh.run("echo hello", 10_000, signal());
    expect(res).toMatchObject({
      reason: "completed",
      exitCode: 0,
      signal: null,
      output: "hello\n",
      outputSnapshot: { content: "hello\n", capped: false },
    });
  });

  it("propagates non-zero exit codes", async () => {
    const sh = make();
    const res = await sh.run("exit 3", 10_000, signal());
    expect(res.exitCode).toBe(3);
  });

  it("persists cd and env vars across calls — the point of the feature", async () => {
    const sh = make();
    await sh.run("cd / && export GG_PSH_TEST=alive", 10_000, signal());
    const res = await sh.run('pwd; echo "$GG_PSH_TEST"', 10_000, signal());
    expect(res.output).toBe("/\nalive\n");
  });

  it("stdin-reading commands don't eat the sentinel or hang", async () => {
    const sh = make();
    const res = await sh.run("cat", 5_000, signal());
    expect(res.exitCode).toBe(0);
    // Session still healthy afterwards.
    const next = await sh.run("echo ok", 5_000, signal());
    expect(next.output).toBe("ok\n");
  });

  it("timeout kills the session; the next call gets a fresh shell", async () => {
    const sh = make();
    await sh.run("export GG_PSH_STATE=set", 10_000, signal());
    const timedOut = await sh.run("sleep 30", 300, signal());
    expect(timedOut).toMatchObject({ reason: "timedOut", exitCode: null, signal: null });
    // Fresh shell: the exported var from before the timeout is gone.
    const res = await sh.run('echo "[$GG_PSH_STATE]"', 10_000, signal());
    expect(res.output).toBe("[]\n");
  });

  it("over-cap output still finds the sentinel — no hang, session survives", async () => {
    shell = new PersistentShell(os.tmpdir(), { ...process.env, TERM: "dumb" }, 512);
    const sh = shell;
    await sh.run("export GG_PSH_CAP=kept", 10_000, signal());
    // ~40KB of output, way past the 512-byte cap.
    const res = await sh.run('yes x | head -n 20000; echo "end"', 10_000, signal());
    expect(res).toMatchObject({
      reason: "completed",
      exitCode: 0,
      outputSnapshot: { capped: true, retainedLines: 100 },
    });
    expect(res.outputSnapshot.totalInputBytes).toBeGreaterThan(512);
    expect(res.outputSnapshot.retainedBytes).toBeLessThanOrEqual(512);
    expect(res.outputSnapshot.content).toBe(res.output);
    expect(res.output.endsWith("end\n")).toBe(true);
    // Session state survived — the command completed instead of timing out.
    const after = await sh.run('echo "$GG_PSH_CAP"', 10_000, signal());
    expect(after.output).toBe("kept\n");
  });

  it("does not leak error listeners across many runs", async () => {
    const sh = make();
    for (let i = 0; i < 15; i++) {
      await sh.run("true", 10_000, signal());
    }
    // Access the internal child to count listeners — the leak showed up as
    // MaxListenersExceededWarning after ~10 calls before the fix.
    const child = (sh as unknown as { child: { listenerCount(e: string): number } }).child;
    expect(child.listenerCount("error")).toBeLessThanOrEqual(1);
    expect(child.listenerCount("exit")).toBeLessThanOrEqual(1);
  });

  it("rejects a concurrent call while busy instead of interleaving", async () => {
    const sh = make();
    const slow = sh.run("sleep 0.5; echo done", 10_000, signal());
    const busy = await sh.run("echo nope", 10_000, signal());
    expect(busy.exitCode).toBe(1);
    expect(busy.output).toContain("busy");
    const done = await slow;
    expect(done.output).toBe("done\n");
  });
});
