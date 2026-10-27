// @ts-check
// Mini-game art kit (owner: "the mini-games look bland and basic next to the world; make them the real deal").
// One look for every overlay game, so they feel like part of GG World: lit, textured, framed, animated.
// All canvas-2D, pixel-crisp, no assets. Coordinates are canvas pixels (overlays are usually 480 x 270 or 320 x 180).
//
//   bg.vignette(x, W, H, '#1a1028')            soft radial backdrop + vignette (never a flat fill)
//   bg.room(x, W, H, { floor, wall, light })     a little lit room: wall, skirting, floor boards, a warm light pool
//   panel(x, X, Y, W, H, { style })              framed panel: 'wood' | 'metal' | 'paper' | 'neon' | 'glass' | 'felt' | 'crt'
//   badge(x, X, Y, label, value, { color })      a stat chip (label small, value big), e.g. POT / STREAK / BEST
//   button(x, X, Y, W, H, label, { hot, primary, disabled })   shaded, bevelled pixel button (+ hover glow when hot)
//   banner(x, W, H, title, sub, t, { color })    big animated result / title card (WIN / BUST / LEVEL 2), eases in
//   title(x, s, X, Y, { size, color, glow })     m5x7 heading with an ink outline and optional glow
//   shine(x, X, Y, W, H, t)                      a moving highlight sweep over a panel (attention)
//   fx = particles()                             fx.burst(x, y, { n, colors, speed, gravity }), fx.confetti(W), fx.sparkle(x, y), fx.draw(x, dt)
//   shake = shaker(); shake.kick(6); x.save(); shake.apply(x, dt); ... x.restore()   screen shake that settles
//   ease.outBack / outCubic / inOut, lerp, clamp
//   glow(x, X, Y, r, color, a)                   additive soft light (lamps, coins, neon)
//   noise(x, X, Y, W, H, a, seed)                film-grain / texture speckle
//   coin(x, X, Y, r, t)                          spinning gold coin
//   PAL                                          shared colours (ink, cream, gold, wood, felt, neon...)
import { CFONT } from '../fonts.js';

export const PAL = {
  ink: '#120c18', ink2: '#1e1628', cream: '#f3e6cc', dim: '#a89cb8', gold: '#f5bd63', goldD: '#c8862a', goldHi: '#ffe8a0',
  wood: '#6a4430', woodHi: '#8a5a3a', woodLo: '#3e2618', felt: '#1f6a4a', feltHi: '#2e8a62', metal: '#5a6270', metalHi: '#9aa4b2',
  red: '#e8645a', green: '#6ee7a0', blue: '#8fa3ff', pink: '#ff7ab8', cyan: '#62e8d8', purple: '#b07aff', paper: '#efe2c4', paperInk: '#3a2414',
};
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const ease = { outCubic: t => 1 - Math.pow(1 - t, 3), outBack: t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }, inOut: t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 };

const shade = (hex, k) => { const n = parseInt(hex.slice(1), 16); const f = c => Math.max(0, Math.min(255, Math.round(k >= 0 ? c + (255 - c) * k : c * (1 + k)))); return '#' + [n >> 16 & 255, n >> 8 & 255, n & 255].map(f).map(v => v.toString(16).padStart(2, '0')).join(''); };
export { shade };

/** text with an ink outline (crisp on any background) */
export function title(x, s, X, Y, o = {}) {
  const size = o.size || 16; x.save(); x.font = CFONT.body(size); /* m5x7 for all mini-game text (owner) */ x.textAlign = o.align || 'center'; x.textBaseline = 'alphabetic';
  X = Math.round(X); Y = Math.round(Y);
  if (o.glow) { x.shadowColor = o.glow; x.shadowBlur = o.glowR || 10; x.fillStyle = o.glow; x.fillText(s, X, Y); x.shadowBlur = 0; }
  x.fillStyle = o.ink || PAL.ink; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [0, 2], [1, 2], [-1, 2]]) x.fillText(s, X + dx, Y + dy);
  x.fillStyle = o.color || PAL.cream; x.fillText(s, X, Y); x.restore();
}

