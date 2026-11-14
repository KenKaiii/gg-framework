// What every part of the critter stage shares (critter-stage.ts): "things"
// (anything on the floor that isn't a critter: a saucer, a monster, an egg),
// small effects, pixel emotes, and a note of what each critter is up to for
// its tag. The lane is a window on a bigger world: things live in two layers
// clipped to its sides, so whatever leaves sideways goes out of frame, and
// whatever leaves upward shrinks into the distance.

import { art, type Art, type ArtSet, type EmoteName } from "./critter-art";
import { discard, PX, SIZE } from "./critter-fx";
import { PRIO } from "./critter-types";
import type { Critter, CritterApi, EaseName, StageOptions } from "./critter-types";

/** What the engine (critter-floor.ts) gives the stage. */
export interface StageHost {
  readonly api: CritterApi;
  readonly lane: HTMLElement;
  readonly floor: HTMLElement;
  readonly reduced: boolean;
  readonly ambient: boolean;
  readonly options: StageOptions;
  readonly random: () => number;
  readonly later: (ms: number, fn: () => void) => number;
  readonly place: (c: Critter) => void;
  /** A tween that may leave the lane (walking in, running off). */
  readonly tweenRaw: (
    c: Critter,
    to: number,
    ms: number,
    ease: EaseName,
    walking: boolean,
  ) => Promise<void>;
  /** The last show that kept the lane open is over (see CritterStage.busy). */
  readonly onQuiet: () => void;
}

export interface Thing {
  readonly node: HTMLDivElement;
  readonly inner: HTMLDivElement;
  x: number;
  y: number;
  readonly w: number;
  readonly h: number;
  at(x: number, y: number): void;
  move(x: number, y: number, ms: number, ease?: string): Promise<void>;
  face(dir: number): void;
  cycle(arts: readonly Art[], ms: number): void;
  show(a: Art): void;
  /** Where it is right now, mid-move included. */
  liveX(): number;
  liveY(): number;
  gone(): void;
}

export interface StageKit {
  readonly host: StageHost;
  readonly art: ArtSet;
  readonly tall: boolean;
  /** How far up things go before they're small enough to be gone. */
  readonly FAR: number;
  /** Where the saucer hovers (its underside above the floor). */
  readonly ALT: number;
  W(): number;
  alive(): boolean;
  stop(): void;
  /** The terrain the lane stands on ("meadow" when it has none). */
  biome(): string;
  thing(a: Art, x: number, y: number, o?: { behind?: boolean; cls?: string }): Thing;
  /** The transform that puts a thing at (x, y) above the floor. */
  T(x: number, y: number): string;
  centred(a: Art, cx: number): number;
  mid(c: Critter): number;
  puffAt(x: number, y: number, n?: number, spread?: number, color?: string): void;
  twinkle(x: number, y: number): void;
  pow(x: number, y: number, size?: number): void;
  shake(n?: number, ms?: number): void;
  hop(c: Critter, h?: number, ms?: number): Promise<void>;
  /** Through the air from where it is to (x, y), `peak` above the higher end. */
  arc(t: Thing, x: number, y: number, peak: number, ms: number, spin?: number): Promise<void>;
  shout(t: Thing, text: string, ms?: number): void;
  thingEmote(t: Thing, name: EmoteName, ms: number): void;
  flashEmote(c: Critter, name: EmoteName, ms?: number): Promise<void>;
  clearMarks(c: Critter): void;
  /** Critters with nothing better to do. */
  free(): Critter[];
  /** Everyone at work on the floor, busy or not. */
  acting(): Critter[];
  /** Nearby free critters turn and react. */
  onlookers(x: number, name: EmoteName, radius?: number, skip?: ReadonlySet<Critter>): void;
  /** Note what a critter is up to, for its tag. */
  say(c: Critter, text: string): void;
  doing(c: Critter): string | undefined;
  weigh<K extends string>(weights: Readonly<Record<K, number>>, avoid: K | null): K;
}

/** A pixel icon in a little paper bubble, where a text badge would be. */
export function emote(c: Critter, name: EmoteName): HTMLElement {
  discard(c.el.querySelector(".critter-badge"));
  const b = document.createElement("div");
  b.className = "critter-badge critter-emote";
  const a = art().emotes[name];
  const img = document.createElement("img");
  img.src = a.url;
  img.width = a.w * PX;
  img.height = a.h * PX;
  img.alt = "";
  b.append(img);
  c.el.append(b);
  return b;
}

