// Props for the top-down Goal map, drawn in code in a cosy 3/4-view pixel
// style: light from the top left, three-tone shading, and a dark outline
// tinted by whatever it rings. Each prop is a small buffer with an anchor (the
// point standing on the ground) and an optional ground shadow. Pure: the same
// arguments always draw the same pixels.

import { E, PixelBuffer, darken, hash, mix, noise, stream, type Rgb } from "./goal-map-pixels";

/**
 * The shadow a standing thing casts: its own silhouette laid on the ground,
 * pushed down and to the right (the light is from the upper left) further
 * the higher each part of it stands, so a canopy's shadow has the canopy's
 * shape and a roof's has the roof's.
 */
export interface Shadow {
  /** How dark, 0 to 1 (about 0.3 for most things). */
  readonly a?: number;
  /** Cap on how high any part counts as standing, for low, deep things like a pond. */
  readonly height?: number;
  /**
   * A tree: its shadow is one flat, lumpy patch in the canopy's shape,
   * flattened onto the ground round the trunk, not a rim under the leaves.
   */
  readonly canopy?: boolean;
}

export interface Sprite {
  readonly buf: PixelBuffer;
  /** The point that stands on the ground, in sprite pixels. */
  readonly ax: number;
  readonly ay: number;
  readonly shadow?: Shadow;
}

/** The farm's outline ink and strength, matching the sprites `lean` is used on. */
const LEAN_INK: Rgb = 0x3a1406;
const OUTLINE = 0.86;

/**
 * The camera looks down on the world from high up, so a building is widest
 * at its eave (the part nearest the camera) and narrows away from it: its
 * walls, posts and legs lean in toward the ground, and its roof narrows
 * toward the ridge at the back. Draw a prop upright, then lean it: rows below
 * its widest row are drawn in toward the middle, down to `ground` (a fraction
 * of its half-width) at its foot; rows above, up to `top` at its top edge.
 * The outline at each row's ends is kept, so the edges stay clean.
 */
export function lean(sprite: Sprite, top = 0.14, ground = 0.12, ink: Rgb = LEAN_INK): Sprite {
  const src = sprite.buf;
  const { width: w, height: h } = src;
  const ends = (y: number): [number, number] => {
    let l = -1;
    let r = -1;
    for (let x = 0; x < w; x++) {
      if ((src.data[(y * w + x) * 4 + 3] ?? 0) === 0) continue;
      if (l < 0) l = x;
      r = x;
    }
    return [l, r];
  };
  let eave = -1;
  let widest = 0;
  let first = -1;
  let cx = w / 2;
  for (let y = 0; y < h; y++) {
    const [l, r] = ends(y);
    if (l < 0) continue;
    if (first < 0) first = y;
    // The lowest of the widest rows: the eave, or the front edge of a top.
    if (r - l + 1 >= widest) {
      widest = r - l + 1;
      eave = y;
      cx = (l + r + 1) / 2;
    }
  }
  if (eave < 0) return sprite;
  const foot = Math.max(eave + 1, sprite.ay);
  // A shape that runs to the canvas edge had no room for its outline there:
  // give the leaned copy a pixel of margin each side so it can have one.
  let touches = false;
  for (let y = 0; y < h && !touches; y++) {
    const [l, r] = ends(y);
    touches = l === 0 || r === w - 1;
  }
  const pad = touches ? 1 : 0;
  const ow = w + pad * 2;
  const out = new PixelBuffer(ow, h);
  for (let y = 0; y < h; y++) {
    const [l, r] = ends(y);
    if (l < 0) continue;
    const t =
      y > eave
        ? Math.min(1, (y - eave) / (foot - eave)) * ground
        : y < eave && eave > first
          ? ((eave - y) / (eave - first)) * top
          : 0;
    const s = Math.max(0.3, 1 - t);
    let dl = w;
    let dr = -1;
    for (let x = 0; x < w; x++) {
      const sx = Math.round(cx + (x + 0.5 - cx) / s - 0.5);
      if (sx < l || sx > r) continue;
      const i = (y * w + sx) * 4;
      if ((src.data[i + 3] ?? 0) === 0) continue;
      const o = (y * ow + x + pad) * 4;
      for (let k = 0; k < 4; k++) out.data[o + k] = src.data[i + k] ?? 0;
      dl = Math.min(dl, x);
      dr = Math.max(dr, x);
    }
    // Keep the row's outline at both ends.
    if (dr >= 0) {
      for (const [d, sx] of [
        [dl, l],
        [dr, r],
      ] as const) {
        const i = (y * w + sx) * 4;
        const o = (y * ow + d + pad) * 4;
        for (let k = 0; k < 4; k++) out.data[o + k] = src.data[i + k] ?? 0;
      }
      // Rows that ran to the canvas edge get the outline they had no room
      // for, drawn the way the sprite's own outline is.
      if (l === 0) out.set(dl + pad - 1, y, mix(src.rgb(l, y), ink, OUTLINE));
      if (r === w - 1) out.set(dr + pad + 1, y, mix(src.rgb(r, y), ink, OUTLINE));
    }
  }
  settle(out, first, foot, cx + pad);
  return { ...sprite, buf: out, ax: sprite.ax + pad };
}

/**
 * Light a standing prop the way GG Royale lights its art, over its own
 * colours: the side toward the sun (upper left) a touch brighter, the side
 * away a touch darker, and the last few rows above its foot gathering shade
 * where it meets the ground (the dark a thing sits in, so it stands on the
 * map rather than floating over it). The outline is left alone, so the lines
 * stay the line colour. Steps go through an ordered dither, not a blend.
 */
function settle(b: PixelBuffer, first: number, foot: number, cx: number): void {
  const BY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;
  const tall = Math.max(1, foot - first);
  const SUN = 0xfff2d6;
  for (let y = first; y <= foot && y < b.height; y++) {
    let l = -1;
    let r = -1;
    for (let x = 0; x < b.width; x++) {
      if (!b.opaque(x, y)) continue;
      if (l < 0) l = x;
      r = x;
    }
    if (l < 0) continue;
    const half = Math.max(1, (r - l + 1) / 2);
    for (let x = l; x <= r; x++) {
      if (!b.opaque(x, y)) continue;
      // Leave the line work alone: it's whatever borders the clear outside.
      const edge = !b.opaque(x - 1, y) || !b.opaque(x + 1, y) || !b.opaque(x, y - 1);
      if (edge) continue;
      const d = ((BY[(y & 3) * 4 + (x & 3)] ?? 0) + 0.5) / 16;
      const u = (x + 0.5 - cx) / half; // -1 left … 1 right
      const v = (y - first) / tall; // 0 top … 1 foot
      const c = b.rgb(x, y);
      // Sunward wash on the upper left, shade on the lower right.
      const lit = -u * 0.5 - (v - 0.5) * 0.7;
      if (lit > 0.42 && (lit - 0.42) * 4 > d) b.set(x, y, mix(c, SUN, 0.14));
      else if (lit < -0.42 && (-0.42 - lit) * 4 > d) b.set(x, y, mix(c, LEAN_INK, 0.16));
      // Contact shade: the bottom three rows darken toward the foot.
      const fromFoot = foot - y;
      if (fromFoot < 4 && (4 - fromFoot) / 4 > d * 0.8)
        b.set(x, y, mix(b.rgb(x, y), LEAN_INK, 0.3));
    }
  }
}

