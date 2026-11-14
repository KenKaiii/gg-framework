// The monster: big, round and more hungry than scary. It comes through the
// lane (chasing off whoever is leaving, or just passing), and everyone else
// ducks until it has gone by. When a mean one comes and somebody is staying
// to see it, Ken sometimes turns up and sees it off: never the same fight
// twice, and he always wins.

import { discard, PX, SIZE } from "./critter-fx";
import { kenArt, type KenPoseName } from "./critter-ken-art";
import { emote, type StageKit, type Thing } from "./critter-stage-kit";
import { PRIO } from "./critter-types";
import type { Critter } from "./critter-types";

/** Someone the monster chases out of the lane; `done` once it is out of frame. */
export interface Chased {
  readonly c: Critter;
  readonly done: () => void;
}

export interface CritterMonster {
  /**
   * A monster comes through. `hero` forces Ken to meet it (or not); left
   * unset, a mean one sometimes does. He needs room and an audience either way.
   */
  run(
    fromLeft: boolean,
    chased: readonly Chased[],
    friendly: boolean,
    hero?: boolean,
  ): Promise<void>;
  /** One is about: there's only ever one. */
  out(): boolean;
  /** Wide enough for Ken to square up to it, with someone staying to watch. */
  kenCanCome(chased?: readonly Chased[]): boolean;
}

/** Room Ken needs on the side the monster is heading for. */
const KEN_ROOM = 226;

