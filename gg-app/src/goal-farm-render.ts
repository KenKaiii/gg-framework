// Draws a Goal's farm on a canvas at a whole-number pixel scale. The static
// map (ground, buildings, trees, beds) is composed once per size into a cached
// background; each frame then draws only what moves, back to front by how far
// down the map it stands: the fire, steam, koi, petals, the cat, chickens and
// dragonfly, and the critters walking about.

import { frameRows, type CritterDef } from "./critter-sprites";
import { FARM_CRITTER_H, FARM_CRITTER_W, farmCritterLook, litFarmGrid } from "./goal-farm-critters";
import { drawChochin, drawFarmWork } from "./goal-farm-held";
import { composeMap, type PlacedProp } from "./goal-map-compose";
import { PixelBuffer, hash } from "./goal-map-pixels";
import {
  animalClock,
  koiClock,
  progress,
  reactionOn,
  type Debris,
  type FarmPlay,
  type Reaction,
  type ThingKind,
} from "./goal-farm-interact";
import {
  cloudTile,
  litPatch,
  tallestNear,
  skyLight,
  type FarmLamp,
  type LitBody,
  type FarmSky,
  type SkyLight,
  type WeatherLook,
} from "./goal-farm-sky";
import {
  CAT_LIT,
  CAT_STEP_A,
  HEN_LIT,
  lightAnimal,
  HEN_PECK,
  HEN_STAND,
  HEN_WALK,
  WELL_WATER_AT,
  drawFirePot,
  KOI,
  KOI_COLORS,
  POND_WATER,
  SHIBA_ASLEEP,
  SHIBA_COLORS,
} from "./goal-map-topdown";
import { drawText, LINE_PITCH, textWidth, wrapText } from "./pixel-text";
import { SURFACE, type Farm } from "./goal-farm-map";
import { ARRIVE_MS, LEAVE_MS, type Actor, type FarmWorld } from "./goal-farm-sim";
import { tripPose, type Spot } from "./goal-farm-travel";
import type { KenMark } from "./goal-ken-status";
import { roamPose, type Roamer, type RoamPose } from "./goal-farm-roam";

type Ctx = CanvasRenderingContext2D;

/** A farm critter sprite's width and height (see goal-farm-critters). */
const CRITTER = FARM_CRITTER_W;
const CRITTER_H = FARM_CRITTER_H;
const WATER_HEX = hexPalette(POND_WATER);
const KOI_HEX = Object.fromEntries(
  Object.entries(KOI_COLORS).map(([k, c]) => [k, `#${c.toString(16).padStart(6, "0")}`]),
) as Record<keyof typeof KOI_COLORS, string>;

/** Compose the farm's static map into an offscreen canvas, once per size. */
export function paintFarm(farm: Farm): HTMLCanvasElement {
  return canvasOf(composeMap(farm.scene));
}

/** Things that sway when poked (see stir in playItems). */
const SWAYS: ReadonlySet<string> = new Set(["tree", "sakura", "camellia", "yuzu", "bush"]);

/**
 * The farm's map without its trees and bushes (their shadows stay): a
 * swaying one is redrawn over its own spot from this, so its still self
 * doesn't show behind the moving one. About one map's paint; made once per
 * farm, off the first frame (see GoalWorld).
 */
export function paintSwayBase(farm: Farm): PixelBuffer {
  return composeMap(farm.scene, swayProps(farm));
}

function swayProps(farm: Farm): Set<PlacedProp> {
  const props = new Set<PlacedProp>();
  for (const t of farm.things) {
    const prop = SWAYS.has(t.kind) ? farm.occluders[t.occluder]?.prop : undefined;
    if (prop) props.add(prop);
  }
  return props;
}

/**
 * The farm's surface with the trees and bushes gone: open ground where they
 * stood. For grading the tree-less copy for the hour and the weather (see
 * weatherBackground) exactly like the map round it, so the patch under a
 * swaying tree can't show as a box of a different tone.
 */
export function swaySurface(farm: Farm): Uint8Array {
  const gone = swayProps(farm);
  const out = farm.surface.slice();
  const { owner } = farm.solids;
  for (let i = 0; i < out.length; i++) {
    const prop = farm.scene.props[owner[i] ?? -1];
    if (prop && gone.has(prop)) out[i] = SURFACE.ground;
  }
  return out;
}

/**
 * The share of a reaction a tree or bush spends swaying (a bird taking off
 * only stirs it briefly), or null if the reaction doesn't sway it.
 */
function stirSpan(r: Reaction): number | null {
  if (!SWAYS.has(r.kind)) return null;
  if (r.action === "shake" || r.action === "rustle") return 1;
  if (r.action === "bird") return 0.35;
  return null;
}

/** How far a swaying tree or bush can move from its spot (see stir). */
const SWAY_MARGIN = 3;

/**
 * Under each tree or bush swaying right now: its spot repainted from the
 * map without it, so only the moving one shows. Any other tree or bush that
 * the repainted spot overlaps is put back at its own depth (anything in
 * front of it is redrawn over it as usual).
 */
function clearSwaying(
  ctx: Ctx,
  farm: Farm,
  play: FarmPlay,
  now: number,
  occluders: readonly OccluderCanvas[],
  out: Placed[],
): void {
  const base = play.swayBase;
  if (!base || base.farm !== farm) return;
  const swaying = new Set<string>();
  const spots: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  for (const r of play.reactions) {
    const span = stirSpan(r);
    if (span === null || now >= r.until || progress(r, now) >= span) continue;
    const t = farm.things.find((thing) => thing.id === r.target);
    if (!t) continue;
    swaying.add(t.id);
    const x0 = Math.max(0, t.x - SWAY_MARGIN);
    const y0 = Math.max(0, t.y);
    const x1 = Math.min(farm.width, t.x + t.buf.width + SWAY_MARGIN);
    const y1 = Math.min(farm.height, t.y + t.buf.height);
    ctx.drawImage(base.image, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    spots.push({ x0, y0, x1, y1 });
  }
  if (spots.length === 0) return;
  for (const t of farm.things) {
    if (!SWAYS.has(t.kind) || swaying.has(t.id) || t.occluder < 0) continue;
    const o = occluders[t.occluder];
    if (!o) continue;
    const hit = spots.some((s) => o.x < s.x1 && o.x + o.w > s.x0 && o.y < s.y1 && o.y + o.h > s.y0);
    if (!hit) continue;
    out.push({
      y: o.base,
      body: { x0: o.x, y0: o.y, x1: o.x + o.w },
      draw: () => ctx.drawImage(o.image, o.x, o.y),
    });
  }
}

/** A pixel buffer as a canvas, ready to draw. */
export function canvasOf(buf: PixelBuffer): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = buf.width;
  canvas.height = buf.height;
  canvas.getContext("2d")?.putImageData(buf.toImageData(), 0, 0);
  return canvas;
}

/** Paint a character grid with its top-left at (x, y); `flip` mirrors it. */
function drawGrid(
  ctx: Ctx,
  rows: readonly string[],
  palette: Readonly<Record<string, string>>,
  x: number,
  y: number,
  flip = false,
): void {
  const width = rows[0]?.length ?? 0;
  rows.forEach((row, dy) => {
    let i = 0;
    while (i < row.length) {
      const ch = row[i];
      let end = i + 1;
      while (end < row.length && row[end] === ch) end++;
      const color = ch === undefined || ch === "." ? undefined : palette[ch];
      if (color) {
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(x) + (flip ? width - end : i), Math.round(y) + dy, end - i, 1);
      }
      i = end;
    }
  });
}

function critterDef(id: string): CritterDef {
  return farmCritterLook(id);
}

/** A soft oval shadow on the ground. */
function shadow(ctx: Ctx, x: number, y: number, rx: number, ry: number, a: number): void {
  ctx.fillStyle = "#2a1406";
  ctx.globalAlpha = a;
  for (let dy = -ry; dy <= ry; dy++) {
    const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy / (ry + 0.5)) ** 2)));
    if (half > 0) ctx.fillRect(Math.round(x) - half, Math.round(y) + dy, half * 2, 1);
  }
  ctx.globalAlpha = 1;
}

// ── Summon in, and back out ─────────────────────────────────

/**
 * The summon's shape over its course (0 = nothing, 1 = standing there): a
 * white silhouette grows out of a speck above the ground, stretches as it
 * drops, squashes on landing, bounces back, and settles, the way the home
 * screen's critters arrive, made gentler for the farm.
 */
const SUMMON_KEYS: ReadonlyArray<{
  readonly at: number;
  readonly sx: number;
  readonly sy: number;
  readonly dy: number;
}> = [
  { at: 0, sx: 0.05, sy: 0.05, dy: -12 },
  { at: 0.22, sx: 0.05, sy: 0.05, dy: -12 },
  { at: 0.45, sx: 0.62, sy: 1.28, dy: -4 },
  { at: 0.62, sx: 1.18, sy: 0.8, dy: 0 },
  { at: 0.8, sx: 0.95, sy: 1.06, dy: 0 },
  { at: 1, sx: 1, sy: 1, dy: 0 },
];

function summonShape(p: number): { sx: number; sy: number; dy: number } {
  for (let i = 1; i < SUMMON_KEYS.length; i++) {
    const a = SUMMON_KEYS[i - 1];
    const b = SUMMON_KEYS[i];
    if (!a || !b || p > b.at) continue;
    const t = b.at === a.at ? 1 : (p - a.at) / (b.at - a.at);
    const e = t * t * (3 - 2 * t);
    return {
      sx: a.sx + (b.sx - a.sx) * e,
      sy: a.sy + (b.sy - a.sy) * e,
      dy: a.dy + (b.dy - a.dy) * e,
    };
  }
  return { sx: 1, sy: 1, dy: 0 };
}

/** A grid drawn scaled about the middle of its feet, pixel by pixel (no gaps). */
function drawGridScaled(
  ctx: Ctx,
  rows: readonly string[],
  palette: Readonly<Record<string, string>>,
  cx: number,
  feet: number,
  sx: number,
  sy: number,
  flip: boolean,
): void {
  const w = rows[0]?.length ?? 0;
  const h = rows.length;
  rows.forEach((row, y) => {
    const y0 = Math.round(feet + (y - h) * sy);
    const y1 = Math.round(feet + (y + 1 - h) * sy);
    if (y1 <= y0) return;
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const color = ch === undefined || ch === "." ? undefined : palette[ch];
      if (!color) continue;
      const col = flip ? w - 1 - x : x;
      const x0 = Math.round(cx + (col - w / 2) * sx);
      const x1 = Math.round(cx + (col + 1 - w / 2) * sx);
      if (x1 <= x0) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  });
}

const SILHOUETTES = new Map<string, Record<string, string>>();

/** Every colour in a critter's palette turned to warm white: its silhouette. */
function silhouette(def: CritterDef): Record<string, string> {
  const have = SILHOUETTES.get(def.id);
  if (have) return have;
  const made = Object.fromEntries(Object.keys(def.palette).map((k) => [k, "#fffaf0"]));
  SILHOUETTES.set(def.id, made);
  return made;
}

const SUMMON_PETALS = ["#ffffff", "#f8c8d4", "#fde58a", "#bfe08a"] as const;

/** A 4×4 ordered (Bayer) dither threshold for a pixel, 0–1. */
const BAYER_R = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;
function bayerAt(x: number, y: number): number {
  return ((BAYER_R[(y & 3) * 4 + (x & 3)] ?? 0) + 0.5) / 16;
}

/**
 * A critter being summoned in at `p` (0 → 1), or out (the same, run
 * backwards). Pixel art doesn't fade through transparency, so everything
 * here thins out by dropping pixels through an ordered dither instead:
 * a column of sunlight pours down where it will stand, a
 * ring of petals spreads on the ground, its white silhouette grows out of
 * the light with a little squash and stretch, then warms into its colours,
 * and a few petals scatter. Quiet, warm and small, to suit the farm.
 */
function drawSummon(
  ctx: Ctx,
  def: CritterDef,
  rows: readonly string[],
  x: number,
  y: number,
  facing: 1 | -1,
  p: number,
  now: number,
): void {
  // The light: pours down over the first quarter, holds, and fades out.
  const pour = Math.min(1, p / 0.25);
  const light = p < 0.6 ? 1 : Math.max(0, 1 - (p - 0.6) / 0.3);
  if (light > 0) {
    const tall = 40;
    const reach = Math.round(tall * pour);
    // Three bands, densest in the middle: each a dithered screen of light
    // that thins (loses pixels) as the light fades, thinner toward the top.
    for (let yy = 0; yy < reach; yy++) {
      const py = Math.round(y - tall + yy);
      const up = 0.55 + 0.45 * (yy / tall);
      for (let dx = -7; dx < 7; dx++) {
        const px = Math.round(x + dx);
        const band = Math.abs(dx + 0.5);
        const cover = (band < 1.5 ? 0.8 : band < 4.5 ? 0.45 : 0.2) * light * up;
        if (bayerAt(px, py) >= cover) continue;
        ctx.fillStyle = band < 1.5 ? "#ffffff" : "#fff4d8";
        ctx.fillRect(px, py, 1, 1);
      }
    }
  }
  // The ring of petals spreading out on the ground.
  if (p > 0.15 && p < 0.8) {
    const k = (p - 0.15) / 0.65;
    const rx = 3 + k * 11;
    // As it spreads, petals drop out one by one rather than fading.
    for (let i = 0; i < 12; i++) {
      if (((i * 7) % 12) / 12 < k) continue;
      const a = (i / 12) * Math.PI * 2;
      ctx.fillStyle = SUMMON_PETALS[i % SUMMON_PETALS.length] ?? "#ffffff";
      ctx.fillRect(Math.round(x + Math.cos(a) * rx), Math.round(y + Math.sin(a) * rx * 0.4), 1, 1);
    }
  }
  ctx.globalAlpha = 1;
  // Its shadow widening under it.
  const sh = Math.max(0, Math.min(1, (p - 0.25) / 0.35));
  if (sh > 0) shadow(ctx, x, y + 1, Math.max(1, Math.round(7 * sh)), 1, 0.3 * sh);
  // The body: in colour once it has a shape, the white silhouette over it fading as it lands.
  if (p > 0.22) {
    const { sx, sy, dy } = summonShape(p);
    const feet = y + dy;
    const lit = litFarmGrid(def, rows);
    drawGridScaled(ctx, lit.rows, lit.palette, x, feet, sx, sy, facing === -1);
    const white = p < 0.62 ? 1 : Math.max(0, 1 - (p - 0.62) / 0.3);
    if (white > 0) {
      // The white silhouette breaks up pixel by pixel as the colours come through.
      const thinned =
        white >= 1
          ? rows
          : rows.map((row, ry) =>
              [...row]
                .map((k2, rx2) => (k2 !== "." && bayerAt(rx2, ry) < white ? k2 : "."))
                .join(""),
            );
      drawGridScaled(ctx, thinned, silhouette(def), x, feet, sx, sy, facing === -1);
    }
  }
  // A few petals scattering as it lands.
  if (p > 0.5 && p < 0.95) {
    const k = (p - 0.5) / 0.45;
    for (let i = 0; i < 6; i++) {
      if (((i * 5) % 6) / 6 < k) continue;
      const a = -Math.PI * (0.15 + (i / 5) * 0.7);
      const r = 4 + k * 10;
      const sway = Math.sin(now / 200 + i) * 1;
      ctx.fillStyle = SUMMON_PETALS[i % SUMMON_PETALS.length] ?? "#ffffff";
      ctx.fillRect(
        Math.round(x + Math.cos(a) * r + sway),
        Math.round(y - 8 + Math.sin(a) * r * 0.8 + k * k * 10),
        1,
        1,
      );
    }
    ctx.globalAlpha = 1;
  }
}

/** The widest a speech bubble's text runs before it wraps onto a second line (pixels). */
export const BUBBLE_TEXT_MAX = 104;

/** GG Royale's speech bubble: blue-white paper, ink outline, a shaded lip. */
const BUBBLE = { ink: "#1e0c1f", paper: "#cedbf9", shade: "#a9b8e4", text: "#1e0c1f" };

/**
 * A speech bubble in GG Royale's style, its tail pointing down at (cx, top):
 * m5x7 text on blue-white paper with a 1px ink outline and rounded corners,
 * a 2px shade along the bottom and a thick ink lip under it, and a tail that
 * runs out of the shade through the lip.
 */
function drawBubble(ctx: Ctx, text: string, cx: number, top: number, mapWidth: number): void {
  const lines = wrapText(text, BUBBLE_TEXT_MAX);
  const w = Math.max(...lines.map(textWidth)) + 8;
  const h = lines.length * LINE_PITCH - 1 + 5;
  const x = Math.min(mapWidth - w - 2, Math.max(2, Math.round(cx - w / 2)));
  const y = Math.round(top - h - 6);
  // The tail stays under the bubble even where the bubble is pushed off-centre.
  const tx = Math.min(x + w - 5, Math.max(x + 4, Math.round(cx)));
  const { ink, paper, shade } = BUBBLE;
  // Outline and lip: ink one pixel round the paper and three under it, with
  // the outer corners cut.
  ctx.fillStyle = ink;
  ctx.fillRect(x, y - 1, w, h + 4);
  ctx.fillRect(x - 1, y, w + 2, h + 2);
  // Paper, with a 2px shade along its bottom, and its corners rounded off.
  ctx.fillStyle = paper;
  ctx.fillRect(x, y, w, h - 2);
  ctx.fillStyle = shade;
  ctx.fillRect(x, y + h - 2, w, 2);
  ctx.fillStyle = ink;
  ctx.fillRect(x, y, 1, 1);
  ctx.fillRect(x + w - 1, y, 1, 1);
  ctx.fillRect(x, y + h - 1, 1, 1);
  ctx.fillRect(x + w - 1, y + h - 1, 1, 1);
  // Tail: the shade runs down through the lip, ringed in ink, to a point.
  const yb = y + h;
  ctx.fillRect(tx - 3, yb, 7, 1);
  ctx.fillRect(tx - 2, yb + 1, 5, 2);
  ctx.fillRect(tx - 1, yb + 3, 3, 1);
  ctx.fillRect(tx, yb + 4, 1, 1);
  ctx.fillStyle = shade;
  ctx.fillRect(tx - 2, yb, 5, 1);
  ctx.fillRect(tx - 1, yb + 1, 3, 1);
  ctx.fillRect(tx, yb + 2, 1, 2);
  lines.forEach((line, i) => {
    // Each line centred in the bubble.
    const lx = x + Math.floor((w - textWidth(line)) / 2);
    drawText(ctx, line, lx, y + 3 + i * LINE_PITCH, BUBBLE.text);
  });
}

