// Idle habits: what a critter does with itself between tasks. Common fidgets
// plus a signature move for most species (hyped critters hop and twirl more).
// Only moves that read at real size (28px) live here: a prop, an icon or a
// big obvious motion. Subtle posture-only fidgets were cut.

import { discard } from "./critter-fx";
import { PRIO } from "./critter-types";
import type { Critter, CritterApi, Ok, Variant } from "./critter-types";

/** What each species' signature move is (Ghost and Shroom have none). */
export const SIGNATURE_LABELS = {
  bee: "loop-de-loop",
  fox: "pounce",
  cat: "nap / big stretch / tail chase",
  owl: "head swivel",
  frog: "catches a fly",
  robot: "beep boop scan",
  wizard: "sparkle spell (sometimes backfires)",
  knight: "sword flourish",
  builder: "floor tap",
  crab: "side-shuffle dance",
  axolotl: "blows bubbles",
  dino: "tiny roar",
  slime: "jiggle bounce",
} as const satisfies Readonly<Record<string, string>>;

type SignatureSpecies = keyof typeof SIGNATURE_LABELS;
type Move = (c: Critter, ok: Ok) => Promise<void>;

interface Fidget extends Variant {
  readonly run: Move;
}

export interface CritterIdle {
  /** Pick and play a fidget. */
  fidget(c: Critter): void;
  /** Tripped over nothing while walking. Rare. */
  trip(c: Critter): void;
}

function isSignatureSpecies(id: string): id is SignatureSpecies {
  return Object.prototype.hasOwnProperty.call(SIGNATURE_LABELS, id);
}

