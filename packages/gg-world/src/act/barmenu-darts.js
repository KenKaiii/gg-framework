// @ts-check
// Bar darts: 3 darts, the aim drifts (you've had a few), space throws. Board-scored (bull 50, outer bull 25, rings x3/x2).
import { text, loop } from './util.js';
import { SFX } from '../sfx.js';
const NUM = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
const CX = 160, CY = 92, RB = 70;
/** score of a hit at board offset (dx, dy) in px */
function score(dx, dy) {
  const r = Math.hypot(dx, dy) / RB; if (r > 1) return { pts: 0, tag: 'wall. nice.' };
  if (r < 0.06) return { pts: 50, tag: 'BULLSEYE' }; if (r < 0.14) return { pts: 25, tag: 'outer bull' };
  const a = (Math.atan2(dx, -dy) / (Math.PI * 2) + 1 + 1 / 40) % 1, n = NUM[Math.floor(a * 20)];
  if (r > 0.55 && r < 0.63) return { pts: n * 3, tag: 'treble ' + n }; if (r > 0.92) return { pts: n * 2, tag: 'double ' + n };
  return { pts: n, tag: String(n) };
}
/** @param {any} ctx */
export function startDarts(ctx) {
  const ov = ctx.overlay({ title: 'Darts', sub: 'bar, SW corner · 3 darts', help: '<kbd>space</kbd> throw <kbd>r</kbd> new round <kbd>esc</kbd> leave' });
  const { x } = ov.canvas(320, 180); x.imageSmoothingEnabled = false;
  const best = () => Number(localStorage.getItem('nr.darts.best') || 0);
  let darts = [], total = 0, pop = null, shake = 0, fly = null, seed = Math.random() * 100;
  const throwDart = t => {
    if (darts.length >= 3 || fly) return;
    const ax = Math.sin(t * 1.7 + seed) * 46 + Math.sin(t * 4.3) * 10, ay = Math.cos(t * 1.3 + seed) * 40 + Math.sin(t * 3.1) * 8;
    fly = { tx: ax, ty: ay, k: 0 }; SFX.play('swoosh', { vol: 0.4 });
  };
  let now = 0;
  const onKey = e => { if (e.code === 'Space') { e.preventDefault(); throwDart(now); } if (e.code === 'KeyR' && darts.length === 3 && !fly) { darts = []; total = 0; pop = null; SFX.play('shuffle', { vol: 0.4 }); } };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  loop(ov, (dt, t) => {
    now = t; shake = Math.max(0, shake - dt * 3);
    if (fly && (fly.k += dt * 5) >= 1) { const s = score(fly.tx, fly.ty); darts.push({ x: fly.tx, y: fly.ty }); total += s.pts; pop = { ...s, t: 0, x: fly.tx, y: fly.ty }; shake = s.pts >= 25 ? 1 : 0.4; fly = null; SFX.play('dart', { vol: s.pts ? 0.7 : 0.4 }); if (s.pts >= 25) SFX.play('score', { delay: 0.1 }); if (darts.length === 3) SFX.play(total >= 60 ? 'success' : 'tick', { delay: 0.3 });
      if (darts.length === 3 && total > best()) { localStorage.setItem('nr.darts.best', String(total)); pop.best = true; } }
    const sx = Math.round((Math.random() - 0.5) * shake * 4), sy = Math.round((Math.random() - 0.5) * shake * 4);
    x.fillStyle = '#1e2240'; x.fillRect(0, 0, 320, 180);
    x.fillStyle = '#2a2440'; for (let i = 0; i < 320; i += 16) x.fillRect(i, 0, 1, 180);           // wall planks
    x.save(); x.translate(sx, sy);
    const ring = (r, c) => { x.fillStyle = c; x.beginPath(); x.arc(CX, CY, r, 0, Math.PI * 2); x.fill(); };
    ring(RB + 12, '#111'); ring(RB, '#c8322a');
    for (let i = 0; i < 20; i++) { const a0 = (i / 20 - 1 / 40) * Math.PI * 2 - Math.PI / 2; x.fillStyle = i % 2 ? '#e8dcc0' : '#151515'; x.beginPath(); x.moveTo(CX, CY); x.arc(CX, CY, RB * 0.92, a0, a0 + Math.PI / 10); x.fill(); }
    for (const [r0, r1] of [[0.55, 0.63]]) { for (let i = 0; i < 20; i++) { const a0 = (i / 20 - 1 / 40) * Math.PI * 2 - Math.PI / 2; x.fillStyle = i % 2 ? '#2a7a4a' : '#c8322a'; x.beginPath(); x.arc(CX, CY, RB * r1, a0, a0 + Math.PI / 10); x.arc(CX, CY, RB * r0, a0 + Math.PI / 10, a0, true); x.fill(); } }
    ring(RB * 0.14, '#2a7a4a'); ring(RB * 0.06, '#c8322a');
    NUM.forEach((n, i) => { const a = i / 20 * Math.PI * 2 - Math.PI / 2; text(x, String(n), CX + Math.cos(a) * (RB + 6), CY + Math.sin(a) * (RB + 6) + 4, { size: 16, color: '#e0a458', align: 'center' }); });
    for (const d of darts) { x.fillStyle = '#ffb36b'; x.fillRect(CX + d.x - 1, CY + d.y - 1, 3, 3); x.fillStyle = '#ff4fd8'; x.fillRect(CX + d.x + 2, CY + d.y - 5, 4, 4); }
    if (fly) { const s = 1 + (1 - fly.k) * 3; x.fillStyle = '#ffb36b'; x.fillRect(CX + fly.tx - s, CY + fly.ty - s, s * 2, s * 2); }
    x.restore();
    if (darts.length < 3 && !fly) { const ax = Math.sin(t * 1.7 + seed) * 46 + Math.sin(t * 4.3) * 10, ay = Math.cos(t * 1.3 + seed) * 40 + Math.sin(t * 3.1) * 8;
      x.strokeStyle = '#6ee7a0'; x.lineWidth = 1; x.beginPath(); x.arc(CX + ax + 0.5, CY + ay + 0.5, 5, 0, Math.PI * 2); x.moveTo(CX + ax - 8, CY + ay + 0.5); x.lineTo(CX + ax + 9, CY + ay + 0.5); x.moveTo(CX + ax + 0.5, CY + ay - 8); x.lineTo(CX + ax + 0.5, CY + ay + 9); x.stroke(); }
    if (pop && (pop.t += dt) < 1.4) text(x, (pop.pts ? '+' + pop.pts + ' ' : '') + pop.tag, CX + pop.x, CY + pop.y - 10 - pop.t * 14, { size: 16, color: pop.pts >= 25 ? '#ff4fd8' : '#6ee7a0', align: 'center', shadow: '#000' });
    text(x, 'SCORE ' + total, 8, 20, { size: 16, color: '#6ee7a0' }); text(x, 'BEST ' + best(), 8, 36, { size: 16, color: '#8e9a88' });
    text(x, 'DARTS ' + '|'.repeat(3 - darts.length - (fly ? 1 : 0)), 312, 20, { size: 16, color: '#e0a458', align: 'right' });
    if (darts.length === 3 && !fly) text(x, pop?.best ? 'NEW BEST! R to go again' : 'R to go again', 160, 174, { size: 16, color: '#ffb36b', align: 'center', shadow: '#000' });
  });
}
