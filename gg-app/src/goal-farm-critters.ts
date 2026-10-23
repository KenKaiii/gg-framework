// The farm's own critters, drawn for the Goal farm's high camera: we look
// down on them as on every building, so the top of the head (a big lit crown)
// is most of each sprite and the face sits low and squat under it, over a
// short body and feet peeking out. Only this world uses them; the app's
// floors keep their front-on critters.
//
// The farm is a Japanese countryside, so its workers are the critters that
// belong there: the app's fox, bee, cat, owl, frog and mushroom, redrawn and
// recoloured for it (a grey tabby, a tawny owl), plus a tanuki, rabbit,
// hedgehog, duck, red panda, squirrel, fawn and chick. 18 wide, 19 tall.
// The grids are material maps, lit at draw time the way the app's critters
// are (litFarmGrid, critter-shade.ts): form shading from the top left,
// hue-shifted ramps, outlines coloured from what they wrap. Keys: O outline,
// T crown, B face, S body, D dark markings and feet, W white fur, K eyes,
// E eye shine, C blush, M mouth; the rest are per critter.

import { shadeGrid, type Material } from "./critter-shade";
import { hashKey, type CritterDef } from "./critter-sprites";

/** Farm critter sprite size, in pixels. */
export const FARM_CRITTER_W = 18;
export const FARM_CRITTER_H = 19;

