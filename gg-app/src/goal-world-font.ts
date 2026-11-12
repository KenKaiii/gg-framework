// A 3×5 pixel font for the Goal world's speech bubbles, so their words stay
// crisp at any whole-number scale (canvas text at one pixel per cell blurs).
// Uppercase only; lowercase is drawn as uppercase. Each glyph is five rows of
// three cells, `#` filled.

/** Glyphs by character, uppercase. Shared by the side view and the top-down map. */
export const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  A: [".#.", "#.#", "###", "#.#", "#.#"],
  B: ["##.", "#.#", "##.", "#.#", "##."],
  C: [".##", "#..", "#..", "#..", ".##"],
  D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "##.", "#..", "###"],
  F: ["###", "#..", "##.", "#..", "#.."],
  G: [".##", "#..", "#.#", "#.#", ".##"],
  H: ["#.#", "#.#", "###", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"],
  J: ["..#", "..#", "..#", "#.#", ".#."],
  K: ["#.#", "#.#", "##.", "#.#", "#.#"],
  L: ["#..", "#..", "#..", "#..", "###"],
  M: ["#.#", "###", "###", "#.#", "#.#"],
  N: ["##.", "#.#", "#.#", "#.#", "#.#"],
  O: [".#.", "#.#", "#.#", "#.#", ".#."],
  P: ["##.", "#.#", "##.", "#..", "#.."],
  Q: [".#.", "#.#", "#.#", "##.", ".##"],
  R: ["##.", "#.#", "##.", "#.#", "#.#"],
  S: [".##", "#..", ".#.", "..#", "##."],
  T: ["###", ".#.", ".#.", ".#.", ".#."],
  U: ["#.#", "#.#", "#.#", "#.#", "###"],
  V: ["#.#", "#.#", "#.#", "#.#", ".#."],
  W: ["#.#", "#.#", "###", "###", "#.#"],
  X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."],
  Z: ["###", "..#", ".#.", "#..", "###"],
  "0": [".#.", "#.#", "#.#", "#.#", ".#."],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["##.", "..#", ".#.", "#..", "###"],
  "3": ["##.", "..#", ".#.", "..#", "##."],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "##.", "..#", "##."],
  "6": [".##", "#..", "##.", "#.#", ".#."],
  "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": [".#.", "#.#", ".#.", "#.#", ".#."],
  "9": [".#.", "#.#", ".##", "..#", "##."],
  ".": ["...", "...", "...", "...", ".#."],
  ",": ["...", "...", "...", ".#.", "#.."],
  "!": [".#.", ".#.", ".#.", "...", ".#."],
  "?": ["##.", "..#", ".#.", "...", ".#."],
  "'": [".#.", ".#.", "...", "...", "..."],
  "\u2019": [".#.", ".#.", "...", "...", "..."],
  "-": ["...", "...", "###", "...", "..."],
  ":": ["...", ".#.", "...", ".#.", "..."],
  "/": ["..#", "..#", ".#.", "#..", "#.."],
  "*": ["...", "#.#", ".#.", "#.#", "..."],
  " ": ["...", "...", "...", "...", "..."],
};

export const GLYPH_W = 3;
/** Cells between letters. */
const GAP = 1;

const glyphOf = (ch: string): readonly string[] => GLYPHS[ch.toUpperCase()] ?? GLYPHS["?"] ?? [];

/**
 * `text` broken into lines no wider than `maxWidth` cells, at spaces (a word
 * longer than a line stays whole on its own line). At most `maxLines` lines;
 * anything past that is dropped with "..." on the last.
 */
export function wrapText(text: string, maxWidth: number, maxLines = 2): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ").filter(Boolean)) {
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

/** Width of `text` in cells. */
export function textWidth(text: string): number {
  return text.length === 0 ? 0 : text.length * (GLYPH_W + GAP) - GAP;
}

/** Draw `text` with its top-left at (x, y), one cell per font pixel. */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
): void {
  ctx.fillStyle = color;
  let left = Math.round(x);
  const top = Math.round(y);
  for (const ch of text) {
    glyphOf(ch).forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++) {
        if (row[dx] === "#") ctx.fillRect(left + dx, top + dy, 1, 1);
      }
    });
    left += GLYPH_W + GAP;
  }
}
