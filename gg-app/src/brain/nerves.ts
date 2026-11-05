/**
 * The nerves: one living nerve per connected provider, drawn on a 2D canvas
 * from the provider's card to its region of the brain. It grows in when the
 * provider connects, writhes gently, tapers toward the brain and frays into
 * dendrites across the region. A heartbeat runs down every connected nerve.
 */
export interface Pt {
  x: number;
  y: number;
}
interface PathPt extends Pt {
  l: number;
}
type Path = PathPt[] & { len: number };

export interface NervePalette {
  /** The nerve body and glow. */
  lit: string;
  /** Its bright core, heartbeat and sparks. */
  spark: string;
  /** Glow adds light on dark; on light it would wash out. */
  dark: boolean;
}

export interface Nerve {
  /**
   * The card's port: the midpoint of the edge the nerve leaves from, which way
   * it leaves, how much of it is in view (0..1), and the join's size. `clip`
   * is the scrolling list's visible band; the join never shows outside it.
   */
  from: Pt & {
    dir: Pt;
    visible: number;
    /** Half-width of the join where it meets the card's edge. */
    base: number;
    /** How far the join stands off the card before the nerve takes over. */
    len: number;
    clip?: { top: number; bottom: number };
  };
  /** The card's colour at the port (its surface plus its port glow), so the join matches it exactly. */
  edge: string;
  /** The region's anchor on screen. */
  to: Pt;
  /** Dendrite tips across the region, on screen. */
  tips: Pt[];
  /** 0..1 grown; nerves grow in on connect. */
  grow: number;
  /** 0..1 opacity; nerves fade out on disconnect. */
  fade: number;
  /** Connected and through: carries the heartbeat. */
  live: boolean;
  hot: boolean;
  /** Dimmed while another nerve is hovered. */
  muted: boolean;
  seed: number;
}

/** How far past its list's edge a card's port can go before its nerve is gone, in px. */
const EDGE_FADE = 28;

/**
 * How much of a nerve to draw for a port at `y` in a list showing `top`..`bottom`:
 * whole while the card is in view, fading out as it scrolls past the edge, so a
 * nerve never ends in mid-air on a card you can't see.
 */
export function edgeVisibility(y: number, top: number, bottom: number): number {
  const past = Math.max(top - y, y - bottom, 0);
  return Math.max(0, 1 - past / EDGE_FADE);
}

/** Half-width of the join where it hands over to the nerve. */
const JOIN_TIP = 2.4;

/**
 * The join's half-width at the card edge: as wide as the edge's straight run
 * allows (`edge` long, corners of `radius`), so it never meets a rounded corner
 * and shows a seam there.
 */
export function joinBase(edge: number, radius: number): number {
  return Math.min(12, Math.max(JOIN_TIP + 2, edge / 2 - radius - 1));
}