/** Ken's thought marks: 5×7 glyphs drawn in his little thought bubble. */
const MARK_GLYPHS: Readonly<
  Record<Exclude<KenMark, "thinking">, ReadonlyArray<readonly [number, number, readonly string[]]>>
> = {
  question: [[7, 3, [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."]]],
  problem: [[8, 3, ["##", "##", "##", "##", "..", "##"]]],
  waiting: [[6, 3, ["#####", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#####"]]],
  asleep: [
    [4, 5, ["###", "..#", ".#.", "#..", "###"]],
    [10, 3, ["###", "..#", ".#.", "#..", "###"]],
  ],
};
const MARK_W = 18;
const MARK_H = 15;

function inMarkBubble(x: number, y: number): boolean {
  if (x < 1 || x > 16 || y < 1 || y > 11) return false;
  return !((x === 1 || x === 16) && (y === 1 || y === 11));
}
function inMarkTail(x: number, y: number): boolean {
  return (y === 12 && (x === 3 || x === 4)) || (y === 13 && x === 3);
}

/**
 * Ken's thought bubble: a small rounded bubble up and to the right of his
 * crown, its tail pointing down at him, holding what he's at (dots while he
 * thinks, an hourglass while he waits, ? for a question, ! for a problem, Zz
 * while paused). The dots take turns lighting up; with `still`, they rest.
 */
function drawKenMark(
  ctx: Ctx,
  mark: KenMark,
  px: number,
  top: number,
  mapWidth: number,
  now: number,
  still: boolean,
): void {
  const x0 = Math.min(mapWidth - MARK_W - 1, Math.max(1, Math.round(px)));
  const y0 = Math.max(1, Math.round(top) - 5 - 13);
  const fill = (x: number, y: number): boolean => inMarkBubble(x, y) || inMarkTail(x, y);
  for (let y = 0; y < MARK_H; y++) {
    for (let x = 0; x < MARK_W; x++) {
      if (fill(x, y))
        ctx.fillStyle = fill(x, y + 1) || !inMarkBubble(x, y) ? BUBBLE.paper : BUBBLE.shade;
      else if (fill(x - 1, y) || fill(x + 1, y) || fill(x, y - 1) || fill(x, y + 1)) {
        ctx.fillStyle = BUBBLE.ink;
      } else continue;
      ctx.fillRect(x0 + x, y0 + y, 1, 1);
    }
  }
  if (mark === "thinking") {
    const lit = still ? -1 : Math.floor(now / 420) % 3;
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i === lit || still ? BUBBLE.ink : BUBBLE.shade;
      ctx.fillRect(x0 + 4 + i * 4, y0 + 6, 2, 2);
    }
    return;
  }
  ctx.fillStyle = BUBBLE.ink;
  for (const [gx, gy, rows] of MARK_GLYPHS[mark]) {
    rows.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++) {
        if (row[dx] === "#") ctx.fillRect(x0 + gx + dx, y0 + gy + dy, 1, 1);
      }
    });
  }
}

// ── The critters ──────────────────────────────────────────────

interface Placed {
  readonly y: number;
  readonly draw: () => void;
  /** For something on the ground that props can hide: its body box (map pixels). */
  readonly body?: { readonly x0: number; readonly y0: number; readonly x1: number };
}

/** A standing prop ready to redraw over whatever passes behind it. */
export interface OccluderCanvas {
  readonly image: CanvasImageSource;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly base: number;
}

/**
 * Each standing prop as its own canvas (flipped as placed), once per farm or
 * per change of light and weather. `pixels` gives a prop's look for the
 * moment (graded, snowed on, wet); by default its plain sprite.
 */
export function paintOccluders(
  farm: Farm,
  pixels: (o: Farm["occluders"][number]) => PixelBuffer = (o) => o.buf,
): OccluderCanvas[] {
  return farm.occluders.map((o) => {
    const buf = pixels(o);
    const canvas = document.createElement("canvas");
    canvas.width = o.buf.width;
    canvas.height = o.buf.height;
    const c = canvas.getContext("2d");
    if (c) {
      if (o.flip) {
        c.translate(o.buf.width, 0);
        c.scale(-1, 1);
      }
      const tmp = document.createElement("canvas");
      tmp.width = o.buf.width;
      tmp.height = o.buf.height;
      tmp.getContext("2d")?.putImageData(buf.toImageData(), 0, 0);
      c.drawImage(tmp, 0, 0);
    }
    return { image: canvas, x: o.x, y: o.y, w: o.buf.width, h: o.buf.height, base: o.base };
  });
}

function actorItems(
  ctx: Ctx,
  world: FarmWorld,
  actor: Actor,
  now: number,
  out: Placed[],
  late: Array<() => void>,
  night: number,
  lanterns: FarmLamp[],
  bodies: LitBody[],
  play: FarmPlay | null,
  ambientNow: number,
): void {
  const def = critterDef(actor.critterId);
  const poked = reactionOn(play, `actor:${actor.key}`, now);
  const pk = poked ? progress(poked, now) : 0;
  let x = actor.spot.x;
  let y = actor.spot.y;
  let facing = actor.facing;
  let alpha = 1;
  const mode = actor.trip?.mode ?? null;
  if (actor.trip) {
    const pose = tripPose(actor.trip, now, actor.facing);
    x = pose.x;
    y = pose.y;
    facing = pose.facing;
  }
  // Arriving: summoned in at the gate (drawSummon). Leaving: a moment at the
  // gate, then the same in reverse. `summon` runs 0 (nothing) → 1 (standing).
  let summon = 1;
  if (actor.state === "arriving") summon = Math.min(1, (now - actor.stateAt) / ARRIVE_MS);
  if (actor.state === "leaving") {
    const raw = (now - actor.stateAt) / LEAVE_MS;
    summon = raw < 0.4 ? 1 : Math.max(0, 1 - (raw - 0.4) / 0.6);
  }
  if (actor.state === "leaving" && summon <= 0) alpha = 0;
  if (alpha <= 0) return;
  // Feet alternate in step with the pace: an easy walk, a quicker jog.
  const step = mode === "run" ? 120 : 190;
  const footing = mode ? Math.floor(now / step) % 2 : 0;
  // A jog bobs a pixel on each stride.
  const bob = mode === "run" && footing ? 1 : 0;
  const working = actor.state === "working" && actor.doing !== null;
  const width = world.farm.width;
  // Snap to whole pixels, so a slow walk doesn't shimmer between them.
  const px = Math.round(x);
  const py = Math.round(y);

  out.push({
    y,
    body: { x0: px - CRITTER / 2, y0: py - CRITTER_H, x1: px + CRITTER / 2 },
    draw: () => {
      const rows = frameRows(def, footing as 0 | 1);
      if (summon < 1) {
        drawSummon(ctx, def, rows, px, py, facing, summon, now);
        // A newcomer speaks once it has landed.
        if (
          actor.state === "arriving" &&
          summon > 0.8 &&
          actor.bubble &&
          actor.bubble.until > now
        ) {
          const { text } = actor.bubble;
          late.push(() => drawBubble(ctx, text, px, py - CRITTER_H, width));
        }
        return;
      }
      shadow(ctx, px, py + 1, 7, 1, 0.3 * alpha);
      // A poke: a hop, a spin (turning to face the other way and back), or a wave (a little bob).
      const hop =
        poked?.action === "jump"
          ? Math.round(6 * arc(Math.min(1, pk / 0.5)))
          : poked?.action === "wave"
            ? Math.floor(now / 160) % 2
            : 0;
      const turned = poked?.action === "spin" && Math.floor(pk * 4) % 2 === 1 ? -facing : facing;
      const left = px - CRITTER / 2;
      const top = py - CRITTER_H - bob - hop;
      ctx.globalAlpha = alpha;
      // GG Goals stands apart: a gold ring on the ground round its feet.
      if (actor.coordinator) drawKenRing(ctx, px, py, now);
      const lit = litFarmGrid(def, rows);
      drawGrid(ctx, lit.rows, lit.palette, left, top, turned === -1);
      // Lamplight falls on it as a figure standing at its feet (see LitBody).
      bodies.push({ x0: left, y0: top, rows, flip: turned === -1, feet: py });
      if (poked?.action === "jump" && pk < 0.6) {
        ctx.fillStyle = "#2a1406";
        ctx.fillRect(px - 1, top - 9, 3, 5);
        ctx.fillStyle = "#ffd060";
        ctx.fillRect(px, top - 8, 1, 2);
        ctx.fillRect(px, top - 5, 1, 1);
      }
      if (poked?.action === "heart" || poked?.action === "wave") {
        drawHeart(ctx, px + 4, top - 4 - pk * 10);
      }
      if (actor.coordinator) {
        drawKenCrown(ctx, px, top, now);
        drawNameplate(ctx, "KEN", px, py + 3);
      }
      if (working && actor.doing) {
        drawFarmWork(ctx, actor.doing, px, py, facing, now, world.farm.lookAt[actor.station]);
      }
      // After dark, a paper lantern: held out in front while walking, set down
      // beside it at the ground while it works (its hands are busy).
      if (night > 0.05 && alpha > 0.5) {
        // Carried, it hangs from a short pole held out in front, swinging with
        // each stride; set down, it stands on the ground at its side.
        const held = !working;
        const swing = held && mode ? Math.floor(now / (mode === "run" ? 120 : 190)) % 2 : 0;
        const lx = held ? px + facing * (8 + swing) : px - facing * 8;
        const ly = held ? py - 10 - bob - hop + swing : py - 7;
        const glow = drawChochin(ctx, lx, ly, held, night, now, {
          x: px + facing * 4,
          y: py - 6 - bob - hop,
        });
        // Its light is cut out of the night's dark like every lamp's (see
        // drawLitOverlay): on the ground just in front of its feet, as high
        // up as the lantern's paper.
        const lz = Math.max(1, py + 1 - glow.y);
        lanterns.push({
          x: glow.x,
          y: py + 1,
          z: lz,
          r: Math.hypot(LANTERN_REACH, lz),
          strength: LANTERN_STRENGTH,
        });
      }
      ctx.globalAlpha = 1;
      // Speech goes on top of the light and weather, so it stays readable at night.
      // A poked critter says what it's doing; GG Goals sums up the goal.
      const pokeText =
        poked?.action === "wave"
          ? actor.detail || actor.name
          : poked?.action === "summary"
            ? summaryOf(world)
            : null;
      if (pokeText) {
        late.push(() =>
          drawBubble(ctx, clip(pokeText), px, top - (actor.coordinator ? 4 : 0), width),
        );
      } else if (actor.bubble && actor.bubble.until > now) {
        const { text } = actor.bubble;
        late.push(() => drawBubble(ctx, text, px, top - (actor.coordinator ? 4 : 0), width));
      } else if (actor.mark && !actor.trip) {
        // Nothing being said: Ken's thought mark, once he's where he's going.
        const { mark } = actor;
        late.push(() => drawKenMark(ctx, mark, px, top, width, now, ambientNow === 0));
      }
    },
  });
}

// ── The farm's own life ───────────────────────────────────────

function ambientItems(
  ctx: Ctx,
  farm: Farm,
  now: number,
  out: Placed[],
  play: FarmPlay | null,
  frameNow: number,
  late: Array<() => void>,
): void {
  const { ambient } = farm;
  const s = now / 1000;
  const fireOut = farm.things.some((t) => t.kind === "campfire" && play?.lightsOff.has(t.id));
  // Just relit: the flames grow up out of the embers over a moment, instead
  // of popping in whole (they used to appear under the flare, looking as if
  // the fire had started behind the stones).
  const relit = play?.reactions.find((r) => r.kind === "campfire" && r.action === "on");
  const grow = relit ? Math.min(1, Math.max(0, (frameNow - relit.start) / FIRE_GROW_MS)) : 1;

  // The campfire: flames that flicker and lick, embers drifting up.
  out.push({
    y: ambient.fire.y + 1,
    draw: () => {
      const { x, y } = ambient.fire;
      const t = Math.floor(now / 110);
      if (fireOut) {
        // Just embers, glowing on and off in the ash.
        for (let i = 0; i < 6; i++) {
          if (Math.floor(now / 300 + i * 1.7) % 3 === 0) continue;
          ctx.fillStyle = i % 2 ? "#ff6a1a" : "#c8441a";
          ctx.fillRect(Math.round(x) - 3 + ((i * 5) % 7), Math.round(y) - 1 + (i % 2), 1, 1);
        }
        return;
      }
      // Flames lick up round the pot, which hangs low in them (it's drawn
      // again over the flames, so the fire is under and around it, not over
      // it). Low and wide: they wrap the pot's belly, never towering over it.
      const rows = Math.max(1, Math.round(8 * grow));
      for (let row = 0; row < rows; row++) {
        const k = row / 8;
        const sway = Math.round(Math.sin(t * 0.9 + row * 0.7) * k * 1.6);
        const half = Math.max(0, Math.round((1 - k) * 6 + ((t + row) % 3 === 0 ? 1 : 0)));
        if (row > 5 && (t + row) % 2 === 0) continue;
        for (let dx = -half; dx <= half; dx++) {
          ctx.fillStyle = k > 0.62 ? "#ffd060" : Math.abs(dx) < half - 1 ? "#ffe8a0" : "#ff8a2a";
          ctx.fillRect(Math.round(x) + dx + sway, Math.round(y) - 2 - row, 1, 1);
        }
      }
      drawFirePot(
        (px, py, color) => {
          ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
          ctx.fillRect(Math.round(px), Math.round(py), 1, 1);
        },
        Math.round(x),
        Math.round(y),
      );
      // Sparks rise past the pot, off either side of it.
      for (let i = 0; i < 4; i++) {
        const life = (s * 0.9 + i * 0.27) % 1;
        const ex = x + (i % 2 ? 5 : -5) + Math.sin(s * 2 + i * 2.1) * 2;
        const ey = y - 8 - life * 16;
        ctx.globalAlpha = 1 - life;
        ctx.fillStyle = i % 2 ? "#ffd060" : "#ff8a2a";
        ctx.fillRect(Math.round(ex), Math.round(ey), 1, 1);
      }
      ctx.globalAlpha = 1;
    },
  });

  // Steam curling up off the kettle and the stove's pots.
  for (const [i, p] of ambient.steam.entries()) {
    out.push({
      y: p.y + 0.5,
      draw: () => {
        for (let k = 0; k < 4; k++) {
          const life = (s * 0.55 + k * 0.25 + i * 0.13) % 1;
          const px = p.x + Math.sin(life * 5 + i) * 2.4 + life * 3;
          const py = p.y - life * 22;
          const r = 1.4 + life * 2.2;
          ctx.globalAlpha = 0.5 * (1 - life);
          ctx.fillStyle = "#ffffff";
          for (let dy = -Math.round(r); dy <= Math.round(r); dy++) {
            const half = Math.round(Math.sqrt(Math.max(0, r * r - dy * dy)));
            ctx.fillRect(Math.round(px) - half, Math.round(py) + dy, half * 2 + 1, 1);
          }
        }
        ctx.globalAlpha = 1;
      },
    });
  }

  // Koi gliding slow loops in the pond.
  const { pond, spout } = ambient;
  // Everything on the water is drawn just after the pond itself, so the pond
  // (redrawn over critters behind it) never covers its own ripples and koi.
  const surfaceDepth = waterDepth(farm);
  // Rings spreading from where the spout's water lands, fading as they grow:
  // each a lit arc along its far side and a dark one along its near side, so
  // it reads as a ridge on the water whatever the water's shade.
  out.push({
    y: surfaceDepth + 0.01,
    draw: () => {
      for (let k = 0; k < 3; k++) {
        const p = (s * 0.55 + k / 3) % 1;
        const rx = 3 + p * 11;
        const ry = rx * 0.42;
        // Pixel art doesn't fade with transparency: an older ring thins out instead.
        const keep = 1 - p * 0.85;
        const steps = Math.round(rx * 5);
        for (let i = 0; i < steps; i++) {
          if (((i * 7 + k * 3) % 10) / 10 >= keep) continue;
          const a = (i / steps) * Math.PI * 2;
          const far = Math.sin(a) < 0;
          const px = Math.round(spout.pour.x + 1 + Math.cos(a) * rx);
          const py = Math.round(spout.pour.y + Math.sin(a) * ry);
          if (farm.surface[py * farm.width + px] !== SURFACE.water) continue;
          ctx.fillStyle = far ? WATER_HEX.foam : WATER_HEX.crack;
          ctx.fillRect(px, py, 1, 1);
        }
      }
    },
  });
  // The water falling from the spout, flowing down its column, splashing.
  out.push({
    y: surfaceDepth + 0.02,
    draw: () => {
      const { mouth, pour } = spout;
      const phase = Math.floor(now / 70);
      for (let y = mouth.y + 1; y < pour.y; y++) {
        const k = (((y - phase) % 3) + 3) % 3;
        ctx.fillStyle = WATER_HEX.light;
        ctx.fillRect(mouth.x, y, 1, 1);
        ctx.fillStyle = k === 0 ? WATER_HEX.pale : WATER_HEX.foam;
        ctx.fillRect(mouth.x + 1, y, 1, 1);
        ctx.fillStyle = k === 2 ? WATER_HEX.light : WATER_HEX.mid;
        ctx.fillRect(mouth.x + 2, y, 1, 1);
      }
      ctx.fillStyle = WATER_HEX.foam;
      ctx.fillRect(mouth.x - 1, pour.y - 1, 5, 2);
      // Droplets thrown up by the splash.
      const hop = Math.floor(now / 120) % 4;
      ctx.fillStyle = WATER_HEX.pale;
      ctx.fillRect(mouth.x - 2 - (hop >> 1), pour.y - 1 - (hop % 2), 1, 1);
      ctx.fillRect(mouth.x + 4 + (hop >> 1), pour.y - 2 + (hop % 2), 1, 1);
    },
  });
  // Frightened koi dart ahead round their loops (see koiClock).
  const ks = (now === 0 ? 0 : koiClock(play, now)) / 1000;
  for (let i = 0; i < 2; i++) {
    out.push({
      y: surfaceDepth + 0.015,
      draw: () => {
        const a = ks * (i === 0 ? 0.42 : -0.33) + i * 2.6;
        const kx = pond.x + Math.cos(a) * pond.rx * (i === 0 ? 0.62 : 0.4);
        const ky = pond.y + Math.sin(a) * pond.ry * (i === 0 ? 0.55 : 0.4);
        // Heading right when the loop carries it right (the sprite faces left).
        const right = Math.cos(a + (i === 0 ? Math.PI / 2 : -Math.PI / 2)) > 0;
        // The tail flicks: its last column shifts a row every beat.
        const flick = Math.floor(now / 260) % 2;
        const x = Math.round(kx - (KOI[0]?.length ?? 0) / 2);
        const y = Math.round(ky - KOI.length / 2);
        drawGrid(ctx, KOI, KOI_HEX, x, y, right);
        if (flick) {
          // The tail fin sweeps a pixel out to one side.
          ctx.fillStyle = KOI_HEX.f;
          ctx.fillRect(right ? x : x + (KOI[0]?.length ?? 1) - 1, y + 3, 1, 3);
        }
      },
    });
  }

  // Petals drifting down from the blossom onto the ground in front of the
  // trunk, swaying as they fall; each lies there a while, then is gone.
  for (const [i, tree] of ambient.blossoms.entries()) {
    const base = tree.y + tree.r * 1.5;
    for (let k = 0; k < 3; k++) {
      const period = 9 + hash(i, k, 61) * 5;
      const at = s / period + hash(i, k, 62);
      const cycle = Math.floor(at);
      const life = at - cycle;
      const lx = tree.x + (hash(cycle, k + i * 7, 63) - 0.5) * tree.r * 2.2;
      const ly = base - 1 + hash(cycle, k + i * 7, 64) * 9;
      const rest = restingSpot(farm, lx, ly);
      if (!rest) continue;
      const color = k % 2 ? "#fbd8e0" : "#f2b6c6";
      const fall = 0.4;
      if (life < fall) {
        const q = life / fall;
        const px = rest.spot.x + Math.sin(q * 9 + k) * 4 * (1 - q) - (1 - q) * 6;
        const py = tree.y - tree.r * 0.3 + (rest.spot.y - tree.y + tree.r * 0.3) * q;
        out.push({
          y: rest.spot.y + 0.3,
          draw: () => {
            ctx.fillStyle = color;
            ctx.fillRect(Math.round(px), Math.round(py), Math.floor(now / 300 + k) % 2 ? 2 : 1, 1);
          },
        });
      } else if (life < 0.96) {
        out.push({
          y: rest.spot.y - 0.5,
          draw: () => {
            ctx.fillStyle = color;
            ctx.fillRect(rest.spot.x, rest.spot.y, 1, 1);
            ctx.fillStyle = shadeOf(color);
            ctx.fillRect(rest.spot.x + 1, rest.spot.y, 1, 1);
          },
        });
      }
    }
  }

  // The cat and the hens, each wandering its own loop (paused while it
  // reacts to a poke). A hen pecks while she stands; legs move only while walking.
  for (const { id, roamer, pose } of roamersNow(farm, play, now)) {
    const r = reactionOn(play, id, frameNow);
    const look =
      roamer.kind === "cat" ? catLook(pose, r, frameNow) : henLook(pose, r, frameNow, roamer.seed);
    const w = look.rows[0]?.length ?? 0;
    out.push({
      y: pose.y,
      body: { x0: look.x - w / 2, y0: look.y - look.rows.length + 2, x1: look.x + w / 2 },
      draw: () => {
        drawLook(ctx, look, pose.y);
        if (r?.action === "groom" && Math.floor(frameNow / 200) % 2) {
          ctx.fillStyle = "#fff8d0";
          ctx.fillRect(Math.round(pose.x + pose.facing * 6), Math.round(pose.y - 6), 1, 1);
        }
        if (r?.action === "roll" && progress(r, frameNow) > 0.3) {
          drawHeart(ctx, pose.x, pose.y - 18 - progress(r, frameNow) * 6);
        }
      },
    });
    if (look.say) {
      const text = look.say;
      late.push(() => drawBubble(ctx, text, look.x, look.y - look.rows.length, farm.width));
    }
  }

  // The shiba by its kennel: asleep (snoring now and then) until it's poked.
  {
    const r = reactionOn(play, "shiba", frameNow);
    const look = shibaLook(ambient.shiba, r, frameNow);
    out.push({
      y: ambient.shiba.y + 0.5,
      body: {
        x0: look.x - (look.rows[0]?.length ?? 0) / 2,
        y0: look.y - look.rows.length + 2,
        x1: look.x + (look.rows[0]?.length ?? 0) / 2,
      },
      draw: () => {
        drawLook(ctx, look, ambient.shiba.y);
        if (!r) {
          const q = (s * 0.35) % 1;
          if (q < 0.6) drawZ(ctx, ambient.shiba.x - 9 + q * 4, ambient.shiba.y - 14 - q * 10);
        }
        if (r?.action === "wag") {
          const q = progress(r, frameNow);
          drawHeart(ctx, ambient.shiba.x + 4, ambient.shiba.y - 16 - q * 8);
        }
      },
    });
    if (look.say) {
      const text = look.say;
      late.push(() => drawBubble(ctx, text, look.x, look.y - look.rows.length, farm.width));
    }
  }

  // Butterflies flitting about the flowers, wings beating.
  for (let i = 0; i < ambient.butterflies.length; i++) {
    const home = ambient.butterflies[i] ?? farm.origin;
    const b = butterflyAt(farm, play, i, now, frameNow);
    out.push({
      y: home.y + 40,
      draw: () => drawButterfly(ctx, b.x, b.y, i, b.open),
    });
  }

  // The dragonfly, hovering in figure-eights over the water.
  const d = dragonflyAt(farm, play, now, frameNow);
  out.push({
    y: ambient.dragonfly.y + 60,
    draw: () => drawDragonfly(ctx, d.x, d.y, d.flap),
  });
}

/** A grid's colours as canvas fill styles. */
function hexPalette(colors: Readonly<Record<string, number>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(colors).map(([k, c]) => [k, `#${c.toString(16).padStart(6, "0")}`]),
  );
}

const SHADOW_HEX: Record<string, string> = Object.fromEntries(
  [...new Set([...CAT_STEP_A, ...HEN_STAND, ...HEN_WALK, ...HEN_PECK].join(""))].map((k) => [
    k,
    "#2a1406",
  ]),
);

/** Butterfly wings: lit, base and the dark vein edge, per kind. */
const BUTTERFLY_WINGS: ReadonlyArray<readonly [string, string, string]> = [
  ["#ffffff", "#ece2c8", "#a8987a"],
  ["#fbe27a", "#e8b838", "#9a6a1a"],
  ["#ffc07a", "#e8823a", "#9a4a1a"],
  ["#e2f2fa", "#a8cce0", "#5a7a94"],
];
const INSECT_INK = "#2a1406";

/**
 * A butterfly from above, drawn like GG Royale's small props: an ink body,
 * forewings and hindwings each lit on their upper edge with a darker vein
 * line at the trailing edge, open or folded up.
 */
function drawButterfly(ctx: Ctx, x: number, y: number, kind: number, open: number): void {
  const [lit, wing, vein] = BUTTERFLY_WINGS[kind % BUTTERFLY_WINGS.length] ?? [
    "#ffffff",
    "#ece2c8",
    "#a8987a",
  ];
  const px = Math.round(x);
  const py = Math.round(y);
  const dot = (dx: number, dy: number, c: string): void => {
    ctx.fillStyle = c;
    ctx.fillRect(px + dx, py + dy, 1, 1);
  };
  if (open) {
    // Forewings (bigger, up), hindwings (smaller, down), each side.
    for (const side of [-1, 1] as const) {
      const fx = side < 0 ? -3 : 1;
      dot(fx, -2, lit);
      dot(fx + 1, -2, lit);
      dot(fx, -1, wing);
      dot(fx + 1, -1, wing);
      dot(side < 0 ? fx : fx + 1, 0, vein);
      dot(side < 0 ? -2 : 1, 1, wing);
      dot(side < 0 ? -2 : 1, 2, vein);
    }
  } else {
    // Folded up over the back: a single lit blade each side.
    dot(-1, -3, lit);
    dot(-1, -2, wing);
    dot(1, -3, lit);
    dot(1, -2, wing);
    dot(-1, -1, vein);
    dot(1, -1, vein);
  }
  // The body, over the wings.
  ctx.fillStyle = INSECT_INK;
  ctx.fillRect(px, py - 2, 1, 4);
}

/**
 * A dragonfly from above: a long blue body, lit along its back, darker at the
 * tail tip, with a big-eyed head; two pairs of glassy wings, lit along their
 * leading edge, beating.
 */
function drawDragonfly(ctx: Ctx, x: number, y: number, flap: number): void {
  const px = Math.round(x);
  const py = Math.round(y);
  // Wings, under the body.
  const glass = flap ? "#e8f4ff" : "#cfe2f4";
  const edge = flap ? "#ffffff" : "#e8f4ff";
  for (const [wx, wy] of [
    [-2, -2 + flap],
    [1, -2 + flap],
    [-2, 1 - flap],
    [1, 1 - flap],
  ] as const) {
    ctx.fillStyle = glass;
    ctx.fillRect(px + wx, py + wy, 2, 2);
    ctx.fillStyle = edge;
    ctx.fillRect(px + wx, py + wy, 2, 1);
  }
  // The body: lit back, shaded underside, a darker tail tip.
  ctx.fillStyle = "#2a5aa8";
  ctx.fillRect(px - 3, py + 1, 7, 1);
  ctx.fillStyle = "#4a9ae8";
  ctx.fillRect(px - 3, py, 7, 1);
  ctx.fillStyle = "#1a3a78";
  ctx.fillRect(px + 3, py, 2, 1);
  // The head and its two big eyes.
  ctx.fillStyle = "#1a3a78";
  ctx.fillRect(px - 5, py, 2, 1);
  ctx.fillStyle = "#7ac8ff";
  ctx.fillRect(px - 5, py - 1, 1, 1);
  ctx.fillRect(px - 5, py + 1, 1, 1);
}

/**
 * Draw one frame: the cached map, then everything that moves, back to front.
 * `ambientNow` drives the fire, water, petals and animals; pass a fixed value
 * to hold them still (reduced motion).
 */
/**
 * The look being faded out while a new one fades in (a change of the hour's
 * light, the weather, or what lies on the ground), and how far along (0–1).
 * `scratch` is a canvas the two light overlays are blended in, exactly.
 */
export interface FarmFade {
  readonly background: CanvasImageSource;
  readonly occluders: readonly OccluderCanvas[];
  readonly atmosphere: Atmosphere | null;
  readonly t: number;
}

export function drawFarm(
  ctx: Ctx,
  background: CanvasImageSource,
  world: FarmWorld,
  now: number,
  ambientNow = now,
  occluders: readonly OccluderCanvas[] = [],
  atmosphere: Atmosphere | null = null,
  fade: FarmFade | null = null,
  scratch: HTMLCanvasElement | null = null,
  play: FarmPlay | null = null,
): void {
  // The new look under the old one, the old one fading out on top.
  const t = fade ? Math.max(0, Math.min(1, fade.t)) : 1;
  ctx.drawImage(background, 0, 0);
  if (fade && t < 1) {
    ctx.globalAlpha = 1 - t;
    ctx.drawImage(fade.background, 0, 0);
    ctx.globalAlpha = 1;
  }
  if (atmosphere) drawLandings(ctx, world.farm, atmosphere, ambientNow, t);
  // What a poke knocked loose, lying where it landed (under anything standing).
  if (play) drawDebrisResting(ctx, play, now);
  if (fade?.atmosphere && t < 1) drawLandings(ctx, world.farm, fade.atmosphere, ambientNow, 1 - t);
  const items: Placed[] = [];
  // Not mid-fade between two looks: the copy matches only the new one, so a
  // tree swaying then sways over itself for those few seconds.
  if (play && (!fade || t >= 1)) clearSwaying(ctx, world.farm, play, now, occluders, items);
  const late: Array<() => void> = [];
  ambientItems(ctx, world.farm, ambientNow, items, play, now, late);
  if (play) {
    playItems(ctx, world, play, now, occluders, items, late, atmosphere?.puddles ?? null);
  }
  // How dark it is: critters carry lanterns once the lamps are coming on.
  const night = Math.min(1, Math.max(0, ((atmosphere?.sky.lamps ?? 0) - 0.4) / 0.5));
  const lanterns: FarmLamp[] = [];
  const bodies: LitBody[] = [];
  for (const actor of world.actors.values()) {
    actorItems(ctx, world, actor, now, items, late, night, lanterns, bodies, play, ambientNow);
  }
  // A prop standing in front of someone (its base lower on the map than
  // their feet) is redrawn over them, so they pass behind it. The same for
  // anything redrawn by a poke (a tree shaking), so it stays behind.
  occluders.forEach((o, index) => {
    const hides = items.some(
      (it) =>
        it.body !== undefined &&
        it.y < o.base &&
        it.body.x1 > o.x &&
        it.body.x0 < o.x + o.w &&
        it.y > o.y &&
        it.body.y0 < o.y + o.h,
    );
    if (!hides) return;
    const before = fade && t < 1 ? fade.occluders[index] : undefined;
    items.push({
      y: o.base,
      draw: () => {
        ctx.drawImage(o.image, o.x, o.y);
        if (before) {
          ctx.globalAlpha = 1 - t;
          ctx.drawImage(before.image, before.x, before.y);
          ctx.globalAlpha = 1;
        }
      },
    });
  });
  if (play) hoverItems(ctx, world, play, now, ambientNow, items);
  items.sort((a, b) => a.y - b.y);
  for (const item of items) item.draw();
  const fading = fade !== null && t < 1;
  const from = fading ? (fade?.atmosphere ?? null) : null;
  const overlay = (): void =>
    drawLitOverlay(ctx, world.farm, scratch, from, atmosphere, fading ? t : 1, lanterns, bodies);
  if (from) drawAtmosphere(ctx, world.farm, from, ambientNow, 1 - t, null);
  if (atmosphere) drawAtmosphere(ctx, world.farm, atmosphere, ambientNow, fading ? t : 1, overlay);
  else overlay();
  ctx.globalAlpha = 1;
  for (const draw of late) draw();
}

/** How far a carried lantern's light reaches, and how bright it is, next to the fixed lamps (30, 1). */
const LANTERN_REACH = 22;
const LANTERN_STRENGTH = 0.85;

/**
 * The night's dark over the farm, with every carried lantern lighting it the
 * way the fixed lamps do, and every critter lit as a figure standing where
 * it is (the same falloff, facing, blocking, rings and warmth; see litPatch):
 * the prepared overlay (blended from the old one mid-fade) is copied to
 * `scratch`, each lantern's and lit critter's box is recomputed and written
 * into it, and the result is laid over the scene. With nothing to relight,
 * the prepared overlay is drawn as it is.
 */
function drawLitOverlay(
  ctx: Ctx,
  farm: Farm,
  scratch: HTMLCanvasElement | null,
  from: Atmosphere | null,
  to: Atmosphere | null,
  t: number,
  lanterns: readonly FarmLamp[],
  bodies: readonly LitBody[],
): void {
  const fading = t < 1 && from !== null;
  if (!fading && !to?.overlay) return;
  if (!scratch) {
    if (to?.overlay) ctx.drawImage(to.overlay, 0, 0);
    return;
  }
  const light = to?.light ?? from?.light ?? null;
  const boxes = light ? relightBoxes(light, lanterns, bodies, farm) : [];
  if (!fading && boxes.length === 0) {
    if (to?.overlay) ctx.drawImage(to.overlay, 0, 0);
    return;
  }
  const sc = prepareScratch(
    ctx,
    scratch,
    fading ? (from?.overlay ?? null) : null,
    to?.overlay ?? null,
    fading ? t : 1,
  );
  if (!sc) return;
  for (const box of boxes) {
    const near = lanterns.filter((l) => overlaps(lanternBox(l, farm), box));
    const among = bodies.filter((b) => overlaps(bodyBox(b), box));
    const patch = (a: Atmosphere | null): Uint8ClampedArray | null => {
      const sky = a?.light;
      return sky
        ? cachedPatch(sky, box, near, among, () =>
            litPatch(
              sky,
              near,
              among,
              farm.width,
              farm.height,
              box.x,
              box.y,
              box.w,
              box.h,
              farm.relief,
            ),
          )
        : null;
    };
    const next = patch(to);
    const prev = fading ? patch(from) : null;
    const data = prev ? blendPatches(prev, next, t) : next;
    if (data) sc.putImageData(new ImageData(data, box.w, box.h), box.x, box.y);
  }
  ctx.drawImage(scratch, 0, 0);
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function overlaps(a: Box | null, b: Box): boolean {
  return a !== null && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** A box clipped to the map, or null if nothing of it is left. */
function clipBox(x0: number, y0: number, x1: number, y1: number, w: number, h: number): Box | null {
  const ax = Math.max(0, Math.floor(x0));
  const ay = Math.max(0, Math.floor(y0));
  const bx = Math.min(w, Math.ceil(x1));
  const by = Math.min(h, Math.ceil(y1));
  return bx > ax && by > ay ? { x: ax, y: ay, w: bx - ax, h: by - ay } : null;
}

/**
 * Everything a lamp can light, on the map: the ground round it (squashed for
 * the high camera), and up above, the faces of whatever stands within its
 * reach, as high as they stand (never higher than its flame plus its reach).
 */
function lanternBox(l: FarmLamp, farm: Farm): Box | null {
  const up = Math.min(l.z + l.r, tallestNear(farm.relief, l.x, l.y, l.r));
  return clipBox(
    l.x - l.r,
    l.y - l.r / 1.35 - up,
    l.x + l.r + 1,
    l.y + l.r / 1.35 + 1,
    farm.width,
    farm.height,
  );
}

/**
 * Relit boxes, kept with their prepared light while what's in them stays
 * put: a critter at work with its lantern set down doesn't need relighting
 * every frame. Keyed by the box, the lanterns and the bodies in it.
 */
const PATCH_CACHE_MAX = 96;

function cachedPatch(
  light: SkyLight,
  box: Box,
  lanterns: readonly FarmLamp[],
  bodies: readonly LitBody[],
  make: () => Uint8ClampedArray,
): Uint8ClampedArray {
  const key = [
    box.x,
    box.y,
    box.w,
    box.h,
    ...lanterns.map((l) => `${l.x},${l.y},${l.z},${l.r},${l.strength}`),
    ...bodies.map((b) => `${b.x0},${b.y0},${b.feet},${b.flip ? 1 : 0},${b.rows.join("")}`),
  ].join("|");
  const cache = light.patches;
  const hit = cache.get(key);
  if (hit) return hit;
  const made = make();
  if (cache.size >= PATCH_CACHE_MAX) cache.clear();
  cache.set(key, made);
  return made;
}

function bodyBox(b: LitBody): Box {
  return { x: b.x0, y: b.y0, w: b.rows[0]?.length ?? 0, h: b.rows.length };
}

/**
 * The boxes to relight this frame: every carried lantern's reach, and every
 * critter within reach of a lit lamp or lantern (so it's lit as a figure).
 * No lamps lit, nothing to relight.
 */
function relightBoxes(
  light: SkyLight,
  lanterns: readonly FarmLamp[],
  bodies: readonly LitBody[],
  farm: Farm,
): Box[] {
  if (light.tone.lamps <= 0.02) return [];
  const { width, height } = farm;
  const boxes = lanterns.flatMap((l) => lanternBox(l, farm) ?? []);
  const lamps = [...light.lamps, ...lanterns];
  for (const b of bodies) {
    const box = clipBox(
      b.x0,
      b.y0,
      b.x0 + (b.rows[0]?.length ?? 0),
      b.y0 + b.rows.length,
      width,
      height,
    );
    if (!box) continue;
    const lit = lamps.some((l) => overlaps(lanternBox(l, farm), box));
    if (lit) boxes.push(box);
  }
  return boxes;
}

/** A wooden bucket from the high camera: banded staves, the water inside showing when full. */
/** The well's bucket: water (or its dark inside) at the top, an iron hoop lit on its left, staves lit left to shaded right. */
const WELL_BUCKET = [".ooooo.", "oWWwwwo", "oHHhhho", "oLBbBDo", "oLBbBDo", ".ooooo."];

function drawWellBucket(ctx: Ctx, x: number, y: number, full: boolean): void {
  const colors: Record<string, string> = {
    o: "#2a1406",
    W: full ? WATER_HEX.pale : "#5a3a1e",
    w: full ? WATER_HEX.light : "#4a2e16",
    H: "#9a9aa4",
    h: "#5a5a64",
    L: "#c8904c",
    B: "#a0703a",
    b: "#8a5a2c",
    D: "#64381a",
  };
  WELL_BUCKET.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const color = colors[row[c] ?? "."];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x + c, y + r, 1, 1);
    }
  });
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/** GG Goals' crown, gold and outlined, a red jewel at its front; it glints now and then. */
const KEN_CROWN = [
  "o.o..o..o.o",
  "oYo.oYo.oYo",
  "oYYoYYYoYYo",
  "oYYYYRYYYYo",
  "oyyyyyyyyyo",
  ".ooooooooo.",
];

