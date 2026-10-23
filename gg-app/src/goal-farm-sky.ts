// The Goal farm's time of day and weather. The light follows the local clock
// through the day (dawn, morning, lunch, afternoon, evening, dusk, night),
// blended smoothly from one look to the next; the weather changes every few
// hours, mostly fair. Pure: the renderer turns these into one light overlay
// (rebuilt about once a minute) and a handful of cheap particles.

import { PixelBuffer, hash, mix, type Rgb } from "./goal-map-pixels";

export const FARM_TIMES = [
  { id: "dawn", label: "Dawn", hour: 5.6 },
  { id: "morning", label: "Morning", hour: 8 },
  { id: "lunch", label: "Lunch", hour: 12.5 },
  { id: "afternoon", label: "Afternoon", hour: 15.5 },
  { id: "evening", label: "Evening", hour: 18 },
  { id: "dusk", label: "Dusk", hour: 19.8 },
  { id: "night", label: "Night", hour: 23 },
] as const;

export const WEATHERS = ["clear", "cloudy", "rain", "fog", "snow"] as const;
export type Weather = (typeof WEATHERS)[number];

/**
 * One moment's light over the farm, in two parts. The grade is baked into
 * the map (see gradePixel): shadows lean toward one colour and highlights
 * toward another, with a little haze and saturation, so each time of day has
 * its own palette. The tint is laid over everything live (critters too), and
 * carries the darkness of dusk and night with the lamps cut out of it.
 */
export interface FarmSky {
  /** The colour laid over everything, and how strongly (0 = none). */
  readonly tint: Rgb;
  readonly tintAlpha: number;
  /** Shadows lean toward this, highlights toward `highlight`, by `grade` (0–1). */
  readonly shadow: Rgb;
  readonly highlight: Rgb;
  readonly grade: number;
  /** A soft haze toward `haze`, by `lift` (0–1): morning mist, evening glow. */
  readonly haze: Rgb;
  readonly lift: number;
  /** Colour strength: 1 as drawn, more for a crisp noon, less for night. */
  readonly saturation: number;
  /** How lit the lanterns, windows and fires are (0 = off by day, 1 = night). */
  readonly lamps: number;
  /** How many fireflies are out (0–1). */
  readonly fireflies: number;
}

type Key = Omit<FarmSky, never> & { readonly hour: number };

// The farm's signature is dawn's lavender: every time of day keeps a little
// of it in its shadows, and the highlights carry the hour.
const LAVENDER: Rgb = 0x5a5aa8;
const NIGHT_BLUE: Rgb = 0x0a1240;

const DAWN: Omit<Key, "hour"> = {
  tint: LAVENDER,
  tintAlpha: 0.3,
  shadow: 0x4a3aa0,
  highlight: 0xffb8b0,
  grade: 0.42,
  haze: 0xd8c8f0,
  lift: 0.05,
  saturation: 0.92,
  lamps: 0.7,
  fireflies: 0,
};
// Soft and dewy: a pale lavender mist, peach light.
const MORNING: Omit<Key, "hour"> = {
  tint: 0x9a8ad0,
  tintAlpha: 0.08,
  shadow: 0x5a50b0,
  highlight: 0xffd4b8,
  grade: 0.38,
  haze: 0xf2e4f4,
  lift: 0.1,
  saturation: 0.94,
  lamps: 0,
  fireflies: 0,
};
// Crisp and bright: vivid colour, clean light, cool blue-lavender shadows.
const LUNCH: Omit<Key, "hour"> = {
  tint: 0xffffff,
  tintAlpha: 0,
  shadow: 0x3a50b8,
  highlight: 0xfff8e8,
  grade: 0.2,
  haze: 0xffffff,
  lift: 0,
  saturation: 1.14,
  lamps: 0,
  fireflies: 0,
};
// Honeyed: warm gold light, mauve shadows, a touch of glow.
const AFTERNOON: Omit<Key, "hour"> = {
  tint: 0xffa040,
  tintAlpha: 0.13,
  shadow: 0x7a4490,
  highlight: 0xffb050,
  grade: 0.52,
  haze: 0xffd890,
  lift: 0.07,
  saturation: 1,
  lamps: 0,
  fireflies: 0,
};
// Golden hour: amber-rose light, violet shadows.
const EVENING: Omit<Key, "hour"> = {
  tint: 0xf06418,
  tintAlpha: 0.2,
  shadow: 0x5a3a98,
  highlight: 0xff9a78,
  grade: 0.48,
  haze: 0xffb890,
  lift: 0.06,
  saturation: 1,
  lamps: 0.35,
  fireflies: 0,
};
const DUSK: Omit<Key, "hour"> = {
  tint: 0x2a2270,
  tintAlpha: 0.46,
  shadow: 0x2a2080,
  highlight: 0xff8aa8,
  grade: 0.5,
  haze: 0x8a7ac0,
  lift: 0.04,
  saturation: 0.88,
  lamps: 0.9,
  fireflies: 0.5,
};
const NIGHT: Omit<Key, "hour"> = {
  tint: NIGHT_BLUE,
  tintAlpha: 0.62,
  shadow: 0x101860,
  highlight: 0x9ab0e8,
  grade: 0.45,
  haze: 0x3a4a80,
  lift: 0,
  saturation: 0.72,
  lamps: 1,
  fireflies: 1,
};

