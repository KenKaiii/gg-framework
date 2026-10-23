import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent, StreamResponse } from "@kenkaiiii/gg-ai";
import {
  HEDGE_CACHE_WARM_MS,
  HEDGE_FIRST_EVENT_AFTER_MS,
  firstEventHedgeDelayMs,
  hedgedStream,
  type HedgeArm,
  type HedgeableStream,
} from "./hedged-stream.js";

type Script = "hang" | { delayMs: number; text?: string; error?: Error };

function abortError(): Error {
  return Object.assign(new Error("Aborted"), { name: "AbortError" });
}

function response(text: string): StreamResponse {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

/** A provider stream that answers after `delayMs`, fails, or hangs until aborted. */
function scripted(signal: AbortSignal, script: Script): HedgeableStream {
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(abortError());
    else signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
  aborted.catch(() => {});
  const ready =
    script === "hang"
      ? aborted
      : Promise.race([new Promise<void>((r) => setTimeout(r, script.delayMs)), aborted]);
  const text = script === "hang" ? "" : (script.text ?? "");
  const error = script === "hang" ? undefined : script.error;
  const done = ready.then(() => {
    if (error) throw error;
    return response(text);
  });
  done.catch(() => {});
  return {
    response: done,
    async *[Symbol.asyncIterator]() {
      await ready;
      if (error) throw error;
      yield { type: "text_delta", text } satisfies StreamEvent;
    },
  };
}

function harness(scripts: Record<HedgeArm, Script>, hedgeAfterMs: number | null = 30_000) {
  const outer = new AbortController();
  const signals: Partial<Record<HedgeArm, AbortSignal>> = {};
  const started: HedgeArm[] = [];
  const settled: { winner: HedgeArm; hedged: boolean }[] = [];
  const result = hedgedStream({
    signal: outer.signal,
    hedgeAfterMs,
    start: (signal, arm) => {
      started.push(arm);
      signals[arm] = signal;
      return scripted(signal, scripts[arm]);
    },
    onSettled: (winner, hedged) => settled.push({ winner, hedged }),
  });
  const collect = (async () => {
    const texts: string[] = [];
    for await (const event of result) {
      if (event.type === "text_delta") texts.push(event.text);
    }
    return texts;
  })();
  collect.catch(() => {});
  return { outer, signals, started, settled, result, collect };
}

describe("hedgedStream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends no hedge when the first event arrives in time", async () => {
    const h = harness({ primary: { delayMs: 5_000, text: "fast" }, hedge: "hang" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await h.collect).toEqual(["fast"]);
    expect(h.started).toEqual(["primary"]);
    expect(h.settled).toEqual([{ winner: "primary", hedged: false }]);
  });

  it("recovers a hung request through the hedge and aborts the hung one", async () => {
    // Incident shape: the original never answers; a fresh request answers in ~8s.
    const h = harness({ primary: "hang", hedge: { delayMs: 8_000, text: "from hedge" } });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.started).toEqual(["primary"]);
    await vi.advanceTimersByTimeAsync(8_001);
    expect(await h.collect).toEqual(["from hedge"]);
    expect(h.started).toEqual(["primary", "hedge"]);
    expect(h.signals.primary?.aborted).toBe(true);
    expect(h.signals.hedge?.aborted).toBe(false);
    expect(h.settled).toEqual([{ winner: "hedge", hedged: true }]);
    expect((await h.result.response).message.content).toEqual([
      { type: "text", text: "from hedge" },
    ]);
  });

  it("never cuts off a slow but healthy original", async () => {
    const h = harness({
      primary: { delayMs: 40_000, text: "slow original" },
      hedge: { delayMs: 30_000, text: "hedge" },
    });
    await vi.advanceTimersByTimeAsync(41_000);
    expect(await h.collect).toEqual(["slow original"]);
    expect(h.signals.hedge?.aborted).toBe(true);
    expect(h.settled).toEqual([{ winner: "primary", hedged: true }]);
  });

  it("propagates an early failure unchanged without hedging", async () => {
    const failure = new Error("overloaded");
    const h = harness({ primary: { delayMs: 1_000, error: failure }, hedge: "hang" });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(h.collect).rejects.toBe(failure);
    await expect(h.result.response).rejects.toBe(failure);
    expect(h.started).toEqual(["primary"]);
  });

  it("keeps waiting on the original when the hedge fails", async () => {
    const h = harness({
      primary: { delayMs: 50_000, text: "original" },
      hedge: { delayMs: 1_000, error: new Error("429") },
    });
    await vi.advanceTimersByTimeAsync(51_000);
    expect(await h.collect).toEqual(["original"]);
    expect(h.settled).toEqual([{ winner: "primary", hedged: true }]);
  });

  it("reports the original's error when both requests fail", async () => {
    const original = new Error("original failed");
    const h = harness({
      primary: { delayMs: 40_000, error: original },
      hedge: { delayMs: 1_000, error: new Error("hedge failed") },
    });
    await vi.advanceTimersByTimeAsync(41_000);
    await expect(h.collect).rejects.toBe(original);
  });

  it("aborts both requests when the caller's watchdog fires", async () => {
    const h = harness({ primary: "hang", hedge: "hang" });
    await vi.advanceTimersByTimeAsync(31_000);
    h.outer.abort();
    await expect(h.collect).rejects.toMatchObject({ name: "AbortError" });
    expect(h.signals.primary?.aborted).toBe(true);
    expect(h.signals.hedge?.aborted).toBe(true);
  });

  it("does not start a hedge after the caller aborted", async () => {
    const h = harness({ primary: "hang", hedge: "hang" });
    await vi.advanceTimersByTimeAsync(10_000);
    h.outer.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(h.collect).rejects.toMatchObject({ name: "AbortError" });
    expect(h.started).toEqual(["primary"]);
  });

  it("is a passthrough when hedging is disabled", async () => {
    const h = harness({ primary: "hang", hedge: { delayMs: 1, text: "x" } }, null);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.started).toEqual(["primary"]);
    expect(h.signals.primary).toBe(h.outer.signal);
    h.outer.abort();
    await expect(h.collect).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("firstEventHedgeDelayMs", () => {
  const warm = {
    priorUsage: { inputTokens: 300, outputTokens: 400, cacheRead: 370_000, cacheWrite: 1_500 },
    msSincePriorResponse: 5_000,
    newPromptTokens: 500,
    firstEventTimeoutMs: 91_000,
    prefillMsPer1kTokens: 640,
  };

  it("hedges the incident shape: warm 370K-token prompt, 91s watchdog", () => {
    expect(firstEventHedgeDelayMs(warm)).toBe(HEDGE_FIRST_EVENT_AFTER_MS + 0.5 * 640);
  });

  it("does not hedge without proof the prompt is cached", () => {
    expect(firstEventHedgeDelayMs({ ...warm, priorUsage: undefined })).toBeNull();
    expect(
      firstEventHedgeDelayMs({
        ...warm,
        priorUsage: { inputTokens: 300_000, outputTokens: 10, cacheRead: 10_000 },
      }),
    ).toBeNull();
  });

  it("does not hedge once the cache has likely expired", () => {
    expect(
      firstEventHedgeDelayMs({ ...warm, msSincePriorResponse: HEDGE_CACHE_WARM_MS + 1 }),
    ).toBeNull();
  });

  it("allows prefill time for a large uncached tail", () => {
    const delay = firstEventHedgeDelayMs({
      ...warm,
      newPromptTokens: 50_000,
      firstEventTimeoutMs: 180_000,
    });
    expect(delay).toBe(HEDGE_FIRST_EVENT_AFTER_MS + 50 * 640);
  });

  it("does not hedge when the watchdog would fire before a hedge could answer", () => {
    expect(firstEventHedgeDelayMs({ ...warm, firstEventTimeoutMs: 45_000 })).toBeNull();
    expect(
      firstEventHedgeDelayMs({ ...warm, firstEventTimeoutMs: Number.POSITIVE_INFINITY }),
    ).toBeNull();
  });
});
