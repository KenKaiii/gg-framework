// @ts-check
// Bar darts: 3 darts, the aim drifts (you've had a few), space throws. Board-scored (bull 50, outer bull 25, rings x3/x2).
import { text, loop, mouse } from './util.js';
import { PAL, bg as BG, panel, badge, button, banner, title, glow, noise, particles, shaker, ease, clamp, keyChip } from './art.js';
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
  const ov = ctx.overlay({ title: 'Darts', sub: 'bar, SW corner · 3 darts', help: '<kbd>space</kbd>/<kbd>click</kbd> throw <kbd>r</kbd>/<kbd>click</kbd> new round <kbd>esc</kbd> leave' });
  const { x, c } = ov.canvas(320, 180); x.imageSmoothingEnabled = false;
  const best = () => Number(localStorage.getItem('nr.darts.best') || 0);
  let darts = [], total = 0, pop = null, shake = 0, fly = null, seed = Math.random() * 100;
  const throwDart = t => {
    if (darts.length >= 3 || fly) return;
    const ax = Math.sin(t * 1.7 + seed) * 46 + Math.sin(t * 4.3) * 10, ay = Math.cos(t * 1.3 + seed) * 40 + Math.sin(t * 3.1) * 8;
    fly = { tx: ax, ty: ay, k: 0 }; SFX.play('swoosh', { vol: 0.4 });
  };
  let now = 0;
  const onKey = e => { if (e.code === 'Space') { e.preventDefault(); throwDart(now); } if (e.code === 'KeyR') again(); };
  const again = () => { if (darts.length === 3 && !fly) { darts = []; total = 0; pop = null; SFX.play('shuffle', { vol: 0.4 }); } };
  // ---- art: cached pub wall + board, kit HUD, start + result cards ----
  const W = 320, H = 180, off = (w, h, f) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; f(/** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'))); return cv; };
  const BACK = off(W, H, g => {
    BG.room(g, W, H, { wall: '#3a2420', floor: '#3a2618', horizon: 0.93, lightX: CX, lightY: CY - 30, lightR: 150, light: '#ffcf8a' });
    for (let i = 8; i < W; i += 40) { g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(i, 0, 2, H * 0.9); } // brick-ish piers
    // cabinet doors around the board
    g.fillStyle = '#2a1810'; g.fillRect(CX - RB - 30, CY - RB - 22, (RB + 30) * 2, (RB + 22) * 2);
    g.fillStyle = '#5a3a26'; g.fillRect(CX - RB - 27, CY - RB - 19, (RB + 27) * 2, (RB + 19) * 2); noise(g, CX - RB - 27, CY - RB - 19, (RB + 27) * 2, (RB + 19) * 2, 0.06, 5);
    g.fillStyle = 'rgba(255,220,170,0.25)'; g.fillRect(CX - RB - 27, CY - RB - 19, (RB + 27) * 2, 1);
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.beginPath(); g.arc(CX + 3, CY + 5, RB + 13, 0, 7); g.fill();
    const ring = (r, c) => { g.fillStyle = c; g.beginPath(); g.arc(CX, CY, r, 0, Math.PI * 2); g.fill(); };
    ring(RB + 12, '#141010'); ring(RB, '#c8322a');
    for (let i = 0; i < 20; i++) { const a0 = (i / 20 - 1 / 40) * Math.PI * 2 - Math.PI / 2; g.fillStyle = i % 2 ? '#e8dcc0' : '#151515'; g.beginPath(); g.moveTo(CX, CY); g.arc(CX, CY, RB * 0.92, a0, a0 + Math.PI / 10); g.fill(); }
    for (let i = 0; i < 20; i++) { const a0 = (i / 20 - 1 / 40) * Math.PI * 2 - Math.PI / 2; g.fillStyle = i % 2 ? '#2a7a4a' : '#c8322a'; g.beginPath(); g.arc(CX, CY, RB * 0.63, a0, a0 + Math.PI / 10); g.arc(CX, CY, RB * 0.55, a0 + Math.PI / 10, a0, true); g.fill();
      g.beginPath(); g.arc(CX, CY, RB, a0, a0 + Math.PI / 10); g.arc(CX, CY, RB * 0.92, a0 + Math.PI / 10, a0, true); g.fill(); }
    ring(RB * 0.14, '#2a7a4a'); ring(RB * 0.06, '#c8322a');
    noise(g, CX - RB, CY - RB, RB * 2, RB * 2, 0.08, 9); // sisal
    g.strokeStyle = 'rgba(210,214,224,0.55)'; g.lineWidth = 0.6; // spider wire
    for (const r of [0.06, 0.14, 0.55, 0.63, 0.92, 1]) { g.beginPath(); g.arc(CX, CY, RB * r, 0, 7); g.stroke(); }
    for (let i = 0; i < 20; i++) { const a = (i / 20 - 1 / 40) * Math.PI * 2 - Math.PI / 2; g.beginPath(); g.moveTo(CX + Math.cos(a) * RB * 0.14, CY + Math.sin(a) * RB * 0.14); g.lineTo(CX + Math.cos(a) * RB, CY + Math.sin(a) * RB); g.stroke(); }
    NUM.forEach((n, i) => { const a = i / 20 * Math.PI * 2 - Math.PI / 2; text(g, String(n), CX + Math.cos(a) * (RB + 6), CY + Math.sin(a) * (RB + 6) + 4, { size: 16, color: '#f3e6cc', align: 'center' }); });
    const v = g.createRadialGradient(CX, CY, 40, CX, CY, 220); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.5)'); g.fillStyle = v; g.fillRect(0, 0, W, H);
  });
  const fx = particles(), shk = shaker(); let shown = 0, endT = -1, hot = '', intro = 0, btns = /** @type {any[]} */ ([]), lastT = -1;
  const dart = (X, Y, s = 1) => { x.fillStyle = 'rgba(0,0,0,0.4)'; x.fillRect(X + 1, Y + 1, 2, 2); x.fillStyle = '#c8ccd8'; x.fillRect(X - 1, Y - 1, 3, 3); x.fillStyle = '#5a6270'; x.fillRect(X + 1, Y - 3 * s, 2, 3 * s);
    x.fillStyle = PAL.pink; x.beginPath(); x.moveTo(X + 2, Y - 3 * s); x.lineTo(X + 2 + 5 * s, Y - 8 * s); x.lineTo(X + 2 + 2 * s, Y - 3 * s); x.lineTo(X + 2 - 3 * s, Y - 8 * s); x.closePath(); x.fill(); };
  const ui = new Set(['again', 'leave']);
  mouse(ov, c, W, H).set([{ x: 0, y: 0, w: W, h: H, pick: () => { if (darts.length === 3 && !fly) { const b = btns.find(b => b.hit); if (b?.id === 'leave') ov.close(); else if (b?.id === 'again' || !b) again(); } else throwDart(now); } }]);
  c.addEventListener('pointermove', e => { const r = c.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * W, py = (e.clientY - r.top) / r.height * H; hot = ''; for (const b of btns) { b.hit = px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h; if (b.hit) hot = b.id; } });
  void ui;
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  loop(ov, (dt, t) => {
    now = t; shake = Math.max(0, shake - dt * 3);
    if (fly && (fly.k += dt * 5) >= 1) { const s = score(fly.tx, fly.ty); darts.push({ x: fly.tx, y: fly.ty }); total += s.pts; pop = { ...s, t: 0, x: fly.tx, y: fly.ty }; shake = s.pts >= 25 ? 1 : 0.4; fly = null; SFX.play('dart', { vol: s.pts ? 0.7 : 0.4 }); if (s.pts >= 25) SFX.play('score', { delay: 0.1 }); if (darts.length === 3) SFX.play(total >= 60 ? 'success' : 'tick', { delay: 0.3 });
      if (darts.length === 3 && total > best()) { localStorage.setItem('nr.darts.best', String(total)); pop.best = true; } }
    const dt2 = lastT < 0 ? 0 : Math.min(0.05, t - lastT); lastT = t; intro += dt2; shown += (total - shown) * Math.min(1, dt2 * 10); if (Math.abs(total - shown) < 0.5) shown = total;
    if (pop && pop.t === 0) { if (pop.pts >= 25) { fx.burst(CX + pop.x, CY + pop.y, { n: 24, colors: [PAL.pink, PAL.gold, PAL.goldHi] }); shk.kick(4); } else if (pop.pts) { fx.burst(CX + pop.x, CY + pop.y, { n: 8, speed: 40 }); shk.kick(1.5); } else shk.kick(3); }
    x.save(); shk.apply(x, dt2);
    x.drawImage(BACK, 0, 0); glow(x, CX, CY - 40, 90, '#ffcf8a', 0.08 + Math.sin(t * 1.2) * 0.02);
    for (const d of darts) dart(CX + d.x, CY + d.y);
    if (fly) { const s = 1 + (1 - fly.k) * 2.5; dart(CX + fly.tx, CY + fly.ty, s); }
    if (darts.length < 3 && !fly) { const ax = Math.sin(t * 1.7 + seed) * 46 + Math.sin(t * 4.3) * 10, ay = Math.cos(t * 1.3 + seed) * 40 + Math.sin(t * 3.1) * 8;
      glow(x, CX + ax, CY + ay, 12, '#6ee7a0', 0.35); x.strokeStyle = '#0a2a18'; x.lineWidth = 3; const cr = () => { x.beginPath(); x.arc(CX + ax + 0.5, CY + ay + 0.5, 5, 0, Math.PI * 2); x.moveTo(CX + ax - 8, CY + ay + 0.5); x.lineTo(CX + ax + 9, CY + ay + 0.5); x.moveTo(CX + ax + 0.5, CY + ay - 8); x.lineTo(CX + ax + 0.5, CY + ay + 9); x.stroke(); }; cr(); x.strokeStyle = '#6ee7a0'; x.lineWidth = 1; cr(); }
    fx.draw(x, dt2);
    if (pop && (pop.t += dt) < 1.4 && endT < 0) title(x, (pop.pts ? '+' + pop.pts + ' ' : '') + pop.tag, CX + pop.x, CY + pop.y - 10 - pop.t * 14, { size: 16, body: true, color: pop.pts >= 25 ? PAL.pink : PAL.green });
    x.restore();
    badge(x, 4, 4, 'score', Math.round(shown), { color: PAL.green, w: 62, style: 'wood' }); badge(x, 4, 42, 'best', best(), { color: PAL.gold, w: 62, style: 'wood' });
    panel(x, W - 70, 4, 66, 34, { style: 'wood', r: 3 }); title(x, 'DARTS', W - 63, 17, { size: 16, body: true, align: 'left', color: PAL.dim });
    for (let i = 0; i < 3; i++) { x.globalAlpha = i < 3 - darts.length - (fly ? 1 : 0) ? 1 : 0.2; dart(W - 58 + i * 18, 31); } x.globalAlpha = 1;
    if (intro < 3 && darts.length === 0 && !fly) { x.globalAlpha = clamp(3 - intro, 0, 1); const k = ease.outBack(clamp(intro / 0.4, 0, 1)); x.save(); x.translate(CX, H - 22); x.scale(k, k); x.translate(-CX, -(H - 22));
      panel(x, CX - 100, H - 46, 200, 42, { style: 'paper' }); let X = CX - 72; X += keyChip(x, 'SPACE', X, H - 12) + 4; title(x, 'or click: throw', X, H - 12, { size: 16, body: true, align: 'left', color: PAL.paperInk, ink: 'rgba(255,255,255,0.4)' });
      title(x, 'the aim drifts. time it.', CX, H - 30, { size: 16, body: true, color: '#7a4a22', ink: 'rgba(255,255,255,0.3)' }); x.restore(); x.globalAlpha = 1; }
    btns = [];
    if (darts.length === 3 && !fly) {
      if (endT < 0) { endT = 0; if (pop?.best) fx.confetti(W); }
      endT += dt2; banner(x, W, H - 40, pop?.best ? 'NEW BEST' : total >= 60 ? 'NICE ROUND' : 'ROUND OVER', total + ' points', endT, { color: pop?.best ? PAL.gold : total >= 60 ? PAL.green : PAL.cream, style: 'wood' });
      if (endT > 0.4) { btns.push({ id: 'again', ...button(x, CX - 92, 132, 88, 24, 'PLAY AGAIN', { primary: true, hot: hot === 'again' }) }, { id: 'leave', ...button(x, CX + 4, 132, 88, 24, 'LEAVE', { hot: hot === 'leave' }) }); }
    } else endT = -1;
  });
}
