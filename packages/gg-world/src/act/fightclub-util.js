// @ts-check
// Shared helpers for the Paper Street activities: saved state, day seed, juice (popups, shake).
import { text } from './util.js';

/** @param {string} k @param {any} def */
export function load(k, def) { try { const v = JSON.parse(localStorage.getItem('fc-' + k) || 'null'); return v && typeof v === 'object' ? { ...def, ...v } : { ...def }; } catch { return { ...def }; } }
/** @param {string} k @param {any} v */
export function save(k, v) { try { localStorage.setItem('fc-' + k, JSON.stringify(v)); } catch { /* ignore */ } }
/** Today as yyyymmdd number (local date). */
export function today(d = new Date()) { return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
/** Floating text pops. */
export function pops() {
  /** @type {{s:string,x:number,y:number,t:number,c:string}[]} */ const L = [];
  return {
    add(s, x, y, c = '#ffe14a') { L.push({ s, x, y, t: 0, c }); },
    draw(x, dt) { for (let i = L.length - 1; i >= 0; i--) { const p = L[i]; p.t += dt; if (p.t > 1) { L.splice(i, 1); continue; } text(x, p.s, p.x, p.y - p.t * 30, { size: 16, color: p.c, align: 'center', shadow: '#000' }); } },
  };
}
export const BG = '#2a2228', INK = '#e8e0cc', PINK = '#f2a6c0', AMBER = '#ffb36b', GREEN = '#6ee7a0', RED = '#ff6b6b';
