// The life of a Goal's farm: one actor per agent, each a small state machine.
// Workers come in through the torii gate, travel along the yard's paths to
// the station for whatever they're doing, work there, gather at the tea bench
// by the fire when there's nothing to do, and say goodbye and leave through
// the gate when they finish. GG Goals (the coordinator) lives there for the
// whole goal. Time and randomness are passed in, so a farm replays the same
// way in tests.

import { pickFarmCritter } from "./goal-farm-critters";
import { pickWorkLine } from "./goal-farm-lines";
import type { KenMark } from "./goal-ken-status";
import type { WorkKind, WorldAgent } from "./goal-world-agents";
import { STATION_FOR, type StationKind } from "./goal-world-stations";
import type { Farm } from "./goal-farm-map";
import {
  createRouter,
  planTrip,
  tripPose,
  type Router,
  type Spot,
  type Trip,
} from "./goal-farm-travel";

export type ActorState = "arriving" | "moving" | "working" | "idle" | "leaving";

export interface Bubble {
  readonly text: string;
  readonly until: number;
}

export interface Actor {
  readonly key: string;
  readonly critterId: string;
  readonly coordinator: boolean;
  name: string;
  /** What its agent is doing, in words ("Reading app.ts"): shown when it's poked. */
  detail: string;
  state: ActorState;
  stateAt: number;
  /** Where its feet are (where its current trip started, while moving). */
  spot: Spot;
  trip: Trip | null;
  facing: 1 | -1;
  /** The station it is at or heading to, and its place there. */
  station: StationKind;
  slot: number;
  /** What it does once it gets there (null: lounging). */
  doing: WorkKind | null;
  /** The latest work it was given. */
  want: WorkKind | null;
  wantAt: number;
  leaving: "done" | "error" | null;
  bubble: Bubble | null;
  /** GG Goals only: the thought mark over its head, when nothing is being said. */
  mark: KenMark | null;
  reply: { readonly text: string; readonly at: number } | null;
  /** The last thing it said about its work, and when (so it never repeats itself or chatters). */
  lastLine: string | null;
  lastLineAt: number;
  /**
   * Off the farm for a moment (aboard the saucer on its way in, or GG Goals
   * away seeing a monster off; see goal-farm-stage.ts): it keeps its place but
   * isn't stepped, drawn or poked until it's back.
   */
  offstage?: boolean;
}

export interface FarmWorld {
  farm: Farm;
  router: Router;
  readonly actors: Map<string, Actor>;
  nextChatAt: number;
  /** When someone last said hello at the gate, so greetings don't pile up. */
  lastGreetAt: number;
  /** When anyone last said what they're off to do, so the farm doesn't chatter. */
  lastWorkLineAt: number;
  /** False until the first sync: agents already at work then are placed, not walked in. */
  started: boolean;
  readonly random: () => number;
}

/** How long being summoned in at the gate takes (see drawSummon). */
export const ARRIVE_MS = 1300;
/** A moment at the gate, then the summon in reverse. */
export const LEAVE_MS = 1700;
/** How often a newcomer says hello (and how often one says goodbye). */
const GREET_CHANCE = 0.3;
/** Nobody greets within this long of the last greeting. */
const GREET_GAP_MS = 6000;
const GREETINGS = ["Hi!", "Hello!", "Here to help!", "On it!", "Morning!"] as const;
const GOODBYES = ["Done. Bye!", "All done!", "See ya!"] as const;
const GOODBYE_MS = 800;
/**
 * A critter stays at a station at least this long before heading to its next
 * job, so you see it work; agents switch tools every second or two, and a
 * critter chasing every switch would dash about the farm.
 */
export const MIN_WORK_MS = 4000;
const BUBBLE_MS = 1600;
/** GG Goals is always a little Ken, never a worker's critter (the notice shows him too). */
export const COORDINATOR_CRITTER = "ken";

const CHAT_LINES = [
  ["Tea?", "Always."],
  ["Nice work!", "Thanks!"],
  ["Almost there.", "Let's go!"],
  ["Need a hand?", "All good!"],
  ["Ship it?", "Soon!"],
  ["Big one today.", "We got this."],
  ["Lovely fire.", "Mm."],
] as const;

export function createFarmWorld(farm: Farm, random: () => number): FarmWorld {
  return {
    farm,
    router: createRouter(farm.paths, farm.walk),
    actors: new Map(),
    nextChatAt: 0,
    lastGreetAt: -Infinity,
    lastWorkLineAt: -Infinity,
    started: false,
    random,
  };
}

