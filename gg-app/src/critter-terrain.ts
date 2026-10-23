// Pixel terrains the critters live on (home screen and chat). Each biome is:
//  - a ground strip (layered soil with seeded speckles, grass blades or ripples
//    on top) repeating along the bottom of the critter lane;
//  - props (flowers, shells, cacti, craters, pine trees…) laid out along a
//    wider, differently-periodic strip so the two don't line up into an obvious
//    tile. Each prop is its own sprite, so it can sprout from the surface (or,
//    in the sky, drift in) in order, and sway / twinkle / bob while it's out;
//  - optional weather (falling snow, drifting pollen or dust, sparkles) and
//    travelers that pass through now and then (a tumbleweed, a gull…).
// Same legend and renderer as the critter sprites: `.` is transparent,
// anything else is a palette key. Colours are art, not theme roles. All the
// timing lives in App.css; the constants below mirror it.

import { INK_COLOR, mixColor, renderColorGrid, shadeGrid, type ShadedGrid } from "./critter-shade";
import { hashKey } from "./critter-sprites";

/** Rows in the ground strip: open air on top, then ground. */
export const TERRAIN_ROWS = 20;
/** First ground row: the critters' feet stand on its top edge. */
export const TERRAIN_FLOOR_ROW = 12;
export const GROUND_COLS = 64;
/** Width of the strip the props are laid out on (it repeats across the lane). */
export const DECOR_COLS = 128;
/** CSS pixels per terrain cell (App.css --terrain-px). */
export const TERRAIN_PX = 2;
/** Most weather particles a lane gets, however wide. */
export const MAX_PARTICLES = 60;

/**
 * How long after a terrain lane starts opening the first critter beams in: once
 * the ground has risen (App.css: 40ms delay + 440ms ease-out, which is all but
 * settled by ~360ms), so the critter lands on solid ground as the props sprout.
 */
export const TERRAIN_LAND_MS = 360;
/**
 * How long a terrain lane stays open after its last critter leaves, so the
 * scenery can pack away in order (App.css: weather and sky out by ~320ms,
 * props sink by ~600ms, ground down by ~760ms) before the lane collapses.
 */
export const TERRAIN_CLOSE_MS = 780;

type Palette = Readonly<Record<string, string>>;
/** [palette key, share of cells] scattered over a base colour. */
type Speckle = readonly [string, number];

interface Layer {
  readonly base: string;
  readonly speckles?: readonly Speckle[];
}

/** Idle motion a prop plays while it's out (App.css .m-<motion>). */
export const PROP_MOTIONS = ["sway", "twinkle", "bob", "glow", "scuttle", "wave"] as const;
export type PropMotion = (typeof PROP_MOTIONS)[number];

export interface Prop {
  readonly stamp: readonly string[];
  /** Left column on the decor strip. */
  readonly x: number;
  /** Rows its bottom sits above the floor: 0 stands on it, more floats in the
   *  sky, less is sunk into the ground (a crater, a tide pool). */
  readonly lift: number;
  readonly motion: PropMotion | null;
}

function prop(
  stamp: readonly string[],
  x: number,
  lift = 0,
  motion: PropMotion | null = null,
): Prop {
  return { stamp, x, lift, motion };
}

export const WEATHER_KINDS = ["snow", "pollen", "dust", "sparkle"] as const;
export type WeatherKind = (typeof WEATHER_KINDS)[number];

export interface Weather {
  readonly kind: WeatherKind;
  readonly colors: readonly string[];
  /** Particles per 100px of lane width. */
  readonly density: number;
}

/** How a traveler moves: flutter (butterfly), glide (gull), roll (tumbleweed),
 *  streak (shooting star). */
export const TRAVELER_KINDS = ["flutter", "glide", "roll", "streak"] as const;
export type TravelerKind = (typeof TRAVELER_KINDS)[number];