function make(
  w: number,
  h: number,
  ax: number,
  ay: number,
  draw: (b: PixelBuffer) => void,
  shadow?: Shadow,
  outline = true,
): Sprite {
  const buf = new PixelBuffer(w, h);
  draw(buf);
  if (outline) buf.outline();
  return { buf, ax, ay, ...(shadow ? { shadow } : {}) };
}

/** Light falls from the top left: how lit a point on a round surface is. */
function lit(nx: number, ny: number): number {
  return -(nx * 0.6 + ny * 0.8);
}

interface Tones {
  readonly hi: Rgb;
  readonly light: Rgb;
  readonly base: Rgb;
  readonly dark: Rgb;
  readonly deep: Rgb;
}

const LEAVES: Tones = {
  hi: E.leaf,
  light: E.green3,
  base: E.green2,
  dark: E.green1,
  deep: E.teal0,
};
const FIR: Tones = {
  hi: mix(E.green2, E.green3, 0.3),
  light: mix(E.green1, E.green2, 0.55),
  base: E.green1,
  dark: mix(E.green1, E.teal0, 0.6),
  deep: E.deep,
};
const AUTUMN: Tones = {
  hi: E.yellow,
  light: E.gold,
  base: E.amber,
  dark: E.orange,
  deep: E.rust,
};

/** One rounded clump of leaves, shaded on its own so a canopy looks bumpy. */
function clump(b: PixelBuffer, cx: number, cy: number, r: number, t: Tones, seed: number): void {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.hypot(dx, dy);
      const rim = r + (noise(x, y, 2.2, seed) - 0.5) * 1.8;
      if (dist > rim) continue;
      const covered = b.opaque(x, y);
      let shade = lit(dx / r, dy / r) + (noise(x, y, 2.1, seed + 3) - 0.5) * 0.7;
      // Where this clump overlaps one behind it, its top edge reads as a fold.
      if (covered && dy < 0 && dist > rim - 1.4) shade -= 0.9;
      const c =
        shade > 0.62
          ? t.hi
          : shade > 0.25
            ? t.light
            : shade > -0.25
              ? t.base
              : shade > -0.7
                ? t.dark
                : t.deep;
      b.set(x, y, c);
    }
  }
}

function trunk(b: PixelBuffer, x: number, y: number, w: number, h: number, seed: number): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const rel = xx - x;
      let c: Rgb = rel === 0 ? E.bark3 : rel >= w - 2 ? E.bark1 : E.bark2;
      if (hash(xx, Math.floor(yy / 3), seed) < 0.18 && rel > 0 && rel < w - 1) c = E.bark1;
      b.set(xx, yy, c);
    }
  }
  // Roots splay at the foot.
  b.set(x - 1, y + h - 1, E.bark2);
  b.set(x + w, y + h - 1, E.bark1);
  b.set(x - 2, y + h - 1, E.bark2);
}

export function oakTree(seed: number, large = true, tones: Tones = LEAVES): Sprite {
  const R = large ? 15 : 11;
  const w = R * 2 + 8;
  const cy = R + 3;
  const trunkW = large ? 6 : 4;
  const trunkTop = Math.round(cy + R * 0.4);
  const trunkH = large ? 15 : 11;
  const h = trunkTop + trunkH + 2;
  const cx = w / 2;
  const rnd = stream(seed);
  return make(
    w,
    h,
    Math.round(cx),
    trunkTop + trunkH,
    (b) => {
      trunk(b, Math.round(cx - trunkW / 2), trunkTop, trunkW, trunkH, seed);
      const blobs: Array<[number, number, number]> = [
        [0, 0, R * 0.66],
        [0, -R * 0.52, R * 0.5],
        [-R * 0.44, -R * 0.24, R * 0.5],
        [R * 0.44, -R * 0.24, R * 0.5],
        [-R * 0.56, R * 0.2, R * 0.47],
        [R * 0.56, R * 0.2, R * 0.47],
        [-R * 0.24, R * 0.47, R * 0.5],
        [R * 0.26, R * 0.48, R * 0.48],
      ];
      blobs.sort((a, bb) => a[1] - bb[1]);
      for (const [ox, oy, r] of blobs) {
        clump(b, cx + ox + (rnd() - 0.5) * 2, cy + oy + (rnd() - 0.5) * 2, r, tones, seed + 17);
      }
    },
    { a: 0.32, canopy: true },
  );
}

export function autumnTree(seed: number): Sprite {
  return oakTree(seed, false, AUTUMN);
}

export function pineTree(seed: number): Sprite {
  const w = 30;
  const h = 46;
  return make(
    w,
    h,
    15,
    43,
    (b) => {
      trunk(b, 13, 36, 4, 7, seed);
      // Four tiers, widest at the bottom, each a soft dome with a ragged hem.
      const tiers: Array<[number, number, number]> = [
        [6, 5, 6],
        [13, 8, 8],
        [21, 10, 10],
        [29, 12, 11],
      ];
      for (const [ty, ry, rx] of tiers) {
        for (let y = ty - ry; y <= ty + 3; y++) {
          for (let x = 15 - rx - 1; x <= 15 + rx + 1; x++) {
            const nx = (x + 0.5 - 15) / rx;
            const ny = (y + 0.5 - ty) / ry;
            const hem = y >= ty ? (x % 3 === 0 ? 2 : x % 3 === 1 ? 3 : 1) : 0;
            if (nx * nx + Math.max(0, -ny) ** 2 > 1 || y > ty + hem) continue;
            let shade = -nx * 0.75 - ny * 0.2 + (noise(x, y * 1.6, 1.8, seed) - 0.5) * 0.8;
            if (y >= ty) shade -= 0.55;
            const c =
              shade > 0.55
                ? FIR.hi
                : shade > 0.15
                  ? FIR.light
                  : shade > -0.35
                    ? FIR.base
                    : shade > -0.8
                      ? FIR.dark
                      : FIR.deep;
            b.set(x, y, c);
          }
        }
      }
    },
    { a: 0.32, canopy: true },
  );
}

export function palmTree(lean = 1): Sprite {
  const w = 36;
  const h = 50;
  return make(
    w,
    h,
    18,
    47,
    (b) => {
      // A curved, ringed trunk.
      for (let i = 0; i < 30; i++) {
        const t = i / 30;
        const x = 18 + Math.sin(t * 1.5) * 5 * lean - 2;
        const y = 47 - i;
        for (let dx = 0; dx < 4; dx++) {
          const ring = i % 4 === 0;
          const c = ring ? E.bark2 : dx === 0 ? E.sand : dx === 3 ? E.bark3 : E.tan;
          b.set(Math.round(x) + dx, y, c);
        }
      }
      const topX = 18 + Math.sin(1.5) * 5 * lean;
      const topY = 17;
      // Fronds arc out and droop.
      const fronds: Array<[number, number]> = [
        [-1, -0.4],
        [1, -0.45],
        [-1, 0.25],
        [1, 0.2],
        [-0.25, -1],
        [0.45, -0.9],
      ];
      for (const [fx, fy] of fronds) {
        for (let s = 0; s < 15; s++) {
          const t = s / 15;
          const x = topX + fx * s * 1.05;
          const y = topY + fy * s * 0.8 + t * t * 9;
          const width = s < 3 ? 1 : s < 11 ? 2 : 1;
          for (let k = -width; k <= width; k++) {
            const c = k < 0 ? E.green3 : k === 0 ? E.green2 : E.green1;
            b.set(Math.round(x), Math.round(y + k), c);
          }
        }
      }
      b.ellipse(topX - 1, topY + 2, 2, 2, E.bark1);
      b.ellipse(topX + 2, topY + 3, 2, 2, E.bark2);
      b.set(Math.round(topX) - 2, topY + 1, E.bark3);
    },
    { a: 0.3 },
  );
}

