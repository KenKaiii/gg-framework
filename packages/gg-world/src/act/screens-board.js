// @ts-check
// Basement whiteboard: "The Plan". ←→ rewrite step 2, space ticks the next step off with a marker scribble.
import { SFX } from '../sfx.js';
import { text, loop, keys } from './util.js';
const STEP2 = ['???', 'blame the intern', 'rewrite it in Rust', 'add more AI', 'pray to CI', 'git push --force', 'it works on my machine'];
/** @param {any} ctx */
export function startBoard(ctx) {
  const ov = ctx.overlay({ title: 'The Plan', sub: 'basement whiteboard', help: '<kbd>←→</kbd> rewrite step 2 <kbd>space</kbd> tick off a step <kbd>esc</kbd> leave' });
  const { x } = ov.canvas(320, 180); x.imageSmoothingEnabled = false;
  const k = keys(ov); let i = 0, ticks = 0, flash = 0, wipe = 0;
  const best = () => Number(localStorage.getItem('nr.plan.done') || 0);
  const onKey = e => {
    if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') { i = (i + (e.code === 'ArrowRight' ? 1 : STEP2.length - 1)) % STEP2.length; wipe = 0.3; ticks = Math.min(ticks, 1); SFX.play('squeak', { vol: 0.3 }); }
    if (e.code === 'Space') { e.preventDefault(); if (ticks < 3) { ticks++; flash = 0.4; SFX.play(ticks === 3 ? 'success' : 'tick', { vol: 0.5 }); if (ticks === 3) localStorage.setItem('nr.plan.done', String(best() + 1)); } else { ticks = 0; wipe = 0.3; SFX.play('swoosh', { vol: 0.3 }); } }
  };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey)); void k;
  loop(ov, (dt, t) => {
    flash = Math.max(0, flash - dt); wipe = Math.max(0, wipe - dt);
    x.fillStyle = '#2a2440'; x.fillRect(0, 0, 320, 180);           // wall
    x.fillStyle = '#8a8a90'; x.fillRect(14, 10, 292, 152);         // frame
    x.fillStyle = '#e8e4d8'; x.fillRect(18, 14, 284, 144);         // board
    x.fillStyle = '#d6d2c4'; for (let s = 0; s < 6; s++) x.fillRect(30 + s * 46, 20 + (s * 13) % 30, 30, 2); // ghost smudges
    text(x, 'THE PLAN', 160, 44, { title: true, size: 32, color: '#1b1b2f', align: 'center' });
    const lines = ['1. ship it', '2. ' + STEP2[i], '3. PROFIT'];
    lines.forEach((l, n) => {
      const y = 76 + n * 26, col = n === 1 ? '#7a1a1a' : '#1b3a2a';
      if (!(n === 1 && wipe > 0 && (t * 20 | 0) % 2)) text(x, l, 40, y, { size: 16, color: col });
      if (ticks > n) { x.strokeStyle = '#2a7a4a'; x.lineWidth = 2; x.beginPath(); x.moveTo(24, y - 5); x.lineTo(29, y); x.lineTo(36, y - 12); x.stroke(); }
    });
    if (ticks === 3) { const s = 1 + flash * 2; const w = Math.round(72 * s), h = Math.round(22 * s); x.strokeStyle = '#c8322a'; x.lineWidth = 2; x.strokeRect(240 - w / 2, 110 - h / 2, w, h); text(x, 'SHIPPED', 240, 115, { size: 16, color: '#c8322a', align: 'center' }); }
    text(x, 'plans shipped: ' + best(), 296, 142, { size: 16, color: '#5a5a66', align: 'right' });
    if (flash > 0) { x.fillStyle = `rgba(110,231,160,${flash * 0.4})`; x.fillRect(18, 14, 284, 144); }
  });
}
