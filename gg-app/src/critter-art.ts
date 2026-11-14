// Pixel art for the critter stage (critter-stage.ts) and the Goal farm's
// extras: the saucer, the monster, things carried, worn and said. Authored as
// fill maps, then outlined and lit by critter-shade.ts like the critters'
// props, so it all sits in the same light. Colours are art, not theme roles.

import {
  INK_COLOR,
  renderColorGrid,
  shadeGrid,
  type Material,
  type ShadedGrid,
} from "./critter-shade";

export interface Art {
  readonly url: string;
  // Size in art cells (outline included).
  readonly w: number;
  readonly h: number;
  readonly grid: ShadedGrid;
}

type Pal = Readonly<Record<string, string>>;
type Mats = Readonly<Record<string, Material>>;

export class Grid {
  readonly c: string[][];
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.c = Array.from({ length: h }, () => Array.from({ length: w }, () => "."));
  }
  set(x: number, y: number, ch: string): this {
    const row = this.c[Math.round(y)];
    const xi = Math.round(x);
    if (row && xi >= 0 && xi < this.w) row[xi] = ch;
    return this;
  }
  get(x: number, y: number): string {
    return this.c[y]?.[x] ?? ".";
  }
  rect(x: number, y: number, w: number, h: number, ch: string): this {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, ch);
    return this;
  }
  // Filled ellipse; `keep` limits it to rows where keep(y) is true.
  ellipse(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    ch: string,
    keep?: (x: number, y: number) => boolean,
  ): this {
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1 && (!keep || keep(x, y))) this.set(x, y, ch);
      }
    return this;
  }
  line(x0: number, y0: number, x1: number, y1: number, ch: string): this {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) this.set(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, ch);
    return this;
  }
  // Stamp rows at (x, y); "." leaves what's there, "_" clears.
  put(x: number, y: number, rows: readonly string[]): this {
    rows.forEach((row, j) =>
      [...row].forEach((ch, i) => {
        if (ch !== ".") this.set(x + i, y + j, ch === "_" ? "." : ch);
      }),
    );
    return this;
  }
  rows(): string[] {
    return this.c.map((r) => r.join(""));
  }
}

function outlined(rows: readonly string[], thin = ""): string[] {
  const w = Math.max(...rows.map((r) => r.length)) + 2;
  const h = rows.length + 2;
  const at = (x: number, y: number): string => rows[y - 1]?.[x - 1] ?? ".";
  const out: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) {
      const k = at(x, y);
      if (k !== ".") row += k;
      else
        row += [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)].some(
          (n) => n !== "." && !thin.includes(n),
        )
          ? "O"
          : ".";
    }
    out.push(row);
  }
  return out;
}

export function make(
  src: readonly string[] | Grid,
  palette: Pal,
  materials: Mats = {},
  opts: { outline?: boolean; seed?: number; relief?: number; thin?: string } = {},
): Art {
  const raw = src instanceof Grid ? src.rows() : [...src];
  const width = Math.max(...raw.map((r) => r.length));
  const even = raw.map((r) => r.padEnd(width, "."));
  const rows = opts.outline === false ? even : outlined(even, opts.thin);
  const grid = shadeGrid({
    rows,
    palette: { O: "#000", ...palette },
    materials,
    seed: opts.seed ?? 7,
    relief: opts.relief ?? 1,
  });
  const w = rows[0]?.length ?? 0;
  const h = rows.length;
  return { url: renderColorGrid(grid, { width: w, height: h }), w, h, grid };
}

// Flat one-colour glyph (emotes, tag icons): "#" is ink.
function glyph(rows: readonly string[], color: string, extra: Pal = {}): Art {
  const w = Math.max(...rows.map((r) => r.length));
  const grid: ShadedGrid = rows.map((r) =>
    [...r.padEnd(w, ".")].map((ch) =>
      ch === "." ? null : ch === "#" ? color : (extra[ch] ?? color),
    ),
  );
  return { url: renderColorGrid(grid, { width: w, height: rows.length }), w, h: rows.length, grid };
}

