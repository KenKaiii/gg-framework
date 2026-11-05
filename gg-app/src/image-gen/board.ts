// Pure state for the image-generation loading card: the progress estimate, the
// status phrase, the dot board's brightness and a small game of Snake on it.

export type Cell = { x: number; y: number };
export type Dir = "up" | "down" | "left" | "right";

export type Snake = {
  cols: number;
  rows: number;
  /** Head first. */
  body: Cell[];
  dir: Dir;
  /** Turns pressed faster than the snake moves, applied one per step. */
  queued: Dir[];
  food: Cell | null;
  score: number;
  alive: boolean;
};

/** The backend reports no progress, so this is an estimate from typical times. */
const TYPICAL_MS = { image: 12_000, gif: 25_000 };
/** Never claim done before the image is: the card leaves when it lands. */
const PROGRESS_CEILING = 0.95;

export function estimateProgress(elapsedMs: number, gif: boolean): number {
  const tau = gif ? TYPICAL_MS.gif : TYPICAL_MS.image;
  const fraction = PROGRESS_CEILING * (1 - Math.exp(-Math.max(0, elapsedMs) / tau));
  return Math.floor(fraction * 100);
}

const PHRASES = {
  image: ["Creating image", "Sketching the layout", "Adding detail", "Finishing touches"],
  gif: ["Creating GIF", "Drawing the frames", "Lining up the loop", "Stitching the GIF"],
};
const PHRASE_AT_MS = [0, 6_000, 14_000, 24_000];

export function phraseFor(elapsedMs: number, gif: boolean): string {
  const phrases = gif ? PHRASES.gif : PHRASES.image;
  let index = 0;
  for (let i = 0; i < PHRASE_AT_MS.length; i++) {
    if (elapsedMs >= (PHRASE_AT_MS[i] ?? Infinity)) index = i;
  }
  return phrases[index] ?? phrases[0]!;
}

/** A stable 0..1 value per cell, so the board fills in a scattered order. */
export function cellSeed(x: number, y: number): number {
  let h = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Brightness of one dot (0..1). Cells "develop" as progress grows; a soft
 * diagonal wave runs over the board while it moves. `timeMs` null is the rest pose.
 */
export function dotLevel(x: number, y: number, progress: number, timeMs: number | null): number {
  const developed = cellSeed(x, y) < progress / 100;
  const base = developed ? 0.5 : 0.16;
  if (timeMs === null) return base;
  const wave = 0.5 + 0.5 * Math.sin(timeMs / 650 - (x + y) * 0.42);
  return Math.min(1, base + 0.3 * wave ** 3);
}

const STEP: Record<Dir, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const OPPOSITE: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };

const same = (a: Cell, b: Cell): boolean => a.x === b.x && a.y === b.y;

function placeFood(cols: number, rows: number, body: Cell[], random: () => number): Cell | null {
  const free: Cell[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!body.some((part) => part.x === x && part.y === y)) free.push({ x, y });
    }
  }
  if (free.length === 0) return null;
  return free[Math.floor(random() * free.length)] ?? null;
}

export function newSnake(cols: number, rows: number, random: () => number = Math.random): Snake {
  const y = Math.floor(rows / 2);
  const x = Math.max(2, Math.floor(cols / 3));
  const body = [
    { x, y },
    { x: x - 1, y },
    { x: x - 2, y },
  ];
  return {
    cols,
    rows,
    body,
    dir: "right",
    queued: [],
    food: placeFood(cols, rows, body, random),
    score: 0,
    alive: true,
  };
}

/** Queue a turn; a reversal into the snake's own neck is ignored. */
export function turn(snake: Snake, dir: Dir): Snake {
  const last = snake.queued[snake.queued.length - 1] ?? snake.dir;
  if (dir === last || dir === OPPOSITE[last] || snake.queued.length >= 3) return snake;
  return { ...snake, queued: [...snake.queued, dir] };
}

export function stepSnake(snake: Snake, random: () => number = Math.random): Snake {
  if (!snake.alive) return snake;
  const [nextDir = snake.dir, ...queued] = snake.queued;
  const head = snake.body[0]!;
  const next = { x: head.x + STEP[nextDir].x, y: head.y + STEP[nextDir].y };
  const eats = snake.food !== null && same(next, snake.food);
  // The tail moves away this step unless the snake grows, so it is not in the way.
  const blocking = eats ? snake.body : snake.body.slice(0, -1);
  const hitsWall = next.x < 0 || next.y < 0 || next.x >= snake.cols || next.y >= snake.rows;
  if (hitsWall || blocking.some((part) => same(part, next))) {
    return { ...snake, dir: nextDir, queued, alive: false };
  }
  const body = [next, ...blocking];
  const food = eats ? placeFood(snake.cols, snake.rows, body, random) : snake.food;
  return {
    ...snake,
    body,
    dir: nextDir,
    queued,
    food,
    score: eats ? snake.score + 1 : snake.score,
    // A board with no room left for food is a finished game.
    alive: food !== null,
  };
}

const KEY_DIRS: Record<string, Dir> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
  W: "up",
  S: "down",
  A: "left",
  D: "right",
};

export function dirForKey(key: string): Dir | undefined {
  return KEY_DIRS[key];
}
