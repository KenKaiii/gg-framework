// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createLiveTextStore, LiveTextContext, useLiveText, type LiveTextStore } from "./live-text";

afterEach(cleanup);

function Row({ id, stored, onRender }: { id: number; stored: string; onRender: () => void }) {
  onRender();
  return <p data-testid={`row-${id}`}>{useLiveText(id, stored).text}</p>;
}

function renderRows(store: LiveTextStore) {
  const renders = { 1: 0, 2: 0 };
  render(
    <LiveTextContext.Provider value={store}>
      <Row id={1} stored="done reply" onRender={() => (renders[1] += 1)} />
      <Row id={2} stored="Hel" onRender={() => (renders[2] += 1)} />
    </LiveTextContext.Provider>,
  );
  return renders;
}

describe("live text", () => {
  it("re-renders only the streaming row as it grows", () => {
    const store = createLiveTextStore();
    store.begin(2, "Hel");
    const renders = renderRows(store);
    expect(renders).toEqual({ 1: 1, 2: 1 });

    act(() => store.append(2, "lo"));
    act(() => store.append(2, " world"));

    expect(screen.getByTestId("row-2").textContent).toBe("Hello world");
    expect(screen.getByTestId("row-1").textContent).toBe("done reply");
    expect(renders).toEqual({ 1: 1, 2: 3 });
  });

  it("falls back to the stored text once released, and ignores ids that aren't live", () => {
    const store = createLiveTextStore();
    store.begin(2, "Hel");
    renderRows(store);
    act(() => store.append(1, "never shown"));
    expect(screen.getByTestId("row-1").textContent).toBe("done reply");

    store.release(2);
    act(() => store.append(2, "late"));
    expect(store.get(2)).toBeUndefined();
  });

  it("reads the stored text without a provider", () => {
    render(<Row id={7} stored="plain" onRender={() => undefined} />);
    expect(screen.getByTestId("row-7").textContent).toBe("plain");
  });

  it("reports a row as streaming from its first chunk until it is released", () => {
    const store = createLiveTextStore();
    function Flag({ id }: { id: number }): React.ReactElement {
      return <p data-testid={`flag-${id}`}>{String(useLiveText(id, "stored").streaming)}</p>;
    }
    store.begin(3, "**He");
    render(
      <LiveTextContext.Provider value={store}>
        <Flag id={3} />
        <Flag id={4} />
      </LiveTextContext.Provider>,
    );
    // Streaming from the very first chunk: the tail repair applies at once.
    expect(screen.getByTestId("flag-3").textContent).toBe("true");
    expect(screen.getByTestId("flag-4").textContent).toBe("false");
    act(() => {
      store.release(3);
      store.append(3, "x"); // ignored, but would notify if still live
    });
  });
});
