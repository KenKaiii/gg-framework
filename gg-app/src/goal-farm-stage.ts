// The Goal farm's stage: what's drawn over the farm's own frame. A name tag
// for whoever the pointer is on (goal-farm-tag.ts), more ways for workers to
// arrive and leave (goal-farm-comings.ts), and visitors: a saucer after a
// daikon, a monster at the gate, Ken seeing one off (goal-farm-visitors.ts).
// It nudges the sim's actors and draws on top; the farm itself is untouched.
//
// With reduced motion only the tag is left: GoalWorld doesn't call `before`,
// and asks `draw` for the tag alone.

import {
  makeFarmComings,
  type FarmArrival,
  type FarmBoard,
  type FarmExit,
  type FarmShow,
} from "./goal-farm-comings";
import type { FarmPlay } from "./goal-farm-interact";
import type { FarmWorld } from "./goal-farm-sim";
import { drawFarmTag, type FarmView } from "./goal-farm-tag";
import { FARM_VISITORS, makeFarmVisitors, type FarmVisitor } from "./goal-farm-visitors";

type Ctx = CanvasRenderingContext2D;

export interface FarmStageOptions {
  /** Injected for tests; defaults to Math.random. */
  readonly random?: () => number;
  /**
   * True while something over the farm needs the user (GG Goals' question,
   * the finish card): no visitor starts, and one that's about is cut short.
   */
  readonly quiet?: () => boolean;
  /** Everyone arrives / leaves this way (tests and previews); varied when unset. */
  readonly arrival?: FarmArrival;
  readonly exit?: FarmExit;
  /** false: nobody visits. A list: only those do. */
  readonly visitors?: boolean | readonly FarmVisitor[];
}

export interface FarmStage {
  /** Before the sim steps: choose how workers come and go, and let visitors in. */
  before(now: number): void;
  /** After the farm's frame. With `tagOnly` (reduced motion), nothing but the tag. */
  draw(ctx: Ctx, now: number, play: FarmPlay, view: FarmView, tagOnly?: boolean): void;
  /** A click on a critter keeps its tag up for a moment. */
  pin(key: string, now: number): void;
  /** Something is playing that wants the smooth frame rate. */
  busy(): boolean;
}

/** A clicked critter's tag stays up this long. */
const PIN_MS = 2600;
/** The first visitor comes this long after the farm appears; then every 26–46s. */
const FIRST_VISIT_MS = 12_000;
const VISIT_GAP_MS = 26_000;
const VISIT_SPREAD_MS = 20_000;
/** How often each visitor comes, relative to the others. */
const VISIT_WEIGHT: Readonly<Record<FarmVisitor, number>> = { flyover: 45, monster: 30, ken: 25 };

export function makeFarmStage(
  world: () => FarmWorld | null,
  options: FarmStageOptions = {},
): FarmStage {
  const random = options.random ?? Math.random;
  const shows: FarmShow[] = [];
  const board: FarmBoard = { world, random, shows };
  const comings = makeFarmComings(board, options);
  const visitors = makeFarmVisitors(board);
  const allowed: readonly FarmVisitor[] =
    options.visitors === false
      ? []
      : Array.isArray(options.visitors)
        ? options.visitors
        : FARM_VISITORS;
  let nextVisitAt: number | null = null;
  let pinned: { key: string; until: number } | null = null;

  /** GG Goals is asking the user something, or a sign is up over the farm. */
  function quiet(): boolean {
    if (options.quiet?.()) return true;
    for (const actor of world()?.actors.values() ?? []) {
      if (actor.coordinator && actor.want === "ask") return true;
    }
    return false;
  }

  function drop(show: FarmShow): void {
    const at = shows.indexOf(show);
    if (at >= 0) shows.splice(at, 1);
    show.end?.();
  }

  function pickVisitor(): FarmVisitor | undefined {
    let roll = random() * allowed.reduce((sum, v) => sum + VISIT_WEIGHT[v], 0);
    for (const v of allowed) {
      roll -= VISIT_WEIGHT[v];
      if (roll <= 0) return v;
    }
    return allowed[allowed.length - 1];
  }

  function before(now: number): void {
    comings.before(now);
    nextVisitAt ??= now + FIRST_VISIT_MS;
    if (quiet()) {
      for (const show of [...shows]) if (show.visitor) drop(show);
      // And nobody turns up the moment the user is done, either.
      nextVisitAt = Math.max(nextVisitAt, now + FIRST_VISIT_MS);
      return;
    }
    // One thing at a time: nobody visits while someone is coming or going.
    if (now < nextVisitAt || shows.length > 0 || comings.busy()) return;
    nextVisitAt = now + VISIT_GAP_MS + random() * VISIT_SPREAD_MS;
    const visitor = pickVisitor();
    if (visitor) visitors.start(visitor, now);
  }

  function draw(ctx: Ctx, now: number, play: FarmPlay, view: FarmView, tagOnly = false): void {
    if (!tagOnly) {
      comings.draw(ctx, now);
      for (const show of [...shows]) {
        const t = now - show.t0;
        if (t >= show.dur) drop(show);
        else show.draw(ctx, Math.max(0, t));
      }
    }
    const w = world();
    if (!w) return;
    if (pinned && now > pinned.until) pinned = null;
    const over = play.hovered?.startsWith("critter:") ? play.hovered.slice(8) : null;
    const actor = w.actors.get(over ?? pinned?.key ?? "");
    if (!actor || actor.offstage || actor.state === "arriving" || actor.state === "leaving") return;
    drawFarmTag(ctx, actor, now, play, view);
  }

  return {
    before,
    draw,
    pin(key, now) {
      pinned = { key, until: now + PIN_MS };
    },
    busy: () => shows.length > 0 || comings.busy(),
  };
}
