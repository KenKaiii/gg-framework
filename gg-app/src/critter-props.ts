// Tiny pixel-art props the critters hold or use while they work. Same grid
// format as critter-sprites.ts: `.` is transparent, any other character is a
// key into PROP_PALETTE. Drawn facing right; mirrored in CSS when the critter
// faces left. Colours are art, not theme roles, so they stay literal here.
//
// Like the critters, the grids are material maps: at render time each prop
// gets an outline round it and is lit by critter-shade.ts (form shading from
// the top left, hue-shifted ramps, outlines coloured from what they wrap), so
// a book in a critter's paws is shaded the same way as the paws.

import { renderColorGrid, shadeGrid, type Material } from "./critter-shade";

const PROP_PALETTE: Readonly<Record<string, string>> = {
  O: "#1b1c24", // outline
  W: "#f1efe6", // paper
  L: "#8c93ab", // text lines
  B: "#c0533a", // book cover
  b: "#7a2f22", // cover shade
  G: "#b5bccb", // metal
  g: "#5d6578", // dark metal
  H: "#9a6434", // wood
  C: "#8fdcff", // glass
  c: "#3aa7d9", // deep glass (gem / crystal facets)
  K: "#15161c", // screen
  N: "#5ef08a", // terminal green
  Y: "#ffe14d", // bulb
  y: "#f2b53a",
  P: "#b07cff", // crystal
  p: "#7c4ddb",
  M: "#e9e4dc", // mug
  m: "#6b3f22", // coffee
  R: "#ff6b60",
  w: "#ffffff",
};

export type PropName =
  | "book"
  | "spellbook"
  | "scroll"
  | "paper"
  | "magnifier"
  | "shovel"
  | "binoculars"
  | "crystal"
  | "hammer"
  | "laptop"
  | "terminal"
  | "gear"
  | "dish"
  | "plane"
  | "letter"
  | "mug"
  | "bulb"
  | "gem"
  | "fly";

interface PropGrid {
  readonly f0: readonly string[];
  readonly f1?: readonly string[];
}

const PROP_GRIDS: Readonly<Record<PropName, PropGrid>> = {
  book: {
    f0: [".WWWOWWW.", "WLLWOWLLW", "WWWWOWWWW", "WLLWOWLLW", "BWWWOWWWB", ".BBBBBBB."],
    f1: [".WWWO.WW.", "WLLWOWWW.", "WWWWOWLLW", "WLLWOWWWW", "BWWWOWWWB", ".BBBBBBB."],
  },
  spellbook: {
    f0: [".WWWOWWW.", "WLLWOWPLW", "WWWWOWWWW", "WPLWOWLLW", "pWWWOWWWp", ".ppYpppp."],
    f1: [".WWWO.WW.", "WLLWOWWW.", "WWWWOWPLW", "WPLWOWWWW", "pWWWOWWWp", ".ppppYpp."],
  },
  scroll: {
    f0: ["HHHHHH", ".WWWW.", ".WLLW.", ".WWWW.", ".WLLW.", ".WWWW.", ".WLWW.", "HHHHHH"],
  },
  paper: {
    f0: ["WWWWWW", "WLLLLW", "WWWWWW", "WLLLWW", "WWWWWW", "WLLWWW", "WWWWWW"],
    f1: ["WWWWWW", "WLLLLW", "WWWWWW", "WLLLLW", "WWWWWW", "WLLLWW", "WWWWWW"],
  },
  magnifier: {
    f0: [".GGG...", "GCCwG..", "GCCCG..", "GCCCG..", ".GGGH..", "....HH.", ".....HH"],
  },
  shovel: {
    f0: ["..H..", "..H..", "..H..", "..H..", "..H..", ".GGG.", ".GGG.", ".GGG.", "..G.."],
  },
  // Front-on, worn over the eyes: two round lenses are what makes it read at 28px.
  binoculars: {
    f0: [".GGG...GGG.", "GOOwG.GOOwG", "GOOOGGGOOOG", "GOOOG.GOOOG", ".GGG...GGG."],
  },
  // Cyan glass on a gold stand, so it doesn't vanish into the wizard's purple.
  crystal: {
    f0: ["..CCC..", ".CwwCC.", "CCwCCCc", "CCCCCcc", ".CCCcc.", "..ccc..", ".yYYYy.", "yyyyyyy"],
    f1: ["..CCC..", ".CCCCC.", "CCCwwCc", "CCCwCcc", ".CCCcc.", "..ccc..", ".yYYYy.", "yyyyyyy"],
  },
  hammer: {
    f0: ["GGGGG", "GGGGg", "..H..", "..H..", "..H..", "..H.."],
  },
  laptop: {
    f0: [".OOOOOOO.", ".OKKKKKO.", ".OKNNNKO.", ".OKKKKKO.", "GGGGGGGGG", ".ggggggg."],
    f1: [".OOOOOOO.", ".OKNKKKO.", ".OKKKKKO.", ".OKNNKKO.", "GGGGGGGGG", ".ggggggg."],
  },
  terminal: {
    f0: ["OOOOOOOO", "OKKKKKKO", "OKNKKKKO", "OKKNKKKO", "OKNKwwKO", "OOOOOOOO"],
    f1: ["OOOOOOOO", "OKKKKKKO", "OKNKKKKO", "OKKNKKKO", "OKNKKKKO", "OOOOOOOO"],
  },
  gear: {
    f0: ["...G...", ".GGGGG.", ".GGgGG.", "GGgggGG", ".GGgGG.", ".GGGGG.", "...G..."],
    f1: [".G...G.", "..GGG..", ".GGgGG.", ".GgggG.", ".GGgGG.", "..GGG..", ".G...G."],
  },
  dish: {
    f0: ["GG.....", "GGG...w", ".GGG.w.", "..GGw..", "...GG..", "..ggg..", ".ggggg."],
  },
  plane: {
    f0: ["WW.....", ".WWWW..", "..LWWWW", ".WWW..."],
  },
  letter: {
    f0: ["WWWWWW", "WLWWLW", "WWLLWW", "WWWWWW"],
  },
  // Handle loop on the side the critter holds; coffee showing at the rim.
  mug: {
    f0: ["..MmmmM", ".MMMMMM", "M.MMMMM", "M.MMMMM", ".MMMMMM", "..MMMMM"],
  },
  bulb: {
    f0: [".YYY.", "YYwYY", "YYYYY", ".YyY.", ".GGG.", "..G.."],
  },
  gem: {
    f0: [".cCwCc.", "cCCwCCc", "ccCCCcc", ".cCCCc.", "..cCc..", "...c..."],
  },
  fly: {
    f0: ["C.C", ".O."],
    f1: [".C.", "COC"],
  },
};

