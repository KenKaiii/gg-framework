// @ts-check
// WarGames homage: tic-tac-toe against a computer that never loses and never takes a win, then the famous moral.
import { SFX } from '../sfx.js';
import { loop, text } from './util.js';
import { crt, titleCard } from './films-a-crt.js';
import { button, title, panel, glow } from './art.js';

/** NORAD big board: dot-matrix continents, grid, labels (drawn once into the CRT backdrop cache). @param {CanvasRenderingContext2D} x @param {number} W @param {number} H */
function norad(x, W, H) {
  x.fillStyle = '#050a12'; x.fillRect(0, 0, W, H);
  x.fillStyle = 'rgba(255,170,60,0.08)'; for (let i = 0; i < W; i += 20) x.fillRect(i, 0, 1, H); for (let j = 0; j < H; j += 20) x.fillRect(0, j, W, 1);
  const land = [[95, 70, 55, 30], [125, 150, 22, 40], [235, 62, 28, 18], [245, 130, 30, 42], [330, 70, 80, 30], [400, 170, 26, 14]];
  for (let px = 2; px < W; px += 4) for (let py = 2; py < H; py += 4) if (land.some(([cx, cy, rx, ry]) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 < 1)) { x.fillStyle = 'rgba(255,176,70,0.45)'; x.fillRect(px, py, 2, 2); }
  title(x, 'NORAD  /  CRYSTAL PALACE', 8, 16, { size: 16, body: true, align: 'left', color: '#ffb347' });
}
const ARCS = [[100, 75, 340, 70], [80, 85, 380, 60], [130, 70, 250, 60], [340, 75, 95, 60], [360, 80, 120, 85], [320, 65, 70, 70]];

