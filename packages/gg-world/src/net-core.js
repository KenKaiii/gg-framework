// @ts-check
// Multiplayer pure parts (no DOM / three): own-state rounding + diffing, validation of what the server sends,
// interpolation buffers and the block list. Tested by test/net-core.test.mjs. Contract: docs/MULTIPLAYER.md.

export const FLOORS = ['main', 'roof', 'basement'];
export const ANIMS = ['idle', 'walk', 'run', 'sit'];
export const EMOTES = ['wave', 'dance', 'kiss', 'sleep', 'worm'];
export const BLOCK_KEY = 'nr.blocked';
export const BLOCK_MAX = 200;
/** how far behind the newest state other players are drawn (ms) */
export const DELAY = 120;
const r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;
const str = (/** @type {unknown} */ v, /** @type {number} */ max) => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * Own state, rounded (2 decimals for x/z/face) and cut to the contract. @param {any} raw
 * @returns {{floor:string, room:string, x:number, z:number, face:number, anim:string, emote:string|null, tipsy:number, prop:string|null, coding:boolean}}
 */
export function packState(raw) {
  const face = Math.atan2(Math.sin(+raw.face || 0), Math.cos(+raw.face || 0));
  return {
    floor: FLOORS.includes(raw.floor) ? raw.floor : 'main', room: String(raw.room || 'bar').slice(0, 24),
    x: r2(Math.max(-80, Math.min(80, +raw.x || 0))), z: r2(Math.max(-80, Math.min(80, +raw.z || 0))), face: r2(face),
    anim: ANIMS.includes(raw.anim) ? raw.anim : 'idle', emote: EMOTES.includes(raw.emote) ? raw.emote : null,
    tipsy: Math.max(0, Math.min(5, Math.floor(+raw.tipsy || 0))), prop: str(raw.prop, 16) ? raw.prop : null, coding: !!raw.coding,
  };
}
/** @param {any} a @param {any} b */
export function sameState(a, b) {
  if (!a || !b) return false;
  for (const k in b) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * Throttle for own state: send when changed (at most every 100 ms) or every 5 s as a keepalive.
 * @returns {{ want(s: any, now: number): boolean, reset(): void }}
 */
export function makeSender(minGap = 100, keep = 5000) {
  let last = /** @type {any} */ (null), at = -1e9;
  return {
    want(s, now) { const changed = !sameState(last, s); if ((changed && now - at >= minGap) || now - at >= keep) { last = s; at = now; return true; } return false; },
    reset() { last = null; at = -1e9; },
  };
}

/** A server state: valid -> cleaned copy, garbage -> null. @param {any} s */
export function cleanState(s) {
  if (!s || typeof s !== 'object') return null;
  if (!FLOORS.includes(s.floor) || !str(s.room, 24) || !Number.isFinite(s.x) || !Number.isFinite(s.z)) return null;
  return {
    floor: s.floor, room: s.room, x: Math.max(-80, Math.min(80, s.x)), z: Math.max(-80, Math.min(80, s.z)), face: Number.isFinite(s.face) ? s.face : 0,
    anim: ANIMS.includes(s.anim) ? s.anim : 'idle', emote: EMOTES.includes(s.emote) ? s.emote : null,
    tipsy: Number.isInteger(s.tipsy) ? Math.max(0, Math.min(5, s.tipsy)) : 0, prop: str(s.prop, 16) ? s.prop : null, coding: s.coding === true,
  };
}
const HEX = /^#[0-9a-fA-F]{6}$/;
/** A look from the server: only known string fields (colours must be #rrggbb). @param {any} L */
export function cleanLook(L) {
  if (!L || typeof L !== 'object') return null; const out = /** @type {Record<string, any>} */ ({});
  for (const k of ['body', 'head', 'acc']) if (str(L[k], 24) && /^[a-z0-9_-]+$/i.test(L[k])) out[k] = L[k];
  for (const k of ['skin', 'hair', 'top', 'bottom', 'accColor']) if (typeof L[k] === 'string' && HEX.test(L[k])) out[k] = L[k];
  if (Array.isArray(L.silly)) out.silly = L.silly.filter((/** @type {unknown} */ x) => str(x, 24)).slice(0, 4);
  if (L.scale && typeof L.scale === 'object') { const c = (/** @type {unknown} */ v) => Math.max(0.6, Math.min(1.6, Number(v) || 1)); out.scale = { head: c(L.scale.head), width: c(L.scale.width), height: c(L.scale.height) }; }
  return out;
}
/** A player P = { id, name, level, look, s }. @param {any} p */
export function cleanPlayer(p) {
  if (!p || typeof p !== 'object' || !str(p.id, 64)) return null;
  const name = typeof p.name === 'string' ? p.name.replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 14) : '';
  return { id: p.id, name: name || 'Player', level: Number.isInteger(p.level) ? Math.max(1, Math.min(999, p.level)) : 1, look: cleanLook(p.look) || {}, s: cleanState(p.s), admin: p.admin === true };
}
/** Any server message -> cleaned message, or null to drop. @param {any} m */
export function cleanServer(m) {
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return null;
  const n = (/** @type {unknown} */ v) => Number.isInteger(v) && /** @type {number} */ (v) >= 0 ? /** @type {number} */ (v) : null;
  switch (m.t) {
    case 'welcome': { if (!str(m.you, 64) || !Array.isArray(m.players)) return null; const players = m.players.slice(0, 100).map(cleanPlayer).filter(Boolean);
      return { t: 'welcome', you: m.you, world: str(m.world, 24) ? m.world : '', players, count: n(m.count) ?? players.length + 1, admin: m.admin === true }; }
    case 'join': { const p = cleanPlayer(m.p); return p ? { t: 'join', p } : null; }
    case 'leave': return str(m.id, 64) ? { t: 'leave', id: m.id } : null;
    case 'states': { if (!Array.isArray(m.u)) return null; const u = [];
      for (const e of m.u.slice(0, 100)) { if (!Array.isArray(e) || !str(e[0], 64)) continue; const s = cleanState(e[1]); if (s) u.push([e[0], s]); } return { t: 'states', u }; }
    case 'look': { const L = cleanLook(m.look); return str(m.id, 64) && L ? { t: 'look', id: m.id, look: L } : null; }
    case 'chat': return str(m.id, 64) && typeof m.text === 'string' && m.text.trim() ? { t: 'chat', id: m.id, name: cleanPlayer({ id: 'x', name: m.name }).name, text: m.text.slice(0, 200) } : null;
    case 'muted': return Number.isFinite(m.until) ? { t: 'muted', until: m.until, by: m.by === 'admin' ? 'admin' : 'rules' } : null;
    case 'count': return n(m.n) != null ? { t: 'count', n: m.n } : null;
    case 'error': return { t: 'error', msg: String(m.msg || '').slice(0, 200) };
    case 'pong': return { t: 'pong' };
    default: return null;
  }
}

