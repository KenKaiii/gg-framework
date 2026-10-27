// @ts-check
// The den CRT, rebuilt for GX: a modern-made CRT set in SVG (moulded shell, smoked bezel, knobs, speaker grille, walnut
// trim) with the game's picture inside. The picture is a 160x120 pixel buffer drawn CRISP into a hi-DPI canvas at an
// integer scale (smoothing off only for it), with soft scanlines, curved-glass vignette and a glass sheen on top (SVG,
// built once). Brand + channel are Sora.
import { svg as S, GX } from './gx.js';

const W = 160, H = 120;
/** @param {HTMLElement} scene a GX scene (aspect ~1.36) */
export function makeTV(scene) {
  const buf = document.createElement('canvas'); buf.width = W; buf.height = H;
  const b = /** @type {CanvasRenderingContext2D} */ (buf.getContext('2d')); b.imageSmoothingEnabled = false;
  // viewBox 1000 x 736; screen rect at 70,64 680x510 (4:3)
  const SX = 70, SY = 64, SW = 680, SH = 510;
  const root = S('svg', { viewBox: '0 0 1000 736', width: '100%', height: '100%', role: 'img', 'aria-label': 'CRT television' }, scene);
  Object.assign(root.style, { position: 'absolute', inset: '0', overflow: 'visible' });
  root.innerHTML = `<defs>
    <linearGradient id="gxt-shell" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4b4757"/><stop offset="0.45" stop-color="#332f3d"/><stop offset="1" stop-color="#1c1a23"/></linearGradient>
    <linearGradient id="gxt-top" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="gxt-bez" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b0a10"/><stop offset="1" stop-color="#262330"/></linearGradient>
    <linearGradient id="gxt-wal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a5634"/><stop offset="1" stop-color="#4a2a16"/></linearGradient>
    <radialGradient id="gxt-knob" cx="0.38" cy="0.32" r="0.7"><stop offset="0" stop-color="#c9c4d6"/><stop offset="0.55" stop-color="#5d586a"/><stop offset="1" stop-color="#1f1d27"/></radialGradient>
    <radialGradient id="gxt-vig" cx="0.5" cy="0.5" r="0.62"><stop offset="0.62" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.6"/></radialGradient>
    <linearGradient id="gxt-sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.13"/><stop offset="0.35" stop-color="#fff" stop-opacity="0.02"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <pattern id="gxt-scan" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1.4" y="2.6" fill="#000" fill-opacity="0.22"/></pattern>
    <filter id="gxt-grain"><feTurbulence type="fractalNoise" baseFrequency="0.02 0.5" numOctaves="2" seed="3"/><feColorMatrix values="0 0 0 0 0.1 0 0 0 0 0.05 0 0 0 0 0.02 0 0 0 0.45 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
    <filter id="gxt-soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="18"/></filter>
    <filter id="gxt-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="4"/></filter>
    <clipPath id="gxt-clip"><rect x="${SX}" y="${SY}" width="${SW}" height="${SH}" rx="46"/></clipPath></defs>
    <rect x="${SX - 20}" y="${SY - 20}" width="${SW + 40}" height="${SH + 40}" rx="60" fill="#7fc8ff" opacity="0.16" filter="url(#gxt-soft)"/>
    <ellipse cx="500" cy="726" rx="470" ry="22" fill="#000" opacity="0.5" filter="url(#gxt-soft)"/>
    <rect x="16" y="14" width="968" height="690" rx="44" fill="url(#gxt-shell)"/>
    <rect x="16" y="14" width="968" height="690" rx="44" fill="url(#gxt-top)" opacity="0.5"/>
    <rect x="17.5" y="15.5" width="965" height="687" rx="43" fill="none" stroke="#fff" stroke-opacity="0.12" stroke-width="2"/>
    <rect x="16" y="14" width="968" height="690" rx="44" fill="none" stroke="#0c0b10" stroke-width="3"/>
    <rect x="40" y="640" width="920" height="40" rx="8" fill="url(#gxt-wal)"/><rect x="40" y="640" width="920" height="40" rx="8" fill="#000" filter="url(#gxt-grain)"/>
    <rect x="40" y="640" width="920" height="2" fill="#ffd29a" opacity="0.35"/>
    <rect x="${SX - 26}" y="${SY - 26}" width="${SW + 52}" height="${SH + 52}" rx="62" fill="url(#gxt-bez)"/>
    <rect x="${SX - 26}" y="${SY - 26}" width="${SW + 52}" height="${SH + 52}" rx="62" fill="none" stroke="#000" stroke-opacity="0.6" stroke-width="3"/>
    <rect x="${SX}" y="${SY}" width="${SW}" height="${SH}" rx="46" fill="#05060a"/>`;
  const fo = S('foreignObject', { x: SX, y: SY, width: SW, height: SH, 'clip-path': 'url(#gxt-clip)' }, root);
  const cv = document.createElement('canvas'); Object.assign(cv.style, { width: '100%', height: '100%', display: 'block' }); fo.appendChild(cv);
  const x = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
  const glass = S('g', { 'clip-path': 'url(#gxt-clip)', 'pointer-events': 'none' }, root);
  S('rect', { x: SX, y: SY, width: SW, height: SH, fill: 'url(#gxt-scan)' }, glass);
  const roll = S('rect', { x: SX, y: SY, width: SW, height: 60, fill: '#fff', opacity: 0.025 }, glass);
  S('rect', { x: SX, y: SY, width: SW, height: SH, fill: 'url(#gxt-vig)' }, glass);
  S('path', { d: `M${SX} ${SY} H${SX + SW * 0.62} Q${SX + SW * 0.3} ${SY + SH * 0.2} ${SX} ${SY + SH * 0.5} Z`, fill: 'url(#gxt-sheen)' }, glass);
  const stat = S('rect', { x: SX, y: SY, width: SW, height: SH, fill: '#cfd6e6', opacity: 0 }, glass);
  // the right column: knobs, channel window, grille, power led, brand
  const px = 870;
  const knobs = [0, 1].map(i => { const g = S('g', { transform: `translate(${px} ${120 + i * 120})` }, root);
    S('circle', { r: 44, fill: '#000', opacity: 0.5, cy: 5 }, g); S('circle', { r: 40, fill: 'url(#gxt-knob)' }, g);
    S('circle', { r: 40, fill: 'none', stroke: '#0c0b10', 'stroke-width': 2 }, g);
    const m = S('g', {}, g); S('rect', { x: -3, y: -36, width: 6, height: 16, rx: 3, fill: GX.lamp }, m); return m; });
  S('rect', { x: px - 50, y: 330, width: 100, height: 56, rx: 10, fill: '#0b0a10', stroke: '#000', 'stroke-width': 2 }, root);
  const chT = S('text', { x: px, y: 368, 'text-anchor': 'middle', 'font-family': 'Sora', 'font-weight': 700, 'font-size': 30, fill: GX.pink, 'letter-spacing': 1 }, root);
  chT.textContent = '03';
  for (let i = 0; i < 7; i++) { S('rect', { x: px - 50, y: 414 + i * 18, width: 100, height: 8, rx: 4, fill: '#121017' }, root); S('rect', { x: px - 50, y: 422 + i * 18, width: 100, height: 1.5, fill: '#fff', opacity: 0.07 }, root); }
  const brand = S('text', { x: SX + SW / 2, y: 622, 'text-anchor': 'middle', 'font-family': 'Sora', 'font-weight': 700, 'font-size': 22, 'letter-spacing': 8, fill: GX.lamp, 'fill-opacity': 0.75 }, root);
  brand.textContent = 'NIGHTRON';
  S('circle', { cx: px, cy: 600, r: 9, fill: GX.success, filter: 'url(#gxt-glow)', opacity: 0.8 }, root);
  const led = S('circle', { cx: px, cy: 600, r: 5, fill: GX.success }, root);

  let scale = 0;
  const size = () => { const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1; cv.width = Math.max(1, Math.round(r.width * d)); cv.height = Math.max(1, Math.round(r.height * d)); scale = 0; };
  size(); const ro = new ResizeObserver(size); ro.observe(cv);
  let seed = 9; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  /** Draw the buffer into the set. @param {number} t @param {{ ch?: number, stat?: number }} o */
  function present(t, o) {
    if (!scale) { const f = Math.min(cv.width / W, cv.height / H) * 1.04; scale = f >= 4 ? Math.round(f) : f; } // integer scale (>=4x), overscan a touch
    x.imageSmoothingEnabled = false; x.fillStyle = '#05060a'; x.fillRect(0, 0, cv.width, cv.height);
    const dw = W * scale, dh = H * scale; x.drawImage(buf, Math.round((cv.width - dw) / 2), Math.round((cv.height - dh) / 2), dw, dh);
    stat.setAttribute('opacity', String(o.stat && o.stat > 0 ? o.stat * (0.5 + rnd() * 0.3) : 0));
    roll.setAttribute('y', String(SY - 60 + ((t * 40) % (SH + 120))));
    knobs[0].setAttribute('transform', `rotate(${(o.ch || 1) * 52})`); knobs[1].setAttribute('transform', `rotate(${-30})`);
    led.setAttribute('opacity', String(0.75 + Math.sin(t * 1.2) * 0.2));
    if (o.ch) chT.textContent = String(o.ch).padStart(2, '0');
  }
  return { W, H, b, present, el: cv, dispose: () => ro.disconnect() };
}
