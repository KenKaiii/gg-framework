// Tree trunks for the top-down Goal map, drawn the way GG Royale draws its
// art: a trunk is a lit cylinder, not a strip of colour. It tapers from a
// flared foot to where the canopy takes it, leans or bends a little, and every
// tree has its own width, height, knot and root pattern from its seed. Across
// its width it's lit from the top left: a bright edge, the bark's own tone,
// a shaded far side and a dark rim. Bark grooves run up it in broken, wavy
// lines; knots sit as darker rings with a lit lip; roots splay out over the
// ground at its foot and fade into it. Pure: the same seed, the same pixels.

import { hash, mix, stream, type PixelBuffer, type Rgb } from "./goal-map-pixels";

/** A wood's tones, lightest to darkest. */
export interface BarkTones {
  readonly hi: Rgb;
  readonly light: Rgb;
  readonly base: Rgb;
  readonly shadow: Rgb;
  readonly deep: Rgb;
}

/** Warm brown bark (the farm's broadleaf and fruit trees). */
export const BARK_BROWN: BarkTones = {
  hi: 0xd8a368,
  light: 0xb67a46,
  base: 0x8e5430,
  shadow: 0x6a3a1e,
  deep: 0x3e1e0e,
};

/** Cherry bark: a darker, cooler red-brown with pale lenticels across it. */
export const BARK_CHERRY: BarkTones = {
  hi: 0xb48478,
  light: 0x8e5e54,
  base: 0x6c4038,
  shadow: 0x4e2a26,
  deep: 0x2c1414,
};

export interface TrunkSpec {
  /** Centre of the trunk's foot, and where it stands. */
  readonly x: number;
  readonly foot: number;
  /** Where the canopy takes over (the trunk runs a little into it). */
  readonly top: number;
  /** Width at the top; the foot flares wider. */
  readonly width: number;
  /** How far the top leans over from the foot, in pixels (+ right). */
  readonly lean?: number;
  readonly seed: number;
  readonly tones?: BarkTones;
  /** Cherry bark: pale bands of lenticels across the trunk. */
  readonly lenticels?: boolean;
}

/**
 * Draws a trunk into `b`, foot first. Returns the trunk's centre at its top,
 * for branches.
 */
export function barkTrunk(b: PixelBuffer, spec: TrunkSpec): { x: number; y: number } {
  const { foot, top, seed } = spec;
  const T = spec.tones ?? BARK_BROWN;
  const rnd = stream(seed * 7 + 3);
  const height = Math.max(2, foot - top);
  // Every tree a little different: a touch wider or narrower, its own bend.
  const width = Math.max(3, spec.width + Math.round((rnd() - 0.5) * 2));
  const lean = (spec.lean ?? 0) + (rnd() - 0.5) * 2;
  const bend = (rnd() - 0.5) * 2.4;
  const flare = 2 + Math.round(rnd() * 2);
  const centre = (y: number): number => {
    const t = (foot - y) / height;
    return spec.x + lean * t + bend * Math.sin(t * Math.PI);
  };
  const halfAt = (y: number): number => {
    const t = (foot - y) / height;
    // Wider at the foot (the flare dies out over the bottom quarter), narrower up top.
    const taper = width / 2 + (1 - t) * 0.8;
    const base = Math.max(0, 1 - t / 0.24);
    return taper + flare * base * base;
  };

  // Knots: one or two dark rings, somewhere up the middle.
  const knots = Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => ({
    y: Math.round(top + 2 + rnd() * Math.max(1, height * 0.6)),
    side: rnd() < 0.5 ? -1 : 1,
  }));
  // Grooves: a few columns (fractions across the trunk) that wander.
  const grooveCount = Math.max(1, Math.round(width / 2.5));
  const grooves = Array.from({ length: grooveCount }, (_, i) => ({
    at: (i + 0.5) / grooveCount - 0.5 + (rnd() - 0.5) * 0.12,
    phase: rnd() * 6,
  }));

  for (let y = top; y <= foot; y++) {
    const cx = centre(y);
    const half = halfAt(y);
    const x0 = Math.round(cx - half);
    const x1 = Math.round(cx + half);
    const span = Math.max(1, x1 - x0);
    for (let x = x0; x <= x1; x++) {
      // Across the trunk, -1 (left, lit) … 1 (right, shaded).
      const u = ((x - x0) / span) * 2 - 1;
      let c =
        u < -0.72 ? T.hi : u < -0.3 ? T.light : u < 0.34 ? T.base : u < 0.78 ? T.shadow : T.deep;
      // Grooves: broken dark lines, lit on their left lip where the light is.
      for (const g of grooves) {
        const gx = cx + (g.at + Math.sin(y / 3.2 + g.phase) * 0.06) * span;
        if (Math.round(gx) === x && hash(x, y >> 1, seed) > 0.22) {
          c = u < 0.3 ? T.shadow : T.deep;
        } else if (Math.round(gx) - 1 === x && u < 0.2 && hash(x, y >> 1, seed + 1) > 0.5) {
          c = mix(c, T.hi, 0.35);
        }
      }
      // Cherry lenticels: short pale dashes across the bark.
      if (spec.lenticels && (y + seed) % 4 === 0 && hash(x >> 1, y, seed + 2) < 0.55 && u < 0.6) {
        c = mix(c, T.hi, 0.5);
      }
      b.set(x, y, c);
    }
    // The flared foot's shadow side meets the ground darker.
    if (y >= foot - 1) {
      b.set(x1, y, T.deep);
      b.set(x0, y, mix(T.light, T.base, 0.4));
    }
  }

  for (const k of knots) {
    const cx = centre(k.y) + k.side * Math.max(0, halfAt(k.y) * 0.35);
    const kx = Math.round(cx);
    b.set(kx, k.y, T.deep);
    b.set(kx + 1, k.y, T.shadow);
    b.set(kx, k.y + 1, T.shadow);
    b.set(kx - 1, k.y, mix(T.base, T.deep, 0.5));
    b.set(kx, k.y - 1, mix(T.light, T.hi, 0.5));
  }

  // Roots: two to four splaying out over the ground from the foot.
  const roots = 2 + Math.floor(rnd() * 3);
  for (let r = 0; r < roots; r++) {
    const dir = r % 2 === 0 ? -1 : 1;
    const len = 2 + Math.floor(rnd() * 4);
    const start = Math.round(centre(foot) + dir * (halfAt(foot) - 1));
    for (let i = 0; i < len; i++) {
      const rx = start + dir * i;
      const ry = foot - (i < len - 1 ? 1 : 0) + (i > len / 2 ? 1 : 0);
      b.set(rx, ry, i === 0 ? T.base : dir < 0 ? T.light : T.shadow);
      if (i < len - 1) b.set(rx, ry + 1, T.deep);
    }
  }

  return { x: Math.round(centre(top)), y: top };
}