const INK = INK_COLOR;

// ── The saucer ──
function ufo(frame: 0 | 1): Art {
  const g = new Grid(26, 13);
  g.ellipse(13, 6, 6, 6, "G", (_x, y) => y <= 6);
  g.ellipse(13, 5.2, 2.6, 2.4, "a", (_x, y) => y <= 6);
  g.set(12, 5, "K").set(14, 5, "K");
  g.set(13, 2, "a").set(13, 1, "t");
  g.ellipse(13, 8.6, 12.6, 3.4, "D");
  g.ellipse(13, 7.6, 12.6, 2.7, "S");
  g.rect(4, 7, 18, 1, "s");
  for (let i = 0; i < 6; i++) g.set(3 + i * 4, 8, (i + frame) % 2 ? "Y" : "R");
  g.rect(10, 11, 6, 1, "E");
  return make(
    g,
    {
      G: "rgba(170,225,255,0.55)",
      a: "#7be04a",
      t: "#ff4f8b",
      K: "#10201a",
      S: "#c3cbe0",
      s: "#e8edf8",
      D: "#6b7390",
      Y: "#ffe14d",
      R: "#ff5a6e",
      E: "#7df9ff",
    },
    {
      G: "glass",
      S: "metal",
      s: "metal",
      D: "metal",
      Y: "glow",
      R: "glow",
      E: "glow",
      a: "skin",
      t: "glow",
    },
  );
}

// ── The monster: big, round, more hungry than scary ──
function monster(frame: 0 | 1, face: "roar" | "shut" | "hurt" = "roar"): Art {
  const g = new Grid(30, 28);
  // Horns.
  g.put(3, 0, [".HH...", "HHH...", "HHHH..", ".HHHH.", "..HHHH"]);
  g.put(21, 0, ["...HH.", "...HHH", "..HHHH", ".HHHH.", "HHHH.."]);
  // Arms up, claws out.
  g.ellipse(2.5, 12 - frame, 2.5, 3.5, "P");
  g.ellipse(26.5, 12 - (1 - frame), 2.5, 3.5, "P");
  g.put(0, 8 - frame, ["w.w.w"]);
  g.put(25, 8 - (1 - frame), ["w.w.w"]);
  // Body and belly.
  g.ellipse(14.5, 15, 12, 11.5, "P");
  g.ellipse(14.5, 21, 7.5, 5, "L");
  // Fur spots.
  for (const [x, y] of [
    [6, 12],
    [22, 11],
    [5, 19],
    [24, 18],
    [9, 6],
    [20, 6],
  ] as const)
    g.set(x, y, "d").set(x + 1, y + 1, "d");
  // Eyes: whites, pupils leaning in, angry brows.
  if (face === "hurt") {
    // Squeezed shut, and a wobbly mouth.
    g.put(7, 9, ["KK...", "..KK.", "..KK.", "KK..."]);
    g.put(18, 9, ["...KK", ".KK..", ".KK..", "...KK"]);
    g.put(8, 17, ["m..mm..mm..mm.", ".mm..mm..mm..m"]);
  } else {
    g.rect(7, 9, 5, 4, "w").rect(18, 9, 5, 4, "w");
    g.rect(10, 10, 2, 3, "K").rect(18, 10, 2, 3, "K");
    g.put(6, 7, ["dd....", "..dd..", "....dd"]);
    g.put(18, 7, ["....dd", "..dd..", "dd...."]);
  }
  // Mouth, teeth.
  if (face === "hurt") {
    // Drawn above.
  } else if (face === "roar") {
    g.rect(8, 15, 14, 6, "m");
    g.rect(11, 19, 8, 2, "T");
    for (let x = 8; x < 22; x += 2) g.set(x, 15, "w").set(x + 1, 20, "w");
    g.rect(9, 15, 2, 2, "w").rect(19, 15, 2, 2, "w");
  } else {
    g.rect(8, 17, 14, 1, "m");
    g.rect(9, 16, 2, 2, "w").rect(19, 16, 2, 2, "w");
  }
  // Feet step.
  g.rect(6 - frame, 25 + frame, 7, 3 - frame, "d");
  g.rect(17 + frame, 26 - frame, 7, 2 + frame, "d");
  return make(
    g,
    {
      P: "#8e5bd9",
      L: "#d9c2ff",
      d: "#5a2f9c",
      H: "#ffe9b8",
      w: "#ffffff",
      K: "#1e0c1f",
      m: "#5a1030",
      T: "#ff6b8e",
    },
    { H: "skin", w: "flat", m: "flat", T: "flat" },
    { seed: 41 },
  );
}

