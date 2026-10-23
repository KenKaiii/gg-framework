// High-angle ("3/4 from above") art for the cosy Goal world. The camera looks
// down at about 60°, so for anything that stands up the TOP is the biggest
// thing you see: a roof is mostly roof, a tub is mostly its rim and water, a
// tree is mostly canopy. Vertical faces are short bands under their tops.
// Matched pixel by pixel against hand-made farm-sim art. Pure.

import { PixelBuffer, hash, mix, noise, stream, type Palette, type Rgb } from "./goal-map-pixels";
import type { Sprite } from "./goal-map-props";
import type { Spot } from "./goal-farm-travel";
import { shadeGrid, type Material } from "./critter-shade";
import { PAPER, THATCH, W, blob, thatchBlotch, type Bay } from "./goal-map-farm";
import { BARK_BROWN, barkTrunk } from "./goal-map-bark";

const LINE: Rgb = 0x3a1406;

function sprite(
  w: number,
  h: number,
  ax: number,
  ay: number,
  draw: (b: PixelBuffer) => void,
  shadow?: Sprite["shadow"],
  outline = 0.86,
): Sprite {
  const buf = new PixelBuffer(w, h);
  draw(buf);
  if (outline > 0) buf.outline(outline, LINE);
  return { buf, ax, ay, ...(shadow ? { shadow } : {}) };
}

/** A 4×4 ordered (Bayer) dither threshold, 0–1. */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;
function bayer4(x: number, y: number): number {
  return ((BAYER4[(y & 3) * 4 + (x & 3)] ?? 0) + 0.5) / 16;
}

/**
 * A step of `ramp` (darkest first) for a light level `v` (0 darkest … 1
 * lightest), the way GG Royale shades: whole steps, meeting through an
 * ordered dither rather than a blend.
 */
function rampStep(ramp: readonly Rgb[], v: number, x: number, y: number): Rgb {
  const n = ramp.length - 1;
  const t = Math.max(0, Math.min(n, v * n));
  const lo = Math.floor(t);
  // Solid steps; only a narrow seam between two of them is dithered.
  const f = t - lo;
  const up = f > 0.65 || (f > 0.35 && (f - 0.35) / 0.3 > bayer4(x, y));
  return ramp[up ? Math.min(n, lo + 1) : lo] ?? ramp[0] ?? 0;
}

/** Thatch colour at (x, y): mid-brown with ragged lighter patches and darker hollows. */
function thatchAt(x: number, y: number, seed: number, light: number): Rgb {
  const lift = thatchBlotch(x, y, seed);
  const hollow = noise(x * 0.4, y * 1.3, 5, seed + 3) < 0.18;
  let c: Rgb =
    lift > 0
      ? lift > 0.55 && light > 0
        ? THATCH.hi
        : mix(THATCH.base, THATCH.hi, 0.6)
      : THATCH.base;
  if (hollow && lift <= 0) c = THATCH.lo;
  if (light < -0.35 && lift < 0.4) c = THATCH.lo;
  if (light < -0.7) c = mix(THATCH.lo, THATCH.deep, 0.45);
  // A face turned up toward the sun is paler all over.
  if (light > 0.3) c = mix(c, THATCH.hi, (light - 0.2) * 0.6);
  return c;
}

/** How far each end of the house front is drawn in at the ground, in pixels. */
const TAPER_INSET = 9;

/** Bays with a veranda deck in front; the rest form the entrance, at ground level. */
const VERANDA: ReadonlySet<Bay> = new Set<Bay>(["shoji", "shojiOpen", "blind"]);

/** One shoji panel: a dark outline, a lit wooden frame, a lattice of paper panes, a panelled kickboard. */
function shojiFront(b: PixelBuffer, x: number, y: number, pw: number, ph: number): void {
  b.rect(x, y, pw, ph, W.line);
  b.rect(x + 1, y + 1, pw - 2, ph - 2, W.warm);
  b.rect(x + 1, y + 1, pw - 2, 1, W.hi);
  b.rect(x + 1, y + 1, 1, ph - 2, W.light);
  // The lattice: three rows of three panes, wooden bars between them.
  const paperBottom = y + Math.round(ph * 0.52);
  for (let py = y + 2; py < paperBottom; py++) {
    for (let px = x + 2; px < x + pw - 2; px++) {
      const bar = (px - x - 2) % 3 === 2 || (py - y - 2) % 3 === 2;
      if (bar) continue;
      // The paper glows with the daylight on it: brightest high on the left,
      // a step softer low on the right, the pane under each bar a touch
      // shaded by it (the paper is set back behind its lattice).
      const corner = (px - x - 2) % 3 === 0 && (py - y - 2) % 3 === 0;
      const under = (py - y - 2) % 3 === 0;
      const v = 0.75 - ((px - x) / pw) * 0.3 - ((py - y) / (paperBottom - y)) * 0.25;
      let c: Rgb = v > 0.55 ? PAPER.lit : mix(PAPER.lit, PAPER.base, 0.55);
      if (corner && v > 0.45) c = 0xfffaf0;
      else if (under) c = mix(c, PAPER.base, 0.35);
      b.set(px, py, c);
    }
  }
  // The rail under the paper, then the kickboard's raised panel.
  b.rect(x + 1, paperBottom, pw - 2, 1, W.base);
  b.rect(x + 1, paperBottom + 1, pw - 2, 1, W.hi);
  const kx = x + 3;
  const ky = paperBottom + 3;
  const kw = pw - 6;
  const kh = y + ph - 3 - ky;
  if (kw > 1 && kh > 1) {
    b.rect(kx - 1, ky - 1, kw + 2, kh + 2, W.face);
    b.rect(kx, ky, kw, kh, W.light);
    b.rect(kx, ky, kw, 1, W.hi);
  }
}

/** What fills one bay of the house front, `h` tall. */
function paintFrontBay(
  b: PixelBuffer,
  kind: Bay,
  x: number,
  y: number,
  w: number,
  h: number,
  seed: number,
  noren: Rgb,
): void {
  const half = Math.floor(w / 2);
  if (kind === "shoji" || kind === "blind") {
    shojiFront(b, x, y, half + 1, h);
    shojiFront(b, x + half, y, w - half, h);
    if (kind === "blind") {
      // A reed blind let half down over the panes, its cords and red tassels.
      const drop = Math.round(h * 0.42);
      for (let k = 0; k < drop; k++) {
        for (let px = x + 1; px < x + w - 1; px++) {
          let c: Rgb = k % 2 === 0 ? 0xdcc38a : 0xc3a466;
          if ((px - x) % 6 === 3) c = 0x8a6a3a;
          if (k === drop - 1) c = W.base;
          b.set(px, y + 1 + k, c);
        }
      }
      for (const tx of [x + 4, x + w - 5]) b.rect(tx, y + drop + 1, 1, 2, 0xc8442c);
    }
    return;
  }
  if (kind === "shojiOpen") {
    // One panel slid across the other: the room shows, dim, its tatami lit low down.
    shojiFront(b, x, y, half + 1, h);
    b.rect(x + half, y, w - half, h, W.line);
    for (let py = y + 1; py < y + h - 1; py++) {
      for (let px = x + half + 1; px < x + w - 1; px++) {
        const t = (py - y) / h;
        let c: Rgb = t < 0.55 ? 0x4a2a14 : (py - y) % 3 === 0 ? 0xa88f52 : 0xc8b070;
        if (t < 0.55 && px === x + half + 1) c = W.light; // the slid panel's edge
        b.set(px, py, c);
      }
    }
    // A hanging scroll on the far wall.
    b.rect(x + half + 5, y + 3, 5, 7, 0xe8dcc0);
    b.rect(x + half + 6, y + 5, 3, 3, 0x7a5a3a);
    b.rect(x + half + 4, y + 2, 7, 1, W.face);
    return;
  }
  if (kind === "glass") {
    // A sliding glass door: one big frosted pane over a panelled kickboard.
    b.rect(x + 1, y, w - 2, h, W.line);
    b.rect(x + 2, y + 1, w - 4, h - 2, W.warm);
    b.rect(x + 2, y + 1, 1, h - 2, W.hi);
    const gy1 = y + Math.round(h * 0.62);
    for (let py = y + 3; py < gy1; py++) {
      for (let px = x + 4; px < x + w - 4; px++) {
        const streak = (px + py * 2) % 11 < 2 || (px + py * 2) % 11 === 5;
        let c: Rgb = streak ? 0xdfe9df : 0xc4d6c8;
        if (px < x + 7 && py < y + 6) c = 0xa9bfae;
        if (hash(px, py, seed) < 0.05) c = 0xb4c8b8;
        b.set(px, py, c);
      }
    }
    b.rect(x + 3, y + 2, w - 6, 1, W.line);
    b.rect(x + 3, gy1, w - 6, 1, W.line);
    b.rect(x + 5, gy1 + 2, w - 10, h - (gy1 - y) - 4, W.face);
    b.rect(x + 6, gy1 + 3, w - 12, h - (gy1 - y) - 6, W.light);
    b.rect(x + 6, gy1 + 3, w - 12, 1, W.hi);
    return;
  }
  if (kind === "room") {
    // An open doorway into a pale room, a noren hanging across its top,
    // and a short stretch of board wall beside it.
    const ow = w - 9;
    b.rect(x, y, ow, h, W.line);
    for (let py = y + 1; py < y + h; py++) {
      for (let px = x + 1; px < x + ow - 1; px++) {
        const ux = (px - x) / ow;
        const uy = (py - y) / h;
        let c: Rgb = 0xeceae4;
        if (ux > 0.62 - uy * 0.25) c = 0xd6d3cb; // a soft shade across the back wall
        if (py >= y + h - 3) c = py === y + h - 3 ? 0xa89878 : 0xc0ae8c; // the floor
        b.set(px, py, c);
      }
    }
    // The noren: two cloth panels, lit along the top, a pale crest on each.
    for (let py = y + 1; py < y + 9; py++) {
      for (let px = x + 1; px < x + ow - 1; px++) {
        if (px === x + Math.floor(ow / 2) && py > y + 2) continue;
        b.set(
          px,
          py,
          py === y + 1 ? mix(noren, 0xffffff, 0.3) : py === y + 8 ? mix(noren, LINE, 0.3) : noren,
        );
      }
    }
    for (const cx of [x + Math.floor(ow / 4), x + Math.floor((ow * 3) / 4)])
      b.rect(cx, y + 4, 2, 2, 0xf0ece0);
    // The board wall beside it, a little wooden box hung on it.
    for (let py = y; py < y + h; py++) {
      for (let px = x + ow; px < x + w; px++) {
        const seam = (px - x - ow) % 3 === 2;
        b.set(px, py, seam ? W.base : (px - x - ow) % 3 === 0 ? W.light : W.warm);
      }
    }
    b.rect(x + ow + 2, y + 6, 6, 6, W.line);
    b.rect(x + ow + 3, y + 7, 4, 4, W.base);
    b.rect(x + ow + 3, y + 7, 4, 1, W.hi);
    return;
  }
  // storeDoor: a heavy plank sliding door with an iron bar.
  for (let py = y; py < y + h; py++) {
    for (let px = x + 1; px < x + w - 1; px++) {
      const seam = (px - x) % 4 === 0;
      b.set(px, py, seam ? W.base : (px - x) % 4 === 1 ? W.light : W.warm);
    }
  }
  b.rect(x + 1, y + Math.round(h * 0.45), w - 2, 2, 0x4a4440);
  b.rect(x + 1, y + Math.round(h * 0.45), w - 2, 1, 0x7a746e);
}

/**
 * The farmhouse from high above, read from a hand-drawn minka. The hipped
 * thatch is most of the picture, its eave a band of dark, spiky tufts. Under
 * it the front stands in the eave's shade: a lit fascia, a row of rafter
 * ends, a lintel beam, then the walls (tall shoji panels with paper lattices
 * and panelled kickboards, a room slid open, a reed blind). Along the left
 * part runs a deep veranda deck, its big pillars standing at the deck's
 * front edge and rising to the beam; the entrance on the right (a frosted
 * glass door, an open doorway under a noren) sits at ground level on a
 * threshold and step stones.
 */
