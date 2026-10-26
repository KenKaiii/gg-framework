// @ts-check
// Jackrabbit Diner activities: a one-page diner menu ($5 shake, cherry pie + black coffee) and the twist contest.
import { mouse, coins, loop } from './util.js';
import { PAL, bg, panel, badge, button, title, glow, noise, shine, coin, particles, shaker, clamp, rr } from './art.js';
import { CFONT } from '../fonts.js';
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
  { id: 'pie', name: 'Cherry Pie + Coffee', price: 3, prop: 'mug', desc: 'black as a moonless night', say: 'damn fine cup of coffee.', after: 'and hot! ...that pie, too.' },
  { id: 'fries', name: 'Fries, Extra Grease', price: 2, prop: 'fries', desc: 'reheated since 1958', say: 'fries. the debugger of hunger.', after: 'grease on the trackpad. worth it.' }];
const say = (S, U, t, s = 3.5) => S.ui?.bubble?.(S.me, t, s) ?? U?.bubble?.(S.me, t, s);

/** @param {any} ctx */
function menu(ctx) {
  const { S, U } = ctx; const wal = coins(S);
  let sel = MENU.findIndex(m => m.id === ctx.it.id); if (sel < 0) sel = 0;
  const ov = ctx.overlay({ title: 'Jackrabbit Diner', sub: 'open all night. no refunds.', help: '<kbd>&uarr;&darr;</kbd> or hover: pick <kbd>enter</kbd> or click: order <kbd>esc</kbd> leave' });
  const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  let shake = 0, msg = '', msgT = 0;
  const order = () => {
    const it = MENU[sel];
    if (wal.balance < it.price || !wal.spend(it.price, it.name)) { shake = 0.35; msg = 'card declined. go ship something.'; msgT = 2.5; SFX.play('ui.deny'); return; }
    ov.close(); SFX.play('register', { delay: 0.1 }); SFX.play(it.prop === 'mug' ? 'pour' : it.prop === 'fries' ? 'fizz' : 'espresso', { delay: 0.5, vol: 0.6 }); SFX.play(it.prop === 'fries' ? 'paper' : 'glass', { delay: 0.9, vol: 0.6 }); say(S, U, it.say); try { S.me.once?.('Interact', 1.2); } catch { /* anim */ }
    setTimeout(() => it.prop === 'fries' ? holdFries(S.me.av) : holdProp(S.me.av, it.prop), 400); setTimeout(() => say(S, U, it.after, 3), 4200);
  };
  const onKey = e => { if (e.code === 'ArrowUp') { sel = (sel + MENU.length - 1) % MENU.length; SFX.play('ui.select'); } else if (e.code === 'ArrowDown') { sel = (sel + 1) % MENU.length; SFX.play('ui.select'); } else if (e.code === 'Enter' || e.code === 'Space') order(); };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  // mouse: hover a dish to pick it, click to order; buttons below
  const ms = mouse(ov, c, W, H); let hotB = -1;
  const rowsArea = () => MENU.map((m, i) => ({ x: 30, y: ROW0 + i * ROWH - 4, w: 214, h: ROWH - 2, hover: () => { if (sel !== i) { sel = i; SFX.play('ui.select'); } }, pick: () => order() }));
  ms.set([...rowsArea(), { x: 252, y: 118, w: 56, h: 22, hover: () => { hotB = 0; }, pick: () => order() }, { x: 252, y: 146, w: 56, h: 20, hover: () => { hotB = 1; }, pick: () => ov.close() }]);
  c.addEventListener('pointerleave', () => { hotB = -1; }); c.addEventListener('pointermove', e => { const r = c.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * W; if (px < 248) hotB = -1; });
  const bgc = dinerBackdrop(), fx = particles(), sh = shaker(); let selY = ROW0 + sel * ROWH, cn = wal.balance, prevSel = sel;
  loop(ov, (dt, t) => {
    shake = Math.max(0, shake - dt); msgT -= dt; if (shake > 0.3) sh.kick(4);
    if (sel !== prevSel) { prevSel = sel; fx.sparkle(40, ROW0 + sel * ROWH + 8, PAL.pink); }
    selY += (ROW0 + sel * ROWH - selY) * Math.min(1, dt * 16); cn += (wal.balance - cn) * Math.min(1, dt * 8);
    x.drawImage(bgc, 0, 0);
    glow(x, 60, 12, 70, PAL.pink, 0.16 + 0.06 * Math.sin(t * 1.8)); glow(x, 270, 12, 60, PAL.cyan, 0.14 + 0.05 * Math.sin(t * 1.6 + 1));
    x.save(); sh.apply(x, dt);
    // the laminated menu: red vinyl + chrome trim, cream card inside
    menuCard(x, 16, 8, 236, 164);
    title(x, "JACKRABBIT SLIM'S", 134, 32, { size: 16, color: '#c8242c', ink: '#fff6e0', glow: 'rgba(255,80,120,0.4)' });
    x.fillStyle = '#c8242c'; x.fillRect(40, 38, 188, 1); x.fillRect(40, 40, 188, 1);
    // selection: a pink neon bar that glides between rows
    const sy = Math.round(selY) - 4; panel(x, 28, sy, 216, ROWH - 2, { style: 'neon', r: 3 }); glow(x, 136, sy + 15, 120, PAL.pink, 0.10 + 0.05 * Math.sin(t * 3));
    MENU.forEach((m, i) => { const y = ROW0 + i * ROWH, on = i === sel;
      dish(x, m.id, 46, y + 14, t, on);
      title(x, m.name, 64, y + 10, { size: 16, body: true, align: 'left', color: on ? '#fff' : PAL.paperInk, ink: on ? PAL.ink : 'rgba(255,246,224,0.7)' });
      x.save(); x.font = CFONT.body(16); x.fillStyle = on ? '#ffd0ec' : '#7a5a48'; x.fillText(m.desc, 64, y + 22); x.restore();
      priceTag(x, 222, y + 8, m.price, on, wal.balance >= m.price); });
    x.restore();
    // right column: wallet + order / leave
    badge(x, 252, 10, 'wallet', Math.round(cn), { w: 58, color: PAL.gold, style: 'metal' }); coin(x, 300, 36, 4, t);
    const it = MENU[sel], can = wal.balance >= it.price;
    badge(x, 252, 50, 'order', '$' + it.price, { w: 58, color: can ? PAL.green : PAL.red, style: 'metal' });
    if (!can) title(x, 'too broke', 281, 104, { size: 16, body: true, color: can ? PAL.dim : PAL.red });
    button(x, 252, 118, 56, 22, 'ORDER', { primary: can, hot: hotB === 0, disabled: !can }); if (can && hotB !== 0) shine(x, 252, 118, 56, 22, t);
    button(x, 252, 146, 56, 20, 'LEAVE', { hot: hotB === 1 });
    fx.draw(x, dt);
    if (msgT > 0) { const k = clamp(msgT / 0.3, 0, 1); x.globalAlpha = k; panel(x, 34, 140, 200, 24, { style: 'neon', r: 3 }); title(x, msg, 134, 157, { size: 16, body: true, color: PAL.red }); x.globalAlpha = 1; }
  });
}