/** The day's looks, by hour; the light blends between neighbours. */
const DAY: readonly Key[] = [
  { hour: 0, ...NIGHT },
  { hour: 4.4, ...NIGHT, fireflies: 0.6 },
  { hour: 5.6, ...DAWN },
  { hour: 6.8, ...DAWN, tintAlpha: 0.2, lamps: 0.2 },
  { hour: 8.2, ...MORNING },
  { hour: 10.2, ...MORNING, tintAlpha: 0.03, lift: 0.04 },
  { hour: 11.6, ...LUNCH },
  { hour: 13.6, ...LUNCH },
  { hour: 15.4, ...AFTERNOON },
  { hour: 16.6, ...AFTERNOON, tintAlpha: 0.15 },
  { hour: 18, ...EVENING },
  { hour: 19.8, ...DUSK },
  { hour: 21, ...NIGHT },
  { hour: 24, ...NIGHT },
];

const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** The farm's light at a local hour (fractional, 0–24). */
export function farmSkyAt(hour: number): FarmSky {
  const h = ((hour % 24) + 24) % 24;
  for (let i = 1; i < DAY.length; i++) {
    const a = DAY[i - 1];
    const b = DAY[i];
    if (!a || !b || h > b.hour) continue;
    const t = smooth(b.hour === a.hour ? 1 : (h - a.hour) / (b.hour - a.hour));
    // An end with no tint blends only the strength, so the tint never turns white on the way.
    const tint = a.tintAlpha === 0 ? b.tint : b.tintAlpha === 0 ? a.tint : mix(a.tint, b.tint, t);
    return {
      tint,
      tintAlpha: lerp(a.tintAlpha, b.tintAlpha, t),
      shadow: mix(a.shadow, b.shadow, t),
      highlight: mix(a.highlight, b.highlight, t),
      grade: lerp(a.grade, b.grade, t),
      haze: mix(a.haze, b.haze, t),
      lift: lerp(a.lift, b.lift, t),
      saturation: lerp(a.saturation, b.saturation, t),
      lamps: lerp(a.lamps, b.lamps, t),
      fireflies: lerp(a.fireflies, b.fireflies, t),
    };
  }
  const { hour: _hour, ...night } = DAY[0] ?? { hour: 0, ...NIGHT };
  return night;
}

/**
 * One pixel graded for the moment: split-toned (shadows toward `shadow`,
 * highlights toward `highlight`, blended soft-light so the art's own shading
 * survives), saturated or muted, then hazed. Pure; used on the map and on
 * every standing prop, so they match.
 */
export function gradePixel(
  r: number,
  g: number,
  b: number,
  sky: FarmSky,
): [number, number, number] {
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const k = smooth(Math.max(0, Math.min(1, (lum - 0.18) / 0.62)));
  const tone = mix(sky.shadow, sky.highlight, k);
  const tr = ((tone >> 16) & 255) / 255;
  const tg = ((tone >> 8) & 255) / 255;
  const tb = (tone & 255) / 255;
  // Soft light (Pegtop): darkens or brightens by the tone, keeping the shape.
  const soft = (base: number, blend: number): number => {
    const a = base / 255;
    return ((1 - 2 * blend) * a * a + 2 * blend * a) * 255;
  };
  let nr = lerp(r, soft(r, tr), sky.grade);
  let ng = lerp(g, soft(g, tg), sky.grade);
  let nb = lerp(b, soft(b, tb), sky.grade);
  const l2 = 0.299 * nr + 0.587 * ng + 0.114 * nb;
  nr = l2 + (nr - l2) * sky.saturation;
  ng = l2 + (ng - l2) * sky.saturation;
  nb = l2 + (nb - l2) * sky.saturation;
  if (sky.lift > 0) {
    nr = lerp(nr, (sky.haze >> 16) & 255, sky.lift);
    ng = lerp(ng, (sky.haze >> 8) & 255, sky.lift);
    nb = lerp(nb, sky.haze & 255, sky.lift);
  }
  const c = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  return [c(nr), c(ng), c(nb)];
}