function drawKenCrown(ctx: Ctx, px: number, top: number, now: number): void {
  const colors: Record<string, string> = {
    o: "#3a1e06",
    Y: "#ffd23a",
    y: "#d99a1a",
    R: "#e8313f",
  };
  const x0 = Math.round(px) - 5;
  const y0 = Math.round(top) - 5;
  KEN_CROWN.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const color = colors[row[c] ?? "."];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x0 + c, y0 + r, 1, 1);
    }
  });
  // A glint running across it every few seconds.
  const g = (now % 3200) / 3200;
  if (g < 0.18) {
    const gx = x0 + 1 + Math.floor((g / 0.18) * 9);
    ctx.fillStyle = "#fffbe0";
    ctx.fillRect(gx, y0 + 2, 1, 2);
  }
}

/** A soft gold ring on the ground round GG Goals' feet, breathing gently. */
function drawKenRing(ctx: Ctx, px: number, py: number, now: number): void {
  const pulse = 0.5 + 0.5 * Math.sin(now / 520);
  const rx = 10;
  const ry = 3;
  ctx.fillStyle = "#ffd23a";
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    // Every other dot, so it reads as a light ring, not a hard line.
    if (i % 2) continue;
    ctx.globalAlpha = 0.45 + 0.35 * pulse;
    ctx.fillRect(Math.round(px + Math.cos(a) * rx), Math.round(py + Math.sin(a) * ry), 1, 1);
  }
  ctx.globalAlpha = 1;
}

