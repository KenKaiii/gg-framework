// @ts-check
// App bridge (GG Coder). World runs in a SEALED frame inside the app (no same-origin: see boot.js). Messages carry
// `gg: 'world'` and are only exchanged with the parent window (the app), on the app's origin.
//   app -> game: player {level, percent, xp} | pause | resume | xp {amount, why} | profile {profile} | note {text}
//   game -> app: ready | save {profile}
// The app owns the online save (consent, device link, server); the game only says what changed and takes what the
// app hands back. Standalone (no parent app) none of this runs.
import { wallet } from './creator.js';

export const EMBED = window.parent !== window;
/** the app's origin (boot.js reads it from the frame's ancestors; a sealed frame's own origin is "null") */
const APP = /** @type {any} */ (globalThis).__ggAppOrigin || location.origin;
export const fromApp = (/** @type {MessageEvent} */ e) => EMBED && e.source === window.parent && (APP === '*' || e.origin === APP);
export const tellApp = (/** @type {Record<string, unknown>} */ msg) => { if (EMBED) try { window.parent.postMessage({ gg: 'world', ...msg }, APP); } catch { /* not embedded */ } };

const LOOK_KEYS = ['body', 'head', 'hair', 'skin', 'top', 'bottom', 'acc', 'accColor'];

/** what the game reports for the online save (only game data: never anything else) */
export function profileOf(S) {
  const L = S.player.look || {}, W = wallet(S) && S.wallet;
  const look = {}; for (const k of LOOK_KEYS) look[k] = L[k];
  look.silly = Array.isArray(L.silly) ? L.silly.slice(0, 4) : [];
  if (L.scale) look.scale = { head: +L.scale.head || 1, width: +L.scale.width || 1, height: +L.scale.height || 1 };
  return { name: S.player.namedHere ? S.player.name : null, look, owned: [...new Set(W.owned)].slice(0, 200), spent: Math.round(W.spent) };
}

let saveT = 0;
/** something worth keeping changed (a purchase, coins won, the wardrobe): tell the app in ~1.5 s (bursts collapse) */
export function saveSoon(S) { if (!EMBED) return; clearTimeout(saveT); saveT = setTimeout(() => { saveT = 0; tellApp({ t: 'save', profile: profileOf(S) }); }, 1500); }
/** send a pending save now (leaving World) */
export function flushSave(S) { if (!EMBED || !saveT) return; clearTimeout(saveT); saveT = 0; tellApp({ t: 'save', profile: profileOf(S) }); }

const HEX = /^#[0-9a-fA-F]{6}$/;
/**
 * The app sent the online save: adopt it. Nothing is lost either way: owned items are merged, the look and name come
 * from online (the account), spent takes the larger value (never invents coins). If this computer had extra, it's
 * saved back up.
 */
export function applyProfile(S, p) {
  if (!p || typeof p !== 'object') return;
  const W = (wallet(S), S.wallet); let extra = false;
  if (Array.isArray(p.owned)) { const on = new Set(p.owned.filter(x => typeof x === 'string')); for (const id of W.owned) if (!on.has(id)) extra = true; W.owned = [...new Set([...p.owned.filter(x => typeof x === 'string'), ...W.owned])]; }
  if (typeof p.spent === 'number' && Number.isFinite(p.spent)) { if (W.spent > p.spent) extra = true; W.spent = Math.max(W.spent, Math.round(p.spent)); }
  try { localStorage.setItem('night-rooms-wallet', JSON.stringify(W)); } catch { /* storage off */ }
  const L = p.look;
  if (L && typeof L === 'object' && LOOK_KEYS.every(k => typeof L[k] === 'string')) {
    const look = { ...S.player.look }; for (const k of LOOK_KEYS) look[k] = L[k];
    look.silly = Array.isArray(L.silly) ? L.silly.filter(x => typeof x === 'string').slice(0, 4) : [];
    if (L.scale && typeof L.scale === 'object') look.scale = { head: +L.scale.head || 1, width: +L.scale.width || 1, height: +L.scale.height || 1 };
    if (LOOK_KEYS.filter(k => /color|hair|skin|top|bottom/i.test(k)).every(k => HEX.test(look[k]))) { S.player.look = look; S.me?.av?.setLook?.(look); }
  }
  if (typeof p.name === 'string' && p.name.trim()) { S.player.name = p.name.trim().slice(0, 14); S.player.namedHere = true; }
  try { localStorage.setItem('night-rooms-look', JSON.stringify({ ...S.player.look, name: S.player.namedHere ? S.player.name : undefined })); } catch { /* storage off */ }
  S.ui?.refreshHud?.();
  if (extra) saveSoon(S);
}
