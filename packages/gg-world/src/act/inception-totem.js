// @ts-check
// The totem: close-up on the spinning top, push-your-luck. Watching grows the pot; leave (Space) to bank it and keep
// the streak. If it topples while you watch, the pot is gone (you were awake). Sometimes it never stops: cut to black.
import { SFX } from '../sfx.js';

// top spin-up purr and the topple clatter
SFX.define('limbo.spin', (o, t, p, K) => K.tone(o, t, { type: 'triangle', f: 300 * p, f1: 520 * p, v: 0.06, a: 0.02, d: 0.35 }));
SFX.define('limbo.topple', (o, t, p, K) => { [0, 0.09, 0.16, 0.21].forEach((d, i) => K.tone(o, t + d, { type: 'sine', f: (900 - i * 60) * p, v: 0.08 - i * 0.015, d: 0.05 })); });
import { loop, coins } from './util.js';
import { setView, clearView, hideOccluders, worldOf } from './view.js';
import { hook, loadNum, saveNum } from './inception-util.js';
import { gx, GX } from './gx.js';
import { FONT } from '../fonts.js';

/** @param {any} ctx */
export function startTotem(ctx) {
  const { R, S } = ctx, I = R.inception, ts = I.topSpin; let wob = false;
  const ov = ctx.overlay({ title: 'The Totem', sub: 'is this a dream?', help: '<kbd>space</kbd> / <kbd>click</kbd> spin, or leave the room to bank it' });
  const K = gx(ov);
  const camT = worldOf(R, 9.2, 0.82, 4.2), camD = { x: 0.25, y: 0.42, z: 1 }; const camL = Math.hypot(camD.x, camD.y, camD.z);
  setView(S, { target: camT, dir: camD, zoom: 0.55 });
  // anyone (seated NPCs, visitors) standing on the camera line would block the close-up: hide them while it's open
  /** @type {Map<any, boolean>} */ const hidden = new Map(); const _p = camT.clone();
  let people = [], scanT = 0; // avatar roots (anything with a skinned mesh), rescanned once a second
  // each avatar is a glTF 'Scene' node holding a rig with a 'head' bone; hide that inner node (the world culler drives the outer root)
  const scan = () => { const L = []; (S.scene || R.root).traverse(m => { if (m.name !== 'head' || !m.isBone && !m.parent) return; let o = m; while (o.parent && o.name !== 'Scene') o = o.parent; if (o.name !== 'Scene' || L.some(p => p.o === o)) return; let me = false; for (let q = o; q; q = q.parent) if (q === S.me.root) me = true; if (!me) L.push({ o, h: m }); }); people = L; };
  const hidePeople = (dt = 1) => { if ((scanT -= dt) <= 0) { scanT = 1; scan(); }
    for (const { o, h } of people) { if (o === S.me.root || o.parent == null) continue;
    if (h) h.getWorldPosition(_p); else { o.getWorldPosition(_p); _p.y += 0.9; } const vx = _p.x - camT.x, vy = _p.y - camT.y, vz = _p.z - camT.z, along = (vx * camD.x + vy * camD.y + vz * camD.z) / camL;
    const perp = Math.sqrt(Math.max(0, vx * vx + vy * vy + vz * vz - along * along)), block = along > 0.3 && perp < 1.5;
    if (block && !hidden.has(o)) { hidden.set(o, true); o.visible = false; } else if (!block && hidden.has(o)) { o.visible = true; hidden.delete(o); } } };
  hidePeople(); hideOccluders(S); const meVis = S.me.root.visible; S.me.root.visible = false; // the player would stand between camera and top
  const st = { phase: 'ready', t: 0, pt: 0, pot: 0, streak: 0, banked: 0, fate: 'fall', T: 0, black: 0, msg: 'Spin the top.', msgC: GX.text2 };
  let best = loadNum('totem-streak'), bestBank = loadNum('totem-bank');
  const hud = K.hud([{ id: 'pot', label: 'Pot', tone: 'gold' }, { id: 'streak', label: 'Streak', tone: 'up' }, { id: 'banked', label: 'Banked' }],
    [{ id: 'best', label: 'Best streak', value: best, tone: 'teal' }, { id: 'bank', label: 'Best bank', value: bestBank, tone: 'pink' }]);
  // the message strip + action button, docked above the help line
  const bar = document.createElement('div');
  bar.style.cssText = `position:fixed;left:50%;bottom:118px;transform:translateX(-50%);z-index:3;display:flex;align-items:center;gap:14px;padding:10px 10px 10px 18px;border-radius:14px;background:rgba(21,23,26,.78);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 0 0 1px rgba(255,255,255,.07),0 12px 30px -12px rgba(0,0,0,.8);font:500 14px/1.3 ${FONT.app};color:${GX.text2};max-width:calc(100vw - 40px)`;
  bar.innerHTML = '<span class="m"></span><button class="gx-btn pri" type="button">Spin</button>';
  const msgEl = /** @type {HTMLElement} */ (bar.querySelector('.m')), actBtn = /** @type {HTMLElement} */ (bar.querySelector('button'));
  ov.el.appendChild(bar);
  const veil = document.createElement('div'); veil.style.cssText = 'position:fixed;inset:0;z-index:4;background:#000;opacity:0;pointer-events:none;transition:opacity .2s'; ov.el.appendChild(veil);
  let lastMsg = '', lastAct = '';
  const P = { add: (s, _x, _y, c) => K.pop(innerWidth / 2, innerHeight * 0.42 + (c ? 34 : 0), s, c || 'gold') };
  const spin = () => {
    SFX.play('whoosh'); SFX.play('limbo.spin', { delay: 0.1 });
    st.phase = 'spin'; st.pt = 0; st.pot = 0; const r = Math.random();
    st.fate = r < 0.15 ? 'dream' : 'fall'; st.T = st.fate === 'dream' ? 7 + Math.random() * 2 : 1.6 + Math.random() * 7.5;
    ts.on = true; ts.speed = 40; ts.tilt = 0; ts.wob = 0; st.msg = 'It spins... leave the room to bank the pot.'; st.msgC = GX.text2;
  };
  const bank = (mult = 1) => {
    const got = Math.floor(st.pot * mult); st.banked += got; st.streak++; P.add('+' + got);
    const cn = Math.floor(got / 25); if (cn > 0) { coins(S).spend(-cn); P.add('+' + cn + ' coins', 0, 0, 'up'); }
    if (st.streak > best) { best = st.streak; saveNum('totem-streak', best); } if (st.banked > bestBank) { bestBank = st.banked; saveNum('totem-bank', bestBank); }
    st.phase = 'ready'; SFX.play(mult > 1 ? 'win' : 'success'); SFX.play('step.marble', { delay: 0.25, vol: 0.6 });
  };
  const kd = e => { if (e.code !== 'Space') return; e.preventDefault();
    if (st.phase === 'ready' || st.phase === 'fell') spin();
    else if (st.phase === 'spin') { (st.bankFn || bank)(); st.msg = 'You leave before it decides. Streak ' + st.streak + '.'; st.msgC = GX.success; } };
  // mouse: a click anywhere (but the overlay's own buttons) is the space key
  const md = e => { if (e.button !== 0 || (e.target instanceof Element && e.target.closest('button,a,.gx-layer') && e.target !== actBtn)) return; e.preventDefault(); kd({ code: 'Space', preventDefault() {} }); };
  ov.el.addEventListener('pointerdown', md); ov.el.style.cursor = 'pointer';
  addEventListener('keydown', kd); hook({ totem: { get phase() { return st.phase; }, get streak() { return st.streak; }, get banked() { return st.banked; } } });
  ov.onClose(() => { removeEventListener('keydown', kd); hook({ totem: null }); ts.on = true; ts.speed = 30; ts.tilt = 0; ts.wob = 0; clearView(S); S.me.root.visible = meVis; for (const [o] of hidden) o.visible = true; hidden.clear(); });
  const bank2 = mult => { bank(mult); if (mult > 1) { K.pop(innerWidth / 2, innerHeight * 0.32, 'Dreaming: double pot', 'pink'); } else K.pop(innerWidth / 2, innerHeight * 0.32, 'Banked', 'up'); };
  st.bankFn = bank2;
  loop(ov, dt => {
    hidePeople(dt); st.t += dt;
    if (st.phase === 'spin') {
      st.pt += dt; st.pot += dt * (4 + st.pt * 3) * (1 + st.streak * 0.25);
      const left = st.T - st.pt;
      if (st.fate === 'fall' && left < 1.4 && !wob) { wob = true; SFX.play('rattle', { vol: 0.5, pitch: 0.7 }); } if (st.pt < dt * 1.5) wob = false;
      if (st.fate === 'fall') { ts.speed = 40 * Math.max(0.25, left / st.T); ts.tilt = left < 1.4 ? (1.4 - left) * 0.18 : 0.01; }
      else { ts.speed = 40; ts.tilt = 0.005; }
      if (left <= 0) {
        if (st.fate === 'fall') { st.phase = 'fell'; ts.on = false; ts.wob = 1.35; st.pot = 0; st.streak = 0; K.pop(innerWidth / 2, innerHeight * 0.32, 'It fell', 'bad'); SFX.play('limbo.topple'); SFX.play('fail', { delay: 0.35, vol: 0.7 }); st.msg = 'It fell. You were awake. Pot lost.'; st.msgC = GX.error; }
        else { st.phase = 'black'; st.black = 0; SFX.play('eerie'); SFX.play('heartbeat', { delay: 0.6, vol: 0.6 }); }
      }
    }
    if (st.phase === 'black') { st.black += dt; if (st.black > 2.2) { bank2(2); st.msg = 'It never stopped. Double pot!'; st.msgC = GX.warning; } }
    if (st.phase === 'spin' && st.fate === 'fall' && st.T - st.pt < 1.4) { st.msg = 'It wobbles...'; st.msgC = GX.error; }
    hud.set('pot', Math.floor(st.pot)); hud.set('streak', st.streak); hud.set('banked', st.banked); hud.set('best', best); hud.set('bank', bestBank);
    if (st.msg !== lastMsg) { lastMsg = st.msg; msgEl.textContent = st.msg; } msgEl.style.color = st.msgC;
    const act = st.phase === 'spin' ? 'Leave the room' : 'Spin'; if (act !== lastAct) { lastAct = act; actBtn.textContent = act; actBtn.className = 'gx-btn' + (st.phase === 'spin' ? '' : ' pri'); }
    veil.style.opacity = st.phase === 'black' ? String(Math.min(1, st.black * 2)) : '0';
  });
}
