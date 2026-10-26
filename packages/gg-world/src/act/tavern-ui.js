// @ts-check
// Tavern activity helpers: parchment panels, rarity colours, date seed, safe localStorage, click hit-testing.
import { text, rng } from './util.js';

export const RARITY = [['Poor', '#9d9d9d'], ['Common', '#ffffff'], ['Uncommon', '#1eff00'], ['Rare', '#0070dd'], ['Epic', '#a335ee'], ['Legendary', '#ff8000']];
export const INK = '#3a2412', GOLDC = '#ffd23a';

/** @param {string} k @param {any} def */
export function load(k, def) { try { const v = JSON.parse(localStorage.getItem('tavern-' + k) || 'null'); return v ?? def; } catch { return def; } }
/** @param {string} k @param {any} v */
export function save(k, v) { try { localStorage.setItem('tavern-' + k, JSON.stringify(v)); } catch { /* ignore */ } }
/** YYYY-MM-DD for today + seeded rng for it. @param {Date} [d] */
export function today(d = new Date()) { const key = d.toISOString().slice(0, 10); return { key, r: rng(+key.replace(/-/g, '')) }; }

/** Wooden frame + parchment panel. @param {CanvasRenderingContext2D} x */
export function panel(x, px, py, w, h, o = {}) {
  x.fillStyle = '#2a1a10'; x.fillRect(px - 4, py - 4, w + 8, h + 8);
  x.fillStyle = o.wood || '#6a4220'; x.fillRect(px - 2, py - 2, w + 4, h + 4);
  x.fillStyle = o.bg || '#e8d6a8'; x.fillRect(px, py, w, h);
  x.fillStyle = 'rgba(120,80,30,0.12)'; for (let i = 0; i < 40; i++) x.fillRect(px + ((i * 37) % w), py + ((i * 53) % h), 3, 1);
  for (const [cx, cy] of [[px - 3, py - 3], [px + w - 1, py - 3], [px - 3, py + h - 1], [px + w - 1, py + h - 1]]) { x.fillStyle = GOLDC; x.fillRect(cx, cy, 4, 4); }
}
/** Warm tavern backdrop. @param {CanvasRenderingContext2D} x */
export function backdrop(x, W, H, t = 0) {
  const g = x.createRadialGradient(W / 2, H * 0.6, 10, W / 2, H * 0.6, W * 0.7); g.addColorStop(0, '#5a3418'); g.addColorStop(1, '#1e1008');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  for (let i = 0; i < 14; i++) { const k = (t * 0.2 + i * 0.37) % 1; x.fillStyle = `rgba(255,170,80,${0.5 * (1 - k)})`; x.fillRect((i * 71) % W, H - k * H, 1, 1); }
}
/** Button: draws and returns a hit box. @param {CanvasRenderingContext2D} x */
export function button(x, label, bx, by, w, h, o = {}) {
  x.fillStyle = o.on ? '#a8302a' : '#5a1e18'; x.fillRect(bx, by, w, h); x.fillStyle = 'rgba(255,220,150,0.25)'; x.fillRect(bx, by, w, 2);
  text(x, label, bx + w / 2, by + h / 2 + 5, { color: o.dim ? '#8a6a5a' : '#ffe8b0', align: 'center' });
  return { x: bx, y: by, w, h };
}
/** Click -> canvas px. @param {HTMLCanvasElement} c */
export function onClick(ov, c, W, H, f) { const h = e => { const r = c.getBoundingClientRect(); f((e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height); }; c.addEventListener('click', h); c.style.cursor = 'pointer'; ov.onClose(() => c.removeEventListener('click', h)); }
export const hit = (b, px, py) => b && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
/** keydown listener auto-removed. */
export function onKey(ov, f) { const h = e => f(e.code, e); addEventListener('keydown', h); ov.onClose(() => removeEventListener('keydown', h)); }

/** Floating pop numbers / text. */
export function pops() {
  const list = [];
  return { add(s, px, py, color = GOLDC) { const n = list.filter(q => Math.abs(q.px - px) < 40 && Math.abs(q.py - py) < 30 && q.t < 0.8).length; list.push({ s, px, py: py - n * 16, color, t: 0 }); },
    draw(x, dt) { for (let i = list.length - 1; i >= 0; i--) { const p = list[i]; p.t += dt; if (p.t > 1.2) { list.splice(i, 1); continue; } if (p.t < 0) continue; text(x, p.s, p.px, p.py - p.t * 24, { color: p.color, align: 'center', shadow: '#000' }); } } };
}
/** Loot pop-up card (item + rarity). @param {CanvasRenderingContext2D} x */
export function lootCard(x, W, H, item, rar, k = 1) {
  const w = 220, h = 70, px = (W - w) / 2, py = H / 2 - h / 2 - (1 - k) * 20;
  x.globalAlpha = Math.min(1, k * 2);
  x.fillStyle = 'rgba(10,8,14,0.92)'; x.fillRect(px, py, w, h); x.strokeStyle = RARITY[rar][1]; x.lineWidth = 2; x.strokeRect(px + 1, py + 1, w - 2, h - 2);
  x.fillStyle = RARITY[rar][1]; x.fillRect(px + 10, py + 12, 40, 40); x.fillStyle = 'rgba(0,0,0,0.4)'; x.fillRect(px + 14, py + 16, 32, 32);
  text(x, item, px + 60, py + 28, { color: RARITY[rar][1] }); text(x, RARITY[rar][0], px + 60, py + 48, { color: '#b8a888' });
  x.globalAlpha = 1;
}
