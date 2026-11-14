// Things that happen to the floor now and then, by themselves: the saucer
// looks someone over, a present drops in, a ball gets kicked about, a monster
// wanders through (and sometimes meets Ken), a rain cloud picks on someone, a
// conga line forms, a shooting star goes over, a game of rock paper scissors,
// a piggyback. One at a time, with a long gap between.

import type { Saucer } from "./critter-arrivals";
import { discard, PX, SIZE } from "./critter-fx";
import type { CritterLooks } from "./critter-looks";
import type { CritterMonster } from "./critter-monster";
import { emote, type StageKit, type Thing } from "./critter-stage-kit";
import { HAPPENINGS, PRIO } from "./critter-types";
import type { Critter, HappeningName } from "./critter-types";

export interface CritterHappenings {
  tick(t: number, dt: number): void;
}

interface Ball {
  readonly t: Thing;
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  readonly until: number;
  readonly cool: WeakMap<Critter, number>;
  chaseAt: number;
  /** It may cross the lane's edge for a moment while it's thrown in. */
  readonly born: number;
  readonly resolve: () => void;
}

/** A new hat from a present lasts this long. */
const GIFT_HAT_MS = 45000;

export function makeCritterHappenings(
  kit: StageKit,
  saucer: Saucer,
  monster: CritterMonster,
  looks: CritterLooks,
): CritterHappenings {
  const { host, art: A, FAR, W, thing, centred, mid, puffAt, hop } = kit;
  const { api, later } = host;
  const { fx } = api;
  const { rand, pick, chance, wait, play } = fx;
  const now = (): number => api.now();
  const { tall } = kit;
  /** How high a shooting star crosses. */
  const SKY = tall ? 170 : 96;

  const wanted = host.options.happenings;
  const auto = wanted !== false;
  const allowed: readonly HappeningName[] = Array.isArray(wanted) ? wanted : HAPPENINGS;
  let on = false;
  let nextAt = now() + (tall ? 7000 : 14000);
  const gap = (): number => (tall ? rand(9000, 17000) : rand(22000, 40000));

  let ball: Ball | null = null;
  const riders = new Map<Critter, Critter>();

  function closestPair(): [Critter, Critter] | null {
    const list = kit.free().sort((p, q) => p.x - q.x);
    let best: [Critter, Critter] | null = null;
    let bestD = Infinity;
    for (let i = 0; i + 1 < list.length; i++) {
      const p = list[i];
      const q = list[i + 1];
      if (!p || !q) continue;
      const d = q.x - p.x;
      if (d < bestD && d < 420) {
        bestD = d;
        best = chance(0.5) ? [p, q] : [q, p];
      }
    }
    return best;
  }

  // Each returns null when it can't happen right now.
  const happenings: Readonly<Record<HappeningName, () => Promise<void> | null>> = {
    "ufo-scan"() {
      const c = pick(kit.acting().length ? kit.acting() : [null]);
      if (!c || saucer.out()) return null;
      return new Promise((resolve) => saucer.call(c, "scan", resolve));
    },

    gift() {
      const x = rand(SIZE * 2, Math.max(SIZE * 2 + 1, W() - SIZE * 3));
      const g = thing(A.gift, x, FAR);
      const chute = fx.el("img", "critter-chute", g.node);
      chute.src = A.parachute.url;
      chute.alt = "";
      Object.assign(chute.style, {
        width: `${A.parachute.w * PX}px`,
        height: `${A.parachute.h * PX}px`,
        left: `${(g.w - A.parachute.w * PX) / 2}px`,
        bottom: `${g.h - 6}px`,
      });
      return (async () => {
        void play(g.inner, [{ rotate: "-7deg" }, { rotate: "7deg" }], {
          duration: 700,
          iterations: 4,
          direction: "alternate",
          easing: "ease-in-out",
        });
        const drop = g.move(x, 0, 2800, "linear");
        void play(
          g.node,
          [{ scale: "0.35", opacity: 0 }, { opacity: 1, offset: 0.15 }, { scale: "1" }],
          { duration: 2000, easing: "ease-out" },
        );
        await drop;
        void play(
          chute,
          [
            { opacity: 1, transform: "none" },
            { opacity: 0, transform: "translateY(24px) scale(1, 0.3)" },
          ],
          { duration: 420, fill: "forwards" },
        );
        const gx = x + g.w / 2;
        kit.onlookers(gx, "?", 220);
        await wait(500);
        const near = kit.free().sort((p, q) => Math.abs(mid(p) - gx) - Math.abs(mid(q) - gx))[0];
        let opened = false;
        if (near) {
          await api.perform(near, PRIO.event, async (ok) => {
            kit.say(near, "Opening a present");
            const side = mid(near) < gx ? -SIZE * 0.6 : SIZE * 0.6;
            await api.goTo(near, gx - SIZE / 2 + side, 1.5);
            if (!ok()) return;
            api.face(near, gx >= mid(near) ? 1 : -1);
            await kit.flashEmote(near, "!", 450);
            await play(g.inner, [{ rotate: "-10deg" }, { rotate: "10deg" }], {
              duration: 110,
              iterations: 6,
              direction: "alternate",
            });
            if (!ok()) return;
            opened = true;
            puffAt(gx, 6, 8, 20, "#ffe14d");
            g.gone();
            fx.confetti(near, 14);
            looks.wear(near, chance(0.5) ? "crown" : "party", GIFT_HAT_MS);
            fx.say(near, pick(["ooh!", "for me?", "a hat!", "fancy"]), 1200, true);
            await hop(near, 12, 360);
            for (const o of kit.free()) {
              if (Math.abs(o.x - near.x) < 170) {
                void api.perform(o, PRIO.idle, async () => void (await hop(o, 8, 300)));
              }
            }
            await wait(500);
          });
        }
        if (!opened) {
          await play(g.node, [{ opacity: 1 }, { opacity: 0 }], {
            duration: 600,
            delay: 2500,
            fill: "forwards",
          });
          g.gone();
        }
      })();
    },

    ball() {
      if (ball) return null;
      const fromLeft = chance(0.5);
      const x = fromLeft ? -A.ball.w * PX - 4 : W() + 4;
      const t = thing(A.ball, x, 26, { cls: "critter-ball" });
      return new Promise<void>((resolve) => {
        ball = {
          t,
          x,
          y: 26,
          vx: (fromLeft ? 1 : -1) * rand(150, 230),
          vy: rand(150, 220),
          spin: 0,
          until: now() + 15000,
          cool: new WeakMap(),
          chaseAt: 0,
          born: now(),
          resolve,
        };
      });
    },

    monster() {
      if (monster.out()) return null;
      return monster.run(chance(0.5), [], chance(0.5));
    },

    ken() {
      // He only turns up for someone: no audience, no Ken.
      if (monster.out() || !monster.kenCanCome()) return null;
      return monster.run(chance(0.5), [], false, true);
    },

    cloud() {
      const target = pick(kit.acting().length ? kit.acting() : [null]);
      if (!target) return null;
      const a = A.cloud;
      const alt = SIZE + 16;
      const fromLeft = chance(0.5);
      const cl = thing(a, fromLeft ? -a.w * PX - 10 : W() + 10, alt);
      return (async () => {
        await cl.move(centred(a, mid(target)), alt, 2200, "ease-out");
        let raining = true;
        const rain = (): void => {
          if (!raining || !cl.node.isConnected) return;
          const d = fx.el("i", "critter-rain", host.floor);
          d.style.left = `${cl.liveX() + rand(6, cl.w - 6)}px`;
          d.style.bottom = `${alt}px`;
          const an = d.animate(
            [{ transform: "translateY(0)" }, { transform: `translateY(${alt}px)` }],
            { duration: 300, easing: "linear" },
          );
          an.onfinish = an.oncancel = () => discard(d);
          later(45, rain);
        };
        rain();
        const follow = (): void => {
          if (!raining || !target.el.isConnected) return;
          void cl.move(centred(a, mid(target)), alt, 600, "linear");
          later(600, follow);
        };
        later(700, follow);
        await api.perform(target, PRIO.event, async (ok) => {
          kit.say(target, "Getting rained on");
          await kit.flashEmote(target, "?", 500);
          fx.say(target, pick(["hey!", "really?", "not on me"]), 900, true);
          for (let i = 0; i < 2 && ok(); i++) {
            emote(target, "sweat");
            const away = (chance(0.5) ? -1 : 1) * rand(120, 220);
            await api.goTo(target, api.clampX(target.x + away), 2.2);
            await wait(350);
          }
          if (!ok()) return;
          emote(target, "anger");
          await wait(500);
          // One bolt, and it's over.
          void play(cl.inner, [{ filter: "brightness(3)" }, { filter: "none" }], { duration: 260 });
          const bolt = fx.el("i", "critter-bolt", host.floor);
          bolt.style.left = `${mid(target)}px`;
          bolt.style.height = `${alt - SIZE + 8}px`;
          bolt.style.bottom = `${SIZE - 6}px`;
          later(160, () => discard(bolt));
          target.el.classList.add("sooty");
          api.jolt(target, 2);
          kit.shake(2);
          discard(target.el.querySelector(".critter-badge"));
          fx.dizzy(target, 900);
          await wait(900);
          fx.say(target, pick(["…ow", "rude", "crispy"]), 1000, true);
          await wait(400);
        });
        raining = false;
        target.el.classList.remove("sooty");
        await play(cl.node, [{ opacity: 1 }, { opacity: 0 }], { duration: 700, fill: "forwards" });
        cl.gone();
      })();
    },

    conga() {
      const all = kit.free().sort((p, q) => p.x - q.x);
      if (all.length < 3) return null;
      const startAt = Math.floor(rand(0, Math.max(1, all.length - 4)));
      const line = all.slice(startAt, startAt + 5);
      const lead = line[Math.floor(line.length / 2)];
      if (!lead) return null;
      const dir: 1 | -1 = mid(lead) < W() / 2 ? 1 : -1;
      const head = api.clampX(lead.x + dir * (line.length * SIZE * 0.45));
      const room = dir > 0 ? W() - SIZE - 8 - head : head - 8;
      const run = Math.min(280, Math.max(60, room));
      let ready = 0;
      let open: () => void = () => undefined;
      const gate = new Promise<void>((r) => (open = r));
      const order = dir > 0 ? [...line].reverse() : line;
      return Promise.all(
        order.map((c, i) =>
          api.perform(c, PRIO.event, async (ok) => {
            kit.say(c, i === 0 ? "Leading the conga" : "In the conga line");
            await api.goTo(c, head - dir * i * SIZE * 0.92, 1.7);
            api.face(c, dir);
            if (++ready === order.length) open();
            await Promise.race([gate, wait(4500)]);
            if (!ok()) return;
            fx.notes(c, 2);
            const bob = c.body.animate(
              [
                { transform: "none" },
                { transform: `translateY(-5px) rotate(${6 * dir}deg)` },
                { transform: "none" },
              ],
              { duration: 420, iterations: Infinity, delay: i * 105 },
            );
            const tune = (): void => {
              if (!ok() || bob.playState === "idle") return;
              if (chance(0.5)) fx.notes(c, 1);
              later(700, tune);
            };
            later(700 + i * 150, tune);
            await host.tweenRaw(c, api.clampX(c.x + dir * run), (run / 34) * 1000, "linear", true);
            bob.cancel();
            if (!ok()) return;
            await hop(c, 10, 320);
            if (i === 0) fx.say(c, pick(["woo!", "again!", "♪"]), 900, true);
          }),
        ),
      ).then(() => undefined);
    },

    star() {
      const s = fx.el("i", "critter-star", host.floor);
      const fromLeft = chance(0.5);
      const tilt = `rotate(${fromLeft ? 14 : 166}deg)`;
      const an = s.animate(
        [
          {
            transform: `translate(${fromLeft ? -40 : W() + 40}px, ${-(SKY + 20)}px) ${tilt}`,
            opacity: 0,
          },
          { opacity: 1, offset: 0.2 },
          { opacity: 1, offset: 0.7 },
          {
            transform: `translate(${fromLeft ? W() * 0.8 : W() * 0.2}px, ${-(SIZE + 30)}px) ${tilt}`,
            opacity: 0,
          },
        ],
        { duration: 1100, easing: "ease-in" },
      );
      an.onfinish = an.oncancel = () => discard(s);
      let spoke = false;
      for (const o of kit.free()) {
        void api.perform(o, PRIO.idle, async () => {
          kit.say(o, "Making a wish");
          api.face(o, fromLeft ? 1 : -1);
          const up = { transform: `rotate(${-10 * o.dir}deg)` };
          void play(
            o.body,
            [{ transform: "none" }, up, { ...up, offset: 0.8 }, { transform: "none" }],
            {
              duration: 1700,
            },
          );
          if (!spoke && chance(0.5)) {
            spoke = true;
            fx.say(o, pick(["make a wish!", "ooh", "did you see that?"]), 1300);
          }
          await kit.flashEmote(o, "star", 1500);
        });
      }
      return wait(1800);
    },

    rps() {
      const pair = closestPair();
      if (!pair) return null;
      const [a, b] = pair;
      const bobUp = [
        { transform: "none" },
        { transform: "translateY(-5px)" },
        { transform: "none" },
      ];
      return api
        .performPair(a, b, PRIO.social, async (ok) => {
          kit.say(a, "Rock, paper, scissors");
          kit.say(b, "Rock, paper, scissors");
          await api.goTo(a, b.x + (a.x < b.x ? -1 : 1) * SIZE * 1.25, 1.5);
          if (!ok()) return;
          api.face(a, b.x >= a.x ? 1 : -1);
          api.face(b, a.x >= b.x ? 1 : -1);
          const throws = ["rock", "paper", "scissors"] as const;
          const beats = (p: number, q: number): boolean => (p + 2) % 3 === q;
          for (let round = 0; round < 3 && ok(); round++) {
            for (let k = 0; k < 3; k++) {
              void play(a.body, bobUp, { duration: 240 });
              await play(b.body, bobUp, { duration: 240 });
            }
            if (!ok()) return;
            const ta = Math.floor(rand(0, 3));
            const tb = Math.floor(rand(0, 3));
            emote(a, throws[ta] ?? "rock");
            emote(b, throws[tb] ?? "rock");
            await wait(900);
            if (!ok()) return;
            if (ta === tb) {
              fx.say(a, "again!", 600, true);
              continue;
            }
            const [win, lose] = beats(ta, tb) ? [a, b] : [b, a];
            emote(win, "star");
            emote(lose, "sweat");
            fx.say(win, pick(["ha!", "yes!", "I win"]), 900, true);
            void hop(win, 12, 340);
            await play(
              lose.body,
              [
                { transform: "none" },
                { transform: `rotate(${10 * lose.dir}deg) translateY(2px)` },
                { transform: "none" },
              ],
              { duration: 800 },
            );
            break;
          }
          discard(a.el.querySelector(".critter-badge"));
          discard(b.el.querySelector(".critter-badge"));
        })
        .then(() => undefined);
    },

    piggyback() {
      const pair = closestPair();
      if (!pair) return null;
      const [rider, mount] = pair;
      const lift = SIZE * 0.7;
      const down = (): void => {
        riders.delete(rider);
        rider.shadow.style.opacity = "";
      };
      return api
        .performPair(rider, mount, PRIO.social, async (ok) => {
          kit.say(rider, "Getting a piggyback");
          kit.say(mount, "Giving a piggyback");
          await api.goTo(rider, mount.x + (rider.x < mount.x ? -1 : 1) * SIZE * 0.9, 1.6);
          if (!ok()) return;
          fx.say(rider, pick(["up!", "carry me", "giddy up"]), 800, true);
          void api.tweenX(rider, mount.x, 420, "ease-out");
          await play(
            rider.body,
            [
              { transform: "none" },
              { transform: `translateY(${-lift - 14}px)`, offset: 0.6 },
              { transform: `translateY(${-lift}px)` },
            ],
            { duration: 440, easing: "ease-out", fill: "forwards" },
          );
          if (!ok()) return;
          void play(mount.body, [{ transform: "scale(1.15, 0.82)" }, { transform: "none" }], {
            duration: 240,
          });
          rider.shadow.style.opacity = "0";
          riders.set(rider, mount);
          for (let i = 0; i < 2 && ok(); i++) {
            const away = (chance(0.5) ? -1 : 1) * rand(90, 190);
            await api.goTo(mount, api.clampX(mount.x + away), 0.9);
            if (ok() && i === 0) fx.say(rider, pick(["wheee", "faster!", "onward"]), 900, true);
            await wait(300);
          }
          down();
          void api.tweenX(rider, rider.x + rider.dir * SIZE, 360, "ease-out");
          await play(
            rider.body,
            [
              { transform: `translateY(${-lift}px)` },
              { transform: `translateY(${-lift - 10}px)`, offset: 0.35 },
              { transform: "scale(1.15, 0.85)", offset: 0.9 },
              { transform: "none" },
            ],
            { duration: 420, easing: "ease-in" },
          );
          if (ok()) fx.say(mount, pick(["oof", "you're heavy", "my turn next"]), 900, true);
        })
        .then(down);
    },
  };

  function start(name: HappeningName): boolean {
    // A ball or a shooting star can share the floor with something else.
    if (on && name !== "ball" && name !== "star") return false;
    const run = happenings[name]();
    if (!run) return false;
    on = true;
    void run.finally(() => {
      on = false;
      nextAt = now() + gap();
    });
    return true;
  }

  function startOne(): void {
    const n = kit.free().length;
    const needs = (e: HappeningName): number =>
      e === "conga" ? 3 : e === "rps" || e === "piggyback" ? 2 : 1;
    // A monster needs open sky above the lane to be thrown into.
    const able = allowed.filter((e) => n >= needs(e) && (tall || (e !== "monster" && e !== "ken")));
    if (able.length) start(pick(able));
  }

  function tickBall(t: number, dt: number): void {
    const b = ball;
    if (!b) return;
    b.vy -= 520 * dt;
    b.y += b.vy * dt;
    b.x += b.vx * dt;
    if (b.y <= 0) {
      b.y = 0;
      b.vy = Math.abs(b.vy) > 60 ? -b.vy * 0.6 : 0;
      b.vx *= 0.985;
    }
    const over = t > b.until;
    if (!over && t > b.born + 900) {
      if (b.x < 2) {
        b.x = 2;
        b.vx = Math.abs(b.vx) * 0.8;
      } else if (b.x > W() - b.t.w - 2) {
        b.x = W() - b.t.w - 2;
        b.vx = -Math.abs(b.vx) * 0.8;
      }
    }
    b.spin += b.vx * dt * 3;
    b.t.at(b.x, b.y);
    b.t.inner.style.rotate = `${b.spin.toFixed(0)}deg`;
    const bx = b.x + b.t.w / 2;
    for (const o of api.live()) {
      if (!api.canAct(o) || o.prio > PRIO.idle || o.mode === "summon") continue;
      if (Math.abs(mid(o) - bx) > 15 || b.y > 16 || (b.cool.get(o) ?? 0) > t) continue;
      b.cool.set(o, t + 1300);
      // Kicked back toward the middle; out of the lane once the game is over.
      const toward = over ? (bx < W() / 2 ? -1 : 1) : mid(o) < W() / 2 ? 1 : -1;
      b.vx = toward * rand(120, 210);
      b.vy = rand(170, 260);
      void api.perform(o, PRIO.idle, async () => {
        kit.say(o, "Playing ball");
        api.face(o, toward);
        if (chance(0.3)) fx.say(o, pick(["mine!", "pass!", "boot it", "goal!"]), 800);
        await play(
          o.body,
          [
            { transform: "none" },
            { transform: `translateY(-7px) rotate(${-14 * toward}deg)`, offset: 0.4 },
            { transform: "none" },
          ],
          { duration: 300, easing: "ease-out" },
        );
      });
    }
    if (!over && t > b.chaseAt) {
      b.chaseAt = t + 650;
      const chasers = kit
        .free()
        .filter((o) => Math.abs(mid(o) - bx) < 240)
        .sort((p, q) => Math.abs(mid(p) - bx) - Math.abs(mid(q) - bx))
        .slice(0, 2);
      for (const o of chasers) {
        void api.perform(o, PRIO.idle, async () => {
          kit.say(o, "Chasing the ball");
          await api.goTo(o, bx - SIZE / 2 + rand(-6, 6), 1.9);
        });
      }
    }
    if (over && (b.x < -40 || b.x > W() + 40 || t > b.until + 5000)) {
      b.t.gone();
      b.resolve();
      ball = null;
    }
  }

  function tick(t: number, dt: number): void {
    for (const [rider, mount] of riders) {
      if (!rider.el.isConnected || !mount.el.isConnected) {
        riders.delete(rider);
        continue;
      }
      rider.x = mount.x;
      rider.dir = mount.dir;
      host.place(rider);
    }
    tickBall(t, dt);
    if (auto && !on && t >= nextAt) {
      nextAt = t + gap();
      startOne();
    }
  }

  return { tick };
}