/** additive soft light */
export function glow(x, X, Y, r, color = '#ffcf8a', a = 0.5) {
  x.save(); x.globalCompositeOperation = 'lighter'; const g = x.createRadialGradient(X, Y, 0, X, Y, r); g.addColorStop(0, color); g.addColorStop(1, 'rgba(0,0,0,0)'); x.globalAlpha = a; x.fillStyle = g; x.fillRect(X - r, Y - r, r * 2, r * 2); x.restore();
}
/** speckle texture */
export function noise(x, X, Y, W, H, a = 0.06, seed = 7) {
  let s = seed >>> 0; const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; x.save();
  for (let i = 0; i < W * H / 40; i++) { x.fillStyle = r() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 1.4})`; x.fillRect(X + Math.floor(r() * W), Y + Math.floor(r() * H), 1, 1); }
  x.restore();
}

export const bg = {
  /** radial backdrop + vignette */
  vignette(x, W, H, base = '#1a1028', light = null) {
    const g = x.createRadialGradient(W / 2, H * 0.42, 10, W / 2, H * 0.5, Math.max(W, H) * 0.75); g.addColorStop(0, light || shade(base, 0.22)); g.addColorStop(0.6, base); g.addColorStop(1, shade(base, -0.55));
    x.fillStyle = g; x.fillRect(0, 0, W, H); noise(x, 0, 0, W, H, 0.035, 3);
  },
  /** a small lit room: wall with wainscot, floorboards, a warm light pool */
  room(x, W, H, o = {}) {
    const wall = o.wall || '#3a2a3a', floor = o.floor || '#4a3222', fy = Math.round(H * (o.horizon ?? 0.62));
    let g = x.createLinearGradient(0, 0, 0, fy); g.addColorStop(0, shade(wall, -0.35)); g.addColorStop(1, wall); x.fillStyle = g; x.fillRect(0, 0, W, fy);
    for (let i = 0; i < W; i += 24) { x.fillStyle = 'rgba(0,0,0,0.12)'; x.fillRect(i, 0, 1, fy); }                          // wallpaper stripes
    x.fillStyle = shade(wall, -0.25); x.fillRect(0, fy - 22, W, 22); x.fillStyle = shade(wall, 0.12); x.fillRect(0, fy - 23, W, 1); // wainscot
    x.fillStyle = PAL.woodLo; x.fillRect(0, fy - 3, W, 3);
    g = x.createLinearGradient(0, fy, 0, H); g.addColorStop(0, shade(floor, 0.1)); g.addColorStop(1, shade(floor, -0.45)); x.fillStyle = g; x.fillRect(0, fy, W, H - fy);
    for (let yy = fy + 6, k = 0; yy < H; yy += 7 + k, k++) { x.fillStyle = 'rgba(0,0,0,0.18)'; x.fillRect(0, yy, W, 1); }   // boards (perspective)
    glow(x, o.lightX ?? W / 2, o.lightY ?? fy - 10, o.lightR ?? W * 0.45, o.light || '#ffcf8a', 0.22);
    noise(x, 0, 0, W, H, 0.03, 11);
    // vignette
    const v = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.55)'); x.fillStyle = v; x.fillRect(0, 0, W, H);
  },
};

const STYLES = {
  wood: { fill: ['#7a5034', '#5a3a26'], edge: '#2a1810', hi: '#a8744c', inner: '#3a2418', text: PAL.cream },
  metal: { fill: ['#4a525e', '#2e343e'], edge: '#12161c', hi: '#8a94a4', inner: '#20252c', text: PAL.cream },
  paper: { fill: ['#f3e6c8', '#e2cfa4'], edge: '#5a3a22', hi: '#fff6e0', inner: '#d8c296', text: PAL.paperInk },
  neon: { fill: ['#1c1230', '#120a20'], edge: '#ff7ab8', hi: '#ffd0ec', inner: '#0c0716', text: PAL.cream, neon: true },
  glass: { fill: ['rgba(30,26,44,0.82)', 'rgba(18,14,28,0.88)'], edge: 'rgba(255,255,255,0.18)', hi: 'rgba(255,255,255,0.22)', inner: 'rgba(0,0,0,0.3)', text: PAL.cream },
  felt: { fill: ['#2a7a56', '#1a5a3e'], edge: '#3e2618', hi: '#4ea07a', inner: '#164a34', text: PAL.cream },
  crt: { fill: ['#0e1a14', '#08100c'], edge: '#3a4a40', hi: '#5aff9a', inner: '#050a07', text: '#6eff9e', crt: true },
};
/** framed panel with bevel, inner shadow and texture */
export function panel(x, X, Y, W, H, o = {}) {
  const S = STYLES[o.style || 'glass']; X = Math.round(X); Y = Math.round(Y); W = Math.round(W); H = Math.round(H); const r = o.r ?? 4;
  x.save();
  // drop shadow
  x.fillStyle = 'rgba(0,0,0,0.4)'; rr(x, X + 2, Y + 4, W, H, r); x.fill();
  // body
  const g = x.createLinearGradient(0, Y, 0, Y + H); g.addColorStop(0, S.fill[0]); g.addColorStop(1, S.fill[1]); x.fillStyle = g; rr(x, X, Y, W, H, r); x.fill();
  if (S.neon) { x.shadowColor = S.edge; x.shadowBlur = 10; }
  x.strokeStyle = S.edge; x.lineWidth = 2; rr(x, X + 1, Y + 1, W - 2, H - 2, r); x.stroke(); x.shadowBlur = 0;
  // bevel: lit top / left, dark bottom
  x.fillStyle = S.hi; x.globalAlpha = 0.5; x.fillRect(X + 3, Y + 2, W - 6, 1); x.globalAlpha = 1;
  x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillRect(X + 3, Y + H - 3, W - 6, 1);
  if (o.style === 'wood' || o.style === 'paper') noise(x, X + 2, Y + 2, W - 4, H - 4, 0.05, X * 7 + Y);
  if (o.style === 'wood') for (let yy = Y + 6; yy < Y + H - 4; yy += 9) { x.fillStyle = 'rgba(0,0,0,0.12)'; x.fillRect(X + 3, yy, W - 6, 1); }
  if (S.crt) { for (let yy = Y + 3; yy < Y + H - 3; yy += 2) { x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(X + 2, yy, W - 4, 1); } glow(x, X + W / 2, Y + H / 2, Math.max(W, H) * 0.6, '#3aff8a', 0.08); }
  x.restore();
  return { x: X, y: Y, w: W, h: H, text: S.text };
}
function rr(x, X, Y, W, H, r) { x.beginPath(); x.moveTo(X + r, Y); x.lineTo(X + W - r, Y); x.quadraticCurveTo(X + W, Y, X + W, Y + r); x.lineTo(X + W, Y + H - r); x.quadraticCurveTo(X + W, Y + H, X + W - r, Y + H); x.lineTo(X + r, Y + H); x.quadraticCurveTo(X, Y + H, X, Y + H - r); x.lineTo(X, Y + r); x.quadraticCurveTo(X, Y, X + r, Y); x.closePath(); }
export { rr };

/** stat chip: small label over a big value */
export function badge(x, X, Y, label, value, o = {}) {
  const w = o.w || 74, h = o.h || 34; panel(x, X, Y, w, h, { style: o.style || 'glass', r: 3 });
  x.save(); x.font = CFONT.body(16); x.textAlign = 'left'; x.fillStyle = o.labelColor || PAL.dim; x.fillText(String(label).toUpperCase(), Math.round(X + 7), Math.round(Y + 13)); x.restore();
  title(x, String(value), X + 7, Y + 29, { align: 'left', color: o.color || PAL.gold, size: 16 });
}

/** bevelled pixel button; returns its box (use with util.js mouse().add) */
export function button(x, X, Y, W, H, label, o = {}) {
  const base = o.disabled ? '#3a3644' : o.primary ? PAL.gold : '#4a3e5e', press = o.down ? 2 : 0;
  x.save(); X = Math.round(X); Y = Math.round(Y);
  x.fillStyle = 'rgba(0,0,0,0.45)'; rr(x, X, Y + 3, W, H, 3); x.fill();
  const g = x.createLinearGradient(0, Y + press, 0, Y + H + press); g.addColorStop(0, shade(base, o.hot ? 0.28 : 0.12)); g.addColorStop(1, shade(base, -0.2));
  x.fillStyle = g; rr(x, X, Y + press, W, H, 3); x.fill(); x.strokeStyle = PAL.ink; x.lineWidth = 1.5; rr(x, X + 0.5, Y + press + 0.5, W - 1, H - 1, 3); x.stroke();
  x.fillStyle = 'rgba(255,255,255,0.35)'; x.fillRect(X + 3, Y + press + 2, W - 6, 1);
  if (o.hot && !o.disabled) glow(x, X + W / 2, Y + H / 2, W * 0.7, o.primary ? '#ffd890' : '#b8a8ff', 0.25);
  x.restore();
  title(x, label, X + W / 2, Y + press + H / 2 + 5, { size: 16, body: true, color: o.disabled ? '#7a7488' : o.primary ? PAL.ink : PAL.cream, ink: o.primary ? 'rgba(255,240,200,0.5)' : PAL.ink });
  return { x: X, y: Y, w: W, h: H };
}

/** animated result / title card. t = seconds since shown. */
export function banner(x, W, H, s, sub, t, o = {}) {
  const k = clamp(t / 0.45, 0, 1), sc = ease.outBack(k), a = clamp(t / 0.2, 0, 1);
  const bw = Math.min(W - 40, 300), bh = sub ? 74 : 54, cy = H / 2;
  // soft shadow behind the banner only (no dimmed rectangle: its edges show over the game / the world behind)
  x.save(); x.globalAlpha = a * 0.6; x.translate(W / 2, cy); x.scale(1, (bh + 70) / (bw + 70)); const sh = x.createRadialGradient(0, 0, 0, 0, 0, (bw + 70) / 2);
  sh.addColorStop(0, 'rgba(0,0,0,0.85)'); sh.addColorStop(0.6, 'rgba(0,0,0,0.5)'); sh.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = sh; x.beginPath(); x.arc(0, 0, (bw + 70) / 2, 0, 7); x.fill(); x.restore();
  x.save(); x.globalAlpha = a;
  x.translate(W / 2, cy); x.scale(sc, sc); x.translate(-W / 2, -cy);
  panel(x, W / 2 - bw / 2, cy - bh / 2, bw, bh, { style: o.style || 'neon' });
  glow(x, W / 2, cy, bw * 0.6, o.color || PAL.gold, 0.25);
  title(x, s, W / 2, cy + (sub ? -4 : 8), { size: 32, color: o.color || PAL.gold, glow: o.color || PAL.gold, glowR: 12 });
  if (sub) title(x, sub, W / 2, cy + 24, { size: 16, body: true, color: PAL.cream });
  x.restore();
}

/** moving highlight sweep */
export function shine(x, X, Y, W, H, t) {
  const p = ((t * 0.6) % 2) - 0.5; if (p < 0 || p > 1) return; const sx = X + p * (W + 40) - 20;
  x.save(); x.beginPath(); x.rect(X, Y, W, H); x.clip(); const g = x.createLinearGradient(sx - 20, 0, sx + 20, 0); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.18)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(sx - 20, Y, 40, H); x.restore();
}

/** spinning coin */
export function coin(x, X, Y, r, t) {
  const w = Math.abs(Math.cos(t * 4)) * r + 1; x.save(); x.fillStyle = PAL.goldD; x.beginPath(); x.ellipse(X, Y + 1, w, r, 0, 0, Math.PI * 2); x.fill();
  x.fillStyle = PAL.gold; x.beginPath(); x.ellipse(X, Y, w, r, 0, 0, Math.PI * 2); x.fill(); x.fillStyle = PAL.goldHi; x.fillRect(Math.round(X - w * 0.4), Math.round(Y - r * 0.5), Math.max(1, Math.round(w * 0.3)), Math.round(r * 0.6)); x.restore();
}

/** particles: bursts, sparkles, confetti */
export function particles() {
  /** @type {{x:number,y:number,vx:number,vy:number,g:number,life:number,max:number,c:string,s:number,spin?:number}[]} */
  const P = [];
  return {
    burst(X, Y, o = {}) { const n = o.n ?? 18, cs = o.colors || [PAL.gold, PAL.goldHi, PAL.cream]; for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, v = (o.speed ?? 70) * (0.4 + Math.random() * 0.8);
      P.push({ x: X, y: Y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (o.up ?? 30), g: o.gravity ?? 140, life: 0, max: 0.6 + Math.random() * 0.6, c: cs[i % cs.length], s: o.size ?? 2 }); } },
    sparkle(X, Y, c = PAL.goldHi) { for (let i = 0; i < 6; i++) P.push({ x: X + (Math.random() - 0.5) * 10, y: Y + (Math.random() - 0.5) * 10, vx: 0, vy: -10, g: 0, life: 0, max: 0.5 + Math.random() * 0.4, c, s: 1 }); },
    confetti(W) { const cs = [PAL.pink, PAL.gold, PAL.cyan, PAL.green, PAL.purple]; for (let i = 0; i < 60; i++) P.push({ x: Math.random() * W, y: -10 - Math.random() * 60, vx: (Math.random() - 0.5) * 30, vy: 30 + Math.random() * 40, g: 30, life: 0, max: 2.5, c: cs[i % cs.length], s: 2, spin: Math.random() * 6 }); },
    draw(x, dt) { for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; p.life += dt; if (p.life > p.max) { P.splice(i, 1); continue; } p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      const a = 1 - p.life / p.max; x.globalAlpha = a; x.fillStyle = p.c; const w = p.spin ? Math.max(1, Math.abs(Math.cos(p.life * p.spin)) * p.s * 2) : p.s; x.fillRect(Math.round(p.x), Math.round(p.y), w, p.s); } x.globalAlpha = 1; },
    get count() { return P.length; },
  };
}
/** screen shake that settles */
export function shaker() { let m = 0, t = 0; return { kick(n = 5) { m = Math.max(m, n); }, apply(x, dt) { t += dt; m = Math.max(0, m - dt * 30); if (m > 0) x.translate(Math.round(Math.sin(t * 70) * m), Math.round(Math.cos(t * 53) * m * 0.6)); } }; }

/** a keyboard key chip (metal keycap with a label); returns its width. Use for how-to-play lines. */
export function keyChip(x, s, X, Y) { const w = Math.max(18, s.length * 6 + 10); panel(x, X, Y - 12, w, 16, { style: 'metal', r: 2 }); title(x, s, X + w / 2, Y, { size: 16, body: true }); return w; }
