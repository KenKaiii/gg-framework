// How critters look on the stage: pixel emotes where text badges were, a
// blink now and then, breathing (CSS), something worn to suit the terrain, a
// shadow that stays on the ground when they jump, and the one clean tip-over
// of a failed critter with its spirit drifting up.

import type { EmoteName, HatName } from "./critter-art";
import { discard, PX, SIZE, type BadgeKind, type CritterFx } from "./critter-fx";
import { renderCritterFrame, withEyesClosed, type CritterDef } from "./critter-sprites";
import { emote, type StageKit } from "./critter-stage-kit";
import type { Critter } from "./critter-types";

export interface CritterLooks {
  dress(c: Critter): void;
  /** Keep the shadow on the ground, and cut the critter at the lane's edge. */
  ground(c: Critter): void;
  /** Put a hat on (for `ms`, or for good). False if this critter can't wear it. */
  wear(c: Critter, name: HatName, ms?: number): boolean;
  fall(c: Critter): void;
  soul(c: Critter): void;
  /** Lying on the ground: no more hovering. */
  downed(c: Critter): boolean;
  tick(): void;
}

export function withEmotes(fx: CritterFx): CritterFx {
  const pickEmote = (kind: BadgeKind, text: string): EmoteName =>
    kind === "ok" ? "ok" : kind === "err" ? "no" : text.includes("?") ? "?" : "!";
  const setBadge = (c: Critter, kind: BadgeKind | null, text = ""): void => {
    discard(c.el.querySelector(".critter-badge"));
    if (kind) emote(c, pickEmote(kind, text));
  };
  const flashBadge = async (c: Critter, kind: BadgeKind, text: string, ms = 700): Promise<void> => {
    setBadge(c, kind, text);
    const b = c.el.querySelector(".critter-badge");
    await fx.wait(ms);
    if (b?.isConnected) discard(b);
  };
  return { ...fx, setBadge, flashBadge };
}

// Already wearing something, or the wrong shape for a hat.
const NO_HAT: ReadonlySet<string> = new Set([
  "wizard",
  "knight",
  "builder",
  "shroom",
  "capybara",
  "robot",
  "crab",
]);

// The row a hat sits on: the first where the middle of the head is solid.
function headTop(rows: readonly string[]): number {
  for (let y = 0; y < rows.length; y++) {
    const middle = rows[y]?.slice(7, 11) ?? "";
    if (!middle.includes(".")) return y;
  }
  return 0;
}

