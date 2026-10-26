// @ts-check
// Go under: recline in the dream chair hooked to the briefcase. Three dream levels, each deeper: the camera tilts and
// time slows (dream clocks run x20 / x400 / x8000). In each level a safe dial spins: SPACE locks its digit in the
// green zone before the kick timer runs out. Crack the 3-digit safe and ride the kick back up. Best time saved.
import { SFX } from '../sfx.js';
import { loop, text, coins } from './util.js';
import { setView, clearView, hideOccluders, worldOf } from './view.js';
import { sitPlayer } from './sit.js';
import { hook, seeThrough, loadNum, saveNum, pops, panel } from './inception-util.js';

// the kick: a soft, low brass swell (two detuned triangles), deliberately quiet and short
SFX.define('limbo.kick', (o, t, p, K) => { K.tone(o, t, { type: 'triangle', f: 73 * p, v: 0.14, a: 0.18, d: 1.1 }); K.tone(o, t, { type: 'triangle', f: 110 * p, v: 0.09, a: 0.2, d: 1.0 }); K.tone(o, t, { type: 'sawtooth', f: 55 * p, v: 0.03, a: 0.25, d: 0.9 }); });
const LV = [{ k: 20, sp: 2.2, zone: 0.55, T: 12 }, { k: 400, sp: 3.0, zone: 0.38, T: 10 }, { k: 8000, sp: 3.9, zone: 0.26, T: 8 }];

