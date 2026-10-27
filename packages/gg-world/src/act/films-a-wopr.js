// @ts-check
// WarGames homage: tic-tac-toe against a computer that never loses and never takes a win, then the famous moral.
import { SFX } from '../sfx.js';
import { loop } from './util.js';
import { gx } from './gx.js';
import { crtDevice, esc, CURSOR, MONO } from './films-a-crt.js';

const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
/** @param {string[]} b */
const winner = b => { for (const [a, c, d] of LINES) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a]; return b.every(Boolean) ? 'draw' : null; };
/** Computer ('O') value: player win -1, draw 0, own win -0.5 (it plays for the draw). @param {string[]} b @param {boolean} cpu */
function score(b, cpu) {
  const w = winner(b); if (w) return w === 'X' ? -1 : w === 'O' ? -0.5 : 0;
  let best = cpu ? -9 : 9;
  for (let i = 0; i < 9; i++) if (!b[i]) { b[i] = cpu ? 'O' : 'X'; const v = score(b, !cpu); b[i] = ''; best = cpu ? Math.max(best, v) : Math.min(best, v); }
  return best;
}
/** @param {string[]} b */
function cpuMove(b) { let best = -9, at = -1; for (const i of [4, 0, 2, 6, 8, 1, 3, 5, 7]) if (!b[i]) { b[i] = 'O'; const v = score(b, false); b[i] = ''; if (v > best) { best = v; at = i; } } return at; }

