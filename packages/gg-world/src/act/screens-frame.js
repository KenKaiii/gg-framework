// @ts-check
// Reusable device close-up: camera push-in (setView, ~0.6 s), then a framed pixel overlay of the device whose screen
// hosts a live mini-app. Styles: 'crt' (curved glass, scanlines, glow), 'flat' (thin bezel), 'tv' (bezel + chin).
import { setView, clearView, hideOccluders } from './view.js';
import { loop, text } from './util.js';
import { SFX } from '../sfx.js';

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

/** Draw the device body and composite the screen with its glass treatment. */
function frame(x, o, sr, scr, t) {
  const glow = o.glow || '#6ee7a0';
  x.fillStyle = '#07070b'; x.fillRect(0, 0, W, H);
  if (o.style === 'crt') {
    rr(x, 2, 2, W - 4, H - 4, 22, '#2a2620'); rr(x, 6, 6, W - 12, H - 12, 18, '#3a342a');
    rr(x, sr.x - 8, sr.y - 8, sr.w + 16, sr.h + 16, 26, '#151310');
    x.save(); x.beginPath(); rpath(x, sr.x, sr.y, sr.w, sr.h, 22); x.clip();
    x.drawImage(scr, sr.x, sr.y);
    x.fillStyle = 'rgba(0,0,0,.28)'; for (let y = sr.y; y < sr.y + sr.h; y += 2) x.fillRect(sr.x, y, sr.w, 1);
    const roll = sr.y + ((t * 40) % (sr.h + 40)) - 20; x.fillStyle = 'rgba(255,255,255,.035)'; x.fillRect(sr.x, roll, sr.w, 14);
    const g = x.createRadialGradient(W / 2, sr.y + sr.h / 2, sr.h * 0.35, W / 2, sr.y + sr.h / 2, sr.w * 0.62); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.75)'); x.fillStyle = g; x.fillRect(sr.x, sr.y, sr.w, sr.h);
    x.fillStyle = 'rgba(255,255,255,.06)'; x.beginPath(); x.ellipse(sr.x + sr.w * 0.3, sr.y + 26, sr.w * 0.26, 12, -0.08, 0, Math.PI * 2); x.fill();
    x.restore();
    x.save(); x.globalCompositeOperation = 'lighter'; x.shadowColor = glow; x.shadowBlur = 14; x.strokeStyle = hexA(glow, 0.25); x.lineWidth = 2; x.beginPath(); rpath(x, sr.x, sr.y, sr.w, sr.h, 22); x.stroke(); x.restore();
    text(x, o.brand || 'PHOSPHOR-9', 40, H - 12, { color: '#8a7a5a' }); x.fillStyle = (t % 2) < 1.6 ? glow : '#1f3a2a'; x.fillRect(W - 46, H - 18, 5, 5);
    for (let i = 0; i < 6; i++) { x.fillStyle = '#1e1a14'; x.fillRect(W - 140 + i * 12, H - 20, 8, 2); }
  } else if (o.style === 'tv') {
    rr(x, 2, 2, W - 4, H - 4, 8, '#16161c'); rr(x, 4, 4, W - 8, H - 8, 7, '#1d1d25');
    x.drawImage(scr, sr.x, sr.y);
    const g = x.createLinearGradient(sr.x, sr.y, sr.x + sr.w, sr.y + sr.h); g.addColorStop(0, 'rgba(255,255,255,.05)'); g.addColorStop(0.4, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(sr.x, sr.y, sr.w, sr.h);
    x.fillStyle = 'rgba(0,0,0,.08)'; for (let y = sr.y; y < sr.y + sr.h; y += 3) x.fillRect(sr.x, y, sr.w, 1);
    text(x, o.brand || 'VIBESONIC', W / 2, H - 10, { align: 'center', color: '#5a5a6a' }); x.fillStyle = '#ff4fd8'; x.fillRect(W - 28, H - 17, 4, 4);
  } else {
    rr(x, 2, 2, W - 4, H - 4, 6, '#1a1c22'); x.fillStyle = '#0c0d10'; x.fillRect(sr.x - 2, sr.y - 2, sr.w + 4, sr.h + 4);
    x.drawImage(scr, sr.x, sr.y);
    const g = x.createLinearGradient(sr.x, sr.y, sr.x + sr.w * 0.6, sr.y + sr.h); g.addColorStop(0, 'rgba(255,255,255,.04)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(sr.x, sr.y, sr.w, sr.h);
    x.fillStyle = '#3ddc84'; x.fillRect(W / 2 - 2, H - 7, 4, 2);
  }
}
function rpath(x, a, b, w, h, r) { x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }
function rr(x, a, b, w, h, r, c) { x.fillStyle = c; x.beginPath(); rpath(x, a, b, w, h, r); x.fill(); }
function hexA(h, a) { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
