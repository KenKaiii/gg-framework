// Critters noticing each other: what happens when two cross paths, when one
// goes looking for company, and how they react when a teammate finishes or
// falls over. Pair moves pick by weight and never repeat the last two used.

import { PRIO } from "./critter-types";
import type { Critter, CritterApi, Ok, Variant, VariantOwner } from "./critter-types";

export interface CritterSocial {
  scan(now: number): void;
  seek(c: Critter): boolean;
  arrived(c: Critter): boolean;
  cheer(done: Critter): void;
  checkOn(fallen: Critter): number;
  passBehind(c: Critter): void;
  grounded(c: Critter): boolean;
}

type Dir = 1 | -1;
interface Dirs {
  readonly a: Dir;
  readonly b: Dir;
}

/** a = the one walking in, b = the one it ran into. */
interface PairMove extends Variant {
  readonly weight: number | ((a: Critter, b: Critter) => number);
  readonly fit: (a: Critter, b: Critter) => boolean;
  readonly run: (a: Critter, b: Critter, ok: Ok, dirs: Dirs) => Promise<void>;
}

interface WorkerMove extends Variant {
  readonly run: (m: Critter, w: Critter, ok: Ok, dir: Dir) => Promise<void>;
}

interface Visit extends Variant {
  readonly fit?: (a: Critter, b: Critter) => boolean;
  readonly run: (a: Critter, b: Critter, ok: Ok) => Promise<void>;
}

const sgn = (n: number, fallback: Dir): Dir => (n > 0 ? 1 : n < 0 ? -1 : fallback);

