import { randomUUID } from "node:crypto";

export type SessionMutationKind =
  | "new-session"
  | "task-run"
  | "phase-start"
  | "prompt-start"
  | "manual-plan-accept"
  | "autopilot-plan-accept";

export interface SessionMutationOwner {
  operationId: string;
  kind: SessionMutationKind;
}

export interface SessionMutationLease extends SessionMutationOwner {
  release(): void;
}

export interface SessionMutationConflictBody {
  error: "session_mutation_in_progress";
  owner: SessionMutationOwner;
}

export interface AppSidecarSessionBusyState {
  running: boolean;
  autopilotActive: boolean;
  runLifecycleRunning: boolean;
}

export interface AppSidecarSessionBusyConflictBody {
  error: "session_busy";
  message: string;
  state: AppSidecarSessionBusyState;
}

/** Authoritative gate for reset-style routes that require an idle logical session. */
export function isAppSidecarSessionBusy(state: AppSidecarSessionBusyState): boolean {
  return state.running || state.autopilotActive || state.runLifecycleRunning;
}

export function appSidecarSessionBusyConflictBody(
  state: AppSidecarSessionBusyState,
): AppSidecarSessionBusyConflictBody {
  return {
    error: "session_busy",
    message: "Cannot start a new session while the current session is active.",
    state,
  };
}

/**
 * Fail-fast lifecycle gate owned by one logical sidecar session.
 *
 * Session transitions and prompt acceptance must never queue behind each other:
 * a delayed reset could silently retarget a prompt after its caller has moved on.
 * The current owner completes atomically; competitors receive a typed 409.
 */
export class AppSidecarSessionMutationCoordinator {
  #owner: SessionMutationOwner | null = null;
  readonly #createOperationId: () => string;

  constructor(createOperationId: () => string = randomUUID) {
    this.#createOperationId = createOperationId;
  }

  get owner(): SessionMutationOwner | null {
    return this.#owner ? { ...this.#owner } : null;
  }

  tryAcquire(kind: SessionMutationKind): SessionMutationLease | null {
    if (this.#owner) return null;

    const owner = { operationId: this.#createOperationId(), kind } satisfies SessionMutationOwner;
    this.#owner = owner;
    let released = false;
    return {
      ...owner,
      release: () => {
        if (released) return;
        released = true;
        if (this.#owner?.operationId === owner.operationId) this.#owner = null;
      },
    };
  }

  conflictBody(): SessionMutationConflictBody {
    const owner = this.#owner;
    if (!owner) throw new Error("session mutation conflict requested without an owner");
    return { error: "session_mutation_in_progress", owner: { ...owner } };
  }
}