export function makeCritterLooks(kit: StageKit): CritterLooks {
  const { host, art: A } = kit;
  const { later } = host;
  const { fx } = host.api;
  const { rand, chance } = fx;

  // Where a hat sits, in sprite cells from the top-left; null if it can't be worn.
  function hatSpot(def: CritterDef, name: HatName): { left: number; top: number } | null {
    const a = A.hats[name];
    if (name === "helmet") return { left: -4, top: -3 };
    const left = Math.round((18 - a.w) / 2);
    if (name === "shades") {
      const eyes = def.rows.findIndex((r) => r.includes("W"));
      return eyes < 0 ? null : { left, top: eyes - 1 };
    }
    if (NO_HAT.has(def.id)) return null;
    return { left, top: headTop(def.rows) + 2 - a.h };
  }

  function wear(c: Critter, name: HatName, ms?: number): boolean {
    const flip = c.body.firstElementChild;
    const spot = hatSpot(c.def, name);
    if (!flip || !spot) return false;
    const a = A.hats[name];
    for (const old of flip.querySelectorAll(".critter-hat")) discard(old);
    const img = fx.el("img", "critter-hat", flip);
    img.src = a.url;
    img.alt = "";
    img.draggable = false;
    Object.assign(img.style, {
      left: `${spot.left * PX}px`,
      top: `${spot.top * PX}px`,
      width: `${a.w * PX}px`,
      height: `${a.h * PX}px`,
    });
    if (ms) later(ms, () => discard(img));
    return true;
  }

  function outfit(c: Critter): void {
    switch (kit.biome()) {
      case "space":
        wear(c, "helmet");
        break;
      case "snow":
        if (chance(0.6)) wear(c, "beanie");
        break;
      case "desert":
        if (chance(0.45)) wear(c, "cowboy");
        break;
      case "beach":
        // Shades sit on eyes with a shine; anyone without gets the straw hat.
        if (chance(0.55) && !wear(c, chance(0.5) ? "straw" : "shades")) wear(c, "straw");
        break;
      default:
        if (chance(0.25)) wear(c, "flowers");
    }
  }

  function blinkLoop(c: Critter): void {
    later(rand(1800, 5200), () => {
      if (!c.el.isConnected || !kit.alive()) return;
      if (!c.leaving && c.mode !== "summon") {
        c.el.classList.add("blinking");
        later(chance(0.2) ? 280 : 130, () => c.el.classList.remove("blinking"));
      }
      blinkLoop(c);
    });
  }

  function dress(c: Critter): void {
    c.el.style.setProperty("--critter-breath", `${(-rand(0, 2.6)).toFixed(2)}s`);
    const flip = c.body.firstElementChild;
    if (!flip || host.reduced) return;
    const shut = withEyesClosed(c.def);
    for (const f of [0, 1] as const) {
      const img = fx.el("img", `critter-blink critter-b${f}`, flip);
      img.src = renderCritterFrame(shut, f);
      img.alt = "";
      img.draggable = false;
    }
    blinkLoop(c);
    outfit(c);
  }

  const clips = new WeakMap<Critter, string>();
  function ground(c: Critter): void {
    const lift = -c.y;
    c.shadow.style.transform =
      lift > 0.5
        ? `translateY(${lift.toFixed(1)}px) scaleX(${Math.max(0.6, 1 - lift / 36).toFixed(2)})`
        : "";
    // Walking in or out past the lane's edge: cut there, like a window frame.
    const left = -c.x;
    const right = c.x + SIZE - kit.W();
    const clip =
      left > 0
        ? `inset(-300px -400px -40px ${left.toFixed(0)}px)`
        : right > 0
          ? `inset(-300px ${right.toFixed(0)}px -40px -400px)`
          : "";
    if ((clips.get(c) ?? "") !== clip) {
      clips.set(c, clip);
      c.el.style.clipPath = clip;
    }
  }

  const fallen = new Map<Critter, Animation>();
  const downed = (c: Critter): boolean =>
    fallen.has(c) || (host.reduced && c.el.classList.contains("fallen"));

  // Forward onto its face in one motion: a start, the drop, a squash where it
  // lands, and then it stays down (see tick). No spring past flat and back.
  function fall(c: Critter): void {
    if (host.reduced) return;
    const d = c.dir;
    const lie = (deg: number, more = ""): string =>
      `rotate(${deg * d}deg) translateX(${((-30 * d * deg) / 90).toFixed(1)}%) ${more}`;
    const anim = c.body.animate(
      [
        { transform: "none" },
        { transform: lie(-9), offset: 0.2, easing: "cubic-bezier(0.6, 0, 1, 0.7)" },
        { transform: lie(90, "scale(0.9, 1.1)"), offset: 0.66 },
        { transform: lie(90, "scale(1.04, 0.97)"), offset: 0.84 },
        { transform: lie(90) },
      ],
      { duration: 620, fill: "forwards" },
    );
    fallen.set(c, anim);
    later(400, () => {
      if (c.el.isConnected) fx.puffs(c, 5, fx.mid() + d * 16, 0, d);
    });
  }

  // The spirit: small, pale, clearly not the critter getting back up.
  function soul(c: Critter): void {
    if (host.reduced) return;
    const s = fx.el("div", "critter-soul", host.floor);
    const img = fx.el("img", "", s);
    img.src = c.sil.src;
    img.alt = "";
    fx.el("i", "critter-halo", s);
    if (c.dir < 0) img.style.scale = "-1 1";
    const x = c.x + c.dir * 10;
    const at = (dx: number, y: number, k: number): string => `${kit.T(x + dx, y)} scale(${k})`;
    const an = s.animate(
      [
        { transform: at(0, 6, 0.3), opacity: 0 },
        { transform: at(-4, 26, 0.7), opacity: 0.8, offset: 0.25 },
        { transform: at(4, 52, 0.7), opacity: 0.65, offset: 0.6 },
        { transform: at(-2, 84, 0.6), opacity: 0 },
      ],
      { duration: 2300, delay: 900, easing: "ease-out", fill: "both" },
    );
    an.onfinish = an.oncancel = () => discard(s);
  }

  function tick(): void {
    // Nothing gets a downed critter back on its feet: a script that was cut
    // off mid-step may still try to move the body once.
    for (const [c, anim] of fallen) {
      if (!c.el.isConnected) {
        fallen.delete(c);
        continue;
      }
      for (const a of c.body.getAnimations()) if (a !== anim) a.cancel();
    }
  }

  return { dress, ground, wear, fall, soul, downed, tick };
}