/** @param {any} ctx */
export function startUnder(ctx) {
  const { R, S, it } = ctx, ch = R.inception.chair;
  // make sure the player lives in this room's root (act-shot / far travel may still be fading in) before seating
  const rig = S.me.av.rig, rx = rig.rotation.x; let up = () => {};
  const seat = () => { if (S.me.root.parent !== R.root && S.W?.put) S.W.put(S.me, R); up = sitPlayer(S, R, it.slot); S.me.root.position.y = 0.05; rig.rotation.x = -0.35; }; // recline
  seat();
  const stand = () => { rig.rotation.x = rx; up(); };
  const ov = ctx.overlay({ title: 'Go Under', sub: 'a dream within a dream', help: '<kbd>space</kbd> lock the digit <kbd>click</kbd> same <kbd>esc</kbd> wake up' });
  const W = 480, H = 270, { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false; seeThrough(ov, c, 0.12);
  hideOccluders(S); const P = pops();
  const st = { lv: 0, t: 0, lt: 0, a: 0, zoneA: 0, code: [], phase: 'drop', pt: 0, run: 0, fail: false, shake: 0 };
  let best = loadNum('under-best', 0);
  const newZone = () => { st.zoneA = Math.random() * Math.PI * 2; st.a = st.zoneA + Math.PI; st.lt = 0; };
  newZone();
  const view = () => { const tilt = st.phase === 'kick' ? Math.sin(st.pt * 30) * 0.15 : (st.lv + 1) * 0.16 * Math.sin(st.t * 0.4 + 1);
    setView(S, { target: worldOf(R, ch.x, 0.8, ch.z), dir: { x: Math.sin(ch.face) * 0.8, y: 0.6, z: Math.cos(ch.face) * 0.8 }, up: { x: Math.sin(tilt), y: Math.cos(tilt), z: 0 }, zoom: 1.7 - st.lv * 0.12 }); };
  const kick = fail => { st.phase = 'kick'; st.pt = 0; st.fail = fail; st.shake = 1.5; SFX.play('limbo.kick', { jitter: 0 }); SFX.play('splash', { delay: 1.2, vol: 0.5 }); };
  const lock = () => { if (st.phase !== 'play') return; const L = LV[st.lv];
    let d = Math.abs(((st.a - st.zoneA) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
    if (d < L.zone / 2) { const dig = Math.floor((((st.zoneA % 6.283) + 6.283) % 6.283) / 6.283 * 10); st.code.push(dig); P.add('digit ' + dig, W / 2, 110, '#6ee7a0'); SFX.play('snap'); SFX.play('ping', { delay: 0.08, pitch: 1 + st.lv * 0.15 });
      if (st.lv === 2) kick(false); else { st.lv++; st.phase = 'drop'; st.pt = 0; newZone(); SFX.play('whoosh', { delay: 0.2, pitch: 0.8 - st.lv * 0.1 }); SFX.play('eerie', { delay: 0.4, vol: 0.5 }); } }
    else { st.shake = 0.6; st.lt += 1.5; SFX.play('ui.deny'); P.add('-1.5s', W / 2, 110, '#ff8a7a'); } };
  const kd = e => { if (e.code !== 'Space') return; e.preventDefault();
    if (st.phase === 'done') { st.lv = 0; st.code = []; st.run = 0; st.phase = 'drop'; st.pt = 0; newZone(); SFX.play('whoosh', { pitch: 0.8 }); } else lock(); };
  // mouse: a click anywhere is the space key
  const md = e => { if (e.button === 0) { e.preventDefault(); kd({ code: 'Space', preventDefault() {} }); } }; c.addEventListener('pointerdown', md); c.style.cursor = 'pointer'; ov.onClose(() => c.removeEventListener('pointerdown', md));
  addEventListener('keydown', kd);
  hook({ under: { get phase() { return st.phase; }, get lv() { return st.lv; }, get code() { return st.code.join(''); },
    aim() { const d = Math.abs(((st.a - st.zoneA) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI); return st.phase === 'play' && d < LV[st.lv].zone / 4; } } });
  ov.onClose(() => { removeEventListener('keydown', kd); hook({ under: null }); clearView(S); stand(); });
  loop(ov, dt => {
    if (!S.me.sitting || S.me.root.parent !== R.root) seat(); // a pending room fade-in may have stood us up
    st.t += dt; st.pt += dt; st.shake = Math.max(0, st.shake - dt * 2); const L = LV[st.lv];
    if (st.phase === 'drop' && st.pt > 1.2) st.phase = 'play';
    if (st.phase === 'play') { st.run += dt; st.lt += dt; st.a += dt * L.sp; if (st.lt > L.T - 3 && Math.floor(st.lt) !== Math.floor(st.lt - dt)) SFX.play('clock', { vol: 0.5 }); if (st.lt > L.T) kick(true); }
    if (st.phase === 'kick' && st.pt > 2.4) { st.phase = 'done';
      SFX.play(st.fail ? 'fail' : 'win');
      if (!st.fail) { if (!best || st.run < best) { best = st.run; saveNum('under-best', best); } coins(S).spend(-12); P.add('+12 coins', W / 2, 150, '#6ee7a0'); } }
    if (st.phase !== 'done') view();
    x.clearRect(0, 0, W, H); x.save(); x.translate((Math.random() - 0.5) * st.shake * 10, (Math.random() - 0.5) * st.shake * 6);
    // level stack (left)
    panel(x, 8, 8, 132, 96);
    LV.forEach((l, i) => { const on = i === st.lv && st.phase !== 'done'; text(x, (on ? '> ' : '  ') + 'LEVEL ' + (i + 1), 16, 28 + i * 18, { color: on ? '#ffd98a' : i < st.code.length ? '#6ee7a0' : '#8e9ab8' });
      text(x, 'x' + l.k, 120, 28 + i * 18, { color: '#8e9ab8', align: 'right' }); });
    text(x, 'code ' + [0, 1, 2].map(i => st.code[i] ?? '_').join(' '), 16, 94, { color: '#e8dcc0' });
    // kick timer + dream time (right)
    panel(x, W - 150, 8, 142, 74); const left = Math.max(0, L.T - st.lt);
    text(x, 'KICK IN', W - 140, 28, { color: '#8e9ab8' }); text(x, left.toFixed(1) + 's', W - 140, 58, { size: 32, color: left < 3 ? '#ff8a7a' : '#ffd98a' });
    const dm = st.lt * L.k / 60; text(x, 'dream ' + Math.floor(dm / 60) + 'h ' + Math.floor(dm % 60) + 'm', W - 140, 76, { color: '#c8c0e0' });
    if (best) { panel(x, W - 150, 88, 142, 22); text(x, 'best ' + best.toFixed(1) + 's', W - 140, 104, { color: '#e8dcc0' }); }
    else { panel(x, W - 150, 88, 142, 22); text(x, 'best --', W - 140, 104, { color: '#8e9ab8' }); }
    // safe dial (centre bottom)
    if (st.phase === 'play' || st.phase === 'drop') { const cx = W / 2, cy = 190, rr = 46;
      x.fillStyle = 'rgba(20,20,32,0.85)'; x.beginPath(); x.arc(cx, cy, rr + 8, 0, 7); x.fill();
      x.strokeStyle = '#3ddc84'; x.lineWidth = 8; x.beginPath(); x.arc(cx, cy, rr, st.zoneA - L.zone / 2, st.zoneA + L.zone / 2); x.stroke();
      x.strokeStyle = '#c8ccd4'; x.lineWidth = 2; x.beginPath(); x.arc(cx, cy, rr, 0, 7); x.stroke();
      for (let i = 0; i < 10; i++) { const a = i / 10 * 6.283; text(x, String(i), cx + Math.cos(a + 0.31) * (rr - 14), cy + Math.sin(a + 0.31) * (rr - 14) + 5, { color: '#8e9ab8', align: 'center' }); }
      x.strokeStyle = '#ffd98a'; x.lineWidth = 3; x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + Math.cos(st.a) * rr, cy + Math.sin(st.a) * rr); x.stroke(); }
    if (st.phase === 'drop') text(x, 'LEVEL ' + (st.lv + 1), W / 2, 70, { size: 48, title: true, color: '#ffd98a', align: 'center', shadow: '#000' });
    x.restore();
    if (st.phase === 'kick') { // the horn: huge brass bars + flash
      const a = Math.max(0, 1 - st.pt / 2.4); x.fillStyle = `rgba(255,220,160,${a * 0.5})`; x.fillRect(0, 0, W, H);
      for (let i = 0; i < 5; i++) { const h = 20 + 60 * Math.abs(Math.sin(st.pt * 9 + i)); x.fillStyle = `rgba(60,30,10,${a})`; x.fillRect(40 + i * 84, H / 2 - h / 2, 50, h); }
      text(x, 'BWAAAMM', W / 2 + (Math.random() - 0.5) * 8, H / 2 + 14, { size: 48, title: true, color: '#fff2d0', align: 'center', shadow: '#3a1a08' });
      text(x, st.fail ? 'Kicked out early' : 'The kick! Riding up...', W / 2, H / 2 + 44, { color: '#3a1a08', align: 'center' }); }
    if (st.phase === 'done') { panel(x, W / 2 - 120, 160, 240, 70, 0.9);
      text(x, st.fail ? 'Safe still locked.' : 'Safe cracked: ' + st.code.join(''), W / 2, 184, { size: 16, color: st.fail ? '#ff8a7a' : '#6ee7a0', align: 'center' });
      text(x, st.fail ? 'Too slow down there.' : 'Time ' + st.run.toFixed(1) + 's', W / 2, 202, { color: '#e8dcc0', align: 'center' });
      text(x, 'SPACE to go under again', W / 2, 220, { color: '#c8c0e0', align: 'center' }); }
    P.draw(x, dt);
  });
}
