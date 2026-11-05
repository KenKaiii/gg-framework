import { useEffect, useRef, useState } from "react";
import { useMotionLevel } from "../window-motion";
import { prefersReducedMotion } from "../transcript-motion";
import {
  dirForKey,
  dotLevel,
  estimateProgress,
  newSnake,
  phraseFor,
  stepSnake,
  turn,
  type Snake,
} from "./board";

/** Board cell size in CSS px. */
const CELL = 16;
/** Snake moves this often. */
const SNAKE_STEP_MS = 140;
/** Progress and phrase refresh. */
const CLOCK_MS = 250;

type Colors = { dot: string; snake: string; food: string };

function readColors(el: Element): Colors {
  const style = getComputedStyle(el);
  const read = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    dot: read("--secondary", "#8fa3ff"),
    snake: read("--primary", "#8fa3ff"),
    food: read("--text", "#e8ebef"),
  };
}

function durationMs(el: Element, token: string): number {
  const value = getComputedStyle(el).getPropertyValue(token).trim();
  const parsed = parseFloat(value) * (value.endsWith("ms") ? 1 : 1000);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The placeholder a generate_image call shows until its image lands: a dot
 * board that fills in as the (estimated) progress grows, with a game of Snake
 * to play on the same grid while you wait.
 */
export function ImageGenCard({
  prompt,
  gif,
  startedAt,
}: {
  prompt: string;
  gif: boolean;
  startedAt: number;
}): React.ReactElement {
  const motion = useMotionLevel();
  const [now, setNow] = useState(() => Date.now());
  const elapsed = now - startedAt;
  const progress = estimateProgress(elapsed, gif);
  const phrase = phraseFor(elapsed, gif);

  const [shown, setShown] = useState(phrase);
  const [changing, setChanging] = useState(false);
  const [snake, setSnake] = useState<Snake | null>(null);
  const [playing, setPlaying] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const snakeRef = useRef<Snake | null>(null);
  const progressRef = useRef(progress);
  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  // The estimate keeps counting with motion off; only the board's animation pauses.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Fade the old phrase out, swap, fade the new one in.
  useEffect(() => {
    if (phrase === shown) return;
    const el = stageRef.current;
    const wait = el && !prefersReducedMotion() ? durationMs(el, "--dur-dissolve") : 0;
    setChanging(true);
    const timer = window.setTimeout(() => {
      setShown(phrase);
      setChanging(false);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [phrase, shown]);

  // Without a running loop, repaint the rest pose as progress grows.
  const stillProgress = motion !== "full" && !playing ? progress : -1;

  // Draw the board: animated while the window is in front or a game runs,
  // one still frame otherwise.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduced = prefersReducedMotion();
    let frame = 0;
    let lastStep = performance.now();
    let colors = readColors(canvas);

    const draw = (time: number, animate: boolean): void => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        colors = readColors(canvas);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const game = snakeRef.current;
      // A running game keeps the grid it started on, even if the window resizes.
      const cols = game?.cols ?? Math.max(4, Math.floor(width / CELL));
      const rows = game?.rows ?? Math.max(4, Math.floor(height / CELL));
      const left = (width - cols * CELL) / 2;
      const top = (height - rows * CELL) / 2;

      ctx.fillStyle = colors.dot;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const level = dotLevel(x, y, progressRef.current, animate ? time : null);
          ctx.globalAlpha = game ? level * 0.45 : level;
          ctx.beginPath();
          ctx.arc(left + x * CELL + CELL / 2, top + y * CELL + CELL / 2, 1 + level * 1.6, 0, 7);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      if (!game) return;
      if (game.food) {
        ctx.fillStyle = colors.food;
        ctx.beginPath();
        ctx.arc(left + game.food.x * CELL + CELL / 2, top + game.food.y * CELL + CELL / 2, 4, 0, 7);
        ctx.fill();
      }
      ctx.fillStyle = colors.snake;
      game.body.forEach((part, i) => {
        ctx.globalAlpha = game.alive ? 1 - (i / game.body.length) * 0.45 : 0.4;
        const [x, y, size] = [left + part.x * CELL + 2, top + part.y * CELL + 2, CELL - 4];
        // roundRect is missing from older WebKitGTK; a square segment still plays.
        if (typeof ctx.roundRect === "function") {
          ctx.beginPath();
          ctx.roundRect(x, y, size, size, 4);
          ctx.fill();
        } else {
          ctx.fillRect(x, y, size, size);
        }
      });
      ctx.globalAlpha = 1;
    };

    const loop = (time: number): void => {
      const game = snakeRef.current;
      if (game && playing && game.alive && time - lastStep >= SNAKE_STEP_MS) {
        lastStep = time;
        const next = stepSnake(game);
        snakeRef.current = next;
        setSnake(next);
      }
      draw(time, !reduced);
      frame = requestAnimationFrame(loop);
    };

    if (motion === "full" || playing) {
      frame = requestAnimationFrame(loop);
    } else {
      draw(0, false);
    }
    return () => cancelAnimationFrame(frame);
  }, [motion, playing, stillProgress]);

  const start = (): void => {
    const canvas = canvasRef.current;
    const cols = Math.max(4, Math.floor((canvas?.clientWidth ?? 256) / CELL));
    const rows = Math.max(4, Math.floor((canvas?.clientHeight ?? 256) / CELL));
    const fresh = newSnake(cols, rows);
    snakeRef.current = fresh;
    setSnake(fresh);
    setPlaying(true);
  };

  const stop = (): void => {
    setPlaying(false);
    snakeRef.current = null;
    setSnake(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!playing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      stop();
      return;
    }
    const dir = dirForKey(e.key);
    const game = snakeRef.current;
    if (!dir || !game) return;
    e.preventDefault();
    const next = turn(game, dir);
    snakeRef.current = next;
    setSnake(next);
  };

  const gameOver = playing && snake !== null && !snake.alive;
  const label = !playing
    ? `Play Snake while your ${gif ? "GIF" : "image"} is generating`
    : gameOver
      ? `Game over, score ${snake?.score ?? 0}. Press to play again`
      : "Snake: steer with the arrow keys, Escape to stop";

  return (
    <figure className="img-card img-gen-card" aria-busy="true">
      <div className="img-gen-stage" ref={stageRef}>
        <div className="img-gen-board">
          <canvas ref={canvasRef} className="img-gen-canvas" aria-hidden="true" />
          <button
            type="button"
            className="img-gen-play"
            aria-label={label}
            onClick={(e) => {
              // WebKit does not focus a clicked button, and the keys go to the focus.
              e.currentTarget.focus();
              if (!playing || gameOver) start();
            }}
            onKeyDown={onKeyDown}
            onBlur={stop}
          />
          {gameOver && (
            <span className="img-gen-over" aria-hidden="true">
              Score {snake?.score ?? 0}. Click to play again
            </span>
          )}
        </div>
        <span className="img-gen-phrase" data-changing={changing || undefined}>
          {shown}
        </span>
        {playing && snake && (
          <span className="img-gen-score" aria-hidden="true">
            {snake.score}
          </span>
        )}
        <span className="img-gen-progress" aria-hidden="true">
          {progress}%
        </span>
      </div>
      <figcaption className="img-cap" title={prompt}>
        {prompt}
      </figcaption>
      <span className="sr-only" role="status">
        {gif ? "Creating GIF" : "Creating image"}
      </span>
    </figure>
  );
}