/** Interpolation buffer of {at, x, z, face} samples. @returns {{ at:number, x:number, z:number, face:number }[]} */
export const makeTrack = () => [];
/** @param {any[]} tr @param {number} at @param {number} x @param {number} z @param {number} face */
export function pushSample(tr, at, x, z, face) {
  const last = tr[tr.length - 1];
  if (last && at <= last.at) { last.x = x; last.z = z; last.face = face; return; }
  const e = tr.length >= 8 ? tr.shift() : {}; e.at = at; e.x = x; e.z = z; e.face = face; tr.push(e);
}
const angLerp = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ k) => { const d = Math.atan2(Math.sin(b - a), Math.cos(b - a)); return a + d * k; };
/**
 * Where to draw at time `now` (renders DELAY ms behind). Writes into `out` (no allocation).
 * @param {any[]} tr @param {number} now @param {{x:number,z:number,face:number}} out @returns {boolean} false when empty
 */
export function sampleAt(tr, now, out) {
  if (!tr.length) return false; const t = now - DELAY;
  const first = tr[0]; if (t <= first.at || tr.length === 1) { out.x = first.x; out.z = first.z; out.face = first.face; return true; }
  for (let i = tr.length - 1; i > 0; i--) { const a = tr[i - 1], b = tr[i]; if (t >= a.at) {
    if (t >= b.at) { out.x = b.x; out.z = b.z; out.face = b.face; return true; }
    const k = (t - a.at) / (b.at - a.at); out.x = a.x + (b.x - a.x) * k; out.z = a.z + (b.z - a.z) * k; out.face = angLerp(a.face, b.face, k); return true; } }
  return true;
}

/** Block list: parse what's stored (array of ids, max 200, newest kept). @param {string|null} raw @returns {string[]} */
export function parseBlocked(raw) {
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? [...new Set(a.filter(x => str(x, 64)))].slice(-BLOCK_MAX) : []; } catch { return []; }
}
/** @param {string[]} list @param {string} id @returns {string[]} */
export function addBlocked(list, id) { const out = list.filter(x => x !== id); out.push(id); return out.slice(-BLOCK_MAX); }
/** @param {string[]} list @param {string} id */
export const removeBlocked = (list, id) => list.filter(x => x !== id);
/** simulated members to show: owner rule max(0, 25 - real players) */
export const simTarget = (/** @type {number} */ real) => Math.max(0, 25 - Math.max(0, real | 0));

/** a 'states' / 'join' entry that isn't ourselves (the server's per-floor batch includes the sender) @param {string} id @param {string} you */
export const othersOnly = (id, you) => !!id && id !== you;
