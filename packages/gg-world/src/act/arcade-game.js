// @ts-check
// BUG INVADERS: a tiny space-invaders game on the den arcade cabinet. 320x240 internal canvas.
import { text } from './util.js';
import { SFX } from '../sfx.js';

const W = 320, H = 240, HI_KEY = 'nightrooms.buginvaders.hi';
const COLORS = ['#ff4fd8', '#ffb36b', '#6ee7a0', '#3ddc84'], PTS = [40, 30, 20, 10];
// '{' shape, 5x9 cells; '}' is mirrored
const BRACE = ['..###', '.##..', '.##..', '.##..', '##...', '.##..', '.##..', '.##..', '..###'];

/** @param {{x:CanvasRenderingContext2D, keys:Set<string>, rand:()=>number}} o */
export function bugInvaders(o) {
  const { x, keys, rand } = o;
  let hi = 0; try { hi = Number(localStorage.getItem(HI_KEY)) || 0; } catch { /* private mode */ }
  const st = { mode: 'attract', t: 0, score: 0, lives: 3, wave: 1, px: W / 2, dir: 1, stepT: 0, frame: 0, dead: 0, shake: 0, over: 0, banner: '', bannerT: 0, ufo: /** @type {any} */ (null), ufoT: 12 };
  /** @type {{x:number,y:number,row:number,alive:boolean}[]} */ let bugs = [];
  /** @type {{x:number,y:number}[]} */ let shots = [];
  /** @type {{x:number,y:number}[]} */ let bombs = [];
  /** @type {Set<string>} */ let cells = new Set();
  /** @type {{x:number,y:number,vx:number,vy:number,t:number,c:string}[]} */ const parts = [];
  /** @type {{x:number,y:number,s:string,t:number,c:string}[]} */ const pops = [];
  const prev = new Set();
  /** @type {Set<string>} */ const taps = new Set();
  const spawnWave = () => {
    bugs = []; for (let r = 0; r < 4; r++) for (let c = 0; c < 9; c++) bugs.push({ x: 44 + c * 26, y: 34 + r * 18 + Math.min(4, st.wave - 1) * 6, row: r, alive: true });
    st.dir = 1; shots = []; bombs = [];
  };
  const buildShields = () => { cells = new Set(); for (let s = 0; s < 4; s++) { const ox = 40 + s * 70; for (let r = 0; r < 9; r++) for (let c = 0; c < 5; c++) { if (BRACE[r][c] === '#') { cells.add((ox + c * 2) + ',' + (176 + r * 2)); cells.add((ox + 26 - c * 2) + ',' + (176 + r * 2)); } } } };
  const snd = (n, o) => { if (st.mode === 'play') SFX.play(n, o); };
  const newGame = () => { SFX.play('arcade.coin'); st.mode = 'play'; st.score = 0; st.lives = 3; st.wave = 1; st.px = W / 2; spawnWave(); buildShields(); st.banner = 'WAVE 1 · npm run fix'; st.bannerT = 2; };
  const burst = (bx, by, c, n = 10) => { for (let i = 0; i < n; i++) { const a = rand() * 6.28, s = 30 + rand() * 80; parts.push({ x: bx, y: by, vx: Math.cos(a) * s, vy: Math.sin(a) * s, t: 0, c }); } };
  const hitCells = (bx, by, r = 3) => { let h = false; for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) { const k = (Math.round((bx + dx) / 2) * 2) + ',' + (Math.round((by + dy) / 2) * 2); if (cells.has(k)) { cells.delete(k); h = true; } } return h; };
  const cellAt = (bx, by) => cells.has((Math.round(bx / 2) * 2) + ',' + (Math.round(by / 2) * 2));
  spawnWave(); buildShields();

  /** @param {number} dt */
  function update(dt) {
    st.t += dt; const pressed = k => taps.has(k) || (keys.has(k) && !prev.has(k));
    if (st.mode === 'attract') { if (pressed('Space') || pressed('Enter')) newGame(); else demo(dt); }
    else if (st.mode === 'over') { st.over += dt; if ((st.over > 1.2 && pressed('Space')) || st.over > 8) { st.mode = 'attract'; spawnWave(); buildShields(); } }
    else play(dt, pressed);
    for (const k of [...prev]) if (!keys.has(k)) prev.delete(k); for (const k of keys) prev.add(k); taps.clear();
    for (const p of parts) { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; } while (parts.length && parts[0].t > 0.5) parts.shift();
    for (const p of pops) p.t += dt; while (pops.length && pops[0].t > 0.9) pops.shift();
    st.shake = Math.max(0, st.shake - dt * 20); st.bannerT -= dt;
  }
  function march(dt) {
    const alive = bugs.filter(b => b.alive); if (!alive.length) return alive;
    st.stepT -= dt; if (st.stepT <= 0) {
      st.stepT = Math.max(0.05, (0.55 - st.wave * 0.04) * (0.25 + 0.75 * alive.length / bugs.length)); st.frame ^= 1; snd('blip', { vol: 0.12, pitch: st.frame ? 0.5 : 0.45 });
      const minX = Math.min(...alive.map(b => b.x)), maxX = Math.max(...alive.map(b => b.x));
      if ((st.dir > 0 && maxX > W - 18) || (st.dir < 0 && minX < 18)) { st.dir *= -1; for (const b of alive) b.y += 8; } else for (const b of alive) b.x += 5 * st.dir;
    }
    return alive;
  }
  function demo(dt) { if (march(dt).some(b => b.y > 150)) spawnWave(); }
  function play(dt, pressed) {
    if (st.dead > 0) { st.dead -= dt; if (st.dead <= 0) { if (st.lives <= 0) { st.mode = 'over'; st.over = 0; if (st.score > hi) { hi = st.score; try { localStorage.setItem(HI_KEY, String(hi)); } catch { /* ignore */ } } } else { bombs = []; } } return; }
    const mv = (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0);
    st.px = Math.max(14, Math.min(W - 14, st.px + mv * 130 * dt));
    if ((pressed('Space') || pressed('ArrowUp')) && shots.length < 2 && (snd('arcade.shoot', { vol: 0.4 }), true)) shots.push({ x: st.px, y: 208 });
    const alive = march(dt);
    if (!alive.length) { snd('levelup'); st.wave++; spawnWave(); st.banner = 'WAVE ' + st.wave + ' · they reproduced'; st.bannerT = 2; st.shake = 4; return; }
    // bombs from the lowest bug in a random column
    if (rand() < dt * (0.9 + st.wave * 0.35)) { const b = alive[Math.floor(rand() * alive.length)]; const low = alive.filter(a => Math.abs(a.x - b.x) < 4).sort((p, q) => q.y - p.y)[0]; bombs.push({ x: low.x, y: low.y + 6 }); }
    for (const s of shots) s.y -= 260 * dt;
    for (const s of bombs) s.y += (90 + st.wave * 10) * dt;
    shots = shots.filter(s => {
      if (s.y < 10) return false;
      if (cellAt(s.x, s.y)) { hitCells(s.x, s.y, 2); return false; }
      for (const b of alive) if (b.alive && Math.abs(s.x - b.x) < 9 && Math.abs(s.y - b.y) < 7) { b.alive = false; snd('arcade.boom', { vol: 0.35, pitch: 1.2 + b.row * 0.1 }); st.score += PTS[b.row]; burst(b.x, b.y, COLORS[b.row]); pops.push({ x: b.x, y: b.y, s: String(PTS[b.row]), t: 0, c: COLORS[b.row] }); st.shake = 1.5; return false; }
      if (st.ufo && Math.abs(s.x - st.ufo.x) < 26 && Math.abs(s.y - 20) < 7) { const p = [100, 150, 300][Math.floor(rand() * 3)]; st.score += p; snd('score'); burst(st.ufo.x, 20, '#ff5050', 18); pops.push({ x: st.ufo.x, y: 22, s: p + '!', t: 0, c: '#ff5050' }); st.ufo = null; st.shake = 4; return false; }
      return true;
    });
    bombs = bombs.filter(s => {
      if (s.y > H) return false;
      if (cellAt(s.x, s.y)) { hitCells(s.x, s.y, 3); return false; }
      if (Math.abs(s.x - st.px) < 10 && Math.abs(s.y - 214) < 6) { snd('arcade.boom', { vol: 0.7, pitch: 0.6 }); if (st.lives <= 1) snd('fail', { delay: 0.4 }); st.lives--; st.dead = 1.4; st.shake = 8; burst(st.px, 214, '#6ee7a0', 24); st.banner = st.lives > 0 ? 'SEGFAULT · core dumped' : 'GAME OVER'; st.bannerT = 1.4; return false; }
      return true;
    });
    for (const b of alive) { if (b.y > 170) hitCells(b.x, b.y, 6); if (b.y > 206) { if (st.lives > 0) snd('fail'); st.lives = 0; st.dead = 1.4; st.banner = 'BUGS IN PROD'; st.bannerT = 2; } }
    st.ufoT -= dt; if (!st.ufo && st.ufoT <= 0) { st.ufo = { x: -30, v: 60 }; st.ufoT = 14 + rand() * 10; }
    if (st.ufo) { st.ufo.x += st.ufo.v * dt; if (st.ufo.x > W + 30) st.ufo = null; }
  }
  function bug(bx, by, row, fr) {
    x.fillStyle = COLORS[row];
    x.fillRect(bx - 4, by - 3, 8, 6); x.fillRect(bx - 2, by - 5, 4, 2); // body + head
    x.fillRect(bx - 3, by - 7, 1, 2); x.fillRect(bx + 2, by - 7, 1, 2); // antennae
    const l = fr ? 1 : -1; for (const dy of [-2, 0, 2]) { x.fillRect(bx - 7, by + dy + (dy === 0 ? 0 : l), 3, 1); x.fillRect(bx + 4, by + dy + (dy === 0 ? 0 : -l), 3, 1); }
    x.fillStyle = '#0a0a12'; x.fillRect(bx - 2, by - 4, 1, 1); x.fillRect(bx + 1, by - 4, 1, 1); x.fillRect(bx, by - 2, 1, 5);
  }
  function draw(t) {
    x.save(); x.fillStyle = '#05080a'; x.fillRect(0, 0, W, H);
    if (st.shake) x.translate(Math.round((rand() - 0.5) * st.shake), Math.round((rand() - 0.5) * st.shake));
    // stars
    x.fillStyle = '#1a3a2a'; for (let i = 0; i < 40; i++) x.fillRect((i * 73) % W, (i * 41 + Math.floor(t * 8)) % H, 1, 1);
    text(x, 'SCORE ' + String(st.score).padStart(5, '0'), 6, 12, { color: '#6ee7a0' });
    text(x, 'HI ' + String(Math.max(hi, st.score)).padStart(5, '0'), W / 2, 12, { color: '#ffb36b', align: 'center' });
    if (st.mode !== 'attract') text(x, 'LIVES ' + '>_ '.repeat(Math.max(0, st.lives)).trim(), W - 6, 12, { color: '#6ee7a0', align: 'right' });
    else text(x, 'CREDIT 1', W - 6, 12, { color: '#6ee7a0', align: 'right' });
    for (const b of bugs) if (b.alive) bug(Math.round(b.x), Math.round(b.y), b.row, st.frame);
    x.fillStyle = '#3ddc84'; for (const k of cells) { const [cx, cy] = k.split(',').map(Number); x.fillRect(cx, cy, 2, 2); }
    if (st.ufo) { const u = st.ufo; x.fillStyle = '#ff5050'; x.fillRect(u.x - 24, 15, 48, 11); text(x, 'SEGFAULT', u.x, 24, { color: '#1a0505', align: 'center' }); }
    for (const s of shots) text(x, ';', s.x, s.y + 4, { color: '#e8ffe8', align: 'center' });
    for (const s of bombs) { x.fillStyle = (s.y | 0) % 6 < 3 ? '#ff5050' : '#ffb36b'; x.fillRect(s.x - 1, s.y - 3, 2, 6); x.fillRect(s.x - 2, s.y + (((s.y | 0) % 4) < 2 ? -1 : 1), 4, 1); }
    if (st.mode === 'play' && !(st.dead > 0)) text(x, '>_', st.px, 218, { color: '#6ee7a0', align: 'center', shadow: '#0f3a22' });
    x.fillStyle = '#1e5a3a'; x.fillRect(0, 226, W, 1);
    for (const p of parts) { x.globalAlpha = 1 - p.t / 0.5; x.fillStyle = p.c; x.fillRect(p.x | 0, p.y | 0, 2, 2); } x.globalAlpha = 1;
    for (const p of pops) { x.globalAlpha = 1 - p.t / 0.9; text(x, p.s, p.x, p.y - p.t * 18, { color: p.c, align: 'center' }); } x.globalAlpha = 1;
    x.restore();
    if (st.mode === 'attract') {
      x.fillStyle = 'rgba(5,8,10,0.72)'; x.fillRect(40, 70, 240, 116);
      text(x, 'BUG INVADERS', W / 2, 104, { title: true, size: 32, color: '#ff4fd8', align: 'center', shadow: '#3a0a30' });
      text(x, 'they compiled. they multiplied.', W / 2, 124, { color: '#8e9a88', align: 'center' });
      PTS.forEach((p, i) => { bug(92 + i * 48, 144, i, Math.floor(t * 2) % 2); text(x, '=' + p, 102 + i * 48, 148, { color: COLORS[i] }); });
      if (Math.sin(t * 5) > -0.2) text(x, 'PRESS SPACE', W / 2, 176, { color: '#ffe2b0', align: 'center' });
    }
    if (st.mode === 'over') { x.fillStyle = 'rgba(5,8,10,0.8)'; x.fillRect(60, 90, 200, 60); text(x, 'GAME OVER', W / 2, 120, { title: true, size: 32, color: '#ff5050', align: 'center' }); text(x, st.score >= hi && st.score > 0 ? 'NEW HIGH SCORE ' + st.score : 'works on my machine', W / 2, 140, { color: '#ffb36b', align: 'center' }); }
    if (st.bannerT > 0 && st.mode === 'play') text(x, st.banner, W / 2, 166, { color: '#ffe2b0', align: 'center', shadow: '#000' });
    // CRT: scanlines + vignette
    x.fillStyle = 'rgba(0,0,0,0.22)'; for (let y = 0; y < H; y += 2) x.fillRect(0, y, W, 1);
    const v = x.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.62); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.55)'); x.fillStyle = v; x.fillRect(0, 0, W, H);
  }
  return { update, draw, tap: k => { taps.add(k); }, W, H };
}
