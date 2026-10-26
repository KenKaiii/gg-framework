// @ts-check
// Go under: recline in the dream chair hooked to the briefcase. Three dream levels, each deeper: the camera tilts and
// time slows (dream clocks run x20 / x400 / x8000). In each level a safe dial spins: SPACE locks its digit in the
// green zone before the kick timer runs out. Crack the 3-digit safe and ride the kick back up. Best time saved.
import { SFX } from '../sfx.js';
import { loop, coins } from './util.js';
import { setView, clearView, hideOccluders, worldOf } from './view.js';
import { sitPlayer } from './sit.js';
import { hook, seeThrough, loadNum, saveNum, pops } from './inception-util.js';
import { PAL, panel, badge, title, glow, particles, shaker, rr } from './art.js';
import { cardFlow } from './fightclub-ui.js';

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
    if (d < L.zone / 2) { const dig = Math.floor((((st.zoneA % 6.283) + 6.283) % 6.283) / 6.283 * 10); st.code.push(dig); fx.burst(W / 2, 190, { n: 20, colors: [PAL.green, PAL.goldHi, '#fff'] }); P.add('digit ' + dig, W / 2, 110, '#6ee7a0'); SFX.play('snap'); SFX.play('ping', { delay: 0.08, pitch: 1 + st.lv * 0.15 });
      if (st.lv === 2) kick(false); else { st.lv++; st.phase = 'drop'; st.pt = 0; newZone(); SFX.play('whoosh', { delay: 0.2, pitch: 0.8 - st.lv * 0.1 }); SFX.play('eerie', { delay: 0.4, vol: 0.5 }); } }
    else { st.shake = 0.6; sh.kick(5); st.lt += 1.5; SFX.play('ui.deny'); P.add('-1.5s', W / 2, 110, '#ff8a7a'); } };
  const restart = () => { st.lv = 0; st.code = []; st.run = 0; st.phase = 'drop'; st.pt = 0; newZone(); SFX.play('whoosh', { pitch: 0.8 }); };
  const fx = particles(), sh = shaker();
  const F = cardFlow(ov, c, W, H, { style: 'glass', accent: PAL.gold, start: restart, again: restart });
  F.setCard({ title: 'GO UNDER', sub: 'a dream within a dream within a dream', lines: ['Lock each safe digit in the green before the kick.', 'Three levels; time slows, the dial speeds up.'], chips: [['[space]', 'lock the digit', '|', '[click]', 'same']] });
  const kd = e => { if (e.code !== 'Space' || F.phase !== 'play') return; e.preventDefault(); if (st.phase !== 'done') lock(); };
  // mouse: a click anywhere is the space key
  const md = e => { if (e.button === 0 && F.phase === 'play') { e.preventDefault(); kd({ code: 'Space', preventDefault() {} }); } }; c.addEventListener('pointerdown', md); c.style.cursor = 'pointer'; ov.onClose(() => c.removeEventListener('pointerdown', md));
  addEventListener('keydown', kd);
  hook({ under: { get phase() { return st.phase; }, get lv() { return st.lv; }, get code() { return st.code.join(''); },
    aim() { const d = Math.abs(((st.a - st.zoneA) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI); return st.phase === 'play' && d < LV[st.lv].zone / 4; } } });
  ov.onClose(() => { removeEventListener('keydown', kd); hook({ under: null }); clearView(S); stand(); });
  loop(ov, dt => {
    if (!S.me.sitting || S.me.root.parent !== R.root) seat(); // a pending room fade-in may have stood us up
    if (F.phase !== 'play') { if (st.phase !== 'done') view(); st.t += dt; x.clearRect(0, 0, W, H); F.draw(x, dt); return; }
    st.t += dt; st.pt += dt; st.shake = Math.max(0, st.shake - dt * 2); const L = LV[st.lv];
    if (st.phase === 'drop' && st.pt > 1.2) st.phase = 'play';
    if (st.phase === 'play') { st.run += dt; st.lt += dt; st.a += dt * L.sp; if (st.lt > L.T - 3 && Math.floor(st.lt) !== Math.floor(st.lt - dt)) SFX.play('clock', { vol: 0.5 }); if (st.lt > L.T) kick(true); }
    if (st.phase === 'kick' && st.pt > 2.4) { st.phase = 'done';
      SFX.play(st.fail ? 'fail' : 'win');
      if (!st.fail) { if (!best || st.run < best) { best = st.run; saveNum('under-best', best); } coins(S).spend(-12); P.add('+12 coins', W / 2, 150, '#6ee7a0'); }
      F.finish(st.fail ? { title: 'STILL LOCKED', sub: 'kicked out early. too slow down there', color: PAL.red, stats: [['digits', st.code.length, PAL.gold, '/3'], ['best', best, PAL.cyan, 's']] }
        : { title: 'SAFE CRACKED', sub: 'code ' + st.code.join('') + '. you ride the kick up', color: PAL.green, win: true, stats: [['time', st.run, PAL.gold, 's'], ['best', best, PAL.cyan, 's'], ['coins', 12, PAL.green, 'c']] }); }
    if (st.phase !== 'done') view();
    x.clearRect(0, 0, W, H);
    const v = x.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, W * 0.7); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, `rgba(8,6,20,${0.35 + st.lv * 0.12})`); x.fillStyle = v; x.fillRect(0, 0, W, H); // deeper = darker edges
    x.save(); if (st.shake > 0.5) { sh.kick(st.shake * 5); } sh.apply(x, dt);
    // level stack (left)
    panel(x, 8, 8, 140, 100, { style: 'glass' });
    LV.forEach((l, i) => { const on = i === st.lv && st.phase !== 'done', done = i < st.code.length, y = 30 + i * 20;
      if (on) { x.fillStyle = 'rgba(245,189,99,0.18)'; x.fillRect(12, y - 14, 132, 18); }
      title(x, (done ? '+ ' : on ? '> ' : '  ') + 'LEVEL ' + (i + 1), 16, y, { size: 16, body: true, align: 'left', color: on ? PAL.gold : done ? PAL.green : PAL.dim });
      title(x, 'x' + l.k, 140, y, { size: 16, body: true, align: 'right', color: PAL.purple }); });
    title(x, 'CODE', 16, 98, { size: 16, body: true, align: 'left', color: PAL.dim });
    for (let i = 0; i < 3; i++) { const X = 62 + i * 26; x.fillStyle = PAL.ink; x.fillRect(X, 84, 22, 18); x.fillStyle = i < st.code.length ? '#1c3a2a' : '#22202c'; x.fillRect(X + 1, 85, 20, 16); title(x, String(st.code[i] ?? '_'), X + 11, 99, { size: 16, color: i < st.code.length ? PAL.green : PAL.dim }); }
    // kick timer + dream time (right)
    const left = Math.max(0, L.T - st.lt); panel(x, W - 150, 8, 142, 78, { style: 'glass' });
    title(x, 'KICK IN', W - 140, 28, { size: 16, body: true, align: 'left', color: PAL.dim });
    title(x, left.toFixed(1) + 's', W - 140, 60, { size: 32, align: 'left', color: left < 3 ? PAL.red : PAL.gold, glow: left < 3 ? PAL.red : undefined });
    const dm = st.lt * L.k / 60; title(x, 'dream ' + Math.floor(dm / 60) + 'h ' + Math.floor(dm % 60) + 'm', W - 140, 78, { size: 16, body: true, align: 'left', color: PAL.purple });
    badge(x, W - 150, 92, 'best', best ? best.toFixed(1) + 's' : '--', { w: 142, color: PAL.cyan });
    // the safe dial: brushed steel bezel, numbered face, green window, brass pointer
    if (st.phase === 'play' || st.phase === 'drop') { const cx = W / 2, cy = 190, r0 = 46;
      x.fillStyle = 'rgba(0,0,0,0.45)'; x.beginPath(); x.arc(cx + 2, cy + 4, r0 + 12, 0, 7); x.fill();
      let g = x.createLinearGradient(cx - r0, cy - r0, cx + r0, cy + r0); g.addColorStop(0, '#d8dee6'); g.addColorStop(0.5, '#6a727e'); g.addColorStop(1, '#2a3038'); x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r0 + 11, 0, 7); x.fill();
      x.strokeStyle = PAL.ink; x.lineWidth = 1.5; x.stroke();
      g = x.createRadialGradient(cx - 10, cy - 12, 4, cx, cy, r0 + 4); g.addColorStop(0, '#3a3e4a'); g.addColorStop(1, '#14161e'); x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r0 + 4, 0, 7); x.fill();
      glow(x, cx + Math.cos(st.zoneA) * r0, cy + Math.sin(st.zoneA) * r0, 24, '#3ddc84', 0.35);
      x.strokeStyle = '#3ddc84'; x.lineWidth = 7; x.beginPath(); x.arc(cx, cy, r0, st.zoneA - L.zone / 2, st.zoneA + L.zone / 2); x.stroke();
      for (let i = 0; i < 40; i++) { const a = i / 40 * 6.283, l = i % 4 ? 3 : 6; x.strokeStyle = i % 4 ? 'rgba(200,204,212,0.5)' : '#e8ecf2'; x.lineWidth = 1; x.beginPath(); x.moveTo(cx + Math.cos(a) * (r0 + 3), cy + Math.sin(a) * (r0 + 3)); x.lineTo(cx + Math.cos(a) * (r0 + 3 - l), cy + Math.sin(a) * (r0 + 3 - l)); x.stroke(); }
      for (let i = 0; i < 10; i++) { const a = i / 10 * 6.283; title(x, String(i), cx + Math.cos(a + 0.31) * (r0 - 14), cy + Math.sin(a + 0.31) * (r0 - 14) + 5, { size: 16, body: true, color: '#c8ccd4' }); }
      x.strokeStyle = PAL.ink; x.lineWidth = 5; x.lineCap = 'round'; x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + Math.cos(st.a) * (r0 + 2), cy + Math.sin(st.a) * (r0 + 2)); x.stroke();
      x.strokeStyle = PAL.gold; x.lineWidth = 3; x.stroke(); x.lineCap = 'butt';
      x.fillStyle = PAL.goldD; x.beginPath(); x.arc(cx, cy, 7, 0, 7); x.fill(); x.fillStyle = PAL.goldHi; x.beginPath(); x.arc(cx - 2, cy - 2, 2.5, 0, 7); x.fill(); }
    if (st.phase === 'drop') { const k = Math.min(1, st.pt / 0.4); title(x, 'LEVEL ' + (st.lv + 1), W / 2, 76, { size: 48, color: PAL.gold, glow: PAL.purple, glowR: 16 }); if (k < 1) { x.fillStyle = `rgba(10,6,20,${(1 - k) * 0.7})`; x.fillRect(0, 0, W, H); } }
    fx.draw(x, dt);
    x.restore();
    if (st.phase === 'kick') { // the horn: huge brass bars + flash
      const a = Math.max(0, 1 - st.pt / 2.4); x.fillStyle = `rgba(255,220,160,${a * 0.5})`; x.fillRect(0, 0, W, H);
      for (let i = 0; i < 5; i++) { const h = 20 + 60 * Math.abs(Math.sin(st.pt * 9 + i)); x.fillStyle = `rgba(60,30,10,${a})`; x.fillRect(40 + i * 84, H / 2 - h / 2, 50, h); }
      title(x, 'BWAAAMM', W / 2 + Math.sin(st.pt * 40) * 3, H / 2 + 14, { size: 48, color: '#fff2d0', ink: '#3a1a08' });
      title(x, st.fail ? 'Kicked out early' : 'The kick! Riding up...', W / 2, H / 2 + 44, { size: 16, body: true, color: PAL.cream }); }
    P.draw(x, dt); F.draw(x, dt);
  });
}