export function farmhouseTop(seed: number, bays: readonly Bay[], noren: Rgb): Sprite {
  const bay = 30;
  const front = bays.length * bay + 6;
  const over = 12; // the eave overhangs each end
  const w = front + over * 2;
  const roofDepth = Math.round(front * 0.36) + 20; // how far back the roof runs
  const eaveY = roofDepth;
  const wallY = eaveY + 8; // under the fascia, the rafter ends and the beam
  const wallH = 20;
  const deckTop = wallY + wallH;
  const deckH = 13;
  const deckBottom = deckTop + deckH;
  const h = deckBottom + 4;
  const left = over;
  const ridgeL = Math.round(w * 0.2);
  const ridgeR = Math.round(w * 0.8);
  const ridgeY = 6;
  const veranda = bays.map((kind) => VERANDA.has(kind));
  const bayX = (i: number): number => left + 3 + i * bay;
  return sprite(
    w,
    h,
    Math.round(w / 2),
    deckBottom + 2,
    (b) => {
      // ── The walls, bay by bay: the entrance's run down to its threshold ──
      bays.forEach((kind, i) => {
        const bh = veranda[i] ? wallH : wallH + 4;
        b.rect(bayX(i), wallY, bay, bh, W.deep);
        paintFrontBay(b, kind, bayX(i) + 3, wallY, bay - 4, bh, seed + i * 13, noren);
      });
      // Posts between the bays, set into the wall.
      for (let i = 0; i <= bays.length; i++) {
        const px = bayX(i) - 1;
        const tall = !veranda[i] || !veranda[i - 1];
        const ph = tall && i > 0 && (!veranda[i - 1] || !veranda[i]) ? wallH + 4 : wallH;
        b.rect(px, wallY, 5, ph, W.line);
        b.rect(px + 1, wallY, 1, ph, W.hi);
        b.rect(px + 2, wallY, 1, ph, W.warm);
        b.rect(px + 3, wallY, 1, ph, W.base);
      }
      // The entrance's threshold board and its step stones, sandals left out.
      bays.forEach((kind, i) => {
        if (veranda[i]) return;
        const x0 = bayX(i) - 1;
        b.rect(x0, deckTop + 4, bay + 1, 1, W.hi);
        b.rect(x0, deckTop + 5, bay + 1, 1, W.base);
        b.rect(x0, deckTop + 6, bay + 1, 1, W.line);
        const sx = bayX(i) + 5;
        const sw = bay - 12;
        b.rect(sx - 1, deckTop + 7, sw + 2, 4, LINE);
        b.rect(sx, deckTop + 7, sw, 1, STONE.hi);
        b.rect(sx, deckTop + 8, sw, 1, STONE.light);
        b.rect(sx, deckTop + 9, sw, 1, STONE.base);
        if (kind === "room") {
          for (const dx of [3, 8]) {
            b.rect(sx + dx, deckTop + 8, 3, 2, 0x5a3418);
            b.rect(sx + dx, deckTop + 8, 3, 1, 0x8a5a30);
          }
        }
      });
      // ── The veranda deck: long boards seen from above, a lit nose, its front face ──
      const runs: Array<[number, number]> = [];
      veranda.forEach((v, i) => {
        if (!v) return;
        const last = runs[runs.length - 1];
        if (last && last[1] === i - 1) last[1] = i;
        else runs.push([i, i]);
      });
      for (const [a, z] of runs) {
        const x0 = bayX(a) - 3;
        const x1 = bayX(z + 1) + 2;
        for (let y = deckTop; y < deckBottom; y++) {
          const r = y - deckTop;
          for (let x = x0; x < x1; x++) {
            let c: Rgb;
            if (r === 0)
              c = W.shadow; // the shade at the foot of the wall
            else if (r <= deckH - 4) {
              const board = Math.floor((r - 1) / 3);
              const at = (r - 1) % 3;
              const joint = (x + board * 23) % 41 === 0;
              const tone = hash(Math.floor((x + board * 23) / 41), board, seed + 5);
              c = at === 2 || joint ? W.base : at === 0 ? W.hi : tone < 0.5 ? W.light : W.warm;
            } else if (r === deckH - 3)
              c = W.hi; // the deck's lit nose
            else if (r < deckH - 1) c = W.face;
            else c = W.line;
            b.set(x, y, c);
          }
        }
        // Short legs under the deck's front.
        for (let i = a; i <= z + 1; i++) b.rect(bayX(i) - 1, deckBottom, 4, 2, W.deep);
      }
      // Things left out on the deck: a cushion and a tea tray.
      const rnd = stream(seed + 30);
      const cushion = veranda.indexOf(true);
      if (cushion >= 0) {
        const cx = bayX(cushion) + 9 + Math.round(rnd() * 4);
        b.rect(cx - 1, deckTop + 2, 11, 7, LINE);
        b.rect(cx, deckTop + 3, 9, 5, 0xc0503a);
        b.rect(cx, deckTop + 3, 9, 1, 0xe07a5a);
        b.rect(cx, deckTop + 7, 9, 1, 0x8a3020);
        b.set(cx + 4, deckTop + 5, 0xe8c070);
      }
      const tray = veranda.lastIndexOf(true);
      if (tray > cushion) {
        const tx = bayX(tray) + 8;
        b.rect(tx - 1, deckTop + 3, 12, 6, LINE);
        b.rect(tx, deckTop + 4, 10, 4, W.face);
        b.rect(tx, deckTop + 4, 10, 1, W.hi);
        for (const dx of [2, 6]) {
          b.rect(tx + dx, deckTop + 4, 3, 3, 0xf0ece0);
          b.set(tx + dx + 1, deckTop + 5, 0x6a8a4a);
        }
      }
      // ── The veranda's pillars: standing at the deck's front, up to the beam ──
      for (let i = 0; i <= bays.length; i += 2) {
        if (!veranda[i] && !veranda[i - 1]) continue;
        const px = bayX(i) - 2;
        const y0 = wallY;
        const y1 = deckBottom - 1;
        b.rect(px, y0, 7, y1 - y0 + 1, W.line);
        b.rect(px + 1, y0, 1, y1 - y0, W.hi);
        b.rect(px + 2, y0, 2, y1 - y0, W.light);
        b.rect(px + 4, y0, 1, y1 - y0, W.warm);
        b.rect(px + 5, y0, 1, y1 - y0, W.base);
        // Grain running down the pillar.
        for (let y = y0 + 2; y < y1; y += 5) b.set(px + 3, y + (i % 3), W.warm);
      }
      // ── Under the eave: the lit fascia, the rafter ends, the lintel beam ──
      const bx0 = left - 4;
      const bx1 = left + front + 4;
      for (let x = bx0; x < bx1; x++) {
        b.set(x, eaveY, W.light);
        const dash = (x - bx0) % 6 < 4;
        b.set(x, eaveY + 1, W.line);
        b.set(x, eaveY + 2, dash ? W.hi : W.line);
        b.set(x, eaveY + 3, dash ? W.warm : W.line);
        b.set(x, eaveY + 4, W.line);
        b.set(x, eaveY + 5, W.hi);
        b.set(x, eaveY + 6, W.warm);
        b.set(x, eaveY + 7, W.line);
      }
      // The eave's shade over the top of the walls and pillars.
      for (let k = 0; k < 3; k++) {
        for (let x = bx0; x < bx1; x++) {
          if (b.opaque(x, wallY + k)) b.set(x, wallY + k, LINE, 0.42 - k * 0.13);
        }
      }

      // ── Seen from above, the front narrows toward the ground ──
      // Everything under the eave is drawn upright, then each row is drawn in
      // toward the middle, more the lower it is, so the corner pillars lean
      // inward like the reference's and the posts fan out from the base. Each
      // bay moves as one piece (its panes stay square); only posts and the
      // ends get squeezed.
      const mid = w / 2;
      const taperRows = h - eaveY;
      const taper = TAPER_INSET / (front / 2 + 4);
      const anchorOf = (x: number): number => {
        for (let i = 0; i < bays.length; i++) {
          if (x >= bayX(i) + 3 && x < bayX(i + 1) - 1) return bayX(i) + bay / 2;
        }
        return x;
      };
      for (let y = eaveY; y < h; y++) {
        const t = (y - eaveY) / taperRows;
        const row = b.data.slice(y * w * 4, (y + 1) * w * 4);
        b.data.fill(0, y * w * 4, (y + 1) * w * 4);
        for (let x = 0; x < w; x++) {
          const i = x * 4;
          if ((row[i + 3] ?? 0) === 0) continue;
          const dx = x + Math.round((mid - anchorOf(x)) * taper * t);
          if (dx < 0 || dx >= w) continue;
          const o = (y * w + dx) * 4;
          b.data[o] = row[i] ?? 0;
          b.data[o + 1] = row[i + 1] ?? 0;
          b.data[o + 2] = row[i + 2] ?? 0;
          b.data[o + 3] = row[i + 3] ?? 0;
        }
      }

      // ── The roof: front slope, hips, ridge ──
      for (let y = 0; y < roofDepth; y++) {
        // Where the roof's outline is at this row: narrow at the ridge, the
        // full eave width at the bottom, curving out like a heavy thatch.
        const t = y / roofDepth;
        const halfW = Math.round(
          (ridgeR - ridgeL) / 2 +
            4 +
            Math.sin((Math.min(1, t * 1.25) * Math.PI) / 2) * ((w - (ridgeR - ridgeL)) / 2 - 4),
        );
        const cx = w / 2;
        // The hip seams: lines from the ridge's ends down to the eave's corners.
        const seamL = ridgeL + (0 - ridgeL) * Math.min(1, (y - ridgeY) / (roofDepth - ridgeY));
        const seamR = ridgeR + (w - ridgeR) * Math.min(1, (y - ridgeY) / (roofDepth - ridgeY));
        for (let x = Math.round(cx - halfW); x < Math.round(cx + halfW); x++) {
          const onLeftHip = x < seamL;
          const onRightHip = x > seamR;
          // Both hip ends face up and out, so both catch more light than the
          // front slope (the left a little more, the sun being up and left).
          const light = onLeftHip ? 0.6 : onRightHip ? 0.4 : 0.15 - t * 0.2;
          let c = thatchAt(x, y, seed, light);
          // The whole roof is one heavy, rounded mass: lit high on the left
          // where it bellies toward the sun, settling into shade low on the
          // right, laid over the patch texture as a dithered wash (so the
          // straw keeps its own patches and hollows).
          const u = (x - (cx - halfW)) / Math.max(1, 2 * halfW);
          const form = (0.55 - u) * 1.2 + (0.45 - t) * 1.1;
          // Lit and shaded areas take whole steps of the thatch's own ramp:
          // full patches of light, full patches of shade, a dithered seam.
          const BY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;
          const d = ((BY[(y & 3) * 4 + (x & 3)] ?? 0) + 0.5) / 16;
          // Only the bodies of the patches move (base stays base where the
          // form is middling), so the straw's own pattern stays crisp.
          if (form > 0.5 || (form > 0.3 && (form - 0.3) / 0.2 > d)) {
            if (c === THATCH.base) c = mix(THATCH.base, THATCH.hi, 0.45);
          } else if (form < -0.5 || (form < -0.3 && (-0.3 - form) / 0.2 > d)) {
            if (c === THATCH.base) c = mix(THATCH.base, THATCH.lo, 0.65);
          }
          // The hip seams: a dark crease with a lit lip on the sunward side.
          if (Math.abs(x - seamL) < 1 || Math.abs(x - seamR) < 1) c = THATCH.lo;
          else if (Math.abs(x - seamL - 1) < 1) c = mix(c, THATCH.hi, 0.5);
          b.set(x, y, c);
        }
      }
      // The ridge: a long, rounded roll capped with dark beams.
      b.rect(ridgeL, ridgeY - 4, ridgeR - ridgeL, 7, THATCH.lo);
      b.rect(ridgeL, ridgeY - 4, ridgeR - ridgeL, 2, THATCH.hi);
      b.rect(ridgeL + 2, ridgeY, ridgeR - ridgeL - 4, 2, THATCH.deep);
      for (let x = ridgeL + 8; x < ridgeR - 8; x += 13) b.rect(x, ridgeY - 4, 3, 7, W.deep);
      const vx = Math.round(w / 2) - 7;
      b.rect(vx, ridgeY - 5, 14, 7, W.face);
      for (let k = 0; k < 4; k++) b.rect(vx + 2 + k * 3, ridgeY - 4, 1, 5, W.line);
      // Moss in the hollows near the bottom of the front slope.
      for (let i = 0; i < 26; i++) {
        const mx = Math.round(ridgeL + rnd() * (ridgeR - ridgeL));
        const my = Math.round(roofDepth * 0.55 + rnd() * roofDepth * 0.35);
        if (b.opaque(mx, my)) {
          b.set(mx, my, THATCH.moss);
          if (rnd() < 0.5) b.set(mx + 1, my, THATCH.moss);
        }
      }
      // The eave: a band of dark straw with spiky tufts rising from it into
      // the thatch, each its own height, the very edge darkest.
      for (let x = 0; x < w; x++) {
        let spike = 2;
        for (let k = Math.floor(x / 7) - 1; k <= Math.floor(x / 7) + 1; k++) {
          const c = k * 7 + hash(k, 1, seed + 8) * 5;
          const tall = 3 + hash(k, 2, seed + 8) * 8;
          spike = Math.max(spike, Math.round(tall - Math.abs(x + 0.5 - c) * 1.6));
        }
        for (let k = 0; k < spike; k++) {
          const y = eaveY - 1 - k;
          if (!b.opaque(x, y)) continue;
          b.set(
            x,
            y,
            k < 2 ? THATCH.deep : k === spike - 1 ? mix(THATCH.lo, THATCH.base, 0.5) : THATCH.lo,
          );
        }
      }
    },
    { a: 0.34 },
  );
}

/** Golden storehouse thatch: lighter and warmer than the farmhouse's. */
const KT = {
  line: 0x5a2410,
  deep: 0x5e3416,
  shade: 0x7c5328,
  lo: 0x93693a,
  base: 0xab814a,
  light: 0xb98e54,
  hi: 0xc69c60,
  sun: 0xd6b072,
  moss: 0x8a922f,
} as const;

/** The storehouse's golden boards. */
const KW = {
  line: 0x5a2410,
  seam: 0x93622f,
  dark: 0xa8763a,
  board: 0xbe8a47,
  lit: 0xd0a05a,
  hi: 0xe0b878,
  shadow: 0x6e3c18,
} as const;

/** The stone platform a storehouse stands on. */
const PLINTH = {
  hi: 0xf0ece6,
  top: 0xd8d2ca,
  shade: 0xb4ada4,
  face: 0xa39b92,
  joint: 0x7e766e,
  foot: 0x6a625b,
} as const;

/**
 * Small, rounded clumps of straw on a jittered grid, with ragged edges:
 * how hand-drawn thatch reads (blobs, not streaks). 0 outside a clump.
 */
function strawClump(x: number, y: number, seed: number, density = 0.55): number {
  const cw = 7;
  const ch = 6;
  let best = 0;
  const gx0 = Math.floor(x / cw);
  const gy0 = Math.floor(y / ch);
  for (let gy = gy0 - 1; gy <= gy0 + 1; gy++) {
    for (let gx = gx0 - 1; gx <= gx0 + 1; gx++) {
      if (hash(gx, gy, seed) > density) continue;
      const ox = gx * cw + hash(gx, gy, seed + 1) * cw;
      const oy = gy * ch + hash(gx, gy, seed + 2) * ch;
      const rx = 1.9 + hash(gx, gy, seed + 3) * 2.6;
      const ry = 1.3 + hash(gx, gy, seed + 4) * 1.5;
      const ragged = (noise(x, y, 1.6, seed + 5) - 0.5) * 0.7;
      const d = ((x + 0.5 - ox) / rx) ** 2 + ((y + 0.5 - oy) / ry) ** 2 - ragged;
      best = Math.max(best, 1 - d);
    }
  }
  return best;
}

/**
 * A kura (storehouse) from above, built the way a pixel artist builds one:
 *
 * - a long hip-and-gable thatch running back from the viewer, its back
 *   rounding down like an arch from a wide ridge roll that runs down the
 *   middle (lit on its left, its straw ties showing as dashes on both edges,
 *   a dark crease where each slope rises to meet it);
 * - two side slopes of clumpy golden straw, the left in the sun, each lighter
 *   in its middle and darker at the ridge and the eave;
 * - at the front, a wide gable recess in deep shadow under the ridge's end:
 *   light board slats behind dark bargeboards, a vent, a lit tie beam and a
 *   row of rafter ends, the slopes darkening into a hood around it;
 * - a deep front skirt of sunlit straw with a ragged fringe;
 * - a golden board wall with lit posts on a sill, on a thin stone platform.
 */