/** The local time as a fractional hour (14:30 → 14.5). */
export function hourOf(date: Date): number {
  return date.getHours() + date.getMinutes() / 60;
}

/** How a kind of weather looks: the extra dimming, and what falls or drifts. */
export interface WeatherLook {
  /** A grey (or pale) veil over everything, on top of the time of day. */
  readonly veil: Rgb;
  readonly veilAlpha: number;
  /** What falls, and how thickly (drops per 10,000 map pixels). */
  readonly falling: "rain" | "snow" | null;
  readonly density: number;
  /** Cloud shadows drifting over the ground (0–1). */
  readonly clouds: number;
  /** Banks of mist drifting through (0–1). */
  readonly fog: number;
}

export function weatherLook(weather: Weather): WeatherLook {
  switch (weather) {
    case "cloudy":
      return { veil: 0x5a6070, veilAlpha: 0.08, falling: null, density: 0, clouds: 1, fog: 0 };
    case "rain":
      return {
        veil: 0x2e3e56,
        veilAlpha: 0.26,
        falling: "rain",
        density: 14,
        clouds: 0.8,
        fog: 0,
      };
    case "fog":
      return { veil: 0xdfe6ea, veilAlpha: 0.16, falling: null, density: 0, clouds: 0, fog: 1 };
    case "snow":
      return {
        veil: 0x6a7a94,
        veilAlpha: 0.16,
        falling: "snow",
        density: 2.5,
        clouds: 0.3,
        fog: 0,
      };
    default:
      return { veil: 0xffffff, veilAlpha: 0, falling: null, density: 0, clouds: 0, fog: 0 };
  }
}

/**
 * Partway from one weather's look to another's (t 0–1): the veil, cloud and
 * fog fade across, and whatever falls thins out as the other thickens. If
 * both have something falling (rain turning to snow), the new kind takes
 * over at the halfway point.
 */
export function blendLook(from: WeatherLook, to: WeatherLook, t: number): WeatherLook {
  if (t >= 1 || from === to) return to;
  const k = Math.max(0, t);
  const lerpN = (a: number, b: number): number => a + (b - a) * k;
  const veilAlpha = lerpN(from.veilAlpha, to.veilAlpha);
  const veilShare = to.veilAlpha / Math.max(0.0001, from.veilAlpha + to.veilAlpha);
  const falling =
    from.falling && to.falling
      ? k < 0.5
        ? from.falling
        : to.falling
      : (to.falling ?? from.falling);
  const density =
    from.falling && to.falling
      ? k < 0.5
        ? from.density * (1 - 2 * k)
        : to.density * (2 * k - 1)
      : to.falling
        ? to.density * k
        : from.density * (1 - k);
  return {
    veil: mix(from.veil, to.veil, from.veilAlpha === 0 ? 1 : to.veilAlpha === 0 ? 0 : veilShare),
    veilAlpha,
    falling: density > 0.05 ? falling : null,
    density,
    clouds: lerpN(from.clouds, to.clouds),
    fog: lerpN(from.fog, to.fog),
  };
}

/**
 * The weather on a given day and time: it changes every four hours and
 * repeats for everyone at the same moment. Mostly fair; fog comes in the
 * early morning; snow only in December to February, in place of rain.
 */
export function weatherFor(date: Date): Weather {
  const block = Math.floor(date.getHours() / 4);
  const day = date.getFullYear() * 400 + date.getMonth() * 32 + date.getDate();
  const roll = hash(day, block, 77);
  const winter = [11, 0, 1].includes(date.getMonth());
  const early = date.getHours() >= 4 && date.getHours() < 9;
  if (roll < 0.56) return "clear";
  if (roll < 0.78) return "cloudy";
  if (roll < 0.9) return winter ? "snow" : "rain";
  return early ? "fog" : "cloudy";
}

/**
 * Something that glows after dark. `x` and `y` are where it stands on the
 * ground (map pixels; `y` is the foot line it's over) and `z` how high above
 * the ground it burns, so it lights what faces it and is hidden from what
 * something taller stands in front of. `owner` is the standing thing it's
 * part of (a stone lantern, the house): that thing's body glows round it
 * instead of being shaded. A `wall` light (a paper window) is set into its
 * owner, so its owner still blocks it from everything behind the wall.
 */
export interface FarmLamp {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly r: number;
  readonly strength: number;
  readonly owner?: number;
  readonly wall?: boolean;
}

/** The warm light of a lamp, for the overlay's glow. */
const LAMP_WARM: Rgb = 0xffb050;

