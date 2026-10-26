// @ts-check
// "Windoze 93" desktop at a lab PC: Snake and Minesweeper (best scores saved) + Clipp-E, the paperclip assistant.
import { SFX } from '../sfx.js';
import { loop, text, keys, rng } from './util.js';
import { PAL, title, glow, banner, particles, shaker, rr } from './art.js';
import { howTo } from './hackers-util.js';
import { best, saveBest, seat, closeUp, win, wrap, pos } from './computer-util.js';

const W = 480, H = 270;
const TIPS = ["It looks like you're writing a prompt. Need context?", 'Tip: small steps beat one giant prompt.', 'Ask the agent for tests. Then read them.', "Never paste your API keys. I'm watching.", 'Review the diff before you ship it.'];

/** @param {any} ctx */
export function startDesktop(ctx) {
  const stand = seat(ctx);
  const ov = ctx.overlay({ title: 'Windoze 93', sub: 'Lab PC · double-click is optional', help: '<kbd>1</kbd> Snake <kbd>2</kbd> Mines <kbd>click</kbd> icons <kbd>esc</kbd> leave' });
  ov.onClose(stand); { const sl = ctx.it?.slot; closeUp(ctx, ov, sl ? sl.x : -3, 1.0, sl ? sl.z - 0.9 : 1.8); }
  const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const k = keys(ov); const fx = particles(), sh = shaker(); let popC = PAL.gold, popSub = '';
  // static desktop wallpaper (cached): teal gradient, soft light, faint logo, grain
  const wall = document.createElement('canvas'); wall.width = W; wall.height = H; { const w = /** @type {CanvasRenderingContext2D} */ (wall.getContext('2d'));
    const g = w.createRadialGradient(W * 0.55, H * 0.4, 10, W / 2, H / 2, W * 0.75); g.addColorStop(0, '#3ab0a8'); g.addColorStop(0.6, '#1a7a7a'); g.addColorStop(1, '#0a3a44'); w.fillStyle = g; w.fillRect(0, 0, W, H);
    const cx = W * 0.62, cy = H * 0.5; [['#e8645a', -1, -1], ['#6ee7a0', 1, -1], ['#8fa3ff', -1, 1], ['#f5bd63', 1, 1]].forEach(([c, sx, sy]) => { w.globalAlpha = 0.16; w.fillStyle = /** @type {string} */ (c); w.beginPath(); w.moveTo(cx + 3 * +sx, cy + 3 * +sy); w.lineTo(cx + 34 * +sx, cy + 3 * +sy - 4); w.lineTo(cx + 34 * +sx, cy + 30 * +sy); w.lineTo(cx + 3 * +sx, cy + 30 * +sy + 4); w.fill(); }); w.globalAlpha = 1;
    let r = 5; for (let i = 0; i < W * H / 40; i++) { r = (r * 1664525 + 1013904223) >>> 0; w.fillStyle = r & 1 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)'; w.fillRect(r % W, (r >>> 9) % H, 1, 1); } }
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
    cl.o = true; if (cl.m) { ms.over = 'boom'; SFX.play('arcade.boom', { vol: 0.7 }); SFX.play('fail', { delay: 0.3 }); st.pop = 'BOOM'; popSub = 'git revert?'; popC = PAL.red; st.popT = 2; sh.kick(7); fx.burst(MX + cx * MC + 8, MY + cy * MC + 8, { n: 30, colors: ['#e63946', '#ffcf8a', '#333'], speed: 110 }); return; }
    if (!cl.n) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = cx + dx, ny = cy + dy; if (nx >= 0 && ny >= 0 && nx < MW && ny < MH) open(nx, ny); }
    if (ms.cells.every(q => q.o || q.m)) { ms.over = 'win'; const s = Math.round(ms.t * 10) / 10; const rec = saveBest('mines', s, true); st.pop = rec ? 'NEW RECORD' : 'CLEARED'; popSub = s + 's   best ' + best('mines') + 's'; popC = PAL.green; st.popT = 3; fx.confetti(W); SFX.play(rec ? 'win' : 'success'); } };
  const flag = (cx, cy) => { const cl = ms.cells[cy * MW + cx]; if (!cl.o && !ms.over) { cl.f = !cl.f; SFX.play(cl.f ? 'snap' : 'ui.back', { vol: 0.6 }); } };
  const go = app => { if (app !== st.app) SFX.play(app === 'desk' ? 'ui.back' : 'pc.boot', { vol: 0.5 }); st.app = app; if (app === 'snake') snakeNew(); if (app === 'mines') minesNew();
    ov.setHelp(app === 'desk' ? '<kbd>1</kbd> Snake <kbd>2</kbd> Mines <kbd>click</kbd> icons <kbd>esc</kbd> leave'
      : app === 'snake' ? '<kbd>arrows</kbd> steer <kbd>space</kbd>/<kbd>click</kbd> restart <kbd>click</kbd> turn toward pointer <kbd>backspace</kbd>/<kbd>x</kbd> desktop' : '<kbd>click</kbd> open <kbd>right-click/F</kbd> flag <kbd>arrows+space</kbd> also <kbd>backspace</kbd>/<kbd>x</kbd> desktop'); };
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
    // the drawn [x] on each window goes back to the desktop
    const xb = st.app === 'snake' ? [SN.ox - 6 + SN.cols * SN.cell + 12 - 17, SN.oy - 26 + 5] : [MX - 8 + MW * MC + 16 - 17, MY - 30 + 5];
    if (e.button === 0 && p.x >= xb[0] - 1 && p.x <= xb[0] + 12 && p.y >= xb[1] - 1 && p.y <= xb[1] + 11) { go('desk'); return; }
    if (st.app === 'snake' && e.button === 0) { if (sn.dead) { snakeNew(); SFX.play('go'); return; } // click restarts; alive, click steers toward the pointer
      const h = sn.body[0], dx = p.x - (SN.ox + (h[0] + 0.5) * SN.cell), dy = p.y - (SN.oy + (h[1] + 0.5) * SN.cell);
      const d = sn.dir[0] ? [0, Math.sign(dy) || 1] : [Math.sign(dx) || 1, 0]; sn.next = d; SFX.play('key', { vol: 0.4 }); return; }
    if (st.app === 'mines') { const cx = Math.floor((p.x - MX) / MC), cy = Math.floor((p.y - MY) / MC); if (ms.over && e.button === 0) { minesNew(); return; } if (cx >= 0 && cy >= 0 && cx < MW && cy < MH) { ms.cur = [cx, cy]; if (e.button === 2) flag(cx, cy); else open(cx, cy); } } };
  const hov = { x: -1, y: -1 }; c.addEventListener('pointermove', e => { const p = pos(c, e); hov.x = p.x; hov.y = p.y; });
  c.addEventListener('mousedown', onClick); c.addEventListener('contextmenu', e => e.preventDefault());
  void k;
  loop(ov, dt => {
    st.t += dt; st.tipT += dt; if (st.tipT > 6) { st.tipT = 0; st.tip = (st.tip + 1) % TIPS.length; } st.popT = Math.max(0, st.popT - dt);
    // desktop
    x.save(); sh.apply(x, dt); x.drawImage(wall, 0, 0);
    [['SNAKE.EXE', 10], ['MINES.EXE', 54]].forEach(([n, y], i) => { const Y = +y, hot = st.app === 'desk' && hov.x < 60 && hov.y > Y && hov.y < Y + 40;
      if (hot) { x.fillStyle = 'rgba(255,255,255,0.18)'; rr(x, 4, Y, 52, 44, 3); x.fill(); glow(x, 30, Y + 16, 26, '#bff', 0.25); }
      x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillRect(18, Y + 7, 26, 22); x.fillStyle = '#d6d6d0'; x.fillRect(16, Y + 4, 26, 22); x.fillStyle = '#fff'; x.fillRect(16, Y + 4, 26, 1); x.fillStyle = '#0a1a10'; x.fillRect(19, Y + 7, 20, 14);
      if (i === 0) { x.fillStyle = '#3ddc84'; x.fillRect(21, Y + 13, 10, 3); x.fillRect(28, Y + 10, 3, 3); x.fillStyle = '#ffb36b'; x.fillRect(34, Y + 14, 2, 2); }
      else { x.fillStyle = '#c0c0c0'; x.fillRect(19, Y + 7, 20, 14); x.fillStyle = '#000'; x.beginPath(); x.arc(29, Y + 14, 4, 0, 7); x.fill(); x.fillRect(28, Y + 8, 2, 12); x.fillRect(23, Y + 13, 12, 2); x.fillStyle = '#fff'; x.fillRect(27, Y + 12, 1, 1); }
      title(x, (i + 1) + ' ' + n, 30, Y + 42, { size: 16, body: true, color: '#fff', ink: '#0a2a2a' }); });
    const tg = x.createLinearGradient(0, H - 18, 0, H); tg.addColorStop(0, '#dcdcd6'); tg.addColorStop(1, '#a8a8a2'); x.fillStyle = tg; x.fillRect(0, H - 18, W, 18); x.fillStyle = '#fff'; x.fillRect(0, H - 18, W, 1);
    const sg = x.createLinearGradient(0, H - 15, 0, H - 3); sg.addColorStop(0, '#5ac85a'); sg.addColorStop(1, '#2a7a2a'); x.fillStyle = sg; rr(x, 3, H - 15, 50, 13, 3); x.fill(); title(x, 'Start', 28, H - 5, { size: 16, body: true, color: '#fff', ink: '#0a3a0a' });
    if (st.app !== 'desk') { x.fillStyle = '#c8c8c2'; x.fillRect(60, H - 15, 90, 13); x.fillStyle = '#808080'; x.fillRect(60, H - 15, 90, 1); text(x, st.app === 'snake' ? 'SNAKE.EXE' : 'MINES.EXE', 66, H - 5, { color: '#000' }); }
    x.fillStyle = '#b8b8b2'; x.fillRect(W - 50, H - 15, 47, 13); x.fillStyle = '#808080'; x.fillRect(W - 50, H - 15, 47, 1);
    const hh = new Date(); text(x, String(hh.getHours()).padStart(2, '0') + ':' + String(hh.getMinutes()).padStart(2, '0'), W - 42, H - 5, { color: '#000' });
    if (st.app === 'snake') drawSnake(dt); else if (st.app === 'mines') drawMines(); else { win(x, 120, 26, 240, 120, 'Welcome.txt'); x.fillStyle = '#fffff4'; x.fillRect(126, 46, 228, 94);
      title(x, 'Lab PC', 240, 66, { size: 16, color: '#1a2a8a', ink: '#c8d0f0' });
      text(x, 'Best Snake', 140, 86, { color: '#333' }); title(x, String(best('snake')), 340, 86, { size: 16, align: 'right', color: '#1a8a3a', ink: '#d0f0d8' });
      text(x, 'Best Mines', 140, 104, { color: '#333' }); title(x, best('mines') ? best('mines') + 's' : '--', 340, 104, { size: 16, align: 'right', color: '#8a3a1a', ink: '#f0d8d0' });
      howTo(x, 240 * 2, 130, [['1', 'Snake'], ['2', 'Mines'], ['click', 'icons']], { dark: '#2a2a3a' }); }
    if (st.app === 'desk') clippy();
    fx.draw(x, dt); x.restore();
    if (st.popT > 0) banner(x, W, H, st.pop, popSub, (st.app === 'mines' && st.pop === 'CLEARED' || st.pop === 'NEW RECORD' ? 3 : st.pop === 'BOOM' ? 2 : 2.5) - st.popT, { color: popC });
  });
  function drawSnake(dt) {
    const { cols, rows, cell, ox, oy } = SN; win(x, ox - 6, oy - 26, cols * cell + 12, rows * cell + 32, 'SNAKE.EXE   score ' + sn.score + '   best ' + best('snake'));
    x.fillStyle = '#0a1a0e'; x.fillRect(ox, oy, cols * cell, rows * cell); x.fillStyle = 'rgba(61,220,132,0.06)'; for (let i = 0; i < cols; i++) for (let j = (i & 1); j < rows; j += 2) x.fillRect(ox + i * cell, oy + j * cell, cell, cell);
    if (!sn.dead) { sn.acc += dt; const step = Math.max(0.06, 0.14 - sn.score * 0.003); while (sn.acc > step) { sn.acc -= step; sn.dir = sn.next; const h = [sn.body[0][0] + sn.dir[0], sn.body[0][1] + sn.dir[1]];
      if (h[0] < 0 || h[1] < 0 || h[0] >= cols || h[1] >= rows || sn.body.some(b => b[0] === h[0] && b[1] === h[1])) { sn.dead = true; const rec = saveBest('snake', sn.score); st.pop = rec && sn.score ? 'NEW BEST' : 'SEGFAULT'; popSub = 'score ' + sn.score + '   best ' + best('snake'); popC = rec && sn.score ? PAL.gold : PAL.red; st.popT = 2.5; sh.kick(5); if (rec && sn.score) fx.confetti(W); SFX.play('thud'); SFX.play(rec && sn.score ? 'win' : 'fail', { delay: 0.2 }); break; }
      sn.body.unshift(h); if (h[0] === sn.food[0] && h[1] === sn.food[1]) { sn.score++; fx.burst(ox + h[0] * cell + 6, oy + h[1] * cell + 6, { n: 10, colors: ['#ffb36b', '#ffe8a0'], speed: 50 }); SFX.play('arcade.coin', { vol: 0.5, pitch: 1 + Math.min(0.5, sn.score * 0.02) }); do { sn.food = [Math.floor(sn.r() * cols), Math.floor(sn.r() * rows)]; } while (sn.body.some(b => b[0] === sn.food[0] && b[1] === sn.food[1])); } else sn.body.pop(); } }
    const fxp = ox + sn.food[0] * cell + 6, fyp = oy + sn.food[1] * cell + 6; glow(x, fxp, fyp, 14 + Math.sin(st.t * 3) * 2, '#ffb36b', 0.5); x.fillStyle = '#e8645a'; x.beginPath(); x.arc(fxp, fyp + 1, 4, 0, 7); x.fill(); x.fillStyle = '#ffd0c0'; x.fillRect(fxp - 2, fyp - 2, 2, 2); x.fillStyle = '#3ddc84'; x.fillRect(fxp, fyp - 5, 2, 3);
    sn.body.forEach((b, i) => { const bx = ox + b[0] * cell + 1, by = oy + b[1] * cell + 1, g = x.createLinearGradient(0, by, 0, by + cell - 2); g.addColorStop(0, i ? '#6ef0a8' : '#d8ffe8'); g.addColorStop(1, i ? '#1a9a54' : '#5ac88a'); x.fillStyle = g; rr(x, bx, by, cell - 2, cell - 2, 3); x.fill();
      if (!i) { x.fillStyle = '#0a1a0e'; x.fillRect(bx + 3 + sn.dir[0] * 2, by + 3 + sn.dir[1] * 2, 2, 2); x.fillRect(bx + 6 + sn.dir[0] * 2, by + 3 + sn.dir[1] * 2, 2, 2); } });
    if (sn.dead && st.popT <= 0) { title(x, 'GAME OVER', ox + cols * cell / 2, oy + rows * cell / 2 - 4, { size: 32, color: PAL.red }); howTo(x, (ox + cols * cell / 2) * 2, oy + rows * cell / 2 + 18, [['space', 'again'], ['click', 'again'], ['x', 'desktop']]); }
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
    x.strokeStyle = '#ff9a3a'; x.lineWidth = 2; x.strokeRect(MX + ms.cur[0] * MC + 1, MY + ms.cur[1] * MC + 1, MC - 2, MC - 2); x.lineWidth = 1;
    if (st.app === 'mines' && !ms.over) { const hx = Math.floor((hov.x - MX) / MC), hy = Math.floor((hov.y - MY) / MC); if (hx >= 0 && hy >= 0 && hx < MW && hy < MH && !ms.cells[hy * MW + hx].o) { x.fillStyle = 'rgba(255,255,255,0.3)'; x.fillRect(MX + hx * MC + 2, MY + hy * MC + 2, MC - 4, MC - 4); } }
    if (ms.over && st.popT <= 0) howTo(x, W, MY + MH * MC + 24, [['space', 'new game'], ['click', 'new game']]);
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
