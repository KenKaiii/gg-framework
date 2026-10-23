// Lights a critter's grid the way GG Royale's art is lit. The sprites are
// drawn as flat material maps (critter-sprites.ts: body, belly, accents,
// eyes, outline); this turns one into finished pixels:
//
// - Form: each part (the cells an outline encloses: head, body, an ear, a
//   leg) is treated as a soft dome. Its slope gives a surface normal, lit by
//   one light from the top left, so every part is lit on its upper left and
//   falls into shade on its lower right. Never pillow shading.
// - Ramps: each material's colour becomes five tones that shift in hue as
//   well as value (shadows cool toward violet, light warms toward gold), the
//   way pixel artists build ramps, so shade reads as depth, not grey.
// - Bounce and contact: the underside of a big part catches a little light
//   back from the ground, and a part tucked under another (a body under the
//   chin) sits in its shadow.
// - Texture by material: fur breaks its tone bands into tufts, cloth into
//   folds, metal goes hard-edged with a glint, gel and glass get a shine.
// - Outlines: silhouette lines are coloured from the material they wrap, a
//   lighter line where the light falls on the top left and near-ink below;
//   lines inside the sprite (a chin over a body) are softer still.
//
// Pure and deterministic: the same grid always gives the same pixels.

/** How a material takes the light. */
export type Material = "fur" | "skin" | "cloth" | "metal" | "gel" | "glow" | "glass" | "flat";

/** GG Royale's ink: the darkest outline, and what deep shadow leans toward. */
const INK = [0x1e, 0x0c, 0x1f] as const;

/** Keys that are painted flat unless a critter says otherwise: eyes, shine, blush, mouth, nose. */
const FLAT_KEYS: ReadonlySet<string> = new Set(["K", "W", "C", "M", "N"]);
/** The outline key. */
const OUTLINE = "O";

type Rgb = readonly [number, number, number];

function parseColor(c: string): { rgb: Rgb; alpha: number } {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(c.trim());
  if (m) return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: m[4] ? Number(m[4]) : 1 };
  const h = c.replace("#", "");
  const n = h.length === 3 ? [...h].map((d) => d + d).join("") : h;
  return {
    rgb: [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)],
    alpha: 1,
  };
}

