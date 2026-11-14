// Things on the Goal farm coming alive while critters use them: the laptop's
// screen scrolls for a critter on the web, a book slides out for one reading,
// the bench is hammered for one editing. Each plays one of its poke
// reactions; another starts only once that one has finished and someone is
// still there, so a crowded station never restarts its animation, and a
// poke still plays over it. Quiet by design: no speech bubbles, nothing
// knocked loose, nothing said to screen readers.

import type { FarmWorld } from "./goal-farm-sim";
import type { Farm, Thing } from "./goal-farm-map";
import {
  startUse,
  reactionOn,
  type FarmPlay,
  type Reaction,
  type ThingKind,
} from "./goal-farm-interact";
import type { StationKind } from "./goal-world-stations";

/** What each station's thing does while it's in use, in the order it cycles through. */
export const STATION_USES: Readonly<
  Record<StationKind, { readonly kind: ThingKind; readonly actions: readonly string[] }>
> = {
  bookcase: { kind: "bookcase", actions: ["book", "dust"] },
  computer: { kind: "laptop", actions: ["wake"] },
  workbench: { kind: "bench", actions: ["hammer", "saw"] },
  machine: { kind: "stove", actions: ["puff", "flare"] },
  whiteboard: { kind: "board", actions: ["note", "flutter"] },
  mailbox: { kind: "postbox", actions: ["flag", "letter"] },
  maptable: { kind: "creel", actions: ["flop"] },
  lounge: { kind: "teabench", actions: ["steam"] },
  door: { kind: "torii", actions: ["glimmer"] },
};

/**
 * The thing each station's critters use: the one of its kind nearest where
 * they look (Farm.lookAt). Stations with nothing of that kind are left out.
 */
export function stationThings(farm: Farm): ReadonlyMap<StationKind, Thing> {
  const out = new Map<StationKind, Thing>();
  for (const station of Object.keys(STATION_USES) as StationKind[]) {
    const look = farm.lookAt[station];
    let best: Thing | undefined;
    let bestD = Infinity;
    for (const t of farm.things) {
      if (t.kind !== STATION_USES[station].kind) continue;
      const d = Math.hypot(t.x + t.buf.width / 2 - look.x, t.base - look.y);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    if (best) out.set(station, best);
  }
  return out;
}

/**
 * Stations someone is using right now: a critter settled there at work, or
 * (the lounge) sitting waiting for more. Not one passing through, arriving
 * or leaving.
 */
export function stationsInUse(world: FarmWorld): ReadonlySet<StationKind> {
  const out = new Set<StationKind>();
  for (const actor of world.actors.values()) {
    if (actor.trip || actor.leaving || actor.offstage) continue;
    if (actor.state === "working" || (actor.state === "idle" && actor.station === "lounge")) {
      out.add(actor.station);
    }
  }
  return out;
}

/**
 * Start the next use on every thing in use that isn't already playing
 * something (a use or a poke). Sorted by station, so the same farm plays the
 * same way. Returns the uses started (for their sounds).
 */
export function playUses(
  play: FarmPlay,
  things: ReadonlyMap<StationKind, Thing>,
  inUse: ReadonlySet<StationKind>,
  now: number,
): readonly Reaction[] {
  const started: Reaction[] = [];
  for (const station of [...inUse].sort()) {
    const t = things.get(station);
    if (!t || reactionOn(play, t.id, now)) continue;
    const key = `use:${t.id}`;
    const turn = play.turns.get(key) ?? 0;
    play.turns.set(key, turn + 1);
    const { actions } = STATION_USES[station];
    const action = actions[turn % actions.length];
    if (!action) continue;
    started.push(
      startUse(
        play,
        { target: t.id, kind: t.kind, x: t.x + t.buf.width / 2, y: t.base },
        action,
        now,
      ),
    );
  }
  return started;
}

/**
 * Does a thing in use need drawing faster than the idle rate (a hammer, a
 * scrolling screen)? Not the tea bench's slow steam: Ken waits there
 * whenever nothing's happening, and an idle farm stays at its idle rate.
 */
export function usesNeedPace(play: FarmPlay, now: number): boolean {
  return play.reactions.some((r) => r.use === true && r.kind !== "teabench" && now < r.until);
}
