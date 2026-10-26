// @ts-check
// The totem: close-up on the spinning top, push-your-luck. Watching grows the pot; leave (Space) to bank it and keep
// the streak. If it topples while you watch, the pot is gone (you were awake). Sometimes it never stops: cut to black.
import { SFX } from '../sfx.js';

// top spin-up purr and the topple clatter
SFX.define('limbo.spin', (o, t, p, K) => K.tone(o, t, { type: 'triangle', f: 300 * p, f1: 520 * p, v: 0.06, a: 0.02, d: 0.35 }));
SFX.define('limbo.topple', (o, t, p, K) => { [0, 0.09, 0.16, 0.21].forEach((d, i) => K.tone(o, t + d, { type: 'sine', f: (900 - i * 60) * p, v: 0.08 - i * 0.015, d: 0.05 })); });
import { loop, text, coins } from './util.js';
import { setView, clearView, hideOccluders, worldOf } from './view.js';
import { hook, seeThrough, loadNum, saveNum, pops, panel } from './inception-util.js';

/** @param {any} ctx */
export function startTotem(ctx) {
  const { R, S } = ctx, I = R.inception, ts = I.topSpin; let wob = false;
  const ov = ctx.overlay({ title: 'The Totem', sub: 'is this a dream?', help: '<kbd>space</kbd> spin / leave the room <kbd>esc</kbd> stop' });
  const W = 480, H = 270, { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false; seeThrough(ov, c, 0.08);
  setView(S, { target: worldOf(R, 9.2, 0.82, 4.2), dir: { x: 0.25, y: 0.42, z: 1 }, zoom: 0.55 }); hideOccluders(S); const meVis = S.me.root.visible; S.me.root.visible = false; // the player would stand between camera and top
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
    else if (st.phase === 'spin') { bank(); st.msg = 'You leave before it decides. Streak ' + st.streak + '.'; st.msgC = '#6ee7a0'; } };
  addEventListener('keydown', kd); hook({ totem: { get phase() { return st.phase; }, get streak() { return st.streak; }, get banked() { return st.banked; } } });
  ov.onClose(() => { removeEventListener('keydown', kd); hook({ totem: null }); ts.on = true; ts.speed = 30; ts.tilt = 0; ts.wob = 0; clearView(S); S.me.root.visible = meVis; });
  loop(ov, dt => {
    st.t += dt; st.shake = Math.max(0, st.shake - dt * 2);
    if (st.phase === 'spin') {
      st.pt += dt; st.pot += dt * (4 + st.pt * 3) * (1 + st.streak * 0.25);
      const left = st.T - st.pt;
      if (st.fate === 'fall' && left < 1.4 && !wob) { wob = true; SFX.play('rattle', { vol: 0.5, pitch: 0.7 }); } if (st.pt < dt * 1.5) wob = false;
      if (st.fate === 'fall') { ts.speed = 40 * Math.max(0.25, left / st.T); ts.tilt = left < 1.4 ? (1.4 - left) * 0.18 : 0.01; }
      else { ts.speed = 40; ts.tilt = 0.005; }
      if (left <= 0) {
        if (st.fate === 'fall') { st.phase = 'fell'; ts.on = false; ts.wob = 1.35; st.pot = 0; st.streak = 0; st.shake = 1; SFX.play('limbo.topple'); SFX.play('fail', { delay: 0.35, vol: 0.7 }); st.msg = 'It fell. You were awake. Pot lost.'; st.msgC = '#ff8a7a'; }
        else { st.phase = 'black'; st.black = 0; SFX.play('eerie'); SFX.play('heartbeat', { delay: 0.6, vol: 0.6 }); }
      }
    }
    if (st.phase === 'black') { st.black += dt; if (st.black > 2.2) { bank(2); st.msg = 'It never stopped. Double pot!'; st.msgC = '#ffd98a'; } }
    x.clearRect(0, 0, W, H);
    const sx = (Math.random() - 0.5) * st.shake * 8; x.save(); x.translate(sx, 0);
    panel(x, 8, 8, 150, 62); text(x, 'POT ' + Math.floor(st.pot), 18, 28, { color: '#ffd98a', size: 16 });
    text(x, 'STREAK ' + st.streak, 18, 46, { color: '#6ee7a0' }); text(x, 'BANKED ' + st.banked, 18, 62, { color: '#c8c0e0' });
    panel(x, W - 150, 8, 142, 44); text(x, 'BEST STREAK ' + best, W - 140, 28, { color: '#e8dcc0' }); text(x, 'BEST BANK ' + bestBank, W - 140, 44, { color: '#e8dcc0' });
    panel(x, 40, H - 40, W - 80, 28); text(x, st.msg, W / 2, H - 21, { color: st.msgC, align: 'center' });
    if (st.phase === 'spin' && st.fate === 'fall' && st.T - st.pt < 1.4) text(x, 'wobble...', W / 2, 90, { size: 32, color: '#ff8a7a', align: 'center', shadow: '#000' });
    P.draw(x, dt); x.restore();
    if (st.phase === 'black') { x.fillStyle = `rgba(0,0,0,${Math.min(1, st.black * 2)})`; x.fillRect(0, 0, W, H); if (st.black > 0.8) text(x, '...', W / 2, H / 2, { size: 32, color: '#888', align: 'center' }); }
  });
}