export function kuraTop(seed: number): Sprite {
  const w = 66;
  const h = 122;
  const cx = 32.5;
  const RIDGE_L = 26;
  const RIDGE_R = 39;
  const RIDGE_TOP = 2;
  const RIDGE_END = 62;
  const GABLE_BASE = 78;
  const SKIRT = 82;
  const FRINGE = 93;
  const WALL_TOP = 96;
  const WALL_BOTTOM = 111;
  const WALL_L = 9;
  const WALL_R = 56;

  /** The slopes' top edge: an arch falling away from the ridge. */
  const roofTop = (x: number): number => {
    if (x >= RIDGE_L && x <= RIDGE_R)
      return x === RIDGE_L || x === RIDGE_R ? RIDGE_TOP + 1 : RIDGE_TOP;
    const t = x < RIDGE_L ? (RIDGE_L - x) / (RIDGE_L - 3) : (x - RIDGE_R) / (w - 4 - RIDGE_R);
    return Math.round(5 + 20 * (1 - Math.sqrt(Math.max(0, 1 - Math.min(1, t) ** 2))));
  };
  /** The side eaves: leaning out a little toward the front, rounding in at the corners. */
  const sideL = (y: number): number => {
    if (y < 40) return 4;
    if (y <= 86) return 3;
    if (y <= 91) return 3 + Math.round(5 - Math.sqrt(Math.max(0, 25 - (y - 86) ** 2)));
    return 8;
  };
  // Opens from the ridge's width to ~4/5 of the roof: broad and shallow.
  const gableHalf = (y: number): number =>
    7 + (Math.min(y, GABLE_BASE) - RIDGE_END) * (17 / (GABLE_BASE - RIDGE_END));
  const gableDist = (x: number, y: number): number => Math.abs(x + 0.5 - (cx + 0.5)) - gableHalf(y);
  const inGable = (x: number, y: number): boolean =>
    y > RIDGE_END && y <= GABLE_BASE + 3 && gableDist(x, y) <= 0;

  /** Straw on a slope or the skirt: clumps of light straw, darker hollows. */
  const straw = (x: number, y: number, lit: number, s: number): Rgb => {
    const lift = strawClump(x * 0.8, y * 0.85, s, 0.4);
    const hollow = strawClump(x * 0.8 + 3, y * 0.85 + 2, s + 50, 0.18);
    let c: Rgb = lit > 0.5 ? KT.light : lit > 0 ? KT.base : mix(KT.base, KT.lo, 0.45);
    if (lift > 0.45) c = lit > 0 ? KT.sun : KT.hi;
    else if (lift > 0) c = lit > 0 ? KT.hi : KT.light;
    else if (hollow > 0.2) c = lit > 0 ? KT.lo : KT.shade;
    return c;
  };

  return sprite(
    w,
    h,
    33,
    h - 3,
    (b) => {
      // ── The stone platform: a thin pale border around the wall ──
      for (let y = 92; y <= 117; y++) {
        for (let x = 6; x <= 59; x++) {
          let c: Rgb;
          if (y >= 114) {
            c = y === 117 ? PLINTH.foot : (x - 6) % 9 === 0 ? PLINTH.joint : PLINTH.face;
            if (y === 114 && (x - 6) % 9 !== 0) c = PLINTH.shade;
          } else {
            c = x >= 57 ? PLINTH.shade : PLINTH.top;
            if (x === 6 || y === 113) c = PLINTH.hi;
          }
          b.set(x, y, c);
        }
      }

      // ── The board wall, its posts and sill ──
      for (let y = WALL_TOP; y <= WALL_BOTTOM; y++) {
        for (let x = WALL_L; x <= WALL_R; x++) {
          const k = (x - WALL_L) % 5;
          const plank = Math.floor((x - WALL_L) / 5);
          // The wall faces us, lit from the left: the boards on the left
          // catch more sun than those on the right, each its own shade.
          const across = (x - WALL_L) / (WALL_R - WALL_L);
          const v = 0.7 - across * 0.45 + (hash(plank, 0, seed + 30) - 0.5) * 0.18;
          let c: Rgb = rampStep([KW.dark, KW.board, KW.lit, KW.hi], v, x, y);
          if (k === 0) c = KW.seam;
          else if (k === 1 && v > 0.35) c = mix(c, KW.hi, 0.4); // each board's lit edge
          // Grain: long, broken, slightly wavy lines down each board.
          const gx = x + Math.round(Math.sin(y / 3 + plank) * 0.5);
          if (k > 1 && hash(gx, Math.floor(y / 4), seed + 31) < 0.12) c = mix(c, KW.dark, 0.55);
          // A knot on some boards.
          if (k === 3 && Math.floor(y / 6) === 1 + (plank % 2) && hash(plank, 1, seed) < 0.3)
            c = KW.dark;
          b.set(x, y, c);
        }
      }
      for (const [px, lit] of [
        [WALL_L, true],
        [31, true],
        [WALL_R - 3, false],
      ] as const) {
        for (let y = WALL_TOP; y <= WALL_BOTTOM; y++) {
          b.set(px, y, KW.line);
          b.set(px + 1, y, lit ? KW.hi : KW.lit);
          b.set(px + 2, y, lit ? KW.lit : KW.board);
          b.set(px + 3, y, KW.seam);
        }
      }
      for (let x = WALL_L; x <= WALL_R; x++) {
        b.set(x, WALL_BOTTOM - 1, KW.hi); // the sill's lit edge
        b.set(x, WALL_BOTTOM, KW.dark);
        // The deep eave's shadow over the top of the wall.
        b.set(x, WALL_TOP, KW.shadow);
        b.set(x, WALL_TOP + 1, mix(b.rgb(x, WALL_TOP + 1), KW.shadow, 0.7));
        b.set(x, WALL_TOP + 2, mix(b.rgb(x, WALL_TOP + 2), KW.shadow, 0.35));
      }

      // ── The roof's slopes and skirt ──
      for (let y = 0; y <= FRINGE + 3; y++) {
        const l = sideL(y);
        const r = w - 1 - l;
        for (let x = l; x <= r; x++) {
          if (y < roofTop(x)) continue;
          if (y >= SKIRT) {
            // The front skirt: deep, sunlit straw with a ragged fringe.
            if (y >= FRINGE) {
              const tooth = Math.floor(hash(x >> 1, 7, seed) * 4);
              if (y > FRINGE + tooth) continue;
              b.set(x, y, y === FRINGE + tooth ? KT.deep : KT.lo);
              continue;
            }
            let c = straw(x, y + 60, 1, seed + 2);
            if (y === SKIRT)
              c = KT.deep; // shade under the rafter ends
            else if (y === SKIRT + 1) c = mix(c, KT.shade, 0.6);
            if (x <= l + 1 || x >= r - 1) c = mix(c, KT.shade, 0.5);
            b.set(x, y, c);
            continue;
          }
          if (x >= RIDGE_L && x <= RIDGE_R && y <= RIDGE_END) continue; // the ridge, below
          if (inGable(x, y)) continue; // the gable, below
          const leftSide = x < cx;
          // Each slope is lit in its middle, darker toward the ridge and the eave.
          const span = leftSide ? RIDGE_L - l : r - RIDGE_R;
          const along = leftSide ? (x - l) / span : (r - x) / span;
          // Each slope rolls over from its crown to the eave as one rounded
          // mass (smoothly, not in two bands), the left catching the sun and
          // the right turned away, with a dithered seam between its steps.
          const roll = Math.sin(Math.min(1, Math.max(0, along)) * Math.PI);
          const BY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;
          const dith = ((BY[(y & 3) * 4 + (x & 3)] ?? 0) + 0.5) / 16 - 0.5;
          const lit = (leftSide ? 0.55 : -0.32) + (roll - 0.55) * 0.75 + dith * 0.18;
          let c = straw(x, y, lit, seed);
          // The creases where the slopes rise to meet the ridge.
          const toRidge = leftSide ? RIDGE_L - 1 - x : x - RIDGE_R - 1;
          if (y <= RIDGE_END + 2 && toRidge >= 0 && toRidge < 3) {
            c = mix(
              c,
              leftSide ? KT.lo : KT.deep,
              toRidge === 0 ? 0.85 : toRidge === 1 ? 0.5 : 0.25,
            );
          }
          // The eaves: a darker rim just inside the outline.
          if (x === l || x === r) c = leftSide ? KT.lo : KT.shade;
          // The hood: the slopes darken into the gable's valleys.
          if (y > RIDGE_END - 3 && y < SKIRT) {
            const away = gableDist(x, Math.max(y, RIDGE_END + 1));
            if (away < 6) c = mix(c, KT.deep, Math.max(0, 0.85 - away * 0.15));
          }
          // The front corners turn away from the light.
          if (y > 72 && (x - l < 7 || r - x < 7)) c = mix(c, KT.shade, 0.4);
          b.set(x, y, c);
        }
      }

      // ── The ridge roll ──
      for (let y = RIDGE_TOP; y <= RIDGE_END; y++) {
        for (let x = RIDGE_L; x <= RIDGE_R; x++) {
          if (y < roofTop(x)) continue;
          const edge = x === RIDGE_L || x === RIDGE_R;
          const dash = (y + (x === RIDGE_L ? 0 : 2)) % 4 < 2;
          let c: Rgb;
          if (edge) c = dash ? KT.line : KT.shade;
          else if (x === RIDGE_L + 1) c = KT.sun;
          else if (x >= RIDGE_R - 2) c = x === RIDGE_R - 1 ? KT.lo : KT.base;
          else {
            const lift = strawClump(x * 1.4, y, seed + 7, 0.7);
            c = lift > 0.3 ? KT.sun : lift > 0 ? KT.hi : KT.light;
          }
          // Its rounded cap at the back, and its end overhanging the gable.
          if (y === RIDGE_TOP && !edge) c = KT.hi;
          if (y >= RIDGE_END - 2)
            c = y === RIDGE_END ? KT.line : y === RIDGE_END - 1 ? KT.lo : mix(c, KT.lo, 0.5);
          b.set(x, y, c);
        }
      }

      // ── The gable: a dark recess with light slats, bargeboards, rafter ends ──
      for (let y = RIDGE_END + 1; y <= GABLE_BASE + 3; y++) {
        for (let x = 0; x < w; x++) {
          if (!inGable(x, y)) continue;
          const d = -gableDist(x, y); // how far inside the edge
          let c: Rgb;
          if (y <= GABLE_BASE) {
            if (d < 1)
              c = KT.line; // bargeboards
            else if (d < 2.2) c = W.deep;
            else if (y < 67)
              c = W.line; // deep under the ridge's end
            else if (y < GABLE_BASE - 1) {
              // Slats: light boards with dark gaps, lit toward the left.
              const slat = (y - 67) % 3;
              c = slat === 0 ? W.deep : slat === 1 ? (x < cx ? KW.lit : KW.board) : KW.dark;
            } else c = y === GABLE_BASE - 1 ? KW.hi : KW.lit; // the tie beam
          } else {
            // Rafter ends under the tie beam.
            c = y === GABLE_BASE + 3 ? KT.line : (x + 1) % 3 === 0 ? W.line : KW.hi;
            if (y === GABLE_BASE + 2 && (x + 1) % 3 !== 0) c = KW.lit;
          }
          b.set(x, y, c);
        }
      }
      // A louvred vent near the top of the gable.
      b.rect(30, 66, 6, 3, W.line);
      for (const vx of [31, 33]) b.rect(vx, 67, 1, 1, KW.seam);

      // ── Moss in the lower hollows of the slopes ──
      const rnd = stream(seed + 9);
      for (let i = 0; i < 16; i++) {
        const mx = Math.round(5 + rnd() * (w - 10));
        const my = Math.round(40 + rnd() * 38);
        const onSlope = (mx < RIDGE_L - 2 || mx > RIDGE_R + 2) && !inGable(mx, my);
        if (onSlope && b.opaque(mx, my)) {
          b.set(mx, my, KT.moss);
          if (rnd() < 0.5) b.set(mx + 1, my, KT.moss);
        }
      }
    },
    { a: 0.32 },
  );
}

/** Pale, sun-bleached kennel boards, sampled from a hand-drawn doghouse. */
const KN = {
  hi: 0xdeac72,
  light: 0xd49d62,
  base: 0xc79157,
  mid: 0xb07a4a,
  grain: 0x925f39,
  dark: 0x7c5234,
  deep: 0x64371f,
  hole: 0x4a0f0a,
  inside: 0x633f27,
  floor: 0x775033,
  floorLit: 0x946642,
} as const;

/**
 * A doghouse from above, read from a hand-drawn one: a big gabled roof of
 * pale boards whose ridge runs straight back from the viewer, the two
 * slopes falling away left and right, each with its own long grain strokes
 * and a thick eave along its lower edge. Under the inverted V of the eaves
 * the gable front shows: a lighter arched frame round a dark doorway, a
 * plank floor inside, a threshold board, and a corner post each side.
 */
export function kennelTop(): Sprite {
  const cx = 18;
  const span = 17; // each slope's width
  const w = cx * 2 + 1;
  const h = 46;
  // Each slope is a skewed band: its top (the back edge) and its eave both
  // fall away from the ridge.
  const slopeTop = (t: number): number => 1 + t * 8;
  const eave = (t: number): number => 22 + t * 13;
  return sprite(
    w,
    h,
    cx,
    h - 2,
    (b) => {
      // The front wall and the gable, behind the roof.
      for (let y = 20; y <= 42; y++) {
        for (let x = 5; x <= w - 6; x++) {
          const edge = x <= 6 || x >= w - 7;
          b.set(x, y, edge ? (x === 5 || x === w - 6 ? KN.mid : KN.base) : KN.light);
        }
      }
      // Corner posts, running down to the ground.
      for (const px of [5, w - 7]) {
        b.rect(px, 30, 2, 14, KN.base);
        b.rect(px + 1, 30, 1, 14, KN.dark);
      }
      // The arched frame, then the doorway inside it.
      const door = { x: cx + 0.5, y: 34, rx: 5.2, ry: 5.6 };
      const inArch = (x: number, y: number, grow: number): boolean =>
        x + 0.5 >= door.x - door.rx - grow &&
        x + 0.5 <= door.x + door.rx + grow &&
        (y >= door.y ||
          ((x + 0.5 - door.x) / (door.rx + grow)) ** 2 +
            ((y + 0.5 - door.y) / (door.ry + grow)) ** 2 <=
            1);
      for (let y = 22; y <= 40; y++) {
        for (let x = 6; x < w - 6; x++) {
          if (inArch(x, y, 0)) {
            const depth = y - (door.y - door.ry);
            let c: Rgb = depth < 2 ? KN.hole : y >= 37 ? KN.floor : KN.inside;
            if (y >= 37 && (x + y) % 5 === 0) c = KN.floorLit; // the floor planks
            if (y === 36) c = KN.dark;
            b.set(x, y, c);
          } else if (inArch(x, y, 1)) b.set(x, y, KN.hole);
          else if (inArch(x, y, 3)) b.set(x, y, y < door.y - 2 ? KN.hi : KN.light);
          else if (inArch(x, y, 4)) b.set(x, y, KN.mid);
        }
      }
      // The threshold board across the doorway.
      b.rect(9, 40, w - 18, 2, KN.light);
      b.rect(9, 40, w - 18, 1, KN.hi);
      b.rect(9, 42, w - 18, 1, KN.dark);
      // The roof: two slopes, the left lit, the right a shade darker.
      for (let x = 1; x < w - 1; x++) {
        if (x === cx) continue;
        const right = x > cx;
        const t = Math.abs(x - cx) / span;
        const y0 = Math.round(slopeTop(t));
        const y1 = Math.round(eave(t));
        for (let y = y0; y <= y1; y++) {
          // The left slope faces the sun (up and left), the right turns
          // away; each falls into shade toward its eave, in whole steps.
          const down = (y - y0) / Math.max(1, y1 - y0);
          const v = (right ? 0.34 : 0.8) - down * 0.32;
          let c: Rgb = rampStep([KN.grain, KN.mid, KN.base, KN.light, KN.hi], v, x, y);
          if (y > y1 - 2)
            c = y === y1 ? KN.dark : KN.grain; // the eave's thickness
          else if (Math.abs(x - cx) === 1)
            c = right ? KN.light : KN.hi; // beside the ridge
          else if (Math.abs(x - cx) === span) c = right ? KN.grain : KN.mid; // the outer edge
          b.set(x, y, c);
        }
        // Grain: long broken strokes running parallel to the eave.
        for (let k = 0; k < 4; k++) {
          const s = (k + 0.7) / 4.6;
          const gy = Math.round(y0 + s * (y1 - 2 - y0) + (hash(k, right ? 1 : 0, 41) - 0.5) * 2);
          const run = Math.floor((Math.abs(x - cx) + k * 3 + (right ? 2 : 0)) / 5);
          if (hash(run, k, right ? 43 : 42) < 0.3 || Math.abs(x - cx) < 2) continue;
          b.set(x, gy, KN.grain);
          if (hash(x, k, 44) < 0.35) b.set(x, gy - 1, right ? KN.light : KN.hi);
        }
      }
      // The ridge: a dark seam where the slopes meet.
      for (let y = 0; y <= Math.round(eave(0)); y++) b.set(cx, y, KN.deep);
    },
    { a: 0.3 },
  );
}

/**
 * A well bucket from high above, read from a hand-drawn one. We look down
 * into its wide mouth: a thin gold rim round the olive inside, the far wall
 * in shade and the near wall showing as a paler band across the bottom of
 * the opening. Below the mouth the green staves taper toward the ground,
 * their hoops curving like the rim does (seen from above), a shine down the
 * left; tall pale stones stand up its sides and crowd round its foot.
 */
/** The water down a well: darker than the pond, being in shade down the shaft. */
const WELL_WATER = {
  shadow: 0x2a2010,
  edge: 0x1f3a34,
  deep: 0x2f5a4e,
  base: 0x3f7262,
  light: 0x6a9c88,
  glint: 0xbfe2d4,
} as const;

/** Where the water sits in a well's mouth, from its top-left (see tubTop): for the live bucket. */
export const WELL_WATER_AT = { x: 18, y: 15 } as const;

export function tubTop(): Sprite {
  const C = {
    rim: 0xd8b860,
    rimLit: 0xf0d888,
    rimDark: 0xa88a3a,
    inner: 0x7f6a25,
    innerDark: 0x64441a,
    nearWall: 0x9a8030,
    green: 0x4f7c3e,
    greenHi: 0x93c67d,
    greenLight: 0x6fa055,
    greenDark: 0x3a5d2a,
    hoop: 0x2c4422,
  } as const;
  const w = 36;
  const h = 46;
  const cx = 18;
  const mouthY = 12;
  const mrx = 13;
  const mry = 9.5;
  return sprite(
    w,
    h,
    cx,
    h - 3,
    (b) => {
      // The staves: from the rim's widest row down, tapering to the ground.
      const top = mouthY;
      const bottom = 36;
      for (let y = top; y <= bottom; y++) {
        const t = (y - top) / (bottom - top);
        const half = mrx - t * 3.2;
        for (let x = Math.ceil(cx - half); x <= Math.floor(cx + half); x++) {
          const nx = (x + 0.5 - cx) / half;
          let c: Rgb = nx < -0.7 ? C.greenLight : nx > 0.6 ? C.greenDark : C.green;
          if (nx > -0.5 && nx < -0.2) c = C.greenHi; // the shine
          if (Math.round((x - cx) * 1.0 + 40) % 5 === 0 && Math.abs(nx) < 0.92)
            c = mix(c, C.hoop, 0.35); // stave joins
          // Hoops, curving like the rim: lower in the middle, rising to the sides.
          const curve = Math.round((1 - nx * nx) * 3.6);
          for (const hy of [top + 13, bottom - 5]) {
            if (y === hy + curve) c = C.hoop;
            if (y === hy + curve - 1) c = mix(c, C.greenHi, 0.4);
          }
          b.set(x, y, c);
        }
      }
      // The mouth: rim, the shaded inside, the near wall's paler band.
      for (let y = 0; y < mouthY + mry + 2; y++) {
        for (let x = 0; x < w; x++) {
          const dx = (x + 0.5 - cx) / mrx;
          const dy = (y + 0.5 - mouthY) / mry;
          const d = dx * dx + dy * dy;
          if (d > 1) continue;
          const ix = (x + 0.5 - cx) / (mrx - 1.6);
          const iy = (y + 0.5 - mouthY) / (mry - 1.4);
          const inside = ix * ix + iy * iy <= 1;
          let c: Rgb;
          if (!inside) c = dy < -0.4 && dx < 0.3 ? C.rimLit : dy > 0.5 ? C.rimDark : C.rim;
          else {
            // Looking down into it: the far wall drops away in shadow, and
            // water sits low in the shaft, dark green-blue, a pale glint on
            // it and a dark ring where it meets the wall.
            const wx = (x + 0.5 - cx) / (mrx - 3.2);
            const wy = (y + 0.5 - (mouthY + 2.6)) / (mry - 3.6);
            const water = wx * wx + wy * wy;
            if (water <= 1) {
              c = water > 0.72 ? WELL_WATER.edge : wy < -0.15 ? WELL_WATER.deep : WELL_WATER.base;
              // The sky's glint on the surface, up-left of the middle.
              if (wx > -0.55 && wx < -0.05 && wy > -0.62 && wy < -0.25) c = WELL_WATER.glint;
              if (wx > 0.15 && wx < 0.4 && Math.abs(wy - 0.2) < 0.18) c = WELL_WATER.light;
            } else {
              // The shaft's wall: darkest at the back, lit on the near side.
              c = iy < -0.2 ? WELL_WATER.shadow : iy < 0.45 ? C.innerDark : C.inner;
            }
          }
          b.set(x, y, c);
        }
      }
      // Tall stones standing up its sides, and low ones round its foot.
      const stone = (x: number, y: number, rx: number, ry: number, seed: number): void =>
        roundStone(b, x, y, rx, ry, seed);
      stone(4.5, 30, 4.2, 7, 81);
      stone(31.5, 30, 4.2, 7, 82);
      stone(9, 38.5, 5.4, 4, 83);
      stone(27, 38.5, 5.4, 4, 84);
      stone(18, 40, 5.8, 3.6, 85);
      // Grass poking up between them.
      for (const [x, y] of [
        [13, 42],
        [23, 42],
        [1, 37],
        [34, 37],
      ] as const) {
        b.set(x, y, 0x6f884b);
        b.set(x + 1, y - 1, 0x9cbd8a);
        b.set(x - 1, y - 1, 0x6f884b);
      }
    },
    { a: 0.28 },
  );
}

