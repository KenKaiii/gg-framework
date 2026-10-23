// GG Coder's face: the Robot critter (critter-sprites.ts) with a different
// face on its screen for each status mood. Only the screen's three rows
// change, so the frames line up pixel for pixel. The screen glows in the
// colour of the status it stands for (green when done, amber when stopped or
// waiting, red on failure), so face and status text read as one.

import { CRITTERS, renderCritterRows, type CritterDef } from "./critter-sprites";

export type GgFaceMood = "ready" | "happy" | "curious" | "worried" | "sad" | "shocked";
export type GgFaceFrame = GgFaceMood | "blink";

/** Screen glow per mood: the status tone it stands beside. */
export const GG_FACE_GLOW: Readonly<Record<GgFaceMood, string>> = {
  ready: "#5cf2ff", // the robot's own cyan
  happy: "#7ee2a0", // success green
  curious: "#f2c45a", // warning amber
  worried: "#f2c45a",
  sad: "#f2c45a",
  shocked: "#ff6b78", // error red
};

function robot(): CritterDef {
  const def = CRITTERS.find((c) => c.id === "robot");
  if (!def) throw new Error("the Robot critter is missing from the roster");
  return def;
}

/** The robot's screen: rows 6–8, columns 5–12 (8×3). */
const SCREEN_ROW = 6;
const SCREEN_COL = 5;

/** Each frame's face on the 8×3 screen. C glows; K is the dark screen. */
const SCREENS: Readonly<Record<GgFaceFrame, readonly string[]>> = {
  // The robot's own look: two dot eyes and a small mouth.
  ready: ["KKKKKKKK", "KCKKKKCK", "KKKCCKKK"],
  blink: ["KKKKKKKK", "CCKKKKCC", "KKKCCKKK"],
  // Dot eyes and a big smile.
  happy: ["KCKKKKCK", "CKKKKKKC", "KCCCCCCK"],
  // Eyes glancing up and over, a little mouth to the side: "hmm, your call?"
  curious: ["KKKCKKKC", "KKKKKKKK", "KKKKKCCK"],
  // Dot eyes, a tight flat mouth, and a sweat drop.
  worried: ["KCKKKKCK", "KKKKKKKK", "KKCCCCKK"],
  // Eyes cast down and a flat mouth (with a tear and a drooping antenna).
  sad: ["KKKKKKKK", "CCKKKKCC", "KKCCCCKK"],
  // Wide eyes and an "o" mouth.
  shocked: ["CCKKKKCC", "CCKKKKCC", "KKKCCKKK"],
};

/** Extra marks outside the screen: a tear for sad, a sweat drop for worried. */
const EXTRAS: Readonly<Partial<Record<GgFaceFrame, readonly (readonly [number, number])[]>>> = {
  sad: [
    [2, 8],
    [2, 9],
  ],
  worried: [
    [15, 4],
    [15, 5],
  ],
};

/** Whole rows a frame swaps in: sad's antenna droops to one side. */
const ROWS: Readonly<Partial<Record<GgFaceFrame, Readonly<Record<number, string>>>>> = {
  sad: {
    0: ".....OAAO.........",
    1: "......OAO.........",
    2: ".......OO.........",
  },
};

/** The grid for one frame: the Robot critter with that frame's face. */
export function ggFaceRows(frame: GgFaceFrame): readonly string[] {
  const screen = SCREENS[frame];
  const swaps = ROWS[frame] ?? {};
  const rows = robot().rows.map((base, y) => {
    const row = swaps[y] ?? base;
    const face = screen[y - SCREEN_ROW];
    if (face === undefined) return row;
    return row.slice(0, SCREEN_COL) + face + row.slice(SCREEN_COL + face.length);
  });
  for (const [x, y] of EXTRAS[frame] ?? []) {
    const row = rows[y];
    if (row !== undefined) rows[y] = row.slice(0, x) + "T" + row.slice(x + 1);
  }
  return rows;
}

/**
 * One frame as an SVG data URL (one unit per cell; scale it up pixelated).
 * `glow` colours the face; it defaults to the mood's own colour.
 */
export function renderGgFace(frame: GgFaceFrame, glow?: string): string {
  const mood: GgFaceMood = frame === "blink" ? "ready" : frame;
  const def = robot();
  return renderCritterRows(
    { ...def, materials: { ...def.materials, C: "flat", T: "flat" } },
    ggFaceRows(frame),
    undefined,
    { ...def.palette, C: glow ?? GG_FACE_GLOW[mood], T: "#7cc8ff" },
  );
}
