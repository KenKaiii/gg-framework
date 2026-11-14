// The critter floor: sub-agents walk around on top of the pinned live region
// (tool panel / activity bar) as little pixel critters. This module owns the
// whole imperative side (DOM, per-frame movement, Web Animations effects) so
// React only re-renders when the agent list changes, never per frame.
//
// Lifecycle per agent: it arrives (a beam of light, a saucer, a parachute…) →
// acts out each real tool it runs (critter-work), fidgets between tools
// (critter-idle), notices the critters it crosses paths with (critter-social)
// → leaves once its work is finished (done, or idle and ready for follow-up),
// or tips over and fades when it fails while teammates check on it. A
// follow-up that sets an idle agent running again brings it back. Clicking a
// critter spooks it (critter-scare). How they arrive and leave, what they
// wear, the name tag and the things that happen to the floor are the stage's
// (critter-stage.ts); this engine only calls into it.
//
// Every behaviour runs as a "script" that owns the critter until it ends or
// something more important (higher PRIO) interrupts it; `ok()` turns false
// the moment the script loses ownership, so it stops at its next check.

import { discard, makeCritterFx, SIZE } from "./critter-fx";
import { makeCritterIdle } from "./critter-idle";
import { withEmotes } from "./critter-looks";
import { makeCritterScare } from "./critter-scare";
import { makeCritterSocial } from "./critter-social";
import { makeCritterStage } from "./critter-stage";
import { CRITTERS, pickCritter, renderCritterFrame } from "./critter-sprites";
import type { CritterDef, CritterMove } from "./critter-sprites";
import { toolKindOf } from "./critter-tool-kind";
import { PRIO } from "./critter-types";
import type {
  Critter,
  CritterApi,
  EaseName,
  Job,
  JobKind,
  Liveliness,
  Priority,
  Script,
  StageOptions,
  TraitName,
  Variant,
  VariantOwner,
} from "./critter-types";
import { makeCritterWork } from "./critter-work";
import { readMotionLevel, subscribeMotion } from "./window-motion";

export type FloorAgentStatus = "running" | "idle" | "done" | "error" | "interrupted";

/** One sub-agent as the floor sees it. Built from SubAgentLine by the caller. */
export interface FloorAgent {
  /** Stable identity across renders (one critter per key). */
  readonly key: string;
  /** Named agent type (e.g. "researcher"); picks the matching critter. */
  readonly agentName: string | undefined;
  /** Pin a specific critter (the home screen's roster); wins over agentName. */
  readonly critterId?: string;
  /** The name on its tag. */
  readonly label: string;
  readonly status: FloorAgentStatus;
  /** Latest humanized tool activity: drives the work action, shown on its tag. */
  readonly activity: string | undefined;
  /** Preformatted token readout (↑ · ↻ cached · ↓), or null before any usage. */
  readonly tokens: string | null;
  readonly durationMs: number | undefined;
  readonly toolUseCount: number;
}

export interface CritterFloorOptions {
  /** Honour prefers-reduced-motion: no wandering, beams or jumps; fades only. */
  readonly reducedMotion: boolean;
  /**
   * A showcase floor with no real agents behind it (the home screen): critters
   * never stop to "think" between tools, and the tag says what the critter
   * itself is up to instead of an agent's activity.
   */
  readonly ambient?: boolean;
  /** Called each time the lane opens from closed (the chat rolls a new terrain). */
  readonly onLaneOpen?: () => void;
  /**
   * How long after the lane starts opening the first critter lands. Floors
   * with a terrain wait for the ground to rise first. Defaults to the lane's
   * own open time.
   */
  readonly landAfterMs?: number;
  /**
   * How long the lane stays open ("closing") after the last critter leaves.
   * Floors with a terrain need longer, to pack the scenery away in order.
   */
  readonly closeAfterMs?: number;
  /** Injected for tests; defaults to Math.random. */
  readonly random?: () => number;
  /**
   * Whether an agent's critter was already on this floor before it was
   * rebuilt (the chat was hidden behind another view and shown again). Such a
   * critter is put straight back where it works, with no beam, greeting or
   * terrain reroll: it never left.
   */
  readonly wasHere?: (key: string) => boolean;
  /** Told when a critter lands on the floor (true) or leaves it for good (false). */
  readonly onPresence?: (key: string, here: boolean) => void;
  /** How the stage plays this floor (critter-stage.ts): pins, happenings, headroom. */
  readonly stage?: StageOptions;
}

export interface CritterFloorController {
  /** Reconcile the floor with the current agent list. Cheap; call on change. */
  sync(agents: readonly FloorAgent[]): void;
  /** Tear everything down (timers, frame loop, observers, DOM). */
  destroy(): void;
}

/** Wait for the lane to mostly open before the first critter lands. */
const LANE_OPEN_MS = 240;
const COLLAPSE_DELAY_MS = 450;
const SPAWN_GAP_MS = 220;
const SUMMON_MS = 900;
/** How long a restored lane keeps its transitions off, so its scenery doesn't replay. */
const RESTORE_SETTLE_MS = 60;
/** Every work action gets at least this long, so rapid tool calls don't jitter. */
const MIN_JOB_MS = 1200;
/** When a different tool arrives, the current action wraps up this soon after. */
const SWITCH_SOON_MS = 350;
/** No new tool for this long while running → the critter stops to think. */
const THINK_AFTER_MS = 6000;
const THINK_GAP_MS = 8000;
const THINK_MS = 4200;

const GREETINGS = [
  "Hi!",
  "Reporting in",
  "On it!",
  "*pop*",
  "Ready!",
  "Where am I?",
  "o/",
  "Let's go",
];
const FAREWELLS = [
  "Bye!",
  "Later!",
  "Done \u2713",
  "Off I go!",
  "Nailed it",
  "o/",
  "See ya!",
  "Peace \u270c",
];

