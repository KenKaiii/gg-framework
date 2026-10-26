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
  x.fillStyle = '#c0c0c0'; x.fillRect(X, Y, W, H); x.fillStyle = '#ffffff'; x.fillRect(X, Y, W, 1); x.fillRect(X, Y, 1, H);
  x.fillStyle = '#404040'; x.fillRect(X, Y + H - 1, W, 1); x.fillRect(X + W - 1, Y, 1, H);
  x.fillStyle = '#1a2a8a'; x.fillRect(X + 3, Y + 3, W - 6, 14); text(x, title, X + 7, Y + 14, { color: '#ffffff' });
  x.fillStyle = '#c0c0c0'; x.fillRect(X + W - 17, Y + 5, 11, 10); text(x, 'x', X + W - 14, Y + 14, { color: '#000' });
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