export function makeCritterSocial(api: CritterApi): CritterSocial {
  const { fx } = api;
  const { rand, pick, chance, wait, play } = fx;
  const cooldown = new Map<string, number>();
  /** Shared no-repeat memory for pair moves, worker moves and visits. */
  const memory: VariantOwner = { recent: new Map<string, string[]>() };
  /** Latest passBehind call per critter, so an older timer doesn't cut a newer one short. */
  const behindStamp = new WeakMap<Critter, number>();

  const grounded = (c: Critter): boolean => c.def.move !== "hover" && c.def.move !== "float";
  const pairKey = (a: Critter, b: Critter): string =>
    a.key < b.key ? `${a.key}:${b.key}` : `${b.key}:${a.key}`;
  const isWorking = (c: Critter): boolean => c.prio === PRIO.work;
  const running = (c: Critter): boolean => c.agent.status === "running";
  const tilt = (c: Critter, deg: number): Keyframe => ({
    transform: `translateY(0px) rotate(${deg * c.dir}deg)`,
  });
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
  const startle = (c: Critter, h = 16): Promise<void> =>
    play(
      c.body,
      [
        { transform: "none" },
        { transform: "scale(1.25, 0.7)", offset: 0.12 },
        { transform: `translateY(${-h}px) scale(0.85, 1.2)`, offset: 0.45 },
        { transform: "translateY(0) scale(1.3, 0.7)", offset: 0.82 },
        { transform: "none" },
      ],
      { duration: 600, easing: "ease-in-out" },
    );
  /** Run `fn` after `ms` on the engine's tracked timer. */
  const after = (ms: number, fn: () => void): void => {
    void wait(ms).then(fn);
  };

  function faceEach(a: Critter, b: Critter): void {
    api.face(a, b.x >= a.x ? 1 : -1);
    api.face(b, a.x > b.x ? 1 : -1);
  }
  /** Line the two up side by side, `gap` sprite-widths apart, facing each other. */
  async function lineUp(a: Critter, b: Critter, gap = 0.78): Promise<void> {
    const side = sgn(b.x - a.x, 1);
    const centre = (a.x + b.x) / 2;
    const half = (fx.size() * gap) / 2;
    faceEach(a, b);
    await Promise.all([
      api.tweenX(a, centre - side * half, 140),
      api.tweenX(b, centre + side * half, 140),
    ]);
  }
  const keepGoing = (c: Critter, dir: Dir, behind = false): void => {
    c.next = { dir, behind };
  };
  const flip = (d: Dir): Dir => (d === 1 ? -1 : 1);

  // ── Pair moves ──
  const bonk: PairMove = {
    id: "bonk",
    weight: 3,
    fit: (a, b) => grounded(a) && grounded(b),
    run: async (a, b, ok, dirs) => {
      await lineUp(a, b, 0.7);
      const knock = (c: Critter): Promise<void> =>
        play(
          c.body,
          [
            { transform: "none" },
            { transform: `scale(0.78, 1.15)`, offset: 0.15 },
            { transform: `translateY(-5px) rotate(${-12 * c.dir}deg)`, offset: 0.5 },
            { transform: "scale(1.15, 0.85)", offset: 0.85 },
            { transform: "none" },
          ],
          { duration: 440, easing: "ease-out" },
        );
      const bonkOnce = async (power: number): Promise<void> => {
        fx.stars(a, fx.frontX(a, 14), fx.size() * 0.6, 5);
        api.jolt(a, 1);
        await Promise.all([
          knock(a),
          knock(b),
          api.tweenX(a, a.x - a.dir * power, 440),
          api.tweenX(b, b.x - b.dir * power, 440),
        ]);
      };
      await bonkOnce(rand(10, 16));
      if (!ok()) return;
      fx.say(a, pick(["oof", "ow!", "hey!", "oops", "sorry!", "bonk"]), 900, true);
      if (chance(0.4)) {
        after(350, () => {
          if (ok()) fx.say(b, pick(["!", "watch it", "…", "ow"]), 800, true);
        });
      }
      if (chance(0.3)) fx.dizzy(pick([a, b]), 1100);
      await wait(700);
      if (!ok()) return;
      const ending = rand(0, 1);
      if (ending < 0.2) {
        // Stubborn: they go again, harder, then both give up.
        await lineUp(a, b, 0.7);
        await bonkOnce(rand(16, 22));
        fx.say(b, "BONK", 700, true);
        await wait(500);
        keepGoing(a, flip(dirs.a));
        keepGoing(b, flip(dirs.b));
      } else if (ending < 0.55) {
        keepGoing(a, flip(dirs.a));
        keepGoing(b, flip(dirs.b));
      } else {
        keepGoing(a, dirs.a, true);
        keepGoing(b, dirs.b);
      }
    },
  };

  const PAIR_MOVES: readonly PairMove[] = [
    bonk,
    {
      id: "leapfrog",
      weight: (a, b) => (a.def.move === "hop" || b.def.move === "hop" ? 5 : 2),
      fit: (a, b) => grounded(a) && grounded(b),
      run: async (a, b, ok, dirs) => {
        let j = a;
        let s = b;
        if (b.def.move === "hop" && a.def.move !== "hop") [j, s] = [b, a];
        const dir = sgn(s.x - j.x, j.dir);
        api.face(j, dir);
        const land = api.clampX(s.x + dir * fx.size() * 1.05);
        if (Math.abs(land - s.x) < fx.size() * 0.8) {
          // Against the wall: no room to land, so it's a bonk after all.
          return bonk.run(a, b, ok, dirs);
        }
        if (chance(0.5)) fx.say(s, pick(["!", "hey", "whoa"]), 700, true);
        await Promise.all([
          play(
            s.body,
            [
              { transform: "none" },
              { transform: "scale(1.15, 0.72)", offset: 0.3 },
              { transform: "scale(1.15, 0.72)", offset: 0.7 },
              { transform: "none" },
            ],
            { duration: 620 },
          ),
          api.tweenX(j, land, 580),
          play(
            j.body,
            [
              { transform: "none" },
              { transform: "scale(1.15, 0.8)", offset: 0.12 },
              { transform: `translateY(-20px) rotate(${10 * dir}deg)`, offset: 0.5 },
              { transform: "translateY(0) scale(1.15, 0.85)", offset: 0.88 },
              { transform: "none" },
            ],
            { duration: 580, easing: "ease-in-out" },
          ),
        ]);
        fx.puffs(j, 3, fx.mid(), 0);
        if (chance(0.5)) fx.say(j, pick(["hup!", "wheee", "pardon me"]), 800, true);
        keepGoing(j, dir);
        keepGoing(s, j === a ? dirs.b : dirs.a);
      },
    },
    {
      id: "greet",
      weight: 2.5,
      fit: () => true,
      run: async (a, b, ok, dirs) => {
        await lineUp(a, b);
        const [first, second] = pick([
          ["hi!", "hey!"],
          ["o/", "\\o"],
          ["sup", "yo"],
          ["♪", "♪♪"],
          ["?", "!"],
          ["gm", "gm"],
          ["nice hat", "thx!"],
          ["after you", "no, after you"],
          ["busy?", "always"],
        ] as const);
        void hop(a, 4);
        fx.say(a, first, 1000, true);
        await wait(650);
        if (!ok()) return;
        void hop(b, 4);
        fx.say(b, second, 1000, true);
        await wait(800);
        keepGoing(a, dirs.a, true);
        keepGoing(b, dirs.b);
      },
    },
    {
      id: "highfive",
      // CritterDef has no role; same gait stands in for "same kind of critter".
      weight: (a, b) => (a.def.move === b.def.move ? 4 : 1.5),
      fit: (a, b) => grounded(a) && grounded(b),
      run: async (a, b, ok, dirs) => {
        await lineUp(a, b, 0.7);
        const jump = (c: Critter): Promise<void> =>
          play(
            c.body,
            [
              { transform: "none" },
              { transform: "scale(1.15, 0.85)", offset: 0.15 },
              { transform: `translateY(-14px) rotate(${8 * c.dir}deg)`, offset: 0.5 },
              { transform: "scale(1.1, 0.9)", offset: 0.88 },
              { transform: "none" },
            ],
            { duration: 560, easing: "ease-in-out" },
          );
        after(280, () => {
          if (!ok()) return;
          fx.stars(a, fx.frontX(a, 15), fx.size() * 1.2, 7, "#ffffff");
          fx.say(a, pick(["gg!", "team!", "nice!", "up top!"]), 900, true);
        });
        await Promise.all([jump(a), jump(b)]);
        await wait(300);
        keepGoing(a, dirs.a, true);
        keepGoing(b, dirs.b);
      },
    },
    {
      id: "tumble",
      weight: 1,
      fit: (a, b) => grounded(a) && grounded(b),
      run: async (a, b, ok, dirs) => {
        await lineUp(a, b, 0.7);
        await api.tweenX(a, a.x + a.dir * 4, 110);
        const away = -b.dir;
        await Promise.all([
          api.tweenX(b, b.x + away * 30, 700),
          play(
            b.body,
            [
              { transform: "none" },
              { transform: `translateY(-8px) rotate(${180 * away}deg)`, offset: 0.45 },
              { transform: `rotate(${360 * away}deg)` },
            ],
            { duration: 700, easing: "ease-out" },
          ),
        ]);
        if (!ok()) return;
        fx.puffs(b, 4, fx.mid(), 0);
        fx.dizzy(b, 1300);
        fx.say(b, pick(["whoa", "@_@", "wheee…", "ow ow"]), 1000, true);
        fx.sweat(a);
        after(400, () => {
          if (ok()) fx.say(a, pick(["oops! sorry!", "my bad", "eek"]), 900, true);
        });
        await wait(1300);
        keepGoing(a, dirs.a, true);
        keepGoing(b, dirs.b);
      },
    },
    {
      id: "pinch",
      weight: 4,
      fit: (a, b) => (a.def.id === "crab") !== (b.def.id === "crab") && grounded(a) && grounded(b),
      run: async (a, b, ok) => {
        const crab = a.def.id === "crab" ? a : b;
        const other = crab === a ? b : a;
        await lineUp(a, b, 0.75);
        for (let i = 0; i < 2; i++) {
          await play(
            crab.body,
            [{ transform: "none" }, { transform: "translateY(-2px)" }, { transform: "none" }],
            { duration: 160 },
          );
        }
        if (!ok()) return;
        fx.stars(crab, fx.frontX(crab, 14), fx.size() * 0.4, 3);
        fx.say(other, pick(["OW!", "yowch!", "hey!!"]), 900, true);
        await startle(other, 18);
        if (chance(0.6)) fx.say(crab, pick(["snip snip", "♪", "hehe"]), 900, true);
        other.next = { flee: 0.7, dir: flip(other.dir) };
        crab.next = { dir: crab.dir };
      },
    },
    {
      id: "trampoline",
      weight: 4,
      fit: (a, b) =>
        (a.def.id === "slime") !== (b.def.id === "slime") && grounded(a) && grounded(b),
      run: async (a, b, ok) => {
        const slime = a.def.id === "slime" ? a : b;
        const j = slime === a ? b : a;
        const dir = sgn(slime.x - j.x, j.dir);
        api.face(j, dir);
        const land = api.clampX(slime.x + dir * fx.size() * 1.2);
        await Promise.all([
          api.tweenX(j, slime.x, 320),
          play(
            j.body,
            [
              { transform: "none" },
              { transform: "translateY(-14px)", offset: 0.5 },
              { transform: "translateY(-8px)" },
            ],
            { duration: 320, fill: "forwards" },
          ),
        ]);
        if (!ok()) return;
        fx.say(slime, pick(["boing!", "sproing", "bwomp"]), 900, true);
        await Promise.all([
          play(
            slime.body,
            [
              { transform: "none" },
              { transform: "scale(1.4, 0.5)" },
              { transform: "scale(0.85, 1.2)" },
              { transform: "none" },
            ],
            { duration: 500 },
          ),
          play(
            j.body,
            [{ transform: "translateY(-8px)" }, { transform: "translateY(-4px) scale(1.2, 0.8)" }],
            { duration: 200, fill: "forwards" },
          ),
        ]);
        await Promise.all([
          api.tweenX(j, land, 620),
          play(
            j.body,
            [
              { transform: "translateY(-4px) scale(1.2, 0.8)" },
              { transform: `translateY(-34px) rotate(${180 * dir}deg)`, offset: 0.5 },
              { transform: `translateY(0) rotate(${360 * dir}deg) scale(1.2, 0.8)`, offset: 0.9 },
              { transform: `rotate(${360 * dir}deg)` },
            ],
            { duration: 620, easing: "ease-in-out" },
          ),
        ]);
        fx.puffs(j, 3, fx.mid(), 0);
        if (chance(0.6)) fx.say(j, pick(["wheee!", "again!", "woah"]), 900, true);
        j.next = { dir };
        slime.next = { dir: slime.dir };
      },
    },
    {
      id: "roar",
      weight: 3,
      fit: (a, b) => (a.def.id === "dino") !== (b.def.id === "dino") && grounded(a) && grounded(b),
      run: async (a, b, ok) => {
        const dino = a.def.id === "dino" ? a : b;
        const other = dino === a ? b : a;
        await lineUp(a, b, 0.85);
        await play(
          dino.body,
          [{ transform: "none" }, { transform: `rotate(${-10 * dino.dir}deg) scale(0.95, 1.1)` }],
          { duration: 260, fill: "forwards" },
        );
        fx.say(dino, "RAWR", 900, true);
        const shake: Keyframe[] = [];
        for (let i = 0; i < 8; i++) shake.push({ transform: `translateX(${i % 2 ? 1 : -1}px)` });
        shake.push({ transform: "none" });
        await play(dino.body, shake, { duration: 420 });
        if (!ok()) return;
        const r = rand(0, 1);
        if (r < 0.45) {
          fx.say(other, pick(["eek!", "nope", "!!"]), 800, true);
          await startle(other);
          other.next = { flee: 0.8, dir: flip(other.dir) };
          dino.next = { dir: dino.dir };
        } else if (r < 0.75) {
          fx.say(other, "rawr!", 800, true);
          await hop(other, 5);
          fx.setBadge(dino, "yikes", "!");
          await startle(dino, 10);
          fx.setBadge(dino, null);
          dino.next = { dir: flip(dino.dir) };
          other.next = { dir: other.dir };
        } else {
          fx.say(other, "…", 1000, true);
          await wait(600);
          await play(
            dino.body,
            [{ transform: "none" }, { transform: "scale(1.05, 0.88)" }, { transform: "none" }],
            { duration: 700 },
          );
          fx.say(dino, "(tiny rawr)", 900, true);
          await wait(500);
          dino.next = { dir: flip(dino.dir) };
          other.next = { dir: other.dir };
        }
      },
    },
    {
      id: "boo",
      weight: 2.5,
      fit: (a, b) =>
        (a.def.move === "float") !== (b.def.move === "float") && (grounded(a) || grounded(b)),
      run: async (a, b, ok) => {
        const ghost = a.def.move === "float" ? a : b;
        const other = ghost === a ? b : a;
        const fade = ghost.react.animate([{ opacity: 1 }, { opacity: 0.12 }], {
          duration: 350,
          fill: "forwards",
        });
        const side = sgn(ghost.x - other.x, 1);
        await api.tweenX(ghost, other.x + side * fx.size() * 0.55, 450);
        faceEach(ghost, other);
        fade.cancel();
        fx.say(ghost, "BOO!", 900, true);
        void play(
          ghost.body,
          [{ transform: "none" }, { transform: "scale(1.4)" }, { transform: "none" }],
          { duration: 400 },
        );
        if (!ok()) return;
        const reaction = pick(["jump", "faint", "flee", "shiver"] as const);
        if (reaction === "jump") {
          fx.setBadge(other, "yikes", "!");
          await startle(other, 22);
        } else if (reaction === "faint") {
          fx.say(other, pick(["x_x", "*faints*"]), 1000, true);
          const down = `rotate(${-90 * other.dir}deg) translateX(4px)`;
          await play(other.body, [{ transform: "none" }, { transform: down }], {
            duration: 260,
            fill: "forwards",
          });
          await wait(900);
          await play(other.body, [{ transform: down }, { transform: "none" }], { duration: 300 });
        } else if (reaction === "shiver") {
          const frames: Keyframe[] = [];
          for (let i = 0; i <= 12; i++) {
            frames.push({ transform: `translateX(${i % 2 ? 1.5 : -1.5}px) scale(0.96, 0.94)` });
          }
          frames.push({ transform: "none" });
          other.sil.animate([{ opacity: 0 }, { opacity: 0.8 }, { opacity: 0 }], { duration: 400 });
          await play(other.body, frames, { duration: 650 });
        } else {
          fx.setBadge(other, "yikes", "!!");
          fx.sweat(other);
          other.next = { flee: 0.8, dir: flip(side) };
        }
        fx.setBadge(other, null);
        if (ok()) fx.say(ghost, pick(["hehe", "heh heh", "got you"]), 900, true);
        await wait(400);
        ghost.next = { dir: side };
        other.next ??= { dir: other.dir };
      },
    },
    {
      id: "phase",
      weight: 2,
      fit: (a, b) => a.def.move === "float" || b.def.move === "float",
      run: async (a, b, ok, dirs) => {
        const ghost = a.def.move === "float" ? a : b;
        const other = ghost === a ? b : a;
        const dir = sgn(other.x - ghost.x, ghost.dir);
        api.face(ghost, dir);
        ghost.el.classList.add("phasing");
        if (chance(0.5)) {
          other.sil.animate([{ opacity: 0 }, { opacity: 0.7 }, { opacity: 0 }], { duration: 500 });
          fx.say(other, pick(["brr", "…cold", "?!"]), 800, true);
        }
        await api.tweenX(ghost, other.x + dir * fx.size() * 1.1, 900, "linear");
        ghost.el.classList.remove("phasing");
        if (!ok()) return;
        ghost.next = { dir };
        other.next = { dir: other === a ? dirs.a : dirs.b };
      },
    },
    {
      id: "buzz",
      weight: 2.5,
      fit: (a, b) =>
        (a.def.move === "hover") !== (b.def.move === "hover") && (grounded(a) || grounded(b)),
      run: async (a, b, ok) => {
        const bee = a.def.move === "hover" ? a : b;
        const other = bee === a ? b : a;
        await api.tweenX(bee, other.x, 260);
        const r = 11;
        const frames: Keyframe[] = [];
        for (let i = 0; i <= 16; i++) {
          const t = (i / 16) * Math.PI * 4;
          frames.push({ transform: `translate(${Math.sin(t) * r}px, ${-9 + Math.cos(t) * 3}px)` });
        }
        const circling = play(bee.body, frames, { duration: 1500, easing: "linear" });
        for (let i = 0; i < 4 && ok(); i++) {
          api.face(other, flip(other.dir));
          await wait(340);
        }
        await circling;
        if (!ok()) return;
        fx.say(other, pick(["shoo!", "?!", "bzz?", "go away"]), 900, true);
        await play(
          other.body,
          [{ transform: "none" }, tilt(other, -14), tilt(other, 10), { transform: "none" }],
          { duration: 360 },
        );
        bee.next = { dir: pick([-1, 1] as const) };
        other.next = { dir: other.dir };
      },
    },
  ];

  // ── Running into someone who's busy ──
  const WORKER_MOVES: readonly WorkerMove[] = [
    {
      id: "peek",
      w: 3,
      run: async (m, w, ok, dir) => {
        api.face(m, sgn(w.x - m.x, m.dir));
        await fx.flashBadge(m, "yikes", "?", 700);
        if (!ok()) return;
        fx.say(m, pick(["ooh", "neat", "what's that?", "nice", "hm!"]), 900, true);
        if (chance(0.45)) {
          after(600, () => fx.say(w, pick(["shh", "busy!", "♪", "thanks"]), 800, true));
        }
        await wait(1100);
        keepGoing(m, dir, true);
      },
    },
    {
      id: "jostle",
      w: 2,
      run: async (m, w, ok, dir) => {
        api.jolt(w, 2, m.dir);
        for (const p of w.react.querySelectorAll(".critter-prop")) {
          p.animate(
            [
              { rotate: "0deg" },
              { rotate: `${20 * m.dir}deg` },
              { rotate: `${-12 * m.dir}deg` },
              { rotate: "0deg" },
            ],
            { duration: 400 },
          );
        }
        fx.say(w, pick(["hey!", "careful!", "I'm working here"]), 900, true);
        fx.sweat(m);
        await play(
          m.body,
          [{ transform: "none" }, { transform: "scale(0.85, 1.1)" }, { transform: "none" }],
          { duration: 260 },
        );
        if (!ok()) return;
        fx.say(m, pick(["sorry!", "oops", "my bad"]), 800, true);
        await wait(500);
        keepGoing(m, dir, true);
      },
    },
  ];

  function passBehind(c: Critter, ms = 1700): void {
    c.el.classList.add("behind");
    const stamp = (behindStamp.get(c) ?? 0) + 1;
    behindStamp.set(c, stamp);
    after(ms, () => {
      if (behindStamp.get(c) === stamp) c.el.classList.remove("behind");
    });
  }

  const approaching = (c: Critter, o: Critter): boolean =>
    c.mode === "walk" && c.prio === PRIO.free && (o.x - c.x) * c.dir >= 0;

  /** Called every frame: find critters whose paths just crossed. */
  function scan(now: number): void {
    const size = fx.size();
    const list = api
      .live()
      .filter((c) => !c.leaving && running(c) && !c.el.classList.contains("summoning"))
      .sort((p, q) => p.x - q.x);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b || b.x - a.x >= size * 0.7) break;
        const aIn = approaching(a, b);
        const bIn = approaching(b, a);
        if (!aIn && !bIn) continue;
        const key = pairKey(a, b);
        if ((cooldown.get(key) ?? 0) > now) continue;
        cooldown.set(key, now + rand(6000, 10000));
        encounter(aIn ? a : b, aIn ? b : a);
      }
    }
  }

  function encounter(m: Critter, o: Critter): void {
    m.seek = null;
    const L = api.lively(m);
    const dir = m.dir;
    if (isWorking(o)) {
      if (rand(0, 1) > L.bump * 0.8) return passBehind(m);
      const move = api.pickVariant(memory, "worker", WORKER_MOVES);
      void api.perform(m, PRIO.social, (ok) => move.run(m, o, ok, dir));
      return;
    }
    if (!api.isFree(o) || !running(o) || !running(m)) return passBehind(m);
    if (rand(0, 1) > L.bump) {
      if (grounded(m) && grounded(o)) passBehind(m);
      return;
    }
    meet(m, o);
  }

  function meet(a: Critter, b: Critter): boolean {
    const fits = PAIR_MOVES.filter((mv) => mv.fit(a, b));
    if (!fits.length) return false;
    const move = api.pickVariant(memory, "pair", fits, (mv) =>
      typeof mv.weight === "function" ? mv.weight(a, b) : mv.weight,
    );
    const dirs: Dirs = { a: a.dir, b: b.dir };
    void api.performPair(a, b, PRIO.social, (ok) => move.run(a, b, ok, dirs));
    return true;
  }

  // ── Going looking for company ──
  const VISITS: readonly Visit[] = [
    {
      id: "chat",
      w: 3,
      run: async (a, b, ok) => {
        faceEach(a, b);
        const convo = pick([
          ["found a bug", "ew", "squashed it"],
          ["coffee?", "always", "♪"],
          ["how's it going?", "busy!", "same"],
          ["did you read that file?", "yeah", "wild"],
          ["tabs or spaces?", "…", "never mind"],
          ["nice work earlier", "thx!", "o/"],
          ["is it lunch yet", "no", "aw"],
        ]);
        for (let i = 0; i < convo.length && ok(); i++) {
          const who = i % 2 ? b : a;
          void hop(who, 3, 260);
          fx.say(who, convo[i] ?? "", 1000, true);
          await wait(rand(850, 1100));
        }
      },
    },
    {
      id: "show",
      w: 1.2,
      run: async (a, b, ok) => {
        faceEach(a, b);
        // The find is held up over both heads; no speech, the prop carries it.
        const thing = fx.prop(a, pick(["gem", "bulb", "book"] as const), { at: { x: 11, y: 16 } });
        await hop(a, 4);
        await wait(700);
        if (!ok()) {
          await thing.put();
          return;
        }
        fx.setBadge(b, "yikes", "!");
        await hop(b, 6);
        await wait(500);
        fx.setBadge(b, null);
        await thing.put();
      },
    },
    {
      id: "hug",
      w: 0.8,
      fit: (a, b) => grounded(a) && grounded(b),
      run: async (a, b) => {
        await lineUp(a, b, 0.55);
        fx.hearts(a, 3);
        await Promise.all([
          play(
            a.body,
            [
              { transform: "none" },
              { transform: `scale(1.1, 0.92) translateX(${2 * a.dir}px)` },
              { transform: "none" },
            ],
            { duration: 900 },
          ),
          play(
            b.body,
            [
              { transform: "none" },
              { transform: `scale(1.1, 0.92) translateX(${2 * b.dir}px)` },
              { transform: "none" },
            ],
            { duration: 900 },
          ),
        ]);
      },
    },
  ];

  function seek(c: Critter): boolean {
    const friends = api
      .live()
      .filter(
        (o) =>
          o !== c &&
          api.isFree(o) &&
          running(o) &&
          Math.abs(o.x - c.x) < 200 &&
          Math.abs(o.x - c.x) > fx.size(),
      );
    if (!friends.length) return false;
    const f = pick(friends);
    const both = grounded(c) && grounded(f);
    const plan = api.pickVariant(c, "seek", [
      { id: "visit", w: 3 },
      { id: "tag", w: both ? 1.5 : 0 },
    ]);
    const dir = sgn(f.x - c.x, 1);
    if (plan.id === "tag") {
      void api.performPair(c, f, PRIO.social, (ok) => tag(c, f, ok));
      return true;
    }
    c.seek = f;
    c.dir = dir;
    c.target = api.clampX(f.x - dir * fx.size() * 0.9);
    c.mode = "walk";
    cooldown.set(pairKey(c, f), api.now() + 4000);
    return true;
  }

  /** A seeking critter reached its friend. */
  function arrived(c: Critter): boolean {
    const f = c.seek;
    c.seek = null;
    if (!f || f.leaving || !api.isFree(f) || !running(f) || Math.abs(f.x - c.x) > fx.size() * 1.8) {
      return false;
    }
    const fits = VISITS.filter((v) => !v.fit || v.fit(c, f));
    const visit = api.pickVariant(memory, "visit", fits);
    void api.performPair(c, f, PRIO.social, (ok) => visit.run(c, f, ok));
    return true;
  }

  async function tag(c: Critter, f: Critter, ok: Ok): Promise<void> {
    faceEach(c, f);
    c.legs = 70;
    fx.say(c, pick(["tag!", "you're it!", "gotcha!"]), 900, true);
    await api.goTo(c, f.x - c.dir * fx.size() * 0.7, 2.4);
    if (!ok()) return;
    fx.stars(c, fx.frontX(c, 14), fx.size() * 0.6, 4);
    await hop(f, 8);
    if (!ok()) return;
    fx.say(f, pick(["hey!", "no fair!", "I'll get you!"]), 800, true);
    api.face(c, flip(c.dir));
    api.face(f, c.dir);
    c.legs = 55;
    f.legs = 55;
    await Promise.all([
      api.goTo(c, c.x + c.dir * rand(50, 80), 2.6),
      api.goTo(f, f.x + f.dir * rand(40, 60), 2.3),
    ]);
    c.legs = 0;
    f.legs = 0;
    if (!ok()) return;
    fx.say(pick([c, f]), pick(["haha", "♪", "ok ok", "phew"]), 900, true);
    await wait(300);
  }

  // ── Reacting to team events ──
  const CHEERS: readonly ((c: Critter) => Promise<void>)[] = [
    async (c) => {
      fx.confetti(c, 10);
      fx.say(c, pick(["gg!", "yay!", "nice!", "go team", "o/"]), 1000, true);
      await hop(c, 8);
      await hop(c, 6);
    },
    async (c) => {
      fx.say(c, pick(["👏", "clap clap", "bravo"]), 1000, true);
      const frames: Keyframe[] = [];
      for (let i = 0; i < 8; i++) {
        frames.push({ transform: i % 2 ? "translateY(-2px) scale(1.05, 0.95)" : "none" });
      }
      frames.push({ transform: "none" });
      await play(c.body, frames, { duration: 900 });
    },
    async (c) => {
      fx.say(c, pick(["bye!", "see ya!", "later!"]), 1000, true);
      await play(
        c.body,
        [{ transform: "none" }, tilt(c, -10), tilt(c, 8), tilt(c, -8), { transform: "none" }],
        { duration: 800 },
      );
    },
    async (c) => {
      fx.notes(c, 3);
      await play(
        c.body,
        [
          { transform: "scaleX(1)" },
          { transform: "scaleX(0.05)", offset: 0.25 },
          { transform: "scaleX(-1)", offset: 0.5 },
          { transform: "scaleX(0.05)", offset: 0.75 },
          { transform: "scaleX(1)" },
        ],
        { duration: 600 },
      );
    },
  ];

  function cheer(done: Critter): void {
    // Only the closest few react, so a crowded floor doesn't erupt every time.
    const near = api
      .live()
      .filter((c) => c !== done && !c.leaving && running(c) && Math.abs(c.x - done.x) < 280)
      .sort((a, b) => Math.abs(a.x - done.x) - Math.abs(b.x - done.x))
      .slice(0, 5);
    near.forEach((c, i) => {
      after(i * 140 + rand(0, 220), () => {
        if (c.leaving) return;
        if (isWorking(c) || c.prio >= PRIO.event) {
          api.jolt(c, -3);
          fx.notes(c, 1);
          return;
        }
        const style = pick(CHEERS);
        void api.perform(c, PRIO.event, async () => {
          api.face(c, sgn(done.x - c.x, c.dir));
          await style(c);
        });
      });
    });
  }

  /** Nearest free teammates rush over to a fallen critter. Returns how many came. */
  function checkOn(fallen: Critter): number {
    const helpers = api
      .live()
      .filter(
        (c) =>
          c !== fallen &&
          !c.leaving &&
          running(c) &&
          !isWorking(c) &&
          c.prio < PRIO.event &&
          grounded(c) &&
          Math.abs(c.x - fallen.x) < 340,
      )
      .sort((p, q) => Math.abs(p.x - fallen.x) - Math.abs(q.x - fallen.x))
      .slice(0, 2);
    helpers.forEach((c, idx) => {
      void api.perform(c, PRIO.event, async (ok) => {
        const side: Dir = c.x < fallen.x ? -1 : 1;
        void fx.flashBadge(c, "yikes", "!", 500);
        await api.goTo(c, fallen.x + side * fx.size() * (0.9 + idx * 0.85), 1.8);
        if (!ok()) return;
        api.face(c, flip(side));
        await fx.flashBadge(c, "yikes", "?", 700);
        if (!ok()) return;
        const style = pick(["nudge", "pat", "medic"] as const);
        if (style === "nudge") {
          for (let i = 0; i < 2 && ok(); i++) {
            await play(c.body, [{ transform: "none" }, tilt(c, 16), { transform: "none" }], {
              duration: 300,
            });
          }
          fx.say(c, pick(["you ok?", "hey…", "buddy?"]), 1100, true);
        } else if (style === "pat") {
          fx.hearts(c, 2);
          fx.say(c, pick(["there there", "it happens", "♥"]), 1100, true);
          await play(
            c.body,
            [
              { transform: "none" },
              tilt(c, 8),
              { transform: "none" },
              tilt(c, 8),
              { transform: "none" },
            ],
            { duration: 900 },
          );
        } else {
          fx.say(c, pick(["medic!", "help!", "uh oh"]), 1000, true);
          await hop(c, 6);
          await hop(c, 6);
        }
        if (!ok()) return;
        await wait(500);
        await play(
          c.body,
          [
            { transform: "none" },
            { transform: "scale(1.04, 0.9)", offset: 0.3 },
            { transform: "scale(1.04, 0.9)", offset: 0.8 },
            { transform: "none" },
          ],
          { duration: 1200 },
        );
      });
    });
    return helpers.length;
  }

  return { scan, seek, arrived, cheer, checkOn, passBehind, grounded };
}
