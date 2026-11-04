/**
 * Keep the computer from idle-sleeping while the agent works.
 *
 * Autopilot cycles, task sweeps and long runs die halfway when a laptop idles
 * into system sleep. This holds an OS power assertion for as long as any agent
 * work is in flight. Only idle SYSTEM sleep is prevented — the display may
 * still turn off, and an explicit sleep (lid close, menu) still wins.
 *
 * No native dependencies: each platform's own tool holds the assertion in a
 * child process, and the assertion dies with that child.
 *
 * - macOS: `caffeinate -i -w <pid>` — exits by itself when our process dies.
 * - Linux: `systemd-inhibit --what=idle:sleep … tail --pid=<pid> -f /dev/null`
 *   — the inhibitor lock lives as long as `tail`, which exits when our process
 *   dies. Spawned as its own process group so release kills both. No
 *   systemd-inhibit (non-systemd distro) → logged no-op.
 * - Windows: a hidden PowerShell that P/Invokes `SetThreadExecutionState(
 *   ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` and then `Wait-Process`es our PID.
 *   The execution state is per-thread, so it is cleared when that process ends.
 *
 * Reference-counted: overlapping runs (several windows, a run plus a Ken reply,
 * background sub-agents) share one OS assertion, which is dropped when the last
 * holder releases.
 */

import { spawn } from "node:child_process";
import { log } from "./logger.js";

/** A platform tool invocation, always an argv array — never a shell string. */
export interface KeepAwakeCommand {
  command: string;
  args: string[];
}

/** The spawned assertion holder, abstracted so tests can inject a fake. */
export interface KeepAwakeProcess {
  /** Terminate the holder (and its children). Must be safe to call twice. */
  stop(): void;
  /** Called once when the holder exits for any reason. */
  onExit(listener: () => void): void;
  /** Called when the holder fails to spawn (e.g. ENOENT: tool missing). */
  onError(listener: (error: NodeJS.ErrnoException) => void): void;
}

export type KeepAwakeSpawner = (command: KeepAwakeCommand) => KeepAwakeProcess;

type KeepAwakeLog = (
  level: "INFO" | "WARN",
  message: string,
  data?: Record<string, unknown>,
) => void;

export interface KeepAwakeOptions {
  platform?: NodeJS.Platform;
  /** The process the assertion is tied to. Defaults to `process.pid`. */
  pid?: number;
  /** Initial state of the `keepAwake` setting. Defaults to true. */
  enabled?: boolean;
  spawner?: KeepAwakeSpawner;
  log?: KeepAwakeLog;
  /** Registers a synchronous last-chance cleanup. Defaults to `process.once("exit")`. */
  onProcessExit?: (cleanup: () => void) => void;
}

/** ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001). */
const WINDOWS_EXECUTION_STATE = 2147483649;

const LINUX_WHY = "Agent is working";

function windowsScript(pid: number): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$k = Add-Type -Name KeepAwake -Namespace Kleio -PassThru -MemberDefinition " +
      "'[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    `if ($k::SetThreadExecutionState([uint32]${WINDOWS_EXECUTION_STATE}) -eq 0) { exit 1 }`,
    // Blocks this (assertion-holding) thread until our process exits; release
    // terminates PowerShell first, which clears the execution state.
    `Wait-Process -Id ${pid} -ErrorAction SilentlyContinue`,
  ].join("\n");
}

/** The OS tool that holds an idle-sleep assertion tied to `pid`, or null if none. */
export function keepAwakeCommand(platform: NodeJS.Platform, pid: number): KeepAwakeCommand | null {
  switch (platform) {
    case "darwin":
      return { command: "caffeinate", args: ["-i", "-w", String(pid)] };
    case "linux":
      return {
        command: "systemd-inhibit",
        args: [
          "--what=idle:sleep",
          "--who=Kleio",
          `--why=${LINUX_WHY}`,
          "--mode=block",
          "tail",
          `--pid=${pid}`,
          "-f",
          "/dev/null",
        ],
      };
    case "win32":
      return {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-WindowStyle",
          "Hidden",
          "-EncodedCommand",
          Buffer.from(windowsScript(pid), "utf16le").toString("base64"),
        ],
      };
    default:
      return null;
  }
}

