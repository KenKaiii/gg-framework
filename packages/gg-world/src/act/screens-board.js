// @ts-check
// Basement whiteboard: "The Plan". ←→ rewrite step 2, space ticks the next step off with a marker scribble.
import { SFX } from '../sfx.js';
import { loop, keys, mouse } from './util.js';
import { PAL, bg as BG, panel, title, glow, noise, particles, shaker, ease, clamp, keyChip } from './art.js';
const STEP2 = ['???', 'blame the intern', 'rewrite it in Rust', 'add more AI', 'pray to CI', 'git push --force', 'it works on my machine'];
/** @param {any} ctx */
export function startBoard(ctx) {
  const ov = ctx.overlay({ title: 'The Plan', sub: 'basement whiteboard', help: '<kbd>←→</kbd> rewrite step 2 <kbd>space</kbd> tick off a step <kbd>click</kbd> step 2 rewrite · board tick <kbd>esc</kbd> leave' });
  const { c, x } = ov.canvas(320, 180); x.imageSmoothingEnabled = false;
  const k = keys(ov); let i = 0, ticks = 0, flash = 0, wipe = 0;
  const best = () => Number(localStorage.getItem('nr.plan.done') || 0);
  const onKey = e => {
    if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') { i = (i + (e.code === 'ArrowRight' ? 1 : STEP2.length - 1)) % STEP2.length; wipe = 0.3; ticks = Math.min(ticks, 1); SFX.play('squeak', { vol: 0.3 }); }
    if (e.code === 'Space') { e.preventDefault(); if (ticks < 3) { ticks++; flash = 0.4; SFX.play(ticks === 3 ? 'success' : 'tick', { vol: 0.5 }); if (ticks === 3) localStorage.setItem('nr.plan.done', String(best() + 1)); } else { ticks = 0; wipe = 0.3; SFX.play('swoosh', { vol: 0.3 }); } }
  };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey)); void k;
  const fire = code => onKey({ code, preventDefault() {} });
  mouse(ov, c, 320, 180).set([{ x: 36, y: 76 + 26 - 14, w: 230, h: 20, pick: () => fire('ArrowRight') }, { x: 18, y: 14, w: 284, h: 144, pick: () => fire('Space') }]);
  // cached: lit basement wall + aluminium-framed whiteboard with smudges, a marker tray
  const BACK = document.createElement('canvas'); BACK.width = 320; BACK.height = 180; {
    const g = /** @type {CanvasRenderingContext2D} */ (BACK.getContext('2d'));
    BG.room(g, 320, 180, { wall: '#2e3038', floor: '#2a2420', horizon: 0.97, lightY: 30, light: '#e8f0ff' });
    g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(17, 14, 292, 152);
    const fr = g.createLinearGradient(0, 10, 0, 162); fr.addColorStop(0, '#d8dce4'); fr.addColorStop(1, '#6a707c'); g.fillStyle = fr; g.fillRect(14, 10, 292, 152);
    const bd = g.createLinearGradient(18, 14, 302, 158); bd.addColorStop(0, '#fbfaf4'); bd.addColorStop(1, '#dcd8cc'); g.fillStyle = bd; g.fillRect(18, 14, 284, 144);
    g.fillStyle = 'rgba(120,130,160,0.08)'; for (let s2 = 0; s2 < 9; s2++) { g.beginPath(); g.ellipse(40 + s2 * 32, 30 + (s2 * 37) % 110, 22, 5, -0.2, 0, 7); g.fill(); } // ghost smudges
    g.fillStyle = 'rgba(255,255,255,0.5)'; g.beginPath(); g.moveTo(18, 14); g.lineTo(90, 14); g.lineTo(18, 70); g.fill(); // glare
    noise(g, 18, 14, 284, 144, 0.015, 3);
    panel(g, 90, 158, 140, 8, { style: 'metal', r: 2 }); // tray
    for (const [mx, c2] of [[110, '#2a7a4a'], [140, '#c8322a'], [170, '#2a55b8']]) { g.fillStyle = c2; g.fillRect(mx, 157, 22, 4); g.fillStyle = '#f2f2f2'; g.fillRect(mx + 18, 157, 4, 4); }
  }
  const fx = particles(), sh = shaker(); let lastTicks = 0, doneT = -1, pen = 0, intro = 0;
  loop(ov, (dt, t) => {
    flash = Math.max(0, flash - dt); wipe = Math.max(0, wipe - dt); intro += dt;
    if (ticks !== lastTicks) { if (ticks > lastTicks) { const y = 76 + (ticks - 1) * 26; fx.burst(30, y - 6, { n: 10, colors: ['#2a7a4a', PAL.green], speed: 40 }); sh.kick(ticks === 3 ? 4 : 1.5); pen = 0; } if (ticks === 3) { doneT = 0; fx.confetti(320); } else doneT = -1; lastTicks = ticks; }
    pen = Math.min(1, pen + dt * 5);
    x.save(); sh.apply(x, dt); x.drawImage(BACK, 0, 0);
    title(x, 'THE PLAN', 160, 46, { size: 32, color: '#1b1b2f', ink: 'rgba(255,255,255,0.6)' });
    x.fillStyle = '#1b1b2f'; x.fillRect(110, 52, 100, 2);
    const lines = ['1. ship it', '2. ' + STEP2[i], '3. PROFIT'];
    lines.forEach((l, n) => {
      const y = 76 + n * 26, col = n === 1 ? '#a8261a' : '#1b3a6a';
      if (!(n === 1 && wipe > 0 && (t * 20 | 0) % 2)) title(x, l, 40, y, { size: 16, body: true, align: 'left', color: col, ink: 'rgba(255,255,255,0.5)' });
      if (n === 1) { glow(x, 44 + l.length * 3, y - 4, 60, '#ff7a5a', 0.06 + Math.sin(t * 1.5) * 0.03); }
      if (ticks > n) { const k = n === ticks - 1 ? pen : 1; x.strokeStyle = '#2a7a4a'; x.lineWidth = 3; x.lineCap = 'round'; x.beginPath(); x.moveTo(23, y - 6); if (k < 0.4) x.lineTo(23 + 6 * k / 0.4, y - 6 + 6 * k / 0.4); else { x.lineTo(29, y); x.lineTo(29 + 8 * (k - 0.4) / 0.6, y - 14 * (k - 0.4) / 0.6); } x.stroke(); }
    });
    if (ticks === 3) { doneT += dt; const s2 = ease.outBack(clamp(doneT / 0.4, 0, 1)); x.save(); x.translate(240, 110); x.rotate(-0.15); x.scale(s2, s2);
      x.strokeStyle = '#c8322a'; x.lineWidth = 3; x.strokeRect(-42, -14, 84, 28); x.lineWidth = 1; x.strokeRect(-38, -10, 76, 20); title(x, 'SHIPPED', 0, 5, { size: 16, color: '#c8322a', ink: 'rgba(255,255,255,0.5)' }); x.restore(); }
    panel(x, 214, 132, 84, 22, { style: 'paper', r: 2 }); title(x, 'shipped: ' + best(), 256, 147, { size: 16, body: true, color: PAL.paperInk, ink: 'rgba(255,255,255,0.4)' });
    fx.draw(x, dt);
    if (flash > 0) { x.fillStyle = `rgba(110,231,160,${flash * 0.25})`; x.fillRect(18, 14, 284, 144); }
    x.restore();
    if (intro < 4) { x.save(); x.globalAlpha = clamp(4 - intro, 0, 1); panel(x, 24, 134, 180, 22, { style: 'glass', r: 2 }); let X = 30; X += keyChip(x, '<', X, 150) + 1; X += keyChip(x, '>', X, 150) + 3; title(x, 'step 2', X, 150, { size: 16, body: true, align: 'left' }); X += 44; X += keyChip(x, 'SPC', X, 150) + 3; title(x, 'tick', X, 150, { size: 16, body: true, align: 'left' }); x.restore(); }
  });
}