/** Walk speed (px/s) and walk-frame interval per movement style. */
const MOVE: Readonly<Record<CritterMove, { speed: number; frameMs: number }>> = {
  walk: { speed: 26, frameMs: 170 },
  hop: { speed: 34, frameMs: 200 },
  hover: { speed: 30, frameMs: 70 },
  float: { speed: 18, frameMs: 260 },
  scuttle: { speed: 38, frameMs: 110 },
  squish: { speed: 16, frameMs: Number.POSITIVE_INFINITY },
};

/** How often things happen on the floor (the preview's "normal" setting). */
const LIVELY: Liveliness = { fidget: 0.42, seek: 0.12, bump: 0.75, trip: 0.015, gap: 1 };

interface Trait {
  readonly speed: number;
  readonly fidget: number;
  readonly seek: number;
  readonly bump: number;
  readonly trip: number;
}
// A personality per critter, rolled at summon, so two foxes don't act alike.
const TRAITS: Readonly<Record<TraitName, Trait>> = {
  chill: { speed: 0.85, fidget: 0.7, seek: 0.8, bump: 0.8, trip: 1 },
  restless: { speed: 1.2, fidget: 1.5, seek: 1, bump: 1, trip: 1 },
  chatty: { speed: 1, fidget: 1, seek: 2.4, bump: 1.15, trip: 1 },
  shy: { speed: 0.95, fidget: 1, seek: 0.25, bump: 0.45, trip: 1 },
  clumsy: { speed: 1.05, fidget: 1, seek: 1, bump: 1.4, trip: 5 },
};
const TRAIT_NAMES = Object.keys(TRAITS) as readonly TraitName[];

/** Base length of each kind of work action before it is stretched or cut. */
const JOB_MS: Readonly<Record<JobKind, number>> = {
  read: 2600,
  search: 3200,
  edit: 3000,
  run: 3000,
  web: 3400,
  think: THINK_MS,
};

const EASE: Readonly<Record<EaseName, (k: number) => number>> = {
  linear: (k) => k,
  "ease-in": (k) => k * k * k,
  "ease-out": (k) => 1 - (1 - k) ** 3,
  "ease-in-out": (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2),
};

