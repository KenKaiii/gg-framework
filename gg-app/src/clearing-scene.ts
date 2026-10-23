// Puts the clearing (clearing-art.ts) on a canvas. The still sky, the still
// land, the sunbeam frames and the mist tile are painted once into buffers;
// each frame stacks them with the moving parts in between, back to front:
// sky, the sky's motion, the field, beams, mist, the near pines, then the
// fire and fireflies. Used
// by the home screen and the "What's new" window.

import {
  BEAM_FRAMES,
  beamFrameAt,
  drawBeamFrame,
  drawClearingField,
  drawClearingGroundLife,
  drawClearingPines,
  drawClearingSky,
  drawClearingSkyLife,
  drawMistTile,
  mistBand,
  type ClearingLayout,
} from "./clearing-art";
import type { SceneLight } from "./scene-light";

/**
 * The hour a scene is built for: rounded to 5 minutes, so the still layers
 * (15–65 ms to paint) are rebuilt every 5 minutes, not every minute; the light
 * moves too slowly for the step to show.
 */
export function sceneHour(hour: number): number {
  return Math.round(hour * 12) / 12;
}

export interface ClearingScene {
  /** Draws the clearing at a time in seconds. */
  paint(seconds: number): void;
}

function buffer(
  w: number,
  h: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  return ctx ? { canvas, ctx } : null;
}

/** The scene for one layout and light; null with no 2D canvas. */
export function createClearingScene(
  ctx: CanvasRenderingContext2D,
  layout: ClearingLayout,
  light: SceneLight,
): ClearingScene | null {
  const sky = buffer(layout.w, layout.h);
  const field = buffer(layout.w, layout.h);
  const pines = buffer(layout.w, layout.h);
  if (!sky || !field || !pines) return null;
  drawClearingSky(sky.ctx, layout, light);
  drawClearingField(field.ctx, layout, light);
  drawClearingPines(pines.ctx, layout, light);

  const beams: HTMLCanvasElement[] = [];
  if (layout.sun && light.beams >= 0.05 && light.stars < 0.5) {
    for (let f = 0; f < BEAM_FRAMES; f++) {
      const b = buffer(layout.w, layout.h);
      if (!b) break;
      drawBeamFrame(b.ctx, layout, light, f);
      beams.push(b.canvas);
    }
  }

  const band = mistBand(layout);
  let mist: HTMLCanvasElement | null = null;
  if (band && light.mistLevel >= 0.05) {
    const b = buffer(band.w, band.h);
    if (b) {
      drawMistTile(b.ctx, layout, light);
      mist = b.canvas;
    }
  }

  return {
    paint(seconds) {
      ctx.drawImage(sky.canvas, 0, 0);
      drawClearingSkyLife(ctx, layout, light, seconds);
      ctx.drawImage(field.canvas, 0, 0);
      const beam = beams[beamFrameAt(seconds)];
      if (beam) ctx.drawImage(beam, 0, 0);
      // The mist slides one art pixel every 2/3 of a second.
      if (mist && band) ctx.drawImage(mist, -(Math.floor(seconds * 1.5) % band.period), band.y);
      ctx.drawImage(pines.canvas, 0, 0);
      drawClearingGroundLife(ctx, layout, light, seconds);
    },
  };
}
