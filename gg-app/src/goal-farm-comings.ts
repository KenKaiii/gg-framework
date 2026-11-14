// More ways for a Goal's workers to come and go than the gate's column of
// sunlight: set down or lifted away by a saucer, walking in or off along the
// road, floating up under a sky lantern, or chased out by a monster. The sim
// (goal-farm-sim.ts) still decides who arrives and who has finished; this
// only chooses how, and plays it out over the farm's frame.

import { art, artCanvas, type Art } from "./critter-art";
import { bayerAt, drawBubble, drawFarmCritter, shadow } from "./goal-farm-render";
import type { Actor, FarmWorld } from "./goal-farm-sim";
import { tripPose } from "./goal-farm-travel";

type Ctx = CanvasRenderingContext2D;

export const FARM_ARRIVALS = ["sun", "saucer", "walk"] as const;
export const FARM_EXITS = ["sun", "saucer", "lantern", "monster", "walk"] as const;
export type FarmArrival = (typeof FARM_ARRIVALS)[number];
export type FarmExit = (typeof FARM_EXITS)[number];

/** Something playing out over the farm: drawn each frame until its time is up. */
export interface FarmShow {
  readonly t0: number;
  readonly dur: number;
  /** A visitor (not someone coming or going): dropped at once when the farm must be quiet. */
  readonly visitor?: true;
  draw(ctx: Ctx, t: number): void;
  /** Called once when it's over, or cut short. */
  end?(): void;
}

/** What the stage's parts share. */
export interface FarmBoard {
  world(): FarmWorld | null;
  random(): number;
  /** Everything playing now; add to it to start something. */
  readonly shows: FarmShow[];
}