export interface Traveler {
  readonly kind: TravelerKind;
  readonly stamp: readonly string[];
  /** Seconds per loop; the crossing takes the first part of it. */
  readonly period: number;
  /** Seconds after the scenery is set before its first pass. */
  readonly delay: number;
  /** Rows above the floor it travels at. */
  readonly lift: number;
}

export interface Biome {
  readonly id: string;
  readonly name: string;
  readonly palette: Palette;
  /** One per ground row, top down; TERRAIN_ROWS − TERRAIN_FLOOR_ROW of them. */
  readonly layers: readonly Layer[];
  /** Sparse bits poking up from the surface (grass blades, sand ripples). */
  readonly tufts?: readonly Speckle[];
  readonly decor: readonly Prop[];
  readonly weather?: Weather;
  readonly travelers?: readonly Traveler[];
}

// ── Meadow ──
const FLOWER_Y = [".Y.", "YoY", ".Y.", ".g."];
const FLOWER_K = [".K.", "KwK", ".K.", ".g."];
const MEADOW: Biome = {
  id: "meadow",
  name: "Meadow",
  palette: {
    G: "#6cbf52",
    g: "#4a9a3f",
    d: "#2f6a30",
    D: "#4a3324",
    E: "#33231a",
    P: "#6e5b4b",
    Y: "#f2d16b",
    o: "#e0734f",
    K: "#f29ac0",
    w: "#fff6e6",
    r: "#9aa0aa",
    R: "#727783",
    q: "#4f535c",
    M: "#e0574f",
    B: "#9ad4ff",
  },
  layers: [
    { base: "G", speckles: [["g", 0.15]] },
    {
      base: "g",
      speckles: [
        ["G", 0.12],
        ["d", 0.1],
      ],
    },
    {
      base: "d",
      speckles: [
        ["D", 0.3],
        ["g", 0.05],
      ],
    },
    { base: "D", speckles: [["d", 0.08]] },
    { base: "D", speckles: [["P", 0.05]] },
    { base: "D", speckles: [["E", 0.15]] },
    {
      base: "E",
      speckles: [
        ["D", 0.1],
        ["P", 0.03],
      ],
    },
    { base: "E" },
  ],
  tufts: [
    ["g", 0.14],
    ["d", 0.06],
  ],
  decor: [
    prop(FLOWER_Y, 6, 0, "sway"),
    prop(["g.g.g", "gdgdg"], 15, 0, "sway"),
    prop([".MMM.", "MwMwM", "..w.."], 26),
    prop(FLOWER_K, 38, 0, "sway"),
    prop([".gGg.", "gGGGg", "gGgGd", "gdgdd"], 47),
    prop([".rR.", "rRRq"], 57),
    prop(FLOWER_K, 63, 0, "sway"),
    prop([".Y.", "YoY", ".Y.", ".g.", "gg.", ".g."], 68, 0, "sway"),
    prop(["g.g", "gdg"], 95, 0, "sway"),
    prop(FLOWER_Y, 104, 0, "sway"),
    prop([".MM.", "MMwM", ".w..", "MMw."], 113),
    prop(["rq"], 122),
  ],
  weather: { kind: "pollen", colors: ["#f6e7a1", "#fff6e6", "#f7c2da"], density: 1.6 },
  travelers: [
    { kind: "flutter", stamp: ["KK.KK", "KwqwK", ".KqK."], period: 24, delay: 1.6, lift: 12 },
  ],
};

