// @ts-check
// TV set renderer for the tv activities: draws a low-res screen buffer into a CRT (curved, scanlines, glow) or a
// flat panel body on a transparent canvas, so the dimmed room stays visible around the set.
import { text } from './util.js';

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')); x.imageSmoothingEnabled = false; return { c, x }; };

/** @param {'crt'|'flat'} kind */
export function makeTV(kind) {
  const crt = kind === 'crt';
  const W = crt ? 160 : 240, H = crt ? 120 : 135, K = 2;
  const CW = crt ? 400 : 500, CH = crt ? 290 : 312;
  const SX = crt ? 24 : 10, SY = crt ? 22 : 10, SW = W * K, SH = H * K;
  const buf = mk(W, H), t1 = mk(W, H), t2 = mk(W, H);
  const noise = buf.x.createImageData(W, H);
  let seed = 9;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  /** CRT barrel: squeeze rows then columns toward the centre, leaving dark curved edges. */
  const warp = () => {
    t1.x.fillStyle = '#040406'; t1.x.fillRect(0, 0, W, H); t2.x.fillStyle = '#040406'; t2.x.fillRect(0, 0, W, H);
    for (let y = 0; y < H; y++) { const v = (y + 0.5) / H * 2 - 1, w = W * (1 - 0.06 * v * v); t1.x.drawImage(buf.c, 0, y, W, 1, (W - w) / 2, y, w, 1); }
    for (let x = 0; x < W; x++) { const u = (x + 0.5) / W * 2 - 1, h = H * (1 - 0.08 * u * u); t2.x.drawImage(t1.c, x, 0, 1, H, x, (H - h) / 2, 1, h); }
    return t2.c;
  };
  const rr = (x, px, py, w, h, r) => { x.beginPath(); x.roundRect(px, py, w, h, r); };
  /**
   * @param {CanvasRenderingContext2D} x target canvas (CW×CH)
   * @param {number} t seconds
   * @param {{ ch?: number, osd?: number, stat?: number, glow?: string, shake?: number }} o
   */
  function present(x, t, o) {
    x.imageSmoothingEnabled = false; x.clearRect(0, 0, CW, CH);
    if (o.stat && o.stat > 0) { // static burst
      const d = noise.data; for (let i = 0; i < d.length; i += 4) { const g = rnd() * 255 * (0.5 + 0.5 * o.stat); d[i] = g * 0.9; d[i + 1] = g; d[i + 2] = g * 1.05; d[i + 3] = 255; }
      t1.x.putImageData(noise, 0, 0); buf.x.globalAlpha = Math.min(1, o.stat); buf.x.drawImage(t1.c, 0, 0); buf.x.globalAlpha = 1;
    }
    if (o.osd && o.osd > 0 && o.ch) { text(buf.x, 'CH ' + String(o.ch).padStart(2, '0'), W - 6, 16, { align: 'right', color: '#6ee7a0', shadow: '#0b2a18' }); }
    const glow = o.glow || '#7fc8ff';
    // ambient glow spilling from the set
    const g = x.createRadialGradient(SX + SW / 2, SY + SH / 2, 40, SX + SW / 2, SY + SH / 2, CW * 0.62);
    g.addColorStop(0, glow + '30'); g.addColorStop(1, glow + '00'); x.fillStyle = g; x.fillRect(0, 0, CW, CH);
    const sh = o.shake ? (Math.random() - 0.5) * o.shake : 0;
    x.save(); x.translate(Math.round(sh), 0);
    if (crt) {
      // plastic body
      rr(x, 4, 4, CW - 8, CH - 8, 22); x.fillStyle = '#2b2838'; x.fill();
      rr(x, 8, 8, CW - 16, CH - 16, 18); x.fillStyle = '#353144'; x.fill();
      x.fillStyle = '#1d1b26'; rr(x, SX - 8, SY - 8, SW + 16, SH + 16, 26); x.fill();
      x.save(); rr(x, SX, SY, SW, SH, 28); x.clip(); x.drawImage(warp(), SX, SY, SW, SH);
      x.fillStyle = 'rgba(0,0,0,.28)'; for (let y = SY; y < SY + SH; y += 2) x.fillRect(SX, y + 1, SW, 1); // scanlines
      const rl = (t * 40) % (SH + 60) - 30; x.fillStyle = 'rgba(255,255,255,.04)'; x.fillRect(SX, SY + rl, SW, 18); // roll bar
      const v = x.createRadialGradient(SX + SW / 2, SY + SH / 2, SH * 0.35, SX + SW / 2, SY + SH / 2, SW * 0.62);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.55)'); x.fillStyle = v; x.fillRect(SX, SY, SW, SH);
      x.globalCompositeOperation = 'lighter'; x.fillStyle = 'rgba(255,255,255,.05)'; x.beginPath(); x.ellipse(SX + SW * 0.3, SY + SH * 0.2, SW * 0.22, SH * 0.1, -0.3, 0, 7); x.fill();
      x.restore();
      // side panel: knobs, LED, badge
      const px = SX + SW + 8;
      for (let i = 0; i < 2; i++) { x.fillStyle = '#16141e'; x.beginPath(); x.arc(px + 12, SY + 30 + i * 40, 10, 0, 7); x.fill(); x.fillStyle = '#5a5668'; x.beginPath(); x.arc(px + 12, SY + 30 + i * 40, 7, 0, 7); x.fill(); const a = i ? t * 0.2 : (o.ch || 1) * 0.9; x.fillStyle = '#e0a458'; x.fillRect(px + 12 + Math.cos(a) * 5 - 1, SY + 30 + i * 40 + Math.sin(a) * 5 - 1, 2, 2); }
      x.fillStyle = '#0c0b10'; x.fillRect(px, SY + 100, 26, 18); text(x, String(o.ch || 1).padStart(2, '0'), px + 13, SY + 114, { align: 'center', color: '#ff4fd8' });
      for (let i = 0; i < 6; i++) { x.fillStyle = '#1d1b26'; x.fillRect(px + 2, SY + 140 + i * 6, 22, 2); }
      x.fillStyle = '#6ee7a0'; x.fillRect(px + 10, SY + SH - 6, 4, 3);
      text(x, 'NIGHTRON', SX + 4, CH - 10, { color: '#8a83a0' });
    } else {
      rr(x, 2, 2, CW - 4, SH + 16, 6); x.fillStyle = '#111116'; x.fill();
      x.drawImage(buf.c, SX, SY, SW, SH);
      x.fillStyle = 'rgba(0,0,0,.12)'; for (let y = SY; y < SY + SH; y += 2) x.fillRect(SX, y + 1, SW, 1);
      x.globalCompositeOperation = 'lighter'; const sg = x.createLinearGradient(SX, SY, SX + SW, SY + SH); sg.addColorStop(0, 'rgba(255,255,255,.05)'); sg.addColorStop(0.4, 'rgba(255,255,255,0)'); x.fillStyle = sg; x.fillRect(SX, SY, SW, SH); x.globalCompositeOperation = 'source-over';
      x.fillStyle = '#1e1e26'; x.fillRect(CW / 2 - 40, SH + 18, 80, 6); x.fillRect(CW / 2 - 6, SH + 18, 12, 14); x.fillRect(CW / 2 - 60, SH + 30, 120, 4);
      x.fillStyle = '#ff4fd8'; x.fillRect(CW - 18, SH + 14, 3, 2);
    }
    x.restore();
  }
  return { W, H, CW, CH, b: buf.x, present };
}
