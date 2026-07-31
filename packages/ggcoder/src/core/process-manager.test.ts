import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { ProcessTarget } from "../utils/process.js";
import { localProcessLifecycle, type ProcessLifecycleAdapter } from "../tools/operations.js";
import {
  ProcessManager,
  type BackgroundProcess,
  type ProcessManagerOptions,
} from "./process-manager.js";

interface FakeChildHarness {
  child: ChildProcess;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  emitSpawn(): void;
  emitError(error: Error): void;
  emitClose(code?: number | null, signal?: NodeJS.Signals | null): void;
}

function fakeChild(pid = 4321): FakeChildHarness {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const state: { exitCode: number | null; signalCode: NodeJS.Signals | null } = {
    exitCode: null,
    signalCode: null,
  };
  Object.defineProperties(emitter, {
    exitCode: { get: () => state.exitCode, configurable: true },
    signalCode: { get: () => state.signalCode, configurable: true },
  });
  const child = Object.assign(emitter, {
    pid,
    stdin,
    stdout,
    stderr,
    unref: vi.fn(),
  }) as unknown as ChildProcess;
  return {
    child,
    stdin,
    stdout,
    stderr,
    emitSpawn() {
      emitter.emit("spawn");
    },
    emitError(error) {
      emitter.emit("error", error);
    },
    emitClose(code = 0, signal = null) {
      state.exitCode = code;
      state.signalCode = signal;
      emitter.emit("close", code, signal);
    },
  };
}

function lifecycle(overrides: Partial<ProcessLifecycleAdapter> = {}): ProcessLifecycleAdapter {
  return { ...localProcessLifecycle, ...overrides };
}

function trackedManager(
  adapter: ProcessLifecycleAdapter,
  options: ProcessManagerOptions = {},
): {
  manager: ProcessManager;
  child: ChildProcess;
  proc: BackgroundProcess;
} {
  const manager = new ProcessManager(adapter, undefined, options);
  const { child } = fakeChild();
  const proc: BackgroundProcess = {
    id: "bg-test",
    pid: child.pid!,
    command: "fixture",
    logFile: "fixture.log",
    startedAt: Date.now(),
    completedAt: null,
    exitCode: null,
    signal: null,
    lastReadOffset: null,
    logSize: 0,
  };
  const internals = manager as unknown as {
    processes: Map<string, BackgroundProcess>;
    children: Map<string, ChildProcess>;
  };
  internals.processes.set(proc.id, proc);
  internals.children.set(proc.id, child);
  return { manager, child, proc };
}

async function managedStopHarness(
  onCleanup: ((fake: FakeChildHarness, target: ProcessTarget) => void | Promise<void>) | undefined,
  options: ProcessManagerOptions = {},
): Promise<{
  manager: ProcessManager;
  fake: FakeChildHarness;
  started: { id: string; pid: number; logFile: string };
  cleanupProcessTree: ReturnType<typeof vi.fn>;
  flushLog(): Promise<void>;
  removeLogRoot(): Promise<void>;
}> {
  const logRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gg-stop-lifecycle-"));
  const fake = fakeChild();
  const chunks: Buffer[] = [];
  let logPath: string | undefined;
  let finishLogFlush: (() => void) | undefined;
  const cleanupProcessTree = vi.fn(async (target: ProcessTarget) => {
    await onCleanup?.(fake, target);
  });
  const manager = new ProcessManager(
    lifecycle({
      spawn: () => {
        queueMicrotask(() => fake.emitSpawn());
        return fake.child;
      },
      cleanupProcessTree,
    }),
    (createdLogPath) => {
      logPath = createdLogPath;
      return new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          finishLogFlush = callback;
        },
      });
    },
    { backgroundLogRoot: logRoot, ...options },
  );
  const started = await manager.start("stop fixture", "/workspace");

  return {
    manager,
    fake,
    started,
    cleanupProcessTree,
    async flushLog() {
      if (!logPath || !finishLogFlush) throw new Error("Log finalization has not started");
      await fs.writeFile(logPath, Buffer.concat(chunks));
      finishLogFlush();
      await Promise.resolve();
    },
    removeLogRoot: () => fs.rm(logRoot, { recursive: true, force: true }),
  };
}

