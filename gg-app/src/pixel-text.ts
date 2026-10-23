import { M5X7, M5X7_SPACE } from "./pixel-font-m5x7";

/**
 * Text in m5x7, GG Royale's body font, drawn pixel by pixel on the Goal
 * world's canvas. The glyphs are baked (pixel-font-m5x7.ts), so drawing is
 * sync, crisp at any CSS scale, and measurable without a canvas.
 *
 * `y` is the top of a capital letter. Accents reach 2px above it, and
 * descenders 2px below the 7px capitals, so a line's box is LINE_H tall.
 */

/** Blank rows above the capitals in the baked band (accents live there). */
const CAP_TOP = 2;
/** Capitals plus descenders: the height a line of text takes up. */
export const LINE_H = 9;
/** Line pitch: a line's height and a 1px gap. */
export const LINE_PITCH = LINE_H + 1;

/** Characters the font has no glyph for, swapped for ones it has. */
const SWAPS: Readonly<Record<string, string>> = {
  "\u2026": "...",
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u2013": "-",
  "\u2014": "-",
  "\u00b7": ".",
};

/** `text` in characters the font can draw (anything else becomes "?"). */
export function drawable(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === " " || M5X7[ch]) out += ch;
    else out += SWAPS[ch] ?? "?";
  }
  return out;
}

function advanceOf(ch: string): number {
  return ch === " " ? M5X7_SPACE : (M5X7[ch]?.advance ?? M5X7["?"]?.advance ?? 6);
}

/** Width of `text` in pixels, without the gap after its last letter. */
export function textWidth(text: string): number {
  const s = drawable(text);
  if (s.length === 0) return 0;
  let w = 0;
  for (const ch of s) w += advanceOf(ch);
  return w - 1;
}

/**
 * `text` broken into lines no wider than `maxWidth` pixels, at spaces (a word
 * longer than a line stays whole on its own line). At most `maxLines` lines;
 * anything past that is dropped with "..." on the last.
 */
export function wrapText(text: string, maxWidth: number, maxLines = 2): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of drawable(text).split(" ").filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1] ?? ""}...`;
  return kept;
}

/** Each ink pixel of `text` with the top of the capitals at y = 0. */
export function textPixels(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let left = 0;
  for (const ch of drawable(text)) {
    const glyph = ch === " " ? undefined : (M5X7[ch] ?? M5X7["?"]);
    glyph?.rows.forEach((row, r) => {
      for (let dx = 0; dx < row.length; dx++) {
        if (row[dx] === "#") out.push([left + dx, r - CAP_TOP]);
      }
    });
    left += advanceOf(ch);
  }
  return out;
}

/** Recently drawn lines, so a bubble on screen costs one drawImage a frame. */
const cache = new Map<string, HTMLCanvasElement | null>();
const CACHE_MAX = 96;

function sprite(text: string, color: string): HTMLCanvasElement | null {
  const key = `${color}\u0000${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let canvas: HTMLCanvasElement | null = null;
  if (typeof document !== "undefined") {
    canvas = document.createElement("canvas");
    canvas.width = Math.max(1, textWidth(text));
    canvas.height = LINE_H + CAP_TOP;
    const c = canvas.getContext("2d");
    if (c) {
      c.fillStyle = color;
      for (const [x, y] of textPixels(text)) c.fillRect(x, y + CAP_TOP, 1, 1);
    } else canvas = null;
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value ?? "");
  cache.set(key, canvas);
  return canvas;
}

/** Draw `text` with the top-left of its capitals at (x, y). */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
): void {
  const left = Math.round(x);
  const top = Math.round(y);
  const s = sprite(text, color);
  if (s) {
    ctx.drawImage(s, left, top - CAP_TOP);
    return;
  }
  ctx.fillStyle = color;
  for (const [px, py] of textPixels(text)) ctx.fillRect(left + px, top + py, 1, 1);
}