// ── Beach ──
const BEACH_CRAB = ["..O..", "OOOOO", ".OoO.", "O...O"];
const BEACH: Biome = {
  id: "beach",
  name: "Beach",
  palette: {
    S: "#f6e1ab",
    s: "#e9c98a",
    t: "#d2ad6c",
    T: "#b08c52",
    w: "#fffaf0",
    b: "#f4b0a2",
    O: "#f08a4b",
    o: "#c9612f",
    F: "#e85a55",
    p: "#8a6a4a",
    L: "#5bbf63",
    l: "#2f8048",
    k: "#a57446",
    j: "#7a5230",
    B: "#4aa8e6",
    A: "#7fd3f5",
  },
  layers: [
    {
      base: "S",
      speckles: [
        ["w", 0.06],
        ["s", 0.1],
      ],
    },
    { base: "S", speckles: [["s", 0.22]] },
    {
      base: "s",
      speckles: [
        ["S", 0.15],
        ["b", 0.02],
      ],
    },
    { base: "s", speckles: [["t", 0.15]] },
    {
      base: "s",
      speckles: [
        ["t", 0.3],
        ["w", 0.02],
      ],
    },
    { base: "t", speckles: [["s", 0.15]] },
    { base: "t", speckles: [["T", 0.2]] },
    { base: "T", speckles: [["t", 0.2]] },
  ],
  tufts: [["s", 0.05]],
  decor: [
    prop(BEACH_CRAB, 5, 0, "scuttle"),
    prop(
      [
        "...FwF...",
        ".FFwwwFF.",
        "FFFwwwFFF",
        "....p....",
        "....p....",
        "....p....",
        "....p....",
        "....p....",
      ],
      16,
    ),
    prop([".b.", "bwb", "bbb"], 31),
    prop(["...FF..", "...p...", "s.sss.s", "sssssss", "sStsStS", "sssssss"], 40),
    prop([".pp.", "p..p", "BBBB", "BwBB", ".BB."], 49),
    prop(["AAwA", "AAAA"], 58, -1),
    prop(
      [
        ".LL...LL.",
        "LLLL.LLLL",
        "L..LkL..L",
        "...lkl...",
        "....k....",
        "....j....",
        "....k....",
        "....j....",
        "....k....",
        "...kkk...",
      ],
      75,
      0,
      "sway",
    ),
    prop([".b.", "bwb", "bbb"], 86),
    prop(["w.b"], 92),
    prop(BEACH_CRAB, 101, 0, "scuttle"),
    prop([".b.", "bwb"], 112),
    prop(["AAAwA", "AAAAA"], 119, -1),
  ],
  travelers: [
    { kind: "glide", stamp: ["w.....w", ".ww.ww.", "...w..."], period: 19, delay: 1.4, lift: 26 },
    { kind: "glide", stamp: ["w...w", ".w.w.", "..w.."], period: 23, delay: 9, lift: 32 },
  ],
};

// ── Desert ──
const DESERT: Biome = {
  id: "desert",
  name: "Desert",
  palette: {
    S: "#efb26a",
    s: "#dd914d",
    t: "#bd703a",
    T: "#8f4e2a",
    c: "#63b052",
    C: "#3f7d3a",
    n: "#c4ec9a",
    F: "#ff86b0",
    Y: "#f6d36b",
    r: "#c27448",
    R: "#94512f",
    q: "#6e3a25",
    k: "#c39a5a",
    K: "#8c6a3a",
    w: "#f6ecd6",
  },
  layers: [
    { base: "S", speckles: [["s", 0.15]] },
    { base: "S", speckles: [["s", 0.3]] },
    {
      base: "s",
      speckles: [
        ["S", 0.1],
        ["t", 0.1],
      ],
    },
    { base: "s", speckles: [["t", 0.2]] },
    { base: "t", speckles: [["s", 0.15]] },
    { base: "t", speckles: [["T", 0.15]] },
    { base: "T", speckles: [["t", 0.2]] },
    { base: "T" },
  ],
  tufts: [["S", 0.05]],
  decor: [
    prop(
      [
        "...FF...",
        "...cc...",
        "..cncC..",
        "..cccC..",
        "c.cccC..",
        "c.cncC.c",
        "ccccCC.c",
        "..cccCcc",
        "..cncC..",
        "..cccC..",
        "..cccC..",
      ],
      8,
    ),
    prop([".rr..", "rRRrq", "RRqRq"], 24),
    prop([".F.", "FYF", ".c."], 33, 0, "sway"),
    prop([".cFc.", "cnccC", "ccncC", ".cCC."], 57),
    prop(["Y.Y", ".w."], 66, 9, "bob"),
    prop([".c..", ".c.c", "cccC"], 76),
    prop(["..cc..", ".cncC.", ".cccC.", "ccncCc", "c.ccCc", "..ccC.", "..ccC."], 88),
    prop([".F.", "FYF", ".c."], 101, 0, "sway"),
    prop(["..rr.", ".rRRq", "rRqRq"], 110),
  ],
  weather: { kind: "dust", colors: ["#f6d9a8", "#e9b77a"], density: 1.1 },
  travelers: [
    {
      kind: "roll",
      stamp: [".kKk.", "kK.Kk", "Kk.kK", ".kKk."],
      period: 15,
      delay: 1.4,
      lift: 0,
    },
  ],
};