/** How many steps lamplight falls off in, and how wide the dither at each step's edge is (0–1). */
const LIGHT_STEPS = 5;
const DITHER = 0.55;

/** A 4×4 ordered-dither threshold, so light falls off in crisp pixel steps. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;

/** The night's darkness at a moment: its colour, how thick, and how lit the lamps are. */
export interface OverlayTone {
  readonly color: Rgb;
  readonly strength: number;
  readonly lamps: number;
}

/** The darkness for a sky and weather, or null in fair daylight (nothing to draw). */
export function overlayTone(sky: FarmSky, look: WeatherLook): OverlayTone | null {
  if (sky.tintAlpha < 0.01 && look.veilAlpha < 0.01) return null;
  // The veil and the tint combine into one colour and strength.
  const veilShare = look.veilAlpha / Math.max(0.0001, sky.tintAlpha + look.veilAlpha);
  return {
    color: mix(sky.tint, look.veil, veilShare),
    strength: 1 - (1 - sky.tintAlpha) * (1 - look.veilAlpha),
    lamps: sky.lamps,
  };
}

/**
 * One pixel of the darkness, given how much lamplight reaches it (0–1, any
 * lamp: fixed or carried). The light steps down in four rings, dithered at
 * their edges; lit pixels thin the dark and turn it warm. Every light on the
 * farm goes through here, so they all look alike.
 */