// ── The big bird: carries things in and out ──
function bird(frame: 0 | 1): Art {
  const g = new Grid(26, 16);
  g.ellipse(11, 9, 7, 3.6, "B");
  g.ellipse(19, 6, 3, 3, "B");
  g.rect(22, 6, 4, 1, "A").rect(22, 7, 2, 1, "A");
  g.set(20, 5, "K");
  g.put(1, 7, ["BB..", "BBBB", ".BBB"]);
  if (frame === 0) g.put(6, 1, ["...WW...", "..WWWW..", ".WWWWWW.", "WWWWWWWW", ".WWWWWW."]);
  else g.put(5, 9, ["WWWWWWWW", ".WWWWWWW", "..WWWWW.", "...WWW..", "....W..."]);
  g.rect(9, 12, 1, 3, "A").rect(13, 12, 1, 3, "A");
  g.put(8, 15, ["AAA"]).put(12, 15, ["AAA"]);
  return make(
    g,
    { B: "#f4f1ea", W: "#9fb4d9", A: "#ffa53a", K: "#1e0c1f" },
    { A: "skin", K: "flat" },
    { seed: 9 },
  );
}

function parachute(): Art {
  const g = new Grid(22, 17);
  g.ellipse(10.5, 9, 10.4, 9, "R", (x, y) => y <= 8 && (y < 8 || x % 5 !== 0));
  for (let y = 0; y <= 8; y++)
    for (let x = 0; x < 22; x++)
      if (g.get(x, y) === "R" && Math.floor((x + 2) / 5) % 2) g.set(x, y, "W");
  g.line(1, 9, 9, 16, "o").line(20, 9, 12, 16, "o").line(10.5, 9, 10.5, 16, "o");
  return make(
    g,
    { R: "#ff6b60", W: "#fff6e6", o: INK },
    { R: "cloth", W: "cloth", o: "flat" },
    { thin: "o" },
  );
}

function balloon(color: string): Art {
  const g = new Grid(11, 22);
  g.ellipse(5, 5.5, 5, 5.6, "R");
  g.put(4, 11, ["RRR", ".R."]);
  g.line(5, 13, 5, 21, "o");
  return make(g, { R: color, o: INK }, { R: "gel", o: "flat" }, { thin: "o" });
}

function eggGrid(): Grid {
  const g = new Grid(13, 15);
  g.ellipse(6, 8, 6, 7, "E");
  for (const [x, y] of [
    [3, 5],
    [8, 4],
    [9, 9],
    [4, 10],
    [6, 7],
  ] as const)
    g.set(x, y, "S").set(x + 1, y, "S");
  return g;
}
const EGG_PAL = { E: "#fff3d6", S: "#ffb86b" };
function eggHalf(top: boolean): Art {
  const g = eggGrid();
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      const cut = 7 + (x % 4 < 2 ? 0 : 1);
      if (top ? y >= cut : y < cut) g.set(x, y, ".");
    }
  return make(g, EGG_PAL, { E: "skin", S: "skin" });
}

function mound(): Art {
  const g = new Grid(18, 6);
  g.ellipse(8.5, 6, 8.5, 6, "D", (_x, y) => y <= 5);
  g.ellipse(8.5, 1.4, 4, 1.6, "K");
  for (const [x, y] of [
    [3, 4],
    [12, 3],
    [14, 5],
    [6, 5],
  ] as const)
    g.set(x, y, "d");
  return make(g, { D: "#8a5a3a", d: "#5e3b26", K: "#2a1810" }, { K: "flat" });
}