/**
 * A name tag under a critter's feet, drawn as GG Royale's name plate (the
 * same tab as on Ken's signs): a gold plate with an ink outline cut at the
 * corners, a pale top lip, a shaded bottom lip and a drop of ink under it,
 * the name in m5x7 ink capitals with a pale line under each stroke.
 */
function drawNameplate(ctx: Ctx, text: string, px: number, y: number): void {
  const w = textWidth(text) + 8;
  const h = 7 + 6;
  const x = Math.round(px - w / 2);
  const INK = "#1e0c1f";
  // The drop: a row of ink under the plate.
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = INK;
  ctx.fillRect(x + 1, y + h, w - 2, 1);
  ctx.globalAlpha = 1;
  // The outline, its corners cut.
  ctx.fillRect(x + 1, y, w - 2, h);
  ctx.fillRect(x, y + 1, w, h - 2);
  // The plate and its lips.
  ctx.fillStyle = "#e9af54";
  ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
  ctx.fillStyle = "#f8d488";
  ctx.fillRect(x + 1, y + 1, w - 2, 1);
  ctx.fillStyle = "#c47a3a";
  ctx.fillRect(x + 1, y + h - 3, w - 2, 2);
  drawText(ctx, text, x + 4, y + 4, "#f8d488");
  drawText(ctx, text, x + 4, y + 3, INK);
}

/** How long a relit campfire's flames take to grow back up from the embers. */
const FIRE_GROW_MS = 600;

/** Two RGBA patches blended `t` of the way from `a` to `b`, premultiplied (as prepareScratch does). */
function blendPatches(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray | null,
  t: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i += 4) {
    const aa = ((a[i + 3] ?? 0) / 255) * (1 - t);
    const ba = b ? ((b[i + 3] ?? 0) / 255) * t : 0;
    const alpha = aa + ba;
    out[i + 3] = Math.round(alpha * 255);
    if (alpha <= 0) continue;
    for (let c = 0; c < 3; c++) {
      out[i + c] = Math.round(((a[i + c] ?? 0) * aa + (b ? (b[i + c] ?? 0) : 0) * ba) / alpha);
    }
  }
  return out;
}

/**
 * Fill `scratch` with the dark `t` of the way from `from` to `to`, blended
 * exactly: premultiplied colour and coverage move in a straight line, so the
 * dark never pulses brighter mid-fade the way two stacked overlays would.
 */
function prepareScratch(
  ctx: Ctx,
  scratch: HTMLCanvasElement,
  from: CanvasImageSource | null,
  to: CanvasImageSource | null,
  t: number,
): CanvasRenderingContext2D | null {
  const { width, height } = ctx.canvas;
  if (scratch.width !== width || scratch.height !== height) {
    scratch.width = width;
    scratch.height = height;
  }
  const sc = scratch.getContext("2d");
  if (!sc) return null;
  sc.globalCompositeOperation = "copy";
  sc.globalAlpha = 1 - t;
  if (from && t < 1) sc.drawImage(from, 0, 0);
  else sc.clearRect(0, 0, width, height);
  sc.globalCompositeOperation = t < 1 ? "lighter" : "copy";
  sc.globalAlpha = t;
  if (to) sc.drawImage(to, 0, 0);
  sc.globalCompositeOperation = "source-over";
  sc.globalAlpha = 1;
  return sc;
}

// ── Time of day and weather ─────────────────────────────────────

/** A drifting tile (cloud shadows, mist), ready to draw. */
export interface DriftTile {
  readonly image: CanvasImageSource;
  readonly size: number;
}

/**
 * The farm's light and weather for the moment, prepared once per change: the
 * light overlay (null in plain daylight) and the drifting tiles. Each frame
 * then costs one overlay image, a few tiles, and a handful of particles.
 */
export interface Atmosphere {
  readonly sky: FarmSky;
  readonly look: WeatherLook;
  readonly overlay: CanvasImageSource | null;
  /** The prepared dark and the fixed lamps' light, for carried lanterns to light too. */
  readonly light: SkyLight | null;
  readonly clouds: DriftTile | null;
  readonly fog: DriftTile | null;
  /** Where puddles lie (rain landing in one rings); map width × height, or null. */
  readonly puddles: Uint8Array | null;
}

const DRIFT_TILE = 192;

/** Prepare the light and weather for a farm (about once a minute; see GoalWorld). */
export function paintAtmosphere(
  farm: Farm,
  sky: FarmSky,
  look: WeatherLook,
  puddles: Uint8Array | null = null,
  lightsOff: ReadonlySet<string> = new Set(),
): Atmosphere {
  const light = skyLight(
    farm.width,
    farm.height,
    sky,
    look,
    litLamps(farm, lightsOff),
    farm.relief,
  );
  return {
    sky,
    look,
    puddles,
    light,
    overlay: light ? canvasOf(light.pixels) : null,
    clouds:
      look.clouds > 0
        ? {
            image: canvasOf(cloudTile(DRIFT_TILE, 0x1a2030, 0.28 * look.clouds, 31)),
            size: DRIFT_TILE,
          }
        : null,
    fog:
      look.fog > 0
        ? {
            image: canvasOf(cloudTile(DRIFT_TILE, 0xf2f6f8, 0.5 * look.fog, 47)),
            size: DRIFT_TILE,
          }
        : null,
  };
}

/** A tile repeated over the whole map, sliding by (dx, dy). */
function drawDrift(
  ctx: Ctx,
  tile: DriftTile,
  width: number,
  height: number,
  dx: number,
  dy: number,
): void {
  const ox = (((dx % tile.size) + tile.size) % tile.size) - tile.size;
  const oy = (((dy % tile.size) + tile.size) % tile.size) - tile.size;
  for (let y = oy; y < height; y += tile.size) {
    for (let x = ox; x < width; x += tile.size)
      ctx.drawImage(tile.image, Math.round(x), Math.round(y));
  }
}

/**
 * Where drop `i` lands in its current fall, and how far through it is. Each
 * drop falls, lands on its own spot, and starts again somewhere else, its
 * timing offset so they never fall in step. Stateless: from the time alone.
 */
function dropCycle(
  i: number,
  s: number,
  period: number,
  width: number,
  height: number,
  salt: number,
): { x: number; y: number; t: number } {
  const p = period * (0.75 + hash(i, 5, salt) * 0.5);
  const at = s + hash(i, 6, salt) * p;
  const cycle = Math.floor(at / p);
  return {
    x: Math.floor(hash(i, cycle, salt + 1) * width),
    y: Math.floor(hash(i, cycle, salt + 2) * height),
    t: (at - cycle * p) / p,
  };
}

/** How far above where it lands a raindrop or snowflake starts (the high camera foreshortens it). */
const RAIN_DROP = 16;
const SNOW_DROP = 24;

/**
 * Rain falling onto the farm: each drop a short slanted streak dropping onto
 * its own spot, then a splash that suits what it hit: a ring on the pond or a
 * puddle, a tiny crown of spray on the ground or a roof, nothing on a wall.
 */