function stationFor(actor: Pick<Actor, "leaving" | "want">): StationKind {
  if (actor.leaving) return "door";
  return actor.want ? STATION_FOR[actor.want] : "lounge";
}

/**
 * The first place at `station` where nobody else stands or is headed: checked
 * by the spot itself, across every station, since a busy station's extras
 * borrow other stations' places (see spotAt).
 */
function freeSlot(world: FarmWorld, actor: Actor, station: StationKind): number {
  const held = [...world.actors.values()]
    .filter((other) => other.key !== actor.key)
    .map((other) => spotAt(world.farm, other.station, other.slot));
  const free = (spot: Spot): boolean =>
    held.every((h) => Math.abs(h.x - spot.x) >= 6 || Math.abs(h.y - spot.y) >= 4);
  const limit = Object.values(world.farm.stations).reduce((n, spots) => n + spots.length, 0);
  for (let slot = 0; slot < limit; slot++) {
    if (free(spotAt(world.farm, station, slot))) return slot;
  }
  // Everywhere is full (a huge crowd): share, starting from the station's own spots.
  return held.length % Math.max(1, world.farm.stations[station].length);
}

/**
 * Where slot `slot` stands at `station`. Every slot the farm plans is clear
 * of everything drawn and apart from every other, so critters never stand on
 * top of each other or behind something. Past a station's own slots (a very
 * busy station), the extras take the nearest free slots of the other
 * stations, in order of distance, so they still stand somewhere sensible.
 */
export function spotAt(farm: Farm, station: StationKind, slot: number): Spot {
  const spots = farm.stations[station];
  const named = spots[slot];
  if (named) return named;
  const base = spots[0] ?? farm.origin;
  const spare = (Object.keys(farm.stations) as StationKind[])
    .filter((kind) => kind !== station)
    .flatMap((kind) => farm.stations[kind])
    .sort(
      (a, b) =>
        Math.hypot(a.x - base.x, a.y - base.y) - Math.hypot(b.x - base.x, b.y - base.y) ||
        a.x - b.x ||
        a.y - b.y,
    );
  return spare[(slot - spots.length) % Math.max(1, spare.length)] ?? base;
}

function say(actor: Actor, text: string, now: number, ms = BUBBLE_MS): void {
  actor.bubble = { text, until: now + ms };
}

/** How often a critter says what it's off to do when it gets a new job (GG Goals more often). */
const WORK_LINE_CHANCE = 0.45;
const KEN_LINE_CHANCE = 0.65;
/** A critter says nothing new about its work within this long of its last line. */
const WORK_LINE_GAP_MS = 9000;
/** Nobody on the farm speaks up about their work within this long of anyone else. */
const FARM_LINE_GAP_MS = 2200;
/** How long a line about the work stays up. */
const WORK_LINE_MS = 2200;

/**
 * Now and then, a critter given a new job says out loud what it's off to do
 * ("I need to read some things first!"): never the detail, never the same
 * line twice in a row, never on top of something it's already saying, and
 * spaced out across the farm so it doesn't chatter.
 */
function sayWhatsNext(world: FarmWorld, actor: Actor, kind: WorkKind, now: number): void {
  if (actor.bubble || actor.leaving || actor.state === "arriving") return;
  if (now - actor.lastLineAt < WORK_LINE_GAP_MS) return;
  if (now - world.lastWorkLineAt < FARM_LINE_GAP_MS) return;
  if (world.random() >= (actor.coordinator ? KEN_LINE_CHANCE : WORK_LINE_CHANCE)) return;
  const line = pickWorkLine(actor.coordinator, kind, world.random(), actor.lastLine);
  actor.lastLine = line;
  actor.lastLineAt = now;
  world.lastWorkLineAt = now;
  say(actor, line, now, WORK_LINE_MS);
}

function pickLine(lines: readonly string[], roll: number): string {
  return lines[Math.min(lines.length - 1, Math.floor(roll * lines.length))] ?? lines[0] ?? "";
}

function coordinatorOf(world: FarmWorld): Actor | undefined {
  return [...world.actors.values()].find((actor) => actor.coordinator);
}

