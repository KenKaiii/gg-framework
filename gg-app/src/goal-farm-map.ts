// The farm a started Goal's team works on: the farmstead layout (a thatched
// farmhouse, a storehouse, a koi pond, fields, a tea bench by the fire) plus
// everything the live view needs to bring it to life: where each station's
// critters stand, the yard's walkways, the things paths must not cross, and
// the anchors for what moves (fire, steam, koi, petals, animals). The core
// farm is fixed at 30×19 tiles; a bigger window gets more countryside around
// it, so the map always fills the view edge to edge. Pure.

import { E, WARM_INK, hash, mix, stream, type PixelBuffer } from "./goal-map-pixels";
import { GRASS_SUN, GridBuilder, TILE } from "./goal-map-ground";
import type { MapScene, PlacedProp } from "./goal-map-compose";
import { lean, type Sprite } from "./goal-map-props";
import {
  K,
  camelliaTree,
  dragonfly,
  flowerClump,
  petals,
  sakuraTree,
  steam,
  tallGrass,
  yuzuTree,
} from "./goal-map-cozy";
import {
  bookcase,
  fishingSpot,
  laptopTable,
  dirtPatch,
  grassSprig,
  pebbles,
  cropPlot,
  fieldFence,
  stone,
  teaRows,
  twig,
} from "./goal-map-farm";
import {
  animalSprite,
  annexTop,
  benchTop,
  canopyTree,
  farmhouseTop,
  fireTop,
  CAT_LIT,
  HEN_LIT,
  lightAnimal,
  kennelTop,
  kuraTop,
  lanternTop,
  moundShrub,
  notesBoardTop,
  pondSpout,
  pondTop,
  POND_WATER,
  postBoxTop,
  SHIBA_ASLEEP,
  SHIBA_COLORS,
  stoveTop,
  teaBenchTop,
  toriiTop,
  tubTop,
} from "./goal-map-topdown";
import type { PathGraph, Spot } from "./goal-farm-travel";
import { SolidMask, planRoute, type Roamer, type RoamerKind } from "./goal-farm-roam";
import { lightRelief, type FarmLamp, type LightRelief } from "./goal-farm-sky";
import type { ThingKind } from "./goal-farm-interact";
import type { StationKind } from "./goal-world-stations";

/** The farmstead itself, in tiles. */
export const FARM_CORE = { cols: 30, rows: 19 } as const;

/** The standard ground colours, warmed into this world's earthy palette. */
export const WARM_GROUND: ReadonlyMap<number, number> = new Map<number, number>([
  [E.green2, K.grass],
  [GRASS_SUN, 0x9aad2c],
  [E.green1, K.grassDark],
  // Thick clumps and lit blade tips (see the grass texture).
  [mix(E.green2, E.green1, 0.4), mix(K.grass, K.grassDark, 0.55)],
  [mix(E.green2, E.green3, 0.6), K.grassLight],
  [E.green3, K.grassLight],
  [E.teal0, K.grassDeep],
  [E.leaf, K.grassLight],
  [E.tan, K.soil],
  [mix(E.tan, E.sand, 0.35), mix(K.soil, K.soilLight, 0.4)],
  [mix(E.tan, E.bark3, 0.25), mix(K.soil, K.soilDark, 0.5)],
  [mix(E.tan, E.bark3, 0.55), K.soilDark],
  [mix(E.tan, E.bark3, 0.6), K.soilDark],
  [E.bark3, K.soilDark],
  [E.sand, mix(K.soil, K.soilLight, 0.55)],
  [E.blue2, K.water],
  [E.blue1, K.waterDark],
  [E.sky, K.waterLight],
  [E.navy, 0x3f8f96],
  // Cliff faces and stair edges: from cold bark to warm earth.
  [E.bark1, 0x7a4a1c],
  [E.bark2, 0xa0682a],
  [mix(E.bark2, E.bark1, 0.35), 0x8e5a24],
  [mix(E.bark2, E.bark3, 0.35), 0xb07a36],
  [mix(E.bark2, E.bark1, 0.5), 0x86531f],
]);

/** An axis-aligned box on the map: something paths must go around. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The places that move in the live view, in map pixels. */
export interface Ambient {
  /** The campfire pit (flames rise from here). */
  readonly fire: Spot;
  /** Where steam leaves the kettle and the stove's pots. */
  readonly steam: readonly Spot[];
  /** The middle of the koi pond, and how far the koi may swim from it. */
  readonly pond: {
    readonly x: number;
    readonly y: number;
    readonly rx: number;
    readonly ry: number;
  };
  /** Blossom canopies petals drift down from. */
  readonly blossoms: ReadonlyArray<{ readonly x: number; readonly y: number; readonly r: number }>;
  /** The bamboo spout: the end of its pipe, and where its water hits the pond. */
  readonly spout: { readonly mouth: Spot; readonly pour: Spot };
  /** Where the dragonfly hovers. */
  readonly dragonfly: Spot;
  /** Where the shiba sleeps, by its kennel (its feet). */
  readonly shiba: Spot;
  /** A lily pad, for the dragonfly to land on. */
  readonly lilyPad: Spot;
  /** The cat and the hens, each wandering its own loop clear of everything drawn. */
  readonly roamers: readonly Roamer[];
  /** Where butterflies flit about: over the flowers and the blossom. */
  readonly butterflies: readonly Spot[];
  /** Where fireflies drift after dark: over the pond, the bushes and the long grass. */
  readonly fireflies: readonly Spot[];
}

export interface Farm {
  /** The static map (ground and props; no critters, nothing that moves). */
  readonly scene: MapScene;
  /** Where the farmstead's top-left corner sits on the map, in pixels. */
  readonly origin: Spot;
  readonly width: number;
  readonly height: number;
  /** Where critters stand at each station, slot by slot (slot 0 first). */
  readonly stations: Readonly<Record<StationKind, readonly Spot[]>>;
  /**
   * What a critter at each station is using (the bookcase, the laptop, the
   * pond's water for fishing…): it turns to face this while it works, and a
   * fishing line lands near it.
   */
  readonly lookAt: Readonly<Record<StationKind, Spot>>;
  /** The yard's walkways. */
  readonly paths: PathGraph;
  /** What walkways keep clear of (buildings, the pond, trunks, beds, hedges). */
  readonly obstacles: readonly Rect[];
  /**
   * The ground a critter's feet can't cross, pixel by pixel (1 = blocked):
   * where each standing thing actually meets the ground (a desk's or a
   * building's base, a tree's trunk), and the water. Walking behind
   * something tall (under a canopy, past a roof) is fine; walking through
   * its base isn't. See createRouter.
   */
  readonly walk: WalkMask;
  readonly ambient: Ambient;
  /** What glows after dark: the stone lanterns, the house's paper windows, the fire, the stove. */
  readonly lamps: readonly FarmLamp[];
  /** Everything standing or lying still that can be poked (see goal-farm-interact). */
  readonly things: readonly Thing[];
  /** What each map pixel is, for weather to settle on (see SURFACE); width × height. */
  readonly surface: Uint8Array;
  /**
   * What stands where, for light to fall on and be blocked by: for each map
   * pixel, the index of the standing thing drawn there (-1 for none, or for
   * the pond, which is too low to block light), and each thing's height in
   * pixels, foot line and last sky-facing row (map y).
   */
  readonly solids: {
    readonly owner: Int32Array;
    readonly heights: readonly number[];
    readonly bases: readonly number[];
    readonly tops: readonly number[];
    /** The base line of the nearest standing thing drawn at each pixel, or -1 (see classifySurface). */
    readonly front: Int16Array;
  };
  /** Where each pixel's surface stands and faces, for lamplight (see lightRelief). */
  readonly relief: LightRelief;
  /**
   * Everything standing that something moving could pass behind: its sprite,
   * where it's drawn (top-left, map pixels) and its base line. The live view
   * redraws one over a critter or animal whose feet are higher up the map
   * than its base, so they walk behind trees and buildings, never over them.
   */
  readonly occluders: readonly Occluder[];
}

