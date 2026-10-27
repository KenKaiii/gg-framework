// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { worldLive } from "./agent";
import { useWorldLive } from "./world-live";

vi.mock("./agent", () => ({ worldLive: vi.fn() }));

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(s: string): void {
    this.sent.push(s);
  }
  close(code = 1000): void {
    this.closed = code;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

let n = 0;
const ticket = () => ({
  status: 200,
  body: { world: "w1", ticket: `t${++n}`, url: "wss://gg-world.example/api/world/live/ws" },
});
const flush = () => act(async () => {});
const last = (): FakeSocket => {
  const s = FakeSocket.all[FakeSocket.all.length - 1];
  if (!s) throw new Error("no socket");
  return s;
};

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  n = 0;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.mocked(worldLive).mockImplementation(async () => ticket());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function setup(enabled: boolean, paused = false) {
  const post = vi.fn();
  const h = renderHook((p: { enabled: boolean; paused: boolean }) => useWorldLive({ ...p, post }), {
    initialProps: { enabled, paused },
  });
  return { post, ...h };
}

describe("useWorldLive", () => {
  it("opens only when enabled, with the ticket", async () => {
    const { rerender } = setup(false);
    await flush();
    expect(worldLive).not.toHaveBeenCalled();
    rerender({ enabled: true, paused: false });
    await flush();
    expect(last().url).toBe("wss://gg-world.example/api/world/live/ws?ticket=t1");
  });

  it("relays both ways, posts status, drops oversize and not-open sends", async () => {
    const { post, result } = setup(true);
    await flush();
    const ws = last();
    act(() => result.current.onGameMessage({ t: "live", m: { t: "ping" } }));
    expect(ws.sent).toEqual([]); // not open yet
    expect(post).toHaveBeenCalledWith({ t: "live-status", state: "connecting" });
    act(() => ws.open());
    act(() =>
      ws.onmessage?.({
        data: JSON.stringify({ t: "welcome", you: "a", world: "w1", players: [], count: 3 }),
      }),
    );
    expect(post).toHaveBeenCalledWith({ t: "live", m: expect.objectContaining({ t: "welcome" }) });
    expect(post).toHaveBeenLastCalledWith({
      t: "live-status",
      state: "online",
      world: "w1",
      count: 3,
    });
    expect(result.current.onGameMessage({ t: "live", m: { t: "ping" } })).toBe(true);
    expect(ws.sent).toEqual(['{"t":"ping"}']);
    result.current.onGameMessage({ t: "live", m: { t: "chat", text: "x".repeat(2100) } });
    expect(ws.sent).toHaveLength(1);
    expect(result.current.onGameMessage({ t: "other" })).toBe(false);
  });

  it("reconnects with a new ticket and backoff", async () => {
    setup(true);
    await flush();
    act(() => last().open());
    act(() => last().serverClose(1006));
    await act(async () => vi.advanceTimersByTimeAsync(1999));
    expect(worldLive).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(worldLive).toHaveBeenCalledTimes(2);
    expect(last().url).toMatch(/ticket=t2$/);
    act(() => last().serverClose(1006)); // never opened: next wait is 4 s
    await act(async () => vi.advanceTimersByTimeAsync(3999));
    expect(worldLive).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(worldLive).toHaveBeenCalledTimes(3);
  });

  it.each([
    [4000, "elsewhere"],
    [4001, "banned"],
    [4002, "kicked"],
    [4003, "consent"],
    [4004, "deleted"],
  ])("close %i is final for the session (reason %s)", async (code, reason) => {
    const { post, rerender } = setup(true);
    await flush();
    act(() => last().open());
    act(() => last().serverClose(code));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(worldLive).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenLastCalledWith({ t: "live-status", state: "off", reason });
    // Pausing and resuming doesn't bring it back either.
    rerender({ enabled: true, paused: true });
    await act(async () => vi.advanceTimersByTimeAsync(61_000));
    rerender({ enabled: true, paused: false });
    await flush();
    expect(worldLive).toHaveBeenCalledTimes(1);
  });

  it("marks retries, and gives up as offline", async () => {
    vi.mocked(worldLive).mockImplementation(async () => ({ status: 0, body: null }));
    const { post } = setup(true);
    await flush();
    expect(post).toHaveBeenCalledWith({ t: "live-status", state: "connecting" });
    expect(post).toHaveBeenLastCalledWith({ t: "live-status", state: "connecting", retry: true });
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(worldLive).toHaveBeenCalledTimes(9);
    expect(post).toHaveBeenLastCalledWith({ t: "live-status", state: "off", reason: "offline" });
  });

  it.each([
    [{ error: "banned" }, "banned"],
    [{ error: "online save is off" }, "consent"],
  ])("a 403 ticket ends the session (%j)", async (body, reason) => {
    vi.mocked(worldLive).mockImplementation(async () => ({ status: 403, body }));
    const { post } = setup(true);
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(worldLive).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenLastCalledWith({ t: "live-status", state: "off", reason });
  });

  it("closes after 60 s paused and reopens on resume; closes when disabled", async () => {
    const { rerender, post } = setup(true);
    await flush();
    const ws = last();
    act(() => ws.open());
    rerender({ enabled: true, paused: true });
    await act(async () => vi.advanceTimersByTimeAsync(59_000));
    expect(ws.closed).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(ws.closed).toBe(1000);
    expect(post).toHaveBeenLastCalledWith({ t: "live-status", state: "off", reason: "offline" });
    rerender({ enabled: true, paused: false });
    await flush();
    expect(worldLive).toHaveBeenCalledTimes(2);
    rerender({ enabled: false, paused: false });
    expect(last().closed).toBe(1000);
  });
});