function drawRain(
  ctx: Ctx,
  farm: Farm,
  atmo: Atmosphere,
  s: number,
  count: number,
  phase: Phase,
  k = 1,
): void {
  const { width, height, surface } = farm;
  const FALL = 0.24;
  const SPLASH = 0.24;
  for (let i = 0; i < count; i++) {
    const { x, y, t } = dropCycle(i, s, 0.9, width, height, 21);
    if (t < FALL) {
      if (phase !== "falling") continue;
      const k = 1 - t / FALL;
      const hx = Math.round(x + k * 5);
      const hy = Math.round(y - k * RAIN_DROP);
      // A raindrop as a slanted streak: a bright head catching the light, a
      // cooler body, and a thin tail broken through a dither, falling down
      // to the left like the wind that drives it.
      ctx.globalAlpha = 0.9 * k;
      ctx.fillStyle = "#eef6ff";
      ctx.fillRect(hx, hy, 1, 1);
      ctx.fillStyle = "#b8cce0";
      ctx.fillRect(hx, hy - 1, 1, 1);
      ctx.fillRect(hx + 1, hy - 2, 1, 1);
      if ((i + Math.floor(s * 30)) % 2 === 0) {
        ctx.fillStyle = "#8aa4c0";
        ctx.fillRect(hx + 1, hy - 3, 1, 1);
      }
      continue;
    }
    if (phase !== "landed") continue;
    const u = (t - FALL) / SPLASH;
    if (u >= 1) continue;
    const code = surface[y * width + x] ?? SURFACE.ground;
    if (code === SURFACE.side) continue;
    const ring = code === SURFACE.water || atmo.puddles?.[y * width + x] === 1;
    ctx.globalAlpha = 0.85 * k;
    if (ring) {
      // A ring spreading on the water: its far edge lit by the sky, its near
      // edge a darker trough; it thins out (pixels drop away) as it widens.
      const r = 1 + u * 3;
      const steps = 10;
      for (let j = 0; j < steps; j++) {
        if (((j * 7) % 10) / 10 < u * 0.7) continue;
        const a = (j / steps) * Math.PI * 2;
        const far = Math.sin(a) < 0;
        ctx.fillStyle = far ? "#f0f8ff" : "#6a8aa0";
        ctx.fillRect(Math.round(x + Math.cos(a) * r), Math.round(y + Math.sin(a) * r * 0.5), 1, 1);
      }
    } else if (u < 0.5) {
      // A crown of spray: droplets thrown up and out, lit on top.
      ctx.fillStyle = "#eef6ff";
      ctx.fillRect(x - 1, y - 1, 1, 1);
      ctx.fillRect(x + 1, y - 1, 1, 1);
      ctx.fillRect(x, y - 2, 1, 1);
      ctx.fillStyle = "#8aa4c0";
      ctx.fillRect(x, y, 1, 1);
    } else {
      // The droplets landing out to each side, and a wet dot where it hit.
      ctx.fillStyle = "#b8cce0";
      ctx.fillRect(x - 2, y, 1, 1);
      ctx.fillRect(x + 2, y, 1, 1);
      ctx.fillStyle = "#5a6a7a";
      ctx.globalAlpha = 0.4 * k;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * Snow drifting down onto the farm: each flake sways down onto its own spot.
 * Where it lands on something snow can lie on (the ground, a roof, a stone)
 * it rests a moment and melts in; on a wall or the pond it's simply gone.
 */
function drawSnow(ctx: Ctx, farm: Farm, s: number, count: number, phase: Phase, k = 1): void {
  const { width, height, surface } = farm;
  const FALL = 0.78;
  ctx.fillStyle = "#ffffff";
  for (let i = 0; i < count; i++) {
    const { x, y, t } = dropCycle(i, s, 5, width, height, 23);
    const big = hash(i, 4, 23) < 0.3 ? 2 : 1;
    if (t < FALL) {
      if (phase !== "falling") continue;
      const k = 1 - t / FALL;
      const sway = Math.sin(s * 1.6 + i) * 2.5 * k;
      ctx.globalAlpha = 0.9 * k;
      const fx = Math.round(x + sway + k * 3);
      const fy = Math.round(y - k * SNOW_DROP);
      ctx.fillRect(fx, fy, big, big);
      if (big === 2) {
        // A bigger flake: lit white, a cool shade on its lower right.
        ctx.fillStyle = "#cfe0f0";
        ctx.fillRect(fx + 1, fy + 1, 1, 1);
        ctx.fillStyle = "#ffffff";
      }
      continue;
    }
    if (phase !== "landed") continue;
    const code = surface[y * width + x] ?? SURFACE.ground;
    if (code === SURFACE.side || code === SURFACE.water) continue;
    ctx.globalAlpha = 0.7 * (1 - (t - FALL) / (1 - FALL)) * k;
    ctx.fillRect(x, y, 1, 1);
  }
}

/** Which part of a drop's life to draw: in the air (over everything), or on the ground (under it). */
type Phase = "falling" | "landed";

/**
 * Splashes and settling flakes, drawn on the ground before anyone standing
 * on it, so they sit on the terrain under critters and props, never on top.
 */
function drawLandings(ctx: Ctx, farm: Farm, atmo: Atmosphere, now: number, k = 1): void {
  const { falling, density } = atmo.look;
  if (!falling) return;
  const s = now / 1000;
  const count = Math.min(MAX_FALLING, Math.round((density * farm.width * farm.height) / 10000));
  if (falling === "rain") drawRain(ctx, farm, atmo, s, count, "landed", k);
  else drawSnow(ctx, farm, s, count, "landed", k);
  ctx.globalAlpha = k;
}

/** Most raindrops or snowflakes at once, whatever the map's size: a few thousand 1px rects a frame. */
const MAX_FALLING = 900;

/**
 * The weather and the light, over everything: cloud shadows and mist
 * drifting with the wind, rain or snow falling (stateless: each drop's place
 * comes from the time, so nothing is stored per frame), then the time of
 * day's light overlay, then fireflies glowing on top of the dark.
 */
function drawAtmosphere(
  ctx: Ctx,
  farm: Farm,
  atmo: Atmosphere,
  now: number,
  k = 1,
  overlay: (() => void) | null = () => {
    if (atmo.overlay) ctx.drawImage(atmo.overlay, 0, 0);
  },
): void {
  const { width, height } = farm;
  const s = now / 1000;
  ctx.globalAlpha = k;
  if (atmo.clouds) drawDrift(ctx, atmo.clouds, width, height, s * 7, s * 2.5);
  if (atmo.fog) {
    drawDrift(ctx, atmo.fog, width, height, s * 4, 0);
    ctx.globalAlpha = 0.6 * k;
    drawDrift(ctx, atmo.fog, width, height, -s * 2.5 + 70, 40);
    ctx.globalAlpha = k;
  }
  const { falling, density } = atmo.look;
  if (falling) {
    const count = Math.min(MAX_FALLING, Math.round((density * width * height) / 10000));
    if (falling === "rain") drawRain(ctx, farm, atmo, s, count, "falling", k);
    else drawSnow(ctx, farm, s, count, "falling", k);
    ctx.globalAlpha = k;
  }
  ctx.globalAlpha = 1;
  overlay?.();
  ctx.globalAlpha = k;
  // Fireflies after dark (not in the rain): a soft glow round a bright point, blinking.
  const flies = atmo.look.falling === "rain" ? 0 : atmo.sky.fireflies;
  if (flies > 0.05) {
    const spots = farm.ambient.fireflies;
    const shown = Math.round(spots.length * flies);
    for (let i = 0; i < shown; i++) {
      const home = spots[i];
      if (!home) continue;
      const glow = Math.sin(s * 1.6 + i * 2.3);
      if (glow < 0.1) continue;
      const x = Math.round(home.x + Math.sin(s * 0.5 + i) * 9);
      const y = Math.round(home.y - 6 + Math.sin(s * 0.7 + i * 1.7) * 5);
      ctx.globalAlpha = 0.35 * glow * k;
      ctx.fillStyle = "#d8f070";
      ctx.fillRect(x - 1, y, 3, 1);
      ctx.fillRect(x, y - 1, 1, 3);
      ctx.globalAlpha = Math.min(1, glow * 1.2) * k;
      ctx.fillStyle = "#f4ffb0";
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.globalAlpha = k;
  }
}

// ── Play: poking things ─────────────────────────────────────────

/** Something that can be poked, as it is this frame. */
export interface Target {
  readonly id: string;
  readonly kind: ThingKind;
  readonly name: string;
  /** Front-most wins a click: its base line (flying things sit above everything). */
  readonly depth: number;
  /** Where its reactions centre: an animal's feet, a thing's middle. */
  readonly anchor: Spot;
  readonly contains: (x: number, y: number) => boolean;
  /** Its shape, for the hover glow: a sprite (outline cached by id) or a grid. */
  readonly outline: Outline | null;
}

type Outline =
  | {
      readonly buf: PixelBuffer;
      readonly x: number;
      readonly y: number;
      readonly flip: boolean;
    }
  | {
      readonly rows: readonly string[];
      readonly x: number;
      readonly y: number;
      readonly flip: boolean;
    };

function roamerId(kind: Roamer["kind"], i: number): string {
  return kind === "cat" ? "cat" : `hen-${i}`;
}

/** Each roaming animal where it is now, on its own clock (paused while it reacts). */
function roamersNow(
  farm: Farm,
  play: FarmPlay | null,
  ambientNow: number,
): Array<{ id: string; roamer: Roamer; pose: RoamPose }> {
  return farm.ambient.roamers.map((roamer, i) => {
    const id = roamerId(roamer.kind, i);
    const clock = ambientNow === 0 ? 0 : animalClock(play, id, ambientNow);
    return { id, roamer, pose: roamPose(roamer, clock / 1000) };
  });
}

/** The shiba awake: its eyes open. */
const SHIBA_AWAKE: readonly string[] = SHIBA_ASLEEP.map((row, y) =>
  y === 5 ? `${row.slice(0, 3)}we${row.slice(5)}` : row,
);
/** The shiba's keys folded for lighting (critter-shade.ts): one orange coat, one white. */
const SHIBA_MERGE = { k: "O", l: "o", h: "o", s: "o", c: "w", e: "K", n: "N" } as const;
const SHIBA_MATERIALS = { o: "fur", w: "fur", K: "flat", N: "flat" } as const;
const SHIBA_LIT = {
  asleep: lightAnimal(SHIBA_ASLEEP, SHIBA_COLORS, SHIBA_MERGE, SHIBA_MATERIALS, 53),
  awake: lightAnimal(SHIBA_AWAKE, SHIBA_COLORS, SHIBA_MERGE, SHIBA_MATERIALS, 53),
} as const;

/** Every key of a palette in the shadow's colour (lit grids have their own keys). */
const SHADOWS = new WeakMap<Readonly<Record<string, string>>, Record<string, string>>();
function shadowOf(palette: Readonly<Record<string, string>>): Record<string, string> {
  const have = SHADOWS.get(palette);
  if (have) return have;
  const made = {
    ...SHADOW_HEX,
    ...Object.fromEntries(Object.keys(palette).map((k) => [k, "#2a1406"])),
  };
  SHADOWS.set(palette, made);
  return made;
}

/** How an animal is drawn this frame: its grid, where, which way, squashed or flipped over. */
interface AnimalLook {
  readonly rows: readonly string[];
  readonly palette: Readonly<Record<string, string>>;
  readonly x: number;
  readonly y: number;
  readonly flip: boolean;
  readonly sx: number;
  readonly sy: number;
  /** Lying on its back. */
  readonly upside: boolean;
  readonly say: string | null;
}

/** A hop's height at t (0–1): up and back down. */
const arc = (t: number): number => (t <= 0 || t >= 1 ? 0 : 4 * t * (1 - t));
/** Smoothstep. */
const ease = (t: number): number => {
  const k = Math.max(0, Math.min(1, t));
  return k * k * (3 - 2 * k);
};
/** In over the first `ramp`, held, out over the last `ramp` (0–1). */
const visit = (p: number, ramp: number): number =>
  p < ramp ? ease(p / ramp) : p > 1 - ramp ? ease((1 - p) / ramp) : 1;

function henLook(pose: RoamPose, r: Reaction | null, now: number, seed: number): AnimalLook {
  const step = Math.floor(now / 140) % 2;
  const pecking = !pose.moving && Math.floor(now / 380 + seed) % 4 === 0;
  let lit = pecking ? HEN_LIT.peck : pose.moving && step ? HEN_LIT.walk : HEN_LIT.stand;
  let dy = 0;
  let sy = 1;
  let say: string | null = null;
  if (r) {
    const p = progress(r, now);
    if (r.action === "startle") {
      lit = HEN_LIT.stand;
      dy = -7 * arc(Math.min(1, p / 0.45));
      if (p < 0.7) say = "Bawk!";
    } else if (r.action === "flap") {
      lit = Math.floor(now / 70) % 2 ? HEN_LIT.walk : HEN_LIT.stand;
      dy = -Math.abs(Math.sin(p * Math.PI * 3)) * 3;
    } else if (r.action === "peck") {
      lit = Math.floor(now / 90) % 2 ? HEN_LIT.peck : HEN_LIT.stand;
    } else if (r.action === "egg") {
      // A squat, then up again: the egg is left where she sat (see drawPlay).
      const sit = now - r.start < 1100;
      sy = sit ? 0.82 : 1;
      lit = HEN_LIT.stand;
    }
  }
  return {
    rows: lit.rows,
    palette: lit.palette,
    x: pose.x,
    y: pose.y + dy,
    flip: pose.facing === 1,
    sx: 1,
    sy,
    upside: false,
    say,
  };
}

function catLook(pose: RoamPose, r: Reaction | null, now: number): AnimalLook {
  const step = pose.moving ? Math.floor(now / 160) % 2 : 0;
  let lit = step ? CAT_LIT.b : CAT_LIT.a;
  let sx = 1;
  let sy = 1;
  let dx = 0;
  let dy = 0;
  let upside = false;
  let say: string | null = null;
  if (r) {
    const p = progress(r, now);
    lit = CAT_LIT.a;
    if (r.action === "hiss") {
      // Its back arched high, fur on end.
      const k = visit(p, 0.15);
      sx = 1 - 0.14 * k;
      sy = 1 + 0.24 * k;
      if (p > 0.1 && p < 0.85) say = "Hss!";
    } else if (r.action === "groom") {
      sy = 1 - 0.18 * visit(p, 0.12);
    } else if (r.action === "roll") {
      upside = p > 0.15 && p < 0.85;
      sy = upside ? 0.85 : 1;
    } else if (r.action === "pounce") {
      if (p < 0.3) sy = 1 - 0.2 * ease(p / 0.3);
      else {
        const q = (p - 0.3) / 0.7;
        dx = pose.facing * 7 * Math.sin(q * Math.PI);
        dy = -6 * arc(Math.min(1, q / 0.6));
      }
    }
  }
  return {
    rows: lit.rows,
    palette: lit.palette,
    x: pose.x + dx,
    y: pose.y + dy,
    flip: pose.facing === -1,
    sx,
    sy,
    upside,
    say,
  };
}

function shibaLook(at: Spot, r: Reaction | null, now: number): AnimalLook {
  let lit: { rows: string[]; palette: Record<string, string> } = SHIBA_LIT.asleep;
  let dy = 0;
  let dx = 0;
  let upside = false;
  let say: string | null = null;
  if (r) {
    const p = progress(r, now);
    lit = SHIBA_LIT.awake;
    if (r.action === "yawn") {
      if (p > 0.15 && p < 0.65) say = "Yawn~";
      if (p > 0.85) lit = SHIBA_LIT.asleep;
    } else if (r.action === "wag") {
      dx = Math.floor(now / 80) % 2 ? 1 : 0;
    } else if (r.action === "roll") {
      upside = p > 0.15 && p < 0.85;
    } else if (r.action === "woof") {
      dy = -4 * arc(Math.min(1, p / 0.35));
      if (p < 0.75) say = "Woof!";
    }
  }
  return {
    rows: lit.rows,
    palette: lit.palette,
    x: at.x + dx,
    y: at.y + dy,
    flip: false,
    sx: 1,
    sy: 1,
    upside,
    say,
  };
}

/** An animal as its look says, with a contact shadow on the ground under it. */
function drawLook(ctx: Ctx, look: AnimalLook, ground: number): void {
  const rows = look.upside ? [...look.rows].reverse() : look.rows;
  ctx.globalAlpha = 0.26;
  drawGridScaled(ctx, rows, shadowOf(look.palette), look.x - 1, ground + 4, look.sx, 1, look.flip);
  ctx.globalAlpha = 1;
  drawGridScaled(ctx, rows, look.palette, look.x, look.y + 2, look.sx, look.sy, look.flip);
}

/** Where butterfly `i` is: flitting round its flowers, scattering, or come to land. */
function butterflyAt(
  farm: Farm,
  play: FarmPlay | null,
  i: number,
  ambientNow: number,
  now: number,
): { x: number; y: number; open: number } {
  const home = farm.ambient.butterflies[i] ?? farm.origin;
  const s = ambientNow / 1000;
  const k = s * (0.5 + (i % 3) * 0.13) + i * 1.7;
  let x = home.x + Math.sin(k) * 16 + Math.sin(k * 2.3) * 5;
  let y = home.y - 10 + Math.sin(k * 1.4) * 7 + Math.sin(ambientNow / 90 + i) * 1.5;
  let open = Math.floor(now / 110 + i) % 2;
  const r = reactionOn(play, "butterflies", now);
  if (r) {
    const p = progress(r, now);
    if (r.action === "scatter") {
      const spread = 1 + 3 * Math.sin(p * Math.PI);
      x = home.x + (x - home.x) * spread;
      y = home.y - 10 + (y - home.y + 10) * spread - 12 * Math.sin(p * Math.PI);
      open = Math.floor(now / 55 + i) % 2;
    } else if (r.action === "land" && i === 0) {
      const q = visit(p, 0.25);
      x += (r.x - x) * q;
      y += (r.y - 2 - y) * q;
      if (q >= 1) open = Math.floor(now / 700) % 2;
    }
  }
  return { x, y, open };
}

/** Where the dragonfly is: hovering in figure-eights, zipping off, or resting on a lily pad. */
function dragonflyAt(
  farm: Farm,
  play: FarmPlay | null,
  ambientNow: number,
  now: number,
): { x: number; y: number; flap: number } {
  const s = ambientNow / 1000;
  const home = farm.ambient.dragonfly;
  let x = home.x + Math.sin(s * 1.3) * 10;
  let y = home.y + Math.sin(s * 2.6) * 4;
  let flap = Math.floor(now / 60) % 2;
  const r = reactionOn(play, "dragonfly", now);
  if (r) {
    const p = progress(r, now);
    const q = visit(p, 0.2);
    const dest =
      r.action === "land"
        ? { x: farm.ambient.lilyPad.x, y: farm.ambient.lilyPad.y - 2 }
        : {
            x: home.x + (hash(r.seed, 1, 7) - 0.5) * 80,
            y: home.y + (hash(r.seed, 2, 7) - 0.5) * 40,
          };
    x += (dest.x - x) * q;
    y += (dest.y - y) * q;
    if (r.action === "land" && q >= 1) flap = 0;
  }
  return { x, y, flap };
}

/** A critter's feet and facing this frame (as actorItems draws it). */
function actorAt(actor: Actor, now: number): { x: number; y: number; facing: 1 | -1 } {
  if (!actor.trip) return { x: actor.spot.x, y: actor.spot.y, facing: actor.facing };
  const pose = tripPose(actor.trip, now, actor.facing);
  return { x: pose.x, y: pose.y, facing: pose.facing };
}

/** Is (x, y) on a sprite placed with its top-left at (ox, oy)? */
function onSprite(
  buf: PixelBuffer,
  ox: number,
  oy: number,
  flip: boolean,
  x: number,
  y: number,
): boolean {
  const sx = Math.floor(x) - ox;
  const sy = Math.floor(y) - oy;
  if (sx < 0 || sy < 0 || sx >= buf.width || sy >= buf.height) return false;
  return buf.opaque(flip ? buf.width - 1 - sx : sx, sy);
}

/** Is (x, y) on a grid drawn with its top-left at (ox, oy)? */
function onGrid(
  rows: readonly string[],
  ox: number,
  oy: number,
  flip: boolean,
  x: number,
  y: number,
): boolean {
  const w = rows[0]?.length ?? 0;
  const gx = Math.floor(x) - Math.round(ox);
  const gy = Math.floor(y) - Math.round(oy);
  if (gx < 0 || gy < 0 || gx >= w || gy >= rows.length) return false;
  const ch = rows[gy]?.[flip ? w - 1 - gx : gx];
  return ch !== undefined && ch !== ".";
}

/** Grow a hit box a little, so small or moving things are easy to click. */
const grow = (x0: number, y0: number, x1: number, y1: number, by: number) => {
  return (x: number, y: number): boolean =>
    x >= x0 - by && x < x1 + by && y >= y0 - by && y < y1 + by;
};

/**
 * Everything that can be poked, where it is this frame: the farm's things,
 * the animals, the koi pond and its spout, the butterflies, the dragonfly
 * and every critter. See targetAt for which one a click lands on.
 */
export function farmTargets(
  world: FarmWorld,
  play: FarmPlay | null,
  now: number,
  ambientNow: number,
): Target[] {
  const { farm } = world;
  const out: Target[] = [];
  const mouth = farm.ambient.spout.mouth;
  for (const t of farm.things) {
    const onIt = (x: number, y: number): boolean => onSprite(t.buf, t.x, t.y, t.flip, x, y);
    const outline: Outline = { buf: t.buf, x: t.x, y: t.y, flip: t.flip };
    const flat = t.kind === "stone" || t.kind === "field";
    const middle = { x: t.x + t.buf.width / 2, y: t.y + t.buf.height / 2 };
    if (t.kind === "pond") {
      // The pond's sprite carries the bamboo spout too: its frame is its own thing.
      const water = (x: number, y: number): boolean =>
        farm.surface[Math.floor(y) * farm.width + Math.floor(x)] === SURFACE.water;
      const spoutAt = (x: number, y: number): boolean =>
        onIt(x, y) && !water(x, y) && x < mouth.x + 4 && y < farm.ambient.spout.pour.y + 8;
      out.push({
        id: "spout",
        kind: "spout",
        name: "Bamboo spout",
        depth: t.base + 0.5,
        anchor: farm.ambient.spout.pour,
        contains: spoutAt,
        outline: null,
      });
      out.push({
        id: t.id,
        kind: "pond",
        name: t.name,
        depth: t.base,
        anchor: farm.ambient.pond,
        contains: (x, y) => onIt(x, y) && !spoutAt(x, y),
        outline,
      });
      continue;
    }
    out.push({
      id: t.id,
      kind: t.kind,
      name: t.name,
      depth: flat ? t.base - 10000 : t.base,
      anchor: middle,
      contains: onIt,
      outline,
    });
  }
  // The animals.
  for (const { id, roamer, pose } of roamersNow(farm, play, ambientNow)) {
    const r = reactionOn(play, id, now);
    const look = roamer.kind === "cat" ? catLook(pose, r, now) : henLook(pose, r, now, roamer.seed);
    const w = look.rows[0]?.length ?? 0;
    const x0 = look.x - w / 2;
    const y0 = look.y - look.rows.length + 2;
    out.push({
      id,
      kind: roamer.kind,
      name: roamer.kind === "cat" ? "Cat" : "Hen",
      depth: pose.y,
      anchor: { x: pose.x, y: pose.y },
      contains: grow(x0, y0, x0 + w, y0 + look.rows.length, 2),
      outline: { rows: look.rows, x: x0, y: y0, flip: look.flip },
    });
  }
  {
    const at = farm.ambient.shiba;
    const look = shibaLook(at, reactionOn(play, "shiba", now), now);
    const w = look.rows[0]?.length ?? 0;
    const x0 = look.x - w / 2;
    const y0 = look.y - look.rows.length + 2;
    out.push({
      id: "shiba",
      kind: "shiba",
      name: "Shiba",
      depth: at.y + 0.5,
      anchor: at,
      contains: (x, y) => onGrid(look.rows, x0, y0, false, x, y),
      outline: { rows: look.rows, x: x0, y: y0, flip: false },
    });
  }
  {
    const d = dragonflyAt(farm, play, ambientNow, now);
    out.push({
      id: "dragonfly",
      kind: "dragonfly",
      name: "Dragonfly",
      depth: 100000,
      anchor: { x: d.x, y: d.y },
      contains: grow(d.x - 4, d.y - 3, d.x + 5, d.y + 3, 3),
      outline: null,
    });
  }
  {
    const flies = farm.ambient.butterflies.map((_, i) =>
      butterflyAt(farm, play, i, ambientNow, now),
    );
    out.push({
      id: "butterflies",
      kind: "butterflies",
      name: "Butterflies",
      depth: 100000,
      anchor: flies[0] ?? farm.origin,
      contains: (x, y) => flies.some((b) => grow(b.x - 3, b.y - 3, b.x + 4, b.y + 2, 3)(x, y)),
      outline: null,
    });
  }
  // The critters (not while being summoned in or out).
  for (const actor of world.actors.values()) {
    if (actor.state === "arriving" || actor.state === "leaving") continue;
    const { x, y, facing } = actorAt(actor, now);
    const def = critterDef(actor.critterId);
    const left = Math.round(x) - CRITTER / 2;
    const top = Math.round(y) - CRITTER_H;
    out.push({
      id: `critter:${actor.key}`,
      kind: actor.coordinator ? "coordinator" : "critter",
      name: actor.name,
      depth: y + 0.25,
      anchor: { x, y },
      contains: grow(left, top, left + CRITTER, top + CRITTER_H, 1),
      outline: { rows: frameRows(def, 0), x: left, y: top, flip: facing === -1 },
    });
  }
  return out;
}

/** The front-most target under (x, y), or null for open ground. */
export function targetAt(targets: readonly Target[], x: number, y: number): Target | null {
  let best: Target | null = null;
  for (const t of targets) {
    if (!t.contains(x, y)) continue;
    if (!best || t.depth > best.depth) best = t;
  }
  return best;
}

// The hover glow: a warm line round the thing, and a fainter one outside it.
const GLOW_INNER = "#fff0c0";
const GLOW_OUTER = "#ffd890";

/** A glow ring round whatever's opaque in `at`, as a buffer two pixels bigger all round. */
function ringBuffer(
  w: number,
  h: number,
  at: (x: number, y: number) => boolean,
  keep: (x: number, y: number) => boolean = () => true,
): PixelBuffer {
  const out = new PixelBuffer(w + 4, h + 4);
  const near = (x: number, y: number, d: number): boolean => {
    for (let oy = -d; oy <= d; oy++) {
      for (let ox = -d; ox <= d; ox++) {
        if (Math.abs(ox) + Math.abs(oy) > d) continue;
        if (at(x + ox, y + oy)) return true;
      }
    }
    return false;
  };
  for (let y = -2; y < h + 2; y++) {
    for (let x = -2; x < w + 2; x++) {
      if (at(x, y) || !keep(x, y)) continue;
      if (near(x, y, 1)) out.set(x + 2, y + 2, parseHex(GLOW_INNER), 0.95);
      else if (near(x, y, 2)) out.set(x + 2, y + 2, parseHex(GLOW_OUTER), 0.45);
    }
  }
  return out;
}

const parseHex = (c: string): number => parseInt(c.slice(1), 16);

/**
 * Draw the hover glow round a target, only where nothing stands in front of
 * it: a pixel covered by a nearer standing thing (its base line lower down
 * the map than the target's) keeps that thing, the way it covers the target.
 */
function drawGlowRing(ctx: Ctx, farm: Farm, play: FarmPlay, t: Target): void {
  const o = t.outline;
  if (!o) return;
  const { front } = farm.solids;
  const clear = (mx: number, my: number): boolean => {
    if (mx < 0 || my < 0 || mx >= farm.width || my >= farm.height) return false;
    return (front[my * farm.width + mx] ?? -1) <= t.depth;
  };
  if ("buf" in o) {
    let img = play.rings.get(t.id);
    if (!img) {
      const { buf, flip } = o;
      img = canvasOf(
        ringBuffer(
          buf.width,
          buf.height,
          (x, y) =>
            x >= 0 && y >= 0 && x < buf.width && y < buf.height
              ? buf.opaque(flip ? buf.width - 1 - x : x, y)
              : false,
          (x, y) => clear(o.x + x, o.y + y),
        ),
      );
      play.rings.set(t.id, img);
    }
    ctx.drawImage(img, o.x - 2, o.y - 2);
    return;
  }
  // A grid moves and changes frame: its ring is drawn straight from it.
  const w = o.rows[0]?.length ?? 0;
  const left = Math.round(o.x) - 2;
  const top = Math.round(o.y) - 2;
  const ring = ringBuffer(
    w,
    o.rows.length,
    (x, y) => {
      const ch = o.rows[y]?.[o.flip ? w - 1 - x : x];
      return ch !== undefined && ch !== ".";
    },
    (x, y) => clear(left + 2 + x, top + 2 + y),
  );
  for (let y = 0; y < ring.height; y++) {
    for (let x = 0; x < ring.width; x++) {
      const a = (ring.data[(y * ring.width + x) * 4 + 3] ?? 0) / 255;
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      ctx.fillStyle = a > 0.6 ? GLOW_INNER : GLOW_OUTER;
      ctx.fillRect(left + x, top + y, 1, 1);
    }
  }
  ctx.globalAlpha = 1;
}

// ── Little effects ─────────────────────────────────────────────

/** Specks flying out from (x, y) and falling back, thinning out as they go. */
function burst(
  ctx: Ctx,
  x: number,
  y: number,
  p: number,
  colors: readonly string[],
  count: number,
  speed: number,
  seed: number,
  gravity = 20,
): void {
  for (let i = 0; i < count; i++) {
    if (hash(i, 3, seed) < p * 0.95) continue;
    const a = -Math.PI * (0.08 + 0.84 * hash(i, 1, seed));
    const v = speed * (0.45 + hash(i, 2, seed) * 0.8);
    ctx.fillStyle = colors[i % colors.length] ?? "#ffffff";
    ctx.fillRect(
      Math.round(x + Math.cos(a) * v * p),
      Math.round(y + Math.sin(a) * v * p + gravity * p * p),
      1,
      1,
    );
  }
}

/** Twinkling four-point sparkles over a box. */
function sparkles(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  p: number,
  now: number,
  seed: number,
  count: number,
  color = "#fff8d0",
): void {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    if (hash(i, 8, seed) < p * 0.9) continue;
    const phase = (now / 140 + i * 1.7) % 3;
    if (phase > 2) continue;
    const sx = Math.round(x + hash(i, 9, seed) * w);
    const sy = Math.round(y + hash(i, 10, seed) * h);
    ctx.fillRect(sx, sy, 1, 1);
    if (phase < 1) {
      ctx.fillRect(sx - 1, sy, 1, 1);
      ctx.fillRect(sx + 1, sy, 1, 1);
      ctx.fillRect(sx, sy - 1, 1, 1);
      ctx.fillRect(sx, sy + 1, 1, 1);
    }
  }
}

/**
 * Rings spreading on water from (x, y): each a bright, two-pixel-thick lit
 * arc along its far side and a dark one along its near side, so a poked ring
 * stands out even on the pond's pale foam; older rings thin out.
 */
function rippleAt(
  ctx: Ctx,
  x: number,
  y: number,
  p: number,
  count: number,
  reach: number,
  on: (x: number, y: number) => boolean = () => true,
): void {
  for (let k = 0; k < count; k++) {
    const q = p - k * 0.18;
    if (q <= 0 || q >= 1) continue;
    const rx = 2 + q * reach;
    const ry = rx * 0.42;
    const keep = 1 - q * 0.7;
    const steps = Math.round(rx * 6);
    for (let i = 0; i < steps; i++) {
      if (((i * 7 + k * 3) % 10) / 10 >= keep) continue;
      const a = (i / steps) * Math.PI * 2;
      const far = Math.sin(a) < 0;
      const px = Math.round(x + Math.cos(a) * rx);
      const py = Math.round(y + Math.sin(a) * ry);
      // Only on the water: a ring meeting the stones stops at them.
      if (!on(px, py)) continue;
      ctx.fillStyle = far ? "#ffffff" : WATER_HEX.deep;
      ctx.fillRect(px, py, 1, 1);
      const py2 = py + (far ? 1 : -1);
      if (!on(px, py2)) continue;
      ctx.fillStyle = far ? WATER_HEX.deep : WATER_HEX.crack;
      ctx.fillRect(px, py2, 1, 1);
    }
  }
}

/** A soft round puff growing from (x, y) and thinning away. */
function puffAt(ctx: Ctx, x: number, y: number, p: number, color: string, seed: number): void {
  ctx.fillStyle = color;
  const r = 2 + p * 6;
  for (let i = 0; i < 18; i++) {
    if (hash(i, 11, seed) < p) continue;
    const a = (i / 18) * Math.PI * 2 + hash(i, 12, seed);
    const d = r * (0.5 + hash(i, 13, seed) * 0.5);
    ctx.fillRect(
      Math.round(x + Math.cos(a) * d),
      Math.round(y + Math.sin(a) * d * 0.6 - p * 3),
      1,
      1,
    );
  }
}

/** A small bird from above, wings up or down. */
function drawBird(ctx: Ctx, x: number, y: number, flap: number): void {
  // A sparrow from above: a brown body lit along its back, a pale breast,
  // wings beating up and down with darker tips, an orange beak.
  const px = Math.round(x);
  const py = Math.round(y);
  ctx.fillStyle = "#2a1a12";
  ctx.fillRect(px - 1, py - 1, 4, 3);
  ctx.fillStyle = "#8a5a34";
  ctx.fillRect(px, py, 2, 1);
  ctx.fillStyle = "#c08a58";
  ctx.fillRect(px, py - 1, 2, 1); // the lit back
  ctx.fillStyle = "#e8d8c0";
  ctx.fillRect(px + 1, py + 1, 1, 1);
  // Wings, beating.
  const wy = py - 1 + flap;
  ctx.fillStyle = "#6a4426";
  ctx.fillRect(px - 3, wy, 2, 1);
  ctx.fillRect(px + 3, wy, 2, 1);
  ctx.fillStyle = "#2a1a12";
  ctx.fillRect(px - 4, wy + (flap ? 0 : -1), 1, 1);
  ctx.fillRect(px + 5, wy + (flap ? 0 : -1), 1, 1);
  ctx.fillStyle = "#f2a630";
  ctx.fillRect(px + 3, py, 1, 1);
}

/** A tiny pixel heart. */
function drawHeart(ctx: Ctx, x: number, y: number): void {
  // A heart like GG Royale's: an ink outline, the red body, a lit lobe on the
  // left and a deeper red point at the bottom right.
  const px = Math.round(x);
  const py = Math.round(y);
  const rows = [".oo.oo.", "oRRoRRo", "oRLRRRo", "oRRRRDo", ".oRRDo.", "..oDo..", "...o..."];
  const pal: Record<string, string> = { o: "#1e0c1f", R: "#e8445a", L: "#ffb0bc", D: "#a8243a" };
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const colour = pal[row[c] ?? "."];
      if (!colour) continue;
      ctx.fillStyle = colour;
      ctx.fillRect(px - 3 + c, py - 1 + r, 1, 1);
    }
  });
}