/** One canopy pad: a rounded dome with a lit crown, a dark rim and a ragged, leafy edge. */
function pad(
  b: PixelBuffer,
  cx: number,
  cy: number,
  r: number,
  T: { hi: Rgb; light: Rgb; base: Rgb; dark: Rgb; deep: Rgb },
  seed: number,
): void {
  const ry = r * 0.78;
  // A pad laid over others casts a band of shade onto what's under it, just
  // below and right of its own rim (where the sun, up and left, can't reach),
  // so stacked clumps read as layers with depth.
  for (let y = Math.floor(cy - ry); y <= cy + ry + 3; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r + 3; x++) {
      if (!b.opaque(x, y)) continue;
      const dx = (x + 0.5 - cx - 1.5) / r;
      const dy = (y + 0.5 - cy - 1.8) / ry;
      if (dx * dx + dy * dy > 1.02) continue;
      b.set(x, y, T.deep, 0.55);
    }
  }
  for (let y = Math.floor(cy - ry - 2); y <= cy + ry + 2; y++) {
    for (let x = Math.floor(cx - r - 2); x <= cx + r + 2; x++) {
      const dx = (x + 0.5 - cx) / r;
      const dy = (y + 0.5 - cy) / ry;
      // A ragged, leafy rim: small bites taken out of the edge.
      const edge = 1 + (noise(x, y, 1.8, seed) - 0.5) * 0.32;
      if (dx * dx + dy * dy > edge * edge) continue;
      // Light from the top left; the crown is lit, the underside dark.
      const lit = -dx * 0.5 - dy * 0.95 + (noise(x, y, 2.4, seed + 1) - 0.5) * 0.5;
      const rimDist = edge - Math.hypot(dx, dy);
      let c: Rgb =
        lit > 0.6
          ? T.hi
          : lit > 0.2
            ? T.light
            : lit > -0.25
              ? T.base
              : lit > -0.65
                ? T.dark
                : T.deep;
      // Leaves: thin, wandering darker lines between clusters, and lit
      // scallops along the top of each cluster, so the canopy reads as many
      // small leafy clumps rather than one smooth dome.
      const vein = noise(x * 1.3, y * 1.6, 2.6, seed + 5);
      if (Math.abs(vein - 0.5) < 0.045 && rimDist > 0.12) c = lit > 0.2 ? T.base : T.dark;
      else if (Math.abs(vein - 0.5) < 0.1 && vein > 0.5 && lit > -0.1)
        c = lit > 0.4 ? T.hi : T.light;
      if (rimDist < 0.12 && dy > -0.2)
        c = T.deep; // the dark lower rim
      // Rim light: the sunward edge of the pad catches a bright line.
      else if (rimDist < 0.1 && dx < 0.1 && dy < 0.1) c = T.hi;
      // Leaf scallops on the lit half: little two-pixel cups, a lit top
      // over its own shade, in a loose grid (not scattered flecks).
      const gx = Math.floor((x + (Math.floor(y / 3) % 2) * 2) / 4);
      const gy = Math.floor(y / 3);
      if (lit > -0.1 && rimDist > 0.15 && hash(gx, gy, seed + 3) < 0.42) {
        const lx = (x + (Math.floor(y / 3) % 2) * 2) % 4;
        const ly = y % 3;
        if (ly === 0 && lx > 0 && lx < 3) c = lit > 0.35 ? T.hi : T.light;
        else if (ly === 1 && lx === 3) c = lit > 0.35 ? T.base : T.dark;
      }
      b.set(x, y, c);
    }
  }
}

/**
 * A shade tree from above, built like the reference's: several canopy pads
 * stacked into a tall, lumpy crown, each pad its own dome, with gnarled
 * branches showing in the gaps between them and a short trunk at the foot.
 */
export function canopyTree(seed: number, tones: "green" | "olive" = "green", size = 1): Sprite {
  const T =
    tones === "olive"
      ? { hi: 0xc4b452, light: 0xa69e3c, base: 0x8a8430, dark: 0x666424, deep: 0x46431a }
      : { hi: 0xa6c64e, light: 0x82aa3c, base: 0x64902e, dark: 0x4a6e22, deep: 0x2e4c16 };
  const R = 11 * size;
  const w = Math.round(R * 4.4);
  const h = Math.round(R * 5.4);
  const rnd = stream(seed);
  return sprite(
    w,
    h,
    Math.round(w / 2),
    h - 3,
    (b) => {
      const cx = w / 2;
      // The trunk (goal-map-bark.ts) and the branches that hold the pads.
      const trunkTop = h - R * 1.6;
      const crown = barkTrunk(b, {
        x: cx,
        foot: h - 4,
        top: Math.round(trunkTop),
        width: Math.round(5 * size),
        lean: Math.sin(seed) * 2,
        seed,
      });
      // Pads: arranged in tiers, the top of the crown first, the lowest last.
      // Each tree its own crown: four to seven pads, placed by the seed.
      const pads: Array<[number, number, number]> = [
        [cx + (rnd() - 0.5) * R * 0.6, R * (0.95 + rnd() * 0.2), R * (0.72 + rnd() * 0.18)],
      ];
      const tiers = 3 + Math.floor(rnd() * 4);
      for (let k = 1; k < tiers + 1; k++) {
        const side = k % 2 === 0 ? 1 : -1;
        const y = R * (1.45 + k * 0.38 + (rnd() - 0.5) * 0.25);
        if (y > R * 3.1) break;
        pads.push([cx + side * R * (0.5 + rnd() * 0.4), y, R * (0.7 + rnd() * 0.16)]);
      }
      // Branches into each pad, drawn before the pads so they peek through:
      // thick at the trunk and thinning out, lit along their upper edge.
      for (const [px, py] of pads) {
        const steps = Math.max(4, Math.round(Math.hypot(px - crown.x, crown.y - py) / 1.5));
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const bx = Math.round(crown.x + (px - crown.x) * t);
          const by = Math.round(crown.y + (py + R * 0.3 - crown.y) * t);
          const thick = t < 0.45 ? 2 : 1;
          b.set(bx, by - 1, BARK_BROWN.light);
          for (let d = 0; d < thick; d++) b.set(bx + d, by, BARK_BROWN.base);
          b.set(bx + thick, by, BARK_BROWN.deep);
          b.set(bx, by + 1, BARK_BROWN.shadow);
        }
      }
      for (const [px, py, r] of pads) pad(b, px, py, r, T, seed + Math.round(px * 3 + py));
    },
    { a: 0.32, canopy: true },
  );
}

/** A low, clipped shrub from above: two or three overlapping pads, a bumpy mound. */
export function moundShrub(
  seed: number,
  tone: "green" | "olive" | "amber" = "green",
  r = 11,
): Sprite {
  const T =
    tone === "olive"
      ? { hi: 0xc4b452, light: 0xa69e3c, base: 0x8a8430, dark: 0x666424, deep: 0x46431a }
      : tone === "amber"
        ? { hi: 0xe2b45c, light: 0xc8923a, base: 0xaa742a, dark: 0x86561c, deep: 0x5e3a12 }
        : { hi: 0xa6c64e, light: 0x82aa3c, base: 0x64902e, dark: 0x4a6e22, deep: 0x2e4c16 };
  const w = Math.round(r * 2.6) + 4;
  const h = Math.round(r * 1.9) + 4;
  const rnd = stream(seed);
  return sprite(
    w,
    h,
    Math.round(w / 2),
    h - 2,
    (b) => {
      const cx = w / 2;
      const cy = h - r * 0.95;
      // Each bush its own shape: a single dome, a low spreading mound, a
      // tall stack, or a loose clump of small lumps.
      const shape = Math.floor(hash(seed, 7, 3) * 4);
      if (shape === 0) {
        pad(b, cx, cy - r * 0.15, r * 0.95, T, seed);
      } else if (shape === 1) {
        for (let k = 0; k < 4; k++) {
          const t = k / 3 - 0.5;
          pad(
            b,
            cx + t * r * 1.5,
            cy + Math.abs(t) * r * 0.3 - rnd() * r * 0.1,
            r * (0.5 + rnd() * 0.15),
            T,
            seed + k,
          );
        }
      } else if (shape === 2) {
        pad(b, cx + (rnd() - 0.5) * 2, cy - r * 0.5, r * 0.55, T, seed);
        pad(b, cx - r * 0.35, cy, r * 0.62, T, seed + 1);
        pad(b, cx + r * 0.38, cy + r * 0.05, r * 0.6, T, seed + 2);
      } else {
        const lumps = 3 + Math.floor(rnd() * 3);
        for (let k = 0; k < lumps; k++) {
          pad(
            b,
            cx + (rnd() - 0.5) * r * 1.4,
            cy + (rnd() - 0.6) * r * 0.5,
            r * (0.38 + rnd() * 0.22),
            T,
            seed + k,
          );
        }
      }
      // Some flower or fruit; most don't.
      const deco = hash(seed, 8, 3);
      if (deco < 0.38) {
        const petal =
          deco < 0.14 ? 0xfdf6ea : deco < 0.26 ? 0xf2b6c6 : deco < 0.32 ? 0xf6d24a : 0xd8394a;
        const count = Math.round(r * 0.6);
        for (let k = 0; k < count; k++) {
          const fx = Math.round(cx + (rnd() - 0.5) * r * 1.8);
          const fy = Math.round(cy - r * 0.3 + (rnd() - 0.5) * r * 0.9);
          if (!b.opaque(fx, fy) || !b.opaque(fx, fy + 1)) continue;
          b.set(fx, fy, petal);
          if (deco >= 0.32) b.set(fx + 1, fy + 1, mix(petal, 0x3a1406, 0.35));
          else b.set(fx, fy + 1, mix(petal, 0x3a1406, 0.2));
        }
      }
    },
    { a: 0.3 },
  );
}

// ── The rest of the yard, from above ─────────────────────────

const STONE = {
  hi: 0xeee9e2,
  light: 0xd8d2ca,
  base: 0xc1bab1,
  mid: 0xa59d94,
  side: 0x857c73,
  deep: 0x5e564e,
} as const;

/** Weathered stone: the base tone, mottled lighter and darker, with the odd fleck of moss. */
function stoneAt(x: number, y: number, seed: number, tone: Rgb): Rgb {
  const n = noise(x, y, 2.2, seed);
  let c = n > 0.7 ? mix(tone, STONE.hi, 0.45) : n < 0.25 ? mix(tone, STONE.side, 0.4) : tone;
  if (hash(x, y, seed + 1) < 0.025) c = mix(tone, 0x7c8a30, 0.6);
  return c;
}

/** Where a pond's parts sit inside its sprite, shared by the sprite and the live view. */
function pondLayout(width: number, height: number) {
  const left = 30; // room for the bamboo frame
  const padX = 17;
  const padTop = 17;
  const padBottom = 19;
  const rx = width / 2;
  const ry = height / 2;
  const w = left + width + padX * 2;
  const h = height + padTop + padBottom;
  const cx = left + padX + rx;
  const cy = padTop + ry;
  // The spout reaches out over open water, clear of the stones, and pours there.
  const pour = { x: Math.round(cx - rx * 0.42), y: Math.round(cy - ry * 0.16) };
  const mouth = { x: pour.x - 1, y: pour.y - 9 };
  const anchor = { x: Math.round(cx), y: Math.round(cy + 28) };
  return { w, h, rx, ry, cx, cy, pour, mouth, anchor };
}

/**
 * Where the pond's bamboo spout pours, relative to the pond sprite's anchor:
 * `mouth` is the end of the pipe, `pour` where its water hits the surface.
 * The live view animates the falling water and the ripples from these.
 */
export function pondSpout(width: number, height: number): { mouth: Spot; pour: Spot } {
  const { mouth, pour, anchor } = pondLayout(width, height);
  return {
    mouth: { x: mouth.x - anchor.x, y: mouth.y - anchor.y },
    pour: { x: pour.x - anchor.x, y: pour.y - anchor.y },
  };
}

/**
 * A koi pond from above, read from a hand-made one: a ring of big, chunky
 * stones (each its own shape, ringed in dark line, a soft facet or two on its
 * pale top, its lower face a shade darker), packed tight around jade water
 * that is mottled with pale foam and crossed by a broken net of dark lines,
 * a lily pad or two, koi, and a bamboo spout on its frame at the upper left
 * reaching out over the water. The spout is part of the sprite so it always
 * sits over the stones it leans on. `still` bakes in the koi, the falling
 * water and a ripple; the live view animates those itself.
 */
export function pondTop(width: number, height: number, seed: number, still = true): Sprite {
  const { w, h, rx, ry, cx, cy, pour, mouth, anchor } = pondLayout(width, height);
  return sprite(
    w,
    h,
    anchor.x,
    anchor.y,
    (b) => {
      paintPondWater(b, cx, cy, rx + 1, ry + 1, seed, pour);
      if (still) b.stamp(KOI, KOI_COLORS, Math.round(cx + 2), Math.round(cy + 1));
      lilyPad(b, cx + rx * 0.42, cy + ry * 0.3, 3.6, seed + 7);
      lilyPad(b, cx + rx * 0.58, cy - ry * 0.05, 2.4, seed + 8);
      if (still) {
        // One ripple spreading from where the water lands.
        for (let k = 0; k < 28; k++) {
          const a = (k / 28) * Math.PI * 2;
          b.set(
            Math.round(pour.x + 1 + Math.cos(a) * 7),
            Math.round(pour.y + Math.sin(a) * 3),
            POND.pale,
          );
        }
      }
      const water = b.data.slice();
      for (const stone of pondRing(cx, cy, rx, ry, seed)) paintPondStone(b, stone);
      shadeUnderStones(b, water);
      paintKakehi(b, mouth, cx - rx - 24, cy);
      if (still) paintFallingWater(b, mouth, pour, 0);
    },
    // Low stones: a thin shadow down their lower right, the shape of the ring.
    { a: 0.34, height: 4 },
    0,
  );
}

/**
 * The water falling from the spout's mouth to the surface: a three-pixel
 * column (lit left edge, bright broken core, shaded right edge) and a burst
 * of foam where it lands. `phase` slides the core's breaks down the column,
 * so redrawing with a rising phase makes it flow.
 */
export function paintFallingWater(
  b: PixelBuffer,
  mouth: { x: number; y: number },
  pour: { x: number; y: number },
  phase: number,
): void {
  for (let y = mouth.y + 1; y < pour.y; y++) {
    const k = (((y - phase) % 3) + 3) % 3;
    b.set(mouth.x, y, POND.light);
    b.set(mouth.x + 1, y, k === 0 ? POND.pale : POND.foam);
    b.set(mouth.x + 2, y, k === 2 ? POND.light : POND.mid);
  }
  b.rect(mouth.x - 1, pour.y - 1, 5, 2, POND.foam);
  b.set(mouth.x - 2, pour.y, POND.pale);
  b.set(mouth.x + 4, pour.y, POND.pale);
}

