// @ts-check
// Oregon Commit: get your feature from Localhost to Production in 6 legs. Each leg pick 1 of 3; random fates.
// Wins counted and saved; "You died of a merge conflict."
import { SFX } from '../sfx.js';
import { loop, text, rng, mouse } from './util.js';
import { PAL, title, glow, banner, particles, shaker, rr } from './art.js';
import { howTo, btns } from './hackers-util.js';
import { store, closeUp, monitor } from './computer-util.js';

const STOPS = ['Localhost', 'Feature Branch', 'Code Review', 'CI Pipeline', 'Staging', 'Friday Deploy', 'PRODUCTION'];
const OPTS = [['Rest (write tests)', 0.1], ['Push on (small commit)', 0.22], ['Ford the river (force push)', 0.55]];
const DEATHS = ['You died of a merge conflict.', 'You died of dysentery (npm install).', 'Your oxen ate the lockfile.', 'You died of scope creep.', 'Lost in node_modules. Forever.'];

/** @param {any} ctx */
export function startTrail(ctx) {
  const ov = ctx.overlay({ title: 'Oregon Commit', sub: 'LAN corner PC', help: '<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd>/<kbd>click</kbd> choose <kbd>enter</kbd>/<kbd>click</kbd> new run <kbd>esc</kbd> leave' });
  closeUp(ctx, ov, -4.6, 0.6, 5.2, 1.6);
  const W = 480, H = 270; const { x, c } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const mon = monitor(W, H, 'OREGON COMMIT  LAN-PC'), fx = particles(), sh = shaker(), B2 = btns(c, W, H); let endT = 0, wx = 0, T0 = 0;
  const r = rng((Date.now() & 0xffffff) + 1);
  let g; const reset = () => { g = { leg: 0, hp: 3, log: ['Your party: you, an agent, 3 coffees.'], over: '', flash: 0 }; }; reset();
  const choose = n => { if (g.over) return; const [, risk] = OPTS[n]; SFX.play('key');
    if (n === 0) g.hp = Math.min(3, g.hp + 1);
    if (r() < risk) { g.hp--; g.flash = 0.6; sh.kick(5); SFX.play(n === 2 ? 'splash' : 'arcade.boom', { vol: 0.5, delay: 0.1 }); g.log.push(['A wild bug appears! -1 coffee.', 'Flaky test bites you. -1 coffee.', 'Reviewer: "nit". -1 coffee.'][Math.floor(r() * 3)]); }
    else { g.leg++; SFX.play(n === 0 ? 'espresso' : 'blip', { delay: 0.1, vol: 0.6 }); g.log.push('You reach ' + STOPS[g.leg] + '.'); }
    if (g.hp <= 0) { g.over = DEATHS[Math.floor(r() * DEATHS.length)]; endT = 0; sh.kick(8); SFX.play('fail', { delay: 0.35 }); }
    else if (g.leg >= STOPS.length - 1) { g.over = 'win'; endT = 0; fx.confetti(W); SFX.play('win', { delay: 0.35 }); store('trailWins', (Number(store('trailWins')) || 0) + 1); }
    if (g.log.length > 5) g.log.shift(); };
  const onKey = e => { const m = /^(Digit|Numpad)([1-3])$/.exec(e.code); if (m) choose(+m[2] - 1); if (e.code === 'Enter') { reset(); SFX.play('pc.boot', { vol: 0.5 }); } };
  const cap = e => { if (e.code !== 'Escape') { e.stopPropagation(); onKey(e); } };
  addEventListener('keydown', cap, true); ov.onClose(() => removeEventListener('keydown', cap, true));
  // mouse: click an option row (drawn at sy + 130 + i*14); when the run is over, click anywhere = new run
  const SX = 48, SY = 20, SW = 384; const M = mouse(ov, c, W, H);
  const newRun = () => { reset(); SFX.play('pc.boot', { vol: 0.5 }); };
  loop(ov, dt => { if (g.over) M.set([{ x: 0, y: 0, w: W, h: H, pick: newRun }]); else M.rows(i => ({ x: SX + 6 + i * 126, y: SY + 130, w: 120, h: 34 }), 3, { pick: choose }); g.flash = Math.max(0, g.flash - dt);
    T0 += dt; x.save(); sh.apply(x, dt);
    mon.draw(x, T0); const S = mon.scr, sx = S.x + 6, sy = S.y, sw = S.w - 12, G = '#6ee7a0', INK = '#020a04';
    const Tx = (s, X, Y, col, o = {}) => title(x, s, X, Y, { size: 16, body: true, align: 'left', color: col, ink: INK, ...o });
    if (g.flash > 0) glow(x, W / 2, H / 2, 200, '#ff6b6b', g.flash * 0.35);
    // the trail: hills, path, stops, the wagon rolling along
    const y0 = sy + 34, L = sx + 16, Wd = sw - 32; x.fillStyle = '#123a22'; x.beginPath(); x.moveTo(sx, y0 + 6); for (let k = 0; k <= 20; k++) x.lineTo(sx + k * sw / 20, y0 - 2 - Math.abs(Math.sin(k * 1.7)) * 10); x.lineTo(sx + sw, y0 + 6); x.fill();
    x.fillStyle = '#2f7a52'; x.fillRect(L, y0, Wd, 2); for (let d = L; d < L + Wd; d += 8) { x.fillStyle = '#1a4a30'; x.fillRect(d, y0 + 3, 4, 1); }
    STOPS.forEach((n, i) => { const px = L + i * Wd / 6, on = i <= g.leg; x.fillStyle = on ? G : '#2f7a52'; rr(x, px - 3, y0 - 3, 6, 8, 2); x.fill(); if (i === STOPS.length - 1) { x.fillStyle = PAL.gold; x.fillRect(px, y0 - 14, 1, 11); x.fillRect(px + 1, y0 - 14, 6, 4); } if (on) glow(x, px, y0, 8, G, 0.3); });
    wx += (L + g.leg * Wd / 6 - wx) * Math.min(1, dt * 4); const bob = Math.round(Math.sin(T0 * 6) * 0.6);
    x.fillStyle = '#f0e6c8'; x.beginPath(); x.ellipse(wx, y0 - 9 + bob, 8, 6, 0, Math.PI, 0); x.fill(); x.fillStyle = '#8a5a3a'; x.fillRect(wx - 8, y0 - 9 + bob, 16, 4); x.fillStyle = '#1a1a1a'; x.fillRect(wx - 6, y0 - 4, 3, 3); x.fillRect(wx + 3, y0 - 4, 3, 3);
    Tx('Next: ' + (STOPS[g.leg + 1] || 'done'), sx + 8, sy + 62, G);
    for (let k = 0; k < 3; k++) { const cx = sx + sw - 132 + k * 16, full = k < g.hp; x.fillStyle = full ? '#f0e6c8' : '#2a3a2e'; rr(x, cx, sy + 50, 10, 12, 2); x.fill(); x.fillStyle = full ? '#6a3a1a' : '#1a2a1e'; x.fillRect(cx + 2, sy + 52, 6, 3); x.strokeStyle = full ? '#f0e6c8' : '#2a3a2e'; x.strokeRect(cx + 10.5, sy + 53.5, 3, 4); }
    Tx('wins ' + (store('trailWins') || 0), sx + sw - 8, sy + 62, PAL.gold, { align: 'right' });
    g.log.forEach((l, i) => Tx(l, sx + 8, sy + 82 + i * 14 - (g.log.length - 3) * 0, i === g.log.length - 1 ? '#ffcf8a' : '#3aa86e'));
    if (!g.over) { const icons = ['#6ee7a0', '#8fa3ff', '#e8645a'];
      OPTS.forEach(([o, risk], i) => { const bx = SX + 6 + i * 126, by = SY + 130, hot = B2.hot(bx, by, 120, 34);
        x.fillStyle = hot ? 'rgba(110,231,160,0.22)' : 'rgba(110,231,160,0.07)'; rr(x, bx, by, 120, 34, 4); x.fill(); x.strokeStyle = hot ? G : 'rgba(110,231,160,0.3)'; rr(x, bx + 0.5, by + 0.5, 119, 33, 4); x.stroke(); if (hot) glow(x, bx + 60, by + 17, 70, G, 0.12);
        x.fillStyle = '#d8d0e8'; rr(x, bx + 4, by + 4, 13, 13, 2); x.fill(); x.font = '16px m5x7'; x.textAlign = 'center'; x.fillStyle = INK; x.fillText(String(i + 1), bx + 10, by + 15);
        const [a, b] = String(o).split(' ('); Tx(a, bx + 21, by + 15, hot ? '#fff' : G); Tx('(' + b, bx + 6, by + 29, '#a8c8b0');
        x.fillStyle = icons[i]; for (let k = 0; k < 3; k++) if (+risk > k * 0.2) rr(x, bx + 100 + k * 5, by + 8, 3, 8, 1), x.fill(); });
    } else { endT += dt; const won = g.over === 'win';
      title(x, won ? 'SHIPPED!' : 'GAME OVER', sx + 8, sy + 180, { size: 16, align: 'left', color: won ? PAL.gold : PAL.red, ink: INK, glow: won ? PAL.gold : PAL.red, glowR: 6 });
      B2.draw(x, sx + sw - 104, sy + 164, 100, 20, 'NEW RUN', { primary: true });
      if (endT < 1.6) banner(x, W, H, won ? 'PRODUCTION' : 'YOU DIED', won ? 'shipped. wins ' + (store('trailWins') || 0) : g.over, endT, { color: won ? PAL.gold : PAL.red, style: 'crt' }); }
    if (!g.over) howTo(x, W, sy + S.h - 6, [['1-3', 'choose'], ['click', 'choose'], ['enter', 'new run']]);
    fx.draw(x, dt); x.restore();
  });
}
