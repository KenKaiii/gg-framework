// Pure helpers behind the "What's new" window (WhatsNewWindow.tsx): which
// mood to show, how a changelog bullet splits into a headline and body, which
// critters turn up, the log frame's pixel art, and the pixel font for the
// version number.

import { CRITTERS, type CritterDef } from "./critter-sprites";

/**
 * `hype` is the one-time show after an update relaunch; `calm` is what the
 * home screen's "What's new" button opens. Anything unknown reads as calm, so a
 * bad URL never blasts the full show at someone who just wanted to read.
 */
export const WHATSNEW_MODES = ["hype", "calm"] as const;
export type WhatsNewMode = (typeof WHATSNEW_MODES)[number];

/** A log's cross-section from its outer edge in: outline, highlight, wood, shade, outline. */
const LOG_RINGS = ["O", "H", "L", "M", "O"] as const;
/** Frame grid edge, in cells: two 5-cell corners and a 6-cell repeating middle. */
export const LOG_FRAME_CELLS = 16;
/** Wood grain sits at this cell of each 6-cell middle run. */
const GRAIN_AT = 7;

/**
 * The 9-slice grid for the log frame. Each cell's ring is its distance from
 * the nearest edge; the corners lose three cells so they read as notched
 * pixel corners, not squares.
 */
export function logFrameRows(): string[] {
  const n = LOG_FRAME_CELLS;
  return Array.from({ length: n }, (_, y) =>
    Array.from({ length: n }, (_, x) => {
      const cx = Math.min(x, n - 1 - x);
      const cy = Math.min(y, n - 1 - y);
      if (cx + cy < 2) return ".";
      const ring = LOG_RINGS[Math.min(cx, cy)];
      if (!ring) return ".";
      const along = cx < cy ? y : x;
      return ring === "L" && along === GRAIN_AT ? "M" : ring;
    }).join(""),
  );
}

/** One piece of the log frame: its art and its size in cells. */
export interface LogPiece {
  readonly rows: readonly string[];
  readonly width: number;
  readonly height: number;
}

/** Corner pieces are this many cells square; edge pieces are 6 cells long. */
export const LOG_CORNER_CELLS = 5;

/**
 * The log frame cut into its nine-slice pieces (centre dropped), drawn as
 * background layers: corners first so they sit on top of the edges. The
 * order is the stylesheet's layer order for `.wn-camp-logs`.
 */
export function logFramePieces(): LogPiece[] {
  const rows = logFrameRows();
  const c = LOG_CORNER_CELLS;
  const far = LOG_FRAME_CELLS - c;
  const cut = (y0: number, y1: number, x0: number, x1: number): LogPiece => ({
    rows: rows.slice(y0, y1).map((row) => row.slice(x0, x1)),
    width: x1 - x0,
    height: y1 - y0,
  });
  const n = LOG_FRAME_CELLS;
  return [
    cut(0, c, 0, c), // top-left
    cut(0, c, far, n), // top-right
    cut(far, n, 0, c), // bottom-left
    cut(far, n, far, n), // bottom-right
    cut(0, c, c, far), // top edge
    cut(far, n, c, far), // bottom edge
    cut(c, far, 0, c), // left edge
    cut(c, far, far, n), // right edge
  ];
}

/** One 6-cell tile of the horizontal log beam, top to bottom. */
export function logBeamRows(): string[] {
  return LOG_RINGS.map((ring) =>
    Array.from({ length: 6 }, (_, x) => (ring === "L" && x === GRAIN_AT - 5 ? "M" : ring)).join(""),
  );
}

export function parseMode(value: string | null): WhatsNewMode {
  return value === "hype" ? "hype" : "calm";
}

/** One changelog bullet, split for reading: a punchy lead and the detail. */
export interface Feature {
  readonly headline: string;
  readonly body: string;
}

/** Shorter leads ("Big win.") read as fragments, so they stay in the body. */
const MIN_HEADLINE = 12;

/**
 * Split a bullet at its first sentence end. Every changelog line opens with a
 * hook sentence ("Plans never get stuck in limbo again."), which makes a
 * natural headline. Dots inside backticked names (`GPT-5.6`) never split.
 */
export function splitItem(text: string): Feature {
  const trimmed = text.trim();
  let inCode = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "`") {
      inCode = !inCode;
      continue;
    }
    if (inCode || (ch !== "." && ch !== "!" && ch !== "?")) continue;
    const next = trimmed[i + 1];
    if (next === undefined || !/\s/.test(next)) continue;
    const headline = trimmed.slice(0, i + 1);
    if (headline.length < MIN_HEADLINE) continue;
    return { headline, body: trimmed.slice(i + 1).trim() };
  }
  return { headline: trimmed, body: "" };
}

/**
 * Seeded PRNG (mulberry32): decorations like star fields and pixel flight
 * paths stay identical across renders, so React never repaints them at random.
 */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `count` critters, all different until the roster runs out, shuffled by
 * `random` so each opening brings a different crew.
 */
export function pickCrew(count: number, random: () => number): CritterDef[] {
  const deck = [...CRITTERS];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = deck[i];
    const b = deck[j];
    if (a && b) {
      deck[i] = b;
      deck[j] = a;
    }
  }
  return Array.from({ length: count }, (_, i) => deck[i % deck.length]).filter(
    (critter): critter is CritterDef => critter !== undefined,
  );
}

/** "2026-10-07" → "Oct 7", read in UTC so the day never shifts by timezone. */
export function shortDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** 3×5 pixel glyphs for the version number. `#` is lit. */
const PIXEL_GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": ["###", "#.#", "#.#", "#.#", "###"],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["###", "..#", "###", "#..", "###"],
  "3": ["###", "..#", ".##", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", "..#", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "###"],
  ".": [".", ".", ".", ".", "#"],
  v: ["...", "...", "#.#", "#.#", ".#."],
};

/** Lay `text` out in the pixel font, one blank column between glyphs. */
export function pixelText(text: string): string[] {
  const glyphs = [...text]
    .map((ch) => PIXEL_GLYPHS[ch])
    .filter((glyph): glyph is readonly string[] => glyph !== undefined);
  return Array.from({ length: 5 }, (_, row) => glyphs.map((glyph) => glyph[row] ?? "").join("."));
}
