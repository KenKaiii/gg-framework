// @ts-check
// Dream architect: "a maze that takes one minute to solve". A date-seeded circular maze that slowly rotates (the
// dream folds); reach the centre against the clock. Best time saved per day and overall; under a minute pays coins.
import { SFX } from '../sfx.js';
import { loop, coins, rng } from './util.js';
import { hook, loadNum, saveNum, today } from './inception-util.js';
import { gx, svg as S, GX } from './gx.js';

// soft stone slide when a ring step lands
SFX.define('limbo.slide', (o, t, p, K) => K.hiss(o, t, { ft: 'bandpass', f: 500 * p, f1: 350 * p, q: 2, v: 0.07, a: 0.005, d: 0.08 }));
const RINGS = 8, secs = r => (r < 2 ? 8 : r < 5 ? 16 : 32);

/** Build the maze: open[r][s] = { cw: bool, in: bool } passages. @param {number} seed */
export function makeMaze(seed) {
  const g = rng(seed), open = [], seen = [];
  for (let r = 0; r < RINGS; r++) { open.push(Array.from({ length: secs(r) }, () => ({ cw: false, in: false }))); seen.push(Array(secs(r)).fill(false)); }
  const nb = (r, s) => { const n = secs(r), out = [[r, (s + 1) % n, 'cw'], [r, (s + n - 1) % n, 'ccw']];
    if (r > 0) out.push([r - 1, Math.floor(s * secs(r - 1) / n), 'in']);
    if (r < RINGS - 1) { const k = secs(r + 1) / n; for (let i = 0; i < k; i++) out.push([r + 1, s * k + i, 'out']); } return out; };
  const stack = [[RINGS - 1, Math.floor(g() * secs(RINGS - 1))]]; seen[stack[0][0]][stack[0][1]] = true;
  while (stack.length) { const [r, s] = stack[stack.length - 1]; const c = nb(r, s).filter(([a, b]) => !seen[a][b]);
    if (!c.length) { stack.pop(); continue; } const [a, b, d] = c[Math.floor(g() * c.length)]; seen[a][b] = true;
    if (d === 'cw') open[r][s].cw = true; else if (d === 'ccw') open[a][b].cw = true; else if (d === 'in') open[r][s].in = true; else open[a][b].in = true;
    stack.push([a, b]); }
  // outward moves take the first open child; if a cell opens to both children, join the siblings so both stay reachable
  for (let r = 0; r < RINGS - 1; r++) { const k = secs(r + 1) / secs(r); if (k < 2) continue;
    for (let s = 0; s < secs(r); s++) if (open[r + 1][s * 2].in && open[r + 1][s * 2 + 1].in) open[r + 1][s * 2].cw = true; }
  return { open, start: [RINGS - 1, Math.floor(g() * 32)] };
}