export const FARM_CRITTERS: readonly CritterDef[] = [
  {
    id: "fox",
    name: "Fox",
    move: "walk",
    palette: {
      O: "#4a1a06",
      T: "#f29a52",
      H: "#ffd4a0",
      B: "#e8782e",
      S: "#c25a1c",
      D: "#8a3a10",
      W: "#fff4e6",
      K: "#1b1208",
      C: "#ff7a6a",
      A: "#2a1208",
      E: "#ffffff",
      M: "#8a2a1a",
    },
    rows: [
      ".OAOO........OOAO.",
      ".OATOOOOOOOOOOTAO.",
      ".OOOTTTTTTTTTTOOO.",
      ".OTTTTTTTTTTTTTTO.",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTBBBBBBBBBBTTTO",
      "OTTBBEKBBBBEKBBTTO",
      "OTTBBKKWWWWKKBBTTO",
      ".OTCCWWWKKWWWCCTO.",
      ".OTBBWWWMMWWWBBTO.",
      "..OOBBWWWWWWBBOOWO",
      "...OOOOOOOOOOOOTTO",
      "...OSSSSSSSSSSOTTO",
      "....OOOSSSSOOOTTTO",
      "....ODDOOOODDOOOO.",
      ".....OO....OO.....",
    ],
    alt: { 16: "....OSOOSSOOSOTTTO", 17: ".....ODDOODDO.OOO.", 18: "......OO..OO......" },
  },
  {
    id: "bee",
    name: "Bee",
    move: "hover",
    palette: {
      O: "#4a2a06",
      T: "#fde58a",
      H: "#fff8d0",
      B: "#f6c83a",
      S: "#d89a1a",
      D: "#2a1a08",
      W: "#ffffff",
      K: "#1b1208",
      C: "#ff8a5c",
      V: "#d8f0ff",
      E: "#ffffff",
      M: "#8a3a1a",
    },
    rows: [
      "......O.....O.....",
      "....OOOOOOOOOO....",
      ".OOOTTTTTTTTTTOOO.",
      "OVVODDDDDDDDDDOVVO",
      "VVVOTTTTTTTTTTOVVV",
      "VVVOTTTTTTTTTTOVVV",
      "VVVODDDDDDDDDDOVVV",
      "OVOTTTTTTTTTTTTOVO",
      "OOTTBBBBBBBBBBTTOO",
      "OTTBBEKBBBBEKBBTTO",
      "OTTBBKKBBBBKKBBTTO",
      ".OTCCBBBBBBBBCCTO.",
      ".OTBBBBBMMBBBBBTO.",
      "..OOBBBBBBBBBBOO..",
      "...OOOOOOOOOOOO...",
      "...OSSSSSSSSSSO...",
      "....OOOOSSOOOO....",
      ".....ODDOODDO.....",
      "......OO.DOO......",
    ],
    alt: {
      2: "..OOTTTTTTTTTTOO..",
      3: ".ODDDDDDDDDDDDDDO.",
      4: "OVOTTTTTTTTTTTTOVO",
      7: "VVVOTTTTTTTTTTOVVV",
      8: "OVVOBBBBBBBBBBOVVO",
      9: "OOOBBEKBBBBEKBBOOO",
    },
  },
  {
    id: "cat",
    name: "Cat",
    move: "walk",
    palette: {
      O: "#2e2a26",
      T: "#b8b2a6",
      H: "#e0dace",
      B: "#9a948a",
      S: "#6e685e",
      D: "#4a453e",
      W: "#ffffff",
      K: "#1b1612",
      C: "#f2a6b4",
      A: "#f2a6b4",
      Z: "#5a554c",
      E: "#ffffff",
    },
    rows: [
      ".OTOO........OOTO.",
      ".OTTOOOOOOOOOOTTO.",
      ".OOOTTTTZZZTTTOOO.",
      ".OTTTZTTTZTTTZTTO.",
      "OTTTTTZTTTTTZTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTZTTTTTTTTTTTTZTO",
      "OTZTTTTTTTTTTTTZTO",
      "OTTTBBBBBBBBBBTTTO",
      "OTTBBEKBBBBEKBBTTO",
      "OTTBBKKBBBBKKBBTTO",
      "OOTCCBWWAAWWBCCTOO",
      ".OTBBBWWWWWWBBBTO.",
      ".OOOBBBBBBBBBBOO..",
      "..OOOOOOOOOOOOO...",
      "...OSSSSSSSSSSO...",
      "....OOOSSSSOOO....",
      "....ODDOOOODDO....",
      ".....OO....OO.....",
    ],
    alt: { 16: "....OSOOSSOOSO....", 17: ".....ODDOODDO.....", 18: "......OO..OO......" },
  },
  {
    id: "owl",
    name: "Owl",
    move: "hover",
    palette: {
      O: "#2a1a0c",
      T: "#c89a64",
      H: "#ecc890",
      B: "#a8784a",
      S: "#7a5232",
      D: "#5a3a20",
      W: "#fbf2e2",
      K: "#1b1208",
      C: "#e8a07a",
      A: "#5a3a20",
      Y: "#f2a630",
      E: "#ffffff",
    },
    rows: [
      "..OAO........OAO..",
      "..OOOOOOOOOOOOOO..",
      "..OTTTTTTTTTTTTO..",
      ".OTTTTDTDTDTDTTTO.",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTDTDTDTDTDTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTWWWWTTWWWWTTTO",
      "OTTWWWWWWWWWWWWTTO",
      "OTTWWKEWWWWKEWWTTO",
      "OTTWWKKWWWWKKWWTTO",
      "OTTTWWWWYYWWWWTTTO",
      ".OCCTTTTYTTTTTCCO.",
      "..OTTTDTDTDTDTTO..",
      "...OOOOOOOOOOOO...",
      "...OSSSSSSSSSSO...",
      "....OSSSSSSSSO....",
      "....OOOOOOOOOO....",
      ".....OO....OO.....",
    ],
    alt: { 17: ".....OOOOOOOO.....", 18: "......OO..OO......" },
  },
  {
    id: "frog",
    name: "Frog",
    move: "hop",
    palette: {
      O: "#22401a",
      T: "#8ec45a",
      H: "#c4e49a",
      B: "#6aa83c",
      S: "#4a8228",
      D: "#2e5a1a",
      W: "#ffffff",
      K: "#0a1a08",
      C: "#f2a0a8",
      E: "#ffffff",
      M: "#1e3a12",
    },
    rows: [
      "...OOOO....OOOO...",
      "..OTTTTO..OTTTTO..",
      "..OTEKKTOOTEKKTO..",
      "..OTKKKTOOTKKKTO..",
      ".OOTTTTTOOTTTTTOO.",
      "OTTOTTTOTTOTTTOTTO",
      "OTTTOOOTTTTOOOTTTO",
      "OTTTTTTDTTTTTTTTTO",
      "OTTDTTTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTDTTO",
      "OTTTTBBBBBBBBTTTTO",
      "OTCCBMMMMMMMMBCCTO",
      ".OTBBBBBBBBBBBBTO.",
      "..OTBBBBBBBBBBTO..",
      "..OOOOOOOOOOOOOO..",
      "..OSSSSSSSSSSSSO..",
      "...OOOSSSSSSOOO...",
      "...OSSOOOOOOSSO...",
      "....OO......OO....",
    ],
    alt: { 16: "...OOOOSSSSOOOO...", 17: "....OSSOOOOSSO....", 18: ".....OO....OO....." },
  },
  {
    id: "shroom",
    name: "Shroom",
    move: "walk",
    palette: {
      O: "#4a0a18",
      T: "#e8443a",
      H: "#ff8a7a",
      B: "#f4e2c4",
      S: "#d8c0a0",
      D: "#b09a7a",
      W: "#fffaf0",
      K: "#2a0d14",
      C: "#ff9ab0",
      Z: "#a82a24",
      E: "#ffffff",
      M: "#8a2a30",
    },
    rows: [
      "....OOOTTTTOOO....",
      "..OOTTTTTTTWWTOO..",
      ".OTTWWTTTTTWWTTTO.",
      "OTTTWWTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTTTTWWTTTTWWTO",
      "OTWWTTTTWWTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      ".OTTTTTTTTTTTTTTO.",
      "..OOZZZZZZZZZZOO..",
      "..OBOOOOOOOOOOBO..",
      "..OBBEKBBBBEKBBO..",
      "..OBBKKBBBBKKBBO..",
      "...CCBBBMMBBBCC...",
      "...OOBBBBBBBBOO...",
      "...OSOOOOOOOOSO...",
      "....OOOSSSSOOO....",
      "....ODDOOOODDO....",
      ".....OO....OO.....",
    ],
    alt: { 16: "....OSOOSSOOSO....", 17: ".....ODDOODDO.....", 18: "......OO..OO......" },
  },
  {
    id: "tanuki",
    name: "Tanuki",
    move: "walk",
    palette: {
      O: "#2a1408",
      T: "#c8925a",
      H: "#e8c08a",
      B: "#b07a48",
      S: "#8a5a30",
      D: "#5a3a1c",
      W: "#ffffff",
      K: "#1b1208",
      C: "#f2a07a",
      A: "#3a2010",
      F: "#f4e2c4",
      E: "#ffffff",
    },
    rows: [
      ".OAAAO......OAAAO.",
      ".OAAOOOOOOOOOOAAO.",
      ".OOOTTTTTTTTTTOOO.",
      ".OTTTTTTTTTTTTTTO.",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTAAAABBAAAATTTO",
      "OTTAAEKAAAAEKAATTO",
      "OTTAAKKAFFAKKAATTO",
      ".OCCBBFFKKFFBBCCO.",
      ".OTBBBFFFFFFBBBTO.",
      "..OOBBBBFFBBBBOO..",
      "...OOOOOOOOOOOO...",
      "...OSSSSSSSSSSO...",
      "....OOOSSSSOOO....",
      "....ODDOOOODDO....",
      ".....OO....OO.....",
    ],
    alt: { 16: "....OSOOSSOOSO....", 17: ".....ODDOODDO.....", 18: "......OO..OO......" },
  },
  {
    id: "rabbit",
    name: "Rabbit",
    move: "hop",
    palette: {
      O: "#4a3030",
      T: "#fbf6ee",
      H: "#ffffff",
      B: "#f0e8dc",
      S: "#d8cabc",
      D: "#b8a898",
      W: "#ffffff",
      K: "#2a1418",
      C: "#f6a0b0",
      A: "#f4a6b4",
      E: "#ffffff",
      M: "#8a4a50",
    },
    rows: [
      "...OTTTO..OTTTO...",
      "...OOOOOOOOOOOO...",
      "..OOTTTTTTTTTTOO..",
      ".OTTTTTTTTTTTTTTO.",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTBBBBBBBBBBTTTO",
      "OTTBBEKBBBBEKBBTTO",
      "OTTBBKKBBBBKKBBTTO",
      ".OTCCBBBAABBBCCTO.",
      ".OTBBBBBMMBBBBBTO.",
      "..OOBBBBBBBBBBOO..",
      "...OOOOOOOOOOOO...",
      "...OSSSSSSSSSSO...",
      "....OOOSSSSOOO....",
      "....ODDOOOODDO....",
      ".....OO....OO.....",
    ],
    alt: {
      0: "...OTTTO...OTTTO..",
      16: "....OSOOSSOOSO....",
      17: ".....ODDOODDO.....",
      18: "......OO..OO......",
    },
  },
  {
    id: "hedgehog",
    name: "Hedgehog",
    move: "scuttle",
    palette: {
      O: "#2a1808",
      T: "#8a5e38",
      H: "#b0845a",
      B: "#e8c494",
      S: "#c49a64",
      D: "#9a7444",
      W: "#ffffff",
      K: "#1b1208",
      C: "#f2a07a",
      A: "#5a3a20",
      E: "#ffffff",
    },
    rows: [
      "...T.OTOOTOOT..T..",
      "...OOTTTTTATTOO...",
      "..OTTTATTTTTTATO..",
      ".TATTTTTTATTTTTTA.",
      "OTTTTATTTTTTATTTTO",
      "OATTTTTTATTTTTTATO",
      "OTTTATTTTTTATTTTTO",
      "ATTTTTTATTTTTTATTT",
      "OTTATOOOOOOOOTTTTO",
      "OTTTOBBBBBBBBOTTTO",
      "OTAOBBBBBBBBBBOTAO",
      ".OTOBEKBBBBEKBOTO.",
      "..OOBKKBBBBKKBOO..",
      "...CCBBBKKBBBCC...",
      "...OOOOBBBBOOOO...",
      "...OSSSOOOOSSSO...",
      "....OOOSSSSOOO....",
      "....ODDOOOODDO....",
      ".....OO....OO.....",
    ],
    alt: { 16: "....OSOOSSOOSO....", 17: ".....ODDOODDO.....", 18: "......OO..OO......" },
  },
  {
    id: "duck",
    name: "Duck",
    move: "walk",
    palette: {
      O: "#3a2e20",
      T: "#fdfaf2",
      H: "#ffffff",
      B: "#f4efe2",
      S: "#d8d0c0",
      D: "#b8ae9a",
      W: "#ffffff",
      K: "#1b1208",
      C: "#f6b0a0",
      Y: "#f2a630",
      Z: "#c8781a",
      E: "#ffffff",
    },
    rows: [
      ".......OTTO.......",
      "....OOOOOTOOOO....",
      "..OOTTTTTOTTTTOO..",
      ".OTTTTTTTTTTTTTTO.",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTBBBBBBBBBBTTTO",
      "OTTBBEKBBBBEKBBTTO",
      "OTTBBKOOOOOOKBBTTO",
      ".OTCCOYYYYYYOCCTO.",
      ".OTBBOYZZZZYOBBTO.",
      "..OOBBOOOOOOBBOO..",
      "...OOOOOOOOOOOO...",
      "...OSSSSSSSSSSO...",
      "....OOOSSSSOOO....",
      "....OYYOOOOYYO....",
      ".....OO....OO.....",
    ],
    alt: { 16: "....OSOOSSOOSO....", 17: ".....OYYOOYYO.....", 18: "......OO..OO......" },
  },
  {
    id: "redpanda",
    name: "Red panda",
    move: "walk",
    palette: {
      O: "#2a0e06",
      T: "#b8482a",
      H: "#d8724a",
      B: "#a83a1e",
      S: "#7a2812",
      D: "#4a180a",
      W: "#fbf2e2",
      K: "#1b0e08",
      C: "#f2a07a",
      A: "#3a140a",
      E: "#ffffff",
    },
    rows: [
      ".OTTTO......OTTTO.",
      ".OWWOOOOOOOOOOWWO.",
      "OTOOTTTTTTTTTTOOTO",
      ".OTTTTTTTTTTTTTTO.",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTWWTTTTTTWWTTTO",
      "OTTTBBBBBBBBBBTTTO",
      "OTTBBEKBBBBEKBBTTO",
      "OTTBBKKWWWWKKBBTTO",
      ".OCCBWWWKKWWWBCCO.",
      ".OTBBWWWWWWWWBBTO.",
      "..OOBBBWWWWBBBOO..",
      "...OOOOOOOOOOOO...",
      "...OAAAAAAAAAAO...",
      "....OOOAAAAOOO....",
      "....OAAOOOOAAO....",
      ".....OO....OO.....",
    ],
    alt: { 16: "....OAOOAAOOAO....", 17: ".....OAAOOAAO.....", 18: "......OO..OO......" },
  },
  {
    id: "squirrel",
    name: "Squirrel",
    move: "hop",
    palette: {
      O: "#2a1408",
      T: "#e09050",
      H: "#f6b87a",
      B: "#c8783a",
      S: "#9a5424",
      D: "#6a3814",
      W: "#fbf0dc",
      K: "#1b0e08",
      C: "#f2a07a",
      A: "#e8a060",
      Y: "#d88a48",
      E: "#ffffff",
      L: "#f6c890",
    },
    rows: [
      "..OAO......OTOOO..",
      "..OTOOOOOOOOOOYYO.",
      "..OOTTTTTTTTTTOYYO",
      "..OTTTTTTTTTTTTOLO",
      ".OTTTTTTTTTTTTTTOO",
      ".OTTTTTTTTTTTTTTOY",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTBBBBBBBBTTTTO",
      "OTTBEKBBBBBEKBBTTO",
      ".OTBKKBBBBBKKBBTOY",
      ".OCCBBWWKKWWBCCTOY",
      "..OBBBWWWWWWBBBOLO",
      "...OTBBBBBBBBTOYYO",
      "...OOOOOOOOOOOOYYO",
      "...OSSSSSSSSSSOYO.",
      "....OOOSSSSOOOOO..",
      "....ODDOOOODDO....",
      ".....OO....OO.....",
    ],
    alt: { 16: "....OSOOSSOOSOOO..", 17: ".....ODDOODDO.....", 18: "......OO..OO......" },
  },
  {
    id: "fawn",
    name: "Fawn",
    move: "walk",
    palette: {
      O: "#2a1808",
      T: "#d8a46c",
      H: "#f0c890",
      B: "#c8925a",
      S: "#a0703c",
      D: "#7a5024",
      W: "#fbf2e2",
      K: "#1b0e08",
      C: "#f2a07a",
      A: "#a0703c",
      E: "#ffffff",
    },
    rows: [
      "..................",
      "....OOOOOOOOOO....",
      "OOOOTTTTTTWTTTOOOO",
      "TOTTTTWTTTTTTTTTOT",
      "OTTTTTTTTTTTWTTTTO",
      "OTTTWTTTWTTTTTTTTO",
      "OTTTTTTTTTTTTTWTTO",
      "OTTTTTTTTTTWTTTTTO",
      "OTTTBBBBBBBBBBTTTO",
      "OTTBBEKBBBBEKBBTTO",
      "OTTBBKKBWWBKKBBTTO",
      ".OTCCBWWKKWWBCCTO.",
      ".OTBBBWWWWWWBBBTO.",
      "..OOBBBBWWBBBBOO..",
      "...OOOOOOOOOOOO...",
      "...OSSSSSSSSSSO...",
      "....OOOSSSSOOO....",
      "....ODDOOOODDO....",
      ".....OO....OO.....",
    ],
    alt: { 16: "....OSOOSSOOSO....", 17: ".....ODDOODDO.....", 18: "......OO..OO......" },
  },
  {
    id: "chick",
    name: "Chick",
    move: "hop",
    palette: {
      O: "#5a3a08",
      T: "#ffe470",
      H: "#fff6b0",
      B: "#ffd94a",
      S: "#f2b02a",
      D: "#c8881a",
      W: "#ffffff",
      K: "#1b1208",
      C: "#ffa07a",
      Y: "#f28a2a",
      E: "#ffffff",
      Z: "#c8681a",
    },
    rows: [
      ".......OOTO.......",
      "....OOOTOTTOOO....",
      "..OOTTTOTOOTTTOO..",
      ".OTTTTTTTTTTTTTTO.",
      ".OTTTTTTTTTTTTTTO.",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTTTTTTTTTTTTTTO",
      "OTTTBBBBBBBBBBTTTO",
      "OTTBBEKBBBBEKBBTTO",
      "OTTBBKKBBBBKKBBTTO",
      "OTTCCBBBYYBBBCCTTO",
      ".OTBBBBBZBBBBBBTO.",
      "..OTBBBBBBBBBBTO..",
      "...OOOTTTTTTOOO...",
      "...OSSOOOOOOSSO...",
      "....OOOSSSSOOO....",
      "....OYYOOOOYYO....",
      ".....OO....OO.....",
    ],
    alt: { 16: "....OSOOSSOOSO....", 17: ".....OYYOOYYO.....", 18: "......OO..OO......" },
  },
];

