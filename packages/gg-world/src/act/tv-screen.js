// @ts-check
// TV set renderer for the tv activities: draws a low-res screen buffer into a CRT (curved, scanlines, glow) or a
// flat panel body on a transparent canvas, so the dimmed room stays visible around the set.
import { text } from './util.js';
import { title, glow as kglow, noise as knoise, PAL } from './art.js';

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
  // cached cabinet: moulded plastic with a top light, bevel, speaker grille, wood-grain trim (CRT) / a bezel + stand (flat)
  const BODY = mk(CW, CH); {
    const g = BODY.x;
    if (crt) {
      g.fillStyle = 'rgba(0,0,0,0.45)'; rr(g, 8, 12, CW - 10, CH - 12, 22); g.fill();
      const bg = g.createLinearGradient(0, 4, 0, CH - 4); bg.addColorStop(0, '#4a4558'); bg.addColorStop(0.5, '#34303f'); bg.addColorStop(1, '#221f2a'); g.fillStyle = bg; rr(g, 4, 4, CW - 8, CH - 8, 22); g.fill();
      g.strokeStyle = '#141219'; g.lineWidth = 2; rr(g, 5, 5, CW - 10, CH - 10, 21); g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(26, 7, CW - 52, 1);
      knoise(g, 8, 8, CW - 16, CH - 16, 0.03, 21);
      g.fillStyle = '#5a3a26'; g.fillRect(14, CH - 22, CW - 28, 8); g.fillStyle = '#8a5a3a'; g.fillRect(14, CH - 22, CW - 28, 1); for (let i = 0; i < 8; i++) { g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(20 + i * 44, CH - 20, 30, 1); }
      const bz = g.createLinearGradient(0, SY - 8, 0, SY + SH + 8); bz.addColorStop(0, '#0e0d14'); bz.addColorStop(1, '#2a2734'); g.fillStyle = bz; rr(g, SX - 8, SY - 8, SW + 16, SH + 16, 26); g.fill();
      const px = SX + SW + 8;
      for (let i = 0; i < 2; i++) { const cy = SY + 30 + i * 40; g.fillStyle = 'rgba(0,0,0,0.5)'; g.beginPath(); g.arc(px + 13, cy + 2, 11, 0, 7); g.fill(); const kg = g.createRadialGradient(px + 9, cy - 4, 1, px + 12, cy, 10); kg.addColorStop(0, '#9a94aa'); kg.addColorStop(1, '#2a2834'); g.fillStyle = kg; g.beginPath(); g.arc(px + 12, cy, 10, 0, 7); g.fill(); }
      for (let i = 0; i < 6; i++) { g.fillStyle = '#16141c'; g.fillRect(px + 2, SY + 140 + i * 6, 22, 2); g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(px + 2, SY + 142 + i * 6, 22, 1); }
      title(g, 'NIGHTRON', SX + SW + 10, CH - 30, { size: 16, body: true, align: 'left', color: PAL.goldHi });
    } else {
      g.fillStyle = 'rgba(0,0,0,0.45)'; rr(g, 4, 6, CW - 4, SH + 16, 6); g.fill();
      const bg = g.createLinearGradient(0, 2, 0, SH + 18); bg.addColorStop(0, '#2a2a34'); bg.addColorStop(1, '#0c0c10'); g.fillStyle = bg; rr(g, 2, 2, CW - 4, SH + 16, 6); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(8, 3, CW - 16, 1);
      const st = g.createLinearGradient(0, SH + 18, 0, SH + 36); st.addColorStop(0, '#5a6270'); st.addColorStop(1, '#1e1e26'); g.fillStyle = st; g.fillRect(CW / 2 - 6, SH + 18, 12, 14); rr(g, CW / 2 - 60, SH + 30, 120, 5, 2); g.fill();
    }
  }
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
    if (o.osd && o.osd > 0 && o.ch) { buf.x.globalAlpha = Math.min(1, o.osd * 2); title(buf.x, 'CH ' + String(o.ch).padStart(2, '0'), W - 6, 16, { size: 16, body: true, align: 'right', color: '#6ee7a0', ink: '#0b2a18' }); buf.x.globalAlpha = 1; }
    const glow = o.glow || '#7fc8ff';
    // ambient glow spilling from the set
    const g = x.createRadialGradient(SX + SW / 2, SY + SH / 2, 40, SX + SW / 2, SY + SH / 2, CW * 0.62);
    g.addColorStop(0, glow + '30'); g.addColorStop(1, glow + '00'); x.fillStyle = g; x.fillRect(0, 0, CW, CH);
    const sh = o.shake ? (Math.random() - 0.5) * o.shake : 0;
    x.save(); x.translate(Math.round(sh), 0);
    x.drawImage(BODY.c, 0, 0);
    if (crt) {
      x.save(); rr(x, SX, SY, SW, SH, 28); x.clip(); x.drawImage(warp(), SX, SY, SW, SH);
      x.fillStyle = 'rgba(0,0,0,.28)'; for (let y = SY; y < SY + SH; y += 2) x.fillRect(SX, y + 1, SW, 1); // scanlines
      const rl = (t * 40) % (SH + 60) - 30; x.fillStyle = 'rgba(255,255,255,.04)'; x.fillRect(SX, SY + rl, SW, 18); // roll bar
      const v = x.createRadialGradient(SX + SW / 2, SY + SH / 2, SH * 0.35, SX + SW / 2, SY + SH / 2, SW * 0.62);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.55)'); x.fillStyle = v; x.fillRect(SX, SY, SW, SH);
      x.globalCompositeOperation = 'lighter'; x.fillStyle = 'rgba(255,255,255,.05)'; x.beginPath(); x.ellipse(SX + SW * 0.3, SY + SH * 0.2, SW * 0.22, SH * 0.1, -0.3, 0, 7); x.fill();
      x.restore();
      const px = SX + SW + 8;
      for (let i = 0; i < 2; i++) { const a = i ? t * 0.2 : (o.ch || 1) * 0.9; x.fillStyle = '#ffcf8a'; x.fillRect(px + 12 + Math.cos(a) * 6 - 1, SY + 30 + i * 40 + Math.sin(a) * 6 - 1, 2, 2); }
      x.fillStyle = '#0c0b10'; x.fillRect(px, SY + 100, 26, 18); kglow(x, px + 13, SY + 109, 16, '#ff4fd8', 0.3); title(x, String(o.ch || 1).padStart(2, '0'), px + 13, SY + 114, { size: 16, body: true, color: '#ff7ad8' });
      x.fillStyle = '#6ee7a0'; x.fillRect(px + 10, SY + SH - 6, 4, 3); kglow(x, px + 12, SY + SH - 5, 8, '#6ee7a0', 0.5 + Math.sin(t * 1.5) * 0.15);
    } else {
      x.drawImage(buf.c, SX, SY, SW, SH);
      x.fillStyle = 'rgba(0,0,0,.12)'; for (let y = SY; y < SY + SH; y += 2) x.fillRect(SX, y + 1, SW, 1);
      x.globalCompositeOperation = 'lighter'; const sg = x.createLinearGradient(SX, SY, SX + SW, SY + SH); sg.addColorStop(0, 'rgba(255,255,255,.05)'); sg.addColorStop(0.4, 'rgba(255,255,255,0)'); x.fillStyle = sg; x.fillRect(SX, SY, SW, SH); x.globalCompositeOperation = 'source-over';
      x.fillStyle = '#ff4fd8'; x.fillRect(CW - 18, SH + 14, 3, 2); kglow(x, CW - 17, SH + 15, 6, '#ff4fd8', 0.5);
    }
    x.restore();
  }
  return { W, H, CW, CH, b: buf.x, present };
}
