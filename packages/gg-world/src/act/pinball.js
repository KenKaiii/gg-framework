// @ts-check
// Pinball activity: close-up of the 'GIT PUSH --FORCE' table in the den.
import { keys, loop, rng } from './util.js';
import { pinball } from './pinball-game.js';

export default [{
  id: 'pinball', label: () => 'Play pinball',
  match: (it) => it.id === 'pinball' || it.kind === 'pinball',
  /** @param {any} ctx */
  start(ctx) {
    const ov = ctx.overlay({ title: 'GIT PUSH --FORCE', sub: 'spell DEPLOY for multipliers · don\'t drain to PROD',
      help: '<kbd>Z</kbd><kbd>←</kbd> left · <kbd>M</kbd><kbd>→</kbd> right · hold <kbd>space</kbd> plunger · <kbd>↑</kbd> nudge · <kbd>esc</kbd> leave' });
    const k = keys(ov);
    const { x } = ov.canvas(240, 432); x.imageSmoothingEnabled = false;
    const game = pinball({ x, keys: k, rand: rng((Date.now() & 0xffff) + 1), onSub: s => ov.setSub(s) });
    const tap = e => game.tap(e.code); addEventListener('keydown', tap); ov.onClose(() => removeEventListener('keydown', tap));
    loop(ov, (dt, t) => { game.update(dt); game.draw(t); });
  },
}];