export function bush(seed: number, berries: Rgb | null = null): Sprite {
  return make(
    22,
    16,
    11,
    14,
    (b) => {
      clump(b, 7, 9, 5.5, LEAVES, seed);
      clump(b, 14, 9, 5.5, LEAVES, seed + 1);
      clump(b, 11, 6, 5, LEAVES, seed + 2);
      if (berries !== null) {
        const rnd = stream(seed);
        for (let i = 0; i < 5; i++) {
          const x = 5 + Math.floor(rnd() * 12);
          const y = 4 + Math.floor(rnd() * 8);
          if (!b.opaque(x, y)) continue;
          b.set(x, y, berries);
          b.set(x, y - 1, mix(berries, E.white, 0.5));
        }
      }
    },
    { a: 0.28 },
  );
}

export function rock(seed: number, size: 1 | 2 | 3 = 2, mossy = false): Sprite {
  const rx = 3 + size * 2.5;
  const ry = 2 + size * 1.8;
  const w = Math.ceil(rx * 2) + 4;
  const h = Math.ceil(ry * 2) + 4;
  return make(
    w,
    h,
    Math.round(w / 2),
    h - 2,
    (b) => {
      const cx = w / 2;
      const cy = h / 2;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const nx = (x + 0.5 - cx) / rx;
          const ny = (y + 0.5 - cy) / ry;
          const bump = (noise(x, y, 3, seed) - 0.5) * 0.4;
          if (nx * nx + ny * ny > 1 + bump || ny > 0.85) continue;
          const shade = lit(nx, ny) + (noise(x, y, 2, seed + 1) - 0.5) * 0.4;
          let c: Rgb =
            shade > 0.5 ? E.mist : shade > 0 ? E.steel1 : shade > -0.5 ? E.steel0 : E.slate1;
          if (mossy && ny < -0.2 && noise(x, y, 2.5, seed + 2) > 0.55) c = E.green3;
          b.set(x, y, c);
        }
      }
    },
    { a: 0.3 },
  );
}

export function stump(): Sprite {
  return make(14, 12, 7, 10, (b) => {
    b.rect(2, 4, 10, 6, E.bark2);
    b.rect(2, 4, 2, 6, E.bark3);
    b.rect(10, 4, 2, 6, E.bark1);
    b.ellipse(7, 4, 5, 2.5, E.sand);
    b.ellipse(7, 4, 3, 1.5, E.tan);
    b.set(7, 4, E.bark3);
    b.set(1, 9, E.bark2);
    b.set(12, 9, E.bark1);
  });
}

export function logSeat(): Sprite {
  return make(
    20,
    10,
    10,
    8,
    (b) => {
      b.rect(3, 2, 14, 6, E.bark2);
      b.rect(3, 2, 14, 2, E.bark3);
      b.rect(3, 7, 14, 1, E.bark1);
      for (let x = 5; x < 16; x += 4) b.set(x, 4, E.bark1);
      b.ellipse(3, 5, 2, 3, E.sand);
      b.set(3, 5, E.bark3);
    },
    { a: 0.25 },
  );
}

// ── Buildings ────────────────────────────────────────────────

export type WallStyle = "logs" | "plaster" | "stone" | "boards";
export type RoofStyle = "shingle" | "tile" | "thatch" | "slate";

const ROOFS: Readonly<Record<RoofStyle, { hi: Rgb; base: Rgb; line: Rgb; eave: Rgb }>> = {
  shingle: { hi: E.tan, base: E.bark3, line: E.bark2, eave: E.bark1 },
  tile: { hi: E.orange, base: E.rust, line: E.brick, eave: darken(E.brick, 0.3) },
  thatch: { hi: E.yellow, base: E.gold, line: E.ochre, eave: E.bark3 },
  slate: { hi: E.steel1, base: E.steel0, line: E.slate1, eave: E.slate0 },
};

export interface HouseOptions {
  /** Width of the walls, in pixels. */
  readonly width: number;
  readonly wall: WallStyle;
  readonly roof: RoofStyle;
  readonly wallH?: number;
  readonly roofH?: number;
  /** Door centre, from the left of the walls. */
  readonly door?: number;
  readonly windows?: readonly number[];
  readonly chimney?: boolean;
  /** A small sign over the door. */
  readonly sign?: Icon;
  readonly seed?: number;
}

function wallColor(style: WallStyle, x: number, y: number, w: number, seed: number): Rgb {
  switch (style) {
    case "logs": {
      const row = y % 5;
      if (row === 0) return mix(E.bark3, E.tan, 0.6);
      if (row === 4) return E.bark1;
      return hash(Math.floor(x / 7), Math.floor(y / 5), seed) < 0.3
        ? mix(E.bark3, E.bark2, 0.4)
        : E.bark3;
    }
    case "plaster": {
      if (x < 2 || x >= w - 2 || y % 13 === 12) return E.bark1;
      if (x % 18 === 9) return E.bark2;
      return noise(x, y, 5, seed) > 0.7 ? E.sand : E.cream;
    }
    case "stone": {
      const row = Math.floor(y / 4);
      const sx = (x + (row % 2) * 3) % 7;
      if (sx === 0 || y % 4 === 0) return E.slate1;
      return hash(Math.floor((x + (row % 2) * 3) / 7), row, seed) < 0.4 ? E.steel0 : E.steel1;
    }
    case "boards":
      if (x % 4 === 0) return E.bark1;
      return x % 4 === 1 ? mix(E.bark3, E.tan, 0.3) : E.bark3;
  }
}

/**
 * A house seen from the front and a little above. Its gable faces you: two
 * roof slopes meeting at a ridge down the middle (lit on the left, in shade on
 * the right), a triangle of wall under the peak, and a front wall with a door
 * and windows, standing a little forward of the roof's eave.
 */
