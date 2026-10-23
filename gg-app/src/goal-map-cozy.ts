// Cosy, rural-Japan props for the top-down Goal map: a thatched minka with a
// wooden engawa (veranda) and shoji screens, sakura and camellia, clipped
// shrubs, stone lanterns, a koi pond with a bamboo spout, a little shrine, and
// the odds and ends that make a farm feel lived in. Same rules as
// goal-map-props.ts: light from the top left, tinted outlines, pure.

import { BARK_CHERRY, barkTrunk } from "./goal-map-bark";
import {
  PixelBuffer,
  WARM_INK,
  darken,
  hash,
  mix,
  noise,
  stream,
  type Rgb,
} from "./goal-map-pixels";
import type { Sprite } from "./goal-map-props";

/** A warm, earthy palette for this world (sampled from cosy farm sims). */
export const K = {
  grass: 0x889a15,
  grassLight: 0x9cb344,
  grassDark: 0x687e19,
  grassDeep: 0x49550c,
  soil: 0xd08f35,
  soilLight: 0xdcab6f,
  soilDark: 0xac7841,
  soilDeep: 0x8a6125,
  thatch: 0x9a6b2d,
  thatchLight: 0xc08a47,
  thatchDark: 0x805123,
  thatchDeep: 0x5c3a14,
  wood: 0xac7841,
  woodLight: 0xd09b5a,
  woodDark: 0x863f17,
  woodDeep: 0x4c0602,
  paper: 0xe9dbb9,
  paperShade: 0xd6c7ad,
  stone: 0xc8c3bd,
  stoneLight: 0xe8e4de,
  stoneDark: 0x948d86,
  stoneDeep: 0x6a635e,
  sakura: 0xf2b6c6,
  sakuraLight: 0xfbd8e0,
  sakuraDark: 0xd98aa2,
  sakuraDeep: 0xae5f7c,
  camellia: 0xd8394a,
  camelliaDark: 0x9e2236,
  leaf: 0x6a8a2a,
  leafLight: 0x8fae3c,
  leafDark: 0x4a6418,
  leafDeep: 0x2f4210,
  pine: 0x587a3a,
  pineDark: 0x3c5628,
  moss: 0x94b349,
  water: 0x9ee0d8,
  waterLight: 0xd6f5ef,
  waterDark: 0x5fb8b8,
  koi: 0xe8742a,
  bamboo: 0xb8c45a,
  bambooDark: 0x7f8f2c,
  lantern: 0xffcf6a,
  ember: 0xff8a2a,
} as const;

function make(
  w: number,
  h: number,
  ax: number,
  ay: number,
  draw: (b: PixelBuffer) => void,
  shadow?: Sprite["shadow"],
  outline = true,
): Sprite {
  const buf = new PixelBuffer(w, h);
  draw(buf);
  // Warm outlines: this world's line work is dark brown, not purple-black.
  if (outline) buf.outline(0.72, WARM_INK);
  return { buf, ax, ay, ...(shadow ? { shadow } : {}) };
}

interface Tones {
  readonly hi: Rgb;
  readonly light: Rgb;
  readonly base: Rgb;
  readonly dark: Rgb;
  readonly deep: Rgb;
}

/** Blossom, from a near-white lit edge down to a deep rose in the shade
 * (wider than the petal colours themselves, so the clumps model). */
const SAKURA: Tones = {
  hi: 0xfff0f4,
  light: K.sakuraLight,
  base: K.sakura,
  dark: mix(K.sakuraDark, 0xb0587a, 0.35),
  deep: mix(K.sakuraDeep, 0x6a2a4a, 0.3),
};
const LEAF: Tones = {
  hi: K.leafLight,
  light: mix(K.leaf, K.leafLight, 0.5),
  base: K.leaf,
  dark: K.leafDark,
  deep: K.leafDeep,
};
const OLIVE: Tones = {
  hi: 0xb9b04a,
  light: 0x9c9a3a,
  base: 0x84822e,
  dark: 0x636224,
  deep: 0x45441a,
};
const AMBER: Tones = {
  hi: 0xd9a24a,
  light: 0xc0862f,
  base: 0xa66d22,
  dark: 0x84521a,
  deep: 0x5e3910,
};

/** A rounded, bumpy clump of foliage, shaded on its own. */
function clump(b: PixelBuffer, cx: number, cy: number, r: number, t: Tones, seed: number): void {
  // The shade this clump throws on whatever it overlaps: a band just below
  // and right of its rim, where the sun (up and left) can't reach.
  for (let y = Math.floor(cy - r); y <= cy + r + 3; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r + 3; x++) {
      if (!b.opaque(x, y)) continue;
      if (Math.hypot(x + 0.5 - cx - 1.4, y + 0.5 - cy - 1.6) > r + 0.4) continue;
      b.set(x, y, t.deep, 0.5);
    }
  }
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.hypot(dx, dy);
      const rim = r + (noise(x, y, 2, seed) - 0.5) * 1.6;
      if (dist > rim) continue;
      // Lit from the top left as one dome, in solid steps; the noise only
      // nudges the steps, so the clump reads as a shape, not a smear.
      const shade = -(dx / r) * 0.55 - (dy / r) * 0.8 + (noise(x, y, 3, seed + 3) - 0.5) * 0.22;
      const edge = rim - dist;
      let c =
        shade > 0.6
          ? t.hi
          : shade > 0.2
            ? t.light
            : shade > -0.3
              ? t.base
              : shade > -0.75
                ? t.dark
                : t.deep;
      // A dark lower rim and a lit upper-left one, a pixel each.
      if (edge < 1 && dy > -r * 0.15) c = t.deep;
      else if (edge < 1 && dx < r * 0.2 && dy < 0) c = t.hi;
      // Little cups of blossom or leaf: a lit top over its own shade, in a
      // loose staggered grid across the lit half.
      const row = Math.floor(y / 3);
      const sx = x + (row % 2) * 2;
      if (shade > -0.25 && edge > 1.2 && hash(Math.floor(sx / 4), row, seed + 7) < 0.45) {
        if (y % 3 === 0 && sx % 4 > 0 && sx % 4 < 3) c = shade > 0.3 ? t.hi : t.light;
        else if (y % 3 === 1 && sx % 4 === 3) c = shade > 0.3 ? t.base : t.dark;
      }
      b.set(x, y, c);
    }
  }
}

/** A trunk from its left edge `x` and top `y`, `w` wide and `h` tall (see goal-map-bark.ts). */
function trunk(
  b: PixelBuffer,
  x: number,
  y: number,
  w: number,
  h: number,
  seed: number,
  lean = 0,
  cherry = false,
): void {
  barkTrunk(b, {
    x: x + w / 2,
    foot: y + h - 1,
    top: y,
    width: w,
    lean: lean * 3,
    seed,
    ...(cherry ? { tones: BARK_CHERRY, lenticels: true } : {}),
  });
}

// ── Trees ────────────────────────────────────────────────────

/** A cherry tree in bloom, with a few petals on the ground below. */
export function sakuraTree(seed: number, large = true): Sprite {
  const R = large ? 15 : 11;
  const w = R * 2 + 10;
  const cy = R + 3;
  const trunkTop = Math.round(cy + R * 0.45);
  const trunkH = large ? 14 : 10;
  const h = trunkTop + trunkH + 4;
  const cx = w / 2;
  const rnd = stream(seed);
  return make(
    w,
    h,
    Math.round(cx),
    trunkTop + trunkH,
    (b) => {
      trunk(b, Math.round(cx - 2), trunkTop, large ? 5 : 4, trunkH, seed, 0.6, true);
      const blobs: Array<[number, number, number]> = [
        [0, 0, R * 0.62],
        [-R * 0.5, -R * 0.15, R * 0.5],
        [R * 0.48, -R * 0.2, R * 0.5],
        [0, -R * 0.52, R * 0.48],
        [-R * 0.3, R * 0.42, R * 0.46],
        [R * 0.34, R * 0.42, R * 0.45],
      ];
      blobs.sort((a, bb) => a[1] - bb[1]);
      for (const [ox, oy, r] of blobs) {
        clump(b, cx + ox + (rnd() - 0.5) * 2, cy + oy + (rnd() - 0.5) * 2, r, SAKURA, seed + 5);
      }
    },
    { a: 0.28, canopy: true },
  );
}

