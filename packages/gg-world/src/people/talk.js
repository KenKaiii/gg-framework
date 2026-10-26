// @ts-check
// Line picking without the "same nonsense": every pool remembers what was said recently (per pool and globally), picks
// with real randomness, never repeats a line until most of the pool has been used, and fills {slots}.
const recentAll = []; const RECENT_MAX = 60; // the last 60 lines anyone said: never again soon, anywhere
const bags = new WeakMap(); // pool -> shuffled queue

export const rand = (a, b) => a + Math.random() * (b - a);
export const chance = p => Math.random() < p;
export const pickOne = arr => arr[Math.floor(Math.random() * arr.length)];

/** next line from a pool (shuffle-bag: everything once before repeats, plus a global recent-lines filter) */
export function draw(pool) {
  if (!pool || !pool.length) return null;
  let bag = bags.get(pool);
  for (let tries = 0; tries < 3; tries++) {
    if (!bag || !bag.length) { bag = pool.slice(); for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; } bags.set(pool, bag); }
    const line = bag.pop(); if (!recentAll.includes(line) || pool.length < 4) { recentAll.push(line); if (recentAll.length > RECENT_MAX) recentAll.shift(); return line; }
  }
  return bag.pop() || pool[0];
}

/** fill {slots}. ctx: { me, other, player, room, ver, hour, weather, A, B } */
export function fill(line, ctx) {
  return String(line).replace(/\{(\w+)\}/g, (m, k) => (ctx[k] != null && ctx[k] !== '' ? String(ctx[k]) : k === 'other' || k === 'A' || k === 'B' ? 'someone' : ''))
    .replace(/\s{2,}/g, ' ').trim();
}
/** apply a persona's writing style */
export function styled(line, style = {}) {
  let s = line; if (style.lower) s = s.toLowerCase().replace(/\bi\b/g, 'i');
  if (style.dots && chance(0.18) && !/[.?!]$/.test(s)) s += '...';
  return s;
}
/** "2am", "11pm" from an hour 0..24 */
export const hourText = h => { const k = Math.floor(h) % 24; return k === 0 ? 'midnight' : k === 12 ? 'noon' : k < 12 ? `${k}am` : `${k - 12}pm`; };
export const weatherText = w => ({ rain: 'rain', cloudy: 'clouds', clear: 'clear skies' })[w] || w || 'weather';
