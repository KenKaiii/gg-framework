// @ts-check
// Reusable device close-up: camera push-in (setView, ~0.6 s), then a framed pixel overlay of the device whose screen
// hosts a live mini-app. Styles: 'crt' (curved glass, scanlines, glow), 'flat' (thin bezel), 'tv' (bezel + chin).
import { setView, clearView, hideOccluders } from './view.js';
import { loop } from './util.js';
import { SFX } from '../sfx.js';
import { title, glow as kglow, noise as knoise, PAL } from './art.js';

export const W = 480, H = 270;
/** Screen rect inside the 480x270 canvas for each frame style. */
export const SCREEN = { crt: { x: 30, y: 22, w: 420, h: 214 }, flat: { x: 10, y: 10, w: 460, h: 238 }, tv: { x: 16, y: 14, w: 448, h: 226 } };

/**
 * @typedef {{ draw:(x:CanvasRenderingContext2D, w:number, h:number, dt:number, t:number)=>void, key?:(code:string)=>void, click?:(px:number, py:number)=>void }} App
 * @param {any} ctx activity ctx
 * @param {{ view:{target:any, dir:{x:number,y:number,z:number}, up?:any, zoom:number}, style:'crt'|'flat'|'tv', title:string, sub?:string, help?:string, brand?:string, glow?:string, app:(ov:any)=>App }} o
 */
export function closeup(ctx, o) {
  const { S } = ctx; let cancelled = false;
  setView(S, o.view); hideOccluders(S);
  const esc = e => { if (e.code === 'Escape') { cancelled = true; clearView(S); removeEventListener('keydown', esc, true); } };
  addEventListener('keydown', esc, true);
  setTimeout(() => {
    removeEventListener('keydown', esc, true);
    if (cancelled) return;
    const ov = ctx.overlay({ title: o.title, sub: o.sub, help: o.help });
    ov.onClose(() => clearView(S));
    const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
    const sr = SCREEN[o.style], app = o.app(ov);
    const scr = document.createElement('canvas'); scr.width = sr.w; scr.height = sr.h; const sx = /** @type {CanvasRenderingContext2D} */ (scr.getContext('2d')); sx.imageSmoothingEnabled = false;
    const kd = e => { if (e.code === 'Escape') return; if (/Arrow|Space/.test(e.code)) e.preventDefault(); SFX.play(/Arrow/.test(e.code) ? 'ui.select' : 'key', { vol: 0.4, jitter: 0.08 }); app.key?.(e.code); };
    const cl = e => { const r = c.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * W - sr.x, py = (e.clientY - r.top) / r.height * H - sr.y; if (px >= 0 && py >= 0 && px < sr.w && py < sr.h) { SFX.play('ui.tap', { vol: 0.4 }); app.click?.(px, py); } };
    addEventListener('keydown', kd); c.addEventListener('mousedown', cl);
    ov.onClose(() => { removeEventListener('keydown', kd); c.removeEventListener('mousedown', cl); });
    loop(ov, (dt, t) => { app.draw(sx, sr.w, sr.h, dt, t); frame(x, o, sr, scr, t); });
  }, 620);
}

