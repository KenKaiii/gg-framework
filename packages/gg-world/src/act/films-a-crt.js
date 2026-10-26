// @ts-check
// Films A helpers: CRT frame drawing, word wrap and a tiny typed-input line for terminal overlays.
import { SFX } from '../sfx.js';
import { CFONT } from '../fonts.js';
import { text, rng } from './util.js';
import { panel, title, glow, keyChip, ease, clamp } from './art.js';

/** Word-wrap s to maxW px in the m5x7 body font. @param {CanvasRenderingContext2D} x @param {string} s @param {number} maxW */
export function wrap(x, s, maxW) {
  x.save(); x.font = CFONT.body(16); const out = []; let line = '';
  for (const w of s.split(' ')) { const t = line ? line + ' ' + w : w; if (x.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }
  out.push(line); x.restore(); return out;
}

/**
 * Beige CRT: bezel with a bulging inner screen; calls draw(sx, sy, sw, sh) clipped to the glass, then adds scanlines,
 * vignette and glare. @param {CanvasRenderingContext2D} x @param {number} W @param {number} H
 * @param {(sx:number, sy:number, sw:number, sh:number) => void} draw @param {{ flash?: number, glow?: string, beige?: string }} o
 */
export function crt(x, W, H, draw, o = {}) {
  const B = o.box || { x: 40, y: 8, w: W - 80, h: H - 34 }, bx = B.x, by = B.y, bw = B.w, bh = B.h, sx = bx + 26, sy = by + 18, sw = bw - 52, sh = bh - 48;
  const key = W + 'x' + H + (o.beige || '') + (o.key || '') + bx + ',' + by; let C = CACHE.get(key);
  if (!C) { // static bezel + glass overlay, drawn once per size / colour
    const back = document.createElement('canvas'); back.width = W; back.height = H; const b = /** @type {CanvasRenderingContext2D} */ (back.getContext('2d'));
    const bg = b.createRadialGradient(W / 2, H * 0.55, 20, W / 2, H * 0.55, W * 0.7); bg.addColorStop(0, '#1e2240'); bg.addColorStop(1, '#08080e');
    b.fillStyle = bg; b.fillRect(0, 0, W, H); if (o.backdrop) o.backdrop(b, W, H);
    b.fillStyle = '#4a3a2a'; b.fillRect(bx + 30, by + bh - 4, bw - 60, 26);
    b.fillStyle = o.beige || '#b9ae8f'; rr(b, bx, by, bw, bh, 18); b.fill();
    b.fillStyle = '#d6cdb0'; rr(b, bx + 4, by + 3, bw - 8, 6, 3); b.fill();
    b.fillStyle = '#8f8670'; rr(b, bx + 6, by + bh - 22, bw - 12, 16, 6); b.fill();
    b.fillStyle = '#3ddc84'; b.fillRect(bx + bw - 30, by + bh - 16, 4, 3);
    text(b, 'OMNIVIEW 14', bx + 16, by + bh - 9, { color: '#5e5646' });
    b.fillStyle = '#2a2620'; glass(b, sx - 5, sy - 5, sw + 10, sh + 10, 8); b.fill();
    const top = document.createElement('canvas'); top.width = W; top.height = H; const g2 = /** @type {CanvasRenderingContext2D} */ (top.getContext('2d'));
    g2.fillStyle = 'rgba(0,0,0,0.28)'; for (let y = sy - 6; y < sy + sh + 6; y += 2) g2.fillRect(sx - 8, y, sw + 16, 1);
    const v = g2.createRadialGradient(sx + sw / 2, sy + sh / 2, sh * 0.35, sx + sw / 2, sy + sh / 2, sw * 0.62); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.75)');
    g2.fillStyle = v; g2.fillRect(sx - 8, sy - 8, sw + 16, sh + 16);
    g2.save(); g2.translate(sx + sw * 0.22, sy + sh * 0.2); g2.scale(1, 0.45); const gl = g2.createRadialGradient(0, 0, 0, 0, 0, sw * 0.3);
    gl.addColorStop(0, 'rgba(255,255,255,0.09)'); gl.addColorStop(1, 'rgba(255,255,255,0)'); g2.fillStyle = gl; g2.fillRect(-sw * 0.3, -sw * 0.3, sw * 0.6, sw * 0.6); g2.restore();
    C = { back, top }; CACHE.set(key, C);
  }
  x.drawImage(C.back, 0, 0);
  x.save(); glass(x, sx, sy, sw, sh, 6); x.clip();
  x.fillStyle = '#04100a'; x.fillRect(sx - 8, sy - 8, sw + 16, sh + 16);
  x.shadowColor = o.glow || '#3ddc84'; x.shadowBlur = 6; draw(sx, sy, sw, sh); x.shadowBlur = 0;
  x.drawImage(C.top, 0, 0);
  if (o.flash) { x.fillStyle = `rgba(220,255,230,${Math.min(1, o.flash)})`; x.fillRect(sx - 8, sy - 8, sw + 16, sh + 16); }
  x.restore();
  return { sx, sy, sw, sh };
}
/** Steady cursor blink: 1.6 s period, on for the first 60%. @param {number} t */
export const blinkOn = t => (t / 1.6) % 1 < 0.6;
/**
 * Title card: big Alagard name, a one-line pitch and the controls as key chips (+ mouse). Shows ~2.4 s then fades.
 * @param {CanvasRenderingContext2D} x @param {number} W @param {number} H @param {number} t
 * @param {{ name: string, sub: string, keys: [string, string][], color: string, style?: string }} o
 */