export function makeStageKit(host: StageHost): StageKit {
  const { api, floor, lane, later, random } = host;
  const { fx } = api;
  const { rand, wait, play } = fx;
  const A = art();
  const tall = host.options.tall === true;
  const W = (): number => api.floorWidth();
  let alive = true;

  const layer = (cls: string, front: boolean): HTMLDivElement => {
    const n = fx.el("div", `critter-things ${cls}`);
    if (front) floor.append(n);
    else floor.prepend(n);
    return n;
  };
  const backLayer = layer("critter-things-back", false);
  const frontLayer = layer("critter-things-front", true);

  const T = (x: number, y: number): string => `translate(${x.toFixed(1)}px, ${(-y).toFixed(1)}px)`;

  function thing(a: Art, x: number, y: number, o: { behind?: boolean; cls?: string } = {}): Thing {
    const node = fx.el("div", `critter-thing ${o.cls ?? ""}`.trim());
    const inner = fx.el("div", "critter-thing-art", node);
    node.style.width = `${a.w * PX}px`;
    node.style.height = `${a.h * PX}px`;
    inner.style.backgroundImage = `url("${a.url}")`;
    (o.behind ? backLayer : frontLayer).append(node);
    let cycling = 0;
    const t: Thing = {
      node,
      inner,
      x,
      y,
      w: a.w * PX,
      h: a.h * PX,
      at(nx, ny) {
        t.x = nx;
        t.y = ny;
        node.style.transform = T(nx, ny);
      },
      async move(nx, ny, ms, ease = "ease-in-out") {
        const from = T(t.liveX(), t.liveY());
        for (const an of node.getAnimations()) an.cancel();
        t.at(nx, ny);
        await play(node, [{ transform: from }, { transform: T(nx, ny) }], {
          duration: Math.max(1, ms),
          easing: ease,
        });
      },
      face(dir) {
        inner.style.scale = dir < 0 ? "-1 1" : "";
      },
      cycle(arts, ms) {
        const id = ++cycling;
        let i = 0;
        const step = (): void => {
          if (!node.isConnected || id !== cycling) return;
          i = (i + 1) % arts.length;
          const next = arts[i];
          if (next) inner.style.backgroundImage = `url("${next.url}")`;
          later(ms, step);
        };
        later(ms, step);
      },
      show(next) {
        cycling++;
        inner.style.backgroundImage = `url("${next.url}")`;
      },
      liveX() {
        return node.getBoundingClientRect().left - floor.getBoundingClientRect().left;
      },
      liveY() {
        return floor.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom;
      },
      gone() {
        cycling++;
        discard(node);
      },
    };
    t.at(x, y);
    return t;
  }

  const mid = (c: Critter): number => c.x + SIZE / 2;

  function puffAt(x: number, y: number, n = 6, spread = 16, color?: string): void {
    for (let i = 0; i < n; i++) {
      const p = fx.el("div", "critter-pt critter-pt-puff", floor);
      p.style.left = `${x + rand(-4, 4)}px`;
      p.style.bottom = `${y}px`;
      if (color) p.style.background = color;
      const an = p.animate(
        [
          { transform: "scale(1.3)", opacity: 1 },
          {
            transform: `translate(${rand(-spread, spread)}px, ${-rand(2, spread)}px) scale(0.4)`,
            opacity: 0,
          },
        ],
        { duration: rand(380, 640), delay: i * 28, easing: "ease-out", fill: "both" },
      );
      an.onfinish = an.oncancel = () => discard(p);
    }
  }

  function twinkle(x: number, y: number): void {
    const s = fx.el("i", "critter-twinkle", floor);
    s.style.left = `${x}px`;
    s.style.bottom = `${y}px`;
    const an = s.animate(
      [
        { transform: "scale(0) rotate(0deg)", opacity: 1 },
        { transform: "scale(1) rotate(45deg)", opacity: 1, offset: 0.45 },
        { transform: "scale(0) rotate(90deg)", opacity: 0 },
      ],
      { duration: 480, easing: "ease-out" },
    );
    an.onfinish = an.oncancel = () => discard(s);
  }

  function pow(x: number, y: number, size = 22): void {
    const s = fx.el("i", "critter-pow", floor);
    Object.assign(s.style, {
      left: `${x}px`,
      bottom: `${y}px`,
      width: `${size}px`,
      height: `${size}px`,
      margin: `0 0 ${-size / 2}px ${-size / 2}px`,
    });
    const an = s.animate(
      [
        { transform: `scale(0.3) rotate(${rand(-25, 25)}deg)`, opacity: 1 },
        { transform: "scale(1.15)", opacity: 1, offset: 0.45 },
        { transform: "scale(0.9)", opacity: 0 },
      ],
      { duration: 240, easing: "ease-out" },
    );
    an.onfinish = an.oncancel = () => discard(s);
  }

  function shake(n = 2, ms = 320): void {
    floor.animate(
      [0, -n, n, -n, n / 2, 0].map((d) => ({ transform: `translateY(${d}px)` })),
      { duration: ms, easing: "linear" },
    );
  }

  const hop = (c: Critter, h = 8, ms = 320): Promise<void> =>
    play(
      c.body,
      [
        { transform: "none" },
        { transform: `translateY(${-h}px) scale(0.94, 1.08)`, offset: 0.45 },
        { transform: "scale(1.1, 0.9)", offset: 0.8 },
        { transform: "none" },
      ],
      { duration: ms, easing: "ease-out" },
    );

  async function arc(
    t: Thing,
    x: number,
    y: number,
    peak: number,
    ms: number,
    spin = 0,
  ): Promise<void> {
    const fromX = t.liveX();
    const fromY = t.liveY();
    for (const an of t.node.getAnimations()) an.cancel();
    t.at(x, y);
    if (spin) {
      void play(t.inner, [{ rotate: "0deg" }, { rotate: `${spin}deg` }], {
        duration: ms,
        easing: "linear",
      });
    }
    await play(
      t.node,
      [
        { transform: T(fromX, fromY), easing: "ease-out" },
        { transform: T((fromX + x) / 2, Math.max(fromY, y) + peak), easing: "ease-in" },
        { transform: T(x, y) },
      ],
      { duration: Math.max(1, ms) },
    );
  }

  function shout(t: Thing, text: string, ms = 1100): void {
    const b = fx.el("div", "critter-bubble", t.node);
    fx.el("span", "critter-bubble-text", b).textContent = text;
    later(ms, () => discard(b));
  }

  function thingEmote(t: Thing, name: EmoteName, ms: number): void {
    const e = fx.el("img", "critter-thing-emote", t.node);
    const a = A.emotes[name];
    e.src = a.url;
    e.alt = "";
    e.width = a.w * PX * 2;
    e.height = a.h * PX * 2;
    later(ms, () => discard(e));
  }

  async function flashEmote(c: Critter, name: EmoteName, ms = 900): Promise<void> {
    const e = emote(c, name);
    await wait(ms);
    if (e.isConnected) discard(e);
  }

  const clearMarks = (c: Critter): void => {
    fx.clearBubble(c);
    discard(c.el.querySelector(".critter-badge"));
  };

  const free = (): Critter[] => api.live().filter((c) => api.isFree(c));
  const acting = (): Critter[] => api.live().filter((c) => api.canAct(c) && c.mode !== "summon");

  const notes = new WeakMap<Critter, string>();
  const say = (c: Critter, text: string): void => void notes.set(c, text);

  function onlookers(x: number, name: EmoteName, radius = 150, skip?: ReadonlySet<Critter>): void {
    for (const o of free()) {
      if (skip?.has(o) || Math.abs(mid(o) - x) > radius) continue;
      void api.perform(o, PRIO.idle, async () => {
        say(o, "Watching");
        api.face(o, x >= mid(o) ? 1 : -1);
        void play(
          o.body,
          [{ transform: "none" }, { transform: `rotate(${-8 * o.dir}deg)` }, { transform: "none" }],
          { duration: 900 },
        );
        await flashEmote(o, name, 900);
      });
    }
  }

  function weigh<K extends string>(weights: Readonly<Record<K, number>>, avoid: K | null): K {
    const keys = (Object.keys(weights) as K[]).filter((k) => weights[k] > 0 && k !== avoid);
    let r = random() * keys.reduce((s, k) => s + weights[k], 0);
    for (const k of keys) {
      r -= weights[k];
      if (r <= 0) return k;
    }
    return keys[keys.length - 1] as K;
  }

  return {
    host,
    art: A,
    tall,
    FAR: tall ? 250 : 132,
    ALT: SIZE + 12,
    W,
    alive: () => alive,
    stop: () => void (alive = false),
    biome: () => lane.querySelector<HTMLElement>(".critter-terrain")?.dataset.terrain ?? "meadow",
    thing,
    T,
    centred: (a, cx) => cx - (a.w * PX) / 2,
    mid,
    puffAt,
    twinkle,
    pow,
    shake,
    hop,
    arc,
    shout,
    thingEmote,
    flashEmote,
    clearMarks,
    free,
    acting,
    onlookers,
    say,
    doing: (c) => notes.get(c),
    weigh,
  };
}
