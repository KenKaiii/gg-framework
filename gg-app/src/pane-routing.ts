export const PRIMARY_PANE_ID = "primary";

/** Rust's trusted agent event envelope. Older sidecars emitted an untagged event. */
export interface PaneEventEnvelope<T = unknown> {
  paneId?: string;
  sessionId?: string;
  type: string;
  data: T;
}

export interface PaneRouteTarget {
  paneId: string;
  /** The currently bound daemon session. Events from replaced sessions are stale. */
  sessionId?: string | null;
}

/**
 * Return the pane that may consume an event, or null when it is malformed/stale.
 * Tagged traffic is matched exactly. Untagged legacy traffic is deliberately
 * restricted to the primary pane so it can never leak into additional panes.
 */
export function routePaneEvent<T>(
  event: PaneEventEnvelope<T>,
  panes: readonly PaneRouteTarget[],
): PaneRouteTarget | null {
  if (event.paneId == null) {
    return panes.find((pane) => pane.paneId === PRIMARY_PANE_ID) ?? null;
  }

  if (typeof event.paneId !== "string" || typeof event.sessionId !== "string") return null;
  const pane = panes.find((candidate) => candidate.paneId === event.paneId);
  if (!pane) return null;
  // An omitted token is the explicit compatibility mode used by the primary
  // wrapper. Pane clients pass a concrete token; null means not ready yet.
  if (pane.sessionId === undefined) return pane;
  if (pane.sessionId === null || pane.sessionId !== event.sessionId) return null;
  return pane;
}

/** Convenient fan-out that still invokes at most one exact pane handler. */
export function dispatchPaneEvent<T>(
  event: PaneEventEnvelope<T>,
  panes: readonly PaneRouteTarget[],
  dispatch: (pane: PaneRouteTarget, event: PaneEventEnvelope<T>) => void,
): boolean {
  const pane = routePaneEvent(event, panes);
  if (!pane) return false;
  dispatch(pane, event);
  return true;
}