// ── Space ──
const STAR = ["*"];
const DIM = ["+"];
const CRATER = ["c....c", "dxxxxd", ".dxxd."];
const SPACE: Biome = {
  id: "space",
  name: "Space",
  palette: {
    G: "#a59fd0",
    g: "#7d77ac",
    d: "#5d5889",
    D: "#433f68",
    E: "#2f2c4a",
    c: "#c7c1ee",
    x: "#322e4e",
    "*": "#ffffff",
    "+": "#9aa3e0",
    p: "#f29ac0",
    P: "#c06a92",
    R: "#f6d36b",
    F: "#e85a55",
    w: "#f4f4fa",
    m: "#b3bbcc",
    M: "#717a8e",
    z: "#86e6ff",
    Z: "#3aa6d0",
    a: "#ff6b6b",
  },
  layers: [
    { base: "G", speckles: [["c", 0.12]] },
    {
      base: "g",
      speckles: [
        ["G", 0.1],
        ["x", 0.05],
      ],
    },
    { base: "g", speckles: [["d", 0.2]] },
    {
      base: "d",
      speckles: [
        ["x", 0.1],
        ["g", 0.1],
      ],
    },
    { base: "d", speckles: [["D", 0.2]] },
    { base: "D", speckles: [["d", 0.1]] },
    { base: "D", speckles: [["E", 0.2]] },
    { base: "E" },
  ],
  tufts: [["c", 0.03]],
  decor: [
    prop(STAR, 3, 9, "twinkle"),
    prop(CRATER, 8, -2),
    prop(DIM, 14, 6, "twinkle"),
    prop(["mFFF", "mFwF", "mFFF", "m...", "m...", "m...", "M..."], 22, 0, "wave"),
    prop(STAR, 30, 10, "twinkle"),
    prop(["..ppp...", ".pppPP..", "RRRRRRRR", ".ppPPP..", "..PPP..."], 36, 5, "bob"),
    prop([".z..", ".zZ.", "zzZz", "zZZZ"], 50, 0, "glow"),
    prop(DIM, 57, 8, "twinkle"),
    prop(CRATER, 63, -2),
    prop(STAR, 7, 6, "twinkle"),
    prop(["....a", "....m", ".mmmm", "mMmMm", "w.w.w"], 79),
    prop(DIM, 88, 10, "twinkle"),
    prop(["..c.", ".cgd", "cgdd"], 95),
    prop(STAR, 101, 8, "twinkle"),
    prop(["dxxd", ".dd."], 108, -1),
    prop([".z.", "zZz"], 115, 0, "glow"),
    prop(DIM, 121, 5, "twinkle"),
  ],
  weather: { kind: "sparkle", colors: ["#ffffff", "#9aa3e0", "#f6d36b"], density: 1.4 },
  travelers: [
    {
      kind: "streak",
      stamp: ["+....", ".+...", "..+*.", "...**"],
      period: 8,
      delay: 2.2,
      lift: 30,
    },
  ],
};