/** Real spawner: argv array, no shell, hidden window, stdio ignored. */
export function spawnKeepAwakeProcess(cmd: KeepAwakeCommand): KeepAwakeProcess {
  // Linux gets its own process group so release can kill systemd-inhibit AND
  // the `tail` it runs; macOS/Windows holders have no children of their own.
  const group = process.platform === "linux";
  const child = spawn(cmd.command, cmd.args, {
    stdio: "ignore",
    windowsHide: true,
    shell: false,
    detached: group,
  });
  // The holder must never keep the sidecar's event loop alive.
  child.unref();
  return {
    stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (group && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
          return;
        } catch {
          // Fall through to the single-process kill.
        }
      }
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    },
    onExit(listener) {
      child.once("exit", () => listener());
    },
    onError(listener) {
      child.once("error", (error) => listener(error));
    },
  };
}

/** Reference-counted holder of one OS idle-sleep assertion. */
export class KeepAwake {
  private readonly holds = new Map<number, string>();
  private nextId = 0;
  private enabled: boolean;
  private child: KeepAwakeProcess | null = null;
  /** The platform tool is missing — permanently a no-op for this process. */
  private unavailable = false;
  /** The holder died on its own; don't respawn until holders drop to zero. */
  private suspended = false;
  private exitHookInstalled = false;
  private readonly platform: NodeJS.Platform;
  private readonly pid: number;
  private readonly spawner: KeepAwakeSpawner;
  private readonly logLine: KeepAwakeLog;
  private readonly onProcessExit: (cleanup: () => void) => void;

  constructor(options: KeepAwakeOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.pid = options.pid ?? process.pid;
    this.enabled = options.enabled ?? true;
    this.spawner = options.spawner ?? spawnKeepAwakeProcess;
    this.logLine =
      options.log ?? ((level, message, data) => log(level, "keep-awake", message, data));
    this.onProcessExit = options.onProcessExit ?? ((cleanup) => process.once("exit", cleanup));
  }

  /** Hold the assertion until the returned release runs. Release is idempotent. */
  acquire(reason: string): () => void {
    const id = ++this.nextId;
    this.holds.set(id, reason);
    this.sync();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds.delete(id);
      this.sync();
    };
  }

  /** Apply the `keepAwake` setting live; outstanding holds survive a toggle. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.suspended = false;
    this.sync();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get holderCount(): number {
    return this.holds.size;
  }

  /** True while an OS assertion holder process is running. */
  get asserting(): boolean {
    return this.child !== null;
  }

  /** Drop every hold and the OS assertion (shutdown). */
  dispose(): void {
    this.holds.clear();
    this.suspended = false;
    this.stopChild();
  }

  private sync(): void {
    if (this.holds.size === 0) this.suspended = false;
    const want = this.enabled && this.holds.size > 0 && !this.unavailable && !this.suspended;
    if (want && !this.child) this.startChild();
    else if (!want && this.child) this.stopChild();
  }

  private startChild(): void {
    const cmd = keepAwakeCommand(this.platform, this.pid);
    if (!cmd) {
      this.unavailable = true;
      this.logLine("INFO", "keep-awake unsupported on this platform; skipping", {
        platform: this.platform,
      });
      return;
    }
    let child: KeepAwakeProcess;
    try {
      child = this.spawner(cmd);
    } catch (error) {
      this.markUnavailable(cmd, error);
      return;
    }
    this.child = child;
    if (!this.exitHookInstalled) {
      this.exitHookInstalled = true;
      this.onProcessExit(() => this.dispose());
    }
    child.onError((error) => {
      if (this.child !== child) return;
      this.child = null;
      this.markUnavailable(cmd, error);
    });
    child.onExit(() => {
      // A holder we stopped, or a superseded one, is expected to exit.
      if (this.child !== child) return;
      this.child = null;
      this.suspended = true;
      this.logLine("WARN", "keep-awake holder exited unexpectedly", { command: cmd.command });
    });
    this.logLine("INFO", "keep-awake on", {
      command: cmd.command,
      reasons: [...new Set(this.holds.values())].join(","),
    });
  }

  private stopChild(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.stop();
    this.logLine("INFO", "keep-awake off");
  }

  private markUnavailable(cmd: KeepAwakeCommand, error: unknown): void {
    this.unavailable = true;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    this.logLine(
      "INFO",
      code === "ENOENT"
        ? "keep-awake tool not found; skipping"
        : "keep-awake tool failed to start; skipping",
      {
        command: cmd.command,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}