/** Named agents that have a farm critter of their own; anything else is picked from its id. */
const FARM_CRITTER_FOR_AGENT: Readonly<Record<string, string>> = {
  // GG Goals' own team (packages/ggcoder/src/goals-agent/goal-team.ts).
  builder: "tanuki",
  scout: "squirrel",
  researcher: "owl",
  checker: "hedgehog",
  // GG Coder's agents, seen in older goal sessions.
  bee: "bee",
  owl: "owl",
  worker: "tanuki",
  auditor: "hedgehog",
  skeptic: "cat",
  "control-verifier": "frog",
};

/**
 * Choose a farm critter for an agent, the way the app's floor does: a named
 * agent gets its own critter when it's free; otherwise the id picks a
 * starting point and the first critter not already on the farm wins, so a
 * crowd stays varied. Once every farm critter is out, repeats are allowed.
 */
export function pickFarmCritter(
  agentName: string | undefined,
  key: string,
  taken: ReadonlySet<string>,
): CritterDef {
  const preferredId = agentName ? FARM_CRITTER_FOR_AGENT[agentName] : undefined;
  const preferred = FARM_CRITTERS.find((critter) => critter.id === preferredId);
  if (preferred && !taken.has(preferred.id)) return preferred;
  const start = hashKey(key) % FARM_CRITTERS.length;
  for (let step = 0; step < FARM_CRITTERS.length; step++) {
    const candidate = FARM_CRITTERS[(start + step) % FARM_CRITTERS.length];
    if (candidate && !taken.has(candidate.id)) return candidate;
  }
  const fallback = preferred ?? FARM_CRITTERS[start];
  if (!fallback) throw new Error("farm critter roster is empty");
  return fallback;
}