/** Parse `#rgb`, `#rrggbb` or `rgb()/rgba()` to 0..255 channels. */
function channels(color: string): [number, number, number] {
  const c = color.trim();
  if (c.startsWith("#")) {
    const hex = c.length === 4 ? c.replace(/^#(.)(.)(.)$/, "#$1$1$2$2$3$3") : c;
    const n = parseInt(hex.slice(1, 7), 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  const m = c.match(/[\d.]+/g);
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : [0, 0, 0];
}

/**
 * `a` with `t` of `b` laid over it, in sRGB: the same result as CSS
 * `color-mix(in srgb, b t, transparent)` painted on `a`.
 */
export function mixColor(a: string, b: string, t: number): string {
  const x = channels(a);
  const y = channels(b);
  const k = Math.min(1, Math.max(0, t));
  const ch = (i: 0 | 1 | 2): number => Math.round(x[i] + (y[i] - x[i]) * k);
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
}

/**
 * The join: the card's own surface swelling out of its edge and tapering into
 * the nerve, like a nerve cell's body narrowing into its fibre. Its flanks
 * leave the edge tangentially (true fillets), it starts in the card's exact
 * colour and warms into the nerve's, and it is opaque, so card, join and nerve
 * read as one piece. Returns where the nerve takes over.
 */
function drawJoin(ctx: CanvasRenderingContext2D, n: Nerve, c: NervePalette, nerveFade: number): Pt {
  const P = n.from;
  const u = P.dir;
  const v = { x: -u.y, y: u.x };
  // Grows out of the card as the nerve sets off; shrinks back into it on disconnect.
  const grown = Math.min(1, n.grow / 0.18);
  const len = P.len * (1 - Math.pow(1 - grown, 3)) * n.fade;
  const at = (a: number, b: number): Pt => ({
    x: P.x + u.x * a + v.x * b,
    y: P.y + u.y * a + v.y * b,
  });
  const tip = at(len, 0);
  // A card mid-layout can measure as nothing; skip it rather than throw and stop the loop.
  if (!(len >= 0.5) || !Number.isFinite(P.base) || P.visible < 0.999) return tip;
  const B = P.base;
  const T = JOIN_TIP;
  const k = (B - T) * 0.55;
  ctx.save();
  if (P.clip) {
    ctx.beginPath();
    ctx.rect(-1e5, P.clip.top, 2e5, P.clip.bottom - P.clip.top);
    ctx.clip();
  }
  ctx.globalCompositeOperation = "source-over";
  const fill = ctx.createLinearGradient(P.x, P.y, tip.x, tip.y);
  fill.addColorStop(0, n.edge);
  fill.addColorStop(0.35, n.edge);
  fill.addColorStop(1, mixColor(n.edge, c.lit, 0.62 * nerveFade));
  ctx.fillStyle = fill;
  ctx.beginPath();
  // Starts tucked under the card, so no hairline shows along the edge.
  let p = at(-3, -B);
  ctx.moveTo(p.x, p.y);
  p = at(0, -B);
  ctx.lineTo(p.x, p.y);
  let c1 = at(0, -B + k);
  let c2 = at(len * 0.35, -T);
  p = at(len, -T);
  ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
  p = at(len, T);
  ctx.lineTo(p.x, p.y);
  c1 = at(len * 0.35, T);
  c2 = at(0, B - k);
  p = at(0, B);
  ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
  p = at(-3, B);
  ctx.lineTo(p.x, p.y);
  ctx.closePath();
  ctx.fill();
  // The nerve's bright core rises out of the card through the join.
  const from = at(len * 0.2, 0);
  const core = ctx.createLinearGradient(from.x, from.y, tip.x, tip.y);
  core.addColorStop(0, rgba(c.spark, 0));
  core.addColorStop(1, rgba(c.spark, 0.75 * nerveFade));
  ctx.strokeStyle = core;
  ctx.lineWidth = 1.2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  ctx.restore();
  return tip;
}

/** Where the trunk ends and the dendrites take over. */
const SPLIT = 0.82;

/** Heartbeat phase 0..1 and its thump 0..1 (peaks as the beat reaches the brain). */
export function heartbeat(t: number, tier: number): { phase: number; thump: number } {
  const period = 1.3 - 0.08 * tier;
  const phase = (t % period) / period;
  return { phase, thump: Math.exp(-Math.pow((phase - 0.64) * 12, 2)) };
}

function cubic(p0: Pt, c1: Pt, c2: Pt, p1: Pt, n: number): Path {
  const pts = [] as unknown as Path;
  let L = 0;
  let px = p0.x;
  let py = p0.y;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    const x = a * p0.x + b * c1.x + c * c2.x + d * p1.x;
    const y = a * p0.y + b * c1.y + c * c2.y + d * p1.y;
    L += Math.hypot(x - px, y - py);
    px = x;
    py = y;
    pts.push({ x, y, l: L });
  }
  pts.len = Math.max(L, 0.001);
  return pts;
}

function at(pts: Path, s: number): Pt {
  const L = Math.min(1, Math.max(0, s)) * pts.len;
  let i = 1;
  while (i < pts.length - 1 && pts[i]!.l < L) i++;
  const a = pts[i - 1]!;
  const b = pts[i]!;
  const k = b.l > a.l ? (L - a.l) / (b.l - a.l) : 0;
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

function trace(ctx: CanvasRenderingContext2D, pts: Path, s0: number, s1: number): void {
  if (s1 <= s0) return;
  const L0 = s0 * pts.len;
  const L1 = s1 * pts.len;
  const a = at(pts, s0);
  const b = at(pts, s1);
  ctx.moveTo(a.x, a.y);
  for (const p of pts) if (p.l > L0 && p.l < L1) ctx.lineTo(p.x, p.y);
  ctx.lineTo(b.x, b.y);
}

export function rgba(color: string, alpha: number): string {
  const c = color.trim();
  if (c.startsWith("#")) {
    const hex = c.length === 4 ? c.replace(/^#(.)(.)(.)$/, "#$1$1$2$2$3$3") : c;
    const n = parseInt(hex.slice(1, 7), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  const m = c.match(/[\d.]+/g);
  return m && m.length >= 3 ? `rgba(${m[0]},${m[1]},${m[2]},${alpha})` : c;
}

/**
 * Draw every nerve. `t` is seconds; `center` is the brain's centre on screen
 * (nerves arrive from outside the brain, along the line from it).
 */
export function drawNerves(
  ctx: CanvasRenderingContext2D,
  nerves: readonly Nerve[],
  center: Pt,
  t: number,
  tier: number,
  live: boolean,
  c: NervePalette,
): void {
  const { phase, thump } = live ? heartbeat(t, tier) : { phase: 0.2, thump: 0 };
  const wave = phase / 0.64;
  const add = c.dark ? "lighter" : "source-over";
  for (const n of nerves) {
    const A = n.to;
    // The nerve takes over where the join ends (drawn after, over its root).
    const len = n.from.len * (1 - Math.pow(1 - Math.min(1, n.grow / 0.18), 3)) * n.fade;
    const P = { ...n.from, x: n.from.x + n.from.dir.x * len, y: n.from.y + n.from.dir.y * len };
    const al = Math.hypot(A.x - center.x, A.y - center.y) || 1;
    const ap = { x: (A.x - center.x) / al, y: (A.y - center.y) / al };
    const d = Math.hypot(A.x - P.x, A.y - P.y);
    const w = live ? 1 : 0;
    const s = n.seed;
    // The nerve writhes slowly: its control points drift on their own clocks.
    const pts = cubic(
      P,
      {
        x: P.x + P.dir.x * d * 0.45 + Math.sin(t * 0.8 + s) * 10 * w,
        y: P.y + P.dir.y * d * 0.45 + Math.cos(t * 0.6 + s * 2) * 10 * w,
      },
      {
        x: A.x + ap.x * d * 0.42 + Math.sin(t * 0.7 + s * 3) * 14 * w,
        y: A.y + ap.y * d * 0.42 + Math.cos(t * 0.9 + s) * 14 * w,
      },
      A,
      56,
    );
    const fade = n.fade * P.visible * (n.muted ? 0.4 : 1);
    if (fade <= 0.01) continue;
    const beating = n.live && live;
    const main = Math.min(n.grow, SPLIT);
    // Glow: one continuous stroke (per-segment round caps would overlap into beads).
    ctx.globalCompositeOperation = add;
    ctx.lineCap = "round";
    ctx.strokeStyle = rgba(c.lit, (c.dark ? 0.14 : 0.08) * fade);
    ctx.lineWidth = n.hot ? 12 : 9;
    ctx.beginPath();
    trace(ctx, pts, 0, main);
    ctx.stroke();
    // Body and core taper per segment; the heartbeat swells and brightens them as it passes.
    ctx.lineCap = "butt";
    for (let pass = 1; pass < 3; pass++) {
      ctx.globalCompositeOperation = pass === 2 ? add : "source-over";
      for (let i = 1; i < pts.length; i++) {
        const sp = pts[i]!.l / pts.len;
        if (sp > main) break;
        const wv = beating ? Math.exp(-Math.pow((sp - wave) * 9, 2)) : 0;
        // A touch fuller at the root, where it leaves the join.
        const root = 1 + 0.35 * Math.exp(-pts[i]!.l / 9);
        const wd = (3.6 - 2.2 * sp) * root * (1 + 0.8 * wv) * (n.hot ? 1.2 : 1);
        ctx.lineWidth = pass === 1 ? wd : Math.max(0.8, wd * 0.4);
        ctx.strokeStyle =
          pass === 1
            ? rgba(c.lit, (c.dark ? 0.55 : 0.75) * fade + 0.25 * wv * fade)
            : rgba(c.spark, (0.2 + 0.8 * wv) * fade);
        ctx.beginPath();
        ctx.moveTo(pts[i - 1]!.x, pts[i - 1]!.y);
        ctx.lineTo(pts[i]!.x, pts[i]!.y);
        ctx.stroke();
      }
    }
    // The heartbeat itself: a bright bead riding the nerve.
    if (beating && wave <= 1) {
      const q = at(pts, Math.min(wave, main));
      ctx.globalCompositeOperation = add;
      ctx.fillStyle = rgba(c.spark, fade);
      if (c.dark) {
        ctx.shadowColor = c.lit;
        ctx.shadowBlur = 14;
      }
      ctx.beginPath();
      ctx.arc(q.x, q.y, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.lineCap = "round";
    // Dendrites: the nerve frays into the region and each tip sparks on the beat.
    if (n.grow > SPLIT) {
      const g = Math.min(1, (n.grow - SPLIT) / (1 - SPLIT));
      const S = at(pts, SPLIT);
      const spark = beating ? thump : 0;
      n.tips.forEach((Q, k) => {
        const bend = Math.sin(s + k * 1.7) * 0.22;
        const m = {
          x: (S.x + Q.x) / 2 + (Q.y - S.y) * bend,
          y: (S.y + Q.y) / 2 - (Q.x - S.x) * bend,
        };
        const br = cubic(S, m, m, Q, 10);
        ctx.globalCompositeOperation = add;
        ctx.strokeStyle = rgba(c.lit, 0.55 * fade);
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        trace(ctx, br, 0, g);
        ctx.stroke();
        if (g >= 1) {
          ctx.fillStyle = rgba(c.spark, (0.45 + 0.55 * spark) * fade);
          if (c.dark) {
            ctx.shadowColor = c.lit;
            ctx.shadowBlur = 6 + 10 * spark;
          }
          ctx.beginPath();
          ctx.arc(Q.x, Q.y, 1.8 + 2.4 * spark, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      });
    }
  }
  // The joins are part of the cards, so they sit over every nerve, as the cards do.
  for (const n of nerves) drawJoin(ctx, n, c, n.fade * n.from.visible * (n.muted ? 0.4 : 1));
  ctx.globalCompositeOperation = "source-over";
}