/**
 * A kohaku koi from above, head to the left: a tapered white body with
 * orange patches (lit along their top, deeper below), two eyes at the head,
 * pale side fins and a forked tail, all a little cooled by the water over it.
 */
export const KOI: readonly string[] = [
  "......kk............",
  ".....kffk...........",
  "..kkkkwwkkkkk....kk.",
  ".keOwwwwOOOwwkk.kffk",
  "kOOOwwwwOOOOwwwkkffk",
  ".keoWWWWoooWWkk.kffk",
  "..kkkkWWkkkkk....kk.",
  ".....kffk...........",
  "......kk............",
];

/** Koi colours, seen through the water: white and orange scales, pale fins. */
export const KOI_COLORS = {
  k: 0x2c4a32,
  w: 0xf4f1e6,
  W: 0xc8d6cc,
  O: 0xf2a070,
  o: 0xd8683a,
  e: 0x1a2a20,
  f: 0xa8cfc0,
} as const;

// ── Farm animals ────────────────────────────────────────────
// Read from hand-drawn ones and seen at the same high angle as everything
// else: side-on bodies with the top of the back showing, short foreshortened
// legs, a dark outline baked in ("k"). Shared by the still map and the live
// view, so the animals look the same in both.

/** A tabby, mid-stride, facing right (two steps). */
export const CAT_STEP_A: readonly string[] = [
  "...k............k...k....",
  "..kwk..........kok.kok...",
  ".kwowk........kopokopok..",
  ".kosk.........koooooookk.",
  ".kosk..kkkkkkkkohoooooook",
  "..koskklhlhlhlhooooeowwwk",
  "..kosklslsslsslooowwwwwnk",
  "...koolslsslsslowwwwwwwk.",
  "...kooooooooooooowwwwwk..",
  "....koccccccccccowwwkk...",
  "....kowkddkkkowkwwkdk....",
  "....kwwkddk.kwwkwwkddk...",
  ".....kk.kk...kk.kk.kk....",
];

export const CAT_STEP_B: readonly string[] = [
  "...k............k...k....",
  "..kwk..........kok.kok...",
  ".kwowk........kopokopok..",
  ".kosk.........koooooookk.",
  ".kosk..kkkkkkkkohoooooook",
  "..koskklhlhlhlhooooeowwwk",
  "..kosklslsslsslooowwwwwnk",
  "...koolslsslsslowwwwwwwk.",
  "...kooooooooooooowwwwwk..",
  "....koccccccccccowwwkk...",
  "....kddkowkkkddkwwkwk....",
  "...kddkkwwk.kddkkwwk.....",
  "....kk..kk...kk..kk......",
];

export const CAT_COLORS = {
  k: 0x3a1406,
  o: 0xc7833a,
  l: 0xdb9c52,
  h: 0xeab46a,
  s: 0x9a5a2b,
  d: 0x8a5228,
  w: 0xf7eccd,
  c: 0xdcc39e,
  p: 0xe8909a,
  e: 0x2a1208,
  n: 0xd86a6a,
} as const;

/** A white hen facing left, standing and pecking. */
export const HEN_STAND: readonly string[] = [
  "...kk.........",
  "..krrk........",
  ".krRrrk...kk..",
  ".kwwwwwk.kwwk.",
  "kewhwwwkkwwswk",
  "kywwwwwkwwwsdk",
  ".krwwwwwwwssdk",
  "..kwwhhwwwwsdk",
  "..kwwwwsssssdk",
  "...kwwssssddk.",
  "....kddddddk..",
  ".....kykkyk...",
  "....kyykyyk...",
  ".....kk.kk....",
];

/** The hen mid-stride: one leg forward, one back. */
export const HEN_WALK: readonly string[] = [
  "...kk.........",
  "..krrk........",
  ".krRrrk...kk..",
  ".kwwwwwk.kwwk.",
  "kewhwwwkkwwswk",
  "kywwwwwkwwwsdk",
  ".krwwwwwwwssdk",
  "..kwwhhwwwwsdk",
  "..kwwwwsssssdk",
  "...kwwssssddk.",
  "....kddddddk..",
  "...kyk.kkyk...",
  "..kyyk..kyyk..",
  "...kk....kk...",
];

export const HEN_PECK: readonly string[] = [
  "..............",
  "...........k..",
  "........kkkwk.",
  ".....kkkwwwswk",
  "...kkwwwwwwsdk",
  "..kwwwwwwwssdk",
  ".kwwhhwwwwssdk",
  "krwwwwwsssssdk",
  "krRwwwssssddk.",
  "kewwwddddddk..",
  "kywwrkykkyk...",
  ".kkkkyykyyk...",
  ".....kk.kk....",
  "..............",
];

export const HEN_COLORS = {
  k: 0x3a1406,
  w: 0xf6f2ea,
  h: 0xffffff,
  s: 0xd8cfc0,
  d: 0xb8ab98,
  r: 0xd8394a,
  R: 0xa82434,
  y: 0xf2b630,
  Y: 0xc88a1a,
  e: 0x2a1208,
} as const;

/** A shiba curled up asleep, head on its paws facing left, tail over its back. */
export const SHIBA_ASLEEP: readonly string[] = [
  "...k.k..............",
  "..kokokk....kkkk....",
  ".koloolok..kwwwwk...",
  ".koohhoookkwwsswwk..",
  "kooohhoooolllwwswk..",
  "kooeeooollhhhlwwok..",
  "knwwwwoolhhhhhloook.",
  "kwwwwwoolhllhhllook.",
  ".kwwwwwoollllllloosk",
  "..kwwwwwwooooooossk.",
  "...kwwwwwcccsssssk..",
  "....kwwwwckkkkkkk...",
  ".....kkkkk..........",
];

export const SHIBA_COLORS = {
  k: 0x3a1406,
  o: 0xd8803a,
  l: 0xe8a058,
  h: 0xf4c07a,
  s: 0xa85a28,
  w: 0xf8ecd0,
  c: 0xe0cfae,
  e: 0x2a1208,
  n: 0x1a0a04,
} as const;

/**
 * An animal grid lit the way the critters are (critter-shade.ts): its
 * hand-placed light and shade keys are folded into one material per part
 * (`merge`), then the shader models each part from the top left, with
 * hue-shifted ramps and outlines coloured from what they wrap. Handed back as
 * rows and a palette (one key per colour) for the farm's grid painters.
 */
export function lightAnimal(
  rows: readonly string[],
  colors: Readonly<Record<string, number>>,
  merge: Readonly<Record<string, string>>,
  materials: Readonly<Record<string, Material>>,
  seed: number,
): { rows: string[]; palette: Record<string, string> } {
  const folded = rows.map((row) =>
    [...row].map((k) => (k === "." ? "." : (merge[k] ?? k))).join(""),
  );
  const palette: Record<string, string> = {};
  for (const [k, c] of Object.entries(colors))
    palette[merge[k] ?? k] ??= `#${c.toString(16).padStart(6, "0")}`;
  for (const [k, c] of Object.entries(colors))
    if (!merge[k]) palette[k] = `#${c.toString(16).padStart(6, "0")}`;
  const lit = shadeGrid({ rows: folded, palette, materials, seed, relief: 0.8 });
  const out: Record<string, string> = {};
  const keyOf = new Map<string, string>();
  const grid = lit.map((row) =>
    row
      .map((c) => {
        if (!c) return ".";
        let k = keyOf.get(c);
        if (!k) {
          k = String.fromCharCode(0x100 + keyOf.size);
          keyOf.set(c, k);
          out[k] = c;
        }
        return k;
      })
      .join(""),
  );
  return { rows: grid, palette: out };
}

/** The hen's keys folded for lighting: k is her outline, the whites one feather coat. */
const HEN_MERGE: Readonly<Record<string, string>> = {
  k: "O",
  h: "w",
  s: "w",
  d: "w",
  R: "r",
  Y: "y",
  e: "K",
};
const HEN_MATERIALS: Readonly<Record<string, Material>> = {
  w: "fur",
  r: "skin",
  y: "flat",
  K: "flat",
};

/** The hen's frames, lit, keyed by which frame. */
export const HEN_LIT = {
  stand: lightAnimal(HEN_STAND, HEN_COLORS, HEN_MERGE, HEN_MATERIALS, 41),
  walk: lightAnimal(HEN_WALK, HEN_COLORS, HEN_MERGE, HEN_MATERIALS, 41),
  peck: lightAnimal(HEN_PECK, HEN_COLORS, HEN_MERGE, HEN_MATERIALS, 41),
} as const;

/** The cat's keys folded for lighting: one ginger coat, one cream, pink ears and nose flat. */
const CAT_MERGE: Readonly<Record<string, string>> = {
  k: "O",
  l: "o",
  h: "o",
  s: "o",
  d: "o",
  c: "w",
  e: "K",
  n: "N",
};
const CAT_MATERIALS: Readonly<Record<string, Material>> = {
  o: "fur",
  w: "fur",
  p: "flat",
  K: "flat",
  N: "flat",
};

/** The cat's two steps, lit. */
export const CAT_LIT = {
  a: lightAnimal(CAT_STEP_A, CAT_COLORS, CAT_MERGE, CAT_MATERIALS, 47),
  b: lightAnimal(CAT_STEP_B, CAT_COLORS, CAT_MERGE, CAT_MATERIALS, 47),
} as const;

/** A still sprite from an animal grid, anchored at its feet; casts a tight contact shadow. */
export function animalSprite(rows: readonly string[], colors: Palette): Sprite {
  const w = rows[0]?.length ?? 0;
  const h = rows.length;
  return sprite(w, h, Math.floor(w / 2), h - 2, (b) => b.stamp(rows, colors, 0, 0), { a: 0.26 }, 0);
}

const POND = {
  foam: 0xf0f9ed,
  pale: 0xdaefe2,
  light: 0xa4d4c2,
  base: 0x8ac0ab,
  mid: 0x7dae96,
  deep: 0x628670,
  crack: 0x46705a,
} as const;

/** The pond's water colours, for the live view's ripples and falling water. */
export const POND_WATER = POND;

/** The water: soft pale patches over jade, a broken net of dark lines, foam where the spout pours. */
function paintPondWater(
  b: PixelBuffer,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  seed: number,
  pour: { x: number; y: number },
): void {
  const shape = blob(seed, 0.1, 4);
  const rnd = stream(seed + 40);
  const cells: Array<[number, number]> = [];
  for (let i = 0; i < 15; i++)
    cells.push([cx + (rnd() - 0.5) * rx * 2, cy + (rnd() - 0.5) * ry * 2]);
  const ramp: readonly Rgb[] = [POND.deep, POND.mid, POND.base, POND.light, POND.pale];
  for (let y = Math.floor(cy - ry - 1); y <= cy + ry + 1; y++) {
    for (let x = Math.floor(cx - rx - 1); x <= cx + rx + 1; x++) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      if (!shape(nx, ny)) continue;
      // Water the way GG Royale paints it: depth first (pale and shallow at
      // the rim, deep jade in the middle), the sky's light reflected across
      // the upper left, a few broad slow patches, all in solid steps that
      // meet through a narrow dithered seam, so it reads calm, not grainy.
      const r = Math.hypot(nx, ny);
      // The rim itself sits under the stones, so the shallows start well in.
      const shallow = Math.min(1, Math.max(0, r - 0.2) / 0.55);
      const sky = Math.max(0, -nx * 0.6 - ny * 0.85);
      const patch = (noise(x * 0.6, y, 11, seed + 11) - 0.5) * 0.5;
      // Churned white only right where the spout's water lands; round it the
      // water stays jade, so the falling water and its ripples show against it.
      const splash = Math.max(0, 1 - Math.hypot(x - pour.x, (y - pour.y) * 1.6) / 4);
      // Calmer, deeper water where the ripples spread, so they read.
      const calm = Math.max(0, 1 - Math.hypot(x - pour.x, (y - pour.y) * 2.2) / 14);
      // Deep in the middle, pale toward the stones, the sky's light across
      // the upper left: the centre falls two whole steps below the rim.
      const deepness = Math.max(0, 1 - r / 0.7) ** 0.8;
      const v =
        0.78 -
        deepness * 0.7 +
        shallow * 0.1 +
        sky * 0.22 +
        patch * 0.7 -
        calm * 0.08 +
        splash * 0.9;
      let c = v > 0.98 ? POND.foam : rampStep(ramp, Math.min(1, v), x, y);
      // Glints: a few short horizontal dashes of light where the sky shows,
      // one per cell at most, never two cells stacked.
      const gx = Math.floor(x / 9);
      const gy = Math.floor(y / 5);
      const g = hash(gx, gy, seed + 16);
      const ox = Math.floor(hash(gx, gy, seed + 17) * 5);
      if (
        sky > 0.12 &&
        g < 0.4 &&
        (gx + gy) % 2 === 0 &&
        y % 5 === 2 &&
        x % 9 >= ox &&
        x % 9 < ox + 2 + (g < 0.12 ? 1 : 0)
      )
        c = POND.foam;
      // The net of dark lines: cell edges, broken here and there, gone in the foam.
      let near = Infinity;
      let next = Infinity;
      // Warped, so the lines wander instead of running ruler-straight.
      const wx = x + (noise(x, y, 6, seed + 14) - 0.5) * 7;
      const wy = y + (noise(x, y, 6, seed + 15) - 0.5) * 5;
      for (const [px, py] of cells) {
        const d = Math.hypot(wx + 0.5 - px, (wy + 0.5 - py) * 1.4);
        if (d < near) {
          next = near;
          near = d;
        } else if (d < next) next = d;
      }
      // Thinner and only in the deeper water, so the shallows stay clean.
      if (next - near < 0.7 && v < 0.6 && noise(x, y, 4, seed + 13) > 0.3) c = POND.crack;
      b.set(x, y, c);
    }
  }
  // Foam ringing the spot the spout hits.
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    b.set(
      Math.round(pour.x + Math.cos(a) * 3.2),
      Math.round(pour.y + Math.sin(a) * 1.8),
      POND.foam,
    );
  }
}

/**
 * Depth: the stones overhang the water, so a band of shadow runs along the
 * water's far edge (under the stones nearest the top) and a thin one down
 * its sides. `water` is the buffer as it was before the stones went down.
 */
function shadeUnderStones(b: PixelBuffer, water: Uint8ClampedArray): void {
  const covered = (x: number, y: number): boolean => {
    if (!b.inside(x, y)) return true;
    const i = (y * b.width + x) * 4;
    return (water[i + 3] ?? 0) === 0 || b.data[i] !== water[i] || b.data[i + 1] !== water[i + 1];
  };
  const marks: Array<[number, number, Rgb]> = [];
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      if (covered(x, y)) continue;
      if (covered(x, y - 1)) marks.push([x, y, POND.deep]);
      else if (covered(x, y - 2) || covered(x - 1, y) || covered(x + 1, y))
        marks.push([x, y, mix(b.rgb(x, y), POND.deep, 0.6)]);
      else if (covered(x, y - 3)) marks.push([x, y, mix(b.rgb(x, y), POND.deep, 0.3)]);
    }
  }
  for (const [x, y, c] of marks) b.set(x, y, c);
}

function lilyPad(b: PixelBuffer, x: number, y: number, r: number, seed: number): void {
  const dir = hash(1, 1, seed) < 0.5 ? 1 : -1;
  const ry = r * 0.7;
  const LEAF = [0x3e6a2a, 0x5a8a34, 0x6f9a3a, 0x94b84c, 0xb4d466] as const;
  // Its shadow on the water, down and right.
  b.ellipse(x + 1, y + 1, r + 1, ry + 1, POND.deep);
  for (let py = Math.floor(y - ry - 1); py <= y + ry + 1; py++) {
    for (let px = Math.floor(x - r - 1); px <= x + r + 1; px++) {
      const nx = (px + 0.5 - x) / r;
      const ny = (py + 0.5 - y) / ry;
      const d = nx * nx + ny * ny;
      // The notch: a wedge cut from the edge to the middle.
      const inNotch =
        Math.sign(nx) === dir && Math.abs(ny - nx * dir * 0.3) < 0.18 && Math.abs(nx) > 0.05;
      if (d > 1.25 || inNotch) continue;
      if (d > 1) {
        b.set(px, py, KOI_COLORS.k);
        continue;
      }
      const lit = -nx * 0.5 - ny * 0.8 + (1 - d) * 0.4;
      let c = rampStep(LEAF, Math.max(0, Math.min(1, 0.45 + lit * 0.5)), px, py);
      // Veins running out from the middle.
      const ang = Math.atan2(ny, nx);
      if (d > 0.08 && Math.abs(Math.sin(ang * 3 + seed)) < 0.12) c = LEAF[1];
      b.set(px, py, c);
    }
  }
  b.set(Math.round(x - r * 0.35), Math.round(y - ry * 0.4), LEAF[4]);
}

