// @ts-check
// Go under: recline in the dream chair hooked to the briefcase. Three dream levels, each deeper: the camera tilts and
// time slows (dream clocks run x20 / x400 / x8000). In each level a safe dial spins: SPACE locks its digit in the
// green zone before the kick timer runs out. Crack the 3-digit safe and ride the kick back up. Best time saved.
import { SFX } from '../sfx.js';
import { loop, coins } from './util.js';
import { setView, clearView, hideOccluders, worldOf } from './view.js';
import { sitPlayer } from './sit.js';
import { hook, loadNum, saveNum } from './inception-util.js';
import { gx, svg as S2, GX } from './gx.js';
import { FONT } from '../fonts.js';

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
  const ov = ctx.overlay({ title: 'Go Under', sub: 'a dream within a dream', help: '<kbd>space</kbd> / <kbd>click</kbd> lock the digit' });
  const K = gx(ov), reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  hideOccluders(S);
  const st = { lv: 0, t: 0, lt: 0, a: 0, zoneA: 0, code: [], phase: 'drop', pt: 0, run: 0, fail: false };
  let best = loadNum('under-best', 0), flow = 'card';
  const hud = K.hud([{ id: 'lv', label: 'Level', value: '1 / 3', tone: 'gold' }, { id: 'code', label: 'Code', value: '_ _ _', tone: 'up' }],
    [{ id: 'kick', label: 'Kick in', value: '--' }, { id: 'dream', label: 'Dream time', value: '0h 0m', tone: GX.violet }, { id: 'best', label: 'Best', value: best ? best.toFixed(1) + 's' : '--', tone: 'teal' }]);
  const scene = K.scene({ aspect: 1, maxW: 380, lamp: false });
  // the safe dial: brushed steel bezel, numbered face, green window, brass pointer (SVG, built once)
  const root = S2('svg', { viewBox: '-80 -80 160 160', width: '100%', height: '100%', role: 'img', 'aria-label': 'Safe dial' }, scene);
  root.style.cssText = 'position:absolute;inset:0;overflow:visible;cursor:pointer;transition:opacity .4s';
  root.innerHTML = `<defs><linearGradient id="un-bz" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eef1f5"/><stop offset="0.45" stop-color="#8a929e"/><stop offset="0.55" stop-color="#6a727e"/><stop offset="1" stop-color="#262b33"/></linearGradient>
    <radialGradient id="un-face" cx="0.38" cy="0.32" r="0.8"><stop offset="0" stop-color="#3c414d"/><stop offset="1" stop-color="#121419"/></radialGradient>
    <linearGradient id="un-brass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe3a8"/><stop offset="1" stop-color="#a8742c"/></linearGradient>
    <filter id="un-sh" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="un-gl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="un-brush"><feTurbulence type="fractalNoise" baseFrequency="0.02 0.9" numOctaves="2" seed="3"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.25 0"/><feComposite in2="SourceGraphic" operator="in"/></filter></defs>`;
  S2('circle', { cx: 2, cy: 6, r: 72, fill: '#000', opacity: 0.55, filter: 'url(#un-sh)' }, root);
  S2('circle', { r: 70, fill: 'url(#un-bz)' }, root); S2('circle', { r: 70, fill: '#000', filter: 'url(#un-brush)' }, root);
  S2('circle', { r: 58, fill: 'url(#un-face)', stroke: '#0b0c10', 'stroke-width': 1.2 }, root);
  const R0 = 50, zone = S2('path', { fill: 'none', stroke: GX.success, 'stroke-width': 7, 'stroke-linecap': 'round', filter: 'url(#un-gl)' }, root);
  for (let i = 0; i < 40; i++) { const a = i / 40 * 6.283, l = i % 4 ? 3 : 6; S2('line', { x1: Math.cos(a) * 57, y1: Math.sin(a) * 57, x2: Math.cos(a) * (57 - l), y2: Math.sin(a) * (57 - l), stroke: i % 4 ? '#c8ccd4' : '#eef1f5', 'stroke-opacity': i % 4 ? 0.5 : 1, 'stroke-width': 0.8 }, root); }
  for (let i = 0; i < 10; i++) { const a = i / 10 * 6.283 + 0.31; const t = S2('text', { x: Math.cos(a) * 40, y: Math.sin(a) * 40, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'Sora', 'font-weight': 600, 'font-size': 9, fill: '#d6dae1' }, root); t.textContent = String(i); }
  const ptr = S2('g', {}, root);
  S2('path', { d: 'M0 -3 L52 0 L0 3 Z', fill: 'url(#un-brass)', stroke: '#3a2408', 'stroke-width': 0.6 }, ptr);
  S2('circle', { r: 8, fill: 'url(#un-brass)', stroke: '#3a2408', 'stroke-width': 0.8 }, root); S2('circle', { cx: -2, cy: -2, r: 2.5, fill: '#fff6dc' }, root);
  // big level title / kick text + full-screen tint (deeper = darker; kick = brass flash)
  const tint = document.createElement('div'); tint.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;transition:background .3s'; ov.el.prepend(tint);
  const big = document.createElement('div'); big.style.cssText = `position:fixed;left:0;right:0;top:30%;z-index:4;text-align:center;pointer-events:none;font-family:${FONT.app};color:#fff;text-shadow:0 4px 30px rgba(0,0,0,.6);transition:opacity .4s;opacity:0`;
  big.innerHTML = '<div style="display:inline-block;padding:16px 28px 18px;border-radius:18px;background:rgba(14,12,24,.82);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);box-shadow:0 0 0 1px rgba(255,255,255,.08)"><div class="h" style="font-size:clamp(30px,5.5vh,52px);line-height:1;font-weight:800;letter-spacing:-.01em"></div><div class="s" style="margin-top:10px;font-size:18px;font-weight:600;color:' + GX.text2 + '"></div></div>'; ov.el.appendChild(big);
  const bigH = /** @type {HTMLElement} */ (big.querySelector('.h')), bigS = /** @type {HTMLElement} */ (big.querySelector('.s'));
  const say = (h, sub, c = GX.lamp) => { big.style.top = Math.max(0, root.getBoundingClientRect().top + root.getBoundingClientRect().height * 0.3) + 'px'; bigH.textContent = h; bigS.textContent = sub; bigH.style.color = c; big.style.opacity = '1'; };
  const dialAt = () => { const b = root.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; };
  const arc = (a0, a1) => `M${Math.cos(a0) * R0} ${Math.sin(a0) * R0}A${R0} ${R0} 0 0 1 ${Math.cos(a1) * R0} ${Math.sin(a1) * R0}`;
  const newZone = () => { st.zoneA = Math.random() * Math.PI * 2; st.a = st.zoneA + Math.PI; st.lt = 0; const z = LV[st.lv].zone; zone.setAttribute('d', arc(st.zoneA - z / 2, st.zoneA + z / 2)); };
  newZone();
  const view = () => { const tilt = st.phase === 'kick' ? (reduce ? 0 : Math.sin(st.pt * 30) * 0.15) : (st.lv + 1) * 0.16 * Math.sin(st.t * 0.4 + 1);
    setView(S, { target: worldOf(R, ch.x, 0.8, ch.z), dir: { x: Math.sin(ch.face) * 0.8, y: 0.6, z: Math.cos(ch.face) * 0.8 }, up: { x: Math.sin(tilt), y: Math.cos(tilt), z: 0 }, zoom: 1.7 - st.lv * 0.12 }); };
  const kick = fail => { st.phase = 'kick'; st.pt = 0; st.fail = fail; SFX.play('limbo.kick', { jitter: 0 }); SFX.play('splash', { delay: 1.2, vol: 0.5 }); say('The kick', fail ? 'Kicked out early' : 'Riding up...', '#fff2d0'); K.swell(); };
  const codeStr = () => [0, 1, 2].map(i => st.code[i] ?? '_').join(' ');
  const lock = () => { if (st.phase !== 'play') return; const L = LV[st.lv];
    let d = Math.abs(((st.a - st.zoneA) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
    const [cx, cy] = dialAt();
    if (d < L.zone / 2) { const dig = Math.floor((((st.zoneA % 6.283) + 6.283) % 6.283) / 6.283 * 10); st.code.push(dig); hud.set('code', codeStr()); K.pop(cx, cy - 40, 'Digit ' + dig, 'up'); SFX.play('snap'); SFX.play('ping', { delay: 0.08, pitch: 1 + st.lv * 0.15 });
      if (st.lv === 2) kick(false); else { st.lv++; st.phase = 'drop'; st.pt = 0; newZone(); SFX.play('whoosh', { delay: 0.2, pitch: 0.8 - st.lv * 0.1 }); SFX.play('eerie', { delay: 0.4, vol: 0.5 }); } }
    else { st.lt += 1.5; SFX.play('ui.deny'); K.pop(cx, cy - 40, '-1.5s', 'bad'); } };
  const restart = () => { st.lv = 0; st.code = []; st.run = 0; st.phase = 'drop'; st.pt = 0; newZone(); hud.set('code', codeStr()); flow = 'play'; SFX.play('whoosh', { pitch: 0.8 }); };
  K.card({ title: 'Go Under', text: 'A dream within a dream within a dream. Lock each safe digit in the green before the kick. Three levels: time slows, the dial speeds up.', how: [[['Space', 'Click'], 'lock the digit']], cta: 'Go under', onGo: restart });
  const kd = e => { if (e.code !== 'Space' || flow !== 'play') return; e.preventDefault(); if (st.phase !== 'done') lock(); };
  // mouse: a click anywhere (not on a button) is the space key
  const md = e => { if (e.button === 0 && flow === 'play' && !(e.target instanceof Element && e.target.closest('button'))) { e.preventDefault(); kd({ code: 'Space', preventDefault() {} }); } }; ov.el.addEventListener('pointerdown', md);
  addEventListener('keydown', kd);
  hook({ under: { get phase() { return st.phase; }, get lv() { return st.lv; }, get code() { return st.code.join(''); },
    aim() { const d = Math.abs(((st.a - st.zoneA) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI); return st.phase === 'play' && d < LV[st.lv].zone / 4; } } });
  ov.onClose(() => { removeEventListener('keydown', kd); hook({ under: null }); clearView(S); stand(); });
  loop(ov, dt => {
    if (!S.me.sitting || S.me.root.parent !== R.root) seat(); // a pending room fade-in may have stood us up
    if (flow !== 'play') { if (st.phase !== 'done') view(); st.t += dt; return; }
    st.t += dt; st.pt += dt; const L = LV[st.lv];
    if (st.phase === 'drop') { say('Level ' + (st.lv + 1), 'Dream clock x' + L.k); if (st.pt > 1.2) { st.phase = 'play'; big.style.opacity = '0'; } }
    if (st.phase === 'play') { st.run += dt; st.lt += dt; st.a += dt * L.sp; if (st.lt > L.T - 3 && Math.floor(st.lt) !== Math.floor(st.lt - dt)) SFX.play('clock', { vol: 0.5 }); if (st.lt > L.T) kick(true); }
    if (st.phase === 'kick' && st.pt > 2.4) { st.phase = 'done'; flow = 'end'; big.style.opacity = '0';
      SFX.play(st.fail ? 'fail' : 'win');
      const nb = !st.fail && (!best || st.run < best);
      if (!st.fail) { if (nb) { best = st.run; saveNum('under-best', best); } coins(S).spend(-12); const [cx, cy] = dialAt(); K.pop(cx, cy, '+12 coins', 'up'); hud.set('best', best.toFixed(1) + 's'); }
      K.result(st.fail ? { title: 'Still locked', big: st.code.length + ' / 3', line: 'Kicked out early. Too slow down there.', stats: [[best ? best.toFixed(1) + 's' : '--', 'Best']], again: 'Go under again', onAgain: restart }
        : { title: 'Safe cracked', big: st.run.toFixed(1) + 's', best: nb, line: 'Code ' + st.code.join('') + '. You ride the kick up.', stats: [[st.code.join(''), 'Code'], [best.toFixed(1) + 's', 'Best'], ['+12', 'Coins']], again: 'Go under again', onAgain: restart }); }
    if (st.phase !== 'done') view();
    ptr.setAttribute('transform', `rotate(${(st.a * 180 / Math.PI).toFixed(2)})`);
    root.style.opacity = st.phase === 'play' || st.phase === 'drop' ? '1' : '0';
    const left = Math.max(0, L.T - st.lt), dm = st.lt * L.k / 60;
    hud.set('lv', (st.lv + 1) + ' / 3'); hud.set('kick', left.toFixed(1) + 's', { tone: left < 3 ? 'bad' : GX.text }); hud.set('dream', Math.floor(dm / 60) + 'h ' + Math.floor(dm % 60) + 'm');
    const ka = st.phase === 'kick' ? Math.max(0, 1 - st.pt / 2.4) : 0;
    tint.style.background = ka > 0 ? `rgba(255,220,160,${(ka * 0.5).toFixed(2)})` : `rgba(8,6,20,${(0.1 + st.lv * 0.1).toFixed(2)})`;
  });
}