function toHex([r, g, b]: Rgb, alpha = 1): string {
  const c = (v: number): string =>
    Math.round(Math.max(0, Math.min(255, v)))
      .toString(16)
      .padStart(2, "0");
  return alpha >= 1
    ? `#${c(r)}${c(g)}${c(b)}`
    : `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha.toFixed(2)})`;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === R
      ? ((G - B) / d + (G < B ? 6 : 0)) * 60
      : max === G
        ? ((B - R) / d + 2) * 60
        : ((R - G) / d + 4) * 60;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const H = ((h % 360) + 360) % 360;
  const S = Math.max(0, Math.min(1, s));
  const L = Math.max(0, Math.min(1, l));
  const k = (n: number): number => (n + H / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number): number => L - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Turns hue `h` toward `target` by up to `by` degrees, the short way round. */
function hueToward(h: number, target: number, by: number): number {
  const d = ((target - h + 540) % 360) - 180;
  return h + Math.sign(d) * Math.min(Math.abs(d), by);
}

/** Two CSS colours mixed (`t` 0 = a, 1 = b), as a hex colour; alpha is kept from `a`. */
export function mixColor(a: string, b: string, t: number): string {
  const A = parseColor(a);
  const B = parseColor(b);
  return toHex(mix(A.rgb, B.rgb, t), A.alpha);
}

/** GG Royale's ink, as a CSS colour. */
export const INK_COLOR = "#1e0c1f";

/** A material's five tones: deep shadow, shadow, base, light, highlight. */
function rampFor(base: Rgb, material: Material): readonly Rgb[] {
  const [h, s, l] = rgbToHsl(base);
  // Greys and near-whites barely have a hue to shift: give their shade a
  // cool violet cast anyway, so white fur and steel still read as lit.
  const grey = s < 0.12;
  // Skin shades warm (toward a soft red), and only a little: a violet
  // shadow on a face reads as a bruise.
  const skin = material === "skin";
  const shadeHue = skin ? 8 : 262;
  const sh = grey ? 255 : h;
  const contrast =
    material === "metal"
      ? 1.25
      : material === "glow"
        ? 0.6
        : material === "gel"
          ? 0.9
          : skin
            ? 0.62
            : 1;
  const down = (amount: number, shift: number, sat: number): Rgb =>
    hslToRgb(
      hueToward(sh, shadeHue, skin ? shift * 0.35 : shift),
      grey ? Math.max(s, 0.1 * amount * 4) : s * sat,
      l * (1 - amount * contrast),
    );
  // Light climbs by less on a dark colour, so dark hair or a dark robe gets
  // a sheen rather than turning grey.
  const up = (amount: number, shift: number, sat: number): Rgb =>
    hslToRgb(
      hueToward(h, 52, grey ? 0 : shift),
      s * sat,
      l + Math.min((1 - l) * amount, l * amount * 1.5 + 0.05) * contrast,
    );
  const deep = mix(down(0.46, 24, 1.05), INK, 0.12);
  return [
    deep,
    down(0.24, 12, 1.06),
    base,
    up(0.3, 8, 0.96),
    up(material === "metal" ? 0.75 : 0.56, 14, 0.85),
  ];
}

/** A small repeatable hash for texture that stays put frame to frame. */
function hash2(x: number, y: number, seed: number): number {
  let n =
    Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** The light: from the top left, a little toward the viewer. */
const LIGHT = (() => {
  const v = [-0.58, -0.72, 0.62];
  const len = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
  return v.map((n) => n / len) as [number, number, number];
})();

export interface ShadeInput {
  readonly rows: readonly string[];
  readonly palette: Readonly<Record<string, string>>;
  /** Material per palette key; unlisted keys are fur, or flat for K, W, C, M, N. */
  readonly materials?: Readonly<Record<string, Material>>;
  /** Varies the fur and cloth texture between critters. */
  readonly seed?: number;
  /**
   * How hard the light models each part, 0–1 (default 1). Below 1 the parts
   * keep more of their own colour and the highlight shrinks to a lit edge:
   * for sprites seen from above, where one dome (a head's crown) is most of
   * the picture and full modelling would flood it with highlight.
   */
  readonly relief?: number;
}

/** The finished pixels: a colour per cell, or null where it's clear. */
export type ShadedGrid = readonly (readonly (string | null)[])[];

export function shadeGrid({
  rows,
  palette,
  materials = {},
  seed = 1,
  relief = 1,
}: ShadeInput): ShadedGrid {
  const h = rows.length;
  const w = Math.max(0, ...rows.map((r) => r.length));
  const keyAt = (x: number, y: number): string | null => {
    const ch = rows[y]?.[x];
    return ch === undefined || ch === "." ? null : ch;
  };
  const materialOf = (key: string): Material =>
    materials[key] ?? (FLAT_KEYS.has(key) ? "flat" : "fur");
  const isPart = (x: number, y: number): boolean => {
    const k = keyAt(x, y);
    return k !== null && k !== OUTLINE;
  };

  // Parts: cells an outline encloses, 4-connected.
  const part = new Int32Array(w * h).fill(-1);
  let parts = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isPart(x, y) || (part[y * w + x] ?? -1) >= 0) continue;
      const stack: [number, number][] = [[x, y]];
      part[y * w + x] = parts;
      while (stack.length) {
        const [cx, cy] = stack.pop() ?? [0, 0];
        for (const [nx, ny] of [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ] as const) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (!isPart(nx, ny) || (part[ny * w + nx] ?? -1) >= 0) continue;
          part[ny * w + nx] = parts;
          stack.push([nx, ny]);
        }
      }
      parts++;
    }
  }
  const partSize = new Int32Array(parts);
  for (const p of part) if (p >= 0) partSize[p] = (partSize[p] ?? 0) + 1;

  // How deep each cell sits inside its part (chamfer distance to the edge).
  const dist = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) dist[i] = (part[i] ?? -1) >= 0 ? 1e9 : 0;
  for (let pass = 0; pass < 2; pass++) {
    const ys = pass === 0 ? [...Array(h).keys()] : [...Array(h).keys()].reverse();
    const xs = pass === 0 ? [...Array(w).keys()] : [...Array(w).keys()].reverse();
    const s = pass === 0 ? -1 : 1;
    for (const y of ys) {
      for (const x of xs) {
        const i = y * w + x;
        if ((dist[i] ?? 0) === 0) continue;
        const at = (nx: number, ny: number): number =>
          nx < 0 || ny < 0 || nx >= w || ny >= h ? 0 : (dist[ny * w + nx] ?? 0);
        dist[i] = Math.min(
          dist[i] ?? 1e9,
          at(x + s, y) + 1,
          at(x, y + s) + 1,
          at(x + s, y + s) + 1.414,
          at(x - s, y + s) + 1.414,
        );
      }
    }
  }
  // A dome over each part: the depth, eased so the edges fall away.
  const height = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    const d = dist[y * w + x] ?? 0;
    return d <= 0 ? 0 : Math.sqrt(d);
  };
  const smooth = (x: number, y: number): number => {
    const p = part[y * w + x] ?? -1;
    let sum = 0;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        const same = nx >= 0 && ny >= 0 && nx < w && ny < h && part[ny * w + nx] === p;
        sum += same ? height(nx, ny) : 0;
        n++;
      }
    }
    return sum / n;
  };
  const heights = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if ((part[y * w + x] ?? -1) >= 0) heights[y * w + x] = smooth(x, y);
  const hAt = (x: number, y: number, p: number): number =>
    x < 0 || y < 0 || x >= w || y >= h || part[y * w + x] !== p ? 0 : (heights[y * w + x] ?? 0);

  // Per cell: a tone index into its material's ramp.
  const ramps = new Map<string, readonly Rgb[]>();
  const rampOf = (key: string): readonly Rgb[] => {
    const known = ramps.get(key);
    if (known) return known;
    const r = rampFor(parseColor(palette[key] ?? "#ff00ff").rgb, materialOf(key));
    ramps.set(key, r);
    return r;
  };

  const out: (string | null)[][] = Array.from({ length: h }, () =>
    Array<string | null>(w).fill(null),
  );
  const tone = new Float32Array(w * h).fill(-1);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const key = keyAt(x, y);
      if (key === null || key === OUTLINE) continue;
      const mat = materialOf(key);
      const { rgb, alpha } = parseColor(palette[key] ?? "#ff00ff");
      if (mat === "flat") {
        out[y]![x] = toHex(rgb, alpha);
        continue;
      }
      const p = part[y * w + x] ?? -1;
      // The slope over a 5-cell span, so one notch in a part's edge doesn't
      // flip a single pixel's light.
      const gx =
        (hAt(x + 1, y, p) - hAt(x - 1, y, p)) * 0.6 + (hAt(x + 2, y, p) - hAt(x - 2, y, p)) * 0.2;
      const gy =
        (hAt(x, y + 1, p) - hAt(x, y - 1, p)) * 0.6 + (hAt(x, y + 2, p) - hAt(x, y - 2, p)) * 0.2;
      // Small parts (ears, feet) are flatter; big ones rounder.
      const flat = 0.9 + 0.5 / Math.sqrt(Math.max(1, partSize[p] ?? 1));
      const len = Math.hypot(gx, gy, flat);
      const n = [-gx / len, -gy / len, flat / len] as const;
      let lit = n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2];
      // A little more light from the sky over the top rows.
      lit += (0.5 - y / h) * 0.12;
      // Softer modelling pulls the light toward the base tone's middle.
      if (relief !== 1) lit = 0.4 + (lit - 0.4) * relief;
      // Texture by material: fur breaks a band's edge into 2-pixel tufts,
      // cloth into folds running down; small enough to only move a pixel at
      // the edge between two tones, never to speckle a whole part.
      if (mat === "fur") lit += (hash2(x >> 1, y >> 1, seed) - 0.5) * 0.07;
      else if (mat === "cloth") lit += (hash2(x, 0, seed) - 0.5) * 0.06;
      let t =
        lit < -0.42
          ? 0
          : lit < 0.16
            ? 1
            : lit < 0.64
              ? 2
              : lit < (mat === "metal" ? 0.8 : 0.84)
                ? 3
                : 4;
      if (mat === "glow") t = Math.max(1, t);
      // Bounce: the underside of a big part catches light from the ground.
      const below = keyAt(x, y + 1);
      const big = (partSize[p] ?? 0) >= 24;
      if (big && (below === null || below === OUTLINE) && n[1] > 0.3 && t <= 1 && mat !== "metal")
        t += 1;
      // Contact: a part tucked under another sits in its shadow.
      // Only for a part that's tucked right under (the line above it is
      // another part's), and only two rows of it.
      const tucked = (dy: number): boolean =>
        keyAt(x, y - dy) === OUTLINE && isPart(x, y - dy - 1) && part[(y - dy - 1) * w + x] !== p;
      if (tucked(1) || (tucked(2) && isPart(x, y - 1))) t = Math.max(1, t - 1);
      tone[y * w + x] = t;
      const ramp = rampOf(key);
      out[y]![x] = toHex(ramp[t] ?? rgb, alpha);
    }
  }

  // Glints on metal, gel and glass: the brightest-facing cell of each part.
  const glint = new Map<number, { i: number; lit: number }>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const key = keyAt(x, y);
      if (key === null || key === OUTLINE) continue;
      const mat = materialOf(key);
      if (mat !== "metal" && mat !== "gel" && mat !== "glass") continue;
      const p = part[y * w + x] ?? -1;
      if ((partSize[p] ?? 0) < 6) continue;
      // Up and left of centre, where the light lands.
      const score = -(x * 0.9 + y * 1.1) + (heights[y * w + x] ?? 0) * 2.2;
      const best = glint.get(p);
      if (!best || score > best.lit) glint.set(p, { i: y * w + x, lit: score });
    }
  }
  for (const { i } of glint.values()) {
    const x = i % w;
    const y = Math.floor(i / w);
    const key = keyAt(x, y);
    if (!key) continue;
    const { alpha } = parseColor(palette[key] ?? "#fff");
    const top = rampOf(key)[4] ?? [255, 255, 255];
    out[y]![x] = toHex(mix(top, [255, 255, 255], 0.7), Math.max(alpha, 0.9));
  }

  // Outlines, coloured from what they wrap.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (keyAt(x, y) !== OUTLINE) continue;
      const sides = [
        [x, y - 1, "up"],
        [x - 1, y, "left"],
        [x + 1, y, "right"],
        [x, y + 1, "down"],
      ] as const;
      const open = sides.filter(([nx, ny]) => keyAt(nx, ny) === null).map(([, , s]) => s);
      // What this line wraps: its most common neighbouring material that
      // isn't flat (eyes and blush don't colour a line).
      const count = new Map<string, number>();
      for (const [nx, ny] of sides) {
        const k = keyAt(nx, ny);
        if (k && k !== OUTLINE && materialOf(k) !== "flat") count.set(k, (count.get(k) ?? 0) + 1);
      }
      if (count.size === 0) {
        for (const [dx, dy] of [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ] as const) {
          const k = keyAt(x + dx, y + dy);
          if (k && k !== OUTLINE && materialOf(k) !== "flat") count.set(k, (count.get(k) ?? 0) + 1);
        }
      }
      const wraps = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!wraps) {
        out[y]![x] = toHex(INK);
        continue;
      }
      const ramp = rampOf(wraps);
      const deep = ramp[0] ?? INK;
      const { alpha } = parseColor(palette[wraps] ?? "#000");
      let c: Rgb;
      if (open.length === 0) {
        // Inside the sprite: a soft line between two parts.
        c = mix(deep, ramp[1] ?? deep, 0.25);
      } else if (open.every((s) => s === "up" || s === "left")) {
        // Facing the light.
        c = mix(deep, INK, 0.2);
      } else if (open.some((s) => s === "down" || s === "right")) {
        c = mix(deep, INK, 0.62);
      } else {
        c = mix(deep, INK, 0.42);
      }
      out[y]![x] = toHex(c, alpha < 1 ? Math.min(1, alpha + 0.2) : 1);
    }
  }
  return out;
}

/**
 * A grid of colours as an SVG data URL, one unit per cell (scale it up with
 * `image-rendering: pixelated`). Runs of one colour along a row merge into a
 * single rect. `fill` paints every opaque cell one colour (the summon
 * silhouette).
 */
export function renderColorGrid(
  grid: ShadedGrid,
  size: { readonly width: number; readonly height: number },
  fill?: string,
): string {
  const rects: string[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x] ?? null;
      let end = x + 1;
      const same = fill
        ? (v: string | null): boolean => (v === null) === (c === null)
        : (v: string | null): boolean => v === c;
      while (end < row.length && same(row[end] ?? null)) end++;
      const color = c === null ? undefined : (fill ?? c);
      if (color)
        rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${color}"/>`);
      x = end;
    }
  });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size.width} ${size.height}" ` +
    `shape-rendering="crispEdges">${rects.join("")}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