export function overlayPixel(
  light: number,
  x: number,
  y: number,
  tone: OverlayTone,
  out: Uint8ClampedArray,
  at: number,
): void {
  // Dithered only near each step's edge, so the light lies in clean bands
  // instead of a speckle across all of it.
  const threshold = ((BAYER[(y % 4) * 4 + (x % 4)] ?? 0) + 0.5) / 16;
  const stepped = Math.min(
    1,
    Math.max(0, Math.floor(light * LIGHT_STEPS + 0.5 + (threshold - 0.5) * DITHER) / LIGHT_STEPS),
  );
  const alpha = tone.strength * (1 - stepped * 0.85);
  // Near a lamp the overlay turns warm, so the light itself has colour.
  const c = stepped > 0 ? mix(tone.color, LAMP_WARM, Math.min(1, stepped * 1.1)) : tone.color;
  const a = stepped > 0 ? Math.max(alpha, stepped * 0.2 * tone.lamps) : alpha;
  out[at] = (c >> 16) & 255;
  out[at + 1] = (c >> 8) & 255;
  out[at + 2] = c & 255;
  out[at + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
}

// ── Light that respects what's around it ────────────────────────
//
// The farm is drawn from a high camera, so every map pixel shows one of
// three kinds of surface: open ground, the sky-facing top of something
// standing (a roof, a canopy), or its side turned toward the camera (a wall,
// a trunk, a lantern's post). `lightRelief` works out, once per farm, where
// on the ground each pixel's surface really is, how high, and which way it
// faces; and a height field of everything standing, for shadows. A lamp then
// lights a surface by how near it is in all three dimensions, how squarely
// the surface faces it, and whether anything taller stands in between: a
// critter walking behind a tree lights the ground round itself, not the
// tree's near side; a lantern beside a house throws the house's shadow.

/** What stands where, for light (see Farm.solids). */
export interface LightSolids {
  /** For each map pixel, the standing thing drawn there, or -1. */
  readonly owner: Int32Array;
  /** Each thing's foot line (map y). */
  readonly bases: readonly number[];
  /** The last map row of each thing that faces the sky; below it, its side. */
  readonly tops: readonly number[];
}

/** Each map pixel's surface, and the height field of everything standing (see lightRelief). */
export interface LightRelief {
  readonly width: number;
  readonly height: number;
  readonly owner: Int32Array;
  readonly bases: readonly number[];
  /** Where on the ground the surface seen at each pixel stands (map y). */
  readonly gy: Int16Array;
  /** How high above the ground it is. */
  readonly z: Int16Array;
  /** Which way it faces (×127): x east, y toward the camera, z up. */
  readonly nx: Int8Array;
  readonly ny: Int8Array;
  readonly nz: Int8Array;
  /** The tallest thing standing over each ground spot, and which thing it is (-1: open). */
  readonly field: Int16Array;
  readonly fieldOwner: Int32Array;
  /**
   * How many ground spots have something standing on them, summed from the
   * top-left corner ((width + 1) × (height + 1)), so a shadow's search can
   * skip open ground at once.
   */
  readonly standing: Int32Array;
}

/** Whether anything stands anywhere in the box from (x0, y0) to (x1, y1), inclusive. */
function anyStanding(r: LightRelief, x0: number, y0: number, x1: number, y1: number): boolean {
  const w = r.width + 1;
  const ax = Math.max(0, Math.min(x0, x1));
  const ay = Math.max(0, Math.min(y0, y1));
  const bx = Math.min(r.width, Math.max(x0, x1) + 1);
  const by = Math.min(r.height, Math.max(y0, y1) + 1);
  if (bx <= ax || by <= ay) return false;
  const sum =
    (r.standing[by * w + bx] ?? 0) -
    (r.standing[ay * w + bx] ?? 0) -
    (r.standing[by * w + ax] ?? 0) +
    (r.standing[ay * w + ax] ?? 0);
  return sum > 0;
}

/** World depth per map pixel of y: the high camera foreshortens the ground. */
const DEPTH = 1.35;
/** Light wraps a little round a surface turned just away from it (a soft terminator). */
const WRAP = 0.3;
/** Open ground catches a lamp's light even at a low angle (it lies all round it). */
const GROUND_FLOOR = 0.55;
/** How brightly a lamp's own body glows round it (a stone lantern's cap, a window's frame). */
const OWN_GLOW = 0.85;
const OWN_SPILL = 0.3;
/** How much light still reaches a spot in shadow (bounced light). */
const BOUNCE = 0.1;
/** Light this faint never lifts a pixel by a step (see overlayPixel). */
const FAINT = 0.04;

function normal(out: { x: number; y: number; z: number }, x: number, y: number, z: number): void {
  const len = Math.hypot(x, y, z) || 1;
  out.x = x / len;
  out.y = y / len;
  out.z = z / len;
}

/** Each pixel's surface and the height field, from what stands where (see LightRelief). */
export function lightRelief(width: number, height: number, solids: LightSolids): LightRelief {
  const n = width * height;
  const gy = new Int16Array(n);
  const z = new Int16Array(n);
  const nx = new Int8Array(n);
  const ny = new Int8Array(n);
  const nz = new Int8Array(n).fill(127);
  const field = new Int16Array(n);
  const fieldOwner = new Int32Array(n).fill(-1);
  const { owner, bases, tops } = solids;
  // Each thing's highest row, for the dome of its top.
  const highest = new Int32Array(bases.length).fill(height);
  for (let i = 0; i < n; i++) {
    const o = owner[i] ?? -1;
    const y = Math.floor(i / width);
    if (o >= 0 && y < (highest[o] ?? height)) highest[o] = y;
  }
  const v = { x: 0, y: 0, z: 1 };
  const spans = new Map<number, [number, number]>();
  for (let y = 0; y < height; y++) {
    spans.clear();
    for (let x = 0; x < width; x++) {
      const o = owner[y * width + x] ?? -1;
      if (o < 0) continue;
      const span = spans.get(o);
      if (span) span[1] = x;
      else spans.set(o, [x, x]);
    }
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      gy[i] = y;
      const o = owner[i] ?? -1;
      if (o < 0) continue;
      const base = bases[o] ?? y;
      const top = tops[o] ?? base;
      // Anything below its own foot line lies on the ground.
      if (y > base) continue;
      const [a, b] = spans.get(o) ?? [x, x];
      const half = Math.max(1, (b - a + 1) / 2);
      // Round things are lit round: their edges turn away to the sides.
      const across = Math.max(-1, Math.min(1, (x - (a + b) / 2) / half));
      let ground: number;
      let up: number;
      if (y > top) {
        // Its side, upright on its foot line.
        ground = base;
        up = base - y;
        normal(v, across * 1.4, 1, 0);
      } else {
        // Its top, at the height of its eave, over the ground behind its foot.
        up = base - top;
        ground = y + up;
        const h = highest[o] ?? top;
        const along = Math.max(-1, Math.min(1, (y - (h + top) / 2) / Math.max(1, (top - h) / 2)));
        normal(v, across * 0.6, along * 0.5, 1);
      }
      gy[i] = ground;
      z[i] = up;
      nx[i] = Math.round(v.x * 127);
      ny[i] = Math.round(v.y * 127);
      nz[i] = Math.round(v.z * 127);
      if (ground >= 0 && ground < height) {
        const c = ground * width + x;
        if (up > (field[c] ?? 0)) {
          field[c] = up;
          fieldOwner[c] = o;
        }
      }
    }
  }
  const w = width + 1;
  const standing = new Int32Array(w * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += (fieldOwner[y * width + x] ?? -1) >= 0 ? 1 : 0;
      standing[(y + 1) * w + x + 1] = (standing[y * w + x + 1] ?? 0) + row;
    }
  }
  return { width, height, owner, bases, gy, z, nx, ny, nz, field, fieldOwner, standing };
}