export function makeCritterIdle(api: CritterApi): CritterIdle {
  const { fx } = api;
  const { rand, pick, chance, wait, play, prop, layer } = fx;

  const tiltT = (c: Critter, deg: number, dy = 0): string =>
    `translateY(${dy}px) rotate(${deg * c.dir}deg)`;
  const tilt = (c: Critter, deg: number, dy = 0): Keyframe => ({ transform: tiltT(c, deg, dy) });
  const side = (c: Critter): string => (c.dir < 0 ? " left" : "");
  const hop = (c: Critter, h = 6, ms = 320): Promise<void> =>
    play(
      c.body,
      [
        { transform: "none" },
        { transform: `translateY(${-h}px) scale(0.94, 1.08)`, offset: 0.45 },
        { transform: "scale(1.1, 0.9)", offset: 0.8 },
        { transform: "none" },
      ],
      { duration: ms, easing: "ease-out" },
    );
  const twirl = (c: Critter, ms = 600): Promise<void> =>
    play(
      c.body,
      [
        { transform: "scaleX(1)" },
        { transform: "scaleX(0.05)", offset: 0.25 },
        { transform: "scaleX(-1)", offset: 0.5 },
        { transform: "scaleX(0.05)", offset: 0.75 },
        { transform: "scaleX(1)" },
      ],
      { duration: ms, easing: "linear" },
    );
  const flip = (c: Critter): void => api.face(c, c.dir === 1 ? -1 : 1);

  // ── Species signatures ──
  const SIGNATURES: Readonly<Record<SignatureSpecies, Move>> = {
    async bee(c) {
      const r = 9;
      const frames: Keyframe[] = [];
      for (let i = 0; i <= 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        frames.push({
          transform: `translate(${Math.sin(a) * r * c.dir}px, ${(Math.cos(a) - 1) * r}px) rotate(${i * 30 * c.dir}deg)`,
        });
      }
      fx.sparks(c, 4);
      await play(c.body, frames, { duration: 900, easing: "linear" });
    },
    async fox(c, ok) {
      await play(c.body, [{ transform: "none" }, { transform: "scale(1.2, 0.75)" }], {
        duration: 300,
        fill: "forwards",
      });
      const wiggle: Keyframe[] = [];
      for (let i = 0; i < 6; i++) {
        wiggle.push({ transform: `translateX(${i % 2 ? 1 : -1}px) scale(1.2, 0.75)` });
      }
      await play(c.body, wiggle, { duration: 420 });
      if (!ok()) return;
      void api.tweenX(c, c.x + c.dir * 30, 480);
      await play(
        c.body,
        [
          { transform: "scale(1.2, 0.75)" },
          {
            transform: `translateY(-16px) rotate(${-12 * c.dir}deg) scale(0.9, 1.1)`,
            offset: 0.45,
          },
          { transform: `translateY(0) rotate(${10 * c.dir}deg) scale(1.25, 0.75)`, offset: 0.85 },
          { transform: "none" },
        ],
        { duration: 560, easing: "ease-in-out" },
      );
      fx.puffs(c, 4, fx.mid(), 0);
      if (ok()) fx.say(c, pick(["got it!", "…missed", "pounce!", "hm, nothing"]), 900, true);
    },
    async cat(c, ok) {
      const mode = pick(["nap", "loaf", "tail"] as const);
      if (mode === "nap") {
        c.el.classList.add("sitting");
        // BadgeKind has no "zz"; setBadge clears any .critter-badge, so this
        // hand-made one is replaced/cleared like the rest.
        fx.setBadge(c, null);
        fx.el("div", "critter-badge critter-badge-zz", c.el).textContent = "z Z";
        await wait(rand(2200, 3400));
        if (!ok()) return;
        fx.setBadge(c, null);
        c.el.classList.remove("sitting");
        await hop(c, 3);
      } else if (mode === "loaf") {
        await play(
          c.body,
          [
            { transform: "none" },
            { transform: `scale(1.38, 0.68) rotate(${4 * c.dir}deg)`, offset: 0.4 },
            { transform: `scale(1.38, 0.68) rotate(${4 * c.dir}deg)`, offset: 0.75 },
            { transform: "none" },
          ],
          { duration: 1500, easing: "ease-in-out" },
        );
      } else {
        for (let i = 0; i < 6 && ok(); i++) {
          flip(c);
          await wait(110);
        }
        if (ok()) fx.dizzy(c, 900);
      }
    },
    async owl(c, ok) {
      for (let i = 0; i < 4 && ok(); i++) {
        flip(c);
        await wait(rand(140, 260));
      }
      if (ok()) fx.say(c, pick(["hoo?", "hoo hoo", "who?"]), 900, true);
    },
    async frog(c, ok) {
      const fly = prop(c, "fly", { at: { x: 25, y: 8 }, flicker: 80, mirror: false });
      const buzz = fly.node.animate(
        [
          { transform: "none" },
          { transform: "translate(3px, -3px)" },
          { transform: "translate(-2px, -1px)" },
          { transform: "none" },
        ],
        { duration: 500, iterations: Infinity },
      );
      await wait(rand(700, 1200));
      if (!ok()) return;
      const tongue = layer(c, `critter-tongue${side(c)}`);
      await play(tongue, [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
        duration: 110,
        fill: "forwards",
      });
      const caught = chance(0.7);
      if (caught) {
        buzz.cancel();
        discard(fly.node);
      }
      await play(tongue, [{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], {
        duration: 160,
        fill: "forwards",
      });
      discard(tongue);
      if (!ok()) return;
      if (caught) {
        fx.say(c, pick(["gulp", "*munch*", "yum"]), 800, true);
        await play(
          c.body,
          [{ transform: "none" }, { transform: "scale(1.12, 0.92)" }, { transform: "none" }],
          { duration: 300 },
        );
      } else {
        fx.say(c, "…", 800, true);
        await play(
          fly.node,
          [
            { transform: "none", opacity: 1 },
            { transform: "translate(30px, -20px)", opacity: 0 },
          ],
          { duration: 500, fill: "forwards" },
        );
      }
    },
    async robot(c, ok) {
      fx.say(c, "beep", 600, true);
      const beam = layer(c, `critter-scan${side(c)}`);
      await wait(1200);
      discard(beam);
      if (ok()) fx.say(c, pick(["boop", "boop?", "all clear"]), 700, true);
    },
    async wizard(c, ok) {
      await play(c.body, [{ transform: "none" }, tilt(c, -10)], {
        duration: 300,
        fill: "forwards",
      });
      for (let i = 0; i < 3 && ok(); i++) {
        fx.stars(c, fx.frontX(c, 12), fx.size(), 3, pick(["#b07cff", "#ffe14d", "#8fdcff"]));
        await wait(220);
      }
      if (!ok()) return;
      if (chance(0.25)) {
        fx.puffs(c, 6, fx.mid(), fx.size() * 0.6);
        c.el.classList.add("sooty");
        fx.say(c, "…oops", 900, true);
        await play(c.body, [tilt(c, -10), { transform: "none" }], { duration: 300 });
        await wait(900);
        c.el.classList.remove("sooty");
      } else {
        fx.say(c, pick(["✨", "ta-da!", "abra…"]), 800);
        await play(c.body, [tilt(c, -10), { transform: "none" }], { duration: 300 });
      }
    },
    async knight(c) {
      const slash = layer(c, `critter-slash${side(c)}`);
      await Promise.all([
        play(c.body, [{ transform: "none" }, tilt(c, 14), { transform: "none" }], {
          duration: 380,
        }),
        play(
          slash,
          [
            { opacity: 0, transform: "rotate(-60deg)" },
            { opacity: 1, offset: 0.3 },
            { opacity: 0, transform: "rotate(60deg)" },
          ],
          { duration: 380 },
        ),
      ]);
      discard(slash);
      if (chance(0.5)) fx.say(c, pick(["hah!", "en garde", "for the repo!"]), 900);
    },
    async builder(c, ok) {
      const hammer = prop(c, "hammer", { at: { x: 14, y: 3 } });
      for (let i = 0; i < 3 && ok(); i++) {
        await play(
          hammer.node,
          [
            { transform: "none" },
            { transform: `rotate(${-60 * c.dir}deg)` },
            { transform: `rotate(${40 * c.dir}deg)` },
          ],
          { duration: 300 },
        );
        fx.stars(c, fx.frontX(c, 16), 1, 2);
      }
      await hammer.put();
    },
    async crab(c, ok) {
      fx.notes(c, 3, "#ff8a5c");
      for (let i = 0; i < 4 && ok(); i++) {
        await api.tweenX(c, c.x + (i % 2 ? -1 : 1) * 8, 180);
        await play(
          c.body,
          [{ transform: "none" }, { transform: "translateY(-2px)" }, { transform: "none" }],
          { duration: 120 },
        );
      }
    },
    async axolotl(c) {
      fx.blubs(c, 5);
      if (chance(0.5)) fx.say(c, "blub", 800);
      await play(
        c.body,
        [{ transform: "none" }, { transform: "scale(1.06, 0.95)" }, { transform: "none" }],
        { duration: 500, iterations: 2 },
      );
    },
    async dino(c, ok) {
      await play(
        c.body,
        [{ transform: "none" }, { transform: `${tiltT(c, -10)} scale(0.95, 1.1)` }],
        { duration: 300, fill: "forwards" },
      );
      if (!ok()) return;
      fx.say(c, pick(["rawr", "RAWR", "rawr!"]), 900, true);
      const frames: Keyframe[] = [];
      for (let i = 0; i < 8; i++) {
        frames.push({ transform: `translateX(${i % 2 ? 1 : -1}px) scale(1.05, 1.02)` });
      }
      frames.push({ transform: "none" });
      await play(c.body, frames, { duration: 500 });
      if (ok() && chance(0.3)) fx.say(c, "(tiny)", 800, true);
    },
    async slime(c) {
      await play(
        c.body,
        [
          { transform: "none" },
          { transform: "scale(1.3, 0.7)" },
          { transform: "scale(0.8, 1.25)" },
          { transform: "scale(1.15, 0.85)" },
          { transform: "scale(0.95, 1.05)" },
          { transform: "none" },
        ],
        { duration: 800 },
      );
      for (let i = 0; i < 4; i++) {
        fx.particle(c, {
          cls: "critter-pt-dot",
          color: c.def.palette.B,
          x: fx.mid(),
          y: 6,
          dx: rand(-14, 14),
          dy: -2,
          arc: rand(6, 12),
          dur: 500,
          ease: "linear",
        });
      }
      await hop(c, 10, 420);
    },
  };

  function signature(c: Critter, ok: Ok): Promise<void> {
    const id = c.def.id;
    return isSignatureSpecies(id) ? SIGNATURES[id](c, ok) : hop(c);
  }

  // ── Common fidgets ──
  const FIDGETS: readonly Fidget[] = [
    {
      id: "look",
      w: 3,
      run: async (c, ok) => {
        const n = chance(0.5) ? 2 : 3;
        for (let i = 0; i < n && ok(); i++) {
          await wait(rand(350, 750));
          if (ok()) flip(c);
        }
        if (ok() && chance(0.3)) await fx.flashBadge(c, "yikes", "?", 600);
      },
    },
    {
      id: "happy-hop",
      w: (c) => (c.hyped ? 6 : 2),
      run: async (c, ok) => {
        const n = chance(0.5) ? 2 : 3;
        for (let i = 0; i < n && ok(); i++) {
          await hop(c, rand(5, 9), 300);
          if (chance(0.5)) fx.sparks(c, 3);
        }
      },
    },
    {
      id: "twirl",
      w: (c) => (c.hyped ? 4 : 1.5),
      run: async (c, ok) => {
        if (chance(0.4)) fx.notes(c, 2);
        await twirl(c, rand(500, 700));
        if (ok() && chance(0.4)) await twirl(c, 500);
      },
    },
    {
      id: "sneeze",
      w: 0.8,
      run: async (c, ok) => {
        fx.say(c, "a… a…", 700, true);
        await play(
          c.body,
          [{ transform: "none" }, { transform: `${tiltT(c, -8)} scale(0.95, 1.1)` }],
          { duration: 650, fill: "forwards", easing: "ease-in" },
        );
        if (!ok()) return;
        fx.say(c, "ACHOO!", 800, true);
        fx.puffs(c, 5, fx.frontX(c, 13), 8, c.dir);
        void api.tweenX(c, c.x - c.dir * 6, 160);
        await play(
          c.body,
          [{ transform: `${tiltT(c, 12)} scale(1.1, 0.9)` }, { transform: "none" }],
          { duration: 400, easing: "ease-out" },
        );
      },
    },
    {
      id: "coffee",
      w: 1,
      run: async (c, ok) => {
        // Raised near the face so the mug (handle + coffee) reads at real size.
        const mug = prop(c, "mug", { at: { x: 14, y: 8 } });
        for (let i = 0; i < 2 && ok(); i++) {
          fx.steam(c, fx.frontX(c, 15), 24, 2);
          await wait(rand(500, 800));
          if (!ok()) return;
          await Promise.all([
            play(c.body, [{ transform: "none" }, tilt(c, -8), { transform: "none" }], {
              duration: 700,
            }),
            play(
              mug.node,
              [
                { transform: "none" },
                { transform: `translateY(-4px) rotate(${-30 * c.dir}deg)` },
                { transform: "none" },
              ],
              { duration: 700 },
            ),
          ]);
        }
        await wait(300);
        await mug.put();
      },
    },
    {
      id: "whistle",
      w: 1.2,
      run: async (c) => {
        fx.notes(c, 4);
        await play(
          c.body,
          [tilt(c, -4), tilt(c, 4), tilt(c, -4), tilt(c, 4), { transform: "none" }],
          { duration: 1600, easing: "ease-in-out" },
        );
      },
    },
    {
      id: "wave",
      w: 0.8,
      run: async (c) => {
        fx.say(c, pick(["o/", "hi!", "hey you", "👋"]), 1000, true);
        await play(
          c.body,
          [{ transform: "none" }, tilt(c, -10), tilt(c, 8), tilt(c, -8), { transform: "none" }],
          { duration: 800, easing: "ease-in-out" },
        );
      },
    },
    {
      id: "signature",
      // Ghost and Shroom have no signature: theirs didn't read at real size.
      w: (c) => (isSignatureSpecies(c.def.id) ? 2.5 : 0),
      run: signature,
    },
  ];

  function fidget(c: Critter): void {
    const f = api.pickVariant(c, "fidget", FIDGETS);
    void api.perform(c, PRIO.idle, (ok) => f.run(c, ok));
  }

  function trip(c: Critter): void {
    const down: Keyframe = { transform: `rotate(${80 * c.dir}deg) translateY(2px)` };
    void api.perform(c, PRIO.idle, async (ok) => {
      await play(c.body, [{ transform: "none" }, down], {
        duration: 220,
        fill: "forwards",
        easing: "ease-in",
      });
      fx.puffs(c, 4, fx.frontX(c, 12), 0);
      await wait(700);
      if (!ok()) return;
      await play(c.body, [down, { transform: "none" }], { duration: 300, easing: "ease-out" });
      fx.say(c, pick(["…nobody saw that", "I'm ok!", "meant to do that", "ow"]), 1100, true);
      await wait(200);
    });
  }

  return { fidget, trip };
}