/** @param {any} ctx */
export function startMaze(ctx) {
  const ov = ctx.overlay({ title: 'Dream Architect', sub: 'design a maze that takes one minute to solve', help: '<kbd>&larr;&rarr;</kbd> around <kbd>&uarr;</kbd> inward <kbd>&darr;</kbd> outward <kbd>click</kbd> step toward the pointer' });
  const K = gx(ov), reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const day = today(), M = makeMaze(day.seed);
  const st = { r: M.start[0], s: M.start[1], t: 0, run: 0, done: false, paid: loadNum('maze-paid-' + day.key), trail: [] };
  let bestDay = loadNum('maze-day-' + day.key, 0), bestAll = loadNum('maze-best', 0), phase = 'card';
  const fmt = v => (v ? v.toFixed(1) + 's' : '--');
  const hud = K.hud([{ id: 'time', label: 'Time  (par 60s)', value: '0.0s' }, { id: 'today', label: 'Today', value: fmt(bestDay) }, { id: 'best', label: 'Best', value: fmt(bestAll), tone: 'teal' }],
    [{ id: 'maze', label: 'Maze #' + day.key, value: st.paid ? 'Paid today' : '15 coins', tone: st.paid ? 'up' : 'gold' }]);
  const scene = K.scene({ aspect: 1, maxW: 760 });
  const R0 = 14, RW = 14;
  const root = S('svg', { viewBox: '-150 -150 300 300', width: '100%', height: '100%', role: 'img', 'aria-label': 'Circular maze' }, scene);
  root.style.cssText = 'position:absolute;inset:0;overflow:visible;cursor:pointer';
  root.innerHTML = `<defs><radialGradient id="mz-bp" r="0.5"><stop offset="0" stop-color="#2c4a86"/><stop offset="0.7" stop-color="#182850"/><stop offset="1" stop-color="#0d1530"/></radialGradient>
    <radialGradient id="mz-core" r="0.5"><stop offset="0" stop-color="#fff3d0"/><stop offset="0.5" stop-color="${GX.lamp}" stop-opacity="0.8"/><stop offset="1" stop-color="${GX.lamp}" stop-opacity="0"/></radialGradient>
    <pattern id="mz-grid" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M8 0H0V8" fill="none" stroke="#b4c8ff" stroke-opacity="0.08" stroke-width="0.4"/></pattern>
    <filter id="mz-glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="mz-sh" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="8"/></filter></defs>`;
  S('circle', { cy: 8, r: 146, fill: '#000', opacity: 0.5, filter: 'url(#mz-sh)' }, root);
  S('circle', { r: 145, fill: 'url(#mz-bp)', stroke: '#9fb6ff', 'stroke-opacity': 0.35, 'stroke-width': 1.2 }, root);
  S('circle', { r: 145, fill: 'url(#mz-grid)' }, root);
  for (let k = 1; k < 3; k++) S('circle', { r: R0 + RINGS * RW + k * 6, fill: 'none', stroke: '#b4c8ff', 'stroke-opacity': 0.12, 'stroke-width': 0.6 }, root);
  const coreGlow = S('circle', { r: R0 + 8, fill: 'url(#mz-core)' }, root);
  const spin = S('g', {}, root), wallsGlow = S('g', { stroke: '#9fb8ff', 'stroke-opacity': 0.22, 'stroke-width': 5, 'stroke-linecap': 'round', fill: 'none' }, spin), walls = S('g', { stroke: '#dbe6ff', 'stroke-width': 1.6, 'stroke-linecap': 'round', fill: 'none' }, spin); /* glow = a wide faint stroke: a live blur on a spinning group re-rasterises every frame */
  const trailG = S('g', {}, spin), me = S('g', {}, spin);
  S('circle', { r: 9, fill: GX.success, opacity: 0.25 }, me); S('circle', { r: 4.6, fill: GX.success, stroke: '#0b2a18', 'stroke-width': 1 }, me); S('circle', { cx: -1.4, cy: -1.4, r: 1.2, fill: '#fff' }, me);
  // ring 0 opens into the centre at one sector only
  const core = M.start[1] % 8;
  const ang = (s, r) => (s / secs(r)) * Math.PI * 2;
  const P2 = (r, a) => `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
  let d = '';
  for (let r = 0; r < RINGS; r++) { const n = secs(r), ri = R0 + r * RW, ro = ri + RW;
    for (let s = 0; s < n; s++) { const a0 = ang(s, r), a1 = ang(s + 1, r), o = M.open[r][s];
      if (!(r === 0 ? s === core : o.in)) d += `M${P2(ri, a0)}A${ri} ${ri} 0 0 1 ${P2(ri, a1)}`;
      if (!o.cw) d += `M${P2(ri, a1)}L${P2(ro, a1)}`;
      if (r === RINGS - 1 && s !== M.start[1]) d += `M${P2(ro, a0)}A${ro} ${ro} 0 0 1 ${P2(ro, a1)}`; } }
  S('path', { d }, wallsGlow); S('path', { d }, walls);
  const pos = (r, s) => { const a = ang(s + 0.5, r), rr = R0 + (r + 0.5) * RW; return [Math.cos(a) * rr, Math.sin(a) * rr]; };
  const drawTrail = () => { trailG.replaceChildren(); st.trail.forEach(([r, s], i) => { const [x, y] = pos(r, s); S('circle', { cx: x, cy: y, r: 1.8, fill: GX.success, opacity: (i / st.trail.length) * 0.55 }, trailG); }); };
  const meAt = () => { const [x, y] = pos(st.r, st.s); me.setAttribute('transform', `translate(${x} ${y})`); };
  meAt();
  const move = d => { if (st.done) return; const { r, s } = st, n = secs(r), o = M.open;
    if (d === 'cw' && o[r][s].cw) st.s = (s + 1) % n;
    else if (d === 'ccw' && o[r][(s + n - 1) % n].cw) st.s = (s + n - 1) % n;
    else if (d === 'in') { if (r === 0) { win(); return; } if (o[r][s].in) { st.r = r - 1; st.s = Math.floor(s * secs(r - 1) / n); } else return bump(); }
    else if (d === 'out' && r < RINGS - 1) { const k = secs(r + 1) / n; let ok = false; for (let i = 0; i < k; i++) if (o[r + 1][s * k + i].in) { st.r = r + 1; st.s = s * k + i; ok = true; break; } if (!ok) return bump(); }
    else if (d === 'cw' || d === 'ccw' || d === 'out') return bump();
    SFX.play('limbo.slide', { pitch: d === 'in' ? 1.25 : d === 'out' ? 0.85 : 1, jitter: 0.08 }); st.trail.push([st.r, st.s]); if (st.trail.length > 40) st.trail.shift(); drawTrail(); meAt(); };
  const bump = () => { SFX.play('thud', { vol: 0.5 }); if (!reduce) me.animate?.([{ opacity: 1 }, { opacity: 0.4 }, { opacity: 1 }], { duration: 260 }); };
  const centre = () => { const b = root.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; };
  const win = () => { if (st.s !== core) return bump(); st.done = true; phase = 'end'; const tm = st.run; SFX.play('magic'); SFX.play(tm < 60 ? 'win' : 'success', { delay: 0.3 });
    const nb = !bestAll || tm < bestAll;
    if (!bestDay || tm < bestDay) { bestDay = tm; saveNum('maze-day-' + day.key, tm); } if (!bestAll || tm < bestAll) { bestAll = tm; saveNum('maze-best', tm); }
    hud.set('today', fmt(bestDay)); hud.set('best', fmt(bestAll));
    const [cx, cy] = centre(); K.pop(cx, cy - 20, tm.toFixed(1) + 's', 'gold'); K.swell();
    let got = 0; if (tm < 60 && !st.paid) { coins(ctx.S).spend(-15); st.paid = 1; got = 15; saveNum('maze-paid-' + day.key, 1); K.pop(cx, cy + 14, '+15 coins', 'up'); hud.set('maze', 'Paid today', { tone: 'up' }); }
    setTimeout(() => { if (!ov.el.isConnected) return; K.result({ title: tm < 60 ? 'Elegant' : 'Too slow', big: tm.toFixed(1) + 's', best: nb, line: tm < 60 ? 'Dream bigger.' : 'A minute, Ariadne. Again?',
      stats: [[fmt(bestDay), 'Today'], [fmt(bestAll), 'Best'], ['+' + got, 'Coins']], again: 'Walk it again', onAgain: again }); }, 700); };
  const kd = e => { const m = { ArrowLeft: 'ccw', ArrowRight: 'cw', ArrowUp: 'in', ArrowDown: 'out', KeyA: 'ccw', KeyD: 'cw', KeyW: 'in', KeyS: 'out' }[e.code];
    if (phase !== 'play') return; if (m) { e.preventDefault(); move(m); } };
  const again = () => { st.r = M.start[0]; st.s = M.start[1]; st.run = 0; st.done = false; st.trail = []; drawTrail(); meAt(); phase = 'play'; SFX.play('page'); };
  K.card({ title: 'Dream Architect', text: 'Reach the glowing centre of today\'s maze. Under 60 seconds pays 15 coins.', how: [[['←', '→'], 'around'], [['↑'], 'in'], [['↓'], 'out'], [['Click'], 'step toward the pointer']], cta: 'Enter the maze', onGo: () => { phase = 'play'; } });
  addEventListener('keydown', kd); ov.onClose(() => { removeEventListener('keydown', kd); hook({ maze: null }); });
  // test hook (tools/review-inception.mjs): BFS from the current cell to the centre, as arrow-key codes
  hook({ maze: { get done() { return st.done; }, get time() { return st.run; }, solve() {
    const key = (r, s) => r + ':' + s, prev = new Map([[key(st.r, st.s), null]]), q = [[st.r, st.s]], o = M.open; let end = null;
    while (q.length) { const [r, s] = q.shift(); if (r === 0 && s === core) { end = [r, s]; break; } const n = secs(r), nx = [];
      if (o[r][s].cw) nx.push([r, (s + 1) % n, 'ArrowRight']); if (o[r][(s + n - 1) % n].cw) nx.push([r, (s + n - 1) % n, 'ArrowLeft']);
      if (r > 0 && o[r][s].in) nx.push([r - 1, Math.floor(s * secs(r - 1) / n), 'ArrowUp']);
      if (r < RINGS - 1) { const k = secs(r + 1) / n; for (let i = 0; i < k; i++) if (o[r + 1][s * k + i].in) { nx.push([r + 1, s * k + i, 'ArrowDown']); break; } }
      for (const [a, b, c] of nx) if (!prev.has(key(a, b))) { prev.set(key(a, b), [r, s, c]); q.push([a, b]); } }
    const out = ['ArrowUp']; let cur = end; while (cur) { const p = prev.get(key(cur[0], cur[1])); if (!p) break; out.unshift(p[2]); cur = p; } return out; } } });
  // mouse: click steps one cell toward the pointer (inner ring = in, outer = out, same ring = around); click again when done
  let rotNow = 0;
  const md = e => { if (e.button !== 0 || phase !== 'play' || st.done) return; e.preventDefault();
    const pt = root.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; const q = pt.matrixTransform(root.getScreenCTM().inverse()), px = q.x, py = q.y;
    const ring = Math.floor((Math.hypot(px, py) - R0) / RW);
    if (ring < st.r) { move('in'); return; } if (ring > st.r) { move('out'); return; }
    const n = secs(st.r), a = ((Math.atan2(py, px) - rotNow) / (Math.PI * 2) * n % n + n) % n, d = ((a - (st.s + 0.5)) % n + n * 1.5) % n - n / 2;
    if (Math.abs(d) >= 0.5) move(d > 0 ? 'cw' : 'ccw'); };
  root.addEventListener('pointerdown', md);
  let lastT = '';
  loop(ov, dt => {
    st.t += dt; if (!st.done && phase === 'play') st.run += dt;
    rotNow = reduce ? 0 : st.t * 0.06; // the dream slowly folds
    spin.setAttribute('transform', `rotate(${(rotNow * 180 / Math.PI).toFixed(2)})`);
    coreGlow.setAttribute('opacity', String(0.75 + Math.sin(st.t * 2) * 0.2));
    const tt = st.run.toFixed(1) + 's'; if (tt !== lastT) { lastT = tt; hud.set('time', tt, { tone: st.run < 60 ? GX.text : 'bad' }); }
  });
}