// ── Snow ──
const PINE = [
  "...w...",
  "..wtT..",
  ".wttTT.",
  "..ttT..",
  ".wttTT.",
  "wtttTTT",
  "..ttT..",
  ".wttTTT",
  "wttttTT",
  "...k...",
];
const SNOW: Biome = {
  id: "snow",
  name: "Snow",
  palette: {
    G: "#f4f8ff",
    g: "#dde7f5",
    d: "#c0cee6",
    D: "#a3b4d4",
    E: "#8798bd",
    b: "#9fd6f4",
    t: "#3c8a5e",
    T: "#22603f",
    k: "#7a5236",
    w: "#ffffff",
    o: "#f08a4b",
    K: "#2a2a33",
    R: "#e85a55",
  },
  layers: [
    { base: "G", speckles: [["w", 0.1]] },
    { base: "G", speckles: [["g", 0.2]] },
    {
      base: "g",
      speckles: [
        ["G", 0.1],
        ["d", 0.1],
      ],
    },
    { base: "g", speckles: [["d", 0.2]] },
    {
      base: "d",
      speckles: [
        ["b", 0.05],
        ["g", 0.1],
      ],
    },
    { base: "d", speckles: [["D", 0.2]] },
    {
      base: "D",
      speckles: [
        ["d", 0.1],
        ["b", 0.05],
      ],
    },
    { base: "D", speckles: [["E", 0.2]] },
  ],
  tufts: [["G", 0.08]],
  decor: [
    prop(PINE, 6, 0, "sway"),
    prop([".KKK.", "KKKKK", ".GGG.", ".KGK.", ".GoG.", "RRRRR", "GGGGG", "GGKGG", "GGGGG"], 26),
    prop([".GG.", "GGGg"], 52),
    prop(PINE, 62, 0, "sway"),
    prop(PINE, 69, 0, "sway"),
    prop(["..GG..", ".GGGg.", "GGGggd"], 88),
    prop([".b.", "bbb"], 104),
    prop(PINE, 112, 0, "sway"),
  ],
  // Falling snow instead of flakes frozen in mid-air.
  weather: { kind: "snow", colors: ["#ffffff", "#e6f2ff", "#bfe3ff"], density: 3.2 },
};

export const BIOMES: readonly Biome[] = [MEADOW, BEACH, DESERT, SPACE, SNOW];

/** Seeded PRNG (mulberry32), so a biome's speckles are the same every time. */
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

function scatter(base: string, speckles: readonly Speckle[], roll: number): string {
  let edge = 0;
  for (const [key, share] of speckles) {
    edge += share;
    if (roll < edge) return key;
  }
  return base;
}

/** The ground strip: air rows (tufts on the last one), then the soil layers. */
export function groundRows(biome: Biome): string[] {
  const random = seeded(hashKey(`terrain:${biome.id}`));
  const rows: string[] = [];
  for (let y = 0; y < TERRAIN_ROWS; y++) {
    let row = "";
    for (let x = 0; x < GROUND_COLS; x++) {
      const layer = biome.layers[y - TERRAIN_FLOOR_ROW];
      if (layer) row += scatter(layer.base, layer.speckles ?? [], random());
      else if (y === TERRAIN_FLOOR_ROW - 1) row += scatter(".", biome.tufts ?? [], random());
      else row += ".";
    }
    rows.push(row);
  }
  return rows;
}

/** A 4×4 ordered (Bayer) dither threshold, 0–1. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;
const bayer = (x: number, y: number): number => ((BAYER[(y & 3) * 4 + (x & 3)] ?? 0) + 0.5) / 16;

/**
 * The ground strip as finished pixels, drawn the way GG Royale draws ground:
 * - the surface layer has a lit top edge and hangs over the soil below in a
 *   ragged lip (2–3 pixel clumps, as grass or packed sand overhangs), with a
 *   band of shadow under it;
 * - each soil layer meets the next in a dithered seam instead of a hard line,
 *   with its speckles kept for grain;
 * - a few stones sit in the deep soil, outlined and lit from the top left;
 * - the soil darkens towards the bottom, so the strip has depth;
 * - tufts above the surface stand 1–2 pixels tall with a lit tip.
 * Seeded per biome: the same strip every time, and it tiles (every feature
 * wraps round the strip's ends).
 */
