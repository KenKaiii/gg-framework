// @ts-check
// Computer Lab activity helpers: best-score storage, sit-if-seat, beige retro window chrome, date seed, word wrap.
import { text } from './util.js';
import { sitPlayer } from './sit.js';
import { CFONT } from '../fonts.js';
import { setView, clearView, worldOf } from './view.js';

const KEY = 'night-rooms-computer';
/** @param {string} k @returns {number} */
export function best(k) { try { return Number(JSON.parse(localStorage.getItem(KEY) || '{}')[k]) || 0; } catch { return 0; } }
/** Save v if better (higher, or lower when low=true). @returns {boolean} new record */
export function saveBest(k, v, low = false) {
  try { const o = JSON.parse(localStorage.getItem(KEY) || '{}'); const old = Number(o[k]) || 0; if (old && (low ? v >= old : v <= old)) return false; o[k] = v; localStorage.setItem(KEY, JSON.stringify(o)); return true; } catch { return false; }
}
/** Store any small value. */
export function store(k, v) { try { const o = JSON.parse(localStorage.getItem(KEY) || '{}'); if (v === undefined) return o[k]; o[k] = v; localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* ignore */ } return v; }
/** Sit the player when started from a seat; returns cleanup. @param {any} ctx */
export function seat(ctx) { if (ctx.it?.kind === 'seat' && ctx.it.slot) { const up = sitPlayer(ctx.S, ctx.R, ctx.it.slot); return () => up(); } return () => {}; }
/** Today as yyyy-mm-dd + numeric seed. @param {Date} [d] */
export function today(d = new Date()) { const s = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return { s, seed: h }; }
/** Retro window: grey frame + blue title bar. @param {CanvasRenderingContext2D} x */
export function win(x, X, Y, W, H, title) {
  x.fillStyle = 'rgba(0,0,0,0.45)'; x.fillRect(X + 3, Y + 4, W, H);                                          // drop shadow
  const g0 = x.createLinearGradient(0, Y, 0, Y + H); g0.addColorStop(0, '#d6d6d0'); g0.addColorStop(1, '#b0b0aa'); x.fillStyle = g0; x.fillRect(X, Y, W, H);
  x.fillStyle = '#ffffff'; x.fillRect(X, Y, W, 1); x.fillRect(X, Y, 1, H); x.fillStyle = '#e8e8e2'; x.fillRect(X + 1, Y + 1, W - 2, 1); x.fillRect(X + 1, Y + 1, 1, H - 2);
  x.fillStyle = '#202020'; x.fillRect(X, Y + H - 1, W, 1); x.fillRect(X + W - 1, Y, 1, H); x.fillStyle = '#808080'; x.fillRect(X + 1, Y + H - 2, W - 2, 1); x.fillRect(X + W - 2, Y + 1, 1, H - 2);
  const g = x.createLinearGradient(X + 3, 0, X + W - 3, 0); g.addColorStop(0, '#0a1a7a'); g.addColorStop(1, '#3a7ad8'); x.fillStyle = g; x.fillRect(X + 3, Y + 3, W - 6, 15);
  x.fillStyle = 'rgba(255,255,255,0.25)'; x.fillRect(X + 3, Y + 3, W - 6, 1);
  x.fillStyle = '#ffcf4a'; x.fillRect(X + 6, Y + 6, 9, 9); x.fillStyle = '#1a2a8a'; x.fillRect(X + 8, Y + 8, 5, 5);           // app icon
  text(x, title, X + 19, Y + 15, { color: '#ffffff', shadow: '#000a3a' });
  const bx = X + W - 17, by = Y + 5; x.fillStyle = '#d6d6d0'; x.fillRect(bx, by, 12, 11); x.fillStyle = '#fff'; x.fillRect(bx, by, 12, 1); x.fillRect(bx, by, 1, 11); x.fillStyle = '#404040'; x.fillRect(bx, by + 10, 12, 1); x.fillRect(bx + 11, by, 1, 11);
  x.fillStyle = '#000'; for (let i = 0; i < 6; i++) { x.fillRect(bx + 3 + i, by + 2 + i, 1, 1); x.fillRect(bx + 8 - i, by + 2 + i, 1, 1); }
}
/** Word-wrap to maxW px (m5x7 16). @param {CanvasRenderingContext2D} x */
export function wrap(x, s, maxW) {
  x.save(); x.font = CFONT.body(16); const out = []; let line = '';
  for (const w of s.split(' ')) { const t = line ? line + ' ' + w : w; if (x.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }
  out.push(line); x.restore(); return out;
}
/** Canvas pixel coords of a mouse event. @param {HTMLCanvasElement} c @param {MouseEvent} e */
export function pos(c, e) { const r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) * c.width / r.width, y: (e.clientY - r.top) * c.height / r.height }; }
/** Camera close-up on a room-local point, seen from the front-right and a little above; restored on close.
 * @param {any} ctx @param {any} ov @param {number} x @param {number} y @param {number} z @param {number} [zoom] */
