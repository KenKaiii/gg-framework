// The ways a finished critter leaves (besides the classic beam of light):
// lifted by the saucer, chased off by the monster, floating away on a
// balloon, carried off by a bird, down a hole, walking out, swapped for a log
// in a puff of smoke, or blasting off. Everyone who finishes together leaves
// the same way.

import type { CritterMonster } from "./critter-monster";
import type { Saucer } from "./critter-arrivals";
import { discard, PX, SIZE } from "./critter-fx";
import { emote, type StageKit } from "./critter-stage-kit";
import type { Critter, ExitName } from "./critter-types";

export interface Leaver {
  readonly c: Critter;
  /** Its work finished (as opposed to being called back). */
  readonly finished: boolean;
  /** Take it off the floor. */
  readonly done: () => void;
  /** The engine's own goodbye and beam-out. */
  readonly classic: () => void;
}

export interface CritterExits {
  /** See a leaving critter off. False: the engine does it the classic way. */
  depart(leaver: Leaver): boolean;
}

/** Leavers within this long of each other go as one group. */
const BATCH_MS = 240;

export function makeCritterExits(
  kit: StageKit,
  saucer: Saucer,
  monster: CritterMonster,
): CritterExits {
  const { host, art: A, ALT, FAR, W, thing, centred, mid, puffAt } = kit;
  const { api, later } = host;
  const { fx } = api;
  const { rand, pick, chance, wait, play } = fx;

  let last: ExitName | null = null;
  let batch: Leaver[] = [];
  let batchTimer = 0;

  function depart(leaver: Leaver): boolean {
    if (host.reduced) return false;
    batch.push(leaver);
    if (!batchTimer) batchTimer = later(BATCH_MS, flush);
    return true;
  }

  function styleFor(group: readonly Leaver[]): ExitName {
    if (host.options.exit) return host.options.exit;
    // Called back, not finished: nothing showy.
    if (group.every((g) => !g.finished)) {
      return kit.weigh<"poof" | "hole" | "beam">({ poof: 1, hole: 1, beam: 0.6 }, null);
    }
    const space = kit.biome() === "space";
    return kit.weigh<ExitName>(
      {
        beam: 0.8,
        ufo: space ? 3 : 1.2,
        monster: monster.out() ? 0 : 1.1,
        balloon: 1.2,
        bird: space ? 0 : 0.8,
        hole: 1,
        walk: 1.4,
        poof: 0.9,
        blast: space ? 2 : 1,
      },
      last,
    );
  }

  function flush(): void {
    batchTimer = 0;
    const group = batch.filter((g) => g.c.el.isConnected);
    batch = [];
    if (!group.length) return;
    let style = styleFor(group);
    if (style === "monster" && monster.out()) style = "walk";
    last = style;
    for (const g of group) kit.say(g.c, "Heading off");
    exits[style](group);
  }

  const farewell = (c: Critter, lines: readonly string[]): void =>
    fx.say(c, pick(lines), 1100, true);
  const middle = (group: readonly Leaver[]): number =>
    group.reduce((s, g) => s + mid(g.c), 0) / group.length;

  const exits: Readonly<Record<ExitName, (group: readonly Leaver[]) => void>> = {
    beam(group) {
      for (const g of group) g.classic();
    },

    ufo(group) {
      for (const g of group) {
        farewell(g.c, ["uh oh", "take me with you", "not again!", "bye!"]);
        saucer.call(g.c, "lift", g.done);
      }
    },

    monster(group) {
      void monster.run(middle(group) > W() / 2, group, false);
    },

    balloon(group) {
      group.forEach((g, i) => {
        const { c } = g;
        const a = A.balloons[(i + Math.floor(rand(0, 5))) % A.balloons.length] ?? A.balloons[0];
        if (!a) return g.done();
        later(i * 180, () => {
          farewell(c, ["up, up!", "wheee", "bye!", "see ya!"]);
          const img = fx.el("img", "critter-balloon", c.react);
          img.src = a.url;
          img.alt = "";
          Object.assign(img.style, {
            width: `${a.w * PX}px`,
            height: `${a.h * PX}px`,
            left: `${c.dir > 0 ? SIZE - 12 : -8}px`,
            bottom: `${SIZE * 0.45}px`,
          });
          const d = chance(0.5) ? 1 : -1;
          void (async () => {
            await play(
              img,
              [
                { transform: "scale(0.1)" },
                { transform: "scale(1.15)", offset: 0.7 },
                { transform: "none" },
              ],
              { duration: 520, easing: "ease-out" },
            );
            await wait(250);
            kit.clearMarks(c);
            void c.shadow.animate([{ opacity: 1 }, { opacity: 0, transform: "scaleX(0.3)" }], {
              duration: 1200,
              fill: "forwards",
            });
            await play(
              c.react,
              [
                { transform: "none", opacity: 1 },
                {
                  transform: `translate(${8 * d}px, ${-FAR * 0.3}px) rotate(${6 * d}deg) scale(0.92)`,
                  offset: 0.3,
                },
                {
                  transform: `translate(${-10 * d}px, ${-FAR * 0.68}px) rotate(${-6 * d}deg) scale(0.68)`,
                  opacity: 1,
                  offset: 0.66,
                },
                {
                  transform: `translate(${14 * d}px, ${-FAR}px) rotate(${4 * d}deg) scale(0.4)`,
                  opacity: 0,
                },
              ],
              { duration: 3200, easing: "cubic-bezier(0.4, 0, 0.8, 0.7)", fill: "forwards" },
            );
            g.done();
          })();
        });
      });
    },

    bird(group) {
      group.forEach((g, i) => {
        const { c } = g;
        later(i * 700, () => {
          const b = A.bird[0];
          const fromLeft = mid(c) > W() / 2;
          const dir = fromLeft ? 1 : -1;
          const t = thing(b, fromLeft ? -b.w * PX - 14 : W() + 14, ALT + 12);
          t.face(dir);
          t.cycle(A.bird, 130);
          const grabX = centred(b, mid(c));
          const grabY = SIZE - 12;
          void (async () => {
            later(350, () => void kit.flashEmote(c, "!", 500));
            await t.move(
              grabX,
              grabY,
              Math.max(600, Math.abs(grabX - t.x) / 0.26),
              "cubic-bezier(0.3, 0, 0.5, 1)",
            );
            kit.clearMarks(c);
            fx.say(c, pick(["whoa!", "hey!", "wheee"]), 800, true);
            const outX = dir > 0 ? W() + 14 : -b.w * PX - 14;
            const ms = Math.max(700, Math.abs(outX - grabX) / 0.21);
            void c.shadow.animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: 400,
              fill: "forwards",
            });
            // Lifted clear of the ground, dangling; then both go the same way at the same pace.
            void play(
              c.react,
              [{ transform: "none" }, { transform: `translateY(-14px) rotate(${-12 * dir}deg)` }],
              { duration: 420, easing: "ease-out", fill: "forwards" },
            );
            c.dir = dir;
            void host.tweenRaw(c, c.x + (outX - grabX), ms, "linear", false);
            await t.move(outX, grabY + 14, ms, "linear");
            t.gone();
            g.done();
          })();
        });
      });
    },

    hole(group) {
      group.forEach((g, i) => {
        const { c } = g;
        later(i * 160, () => {
          const h = thing(A.hole, centred(A.hole, mid(c)), -4, { behind: true });
          void (async () => {
            await play(h.inner, [{ scale: "0 0" }, { scale: "1 1" }], {
              duration: 240,
              easing: "ease-out",
            });
            kit.clearMarks(c);
            emote(c, "?");
            c.legs = 70;
            await wait(620);
            c.legs = 0;
            emote(c, "!");
            await wait(260);
            discard(c.el.querySelector(".critter-badge"));
            c.react.style.clipPath = "inset(-120px -80px -1px -80px)";
            c.shadow.style.opacity = "0";
            await play(
              c.body,
              [{ transform: "none" }, { transform: `translateY(${SIZE + 8}px) scale(0.8, 1.2)` }],
              { duration: 300, easing: "cubic-bezier(0.6, 0, 1, 0.7)", fill: "forwards" },
            );
            puffAt(mid(c), 0, 5, 12);
            await play(h.inner, [{ scale: "1 1" }, { scale: "0 0" }], {
              duration: 260,
              easing: "ease-in",
              fill: "forwards",
            });
            h.gone();
            g.done();
          })();
        });
      });
    },

    walk(group) {
      const dir = middle(group) > W() / 2 ? 1 : -1;
      const line = [...group].sort((a, b) => (b.c.x - a.c.x) * dir);
      line.forEach((g, i) => {
        const { c } = g;
        later(i * 140, () => {
          farewell(c, ["Bye!", "Later!", "Off I go!", "See ya!", "Done!"]);
          void (async () => {
            await play(
              c.body,
              [
                { transform: "none" },
                { transform: `rotate(${-10 * dir}deg)` },
                { transform: `rotate(${8 * dir}deg)` },
                { transform: "none" },
              ],
              { duration: 600 },
            );
            c.dir = dir;
            const to = dir > 0 ? W() + SIZE : -SIZE * 2;
            await host.tweenRaw(c, to, Math.abs(to - c.x) / 0.15, "ease-in", true);
            g.done();
          })();
        });
      });
    },

    poof(group) {
      group.forEach((g, i) => {
        const { c } = g;
        later(i * 140, () => {
          kit.clearMarks(c);
          void (async () => {
            await play(c.body, [{ transform: "none" }, { transform: "scale(0.9, 1.12)" }], {
              duration: 260,
              fill: "forwards",
            });
            puffAt(mid(c), 8, 12, 24);
            c.react.style.transition = "none";
            c.react.style.opacity = "0";
            // A log where it stood: it was never really there.
            const l = thing(A.log, centred(A.log, mid(c)), 0);
            await wait(700);
            l.inner.style.transformOrigin = "50% 100%";
            await play(l.inner, [{ rotate: "0deg" }, { rotate: `${80 * c.dir}deg` }], {
              duration: 320,
              easing: "ease-in",
              fill: "forwards",
            });
            puffAt(mid(c) + c.dir * 14, 0, 3, 8);
            await play(l.node, [{ opacity: 1 }, { opacity: 0 }], {
              duration: 500,
              delay: 300,
              fill: "forwards",
            });
            l.gone();
            g.done();
          })();
        });
      });
    },

    blast(group) {
      group.forEach((g, i) => {
        const { c } = g;
        later(i * 200, () => {
          farewell(c, ["3… 2… 1…", "liftoff!", "to the moon"]);
          void (async () => {
            const fizz = (): void => {
              if (!c.el.isConnected) return;
              fx.sparks(c, 2, true);
              later(90, fizz);
            };
            fizz();
            const crouch = "translateY(2px) scale(1.2, 0.72)";
            await play(c.body, [{ transform: "none" }, { transform: crouch }], {
              duration: 700,
              easing: "ease-out",
              fill: "forwards",
            });
            kit.clearMarks(c);
            kit.shake(2);
            puffAt(mid(c), 0, 10, 26);
            void c.shadow.animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: 300,
              fill: "forwards",
            });
            await play(
              c.body,
              [
                { transform: crouch },
                { transform: "translateY(-22px) scale(0.8, 1.35)", offset: 0.2 },
                { transform: `translateY(${-FAR * 0.7}px) scale(0.4, 0.75)`, offset: 0.62 },
                { transform: `translateY(${-FAR}px) scale(0.06)` },
              ],
              { duration: 780, easing: "cubic-bezier(0.5, 0, 0.8, 0.6)", fill: "forwards" },
            );
            kit.twinkle(mid(c), FAR + SIZE / 2);
            await wait(200);
            g.done();
          })();
        });
      });
    },
  };

  return { depart };
}
