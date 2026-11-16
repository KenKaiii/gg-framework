// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createParentBridge } from "./bridge";

function fakeWindow() {
  const listeners = new Set<(e: MessageEvent) => void>();
  const parent = { postMessage: vi.fn() };
  const win = {
    parent,
    addEventListener: (_t: string, fn: (e: MessageEvent) => void) => listeners.add(fn),
  } as unknown as Window;
  const deliver = (data: unknown, origin: string, source: unknown = parent) => {
    for (const fn of listeners) fn({ data, origin, source } as MessageEvent);
  };
  return { win, parent, deliver };
}

describe("frame bridge", () => {
  it("holds messages until it knows the proxy's origins, then accepts only those", () => {
    const { win, deliver } = fakeWindow();
    const bridge = createParentBridge(win);
    const seen: string[] = [];
    bridge.onMessage((m) => seen.push(m.type));
    deliver({ type: "gg-live:focus" }, "http://localhost:4100");
    expect(seen).toEqual([]);
    bridge.setOrigins(["http://localhost:4100"]);
    expect(seen).toEqual(["gg-live:focus"]);
    deliver({ type: "gg-live:focus" }, "http://evil.example");
    deliver({ type: "gg-live:focus" }, "http://localhost:4100", {});
    expect(seen).toEqual(["gg-live:focus"]);
  });

  it("replies only to the page's own origin once it has spoken", () => {
    const { win, parent, deliver } = fakeWindow();
    const bridge = createParentBridge(win);
    bridge.setOrigins(["http://localhost:4100", "http://127.0.0.1:4100"]);
    bridge.post({ type: "gg-live:ready" });
    expect(parent.postMessage.mock.calls.map((c) => c[1])).toEqual([
      "http://localhost:4100",
      "http://127.0.0.1:4100",
    ]);
    parent.postMessage.mockClear();
    deliver({ type: "gg-live:focus" }, "http://127.0.0.1:4100");
    bridge.post({ type: "gg-live:open", open: true });
    expect(parent.postMessage).toHaveBeenCalledExactlyOnceWith(
      { type: "gg-live:open", open: true },
      "http://127.0.0.1:4100",
    );
  });
});
