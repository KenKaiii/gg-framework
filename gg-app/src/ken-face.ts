// Ken's face: a head-only pixel portrait in the critter sprite format (see
// critter-sprites.ts). It stands in for the teal dot on Ken's chat replies and
// headlines the "Ken is on." / "Ken is off." banner. Buzzcut, light skin,
// calm narrow eyes, friendly grin. Each expression is the base grid with a few
// rows swapped, so the frames line up pixel for pixel when stacked and
// cross-faded in CSS (KenFace.tsx). Colours are art, not theme roles.

import { renderColorGrid, shadeGrid, type Material } from "./critter-shade";
import { CRITTER_CELLS } from "./critter-sprites";

export type KenFaceFrame = "base" | "blink" | "talk" | "happy" | "sleepy";

export const KEN_FACE_PALETTE: Readonly<Record<string, string>> = {
  O: "#1c120e", // outline
  H: "#3d302a", // buzzcut
  h: "#6e5a4d", // stubble flecks and the faded temples
  F: "#f7dcc4", // skin
  D: "#e3b796", // skin shade (nose)
  A: "#ecbf9f", // ears
  B: "#4a3830", // brows
  E: "#1d1418", // eyes
  L: "#8a5a44", // closed lids
  C: "#f4a99e", // blush
  M: "#b5554c", // smile
  K: "#4a1a1e", // open mouth
  T: "#e86a5e", // tongue
  G: "#2f4a7a", // his tee (navy, as on the farm and in his portrait)
};

// Buzzed cap with a hairline and faded temples, brows a row clear of the
// narrow eyes, ears at eye level, a shaded nose, a friendly grin, and the
// neck and collar of his tee. Lit like the critters (critter-shade.ts).
const BASE: readonly string[] = [
  "..................",
  ".....OOOOOOOO.....",
  "...OOHHhHHHhHHOO..",
  "..OHHHhHHHHHhHHHO.",
  "..OHhHHHhHHHHhHHO.",
  ".OHhFFFFFFFFFFhHO.",
  ".OhFFBBBFFFBBBFhO.",
  "OAAFFFFFFFFFFFFAAO",
  "OAAFFEEFFFFFEEFAAO",
  "OAAFFFFFFDFFFFFAAO",
  ".OOCCFFFFDDFFCCOO.",
  "..OFFFMFFFFFMFFO..",
  "..OFFFFMMMMMFFFO..",
  "...OFFFFFFFFFFO...",
  "....OOFFFFFFOO....",
  "....OGGOFFOGGO....",
  "...OGGGGOOGGGGO...",
  "..................",
];

const LIDS = "OAAFFLLFFFFFLLFAAO";
const OPEN_MOUTH = {
  11: "..OFFFFKKKKKFFFO..",
  12: "..OFFFFKTTTKFFFO..",
};

/** Rows each expression swaps into the base grid. */
const CHANGES: Readonly<Record<KenFaceFrame, Readonly<Record<number, string>>>> = {
  base: {},
  blink: { 8: LIDS },
  talk: OPEN_MOUTH,
  // ^^ eyes (a row below the brows, so they don't cross them) and an open grin.
  happy: { 8: "OAAFFFEFFFFFFEFAAO", 9: "OAAFFEFEFDFFEFEAAO", ...OPEN_MOUTH },
  // Lids shut and a small, settled mouth.
  sleepy: {
    8: LIDS,
    11: "..OFFFFFFFFFFFFO..",
    12: "..OFFFFFMMMFFFFO..",
  },
};

/** How each part of the face takes the light (critter-shade.ts). */
const KEN_FACE_MATERIALS: Readonly<Record<string, Material>> = {
  F: "skin",
  A: "skin",
  D: "skin",
  H: "fur",
  h: "fur",
  G: "cloth",
  B: "flat",
  E: "flat",
  L: "flat",
  C: "flat",
  M: "flat",
  K: "flat",
  T: "flat",
};

/** The grid for one expression. */
export function kenFaceRows(frame: KenFaceFrame): readonly string[] {
  const changes = CHANGES[frame];
  return BASE.map((row, i) => changes[i] ?? row);
}

/** One expression, lit, as an SVG data URL (one unit per cell, scale it up pixelated). */
export function renderKenFace(frame: KenFaceFrame): string {
  return renderColorGrid(
    shadeGrid({
      rows: kenFaceRows(frame),
      palette: KEN_FACE_PALETTE,
      materials: KEN_FACE_MATERIALS,
      seed: 11,
    }),
    { width: CRITTER_CELLS, height: CRITTER_CELLS },
  );
}
