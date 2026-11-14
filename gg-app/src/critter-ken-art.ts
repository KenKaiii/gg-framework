// Strong Ken, who turns up when a monster means it: the app's Ken (buzzcut,
// skin and navy tee, as in ken-face.ts and on the farm) with a fighter's
// build, in nine poses. Facing right; the stage flips him.

import { Grid, make, type Art } from "./critter-art";
import { KEN_FACE_PALETTE } from "./ken-face";

type P2 = readonly [number, number];
interface KenPose {
  // Elbow then fist of the back and the front arm.
  readonly armB: readonly [P2, P2];
  readonly armF: readonly [P2, P2];
  // Knee then foot of each leg.
  readonly legB: readonly [P2, P2];
  readonly legF: readonly [P2, P2];
  // How far the body is lowered (feet stay put).
  readonly drop?: number;
  readonly face?: "grin" | "yell";
}

// prettier-ignore
const KEN_POSES = {
  stand: { armB: [[4, 12], [5, 16]], armF: [[18, 12], [17, 16]], legB: [[9, 20], [9, 24]], legF: [[14, 20], [14, 24]] },
  run0: { armB: [[4, 12], [2, 15]], armF: [[19, 11], [21, 8]], legB: [[7, 20], [4, 23]], legF: [[15, 19], [17, 24]] },
  run1: { armB: [[4, 11], [6, 14]], armF: [[18, 11], [16, 14]], legB: [[10, 20], [10, 24]], legF: [[14, 19], [12, 22]], drop: -1 },
  punch: { armB: [[3, 10], [5, 13]], armF: [[20, 8], [24, 8]], legB: [[7, 20], [5, 24]], legF: [[15, 20], [16, 24]], face: "yell" },
  upper: { armB: [[4, 12], [6, 14]], armF: [[19, 5], [19, 0]], legB: [[9, 20], [8, 24]], legF: [[14, 20], [15, 24]], face: "yell" },
  flex: { armB: [[2, 7], [4, 3]], armF: [[20, 7], [18, 3]], legB: [[8, 20], [7, 24]], legF: [[15, 20], [16, 24]], face: "grin" },
  kick: { armB: [[3, 10], [2, 13]], armF: [[18, 11], [19, 14]], legB: [[8, 19], [11, 22]], legF: [[17, 17], [22, 17]], face: "yell" },
  land: { armB: [[3, 9], [1, 6]], armF: [[19, 13], [20, 19]], legB: [[6, 21], [7, 24]], legF: [[17, 21], [16, 24]], drop: 4 },
  power: { armB: [[3, 11], [5, 13]], armF: [[19, 11], [17, 13]], legB: [[8, 20], [6, 24]], legF: [[15, 20], [17, 24]], drop: 1, face: "yell" },
} satisfies Record<string, KenPose>;
export type KenPoseName = keyof typeof KEN_POSES;

// His look lives here and in head(): restyle him by changing these two.
const KEN_LOOK: Readonly<Record<string, string>> = {
  s: KEN_FACE_PALETTE.F ?? "#f7dcc4", // skin
  h: KEN_FACE_PALETTE.H ?? "#3d302a", // buzzcut
  f: KEN_FACE_PALETTE.h ?? "#6e5a4d", // stubble flecks, faded temples
  T: KEN_FACE_PALETTE.G ?? "#2f4a7a", // tee
  t: "#243a62", // the tee's hem, in shade
  p: "#3a3d4a", // trousers
  k: "#2a1e1a", // shoes
  r: "#e0364f", // gloves
  K: KEN_FACE_PALETTE.E ?? "#1d1418", // eyes
  m: KEN_FACE_PALETTE.K ?? "#4a1a1e", // open mouth
  w: "#ffffff", // grin
};

function head(g: Grid, x: number, y: number, face: KenPose["face"]): void {
  // Buzzed cap with a hairline, the temple faded down the back of the head.
  g.rect(x + 8, y, 7, 2, "h").rect(x + 8, y + 2, 1, 3, "f");
  g.set(x + 10, y, "f").set(x + 13, y + 1, "f");
  g.rect(x + 9, y + 2, 6, 4, "s").rect(x + 10, y + 6, 4, 1, "s");
  g.set(x + 12, y + 4, "K").set(x + 14, y + 4, "K");
  if (face === "grin") g.rect(x + 12, y + 5, 3, 1, "w");
  else if (face === "yell") g.rect(x + 13, y + 5, 2, 1, "m").set(x + 13, y + 6, "m");
}

function ken(pose: KenPose): Art {
  const g = new Grid(28, 28);
  const OX = 1;
  const OY = 2;
  const d = pose.drop ?? 0;
  const limb = (a: P2, b: P2, r: number, ch: string): void => {
    const n = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1) * 2);
    for (let i = 0; i <= n; i++)
      g.ellipse(OX + a[0] + ((b[0] - a[0]) * i) / n, OY + a[1] + ((b[1] - a[1]) * i) / n, r, r, ch);
  };
  const body = (p: P2): P2 => [p[0], p[1] + d];
  const arm = (shoulder: P2, [elbow, fist]: readonly [P2, P2]): void => {
    limb(body(shoulder), body(elbow), 1.9, "s");
    limb(body(elbow), body(fist), 1.5, "s");
    g.ellipse(OX + fist[0], OY + fist[1] + d, 1.9, 1.9, "r");
  };
  const leg = (hip: P2, [knee, foot]: readonly [P2, P2]): void => {
    limb(body(hip), knee, 1.7, "p");
    limb(knee, foot, 1.5, "p");
    g.ellipse(OX + foot[0] + 0.6, OY + foot[1] + 0.4, 2.3, 1.5, "k");
  };
  arm([6, 8], pose.armB);
  leg([9.5, 16], pose.legB);
  leg([13.5, 16], pose.legF);
  // Chest tapering to the waist, the neck showing, the hem in shade.
  const x = OX;
  const y = OY + d;
  g.rect(x + 7, y + 7, 9, 5, "T")
    .rect(x + 8, y + 12, 7, 3, "T")
    .rect(x + 8, y + 15, 7, 1, "t");
  g.rect(x + 10, y + 7, 3, 1, "s").set(x + 11, y + 8, "s");
  head(g, x, y, pose.face);
  arm([16, 8], pose.armF);
  return make(
    g,
    KEN_LOOK,
    { s: "skin", T: "cloth", t: "cloth", p: "cloth", k: "cloth", w: "flat", m: "flat", K: "flat" },
    { seed: 23 },
  );
}

let cached: Readonly<Record<KenPoseName, Art>> | null = null;
export function kenArt(): Readonly<Record<KenPoseName, Art>> {
  cached ??= Object.fromEntries(
    (Object.keys(KEN_POSES) as KenPoseName[]).map((k) => [k, ken(KEN_POSES[k])]),
  ) as Record<KenPoseName, Art>;
  return cached;
}