/**
 * Something on the farm that can be poked: what it is, its name, where its
 * sprite sits (top-left, map pixels) and its base line (front-most wins a
 * click), which lamps it switches (lights only), and its index among the
 * occluders (to redraw it when it shakes), or -1.
 */
export interface Thing {
  readonly id: string;
  readonly kind: ThingKind;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly base: number;
  readonly buf: PixelBuffer;
  readonly flip: boolean;
  readonly lamps: readonly number[];
  readonly occluder: number;
}

export interface Occluder {
  readonly buf: PixelBuffer;
  readonly x: number;
  readonly y: number;
  readonly base: number;
  readonly flip: boolean;
  /** Its rows up to this one face the sky (a roof, a canopy's top); below, its sides. */
  readonly topRow: number;
  /** The prop it's drawn from (to paint the map without it, see paintSwayBase). */
  readonly prop: PlacedProp;
}

/**
 * What each map pixel is, for weather to settle on: the ground (grass, dirt,
 * paths), the sky-facing top of something standing (a roof, a canopy, a
 * lantern's cap, the pond's stones), its side (a wall, a trunk: nothing
 * settles), water, or something flat on the ground (a stepping stone, a
 * field). See Farm.surface.
 */
export const SURFACE = { ground: 0, top: 1, side: 2, water: 3, flat: 4 } as const;
export type SurfaceCode = (typeof SURFACE)[keyof typeof SURFACE];

/**
 * The last row of a standing prop that faces the sky. For a building, its
 * whole roof down to the eave (where it's widest). For anything else, its
 * widest row (a canopy's middle, a lantern's cap) but never past its upper
 * part: a well, a desk or a bookcase is open to the sky only on top.
 */
export function topRowFor(p: PlacedProp): number {
  const widest = topRowOf(p.sprite.buf);
  return p.roof ? widest : Math.min(widest, Math.floor(p.sprite.buf.height * TOP_SHARE));
}

/** How much of a non-building prop can face the sky, from its top down. */
const TOP_SHARE = 0.42;

/** The lowest row where a sprite is widest. */
export function topRowOf(buf: PixelBuffer): number {
  let best = 0;
  let row = 0;
  for (let y = 0; y < buf.height; y++) {
    let n = 0;
    for (let x = 0; x < buf.width; x++) if (buf.opaque(x, y)) n++;
    if (n >= best && n > 0) {
      best = n;
      row = y;
    }
  }
  return row;
}

/** The pond's water colours, to tell its water from its stones. */
const WATER_COLORS: ReadonlySet<number> = new Set(Object.values(POND_WATER));

/**
 * Classify every map pixel (see SURFACE). Standing things are laid down back
 * to front, so the nearest one wins; grass and flowers count as the ground
 * they grow in (snow covers them).
 */
function classifySurface(
  width: number,
  height: number,
  props: readonly PlacedProp[],
  filler: ReadonlyMap<PlacedProp, PlacedProp | undefined>,
  pond: PlacedProp,
): {
  surface: Uint8Array;
  owner: Int32Array;
  heights: number[];
  bases: number[];
  tops: number[];
  front: Int16Array;
} {
  const out = new Uint8Array(width * height);
  const owner = new Int32Array(width * height).fill(-1);
  // The base line (map y of its foot) of the nearest standing thing drawn at
  // each pixel, or -1: anything with a lower base is behind it there.
  const front = new Int16Array(width * height).fill(-1);
  const heights = props.map((p) => p.sprite.buf.height);
  const bases = props.map((p) => Math.floor(p.y));
  const tops = props.map((p) => footprint(p).y0 + topRowFor(p));
  const order = props
    .filter((p) => !filler.has(p) && !p.hidden)
    .sort((a, b) => Number(!a.flat) - Number(!b.flat) || a.y - b.y || a.x - b.x);
  for (const p of order) {
    const index = props.indexOf(p);
    const { buf } = p.sprite;
    const box = footprint(p);
    const tall = !p.flat && buf.height > 12;
    if (!p.flat && !tall) continue;
    const top = tall ? topRowFor(p) : buf.height;
    for (let sy = 0; sy < buf.height; sy++) {
      const y = box.y0 + sy;
      if (y < 0 || y >= height) continue;
      for (let sx = 0; sx < buf.width; sx++) {
        const x = box.x0 + sx;
        if (x < 0 || x >= width) continue;
        const bx = p.flip ? buf.width - 1 - sx : sx;
        if (!buf.opaque(bx, sy)) continue;
        let code: SurfaceCode;
        if (p.flat) code = SURFACE.flat;
        else if (p === pond) code = WATER_COLORS.has(buf.rgb(bx, sy)) ? SURFACE.water : SURFACE.top;
        else code = sy <= top ? SURFACE.top : SURFACE.side;
        out[y * width + x] = code;
        owner[y * width + x] = p.flat || p === pond ? -1 : index;
        if (!p.flat) front[y * width + x] = Math.floor(p.y);
      }
    }
  }
  return { surface: out, owner, heights, bases, tops, front };
}

export interface FarmOptions {
  /** Map size in tiles; never smaller than the farmstead. */
  readonly cols?: number;
  readonly rows?: number;
  /** Varies the countryside around the farmstead (the farmstead never changes). */
  readonly seed?: number;
  /**
   * Tiles at the top the farmstead keeps below: the window's see-through
   * header sits over them, so only countryside shows there.
   */
  readonly top?: number;
  /**
   * A still picture: bake the fire's flames, steam, koi and animals into the
   * map. The live view leaves them out and animates them itself.
   */
  readonly still?: boolean;
}

// ── Where things are, in farmstead pixels ─────────────────────

/**
 * What glows after dark, in farmstead pixels: where its light shows on the
 * map (see placeLamps for where it really stands, and how high). A window's
 * light is set in its wall.
 */