interface PondStone {
  readonly x: number;
  readonly y: number;
  readonly hw: number;
  readonly hh: number;
  readonly seed: number;
}

/** The ring: big stones spaced evenly round the rim, small ones tucked into the gaps outside. */
function pondRing(cx: number, cy: number, rx: number, ry: number, seed: number): PondStone[] {
  const Rx = rx + 5;
  const Ry = ry + 5;
  const stones: PondStone[] = [];
  const count = Math.round((2 * Math.PI * Math.sqrt((Rx * Rx + Ry * Ry) / 2)) / 13.5);
  for (let i = 0; i < count; i++) {
    const a = ((i + 0.5) / count) * Math.PI * 2 + (hash(i, 3, seed) - 0.5) * 0.12;
    const back = Math.sin(a) < -0.3; // the far side: bigger stones
    const out = 1 + (hash(i, 4, seed) - 0.5) * 0.06;
    stones.push({
      x: cx + Math.cos(a) * Rx * out,
      y: cy + Math.sin(a) * Ry * out,
      hw: 7.2 + hash(i, 5, seed) * 2.4 + (back ? 1 : 0),
      hh: 5.6 + hash(i, 6, seed) * 1.6 + (back ? 0.8 : 0),
      seed: seed * 31 + i,
    });
  }
  for (let i = 0; i < count; i++) {
    // Only on the near side and the right: the spout's frame stands on the left.
    const a = ((i + 1) / count) * Math.PI * 2;
    if (Math.cos(a) < -0.5 || hash(i, 7, seed) < 0.45) continue;
    if (Math.sin(a) < 0.1 && Math.cos(a) < 0.6) continue;
    stones.push({
      x: cx + Math.cos(a) * (Rx + 7),
      y: cy + Math.sin(a) * (Ry + 5),
      hw: 3.6 + hash(i, 8, seed) * 1.4,
      hh: 3 + hash(i, 9, seed) * 0.8,
      seed: seed * 37 + i,
    });
  }
  // Back to front, so nearer stones overlap the ones behind.
  return stones.sort((p, q) => p.y + p.hh - (q.y + q.hh) || p.x - q.x);
}

const ROCK = {
  hi: 0xf2ece0,
  top: 0xd8d0c4,
  facet: 0xbfb8b2,
  crack: 0x7e7884,
  side: 0x9f99a0,
  sideDark: 0x7e7884,
} as const;
/** The pond stones' full ramp, cool violet shade to warm sheen (as the stepping stones). */
const ROCK_STEPS: readonly Rgb[] = [0x5e5864, 0x7e7884, 0x9f99a0, 0xbfb8b2, 0xd8d0c4, 0xf2ece0];

/**
 * A rounded stone, drawn like the pond's and the path's: its own ink outline
 * (lighter along the sunlit upper left), a low dome lit from the upper left
 * in solid ramp steps, two planes meeting on its crown, a violet-grey side.
 */
function roundStone(
  b: PixelBuffer,
  x: number,
  y: number,
  rx: number,
  ry: number,
  seed: number,
): void {
  const inside = (xx: number, yy: number, grow: number): boolean => {
    const nx = (xx + 0.5 - x) / (rx + grow);
    const ny = (yy + 0.5 - y) / (ry + grow);
    return Math.abs(nx) ** 2.4 + Math.abs(ny) ** 2.4 <= 1;
  };
  const ang = hash(seed, 9, 4) * Math.PI;
  for (let yy = Math.floor(y - ry - 1); yy <= y + ry + 1; yy++) {
    for (let xx = Math.floor(x - rx - 1); xx <= x + rx + 1; xx++) {
      if (!inside(xx, yy, 1)) continue;
      const nx = (xx + 0.5 - x) / rx;
      const ny = (yy + 0.5 - y) / ry;
      if (!inside(xx, yy, 0)) {
        b.set(xx, yy, nx < 0.2 && ny < 0.1 ? mix(LINE, ROCK_STEPS[1] ?? LINE, 0.4) : LINE);
        continue;
      }
      const dome = 1 - Math.min(1, nx * nx + ny * ny);
      const plane = nx * Math.cos(ang) + ny * Math.sin(ang) > 0.1 ? -0.14 : 0.06;
      const lit = -nx * 0.5 - ny * 0.65 + dome * 0.42 + plane;
      b.set(xx, yy, rampStep(ROCK_STEPS, Math.max(0, Math.min(1, 0.5 + lit * 0.5)), xx, yy));
    }
  }
}

/**
 * One stone: a chunky, slightly squared shape ringed in dark line. Its pale
 * top is lit from the upper left with a soft facet or two; the band of its
 * near face along the bottom is a shade darker.
 */
function paintPondStone(b: PixelBuffer, s: PondStone): void {
  const amps = [0, 1, 2].map((k) => (hash(k, 1, s.seed) - 0.5) * 0.16);
  const phases = [0, 1, 2].map((k) => hash(k, 2, s.seed) * Math.PI * 2);
  const inside = (x: number, y: number, grow: number): boolean => {
    const nx = (x + 0.5 - s.x) / (s.hw + grow);
    const ny = (y + 0.5 - s.y) / (s.hh + grow);
    const a = Math.atan2(ny, nx);
    let r = 1;
    for (let k = 0; k < 3; k++) r += (amps[k] ?? 0) * Math.sin((k + 2) * a + (phases[k] ?? 0));
    return Math.abs(nx) ** 2.5 + Math.abs(ny) ** 2.5 <= r ** 2.5;
  };
  const x0 = Math.floor(s.x - s.hw - 3);
  const x1 = Math.ceil(s.x + s.hw + 3);
  const y0 = Math.floor(s.y - s.hh - 3);
  const y1 = Math.ceil(s.y + s.hh + 3);
  // The outline: lighter where the sun catches the stone's upper-left edge.
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // The whole grown shape, so it cuts a line over any stone drawn before.
      if (!inside(x, y, 1)) continue;
      const nx = (x + 0.5 - s.x) / s.hw;
      const ny = (y + 0.5 - s.y) / s.hh;
      // Lit only where the stone meets water or grass; where it laps over a
      // stone already drawn, the join stays full ink so the two separate.
      const under = b.opaque(x, y) ? b.rgb(x, y) : -1;
      const onStone =
        under === LINE ||
        (Object.values(ROCK) as number[]).includes(under) ||
        ROCK_STEPS.includes(under);
      b.set(x, y, !onStone && nx < 0.2 && ny < 0.1 ? mix(LINE, ROCK.side, 0.38) : LINE);
    }
  }
  const BY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;
  const tilt = (hash(5, 5, s.seed) - 0.5) * 0.5;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!inside(x, y, 0)) continue;
      const nx = (x + 0.5 - s.x) / s.hw;
      const ny = (y + 0.5 - s.y) / s.hh;
      const d = ((BY[(y & 3) * 4 + (x & 3)] ?? 0) + 0.5) / 16;
      const face = 0.42 + tilt * nx + Math.sin(nx * 3 + s.seed) * 0.08;
      let c: Rgb;
      if (ny > face) {
        // The side: lit where it turns to the sun, violet-grey turning away,
        // darkest and wet at the waterline.
        c = nx < -0.35 ? (ROCK_STEPS[2] ?? ROCK.side) : (ROCK_STEPS[1] ?? ROCK.sideDark);
        if (ny > 0.72 && (ny - 0.72) * 5 > d) c = ROCK_STEPS[0] ?? ROCK.sideDark;
      } else {
        // The top: a low dome lit from the upper left, cut into two planes
        // (the one turned to the sun a step brighter), in solid ramp steps.
        const dome = 1 - Math.min(1, nx * nx + ny * ny);
        const ang = hash(9, 9, s.seed) * Math.PI;
        const plane = nx * Math.cos(ang) + ny * Math.sin(ang) > 0.1 ? -0.15 : 0.06;
        const lit = -nx * 0.5 - ny * 0.6 + dome * 0.45 + plane;
        c = rampStep(ROCK_STEPS, Math.max(0, Math.min(1, 0.52 + lit * 0.48)), x, y);
      }
      b.set(x, y, c);
    }
  }
  // A crack or a facet edge across the top, on the bigger stones.
  if (s.hw > 6) {
    const len = 3 + Math.floor(hash(6, 6, s.seed) * 3);
    const sx = s.x + (hash(7, 7, s.seed) - 0.3) * s.hw * 0.6;
    const sy = s.y - s.hh * 0.35;
    const lean = hash(8, 8, s.seed) < 0.5 ? 1 : -1;
    for (let k = 0; k < len; k++) {
      const px = Math.round(sx + lean * k * 0.8);
      const py = Math.round(sy + k * 0.6);
      if (inside(px, py, -0.35)) b.set(px, py, ROCK.crack);
    }
  }
}

const BAMBOO = {
  hi: 0xe2e1a8,
  light: 0xc6c78b,
  base: 0x9fac4e,
  dark: 0x7c7e3f,
  deep: 0x5d6028,
  cut: 0xf0d860,
  cutDark: 0xb8963a,
  tie: 0x7a4a1c,
} as const;

/** An upright culm with its nodes, its cut top showing. */
function bambooPost(b: PixelBuffer, x: number, y0: number, y1: number): void {
  b.rect(x - 1, y0 - 1, 6, y1 - y0 + 2, LINE);
  for (let y = y0; y < y1; y++) {
    // A node every few pixels: a dark ring with a lit lip above it.
    const node = (y - y0) % 8 === 6;
    const lip = (y - y0) % 8 === 5;
    b.set(x, y, node ? BAMBOO.base : BAMBOO.hi);
    b.set(x + 1, y, node ? BAMBOO.dark : lip ? BAMBOO.hi : BAMBOO.light);
    b.set(x + 2, y, node ? BAMBOO.dark : lip ? BAMBOO.light : BAMBOO.base);
    b.set(x + 3, y, node ? BAMBOO.deep : BAMBOO.dark);
  }
  b.rect(x, y0, 4, 2, BAMBOO.cut);
  b.rect(x + 1, y0, 2, 1, BAMBOO.cutDark);
}

/** A culm lying from (x0, y0) to (x1, y1), lit along its top, its cut end open toward x1. */
function bambooPipe(b: PixelBuffer, x0: number, y0: number, x1: number, y1: number): void {
  const len = Math.max(1, x1 - x0);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i <= len; i++) {
      const x = x0 + i;
      const y = Math.round(y0 + ((y1 - y0) * i) / len);
      if (pass === 0) {
        for (let k = -2; k <= 3; k++) b.set(x, y + k, LINE);
        if (i === 0) for (let k = -2; k <= 3; k++) b.set(x - 1, y + k, LINE);
        if (i === len) for (let k = -2; k <= 3; k++) b.set(x + 1, y + k, LINE);
        continue;
      }
      const node = i % 9 === 7;
      b.set(x, y - 1, node ? BAMBOO.base : BAMBOO.hi);
      b.set(x, y, node ? BAMBOO.dark : BAMBOO.light);
      b.set(x, y + 1, node ? BAMBOO.dark : BAMBOO.base);
      b.set(x, y + 2, node ? BAMBOO.deep : BAMBOO.dark);
      if (i >= len - 1) {
        // The open, slant-cut mouth: bright inside, a dark hollow.
        b.set(x, y - 1, BAMBOO.cut);
        b.set(x, y, i === len ? BAMBOO.cutDark : BAMBOO.cut);
        b.set(x, y + 1, i === len ? BAMBOO.cutDark : BAMBOO.cut);
        b.set(x, y + 2, BAMBOO.cut);
      }
    }
  }
}

/**
 * The kakehi: two bamboo posts, a rail lashed across them, and a pipe angled
 * down from the taller post out over the stones, a thread of water falling
 * from its mouth to `pour`.
 */
function paintKakehi(b: PixelBuffer, mouth: { x: number; y: number }, x: number, cy: number): void {
  const postA = Math.round(x + 4);
  const postB = Math.round(x + 15);
  const railY = Math.round(cy + 4);
  bambooPost(b, postB, mouth.y - 11, railY + 9);
  bambooPipe(b, Math.round(x), railY, Math.round(x + 34), railY - 1);
  bambooPost(b, postA, railY - 9, railY + 13);
  bambooPipe(b, postB + 1, mouth.y - 7, mouth.x, mouth.y);
  // Lashings where the rail crosses the posts.
  for (const px of [postA, postB]) {
    b.rect(px, railY - 1, 3, 1, BAMBOO.tie);
    b.set(px + 1, railY + 1, BAMBOO.tie);
  }
}

/**
 * A torii from high above. The top beam (kasagi) is the biggest part: its
 * charcoal top surface seen deep, sweeping up at both ends, over a lit band of
 * red. Under it the plaque, gold with dark lettering, then the tie beam
 * (nuki) running past the pillars with wedges at each; the red pillars below
 * are short, lit down their left with a grain line, on black stone footings.
 */
export function toriiTop(): Sprite {
  const w = 52;
  const h = 40;
  const RED = { hi: 0xf07a5a, lit: 0xe0664a, base: 0xc8442c, dark: 0x9a301e, deep: 0x6e1e14 };
  const CAP = { top: 0x5a524c, hi: 0x7a706a, face: 0x2e2824, under: 0x1e1a18 };
  return sprite(
    w,
    h,
    26,
    37,
    (b) => {
      // Pillars, short (we look down on them), on footings.
      for (const px of [10, 37]) {
        for (let y = 16; y < 34; y++) {
          for (let x = 0; x < 6; x++) {
            let c: Rgb =
              x === 0
                ? RED.hi
                : x === 1
                  ? RED.lit
                  : x >= 5
                    ? RED.deep
                    : x === 4
                      ? RED.dark
                      : RED.base;
            if (x === 2 && hash(px, y, 3) < 0.35) c = RED.dark; // grain
            b.set(px + x, y, c);
          }
        }
        // Black stone footings, lit on top.
        b.rect(px - 1, 32, 8, 4, 0x2e2824);
        b.rect(px - 1, 32, 8, 1, 0x6a625c);
        b.rect(px, 33, 6, 1, 0x4a423c);
      }
      // The tie beam: past the pillars, a lit top, wedges at each pillar.
      b.rect(5, 17, w - 10, 4, RED.base);
      b.rect(5, 17, w - 10, 1, RED.hi);
      b.rect(5, 20, w - 10, 1, RED.deep);
      for (const px of [10, 37]) {
        b.rect(px + 1, 21, 4, 2, 0x8a6a40);
        b.rect(px + 1, 21, 4, 1, 0xb08a54);
      }
      // The plaque: a dark frame round gold, two characters on it.
      b.rect(22, 9, 8, 9, 0x2e2824);
      b.rect(23, 10, 6, 7, 0xe8c44a);
      b.rect(23, 10, 6, 1, 0xf8e08a);
      b.rect(25, 11, 2, 2, 0x5a3a14);
      b.rect(25, 14, 2, 2, 0x5a3a14);
      // The top beam: its top surface seen deep, upswept ends, a red band under it.
      for (let x = 0; x < w; x++) {
        const fromEnd = Math.min(x, w - 1 - x);
        const rise = fromEnd < 7 ? Math.round(((7 - fromEnd) / 7) ** 1.6 * 4) : 0;
        const y0 = 4 - rise;
        b.set(x, y0, CAP.hi);
        b.set(x, y0 + 1, CAP.top);
        b.set(x, y0 + 2, hash(x, 1, 5) < 0.2 ? CAP.hi : CAP.top);
        b.set(x, y0 + 3, CAP.face);
        if (x >= 2 && x < w - 2) {
          b.set(x, y0 + 4, RED.lit);
          b.set(x, y0 + 5, RED.base);
          b.set(x, y0 + 6, RED.base);
          b.set(x, y0 + 7, RED.deep);
        }
      }
    },
    { a: 0.28 },
  );
}

/**
 * A stone lantern (toro) from high above, in weathered, mottled granite: a
 * broad roof is most of it, its top seen deep with ridges running to curled
 * corners and a jewel knob; under it the firebox glows through its window;
 * then a short post with a ring, on a wide stepped base.
 */
