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
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { killProcessTree } from "../utils/process.js";

export interface PersistentRunResult {
  exitCode: number | "TIMEOUT";
  output: string;
}

export class PersistentShell {
  private child: ChildProcess | null = null;
  private buffer = "";
  private busy = false;

  constructor(
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly maxOutputBytes: number,
  ) {}

  /** True while a previous persistent command is still running. */
  get isBusy(): boolean {
    return this.busy;
  }

  private ensureChild(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return this.child;
    }
    // Fresh session: no rc files so startup is fast and deterministic.
    const child = spawn("bash", ["--norc", "--noprofile"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
      detached: true,
    });
    // Don't let a lingering session shell keep the parent process alive.
    child.unref();
    this.child = child;
    this.buffer = "";
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
    onChunk?: (text: string) => void,
  ): Promise<PersistentRunResult> {
    if (this.busy) {
      return Promise.resolve({
        exitCode: 1,
        output: "persistent shell is busy with a previous command",
      });
    }
    this.busy = true;
    const child = this.ensureChild();
    const sentinel = `__GG_PSH_${randomUUID()}__`;
    // `</dev/null` keeps stdin-reading commands (cat, read) from eating the
    // next sentinel line instead of hanging the session.
    const wrapped = `{ ${command}\n} </dev/null; echo "${sentinel}$?"\n`;

    return new Promise<PersistentRunResult>((resolve) => {
      let out = "";
      let capped = false;
      let done = false;

      const finish = (result: PersistentRunResult): void => {
        if (done) return;
        done = true;
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        child.off("exit", onExit);
        child.off("error", onError);
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.busy = false;
        resolve(result);
      };

      // When output is capped we stop growing `out` but MUST keep scanning for
      // the sentinel — otherwise an over-cap command hangs until timeout and
      // needlessly destroys the session. `scanTail` keeps a small rolling
      // window across chunk boundaries so a split sentinel is still found.
      let scanTail = "";
      const checkSentinel = (scan: string, fromCapped: boolean): void => {
        const idx = scan.indexOf(sentinel);
        if (idx === -1) return;
        const code = parseInt(scan.slice(idx + sentinel.length), 10);
        const body = fromCapped ? out : scan.slice(0, idx);
        finish({
          exitCode: Number.isNaN(code) ? 1 : code,
          output:
            body.replace(/\n$/, "") +
            (fromCapped ? `\n[Output capped at ${this.maxOutputBytes} bytes]` : ""),
        });
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
          out = out.slice(0, this.maxOutputBytes);
        }
        onChunk?.(text);
        checkSentinel(capped ? scanTail : out, capped);
      };

      const timer = setTimeout(() => {
        this.kill();
        finish({ exitCode: "TIMEOUT", output: out });
      }, timeoutMs);

      const onAbort = (): void => {
        this.kill();
        finish({ exitCode: 1, output: out });
      };
      signal.addEventListener("abort", onAbort, { once: true });

      // `exit N` (or a crash) ends the session shell itself — the sentinel
      // never prints, so settle from the shell's own exit code. The next run()
      // starts a fresh session.
      const onExit = (code: number | null): void => {
        this.child = null;
        finish({ exitCode: code ?? 1, output: out.replace(/\n$/, "") });
      };
      child.on("exit", onExit);

      const onError = (): void => finish({ exitCode: 1, output: "failed to spawn session bash" });
      child.on("error", onError);

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.stdin?.write(wrapped);
    });
  }

  /** Kill the session shell; the next run() starts a fresh one. */
  kill(): void {
    if (this.child?.pid) killProcessTree(this.child.pid);
    this.child = null;
    this.busy = false;
  }
}