/** A little "z", for snoring. */
function drawZ(ctx: Ctx, x: number, y: number): void {
  // A sleepy "z", cream with an ink outline so it reads on grass or dirt.
  const px = Math.round(x);
  const py = Math.round(y);
  const rows = ["ooooo", "oZZZo", "oooZo", ".oZo.", "oZooo", "oZZZo", "ooooo"];
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const k = row[c];
      if (k === ".") continue;
      ctx.fillStyle = k === "Z" ? "#fff8ec" : "#1e0c1f";
      ctx.fillRect(px - 1 + c, py - 2 + r, 1, 1);
    }
  });
}

/**
 * Everything play adds to this frame: reactions on things (shakes, puffs,
 * petals, birds, letters), the lanterns that are switched off, eggs, speech
 * for the animals and critters. Things on the ground join the depth sort;
 * speech and the hover glow go on top.
 */
function playItems(
  ctx: Ctx,
  world: FarmWorld,
  play: FarmPlay,
  now: number,
  occluders: readonly OccluderCanvas[],
  out: Placed[],
  late: Array<() => void>,
  puddles: Uint8Array | null,
): void {
  const { farm } = world;
  const byId = new Map(farm.things.map((t) => [t.id, t]));
  const onWater = waterAt(farm);
  const surfaceDepth = waterDepth(farm);
  const onPuddle = (x: number, y: number): boolean =>
    puddles?.[Math.round(y) * farm.width + Math.round(x)] === 1;
  // Whatever's falling from a poke, sorted with everything else.
  debrisFalling(ctx, farm, play, now, out);
  // Lights that are off: a lantern's firebox goes dark.
  for (const t of farm.things) {
    if (t.kind !== "lantern" || !play.lightsOff.has(t.id)) continue;
    const lamp = farm.lamps[t.lamps[0] ?? -1];
    if (!lamp) continue;
    out.push({
      y: t.base + 0.01,
      draw: () => {
        ctx.fillStyle = "#3a2c22";
        ctx.fillRect(Math.round(lamp.x) - 2, Math.round(lamp.y) - 4, 4, 4);
        ctx.fillStyle = "#5a4a3c";
        ctx.fillRect(Math.round(lamp.x) - 2, Math.round(lamp.y) - 4, 4, 1);
      },
    });
  }
  for (const r of play.reactions) {
    if (now >= r.until) continue;
    const p = progress(r, now);
    const t = byId.get(r.target);
    const box = t ? { x: t.x, y: t.y, w: t.buf.width, h: t.buf.height, base: t.base } : null;
    const seed = r.seed;
    // Drawn at the thing's own depth, and over its box: anything standing in
    // front of it is redrawn over it (see drawFarm), just as for a critter, so
    // a shaking tree behind the kura stays behind the kura's roof.
    const area = box ? { x0: box.x, y0: box.y, x1: box.x + box.w } : undefined;
    const at = (y: number, draw: () => void): void => {
      out.push(area ? { y, draw, body: area } : { y, draw });
    };
    const top = (draw: () => void): void => {
      late.push(draw);
    };
    const say = (text: string, x: number, y: number): void =>
      top(() => drawBubble(ctx, text, x, y, farm.width));
    // Shaking: the thing redrawn a pixel to and fro over itself.
    const shake = (strength: number): void => {
      const o = t ? occluders[t.occluder] : undefined;
      if (!o || !box) return;
      const dx = p < 0.85 ? (Math.floor(now / 55) % 2 ? strength : -strength) : 0;
      at(box.base + 0.01, () => ctx.drawImage(o.image, o.x + dx, o.y));
    };
    // A tree or bush stirred: a slow, smooth sway that leans one way, swings
    // back past upright and settles, fading as it goes (no per-row flicker).
    // Redrawn row by row, each row moved by how far up the plant it is, so
    // whatever's in the ground stays put: a tree's crown leans as one while
    // its trunk bends from the root; a bush leans more at the top than the
    // bottom. `span` is the share of the reaction it takes (a bird taking off
    // only stirs it briefly).
    const stir = (rooted: boolean): void => {
      const o = t ? occluders[t.occluder] : undefined;
      const occ = t ? farm.occluders[t.occluder] : undefined;
      const span = stirSpan(r);
      if (!o || !occ || !box || span === null) return;
      const q = p / span;
      if (q >= 1) return;
      // Two gentle swings over the reaction, damped to rest by its end.
      const sway = Math.sin(q * Math.PI * 4) * (1 - q) ** 1.5 * (rooted ? 2.2 : 1.6);
      const crown = Math.max(1, occ.topRow);
      const foot = o.h - 1;
      const offset = (row: number): number => {
        if (!rooted) return Math.round(sway * ((foot - row) / foot));
        if (row <= crown) return Math.round(sway);
        // Trunk: bends from the root, so its foot never moves.
        const k = (foot - row) / Math.max(1, foot - crown);
        return Math.round(sway * k * k);
      };
      at(box.base + 0.01, () => {
        let start = 0;
        let dx = offset(0);
        for (let row = 1; row <= o.h; row++) {
          const next = row < o.h ? offset(row) : Number.NaN;
          if (next === dx) continue;
          ctx.drawImage(
            o.image,
            0,
            start,
            o.w,
            row - start,
            o.x + dx,
            o.y + start,
            o.w,
            row - start,
          );
          start = row;
          dx = next;
        }
      });
    };
    switch (`${r.kind}:${r.action}`) {
      // Flaring up in front of the stones, never behind them: drawn with
      // what's above the scene, like a bubble.
      case "campfire:on":
        top(() =>
          burst(
            ctx,
            farm.ambient.fire.x,
            farm.ambient.fire.y - 6,
            p,
            ["#ffd060", "#ff8a2a"],
            16,
            14,
            seed,
            8,
          ),
        );
        break;
      case "lantern:on": {
        const lamp = t ? farm.lamps[t.lamps[0] ?? -1] : undefined;
        if (lamp)
          top(() => sparkles(ctx, lamp.x - 4, lamp.y - 8, 8, 8, p, now, seed, 4, "#fff0b0"));
        break;
      }
      case "stove:rattle":
        if (box) {
          at(box.base + 0.02, () => {
            const jig = Math.floor(now / 50) % 2;
            ctx.fillStyle = "#c89a62";
            ctx.fillRect(box.x + 6 + jig, box.y + 4 - jig, 8, 2);
            ctx.fillStyle = "#3a1406";
            ctx.fillRect(box.x + 9 + jig, box.y + 3 - jig, 2, 1);
          });
          say("Clatter!", box.x + box.w / 2, box.y);
        }
        break;
      case "stove:puff":
        if (box) {
          top(() => {
            puffAt(ctx, box.x + 10, box.y + 2 - p * 10, p, "#ffffff", seed);
            puffAt(ctx, box.x + box.w - 10, box.y - p * 12, p, "#ffffff", seed + 1);
          });
        }
        break;
      case "stove:flare":
        if (box) {
          at(box.base + 0.02, () =>
            burst(
              ctx,
              box.x + box.w / 2,
              box.y + box.h - 8,
              p,
              ["#ffd060", "#ff8a2a", "#ffe8a0"],
              20,
              16,
              seed,
              6,
            ),
          );
        }
        break;
      case "kennel:creak":
        shake(1);
        if (box) say("Creak", box.x + box.w / 2, box.y);
        break;
      case "kennel:zzz":
        if (box) {
          top(() => {
            for (let k = 0; k < 3; k++) {
              const q = p * 1.4 - k * 0.25;
              if (q <= 0 || q >= 1) continue;
              drawZ(ctx, box.x + box.w / 2 + q * 6 + k * 2, box.y + box.h * 0.6 - q * 16);
            }
          });
        }
        break;
      case "board:flutter":
        if (box) {
          at(box.base + 0.02, () => {
            const lift = Math.floor(now / 70) % 3;
            ctx.fillStyle = "#3a1406";
            ctx.fillRect(box.x + 9, box.y + 18 - lift, 6, 4);
            ctx.fillStyle = "#fff4dc";
            ctx.fillRect(box.x + 10, box.y + 18 - lift, 4, 3);
          });
        }
        break;
      case "board:note":
        if (box) {
          at(box.base + 0.02, () => {
            const nx = box.x + 6 + Math.floor(hash(seed, 1, 3) * (box.w - 14));
            ctx.fillStyle = ["#f6d24a", "#f2b6c6", "#bfe0f0"][seed % 3] ?? "#f6d24a";
            ctx.fillRect(nx, box.y + 19, 5, 3);
            ctx.fillStyle = "#c8442c";
            ctx.fillRect(nx + 2, box.y + 19, 1, 1);
          });
          top(() => sparkles(ctx, box.x + 4, box.y + 14, box.w - 8, 10, p, now, seed, 4));
        }
        break;
      case "kura:mouse":
        if (box) {
          at(box.base + 0.02, () => {
            const peek = Math.round(4 * visit(p, 0.25));
            const mx = box.x + box.w / 2 + 6;
            const my = box.base - 1;
            ctx.fillStyle = "#3a1406";
            ctx.fillRect(mx - 1, my - 3, peek + 2, 4);
            ctx.fillStyle = "#9a948a";
            ctx.fillRect(mx, my - 2, peek, 2);
            if (peek > 2) {
              ctx.fillStyle = "#f2a6b4";
              ctx.fillRect(mx + peek - 2, my - 3, 1, 1);
              ctx.fillStyle = "#1b1612";
              ctx.fillRect(mx + peek - 1, my - 2, 1, 1);
            }
          });
        }
        break;
      case "kura:dust":
      case "bookcase:dust":
        if (box) {
          top(() => {
            puffAt(ctx, box.x + box.w * 0.3, box.y + box.h * 0.6, p, "#e8dcc8", seed);
            puffAt(ctx, box.x + box.w * 0.7, box.y + box.h * 0.5, p, "#e8dcc8", seed + 1);
          });
        }
        break;
      case "well:draw":
        if (box) {
          // A bucket hauled up out of the water on its rope, full and
          // dripping, held a moment over the mouth, then let back down: the
          // water rings where it leaves and where it lands again.
          const wx = box.x + WELL_WATER_AT.x;
          const wy = box.y + WELL_WATER_AT.y;
          const inWell = (x: number, y: number): boolean =>
            ((x + 0.5 - wx) / 8) ** 2 + ((y + 0.5 - wy) / 5) ** 2 <= 1;
          // How high the bucket is above the water: up, hold, down.
          const lift =
            p < 0.45 ? easeInOut(p / 0.45) : p < 0.72 ? 1 : 1 - easeInOut((p - 0.72) / 0.28);
          at(box.base + 0.02, () => {
            if (p < 0.3) rippleAt(ctx, wx, wy, p / 0.3, 2, 5, inWell);
            if (p > 0.85) rippleAt(ctx, wx, wy, (p - 0.85) / 0.15, 1, 5, inWell);
            const bx = Math.round(wx) - 3;
            // Up to just over the rim: held there, not swung away from the well.
            const by = Math.round(wy - 3 - lift * 11);
            // The rope, up out of view (to the windlass above), fading as it goes.
            for (let ry = by - 1; ry > by - 14; ry--) {
              ctx.globalAlpha = Math.max(0, 1 - (by - ry) / 14);
              ctx.fillStyle = ry % 2 ? "#c8b07a" : "#a88a5a";
              ctx.fillRect(bx + 3, ry, 1, 1);
            }
            ctx.globalAlpha = 1;
            drawWellBucket(ctx, bx, by, lift > 0.15);
            // Drips running off its bottom back into the well.
            if (lift > 0.2) {
              for (let k = 0; k < 3; k++) {
                const life = (now / 500 + k * 0.33) % 1;
                const dy = by + 6 + life * (wy - by - 6);
                if (dy >= wy) continue;
                ctx.globalAlpha = 0.85;
                ctx.fillStyle = WATER_HEX.pale;
                ctx.fillRect(bx + 2 + k, Math.round(dy), 1, 1);
              }
              ctx.globalAlpha = 1;
            }
          });
        }
        break;
      case "well:pebble":
        if (box) {
          at(box.base + 0.02, () => rippleAt(ctx, box.x + box.w / 2, box.y + 12, p, 2, 6));
          if (p > 0.15) say("Plink", box.x + box.w / 2, box.y + 2);
        }
        break;
      case "well:echo":
        if (box) say(p < 0.5 ? "Hello!" : "...hello...", box.x + box.w / 2, box.y + 2);
        break;
      case "pond:splash": {
        // Flicked off the stones: a pebble arcs into the water first.
        const hit = r.from ? 0.28 : 0;
        const from = r.from;
        if (from && p < hit) {
          const k = p / hit;
          at(surfaceDepth + 0.05, () => {
            ctx.fillStyle = "#3a1406";
            ctx.fillRect(
              Math.round(from.x + (r.x - from.x) * k),
              Math.round(from.y + (r.y - from.y) * k - 8 * k * (1 - k) * 4),
              2,
              2,
            );
          });
        }
        if (p >= hit)
          at(surfaceDepth, () => rippleAt(ctx, r.x, r.y, (p - hit) / (1 - hit), 3, 12, onWater));
        break;
      }
      case "pond:dart":
        at(surfaceDepth, () => rippleAt(ctx, r.x, r.y, p, 2, 10, onWater));
        break;
      case "pond:feed":
        at(surfaceDepth, () => {
          rippleAt(ctx, r.x, r.y, p, 3, 9, onWater);
          ctx.fillStyle = "#8a5a2a";
          for (let k = 0; k < 5; k++) {
            if (hash(k, 1, seed) < p * 1.2) continue;
            ctx.fillRect(
              Math.round(r.x - 3 + hash(k, 2, seed) * 6),
              Math.round(r.y - 1 + hash(k, 3, seed) * 3),
              1,
              1,
            );
          }
          ctx.fillStyle = WATER_HEX.foam;
          for (let k = 0; k < 4; k++) {
            const q = (p * 2 + k * 0.3) % 1;
            ctx.fillRect(Math.round(r.x - 4 + k * 3), Math.round(r.y + 2 - q * 4), 1, 1);
          }
        });
        break;
      case "spout:gush": {
        const pour = farm.ambient.spout.pour;
        at(surfaceDepth, () => rippleAt(ctx, pour.x + 1, pour.y, p, 3, 16, onWater));
        break;
      }
      case "spout:clack": {
        const pour = farm.ambient.spout.pour;
        at(surfaceDepth, () => rippleAt(ctx, pour.x + 1, pour.y, p, 2, 9, onWater));
        if (p < 0.6) say("Clack!", farm.ambient.spout.mouth.x - 6, farm.ambient.spout.mouth.y - 4);
        break;
      }
      case "torii:petals":
        // The petals themselves fall as debris (see spawnDebris).
        break;
      case "torii:glimmer":
        if (box) top(() => sparkles(ctx, box.x, box.y, box.w, 10, p, now, seed, 8));
        break;
      case "postbox:letter":
        if (box) {
          at(box.base + 0.02, () => {
            const up = Math.round(5 * visit(p, 0.25));
            const lx = box.x + box.w / 2 - 3;
            const ly = box.y + 5 - up;
            ctx.fillStyle = "#3a1406";
            ctx.fillRect(lx - 1, ly - 1, 8, 6);
            ctx.fillStyle = "#fffaf0";
            ctx.fillRect(lx, ly, 6, 4);
            ctx.fillStyle = "#c8bca4";
            ctx.fillRect(lx + 1, ly + 1, 4, 1);
            ctx.fillStyle = "#c8442c";
            ctx.fillRect(lx + 2, ly + 2, 2, 1);
          });
        }
        break;
      case "postbox:flag":
        if (box) {
          at(box.base + 0.02, () => {
            const up = Math.round(6 * ease(Math.min(1, p / 0.2)));
            const fx = box.x + box.w - 2;
            ctx.fillStyle = "#3a1406";
            ctx.fillRect(fx, box.y + 12 - up, 1, up + 2);
            ctx.fillStyle = "#e84a3a";
            ctx.fillRect(fx + 1, box.y + 12 - up, 4, 3);
          });
        }
        break;
      case "bookcase:book":
        if (box) {
          at(box.base + 0.02, () => {
            const out = Math.round(4 * visit(p, 0.3));
            const bx = box.x + Math.floor(box.w * 0.4);
            const by = box.y + 8;
            ctx.fillStyle = "#3a1406";
            ctx.fillRect(bx - 1, by + out - 1, 4, 8);
            ctx.fillStyle = ["#c8442c", "#3a6a9a", "#5a8a3a"][seed % 3] ?? "#c8442c";
            ctx.fillRect(bx, by + out, 2, 6);
            ctx.fillStyle = "#f6d24a";
            ctx.fillRect(bx, by + out + 1, 2, 1);
          });
        }
        break;
      case "laptop:wake":
        if (box) {
          at(box.base + 0.02, () => {
            const sx = box.x + Math.floor(box.w / 2) - 5;
            const sy = box.y + 2;
            ctx.fillStyle = "#bfe8ff";
            ctx.fillRect(sx, sy, 10, 6);
            ctx.fillStyle = "#3a6a9a";
            const scroll = Math.floor(now / 160) % 6;
            for (let k = 0; k < 3; k++) {
              const ly = sy + 1 + ((k * 2 + scroll) % 6);
              if (ly > sy + 4) continue;
              ctx.fillRect(sx + 1, ly, 3 + ((k * 5 + seed) % 6), 1);
            }
            if (Math.floor(now / 400) % 2) ctx.fillRect(sx + 8, sy + 4, 1, 1);
          });
        }
        break;
      case "laptop:beep":
        if (box && p < 0.7) say("Beep!", box.x + box.w / 2, box.y);
        break;
      case "bench:hammer":
        if (box) {
          at(box.base + 0.02, () => {
            const down = Math.floor(now / 160) % 2;
            const hx = box.x + box.w / 2;
            const hy = box.y - 2 + down * 3;
            ctx.fillStyle = "#8a5a34";
            ctx.fillRect(hx, hy, 1, 5);
            ctx.fillStyle = "#5a524c";
            ctx.fillRect(hx - 2, hy - 1, 5, 2);
            if (down)
              burst(
                ctx,
                hx,
                box.y + 6,
                (now % 320) / 320,
                ["#f0d0a0", "#e0b078"],
                6,
                8,
                seed + Math.floor(now / 320),
                10,
              );
          });
        }
        break;
      case "bench:saw":
        if (box) {
          at(box.base + 0.02, () => {
            const stroke = Math.round(Math.sin(now / 90) * 3);
            const sx = box.x + box.w / 2 - 4 + stroke;
            ctx.fillStyle = "#c9c2b9";
            ctx.fillRect(sx, box.y + 4, 8, 1);
            ctx.fillStyle = "#8a4e22";
            ctx.fillRect(sx + 8, box.y + 3, 2, 3);
            burst(
              ctx,
              box.x + box.w / 2,
              box.y + 6,
              (now % 400) / 400,
              ["#f0d0a0"],
              5,
              6,
              seed + Math.floor(now / 400),
              12,
            );
          });
        }
        break;
      case "teabench:steam":
        if (box) {
          top(() => {
            for (let k = 0; k < 4; k++) {
              const q = (p * 1.6 + k * 0.22) % 1;
              puffAt(
                ctx,
                box.x + box.w * 0.7 + Math.sin(q * 6 + k) * 2,
                box.y + box.h * 0.6 - q * 16,
                q,
                "#ffffff",
                seed + k,
              );
            }
          });
        }
        break;
      case "teabench:spin":
        if (box) {
          top(() => {
            const cx = box.x + box.w / 2;
            const cy = box.y + 10;
            ctx.fillStyle = "#fff4e0";
            for (let k = 0; k < 4; k++) {
              const a = now / 120 + (k * Math.PI) / 2;
              ctx.fillRect(
                Math.round(cx + Math.cos(a) * 12),
                Math.round(cy + Math.sin(a) * 6),
                1,
                1,
              );
            }
          });
        }
        break;
      case "sakura:shake":
      case "tree:shake":
      case "camellia:shake":
      case "yuzu:shake":
        stir(true);
        break;
      case "bush:rustle":
        stir(false);
        break;
      case "sakura:bird":
      case "tree:bird":
      case "camellia:bird":
      case "yuzu:bird":
      case "bush:bird":
        if (box) {
          stir(r.kind !== "bush");
          top(() => {
            const sx = box.x + box.w / 2;
            const sy = box.y + box.h * 0.35;
            const dir = hash(seed, 2, 3) < 0.5 ? -1 : 1;
            drawBird(
              ctx,
              sx + dir * p * 60,
              sy - p * 40 - Math.sin(p * 12) * 2,
              Math.floor(now / 90) % 2,
            );
          });
        }
        break;
      case "bush:butterfly":
        if (box) {
          top(() =>
            drawButterfly(
              ctx,
              box.x + box.w / 2 + Math.sin(p * 9) * 6,
              box.y + box.h * 0.4 - p * 26,
              seed,
              Math.floor(now / 110) % 2,
            ),
          );
        }
        break;
      case "stone:hop":
        at(r.y + 0.5, () => puffAt(ctx, r.x, r.y + 1, p, "#e8dcc8", seed));
        break;
      case "field:sway":
        top(() => burst(ctx, r.x, r.y, p, ["#9ab84c", "#c8d878"], 10, 10, seed, 14));
        break;
      case "field:sprout":
        top(() => {
          sparkles(ctx, r.x - 6, r.y - 8, 12, 8, p, now, seed, 5, "#e8f8b0");
          const h = Math.round(3 * ease(Math.min(1, p / 0.4)));
          ctx.fillStyle = "#5a8a2a";
          ctx.fillRect(Math.round(r.x), Math.round(r.y) - h, 1, h);
          if (h >= 3) {
            ctx.fillStyle = "#9ab84c";
            ctx.fillRect(Math.round(r.x) - 1, Math.round(r.y) - h, 1, 1);
            ctx.fillRect(Math.round(r.x) + 1, Math.round(r.y) - h - 1, 1, 1);
          }
        });
        break;
      case "creel:flop":
        if (box) {
          top(() => {
            const q = Math.min(1, p / 0.7);
            const fx = box.x + box.w / 2 + (q - 0.5) * 8;
            const fy = box.y + 6 - 10 * arc(q);
            ctx.fillStyle = "#3a1406";
            ctx.fillRect(Math.round(fx) - 1, Math.round(fy) - 1, 6, 4);
            ctx.fillStyle = "#c8d4e0";
            ctx.fillRect(Math.round(fx), Math.round(fy), 4, 2);
            ctx.fillStyle = "#8aa0b8";
            ctx.fillRect(Math.round(fx) + 4, Math.round(fy), 1, 2);
          });
        }
        break;
      case "ground:snow":
        at(r.y + 0.5, () => puffAt(ctx, r.x, r.y, p, "#ffffff", seed));
        break;
      case "ground:puddle":
        at(r.y + 0.4, () => rippleAt(ctx, r.x, r.y, p, 2, 7, onPuddle));
        break;
      case "ground:grass":
        at(r.y + 0.5, () => burst(ctx, r.x, r.y, p, ["#9ab84c", "#7c8a30"], 8, 8, seed, 14));
        break;
      case "ground:dirt":
        at(r.y + 0.5, () => puffAt(ctx, r.x, r.y, p, "#e0c090", seed));
        break;
      default:
        break;
    }
  }
  // The hen's egg, left where she sat until it fades.
  for (const r of play.reactions) {
    if (r.kind !== "hen" || r.action !== "egg" || now - r.start < 900 || now >= r.until) continue;
    const fade = progress(r, now) > 0.9;
    if (fade && Math.floor(now / 120) % 2) continue;
    out.push({
      y: r.y - 0.5,
      draw: () => {
        const ex = Math.round(r.x) + 6;
        const ey = Math.round(r.y);
        ctx.fillStyle = "#3a1406";
        ctx.fillRect(ex - 1, ey - 3, 5, 5);
        ctx.fillStyle = "#fff8ec";
        ctx.fillRect(ex, ey - 2, 3, 3);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(ex, ey - 2, 1, 1);
      },
    });
  }
}

