import { brainTier } from "../provider-groups";
import type { MotionLevel } from "../window-motion";
import { BrainView } from "./BrainView";
import { buildBrain, type BrainModel, type Vec3 } from "./brain-model";
import {
  drawNerves,
  edgeVisibility,
  heartbeat,
  joinBase,
  mixColor,
  type Nerve,
  type NervePalette,
  type Pt,
} from "./nerves";

/**
 * The AI Providers brain bay, wired up: the brain, the nerve overlay, and the
 * life cycle of each connection (a nerve grows in from the card, then the
 * region charges; on disconnect the nerve fades and the region drains). Loaded
 * on demand so three.js stays out of the app's first paint.
 */
export interface BrainBayOptions {
  /** The bay. The nerve canvas covers it; card ports are found inside it. */
  root: HTMLElement;
  /** Where the brain renders. */
  stage: HTMLElement;
  /** The nerve overlay, absolutely covering `root`. */
  overlay: HTMLCanvasElement;
  /** Provider values, in region order. */
  providers: readonly string[];
  onHover: (value: string | null) => void;
  onPick: (value: string) => void;
}

export interface BrainBay {
  setConnected(values: readonly string[]): void;
  setHot(value: string | null): void;
  setMotion(level: MotionLevel): void;
  dispose(): void;
}

/** Seconds for a nerve to grow from the card to the brain. */
const GROW = 0.9;
/** Seconds after connecting that the region starts to charge (the nerve has landed). */
const CHARGE_AFTER = 1.0;
const FADE_OUT = 0.65;
const TIPS = 5;

interface Link {
  region: number;
  t0: number;
  out: number | null;
  seed: number;
  pulsed: boolean;
}

