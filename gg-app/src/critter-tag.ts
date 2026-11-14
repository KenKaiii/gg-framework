// The name tag: a gold name tab on a slip of paper saying what the critter is
// doing, shown while it's pointed at (or for a moment after a click). It
// stands in for the old hover card. With a real agent behind the critter the
// slip shows the agent's activity; on a showcase floor it says what the
// critter itself is up to.

import type { IconName } from "./critter-art";
import { discard, PX } from "./critter-fx";
import { signatureDoing } from "./critter-idle";
import type { StageKit } from "./critter-stage-kit";
import { toolKindOf } from "./critter-tool-kind";
import { PRIO } from "./critter-types";
import type { Critter } from "./critter-types";

export interface CritterTag {
  /** The pointer is over this critter. */
  show(c: Critter): void;
  /** The pointer left. */
  hide(): void;
  /** A click keeps the tag up for a moment. */
  pin(c: Critter): void;
  /** Take the tag off this critter (it's leaving). */
  drop(c: Critter): void;
  /** The engine picked a variant of an action: note it in words. */
  noteAct(c: Critter, key: string, id: string): void;
  tick(): void;
  destroy(): void;
}

const PIN_MS = 2600;

const FIDGET_TEXT: Readonly<Record<string, string>> = {
  look: "Looking around",
  "happy-hop": "Feeling good",
  twirl: "Twirling",
  sneeze: "Sneezing",
  coffee: "Coffee break",
  whistle: "Whistling a tune",
  wave: "Saying hi",
};
const STROLL_TEXT: Readonly<Record<string, string>> = {
  walk: "Out for a walk",
  hop: "Hopping along",
  hover: "Buzzing about",
  float: "Drifting along",
  scuttle: "Scuttling about",
  squish: "Oozing along",
};

// "Reading src/auth/session.ts" → "Reading session.ts".
function tidy(activity: string): string {
  return activity.replace(/(?:[\w.@~-]*\/)+([\w.@~-]+)/g, "$1");
}

export function makeCritterTag(kit: StageKit): CritterTag {
  const { host, art: A } = kit;
  const { api, later } = host;
  const { fx } = api;

  function noteAct(c: Critter, key: string, id: string): void {
    if (key === "seek") kit.say(c, "Off to see a friend");
    else if (key === "fidget") {
      kit.say(c, id === "signature" ? signatureDoing(c.def.id) : (FIDGET_TEXT[id] ?? "Fidgeting"));
    }
  }

  function describe(c: Critter): { text: string; icon: IconName } {
    const status = c.agent.status;
    if (status === "error") return { text: "Hit a snag", icon: "fail" };
    if (status === "done" || status === "idle") return { text: "All done", icon: "done" };
    if (status === "interrupted") return { text: "Called back", icon: "fail" };
    if (c.mode === "summon") return { text: "Just arrived", icon: "play" };
    if (!host.ambient) {
      if (c.job?.kind === "think" || !c.agent.activity) return { text: "Thinking", icon: "think" };
      return { text: tidy(c.agent.activity), icon: toolKindOf(c.agent.activity) ?? "think" };
    }
    if (c.prio === PRIO.free) {
      return c.mode === "walk" || c.mode === "flee"
        ? { text: STROLL_TEXT[c.def.move] ?? "Out for a walk", icon: "idle" }
        : { text: "Taking a breather", icon: "idle" };
    }
    if (c.prio === PRIO.scare) return { text: "Spooked!", icon: "play" };
    if (c.prio === PRIO.social) return { text: kit.doing(c) ?? "Hanging out", icon: "play" };
    return { text: kit.doing(c) ?? "Up to something", icon: "play" };
  }

  let shown: {
    readonly c: Critter;
    readonly el: HTMLDivElement;
    readonly icon: HTMLImageElement;
    readonly line: HTMLSpanElement;
    key: string;
  } | null = null;
  let hovering = false;
  let pinnedUntil = 0;

  function take(): void {
    if (!shown) return;
    discard(shown.el);
    shown.c.el.classList.remove("tagged");
    shown = null;
  }

  function refresh(): void {
    if (!shown) return;
    const { c, el } = shown;
    const d = describe(c);
    const key = `${d.icon}:${d.text}`;
    if (key !== shown.key) {
      shown.key = key;
      const a = A.icons[d.icon];
      shown.icon.src = a.url;
      shown.icon.width = a.w * PX;
      shown.icon.height = a.h * PX;
      shown.line.textContent = d.text;
    }
    // Keep it inside the lane.
    const half = el.offsetWidth / 2;
    const cx = kit.mid(c);
    const shift = Math.max(6 + half - cx, 0) + Math.min(kit.W() - 6 - half - cx, 0);
    el.style.setProperty("--critter-tag-shift", `${shift.toFixed(0)}px`);
  }

  function build(c: Critter): void {
    take();
    const el = fx.el("div", "critter-tag", c.el);
    fx.el("span", "critter-tag-name", el).textContent = c.agent.label;
    const row = fx.el("span", "critter-tag-do", el);
    const icon = fx.el("img", "critter-tag-icon", row);
    icon.alt = "";
    const line = fx.el("span", "critter-tag-text", row);
    c.el.classList.add("tagged");
    shown = { c, el, icon, line, key: "" };
    refresh();
  }

  return {
    show(c) {
      if (c.leaving) return;
      hovering = true;
      if (shown?.c !== c) build(c);
    },
    hide() {
      hovering = false;
      if (api.now() >= pinnedUntil) take();
    },
    pin(c) {
      if (shown?.c !== c) build(c);
      pinnedUntil = api.now() + PIN_MS;
      later(PIN_MS + 50, () => {
        if (!hovering && api.now() >= pinnedUntil) take();
      });
    },
    drop(c) {
      if (shown?.c === c) take();
    },
    noteAct,
    tick() {
      if (!shown) return;
      if (!shown.c.el.isConnected || shown.c.leaving) take();
      else refresh();
    },
    destroy: take,
  };
}
