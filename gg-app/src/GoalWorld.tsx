import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import type { FloorAgent } from "./critter-floor";
import { hashKey } from "./critter-sprites";
import { GoalAskNotice } from "./GoalAskNotice";
import { GoalFinishCard } from "./GoalFinishCard";
import type { GoalFinish } from "./goal-finish";
import type { KenSaid } from "./goal-ken-talk";
import { KenDialogue } from "./KenDialogue";
import { KenStatus } from "./KenStatus";
import type { KenStatus as KenStatusValue } from "./goal-ken-status";
import { collectWorldAgents, type WorldAgent } from "./goal-world-agents";
import { FARM_CORE, buildFarm } from "./goal-farm-map";
import {
  addDebris,
  createPlay,
  groundAt,
  LIGHTS,
  playing,
  poke,
  settlePlay,
  type FarmPlay,
  type ThingKind,
} from "./goal-farm-interact";
import { SURFACE } from "./goal-farm-map";
import { playUses, stationThings, stationsInUse, usesNeedPace } from "./goal-farm-use";
import { createFarmSounds, type FarmSounds } from "./goal-farm-sounds";
import type { Spot } from "./goal-farm-travel";
import {
  canvasOf,
  drawFarm,
  farmTargets,
  nearestWater,
  spawnDebris,
  targetAt,
  paintAtmosphere,
  paintOccluders,
  paintSwayBase,
  swaySurface,
  type Atmosphere,
  type OccluderCanvas,
} from "./goal-farm-render";
import { blendLook, farmSkyAt, hourOf, weatherFor, weatherLook } from "./goal-farm-sky";
import { coverAt, coverStep, weatherBackground, weatherSprite } from "./goal-farm-weather";
import { composeMap } from "./goal-map-compose";
import type { PixelBuffer } from "./goal-map-pixels";
import {
  createFarmWorld,
  farmIsMoving,
  resizeFarm,
  stepFarm,
  syncFarm,
  type FarmWorld,
} from "./goal-farm-sim";
import { makeFarmStage, type FarmStage } from "./goal-farm-stage";
import { TILE } from "./goal-map-ground";
import type { LiveToolEntry } from "./LiveToolPanel";
import { useMotionLevel, type MotionLevel } from "./window-motion";

/**
 * How the farm moves for the window's motion level. Only a hidden window
 * stops it; reduced motion holds the fire, water and animals still. A window
 * that's visible but not focused moves exactly as a focused one: the farm is
 * meant to be glanced at beside other work, so nothing slows down, rests, or
 * walks on the spot.
 */
export function farmMotion(
  level: MotionLevel,
  reduced: boolean,
): { readonly runs: boolean; readonly ambientStill: boolean } {
  return { runs: level !== "off", ambientStill: reduced };
}

/**
 * How many screen pixels each map pixel takes: exactly enough for the whole
 * farmstead to fill the part of the window below the header, whatever the
 * window's size, so everything is always in view. Not rounded to a whole
 * number: a whole-number scale jumps (a window a little smaller than full
 * screen dropped from 2× to 1×, halving the farm). The canvas is scaled with
 * nearest-neighbour sampling, so a fractional scale still reads as pixels.
 */
export function farmScale(width: number, height: number): number {
  const coreW = FARM_CORE.cols * TILE;
  const coreH = FARM_CORE.rows * TILE;
  return Math.max(0.5, Math.min(width / coreW, height / coreH));
}

/** How big a map (in tiles) covers the stage edge to edge, and what the header hides. */
export interface FarmFit {
  readonly scale: number;
  readonly cols: number;
  readonly rows: number;
  /** Tiles at the top under the see-through header. */
  readonly top: number;
}

/**
 * Fit the farm to a stage of `width × height` px with a header `headerPx` tall
 * over its top: the whole farmstead fits below the header, as big as it can
 * be, and countryside around it covers the rest of the stage.
 */
