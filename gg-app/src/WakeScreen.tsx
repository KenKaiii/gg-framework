import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CritterTerrain } from "./CritterTerrain";
import { CRITTER_CELLS, CRITTERS, renderCritterFrame, type CritterDef } from "./critter-sprites";
import {
  DECOR_COLS,
  TERRAIN_FLOOR_ROW,
  TERRAIN_PX,
  TERRAIN_ROWS,
  renderTerrain,
  weatherParticles,
  type Biome,
} from "./critter-terrain";
import { useRandomBiome } from "./use-random-biome";

/**
 * The empty-state "wake" screen: a critter on a little patch of terrain types
 * a greeting into its own speech bubble, then rests on the invitation with a
 * blinking cursor, while the terrain's weather drifts slowly across the
 * screen. The terrain is picked at random (never the one shown last), and so
 * are the critter and which set of lines it says. Click the critter and it
 * hops and says hi.
 *
 * Calm on purpose: the critter only breathes, blinks and now and then looks
 * the other way. Honors `prefers-reduced-motion`: no typing, hopping or
 * weather, and the final line is shown straight away. The whole thing is gone
 * once the first prompt is sent (the parent stops rendering it).
 */

export type WakeMode = "code" | "chat" | "motion" | "goals";

/**
 * Five sets per mode, so a new session doesn't always open the same way. Each
 * set types line by line (each replaces the last); its final line is the
 * resting invitation and stays.
 */
export const WAKE_LINES = {
  code: [
    [
      "*yawn*\u2026 oh, hi!",
      "The critters are stretching their legs.",
      "What are we building today?",
    ],
    ["Psst\u2026", "The codebase is all warmed up.", "What should we make?"],
    ["Oh! A visitor.", "Tools sharpened, snacks packed.", "What are we coding today?"],
    ["*stretches*\u2026", "Ready when you are.", "What\u2019s the plan?"],
    ["Hi hi!", "Every critter is at its desk.", "Where should we start?"],
  ],
  chat: [
    ["Kettle\u2019s on\u2026", "Pull up a cushion.", "What\u2019s on your mind?"],
    ["Oh, hello!", "The cozy corner is free.", "What shall we talk about?"],
    ["*settles in*\u2026", "No rush at all.", "What are you thinking about?"],
    ["Hey there.", "I saved you a seat.", "What\u2019s on your mind today?"],
    ["Hi!", "The critters are all ears.", "Tell me anything."],
  ],
  motion: [
    [
      "Lights\u2026",
      "The critters are setting up the stage.",
      "Tell me what to make. Let\u2019s make it move.",
    ],
    ["Curtains up!", "Drop in a website, a PDF, or an idea.", "What should we animate?"],
    ["*taps the mic*\u2026", "The stage is set.", "What are we bringing to life?"],
    ["Ooh, showtime?", "Cameras are rolling.", "What should we make move?"],
    ["Hi!", "Got a page, a PDF, or a doodle?", "Let\u2019s make it move."],
  ],
  // GG Goals speaks first on a new goal, so these show while it reads the
  // brief and the context, before its first words arrive.
  goals: [
    [
      "*unrolls the map*\u2026",
      "GG Goals is reading your goal.",
      "Back in a moment with questions.",
    ],
    [
      "Oh, a big one!",
      "GG Goals is looking through your context.",
      "I\u2019ll check in before we start.",
    ],
    [
      "*sharpens pencil*\u2026",
      "GG Goals is sizing up the goal.",
      "Let\u2019s make sure we agree first.",
    ],
    ["Hi!", "GG Goals is getting the lay of the land.", "Questions incoming."],
    ["*opens notebook*\u2026", "GG Goals is taking notes.", "We\u2019ll plan it together."],
  ],
} as const satisfies Record<WakeMode, readonly (readonly string[])[]>;

/** What the critter says when poked. */
const POKE_LINES = ["hi!", "\u266A", "hehe", "!", "<3", "boop"] as const;

