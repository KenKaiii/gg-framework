// A horizon behind the chat lane's ground strip: sky that thins out upward
// through a dither (pixel art doesn't fade through alpha), two ridges,
// something in the sky, and the terrain's landmarks standing on the horizon.
// Painted once per terrain and width, on the critters' pixel grid. Colours
// are art, not theme roles.

import { useEffect, useRef } from "react";
import { art, artCanvas } from "./critter-art";
import { PX } from "./critter-fx";
import type { Biome } from "./critter-terrain";

const ROWS = 42;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x: number, y: number): number => ((BAYER[(y & 3) * 4 + (x & 3)] ?? 0) + 0.5) / 16;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
// Smooth 1D noise, 0–1.
function noise(seed: number): (x: number) => number {
  const r = rng(seed);
  const v = Array.from({ length: 256 }, () => r());
  return (x) => {
    const i = Math.floor(x);
    const f = x - i;
    const a = v[i & 255] ?? 0;
    const b = v[(i + 1) & 255] ?? 0;
    return a + (b - a) * (f * f * (3 - 2 * f));
  };
}

interface Look {
  // Sky colours, top to horizon.
  readonly sky: readonly string[];
  // Rows over which the sky thins out at the top.
  readonly fade: number;
  readonly far: {
    color: string;
    base: number;
    amp: number;
    scale: number;
    steps?: number;
    cap?: string;
    sharp?: boolean;
  };
  readonly near: { color: string; base: number; amp: number; scale: number };
  readonly extra?: (ctx: CanvasRenderingContext2D, cols: number, r: () => number) => void;
}

const disc = (
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rad: number,
  color: string,
  clipBelow = ROWS,
): void => {
  ctx.fillStyle = color;
  for (let y = -rad; y <= rad; y++)
    for (let x = -rad; x <= rad; x++)
      if (x * x + y * y <= rad * rad + 1 && cy + y < clipBelow)
        ctx.fillRect(Math.round(cx + x), Math.round(cy + y), 1, 1);
};

const LOOKS: Readonly<Record<string, Look>> = {
  meadow: {
    sky: ["#1d3557", "#2f6690", "#6fa8c7"],
    fade: 20,
    far: { color: "#2d6a5a", base: 11, amp: 13, scale: 40 },
    near: { color: "#3f8f4a", base: 4, amp: 8, scale: 22 },
    extra(ctx, cols, r) {
      // A few flat-bottomed clouds.
      ctx.fillStyle = "#dbe9f4";
      for (let x = 20 + r() * 40; x < cols; x += 70 + r() * 80) {
        const y = 10 + Math.floor(r() * 8);
        const w = 10 + Math.floor(r() * 8);
        ctx.fillRect(Math.round(x), y, w, 2);
        ctx.fillRect(Math.round(x) + 2, y - 1, w - 5, 1);
        ctx.fillRect(Math.round(x) + 4, y - 2, Math.max(2, w - 10), 1);
      }
    },
  },
  beach: {
    sky: ["#43305e", "#b4566b", "#f6a25f", "#ffd98a"],
    fade: 18,
    far: { color: "#4a4a7a", base: 13, amp: 5, scale: 70 },
    near: { color: "#2a7fb8", base: 9, amp: 0, scale: 1 },
    extra(ctx, cols, r) {
      disc(ctx, cols * 0.68, ROWS - 10, 8, "#fff0b8", ROWS - 9);
      // Light on the water.
      for (let i = 0; i < cols / 3; i++) {
        const y = ROWS - 9 + Math.floor(r() * 9);
        ctx.fillStyle = y < ROWS - 5 ? "#8fd6ff" : "#1f5f96";
        ctx.fillRect(Math.floor(r() * cols), y, 2 + Math.floor(r() * 4), 1);
      }
    },
  },
  desert: {
    sky: ["#3a275c", "#a8483d", "#ee9b55", "#ffd08a"],
    fade: 18,
    far: { color: "#8c4a3e", base: 12, amp: 12, scale: 38, steps: 3 },
    near: { color: "#c8783f", base: 4, amp: 5, scale: 30 },
    extra(ctx, cols) {
      disc(ctx, cols * 0.3, 20, 7, "#ffe6a8");
    },
  },
  space: {
    sky: ["#0b0d1c", "#14173a", "#262a5e"],
    fade: 14,
    far: { color: "#3a3f66", base: 6, amp: 6, scale: 26 },
    near: { color: "#565c85", base: 2, amp: 3, scale: 12 },
    extra(ctx, cols, r) {
      for (let i = 0; i < cols / 2.2; i++) {
        ctx.fillStyle = ["#ffffff", "#9aa3e0", "#f6d36b"][Math.floor(r() * 3)] ?? "#fff";
        ctx.fillRect(Math.floor(r() * cols), Math.floor(r() * (ROWS - 8)), 1, 1);
      }
      const px = cols * 0.74;
      disc(ctx, px, 15, 9, "#d9775c");
      disc(ctx, px - 3, 12, 5, "#ee9b78");
      ctx.fillStyle = "#f4d19b";
      ctx.fillRect(Math.round(px - 15), 16, 30, 1);
      ctx.fillRect(Math.round(px - 13), 17, 8, 1);
      ctx.fillRect(Math.round(px + 6), 15, 8, 1);
      disc(ctx, cols * 0.2, 11, 3, "#5aa4f0");
      disc(ctx, cols * 0.2 - 1, 10, 1, "#bfe3ff");
    },
  },
  snow: {
    sky: ["#0f1c3f", "#1f3a70", "#4a6aa8"],
    fade: 16,
    far: { color: "#51648f", base: 12, amp: 16, scale: 30, cap: "#e6f2ff", sharp: true },
    near: { color: "#c5d5ec", base: 4, amp: 4, scale: 26 },
    extra(ctx, cols) {
      // Aurora: two ribbons, dithered thin.
      for (const [color, phase, y0] of [
        ["#4ae0b0", 0, 9],
        ["#8a6bf0", 2.1, 13],
      ] as const)
        for (let x = 0; x < cols; x++) {
          const top = y0 + Math.sin(x / 19 + phase) * 3 + Math.sin(x / 7 + phase) * 1.2;
          for (let k = 0; k < 6; k++) {
            const y = Math.round(top + k);
            if (bayer(x, y) < 0.55 - k * 0.09) {
              ctx.fillStyle = color;
              ctx.fillRect(x, y, 1, 1);
            }
          }
        }
    },
  },
};

