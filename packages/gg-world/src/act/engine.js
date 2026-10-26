// @ts-check
// The Engine Room explainer cards: one activity per station (see act/engine-cards.js for text + diagrams).
import { loop, mouse } from './util.js';
import { bg, panel, title, button, PAL } from './art.js';
import { CFONT } from '../fonts.js';
import { CARDS } from './engine-cards.js';

/** @param {any} card */
const start = card => (/** @type {any} */ ctx) => {
  const ov = ctx.overlay({ title: card.name, sub: 'GG Coder engine room', help: '<kbd>esc</kbd> <kbd>click</kbd> close' });
  const W = 480, H = 320; const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const M = mouse(ov, c, W, H); let hot = false;
  M.set([{ x: 190, y: 288, w: 100, h: 24, hover: () => { hot = true; }, pick: () => ov.close() }]);
  c.addEventListener('pointermove', () => { hot = false; }, { capture: true });
  loop(ov, (dt, t) => {
    bg.vignette(x, W, H, '#241a16', '#4a3022');
    title(x, card.name, W / 2, 30, { size: 32, color: PAL.gold, glow: PAL.goldD });
    title(x, card.tag, W / 2, 48, { size: 16, body: true, color: PAL.dim });
    panel(x, 14, 56, W - 28, 112, { style: 'metal' });
    x.save(); card.draw(x, 22, 62, W - 44, 100, t); x.restore();
    panel(x, 14, 174, W - 28, 108, { style: 'paper' });
    x.save(); x.font = CFONT.body(16); x.fillStyle = PAL.paperInk; x.textAlign = 'left';
    let y = 190; for (const l of card.lines) { const words = l.split(' '); let cur = '', first = true;
      const out = (s) => { x.fillText((first ? '· ' : '  ') + s, 24, y); y += 13; first = false; };
      for (const w of words) { const n = cur ? cur + ' ' + w : w; if (x.measureText('  ' + n).width > W - 60) { out(cur); cur = w; } else cur = n; }
      out(cur); y += 2; }
    x.restore();
    button(x, 190, 288, 100, 24, 'Close', { primary: true, hot });
  });
};
const at = (/** @type {string} */ id) => (/** @type {any} */ it, /** @type {any} */ R) => R.id === 'engine' && it.id === id;
export default CARDS.map(cd => ({ id: 'engine-' + cd.id, match: at(cd.id), label: () => cd.name, start: start(cd) }));
