// @ts-check
// Basement whiteboard: "The Plan", rebuilt on GX. A real whiteboard in SVG: brushed aluminium frame, glossy white
// surface with ghost smudges, marker handwriting in Sora, tick marks drawn as marker strokes, a marker tray.
// ←→ rewrite step 2, space ticks the next step off; the 3rd tick stamps SHIPPED and counts in nr.plan.done (same key).
import { gx, svg as S, GX } from './gx.js';
import { SFX } from '../sfx.js';
const STEP2 = ['???', 'blame the intern', 'rewrite it in Rust', 'add more AI', 'pray to CI', 'git push --force', 'it works on my machine'];
/** @param {any} ctx */
export function startBoard(ctx) {
  const ov = ctx.overlay({ title: 'The Plan', sub: 'basement whiteboard', help: '<kbd>←→</kbd> / <kbd>click step 2</kbd> rewrite step 2 <kbd>space</kbd> / <kbd>click</kbd> tick off a step' });
  const K = gx(ov), reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const best = () => Number(localStorage.getItem('nr.plan.done') || 0);
  const hud = K.hud([{ id: 'done', label: 'Plans shipped', value: best(), tone: 'gold' }]);
  const scene = K.scene({ aspect: 1.75 });
  const root = S('svg', { viewBox: '0 0 1050 600', width: '100%', height: '100%', role: 'img', 'aria-label': 'Whiteboard' }, scene);
  Object.assign(root.style, { position: 'absolute', inset: '0', overflow: 'visible' });
  root.innerHTML = `<defs>
    <linearGradient id="gxb-al" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eef1f5"/><stop offset="0.5" stop-color="#a9afb8"/><stop offset="1" stop-color="#6c727c"/></linearGradient>
    <linearGradient id="gxb-wb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fdfdfb"/><stop offset="1" stop-color="#e2e0d8"/></linearGradient>
    <linearGradient id="gxb-gl" x1="0" y1="0" x2="1" y2="0.6"><stop offset="0" stop-color="#fff" stop-opacity="0.75"/><stop offset="0.35" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <filter id="gxb-soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter>
    <filter id="gxb-smudge" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>
    <filter id="gxb-ink"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="1" seed="2"/><feDisplacementMap in="SourceGraphic" scale="2.2"/></filter></defs>
    <rect x="30" y="40" width="990" height="520" rx="10" fill="#000" opacity="0.5" filter="url(#gxb-soft)"/>
    <rect x="20" y="16" width="1010" height="540" rx="10" fill="url(#gxb-al)"/>
    <rect x="34" y="30" width="982" height="512" rx="4" fill="url(#gxb-wb)"/>
    <g fill="#8090b0" opacity="0.12" filter="url(#gxb-smudge)"><ellipse cx="160" cy="120" rx="90" ry="18" transform="rotate(-8 160 120)"/><ellipse cx="760" cy="420" rx="120" ry="22"/><ellipse cx="880" cy="140" rx="70" ry="16" transform="rotate(6 880 140)"/><ellipse cx="420" cy="480" rx="100" ry="14"/></g>
    <path d="M34 30 H520 L34 300 Z" fill="url(#gxb-gl)" opacity="0.6"/>
    <rect x="300" y="552" width="450" height="22" rx="5" fill="url(#gxb-al)"/><rect x="300" y="570" width="450" height="5" rx="2" fill="#000" opacity="0.3"/>`;
  for (const [mx, c] of [[350, '#2a7a4a'], [470, '#c8322a'], [590, '#2a55b8']]) { S('rect', { x: mx, y: 541, width: 92, height: 15, rx: 7, fill: c }, root); S('rect', { x: mx + 74, y: 541, width: 18, height: 15, rx: 4, fill: '#f2f2f2' }, root); S('rect', { x: mx + 4, y: 543, width: 60, height: 3, rx: 1.5, fill: '#fff', opacity: 0.3 }, root); }
  const ink = S('g', { filter: 'url(#gxb-ink)', 'font-family': 'Sora' }, root);
  const T = S('text', { x: 525, y: 130, 'text-anchor': 'middle', 'font-size': 64, 'font-weight': 800, fill: '#1b1b2f', 'letter-spacing': -1 }, ink); T.textContent = 'The Plan';
  S('path', { d: 'M380 152 Q520 166 670 148', stroke: '#1b1b2f', 'stroke-width': 6, fill: 'none', 'stroke-linecap': 'round' }, ink);
  const lines = [0, 1, 2].map(n => S('text', { x: 190, y: 260 + n * 100, 'font-size': 46, 'font-weight': 600, fill: n === 1 ? '#a8261a' : '#1b3a6a' }, ink));
  const ticks = [0, 1, 2].map(n => S('path', { d: `M110 ${238 + n * 100} l22 24 l38 -56`, stroke: '#2a7a4a', 'stroke-width': 9, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', pathLength: 1, 'stroke-dasharray': 1, 'stroke-dashoffset': 1 }, ink));
  for (const p of ticks) p.style.transition = reduce ? 'none' : 'stroke-dashoffset .35s cubic-bezier(.3,.7,.4,1)';
  const stamp = S('g', { transform: 'translate(820 420) rotate(-12)', opacity: 0 }, ink); stamp.style.transition = 'opacity .3s';
  S('rect', { x: -130, y: -42, width: 260, height: 84, rx: 8, fill: 'none', stroke: '#c8322a', 'stroke-width': 7 }, stamp);
  S('text', { y: 18, 'text-anchor': 'middle', 'font-size': 52, 'font-weight': 800, fill: '#c8322a', 'letter-spacing': 4 }, stamp).textContent = 'SHIPPED';
  const hit2 = S('rect', { x: 180, y: 300, width: 760, height: 80, fill: 'transparent' }, root); hit2.style.cursor = 'pointer';
  const hitAll = S('rect', { x: 34, y: 30, width: 982, height: 512, fill: 'transparent' }, root); hitAll.style.cursor = 'pointer';
  root.appendChild(hit2);
  let i = 0, done = 0;
  const draw = () => {
    ['1. ship it', '2. ' + STEP2[i], '3. profit'].forEach((l, n) => { lines[n].textContent = l; });
    ticks.forEach((p, n) => { p.setAttribute('stroke-dashoffset', n < done ? '0' : '1'); p.setAttribute('stroke-opacity', n < done ? '1' : '0'); });
    stamp.setAttribute('opacity', done === 3 ? '1' : '0');
  };
  draw();
  const scr = (bx, by) => { const m = root.getScreenCTM(); return [m.a * bx + m.e, m.d * by + m.f]; };
  const onKey = e => {
    if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') { e.preventDefault(); i = (i + (e.code === 'ArrowRight' ? 1 : STEP2.length - 1)) % STEP2.length; done = Math.min(done, 1); SFX.play('squeak', { vol: 0.3 }); draw(); }
    if (e.code === 'Space') { e.preventDefault();
      if (done < 3) { done++; SFX.play(done === 3 ? 'success' : 'tick', { vol: 0.5 }); const [px, py] = scr(140, 230 + (done - 1) * 100); K.pop(px, py, done === 3 ? 'Shipped' : 'Done', done === 3 ? 'gold' : 'up');
        if (done === 3) { try { localStorage.setItem('nr.plan.done', String(best() + 1)); } catch { /* storage off */ } hud.set('done', best(), { count: true }); K.swell(); } }
      else { done = 0; SFX.play('swoosh', { vol: 0.3 }); }
      draw(); }
  };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  hit2.addEventListener('click', () => onKey({ code: 'ArrowRight', preventDefault() {} }));
  hitAll.addEventListener('click', () => onKey({ code: 'Space', preventDefault() {} }));
  void GX;
}
