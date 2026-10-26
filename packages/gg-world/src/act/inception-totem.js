// @ts-check
// The totem: close-up on the spinning top, push-your-luck. Watching grows the pot; leave (Space) to bank it and keep
// the streak. If it topples while you watch, the pot is gone (you were awake). Sometimes it never stops: cut to black.
import { SFX } from '../sfx.js';

// top spin-up purr and the topple clatter
SFX.define('limbo.spin', (o, t, p, K) => K.tone(o, t, { type: 'triangle', f: 300 * p, f1: 520 * p, v: 0.06, a: 0.02, d: 0.35 }));
SFX.define('limbo.topple', (o, t, p, K) => { [0, 0.09, 0.16, 0.21].forEach((d, i) => K.tone(o, t + d, { type: 'sine', f: (900 - i * 60) * p, v: 0.08 - i * 0.015, d: 0.05 })); });
import { loop, text, coins } from './util.js';
import { PAL, panel as artPanel, badge, button, banner, title, glow, shine, coin, particles, shaker } from './art.js';
import { setView, clearView, hideOccluders, worldOf } from './view.js';
import { hook, seeThrough, loadNum, saveNum, pops, panel } from './inception-util.js';

/** @param {any} ctx */
export function startTotem(ctx) {
  const { R, S } = ctx, I = R.inception, ts = I.topSpin; let wob = false;
  const ov = ctx.overlay({ title: 'The Totem', sub: 'is this a dream?', help: '<kbd>space</kbd> spin / leave the room <kbd>click</kbd> same <kbd>esc</kbd> stop' });
  const W = 480, H = 270, { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false; seeThrough(ov, c, 0.08);
  setView(S, { target: worldOf(R, 9.2, 0.82, 4.2), dir: { x: 0.25, y: 0.42, z: 1 }, zoom: 0.55 }); hideOccluders(S); const meVis = S.me.root.visible; S.me.root.visible = false; // the player would stand between camera and top
  let btn = null, hoverBtn = false;
  c.addEventListener('pointermove', e => { const r = c.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * W, py = (e.clientY - r.top) / r.height * H; hoverBtn = !!btn && px >= btn.x && px <= btn.x + btn.w && py >= btn.y && py <= btn.y + btn.h; });
  const st = { phase: 'ready', t: 0, pt: 0, pot: 0, streak: 0, banked: 0, fate: 'fall', T: 0, black: 0, msg: 'Press SPACE to spin the top.', msgC: '#e8dcc0', shake: 0 };
  let best = loadNum('totem-streak'), bestBank = loadNum('totem-bank'); const P = pops();
  const spin = () => {
    SFX.play('whoosh'); SFX.play('limbo.spin', { delay: 0.1 });
    st.phase = 'spin'; st.pt = 0; st.pot = 0; const r = Math.random();
    st.fate = r < 0.15 ? 'dream' : 'fall'; st.T = st.fate === 'dream' ? 7 + Math.random() * 2 : 1.6 + Math.random() * 7.5;
    ts.on = true; ts.speed = 40; ts.tilt = 0; ts.wob = 0; st.msg = 'It spins... SPACE to walk away and bank it.'; st.msgC = '#e8dcc0';
  };
  const bank = (mult = 1) => {
    const got = Math.floor(st.pot * mult); st.banked += got; st.streak++; P.add('+' + got, W / 2, 120);
    const cn = Math.floor(got / 25); if (cn > 0) { coins(S).spend(-cn); P.add('+' + cn + ' coins', W / 2, 140, '#6ee7a0'); }
    if (st.streak > best) { best = st.streak; saveNum('totem-streak', best); } if (st.banked > bestBank) { bestBank = st.banked; saveNum('totem-bank', bestBank); }
    st.phase = 'ready'; SFX.play(mult > 1 ? 'win' : 'success'); SFX.play('step.marble', { delay: 0.25, vol: 0.6 });
  };
  const kd = e => { if (e.code !== 'Space') return; e.preventDefault();
    if (st.phase === 'ready' || st.phase === 'fell') spin();
    else if (st.phase === 'spin') { (st.bankFn || bank)(); st.msg = 'You leave before it decides. Streak ' + st.streak + '.'; st.msgC = PAL.green; } };
  // mouse: a click anywhere is the space key
  const md = e => { if (e.button === 0) { e.preventDefault(); kd({ code: 'Space', preventDefault() {} }); } }; c.addEventListener('pointerdown', md); c.style.cursor = 'pointer'; ov.onClose(() => c.removeEventListener('pointerdown', md));
  addEventListener('keydown', kd); hook({ totem: { get phase() { return st.phase; }, get streak() { return st.streak; }, get banked() { return st.banked; } } });
  ov.onClose(() => { removeEventListener('keydown', kd); hook({ totem: null }); ts.on = true; ts.speed = 30; ts.tilt = 0; ts.wob = 0; clearView(S); S.me.root.visible = meVis; });
  // HUD drawn with the mini-game art kit (art.js): glass stat chips, a framed message strip, an animated banner on
  // results, particles on a bank, screen shake on a topple, a soft warm light over the table
  const fx = particles(), shake = shaker(); let bannerT = -1, bannerS = '', bannerSub = '', bannerC = PAL.gold, potShown = 0;
  const showBanner = (s, sub, c) => { bannerT = 0; bannerS = s; bannerSub = sub; bannerC = c; };
  const oldBank = bank; const bank2 = mult => { const before = st.banked; oldBank(mult); const got = st.banked - before; fx.burst(W / 2, 128, { n: 26 + Math.min(40, got) }); if (mult > 1) { fx.confetti(W); showBanner('DREAMING', 'it never stopped: double pot', PAL.purple); } else showBanner('BANKED', '+' + got + '   streak ' + st.streak, PAL.green); };
  st.bankFn = bank2;
  loop(ov, dt => {
    st.t += dt; st.shake = Math.max(0, st.shake - dt * 2);
    if (st.phase === 'spin') {
      st.pt += dt; st.pot += dt * (4 + st.pt * 3) * (1 + st.streak * 0.25);
      const left = st.T - st.pt;
      if (st.fate === 'fall' && left < 1.4 && !wob) { wob = true; SFX.play('rattle', { vol: 0.5, pitch: 0.7 }); } if (st.pt < dt * 1.5) wob = false;
      if (st.fate === 'fall') { ts.speed = 40 * Math.max(0.25, left / st.T); ts.tilt = left < 1.4 ? (1.4 - left) * 0.18 : 0.01; }
      else { ts.speed = 40; ts.tilt = 0.005; }
      if (left <= 0) {
        if (st.fate === 'fall') { st.phase = 'fell'; ts.on = false; ts.wob = 1.35; st.pot = 0; st.streak = 0; st.shake = 1; shake.kick(7); SFX.play('limbo.topple'); SFX.play('fail', { delay: 0.35, vol: 0.7 }); st.msg = 'It fell. You were awake. Pot lost.'; st.msgC = PAL.red; showBanner('IT FELL', 'you were awake. pot lost', PAL.red); }
        else { st.phase = 'black'; st.black = 0; SFX.play('eerie'); SFX.play('heartbeat', { delay: 0.6, vol: 0.6 }); }
      }
    }
    if (st.phase === 'black') { st.black += dt; if (st.black > 2.2) { bank2(2); st.msg = 'It never stopped. Double pot!'; st.msgC = PAL.goldHi; } }
    potShown += (st.pot - potShown) * Math.min(1, dt * 12);
    x.clearRect(0, 0, W, H);
    x.save(); shake.apply(x, dt);
    // soft lamp light over the table + a faint edge vignette so the HUD sits on the scene, not on a flat box
    glow(x, W / 2, 120, 150, '#ffcf8a', 0.10);
    const v = x.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.7); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(10,6,18,0.45)'); x.fillStyle = v; x.fillRect(0, 0, W, H);
    // left: the live run
    badge(x, 10, 10, 'pot', Math.floor(potShown), { color: PAL.gold, w: 84 });
    badge(x, 98, 10, 'streak', st.streak, { color: PAL.green, w: 70 });
    badge(x, 172, 10, 'banked', st.banked, { color: PAL.cream, w: 78 });
    if (st.phase === 'spin') shine(x, 10, 10, 84, 34, st.t);
    // right: records
    badge(x, W - 162, 10, 'best streak', best, { color: PAL.cyan, w: 76 }); badge(x, W - 82, 10, 'best bank', bestBank, { color: PAL.pink, w: 72 });
    if (st.phase === 'spin') coin(x, 100 + 0, 27, 4, st.t); // tiny coin ticking on the pot chip
    // the wobble warning
    if (st.phase === 'spin' && st.fate === 'fall' && st.T - st.pt < 1.4) { const k = 0.6 + Math.sin(st.t * 22) * 0.4; title(x, 'WOBBLE...', W / 2 + Math.sin(st.t * 30) * 2, 92, { size: 32, color: PAL.red, glow: 'rgba(232,100,90,' + k + ')', glowR: 14 }); }
    // message strip + the action button
    const m = artPanel(x, 36, H - 42, W - 72, 30, { style: 'glass' });
    title(x, st.msg, W / 2 - 36, m.y + 20, { size: 16, body: true, color: st.msgC === '#e8dcc0' ? PAL.cream : st.msgC });
    const label = st.phase === 'spin' ? 'LEAVE' : 'SPIN';
    btn = button(x, W - 108, H - 40, 66, 26, label, { primary: st.phase !== 'spin', hot: hoverBtn });
    fx.draw(x, dt);
    x.restore();
    if (bannerT >= 0) { bannerT += dt; banner(x, W, H, bannerS, bannerSub, bannerT, { color: bannerC }); if (bannerT > 1.6) bannerT = -1; }
    if (st.phase === 'black') { x.fillStyle = `rgba(0,0,0,${Math.min(1, st.black * 2)})`; x.fillRect(0, 0, W, H); if (st.black > 0.8) title(x, '...', W / 2, H / 2, { size: 32, color: '#888' }); }
  });
}
