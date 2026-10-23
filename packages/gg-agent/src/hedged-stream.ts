import type { StreamEvent, StreamResponse, Usage } from "@kenkaiiii/gg-ai";

/**
 * Hedged first event for provider streams.
 *
 * Under load, providers (measured on Anthropic, 2026-10-22) occasionally
 * accept a request and then send nothing — not even `message_start` — until
 * our first-event watchdog gives up 90-155s later. A fresh request for the
 * identical, fully cached prompt starts in ~6-14s. Over the same window,
 * genuinely slow but healthy cached requests reached their first event at up
 * to ~139s, so the two are indistinguishable by elapsed time alone: a shorter
 * watchdog would abort real replies, and the long watchdog makes every hang
 * cost ~2 minutes of "Retrying…".
 *
 * A hedge resolves this without choosing a side. When the first event is late,
 * a second identical request starts while the original keeps running;
 * whichever produces an event first wins and the other is aborted. A slow
 * healthy request is never cut off, and a hung one costs only the hedge delay
 * plus a normal first-event latency. It is invisible to the UI (not a retry).
 *
 * The duplicate is only cheap when the prompt is already cached — a cold
 * duplicate re-prefills (and re-writes cache for) the whole context — so hedging
 * is gated on proof the prefix is warm; see `firstEventHedgeDelayMs`.
 */

export interface HedgeableStream extends AsyncIterable<StreamEvent> {
  readonly response: Promise<StreamResponse>;
}

export type HedgeArm = "primary" | "hedge";

export interface HedgedStreamOptions {
  /** Start one request. Each call gets its own abort signal. */
  start: (signal: AbortSignal, arm: HedgeArm) => HedgeableStream;
  /** Aborts every request (caller abort, idle/hard watchdogs). */
  signal: AbortSignal;
  /** Delay before starting the hedge; null disables hedging. */
  hedgeAfterMs: number | null;
  onHedgeStarted?: () => void;
  /** Called once, when the stream that will be consumed is chosen. */
  onSettled?: (winner: HedgeArm, hedged: boolean) => void;
}

/** Hedge after this much silence on a warm, cached prompt (~p98 healthy first-event). */
export const HEDGE_FIRST_EVENT_AFTER_MS = 30_000;
/**
 * The previous response must be this recent for its cached prefix to still be
 * warm. 5 minutes is the shortest default cache TTL among supported providers;
 * stay under it.
 */
export const HEDGE_CACHE_WARM_MS = 4 * 60_000;
/** Minimum share of the previous prompt that was served from or written to cache. */
export const HEDGE_MIN_CACHED_RATIO = 0.5;
/** The hedge needs this long before the watchdog fires to be worth starting. */
export const HEDGE_MIN_WINDOW_MS = 20_000;

export interface HedgeDelayInput {
  /** Usage of the previous successful response in this run, if any. */
  priorUsage: Usage | undefined;
  /** Milliseconds since that response completed. */
  msSincePriorResponse: number;
  /** Estimated tokens added since that response (the uncached tail). */
  newPromptTokens: number;
  /** The first-event watchdog for this attempt. */
  firstEventTimeoutMs: number;
  /** Per-1K-token prefill allowance applied to the uncached tail. */
  prefillMsPer1kTokens: number;
}

/**
 * Hedge delay for this attempt, or null when a hedge would be expensive or
 * pointless: no warm cache proof (first call of a run, after compaction, the
 * provider isn't caching, or the cache likely expired), or too little time left
 * before the watchdog for a duplicate to help.
 */