/** A surface for a lamp to light: where it is, which way it faces, and whose it is. */
interface Surface {
  x: number;
  gy: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  owner: number;
  ground: boolean;
}

function blankSurface(): Surface {
  return { x: 0, gy: 0, z: 0, nx: 0, ny: 0, nz: 1, owner: -1, ground: true };
}

function surfaceAt(out: Surface, relief: LightRelief | undefined, x: number, y: number): Surface {
  out.x = x;
  out.gy = y;
  out.z = 0;
  out.nx = 0;
  out.ny = 0;
  out.nz = 1;
  out.owner = -1;
  out.ground = true;
  if (!relief) return out;
  const i = y * relief.width + x;
  const o = relief.owner[i] ?? -1;
  out.owner = o;
  out.gy = relief.gy[i] ?? y;
  out.z = relief.z[i] ?? 0;
  out.nx = (relief.nx[i] ?? 0) / 127;
  out.ny = (relief.ny[i] ?? 0) / 127;
  out.nz = (relief.nz[i] ?? 127) / 127;
  out.ground = o < 0 || out.z <= 0;
  return out;
}

/**
 * How much of `lamp`'s light reaches a surface, 0–1: falling off with
 * distance (in three dimensions, the ground foreshortened for the high
 * camera), by how squarely the surface faces the lamp, and cut to bounced
 * light where something taller stands in between.
 */
function lightOn(
  s: Surface,
  lamp: FarmLamp,
  relief: LightRelief | undefined,
  /** Light already reaching it: no need to look for a shadow on anything dimmer. */
  floor = 0,
): number {
  const vx = lamp.x - s.x;
  const vy = (lamp.y - s.gy) * DEPTH;
  const vz = lamp.z - s.z;
  const d2 = vx * vx + vy * vy + vz * vz;
  if (d2 >= lamp.r * lamp.r) return 0;
  const d = Math.sqrt(d2);
  const t = 1 - d / lamp.r;
  // Bright close to the flame, fading softly at the edge of its reach.
  const fall = t * t * (3 - 2 * t) * lamp.strength;
  // Its own body glows round the flame; what's above the flame (a lantern's
  // cap, the eaves over a window) catches only what spills up past it.
  if (s.owner >= 0 && s.owner === (lamp.owner ?? -1)) {
    return fall * (s.z > lamp.z + 1 ? OWN_SPILL : OWN_GLOW);
  }
  let facing = d < 0.5 ? 1 : (s.nx * vx + s.ny * vy + s.nz * vz) / d;
  if (s.ground) facing = Math.max(facing, GROUND_FLOOR);
  // Someone standing right by a light is lit all over by it, a little.
  else if (s.owner === BODY && d < lamp.r * 0.5) facing = Math.max(facing, BODY_FLOOR);
  if (facing <= -WRAP) return 0;
  const k = fall * ((facing + WRAP) / (1 + WRAP));
  // Too faint to show, or no brighter than what reaches it anyway: no shadow to look for.
  if (k < FAINT || k <= floor || !relief) return k;
  return shaded(relief, s, lamp) ? k * BOUNCE : k;
}

/**
 * Whether something standing blocks the line from a surface to a lamp:
 * walk the ground between them, and see if anything there (but the surface's
 * own thing, or the lamp's, unless the lamp's set in a wall) stands taller
 * than the line at that point.
 */
function shaded(relief: LightRelief, s: Surface, lamp: FarmLamp): boolean {
  const { width, height, field, fieldOwner } = relief;
  const dx = lamp.x - s.x;
  const dy = lamp.y - s.gy;
  const dz = lamp.z - s.z;
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
  // Nothing standing between them at all (open ground): no shadow.
  if (
    !anyStanding(relief, Math.round(s.x), Math.round(s.gy), Math.round(lamp.x), Math.round(lamp.y))
  ) {
    return false;
  }
  const lampOwner = lamp.wall ? -2 : (lamp.owner ?? -1);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const cx = Math.round(s.x + dx * t);
    const cy = Math.round(s.gy + dy * t);
    if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
    const c = cy * width + cx;
    const o = fieldOwner[c] ?? -1;
    if (o < 0 || o === s.owner || o === lampOwner) continue;
    if ((field[c] ?? 0) > s.z + dz * t + 0.5) return true;
  }
  return false;
}

/** The prepared darkness, and the fixed lamps' light at every pixel, for carried lanterns to add to. */
export interface SkyLight {
  readonly pixels: PixelBuffer;
  /** Fixed lamplight reaching each pixel (already scaled by how lit the lamps are). */
  readonly light: Float32Array;
  readonly tone: OverlayTone;
  /** The fixed lamps that are lit, to light whoever walks among them (see litPatch). */
  readonly lamps: readonly FarmLamp[];
  /** Boxes already relit against this light, by what was in them (see drawLitOverlay). */
  readonly patches: Map<string, Uint8ClampedArray>;
}

