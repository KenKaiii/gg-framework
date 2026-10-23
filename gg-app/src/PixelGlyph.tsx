/**
 * Small pixel icons for Ken's status pill, drawn the way GG Royale draws its
 * UI glyphs: on a 9×9 grid, one solid colour (the pill's tone ink, through
 * `currentColor`) and its shadow tone a step darker under each stroke, so a
 * glyph reads as a stamped, raised mark rather than a hairline vector. Shown
 * at whole multiples of the grid with crisp edges.
 */

import type { KenStatusIcon } from "./goal-ken-status";

/** "#" the glyph, "s" its drop shadow (drawn at 55% of the ink). */
const GLYPHS: Readonly<Record<KenStatusIcon | "clock", readonly string[]>> = {
  // An open book: two pages, a spine down the middle.
  read: [
    ".........",
    ".##...##.",
    "#..#.#..#",
    "#..#.#..#",
    "#..#.#..#",
    "#..###..#",
    ".##.#.##.",
    "....s....",
    ".........",
  ],
  // A magnifier: a ring and its handle.
  search: [
    ".........",
    "..###....",
    ".#...#...",
    ".#...#...",
    ".#...#...",
    "..####...",
    ".....##..",
    "......##.",
    ".......s.",
  ],
  // A pencil, point down to the left.
  edit: [
    ".........",
    "......##.",
    ".....#.##",
    "....#.##.",
    "...#.##..",
    "..#.##...",
    ".###s....",
    ".##s.....",
    ".........",
  ],
  // A terminal: a window with a prompt and cursor.
  run: [
    ".........",
    "#########",
    "#.......#",
    "#.#.....#",
    "#..#....#",
    "#.#..##.#",
    "#.......#",
    "#########",
    ".sssssss.",
  ],
  // A globe: a circle, its equator and a meridian.
  web: [
    ".........",
    "...###...",
    "..#.#.#..",
    ".#..#..#.",
    ".#######.",
    ".#..#..#.",
    "..#.#.#..",
    "...###...",
    "....s....",
  ],
  // A light bulb.
  think: [
    "...###...",
    "..#...#..",
    ".#.....#.",
    ".#.....#.",
    "..#...#..",
    "...#.#...",
    "...###...",
    "...###...",
    "....s....",
  ],
  // A speech bubble with three dots.
  ask: [
    ".........",
    ".#######.",
    "#.......#",
    "#.#.#.#.#",
    "#.......#",
    ".####.##.",
    "....##...",
    "....#s...",
    ".........",
  ],
  // Three heads.
  delegate: [
    ".........",
    "...##....",
    ".#.##.#..",
    "#.#..#.#.",
    "..####...",
    "#######..",
    "#.###.#..",
    ".sssss...",
    ".........",
  ],
  // An hourglass.
  wait: [
    ".#######.",
    "..#...#..",
    "..#...#..",
    "...#.#...",
    "....#....",
    "...#.#...",
    "..#.#.#..",
    ".#######.",
    "..sssss..",
  ],
  // Pause: two bars.
  paused: [
    ".........",
    "..##.##..",
    "..##.##..",
    "..##.##..",
    "..##.##..",
    "..##.##..",
    "..##.##..",
    "...s..s..",
    ".........",
  ],
  // Warning: a circle with a bang.
  error: [
    "...###...",
    "..#...#..",
    ".#..#..#.",
    "#...#...#",
    "#...#...#",
    "#.......#",
    ".#..#..#.",
    "..#...#..",
    "...###...",
  ],
  // A tick in a circle.
  done: [
    "...###...",
    "..#...#..",
    ".#.....#.",
    "#.....#.#",
    "#.#..#..#",
    "#..##...#",
    ".#.....#.",
    "..#...#..",
    "...###...",
  ],
  // A cup with steam.
  idle: [
    "..#..#...",
    ".#..#....",
    "..#..#...",
    ".........",
    "#######..",
    "#.....###",
    "#.....#.#",
    ".#####.#.",
    "..sssss..",
  ],
  clock: [
    "...###...",
    "..#...#..",
    ".#..#..#.",
    "#...#...#",
    "#...##..#",
    "#.......#",
    ".#.....#.",
    "..#...#..",
    "...###...",
  ],
};

/** A glyph from GLYPHS as an inline SVG, its pixels in `currentColor`. */
export function PixelGlyph({
  name,
  size = 9,
}: {
  readonly name: KenStatusIcon | "clock";
  /** Rendered size in CSS px: keep it a multiple of 9 so pixels stay square. */
  readonly size?: number;
}): React.ReactElement {
  const rows = GLYPHS[name];
  const ink: string[] = [];
  const shade: string[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c === "#") ink.push(`M${x} ${y}h1v1h-1z`);
      else if (c === "s") shade.push(`M${x} ${y}h1v1h-1z`);
    }
  });
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 9 9"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <path d={shade.join("")} fill="currentColor" opacity="0.55" />
      <path d={ink.join("")} fill="currentColor" />
    </svg>
  );
}
