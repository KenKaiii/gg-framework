// @ts-check
// The Engine Room explainer cards (GX rebuild): one activity per station. Each opens as a clean product explainer: a
// large panel in the app's surface + Sora, a crisp SVG diagram (rounded nodes, smooth links with travelling dots, soft
// glow) and the station's points as readable text. Content lives in act/engine-cards.js.
import { gx, svg as S, GX } from './gx.js';
import { FONT } from '../fonts.js';
import { SFX } from '../sfx.js';
import { CARDS } from './engine-cards.js';

const TONES = { cool: GX.primary, teal: GX.teal, violet: GX.violet, pink: GX.pink, lamp: GX.lamp, up: GX.success, muted: GX.muted };
let styled = false;
function style() {
  if (styled) return; styled = true;
  const st = document.createElement('style');
  st.textContent = `
.ex-panel{position:absolute;inset:0;display:flex;flex-direction:column;padding:3.2cqh 3.4cqw 2.6cqh;border-radius:22px;background:linear-gradient(180deg,${GX.s1},#1a1c20);box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 0 0 1px rgba(255,255,255,.07),0 30px 70px -20px rgba(0,0,0,.8);animation:gx-pop .4s cubic-bezier(.3,1.4,.6,1);font-family:${FONT.app}}
.ex-panel .k{margin:0;font-size:max(10px,1.5cqh);font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${GX.muted}}
.ex-panel h2{margin:.5cqh 0 0;font-size:max(18px,4.6cqh);line-height:1.1;font-weight:700;letter-spacing:-.025em}
.ex-panel .tag{margin:.6cqh 0 0;font-size:max(12px,2.3cqh);color:${GX.lamp}}
.ex-panel .dia{flex:1 1 auto;min-height:0;margin:1.8cqh 0;border-radius:14px;background:radial-gradient(ellipse at 50% 30%,#23262c,#17191c);box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)}
.ex-panel .dia svg{width:100%;height:100%}
.ex-panel ul{margin:0;padding:0;list-style:none;display:grid;grid-template-columns:1fr 1fr;gap:1cqh 3cqw}
.ex-panel li{position:relative;padding-left:16px;font-size:max(11.5px,2.15cqh);line-height:1.45;color:${GX.text2}}
.ex-panel li::before{content:'';position:absolute;left:0;top:.6em;width:6px;height:6px;border-radius:50%;background:${GX.lamp};box-shadow:0 0 8px ${GX.lamp}}
.ex-panel .acts{display:flex;justify-content:flex-end;margin-top:1.8cqh}
@media (prefers-reduced-motion: reduce){.ex-panel{animation:none}}`;
  document.head.appendChild(st);
}