/** A small round-leafed tree heavy with red camellias. */
export function camelliaTree(seed: number): Sprite {
  const R = 11;
  const w = R * 2 + 8;
  const cy = R + 3;
  const trunkTop = Math.round(cy + R * 0.5);
  const h = trunkTop + 12;
  const cx = w / 2;
  return make(
    w,
    h,
    Math.round(cx),
    trunkTop + 9,
    (b) => {
      trunk(b, Math.round(cx - 2), trunkTop, 4, 9, seed);
      clump(b, cx - 4, cy + 1, R * 0.62, LEAF, seed);
      clump(b, cx + 4, cy + 1, R * 0.62, LEAF, seed + 1);
      clump(b, cx, cy - 4, R * 0.6, LEAF, seed + 2);
      // Blossoms: little red rosettes with a bright centre.
      const rnd = stream(seed + 9);
      for (let i = 0; i < 14; i++) {
        const x = Math.round(cx - R + 2 + rnd() * (R * 2 - 4));
        const y = Math.round(cy - R + 2 + rnd() * (R * 2 - 4));
        if (!b.opaque(x, y)) continue;
        b.set(x, y, K.camellia);
        b.set(x + 1, y, K.camellia);
        b.set(x, y + 1, K.camelliaDark);
        b.set(x + 1, y + 1, K.camellia);
        b.set(x, y - 1, mix(K.camellia, K.sakuraLight, 0.4));
      }
    },
    { a: 0.28, canopy: true },
  );
}

/** A citrus tree, with yuzu-yellow fruit. */
export function yuzuTree(seed: number): Sprite {
  const R = 10;
  const w = R * 2 + 8;
  const cy = R + 3;
  const trunkTop = Math.round(cy + R * 0.5);
  const cx = w / 2;
  return make(
    w,
    trunkTop + 13,
    Math.round(cx),
    trunkTop + 10,
    (b) => {
      trunk(b, Math.round(cx - 1), trunkTop, 3, 10, seed, -0.5);
      clump(b, cx - 3, cy + 1, R * 0.6, LEAF, seed);
      clump(b, cx + 4, cy, R * 0.58, LEAF, seed + 1);
      clump(b, cx, cy - 4, R * 0.55, LEAF, seed + 2);
      const rnd = stream(seed + 4);
      for (let i = 0; i < 9; i++) {
        const x = Math.round(cx - R + 3 + rnd() * (R * 2 - 6));
        const y = Math.round(cy - R + 3 + rnd() * (R * 2 - 5));
        if (!b.opaque(x, y)) continue;
        b.rect(x, y, 2, 2, 0xf2c933);
        b.set(x, y, 0xfbe68a);
      }
    },
    { a: 0.28, canopy: true },
  );
}

/** A broad, gnarled shade tree with flat, layered clouds of leaves (niwaki style). */
export function niwakiTree(seed: number): Sprite {
  const w = 44;
  const h = 46;
  return make(
    w,
    h,
    22,
    43,
    (b) => {
      // A twisting trunk with two arms.
      for (let y = 22; y < 43; y++) {
        const off = Math.round(Math.sin(y / 5 + seed) * 2);
        for (let x = 0; x < 5; x++) {
          b.set(20 + off + x, y, x === 0 ? K.woodLight : x >= 3 ? K.woodDeep : K.woodDark);
        }
      }
      for (let i = 0; i < 9; i++) {
        b.set(19 - i, 24 - Math.round(i * 0.6), K.woodDark);
        b.set(19 - i, 25 - Math.round(i * 0.6), K.woodDeep);
        b.set(25 + i, 22 - Math.round(i * 0.5), K.woodDark);
        b.set(25 + i, 23 - Math.round(i * 0.5), K.woodDeep);
      }
      // Cloud pads.
      clump(b, 10, 17, 7, LEAF, seed);
      clump(b, 34, 15, 7.5, LEAF, seed + 1);
      clump(b, 22, 9, 8, LEAF, seed + 2);
    },
    { a: 0.28, canopy: true },
  );
}

/** A clipped, round shrub (o-karikomi); olive, green or autumn-amber. */
export function roundShrub(
  seed: number,
  kind: "green" | "olive" | "amber" = "green",
  large = false,
): Sprite {
  const r = large ? 12 : 9;
  const tones = kind === "olive" ? OLIVE : kind === "amber" ? AMBER : LEAF;
  const w = r * 2 + 8;
  const h = r * 2 + 4;
  return make(
    w,
    h,
    Math.round(w / 2),
    h - 2,
    (b) => {
      const cx = w / 2;
      const base = h - r - 2;
      // Back lump, then two side lumps, then the front: a soft, bumpy dome.
      clump(b, cx, base - r * 0.25, r * 0.72, tones, seed);
      clump(b, cx - r * 0.45, base + r * 0.1, r * 0.66, tones, seed + 1);
      clump(b, cx + r * 0.45, base + r * 0.1, r * 0.66, tones, seed + 2);
      clump(b, cx, base + r * 0.32, r * 0.62, tones, seed + 3);
    },
    { a: 0.3 },
  );
}

/** A long, flat-topped clipped hedge (or a tea-row). */
export function hedge(width: number, seed: number): Sprite {
  return make(
    width + 4,
    14,
    Math.round(width / 2) + 2,
    12,
    (b) => {
      for (let y = 2; y < 12; y++) {
        for (let x = 2; x < width + 2; x++) {
          const top = y < 5;
          const n = noise(x, y, 2.4, seed) - 0.5;
          const shade = (top ? 0.5 : -0.2) - (x / width) * 0.25 + n * 0.5 - (y > 9 ? 0.5 : 0);
          b.set(
            x,
            y,
            shade > 0.45
              ? K.leafLight
              : shade > 0.05
                ? mix(K.leaf, K.leafLight, 0.4)
                : shade > -0.35
                  ? K.leaf
                  : K.leafDark,
          );
        }
      }
      // Rounded ends.
      for (const [x, y] of [
        [2, 2],
        [width + 1, 2],
        [2, 11],
        [width + 1, 11],
      ] as const) {
        b.set(x, y, 0, 0);
      }
    },
    { a: 0.26 },
  );
}

// ── Buildings ────────────────────────────────────────────────

/** Colours sampled from a hand-drawn minka (a farmhouse in a cosy farm sim). */
const MK = {
  line: 0x470501, // the dark outline every edge is drawn in
  deep: 0x602710,
  shadow: 0x7a3c17,
  wood: 0xa56436,
  woodMid: 0xb47744,
  woodWarm: 0xc98149,
  woodLight: 0xce8952,
  woodHi: 0xdea260,
  woodFace: 0x9b582b,
  paper: 0xf3d4aa,
  paperLit: 0xfff1d8,
  frame: 0x81512a,
  glass: 0xc9ddd2,
  glassHi: 0xe3eee6,
  interior: 0xe4e2dc,
  interiorShade: 0xc9c5bd,
  thatch: 0x8e613a,
  thatchHi: 0xac7b49,
  thatchLo: 0x7a5230,
  thatchDeep: 0x5e3c20,
  thatchEdge: 0x4a2c16,
} as const;

/**
 * A minka, drawn the way a pixel artist builds one: a heavy thatched hip roof
 * with streaky straw, a row of rafter ends under its eave, a front of posts
 * with shoji screens set in deep frames, a wide veranda deck raised on a
 * beam, and one bay slid open onto a bright room. Every edge carries the
 * same dark-brown line, and the eave throws a deep shadow down the front.
 */
