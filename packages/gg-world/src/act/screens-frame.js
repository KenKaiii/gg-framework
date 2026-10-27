// @ts-check
// Reusable device close-up, rebuilt on GX: camera push-in (setView, ~0.6 s), then the device itself in SVG (a slim
// modern TV with a chin, a warm CRT, or a flat monitor) at screen resolution, its screen a hi-DPI canvas hosting a live
// mini-app. Apps draw in logical screen units (SCREEN sizes); the canvas is scaled by size x devicePixelRatio.
import { setView, clearView, hideOccluders } from './view.js';
import { loop } from './util.js';
import { SFX } from '../sfx.js';
import { gx, svg as S, GX } from './gx.js';

/** Logical screen size per style. */
export const SCREEN = { crt: { x: 0, y: 0, w: 420, h: 214 }, flat: { x: 0, y: 0, w: 460, h: 238 }, tv: { x: 0, y: 0, w: 448, h: 226 } };
const BODY = { crt: { pad: 34, chin: 46, r: 28, sr: 22 }, flat: { pad: 10, chin: 26, r: 10, sr: 3 }, tv: { pad: 9, chin: 30, r: 8, sr: 3 } };

/**
 * @typedef {{ draw:(x:CanvasRenderingContext2D, w:number, h:number, dt:number, t:number)=>void, key?:(code:string)=>void, click?:(px:number, py:number)=>void }} App
 * @param {any} ctx activity ctx
 * @param {{ view:{target:any, dir:{x:number,y:number,z:number}, up?:any, zoom:number}, style:'crt'|'flat'|'tv', title:string, sub?:string, help?:string, brand?:string, glow?:string, app:(ov:any)=>App }} o
 */