const TYPE_MS = 55; // per-character type speed
const HOLD_MS = 1400; // pause once a line finishes typing
const ERASE_MS = 22; // per-character erase speed
const FIRST_KEY_MS = 450; // brief beat before the first keystroke
const POKE_MS = 1400; // how long a poke's bubble stays up

/** Visible width of the terrain patch, in cells. */
export const PATCH_COLS = 85;
/** Weather particles across the screen: few, so it stays calm. */
const WEATHER_COUNT = 34;
/** Screen weather runs this many times slower than a lane's. */
const WEATHER_SLOWDOWN = 2.6;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** A random member of a non-empty list. */
function pick<T>(list: readonly T[], random: () => number): T {
  const item = list[Math.floor(random() * list.length)] ?? list[0];
  if (item === undefined) throw new Error("pick from an empty list");
  return item;
}

/**
 * The middle of the widest stretch of ground with nothing standing in it, as
 * a column on the repeating decor strip, so no tree or umbrella sits behind
 * the critter. Props sunk into the ground, or floating well above the critter,
 * don't count.
 */
export function clearSpot(biome: Biome): number {
  const floor = TERRAIN_ROWS - TERRAIN_FLOOR_ROW;
  const blockers = renderTerrain(biome)
    .props.filter((p) => p.layer !== "sunk" && p.bottom - floor < CRITTER_CELLS + 4)
    .map((p) => [p.x, p.x + p.width] as const)
    .sort((a, b) => a[0] - b[0]);
  const first = blockers[0];
  if (!first) return DECOR_COLS / 2;
  let best = { width: -1, middle: DECOR_COLS / 2 };
  blockers.forEach(([, end], i) => {
    // The strip repeats, so the last gap wraps round to the first prop.
    const next = blockers[i + 1]?.[0] ?? first[0] + DECOR_COLS;
    if (next - end > best.width) best = { width: next - end, middle: (end + next) / 2 };
  });
  return best.middle % DECOR_COLS;
}

/**
 * How far to slide the terrain (in cells, never positive) so `spot` lands in
 * the middle of the patch with ground on both sides of it.
 */
export function patchOffset(spot: number): number {
  let offset = PATCH_COLS / 2 - spot;
  while (offset > 0) offset -= DECOR_COLS;
  while (offset <= -DECOR_COLS) offset += DECOR_COLS;
  return Math.round(offset);
}

/**
 * The same critter with its eyes shut, for blinks. An eye is a clump of
 * shine (W) and pupil (K) cells: it fills with the skin round it, and its
 * bottom row becomes the lid line. Critters with glowing eyes and no shine
 * (the robot's screen, the wizard and knight under their hats) dim their top
 * row of glow (E) instead.
 */
export function withEyesClosed(critter: CritterDef): CritterDef {
  const grid = critter.rows.map((row) => [...row]);
  const h = grid.length;
  const at = (x: number, y: number): string => grid[y]?.[x] ?? ".";
  const seen = new Set<string>();
  let changed = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < (grid[y]?.length ?? 0); x++) {
      if (at(x, y) !== "W" || seen.has(`${x},${y}`)) continue;
      // The eye: W and K cells joined to this shine.
      const eye: [number, number][] = [];
      const stack: [number, number][] = [[x, y]];
      seen.add(`${x},${y}`);
      while (stack.length) {
        const [cx, cy] = stack.pop() ?? [0, 0];
        eye.push([cx, cy]);
        for (const [nx, ny] of [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ] as const) {
          const k = at(nx, ny);
          if ((k === "W" || k === "K") && !seen.has(`${nx},${ny}`)) {
            seen.add(`${nx},${ny}`);
            stack.push([nx, ny]);
          }
        }
      }
      // The skin round it: its commonest neighbour that's part of the face.
      const count = new Map<string, number>();
      for (const [cx, cy] of eye) {
        for (const [nx, ny] of [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ] as const) {
          const k = at(nx, ny);
          if (!"WKOCMN.".includes(k)) count.set(k, (count.get(k) ?? 0) + 1);
        }
      }
      const skin = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "B";
      const bottom = Math.max(...eye.map(([, ey]) => ey));
      for (const [cx, cy] of eye) {
        const row = grid[cy];
        if (row) row[cx] = cy === bottom ? "O" : skin;
      }
      changed = true;
    }
  }
  if (!changed) {
    // Glowing eyes: the top row of glow goes dark.
    const top = grid.findIndex((row) => row.includes("E"));
    const row = grid[top];
    if (row) {
      for (let x = 0; x < row.length; x++) if (row[x] === "E") row[x] = "K";
      changed = true;
    }
  }
  return changed ? { ...critter, rows: grid.map((row) => row.join("")) } : critter;
}

