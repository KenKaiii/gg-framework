// @ts-check
// Activity registry: turns world interactables into real activities.
//
// An ACTIVITY is a module that exports `default` = { id, title, match, start }:
//   match(it, R) -> boolean      which interactables (room R, entry it from R.interact) open this activity
//   start(ctx) -> void           ctx = { S, it, R, api, ov: overlay(...)?, done(result?) }
// Activities either open a full-screen overlay (games, menus, close-up screens) or run in the world (sit and watch).
// The registry handles input blocking, pausing world keys, Esc, and calling done().
//
// Sit-to-activity: a SLOT can carry `act: '<activityId>'`; when the player sits there the activity starts (e.g. the
// sofa in front of the TV starts "watch").
import { overlay, ensureStyle } from './overlay.js';
import { setView, clearView, worldOf, hideBlockers } from './view.js';
import { ACTIVITIES } from './index.js';
import { SFX } from '../sfx.js';

/** @param {any} S @param {any} U */
export function initActivities(S, U) {
  const A = { current: null };
  ensureStyle();
  const find = (it, R) => ACTIVITIES.find(a => { try { return a.match(it, R); } catch { return false; } });
  /** @returns {boolean} true when an activity took the interaction */
  A.tryStart = (it, R, api) => {
    const act = find(it, R); if (!act || A.current) return false;
    U.blocking = true; S.keys.clear(); S.me.path = null; document.body.classList.add('in-act');
    let ov = null;
    // lean in: the camera glides onto the object (same angle, closer) before its game opens out of it; an activity that
    // sets its own close-up (pool from above, a TV over the shoulder) replaces this view in start()
    const lean = act.lean === false ? null : leanView(S, it, R); if (lean) { setView(S, lean); S.view.__lean = true; }
    // nobody's head between the camera and the thing (other people, or you standing in front of it)
    let blk = null, blkRaf = 0;
    const meToo = it?.kind === 'seat'; // seated at it: your own head is between the camera and the screen
    if (lean && S.scene) { blk = hideBlockers(S, S.scene, lean.target, lean.dir, { radius: 0.9, me: meToo }); let tl = performance.now(); const tick = now => { if (!blk) return; const v = S.view || lean; if (v !== lean && S.view) { blk.restore(); blk = hideBlockers(S, S.scene, v.target, v.dir, { radius: 0.9, me: meToo }); lean.target = v.target; lean.dir = v.dir; } blk.tick((now - tl) / 1000); tl = now; blkRaf = requestAnimationFrame(tick); }; blkRaf = requestAnimationFrame(tick); }
    const done = () => { if (!A.current) return; A.current = null; U.blocking = false; document.body.classList.remove('in-act'); removeEventListener('keydown', esc, true); try { ov?.close(); } catch (e) { console.warn(e); } if (S.view?.__lean) clearView(S); cancelAnimationFrame(blkRaf); blk?.restore(); blk = null; };
    const esc = e => { if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); } };
    addEventListener('keydown', esc, true);
    A.current = { act, done };
    if (act.sfx !== false) { if (act.sfx) SFX.play(act.sfx); else SFX.forItem(it, R); }
    const ctx = { S, U, it, R, api, done, overlay: o => { ov = overlay({ ...o, lean: true, _for: { it, actId: act.id, seated: () => !!S.me?.sitting } }); ov.onClose(done);
      // the game opens out of the object once the camera has arrived on it (or straight away if there's no close-up)
      const el = ov.el, t0 = performance.now(), wait = () => { if (!el.isConnected) return; if (!S.view || (S.viewK || 0) > 0.93 || performance.now() - t0 > 1100) el.classList.add('arrived'); else requestAnimationFrame(wait); };
      requestAnimationFrame(wait); return ov; } };
    try { act.start(ctx); } catch (e) { console.warn('activity ' + act.id, e); done(); }
    return true;
  };
  A.label = (it, R) => { const a = find(it, R); return a?.label ? a.label(it, R) : null; };
  return A;
}

/** How high the thing you use sits (m), by kind: the camera leans in on that point. */
const LEAN_Y = { board: 1.45, poster: 1.5, sign: 1.5, screen: 1.4, tv: 1.0, window: 1.4, phone: 1.25, payphone: 1.25, curtain: 1.4,
  arcade: 1.25, pinball: 1.0, pool: 0.8, pc: 1.0, terminal: 1.05, server: 1.1, machine: 1.0, jukebox: 1.05, radio: 1.0,
  telescope: 1.25, shelf: 1.2, tome: 0.95, fridge: 1.0, counter: 1.0, food: 0.95, bed: 0.55, game: 1.0, lamp: 1.2, gadget: 1.0, prop: 0.9 };
/**
 * The default "lean in" close-up for an interactable: same iso angle as the play camera, ~2.4 m of world in view,
 * centred on the object (a seat's view centres on what's in front of it). @returns {any}
 */
function leanView(S, it, R) {
  if (!it || !R?.root) return null;
  // the object itself (rooms/focus.js found it for the hover ring: footprint centre vx/vz, top vh), else the hotspot
  let x = it.vx ?? it.x, z = it.vz ?? it.z;
  if (typeof x !== 'number' && it.slot) { x = it.slot.x; z = it.slot.z; }
  if (typeof x !== 'number' || typeof z !== 'number') return null;
  if (it.slot && typeof it.slot.face === 'number' && it.kind === 'seat') { x += Math.sin(it.slot.face) * 0.6; z += Math.cos(it.slot.face) * 0.6; } // the desk in front of the chair
  const a = Math.PI / 4 + (S.rotSmooth || 0) * Math.PI / 2;
  const y = typeof it.vh === 'number' ? Math.max(0.5, it.vh - 0.2) : LEAN_Y[it.kind] ?? 1.0;
  return { speed: 5.5, target: worldOf(R, x, y, z), dir: { x: Math.sin(a), y: Math.SQRT1_2, z: Math.cos(a) }, zoom: it.kind === 'seat' ? 1.9 : 2.4 };
}
