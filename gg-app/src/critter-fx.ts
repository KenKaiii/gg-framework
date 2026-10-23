// Visual effects every critter behaviour shares: props, particles, badges,
// speech and little overlay layers (thought clouds, signal arcs, a hamster
// wheel…). Everything a script attaches gets `critter-fxl` so the engine can
// sweep it away in one go when the script ends or the critter leaves.
//
// All timers go through the engine's tracked `later`, so destroy() leaves none
// behind (a prop's flicker is a self-rescheduling `later`, not setInterval).

import { CRITTER_CELLS } from "./critter-sprites";
import { PROP_PAD, type PropArt, type PropName, renderProp } from "./critter-props";
import type { Critter } from "./critter-types";

/** Equal to `--ease-pop` in App.css; scripts/motion-tokens.test.mjs enforces it. */
const POP = "cubic-bezier(0.3, 1.6, 0.6, 1)";
/** One sprite cell in CSS px (matches --critter-px). */
export const PX = 2;
export const SIZE = CRITTER_CELLS * PX;
/** More than this many live particles on the floor and new ones are skipped. */
const MAX_PARTICLES = 90;

const noop = (): void => undefined;

/**
 * Remove a node, cancelling its Web Animations (and its children's) first.
 * WebKit keeps a finished `fill: "forwards"`/`"both"` animation, and any
 * infinite one, on the page timeline after its element is detached, and
 * re-checks every one of them on each frame. Once the node is gone,
 * `getAnimations()` can no longer reach them, so they pile up for the life
 * of the window: tens of thousands of sparks and props cost about 20% idle
 * CPU. Every critter effect node leaves the DOM through here.
 */
export function discard(node: Element | null | undefined): void {
  if (!node) return;
  // jsdom (the test DOM) has no Web Animations.
  if (typeof node.getAnimations === "function") {
    for (const anim of node.getAnimations({ subtree: true })) anim.cancel();
  }
  node.remove();
}

export interface FxDeps {
  readonly random: () => number;
  readonly later: (ms: number, fn: () => void) => number;
  readonly cancelLater: (id: number) => void;
  readonly live: () => readonly Critter[];
}

type SpotName = "hand" | "ground" | "up" | "eye" | "head";
interface Spot {
  readonly x: number | "center";
  readonly y: number;
}
// Spots in sprite cells for a critter facing right (x = left edge, y = bottom
// edge). Facing left mirrors x. "center" keeps it over the head.
const SPOTS: Readonly<Record<SpotName, Spot>> = {
  hand: { x: 14, y: 3 },
  ground: { x: 16, y: 0 },
  up: { x: 13, y: 10 },
  eye: { x: 14, y: 9 },
  head: { x: "center", y: 18 },
};

export interface PropOptions {
  readonly at?: SpotName | Spot;
  readonly dx?: number;
  readonly dy?: number;
  readonly mirror?: boolean;
  readonly origin?: string;
  readonly behind?: boolean;
  readonly pop?: boolean;
  readonly flicker?: number;
}

export interface PropHandle {
  readonly node: HTMLDivElement;
  readonly img: HTMLImageElement;
  setFrame(i: 0 | 1): void;
  flicker(ms: number): void;
  /** Shrink away and remove. */
  put(): Promise<void>;
}

export interface ParticleOptions {
  readonly cls: string;
  readonly text?: string;
  readonly color?: string;
  readonly x: number;
  readonly y: number;
  readonly dx?: number;
  readonly dy?: number;
  readonly arc?: number;
  readonly s0?: number;
  readonly s1?: number;
  readonly o0?: number;
  readonly rot?: number;
  readonly dur?: number;
  readonly delay?: number;
  readonly ease?: string;
}

export interface LayerOptions {
  /** Prepend inside .react (behind the body). */
  readonly behind?: boolean;
  /** Attach to the critter root rather than the .react wrapper. */
  readonly outside?: boolean;
  /** Self-removing after this long (may outlive the script that made it). */
  readonly ms?: number;
}

export type BadgeKind = "ok" | "err" | "yikes";