export function fitFarm(width: number, height: number, headerPx: number): FarmFit {
  const header = Math.max(0, Math.min(height / 2, headerPx));
  const scale = farmScale(width, height - header);
  const cell = TILE * scale;
  return {
    scale,
    cols: Math.max(FARM_CORE.cols, Math.ceil(width / cell)),
    rows: Math.max(FARM_CORE.rows, Math.ceil(height / cell)),
    top: Math.ceil(header / cell),
  };
}

/** What the farm shows, in words, for screen readers. */
export function describeWorld(agents: readonly WorldAgent[]): string {
  return agents
    .map((agent) => {
      const status =
        agent.status === "done" ? "done" : agent.status === "error" ? "stopped" : agent.detail;
      return `${agent.name}: ${status}.`;
    })
    .join(" ");
}

const reducedMotionQuery = (): boolean =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Rebuilding the farm costs ~0.15s, so a drag-resize waits until it settles. */
/** How long after the farm appears its tree-less copy is painted (see paintSwayBase). */
const SWAY_BASE_DELAY_MS = 400;
const REFIT_DELAY_MS = 140;

interface Props {
  /** The header the farm runs under; the farmstead keeps below it. */
  headerRef?: RefObject<HTMLElement | null>;
  goalId: string;
  running: boolean;
  liveTools: readonly LiveToolEntry[];
  waitingOnUser: boolean;
  workers: readonly FloorAgent[];
  /**
   * GG Goals is blocked on a question the user hasn't seen yet: shown over
   * the farm as a sign until they go to the chat (see GoalAskNotice).
   */
  ask?: { readonly question: string; readonly more?: number } | null;
  /** Switch the window to the chat (the notice's "Answer in Chat"). */
  onShowChat?: () => void;
  /** Ken's newest spoken line, said now and then in the dialogue box. */
  kenSaid?: KenSaid | null;
  /** A stretch of work just finished: its end-of-level card (see GoalFinishCard). */
  finish?: GoalFinish | null;
  /** Take the finish card down. */
  onCloseFinish?: () => void;
  /**
   * What Ken is doing right now (see goal-ken-status): the status pill
   * bottom right, and the thought mark over his head on the farm.
   */
  kenStatus?: KenStatusValue | null;
}

/** How long a change of light, weather or ground cover takes to fade in. */
const LOOK_FADE_MS = 3200;
/** How long a new spell of weather takes to ease in, live. */
const WEATHER_EASE_MIN = 15;

/**
 * A started Goal, seen from above as a little farm filling the window: GG
 * Goals and every worker it brings in are critters about the yard, travelling
 * on foot along the yard's paths to the place for
 * whatever they're doing: the bookcase to read, the laptop for the web, the
 * notes board to plan, the carpenter's bench to edit, the stove to run things,
 * the post box to ask you something, and the tea bench by the fire to wait.
 * The canvas is decoration; a visually hidden summary carries the same facts.
 */