export function closeup(ctx, o) {
  const { S: St } = ctx; let cancelled = false;
  setView(St, o.view); hideOccluders(St);
  const esc = e => { if (e.code === 'Escape') { cancelled = true; clearView(St); removeEventListener('keydown', esc, true); } };
  addEventListener('keydown', esc, true);
  setTimeout(() => {
    removeEventListener('keydown', esc, true);
    if (cancelled) return;
    const ov = ctx.overlay({ title: o.title, sub: o.sub, help: (o.help || '').replace(/\s*<kbd>esc<\/kbd>\s*leave/, '') });
    ov.onClose(() => clearView(St));
    const sr = SCREEN[o.style], B = BODY[o.style], glow = o.glow || (o.style === 'crt' ? '#7fdc95' : o.style === 'tv' ? GX.primary : GX.teal);
    const VW = sr.w + B.pad * 2, VH = sr.h + B.pad * 2 + B.chin;
    const K = gx(ov), scene = K.scene({ aspect: VW / VH, maxW: 1200 });
    const root = S('svg', { viewBox: `0 0 ${VW} ${VH}`, width: '100%', height: '100%' }, scene);
    Object.assign(root.style, { position: 'absolute', inset: '0', overflow: 'visible' });
    const crt = o.style === 'crt', [c0, c1, c2] = crt ? ['#5c5242', '#3a3226', '#1f1a12'] : o.style === 'tv' ? ['#2c2f36', '#1a1c21', '#0d0e11'] : ['#3a3f48', '#262a31', '#14161b'];
    const X0 = B.pad, Y0 = B.pad;
    root.innerHTML = `<defs>
      <linearGradient id="gxf-body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c0}"/><stop offset="0.5" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
      <linearGradient id="gxf-sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="${crt ? 0.1 : 0.06}"/><stop offset="0.4" stop-color="#fff" stop-opacity="0"/></linearGradient>
      <radialGradient id="gxf-vig" r="0.7"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${crt ? 0.65 : 0.2}"/></radialGradient>
      <pattern id="gxf-scan" width="3" height="3" patternUnits="userSpaceOnUse"><rect width="3" height="1" y="2" fill="#000" fill-opacity="${crt ? 0.1 : 0}"/></pattern>
      <filter id="gxf-soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="12"/></filter>
      <filter id="gxf-led" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="2.5"/></filter>
      <filter id="gxf-grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="5"/><feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.12 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
      <clipPath id="gxf-clip"><rect x="${X0}" y="${Y0}" width="${sr.w}" height="${sr.h}" rx="${B.sr}"/></clipPath></defs>
      <rect x="${X0 - 10}" y="${Y0 - 10}" width="${sr.w + 20}" height="${sr.h + 20}" rx="${B.r}" fill="${glow}" opacity="0.14" filter="url(#gxf-soft)"/>
      <ellipse cx="${VW / 2}" cy="${VH + 4}" rx="${VW * 0.46}" ry="10" fill="#000" opacity="0.5" filter="url(#gxf-soft)"/>
      <rect width="${VW}" height="${VH}" rx="${B.r}" fill="url(#gxf-body)"/>
      <rect width="${VW}" height="${VH}" rx="${B.r}" fill="#000" filter="url(#gxf-grain)"/>
      <rect x="0.75" y="0.75" width="${VW - 1.5}" height="${VH - 1.5}" rx="${B.r}" fill="none" stroke="#fff" stroke-opacity="0.13" stroke-width="1.2"/>
      <rect x="${X0 - 4}" y="${Y0 - 4}" width="${sr.w + 8}" height="${sr.h + 8}" rx="${B.sr + 3}" fill="#07080a"/>`;
    const fo = S('foreignObject', { x: X0, y: Y0, width: sr.w, height: sr.h, 'clip-path': 'url(#gxf-clip)' }, root);
    const cv = document.createElement('canvas'); Object.assign(cv.style, { width: '100%', height: '100%', display: 'block', cursor: 'pointer' }); fo.appendChild(cv);
    const x = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
    const glass = S('g', { 'pointer-events': 'none', 'clip-path': 'url(#gxf-clip)' }, root);
    S('rect', { x: X0, y: Y0, width: sr.w, height: sr.h, fill: 'url(#gxf-scan)' }, glass);
    S('rect', { x: X0, y: Y0, width: sr.w, height: sr.h, fill: 'url(#gxf-vig)' }, glass);
    S('rect', { x: X0, y: Y0, width: sr.w, height: sr.h, fill: 'url(#gxf-sheen)' }, glass);
    const cy = Y0 + sr.h + B.pad / 2 + B.chin / 2 - (crt ? 4 : 0);
    const brand = S('text', { x: crt ? X0 + 8 : VW / 2, y: cy + 4, 'text-anchor': crt ? 'start' : 'middle', 'font-family': 'Sora', 'font-weight': 700, 'font-size': crt ? 12 : 9, 'letter-spacing': 3, fill: crt ? GX.lamp : '#c7ccd6', 'fill-opacity': 0.7 }, root);
    brand.textContent = (o.brand || (crt ? 'PHOSPHOR-9' : '')).toUpperCase();
    if (crt) for (let i = 0; i < 7; i++) S('rect', { x: VW - B.pad - 150 + i * 16, y: cy - 6, width: 10, height: 12, rx: 3, fill: '#15110b', stroke: '#fff', 'stroke-opacity': 0.06 }, root);
    const ledX = crt ? VW - B.pad - 10 : VW - B.pad - 8;
    S('circle', { cx: ledX, cy, r: 4, fill: glow, filter: 'url(#gxf-led)' }, root);
    const led = S('circle', { cx: ledX, cy, r: 2, fill: glow }, root);
    if (o.style === 'flat') { S('rect', { x: VW / 2 - 24, y: VH, width: 48, height: 14, fill: '#1e2127' }, root); }

    const size = () => { const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1, w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d)); if (w !== cv.width || h !== cv.height) { cv.width = w; cv.height = h; } };
    let sz = 0; // the scene fits after the first frame and SVG scaling doesn't trigger ResizeObserver: re-check twice a second
    size(); const ro = new ResizeObserver(size); ro.observe(cv); ov.onClose(() => ro.disconnect());
    const app = o.app(ov);
    const kd = e => { if (e.code === 'Escape') return; if (/Arrow|Space/.test(e.code)) e.preventDefault(); SFX.play(/Arrow/.test(e.code) ? 'ui.select' : 'key', { vol: 0.4, jitter: 0.08 }); app.key?.(e.code); };
    const cl = e => { const r = cv.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * sr.w, py = (e.clientY - r.top) / r.height * sr.h; if (px >= 0 && py >= 0 && px < sr.w && py < sr.h) { SFX.play('ui.tap', { vol: 0.4 }); app.click?.(px, py); } };
    addEventListener('keydown', kd); cv.addEventListener('mousedown', cl);
    ov.onClose(() => { removeEventListener('keydown', kd); cv.removeEventListener('mousedown', cl); });
    loop(ov, (dt, t) => {
      if ((sz -= dt) < 0) { sz = 0.5; size(); }
      x.setTransform(cv.width / sr.w, 0, 0, cv.height / sr.h, 0, 0); x.imageSmoothingEnabled = true;
      app.draw(x, sr.w, sr.h, dt, t);
      led.setAttribute('opacity', String(0.75 + Math.sin(t * 1.2) * 0.2));
    });
  }, 620);
}