/**
 * Types each line, holds, erases it, and rests on the last one. Returns the
 * text so far and whether it has come to rest.
 */
function useTypedLines(
  lines: readonly string[],
  reduced: boolean,
): { text: string; done: boolean } {
  const last = lines[lines.length - 1] ?? "";
  const [state, setState] = useState(() =>
    reduced ? { text: last, done: true } : { text: "", done: false },
  );

  useEffect(() => {
    if (reduced) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let line = 0;
    let pos = 0;
    let phase: "typing" | "holding" | "erasing" = "typing";

    function tick(): void {
      if (cancelled) return;
      const full = lines[line] ?? "";
      if (phase === "typing") {
        pos++;
        const done = pos >= full.length && line === lines.length - 1;
        setState({ text: full.slice(0, pos), done });
        if (done) return; // rest here: the invitation stays
        if (pos >= full.length) {
          phase = "holding";
          timer = setTimeout(tick, HOLD_MS);
        } else {
          timer = setTimeout(tick, TYPE_MS);
        }
        return;
      }
      if (phase === "holding") {
        phase = "erasing";
        timer = setTimeout(tick, ERASE_MS);
        return;
      }
      pos--;
      setState({ text: full.slice(0, Math.max(0, pos)), done: false });
      if (pos <= 0) {
        line++;
        phase = "typing";
        timer = setTimeout(tick, TYPE_MS * 4);
      } else {
        timer = setTimeout(tick, ERASE_MS);
      }
    }

    timer = setTimeout(tick, FIRST_KEY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lines, reduced]);

  return state;
}

/**
 * Blinks every few seconds and now and then turns to look the other way. Both
 * stop for reduced motion.
 */
function useIdleLife(reduced: boolean, random: () => number): { blink: boolean; flip: boolean } {
  const [blink, setBlink] = useState(false);
  const [flip, setFlip] = useState(false);
  useEffect(() => {
    if (reduced) return;
    let blinkTimer: ReturnType<typeof setTimeout>;
    let lookTimer: ReturnType<typeof setTimeout>;
    const nextBlink = (): void => {
      blinkTimer = setTimeout(
        () => {
          setBlink(true);
          blinkTimer = setTimeout(() => {
            setBlink(false);
            nextBlink();
          }, 140);
        },
        2600 + random() * 3200,
      );
    };
    const nextLook = (): void => {
      lookTimer = setTimeout(
        () => {
          setFlip((f) => !f);
          nextLook();
        },
        7000 + random() * 4000,
      );
    };
    nextBlink();
    nextLook();
    return () => {
      clearTimeout(blinkTimer);
      clearTimeout(lookTimer);
    };
  }, [reduced, random]);
  return { blink, flip };
}

/** CSS custom properties alongside the regular style keys. */
type Style = React.CSSProperties & Record<`--${string}`, string>;

/** The terrain's weather, slowed down and spread faintly across the screen. */
function WakeWeather({ biome }: { biome: Biome }): React.ReactElement | null {
  const particles = useMemo(() => weatherParticles(biome, WEATHER_COUNT), [biome]);
  if (!biome.weather) return null;
  return (
    <div className={`wake-weather wake-wx-${biome.weather.kind}`} aria-hidden="true">
      {particles.map((p, i) => {
        const style: Style = {
          left: `${p.left}%`,
          top: `${p.y * 100}%`,
          width: `${p.size * 2}px`,
          height: `${p.size * 2}px`,
          background: p.color,
          animationDuration: `${(p.duration * WEATHER_SLOWDOWN).toFixed(2)}s`,
          animationDelay: `${(p.delay * WEATHER_SLOWDOWN).toFixed(2)}s`,
          "--drift": `${p.drift}px`,
        };
        return <i key={i} style={style} />;
      })}
    </div>
  );
}

export function WakeScreen({
  chat = false,
  motion = false,
  goals = false,
  random = Math.random,
}: {
  chat?: boolean;
  motion?: boolean;
  /** A Goal window, where GG Goals is the agent. */
  goals?: boolean;
  /** Injected for tests; defaults to Math.random. */
  random?: () => number;
}): React.ReactElement {
  const reduced = prefersReducedMotion();
  const mode: WakeMode = goals ? "goals" : motion ? "motion" : chat ? "chat" : "code";
  const [biome] = useRandomBiome(random);
  // One critter and one set of lines per screen, picked once.
  const [critter] = useState(() => pick(CRITTERS, random));
  const [setIndex] = useState(() => Math.floor(random() * WAKE_LINES[mode].length));
  const lines = WAKE_LINES[mode][setIndex] ?? WAKE_LINES[mode][0];

  const { text, done } = useTypedLines(lines, reduced);
  const { blink, flip } = useIdleLife(reduced, random);
  const open = useMemo(() => renderCritterFrame(critter, 0), [critter]);
  const shut = useMemo(() => renderCritterFrame(withEyesClosed(critter), 0), [critter]);
  const offset = useMemo(() => patchOffset(clearSpot(biome)), [biome]);

  // Open the terrain a frame after mounting, so its ground rises and its
  // props sprout in (the lane's own entrance), then the critter pops in.
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpened(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Poke: a hop (restarted by remounting the body) and a short reply that
  // takes over the bubble for a moment.
  const [hops, setHops] = useState(0);
  const [poke, setPoke] = useState<string | null>(null);
  const pokeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onPoke = useCallback(() => {
    if (!reduced) setHops((h) => h + 1);
    setPoke(pick(POKE_LINES, random));
    clearTimeout(pokeTimer.current);
    pokeTimer.current = setTimeout(() => setPoke(null), POKE_MS);
  }, [reduced, random]);
  useEffect(() => () => clearTimeout(pokeTimer.current), []);

  const laneStyle: Style = {
    left: `${offset * TERRAIN_PX}px`,
    width: `${(PATCH_COLS + DECOR_COLS) * TERRAIN_PX}px`,
  };

  // The critter's box and everything placed round it (the bubble, the art's
  // height) follow the sprite's real size, so a resized sprite never squashes.
  const sceneStyle: Style = { "--wake-critter": `${CRITTER_CELLS * TERRAIN_PX}px` };

  return (
    <div className="wake-screen transcript-reveal" aria-label="Ready to start">
      {!reduced && <WakeWeather biome={biome} />}
      <div className="wake-scene" style={sceneStyle}>
        <p className="wake-bubble">
          <span className="wake-bubble-text">{poke ?? text}</span>
          {poke === null && (
            <span className={`wake-cursor${done ? " wake-cursor-rest" : ""}`} aria-hidden="true" />
          )}
        </p>
        {/* Pixel art drawn at the terrain's native size, then scaled up 2x. */}
        <div className="wake-art" style={{ width: `${PATCH_COLS * TERRAIN_PX}px` }}>
          <div className="wake-patch" aria-hidden="true">
            <div
              className={`critter-lane with-terrain wake-lane${opened ? " open" : ""}`}
              style={laneStyle}
            >
              <CritterTerrain biome={biome} />
            </div>
          </div>
          <button
            type="button"
            className="wake-critter"
            onClick={onPoke}
            aria-label={`Say hi to the ${critter.name}`}
          >
            <span className="critter-shadow" />
            <span key={hops} className={`wake-critter-body${hops > 0 ? " wake-hop" : ""}`}>
              <img
                src={blink ? shut : open}
                alt=""
                draggable={false}
                style={flip ? { transform: "scaleX(-1)" } : undefined}
              />
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
