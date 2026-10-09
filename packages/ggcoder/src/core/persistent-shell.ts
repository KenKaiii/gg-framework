/**
 * Persistent bash session for the bash tool's opt-in `persist` mode.
 *
 * One long-lived bash per instance; commands are written to stdin and
 * delimited with a sentinel that carries the exit code. Benchmarked at ~0.3ms
 * per call vs ~6.4ms for spawn-per-call (see bash-spawn-benchmark.ts), and —
 * the real win — cd/env/shell state survive across calls.
 *
 * Losing that state silently is the failure mode this file guards against:
 *
 * - Timeout / abort stops only the running command: the shell gets SIGUSR1
 *   (its trap breaks out of the wrapper loop, so the rest of the command list
 *   is skipped) and every descendant of the shell is SIGTERM'd, then
 *   SIGKILL'd. The shell itself survives with its cwd/env. Only if it still
 *   has not printed the sentinel after a grace period (a builtin busy loop, a
 *   user trap) is the whole shell killed.
 * - After every command the sentinel line snapshots the physical cwd and
 *   `export -p` to a private temp file (builtins + one redirect, no fork).
 * - When the shell dies (`exit`, `kill -9 $$`, OOM, or the fallback kill
 *   above) a fresh shell is started at once and restored from that snapshot,
 *   and the result carries a one-line note saying so. The command that killed
 *   it is never re-run.
 *
 * Callers must fall back to spawn-per-call when bash is unavailable (Windows
 * cmd.exe fallback path). On Windows (Git Bash) a command cannot be stopped
 * without the shell — MSYS pids are not native pids and there are no POSIX
 * signals — so timeout/abort still kills the shell tree, but the restart
 * restores cwd/env the same way.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sliceHead } from "@kenkaiiii/gg-ai";
import { resolveShell, type ResolveShellOpts, type ShellResolution } from "./shell.js";
import { killProcessTree, listDescendantPids, signalDescendants } from "../utils/process.js";

export interface PersistentRunResult {
  exitCode: number | "TIMEOUT";
  output: string;
  /** Timeout/abort only: true when the command was stopped and the shell kept its state. */
  shellKept?: boolean;
}

/** How long a stopped command's shell gets to print its sentinel before it is killed. */
const INTERRUPT_GRACE_MS = 2_000;
/** Re-sweep for descendants the command forked after the first signal. */
const INTERRUPT_SWEEP_MS = 200;
/** Startup handshake / state restore of a freshly spawned shell. */
const SETUP_TIMEOUT_MS = 10_000;

/** Interrupt trap: `break` out of every loop, including the per-command wrapper loop. */
const SETUP_SCRIPT = "trap 'break 1000 2>/dev/null' USR1";

type RawResult =
  | { kind: "done"; code: number; output: string }
  | {
      kind: "exited";
      code: number | null;
      signal: NodeJS.Signals | null;
      output: string;
    }
  | {
      kind: "timeout" | "abort";
      shellKept: boolean;
      /** The command was interrupted but the shell did not finish within the grace period. */
      stuck?: boolean;
      output: string;
    }
  | { kind: "error"; output: string };

interface Snapshot {
  cwd: string | null;
  env: string;
}

const stateDirs = new Set<string>();
let exitHookInstalled = false;
function trackStateDir(dir: string): void {
  stateDirs.add(dir);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const d of stateDirs) rmSync(d, { recursive: true, force: true });
  });
}

/** Single-quote for bash. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Split a state file (`pwd -P` line, then `export -p`) into cwd + env script.
 * Variables the new shell must own (PWD, OLDPWD, SHLVL) are dropped.
 */
export function parseStateSnapshot(text: string): Snapshot | null {
  if (!text.trim()) return null;
  // The cwd may in theory contain a newline, so split at the first export line.
  const m = /\n(?=declare -|export )/.exec(text);
  const cwd = (m ? text.slice(0, m.index) : text.replace(/\n$/, "")) || null;
  const env = m
    ? text
        .slice(m.index + 1)
        .split("\n")
        .filter((line) => !/^(declare -\S+|export) (PWD|OLDPWD|SHLVL)(=|$)/.test(line))
        .join("\n")
    : "";
  return { cwd, env };
}

/** Restore script: env first (its PWD is filtered), then cd, then report where we landed. */
export function buildRestoreScript(snapshot: Snapshot): string {
  const env = snapshot.env.trim() ? `{ ${snapshot.env}\n} >/dev/null 2>&1\n` : "";
  const cd = snapshot.cwd ? `builtin cd -- ${shellQuote(snapshot.cwd)} >/dev/null 2>&1\n` : "";
  return `${env}${cd}builtin pwd -P`;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `killed by ${signal}`;
  return code === null ? "exited" : `exited with code ${code}`;
}