/** @param {any} card */
function diagram(card, host, reduce) {
  const root = S('svg', { viewBox: '0 0 800 260', preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': card.name + ' diagram' }, host);
  const uid = 'ex-' + card.id;
  root.innerHTML = `<defs><filter id="${uid}-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>
    <filter id="${uid}-dot" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="2.5"/></filter>
    <linearGradient id="${uid}-face" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#30353c"/><stop offset="1" stop-color="#24272c"/></linearGradient></defs>`;
  const by = Object.fromEntries(card.nodes.map(n => [n.id, n]));
  const links = S('g', {}, root), nodes = S('g', {}, root), dots = S('g', {}, root);
  card.links.forEach(([a, b, label], i) => {
    const A = by[a], B = by[b]; if (!A || !B) return;
    let d, mx, my;
    if (Math.abs((A.x + A.w / 2) - (B.x + B.w / 2)) < 60) { // vertical link (same column)
      const down = B.y > A.y, x = A.x + A.w / 2 + (label === 'result' ? 30 : 0);
      const y0 = down ? A.y + A.h : A.y, y1 = down ? B.y : B.y + B.h;
      d = `M${x} ${y0} C${x} ${(y0 + y1) / 2} ${x} ${(y0 + y1) / 2} ${x} ${y1}`; mx = x + 10; my = (y0 + y1) / 2;
    } else {
      const fwd = B.x > A.x, x0 = fwd ? A.x + A.w : A.x, y0 = A.y + A.h / 2, x1 = fwd ? B.x : B.x + B.w, y1 = B.y + B.h / 2, c = (x1 - x0) * 0.5;
      const bend = label === 'result' ? 40 : label === 'call' ? -40 : 0;
      d = `M${x0} ${y0} C${x0 + c} ${y0 + bend} ${x1 - c} ${y1 + bend} ${x1} ${y1}`; mx = (x0 + x1) / 2; my = (y0 + y1) / 2 + bend * 0.75 - 8;
    }
    const tone = TONES[A.tone] || GX.primary;
    S('path', { d, fill: 'none', stroke: 'rgba(255,255,255,.12)', 'stroke-width': 3, 'stroke-linecap': 'round' }, links);
    const p = S('path', { id: `${uid}-l${i}`, d, fill: 'none', stroke: tone, 'stroke-opacity': 0.45, 'stroke-width': 1.6, 'stroke-dasharray': '2 6', 'stroke-linecap': 'round' }, links);
    if (label) { const t = S('text', { x: mx, y: my, 'text-anchor': Math.abs((A.x + A.w / 2) - (B.x + B.w / 2)) < 60 ? 'start' : 'middle', 'font-family': 'Sora', 'font-size': 12, 'font-weight': 600, fill: GX.muted }, links); t.textContent = label; }
    if (!reduce) {
      const dur = 2.2 + (i % 3) * 0.4;
      for (const off of [0, dur / 2]) {
        const g = S('g', {}, dots);
        S('circle', { r: 7, fill: tone, opacity: 0.5, filter: `url(#${uid}-dot)` }, g); S('circle', { r: 3, fill: '#fff' }, g);
        const am = S('animateMotion', { dur: dur + 's', begin: (off + i * 0.25).toFixed(2) + 's', repeatCount: 'indefinite', calcMode: 'spline', keyTimes: '0;1', keySplines: '.45 0 .55 1' }, g);
        S('mpath', { href: '#' + p.id }, am);
        g.setAttribute('opacity', '0'); S('set', { attributeName: 'opacity', to: 1, begin: (off + i * 0.25).toFixed(2) + 's' }, g);
      }
    }
  });
  for (const n of card.nodes) {
    const tone = TONES[n.tone || 'cool'] || GX.primary, g = S('g', {}, nodes), inner = n.big && by[n.id] && card.nodes.some(m => m !== n && m.x > n.x && m.x + m.w < n.x + n.w && m.y > n.y);
    if (n.big) { const gl = S('rect', { x: n.x + 6, y: n.y + 6, width: n.w - 12, height: n.h - 12, rx: 18, fill: tone, opacity: 0.22, filter: `url(#${uid}-glow)` }, g);
      if (!reduce) S('animate', { attributeName: 'opacity', values: '0.14;0.32;0.14', dur: '3.2s', repeatCount: 'indefinite' }, gl); }
    S('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: Math.min(16, n.h / 3), fill: `url(#${uid}-face)`, stroke: tone, 'stroke-opacity': n.big ? 0.75 : 0.45, 'stroke-width': 1.5 }, g);
    S('rect', { x: n.x + 1, y: n.y + 1, width: n.w - 2, height: 1, fill: 'rgba(255,255,255,.12)' }, g);
    const ly = inner ? n.y + 30 : n.y + n.h / 2 + (n.sub ? -3 : 5);
    S('circle', { cx: n.x + 16, cy: ly - 5, r: 4, fill: tone }, g);
    const t = S('text', { x: n.x + 28, y: ly, 'font-family': 'Sora', 'font-size': n.big ? 17 : 15, 'font-weight': 700, fill: GX.text }, g); t.textContent = n.label;
    if (n.sub) { const s = S('text', { x: n.x + 28, y: ly + 18, 'font-family': 'Sora', 'font-size': 12, 'font-weight': 500, fill: GX.muted }, g); s.textContent = n.sub; }
  }
}

/** @param {any} card */
const start = card => (/** @type {any} */ ctx) => {
  const ov = ctx.overlay({ title: card.name, sub: 'GG Coder engine room', help: '' });
  style();
  const K = gx(ov), reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scene = K.scene({ aspect: 16 / 10, maxW: 1080, lamp: false });
  const panel = document.createElement('div'); panel.className = 'ex-panel';
  panel.innerHTML = `<p class="k">GG Coder engine room</p><h2></h2><p class="tag"></p><div class="dia"></div><ul></ul><div class="acts"><button class="gx-btn pri lg" type="button">Close</button></div>`;
  /** @type {HTMLElement} */ (panel.querySelector('h2')).textContent = card.name;
  /** @type {HTMLElement} */ (panel.querySelector('.tag')).textContent = card.tag[0].toUpperCase() + card.tag.slice(1);
  const ul = /** @type {HTMLElement} */ (panel.querySelector('ul'));
  for (const l of card.lines) { const li = document.createElement('li'); li.textContent = l; ul.appendChild(li); }
  diagram(card, panel.querySelector('.dia'), reduce);
  scene.appendChild(panel);
  const btn = /** @type {HTMLElement} */ (panel.querySelector('.gx-btn'));
  const close = () => { SFX.play('ui.tap'); ov.close(); };
  btn.addEventListener('click', close); requestAnimationFrame(() => btn.focus({ preventScroll: true }));
  const onKey = e => { if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); close(); } };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
};
const at = (/** @type {string} */ id) => (/** @type {any} */ it, /** @type {any} */ R) => R.id === 'engine' && it.id === id;
export default CARDS.map(cd => ({ id: 'engine-' + cd.id, match: at(cd.id), label: () => cd.name, start: start(cd) }));
