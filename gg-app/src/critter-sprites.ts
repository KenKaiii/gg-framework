// Pixel critter sprites for the sub-agent "floor" (see CritterFloor.tsx).
// Each critter is an 18×18 grid facing right; the floor flips it in CSS when
// it walks left. The grids are material maps, not finished pixels: a key
// names a part of the critter (B body, L belly or pale fur, D dark markings,
// K eyes, W eye shine, C blush, M mouth, N nose, O outline, the rest per
// critter) and critter-shade.ts lights it as GG Royale's art is lit, with
// form shading, hue-shifted ramps and coloured outlines. `alt` lists only the
// rows that change for the second walk frame. Colours are art, not theme
// roles, so they stay literal here.

import { renderColorGrid, shadeGrid, type Material } from "./critter-shade";

/** How a critter gets around the floor. */
export type CritterMove = "walk" | "hop" | "hover" | "float" | "scuttle" | "squish";

export interface CritterDef {
  readonly id: string;
  readonly name: string;
  readonly move: CritterMove;
  /** Palette key → colour. `B` is the body colour (beam, glow, tooltip swatch). */
  readonly palette: Readonly<Record<string, string>>;
  readonly rows: readonly string[];
  readonly alt: Readonly<Record<number, string>>;
  /** How each palette key takes the light (critter-shade.ts); unlisted keys are fur. */
  readonly materials?: Readonly<Record<string, Material>>;
}

/** Sprite grid edge, in cells. */
export const CRITTER_CELLS = 18;

