// Work actions: what a critter acts out while its agent runs a tool.
// Every tool kind has several variants. A critter never repeats the variant it
// just did, and some species have their own spin on a kind.
//
// Work loops run until job.endAt (re-read every pass: the engine stretches it
// while the same tool keeps firing and pulls it in when a different one
// arrives), then mark the job `winding` and play their outro.

import { discard } from "./critter-fx";
import type { CritterApi, Critter, Job, JobKind, Ok, Variant } from "./critter-types";

export interface CritterWork {
  run(c: Critter, job: Job, ok: Ok): Promise<void>;
}

interface WorkVariant extends Variant {
  readonly run: (c: Critter, job: Job, ok: Ok) => Promise<void>;
}

const CODE = ["{", "}", ";", "<>", "=>", "()", "//", "+=", "0", "1", "[]"];
/** A "run" job longer than this gets a worried mutter. */
const LONG_RUN_MS = 5000;
const MIN_PASS_MS = 80;

export function makeCritterWork(api: CritterApi): CritterWork {
  const { fx } = api;
  const { rand, pick, chance, wait, play, prop, layer } = fx;

  /** Repeat `step` until the job's (moving) end, minus `lead` ms for the outro.
   *  Each pass takes at least MIN_PASS_MS: a step that resolves instantly (an
   *  animation on a node that is already gone) must not spin the loop hot. */
  async function loop(job: Job, ok: Ok, step: () => Promise<void>, lead = 0): Promise<void> {
    while (ok() && api.now() < job.endAt - lead) {
      const t0 = api.now();
      await step();
      const spent = api.now() - t0;
      if (spent < MIN_PASS_MS) await wait(MIN_PASS_MS - spent);
    }
    job.winding = true;
  }
  const bob = (c: Critter, dy: number, ms: number): Animation =>
    c.body.animate(
      [{ transform: "none" }, { transform: `translateY(${dy}px)` }, { transform: "none" }],
      { duration: ms, iterations: Infinity, easing: "ease-in-out" },
    );
  const tilt = (c: Critter, deg: number, dy = 0): Keyframe => ({
    transform: `translateY(${dy}px) rotate(${deg * c.dir}deg)`,
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
  const lean = (c: Critter, deg: number, dy = 0, ms = 260): Promise<void> =>
    play(c.body, [{ transform: "none" }, tilt(c, deg, dy)], {
      duration: ms,
      fill: "forwards",
      easing: "ease-out",
    });
  const unlean = (c: Critter, deg: number, dy = 0, ms = 220): Promise<void> =>
    play(c.body, [tilt(c, deg, dy), { transform: "none" }], {
      duration: ms,
      easing: "ease-in-out",
    });
  const flip = (c: Critter): void => api.face(c, c.dir > 0 ? -1 : 1);

  /** Walk a little way along the floor without leaving it. */
  async function stroll(c: Critter, dist: number, speed: number): Promise<void> {
    let target = api.clampX(c.x + c.dir * dist);
    if (Math.abs(target - c.x) < dist * 0.5) {
      flip(c);
      target = api.clampX(c.x + c.dir * dist);
    }
    await api.goTo(c, target, speed);
  }

  // ── READ ──
  const READ: readonly WorkVariant[] = [
    {
      id: "book",
      run: async (c, job, ok) => {
        const book = prop(c, c.def.id === "wizard" ? "spellbook" : "book", {
          at: "hand",
          flicker: rand(380, 560),
        });
        await loop(job, ok, async () => {
          await play(c.body, [{ transform: "none" }, tilt(c, 3, 1), { transform: "none" }], {
            duration: rand(700, 1000),
            easing: "ease-in-out",
          });
          if (c.def.id === "wizard" && chance(0.5)) fx.stars(c, fx.frontX(c), 8, 2, "#b07cff");
        });
        book.setFrame(0);
        await book.put();
      },
    },
    {
      id: "scroll",
      run: async (c, job, ok) => {
        const scroll = prop(c, "scroll", { at: "up", origin: "50% 0%", pop: false });
        await play(scroll.node, [{ transform: "scaleY(0.15)" }, { transform: "none" }], {
          duration: 380,
          easing: "cubic-bezier(0.3, 1.4, 0.6, 1)",
        });
        await lean(c, -5);
        await loop(
          job,
          ok,
          () =>
            play(
              scroll.node,
              [{ transform: "none" }, { transform: "translateY(-1px)" }, { transform: "none" }],
              { duration: 900 },
            ),
          700,
        );
        if (!ok()) return;
        await unlean(c, -5);
        await play(scroll.node, [{ transform: "none" }, { transform: "scaleY(0.1)" }], {
          duration: 220,
          fill: "forwards",
        });
      },
    },
    {
      id: "pace-read",
      run: async (c, job, ok) => {
        let book = prop(c, "book", { at: "hand", flicker: 450 });
        await loop(job, ok, async () => {
          await stroll(c, rand(24, 44), 0.4);
          if (!ok()) return;
          await wait(rand(300, 600));
          if (!ok()) return;
          flip(c);
          discard(book.node);
          book = prop(c, "book", { at: "hand", flicker: 450, pop: false });
        });
        await book.put();
      },
    },
    {
      id: "sit-read",
      run: async (c, job, ok) => {
        c.el.classList.add("sitting");
        const book = prop(c, "book", { at: "ground", dx: -1, flicker: 620 });
        if (chance(0.4)) fx.say(c, pick(["hm.", "huh", "ooh"]), 900);
        await loop(job, ok, () => wait(250));
        // Stand back up even when interrupted: nothing else clears "sitting".
        if (!ok()) {
          c.el.classList.remove("sitting");
          return;
        }
        await book.put();
        c.el.classList.remove("sitting");
        await hop(c, 4);
      },
    },
    {
      id: "scan",
      only: (c) => c.def.id === "robot",
      w: 4,
      run: async (c, job, ok) => {
        const page = prop(c, "paper", { at: "ground", dx: 2 });
        const beam = layer(c, c.dir < 0 ? "critter-scan left" : "critter-scan");
        fx.say(c, "beep", 700, true);
        await loop(job, ok, () => wait(200));
        if (!ok()) return;
        discard(beam);
        fx.say(c, "boop", 700, true);
        await page.put();
      },
    },
  ];

  // ── SEARCH ──
  const SEARCH: readonly WorkVariant[] = [
    {
      id: "magnifier",
      run: async (c, job, ok) => {
        const at = { x: 12, y: 0 };
        let glass = prop(c, "magnifier", { at, origin: "30% 30%" });
        const wob = (): void => {
          glass.node.animate(
            [
              { transform: "rotate(-12deg)" },
              { transform: "rotate(12deg)" },
              { transform: "rotate(-12deg)" },
            ],
            { duration: 700, iterations: Infinity },
          );
        };
        wob();
        await loop(
          job,
          ok,
          async () => {
            await stroll(c, rand(18, 34), 0.35);
            if (!ok()) return;
            if (chance(0.4)) await fx.flashBadge(c, "yikes", "?", 500);
            else await wait(rand(200, 500));
            if (ok() && chance(0.35)) {
              flip(c);
              discard(glass.node);
              glass = prop(c, "magnifier", { at, origin: "30% 30%", pop: false });
              wob();
            }
          },
          500,
        );
        if (!ok()) return;
        fx.setBadge(c, "yikes", "!");
        await hop(c, 7);
        await glass.put();
      },
    },
    {
      id: "dig",
      run: async (c, job, ok) => {
        const shovel = prop(c, "shovel", { at: { x: 14, y: 0 }, origin: "50% 100%" });
        await loop(
          job,
          ok,
          async () => {
            await Promise.all([
              play(c.body, [{ transform: "none" }, tilt(c, 12, 1), { transform: "none" }], {
                duration: 420,
              }),
              play(
                shovel.node,
                [
                  { transform: "none" },
                  { transform: `rotate(${-35 * c.dir}deg)` },
                  { transform: "none" },
                ],
                { duration: 420 },
              ),
            ]);
            fx.dirt(c, 4);
            await wait(rand(80, 220));
          },
          600,
        );
        await shovel.put();
        if (!ok()) return;
        // The find pops up beside the head, big enough to read as a gem at real size.
        const gem = prop(c, "gem", { at: "up" });
        fx.stars(c, fx.frontX(c, 11), 20, 3, "#8fdcff");
        fx.setBadge(c, "yikes", "!");
        await hop(c, 8);
        await wait(700);
        await gem.put();
      },
    },
    {
      id: "binoculars",
      run: async (c, job, ok) => {
        // Front-on binoculars over the eyes: two round lenses read at real size.
        const at = { x: "center" as const, y: 7 };
        let bino = prop(c, "binoculars", { at });
        await loop(job, ok, async () => {
          await wait(rand(700, 1200));
          if (!ok() || api.now() >= job.endAt) return;
          flip(c);
          discard(bino.node);
          bino = prop(c, "binoculars", { at, pop: false });
        });
        if (!ok()) return;
        fx.setBadge(c, "yikes", "!");
        await hop(c, 6);
        await bino.put();
      },
    },
    {
      id: "crystal",
      only: (c) => c.def.id === "wizard",
      w: 4,
      run: async (c, job, ok) => {
        // Held up beside the head; cyan glass so it stands out from the purple robe.
        const ball = prop(c, "crystal", { at: { x: 14, y: 8 }, flicker: 300 });
        await lean(c, 8, 1);
        await loop(job, ok, async () => {
          fx.stars(c, fx.frontX(c, 14), 28, 1, "#8fdcff");
          await wait(380);
        });
        if (!ok()) return;
        await unlean(c, 8, 1);
        await ball.put();
      },
    },
  ];

  // ── EDIT ──
  const EDIT: readonly WorkVariant[] = [
    {
      id: "hammer",
      w: (c) => (c.def.id === "builder" || c.def.id === "knight" ? 4 : 1),
      run: async (c, job, ok) => {
        const hammer = prop(c, "hammer", { at: { x: 14, y: 3 }, origin: "50% 100%" });
        await loop(
          job,
          ok,
          async () => {
            await play(
              hammer.node,
              [{ transform: "none" }, { transform: `rotate(${-70 * c.dir}deg)` }],
              { duration: 260, fill: "forwards", easing: "ease-out" },
            );
            await play(
              hammer.node,
              [
                { transform: `rotate(${-70 * c.dir}deg)` },
                { transform: `rotate(${40 * c.dir}deg)` },
              ],
              { duration: 110, fill: "forwards", easing: "ease-in" },
            );
            fx.stars(c, fx.frontX(c, 16), 1, 3);
            api.jolt(c, 1);
            await play(
              hammer.node,
              [{ transform: `rotate(${40 * c.dir}deg)` }, { transform: "none" }],
              { duration: 160 },
            );
            await wait(rand(60, 200));
          },
          500,
        );
        if (!ok()) return;
        await hammer.put();
        fx.sparks(c, 6);
        await hop(c, 5);
      },
    },
    {
      id: "typing",
      run: async (c, job, ok) => {
        const laptop = prop(c, "laptop", { at: "ground", dx: -1, flicker: 160 });
        const tap = bob(c, 1, 170);
        await loop(
          job,
          ok,
          async () => {
            fx.glyphs(c, 1, fx.frontX(c, 16), 6, CODE);
            await wait(rand(180, 340));
          },
          300,
        );
        tap.cancel();
        if (!ok()) return;
        await play(
          c.body,
          [{ transform: "none" }, { transform: "scale(1.15, 0.85)" }, { transform: "none" }],
          { duration: 200 },
        );
        fx.stars(c, fx.frontX(c, 16), 5, 3, "#5ef08a");
        await laptop.put();
      },
    },
    {
      id: "scribble",
      run: async (c, job, ok) => {
        const paper = prop(c, "paper", { at: "ground", flicker: 700 });
        await loop(
          job,
          ok,
          async () => {
            await play(c.body, [{ transform: "none" }, tilt(c, 14, 1), { transform: "none" }], {
              duration: 300,
            });
            fx.particle(c, {
              cls: "critter-pt-dot",
              color: "#3a3d4a",
              x: fx.frontX(c, 15),
              y: rand(3, 10),
              dx: c.dir * rand(2, 6),
              dur: 400,
            });
          },
          600,
        );
        await paper.put();
        if (!ok()) return;
        const shown = prop(c, "paper", { at: "up" });
        fx.sparks(c, 5);
        await hop(c, 5);
        await wait(400);
        await shown.put();
      },
    },
  ];

  // ── RUN (bash / commands) ──
  /** Once a command has dragged on, sweat and mutter about it (once). */
  function longRunWorry(c: Critter, job: Job, ok: Ok): void {
    if (c.saidLong || !ok()) return;
    if (api.now() - job.startedAt <= LONG_RUN_MS) return;
    c.saidLong = true;
    fx.sweat(c, 2);
    fx.say(c, pick(["still going…", "any minute now", "…", "come on…"]), 1400, true);
  }
  async function runEnding(c: Critter, ok: Ok): Promise<void> {
    const wasLong = c.saidLong;
    c.saidLong = false;
    if (!ok()) return;
    if (wasLong) {
      fx.say(c, pick(["phew", "finally!", "done… phew"]), 1000, true);
      await play(
        c.body,
        [{ transform: "none" }, { transform: "scale(1.2, 0.8)" }, { transform: "none" }],
        { duration: 400 },
      );
    } else if (chance(0.5)) {
      fx.setBadge(c, "yikes", "!");
      await hop(c, 5);
    }
  }
  const RUN: readonly WorkVariant[] = [
    {
      id: "terminal",
      run: async (c, job, ok) => {
        const term = prop(c, "terminal", { at: "ground", flicker: 420 });
        const tap = bob(c, 0.5, 260);
        await loop(job, ok, async () => {
          fx.glyphs(c, 1, fx.frontX(c, 17), 10, ["▪", "▪▪", "──", "ok", "▪▪▪"]);
          longRunWorry(c, job, ok);
          await wait(rand(260, 420));
        });
        tap.cancel();
        await term.put();
        await runEnding(c, ok);
      },
    },
    {
      id: "gear",
      run: async (c, job, ok) => {
        const gear = prop(c, "gear", { at: "head", flicker: 140, origin: "50% 50%" });
        gear.node.animate([{ transform: "rotate(0)" }, { transform: "rotate(360deg)" }], {
          duration: 900,
          iterations: Infinity,
        });
        const shake = c.body.animate(
          [
            { transform: "translateX(0)" },
            { transform: "translateX(0.5px)" },
            { transform: "translateX(0)" },
          ],
          { duration: 120, iterations: Infinity },
        );
        await loop(job, ok, async () => {
          fx.steam(c, fx.mid(), fx.size() + 14, 1);
          longRunWorry(c, job, ok);
          await wait(420);
        });
        shake.cancel();
        await gear.put();
        await runEnding(c, ok);
      },
    },
    {
      id: "wheel",
      run: async (c, job, ok) => {
        const wheel = layer(c, "critter-wheel", { behind: true });
        c.legs = 60;
        const running = bob(c, -1, 140);
        await loop(job, ok, async () => {
          fx.puffs(c, 1, c.dir > 0 ? 4 : fx.size() - 4, 0, -c.dir);
          longRunWorry(c, job, ok);
          await wait(260);
        });
        running.cancel();
        c.legs = 0;
        if (!ok()) return;
        for (const a of wheel.getAnimations()) a.playbackRate = 0.4;
        await wait(300);
        discard(wheel);
        if (!ok()) return;
        if (chance(0.4)) fx.dizzy(c, 1000);
        await runEnding(c, ok);
      },
    },
  ];

  // ── WEB ──
  const WEB: readonly WorkVariant[] = [
    {
      id: "antenna",
      run: async (c, job, ok) => {
        layer(c, "critter-arcs");
        await lean(c, -6);
        await loop(job, ok, () => wait(250));
        if (!ok()) return;
        await unlean(c, -6);
        fx.sparks(c, 6);
      },
    },
    {
      id: "plane",
      run: async (c, job, ok) => {
        const plane = prop(c, "plane", { at: "up" });
        await play(
          c.body,
          [{ transform: "none" }, tilt(c, -10), tilt(c, 8), { transform: "none" }],
          { duration: 300 },
        );
        const fly = rand(70, 110) * c.dir;
        await play(
          plane.node,
          [
            { transform: "none", opacity: 1 },
            {
              transform: `translate(${fly * 0.5}px, -22px) rotate(${-15 * c.dir}deg)`,
              opacity: 1,
              offset: 0.5,
            },
            { transform: `translate(${fly}px, -14px)`, opacity: 0 },
          ],
          { duration: 900, easing: "ease-out", fill: "forwards" },
        );
        discard(plane.node);
        if (!ok()) return;
        const cloud = fx.thought(c);
        await wait(400);
        await loop(job, ok, () => wait(200), 700);
        discard(cloud);
        if (!ok()) return;
        const letter = prop(c, "letter", { at: "up", pop: false });
        await play(
          letter.node,
          [
            { transform: `translate(${fly}px, -30px)`, opacity: 0 },
            { transform: `translate(${fly * 0.4}px, -26px)`, opacity: 1, offset: 0.5 },
            { transform: "none", opacity: 1 },
          ],
          { duration: 700, easing: "ease-in" },
        );
        fx.say(c, pick(["mail!", "got it", "oh nice"]), 800, true);
        await hop(c, 6);
        await letter.put();
      },
    },
    {
      id: "dish",
      run: async (c, job, ok) => {
        const dish = prop(c, "dish", { at: "ground" });
        await loop(job, ok, async () => {
          fx.particle(c, {
            cls: "critter-pt-txt critter-pt-small",
            text: "~",
            color: "#8fdcff",
            x: fx.frontX(c, 22),
            y: 26,
            dx: -c.dir * 8,
            dy: -12,
            s0: 1,
            s1: 0.6,
            dur: 700,
          });
          await play(
            dish.node,
            [
              { transform: "none" },
              { transform: `rotate(${8 * c.dir}deg)` },
              { transform: "none" },
            ],
            { duration: 600 },
          );
        });
        await dish.put();
      },
    },
  ];

  // ── THINK (no tool running for a while) ──
  const THINK: readonly WorkVariant[] = [
    {
      id: "cloud",
      run: async (c, job, ok) => {
        fx.thought(c);
        const sway = c.body.animate([tilt(c, -3), tilt(c, 3), tilt(c, -3)], {
          duration: 2200,
          iterations: Infinity,
          easing: "ease-in-out",
        });
        await loop(job, ok, () => wait(250));
        sway.cancel();
      },
    },
  ];

  const BY_KIND: Readonly<Record<JobKind, readonly WorkVariant[]>> = {
    read: READ,
    search: SEARCH,
    edit: EDIT,
    run: RUN,
    web: WEB,
    think: THINK,
  };

  /** "Aha!": a light bulb pops on when a think spell turns into action. */
  async function eureka(c: Critter, ok: Ok): Promise<void> {
    const bulb = prop(c, "bulb", { at: "head" });
    fx.stars(c, fx.mid(), fx.size() + 12, 4);
    await wait(550);
    if (ok()) await bulb.put();
  }

  async function run(c: Critter, job: Job, ok: Ok): Promise<void> {
    const variant = api.pickVariant(c, `work:${job.kind}`, BY_KIND[job.kind]);
    if (c.lastKind === "think" && job.kind !== "think") await eureka(c, ok);
    c.lastKind = job.kind;
    if (!ok()) return;
    await variant.run(c, job, ok);
  }

  return { run };
}