const now = (): number => performance.now() / 1000;
const ease = (x: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

/** Five well-spread points across each region, for the nerve's dendrites to land on. */
function dendriteTips(model: BrainModel): Vec3[][] {
  return model.anchors.map((anchor, r) => {
    const candidates: Vec3[] = [];
    for (let i = 0; i < model.count; i++) {
      if (model.region[i] !== r || !model.surface[i]) continue;
      const d = model.dA[i] ?? 0;
      if (d > 0.2 && d < 0.8) {
        candidates.push([
          model.position[i * 3] ?? 0,
          model.position[i * 3 + 1] ?? 0,
          model.position[i * 3 + 2] ?? 0,
        ]);
      }
    }
    const picked: Vec3[] = [anchor];
    while (picked.length <= TIPS && candidates.length > 0) {
      let best = candidates[0]!;
      let bestD = -1;
      for (const v of candidates) {
        const m = Math.min(...picked.map((q) => Math.hypot(q[0] - v[0], q[1] - v[1], q[2] - v[2])));
        if (m > bestD) {
          bestD = m;
          best = v;
        }
      }
      picked.push(best);
    }
    return picked.slice(1);
  });
}

export function mountBrainBay(o: BrainBayOptions): BrainBay {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const total = o.providers.length;
  const model = buildBrain(o.providers);
  const tips = dendriteTips(model);
  const links = new Map<string, Link>();
  let hot: string | null = null;
  let motion: MotionLevel = "full";
  let primed = false;
  let raf = 0;
  let last = now();
  let disposed = false;

  const invalidate = (): void => {
    if (!raf && !disposed && motion !== "off") raf = requestAnimationFrame(frame);
  };
  const view = new BrainView(o.stage, model, {
    onHover: (r) => {
      hot = r >= 0 ? (o.providers[r] ?? null) : null;
      o.onHover(hot);
    },
    onPick: (r) => {
      const v = o.providers[r];
      if (v) o.onPick(v);
    },
    onInvalidate: invalidate,
  });
  const ctx = o.overlay.getContext("2d");

  let surfaces = { rest: "#1f2226", hot: "#2a2e33" };
  let portGlow = 0.16;
  let cardRadius = 14;
  let palette: NervePalette = { lit: "#8fa3ff", spark: "#e4ecff", dark: true };
  const readColors = (): void => {
    const cs = getComputedStyle(o.root);
    const v = (name: string, fallback: string): string =>
      cs.getPropertyValue(name).trim() || fallback;
    const dark = document.documentElement.dataset.theme !== "light";
    palette = { lit: v("--bay-lit", "#8fa3ff"), spark: v("--bay-spark", "#e4ecff"), dark };
    // The card colours the joins must match, and the port glow they carry (ProvidersBay.css).
    surfaces = { rest: v("--surface-1", "#1f2226"), hot: v("--surface-2", "#2a2e33") };
    portGlow = (parseFloat(v("--bay-port-glow", "16%")) || 0) / 100;
    cardRadius = parseFloat(v("--radius-card", "14px")) || 14;
    view.setPalette({
      dim: v("--bay-dim", "#5d6678"),
      lit: palette.lit,
      hot: palette.spark,
      core: v("--bay-core", "#7fdc95"),
      dark,
    });
    invalidate();
  };
  readColors();
  const themeObserver = new MutationObserver(readColors);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  const resizeObserver = new ResizeObserver(invalidate);
  resizeObserver.observe(o.root);
  // Cards scroll inside their banks; their nerves follow.
  o.root.addEventListener("scroll", invalidate, true);

  const animating = (): boolean => motion === "full" && !reduced;

  /** A card's port on the overlay, leaving along the edge it sits on. */
  const portOf = (value: string, base: DOMRect): Nerve["from"] | null => {
    const port = o.root.querySelector<HTMLElement>(`[data-bay-port="${CSS.escape(value)}"]`);
    const card = port?.closest<HTMLElement>("[data-bay-card]");
    if (!port || !card) return null;
    const p = port.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const px = p.left + p.width / 2;
    const py = p.top + p.height / 2;
    const dx = (px - (c.left + c.width / 2)) / Math.max(1, c.width);
    const dy = (py - (c.top + c.height / 2)) / Math.max(1, c.height);
    const dir =
      Math.abs(dx) > Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) || -1 };
    let x = px - base.left;
    let y = py - base.top;
    let visible = 1;
    // Stacked cards leave from the top edge (rows are 16px apart); wide ones from the side.
    const joinLen = dir.x !== 0 ? 18 : 11;
    const joinWidth = joinBase(dir.x !== 0 ? c.height : c.width, cardRadius);
    let clip: { top: number; bottom: number } | undefined;
    // The nearest bank that scrolls; a bank laid out as display: contents has no box.
    let scroller = port.closest<HTMLElement>("[data-bay-scroll]");
    while (scroller && scroller.getBoundingClientRect().height === 0) {
      scroller = scroller.parentElement?.closest<HTMLElement>("[data-bay-scroll]") ?? null;
    }
    if (scroller) {
      // A card scrolling out of its list takes its nerve with it: the nerve
      // slides to the list's edge and fades, never left hanging from nothing.
      const s = scroller.getBoundingClientRect();
      const top = s.top - base.top;
      const bottom = s.bottom - base.top;
      visible = edgeVisibility(y, top, bottom);
      clip = { top, bottom };
      y = Math.max(top, Math.min(bottom, y));
      x = Math.max(s.left - base.left, Math.min(s.right - base.left, x));
    }
    return { x, y, dir, visible, base: joinWidth, len: joinLen, ...(clip ? { clip } : {}) };
  };

  function frame(): void {
    raf = 0;
    if (disposed) return;
    const t = now();
    const dt = Math.min(0.05, t - last);
    last = t;
    const live = animating();
    for (const [v, l] of links) if (l.out !== null && t - l.out > FADE_OUT) links.delete(v);

    // Regions charge once their nerve has landed; each landing sends a pulse through the brain.
    const charged = new Set<number>();
    let connected = 0;
    for (const l of links.values()) {
      if (l.out !== null) continue;
      connected++;
      if (t - l.t0 >= CHARGE_AFTER) {
        charged.add(l.region);
        if (!l.pulsed) {
          l.pulsed = true;
          view.pulse(l.region, 1);
        }
      }
    }
    const tier = brainTier(connected, total);
    view.setCharged(charged, total, tier);
    view.beat = live && charged.size > 0 ? heartbeat(t, tier).thump : 0;
    const busy = view.step(dt, live);
    view.render();

    let growing = false;
    if (ctx) {
      const base = o.root.getBoundingClientRect();
      const stage = o.stage.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(base.width * dpr);
      const h = Math.round(base.height * dpr);
      if (o.overlay.width !== w || o.overlay.height !== h) {
        o.overlay.width = w;
        o.overlay.height = h;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, base.width, base.height);
      const sx = stage.left - base.left;
      const sy = stage.top - base.top;
      const onStage = (p: Pt): Pt => ({ x: p.x + sx, y: p.y + sy });
      const focus = hot !== null && links.has(hot);
      const nerves: Nerve[] = [];
      for (const [v, l] of links) {
        const from = portOf(v, base);
        const anchor = model.anchors[l.region];
        if (!from || !anchor) continue;
        const age = t - l.t0;
        if (age < CHARGE_AFTER || l.out !== null) growing = true;
        // The card's colour at its port: its surface (lighter while hot) plus the
        // port glow it shows while connected. A leaving nerve's card has lost its glow.
        const surface = hot === v ? surfaces.hot : surfaces.rest;
        nerves.push({
          from,
          edge: l.out === null ? mixColor(surface, palette.lit, portGlow) : surface,
          to: onStage(view.project(anchor)),
          tips: (tips[l.region] ?? []).map((q) => onStage(view.project(q))),
          grow: ease(age / GROW),
          fade: l.out === null ? 1 : 1 - ease((t - l.out) / FADE_OUT),
          live: l.out === null && age >= GROW,
          hot: hot === v,
          muted: focus && hot !== v,
          seed: l.seed,
        });
      }
      drawNerves(ctx, nerves, onStage(view.center()), t, tier, live, palette);
    }
    if (live || busy || growing) invalidate();
  }

  return {
    setConnected(values) {
      const t = now();
      // The first read is the state the page opened in: already wired, no growing in.
      const settled = !primed || !animating();
      const want = new Set(values);
      for (const v of want) {
        const region = o.providers.indexOf(v);
        if (region < 0) continue;
        const l = links.get(v);
        if (l && l.out === null) continue;
        links.set(v, {
          region,
          t0: settled ? t - 60 : t,
          out: null,
          seed: Math.random() * 100,
          pulsed: settled,
        });
      }
      for (const [v, l] of links) {
        if (!want.has(v) && l.out === null) {
          if (settled) links.delete(v);
          else l.out = t;
        }
      }
      if (settled) {
        const charged = new Set([...links.values()].map((l) => l.region));
        view.setCharged(charged, total, brainTier(charged.size, total));
        view.settle();
      }
      primed = true;
      invalidate();
    },
    setHot(value) {
      hot = value;
      view.setHover(value ? o.providers.indexOf(value) : -1);
      invalidate();
    },
    setMotion(level) {
      const wasLive = animating();
      motion = level;
      if (level === "off" && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (!wasLive) last = now();
      invalidate();
    },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      themeObserver.disconnect();
      resizeObserver.disconnect();
      o.root.removeEventListener("scroll", invalidate, true);
      view.dispose();
    },
  };
}