/**
 * The light overlay for a moment: the time of day's tint (and the weather's
 * veil) over the whole map, opened up where lamplight falls (see lightOn)
 * and warmed by its glow as the lamps come on. Built once per change (about
 * once a minute), then drawn each frame as one image. Null in plain daylight
 * with fair weather: nothing to draw.
 */
export function skyLight(
  width: number,
  height: number,
  sky: FarmSky,
  look: WeatherLook,
  lamps: readonly FarmLamp[],
  relief?: LightRelief,
): SkyLight | null {
  const tone = overlayTone(sky, look);
  if (!tone) return null;
  const lit = sky.lamps > 0.02 ? lamps : [];
  const pixels = new PixelBuffer(width, height);
  const light = new Float32Array(width * height);
  const s = blankSurface();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // How much lamplight reaches here (the brightest lamp wins).
      let best = 0;
      if (lit.length > 0) {
        surfaceAt(s, relief, x, y);
        for (const lamp of lit) {
          const k = lightOn(s, lamp, relief, best);
          if (k > best) best = k;
        }
      }
      const i = y * width + x;
      light[i] = best * sky.lamps;
      overlayPixel(light[i] ?? 0, x, y, tone, pixels.data, i * 4);
    }
  }
  return { pixels, light, tone, lamps: lit, patches: new Map() };
}

/** The overlay alone (see skyLight). */
export function skyOverlay(
  width: number,
  height: number,
  sky: FarmSky,
  look: WeatherLook,
  lamps: readonly FarmLamp[],
  relief?: LightRelief,
): PixelBuffer | null {
  return skyLight(width, height, sky, look, lamps, relief)?.pixels ?? null;
}

/**
 * Someone standing on the farm, for light to fall on: their sprite rows
 * (anything but "." is them), drawn from (x0, y0), flipped or not, standing
 * on the foot line `feet`. They're lit as a figure upright there (the top of
 * the head facing the sky), not as the ground their pixels happen to cover.
 */
export interface LitBody {
  readonly x0: number;
  readonly y0: number;
  readonly rows: readonly string[];
  readonly flip: boolean;
  readonly feet: number;
}

/** A body's stand-in owner: not any thing on the map, nor any lamp's. */
const BODY = -3;
/** How much light someone standing close to a lamp catches even on their far side. */
const BODY_FLOOR = 0.2;

/** Whether a lamp's light could reach open ground at (x, y). */
function near(l: FarmLamp, x: number, y: number): boolean {
  const dx = x - l.x;
  const dy = (y - l.y) * DEPTH;
  return dx * dx + dy * dy < l.r * l.r;
}

/**
 * How high above the ground anything stands round (x, y), within `r` (its
 * reach over the ground): a lamp lights no higher than that.
 */
export function tallestNear(relief: LightRelief, x: number, y: number, r: number): number {
  const x0 = Math.max(0, Math.floor(x - r));
  const x1 = Math.min(relief.width - 1, Math.ceil(x + r));
  const y0 = Math.max(0, Math.floor(y - r / DEPTH));
  const y1 = Math.min(relief.height - 1, Math.ceil(y + r / DEPTH));
  if (!anyStanding(relief, x0, y0, x1, y1)) return 0;
  let top = 0;
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++)
      top = Math.max(top, relief.field[yy * relief.width + xx] ?? 0);
  }
  return top;
}

/** The share of a body's rows, from the top, that face the sky (the crown of the head). */
const CROWN_SHARE = 0.45;

/** The body drawn at (x, y), front-most first, unless something standing is drawn over it there. */
function bodyAt(
  bodies: readonly LitBody[],
  relief: LightRelief | undefined,
  x: number,
  y: number,
): LitBody | null {
  let found: LitBody | null = null;
  for (const b of bodies) {
    const row = b.rows[y - b.y0];
    if (!row || (found && found.feet >= b.feet)) continue;
    const col = b.flip ? row.length - 1 - (x - b.x0) : x - b.x0;
    const ch = row[col];
    if (ch === undefined || ch === ".") continue;
    found = b;
  }
  if (!found || !relief) return found;
  const o = relief.owner[y * relief.width + x] ?? -1;
  // A standing thing nearer the camera (its foot lower down) is drawn over them here.
  return o >= 0 && (relief.bases[o] ?? -1) > found.feet ? null : found;
}