export function lanternTop(): Sprite {
  const w = 24;
  const h = 32;
  const cx = 12;
  return sprite(
    w,
    h,
    cx,
    30,
    (b) => {
      // The stepped base.
      b.ellipse(cx, 27, 9, 3.4, STONE.side);
      b.ellipse(cx, 26.4, 8.4, 2.8, STONE.mid);
      b.ellipse(cx, 25.2, 6.2, 2, STONE.base);
      // The post, with a ring halfway.
      const POST: readonly Rgb[] = [STONE.side, STONE.mid, STONE.base, STONE.light, STONE.hi];
      for (let y = 18; y < 25; y++) {
        for (let x = cx - 2; x <= cx + 2; x++) {
          b.set(x, y, stoneAt(x, y, 61, POST[4 - (x - (cx - 2))] ?? STONE.base));
        }
      }
      b.rect(cx - 3, 21, 7, 1, STONE.mid);
      b.rect(cx - 3, 20, 7, 1, STONE.light);
      // The firebox: a stone frame round a warm window.
      for (let y = 11; y < 18; y++) {
        for (let x = cx - 5; x <= cx + 5; x++) {
          b.set(
            x,
            y,
            stoneAt(
              x,
              y,
              62,
              x < cx - 3
                ? STONE.light
                : x > cx + 3
                  ? x === cx + 5
                    ? STONE.side
                    : STONE.mid
                  : STONE.base,
            ),
          );
        }
      }
      // The window's glow warming the stone round it.
      for (const [gx, gy] of [
        [cx - 4, 13],
        [cx - 4, 14],
        [cx + 3, 13],
        [cx + 3, 14],
        [cx - 2, 11],
        [cx + 1, 11],
      ] as const)
        b.set(gx, gy, mix(b.rgb(gx, gy), 0xffcf6a, 0.3));
      b.rect(cx - 3, 12, 6, 4, 0x6a4a1a);
      b.rect(cx - 2, 12, 4, 4, 0xffcf6a);
      b.rect(cx - 2, 12, 4, 1, 0xfff0b0);
      b.set(cx - 1, 14, 0xfff7d8);
      b.rect(cx - 5, 17, 11, 1, STONE.side);
      // The roof: a wide cap seen from above, ridges to curled-up corners.
      for (let y = 0; y < 12; y++) {
        for (let x = 0; x < w; x++) {
          const dx = (x + 0.5 - cx) / 11.5;
          const dy = (y + 0.5 - 6.5) / 5.5;
          if (dx * dx + dy * dy > 1) continue;
          const lit = -dx * 0.6 - dy * 0.7 + (1 - dx * dx - dy * dy) * 0.3;
          let tone: Rgb = rampStep(
            [STONE.side, STONE.mid, STONE.base, STONE.light, STONE.hi],
            Math.max(0, Math.min(1, 0.5 + lit * 0.6)),
            x,
            y,
          );
          // Ridges radiating from the knob.
          const a = Math.atan2(dy, dx);
          if (Math.abs(Math.sin(a * 2)) < 0.12 && dx * dx + dy * dy > 0.15) tone = STONE.side;
          if (dy > 0.72) tone = STONE.side; // the cap's thick front edge
          b.set(x, y, stoneAt(x, y, 63, tone));
        }
      }
      // Curled corners.
      b.set(0, 4, STONE.light);
      b.set(w - 1, 4, STONE.base);
      // The jewel knob.
      b.ellipse(cx, 3, 2.2, 1.8, STONE.base);
      b.set(cx - 1, 2, STONE.hi);
      b.set(cx, 1, STONE.light);
    },
    { a: 0.28 },
  );
}

/**
 * A tea bench under a paper parasol (wagasa), from high above. The parasol
 * is the biggest thing: a round canopy of red panels between thin ribs
 * radiating from its cap, lit on its upper left, its rim scalloped. Below it
 * the bench: a red felt cloth over the seat (its top seen deep, a fold at
 * the front), short wooden legs, and a tray with a teapot and two cups.
 */
export function teaBenchTop(): Sprite {
  const w = 46;
  const h = 44;
  const RED = { hi: 0xf08468, lit: 0xe0604a, base: 0xc8442c, dark: 0x9a301e, deep: 0x6e1e14 };
  return sprite(
    w,
    h,
    23,
    41,
    (b) => {
      // The bench: legs, then the felt-covered seat.
      for (const x of [7, 37]) {
        b.rect(x, 37, 3, 4, W.base);
        b.rect(x, 37, 1, 4, W.hi);
      }
      for (let y = 28; y < 38; y++) {
        for (let x = 4; x < 42; x++) {
          // The felt drapes over the seat: lit along the top, rolling over
          // its front edge into shade, folds hanging down the front, the
          // left end catching more sun than the right.
          const across = (x - 4) / 38;
          let c: Rgb = y < 30 ? RED.lit : y > 35 ? RED.dark : RED.base;
          if (y === 28) c = across < 0.85 ? RED.hi : RED.lit;
          if (y === 37) c = RED.deep;
          if (y >= 30 && y <= 35 && across > 0.75) c = y > 33 ? RED.dark : RED.base;
          // Folds: soft vertical creases down the front, each a lit ridge
          // beside its shaded valley.
          if (y > 34 && y < 37) {
            const k = (x + Math.floor(hash(Math.floor(x / 6), 0, 71) * 3)) % 6;
            if (k === 0) c = RED.deep;
            else if (k === 1) c = RED.base;
          }
          // The felt's nap: a faint brushed sheen on the top.
          if (y > 29 && y < 33 && (x + y * 3) % 7 === 0 && across < 0.7) c = RED.lit;
          b.set(x, y, c);
        }
      }
      // The tray: wood, a teapot and two cups.
      b.rect(26, 27, 13, 6, W.line);
      b.rect(27, 28, 11, 4, W.warm);
      b.rect(27, 28, 11, 1, W.hi);
      b.ellipse(30, 29.5, 2.4, 2, 0x4a4a54);
      b.set(29, 28, 0x8a8a96);
      b.rect(32, 29, 1, 1, 0x4a4a54);
      for (const cx of [35, 37]) {
        b.set(cx, 29, 0xf2ece0);
        b.set(cx, 30, 0xb8b0a0);
      }
      // The pole down to the bench.
      b.rect(19, 22, 1, 8, W.face);
      // The parasol.
      const cx = 19;
      const cy = 12;
      const rx = 18;
      const ry = 12;
      for (let y = 0; y < 26; y++) {
        for (let x = 0; x < w; x++) {
          const dx = (x + 0.5 - cx) / rx;
          const dy = (y + 0.5 - cy) / ry;
          const d = Math.hypot(dx, dy);
          const a = Math.atan2(dy, dx);
          // A scalloped rim: each panel's edge bows out between the ribs.
          const ribs = 12;
          const scallop = 0.94 + 0.06 * Math.abs(Math.sin((a * ribs) / 2));
          if (d > scallop) continue;
          const lit = -dx * 0.55 - dy * 0.75;
          const panel = Math.floor(((a + Math.PI) / (Math.PI * 2)) * ribs) % 2;
          let c: Rgb = lit > 0.3 ? RED.hi : lit > 0 ? RED.lit : lit > -0.35 ? RED.base : RED.dark;
          if (panel === 1) c = mix(c, RED.deep, 0.14);
          // The ribs: thin dark lines from the cap.
          if (Math.abs(Math.sin((a * ribs) / 2)) < 0.07 && d > 0.15) c = RED.deep;
          if (d > scallop - 0.08) c = RED.deep; // the rim
          b.set(x, y, c);
        }
      }
      // The cap.
      b.ellipse(cx, cy, 2.2, 1.6, 0x5a1a10);
      b.set(cx - 1, cy - 1, RED.hi);
    },
    { a: 0.28 },
  );
}

/**
 * Boards laid side by side, the way this world's woodwork is drawn: each
 * board its own shade, a dark seam between boards with a lit bevel beside
 * it, broken grain strokes running along the board, and the odd knot.
 * `along` is the direction the boards run.
 */
function paintBoards(
  b: PixelBuffer,
  x0: number,
  y0: number,
  w: number,
  h: number,
  along: "x" | "y",
  size: number,
  seed: number,
): void {
  const RAMP: readonly Rgb[] = [KN.mid, KN.base, KN.light, KN.hi];
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const across = along === "x" ? y - y0 : x - x0;
      const run = along === "x" ? x - x0 : y - y0;
      const board = Math.floor(across / size);
      const at = across % size;
      // The whole surface lit from the upper left (each board a little its
      // own shade on top of that), in solid steps with a dithered seam.
      const v =
        0.78 -
        ((x - x0) / Math.max(1, w)) * 0.38 -
        ((y - y0) / Math.max(1, h)) * 0.22 +
        (hash(board, 0, seed) - 0.5) * 0.2;
      let c: Rgb = rampStep(RAMP, v, x, y);
      if (at === size - 1)
        c = KN.dark; // the seam
      else if (at === 0 && board > 0)
        c = mix(c, KN.hi, 0.5); // the lit bevel
      else if (noise(run, board * 7 + at, 5, seed + 1) > 0.72 && at > 0) c = KN.mid; // grain
      // Butt joints: boards end at different places.
      const joint = Math.floor(hash(board, 1, seed) * 40) + 9;
      if (run % joint === joint - 1 && at < size - 1) c = KN.grain;
      if (hash(x, y, seed + 2) < 0.006 && at > 0 && at < size - 1) c = KN.grain; // a knot
      b.set(x, y, c);
    }
  }
}

/** Darken a band under an overhang, `rows` deep, fading out. */
/**
 * The shade an eave throws on the wall under it, as GG Royale lays shadow: a
 * solid band right under the edge (the umbra), then a dithered fall-off, not
 * a smooth fade.
 */
function eaveShadow(b: PixelBuffer, x0: number, y0: number, w: number, rows: number): void {
  const solid = Math.max(1, Math.ceil(rows * 0.5));
  for (let k = 0; k < rows + 2; k++) {
    for (let x = x0; x < x0 + w; x++) {
      const y = y0 + k;
      if (!b.opaque(x, y)) continue;
      if (k < solid) b.set(x, y, mix(b.rgb(x, y), LINE, 0.46));
      else {
        const t = (k - solid + 1) / (rows + 2 - solid + 1);
        if (t < 1 - bayer4(x, y)) b.set(x, y, mix(b.rgb(x, y), LINE, 0.3));
      }
    }
  }
}

/**
 * A plank shed beside the house, seen from high above like everything else,
 * read from a hand-drawn one: almost all of it is its lean-to roof, a broad
 * sheet of boards sloping down toward the viewer, laid in overlapping
 * courses that step down a pixel along their length (so they run on a
 * slant), every board its own shade, a thick fascia at the eave. Under the
 * eave only a thin strip of the front shows, deep in shade: corner posts,
 * the end-grain of stacked firewood, a paper door's lower panes.
 */
export function annexTop(seed: number): Sprite {
  const w = 72;
  const roofH = 46;
  const frontH = 9;
  const h = roofH + frontH + 4;
  const course = 6;
  const boardLen = 34;
  return sprite(
    w,
    h,
    38,
    h - 2,
    (b) => {
      const y0 = roofH;
      // The strip of front under the eave, in shade.
      for (let y = y0 - 1; y < y0 + frontH; y++) {
        for (let x = 4; x < w - 4; x++)
          b.set(x, y, x < 28 ? KN.inside : y > y0 + frontH - 3 ? KN.mid : 0xc8bca4);
      }
      // Firewood end-on in the open bay: just the lower rows show.
      const rnd = stream(seed);
      for (let k = 0; k < 5; k++) {
        const lx = 8 + k * 4 + (rnd() - 0.5);
        const ly = y0 + 4 + (k % 2);
        b.ellipse(lx, ly, 2.2, 1.9, KN.deep);
        b.ellipse(lx, ly, 1.6, 1.4, 0xd8a870);
        b.set(Math.round(lx), Math.round(ly), KN.grain);
      }
      // The paper door's lower panes.
      b.rect(36, y0, 18, frontH - 1, KN.dark);
      for (let y = y0 + 1; y < y0 + frontH - 1; y++) {
        for (let x = 37; x < 53; x++) b.set(x, y, (x - 37) % 4 === 3 ? KN.base : 0xe6dcc6);
      }
      b.rect(37, y0 + frontH - 3, 16, 2, KN.base);
      // Posts, lit on their left.
      for (const px of [4, 28, w - 7]) {
        b.rect(px, y0 - 1, 3, frontH + 1, KN.base);
        b.rect(px, y0 - 1, 1, frontH + 1, KN.hi);
        b.rect(px + 2, y0 - 1, 1, frontH + 1, KN.dark);
      }
      // A stone footing along the ground.
      for (let x = 3; x < w - 3; x++) {
        b.set(x, y0 + frontH, hash(x >> 2, 1, seed) < 0.5 ? STONE.hi : STONE.light);
        b.set(x, y0 + frontH + 1, (x >> 2) % 2 === 0 ? STONE.mid : STONE.side);
      }
      eaveShadow(b, 4, y0 - 1, w - 8, 4);
      // The roof: its back edge a little narrower (further off), its courses on a slant.
      for (let y = 0; y < roofH; y++) {
        const inset = Math.round((1 - y / roofH) * 4);
        for (let x = inset; x < w - inset; x++) {
          // Courses climb a pixel every few columns, so the boards run on a slant.
          const slant = y + Math.floor(x / 4);
          const k = Math.floor(slant / course);
          const shifted = x + k * 13;
          const j = Math.floor(shifted / boardLen);
          const local = slant % course;
          // The roof's own light: lit high on the left, shaded low on the right.
          const v =
            0.78 - (x / w) * 0.34 - (y / roofH) * 0.26 + (hash(j, k, seed + 3) - 0.5) * 0.12;
          let c: Rgb = rampStep([KN.grain, KN.mid, KN.base, KN.light, KN.hi], v, x, y);
          if (local === 0)
            c = KN.grain; // the seam under the course above
          else if (local === 1)
            c = KN.mid; // the shadow the course above casts on this one
          else if (local === course - 1)
            c = mix(c, KN.hi, 0.35); // the course's lit lower lip
          else if (noise(x, y * 2, 6, seed + 5) > 0.78) c = KN.base; // grain
          if (shifted % boardLen === 0 && local > 0 && local < course - 1) c = KN.mid; // board ends
          if (x === inset) c = KN.hi;
          if (x >= w - inset - 2) c = x === w - inset - 1 ? KN.dark : KN.mid;
          b.set(x, y, c);
        }
      }
      // The fascia along the eave: thick, lit on top.
      b.rect(0, roofH - 4, w, 1, KN.hi);
      b.rect(0, roofH - 3, w, 2, KN.base);
      b.rect(0, roofH - 1, w, 1, KN.dark);
    },
    { a: 0.32 },
  );
}

/**
 * A carpenter's table from above: a thick top of long boards (lit along its
 * back edge, grained, knotted) carrying a plank half-planed, the plane,
 * curled shavings, a saw and a mallet; below it the front apron and four
 * legs, with deep shade under the top between them.
 */
export function benchTop(): Sprite {
  const w = 38;
  const h = 26;
  return sprite(
    w,
    h,
    19,
    24,
    (b) => {
      // Shade under the top, then the legs standing in it.
      b.rect(3, 16, w - 6, 7, mix(KN.deep, LINE, 0.3));
      for (const x of [2, 9, w - 12, w - 5]) {
        const front = x === 2 || x === w - 5;
        b.rect(x, 16, 3, front ? 8 : 5, front ? KN.base : KN.dark);
        if (front) {
          b.rect(x, 16, 1, 8, KN.hi);
          b.rect(x + 2, 16, 1, 8, KN.dark);
        }
      }
      // A stretcher between the front legs.
      b.rect(5, 20, w - 10, 2, KN.mid);
      b.rect(5, 20, w - 10, 1, KN.light);
      // The top, then its thick front edge.
      paintBoards(b, 1, 3, w - 2, 11, "x", 4, 61);
      b.rect(1, 3, w - 2, 1, KN.hi);
      b.rect(1, 14, w - 2, 1, KN.light);
      b.rect(1, 15, w - 2, 2, KN.mid);
      b.rect(1, 17, w - 2, 1, KN.dark);
      // A plank being planed, its fresh face pale, curls of shaving off its end.
      b.rect(5, 6, 19, 4, 0xf0d0a0);
      b.rect(5, 6, 19, 1, 0xfbe6c4);
      b.rect(5, 9, 19, 1, 0xc89a62);
      // The plane: a block with its steel iron and a knob.
      b.rect(14, 5, 7, 4, 0x8a5a34);
      b.rect(14, 5, 7, 1, 0xb07a4a);
      b.rect(17, 6, 1, 2, 0xd8d4cc);
      b.set(15, 6, 0x5a3a20);
      for (const [x, y] of [
        [25, 8],
        [27, 6],
        [26, 11],
        [8, 12],
        [30, 10],
      ] as const) {
        b.set(x, y, 0xfbe6c4);
        b.set(x + 1, y, 0xe8c48a);
        b.set(x + 1, y - 1, 0xfbe6c4);
      }
      // The saw: a toothed blade and a wooden grip.
      for (let x = 27; x < 35; x++) {
        b.set(x, 4, 0xe2ded6);
        b.set(x, 5, x % 2 === 0 ? 0x8f8880 : 0xc9c2b9);
      }
      b.rect(34, 3, 2, 4, 0x8a4e22);
      // A mallet lying at the front.
      b.rect(29, 11, 4, 3, 0xb07a4a);
      b.rect(29, 11, 4, 1, 0xd49d62);
      b.rect(24, 12, 5, 1, 0x8a5a34);
    },
    { a: 0.28 },
  );
}