export function minka(
  width: number,
  seed: number,
  options: { sign?: Rgb; roofRatio?: number } = {},
): Sprite {
  const bay = 34;
  const bays = Math.max(3, Math.round(width / bay));
  const front = bays * bay + 4; // the house front, post to post
  const over = 10; // how far the eave overhangs each end
  const w = front + over * 2;
  const roofH = Math.round(front * (options.roofRatio ?? 0.3)) + 14;
  const eaveY = roofH; // the eave's bottom edge
  const lintel = eaveY + 3; // the beam above the screens, under the rafters
  const wallH = 26;
  const deckY = lintel + wallH; // the veranda's top
  const deckH = 9;
  const h = deckY + deckH + 3;
  const left = over;
  const openBay = Math.min(bays - 1, Math.max(1, Math.floor(bays * 0.62)));
  const b = new PixelBuffer(w, h);
  const line = (x: number, y: number, len: number, c: Rgb = MK.line): void =>
    b.rect(x, y, len, 1, c);

  // ── The front wall: one bay at a time ────────────────────────────
  b.rect(left, lintel, front, wallH, MK.deep); // the gaps read as deep shadow
  for (let i = 0; i < bays; i++) {
    const bx = left + 2 + i * bay;
    const open = i === openBay;
    if (open) {
      // A bright room: pale walls, a step in, a darker back corner.
      b.rect(bx + 4, lintel + 3, bay - 8, wallH - 4, MK.interior);
      b.rect(bx + 4, lintel + 3, 3, wallH - 4, MK.interiorShade);
      b.rect(bx + 4, lintel + wallH - 6, bay - 8, 1, MK.interiorShade);
      b.rect(bx + bay - 9, lintel + 6, 3, wallH - 10, MK.interiorShade);
      // A hanging scroll and a lamp glimpsed inside.
      b.rect(bx + 10, lintel + 6, 4, 9, MK.paperLit);
      b.rect(bx + 10, lintel + 6, 4, 1, MK.frame);
      b.rect(bx + 11, lintel + 9, 2, 4, MK.shadow);
      if (options.sign !== undefined) {
        // A noren curtain across the top of the doorway.
        b.rect(bx + 3, lintel + 2, bay - 6, 7, options.sign);
        for (let x = bx + 3 + 6; x < bx + bay - 4; x += 7)
          b.rect(x, lintel + 2, 1, 7, darken(options.sign, 0.35, MK.line));
        b.rect(bx + 3, lintel + 8, bay - 6, 1, darken(options.sign, 0.35, MK.line));
      }
      continue;
    }
    // Two shoji panels per bay, each in a deep frame with a lit top rail.
    for (let k = 0; k < 2; k++) {
      const px = bx + 3 + k * Math.floor((bay - 6) / 2);
      const pw = Math.floor((bay - 6) / 2) - 1;
      const ph = wallH - 8;
      const py = lintel + 3;
      b.rect(px, py, pw, ph, MK.frame);
      b.rect(px + 1, py + 1, pw - 2, ph - 2, MK.paper);
      // The lattice: a grid of fine wooden bars over the paper, upper half only.
      for (let yy = py + 1; yy < py + 1 + Math.round(ph * 0.55); yy++) {
        for (let xx = px + 1; xx < px + pw - 1; xx++) {
          if ((xx - px) % 3 === 0 || (yy - py) % 3 === 0) b.set(xx, yy, MK.woodMid);
          else if ((yy - py) % 3 === 1 && (xx - px) % 3 === 1) b.set(xx, yy, MK.paperLit);
        }
      }
      // The panel's lower board, with a lit edge.
      b.rect(
        px + 1,
        py + Math.round(ph * 0.55) + 1,
        pw - 2,
        ph - Math.round(ph * 0.55) - 2,
        MK.woodWarm,
      );
      b.rect(px + 1, py + Math.round(ph * 0.55) + 1, pw - 2, 1, MK.woodHi);
      b.rect(px + 2, py + ph - 3, pw - 4, 1, MK.wood);
      line(px, py + ph, pw, MK.shadow);
    }
    // The wainscot under the screens.
    b.rect(bx, lintel + wallH - 4, bay, 4, MK.woodFace);
    b.rect(bx, lintel + wallH - 4, bay, 1, MK.woodLight);
  }
  // Posts between the bays: a lit face, a shaded side, an outline.
  for (let i = 0; i <= bays; i++) {
    const px = left + i * bay;
    b.rect(px, lintel, 5, wallH, MK.woodWarm);
    b.rect(px, lintel, 1, wallH, MK.line);
    b.rect(px + 4, lintel, 1, wallH, MK.line);
    b.rect(px + 1, lintel, 1, wallH, MK.woodHi);
    b.rect(px + 3, lintel, 1, wallH, MK.wood);
  }
  // The lintel beam, with rafter ends poking out under the eave.
  b.rect(left - 2, lintel - 3, front + 4, 4, MK.woodWarm);
  b.rect(left - 2, lintel - 3, front + 4, 1, MK.woodHi);
  line(left - 2, lintel + 1, front + 4);
  for (let x = left; x < left + front; x += 7) {
    b.rect(x, eaveY, 4, 3, MK.woodLight);
    b.rect(x, eaveY, 4, 1, MK.paper);
    b.set(x + 3, eaveY + 1, MK.wood);
    b.set(x + 3, eaveY + 2, MK.wood);
  }

  // ── The veranda: a raised deck of long boards on a beam ──────────
  for (let y = 0; y < deckH; y++) {
    for (let x = left - 6; x < left + front + 6; x++) {
      let c: Rgb;
      if (y === 0) c = MK.woodHi;
      else if (y >= deckH - 3)
        c = y === deckH - 1 ? MK.line : y === deckH - 2 ? MK.shadow : MK.woodFace;
      else {
        const board = y % 3 === 0;
        const joint = (x + Math.floor(y / 3) * 23) % 41 === 0;
        c = board || joint ? MK.wood : y === 1 ? MK.woodLight : MK.woodWarm;
      }
      b.set(x, deckY + y, c);
    }
  }
  // Deck posts underneath, and a broad step stone at the open bay.
  for (let i = 0; i <= bays; i += 2) {
    const px = left + i * bay;
    b.rect(px, deckY + deckH - 3, 4, 3, MK.deep);
  }
  const step = left + 2 + openBay * bay + 6;
  b.rect(step, deckY + deckH - 1, bay - 12, 3, 0xc5bcb0);
  b.rect(step, deckY + deckH - 1, bay - 12, 1, 0xe8e4de);
  line(step, deckY + deckH + 2, bay - 12);

  // ── The roof: a heavy thatch hip, lit from the left ──────────────
  // Hand-drawn thatch is one mid-brown with chunky, ragged blotches of a
  // lighter straw (wider than tall, with jagged hanging edges) and a few
  // darker hollows: not fine noise.
  const blotch = (x: number, y: number): number => {
    const cell = 13;
    let best = 0;
    for (let gy = Math.floor(y / 7) - 1; gy <= Math.floor(y / 7) + 1; gy++) {
      for (let gx = Math.floor(x / cell) - 1; gx <= Math.floor(x / cell) + 1; gx++) {
        if (hash(gx, gy, seed + 7) > 0.3) continue;
        const ox = gx * cell + hash(gx, gy, seed + 8) * cell;
        const oy = gy * 7 + hash(gx, gy, seed + 9) * 7;
        const rx = 6 + hash(gx, gy, seed + 10) * 8;
        const ry = 1.1 + hash(gx, gy, seed + 11) * 1.3;
        // Jagged lower edge: straw hanging down in short strands.
        const hang = hash(Math.floor(x / 2), gy, seed + 12) * 2.2;
        const d =
          ((x - ox) / rx) ** 2 +
          (Math.max(0, y - oy - hang) / ry) ** 2 +
          (Math.min(0, y - oy) / ry) ** 2;
        best = Math.max(best, 1 - d);
      }
    }
    return best;
  };
  for (let y = 0; y < roofH; y++) {
    const t = y / roofH;
    // The hip: narrow at the ridge, full width at the eave, bulging slightly.
    const inset = Math.round((1 - Math.pow(t, 0.55)) * front * 0.2);
    for (let x = inset; x < w - inset; x++) {
      const nx = (x - w / 2) / (w / 2);
      const lift = blotch(x, y);
      const hollow = noise(x * 0.4, y * 1.3, 5, seed + 3) < 0.2;
      let c: Rgb =
        lift > 0
          ? lift > 0.55 && nx < 0.2
            ? MK.thatchHi
            : mix(MK.thatch, MK.thatchHi, 0.6)
          : MK.thatch;
      if (hollow && lift <= 0) c = MK.thatchLo;
      // The hip's sides fall away into shade (the right more than the left).
      const side = nx > 0 ? nx : -nx * 0.85;
      if (side > 0.82 && lift < 0.4) c = MK.thatchLo;
      if (side > 0.93) c = mix(MK.thatchLo, MK.thatchDeep, 0.5);
      // A ragged fringe of straw along the eave.
      if (y >= roofH - 5) {
        const tooth = Math.floor(hash(Math.floor(x / 2), 9, seed) * 4);
        c = y >= roofH - 5 + tooth ? MK.thatchDeep : MK.thatchLo;
      }
      b.set(x, y, c);
    }
  }
  // The ridge: a long roll on top, capped with a dark beam.
  const ridgeL = Math.round(w * 0.24);
  const ridgeR = Math.round(w * 0.76);
  b.rect(ridgeL, 0, ridgeR - ridgeL, 5, MK.thatchLo);
  b.rect(ridgeL, 0, ridgeR - ridgeL, 1, MK.thatchHi);
  b.rect(ridgeL + 2, 2, ridgeR - ridgeL - 4, 2, MK.thatchDeep);
  for (let x = ridgeL + 6; x < ridgeR - 6; x += 12) b.rect(x, 1, 3, 4, MK.deep);
  // The eave's shadow on the front: dark under the overhang, fading down.
  for (let x = left - 2; x < left + front + 2; x++) {
    for (let k = 0; k < 6; k++) b.set(x, eaveY + k, MK.line, 0.5 - k * 0.08);
  }

  // One pass of outline around everything, in the same dark brown.
  b.outline(0.85, MK.line);
  return {
    buf: b,
    ax: Math.round(w / 2),
    ay: deckY + deckH + 1,
    shadow: { a: 0.34 },
  };
}

