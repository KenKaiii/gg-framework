// The campfire clearing, drawn the way GG Royale draws its art: 1 art pixel
// per canvas pixel (shown at 2 screen px each), ink outlines, two- and
// three-tone shading, and ordered dithering where tones meet. Its colours come
// from the light for the local hour (scene-light.ts): a sky warming to the
// horizon, stars and the moon at night, the sun by day, pines at the edges, a
// field of the critters' meadow grass, and a campfire that burns in the
// evening and smoulders in the day.
//
// Two layers. `drawClearing` paints what stays still (sky, sun, moon, hills,
// forest, pines, grass) once per size and hour. `drawClearingLife` paints what
// moves on top for a moment in time: the fire and its light on the grass,
// embers, smoke, fireflies, twinkling stars and the odd shooting star, a glow
// breathing round the moon and sun, drifting clouds and pollen, and (where the
// layout has them) birds, bats and an owl's eyes. Sunbeams and morning mist
// are pre-drawn in a few frames (`drawBeamFrame`, `drawMistTile`) and stepped
// or slid across, so they cost a copy a frame. Motion steps in whole art
// pixels, as the game's does, and the sky's is slow on purpose. Pure: the same
// picture for the same layout, hour and time.
//
// Two layouts share it: the "What's new" window (`whatsNewLayout`) and the
// home screen (`homeLayout`).

import { clamp01, mixRgb, moonAt, skyAt, sunAt, type Rgb, type SceneLight } from "./scene-light";

type Ctx = CanvasRenderingContext2D;

const INK: Rgb = [0x1e, 0x0c, 0x1f];
const BLACK: Rgb = [0x08, 0x06, 0x0c];
/** The critters' meadow (critter-terrain.ts), so the field meets their ground without a seam. */
const MEADOW = { hi: "#6cbf52", tuft: "#4a9a3f", body: "#2f6a30", lo: "#24522a" } as const;
/** GG Royale's wood and stone, for the fire. */
const WOOD = { body: "#743c36", hi: "#8a4a40", lo: "#4e343f" } as const;
const STONE = { body: "#5e5866", hi: "#7c7686" } as const;
const FLAME = { w: "#fff1c0", Y: "#f5bd63", O: "#e9813a", R: "#c2444d" } as const;
const EMBER = ["#fff1c0", "#f5bd63", "#e9813a", "#c2444d", "#7a2e2a"] as const;
/** The firelight on the grass: the flame's own orange, whatever the sky is doing. */
const FIRELIGHT: Rgb = [0xe9, 0x81, 0x3a];
const ASH = "#6a6470";
const SMOKE = ["#a8a2ae", "#8a8492", "#6e6878"] as const;
const STAR = "#f2e6d0";
const STAR_DIM = "#8a7a96";
const FIREFLY = { on: "#f5d878", glow: "#8a8a3a" } as const;
const MOON = { body: "#efe6d2", shade: "#bfb4a4" } as const;
const OWL_EYE = "#ffc45a";

/** The flame's three frames, as GG Royale draws a prop: palette keys, "." clear. */
const FIRE_FRAMES = [
  [
    ".....R.....",
    "....RO..R..",
    "...ROR.RO..",
    "...ROYOROR.",
    "..ROYYYYOR.",
    "..ROYwwYOR.",
    ".ROYwwwwYOR",
    ".ROYwwwYOR.",
    "..ROYYYOR..",
  ],
  [
    "......R....",
    "..R..ROR...",
    "..RO.ROR...",
    "..ROROYOR..",
    ".ROYYYYOR..",
    ".ROYwwYYOR.",
    ".ROYwwwwYOR",
    "..ROYwwYOR.",
    "..ROYYYOR..",
  ],
  [
    "....R......",
    "....OR..R..",
    "...ROR.ROR.",
    "..ROYOROR..",
    "..ROYYYYOR.",
    ".ROYYwwYOR.",
    ".ROYwwwwYOR",
    ".ROYwwwYOR.",
    "..ROYYYOR..",
  ],
] as const;
/** The moon, a crescent lit on its right. */
const MOON_ROWS = [
  "...bbb..",
  "..sbbbb.",
  ".sbbbbbb",
  ".sbbbbbb",
  ".sbbbbbb",
  "..sbbbb.",
  "...sss..",
] as const;
/** A bird, wings up then level. */
const BIRD = [
  ["x...x", ".x.x.", "..x.."],
  [".....", "xx.xx", "..x.."],
] as const;
/** A bat, wings up then down. */
const BAT = [
  ["x...x", "xx.xx", ".xxx."],
  ["..x..", ".xxx.", "x.x.x"],
] as const;