function paint(canvas: HTMLCanvasElement, id: string, cols: number): void {
  const look = LOOKS[id] ?? LOOKS.meadow;
  const ctx = canvas.getContext("2d");
  if (!look || !ctx) return;
  canvas.width = cols;
  canvas.height = ROWS;
  const seed = [...id].reduce((n, ch) => n * 31 + ch.charCodeAt(0), 7);
  const r = rng(seed);
  // Sky: bands of colour, the top rows thinned out through a dither.
  for (let y = 0; y < ROWS; y++) {
    const band =
      look.sky[Math.min(look.sky.length - 1, Math.floor((y / ROWS) * look.sky.length))] ?? "#000";
    const next =
      look.sky[Math.min(look.sky.length - 1, Math.floor((y / ROWS) * look.sky.length) + 1)] ?? band;
    const within = ((y / ROWS) * look.sky.length) % 1;
    const cover = Math.min(1, (y + 1) / look.fade) ** 1.3;
    for (let x = 0; x < cols; x++) {
      if (bayer(x, y) >= cover) continue;
      ctx.fillStyle = bayer(x + 2, y + 1) < within ? next : band;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  look.extra?.(ctx, cols, r);
  // Ridges.
  const ridge = (o: Look["far"] | Look["near"], n: number): void => {
    const f = noise(seed + n);
    for (let x = 0; x < cols; x++) {
      let k = f(x / o.scale) * 0.7 + f(x / (o.scale / 2.7) + 40) * 0.3;
      if ("sharp" in o && o.sharp)
        k = Math.abs(((x / o.scale + f(x / 90) * 2) % 1) - 0.5) * 2 * 0.75 + k * 0.25;
      if ("steps" in o && o.steps) k = Math.floor(k * o.steps + 0.5) / o.steps;
      const h = Math.round(o.base + o.amp * k);
      ctx.fillStyle = o.color;
      ctx.fillRect(x, ROWS - h, 1, h);
      if ("cap" in o && o.cap && h > o.base + o.amp * 0.55) {
        ctx.fillStyle = o.cap;
        ctx.fillRect(x, ROWS - h, 1, Math.max(1, Math.round((h - o.base - o.amp * 0.55) * 0.8)));
      }
    }
  };
  ridge(look.far, 1);
  ridge(look.near, 2);
  // Landmarks on the horizon.
  const marks = art().landmarks[id] ?? [];
  for (let x = 24 + r() * 50, i = 0; x < cols - 20 && marks.length; x += 90 + r() * 110, i++) {
    const a = marks[r() < 0.62 ? 0 : 1] ?? marks[0];
    if (a) ctx.drawImage(artCanvas(a), Math.round(x), ROWS - a.h + 1);
  }
}

export function CritterBackdrop({ biome }: { biome: Biome }): React.ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const box = canvas?.parentElement;
    if (!canvas || !box) return;
    let cols = 0;
    const fit = (): void => {
      const want = Math.ceil(box.clientWidth / PX);
      if (want === cols || want <= 0) return;
      cols = want;
      paint(canvas, biome.id, cols);
      canvas.style.width = `${cols * PX}px`;
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [biome]);
  return <canvas ref={ref} className="critter-backdrop" aria-hidden="true" />;
}
