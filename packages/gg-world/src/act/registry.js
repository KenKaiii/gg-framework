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
    const done = () => { if (!A.current) return; A.current = null; U.blocking = false; document.body.classList.remove('in-act'); removeEventListener('keydown', esc, true); try { ov?.close(); } catch (e) { console.warn(e); } };
    const esc = e => { if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); } };
    addEventListener('keydown', esc, true);
    A.current = { act, done };
    if (act.sfx !== false) { if (act.sfx) SFX.play(act.sfx); else SFX.forItem(it, R); }
    const ctx = { S, U, it, R, api, done, overlay: o => { ov = overlay(o); ov.onClose(done); return ov; } };
    try { act.start(ctx); } catch (e) { console.warn('activity ' + act.id, e); done(); }
    return true;
  };
  A.label = (it, R) => { const a = find(it, R); return a?.label ? a.label(it, R) : null; };
  return A;
}