const hex = ([r, g, b]: Rgb): string =>
  `#${[r, g, b]
    .map((n) =>
      Math.round(Math.max(0, Math.min(255, n)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
const rgbOf = (h: string): Rgb => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

function px(ctx: Ctx, x: number, y: number, w: number, h: number, c: string): void {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 4×4 ordered (Bayer) dither threshold, 0–1: tones meet in a fine checker. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;
function dither(x: number, y: number): number {
  return ((BAYER[(y & 3) * 4 + (x & 3)] ?? 0) + 0.5) / 16;
}

/** A sprite of palette keys at (x, y), optionally with GG Royale's ink outline round it. */
function sprite(
  ctx: Ctx,
  rows: readonly string[],
  x: number,
  y: number,
  pal: Readonly<Record<string, string>>,
  outline = true,
): void {
  const on = (cx: number, cy: number): boolean => {
    const ch = rows[cy]?.[cx];
    return ch !== undefined && ch !== ".";
  };
  if (outline) {
    const width = Math.max(...rows.map((r) => r.length));
    for (let ry = -1; ry <= rows.length; ry++) {
      for (let rx = -1; rx <= width; rx++) {
        if (on(rx, ry)) continue;
        if (on(rx - 1, ry) || on(rx + 1, ry) || on(rx, ry - 1) || on(rx, ry + 1)) {
          px(ctx, x + rx, y + ry, 1, 1, hex(INK));
        }
      }
    }
  }
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const c = pal[row[rx] ?? "."];
      if (c) px(ctx, x + rx, y + ry, 1, 1, c);
    }
  });
}

/**
 * The CSS filter `brightness(b) saturate(s) sepia(p)` (scene-light.ts
 * groundFilter, applied to the critters' ground) worked out for one colour,
 * so the field is the very same green as their strip.
 */
function groundTint(c: Rgb, light: SceneLight): Rgb {
  const clamp = (n: number): number => Math.max(0, Math.min(255, n));
  const b = light.groundBrightness;
  const s = light.groundSaturate;
  const k = 1 - clamp01(light.groundSepia);
  let [r, g, bl] = [clamp(c[0] * b), clamp(c[1] * b), clamp(c[2] * b)];
  [r, g, bl] = [
    clamp((0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * bl),
    clamp((0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * bl),
    clamp((0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * bl),
  ];
  return [
    clamp((0.393 + 0.607 * k) * r + (0.769 - 0.769 * k) * g + (0.189 - 0.189 * k) * bl),
    clamp((0.349 - 0.349 * k) * r + (0.686 + 0.314 * k) * g + (0.168 - 0.168 * k) * bl),
    clamp((0.272 - 0.272 * k) * r + (0.534 - 0.534 * k) * g + (0.131 + 0.869 * k) * bl),
  ];
}

/** The field's tones for this hour. */
function grassTones(light: SceneLight): { lo: string; body: Rgb; tuft: string; hi: string } {
  const t = (c: string): Rgb => groundTint(rgbOf(c), light);
  return {
    lo: hex(t(MEADOW.lo)),
    body: t(MEADOW.body),
    tuft: hex(t(MEADOW.tuft)),
    hi: hex(t(MEADOW.hi)),
  };
}

// ── Layouts ──

export interface ClearingPine {
  readonly x: number;
  /** Where the trunk meets the ground. */
  readonly base: number;
  readonly height: number;
  /** The side its lit edge faces: +1 right, -1 left (towards the middle). */
  readonly light: 1 | -1;
  /** 0 standing back towards the forest … 1 right at the front: back ones are hazier. */
  readonly depth: number;
}

/** Where everything sits, in art pixels. */
export interface ClearingLayout {
  readonly w: number;
  readonly h: number;
  /** The horizon: the field of grass from here down. */
  readonly horizon: number;
  /** How tall the hills along the horizon stand. */
  readonly hills: number;
  /** The campfire's base. */
  readonly fire: { readonly x: number; readonly base: number };
  /** How far the fire's light reaches across the grass, and how high its embers climb. */
  readonly glow: { readonly rx: number; readonly ry: number; readonly rise: number };
  /** Back to front. */
  readonly pines: readonly ClearingPine[];
  /** Pines grow this wide for their height. */
  readonly spread: number;
  /** Moon and sun, where the layout shows them; null where it doesn't. */
  readonly moon: { readonly x: number; readonly y: number } | null;
  readonly sun: { readonly x: number; readonly y: number; readonly r: number } | null;
  /** The owl's eyes, in the tallest pine at the left; null for no owl. */
  readonly owl: { readonly x: number; readonly y: number } | null;
  /** Whether birds cross the sky and bats flit at dusk. */
  readonly fliers: boolean;
  /** Fireflies drift in this box. */
  readonly flies: {
    readonly x0: number;
    readonly x1: number;
    readonly y0: number;
    readonly y1: number;
    readonly count: number;
  };
}

/** The "What's new" window: a strip of grass along the bottom, the fire to the left of its button. */
export function whatsNewLayout(w: number, h: number, groundHeight: number): ClearingLayout {
  const horizon = Math.max(0, h - groundHeight);
  return {
    w,
    h,
    horizon,
    hills: 1,
    fire: { x: Math.round(w * 0.2), base: horizon + 30 },
    glow: { rx: 48, ry: 14, rise: 30 },
    pines: [
      // Back to front.
      { x: 17, base: horizon + 2, height: Math.round(horizon * 0.3), light: 1, depth: 0.4 },
      { x: w - 18, base: horizon + 2, height: Math.round(horizon * 0.26), light: -1, depth: 0.4 },
      { x: 3, base: horizon + 4, height: Math.round(horizon * 0.5), light: 1, depth: 1 },
      { x: w - 4, base: horizon + 4, height: Math.round(horizon * 0.44), light: -1, depth: 1 },
    ],
    spread: 0.28,
    moon: { x: Math.round(w * 0.1), y: Math.round(horizon * 0.1) },
    sun: { x: Math.round(w * 0.07), y: Math.round(horizon * 0.07), r: 6 },
    owl: null,
    fliers: false,
    flies: { x0: w * 0.08, x1: w * 0.92, y0: horizon + 8, y1: horizon + 38, count: 6 },
  };
}

/**
 * Half the home content's width in art px: the row of five plate buttons is
 * ~1020 screen px across, at 2 screen px per art px. The sun and moon stay
 * outside it, among the pines, wherever the window has room.
 */
export const HOME_CONTENT_HALF = 256;
/** The home field's depth, in art px: the critters' ground strip sits along its bottom. */
const HOME_FIELD = 0.2;

/** Where the sun or moon sits on its arc, kept clear of the home content. */
function skyBodyAt(
  body: { x: number; elevation: number },
  from: number,
  to: number,
  w: number,
  horizon: number,
  r: number,
): { x: number; y: number } {
  const mid = (from + to) / 2;
  const rising = body.x < mid;
  const along = clamp01(rising ? (body.x - from) / (mid - from) : (to - body.x) / (to - mid));
  const inset = Math.max(r + 6, Math.min(w * (0.1 + 0.12 * along), w / 2 - HOME_CONTENT_HALF - r));
  // 1.15: at its highest it's above the window, clear of the Settings button.
  return {
    x: Math.round(rising ? inset : w - inset),
    y: Math.round(horizon - body.elevation * horizon * 1.15),
  };
}

/** The home screen at `hour`: the fire in the middle of the field above the critters, pines down both sides. */
export function homeLayout(w: number, h: number, hour: number): ClearingLayout {
  const horizon = Math.max(1, Math.round(h * (1 - HOME_FIELD)));
  const field = h - horizon;
  // Four pines down each side, [x, height, depth]: each a step further in,
  // shorter and further back, so they read as a forest edge in depth rather
  // than one dark mass.
  const pinesLeft: [number, number, number][] = [
    [0.03, 0.8, 1],
    [0.115, 0.56, 0.7],
    [0.19, 0.38, 0.45],
    [0.255, 0.25, 0.2],
  ];
  const pinesRight: [number, number, number][] = [
    [0.97, 0.74, 1],
    [0.885, 0.52, 0.7],
    [0.81, 0.36, 0.45],
    [0.745, 0.23, 0.2],
  ];
  const r = Math.max(5, Math.round(h * 0.025));
  const sun = sunAt(hour);
  const moon = moonAt(hour);
  const pines: ClearingPine[] = [];
  // Back to front. Back ones stand up the field, their trunks on the grass.
  for (const [fx, fh, depth] of [...pinesLeft, ...pinesRight].sort((a, b) => a[2] - b[2])) {
    pines.push({
      x: Math.round(w * fx),
      base: Math.round(h + 2 - (1 - depth) * field * 0.45),
      height: Math.round(h * fh),
      light: fx < 0.5 ? 1 : -1,
      depth,
    });
  }
  const owlPine = pinesLeft[0] ?? [0.03, 0.8, 1];
  return {
    w,
    h,
    horizon,
    hills: Math.max(1, h / 260),
    // Just above the critters' lane (its open height is ~45 art px), so their
    // speech bubbles never cover it.
    fire: { x: Math.round(w / 2), base: Math.min(horizon + Math.round(field * 0.42), h - 48) },
    glow: { rx: 72, ry: Math.max(10, Math.round(field * 0.32)), rise: 70 },
    pines,
    spread: 0.2,
    moon: moon.elevation > 0 ? skyBodyAt(moon, 0.3, 0.7, w, horizon, 4) : null,
    sun: sun.elevation > -0.2 ? { ...skyBodyAt(sun, 0.3, 0.74, w, horizon, r), r } : null,
    owl: { x: Math.round(w * owlPine[0]), y: Math.round(h - h * owlPine[1] * 0.62) },
    fliers: true,
    flies: { x0: w * 0.05, x1: w * 0.95, y0: horizon - field * 0.6, y1: h - 14, count: 14 },
  };
}

// ── The still layer ──

/** A pine's colours: foliage in five steps, bark in three, and outlines, for one depth and hour. */
interface PinePalette {
  readonly ink: Rgb;
  readonly deep: Rgb;
  readonly shadow: Rgb;
  readonly body: Rgb;
  readonly lit: Rgb;
  readonly shine: Rgb;
  readonly barkDark: Rgb;
  readonly bark: Rgb;
  readonly barkLit: Rgb;
  /** Its shadow on the grass round the trunk. */
  readonly ground: Rgb;
}

/** Pine needles in daylight; each hour's light tints them like the grass. */
const NEEDLES = "#2f5a3a";

/**
 * A pine's palette for its depth: the front ones dark and full, the back ones
 * hazed towards the distant ridge (as the far forest is), outline and all, so
 * each stands apart from the one in front of it. Lit on one side by the
 * fire's glow in the evening, by daylight otherwise.
 */
function pinePalette(light: SceneLight, depth: number): PinePalette {
  const haze = (1 - clamp01(depth)) * 0.55;
  const hazed = (c: Rgb): Rgb => mixRgb(c, light.ridge, haze);
  const silhouette = mixRgb(light.treeNear, light.treeFar, 0.35);
  const body = hazed(mixRgb(silhouette, groundTint(rgbOf(NEEDLES), light), 0.4));
  const glow = light.fire > 0.2 ? light.glow : light.sun;
  const bark = hazed(mixRgb(rgbOf(WOOD.body), light.treeNear, 0.6));
  const grass = grassTones(light).body;
  return {
    ink: mixRgb(INK, body, haze * 0.9),
    deep: mixRgb(body, BLACK, 0.55 * (1 - haze)),
    shadow: mixRgb(body, BLACK, 0.3 * (1 - haze)),
    body,
    lit: mixRgb(body, glow, 0.16),
    shine: mixRgb(body, glow, 0.32),
    barkDark: mixRgb(bark, BLACK, 0.45),
    bark,
    barkLit: mixRgb(bark, glow, 0.25),
    ground: mixRgb(grass, BLACK, 0.4),
  };
}

/** A repeatable 0–1 hash of a few integers: texture that stays put frame to frame. */
function hash(a: number, b: number, c: number): number {
  let n =
    Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b9);
  n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** One layer of branches: rows `y0`–`y1`, widening from `top` to `left`/`right` at its foot. */
interface Tier {
  readonly y0: number;
  readonly y1: number;
  readonly top: number;
  readonly left: number;
  readonly right: number;
}

/** A pixel buffer the pines are drawn into, over whatever's already there. */
interface Pixels {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8ClampedArray;
}
function put(buf: Pixels, x: number, y: number, c: Rgb): void {
  if (x < 0 || y < 0 || x >= buf.w || y >= buf.h) return;
  const i = (y * buf.w + x) * 4;
  buf.data[i] = c[0];
  buf.data[i + 1] = c[1];
  buf.data[i + 2] = c[2];
  buf.data[i + 3] = 255;
}

/**
 * A pine, drawn like a GG Royale prop, pixel by pixel: an ink outline round
 * the whole tree; layers of branches, each overhanging the one below with a
 * shaded underside, lit along its top and on the side facing the light, with
 * needle texture and ragged, drooping tips; and a trunk that varies tree to
 * tree, with bark grooves, a knot or two, a root flare and a shadow on the
 * grass. The tree's own seed picks its proportions, so no two match.
 */
function pine(buf: Pixels, p: ClearingPine, spreadFor: number, pal: PinePalette): void {
  const { x: cx, base, height, light: side } = p;
  if (height < 6) return;
  const seed = cx * 31 + height * 7;
  const r = rng(seed);
  const crownFrac = 0.82 + r() * 0.1;
  const crown = Math.round(height * crownFrac);
  const top = base - height;
  const crownFoot = top + crown;
  const tierCount = Math.max(3, Math.round(crown / (12 + r() * 6)));
  const spread = height * spreadFor * (0.88 + r() * 0.24);
  const tierH = crown / tierCount;
  const overlap = Math.max(1, Math.round(tierH * 0.4));
  const tiers: Tier[] = Array.from({ length: tierCount }, (_, k) => {
    const t1 = (k + 1) / tierCount;
    const full = Math.max(2, spread * (0.22 + 0.78 * t1 ** 0.9));
    return {
      y0: top + Math.round(k * tierH) - (k > 0 ? overlap : 0),
      y1: top + Math.round((k + 1) * tierH),
      top: k === 0 ? 0 : full * (0.3 + r() * 0.12),
      left: full * (0.9 + r() * 0.2),
      right: full * (0.9 + r() * 0.2),
    };
  });

  // The trunk: wider for taller trees, different every time, showing below
  // the lowest branches and running up behind them.
  const trunkW = Math.max(2, Math.min(9, Math.round(height / 22 + (r() - 0.5) * 2.5)));
  const trunkX0 = cx - Math.floor(trunkW / 2);
  const trunkTop = crownFoot - overlap - 2;
  const knots = Array.from({ length: 1 + Math.floor(r() * 2) }, () => ({
    y: Math.round(trunkTop + 3 + r() * Math.max(1, base - trunkTop - 6)),
    x: trunkX0 + 1 + Math.floor(r() * Math.max(1, trunkW - 2)),
  }));

  const maxHalf = Math.ceil(Math.max(...tiers.map((t) => Math.max(t.left, t.right)))) + 3;
  const bx0 = cx - maxHalf;
  const bw = maxHalf * 2 + 1;
  const by0 = top - 1;
  const bh = base - by0 + 2;
  // 0 empty, 1 foliage, 2 trunk.
  const mask = new Uint8Array(bw * bh);
  const tierOf = new Int16Array(bw * bh).fill(-1);
  const at = (x: number, y: number): number => (y - by0) * bw + (x - bx0);
  const inside = (x: number, y: number): boolean =>
    x >= bx0 && x < bx0 + bw && y >= by0 && y < by0 + bh;

  for (let y = by0; y < by0 + bh; y++) {
    for (let x = bx0; x < bx0 + bw; x++) {
      const dx = x - cx;
      // The first (highest) layer that reaches here is the one in front.
      for (let k = 0; k < tiers.length; k++) {
        const t = tiers[k];
        if (!t || y < t.y0 || y > t.y1 + 1) continue;
        const v = Math.min(1, (y - t.y0) / Math.max(1, t.y1 - t.y0));
        const full = dx < 0 ? t.left : t.right;
        // Sprigs: the edge steps out down each layer in little sawteeth (a
        // branch's tips), unevenly, so the side never runs in a straight line.
        const row = y - t.y0;
        const tooth = ((row + Math.floor(hash(k, dx < 0 ? 1 : 2, seed) * 4)) % 4) * 0.7;
        const reach =
          t.top + (full - t.top) * v ** 0.85 - 1.4 + tooth - (hash(y, k, seed) < 0.25 ? 1 : 0);
        if (Math.abs(dx) > reach) continue;
        // Ragged foot: needle tufts hang a pixel lower, the outer tips droop.
        const foot =
          t.y1 - (hash(dx >> 1, k, seed + 1) < 0.35 ? 1 : 0) + (Math.abs(dx) > full * 0.72 ? 1 : 0);
        if (y > foot) continue;
        mask[at(x, y)] = 1;
        tierOf[at(x, y)] = k;
        break;
      }
      if (mask[at(x, y)]) continue;
      // Trunk, flaring into roots over its last rows.
      if (y >= trunkTop && y <= base) {
        const flare = y >= base - 1 ? 2 : y >= base - 3 ? 1 : 0;
        if (x >= trunkX0 - flare && x < trunkX0 + trunkW + flare) mask[at(x, y)] = 2;
      }
    }
  }

  // Its shadow on the grass round the foot of the trunk, dithered out.
  const sw = trunkW * 2 + 8;
  for (let y = base - 2; y <= base + 2; y++) {
    for (let x = cx - sw; x <= cx + sw; x++) {
      const d = Math.hypot((x - cx) / sw, (y - base) / 2.5);
      if (d < 1 && 1 - d > dither(x, y) * 0.9) put(buf, x, y, pal.ground);
    }
  }

  for (let y = by0; y < by0 + bh; y++) {
    for (let x = bx0; x < bx0 + bw; x++) {
      const m = mask[at(x, y)];
      if (!m) {
        // The outline: ink on every empty pixel touching the tree.
        const touches = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ].some(([nx = 0, ny = 0]) => inside(nx, ny) && mask[at(nx, ny)]);
        if (touches) put(buf, x, y, pal.ink);
        continue;
      }
      const dx = x - cx;
      if (m === 2) {
        // Bark: dark on the far side, lit on the near edge, grooves and knots between.
        const col = x - trunkX0;
        const shaded = side > 0 ? col <= 0 : col >= trunkW - 1;
        const litEdge = side > 0 ? col === trunkW - 1 : col === 0;
        let c = pal.bark;
        if (shaded) c = pal.barkDark;
        else if (litEdge && trunkW > 2) c = pal.barkLit;
        else if (hash(col, (y + col * 3) >> 2, seed) < 0.32) c = pal.barkDark;
        if (y < crownFoot + 3) c = pal.barkDark; // under the branches
        for (const k of knots) {
          if (x === k.x && (y === k.y || y === k.y + 1)) c = pal.barkDark;
          if (x === k.x && y === k.y + 2) c = pal.barkLit;
        }
        put(buf, x, y, c);
        continue;
      }
      const k = tierOf[at(x, y)] ?? 0;
      const t = tiers[k];
      if (!t) continue;
      const v = Math.min(1, (y - t.y0) / Math.max(1, t.y1 - t.y0));
      const full = dx < 0 ? t.left : t.right;
      const u = dx / Math.max(1, full);
      // Light from one side, catching each layer's top; its underside in shade.
      let s = 0.44 + 0.3 * u * side;
      if (v < 0.3) s += 0.12;
      if (v > 0.78) s -= 0.42;
      // Needle texture: short strokes slanting down and out from the trunk,
      // as needles hang, in clumps; a little single-pixel grain on top.
      const out = Math.abs(dx);
      const stroke = hash(Math.floor((y - out * 0.5) / 2), Math.floor(out / 3), seed);
      s += (stroke - 0.5) * 0.34 + (hash(x, y, seed + 2) - 0.5) * 0.08;
      s += (dither(x, y) - 0.5) * 0.1;
      const c =
        s < 0.16
          ? pal.deep
          : s < 0.38
            ? pal.shadow
            : s < 0.62
              ? pal.body
              : s < 0.8 || u * side < 0.35 || v > 0.6
                ? pal.lit
                : pal.shine;
      put(buf, x, y, c);
    }
  }
}

/** The stars the hour has out, fixed in place (some twinkle, see drawClearingLife). */
function starsOf(
  L: ClearingLayout,
  light: SceneLight,
): { x: number; y: number; bright: boolean }[] {
  const r = rng(7);
  const count = Math.round(((L.w * L.horizon) / 1200) * light.stars);
  return Array.from({ length: count }, () => ({
    x: Math.floor(r() * L.w),
    y: Math.floor(r() ** 1.6 * L.horizon * 0.42),
    bright: r() < 0.3,
  }));
}

/** The sky in banded tones that meet through the dither, written straight into the pixels. */
function paintSky(ctx: Ctx, L: ClearingLayout, light: SceneLight): void {
  const { w, horizon } = L;
  if (horizon <= 0 || w <= 0) return;
  const BANDS = 9;
  const tones = Array.from({ length: BANDS }, (_, i) => skyAt(light, i / (BANDS - 1)));
  const img = ctx.createImageData(w, horizon);
  for (let y = 0; y < horizon; y++) {
    const t = (y / Math.max(1, horizon)) * (BANDS - 1);
    const lo = Math.min(BANDS - 1, Math.floor(t));
    const hi = Math.min(BANDS - 1, lo + 1);
    const a = tones[lo] ?? INK;
    const b = tones[hi] ?? INK;
    for (let x = 0; x < w; x++) {
      const c = t - lo > dither(x, y) ? b : a;
      const i = (y * w + x) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** A pixel sun: a light disc, a warmer rim, and a dithered halo into the sky. */
/** A pixel sun: a light disc with a warmer rim (its halo breathes, in the moving layer). */
function paintSun(ctx: Ctx, sun: { x: number; y: number; r: number }, light: SceneLight): void {
  const rim = hex(mixRgb(light.sun, light.glow, 0.5));
  const core = hex(light.sun);
  for (let y = -sun.r; y <= sun.r; y++) {
    for (let x = -sun.r; x <= sun.r; x++) {
      const d = Math.hypot(x, y);
      if (d <= sun.r - 1.5) px(ctx, sun.x + x, sun.y + y, 1, 1, core);
      else if (d <= sun.r) px(ctx, sun.x + x, sun.y + y, 1, 1, rim);
    }
  }
}

/** Whether the sun is out at this light (the sun and the stars don't share a sky). */
function sunOut(
  L: ClearingLayout,
  light: SceneLight,
): L is ClearingLayout & { sun: NonNullable<ClearingLayout["sun"]> } {
  return L.sun !== null && light.stars < 0.5;
}
function moonOut(
  L: ClearingLayout,
  light: SceneLight,
): L is ClearingLayout & { moon: NonNullable<ClearingLayout["moon"]> } {
  return L.moon !== null && light.stars > 0.4;
}

/** The still layer: sky, stars, moon, sun, hills, the far forest, near pines and the field. */
export function drawClearing(ctx: Ctx, L: ClearingLayout, light: SceneLight): void {
  drawClearingSky(ctx, L, light);
  drawClearingLand(ctx, L, light);
}

/** The still sky (opaque): its bands, the stars, the moon and the sun. */
export function drawClearingSky(ctx: Ctx, L: ClearingLayout, light: SceneLight): void {
  paintSky(ctx, L, light);
  for (const s of starsOf(L, light)) px(ctx, s.x, s.y, 1, 1, s.bright ? STAR : STAR_DIM);
  if (moonOut(L, light))
    sprite(ctx, MOON_ROWS, L.moon.x - 4, L.moon.y - 3, { b: MOON.body, s: MOON.shade });
  if (sunOut(L, light)) paintSun(ctx, L.sun, light);
}

/**
 * The still land, on a clear canvas, so the sky's motion can play between the
 * two: hills, the far forest, the field, the near pines and the vignette.
 */
export function drawClearingLand(ctx: Ctx, L: ClearingLayout, light: SceneLight): void {
  drawClearingField(ctx, L, light);
  drawClearingPines(ctx, L, light);
}

/** The hills, the far forest and the field, on a clear canvas. */
export function drawClearingField(ctx: Ctx, L: ClearingLayout, light: SceneLight): void {
  const { w, h, horizon } = L;
  if (horizon >= h) return;

  // Soft hills, then the far forest: one band with pine tips along its top, so
  // the horizon's glow only shows between the tips.
  const ridge = hex(light.ridge);
  for (let x = 0; x < w; x++) {
    const hill = Math.round(
      L.hills * (10 + 5 * Math.sin(x / (23 * L.hills)) + 3 * Math.sin(x / (9 * L.hills) + 1)),
    );
    px(ctx, x, horizon - hill, 1, hill, ridge);
  }
  const far = hex(light.treeFar);
  const tips = rng(11);
  const band = Math.round(5 * L.hills);
  px(ctx, 0, horizon - band, w, band, far);
  for (let x = -3; x < w + 3; x += 3 + Math.floor(tips() * 3)) {
    const ht = Math.round((4 + Math.floor(tips() * 6)) * Math.sqrt(L.hills));
    for (let y = 0; y < ht; y++) {
      const half = Math.floor((y / ht) * 2.2);
      px(ctx, x - half, horizon - band - ht + y, half * 2 + 1, 1, far);
    }
  }

  // The field: darker than the critters' own strip and hazed into the ridge's
  // colour towards the horizon, so it sits back; an ink line along the
  // horizon, a lit top edge, tufts and earth flecks.
  const grass = grassTones(light);
  const depth = h - horizon;
  const BANDS = 4;
  // Deeper in the dark: a big field of pixel green glares against a night sky.
  const shadow = 0.22 + (1 - light.groundBrightness) * 0.9;
  for (let y = horizon; y < h; y++) {
    const far = 1 - (y - horizon) / Math.max(1, depth);
    const t = far * (BANDS - 1);
    const band = Math.floor(t);
    for (let x = 0; x < w; x++) {
      const k = t - band > dither(x, y) ? band + 1 : band;
      const haze = (k / (BANDS - 1)) * 0.45;
      px(ctx, x, y, 1, 1, hex(mixRgb(mixRgb(grass.body, BLACK, shadow), light.ridge, haze)));
    }
  }
  const flecks = rng(23);
  for (let i = 0; i < w * (h - horizon) * 0.06; i++) {
    const x = Math.floor(flecks() * w);
    const y = horizon + 4 + Math.floor(flecks() * Math.max(1, h - horizon - 4));
    px(ctx, x, y, 1, 1, flecks() < 0.6 ? grass.lo : grass.tuft);
  }
  px(ctx, 0, horizon, w, 1, hex(INK));
  px(ctx, 0, horizon + 1, w, 1, grass.hi);
  px(ctx, 0, horizon + 2, w, 1, grass.tuft);
  const tufts = rng(13);
  for (let x = 1; x < w; x += 3 + Math.floor(tufts() * 5)) {
    const tall = 1 + Math.floor(tufts() * 2);
    px(ctx, x, horizon - tall, 1, tall + 1, hex(INK));
    px(ctx, x, horizon - tall + 1, 1, tall, grass.hi);
  }
}

/**
 * The near pines framing the middle and the vignette, on a clear canvas: in
 * front of the beams and the mist. Each is lit on the side facing in, by the
 * fire's glow in the evening and by daylight otherwise.
 */
export function drawClearingPines(ctx: Ctx, L: ClearingLayout, light: SceneLight): void {
  const { w, h } = L;
  if (w > 0 && h > 0 && L.pines.length) {
    // Pixel by pixel, over whatever the canvas already holds.
    const img = ctx.getImageData(0, 0, w, h);
    const buf: Pixels = { w, h, data: img.data };
    for (const p of L.pines) pine(buf, p, L.spread, pinePalette(light, p.depth));
    ctx.putImageData(img, 0, 0);
  }

  // A soft vignette, as in the game.
  ctx.globalAlpha = 0.14;
  for (let i = 0; i < 4; i++) {
    const m = 5 * (4 - i);
    px(ctx, 0, 0, w, m, hex(BLACK));
    px(ctx, 0, h - m, w, m, hex(BLACK));
    px(ctx, 0, m, m, h - 2 * m, hex(BLACK));
    px(ctx, w - m, m, m, h - 2 * m, hex(BLACK));
  }
  ctx.globalAlpha = 1;
}

// ── The moving layer ──

/** A slow, uneven wobble in [-1, 1] (two sines out of step), for flicker and drift. */
function wobble(t: number, seed: number): number {
  return 0.6 * Math.sin(t * 2.3 + seed) + 0.4 * Math.sin(t * 5.1 + seed * 1.7);
}

/** One log, ink-outlined, from (x0, y0) running `len` px in `dir`, rising 1 px every 3. */
function log(ctx: Ctx, x0: number, y0: number, len: number, dir: 1 | -1, lit: boolean): void {
  const at = (i: number): [number, number] => [x0 + dir * i, y0 - Math.floor(i / 3)];
  for (let i = 0; i < len; i++) {
    const [x, y] = at(i);
    px(ctx, x - 1, y - 1, 3, 4, hex(INK));
  }
  for (let i = 0; i < len; i++) {
    const [x, y] = at(i);
    px(ctx, x, y, 1, 2, WOOD.body);
    px(ctx, x, y, 1, 1, lit ? WOOD.hi : WOOD.body);
    px(ctx, x, y + 1, 1, 1, WOOD.lo);
  }
}

function campfire(ctx: Ctx, L: ClearingLayout, light: SceneLight, t: number): void {
  const { x: cx, base } = L.fire;
  const lit = light.fire > 0.2;
  const grass = grassTones(light);
  // Its light on the grass, breathing with the flame: two close tones through
  // the dither, so it reads as light, not a rug.
  if (light.fire > 0) {
    const flicker = 1 + 0.06 * wobble(t, 1);
    const warm = hex(mixRgb(grass.body, FIRELIGHT, 0.2));
    const warmer = hex(mixRgb(grass.body, FIRELIGHT, 0.38));
    const rx = L.glow.rx * (0.4 + 0.6 * light.fire) * flicker;
    const ry = L.glow.ry * (0.5 + 0.5 * light.fire) * flicker;
    for (
      let y = Math.max(L.horizon + 3, Math.floor(base - ry));
      y < Math.min(L.h, base + ry);
      y++
    ) {
      for (let x = Math.max(0, Math.floor(cx - rx)); x < Math.min(L.w, cx + rx); x++) {
        const d = Math.hypot((x - cx) / rx, (y - base + 1) / ry);
        if (d >= 1) continue;
        const strength = (1 - d) ** 1.6 * light.fire;
        if (strength > 0.5 + dither(x, y) * 0.5) px(ctx, x, y, 1, 1, warmer);
        else if (strength > dither(x, y)) px(ctx, x, y, 1, 1, warm);
      }
    }
  }
  // Stones and two crossed logs.
  for (const dx of [-10, -7, -3, 2, 6, 9] as const) {
    const y = base + (Math.abs(dx) > 7 ? -1 : 1);
    px(ctx, cx + dx - 1, y - 1, 4, 3, hex(INK));
    px(ctx, cx + dx, y - 1, 2, 2, STONE.body);
    px(ctx, cx + dx, y - 1, 2, 1, STONE.hi);
  }
  log(ctx, cx - 7, base, 12, 1, lit);
  log(ctx, cx + 7, base, 12, -1, lit);
  if (lit) {
    // The flame: three frames, changing about eight times a second, unevenly.
    const frame = Math.floor(t * 8 + 0.6 * Math.sin(t * 3)) % FIRE_FRAMES.length;
    sprite(ctx, FIRE_FRAMES[frame] ?? FIRE_FRAMES[0], cx - 5, base - 12, FLAME);
    // Embers: each rises from the flame on its own loop, drifting, cooling as it goes.
    const embers = Math.round((L.glow.rise / 5) * light.fire);
    for (let i = 0; i < embers; i++) {
      const period = 1.8 + (i % 3) * 0.5;
      const p = ((t + i * 0.73) / period) % 1;
      const y = base - 12 - p * (L.glow.rise * (0.85 + (i % 4) * 0.1));
      const x = cx + ((i * 5) % 7) - 3 + wobble(t * 0.8, i) * 3 * p;
      const colour = EMBER[Math.min(EMBER.length - 1, Math.floor(p * EMBER.length))] ?? EMBER[0];
      if (p < 0.92) px(ctx, x, y, 1, 1, colour);
    }
  } else {
    // Out: embers glowing in the ashes, and a curl of smoke rising and fading.
    px(ctx, cx - 3, base - 4, 7, 2, ASH);
    const glow = Math.sin(t * 1.7) > 0;
    px(ctx, cx - 1, base - 4, 1, 1, glow ? (EMBER[3] ?? ASH) : (EMBER[4] ?? ASH));
    px(ctx, cx + 2, base - 3, 1, 1, glow ? (EMBER[4] ?? ASH) : (EMBER[3] ?? ASH));
    for (let i = 0; i < 4; i++) {
      const p = (((t * 0.3 + i / 4) % 1) + 1) % 1;
      const y = base - 6 - p * L.glow.rise * 0.8;
      const x = cx + Math.sin(p * 5 + t * 0.6) * 2.5 * (0.4 + p);
      const shade = SMOKE[Math.min(SMOKE.length - 1, Math.floor(p * SMOKE.length))] ?? SMOKE[0];
      if (p < 0.85) px(ctx, x, y, p > 0.4 ? 2 : 1, 1, shade);
    }
  }
}

/** Everything that moves, drawn over the whole still picture at `seconds` (tests, previews). */
export function drawClearingLife(
  ctx: Ctx,
  L: ClearingLayout,
  light: SceneLight,
  seconds: number,
): void {
  drawClearingSkyLife(ctx, L, light, seconds);
  drawClearingGroundLife(ctx, L, light, seconds);
}

/**
 * What moves in the sky, drawn after the still sky and before the land, so
 * the pines stand in front of it: the stars' twinkle, the moon's and sun's
 * glow, clouds, a shooting star, birds and bats.
 */
export function drawClearingSkyLife(
  ctx: Ctx,
  L: ClearingLayout,
  light: SceneLight,
  seconds: number,
): void {
  const t = seconds;
  drawSkyLife(ctx, L, light, t);
  // Twinkle: one star in three dims, brightens or blinks out, each at its own pace.
  const stars = starsOf(L, light);
  for (let i = 0; i < stars.length; i += 3) {
    const s = stars[i];
    if (!s) continue;
    const k = Math.sin(t * (0.7 + (i % 5) * 0.23) + i * 2.1);
    const sky = hex(skyAt(light, s.y / Math.max(1, L.horizon)));
    px(ctx, s.x, s.y, 1, 1, k > 0.35 ? STAR : k > -0.6 ? STAR_DIM : sky);
  }
  if (L.horizon >= L.h) return;

  if (L.fliers) {
    // Birds crossing the sky (morning, day and golden hour), flapping as they go.
    const birdTone = hex(mixRgb(light.treeNear, light.skyMid, 0.25));
    const birds = Math.round(4 * light.birds);
    for (let i = 0; i < birds; i++) {
      const speed = 9 + i * 2.5;
      const span = L.w + 40;
      const dir = i % 2 ? -1 : 1;
      const p = (((t * speed + i * 157) % span) + span) % span;
      const x = dir > 0 ? p - 20 : L.w + 20 - p;
      const y = L.horizon * (0.18 + 0.1 * i) + Math.sin(t * 0.7 + i) * 3;
      const frame = BIRD[Math.floor(t * 4 + i) % 2] ?? BIRD[0];
      sprite(ctx, frame, x, y, { x: birdTone }, false);
    }
    // Bats flitting by the pines at dusk.
    const bats = Math.round(3 * light.bats);
    for (let i = 0; i < bats; i++) {
      const side = i % 2 ? 0.85 : 0.15;
      const x = L.w * side + Math.sin(t * 0.9 + i * 2) * L.w * 0.08;
      const y = L.horizon * (0.3 + 0.08 * i) + Math.sin(t * 1.8 + i) * 6;
      const frame = BAT[Math.floor(t * 7 + i) % 2] ?? BAT[0];
      sprite(ctx, frame, x, y, { x: hex(BLACK) }, false);
    }
  }
}

/**
 * What moves on the land, drawn over it: pollen in the sunbeams, the owl's
 * eyes, the campfire (flame, embers, smoke, its light on the grass) and the
 * fireflies.
 */
export function drawClearingGroundLife(
  ctx: Ctx,
  L: ClearingLayout,
  light: SceneLight,
  seconds: number,
): void {
  const t = seconds;
  if (L.horizon >= L.h) return;
  drawPollen(ctx, L, light, t);
  if (L.fliers) {
    // The owl's eyes in the tall pine at the left, blinking now and then.
    if (L.owl && light.owl > 0.5 && (t + 0.4) % 5 > 0.18) {
      px(ctx, L.owl.x - 2, L.owl.y, 1, 1, OWL_EYE);
      px(ctx, L.owl.x + 1, L.owl.y, 1, 1, OWL_EYE);
    }
  }

  campfire(ctx, L, light, t);

  // Fireflies, each on its own slow loop, blinking on and off.
  const flies = rng(31);
  const { x0, x1, y0, y1, count } = L.flies;
  for (let i = 0; i < Math.round(count * light.fireflies); i++) {
    const hx = x0 + flies() * (x1 - x0);
    const hy = y0 + flies() * (y1 - y0);
    const speed = 0.25 + flies() * 0.25;
    const x = hx + Math.sin(t * speed + i) * 8;
    const y = hy + Math.sin(t * speed * 1.7 + i * 2) * 4;
    if (Math.sin(t * (1.1 + i * 0.13) + i * 3) <= -0.2) continue;
    px(ctx, x - 1, y, 3, 1, FIREFLY.glow);
    px(ctx, x, y - 1, 1, 3, FIREFLY.glow);
    px(ctx, x, y, 1, 1, FIREFLY.on);
  }
}

// ── The sky's motion ──

/** How many sunbeam frames there are; the scene steps back and forth through them. */
export const BEAM_FRAMES = 4;
/** The order the beam frames play in (back and forth), one step every BEAM_STEP_S. */
const BEAM_ORDER = [0, 1, 2, 3, 2, 1] as const;
const BEAM_STEP_S = 0.9;
export function beamFrameAt(seconds: number): number {
  return BEAM_ORDER[Math.floor(seconds / BEAM_STEP_S) % BEAM_ORDER.length] ?? 0;
}

/**
 * One frame of the sunbeams, on a clear canvas: a few shafts fanning from the
 * sun towards the middle, as a dithered checker of faint sunlight. The frames
 * differ by a hair in angle and strength, so stepping through them reads as
 * light shifting through the trees.
 */
export function drawBeamFrame(ctx: Ctx, L: ClearingLayout, light: SceneLight, frame: number): void {
  if (!sunOut(L, light) || light.beams < 0.05) return;
  const { w, horizon } = L;
  const { x: sx, y: sy } = L.sun;
  const bottom = Math.min(L.h, horizon + Math.round((L.h - horizon) * 0.3));
  const toward = Math.atan2(horizon - sy, w / 2 - sx);
  const phase = (frame / BEAM_FRAMES) * Math.PI * 2;
  const rays = [-2, -1, 0, 1, 2].map((k) => ({
    angle: toward + k * 0.11 + Math.sin(phase + k) * 0.006,
    width: 0.018 + ((k + 5) % 3) * 0.007,
    weight: 0.7 + 0.3 * Math.sin(phase * 0.5 + k * 1.7),
  }));
  const reach = Math.hypot(w, horizon) * 0.95;
  const [r, g, b] = light.sun;
  const img = ctx.createImageData(w, bottom);
  for (let y = 0; y < bottom; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - sx;
      const dy = y - sy;
      const dist = Math.hypot(dx, dy);
      if (dist < L.sun.r + 3 || dist > reach) continue;
      const a = Math.atan2(dy, dx);
      let s = 0;
      for (const ray of rays) {
        const off = Math.abs(a - ray.angle);
        if (off < ray.width) s = Math.max(s, (1 - off / ray.width) * ray.weight);
      }
      if (s <= 0) continue;
      const fade =
        (1 - dist / reach) * (y > horizon ? 1 - (y - horizon) / Math.max(1, bottom - horizon) : 1);
      if (s * fade * light.beams * 0.9 <= dither(x, y)) continue;
      const i = (y * w + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 34;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** The mist's band along the horizon: where its tile goes, and how far it slides before repeating. */
export function mistBand(
  L: ClearingLayout,
): { y: number; w: number; h: number; period: number } | null {
  const h = Math.round(16 * L.hills);
  if (L.horizon >= L.h || h < 2) return null;
  const period = 96;
  return { y: L.horizon - Math.round(h * 0.7), w: L.w + period, h, period };
}

/**
 * The morning mist, on a clear canvas the band's size: a dithered haze, thick
 * in the middle of the band, thinning above and below, in soft wisps that
 * repeat every `period` px, so it can slide along the horizon without a seam.
 */
export function drawMistTile(ctx: Ctx, L: ClearingLayout, light: SceneLight): void {
  const band = mistBand(L);
  if (!band || light.mistLevel < 0.05) return;
  const [r, g, b] = light.mist;
  const img = ctx.createImageData(band.w, band.h);
  const k = (Math.PI * 2) / band.period;
  for (let y = 0; y < band.h; y++) {
    const v = 1 - Math.abs(y / band.h - 0.55) * 2;
    for (let x = 0; x < band.w; x++) {
      const wisp = 0.55 + 0.3 * Math.sin(x * k + y * 0.3) + 0.15 * Math.sin(x * k * 3 + 1);
      if (v * wisp * light.mistLevel * 1.2 <= dither(x, y)) continue;
      const i = (y * band.w + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 70;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** A dithered glow round a sky body, its edge breathing in and out by a pixel or two. */
function halo(
  ctx: Ctx,
  L: ClearingLayout,
  light: SceneLight,
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  tint: Rgb,
  strength: number,
): void {
  for (let y = Math.floor(cy - outer); y <= cy + outer; y++) {
    for (let x = Math.floor(cx - outer); x <= cx + outer; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= inner || d > outer) continue;
      if (((outer - d) / (outer - inner)) * strength <= dither(x, y)) continue;
      const sky = skyAt(light, y / Math.max(1, L.horizon));
      px(ctx, x, y, 1, 1, hex(mixRgb(sky, tint, 0.28)));
    }
  }
}

/** A small cloud: a few stacked rows, lit on top, shaded underneath. */
function cloud(
  ctx: Ctx,
  x: number,
  y: number,
  size: number,
  lit: string,
  body: string,
  shade: string,
): void {
  const rows = [0.45, 0.8, 1, 0.9, 0.6] as const;
  rows.forEach((wf, i) => {
    const half = Math.round(size * wf);
    const off = i % 2 ? 1 : 0;
    px(
      ctx,
      x - half + off,
      y + i,
      half * 2,
      1,
      i === 0 ? lit : i === rows.length - 1 ? shade : body,
    );
  });
}

/** The sky's motion, behind everything else in the moving layer. */
function drawSkyLife(ctx: Ctx, L: ClearingLayout, light: SceneLight, t: number): void {
  const { w, horizon } = L;
  // The moon's glow and the sun's halo, breathing slowly.
  if (moonOut(L, light)) {
    const breath = 1.2 * Math.sin(t * 0.5);
    halo(ctx, L, light, L.moon.x, L.moon.y, 5.5, 11 + breath, rgbOf(MOON.body), 0.55 * light.stars);
  }
  if (sunOut(L, light)) {
    const breath = 1.4 * Math.sin(t * 0.7);
    halo(ctx, L, light, L.sun.x, L.sun.y, L.sun.r + 0.5, L.sun.r + 6 + breath, light.sun, 0.7);
  }
  drawShootingStar(ctx, L, light, t);
  // A few clouds drifting by in the daylight hours, tinted by the hour.
  const daylight = clamp01(1 - light.stars * 1.6);
  if (daylight > 0.1) {
    const lit = hex(mixRgb(light.skyMid, light.sun, 0.45));
    const body = hex(mixRgb(light.skyMid, light.sun, 0.28));
    const shade = hex(mixRgb(light.skyMid, light.skyLow, 0.35));
    const span = w + 80;
    for (let i = 0; i < 3; i++) {
      const speed = 0.6 + i * 0.25;
      const x = ((((t * speed + i * 211) % span) + span) % span) - 40;
      const y = Math.round(horizon * (0.16 + i * 0.11));
      cloud(ctx, x, y, 7 + i * 3, lit, body, shade);
    }
  }
}

/** Pollen drifting down through the sunbeams. */
function drawPollen(ctx: Ctx, L: ClearingLayout, light: SceneLight, t: number): void {
  const { w, horizon } = L;
  if (sunOut(L, light) && light.pollen > 0.05) {
    const p = rng(41);
    const count = Math.round(16 * light.pollen);
    const tone = hex(mixRgb(light.sun, light.skyMid, 0.15));
    for (let i = 0; i < count; i++) {
      const fx = p();
      const baseX = L.sun.x + (w / 2 - L.sun.x) * fx;
      const fall = ((t * (1.5 + p() * 2) + p() * horizon) % horizon) | 0;
      const x = baseX + Math.sin(t * 0.8 + i) * 6;
      const y = (L.sun.y + fall) % horizon;
      if (Math.sin(t * 2 + i * 3) > -0.3) px(ctx, x, y, 1, 1, tone);
    }
  }
}

/** Now and then, a shooting star across the dark top of the sky. */
function drawShootingStar(ctx: Ctx, L: ClearingLayout, light: SceneLight, t: number): void {
  const { w, horizon } = L;
  if (light.stars > 0.6) {
    const PERIOD = 14;
    const cycle = Math.floor(t / PERIOD);
    const p = (t % PERIOD) / 0.7;
    if (p < 1) {
      const r = rng(97 + cycle);
      const x0 = w * (0.15 + r() * 0.7);
      const y0 = horizon * (0.05 + r() * 0.2);
      const dir = r() < 0.5 ? -1 : 1;
      const head = Math.round(p * 26);
      for (let i = 0; i < 6; i++) {
        const k = head - i;
        if (k < 0) continue;
        px(ctx, x0 + dir * k, y0 + k * 0.5, 1, 1, i < 2 ? STAR : STAR_DIM);
      }
    }
  }
}
