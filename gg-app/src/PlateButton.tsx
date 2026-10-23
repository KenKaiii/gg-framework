import { useEffect, useRef } from "react";

/**
 * GG Royale's plate button, in the app: a raised plate with a dash-dot border
 * sitting in a wooden socket, its word in Alagard. Pointing at it lifts the
 * plate a touch, pressing sinks it into the socket, and letting go springs it
 * back past rest with a wobble. A dimmed button (prerequisites unmet) sits
 * sunk in its socket.
 *
 * Drawn exactly as the game draws it (apps/client/blackjack/game.js,
 * plateLayers): 100×46 art pixels on three canvases (the socket, the plate,
 * the socket's front lip), shown at --plate-scale screen pixels per art pixel
 * with nearest-neighbour sampling. The word is real text, so it's the
 * button's accessible name.
 */

export const PLATE_W = 100;
export const PLATE_H = 46;
/** How far a press sinks the plate (art pixels). */
const PRESS = 7;
const LIFT = -2;

const C = {
  ink: "#1e0c1f",
  wood: "#743c36",
  woodHi: "#8a4a40",
  woodLo: "#4e343f",
  woodDark: "#271d2a",
};

/** The game's plate colours: green for the main action (Deal me in, Tables),
 * wine for the quiet one beside it (Stand, Cancel). */
const PLATES = {
  go: { body: "#688e50", hi: "#4c7b53", dash: "#4c7b53", side: "#2b353f", sideHi: "#395653" },
  wine: { body: "#593139", hi: "#4c0b2f", dash: "#4c0b2f", side: "#310919", sideHi: "#4c0b2f" },
} as const;
export type PlateKind = keyof typeof PLATES;

type Ctx = CanvasRenderingContext2D;

function px(ctx: Ctx, x: number, y: number, w: number, h: number, c: string): void {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/** A box with 2px-cut corners and a 1px edge. */
function roundRect(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  edge: string,
): void {
  px(ctx, x + 2, y, w - 4, h, edge);
  px(ctx, x, y + 2, w, h - 4, edge);
  px(ctx, x + 1, y + 1, w - 2, h - 2, edge);
  px(ctx, x + 2, y + 1, w - 4, h - 2, fill);
  px(ctx, x + 1, y + 2, w - 2, h - 4, fill);
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speckle(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  seed: number,
  amount: number,
  color: string,
): void {
  const r = rng(seed);
  ctx.fillStyle = color;
  for (let i = 0; i < w * h * amount; i++) {
    ctx.fillRect(x + Math.floor(r() * w), y + Math.floor(r() * h), 1, 1);
  }
}

function dashRect(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, col: string): void {
  for (let x = x0; x <= x1; x++) {
    const on = (x - x0) % 8 < 5 || (x - x0) % 8 === 6;
    if (on) {
      px(ctx, x, y0, 1, 1, col);
      px(ctx, x, y1, 1, 1, col);
    }
  }
  for (let y = y0; y <= y1; y++) {
    const on = (y - y0) % 8 < 5 || (y - y0) % 8 === 6;
    if (on) {
      px(ctx, x0, y, 1, 1, col);
      px(ctx, x1, y, 1, 1, col);
    }
  }
}

function ctxOf(canvas: HTMLCanvasElement | null): Ctx | null {
  const ctx = canvas?.getContext("2d") ?? null;
  if (ctx) {
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, PLATE_W, PLATE_H);
  }
  return ctx;
}

/** Paint the three layers: socket and hole, the plate, the socket's front lip. */
function paint(
  back: HTMLCanvasElement | null,
  plate: HTMLCanvasElement | null,
  front: HTMLCanvasElement | null,
  kind: PlateKind,
  seed: number,
): void {
  const p = PLATES[kind];
  const W = PLATE_W;
  const H = PLATE_H;
  const b = ctxOf(back);
  if (b) {
    roundRect(b, 1, 12, W - 2, 27, C.wood, C.ink);
    px(b, 3, 13, W - 6, 1, C.woodHi);
    speckle(b, 3, 14, W - 6, 22, seed * 7, 0.07, C.woodHi);
    speckle(b, 3, 14, W - 6, 22, seed * 9, 0.06, C.woodLo);
    px(b, 1, 37, W - 2, 7, C.ink);
    px(b, 2, 37, W - 4, 6, C.woodDark);
    px(b, 3, 37, W - 6, 1, C.woodLo);
    px(b, 9, 15, W - 18, 19, C.ink);
    px(b, 10, 16, W - 20, 3, C.woodDark);
  }
  const f = ctxOf(front);
  if (f && back) {
    // Everything of the socket below the plate's resting bottom edge (y 33).
    f.drawImage(back, 0, 33, W, H - 33, 0, 33, W, H - 33);
    px(f, 9, 33, W - 18, 1, C.ink);
  }
  const x = ctxOf(plate);
  if (x) {
    // Side, then the top face: ink outline, a lighter inner ring, and the
    // dash-dot border two pixels in.
    roundRect(x, 7, 1, W - 14, 32, p.side, C.ink);
    px(x, 8, 29, W - 16, 1, p.sideHi);
    roundRect(x, 7, 1, W - 14, 28, p.hi, C.ink);
    px(x, 9, 3, W - 18, 24, p.body);
    px(x, 8, 4, W - 16, 22, p.body);
    dashRect(x, 10, 4, W - 11, 25, p.dash);
  }
}

interface Props extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly label: string;
  readonly kind?: PlateKind;
  /** Prerequisites unmet: shown sunk and dull, but still clickable. */
  readonly dimmed?: boolean;
  /** Working on it (e.g. a screen is loading): held down in its socket. */
  readonly held?: boolean;
}

