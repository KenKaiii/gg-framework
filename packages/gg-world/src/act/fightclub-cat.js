// @ts-check
// Catalogue corner: "what kind of furniture defines you?" Four picks -> a personality verdict. Last verdict + count saved.
import { loop, text } from './util.js';
import { SFX } from '../sfx.js';
import { load, save, pops, BG, INK, PINK, AMBER } from './fightclub-util.js';

const QS = [
  ['Pick a coffee table', ['yin-yang glass top', 'reclaimed door', 'pizza box stack']],
  ['Pick a sofa', ['sleek 3-seater "Klipsk"', 'curbside find', 'beanbag, deflated']],
  ['Pick a lamp', ['rice-paper globe', 'bare bulb', 'monitor glow']],
  ['Pick a dinner set', ['hand-blown green glass', 'mugs only', 'the pan itself']],
];
const VERDICT = [['Complete as a person.', 'The catalogue owns you.'], ['Charming disaster.', 'Your sofa has stories.'], ['Pure vibe coder.', 'Furniture is a social construct.']];

/** @param {any} ctx */
export function startCatalogue(ctx) {
  const ov = ctx.overlay({ title: 'Furniture Quiz', sub: 'the catalogue corner', help: '<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> or <kbd>↑</kbd><kbd>↓</kbd> <kbd>enter</kbd> pick <kbd>esc</kbd> leave' });
  const W = 480, H = 270; const { x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const rec = load('cat', { last: '', n: 0 }); const P = pops();
  let q = 0, sel = 0, tally = [0, 0, 0], res = -1, pick = 0;
  const choose = (/** @type {number} */ i) => {
    if (res >= 0) { SFX.play('ui.back'); q = 0; tally = [0, 0, 0]; res = -1; return; }
    tally[i]++; P.add('+ defines you', 240, 90 + i * 40, PINK); pick = 0.3; q++; sel = 0; SFX.play('ui.click'); SFX.play('page', { delay: 0.08 });
    if (q >= QS.length) { res = tally.indexOf(Math.max(...tally)); rec.last = VERDICT[res][0]; rec.n++; save('cat', rec); SFX.play('magic', { delay: 0.2 }); }
  };
  const kd = (/** @type {KeyboardEvent} */ e) => { const d = /^Digit([1-3])$/.exec(e.code); if (d) choose(+d[1] - 1); else if (e.code === 'ArrowUp') { sel = (sel + 2) % 3; SFX.play('ui.select'); } else if (e.code === 'ArrowDown') { sel = (sel + 1) % 3; SFX.play('ui.select'); } else if (e.code === 'Enter') choose(sel); };
  addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd));
  loop(ov, (dt) => {
    pick = Math.max(0, pick - dt);
    x.fillStyle = '#e8e0cc'; x.fillRect(0, 0, W, H); x.fillStyle = BG; x.fillRect(0, 0, W, 34);
    text(x, 'HJÄLP CATALOGUE  p.' + (12 + q * 7), 16, 24, { title: true, color: '#ffe14a' });
    text(x, `quizzes ${rec.n}${rec.last ? '  last: ' + rec.last : ''}`, W - 12, 24, { color: INK, align: 'right' });
    if (res < 0) {
      text(x, QS[q][0], 240, 66, { size: 32, title: true, color: '#3a2a20', align: 'center' });
      QS[q][1].forEach((s, i) => { const y = 84 + i * 44, on = i === sel; x.fillStyle = on ? '#ffe14a' : '#f6f0e0'; x.fillRect(80 - (on ? pick * 20 : 0), y, 320, 36); x.strokeStyle = '#3a2a20'; x.strokeRect(80.5, y + 0.5, 320, 36);
        text(x, `${i + 1}. ${s}`, 96, y + 24, { color: '#2a2020' }); text(x, `${99 + i * 50 + q * 20},-`, 388, y + 24, { color: '#a02a2a', align: 'right' }); });
      text(x, `${q + 1} / ${QS.length}`, 240, 250, { color: '#5a4a30', align: 'center' });
    } else {
      text(x, VERDICT[res][0], 240, 110, { size: 32, title: true, color: '#5a2034', align: 'center' });
      text(x, VERDICT[res][1], 240, 140, { color: '#3a2a20', align: 'center' });
      text(x, 'You are not your furniture. (Probably.)', 240, 180, { color: AMBER, align: 'center' });
      text(x, 'enter: retake', 240, 240, { color: '#5a4a30', align: 'center' });
    }
    P.draw(x, dt);
  });
}
