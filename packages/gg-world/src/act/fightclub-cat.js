// @ts-check
// Catalogue corner: "what kind of furniture defines you?" Four picks -> a personality verdict. Last verdict + count saved.
import { loop, mouse } from './util.js';
import { SFX } from '../sfx.js';
import { load, save, pops, PINK } from './fightclub-util.js';
import { PAL, bg, panel, title, glow, particles, shine } from './art.js';
import { cardFlow, cached } from './fightclub-ui.js';

const QS = [
  ['Pick a coffee table', ['yin-yang glass top', 'reclaimed door', 'pizza box stack']],
  ['Pick a sofa', ['sleek 3-seater "Klipsk"', 'curbside find', 'beanbag, deflated']],
  ['Pick a lamp', ['rice-paper globe', 'bare bulb', 'monitor glow']],
  ['Pick a dinner set', ['hand-blown green glass', 'mugs only', 'the pan itself']],
];
const VERDICT = [['Complete as a person.', 'The catalogue owns you.'], ['Charming disaster.', 'Your sofa has stories.'], ['Pure vibe coder.', 'Furniture is a social construct.']];

/** @param {any} ctx */
export function startCatalogue(ctx) {
  const ov = ctx.overlay({ title: 'Furniture Quiz', sub: 'the catalogue corner', help: '<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> or <kbd>↑</kbd><kbd>↓</kbd> <kbd>enter</kbd>/<kbd>click</kbd> pick / start / retake <kbd>esc</kbd> leave' });
  const W = 480, H = 270; const { x, c } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const rec = load('cat', { last: '', n: 0 }); const P = pops();
  let q = 0, sel = 0, tally = [0, 0, 0], res = -1, pick = 0;
  const choose = (/** @type {number} */ i) => {
    if (res >= 0) { SFX.play('ui.back'); q = 0; tally = [0, 0, 0]; res = -1; return; }
    tally[i]++; P.add('+ defines you', 240, 90 + i * 40, PINK); pick = 0.3; q++; sel = 0; SFX.play('ui.click'); SFX.play('page', { delay: 0.08 });
    fx.burst(240, 100 + i * 44, { n: 12, colors: ['#ffe14a', '#0058a3', '#fff'] });
    if (q >= QS.length) { res = tally.indexOf(Math.max(...tally)); rec.last = VERDICT[res][0]; rec.n++; save('cat', rec); SFX.play('magic', { delay: 0.2 });
      F.finish({ title: 'VERDICT', sub: VERDICT[res][0] + ' ' + VERDICT[res][1], color: ['#ffe14a', PAL.pink, PAL.cyan][res], win: true,
        stats: [['glass', tally[0], '#ffe14a'], ['curbside', tally[1], PAL.pink], ['vibe', tally[2], PAL.cyan], ['quizzes', rec.n, PAL.cream]] }); }
  };
  const kd = (/** @type {KeyboardEvent} */ e) => { if (F.phase !== 'play' || res >= 0) return; const d = /^Digit([1-3])$/.exec(e.code); if (d) choose(+d[1] - 1); else if (e.code === 'ArrowUp') { sel = (sel + 2) % 3; SFX.play('ui.select'); } else if (e.code === 'ArrowDown') { sel = (sel + 1) % 3; SFX.play('ui.select'); } else if (e.code === 'Enter') choose(sel); };
  addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd));
  // mouse: hover a card to select, click to pick; on the verdict, click anywhere to retake
  const M = mouse(ov, c, W, H); const fx = particles();
  const F = cardFlow(ov, c, W, H, { style: 'paper', accent: '#0058a3', again: () => { q = 0; tally = [0, 0, 0]; res = -1; sel = 0; } });
  F.setCard({ title: 'HJALP QUIZ', sub: 'what kind of furniture defines you?', lines: ['Four pages, three picks each. Be honest.'], chips: [['[1]', '[2]', '[3]', 'or', '[↑]', '[↓]', '[enter]'], ['[click]', 'a product']] });
  // a glossy catalogue spread: blue + yellow masthead, white page with soft gutter shading (cached)
  const page = cached(W, H, b => { bg.vignette(b, W, H, '#c8c0b0');
    panel(b, 10, 40, W - 20, H - 48, { style: 'paper', r: 2 }); const g = b.createLinearGradient(W / 2 - 18, 0, W / 2 + 18, 0); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(60,40,20,0.18)'); g.addColorStop(1, 'rgba(0,0,0,0)'); b.fillStyle = g; b.fillRect(W / 2 - 18, 42, 36, H - 52);
    b.fillStyle = '#003f7a'; b.fillRect(0, 0, W, 36); b.fillStyle = '#0058a3'; b.fillRect(0, 0, W, 33); b.fillStyle = 'rgba(255,255,255,0.15)'; b.fillRect(0, 0, W, 1); b.fillStyle = '#ffda1a'; b.fillRect(0, 33, W, 3); });
  const icon = (qi, i, X, Y) => { // tiny product drawings
    x.save(); x.translate(X, Y); x.fillStyle = PAL.ink;
    const k = qi * 3 + i, col = ['#8fd0e8', '#8a5a3a', '#c8a060', '#5a6a8a', '#9a7a5a', '#c87a3a', '#f0e6c8', '#ffe8a0', '#6ee7ff', '#7ac87a', '#c8c0b0', '#3a3a40'][k];
    x.fillRect(-10, -7, 20, 14); x.fillStyle = col; x.fillRect(-9, -6, 18, 12); x.fillStyle = 'rgba(255,255,255,0.45)'; x.fillRect(-9, -6, 18, 2); x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(-9, 3, 18, 3); x.restore(); };
  loop(ov, (dt) => { if (res >= 0 || F.phase !== 'play') M.clear(); else M.rows(i => ({ x: 80, y: 84 + i * 44, w: 320, h: 36 }), 3, { hover: i => { if (sel !== i) { sel = i; SFX.play('ui.select'); } }, pick: choose });
    pick = Math.max(0, pick - dt);
    page(x, 0, 0);
    title(x, 'HJÄLP', 16, 26, { size: 32, align: 'left', color: '#ffda1a', ink: '#002a5a' }); title(x, 'catalogue  p.' + (12 + q * 7), 108, 24, { size: 16, body: true, align: 'left', color: '#fff', ink: '#002a5a' });
    title(x, `quizzes ${rec.n}`, W - 12, 24, { size: 16, body: true, align: 'right', color: '#ffda1a', ink: '#002a5a' });
    if (res < 0) { const qq = Math.min(q, QS.length - 1);
      title(x, QS[qq][0], 240, 70, { size: 32, color: '#0058a3', ink: 'rgba(255,255,255,0.7)' });
      QS[qq][1].forEach((s2, i) => { const y = 84 + i * 44, on = i === sel, X = 80 - (on ? pick * 20 : 0);
        if (on) glow(x, 240, y + 18, 170, '#ffe14a', 0.25);
        panel(x, X, y, 320, 36, { style: on ? 'paper' : 'paper', r: 3 }); if (on) { x.fillStyle = 'rgba(255,218,26,0.35)'; x.fillRect(X + 2, y + 2, 316, 32); shine(x, X, y, 320, 36, F.t); }
        icon(qq, i, X + 22, y + 18);
        title(x, `${i + 1}. ${s2}`, X + 40, y + 23, { size: 16, body: true, align: 'left', color: PAL.paperInk, ink: 'rgba(0,0,0,0)' });
        x.fillStyle = '#ffda1a'; x.fillRect(X + 262, y + 6, 52, 24); x.fillStyle = '#e8c000'; x.fillRect(X + 262, y + 26, 52, 4);
        title(x, `${99 + i * 50 + qq * 20},-`, X + 310, y + 24, { size: 16, align: 'right', color: '#c01a1a', ink: 'rgba(0,0,0,0)' }); });
      for (let i = 0; i < QS.length; i++) { x.fillStyle = PAL.ink; x.fillRect(214 + i * 14, 240, 10, 10); x.fillStyle = i < q ? '#0058a3' : i === q ? '#ffda1a' : '#e8dcc0'; x.fillRect(215 + i * 14, 241, 8, 8); }
    }
    fx.draw(x, dt);
    P.draw(x, dt); F.draw(x, dt);
  });
}
