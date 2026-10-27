// @ts-check
// Pinball activity: close-up of the 'GIT PUSH --FORCE' table in the den, rebuilt on the GX kit: the playfield is SVG at
// screen resolution (chrome rails, bumpers, moving flippers, glass) under a backbox score plate.
import { keys, loop, rng } from './util.js';
import { pinball } from './pinball-game.js';
import { gx, svg } from './gx.js';

export default [{
  id: 'pinball', label: () => 'Play pinball',
  match: (it) => it.id === 'pinball' || it.kind === 'pinball',
  /** @param {any} ctx */
  start(ctx) {
    const ov = ctx.overlay({ title: 'GIT PUSH --FORCE', sub: 'spell DEPLOY for multipliers, don\'t drain to PROD',
      help: '<kbd>Z</kbd><kbd>←</kbd> left <kbd>M</kbd><kbd>→</kbd> right hold <kbd>space</kbd> plunger <kbd>↑</kbd> nudge <kbd>hold click</kbd> left/right half flips + plunger' });
    const K = gx(ov), k = keys(ov);
    const scene = K.scene({ aspect: 268 / 492, pad: 12 });
    const root = svg('svg', { viewBox: '-14 -76 268 492', width: '100%', height: '100%', role: 'img', 'aria-label': 'Pinball table' }, scene);
    root.style.position = 'absolute'; root.style.inset = '0'; root.style.cursor = 'pointer';
    const game = pinball({ root, keys: k, rand: rng((Date.now() & 0xffff) + 1), onSub: s => ov.setSub(s), on: (ev, a) => {
      if (ev === 'pop') { const m = root.getScreenCTM(); if (m) K.pop(m.a * a.x + m.e, m.d * a.y + m.f, a.s, a.c); }
      else if (ev === 'swell') K.swell();
      else if (ev === 'over') setTimeout(() => { if (!ov.el.isConnected || !game.over) return; if (a.best) K.swell();
        K.result({ title: a.best ? 'Force push accepted' : 'Prod is down', big: a.score, best: a.best, line: 'Game over.', stats: [[a.hi.toLocaleString('en-US'), 'Best']], again: 'Play again', onAgain: () => game.replay() }); }, 900);
    } });
    const tap = e => { if (!started) return; game.tap(e.code); }; addEventListener('keydown', tap); ov.onClose(() => removeEventListener('keydown', tap));
    // mouse: hold on the left/right half = that flipper (and the plunger, like holding space)
    const held = new Map(); let started = false;
    const pdown = e => { if (e.button !== 0 || game.over || !started) return; e.preventDefault();
      const r = root.getBoundingClientRect(); const code = e.clientX - r.left < r.width / 2 ? 'ArrowLeft' : 'ArrowRight';
      held.set(e.pointerId, code); k.add(code); k.add('Space'); root.setPointerCapture?.(e.pointerId); };
    const pup = e => { const code = held.get(e.pointerId); if (!code) return; held.delete(e.pointerId); if (![...held.values()].includes(code)) k.delete(code); if (!held.size) k.delete('Space'); };
    root.addEventListener('pointerdown', pdown); root.addEventListener('pointerup', pup); root.addEventListener('pointercancel', pup);
    if (typeof (/** @type {any} */ (globalThis)).__actIds === 'function') /** @type {any} */ (globalThis).__pinball = game; ov.onClose(() => { /** @type {any} */ (globalThis).__pinball = null; }); // test hook
    loop(ov, (dt, t) => { game.update(dt); game.draw(t); });
    K.card({ title: 'Push --force', kicker: 'Pinball', text: 'Spell DEPLOY for multipliers. Three balls. Don\'t drain to prod.', how: [[['Z', 'M'], 'flippers'], [['Space'], 'hold, release: launch'], [['↑'], 'nudge'], [['Hold click'], 'left / right half']], cta: 'Play', onGo: () => { started = true; } });
  },
}];
