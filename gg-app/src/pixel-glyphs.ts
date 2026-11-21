// 1-bit pixel glyphs ("#" is ink, "." is clear) shared by the critter world's
// name tags (critter-art.ts) and the activity bar's lead well. Kept apart from
// critter-art so the chat's status row doesn't load the critter art to draw them.

export const CRITTER_ICONS = {
  read: ["###.###", "#.###.#", "#.#.#.#", "#.###.#", "###.###", "...#..."],
  search: [".###...", "#...#..", "#...#..", "#...#..", ".####..", ".....#.", "......#"],
  edit: [".....##", "....###", "...###.", "..###..", ".###...", "##.....", "#......"],
  run: ["#......", ".#.....", "..#....", ".#.....", "#..####"],
  web: [".#####.", "#.#.#.#", "#######", "#.#.#.#", "#######", "#.#.#.#", ".#####."],
  think: [".####..", "#....#.", "#....#.", ".####..", ".#.....", "#......"],
  idle: ["..#.#..", ".#.#...", ".......", "#####.#", "#####.#", ".###.#.", ".###..."],
  ask: ["#######", "##...##", "#.#.#.#", "#..#..#", "#######"],
  done: ["......#", ".....##", "#...##.", "##.##..", ".###...", "..#...."],
  fail: ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
  play: ["..#..", "#####", ".###.", ".#.#.", "#...#"],
} as const;

/** One glyph for every kind of step the activity bar can show. At most 7×7. */
export const ACTIVITY_GLYPHS = {
  idle: CRITTER_ICONS.idle,
  start: ["#....", "###..", "#####", "###..", "#...."],
  work: ["..#.#..", ".#####.", "##...##", ".#...#.", "##...##", ".#####.", "..#.#.."],
  think: CRITTER_ICONS.think,
  write: ["#######", ".......", "######.", ".......", "#######", ".......", "####..."],
  read: CRITTER_ICONS.read,
  edit: CRITTER_ICONS.edit,
  web: CRITTER_ICONS.web,
  run: CRITTER_ICONS.run,
  check: [".#####.", "..#.#..", "..#.#..", ".#...#.", "#######", "#######", ".#####."],
  inspect: ["#######", "#######", "#.....#", "#.....#", "#.....#", "#######"],
  debug: [".#...#.", "..###..", "#.###.#", ".#####.", "#.###.#", ".#####.", "#.###.#"],
  agents: ["##...##", "##...##", "..#.#..", "...#...", "..#.#..", "##...##", "##...##"],
  background: ["#####", ".###.", "..#..", ".#.#.", "#####"],
  review: ["..###..", ".#.#.#.", "#.###.#", ".#.#.#.", "..###.."],
  plan: ["#.#####", ".......", "#.#####", ".......", "#.####.", ".......", "#.###.."],
  context: ["#######", "#######", ".#...#.", ".#.#.#.", ".#...#.", ".#####."],
  retry: ["..###.#", ".#...##", "#...###", "#......", "#.....#", ".#...#.", "..###.."],
  reconnect: [".#####.", "#.....#", "..###..", ".#...#.", "...#..."],
  stop: ["#####", "#####", "#####", "#####", "#####"],
  ask: [".###.", "#...#", "...#.", "..#..", ".....", "..#.."],
  done: CRITTER_ICONS.done,
  warn: ["##", "##", "##", "##", "..", "##"],
  fail: CRITTER_ICONS.fail,
} as const satisfies Record<string, readonly string[]>;

export type ActivityGlyphName = keyof typeof ACTIVITY_GLYPHS;

/** The glyph's ink as one SVG path, a unit square per "#". */
export function glyphPath(rows: readonly string[]): string {
  let d = "";
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "#") d += `M${x} ${y}h1v1h-1z`;
  });
  return d;
}