export function house(o: HouseOptions): Sprite {
  const wallH = o.wallH ?? 26;
  const roofH = o.roofH ?? Math.round(o.width * 0.55);
  const over = 5;
  const w = o.width + over * 2;
  const top = o.chimney ? 9 : 2;
  const h = top + roofH + wallH + 3;
  const seed = o.seed ?? 3;
  const left = over;
  const wallTop = top + roofH;
  const roof = ROOFS[o.roof];
  const mid = (w - 1) / 2;
  return make(
    w,
    h,
    Math.round(w / 2),
    wallTop + wallH,
    (b) => {
      // Roof: each row spans the full width; the slope shows as shingle rows
      // that run down and away from the ridge on each side.
      for (let y = 0; y < roofH; y++) {
        const t = y / roofH;
        const half = Math.round(5 + t * (w / 2 - 5));
        for (let x = Math.round(mid - half); x <= Math.round(mid + half); x++) {
          const fromRidge = Math.abs(x - mid);
          const right = x > mid;
          // Shingle rows follow the slope: offset by distance from the ridge.
          const course = Math.floor((y + fromRidge * 0.5) / 4);
          const along = (y + fromRidge * 0.5) % 4;
          let c = right ? darken(roof.base, 0.18) : roof.base;
          if (o.roof === "thatch") {
            c =
              noise(x * 2, y, 2, seed) > 0.62
                ? roof.hi
                : noise(x, y * 2, 2.5, seed) < 0.3
                  ? roof.line
                  : c;
          } else if (along < 1) c = right ? roof.eave : roof.line;
          else if ((Math.floor(fromRidge) + course * 3) % 7 === 0)
            c = right ? roof.eave : roof.line;
          else if (!right && along < 2 && fromRidge > 3) c = roof.hi;
          if (fromRidge < 1.5) c = y % 2 === 0 ? roof.hi : roof.line; // ridge cap
          if (y >= roofH - 3) c = y === roofH - 1 ? darken(roof.eave, 0.3) : roof.eave; // eave
          b.set(x, top + y, c);
        }
      }
      // The gable's wall triangle, under the peak, with a small round window.
      const gableH = Math.round(roofH * 0.42);
      for (let y = 0; y < gableH; y++) {
        const half = Math.round((y / gableH) * (o.width * 0.22));
        for (let x = Math.round(mid - half); x <= Math.round(mid + half); x++) {
          b.set(x, wallTop - gableH + y - 2, wallColor(o.wall, x, y + 3, o.width, seed));
        }
      }
      b.ellipse(mid + 0.5, wallTop - gableH * 0.45, 3, 3, E.bark1);
      b.ellipse(mid + 0.5, wallTop - gableH * 0.45, 2, 2, E.blue2);
      b.set(Math.round(mid) - 1, Math.round(wallTop - gableH * 0.45) - 1, E.ice);
      // Front wall.
      for (let y = 0; y < wallH; y++) {
        for (let x = 0; x < o.width; x++) {
          let c = wallColor(o.wall, x, y, o.width, seed);
          if (x === 0) c = mix(c, E.white, 0.15);
          if (x >= o.width - 3) c = darken(c, 0.22);
          b.set(left + x, wallTop + y, c);
        }
        if (o.wall === "logs" && y % 5 === 2) {
          for (const ex of [left - 1, left + o.width - 2]) {
            b.ellipse(ex + 1.5, wallTop + y + 0.5, 2, 2.2, E.sand);
            b.set(ex + 1, wallTop + y, E.bark3);
          }
        }
      }
      // The eave's shadow on the wall.
      for (let x = left; x < left + o.width; x++) {
        b.set(x, wallTop, E.ink, 0.5);
        b.set(x, wallTop + 1, E.ink, 0.3);
        b.set(x, wallTop + 2, E.ink, 0.12);
      }
      if (o.chimney) {
        const cx = Math.round(w * 0.72);
        const surface = top + Math.round(((cx - mid) / (w / 2)) * roofH * 0.35);
        b.rect(cx, surface - 9, 8, 12, E.steel1);
        b.rect(cx + 6, surface - 9, 2, 12, E.steel0);
        b.rect(cx - 1, surface - 10, 10, 2, E.slate1);
        b.set(cx + 2, surface - 6, E.steel0);
        b.set(cx + 4, surface - 2, E.steel0);
      }
      for (const wx of o.windows ?? []) window_(b, left + wx - 4, wallTop + 7);
      if (o.door !== undefined) door(b, left + o.door - 5, wallTop + wallH - 16);
      if (o.sign && o.door !== undefined) {
        const sx = left + o.door - 7;
        const sy = wallTop + 2;
        b.rect(sx, sy, 14, 9, E.tan);
        b.rect(sx, sy + 8, 14, 1, E.bark2);
        b.rect(sx, sy, 1, 9, E.bark2);
        b.rect(sx + 13, sy, 1, 9, E.bark2);
        b.stamp(o.sign.rows, o.sign.palette, sx + 3, sy + 2);
      }
    },
    { a: 0.34 },
  );
}

function window_(b: PixelBuffer, x: number, y: number): void {
  b.rect(x, y, 9, 8, E.bark1);
  b.rect(x + 1, y + 1, 7, 6, E.blue2);
  b.rect(x + 1, y + 1, 3, 2, E.sky);
  b.set(x + 2, y + 3, E.ice);
  b.rect(x + 4, y + 1, 1, 6, E.bark1);
  b.rect(x + 1, y + 4, 7, 1, E.bark1);
  b.rect(x - 1, y + 8, 11, 2, E.tan);
  b.rect(x - 1, y + 9, 11, 1, E.bark2);
}

function door(b: PixelBuffer, x: number, y: number): void {
  b.rect(x, y + 1, 10, 14, E.bark0);
  b.rect(x + 1, y, 8, 1, E.bark0);
  for (let yy = 1; yy < 14; yy++) {
    for (let xx = 1; xx < 9; xx++) {
      if (yy === 1 && (xx === 1 || xx === 8)) continue;
      const c = xx % 3 === 0 ? E.bark1 : xx === 1 ? E.bark3 : E.bark2;
      b.set(x + xx, y + yy, c);
    }
  }
  b.set(x + 7, y + 8, E.gold);
  b.rect(x - 1, y + 15, 12, 2, E.steel1);
  b.rect(x - 1, y + 16, 12, 1, E.steel0);
}

/** An open-fronted shed on posts, for a workshop. */
export function shed(width: number, roof: RoofStyle = "shingle"): Sprite {
  const h = 40;
  const w = width + 8;
  const r = ROOFS[roof];
  return make(
    w,
    h,
    Math.round(w / 2),
    h - 2,
    (b) => {
      // Back wall in shadow, posts in front, a roof over all.
      b.rect(4, 14, width, h - 16, E.bark1);
      for (let x = 4; x < 4 + width; x += 4) b.rect(x, 14, 1, h - 16, E.bark0);
      b.rect(4, h - 5, width, 3, darken(E.bark1, 0.3));
      for (const px of [4, 4 + width - 4]) {
        b.rect(px, 14, 4, h - 16, E.bark2);
        b.rect(px, 14, 1, h - 16, E.bark3);
      }
      // Tools hanging on the back wall.
      b.rect(12, 18, 1, 7, E.bark3);
      b.rect(10, 18, 5, 2, E.steel1);
      b.rect(20, 18, 1, 8, E.bark3);
      b.rect(19, 24, 3, 2, E.steel1);
      b.rect(28, 19, 6, 1, E.steel1);
      b.rect(28, 20, 6, 3, E.mist);
      for (let y = 2; y < 16; y++) {
        const inset = y < 5 ? 5 - y : 0;
        for (let x = inset; x < w - inset; x++) {
          let c = r.base;
          if (y % 4 === 1) c = r.line;
          else if ((x + Math.floor(y / 4) * 3) % 6 === 0) c = r.line;
          else if (y % 4 === 2 && x < w / 2) c = r.hi;
          if (y >= 14) c = r.eave;
          b.set(x, y, c);
        }
      }
    },
    { a: 0.3 },
  );
}

export function lighthouse(): Sprite {
  const w = 30;
  const h = 70;
  return make(
    w,
    h,
    15,
    66,
    (b) => {
      // A tapering tower with red and white bands.
      for (let y = 22; y < 66; y++) {
        const t = (y - 22) / 44;
        const half = 5 + t * 3.5;
        for (let x = Math.round(15 - half); x <= Math.round(15 + half); x++) {
          const band = Math.floor((y - 22) / 8) % 2 === 0;
          let c: Rgb = band ? E.white : E.red;
          const nx = (x - 15) / half;
          if (nx < -0.55) c = band ? E.white : E.coral;
          else if (nx > 0.45) c = band ? E.mist : E.crimson;
          b.set(x, y, c);
        }
      }
      b.rect(12, 58, 6, 8, E.bark1);
      b.rect(13, 59, 4, 7, E.bark2);
      b.rect(13, 40, 3, 4, E.blue1);
      // Gallery, lamp room, glow and cap.
      b.rect(7, 20, 16, 3, E.slate1);
      b.rect(7, 20, 16, 1, E.steel0);
      b.rect(10, 10, 10, 10, E.slate1);
      b.rect(11, 11, 8, 9, E.ice);
      b.rect(13, 13, 4, 5, E.yellow);
      b.rect(14, 14, 2, 3, E.white);
      b.rect(11, 11, 1, 9, E.slate1);
      b.rect(18, 11, 1, 9, E.slate1);
      for (let y = 3; y < 10; y++) {
        const half = (y - 2) * 1.0 + 1;
        b.rect(15 - half, y, half * 2, 1, y < 5 ? E.coral : E.red);
      }
      b.set(15, 2, E.slate1);
      b.set(15, 1, E.slate1);
    },
    { a: 0.3 },
  );
}

