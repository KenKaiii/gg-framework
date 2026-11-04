import type { spawnSync } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { killProcessTree } from "../utils/process.js";
import { getSafeToolEnv } from "../tools/safe-env.js";
import { resolveShell, type ShellResolution } from "./shell.js";
import type { AgentNotificationQueue } from "./agent-notifications.js";

export interface BackgroundProcess {
  id: string;
  pid: number;
  command: string;
  logFile: string;
  startedAt: number;
  exitCode: number | null;
  lastReadOffset: number;
  /** Unread one-shot wake, retained even if it fired before task_output waited. */
  wakeReason?: "pattern" | "silence";
  /**
   * Last known size of `logFile` in bytes. Kept current by the progress
   * watcher, the exit handler and every `readOutput`, so consumers (notably
   * the pre-stop process gate) can tell "output was never consumed" from
   * "output was read" without an fs stat per check.
   */
  logSize: number;
}

export interface StartResult {
  id: string;
  pid: number;
  logFile: string;
  /** False when wake rules were requested but no notification queue is wired,
   *  so callers must not promise the model a wake that can never fire. */
  wakeArmed: boolean;
}

export interface ReadOutputResult {
  id: string;
  isRunning: boolean;
  exitCode: number | null;
  output: string;
}

const BG_DIR = path.join(os.homedir(), ".gg", "bg");

/**
 * How long a background process log survives after its last write.
 *
 * Every `start()` opens a new `<id>.log` and nothing ever removed them, so the
 * directory grew without bound for the lifetime of the install — measured at
 * 14,358 files / 494MB on a single developer machine, with entries dating back
 * five months. These are debugging aids for a process the agent started; once
 * the run is long over, so is their value.
 */
const BG_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Throttle between prune sweeps, so a burst of `start()` calls scans once. */
const BG_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Delay before a running process may first report progress. */
const WATCH_INTERVAL_MS = 5_000;
/** Tick for model-declared wake rules (match/silence). Cheap: one stat + a
 * bounded tail read, so a flat interval (no backoff) is fine. */
const WAKE_INTERVAL_MS = 500;
/** Ceiling on the progress interval as it backs off between reports. */
const WATCH_INTERVAL_MAX_MS = 120_000;
/**
 * How many progress checkpoints one background process may push, ever.
 *
 * A progress checkpoint is worth most early ("the build is underway", "it died
 * on startup") and approaches zero after that: a dev server the agent started
 * itself, still logging an hour on, tells it nothing it doesn't already know
 * and can always be inspected on demand with `task_output`.
 *
 * At a flat interval with no budget, such a server produced a fresh checkpoint
 * for essentially every loop step — measured here at ~2k tokens per minute of
 * overlap, i.e. a whole context window per hour spent restating "still
 * running".
 *
 * Anthropic reached the same conclusion the hard way: Claude Code shipped
 * periodic background status into the model's context as `task_progress` and
 * `background_task_status` attachments, then REMOVED both (they survive only in
 * a `LEGACY_ATTACHMENT_TYPES` list that drops them from resumed sessions).
 * Their progress is now a host-side stream event for the UI, and the only thing
 * pushed into context is the terminal completion notice.
 *
 * We keep a small early budget rather than going to zero: the first few reports
 * are what let the agent notice a build that died on startup without blocking
 * on it. Combined with the backoff those land at ~5s, ~15s and ~35s, after
 * which the watcher retires and only the exit notification remains.
 */
const WATCH_MAX_REPORTS = 3;
/** Chars of log tail carried in a progress checkpoint. */
const CHECKPOINT_TAIL_CHARS = 320;
/** Ceiling on a single blocking `waitForExitOrWake`, so one wedged process cannot
 *  hold the agent loop indefinitely; callers re-wait if they still want to. */
export const MAX_PROCESS_WAIT_MS = 600_000;
/** Output a foreground command produced before {@link ProcessManager.adopt} that
 *  is kept in its log; the rest was already shown to nobody and only costs disk. */