export class PersistentShell {
  private child: ChildProcess | null = null;
  /** The shell's own `$$`, used to stop just its command. */
  private shellPid: number | null = null;
  private busy = false;
  private stateDir: string | null = null;
  /**
   * One-line notes about restarts, kept until `takeRestartNote()` so a helper
   * run (e.g. a guard's `pwd`) cannot swallow the note meant for the model.
   */
  private pendingNotes: string[] = [];
  /** Bumped by kill(): a run cut short by an explicit kill must not restart the shell. */
  private generation = 0;

  constructor(
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly maxOutputBytes: number,
    private readonly shellOpts?: ResolveShellOpts,
    private readonly launch?: ShellResolution,
  ) {}

  /**
   * Consume the note(s) for the model about shell restarts since the last
   * call, e.g. `[Shell exited with code 3, so it was restarted; restored
   * working directory /x and exported environment variables. …]`.
   */
  takeRestartNote(): string | undefined {
    const note = this.pendingNotes.join("\n") || undefined;
    this.pendingNotes = [];
    return note;
  }

  /** True while a previous persistent command is still running. */
  get isBusy(): boolean {
    return this.busy;
  }

  /** Private 0700 temp dir holding the state snapshot; null if unavailable. */
  private get statePath(): string | null {
    if (!this.stateDir) {
      try {
        this.stateDir = mkdtempSync(path.join(os.tmpdir(), "gg-psh-"));
        trackStateDir(this.stateDir);
      } catch {
        return null;
      }
    }
    return path.join(this.stateDir, "state.sh");
  }

