import type { ChildProcess } from "node:child_process";
import { hermesProxyHealth, startHermesProxy, type HermesRunOptions } from "@kenkaiiii/gg-core";
import { killProcessTree } from "../utils/process.js";
import { log } from "./logger.js";

/** A run shorter than this counts as a failed start for the restart backoff. */
const STABLE_RUN_MS = 60_000;
const MAX_QUICK_FAILURES = 5;

export interface HermesProxySupervisorOptions extends HermesRunOptions {
  /** Whether Nous Portal is still connected; a restart is skipped once it isn't. */
  isConnected: () => Promise<boolean>;
  start?: typeof startHermesProxy;
  health?: typeof hermesProxyHealth;
}

/**
 * Keeps Hermes's subscription proxy up while Nous Portal is connected. A proxy
 * the user already runs is used as is; otherwise this starts one as a child of
 * the host, restarts it if it dies, and stops it with the host.
 */
export class HermesProxySupervisor {
  private child: ChildProcess | undefined;
  private starting: Promise<void> | undefined;
  private stopped = false;
  private quickFailures = 0;
  private restartTimer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: HermesProxySupervisorOptions) {}

  /** Resolves once a Nous Portal proxy answers, starting one when none does. */
  ensure(): Promise<void> {
    this.stopped = false;
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** Stop the proxy this host started. A proxy the user runs is left alone. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    this.child = undefined;
    if (child?.pid !== undefined && child.exitCode === null) killProcessTree(child.pid);
  }

  private async start(): Promise<void> {
    if ((await (this.opts.health ?? hermesProxyHealth)())?.nous) return;
    const child = await (this.opts.start ?? startHermesProxy)(this.opts);
    if (this.stopped) {
      if (child.pid !== undefined) killProcessTree(child.pid);
      return;
    }
    this.child = child;
    const startedAt = Date.now();
    log("INFO", "hermes", "Started the Hermes proxy for Nous Portal", { pid: String(child.pid) });
    child.once("exit", (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.stopped) return;
      this.quickFailures = Date.now() - startedAt < STABLE_RUN_MS ? this.quickFailures + 1 : 0;
      this.scheduleRestart(code);
    });
  }

  private scheduleRestart(code: number | null): void {
    if (this.quickFailures > MAX_QUICK_FAILURES) {
      log("WARN", "hermes", "The Hermes proxy keeps stopping; not restarting it again", {
        code: String(code),
      });
      return;
    }
    const delay = Math.min(30_000, 1_000 * 2 ** this.quickFailures);
    log("WARN", "hermes", `The Hermes proxy stopped (exit ${code}); restarting in ${delay}ms`);
    this.restartTimer = setTimeout(() => {
      void this.opts
        .isConnected()
        .then((connected) => (connected && !this.stopped ? this.ensure() : undefined))
        .catch((err: unknown) =>
          log("WARN", "hermes", "Hermes proxy restart failed", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    }, delay);
    this.restartTimer.unref?.();
  }
}
