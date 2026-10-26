// @ts-check
// Soap-making: render (hold to heat into the zone), mix (alternate ←/→), pour (hold to the line), cut (space on the marks).
// Quality -> bars -> coins via coins(S). Daily order from the date (scent + bars wanted) pays a bonus once a day.
import { loop, text, coins, rng } from './util.js';
import { SFX } from '../sfx.js';
import { load, save, today, pops, BG, INK, PINK, AMBER, GREEN, RED } from './fightclub-util.js';

const SCENTS = [['rose', '#f2a6c0'], ['lavender', '#b8a0e8'], ['mint', '#9ee8c0'], ['lemon', '#f0e08a'], ['tar', '#8a7a70']];
const STEPS = ['RENDER', 'MIX', 'POUR', 'CUT'];
const HELP = ['hold <kbd>space</kbd> to heat, release in the green', 'tap <kbd>←</kbd> <kbd>→</kbd> alternately to stir', 'hold <kbd>space</kbd> to pour, stop at the line', 'press <kbd>space</kbd> when the knife is on a mark'];

/** @param {any} ctx */
export function startSoap(ctx) {
  const ov = ctx.overlay({ title: 'Paper St. Soap Co.', sub: 'the workbench', help: HELP[0] + ' <kbd>esc</kbd> leave' });
  const W = 480, H = 270; const { x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const day = today(), r = rng(day * 7 + 3);
  const order = { scent: SCENTS[Math.floor(r() * SCENTS.length)], bars: 6 + Math.floor(r() * 5) };
  const rec = load('soap', { day: 0, orderDone: false, batches: 0, best: 0, total: 0 });
  if (rec.day !== day) { rec.day = day; rec.orderDone = false; rec.batches = 0; }
  const wallet = coins(ctx.S), P = pops();
  /** @type {any} */ let st;
  const reset = () => { st = { step: 0, q: [], heat: 0, zone: 0.55 + r() * 0.2, hold: false, stir: 0, last: '', stirT: 6, fill: 0, line: 0.7 + r() * 0.15, knife: 0, kdir: 1, cuts: [], marks: [0.2, 0.4, 0.6, 0.8], end: false, bars: 0, pay: 0, scent: order.scent, t: 0, flash: 0 }; ov.setHelp(HELP[0] + ' <kbd>esc</kbd> leave'); };
  reset();
  const next = (/** @type {number} */ q) => { st.q.push(q); P.add(q > 0.85 ? 'PERFECT' : q > 0.6 ? 'good' : q > 0.3 ? 'meh' : 'yikes', 240, 70, q > 0.6 ? GREEN : q > 0.3 ? AMBER : RED); st.flash = 0.6; st.step++; SFX.play(q > 0.85 ? 'success' : q > 0.6 ? 'score' : q > 0.3 ? 'tick' : 'ui.deny');
    if (st.step >= 4) finish(); else ov.setHelp(HELP[st.step] + ' <kbd>esc</kbd> leave'); };
  const finish = () => {
    const q = st.q.reduce((a, b) => a + b, 0) / 4; st.bars = Math.max(1, Math.round(q * 12)); st.end = true;
    const paid = rec.batches < 5; st.pay = paid ? st.bars * 3 : 0; let bonus = 0;
    if (paid && !rec.orderDone && st.scent === order.scent && st.bars >= order.bars) { bonus = 40; rec.orderDone = true; }
    st.bonus = bonus; st.pay += bonus; SFX.play(bonus ? 'win' : 'bubble', { delay: 0.3 }); if (st.pay) wallet.spend(-st.pay, null);
    rec.batches++; rec.best = Math.max(rec.best, st.bars); rec.total += st.bars; save('soap', rec);
    ov.setHelp('<kbd>enter</kbd> next batch <kbd>←</kbd><kbd>→</kbd> scent <kbd>esc</kbd> leave');
  };
  const kd = (/** @type {KeyboardEvent} */ e) => {
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
  loop(ov, (dt, t) => {
    st.t += dt; st.flash = Math.max(0, st.flash - dt);
    if (!st.end) {
      if (st.step === 0 && st.hold) st.heat = Math.min(1, st.heat + dt * 0.5);
      if (st.step === 1) { st.stirT -= dt; st.stir = Math.max(0, st.stir - dt * 0.05); if (st.stirT <= 0 || st.stir >= 1) next(st.stir); }
      if (st.step === 2 && st.hold) { st.fill = Math.min(1, st.fill + dt * 0.4); if (st.fill >= 1) { st.hold = false; next(0.1); } }
      if (st.step === 3) { st.knife += st.kdir * dt * 0.55; if (st.knife > 0.95 || st.knife < 0.05) st.kdir *= -1; }
    }
    x.fillStyle = BG; x.fillRect(0, 0, W, H);
    x.fillStyle = '#6a4e34'; x.fillRect(0, 200, W, 70); x.fillStyle = '#7a5a3a'; x.fillRect(0, 200, W, 6);
    // order card
    x.fillStyle = '#e8e0cc'; x.fillRect(340, 14, 126, 64); text(x, 'TODAY\'S ORDER', 403, 30, { color: '#3a2a20', align: 'center' });
    text(x, `${order.bars}+ bars, ${order.scent[0]}`, 403, 48, { color: '#5a2034', align: 'center' });
    text(x, rec.orderDone ? 'DELIVERED ✓' : '+40c bonus', 403, 66, { color: rec.orderDone ? '#2a7a4a' : '#7a5a20', align: 'center' });
    STEPS.forEach((s, i) => text(x, s, 20 + i * 76, 28, { color: i === st.step && !st.end ? AMBER : i < st.step || st.end ? GREEN : '#6a6060' }));
    text(x, 'scent: ' + st.scent[0] + (st.step === 0 && !st.end && st.heat === 0 ? '  (←/→ to change)' : ''), 20, 48, { color: st.scent[1] });
    const col = st.scent[1];
    if (st.end) {
      for (let i = 0; i < st.bars; i++) { const bx = 60 + (i % 6) * 46, by = 150 - Math.floor(i / 6) * 22; x.fillStyle = col; x.fillRect(bx, by, 40, 18); x.fillStyle = 'rgba(255,255,255,0.35)'; x.fillRect(bx + 2, by + 2, 36, 3); }
      text(x, `${st.bars} bars`, 240, 100 - (st.bars > 6 ? 22 : 0), { size: 32, title: true, color: PINK, align: 'center' });
      text(x, st.pay ? `sold +${st.pay}c${st.bonus ? ' (order bonus!)' : ''}` : 'buyers are tapped out today (5 batches)', 240, 230, { color: st.pay ? '#ffe14a' : INK, align: 'center' });
      text(x, `wallet ${wallet.balance}c  best ${rec.best}  lifetime ${rec.total}`, 240, 252, { color: INK, align: 'center' });
    } else if (st.step === 0) {
      x.fillStyle = '#555'; x.fillRect(190, 120, 100, 80); x.fillStyle = '#e8d8a0'; x.fillRect(196, 120, 88, 10);
      for (let i = 0; i < 3; i++) { x.fillStyle = `rgba(255,${120 + i * 40},60,${0.4 + st.heat * 0.6})`; x.fillRect(200 + i * 28, 200 - 6 - (t * 30 + i * 7) % 10 * st.heat, 20, 6); }
      x.fillStyle = '#333'; x.fillRect(320, 90, 16, 110); x.fillStyle = GREEN; x.fillRect(320, 200 - (st.zone + 0.08) * 110, 16, 0.16 * 110);
      x.fillStyle = RED; x.fillRect(318, 198 - st.heat * 110, 20, 3); text(x, 'heat', 328, 84, { align: 'center' });
    } else if (st.step === 1) {
      x.fillStyle = '#555'; x.fillRect(180, 130, 120, 70); x.fillStyle = col; x.fillRect(186, 130, 108, 10);
      const a = st.last === 'ArrowLeft' ? -0.5 : 0.5; x.save(); x.translate(240, 135); x.rotate(a); x.fillStyle = '#a07a4a'; x.fillRect(-3, -70, 6, 80); x.restore();
      x.fillStyle = '#333'; x.fillRect(140, 216, 200, 10); x.fillStyle = GREEN; x.fillRect(140, 216, 200 * st.stir, 10); text(x, `trace ${Math.round(st.stir * 100)}%   ${st.stirT.toFixed(1)}s`, 240, 250, { align: 'center' });
    } else if (st.step === 2) {
      x.fillStyle = '#3a3030'; x.fillRect(150, 140, 180, 60); x.fillStyle = col; x.fillRect(154, 196 - st.fill * 52, 172, st.fill * 52);
      x.fillStyle = '#fff'; x.fillRect(146, 196 - st.line * 52, 188, 2); if (st.hold) { x.fillStyle = col; x.fillRect(236, 60, 8, 196 - st.fill * 52 - 60); }
      x.fillStyle = '#777'; x.fillRect(220, 40, 40, 24);
    } else {
      x.fillStyle = col; x.fillRect(140, 150, 200, 40); x.fillStyle = '#5a4a3a';
      for (const m of st.marks) x.fillRect(140 + m * 200 - 1, 144, 2, 6);
      for (const c of st.cuts) { x.fillStyle = BG; x.fillRect(140 + c * 200 - 1, 150, 2, 40); }
      x.fillStyle = '#d8d8d8'; x.fillRect(140 + st.knife * 200 - 2, 100, 4, 46); x.fillStyle = '#5a3a20'; x.fillRect(140 + st.knife * 200 - 4, 86, 8, 16);
    }
    P.draw(x, dt);
    if (st.flash > 0) { x.fillStyle = `rgba(242,166,192,${st.flash * 0.3})`; x.fillRect(0, 0, W, H); }
  });
}
