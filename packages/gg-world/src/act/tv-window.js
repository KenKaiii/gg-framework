// @ts-check
// "Look outside" (den + bedroom windows), rebuilt on GX: a real painted-wood sash window in SVG with the night city
// behind the glass. Rain on the glass in the bedroom, the moon in the den, windows across the street fade on and off;
// one of them is a dev typing (green). Space / click wipes the fog off the glass. Caption in Sora.
import { gx, svg as S, GX } from './gx.js';
import { loop, rng } from './util.js';
import { SFX } from '../sfx.js';
/** @param {any} ctx */
export function startWindow(ctx) {
  const rain = ctx.R.id === 'bedroom', reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ov = ctx.overlay({ title: 'Outside', sub: rain ? 'bedroom window · raining again' : 'den window · clear night', help: '<kbd>space</kbd> / <kbd>click</kbd> wipe the glass' });
  const K = gx(ov), scene = K.scene({ aspect: 16 / 10, maxW: 1100 });
  const VW = 800, VH = 500, G = { x: 40, y: 34, w: 720, h: 400 };
  const root = S('svg', { viewBox: `0 0 ${VW} ${VH}`, width: '100%', height: '100%', role: 'img', 'aria-label': 'Window' }, scene);
  Object.assign(root.style, { position: 'absolute', inset: '0', overflow: 'visible', cursor: 'pointer' });
  root.innerHTML = `<defs>
    <linearGradient id="gxw-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#070918"/><stop offset="0.6" stop-color="#1c1a38"/><stop offset="1" stop-color="#4a2c48"/></linearGradient>
    <radialGradient id="gxw-haze" cx="0.5" cy="1" r="0.7"><stop offset="0" stop-color="#ff8a5a" stop-opacity="0.3"/><stop offset="1" stop-color="#ff8a5a" stop-opacity="0"/></radialGradient>
    <radialGradient id="gxw-moon" r="0.5"><stop offset="0.3" stop-color="#fff2c8" stop-opacity="0.35"/><stop offset="1" stop-color="#fff2c8" stop-opacity="0"/></radialGradient>
    <linearGradient id="gxw-wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7a5034"/><stop offset="1" stop-color="#3e2618"/></linearGradient>
    <linearGradient id="gxw-sill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9a6a46"/><stop offset="1" stop-color="#4a2c1a"/></linearGradient>
    <linearGradient id="gxw-glint" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.12"/><stop offset="0.3" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <filter id="gxw-grain"><feTurbulence type="fractalNoise" baseFrequency="0.015 0.4" numOctaves="3" seed="7"/><feColorMatrix values="0 0 0 0 0.08 0 0 0 0 0.04 0 0 0 0 0.02 0 0 0 0.5 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
    <filter id="gxw-fog" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="3" seed="2"/><feColorMatrix values="0 0 0 0 0.62 0 0 0 0 0.66 0 0 0 0 0.74 0 0 0 0.9 0"/></filter>
    <filter id="gxw-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>
    <filter id="gxw-soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter>
    <clipPath id="gxw-clip"><rect x="${G.x}" y="${G.y}" width="${G.w}" height="${G.h}"/></clipPath></defs>
    <rect x="16" y="20" width="768" height="480" rx="6" fill="#000" opacity="0.5" filter="url(#gxw-soft)"/>`;
  const view = S('g', { 'clip-path': 'url(#gxw-clip)' }, root);
  S('rect', { x: G.x, y: G.y, width: G.w, height: G.h, fill: 'url(#gxw-sky)' }, view);
  S('rect', { x: G.x, y: G.y, width: G.w, height: G.h, fill: 'url(#gxw-haze)' }, view);
  const r = rng(rain ? 7 : 3);
  if (!rain) { for (let i = 0; i < 60; i++) S('circle', { cx: G.x + r() * G.w, cy: G.y + r() * 170, r: 0.5 + r() * 0.9, fill: '#dde5ff', opacity: 0.3 + r() * 0.6 }, view);
    S('circle', { cx: 600, cy: 110, r: 70, fill: 'url(#gxw-moon)' }, view); const mk = S('mask', { id: 'gxw-crescent' }, root); S('rect', { x: 0, y: 0, width: VW, height: VH, fill: '#fff' }, mk); S('circle', { cx: 613, cy: 101, r: 24, fill: '#000' }, mk);
    S('circle', { cx: 600, cy: 110, r: 26, fill: '#efe9d8', mask: 'url(#gxw-crescent)' }, view); }
  const lit = /** @type {{ el: any, p: number }[]} */ ([]); let bx = G.x - 6, mid = null;
  while (bx < G.x + G.w) { const w = 44 + r() * 70, h = 110 + r() * 220, top = G.y + G.h - h, back = r() < 0.5;
    S('rect', { x: bx, y: top, width: w, height: h + 2, fill: back ? '#161838' : '#10112a' }, view);
    for (let yy = top + 14; yy < G.y + G.h - 10; yy += 18) for (let xx = bx + 8; xx < bx + w - 10; xx += 13) if (r() < 0.33) { const p = r();
      const el = S('rect', { x: xx, y: yy, width: 6, height: 9, rx: 1, fill: p > 0.85 ? GX.pink : '#e0a458' }, view); el.style.transition = 'opacity 1.6s'; lit.push({ el, p }); if (!mid && bx > G.x + G.w * 0.45) mid = [xx, yy]; }
    bx += w + r() * 8; }
  const dev = mid || [400, 300];
  S('rect', { x: dev[0] - 6, y: dev[1] - 6, width: 18, height: 21, fill: GX.success, opacity: 0.35, filter: 'url(#gxw-blur)' }, view);
  const devW = S('rect', { x: dev[0], y: dev[1], width: 6, height: 9, rx: 1, fill: GX.success }, view);
  const drops = rain ? Array.from({ length: 70 }, () => ({ el: S('line', { x1: 0, y1: 0, x2: 0, y2: 10 + r() * 8, stroke: '#a8bce0', 'stroke-opacity': 0.4, 'stroke-width': 1, 'stroke-linecap': 'round' }, view), x: G.x + r() * G.w, y: G.y + r() * G.h, v: 160 + r() * 200 })) : [];
  const beads = rain ? Array.from({ length: 30 }, () => S('ellipse', { cx: G.x + r() * G.w, cy: G.y + r() * G.h, rx: 1.5 + r() * 2, ry: 2 + r() * 3, fill: '#cfe0ff', 'fill-opacity': 0.25, stroke: '#fff', 'stroke-opacity': 0.25, 'stroke-width': 0.6 }, view)) : [];
  void beads;
  const fogEl = S('rect', { x: G.x, y: G.y, width: G.w, height: G.h, filter: 'url(#gxw-fog)', opacity: 0.4 }, view);
  S('path', { d: `M${G.x} ${G.y} H${G.x + 300} L${G.x} ${G.y + 220} Z`, fill: 'url(#gxw-glint)' }, view);
  // frame: casing, sashes, mullions, sill
  const wood = (x, y, w, h) => { S('rect', { x, y, width: w, height: h, fill: 'url(#gxw-wood)' }, root); S('rect', { x, y, width: w, height: h, fill: '#000', filter: 'url(#gxw-grain)' }, root);
    S('rect', { x, y, width: w, height: 1.5, fill: '#ffd29a', opacity: 0.35 }, root); S('rect', { x, y: y + h - 1.5, width: w, height: 1.5, fill: '#000', opacity: 0.45 }, root); };
  wood(16, 10, 768, 24); wood(16, 10, 24, 440); wood(760, 10, 24, 440); wood(16, 430, 768, 16);
  wood(394, 34, 12, 396); wood(40, 226, 720, 14);
  S('rect', { x: G.x, y: G.y, width: G.w, height: G.h, fill: 'none', stroke: '#000', 'stroke-opacity': 0.5, 'stroke-width': 4 }, root);
  S('rect', { x: 4, y: 444, width: 792, height: 26, rx: 4, fill: 'url(#gxw-sill)' }, root); S('rect', { x: 4, y: 444, width: 792, height: 26, rx: 4, fill: '#000', filter: 'url(#gxw-grain)' }, root);
  S('rect', { x: 4, y: 444, width: 792, height: 2, fill: '#ffd29a', opacity: 0.5 }, root);
  S('rect', { x: 385, y: 222, width: 30, height: 10, rx: 3, fill: '#c9a46a' }, root);
  const cap = S('text', { x: VW / 2, y: 496, 'text-anchor': 'middle', 'font-family': 'Sora', 'font-size': 17, 'font-weight': 600, fill: GX.text }, root);

  let fog = 0.6, msg = 0, wins = 0;
  const wipe = () => { fog = 0; msg = 3; SFX.play('squeak', { vol: 0.35 }); };
  const onKey = e => { if (e.code === 'Space') { e.preventDefault(); wipe(); } };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  root.addEventListener('click', wipe);
  let lastCap = '';
  loop(ov, (dt, t) => {
    fog = Math.min(0.6, fog + dt * 0.04); msg = Math.max(0, msg - dt);
    fogEl.setAttribute('opacity', (fog * 0.7).toFixed(3));
    if ((wins -= dt) < 0) { wins = 1.6; for (const w of lit) w.el.style.opacity = Math.sin(t * 0.3 + w.p * 50) > -0.6 ? String(0.5 + w.p * 0.5) : '0.05'; }
    devW.setAttribute('opacity', String(0.75 + Math.sin(t * 1.4) * 0.25));
    if (!reduce) for (const d of drops) { d.y += d.v * dt; if (d.y > G.y + G.h) { d.y = G.y - 20; d.x = G.x + Math.random() * G.w; } d.el.setAttribute('transform', `translate(${d.x} ${d.y}) rotate(8)`); }
    const c = msg > 0 ? 'Someone over there is still shipping too.' : rain ? 'Rain on the glass. The city is still awake.' : 'City lights. Not a single bug in sight.';
    if (c !== lastCap) { lastCap = c; cap.textContent = c; cap.setAttribute('fill', msg > 0 ? GX.success : GX.text); }
  });
}