/** A small thatched storehouse / teahouse on stilts. */
export function teahouse(seed: number): Sprite {
  const w = 40;
  const h = 46;
  return make(
    w,
    h,
    20,
    44,
    (b) => {
      // Walls and a door.
      b.rect(6, 22, 28, 18, K.paper);
      for (let x = 6; x < 34; x += 7) b.rect(x, 22, 2, 18, K.woodDark);
      for (let y = 22; y < 40; y += 6) b.rect(6, y, 28, 1, K.wood);
      b.rect(16, 28, 8, 12, K.woodDeep);
      b.rect(17, 29, 6, 4, K.lantern);
      // Stilts and a little deck.
      b.rect(4, 40, 32, 3, K.wood);
      b.rect(4, 40, 32, 1, K.woodLight);
      for (const x of [6, 19, 32]) b.rect(x, 43, 2, 2, K.woodDeep);
      // Roof: steep thatch.
      for (let y = 0; y < 24; y++) {
        const inset = Math.max(0, 12 - Math.round(y * 0.75));
        for (let x = inset; x < w - inset; x++) {
          const n = noise(x, y * 1.5, 2.5, seed) - 0.5;
          const shade = -((x - w / 2) / (w / 2)) * 0.5 - (y / 24 - 0.4) * 0.9 + n * 0.6;
          let c: Rgb = shade > 0.45 ? K.thatchLight : shade > 0 ? K.thatch : K.thatchDark;
          if (y >= 21) c = y === 23 ? K.thatchDeep : K.thatchDark;
          b.set(x, y, c);
        }
      }
      b.rect(16, 0, 8, 2, K.thatchDark);
    },
    { a: 0.3 },
  );
}

/** A red torii gate: where workers arrive and leave. */
export function torii(): Sprite {
  const w = 46;
  const h = 40;
  const red = 0xc8442c;
  const redDark = 0x8a2a1c;
  return make(
    w,
    h,
    23,
    38,
    (b) => {
      // Top beam (kasagi), curving up at the ends, with a dark cap.
      for (let x = 0; x < w; x++) {
        const lift = x < 5 ? 5 - x : x > w - 6 ? x - (w - 6) : 0;
        b.rect(x, 4 - Math.round(lift * 0.5), 1, 5, red);
        b.set(x, 3 - Math.round(lift * 0.5), 0x2a1a14);
        b.set(x, 8 - Math.round(lift * 0.5), redDark);
      }
      // Tie beam (nuki).
      b.rect(5, 14, w - 10, 4, red);
      b.rect(5, 17, w - 10, 1, redDark);
      // A plaque between them.
      b.rect(20, 8, 6, 7, 0x2a1a14);
      b.rect(21, 9, 4, 5, 0xd8b04a);
      // Pillars, with black feet.
      for (const x of [9, w - 13]) {
        b.rect(x, 8, 4, 28, red);
        b.rect(x, 8, 1, 28, 0xe06a48);
        b.rect(x + 3, 8, 1, 28, redDark);
        b.rect(x - 1, 34, 6, 4, 0x2a1a14);
      }
    },
    { a: 0.25 },
  );
}

// ── Garden pieces ────────────────────────────────────────────

/** A stone lantern (tōrō), softly lit. */
export function stoneLantern(): Sprite {
  return make(
    14,
    26,
    7,
    24,
    (b) => {
      // Cap.
      b.rect(1, 6, 12, 3, K.stone);
      b.rect(1, 6, 12, 1, K.stoneLight);
      b.rect(3, 4, 8, 2, K.stone);
      b.rect(5, 2, 4, 2, K.stoneDark);
      b.set(6, 1, K.stoneDark);
      // Light box with a glowing window.
      b.rect(3, 9, 8, 6, K.stoneDark);
      b.rect(5, 10, 4, 4, K.lantern);
      b.set(5, 10, 0xfff0b8);
      // Post and base.
      b.rect(5, 15, 4, 6, K.stone);
      b.rect(5, 15, 1, 6, K.stoneLight);
      b.rect(2, 21, 10, 3, K.stoneDark);
      b.rect(2, 21, 10, 1, K.stone);
    },
    { a: 0.28 },
  );
}

/** A koi pond: a jade basin inside a wall of big, rounded grey boulders. */
export function koiPond(width: number, height: number, seed: number): Sprite {
  const pad = 14;
  const w = width + pad * 2;
  const h = height + pad * 2;
  const cx = w / 2;
  const cy = h / 2;
  const rx = width / 2;
  const ry = height / 2;
  return make(
    w,
    h,
    Math.round(cx),
    h - 5,
    (b) => {
      // Boulders: sorted top to bottom so lower ones overlap upper ones.
      const stones = Math.round((rx + ry) * 0.3);
      const ring: Array<[number, number, number]> = [];
      for (let i = 0; i < stones; i++) {
        const a = (i / stones) * Math.PI * 2 + hash(i, 1, seed) * 0.18;
        const r = 7.2 + hash(i, 0, seed) * 2.6;
        ring.push([cx + Math.cos(a) * (rx + 3.5), cy + Math.sin(a) * (ry + 3.5), r]);
      }
      ring.sort((p, q) => p[1] - q[1]);
      for (const [sx, sy, r] of ring) {
        for (let yy = Math.floor(sy - r); yy <= sy + r; yy++) {
          for (let xx = Math.floor(sx - r * 1.15); xx <= sx + r * 1.15; xx++) {
            const ddx = (xx + 0.5 - sx) / (r * 1.15);
            const ddy = (yy + 0.5 - sy) / r;
            const d = ddx * ddx + ddy * ddy;
            if (d > 1) continue;
            const lit = -ddx * 0.55 - ddy * 0.85;
            let c: Rgb =
              lit > 0.5
                ? K.stoneLight
                : lit > -0.15
                  ? K.stone
                  : lit > -0.6
                    ? K.stoneDark
                    : K.stoneDeep;
            if (d > 0.82 && ddy > 0) c = K.stoneDeep; // the underside in shadow
            b.set(xx, yy, c);
          }
        }
      }
      // Water inside the ring: pale, icy jade crossed by a light crackle of
      // ripples (the edges of a few cells), deeper toward the middle.
      const cells: Array<[number, number]> = [];
      const rnd = stream(seed + 40);
      for (let i = 0; i < 9; i++)
        cells.push([cx + (rnd() - 0.5) * rx * 1.8, cy + (rnd() - 0.5) * ry * 1.8]);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = (x + 0.5 - cx) / rx;
          const dy = (y + 0.5 - cy) / ry;
          const d = dx * dx + dy * dy;
          if (d > 1) continue;
          let near = Infinity;
          let next = Infinity;
          for (const [px, py] of cells) {
            const dist = Math.hypot(x + 0.5 - px, (y + 0.5 - py) * 1.3);
            if (dist < near) {
              next = near;
              near = dist;
            } else if (dist < next) next = dist;
          }
          let c: Rgb = d < 0.45 ? mix(K.water, K.waterDark, 0.35) : K.water;
          if (next - near < 1.1)
            c = K.waterLight; // a ripple line
          else if (next - near < 2 && d > 0.3) c = mix(K.water, K.waterLight, 0.5);
          b.set(x, y, c);
        }
      }
      // The stones throw a band of shade onto the top of the water.
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
          const dx = (x + 0.5 - cx) / rx;
          const dy = (y + 0.5 - cy) / ry;
          if (dx * dx + dy * dy > 1 || dy > -0.55) continue;
          const above = dx * dx + ((y - 2.5 + 0.5 - cy) / ry) ** 2 > 1;
          if (above) b.set(x, y, K.waterDark);
        }
      }
      // Koi: two orange fish, one with white patches, and a lily pad.
      const fx = Math.round(cx - 7);
      const fy = Math.round(cy + 2);
      b.rect(fx, fy, 7, 2, K.koi);
      b.set(fx - 1, fy + 1, K.koi);
      b.set(fx - 1, fy - 1, K.koi);
      b.set(fx + 3, fy, 0xffffff);
      b.set(fx + 6, fy, 0x2a1a14);
      const gx = Math.round(cx + 5);
      const gy = Math.round(cy - 5);
      b.rect(gx, gy, 2, 6, K.koi);
      b.set(gx, gy + 2, 0xffffff);
      b.set(gx + 1, gy + 3, 0xffffff);
      b.ellipse(cx + 9, cy + 4, 2.6, 2, K.leaf);
      b.set(Math.round(cx + 9), Math.round(cy + 4), K.leafLight);
    },
    undefined,
  );
}

