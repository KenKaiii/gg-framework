// @ts-check
// Arcade activity: the den's arcade row plays BUG INVADERS on the cabinet screen.
import { keys, loop, rng, mouse } from './util.js';
import { bugInvaders } from './arcade-game.js';

export default [{
  id: 'arcade', label: () => 'Insert coin',
  match: (it, R) => R?.id === 'den' && it.id === 'arcade',
  /** @param {any} ctx */
  start(ctx) {
    const ov = ctx.overlay({ title: 'BUG INVADERS', sub: 'den arcade · 1 credit, on the house',
      help: '<kbd>←</kbd><kbd>→</kbd> move · <kbd>space</kbd> fire semicolons · <kbd>hold left/right side</kbd> move <kbd>click</kbd> fire · <kbd>esc</kbd> leave' });
    const k = keys(ov);
    const { x, c } = ov.canvas(320, 240); x.imageSmoothingEnabled = false;
    c.style.boxShadow = '0 0 0 10px #1a1424, 0 0 0 12px #ff4fd8, 0 0 40px 14px rgba(255,79,216,.25), 0 20px 60px rgba(0,0,0,.6)'; c.style.borderRadius = '14px';
    const game = bugInvaders({ x, keys: k, rand: rng((Date.now() & 0xffff) + 7) });
    const tap = e => game.tap(e.code); addEventListener('keydown', tap); ov.onClose(() => removeEventListener('keydown', tap));
    // mouse: any click fires (and starts a game); holding on the left / right third steers like the arrow keys
    const M = mouse(ov, c, 320, 240); let held = '';
    const steer = e => { if (held) k.delete(held); held = ''; if (!(e.buttons & 1)) return; const r = c.getBoundingClientRect(), f = (e.clientX - r.left) / r.width; held = f < 1 / 3 ? 'ArrowLeft' : f > 2 / 3 ? 'ArrowRight' : ''; if (held) k.add(held); };
    let btns = [];
    const at = e => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * 320, (e.clientY - r.top) / r.height * 240]; };
    const hit = e => { const [px, py] = at(e); return btns.find(b => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h); };
    c.addEventListener('pointermove', e => { const b = hit(e); game.hover(b ? b.id : ''); c.style.cursor = b || game.mode === 'play' ? 'pointer' : ''; });
    M.set([{ x: 0, y: 0, w: 320, h: 240, pick: () => { if (game.mode === 'play') game.tap('Space'); } }]);
    c.addEventListener('pointerdown', e => { if (e.button !== 0 || game.mode === 'play') return; const b = hit(e); if (b?.id === 'leave') ov.close(); else if (b?.id === 'play' || game.mode === 'attract') game.replay(); });
    c.addEventListener('pointerdown', steer); c.addEventListener('pointermove', steer); addEventListener('pointerup', steer);
    ov.onClose(() => removeEventListener('pointerup', steer));
    loop(ov, (dt, t) => { game.update(dt); btns = game.draw(t) || []; });
  },
}];