export function observatory(): Sprite {
  const w = 44;
  const h = 46;
  return make(
    w,
    h,
    22,
    44,
    (b) => {
      // A round stone tower under a dome, a telescope peeking out of its slit.
      for (let y = 22; y < 44; y++) {
        for (let x = 6; x < 38; x++) {
          const nx = (x - 22) / 16;
          let c = wallColor("stone", x, y, w, 9);
          if (nx < -0.7) c = mix(c, E.white, 0.15);
          if (nx > 0.6) c = darken(c, 0.3);
          b.set(x, y, c);
        }
      }
      b.rect(18, 30, 8, 14, E.bark1);
      b.rect(19, 31, 6, 13, E.bark2);
      b.set(23, 38, E.gold);
      for (let y = 4; y < 23; y++) {
        for (let x = 4; x < 40; x++) {
          const nx = (x + 0.5 - 22) / 18;
          const ny = (y + 0.5 - 23) / 19;
          if (nx * nx + ny * ny > 1) continue;
          const shade = lit(nx, ny);
          const c =
            shade > 0.45 ? E.white : shade > 0 ? E.mist : shade > -0.4 ? E.steel1 : E.steel0;
          b.set(x, y, c);
        }
      }
      b.rect(19, 6, 6, 17, E.slate0);
      b.rect(20, 7, 4, 16, E.dusk);
      for (let i = 0; i < 14; i++) {
        b.set(24 + i, 13 - Math.floor(i * 0.55), E.ochre);
        b.set(24 + i, 14 - Math.floor(i * 0.55), E.amber);
        b.set(24 + i, 15 - Math.floor(i * 0.55), E.bark3);
      }
      b.rect(37, 4, 3, 4, E.gold);
      b.rect(4, 21, 36, 2, E.slate1);
    },
    { a: 0.3 },
  );
}

export function fountain(): Sprite {
  const w = 40;
  const h = 32;
  return make(
    w,
    h,
    20,
    29,
    (b) => {
      b.ellipse(20, 21, 18, 8, E.steel0);
      b.ellipse(20, 20, 18, 7.5, E.mist);
      b.ellipse(20, 20, 15, 5.5, E.blue2);
      b.ellipse(19, 19, 11, 3.5, E.sky);
      b.rect(2, 21, 36, 6, E.steel1);
      b.rect(2, 21, 36, 1, E.mist);
      b.rect(30, 21, 8, 6, E.steel0);
      b.rect(17, 7, 6, 14, E.steel1);
      b.rect(17, 7, 2, 14, E.mist);
      b.rect(21, 7, 2, 14, E.steel0);
      b.ellipse(20, 7, 7, 2.5, E.mist);
      b.ellipse(20, 7, 5, 1.5, E.blue2);
      for (let i = 0; i < 9; i++) {
        b.set(13 + i * 2, 2 + Math.abs(4 - i), E.ice);
        b.set(14 + i * 2, 3 + Math.abs(4 - i), E.white);
      }
      b.rect(19, 0, 2, 5, E.ice);
    },
    { a: 0.25 },
  );
}

export function well(): Sprite {
  return make(
    26,
    32,
    13,
    30,
    (b) => {
      b.rect(5, 6, 2, 16, E.bark2);
      b.rect(19, 6, 2, 16, E.bark1);
      for (let y = 1; y < 8; y++)
        b.rect(
          4 - (y < 3 ? 3 - y : 0) + 2,
          y,
          18 + (y < 3 ? 0 : 0),
          1,
          y % 3 === 2 ? E.bark2 : E.bark3,
        );
      b.rect(2, 7, 22, 2, E.bark1);
      b.rect(7, 10, 12, 1, E.bark1);
      b.rect(12, 11, 1, 4, E.gray2);
      b.rect(11, 14, 4, 3, E.bark3);
      b.ellipse(13, 23, 10, 4, E.steel0);
      b.ellipse(13, 22, 9.5, 3.5, E.steel1);
      b.ellipse(13, 22, 6.5, 2, E.navy);
      b.rect(3, 22, 20, 6, E.steel1);
      for (let x = 3; x < 23; x += 5) b.rect(x, 22, 1, 6, E.slate1);
      b.rect(3, 25, 20, 1, E.slate1);
    },
    { a: 0.3 },
  );
}

export function boat(): Sprite {
  return make(
    36,
    18,
    18,
    14,
    (b) => {
      for (let y = 3; y < 14; y++) {
        const t = (y - 3) / 11;
        const half = 15 - Math.abs(t - 0.4) * 14;
        for (let x = Math.round(18 - half); x <= Math.round(18 + half); x++) {
          const edge = x <= Math.round(18 - half) + 1 || x >= Math.round(18 + half) - 1 || y <= 4;
          b.set(x, y, edge ? E.bark2 : y > 11 ? E.bark1 : E.bark3);
        }
      }
      b.rect(10, 6, 2, 6, E.tan);
      b.rect(24, 6, 2, 6, E.tan);
      b.rect(4, 8, 28, 1, E.bark1);
      b.rect(15, 2, 1, 10, E.bark1);
      b.rect(13, 1, 5, 2, E.mist);
    },
    { a: 0.25 },
  );
}

// ── Work stations ────────────────────────────────────────────

export function bookshelf(seed: number, tall = false): Sprite {
  const h = tall ? 30 : 24;
  return make(
    20,
    h + 2,
    10,
    h,
    (b) => {
      b.rect(1, 0, 18, h, E.bark1);
      b.rect(2, 1, 16, h - 2, E.bark0);
      const rnd = stream(seed);
      const spines = [E.crimson, E.blue1, E.green1, E.gold, E.plum, E.rust, E.teal0, E.rose];
      for (let shelf = 0; shelf * 6 + 6 <= h - 2; shelf++) {
        const base = 2 + shelf * 6 + 5;
        let x = 2;
        while (x < 17) {
          const bw = 1 + Math.floor(rnd() * 2);
          const bh = 3 + Math.floor(rnd() * 2);
          const color = spines[Math.floor(rnd() * spines.length)] ?? E.crimson;
          if (rnd() > 0.12) {
            b.rect(x, base - bh, bw, bh, color);
            b.set(x, base - bh, mix(color, E.white, 0.35));
          }
          x += bw;
        }
        b.rect(1, base, 18, 1, E.bark2);
        b.rect(2, base, 15, 1, E.bark3);
      }
      b.rect(0, 0, 20, 2, E.bark2);
      b.rect(0, 0, 20, 1, E.bark3);
    },
    { a: 0.3 },
  );
}