const ADOPTED_PRIOR_OUTPUT_BYTES = 1024 * 1024;
/** Chars of the matched log line carried in a pattern-wake notification. */
const WAKE_LINE_CHARS = 200;

/** One log line, whitespace-collapsed and tail-bounded — never the raw log. */
function boundedLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length <= WAKE_LINE_CHARS
    ? collapsed
    : `\u2026${collapsed.slice(collapsed.length - WAKE_LINE_CHARS)}`;
}

/**
 * Model-declared wake conditions for a background task. The agent states up
 * front what output it cares about (or what silence means), and the watcher
 * turns exactly that into a steering-path notification — instead of the model
 * polling `task_output` (measured elsewhere at 71 wasted turns on one build)
 * or re-reading generic progress checkpoints hoping to spot the signal.
 */
export interface WakeRules {
  /** Wake the moment new log output matches this regex. One-shot. */
  pattern?: RegExp;
  /** Wake when the process is still running but has logged nothing for this
   *  many milliseconds (a stalled build/hang detector). One-shot. */
  silenceMs?: number;
}

interface WakeState {
  rules: WakeRules;
  /** Log offset already scanned for `pattern`; new bytes only. */
  scanOffset: number;
  /** Log size at the last tick that saw growth; drives the silence rule. */
  lastSize: number;
  lastGrowthAt: number;
  matched: boolean;
  silenceFired: boolean;
}

/** Last line(s) of the log, collapsed and bounded — never the raw log. */
function tailDigest(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length <= CHECKPOINT_TAIL_CHARS
    ? collapsed
    : `\u2026${collapsed.slice(collapsed.length - CHECKPOINT_TAIL_CHARS)}`;
}

