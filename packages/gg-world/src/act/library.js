// @ts-check
// Activities for The Restricted Section: the Sorting Hat sorts you into a coder house; the Ring makes you vanish.
import { moment } from './films-b-fx.js';
import { SFX } from '../sfx.js';

const on = id => (it, R) => R.id === 'library' && it.id === id;
const HOUSES = [
  ['RUSTPUFF!', 'Loyal, patient, fights the borrow checker daily.'],
  ['TYPESCRIPTHERIN!', 'Ambitious. Types everything. Trusts no any.'],
  ['GRYFFINDEV!', 'Brave enough to deploy on a Friday.'],
  ['PYTHONCLAW!', 'Clever, lazy, imports a library for it.'],
  ['GOLANDOR!', 'if err != nil. Steady, stubborn, fast.'],
];

/** Make the player see-through for `secs` (materials cloned so other avatars stay solid). */
function vanish(S, secs = 5) {
  const root = S.me?.av?.root || S.me?.root; if (!root) return;
  const saved = [];
  root.traverse(o => { if (!o.isMesh || !o.material) return; const m = o.material; saved.push([o, m, o.castShadow]);
    const fade = (Array.isArray(m) ? m : [m]).map(x => { const c = x.clone(); c.transparent = true; c.opacity = 0.12; c.depthWrite = false; return c; });
    o.material = Array.isArray(m) ? fade : fade[0]; o.castShadow = false; });
  setTimeout(() => { for (const [o, m, cs] of saved) { const f = o.material; o.material = m; o.castShadow = cs; (Array.isArray(f) ? f : [f]).forEach(x => x.dispose?.()); } }, secs * 1000);
}

/** Hide the player's avatar while a close-up looks past them; returns the restore. */
const hideMe = S => { const r = S.me?.root; if (!r) return () => {}; r.visible = false; return () => { r.visible = true; }; };

/** @type {any[]} */
export default [
  { id: 'lib-hat', match: on('hat'), start(ctx) {
    const lib = ctx.R.lib, n = (lib.sorted = (lib.sorted ?? Math.floor(Math.random() * HOUSES.length)) + 1) % HOUSES.length, [house, why] = HOUSES[n];
    lib.wobble = 2.4; let said = false; SFX.play('rattle', { vol: 0.3, delay: 0.3 }); SFX.play('ui.type', { delay: 0.8 }); SFX.play('heartbeat', { vol: 0.4, delay: 1.2 }); const show = hideMe(ctx.S);
    moment(ctx, { at: [-2.9, 0.78, -2.55], dir: { x: 0.55, y: 0.45, z: 1 }, zoom: 0.75, title: 'The old hat', line: 'Hmm... difficult. Very difficult. Lots of tabs open...', secs: 5.2,
      tick: (dt, t, api) => { if (t > 2.3 && !said) { said = true; lib.burst(); api.shake(0.03); SFX.play('sparkle'); SFX.play('levelup', { delay: 0.15, vol: 0.7 }); api.cap.set(house, why); ctx.U?.bubble?.(ctx.S.me, house, 3); } }, end: show });
  } },
  { id: 'lib-ring', match: on('ring'), start(ctx) {
    const lib = ctx.R.lib, show = hideMe(ctx.S);
    moment(ctx, { at: [7.2, 1.1, -3.0], dir: { x: 0.6, y: 0.5, z: 1 }, zoom: 0.45, title: 'A plain gold ring', line: 'My precious...', secs: 3.2,
      tick: (dt, t, api) => { lib.rc.ring.rotation.z += dt * 3; if (t > 1.6 && !lib.rFx) { lib.rFx = 1; SFX.play('magic'); SFX.play('eerie', { delay: 0.3, vol: 0.6 }); } if (t > 1.6) api.cap.set(null, 'You slip it on. You fade out for a bit.'); },
      end: () => { lib.rFx = 0; show(); vanish(ctx.S, 5); SFX.play('whoosh', { vol: 0.5 }); setTimeout(() => SFX.play('chime', { vol: 0.5 }), 5000); } });
  } },
];
