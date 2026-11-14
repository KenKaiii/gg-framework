// The ways a critter turns up (besides the classic beam of light): set down
// by the saucer, under a parachute, out of a burrow, hatching from an egg,
// dropped by a bird, walking in from the side, or as a comet. A crowd comes
// in a handful at a time, each handful the same way. The saucer also lives
// here: there is one, working through whoever needs it.

import { discard, PX, SIZE } from "./critter-fx";
import { emote, type StageKit } from "./critter-stage-kit";
import { PRIO } from "./critter-types";
import type { ArrivalName, Critter } from "./critter-types";

export interface Saucer {
  /** Queue a critter to be set down, lifted away, or just looked over. */
  call(c: Critter, kind: "drop" | "lift" | "scan", done: () => void): void;
  out(): boolean;
}

export interface CritterArrivals {
  /** Bring a new critter in. False: the engine beams it in the classic way. */
  arrive(c: Critter, settle: () => void): boolean;
  /** Called away before it landed: stand it on the floor. True if it was still arriving. */
  cut(c: Critter): boolean;
  readonly saucer: Saucer;
}

type Staged = Exclude<ArrivalName, "beam">;

export function makeCritterArrivals(kit: StageKit): CritterArrivals {
  const { host, art: A, ALT, FAR, W, T, thing, centred, mid } = kit;
  const { api, later } = host;
  const { fx } = api;
  const { rand, chance, wait, play } = fx;

  const hide = (c: Critter): void => {
    c.react.style.transition = "none";
    c.react.style.opacity = "0";
    c.shadow.style.opacity = "0";
  };
  const reveal = (c: Critter): void => {
    c.react.style.opacity = "";
    c.shadow.style.opacity = "";
    later(60, () => (c.react.style.transition = ""));
  };
  const gone = (c: Critter): boolean => c.leaving || !c.el.isConnected;

  // ── The saucer ──
  interface Job {
    readonly c: Critter;
    readonly kind: "drop" | "lift" | "scan";
    readonly done: () => void;
  }
  const queue: Job[] = [];
  let flying = false;
  let warmed = false;

  async function fly(): Promise<void> {
    flying = true;
    if (!warmed) {
      // Load both frames up front, so the lights never blink out.
      warmed = true;
      for (const a of A.ufo) new Image().src = a.url;
    }
    const a = A.ufo[0];
    const w = a.w * PX;
    const first = queue[0];
    const fromLeft = first ? mid(first.c) < W() / 2 : chance(0.5);
    const t = thing(a, fromLeft ? -w - 12 : W() + 12, ALT + 6, { cls: "critter-ufo" });
    t.cycle(A.ufo, 150);
    const beam = fx.el("div", "critter-ufo-beam", t.node);
    beam.style.height = `${ALT + 6}px`;
    while (kit.alive()) {
      const job = queue.shift();
      if (!job) {
        await wait(420);
        if (!queue.length) break;
        continue;
      }
      const { c } = job;
      if (!c.el.isConnected || (job.kind !== "lift" && c.leaving)) {
        job.done();
        continue;
      }
      const tx = centred(a, mid(c));
      await t.move(
        tx,
        ALT,
        Math.max(320, Math.abs(tx - t.liveX()) * 1.7),
        "cubic-bezier(0.3, 0, 0.2, 1)",
      );
      await wait(100);
      beam.classList.add("on");
      const seen = new Set([c]);
      if (job.kind === "drop") {
        kit.onlookers(mid(c), "?", 130, seen);
        reveal(c);
        void c.shadow.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 500,
          delay: 500,
          fill: "backwards",
        });
        await play(
          c.body,
          [
            {
              transform: `translateY(${-(ALT - 6)}px) scale(0.2) rotate(${-240 * c.dir}deg)`,
              opacity: 0,
            },
            { opacity: 1, offset: 0.15 },
            { transform: "translateY(-8px) scale(1) rotate(0deg)", offset: 0.78 },
            { transform: "translateY(0) scale(1.22, 0.78)", offset: 0.9 },
            { transform: "none" },
          ],
          { duration: 900, easing: "ease-in" },
        );
        fx.puffs(c, 4);
      } else if (job.kind === "lift") {
        kit.onlookers(mid(c), "!", 130, seen);
        emote(c, "!");
        await wait(260);
        discard(c.el.querySelector(".critter-badge"));
        void c.shadow.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 700,
          fill: "forwards",
        });
        await play(
          c.body,
          [
            { transform: "none" },
            { transform: "translateY(-5px) scale(0.94, 1.1)", offset: 0.18 },
            {
              transform: `translateY(${-ALT * 0.5}px) rotate(${150 * c.dir}deg) scale(0.8)`,
              offset: 0.62,
            },
            {
              transform: `translateY(${-(ALT - 4)}px) rotate(${330 * c.dir}deg) scale(0.15)`,
              opacity: 0.3,
            },
          ],
          { duration: 1050, easing: "ease-in", fill: "forwards" },
        );
        void play(t.inner, [{ scale: "1 1" }, { scale: "1.12 0.86" }, { scale: "1 1" }], {
          duration: 260,
        });
      } else {
        beam.classList.add("scan");
        void api.perform(c, PRIO.event, async () => {
          kit.say(c, "Being scanned");
          void play(
            c.body,
            [{ transform: "none" }, { transform: "scale(0.94, 1.06)" }, { transform: "none" }],
            { duration: 1300 },
          );
          await kit.flashEmote(c, "?", 1300);
        });
        await wait(1300);
        beam.classList.remove("scan");
      }
      beam.classList.remove("on");
      job.done();
      await wait(160);
    }
    // Off through whichever side is nearer, a little wind-up first.
    const toLeft = t.x + w / 2 < W() / 2;
    const out = toLeft ? -w - 12 : W() + 12;
    await t.move(t.x + (toLeft ? 14 : -14), ALT + 3, 220, "ease-out");
    await t.move(
      out,
      ALT + 8,
      Math.max(380, Math.abs(out - t.x) * 0.8),
      "cubic-bezier(0.7, 0, 1, 0.5)",
    );
    t.gone();
    flying = false;
    if (queue.length && kit.alive()) void fly();
  }

  const saucer: Saucer = {
    call(c, kind, done) {
      queue.push({ c, kind, done });
      if (!flying) void fly();
    },
    out: () => flying,
  };

  // ── Which way this one comes ──
  let waveStyle: ArrivalName = "walk";
  let waveUntil = 0;
  let waveCount = 0;
  let waveStale = true;
  let lastStyle: ArrivalName | null = null;

  function styleFor(c: Critter): ArrivalName {
    const t = api.now();
    // A big crowd comes in several ways, a handful at a time.
    if (t > waveUntil || waveCount >= 5) {
      waveCount = 0;
      waveStale = true;
    }
    waveUntil = t + 1500;
    waveCount++;
    if (host.options.arrival) return host.options.arrival;
    // The alien only ever arrives by saucer.
    if (c.def.id === "alien") return "ufo";
    if (waveStale) {
      const space = kit.biome() === "space";
      waveStyle = kit.weigh<ArrivalName>(
        {
          beam: 0.8,
          ufo: space ? 3 : 1.2,
          parachute: 1.4,
          burrow: space ? 0.4 : 1.2,
          egg: 1,
          bird: space ? 0 : 0.8,
          walk: 1.5,
          comet: space ? 2 : 0.8,
        },
        lastStyle,
      );
      lastStyle = waveStyle;
      waveStale = false;
    }
    return waveStyle;
  }

  const arrivals: Readonly<Record<Staged, (c: Critter, land: () => void) => void>> = {
    ufo(c, land) {
      hide(c);
      saucer.call(c, "drop", land);
    },

    parachute(c, land) {
      const a = A.parachute;
      const chute = fx.el("img", "critter-chute", c.react);
      chute.src = a.url;
      chute.alt = "";
      Object.assign(chute.style, {
        width: `${a.w * PX}px`,
        height: `${a.h * PX}px`,
        left: `${(SIZE - a.w * PX) / 2}px`,
        bottom: `${SIZE - 10}px`,
      });
      const d = chance(0.5) ? 1 : -1;
      c.react.style.transformOrigin = "50% -30px";
      void c.shadow.animate(
        [
          { opacity: 0, transform: "scaleX(0.3)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 900, delay: 1300, fill: "backwards" },
      );
      void play(
        c.react,
        [
          {
            transform: `translate(${-14 * d}px, ${-FAR}px) rotate(${7 * d}deg) scale(0.4)`,
            opacity: 0,
          },
          { opacity: 1, offset: 0.16 },
          {
            transform: `translate(${10 * d}px, ${-FAR * 0.62}px) rotate(${-7 * d}deg) scale(0.66)`,
            offset: 0.36,
          },
          {
            transform: `translate(${-7 * d}px, ${-FAR * 0.28}px) rotate(${6 * d}deg) scale(0.9)`,
            offset: 0.68,
          },
          { transform: "none" },
        ],
        { duration: 2300 + waveCount * 60, easing: "linear" },
      ).then(() => {
        c.react.style.transformOrigin = "";
        if (gone(c)) {
          discard(chute);
          return;
        }
        void play(c.body, [{ transform: "scale(1.2, 0.8)" }, { transform: "none" }], {
          duration: 260,
        });
        void play(
          chute,
          [
            { transform: "none", opacity: 1 },
            {
              transform: `translate(${10 * d}px, 26px) rotate(${50 * d}deg) scale(1, 0.3)`,
              opacity: 0,
            },
          ],
          { duration: 520, easing: "ease-in", fill: "forwards" },
        ).then(() => discard(chute));
        land();
      });
    },

    burrow(c, land) {
      hide(c);
      const m = thing(A.mound, centred(A.mound, mid(c)), 0, { cls: "critter-clip" });
      const sink = (): Promise<void> =>
        play(m.inner, [{ transform: "none" }, { transform: "translateY(100%)" }], {
          duration: 420,
          easing: "ease-in",
          fill: "forwards",
        }).then(() => m.gone());
      void (async () => {
        await play(m.inner, [{ transform: "translateY(100%)" }, { transform: "none" }], {
          duration: 380,
          easing: "ease-out",
        });
        if (gone(c)) return void sink();
        fx.dirt(c, 6);
        c.react.style.clipPath = "inset(-120px -80px 0px -80px)";
        reveal(c);
        c.shadow.style.opacity = "0";
        const peek = `translateY(${SIZE * 0.52}px)`;
        later(420, () => {
          if (!gone(c)) void kit.flashEmote(c, "?", 520);
        });
        await play(
          c.body,
          [
            { transform: `translateY(${SIZE}px)` },
            { transform: peek, offset: 0.25 },
            { transform: peek, offset: 0.62 },
            { transform: "translateY(-12px) scale(0.94, 1.1)", offset: 0.84 },
            { transform: "scale(1.16, 0.84)", offset: 0.94 },
            { transform: "none" },
          ],
          { duration: 1500, easing: "ease-out" },
        );
        void sink();
        if (gone(c)) return;
        c.react.style.clipPath = "";
        c.shadow.style.opacity = "";
        fx.dirt(c, 4);
        land();
      })();
    },

    egg(c, land) {
      hide(c);
      const x = centred(A.egg, mid(c));
      const fromLeft = mid(c) < W() / 2;
      const x0 = fromLeft ? -A.egg.w * PX - 6 : W() + 6;
      const e = thing(A.egg, x0, 0);
      void (async () => {
        const roll = Math.abs(x - x0);
        const ms = Math.max(500, roll / 0.2);
        const rollEase = "cubic-bezier(0.2, 0.6, 0.3, 1)";
        void play(
          e.inner,
          [{ rotate: "0deg" }, { rotate: `${(fromLeft ? 1 : -1) * (roll / 82) * 360}deg` }],
          { duration: ms, easing: rollEase },
        );
        await e.move(x, 0, ms, rollEase);
        if (!gone(c)) c.shadow.style.opacity = "";
        await wait(rand(100, 350));
        for (const deg of [10, 18]) {
          await play(
            e.inner,
            [
              { rotate: "0deg" },
              { rotate: `${deg}deg` },
              { rotate: `${-deg}deg` },
              { rotate: "0deg" },
            ],
            { duration: 300, easing: "ease-in-out" },
          );
          await wait(110);
        }
        e.gone();
        const top = thing(A.eggTop, x, 0);
        const bottom = thing(A.eggBottom, x, 0);
        const d = chance(0.5) ? 1 : -1;
        void play(
          top.node,
          [
            { transform: T(x, 0) },
            { transform: `${T(x + 16 * d, 34)} rotate(${120 * d}deg)`, offset: 0.5 },
            { transform: `${T(x + 30 * d, 0)} rotate(${250 * d}deg)`, opacity: 0 },
          ],
          { duration: 620, easing: "linear", fill: "forwards" },
        ).then(() => top.gone());
        void play(bottom.node, [{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], {
          duration: 900,
          fill: "forwards",
        }).then(() => bottom.gone());
        if (gone(c)) return;
        reveal(c);
        fx.sparks(c, 8);
        await play(
          c.body,
          [
            { transform: "scale(0.3)" },
            { transform: "translateY(-8px) scale(1.12, 0.94)", offset: 0.6 },
            { transform: "none" },
          ],
          { duration: 420, easing: "ease-out" },
        );
        land();
      })();
    },

    bird(c, land) {
      hide(c);
      const b = A.bird[0];
      const fromLeft = chance(0.5);
      const alt = ALT + 22;
      const x0 = fromLeft ? -b.w * PX - 20 : W() + 20;
      const x1 = fromLeft ? W() + 40 : -b.w * PX - 40;
      const t = thing(b, x0, alt);
      t.face(fromLeft ? 1 : -1);
      t.cycle(A.bird, 140);
      const carried = fx.el("img", "critter-carried", t.node);
      carried.src = A.sack.url;
      carried.alt = "";
      Object.assign(carried.style, {
        width: `${A.sack.w * PX}px`,
        height: `${A.sack.h * PX}px`,
      });
      const speed = 0.2;
      const dropX = centred(b, mid(c));
      void t.move(x1, alt, Math.abs(x1 - x0) / speed, "linear").then(() => t.gone());
      void (async () => {
        await wait(Math.abs(dropX - x0) / speed);
        discard(carried);
        const sx = centred(A.sack, mid(c));
        const s = thing(A.sack, sx, alt - 16);
        if (!gone(c)) c.shadow.style.opacity = "";
        await s.move(sx, 0, 420, "cubic-bezier(0.5, 0, 1, 0.8)");
        await play(s.inner, [{ scale: "1.3 0.7" }, { scale: "1 1" }], { duration: 200 });
        await wait(260);
        kit.puffAt(mid(c), 6, 8, 18);
        s.gone();
        if (gone(c)) return;
        reveal(c);
        await play(
          c.body,
          [
            { transform: "scale(0.4)" },
            { transform: "scale(1.14, 0.9)", offset: 0.65 },
            { transform: "none" },
          ],
          { duration: 360, easing: "ease-out" },
        );
        land();
      })();
    },

    walk(c, land) {
      const target = c.x;
      const fromLeft = target < W() / 2;
      // A crowd walks in single file.
      const gap = (waveCount - 1) * SIZE * 0.9;
      c.x = fromLeft ? -SIZE - 8 - gap : W() + 8 + gap;
      c.dir = fromLeft ? 1 : -1;
      host.place(c);
      void host
        .tweenRaw(c, target, (Math.abs(target - c.x) / 95) * 1000, "linear", true)
        .then(land);
    },

    comet(c, land) {
      const d = chance(0.5) ? 1 : -1;
      c.shadow.style.opacity = "0";
      const trail = (): void => {
        if (gone(c) || c.mode !== "summon") return;
        fx.sparks(c, 2, false);
        later(70, trail);
      };
      later(380, trail);
      void (async () => {
        await play(
          c.body,
          [
            {
              transform: `translate(${-d * FAR * 1.5}px, ${-FAR * 1.25}px) rotate(${-d * 50}deg) scale(0.15)`,
              opacity: 0,
            },
            { opacity: 1, offset: 0.12 },
            {
              transform: `translate(${-d * FAR * 0.6}px, ${-FAR * 0.5}px) rotate(${-d * 40}deg) scale(0.6)`,
              offset: 0.55,
            },
            { transform: "translate(0, 0) rotate(0deg) scale(1.35, 0.6)", offset: 0.86 },
            { transform: "translateY(-6px) scale(0.92, 1.1)", offset: 0.94 },
            { transform: "none" },
          ],
          { duration: 980, easing: "cubic-bezier(0.5, 0, 0.9, 0.7)" },
        );
        if (gone(c)) return;
        c.shadow.style.opacity = "";
        kit.shake(3);
        kit.puffAt(mid(c), 2, 10, 26);
        for (const o of api.live()) {
          if (o !== c && Math.abs(o.x - c.x) < SIZE * 2.6) api.jolt(o, 1.6, o.x > c.x ? 1 : -1);
        }
        fx.dizzy(c, 1000);
        await wait(650);
        land();
      })();
    },
  };

  function arrive(c: Critter, settle: () => void): boolean {
    if (host.reduced) return false;
    const style = styleFor(c);
    if (style === "beam") return false;
    const land = (): void => {
      if (c.el.isConnected && kit.alive()) settle();
    };
    // A bird carries one bundle: the rest of a crowd drift down after it.
    arrivals[style === "bird" && waveCount > 1 ? "parachute" : style](c, land);
    return true;
  }

  function cut(c: Critter): boolean {
    if (!c.el.classList.contains("summoning")) return false;
    c.react.style.opacity = "";
    c.react.style.transition = "";
    c.react.style.clipPath = "";
    c.react.style.transformOrigin = "";
    c.shadow.style.opacity = "";
    c.x = api.clampX(c.x);
    host.place(c);
    return true;
  }

  return { arrive, cut, saucer };
}
