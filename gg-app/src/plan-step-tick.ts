import { renderPixelGrid } from "./critter-sprites";
import { INK_COLOR } from "./critter-shade";

// A green tick drawn like the critters: 18×18 cells shown one CSS px each, an
// ink outline, a lit top edge and a shaded underside. Fixed art colours with
// the ink outline, so it reads on both themes.
const TICK_ROWS: readonly string[] = [
  "..................",
  "..................",
  "..............KKK.",
  ".............KLLLK",
  "............KLGGGK",
  "...........KLGGGDK",
  "..KKK.....KLGGGDK.",
  ".KLLLK...KLGGGDK..",
  ".KGGGLK.KLGGGDK...",
  ".KDGGGLKLGGGDK....",
  "..KDGGGLGGGDK.....",
  "...KDGGGGGDK......",
  "....KDGGGDK.......",
  ".....KDDDK........",
  "......KKK.........",
  "..................",
  "..................",
  "..................",
];

const TICK_PALETTE = { K: INK_COLOR, L: "#b6f59a", G: "#4ad86a", D: "#26924a" } as const;

export const PLAN_STEP_TICK = renderPixelGrid(TICK_ROWS, TICK_PALETTE, { width: 18, height: 18 });
