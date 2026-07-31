/**
 * Persistent bash session for the bash tool's opt-in `persist` mode.
 *
 * One long-lived bash per instance; commands are written to stdin and
 * delimited with a sentinel that carries the exit code. Benchmarked at ~0.3ms
 * per call vs ~6.4ms for spawn-per-call (see bash-spawn-benchmark.ts), and —
 * the real win — cd/env/shell state survive across calls.
 *
 * POSIX-only (needs a real bash). Callers must fall back to spawn-per-call
 * when bash is unavailable (Windows cmd.exe fallback path).
 */
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ForegroundExecutionReason } from "../types.js";
import type { ProcessTarget } from "../utils/process.js";
import {
  BOUNDED_OUTPUT_MAX_LINES,
  BoundedOutputTail,
  type BoundedOutputTailSnapshot,
  OutputChunkDecoder,
} from "../tools/bounded-output-tail.js";
import { localProcessLifecycle, type ProcessLifecycleAdapter } from "../tools/operations.js";
import type { ForegroundLogHandle } from "./process-manager.js";
import { log } from "./logger.js";
import { resolveShell, type ResolveShellOpts } from "./shell.js";

type PersistentOutputSource = "stdout" | "stderr";

interface PersistentOutputStreamState {
  source: PersistentOutputSource;
  decoder: OutputChunkDecoder;
  binary: boolean;
  binaryBytes: number;
  reportedBinaryBytes: number;
}

export interface PersistentRunResult {
  reason: ForegroundExecutionReason;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  pid: number | null;
  error: Error | null;
  output: string;
  outputSnapshot: BoundedOutputTailSnapshot;
}

function longestSentinelPrefix(candidate: Buffer, sentinel: Buffer): number {
  const maxLength = Math.min(candidate.length, sentinel.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (candidate.subarray(candidate.length - length).equals(sentinel.subarray(0, length))) {
      return length;
    }
  }
  return 0;
}

export class PersistentShell {
  private child: ChildProcess | null = null;
  private busy = false;

  constructor(
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly maxOutputBytes: number,
    private readonly lifecycle: ProcessLifecycleAdapter = localProcessLifecycle,
    private readonly shellOpts?: ResolveShellOpts,
  ) {}

