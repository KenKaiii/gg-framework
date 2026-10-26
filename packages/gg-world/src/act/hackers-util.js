// @ts-check
import { glow as aGlow, noise as aNoise, rr as aRR, title as aTitle, button as aButton, PAL as aPAL } from './art.js';
import { CFONT } from '../fonts.js';
// Club Cyberdelia activity helpers: safe localStorage, the player's hacker handle, today's seed, neon backdrop.
export const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? d; } catch { return d; } };
export const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off */ } };
/** @param {any} S */
export const handle = S => load('cyb-handle', null) || (S?.player?.name ? String(S.player.name).toUpperCase().slice(0, 12) : 'ANON');
export const today = () => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
/** Dark grid backdrop with scanlines. @param {CanvasRenderingContext2D} x */
export function backdrop(x, W, H, t = 0, tint = '#3ff0ff') {
  x.fillStyle = '#0b0a16'; x.fillRect(0, 0, W, H);
  x.strokeStyle = tint; x.globalAlpha = 0.12; x.beginPath();
  for (let i = 0; i <= W; i += 16) { x.moveTo(i + 0.5, 0); x.lineTo(i + 0.5, H); }
  for (let j = (t * 8) % 16; j <= H; j += 16) { x.moveTo(0, j + 0.5); x.lineTo(W, j + 0.5); }
  x.stroke(); x.globalAlpha = 1;
}
export function scan(x, W, H) { x.fillStyle = 'rgba(0,0,0,0.22)'; for (let y = 0; y < H; y += 2) x.fillRect(0, y, W, 1); }

// ---- Cyberdelia art (built on art.js): cached synthwave backdrop, key chips, a hover-aware button set ----