export function paintGround(biome: Biome): ShadedGrid {
  const keys = groundRows(biome);
  const color = (k: string | undefined): string | null =>
    k === undefined || k === "." ? null : (biome.palette[k] ?? null);
  const random = seeded(hashKey(`ground:${biome.id}`));
  const W = GROUND_COLS;
  const out: (string | null)[][] = keys.map((row) => [...row].map((k) => color(k)));
  const layerColor = (i: number): string | null => {
    const layer = biome.layers[i];
    return layer ? color(layer.base) : null;
  };
  const top = TERRAIN_FLOOR_ROW;
  const set = (x: number, y: number, c: string | null): void => {
    const row = out[y];
    if (row && c) row[((x % W) + W) % W] = c;
  };
  const get = (x: number, y: number): string | null => out[y]?.[((x % W) + W) % W] ?? null;

  // Dithered seams: the top quarter of each layer's first row takes the
  // colour of the layer above through a Bayer pattern.
  for (let i = 1; i < biome.layers.length; i++) {
    const above = layerColor(i - 1);
    const here = layerColor(i);
    if (!above || !here || above === here) continue;
    const y = top + i;
    for (let x = 0; x < W; x++) if (bayer(x, y) < 0.32) set(x, y, above);
  }

  // Depth: the last rows darken.
  const rowsDown = TERRAIN_ROWS - top;
  for (let y = top; y < TERRAIN_ROWS; y++) {
    const t = (y - top) / Math.max(1, rowsDown - 1);
    if (t < 0.55) continue;
    for (let x = 0; x < W; x++) {
      const c = get(x, y);
      if (c) set(x, y, mixColor(c, INK_COLOR, (t - 0.55) * 0.55));
    }
  }

  // Stones in the deep soil.
  const deep = top + Math.max(3, Math.round(rowsDown * 0.45));
  const stone = biome.palette.P ?? biome.palette.r ?? layerColor(0) ?? "#8a8494";
  for (let n = 0; n < 4; n++) {
    const sx = Math.floor(random() * W);
    const sy = deep + Math.floor(random() * Math.max(1, TERRAIN_ROWS - deep - 2));
    const wide = random() < 0.5 ? 3 : 2;
    const soil = get(sx, sy) ?? stone;
    const line = mixColor(soil, INK_COLOR, 0.45);
    for (let dx = -1; dx <= wide; dx++) {
      set(sx + dx, sy - 1, dx >= 0 && dx < wide ? line : null);
      set(sx + dx, sy + 2, dx >= 0 && dx < wide ? line : null);
    }
    for (let dy = 0; dy < 2; dy++) {
      set(sx - 1, sy + dy, line);
      set(sx + wide, sy + dy, line);
      for (let dx = 0; dx < wide; dx++) {
        const lit = dx === 0 && dy === 0;
        const shade = dx === wide - 1 && dy === 1;
        set(
          sx + dx,
          sy + dy,
          lit ? mixColor(stone, "#ffffff", 0.3) : shade ? mixColor(stone, INK_COLOR, 0.3) : stone,
        );
      }
    }
  }

  // The surface: a lit top edge, and a ragged lip hanging into the soil
  // with a band of shadow under it.
  const surface = layerColor(0);
  const second = layerColor(1);
  if (surface) {
    const lit = mixColor(surface, "#fff6d8", 0.28);
    for (let x = 0; x < W; x++) set(x, top, lit);
    let x = 0;
    while (x < W) {
      const run = 2 + Math.floor(random() * 3);
      const hang = random() < 0.5 ? 1 : random() < 0.7 ? 2 : 0;
      for (let i = 0; i < run && x + i < W; i++) {
        const cx = x + i;
        for (let d = 1; d <= hang; d++)
          set(cx, top + d, d === hang ? mixColor(surface, INK_COLOR, 0.18) : surface);
        // Shadow under the lip.
        const under = top + hang + 1;
        const soil = get(cx, under);
        if (soil && soil !== surface) set(cx, under, mixColor(soil, INK_COLOR, 0.32));
        if (second && hang === 0) {
          const s2 = get(cx, top + 1);
          if (s2) set(cx, top + 1, mixColor(s2, INK_COLOR, 0.2));
        }
      }
      x += run;
    }
  }

  // Tufts: each 1–2 px tall, the tip lit.
  const tuftRow = top - 1;
  for (let x = 0; x < W; x++) {
    const c = out[tuftRow]?.[x];
    if (!c) continue;
    const tall = random() < 0.4;
    if (tall) {
      set(x, tuftRow - 1, mixColor(c, "#fff6d8", 0.3));
    } else {
      set(x, tuftRow, mixColor(c, "#fff6d8", 0.15));
    }
  }
  return out;
}

