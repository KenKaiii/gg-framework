import { useEffect, useRef, useState } from "react";
import { homeLayout } from "./clearing-art";
import { createClearingScene, sceneHour } from "./clearing-scene";
import { BIOMES, type Biome } from "./critter-terrain";
import { lightAt } from "./scene-light";
import { useWindowFocused } from "./useWindowFocused";

/** Screen px per art px, as in GG Royale (and the critters' ground). */
const SCALE = 2;
/** The fire and fireflies step like the game's art: 12 frames a second is plenty. */
const FRAME_MS = 1000 / 12;
/** Where a still (reduced-motion) frame is taken: the fire mid-flicker, embers up. */
const STILL_SECONDS = 4;

/** Terrains that belong in the campfire's clearing. */
const SCENERY_BIOME_IDS: ReadonlySet<string> = new Set(["meadow"]);

/**
 * The terrain the home screen shows with the scenery on: the visit's pick when
 * it has a scene, otherwise one that does, so ground and horizon always match.
 */
export function withScenery(biome: Biome): Biome {
  if (SCENERY_BIOME_IDS.has(biome.id)) return biome;
  return BIOMES.find((b) => SCENERY_BIOME_IDS.has(b.id)) ?? biome;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The home screen's backdrop: the critters' campfire clearing in the pines,
 * drawn in GG Royale's pixel style (clearing-art.ts) and lit by the local
 * clock (scene-light.ts). Fills the home screen under all content and never
 * takes pointer events.
 *
 * - The still layer (sky, pines, field) paints once per size and hour; each
 *   frame copies it and paints what moves: the fire, embers and smoke,
 *   fireflies, stars, the moon's and sun's glow, beams, mist, clouds, fliers.
 * - Background windows stop animating (the last frame stays), so an idle
 *   window costs nothing.
 * - Reduced motion draws one still frame, re-lit as the hour moves on.
 * - No 2D canvas: nothing draws, and the plain background shows.
 */
export function HomeScenery({ hour: clock }: { hour: number }): React.ReactElement {
  const hour = sceneHour(clock);
  const focused = useWindowFocused();
  const [reduced] = useState(prefersReducedMotion);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const box = canvasRef.current?.parentElement;
    if (!box) return;
    const fit = (): void => {
      const w = Math.ceil(box.clientWidth / SCALE);
      const h = Math.ceil(box.clientHeight / SCALE);
      setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !ctx || !size || size.w < 1 || size.h < 1) return;
    const { w, h } = size;
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${w * SCALE}px`;
    canvas.style.height = `${h * SCALE}px`;
    ctx.imageSmoothingEnabled = false;
    const scene = createClearingScene(ctx, homeLayout(w, h, hour), lightAt(hour));
    if (!scene) return;
    const paint = (seconds: number): void => scene.paint(seconds);
    paint(STILL_SECONDS);
    if (reduced || !focused) return;
    let raf = 0;
    let last = -Infinity;
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      last = now;
      paint(now / 1000);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [size, hour, reduced, focused]);

  return (
    <div className="home-scenery" aria-hidden="true">
      <canvas className="home-scenery-canvas" ref={canvasRef} />
    </div>
  );
}
