// @ts-check
// Films A helpers: CRT frame drawing, word wrap and a tiny typed-input line for terminal overlays.
import { SFX } from '../sfx.js';
import { CFONT } from '../fonts.js';
import { text } from './util.js';

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
  const bg = x.createRadialGradient(W / 2, H * 0.55, 20, W / 2, H * 0.55, W * 0.7); bg.addColorStop(0, '#1e2240'); bg.addColorStop(1, '#08080e');
  x.fillStyle = bg; x.fillRect(0, 0, W, H);
  const bx = 40, by = 8, bw = W - 80, bh = H - 34;
  x.fillStyle = '#4a3a2a'; x.fillRect(bx + 30, by + bh - 4, bw - 60, 26); // desk edge / stand
  x.fillStyle = o.beige || '#b9ae8f'; rr(x, bx, by, bw, bh, 18); x.fill();
  x.fillStyle = '#d6cdb0'; rr(x, bx + 4, by + 3, bw - 8, 6, 3); x.fill();
  x.fillStyle = '#8f8670'; rr(x, bx + 6, by + bh - 22, bw - 12, 16, 6); x.fill();
  x.fillStyle = '#3ddc84'; x.fillRect(bx + bw - 30, by + bh - 16, 4, 3); // power led
  text(x, 'OMNIVIEW 14', bx + 16, by + bh - 9, { color: '#5e5646' });
  const sx = bx + 26, sy = by + 18, sw = bw - 52, sh = bh - 48;
  x.fillStyle = '#2a2620'; glass(x, sx - 5, sy - 5, sw + 10, sh + 10, 8); x.fill();
  x.save(); glass(x, sx, sy, sw, sh, 6); x.clip();
  x.fillStyle = '#04100a'; x.fillRect(sx - 8, sy - 8, sw + 16, sh + 16);
  x.shadowColor = o.glow || '#3ddc84'; x.shadowBlur = 6; draw(sx, sy, sw, sh); x.shadowBlur = 0;
  x.fillStyle = 'rgba(0,0,0,0.28)'; for (let y = sy - 6; y < sy + sh + 6; y += 2) x.fillRect(sx - 8, y, sw + 16, 1);
  const v = x.createRadialGradient(sx + sw / 2, sy + sh / 2, sh * 0.35, sx + sw / 2, sy + sh / 2, sw * 0.62); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.75)');
  x.fillStyle = v; x.fillRect(sx - 8, sy - 8, sw + 16, sh + 16);
  x.save(); x.translate(sx + sw * 0.22, sy + sh * 0.2); x.scale(1, 0.45); const gl = x.createRadialGradient(0, 0, 0, 0, 0, sw * 0.3);
  gl.addColorStop(0, 'rgba(255,255,255,0.09)'); gl.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gl; x.fillRect(-sw * 0.3, -sw * 0.3, sw * 0.6, sw * 0.6); x.restore();
  if (o.flash) { x.fillStyle = `rgba(220,255,230,${Math.min(1, o.flash)})`; x.fillRect(sx - 8, sy - 8, sw + 16, sh + 16); }
  x.restore();
  return { sx, sy, sw, sh };
}
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