export function titleCard(x, W, H, t, o) {
  const a = t < 2.4 ? 1 : 1 - (t - 2.4) / 0.5; if (a <= 0) return;
  const k = ease.outBack(clamp(t / 0.4, 0, 1)), bw = 320, bh = 112, X = (W - bw) / 2, Y = (H - bh) / 2;
  x.save(); x.globalAlpha = a; x.fillStyle = 'rgba(0,0,0,0.6)'; x.fillRect(0, 0, W, H);
  x.translate(W / 2, H / 2); x.scale(k, k); x.translate(-W / 2, -H / 2);
  panel(x, X, Y, bw, bh, { style: o.style || 'metal' }); glow(x, W / 2, Y + 34, 150, o.color, 0.22);
  title(x, o.name, W / 2, Y + 42, { size: 32, color: o.color, glow: o.color, glowR: 10 });
  title(x, o.sub, W / 2, Y + 64, { size: 16, body: true });
  x.font = CFONT.body(16); const ws = o.keys.map(([c, l]) => Math.max(18, c.length * 6 + 10) + 4 + x.measureText(l).width + 12);
  let cx = W / 2 - ws.reduce((p, v) => p + v, 0) / 2 + 6;
  o.keys.forEach(([c, l], i) => { const w = keyChip(x, c, cx, Y + 94); title(x, l, cx + w + 4, Y + 94, { size: 16, body: true, align: 'left', color: '#cfd6e0' }); cx += ws[i]; });
  x.restore();
}

/** Digital rain tile (sw x sh), cached; draw it twice with a slow vertical scroll. @param {number} sw @param {number} sh */
export function rainTile(sw, sh) {
  const key = 'rain' + sw + 'x' + sh; const hit = /** @type {any} */ (CACHE.get(key)); if (hit) return /** @type {HTMLCanvasElement} */ (hit.back);
  const c = document.createElement('canvas'); c.width = sw; c.height = sh; const r = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')); const R = rng(42);
  r.font = CFONT.body(16); r.textAlign = 'center'; const CH = '01アイウエオカキクケコｦｱｳｴｵ'.split('').concat('ZXQ7$#<>'.split(''));
  for (let cx = 6; cx < sw; cx += 11) { const len = 4 + Math.floor(R() * 14), head = Math.floor(R() * (sh / 13));
    for (let j = 0; j < len; j++) { const y = ((head - j) * 13 + sh * 4) % sh; const f = 1 - j / len;
      r.fillStyle = j === 0 ? 'rgba(220,255,230,0.9)' : `rgba(60,${(160 + 80 * f) | 0},100,${(0.15 + 0.6 * f).toFixed(2)})`; r.fillText(CH[Math.floor(R() * CH.length)], cx, y + 12); } }
  CACHE.set(key, /** @type {any} */ ({ back: c, top: c })); return c;
}
/** @type {Map<string, {back: HTMLCanvasElement, top: HTMLCanvasElement}>} */
const CACHE = new Map();
function rr(x, X, Y, w, h, r) { x.beginPath(); x.roundRect(X, Y, w, h, r); }
/** Slightly bulging (curved glass) rectangle path. */
function glass(x, X, Y, w, h, b) {
  x.beginPath(); x.moveTo(X + 10, Y); x.quadraticCurveTo(X + w / 2, Y - b, X + w - 10, Y); x.quadraticCurveTo(X + w, Y, X + w, Y + 10);
  x.quadraticCurveTo(X + w + b, Y + h / 2, X + w, Y + h - 10); x.quadraticCurveTo(X + w, Y + h, X + w - 10, Y + h);
  x.quadraticCurveTo(X + w / 2, Y + h + b, X + 10, Y + h); x.quadraticCurveTo(X, Y + h, X, Y + h - 10);
  x.quadraticCurveTo(X - b, Y + h / 2, X, Y + 10); x.quadraticCurveTo(X, Y, X + 10, Y); x.closePath();
}

/** Typed input line: printable keys append, Backspace deletes, Enter submits. Removed on close. */
export function typer(ov, onEnter, max = 40) {
  const st = { buf: '', on: true };
  const kd = e => {
    if (!st.on || e.code === 'Escape' || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Enter') SFX.play('ui.send', { vol: 0.4 }); else if (e.key === 'Backspace' || e.key.length === 1) SFX.play('key', { vol: 0.35, jitter: 0.1 });
    if (e.key === 'Enter') { const v = st.buf.trim(); st.buf = ''; onEnter(v); }
    else if (e.key === 'Backspace') st.buf = st.buf.slice(0, -1);
    else if (e.key.length === 1 && st.buf.length < max) st.buf += e.key;
    else return;
    e.preventDefault(); e.stopPropagation();
  };
  addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd));
  return st;
}
