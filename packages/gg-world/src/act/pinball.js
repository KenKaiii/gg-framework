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
      help: '<kbd>Z</kbd><kbd>←</kbd> left · <kbd>M</kbd><kbd>→</kbd> right · hold <kbd>space</kbd> plunger · <kbd>↑</kbd> nudge · <kbd>esc</kbd> leave · <kbd>hold click</kbd> left/right half flips + plunger' });
    const k = keys(ov);
    const { c, x } = ov.canvas(240, 432); x.imageSmoothingEnabled = false;
    const game = pinball({ x, keys: k, rand: rng((Date.now() & 0xffff) + 1), onSub: s => ov.setSub(s) });
    const tap = e => game.tap(e.code); addEventListener('keydown', tap); ov.onClose(() => removeEventListener('keydown', tap));
    // mouse: hold on the left/right half = that flipper (and the plunger, like holding space)
    const held = new Map();
    let btns = [];
    const at = e => { const r = c.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * 240, py = (e.clientY - r.top) / r.height * 432; return btns.find(b => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h); };
    c.addEventListener('pointermove', e => game.hover(at(e)?.id || ''));
    const pdown = e => { if (e.button !== 0) return; e.preventDefault();
      if (game.over) { const b = at(e); if (b?.id === 'leave') ov.close(); else if (b?.id === 'play') game.replay(); return; } const r = c.getBoundingClientRect(); const code = e.clientX - r.left < r.width / 2 ? 'ArrowLeft' : 'ArrowRight';
      held.set(e.pointerId, code); k.add(code); k.add('Space'); c.setPointerCapture?.(e.pointerId); };
    const pup = e => { const code = held.get(e.pointerId); if (!code) return; held.delete(e.pointerId); if (![...held.values()].includes(code)) k.delete(code); if (!held.size) k.delete('Space'); };
    c.addEventListener('pointerdown', pdown); c.addEventListener('pointerup', pup); c.addEventListener('pointercancel', pup); c.style.cursor = 'pointer';
    if (typeof (/** @type {any} */ (globalThis)).__actIds === 'function') /** @type {any} */ (globalThis).__pinball = game; ov.onClose(() => { /** @type {any} */ (globalThis).__pinball = null; }); // test hook
    loop(ov, (dt, t) => { game.update(dt); btns = game.draw(t) || []; });
  },
}];
