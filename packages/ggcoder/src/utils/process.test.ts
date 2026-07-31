import type { spawn, spawnSync } from "node:child_process";
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as logger from "../core/logger.js";
import {
  DEFAULT_POSIX_TERM_GRACE_MS,
  killProcessTree,
  killProcessTreeAsync,
  reapProcessWrapper,
  resolveWindowsTaskkillPath,
} from "./process.js";

function createKiller(): {
  child: ChildProcess;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  events: EventEmitter;
} {
  const events = new EventEmitter();
  const kill = vi.fn(() => true);
  const unref = vi.fn();
  return {
    child: Object.assign(events, { kill, unref }) as unknown as ChildProcess,
    kill,
    unref,
    events,
  };
}

function errno(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function aliveKill(): typeof process.kill {
  return vi.fn(() => true) as unknown as typeof process.kill;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createPsHelper(): {
  child: ChildProcess;
  stdout: PassThrough;
  events: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const kill = vi.fn(() => true);
  return {
    child: Object.assign(events, { stdout, kill }) as unknown as ChildProcess,
    stdout,
    events,
    kill,
  };
}

function successfulPsSync(stdout: string): typeof spawnSync {
  return vi.fn(() => ({
    pid: 1,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
  })) as unknown as typeof spawnSync;
}

describe("POSIX process-tree cleanup", () => {
  it.each([0, -1, Number.NaN, 1.5])(
    "rejects invalid PID %s without constructing a PGID",
    async (pid) => {
      const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
      const kill = aliveKill();
      const spawnSyncMock = successfulPsSync("");
      const spawnMock = vi.fn() as unknown as typeof spawn;

      killProcessTree(pid, { platform: "linux", kill, spawnSync: spawnSyncMock });
      await killProcessTreeAsync(pid, { platform: "linux", kill, spawn: spawnMock });

      expect(kill).not.toHaveBeenCalled();
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledTimes(2);
    },
  );

  it("hard-kills the exact process group without blocking", () => {
    const kill = aliveKill();
    const spawnSyncMock = successfulPsSync("20 10\n30 20\n");

    killProcessTree(10, { platform: "linux", kill, spawnSync: spawnSyncMock });

    expect(spawnSyncMock).toHaveBeenCalledWith("/bin/ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 150,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    expect(kill).toHaveBeenCalledWith(-10, "SIGKILL");
  });

  it("leaves descendants untouched when the root PID is reused during a synchronous snapshot", () => {
    const spawnSyncMock = successfulPsSync("124 123\n");
    const kill = aliveKill();
    const isExited = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);

    killProcessTree({ pid: 123, isExited }, { platform: "linux", kill, spawnSync: spawnSyncMock });

    expect(spawnSyncMock).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
    expect(isExited).toHaveBeenCalledTimes(2);
  });

  it("kills captured descendants when the committed synchronous root exits before signaling", () => {
    const spawnSyncMock = successfulPsSync("124 123\n");
    const kill = aliveKill();
    const isExited = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);

    killProcessTree({ pid: 123, isExited }, { platform: "linux", kill, spawnSync: spawnSyncMock });

    expect(kill).toHaveBeenCalledWith(124, "SIGKILL");
    expect(kill).not.toHaveBeenCalledWith(-123, "SIGKILL");
    expect(kill).not.toHaveBeenCalledWith(123, "SIGKILL");
    expect(isExited).toHaveBeenCalledTimes(3);
  });

  it("does not snapshot or signal a live numeric PID after the original child exited", () => {
    const spawnSyncMock = successfulPsSync("778 777\n");
    const kill = aliveKill();

    killProcessTree(
      { pid: 777, isExited: () => true },
      { platform: "linux", kill, spawnSync: spawnSyncMock },
    );

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("falls back deepest-first and caps the rooted descendant snapshot", () => {
    const calls: Array<[number, NodeJS.Signals | number]> = [];
    const kill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      calls.push([pid, signal ?? 0]);
      if (pid === -10 && signal === "SIGKILL") throw errno("EPERM", "group blocked");
      return true;
    }) as unknown as typeof process.kill;

    killProcessTree(10, {
      platform: "darwin",
      kill,
      spawnSync: successfulPsSync("20 10\n30 20\n40 10\n50 30\n999 998\n"),
      posixMaxDescendants: 3,
    });

    const signals = calls.filter(([, signal]) => signal === "SIGKILL");
    expect(signals).toEqual([
      [-10, "SIGKILL"],
      [30, "SIGKILL"],
      [20, "SIGKILL"],
      [40, "SIGKILL"],
      [10, "SIGKILL"],
    ]);
    expect(calls.some(([pid]) => pid === 50 || pid === 999)).toBe(false);
  });

  it("degrades a failed synchronous snapshot to exact group/direct handling", () => {
    const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
    const kill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -77 && signal === "SIGKILL") throw errno("EPERM", "blocked");
      return true;
    }) as unknown as typeof process.kill;
    const spawnSyncMock = vi.fn(() => {
      throw errno("ENOENT", "missing ps");
    }) as unknown as typeof spawnSync;

    killProcessTree(77, { platform: "linux", kill, spawnSync: spawnSyncMock });

    expect(warning).toHaveBeenCalledWith(
      "WARN",
      "process",
      "POSIX descendant snapshot failed",
      expect.objectContaining({ pid: "77", error: "missing ps" }),
    );
    expect(kill).toHaveBeenCalledWith(77, "SIGKILL");
  });

  it("leaves descendants untouched when the root PID is reused during an async snapshot", async () => {
    const helper = createPsHelper();
    const kill = aliveKill();
    const isExited = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const cleanup = killProcessTreeAsync(
      { pid: 123, isExited },
      {
        platform: "linux",
        kill,
        spawn: vi.fn(() => helper.child) as unknown as typeof spawn,
      },
    );
    helper.stdout.end("124 123\n");
    helper.events.emit("close", 0);
    await cleanup;

    expect(kill).not.toHaveBeenCalled();
    expect(isExited).toHaveBeenCalledTimes(2);
  });

  it("kills captured descendants when the committed async root exits before TERM signaling", async () => {
    const helper = createPsHelper();
    const kill = aliveKill();
    const isExited = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const cleanup = killProcessTreeAsync(
      { pid: 123, isExited },
      {
        platform: "linux",
        kill,
        spawn: vi.fn(() => helper.child) as unknown as typeof spawn,
      },
    );
    helper.stdout.end("124 123\n");
    helper.events.emit("close", 0);
    await cleanup;

    expect(kill).toHaveBeenCalledWith(124, "SIGKILL");
    expect(kill).not.toHaveBeenCalledWith(-123, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(-123, "SIGKILL");
    expect(kill).not.toHaveBeenCalledWith(123, "SIGKILL");
    expect(isExited).toHaveBeenCalledTimes(3);
  });

  it("uses TERM only when the group exits during the grace period", async () => {
    vi.useFakeTimers();
    const helper = createPsHelper();
    let termSent = false;
    const kill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -123 && signal === "SIGTERM") termSent = true;
      if (signal === 0 && termSent) throw errno("ESRCH");
      return true;
    }) as unknown as typeof process.kill;
    const cleanup = killProcessTreeAsync(123, {
      platform: "linux",
      kill,
      spawn: vi.fn(() => helper.child) as unknown as typeof spawn,
    });
    helper.stdout.end("124 123\n");
    helper.events.emit("close", 0);
    await vi.advanceTimersByTimeAsync(DEFAULT_POSIX_TERM_GRACE_MS);
    await cleanup;

    expect(kill).toHaveBeenCalledWith(-123, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(-123, "SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("escalates a live group from TERM to KILL after the injected grace", async () => {
    vi.useFakeTimers();
    const helper = createPsHelper();
    const kill = aliveKill();
    const cleanup = killProcessTreeAsync(222, {
      platform: "linux",
      kill,
      spawn: vi.fn(() => helper.child) as unknown as typeof spawn,
      posixGraceMs: 25,
    });
    helper.stdout.end("");
    helper.events.emit("close", 0);
    await vi.advanceTimersByTimeAsync(24);
    expect(kill).toHaveBeenCalledWith(-222, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(-222, "SIGKILL");
    await vi.advanceTimersByTimeAsync(1);
    await cleanup;
    expect(kill).toHaveBeenCalledWith(-222, "SIGKILL");
  });

  it("re-checks the original child after TERM grace before KILL escalation", async () => {
    vi.useFakeTimers();
    const helper = createPsHelper();
    const kill = aliveKill();
    let exited = false;
    const cleanup = killProcessTreeAsync(
      { pid: 223, isExited: () => exited },
      {
        platform: "linux",
        kill,
        spawn: vi.fn(() => helper.child) as unknown as typeof spawn,
        posixGraceMs: 25,
      },
    );
    helper.stdout.end("");
    helper.events.emit("close", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(kill).toHaveBeenCalledWith(-223, "SIGTERM");

    exited = true;
    await vi.advanceTimersByTimeAsync(25);
    await cleanup;

    expect(kill).not.toHaveBeenCalledWith(-223, "SIGKILL");
  });

  it("kills captured detached descendants after the TERM-killed root exits", async () => {
    vi.useFakeTimers();
    const helper = createPsHelper();
    let exited = false;
    const kill = aliveKill();
    const cleanup = killProcessTreeAsync(
      { pid: 223, isExited: () => exited },
      {
        platform: "linux",
        kill,
        spawn: vi.fn(() => helper.child) as unknown as typeof spawn,
        posixGraceMs: 25,
      },
    );
    helper.stdout.end("224 223\n");
    helper.events.emit("close", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(kill).toHaveBeenCalledWith(-223, "SIGTERM");

    exited = true;
    await vi.advanceTimersByTimeAsync(25);
    await cleanup;

    expect(kill).toHaveBeenCalledWith(224, "SIGKILL");
    expect(kill).not.toHaveBeenCalledWith(-223, "SIGKILL");
    expect(kill).not.toHaveBeenCalledWith(223, "SIGKILL");
  });

  it("falls back to snapshotted descendants when group signaling fails", async () => {
    vi.useFakeTimers();
    const helper = createPsHelper();
    const kill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -300 && signal !== 0) throw errno("EPERM", "group blocked");
      return true;
    }) as unknown as typeof process.kill;
    const cleanup = killProcessTreeAsync(300, {
      platform: "linux",
      kill,
      spawn: vi.fn(() => helper.child) as unknown as typeof spawn,
      posixGraceMs: 10,
    });
    helper.stdout.end("301 300\n302 301\n");
    helper.events.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await cleanup;

    const sentSignals = (kill as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, signal]) => signal === "SIGTERM" || signal === "SIGKILL",
    );
    expect(sentSignals).toEqual([
      [-300, "SIGTERM"],
      [302, "SIGTERM"],
      [301, "SIGTERM"],
      [300, "SIGTERM"],
      [-300, "SIGKILL"],
      [302, "SIGKILL"],
      [301, "SIGKILL"],
      [300, "SIGKILL"],
    ]);
  });

  it("falls back to live descendants when the process group no longer exists", async () => {
    vi.useFakeTimers();
    const helper = createPsHelper();
    const kill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -350 && signal !== 0) throw errno("ESRCH");
      return true;
    }) as unknown as typeof process.kill;
    const cleanup = killProcessTreeAsync(350, {
      platform: "linux",
      kill,
      spawn: vi.fn(() => helper.child) as unknown as typeof spawn,
      posixGraceMs: 10,
    });
    helper.stdout.end("351 350\n");
    helper.events.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);
    await cleanup;

    const sentSignals = (kill as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, signal]) => signal === "SIGTERM" || signal === "SIGKILL",
    );
    expect(sentSignals).toEqual([
      [-350, "SIGTERM"],
      [351, "SIGTERM"],
      [350, "SIGTERM"],
      [-350, "SIGKILL"],
      [351, "SIGKILL"],
      [350, "SIGKILL"],
    ]);
  });

  it("kills and reaps a timed-out ps helper and removes its listeners", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
    const helper = createPsHelper();
    const kill = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === "SIGTERM") throw errno("ESRCH");
      return true;
    }) as unknown as typeof process.kill;
    const cleanup = killProcessTreeAsync(400, {
      platform: "linux",
      kill,
      spawn: vi.fn(() => helper.child) as unknown as typeof spawn,
      posixPsTimeoutMs: 20,
      posixGraceMs: 10,
    });

    expect(helper.events.listenerCount("close")).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(helper.kill).toHaveBeenCalledWith("SIGKILL");
    expect(helper.events.listenerCount("close")).toBe(1);
    helper.events.emit("close", null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(10);
    await cleanup;

    expect(helper.kill).toHaveBeenCalledWith("SIGKILL");
    expect(helper.events.listenerCount("error")).toBe(0);
    expect(helper.events.listenerCount("close")).toBe(0);
    expect(helper.stdout.listenerCount("data")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(warning).toHaveBeenCalledWith(
      "WARN",
      "process",
      "POSIX descendant snapshot failed",
      expect.objectContaining({ error: "ps timed out" }),
    );
  });
});