  private readSnapshot(): Snapshot | null {
    const file = this.stateDir ? path.join(this.stateDir, "state.sh") : null;
    if (!file) return null;
    try {
      return parseStateSnapshot(readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
  }

  private spawnChild(): ChildProcess {
    // Fresh session: no rc files so startup is fast and deterministic.
    //
    // Spawn the SAME bash the one-shot path resolved, not a bare `bash`: on
    // Windows the caller only reaches persist mode when Git Bash was found,
    // but Git for Windows puts `cmd\` on PATH and `bash.exe` in `bin\` — so a
    // bare `bash` spawn is ENOENT and every persist-mode command failed.
    const resolved = this.launch ?? resolveShell("", this.shellOpts);
    // -o pipefail mirrors the one-shot path: pipelines keep the failing
    // stage's exit status instead of the trailing limiter's 0.
    const args = this.launch ? resolved.args : ["--norc", "--noprofile", "-o", "pipefail"];
    const child = spawn(resolved.file, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
      // Windows has no process groups; `detached` there only orphans the shell
      // past a parent crash instead of grouping it for a clean tree-kill.
      detached: process.platform !== "win32",
    });
    // Writing to a shell that just died is EPIPE on stdin; the exit handler
    // reports it, so don't let the stream error crash the process.
    child.stdin?.on("error", () => {});
    // Don't let a lingering session shell keep the parent process alive.
    child.unref();
    this.child = child;
    this.shellPid = null;
    return child;
  }

  /** Spawn a shell, install the interrupt trap and learn its pid. */
  private async startShell(): Promise<boolean> {
    const child = this.spawnChild();
    const res = await this.send(child, `${SETUP_SCRIPT}; builtin echo "$$"`, SETUP_TIMEOUT_MS);
    if (res.kind !== "done") {
      this.hardKill(child);
      return false;
    }
    const pid = parseInt(res.output.trim().split("\n").pop() ?? "", 10);
    this.shellPid = Number.isNaN(pid) ? null : pid;
    return true;
  }

  /**
   * Replace a dead (or killed) shell with a fresh one restored from the
   * snapshot taken after the last completed command. Returns the one-line
   * note for the tool result: `[Shell <how>, so it was restarted; <restored>.
   * <lost> <tail>]`.
   */
  private async restart(how: string, tail: string): Promise<string> {
    const snapshot = this.readSnapshot();
    const lost = "Shell functions, aliases, unexported variables and background jobs are gone.";
    const started = await this.startShell().catch(() => false);
    if (!started || !this.child) {
      this.child = null;
      return `[Shell ${how}, and starting a new shell failed; the next command starts a fresh shell in ${this.cwd} without the previous cwd/env. ${tail}]`;
    }
    if (!snapshot) {
      return `[Shell ${how}, so it was restarted in ${this.cwd}; there was no saved state, so earlier cd/exported variables are gone. ${tail}]`;
    }
    const res = await this.send(this.child, buildRestoreScript(snapshot), SETUP_TIMEOUT_MS);
    if (res.kind !== "done") {
      this.hardKill(this.child);
      return `[Shell ${how}, and restoring its state failed; the next command starts a fresh shell in ${this.cwd} without the previous cwd/env. ${tail}]`;
    }
    const landed = res.output.trim().split("\n").pop() || this.cwd;
    const restored =
      snapshot.cwd && landed === snapshot.cwd
        ? `restored working directory ${landed} and exported environment variables`
        : `restored exported environment variables; the previous working directory ${snapshot.cwd ?? "(unknown)"} no longer exists, so it is ${landed}`;
    return `[Shell ${how}, so it was restarted; ${restored}. ${lost} ${tail}]`;
  }

  /**
   * The shell's own pid, if it is a real descendant of the spawned process
   * (inside a Linux sandbox's pid namespace `$$` is not a host pid). Never on
   * Windows, where MSYS pids are not native pids.
   */
  private verifiedShellPid(child: ChildProcess): number | null {
    const pid = this.shellPid;
    if (process.platform === "win32" || !pid || !child.pid) return null;
    if (pid === child.pid) return pid;
    return listDescendantPids(child.pid).includes(pid) ? pid : null;
  }

  private hardKill(child: ChildProcess): void {
    if (child.pid) killProcessTree(child.pid);
    if (this.child === child) {
      this.child = null;
      this.shellPid = null;
    }
  }

  /**
   * Write one script and wait for its sentinel. `run()` passes a signal and
   * gets the stop-the-command-not-the-shell interrupt; setup scripts don't.
   */
  private send(
    child: ChildProcess,
    script: string,
    timeoutMs: number,
    signal?: AbortSignal,
    onChunk?: (text: string) => void,
  ): Promise<RawResult> {
    const sentinel = `__GG_PSH_${randomUUID()}__`;
    const statePath = this.statePath;
    // Snapshot cwd + exported env before the sentinel, so a shell that dies
    // in the next command can be restored to exactly this point. Builtins and
    // one redirect only — no fork. On Windows Git Bash accepts `C:/…` paths.
    const snapshot = statePath
      ? `{ builtin pwd -P; builtin export -p; } >${shellQuote(statePath.replace(/\\/g, "/"))} 2>/dev/null; `
      : "";
    // The one-iteration loop is what the USR1 trap breaks out of, skipping the
    // rest of an interrupted command list. `</dev/null` keeps stdin-reading
    // commands (cat, read) from eating the next sentinel line.
    const wrapped =
      `for __gg_psh_once in 1; do { ${script}\n} </dev/null; done; ` +
      `__gg_psh_rc=$?; ${snapshot}builtin echo "${sentinel}$__gg_psh_rc"\n`;

    return new Promise<RawResult>((resolve) => {
      let out = "";
      let capped = false;
      let done = false;
      let interrupted: "timeout" | "abort" | null = null;
      let sweep: ReturnType<typeof setInterval> | undefined;
      let grace: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: RawResult): void => {
        if (done) return;
        done = true;
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        child.off("exit", onExit);
        child.off("error", onError);
        clearTimeout(timer);
        clearInterval(sweep);
        clearTimeout(grace);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };

      const capNote = (): string => `\n[Output capped at ${this.maxOutputBytes} bytes]`;

      // When output is capped we stop growing `out` but MUST keep scanning for
      // the sentinel — otherwise an over-cap command hangs until timeout and
      // needlessly destroys the session. `scanTail` keeps a small rolling
      // window across chunk boundaries so a split sentinel is still found.
      let scanTail = "";
      const checkSentinel = (scan: string, fromCapped: boolean): void => {
        const idx = scan.indexOf(sentinel);
        if (idx === -1) return;
        const code = parseInt(scan.slice(idx + sentinel.length), 10);
        const body = (fromCapped ? out : scan.slice(0, idx)).replace(/\n$/, "");
        const output = body + (fromCapped ? capNote() : "");
        if (interrupted) {
          finish({ kind: interrupted, shellKept: true, output });
          return;
        }
        finish({ kind: "done", code: Number.isNaN(code) ? 1 : code, output });
      };

      const onData = (d: Buffer): void => {
        const text = d.toString("utf-8");
        if (capped) {
          scanTail = (scanTail + text).slice(-(sentinel.length + 16));
          checkSentinel(scanTail, true);
          return;
        }
        out += text;
        if (out.length > this.maxOutputBytes) {
          capped = true;
          scanTail = out.slice(-(sentinel.length + 16));
          // Surrogate-safe cut: splitting an emoji here strands a lone surrogate
          // that later makes the provider request body invalid JSON.
          out = sliceHead(out, this.maxOutputBytes);
        }
        onChunk?.(text);
        checkSentinel(capped ? scanTail : out, capped);
      };

      const giveUp = (kind: "timeout" | "abort", stuck = false): void => {
        this.hardKill(child);
        finish({ kind, shellKept: false, stuck, output: out + (capped ? capNote() : "") });
      };

      const interrupt = (kind: "timeout" | "abort"): void => {
        if (done || interrupted) return;
        interrupted = kind;
        if (!signal) {
          // Setup scripts: nothing worth preserving yet.
          giveUp(kind);
          return;
        }
        const pid = this.verifiedShellPid(child);
        if (pid === null) {
          giveUp(kind);
          return;
        }
        // Order matters: the trap is deferred until the foreground child dies,
        // so it must be pending before the children are killed.
        try {
          process.kill(pid, "SIGUSR1");
        } catch {
          giveUp(kind);
          return;
        }
        signalDescendants(pid, "SIGTERM");
        // Anything that ignored SIGTERM, or was forked since, gets SIGKILL.
        sweep = setInterval(() => signalDescendants(pid, "SIGKILL"), INTERRUPT_SWEEP_MS);
        grace = setTimeout(() => giveUp(kind, true), INTERRUPT_GRACE_MS);
      };

      const timer = setTimeout(() => interrupt("timeout"), timeoutMs);
      const onAbort = (): void => interrupt("abort");
      signal?.addEventListener("abort", onAbort, { once: true });

      // `exit N` (or a crash) ends the session shell itself — the sentinel
      // never prints, so settle from the shell's own exit status.
      const onExit = (code: number | null, sig: NodeJS.Signals | null): void => {
        if (this.child === child) {
          this.child = null;
          this.shellPid = null;
        }
        const output = out.replace(/\n$/, "") + (capped ? capNote() : "");
        if (interrupted) finish({ kind: interrupted, shellKept: false, output });
        else finish({ kind: "exited", code, signal: sig, output });
      };
      child.on("exit", onExit);

      const onError = (): void => finish({ kind: "error", output: "failed to spawn session bash" });
      child.on("error", onError);

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.stdin?.write(wrapped);
    });
  }

