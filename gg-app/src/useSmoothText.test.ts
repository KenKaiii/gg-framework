// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useSmoothText } from "./useSmoothText";

// The reveal runs on requestAnimationFrame and reads performance.now(); fake
// timers drive both, so a "frame" here is just advancing time.
const frames = async (ms: number): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

describe("useSmoothText", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits the text present on first render immediately", () => {
    // Resumed history and finished replies must never re-animate.
    const { result } = renderHook(() => useSmoothText("already finished"));
    expect(result.current.text).toBe("already finished");
    expect(result.current.animating).toBe(false);
  });

  it("reveals growth gradually, then catches up fully", async () => {
    const { result, rerender } = renderHook(({ text }) => useSmoothText(text), {
      initialProps: { text: "" },
    });

    rerender({ text: "hello world, this is a streamed sentence" });
    // Long enough for a couple of frames past the 33ms commit throttle.
    await frames(80);
    expect(result.current.animating).toBe(true);
    // Part of the burst is on screen, but not all of it.
    expect(result.current.text.length).toBeGreaterThan(0);
    expect(result.current.text.length).toBeLessThan(39);
    expect("hello world, this is a streamed sentence".startsWith(result.current.text)).toBe(true);

    await frames(500);
    expect(result.current.text).toBe("hello world, this is a streamed sentence");
  });

  it("stops animating once the stream settles", async () => {
    const { result, rerender } = renderHook(({ text }) => useSmoothText(text), {
      initialProps: { text: "" },
    });
    rerender({ text: "done" });
    await frames(100);
    expect(result.current.animating).toBe(true);
    await frames(1000);
    expect(result.current.animating).toBe(false);
  });

  it("shows each word whole, never a word that is still gaining letters", async () => {
    const { result, rerender } = renderHook(({ text }) => useSmoothText(text), {
      initialProps: { text: "" },
    });
    const full = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    rerender({ text: full });
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      await frames(16);
      seen.add(result.current.text);
    }
    expect(seen.size).toBeGreaterThan(3);
    for (const text of seen) {
      // Mid-stream, the shown text always ends where a whole word ends.
      if (text === "" || text === full) continue;
      expect(full.charAt(text.length) === " " || /\s$/.test(text)).toBe(true);
    }
    expect(result.current.text).toBe(full);
  });

  it("shows a partial last word once no more letters arrive", async () => {
    const { result, rerender } = renderHook(({ text }) => useSmoothText(text), {
      initialProps: { text: "" },
    });
    // The stream stalls partway through "stream".
    rerender({ text: "a partial str" });
    await frames(60);
    // The complete words are up; the unfinished "str" is held back.
    expect(result.current.text.trimEnd()).toBe("a partial");
    await frames(200);
    expect(result.current.text).toBe("a partial str");
    // The rest of the word arrives and joins it.
    rerender({ text: "a partial stream" });
    await frames(300);
    expect(result.current.text).toBe("a partial stream");
  });

  it("holds a half-arrived word through a network gap while the reply is still streaming", async () => {
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmoothText(text, streaming),
      { initialProps: { text: "", streaming: true } },
    );
    // The gap lands mid-word: "co" of "cold".
    rerender({ text: "the co", streaming: true });
    await frames(1000);
    // Showing "co" now would fade it in, then pop "ld" onto it un-faded.
    expect(result.current.text.trimEnd()).toBe("the");

    rerender({ text: "the cold start", streaming: true });
    await frames(400);
    expect(result.current.text).toContain("cold");

    // The reply ends on a partial word: it is the last word, so it shows.
    rerender({ text: "the cold start is fa", streaming: true });
    await frames(400);
    expect(result.current.text.endsWith("fa")).toBe(false);
    rerender({ text: "the cold start is fa", streaming: false });
    await frames(16);
    expect(result.current.text).toBe("the cold start is fa");
  });

  it("snaps when the text is replaced rather than extended", async () => {
    const { result, rerender } = renderHook(({ text }) => useSmoothText(text), {
      initialProps: { text: "" },
    });
    rerender({ text: "an unreviewed draft" });
    await frames(500);
    // A discarded draft replaced by the reviewed final answer: rewinding
    // character by character would look broken, so it lands whole.
    rerender({ text: "the reviewed answer" });
    await frames(16);
    expect(result.current.text).toBe("the reviewed answer");
  });
});