export function workbench(): Sprite {
  return make(
    30,
    20,
    15,
    18,
    (b) => {
      // Top (seen from above), front apron and legs; tools on top.
      b.rect(1, 6, 28, 5, E.bark3);
      b.rect(1, 6, 28, 1, E.tan);
      b.rect(1, 11, 28, 3, E.bark2);
      b.rect(1, 13, 28, 1, E.bark1);
      b.rect(2, 14, 3, 4, E.bark1);
      b.rect(25, 14, 3, 4, E.bark1);
      b.rect(2, 7, 4, 3, E.steel0);
      b.rect(3, 4, 2, 3, E.steel1);
      b.rect(9, 3, 9, 3, E.mist);
      b.rect(9, 5, 9, 1, E.steel0);
      b.rect(18, 3, 3, 3, E.bark2);
      b.rect(22, 6, 6, 2, E.sand);
      b.rect(23, 4, 1, 3, E.bark3);
      b.rect(21, 3, 5, 2, E.slate1);
      b.set(12, 8, E.sand);
      b.set(15, 9, E.sand);
    },
    { a: 0.3 },
  );
}

export function forge(): Sprite {
  return make(
    26,
    30,
    13,
    28,
    (b) => {
      // A hood and chimney over a stone hearth with a glowing mouth.
      b.rect(9, 0, 8, 10, E.steel0);
      b.rect(9, 0, 2, 10, E.steel1);
      b.rect(4, 9, 18, 4, E.slate1);
      b.rect(4, 9, 18, 1, E.steel0);
      for (let y = 13; y < 28; y++) {
        for (let x = 2; x < 24; x++) {
          let c = wallColor("stone", x, y, 26, 4);
          if (x > 20) c = darken(c, 0.3);
          b.set(x, y, c);
        }
      }
      b.ellipse(13, 21, 6, 4, E.bark0);
      b.ellipse(13, 21.5, 5, 3, E.orange);
      b.ellipse(13, 22, 3.5, 2, E.amber);
      b.ellipse(13, 22.5, 2, 1, E.yellow);
      b.rect(2, 26, 22, 2, E.slate1);
    },
    { a: 0.3 },
  );
}

export function anvil(): Sprite {
  return make(
    18,
    14,
    9,
    12,
    (b) => {
      b.rect(5, 7, 8, 5, E.bark2);
      b.rect(5, 7, 2, 5, E.bark3);
      b.ellipse(9, 7, 4, 1.5, E.sand);
      b.rect(3, 2, 13, 3, E.slate1);
      b.rect(3, 2, 13, 1, E.steel0);
      b.rect(1, 2, 2, 2, E.slate1);
      b.rect(7, 5, 5, 2, E.slate0);
      b.set(5, 2, E.steel1);
      b.set(9, 2, E.steel1);
    },
    { a: 0.3 },
  );
}

export function mapTable(): Sprite {
  return make(
    28,
    18,
    14,
    16,
    (b) => {
      b.rect(1, 3, 26, 8, E.bark3);
      b.rect(1, 3, 26, 1, E.tan);
      b.rect(1, 11, 26, 2, E.bark2);
      b.rect(3, 13, 2, 3, E.bark1);
      b.rect(23, 13, 2, 3, E.bark1);
      // The map: parchment, a coast, a dotted route and an X.
      b.rect(4, 2, 18, 8, E.cream);
      b.rect(4, 9, 18, 1, E.sand);
      b.rect(5, 3, 6, 4, E.sky);
      b.rect(5, 6, 3, 2, E.sky);
      b.rect(10, 4, 4, 3, E.green3);
      for (let x = 12; x < 19; x += 2) b.set(x, 7, E.bark2);
      b.set(19, 5, E.red);
      b.set(20, 6, E.red);
      b.set(20, 5, E.red);
      b.set(19, 6, E.red);
      b.rect(22, 4, 3, 5, E.sand);
      b.rect(22, 4, 3, 1, E.tan);
    },
    { a: 0.3 },
  );
}

export function telescope(): Sprite {
  return make(18, 22, 9, 20, (b) => {
    for (let i = 0; i < 9; i++) {
      b.set(9 - Math.floor(i / 2), 11 + i, E.bark2);
      b.set(9 + Math.floor(i / 2), 11 + i, E.bark1);
      b.set(9, 11 + i, E.bark2);
    }
    for (let i = 0; i < 11; i++) {
      const y = 11 - Math.floor(i * 0.7);
      b.set(4 + i, y, E.amber);
      b.set(4 + i, y - 1, E.gold);
      b.set(4 + i, y + 1, E.ochre);
    }
    b.rect(14, 2, 3, 4, E.slate1);
    b.set(15, 3, E.sky);
  });
}

export function computer(): Sprite {
  return make(
    30,
    30,
    13,
    28,
    (b) => {
      // A desk with a glowing monitor, and a dish on a pole.
      b.rect(1, 17, 22, 5, E.bark3);
      b.rect(1, 17, 22, 1, E.tan);
      b.rect(1, 22, 22, 2, E.bark2);
      b.rect(2, 24, 2, 4, E.bark1);
      b.rect(20, 24, 2, 4, E.bark1);
      b.rect(4, 4, 15, 12, E.steel1);
      b.rect(4, 4, 15, 1, E.mist);
      b.rect(5, 5, 13, 9, E.navy);
      b.rect(6, 6, 7, 1, E.cyan);
      b.rect(6, 8, 10, 1, E.sky);
      b.rect(6, 10, 5, 1, E.cyan);
      b.rect(6, 12, 8, 1, E.sky);
      b.rect(10, 16, 3, 1, E.steel0);
      b.rect(6, 18, 11, 2, E.mist);
      b.rect(6, 19, 11, 1, E.steel1);
      b.rect(25, 8, 1, 20, E.slate1);
      b.ellipse(25, 6, 4, 3, E.mist);
      b.ellipse(25.5, 6.5, 2.5, 1.8, E.steel1);
      b.set(25, 2, E.red);
    },
    { a: 0.3 },
  );
}

export function noticeBoard(seed: number): Sprite {
  return make(
    28,
    28,
    14,
    26,
    (b) => {
      b.rect(3, 6, 2, 20, E.bark2);
      b.rect(23, 6, 2, 20, E.bark1);
      b.rect(1, 2, 26, 3, E.bark1);
      b.rect(1, 2, 26, 1, E.bark2);
      b.rect(2, 5, 24, 15, E.bark2);
      b.rect(3, 6, 22, 13, E.bark3);
      const rnd = stream(seed);
      const papers = [E.cream, E.pink, E.yellow, E.ice, E.cream];
      for (let i = 0; i < 5; i++) {
        const x = 4 + Math.floor(rnd() * 15);
        const y = 7 + Math.floor(rnd() * 6);
        const color = papers[i] ?? E.cream;
        b.rect(x, y, 5, 5, color);
        b.rect(x + 1, y + 2, 3, 1, E.steel1);
        b.rect(x + 1, y + 3, 2, 1, E.steel1);
        b.set(x + 2, y, E.red);
      }
    },
    { a: 0.3 },
  );
}

export function mailbox(): Sprite {
  return make(
    14,
    20,
    6,
    18,
    (b) => {
      b.rect(5, 8, 2, 10, E.bark2);
      b.rect(1, 2, 10, 7, E.red);
      b.rect(1, 2, 10, 1, E.coral);
      b.rect(9, 2, 2, 7, E.crimson);
      b.rect(1, 8, 10, 1, E.crimson);
      b.rect(3, 4, 5, 1, E.brick);
      b.rect(11, 1, 1, 6, E.slate1);
      b.rect(12, 1, 2, 2, E.gold);
    },
    { a: 0.3 },
  );
}