describe("ProcessManager foreground logs", () => {
  it("creates unique foreground log files before returning", async () => {
    const logRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gg-foreground-logs-"));
    try {
      const manager = new ProcessManager(undefined, undefined, { foregroundLogRoot: logRoot });

      const first = await manager.allocateForegroundLog();
      const second = await manager.allocateForegroundLog();

      expect(first.executionId).not.toBe(second.executionId);
      expect(first.logPath).not.toBe(second.logPath);
      expect(path.dirname(first.logPath)).toBe(logRoot);
      await expect(fs.stat(first.logPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
      await expect(fs.stat(second.logPath)).resolves.toMatchObject({
        isFile: expect.any(Function),
      });
      await Promise.all([first.close(), second.close()]);
    } finally {
      await fs.rm(logRoot, { recursive: true, force: true });
    }
  });

  it("retries exclusive file collisions without truncating the existing log", async () => {
    const logRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gg-foreground-collision-"));
    const occupiedLog = path.join(logRoot, "occupied.log");
    await fs.writeFile(occupiedLog, "existing output");
    const createExecutionId = vi
      .fn<() => string>()
      .mockReturnValueOnce("occupied")
      .mockReturnValueOnce("reserved");
    try {
      const manager = new ProcessManager(undefined, undefined, {
        foregroundLogRoot: logRoot,
        createExecutionId,
      });

      const handle = await manager.allocateForegroundLog();

      expect(createExecutionId).toHaveBeenCalledTimes(2);
      expect(handle.executionId).toBe("reserved");
      await expect(fs.readFile(occupiedLog, "utf8")).resolves.toBe("existing output");
      await handle.close();
    } finally {
      await fs.rm(logRoot, { recursive: true, force: true });
    }
  });

  it("opens the stream only after file creation and closes it safely exactly once", async () => {
    const logRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gg-foreground-stream-"));
    const logStream = new PassThrough();
    const endLog = vi.spyOn(logStream, "end");
    const createForegroundLogStream = vi.fn((logPath: string) => {
      expect(existsSync(logPath)).toBe(true);
      return logStream;
    });
    try {
      const manager = new ProcessManager(undefined, undefined, {
        foregroundLogRoot: logRoot,
        createForegroundLogStream,
      });
      const handle = await manager.allocateForegroundLog();

      expect(createForegroundLogStream).toHaveBeenCalledWith(handle.logPath);
      expect(() => logStream.emit("error", new Error("disk failed"))).not.toThrow();
      expect(handle.error?.message).toBe("disk failed");
      expect(() => handle.write("ignored after failure")).not.toThrow();
      const firstClose = handle.close();
      const secondClose = handle.close();

      expect(firstClose).toBe(secondClose);
      await firstClose;
      expect(endLog).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(logRoot, { recursive: true, force: true });
    }
  });

  it("exposes foreground stream backpressure until the buffered write drains", async () => {
    const logRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gg-foreground-drain-"));
    let finishWrite: (() => void) | undefined;
    const logStream = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        finishWrite = callback;
      },
    });
    try {
      const manager = new ProcessManager(undefined, undefined, {
        foregroundLogRoot: logRoot,
        createForegroundLogStream: () => logStream,
      });
      const handle = await manager.allocateForegroundLog();

      expect(handle.write("buffered output")).toBe(false);
      const drained = handle.waitForDrain();
      let didDrain = false;
      void drained.then(() => {
        didDrain = true;
      });

      await Promise.resolve();
      expect(didDrain).toBe(false);
      finishWrite?.();
      await expect(drained).resolves.toBeUndefined();
      await handle.close();
    } finally {
      await fs.rm(logRoot, { recursive: true, force: true });
    }
  });

  it("keeps close pending until delayed buffered output flushes", async () => {
    const logRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gg-foreground-flush-"));
    let finishFlush: (() => void) | undefined;
    const logStream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        finishFlush = callback;
      },
    });
    try {
      const manager = new ProcessManager(undefined, undefined, {
        foregroundLogRoot: logRoot,
        createForegroundLogStream: () => logStream,
      });
      const handle = await manager.allocateForegroundLog();
      handle.write("final output");
      const closing = handle.close();
      let closed = false;
      void closing.then(() => {
        closed = true;
      });

      await Promise.resolve();
      expect(closed).toBe(false);
      finishFlush?.();
      await expect(closing).resolves.toBeUndefined();
    } finally {
      await fs.rm(logRoot, { recursive: true, force: true });
    }
  });

  it("rejects synchronous foreground stream factory failures", async () => {
    const logRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gg-foreground-factory-"));
    const error = new Error("stream factory failed");
    try {
      const manager = new ProcessManager(undefined, undefined, {
        foregroundLogRoot: logRoot,
        createForegroundLogStream: () => {
          throw error;
        },
      });

      await expect(manager.allocateForegroundLog()).rejects.toBe(error);
    } finally {
      await fs.rm(logRoot, { recursive: true, force: true });
    }
  });
});