/** A line of text cut to fit a speech bubble. */
function clip(text: string, max = 28): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** GG Goals' summary of the goal: how many workers, and how many need you. */
function summaryOf(world: FarmWorld): string {
  const workers = [...world.actors.values()].filter((a) => !a.coordinator && !a.leaving);
  const busy = workers.filter((a) => a.want !== null).length;
  if (workers.length === 0) return "Just me for now";
  const asking = [...world.actors.values()].some((a) => a.coordinator && a.want === "ask");
  const crew = `${workers.length} worker${workers.length === 1 ? "" : "s"}, ${busy} busy`;
  return asking ? `${crew}. Need you!` : crew;
}

/**
 * The glow round whatever the pointer is over (or a keyboard user has
 * focused): a soft warm outline in its own shape, drawn at the thing's own
 * depth so anything in front of it (a critter, a lantern) covers the glow
 * just as it covers the thing. Records what's hovered on the play state, so
 * the view can set the cursor and name it. While the thing is reacting to a
 * click (shaking, swaying, hopping) the glow is left off: it traces the
 * thing at rest, and would hang in place while the thing moves. It comes
 * back once the thing settles.
 */
function hoverItems(
  ctx: Ctx,
  world: FarmWorld,
  play: FarmPlay,
  now: number,
  ambientNow: number,
  out: Placed[],
): void {
  const targets = farmTargets(world, play, now, ambientNow);
  const focused = play.focus ? targets.find((t) => t.id === play.focus) : undefined;
  const hovered = play.hover ? targetAt(targets, play.hover.x, play.hover.y) : null;
  const shown = hovered ?? focused ?? null;
  play.hovered = hovered?.id ?? null;
  if (shown && !reactionOn(play, shown.id, now))
    out.push({ y: shown.depth + 0.001, draw: () => drawGlowRing(ctx, world.farm, play, shown) });
}