export function makeCritterMonster(kit: StageKit, onGone: () => void): CritterMonster {
  const { host, art: A, FAR, W, thing, mid, puffAt, twinkle, pow, shake, hop, arc, shout } = kit;
  const { api, later } = host;
  const { fx } = api;
  const { rand, pick, chance, wait, play } = fx;
  let out = false;
  let warmed = false;

  async function kenFight(
    m: Thing,
    dir: number,
    watchers: ReadonlySet<Critter>,
    onArrive: () => void,
    onWin: () => void,
  ): Promise<void> {
    const K = kenArt();
    const kw = K.stand.w * PX;
    const kh = K.stand.h * PX;
    const GAP = 40;
    const HI = kit.tall ? 64 : 42;
    const sx = -dir; // he faces the monster
    const inFrame = (x: number): number => Math.max(4, Math.min(W() - kw - 4, x));
    const home = (): number => inFrame(dir > 0 ? m.x + m.w + GAP : m.x - GAP - kw);
    const reach = (): number => (dir > 0 ? m.x + m.w - 12 : m.x + 12 - kw);
    const front = (): number => (dir > 0 ? m.x + m.w - 8 : m.x + 8);
    const mMid = (): number => m.x + m.w / 2;
    const kMid = (): number => k.x + kw / 2;
    // Where the monster ends up, knocked back `px` (never out of frame before the end).
    const knocked = (px: number): number =>
      dir > 0 ? Math.max(-m.w * 0.25, m.x - px) : Math.min(W() - m.w * 0.75, m.x + px);

    const dropIn = chance(0.5);
    const k = thing(
      dropIn ? K.kick : K.run0,
      dropIn ? home() : dir > 0 ? W() + 10 : -kw - 10,
      dropIn ? FAR : 0,
      { cls: "critter-ken" },
    );
    k.face(sx);
    const pose = (p: KenPoseName): void => k.show(K[p]);
    const run = (): void => {
      k.show(K.run0);
      k.cycle([K.run0, K.run1], 90);
    };
    const bounce = (h: number, ms: number, times = 1): void =>
      void play(k.inner, [{ translate: "0 0" }, { translate: `0 ${-h}px` }, { translate: "0 0" }], {
        duration: ms,
        iterations: times,
        easing: "ease-out",
      });
    let hurtN = 0;
    const hurt = (ms: number): void => {
      const id = ++hurtN;
      m.show(A.monsterHurt[0]);
      later(ms, () => {
        if (id === hurtN && m.node.isConnected) m.show(A.monster[0]);
      });
    };
    // Out of it for good: the face stays.
    const ko = (): void => {
      hurtN++;
      m.show(A.monsterHurt[0]);
    };
    const hit = (power: 1 | 2 | 3): void => {
      pow(front() + rand(-6, 6), m.y + rand(18, 38), 16 + power * 8);
      void play(
        m.inner,
        [
          { translate: "0 0", rotate: "0deg" },
          { translate: `${-dir * (2 + power * 3)}px 0`, rotate: `${-dir * power * 3}deg` },
          { translate: "0 0", rotate: "0deg" },
        ],
        { duration: 120 + power * 50, easing: "ease-out" },
      );
      hurt(220 + power * 140);
      shake(power, 120 + power * 70);
      if (power > 1) for (const o of watchers) void hop(o, 3 + power * 2, 240);
    };
    const dashIn = async (): Promise<void> => {
      run();
      await k.move(reach(), 0, 150, "ease-in");
    };
    const backOff = async (): Promise<void> => {
      pose("stand");
      await arc(k, home(), 0, 14, 240);
      puffAt(kMid(), 2, 3, 10);
    };
    const push = (px: number, ms: number): Promise<void> => {
      puffAt(mMid(), 2, 4, 14);
      return m.move(knocked(px), 0, ms, "ease-out");
    };
    const thud = (): void => {
      shake(4, 300);
      puffAt(mMid() - 20, 2, 5, 18);
      puffAt(mMid() + 20, 2, 5, 18);
    };

    // He arrives: at a run, or out of the sky.
    if (dropIn) {
      const fall = k.move(home(), 0, 460, "ease-in");
      void play(
        k.inner,
        [
          { scale: `${sx * 0.3} 0.3`, opacity: 0 },
          { opacity: 1, offset: 0.25 },
          { scale: `${sx} 1` },
        ],
        { duration: 460, easing: "ease-in" },
      );
      await fall;
      pose("land");
      shake(4, 320);
      puffAt(kMid() - 14, 2, 5, 18);
      puffAt(kMid() + 14, 2, 5, 18);
      await wait(380);
    } else {
      run();
      await k.move(home(), 0, Math.min(800, Math.abs(home() - k.x) / 0.55), "ease-out");
      puffAt(kMid() + dir * 12, 2, 5, 14);
    }
    pose("stand");
    onArrive();
    shout(k, pick(["Not today.", "Back off!", "Hey, ugly!", "Leave them be!", "Shoo."]), 1000);
    await wait(950);
    shout(m, pick(["RAWR!", "GRAAH!", "MINE!"]), 700);
    shake(2, 260);
    await play(m.inner, [{ scale: "1" }, { scale: "1.12" }, { scale: "1" }], { duration: 440 });
    await wait(160);

    const moves: Readonly<Record<string, () => Promise<void>>> = {
      async flurry() {
        await dashIn();
        const n = 4 + Math.floor(rand(0, 3));
        for (let i = 0; i < n; i++) {
          pose("punch");
          hit(1);
          await wait(80);
          pose("power");
          await wait(50);
        }
        await push(14, 160);
        await backOff();
      },
      async uppercut() {
        await dashIn();
        pose("land");
        await wait(150);
        pose("upper");
        hit(2);
        hurt(900);
        void arc(k, k.x, 0, HI * 0.55, 480);
        await arc(m, knocked(10), 0, HI, 640, -dir * 360);
        thud();
        await wait(220);
        await backOff();
      },
      async kick() {
        // A step back for a run-up, then feet first.
        await arc(k, inFrame(k.x + dir * 24), 0, 10, 200);
        pose("land");
        await wait(170);
        pose("kick");
        await arc(k, reach() + dir * 6, 14, HI * 0.35, 280);
        hit(2);
        const skid = push(30, 300);
        pose("stand");
        await arc(k, home(), 0, 16, 260);
        await skid;
      },
      async slam() {
        pose("upper");
        await arc(k, reach() + dir * 16, 0, HI * 1.15, 520);
        pose("land");
        shake(5, 380);
        const at = kMid();
        for (let i = 0; i < 3; i++) {
          later(i * 70, () => {
            puffAt(at - (i + 1) * 16, 2, 3, 10);
            puffAt(at + (i + 1) * 16, 2, 3, 10);
          });
        }
        hurt(700);
        for (const o of watchers) void hop(o, 8, 300);
        await arc(m, knocked(18), 0, HI * 0.5, 420);
        shake(2, 200);
        await wait(160);
        await backOff();
      },
      async counter() {
        // The monster swings first. He isn't there any more.
        shout(m, pick(["GRAAH!", "SNACK!"]), 600);
        await m.move(m.x - dir * 8, 0, 200, "ease-out");
        const lunge = m.move(m.x + dir * (GAP + 22), 0, 170, "ease-in");
        const flip = arc(k, inFrame(k.x + dir * 54), 0, HI * 0.7, 420, dir * 360);
        await lunge;
        await play(
          m.inner,
          [{ rotate: "0deg" }, { rotate: `${dir * 16}deg` }, { rotate: "0deg" }],
          { duration: 420, easing: "ease-in-out" },
        );
        await flip;
        shout(k, pick(["Too slow!", "Missed me!", "Nope."]), 800);
        await wait(380);
        await dashIn();
        pose("punch");
        hit(2);
        await push(GAP + 30, 260);
        await backOff();
      },
      async taunt() {
        // Its best roar. He lets it finish.
        shout(m, "RAAAWR!", 800);
        shake(4, 500);
        void play(m.inner, [{ scale: "1" }, { scale: "1.18 1.1" }, { scale: "1" }], {
          duration: 600,
        });
        void play(
          k.inner,
          [{ translate: "0 0" }, { translate: `${dir * 5}px 0` }, { translate: "0 0" }],
          { duration: 600 },
        );
        await wait(720);
        pose("flex");
        shout(k, pick(["That all?", "Cute.", "Done?"]), 800);
        await wait(620);
        hurtN++;
        m.show(A.monsterShut);
        kit.thingEmote(m, "sweat", 600);
        await wait(520);
        await dashIn();
        pose("punch");
        hit(2);
        await push(20, 220);
        await backOff();
      },
    };
    const finishers: Readonly<Record<string, () => Promise<void>>> = {
      async launch() {
        // Wound up, then sent so far it twinkles.
        pose("power");
        shout(k, pick(["GG!", "Bye bye!", "Out you go!"]), 900);
        k.node.classList.add("charging");
        for (let i = 0; i < 6; i++) {
          later(i * 80, () => twinkle(kMid() + rand(-22, 22), rand(6, kh - 10)));
        }
        await wait(560);
        k.node.classList.remove("charging");
        await dashIn();
        pose("upper");
        hit(3);
        ko();
        void arc(k, k.x, 0, HI * 0.6, 520);
        const away = m.x - dir * (kit.tall ? 240 : 170);
        const fly = m.move(away, FAR, 1150, "ease-out");
        void play(
          m.inner,
          [
            { rotate: "0deg", scale: "1" },
            { rotate: `${-dir * 720}deg`, scale: "0.1" },
          ],
          { duration: 1150, easing: "ease-in", fill: "forwards" },
        );
        await fly;
        twinkle(away + m.w / 2, FAR + m.h / 2);
        m.gone();
        await wait(250);
      },
      async scare() {
        // One flex and it remembers somewhere else to be.
        pose("flex");
        bounce(8, 260);
        shout(k, pick(["BOO!", "SCRAM!", "GET!"]), 800);
        shake(3, 300);
        ko();
        kit.thingEmote(m, "!", 500);
        await arc(m, m.x, 0, 20, 320);
        shout(m, pick(["eep!", "nope nope", "MUMMY!"]), 900);
        m.cycle(A.monsterHurt, 90);
        const off = dir > 0 ? -m.w - 40 : W() + 40;
        const flee = m.move(off, 0, Math.abs(off - m.x) / 0.42, "ease-in");
        const trail = (): void => {
          if (!m.node.isConnected) return;
          puffAt(m.liveX() + m.w / 2, 2, 2, 8);
          later(110, trail);
        };
        trail();
        run();
        await k.move(inFrame(k.x - dir * 60), 0, 420, "linear");
        pose("stand");
        await flee;
        m.gone();
      },
      async toss() {
        // Under it, up over his head, and out the way it came.
        await dashIn();
        pose("land");
        await wait(180);
        ko();
        pose("flex");
        shout(k, pick(["Hup!", "Up you go!"]), 700);
        await m.move(kMid() - m.w / 2, kh - 16, 320, "ease-out");
        void play(m.inner, [{ rotate: "-6deg" }, { rotate: "6deg" }], {
          duration: 110,
          iterations: 5,
          direction: "alternate",
        });
        shake(1, 200);
        await wait(560);
        pose("punch");
        const off = dir > 0 ? -m.w - 60 : W() + 60;
        await arc(m, off, 6, HI * 0.9, Math.max(620, Math.abs(off - m.x) / 0.7), -dir * 540);
        m.gone();
        later(120, () => shake(3, 260));
        await wait(350);
      },
    };

    const names = Object.keys(moves);
    const rounds = chance(0.4) ? 3 : 2;
    let last = "";
    for (let i = 0; i < rounds; i++) {
      const name = pick(names.filter((n) => n !== last));
      last = name;
      await moves[name]?.();
      await wait(rand(120, 320));
    }
    await finishers[pick(Object.keys(finishers))]?.();

    // Won. He lets them know.
    pose("flex");
    bounce(6, 300, 3);
    shout(k, pick(["GG!", "Too easy.", "All clear!", "Who's next?"]), 1500);
    for (const col of ["#ffe14d", "#ff6b60", "#8fdcff"]) puffAt(kMid(), kh - 6, 6, 30, col);
    onWin();
    await wait(2300);

    if (chance(0.5)) {
      // Up and away, until he's too small to see.
      pose("land");
      await wait(200);
      pose("upper");
      puffAt(kMid(), 2, 6, 18);
      const up = k.move(k.x - dir * 30, FAR, 700, "ease-in");
      void play(k.inner, [{ scale: `${sx} 1` }, { scale: `${sx * 0.12} 0.12` }], {
        duration: 700,
        easing: "ease-in",
        fill: "forwards",
      });
      await up;
      twinkle(kMid(), FAR + kh / 2);
    } else {
      // Or back the way he came, at a jog.
      k.face(dir);
      run();
      const off = dir > 0 ? W() + 20 : -kw - 20;
      await k.move(off, 0, Math.abs(off - k.x) / 0.3, "linear");
    }
    k.gone();
  }

  const kenCanCome = (chased: readonly Chased[] = []): boolean =>
    W() >= KEN_ROOM + 200 && kit.acting().some((o) => !chased.some((g) => g.c === o));

  async function run(
    fromLeft: boolean,
    chased: readonly Chased[],
    friendly: boolean,
    wantHero?: boolean,
  ): Promise<void> {
    out = true;
    const hero = !friendly && kenCanCome(chased) && (wantHero ?? chance(0.45));
    if (!warmed) {
      // Load every frame up front, so a face swap never blinks.
      warmed = true;
      const frames = [...A.monster, A.monsterShut, ...A.monsterHurt, ...Object.values(kenArt())];
      for (const a of frames) new Image().src = a.url;
    }
    let kenHere: () => void = () => undefined;
    let kenWon: () => void = () => undefined;
    const arrived = new Promise<void>((r) => (kenHere = r));
    const won = new Promise<void>((r) => (kenWon = r));
    const watchers = new Set<Critter>();
    let fightX = 0;
    const a = A.monster[0];
    const w = a.w * PX;
    const dir = fromLeft ? 1 : -1;
    const m = thing(a, fromLeft ? -w - 10 : W() + 10, 0, { cls: "critter-monster" });
    m.cycle(A.monster, 170);
    let walking = true;
    const stomp = (): void => {
      if (!m.node.isConnected) return;
      if (walking) shake(1, 160);
      later(340, stomp);
    };
    stomp();
    await m.move(m.x + dir * (w + 24), 0, 800, "linear");
    shout(m, friendly ? "Hello?" : pick(["RAWR!", "GRAAH!", "SNACKS!"]), 1000);
    shake(3, 380);
    const speed = 0.13;
    for (const o of kit.acting()) {
      if (chased.some((g) => g.c === o)) continue;
      const reach = (Math.abs(mid(o) - (m.x + w / 2)) / speed) | 0;
      void api.perform(o, PRIO.event, async (ok) => {
        kit.say(o, friendly ? "Keeping very still" : "Hiding from the monster");
        api.face(o, -dir as 1 | -1);
        void kit.flashEmote(o, "!", 600);
        await hop(o, 10, 280);
        if (!ok()) return;
        const ducked = "translateY(2px) scale(1.16, 0.62)";
        await play(o.body, [{ transform: "none" }, { transform: ducked }], {
          duration: 180,
          fill: "forwards",
        });
        o.el.classList.add("shiver");
        await (hero ? Promise.race([arrived, wait(20000)]) : wait(reach + 700));
        o.el.classList.remove("shiver");
        if (!ok()) return;
        await play(o.body, [{ transform: ducked }, { transform: "none" }], { duration: 220 });
        if (!hero) {
          void kit.flashEmote(o, "sweat", 800);
          if (chance(0.35)) fx.say(o, pick(["phew", "is it gone?", "close one"]), 1000);
          await wait(300);
          return;
        }
        // Ken's here: up they get to watch, and when he wins they cheer.
        kit.say(o, "Watching Ken fight");
        api.face(o, fightX >= mid(o) ? 1 : -1);
        void kit.flashEmote(o, "!", 700);
        watchers.add(o);
        await Promise.race([won, wait(40000)]);
        watchers.delete(o);
        if (!ok()) return;
        kit.say(o, "Cheering for Ken");
        await wait(rand(0, 260));
        if (chance(0.6)) {
          fx.say(o, pick(["KEN!", "our hero!", "woo!", "GG!", "yeah!", "he did it!"]), 1300, true);
        } else void kit.flashEmote(o, pick(["heart", "star"] as const), 1300);
        for (let i = 0; i < 4; i++) {
          if (!ok()) return;
          if (i === 1) fx.confetti(o, 8);
          if (i === 2) fx.hearts(o, 2);
          await hop(o, rand(8, 15), rand(260, 340));
          await wait(rand(20, 120));
        }
      });
    }
    for (const { c } of chased) {
      kit.clearMarks(c);
      emote(c, "!");
      void hop(c, 12, 300);
    }
    await wait(520);
    chased.forEach(({ c, done }, i) => {
      discard(c.el.querySelector(".critter-badge"));
      c.dir = dir;
      fx.sweat(c, 3);
      const to = dir > 0 ? W() + SIZE + 30 : -SIZE * 2 - 30;
      // Each is gone the moment it's out of frame, not when the show ends.
      later(i * 90, () => {
        void host.tweenRaw(c, to, Math.abs(to - c.x) / 0.19, "ease-in", true).then(done);
      });
    });
    if (hero) {
      // It gets a little way after them, and then Ken is in its way.
      const far = Math.min(300, W() * 0.3);
      const stage =
        dir > 0
          ? Math.min(Math.max(m.x, far - w / 2), Math.max(m.x, W() - KEN_ROOM - w))
          : Math.max(Math.min(m.x, W() - far - w / 2), Math.min(m.x, KEN_ROOM));
      await m.move(stage, 0, Math.abs(stage - m.x) / 0.2, "linear");
      walking = false;
      m.show(A.monster[0]);
      await kenFight(
        m,
        dir,
        watchers,
        () => {
          fightX = m.x + w / 2;
          kenHere();
        },
        kenWon,
      );
      kenHere();
      kenWon();
    } else {
      if (friendly) {
        // It only wanted to smell the flowers.
        const cx = W() / 2 - w / 2;
        await m.move(cx, 0, Math.abs(cx - m.x) / speed, "linear");
        walking = false;
        m.show(A.monsterShut);
        await wait(500);
        kit.thingEmote(m, "heart", 1200);
        await play(
          m.inner,
          [{ rotate: "0deg" }, { rotate: "-5deg" }, { rotate: "5deg" }, { rotate: "0deg" }],
          { duration: 1200, easing: "ease-in-out" },
        );
        walking = true;
        m.cycle(A.monster, 170);
      }
      const off = dir > 0 ? W() + 40 : -w - 40;
      await m.move(off, 0, Math.abs(off - m.x) / speed, "linear");
      m.gone();
    }
    out = false;
    onGone();
  }

  return { run, out: () => out, kenCanCome };
}
