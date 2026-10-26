// @ts-check
// Sample activity (template for builders): opens on the basement whiteboard. Delete-safe; not part of the real set.
import { text, loop } from './util.js';
export default {
  id: '_sample', match: (it, R) => R.id === '_sample' && it.id === '_sample',
  start(ctx) {
    const ov = ctx.overlay({ title: 'The Plan', sub: 'basement whiteboard', help: '<kbd>esc</kbd> leave' });
    const { x } = ov.canvas(320, 180);
    loop(ov, (dt, t) => { x.fillStyle = '#e8e4d8'; x.fillRect(0, 0, 320, 180); text(x, 'STEP 1: ship it', 20, 40, { color: '#1b3a2a', size: 16 }); text(x, 'STEP 2: ???', 20, 64, { color: '#7a1a1a' }); text(x, 'PROFIT', 20, 100, { title: true, size: 32, color: '#1b1b2f' }); text(x, (t | 0) % 2 ? '_' : '', 140, 64, { color: '#7a1a1a' }); });
  },
};
