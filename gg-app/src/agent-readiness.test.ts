// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const unlisten = vi.fn();
  const listen = vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    listeners.set(name, callback);
    return unlisten;
  });
  return { listeners, unlisten, listen, invoke: vi.fn() };
});
const { listeners, unlisten, listen, invoke } = mocks;

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main", setTitle: vi.fn(), listen: mocks.listen }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));

import { waitForPaneReady } from "./agent";

const pending = { ready: false, error: null, generation: 2, sessionId: null };
const ready = { ready: true, error: null, generation: 2, sessionId: "session-2" };

beforeEach(() => {
  vi.useFakeTimers();
  listeners.clear();
  listen.mockClear();
  unlisten.mockClear();
  invoke.mockReset();
});

describe("pane readiness", () => {
  it("installs all listeners before its first status read and cleans up", async () => {
    invoke.mockResolvedValue(ready);
    const promise = waitForPaneReady("pane-2");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(listen.mock.calls.map(([name]) => name)).toEqual([
      "agent-pane-ready",
      "agent-pane-error",
      "sidecar-error",
    ]);
    await expect(promise).resolves.toEqual(ready);
    expect(unlisten).toHaveBeenCalledTimes(3);
  });

  it("polls persistently to close a missed-event race", async () => {
    invoke.mockResolvedValueOnce(pending).mockResolvedValueOnce(ready);
    const promise = waitForPaneReady("pane-2");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toEqual(ready);
  });

  it("ignores another pane's error and rejects its own with pane context", async () => {
    invoke.mockResolvedValue(pending);
    const promise = waitForPaneReady("pane-2");
    await vi.waitFor(() => expect(listeners.has("agent-pane-error")).toBe(true));
    listeners.get("agent-pane-error")!({
      payload: { paneId: "pane-1", generation: 1, error: "wrong" },
    });
    listeners.get("agent-pane-error")!({
      payload: { paneId: "pane-2", generation: 2, error: "boom" },
    });
    await expect(promise).rejects.toThrow("pane 'pane-2' failed to start: boom");
    expect(unlisten).toHaveBeenCalledTimes(3);
  });

  it("treats sidecar failures as daemon-global", async () => {
    invoke.mockResolvedValue(pending);
    const promise = waitForPaneReady("pane-9");
    await vi.waitFor(() => expect(listeners.has("sidecar-error")).toBe(true));
    listeners.get("sidecar-error")!({ payload: "fatal startup" });
    await expect(promise).rejects.toThrow("agent daemon failed: fatal startup");
  });
});
