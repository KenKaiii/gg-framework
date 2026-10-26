// @ts-check
// Tavern activity helpers: parchment panels, rarity colours, date seed, safe localStorage, click hit-testing.
import { text, rng } from './util.js';
import { PAL, bg, panel as artPanel, button as kitButton, title, glow, shine } from './art.js';
import { cached, parchment } from './fightclub-ui.js';

export const RARITY = [['Poor', '#9d9d9d'], ['Common', '#ffffff'], ['Uncommon', '#1eff00'], ['Rare', '#0070dd'], ['Epic', '#a335ee'], ['Legendary', '#ff8000']];
export const INK = '#3a2412', GOLDC = '#ffd23a';

/** @param {string} k @param {any} def */
export function load(k, def) { try { const v = JSON.parse(localStorage.getItem('tavern-' + k) || 'null'); return v ?? def; } catch { return def; } }
/** @param {string} k @param {any} v */
export function save(k, v) { try { localStorage.setItem('tavern-' + k, JSON.stringify(v)); } catch { /* ignore */ } }
/** YYYY-MM-DD for today + seeded rng for it. @param {Date} [d] */
export function today(d = new Date()) { const key = d.toISOString().slice(0, 10); return { key, r: rng(+key.replace(/-/g, '')) }; }

/** Wooden frame + parchment panel (art kit: wood frame, burnt-edge parchment, brass corner studs). @param {CanvasRenderingContext2D} x */
export function panel(x, px, py, w, h, o = {}) {
  artPanel(x, px - 5, py - 5, w + 10, h + 10, { style: 'wood', r: 3 }); parchment(x, px, py, w, h);
  for (const [cx, cy] of [[px - 3, py - 3], [px + w - 1, py - 3], [px - 3, py + h - 1], [px + w - 1, py + h - 1]]) { x.fillStyle = '#2a1808'; x.fillRect(cx - 1, cy - 1, 6, 6); x.fillStyle = PAL.gold; x.fillRect(cx, cy, 4, 4); x.fillStyle = PAL.goldHi; x.fillRect(cx, cy, 2, 1); }
}
/** Warm tavern backdrop: a cached lit room (timber wall, hearth glow) + drifting embers. @param {CanvasRenderingContext2D} x */
const BACK = new WeakMap();
export function backdrop(x, W, H, t = 0) {
  let b = BACK.get(x); if (!b) { b = cached(W, H, cx => { bg.room(cx, W, H, { wall: '#4a2c1a', floor: '#3a2414', light: '#ffb060', lightX: W * 0.5, lightY: H * 0.7, lightR: W * 0.6 });
    for (let k = 40; k < W; k += 120) { cx.fillStyle = '#1e1008'; cx.fillRect(k, 0, 10, H * 0.62); cx.fillStyle = '#5a3820'; cx.fillRect(k + 1, 0, 3, H * 0.62); } // timber posts
    cx.fillStyle = '#1e1008'; cx.fillRect(0, 10, W, 8); cx.fillStyle = '#5a3820'; cx.fillRect(0, 10, W, 2); }); BACK.set(x, b); }
  b(x, 0, 0); glow(x, W / 2, H * 0.85, W * 0.5, '#ff9a40', 0.12 + Math.sin(t * 1.3) * 0.03);
  for (let i = 0; i < 14; i++) { const k = (t * 0.2 + i * 0.37) % 1; x.fillStyle = `rgba(255,170,80,${0.6 * (1 - k)})`; x.fillRect((i * 71 + Math.sin(t + i) * 6) % W, H - k * H, 2, 2); }
}
/** Button: kit bevelled button (hover glow from the last pointer position); returns a hit box. @param {CanvasRenderingContext2D} x */
export function button(x, label, bx, by, w, h, o = {}) {
  const c = x.canvas, m = MP.get(c); const hot = !!m && m[0] >= bx && m[0] <= bx + w && m[1] >= by && m[1] <= by + h;
  if (!m && !MP.has(c)) { MP.set(c, null); c.addEventListener('pointermove', e => { const r = c.getBoundingClientRect(); MP.set(c, [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]); }); }
  return kitButton(x, bx, by, w, h, label, { primary: !!o.on && !o.dim, hot, disabled: !!o.dim });
}
/** @type {WeakMap<HTMLCanvasElement, number[]|null>} */ const MP = new WeakMap();
/** Click -> canvas px. @param {HTMLCanvasElement} c */
export function onClick(ov, c, W, H, f) { const h = e => { const r = c.getBoundingClientRect(); f((e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height); }; c.addEventListener('click', h); c.style.cursor = 'pointer'; ov.onClose(() => c.removeEventListener('click', h)); }
export const hit = (b, px, py) => b && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
/** keydown listener auto-removed. */
export function onKey(ov, f) { const h = e => f(e.code, e); addEventListener('keydown', h); ov.onClose(() => removeEventListener('keydown', h)); }

/** Floating pop numbers / text. */
export function pops() {
  const list = [];
  return { add(s, px, py, color = GOLDC) { const n = list.filter(q => Math.abs(q.px - px) < 40 && Math.abs(q.py - py) < 30 && q.t < 0.8).length; list.push({ s, px, py: py - n * 16, color, t: 0 }); },
    draw(x, dt) { for (let i = list.length - 1; i >= 0; i--) { const p = list[i]; p.t += dt; if (p.t > 1.2) { list.splice(i, 1); continue; } if (p.t < 0) continue; title(x, p.s, p.px, p.py - p.t * 24, { size: 16, body: true, color: p.color }); } } };
}
/** Loot pop-up card (item + rarity) on a kit panel with a rarity glow. @param {CanvasRenderingContext2D} x */
export function lootCard(x, W, H, item, rar, k = 1) {
  const w = 240, h = 74, px = (W - w) / 2, py = H / 2 - h / 2 - (1 - k) * 20, col = RARITY[rar][1];
  x.save(); x.globalAlpha = Math.min(1, k * 2); glow(x, W / 2, H / 2, 150, col, 0.3);
  artPanel(x, px, py, w, h, { style: 'glass' }); x.strokeStyle = col; x.lineWidth = 2; x.strokeRect(px + 2, py + 2, w - 4, h - 4);
  artPanel(x, px + 10, py + 14, 46, 46, { style: 'metal', r: 3 }); x.fillStyle = col; x.fillRect(px + 18, py + 22, 30, 30); x.fillStyle = 'rgba(255,255,255,0.35)'; x.fillRect(px + 18, py + 22, 30, 3); x.fillStyle = 'rgba(0,0,0,0.3)'; x.fillRect(px + 18, py + 46, 30, 6);
  title(x, item, px + 66, py + 34, { size: 16, body: true, align: 'left', color: col }); title(x, RARITY[rar][0], px + 66, py + 54, { size: 16, align: 'left', color: PAL.cream });
  shine(x, px, py, w, h, k * 2); x.restore();
}
