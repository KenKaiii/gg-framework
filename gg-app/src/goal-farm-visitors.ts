// Visitors to a Goal's farm, now and then: a saucer after a daikon, a monster
// that only wants to say hello at the gate, and a mean one that Ken sees off.
// For that fight little Ken (GG Goals, at work on the farm) powers up: he
// steps out in a puff, strong Ken drops in at the gate, and when it's won
// little Ken is back at his spot. Never the same fight twice; he always wins.

import { art, artCanvas, type Art } from "./critter-art";
import { kenArt, type KenPoseName } from "./critter-ken-art";
import { FARM_CRITTER_H } from "./goal-farm-critters";
import { drawSaucer, everyoneSays, stamp, type FarmBoard } from "./goal-farm-comings";
import { drawBubble, shadow } from "./goal-farm-render";
import type { Actor } from "./goal-farm-sim";
import { tripPose } from "./goal-farm-travel";

type Ctx = CanvasRenderingContext2D;

export const FARM_VISITORS = ["flyover", "monster", "ken"] as const;
export type FarmVisitor = (typeof FARM_VISITORS)[number];

export interface FarmVisitors {
  /** Start one now. False if it can't happen (no gate, or Ken is busy). */
  start(name: FarmVisitor, now: number): boolean;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const easeInOut = (k: number): number => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
/** A hop `h` high, over u = 0 → 1. */
const hopY = (u: number, h: number): number => 4 * h * u * (1 - u);

/** An art with its bottom-centre at (x, y): flipped, turned by quarter turns, or scaled. */
function stampT(
  ctx: Ctx,
  a: Art,
  x: number,
  y: number,
  flip: boolean,
  turns: number,
  scale: number,
): void {
  if (!flip && !turns && scale === 1) return stamp(ctx, a, x, y);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(Math.round(x), Math.round(y - a.h / 2));
  if (turns) ctx.rotate((turns * Math.PI) / 2);
  ctx.scale(flip ? -scale : scale, scale);
  ctx.drawImage(artCanvas(a), -a.w / 2, -a.h / 2);
  ctx.restore();
}

/** A puff of paper-white dust bursting out from (x, y), u = 0 → 1. */
function puff(ctx: Ctx, x: number, y: number, u: number): void {
  ctx.fillStyle = "#f3efe6";
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const r = 3 + u * 11;
    const size = u < 0.6 ? 2 : 1;
    ctx.fillRect(
      Math.round(x + Math.cos(a) * r),
      Math.round(y + Math.sin(a) * r * 0.7),
      size,
      size,
    );
  }
}

