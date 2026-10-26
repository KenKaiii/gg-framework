// @ts-check
// BUG INVADERS: a tiny space-invaders game on the den arcade cabinet. 320x240 internal canvas.
import { text } from './util.js';
import { PAL, panel, badge, button, banner, title, glow, particles, ease, clamp, keyChip } from './art.js';
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
    else if (st.mode === 'over') { st.over += dt; if (st.over > 1.2 && pressed('Space')) newGame(); else if (st.over > 30) { st.mode = 'attract'; st.t = 0; spawnWave(); buildShields(); } }
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
  // cached art: glowing bug sprites (row x frame), the cabinet backdrop (nebula, stars, bezel glow)
  const sprite = (w, h, f) => { const c = document.createElement('canvas'); c.width = w; c.height = h; f(/** @type {CanvasRenderingContext2D} */ (c.getContext('2d'))); return c; };
  const bugPix = (g, bx, by, row, fr) => {
    g.fillStyle = COLORS[row]; g.fillRect(bx - 4, by - 3, 8, 6); g.fillRect(bx - 2, by - 5, 4, 2); g.fillRect(bx - 3, by - 7, 1, 2); g.fillRect(bx + 2, by - 7, 1, 2);
    const l = fr ? 1 : -1; for (const dy of [-2, 0, 2]) { g.fillRect(bx - 7, by + dy + (dy === 0 ? 0 : l), 3, 1); g.fillRect(bx + 4, by + dy + (dy === 0 ? 0 : -l), 3, 1); }
    g.fillStyle = 'rgba(255,255,255,0.45)'; g.fillRect(bx - 4, by - 3, 8, 1);
    g.fillStyle = '#0a0a12'; g.fillRect(bx - 2, by - 4, 1, 1); g.fillRect(bx + 1, by - 4, 1, 1); g.fillRect(bx, by - 2, 1, 5);
  };
  const BUGS = [0, 1, 2, 3].map(row => [0, 1].map(fr => sprite(24, 24, g => { g.shadowColor = COLORS[row]; g.shadowBlur = 6; bugPix(g, 12, 12, row, fr); g.shadowBlur = 0; bugPix(g, 12, 12, row, fr); })));
  const SHIELD = sprite(4, 4, g => { g.fillStyle = '#3ddc84'; g.fillRect(0, 0, 2, 2); g.fillStyle = '#9affc0'; g.fillRect(0, 0, 2, 1); });
  const BACK = sprite(W, H, g => {
    const v = g.createRadialGradient(W / 2, H * 0.4, 10, W / 2, H / 2, W * 0.7); v.addColorStop(0, '#16102a'); v.addColorStop(0.6, '#0a0816'); v.addColorStop(1, '#030308'); g.fillStyle = v; g.fillRect(0, 0, W, H);
    glow(g, 70, 70, 90, '#ff4fd8', 0.10); glow(g, 260, 150, 110, '#3a7aff', 0.10);
    let s = 9; const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < 70; i++) { g.fillStyle = r() < 0.2 ? '#ffe8f4' : r() < 0.5 ? '#6a7ab8' : '#2a3a5a'; g.fillRect(Math.floor(r() * W), Math.floor(r() * H), 1, 1); }
    // ground: a glowing grid floor under the player
    const fg = g.createLinearGradient(0, 226, 0, H); fg.addColorStop(0, '#2a0a2a'); fg.addColorStop(1, '#08040c'); g.fillStyle = fg; g.fillRect(0, 226, W, H - 226);
    g.fillStyle = '#ff4fd8'; g.fillRect(0, 226, W, 1); g.globalAlpha = 0.35; for (let i = -10; i <= 10; i++) { g.strokeStyle = '#ff4fd8'; g.beginPath(); g.moveTo(W / 2 + i * 8, 227); g.lineTo(W / 2 + i * 40, H); g.stroke(); } g.globalAlpha = 1;
  });
  const SCAN = sprite(W, H, g => { g.fillStyle = 'rgba(0,0,0,0.2)'; for (let y = 0; y < H; y += 2) g.fillRect(0, y, W, 1); const v = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.62); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.55)'); g.fillStyle = v; g.fillRect(0, 0, W, H); });
  const fx = particles(); let shown = 0, lastT = 0, overT = -1, hot = '';
  const chip = (s, X, Y) => keyChip(x, s, X, Y);
  function bug(bx, by, row, fr) { x.drawImage(BUGS[row][fr], bx - 12, by - 12); }
  function ship(px, py) {
    x.fillStyle = '#0f3a22'; x.fillRect(px - 9, py + 1, 18, 3);
    x.fillStyle = '#3ddc84'; x.fillRect(px - 9, py - 2, 18, 4); x.fillRect(px - 5, py - 5, 10, 3); x.fillRect(px - 1, py - 9, 2, 4);
    x.fillStyle = '#b8ffd8'; x.fillRect(px - 8, py - 2, 16, 1); x.fillRect(px - 1, py - 9, 1, 3);
    title(x, '>_', px, py + 3, { size: 16, body: true, color: '#0a2a18', ink: 'rgba(0,0,0,0)' });
  }
  /** @param {number} t */
  function draw(t) {
    const dt = clamp(t - lastT, 0, 0.05); lastT = t; shown += (st.score - shown) * Math.min(1, dt * 10); if (Math.abs(st.score - shown) < 0.5) shown = st.score;
    x.save(); x.drawImage(BACK, 0, 0);
    if (st.shake) x.translate(Math.round((rand() - 0.5) * st.shake), Math.round((rand() - 0.5) * st.shake));
    x.fillStyle = '#4a5a8a'; for (let i = 0; i < 24; i++) x.fillRect((i * 73) % W, (i * 41 + Math.floor(t * 12)) % 226, 1, 2); // drifting stars
    for (const b of bugs) if (b.alive) bug(Math.round(b.x), Math.round(b.y), b.row, st.frame);
    for (const k of cells) { const i = k.indexOf(','); x.drawImage(SHIELD, +k.slice(0, i), +k.slice(i + 1)); }
    for (const s of shots) { x.fillStyle = 'rgba(200,255,220,0.35)'; x.fillRect(s.x - 1, s.y, 2, 8); title(x, ';', s.x, s.y + 4, { size: 16, body: true, color: '#e8ffe8' }); }
    for (const s of bombs) { x.fillStyle = (s.y | 0) % 6 < 3 ? '#ff5050' : '#ffb36b'; x.fillRect(s.x - 1, s.y - 3, 2, 6); x.fillRect(s.x - 2, s.y + (((s.y | 0) % 4) < 2 ? -1 : 1), 4, 1); }
    if (st.mode === 'play' && !(st.dead > 0)) { ship(st.px, 216); }
    for (const p of parts) { x.globalAlpha = 1 - p.t / 0.5; x.fillStyle = p.c; x.fillRect(p.x | 0, p.y | 0, 2, 2); } x.globalAlpha = 1;
    fx.draw(x, dt);
    for (const p of pops) { x.globalAlpha = 1 - p.t / 0.9; title(x, p.s, p.x, p.y - p.t * 18, { size: 16, body: true, color: p.c }); } x.globalAlpha = 1;
    x.restore();
    // HUD: glass chips along the top
    x.drawImage(SCAN, 0, 0);
    const btns = [];
    if (st.mode === 'play') {
      const strip = (X, w, l, v, c) => { panel(x, X, 2, w, 17, { style: 'glass', r: 3 }); title(x, l, X + 5, 15, { size: 16, body: true, align: 'left', color: PAL.dim }); title(x, v, X + w - 5, 15, { size: 16, body: true, align: 'right', color: c }); };
      strip(3, 90, 'SCORE', String(Math.round(shown)).padStart(5, '0'), PAL.green); strip(W / 2 - 50, 100, 'HI', String(Math.max(hi, st.score)).padStart(5, '0'), PAL.gold);
      strip(W - 93, 90, 'W' + st.wave, '', PAL.pink);
      for (let i = 0; i < 3; i++) { x.globalAlpha = i < st.lives ? 1 : 0.2; x.fillStyle = '#3ddc84'; x.fillRect(W - 66 + i * 20, 12, 14, 3); x.fillRect(W - 62 + i * 20, 9, 6, 3); } x.globalAlpha = 1;
      if (st.bannerT > 0) { const k = ease.outBack(clamp((2 - st.bannerT) / 0.4, 0, 1)); x.save(); x.globalAlpha = clamp(st.bannerT * 2, 0, 1); x.translate(W / 2, 160); x.scale(k, k); title(x, st.banner, 0, 0, { size: 16, body: true, color: PAL.goldHi, glow: PAL.pink, glowR: 8 }); x.restore(); }
    }
  if (st.ufo && st.mode === 'play') { const u = st.ufo; glow(x, u.x, 20, 34, '#ff5050', 0.35); panel(x, u.x - 26, 13, 52, 14, { style: 'metal', r: 6 }); x.fillStyle = Math.sin(t * 8) > 0 ? '#ff5050' : '#ffb36b'; for (let i = -2; i <= 2; i++) x.fillRect(u.x + i * 9, 24, 2, 2); title(x, 'SEGFAULT', u.x, 23, { size: 16, body: true, color: '#ff8a8a' }); }
    if (st.mode === 'attract') {
      const k = ease.outBack(clamp(st.t / 0.5, 0, 1)); x.save(); x.translate(W / 2, H / 2); x.scale(k, k); x.translate(-W / 2, -H / 2);
      panel(x, 30, 40, 260, 170, { style: 'neon' }); glow(x, W / 2, 74, 120, '#ff4fd8', 0.18 + Math.sin(t * 2) * 0.05);
      title(x, 'BUG INVADERS', W / 2, 82, { size: 32, color: PAL.pink, glow: '#ff4fd8', glowR: 12 });
      title(x, 'they compiled. they multiplied.', W / 2, 100, { size: 16, body: true, color: PAL.dim });
      PTS.forEach((p, i) => { bug(86 + i * 48, 120 + Math.round(Math.sin(t * 3 + i) * 1.5), i, Math.floor(t * 2) % 2); title(x, '' + p, 102 + i * 48, 125, { size: 16, body: true, color: COLORS[i], align: 'left' }); });
      let cx = 52; cx += chip('<', cx, 152) + 2; cx += chip('>', cx, 152) + 4; title(x, 'move', cx, 152, { size: 16, body: true, align: 'left' }); cx += 34; cx += chip('SPACE', cx, 152) + 4; title(x, 'or click: fire', cx, 152, { size: 16, body: true, align: 'left' });
      title(x, 'hold left / right third to steer', W / 2, 172, { size: 16, body: true, color: PAL.dim });
      btns.push({ id: 'play', ...button(x, W / 2 - 50, 180, 100, 22, 'INSERT COIN', { primary: true, hot: hot === 'play' || Math.sin(t * 3) > 0.6 }) });
      x.restore();
    }
    if (st.mode === 'over') {
      if (overT < 0) { overT = 0; const nb = st.score >= hi && st.score > 0; fx.burst(W / 2, 110, { n: 30, colors: nb ? [PAL.gold, PAL.goldHi, PAL.pink] : ['#ff5050', '#ffb36b'] }); if (nb) fx.confetti(W); }
      overT += dt; const nb = st.score >= hi && st.score > 0;
      banner(x, W, H - 60, nb ? 'NEW HIGH' : 'GAME OVER', nb ? 'top of the leaderboard' : 'works on my machine', overT, { color: nb ? PAL.gold : PAL.red });
      if (overT > 0.4) {
        badge(x, W / 2 - 78, 138, 'score', Math.round(shown), { color: PAL.green, w: 76 }); badge(x, W / 2 + 2, 138, 'best', Math.max(hi, st.score), { color: PAL.gold, w: 76 });
        btns.push({ id: 'play', ...button(x, W / 2 - 96, 184, 90, 24, 'PLAY AGAIN', { primary: true, hot: hot === 'play' }) });
        btns.push({ id: 'leave', ...button(x, W / 2 + 6, 184, 90, 24, 'LEAVE', { hot: hot === 'leave' }) });
      }
    } else overT = -1;
    return btns;
  }
  return { update, draw, tap: k => { taps.add(k); }, hover: id => { hot = id; }, get mode() { return st.mode; }, replay: () => newGame(), W, H };
}
