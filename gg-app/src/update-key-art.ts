import { LINE_H, textPixels, textWidth } from "./pixel-text";
import { hashKey, renderPixelGrid } from "./critter-sprites";
import { seeded } from "./whatsnew-content";

/**
 * Art for the home screen's update key (HomeUpdateButton): the
 * key's pixel plate and its side, the bobbing arrow, a sparkle, words in
 * GG Royale's pixel font (m5x7), and the burst it goes off in at 100%, all in
 * GG Royale's palette (ink, gold, wine, felt green). Colours are art, not
 * theme roles, so the key looks the same in both themes. Everything here is
 * computed once and deterministic.
 */

export interface PixelCell {
  readonly col: number;
  readonly row: number;
  /** 0 at the word's left edge to 1 at its right, for a colour sweep. */
  readonly t: number;
}

export interface PixelWord {
  readonly cells: readonly PixelCell[];
  readonly cols: number;
  readonly rows: number;
}

/**
 * `text` in m5x7, GG Royale's pixel font (as the Goal world draws it): rows
 * run from the top of the capitals to the bottom of the descenders.
 */
export function pixelWord(text: string): PixelWord {
  const cols = Math.max(1, textWidth(text));
  const cells: PixelCell[] = textPixels(text)
    .filter(([, y]) => y >= 0 && y < LINE_H)
    .map(([x, y]) => ({ col: x, row: y, t: cols > 1 ? x / (cols - 1) : 0 }));
  return { cells, cols, rows: LINE_H };
}

/** Columns the XP readout reserves, so "7%" to "100%" never resizes the key. */
export const PCT_COLS = textWidth("100%");

/** Where each lit cell of a word starts before it flies into place. */
export interface CellFlight {
  readonly dx: number;
  readonly dy: number;
  readonly rot: number;
  /** Start delay, in seconds. */
  readonly delay: number;
}

/** A seeded scatter for a word's cells: the same word always flies the same way. */
export function cellFlights(word: PixelWord, key: string, spread: number): CellFlight[] {
  const rand = seeded(hashKey(key));
  return word.cells.map(() => ({
    dx: (rand() - 0.5) * spread * 2,
    dy: (rand() - 0.5) * spread,
    rot: (rand() - 0.5) * 540,
    delay: rand() * 0.35,
  }));
}

export interface BurstPiece {
  readonly dx: number;
  readonly dy: number;
  readonly size: number;
  readonly color: string;
  readonly delay: number;
}

const BURST_COLORS = ["#f5bd63", "#8fbf6a", "#fff0e0", "#cedbf9"] as const;

/**
 * The pixels a key goes off in when the update lands: a ring, flung outwards.
 * `squash` scales the vertical reach, for a bar too short for a full ring.
 */
export function burstPieces(count = 18, squash = 1): BurstPiece[] {
  const rand = seeded(hashKey("update-key-burst"));
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2 + (rand() - 0.5) * 0.4;
    const reach = 46 + rand() * 40;
    return {
      dx: Math.round(Math.cos(angle) * reach * 1.9),
      dy: Math.round(Math.sin(angle) * reach * 0.8 * squash),
      size: rand() < 0.35 ? 6 : 4,
      color: BURST_COLORS[i % BURST_COLORS.length] ?? "#f5bd63",
      delay: rand() * 0.08,
    };
  });
}

/**
 * A pixel grid as an SVG with its own size (one unit per cell), so CSS
 * `border-image-slice` can count in cells. renderPixelGrid leaves the size
 * off, which border-image can't slice.
 */
function sizedPixelSvg(rows: readonly string[], palette: Readonly<Record<string, string>>): string {
  const width = rows[0]?.length ?? 0;
  const src = renderPixelGrid(rows, palette, { width, height: rows.length });
  return src.replace(
    encodeURIComponent("<svg "),
    encodeURIComponent(`<svg width="${width}" height="${rows.length}" `),
  );
}

/**
 * The key's plate as a 9-slice, 12x12 cells (slice 4): an ink outline with
 * stepped corners, a gold rim lit top-left and shaded bottom-right, a lighter
 * inner edge on top and left, and a deep wine face (GG Royale's velvet).
 */
export const PLATE_ROWS = [
  "..KKKKKKKK..",
  ".KYYYYYYYYK.",
  "KYYHHHHHHYyK",
  "KYHFFFFFFFyK",
  "KYHFFFFFFFyK",
  "KYHFFFFFFFyK",
  "KYHFFFFFFFyK",
  "KYHFFFFFFFyK",
  "KYFFFFFFFFyK",
  "KyyFFFFFFyyK",
  ".KyyyyyyyyK.",
  "..KKKKKKKK..",
] as const;

export const PLATE_PALETTE = {
  K: "#1e0c1f",
  Y: "#e9af54",
  y: "#a0743c",
  H: "#6e3446",
  F: "#4c1c2c",
} as const;

/** The key's side, seen under the plate: the same shape in dark wood. */
const BASE_PALETTE = {
  K: "#1e0c1f",
  Y: "#743c36",
  y: "#4e343f",
  H: "#5a2e22",
  F: "#5a2e22",
} as const;

export const PLATE_SRC = sizedPixelSvg(PLATE_ROWS, PLATE_PALETTE);
export const BASE_SRC = sizedPixelSvg(PLATE_ROWS, BASE_PALETTE);

/** The up arrow on the key: felt green, ink outline, lit on its left edge. 9x9. */
const ARROW_ROWS = [
  "....O....",
  "...OLO...",
  "..OLGGO..",
  ".OLGGGGO.",
  "OLGGGGGGO",
  "OOOLGGOOO",
  "..OLGGO..",
  "..OLGGO..",
  "..OOOOO..",
] as const;
export const ARROW_SRC = renderPixelGrid(
  ARROW_ROWS,
  { O: "#1e0c1f", L: "#b8dc98", G: "#688e50" },
  { width: 9, height: 9 },
);

/** A four-point twinkle. 5x5. */
const SPARKLE_ROWS = ["..Y..", "..Y..", "YYWYY", "..Y..", "..Y.."] as const;
export const SPARKLE_SRC = renderPixelGrid(
  SPARKLE_ROWS,
  { Y: "#f5bd63", W: "#fff0d0" },
  { width: 5, height: 5 },
);
