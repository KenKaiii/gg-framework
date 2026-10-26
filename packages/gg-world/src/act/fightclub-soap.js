// @ts-check
// Soap-making: render (hold to heat into the zone), mix (alternate ←/→), pour (hold to the line), cut (space on the marks).
// Quality -> bars -> coins via coins(S). Daily order from the date (scent + bars wanted) pays a bonus once a day.
import { loop, coins, rng, mouse } from './util.js';
import { SFX } from '../sfx.js';
import { load, save, today, pops, PINK, AMBER, GREEN, RED } from './fightclub-util.js';
import { PAL, bg, panel, title, glow, shaker, particles, shade } from './art.js';
import { cardFlow, cardboard, cached, tape } from './fightclub-ui.js';

const SCENTS = [['rose', '#f2a6c0'], ['lavender', '#b8a0e8'], ['mint', '#9ee8c0'], ['lemon', '#f0e08a'], ['tar', '#8a7a70']];
const STEPS = ['RENDER', 'MIX', 'POUR', 'CUT'];
const HELP = ['hold <kbd>space</kbd>/<kbd>mouse</kbd> to heat, release in the green', 'tap <kbd>←</kbd> <kbd>→</kbd> (or click left / right half) alternately to stir', 'hold <kbd>space</kbd>/<kbd>mouse</kbd> to pour, stop at the line', 'press <kbd>space</kbd>/<kbd>click</kbd> when the knife is on a mark'];

