// @ts-check
// "Super Commit Bros": a tiny retro platformer for the den CRT (160×120 buffer). Collect coins, stomp bugs, reach the
// flag before the timer runs out. Pure function of input + dt; the picture is fillRect pixel art (a CRT game, so it
// stays retro, drawn crisp by tv-screen.js). No text in the picture: score/time/cards are the GX HUD in Sora; floating
// words ('+100', 'SQUASHED') go out through onPop(x, y, text, tone) in buffer pixels.
import { rng } from './util.js';
import { SFX } from '../sfx.js';

const T = 8, ROWS = 15, COLS = 96, TIME = 45;
/** Deterministic level: ground with gaps, floating platforms, coins and bug enemies. */
function level() {
  const r = rng(1337), solid = new Uint8Array(ROWS * COLS), coins = [], bugs = [];
  for (let c = 0; c < COLS; c++) { const gap = c > 10 && c < COLS - 10 && (c % 17 === 8 || c % 17 === 9 || (c % 23 === 14)); if (!gap) { solid[13 * COLS + c] = 1; solid[14 * COLS + c] = 1; } }
  for (let c = 12; c < COLS - 12; c += 6 + Math.floor(r() * 4)) {
    const row = 8 + Math.floor(r() * 3), len = 3 + Math.floor(r() * 3);
    for (let k = 0; k < len; k++) solid[row * COLS + c + k] = 2;
    for (let k = 0; k < len; k++) if (r() > 0.35) coins.push({ x: (c + k) * T + 4, y: (row - 1) * T + 4, got: 0 });
  }
  for (let c = 6; c < COLS - 6; c += 3) if (r() > 0.6 && solid[13 * COLS + c]) coins.push({ x: c * T + 4, y: 11 * T, got: 0 });
  for (let c = 18; c < COLS - 12; c += 9 + Math.floor(r() * 5)) if (solid[13 * COLS + c] && solid[13 * COLS + c + 2]) bugs.push({ x: c * T, y: 12 * T, vx: -18, dead: 0 });
  for (let rr = 9; rr < 13; rr++) solid[rr * COLS + COLS - 5] = 0;
  return { solid, coins, bugs, flagX: (COLS - 5) * T };
}

