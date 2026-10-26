// @ts-check
// "Look outside" (den + bedroom windows): a little pixel skyline at night. Rain on the glass in the bedroom, the moon in
// the den, windows across the street flicker; one of them is a dev typing (green phosphor). Space wipes the fog off.
import { text, loop, rng, mouse } from './util.js';
import { SFX } from '../sfx.js';
import { PAL, panel, title, glow, noise, keyChip } from './art.js';
/** @param {any} ctx */
export function startWindow(ctx) {
  const rain = ctx.R.id === 'bedroom';
  const ov = ctx.overlay({ title: 'Outside', sub: rain ? 'bedroom window · raining again' : 'den window · clear night', help: '<kbd>space</kbd> wipe the glass <kbd>click</kbd> wipe <kbd>esc</kbd> leave' });
  const { c, x } = ov.canvas(320, 180); x.imageSmoothingEnabled = false;
  const r = rng(rain ? 7 : 3), blds = []; let bx = -4;
  while (bx < 320) { const w = 18 + (r() * 30 | 0), h = 40 + (r() * 90 | 0), wins = []; for (let yy = 180 - h + 6; yy < 172; yy += 7) for (let xx = bx + 3; xx < bx + w - 3; xx += 5) if (r() < 0.35) wins.push([xx, yy, r()]); blds.push({ x: bx, w, h, wins }); bx += w + (r() * 4 | 0); }
  const dev = blds[Math.floor(blds.length / 2)].wins[2] || [150, 120, 0];
  const drops = Array.from({ length: 50 }, () => ({ x: r() * 320, y: r() * 180, v: 20 + r() * 40 }));
  let fog = 0.6, msg = 0;
  // cached wooden window frame (mullions, sill, bevel) and a sky gradient, drawn once
  const mk = f => { const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180; f(/** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'))); return cv; };
  const SKY = mk(g => { const gr = g.createLinearGradient(0, 0, 0, 180); gr.addColorStop(0, '#070918'); gr.addColorStop(0.6, '#1c1a38'); gr.addColorStop(1, '#3a2a48'); g.fillStyle = gr; g.fillRect(0, 0, 320, 180); glow(g, 160, 190, 200, '#ff8a5a', 0.18); noise(g, 0, 0, 320, 180, 0.02, 4); });
  const FRAME = mk(g => {
    const bar = (X, Y, w, h) => { const gr = g.createLinearGradient(X, Y, X + (w < h ? w : 0), Y + (w < h ? 0 : h)); gr.addColorStop(0, '#7a5034'); gr.addColorStop(1, '#3a2418'); g.fillStyle = gr; g.fillRect(X, Y, w, h); g.fillStyle = 'rgba(255,220,170,0.25)'; g.fillRect(X, Y, w < h ? 1 : w, w < h ? h : 1); g.fillStyle = 'rgba(0,0,0,0.4)'; if (w < h) g.fillRect(X + w - 1, Y, 1, h); else g.fillRect(X, Y + h - 1, w, 1); };
    bar(0, 0, 320, 8); bar(0, 0, 8, 180); bar(312, 0, 8, 180); bar(157, 0, 6, 160); bar(0, 86, 320, 6);
    panel(g, -4, 156, 328, 28, { style: 'wood', r: 2 }); noise(g, 0, 0, 320, 180, 0.03, 8);
    const v = g.createRadialGradient(160, 90, 80, 160, 90, 220); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.45)'); g.fillStyle = v; g.fillRect(0, 0, 320, 180);
  });
  const onKey = e => { if (e.code === 'Space') { e.preventDefault(); fog = 0; msg = 2; SFX.play('squeak', { vol: 0.35 }); } };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  mouse(ov, c, 320, 180).set([{ x: 0, y: 0, w: 320, h: 180, pick: () => onKey({ code: 'Space', preventDefault() {} }) }]);
  loop(ov, (dt, t) => {
    fog = Math.min(0.6, fog + dt * 0.04); msg = Math.max(0, msg - dt);
    x.drawImage(SKY, 0, 0);
    if (!rain) { glow(x, 250, 36, 40, '#fff2c8', 0.25); x.fillStyle = '#e8e4d8'; x.beginPath(); x.arc(250, 36, 12, 0, 7); x.fill(); x.fillStyle = '#0a0b1c'; x.beginPath(); x.arc(256, 32, 11, 0, 7); x.fill();
      for (let i = 0; i < 30; i++) { if ((i * 7 + (t * 2 | 0)) % 11) { x.fillStyle = '#8e9a88'; x.fillRect((i * 97) % 320, (i * 53) % 70, 1, 1); } } }
    for (const b of blds) { x.fillStyle = '#12132a'; x.fillRect(b.x, 180 - b.h, b.w, b.h);
      for (const [wx, wy, p] of b.wins) { const on = Math.sin(t * 0.3 + p * 50) > -0.6; if (on) { x.fillStyle = p > 0.85 ? '#ff4fd8' : '#e0a458'; x.globalAlpha = 0.5 + p * 0.5; x.fillRect(wx, wy, 2, 3); x.globalAlpha = 1; } } }
    glow(x, dev[0] + 1, dev[1] + 1, 10, '#3ddc84', 0.4 + Math.sin(t * 2) * 0.1); x.fillStyle = (t * 0.7 | 0) % 2 ? '#3ddc84' : '#6ee7a0'; x.fillRect(dev[0] - 1, dev[1] - 1, 4, 5);    // someone else is shipping too
    if (rain) { x.fillStyle = 'rgba(160,180,220,.5)'; for (const d of drops) { d.y += d.v * dt; if (d.y > 180) { d.y = -6; d.x = Math.random() * 320; } x.fillRect(d.x | 0, d.y | 0, 1, 4); } }
    x.fillStyle = `rgba(140,150,170,${fog * 0.35})`; x.fillRect(0, 0, 320, 180);
    x.fillStyle = 'rgba(255,255,255,0.04)'; x.beginPath(); x.moveTo(20, 8); x.lineTo(70, 8); x.lineTo(20, 80); x.fill(); // glass sheen
    x.drawImage(FRAME, 0, 0);
    title(x, msg > 0 ? 'someone over there is still shipping too.' : rain ? 'rain on the glass. the city is still awake.' : 'city lights. not a single bug in sight.', 160, 172, { size: 16, body: true, color: msg > 0 ? PAL.green : PAL.cream });
    if (fog > 0.45 && !msg) { x.globalAlpha = Math.min(1, (fog - 0.45) * 8); const X0 = 108; let X = X0 + keyChip(x, 'SPACE', X0, 52) + 4; title(x, 'or click: wipe', X, 52, { size: 16, body: true, align: 'left' }); x.globalAlpha = 1; }
  });
}
