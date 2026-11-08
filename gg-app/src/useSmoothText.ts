import { useEffect, useRef, useState } from "react";

/**
 * Paces streamed text so the PAINT rhythm stops being the NETWORK rhythm.
 *
 * Deltas arrive in bursts (200 characters in one flush, then five), which is
 * what makes a naive stream read as a lurching typewriter. This reveals text
 * toward the incoming target on every animation frame instead, spending
 * `DRAIN_MS` on whatever backlog exists: a burst simply reveals slightly
 * faster until it has caught up. Same total duration, even cadence.
 *
 * Port of the approach in assistant-ui's `useSmooth` (MIT), trimmed to what
 * this app needs.
 */

/** Target time to drain the unrevealed backlog. Bigger = more lag, smoother. */
const DRAIN_MS = 250;
/** Slowest reveal rate — the floor that keeps a 3-character backlog moving. */
const MAX_CHAR_INTERVAL_MS = 5;
/**
 * Minimum gap between React commits. The reveal advances every frame, but
 * committing re-runs `marked.lexer` over the whole message, so committing at
 * 30fps rather than 60 halves that cost; the per-word fade-in covers the gap.
 */
const COMMIT_MS = 33;
/**
 * How long after the last delta a row still counts as animating. Covers the
 * reveal draining plus the last word's fade, after which the word-span
 * wrappers are dropped from the DOM.
 */
const SETTLE_MS = 700;
/**
 * Words land whole. The reveal still advances by characters, but a commit stops
 * at the last word boundary, so a word appears complete and fades in once,
 * rather than gaining letters while it is already fading (each late letter
 * popped in at a different brightness). When the reveal has caught up and the
 * text ends mid-word, the partial word waits this long for its next letters
 * before it is shown anyway. While the caller says more is still coming
 * (`holdPartial`), it waits for them instead: a network gap mid-word used to
 * show "co", fade it in, then pop "ld" onto it un-faded.
 */
const WORD_TAIL_MS = 90;
/** A "word" longer than this (a URL, a long path) shows as it grows. */
const MAX_HELD_CHARS = 40;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export interface SmoothText {
  /** The prefix revealed so far — render this, not the raw text. */
  text: string;
  /** True while text is still arriving/revealing: gates the word fade-in. */
  animating: boolean;
}

interface Reveal {
  /** How far the reveal has advanced (may end mid-word). */
  current: string;
  /** What has arrived and is still to be revealed. */
  target: string;
  /** What is on screen: `current` cut back to a word boundary. */
  shown: string;
  raf: number;
  lastFrame: number;
  lastCommit: number;
  settle: number;
  /** Shows a held partial word once the reveal has stalled on it. */
  tail: number;
  /** More text is still coming: keep a partial last word back until it ends. */
  hold: boolean;
}

/**
 * The part of `current` to put on screen: everything up to the last word
 * boundary while the word being revealed is still incomplete. Never shrinks
 * below what is already shown.
 */
function wholeWords(a: Reveal): string {
  const { current, target, shown } = a;
  const next = target.charAt(current.length);
  // Ends exactly on a boundary, or the next character starts a new word.
  if (current === "" || /\s$/.test(current) || (next !== "" && /\s/.test(next))) {
    return current;
  }
  const cut = Math.max(current.lastIndexOf(" "), current.lastIndexOf("\n")) + 1;
  if (current.length - cut > MAX_HELD_CHARS || cut <= shown.length) return shown;
  return current.slice(0, cut);
}

function show(a: Reveal, text: string, commit: (text: string) => void): void {
  if (text.length <= a.shown.length) return;
  a.shown = text;
  commit(text);
}

/** One frame of the reveal; re-arms itself until `current` catches `target`. */
function advance(a: Reveal, commit: (text: string) => void): void {
  const now = performance.now();
  let budget = now - a.lastFrame;
  const remaining = a.target.length - a.current.length;
  const perChar = Math.min(MAX_CHAR_INTERVAL_MS, DRAIN_MS / Math.max(remaining, 1));
  let add = 0;
  while (budget >= perChar && add < remaining) {
    add++;
    budget -= perChar;
  }
  a.raf = add === remaining ? 0 : requestAnimationFrame(() => advance(a, commit));
  if (add === 0) return;
  a.current = a.target.slice(0, a.current.length + add);
  a.lastFrame = now - budget;
  const caughtUp = add === remaining;
  // The catch-up frame always commits, so the tail of a reply can never be
  // left unpainted by the commit throttle.
  if (caughtUp || now - a.lastCommit >= COMMIT_MS) {
    a.lastCommit = now;
    show(a, wholeWords(a), commit);
  }
  // Caught up partway through a word: show the rest of it if no more letters
  // arrive shortly, unless more is known to be coming.
  if (caughtUp && a.shown !== a.current && !a.hold) {
    clearTimeout(a.tail);
    a.tail = window.setTimeout(() => show(a, a.current, commit), WORD_TAIL_MS);
  }
}

/**
 * Returns the smoothly-revealed prefix of `text`.
 *
 * The text present on the FIRST render commits immediately — resumed history
 * and finished replies must never animate. Only later growth is paced, and
 * text that stops being an extension of what is on screen (a discarded draft,
 * a replaced message) snaps instead of rewinding.
 *
 * `holdPartial`: the text is still streaming in, so a half-arrived last word
 * stays back until the rest of it lands (or this turns false).
 */
export function useSmoothText(text: string, holdPartial = false): SmoothText {
  const [revealed, setRevealed] = useState(text);
  const [animating, setAnimating] = useState(false);
  const anim = useRef<Reveal>({
    current: text,
    target: text,
    shown: text,
    raf: 0,
    lastFrame: 0,
    lastCommit: 0,
    settle: 0,
    tail: 0,
    hold: holdPartial,
  });

  useEffect(() => {
    const a = anim.current;
    a.hold = holdPartial;
    // The stream ended while a partial word was held: it is the last word.
    if (!holdPartial && a.raf === 0 && a.shown !== a.current) show(a, a.current, setRevealed);
  }, [holdPartial]);

  useEffect(() => {
    const a = anim.current;
    if (a.target === text) return;
    // Not an extension of what is on screen (draft discarded, message
    // replaced) — or motion is unwanted. Snap; rewinding would look broken.
    if (prefersReducedMotion() || !text.startsWith(a.current)) {
      if (a.raf) cancelAnimationFrame(a.raf);
      clearTimeout(a.tail);
      a.raf = 0;
      a.current = text;
      a.target = text;
      a.shown = text;
      setRevealed(text);
      return;
    }
    // More text arrived: a held partial word is about to be completed.
    clearTimeout(a.tail);
    a.target = text;
    setAnimating(true);
    clearTimeout(a.settle);
    a.settle = window.setTimeout(() => setAnimating(false), SETTLE_MS);
    if (a.raf === 0) {
      a.lastFrame = performance.now();
      advance(a, setRevealed);
    }
  }, [text]);

  useEffect(() => {
    const a = anim.current;
    return () => {
      if (a.raf) cancelAnimationFrame(a.raf);
      clearTimeout(a.settle);
      clearTimeout(a.tail);
    };
  }, []);

  return { text: revealed, animating };
}