const LAMPS: ReadonlyArray<{
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly strength: number;
  readonly wall?: boolean;
}> = [
  // The stone lanterns either side of the way up to the door.
  { x: 254, y: 110, r: 30, strength: 1 },
  { x: 300, y: 110, r: 30, strength: 1 },
  // The farmhouse's paper windows, lit from inside.
  { x: 128, y: 90, r: 24, strength: 0.75, wall: true },
  { x: 165, y: 90, r: 24, strength: 0.75, wall: true },
  { x: 205, y: 90, r: 24, strength: 0.75, wall: true },
  { x: 245, y: 90, r: 22, strength: 0.65, wall: true },
  { x: 280, y: 90, r: 22, strength: 0.65, wall: true },
  // The side building's window.
  { x: 70, y: 92, r: 18, strength: 0.55, wall: true },
  // The campfire, the brightest thing on the farm at night.
  { x: 398, y: 204, r: 50, strength: 1 },
  // The stove's fire mouths.
  { x: 456, y: 150, r: 22, strength: 0.7 },
];

/** What each station's critters use, in farmstead pixels (see Farm.lookAt). */
const LOOK_AT: Readonly<Record<StationKind, readonly [number, number]>> = {
  door: [24, 212],
  workbench: [416, 150],
  machine: [456, 150],
  bookcase: [122, 110],
  // Open water at the pond's east side, where the lines go in.
  maptable: [114, 168],
  computer: [196, 130],
  whiteboard: [374, 100],
  mailbox: [52, 208],
  lounge: [398, 204],
};

const SPOTS: Readonly<Record<StationKind, ReadonlyArray<readonly [number, number]>>> = {
  door: [
    [25, 226],
    [42, 230],
    [10, 232],
    [56, 236],
  ],
  bookcase: [
    [122, 129],
    [108, 127],
    [136, 130],
    [96, 123],
  ],
  computer: [
    [190, 148],
    [204, 149],
    [216, 143],
    [182, 141],
  ],
  whiteboard: [
    [372, 119],
    [386, 121],
    [358, 122],
  ],
  workbench: [
    [413, 167],
    [400, 169],
  ],
  machine: [
    [455, 168],
    [468, 171],
  ],
  maptable: [
    [148, 188],
    [160, 194],
  ],
  mailbox: [
    [62, 227],
    [72, 231],
  ],
  lounge: [
    [330, 214],
    [350, 215],
    [382, 222],
    [414, 223],
    [398, 231],
    [366, 225],
    [310, 220],
  ],
};

/** The walkways: one node by every station, and the junctions between them. */
const PATH_NODES: ReadonlyArray<readonly [number, number]> = [
  [25, 228], // 0 the gate
  [44, 230], // 1 just inside the gate
  [62, 228], // 2 the post box
  [100, 214], // 3 below the pond
  [148, 192], // 4 the fishing spot
  [190, 180], // 5 past the tub
  [222, 182], // 6 the lane, halfway
  [222, 140], // 7 the top of the lane
  [196, 148], // 8 the laptop
  [122, 129], // 9 the bookcase
  [96, 120], // 10 the yard, west
  [262, 140], // 11 the yard in front of the house
  [314, 134], // 12 the yard, east
  [372, 121], // 13 the notes board
  [394, 132], // 14 east of the notes board, before the storehouse
  [413, 169], // 15 the carpenter's bench
  [455, 170], // 16 the stove
  [382, 168], // 17 under the blossom
  [382, 224], // 18 the fire, west
  [334, 216], // 19 the tea bench
  [416, 226], // 20 the fire, east
  [222, 214], // 21 the lane, low
  [300, 214], // 22 the yard, south-east
];

const PATH_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [7, 9],
  [9, 10],
  [7, 11],
  [11, 12],
  [12, 13],
  [13, 14],
  // The bench is reached from below (via 17): a walkway down from 14 would
  // run through the bench itself.
  [15, 16],
  [15, 17],
  [13, 17],
  [17, 18],
  [18, 19],
  [18, 20],
  [20, 16],
  [6, 21],
  [21, 22],
  [22, 19],
  [21, 3],
];

/** Footprints walkways must not cross (farmstead pixels). */
const OBSTACLES: ReadonlyArray<readonly [number, number, number, number]> = [
  [100, 0, 210, 116], // the farmhouse and its veranda
  [18, 50, 78, 50], // the side building
  [50, 188, 48, 22], // the shrubs in front of the pond
  [30, 134, 114, 56], // the koi pond, its stones and the bamboo spout
  [146, 144, 32, 22], // the well
  [322, 76, 32, 30], // the kennel
  [358, 78, 32, 30], // the notes board
  [413, 6, 62, 116], // the storehouse and its platform
  [398, 138, 36, 20], // the carpenter's bench
  [438, 134, 36, 24], // the stove
  [318, 176, 44, 34], // the tea bench and parasol
  [384, 188, 28, 24], // the fire pit
  [16, 124, 14, 12], // tree trunks
  [284, 160, 10, 16],
  [328, 138, 8, 14],
  [360, 170, 8, 12],
  [262, 196, 8, 10],
  [452, 190, 8, 10],
  [72, 226, 128, 12], // the hedgerows
  [248, 226, 52, 12],
  [424, 226, 56, 12],
  [8, 262, 466, 42], // the fields
];

// ── Building the farm ─────────────────────────────────────────