const CLAY = {
  hi: 0xeec08a,
  light: 0xdcaa74,
  base: 0xc8905c,
  mid: 0xb07446,
  dark: 0x8e5634,
  deep: 0x6a3a22,
} as const;

/**
 * A kamado (clay stove) seen from high above: its broad top slab is most of
 * it (mottled clay, lit along the back and the front lip) with two iron pots
 * sunk in it, one lidded in wood, one of rice; under the lip only a short,
 * shaded strip of the front shows, two squat fire mouths glowing in it, on a
 * stone plinth.
 */
export function stoveTop(): Sprite {
  const w = 36;
  const h = 30;
  const lip = 19; // where the top slab ends and the front begins
  return sprite(
    w,
    h,
    18,
    28,
    (b) => {
      // The front strip: shaded clay with fine cracks.
      for (let y = lip; y < 26; y++) {
        for (let x = 2; x < w - 2; x++) {
          let c: Rgb = y === lip ? CLAY.dark : CLAY.mid;
          if (y > lip && noise(x, y, 3, 71) > 0.72) c = CLAY.base;
          if (hash(x, y, 72) < 0.03) c = CLAY.dark;
          if (x >= w - 4) c = CLAY.dark;
          b.set(x, y, c);
        }
      }
      // Two squat fire mouths, framed dark, embers glowing low.
      for (const [mx, hot] of [
        [11, true],
        [25, false],
      ] as const) {
        b.rect(mx - 4, lip + 1, 9, 6, CLAY.deep);
        b.rect(mx - 3, lip + 2, 7, 4, 0x2a1208);
        for (let x = mx - 3; x <= mx + 3; x++) {
          b.set(
            x,
            lip + 5,
            hot ? (x % 2 === 0 ? 0xffb03a : 0xff7a1a) : x % 3 === 0 ? 0xc84a1a : 0x5a1e0a,
          );
          if (hot && x % 2 === 1) b.set(x, lip + 4, 0xd8501a);
        }
        if (hot) b.set(mx, lip + 5, 0xffe08a);
      }
      // The stone plinth.
      for (let x = 1; x < w - 1; x++) {
        b.set(x, 26, x % 5 === 0 ? STONE.mid : STONE.hi);
        b.set(x, 27, STONE.base);
        b.set(x, 28, STONE.side);
      }
      // The top slab.
      for (let y = 1; y < lip; y++) {
        for (let x = 1; x < w - 1; x++) {
          // Smoothed clay, lit from the upper left; a few soot smudges and
          // trowel marks, darker round the pot holes.
          const v = 0.82 - (x / w) * 0.32 - (y / lip) * 0.2 + (noise(x, y, 6, 73) - 0.5) * 0.12;
          let c: Rgb = rampStep([CLAY.base, CLAY.light, CLAY.hi], v, x, y);
          if (hash(x >> 1, y, 74) < 0.04) c = CLAY.base;
          if (y === 1 || y === lip - 2) c = CLAY.hi;
          if (y === lip - 1) c = CLAY.base;
          if (x === w - 2) c = CLAY.base;
          b.set(x, y, c);
        }
      }
      for (const [px, lid] of [
        [11, true],
        [25, false],
      ] as const) {
        const py = 9.5;
        // The iron pot's rim, lit along its back, sunk in a dark ring of clay.
        b.ellipse(px, py, 6.8, 5.6, CLAY.mid);
        b.ellipse(px, py, 6, 4.9, 0x2a2420);
        b.ellipse(px, py, 5, 4, 0x4a423c);
        for (let x = px - 3; x <= px + 3; x++) b.set(x, Math.round(py - 4.6), 0x8a827a);
        if (lid) {
          // A wooden lid of three boards, a handle across it.
          b.ellipse(px, py, 4.2, 3.3, KN.light);
          for (let x = px - 4; x <= px + 4; x++) {
            if (b.rgb(x, Math.round(py - 1)) === KN.light) b.set(x, Math.round(py - 1), KN.mid);
            if (b.rgb(x, Math.round(py + 1)) === KN.light) b.set(x, Math.round(py + 1), KN.mid);
          }
          b.ellipse(px - 0.5, py - 2, 3, 0.8, KN.hi);
          b.rect(px - 3, Math.round(py), 7, 1, KN.grain);
          b.rect(px - 3, Math.round(py) - 1, 7, 1, KN.base);
        } else {
          // Rice, heaped and white, shaded at the pot's back wall.
          b.ellipse(px, py + 0.4, 4.2, 3.3, 0xf4efe2);
          b.rect(px - 3, Math.round(py - 3), 7, 1, 0xd8d0be);
          b.set(px - 1, Math.round(py), 0xffffff);
          b.set(px + 2, Math.round(py + 1), 0xffffff);
          b.set(px + 1, Math.round(py - 1), 0xffffff);
        }
      }
    },
    { a: 0.28 },
  );
}

/**
 * A notice board seen from high above: its little gabled roof (a ridge
 * running across, a short lit back slope, a long front slope of boards, a
 * thick eave) is most of it; under the eave the board's face shows short and
 * foreshortened, in shade, notes pinned to it, on two posts.
 */
export function notesBoardTop(seed: number): Sprite {
  const w = 34;
  const h = 32;
  const eave = 17;
  return sprite(
    w,
    h,
    17,
    30,
    (b) => {
      // Posts, lit on their left, down to the ground.
      for (const x of [5, w - 8]) {
        b.rect(x, eave, 3, 13, KN.base);
        b.rect(x, eave, 1, 13, KN.hi);
        b.rect(x + 2, eave, 1, 13, KN.dark);
      }
      // The board: a frame round cork, short because we look down on it.
      b.rect(3, eave, w - 6, 10, KN.dark);
      for (let y = eave + 1; y < eave + 9; y++) {
        for (let x = 4; x < w - 4; x++) {
          b.set(
            x,
            y,
            hash(x, y, seed) < 0.12 ? 0x9a7240 : noise(x, y, 3, seed) > 0.6 ? 0xc49a5e : 0xb08a52,
          );
        }
      }
      b.rect(3, eave + 9, w - 6, 1, KN.mid);
      // Notes: squat (foreshortened), each with a shadow and a red pin.
      const rnd = stream(seed);
      const colours = [0xfff1d8, 0xf6d24a, 0xf2b6c6, 0xbfe0f0, 0xe8f0c8];
      for (let i = 0; i < 5; i++) {
        const nw = 5 + Math.round(rnd());
        const nx = 5 + i * 5 + Math.round(rnd());
        const ny = eave + 3 + (i % 2) * 2;
        b.rect(nx + 1, ny + 1, nw, 3, 0x6a4a28);
        b.rect(nx, ny, nw, 3, colours[i] ?? 0xfff1d8);
        b.rect(nx + 1, ny + 1, nw - 2, 1, 0x9a8a74);
        b.set(nx + Math.floor(nw / 2), ny, 0xc8442c);
      }
      eaveShadow(b, 3, eave, w - 6, 2);
      // The roof: a short back slope, the ridge cap, a long front slope.
      // Boards laid in courses across the slopes, so they stay clean when the
      // board is leaned for the high camera.
      paintBoards(b, 2, 0, w - 4, 4, "x", 4, seed + 9);
      paintBoards(b, 0, 5, w, eave - 7, "x", 3, seed + 10);
      for (let y = 0; y < 4; y++)
        for (let x = 2; x < w - 2; x++) b.set(x, y, mix(b.rgb(x, y), KN.dark, 0.15));
      b.rect(1, 4, w - 2, 1, KN.hi);
      b.rect(1, 3, w - 2, 1, KN.light);
      b.rect(0, eave - 2, w, 1, KN.light);
      b.rect(0, eave - 1, w, 1, KN.dark);
    },
    { a: 0.28 },
  );
}

/**
 * A round red post box from high above: its domed top is the biggest part,
 * lit on its upper left with a shine, over a short cylinder shaded round its
 * curve (a lit stripe on the left, deep red on the right) with the slot under
 * a lip, a white plate, and a dark base band.
 */
export function postBoxTop(): Sprite {
  const w = 18;
  const h = 28;
  const RED = {
    shine: 0xfbb0a0,
    hi: 0xf08468,
    lit: 0xe0604a,
    base: 0xc8442c,
    dark: 0x9a301e,
    deep: 0x6e1e14,
  };
  return sprite(
    w,
    h,
    9,
    26,
    (b) => {
      // The body: a cylinder, shaded round its curve.
      for (let y = 10; y < 24; y++) {
        for (let x = 2; x < 16; x++) {
          const nx = (x + 0.5 - 9) / 7;
          const c: Rgb =
            nx < -0.7
              ? RED.lit
              : nx < -0.35
                ? RED.hi
                : nx < 0.35
                  ? RED.base
                  : nx < 0.75
                    ? RED.dark
                    : RED.deep;
          b.set(x, y, c);
        }
      }
      // The slot under its lip, the white plate, the dark base band.
      b.rect(4, 12, 10, 1, RED.hi);
      b.rect(5, 13, 8, 2, 0x2a1a10);
      b.rect(5, 17, 8, 4, 0xfff1d8);
      b.rect(5, 17, 8, 1, 0xffffff);
      b.rect(6, 19, 6, 1, 0xc8442c);
      b.rect(2, 23, 14, 2, 0x3a3230);
      b.rect(2, 23, 14, 1, 0x5a524c);
      // The domed top, seen deep from above.
      for (let y = 0; y < 13; y++) {
        for (let x = 0; x < w; x++) {
          const dx = (x + 0.5 - 9) / 8.4;
          const dy = (y + 0.5 - 7) / 6;
          const d = dx * dx + dy * dy;
          if (d > 1) continue;
          const lit = -dx * 0.6 - dy * 0.7;
          let c: Rgb = lit > 0.4 ? RED.hi : lit > 0 ? RED.lit : lit > -0.4 ? RED.base : RED.dark;
          if (dy > 0.75) c = RED.dark; // the dome's lower rim
          b.set(x, y, c);
        }
      }
      b.rect(5, 3, 3, 1, RED.shine);
      b.set(4, 4, RED.shine);
    },
    { a: 0.28 },
  );
}

/** The campfire's pot, from the high camera: its lid on top, its belly below. */
const FIRE_POT = [
  "..ooooo..",
  ".oLLHLLo.",
  "oLLHHLLLo",
  "oDLLLLLDo",
  "oDDDDDDDo",
  "oDSDDDDDo",
  ".oDDDDDo.",
  "..ooooo..",
];
const FIRE_POT_COLORS: Readonly<Record<string, Rgb>> = {
  o: 0x14100c,
  L: 0x5a5048,
  H: 0x7a7068,
  D: 0x2a2420,
  S: 0x4a4038,
};
/** Where the pot sits, from the pit's flame base (see Ambient.fire): 4 left, 8 up. */
export const FIRE_POT_OFFSET = { x: -4, y: -8 } as const;
/** How far above the flame base the tripod's top (the chain's hook) is. */
const FIRE_APEX_RISE = 17;

/**
 * The campfire's pot and the chain it hangs from, drawn through `set` so the
 * sprite and the live fire (which draws it again over its flames) share it.
 * (x, y) is the flame base: the middle of the pit, where the flames start.
 */
export function drawFirePot(
  set: (x: number, y: number, color: Rgb) => void,
  x: number,
  y: number,
): void {
  // The chain, from the tripod's top down to the lid's knob.
  for (let cy = y - FIRE_APEX_RISE; cy < y + FIRE_POT_OFFSET.y; cy++) {
    set(x, cy, cy % 2 ? 0x5a5048 : 0x2a2420);
  }
  FIRE_POT.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const color = FIRE_POT_COLORS[row[c] ?? "."];
      if (color !== undefined) set(x + FIRE_POT_OFFSET.x + c, y + FIRE_POT_OFFSET.y + r, color);
    }
  });
}

/**
 * A campfire from above: a ring of stones round the pit, logs crossed in the
 * middle, flames rising from them, and a pot hanging low over the fire from a
 * tripod whose feet stand inside the ring.
 */
export function fireTop(flames = true): Sprite {
  const w = 34;
  const h = 36;
  return sprite(
    w,
    h,
    17,
    33,
    (b) => {
      // The ring: stones around an oval pit, seen from above.
      const cx = 17;
      const cy = 26;
      // Ash in the pit, darker toward the middle.
      b.ellipse(cx, cy, 11, 6, 0x4a3a30);
      b.ellipse(cx, cy, 8.5, 4.4, 0x3a2a20);
      for (let k = 0; k < 14; k++) b.set(cx - 7 + ((k * 5) % 15), cy - 3 + ((k * 3) % 6), 0x6a5a50);
      // The ring: stones each their own size and shape, textured, lit up-left.
      for (let i = 0; i < 11; i++) {
        const a = (i / 11) * Math.PI * 2 + hash(i, 1, 9) * 0.2;
        const sx = cx + Math.cos(a) * 11.2;
        const sy = cy + Math.sin(a) * 6.2;
        const rx = 2.8 + hash(i, 2, 9) * 1.4;
        const ry = 2 + hash(i, 3, 9) * 0.9;
        roundStone(b, sx, sy, rx, ry, 90 + i);
        // Soot on the stones facing the fire.
        b.set(
          Math.round(sx - Math.cos(a) * rx * 0.6),
          Math.round(sy - Math.sin(a) * ry * 0.6),
          STONE.side,
        );
      }
      // Logs crossed in the pit: bark, a pale split face, charred, glowing ends.
      for (const [dir, tone] of [
        [1, W.face],
        [-1, W.base],
      ] as const) {
        for (let k = 0; k < 11; k++) {
          const x = cx - dir * 5 + dir * k;
          const y = cy - 1 + Math.round(k * 0.3);
          b.set(x, y, tone);
          b.set(x, y + 1, W.deep);
          if (k > 3 && k < 7) b.set(x, y, 0x2a1a14); // charred where it burns
        }
        b.set(cx - dir * 5, cy - 1, 0xe0b078);
        b.set(cx + dir * 5, cy + 2, 0xff8a2a);
      }
      // Embers glowing in the ash.
      b.ellipse(cx, cy, 4, 2, 0xff8a2a);
      b.ellipse(cx, cy - 0.5, 2.4, 1.2, 0xffd060);
      for (const [x, y] of [
        [cx - 5, cy + 2],
        [cx + 4, cy + 3],
        [cx - 2, cy + 3],
        [cx + 6, cy],
      ] as const)
        b.set(x, y, 0xff6a1a);
      // Flames, low and wide round the pot (the live view flickers its own).
      for (let y = 0; y < (flames ? 8 : 0); y++) {
        const t = y / 8;
        const half = Math.round((1 - t) * 6);
        for (let x = cx - half; x <= cx + half; x++) {
          b.set(
            x,
            cy - 2 - y,
            t > 0.6 ? 0xffd060 : Math.abs(x - cx) < half - 1 ? 0xffe8a0 : 0xff8a2a,
          );
        }
      }
      // The tripod: three poles from inside the ring up to a lashed top, the
      // back one mostly behind the pot. Lit on their upper side.
      const base = cy - 2;
      const apex = { x: cx, y: base - FIRE_APEX_RISE };
      for (const foot of [
        { x: cx + 3, y: cy - 6 },
        { x: cx - 10, y: cy + 1 },
        { x: cx + 10, y: cy + 1 },
      ]) {
        const steps = Math.max(Math.abs(foot.x - apex.x), Math.abs(foot.y - apex.y));
        for (let k = 0; k <= steps; k++) {
          const px = Math.round(foot.x + ((apex.x - foot.x) * k) / steps);
          const py = Math.round(foot.y + ((apex.y - foot.y) * k) / steps);
          b.set(px, py, k % 3 === 1 ? W.base : W.deep);
        }
      }
      // The lashing at the top.
      b.set(apex.x - 1, apex.y + 1, W.face);
      b.set(apex.x + 1, apex.y + 1, W.face);
      // The pot hangs low over the logs, in the fire, inside the ring.
      drawFirePot((x, y, color) => b.set(x, y, color), cx, base);
    },
    { a: 0.25 },
  );
}