  /**
   * Run one command in the session shell. Serialized by the tool's sequential
   * execution mode; a concurrent call while busy is rejected defensively.
   */
  async run(
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
    onChunk?: (text: string) => void,
  ): Promise<PersistentRunResult> {
    if (this.busy) {
      return { exitCode: 1, output: "persistent shell is busy with a previous command" };
    }
    this.busy = true;
    try {
      const notes = this.pendingNotes;
      const current = this.child;
      if (current && (current.exitCode !== null || current.signalCode !== null)) {
        // Died between commands (external kill, OOM). Nothing has been sent,
        // so restarting here cannot double-execute anything.
        this.child = null;
        notes.push(
          await this.restart(
            `had ${describeExit(current.exitCode, current.signalCode)} since the last command`,
            "This command ran in the new shell.",
          ),
        );
      }
      if (!this.child && !(await this.startShell().catch(() => false))) {
        this.child = null;
      }
      const child = this.child;
      if (!child) return { exitCode: 1, output: "failed to spawn session bash" };
      const generation = this.generation;
      const res = await this.send(child, command, timeoutMs, signal, onChunk);
      if (generation !== this.generation) {
        return { exitCode: res.kind === "done" ? res.code : 1, output: res.output };
      }

      switch (res.kind) {
        case "done":
          return { exitCode: res.code, output: res.output };
        case "error":
          this.hardKill(child);
          return { exitCode: 1, output: res.output };
        case "exited": {
          notes.push(
            await this.restart(describeExit(res.code, res.signal), "The command was not re-run."),
          );
          // A signal death has no code; report it the way bash would (128+n).
          const code = res.code ?? (res.signal ? 128 + (os.constants.signals[res.signal] ?? 0) : 1);
          return { exitCode: code, output: res.output };
        }
        case "timeout":
        case "abort": {
          const exitCode = res.kind === "timeout" ? ("TIMEOUT" as const) : 1;
          if (res.shellKept) {
            return { exitCode, output: res.output, shellKept: true };
          }
          const event = res.kind === "timeout" ? "timed out" : "was aborted";
          const how = res.stuck
            ? `did not stop when the command ${event}, so it was killed`
            : `was killed to stop the command that ${event}`;
          notes.push(await this.restart(how, "The command was not re-run."));
          return { exitCode, output: res.output, shellKept: false };
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** Kill the session shell and drop its saved state; the next run() starts fresh. */
  kill(): void {
    this.generation++;
    if (this.child) this.hardKill(this.child);
    this.child = null;
    this.shellPid = null;
    this.busy = false;
    this.pendingNotes = [];
    if (this.stateDir) {
      rmSync(this.stateDir, { recursive: true, force: true });
      stateDirs.delete(this.stateDir);
      this.stateDir = null;
    }
  }
}
