// @ts-check
// Jackrabbit Diner activities: a one-page diner menu ($5 shake, cherry pie + black coffee) and the twist contest.
import { text, coins, loop } from './util.js';
import { holdProp } from '../rooms/props-hand.js';
import { moment } from './films-b-fx.js';
import { SFX } from '../sfx.js';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Tiny fries cone in the right hand: a red paper cone + a merged bunch of sticks (2 draw calls), cached like holdProp's. */
function holdFries(av) {
  const cache = av.root.userData.props || (av.root.userData.props = {});
  if (!cache.fries) { const g = new THREE.Group(); g.name = 'prop-fries';
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.045, 0.16, 8), new THREE.MeshStandardMaterial({ color: '#c8242c', roughness: 0.7 })); cone.position.y = 0.08; g.add(cone);
    const sticks = []; for (let i = 0; i < 9; i++) { const a = i * 2.4, r = 0.035 * (i % 3) / 2; sticks.push(new THREE.BoxGeometry(0.018, 0.13 + (i % 4) * 0.015, 0.018).rotateZ(Math.cos(a) * 0.25).rotateX(Math.sin(a) * 0.25).translate(Math.cos(a) * r, 0.2, Math.sin(a) * r)); }
    g.add(new THREE.Mesh(mergeGeometries(sticks), new THREE.MeshStandardMaterial({ color: '#f2c14e', roughness: 0.6, emissive: '#3a2000' })));
    ((av.bones?.['handslot.r'] || av.bones?.['handslotr']) || av.rig).add(g); cache.fries = g; }
  for (const k in cache) cache[k].visible = k === 'fries';
}

const W = 320, H = 180;
const MENU = [
  { id: 'shake', name: 'The $5 Shake', price: 5, prop: 'cocktail', desc: 'vanilla. cherry on top. pricey.', say: 'is that a five dollar shake?', after: "that's a pretty f***ing good milkshake." },
  { id: 'pie', name: 'Cherry Pie + Coffee', price: 3, prop: 'mug', desc: 'black as midnight on a moonless night', say: 'damn fine cup of coffee.', after: 'and hot! ...that pie, too.' },
  { id: 'fries', name: 'Fries, Extra Grease', price: 2, prop: 'fries', desc: 'reheated since 1958', say: 'fries. the debugger of hunger.', after: 'grease on the trackpad. worth it.' }];
const say = (S, U, t, s = 3.5) => S.ui?.bubble?.(S.me, t, s) ?? U?.bubble?.(S.me, t, s);

