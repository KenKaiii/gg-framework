// @ts-check
// "Look outside" (den + bedroom windows): a little pixel skyline at night. Rain on the glass in the bedroom, the moon in
// the den, windows across the street flicker; one of them is a dev typing (green phosphor). Space wipes the fog off.
import { text, loop, rng } from './util.js';
import { SFX } from '../sfx.js';
/** @param {any} ctx */
export function startWindow(ctx) {
  const rain = ctx.R.id === 'bedroom';
  const ov = ctx.overlay({ title: 'Outside', sub: rain ? 'bedroom window · raining again' : 'den window · clear night', help: '<kbd>space</kbd> wipe the glass <kbd>esc</kbd> leave' });
  const { x } = ov.canvas(320, 180); x.imageSmoothingEnabled = false;
  const r = rng(rain ? 7 : 3), blds = []; let bx = -4;
  while (bx < 320) { const w = 18 + (r() * 30 | 0), h = 40 + (r() * 90 | 0), wins = []; for (let yy = 180 - h + 6; yy < 172; yy += 7) for (let xx = bx + 3; xx < bx + w - 3; xx += 5) if (r() < 0.35) wins.push([xx, yy, r()]); blds.push({ x: bx, w, h, wins }); bx += w + (r() * 4 | 0); }
  const dev = blds[Math.floor(blds.length / 2)].wins[2] || [150, 120, 0];
  const drops = Array.from({ length: 50 }, () => ({ x: r() * 320, y: r() * 180, v: 20 + r() * 40 }));
  let fog = 0.6, msg = 0;
  const onKey = e => { if (e.code === 'Space') { e.preventDefault(); fog = 0; msg = 2; SFX.play('squeak', { vol: 0.35 }); } };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  loop(ov, (dt, t) => {
    fog = Math.min(0.6, fog + dt * 0.04); msg = Math.max(0, msg - dt);
    const g = x.createLinearGradient(0, 0, 0, 180); g.addColorStop(0, '#0b0d1c'); g.addColorStop(1, '#2a2440'); x.fillStyle = g; x.fillRect(0, 0, 320, 180);
    if (!rain) { x.fillStyle = '#e8e4d8'; x.beginPath(); x.arc(250, 36, 12, 0, 7); x.fill(); x.fillStyle = '#0b0d1c'; x.beginPath(); x.arc(256, 32, 11, 0, 7); x.fill();
      for (let i = 0; i < 30; i++) { if ((i * 7 + (t * 2 | 0)) % 11) { x.fillStyle = '#8e9a88'; x.fillRect((i * 97) % 320, (i * 53) % 70, 1, 1); } } }
    for (const b of blds) { x.fillStyle = '#12132a'; x.fillRect(b.x, 180 - b.h, b.w, b.h);
      for (const [wx, wy, p] of b.wins) { const on = Math.sin(t * 0.3 + p * 50) > -0.6; if (on) { x.fillStyle = p > 0.85 ? '#ff4fd8' : '#e0a458'; x.globalAlpha = 0.5 + p * 0.5; x.fillRect(wx, wy, 2, 3); x.globalAlpha = 1; } } }
    x.fillStyle = (t * 2 | 0) % 2 ? '#3ddc84' : '#6ee7a0'; x.fillRect(dev[0] - 1, dev[1] - 1, 4, 5);    // someone else is shipping too
    if (rain) { x.fillStyle = 'rgba(160,180,220,.5)'; for (const d of drops) { d.y += d.v * dt; if (d.y > 180) { d.y = -6; d.x = Math.random() * 320; } x.fillRect(d.x | 0, d.y | 0, 1, 4); } }
    x.fillStyle = `rgba(140,150,170,${fog * 0.35})`; x.fillRect(0, 0, 320, 180);
    x.fillStyle = '#2a1e16'; x.fillRect(0, 0, 320, 6); x.fillRect(0, 174, 320, 6); x.fillRect(0, 0, 6, 180); x.fillRect(314, 0, 6, 180); x.fillRect(158, 0, 4, 180); x.fillRect(0, 88, 320, 4); // frame
    text(x, msg > 0 ? 'someone over there is still shipping too.' : rain ? 'rain on the glass. the city is still awake.' : 'city lights. not a single bug in sight.', 160, 166, { size: 16, color: '#e0a458', align: 'center', shadow: '#000' });
  });
}
