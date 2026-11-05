/**
 * The procedural brain behind the AI Providers page: two folded hemispheres
 * (gyri from ridged value noise), a striped cerebellum and a stem, as a point
 * cloud. Each provider owns the cortex region around its anchor; the region
 * lights as a wave spreading out from the anchor. No three.js here, so the
 * shape is testable without WebGL.
 */
export type Vec3 = [number, number, number];

export interface BrainModel {
  readonly count: number;
  readonly position: Float32Array;
  /** Owning provider index, or -1 for the cerebellum and stem (the core). */
  readonly region: Float32Array;
  /** Distance from the region's anchor, 0..1 within the region. */
  readonly dA: Float32Array;
  /** Random 0..1; points below the brain's current density draw. */
  readonly rank: Float32Array;
  /** Fold depth 0..1: ridges bright, sulci dim. */
  readonly fold: Float32Array;
  readonly seed: Float32Array;
  /** 1 for points on the cortex surface (not deep, not core). */
  readonly surface: Uint8Array;
  /** One anchor per provider, on the cortex surface. */
  readonly anchors: Vec3[];
}

export const BRAIN_CENTER: Vec3 = [0, 0.05, 0];
const RX = 0.5;
const RY = 0.64;
const RZ = 0.9;
/** Half the gap between the hemispheres. */
export const HEMI_OFFSET = 0.19;
const INNER = 0.34;
export const HEMI_RADII: Vec3 = [RX, RY, RZ];

/**
 * Where each provider's region sits. Countries share a neighbourhood: the US
 * across the frontal lobe, China around the crown and temples, Japan and the
 * gateways at the back.
 */
const ANCHOR_DIRS: Record<string, Vec3> = {
  anthropic: [-0.55, 0.5, 0.7],
  openai: [0.55, 0.5, 0.7],
  gemini: [0, 0.35, 0.95],
  xai: [0.8, -0.2, 0.65],
  moonshot: [-0.45, 0.85, 0.05],
  glm: [0.45, 0.85, 0.05],
  minimax: [-0.98, 0.05, -0.1],
  xiaomi: [0.98, 0.05, -0.1],
  deepseek: [-0.8, -0.2, 0.55],
  sakana: [0.45, 0.35, -0.9],
  openrouter: [-0.45, 0.35, -0.9],
  huggingface: [0.75, -0.25, -0.6],
};

export function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) % 65536) / 32768 - 1;
}

function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const l = (a: number, b: number, t: number): number => a + (b - a) * t;
  return l(
    l(
      l(hash(xi, yi, zi), hash(xi + 1, yi, zi), u),
      l(hash(xi, yi + 1, zi), hash(xi + 1, yi + 1, zi), u),
      v,
    ),
    l(
      l(hash(xi, yi, zi + 1), hash(xi + 1, yi, zi + 1), u),
      l(hash(xi, yi + 1, zi + 1), hash(xi + 1, yi + 1, zi + 1), u),
      v,
    ),
    w,
  );
}

const gyri = (x: number, y: number, z: number): number =>
  1 -
  2 * Math.abs(noise3(x * 4.2, y * 4.2, z * 4.2)) * 0.75 -
  Math.abs(noise3(x * 9 + 3, y * 9, z * 9)) * 0.5;

/** A point on (or under, with depth < 1) one hemisphere's folded surface. */
function cortex(
  ux: number,
  uy: number,
  uz: number,
  side: number,
  depth: number,
): [number, number, number, number] {
  let px = ux * RX;
  let py = uy * RY;
  const pz = uz * RZ;
  if (ux * side < 0) px *= INNER;
  if (uy < 0) py *= 0.6 + 0.25 * Math.max(0, uz);
  py *= 1 + 0.1 * uz;
  px *= 1 - 0.12 * Math.max(0, -uz);
  const f = gyri(px + side * 7, py, pz);
  const r = depth * (1 + 0.045 * f);
  return [px * r + side * HEMI_OFFSET, py * r + 0.06, pz * r, f];
}

/** A provider's anchor direction: its table entry, or a stable spot for one the table doesn't know. */
export function anchorDir(value: string, index: number): Vec3 {
  const known = ANCHOR_DIRS[value];
  if (known) return known;
  // Golden-angle spiral over the upper cortex, offset so it misses the table's spots.
  const t = index * 2.39996 + 0.7;
  const y = 0.2 + ((index * 0.37) % 0.6);
  const s = Math.sqrt(1 - y * y);
  return [Math.cos(t) * s, y, Math.sin(t) * s];
}

const DENSE = 11000;

/** Build the brain for these providers (region i belongs to providers[i]). Deterministic. */
export function buildBrain(providers: readonly string[], count = DENSE): BrainModel {
  const R = rng(7);
  const anchors: Vec3[] = providers.map((value, i) => {
    const [x, y, z] = anchorDir(value, i);
    const l = Math.hypot(x, y, z);
    const p = cortex(x / l, y / l, z / l, Math.sign(x) || 1, 1);
    return [p[0], p[1], p[2]];
  });
  const position = new Float32Array(count * 3);
  const region = new Float32Array(count);
  const dA = new Float32Array(count);
  const rank = new Float32Array(count);
  const fold = new Float32Array(count);
  const seed = new Float32Array(count);
  const surface = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const kind = R();
    let p: [number, number, number];
    let f: number;
    let cortical = false;
    if (kind < 0.82) {
      const z = 2 * R() - 1;
      const a = 2 * Math.PI * R();
      const s = Math.sqrt(1 - z * z);
      const side = R() < 0.5 ? -1 : 1;
      let ux = s * Math.cos(a);
      if (R() < 0.8) ux = Math.abs(ux) * side;
      const deep = R() < 0.12;
      const q = cortex(ux, s * Math.sin(a), z, side, deep ? 0.35 + 0.55 * R() : 1);
      p = [q[0], q[1], q[2]];
      f = (q[3] + 1) / 2;
      if (deep) f *= 0.45;
      else surface[i] = 1;
      cortical = true;
    } else if (kind < 0.95) {
      // Cerebellum: a striped bulb tucked under the back.
      const z = 2 * R() - 1;
      const a = 2 * Math.PI * R();
      const s = Math.sqrt(1 - z * z);
      p = [s * Math.cos(a) * 0.46, -0.36 + Math.min(s * Math.sin(a), 0.4) * 0.22, -0.6 + z * 0.27];
      f = 0.5 + 0.5 * Math.sin(p[1] * 90 + p[2] * 12);
    } else {
      // Stem.
      const t = R();
      const a = 2 * Math.PI * R();
      const rr = 0.06 * (1 - 0.3 * t);
      p = [Math.cos(a) * rr, -0.3 - 0.5 * t, -0.32 - 0.12 * t + Math.sin(a) * rr];
      f = 0.55;
    }
    position.set(p, i * 3);
    fold[i] = f;
    rank[i] = R();
    seed[i] = R();
    region[i] = -1;
    if (cortical && anchors.length > 0) {
      let best = 0;
      let bestD = Infinity;
      anchors.forEach((a, k) => {
        const d = Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      });
      region[i] = best;
      dA[i] = bestD;
    }
  }
  // Normalise each region's distances so every wave takes the same time to fill it.
  const maxD = anchors.map(() => 0.01);
  for (let i = 0; i < count; i++) {
    const r = region[i];
    if (r >= 0) maxD[r] = Math.max(maxD[r], dA[i]);
  }
  for (let i = 0; i < count; i++) {
    const r = region[i];
    if (r >= 0) dA[i] = dA[i] / maxD[r];
  }
  return { count, position, region, dA, rank, fold, seed, surface, anchors };
}
