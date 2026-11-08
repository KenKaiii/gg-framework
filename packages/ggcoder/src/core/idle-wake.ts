/**
 * Wake an idle session when its own background work needs attention.
 *
 * Background alerts — a build or CI watcher that failed, a task that exited
 * non-zero, a child agent that finished — ride the steering path, which only
 * exists while a run is live. Once the agent has ended its turn, an alert sat
 * in the queue until the user happened to send another message (measured: 8 of
 * 483 runs began with a status update that had been waiting for exactly that).
 *
 * This starts a run for the alert instead, inside hard limits:
 *
 * - Never while anything else could deliver it: a live run, a run being
 *   claimed, an autopilot cycle. The alert waits for that run's next steering
 *   boundary instead, and is retried here if the run ends without draining it.
 * - Never while the user is deciding something (a plan awaiting review).
 * - Never after the user pressed Stop, until they send another message. Stop
 *   means "stop acting on your own", and a background exit is not a reason to
 *   override it.
 * - At most {@link DEFAULT_MAX_WAKES_PER_PROMPT} wakes per user message, so a
 *   flapping task cannot keep the agent (and the bill) running unattended.
 *
 * Pure policy over injected callbacks; the host owns the run itself.
 */

/** Batch alerts that land together (a failure line, then the exit) into one run. */
export const DEFAULT_IDLE_WAKE_DEBOUNCE_MS = 2_000;
/** Unattended wakes allowed per human prompt. */
export const DEFAULT_MAX_WAKES_PER_PROMPT = 2;

export type IdleWakeSkip = "stopped" | "budget" | "blocked" | "nothing-pending";

export interface IdleWakeDeps {
  /** A run, a run claim, or an autopilot cycle is live and will deliver it. */
  isBusy: () => boolean;
  /** The user is deciding something (a plan awaiting review). */
  isBlocked: () => boolean;
  /** An urgent alert is still waiting to be delivered. */
  hasPendingAlert: () => boolean;
  /** Monotonic count of human prompts; budgets and Stop reset when it moves. */
  humanPromptSeq: () => number;
  /** Start the wake run; resolves when it has settled. */
  start: () => Promise<void>;
  /** Observability hook for skipped wakes. */
  onSkip?: (reason: IdleWakeSkip) => void;
  debounceMs?: number;
  maxWakesPerPrompt?: number;
}

export class IdleWakeController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private budgetSeq = -1;
  private wakesUsed = 0;
  private stoppedAtSeq: number | null = null;
  private starting = false;
  private disposed = false;

  constructor(private readonly deps: IdleWakeDeps) {}

  /** An urgent alert was queued. Debounced; safe to call often. */
  trigger(): void {
    if (this.disposed || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire();
    }, this.deps.debounceMs ?? DEFAULT_IDLE_WAKE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** The user pressed Stop: no unattended wakes until their next message. */
  noteStop(): void {
    this.stoppedAtSeq = this.deps.humanPromptSeq();
    this.cancelTimer();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async fire(): Promise<void> {
    if (this.disposed || this.starting) return;
    if (!this.deps.hasPendingAlert()) return this.skip("nothing-pending");
    const seq = this.deps.humanPromptSeq();
    if (this.stoppedAtSeq === seq) return this.skip("stopped");
    if (seq !== this.budgetSeq) {
      this.budgetSeq = seq;
      this.wakesUsed = 0;
    }
    if (this.wakesUsed >= (this.deps.maxWakesPerPrompt ?? DEFAULT_MAX_WAKES_PER_PROMPT)) {
      return this.skip("budget");
    }
    if (this.deps.isBusy()) {
      // The live run should drain it at its next steering boundary. If that
      // run is already past its last boundary, the alert would strand — so
      // look again shortly rather than trusting the run to have taken it.
      this.trigger();
      return;
    }
    if (this.deps.isBlocked()) return this.skip("blocked");
    this.wakesUsed += 1;
    this.starting = true;
    try {
      await this.deps.start();
    } finally {
      this.starting = false;
    }
    // An alert that landed after the wake run's last steering boundary.
    if (this.deps.hasPendingAlert()) this.trigger();
  }

  private skip(reason: IdleWakeSkip): void {
    this.deps.onSkip?.(reason);
  }
}