export interface CritterFx {
  readonly size: () => number;
  readonly rand: (a: number, b: number) => number;
  readonly pick: <T>(list: readonly T[]) => T;
  readonly chance: (p: number) => boolean;
  readonly wait: (ms: number) => Promise<void>;
  readonly el: <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls: string,
    parent?: Element,
  ) => HTMLElementTagNameMap[K];
  readonly play: (
    node: Element | null | undefined,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions,
  ) => Promise<void>;
  readonly prop: (c: Critter, name: PropName, opts?: PropOptions) => PropHandle;
  readonly layer: (c: Critter, cls: string, opts?: LayerOptions) => HTMLDivElement;
  readonly clearProps: (c: Critter) => void;
  readonly dropProps: (c: Critter) => void;
  readonly particle: (c: Critter, o: ParticleOptions) => void;
  readonly sparks: (c: Critter, n: number, outward?: boolean) => void;
  readonly stars: (c: Critter, x: number, y: number, n?: number, color?: string) => void;
  readonly puffs: (c: Critter, n: number, x?: number, y?: number, dir?: number) => void;
  readonly notes: (c: Critter, n?: number, color?: string) => void;
  readonly glyphs: (
    c: Critter,
    n: number,
    x: number,
    y: number,
    list: readonly string[],
    color?: string,
  ) => void;
  readonly steam: (c: Critter, x: number, y: number, n?: number) => void;
  readonly dirt: (c: Critter, n: number) => void;
  readonly confetti: (c: Critter, n?: number) => void;
  readonly sweat: (c: Critter, n?: number) => void;
  readonly hearts: (c: Critter, n?: number) => void;
  readonly blubs: (c: Critter, n?: number) => void;
  readonly setBadge: (c: Critter, kind: BadgeKind | null, text?: string) => void;
  readonly flashBadge: (c: Critter, kind: BadgeKind, text: string, ms?: number) => Promise<void>;
  readonly clearBubble: (c: Critter) => void;
  /** One critter chatters at a time; reactions and conversations pass `force`. */
  readonly say: (c: Critter, text: string, ms?: number, force?: boolean) => void;
  readonly thought: (c: Critter) => HTMLDivElement;
  readonly dizzy: (c: Critter, ms?: number) => HTMLDivElement;
  readonly frontX: (c: Critter, cells?: number) => number;
  readonly headY: () => number;
  readonly mid: () => number;
}

