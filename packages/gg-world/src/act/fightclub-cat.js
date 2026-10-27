// @ts-check
// Catalogue corner (GX kit: a flat-pack catalogue page, three product tiles per spread): "what kind of furniture defines you?" Four picks -> a personality verdict. Last verdict + count saved.
import { SFX } from '../sfx.js';
import { load, save } from './fightclub-util.js';
import { gx } from './gx.js';

const QS = [
  ['Pick a coffee table', ['yin-yang glass top', 'reclaimed door', 'pizza box stack']],
  ['Pick a sofa', ['sleek 3-seater "Klipsk"', 'curbside find', 'beanbag, deflated']],
  ['Pick a lamp', ['rice-paper globe', 'bare bulb', 'monitor glow']],
  ['Pick a dinner set', ['hand-blown green glass', 'mugs only', 'the pan itself']],
];
const VERDICT = [['Complete as a person.', 'The catalogue owns you.'], ['Charming disaster.', 'Your sofa has stories.'], ['Pure vibe coder.', 'Furniture is a social construct.']];

const COL = ['#8fd0e8', '#8a5a3a', '#c8a060', '#5a6a8a', '#9a7a5a', '#c87a3a', '#f0e6c8', '#ffe8a0', '#6ee7ff', '#7ac87a', '#c8c0b0', '#3a3a40'];
// one product drawing per question (table, sofa, lamp, dinner set), tinted per option
const ART = [
  c => `<ellipse cx="60" cy="88" rx="44" ry="6" fill="#000" opacity=".12"/><rect x="18" y="44" width="84" height="8" rx="3" fill="${c}"/><rect x="18" y="44" width="84" height="3" rx="2" fill="#fff" opacity=".4"/><rect x="26" y="52" width="5" height="34" fill="#4a3a30"/><rect x="89" y="52" width="5" height="34" fill="#4a3a30"/>`,
  c => `<ellipse cx="60" cy="88" rx="50" ry="6" fill="#000" opacity=".12"/><rect x="16" y="34" width="88" height="34" rx="10" fill="${c}"/><rect x="10" y="50" width="100" height="26" rx="9" fill="${c}"/><rect x="10" y="50" width="100" height="26" rx="9" fill="#000" opacity=".12"/><rect x="22" y="76" width="5" height="10" fill="#333"/><rect x="93" y="76" width="5" height="10" fill="#333"/>`,
  c => `<ellipse cx="60" cy="90" rx="26" ry="5" fill="#000" opacity=".12"/><circle cx="60" cy="38" r="24" fill="${c}"/><circle cx="52" cy="30" r="9" fill="#fff" opacity=".45"/><rect x="58" y="62" width="4" height="24" fill="#555"/><rect x="44" y="84" width="32" height="5" rx="2" fill="#555"/>`,
  c => `<ellipse cx="60" cy="88" rx="46" ry="6" fill="#000" opacity=".12"/><ellipse cx="60" cy="72" rx="40" ry="12" fill="${c}"/><ellipse cx="60" cy="70" rx="28" ry="7" fill="#fff" opacity=".35"/><path d="M24 30h20l-3 34h-14z" fill="${c}"/><path d="M76 30h20l-3 34h-14z" fill="${c}"/><rect x="26" y="32" width="5" height="26" fill="#fff" opacity=".4"/>`,
];
const CSS = `
.fk-page{position:absolute;inset:0;border-radius:6px;overflow:hidden;background:#fbfaf6;color:#111;box-shadow:0 30px 60px -20px rgba(0,0,0,.85),inset 0 0 0 1px rgba(0,0,0,.08);display:flex;flex-direction:column}
.fk-page::after{content:"";position:absolute;top:0;bottom:0;left:50%;width:6%;translate:-50%;background:linear-gradient(90deg,transparent,rgba(60,40,20,.12),transparent);pointer-events:none}
.fk-mast{display:flex;align-items:baseline;gap:1.6cqw;padding:1.3cqw 2.4cqw 1.1cqw;background:#0058a3;border-bottom:.45cqw solid #ffda1a;color:#fff}
.fk-mast b{font-size:3.4cqw;font-weight:800;letter-spacing:-.02em;color:#ffda1a}.fk-mast span{font-size:1.4cqw;opacity:.85}.fk-mast i{margin-left:auto;font-style:normal;font-size:1.4cqw;color:#ffda1a}
.fk-q{margin:2.2cqw 0 0;text-align:center;font-size:3.2cqw;font-weight:800;letter-spacing:-.02em;color:#0058a3}
.fk-row{flex:1;display:flex;gap:2cqw;padding:2cqw 3cqw 1cqw}
.fk-tile{all:unset;position:relative;flex:1;display:flex;flex-direction:column;align-items:center;border-radius:8px;padding:1.4cqw;cursor:pointer;background:#f0eee8;transition:transform .2s cubic-bezier(.22,1,.36,1),box-shadow .2s,background-color .2s}
.fk-tile svg{width:78%;flex:1}
.fk-tile.sel{background:#fff6c8;transform:translateY(-.6cqw);box-shadow:0 0 0 .3cqw #ffda1a,0 16px 26px -14px rgba(0,0,0,.5)}
.fk-tile .n{font-size:1.75cqw;font-weight:700;text-align:center;line-height:1.25}
.fk-tile .k{position:absolute;top:1cqw;left:1cqw}
.fk-tile .p{margin-top:.8cqw;padding:.2cqw .9cqw .3cqw;background:#ffda1a;box-shadow:0 .3cqw 0 #e8c000;font-size:2.2cqw;font-weight:800;color:#c01a1a}
.fk-dots{display:flex;justify-content:center;gap:.8cqw;padding:0 0 1.6cqw}.fk-dots i{width:1cqw;height:1cqw;border-radius:50%;background:#e2dccb}.fk-dots i.d{background:#0058a3}.fk-dots i.c{background:#ffda1a}
`;