/** A bamboo water spout (kakei) dripping into a stone basin. */
export function bambooSpout(): Sprite {
  return make(
    24,
    20,
    12,
    18,
    (b) => {
      // Stone basin.
      b.ellipse(15, 14, 6, 4, K.stone);
      b.ellipse(15, 13, 4, 2.4, K.water);
      b.set(14, 12, K.waterLight);
      // Bamboo post and spout.
      b.rect(2, 2, 3, 16, K.bamboo);
      b.rect(4, 2, 1, 16, K.bambooDark);
      for (const y of [6, 11]) b.rect(2, y, 3, 1, K.bambooDark);
      for (let x = 4; x < 14; x++) b.set(x, 4 + Math.round((x - 4) * 0.3), K.bamboo);
      for (let x = 4; x < 14; x++) b.set(x, 5 + Math.round((x - 4) * 0.3), K.bambooDark);
      b.set(14, 9, K.waterLight);
      b.set(14, 10, K.water);
    },
    { a: 0.25 },
  );
}

/** A low bamboo fence section. */
export function bambooFence(segments: number): Sprite {
  const w = segments * 10 + 2;
  return make(
    w,
    14,
    Math.round(w / 2),
    12,
    (b) => {
      for (let x = 0; x < w; x += 10) {
        b.rect(x, 0, 3, 13, K.bamboo);
        b.rect(x + 2, 0, 1, 13, K.bambooDark);
        b.rect(x, 3, 3, 1, K.bambooDark);
      }
      for (const y of [4, 8]) {
        b.rect(0, y, w, 2, K.bamboo);
        b.rect(0, y + 1, w, 1, K.bambooDark);
      }
    },
    undefined,
  );
}

/** A flat, rounded stepping stone, set into the ground. */
export function steppingStone(seed: number): Sprite {
  // A plump, rounded stepping stone: an oval that bulges a little toward the
  // viewer, a bright cream-grey top with a white sheen, a cooler grey belly,
  // a heavy dark underside, and the same dark-brown line as everything else.
  const w = 22 + Math.floor(hash(seed, 0, 1) * 4);
  const h = 15 + Math.floor(hash(seed, 1, 1) * 2);
  const cx = w / 2 + (hash(seed, 2, 1) - 0.5);
  const cy = h / 2 - 0.5;
  const rx = w / 2 - 1;
  const ry = h / 2 - 1;
  // A softened oval (between an ellipse and a cushion), slightly flattened on top.
  const p = 2.4;
  const inside = (x: number, y: number): boolean => {
    const dx = Math.abs((x + 0.5 - cx) / rx);
    const dyRaw = (y + 0.5 - cy) / ry;
    const dy = Math.abs(dyRaw < 0 ? dyRaw * 1.05 : dyRaw);
    return dx ** p + dy ** p <= 1;
  };
  const buf = new PixelBuffer(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      const below = (k: number): boolean => !inside(x, y + k);
      const above = (k: number): boolean => !inside(x, y - k);
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      let c: Rgb;
      if (below(1))
        c = 0x5a4a44; // the underside, in shadow
      else if (below(2)) c = 0x8a817a;
      else if (below(3) || dy > 0.42)
        c = 0xa69e96; // the belly
      else if (above(1))
        c = 0xd9d3cb; // the top rim catches light
      else if (above(2) && dx > -0.6 && dx < 0.35)
        c = 0xfcfaf6; // a white sheen
      else c = dx > 0.55 ? 0xb9b1a8 : 0xcac3ba; // the face, a touch darker right
      // A couple of pits and a crack, so it reads as stone.
      if (c === 0xcac3ba && hash(x, y, seed + 5) < 0.04) c = 0xb3aba2;
      buf.set(x, y, c);
    }
  }
  buf.outline(0.92, 0x3a1608);
  return {
    buf,
    ax: Math.round(cx),
    ay: h - 1,
    shadow: { a: 0.18 },
  };
}

/** A raised bed of crops: rows of soil with sprouts, in a wooden frame. */
export function cropBed(
  cols: number,
  rows: number,
  kind: "daikon" | "carrot" | "rice" | "cabbage",
  seed: number,
): Sprite {
  const w = cols * 12 + 8;
  const h = rows * 12 + 8;
  return make(
    w,
    h,
    Math.round(w / 2),
    h - 1,
    (b) => {
      // Soil furrows.
      for (let y = 2; y < h - 2; y++) {
        for (let x = 2; x < w - 2; x++) {
          const furrow = (y - 2) % 6;
          b.set(x, y, furrow === 0 ? K.soilDeep : furrow < 3 ? 0x6a4317 : 0x7d521d);
        }
      }
      // Wooden frame.
      b.rect(0, 0, w, 2, K.wood);
      b.rect(0, h - 2, w, 2, K.woodDark);
      b.rect(0, 0, 2, h, K.wood);
      b.rect(w - 2, 0, 2, h, K.woodDark);
      // Plants.
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = 5 + c * 12;
          const y = 3 + r * 12;
          const rnd = stream(seed + r * 13 + c);
          if (kind === "rice") {
            for (let k = 0; k < 4; k++) {
              const sx = x + Math.round(rnd() * 5);
              b.rect(sx, y + 1, 1, 7, K.leafLight);
              b.set(sx, y, 0xe0c35a);
              b.set(sx + 1, y + 1, 0xe0c35a);
            }
            continue;
          }
          if (kind === "carrot") b.rect(x + 2, y + 6, 3, 3, K.koi);
          if (kind === "daikon") b.rect(x + 2, y + 6, 3, 3, 0xf3f0e2);
          if (kind === "cabbage") {
            b.ellipse(x + 3.5, y + 5, 4, 3.4, K.leafLight);
            b.ellipse(x + 3.5, y + 5, 2.2, 1.8, 0xc8d878);
            continue;
          }
          // Leafy tops.
          b.set(x + 3, y + 1, K.leafLight);
          b.rect(x + 1, y + 2, 5, 2, K.leaf);
          b.rect(x + 2, y + 4, 3, 2, K.leafDark);
          b.set(x, y + 1, K.leafLight);
          b.set(x + 6, y + 1, K.leafLight);
        }
      }
    },
    { a: 0.2 },
  );
}

/** A campfire ringed with stones, with a kettle hanging over it. */
export function cozyCampfire(): Sprite {
  return make(
    26,
    26,
    13,
    22,
    (b) => {
      // Stones.
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        b.ellipse(
          13 + Math.cos(a) * 8,
          19 + Math.sin(a) * 4,
          2.6,
          2,
          i % 2 ? K.stone : K.stoneDark,
        );
      }
      // Logs.
      for (let x = 7; x < 19; x++) {
        b.set(x, 18 + Math.round((x - 7) * 0.15), K.woodDark);
        b.set(x, 19 + Math.round((x - 7) * 0.15), K.woodDeep);
        b.set(x, 20 - Math.round((x - 7) * 0.15), K.wood);
      }
      // Flames.
      b.ellipse(13, 15, 4, 5, K.ember);
      b.ellipse(13, 16, 2.6, 3.4, K.lantern);
      b.ellipse(13, 17, 1.4, 2, 0xfff3c8);
      b.set(11, 9, K.ember);
      b.set(15, 10, K.ember);
      // A tripod and a hanging kettle.
      for (let y = 2; y < 18; y++) {
        b.set(6 + Math.round((y - 2) * 0.15), y, K.woodDark);
        b.set(20 - Math.round((y - 2) * 0.15), y, K.woodDark);
      }
      b.rect(6, 2, 15, 1, K.woodDark);
      b.rect(12, 3, 1, 4, 0x3a3a3a);
      b.ellipse(12.5, 9, 3.4, 2.6, 0x3a3a3a);
      b.set(11, 8, 0x6a6a6a);
    },
    { a: 0.25 },
  );
}

/** A low wooden bench with a cushion. */
export function bench(): Sprite {
  return make(
    26,
    12,
    13,
    10,
    (b) => {
      b.rect(1, 2, 24, 4, K.wood);
      b.rect(1, 2, 24, 1, K.woodLight);
      b.rect(1, 5, 24, 1, K.woodDark);
      b.rect(5, 1, 16, 3, 0x6a4a8a);
      b.rect(5, 1, 16, 1, 0x8a6aaa);
      for (const x of [3, 21]) b.rect(x, 6, 2, 5, K.woodDark);
    },
    { a: 0.25 },
  );
}