describe("ProcessManager retention", () => {
  it("captures signal and completion time only after the background log flushes", async () => {
    const fake = fakeChild(1357);
    let now = 1_234_567;
    let finishLogFlush: (() => void) | undefined;
    const logStream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        finishLogFlush = callback;
      },
    });
    const manager = new ProcessManager(
      lifecycle({
        spawn: () => {
          queueMicrotask(() => fake.emitSpawn());
          return fake.child;
        },
      }),
      () => logStream,
      { now: () => now },
    );

    const started = await manager.start("signal fixture", "/workspace");
    fake.emitClose(null, "SIGTERM");

    expect(manager.list()).toEqual([
      expect.objectContaining({
        id: started.id,
        exitCode: null,
        signal: null,
        completedAt: null,
        isRunning: false,
      }),
    ]);

    now = 1_234_999;
    finishLogFlush?.();
    await vi.waitFor(() => {
      expect(manager.list()).toEqual([
        expect.objectContaining({
          id: started.id,
          exitCode: null,
          signal: "SIGTERM",
          completedAt: 1_234_999,
          lastReadOffset: null,
          logSize: 0,
          isRunning: false,
        }),
      ]);
    });
  });

  it("prunes completed records opportunistically from completion time", () => {
    let now = 1_000;
    const manager = new ProcessManager(undefined, undefined, {
      now: () => now,
      completedRecordRetentionMs: 5 * 60 * 1000,
    });
    const record: BackgroundProcess = {
      id: "completed",
      pid: 1,
      command: "done",
      logFile: "done.log",
      startedAt: 0,
      completedAt: 1_000,
      exitCode: 0,
      signal: null,
      lastReadOffset: null,
      logSize: 0,
    };
    const processes = (manager as unknown as { processes: Map<string, BackgroundProcess> })
      .processes;
    processes.set(record.id, record);

    now = 300_999;
    expect(manager.list()).toEqual([
      {
        id: record.id,
        pid: record.pid,
        command: record.command,
        logFile: record.logFile,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        exitCode: record.exitCode,
        signal: record.signal,
        lastReadOffset: record.lastReadOffset,
        logSize: record.logSize,
        isRunning: false,
      },
    ]);
    now = 301_000;
    expect(manager.list()).toEqual([]);
  });

  it("schedules completion-relative record expiry with an unrefed timer", async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      const manager = new ProcessManager(undefined, undefined, {
        now: () => now,
        completedRecordRetentionMs: 5 * 60 * 1000,
      });
      const record: BackgroundProcess = {
        id: "scheduled",
        pid: 2,
        command: "done",
        logFile: "done.log",
        startedAt: 0,
        completedAt: now,
        exitCode: 0,
        signal: null,
        lastReadOffset: null,
        logSize: 0,
      };
      const internals = manager as unknown as {
        processes: Map<string, BackgroundProcess>;
        recordExpiryTimers: Map<string, NodeJS.Timeout>;
        scheduleRecordExpiry(id: string, completedAt: number): void;
      };
      internals.processes.set(record.id, record);
      internals.scheduleRecordExpiry(record.id, record.completedAt!);

      expect(internals.recordExpiryTimers.get(record.id)?.hasRef()).toBe(false);

      now += 5 * 60 * 1000;
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(internals.processes.has(record.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes 48-hour logs while protecting active background and foreground logs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-log-retention-"));
    const backgroundLogRoot = path.join(root, "background");
    const foregroundLogRoot = path.join(root, "foreground");
    await Promise.all([
      fs.mkdir(backgroundLogRoot, { recursive: true }),
      fs.mkdir(foregroundLogRoot, { recursive: true }),
    ]);
    let now = 2_000_000_000_000;
    const retentionMs = 48 * 60 * 60 * 1000;
    const staleDate = new Date(now - retentionMs - 1);
    const staleBackground = path.join(backgroundLogRoot, "stale.log");
    const staleForeground = path.join(foregroundLogRoot, "stale.log");
    const activeBackground = path.join(backgroundLogRoot, "active.log");
    const freshBackground = path.join(backgroundLogRoot, "fresh.log");
    await Promise.all([
      fs.writeFile(staleBackground, "old"),
      fs.writeFile(staleForeground, "old"),
      fs.writeFile(activeBackground, "live"),
      fs.writeFile(freshBackground, "fresh"),
    ]);
    await Promise.all([
      fs.utimes(staleBackground, staleDate, staleDate),
      fs.utimes(staleForeground, staleDate, staleDate),
      fs.utimes(activeBackground, staleDate, staleDate),
      fs.utimes(freshBackground, new Date(now), new Date(now)),
    ]);

    const manager = new ProcessManager(undefined, undefined, {
      backgroundLogRoot,
      foregroundLogRoot,
      now: () => now,
      logRetentionMs: retentionMs,
      createExecutionId: () => "open-foreground",
    });
    const internals = manager as unknown as { activeBackgroundLogs: Set<string> };
    internals.activeBackgroundLogs.add(activeBackground);

    try {
      const foreground = await manager.allocateForegroundLog();
      await fs.utimes(foreground.logPath, staleDate, staleDate);

      await expect(fs.stat(staleBackground)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(staleForeground)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(activeBackground)).resolves.toBeDefined();
      await expect(fs.stat(freshBackground)).resolves.toBeDefined();

      now += 60_001;
      await manager.readOutput("unknown");
      await expect(fs.stat(foreground.logPath)).resolves.toBeDefined();

      await foreground.close();
      now += 60_001;
      await manager.readOutput("unknown");
      await expect(fs.stat(foreground.logPath)).rejects.toMatchObject({ code: "ENOENT" });

      internals.activeBackgroundLogs.delete(activeBackground);
      now += 60_001;
      await manager.readOutput("unknown");
      await expect(fs.stat(activeBackground)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(freshBackground)).resolves.toBeDefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("throttles stale-log sweeps to once per minute", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-log-sweep-throttle-"));
    const backgroundLogRoot = path.join(root, "background");
    const foregroundLogRoot = path.join(root, "foreground");
    await Promise.all([
      fs.mkdir(backgroundLogRoot, { recursive: true }),
      fs.mkdir(foregroundLogRoot, { recursive: true }),
    ]);
    let now = 2_000_000_000_000;
    const manager = new ProcessManager(undefined, undefined, {
      backgroundLogRoot,
      foregroundLogRoot,
      now: () => now,
      logRetentionMs: 0,
    });

    try {
      await manager.readOutput("first-sweep");
      const staleLog = path.join(backgroundLogRoot, "eligible.log");
      await fs.writeFile(staleLog, "old");
      await fs.utimes(staleLog, new Date(now - 1), new Date(now - 1));

      now += 59_999;
      await manager.readOutput("throttled");
      await expect(fs.stat(staleLog)).resolves.toBeDefined();

      now += 1;
      await manager.readOutput("next-sweep");
      await expect(fs.stat(staleLog)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps lifecycle reads working when log cleanup operations fail", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-log-cleanup-failure-"));
    const backgroundLogRoot = path.join(root, "background");
    const foregroundLogRoot = path.join(root, "foreground");
    const notADirectory = path.join(root, "not-a-directory");
    await Promise.all([
      fs.mkdir(backgroundLogRoot, { recursive: true }),
      fs.mkdir(foregroundLogRoot, { recursive: true }),
      fs.writeFile(notADirectory, "fixture"),
    ]);
    const statFailure = path.join(backgroundLogRoot, "stat-failure.log");
    const unlinkFailure = path.join(foregroundLogRoot, "unlink-failure.log");
    await Promise.all([fs.writeFile(statFailure, "old"), fs.writeFile(unlinkFailure, "old")]);
    const originalStat = fs.stat;
    const originalUnlink = fs.unlink;
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (filePath, options) => {
      if (filePath === statFailure) throw new Error("stat failed");
      return originalStat(filePath, options as never);
    });
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (filePath) => {
      if (filePath === unlinkFailure) throw new Error("unlink failed");
      return originalUnlink(filePath);
    });

    try {
      const enumerationFailureManager = new ProcessManager(undefined, undefined, {
        backgroundLogRoot: notADirectory,
        foregroundLogRoot: notADirectory,
        logRetentionMs: 0,
      });
      const entryFailureManager = new ProcessManager(undefined, undefined, {
        backgroundLogRoot,
        foregroundLogRoot,
        logRetentionMs: 0,
      });

      await expect(enumerationFailureManager.readOutput("missing")).resolves.toMatchObject({
        output: 'No background process with id "missing"',
      });
      await expect(entryFailureManager.readOutput("missing")).resolves.toMatchObject({
        output: 'No background process with id "missing"',
      });
      expect(enumerationFailureManager.list()).toEqual([]);
      expect(entryFailureManager.list()).toEqual([]);
      await expect(fs.readFile(statFailure, "utf8")).resolves.toBe("old");
      await expect(fs.readFile(unlinkFailure, "utf8")).resolves.toBe("old");
    } finally {
      statSpy.mockRestore();
      unlinkSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("ProcessManager shutdown disposers", () => {
  it("invokes registered disposers once, isolates failures, and supports unregistering", () => {
    const manager = new ProcessManager();
    const first = vi.fn();
    const failing = vi.fn(() => {
      throw new Error("shutdown failed");
    });
    const last = vi.fn();
    const unregistered = vi.fn();
    manager.registerShutdown(first);
    manager.registerShutdown(failing);
    manager.registerShutdown(last);
    const unregister = manager.registerShutdown(unregistered);

    unregister();
    unregister();
    expect(() => manager.shutdownAll()).not.toThrow();
    expect(() => manager.shutdownAll()).not.toThrow();

    expect(first).toHaveBeenCalledOnce();
    expect(failing).toHaveBeenCalledOnce();
    expect(last).toHaveBeenCalledOnce();
    expect(unregistered).not.toHaveBeenCalled();
  });
});

describe("ProcessManager lifecycle adapter", () => {
  it("spawns background work through the adapter with piped output", async () => {
    const fake = fakeChild(9876);
    const spawn = vi.fn(() => {
      queueMicrotask(() => fake.emitSpawn());
      return fake.child;
    });
    const reapProcessWrapper = vi.fn();
    const createForegroundLogStream = vi.fn(() => new PassThrough());
    const manager = new ProcessManager(lifecycle({ spawn, reapProcessWrapper }), undefined, {
      createForegroundLogStream,
    });

    const started = await manager.start("echo remote", "/remote/workspace");

    expect(started.pid).toBe(9876);
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        cwd: "/remote/workspace",
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    fake.stdout.write("remote stdout\n");
    fake.stderr.write("remote stderr\n");
    fake.emitClose(0);
    let output = "";
    for (let attempt = 0; attempt < 20 && !output.includes("remote stderr"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      output = (await manager.readOutput(started.id, true)).output;
    }
    expect(output).toContain("remote stdout");
    expect(output).toContain("remote stderr");
    expect(reapProcessWrapper).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 9876, isExited: expect.any(Function) }),
    );
    expect(createForegroundLogStream).not.toHaveBeenCalled();
  });

  it("retries colliding background IDs without replacing process owners", async () => {
    const logRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gg-background-collision-"));
    const firstFake = fakeChild(1010);
    const secondFake = fakeChild(2020);
    const pendingChildren = [firstFake, secondFake];
    const spawn = vi.fn(() => {
      const fake = pendingChildren.shift();
      if (!fake) throw new Error("Unexpected extra spawn");
      queueMicrotask(() => fake.emitSpawn());
      return fake.child;
    });
    const killProcessTree = vi.fn();
    const ids = ["shared-owner", "shared-owner", "unique-owner"];
    const createExecutionId = vi.fn(() => {
      const id = ids.shift();
      if (!id) throw new Error("Unexpected extra ID allocation");
      return id;
    });
    const manager = new ProcessManager(lifecycle({ spawn, killProcessTree }), undefined, {
      backgroundLogRoot: logRoot,
      createExecutionId,
    });
    let childrenClosed = false;

    try {
      const first = await manager.start("first command", "/workspace");
      firstFake.stdout.write("first output\n");
      const second = await manager.start("second command", "/workspace");
      secondFake.stdout.write("second output\n");

      expect(createExecutionId).toHaveBeenCalledTimes(3);
      expect(first.id).toBe("shared-owner");
      expect(second.id).toBe("unique-owner");
      expect(first.logFile).not.toBe(second.logFile);

      const internals = manager as unknown as {
        processes: Map<string, BackgroundProcess>;
        children: Map<string, ChildProcess>;
        completions: Map<string, Promise<void>>;
        nativeCloseDeferreds: Map<string, { child: ChildProcess }>;
      };
      expect(internals.processes.get(first.id)?.pid).toBe(first.pid);
      expect(internals.processes.get(second.id)?.pid).toBe(second.pid);
      expect(internals.children.get(first.id)).toBe(firstFake.child);
      expect(internals.children.get(second.id)).toBe(secondFake.child);
      expect(internals.completions.size).toBe(2);
      expect(internals.nativeCloseDeferreds.get(first.id)?.child).toBe(firstFake.child);
      expect(internals.nativeCloseDeferreds.get(second.id)?.child).toBe(secondFake.child);

      manager.shutdownAll();

      expect(killProcessTree).toHaveBeenCalledTimes(2);
      expect(killProcessTree.mock.calls.map(([target]) => target.pid)).toEqual([1010, 2020]);

      firstFake.emitClose(0);
      secondFake.emitClose(0);
      childrenClosed = true;
      await vi.waitFor(async () => {
        await expect(fs.readFile(first.logFile, "utf8")).resolves.toBe("first output\n");
        await expect(fs.readFile(second.logFile, "utf8")).resolves.toBe("second output\n");
      });
    } finally {
      if (!childrenClosed) {
        firstFake.emitClose(0);
        secondFake.emitClose(0);
      }
      await vi.waitFor(() => {
        expect(
          (manager as unknown as { activeBackgroundLogs: Set<string> }).activeBackgroundLogs.size,
        ).toBe(0);
      });
      await fs.rm(logRoot, { recursive: true, force: true });
    }
  });

  it("rejects a synchronous spawn throw without tracking a process", async () => {
    const error = new Error("spawn threw");
    const logStream = new PassThrough();
    const endLog = vi.spyOn(logStream, "end");
    const manager = new ProcessManager(
      lifecycle({
        spawn: () => {
          throw error;
        },
      }),
      () => logStream,
    );

    await expect(manager.start("missing command", "/workspace")).rejects.toBe(error);
    expect(manager.list()).toEqual([]);
    expect(endLog).toHaveBeenCalledOnce();
  });

  it("rejects an asynchronous startup error without tracking or unrefing the child", async () => {
    const fake = fakeChild();
    const error = new Error("ENOENT");
    const logStream = new PassThrough();
    const endLog = vi.spyOn(logStream, "end");
    const manager = new ProcessManager(
      lifecycle({
        spawn: () => {
          queueMicrotask(() => fake.emitError(error));
          return fake.child;
        },
      }),
      () => logStream,
    );
    const starting = manager.start("missing command", "/workspace");

    await expect(starting).rejects.toBe(error);
    expect(manager.list()).toEqual([]);
    expect(fake.child.unref).not.toHaveBeenCalled();
    expect(fake.child.listenerCount("error")).toBeGreaterThan(0);
    expect(endLog).toHaveBeenCalledOnce();
    expect(() => fake.emitError(new Error("later failure"))).not.toThrow();
  });

  it("tracks spawn before handling an immediate close", async () => {
    const fake = fakeChild(7654);
    const reapProcessWrapper = vi.fn();
    const logStream = new PassThrough();
    const endLog = vi.spyOn(logStream, "end");
    const manager = new ProcessManager(
      lifecycle({
        spawn: () => {
          queueMicrotask(() => {
            fake.emitSpawn();
            fake.emitClose(0);
          });
          return fake.child;
        },
        reapProcessWrapper,
      }),
      () => logStream,
    );
    const starting = manager.start("fast command", "/workspace");

    await expect(starting).resolves.toMatchObject({ pid: 7654 });
    await vi.waitFor(() => {
      expect(manager.list()).toEqual([expect.objectContaining({ pid: 7654, exitCode: 0 })]);
      expect((manager as unknown as { children: Map<string, ChildProcess> }).children.size).toBe(0);
      expect(reapProcessWrapper).toHaveBeenCalledOnce();
    });
    expect(fake.child.unref).toHaveBeenCalledOnce();
    expect(endLog).toHaveBeenCalledOnce();
  });

  it("keeps completion pending until the log stream flushes", async () => {
    const fake = fakeChild(2468);
    let finishLogFlush: (() => void) | undefined;
    const logStream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        finishLogFlush = callback;
      },
    });
    const reapProcessWrapper = vi.fn();
    const manager = new ProcessManager(
      lifecycle({
        spawn: () => {
          queueMicrotask(() => fake.emitSpawn());
          return fake.child;
        },
        reapProcessWrapper,
      }),
      () => logStream,
    );

    const started = await manager.start("flush logs", "/workspace");
    fake.stdout.write("final output\n");
    fake.emitClose(0);

    expect(manager.list()).toEqual([
      expect.objectContaining({
        exitCode: null,
        signal: null,
        completedAt: null,
        isRunning: false,
      }),
    ]);
    expect(
      (manager as unknown as { children: Map<string, ChildProcess> }).children.has(started.id),
    ).toBe(false);
    expect(reapProcessWrapper).not.toHaveBeenCalled();

    finishLogFlush?.();
    await vi.waitFor(() => {
      expect(manager.list()).toEqual([
        expect.objectContaining({ exitCode: 0, signal: null, completedAt: expect.any(Number) }),
      ]);
      expect(
        (manager as unknown as { children: Map<string, ChildProcess> }).children.has(started.id),
      ).toBe(false);
      expect(reapProcessWrapper).toHaveBeenCalledOnce();
    });
  });

  it("waits for managed completion when stop races after native close", async () => {
    const harness = await managedStopHarness(undefined);
    try {
      harness.fake.stdout.write("natural shutdown\n");
      harness.fake.emitClose(0);

      const stopping = harness.manager.stop(harness.started.id);
      let result: string | undefined;
      void stopping.then((value) => {
        result = value;
      });
      await Promise.resolve();
      expect(result).toBeUndefined();
      expect(harness.cleanupProcessTree).not.toHaveBeenCalled();

      await harness.flushLog();
      await expect(stopping).resolves.toMatch(
        new RegExp(
          `^Process ${harness.started.id} already exited ` +
            `\\(code=0, signal=none, completedAt=\\d+\\)\\. Final output:\\nnatural shutdown\\n$`,
        ),
      );
      expect(harness.cleanupProcessTree).not.toHaveBeenCalled();
    } finally {
      await harness.removeLogRoot();
    }
  });

  it("ends stdin first and waits for close plus log flush before graceful success", async () => {
    vi.useFakeTimers();
    const harness = await managedStopHarness(undefined);
    try {
      const endStdin = vi.spyOn(harness.fake.stdin, "end");
      const stopping = harness.manager.stop(harness.started.id);
      let result: string | undefined;
      void stopping.then((value) => {
        result = value;
      });

      await Promise.resolve();
      expect(harness.fake.stdin.writableEnded).toBe(true);
      expect(endStdin).toHaveBeenCalledOnce();
      expect(harness.cleanupProcessTree).not.toHaveBeenCalled();

      harness.fake.stdout.write("shutdown complete\n");
      harness.fake.emitClose(0);
      await Promise.resolve();
      await Promise.resolve();
      expect(result).toBeUndefined();
      expect(harness.cleanupProcessTree).not.toHaveBeenCalled();

      await harness.flushLog();
      await expect(stopping).resolves.toMatch(
        new RegExp(
          `^Process ${harness.started.id} stopped gracefully via stdin EOF ` +
            `\\(code=0, signal=none, completedAt=\\d+\\)\\. Final output:\\nshutdown complete\\n$`,
        ),
      );
      expect(harness.cleanupProcessTree).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await harness.removeLogRoot();
    }
  });

  it("waits 2 seconds before escalating once and remains pending through log settlement", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const harness = await managedStopHarness((fake, target) => {
      events.push(`cleanup:${target.pid}`);
      fake.stderr.write("forced shutdown\n");
      fake.emitClose(null, "SIGTERM");
    });
    try {
      harness.fake.stdin.once("finish", () => events.push("stdin EOF"));
      const stopping = harness.manager.stop(harness.started.id);
      let settled = false;
      void stopping.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(events).toEqual(["stdin EOF"]);
      expect(harness.cleanupProcessTree).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(events).toEqual(["stdin EOF", `cleanup:${harness.started.pid}`]);
      expect(harness.cleanupProcessTree).toHaveBeenCalledOnce();
      expect(settled).toBe(false);

      await harness.flushLog();
      await expect(stopping).resolves.toContain(
        `Process ${harness.started.id} stopped after process-tree cleanup ` +
          `(code=null, signal=SIGTERM, completedAt=`,
      );
      await expect(stopping).resolves.toContain("Final output:\nforced shutdown\n");
    } finally {
      vi.useRealTimers();
      await harness.removeLogRoot();
    }
  });

  it("shares one EOF-first stop across concurrent callers", async () => {
    vi.useFakeTimers();
    const harness = await managedStopHarness((fake) => fake.emitClose(null, "SIGTERM"));
    try {
      const endStdin = vi.spyOn(harness.fake.stdin, "end");
      const firstStop = harness.manager.stop(harness.started.id);
      const secondStop = harness.manager.stop(harness.started.id);

      expect(secondStop).toBe(firstStop);
      expect(endStdin).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(harness.cleanupProcessTree).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(harness.cleanupProcessTree).toHaveBeenCalledOnce();
      await harness.flushLog();

      const [firstResult, secondResult] = await Promise.all([firstStop, secondStop]);
      expect(secondResult).toBe(firstResult);
      expect(firstResult).toContain("stopped after process-tree cleanup");
      expect(endStdin).toHaveBeenCalledOnce();
      expect(harness.cleanupProcessTree).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      await harness.removeLogRoot();
    }
  });

  it("skips EOF grace and cleans up directly when stdin is closed", async () => {
    vi.useFakeTimers();
    const harness = await managedStopHarness((fake) => fake.emitClose(0));
    try {
      harness.fake.stdin.destroy();
      const stopping = harness.manager.stop(harness.started.id);
      await Promise.resolve();

      expect(harness.cleanupProcessTree).toHaveBeenCalledOnce();
      await harness.flushLog();
      await expect(stopping).resolves.toContain("stopped after process-tree cleanup");
    } finally {
      vi.useRealTimers();
      await harness.removeLogRoot();
    }
  });

  it("treats cleanup errors as best-effort when the process still exits", async () => {
    vi.useFakeTimers();
    const harness = await managedStopHarness(
      async (fake) => {
        queueMicrotask(() => fake.emitClose(0));
        throw new Error("cleanup failed");
      },
      { eofGraceMs: 10 },
    );
    try {
      const stopping = harness.manager.stop(harness.started.id);
      await vi.advanceTimersByTimeAsync(10);
      expect(harness.cleanupProcessTree).toHaveBeenCalledOnce();

      await harness.flushLog();
      await expect(stopping).resolves.toContain("stopped after process-tree cleanup");
    } finally {
      vi.useRealTimers();
      await harness.removeLogRoot();
    }
  });

  it("keeps a process retryable when EOF and cleanup do not produce terminal settlement", async () => {
    vi.useFakeTimers();
    try {
      const cleanupProcessTree = vi.fn(async () => {});
      const { manager, proc } = trackedManager(lifecycle({ cleanupProcessTree }), {
        eofGraceMs: 2_000,
        terminalSettlementMs: 5_000,
      });
      const stopping = manager.stop(proc.id);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(cleanupProcessTree).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(cleanupProcessTree).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(4_999);
      let settled = false;
      void stopping.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(stopping).resolves.toMatch(
        /^Failed to stop process bg-test: .*may still be running\.$/,
      );
      expect(manager.list()).toContainEqual(
        expect.objectContaining({ id: proc.id, isRunning: true }),
      );
      expect(cleanupProcessTree).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not accumulate close listeners across timed-out stop retries", async () => {
    vi.useFakeTimers();
    try {
      const cleanupProcessTree = vi.fn(async () => {});
      const { manager, child, proc } = trackedManager(lifecycle({ cleanupProcessTree }), {
        eofGraceMs: 10,
        terminalSettlementMs: 20,
      });

      const firstStop = manager.stop(proc.id);
      expect(child.listenerCount("close")).toBe(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(cleanupProcessTree).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(20);
      await expect(firstStop).resolves.toContain("Failed to stop process");
      expect(child.listenerCount("close")).toBe(0);

      const secondStop = manager.stop(proc.id);
      expect(child.listenerCount("close")).toBe(1);
      await Promise.resolve();
      expect(cleanupProcessTree).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(20);
      await expect(secondStop).resolves.toContain("Failed to stop process");
      expect(child.listenerCount("close")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes shutdown through immediate target cleanup", () => {
    const killProcessTree = vi.fn();
    const { manager, proc } = trackedManager(lifecycle({ killProcessTree }));

    manager.shutdownAll();

    expect(killProcessTree).toHaveBeenCalledWith(
      expect.objectContaining({ pid: proc.pid, isExited: expect.any(Function) }),
    );
    expect(manager.list()[0]).toMatchObject({ exitCode: null, signal: null, isRunning: true });
  });

  it("does not clean up records that already completed naturally", () => {
    const killProcessTree = vi.fn();
    const tracked = trackedManager(lifecycle({ killProcessTree }));
    tracked.proc.exitCode = 0;
    (tracked.manager as unknown as { children: Map<string, ChildProcess> }).children.delete(
      tracked.proc.id,
    );

    tracked.manager.shutdownAll();

    expect(killProcessTree).not.toHaveBeenCalled();
  });
});