/** Cached device body per style: moulded plastic / brushed bezel with a lit top edge, bevel, texture, drop shadow. */
const BODIES = new Map();
function body(o, sr) {
  const k = o.style + (o.brand || ''); if (BODIES.has(k)) return BODIES.get(k);
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  const bg = g.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W * 0.7); bg.addColorStop(0, '#16141e'); bg.addColorStop(1, '#050408'); g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const [top, bot, rad] = o.style === 'crt' ? ['#5a5040', '#2a2418', 22] : o.style === 'tv' ? ['#2e2e38', '#0e0e14', 8] : ['#3a3e48', '#14161c', 6];
  const lg = g.createLinearGradient(0, 2, 0, H - 2); lg.addColorStop(0, top); lg.addColorStop(1, bot); g.fillStyle = lg; g.beginPath(); rpath(g, 2, 2, W - 4, H - 4, rad); g.fill();
  g.strokeStyle = '#08070a'; g.lineWidth = 2; g.beginPath(); rpath(g, 3, 3, W - 6, H - 6, rad); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.2)'; g.fillRect(rad + 4, 4, W - rad * 2 - 8, 1); g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(rad + 4, H - 5, W - rad * 2 - 8, 1);
  knoise(g, 6, 6, W - 12, H - 12, 0.03, 13);
  const bz = g.createLinearGradient(0, sr.y - 8, 0, sr.y + sr.h + 8); bz.addColorStop(0, '#060508'); bz.addColorStop(1, '#24222c'); g.fillStyle = bz; g.beginPath(); rpath(g, sr.x - 6, sr.y - 6, sr.w + 12, sr.h + 12, o.style === 'crt' ? 26 : 4); g.fill();
  if (o.style === 'crt') { for (let i = 0; i < 6; i++) { g.fillStyle = '#1a160e'; g.fillRect(W - 140 + i * 12, H - 20, 8, 3); g.fillStyle = 'rgba(255,230,180,0.12)'; g.fillRect(W - 140 + i * 12, H - 17, 8, 1); } title(g, o.brand || 'PHOSPHOR-9', 40, H - 9, { size: 16, body: true, align: 'left', color: PAL.goldHi }); }
  if (o.style === 'tv') title(g, o.brand || 'VIBESONIC', W / 2, H - 6, { size: 16, body: true, color: '#c8c8d8' });
  BODIES.set(k, c); return c;
}
/** Draw the device body and composite the screen with its glass treatment. */
function frame(x, o, sr, scr, t) {
  const glow = o.glow || '#6ee7a0';
  x.drawImage(body(o, sr), 0, 0);
  if (o.style === 'crt') {
    x.save(); x.beginPath(); rpath(x, sr.x, sr.y, sr.w, sr.h, 22); x.clip();
    x.drawImage(scr, sr.x, sr.y);
    x.fillStyle = 'rgba(0,0,0,.28)'; for (let y = sr.y; y < sr.y + sr.h; y += 2) x.fillRect(sr.x, y, sr.w, 1);
    const roll = sr.y + ((t * 40) % (sr.h + 40)) - 20; x.fillStyle = 'rgba(255,255,255,.035)'; x.fillRect(sr.x, roll, sr.w, 14);
    const g = x.createRadialGradient(W / 2, sr.y + sr.h / 2, sr.h * 0.35, W / 2, sr.y + sr.h / 2, sr.w * 0.62); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.75)'); x.fillStyle = g; x.fillRect(sr.x, sr.y, sr.w, sr.h);
    x.fillStyle = 'rgba(255,255,255,.06)'; x.beginPath(); x.ellipse(sr.x + sr.w * 0.3, sr.y + 26, sr.w * 0.26, 12, -0.08, 0, Math.PI * 2); x.fill();
    x.restore();
    x.save(); x.globalCompositeOperation = 'lighter'; x.shadowColor = glow; x.shadowBlur = 14; x.strokeStyle = hexA(glow, 0.25); x.lineWidth = 2; x.beginPath(); rpath(x, sr.x, sr.y, sr.w, sr.h, 22); x.stroke(); x.restore();
    x.fillStyle = glow; x.fillRect(W - 46, H - 18, 5, 5); kglow(x, W - 44, H - 16, 10, glow, 0.35 + Math.sin(t * 1.5) * 0.15);
  } else if (o.style === 'tv') {
    x.drawImage(scr, sr.x, sr.y);
    const g = x.createLinearGradient(sr.x, sr.y, sr.x + sr.w, sr.y + sr.h); g.addColorStop(0, 'rgba(255,255,255,.05)'); g.addColorStop(0.4, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(sr.x, sr.y, sr.w, sr.h);
    x.fillStyle = 'rgba(0,0,0,.08)'; for (let y = sr.y; y < sr.y + sr.h; y += 3) x.fillRect(sr.x, y, sr.w, 1);
    x.fillStyle = '#ff4fd8'; x.fillRect(W - 28, H - 17, 4, 4); kglow(x, W - 26, H - 15, 8, '#ff4fd8', 0.4);
  } else {
    x.drawImage(scr, sr.x, sr.y);
    const g = x.createLinearGradient(sr.x, sr.y, sr.x + sr.w * 0.6, sr.y + sr.h); g.addColorStop(0, 'rgba(255,255,255,.04)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(sr.x, sr.y, sr.w, sr.h);
    x.fillStyle = '#3ddc84'; x.fillRect(W / 2 - 2, H - 7, 4, 2); kglow(x, W / 2, H - 6, 8, '#3ddc84', 0.4);
  }
}
function rpath(x, a, b, w, h, r) { x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }
function rr(x, a, b, w, h, r, c) { x.fillStyle = c; x.beginPath(); rpath(x, a, b, w, h, r); x.fill(); }
function hexA(h, a) { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