/** The farm's lamps, without those belonging to lights someone switched off. */
export function litLamps(farm: Farm, lightsOff: ReadonlySet<string>): FarmLamp[] {
  const dark = new Set(farm.things.filter((t) => lightsOff.has(t.id)).flatMap((t) => t.lamps));
  return farm.lamps.filter((_, i) => !dark.has(i));
}

// ── What a poke knocks loose ───────────────────────────────────

const PETALS = ["#f8c8d4", "#fbe0e8", "#f2b6c6"] as const;
const LEAVES = ["#7c9a3a", "#9ab84c", "#5e7a2a"] as const;
const DROP_LIGHT = "#e8f4f8";

/**
 * Where something can come to rest at (x, y): open ground, something flat on
 * it, a stone of the pond's ring or other sky-facing top, or water (it
 * floats), and not under anything standing (it would be hidden). Null if not.
 */
function restingSpot(farm: Farm, x: number, y: number): { spot: Spot; water: boolean } | null {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 1 || py < 1 || px >= farm.width - 1 || py >= farm.height - 1) return null;
  const i = py * farm.width + px;
  const code = farm.surface[i] ?? SURFACE.ground;
  if (code === SURFACE.side) return null;
  if ((farm.solids.owner[i] ?? -1) >= 0) return null;
  return { spot: { x: px, y: py }, water: code === SURFACE.water };
}

/** The water pixel nearest (x, y), searching outward up to `reach` pixels; null if none. */
export function nearestWater(farm: Farm, x: number, y: number, reach = 40): Spot | null {
  const at = (px: number, py: number): boolean =>
    px >= 0 &&
    py >= 0 &&
    px < farm.width &&
    py < farm.height &&
    farm.surface[py * farm.width + px] === SURFACE.water;
  const cx = Math.round(x);
  const cy = Math.round(y);
  if (at(cx, cy)) return { x: cx, y: cy };
  for (let r = 1; r <= reach; r++) {
    let best: Spot | null = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!at(cx + dx, cy + dy)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = { x: cx + dx, y: cy + dy };
        }
      }
    }
    // Step a little way in, so a ripple there has room before the stones.
    if (best) return nearestInner(farm, best, { x: cx, y: cy });
  }
  return null;
}

/** A water point a little further in from the edge, away from where the click came from. */
function nearestInner(farm: Farm, edge: Spot, from: Spot): Spot {
  const dx = Math.sign(edge.x - from.x);
  const dy = Math.sign(edge.y - from.y);
  let p = edge;
  for (let k = 0; k < 9; k++) {
    const next = { x: p.x + dx, y: p.y + dy };
    if (farm.surface[next.y * farm.width + next.x] !== SURFACE.water) break;
    p = next;
  }
  return p;
}

/**
 * The pieces a reaction knocks loose, each with its own path and timing: leaves
 * and petals drift down from a canopy to the ground in front of the trunk,
 * fruit drops, bounces and rolls, feathers float down by a startled hen,
 * shavings fly off the bench, drops from a splash arc back to the water (or
 * leave a wet mark on the stones). Where each lands is a real spot on the
 * terrain (see restingSpot); anything with nowhere to land isn't made.
 */
export function spawnDebris(farm: Farm, r: Reaction): Debris[] {
  const t = farm.things.find((x) => x.id === r.target);
  const box = t ? { x: t.x, y: t.y, w: t.buf.width, h: t.buf.height, base: t.base } : null;
  const dur = r.until - r.start;
  const out: Debris[] = [];
  const h = (i: number, k: number): number => hash(i, k, r.seed);
  // Pieces falling from a canopy to the ground in front of it.
  const fromCanopy = (
    kind: Debris["kind"],
    colors: readonly string[],
    count: number,
    linger: number,
    front: number,
  ): void => {
    if (!box) return;
    for (let i = 0; i < count; i++) {
      let landing: ReturnType<typeof restingSpot> = null;
      for (let tries = 0; tries < 8 && !landing; tries++) {
        const x = box.x + box.w * (0.08 + 0.84 * h(i * 8 + tries, 1));
        const y = box.base - 3 + h(i * 8 + tries, 2) * front;
        landing = restingSpot(farm, x, y);
      }
      if (!landing) continue;
      const start = r.start + h(i, 3) * dur * 0.55;
      const fall = 1100 + h(i, 4) * 900;
      out.push({
        kind,
        color: colors[i % colors.length] ?? "#ffffff",
        size: h(i, 5) < 0.45 ? 2 : 1,
        from: {
          x: landing.spot.x + (h(i, 6) - 0.5) * 8,
          y: box.y + box.h * (0.12 + 0.38 * h(i, 7)),
        },
        to: landing.spot,
        rest: landing.spot,
        start,
        land: start + fall,
        until: start + fall + linger * (0.55 + 0.9 * h(i, 8)),
        sway: 2 + h(i, 9) * 3,
        arc: 0,
        water: landing.water,
        seed: r.seed + i,
      });
    }
  };
  // Drops from a splash at (x, y): arcing up and back down onto the water,
  // or onto a stone of the ring, where they leave a wet mark for a moment.
  const droplets = (x: number, y: number, count: number, spread: number, delay: number): void => {
    for (let i = 0; i < count; i++) {
      const a = h(i, 1) * Math.PI * 2;
      const d = spread * (0.35 + 0.65 * h(i, 2));
      const landing = restingSpot(farm, x + Math.cos(a) * d, y + Math.sin(a) * d * 0.45);
      if (!landing) continue;
      const start = r.start + delay + h(i, 3) * 120;
      const fall = 320 + h(i, 4) * 260;
      out.push({
        kind: "drop",
        color: DROP_LIGHT,
        size: 1,
        from: { x, y },
        to: landing.spot,
        rest: landing.spot,
        start,
        land: start + fall,
        until: start + fall + (landing.water ? 500 : 3500 + h(i, 5) * 2500),
        sway: 0,
        arc: 5 + h(i, 6) * 7,
        water: landing.water,
        seed: r.seed + i,
      });
    }
  };
  switch (`${r.kind}:${r.action}`) {
    case "sakura:shake":
      fromCanopy("petal", PETALS, 24, 22_000, 14);
      break;
    case "tree:shake":
      fromCanopy("leaf", LEAVES, 14, 22_000, 12);
      break;
    case "bush:rustle":
      fromCanopy("leaf", LEAVES, 6, 16_000, 8);
      break;
    case "sakura:bird":
    case "tree:bird":
    case "camellia:bird":
    case "yuzu:bird":
    case "bush:bird":
      fromCanopy(
        r.kind === "sakura" ? "petal" : "leaf",
        r.kind === "sakura" ? PETALS : LEAVES,
        3,
        14_000,
        10,
      );
      break;
    case "camellia:shake":
    case "yuzu:shake": {
      fromCanopy("leaf", LEAVES, 4, 18_000, 10);
      if (!box) break;
      // One flower or fruit: drops, bounces, rolls a little way, and lies there.
      const dir = h(0, 11) < 0.5 ? -1 : 1;
      for (let tries = 0; tries < 8; tries++) {
        const x = box.x + box.w * (0.25 + 0.5 * h(tries, 12));
        const landing = restingSpot(farm, x, box.base + 2 + h(tries, 13) * 5);
        const rolled = landing && restingSpot(farm, landing.spot.x + dir * 6, landing.spot.y);
        if (!landing || !rolled) continue;
        out.push({
          kind: "fruit",
          color: r.kind === "yuzu" ? "#f6c83a" : "#e8445a",
          size: 2,
          from: { x: landing.spot.x, y: box.y + box.h * 0.4 },
          to: landing.spot,
          rest: rolled.spot,
          start: r.start + 120,
          land: r.start + 620,
          until: r.start + 620 + 40_000,
          sway: 0,
          arc: 0,
          water: false,
          seed: r.seed,
        });
        break;
      }
      break;
    }
    case "torii:petals":
      fromCanopy("petal", PETALS, 20, 20_000, 9);
      break;
    case "bench:hammer":
    case "bench:saw":
      if (!box) break;
      for (let i = 0; i < 6; i++) {
        const landing = restingSpot(
          farm,
          box.x + box.w * (0.2 + 0.6 * h(i, 1)),
          box.base + 1 + h(i, 2) * 5,
        );
        if (!landing) continue;
        const start = r.start + h(i, 3) * dur * 0.8;
        out.push({
          kind: "shaving",
          color: h(i, 4) < 0.5 ? "#f0d0a0" : "#e0b078",
          size: h(i, 5) < 0.5 ? 2 : 1,
          from: { x: box.x + box.w / 2, y: box.y + 6 },
          to: landing.spot,
          rest: landing.spot,
          start,
          land: start + 420,
          until: start + 420 + 18_000 * (0.5 + h(i, 6)),
          sway: 0,
          arc: 6,
          water: false,
          seed: r.seed + i,
        });
      }
      break;
    case "hen:startle":
    case "hen:flap":
      // Feathers puffed loose, floating down round her feet.
      for (let i = 0; i < 4; i++) {
        const landing = restingSpot(farm, r.x + (h(i, 1) - 0.5) * 14, r.y + 1 + h(i, 2) * 3);
        if (!landing) continue;
        const start = r.start + h(i, 3) * 200;
        out.push({
          kind: "feather",
          color: h(i, 4) < 0.5 ? "#ffffff" : "#e8e0d2",
          size: 1,
          from: { x: r.x + (h(i, 5) - 0.5) * 6, y: r.y - 10 },
          to: landing.spot,
          rest: landing.spot,
          start,
          land: start + 900 + h(i, 6) * 500,
          until: start + 9_000 + h(i, 7) * 5_000,
          sway: 2.5,
          arc: 3,
          water: landing.water,
          seed: r.seed + i,
        });
      }
      break;
    case "pond:splash":
      droplets(r.x, r.y, 12, 10, r.from ? dur * 0.28 : 0);
      break;
    case "spout:gush": {
      const pour = farm.ambient.spout.pour;
      droplets(pour.x + 1, pour.y, 16, 13, 0);
      break;
    }
    case "spout:clack": {
      const pour = farm.ambient.spout.pour;
      droplets(pour.x + 1, pour.y, 8, 8, 0);
      break;
    }
    case "ground:puddle":
      droplets(r.x, r.y, 6, 5, 0);
      break;
    default:
      break;
  }
  return out;
}

/**
 * Debris lying where it landed: drawn on the ground before anything standing,
 * so a leaf under a bench is hidden by the bench, and dimmed by night like
 * the ground it's on. Pieces afloat on the pond are drawn with the water
 * (see debrisFalling).
 */
function drawDebrisResting(ctx: Ctx, play: FarmPlay, now: number): void {
  for (const d of play.debris) {
    if (now < d.land || now >= d.until || d.water) continue;
    const since = now - d.land;
    let x = d.rest.x;
    let y = d.rest.y;
    if (d.kind === "fruit" && since < 500) {
      // Bounce, then roll on to where it rests.
      const k = since / 500;
      x = d.to.x + (d.rest.x - d.to.x) * ease(k);
      y = d.to.y - 2 * arc(Math.min(1, k * 2));
    }
    drawPiece(ctx, d, x, y, true);
  }
}

/**
 * Debris in the air, depth-sorted at where it'll land so it falls in front of
 * what's behind that spot; and anything afloat on the pond, drawn with the
 * water (bobbing, ringing the water as it lands).
 */
function debrisFalling(ctx: Ctx, farm: Farm, play: FarmPlay, now: number, out: Placed[]): void {
  const surfaceDepth = waterDepth(farm);
  const onWater = waterAt(farm);
  for (const d of play.debris) {
    if (d.water && now >= d.land && now < d.until) {
      const since = now - d.land;
      const bob = Math.floor(now / 600 + d.seed) % 2 ? 0 : 1;
      out.push({
        y: surfaceDepth + 0.03,
        draw: () => {
          if (since < 600) rippleAt(ctx, d.to.x, d.to.y, since / 600, 1, 4, onWater);
          if (d.kind !== "drop") drawPiece(ctx, d, d.rest.x, d.rest.y + bob, true);
        },
      });
      continue;
    }
    if (now < d.start || now >= d.land) continue;
    const k = (now - d.start) / (d.land - d.start);
    // Leaves drift down, slow then steady; drops arc up and fall back.
    const fall = d.arc > 0 ? k : k * (0.4 + 0.6 * k);
    const x = d.from.x + (d.to.x - d.from.x) * fall + Math.sin(k * 9 + d.seed) * d.sway * (1 - k);
    const y = d.from.y + (d.to.y - d.from.y) * fall - d.arc * 4 * k * (1 - k);
    out.push({
      y: d.water ? surfaceDepth + 0.04 : d.to.y + 0.3,
      draw: () => drawPiece(ctx, d, x, y, false),
    });
  }
}

/** One piece of debris at (x, y): a pixel or two in its colour, shaded once it lies on the ground. */
function drawPiece(ctx: Ctx, d: Debris, x: number, y: number, resting: boolean): void {
  const px = Math.round(x);
  const py = Math.round(y);
  if (d.kind === "drop") {
    if (resting) {
      // A wet mark on stone, darker than it.
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = "#2a3a4a";
      ctx.fillRect(px, py, 2, 1);
      ctx.globalAlpha = 1;
      return;
    }
    ctx.fillStyle = d.color;
    ctx.fillRect(px, py, 1, 1);
    return;
  }
  if (d.kind === "fruit") {
    // A little round fruit: an ink outline with its corners cut, the fruit's
    // colour, a lit cheek on its upper left, a deeper shade on its lower
    // right, and a stalk on top (a leaf with it, while it's still falling).
    const lit = d.color === "#f6c83a" ? "#fde58a" : "#ffb0bc";
    const deep = shadeOf(d.color);
    ctx.fillStyle = "#3a1406";
    ctx.fillRect(px - 1, py - 2, 4, 1);
    ctx.fillRect(px - 2, py - 1, 6, 3);
    ctx.fillRect(px - 1, py + 2, 4, 1);
    ctx.fillStyle = d.color;
    ctx.fillRect(px - 1, py - 1, 4, 3);
    ctx.fillStyle = lit;
    ctx.fillRect(px - 1, py - 1, 1, 1);
    ctx.fillRect(px, py - 1, 1, 1);
    ctx.fillStyle = deep;
    ctx.fillRect(px + 2, py, 1, 2);
    ctx.fillRect(px + 1, py + 1, 1, 1);
    ctx.fillStyle = "#5a3a1a";
    ctx.fillRect(px + 1, py - 3, 1, 1);
    if (!resting) {
      ctx.fillStyle = "#6aa03a";
      ctx.fillRect(px + 2, py - 3, 1, 1);
    }
    return;
  }
  // Leaves, petals, feathers, shavings: lying flat, a lit pixel and a shaded one.
  const flat = resting && d.size === 2;
  const across = hash(d.seed, 1, 7) < 0.5;
  ctx.fillStyle = d.color;
  ctx.fillRect(px, py, 1, 1);
  if (flat || d.size === 2) {
    ctx.fillStyle = resting ? shadeOf(d.color) : d.color;
    ctx.fillRect(px + (across ? 1 : 0), py + (across ? 0 : 1), 1, 1);
  }
}

/** A colour a shade darker, for the far edge of something lying on the ground. */
function shadeOf(color: string): string {
  const n = parseInt(color.slice(1), 16);
  const f = (v: number): number => Math.round(v * 0.78);
  const c = (f((n >> 16) & 255) << 16) | (f((n >> 8) & 255) << 8) | f(n & 255);
  return `#${c.toString(16).padStart(6, "0")}`;
}

/** Is (x, y) the pond's water? For keeping ripples on it. */
function waterAt(farm: Farm): (x: number, y: number) => boolean {
  return (x, y) => farm.surface[Math.round(y) * farm.width + Math.round(x)] === SURFACE.water;
}

/** The pond's base line: what's on its water is drawn just after it. */
function waterDepth(farm: Farm): number {
  return farm.things.find((t) => t.kind === "pond")?.base ?? farm.ambient.pond.y;
}