/** @param {any} ctx */
export function startSoap(ctx) {
  const ov = ctx.overlay({ title: 'Paper St. Soap Co.', sub: 'the workbench', help: HELP[0] + ' <kbd>esc</kbd> leave' });
  const W = 480, H = 270; const { x, c } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const day = today(), r = rng(day * 7 + 3);
  const order = { scent: SCENTS[Math.floor(r() * SCENTS.length)], bars: 6 + Math.floor(r() * 5) };
  const rec = load('soap', { day: 0, orderDone: false, batches: 0, best: 0, total: 0 });
  if (rec.day !== day) { rec.day = day; rec.orderDone = false; rec.batches = 0; }
  const wallet = coins(ctx.S), P = pops();
  /** @type {any} */ let st;
  const reset = () => { st = { step: 0, q: [], heat: 0, zone: 0.55 + r() * 0.2, hold: false, stir: 0, last: '', stirT: 6, fill: 0, line: 0.7 + r() * 0.15, knife: 0, kdir: 1, cuts: [], marks: [0.2, 0.4, 0.6, 0.8], end: false, bars: 0, pay: 0, scent: order.scent, t: 0, flash: 0 }; ov.setHelp(HELP[0] + ' <kbd>esc</kbd> leave'); };
  reset();
  const next = (/** @type {number} */ q) => { st.q.push(q); if (q > 0.6) fx.burst(240, 130, { n: q > 0.85 ? 24 : 12, colors: [st.scent[1], '#fff', PAL.cream] }); else sh.kick(4); P.add(q > 0.85 ? 'PERFECT' : q > 0.6 ? 'good' : q > 0.3 ? 'meh' : 'yikes', 240, 70, q > 0.6 ? GREEN : q > 0.3 ? AMBER : RED); st.flash = 0.6; st.step++; SFX.play(q > 0.85 ? 'success' : q > 0.6 ? 'score' : q > 0.3 ? 'tick' : 'ui.deny');
    if (st.step >= 4) finish(); else ov.setHelp(HELP[st.step] + ' <kbd>esc</kbd> leave'); };
  const finish = () => {
    const q = st.q.reduce((a, b) => a + b, 0) / 4; st.bars = Math.max(1, Math.round(q * 12)); st.end = true;
    const paid = rec.batches < 5; st.pay = paid ? st.bars * 3 : 0; let bonus = 0;
    if (paid && !rec.orderDone && st.scent === order.scent && st.bars >= order.bars) { bonus = 40; rec.orderDone = true; }
    st.bonus = bonus; st.pay += bonus; SFX.play(bonus ? 'win' : 'bubble', { delay: 0.3 }); if (st.pay) wallet.spend(-st.pay, null);
    rec.batches++; rec.best = Math.max(rec.best, st.bars); rec.total += st.bars; save('soap', rec);
    ov.setHelp('<kbd>enter</kbd>/<kbd>click</kbd> next batch <kbd>esc</kbd> leave'); fx.burst(240, 150, { n: 30, colors: [st.scent[1], PAL.cream, '#fff'] });
    F.finish({ title: st.bars + ' BARS', sub: st.pay ? 'sold +' + st.pay + 'c' + (st.bonus ? ' (order bonus!)' : '') : 'buyers are tapped out today (5 batches)', color: st.scent[1], win: st.bars >= 9 || !!st.bonus,
      stats: [['bars', st.bars, st.scent[1]], ['coins', st.pay, PAL.gold, 'c'], ['best', rec.best, PAL.cyan], ['lifetime', rec.total, PAL.cream]] });
  };
  const kd = (/** @type {KeyboardEvent} */ e) => {
    if (F.phase !== 'play') return;
    if (/Arrow|Space/.test(e.code)) e.preventDefault();
    if (st.end) { if (e.code === 'Enter') { SFX.play('ui.select'); const s = st.scent; reset(); st.scent = s; } return; }
    if (st.step === 0 && st.t < 0.01) return;
    if (st.step === 0 && st.q.length === 0 && (e.code === 'ArrowLeft' || e.code === 'ArrowRight') && st.heat === 0) { const i = SCENTS.indexOf(st.scent); st.scent = SCENTS[(i + (e.code === 'ArrowLeft' ? 4 : 1)) % 5]; SFX.play('ui.select'); return; }
    if ((st.step === 0 || st.step === 2) && e.code === 'Space' && !st.hold) { st.hold = true; SFX.play(st.step ? 'pour' : 'fire', { vol: 0.6 }); }
    if (st.step === 1 && (e.code === 'ArrowLeft' || e.code === 'ArrowRight') && e.code !== st.last) { st.last = e.code; st.stir = Math.min(1, st.stir + 0.045); SFX.play('gurgle', { vol: 0.35, pitch: e.code === 'ArrowLeft' ? 0.9 : 1.1 }); }
    if (st.step === 3 && e.code === 'Space') { const d = Math.min(...st.marks.map(m => Math.abs(m - st.knife))); st.cuts.push(st.knife); SFX.play('snap', { vol: 0.6 }); P.add(d < 0.03 ? 'clean' : 'wonky', 140 + st.knife * 200, 120, d < 0.03 ? GREEN : AMBER); if (st.cuts.length >= 4) { const err = st.cuts.reduce((a, c) => a + Math.min(...st.marks.map(m => Math.abs(m - c))), 0) / 4; next(Math.max(0, 1 - err * 12)); } }
  };
  const ku = (/** @type {KeyboardEvent} */ e) => {
    if (e.code !== 'Space' || !st.hold) return; st.hold = false;
    if (st.step === 0 && st.heat > 0) next(Math.max(0, 1 - Math.abs(st.heat - st.zone) * 6));
    else if (st.step === 2 && st.fill > 0) next(Math.max(0, 1 - Math.abs(st.fill - st.line) * 7));
  };
  addEventListener('keydown', kd); addEventListener('keyup', ku); ov.onClose(() => { removeEventListener('keydown', kd); removeEventListener('keyup', ku); });
  // mouse mirrors the keys: hold = space (heat / pour), click = space (cut), left / right half = ←/→ (stir),
  // click the scent line = next scent (before heating), click when done = next batch
  const fake = code => ({ code, preventDefault() {} });
  const pd = (/** @type {PointerEvent} */ e) => { if (e.button !== 0 || F.phase !== 'play') return; e.preventDefault(); const r = c.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * W, py = (e.clientY - r.top) / r.height * H;
    if (st.end) kd(fake('Enter'));
    else if (st.step === 0 && st.q.length === 0 && st.heat === 0 && py >= 34 && py <= 54 && px <= 240) kd(fake('ArrowRight'));
    else if (st.step === 1) kd(fake(px < W / 2 ? 'ArrowLeft' : 'ArrowRight'));
    else kd(fake('Space')); };
  const pu = () => ku(fake('Space'));
  c.addEventListener('pointerdown', pd); addEventListener('pointerup', pu); ov.onClose(() => removeEventListener('pointerup', pu));
  const M = mouse(ov, c, W, H); M.set([{ x: 0, y: 0, w: W, h: H }]);
  const fx = particles(), sh = shaker();
  const F = cardFlow(ov, c, W, H, { surface: cardboard, accent: PINK, again: () => { const s = st.scent; reset(); st.scent = s; } });
  F.setCard({ title: 'SOAP CO.', sub: 'render, mix, pour, cut. sell the bars', lines: ['Four steps; land each one in its zone.', 'Today: ' + order.bars + '+ ' + order.scent[0] + ' bars pays a +40c bonus.'], chips: [['[space]', 'hold / tap', '|', '[←]', '[→]', 'stir + scent'], ['[mouse]', 'hold / click, left / right half']] });
  const scene = cached(W, H, cx => { bg.room(cx, W, H, { wall: '#4a4440', floor: '#3a3430', horizon: 0.7, light: '#ffd8a0', lightY: 120 });
    for (let r = 0; r < 9; r++) for (let k = 0; k < 13; k++) { cx.fillStyle = (r * 5 + k * 3) % 4 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.04)'; cx.fillRect(k * 40 - (r % 2) * 20 + 1, r * 18 + 1, 38, 16); }
    // workbench top: thick planks
    const g = cx.createLinearGradient(0, 196, 0, 270); g.addColorStop(0, '#8a6040'); g.addColorStop(0.12, '#6a4630'); g.addColorStop(1, '#2a1a10'); cx.fillStyle = g; cx.fillRect(0, 196, W, 74);
    cx.fillStyle = '#a87a50'; cx.fillRect(0, 196, W, 2); for (let i = 0; i < W; i += 96) { cx.fillStyle = 'rgba(0,0,0,0.3)'; cx.fillRect(i, 198, 1, 72); } cx.fillStyle = 'rgba(0,0,0,0.25)'; cx.fillRect(0, 214, W, 1);
    // shelf with lye jars on the wall
    cx.fillStyle = '#2a1a10'; cx.fillRect(14, 100, 110, 5); cx.fillStyle = '#6a4630'; cx.fillRect(14, 98, 110, 3);
    [['#c8d8e0', 'LYE'], ['#e8c8a0', 'FAT'], ['#d8e8c8', 'OIL']].forEach(([c, l], i) => { const X = 22 + i * 34; cx.fillStyle = '#120c10'; cx.fillRect(X - 1, 69, 26, 30); cx.fillStyle = c; cx.fillRect(X, 70, 24, 28); cx.fillStyle = 'rgba(255,255,255,0.45)'; cx.fillRect(X + 3, 72, 3, 22); cx.fillStyle = '#efe2c4'; cx.fillRect(X + 3, 80, 18, 9); cx.font = '8px monospace'; cx.fillStyle = '#5a2a1a'; cx.fillText(l, X + 5, 88); });
    noise2(cx); });
  function noise2(cx) { const v = cx.createRadialGradient(240, 150, 60, 240, 150, 300); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.35)'); cx.fillStyle = v; cx.fillRect(0, 0, W, H); }
  const pot = (X, Y, w, h, fillC, lvl) => { // a dented steel pot
    x.fillStyle = '#120c10'; x.fillRect(X - 3, Y - 2, w + 6, h + 4); const g = x.createLinearGradient(X, 0, X + w, 0); g.addColorStop(0, '#5a6068'); g.addColorStop(0.3, '#b8c0c8'); g.addColorStop(0.55, '#7a828a'); g.addColorStop(1, '#3a4048'); x.fillStyle = g; x.fillRect(X, Y, w, h);
    x.fillStyle = '#d8e0e8'; x.fillRect(X - 2, Y - 2, w + 4, 3); x.fillStyle = fillC; x.fillRect(X + 3, Y + 1, w - 6, Math.max(3, lvl)); x.fillStyle = 'rgba(255,255,255,0.35)'; x.fillRect(X + 8, Y + 2, w * 0.3, 1);
    x.fillStyle = '#2a2a30'; x.fillRect(X - 10, Y + 10, 8, 4); x.fillRect(X + w + 2, Y + 10, 8, 4); };
  const meter = (X, Y, h, v, lo, hi, label) => { panel(x, X - 8, Y - 22, 32, h + 30, { style: 'metal', r: 3 }); title(x, label, X + 8, Y - 8, { size: 16, body: true });
    x.fillStyle = '#0a0808'; x.fillRect(X, Y, 16, h); x.fillStyle = 'rgba(110,231,160,0.85)'; x.fillRect(X, Y + h - hi * h, 16, (hi - lo) * h); glow(x, X + 8, Y + h - (lo + hi) / 2 * h, 20, '#6ee7a0', 0.2);
    x.fillStyle = PAL.red; x.fillRect(X - 3, Y + h - v * h - 1, 22, 3); x.fillStyle = '#fff'; x.fillRect(X - 3, Y + h - v * h - 1, 22, 1); };
  loop(ov, (dt, t) => {
    st.t += dt; st.flash = Math.max(0, st.flash - dt);
    if (!st.end && F.phase === 'play') {
      if (st.step === 0 && st.hold) st.heat = Math.min(1, st.heat + dt * 0.5);
      if (st.step === 1) { st.stirT -= dt; st.stir = Math.max(0, st.stir - dt * 0.05); if (st.stirT <= 0 || st.stir >= 1) next(st.stir); }
      if (st.step === 2 && st.hold) { st.fill = Math.min(1, st.fill + dt * 0.4); if (st.fill >= 1) { st.hold = false; next(0.1); } }
      if (st.step === 3) { st.knife += st.kdir * dt * 0.55; if (st.knife > 0.95 || st.knife < 0.05) st.kdir *= -1; }
    }
    x.save(); sh.apply(x, dt); scene(x, 0, 0);
    const col = st.scent[1];
    // order slip, taped to the wall
    x.save(); x.translate(406, 46); x.rotate(0.04); panel(x, -62, -32, 124, 66, { style: 'paper', r: 1 }); tape(x, 0, -32, 34, -0.04, 9);
    title(x, "TODAY'S ORDER", 0, -12, { size: 16, body: true, color: PAL.paperInk, ink: 'rgba(0,0,0,0)' });
    title(x, order.bars + '+ bars, ' + order.scent[0], 0, 6, { size: 16, body: true, color: '#7a2040', ink: 'rgba(0,0,0,0)' });
    title(x, rec.orderDone ? 'DELIVERED' : '+40c bonus', 0, 24, { size: 16, body: true, color: rec.orderDone ? '#2a7a4a' : '#8a5a10', ink: 'rgba(0,0,0,0)' }); x.restore();
    // step tracker: four cardboard tabs
    STEPS.forEach((sname, i) => { const on = i === st.step && !st.end, done = i < st.step || st.end, X = 12 + i * 74;
      cardboard(x, X, 10 + (on ? 0 : 3), 68, 22, { tape: false, tint: on ? '#f0c070' : done ? '#b8c890' : '#a88a68' });
      title(x, (done ? '+ ' : '') + sname, X + 34, 26 + (on ? 0 : 3), { size: 16, body: true, color: on ? PAL.goldHi : done ? PAL.green : PAL.dim }); });
    if (!st.end) { x.fillStyle = '#120c10'; x.fillRect(12, 38, 12, 12); x.fillStyle = col; x.fillRect(13, 39, 10, 10); title(x, 'scent: ' + st.scent[0] + (st.step === 0 && st.heat === 0 ? '   < > to change' : ''), 30, 49, { size: 16, body: true, align: 'left', color: col }); }
    if (st.end) { for (let i = 0; i < st.bars; i++) { const bx = 100 + (i % 6) * 48, by = 176 - Math.floor(i / 6) * 22; x.fillStyle = '#120c10'; x.fillRect(bx - 1, by - 1, 42, 20); x.fillStyle = col; x.fillRect(bx, by, 40, 18); x.fillStyle = shade(col, -0.25); x.fillRect(bx, by + 13, 40, 5); x.fillStyle = 'rgba(255,255,255,0.45)'; x.fillRect(bx + 2, by + 2, 36, 2); } }
    else if (st.step === 0) {
      const heat = st.heat; for (let i = 0; i < 5; i++) { const fh = 10 + heat * 18 + Math.sin(t * 9 + i * 2) * 4; x.fillStyle = `rgba(255,${90 + i * 25},40,${0.35 + heat * 0.6})`; x.beginPath(); x.moveTo(196 + i * 22, 202); x.quadraticCurveTo(202 + i * 22, 202 - fh * 1.4, 208 + i * 22, 202); x.fill(); }
      glow(x, 240, 196, 60 + heat * 40, '#ff8a3a', 0.2 + heat * 0.4); x.fillStyle = '#2a2a30'; x.fillRect(184, 198, 112, 6);
      pot(190, 104, 100, 72, '#e8d8a0', 10); x.fillStyle = '#18181c'; x.fillRect(186, 178, 108, 4); if (heat > 0.3) for (let i = 0; i < 4; i++) { const k = (t * 0.6 + i * 0.25) % 1; x.globalAlpha = (1 - k) * heat * 0.5; x.fillStyle = '#fff'; x.fillRect(210 + i * 18 + Math.sin(t * 2 + i) * 4, 98 - k * 40, 5, 5); x.globalAlpha = 1; }
      meter(340, 100, 92, heat, st.zone - 0.08, st.zone + 0.08, 'HEAT');
    } else if (st.step === 1) {
      pot(180, 128, 120, 68, col, 12); const a = st.last === 'ArrowLeft' ? -0.5 : 0.5; x.save(); x.translate(240, 132); x.rotate(a); x.fillStyle = '#2a1a10'; x.fillRect(-4, -72, 8, 82); x.fillStyle = '#b08a5a'; x.fillRect(-3, -71, 6, 80); x.fillStyle = '#d8b080'; x.fillRect(-3, -71, 2, 80); x.restore();
      panel(x, 130, 210, 220, 46, { style: 'metal' }); x.fillStyle = '#0a0808'; x.fillRect(142, 220, 196, 10); const gb = x.createLinearGradient(142, 0, 338, 0); gb.addColorStop(0, '#3a8a5a'); gb.addColorStop(1, PAL.green); x.fillStyle = gb; x.fillRect(142, 220, 196 * st.stir, 10);
      title(x, `TRACE ${Math.round(st.stir * 100)}%   ${st.stirT.toFixed(1)}s`, 240, 248, { size: 16, body: true });
    } else if (st.step === 2) {
      x.fillStyle = '#120c10'; x.fillRect(146, 138, 188, 64); x.fillStyle = '#6a4630'; x.fillRect(149, 141, 182, 58); x.fillStyle = '#2a1a10'; x.fillRect(154, 144, 172, 52);
      x.fillStyle = col; x.fillRect(154, 196 - st.fill * 52, 172, st.fill * 52); x.fillStyle = 'rgba(255,255,255,0.35)'; x.fillRect(154, 196 - st.fill * 52, 172, 1);
      x.fillStyle = '#fff'; x.fillRect(142, 196 - st.line * 52, 196, 2); glow(x, 240, 196 - st.line * 52, 60, '#fff', 0.15); title(x, 'LINE', 352, 202 - st.line * 52, { size: 16, body: true });
      if (st.hold) { x.fillStyle = col; x.fillRect(237, 76, 6, 196 - st.fill * 52 - 76); x.fillStyle = 'rgba(255,255,255,0.4)'; x.fillRect(238, 76, 1, 196 - st.fill * 52 - 76); }
      x.save(); x.translate(240, 60); x.rotate(st.hold ? 0.6 : 0.2); pot(-26, -20, 52, 34, col, 6); x.restore();
    } else {
      x.fillStyle = '#120c10'; x.fillRect(138, 148, 204, 44); x.fillStyle = col; x.fillRect(140, 150, 200, 40); x.fillStyle = shade(col, -0.25); x.fillRect(140, 182, 200, 8); x.fillStyle = 'rgba(255,255,255,0.4)'; x.fillRect(142, 152, 196, 2);
      for (const m of st.marks) { x.fillStyle = PAL.ink; x.fillRect(140 + m * 200 - 1, 142, 2, 7); }
      for (const c2 of st.cuts) { x.fillStyle = '#120c10'; x.fillRect(140 + c2 * 200 - 1, 150, 3, 40); }
      const kx = 140 + st.knife * 200; x.fillStyle = '#120c10'; x.fillRect(kx - 3, 98, 7, 50); const gk = x.createLinearGradient(kx - 2, 0, kx + 3, 0); gk.addColorStop(0, '#f0f4f8'); gk.addColorStop(1, '#8a929a'); x.fillStyle = gk; x.fillRect(kx - 2, 100, 5, 46);
      x.fillStyle = '#120c10'; x.fillRect(kx - 5, 80, 11, 22); x.fillStyle = '#6a3a20'; x.fillRect(kx - 4, 81, 9, 20); x.fillStyle = '#8a5a3a'; x.fillRect(kx - 4, 81, 2, 20);
    }
    fx.draw(x, dt);
    P.draw(x, dt); x.restore();
    if (st.flash > 0) { x.fillStyle = `rgba(242,166,192,${st.flash * 0.3})`; x.fillRect(0, 0, W, H); }
    F.draw(x, dt);
  });
}