export function closeUp(ctx, ov, x, y, z, zoom = 1.3) {
  setView(ctx.S, { target: worldOf(ctx.R, x, y, z), dir: { x: 0.45, y: 0.55, z: 1 }, zoom });
  ov.onClose(() => clearView(ctx.S));
}

// ---- a beige 90s monitor on a lit desk (cached), screen = kit CRT panel; draw content inside the returned rect ----
import { bg as aBg, panel as aPanel, glow as aGlow, rr as aRR } from './art.js';
/** @param {number} W @param {number} H @param {string} label */
export function monitor(W, H, label) {
  const c = document.createElement('canvas'); c.width = W; c.height = H; const m = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  aBg.room(m, W, H, { wall: '#2a3048', floor: '#4a3a2a', horizon: 0.86, light: '#cfe0ff', lightY: H * 0.4 });
  const X = 34, Y = 6, w = W - 68, h = H - 22;
  m.fillStyle = 'rgba(0,0,0,0.45)'; aRR(m, X + 4, Y + 6, w, h, 10); m.fill();
  let g = m.createLinearGradient(0, Y, 0, Y + h); g.addColorStop(0, '#e8e0cc'); g.addColorStop(1, '#b8ae96'); m.fillStyle = g; aRR(m, X, Y, w, h, 10); m.fill();
  m.strokeStyle = '#5a5240'; m.lineWidth = 2; aRR(m, X + 1, Y + 1, w - 2, h - 2, 10); m.stroke(); m.fillStyle = 'rgba(255,255,255,0.6)'; m.fillRect(X + 10, Y + 3, w - 20, 1);
  g = m.createLinearGradient(0, Y + 8, 0, Y + h - 22); g.addColorStop(0, '#8a826e'); g.addColorStop(1, '#d8d0bc'); m.fillStyle = g; aRR(m, X + 8, Y + 8, w - 16, h - 32, 8); m.fill();
  m.fillStyle = '#5a5240'; m.font = '16px m5x7'; m.textAlign = 'left'; m.fillText(label, X + 14, Y + h - 9);
  for (let i = 0; i < 6; i++) { m.fillStyle = 'rgba(0,0,0,0.25)'; m.fillRect(X + w - 90 + i * 6, Y + h - 16, 3, 8); }
  m.fillStyle = '#3a3428'; aRR(m, X + w - 30, Y + h - 17, 14, 9, 2); m.fill();
  const scr = { x: X + 14, y: Y + 14, w: w - 28, h: h - 44 };
  return { scr, /** @param {CanvasRenderingContext2D} x @param {number} t */ draw(x, t) {
    x.drawImage(c, 0, 0); aPanel(x, scr.x, scr.y, scr.w, scr.h, { style: 'crt', r: 6 });
    x.fillStyle = (t % 3) < 2.4 ? '#6eff7a' : '#2a6a3a'; x.fillRect(X + w - 26, Y + h - 14, 6, 3); aGlow(x, X + w - 23, Y + h - 13, 8, '#6eff7a', 0.5); } };
}