export function firstEventHedgeDelayMs(input: HedgeDelayInput): number | null {
  const usage = input.priorUsage;
  if (!usage) return null;
  const cached = (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const prompt = usage.inputTokens + cached;
  if (prompt <= 0 || cached / prompt < HEDGE_MIN_CACHED_RATIO) return null;
  if (input.msSincePriorResponse < 0 || input.msSincePriorResponse > HEDGE_CACHE_WARM_MS) {
    return null;
  }
  const delay =
    HEDGE_FIRST_EVENT_AFTER_MS +
    (Math.max(0, input.newPromptTokens) / 1000) * input.prefillMsPer1kTokens;
  if (!Number.isFinite(input.firstEventTimeoutMs)) return null;
  if (delay + HEDGE_MIN_WINDOW_MS > input.firstEventTimeoutMs) return null;
  return delay;
}

interface Arm {
  name: HedgeArm;
  stream: HedgeableStream;
  iterator: AsyncIterator<StreamEvent>;
  controller: AbortController;
}

type Outcome =
  | { arm: Arm; ok: true; first: IteratorResult<StreamEvent> }
  | { arm: Arm; ok: false; error: unknown };

interface Selection {
  arm: Arm;
  first: IteratorResult<StreamEvent>;
}

function linkedController(parent: AbortSignal): AbortController {
  const controller = new AbortController();
  if (parent.aborted) controller.abort();
  else parent.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

function startArm(name: HedgeArm, options: HedgedStreamOptions): Arm {
  const controller = linkedController(options.signal);
  const stream = options.start(controller.signal, name);
  // Losers are abandoned; never let their rejection go unhandled.
  stream.response.catch(() => {});
  return { name, stream, iterator: stream[Symbol.asyncIterator](), controller };
}

function firstOutcome(arm: Arm): Promise<Outcome> {
  return arm.iterator.next().then(
    (first): Outcome => ({ arm, ok: true, first }),
    (error: unknown): Outcome => ({ arm, ok: false, error }),
  );
}

/**
 * Wrap a stream so a late first event triggers one hedged duplicate request.
 * With `hedgeAfterMs` null this is exactly `start(signal)`.
 */
export function hedgedStream(options: HedgedStreamOptions): HedgeableStream {
  if (options.hedgeAfterMs === null) {
    const stream = options.start(options.signal, "primary");
    options.onSettled?.("primary", false);
    return stream;
  }
  const hedgeAfterMs = options.hedgeAfterMs;

  const select = async (): Promise<Selection> => {
    const primary = startArm("primary", options);
    const primaryOutcome = firstOutcome(primary);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const hedgeDue = new Promise<"hedge">((resolve) => {
      timer = setTimeout(() => resolve("hedge"), hedgeAfterMs);
    });
    let early: Outcome | "hedge";
    try {
      early = await Promise.race([primaryOutcome, hedgeDue]);
    } finally {
      clearTimeout(timer);
    }

    // Primary answered (or failed) before the hedge was due: no hedge. Errors
    // propagate unchanged so the loop's normal retry classification applies.
    if (early !== "hedge" || options.signal.aborted) {
      const outcome = early === "hedge" ? await primaryOutcome : early;
      if (!outcome.ok) throw outcome.error;
      options.onSettled?.("primary", false);
      return { arm: primary, first: outcome.first };
    }

    const hedge = startArm("hedge", options);
    options.onHedgeStarted?.();
    const hedgeOutcome = firstOutcome(hedge);

    // First arm to produce an event (or finish) wins. An arm that fails while
    // the other is still pending is ignored — that is the point of hedging.
    let winner = await Promise.race([primaryOutcome, hedgeOutcome]);
    if (!winner.ok) {
      const other = await (winner.arm === primary ? hedgeOutcome : primaryOutcome);
      if (!other.ok) {
        // Both failed: report the original request's error for classification.
        throw winner.arm === primary ? winner.error : other.error;
      }
      winner = other;
    }
    const loser = winner.arm === primary ? hedge : primary;
    loser.controller.abort();
    options.onSettled?.(winner.arm.name, true);
    return { arm: winner.arm, first: winner.first };
  };

  const selection = select();
  selection.catch(() => {});
  const response = selection.then((s) => s.arm.stream.response);
  response.catch(() => {});

  return {
    response,
    async *[Symbol.asyncIterator]() {
      const { arm, first } = await selection;
      if (first.done) return;
      try {
        yield first.value;
        while (true) {
          const next = await arm.iterator.next();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        await arm.iterator.return?.();
      }
    },
  };
}
