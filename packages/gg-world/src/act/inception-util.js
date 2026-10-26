// @ts-check
// Limbo activity helpers: see-through overlay (world visible behind), localStorage best values, date seed, popups.
import { text } from './util.js';

/** Make an overlay see-through so the 3D close-up shows behind its HUD canvas. @param {any} ov @param {HTMLCanvasElement} c @param {number} alpha */
export function seeThrough(ov, c, alpha = 0.1) {
  ov.el.style.background = `rgba(6,6,10,${alpha})`; c.style.boxShadow = 'none'; c.style.background = 'transparent';
}
/** @param {string} k @param {number} def */
export function loadNum(k, def = 0) { try { const v = Number(localStorage.getItem('limbo-' + k)); return Number.isFinite(v) && localStorage.getItem('limbo-' + k) !== null ? v : def; } catch { return def; } }
/** @param {string} k @param {number} v */
export function saveNum(k, v) { try { localStorage.setItem('limbo-' + k, String(v)); } catch { /* private mode */ } }
/** Today's seed (YYYYMMDD) and key. */
export function today() { const d = new Date(); const k = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); return { seed: k, key: String(k) }; }
/** Floating score popups. */
export function pops() {
  /** @type {{s:string,x:number,y:number,t:number,c:string}[]} */ const list = [];
  return {
    add: (s, x, y, c = '#ffd98a') => list.push({ s, x, y, t: 0, c }),
    /** @param {CanvasRenderingContext2D} x @param {number} dt */
    draw(x, dt) { for (let i = list.length - 1; i >= 0; i--) { const p = list[i]; p.t += dt; if (p.t > 1.2) { list.splice(i, 1); continue; }
      x.globalAlpha = Math.min(1, (1.2 - p.t) * 2); text(x, p.s, p.x, p.y - p.t * 24, { size: 16, color: p.c, align: 'center', shadow: '#000' }); x.globalAlpha = 1; } },
  };
}
/** Dark rounded HUD panel. @param {CanvasRenderingContext2D} x */
export function panel(x, X, Y, w, h, a = 0.78) { x.fillStyle = `rgba(14,14,24,${a})`; x.beginPath(); x.roundRect(X, Y, w, h, 6); x.fill(); x.strokeStyle = 'rgba(200,180,140,0.5)'; x.lineWidth = 1; x.stroke(); }
/** Test hook for tools/review-inception.mjs: window.__limbo.{totem,maze,under} (state getters; null when closed). @param {object} o */
export function hook(o) { const g = /** @type {any} */ (globalThis); g.__limbo = Object.assign(g.__limbo || {}, o); }