export const CRITTERS: readonly CritterDef[] = [
  {
    id: "bee",
    name: "Bee",
    move: "hover",
    palette: {
      O: "#000",
      B: "#ffd23f",
      D: "#5a3a1c",
      V: "rgba(214,240,255,0.78)",
      G: "#ffffff",
      S: "#5a3a1c",
      K: "#1e0c1f",
      W: "#ffffff",
      C: "#ff8a5c",
      M: "#7a2e2a",
    },
    materials: { V: "glass", G: "flat" },
    rows: [
      ".OOODDO.....ODDOO.",
      "OVVVOOO.....OOOVVO",
      "OVGVVVOOOOOOVVVGVO",
      "OVVVOOOBBBBOOOVVVO",
      "OVVOBBBBBBBBBBOVVO",
      ".OOBBBBBBBBBBBBOO.",
      ".OBBBBBBBBBBBBBBO.",
      ".OBBBBWKBBBWKBBBO.",
      "OBBBBBKKBBBKKBBBBO",
      "OBBCCBBBBMMBBCCBBO",
      "OBBBBBBBBBBBBBBBBO",
      "ODDDDDDDDDDDDDDDDO",
      ".ODDDDDDDDDDDDOOO.",
      "..OBBBBBBBBBBOBBBO",
      "...ODDDDDDDDDDOBO.",
      "....OBBBBBBBBO.O..",
      ".....OOOOOOOO.....",
      "........OSO.......",
    ],
    alt: {
      0: "...ODDO.....ODDO..",
      1: "..OOOOO.....OOOO..",
      2: ".OVVVO.OOOOOOVVVO.",
      3: "OVGVOOOBBBBOOOVGVO",
      5: "OVOBBBBBBBBBBBBOVO",
    },
  },
  {
    id: "fox",
    name: "Fox",
    move: "walk",
    palette: {
      O: "#000",
      B: "#f07a2a",
      L: "#fff1dc",
      D: "#5a2a1c",
      I: "#ffc2a1",
      P: "#f07a2a",
      K: "#1e0c1f",
      W: "#ffffff",
      C: "#ff7a8a",
      N: "#2a1418",
      M: "#7a2e2a",
    },
    materials: { I: "skin" },
    rows: [
      ".ODO..........ODO.",
      ".ODBOO......OOBDO.",
      ".OBIOOOOOOOOOOIBO.",
      "OBBOBBBBBBBBBBOBBO",
      "OBOBBBBBBBBBBBBOBO",
      "OOBBBBBBBBBBBBBBOO",
      "OBBBBBBBBBBBBBBBBO",
      "OBBBBBWKBBBWKBBBBO",
      "OBBBBBKKBBBKKBBBBO",
      ".OLCCBBLLNNLBCCLO.",
      ".OOLBBLLLMMLLBLO..",
      "OLLOOBLLLLLLLOO...",
      "BLLBBOOOOOOOO.OO..",
      "BBBBOBBBLLLBBODDO.",
      "BBBBOBBLLLLLODDDO.",
      "OBBBOBBLLLLLBOOO..",
      ".OOOOOOOOOOOOO....",
      ".....OO....OO.....",
    ],
    alt: {
      16: ".OOO.OOOOOOOO.....",
      17: "......OO..OO......",
    },
  },
  {
    id: "cat",
    name: "Cat",
    move: "walk",
    palette: {
      O: "#000",
      B: "#4ae0b0",
      L: "#e6fff6",
      D: "#1f9c7a",
      I: "#ff9cc6",
      P: "#4ae0b0",
      K: "#0e1a16",
      W: "#ffffff",
      C: "#ff8cc0",
      N: "#ff6fa8",
      M: "#2a3a34",
    },
    materials: { I: "skin" },
    rows: [
      "..O............O..",
      ".OBOO........OOBO.",
      ".OBIOOOOOOOOOOIBO.",
      ".OBOBBBBDDDBBBOBO.",
      ".OOBBDBBBDBBBDBOO.",
      ".OBBBBBBBBBBBBBBO.",
      "OBBBBBBBBBBBBBBBBO",
      "OBBBBBWKBBBWKBBBBO",
      "OBDBBBKKBBBKKBBDBO",
      "OODCCBBLLNNLLCCDOO",
      "OBOBBBLLMLLMLBBO.O",
      "OBOOOBBLLLLLBOO...",
      ".OBO.OOOOOOOO.OO..",
      ".OBOOBBBLLLBBOPPO.",
      "..OBOBBLLLLLOPPPO.",
      "...OOBBLLLLLBOOO..",
      "....OOOOOOOOOO....",
      ".....OO....OO.....",
    ],
    alt: {
      16: ".....OOOOOOOO.....",
      17: "......OO..OO......",
    },
  },
  {
    id: "owl",
    name: "Owl",
    move: "hop",
    palette: {
      O: "#000",
      B: "#8a6bf0",
      L: "#e6defc",
      D: "#5a40b8",
      A: "#ffb23a",
      K: "#140a2e",
      W: "#ffffff",
    },
    materials: { A: "skin" },
    rows: [
      ".ODO..........ODO.",
      ".ODDOO..OO..OODDO.",
      ".ODDDOOOBBOOODDDO.",
      "..OOOBBBBBBBBOOO..",
      "..OBBBBBBBBBBBBO..",
      ".OBBBLLBBBBLLBBBO.",
      ".OBBLLLLBBLLLLBBO.",
      "OBBLLWKLLLLWKLLBBO",
      "OBBLLKKLLLLKKLLOBO",
      "OBBBLLLLAALLLLODOO",
      "OBBBBBBBALLBBODDOO",
      ".OBBBBLLLLLLLODDDO",
      ".OBBBLLDLDLDLODDDO",
      "..OBBLDLLLLLDODDDO",
      "...OBBLLDLDLLODDO.",
      "....OOBBLLLBOOOO..",
      "....OAOOOOOOAO....",
      ".....OO....OO.....",
    ],
    alt: {
      16: ".....OOOOOOOO.....",
      17: "......OO..OO......",
    },
  },
  {
    id: "frog",
    name: "Frog",
    move: "hop",
    palette: {
      O: "#000",
      B: "#4ad86a",
      L: "#d8f7b8",
      D: "#2a9a48",
      P: "#4ad86a",
      K: "#0a1a10",
      W: "#ffffff",
      C: "#ff7aa8",
      M: "#1e3a22",
    },
    materials: { B: "skin", L: "skin", D: "skin", P: "skin" },
    rows: [
      "..................",
      "...OOOO....OOOO...",
      "..OBBBBO..OBBBBO..",
      "..OBBBBOOOOBBBBO..",
      "..OBWKKBBBBWKKBO..",
      "..OOKKKBBBBKKKOO..",
      ".OBBBBBBDBBBBBBBO.",
      "OBBBBBBBBBBBBBBBBO",
      "OBDBBBBBBBBBBBBDBO",
      "OBCCMBBBBBBBBBMCCO",
      "OBBDBMMMMMMMMMDBBO",
      ".OOBBLLLLLLLLLBOO.",
      "...OOBBLLLLBBOOO..",
      "....OOOOOOOOOOPPO.",
      "...OBBBLLLLLOPPPO.",
      "....OBBLLLLLBOOO..",
      "....OOOOOOOOOO....",
      ".....OO....OO.....",
    ],
    alt: {
      16: ".....OOOOOOOO.....",
      17: "......OO..OO......",
    },
  },
  {
    id: "robot",
    name: "Robot",
    move: "walk",
    palette: {
      O: "#000",
      B: "#5aa4f0",
      S: "#2f5fb8",
      G: "#b8c4d8",
      A: "#ff4a5c",
      R: "#ffd23f",
      K: "#0a1030",
      E: "#5cf2ff",
    },
    materials: { B: "metal", S: "metal", G: "metal", A: "glass", R: "flat", E: "flat", K: "flat" },
    rows: [
      ".......OAAO.......",
      ".......OAAO.......",
      "........OO........",
      "..OOOOOOOOOOOOOO..",
      ".OBBBBBBBBBBBBBBO.",
      ".OBOOOOOOOOOOOOBO.",
      ".OBOKKKKKKKKKKOBO.",
      ".OBOKKEKKKKEKKOBO.",
      ".OBOKKKKEEKKKKOBO.",
      ".OBOOOOOOOOOOOOBO.",
      ".OBGBBBSSSSBBBGBO.",
      "..OOOOOOOOOOOOOO..",
      ".....OOOOOOOOO....",
      "....OBBASRSBBOOO..",
      "....OBBSESSBBOGGO.",
      "....OBBBBBBBBOOO..",
      "....OOGGOOGGOO....",
      "....OGGO..OGGO....",
    ],
    alt: {
      13: "....OBBRSASBBOOO..",
      16: ".....OOGGOGGOO....",
      17: ".....OGGO.OGGO....",
    },
  },
  {
    id: "ghost",
    name: "Ghost",
    move: "float",
    palette: { O: "#000", B: "#f1ecff", K: "#2a1e5c", W: "#ffffff", C: "#ff9ad8", M: "#5a3a8a" },
    materials: { B: "glow" },
    rows: [
      "......OOOOOO......",
      "....OOBBBBBBOO....",
      "...OBBBBBBBBBBO...",
      "..OBBBBBBBBBBBBO..",
      ".OBBBBBBBBBBBBBBO.",
      ".OBBBBBBBBBBBBBBO.",
      ".OBBBBBBBBBBBBBBO.",
      "OBBBBBWKBBBWKBBBBO",
      "OBBBBBKKBBBKKBBBBO",
      ".OBBBBKKBBBKKBBOO.",
      ".OBBCCBBBBBBBCOBBO",
      ".OBBBBBBBMMBBBOBBO",
      ".OBBBBBBBBBBBBOBO.",
      ".OBBBBBBBBBBBBBOO.",
      ".OBBBBBBBBBBBBBBO.",
      ".OBBOOBBOOBBOOBBO.",
      "..OO..OO..OO..OO..",
      "..................",
    ],
    alt: {
      15: "..OOBBOOBBOOBBOO..",
      16: "....OO..OO..OO....",
    },
  },
  {
    id: "shroom",
    name: "Shroom",
    move: "walk",
    palette: {
      O: "#000",
      B: "#f0384a",
      L: "#fff6ea",
      S: "#c9a888",
      F: "#ffe8c8",
      P: "#ffe8c8",
      K: "#2a0d14",
      W: "#ffffff",
      C: "#ff9ab0",
      M: "#7a2e2a",
    },
    materials: { F: "skin", P: "skin", S: "cloth" },
    rows: [
      "....OOOOOOOOOO....",
      "..OOBBBBBBBLLBOO..",
      ".OBBBLLBBBBLLBBBO.",
      "OBBBBLLBBBBBBBBBBO",
      "OBBBBBBBBBBBBBBBBO",
      "OBBBBBBBBBBBBBLLBO",
      "OBLLBBBBBBBBBBBBBO",
      ".OOSSSSSSSSSSSSOO.",
      "...OOOOOOOOOOOO...",
      "...OFFWKFFWKFFO...",
      "...OFFKKFFKKFFO...",
      "...OCCFFMMFFCCO...",
      "...OFFFFFFFFFFOO..",
      "....OOOOOOOOOOFFO.",
      "....OFFFFFFFOFFFO.",
      "....OFFFFFFFFOOO..",
      "....OOOOOOOOOO....",
      ".....OO....OO.....",
    ],
    alt: {
      16: ".....OOOOOOOO.....",
      17: "......OO..OO......",
    },
  },
  {
    id: "wizard",
    name: "Wizard",
    move: "walk",
    palette: {
      O: "#000",
      B: "#9a4af0",
      A: "#ff3fa4",
      Y: "#ffd23f",
      L: "#e8e4f0",
      F: "#ffd3a8",
      D: "#4a2a6a",
      K: "#170a2e",
      E: "#ffe14d",
    },
    materials: { B: "cloth", A: "cloth", Y: "metal", F: "skin", D: "cloth", E: "flat" },
    rows: [
      "..........OBBO....",
      ".........OYBBO....",
      "........OYYYBO....",
      ".......OBBYBBO....",
      "......OAAAAAAO....",
      ".OOOOOOOOOOOOOOOO.",
      "OBBBBBBBBBBBBBBBBO",
      "OBBBBBBBBBBBBBBBBO",
      ".OOOOOOOOOOOOOOOO.",
      "...OKKKKKKKKKKO...",
      "...OKKKEKKKEKKO...",
      "....OKOOOOOOKO....",
      "....OOLLLLLLOOOO..",
      "...OBBOLLLLLOOFFO.",
      "...OBBBOOOOOBOFFO.",
      "...OBBBBYYBBBBOO..",
      "....OOOBYYBOOO....",
      ".....OOOOOOOO.....",
    ],
    alt: {
      1: ".........OBYBO....",
      2: "........OBYBBO....",
      3: ".......OBYBYBO....",
      17: "......OOOOOO......",
    },
  },
  {
    id: "knight",
    name: "Knight",
    move: "walk",
    palette: {
      O: "#000",
      B: "#c8d2e4",
      S: "#8a96b0",
      A: "#2ac8d0",
      G: "#ffc93c",
      K: "#0b1020",
      E: "#5cf2ff",
    },
    materials: { B: "metal", S: "metal", A: "cloth", G: "metal", E: "flat" },
    rows: [
      "...OAAAO..........",
      "..OAAAOOOOOO......",
      "..OAOOBBBGBBOO....",
      "...OBBBBBGBBBBO...",
      "..OBBBBBBGBBBBBO..",
      ".OBBBBBBBBBBBBBBO.",
      ".OBBKKKEKKKEKKKBO.",
      ".OBBKKKKKKKKKKKBO.",
      "..OBBBBBBBBBBBBO..",
      "..OBSSSSSSSSSOOOO.",
      "...OBBBBBBBBOAAAAO",
      "....OOOOOOOOOAGGAO",
      ".....OBBBBBBOAGGAO",
      "....OBBBGGBBOAAAAO",
      "...OBBBBBGBBOAAAAO",
      "....OBBBBBBBBOOOO.",
      "....OOOOOOOOOO....",
      ".....OO....OO.....",
    ],
    alt: {
      0: "..OAAAAO..........",
      1: ".OAAAAOOOOOO......",
      16: ".....OOOOOOOO.....",
      17: "......OO..OO......",
    },
  },
  {
    id: "builder",
    name: "Builder",
    move: "walk",
    palette: {
      O: "#000",
      B: "#2f6bff",
      V: "#2f6bff",
      A: "#ffb020",
      Y: "#ffe08a",
      F: "#ffd3a8",
      P: "#ffd3a8",
      D: "#5a3a24",
      K: "#1b1530",
      W: "#ffffff",
      C: "#ff8a7a",
      M: "#7a2e2a",
    },
    materials: { V: "cloth", A: "metal", Y: "metal", F: "skin", P: "skin" },
    rows: [
      ".....OOOOOOOO.....",
      "...OOAAAAYAAAOO...",
      "..OAAAAAAYAAAAAO..",
      "..OAAAAAAYAAAAAO..",
      "..OOOOOOOOOOOOOOO.",
      ".OAAAAAAAAAAAAAAAO",
      "..OOOOOOOOOOOOOOO.",
      "..OFOOOAAAAOOOFO..",
      "..OFFFWOOOOKFFFO..",
      "..OFFFKKFFKKFFFO..",
      "..OFCCFFMMFFCCFO..",
      "...OOFFFFFFFFOO...",
      ".....OOOFFOOO.OO..",
      "....OVVVOOVVVOFFO.",
      "....OVVVYYYVOFFFO.",
      "....OVVVVVVVVOOO..",
      "....OOOOOOOOOO....",
      ".....OO....OO.....",
    ],
    alt: {
      16: ".....OOOOOOOO.....",
      17: "......OO..OO......",
    },
  },
  {
    id: "crab",
    name: "Crab",
    move: "scuttle",
    palette: {
      O: "#000",
      B: "#f04a3a",
      L: "#fff1e6",
      D: "#b8282a",
      K: "#1b0a0a",
      W: "#ffffff",
      C: "#ffb3a6",
      M: "#5a1418",
    },
    materials: { B: "skin", D: "skin", L: "skin" },
    rows: [
      ".....OLO..OLO.....",
      ".OOOOLWLOOLWLOOOO.",
      "OBOBOLKLOOLKLOBOBO",
      "BBBBBOOO..OOOBBBBB",
      "BBBBOOBO..OBOOBBBB",
      "OBBBOOOOOOOOOOBBBO",
      ".OOOOBBBBBBBBOOOO.",
      "..OBBBBBBDBBBBBO..",
      ".OBBBDBBBBBBBDBBO.",
      "OBBBBBBDBBBDBBBBBO",
      "OBBDBBBBBBBBBBBDBO",
      "OBBCCBBBMMBBBCCBBO",
      "OBBBBBBBBBBBBBBBBO",
      ".OBBBBBBBBBBBBBBO.",
      ".OOOOBBBBBBBBOOOO.",
      "ODODOOOOOOOOOODODO",
      "ODODO........ODODO",
      ".O.O..........O.O.",
    ],
    alt: {
      1: "....OLWLOOLWLO....",
      2: ".OOOOLKLOOLKLOOOO.",
      3: "OBOBOOOO..OOOOBOBO",
      4: "BBBBBOBO..OBOBBBBB",
      5: "BBBBOOOOOOOOOOBBBB",
      6: "OBBOOBBBBBBBBOOBBO",
      7: ".OOBBBBBBDBBBBBOO.",
      14: "..OOOBBBBBBBBOOO..",
      15: ".ODODOOOOOOOODODO.",
      16: ".ODODO......ODODO.",
      17: "..O.O........O.O..",
    },
  },
  {
    id: "axolotl",
    name: "Axolotl",
    move: "walk",
    palette: {
      O: "#000",
      B: "#ff9ad6",
      L: "#ffe0f2",
      A: "#ff4fae",
      P: "#ff9ad6",
      K: "#2a0a20",
      W: "#ffffff",
      C: "#ff5fb4",
      M: "#7a2050",
    },
    materials: { B: "skin", L: "skin", A: "skin", P: "skin" },
    rows: [
      "..................",
      "OO.....OOOO.....OO",
      "AAO.OOOBBBBOOO.OAA",
      "AAAOBBBBBBBBBBOAAA",
      "OOOBBBBBBBBBBBBOOO",
      "AOBBBBBBBBBBBBBBOA",
      "OOBBBBBBBBBBBBBBOO",
      "AOBBBWKBBBBWKBBBOA",
      "OOBBBKKBBBBKKBBBOO",
      "..OCCBBBMBMBBCCO..",
      "...OBBBBBMBBBBO...",
      "OOOOOOBBBBBBOO....",
      "BBBBBOOOOOOOO.OO..",
      "BBBBOBBBLLLBBOPPO.",
      "OBBBOBBLLLLLOPPPO.",
      ".OOOOBBLLLLLBOOO..",
      "....OOOOOOOOOO....",
      ".....OO....OO.....",
    ],
    alt: {
      10: ".OOOBBBBBMBBBBO...",
      11: "OBBBOOBBBBBBOO....",
      14: "OOOOOBBLLLLLOPPPO.",
      15: "....OBBLLLLLBOOO..",
      16: ".....OOOOOOOO.....",
      17: "......OO..OO......",
    },
  },
  {
    id: "dino",
    name: "Dino",
    move: "walk",
    palette: {
      O: "#000",
      B: "#2ad0e8",
      L: "#d4f8ff",
      A: "#ff9a2e",
      D: "#1a8aa8",
      P: "#2ad0e8",
      K: "#06161c",
      W: "#ffffff",
      C: "#ff7ab6",
      M: "#0a3a44",
    },
    materials: { B: "skin", L: "skin", A: "skin", D: "skin", P: "skin" },
    rows: [
      ".....O..OAO.......",
      "....OAO.OAO.OO....",
      "....OOOOOOOOOAO...",
      "...OOBBBBBBBBOO...",
      "..OBBBBBBBBBBBBO..",
      ".OBBBBBBBBBBBBDBO.",
      "OBBDBBBBBBBBBDBDBO",
      "OBBBDBWKBBBWKBBBBO",
      "OBDBBBKKBBBKKBBBBO",
      ".OBCCBBBBBBBBCCBO.",
      "..OBBBBBBMWMBBBO..",
      "...OBBBBBBBBBBO...",
      "...OOOOOOOOOOOOO..",
      "..OBOBBBLLLBBOPPO.",
      "OOBBOBBLLLLLOPPPO.",
      "BBBBOBBLLLLLBOOO..",
      "OOOOOOOOOOOOOO....",
      ".....OO....OO.....",
    ],
    alt: {
      16: "OOOOOOOOOOOOO.....",
      17: "......OO..OO......",
    },
  },
  {
    id: "slime",
    name: "Slime",
    move: "squish",
    palette: {
      O: "#000",
      B: "#a8f03a",
      L: "#efffc8",
      K: "#122000",
      W: "#ffffff",
      C: "#ff7ab6",
      M: "#2a4a0a",
    },
    materials: { B: "gel", L: "gel" },
    rows: [
      "..................",
      "..................",
      "..................",
      "..................",
      "..................",
      ".....OOOOOOOO.....",
      "...OOBBBBBBBBOO...",
      "..OBBBBBBBBBBBBO..",
      ".OBBBBBBBBBBBBBBO.",
      "OBBBBBWKBBBWKBBBBO",
      "OBBBBBKKBBBKKBBBBO",
      "OBBCCBBBBMMBBCCBBO",
      "OBBBBBBBBBBBBBBBBO",
      "OBBBBBBBBBBBBBBBBO",
      "OBBBLBBBBBBBLBBBBO",
      "OBBBBLBBBBBBBLBBBO",
      "OBBBBBBBBBBBBBBBBO",
      ".OOOOOOOOOOOOOOOO.",
    ],
    alt: {
      5: "..................",
      6: "......OOOOOO......",
      7: "...OOOBBBBBBOOO...",
      8: "..OBBBBBBBBBBBBO..",
      9: ".OBBBBBBBBBBBBBBO.",
      10: "OBBBBBWKBBBWKBBBBO",
      11: "BBBBBBKKBBBKKBBBBB",
      12: "BBBCCBBBBMMBBCCBBB",
    },
  },
];

