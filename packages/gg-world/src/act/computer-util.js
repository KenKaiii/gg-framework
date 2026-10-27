// @ts-check
// Computer Lab activity helpers: best-score storage, sit-if-seat, date seed, camera close-up.
import { sitPlayer } from './sit.js';
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
/** Camera close-up on a room-local point, seen from the front-right and a little above; restored on close.
 * @param {any} ctx @param {any} ov @param {number} x @param {number} y @param {number} z @param {number} [zoom] */
export function closeUp(ctx, ov, x, y, z, zoom = 1.3) {
  setView(ctx.S, { target: worldOf(ctx.R, x, y, z), dir: { x: 0.45, y: 0.55, z: 1 }, zoom });
  ov.onClose(() => clearView(ctx.S));
}