export function campfire(): Sprite {
  return make(
    20,
    20,
    10,
    16,
    (b) => {
      const stones: Array<[number, number]> = [
        [3, 14],
        [6, 16],
        [10, 17],
        [14, 16],
        [17, 14],
        [5, 11],
        [15, 11],
      ];
      b.rect(5, 12, 10, 3, E.bark2);
      b.rect(6, 13, 8, 1, E.bark3);
      b.rect(8, 10, 4, 5, E.bark1);
      for (const [x, y] of stones) {
        b.ellipse(x, y, 2, 1.5, E.steel1);
        b.set(x - 1, y - 1, E.mist);
      }
      // Flames: a gold heart in orange tongues.
      b.ellipse(10, 9, 4, 5, E.orange);
      b.ellipse(10, 10, 3, 3.5, E.amber);
      b.ellipse(10, 11, 1.5, 2, E.yellow);
      b.set(8, 3, E.amber);
      b.set(12, 4, E.orange);
      b.set(10, 2, E.gold);
    },
    { a: 0.2 },
    true,
  );
}

export function fence(posts: number): Sprite {
  const w = posts * 12 + 2;
  return make(
    w + 2,
    16,
    Math.round(w / 2) + 1,
    14,
    (b) => {
      b.rect(2, 4, w - 2, 2, E.bark3);
      b.rect(2, 5, w - 2, 1, E.bark2);
      b.rect(2, 9, w - 2, 2, E.bark3);
      b.rect(2, 10, w - 2, 1, E.bark2);
      for (let i = 0; i < posts; i++) {
        const x = 1 + i * 12;
        b.rect(x, 2, 4, 12, E.bark2);
        b.rect(x, 2, 1, 12, E.bark3);
        b.rect(x + 3, 2, 1, 12, E.bark1);
        b.rect(x, 1, 4, 2, E.sand);
      }
    },
    { a: 0.22 },
  );
}

export function lampPost(): Sprite {
  return make(
    12,
    30,
    6,
    28,
    (b) => {
      b.rect(5, 9, 2, 19, E.slate1);
      b.rect(5, 9, 1, 19, E.steel0);
      b.rect(3, 26, 6, 2, E.slate1);
      b.rect(3, 3, 6, 7, E.slate1);
      b.rect(4, 4, 4, 5, E.gold);
      b.rect(5, 5, 2, 3, E.yellow);
      b.rect(2, 2, 8, 2, E.slate0);
      b.set(6, 1, E.slate0);
    },
    { a: 0.25 },
  );
}

export function signpost(): Sprite {
  return make(18, 22, 8, 20, (b) => {
    b.rect(7, 4, 2, 16, E.bark2);
    b.rect(2, 4, 13, 4, E.tan);
    b.rect(2, 7, 13, 1, E.bark2);
    b.set(15, 5, E.tan);
    b.set(15, 6, E.tan);
    b.rect(3, 10, 12, 4, E.tan);
    b.rect(3, 13, 12, 1, E.bark2);
    b.set(2, 11, E.tan);
    b.set(2, 12, E.tan);
    b.rect(4, 5, 7, 1, E.bark2);
    b.rect(6, 11, 6, 1, E.bark2);
  });
}

export function hayBale(): Sprite {
  return make(
    18,
    14,
    9,
    12,
    (b) => {
      b.rect(1, 2, 16, 10, E.gold);
      b.rect(1, 2, 16, 3, E.yellow);
      b.rect(1, 9, 16, 3, E.ochre);
      for (let x = 2; x < 17; x += 3) b.set(x, 6, E.ochre);
      b.rect(5, 2, 1, 10, E.bark3);
      b.rect(12, 2, 1, 10, E.bark3);
    },
    { a: 0.3 },
  );
}

export function crate(): Sprite {
  return make(
    14,
    14,
    7,
    12,
    (b) => {
      b.rect(1, 1, 12, 11, E.tan);
      b.rect(1, 1, 12, 1, E.sand);
      b.rect(1, 1, 1, 11, E.bark3);
      b.rect(12, 1, 1, 11, E.bark3);
      b.rect(1, 11, 12, 1, E.bark3);
      b.rect(1, 6, 12, 1, E.bark3);
      for (let i = 0; i < 10; i++) b.set(2 + i, 1 + Math.floor(i * 1.0), E.bark3);
    },
    { a: 0.3 },
  );
}

export function barrel(): Sprite {
  return make(
    14,
    16,
    7,
    14,
    (b) => {
      b.rect(2, 2, 10, 12, E.bark2);
      b.rect(3, 2, 3, 12, E.bark3);
      b.rect(10, 2, 2, 12, E.bark1);
      b.rect(2, 4, 10, 1, E.steel0);
      b.rect(2, 11, 10, 1, E.steel0);
      b.ellipse(7, 2, 5, 1.6, E.bark3);
      b.ellipse(7, 2, 3, 0.8, E.bark1);
    },
    { a: 0.3 },
  );
}

export function crops(kind: "cabbage" | "carrot" | "wheat" | "berry", seed: number): Sprite {
  return make(
    14,
    14,
    7,
    12,
    (b) => {
      if (kind === "wheat") {
        for (let i = 0; i < 4; i++) {
          const x = 3 + i * 3;
          b.rect(x, 4, 1, 8, E.ochre);
          b.rect(x - 1, 2, 2, 4, E.gold);
          b.set(x, 1, E.yellow);
        }
        return;
      }
      clump(b, 7, 8, 4.5, LEAVES, seed);
      if (kind === "cabbage") {
        b.ellipse(7, 8, 3, 2.5, E.leaf);
        b.ellipse(7, 8, 1.5, 1.2, E.lime);
      } else if (kind === "carrot") {
        b.rect(5, 11, 4, 2, E.orange);
        b.set(6, 11, E.amber);
      } else {
        for (const [x, y] of [
          [5, 6],
          [9, 7],
          [7, 10],
        ] as const) {
          b.set(x, y, E.red);
          b.set(x, y - 1, E.rose);
        }
      }
    },
    { a: 0.25 },
  );
}

export function pumpkin(): Sprite {
  return make(14, 12, 7, 10, (b) => {
    b.ellipse(7, 7, 6, 4, E.orange);
    b.ellipse(5, 6, 2, 3, E.amber);
    b.rect(7, 4, 1, 6, E.rust);
    b.rect(10, 4, 1, 6, E.rust);
    b.rect(6, 1, 2, 3, E.green1);
  });
}

export function reeds(seed: number): Sprite {
  return make(12, 16, 6, 14, (b) => {
    const rnd = stream(seed);
    for (let i = 0; i < 3; i++) {
      const x = 2 + i * 3 + Math.floor(rnd() * 2);
      const top = 2 + Math.floor(rnd() * 4);
      b.rect(x, top + 3, 1, 14 - top - 3, E.green1);
      b.rect(x, top, 1, 3, E.bark2);
      b.set(x + 1, top + 6, E.green3);
    }
  });
}

export function lilyPad(flower: boolean): Sprite {
  return make(14, 10, 7, 7, (b) => {
    b.ellipse(7, 5, 5.5, 3.5, E.green2);
    b.ellipse(6, 4, 3.5, 2, E.green3);
    b.rect(7, 2, 1, 3, E.green1);
    if (flower) {
      b.set(9, 3, E.pink);
      b.set(10, 3, E.orchid);
      b.set(9, 2, E.white);
    }
  });
}