/** A washing line between two posts, with laundry drying. */
export function washingLine(): Sprite {
  return make(
    40,
    28,
    20,
    26,
    (b) => {
      for (const x of [2, 36]) {
        b.rect(x, 4, 2, 22, K.woodDark);
        b.rect(x, 4, 1, 22, K.wood);
      }
      for (let x = 3; x < 37; x++)
        b.set(x, 6 + Math.round(Math.sin(((x - 3) / 34) * Math.PI) * 2), 0x3a3a3a);
      const items: Array<[number, number, Rgb]> = [
        [7, 7, 0x6a8ad0],
        [16, 10, 0xf3f0e2],
        [24, 10, 0xd8394a],
        [31, 7, 0xe0c35a],
      ];
      for (const [x, w, c] of items) {
        b.rect(x, 8, 6, w, c);
        b.rect(x, 8, 6, 1, mix(c, 0xffffff, 0.35));
        b.rect(x + 5, 8, 1, w, darken(c, 0.25));
      }
    },
    undefined,
  );
}

/** A wooden water bucket and a ladle. */
export function bucket(): Sprite {
  return make(
    12,
    13,
    6,
    11,
    (b) => {
      b.rect(2, 4, 8, 8, K.wood);
      b.rect(2, 4, 1, 8, K.woodLight);
      b.rect(9, 4, 1, 8, K.woodDark);
      for (const y of [6, 10]) b.rect(2, y, 8, 1, 0x3a3a3a);
      b.rect(3, 4, 6, 1, K.water);
      b.rect(8, 0, 1, 5, K.woodLight);
    },
    { a: 0.25 },
  );
}

/** A sleepy cat, curled up. */
export function sleepingCat(): Sprite {
  return make(
    14,
    9,
    7,
    8,
    (b) => {
      b.ellipse(7, 5, 6, 3.4, 0xe8a24a);
      b.ellipse(7, 4, 4.4, 2.2, 0xf2c27a);
      b.rect(2, 5, 3, 2, 0xe8a24a);
      b.set(2, 3, 0xe8a24a);
      b.set(4, 3, 0xe8a24a);
      b.set(3, 5, 0x3a2a1a);
      b.rect(9, 6, 4, 1, 0xc0782a);
    },
    { a: 0.25 },
  );
}

/** A little straw scarecrow in a kasa hat. */
export function scarecrow(): Sprite {
  return make(
    18,
    28,
    9,
    26,
    (b) => {
      b.rect(8, 8, 2, 18, K.woodDark);
      b.rect(2, 12, 14, 2, K.woodDark);
      b.rect(5, 12, 8, 8, 0x5a7ac0);
      b.rect(5, 12, 8, 1, 0x7a9ae0);
      b.ellipse(9, 8, 3, 3, K.paper);
      // Conical straw hat.
      for (let y = 0; y < 5; y++)
        b.rect(9 - (y + 1) * 1.6, 2 + y, (y + 1) * 3.2, 1, y === 4 ? K.thatchDark : K.thatchLight);
      b.set(7, 8, 0x2a1a14);
      b.set(10, 8, 0x2a1a14);
    },
    { a: 0.25 },
  );
}

/** A wooden kennel / tool hut with a pitched board roof. */
export function hut(): Sprite {
  return make(
    28,
    30,
    14,
    28,
    (b) => {
      b.rect(4, 12, 20, 16, K.wood);
      for (let x = 4; x < 24; x += 4) b.rect(x, 12, 1, 16, K.woodDark);
      b.ellipse(14, 22, 4, 5, K.woodDeep);
      b.rect(10, 22, 8, 6, K.woodDeep);
      for (let y = 0; y < 13; y++) {
        const half = 3 + y;
        b.rect(14 - half, y, half, 1, y % 3 === 0 ? K.woodDark : K.woodLight);
        b.rect(14, y, half, 1, y % 3 === 0 ? K.woodDeep : K.wood);
      }
    },
    { a: 0.28 },
  );
}

/** A small wayside shrine on a post, with an offering. */
export function shrine(): Sprite {
  return make(
    16,
    24,
    8,
    22,
    (b) => {
      b.rect(7, 12, 2, 10, K.woodDark);
      b.rect(3, 6, 10, 7, K.wood);
      b.rect(5, 8, 6, 5, K.woodDeep);
      b.rect(7, 9, 2, 2, K.lantern);
      for (let y = 0; y < 6; y++)
        b.rect(8 - (y + 2), y + 1, (y + 2) * 2, 1, y < 2 ? K.woodDark : K.woodDeep);
      b.rect(5, 12, 6, 1, 0xd8394a);
    },
    { a: 0.25 },
  );
}

/** A low stack of firewood. */
export function woodpile(): Sprite {
  return make(
    22,
    12,
    11,
    10,
    (b) => {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 4 - (r === 2 ? 1 : 0); c++) {
          const x = 2 + c * 5 + (r % 2) * 2;
          const y = 7 - r * 3;
          b.ellipse(x + 2, y + 1.5, 2.4, 1.8, K.woodLight);
          b.set(x + 2, y + 1, K.woodDark);
        }
      }
    },
    { a: 0.25 },
  );
}

// ── Farm life and filler ─────────────────────────────────────

/** A clump of tall, spiky grass: the filler that makes a farm feel overgrown. */
export function tallGrass(seed: number, tone: "green" | "gold" = "green"): Sprite {
  const light = tone === "gold" ? 0xd8c25a : K.grassLight;
  const base = tone === "gold" ? 0xb39a34 : K.grass;
  const dark = tone === "gold" ? 0x7d6a1e : K.grassDark;
  // The tips catch the sun: a warm, pale step above the light.
  const hi = mix(light, 0xfff4cc, 0.38);
  return make(
    16,
    13,
    8,
    12,
    (b) => {
      const rnd = stream(seed);
      // Each clump its own size and habit: a little sprig, a fan, a tall
      // stand, or a leaning tussock; some carry seed heads.
      const habit = Math.floor(hash(seed, 3, 7) * 4);
      const widthOf = [5, 9, 11, 12][habit] ?? 9;
      const tallest = [4, 6, 10, 8][habit] ?? 6;
      const lean = habit === 3 ? (hash(seed, 4, 7) < 0.5 ? -1 : 1) * 0.6 : 0;
      const heads = hash(seed, 5, 7) < 0.3;
      const x0 = 8 - widthOf / 2;
      // The clump's own shade at its foot, where the blades crowd out the light.
      b.ellipse(8, 11, widthOf / 2 + 0.5, 1.6, dark);
      const blades = Math.max(3, Math.round(widthOf * 0.75) + Math.floor(rnd() * 3));
      // Back blades (the middle ones, tallest) first, so the outer ones cross them.
      const order = Array.from({ length: blades }, (_, i) => i).sort(
        (p, q) => Math.abs(p - (blades - 1) / 2) - Math.abs(q - (blades - 1) / 2),
      );
      for (const i of order) {
        const bx = x0 + (i / Math.max(1, blades - 1)) * widthOf + (rnd() - 0.5) * 1.5;
        const height = Math.max(2, Math.round(tallest * (0.45 + rnd() * 0.55)));
        const splay = (bx - 8) * 0.22 + lean + (rnd() - 0.5) * 0.6;
        // A blade leaning toward the sun (left) is lit along its length; one
        // leaning away stays in its own shade until its tip.
        const sunward = splay < 0;
        let tipX = 0;
        for (let k = 0; k < height; k++) {
          const t = k / height;
          const x = Math.round(bx + splay * t * 2);
          const y = 11 - k;
          const c =
            t > 0.82
              ? hi
              : t > 0.55
                ? sunward
                  ? light
                  : base
                : t > 0.25
                  ? sunward
                    ? base
                    : dark
                  : dark;
          b.set(x, y, c);
          tipX = x;
        }
        if (heads && i % 2 === 0 && height > 4) {
          // A seed head: a lit grain over a shaded one, nodding over.
          b.set(tipX, 11 - height, 0xf2e6b4);
          b.set(tipX + (splay < 0 ? -1 : 1), 11 - height, 0xd8c070);
          b.set(tipX, 10 - height, 0xb89a48);
        }
      }
    },
    undefined,
  );
}

/** A low clump of flowers on leaves. */
export function flowerClump(seed: number, petal: Rgb): Sprite {
  // A low clump of leaves (pads lit from the upper left, shade between them)
  // with a few five-petal flowers on it: each petal lit on the sunny side
  // and a shade darker on the far one, round a gold centre with a lit pixel.
  return make(
    14,
    10,
    7,
    9,
    (b) => {
      clump(b, 4.6, 7, 2.8, LEAF, seed);
      clump(b, 9.4, 7.2, 2.8, LEAF, seed + 1);
      clump(b, 7, 6, 2.6, LEAF, seed + 2);
      const rnd = stream(seed);
      const lit = mix(petal, 0xffffff, 0.35);
      const shade = mix(petal, WARM_INK, 0.22);
      for (let i = 0; i < 3; i++) {
        const x = Math.round(3 + rnd() * 8);
        const y = Math.round(3 + rnd() * 3);
        b.set(x, y - 1, lit);
        b.set(x - 1, y, lit);
        b.set(x + 1, y, petal);
        b.set(x - 1, y + 1, petal);
        b.set(x + 1, y + 1, shade);
        b.set(x, y, 0xf6d24a);
        b.set(x, y + 1, 0xc8941a);
      }
    },
    undefined,
  );
}

