// @ts-check
// "Windoze 93" desktop at a lab PC: Snake and Minesweeper (best scores saved) + Clipp-E, the paperclip assistant.
import { SFX } from '../sfx.js';
import { loop, text, keys, rng } from './util.js';
import { best, saveBest, seat, closeUp, win, wrap, pos } from './computer-util.js';

const W = 480, H = 270;
const TIPS = ["It looks like you're writing a prompt. Need context?", 'Tip: small steps beat one giant prompt.', 'Ask the agent for tests. Then read them.', "Never paste your API keys. I'm watching.", 'Review the diff before you ship it.'];

/** @param {any} ctx */
export function startDesktop(ctx) {
  const stand = seat(ctx);
  const ov = ctx.overlay({ title: 'Windoze 93', sub: 'Lab PC · double-click is optional', help: '<kbd>1</kbd> Snake <kbd>2</kbd> Mines <kbd>click</kbd> icons <kbd>esc</kbd> leave' });
  ov.onClose(stand); { const sl = ctx.it?.slot; closeUp(ctx, ov, sl ? sl.x : -3, 1.0, sl ? sl.z - 0.9 : 1.8); }
  const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const k = keys(ov);
  const st = { app: 'desk', t: 0, tip: 0, tipT: 0, pop: '', popT: 0 };
  // ---- Snake
  const SN = { cols: 28, rows: 13, cell: 12, ox: 72, oy: 50 };
  let sn; const snakeNew = () => { sn = { body: [[8, 6], [7, 6], [6, 6]], dir: [1, 0], next: [1, 0], food: [18, 6], acc: 0, score: 0, dead: false, r: rng(Date.now() & 0xffff) }; };
  // ---- Minesweeper 12x8, 14 mines
  const MW = 12, MH = 8, MN = 14, MC = 16, MX = 144, MY = 66;
  let ms; const minesNew = () => { ms = { cells: Array.from({ length: MW * MH }, () => ({ m: false, o: false, f: false, n: 0 })), first: true, over: '', t0: 0, t: 0, cur: [0, 0] }; };
  const lay = (safe) => { const r = rng((Date.now() & 0xffff) + 3); let n = 0; while (n < MN) { const i = Math.floor(r() * MW * MH); if (i === safe || ms.cells[i].m) continue; ms.cells[i].m = true; n++; }
    for (let i = 0; i < MW * MH; i++) { const cx = i % MW, cy = Math.floor(i / MW); let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = cx + dx, ny = cy + dy; if (nx >= 0 && ny >= 0 && nx < MW && ny < MH && ms.cells[ny * MW + nx].m) s++; } ms.cells[i].n = s; } };
  const open = (cx, cy) => { if (ms.over) return; const i = cy * MW + cx, cl = ms.cells[i]; if (cl.o || cl.f) return;
    if (ms.first) { ms.first = false; lay(i); ms.t0 = st.t; }
    cl.o = true; if (cl.m) { ms.over = 'boom'; SFX.play('arcade.boom', { vol: 0.7 }); SFX.play('fail', { delay: 0.3 }); st.pop = 'BOOM. git revert?'; st.popT = 2; return; }
    if (!cl.n) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = cx + dx, ny = cy + dy; if (nx >= 0 && ny >= 0 && nx < MW && ny < MH) open(nx, ny); }
    if (ms.cells.every(q => q.o || q.m)) { ms.over = 'win'; const s = Math.round(ms.t * 10) / 10; const rec = saveBest('mines', s, true); st.pop = rec ? 'NEW RECORD ' + s + 's!' : 'Cleared in ' + s + 's'; st.popT = 3; SFX.play(rec ? 'win' : 'success'); } };
  const flag = (cx, cy) => { const cl = ms.cells[cy * MW + cx]; if (!cl.o && !ms.over) { cl.f = !cl.f; SFX.play(cl.f ? 'snap' : 'ui.back', { vol: 0.6 }); } };
  const go = app => { if (app !== st.app) SFX.play(app === 'desk' ? 'ui.back' : 'pc.boot', { vol: 0.5 }); st.app = app; if (app === 'snake') snakeNew(); if (app === 'mines') minesNew();
    ov.setHelp(app === 'desk' ? '<kbd>1</kbd> Snake <kbd>2</kbd> Mines <kbd>click</kbd> icons <kbd>esc</kbd> leave'
      : app === 'snake' ? '<kbd>arrows</kbd> steer <kbd>space</kbd> restart <kbd>backspace</kbd> desktop' : '<kbd>click</kbd> open <kbd>right-click/F</kbd> flag <kbd>arrows+space</kbd> also <kbd>backspace</kbd> desktop'); };
  const onKey = e => {
    if (e.code === 'Backspace') { go('desk'); return; }
    if (st.app === 'desk') { if (e.code === 'Digit1') go('snake'); if (e.code === 'Digit2') go('mines'); return; }
    if (st.app === 'snake') { const d = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.code]; if (d && (d[0] !== -sn.dir[0] || d[1] !== -sn.dir[1])) { sn.next = d; SFX.play('key', { vol: 0.4 }); } if (e.code === 'Space' && sn.dead) { snakeNew(); SFX.play('go'); } }
    if (st.app === 'mines') { const d = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.code]; if (d) SFX.play('ui.select', { vol: 0.5 }); if (d) ms.cur = [Math.max(0, Math.min(MW - 1, ms.cur[0] + d[0])), Math.max(0, Math.min(MH - 1, ms.cur[1] + d[1]))];
      if (e.code === 'Space') { if (ms.over) minesNew(); else open(ms.cur[0], ms.cur[1]); } if (e.code === 'KeyF') flag(ms.cur[0], ms.cur[1]); }
  };
  const cap = e => { if (e.code !== 'Escape') { e.stopPropagation(); onKey(e); } };
  addEventListener('keydown', cap, true); ov.onClose(() => removeEventListener('keydown', cap, true));
  const onClick = e => { const p = pos(c, e); e.preventDefault();
    if (st.app === 'desk') { if (p.x < 60 && p.y > 10 && p.y < 50) go('snake'); else if (p.x < 60 && p.y > 54 && p.y < 94) go('mines'); else if (p.x > 380 && p.y > 170) { st.tip = (st.tip + 1) % TIPS.length; SFX.play('pop'); } return; }
    if (st.app === 'mines') { const cx = Math.floor((p.x - MX) / MC), cy = Math.floor((p.y - MY) / MC); if (ms.over && e.button === 0) { minesNew(); return; } if (cx >= 0 && cy >= 0 && cx < MW && cy < MH) { ms.cur = [cx, cy]; if (e.button === 2) flag(cx, cy); else open(cx, cy); } } };
  c.addEventListener('mousedown', onClick); c.addEventListener('contextmenu', e => e.preventDefault());
  void k;
  loop(ov, dt => {
    st.t += dt; st.tipT += dt; if (st.tipT > 6) { st.tipT = 0; st.tip = (st.tip + 1) % TIPS.length; } st.popT = Math.max(0, st.popT - dt);
    // desktop
    x.fillStyle = '#1f7a7a'; x.fillRect(0, 0, W, H);
    [['SNAKE.EXE', '#3ddc84', 10], ['MINES.EXE', '#c0c0c0', 54]].forEach(([n, col, y], i) => { x.fillStyle = /** @type {string} */ (col); x.fillRect(18, /** @type {number} */ (y) + 4, 24, 20); x.fillStyle = '#000'; x.fillRect(22, /** @type {number} */ (y) + 8, 16, 12); text(x, (i + 1) + ' ' + n, 6, /** @type {number} */ (y) + 38, { color: '#fff', shadow: '#0a3a3a' }); });
    x.fillStyle = '#c0c0c0'; x.fillRect(0, H - 18, W, 18); x.fillStyle = '#3a8a3a'; x.fillRect(3, H - 15, 44, 12); text(x, 'Start', 8, H - 5, { color: '#fff' });
    const hh = new Date(); text(x, String(hh.getHours()).padStart(2, '0') + ':' + String(hh.getMinutes()).padStart(2, '0'), W - 40, H - 5, { color: '#000' });
    if (st.app === 'snake') drawSnake(dt); else if (st.app === 'mines') drawMines(); else { win(x, 120, 30, 240, 100, 'Welcome.txt'); ['Welcome to the Lab PC.', 'Best Snake: ' + best('snake'), 'Best Mines: ' + (best('mines') ? best('mines') + 's' : '--'), 'Press 1 or 2, or click an icon.'].forEach((s, i) => text(x, s, 130, 62 + i * 18, { color: '#000' })); }
    if (st.app === 'desk') clippy();
    if (st.popT > 0) { const s = 1 + Math.max(0, st.popT - 1.6) * 0.6; x.save(); x.translate(W / 2, 30); x.scale(s, s); text(x, st.pop, 0, 0, { size: 32, align: 'center', color: '#ffcf8a', shadow: '#000', title: true }); x.restore(); }
  });
  function drawSnake(dt) {
    const { cols, rows, cell, ox, oy } = SN; win(x, ox - 6, oy - 26, cols * cell + 12, rows * cell + 32, 'SNAKE.EXE   score ' + sn.score + '   best ' + best('snake'));
    x.fillStyle = '#0a1a0e'; x.fillRect(ox, oy, cols * cell, rows * cell);
    if (!sn.dead) { sn.acc += dt; const step = Math.max(0.06, 0.14 - sn.score * 0.003); while (sn.acc > step) { sn.acc -= step; sn.dir = sn.next; const h = [sn.body[0][0] + sn.dir[0], sn.body[0][1] + sn.dir[1]];
      if (h[0] < 0 || h[1] < 0 || h[0] >= cols || h[1] >= rows || sn.body.some(b => b[0] === h[0] && b[1] === h[1])) { sn.dead = true; const rec = saveBest('snake', sn.score); st.pop = rec && sn.score ? 'NEW BEST ' + sn.score + '!' : 'Segfault. Score ' + sn.score; st.popT = 2.5; SFX.play('thud'); SFX.play(rec && sn.score ? 'win' : 'fail', { delay: 0.2 }); break; }
      sn.body.unshift(h); if (h[0] === sn.food[0] && h[1] === sn.food[1]) { sn.score++; SFX.play('arcade.coin', { vol: 0.5, pitch: 1 + Math.min(0.5, sn.score * 0.02) }); do { sn.food = [Math.floor(sn.r() * cols), Math.floor(sn.r() * rows)]; } while (sn.body.some(b => b[0] === sn.food[0] && b[1] === sn.food[1])); } else sn.body.pop(); } }
    x.fillStyle = '#ffb36b'; x.fillRect(ox + sn.food[0] * cell + 2, oy + sn.food[1] * cell + 2, cell - 4, cell - 4);
    sn.body.forEach((b, i) => { x.fillStyle = i ? '#3ddc84' : '#b8f5d0'; x.fillRect(ox + b[0] * cell + 1, oy + b[1] * cell + 1, cell - 2, cell - 2); });
    if (sn.dead) text(x, 'GAME OVER  space = again', ox + cols * cell / 2, oy + rows * cell / 2, { size: 16, align: 'center', color: '#ff6b6b', shadow: '#000' });
  }
  function drawMines() {
    if (!ms.first && !ms.over) ms.t = st.t - ms.t0;
    win(x, MX - 8, MY - 30, MW * MC + 16, MH * MC + 40, 'MINES.EXE  ' + ms.t.toFixed(1) + 's  best ' + (best('mines') || '--'));
    const left = MN - ms.cells.filter(q => q.f).length; text(x, (ms.over === 'boom' ? 'x_x' : ms.over === 'win' ? 'B-)' : ':-)') + '  mines ' + left, MX, MY - 4, { color: '#000' });
    ms.cells.forEach((cl, i) => { const cx = MX + (i % MW) * MC, cy = MY + Math.floor(i / MW) * MC;
      if (cl.o) { x.fillStyle = cl.m ? '#e63946' : '#d8d8d8'; x.fillRect(cx, cy, MC, MC); x.fillStyle = '#9a9a9a'; x.fillRect(cx, cy, MC, 1); x.fillRect(cx, cy, 1, MC);
        if (cl.m) { x.fillStyle = '#000'; x.fillRect(cx + 5, cy + 5, 6, 6); } else if (cl.n) text(x, String(cl.n), cx + 5, cy + 13, { color: ['', '#1a3ad8', '#1a8a3a', '#d83a3a', '#1a1a8a', '#8a1a1a', '#1a8a8a', '#000', '#555'][cl.n] }); }
      else { x.fillStyle = '#c0c0c0'; x.fillRect(cx, cy, MC, MC); x.fillStyle = '#fff'; x.fillRect(cx, cy, MC, 2); x.fillRect(cx, cy, 2, MC); x.fillStyle = '#707070'; x.fillRect(cx, cy + MC - 2, MC, 2); x.fillRect(cx + MC - 2, cy, 2, MC);
        if (cl.f || (ms.over === 'boom' && cl.m)) { x.fillStyle = cl.f ? '#e63946' : '#000'; x.fillRect(cx + 5, cy + 4, 6, 5); x.fillStyle = '#000'; x.fillRect(cx + 7, cy + 4, 1, 9); } } });
    x.strokeStyle = '#ffcf8a'; x.lineWidth = 1; x.strokeRect(MX + ms.cur[0] * MC + 0.5, MY + ms.cur[1] * MC + 0.5, MC - 1, MC - 1);
  }
  function clippy() {
    const bx = 400, by = 200 + Math.sin(st.t * 3) * 2; x.strokeStyle = '#d0d4dc'; x.lineWidth = 3;
    x.beginPath(); x.moveTo(bx, by + 30); x.lineTo(bx, by); x.arc(bx + 8, by, 8, PI, 0); x.lineTo(bx + 16, by + 34); x.arc(bx + 10, by + 34, 6, 0, PI); x.lineTo(bx + 4, by + 8); x.stroke();
    x.fillStyle = '#fff'; x.fillRect(bx + 1, by + 10, 6, 6); x.fillRect(bx + 10, by + 10, 6, 6); x.fillStyle = '#000'; x.fillRect(bx + 3 + Math.round(Math.sin(st.t)), by + 12, 2, 2); x.fillRect(bx + 12 + Math.round(Math.sin(st.t)), by + 12, 2, 2);
    const lines = wrap(x, TIPS[st.tip], 150); const bh = lines.length * 14 + 10, tx = 320, ty = by - bh - 6;
    x.fillStyle = '#ffffcc'; x.fillRect(tx, ty, 160, bh); x.strokeStyle = '#000'; x.lineWidth = 1; x.strokeRect(tx + 0.5, ty + 0.5, 159, bh - 1);
    lines.forEach((l, i) => text(x, l, tx + 5, ty + 14 + i * 14, { color: '#000' }));
  }
}
const PI = Math.PI;