function bodySurface(out: Surface, b: LitBody, x: number, y: number): Surface {
  const w = b.rows[0]?.length ?? 1;
  const h = b.rows.length;
  const across = Math.max(-1, Math.min(1, (x - b.x0 - (w - 1) / 2) / (w / 2)));
  const v = { x: 0, y: 0, z: 0 };
  // The crown is round: it faces the sky but turns toward the camera and the sides as well.
  if (y - b.y0 < h * CROWN_SHARE) normal(v, across * 0.9, 0.7, 0.8);
  else normal(v, across * 1.4, 1, 0);
  out.x = x;
  out.gy = b.feet;
  out.z = Math.max(0, b.feet - y);
  out.nx = v.x;
  out.ny = v.y;
  out.nz = v.z;
  out.owner = BODY;
  out.ground = false;
  return out;
}

/**
 * The darkness over a small box with carried lanterns lighting it as well as
 * the fixed lamps, and with anyone standing in it lit as a figure (see
 * LitBody): the same falloff, facing, blocking, rings and warmth as the
 * prepared overlay (each pixel keeps whichever light is brightest). RGBA,
 * `w` × `h`, from (x0, y0).
 */
export function litPatch(
  sky: SkyLight,
  lanterns: readonly FarmLamp[],
  bodies: readonly LitBody[],
  width: number,
  height: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  relief?: LightRelief,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const s = blankSurface();
  const level = sky.tone.lamps;
  const under = (best: number): number => (level > 0 ? best / level : 0);
  for (let py = 0; py < h; py++) {
    const y = y0 + py;
    for (let px = 0; px < w; px++) {
      const x = x0 + px;
      const o = (py * w + px) * 4;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const body = bodies.length > 0 ? bodyAt(bodies, relief, x, y) : null;
      // Open ground out of every lantern's reach is just the prepared dark.
      if (
        !body &&
        (relief?.owner[y * width + x] ?? -1) < 0 &&
        !lanterns.some((l) => near(l, x, y))
      ) {
        const from = (y * width + x) * 4;
        for (let c = 0; c < 4; c++) out[o + c] = sky.pixels.data[from + c] ?? 0;
        continue;
      }
      let best = 0;
      if (body) {
        bodySurface(s, body, x, y);
        for (const lamp of sky.lamps) {
          best = Math.max(best, lightOn(s, lamp, relief, under(best)) * level);
        }
      } else {
        best = sky.light[y * width + x] ?? 0;
        surfaceAt(s, relief, x, y);
      }
      for (const l of lanterns) best = Math.max(best, lightOn(s, l, relief, under(best)) * level);
      overlayPixel(best, x, y, sky.tone, out, o);
    }
  }
  return out;
}

/**
 * A tile of soft blobs for drifting cloud shadows or banks of mist: alpha
 * from noise, in a few flat steps, seamless at its edges so it can repeat.
 */
export function cloudTile(size: number, color: Rgb, maxAlpha: number, seed: number): PixelBuffer {
  const out = new PixelBuffer(size, size);
  const cells = 4;
  const cell = size / cells;
  const corner = (cx: number, cy: number): number =>
    hash(((cx % cells) + cells) % cells, ((cy % cells) + cells) % cells, seed);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = x / cell;
      const gy = y / cell;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const tx = smooth(gx - x0);
      const ty = smooth(gy - y0);
      const top = corner(x0, y0) + (corner(x0 + 1, y0) - corner(x0, y0)) * tx;
      const bottom = corner(x0, y0 + 1) + (corner(x0 + 1, y0 + 1) - corner(x0, y0 + 1)) * tx;
      const n = top + (bottom - top) * ty;
      // Only the densest third forms a cloud: a flat core, and a rim that
      // breaks up through an ordered dither (GG Royale shades with dither,
      // not soft alpha), so the shadow's edge reads as pixels.
      const k = Math.max(0, (n - 0.55) / 0.45);
      const B = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;
      const t = ((B[(y & 3) * 4 + (x & 3)] ?? 0) + 0.5) / 16;
      // The core is two flat steps; only its thin outer rim is dithered, at
      // a sparse quarter, so a cloud's shade has a pixel edge, not a veil.
      // The dotted fringe is a thin band, so it never spreads into a screen.
      const stepped = k > 0.5 ? 1 : k > 0.2 ? 0.66 : k > 0.14 && t < 0.25 ? 0.5 : 0;
      const i = (y * size + x) * 4;
      out.data[i] = (color >> 16) & 255;
      out.data[i + 1] = (color >> 8) & 255;
      out.data[i + 2] = color & 255;
      out.data[i + 3] = Math.round(stepped * maxAlpha * 255);
    }
  }
  return out;
}
