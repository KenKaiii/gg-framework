// @ts-check
// Soap-making (GX kit: a steel pot, mould and knife on a planked workbench): render (hold to heat into the zone), mix (alternate ←/→), pour (hold to the line), cut (space on the marks).
// Quality -> bars -> coins via coins(S). Daily order from the date (scent + bars wanted) pays a bonus once a day.
import { loop, coins, rng } from './util.js';
import { SFX } from '../sfx.js';
import { load, save, today } from './fightclub-util.js';
import { gx, svg as S, GX } from './gx.js';

const SCENTS = [['rose', '#f2a6c0'], ['lavender', '#b8a0e8'], ['mint', '#9ee8c0'], ['lemon', '#f0e08a'], ['tar', '#8a7a70']];
const STEPS = ['RENDER', 'MIX', 'POUR', 'CUT'];
const HELP = ['hold <kbd>space</kbd>/<kbd>mouse</kbd> to heat, release in the green', 'tap <kbd>←</kbd> <kbd>→</kbd> (or click left / right half) alternately to stir', 'hold <kbd>space</kbd>/<kbd>mouse</kbd> to pour, stop at the line', 'press <kbd>space</kbd>/<kbd>click</kbd> when the knife is on a mark'];

/** @param {any} ctx */
export function startSoap(ctx) {
  const ov = ctx.overlay({ title: 'Paper St. Soap Co.', sub: 'the workbench', help: HELP[0] });
  const K = gx(ov), reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const day = today(), r = rng(day * 7 + 3);
  const order = { scent: SCENTS[Math.floor(r() * SCENTS.length)], bars: 6 + Math.floor(r() * 5) };
  const rec = load('soap', { day: 0, orderDone: false, batches: 0, best: 0, total: 0 });
  if (rec.day !== day) { rec.day = day; rec.orderDone = false; rec.batches = 0; }
  const wallet = coins(ctx.S);
  const hud = K.hud([{ id: 'step', label: 'Step', value: '1 / 4 Render' }, { id: 'best', label: 'Best batch', value: rec.best, tone: 'gold' }], [{ id: 'batches', label: 'Batches today', value: `${rec.batches} / 5` }]);
  const scene = K.scene({ aspect: 16 / 9 });
  const root = S('svg', { viewBox: '0 0 1600 900', width: '100%', height: '100%' }, scene); root.style.position = 'absolute'; root.style.inset = '0'; root.style.cursor = 'pointer'; root.style.touchAction = 'none';
  root.innerHTML = `<defs><filter id="fp-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10"/></filter>
    <filter id="fp-grain"><feTurbulence type="fractalNoise" baseFrequency="0.008 0.25" numOctaves="3" seed="4"/><feColorMatrix values="0 0 0 0 .1  0 0 0 0 .05  0 0 0 0 .02  0 0 0 .5 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
    <linearGradient id="fp-wood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9a6a44"/><stop offset=".1" stop-color="#6a4630"/><stop offset="1" stop-color="#2a1a10"/></linearGradient>
    <linearGradient id="fp-steel" x1="0" x2="1"><stop offset="0" stop-color="#4a5058"/><stop offset=".3" stop-color="#c8d0d8"/><stop offset=".55" stop-color="#7a828a"/><stop offset="1" stop-color="#30363e"/></linearGradient>
    <linearGradient id="fp-blade" x1="0" x2="1"><stop offset="0" stop-color="#f0f4f8"/><stop offset="1" stop-color="#7a828a"/></linearGradient>
    <radialGradient id="fp-light" cx=".5" cy=".2" r=".8"><stop offset="0" stop-color="#ffd29a" stop-opacity=".3"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></radialGradient>
    <radialGradient id="fp-fire" cx=".5" cy="1" r=".8"><stop offset="0" stop-color="#ffe0a0"/><stop offset=".4" stop-color="#ff8a3a"/><stop offset="1" stop-color="#ff5a2a" stop-opacity="0"/></radialGradient></defs>
    <rect x="0" y="600" width="1600" height="300" rx="16" fill="url(#fp-wood)"/><rect x="0" y="600" width="1600" height="300" rx="16" fill="#000" filter="url(#fp-grain)"/>
    <path d="M0 604 H1600" stroke="#c09060" stroke-width="4"/><g stroke="#000" stroke-opacity=".3" stroke-width="3"><path d="M320 606 V900M700 606V900M1090 606V900M1420 606V900"/></g>`;
  const T = (o, p) => S('text', { 'font-family': 'Sora', ...o }, p);
  // order slip, top right
  const slip = S('g', { transform: 'translate(1360 120) rotate(2.5)' }, root);
  S('rect', { x: -150, y: -80, width: 300, height: 160, rx: 4, fill: '#000', opacity: 0.4, filter: 'url(#fp-soft)' }, slip);
  S('rect', { x: -150, y: -84, width: 300, height: 160, rx: 4, fill: '#f6efdc' }, slip); S('rect', { x: -44, y: -98, width: 88, height: 28, fill: '#c8c4b4', opacity: 0.8, transform: 'rotate(-3)' }, slip);
  T({ y: -34, 'text-anchor': 'middle', 'font-size': 22, 'font-weight': 700, fill: '#5a4a30', 'letter-spacing': 2 }, slip).textContent = "TODAY'S ORDER";
  T({ y: 6, 'text-anchor': 'middle', 'font-size': 32, 'font-weight': 800, fill: '#7a2040' }, slip).textContent = `${order.bars}+ bars, ${order.scent[0]}`;
  const slipS = T({ y: 48, 'text-anchor': 'middle', 'font-size': 24, 'font-weight': 700 }, slip);
  // steps + scent, top left
  const tabs = STEPS.map((n, i) => { const g = S('g', { transform: `translate(${60 + i * 190} 60)` }, root); const b = S('rect', { width: 176, height: 56, rx: 12 }, g); const t = T({ x: 88, y: 37, 'text-anchor': 'middle', 'font-size': 22, 'font-weight': 700 }, g); t.textContent = n[0] + n.slice(1).toLowerCase(); return { b, t }; });
  const scentG = S('g', { transform: 'translate(60 160)', style: 'cursor:pointer' }, root); const sw = S('rect', { width: 34, height: 34, rx: 8 }, scentG); const scT = T({ x: 48, y: 26, 'font-size': 26, 'font-weight': 600 }, scentG);
  const stage = S('g', {}, root);
  const G = [0, 1, 2, 3, 4].map(() => S('g', {}, stage));
  const pot = (p, x, y, w, h) => { const g = S('g', { transform: `translate(${x} ${y})` }, p); S('rect', { x: -w / 2 - 26, y: 30, width: 26, height: 14, rx: 6, fill: '#2a2a30' }, g); S('rect', { x: w / 2, y: 30, width: 26, height: 14, rx: 6, fill: '#2a2a30' }, g);
    S('path', { d: `M${-w / 2} 0 H${w / 2} V${h - 16} Q${w / 2} ${h} ${w / 2 - 16} ${h} H${-w / 2 + 16} Q${-w / 2} ${h} ${-w / 2} ${h - 16}Z`, fill: 'url(#fp-steel)' }, g);
    const top = S('ellipse', { cx: 0, cy: 0, rx: w / 2 - 6, ry: 14, fill: '#e8d8a0' }, g); S('ellipse', { cx: 0, cy: 0, rx: w / 2, ry: 16, fill: 'none', stroke: '#e0e6ec', 'stroke-width': 5 }, g); return { g, top }; };
  // 0 render: pot over flames + heat meter
  S('ellipse', { cx: 800, cy: 610, rx: 220, ry: 20, fill: '#000', opacity: 0.5, filter: 'url(#fp-soft)' }, G[0]);
  const fireG = S('g', {}, G[0]); const flames = [0, 1, 2, 3, 4].map(i => S('path', { fill: 'url(#fp-fire)' }, fireG));
  S('rect', { x: 640, y: 580, width: 320, height: 16, rx: 6, fill: '#2a2a30' }, G[0]);
  pot(G[0], 800, 330, 300, 230);
  const steam = [0, 1, 2, 3].map(i => S('circle', { cx: 730 + i * 46, r: 12, fill: '#fff', opacity: 0 }, G[0]));
  const meter = S('g', { transform: 'translate(1180 260)' }, G[0]); S('rect', { x: -30, y: -50, width: 100, height: 390, rx: 16, fill: '#1f2226', opacity: 0.85 }, meter);
  T({ x: 20, y: -16, 'text-anchor': 'middle', 'font-size': 20, 'font-weight': 700, fill: GX.muted }, meter).textContent = 'Heat';
  S('rect', { x: 0, y: 0, width: 40, height: 320, rx: 8, fill: '#0a0808' }, meter); const zone = S('rect', { x: 0, width: 40, rx: 4, fill: GX.success, opacity: 0.8 }, meter);
  const needle = S('rect', { x: -10, width: 60, height: 6, rx: 3, fill: GX.error }, meter);
  // 1 mix: pot + paddle + trace bar
  S('ellipse', { cx: 800, cy: 610, rx: 220, ry: 20, fill: '#000', opacity: 0.5, filter: 'url(#fp-soft)' }, G[1]);
  const mixPot = pot(G[1], 800, 380, 320, 210);
  const paddle = S('g', { transform: 'translate(800 390)' }, G[1]); S('rect', { x: -9, y: -240, width: 18, height: 250, rx: 8, fill: '#b08a5a' }, paddle); S('rect', { x: -9, y: -240, width: 5, height: 250, fill: '#e0b888' }, paddle);
  S('rect', { x: 520, y: 690, width: 560, height: 100, rx: 16, fill: '#1f2226', opacity: 0.85 }, G[1]); S('rect', { x: 550, y: 712, width: 500, height: 20, rx: 10, fill: '#0a0808' }, G[1]);
  const trace = S('rect', { x: 550, y: 712, height: 20, rx: 10, fill: GX.success }, G[1]); const traceT = T({ x: 800, y: 772, 'text-anchor': 'middle', 'font-size': 24, 'font-weight': 700, fill: GX.text }, G[1]);
  // 2 pour: mould + line + tilted pot + stream
  S('rect', { x: 470, y: 470, width: 660, height: 200, rx: 10, fill: '#000', opacity: 0.5, filter: 'url(#fp-soft)' }, G[2]);
  S('rect', { x: 460, y: 460, width: 680, height: 200, rx: 10, fill: '#7a4a2a' }, G[2]); S('rect', { x: 460, y: 460, width: 680, height: 200, rx: 10, fill: '#000', filter: 'url(#fp-grain)' }, G[2]);
  S('rect', { x: 480, y: 470, width: 640, height: 172, fill: '#2a1a10' }, G[2]);
  const fillR = S('rect', { x: 480, width: 640 }, G[2]);
  const lineL = S('rect', { x: 446, width: 708, height: 6, rx: 3, fill: '#fff' }, G[2]); const lineT = T({ x: 1170, 'font-size': 24, 'font-weight': 700, fill: '#fff' }, G[2]); lineT.textContent = 'Line';
  const stream = S('rect', { x: 792, y: 300, width: 16, rx: 8 }, G[2]);
  const potP = S('g', {}, G[2]); const pourPot = pot(potP, 0, 0, 160, 110);
  // 3 cut: slab + marks + knife
  S('rect', { x: 470, y: 470, width: 660, height: 150, rx: 10, fill: '#000', opacity: 0.5, filter: 'url(#fp-soft)' }, G[3]);
  const slab = S('rect', { x: 460, y: 440, width: 680, height: 150, rx: 8 }, G[3]); S('rect', { x: 460, y: 440, width: 680, height: 10, rx: 4, fill: '#fff', opacity: 0.35 }, G[3]);
  S('rect', { x: 460, y: 560, width: 680, height: 30, fill: '#000', opacity: 0.2 }, G[3]);
  const marks = S('g', {}, G[3]), cutsG = S('g', {}, G[3]);
  const knife = S('g', {}, G[3]); S('path', { d: 'M-10 -60 H14 V120 L0 150 L-10 120Z', fill: 'url(#fp-blade)' }, knife); S('rect', { x: -16, y: -150, width: 32, height: 96, rx: 10, fill: '#6a3a20' }, knife); S('rect', { x: -16, y: -150, width: 8, height: 96, fill: '#8a5a3a' }, knife);
  // 4 end: stacked bars
  const barsG = G[4];
  /** @type {any} */ let st; let playing = false;
  const reset = () => { st = { step: 0, q: [], heat: 0, zone: 0.55 + r() * 0.2, hold: false, stir: 0, last: '', stirT: 6, fill: 0, line: 0.7 + r() * 0.15, knife: 0, kdir: 1, cuts: [], marks: [0.2, 0.4, 0.6, 0.8], end: false, bars: 0, pay: 0, scent: order.scent, t: 0, flash: 0 }; ov.setHelp(HELP[0]);
    marks.replaceChildren(); for (const m of st.marks) S('path', { d: `M${460 + m * 680} 420 v24`, stroke: '#1a1210', 'stroke-width': 5, 'stroke-linecap': 'round' }, marks); cutsG.replaceChildren(); barsG.replaceChildren(); };
  reset();
  const at = (x, y) => { const b = root.getBoundingClientRect(); return /** @type {[number, number]} */ ([b.left + b.width * x / 1600, b.top + b.height * y / 900]); };
  const next = (/** @type {number} */ q) => { st.q.push(q); if (q > 0.6) { if (q > 0.85) K.swell(); } K.pop(...at(800, 260), q > 0.85 ? 'Perfect' : q > 0.6 ? 'Good' : q > 0.3 ? 'Meh' : 'Yikes', q > 0.6 ? 'up' : q > 0.3 ? 'gold' : 'bad'); st.flash = 0.6; st.step++; SFX.play(q > 0.85 ? 'success' : q > 0.6 ? 'score' : q > 0.3 ? 'tick' : 'ui.deny');
    if (st.step >= 4) finish(); else ov.setHelp(HELP[st.step]); };
  const finish = () => {
    const q = st.q.reduce((a, b) => a + b, 0) / 4; st.bars = Math.max(1, Math.round(q * 12)); st.end = true;
    const paid = rec.batches < 5; st.pay = paid ? st.bars * 3 : 0; let bonus = 0;
    if (paid && !rec.orderDone && st.scent === order.scent && st.bars >= order.bars) { bonus = 40; rec.orderDone = true; }
    st.bonus = bonus; st.pay += bonus; SFX.play(bonus ? 'win' : 'bubble', { delay: 0.3 }); if (st.pay) wallet.spend(-st.pay, null);
    rec.batches++; rec.best = Math.max(rec.best, st.bars); rec.total += st.bars; save('soap', rec);
    hud.set('best', rec.best); hud.set('batches', `${rec.batches} / 5`);
    for (let i = 0; i < st.bars; i++) { const bx = 470 + (i % 6) * 112, by = 520 - Math.floor(i / 6) * 70; S('rect', { x: bx, y: by, width: 100, height: 60, rx: 8, fill: st.scent[1] }, barsG); S('rect', { x: bx, y: by + 44, width: 100, height: 16, rx: 6, fill: '#000', opacity: 0.2 }, barsG); S('rect', { x: bx + 8, y: by + 6, width: 60, height: 6, rx: 3, fill: '#fff', opacity: 0.45 }, barsG); }
    if (st.bars >= 9 || bonus) K.swell();
    playing = false;
    setTimeout(() => { if (!ov.el.isConnected) return; K.result({ title: st.bars + ' bars', big: st.bars, line: st.pay ? 'Sold +' + st.pay + ' coins' + (st.bonus ? ' (order bonus!)' : '') : 'Buyers are tapped out today (5 batches).',
      stats: [[`+${st.pay}`, 'Coins'], [rec.best, 'Best batch'], [rec.total, 'Lifetime bars']], again: 'Next batch', onAgain: () => { const s = st.scent; reset(); st.scent = s; playing = true; } }); }, 700);
  };
  const kd = (/** @type {KeyboardEvent} */ e) => {
    if (!playing) return;
    if (/Arrow|Space/.test(e.code)) e.preventDefault();
    if (st.end) return;
    if (st.step === 0 && st.t < 0.01) return;
    if (st.step === 0 && st.q.length === 0 && (e.code === 'ArrowLeft' || e.code === 'ArrowRight') && st.heat === 0) { const i = SCENTS.indexOf(st.scent); st.scent = SCENTS[(i + (e.code === 'ArrowLeft' ? 4 : 1)) % 5]; SFX.play('ui.select'); return; }
    if ((st.step === 0 || st.step === 2) && e.code === 'Space' && !st.hold) { st.hold = true; SFX.play(st.step ? 'pour' : 'fire', { vol: 0.6 }); }
    if (st.step === 1 && (e.code === 'ArrowLeft' || e.code === 'ArrowRight') && e.code !== st.last) { st.last = e.code; st.stir = Math.min(1, st.stir + 0.045); SFX.play('gurgle', { vol: 0.35, pitch: e.code === 'ArrowLeft' ? 0.9 : 1.1 }); }
    if (st.step === 3 && e.code === 'Space') { const d = Math.min(...st.marks.map(m => Math.abs(m - st.knife))); st.cuts.push(st.knife); SFX.play('snap', { vol: 0.6 }); K.pop(...at(460 + st.knife * 680, 400), d < 0.03 ? 'clean' : 'wonky', d < 0.03 ? 'up' : 'gold');
      S('rect', { x: 460 + st.knife * 680 - 3, y: 440, width: 6, height: 150, fill: '#1a1210', opacity: 0.8 }, cutsG);
      if (st.cuts.length >= 4) { const err = st.cuts.reduce((a, c) => a + Math.min(...st.marks.map(m => Math.abs(m - c))), 0) / 4; next(Math.max(0, 1 - err * 12)); } }
  };
  const ku = (/** @type {KeyboardEvent} */ e) => {
    if (e.code !== 'Space' || !st.hold) return; st.hold = false;
    if (st.step === 0 && st.heat > 0) next(Math.max(0, 1 - Math.abs(st.heat - st.zone) * 6));
    else if (st.step === 2 && st.fill > 0) next(Math.max(0, 1 - Math.abs(st.fill - st.line) * 7));
  };
  addEventListener('keydown', kd); addEventListener('keyup', ku); ov.onClose(() => { removeEventListener('keydown', kd); removeEventListener('keyup', ku); });
  // mouse mirrors the keys: hold = space (heat / pour), click = space (cut), left / right half = ←/→ (stir), click the scent line = next scent (before heating)
  const fake = code => ({ code, preventDefault() {} });
  const pd = (/** @type {PointerEvent} */ e) => { if (e.button !== 0 || !playing) return; e.preventDefault(); const b = root.getBoundingClientRect(), px = (e.clientX - b.left) / b.width * 1600, py = (e.clientY - b.top) / b.height * 900;
    if (st.step === 0 && st.q.length === 0 && st.heat === 0 && py >= 150 && py <= 210 && px <= 600) kd(/** @type {any} */ (fake('ArrowRight')));
    else if (st.step === 1) kd(/** @type {any} */ (fake(px < 800 ? 'ArrowLeft' : 'ArrowRight')));
    else kd(/** @type {any} */ (fake('Space'))); };
  const pu = () => ku(/** @type {any} */ (fake('Space')));
  root.addEventListener('pointerdown', pd); addEventListener('pointerup', pu); ov.onClose(() => removeEventListener('pointerup', pu));
  loop(ov, (dt, t) => {
    st.t += dt; st.flash = Math.max(0, st.flash - dt);
    if (!st.end && playing) {
      if (st.step === 0 && st.hold) st.heat = Math.min(1, st.heat + dt * 0.5);
      if (st.step === 1) { st.stirT -= dt; st.stir = Math.max(0, st.stir - dt * 0.05); if (st.stirT <= 0 || st.stir >= 1) next(st.stir); }
      if (st.step === 2 && st.hold) { st.fill = Math.min(1, st.fill + dt * 0.4); if (st.fill >= 1) { st.hold = false; next(0.1); } }
      if (st.step === 3) { st.knife += st.kdir * dt * 0.55; if (st.knife > 0.95 || st.knife < 0.05) st.kdir *= -1; }
    }
    const col = st.scent[1], view = st.end ? 4 : st.step;
    G.forEach((g, i) => g.style.display = i === view ? '' : 'none');
    tabs.forEach((tb, i) => { const on = i === st.step && !st.end, done = i < st.step || st.end; tb.b.setAttribute('fill', on ? GX.primary : done ? 'rgba(127,220,149,.18)' : 'rgba(21,23,26,.7)'); tb.t.setAttribute('fill', on ? GX.onPrimary : done ? GX.success : GX.muted); });
    hud.set('step', st.end ? 'Done' : `${st.step + 1} / 4 ${STEPS[st.step][0] + STEPS[st.step].slice(1).toLowerCase()}`);
    scentG.style.display = st.end ? 'none' : ''; sw.setAttribute('fill', col); scT.setAttribute('fill', col); scT.textContent = 'Scent: ' + st.scent[0] + (st.step === 0 && st.heat === 0 ? '   ← → to change' : '');
    slipS.textContent = rec.orderDone ? 'Delivered' : '+40 coins bonus'; slipS.setAttribute('fill', rec.orderDone ? '#2a7a4a' : '#8a5a10');
    if (view === 0) { const h = st.heat; flames.forEach((f, i) => { const fh = 40 + h * 90 + (reduce ? 0 : Math.sin(t * 9 + i * 2) * 12), x0 = 680 + i * 60; f.setAttribute('d', `M${x0} 584 Q${x0 + 30} ${584 - fh * 1.6} ${x0 + 60} 584Z`); f.setAttribute('opacity', String(0.35 + h * 0.65)); });
      steam.forEach((s, i) => { const k = (t * 0.6 + i * 0.25) % 1; s.setAttribute('cy', String(310 - k * 140)); s.setAttribute('opacity', h > 0.3 ? String((1 - k) * h * 0.5) : '0'); });
      zone.setAttribute('y', String(320 - (st.zone + 0.08) * 320)); zone.setAttribute('height', String(0.16 * 320)); needle.setAttribute('y', String(320 - h * 320 - 3)); }
    else if (view === 1) { mixPot.top.setAttribute('fill', col); paddle.setAttribute('transform', `translate(800 390) rotate(${st.last === 'ArrowLeft' ? -24 : 24})`); trace.setAttribute('width', String(500 * st.stir)); traceT.textContent = `Trace ${Math.round(st.stir * 100)}%  ·  ${Math.max(0, st.stirT).toFixed(1)} s`; }
    else if (view === 2) { const fy = 642 - st.fill * 172; fillR.setAttribute('y', String(fy)); fillR.setAttribute('height', String(st.fill * 172)); fillR.setAttribute('fill', col);
      const ly = 642 - st.line * 172; lineL.setAttribute('y', String(ly - 3)); lineT.setAttribute('y', String(ly + 8));
      stream.setAttribute('fill', col); stream.setAttribute('height', String(Math.max(0, fy - 300))); stream.style.display = st.hold ? '' : 'none';
      potP.setAttribute('transform', `translate(720 230) rotate(${st.hold ? 34 : 12})`); pourPot.top.setAttribute('fill', col); }
    else if (view === 3) { slab.setAttribute('fill', col); knife.setAttribute('transform', `translate(${460 + st.knife * 680} 400)`); }
  });
  K.card({ title: 'Paper St. Soap Co.', text: `Render, mix, pour, cut, sell the bars. Land each step in its zone. Today: ${order.bars}+ ${order.scent[0]} bars pays a +40 coins bonus.`, how: [[['Space'], 'hold / tap'], [['←', '→'], 'stir + scent'], [['Mouse'], 'hold / click, left / right half']], cta: 'Start a batch', onGo: () => { playing = true; } });
}