function spawn(world: FarmWorld, agent: WorldAgent, now: number): Actor {
  const taken = new Set([...world.actors.values()].map((actor) => actor.critterId));
  const critterId = agent.coordinator
    ? COORDINATOR_CRITTER
    : pickFarmCritter(agent.agentName, agent.key, new Set([...taken, COORDINATOR_CRITTER])).id;
  const actor: Actor = {
    key: agent.key,
    critterId,
    coordinator: agent.coordinator,
    name: agent.name,
    detail: agent.detail,
    state: "idle",
    stateAt: now,
    spot: world.farm.origin,
    trip: null,
    facing: 1,
    station: "lounge",
    slot: 0,
    doing: null,
    want: agent.status === "working" ? agent.kind : null,
    wantAt: now,
    leaving: null,
    bubble: null,
    mark: null,
    reply: null,
    lastLine: null,
    lastLineAt: -Infinity,
  };
  world.actors.set(actor.key, actor);
  const arriving = world.started && !agent.coordinator;
  actor.station = arriving ? "door" : stationFor(actor);
  actor.slot = freeSlot(world, actor, actor.station);
  actor.spot = spotAt(world.farm, actor.station, actor.slot);
  if (arriving) {
    actor.state = "arriving";
    // Now and then a hello (never two close together), and only sometimes a welcome back.
    if (now - world.lastGreetAt >= GREET_GAP_MS && world.random() < GREET_CHANCE) {
      world.lastGreetAt = now;
      say(actor, pickLine(GREETINGS, world.random()), now, BUBBLE_MS + ARRIVE_MS * 0.5);
      const coordinator = coordinatorOf(world);
      if (coordinator && !coordinator.reply && world.random() < 0.5) {
        coordinator.reply = { text: "Welcome!", at: now + ARRIVE_MS * 0.5 + 500 };
      }
    }
  } else {
    actor.doing = actor.want;
    actor.state = actor.doing ? "working" : "idle";
  }
  return actor;
}

/** Bring the farm in line with the current agents. Cheap; call on every change. */
export function syncFarm(world: FarmWorld, agents: readonly WorldAgent[], now: number): void {
  const seen = new Set<string>();
  for (const agent of agents) {
    seen.add(agent.key);
    const finished = agent.status === "done" || agent.status === "error";
    let actor = world.actors.get(agent.key);
    // Handed new work after it finished (a follow-up): if it's already gone
    // out of the gate, it walks back in as a new arrival; if it was still on
    // its way out, it turns round and gets back to it.
    if (actor?.leaving && agent.status === "working") {
      if (actor.state === "leaving") {
        world.actors.delete(actor.key);
        actor = undefined;
      } else {
        actor.leaving = null;
      }
    }
    if (!actor) {
      // Someone who finished before the farm saw them has nothing to act out.
      if (finished) continue;
      actor = spawn(world, agent, now);
    }
    actor.name = agent.name;
    actor.detail = agent.detail;
    actor.mark = agent.mark ?? null;
    const want = agent.status === "working" ? agent.kind : null;
    if (want !== actor.want) {
      actor.want = want;
      actor.wantAt = now;
      if (want) sayWhatsNext(world, actor, want, now);
    }
    if (finished && !actor.coordinator && !actor.leaving) {
      actor.leaving = agent.status === "error" ? "error" : "done";
    }
  }
  for (const actor of world.actors.values()) {
    if (!seen.has(actor.key) && !actor.coordinator && !actor.leaving) actor.leaving = "done";
  }
  world.started = true;
}

/**
 * A new farm (the view resized, so the countryside grew or shrank): everyone
 * settles where they were headed. The farmstead may have moved on the map.
 */
export function resizeFarm(world: FarmWorld, farm: Farm): void {
  world.farm = farm;
  world.router = createRouter(farm.paths, farm.walk);
  for (const actor of world.actors.values()) {
    actor.trip = null;
    actor.spot = spotAt(farm, actor.station, actor.slot);
    if (actor.state === "moving") actor.state = actor.doing ? "working" : "idle";
  }
}

function startLeaving(world: FarmWorld, actor: Actor, now: number): void {
  actor.state = "leaving";
  actor.stateAt = now;
  actor.doing = null;
  // A failure always says so; a finished worker only sometimes says goodbye.
  if (actor.leaving === "error") say(actor, "Oops. Bye!", now, GOODBYE_MS + 200);
  else if (world.random() < GREET_CHANCE) {
    say(actor, pickLine(GOODBYES, world.random()), now, GOODBYE_MS + 200);
    const coordinator = coordinatorOf(world);
    if (coordinator && !coordinator.reply) coordinator.reply = { text: "Thanks!", at: now + 500 };
  }
}