export function makeFarmVisitors(board: FarmBoard): FarmVisitors {
  const A = art();
  const choose = <T>(list: readonly T[]): T => list[Math.floor(board.random() * list.length)] as T;
  const coordinator = (): Actor | undefined =>
    [...(board.world()?.actors.values() ?? [])].find((a) => a.coordinator);

  // ── The saucer comes for a daikon ──
  function flyover(now: number): boolean {
    const farm = board.world()?.farm;
    if (!farm) return false;
    const gx = farm.width * (0.25 + board.random() * 0.4);
    const gy = farm.height - 40;
    const IN = 2200;
    const HOLD = 1700;
    const OUT = 1500;
    const ALT = 46;
    board.shows.push({
      t0: now,
      dur: IN + HOLD + OUT,
      visitor: true,
      draw(ctx, t) {
        let x = gx;
        let y = gy;
        if (t < IN) {
          const k = easeInOut(t / IN);
          x = lerp(-30, gx, k);
          y = lerp(farm.height * 0.35, gy, k);
        } else if (t > IN + HOLD) {
          const k = ((t - IN - HOLD) / OUT) ** 2;
          x = lerp(gx, farm.width + 40, k);
          y = lerp(gy, farm.height * 0.2, k);
        }
        // Up the beam it goes.
        const pull = clamp01((t - IN - 300) / (HOLD - 500));
        if (t > IN + 300 && pull < 1) stamp(ctx, A.daikon, x, y - 2 - (ALT - 12) * easeInOut(pull));
        drawSaucer(ctx, x, y - ALT, t, t > IN && t < IN + HOLD ? 1 : 0, y);
      },
    });
    return true;
  }

  // ── A monster looks in at the gate. It only wanted to say hello ──
  function monsterVisit(now: number): boolean {
    const w = board.world();
    const door = w?.farm.stations.door[0];
    if (!w || !door) return false;
    const y = door.y;
    const width = w.farm.width;
    const stop = Math.max(24, door.x - 34);
    const IN = ((stop + 20) / 34) * 1000;
    const LOOK = 2400;
    let warned = false;
    board.shows.push({
      t0: now,
      dur: IN * 2 + LOOK,
      visitor: true,
      draw(ctx, t) {
        const moving = t < IN || t > IN + LOOK;
        const x =
          t < IN ? lerp(-20, stop, t / IN) : moving ? lerp(stop, -20, (t - IN - LOOK) / IN) : stop;
        if (!moving && !warned) {
          warned = true;
          everyoneSays(board, () => "!", now + t);
        }
        const bob = moving && Math.floor(t / 170) % 2 ? 1 : 0;
        shadow(ctx, x, y + 2, 12, 1, 0.3);
        stamp(ctx, moving ? A.monster[bob] : A.monsterShut, x, y + 3 - bob);
        if (moving) return;
        if (t < IN + 1100) drawBubble(ctx, "Hello?", x, y - 27, width);
        else {
          const rise = ((t - IN - 1100) / 1300) * 6;
          ctx.drawImage(artCanvas(A.emotes.heart), Math.round(x - 2), Math.round(y - 36 - rise));
        }
      },
    });
    return true;
  }

  // ── Ken sees a monster off at the gate ──
  /** Little Ken can step away: he's on the farm, standing still, and not asking you something. */
  const kenFree = (ken: Actor | undefined): ken is Actor =>
    ken !== undefined && !ken.offstage && !ken.trip && ken.want !== "ask";

  function kenBattle(now: number): boolean {
    const w = board.world();
    const door = w?.farm.stations.door[0];
    const little = coordinator();
    if (!w || !door || !kenFree(little)) return false;
    const y = door.y;
    const width = w.farm.width;
    // A little way in through the gate, so there's room to knock it back.
    const stop = Math.max(24, door.x - 34) + 26;
    const K = kenArt();
    /** Ken's distance from the monster: squaring up, and close enough to land one. */
    const HOME = 42;
    const HIT = 26;
    /** The middle of little Ken, wherever he is `t` ms into the fight: where his puffs go. */
    const littleAt = (t: number): { x: number; y: number } => {
      const feet = little.trip ? tripPose(little.trip, now + t, little.facing) : little.spot;
      return { x: feet.x, y: feet.y - FARM_CRITTER_H / 2 };
    };
    const S = {
      mx: -20,
      my: 0,
      mArt: A.monster[0] as Art,
      turns: 0,
      mScale: 1,
      mOn: true,
      kx: stop + HOME,
      ky: 0,
      pose: "stand" as KenPoseName,
      kScale: 1,
      kOn: false,
    };
    const says: { text: string; x: number; top: number }[] = [];
    const sparks: { x: number; y: number; r: number }[] = [];
    const dust: { x: number; u: number }[] = [];
    const puffs: { x: number; y: number; u: number }[] = [];
    interface Beat {
      readonly dur: number;
      step(t: number, u: number): void;
    }
    const beats: Beat[] = [];
    const beat = (dur: number, step: Beat["step"]): void => void beats.push({ dur, step });
    /** A beat that starts from wherever the two of them have got to. */
    const act = (
      dur: number,
      step: (t: number, u: number, k0: number, m0: number) => void,
    ): void => {
      let k0: number | undefined;
      let m0: number | undefined;
      beat(dur, (t, u) => {
        k0 ??= S.kx;
        m0 ??= S.mx;
        step(t, u, k0, m0);
      });
    };
    const stepArt = (t: number, hurt = false, ms = 170): Art =>
      (hurt ? A.monsterHurt : A.monster)[Math.floor(t / ms) % 2 ? 1 : 0];
    const runPose = (t: number): KenPoseName => (Math.floor(t / 90) % 2 ? "run1" : "run0");
    const mSay = (text: string): void => void says.push({ text, x: S.mx, top: y - 27 - S.my });
    const kSay = (text: string): void => void says.push({ text, x: S.kx, top: y - 28 - S.ky });
    const spark = (r: number): void => void sparks.push({ x: S.mx + 13, y: y - 14 - S.my, r });
    const hurtArt = A.monsterHurt[0];

    const dashIn = (): void =>
      act(140, (t, u, k0, m0) => {
        S.pose = runPose(t);
        S.kx = lerp(k0, m0 + HIT, u);
      });
    const backOff = (): void =>
      act(230, (_t, u, k0, m0) => {
        S.pose = "stand";
        S.kx = lerp(k0, m0 + HOME, u);
        S.ky = hopY(u, 6);
        S.mArt = A.monster[0];
      });
    const crouch = (ms: number): void => act(ms, () => void (S.pose = "land"));

    const moves: Readonly<Record<string, () => void>> = {
      flurry() {
        dashIn();
        const n = 4 + Math.floor(board.random() * 3);
        act(n * 130, (t, _u, _k0, m0) => {
          const p = t % 130;
          S.pose = p < 80 ? "punch" : "power";
          S.mArt = hurtArt;
          S.mx = m0 - (p < 60 ? 2 : 0);
          if (p < 70) spark(4);
        });
        act(160, (_t, u, _k0, m0) => void (S.mx = lerp(m0, m0 - 8, u)));
        backOff();
      },
      uppercut() {
        dashIn();
        crouch(150);
        act(620, (t, u, _k0, m0) => {
          S.pose = "upper";
          S.ky = hopY(Math.min(1, u * 1.4), 12);
          S.my = hopY(u, 34);
          S.turns = Math.floor(u * 4) % 4;
          S.mArt = hurtArt;
          S.mx = lerp(m0, m0 - 6, u);
          if (t < 130) spark(6);
        });
        act(200, (_t, u) => void dust.push({ x: S.mx, u }));
        backOff();
      },
      kick() {
        crouch(170);
        act(260, (_t, u, k0, m0) => {
          S.pose = "kick";
          S.kx = lerp(k0, m0 + HIT + 2, u);
          S.ky = 5 * u + hopY(u, 8);
        });
        act(300, (t, u, k0, m0) => {
          S.pose = "stand";
          S.mArt = u < 1 ? hurtArt : A.monster[0];
          S.mx = lerp(m0, m0 - 14, 1 - (1 - u) ** 2);
          S.kx = lerp(k0, m0 - 14 + HOME, u);
          S.ky = 5 * (1 - u) + hopY(u, 6);
          if (t < 130) spark(6);
          dust.push({ x: S.mx, u });
        });
      },
      slam() {
        act(500, (_t, u, k0, m0) => {
          S.pose = "upper";
          S.kx = lerp(k0, m0 + HIT + 8, u);
          S.ky = hopY(u, 40);
        });
        act(420, (_t, u, _k0, m0) => {
          S.pose = "land";
          S.my = hopY(u, 16);
          S.mx = lerp(m0, m0 - 8, u);
          S.mArt = hurtArt;
          dust.push({ x: S.kx - 10, u }, { x: S.kx + 10, u });
        });
        backOff();
      },
    };
    const finishers: Readonly<Record<string, () => void>> = {
      launch() {
        // Wound up, then sent so far it twinkles.
        const line = choose(["GG!", "Bye bye!", "Out you go!"]);
        act(520, (t, _u, k0) => {
          S.pose = "power";
          S.kx = k0 + (Math.floor(t / 60) % 2);
          kSay(line);
        });
        dashIn();
        act(1100, (t, u, _k0, m0) => {
          S.pose = "upper";
          S.ky = hopY(Math.min(1, u * 2.2), 12);
          S.mArt = hurtArt;
          S.mx = lerp(m0, m0 - 110, u);
          S.my = lerp(0, 150, 1 - (1 - u) ** 2);
          S.mScale = lerp(1, 0.12, u * u);
          S.turns = Math.floor(u * 8) % 4;
          if (t < 140) spark(8);
          if (u >= 1) S.mOn = false;
        });
        act(300, (_t, u) => {
          sparks.push({ x: S.mx - 13, y: y - S.my, r: Math.round(4 * (1 - u)) });
        });
      },
      scare() {
        // One flex and it remembers somewhere else to be.
        const line = choose(["BOO!", "SCRAM!", "GET!"]);
        act(560, (_t, u) => {
          S.pose = "flex";
          S.ky = hopY(Math.min(1, u * 2), 4);
          S.my = hopY(Math.min(1, Math.max(0, u * 2 - 0.6)), 10);
          S.mArt = hurtArt;
          kSay(line);
        });
        const cry = choose(["eep!", "nope nope", "MUMMY!"]);
        act(((stop + 30) / 95) * 1000, (t, u, k0, m0) => {
          S.my = 0;
          S.mx = lerp(m0, -26, u);
          S.mArt = stepArt(t, true, 90);
          if (t < 800) mSay(cry);
          S.pose = t < 380 ? runPose(t) : "stand";
          S.kx = lerp(k0, k0 - 16, Math.min(1, t / 380));
          if (u >= 1) S.mOn = false;
        });
      },
      toss() {
        // Under it, up over his head, and out the way it came.
        dashIn();
        crouch(180);
        act(320, (_t, u, k0, m0) => {
          S.pose = "flex";
          S.mArt = hurtArt;
          S.mx = lerp(m0, k0, u);
          S.my = lerp(0, 24, u);
        });
        act(520, (t, _u, k0) => {
          S.mx = k0 + (Math.floor(t / 90) % 2 ? 1 : -1);
          kSay("Hup!");
        });
        act(800, (_t, u, _k0, m0) => {
          S.pose = "punch";
          S.mx = lerp(m0, -40, u);
          S.my = 24 * (1 - u) + hopY(u, 44);
          S.turns = Math.floor(u * 6) % 4;
          if (u >= 1) S.mOn = false;
        });
      },
    };

    // The monster comes up the road and means it.
    beat(((stop + 20) / 34) * 1000, (t, u) => {
      S.mx = lerp(-20, stop, u);
      S.mArt = stepArt(t);
    });
    let warned = false;
    beat(900, (t) => {
      S.mArt = A.monster[0];
      mSay("RAWR!");
      if (!warned) everyoneSays(board, () => "!", now + elapsed + t);
      warned = true;
    });
    // Little Ken powers up: gone from his spot in a puff…
    beat(380, (t, u) => {
      little.offstage = true;
      puffs.push({ ...littleAt(elapsed + t), u });
    });
    // …and strong Ken comes down out of the sky at the gate.
    beat(420, (_t, u) => {
      S.kOn = true;
      S.pose = "kick";
      S.ky = lerp(150, 0, u * u);
      S.kScale = lerp(0.35, 1, u);
    });
    beat(380, (_t, u) => {
      S.pose = "land";
      dust.push({ x: S.kx - 8, u }, { x: S.kx + 8, u });
    });
    const taunt = choose(["Not today.", "Back off!", "Hey, ugly!", "Shoo."]);
    beat(850, () => {
      S.pose = "stand";
      kSay(taunt);
    });
    const names = Object.keys(moves);
    const rounds = board.random() < 0.4 ? 3 : 2;
    let last = "";
    for (let n = 0; n < rounds; n++) {
      const name = choose(names.filter((m) => m !== last));
      last = name;
      moves[name]?.();
      act(120 + board.random() * 200, () => undefined);
    }
    finishers[choose(Object.keys(finishers))]?.();
    // Won: he lets them know, and they cheer.
    const win = choose(["GG!", "Too easy.", "All clear!"]);
    const cheerAt = beats.reduce((s, b) => s + b.dur, 0);
    let cheered = false;
    beat(2300, (t) => {
      S.pose = "flex";
      S.ky = t < 900 ? hopY((t % 300) / 300, 3) : 0;
      if (t < 1500) kSay(win);
      if (cheered) return;
      cheered = true;
      everyoneSays(board, () => choose(["KEN!", "GG!", "Woo!", "Yay!"]), now + elapsed + t, 1500);
    });
    if (board.random() < 0.5) {
      // Up and away.
      crouch(200);
      act(650, (_t, u, k0) => {
        S.pose = "upper";
        S.kx = k0 - 14 * u;
        S.ky = lerp(0, 150, u * u);
        S.kScale = lerp(1, 0.15, u);
        if (u >= 1) S.kOn = false;
      });
    } else {
      // Or off down the road.
      act(((stop + HOME + 20) / 60) * 1000, (t, u, k0) => {
        S.pose = runPose(t * 0.6);
        S.kx = lerp(k0, -20, u);
        if (t < 800) kSay("See ya!");
        if (u >= 1) S.kOn = false;
      });
    }
    // …and little Ken is back at his spot, in another puff.
    beat(380, (t, u) => {
      little.offstage = false;
      puffs.push({ ...littleAt(elapsed + t), u });
    });

    let i = 0;
    /** When the current beat started, ms into the fight. */
    let elapsed = 0;
    const CONFETTI = ["#ff6b60", "#ffe14d", "#7fe89a", "#8fdcff"];
    board.shows.push({
      t0: now,
      dur: beats.reduce((s, b) => s + b.dur, 0),
      visitor: true,
      draw(ctx, t) {
        for (let b = beats[i]; b && i < beats.length - 1 && t - elapsed >= b.dur; b = beats[i]) {
          b.step(b.dur, 1);
          elapsed += b.dur;
          i++;
        }
        says.length = sparks.length = dust.length = puffs.length = 0;
        const b = beats[i];
        if (b) b.step(Math.min(t - elapsed, b.dur), Math.min(1, (t - elapsed) / b.dur));
        if (S.mOn) {
          shadow(ctx, S.mx, y + 2, S.my > 3 ? 8 : 12, 1, S.my > 3 ? 0.18 : 0.3);
          stampT(ctx, S.mArt, S.mx, y + 3 - S.my, false, S.turns, S.mScale);
        }
        if (S.kOn) {
          shadow(ctx, S.kx, y + 1, S.ky > 3 ? 5 : 8, 1, S.ky > 3 ? 0.18 : 0.3);
          stampT(ctx, K[S.pose], S.kx, y + 2 - S.ky, true, 0, S.kScale);
        }
        for (const p of puffs) puff(ctx, p.x, p.y, p.u);
        ctx.fillStyle = "#f3efe6";
        for (const p of dust) {
          for (const side of [-1, 1]) {
            ctx.fillRect(Math.round(p.x + side * (4 + p.u * 9)), Math.round(y - p.u * 5), 2, 2);
          }
        }
        for (const s of sparks) {
          ctx.fillStyle = "#ffe14d";
          ctx.fillRect(Math.round(s.x - s.r), Math.round(s.y), s.r * 2 + 1, 1);
          ctx.fillRect(Math.round(s.x), Math.round(s.y - s.r), 1, s.r * 2 + 1);
          const d = Math.round(s.r * 0.6);
          for (const [dx, dy] of [
            [-d, -d],
            [d, -d],
            [-d, d],
            [d, d],
          ] as const) {
            ctx.fillRect(Math.round(s.x) + dx, Math.round(s.y) + dy, 1, 1);
          }
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(Math.round(s.x) - 1, Math.round(s.y) - 1, 3, 3);
        }
        // Confetti over everyone who's cheering.
        const ct = t - cheerAt;
        if (ct > 0 && ct < 1700) {
          let n = 0;
          for (const a of board.world()?.actors.values() ?? []) {
            if (a.offstage || a.state === "leaving" || a.state === "arriving") continue;
            const pose = a.trip ? tripPose(a.trip, now + t, a.facing) : a.spot;
            for (let j = 0; j < 6; j++) {
              const fall = (ct / 14 + j * 9 + n * 5) % 30;
              ctx.fillStyle = CONFETTI[(j + n) % CONFETTI.length] ?? "#fff";
              ctx.fillRect(
                Math.round(pose.x + ((j * 7 + n * 3) % 17) - 8),
                Math.round(pose.y - 34 + fall),
                1,
                2,
              );
            }
            n++;
          }
        }
        for (const s of says) drawBubble(ctx, s.text, s.x, s.top, width);
      },
      end() {
        // However it ends (won, or cut short by a question), he's back.
        little.offstage = false;
      },
    });
    return true;
  }

  return {
    start(name, now) {
      if (name === "flyover") return flyover(now);
      if (name === "monster") return monsterVisit(now);
      return kenBattle(now);
    },
  };
}