/** Lay out the farm on a map of `cols × rows` tiles (at least the farmstead). */
export function buildFarm(options: FarmOptions = {}): Farm {
  const cols = Math.max(FARM_CORE.cols, Math.floor(options.cols ?? FARM_CORE.cols));
  const rows = Math.max(FARM_CORE.rows, Math.floor(options.rows ?? FARM_CORE.rows));
  const still = options.still ?? false;
  const seed = options.seed ?? 13;
  const top = Math.max(0, Math.floor(options.top ?? 0));
  const tox = Math.floor((cols - FARM_CORE.cols) / 2);
  // Centred in the part of the map below the header, never off the map.
  const toy = Math.max(
    0,
    Math.min(rows - FARM_CORE.rows, top + Math.floor((rows - top - FARM_CORE.rows) / 2)),
  );
  const ox = tox * TILE;
  const oy = toy * TILE;
  const at = (x: number, y: number): Spot => ({ x: x + ox, y: y + oy });

  // ── Ground: worn earth in front of the house and down the lane ──
  const g = new GridBuilder(cols, rows);
  g.rect(3 + tox, 5 + toy, 25, 3, "d");
  g.ellipse(15 + tox, 9 + toy, 12, 4.2, "d");
  // The lane: trodden earth under the stepping stones, all the way down to the fields.
  g.rect(13 + tox, 9 + toy, 3, 10, "d");
  g.ellipse(26 + tox, 8.5 + toy, 4, 3, "d");
  // The pond sits in its own patch of grass, not on the bare yard.
  g.ellipse(5.6 + tox, 10.2 + toy, 3.9, 2.7, ".");
  g.ellipse(4 + tox, 12.6 + toy, 4.4, 1.6, "d");
  // The lane out through the gate runs on to the edge of the map.
  g.rect(0, 12 + toy, 3 + tox, 2, "d");
  g.ellipse(9.5 + tox, 7.3 + toy, 1.4, 0.8, ".");
  g.ellipse(20.6 + tox, 10.6 + toy, 1.7, 1, ".");
  g.ellipse(17.4 + tox, 6.6 + toy, 0.9, 0.7, ".");

  const props: PlacedProp[] = [];
  const P = (sprite: Sprite, x: number, y: number, extra: Partial<PlacedProp> = {}): PlacedProp => {
    const p: PlacedProp = { sprite, x: x + ox, y: y + oy, ...extra };
    props.push(p);
    return p;
  };
  const flat = (sprite: Sprite, x: number, y: number): PlacedProp => {
    const p: PlacedProp = { sprite, x: x + ox, y: y + oy, flat: true };
    props.push(p);
    return p;
  };
  // Everything that can be poked, tagged as it's placed (see Farm.things).
  const tagged: Array<{
    prop: PlacedProp;
    kind: ThingKind;
    name: string;
    lamps: readonly number[];
  }> = [];
  const T = (
    prop: PlacedProp,
    kind: ThingKind,
    name: string,
    lamps: readonly number[] = [],
  ): PlacedProp => {
    tagged.push({ prop, kind, name, lamps });
    return prop;
  };
  // Grass and flowers grow round things, never over them: these are dropped
  // wherever they'd overlap anything else that's drawn (see `clearFiller`).
  const filler = new Map<PlacedProp, PlacedProp | undefined>();
  const bare = new Set<PlacedProp>();
  /** Place grass or flowers; `owner` is the one thing it may grow against. */
  const F = (sprite: Sprite, x: number, y: number, owner?: PlacedProp): void => {
    const p: PlacedProp = { sprite, x: x + ox, y: y + oy };
    props.push(p);
    filler.set(p, owner);
  };

  // ── Buildings along the top ──
  const annex = P(lean(annexTop(301)), 58, 98, { roof: true });
  const house = P(
    lean(
      farmhouseTop(302, ["shoji", "shojiOpen", "shoji", "blind", "glass", "room"], 0x3a5a9a),
      0.16,
      0,
    ),
    205,
    112,
    { roof: true },
  );
  T(annex, "annex", "Side house", [7]);
  T(house, "house", "Farmhouse", [2, 3, 4, 5, 6]);
  const kennel = T(P(lean(kennelTop(), 0.08), 335, 104, { roof: true }), "kennel", "Kennel");
  // The shiba sleeps here; it's drawn live (it can wake), so it only holds its place.
  // The shiba asleep by its kennel, lit like the critters.
  const shiba = lightAnimal(
    SHIBA_ASLEEP,
    SHIBA_COLORS,
    { k: "O", l: "o", h: "o", s: "o", c: "w", e: "K", n: "N" },
    { o: "fur", w: "fur", K: "flat", N: "flat" },
    53,
  );
  P(animalSprite(shiba.rows, shiba.palette), 338, 114, { hidden: true });
  const board = T(P(lean(notesBoardTop(303)), 374, 106, { roof: true }), "board", "Notice board");
  const kura = T(P(lean(kuraTop(304)), 444, 120, { roof: true }), "kura", "Storehouse");
  T(P(sakuraTree(305, false), 470, 44), "sakura", "Cherry tree");
  T(P(moundShrub(306, "olive", 12), 396, 50), "bush", "Bush");

  // ── The lane: stepping stones from the fields up to the door ──
  const lane: ReadonlyArray<readonly [number, number, "m" | "l"]> = [
    // Up from the fields, curving right to the door under the noren.
    [276, 121, "l"],
    [264, 136, "m"],
    [250, 149, "m"],
    [235, 160, "l"],
    [220, 172, "m"],
    [226, 188, "m"],
    [217, 205, "m"],
    [226, 222, "l"],
    [217, 240, "m"],
    [226, 258, "m"],
    [218, 277, "l"],
    [226, 296, "m"],
  ];
  lane.forEach(([x, y, size], i) =>
    T(flat(stone(310 + i * 7, size, i % 4 === 3), x, y), "stone", "Stepping stone"),
  );
  // A lantern each side of the way up to the door.
  T(P(lean(lanternTop(), 0.1, 0.1), 254, 124), "lantern", "Stone lantern, left", [0]);
  T(P(lean(lanternTop(), 0.1, 0.1), 300, 124), "lantern", "Stone lantern, right", [1]);

  // ── The front yard: the reading and web corners in front of the veranda ──
  // The bookcase at the veranda's west end; the laptop out in the yard, well
  // apart, so critters reading and critters coding don't crowd one spot.
  T(P(lean(bookcase(311), 0.1, 0.1), 122, 116), "bookcase", "Bookcase");
  T(P(lean(laptopTable(), 0.08, 0.14), 196, 136), "laptop", "Laptop desk");
  P(stone(312, "s"), 106, 118);
  P(stone(313, "s", true), 186, 112);

  // ── The pond (its bamboo spout is part of it), the well and the fishing spot ──
  const pond = T(P(pondTop(66, 38, 314, still), 92, 190), "pond", "Koi pond");
  T(P(lean(tubTop(), 0.08, 0.1), 162, 164), "well", "Well");
  // The creel by the fishing spot (critters who are searching bring their own rods).
  T(P(fishingSpot(), 140, 182, { flip: true }), "creel", "Fishing creel");
  T(P(canopyTree(315, "green", 1.05), 22, 134), "tree", "Shade tree");
  // Shrubs and long grass crowding the pond's near stones.
  T(P(moundShrub(337, "amber", 8), 62, 204), "bush", "Bush");
  T(P(moundShrub(338, "green", 9), 84, 208), "bush", "Bush");
  F(tallGrass(341), 46, 190);
  F(tallGrass(342), 104, 196);
  F(tallGrass(343, "gold"), 140, 180);
  F(tallGrass(344), 40, 144);
  F(flowerClump(345, 0xf6d24a), 120, 196);
  T(P(sakuraTree(316), 24, 64), "sakura", "Cherry tree");
  flat(petals(317, 10, 16), 24, 74);

  // ── The gate out on the left, the post box by it ──
  T(P(lean(toriiTop(), 0.06, 0.14), 24, 220), "torii", "Torii gate");
  T(P(lean(postBoxTop(), 0.1, 0.12), 52, 216), "postbox", "Post box");

  // ── The right yard: shade, blossom over the tea bench, the fire ──
  T(P(canopyTree(318, "olive", 0.9), 288, 176), "tree", "Shade tree");
  T(P(sakuraTree(319), 332, 152), "sakura", "Cherry tree");
  T(P(sakuraTree(320, false), 364, 182), "sakura", "Cherry tree");
  flat(petals(321, 12, 18), 340, 160);
  flat(petals(322, 8, 14), 366, 190);
  T(P(lean(teaBenchTop(), 0.08, 0.12), 340, 208), "teabench", "Tea bench");
  T(P(fireTop(still), 398, 210), "campfire", "Campfire", [8]);
  T(P(camelliaTree(324), 266, 206), "camellia", "Camellia tree");
  T(P(yuzuTree(325), 456, 200), "yuzu", "Yuzu tree");

  // ── Work, by the storehouse: the carpenter's bench and the stove ──
  T(P(lean(benchTop(), 0.08, 0.14), 416, 156), "bench", "Carpenter's bench");
  T(P(lean(stoveTop(), 0.08, 0.12), 456, 156), "stove", "Stove");

  // ── A hedgerow between the yard and the fields, open where the lane runs ──
  const hedge = (x0: number, x1: number, y: number, s: number): void => {
    let x = x0;
    let i = 0;
    while (x < x1) {
      const tone = (["olive", "green", "amber", "green", "olive"] as const)[(s + i) % 5] ?? "green";
      const large = hash(i, 1, s) < 0.4;
      T(
        P(moundShrub(s + i, tone, large ? 12 : 9), x, y + Math.round((hash(i, 2, s) - 0.5) * 4)),
        "bush",
        "Bush",
      );
      x += large ? 22 : 17;
      i++;
    }
  };
  hedge(72, 200, 236, 330);
  hedge(248, 300, 236, 350);
  hedge(424, 480, 236, 360);

  // ── The fields along the bottom ──
  // Plots dug into the grass (flat on the ground), each fenced along its front.
  const field = (plot: Sprite, x: number, seed: number, name: string): void => {
    T(flat(plot, x, 300), "field", name);
    P(fieldFence(plot.buf.width - 4, seed), x, 306);
  };
  field(cropPlot("rice", 6, 2, 331), 52, 335, "Rice paddy");
  field(cropPlot("carrot", 5, 2, 332), 152, 336, "Carrot field");
  field(cropPlot("daikon", 5, 2, 333), 300, 337, "Daikon field");
  field(teaRows(76, 3, 334), 430, 338, "Tea rows");
  T(P(moundShrub(335, "amber"), 6, 286), "bush", "Bush");
  T(P(moundShrub(336, "olive", 10), 368, 298), "bush", "Bush");

  // ── Filler: tall grass, flowers, twigs, pebbles ──
  const tufts: ReadonlyArray<readonly [number, number]> = [
    [92, 96],
    [160, 100],
    [262, 102],
    [304, 112],
    [188, 156],
    [250, 166],
    [178, 196],
    [204, 222],
    [242, 228],
    [120, 212],
    [96, 226],
    [30, 180],
    [16, 248],
    [62, 240],
    [312, 214],
    [292, 236],
    [420, 180],
    [470, 172],
    [384, 232],
    [350, 236],
    [248, 278],
    [202, 268],
    [118, 250],
    [24, 302],
    [474, 258],
    [404, 252],
    [62, 120],
    [136, 134],
    [300, 132],
    [326, 120],
  ];
  tufts.forEach(([x, y], i) => F(tallGrass(340 + i, i % 5 === 0 ? "gold" : "green"), x, y));
  const blooms: ReadonlyArray<readonly [number, number, number]> = [
    [70, 226, 0xf6d24a],
    [184, 212, 0xffffff],
    [254, 196, 0xf2b6c6],
    [312, 228, 0xd8394a],
    [42, 196, 0xf2b6c6],
    [418, 196, 0xf6d24a],
    [138, 226, 0xffffff],
  ];
  blooms.forEach(([x, y, color], i) => F(flowerClump(380 + i, color), x, y));
  const litter: ReadonlyArray<readonly [number, number]> = [
    [200, 182],
    [246, 210],
    [122, 140],
    [310, 140],
    [392, 166],
    [60, 136],
  ];
  litter.forEach(([x, y], i) => flat(i % 2 === 0 ? twig(390 + i) : pebbles(390 + i), x, y));

  // ── Bare patches worn into the grass, here and there ──
  const patchRnd = stream(seed * 53 + 7);
  const onGrass = (x: number, y: number, r: number): boolean =>
    !OBSTACLES.some(
      ([ox2, oy2, w, h]) => x + r > ox2 && x - r < ox2 + w && y + r > oy2 && y - r < oy2 + h,
    ) && (g.cells[Math.floor((y + oy) / TILE) * cols + Math.floor((x + ox) / TILE)] ?? ".") === ".";
  let placed = 0;
  for (let tries = 0; tries < 400 && placed < 16; tries++) {
    const x = 8 + patchRnd() * (FARM_CORE.cols * TILE - 16);
    const y = 8 + patchRnd() * (FARM_CORE.rows * TILE - 16);
    const big = patchRnd() < 0.35;
    if (!onGrass(x, y, big ? 16 : 9)) continue;
    flat(dirtPatch(seed * 61 + placed, big ? "l" : "s"), Math.round(x), Math.round(y));
    const patch = props[props.length - 1];
    if (patch) bare.add(patch);
    placed++;
  }
  // Grass poking out along the foot of each building: sprigs rooted on its
  // drawn bottom edge, so they follow its leaned outline.
  for (const building of [annex, house, kennel, board, kura]) {
    const box = footprint(building);
    for (let x = box.x0 + 4; x < box.x1 - 4; x += 6 + Math.floor(patchRnd() * 9)) {
      if (patchRnd() < 0.3) continue;
      let y = box.y1 - 1;
      while (y > box.y0 && !box.at(x, y)) y--;
      if (y <= box.y0) continue;
      F(grassSprig(seed * 67 + x), x - ox, y + 2 - oy, building);
    }
  }

  clearFiller(props, filler, bare);

  // ── What moves: baked in for a still picture, animated otherwise ──
  const occ = occupancy(props, filler, ox, oy);
  const slots = planSlots(occ);
  const spout = pondSpout(66, 38);
  const ambient: Ambient = {
    fire: at(398, 201),
    // The campfire's pot (its lid, low over the fire), then the stove's pots.
    steam: [at(398, 192), at(452, 138), at(462, 138)],
    pond: { ...at(92, 162), rx: 15, ry: 6 },
    blossoms: [
      { ...at(470, 29), r: 10 },
      { ...at(24, 43), r: 14 },
      { ...at(332, 131), r: 14 },
      { ...at(364, 167), r: 10 },
    ],
    spout: {
      mouth: at(92 + spout.mouth.x, 190 + spout.mouth.y),
      pour: at(92 + spout.pour.x, 190 + spout.pour.y),
    },
    dragonfly: at(104, 150),
    shiba: at(338, 114),
    lilyPad: at(92 + 14, 190 - 22),
    roamers: planRoamers(occ, Object.values(slots).flat(), seed).map((r) => ({
      ...r,
      route: r.route.map((spot) => at(spot.x, spot.y)),
    })),
    butterflies: [at(120, 190), at(262, 196), at(318, 226), at(70, 220), at(440, 96)],
    fireflies: [
      at(96, 150),
      at(70, 196),
      at(130, 206),
      at(36, 150),
      at(250, 214),
      at(330, 236),
      at(420, 232),
      at(456, 196),
      at(170, 236),
      at(300, 246),
      at(12, 120),
      at(470, 110),
    ],
  };
  if (still) {
    P(steam(323), 400, 188);
    P(steam(326), 458, 130);
    P(dragonfly(), 104, 150);
    for (const r of ambient.roamers) {
      const spot = r.route[0];
      if (!spot) continue;
      const sprite =
        r.kind === "cat"
          ? animalSprite(CAT_LIT.a.rows, CAT_LIT.a.palette)
          : animalSprite(HEN_LIT.stand.rows, HEN_LIT.stand.palette);
      props.push({ sprite, x: spot.x, y: spot.y });
    }
  }

  addCountryside(props, cols, rows, { ox, oy, seed, gateY: oy + 12 * TILE, headerY: top * TILE });

  const classified = classifySurface(cols * TILE, rows * TILE, props, filler, pond);
  const standing = standingProps(props, filler);
  const stations = Object.fromEntries(
    (Object.keys(slots) as StationKind[]).map((kind) => [
      kind,
      slots[kind].map(({ x, y }) => at(x, y)),
    ]),
  ) as Record<StationKind, Spot[]>;

  return {
    scene: {
      grid: g.build(),
      seed,
      groundColors: WARM_GROUND,
      ink: WARM_INK,
      hideLabels: true,
      props,
      critters: [],
    },
    origin: { x: ox, y: oy },
    width: cols * TILE,
    height: rows * TILE,
    stations,
    lookAt: Object.fromEntries(
      (Object.keys(LOOK_AT) as StationKind[]).map((kind) => {
        const [x, y] = LOOK_AT[kind];
        return [kind, at(x, y)];
      }),
    ) as Record<StationKind, Spot>,
    paths: {
      nodes: PATH_NODES.map(([x, y]) => at(x, y)),
      edges: PATH_EDGES,
    },
    obstacles: OBSTACLES.map(([x, y, w, h]) => ({ x: x + ox, y: y + oy, w, h })),
    ambient,
    lamps: placeLamps(
      LAMPS.map((l) => ({ ...l, ...at(l.x, l.y) })),
      classified,
      cols * TILE,
    ),
    surface: classified.surface,
    walk: walkMask(cols * TILE, rows * TILE, props, filler, classified.surface, pond),
    solids: {
      owner: classified.owner,
      heights: classified.heights,
      bases: classified.bases,
      tops: classified.tops,
      front: classified.front,
    },
    relief: lightRelief(cols * TILE, rows * TILE, classified),
    things: tagged.map(({ prop, kind, name, lamps }, i): Thing => {
      const box = footprint(prop);
      return {
        id: `${kind}-${i}`,
        kind,
        name,
        x: box.x0,
        y: box.y0,
        base: Math.floor(prop.y),
        buf: prop.sprite.buf,
        flip: prop.flip === true,
        lamps,
        occluder: standing.indexOf(prop),
      };
    }),
    occluders: standing.map((p): Occluder => {
      const box = footprint(p);
      return {
        buf: p.sprite.buf,
        x: box.x0,
        y: box.y0,
        base: Math.floor(p.y),
        flip: p.flip === true,
        topRow: topRowFor(p),
        prop: p,
      };
    }),
  };
}