function settle(actor: Actor, now: number, farm?: Farm): void {
  const doing = actor.want;
  // Turn to face what this station is for (the books, the laptop, the water).
  const look = farm?.lookAt[actor.station];
  if (look && Math.abs(look.x - actor.spot.x) > 2) actor.facing = look.x > actor.spot.x ? 1 : -1;
  const next: ActorState = doing ? "working" : "idle";
  if (actor.state !== next || actor.doing !== doing) {
    actor.state = next;
    actor.stateAt = now;
  }
  actor.doing = doing;
}

/**
 * Advance every actor to `now`. With `instant` (reduced motion, a background
 * window) nobody travels: they appear where they're going.
 */
export function stepFarm(world: FarmWorld, now: number, instant = false): void {
  for (const actor of [...world.actors.values()]) {
    if (actor.offstage) continue;
    if (actor.trip) {
      const pose = tripPose(actor.trip, now, actor.facing);
      actor.facing = pose.facing;
      if (!pose.done && !instant) continue;
      actor.spot = actor.trip.to;
      actor.trip = null;
      actor.state = "idle";
      actor.stateAt = now;
    }
    if (actor.state === "arriving") {
      if (now - actor.stateAt < ARRIVE_MS && !instant) continue;
      actor.state = "idle";
      actor.stateAt = now;
    }
    if (actor.state === "leaving") {
      if (now - actor.stateAt >= LEAVE_MS || instant) world.actors.delete(actor.key);
      continue;
    }
    // Give a working critter a moment at its station before moving on.
    const target = stationFor(actor);
    if (
      actor.state === "working" &&
      !actor.leaving &&
      target !== actor.station &&
      now - actor.stateAt < MIN_WORK_MS &&
      !instant
    ) {
      continue;
    }
    if (target !== actor.station) {
      actor.station = target;
      actor.slot = freeSlot(world, actor, target);
    }
    const goal = spotAt(world.farm, actor.station, actor.slot);
    const there = Math.hypot(goal.x - actor.spot.x, goal.y - actor.spot.y) < 1;
    if (there || instant) {
      if (!there) {
        actor.facing = goal.x >= actor.spot.x ? 1 : -1;
        actor.spot = goal;
      }
      if (actor.leaving) startLeaving(world, actor, now);
      else settle(actor, now, world.farm);
      continue;
    }
    actor.trip = planTrip(world.router.route(actor.spot, goal), { now });
    actor.state = "moving";
    actor.stateAt = now;
  }
  chatter(world, now);
  for (const actor of world.actors.values()) {
    if (actor.bubble && actor.bubble.until <= now) actor.bubble = null;
    if (actor.reply && actor.reply.at <= now) {
      say(actor, actor.reply.text, now);
      actor.reply = null;
    }
  }
}

/** Critters lounging by the fire chat now and then; a lone one sips its tea. */
function chatter(world: FarmWorld, now: number): void {
  if (now < world.nextChatAt) return;
  world.nextChatAt = now + 3500 + world.random() * 3500;
  const lounging = [...world.actors.values()]
    .filter(
      (actor) =>
        actor.state === "idle" && actor.station === "lounge" && !actor.bubble && !actor.offstage,
    )
    .sort((a, b) => a.key.localeCompare(b.key));
  if (lounging.length >= 2) {
    const first = Math.floor(world.random() * lounging.length);
    const a = lounging[first];
    const b = lounging[(first + 1) % lounging.length];
    const line = CHAT_LINES[Math.floor(world.random() * CHAT_LINES.length)] ?? CHAT_LINES[0];
    if (!a || !b) return;
    say(a, line[0], now);
    a.facing = b.spot.x >= a.spot.x ? 1 : -1;
    b.facing = a.spot.x >= b.spot.x ? 1 : -1;
    b.reply = { text: line[1], at: now + 1100 };
  } else if (lounging.length === 1 && world.random() < 0.35) {
    const only = lounging[0];
    if (only) say(only, "*sip*", now, 1100);
  }
}

/** True while anyone is travelling, arriving or leaving: worth drawing smoothly. */
export function farmIsMoving(world: FarmWorld): boolean {
  for (const actor of world.actors.values()) {
    if (actor.offstage) continue;
    if (actor.trip || actor.state === "arriving" || actor.state === "leaving") return true;
  }
  return false;
}
