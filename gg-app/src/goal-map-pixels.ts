// Pixel painting for the top-down Goal map. The map is painted one pixel at a
// time into these buffers (a few hundred thousand pixels, painted once per
// size), then shown with a single putImageData. Colours are packed 0xRRGGBB.

export type Rgb = number;

/**
 * The ENDESGA 64 palette (a public pixel-art palette), which the map is drawn
 * in. Named by look, not role: these are art colours, not theme tokens.
 */
export const E = {
  ink: 0x0e071b,
  dusk: 0x1a1932,
  slate0: 0x2a2f4e,
  slate1: 0x424c6e,
  steel0: 0x657392,
  steel1: 0x92a1b9,
  mist: 0xc7cfdd,
  white: 0xffffff,
  gray0: 0x3d3d3d,
  gray1: 0x5d5d5d,
  gray2: 0x858585,
  gray3: 0xb4b4b4,
  bark0: 0x391f21,
  bark1: 0x5d2c28,
  bark2: 0x8a4836,
  bark3: 0xbf6f4a,
  tan: 0xe69c69,
  sand: 0xf6ca9f,
  cream: 0xf9e6cf,
  ochre: 0xedab50,
  orange: 0xe07438,
  rust: 0xc64524,
  brick: 0x8e251d,
  amber: 0xffa214,
  gold: 0xffc825,
  yellow: 0xffeb57,
  lime: 0xd3fc7e,
  leaf: 0x99e65f,
  green3: 0x5ac54f,
  green2: 0x33984b,
  green1: 0x1e6f50,
  teal0: 0x134c4c,
  deep: 0x0c2e44,
  navy: 0x00396d,
  blue1: 0x0069aa,
  blue2: 0x0098dc,
  sky: 0x00cdf9,
  cyan: 0x0cf1ff,
  ice: 0x94fdff,
  pink: 0xfdd2ed,
  orchid: 0xf389f5,
  violet: 0xca52c9,
  plum: 0x93388f,
  wine: 0x622461,
  rose: 0xf68187,
  coral: 0xf5555d,
  red: 0xea323c,
  crimson: 0xc42430,
} as const;

export function hexRgb(hex: string): Rgb {
  return Number.parseInt(hex.replace("#", ""), 16);
}

/** Straight-line blend of two colours; t = 0 is `a`, 1 is `b`. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const r = Math.round(ar + (((b >> 16) & 255) - ar) * t);
  const g = Math.round(ag + (((b >> 8) & 255) - ag) * t);
  const bl = Math.round(ab + ((b & 255) - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/** Toward an ink (the palette's cool near-black by default), the way outlines are drawn. */
export function darken(c: Rgb, t = 0.6, ink: Rgb = E.ink): Rgb {
  return mix(c, ink, t);
}

/** A warm near-black for cosy, earthy worlds: outlines and shadows go brown, not purple. */
export const WARM_INK: Rgb = 0x2a1406;

/** Deterministic hash of a lattice point, in [0, 1). */
export function hash(x: number, y: number, seed = 0): number {
  let h =
    Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1): features about `scale` pixels across. */
export function noise(x: number, y: number, scale: number, seed = 0): number {
  const fx = x / scale;
  const fy = y / scale;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash(ix, iy, seed);
  const b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed);
  const d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** A seeded stream of numbers in [0, 1), for laying out one prop's details. */
export function stream(seed: number): () => number {
  let i = 0;
  return () => hash(i++, 7919, seed);
}

export type Palette = Readonly<Record<string, Rgb | string>>;

export class PixelBuffer {
  readonly data: Uint8ClampedArray<ArrayBuffer>;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  opaque(x: number, y: number): boolean {
    return this.inside(x, y) && (this.data[(y * this.width + x) * 4 + 3] ?? 0) > 0;
  }

  rgb(x: number, y: number): Rgb {
    const i = (y * this.width + x) * 4;
    return ((this.data[i] ?? 0) << 16) | ((this.data[i + 1] ?? 0) << 8) | (this.data[i + 2] ?? 0);
  }