/** Where a critter's feet can't go, in map pixels (see Farm.walk). */
export interface WalkMask {
  readonly width: number;
  readonly height: number;
  readonly blocked: Uint8Array;
}

/**
 * How deep into the picture a standing thing's base reaches, in rows up from
 * its foot line. A box (a desk, a building, the stove) covers the ground its
 * top covers, seen from the high camera: about as many rows as its top shows.
 * A tree stands on its trunk alone: a few rows, only as wide as the trunk.
 */
function groundDepth(p: PlacedProp): number {
  const { buf } = p.sprite;
  // How wide a row spans, from its leftmost drawn pixel to its rightmost (so
  // a desk's two legs span the desk, while a trunk spans only itself).
  const widthOf = (row: number): number => {
    let left = -1;
    let right = -1;
    for (let x = 0; x < buf.width; x++) {
      if (!buf.opaque(x, row)) continue;
      if (left < 0) left = x;
      right = x;
    }
    return left < 0 ? 0 : right - left + 1;
  };
  let first = 0;
  while (first < buf.height && widthOf(first) === 0) first++;
  let last = buf.height - 1;
  while (last > first && widthOf(last) === 0) last--;
  let widest = 0;
  for (let row = first; row <= last; row++) widest = Math.max(widest, widthOf(row));
  const foot = Math.max(widthOf(last), widthOf(last - 1), widthOf(last - 2));
  // Narrow at the bottom (a trunk, a post): only its foot meets the ground.
  if (foot < widest * 0.4) return 3;
  const top = Math.min(topRowFor(p), last);
  return Math.max(4, Math.min(24, top - first + 2));
}