interface SpriteSet {
  readonly f0: string;
  readonly f1: string;
  readonly sil: string;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

export function createCritterFloor(
  lane: HTMLElement,
  options: CritterFloorOptions,
): CritterFloorController {
  const random = options.random ?? Math.random;
  const reduced = options.reducedMotion;
  const ambient = options.ambient === true;
  const rand = (a: number, b: number): number => a + random() * (b - a);
  // The floor's own clock: it stops while the window rests (see "Resting"),
  // so jobs, tweens and pending timers resume where they left off instead of
  // all coming due at once on focus.
  let resting = false;
  let restedAt = 0;
  let restedTotal = 0;
  const now = (): number => (resting ? restedAt : performance.now()) - restedTotal;

  const floor = el("div", "critter-floor");
  lane.append(floor);

  const critters = new Map<string, Critter>();
  const pending = new Map<string, number>();
  const sprites = new Map<string, SpriteSet>();
  /** Script timers by our id; `handle` is the live setTimeout (0 while resting). */
  const timers = new Map<
    number,
    { readonly fn: () => void; readonly due: number; handle: number }
  >();
  let nextTimerId = 1;
  let latest = new Map<string, FloorAgent>();
  let floorWidth = lane.clientWidth;
  let laneReadyAt = 0;
  let nextSpawnAt = 0;
  let collapseTimer = 0;
  let rafId = 0;
  let lastFrameTs = 0;
  let destroyed = false;

  // Every script step, prop flicker and bubble timeout goes through `later`,
  // so freezing these timers freezes the floor's behaviour in one place.
  const arm = (id: number): void => {
    const entry = timers.get(id);
    if (!entry) return;
    entry.handle = window.setTimeout(
      () => {
        timers.delete(id);
        if (!destroyed) entry.fn();
      },
      Math.max(0, entry.due - now()),
    );
  };
  const later = (ms: number, fn: () => void): number => {
    const id = nextTimerId++;
    timers.set(id, { fn, due: now() + ms, handle: 0 });
    if (!resting) arm(id);
    return id;
  };
  const cancelLater = (id: number): void => {
    const entry = timers.get(id);
    if (entry) window.clearTimeout(entry.handle);
    timers.delete(id);
  };
  const live = (): readonly Critter[] => [...critters.values()];
  const clampX = (x: number): number => Math.max(4, Math.min(floorWidth - SIZE - 4, x));

  // Pixel emotes where the text badges were.
  const fx = withEmotes(makeCritterFx({ random, later, cancelLater, live }));

  const spritesFor = (def: CritterDef): SpriteSet => {
    const cached = sprites.get(def.id);
    if (cached) return cached;
    const set = {
      f0: renderCritterFrame(def, 0),
      f1: renderCritterFrame(def, 1),
      sil: renderCritterFrame(def, 0, "#ffffff"),
    };
    sprites.set(def.id, set);
    return set;
  };

  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          floorWidth = lane.clientWidth;
          for (const c of critters.values()) {
            c.x = clampX(c.x);
            c.target = clampX(c.target);
            if (c.tween) {
              c.tween.from = clampX(c.tween.from);
              c.tween.to = clampX(c.tween.to);
            }
            place(c);
          }
        });
  resizeObserver?.observe(lane);

  // ── Lane: open while anyone is out (or about to be), collapse after ──
  // While the last critter has gone and the collapse is pending the lane is
  // "closing" (still open), so its terrain can sink before the lane shuts.
  function openLane(): number {
    lane.classList.remove("instant");
    if (collapseTimer) {
      cancelLater(collapseTimer);
      collapseTimer = 0;
    }
    lane.classList.remove("closing");
    if (!lane.classList.contains("open")) {
      lane.classList.add("open");
      laneReadyAt = now() + (reduced ? 0 : (options.landAfterMs ?? LANE_OPEN_MS));
      options.onLaneOpen?.();
    }
    return Math.max(0, laneReadyAt - now());
  }
  function maybeCollapseLane(): void {
    // A show still on (a monster crossing) keeps the lane open after the last critter.
    if (critters.size > 0 || pending.size > 0 || collapseTimer || stage.busy()) return;
    lane.classList.remove("instant");
    if (resting) {
      // Its timer would be frozen: shut the empty lane now.
      lane.classList.remove("open", "closing");
      return;
    }
    if (lane.classList.contains("open")) lane.classList.add("closing");
    const delay = reduced ? COLLAPSE_DELAY_MS : (options.closeAfterMs ?? COLLAPSE_DELAY_MS);
    collapseTimer = later(delay, () => {
      collapseTimer = 0;
      lane.classList.remove("closing");
      if (critters.size === 0 && pending.size === 0) lane.classList.remove("open");
    });
  }

  // ── Frame loop: runs only while critters exist and the window is in use ──
  function startLoop(): void {
    if (rafId || destroyed || critters.size === 0 || resting) return;
    lastFrameTs = now();
    rafId = requestAnimationFrame(frame);
  }
  function stopLoop(): void {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }
  function frame(): void {
    rafId = 0;
    const t = now();
    const dt = Math.min(0.05, Math.max(0, (t - lastFrameTs) / 1000));
    lastFrameTs = t;
    for (const c of critters.values()) tick(c, t, dt);
    if (!reduced) social.scan(t);
    stage.tick(t, dt);
    startLoop();
  }

  // ── Resting: a window the user isn't looking at holds a still pose ──
  // Every repaint is a round trip through WebKit's shared GPU process, so a
  // background window doesn't animate (see `data-motion` in App.css, which
  // covers the CSS loops). Here the frame loop stops, the floor clock and its
  // script timers freeze, and looping Web Animations (gear spin, typing bob,
  // the fly's buzz…) rest on their first frame. One-shot reactions to agent
  // events (summon, wave goodbye, tip over) still play, so a background window
  // still shows an agent arriving or finishing.
  const restingLoops = new Set<Animation>();
  /** One-shots already being waited on, so each gets a single listener. */
  const watchedOneShots = new WeakSet<Animation>();
  const isScriptAnimation = (a: Animation): boolean =>
    typeof CSSAnimation === "undefined" || !(a instanceof CSSAnimation);
  const floorAnimations = (): Animation[] =>
    typeof floor.getAnimations === "function"
      ? floor.getAnimations({ subtree: true }).filter(isScriptAnimation)
      : [];
  /** Rest running loops. A one-shot still playing may hand its script on to
   *  a new loop when it ends (timers are frozen, so nothing else can), so
   *  settle again when it finishes: event-driven, nothing polls while hidden
   *  (a hidden page's one-shots don't advance until it's shown). */
  function settleLoops(): void {
    if (!resting || destroyed) return;
    for (const a of floorAnimations()) {
      if (a.playState !== "running") continue;
      if (a.effect?.getTiming().iterations === Number.POSITIVE_INFINITY) {
        a.currentTime = 0;
        a.pause();
        restingLoops.add(a);
      } else if (!watchedOneShots.has(a)) {
        watchedOneShots.add(a);
        // `finished` rejects when the script cancels it; either way, settle.
        void a.finished.then(settleLoops, settleLoops);
      }
    }
  }
  function rest(): void {
    if (resting) return;
    resting = true;
    restedAt = performance.now();
    stopLoop();
    for (const entry of timers.values()) {
      window.clearTimeout(entry.handle);
      entry.handle = 0;
    }
    settleLoops();
  }
  function wake(): void {
    if (!resting) return;
    restedTotal += performance.now() - restedAt;
    resting = false;
    for (const a of restingLoops) {
      // Cancelled while resting (its script ended): leave it cancelled.
      if (a.playState === "paused") a.play();
    }
    restingLoops.clear();
    for (const id of [...timers.keys()]) arm(id);
    startLoop();
  }
  const stopMotionWatch = subscribeMotion((level) => (level === "full" ? wake() : rest()));
  if (readMotionLevel() !== "full") rest();

  // ── Script runner ──
  const canAct = (c: Critter): boolean =>
    !c.leaving && c.el.isConnected && c.agent.status === "running";
  const isFree = (c: Critter): boolean => canAct(c) && c.prio <= PRIO.idle && c.mode !== "summon";

  function cancelBodyAnimations(c: Critter): void {
    for (const a of c.body.getAnimations()) a.cancel();
    for (const a of c.react.getAnimations()) a.cancel();
  }

  function interrupt(c: Critter): void {
    if (c.prio === PRIO.work && c.job && !c.pendingJob) {
      // Spooked or pulled away mid-task: the agent is still running that
      // tool, so pick it back up afterwards.
      const left = c.job.endAt - now();
      if (left > 900) c.pendingJob = makeJob(c.job.kind, left);
    }
    c.job = null;
    c.token++;
    c.prio = PRIO.free;
    c.next = null;
    c.legs = 0;
    if (c.tween) {
      c.tween.resolve();
      c.tween = null;
    }
    cancelBodyAnimations(c);
    fx.clearProps(c);
    c.el.classList.remove("sitting", "phasing", "sooty");
  }

  function begin(c: Critter, prio: Priority): void {
    c.prio = prio;
    c.mode = "script";
    c.frame = 0;
    c.seek = null;
  }

  function release(c: Critter): void {
    const next = c.next;
    c.next = null;
    c.prio = PRIO.free;
    c.legs = 0;
    c.tween = null;
    c.job = null;
    cancelBodyAnimations(c);
    fx.clearProps(c);
    c.el.classList.remove("phasing", "sooty", "sitting");
    if (!canAct(c)) return;
    fx.setBadge(c, null);
    // The agent moved on to another tool while this one was busy.
    const queued = c.pendingJob;
    if (queued) {
      c.pendingJob = null;
      if (startJob(c, queued)) return;
    }
    if (next?.flee) {
      c.mode = "flee";
      c.dir = next.dir ?? c.dir;
      c.timer = next.flee;
      fx.sweat(c);
    } else if (next?.dir) {
      walkOn(c, next.dir);
      if (next.behind) social.passBehind(c);
    } else {
      c.mode = "pause";
      c.timer = reduced ? Number.POSITIVE_INFINITY : rand(0.3, 1.1);
    }
  }

  async function runScript(fn: Script, ok: () => boolean, done: () => void): Promise<boolean> {
    try {
      await fn(ok);
    } catch (err) {
      console.error("critter script failed", err);
    }
    done();
    return true;
  }

  function perform(c: Critter, prio: Priority, fn: Script): Promise<boolean> {
    if (!canAct(c) || c.prio >= prio || c.mode === "summon") return Promise.resolve(false);
    interrupt(c);
    const token = c.token;
    begin(c, prio);
    const ok = (): boolean => c.token === token && canAct(c);
    return runScript(fn, ok, () => {
      if (c.token === token) release(c);
    });
  }

  function performPair(a: Critter, b: Critter, prio: Priority, fn: Script): Promise<boolean> {
    const able = (c: Critter): boolean => canAct(c) && c.prio < prio && c.mode !== "summon";
    if (!able(a) || !able(b)) return Promise.resolve(false);
    interrupt(a);
    interrupt(b);
    const ta = a.token;
    const tb = b.token;
    begin(a, prio);
    begin(b, prio);
    const ok = (): boolean => a.token === ta && b.token === tb && canAct(a) && canAct(b);
    return runScript(fn, ok, () => {
      if (a.token === ta) release(a);
      if (b.token === tb) release(b);
    });
  }

  /** Pick a weighted variant, never one of the last one or two used. */
  function pickVariant<V extends Variant>(
    owner: VariantOwner,
    key: string,
    list: readonly V[],
    weightFn?: (v: V) => number,
    subject?: Critter,
  ): V {
    const who = subject ?? (isCritter(owner) ? owner : undefined);
    const recent = owner.recent.get(key) ?? [];
    const weight = (v: V): number => {
      if (v.only && (!who || !v.only(who))) return 0;
      if (weightFn) return Math.max(0, weightFn(v));
      if (typeof v.w === "function") return who ? Math.max(0, v.w(who)) : 1;
      return Math.max(0, v.w ?? 1);
    };
    let pool = list.filter((v) => weight(v) > 0);
    const avoid = pool.length > 3 ? 2 : pool.length > 1 ? 1 : 0;
    const skip = avoid ? recent.slice(-avoid) : [];
    const fresh = pool.filter((v) => !skip.includes(v.id));
    if (fresh.length) pool = fresh;
    const fallback = pool[pool.length - 1] ?? list[0];
    if (!fallback) throw new Error(`pickVariant(${key}) from an empty list`);
    let chosen = fallback;
    let r = random() * pool.reduce((s, v) => s + weight(v), 0);
    for (const v of pool) {
      r -= weight(v);
      if (r <= 0) {
        chosen = v;
        break;
      }
    }
    owner.recent.set(key, [...recent, chosen.id].slice(-3));
    if (who) stage.noteAct(who, key, chosen.id);
    return chosen;
  }
  const isCritter = (o: VariantOwner): o is Critter => "agent" in o && "def" in o;

  // ── Movement primitives the scripts use ──
  function face(c: Critter, dir: 1 | -1): void {
    c.dir = dir;
  }
  function tween(
    c: Critter,
    to: number,
    ms: number,
    ease: EaseName,
    walking: boolean,
    // The stage walks critters in from, and out past, the lane's edges.
    raw = false,
  ): Promise<void> {
    if (c.tween) c.tween.resolve();
    return new Promise((resolve) => {
      c.tween = {
        from: c.x,
        to: raw ? to : clampX(to),
        t0: now(),
        ms: Math.max(1, ms),
        ease: EASE[ease],
        walking,
        token: c.token,
        resolve,
      };
    });
  }
  const tweenX = (c: Critter, x: number, ms: number, ease: EaseName = "ease-out"): Promise<void> =>
    tween(c, x, ms, ease, false);
  /** Walk (with legs moving) to x at the critter's speed × mul. */
  function goTo(c: Critter, x: number, mul = 1): Promise<void> {
    const to = clampX(x);
    const dist = Math.abs(to - c.x);
    if (dist < 1) return Promise.resolve();
    face(c, to >= c.x ? 1 : -1);
    const ms = (dist / (speedOf(c) * mul)) * 1000;
    return tween(c, to, ms, "linear", true);
  }
  /** A small knock that doesn't interrupt whatever the critter is doing. */
  function jolt(c: Critter, n = 1, dir = -c.dir): void {
    if (reduced) return;
    c.react.animate(
      [
        { transform: "none" },
        { transform: `translateX(${dir * 3 * n}px) rotate(${dir * 6 * n}deg)` },
        { transform: "none" },
      ],
      { duration: 260, easing: "ease-out" },
    );
  }
  const speedOf = (c: Critter): number =>
    MOVE[c.def.move].speed * TRAITS[c.trait].speed * (c.hyped ? 1.25 : 1);
  function lively(c: Critter): Liveliness {
    const t = TRAITS[c.trait];
    return {
      fidget: LIVELY.fidget * t.fidget,
      seek: LIVELY.seek * t.seek,
      bump: Math.min(1, LIVELY.bump * t.bump),
      trip: LIVELY.trip * t.trip,
      gap: LIVELY.gap,
    };
  }

  const api: CritterApi = {
    fx,
    live,
    lively,
    pickVariant,
    perform,
    performPair,
    canAct,
    isFree,
    face,
    clampX,
    goTo,
    tweenX,
    jolt,
    floorWidth: () => floorWidth,
    now,
  };
  const work = makeCritterWork(api);
  const idle = makeCritterIdle(api);
  const social = makeCritterSocial(api);
  const scares = makeCritterScare(api);
  const stage = makeCritterStage({
    api,
    lane,
    floor,
    reduced,
    ambient,
    options: options.stage ?? {},
    random,
    later,
    place: (c) => place(c),
    tweenRaw: (c, to, ms, ease, walking) => tween(c, to, ms, ease, walking, true),
    onQuiet: () => maybeCollapseLane(),
  });

  // ── Work: real tool activity → acted-out work ──
  function makeJob(kind: JobKind, ms: number): Job {
    const t = now();
    return {
      kind,
      startedAt: t,
      endAt: t + ms,
      minEndAt: t + Math.min(ms, MIN_JOB_MS),
      winding: false,
    };
  }
  function jobLength(kind: JobKind): number {
    return JOB_MS[kind] * rand(0.8, 1.3);
  }
  /** Start acting out a job now. Returns false if the critter couldn't take it. */
  function startJob(c: Critter, job: Job): boolean {
    if (!canAct(c) || c.prio >= PRIO.work || c.mode === "summon") return false;
    // The job's clock starts when the critter actually starts on it.
    const ms = job.endAt - job.startedAt;
    const fresh = makeJob(job.kind, ms);
    void perform(c, PRIO.work, async (ok) => {
      c.job = fresh;
      c.saidLong = false;
      await work.run(c, fresh, ok);
    });
    return true;
  }

  /** A running agent started a new tool. */
  function onActivity(c: Critter, activity: string): void {
    c.lastActivityAt = now();
    const kind = toolKindOf(activity);
    if (!kind || reduced) return;
    const current = c.prio === PRIO.work ? c.job : null;
    if (current && !current.winding) {
      if (current.kind === kind) {
        // More of the same: keep going a little longer.
        current.endAt = Math.max(current.endAt, now() + jobLength(kind) * 0.7);
        return;
      }
      // A different tool: wrap this one up soon, then start the new one.
      current.endAt = Math.max(current.minEndAt, Math.min(current.endAt, now() + SWITCH_SOON_MS));
      c.pendingJob = makeJob(kind, jobLength(kind));
      return;
    }
    const job = makeJob(kind, jobLength(kind));
    if (c.prio > PRIO.work || c.mode === "summon" || current) {
      // Busy with something more important (or finishing an outro): queue it.
      c.pendingJob = job;
      return;
    }
    startJob(c, job);
  }

  /** Long quiet stretch between tools: stop and think for a bit. */
  function maybeThink(c: Critter, t: number): boolean {
    if (ambient) return false;
    if (c.pendingJob || t - c.lastActivityAt < THINK_AFTER_MS || t - c.lastThinkAt < THINK_GAP_MS) {
      return false;
    }
    c.lastThinkAt = t;
    return startJob(c, makeJob("think", THINK_MS * rand(0.8, 1.2)));
  }

  // ── Placement + movement ──
  function place(c: Critter): void {
    c.el.classList.toggle("left", c.def.move !== "scuttle" && c.dir < 0);
    c.el.classList.toggle("frame1", c.frame === 1);
    c.el.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px)`;
    stage.ground(c);
    if (c.def.move === "squish" && c.mode !== "script") {
      const s = c.mode === "walk" ? Math.sin(c.phase * 9) : 0;
      c.body.style.transform = s === 0 ? "" : `scale(${1 + s * 0.08}, ${1 - s * 0.1})`;
    }
  }
  function stepFrame(c: Critter, dt: number, ms: number): void {
    c.frameT += dt * 1000;
    if (c.frameT > ms) {
      c.frameT = 0;
      c.frame = c.frame === 0 ? 1 : 0;
    }
  }
  function walkOn(c: Critter, dir: 1 | -1): void {
    face(c, dir);
    c.target = clampX(c.x + dir * rand(40, 140));
    c.mode = "walk";
  }
  function pickTarget(c: Critter): void {
    const reach = random() < 0.25 ? floorWidth * 0.6 : rand(40, 160);
    const raw = c.x + (random() < 0.5 ? -reach : reach);
    c.target = clampX(raw);
    c.dir = c.target >= c.x ? 1 : -1;
    c.mode = "walk";
  }
  /** What a free critter does when its pause runs out. */
  function decide(c: Critter, t: number): void {
    if (maybeThink(c, t)) return;
    const L = lively(c);
    if (random() < L.seek && social.seek(c)) return;
    if (random() < L.fidget) {
      idle.fidget(c);
      if (c.prio !== PRIO.free) return;
    }
    if (random() < 0.2) c.dir = c.dir > 0 ? -1 : 1; // glance the other way
    pickTarget(c);
  }

  function tick(c: Critter, t: number, dt: number): void {
    c.phase += dt;
    if (c.hyped && t > c.hypedUntil) c.hyped = false;
    const move = MOVE[c.def.move];
    let moving = false;

    const tw = c.tween;
    if (tw) {
      if (tw.token !== c.token) {
        c.tween = null;
        tw.resolve();
      } else {
        const k = Math.min(1, (t - tw.t0) / tw.ms);
        c.x = tw.from + (tw.to - tw.from) * tw.ease(k);
        if (tw.walking) {
          moving = true;
          stepFrame(c, dt, move.frameMs);
        }
        if (k >= 1) {
          c.tween = null;
          tw.resolve();
        }
      }
    } else if (c.mode === "walk") {
      moving = true;
      c.x += c.dir * speedOf(c) * dt;
      stepFrame(c, dt, move.frameMs);
      const canTrip = social.grounded(c) && c.def.move !== "squish";
      if (canTrip && random() < lively(c).trip * dt) {
        idle.trip(c);
      } else if (c.dir > 0 ? c.x >= c.target : c.x <= c.target) {
        c.x = c.target;
        c.frame = 0;
        if (c.seek && social.arrived(c)) {
          // the visit script owns it now
        } else {
          c.mode = "pause";
          c.timer = rand(0.6, 2.6) * LIVELY.gap;
        }
      }
    } else if (c.mode === "flee") {
      moving = true;
      c.x = clampX(c.x + c.dir * speedOf(c) * 5 * dt);
      stepFrame(c, dt, 55);
      c.timer -= dt;
      if (c.timer <= 0) {
        c.mode = "pause";
        c.timer = rand(0.4, 1.2);
        c.frame = 0;
      }
    } else if (c.mode === "pause") {
      if (c.def.move === "hover") stepFrame(c, dt, move.frameMs);
      c.timer -= dt;
      if (c.timer <= 0 && !reduced && isFree(c)) decide(c, t);
    } else if (c.legs > 0) {
      moving = true; // running in place (hamster wheel, tag…)
      stepFrame(c, dt, c.legs);
    } else if (c.def.move === "hover" && !stage.downed(c)) {
      stepFrame(c, dt, move.frameMs); // bees keep buzzing no matter what
    }

    // A downed critter drops to the ground and stays there.
    if (stage.downed(c)) c.y = Math.min(0, c.y + dt * 70);
    else if (c.def.move === "hover") c.y = reduced ? -8 : -8 + Math.sin(c.phase * 3) * 3;
    else if (c.def.move === "float") c.y = reduced ? -5 : -5 + Math.sin(c.phase * 2) * 2.5;
    else if (c.def.move === "hop" && moving) c.y = -Math.abs(Math.sin(c.phase * 7)) * 5;
    else if (moving && c.frame === 1 && c.def.move !== "squish") c.y = -1;
    else c.y = 0;
    place(c);
  }

  // ── Summon in / teleport out / fall over ──
  function create(agent: FloorAgent, returning = false): void {
    const taken = new Set([...critters.values()].map((c) => c.def.id));
    const pinned = CRITTERS.find((critter) => critter.id === agent.critterId);
    const def = pinned ?? pickCritter(agent.agentName, agent.key, taken);
    const set = spritesFor(def);
    const root = el("div", "critter summoning");
    root.style.setProperty("--critter-color", def.palette.B ?? "#ffffff");
    const shadow = el("div", "critter-shadow");
    const react = el("div", "critter-react");
    const body = el("div", "critter-body");
    const flip = el("div", "critter-flip");
    const f0 = el("img", "critter-f0");
    const f1 = el("img", "critter-f1");
    const sil = el("img", "critter-sil");
    for (const [img, src] of [
      [f0, set.f0],
      [f1, set.f1],
      [sil, set.sil],
    ] as const) {
      img.src = src;
      img.alt = "";
      img.draggable = false;
    }
    flip.append(f0, f1, sil);
    body.appendChild(flip);
    react.appendChild(body);
    root.append(shadow, react);
    floor.appendChild(root);

    const t = now();
    const c: Critter = {
      key: agent.key,
      def,
      el: root,
      react,
      body,
      sil,
      shadow,
      startedAt: t,
      trait: TRAIT_NAMES[Math.floor(random() * TRAIT_NAMES.length)] ?? "chill",
      recent: new Map(),
      agent,
      x: rand(SIZE, Math.max(SIZE + 1, floorWidth - SIZE * 2)),
      y: 0,
      dir: random() < 0.5 ? -1 : 1,
      target: 0,
      mode: "summon",
      timer: 0,
      frame: 0,
      frameT: 0,
      phase: random() * 10,
      prio: PRIO.free,
      token: 0,
      hyped: false,
      hypedUntil: 0,
      job: null,
      pendingJob: null,
      lastKind: null,
      lastActivityAt: t,
      lastThinkAt: t,
      saidLong: false,
      lastAct: agent.activity ?? "",
      legs: 0,
      next: null,
      seek: null,
      tween: null,
      leaving: false,
      scareIndex: Math.floor(random() * 5),
    };
    c.target = c.x;
    root.addEventListener("mouseenter", () => stage.tag.show(c));
    root.addEventListener("mouseleave", () => stage.tag.hide());
    root.addEventListener("click", () => onClick(c));
    critters.set(c.key, c);
    stage.dress(c);
    place(c);
    summonIn(c, returning);
    options.onPresence?.(c.key, true);
    startLoop();
  }

  /** Bring it in: one of the stage's arrivals, or the classic one here (beam
   *  + ring, then a white silhouette grows out of the floor and fades into the
   *  critter's colours). */
  function summonIn(c: Critter, returning: boolean): void {
    const settle = (): void => {
      c.el.classList.remove("summoning");
      if (c.leaving) return;
      c.mode = "pause";
      c.timer = reduced ? Number.POSITIVE_INFINITY : rand(0.3, 1.2);
      fx.say(c, fx.pick(GREETINGS), 1300, true);
      // It may already be mid-tool by the time it lands.
      if (c.agent.activity) onActivity(c, c.agent.activity);
    };
    if (resting || returning) {
      // Landing in a resting window (its timers are frozen), or coming back
      // into view: no beam or greeting, just stand there in the working pose.
      c.el.classList.remove("summoning");
      c.mode = "pause";
      c.timer = reduced ? Number.POSITIVE_INFINITY : rand(0.3, 1.2);
      if (c.agent.activity) onActivity(c, c.agent.activity);
      return;
    }
    if (reduced) {
      c.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: "ease-out" });
      later(300, settle);
      return;
    }
    if (stage.arrive(c, settle)) return;
    beam(c, "in");
    c.shadow.animate(
      [
        { opacity: 0, transform: "scaleX(0.2)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 500, delay: 250, fill: "backwards" },
    );
    c.body.animate(
      [
        { transform: "translateY(-14px) scale(0.05, 0.05)", offset: 0 },
        { transform: "translateY(-14px) scale(0.05, 0.05)", offset: 0.22 },
        { transform: "translateY(-4px) scale(0.55, 1.35)", offset: 0.45 },
        { transform: "translateY(0) scale(1.28, 0.72)", offset: 0.62 },
        { transform: "translateY(0) scale(0.92, 1.1)", offset: 0.8 },
        { transform: "none", offset: 1 },
      ],
      { duration: SUMMON_MS, easing: "cubic-bezier(0.3, 0.7, 0.4, 1)", fill: "backwards" },
    );
    c.sil.animate(
      [
        { opacity: 1, offset: 0 },
        { opacity: 1, offset: 0.62 },
        { opacity: 0, offset: 1 },
      ],
      { duration: SUMMON_MS + 150, easing: "ease-in" },
    );
    later(SUMMON_MS * 0.55, () => fx.sparks(c, 10, true));
    later(SUMMON_MS + 60, settle);
  }

  function beam(c: Critter, direction: "in" | "out"): void {
    if (reduced) return;
    const glow = el("div", "critter-beam");
    const core = el("div", "critter-beam-core");
    const ring = el("div", "critter-ring");
    c.el.prepend(glow, core);
    c.el.appendChild(ring);
    // Summon pours DOWN onto the floor; teleport shoots UP off it.
    const origin = direction === "in" ? "50% 0%" : "50% 100%";
    glow.style.transformOrigin = origin;
    core.style.transformOrigin = origin;
    const grow: Keyframe[] = [
      { transform: "scaleY(0)", opacity: 0 },
      { transform: "scaleY(1)", opacity: 1, offset: 0.25 },
      { transform: "scaleY(1)", opacity: 0.9, offset: 0.6 },
      {
        transform: direction === "in" ? "scaleY(0.2) scaleX(2.2)" : "scaleY(1.2) scaleX(0.2)",
        opacity: 0,
      },
    ];
    glow.animate(grow, { duration: 820, easing: "ease-out", fill: "forwards" });
    core.animate(grow, { duration: 700, easing: "ease-out", fill: "forwards" });
    ring.animate(
      [
        { transform: "scale(0.2)", opacity: 0 },
        { transform: "scale(1)", opacity: 1, offset: 0.3 },
        { transform: "scale(2.4)", opacity: 0 },
      ],
      { duration: 760, delay: direction === "in" ? 160 : 0, easing: "ease-out", fill: "both" },
    );
    later(1100, () => {
      discard(glow);
      discard(core);
      discard(ring);
    });
  }

  /** Stop everything the critter was doing; it ignores the floor from now on. */
  function beginLeaving(c: Critter): void {
    interrupt(c);
    c.pendingJob = null;
    c.leaving = true;
    c.prio = PRIO.gone;
    c.mode = "script";
    c.frame = 0;
    c.el.classList.add("leaving");
    c.el.classList.remove("behind");
    fx.clearBubble(c);
    fx.setBadge(c, null);
    stage.tag.drop(c);
  }

  // Four ways to say goodbye before beaming out.
  const FAREWELL_MOVES: readonly ((c: Critter) => Animation)[] = [
    (c) =>
      c.body.animate(
        [
          { transform: "none" },
          { transform: "rotate(-12deg)" },
          { transform: "rotate(10deg)" },
          { transform: "rotate(-10deg)" },
          { transform: "rotate(8deg)" },
          { transform: "none" },
        ],
        { duration: 800, easing: "ease-in-out" },
      ),
    (c) =>
      c.body.animate(
        [
          { transform: "none" },
          { transform: `rotate(${c.dir * 22}deg) translateY(1px)`, offset: 0.35 },
          { transform: `rotate(${c.dir * 22}deg) translateY(1px)`, offset: 0.65 },
          { transform: "none" },
        ],
        { duration: 800, easing: "ease-in-out" },
      ),
    (c) =>
      c.body.animate(
        [
          { transform: "scaleX(1)" },
          { transform: "scaleX(0.05)", offset: 0.25 },
          { transform: "scaleX(-1)", offset: 0.5 },
          { transform: "scaleX(0.05)", offset: 0.75 },
          { transform: "scaleX(1)" },
        ],
        { duration: 700, easing: "linear" },
      ),
    (c) => {
      fx.confetti(c, 8);
      return c.body.animate(
        [
          { transform: "none" },
          { transform: "translateY(-12px) scale(0.92, 1.1)", offset: 0.35 },
          { transform: "scale(1.15, 0.85)", offset: 0.7 },
          { transform: "none" },
        ],
        { duration: 700, easing: "ease-out" },
      );
    },
  ];

  /** Its work is over: off it goes, one of the stage's ways or the classic one. */
  function teleportOut(c: Critter, finished: boolean): void {
    if (resting) return leaveNow(c);
    beginLeaving(c);
    if (finished) {
      fx.setBadge(c, "ok", "\u2713");
      if (!reduced) social.cheer(c);
    }
    if (reduced) {
      fx.say(c, finished ? fx.pick(FAREWELLS) : "Called back", 1300, true);
      later(900, () => {
        c.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, fill: "forwards" });
        later(420, () => remove(c));
      });
      return;
    }
    const classic = (): void => classicOut(c, finished);
    if (!stage.depart({ c, finished, done: () => remove(c), classic })) classic();
  }

  /** Say goodbye, then reverse the summon: light up, stretch thin, zip up the beam. */
  function classicOut(c: Critter, finished: boolean): void {
    fx.say(c, finished ? fx.pick(FAREWELLS) : "Called back", 1300, true);
    fx.pick(FAREWELL_MOVES)(c);
    later(1050, () => {
      fx.clearBubble(c);
      fx.setBadge(c, null);
      beam(c, "out");
      c.sil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, fill: "forwards" });
      c.shadow.animate([{ opacity: 1 }, { opacity: 0, transform: "scaleX(0.2)" }], {
        duration: 500,
        fill: "forwards",
      });
      c.body.animate(
        [
          { transform: "none", offset: 0 },
          { transform: "scale(1.25, 0.72)", offset: 0.3 },
          { transform: "translateY(-6px) scale(0.55, 1.5)", offset: 0.55 },
          { transform: "translateY(-70px) scale(0.08, 2.6)", opacity: 0, offset: 1 },
        ],
        { duration: 620, easing: "cubic-bezier(0.5, 0, 0.75, 0)", fill: "forwards" },
      );
      later(320, () => fx.sparks(c, 12, false));
      later(1000, () => remove(c));
    });
  }

  /** Tips over (dropping whatever it held); nearby teammates come to check. */
  /** A resting window applies a departure at once: its farewell timers are
   *  frozen, so the animated goodbye would leave a finished agent standing
   *  there until focus. The activity bar already shows the outcome. */
  function leaveNow(c: Critter): void {
    beginLeaving(c);
    remove(c);
  }

  function fallOver(c: Critter): void {
    if (resting) return leaveNow(c);
    const held = c.react.querySelector(".critter-prop") !== null;
    if (held && !reduced) fx.dropProps(c);
    beginLeaving(c);
    fx.setBadge(c, "err", "\u2717");
    // Tipping over swings the sprite sideways; keep it clear of the walls.
    c.x = Math.min(Math.max(c.x, SIZE * 0.8), floorWidth - SIZE * 1.2);
    place(c);
    c.el.classList.add("fallen");
    stage.fall(c);
    if (reduced) {
      later(300, () => c.el.classList.add("fading"));
      later(1000, () => remove(c));
      return;
    }
    fx.say(c, fx.pick(["x_x", "ow\u2026", "I tried\u2026", "oops"]), 1300, true);
    const helpers = social.checkOn(c);
    const stay = helpers > 0 ? 3600 : 900;
    later(stay, () => c.el.classList.add("fading"));
    later(stay + 700, () => remove(c));
  }

  function remove(c: Critter): void {
    if (critters.get(c.key) !== c) return;
    c.token++;
    c.tween?.resolve();
    c.tween = null;
    discard(c.el);
    critters.delete(c.key);
    options.onPresence?.(c.key, false);
    stage.tag.drop(c);
    if (critters.size === 0) stopLoop();
    // A follow-up landed while it was waving goodbye: bring it straight back.
    const current = latest.get(c.key);
    if (current?.status === "running" && !pending.has(c.key)) summon(current);
    maybeCollapseLane();
  }

  // ── Click to spook ──
  const SCARE_BADGES = ["!", "!!", "?!", "!", "eep"];
  function onClick(c: Critter): void {
    if (c.leaving || c.mode === "summon") return;
    stage.tag.pin(c);
    if (reduced) {
      fx.setBadge(c, "yikes", SCARE_BADGES[c.scareIndex % SCARE_BADGES.length] ?? "!");
      c.scareIndex++;
      later(900, () => {
        if (!c.leaving) fx.setBadge(c, null);
      });
      return;
    }
    scares.scare(c);
  }

  // ── Reconcile with the agent list ──
  /**
   * Put a critter that was already out straight back (see wasHere): the lane
   * opens at once with its scenery in place, without rolling a new terrain.
   */
  function restore(agent: FloorAgent): void {
    if (collapseTimer) {
      cancelLater(collapseTimer);
      collapseTimer = 0;
    }
    lane.classList.remove("closing");
    if (!lane.classList.contains("open")) {
      lane.classList.add("instant", "open");
      laneReadyAt = now();
      later(RESTORE_SETTLE_MS, () => lane.classList.remove("instant"));
    }
    create(agent, true);
  }

  function summon(agent: FloorAgent): void {
    const t = now();
    const laneWait = openLane();
    if (resting) {
      // The spawn queue's timers are frozen while resting: land it now.
      create(agent);
      return;
    }
    const at = Math.max(t + laneWait, nextSpawnAt);
    nextSpawnAt = at + SPAWN_GAP_MS;
    const id = later(at - t, () => {
      pending.delete(agent.key);
      const current = latest.get(agent.key);
      // Finished before it ever landed (a very quick agent): skip it.
      if (current?.status !== "running" || critters.has(agent.key)) {
        maybeCollapseLane();
        return;
      }
      create(current);
    });
    pending.set(agent.key, id);
  }

  function update(c: Critter, agent: FloorAgent): void {
    const previous = c.agent;
    c.agent = agent;
    if (c.leaving) return;
    // "idle" is how a background agent reports its work finished (ready for
    // follow-up), so it leaves exactly like a done one.
    if (agent.status === "done" || agent.status === "idle") return teleportOut(c, true);
    if (agent.status === "interrupted") return teleportOut(c, false);
    if (agent.status === "error") return fallOver(c);
    if (agent.status !== "running" || !agent.activity) return;
    if (agent.activity === previous.activity && agent.toolUseCount === previous.toolUseCount) {
      return;
    }
    c.lastAct = agent.activity;
    // Still landing: settle() picks up the latest activity once it touches down.
    if (c.mode === "summon") return;
    onActivity(c, agent.activity);
  }

  function sync(agents: readonly FloorAgent[]): void {
    if (destroyed) return;
    syncAgents(agents);
    // Agent events can start a work loop in a resting window: rest it too.
    if (resting) settleLoops();
  }

  function syncAgents(agents: readonly FloorAgent[]): void {
    latest = new Map(agents.map((agent) => [agent.key, agent]));
    for (const agent of agents) {
      const existing = critters.get(agent.key);
      if (existing) {
        update(existing, agent);
        continue;
      }
      // Only working agents are summoned: finished ones (including a resumed
      // session's history) stay off the floor until a follow-up wakes them.
      if (pending.has(agent.key) || agent.status !== "running") continue;
      if (options.wasHere?.(agent.key)) restore(agent);
      else summon(agent);
    }
    // Agents that vanished from the list (session switch, transcript reload).
    for (const [key, id] of pending) {
      if (!latest.has(key)) {
        cancelLater(id);
        pending.delete(key);
      }
    }
    for (const c of [...critters.values()]) {
      if (!latest.has(c.key)) remove(c);
    }
    maybeCollapseLane();
  }

  function destroy(): void {
    destroyed = true;
    stage.destroy();
    stopLoop();
    for (const c of critters.values()) {
      c.token++;
      c.tween?.resolve();
      c.tween = null;
    }
    for (const entry of timers.values()) window.clearTimeout(entry.handle);
    timers.clear();
    restingLoops.clear();
    resizeObserver?.disconnect();
    stopMotionWatch();
    critters.clear();
    pending.clear();
    discard(floor);
    lane.classList.remove("open", "closing");
  }

  return { sync, destroy };
}