/** @param {{ onPop?: (x: number, y: number, text: string, tone?: string) => void, onEnd?: (r: { win: boolean, score: number, got: number, total: number, best: number, newBest: boolean }) => void }} [cb] */
export function makePlatformer(cb = {}) {
  let L, p, cam, time, score, got, state, parts, shake, lastJump, checkpoint;
  let best = 0; try { best = Number(localStorage.getItem('gg-plat-best')) || 0; } catch { /* */ }
  const reset = () => { L = level(); p = { x: 16, y: 96, vx: 0, vy: 0, on: 0, face: 1, inv: 0 }; cam = 0; time = TIME; score = 0; got = 0; state = 'play'; parts = []; shake = 0; lastJump = false; checkpoint = 16; };
  reset();
  const at = (x, y) => { const c = Math.floor(x / T), r = Math.floor(y / T); if (c < 0 || c >= COLS) return 1; if (r < 0 || r >= ROWS) return 0; return L.solid[r * COLS + c]; };
  const pop = (x, y, c, n, txt) => { for (let i = 0; i < n; i++) parts.push({ x, y, vx: (Math.random() - 0.5) * 70, vy: -Math.random() * 70 - 20, l: 0.5, c }); if (txt) cb.onPop?.(x - cam, y - 4, txt, c === '#ffd84a' ? 'gold' : c === '#6ee7a0' ? 'up' : 'pink'); };
  const hurt = () => { if (p.inv > 0) return; SFX.play('arcade.boom', { vol: 0.4, pitch: 0.7 }); shake = 6; time = Math.max(0, time - 3); pop(p.x, p.y, '#ff4fd8', 10, '-3s'); p.x = checkpoint; p.y = 80; p.vx = p.vy = 0; p.inv = 1.2; };
  /** @param {number} dt @param {Set<string>} k */
  function step(dt, k) {
    for (const q of parts) { q.l -= dt; q.x += q.vx * dt; q.y += q.vy * dt; if (!q.txt) q.vy += 300 * dt; }
    parts = parts.filter(q => q.l > 0); shake = Math.max(0, shake - dt * 20);
    const jump = k.has('Space') || k.has('ArrowUp') || k.has('KeyW');
    if (state !== 'play') { lastJump = jump; return; }
    time -= dt; if (time <= 0) { time = 0; state = 'lose'; shake = 8; SFX.play('fail'); end(); }
    const dir = (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
    p.vx += (dir * 80 - p.vx) * Math.min(1, dt * (p.on ? 14 : 6)); if (dir) p.face = dir;
    if (jump && !lastJump && p.on) { p.vy = -195; p.on = 0; SFX.play('arcade.jump', { vol: 0.4 }); pop(p.x, p.y + 6, '#8a83a0', 4); }
    if (!jump && p.vy < -60) p.vy = -60; lastJump = jump;
    p.vy = Math.min(260, p.vy + 560 * dt); p.inv = Math.max(0, p.inv - dt);
    // axis-separated collision, player box 6×8 centred at x, bottom at y+4
    p.x += p.vx * dt; for (const yy of [p.y - 3, p.y + 3]) { if (at(p.x + 3, yy)) { p.x = Math.floor((p.x + 3) / T) * T - 3.01; p.vx = 0; } if (at(p.x - 3, yy)) { p.x = Math.floor((p.x - 3) / T + 1) * T + 3.01; p.vx = 0; } }
    p.y += p.vy * dt; p.on = 0;
    if (p.vy >= 0 && (at(p.x - 2, p.y + 4) || at(p.x + 2, p.y + 4))) { p.y = Math.floor((p.y + 4) / T) * T - 4; p.vy = 0; p.on = 1; if (p.x > checkpoint + 120) checkpoint = p.x; }
    if (p.vy < 0 && (at(p.x - 2, p.y - 4) || at(p.x + 2, p.y - 4))) { p.y = Math.floor((p.y - 4) / T + 1) * T + 4; p.vy = 0; }
    if (p.y > ROWS * T + 10) hurt();
    for (const c of L.coins) if (!c.got && Math.abs(c.x - p.x) < 6 && Math.abs(c.y - p.y) < 7) { c.got = 1; got++; SFX.play('coin', { vol: 0.35, pitch: 1.3 }); score += 100; pop(c.x, c.y, '#ffd84a', 6, '+100'); }
    for (const g of L.bugs) {
      if (g.dead) { g.dead += dt; continue; }
      g.x += g.vx * dt; if (at(g.x + (g.vx > 0 ? 4 : -4), g.y) || !at(g.x + (g.vx > 0 ? 4 : -4), g.y + 6)) g.vx = -g.vx;
      if (Math.abs(g.x - p.x) < 7 && Math.abs(g.y - p.y) < 8) { if (p.vy > 20 && p.y < g.y - 2) { g.dead = 0.01; p.vy = -150; SFX.play('squeak', { vol: 0.4 }); score += 250; shake = 3; pop(g.x, g.y, '#6ee7a0', 10, 'SQUASHED'); } else hurt(); }
    }
    if (p.x >= L.flagX) { state = 'win'; SFX.play('win'); score += Math.ceil(time) * 10; shake = 4; for (let i = 0; i < 4; i++) pop(p.x, p.y - 10, ['#ffd84a', '#ff4fd8', '#6ee7a0'][i % 3], 10); end(); }
    cam += (Math.max(0, Math.min(COLS * T - 160, p.x - 64)) - cam) * Math.min(1, dt * 8);
  }
  function end() { let nb = false; if (score > best) { best = score; nb = true; try { localStorage.setItem('gg-plat-best', String(best)); } catch { /* */ } }
    cb.onEnd?.({ win: state === 'win', score, got, total: L.coins.length, best, newBest: nb }); }
  /** @param {CanvasRenderingContext2D} b @param {number} t */
  function draw(b, t) {
    const R = (c, x, y, w, h) => { b.fillStyle = c; b.fillRect(Math.round(x), Math.round(y), w, h); };
    R('#1e2240', 0, 0, 160, 120); for (let i = 0; i < 30; i++) R(i % 4 ? '#5a5a88' : '#e0a458', ((i * 53 - cam * 0.2) % 180 + 180) % 180 - 10, (i * 37) % 70, 1, 1);
    R('#ffe8b0', 120, 22, 6, 6); R('#ffe8b0', 119, 23, 8, 4);
    for (let i = 0; i < 12; i++) { const h = 20 + (i * 29) % 30, x = ((i * 34 - cam * 0.4) % 400 + 400) % 400 - 30; R('#2a2440', x, 104 - h, 26, h); if (i % 2) R('#e0a458', x + 6, 104 - h + 6, 2, 2); }
    b.save(); b.translate(-Math.round(cam) + (shake ? Math.round((Math.random() - 0.5) * shake) : 0), 0);
    const c0 = Math.floor(cam / T), c1 = c0 + 22;
    for (let r = 0; r < ROWS; r++) for (let c = c0; c < c1 && c < COLS; c++) { const s = L.solid[r * COLS + c]; if (!s) continue; const x = c * T, y = r * T;
      if (s === 1) { R(r === 13 ? '#3d7a52' : '#3a2a30', x, y, T, T); if (r === 13) { R('#6ee7a0', x, y, T, 1); R('#2f5a3d', x + 2, y + 4, 1, 1); } else R('#2a1e24', x + (c % 3) * 2, y + 3, 2, 2); }
      else { R('#e0a458', x, y, T, T); R('#8a5a2a', x, y + T - 1, T, 1); R('#ffb36b', x, y, T, 1); R('#8a5a2a', x + 3, y + 3, 2, 2); } }
    for (const c of L.coins) if (!c.got) { const w = Math.abs(Math.cos(t * 4 + c.x)) * 4 + 1; R('#ffd84a', c.x - w / 2, c.y - 3, w, 6); R('#fff2a0', c.x - w / 2, c.y - 3, 1, 2); }
    for (const g of L.bugs) { if (g.dead > 0.4) continue; if (g.dead) { R('#ff4fd8', g.x - 4, g.y + 2, 8, 2); continue; } const lg = Math.floor(t * 8) % 2; R('#ff4fd8', g.x - 4, g.y - 3, 8, 6); R('#141418', g.x - 2, g.y - 2, 1, 1); R('#141418', g.x + 1, g.y - 2, 1, 1); R('#8a2a7a', g.x - 4 + lg, g.y + 3, 2, 1); R('#8a2a7a', g.x + 2 - lg, g.y + 3, 2, 1); R('#ff4fd8', g.x - 3, g.y - 5, 1, 2); R('#ff4fd8', g.x + 2, g.y - 5, 1, 2); }
    R('#d8dccf', L.flagX, 40, 1, 64); R('#3ddc84', L.flagX + 1, 40 + Math.sin(t * 6), 12, 7); R('#141418', L.flagX + 4, 42 + Math.sin(t * 6), 2, 2);
    if (!(p.inv > 0 && Math.floor(t * 16) % 2)) { const run = p.on && Math.abs(p.vx) > 10 ? Math.floor(t * 12) % 2 : 0;
      R('#3a2a6a', p.x - 3, p.y - 1, 6, 4); R('#6ee7a0', p.x - 3, p.y - 4, 6, 3); R('#f0c8a0', p.x - 2, p.y - 8, 4, 4); R('#1a1824', p.x - 3, p.y - 9, 6, 2); R('#e0a458', p.x + p.face * 2 - 1, p.y - 9, 3, 1);
      R('#141418', p.x + (p.face > 0 ? 0 : -2), p.y - 7, 1, 1); R('#1a1824', p.x - 3 + run, p.y + 3, 2, 1); R('#1a1824', p.x + 1 - run, p.y + 3, 2, 1); }
    for (const q of parts) R(q.c, q.x, q.y, 2, 2);
    b.restore();
  }
  return { step, draw, reset, get state() { return state; }, get time() { return time; }, get score() { return score; }, get got() { return got; }, get total() { return L.coins.length; }, get best() { return best; } };
}