const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const C = '#ffb347', G = '#ffe0a0';
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
  const ov = ctx.overlay({ title: 'W.O.P.R.', sub: 'old CRT on the workbench', help: '<kbd>1-9</kbd> or <kbd>click</kbd> place X <kbd>enter</kbd>/<kbd>click</kbd> again <kbd>esc</kbd> leave' });
  const W = 480, H = 270; const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const st = { t: 0, b: Array(9).fill(''), phase: 'intro', msgT: 0, sims: 0, simB: Array(9).fill(''), simT: 0, pop: -1, popT: 0, games: 0 };
  const cell = { x: 0, y: 0, s: 42 };
  const place = i => {
    if (st.phase !== 'play' || st.b[i]) return;
    st.b[i] = 'X'; st.pop = i; st.popT = st.t; SFX.play('beep', { vol: 0.35 }); SFX.play('blip', { vol: 0.3, pitch: 0.8, delay: 0.25 });
    if (!winner(st.b)) { const m = cpuMove(st.b); st.b[m] = 'O'; }
    if (winner(st.b)) { st.games++; st.phase = 'sim'; SFX.play('eerie', { vol: 0.4 }); st.msgT = st.t; st.simT = st.t; st.sims = 0; }
  };
  const reset = () => { SFX.play('crt.on', { vol: 0.4 }); st.b = Array(9).fill(''); st.phase = 'play'; };
  const kd = e => { if (/^Digit[1-9]$|^Numpad[1-9]$/.test(e.code)) place(+e.code.slice(-1) - 1); else if ((e.code === 'Enter' || e.code === 'KeyR') && st.phase === 'moral' && st.t - st.msgT > 2) reset(); };
  const ck = e => { const r = c.getBoundingClientRect(); const px = (e.clientX - r.left) * W / r.width, py = (e.clientY - r.top) * H / r.height;
    const cx = Math.floor((px - cell.x) / cell.s), cy = Math.floor((py - cell.y) / cell.s); if (st.phase === 'moral' && st.t - st.msgT > 2) { if (resultOn() && hitBox(leaveB, px, py)) { ov.close(); return; } reset(); return; } if (cx >= 0 && cx < 3 && cy >= 0 && cy < 3) place(cy * 3 + cx); };
  const leaveB = { x: 244, y: 224, w: 84, h: 26 }, againB = { x: 152, y: 224, w: 84, h: 26 }; let hover = '';
  const resultOn = () => st.phase === 'moral' && st.t - st.msgT > 5;
  const hitBox = (b, px, py) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
  const mv = e => { const r = c.getBoundingClientRect(); const px = (e.clientX - r.left) * W / r.width, py = (e.clientY - r.top) * H / r.height; hover = !resultOn() ? '' : hitBox(leaveB, px, py) ? 'leave' : hitBox(againB, px, py) ? 'again' : ''; };
  c.addEventListener('pointermove', mv); ov.onClose(() => c.removeEventListener('pointermove', mv));
  c.style.cursor = 'pointer';
  addEventListener('keydown', kd); c.addEventListener('click', ck); ov.onClose(() => { removeEventListener('keydown', kd); c.removeEventListener('click', ck); });
  const typed = (s, t0, cps = 20) => s.slice(0, Math.max(0, Math.floor((st.t - t0) * cps)));
  const grid = (b, gx, gy, s, col) => {
    x.fillStyle = col; for (let k = 1; k < 3; k++) { x.fillRect(gx + k * s - 1, gy + 2, 2, s * 3 - 4); x.fillRect(gx + 2, gy + k * s - 1, s * 3 - 4, 2); }
    b.forEach((v, i) => { const px = gx + (i % 3) * s + s / 2, py = gy + Math.floor(i / 3) * s + s / 2;
      const k = i === st.pop && b === st.b ? 1 + Math.max(0, 0.4 - (st.t - st.popT)) * 1.5 : 1;
      if (!v) { if (b === st.b && st.phase === 'play') text(x, String(i + 1), px, py + 5, { color: '#5a3a14', align: 'center' }); return; }
      x.strokeStyle = v === 'X' ? G : C; x.lineWidth = 2; const r = s * 0.28 * k; x.beginPath();
      if (v === 'X') { x.moveTo(px - r, py - r); x.lineTo(px + r, py + r); x.moveTo(px + r, py - r); x.lineTo(px - r, py + r); } else x.arc(px, py, r, 0, 7);
      x.stroke(); });
  };
  loop(ov, dt => {
    st.t += dt; const t = st.t;
    if (st.phase === 'intro' && t > 5.4) st.phase = 'play';
    if (st.phase === 'sim') { // the computer plays itself, faster and faster
      if (t - st.simT > Math.max(0.03, 0.28 - st.sims * 0.012)) { st.simT = t;
        const e = st.simB.map((v, i) => v ? -1 : i).filter(i => i >= 0); const w = winner(st.simB);
        if (w || !e.length) { st.simB = Array(9).fill(''); st.sims++; } else { const turnX = e.length % 2 === 1; st.simB[swapMove(st.simB, turnX ? 'X' : 'O')] = turnX ? 'X' : 'O'; } }
      if (t - st.msgT > 4.5) { st.phase = 'moral'; st.msgT = t; }
    }
    crt(x, W, H, (sx, sy, sw, sh) => {
      x.fillStyle = '#02060c'; x.fillRect(sx - 8, sy - 8, sw + 16, sh + 16);
      if (st.phase === 'intro') { text(x, typed('GREETINGS PROFESSOR FALKEN.', 3.0), sx + 14, sy + 30, { color: C }); text(x, typed('SHALL WE PLAY A GAME?', 4.4), sx + 14, sy + 54, { color: C }); return; }
      if (st.phase === 'moral') {
        text(x, typed('A STRANGE GAME.', st.msgT), sx + sw / 2, sy + sh / 2 - 20, { color: C, align: 'center' });
        text(x, typed('THE ONLY WINNING MOVE IS', st.msgT + 1), sx + sw / 2, sy + sh / 2 + 4, { color: C, align: 'center' });
        text(x, typed('NOT TO PLAY.', st.msgT + 2.4), sx + sw / 2, sy + sh / 2 + 22, { color: C, align: 'center' });
        if (t - st.msgT > 3.4) text(x, typed('HOW ABOUT A NICE GAME OF CHESS?', st.msgT + 3.4, 30), sx + sw / 2, sy + sh / 2 + 44, { color: '#a8702a', align: 'center' });
        return;
      }
      text(x, 'TIC-TAC-TOE', sx + 14, sy + 20, { color: C });
      text(x, 'YOU: X   WOPR: O', sx + 14, sy + 38, { color: '#a8702a' });
      cell.x = sx + sw - 146; cell.y = sy + 14; grid(st.b, cell.x, cell.y, cell.s, '#a8702a');
      if (st.phase === 'play') text(x, 'YOUR MOVE.', sx + 14, sy + 70, { color: G });
      if (st.phase === 'sim') {
        text(x, 'DRAW.', sx + 14, sy + 70, { color: C });
        text(x, 'SIMULATING... ' + st.sims, sx + 14, sy + 90, { color: '#a8702a' });
        const mx = sx + 14, my = sy + 98; for (let k = 0; k < 4; k++) grid(k === 0 ? st.simB : Array(9).fill('').map((_, i) => (i + k + st.sims) % 3 === 0 ? 'X' : (i * k + st.sims) % 4 === 1 ? 'O' : ''), mx + k * 40, my, 12, '#5a3a14');
        x.fillStyle = `rgba(127,214,255,${(0.03 + 0.03 * Math.sin(t * 2.5)).toFixed(3)})`; x.fillRect(sx - 8, sy - 8, sw + 16, sh + 16); // slow glow, no strobe
      }
    }, { glow: C, beige: '#5a5a52', key: 'wopr', backdrop: norad, box: { x: 90, y: 34, w: 300, h: 212 } });
    // live board: DEFCON readout and slow missile tracks while it simulates
    const def = st.phase === 'sim' || st.phase === 'moral' ? Math.max(1, 5 - Math.floor(st.sims / 3)) : 5;
    panel(x, 398, 4, 76, 22, { style: 'metal', r: 3 }); title(x, 'DEFCON ' + def, 436, 20, { size: 16, body: true, color: def < 3 ? '#ff5a3a' : C });
    if (st.phase === 'sim') { x.save(); x.beginPath(); x.rect(0, 0, W, H); x.rect(90, 34, 300, 212); x.clip('evenodd'); /* tracks stay on the wall map, not over the CRT */ x.strokeStyle = 'rgba(255,90,50,0.7)'; x.lineWidth = 1; const n = Math.min(ARCS.length, 1 + st.sims);
      for (let k = 0; k < n; k++) { const [ax, ay, bx2, by2] = ARCS[k], mx = (ax + bx2) / 2, my = Math.min(ay, by2) - 45; x.beginPath(); x.moveTo(ax, ay); x.quadraticCurveTo(mx, my, bx2, by2); x.stroke(); glow(x, bx2, by2, 8, '#ff5a3a', 0.4 + 0.2 * Math.sin(t * 2)); } x.restore(); }
    if (resultOn()) { const k = Math.min(1, (t - st.msgT - 5) / 0.4); x.save(); x.globalAlpha = k;
      panel(x, 140, 196, 200, 66, { style: 'metal' }); title(x, 'GAMES PLAYED ' + st.games, 240, 214, { size: 16, body: true, color: C });
      button(x, 152, 224, 84, 26, 'Play again', { primary: true, hot: hover === 'again' }); button(x, 244, 224, 84, 26, 'Leave', { hot: hover === 'leave' }); x.restore(); }
    titleCard(x, W, H, t, { name: 'W.O.P.R.', sub: 'tic-tac-toe vs the war computer', keys: [['1-9', 'place'], ['click', 'place'], ['esc', 'leave']], color: C });
  });
}
/** Best move for `who` (both sides play for a draw). @param {string[]} b @param {string} who */
function swapMove(b, who) { const s = who === 'O' ? b : b.map(v => v === 'X' ? 'O' : v === 'O' ? 'X' : ''); return cpuMove(s.slice()); }