  /** Paint one pixel; `a` below 1 blends over what is there. */
  set(x: number, y: number, c: Rgb, a = 1): void {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (a <= 0 || !this.inside(px, py)) return;
    const d = this.data;
    const i = (py * this.width + px) * 4;
    const r = (c >> 16) & 255;
    const g = (c >> 8) & 255;
    const b = c & 255;
    const da = (d[i + 3] ?? 0) / 255;
    if (a >= 1 || da === 0) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = a >= 1 ? 255 : Math.round(a * 255);
      return;
    }
    const out = a + da * (1 - a);
    d[i] = (r * a + (d[i] ?? 0) * da * (1 - a)) / out;
    d[i + 1] = (g * a + (d[i + 1] ?? 0) * da * (1 - a)) / out;
    d[i + 2] = (b * a + (d[i + 2] ?? 0) * da * (1 - a)) / out;
    d[i + 3] = out * 255;
  }

  rect(x: number, y: number, w: number, h: number, c: Rgb, a = 1): void {
    for (let yy = Math.floor(y); yy < y + h; yy++) {
      for (let xx = Math.floor(x); xx < x + w; xx++) this.set(xx, yy, c, a);
    }
  }

  /** A filled ellipse; a pixel is in when its centre is. */
  ellipse(cx: number, cy: number, rx: number, ry: number, c: Rgb, a = 1): void {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.set(x, y, c, a);
      }
    }
  }

  /** Paint a character grid (`.` transparent) with its top-left at (x, y). */
  stamp(
    rows: readonly string[],
    palette: Palette,
    x: number,
    y: number,
    flip = false,
    a = 1,
  ): void {
    const width = rows.reduce((w, row) => Math.max(w, row.length), 0);
    rows.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++) {
        const key = row[dx];
        if (key === undefined || key === ".") continue;
        const color = palette[key];
        if (color === undefined) continue;
        const c = typeof color === "string" ? hexRgb(color) : color;
        this.set(Math.floor(x) + (flip ? width - 1 - dx : dx), Math.floor(y) + dy, c, a);
      }
    });
  }

  /** Composite another buffer with its top-left at (x, y). */
  draw(src: PixelBuffer, x: number, y: number, flip = false, a = 1): void {
    const ox = Math.floor(x);
    const oy = Math.floor(y);
    for (let sy = 0; sy < src.height; sy++) {
      for (let sx = 0; sx < src.width; sx++) {
        const i = (sy * src.width + sx) * 4;
        const sa = (src.data[i + 3] ?? 0) / 255;
        if (sa === 0) continue;
        this.set(ox + (flip ? src.width - 1 - sx : sx), oy + sy, src.rgb(sx, sy), sa * a);
      }
    }
  }

  /**
   * Ring every opaque shape with a 1px outline, tinted by the colour it borders
   * (so a tree is ringed in near-black green and a cabin in near-black brown),
   * and lit the way GG Royale's lines are: lighter on the top and left, where
   * the sun falls on the shape's edge, and full ink on the bottom and right,
   * where it turns away. Outer corners (touching the shape only diagonally)
   * stay clear, so silhouettes read round rather than boxed.
   */
  outline(strength = 0.68, ink: Rgb = E.ink): void {
    const marks: Array<[number, number, Rgb]> = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.opaque(x, y)) continue;
        // Which sides of the shape this ring pixel sits on.
        const below = this.opaque(x, y + 1); // the ring is above: the lit top edge
        const right = this.opaque(x + 1, y); // the ring is left of it: lit
        const above = this.opaque(x, y - 1); // the ring is under it: shade
        const left = this.opaque(x - 1, y); // the ring is right of it: shade
        if (!below && !right && !above && !left) continue;
        const from = below ? [x, y + 1] : right ? [x + 1, y] : above ? [x, y - 1] : [x - 1, y];
        const touch = this.rgb(from[0] ?? x, from[1] ?? y);
        // Lit edges (top and left only) take 30% less ink.
        const lit = (below || right) && !above && !left;
        marks.push([x, y, darken(touch, lit ? strength * 0.7 : strength, ink)]);
      }
    }
    for (const [x, y, c] of marks) this.set(x, y, c);
  }

  toImageData(): ImageData {
    return new ImageData(this.data, this.width, this.height);
  }
}
