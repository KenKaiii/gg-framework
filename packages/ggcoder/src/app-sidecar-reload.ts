export interface ReloadableSession {
  isRunning(): boolean;
}

export type ReloadDecision = { ok: true } | { ok: false; reason: "active-runs" | "not-prepared" };

/**
 * Coordinates a secret-free daemon reload handshake.
 * Preparation reserves the daemon while Rust persists validated native config,
 * preventing a new run from racing between the idle check and process reload.
 */
export class AppSidecarReloadCoordinator {
  #prepared = false;
  #reloading = false;
  #inFlightMutations = 0;

  prepare(sessions: Iterable<ReloadableSession>): ReloadDecision {
    if (this.#inFlightMutations > 0 || hasActiveRun(sessions)) {
      return { ok: false, reason: "active-runs" };
    }
    this.#prepared = true;
    return { ok: true };
  }

  cancel(): void {
    this.#prepared = false;
  }

  begin(sessions: Iterable<ReloadableSession>): ReloadDecision {
    if (!this.#prepared) {
      if (this.#inFlightMutations > 0 || hasActiveRun(sessions)) {
        return { ok: false, reason: "active-runs" };
      }
      return { ok: false, reason: "not-prepared" };
    }
    this.#prepared = false;
    this.#reloading = true;
    return { ok: true };
  }

  shouldBlockSessionMutation(method: string): boolean {
    return (this.#prepared || this.#reloading) && method !== "GET" && method !== "OPTIONS";
  }

  /**
   * Atomically passes the reload gate and leases one request-level mutation.
   * The response lifecycle owns this lease. Early-response handlers must also
   * acquire an operation lease for work that continues after the response.
   */
  tryAcquireSessionMutation(method: string): (() => void) | null {
    if (method === "GET" || method === "OPTIONS") return () => {};
    return this.#tryAcquireMutation();
  }

  /**
   * Leases accepted work that can outlive its HTTP response. Acquire this before
   * ending the response and release it in finally after the continuation settles.
   */
  tryAcquireOperationMutation(): (() => void) | null {
    return this.#tryAcquireMutation();
  }

  #tryAcquireMutation(): (() => void) | null {
    if (this.#prepared || this.#reloading) return null;

    this.#inFlightMutations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inFlightMutations -= 1;
    };
  }
}

function hasActiveRun(sessions: Iterable<ReloadableSession>): boolean {
  for (const session of sessions) {
    if (session.isRunning()) return true;
  }
  return false;
}