function hole(): Art {
  const g = new Grid(20, 5);
  g.ellipse(9.5, 2, 9.6, 2.4, "d");
  g.ellipse(9.5, 2.3, 8, 1.6, "K");
  return make(g, { d: "#5e3b26", K: "#150b10" }, { K: "flat", d: "flat" }, { outline: false });
}

function log(): Art {
  const g = new Grid(8, 14);
  g.rect(0, 1, 8, 13, "H");
  g.ellipse(3.5, 1.5, 4, 1.6, "h");
  g.set(3, 1, "H").set(4, 1, "H");
  g.rect(2, 6, 1, 3, "d").rect(5, 9, 1, 3, "d");
  return make(g, { H: "#9a6434", h: "#e2b77a", d: "#6b4322" }, {}, { seed: 3 });
}

function gift(): Art {
  return make(
    [
      "..YY.YY..",
      "..YYYYY..",
      "RRRRYRRRR",
      "RRRRYRRRR",
      "YYYYYYYYY",
      "RRRRYRRRR",
      "RRRRYRRRR",
      "RRRRYRRRR",
    ],
    { R: "#ff5a6e", Y: "#ffe14d" },
    { R: "cloth", Y: "cloth" },
  );
}

function ball(): Art {
  const g = new Grid(9, 9);
  g.ellipse(4, 4, 4.4, 4.4, "W");
  g.ellipse(4, 4, 4.4, 4.4, "R", (x, y) => x + y < 6);
  g.ellipse(4, 4, 4.4, 4.4, "B", (x, y) => x - y > 2);
  g.ellipse(4, 4, 4.4, 4.4, "Y", (x, y) => y - x > 2 && x + y > 9);
  return make(
    g,
    { W: "#ffffff", R: "#ff5a6e", B: "#4aa3ff", Y: "#ffe14d" },
    { W: "gel", R: "gel", B: "gel", Y: "gel" },
  );
}

function cloud(): Art {
  const g = new Grid(22, 9);
  g.ellipse(6, 5, 5.5, 3.6, "c").ellipse(12, 3.6, 6, 3.8, "c").ellipse(17, 5.4, 4.5, 3.2, "c");
  g.rect(2, 6, 18, 2, "c");
  g.rect(3, 8, 16, 1, "d");
  return make(g, { c: "#8d93a6", d: "#5d6578" }, { c: "glow", d: "flat" });
}

function sack(): Art {
  const g = new Grid(11, 11);
  g.ellipse(5, 6.5, 5, 4.4, "C");
  g.put(3, 0, ["C...C", ".C.C.", "..C..", ".CCC."]);
  g.set(4, 7, "c").set(7, 5, "c").set(3, 5, "c");
  return make(g, { C: "#f4ecd8", c: "#c9b78f" }, { C: "cloth" });
}

function lantern(): Art {
  const g = new Grid(9, 12);
  g.rect(1, 1, 7, 9, "P");
  g.rect(0, 2, 9, 7, "P");
  g.rect(2, 0, 5, 1, "w").rect(2, 10, 5, 1, "w");
  g.rect(3, 4, 3, 4, "F");
  g.set(4, 11, "F");
  return make(g, { P: "#ff9a5c", w: "#8a4a40", F: "#ffe9a8" }, { P: "glow", F: "glow", w: "flat" });
}