/** Cells of outline round each rendered prop (renderProp): place it this much out. */
export const PROP_PAD = 1;

/** A rendered prop: size in sprite cells and data-URL frames. */
export interface PropArt {
  readonly w: number;
  readonly h: number;
  readonly f0: string;
  readonly f1: string | null;
}

/** How each key takes the light; the screens, glows and hand-placed shades stay as drawn. */
const PROP_MATERIALS: Readonly<Record<string, Material>> = {
  W: "cloth",
  B: "cloth",
  H: "cloth",
  G: "metal",
  M: "gel",
  C: "glass",
  P: "glass",
  Y: "glow",
  L: "flat",
  b: "flat",
  g: "flat",
  c: "flat",
  p: "flat",
  y: "flat",
  K: "flat",
  N: "flat",
  m: "flat",
  R: "flat",
  w: "flat",
};

/** The grid with an outline ("O") one cell round everything drawn, so it reads against fur. */
function outlined(rows: readonly string[]): string[] {
  const w = (rows[0]?.length ?? 0) + 2;
  const h = rows.length + 2;
  const at = (x: number, y: number): string => rows[y - 1]?.[x - 1] ?? ".";
  const out: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) {
      const k = at(x, y);
      if (k !== ".") row += k;
      else
        row += [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)].some((n) => n !== ".")
          ? "O"
          : ".";
    }
    out.push(row);
  }
  return out;
}

/** One grid, outlined and lit, as an SVG data URL (same approach as renderCritterFrame). */
function renderGrid(rows: readonly string[], seed: number): string {
  const grid = outlined(rows);
  return renderColorGrid(
    shadeGrid({ rows: grid, palette: PROP_PALETTE, materials: PROP_MATERIALS, seed }),
    {
      width: grid[0]?.length ?? 0,
      height: grid.length,
    },
  );
}

/** A prop's raw pixel rows and palette, for callers that draw to a canvas. */
export function propGrid(name: PropName): {
  readonly f0: readonly string[];
  readonly f1: readonly string[] | null;
  readonly palette: Readonly<Record<string, string>>;
} {
  const grid = PROP_GRIDS[name];
  return { f0: grid.f0, f1: grid.f1 ?? null, palette: PROP_PALETTE };
}

/** Render a prop's frames. Pure; callers cache the result. */
export function renderProp(name: PropName): PropArt {
  const grid = PROP_GRIDS[name];
  const seed = [...name].reduce((n, ch) => n * 31 + ch.charCodeAt(0), 7);
  // Two cells bigger each way than the grid: the outline round it.
  return {
    w: (grid.f0[0]?.length ?? 0) + 2,
    h: grid.f0.length + 2,
    f0: renderGrid(grid.f0, seed),
    f1: grid.f1 ? renderGrid(grid.f1, seed) : null,
  };
}