/** A green-banded wooden tub on a ring of stones (a well bucket / rain tub). */
export function waterTub(): Sprite {
  const green = 0x4f8a3a;
  const greenLight = 0x74b04e;
  const greenDark = 0x2f5a24;
  return make(
    22,
    24,
    11,
    22,
    (b) => {
      // Stones it stands on.
      for (const [x, y, r] of [
        [4, 19, 3.4],
        [11, 21, 3.6],
        [18, 19, 3.4],
        [7, 16, 2.8],
        [15, 16, 2.8],
      ] as const) {
        b.ellipse(x, y, r * 1.1, r * 0.8, K.stone);
        b.ellipse(x - 0.8, y - 0.8, r * 0.6, r * 0.4, K.stoneLight);
      }
      // The tub: staves, two bands, a rim with dark water inside.
      for (let y = 4; y < 17; y++) {
        const bulge = Math.round(Math.sin(((y - 4) / 13) * Math.PI) * 1.2);
        for (let x = 4 - bulge; x < 18 + bulge; x++) {
          const lit = x < 8 ? greenLight : x > 14 ? greenDark : green;
          b.set(x, y, (x - 4) % 3 === 0 ? mix(lit, greenDark, 0.35) : lit);
        }
      }
      for (const y of [7, 13]) b.rect(3, y, 16, 1, 0x3a3a2a);
      b.ellipse(11, 4, 7, 2.4, green);
      b.ellipse(11, 4, 5.6, 1.6, 0x2a4a4a);
      b.rect(8, 4, 4, 1, 0x5fa8a8);
    },
    { a: 0.28 },
  );
}

/** A shiba inu, curled up asleep. */
export function shibaDog(): Sprite {
  const fur = 0xe08a3a;
  const furLight = 0xf2b06a;
  const cream = 0xf8e6c4;
  return make(
    18,
    12,
    9,
    11,
    (b) => {
      b.ellipse(10, 7, 6.5, 3.6, fur);
      b.ellipse(9, 5.8, 4.6, 2.2, furLight);
      // Head resting on its paws, facing left.
      b.ellipse(4.5, 7, 3.4, 2.8, fur);
      b.ellipse(3.6, 8.2, 2.2, 1.4, cream);
      b.set(3, 4, fur);
      b.set(5, 4, fur);
      b.set(3, 5, furLight);
      b.set(5, 5, furLight);
      b.rect(3, 7, 2, 1, 0x3a2414); // a closed, sleepy eye
      b.set(1, 8, 0x2a1a10); // nose
      // A curled tail on top.
      b.ellipse(15, 5, 2.2, 1.8, cream);
      b.set(15, 5, fur);
      b.rect(6, 10, 6, 1, cream);
    },
    { a: 0.26 },
  );
}

/** A chicken, pecking about. */
export function chicken(seed: number): Sprite {
  const white = 0xf6f2ea;
  const shade = 0xd2c8b8;
  return make(
    12,
    12,
    6,
    11,
    (b) => {
      b.ellipse(6.5, 7, 4.4, 3.2, white);
      b.ellipse(7.5, 8, 2.6, 1.6, shade);
      b.ellipse(3.5, 4, 2, 2, white);
      b.set(3, 1, 0xd8394a);
      b.set(4, 1, 0xd8394a);
      b.set(3, 2, 0xd8394a);
      b.set(1, 4, 0xf2b630); // beak
      b.set(3, 4, 0x2a1a14); // eye
      b.set(2, 6, 0xd8394a); // wattle
      b.rect(10, 4, 2, 3, white); // tail
      for (const x of [5, 8]) b.rect(x, 10, 1, 2, 0xf2b630);
      if (hash(seed, 0, 3) < 0.5) b.set(9, 6, shade);
    },
    { a: 0.25 },
  );
}

/** A tall thatched storehouse (kura) with an A-frame roof and a board front. */
export function kura(seed: number): Sprite {
  const w = 60;
  const h = 72;
  const roofH = 46;
  return make(
    w,
    h,
    30,
    70,
    (b) => {
      // Stone footing and the board front with a door and a high window.
      b.rect(8, 64, 44, 6, K.stoneDark);
      b.rect(8, 64, 44, 1, K.stone);
      for (let y = roofH - 4; y < 64; y++) {
        for (let x = 10; x < 50; x++) {
          const board = (x - 10) % 5 === 0;
          b.set(x, y, board ? K.woodDark : x < 16 ? K.woodLight : K.wood);
        }
      }
      b.rect(22, 50, 16, 14, K.woodDeep);
      b.rect(23, 51, 7, 13, K.woodDark);
      b.rect(30, 51, 7, 13, K.wood);
      b.rect(26, 45, 8, 3, K.woodDeep);
      // The roof: a steep, rounded thatch hood, darker in its gable.
      for (let y = 0; y < roofH; y++) {
        const t = y / roofH;
        const half = Math.round(5 + Math.pow(t, 0.62) * (w / 2 - 3));
        for (let x = Math.round(w / 2 - half); x < Math.round(w / 2 + half); x++) {
          const nx = (x - w / 2) / half;
          const blot = noise(x, y * 1.4, 4.5, seed) - 0.5;
          const shade = -nx * 0.7 - (t - 0.5) * 0.5 + blot * 0.8;
          let c: Rgb = shade > 0.45 ? K.thatchLight : shade > -0.1 ? K.thatch : K.thatchDark;
          if (y >= roofH - 5) c = y >= roofH - 2 ? K.thatchDeep : K.thatchDark;
          b.set(x, y, c);
        }
      }
      // The gable: a dark triangle of boards under the ridge, with a vent.
      for (let y = 10; y < 30; y++) {
        const half = Math.round((y - 10) * 0.42);
        for (let x = 30 - half; x <= 30 + half; x++) {
          b.set(x, y, (x - 30) % 3 === 0 ? K.woodDeep : K.woodDark);
        }
      }
      b.rect(27, 20, 6, 4, K.woodDeep);
      b.rect(28, 21, 4, 2, K.lantern);
    },
    { a: 0.32 },
  );
}

/**
 * A bed of tilled soil with rounded corners, crops in rows, and (optionally)
 * a low wooden fence along its front.
 */
export function soilBed(
  cols: number,
  rows: number,
  kind: "carrot" | "daikon" | "cabbage" | "rice" | "eggplant",
  seed: number,
  fenced = true,
): Sprite {
  const w = cols * 13 + 8;
  const bedH = rows * 13 + 6;
  const h = bedH + (fenced ? 10 : 2);
  const rice = kind === "rice";
  const soil = rice ? 0xa47c34 : 0x6a3c14;
  const ridge = rice ? 0xc49a48 : 0x86501e;
  const furrow = rice ? 0x7c5a22 : 0x4c2a0c;
  return make(
    w,
    h,
    Math.round(w / 2),
    h - 1,
    (b) => {
      for (let y = 0; y < bedH; y++) {
        for (let x = 0; x < w; x++) {
          const corner =
            (x < 2 || x > w - 3) &&
            (y < 2 || y > bedH - 3) &&
            !(x > 0 && x < w - 1 && y > 0 && y < bedH - 1);
          if (corner) continue;
          const r = y % 13;
          b.set(x, y, r === 0 ? furrow : r < 4 ? ridge : soil);
        }
      }
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = 5 + c * 13;
          const y = 2 + r * 13;
          const rnd = stream(seed + r * 17 + c);
          if (rice) {
            for (let k = 0; k < 5; k++) {
              const sx = x + Math.round(rnd() * 7);
              const top = y + Math.round(rnd() * 2);
              for (let yy = top; yy < y + 10; yy++)
                b.set(sx, yy, yy < top + 3 ? 0xe8cf62 : K.leafLight);
              b.set(sx + 1, top + 1, 0xe8cf62);
            }
            continue;
          }
          if (kind === "cabbage") {
            b.ellipse(x + 4, y + 6, 5, 4.2, K.leafDark);
            b.ellipse(x + 4, y + 5.5, 3.8, 3, K.leafLight);
            b.ellipse(x + 3.5, y + 5, 2.2, 1.6, 0xc8d878);
            continue;
          }
          if (kind === "eggplant") {
            b.ellipse(x + 4, y + 4, 4, 3, K.leaf);
            b.ellipse(x + 3, y + 8, 1.6, 2.4, 0x5a2a6a);
            b.ellipse(x + 6, y + 8, 1.6, 2.4, 0x6a3a7a);
            continue;
          }
          // Leafy tops over a root showing at the soil.
          const root = kind === "carrot" ? K.koi : 0xf3f0e2;
          b.rect(x + 2, y + 7, 4, 3, root);
          b.set(x + 2, y + 7, mix(root, 0xffffff, 0.4));
          b.set(x + 4, y + 1, K.leafLight);
          b.rect(x + 2, y + 2, 4, 2, K.leafLight);
          b.rect(x + 1, y + 4, 6, 2, K.leaf);
          b.set(x, y + 3, K.leaf);
          b.set(x + 7, y + 3, K.leaf);
          b.rect(x + 3, y + 6, 2, 1, K.leafDark);
        }
      }
      if (fenced) {
        const fy = bedH + 1;
        for (let x = 1; x < w - 1; x++) {
          b.set(x, fy + 2, K.wood);
          b.set(x, fy + 5, K.wood);
          b.set(x, fy + 3, K.woodDark);
          b.set(x, fy + 6, K.woodDark);
        }
        for (let x = 1; x < w - 1; x += 10) {
          b.rect(x, fy, 2, 9, K.woodDark);
          b.rect(x, fy, 1, 9, K.woodLight);
        }
        b.rect(w - 3, fy, 2, 9, K.woodDark);
      }
    },
    { a: 0.2 },
  );
}