/**
 * GG Goals itself: a little Ken (the face of Ken, redrawn for the farm's high
 * camera). From up here his buzzcut crown is most of the sprite, his face
 * squat beneath it with the same narrow eyes, blush and grin, then a navy
 * tee and little feet. Not in FARM_CRITTERS: no worker is ever Ken, so GG
 * Goals stands apart from the crowd.
 */
export const KEN_FARM_CRITTER: CritterDef = {
  id: "ken",
  name: "Ken",
  move: "walk",
  palette: {
    O: "#1c120e", // outline
    T: "#3d302a", // buzzcut (lit crown)
    H: "#6e5a4d", // stubble flecks and the light on the crown
    A: "#ecbf9f", // ears
    B: "#f7dcc4", // skin
    D: "#e3b796", // skin shade
    K: "#1d1418", // eyes
    C: "#f4a99e", // blush
    M: "#b5554c", // smile
    S: "#2f4a7a", // tee
    W: "#4a6aa0", // tee, lit
    L: "#2a1e1a", // shoes
    E: "#ffffff",
    P: "#fbf1e0",
  },
  rows: [
    "..................",
    "....OOOOOOOOOO....",
    "...OTTHTTTTTHTO...",
    "..OHTTTTTHTTTTTO..",
    ".OTTTTHTTTTTHTTTO.",
    ".OTHTTTTTHTTTTTHO.",
    ".OTTTTHTTTTTHTTTO.",
    ".OTHTTTBBBBTTTTHO.",
    "OAOTBBBBBBBBBBTOAO",
    "AAOBBEKBBBBEKBBOAA",
    "AAOBBKKBBBBKKPPOAA",
    "OOTCCBBMBBBBBCCTOO",
    "..OBBBBMMMMBBBBO..",
    "...OBBBBBBBBBBO...",
    "..OSOOOOOOOOOOSO..",
    "..OSSSSSSSSSSSSO..",
    "...OOOOSSSSOOOO...",
    "....OLLOOOOLLO....",
    ".....OO....OO.....",
  ],
  alt: { 16: "...OOSOOSSOOSOO...", 17: ".....OLLOOLLO.....", 18: "......OO..OO......" },
};