function formatElapsed(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 6_000) / 10}m` : `${Math.round(ms / 1_000)}s`;
}

export interface ProcessManagerOps {
  platform?: NodeJS.Platform;
  kill?: typeof process.kill;
  killProcessTree?: (pid: number) => void;
  spawnSync?: typeof spawnSync;
  /**
   * Push queue for background-process progress checkpoints. When set, a long
   * build reports progress and its exit code into the agent's next turn
   * instead of waiting to be polled with `task_output`.
   */
  notifications?: AgentNotificationQueue;
  /**
   * Directory for background process logs. Defaults to the real `~/.gg/bg`.
   *
   * Injectable because this manager both writes AND prunes here: a test that
   * calls `start()` without an override operates on the developer's own log
   * history. That is not hypothetical — running the suite once deleted ~12.7k
   * real logs off a machine before this parameter existed.
   */
  bgDir?: string;
  /**
   * Base delay before the first progress report, in ms. Defaults to
   * {@link WATCH_INTERVAL_MS}.
   *
   * Injectable so tests can assert the watcher's BEHAVIOUR (reports, backoff,
   * budget, retirement) without waiting out the production 5s/10s/20s cadence.
   * A test that waits real seconds for a real subprocess is a test whose result
   * depends on how loaded the machine is: the budget test used to fail under
   * `pnpm test` (12 packages in parallel) while passing when run alone.
   */
  watchIntervalMs?: number;
}

function stopProcessTree(pid: number, ops: ProcessManagerOps = {}): void {
  if (ops.killProcessTree) {
    ops.killProcessTree(pid);
    return;
  }
  // killProcessTree is itself platform-aware (taskkill /T /F on Windows).
  killProcessTree(pid, { platform: ops.platform, kill: ops.kill, spawnSync: ops.spawnSync });
}

export class ProcessManager {
  private processes = new Map<string, BackgroundProcess>();
  private children = new Map<string, ChildProcess>();
  /** Per-process progress timers. Cleared on exit, stop and shutdown. */
  private watchers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per-process wake-rule timers (model-declared match/silence conditions). */
  private wakeWatchers = new Map<string, ReturnType<typeof setTimeout>>();
  private wakeStates = new Map<string, WakeState>();
  /** Log size at the last emitted checkpoint, so a quiet process stays quiet. */
  private watchedSizes = new Map<string, number>();
  /** Timestamp of the last retention sweep; 0 means "never swept". */
  private lastPruneAt = 0;

  constructor(private readonly ops: ProcessManagerOps = {}) {}

  private get bgDir(): string {
    return this.ops.bgDir ?? BG_DIR;
  }

  /**
   * Delete background logs whose last write is older than the retention window.
   *
   * Deliberately best-effort and never awaited by `start()`: losing an old log
   * is harmless, but failing to launch the user's process because a stale log
   * couldn't be unlinked is not. Logs belonging to processes this manager still
   * tracks are skipped regardless of age — a quiet long-running dev server can
   * easily go a week without writing a line, and its log must stay readable.
   */
  private async pruneOldLogs(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPruneAt < BG_PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;

    let entries: string[];
    try {
      entries = await fsp.readdir(this.bgDir);
    } catch {
      return; // Directory missing or unreadable; nothing to prune.
    }

    const live = new Set([...this.processes.keys()].map((id) => `${id}.log`));
    const cutoff = now - BG_LOG_RETENTION_MS;
    for (const entry of entries) {
      if (!entry.endsWith(".log") || live.has(entry)) continue;
      const file = path.join(this.bgDir, entry);
      try {
        const stat = await fsp.stat(file);
        if (stat.mtimeMs >= cutoff) continue;
        await fsp.unlink(file);
      } catch {
        // Raced with another sweep or held open elsewhere; try again next time.
      }
    }
  }

  async start(
    command: string,
    cwd: string,
    launch?: ShellResolution,
    wake?: WakeRules,
  ): Promise<StartResult> {
    await fsp.mkdir(this.bgDir, { recursive: true });
    void this.pruneOldLogs();

    const id = crypto.randomUUID().slice(0, 8);
    const logFile = path.join(this.bgDir, `${id}.log`);
    const fd = fs.openSync(logFile, "w");

    // Cross-platform shell (see core/shell.ts): bash on POSIX, Git Bash on
    // Windows, cmd.exe fallback. Same resolution as the foreground bash tool.
    const shell = launch ?? resolveShell(command);
    const child = spawn(shell.file, shell.args, {
      cwd,
      detached: true,
      // stdin is a pipe so callers can drive interactive processes (REPLs,
      // scaffolders, [Y/n] prompts) via sendInput(); stdout/stderr go to the log.
      stdio: ["pipe", fd, fd],
      env: getSafeToolEnv(),
    });

    fs.closeSync(fd);

    // Swallow EPIPE: writing to a process that has already exited would
    // otherwise emit an unhandled 'error' and crash the host.
    child.stdin?.on("error", () => {});

    const pid = child.pid!;
    child.unref();

    const proc: BackgroundProcess = {
      id,
      pid,
      command,
      logFile,
      startedAt: Date.now(),
      exitCode: null,
      lastReadOffset: 0,
      logSize: 0,
    };
    return this.track(child, proc, wake);
  }

  /**
   * Take over a foreground command that is still running, so the caller can
   * return without killing it. Output captured so far seeds the log (its last
   * {@link ADOPTED_PRIOR_OUTPUT_BYTES} only); later stdout/stderr is appended
   * as it arrives. The process keeps its cwd and environment because it is the
   * same process. Its stdin was never a pipe, so `sendInput` reports it closed.
   *
   * Synchronous on purpose: the caller hands over a live child whose 'close'
   * has not fired yet, and an `await` here could let it fire unobserved.
   */
  adopt(child: ChildProcess, command: string, startedAt: number, priorOutput: Buffer): StartResult {
    fs.mkdirSync(this.bgDir, { recursive: true });
    void this.pruneOldLogs();

    const id = crypto.randomUUID().slice(0, 8);
    const logFile = path.join(this.bgDir, `${id}.log`);
    const prior =
      priorOutput.length > ADOPTED_PRIOR_OUTPUT_BYTES
        ? Buffer.concat([
            Buffer.from(
              `[earlier output dropped; last ${ADOPTED_PRIOR_OUTPUT_BYTES / 1024 / 1024} MiB kept]\n`,
            ),
            priorOutput.subarray(priorOutput.length - ADOPTED_PRIOR_OUTPUT_BYTES),
          ])
        : priorOutput;
    const fd = fs.openSync(logFile, "w");
    fs.writeSync(fd, prior);
    // Synchronous appends keep the log ordered and complete by the time
    // 'close' fires, which the exit bookkeeping and waiters rely on.
    const append = (data: Buffer): void => {
      try {
        fs.writeSync(fd, data);
      } catch {
        // Disk full or log removed: drop output rather than crash the host.
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("close", () => fs.closeSync(fd));
    // Never hold the host's event loop open for a process it no longer awaits.
    child.unref();
    for (const stream of [child.stdout, child.stderr]) {
      (stream as { unref?: () => void } | null)?.unref?.();
    }

    const proc: BackgroundProcess = {
      id,
      pid: child.pid ?? 0,
      command,
      logFile,
      startedAt,
      exitCode: null,
      lastReadOffset: 0,
      logSize: prior.length,
    };
    return this.track(child, proc);
  }

  /** Register a running child and arm its exit bookkeeping and watchers. */
  private track(child: ChildProcess, proc: BackgroundProcess, wake?: WakeRules): StartResult {
    const { id, pid, logFile } = proc;
    this.processes.set(id, proc);
    this.children.set(id, child);

    // A child that fails to spawn emits 'error', and an 'error' with no listener
    // is thrown as an uncaught exception that takes the whole CLI down. 'close'
    // still fires afterwards (verified: ENOENT gives error then close -2), so
    // exit bookkeeping below stays the single source of truth and this handler
    // only has to keep the event from being fatal.
    child.on("error", () => {});

    child.on("close", (code) => {
      proc.exitCode = code ?? 1;
      this.children.delete(id);
      this.disposeWatcher(id);
      // Refresh unconditionally: the gate needs a final size even when no
      // notification queue is wired and notifyExit is a no-op.
      void this.refreshLogSize(proc).then(() => this.notifyExit(proc));
    });

    this.armWatcher(proc);
    let wakeArmed = false;
    if (wake && (wake.pattern || wake.silenceMs)) {
      wakeArmed = this.armWakeWatcher(proc, wake);
    }

    return { id, pid, logFile, wakeArmed };
  }

  /**
   * Arm a backing-off, budgeted progress watcher for one background process.
   * Emits at most one latest-only checkpoint per interval, only when the log
   * actually grew, and at most {@link WATCH_MAX_REPORTS} times in total — so a
   * build reports itself early without the agent ever calling `task_output`,
   * while an idle or long-lived process stops costing context.
   *
   * Once the budget is spent the watcher retires completely (no timer, no
   * further injections). The terminal exit notification is unaffected: it is
   * produced by the exit handler, not this watcher, so "it finished" always
   * still reaches the agent.
   *
   * Self-rescheduling rather than `setInterval` because the delay changes; a
   * tick is only scheduled once the previous one has been handled.
   *
   * No-op when no notification queue is wired, so hosts that never drain
   * notifications pay nothing.
   */
  private armWatcher(proc: BackgroundProcess): void {
    const queue = this.ops.notifications;
    if (!queue) return;
    this.watchedSizes.set(proc.id, 0);

    let delay = this.ops.watchIntervalMs ?? WATCH_INTERVAL_MS;
    let reports = 0;
    const schedule = (): void => {
      const timer = setTimeout(() => {
        // The process may have exited between ticks; the terminal checkpoint
        // owns that case and must not be overwritten by a stale progress line.
        if (proc.exitCode !== null) {
          this.disposeWatcher(proc.id);
          return;
        }
        void this.emitProgress(proc).then((emitted) => {
          // Re-check: the process can exit while the tail read is in flight,
          // and disposeWatcher may already have cleared this entry.
          if (proc.exitCode !== null || !this.watchers.has(proc.id)) return;
          if (emitted && ++reports >= WATCH_MAX_REPORTS) {
            // Retire generic progress only; declared readiness must still fire
            // if a slow server finishes starting after this budget is spent.
            this.disposeProgressWatcher(proc.id);
            return;
          }
          // Back off only on an actual report. A process that goes quiet must
          // NOT drift towards the cap while emitting nothing — otherwise a dev
          // server that idles and then fails a recompile is heard about minutes
          // late. Silence is already free; only chattiness needs damping.
          if (emitted) delay = Math.min(delay * 2, WATCH_INTERVAL_MAX_MS);
          schedule();
        });
      }, delay);
      // Never hold the event loop open for a detached background process.
      timer.unref?.();
      this.watchers.set(proc.id, timer);
    };
    schedule();
  }

  /** Stat the log once and cache its size on the record. Returns 0 if unreadable. */
  private async refreshLogSize(proc: BackgroundProcess): Promise<number> {
    try {
      proc.logSize = (await fsp.stat(proc.logFile)).size;
    } catch {
      // Log may be gone (pruned, or never created); keep the last known size.
    }
    return proc.logSize;
  }

  /** Emit one progress checkpoint if the log grew. Returns whether it did. */
  private async emitProgress(proc: BackgroundProcess): Promise<boolean> {
    const queue = this.ops.notifications;
    if (!queue) return false;
    const size = await this.refreshLogSize(proc);
    const previous = this.watchedSizes.get(proc.id) ?? 0;
    if (size <= previous) return false;
    if (proc.exitCode !== null) return false;

    const tail = await this.readTail(proc.logFile, size);
    // The tail read can race a dispose: a wake rule firing (its declared
    // signal outranks generic progress) or the process exiting (the terminal
    // notification owns that case). An enqueue after that would supersede
    // that notification in the latest-only queue, so a disposed watcher
    // stays silent.
    if (!this.watchers.has(proc.id)) return false;
    this.watchedSizes.set(proc.id, size);
    queue.enqueue(
      "process",
      proc.id,
      `Background process ${proc.id} (${proc.command}) is still running after ` +
        `${formatElapsed(Date.now() - proc.startedAt)}, ${size} bytes logged` +
        `${tail ? `. Latest: ${tail}` : ""}`,
    );
    return true;
  }

  private notifyExit(proc: BackgroundProcess): void {
    const queue = this.ops.notifications;
    if (!queue) return;
    void (async () => {
      const size = proc.logSize;
      const tail = size > 0 ? await this.readTail(proc.logFile, size) : "";
      queue.enqueue(
        "process",
        proc.id,
        `Background process ${proc.id} (${proc.command}) exited with code ${proc.exitCode} ` +
          `after ${formatElapsed(Date.now() - proc.startedAt)}` +
          `${tail ? `. Last output: ${tail}` : ""}. ` +
          `Read it with task_output id="${proc.id}".`,
        { terminal: true },
      );
    })();
  }

  /** Read the trailing bytes of a log without loading the whole file. */
  private async readTail(logFile: string, size: number): Promise<string> {
    const start = Math.max(0, size - CHECKPOINT_TAIL_CHARS * 4);
    try {
      const fh = await fsp.open(logFile, "r");
      try {
        const buf = Buffer.alloc(size - start);
        const { bytesRead } = await fh.read(buf, 0, buf.length, start);
        return tailDigest(buf.subarray(0, bytesRead).toString("utf-8"));
      } finally {
        await fh.close();
      }
    } catch {
      return "";
    }
  }

  /** Read the bytes of a log in `[start, end)` without loading the file. */
  private async readRange(logFile: string, start: number, end: number): Promise<string> {
    try {
      const fh = await fsp.open(logFile, "r");
      try {
        const buf = Buffer.alloc(Math.max(0, end - start));
        const { bytesRead } = await fh.read(buf, 0, buf.length, start);
        return buf.subarray(0, bytesRead).toString("utf-8");
      } finally {
        await fh.close();
      }
    } catch {
      return "";
    }
  }

  /**
   * Wake-rule watcher: evaluates the model's `pattern`/`silenceMs` conditions
   * every {@link WAKE_INTERVAL_MS} and pushes a steering-path notification the
   * moment one holds. Each rule is one-shot; once every declared rule has fired
   * (or the process exits) the watcher retires. Unlike the progress watcher it
   * never backs off — the agent asked for exactly this signal, however long it
   * takes, and a late match on a quiet dev server is precisely the point.
   */
  private armWakeWatcher(proc: BackgroundProcess, rules: WakeRules): boolean {
    if (!this.ops.notifications) return false; // No queue wired: nothing to wake.
    const state: WakeState = {
      rules,
      scanOffset: 0,
      lastSize: 0,
      lastGrowthAt: proc.startedAt,
      matched: false,
      silenceFired: false,
    };
    this.wakeStates.set(proc.id, state);
    const patternSource = rules.pattern?.source ?? "";
    // Re-scan a little before the last offset so a match straddling the tick
    // boundary is still seen; the offset only ever advances to full size.
    const overlap = Math.min(256, patternSource.length + 16);
    const tick = (): void => {
      const timer = setTimeout(() => {
        void this.evaluateWakeRules(proc, state, overlap).then(() => {
          if (proc.exitCode !== null || !this.wakeStates.has(proc.id)) {
            this.disposeWakeWatcher(proc.id);
            return;
          }
          const done =
            (!state.rules.pattern || state.matched) &&
            (!state.rules.silenceMs || state.silenceFired);
          if (done) {
            this.disposeWakeWatcher(proc.id);
            return;
          }
          tick();
        });
      }, WAKE_INTERVAL_MS);
      timer.unref?.();
      this.wakeWatchers.set(proc.id, timer);
    };
    tick();
    return true;
  }

  private async evaluateWakeRules(
    proc: BackgroundProcess,
    state: WakeState,
    overlap: number,
  ): Promise<void> {
    const queue = this.ops.notifications;
    if (!queue) return;
    const size = await this.refreshLogSize(proc);

    if (size > state.lastSize) {
      state.lastSize = size;
      state.lastGrowthAt = Date.now();
    }

    const { pattern, silenceMs } = state.rules;
    if (pattern && !state.matched && size > state.scanOffset) {
      const start = Math.max(0, state.scanOffset - overlap);
      const chunk = await this.readRange(proc.logFile, start, size);
      if (proc.exitCode !== null || !this.wakeStates.has(proc.id)) return;
      state.scanOffset = size;
      const match = pattern.exec(chunk);
      if (match) {
        state.matched = true;
        // The declared signal outranks generic progress: retire the progress
        // watcher so its next tick cannot supersede this notification in the
        // latest-only queue. Exit notifications come from the exit handler.
        this.disposeProgressWatcher(proc.id);
        const line =
          chunk
            .slice(Math.max(0, match.index - WAKE_LINE_CHARS))
            .split("\n")
            .find((l) => pattern.test(l)) ?? match[0];
        queue.enqueue(
          "process",
          proc.id,
          `Background process ${proc.id} (${proc.command}) produced output matching your wake ` +
            `pattern /${pattern.source}/: ${boundedLine(line)}. Still running — ` +
            `task_output id="${proc.id}" for full context.`,
        );
        proc.wakeReason = "pattern";
        this.children.get(proc.id)?.emit("gg:wake", proc.wakeReason);
      }
    }

    if (
      silenceMs &&
      !state.silenceFired &&
      proc.exitCode === null &&
      Date.now() - state.lastGrowthAt >= silenceMs
    ) {
      state.silenceFired = true;
      this.disposeProgressWatcher(proc.id);
      const tail = await this.readTail(proc.logFile, size);
      if (proc.exitCode !== null || !this.wakeStates.has(proc.id)) return;
      queue.enqueue(
        "process",
        proc.id,
        `Background process ${proc.id} (${proc.command}) has produced no output for ` +
          `${Math.round((Date.now() - state.lastGrowthAt) / 1000)}s — it may be stalled` +
          `${tail ? `. Last output: ${tail}` : " (no output so far)"}. ` +
          `Check task_output id="${proc.id}" and decide whether to wait, send input, or stop it.`,
      );
      proc.wakeReason = "silence";
      this.children.get(proc.id)?.emit("gg:wake", proc.wakeReason);
    }
  }

  /** Stop and forget a process's wake watcher. */
  private disposeWakeWatcher(id: string): void {
    const timer = this.wakeWatchers.get(id);
    if (timer) clearTimeout(timer);
    this.wakeWatchers.delete(id);
    this.wakeStates.delete(id);
  }

  /** Live wake-watcher ids. Exposed for leak assertions in tests. */
  activeWakeWatchers(): string[] {
    return [...this.wakeWatchers.keys()];
  }

  /** Stop and forget a process's watcher. A finished process keeps no timer. */
  private disposeWatcher(id: string): void {
    this.disposeProgressWatcher(id);
    this.disposeWakeWatcher(id);
  }

  /** Stop and forget a process's progress watcher only. */
  private disposeProgressWatcher(id: string): void {
    const timer = this.watchers.get(id);
    if (timer) clearTimeout(timer);
    this.watchers.delete(id);
    this.watchedSizes.delete(id);
  }

  /** Live watcher ids. Exposed for leak assertions in tests. */
  activeWatchers(): string[] {
    return [...this.watchers.keys()];
  }

  /**
   * Block until a process exits or a declared wake fires, bounded by `timeoutMs`.
   * Steering notifications cannot interrupt a tool call; the wake must also
   * release this wait directly so a ready dev server doesn't wait for shutdown.
   *
   * Without this, "wait for the build" can only be expressed as a guessed
   * `sleep N`: too short burns a turn, too long burns wall-clock, and neither
   * knows when the process actually finished. The wake/exit notifications
   * answer the same question but only on the steering path — they need a next
   * loop step to be delivered, which is exactly what an agent with nothing
   * else to do does not have.
   */
  async waitForExitOrWake(
    id: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<"exited" | "timeout" | "unknown" | "pattern" | "silence"> {
    const proc = this.processes.get(id);
    if (!proc) return "unknown";
    const child = this.children.get(id);
    // Already terminal (or no live child tracked): nothing to wait on.
    if (!child || proc.exitCode !== null) return "exited";
    if (signal?.aborted) return "timeout";
    if (proc.wakeReason) return proc.wakeReason;
    const bounded = Math.min(Math.max(timeoutMs, 0), MAX_PROCESS_WAIT_MS);
    return await new Promise((resolve) => {
      const settle = (outcome: "exited" | "timeout" | "pattern" | "silence"): void => {
        clearTimeout(timer);
        child.off("close", onClose);
        child.off("gg:wake", onWake);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      // Registered after start()'s own 'close' handler, so `exitCode` is
      // already set by the time this resolves.
      const onClose = (): void => settle("exited");
      const onWake = (reason: "pattern" | "silence"): void => settle(reason);
      // Give up the wait when the caller is cancelled; the process itself is
      // left running — this only ends our observation of it.
      const onAbort = (): void => settle("timeout");
      const timer = setTimeout(() => settle("timeout"), bounded);
      timer.unref?.();
      child.once("close", onClose);
      child.once("gg:wake", onWake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async readOutput(id: string, fromStart?: boolean): Promise<ReadOutputResult> {
    const proc = this.processes.get(id);
    if (!proc) {
      return {
        id,
        isRunning: false,
        exitCode: null,
        output: `No background process with id "${id}"`,
      };
    }

    delete proc.wakeReason;
    const offset = fromStart ? 0 : proc.lastReadOffset;
    let output = "";

    try {
      const stat = await fsp.stat(proc.logFile);
      proc.logSize = stat.size;
      if (stat.size > offset) {
        const buf = Buffer.alloc(stat.size - offset);
        const fh = await fsp.open(proc.logFile, "r");
        const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
        await fh.close();
        output = buf.subarray(0, bytesRead).toString("utf-8");
        proc.lastReadOffset = offset + bytesRead;
      }
    } catch {
      output = "(failed to read log file)";
    }

    const isRunning = this.children.has(id);
    return { id, isRunning, exitCode: proc.exitCode, output };
  }

  /**
   * Write input to a running background process's stdin, enabling interactive
   * control (answer prompts, drive a REPL, feed a scaffolder). By default a
   * newline is appended (as if the user pressed Enter). Set `eof` to close
   * stdin afterwards, signalling end-of-input (Ctrl-D) to the program.
   */
  async sendInput(
    id: string,
    input: string,
    opts: { enter?: boolean; eof?: boolean } = {},
  ): Promise<string> {
    const proc = this.processes.get(id);
    if (!proc) return `No background process with id "${id}"`;

    const child = this.children.get(id);
    if (!child || proc.exitCode !== null) {
      return `Process ${id} already exited (code ${proc.exitCode})`;
    }

    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      return `Process ${id} is not accepting input (stdin is closed).`;
    }

    const enter = opts.enter ?? true;
    const text = input + (enter ? "\n" : "");

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

  async stop(id: string): Promise<string> {
    const proc = this.processes.get(id);
    if (!proc) return `No background process with id "${id}"`;

    const child = this.children.get(id);
    if (!child || proc.exitCode !== null) {
      return `Process ${id} already exited (code ${proc.exitCode})`;
    }

    const isWindows = (this.ops.platform ?? process.platform) === "win32";
    if (isWindows) {
      // Windows has no process groups and no real SIGTERM: signalling the
      // wrapper only orphans its descendants. Force-kill the PID tree up front.
      stopProcessTree(proc.pid, this.ops);
    } else {
      // SIGTERM the group first so POSIX children get a chance to clean up.
      try {
        (this.ops.kill ?? process.kill)(-proc.pid, "SIGTERM");
      } catch {
        try {
          (this.ops.kill ?? process.kill)(proc.pid, "SIGTERM");
        } catch {
          return `Process ${id} already exited`;
        }
      }
    }

    // Wait up to 5s, then hard-kill a surviving tree.
    const exited = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      child.on("close", () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });

    if (!exited) {
      if (isWindows) {
        return `Failed to stop process ${id}: it did not exit within 5 seconds and may still be running.`;
      }
      stopProcessTree(proc.pid, this.ops);
    }

    return `Process ${id} stopped`;
  }

  list(): BackgroundProcess[] {
    // Prune completed processes older than 5 minutes to prevent Map growth
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [id, proc] of this.processes) {
      if (proc.exitCode !== null && !this.children.has(id) && proc.startedAt < cutoff) {
        this.processes.delete(id);
        this.disposeWatcher(id);
      }
    }
    return Array.from(this.processes.values());
  }

  shutdownAll(): void {
    for (const [id, proc] of this.processes) {
      if (this.children.has(id)) {
        stopProcessTree(proc.pid, this.ops);
        proc.exitCode = proc.exitCode ?? 1;
        this.children.delete(id);
      }
      this.disposeWatcher(id);
    }
  }
}