/** The arrivals gate: two posts, a crossbeam and a sign. */
export function gate(): Sprite {
  return make(
    46,
    36,
    23,
    34,
    (b) => {
      b.rect(3, 6, 5, 28, E.bark2);
      b.rect(3, 6, 1, 28, E.bark3);
      b.rect(38, 6, 5, 28, E.bark1);
      b.rect(1, 4, 44, 4, E.bark2);
      b.rect(1, 4, 44, 1, E.bark3);
      b.rect(1, 1, 3, 4, E.bark2);
      b.rect(42, 1, 3, 4, E.bark1);
      b.rect(13, 9, 20, 8, E.tan);
      b.rect(13, 16, 20, 1, E.bark2);
      b.rect(15, 9, 1, 2, E.bark1);
      b.rect(30, 9, 1, 2, E.bark1);
      // A little critter-paw mark on the sign.
      b.rect(21, 12, 4, 3, E.bark2);
      b.set(20, 11, E.bark2);
      b.set(22, 10, E.bark2);
      b.set(24, 10, E.bark2);
      b.set(26, 11, E.bark2);
    },
    { a: 0.25 },
  );
}

// ── Indoors ──────────────────────────────────────────────────

export function desk(): Sprite {
  return make(
    28,
    22,
    14,
    20,
    (b) => {
      b.rect(1, 9, 26, 6, E.bark3);
      b.rect(1, 9, 26, 1, E.tan);
      b.rect(1, 15, 26, 2, E.bark2);
      b.rect(2, 17, 2, 3, E.bark1);
      b.rect(24, 17, 2, 3, E.bark1);
      b.rect(7, 1, 14, 9, E.slate1);
      b.rect(8, 2, 12, 6, E.navy);
      b.rect(9, 3, 6, 1, E.cyan);
      b.rect(9, 5, 9, 1, E.sky);
      b.rect(12, 9, 4, 1, E.slate0);
      b.rect(3, 11, 4, 3, E.cream);
      b.rect(21, 10, 3, 3, E.white);
      b.rect(22, 9, 1, 1, E.bark3);
    },
    { a: 0.3 },
  );
}

export function serverRack(seed: number): Sprite {
  return make(
    16,
    30,
    8,
    28,
    (b) => {
      b.rect(1, 1, 14, 27, E.slate0);
      b.rect(1, 1, 14, 1, E.steel0);
      b.rect(1, 1, 1, 27, E.slate1);
      const rnd = stream(seed);
      for (let y = 3; y < 26; y += 3) {
        b.rect(3, y, 10, 2, E.dusk);
        b.set(4, y, rnd() > 0.4 ? E.green3 : E.amber);
        b.set(6, y, rnd() > 0.6 ? E.sky : E.dusk);
        b.rect(9, y + 1, 3, 1, E.slate1);
      }
    },
    { a: 0.3 },
  );
}

export function whiteboard(): Sprite {
  return make(
    30,
    28,
    15,
    26,
    (b) => {
      b.rect(4, 18, 2, 8, E.steel0);
      b.rect(24, 18, 2, 8, E.steel0);
      b.rect(1, 1, 28, 18, E.steel1);
      b.rect(2, 2, 26, 15, E.white);
      b.rect(4, 4, 10, 1, E.blue1);
      b.rect(4, 6, 7, 1, E.blue1);
      b.rect(16, 4, 9, 6, E.mist);
      b.rect(17, 5, 3, 2, E.red);
      b.rect(21, 7, 3, 2, E.green2);
      b.rect(4, 9, 8, 1, E.red);
      b.rect(4, 12, 20, 1, E.steel1);
      b.rect(4, 14, 14, 1, E.steel1);
      b.rect(2, 17, 26, 2, E.steel0);
      b.rect(6, 17, 3, 1, E.red);
      b.rect(10, 17, 3, 1, E.blue1);
    },
    { a: 0.3 },
  );
}

export function sofa(): Sprite {
  return make(
    38,
    20,
    19,
    18,
    (b) => {
      b.rect(3, 2, 32, 8, E.plum);
      b.rect(3, 2, 32, 2, E.violet);
      b.rect(1, 6, 36, 10, E.violet);
      b.rect(1, 6, 5, 10, E.plum);
      b.rect(32, 6, 5, 10, E.wine);
      b.rect(6, 7, 13, 6, E.orchid);
      b.rect(19, 7, 13, 6, E.orchid);
      b.rect(19, 7, 1, 6, E.violet);
      b.rect(1, 15, 36, 1, E.wine);
      b.rect(3, 16, 2, 2, E.bark1);
      b.rect(33, 16, 2, 2, E.bark1);
    },
    { a: 0.3 },
  );
}

export function plantPot(seed: number): Sprite {
  return make(
    16,
    22,
    8,
    20,
    (b) => {
      clump(b, 8, 7, 5, LEAVES, seed);
      clump(b, 5, 9, 3.5, LEAVES, seed + 1);
      clump(b, 11, 9, 3.5, LEAVES, seed + 2);
      b.rect(4, 13, 8, 7, E.rust);
      b.rect(3, 13, 10, 2, E.orange);
      b.rect(10, 15, 2, 5, E.brick);
    },
    { a: 0.3 },
  );
}

export function coffeeBar(): Sprite {
  return make(
    26,
    22,
    13,
    20,
    (b) => {
      b.rect(1, 10, 24, 10, E.bark2);
      b.rect(1, 10, 24, 2, E.bark3);
      b.rect(1, 10, 24, 1, E.tan);
      b.rect(4, 2, 8, 9, E.slate1);
      b.rect(5, 3, 6, 3, E.steel0);
      b.set(7, 4, E.red);
      b.rect(6, 7, 3, 2, E.cream);
      b.rect(15, 7, 3, 3, E.white);
      b.rect(19, 7, 3, 3, E.rose);
      b.rect(14, 12, 9, 6, E.bark1);
    },
    { a: 0.3 },
  );
}

export function rug(w: number, h: number): Sprite {
  return make(
    w,
    h,
    Math.round(w / 2),
    h,
    (b) => {
      b.rect(0, 0, w, h, E.crimson);
      b.rect(1, 1, w - 2, h - 2, E.rose);
      b.rect(3, 3, w - 6, h - 6, E.crimson);
      for (let x = 5; x < w - 5; x += 4) {
        b.set(x, Math.floor(h / 2), E.gold);
        b.set(x + 1, Math.floor(h / 2) - 1, E.gold);
        b.set(x + 1, Math.floor(h / 2) + 1, E.gold);
      }
    },
    undefined,
    false,
  );
}

// ── Icons for signs ──────────────────────────────────────────

export interface Icon {
  readonly rows: readonly string[];
  readonly palette: Readonly<Record<string, Rgb>>;
}

const ICON_PALETTE: Readonly<Record<string, Rgb>> = {
  o: E.bark1,
  r: E.crimson,
  b: E.blue1,
  w: E.cream,
  g: E.steel0,
  y: E.gold,
  s: E.slate1,
};

export const ICONS = {
  book: { rows: ["rrr.bbb", "rwr.bwb", "rwr.bwb", "rrrobbb"], palette: ICON_PALETTE },
  hammer: { rows: ["ggggg..", "ggggg..", "..o....", "..o....", "..o...."], palette: ICON_PALETTE },
  letter: { rows: ["wwwwwww", "wrw.wrw", "ww.r.ww", "wwwwwww"], palette: ICON_PALETTE },
  star: { rows: ["...y...", "..yyy..", "yyyyyyy", ".yy.yy.", "y.....y"], palette: ICON_PALETTE },
  gear: { rows: [".s.s.", "sssss", "ss.ss", "sssss", ".s.s."], palette: ICON_PALETTE },
} as const satisfies Record<string, Icon>;