/** @param {any} ctx */
function menu(ctx) {
  const { S, U } = ctx; const wal = coins(S);
  let sel = MENU.findIndex(m => m.id === ctx.it.id); if (sel < 0) sel = 0;
  const ov = ctx.overlay({ title: 'Jackrabbit Diner', sub: 'open all night. no refunds.', help: '<kbd>&uarr;&darr;</kbd>pick <kbd>enter</kbd>order <kbd>esc</kbd>leave' });
  const { x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  let shake = 0, msg = '', msgT = 0;
  const order = () => {
    const it = MENU[sel];
    if (wal.balance < it.price || !wal.spend(it.price, it.name)) { shake = 0.35; msg = 'card declined. go ship something.'; msgT = 2.5; SFX.play('ui.deny'); return; }
    ov.close(); SFX.play('register', { delay: 0.1 }); SFX.play(it.prop === 'mug' ? 'pour' : it.prop === 'fries' ? 'fizz' : 'espresso', { delay: 0.5, vol: 0.6 }); SFX.play(it.prop === 'fries' ? 'paper' : 'glass', { delay: 0.9, vol: 0.6 }); say(S, U, it.say); try { S.me.once?.('Interact', 1.2); } catch { /* anim */ }
    setTimeout(() => it.prop === 'fries' ? holdFries(S.me.av) : holdProp(S.me.av, it.prop), 400); setTimeout(() => say(S, U, it.after, 3), 4200);
  };
  const onKey = e => { if (e.code === 'ArrowUp') { sel = (sel + MENU.length - 1) % MENU.length; SFX.play('ui.select'); } else if (e.code === 'ArrowDown') { sel = (sel + 1) % MENU.length; SFX.play('ui.select'); } else if (e.code === 'Enter' || e.code === 'Space') order(); };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  loop(ov, (dt, t) => {
    shake = Math.max(0, shake - dt); msgT -= dt; const sx = shake ? Math.sin(t * 80) * 3 : 0;
    x.fillStyle = '#140f1c'; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 20; i++) for (let j = 0; j < 2; j++) { x.fillStyle = (i + j) % 2 ? '#2a2440' : '#7d7568'; x.fillRect(i * 16, H - 16 + j * 8 - 8, 16, 8); }
    x.fillStyle = '#8a1f26'; x.fillRect(12 + sx, 10, W - 24, 132); x.fillStyle = '#e8dcc0'; x.fillRect(16 + sx, 14, W - 32, 124);
    text(x, 'TONIGHT', W / 2 + sx, 30, { size: 16, title: true, color: '#8a1f26', align: 'center' });
    MENU.forEach((m, i) => { const y = 52 + i * 30, on = i === sel;
      if (on) { x.fillStyle = Math.sin(t * 6) > 0 ? '#ff4fd8' : '#d43fb4'; x.fillRect(22 + sx, y - 13, W - 44, 28); }
      text(x, m.name, 28 + sx, y, { size: 16, color: on ? '#fff' : '#2a1820' });
      text(x, '$' + m.price, W - 30 + sx, y, { size: 16, color: on ? '#fff' : '#8a1f26', align: 'right' });
      text(x, m.desc, 28 + sx, y + 12, { size: 16, color: on ? '#ffe6f6' : '#6a5a50' }); });
    text(x, msgT > 0 ? msg : `wallet: ${wal.balance} coins`, W / 2, 146, { size: 16, color: msgT > 0 ? '#ff6b6b' : '#ffcf8a', align: 'center' });
  });
}

/** Twist contest: a close-up on the dance floor while the player twists, then the floor crowns a winner. @param {any} ctx */
function twist(ctx) {
  const { S, U, R } = ctx; const av = S.me.av, p = S.me.pos;
  try { av.startEmote('cringe'); av.emT = 5.4; } catch { /* no emote */ }
  R.dinerSong = 1; R.onInteract?.('jukebox', { toast: () => {}, bubble: () => {} });
  let won = false, beat = 0;
  moment(ctx, { at: [p.x, 1.0, p.z], dir: { x: 1, y: 0.55, z: 0.35 }, zoom: 1.8, title: 'Twist contest', line: 'I want to dance. I want to win.', secs: 5.6,
    tick: (dt, t, api) => { if (t > 1.2 && t < 3.6 && Math.floor(t / 0.42) !== beat) { beat = Math.floor(t / 0.42); SFX.play('step.tile', { vol: 0.6, jitter: 0.1 }); if (beat % 2) SFX.play('squeak', { vol: 0.25 }); }
      if (t > 3.6 && !won) { won = true; api.shake(0.06); SFX.play('win'); SFX.play('sparkle', { delay: 0.4 }); api.cap.set('1st place!', 'The trophy is yours. Nobody else entered.'); say(S, U, 'You won the trophy. Everyone saw.', 3); } },
    end: () => { try { av.em = null; av.rig.rotation.z = 0; av.rig.position.y = 0; av.play('Idle'); } catch { /* */ } } });
}

/** @type {any[]} */
export default [
  { id: 'diner-menu', label: () => 'Order', match: (it, R) => R.id === 'diner' && (it.id === 'shake' || it.id === 'pie'), start: menu },
  { id: 'diner-twist', sfx: false, match: (it, R) => R.id === 'diner' && it.id === 'twist', start: twist },
];
