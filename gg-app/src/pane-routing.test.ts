import { describe, expect, it, vi } from "vitest";
import { dispatchPaneEvent, routePaneEvent, type PaneRouteTarget } from "./pane-routing";

const panes: PaneRouteTarget[] = Array.from({ length: 12 }, (_, index) => ({
  paneId: index === 0 ? "primary" : `pane-${index}`,
  sessionId: `session-${index}`,
}));

describe("pane routing", () => {
  it("routes twelve interleaved pane streams exactly once to their pane", () => {
    const received = new Map<string, number[]>();
    const dispatch = vi.fn((pane: PaneRouteTarget, event: { data: number }) => {
      const values = received.get(pane.paneId) ?? [];
      values.push(event.data);
      received.set(pane.paneId, values);
    });

    for (let turn = 0; turn < 4; turn++) {
      for (const [index, pane] of [...panes].reverse().entries()) {
        dispatchPaneEvent(
          {
            paneId: pane.paneId,
            sessionId: pane.sessionId!,
            type: "delta",
            data: turn * 12 + index,
          },
          panes,
          dispatch,
        );
      }
    }

    expect(dispatch).toHaveBeenCalledTimes(48);
    expect(received.size).toBe(12);
    for (const pane of panes) expect(received.get(pane.paneId)).toHaveLength(4);
  });

  it("rejects events from a stale active session", () => {
    expect(
      routePaneEvent(
        { paneId: "pane-3", sessionId: "replaced-session", type: "delta", data: null },
        panes,
      ),
    ).toBeNull();
  });

  it("does not use prefix or partial pane matches", () => {
    expect(
      routePaneEvent(
        { paneId: "pane-1-extra", sessionId: "session-1", type: "x", data: null },
        panes,
      ),
    ).toBeNull();
  });

  it("routes untagged legacy events only to primary", () => {
    expect(routePaneEvent({ type: "legacy", data: null }, panes)?.paneId).toBe("primary");
    expect(routePaneEvent({ type: "legacy", data: null }, panes.slice(1))).toBeNull();
  });

  it("allows tagged primary compatibility only when no active token is supplied", () => {
    const tagged = { paneId: "primary", sessionId: "current", type: "delta", data: null };
    expect(routePaneEvent(tagged, [{ paneId: "primary" }])?.paneId).toBe("primary");
    expect(routePaneEvent(tagged, [{ paneId: "primary", sessionId: null }])).toBeNull();
    expect(routePaneEvent(tagged, [{ paneId: "primary", sessionId: "stale" }])).toBeNull();
  });
});