export interface FarmComings {
  /** Before the sim steps: choose how each newcomer arrives and each finished worker leaves. */
  before(now: number): void;
  /** The saucer on its rounds, and whoever is waiting for it. */
  draw(ctx: Ctx, now: number): void;
  busy(): boolean;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const easeInOut = (k: number): number => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

/** An art with its bottom-centre at (x, y). */
export function stamp(ctx: Ctx, a: Art, x: number, y: number): void {
  ctx.drawImage(artCanvas(a), Math.round(x - a.w / 2), Math.round(y - a.h));
}

/** A farm critter and its shadow, feet at (x, y), `lift` pixels off the ground. */
function critter(
  ctx: Ctx,
  id: string,
  x: number,
  y: number,
  facing: 1 | -1,
  step: 0 | 1 = 0,
  lift = 0,
): void {
  if (lift < 3) shadow(ctx, x, y + 1, 7, 1, 0.3);
  drawFarmCritter(ctx, id, x, y - lift, facing, step);
}

/** A speech bubble over a critter standing at (x, y). */
const say = (ctx: Ctx, text: string, x: number, y: number, width: number): void =>
  drawBubble(ctx, text, x, y - 19, width);

/** Everyone on the farm says `text` (a gasp, a cheer). */
export function everyoneSays(board: FarmBoard, text: () => string, now: number, ms = 900): void {
  for (const a of board.world()?.actors.values() ?? []) {
    if (a.offstage || a.state === "leaving" || a.state === "arriving") continue;
    a.bubble = { text: text(), until: now + ms };
  }
}

/** The saucer hovering at (x, y) over ground at `groundY`, its beam `beam` (0–1) strong. */
export function drawSaucer(
  ctx: Ctx,
  x: number,
  y: number,
  t: number,
  beam: number,
  groundY: number,
): void {
  shadow(ctx, x, groundY + 1, 11, 1, 0.22);
  if (beam > 0) {
    // The beam widens toward the ground, in dithered bands.
    const top = Math.round(y - 3);
    const tall = Math.round(groundY - top);
    for (let yy = 0; yy < tall; yy++) {
      const half = Math.round(3 + (yy / tall) * 7);
      for (let dx = -half; dx <= half; dx++) {
        const px = Math.round(x + dx);
        const py = top + yy;
        if (bayerAt(px, py) >= (py % 4 < 2 ? 0.75 : 0.45) * beam) continue;
        ctx.fillStyle = Math.abs(dx) < 2 ? "#e9ffff" : "#7df9ff";
        ctx.fillRect(px, py, 1, 1);
      }
    }
  }
  const frames = art().ufo;
  stamp(ctx, frames[Math.floor(t / 150) % 2 ? 1 : 0], x, y + (Math.floor(t / 350) % 2));
}

/** How high the saucer hovers over whoever it has come for. */
const HOVER = 44;
/** How long it takes to set someone down or lift them away. */
const WORK_MS = 1350;

export function makeFarmComings(
  board: FarmBoard,
  pins: { readonly arrival?: FarmArrival; readonly exit?: FarmExit },
): FarmComings {
  const A = art();
  const mapWidth = (): number => board.world()?.farm.width ?? 480;
  const pick = <T>(list: readonly T[], avoid: T | null): T => {
    const pool = list.filter((v) => v !== avoid);
    return pool[Math.floor(board.random() * pool.length)] ?? (list[0] as T);
  };

  // ── The saucer: one at a time, working through whoever is waiting ──
  interface Job {
    readonly kind: "in" | "out";
    readonly x: number;
    readonly y: number;
    readonly id: string;
    readonly facing: 1 | -1;
    /** Who steps back onto the farm once they're set down. */
    readonly actor?: Actor;
  }
  interface Point {
    readonly x: number;
    readonly y: number;
  }
  let run: {
    phase: "in" | "move" | "work" | "out";
    at: number;
    from: Point;
    pos: Point;
    groundY: number;
    readonly jobs: Job[];
    readonly ms: number;
  } | null = null;
  /** Just past whichever side of the map is nearer to x. */
  const edgeX = (x: number): number => (x < mapWidth() / 2 ? -34 : mapWidth() + 34);
  const flightMs = (a: Point, b: Point): number =>
    Math.max(700, Math.hypot(b.x - a.x, b.y - a.y) / 0.26);

  function callSaucer(job: Job, now: number): void {
    if (run) {
      run.jobs.push(job);
      return;
    }
    // It comes in over the nearer edge of the map, never out of thin air.
    const from = { x: edgeX(job.x), y: job.y - HOVER - 30 };
    run = {
      phase: "in",
      at: now,
      from,
      pos: from,
      groundY: job.y,
      jobs: [job],
      ms: flightMs(from, { x: job.x, y: job.y - HOVER }),
    };
  }

  function drawSaucerRun(ctx: Ctx, now: number): void {
    const r = run;
    if (!r) return;
    const t = now - r.at;
    const job = r.jobs[0];
    const over = job ? { x: job.x, y: job.y - HOVER } : r.pos;
    const width = mapWidth();
    let beam = 0;
    // Whoever is still waiting to be picked up stands where they were.
    r.jobs.forEach((j, i) => {
      if (j.kind !== "out" || (i === 0 && r.phase === "work")) return;
      critter(ctx, j.id, j.x, j.y, j.facing);
      say(ctx, "!", j.x, j.y, width);
    });
    if (r.phase === "in" || r.phase === "move") {
      const ms = r.phase === "in" ? r.ms : 420;
      const k = easeInOut(clamp01(t / ms));
      r.pos = { x: r.from.x + (over.x - r.from.x) * k, y: r.from.y + (over.y - r.from.y) * k };
      if (job) r.groundY = job.y;
      if (t >= ms) {
        r.phase = job ? "work" : "out";
        r.at = now;
        r.from = r.pos;
      }
    } else if (r.phase === "work" && job) {
      const p = clamp01(t / WORK_MS);
      beam = p > 0.06 && p < 0.94 ? 1 : 0;
      const k = easeInOut(clamp01((p - 0.12) / 0.7));
      const lift = job.kind === "in" ? 30 * (1 - k) : 30 * k;
      if (lift < 26) critter(ctx, job.id, job.x, job.y, job.facing, 0, lift);
      if (p >= 1) {
        if (job.actor) {
          job.actor.offstage = false;
          job.actor.state = "idle";
          job.actor.stateAt = now;
        }
        r.jobs.shift();
        r.phase = r.jobs.length ? "move" : "out";
        r.at = now;
        r.from = r.pos;
      }
    } else if (r.jobs.length) {
      // Called back on its way out.
      r.phase = "move";
      r.at = now;
      r.from = r.pos;
    } else {
      // Away over the nearer edge of the map.
      const to = { x: edgeX(r.from.x), y: r.from.y - 36 };
      const ms = flightMs(r.from, to) * 0.8;
      const k = clamp01(t / ms) ** 2;
      r.pos = { x: r.from.x + (to.x - r.from.x) * k, y: r.from.y + (to.y - r.from.y) * k };
      if (t >= ms) {
        run = null;
        return;
      }
    }
    drawSaucer(ctx, r.pos.x, r.pos.y, now, beam, r.groundY);
  }

  // ── Arrivals ──
  function saucerIn(actor: Actor, now: number): void {
    // Aboard until it's set down: the sim leaves it alone meanwhile.
    actor.offstage = true;
    callSaucer(
      {
        kind: "in",
        x: actor.spot.x,
        y: actor.spot.y,
        id: actor.critterId,
        facing: actor.facing,
        actor,
      },
      now,
    );
  }
  function walkIn(actor: Actor, now: number): void {
    // Start off the edge of the map, on the road: the sim walks it in from there.
    actor.spot = { x: -12, y: actor.spot.y };
    actor.state = "idle";
    actor.stateAt = now;
  }

  // ── Departures: the worker comes off the sim and its leaving is played out here ──
  function takeOver(
    actor: Actor,
    now: number,
  ): { x: number; y: number; id: string; facing: 1 | -1 } {
    board.world()?.actors.delete(actor.key);
    // Mid-walk, it's taken from where it has got to.
    const at = actor.trip
      ? tripPose(actor.trip, now, actor.facing)
      : { ...actor.spot, facing: actor.facing };
    return { x: Math.round(at.x), y: Math.round(at.y), id: actor.critterId, facing: at.facing };
  }

  function saucerOut(actor: Actor, now: number): void {
    callSaucer({ kind: "out", ...takeOver(actor, now) }, now);
  }

  function lanternOut(actor: Actor, now: number): void {
    const { x, y, id, facing } = takeOver(actor, now);
    const width = mapWidth();
    const LIGHT_MS = 700;
    const dur = 4600;
    board.shows.push({
      t0: now,
      dur,
      draw(ctx, t) {
        const k = clamp01((t - LIGHT_MS) / (dur - LIGHT_MS));
        const rise = k ** 1.7 * (y + 50);
        const sway = t > LIGHT_MS ? Math.round(Math.sin(t / 520) * 3) : 0;
        const lx = x + 9 * facing + sway;
        const ly = y - 16 - rise;
        // Its glow, thinning out from the paper.
        for (let dy = -11; dy <= 9; dy++) {
          for (let dx = -10; dx <= 10; dx++) {
            const d = Math.hypot(dx, dy * 1.1) / 11;
            if (d >= 1) continue;
            const px = Math.round(lx + dx);
            const py = Math.round(ly - 6 + dy);
            if (bayerAt(px, py) >= (1 - d) * 0.5) continue;
            ctx.fillStyle = "#ffd98a";
            ctx.fillRect(px, py, 1, 1);
          }
        }
        critter(ctx, id, x + sway, y, facing, 0, rise);
        stamp(ctx, A.lantern, lx, ly);
        if (t < 900) say(ctx, "Bye!", x, y, width);
      },
    });
  }

  interface Runner {
    readonly x: number;
    readonly y: number;
    readonly id: string;
    /** When it bolts, ms into the chase. */
    readonly at: number;
  }
  let chase: { readonly t0: number; readonly runners: Runner[] } | null = null;
  function monsterOut(actor: Actor, now: number): void {
    const { x, y, id } = takeOver(actor, now);
    const WALK = 1300;
    const ROAR = 700;
    if (chase) {
      // Already one about: this one just runs for it too.
      chase.runners.push({ x, y, id, at: Math.max(now - chase.t0 + 350, WALK + ROAR) });
      return;
    }
    const width = mapWidth();
    const startX = Math.min(width + 20, x + 130);
    const stopX = x + 46;
    const mine = { t0: now, runners: [{ x, y, id, at: WALK + ROAR }] };
    chase = mine;
    let warned = false;
    board.shows.push({
      t0: now,
      dur: WALK + ROAR + ((stopX + 30) / 50) * 1000,
      draw(ctx, t) {
        const hunt = Math.max(0, t - WALK - ROAR);
        const mx = t < WALK ? startX + (stopX - startX) * (t / WALK) : stopX - (hunt / 1000) * 50;
        if (t > WALK && !warned) {
          warned = true;
          everyoneSays(board, () => "!", now + t);
        }
        for (const r of mine.runners) {
          const ran = Math.max(0, t - r.at);
          const cx = r.x - (ran / 1000) * 78;
          if (cx < -12) continue;
          const step = ran > 0 ? ((Math.floor(t / 110) % 2) as 0 | 1) : 0;
          critter(ctx, r.id, cx, r.y, ran > 0 ? -1 : 1, step, ran > 0 && step ? 1 : 0);
          if (ran === 0 && t > r.at - 600) say(ctx, "!", cx, r.y, width);
        }
        const moving = t < WALK || hunt > 0;
        const bob = moving && Math.floor(t / 170) % 2 ? 1 : 0;
        shadow(ctx, mx, y + 2, 12, 1, 0.3);
        stamp(ctx, A.monster[bob], mx, y + 3 - bob);
        if (t > WALK && hunt < 300) drawBubble(ctx, "RAWR!", mx, y - 27, width);
      },
      end() {
        if (chase === mine) chase = null;
      },
    });
  }

  function walkOut(actor: Actor, now: number): void {
    const { x, y, id } = takeOver(actor, now);
    const width = mapWidth();
    const WAVE = 700;
    board.shows.push({
      t0: now,
      dur: WAVE + ((x + 14) / 44) * 1000,
      draw(ctx, t) {
        const go = Math.max(0, t - WAVE);
        const cx = x - (go / 1000) * 44;
        const step = go > 0 ? ((Math.floor(t / 150) % 2) as 0 | 1) : 0;
        // A little bounce on the spot while it waves, then off down the road.
        critter(ctx, id, cx, y, go > 0 ? -1 : 1, step, go === 0 ? Math.floor(t / 160) % 2 : 0);
        if (t < WAVE + 400) say(ctx, "See ya!", cx, y, width);
      },
    });
  }

  let lastArrival: FarmArrival | null = null;
  let lastExit: FarmExit | null = null;
  /** Newcomers and leavers already dealt with, and how each finished worker will go. */
  const seen = new WeakSet<Actor>();
  const plan = new WeakMap<Actor, FarmExit>();

  function before(now: number): void {
    const w = board.world();
    if (!w) return;
    for (const actor of [...w.actors.values()]) {
      if (actor.coordinator || actor.offstage) continue;
      if (actor.state === "arriving" && !seen.has(actor)) {
        seen.add(actor);
        const style = pins.arrival ?? pick(FARM_ARRIVALS, lastArrival);
        lastArrival = style;
        if (style === "sun") continue;
        // Its hello was timed to the sunlight.
        actor.bubble = null;
        if (style === "saucer") saucerIn(actor, now);
        else walkIn(actor, now);
      } else if (actor.leaving && !plan.has(actor)) {
        // Finished: decide now how it goes. The saucer and the lantern take
        // it from where it stands; the rest happen at the gate. A failure
        // always goes the plain way.
        const style = actor.leaving === "error" ? "sun" : (pins.exit ?? pick(FARM_EXITS, lastExit));
        plan.set(actor, style);
        lastExit = style;
        if (style === "saucer") saucerOut(actor, now);
        else if (style === "lantern") lanternOut(actor, now);
      } else if (actor.state === "leaving" && !seen.has(actor)) {
        seen.add(actor);
        const style = plan.get(actor);
        if (style === "monster") monsterOut(actor, now);
        else if (style === "walk") walkOut(actor, now);
      } else if (!actor.leaving && actor.state !== "arriving") {
        // Back at work: it may arrive or leave again later.
        seen.delete(actor);
        plan.delete(actor);
      }
    }
  }

  return { before, draw: drawSaucerRun, busy: () => run !== null };
}