/** Each stamp's keys, outlined: a ring of "O" round everything drawn, one cell out. */
function outlined(stamp: readonly string[]): string[] {
  const w = stampWidth(stamp) + 2;
  const h = stamp.length + 2;
  const at = (x: number, y: number): string => stamp[y - 1]?.[x - 1] ?? ".";
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) {
      const k = at(x, y);
      if (k !== ".") {
        // A stamp's own "O" (a colour in some palettes) becomes "Ø", so the
        // shader doesn't take it for an outline.
        row += k === "O" ? "Ø" : k;
        continue;
      }
      const near = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)].some((n) => n !== ".");
      row += near ? "O" : ".";
    }
    rows.push(row);
  }
  return rows;
}

/** Where a prop lives: sunk into the ground (moves with it), standing on it
 *  (sprouts from the surface), or floating in the sky (drifts in). */
export type PropLayer = "sunk" | "ground" | "sky";

export function propLayer(lift: number): PropLayer {
  if (lift < 0) return "sunk";
  return lift > 0 ? "sky" : "ground";
}

export interface PropSprite {
  readonly url: string;
  /** Left column on the decor strip, and size, all in cells. */
  readonly x: number;
  readonly width: number;
  readonly height: number;
  /** Cells from the bottom of the terrain to the sprite's bottom edge. */
  readonly bottom: number;
  readonly layer: PropLayer;
  readonly motion: PropMotion | null;
}

export interface TravelerSprite {
  readonly kind: TravelerKind;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly period: number;
  readonly delay: number;
  /** Cells from the bottom of the terrain to the traveler's bottom edge. */
  readonly bottom: number;
}

export interface TerrainArt {
  /** The ground strip, as an SVG data URL for a repeating background. */
  readonly ground: string;
  /** One decor strip's props, left to right. */
  readonly props: readonly PropSprite[];
  readonly travelers: readonly TravelerSprite[];
}

const stampWidth = (stamp: readonly string[]): number =>
  Math.max(0, ...stamp.map((line) => line.length));

