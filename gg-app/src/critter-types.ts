// Shared runtime types for the critter floor: the live Critter object the
// engine (critter-floor.ts) owns, and the Api it hands to the behaviour
// modules (critter-work / -idle / -social / -scare). Behaviour modules only
// see the Api, never the engine's internals.

import type { CritterDef } from "./critter-sprites";
import type { CritterFx } from "./critter-fx";
import type { FloorAgent } from "./critter-floor";
import type { ToolKind } from "./critter-tool-kind";

/** Who may interrupt whom: a higher number cancels a lower one. */
export const PRIO = {
  free: 0,
  idle: 1,
  work: 2,
  social: 3,
  event: 4,
  scare: 5,
  gone: 9,
} as const;
export type Priority = (typeof PRIO)[keyof typeof PRIO];

/** What a critter acts out: a real tool kind, or "think" between tools. */
export type JobKind = ToolKind | "think";

export interface Job {
  readonly kind: JobKind;
  /** When the work action started (performance.now()). */
  startedAt: number;
  /** When the work loop should wrap up. Mutable: more of the same tool
   *  extends it; a different tool pulls it in (never below minEndAt). */
  endAt: number;
  /** Earliest allowed end, so rapid tool calls don't make the critter jitter. */
  minEndAt: number;
  /** Set once the work loop has exited and the action is in its outro. */
  winding: boolean;
}

export type CritterMode = "summon" | "script" | "pause" | "walk" | "flee";

/** What to do when the current script releases the critter. */
export interface NextMove {
  readonly dir?: 1 | -1;
  /** Seconds of fleeing in `dir`. */
  readonly flee?: number;
  /** Walk on, passing behind the other critter. */
  readonly behind?: boolean;
}

export interface Tween {
  from: number;
  to: number;
  /** Start time; shifted forward by however long the floor sat paused. */
  t0: number;
  readonly ms: number;
  readonly ease: (k: number) => number;
  readonly walking: boolean;
  readonly token: number;
  readonly resolve: () => void;
}

export type TraitName = "chill" | "restless" | "chatty" | "shy" | "clumsy";

/** Anything pickVariant can remember its last picks on (a critter, a pair…). */
export interface VariantOwner {
  readonly recent: Map<string, string[]>;
}

/** One weighted variant of an action. */
export interface Variant {
  readonly id: string;
  /** Relative weight; a function lets it depend on the critter. */
  readonly w?: number | ((c: Critter) => number);
  /** Species-only (or otherwise conditional) variants. */
  readonly only?: (c: Critter) => boolean;
}

export interface Critter extends VariantOwner {
  readonly key: string;
  readonly def: CritterDef;
  readonly el: HTMLDivElement;
  /** Wrapper the reaction jolts and props/overlays live on. */
  readonly react: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly sil: HTMLImageElement;
  readonly shadow: HTMLDivElement;
  readonly startedAt: number;
  readonly trait: TraitName;
  agent: FloorAgent;
  x: number;
  y: number;
  dir: 1 | -1;
  target: number;
  mode: CritterMode;
  timer: number;
  frame: 0 | 1;
  frameT: number;
  phase: number;
  prio: Priority;
  /** Bumped whenever a script loses ownership of the critter. */
  token: number;
  hyped: boolean;
  hypedUntil: number;
  job: Job | null;
  pendingJob: Job | null;
  /** Kind of the last work action, so think → tool can play the eureka bulb. */
  lastKind: JobKind | null;
  /** When the last real tool activity arrived. */
  lastActivityAt: number;
  /** When the last think spell ended. */
  lastThinkAt: number;
  saidLong: boolean;
  lastAct: string;
  /** Leg-cycle frame interval (ms) while running in place; 0 = off. */
  legs: number;
  next: NextMove | null;
  /** Who it is walking over to meet. */
  seek: Critter | null;
  tween: Tween | null;
  /** Set once the critter is on its way out; it ignores further updates. */
  leaving: boolean;
  scareIndex: number;
}

export type Ok = () => boolean;
export type Script = (ok: Ok) => Promise<void>;

export interface Liveliness {
  readonly fidget: number;
  readonly seek: number;
  readonly bump: number;
  readonly trip: number;
  readonly gap: number;
}

/** What the engine gives every behaviour module. */
export interface CritterApi {
  readonly fx: CritterFx;
  /** Everyone currently on the floor (do not mutate). */
  readonly live: () => readonly Critter[];
  readonly lively: (c: Critter) => Liveliness;
  readonly pickVariant: <V extends Variant>(
    owner: VariantOwner,
    key: string,
    list: readonly V[],
    weightFn?: (v: V) => number,
    subject?: Critter,
  ) => V;
  /** Run a script on one critter if `prio` beats what it is doing. */
  readonly perform: (c: Critter, prio: Priority, fn: Script) => Promise<boolean>;
  /** Run a script owning two critters at once. */
  readonly performPair: (a: Critter, b: Critter, prio: Priority, fn: Script) => Promise<boolean>;
  readonly canAct: (c: Critter) => boolean;
  readonly isFree: (c: Critter) => boolean;
  readonly face: (c: Critter, dir: 1 | -1) => void;
  readonly clampX: (x: number) => number;
  readonly goTo: (c: Critter, x: number, mul?: number) => Promise<void>;
  readonly tweenX: (c: Critter, x: number, ms: number, ease?: EaseName) => Promise<void>;
  /** A small knock that doesn't interrupt whatever the critter is doing. */
  readonly jolt: (c: Critter, n?: number, dir?: number) => void;
  readonly floorWidth: () => number;
  readonly now: () => number;
}

export type EaseName = "linear" | "ease-in" | "ease-out" | "ease-in-out";

// ── The stage (critter-stage.ts): arrivals, exits and things that happen ──
export const ARRIVALS = [
  "beam",
  "ufo",
  "parachute",
  "burrow",
  "egg",
  "bird",
  "walk",
  "comet",
] as const;
export const EXITS = [
  "beam",
  "ufo",
  "monster",
  "balloon",
  "bird",
  "hole",
  "walk",
  "poof",
  "blast",
] as const;
export const HAPPENINGS = [
  "ufo-scan",
  "gift",
  "ball",
  "monster",
  "ken",
  "cloud",
  "conga",
  "star",
  "rps",
  "piggyback",
] as const;
export type ArrivalName = (typeof ARRIVALS)[number];
export type ExitName = (typeof EXITS)[number];
export type HappeningName = (typeof HAPPENINGS)[number];

export interface StageOptions {
  /** Everyone arrives this way (tests and previews); varied when unset. */
  readonly arrival?: ArrivalName;
  /** Everyone leaves this way; varied when unset. */
  readonly exit?: ExitName;
  /** false: nothing happens by itself. A list: only those do. */
  readonly happenings?: boolean | readonly HappeningName[];
  /** Open sky above the lane (the home screen): longer drops, higher jumps, monsters. */
  readonly tall?: boolean;
}