/** The ground critters can't walk through (see Farm.walk). */
function walkMask(
  width: number,
  height: number,
  props: readonly PlacedProp[],
  filler: ReadonlyMap<PlacedProp, PlacedProp | undefined>,
  surface: Uint8Array,
  pond: PlacedProp,
): WalkMask {
  const blocked = new Uint8Array(width * height);
  for (let i = 0; i < blocked.length; i++) {
    if (surface[i] === SURFACE.water) blocked[i] = 1;
  }
  // The pond's ring of stones, which lies flat but isn't for walking on.
  const ring = footprint(pond);
  for (let y = Math.max(0, ring.y0); y < Math.min(height, ring.y1); y++) {
    for (let x = Math.max(0, ring.x0); x < Math.min(width, ring.x1); x++) {
      if (ring.at(x, y)) blocked[y * width + x] = 1;
    }
  }
  for (const p of props) {
    if (p.flat || p.hidden || filler.has(p)) continue;
    const box = footprint(p);
    const foot = Math.floor(p.y);
    const depth = groundDepth(p);
    for (let x = Math.max(0, box.x0); x < Math.min(width, box.x1); x++) {
      // Its base covers this column if any of it stands there, near the ground.
      let stands = false;
      for (let y = foot - depth; y <= foot && !stands; y++) stands = box.at(x, y);
      if (!stands) continue;
      for (let y = Math.max(0, foot - depth); y <= Math.min(height - 1, foot); y++) {
        blocked[y * width + x] = 1;
      }
    }
  }
  return { width, height, blocked };
}

