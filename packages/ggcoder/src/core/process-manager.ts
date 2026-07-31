import type { ChildProcess, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import type { Writable } from "node:stream";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  killProcessTree as killLocalProcessTree,
  type ProcessTarget,
} from "../utils/process.js";
import { localProcessLifecycle, type ProcessLifecycleAdapter } from "../tools/operations.js";
import { getSafeToolEnv } from "../tools/safe-env.js";
import { resolveShell } from "./shell.js";
import type { AgentNotificationQueue } from "./agent-notifications.js";

export interface BackgroundProcess {
  id: string;
  pid: number;
  command: string;
  logFile: string;
  startedAt: number;
  completedAt: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  lastReadOffset: number | null;
  /** Last observed retained-log size, used by completion gates and notifications. */
  logSize: number;
}

/** Serializable process state shared by orchestration and task-status surfaces. */
export interface BackgroundTaskSnapshot extends BackgroundProcess {
  isRunning: boolean;
}

export interface StartResult {
  id: string;
  pid: number;
  logFile: string;
}

export interface ReadOutputResult {
  id: string;
  isRunning: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  completedAt: number | null;
  output: string;
  startOffset: number;
  endOffset: number;
  skippedBytes: number;
  remainingBytes: number;
  logFile: string | null;
}

const BG_DIR = path.join(os.homedir(), ".gg", "bg");
const FOREGROUND_DIR = path.join(os.homedir(), ".gg", "foreground");
const DEFAULT_READ_CAP_BYTES = 256 * 1024;
const DEFAULT_RECORD_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_LOG_RETENTION_MS = 48 * 60 * 60 * 1000;
const DEFAULT_EOF_GRACE_MS = 2_000;
const DEFAULT_TERMINAL_SETTLEMENT_MS = 5_000;
const LOG_SWEEP_INTERVAL_MS = 60 * 1000;
const WATCH_INTERVAL_MS = 5_000;
const WATCH_INTERVAL_MAX_MS = 120_000;
const WATCH_MAX_REPORTS = 3;
const CHECKPOINT_TAIL_CHARS = 320;

function tailDigest(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length <= CHECKPOINT_TAIL_CHARS
    ? collapsed
    : `…${collapsed.slice(collapsed.length - CHECKPOINT_TAIL_CHARS)}`;
}