// ── Landmarks: the tall things on each terrain's horizon ──
const LAND_PAL: Pal = {
  G: "#4a9a3f",
  g: "#2f6a30",
  H: "#8a5a3a",
  h: "#5e3b26",
  P: "#f29ac0",
  R: "#ff5a6e",
  W: "#fff6e6",
  S: "#b8c4d8",
  r: "#9aa0aa",
  Y: "#f2c14e",
  C: "#8fdcff",
  w: "#f4f8ff",
  K: "#1e0c1f",
  A: "#ffa53a",
  D: "#1f6a4a",
};
const LAND_MATS: Mats = {
  S: "metal",
  Y: "metal",
  C: "glass",
  K: "flat",
  w: "gel",
  R: "cloth",
  W: "cloth",
};
function landmarks(): Record<string, Art[]> {
  const tree = new Grid(14, 19);
  tree.rect(6, 11, 2, 8, "H");
  tree.ellipse(6.5, 6.5, 6.6, 6.4, "G");
  for (const [x, y] of [
    [3, 5],
    [8, 3],
    [9, 8],
    [5, 9],
    [10, 6],
  ] as const)
    tree.set(x, y, "g").set(x + 1, y, "g");
  const bush = new Grid(12, 7);
  bush.ellipse(5.5, 5, 5.6, 4.4, "G", (_x, y) => y <= 6);
  bush.set(3, 3, "P").set(8, 2, "P").set(6, 4, "W");
  const palm = new Grid(18, 22);
  for (let i = 0; i <= 14; i++) palm.rect(8 + Math.round(Math.sin(i / 5) * 1.5), 7 + i, 2, 1, "H");
  for (const [dx, dy] of [
    [-8, 3],
    [-6, -4],
    [0, -6],
    [6, -4],
    [8, 3],
  ] as const) {
    palm.line(9, 6, 9 + dx, 6 + dy, "G");
    palm.line(9, 7, 9 + dx, 7 + dy, "G");
  }
  palm.set(8, 8, "h").set(10, 8, "h");
  const umbrella = new Grid(15, 13);
  umbrella.ellipse(7, 6, 7.2, 6, "R", (_x, y) => y <= 5);
  for (let y = 0; y <= 5; y++)
    for (let x = 0; x < 15; x++)
      if (umbrella.get(x, y) === "R" && Math.floor(x / 3) % 2) umbrella.set(x, y, "W");
  umbrella.rect(7, 6, 1, 7, "S");
  const cactus = new Grid(11, 17);
  cactus.rect(4, 2, 3, 15, "G").rect(5, 1, 1, 1, "G");
  cactus.rect(0, 6, 2, 5, "G").rect(1, 10, 3, 2, "G");
  cactus.rect(9, 4, 2, 6, "G").rect(7, 9, 3, 2, "G");
  cactus.set(5, 0, "P").set(5, 5, "g").set(5, 9, "g").set(5, 13, "g");
  const rock = new Grid(11, 7);
  rock.ellipse(5, 5, 5.4, 4.6, "r", (_x, y) => y <= 6);
  const lander = new Grid(15, 15);
  lander.ellipse(7, 5.5, 4.6, 4, "Y");
  lander.rect(6, 4, 3, 2, "C").rect(4, 9, 7, 2, "S");
  lander.line(4, 10, 1, 14, "S").line(10, 10, 13, 14, "S");
  lander.rect(0, 14, 3, 1, "S").rect(12, 14, 3, 1, "S").rect(7, 0, 1, 2, "S");
  const flag = new Grid(8, 13);
  flag.rect(0, 0, 1, 13, "S").rect(1, 0, 7, 5, "R").rect(1, 2, 7, 1, "W");
  const pine = new Grid(13, 20);
  [3, 5, 7, 9, 11, 13].forEach((w, i) => {
    pine.rect(6 - Math.floor(w / 2), 1 + i * 2 + (i > 2 ? i - 2 : 0), w, 3, "D");
  });
  pine.rect(5, 0, 3, 2, "w").rect(2, 7, 3, 1, "w").rect(8, 10, 4, 1, "w").rect(0, 15, 4, 1, "w");
  pine.rect(6, 17, 1, 3, "H");
  const snowman = new Grid(9, 14);
  snowman.ellipse(4, 10, 4.4, 3.8, "w").ellipse(4, 4, 3.2, 3.2, "w");
  snowman
    .set(3, 3, "K")
    .set(5, 3, "K")
    .set(4, 5, "A")
    .set(5, 5, "A")
    .rect(1, 7, 7, 1, "R")
    .set(4, 10, "K")
    .set(4, 12, "K");
  const m = (g: Grid, seed: number): Art => make(g, LAND_PAL, LAND_MATS, { seed });
  return {
    meadow: [m(tree, 1), m(bush, 2)],
    beach: [m(palm, 3), m(umbrella, 4)],
    desert: [m(cactus, 5), m(rock, 6)],
    space: [m(lander, 7), m(flag, 8)],
    snow: [m(pine, 9), m(snowman, 10)],
  };
}

