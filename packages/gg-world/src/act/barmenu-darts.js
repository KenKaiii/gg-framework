// @ts-check
// Bar darts, rebuilt on the GX kit (owner-approved concept: showcase/minigames/concepts/darts.html). The camera has
// leaned onto the dartboard on the bar's brick wall; the board opens out of it as the real thing: a sisal board in an
// oak cabinet with chalkboard doors, under the bar's pendant. 3 darts a round; the aim sways with your hand (you've had
// a few), so time the throw. Scoring as before: bull 50, outer bull 25, treble ring x3, double ring x2, off the board 0.
// Best round kept in nr.darts.best (same key as before).
import { gx, svg as S, GX } from './gx.js';
import { SFX } from '../sfx.js';

const ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
const R = { bull: 6.35, outer: 15.9, tIn: 99, tOut: 107, dIn: 162, dOut: 170, edge: 226 };
const C = { black: '#1d1b19', cream: '#e9dcbc', red: '#c33a2e', green: '#1f8a52' };
const WEDGE = Math.PI / 10;
const KEY = 'nr.darts.best';

/** @param {number} x @param {number} y board units, bull at 0,0 */
function scoreAt(x, y) {
  const d = Math.hypot(x, y);
  if (d <= R.bull) return { v: 50, label: 'Bullseye' };
  if (d <= R.outer) return { v: 25, label: 'Outer bull' };
  if (d > R.dOut) return { v: 0, label: 'Wall. Nice.' };
  let a = Math.atan2(x, -y); if (a < 0) a += Math.PI * 2;
  const n = ORDER[Math.round(a / WEDGE) % 20];
  if (d >= R.tIn && d <= R.tOut) return { v: n * 3, label: 'Treble ' + n };
  if (d >= R.dIn) return { v: n * 2, label: 'Double ' + n };
  return { v: n, label: String(n) };
}

const arcPath = (r0, r1, a0, a1) => {
  const p = (r, a) => [Math.sin(a) * r, -Math.cos(a) * r];
  const [x0, y0] = p(r1, a0), [x1, y1] = p(r1, a1), [x2, y2] = p(r0, a1), [x3, y3] = p(r0, a0);
  return `M${x0} ${y0}A${r1} ${r1} 0 0 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 0 0 ${x3} ${y3}Z`;
};

/** A steel dart pointing into the board at 0,0 (flights up-right, pink like the bar's neon). */
function dartArt(g) {
  S('ellipse', { cx: 12, cy: 16, rx: 30, ry: 9, fill: '#000', opacity: 0.35, filter: 'url(#gxd-softS)', transform: 'rotate(30)' }, g);
  S('path', { d: 'M0 0 L10 -12', stroke: '#cfd4da', 'stroke-width': 2.4, 'stroke-linecap': 'round' }, g);
  S('path', { d: 'M8 -10 L30 -38', stroke: 'url(#gxd-barrel)', 'stroke-width': 9, 'stroke-linecap': 'round' }, g);
  for (let k = 0; k < 4; k++) { const t = 0.2 + k * 0.18; S('path', { d: `M${8 + 22 * t - 3} ${-10 - 28 * t - 2} l6 4`, stroke: '#2e3237', 'stroke-width': 1.2, 'stroke-opacity': 0.7 }, g); }
  S('path', { d: 'M30 -38 L50 -64', stroke: '#20242a', 'stroke-width': 4, 'stroke-linecap': 'round' }, g);
  S('path', { d: 'M44 -56 L70 -66 L74 -86 L52 -70 Z', fill: '#ff5fd2' }, g);
  S('path', { d: 'M44 -56 L46 -84 L62 -98 L54 -70 Z', fill: '#d63eae' }, g);
  return g;
}