const ROW0 = 50, ROWH = 36;
/** Static diner backdrop (cached): neon-lit wall with a chrome rail, checkerboard floor. */
function dinerBackdrop() {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const x = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
  bg.vignette(x, W, H, '#2a1430', '#4a2448');
  for (let i = 0; i < W; i += 10) { x.fillStyle = 'rgba(255,255,255,0.03)'; x.fillRect(i, 0, 5, 120); }
  x.fillStyle = '#c8cdd6'; x.fillRect(0, 118, W, 3); x.fillStyle = '#fff'; x.fillRect(0, 118, W, 1); x.fillStyle = '#6a707a'; x.fillRect(0, 121, W, 1);
  for (let j = 0; j < 7; j++) for (let i = 0; i < 21; i++) { x.fillStyle = (i + j) % 2 ? '#1a1620' : '#d8d0c4'; x.fillRect(i * 16 - (j % 2) * 0, 122 + j * 9, 16, 9); }
  const v = x.createLinearGradient(0, 122, 0, H); v.addColorStop(0, 'rgba(0,0,0,0.25)'); v.addColorStop(1, 'rgba(0,0,0,0.65)'); x.fillStyle = v; x.fillRect(0, 122, W, H - 122);
  noise(x, 0, 0, W, H, 0.03, 5); return cv;
}
/** Laminated menu: red vinyl cover with chrome trim around a cream card. */
function menuCard(x, X, Y, w, h) {
  x.fillStyle = 'rgba(0,0,0,0.45)'; rr(x, X + 3, Y + 5, w, h, 6); x.fill();
  let g = x.createLinearGradient(0, Y, 0, Y + h); g.addColorStop(0, '#f0f2f6'); g.addColorStop(0.5, '#8a909c'); g.addColorStop(1, '#d8dce4'); x.fillStyle = g; rr(x, X, Y, w, h, 6); x.fill();
  g = x.createLinearGradient(0, Y, 0, Y + h); g.addColorStop(0, '#d8303a'); g.addColorStop(1, '#8a1620'); x.fillStyle = g; rr(x, X + 3, Y + 3, w - 6, h - 6, 4); x.fill();
  g = x.createLinearGradient(0, Y, 0, Y + h); g.addColorStop(0, '#fbf2dc'); g.addColorStop(1, '#ead8b0'); x.fillStyle = g; rr(x, X + 8, Y + 8, w - 16, h - 16, 2); x.fill();
  noise(x, X + 8, Y + 8, w - 16, h - 16, 0.04, 9);
  x.fillStyle = 'rgba(255,255,255,0.35)'; x.beginPath(); x.moveTo(X + 8, Y + 8); x.lineTo(X + 70, Y + 8); x.lineTo(X + 8, Y + 60); x.fill(); // laminate glare
  for (const [cx, cy] of [[X + 5, Y + 5], [X + w - 6, Y + 5], [X + 5, Y + h - 6], [X + w - 6, Y + h - 6]]) { x.fillStyle = '#fff'; x.fillRect(cx, cy, 2, 2); x.fillStyle = '#5a606a'; x.fillRect(cx + 1, cy + 1, 1, 1); } // rivets
}
/** Price tag: a little red star burst with the price. */
function priceTag(x, X, Y, n, on, can) {
  x.save(); x.translate(X, Y); x.fillStyle = can ? (on ? PAL.gold : '#c8242c') : '#7a7488'; x.beginPath();
  for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2, r = i % 2 ? 9 : 12; x.lineTo(Math.cos(a) * r, Math.sin(a) * r); } x.closePath(); x.fill(); x.restore();
  title(x, '$' + n, X, Y + 5, { size: 16, body: true, color: on && can ? PAL.ink : '#fff', ink: on && can ? 'rgba(255,240,200,0.5)' : PAL.ink });
}
/** Little drawn dish icons. */
function dish(x, id, X, Y, t, on) {
  const bob = on ? Math.round(Math.sin(t * 4) * 1.5) : 0; X = Math.round(X); Y = Math.round(Y) + bob;
  x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(X - 8, Y + 6, 16, 2);
  if (id === 'shake') { x.fillStyle = '#cfe6f0'; x.beginPath(); x.moveTo(X - 6, Y - 10); x.lineTo(X + 6, Y - 10); x.lineTo(X + 3, Y + 4); x.lineTo(X - 3, Y + 4); x.fill(); x.fillStyle = '#fff4e0'; x.fillRect(X - 6, Y - 14, 12, 5); x.beginPath(); x.arc(X, Y - 14, 5, Math.PI, 0); x.fill(); x.fillStyle = '#d8203a'; x.beginPath(); x.arc(X + 1, Y - 19, 2.5, 0, 7); x.fill(); x.fillStyle = '#ff7ab8'; x.fillRect(X + 3, Y - 24, 1, 10); x.fillStyle = '#aab'; x.fillRect(X - 3, Y + 4, 6, 2); }
  else if (id === 'pie') { x.fillStyle = '#e0a458'; x.beginPath(); x.moveTo(X - 9, Y + 3); x.lineTo(X + 7, Y + 3); x.lineTo(X + 4, Y - 6); x.closePath(); x.fill(); x.fillStyle = '#a0182a'; x.fillRect(X - 6, Y - 1, 11, 3); x.fillStyle = '#3a1a10'; x.fillRect(X + 6, Y - 9, 6, 8); x.fillStyle = '#eee'; x.fillRect(X + 5, Y - 10, 8, 2); if (on) { x.fillStyle = 'rgba(255,255,255,0.5)'; x.fillRect(X + 8, Y - 14 - Math.round((t * 6) % 3), 1, 3); } }
  else { x.fillStyle = '#f2c14e'; for (let i = 0; i < 6; i++) x.fillRect(X - 5 + i * 2, Y - 12 + (i % 3) * 2, 1, 8); x.fillStyle = '#c8242c'; x.beginPath(); x.moveTo(X - 7, Y - 5); x.lineTo(X + 7, Y - 5); x.lineTo(X + 4, Y + 5); x.lineTo(X - 4, Y + 5); x.fill(); x.fillStyle = '#fff'; x.fillRect(X - 2, Y - 2, 4, 4); }
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