  private startCleanup(target: ProcessTarget): void {
    void Promise.resolve()
      .then(() => this.lifecycle.cleanupProcessTree(target))
      .catch((error: unknown) => {
        log("WARN", "bash", "Persistent process-tree cleanup failed", {
          pid: String(target.pid),
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /** True while a previous persistent command is still running. */
  get isBusy(): boolean {
    return this.busy;
  }

  private ensureChild(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return this.child;
    }
    // Fresh session: use the same resolved shell as one-shot execution.
    const shell = resolveShell("", this.shellOpts);
    const child = this.lifecycle.spawn(shell.file, ["--norc", "--noprofile"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
      detached: process.platform !== "win32",
    });
    // Don't let a lingering session shell keep the parent process alive.
    child.unref();
    this.child = child;
    return child;
  }

  /**
   * Run one command in the session shell. Serialized by the tool's sequential
   * execution mode; a concurrent call while busy is rejected defensively.
   * On timeout or abort the whole session is killed (state is gone — the next
   * call starts a fresh shell) because a wedged command cannot be safely
   * skipped within the same shell.
   */
  run(
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
    onChunk?: (text: string, totalBytes: number) => void,
    foregroundLog?: ForegroundLogHandle,
  ): Promise<PersistentRunResult> {
    const startedAt = Date.now();
    const emptySnapshot = (): BoundedOutputTailSnapshot => ({
      content: "",
      totalInputBytes: 0,
      retainedBytes: 0,
      retainedLines: 0,
      capped: false,
    });
    if (this.busy) {
      return Promise.resolve({
        reason: "nonZeroExit",
        exitCode: 1,
        signal: null,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        pid: this.child?.pid ?? null,
        error: null,
        output: "persistent shell is busy with a previous command",
        outputSnapshot: {
          ...emptySnapshot(),
          content: "persistent shell is busy with a previous command",
          totalInputBytes: Buffer.byteLength("persistent shell is busy with a previous command"),
          retainedBytes: Buffer.byteLength("persistent shell is busy with a previous command"),
          retainedLines: 1,
        },
      });
    }
    this.busy = true;

    let child: ChildProcess;
    try {
      child = this.ensureChild();
    } catch (error) {
      this.busy = false;
      const spawnError = error instanceof Error ? error : new Error(String(error));
      return Promise.resolve({
        reason: "spawnError",
        exitCode: null,
        signal: null,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        pid: null,
        error: spawnError,
        output: "",
        outputSnapshot: emptySnapshot(),
      });
    }

    const sentinelText = `__GG_PSH_${randomUUID()}__`;
    const sentinel = Buffer.from(sentinelText, "utf8");
    // `</dev/null` keeps stdin-reading commands (cat, read) from eating the
    // next sentinel line instead of hanging the session. Merge command stderr
    // into stdout so the sentinel is ordered after every command output byte.
    const wrapped = `{ ${command}\n} </dev/null 2>&1; echo "${sentinelText}$?"\n`;

    return new Promise<PersistentRunResult>((resolve) => {
      const outputTail = new BoundedOutputTail(BOUNDED_OUTPUT_MAX_LINES, this.maxOutputBytes);
      const stdoutState: PersistentOutputStreamState = {
        source: "stdout",
        decoder: new OutputChunkDecoder(),
        binary: false,
        binaryBytes: 0,
        reportedBinaryBytes: 0,
      };
      const stderrState: PersistentOutputStreamState = {
        source: "stderr",
        decoder: new OutputChunkDecoder(),
        binary: false,
        binaryBytes: 0,
        reportedBinaryBytes: 0,
      };
      let totalBytes = 0;
      let stdoutPending: Buffer = Buffer.alloc(0);
      let sentinelSuffix = "";
      let sentinelFound = false;
      let done = false;
      let logBackpressured = false;

      const writeForegroundLog = (source: PersistentOutputSource, text: string): void => {
        if (
          !foregroundLog ||
          foregroundLog.write(`[${source}] ${text}`) ||
          logBackpressured ||
          done
        ) {
          return;
        }
        logBackpressured = true;
        child.stdout?.pause();
        child.stderr?.pause();
        void foregroundLog.waitForDrain().then(() => {
          if (!logBackpressured) return;
          logBackpressured = false;
          if (done) return;
          child.stdout?.resume();
          child.stderr?.resume();
        });
      };

      const emitText = (source: PersistentOutputSource, text: string): void => {
        if (!text) return;
        outputTail.append(text);
        writeForegroundLog(source, text);
        onChunk?.(text, totalBytes);
      };

      const emitBinarySummary = (state: PersistentOutputStreamState): void => {
        if (state.binaryBytes === state.reportedBinaryBytes) return;
        const marker = `[${state.source} binary output omitted: ${state.binaryBytes} bytes]\n`;
        state.reportedBinaryBytes = state.binaryBytes;
        outputTail.append(marker);
        writeForegroundLog(state.source, marker);
        onChunk?.(marker, totalBytes);
      };

      const decodeOutput = (state: PersistentOutputStreamState, data: Buffer): void => {
        if (data.length === 0) return;
        if (state.binary) {
          state.binaryBytes += data.length;
          return;
        }
        const decoded = state.decoder.write(data);
        if (decoded.binary) {
          state.binary = true;
          state.binaryBytes += decoded.unsafeBytes;
          emitBinarySummary(state);
          return;
        }
        emitText(state.source, decoded.text);
      };

      const flushDecoder = (state: PersistentOutputStreamState): void => {
        if (state.binary) {
          emitBinarySummary(state);
          return;
        }
        const decoded = state.decoder.end();
        if (decoded.binary) {
          state.binary = true;
          state.binaryBytes += decoded.unsafeBytes;
          emitBinarySummary(state);
          return;
        }
        emitText(state.source, decoded.text);
      };

      const finish = (
        reason: ForegroundExecutionReason,
        exitCode: number | null,
        closeSignal: NodeJS.Signals | null,
        error: Error | null = null,
      ): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        child.stdout?.off("data", onStdoutData);
        child.stderr?.off("data", onStderrData);
        child.off("exit", onExit);
        child.off("error", onError);
        if (!sentinelFound && stdoutPending.length > 0) {
          totalBytes += stdoutPending.length;
          decodeOutput(stdoutState, stdoutPending);
          stdoutPending = Buffer.alloc(0);
        }
        flushDecoder(stdoutState);
        flushDecoder(stderrState);
        if (logBackpressured) {
          logBackpressured = false;
          child.stdout?.resume();
          child.stderr?.resume();
        }
        this.busy = false;
        const outputSnapshot = outputTail.snapshot();
        resolve({
          reason,
          exitCode,
          signal: closeSignal,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          pid: child.pid ?? null,
          error,
          output: outputSnapshot.content,
          outputSnapshot,
        });
      };

      const maybeFinishSentinel = (): void => {
        const newline = sentinelSuffix.indexOf("\n");
        if (newline === -1) return;
        const code = Number.parseInt(sentinelSuffix.slice(0, newline).trim(), 10);
        const exitCode = Number.isNaN(code) ? 1 : code;
        finish(exitCode === 0 ? "completed" : "nonZeroExit", exitCode, null);
      };

      const onStdoutData = (data: Buffer): void => {
        if (sentinelFound) {
          sentinelSuffix += data.toString("utf8");
          maybeFinishSentinel();
          return;
        }

        const candidate = stdoutPending.length === 0 ? data : Buffer.concat([stdoutPending, data]);
        const sentinelIndex = candidate.indexOf(sentinel);
        if (sentinelIndex !== -1) {
          const commandOutput = candidate.subarray(0, sentinelIndex);
          totalBytes += commandOutput.length;
          decodeOutput(stdoutState, commandOutput);
          stdoutPending = Buffer.alloc(0);
          sentinelFound = true;
          sentinelSuffix = candidate.subarray(sentinelIndex + sentinel.length).toString("utf8");
          maybeFinishSentinel();
          return;
        }

        const retainedPrefixBytes = longestSentinelPrefix(candidate, sentinel);
        const emitThrough = candidate.length - retainedPrefixBytes;
        const commandOutput = candidate.subarray(0, emitThrough);
        totalBytes += commandOutput.length;
        decodeOutput(stdoutState, commandOutput);
        stdoutPending = candidate.subarray(emitThrough);
      };

      const onStderrData = (data: Buffer): void => {
        totalBytes += data.length;
        decodeOutput(stderrState, data);
      };

      const interrupt = (reason: "timedOut" | "aborted"): void => {
        if (done) return;
        if (this.child === child) this.child = null;
        if (child.pid !== undefined) {
          this.startCleanup({
            pid: child.pid,
            isExited: () => child.exitCode !== null || child.signalCode !== null,
          });
        }
        finish(reason, null, child.signalCode);
      };
      const onAbort = (): void => interrupt("aborted");

      // `exit N` (or a crash) ends the session shell itself — the sentinel
      // never prints, so settle from the shell's own exit code. The next run()
      // starts a fresh session.
      const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
        if (this.child === child) this.child = null;
        if (child.pid !== undefined) {
          try {
            this.lifecycle.reapProcessWrapper({
              pid: child.pid,
              isExited: () => child.exitCode !== null || child.signalCode !== null,
            });
          } catch {
            // The shell exit result remains authoritative if wrapper reaping fails.
          }
        }
        const exitCode = code ?? (exitSignal ? null : 1);
        finish(
          exitCode === 0 ? "completed" : "nonZeroExit",
          exitCode,
          exitSignal ?? child.signalCode,
        );
      };
      const onError = (error: Error): void => {
        if (this.child === child) this.child = null;
        finish("spawnError", null, child.signalCode, error);
      };

      const timer = setTimeout(() => interrupt("timedOut"), timeoutMs);

      child.on("exit", onExit);
      child.on("error", onError);
      child.stdout?.on("data", onStdoutData);
      child.stderr?.on("data", onStderrData);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      if (!done) {
        try {
          child.stdin?.write(wrapped);
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  }

  /** Gracefully kill the session shell; the next run() starts a fresh one. */
  kill(): void {
    const childToKill = this.takeChild();
    if (childToKill?.pid !== undefined) {
      this.startCleanup({
        pid: childToKill.pid,
        isExited: () => childToKill.exitCode !== null || childToKill.signalCode !== null,
      });
    }
  }

  /** Immediately kill the session tree from synchronous process-exit hooks. */
  killNow(): void {
    const childToKill = this.takeChild();
    if (childToKill?.pid === undefined) return;
    try {
      this.lifecycle.killProcessTree({
        pid: childToKill.pid,
        isExited: () => childToKill.exitCode !== null || childToKill.signalCode !== null,
      });
    } catch (error) {
      log("WARN", "bash", "Immediate persistent process-tree cleanup failed", {
        pid: String(childToKill.pid),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private takeChild(): ChildProcess | null {
    const childToKill = this.child;
    this.child = null;
    this.busy = false;
    return childToKill;
  }
}