export function GoalWorld({
  headerRef,
  goalId,
  running,
  liveTools,
  waitingOnUser,
  workers,
  ask = null,
  onShowChat,
  kenSaid = null,
  finish = null,
  onCloseFinish,
  kenStatus = null,
}: Props): React.ReactElement {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<FarmWorld | null>(null);
  const backgroundRef = useRef<HTMLCanvasElement | null>(null);
  const occludersRef = useRef<readonly OccluderCanvas[]>([]);
  const atmosphereRef = useRef<Atmosphere | null>(null);
  // The look fading out after a change (light, weather, ground cover), and when it started.
  const fadeRef = useRef<{
    background: CanvasImageSource;
    occluders: readonly OccluderCanvas[];
    atmosphere: Atmosphere | null;
    start: number;
  } | null>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  // Poking things (see goal-farm-interact): which lights are off, what's
  // reacting, what's under the pointer. Kept for the session, not saved.
  const playRef = useRef<FarmPlay>(createPlay());
  // Their sounds (see goal-farm-sounds): one engine for as long as the farm is shown.
  const soundsRef = useRef<FarmSounds | null>(null);
  useEffect(() => {
    const sounds = createFarmSounds();
    soundsRef.current = sounds;
    return () => {
      sounds.dispose();
      soundsRef.current = null;
    };
  }, []);
  // What's drawn over the farm's frame (see goal-farm-stage): the name tag,
  // the other ways workers come and go, and visitors.
  const quietRef = useRef(false);
  const farmStageRef = useRef<FarmStage | null>(null);
  useEffect(() => {
    farmStageRef.current = makeFarmStage(() => worldRef.current, {
      quiet: () => quietRef.current,
    });
    return () => {
      farmStageRef.current = null;
    };
  }, []);
  // Bumped when a light is switched, so the light is rebuilt without it.
  const [lightsVersion, setLightsVersion] = useState(0);
  // Which lights are off, for the buttons' labels (the play state holds the truth).
  const [lightsOff, setLightsOff] = useState<ReadonlySet<string>>(new Set());
  // What can be poked, for the keyboard buttons: set when the farm or crew changes.
  const [pokeables, setPokeables] = useState<
    ReadonlyArray<{ id: string; name: string; kind: string }>
  >([]);
  // What the last poke did, in words, for the live region.
  const [pokeSaid, setPokeSaid] = useState("");
  const [hoverName, setHoverName] = useState<string | null>(null);
  // The map as drawn, before the hour's grade and the weather: rebuilt from this.
  const basePixelsRef = useRef<PixelBuffer | null>(null);
  // The map without its trees and bushes, ungraded (see paintSwayBase): graded
  // with the rest whenever the hour or weather changes a step.
  const swayPixelsRef = useRef<{ farm: object; pixels: PixelBuffer; surface: Uint8Array } | null>(
    null,
  );
  // Grades the tree-less copy for the current look; set by the look's effect.
  const gradeSwayRef = useRef<(() => void) | null>(null);
  // Bumped whenever the map is rebuilt, so the light is rebuilt to match.
  const [farmVersion, setFarmVersion] = useState(0);
  const fitKeyRef = useRef("");
  const motionLevel = useMotionLevel();
  const [reduced, setReduced] = useState(reducedMotionQuery);
  // Each goal keeps its own countryside, so returning to it feels like coming home.
  const seed = useMemo(() => hashKey(`goal-farm:${goalId}`) % 9973, [goalId]);

  const kenMark = kenStatus?.mark ?? null;
  const kenDetail = kenStatus?.headline ?? null;
  const agents = useMemo(() => {
    const all = collectWorldAgents({ running, liveTools, waitingOnUser, workers });
    // Ken's own words for what he's doing, and his thought mark: GG Goals
    // stands on the farm even between runs (paused, or done), so it's always there.
    return all.map((agent) =>
      agent.coordinator ? { ...agent, detail: kenDetail ?? agent.detail, mark: kenMark } : agent,
    );
  }, [running, liveTools, waitingOnUser, workers, kenMark, kenDetail]);
  const summary = useMemo(() => describeWorld(agents), [agents]);
  const shownAsk = ask && {
    question: ask.question,
    more: ask.more ?? 0,
    onAnswer: () => onShowChat?.(),
  };
  // One thing at a time over the farm: a sign (the question, or the finish
  // card) beats everything, Ken talking beats the status, and Ken holds his
  // next line while the user is reading the status.
  const signUp = Boolean(shownAsk) || Boolean(finish);
  // No visitors while a sign is up: the user has something to read.
  useEffect(() => {
    quietRef.current = signUp;
  }, [signUp]);
  const [kenTalking, setKenTalking] = useState(false);
  const [statusHovered, setStatusHovered] = useState(false);
  // The header's height, so the notice hangs just below it.
  const [headHeight, setHeadHeight] = useState(0);

  // The time of day follows the local clock (checked each minute); the
  // weather changes every few hours.
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setClock(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const hour = hourOf(clock);
  const weather = weatherFor(clock);
  // The light changes slowly: rebuild it every six minutes of the day, not every one.
  const lightStep = Math.round(hour * 10) / 10;

  // What the weather has left on the ground, from the clock.
  const cover = coverStep(coverAt(clock));

  // A new spell of weather eases in over its first quarter hour (the rain
  // thinning out, the fog rolling in) instead of switching at once.
  const minutesIn = (clock.getHours() % 4) * 60 + clock.getMinutes();
  const easing = Math.min(1, Math.round((minutesIn / WEATHER_EASE_MIN) * 5) / 5);
  const lastSpell = weatherFor(new Date(clock.getTime() - (minutesIn + 1) * 60_000));
  const lookKey = `${lastSpell}>${weather}@${easing}`;
  const look = blendLook(weatherLook(lastSpell), weatherLook(weather), easing);
  const coverKey = cover ? `${cover.kind}:${cover.level}` : "none";
  const snowLying = cover?.kind === "snow";

  // Rebuild the map's look (graded for the hour, with the weather's snow or
  // wet) and the light over it when either changes a step. A few dozen ms,
  // about every six minutes when live.
  useEffect(() => {
    const farm = worldRef.current?.farm;
    const base = basePixelsRef.current;
    if (!farm || !base) return;
    const sky = farmSkyAt(lightStep);
    const lying = coverKey === "none" ? null : cover;
    const { pixels, puddles } = weatherBackground(base, farm.surface, sky, lying, seed);
    // Keep the look on screen now, to fade out as this one fades in.
    if (backgroundRef.current) {
      fadeRef.current = {
        background: backgroundRef.current,
        occluders: occludersRef.current,
        atmosphere: atmosphereRef.current,
        start: performance.now(),
      };
    }
    backgroundRef.current = canvasOf(pixels);
    // The tree-less copy, graded the same way so a swaying tree's patch
    // matches the ground round it.
    gradeSwayRef.current = () => {
      const raw = swayPixelsRef.current;
      if (!raw || raw.farm !== farm) return;
      const graded = weatherBackground(raw.pixels, raw.surface, sky, lying, seed).pixels;
      playRef.current.swayBase = { farm, image: canvasOf(graded) };
    };
    playRef.current.swayBase = null;
    gradeSwayRef.current();
    occludersRef.current = paintOccluders(farm, (o) =>
      weatherSprite(o.buf, o.topRow, o.x, o.y, o.flip, sky, lying, seed),
    );
    atmosphereRef.current = paintAtmosphere(
      farm,
      sky,
      look,
      lying?.kind === "rain" ? puddles : null,
      playRef.current.lightsOff,
    );
    // `cover` and `look` are described by coverKey and lookKey; rebuilding on
    // their identity would rebuild every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightStep, lookKey, coverKey, farmVersion, seed, lightsVersion]);

  // Poking: find what's under a map point (front-most first) and set it off.
  const pokeAt = useCallback(
    (x: number, y: number, keyboard?: string): void => {
      const world = worldRef.current;
      if (!world) return;
      const now = performance.now();
      const targets = farmTargets(world, playRef.current, now, now);
      const hit = keyboard
        ? (targets.find((t) => t.id === keyboard) ?? null)
        : targetAt(targets, x, y);
      const play = playRef.current;
      const farm = world.farm;
      let said: string;
      if (hit) {
        // Animals and critters react where they stand; the pond where the
        // water is (a click on its stones flicks a pebble in from there);
        // anything else where it was clicked.
        const clicked = keyboard ? hit.anchor : { x, y };
        const standing = ["hen", "cat", "shiba", "critter", "coordinator"].includes(hit.kind);
        const water = hit.kind === "pond" ? nearestWater(farm, clicked.x, clicked.y) : null;
        const at = standing ? hit.anchor : (water ?? clicked);
        const flicked =
          water && (Math.abs(water.x - clicked.x) > 2 || Math.abs(water.y - clicked.y) > 2);
        said = poke(
          play,
          {
            target: hit.id,
            kind: hit.kind,
            name: hit.name,
            x: at.x,
            y: at.y,
            from: flicked ? clicked : undefined,
          },
          now,
          Math.floor(Math.random() * 1e6),
        );
        if (LIGHTS.has(hit.kind)) setLightsVersion((v) => v + 1);
        // A poked critter's tag stays up a moment.
        if (standing && hit.id.startsWith("critter:"))
          farmStageRef.current?.pin(hit.id.slice(8), now);
      } else {
        const i = Math.floor(y) * farm.width + Math.floor(x);
        const atmo = atmosphereRef.current;
        const base = basePixelsRef.current;
        const ground = groundAt(
          farm.surface[i] ?? 0,
          base?.rgb(Math.floor(x), Math.floor(y)) ?? 0,
          atmo?.puddles?.[i] === 1,
          (atmo?.look.falling === "snow" || snowLying) && (farm.surface[i] ?? 0) !== SURFACE.water,
        );
        said = poke(
          play,
          {
            target: `ground-${Math.floor(x)}-${Math.floor(y)}`,
            kind: "ground",
            name: "ground",
            x,
            y,
            ground,
          },
          now,
          Math.floor(Math.random() * 1e6),
        );
      }
      // Whatever the poke knocks loose falls onto the farm and lies there a while.
      const latest = play.reactions[play.reactions.length - 1];
      if (latest) {
        addDebris(play, spawnDebris(farm, latest));
        soundsRef.current?.play(latest);
      }
      setPokeSaid(said);
      setLightsOff(new Set(play.lightsOff));
    },
    [snowLying],
  );
  // The pointer, in map pixels: the canvas is scaled and centred by CSS.
  const toMap = (event: { clientX: number; clientY: number }): Spot | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>): void => {
    if (event.pointerType !== "mouse") return;
    playRef.current.hover = toMap(event);
  };
  const onPointerLeave = (): void => {
    playRef.current.hover = null;
    setHoverName(null);
  };
  const onClick = (event: MouseEvent<HTMLCanvasElement>): void => {
    const at = toMap(event);
    if (at) pokeAt(at.x, at.y);
  };
  // The things a keyboard user can poke, listed as buttons for screen readers
  // and Tab (refreshed when the farm or the crew changes).
  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    const seen = new Set<string>();
    setPokeables(
      farmTargets(world, null, 0, 0)
        .filter((t) => {
          // One button per named thing that isn't a bush or a stone (there are dozens).
          if (t.kind === "bush" || t.kind === "stone") return false;
          if (seen.has(t.id)) return false;
          seen.add(t.id);
          return true;
        })
        .map((t) => ({ id: t.id, name: t.name, kind: t.kind })),
    );
  }, [farmVersion, agents]);
  // The latest agents, for a farm built after they arrive (a stage that was
  // hidden at first gets its farm on its first resize).
  const agentsRef = useRef(agents);
  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (): void => setReduced(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // Fit the farm to the stage: the whole farmstead in view below the header,
  // the map covering the stage edge to edge. The map is rebuilt only when its
  // tile size changes; the scale just restyles the canvas. A drag-resize
  // waits for the window to settle.
  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    let timer = 0;
    let swayTimer = 0;
    const fit = (): void => {
      const { clientWidth, clientHeight } = stage;
      if (clientWidth === 0 || clientHeight === 0) return;
      const head = headerRef?.current?.offsetHeight ?? 0;
      setHeadHeight(head);
      const f = fitFarm(clientWidth, clientHeight, head);
      const key = `${seed}:${f.cols}x${f.rows}:${f.top}`;
      if (key !== fitKeyRef.current || !worldRef.current || !backgroundRef.current) {
        fitKeyRef.current = key;
        const farm = buildFarm({ cols: f.cols, rows: f.rows, top: f.top, seed });
        canvas.width = farm.width;
        canvas.height = farm.height;
        const pixels = composeMap(farm.scene);
        basePixelsRef.current = pixels;
        backgroundRef.current = canvasOf(pixels);
        occludersRef.current = paintOccluders(farm);
        if (worldRef.current) resizeFarm(worldRef.current, farm);
        else {
          worldRef.current = createFarmWorld(farm, Math.random);
          syncFarm(worldRef.current, agentsRef.current, performance.now());
        }
        // The map without its trees and bushes, for one swaying in place:
        // painted just after the farm appears, off its first frame.
        playRef.current.swayBase = null;
        swayPixelsRef.current = null;
        window.clearTimeout(swayTimer);
        swayTimer = window.setTimeout(() => {
          if (fitKeyRef.current !== key) return;
          swayPixelsRef.current = {
            farm,
            pixels: paintSwayBase(farm),
            surface: swaySurface(farm),
          };
          gradeSwayRef.current?.();
        }, SWAY_BASE_DELAY_MS);
        setFarmVersion((v) => v + 1);
      }
      // Scale the canvas up, and centre it so any overhang (under a tile) is
      // split between the edges.
      const w = Math.round(canvas.width * f.scale);
      const h = Math.round(canvas.height * f.scale);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.style.left = `${Math.round((clientWidth - w) / 2)}px`;
      canvas.style.top = `${Math.round((clientHeight - h) / 2)}px`;
    };
    fit();
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(fit, REFIT_DELAY_MS);
    });
    observer.observe(stage);
    // The header grows or shrinks (nav shown or hidden): re-fit then too.
    const header = headerRef?.current;
    if (header) observer.observe(header);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(swayTimer);
      observer.disconnect();
    };
  }, [seed, headerRef]);

  // Feed agent changes to the farm as they happen.
  useEffect(() => {
    const world = worldRef.current;
    if (world) syncFarm(world, agents, performance.now());
  }, [agents]);

  // One frame loop, and only while the window is in view. A hidden window
  // draws nothing. Reduced motion is a still picture (everyone where they are
  // working, the fire and water at rest). A window that's visible but not
  // focused runs the farm exactly as a focused one does: it's something to
  // glance at beside other work, so nothing slows, rests or walks on the spot.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { runs, ambientStill } = farmMotion(motionLevel, reduced);
    if (!runs) return;
    const paint = (now: number): void => {
      const world = worldRef.current;
      const background = backgroundRef.current;
      if (!world || !background) return;
      // Reduced motion keeps the stage's tag and nothing else of it.
      if (!reduced) farmStageRef.current?.before(now);
      stepFarm(world, now, reduced);
      // A change of light or weather fades over a few seconds (at once with reduced motion).
      const was = fadeRef.current;
      const t = was && !reduced ? (now - was.start) / LOOK_FADE_MS : 1;
      if (t >= 1) fadeRef.current = null;
      scratchRef.current ??= document.createElement("canvas");
      const play = playRef.current;
      settlePlay(play, now);
      // Things in use come alive (a still picture, with reduced motion).
      if (!ambientStill) {
        const started = playUses(play, stationThings(world.farm), stationsInUse(world), now);
        for (const use of started) soundsRef.current?.play(use);
      }
      drawFarm(
        ctx,
        background,
        world,
        now,
        ambientStill ? 0 : now,
        occludersRef.current,
        atmosphereRef.current,
        was && t < 1 ? { ...was, t: Math.max(0, t) } : null,
        scratchRef.current,
        play,
      );
      // The part of the map in view below the header, for the tag to keep inside.
      const shown = canvas.clientWidth / canvas.width || 1;
      const head = headerRef?.current?.offsetHeight ?? 0;
      farmStageRef.current?.draw(
        ctx,
        now,
        play,
        {
          x0: Math.max(0, -canvas.offsetLeft / shown),
          x1: Math.min(
            canvas.width,
            ((canvas.parentElement?.clientWidth ?? 0) - canvas.offsetLeft) / shown,
          ),
          y0: Math.max(0, (head - canvas.offsetTop) / shown),
        },
        reduced,
      );
      // The cursor and the name of whatever the pointer's over. A critter
      // wears its tag instead, so it gets no tooltip as well.
      canvas.style.cursor = play.hovered ? "pointer" : "";
      const name =
        play.hovered && !play.hovered.startsWith("critter:")
          ? (farmTargets(world, play, now, ambientStill ? 0 : now).find(
              (x) => x.id === play.hovered,
            )?.name ?? null)
          : null;
      setHoverName((was) => (was === name ? was : name));
    };
    if (reduced) {
      paint(performance.now());
      const id = window.setInterval(() => paint(performance.now()), 600);
      return () => window.clearInterval(id);
    }
    // ~30fps while someone walks (focused or not); ~20fps while rain or
    // snow falls; ~10fps while the farm just idles (the fire, the koi, the
    // petals), which is all that pixel art needs.
    let frame = 0;
    let last = 0;
    const tick = (now: number): void => {
      const world = worldRef.current;
      const moving = world !== null && farmIsMoving(world);
      const falling = !ambientStill && atmosphereRef.current?.look.falling;
      const fading = fadeRef.current !== null;
      const play = playRef.current;
      const busy =
        playing(play, now) || play.hover !== null || farmStageRef.current?.busy() === true;
      // Something in use animates at the weather's rate: smooth enough for a
      // hammer or a scrolling screen, without the full rate's cost.
      const using = usesNeedPace(play, now);
      const interval = moving || fading || busy ? 32 : falling || using ? 50 : 100;
      if (now - last >= interval) {
        last = now;
        paint(now);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [motionLevel, reduced, seed, headerRef]);

  return (
    <section
      className="goal-world"
      aria-label="Workers"
      style={{ "--goal-head": `${headHeight}px` } as React.CSSProperties}
    >
      <div ref={stageRef} className="goal-world-stage">
        {/* Pointer play only: keyboard and screen-reader users poke things with the buttons below. */}
        <canvas
          ref={canvasRef}
          className="goal-world-canvas"
          data-ready={farmVersion > 0 ? "" : undefined}
          aria-hidden="true"
          title={hoverName ?? undefined}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          onClick={onClick}
        />
      </div>
      <div className="goal-world-pokes" role="group" aria-label="Things on the farm">
        {pokeables.map((t) => (
          <button
            key={t.id}
            type="button"
            className="goal-world-poke"
            onFocus={() => {
              playRef.current.focus = t.id;
            }}
            onBlur={() => {
              playRef.current.focus = null;
            }}
            onClick={() => pokeAt(0, 0, t.id)}
          >
            {LIGHTS.has(t.kind as ThingKind)
              ? `${t.name}: ${lightsOff.has(t.id) ? "turn on" : "turn off"}`
              : t.name}
          </button>
        ))}
      </div>
      {shownAsk && (
        <GoalAskNotice
          question={shownAsk.question}
          more={shownAsk.more}
          onAnswer={shownAsk.onAnswer}
        />
      )}
      {finish && !shownAsk && (
        <GoalFinishCard
          finish={finish}
          onShowChat={() => onShowChat?.()}
          onClose={() => onCloseFinish?.()}
        />
      )}
      <KenDialogue
        said={kenSaid}
        workers={workers}
        paused={signUp}
        held={statusHovered}
        reducedMotion={reduced}
        onShownChange={setKenTalking}
      />
      {kenStatus && (
        <KenStatus
          status={kenStatus}
          away={signUp || kenTalking}
          reducedMotion={reduced}
          onHoverChange={setStatusHovered}
        />
      )}
      <p className="sr-only goal-world-summary" aria-live="polite">
        {summary}
      </p>
      <p className="sr-only" aria-live="polite">
        {pokeSaid}
      </p>
    </section>
  );
}