/** @param {any} ctx */
export function startCatalogue(ctx) {
  const ov = ctx.overlay({ title: 'Furniture Quiz', sub: 'the catalogue corner', help: '<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> or <kbd>↑</kbd><kbd>↓</kbd> <kbd>enter</kbd>/<kbd>click</kbd> pick / start / retake' });
  const K = gx(ov);
  if (!document.getElementById('fk-style')) { const s = document.createElement('style'); s.id = 'fk-style'; s.textContent = CSS; document.head.appendChild(s); }
  const rec = load('cat', { last: '', n: 0 });
  let q = 0, sel = 0, tally = [0, 0, 0], res = -1, playing = false;
  const hud = K.hud([{ id: 'page', label: 'Page', value: '1 / 4' }], [{ id: 'n', label: 'Quizzes', value: rec.n, tone: 'gold' }]);
  const scene = K.scene({ aspect: 16 / 10, maxW: 1100 });
  const pg = document.createElement('div'); pg.className = 'fk-page'; scene.appendChild(pg);
  pg.innerHTML = `<div class="fk-mast"><b>HJÄLP</b><span></span><i>what defines you?</i></div><div class="fk-q"></div><div class="fk-row"></div><div class="fk-dots"></div>`;
  const $ = s => /** @type {HTMLElement} */ (pg.querySelector(s));
  const tiles = [0, 1, 2].map(i => { const b = document.createElement('button'); b.className = 'fk-tile'; b.type = 'button';
    b.addEventListener('pointerenter', () => { if (playing && res < 0 && sel !== i) { sel = i; SFX.play('ui.select'); draw(); } });
    b.addEventListener('click', () => { if (playing && res < 0) choose(i); }); $('.fk-row').appendChild(b); return b; });
  const draw = () => { const qq = Math.min(q, QS.length - 1);
    $('.fk-mast span').textContent = 'catalogue  p.' + (12 + qq * 7); $('.fk-q').textContent = QS[qq][0];
    tiles.forEach((b, i) => { b.classList.toggle('sel', playing && i === sel);
      b.innerHTML = `<span class="gx-key k">${i + 1}</span><svg viewBox="0 0 120 96">${ART[qq](COL[qq * 3 + i])}</svg><span class="n">${QS[qq][1][i].replace(/</g, '&lt;')}</span><span class="p">${99 + i * 50 + qq * 20},-</span>`; });
    $('.fk-dots').innerHTML = QS.map((_, i) => `<i class="${i < q ? 'd' : i === q ? 'c' : ''}"></i>`).join(''); hud.set('page', `${qq + 1} / 4`); };
  const choose = (/** @type {number} */ i) => {
    tally[i]++; const b = tiles[i].getBoundingClientRect(); K.pop(b.left + b.width / 2, b.top + b.height * 0.3, '+ defines you', 'pink');
    q++; sel = 0; SFX.play('ui.click'); SFX.play('page', { delay: 0.08 });
    if (q >= QS.length) { res = tally.indexOf(Math.max(...tally)); rec.last = VERDICT[res][0]; rec.n++; save('cat', rec); SFX.play('magic', { delay: 0.2 }); K.swell(); hud.set('n', rec.n);
      K.result({ title: 'Verdict', big: VERDICT[res][0], line: VERDICT[res][1], stats: [[tally[0], 'Glass'], [tally[1], 'Curbside'], [tally[2], 'Vibe'], [rec.n, 'Quizzes']], again: 'Retake', onAgain: again });
      const big = /** @type {HTMLElement | null} */ (ov.el.querySelector('.gx-card .big')); if (big) { big.style.fontSize = '30px'; big.style.letterSpacing = '-.02em'; big.style.color = ['#ffda1a', '#ff5fd2', '#44e3cf'][res]; }
      return; }
    draw(); };
  const again = () => { q = 0; tally = [0, 0, 0]; res = -1; sel = 0; draw(); };
  const kd = (/** @type {KeyboardEvent} */ e) => { if (!playing || res >= 0) return; const d = /^Digit([1-3])$/.exec(e.code); if (d) choose(+d[1] - 1);
    else if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') { sel = (sel + 2) % 3; SFX.play('ui.select'); draw(); } else if (e.code === 'ArrowDown' || e.code === 'ArrowRight') { sel = (sel + 1) % 3; SFX.play('ui.select'); draw(); } else if (e.code === 'Enter') choose(sel); };
  addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd));
  draw();
  K.card({ title: 'HJÄLP Quiz', text: 'What kind of furniture defines you? Four pages, three picks each. Be honest.', how: [[['1', '2', '3'], 'pick'], [['↑', '↓', 'Enter'], 'choose'], [['Click'], 'a product']], cta: 'Open the catalogue', onGo: () => { playing = true; draw(); } });
}
