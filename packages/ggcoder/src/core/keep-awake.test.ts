import { describe, expect, it } from "vitest";
import {
  KeepAwake,
  keepAwakeCommand,
  type KeepAwakeCommand,
  type KeepAwakeProcess,
} from "./keep-awake.js";

interface FakeProcess extends KeepAwakeProcess {
  command: KeepAwakeCommand;
  stopped: number;
  exit(): void;
  fail(code: string): void;
}

function harness(options: { platform?: NodeJS.Platform; enabled?: boolean } = {}) {
  const spawned: FakeProcess[] = [];
  const exitHooks: Array<() => void> = [];
  const logs: string[] = [];
  const keepAwake = new KeepAwake({
    platform: options.platform ?? "darwin",
    pid: 4242,
    enabled: options.enabled,
    log: (_level, message) => logs.push(message),
    onProcessExit: (cleanup) => exitHooks.push(cleanup),
    spawner: (command) => {
      let exitListener: (() => void) | undefined;
      let errorListener: ((error: NodeJS.ErrnoException) => void) | undefined;
      const fake: FakeProcess = {
        command,
        stopped: 0,
        stop() {
          fake.stopped++;
        },
        onExit(listener) {
          exitListener = listener;
        },
        onError(listener) {
          errorListener = listener;
        },
        exit() {
          exitListener?.();
        },
        fail(code) {
          const error: NodeJS.ErrnoException = new Error(`spawn ${command.command} ${code}`);
          error.code = code;
          errorListener?.(error);
        },
      };
      spawned.push(fake);
      return fake;
    },
  });
  return { keepAwake, spawned, exitHooks, logs };
}

describe("keepAwakeCommand", () => {
  it("uses caffeinate -i tied to our pid on macOS", () => {
    expect(keepAwakeCommand("darwin", 123)).toEqual({
      command: "caffeinate",
      args: ["-i", "-w", "123"],
    });
  });

  it("uses systemd-inhibit for idle+sleep on Linux, tied to our pid", () => {
    const cmd = keepAwakeCommand("linux", 123);
    expect(cmd?.command).toBe("systemd-inhibit");
    expect(cmd?.args).toEqual([
      "--what=idle:sleep",
      "--who=Kleio",
      "--why=Agent is working",
      "--mode=block",
      "tail",
      "--pid=123",
      "-f",
      "/dev/null",
    ]);
  });

  it("uses a hidden PowerShell SetThreadExecutionState holder on Windows", () => {
    const cmd = keepAwakeCommand("win32", 123);
    expect(cmd?.command).toBe("powershell.exe");
    expect(cmd?.args).toContain("-NonInteractive");
    expect(cmd?.args).toContain("Hidden");
    const encoded = cmd?.args[cmd.args.indexOf("-EncodedCommand") + 1] ?? "";
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("SetThreadExecutionState([uint32]2147483649)");
    expect(script).toContain("Wait-Process -Id 123");
  });

  it("has no command on other platforms", () => {
    expect(keepAwakeCommand("freebsd", 123)).toBeNull();
  });
});

describe("KeepAwake", () => {
  it("shares one OS holder across overlapping holds and kills it on the last release", () => {
    const { keepAwake, spawned } = harness();
    const releaseRun = keepAwake.acquire("run");
    const releaseKen = keepAwake.acquire("ken");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.command).toEqual({ command: "caffeinate", args: ["-i", "-w", "4242"] });
    expect(keepAwake.holderCount).toBe(2);

    releaseRun();
    expect(spawned[0]?.stopped).toBe(0);
    expect(keepAwake.asserting).toBe(true);

    releaseKen();
    expect(spawned[0]?.stopped).toBe(1);
    expect(keepAwake.asserting).toBe(false);
  });

  it("treats a second release of the same hold as a no-op", () => {
    const { keepAwake, spawned } = harness();
    const releaseA = keepAwake.acquire("a");
    keepAwake.acquire("b");
    releaseA();
    releaseA();
    expect(keepAwake.holderCount).toBe(1);
    expect(spawned[0]?.stopped).toBe(0);
  });

  it("respawns for a fresh hold after the previous one was released", () => {
    const { keepAwake, spawned } = harness();
    keepAwake.acquire("first")();
    keepAwake.acquire("second");
    expect(spawned).toHaveLength(2);
    expect(spawned[0]?.stopped).toBe(1);
    expect(spawned[1]?.stopped).toBe(0);
  });

  it("does nothing while disabled and follows the setting live", () => {
    const { keepAwake, spawned } = harness({ enabled: false });
    const release = keepAwake.acquire("run");
    expect(spawned).toHaveLength(0);

    keepAwake.setEnabled(true);
    expect(spawned).toHaveLength(1);

    keepAwake.setEnabled(false);
    expect(spawned[0]?.stopped).toBe(1);
    expect(keepAwake.holderCount).toBe(1);

    release();
    keepAwake.setEnabled(true);
    expect(spawned).toHaveLength(1);
  });

  it("becomes a permanent no-op when the tool is missing", () => {
    const { keepAwake, spawned, logs } = harness({ platform: "linux" });
    keepAwake.acquire("run");
    spawned[0]?.fail("ENOENT");
    expect(keepAwake.asserting).toBe(false);
    expect(logs).toContain("keep-awake tool not found; skipping");

    keepAwake.acquire("another");
    expect(spawned).toHaveLength(1);
  });

  it("no-ops on platforms without a tool", () => {
    const { keepAwake, spawned } = harness({ platform: "aix" });
    const release = keepAwake.acquire("run");
    expect(spawned).toHaveLength(0);
    release();
  });

  it("survives a spawner that throws", () => {
    const keepAwake = new KeepAwake({
      platform: "darwin",
      log: () => {},
      onProcessExit: () => {},
      spawner: () => {
        throw new Error("EAGAIN");
      },
    });
    const release = keepAwake.acquire("run");
    expect(keepAwake.asserting).toBe(false);
    release();
  });

  it("does not respawn in a loop when the holder dies on its own", () => {
    const { keepAwake, spawned } = harness();
    const release = keepAwake.acquire("run");
    spawned[0]?.exit();
    expect(keepAwake.asserting).toBe(false);

    const releaseOverlap = keepAwake.acquire("overlap");
    expect(spawned).toHaveLength(1);

    // Once every hold is gone, the next run tries again.
    release();
    releaseOverlap();
    keepAwake.acquire("next");
    expect(spawned).toHaveLength(2);
  });

  it("ignores the exit of a holder it already stopped", () => {
    const { keepAwake, spawned } = harness();
    keepAwake.acquire("first")();
    keepAwake.acquire("second");
    spawned[0]?.exit();
    expect(keepAwake.asserting).toBe(true);
  });

  it("kills the holder on dispose and on process exit", () => {
    const { keepAwake, spawned, exitHooks } = harness();
    keepAwake.acquire("run");
    expect(exitHooks).toHaveLength(1);
    exitHooks[0]?.();
    expect(spawned[0]?.stopped).toBe(1);
    expect(keepAwake.holderCount).toBe(0);
    keepAwake.dispose();
    expect(spawned[0]?.stopped).toBe(1);
  });
});