/** @param {any} ctx */
export function startWopr(ctx) {
  const ov = ctx.overlay({ title: 'W.O.P.R.', sub: 'old CRT on the workbench', help: '<kbd>1-9</kbd> or <kbd>click</kbd> place X' });
  const K = gx(ov), hud = K.hud([{ id: 'games', label: 'Games played', value: 0 }], [{ id: 'def', label: 'DEFCON', value: 5, tone: 'gold' }]);
  const scene = K.scene({ aspect: 4 / 3, maxW: 900 });
  const dev = crtDevice(scene, { name: 'W.O.P.R.  /  NORAD', ph: '#ffc061', glow: 'rgba(255,160,50,.55)', bg0: '#0a0602', bg1: '#1d1206', case: 'linear-gradient(160deg,#5c5c55,#3c3c37 60%,#2a2a26)', top: true, fs: '4cqh' });
  if (!document.getElementById('wopr-style')) { const s = document.createElement('style'); s.id = 'wopr-style'; s.textContent = `
.wopr-g{display:grid;grid-template-columns:repeat(3,1fr);width:46cqh;height:46cqh;margin:2cqh 0 0 auto;position:absolute;right:4%;top:4%}
.wopr-g.sm{position:static;width:9cqh;height:9cqh;margin:0;display:inline-grid;font-size:2cqh}
.wopr-g>*{all:unset;display:grid;place-items:center;font:600 9cqh/1 ${MONO};color:#ffe0a0;cursor:pointer;border-color:rgba(255,179,71,.55);border-style:solid;border-width:0 .4cqh .4cqh 0;transition:transform .3s}
.wopr-g.sm>*{font-size:2cqh;border-width:0 .2cqh .2cqh 0;cursor:default}
.wopr-g>*:nth-child(3n){border-right:0}.wopr-g>*:nth-child(n+7){border-bottom:0}
.wopr-g>.o{color:#ffb347}.wopr-g>.n{font-size:3cqh;color:rgba(255,179,71,.3)}.wopr-g>.n:hover{color:#ffe0a0}
.wopr-g>.pop{animation:wopr-pop .4s cubic-bezier(.3,1.6,.6,1)}@keyframes wopr-pop{from{transform:scale(1.5)}}`; document.head.appendChild(s); }
  const st = { t: 0, b: Array(9).fill(''), phase: 'wait', msgT: 0, sims: 0, simB: Array(9).fill(''), simT: 0, pop: -1, games: 0, shown: false };
  const place = i => {
    if (st.phase !== 'play' || st.b[i]) return;
    st.b[i] = 'X'; st.pop = i; SFX.play('beep', { vol: 0.35 }); SFX.play('blip', { vol: 0.3, pitch: 0.8, delay: 0.25 });
    if (!winner(st.b)) { const m = cpuMove(st.b); st.b[m] = 'O'; }
    if (winner(st.b)) { st.games++; hud.set('games', st.games); st.phase = 'sim'; SFX.play('eerie', { vol: 0.4 }); st.msgT = st.t; st.simT = st.t; st.sims = 0; }
  };
  const reset = () => { SFX.play('crt.on', { vol: 0.4 }); dev.flash(); st.b = Array(9).fill(''); st.phase = 'play'; st.shown = false; hud.set('def', 5, { tone: 'gold' }); };
  const kd = e => { if (/^Digit[1-9]$|^Numpad[1-9]$/.test(e.code)) place(+e.code.slice(-1) - 1); };
  addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd));
  dev.txt.addEventListener('click', e => { const c = /** @type {HTMLElement} */ (e.target).closest('[data-i]'); if (c) place(Number(/** @type {HTMLElement} */ (c).dataset.i)); });
  const typed = (s, t0, cps = 20) => esc(s.slice(0, Math.max(0, Math.floor((st.t - t0) * cps))));
  const grid = (b, sm) => `<div class="wopr-g${sm ? ' sm' : ''}">${b.map((v, i) => v ? `<b class="${v === 'O' ? 'o' : ''}${!sm && i === st.pop ? ' pop' : ''}">${v}</b>` : sm ? '<b></b>' : `<button class="n" data-i="${i}" aria-label="cell ${i + 1}">${st.phase === 'play' ? i + 1 : ''}</button>`).join('')}</div>`;
  let prev = '';
  loop(ov, dt => {
    st.t += dt; const t = st.t; let h = '';
    if (st.phase === 'intro' && t - st.msgT > 2.6) st.phase = 'play';
    if (st.phase === 'sim') {
      if (t - st.simT > Math.max(0.03, 0.28 - st.sims * 0.012)) { st.simT = t;
        const e = st.simB.map((v, i) => v ? -1 : i).filter(i => i >= 0); const w = winner(st.simB);
        if (w || !e.length) { st.simB = Array(9).fill(''); st.sims++; } else { const turnX = e.length % 2 === 1; st.simB[swapMove(st.simB, turnX ? 'X' : 'O')] = turnX ? 'X' : 'O'; } }
      if (t - st.msgT > 4.5) { st.phase = 'moral'; st.msgT = t; }
      const def = Math.max(1, 5 - Math.floor(st.sims / 3)); hud.set('def', def, { tone: def < 3 ? 'bad' : 'gold' });
    }
    if (st.phase === 'wait') h = '';
    else if (st.phase === 'intro') h = `<div>${typed('GREETINGS PROFESSOR FALKEN.', st.msgT)}</div><div>${typed('SHALL WE PLAY A GAME?', st.msgT + 1.4)}${CURSOR}</div>`;
    else if (st.phase === 'moral') {
      h = `<div style="margin:auto;text-align:center;font-size:1.3em"><div>${typed('A STRANGE GAME.', st.msgT)}</div><div>${typed('THE ONLY WINNING MOVE IS', st.msgT + 1)}</div><div>${typed('NOT TO PLAY.', st.msgT + 2.4)}</div><div style="opacity:.6;margin-top:1em;font-size:.75em">${t - st.msgT > 3.4 ? typed('HOW ABOUT A NICE GAME OF CHESS?', st.msgT + 3.4, 30) : ''}</div></div>`;
      if (t - st.msgT > 5 && !st.shown) { st.shown = true; K.result({ title: 'A strange game', big: st.games, line: 'The only winning move is not to play.', stats: [[st.games, 'Games played']], again: 'Play again', onAgain: reset }); }
    } else {
      h = `<div>TIC-TAC-TOE</div><div style="opacity:.6">YOU: X &nbsp; WOPR: O</div><div style="margin-top:1em;color:#ffe0a0">${st.phase === 'play' ? 'YOUR MOVE.' + CURSOR : 'DRAW.'}</div>`;
      if (st.phase === 'sim') h += `<div style="opacity:.7">SIMULATING... ${st.sims}</div><div style="display:flex;gap:2cqh;margin-top:1em;opacity:.7">${[0, 1, 2, 3].map(k => grid(k === 0 ? st.simB : Array(9).fill('').map((_, i) => (i + k + st.sims) % 3 === 0 ? 'X' : (i * k + st.sims) % 4 === 1 ? 'O' : ''), true)).join('')}</div>`;
      h += grid(st.b, false);
    }
    if (h !== prev) { prev = h; dev.txt.innerHTML = h; }
  });
  K.card({ title: 'W.O.P.R.', text: 'Tic-tac-toe against the war computer.', how: [[['1-9'], 'place'], [['Click'], 'place']], cta: 'Log on', onGo: () => { SFX.play('crt.on', { vol: 0.4 }); dev.flash(); st.phase = 'intro'; st.msgT = st.t; } });
}
/** Best move for `who` (both sides play for a draw). @param {string[]} b @param {string} who */
function swapMove(b, who) { const s = who === 'O' ? b : b.map(v => v === 'X' ? 'O' : v === 'O' ? 'X' : ''); return cpuMove(s.slice()); }