function formatElapsed(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 6_000) / 10}m` : `${Math.round(ms / 1_000)}s`;
}

export interface ForegroundLogHandle {
  executionId: string;
  logPath: string;
  readonly error: Error | null;
  /** Returns false when producers must pause until waitForDrain() resolves. */
  write(record: string | Buffer): boolean;
  waitForDrain(): Promise<void>;
  close(): Promise<void>;
}

export interface ProcessManagerOptions {
  backgroundLogRoot?: string;
  foregroundLogRoot?: string;
  createForegroundLogStream?: (logPath: string) => Writable;
  createExecutionId?: () => string;
  now?: () => number;
  readCapBytes?: number;
  completedRecordRetentionMs?: number;
  logRetentionMs?: number;
  eofGraceMs?: number;
  terminalSettlementMs?: number;
  /** Queue for bounded progress and terminal process notifications. */
  notifications?: AgentNotificationQueue;
  /** Legacy platform overrides retained for deterministic process-tree tests. */
  platform?: NodeJS.Platform;
  kill?: typeof process.kill;
  killProcessTree?: (pid: number) => void;
  spawnSync?: typeof spawnSync;
}

interface NativeCloseDeferred {
  child: ChildProcess;
  promise: Promise<void>;
  cancel: (() => void) | null;
}

function processTarget(pid: number, child: ChildProcess): ProcessTarget {
  return {
    pid,
    isExited: () => child.exitCode !== null || child.signalCode !== null,
  };
}

function isLifecycleAdapter(
  value: ProcessLifecycleAdapter | ProcessManagerOptions,
): value is ProcessLifecycleAdapter {
  return typeof (value as Partial<ProcessLifecycleAdapter>).spawn === "function";
}

function lifecycleFromOptions(options: ProcessManagerOptions): ProcessLifecycleAdapter {
  if (!options.platform && !options.kill && !options.killProcessTree && !options.spawnSync) {
    return localProcessLifecycle;
  }
  const killTree = (target: ProcessTarget): void => {
    if (options.killProcessTree) {
      options.killProcessTree(target.pid);
      return;
    }
    killLocalProcessTree(target, {
      platform: options.platform,
      kill: options.kill,
      spawnSync: options.spawnSync,
    });
  };
  return {
    ...localProcessLifecycle,
    cleanupProcessTree: async (target) => killTree(target),
    killProcessTree: killTree,
  };
}

export class ProcessManager {
  private processes = new Map<string, BackgroundProcess>();
  private children = new Map<string, ChildProcess>();
  private completions = new Map<string, Promise<void>>();
  private nativeCloseDeferreds = new Map<string, NativeCloseDeferred>();
  private stopOperations = new Map<string, Promise<string>>();
  private recordExpiryTimers = new Map<string, NodeJS.Timeout>();
  private activeBackgroundLogs = new Set<string>();
  private openForegroundLogs = new Set<string>();
  private shutdownDisposers = new Set<() => void>();
  private logSweepPromise: Promise<void> | null = null;
  private lastLogSweepAt: number | null = null;
  private watchers = new Map<string, ReturnType<typeof setTimeout>>();
  private watchedSizes = new Map<string, number>();
  private readonly lifecycle: ProcessLifecycleAdapter;
  private readonly createLogStream: (logFile: string) => Writable;
  private readonly options: ProcessManagerOptions;

  constructor(options?: ProcessManagerOptions);
  constructor(
    lifecycle?: ProcessLifecycleAdapter,
    createLogStream?: (logFile: string) => Writable,
    options?: ProcessManagerOptions,
  );
  constructor(
    lifecycleOrOptions: ProcessLifecycleAdapter | ProcessManagerOptions = localProcessLifecycle,
    createLogStream: (logFile: string) => Writable = (logFile) =>
      createWriteStream(logFile, { flags: "a" }),
    options: ProcessManagerOptions = {},
  ) {
    if (isLifecycleAdapter(lifecycleOrOptions)) {
      this.lifecycle = lifecycleOrOptions;
      this.createLogStream = createLogStream;
      this.options = options;
    } else {
      this.lifecycle = lifecycleFromOptions(lifecycleOrOptions);
      this.createLogStream = createLogStream;
      this.options = lifecycleOrOptions;
    }
  }

  /** Register session-owned cleanup and return an idempotent unregister function. */
  registerShutdown(dispose: () => void): () => void {
    this.shutdownDisposers.add(dispose);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      this.shutdownDisposers.delete(dispose);
    };
  }

  private armWatcher(proc: BackgroundProcess): void {
    const queue = this.options.notifications;
    if (!queue) return;
    this.watchedSizes.set(proc.id, 0);

    let delay = WATCH_INTERVAL_MS;
    let reports = 0;
    const schedule = (): void => {
      const timer = setTimeout(() => {
        if (!this.children.has(proc.id)) {
          this.disposeWatcher(proc.id);
          return;
        }
        void this.emitProgress(proc).then((emitted) => {
          if (!this.children.has(proc.id) || !this.watchers.has(proc.id)) return;
          if (emitted && ++reports >= WATCH_MAX_REPORTS) {
            this.disposeWatcher(proc.id);
            return;
          }
          if (emitted) delay = Math.min(delay * 2, WATCH_INTERVAL_MAX_MS);
          schedule();
        });
      }, delay);
      timer.unref?.();
      this.watchers.set(proc.id, timer);
    };
    schedule();
  }

  private async refreshLogSize(proc: BackgroundProcess): Promise<number> {
    try {
      proc.logSize = (await fsp.stat(proc.logFile)).size;
    } catch {
      // Retained logs are best-effort; preserve the last observed size.
    }
    return proc.logSize;
  }

  private async emitProgress(proc: BackgroundProcess): Promise<boolean> {
    const queue = this.options.notifications;
    if (!queue) return false;
    const size = await this.refreshLogSize(proc);
    const previous = this.watchedSizes.get(proc.id) ?? 0;
    if (size <= previous || !this.children.has(proc.id)) return false;
    this.watchedSizes.set(proc.id, size);
    const tail = await this.readTail(proc.logFile, size);
    queue.enqueue(
      "process",
      proc.id,
      `Background process ${proc.id} (${proc.command}) is still running after ` +
        `${formatElapsed(this.now() - proc.startedAt)}, ${size} bytes logged` +
        `${tail ? `. Latest: ${tail}` : ""}`,
    );
    return true;
  }

  private notifyExit(proc: BackgroundProcess): void {
    const queue = this.options.notifications;
    if (!queue) return;
    void (async () => {
      const size = proc.logSize;
      const tail = size > 0 ? await this.readTail(proc.logFile, size) : "";
      const terminalStatus = proc.signal
        ? `signal ${proc.signal}`
        : `code ${proc.exitCode ?? "unknown"}`;
      queue.enqueue(
        "process",
        proc.id,
        `Background process ${proc.id} (${proc.command}) exited with ${terminalStatus} ` +
          `after ${formatElapsed(this.now() - proc.startedAt)}` +
          `${tail ? `. Last output: ${tail}` : ""}. ` +
          `Read it with task_output id="${proc.id}".`,
        { terminal: true },
      );
    })();
  }

  private async readTail(logFile: string, size: number): Promise<string> {
    const start = Math.max(0, size - CHECKPOINT_TAIL_CHARS * 4);
    try {
      const file = await fsp.open(logFile, "r");
      try {
        const buffer = Buffer.alloc(size - start);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
        return tailDigest(buffer.subarray(0, bytesRead).toString("utf-8"));
      } finally {
        await file.close();
      }
    } catch {
      return "";
    }
  }

  private disposeWatcher(id: string): void {
    const timer = this.watchers.get(id);
    if (timer) clearTimeout(timer);
    this.watchers.delete(id);
    this.watchedSizes.delete(id);
  }

  activeWatchers(): string[] {
    return [...this.watchers.keys()];
  }

  async allocateForegroundLog(): Promise<ForegroundLogHandle> {
    this.pruneExpiredRecords();
    await this.sweepStaleLogs();
    const foregroundLogRoot = this.options.foregroundLogRoot ?? FOREGROUND_DIR;
    await fsp.mkdir(foregroundLogRoot, { recursive: true });

    const { id: executionId, logPath } = await this.reserveLogFile(foregroundLogRoot);

    const streamFactory =
      this.options.createForegroundLogStream ??
      ((foregroundLogPath: string) => createWriteStream(foregroundLogPath, { flags: "a" }));
    this.openForegroundLogs.add(logPath);
    let stream: Writable;
    try {
      stream = streamFactory(logPath);
    } catch (error) {
      this.openForegroundLogs.delete(logPath);
      throw error;
    }
    let streamError: Error | null = null;
    let ended = false;
    let settleClose!: () => void;
    const closed = new Promise<void>((resolve) => {
      settleClose = () => {
        this.openForegroundLogs.delete(logPath);
        resolve();
      };
    });
    stream.on("error", (error: Error) => {
      streamError = error;
      settleClose();
    });
    stream.once("finish", settleClose);
    stream.once("close", settleClose);

    if ((stream as Writable & { readonly pending?: boolean }).pending === true) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onOpen = (): void => {
            stream.removeListener("error", onOpenError);
            resolve();
          };
          const onOpenError = (error: Error): void => {
            stream.removeListener("open", onOpen);
            reject(error);
          };
          stream.once("open", onOpen);
          stream.once("error", onOpenError);
        });
      } catch (error) {
        this.openForegroundLogs.delete(logPath);
        stream.destroy();
        throw error;
      }
    }

    return {
      executionId,
      logPath,
      get error() {
        return streamError;
      },
      write(record) {
        if (ended || streamError) return true;
        try {
          return stream.write(record);
        } catch (error) {
          streamError = error instanceof Error ? error : new Error(String(error));
          return true;
        }
      },
      waitForDrain() {
        if (ended || streamError || stream.destroyed) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const settle = (): void => {
            stream.removeListener("drain", settle);
            stream.removeListener("error", settle);
            stream.removeListener("finish", settle);
            stream.removeListener("close", settle);
            resolve();
          };
          stream.once("drain", settle);
          stream.once("error", settle);
          stream.once("finish", settle);
          stream.once("close", settle);
        });
      },
      close() {
        if (ended) return closed;
        ended = true;
        try {
          stream.end();
        } catch (error) {
          streamError = error instanceof Error ? error : new Error(String(error));
          settleClose();
        }
        return closed;
      },
    };
  }

  async start(command: string, cwd: string): Promise<StartResult> {
    this.pruneExpiredRecords();
    await this.sweepStaleLogs();
    const backgroundLogRoot = this.options.backgroundLogRoot ?? BG_DIR;
    await fsp.mkdir(backgroundLogRoot, { recursive: true });

    const { id, logPath: logFile } = await this.reserveLogFile(
      backgroundLogRoot,
      (candidateId) => !this.hasBackgroundOwner(candidateId),
    );
    this.activeBackgroundLogs.add(logFile);
    let logStream: Writable;
    try {
      logStream = this.createLogStream(logFile);
    } catch (error) {
      this.activeBackgroundLogs.delete(logFile);
      throw error;
    }
    const markLogClosed = (): void => {
      this.activeBackgroundLogs.delete(logFile);
    };
    // A local logging failure must not crash the host or bypass target execution.
    logStream.on("error", () => {});
    logStream.once("finish", markLogClosed);
    logStream.once("close", markLogClosed);
    logStream.once("error", markLogClosed);

    const shell = resolveShell(command);
    let child: ChildProcess;
    try {
      child = this.lifecycle.spawn(shell.file, shell.args, {
        cwd,
        detached: true,
        // Keep adapter-owned process I/O as pipes. Numeric descriptors would
        // bypass remote/SSH/Docker adapters and execute logging on their target.
        stdio: ["pipe", "pipe", "pipe"],
        env: getSafeToolEnv(),
      });
    } catch (error) {
      logStream.end();
      throw error;
    }

    child.stdout?.pipe(logStream, { end: false });
    child.stderr?.pipe(logStream, { end: false });
    child.stdin?.on("error", () => {});

    let settleNativeClose!: () => void;
    const nativeClose = new Promise<void>((resolveNativeClose) => {
      settleNativeClose = resolveNativeClose;
    });

    return new Promise<StartResult>((resolve, reject) => {
      let startupSettled = false;
      let proc: BackgroundProcess | undefined;
      let pid: number | undefined;
      let logEnded = false;
      let settleCompletion!: () => void;
      const completion = new Promise<void>((resolveCompletion) => {
        settleCompletion = resolveCompletion;
      });
      let settleLogFlush!: () => void;
      const logFlushed = new Promise<void>((resolveFlush) => {
        settleLogFlush = resolveFlush;
      });
      logStream.once("finish", settleLogFlush);
      logStream.once("close", settleLogFlush);
      logStream.once("error", settleLogFlush);

      const endLog = (): void => {
        if (logEnded) return;
        logEnded = true;
        logStream.end();
      };

      const onError = (error: Error): void => {
        if (startupSettled) return;
        startupSettled = true;
        endLog();
        reject(error);
        // Keep this listener installed: ChildProcess may emit another error later,
        // and an unhandled error event must never crash the agent host.
      };

      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        settleNativeClose();
        endLog();
        if (!proc || pid === undefined) {
          if (!startupSettled) {
            startupSettled = true;
            reject(new Error("Background process closed before startup completed"));
          }
          return;
        }

        const completedProcess = proc;
        const completedPid = pid;
        this.children.delete(id);
        this.disposeWatcher(id);
        void logFlushed.then(async () => {
          // Preserve native child semantics: signal exits have no numeric code.
          // Consumers use the explicit snapshot isRunning field for liveness.
          completedProcess.exitCode = code;
          completedProcess.signal = signal;
          completedProcess.completedAt = this.now();
          await this.refreshLogSize(completedProcess);
          this.scheduleRecordExpiry(id, completedProcess.completedAt);
          try {
            this.lifecycle.reapProcessWrapper(processTarget(completedPid, child));
          } catch {
            // Completion is authoritative; wrapper reaping remains best-effort.
          }
          this.notifyExit(completedProcess);
          settleCompletion();
        });
      };

      const onSpawn = (): void => {
        if (startupSettled) return;
        pid = child.pid;
        if (pid === undefined) {
          startupSettled = true;
          endLog();
          reject(new Error("Background process did not provide a PID"));
          return;
        }

        proc = {
          id,
          pid,
          command,
          logFile,
          startedAt: this.now(),
          completedAt: null,
          exitCode: null,
          signal: null,
          lastReadOffset: null,
          logSize: 0,
        };
        this.processes.set(id, proc);
        this.children.set(id, child);
        this.completions.set(id, completion);
        this.nativeCloseDeferreds.set(id, { child, promise: nativeClose, cancel: null });
        child.unref();
        this.armWatcher(proc);
        startupSettled = true;
        resolve({ id, pid, logFile });
      };

      // Register all terminal handlers before awaiting startup so fast failures
      // and immediate exits cannot escape or be reported as false success.
      child.on("error", onError);
      child.on("close", onClose);
      child.once("spawn", onSpawn);
    });
  }

  async readOutput(id: string, fromStart = false): Promise<ReadOutputResult> {
    this.pruneExpiredRecords();
    await this.sweepStaleLogs();
    const proc = this.processes.get(id);
    if (!proc) {
      return {
        id,
        isRunning: false,
        exitCode: null,
        signal: null,
        completedAt: null,
        output: `No background process with id "${id}"`,
        startOffset: 0,
        endOffset: 0,
        skippedBytes: 0,
        remainingBytes: 0,
        logFile: null,
      };
    }

    const configuredReadCap = Math.floor(this.options.readCapBytes ?? DEFAULT_READ_CAP_BYTES);
    const readCap = Number.isFinite(configuredReadCap)
      ? Math.max(4, configuredReadCap)
      : DEFAULT_READ_CAP_BYTES;
    const isLateSnapshot = !fromStart && proc.lastReadOffset === null;
    const isRunning = this.children.has(id);
    let output = "";
    let startOffset: number;
    let endOffset: number;
    let skippedBytes = 0;
    let remainingBytes = 0;

    try {
      // Freeze range selection at this size. Bytes appended after this stat are
      // intentionally left for the next incremental read.
      const snapshotSize = (await fsp.stat(proc.logFile)).size;
      proc.logSize = snapshotSize;
      const previousOffset = proc.lastReadOffset ?? 0;
      const requestedStart = fromStart
        ? 0
        : isLateSnapshot
          ? Math.max(0, snapshotSize - readCap)
          : previousOffset > snapshotSize
            ? 0
            : previousOffset;
      const requestedLength = Math.min(readCap, Math.max(0, snapshotSize - requestedStart));

      if (requestedLength > 0) {
        const buffer = Buffer.alloc(requestedLength);
        const file = await fsp.open(proc.logFile, "r");
        let bytesRead = 0;
        try {
          ({ bytesRead } = await file.read(buffer, 0, buffer.length, requestedStart));
        } finally {
          await file.close();
        }

        let leadingBytes = 0;
        if (isLateSnapshot && requestedStart > 0) {
          while (leadingBytes < bytesRead && (buffer[leadingBytes]! & 0xc0) === 0x80) {
            leadingBytes += 1;
          }
        }

        const completePrefixLength = this.completeUtf8PrefixLength(
          buffer.subarray(leadingBytes, bytesRead),
        );
        const reachedSnapshotEnd = requestedStart + bytesRead >= snapshotSize;
        const consumedLength =
          !isRunning && reachedSnapshotEnd ? bytesRead - leadingBytes : completePrefixLength;
        startOffset = requestedStart + leadingBytes;
        endOffset = startOffset + consumedLength;
        output = buffer
          .subarray(leadingBytes, leadingBytes + completePrefixLength)
          .toString("utf-8");
        proc.lastReadOffset = endOffset;
      } else {
        startOffset = requestedStart;
        endOffset = requestedStart;
        proc.lastReadOffset = requestedStart;
      }

      skippedBytes = isLateSnapshot ? startOffset : 0;
      remainingBytes = Math.max(0, snapshotSize - endOffset);
    } catch {
      output = "(failed to read log file)";
      const cursor = proc.lastReadOffset ?? 0;
      startOffset = cursor;
      endOffset = cursor;
    }

    return {
      id,
      isRunning,
      exitCode: proc.exitCode,
      signal: proc.signal,
      completedAt: proc.completedAt,
      output,
      startOffset,
      endOffset,
      skippedBytes,
      remainingBytes,
      logFile: proc.logFile,
    };
  }

  private completeUtf8PrefixLength(buffer: Buffer): number {
    if (buffer.length === 0) return 0;

    let continuationBytes = 0;
    for (
      let index = buffer.length - 1;
      index >= 0 && (buffer[index]! & 0xc0) === 0x80;
      index -= 1
    ) {
      continuationBytes += 1;
    }

    const leadIndex = buffer.length - continuationBytes - 1;
    if (leadIndex < 0) return buffer.length;
    const lead = buffer[leadIndex]!;
    const expectedBytes =
      (lead & 0x80) === 0 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : 4;
    const availableBytes = continuationBytes + 1;
    return availableBytes < expectedBytes ? leadIndex : buffer.length;
  }

  async sendInput(
    id: string,
    input?: string,
    opts: { enter?: boolean; eof?: boolean } = {},
  ): Promise<string> {
    this.pruneExpiredRecords();
    await this.sweepStaleLogs();
    const proc = this.processes.get(id);
    if (!proc) return `No background process with id "${id}"`;

    const child = this.children.get(id);
    if (!child) {
      return `Process ${id} already exited (${this.formatTerminalStatus(proc)})`;
    }

    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      return `Process ${id} is not accepting input (stdin is closed).`;
    }

    const enter = opts.enter ?? input !== undefined;
    const text = (input ?? "") + (enter ? "\n" : "");

    try {
      if (text.length > 0) {
        await new Promise<void>((resolve, reject) => {
          stdin.write(text, (err) => (err ? reject(err) : resolve()));
        });
      }
      if (opts.eof) stdin.end();
    } catch (err) {
      return `Failed to send input to ${id}: ${(err as Error).message}`;
    }

    const summary = opts.eof
      ? text.length > 0
        ? `Sent input and closed stdin (EOF) for ${id}.`
        : `Closed stdin (EOF) for ${id}.`
      : `Sent input to ${id}.`;
    return `${summary} Use task_output with id="${id}" to read the response.`;
  }

  stop(id: string): Promise<string> {
    this.pruneExpiredRecords();
    void this.sweepStaleLogs();

    const existingOperation = this.stopOperations.get(id);
    if (existingOperation) return existingOperation;

    const proc = this.processes.get(id);
    if (!proc) return Promise.resolve(`No background process with id "${id}"`);

    const child = this.children.get(id);
    const operation = child
      ? this.performStop(id, proc, child)
      : this.reportCompletedProcess(id, proc);
    this.stopOperations.set(id, operation);
    const clearOperation = (): void => {
      if (this.stopOperations.get(id) === operation) this.stopOperations.delete(id);
    };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }

  private async performStop(
    id: string,
    proc: BackgroundProcess,
    child: ChildProcess,
  ): Promise<string> {
    const nativeClose = this.getNativeClose(id, proc, child);
    const terminalSettled = this.waitForTerminalSettlement(id, proc, nativeClose);

    try {
      const stdin = child.stdin;
      const canSendEof =
        stdin !== null &&
        stdin !== undefined &&
        stdin.writable !== false &&
        !stdin.destroyed &&
        !stdin.writableEnded;
      let attemptedEof = false;
      let stoppedGracefully = false;

      if (canSendEof) {
        try {
          stdin.end();
          attemptedEof = true;
        } catch {
          // A failed EOF attempt falls through to adapter-owned tree cleanup.
        }
      }

      if (attemptedEof) {
        const eofGraceMs = this.boundedDuration(this.options.eofGraceMs, DEFAULT_EOF_GRACE_MS);
        stoppedGracefully = await this.settlesWithin(nativeClose, eofGraceMs);
      }

      if (!stoppedGracefully) {
        try {
          await this.lifecycle.cleanupProcessTree(processTarget(proc.pid, child));
        } catch {
          // Cleanup is best-effort; terminal settlement remains authoritative.
        }
      }

      const terminalSettlementMs = this.boundedDuration(
        this.options.terminalSettlementMs,
        DEFAULT_TERMINAL_SETTLEMENT_MS,
      );
      if (!(await this.settlesWithin(terminalSettled, terminalSettlementMs))) {
        return `Failed to stop process ${id}: process did not reach a terminal settled state within ${terminalSettlementMs} ms and may still be running.`;
      }

      const final = await this.readOutput(id);
      const method = stoppedGracefully ? "gracefully via stdin EOF" : "after process-tree cleanup";
      const finalOutput = final.output.length > 0 ? final.output : "(no unread output)";
      return (
        `Process ${id} stopped ${method} ` +
        `(code=${final.exitCode ?? "null"}, signal=${final.signal ?? "none"}, ` +
        `completedAt=${final.completedAt ?? "pending"}). Final output:\n${finalOutput}`
      );
    } finally {
      if (this.children.get(id) === child) this.cancelInjectedNativeClose(id, child);
    }
  }

  list(): BackgroundTaskSnapshot[] {
    this.pruneExpiredRecords();
    void this.sweepStaleLogs();
    return Array.from(this.processes.values(), (proc) => ({
      id: proc.id,
      pid: proc.pid,
      command: proc.command,
      logFile: proc.logFile,
      startedAt: proc.startedAt,
      completedAt: proc.completedAt,
      exitCode: proc.exitCode,
      signal: proc.signal,
      lastReadOffset: proc.lastReadOffset,
      logSize: proc.logSize,
      isRunning: this.children.has(proc.id),
    }));
  }

  shutdownAll(): void {
    this.pruneExpiredRecords();
    void this.sweepStaleLogs();
    const shutdownDisposers = Array.from(this.shutdownDisposers);
    this.shutdownDisposers.clear();
    for (const dispose of shutdownDisposers) {
      try {
        dispose();
      } catch {
        // Shutdown is best-effort; one owner must not prevent cleanup of the others.
      }
    }
    for (const proc of this.processes.values()) {
      const child = this.children.get(proc.id);
      if (child) {
        this.lifecycle.killProcessTree(processTarget(proc.pid, child));
      }
      this.disposeWatcher(proc.id);
    }
  }

  private async reportCompletedProcess(id: string, proc: BackgroundProcess): Promise<string> {
    if (proc.completedAt === null) await this.completions.get(id);
    const final = await this.readOutput(id);
    const finalOutput = final.output.length > 0 ? final.output : "(no unread output)";
    return (
      `Process ${id} already exited ` +
      `(code=${final.exitCode ?? "null"}, signal=${final.signal ?? "none"}, ` +
      `completedAt=${final.completedAt ?? "pending"}). Final output:\n${finalOutput}`
    );
  }

  private formatTerminalStatus(proc: BackgroundProcess): string {
    if (proc.signal) return `signal ${proc.signal}`;
    if (proc.exitCode !== null) return `code ${proc.exitCode}`;
    return "completion pending";
  }

  private getNativeClose(id: string, proc: BackgroundProcess, child: ChildProcess): Promise<void> {
    const existing = this.nativeCloseDeferreds.get(id);
    if (existing?.child === child) return existing.promise;
    existing?.cancel?.();

    const settleInjectedRecord = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (this.children.get(id) === child) this.children.delete(id);
      proc.exitCode = code;
      proc.signal = signal;
      proc.completedAt = this.now();
      this.disposeWatcher(id);
      void this.refreshLogSize(proc).then(() => this.notifyExit(proc));
      this.scheduleRecordExpiry(id, proc.completedAt);
    };

    if (child.exitCode !== null || child.signalCode !== null) {
      settleInjectedRecord(child.exitCode, child.signalCode);
      return Promise.resolve();
    }

    // Tests and adapters may inject a tracked child without going through start().
    // Share one cancellable listener across each stop attempt so retries cannot leak listeners.
    let resolveNativeClose!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveNativeClose = resolve;
    });
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      settleInjectedRecord(code, signal);
      resolveNativeClose();
    };
    const deferred: NativeCloseDeferred = {
      child,
      promise,
      cancel: () => {
        child.removeListener("close", onClose);
        if (this.nativeCloseDeferreds.get(id) === deferred) {
          this.nativeCloseDeferreds.delete(id);
        }
      },
    };
    child.once("close", onClose);
    this.nativeCloseDeferreds.set(id, deferred);
    return promise;
  }

  private cancelInjectedNativeClose(id: string, child: ChildProcess): void {
    const deferred = this.nativeCloseDeferreds.get(id);
    if (deferred?.child === child) deferred.cancel?.();
  }

  private waitForTerminalSettlement(
    id: string,
    proc: BackgroundProcess,
    nativeClose: Promise<void>,
  ): Promise<void> {
    const managedCompletion = this.completions.get(id);
    if (managedCompletion) return managedCompletion;
    if (proc.completedAt !== null) return Promise.resolve();
    return nativeClose;
  }

  private settlesWithin(settlement: Promise<void>, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (result: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const timeout = setTimeout(() => finish(false), timeoutMs);
      void settlement.then(() => finish(true));
    });
  }

  private boundedDuration(configured: number | undefined, fallback: number): number {
    if (configured === undefined || !Number.isFinite(configured)) return fallback;
    return Math.max(0, Math.floor(configured));
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private hasBackgroundOwner(id: string): boolean {
    return (
      this.processes.has(id) ||
      this.children.has(id) ||
      this.completions.has(id) ||
      this.nativeCloseDeferreds.has(id) ||
      this.stopOperations.has(id) ||
      this.recordExpiryTimers.has(id)
    );
  }

  private async reserveLogFile(
    logRoot: string,
    isIdAvailable: (id: string) => boolean = () => true,
  ): Promise<{ id: string; logPath: string }> {
    const createId = this.options.createExecutionId ?? crypto.randomUUID;
    for (;;) {
      const id = createId();
      if (!isIdAvailable(id)) continue;

      const logPath = path.join(logRoot, `${id}.log`);
      try {
        const file = await fsp.open(logPath, "wx");
        await file.close();
        return { id, logPath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
    }
  }

  private sweepStaleLogs(): Promise<void> {
    if (this.logSweepPromise) return this.logSweepPromise;

    const now = this.now();
    if (this.lastLogSweepAt !== null && now - this.lastLogSweepAt < LOG_SWEEP_INTERVAL_MS) {
      return Promise.resolve();
    }
    this.lastLogSweepAt = now;

    this.logSweepPromise = this.removeStaleLogFiles(now)
      .catch(() => {})
      .finally(() => {
        this.logSweepPromise = null;
      });
    return this.logSweepPromise;
  }

  private async removeStaleLogFiles(now: number): Promise<void> {
    const retentionMs = Math.max(0, this.options.logRetentionMs ?? DEFAULT_LOG_RETENTION_MS);
    const cutoff = now - retentionMs;
    const roots = new Set([
      this.options.backgroundLogRoot ?? BG_DIR,
      this.options.foregroundLogRoot ?? FOREGROUND_DIR,
    ]);
    const protectedPaths = new Set([...this.activeBackgroundLogs, ...this.openForegroundLogs]);

    await Promise.all(
      Array.from(roots, async (root) => {
        let entries;
        try {
          entries = await fsp.readdir(root, { withFileTypes: true });
        } catch {
          return;
        }

        await Promise.all(
          entries.map(async (entry) => {
            if (!entry.isFile()) return;
            const logPath = path.join(root, entry.name);
            if (protectedPaths.has(logPath)) return;
            try {
              const stat = await fsp.stat(logPath);
              if (stat.mtimeMs < cutoff) await fsp.unlink(logPath);
            } catch {
              // Log retention is best-effort and must never break process lifecycle methods.
            }
          }),
        );
      }),
    );
  }

  private pruneExpiredRecords(): void {
    const retentionMs = Math.max(
      0,
      this.options.completedRecordRetentionMs ?? DEFAULT_RECORD_RETENTION_MS,
    );
    const cutoff = this.now() - retentionMs;
    for (const [id, proc] of this.processes) {
      if (proc.completedAt !== null && !this.children.has(id) && proc.completedAt <= cutoff) {
        this.processes.delete(id);
        this.disposeWatcher(id);
        this.completions.delete(id);
        this.stopOperations.delete(id);
        this.nativeCloseDeferreds.get(id)?.cancel?.();
        this.nativeCloseDeferreds.delete(id);
        const timer = this.recordExpiryTimers.get(id);
        if (timer) clearTimeout(timer);
        this.recordExpiryTimers.delete(id);
      }
    }
  }

  private scheduleRecordExpiry(id: string, completedAt: number): void {
    const existingTimer = this.recordExpiryTimers.get(id);
    if (existingTimer) clearTimeout(existingTimer);

    const retentionMs = Math.max(
      0,
      this.options.completedRecordRetentionMs ?? DEFAULT_RECORD_RETENTION_MS,
    );
    const delay = Math.max(0, completedAt + retentionMs - this.now());
    const timer = setTimeout(() => {
      this.recordExpiryTimers.delete(id);
      this.pruneExpiredRecords();
    }, delay);
    timer.unref();
    this.recordExpiryTimers.set(id, timer);
  }
}