export function makeCritterFx(deps: FxDeps): CritterFx {
  const { random, later, cancelLater, live } = deps;
  const size = (): number => SIZE;
  const rand = (a: number, b: number): number => a + random() * (b - a);
  const pick = <T>(list: readonly T[]): T => {
    const item = list[Math.floor(random() * list.length)] ?? list[0];
    if (item === undefined) throw new Error("pick() from an empty list");
    return item;
  };
  const chance = (p: number): boolean => random() < p;
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      later(ms, resolve);
    });

  const propArt = new Map<PropName, PropArt>();
  const artFor = (name: PropName): PropArt => {
    let art = propArt.get(name);
    if (!art) {
      art = renderProp(name);
      propArt.set(name, art);
    }
    return art;
  };
  /** Stop functions for flickering props, so sweeping them also stops the timer. */
  const stoppers = new WeakMap<Element, () => void>();
  const particles = new Set<HTMLElement>();

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls: string,
    parent?: Element,
  ): HTMLElementTagNameMap[K] {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    parent?.appendChild(n);
    return n;
  }

  /** Web animation that resolves (never rejects) when finished OR cancelled. */
  function play(
    node: Element | null | undefined,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions,
  ): Promise<void> {
    if (!node?.isConnected) return Promise.resolve();
    return node.animate(keyframes, options).finished.then(noop, noop);
  }

  // ── Props ──
  function prop(c: Critter, name: PropName, opts: PropOptions = {}): PropHandle {
    const art = artFor(name);
    const spot = typeof opts.at === "object" ? opts.at : SPOTS[opts.at ?? "hand"];
    const node = el("div", "critter-prop critter-fxl");
    const img = el("img", "", node);
    img.src = art.f0;
    img.alt = "";
    img.draggable = false;
    node.style.width = `${PX * art.w}px`;
    node.style.height = `${PX * art.h}px`;
    const dx = (opts.dx ?? 0) * c.dir;
    // The art carries an outline PROP_PAD cells round it: set it that far
    // out, so the prop itself sits on its spot.
    const cellX =
      spot.x === "center"
        ? CRITTER_CELLS / 2 - art.w / 2
        : c.dir > 0
          ? spot.x - PROP_PAD
          : CRITTER_CELLS - spot.x - art.w + PROP_PAD;
    node.style.left = `${PX * (cellX + dx)}px`;
    node.style.bottom = `${PX * (spot.y - PROP_PAD + (opts.dy ?? 0))}px`;
    if (opts.mirror !== false && c.dir < 0) img.style.transform = "scaleX(-1)";
    node.style.transformOrigin = opts.origin ?? "50% 100%";
    if (opts.behind) c.react.prepend(node);
    else c.react.appendChild(node);
    if (opts.pop !== false) {
      node.animate(
        [
          { transform: "scale(0.2)", opacity: 0 },
          { transform: "none", opacity: 1 },
        ],
        { duration: 200, easing: POP },
      );
    }
    let frame: 0 | 1 = 0;
    let timer = 0;
    const stop = (): void => {
      if (timer) cancelLater(timer);
      timer = 0;
    };
    stoppers.set(node, stop);
    const handle: PropHandle = {
      node,
      img,
      setFrame(i) {
        frame = i;
        img.src = i && art.f1 ? art.f1 : art.f0;
      },
      flicker(ms) {
        stop();
        const step = (): void => {
          if (!node.isConnected) {
            timer = 0;
            return;
          }
          handle.setFrame(frame === 0 ? 1 : 0);
          timer = later(ms, step);
        };
        timer = later(ms, step);
      },
      async put() {
        stop();
        await play(
          node,
          [
            { transform: "none", opacity: 1 },
            { transform: "scale(0.3)", opacity: 0 },
          ],
          { duration: 160, fill: "forwards" },
        );
        discard(node);
      },
    };
    if (opts.flicker) handle.flicker(opts.flicker);
    return handle;
  }

  function layer(c: Critter, cls: string, opts: LayerOptions = {}): HTMLDivElement {
    // Timed layers clean themselves up, so they may outlive their script;
    // untimed ones belong to the script (`critter-fxl`).
    const node = el("div", opts.ms ? cls : `critter-fxl ${cls}`);
    if (opts.behind) c.react.prepend(node);
    else (opts.outside ? c.el : c.react).appendChild(node);
    if (opts.ms) later(opts.ms, () => discard(node));
    return node;
  }

  function clearProps(c: Critter): void {
    for (const n of c.el.querySelectorAll(".critter-fxl")) {
      stoppers.get(n)?.();
      discard(n);
    }
  }

  /** Startled mid-task: whatever it was holding tumbles to the floor. */
  function dropProps(c: Critter): void {
    for (const n of c.react.querySelectorAll<HTMLElement>(".critter-prop")) {
      stoppers.get(n)?.();
      n.classList.remove("critter-fxl");
      c.el.appendChild(n);
      const spin = pick([-1, 1]) * rand(70, 160);
      const anim = n.animate(
        [
          { transform: "none", opacity: 1 },
          {
            transform: `translate(${rand(-4, 4)}px, -6px) rotate(${spin * 0.4}deg)`,
            offset: 0.3,
          },
          {
            transform: `translate(${rand(-8, 8)}px, 4px) rotate(${spin}deg)`,
            opacity: 1,
            offset: 0.7,
          },
          { transform: `translate(${rand(-8, 8)}px, 4px) rotate(${spin}deg)`, opacity: 0 },
        ],
        { duration: 1100, easing: "ease-in", fill: "forwards" },
      );
      anim.onfinish = () => discard(n);
      // Belt and braces: the fake/absent animation never finishes.
      later(1200, () => discard(n));
    }
  }

  // ── Particles (self-removing) ── x/y are px from the critter's left/bottom.
  function particle(c: Critter, o: ParticleOptions): void {
    if (particles.size >= MAX_PARTICLES) {
      for (const p of particles) if (!p.isConnected) particles.delete(p);
      if (particles.size >= MAX_PARTICLES) return;
    }
    const p = el("div", `critter-pt ${o.cls}`, c.el);
    particles.add(p);
    if (o.text) p.textContent = o.text;
    if (o.color) p.style.setProperty("--critter-pc", o.color);
    p.style.left = `${o.x}px`;
    p.style.bottom = `${o.y}px`;
    const dx = o.dx ?? 0;
    const dy = o.dy ?? 0;
    const s0 = o.s0 ?? 1;
    const frames: Keyframe[] = [{ transform: `scale(${s0})`, opacity: o.o0 ?? 1 }];
    if (o.arc) {
      frames.push({
        transform: `translate(${dx * 0.5}px, ${-(dy * 0.5 + o.arc)}px) scale(${s0})`,
        opacity: 1,
        offset: 0.5,
      });
    }
    frames.push({
      transform: `translate(${dx}px, ${-dy}px) scale(${o.s1 ?? 0.5}) rotate(${o.rot ?? 0}deg)`,
      opacity: 0,
    });
    const done = (): void => {
      discard(p);
      particles.delete(p);
    };
    const a = p.animate(frames, {
      duration: o.dur ?? 600,
      delay: o.delay ?? 0,
      easing: o.ease ?? "cubic-bezier(0.2, 0.8, 0.4, 1)",
      fill: "both",
    });
    a.onfinish = done;
    a.oncancel = done;
  }

  const mid = (): number => SIZE / 2;
  const headY = (): number => SIZE * 0.85;
  const frontX = (c: Critter, cells = 16): number =>
    (c.dir > 0 ? cells : CRITTER_CELLS - cells) * PX;

  function sparks(c: Critter, n: number, outward = true): void {
    const pal = c.def.palette;
    const colors = ["#ffffff", pal.B ?? "#ffffff", pal.H ?? "#ffffff", pal.A ?? pal.B ?? "#ffffff"];
    for (let i = 0; i < n; i++) {
      const ang = outward ? rand(-Math.PI, 0) : rand(-Math.PI * 0.8, -Math.PI * 0.2);
      const dist = outward ? rand(14, 30) : rand(18, 50);
      particle(c, {
        cls: "critter-pt-dot",
        color: pick(colors),
        x: mid(),
        y: 10,
        dx: Math.cos(ang) * dist,
        dy: -Math.sin(ang) * dist * (outward ? 0.9 : 1.6),
        s0: 1.4,
        s1: 0.4,
        dur: rand(420, 700),
      });
    }
  }

  function stars(c: Critter, x: number, y: number, n = 4, color = "#ffe14d"): void {
    for (let i = 0; i < n; i++) {
      const ang = rand(-Math.PI * 0.95, -Math.PI * 0.05);
      particle(c, {
        cls: "critter-pt-txt",
        text: pick(["\u2726", "\u2727", "\u2605"]),
        color,
        x,
        y,
        dx: Math.cos(ang) * rand(10, 20),
        dy: -Math.sin(ang) * rand(8, 16),
        s0: 1.1,
        s1: 0.6,
        rot: rand(-90, 90),
        dur: rand(450, 650),
      });
    }
  }

  function puffs(c: Critter, n: number, x = mid(), y = 0, dir = 0): void {
    for (let i = 0; i < n; i++) {
      particle(c, {
        cls: "critter-pt-puff",
        x: x + rand(-3, 3),
        y,
        dx: (dir || pick([-1, 1])) * rand(4, 12),
        dy: rand(2, 7),
        s0: rand(0.8, 1.3),
        s1: 0.2,
        dur: rand(380, 520),
        delay: i * 40,
      });
    }
  }

  function notes(c: Critter, n = 3, color?: string): void {
    for (let i = 0; i < n; i++) {
      particle(c, {
        cls: "critter-pt-txt",
        text: pick(["\u266a", "\u266b", "\u266a"]),
        color: color ?? c.def.palette.B ?? "#ffffff",
        x: mid() + rand(-4, 6),
        y: headY(),
        dx: rand(-10, 10),
        dy: rand(18, 28),
        s0: 0.8,
        s1: 1.1,
        rot: rand(-20, 20),
        dur: rand(900, 1300),
        delay: i * 280,
        ease: "ease-out",
      });
    }
  }

  function glyphs(
    c: Critter,
    n: number,
    x: number,
    y: number,
    list: readonly string[],
    color = "#5ef08a",
  ): void {
    for (let i = 0; i < n; i++) {
      particle(c, {
        cls: "critter-pt-txt critter-pt-small",
        text: pick(list),
        color,
        x: x + rand(-4, 4),
        y,
        dx: rand(-6, 6),
        dy: rand(14, 22),
        s0: 0.7,
        s1: 1,
        dur: rand(700, 1000),
        delay: i * rand(120, 220),
        ease: "ease-out",
      });
    }
  }

  function steam(c: Critter, x: number, y: number, n = 3): void {
    for (let i = 0; i < n; i++) {
      particle(c, {
        cls: "critter-pt-puff critter-pt-steam",
        x: x + rand(-2, 2),
        y,
        dx: rand(-4, 4),
        dy: rand(10, 16),
        s0: 0.6,
        s1: 1.6,
        o0: 0.8,
        dur: rand(700, 1000),
        delay: i * 200,
        ease: "ease-out",
      });
    }
  }

  function dirt(c: Critter, n: number): void {
    for (let i = 0; i < n; i++) {
      particle(c, {
        cls: "critter-pt-dot",
        color: pick(["#7b5a3a", "#5c4129", "#a07850"]),
        x: frontX(c, 15),
        y: 0,
        dx: -c.dir * rand(10, 26),
        dy: -2,
        arc: rand(8, 16),
        dur: rand(450, 650),
        delay: i * 50,
        ease: "linear",
      });
    }
  }

  function confetti(c: Critter, n = 14): void {
    const colors = ["#ff6b60", "#ffe14d", "#7fe89a", "#8fdcff", "#b07cff", "#ffffff"];
    for (let i = 0; i < n; i++) {
      particle(c, {
        cls: "critter-pt-dot",
        color: pick(colors),
        x: mid(),
        y: headY(),
        dx: rand(-26, 26),
        dy: rand(-8, 4),
        arc: rand(14, 26),
        rot: rand(-200, 200),
        s0: 1.3,
        s1: 1,
        dur: rand(800, 1200),
        delay: i * 15,
        ease: "linear",
      });
    }
  }

  function sweat(c: Critter, n = 3): void {
    for (let i = 0; i < n; i++) {
      particle(c, {
        cls: "critter-pt-drop",
        x: c.dir > 0 ? 2 : SIZE - 4,
        y: SIZE - 4,
        dx: -c.dir * rand(8, 16),
        dy: rand(2, 10),
        s0: 1,
        s1: 0.8,
        dur: 450,
        delay: i * 90,
        ease: "ease-out",
      });
    }
  }

  function hearts(c: Critter, n = 2): void {
    for (let i = 0; i < n; i++) {
      particle(c, {
        cls: "critter-pt-txt",
        text: "\u2665",
        color: "#ff7aa8",
        x: mid() + rand(-4, 4),
        y: headY(),
        dx: rand(-6, 6),
        dy: rand(14, 20),
        s0: 0.6,
        s1: 1.1,
        dur: 1000,
        delay: i * 250,
        ease: "ease-out",
      });
    }
  }

  function blubs(c: Critter, n = 4): void {
    for (let i = 0; i < n; i++) {
      particle(c, {
        cls: "critter-pt-blub",
        x: frontX(c, 15),
        y: 18,
        dx: c.dir * rand(2, 10),
        dy: rand(16, 26),
        s0: 0.5,
        s1: 1.3,
        dur: rand(900, 1300),
        delay: i * 220,
        ease: "ease-out",
      });
    }
  }

  // ── Badges and speech ──
  function setBadge(c: Critter, kind: BadgeKind | null, text = ""): void {
    discard(c.el.querySelector(".critter-badge"));
    if (!kind) return;
    const b = el("div", `critter-badge critter-badge-${kind}`, c.el);
    b.textContent = text;
  }

  /** Flash a badge for a moment, then clear it (unless something replaced it). */
  async function flashBadge(c: Critter, kind: BadgeKind, text: string, ms = 700): Promise<void> {
    setBadge(c, kind, text);
    const b = c.el.querySelector(".critter-badge");
    await wait(ms);
    if (b?.isConnected) discard(b);
  }

  function clearBubble(c: Critter): void {
    discard(c.el.querySelector(".critter-bubble"));
  }

  let speakingUntil = 0;
  function say(c: Critter, text: string, ms = 1800, force = false): void {
    const now = performance.now();
    if (!force && now < speakingUntil) return;
    if (!force) speakingUntil = now + ms + 400;
    clearBubble(c);
    // Neighbours' bubbles would overlap this one, so a conversation reads as
    // turn-taking: the new line replaces whatever the one next door said.
    for (const o of live()) {
      if (o !== c && Math.abs(o.x - c.x) < SIZE * 2.6) clearBubble(o);
    }
    const bubble = el("div", "critter-bubble", c.el);
    const label = el("span", "critter-bubble-text", bubble);
    label.textContent = text;
    later(ms, () => discard(bubble));
  }

  // ── Overlay layers ──
  function thought(c: Critter): HTMLDivElement {
    const n = layer(c, "critter-thought");
    for (let i = 0; i < 3; i++) el("span", "", n);
    return n;
  }

  function dizzy(c: Critter, ms = 1200): HTMLDivElement {
    const n = layer(c, "critter-dizzy", { outside: true, ms });
    for (const star of ["\u2726", "\u2727", "\u2726"]) el("i", "", n).textContent = star;
    return n;
  }

  return {
    size,
    rand,
    pick,
    chance,
    wait,
    el,
    play,
    prop,
    layer,
    clearProps,
    dropProps,
    particle,
    sparks,
    stars,
    puffs,
    notes,
    glyphs,
    steam,
    dirt,
    confetti,
    sweat,
    hearts,
    blubs,
    setBadge,
    flashBadge,
    clearBubble,
    say,
    thought,
    dizzy,
    frontX,
    headY,
    mid,
  };
}