/** Long, rounded rows of a clipped crop (like rolls of tea or cabbage), on soil. */
export function cropRolls(width: number, rolls: number): Sprite {
  const h = rolls * 13 + 8;
  return make(
    width + 6,
    h,
    Math.round(width / 2) + 3,
    h - 1,
    (b) => {
      for (let y = 0; y < h - 2; y++) {
        for (let x = 0; x < width + 6; x++) b.set(x, y, y % 13 === 12 ? 0x4c2a0c : 0x6a3c14);
      }
      for (let r = 0; r < rolls; r++) {
        const top = 2 + r * 13;
        for (let y = top; y < top + 10; y++) {
          for (let x = 3; x < width + 3; x++) {
            const endCut = (x === 3 || x === width + 2) && (y === top || y === top + 9);
            if (endCut) continue;
            const t = (y - top) / 10;
            const c = t < 0.2 ? 0xc8dc5a : t < 0.6 ? 0xa2c040 : t < 0.85 ? K.leaf : K.leafDark;
            b.set(
              x,
              y,
              x === 3 ? mix(c, 0xffffff, 0.15) : x > width ? darken(c, 0.2, WARM_INK) : c,
            );
          }
        }
      }
    },
    { a: 0.2 },
  );
}

/** A small wooden stake with a crossbar (a field marker). */
export function stake(): Sprite {
  return make(
    14,
    16,
    7,
    15,
    (b) => {
      b.rect(6, 2, 2, 13, K.woodDark);
      b.rect(6, 2, 1, 13, K.woodLight);
      b.rect(1, 5, 12, 2, K.wood);
      b.rect(1, 6, 12, 1, K.woodDark);
    },
    { a: 0.25 },
  );
}

/** A wisp of steam or smoke: a few soft puffs drifting up and to the side. */
export function steam(seed: number): Sprite {
  // Steam drawn the way GG Royale draws smoke: rounded puffs, each lit white
  // on its upper left with a cool shade on its lower right, getting bigger
  // and thinner as they rise (pixels drop out through an ordered dither,
  // rather than the puff going see-through).
  const BY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;
  return make(
    10,
    18,
    4,
    17,
    (b) => {
      const rnd = stream(seed);
      for (let i = 0; i < 4; i++) {
        const y = 15 - i * 4;
        const x = 4 + Math.round(Math.sin(i * 1.3 + rnd()) * 2) + (i > 1 ? 1 : 0);
        const r = 1.4 + i * 0.45;
        // How much of the puff's rim is left: full low down, thin high up
        // (its middle stays solid, so it never breaks into a checker).
        const keep = 1 - i * 0.28;
        for (let yy = Math.floor(y - r); yy <= y + r; yy++) {
          for (let xx = Math.floor(x - r); xx <= x + r; xx++) {
            const dx = (xx + 0.5 - x) / r;
            const dy = (yy + 0.5 - y) / r;
            if (dx * dx + dy * dy > 1) continue;
            const t = ((BY[(yy & 3) * 4 + (xx & 3)] ?? 0) + 0.5) / 16;
            if (dx * dx + dy * dy > 0.4 && t > keep) continue;
            const lit = -dx * 0.55 - dy * 0.7;
            b.set(xx, yy, lit > 0.3 ? 0xffffff : lit > -0.35 ? 0xe8e6ec : 0xc4c2d0);
          }
        }
      }
    },
    undefined,
    false,
  );
}

/** Sakura petals scattered on the ground under a tree. */
export function petals(seed: number, count = 9, spread = 18): Sprite {
  // Fallen cherry petals lying on the ground: each a little oval (two or
  // three pixels, turned its own way), lit on its sunny end and a deeper
  // rose on the other, the odd one curled with its notch showing.
  const w = spread * 2 + 4;
  const h = Math.round(spread * 0.8) + 4;
  const deep = mix(K.sakuraDark, 0xb0587a, 0.35);
  return make(
    w,
    h,
    Math.round(w / 2),
    h - 2,
    (b) => {
      const rnd = stream(seed);
      for (let i = 0; i < count; i++) {
        const x = Math.round(2 + rnd() * (w - 4));
        const y = Math.round(2 + rnd() * (h - 4));
        const turn = Math.floor(rnd() * 4);
        const big = rnd() < 0.45;
        // Its lit end, then its body, then (bigger ones) the shaded tip.
        const steps: ReadonlyArray<readonly [number, number]> =
          turn === 0
            ? [
                [0, 0],
                [1, 0],
                [2, 0],
              ]
            : turn === 1
              ? [
                  [0, 0],
                  [0, 1],
                  [0, 2],
                ]
              : turn === 2
                ? [
                    [0, 0],
                    [1, 1],
                    [2, 1],
                  ]
                : [
                    [0, 0],
                    [1, 0],
                    [1, 1],
                  ];
        const tones = [K.sakuraLight, K.sakura, deep] as const;
        steps.forEach(([dx, dy], k) => {
          if (k === 2 && !big) return;
          b.set(x + dx, y + dy, tones[k] ?? K.sakura);
        });
        // A curled petal shows its paler underside notch.
        if (big && rnd() < 0.3) b.set(x, y + (turn === 1 ? 0 : 1), 0xfff0f4);
      }
    },
    undefined,
    false,
  );
}

/** A tabby cat, mid-stride. */
export function walkingCat(): Sprite {
  const fur = 0xc89060;
  const stripe = 0x8a5a34;
  const belly = 0xf2dcc0;
  return make(
    16,
    12,
    8,
    11,
    (b) => {
      b.ellipse(8, 7, 5.5, 2.6, fur);
      b.rect(5, 8, 6, 1, belly);
      for (const x of [6, 9, 12]) b.rect(x, 5, 1, 2, stripe);
      // Head, facing right, ears up.
      b.ellipse(13, 5, 2.6, 2.4, fur);
      b.set(12, 2, fur);
      b.set(14, 2, fur);
      b.set(14, 5, 0x2a1a10);
      b.set(15, 6, 0xd88a8a);
      // Tail curling up behind.
      b.rect(2, 4, 1, 4, fur);
      b.set(3, 3, fur);
      b.set(2, 3, stripe);
      // Legs, one forward one back.
      b.rect(5, 9, 1, 2, fur);
      b.rect(8, 9, 1, 2, stripe);
      b.rect(10, 9, 1, 2, fur);
      b.rect(12, 9, 1, 2, stripe);
    },
    { a: 0.25 },
  );
}

/** A dragonfly hovering over water. */
export function dragonfly(): Sprite {
  return make(
    11,
    7,
    5,
    6,
    (b) => {
      b.rect(2, 3, 7, 1, 0x3a8ad8);
      b.set(9, 3, 0x2a5aa8);
      b.rect(3, 1, 2, 2, 0xd8ecff);
      b.rect(6, 1, 2, 2, 0xd8ecff);
      b.rect(3, 4, 2, 2, 0xc8e0f8);
      b.rect(6, 4, 2, 2, 0xc8e0f8);
    },
    undefined,
    false,
  );
}