/** Everything a biome draws, rendered once (repeated stamps share one image). */
export function renderTerrain(biome: Biome): TerrainArt {
  // Props and travelers are drawn like the critters: outlined, and lit by
  // critter-shade.ts. The outline adds a cell all round, so each sits a cell
  // left and a cell lower than its stamp (its outline's foot on the ground).
  const palette: Palette = { ...biome.palette, O: INK_COLOR, Ø: biome.palette.O ?? INK_COLOR };
  const materials = Object.fromEntries(
    Object.keys(palette)
      .filter((k) => k !== "O")
      .map((k) => [k, "fur" as const]),
  );
  const urls = new Map<string, string>();
  const image = (stamp: readonly string[]): string => {
    const key = stamp.join("/");
    const cached = urls.get(key);
    if (cached) return cached;
    const rows = outlined(stamp);
    const url = renderColorGrid(
      shadeGrid({ rows, palette, materials, seed: hashKey(`${biome.id}:${key}`) }),
      { width: stampWidth(rows), height: rows.length },
    );
    urls.set(key, url);
    return url;
  };
  const floor = TERRAIN_ROWS - TERRAIN_FLOOR_ROW;
  return {
    ground: renderColorGrid(paintGround(biome), { width: GROUND_COLS, height: TERRAIN_ROWS }),
    props: [...biome.decor]
      .sort((a, b) => a.x - b.x)
      .map((p) => ({
        url: image(p.stamp),
        x: p.x - 1,
        width: stampWidth(p.stamp) + 2,
        height: p.stamp.length + 2,
        bottom: floor + p.lift - 1,
        layer: propLayer(p.lift),
        motion: p.motion,
      })),
    travelers: (biome.travelers ?? []).map((t) => ({
      kind: t.kind,
      url: image(t.stamp),
      width: stampWidth(t.stamp) + 2,
      height: t.stamp.length + 2,
      period: t.period,
      delay: t.delay,
      bottom: floor + t.lift - 1,
    })),
  };
}

export interface Particle {
  /** Horizontal position, % of the lane. */
  readonly left: number;
  /** Vertical placement, 0–1 (what it means depends on the weather kind). */
  readonly y: number;
  /** Size in cells. */
  readonly size: 1 | 2;
  readonly color: string;
  /** Seconds per loop, and a negative start offset so it's already under way. */
  readonly duration: number;
  readonly delay: number;
  /** Sideways travel over a loop, px. */
  readonly drift: number;
}

/** [shortest, longest] loop in seconds, and the widest sideways drift in px. */
const WEATHER_MOTION: Readonly<Record<WeatherKind, readonly [number, number, number]>> = {
  snow: [5, 9, 18],
  pollen: [6, 10, 24],
  dust: [4, 7, 140],
  sparkle: [2.2, 4.5, 0],
};

/** How many particles a lane this wide gets. */
export function particleCount(biome: Biome, widthPx: number): number {
  if (!biome.weather || widthPx <= 0) return 0;
  const wanted = Math.round((widthPx / 100) * biome.weather.density);
  return Math.min(MAX_PARTICLES, Math.max(3, wanted));
}

const round = (n: number, places: number): number => Number(n.toFixed(places));

/**
 * The biome's weather particles, seeded so they're the same every time, and
 * each one independent of the count (a wider lane just adds more at the end).
 */
export function weatherParticles(biome: Biome, count: number): Particle[] {
  const weather = biome.weather;
  if (!weather) return [];
  const random = seeded(hashKey(`weather:${biome.id}`));
  const [shortest, longest, drift] = WEATHER_MOTION[weather.kind];
  return Array.from({ length: count }, (): Particle => {
    const duration = shortest + random() * (longest - shortest);
    const color = weather.colors[Math.floor(random() * weather.colors.length)];
    // Dust always blows the same way; everything else wanders either side.
    const sway = weather.kind === "dust" ? 0.4 + random() * 0.6 : random() * 2 - 1;
    return {
      left: round(random() * 100, 2),
      y: round(random(), 3),
      size: random() < 0.3 ? 2 : 1,
      color: color ?? "#ffffff",
      duration: round(duration, 2),
      delay: -round(random() * duration, 2),
      drift: round(sway * drift, 1),
    };
  });
}

/**
 * A random biome for this visit, never the one shown last time (when there is
 * more than one to choose from), so the home screen keeps changing scenery.
 */
export function pickBiome(previousId: string | null, random: () => number): Biome {
  const choices = BIOMES.filter((biome) => biome.id !== previousId);
  const pool = choices.length > 0 ? choices : BIOMES;
  const biome = pool[Math.floor(random() * pool.length)] ?? pool[0];
  if (!biome) throw new Error("terrain list is empty");
  return biome;
}