/** @param {any} ctx */
export function startDarts(ctx) {
  const ov = ctx.overlay({ title: 'Darts', sub: 'the bar', help: '<kbd>mouse</kbd> aim <kbd>click</kbd> / <kbd>space</kbd> throw <kbd>arrows</kbd> nudge the aim' });
  const K = gx(ov), reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const best = () => Number(localStorage.getItem(KEY) || 0);
  const hud = K.hud([{ id: 'score', label: 'Score' }, { id: 'best', label: 'Best round', value: best(), tone: 'gold' }], [{ id: 'darts', label: 'Darts left', value: 3 }]);
  const scene = K.scene({ aspect: 1.42 });

  // ---- the cabinet + board (SVG, drawn once) ----
  const root = S('svg', { viewBox: '-710 -500 1420 1000', width: '100%', height: '100%', role: 'img', 'aria-label': 'Dartboard' }, scene);
  root.style.overflow = 'visible'; root.style.position = 'absolute'; root.style.inset = '0';
  root.innerHTML = `<defs>
    <filter id="gxd-sisal" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.9 0.06" numOctaves="2" seed="4" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.55 0" result="f"/><feComposite in="f" in2="SourceGraphic" operator="in" result="fi"/><feBlend in="SourceGraphic" in2="fi" mode="multiply"/></filter>
    <filter id="gxd-grain"><feTurbulence type="fractalNoise" baseFrequency="0.012 0.32" numOctaves="3" seed="9"/><feColorMatrix type="matrix" values="0 0 0 0 0.1  0 0 0 0 0.05  0 0 0 0 0.02  0 0 0 0.35 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
    <radialGradient id="gxd-light" cx="0.46" cy="0.22" r="0.85"><stop offset="0" stop-color="#fff3dc" stop-opacity="0.32"/><stop offset="0.45" stop-color="#ffd8a0" stop-opacity="0.08"/><stop offset="1" stop-color="#000" stop-opacity="0.42"/></radialGradient>
    <linearGradient id="gxd-oak" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6b4026"/><stop offset="0.5" stop-color="#55311c"/><stop offset="1" stop-color="#3e2312"/></linearGradient>
    <linearGradient id="gxd-oakIn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a1a10"/><stop offset="1" stop-color="#1d120a"/></linearGradient>
    <linearGradient id="gxd-chalk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b3a33"/><stop offset="1" stop-color="#1f2a25"/></linearGradient>
    <radialGradient id="gxd-rim" cx="0.5" cy="0.5" r="0.5"><stop offset="0.93" stop-color="#16120f"/><stop offset="0.985" stop-color="#3a2f27"/><stop offset="1" stop-color="#0b0907"/></radialGradient>
    <linearGradient id="gxd-wire" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4f6f8"/><stop offset="1" stop-color="#8d939b"/></linearGradient>
    <linearGradient id="gxd-barrel" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#5d636b"/><stop offset="0.35" stop-color="#e9edf2"/><stop offset="0.6" stop-color="#9aa1aa"/><stop offset="1" stop-color="#3d4248"/></linearGradient>
    <filter id="gxd-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10"/></filter>
    <filter id="gxd-softS" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>
    <clipPath id="gxd-clip"><circle r="226"/></clipPath></defs>`;
  const cab = S('g', {}, root);
  S('ellipse', { cx: 0, cy: 470, rx: 640, ry: 40, fill: '#000', opacity: 0.45, filter: 'url(#gxd-soft)' }, cab);
  for (const [d, inner] of [['M-342 -330 L-660 -296 L-660 356 L-342 390 Z', 'M-372 -292 L-628 -264 L-628 326 L-372 352 Z'], ['M342 -330 L660 -296 L660 356 L342 390 Z', 'M372 -292 L628 -264 L628 326 L372 352 Z']]) {
    S('path', { d, fill: 'url(#gxd-oak)' }, cab); S('path', { d, fill: '#000', filter: 'url(#gxd-grain)', opacity: 0.8 }, cab);
    S('path', { d: inner, fill: 'url(#gxd-chalk)' }, cab); S('path', { d: inner, fill: 'none', stroke: '#000', 'stroke-opacity': 0.35, 'stroke-width': 4 }, cab);
  }
  S('rect', { x: -340, y: -330, width: 680, height: 720, rx: 18, fill: 'url(#gxd-oak)' }, cab);
  S('rect', { x: -340, y: -330, width: 680, height: 720, rx: 18, fill: '#000', filter: 'url(#gxd-grain)', opacity: 0.9 }, cab);
  S('rect', { x: -312, y: -302, width: 624, height: 664, rx: 10, fill: 'url(#gxd-oakIn)' }, cab);
  S('rect', { x: -312, y: -302, width: 624, height: 664, rx: 10, fill: 'none', stroke: '#000', 'stroke-opacity': 0.5, 'stroke-width': 6 }, cab);
  const chalkL = S('g', { 'font-family': 'Sora', fill: '#e9efe9', 'fill-opacity': 0.88, transform: 'translate(-500 0) skewY(-6)', 'text-anchor': 'middle' }, cab);
  const chalkR = S('g', { 'font-family': 'Sora', fill: '#e9efe9', 'fill-opacity': 0.88, transform: 'translate(500 0) skewY(6)', 'text-anchor': 'middle' }, cab);
  S('circle', { cx: 12, cy: 52, r: 288, fill: '#000', opacity: 0.6, filter: 'url(#gxd-soft)' }, cab);

  const wrap = S('g', { transform: 'scale(1.22)' }, root);
  const board = S('g', {}, wrap);
  S('circle', { r: 232, fill: 'url(#gxd-rim)' }, board);
  const seg = S('g', { 'clip-path': 'url(#gxd-clip)', filter: 'url(#gxd-sisal)' }, board), wires = S('g', {}, board);
  const nums = S('g', { 'font-family': 'Sora', 'font-weight': 700, 'font-size': 30, fill: '#f2efe7', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, board);
  S('circle', { r: R.edge, fill: C.black }, seg);
  ORDER.forEach((n, i) => {
    const a0 = (i - 0.5) * WEDGE, a1 = (i + 0.5) * WEDGE, dark = i % 2 === 0;
    S('path', { d: arcPath(R.outer, R.tIn, a0, a1), fill: dark ? C.black : C.cream }, seg);
    S('path', { d: arcPath(R.tIn, R.tOut, a0, a1), fill: dark ? C.red : C.green }, seg);
    S('path', { d: arcPath(R.tOut, R.dIn, a0, a1), fill: dark ? C.black : C.cream }, seg);
    S('path', { d: arcPath(R.dIn, R.dOut, a0, a1), fill: dark ? C.red : C.green }, seg);
    S('text', { x: Math.sin(i * WEDGE) * 198, y: -Math.cos(i * WEDGE) * 198 }, nums).textContent = String(n);
    const wa = (i - 0.5) * WEDGE;
    S('line', { x1: Math.sin(wa) * R.outer, y1: -Math.cos(wa) * R.outer, x2: Math.sin(wa) * R.dOut, y2: -Math.cos(wa) * R.dOut, stroke: 'url(#gxd-wire)', 'stroke-width': 1.6, 'stroke-opacity': 0.85 }, wires);
  });
  S('circle', { r: R.outer, fill: C.green }, seg); S('circle', { r: R.bull, fill: C.red }, seg);
  for (const r of [R.bull, R.outer, R.tIn, R.tOut, R.dIn, R.dOut]) S('circle', { r, fill: 'none', stroke: 'url(#gxd-wire)', 'stroke-width': 1.8, 'stroke-opacity': 0.9 }, wires);
  S('circle', { r: 232, fill: 'url(#gxd-light)', 'pointer-events': 'none' }, board);
  const stuck = S('g', {}, wrap), fly = S('g', { 'pointer-events': 'none' }, wrap);
  const ret = S('g', { opacity: 0, 'pointer-events': 'none' }, wrap);
  S('circle', { r: 22, fill: 'none', stroke: '#fff', 'stroke-opacity': 0.9, 'stroke-width': 2.5 }, ret);
  S('path', { d: 'M-34 0h20M14 0h20M0 -34v20M0 14v20', stroke: '#fff', 'stroke-width': 2.5, 'stroke-linecap': 'round' }, ret);
  S('circle', { r: 3, fill: GX.error }, ret);
  const hit = S('rect', { x: -260, y: -260, width: 520, height: 520, fill: 'transparent' }, wrap); hit.style.cursor = 'none';

  // ---- state ----
  let total = 0, left = 3, throws = /** @type {{v:number,label:string}[]} */ ([]), playing = false, busy = false;
  let aim = { x: 0, y: 0 }; const t0 = performance.now();
  const writeChalk = () => {
    chalkL.replaceChildren(); chalkR.replaceChildren();
    S('text', { y: -210, 'font-size': 30, 'font-weight': 700 }, chalkL).textContent = 'This round';
    throws.forEach((th, i) => { S('text', { y: -140 + i * 64, 'font-size': 34, 'font-weight': 600 }, chalkL).textContent = String(th.v); });
    S('line', { x1: -70, x2: 70, y1: 70, y2: 70, stroke: '#e9efe9', 'stroke-opacity': 0.7, 'stroke-width': 3, 'stroke-linecap': 'round' }, chalkL);
    S('text', { y: 128, 'font-size': 48, 'font-weight': 800 }, chalkL).textContent = String(total);
    S('text', { y: -210, 'font-size': 30, 'font-weight': 700 }, chalkR).textContent = 'Best';
    S('text', { y: -130, 'font-size': 56, 'font-weight': 800 }, chalkR).textContent = String(best());
    S('text', { y: 0, 'font-size': 22, 'font-weight': 500, 'fill-opacity': 0.7 }, chalkR).textContent = 'Treble 20 = 60';
    S('text', { y: 40, 'font-size': 22, 'font-weight': 500, 'fill-opacity': 0.7 }, chalkR).textContent = 'Bull = 50';
  };
  writeChalk();
  const toBoard = e => { const p = root.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(wrap.getScreenCTM().inverse()); };
  const sway = t => reduce ? { x: 0, y: 0 } : { x: Math.sin(t * 1.3) * 16 + Math.sin(t * 2.9) * 6, y: Math.cos(t * 1.1) * 13 + Math.sin(t * 3.7) * 5 };
  hit.addEventListener('pointermove', e => { const p = toBoard(e); aim = { x: p.x, y: p.y }; });
  hit.addEventListener('pointerenter', () => { if (playing) ret.setAttribute('opacity', '1'); });
  hit.addEventListener('pointerleave', () => ret.setAttribute('opacity', '0'));
  let raf = 0; const tick = now => { const s = sway((now - t0) / 1000); ret.setAttribute('transform', `translate(${aim.x + s.x} ${aim.y + s.y})`); raf = requestAnimationFrame(tick); };
  raf = requestAnimationFrame(tick); ov.onClose(() => cancelAnimationFrame(raf));

  const throwDart = () => {
    if (!playing || busy || left <= 0) return;
    busy = true; SFX.play('swoosh', { vol: 0.4 });
    const s = sway((performance.now() - t0) / 1000), land = { x: aim.x + s.x, y: aim.y + s.y };
    const g = S('g', {}, fly); dartArt(g);
    const from = { x: land.x * 0.4 + 120, y: 520 }, dur = reduce ? 1 : 260, st = performance.now();
    const step = now => {
      const k = Math.min(1, (now - st) / dur), e = 1 - Math.pow(1 - k, 2);
      g.setAttribute('transform', `translate(${from.x + (land.x - from.x) * e} ${from.y + (land.y - from.y) * e - Math.sin(k * Math.PI) * 60}) scale(${2.6 - 1.6 * e})`);
      if (k < 1 && g.isConnected) return requestAnimationFrame(step);
      g.remove(); stick(land);
    };
    requestAnimationFrame(step);
  };
  const stick = land => {
    if (!ov.el.isConnected) return;
    const r = scoreAt(land.x, land.y);
    const g = S('g', { transform: `translate(${land.x} ${land.y})` }, stuck), inner = S('g', {}, g); dartArt(inner);
    if (!reduce) { const st = performance.now(); const w = now => { const t = (now - st) / 1000; inner.setAttribute('transform', `rotate(${Math.exp(-t * 6) * Math.sin(t * 38) * 5})`); if (t < 0.8 && inner.isConnected) requestAnimationFrame(w); }; requestAnimationFrame(w); }
    SFX.play(r.v ? 'ball.clack' : 'ui.deny', { vol: r.v ? 0.6 : 0.4 });
    left -= 1; total += r.v; throws.push(r);
    hud.set('score', total, { count: true }); hud.set('darts', left); writeChalk();
    const m = wrap.getScreenCTM(); K.pop(m.a * land.x + m.e, m.d * land.y + m.f - 50, r.v ? `${r.label}  +${r.v}` : r.label, r.v >= 50 ? 'gold' : r.v >= 40 ? 'up' : undefined);
    if (r.v >= 50 || r.label.startsWith('Treble')) K.swell();
    busy = false;
    if (left === 0) setTimeout(endRound, 900);
  };
  const endRound = () => {
    if (!ov.el.isConnected) return;
    playing = false; ret.setAttribute('opacity', '0');
    const nb = total > best(); if (nb) try { localStorage.setItem(KEY, String(total)); } catch { /* storage off */ }
    hud.set('best', best()); writeChalk();
    const top = throws.reduce((a, b) => (b.v > a.v ? b : a), { v: -1, label: '-' });
    K.result({ title: total >= 180 ? 'One hundred and eighty!' : 'Round over', big: total, best: nb, line: total >= 100 ? 'A ton. The bar noticed.' : total >= 60 ? 'Solid round.' : 'Warm-up round.',
      stats: [[best(), 'Best round'], [top.v > 0 ? top.label : '-', 'Top dart']], again: 'Throw again', onAgain: newRound });
  };
  const newRound = () => { stuck.replaceChildren(); total = 0; left = 3; throws = []; hud.set('score', 0); hud.set('darts', 3); writeChalk(); playing = true; };
  hit.addEventListener('click', throwDart);
  const onKey = e => {
    if (!playing) return;
    if (e.code === 'Space') { e.preventDefault(); throwDart(); }
    const d = 14; if (e.code === 'ArrowLeft') aim.x -= d; if (e.code === 'ArrowRight') aim.x += d; if (e.code === 'ArrowUp') aim.y -= d; if (e.code === 'ArrowDown') aim.y += d;
    if (e.code.startsWith('Arrow')) { e.preventDefault(); ret.setAttribute('opacity', '1'); }
  };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  K.card({ title: 'Darts', text: 'Three darts a round. The aim sways with your hand, so time the throw.', how: [[['Mouse'], 'aim'], [['Click', 'Space'], 'throw']], cta: 'Throw', onGo: newRound });
  /** @type {any} */ (window).__darts = { throwAt: (x, y) => { aim = { x, y }; throwDart(); } }; // dev hook (screenshots)
}