export function PlateButton({
  label,
  kind = "go",
  dimmed = false,
  held = false,
  className,
  ...rest
}: Props): React.ReactElement {
  const btnRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLCanvasElement>(null);
  const plateRef = useRef<HTMLCanvasElement>(null);
  const frontRef = useRef<HTMLCanvasElement>(null);
  const faceRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let seed = 0;
    for (const ch of label) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    paint(backRef.current, plateRef.current, frontRef.current, kind, (seed % 97) + 3);
  }, [kind, label]);

  // A damped spring moves the plate: rest 0, lifted on hover, sunk on press.
  const dimmedRef = useRef(dimmed);
  const heldRef = useRef(held);
  useEffect(() => {
    const btn = btnRef.current;
    const face = faceRef.current;
    if (!btn || !face) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const sp = { y: 0, v: 0, target: 0, held: false, raf: 0 };
    const place = (y: number): void => {
      face.style.setProperty("--plate-y", String(y));
    };
    const step =
      (last: number) =>
      (t: number): void => {
        const dt = Math.min(0.033, (t - last) / 1000 || 0.016);
        // Stiff and a little under-damped: a release overshoots and wobbles.
        const a = -520 * (sp.y - sp.target) - 15 * sp.v;
        sp.v += a * dt;
        sp.y += sp.v * dt;
        place(Math.round(Math.max(-4, Math.min(PRESS + 1, sp.y))));
        if (Math.abs(sp.v) < 0.5 && Math.abs(sp.y - sp.target) < 0.3) {
          sp.y = sp.target;
          sp.v = 0;
          place(sp.target);
          sp.raf = 0;
          return;
        }
        sp.raf = requestAnimationFrame(step(t));
      };
    const set = (target: number, kick = 0): void => {
      sp.target = target;
      if (reduced) {
        sp.y = target;
        place(target);
        return;
      }
      sp.v += kick;
      if (!sp.raf) sp.raf = requestAnimationFrame(step(performance.now()));
    };
    const sunk = (): boolean => dimmedRef.current || heldRef.current;
    const rest = (): number => (sunk() ? PRESS : 0);
    const enter = (): void => {
      if (!sunk() && !sp.held) set(LIFT, -30);
    };
    const down = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      sp.held = true;
      set(PRESS, 160);
    };
    const release = (leaving: boolean): void => {
      if (sp.held) {
        sp.held = false;
        set(leaving || sunk() ? rest() : LIFT, -40);
      } else if (leaving) set(rest(), 20);
    };
    const up = (): void => release(false);
    const leave = (): void => release(true);
    const keyDown = (e: KeyboardEvent): void => {
      if ((e.key === "Enter" || e.key === " ") && !e.repeat) set(PRESS, 160);
    };
    const keyUp = (e: KeyboardEvent): void => {
      if (e.key === "Enter" || e.key === " ") set(rest(), -40);
    };
    btn.addEventListener("pointerenter", enter);
    btn.addEventListener("pointerdown", down);
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointerleave", leave);
    btn.addEventListener("keydown", keyDown);
    btn.addEventListener("keyup", keyUp);
    (btn as HTMLButtonElement & { _plate?: typeof set })._plate = set;
    sp.y = sp.target = rest();
    place(sp.y);
    return () => {
      cancelAnimationFrame(sp.raf);
      btn.removeEventListener("pointerenter", enter);
      btn.removeEventListener("pointerdown", down);
      btn.removeEventListener("pointerup", up);
      btn.removeEventListener("pointerleave", leave);
      btn.removeEventListener("keydown", keyDown);
      btn.removeEventListener("keyup", keyUp);
    };
  }, []);

  // Held stays down in the socket until the work is done, then pops back up.
  useEffect(() => {
    if (heldRef.current === held) return;
    heldRef.current = held;
    const set = (
      btnRef.current as (HTMLButtonElement & { _plate?: (t: number, k?: number) => void }) | null
    )?._plate;
    if (held) set?.(PRESS, 60);
    else if (!dimmedRef.current) set?.(0, -60);
  }, [held]);

  // Dimmed sinks into the socket; ready pops back up with a bounce.
  useEffect(() => {
    if (dimmedRef.current === dimmed) return;
    dimmedRef.current = dimmed;
    const set = (
      btnRef.current as (HTMLButtonElement & { _plate?: (t: number, k?: number) => void }) | null
    )?._plate;
    set?.(dimmed || heldRef.current ? PRESS : 0, dimmed ? 60 : -60);
  }, [dimmed]);

  return (
    <button
      ref={btnRef}
      type="button"
      className={`plate-button is-${kind}${dimmed ? " is-dimmed" : ""}${className ? ` ${className}` : ""}`}
      aria-disabled={dimmed ? true : undefined}
      aria-busy={held ? true : undefined}
      {...rest}
    >
      <canvas
        ref={backRef}
        className="plate-layer"
        width={PLATE_W}
        height={PLATE_H}
        aria-hidden="true"
      />
      <span ref={faceRef} className="plate-face">
        <canvas
          ref={plateRef}
          className="plate-layer"
          width={PLATE_W}
          height={PLATE_H}
          aria-hidden="true"
        />
        <span className="plate-word">{label}</span>
      </span>
      <canvas
        ref={frontRef}
        className="plate-layer"
        width={PLATE_W}
        height={PLATE_H}
        aria-hidden="true"
      />
    </button>
  );
}