/** Synthwave backdrop: static sky / sun / skyline / vignette cached offscreen; only the floor grid animates. */
export function neonBg(W, H, tint = '#ff4fd8', horizon = 0.55) {
  const hy = Math.round(H * horizon), mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return [c, /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'))]; };
  const [sky, s] = mk(); let g = s.createLinearGradient(0, 0, 0, hy); g.addColorStop(0, '#07061a'); g.addColorStop(0.7, '#2a0f44'); g.addColorStop(1, '#5a1a62'); s.fillStyle = g; s.fillRect(0, 0, W, hy);
  let r = 9; const rnd = () => (r = (r * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < W / 6; i++) { s.fillStyle = `rgba(255,255,255,${0.2 + rnd() * 0.5})`; s.fillRect(Math.floor(rnd() * W), Math.floor(rnd() * hy * 0.7), 1, 1); }
  // banded sun
  const sr = Math.round(H * 0.2); g = s.createLinearGradient(0, hy - sr, 0, hy); g.addColorStop(0, '#ffd56a'); g.addColorStop(1, tint); s.fillStyle = g; s.beginPath(); s.arc(W / 2, hy, sr, Math.PI, 0); s.fill();
  s.fillStyle = '#2a0f44'; for (let k = 0; k < 5; k++) s.fillRect(W / 2 - sr, hy - 3 - k * 5 - k * k * 0.4, sr * 2, 1 + k * 0.5);
  aGlow(s, W / 2, hy, sr * 2.2, tint, 0.35);
  // skyline with lit windows
  for (let bx = -4; bx < W; ) { const bw = 8 + Math.floor(rnd() * 14), bh = 6 + Math.floor(rnd() * hy * 0.35); s.fillStyle = '#0c0718'; s.fillRect(bx, hy - bh, bw, bh);
    for (let wy = hy - bh + 3; wy < hy - 2; wy += 4) for (let wx = bx + 2; wx < bx + bw - 2; wx += 3) if (rnd() < 0.25) { s.fillStyle = rnd() < 0.5 ? '#3ff0ff' : '#ffcf8a'; s.globalAlpha = 0.6; s.fillRect(wx, wy, 1, 1); s.globalAlpha = 1; }
    bx += bw + Math.floor(rnd() * 3); }
  g = s.createLinearGradient(0, hy, 0, H); g.addColorStop(0, '#1a0828'); g.addColorStop(1, '#050310'); s.fillStyle = g; s.fillRect(0, hy, W, H - hy);
  s.fillStyle = tint; s.fillRect(0, hy, W, 1); aGlow(s, W / 2, hy, W * 0.6, tint, 0.18); aNoise(s, 0, 0, W, H, 0.03, 5);
  const [vg, v] = mk(); g = v.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.72); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.6)'); v.fillStyle = g; v.fillRect(0, 0, W, H);
  return {
    /** @param {CanvasRenderingContext2D} x */ draw(x, t) {
      x.drawImage(sky, 0, 0); x.save(); x.strokeStyle = tint; x.lineWidth = 1; x.globalAlpha = 0.55; x.beginPath();
      for (let k = -12; k <= 12; k++) { x.moveTo(W / 2 + k * 6, hy); x.lineTo(W / 2 + k * W * 0.16, H); }
      for (let i = 0; i < 10; i++) { const p = ((i + (t * 0.8) % 1) / 10), yy = Math.round(hy + (H - hy) * p * p) + 0.5; x.moveTo(0, yy); x.lineTo(W, yy); }
      x.stroke(); x.restore(); x.drawImage(vg, 0, 0);
    },
  };
}
/** a keyboard key chip; returns its width */
export function keyChip(x, X, Y, label) {
  x.save(); x.font = CFONT.body(16); const w = Math.max(14, Math.round(x.measureText(label).width) + 8); X = Math.round(X); Y = Math.round(Y);
  x.fillStyle = 'rgba(0,0,0,0.5)'; aRR(x, X, Y + 2, w, 14, 2); x.fill(); x.fillStyle = '#d8d0e8'; aRR(x, X, Y, w, 13, 2); x.fill(); x.fillStyle = '#fff'; x.fillRect(X + 2, Y + 1, w - 4, 1);
  x.fillStyle = aPAL.ink; x.textAlign = 'left'; x.fillText(label, X + 4, Y + 11); x.restore(); return w;
}
/** a centred row of [key, what] hints */
export function howTo(x, W, Y, items, o = {}) {
  x.save(); x.font = CFONT.body(16); let tw = 0; const ws = items.map(([k, s]) => { const kw = Math.max(14, Math.round(x.measureText(k).width) + 8), sw = Math.round(x.measureText(s).width); tw += kw + 4 + sw + 10; return [kw, sw]; }); x.restore();
  let X = Math.round(W / 2 - (tw - 10) / 2);
  items.forEach(([k, s], i) => { keyChip(x, X, Y - 11, k); X += ws[i][0] + 4; if (o.dark) { x.save(); x.font = CFONT.body(16); x.textAlign = 'left'; x.fillStyle = o.dark; x.fillText(s, X, Y); x.restore(); } else aTitle(x, s, X, Y, { size: 16, body: true, align: 'left' }); X += ws[i][1] + 10; });
}
/** hover-aware buttons: register boxes with util mouse() each frame; hot = pointer over */
export function btns(c, W, H) {
  const p = { x: -1, y: -1 }; c.addEventListener('pointermove', e => { const r = c.getBoundingClientRect(); p.x = (e.clientX - r.left) / r.width * W; p.y = (e.clientY - r.top) / r.height * H; });
  c.addEventListener('pointerleave', () => { p.x = p.y = -1; });
  return { hot: (X, Y, w, h) => p.x >= X && p.x <= X + w && p.y >= Y && p.y <= Y + h, get x() { return p.x; }, get y() { return p.y; },
    /** draw a kit button with hover */ draw(x, X, Y, w, h, label, o = {}) { return aButton(x, X, Y, w, h, label, { ...o, hot: p.x >= X && p.x <= X + w && p.y >= Y && p.y <= Y + h }); } };
}