/** Frame rows: the base grid with the second walk frame's changed rows swapped in. */
export function frameRows(critter: CritterDef, frame: 0 | 1): readonly string[] {
  if (frame === 0) return critter.rows;
  return critter.rows.map((row, i) => critter.alt[i] ?? row);
}

/**
 * A pixel grid as an SVG data URL, one unit per cell (scaled up with
 * `image-rendering: pixelated`). Same legend as the sprites: `.` is
 * transparent, anything else is a palette key. Horizontal runs of one colour
 * merge into a single rect so the image stays small. Pass `fill` to paint every
 * opaque cell one colour. SVG rather than canvas so it is pure, deterministic
 * and testable.
 */
export function renderPixelGrid(
  rows: readonly string[],
  palette: Readonly<Record<string, string>>,
  size: { readonly width: number; readonly height: number },
  fill?: string,
): string {
  const rects: string[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      const color = ch === undefined || ch === "." ? undefined : (fill ?? palette[ch]);
      if (color) {
        rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${color}"/>`);
      }
      x = end;
    }
  });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size.width} ${size.height}" ` +
    `shape-rendering="crispEdges">${rects.join("")}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Shaded frames, so each grid is lit once (keyed by its pixels: a blink is its own grid). */
const FRAME_CACHE = new Map<string, string>();

/**
 * A critter's grid, lit (critter-shade.ts) and as an SVG data URL, one unit
 * per cell. `rows` overrides the frame's own grid (a blink, a face swap) and
 * is lit the same way. Pass `fill` for the white silhouette used by the summon
 * glow.
 */
export function renderCritterRows(
  critter: CritterDef,
  rows: readonly string[],
  fill?: string,
  palette: Readonly<Record<string, string>> = critter.palette,
): string {
  const size = { width: rows[0]?.length ?? CRITTER_CELLS, height: rows.length };
  if (fill) return renderPixelGrid(rows, palette, size, fill);
  return renderColorGrid(
    shadeGrid({ rows, palette, materials: critter.materials, seed: hashKey(critter.id) }),
    size,
  );
}

/** One frame of a critter, lit (see renderCritterRows). */
export function renderCritterFrame(critter: CritterDef, frame: 0 | 1, fill?: string): string {
  const rows = frameRows(critter, frame);
  const key = `${critter.id}:${fill ?? ""}:${rows.join("|")}`;
  const known = FRAME_CACHE.get(key);
  if (known) return known;
  const url = renderCritterRows(critter, rows, fill);
  FRAME_CACHE.set(key, url);
  return url;
}

/**
 * Named agents that have a critter of their own. Anything else (unnamed
 * `default` agents, custom names) gets one picked from its id.
 */
const CRITTER_FOR_AGENT: Readonly<Record<string, string>> = {
  bee: "bee",
  owl: "owl",
  worker: "builder",
  researcher: "wizard",
  auditor: "knight",
  skeptic: "cat",
  "control-verifier": "robot",
};

/**
 * Small stable string hash (FNV-1a): an agent keeps the same critter, and a
 * chat line keeps the same wording, across renders and reloads.
 */
export function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Choose the critter for an agent. A named agent gets its own critter when
 * that one is free; otherwise the id picks a starting point and the first
 * critter not already on the floor wins, so a crowd stays varied. Once all 15
 * are out, repeats are allowed.
 */
export function pickCritter(
  agentName: string | undefined,
  key: string,
  taken: ReadonlySet<string>,
): CritterDef {
  const preferredId = agentName ? CRITTER_FOR_AGENT[agentName] : undefined;
  const preferred = CRITTERS.find((critter) => critter.id === preferredId);
  if (preferred && !taken.has(preferred.id)) return preferred;
  const start = hashKey(key) % CRITTERS.length;
  for (let step = 0; step < CRITTERS.length; step++) {
    const candidate = CRITTERS[(start + step) % CRITTERS.length];
    if (candidate && !taken.has(candidate.id)) return candidate;
  }
  const fallback = preferred ?? CRITTERS[start];
  if (!fallback) throw new Error("critter roster is empty");
  return fallback;
}
