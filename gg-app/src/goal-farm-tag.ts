// The name tag on the Goal farm: the same gold name tab on a slip of bubble
// paper as the critter floors' (critter-tag.ts), drawn on the farm's canvas
// for whoever the pointer is over (or was just clicked). It says what the
// worker's agent is doing, with the tool's icon.

import { art, artCanvas, type IconName } from "./critter-art";
import { INK_COLOR } from "./critter-shade";
import { FARM_CRITTER_H } from "./goal-farm-critters";
import { reactionOn, type FarmPlay } from "./goal-farm-interact";
import type { Actor } from "./goal-farm-sim";
import { tripPose } from "./goal-farm-travel";
import type { WorkKind } from "./goal-world-agents";
import { drawText, textWidth } from "./pixel-text";

type Ctx = CanvasRenderingContext2D;

/** The part of the map on screen, in map pixels: the tag keeps inside it. */
export interface FarmView {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
}

const ICON_FOR: Readonly<Record<WorkKind, IconName>> = {
  read: "read",
  search: "search",
  edit: "edit",
  run: "run",
  web: "web",
  think: "think",
  ask: "ask",
  delegate: "play",
  wait: "idle",
};

const PAPER = "#cedbf9";
const PAPER_SHADE = "#a9b8e4";
const GOLD = "#e9af54";
const GOLD_LIT = "#f8d488";
const GOLD_SHADE = "#c47a3a";
/** The slip's height, and how far the name tab stands above it. */
const SLIP_H = 15;
const TAB_H = 12;

/** What the slip says: the agent's own words, or what the critter is up to between jobs. */
export function tagLine(actor: Actor): { text: string; icon: IconName } {
  const text =
    actor.detail ||
    (actor.state === "moving"
      ? "On the move"
      : actor.station === "lounge"
        ? "Tea by the fire"
        : "Taking a breather");
  return { text, icon: actor.want ? ICON_FOR[actor.want] : "idle" };
}

/**
 * Draw `actor`'s tag: over its head, or under its feet when there's no room
 * above or it's saying something (so the tag never covers its bubble).
 */
export function drawFarmTag(
  ctx: Ctx,
  actor: Actor,
  now: number,
  play: FarmPlay | null,
  view: FarmView,
): void {
  const pose = actor.trip ? tripPose(actor.trip, now, actor.facing) : actor.spot;
  const cx = pose.x;
  const feet = pose.y;
  // GG Goals wears a crown, and a nameplate under his feet.
  const top = feet - FARM_CRITTER_H - (actor.coordinator ? 4 : 0);
  const { text, icon } = tagLine(actor);
  const ic = art().icons[icon];
  const w = ic.w + 3 + textWidth(text) + 8;
  const x = Math.round(Math.min(view.x1 - w - 3, Math.max(view.x0 + 3, cx - w / 2)));
  const poked = reactionOn(play, `critter:${actor.key}`, now)?.action;
  const talking =
    (actor.bubble !== null && actor.bubble.until > now) || poked === "wave" || poked === "summary";
  const above = !talking && top - SLIP_H - 7 - TAB_H - 1 >= view.y0 + 2;
  const y = Math.round(above ? top - SLIP_H - 7 : feet + 19 + (actor.coordinator ? 14 : 0));

  // The slip: paper with a shaded bottom, an ink outline and a thick lip.
  ctx.fillStyle = INK_COLOR;
  ctx.fillRect(x, y - 1, w, SLIP_H + 4);
  ctx.fillRect(x - 1, y, w + 2, SLIP_H + 2);
  ctx.fillStyle = PAPER;
  ctx.fillRect(x, y, w, SLIP_H - 2);
  ctx.fillStyle = PAPER_SHADE;
  ctx.fillRect(x, y + SLIP_H - 2, w, 2);
  ctx.fillStyle = INK_COLOR;
  for (const [px, py] of [
    [x, y],
    [x + w - 1, y],
    [x, y + SLIP_H - 1],
    [x + w - 1, y + SLIP_H - 1],
  ] as const) {
    ctx.fillRect(px, py, 1, 1);
  }
  // Its tail, pointing at the critter even where the slip is pushed off-centre.
  if (above) {
    const tx = Math.min(x + w - 5, Math.max(x + 4, Math.round(cx)));
    ctx.fillRect(tx - 2, y + SLIP_H + 2, 5, 1);
    ctx.fillRect(tx - 1, y + SLIP_H + 3, 3, 1);
    ctx.fillRect(tx, y + SLIP_H + 4, 1, 1);
  }
  ctx.drawImage(artCanvas(ic), x + 4, y + Math.floor((SLIP_H - 2 - ic.h) / 2) + 1);
  drawText(ctx, text, x + 4 + ic.w + 3, y + 2, INK_COLOR);

  // The name tab, sitting on the slip's top edge.
  const label = actor.name.toUpperCase();
  const tw = textWidth(label) + 8;
  const ty = y - TAB_H;
  const nx = x + 3;
  ctx.fillStyle = INK_COLOR;
  ctx.fillRect(nx + 1, ty, tw - 2, TAB_H + 1);
  ctx.fillRect(nx, ty + 1, tw, TAB_H);
  ctx.fillStyle = GOLD;
  ctx.fillRect(nx + 1, ty + 1, tw - 2, TAB_H - 1);
  ctx.fillStyle = GOLD_LIT;
  ctx.fillRect(nx + 1, ty + 1, tw - 2, 1);
  ctx.fillStyle = GOLD_SHADE;
  ctx.fillRect(nx + 1, ty + TAB_H - 2, tw - 2, 2);
  drawText(ctx, label, nx + 4, ty + 1, INK_COLOR);
}