describe("killProcessTree on Windows", () => {
  it("resolves taskkill only from System32 with a safe fallback", () => {
    expect(resolveWindowsTaskkillPath({ SystemRoot: "  D:\\WinRoot  " })).toBe(
      "D:\\WinRoot\\System32\\taskkill.exe",
    );
    expect(resolveWindowsTaskkillPath({})).toBe("C:\\Windows\\System32\\taskkill.exe");
  });

  it("uses WINDIR when SystemRoot is unavailable", () => {
    expect(resolveWindowsTaskkillPath({ WINDIR: "E:\\Windows" })).toBe(
      "E:\\Windows\\System32\\taskkill.exe",
    );
  });

  it("looks up Windows environment keys case-insensitively", () => {
    expect(resolveWindowsTaskkillPath({ systemroot: "F:\\Windows" })).toBe(
      "F:\\Windows\\System32\\taskkill.exe",
    );
    expect(resolveWindowsTaskkillPath({ windir: "G:\\Windows" })).toBe(
      "G:\\Windows\\System32\\taskkill.exe",
    );
  });

  it.each([
    ["relative", { SystemRoot: ".\\Windows" }],
    ["drive-relative", { SystemRoot: "C:Windows" }],
    ["UNC", { SystemRoot: "\\\\server\\Windows" }],
    ["semicolon injection", { SystemRoot: "C:\\Windows;C:\\attacker" }],
    ["newline injection", { SystemRoot: "C:\\Windows\nC:\\attacker" }],
    ["control-character injection", { SystemRoot: "C:\\Win\u0000dows" }],
  ])("rejects %s SystemRoot values", (_label, env) => {
    expect(resolveWindowsTaskkillPath(env)).toBe("C:\\Windows\\System32\\taskkill.exe");
  });

  it("uses a valid WINDIR when SystemRoot is unsafe", () => {
    expect(
      resolveWindowsTaskkillPath({ SystemRoot: "\\\\attacker\\Windows", WINDIR: "D:\\Windows" }),
    ).toBe("D:\\Windows\\System32\\taskkill.exe");
  });

  it("treats an already-dead PID as a successful no-op", () => {
    const kill = vi.fn(() => {
      throw errno("ESRCH");
    }) as unknown as typeof process.kill;
    const spawnSyncMock = vi.fn() as unknown as typeof spawnSync;

    killProcessTree(111, { platform: "win32", kill, spawnSync: spawnSyncMock });

    expect(kill).toHaveBeenCalledWith(111, 0);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("uses the absolute executable and PID-only tree arguments", () => {
    const spawnSyncMock = vi.fn(() => ({
      pid: 1,
      output: [],
      stdout: null,
      stderr: null,
      status: 0,
      signal: null,
    })) as unknown as typeof spawnSync;
    const kill = aliveKill();

    killProcessTree(4321, {
      platform: "win32",
      kill,
      spawnSync: spawnSyncMock,
      env: { SystemRoot: "C:\\TrustedWindows" },
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "C:\\TrustedWindows\\System32\\taskkill.exe",
      ["/PID", "4321", "/T", "/F"],
      { stdio: "ignore", windowsHide: true, timeout: 5_000 },
    );
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("skips taskkill when a live numeric PID no longer belongs to the original child", () => {
    const kill = aliveKill();
    const spawnSyncMock = vi.fn() as unknown as typeof spawnSync;

    killProcessTree(
      { pid: 4321, isExited: () => true },
      { platform: "win32", kill, spawnSync: spawnSyncMock },
    );

    expect(kill).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("re-checks the original child immediately before launching taskkill", () => {
    const kill = aliveKill();
    const spawnSyncMock = vi.fn() as unknown as typeof spawnSync;
    const isExited = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);

    killProcessTree({ pid: 4321, isExited }, { platform: "win32", kill, spawnSync: spawnSyncMock });

    expect(kill).toHaveBeenCalledWith(4321, 0);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("passes an injected timeout to synchronous taskkill", () => {
    const spawnSyncMock = vi.fn(() => ({
      pid: 1,
      output: [],
      stdout: null,
      stderr: null,
      status: 0,
      signal: null,
    })) as unknown as typeof spawnSync;

    killProcessTree(4321, {
      platform: "win32",
      kill: aliveKill(),
      spawnSync: spawnSyncMock,
      taskkillTimeoutMs: 250,
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeout: 250 }),
    );
  });

  it("logs access-denied launch failures and tries the direct PID fallback", () => {
    const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
    const spawnSyncMock = vi.fn(() => {
      throw errno("EACCES", "blocked");
    }) as unknown as typeof spawnSync;
    const kill = aliveKill();

    killProcessTree(8765, { platform: "win32", kill, spawnSync: spawnSyncMock });

    expect(warning).toHaveBeenCalledWith(
      "WARN",
      "process",
      "Windows process-tree cleanup failed",
      expect.objectContaining({
        pid: "8765",
        executable: expect.stringMatching(/System32\\taskkill\.exe$/),
        failureKind: "access-denied",
        error: "blocked",
      }),
    );
    expect(kill).toHaveBeenCalledWith(8765, "SIGKILL");
  });

  it("suppresses a non-zero failure when the PID exited before the post-check", () => {
    const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
    let probes = 0;
    const kill = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && probes++ > 0) throw errno("ESRCH");
      return true;
    }) as unknown as typeof process.kill;
    const spawnSyncMock = vi.fn(() => ({
      pid: 1,
      output: [],
      stdout: null,
      stderr: null,
      status: 128,
      signal: null,
    })) as unknown as typeof spawnSync;

    killProcessTree(222, { platform: "win32", kill, spawnSync: spawnSyncMock });

    expect(warning).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalledWith(222, "SIGKILL");
  });
});

describe("exact-PID wrapper reap", () => {
  it("signals only the positive wrapper PID on POSIX", () => {
    const kill = aliveKill();

    reapProcessWrapper(2468, { platform: "linux", kill });

    expect(kill).toHaveBeenCalledWith(2468, 0);
    expect(kill).toHaveBeenCalledWith(2468, "SIGKILL");
    expect(kill).not.toHaveBeenCalledWith(-2468, expect.anything());
  });

  it("uses taskkill without tree traversal on Windows", () => {
    const spawnSyncMock = vi.fn(() => ({
      pid: 1,
      output: [],
      stdout: null,
      stderr: null,
      status: 0,
      signal: null,
    })) as unknown as typeof spawnSync;

    reapProcessWrapper(2468, {
      platform: "win32",
      kill: aliveKill(),
      spawnSync: spawnSyncMock,
      env: { SystemRoot: "C:\\Windows" },
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/PID", "2468", "/F"],
      { stdio: "ignore", windowsHide: true, timeout: 5_000 },
    );
  });

  it("does nothing when the wrapper handle says its numeric PID was reused", () => {
    const kill = aliveKill();
    const spawnSyncMock = vi.fn() as unknown as typeof spawnSync;

    reapProcessWrapper(
      { pid: 2468, isExited: () => true },
      { platform: "win32", kill, spawnSync: spawnSyncMock },
    );

    expect(kill).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});

describe("killProcessTreeAsync on Windows", () => {
  it("waits for success and cleans listeners", async () => {
    const killer = createKiller();
    const spawnMock = vi.fn(() => killer.child) as unknown as typeof spawn;
    const kill = aliveKill();
    let settled = false;

    const cleanup = killProcessTreeAsync(4321, {
      platform: "win32",
      spawn: spawnMock,
      kill,
      env: { SystemRoot: "C:\\Windows" },
    });
    void cleanup.then(() => {
      settled = true;
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/PID", "4321", "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    expect(killer.unref).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(settled).toBe(false);

    killer.events.emit("close", 0, null);
    await cleanup;
    expect(kill).toHaveBeenCalledTimes(1);
    expect(killer.events.listenerCount("error")).toBe(0);
    expect(killer.events.listenerCount("close")).toBe(0);
  });

  it("does not launch taskkill for an exited original child even when its PID probes live", async () => {
    const spawnMock = vi.fn() as unknown as typeof spawn;
    const kill = aliveKill();

    await killProcessTreeAsync(
      { pid: 4321, isExited: () => true },
      { platform: "win32", spawn: spawnMock, kill },
    );

    expect(kill).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("re-checks the original child before direct-PID fallback", async () => {
    const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
    const killer = createKiller();
    const kill = aliveKill();
    let exited = false;
    const cleanup = killProcessTreeAsync(
      { pid: 4321, isExited: () => exited },
      {
        platform: "win32",
        spawn: vi.fn(() => killer.child) as unknown as typeof spawn,
        kill,
      },
    );

    exited = true;
    killer.events.emit("close", 1, null);
    await cleanup;

    expect(warning).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalledWith(4321, "SIGKILL");
  });

  it("times out taskkill, cleans listeners and timer, then falls back to the target PID", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
    const killer = createKiller();
    const kill = aliveKill();
    const cleanup = killProcessTreeAsync(9876, {
      platform: "win32",
      spawn: vi.fn(() => killer.child) as unknown as typeof spawn,
      kill,
      taskkillTimeoutMs: 250,
    });

    expect(killer.events.listenerCount("error")).toBe(1);
    expect(killer.events.listenerCount("close")).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    await cleanup;

    expect(killer.kill).toHaveBeenCalledOnce();
    expect(killer.kill).toHaveBeenCalledWith("SIGKILL");
    expect(killer.unref).toHaveBeenCalledTimes(2);
    expect(killer.events.listenerCount("error")).toBe(0);
    expect(killer.events.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(warning).toHaveBeenCalledWith(
      "WARN",
      "process",
      "Windows process-tree cleanup failed",
      expect.objectContaining({ pid: "9876", failureKind: "timed-out" }),
    );
    expect(kill).toHaveBeenCalledWith(9876, "SIGKILL");

    killer.events.emit("close", 0, null);
    expect(kill).toHaveBeenCalledTimes(3);
  });

  it("observes an emitted access-denied error and falls back exactly once", async () => {
    const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
    const killer = createKiller();
    const spawnMock = vi.fn(() => killer.child) as unknown as typeof spawn;
    const kill = aliveKill();
    const cleanup = killProcessTreeAsync(8765, { platform: "win32", spawn: spawnMock, kill });

    killer.events.emit("error", errno("EPERM", "denied"));
    killer.events.emit("close", 1, null);
    await cleanup;

    expect(warning).toHaveBeenCalledWith(
      "WARN",
      "process",
      "Windows process-tree cleanup failed",
      expect.objectContaining({ failureKind: "access-denied", error: "denied" }),
    );
    expect(kill).toHaveBeenCalledWith(8765, "SIGKILL");
    expect(kill).toHaveBeenCalledTimes(3);
    expect(killer.events.listenerCount("error")).toBe(0);
    expect(killer.events.listenerCount("close")).toBe(0);
  });

  it("logs a non-zero status and signal", async () => {
    const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
    const killer = createKiller();
    const kill = aliveKill();
    const cleanup = killProcessTreeAsync(333, {
      platform: "win32",
      spawn: vi.fn(() => killer.child) as unknown as typeof spawn,
      kill,
    });

    killer.events.emit("close", 9, "SIGTERM");
    await cleanup;

    expect(warning).toHaveBeenCalledWith(
      "WARN",
      "process",
      "Windows process-tree cleanup failed",
      expect.objectContaining({
        pid: "333",
        failureKind: "non-zero",
        status: "9",
        signal: "SIGTERM",
      }),
    );
  });

  it("suppresses an asynchronous failure after the target exits", async () => {
    const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
    const killer = createKiller();
    let probes = 0;
    const kill = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && probes++ > 0) throw errno("ESRCH");
      return true;
    }) as unknown as typeof process.kill;
    const cleanup = killProcessTreeAsync(444, {
      platform: "win32",
      spawn: vi.fn(() => killer.child) as unknown as typeof spawn,
      kill,
    });

    killer.events.emit("close", 1, null);
    await cleanup;

    expect(warning).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalledWith(444, "SIGKILL");
  });

  it("handles synchronous spawn throws and logs a live fallback failure", async () => {
    const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
    const kill = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === "SIGKILL") throw errno("EACCES", "fallback blocked");
      return true;
    }) as unknown as typeof process.kill;

    await killProcessTreeAsync(555, {
      platform: "win32",
      spawn: vi.fn(() => {
        throw errno("ENOENT", "missing taskkill");
      }) as unknown as typeof spawn,
      kill,
    });

    expect(warning).toHaveBeenCalledWith(
      "WARN",
      "process",
      "Windows process-tree cleanup failed",
      expect.objectContaining({ failureKind: "launch", error: "missing taskkill" }),
    );
    expect(warning).toHaveBeenCalledWith(
      "WARN",
      "process",
      "Direct PID cleanup fallback failed",
      expect.objectContaining({ pid: "555", error: "fallback blocked" }),
    );
  });
});
