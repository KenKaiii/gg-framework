// @ts-check
// Oregon Commit: get your feature from Localhost to Production in 6 legs. Each leg pick 1 of 3; random fates.
// Wins counted and saved; "You died of a merge conflict."
import { SFX } from '../sfx.js';
import { loop, text, rng } from './util.js';
import { crt } from './films-a-crt.js';
import { store, closeUp } from './computer-util.js';

const STOPS = ['Localhost', 'Feature Branch', 'Code Review', 'CI Pipeline', 'Staging', 'Friday Deploy', 'PRODUCTION'];
const OPTS = [['Rest (write tests)', 0.1], ['Push on (small commit)', 0.22], ['Ford the river (force push)', 0.55]];
const DEATHS = ['You died of a merge conflict.', 'You died of dysentery (npm install).', 'Your oxen ate the lockfile.', 'You died of scope creep.', 'Lost in node_modules. Forever.'];

/** @param {any} ctx */
export function startTrail(ctx) {
  const ov = ctx.overlay({ title: 'Oregon Commit', sub: 'LAN corner PC', help: '<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> choose <kbd>enter</kbd> new run <kbd>esc</kbd> leave' });
  closeUp(ctx, ov, -4.6, 0.6, 5.2, 1.6);
  const W = 480, H = 270; const { x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const r = rng((Date.now() & 0xffffff) + 1);
  let g; const reset = () => { g = { leg: 0, hp: 3, log: ['Your party: you, an agent, 3 coffees.'], over: '', flash: 0 }; }; reset();
  const choose = n => { if (g.over) return; const [, risk] = OPTS[n]; SFX.play('key');
    if (n === 0) g.hp = Math.min(3, g.hp + 1);
    if (r() < risk) { g.hp--; g.flash = 0.6; SFX.play(n === 2 ? 'splash' : 'arcade.boom', { vol: 0.5, delay: 0.1 }); g.log.push(['A wild bug appears! -1 coffee.', 'Flaky test bites you. -1 coffee.', 'Reviewer: "nit". -1 coffee.'][Math.floor(r() * 3)]); }
    else { g.leg++; SFX.play(n === 0 ? 'espresso' : 'blip', { delay: 0.1, vol: 0.6 }); g.log.push('You reach ' + STOPS[g.leg] + '.'); }
    if (g.hp <= 0) { g.over = DEATHS[Math.floor(r() * DEATHS.length)]; SFX.play('fail', { delay: 0.35 }); }
    else if (g.leg >= STOPS.length - 1) { g.over = 'win'; SFX.play('win', { delay: 0.35 }); store('trailWins', (Number(store('trailWins')) || 0) + 1); }
    if (g.log.length > 5) g.log.shift(); };
  const onKey = e => { const m = /^(Digit|Numpad)([1-3])$/.exec(e.code); if (m) choose(+m[2] - 1); if (e.code === 'Enter') { reset(); SFX.play('pc.boot', { vol: 0.5 }); } };
  const cap = e => { if (e.code !== 'Escape') { e.stopPropagation(); onKey(e); } };
  addEventListener('keydown', cap, true); ov.onClose(() => removeEventListener('keydown', cap, true));
  loop(ov, dt => { g.flash = Math.max(0, g.flash - dt);
    crt(x, W, H, (sx, sy, sw) => { const G = '#6ee7a0';
      // trail strip
      const y0 = sy + 22; x.fillStyle = '#2f7a52'; x.fillRect(sx + 12, y0, sw - 24, 2);
      STOPS.forEach((_, i) => { x.fillStyle = i <= g.leg ? G : '#2f7a52'; x.fillRect(sx + 12 + i * (sw - 28) / 6, y0 - 3, 4, 8); });
      const wx = sx + 10 + g.leg * (sw - 28) / 6; x.fillStyle = '#e0a458'; x.fillRect(wx, y0 - 10, 10, 6); x.fillRect(wx + 1, y0 - 4, 2, 2); x.fillRect(wx + 7, y0 - 4, 2, 2);
      text(x, 'Next: ' + (STOPS[g.leg + 1] || '-') + '   coffee ' + '#'.repeat(Math.max(0, g.hp)) + '   wins ' + (store('trailWins') || 0), sx + 10, sy + 44, { color: G });
      g.log.forEach((l, i) => text(x, l, sx + 10, sy + 64 + i * 15, { color: i === g.log.length - 1 ? '#ffcf8a' : '#2f9a62' }));
      if (g.over === 'win') text(x, 'SHIPPED TO PRODUCTION! enter = again', sx + 10, sy + 160, { color: '#ffcf8a' });
      else if (g.over) text(x, g.over + ' (enter)', sx + 10, sy + 160, { color: '#ff8080' });
      else OPTS.forEach(([o], i) => text(x, (i + 1) + ') ' + o, sx + 10 + i * 0, sy + 144 + i * 14 - 14, { color: G }));
    }, { flash: g.flash * 0.4, glow: g.flash ? '#ff6b6b' : undefined });
  });
}