// ── Things worn ──
const HAT_PAL: Pal = {
  Y: "#ffd23f",
  R: "#ff5a6e",
  B: "#4aa3ff",
  G: "#6cbf52",
  P: "#f29ac0",
  W: "#fff6e6",
  S: "#e9c98a",
  s: "#b98d4f",
  H: "#8a5a3a",
  h: "#5e3b26",
  T: "#2ac8d0",
  t: "#ffffff",
  K: "#1e0c1f",
  V: "rgba(190,235,255,0.28)",
  v: "rgba(255,255,255,0.75)",
};
const HAT_MATS: Mats = { Y: "metal", V: "glass", v: "flat", K: "flat" };
const HATS = {
  crown: ["Y.Y.Y.Y", "YYYYYYY", "YRYBYRY", "YYYYYYY"],
  party: ["..t..", "..R..", ".RYR.", ".YRY.", "RYRYR", "YRYRY"],
  flowers: [".P..Y..P..", "PWPYRYPWP.", "GPGGYGGPGG"],
  straw: ["...SSSSSS...", "..SSSSSSSS..", "..RRRRRRRR..", "SSSSSSSSSSSS"],
  cowboy: ["...HHHHHH...", "..HHHHHHHH..", "..hhhhhhhh..", "H.HHHHHHHH.H", "HHHHHHHHHHHH"],
  beanie: ["...tt...", "..TTTT..", ".TTTTTT.", "TTTTTTTT", "tttttttt"],
  shades: ["KKKKK.KKKKK", "KvKKKKKvKKK", ".KKK...KKK."],
} as const;
export type HatName = keyof typeof HATS | "helmet";

function helmet(): Art {
  const g = new Grid(24, 22);
  g.ellipse(11.5, 10.5, 11.6, 10.6, "V");
  g.put(4, 3, ["..vv", ".v..", "v..."]);
  return make(g, HAT_PAL, HAT_MATS);
}

// ── Emotes (in a little paper bubble) and tag icons ──
const EMOTES = {
  "!": ["##", "##", "##", "##", "..", "##"],
  "?": [".###.", "#...#", "...#.", "..#..", ".....", "..#.."],
  heart: [".#.#.", "#####", "#####", ".###.", "..#.."],
  zz: ["####...", "..#....", ".#..###", "####.#.", "....###"],
  note: ["..###", "..#.#", "..#..", "###..", "###.."],
  ok: ["....#", "...##", "#.##.", "###..", ".#..."],
  no: ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
  sweat: ["..#..", ".###.", "#####", "#####", ".###."],
  anger: ["#.#..", ".....", "#.#.#", "....", "..#.#"],
  bulb: [".###.", "#####", "#####", ".###.", ".#.#.", "..#.."],
  star: ["..#..", "#####", ".###.", ".#.#.", "#...#"],
  rock: [".###.", "#####", "#####", "#####", ".###."],
  paper: ["#####", "#...#", "#.#.#", "#...#", "#####"],
  scissors: ["#...#", ".#.#.", "..#..", "##.##", "##.##"],
  dots: [".....", ".....", "#.#.#"],
  skull: [".###.", "#.#.#", "#####", ".#.#."],
} as const;
export type EmoteName = keyof typeof EMOTES;
const EMOTE_COLOR: Partial<Record<EmoteName, string>> = {
  heart: "#e0364f",
  ok: "#2f8f4e",
  no: "#c8323c",
  sweat: "#3a8fd9",
  anger: "#c8323c",
  bulb: "#c98a10",
  star: "#c98a10",
  note: "#6a3fc0",
};