const BY_ID = new Map([...FARM_CRITTERS, KEN_FARM_CRITTER].map((critter) => [critter.id, critter]));

/** A farm critter by id (the first one if unknown). */
export function farmCritterLook(id: string): CritterDef {
  const look = BY_ID.get(id) ?? FARM_CRITTERS[0];
  if (!look) throw new Error("farm critter roster is empty");
  return look;
}

/** How the farm critters' keys take the light (critter-shade.ts); the rest are fur. */
const FARM_MATERIALS: Readonly<Record<string, Material>> = {
  K: "flat",
  E: "flat",
  C: "flat",
  M: "flat",
  N: "flat",
  P: "flat",
  V: "glass",
};
/** Ken's own: skin, a buzzcut, a cotton tee. */
const KEN_MATERIALS: Readonly<Record<string, Material>> = {
  ...FARM_MATERIALS,
  B: "skin",
  A: "skin",
  T: "cloth",
  H: "flat",
  S: "cloth",
  W: "cloth",
  L: "cloth",
};

/** Lit frames, per critter and grid (a step or a blink is its own grid). */
const LIT = new Map<string, { rows: string[]; palette: Record<string, string> }>();

/**
 * A farm critter's grid, lit (form shading, hue-shifted ramps, coloured
 * outlines), handed back as rows and a palette with one key per colour so the
 * farm's grid painters draw it unchanged.
 */
export function litFarmGrid(
  def: CritterDef,
  rows: readonly string[],
): { rows: string[]; palette: Record<string, string> } {
  const key = `${def.id}:${rows.join("|")}`;
  const have = LIT.get(key);
  if (have) return have;
  const lit = shadeGrid({
    rows,
    palette: def.palette,
    materials: def.id === "ken" ? KEN_MATERIALS : FARM_MATERIALS,
    seed: hashKey(def.id),
    // Seen from above, a crown is most of the sprite: model it gently, so it
    // keeps its colour with a lit edge, not a flood of highlight.
    relief: 0.55,
  });
  const palette: Record<string, string> = {};
  const keyOf = new Map<string, string>();
  const out = lit.map((row) =>
    row
      .map((c) => {
        if (!c) return ".";
        let k = keyOf.get(c);
        if (!k) {
          k = String.fromCharCode(0x100 + keyOf.size);
          keyOf.set(c, k);
          palette[k] = c;
        }
        return k;
      })
      .join(""),
  );
  const made = { rows: out, palette };
  LIT.set(key, made);
  return made;
}