/** Standing things worth redrawing over someone passing behind them (see Farm.occluders). */
function standingProps(
  props: readonly PlacedProp[],
  filler: ReadonlyMap<PlacedProp, PlacedProp | undefined>,
): PlacedProp[] {
  return props.filter((p) => !p.flat && !p.hidden && !filler.has(p) && p.sprite.buf.height > 12);
}

/** Where each animal lives and how far it wanders (farmstead pixels). */
const ROAMERS: ReadonlyArray<{
  readonly kind: RoamerKind;
  readonly home: readonly [number, number];
  readonly radius: number;
}> = [
  { kind: "hen", home: [396, 128], radius: 46 },
  { kind: "hen", home: [372, 150], radius: 40 },
  { kind: "hen", home: [276, 196], radius: 36 },
  { kind: "cat", home: [244, 252], radius: 60 },
];

/**
 * What stands where in the farmstead: for every pixel, the base line (map y
 * of its feet) of the front-most standing thing drawn there, or -1. Grass and
 * flowers don't count (anyone may walk through them), nor do flat things.
 */
interface Occupancy {
  readonly w: number;
  readonly h: number;
  readonly base: Int16Array;
  /** Is (x, y), in farmstead pixels, inside a footprint nothing may stand in? */
  readonly blocked: (x: number, y: number) => boolean;
}

function occupancy(
  props: readonly PlacedProp[],
  filler: ReadonlyMap<PlacedProp, PlacedProp | undefined>,
  ox: number,
  oy: number,
): Occupancy {
  const w = FARM_CORE.cols * TILE;
  const h = FARM_CORE.rows * TILE;
  const base = new Int16Array(w * h).fill(-1);
  for (const p of props) {
    if (p.flat || filler.has(p)) continue;
    const box = footprint(p);
    const feet = Math.floor(p.y) - oy;
    for (let y = Math.max(box.y0, oy); y < Math.min(box.y1, oy + h); y++) {
      for (let x = Math.max(box.x0, ox); x < Math.min(box.x1, ox + w); x++) {
        if (!box.at(x, y)) continue;
        const i = (y - oy) * w + (x - ox);
        if (feet > (base[i] ?? -1)) base[i] = feet;
      }
    }
  }
  return {
    w,
    h,
    base,
    blocked: (x, y) =>
      OBSTACLES.some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh),
  };
}

/** A critter's body on the ground: width and height, in pixels (feet at the bottom). */
const CRITTER_BODY = { w: 12, h: 14 } as const;
/** How far apart two critters must stand so neither covers the other. */
const SLOT_GAP = { x: 15, y: 16 } as const;
/** Slots planned per station, enough for a busy one. */
const SLOTS_PER_STATION = 8;

/**
 * Could a critter stand with its feet at (x, y)? Its feet clear of every
 * footprint and of anything drawn, and nothing standing in front of it
 * covering any part of its body (it would vanish behind it).
 */
function standable(occ: Occupancy, x: number, y: number): boolean {
  const { w, h } = CRITTER_BODY;
  if (x - w / 2 < 2 || x + w / 2 > occ.w - 2 || y - h < 2 || y > occ.h - 2) return false;
  for (let py = Math.floor(y - h); py <= y; py++) {
    for (let px = Math.floor(x - w / 2); px < Math.ceil(x + w / 2); px++) {
      if (occ.blocked(px, py) && py >= y - 3) return false;
      const front = occ.base[py * occ.w + px] ?? -1;
      if (front >= y || (py >= y - 2 && front >= 0)) return false;
    }
  }
  return true;
}

/**
 * Every station's slots: its named spots first, then spots in widening rings
 * round the first, keeping only those a critter can stand in and that are far
 * enough from every other slot (at this station or any other) that no two
 * critters ever stand on top of each other.
 */
function planSlots(occ: Occupancy): Record<StationKind, Spot[]> {
  const taken: Spot[] = [];
  const apart = (s: Spot): boolean =>
    taken.every((t) => Math.abs(t.x - s.x) >= SLOT_GAP.x || Math.abs(t.y - s.y) >= SLOT_GAP.y);
  const out = {} as Record<StationKind, Spot[]>;
  // Named spots first across every station, so a later station's rings can't take them.
  const kinds = Object.keys(SPOTS) as StationKind[];
  for (const kind of kinds) {
    out[kind] = [];
    for (const [x, y] of SPOTS[kind] ?? []) {
      const spot = { x, y };
      if (standable(occ, x, y) && apart(spot)) {
        out[kind].push(spot);
        taken.push(spot);
      }
    }
  }
  for (const kind of kinds) {
    const [cx, cy] = SPOTS[kind]?.[0] ?? [0, 0];
    for (let r = 10; r <= 64 && out[kind].length < SLOTS_PER_STATION; r += 6) {
      for (let k = 0; k < 16 && out[kind].length < SLOTS_PER_STATION; k++) {
        const a = (k / 16) * Math.PI * 2;
        const spot = {
          x: Math.round(cx + Math.cos(a) * r),
          y: Math.round(cy + Math.sin(a) * r * 0.55),
        };
        if (standable(occ, spot.x, spot.y) && apart(spot)) {
          out[kind].push(spot);
          taken.push(spot);
        }
      }
    }
  }
  return out;
}

/**
 * Plan every animal's wandering loop. Each keeps to its own patch (nearer its
 * home than any other animal's, with a gap between patches) so no two ever
 * walk into each other; none crosses a footprint, anything drawn, or the
 * spots where critters stand to work. Routes come back in farmstead pixels.
 */
function planRoamers(occ: Occupancy, slots: readonly Spot[], seed: number): Roamer[] {
  const homes = ROAMERS.map((r) => ({ x: r.home[0], y: r.home[1] }));
  return ROAMERS.map(({ kind, home, radius }, i) => {
    const own = homes[i] ?? { x: home[0], y: home[1] };
    const mask = new SolidMask(occ.w, occ.h, (x, y) => {
      if ((occ.base[y * occ.w + x] ?? -1) >= 0 || occ.blocked(x, y)) return true;
      // Where critters stand to work.
      if (slots.some((s) => Math.abs(s.x - x) < 9 && y <= s.y + 2 && y >= s.y - 12)) return true;
      // Another animal's patch, with a gap between.
      const mine = Math.hypot(x - own.x, (y - own.y) / 0.6);
      return homes.some((o, j) => j !== i && Math.hypot(x - o.x, (y - o.y) / 0.6) < mine + 14);
    });
    return {
      kind,
      seed: seed * 71 + i,
      route: planRoute(mask, kind, own, radius, seed * 71 + i),
    };
  }).filter((r) => r.route.length > 0);
}

/**
 * Where each lamp really stands. A light that shows on something standing
 * (a stone lantern's firebox, a window) burns inside it: on the ground at its
 * foot line, as high above it as it shows, and part of it (its body glows
 * round it). A window's light sits just in front of its wall. A light shown
 * on open ground (the fire) burns just above it.
 */