const ICONS = {
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
export type IconName = keyof typeof ICONS;

export interface ArtSet {
  readonly ufo: readonly [Art, Art];
  readonly monster: readonly [Art, Art];
  readonly monsterShut: Art;
  readonly monsterHurt: readonly [Art, Art];
  readonly bird: readonly [Art, Art];
  readonly parachute: Art;
  readonly balloons: readonly Art[];
  readonly egg: Art;
  readonly eggTop: Art;
  readonly eggBottom: Art;
  readonly mound: Art;
  readonly hole: Art;
  readonly log: Art;
  readonly gift: Art;
  readonly ball: Art;
  readonly cloud: Art;
  readonly sack: Art;
  readonly lantern: Art;
  readonly daikon: Art;
  readonly landmarks: Readonly<Record<string, readonly Art[]>>;
  readonly hats: Readonly<Record<HatName, Art>>;
  readonly emotes: Readonly<Record<EmoteName, Art>>;
  readonly icons: Readonly<Record<IconName, Art>>;
}

// Each piece is drawn the first time it's asked for: a chat that never has a
// saucer over it never pays for one.
const MAKERS: { readonly [K in keyof ArtSet]: () => ArtSet[K] } = {
  ufo: () => [ufo(0), ufo(1)],
  monster: () => [monster(0), monster(1)],
  monsterShut: () => monster(0, "shut"),
  monsterHurt: () => [monster(0, "hurt"), monster(1, "hurt")],
  bird: () => [bird(0), bird(1)],
  parachute,
  balloons: () => ["#ff5a6e", "#4aa3ff", "#ffd23f", "#6cbf52", "#f29ac0"].map(balloon),
  egg: () => make(eggGrid(), EGG_PAL, { E: "skin", S: "skin" }),
  eggTop: () => eggHalf(true),
  eggBottom: () => eggHalf(false),
  mound,
  hole,
  log,
  gift,
  ball,
  cloud,
  sack,
  lantern,
  landmarks,
  daikon: () =>
    make(
      [".G.G.", "GGGGG", ".WWW.", ".WWW.", ".WWW.", "..W.."],
      { G: "#4a9a3f", W: "#fff6e6" },
      { W: "skin" },
    ),
  hats: () => ({
    ...(Object.fromEntries(
      (Object.keys(HATS) as (keyof typeof HATS)[]).map((k) => [
        k,
        make(HATS[k], HAT_PAL, HAT_MATS),
      ]),
    ) as Record<keyof typeof HATS, Art>),
    helmet: helmet(),
  }),
  emotes: () =>
    Object.fromEntries(
      (Object.keys(EMOTES) as EmoteName[]).map((k) => [k, glyph(EMOTES[k], EMOTE_COLOR[k] ?? INK)]),
    ) as Record<EmoteName, Art>,
  icons: () =>
    Object.fromEntries(
      (Object.keys(ICONS) as IconName[]).map((k) => [k, glyph(ICONS[k], INK)]),
    ) as Record<IconName, Art>,
};

let cached: ArtSet | null = null;
export function art(): ArtSet {
  if (cached) return cached;
  const set = {} as ArtSet;
  for (const key of Object.keys(MAKERS) as (keyof ArtSet)[]) {
    Object.defineProperty(set, key, {
      configurable: true,
      enumerable: true,
      get: () => {
        const made = MAKERS[key]();
        Object.defineProperty(set, key, { value: made, enumerable: true });
        return made;
      },
    });
  }
  cached = set;
  return cached;
}

// An art's pixels on a canvas (for the farm, which draws on one).
const canvases = new WeakMap<Art, HTMLCanvasElement>();
export function artCanvas(a: Art): HTMLCanvasElement {
  let cv = canvases.get(a);
  if (cv) return cv;
  cv = document.createElement("canvas");
  cv.width = a.w;
  cv.height = a.h;
  const ctx = cv.getContext("2d");
  if (ctx)
    a.grid.forEach((row, y) =>
      row.forEach((c, x) => {
        if (!c) return;
        ctx.fillStyle = c;
        ctx.fillRect(x, y, 1, 1);
      }),
    );
  canvases.set(a, cv);
  return cv;
}