function placeLamps(
  lamps: ReadonlyArray<{ x: number; y: number; r: number; strength: number; wall?: boolean }>,
  solids: { owner: Int32Array; bases: readonly number[] },
  width: number,
): FarmLamp[] {
  return lamps.map(({ x, y, r, strength, wall }) => {
    const owner = solids.owner[Math.round(y) * width + Math.round(x)] ?? -1;
    const base = owner >= 0 ? solids.bases[owner] : undefined;
    // `r` is how far over the ground it reaches; from up high it must reach further.
    if (base === undefined) return { x, y, z: 2, r: Math.hypot(r, 2), strength };
    const foot = base + (wall ? 1 : 0);
    const z = Math.max(1, foot - y);
    return { x, y: foot, z, r: Math.hypot(r, z), strength, owner, ...(wall ? { wall } : {}) };
  });
}

/** Where a placed prop's pixels land on the map: its box, and whether a map pixel is drawn. */
function footprint(p: PlacedProp): {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  at: (x: number, y: number) => boolean;
} {
  const { buf, ax, ay } = p.sprite;
  const left = Math.floor(p.x) - (p.flip ? buf.width - 1 - ax : ax);
  const top = Math.floor(p.y) - ay;
  return {
    x0: left,
    y0: top,
    x1: left + buf.width,
    y1: top + buf.height,
    at: (x, y) => buf.opaque(p.flip ? buf.width - 1 - (x - left) : x - left, y - top),
  };
}

/**
 * Drop every filler (grass, flowers) that would overlap or touch anything
 * else drawn (a lantern, a stepping stone, a building, another tuft), so the
 * grass grows round things instead of being pasted over them. A sprig at a
 * building's foot may grow against that building (its `owner`), nothing else.
 * Bare dirt patches don't count: grass may grow on them. Fillers are checked
 * in the order placed, so earlier ones win.
 */
function clearFiller(
  props: PlacedProp[],
  filler: ReadonlyMap<PlacedProp, PlacedProp | undefined>,
  bare: ReadonlySet<PlacedProp>,
): void {
  const kept: PlacedProp[] = [];
  const blockers = props.filter((p) => !filler.has(p) && !bare.has(p));
  const hits = (f: PlacedProp, others: readonly PlacedProp[]): boolean => {
    const a = footprint(f);
    return others.some((o) => {
      const b = footprint(o);
      if (a.x1 + 1 <= b.x0 || b.x1 + 1 <= a.x0 || a.y1 + 1 <= b.y0 || b.y1 + 1 <= a.y0)
        return false;
      for (let y = Math.max(a.y0, b.y0 - 1); y < Math.min(a.y1, b.y1 + 1); y++) {
        for (let x = Math.max(a.x0, b.x0 - 1); x < Math.min(a.x1, b.x1 + 1); x++) {
          if (!a.at(x, y)) continue;
          // Touching counts: a pixel of grass right against a stone reads as on it.
          if (b.at(x, y) || b.at(x + 1, y) || b.at(x - 1, y) || b.at(x, y + 1) || b.at(x, y - 1))
            return true;
        }
      }
      return false;
    });
  };
  for (const [f, owner] of filler) {
    const others = owner ? blockers.filter((b) => b !== owner) : blockers;
    if (hits(f, others) || hits(f, kept)) props.splice(props.indexOf(f), 1);
    else kept.push(f);
  }
}

/**
 * Countryside around the farmstead, for windows wider or taller than it:
 * trees, blossom, shrubs and long grass on a loose grid, kept off the lane
 * that leads out through the gate. Deterministic for a seed.
 */
function addCountryside(
  props: PlacedProp[],
  cols: number,
  rows: number,
  o: {
    readonly ox: number;
    readonly oy: number;
    readonly seed: number;
    readonly gateY: number;
    /** The band at the top under the see-through header. */
    readonly headerY: number;
  },
): void {
  const width = cols * TILE;
  const height = rows * TILE;
  const core = {
    x0: o.ox - 6,
    y0: o.oy - 4,
    x1: o.ox + FARM_CORE.cols * TILE + 6,
    y1: o.oy + FARM_CORE.rows * TILE + 8,
  };
  const step = 34;
  for (let gy = 0; gy * step < height + step; gy++) {
    for (let gx = 0; gx * step < width + step; gx++) {
      const x = gx * step + Math.round((hash(gx, gy, o.seed + 1) - 0.5) * 18) + step / 2;
      const y = gy * step + Math.round((hash(gx, gy, o.seed + 2) - 0.5) * 16) + step / 2;
      // Keep the lane to the gate open.
      if (x < o.ox + 8 && Math.abs(y - o.gateY - 12) < 28) continue;
      if (x < -8 || y < 6 || x > width + 8 || y > height + 24) continue;
      // Under the header (and just below it) only low growth, so the header's
      // controls stay easy to read over the countryside.
      const underHeader = y < o.headerY + 22;
      const roll = underHeader ? 0.66 + hash(gx, gy, o.seed + 3) * 0.34 : hash(gx, gy, o.seed + 3);
      if (underHeader && hash(gx, gy, o.seed + 7) < 0.45) continue;
      const s = o.seed * 101 + gx * 31 + gy * 17;
      let sprite: Sprite;
      if (roll < 0.3)
        sprite = canopyTree(s, roll < 0.15 ? "green" : "olive", 0.8 + hash(gx, gy, 4) * 0.25);
      else if (roll < 0.42) sprite = sakuraTree(s, hash(gx, gy, 5) < 0.5);
      else if (roll < 0.66)
        sprite = moundShrub(
          s,
          (["green", "olive", "amber"] as const)[gx % 3] ?? "green",
          9 + Math.round(hash(gx, gy, 6) * 4),
        );
      else if (roll < 0.9) sprite = tallGrass(s, roll < 0.78 ? "green" : "gold");
      else sprite = flowerClump(s, ([0xf6d24a, 0xf2b6c6, 0xffffff] as const)[gy % 3] ?? 0xffffff);
      // Its whole picture must stay outside the farmstead, not just its foot:
      // a tree standing below the fields would grow up over them.
      const left = x - sprite.ax;
      const top = y - sprite.ay;
      const right = left + sprite.buf.width;
      const bottom = top + sprite.buf.height;
      if (right > core.x0 && left < core.x1 && bottom > core.y0 && top < core.y1) continue;
      props.push({ sprite, x, y });
    }
  }
}

/** Where a critter stands at `station` in its `slot`-th place (places repeat, nudged). */
export function farmSpot(farm: Farm, station: StationKind, slot: number): Spot {
  const spots = farm.stations[station];
  const base = spots[slot % spots.length] ?? farm.stations.lounge[0] ?? { x: 0, y: 0 };
  const lap = Math.floor(slot / Math.max(1, spots.length));
  return lap === 0 ? base : { x: base.x + lap * 6, y: base.y + lap * 3 };
}
