// @ts-check
// BUG INVADERS: a tiny space-invaders game on the den arcade cabinet. The picture is pixel art drawn at 1x into a
// 320x240 canvas the cabinet scales up crisply; all text (score, banners, cards) lives outside it in Sora.
import { SFX } from '../sfx.js';

const W = 320, H = 240, HI_KEY = 'nightrooms.buginvaders.hi';
const COLORS = ['#ff4fd8', '#ffb36b', '#6ee7a0', '#3ddc84'], PTS = [40, 30, 20, 10];
// '{' shape, 5x9 cells; '}' is mirrored
const BRACE = ['..###', '.##..', '.##..', '.##..', '##...', '.##..', '.##..', '.##..', '..###'];

/** @param {{x:CanvasRenderingContext2D, keys:Set<string>, rand:()=>number, on?:(ev:string, a?:any)=>void}} o */
export function bugInvaders(o) {
  const { x, keys, rand } = o; const emit = (ev, a) => o.on?.(ev, a);
  let hi = 0; try { hi = Number(localStorage.getItem(HI_KEY)) || 0; } catch { /* private mode */ }
  const st = { mode: 'attract', t: 0, score: 0, lives: 3, wave: 1, px: W / 2, dir: 1, stepT: 0, frame: 0, dead: 0, shake: 0, over: 0, banner: '', bannerT: 0, ufo: /** @type {any} */ (null), ufoT: 12 };
  /** @type {{x:number,y:number,row:number,alive:boolean}[]} */ let bugs = [];
  /** @type {{x:number,y:number}[]} */ let shots = [];
  /** @type {{x:number,y:number}[]} */ let bombs = [];
  /** @type {Set<string>} */ let cells = new Set();
  /** @type {{x:number,y:number,vx:number,vy:number,t:number,c:string}[]} */ const parts = [];
  const prev = new Set();
  /** @type {Set<string>} */ const taps = new Set();
  const spawnWave = () => {
    bugs = []; for (let r = 0; r < 4; r++) for (let c = 0; c < 9; c++) bugs.push({ x: 44 + c * 26, y: 34 + r * 18 + Math.min(4, st.wave - 1) * 6, row: r, alive: true });
    st.dir = 1; shots = []; bombs = [];
  };
  const buildShields = () => { cells = new Set(); for (let s = 0; s < 4; s++) { const ox = 40 + s * 70; for (let r = 0; r < 9; r++) for (let c = 0; c < 5; c++) { if (BRACE[r][c] === '#') { cells.add((ox + c * 2) + ',' + (176 + r * 2)); cells.add((ox + 26 - c * 2) + ',' + (176 + r * 2)); } } } };
  const snd = (n, o) => { if (st.mode === 'play') SFX.play(n, o); };
  const newGame = () => { SFX.play('arcade.coin'); st.mode = 'play'; st.score = 0; st.lives = 3; st.wave = 1; st.px = W / 2; spawnWave(); buildShields(); st.banner = 'Wave 1: npm run fix'; st.bannerT = 2; emit('banner', st.banner); };
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
    if (st.dead > 0) { st.dead -= dt; if (st.dead <= 0) { if (st.lives <= 0) { st.mode = 'over'; st.over = 0; const nb = st.score > hi; if (st.score > hi) { hi = st.score; try { localStorage.setItem(HI_KEY, String(hi)); } catch { /* ignore */ } } emit('over', { score: st.score, hi, best: nb, wave: st.wave }); } else { bombs = []; } } return; }
    const mv = (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0);
    st.px = Math.max(14, Math.min(W - 14, st.px + mv * 130 * dt));
    if ((pressed('Space') || pressed('ArrowUp')) && shots.length < 2 && (snd('arcade.shoot', { vol: 0.4 }), true)) shots.push({ x: st.px, y: 208 });
    const alive = march(dt);
    if (!alive.length) { snd('levelup'); st.wave++; spawnWave(); st.banner = 'Wave ' + st.wave + ': they reproduced'; st.bannerT = 2; emit('banner', st.banner); st.shake = 4; return; }
    // bombs from the lowest bug in a random column
    if (rand() < dt * (0.9 + st.wave * 0.35)) { const b = alive[Math.floor(rand() * alive.length)]; const low = alive.filter(a => Math.abs(a.x - b.x) < 4).sort((p, q) => q.y - p.y)[0]; bombs.push({ x: low.x, y: low.y + 6 }); }
    for (const s of shots) s.y -= 260 * dt;
    for (const s of bombs) s.y += (90 + st.wave * 10) * dt;
    shots = shots.filter(s => {
      if (s.y < 10) return false;
      if (cellAt(s.x, s.y)) { hitCells(s.x, s.y, 2); return false; }
      for (const b of alive) if (b.alive && Math.abs(s.x - b.x) < 9 && Math.abs(s.y - b.y) < 7) { b.alive = false; snd('arcade.boom', { vol: 0.35, pitch: 1.2 + b.row * 0.1 }); st.score += PTS[b.row]; burst(b.x, b.y, COLORS[b.row]); emit('pop', { x: b.x, y: b.y, s: '+' + PTS[b.row], c: COLORS[b.row] }); st.shake = 1.5; return false; }
      if (st.ufo && Math.abs(s.x - st.ufo.x) < 26 && Math.abs(s.y - 20) < 7) { const p = [100, 150, 300][Math.floor(rand() * 3)]; st.score += p; snd('score'); burst(st.ufo.x, 20, '#ff5050', 18); emit('pop', { x: st.ufo.x, y: 22, s: '+' + p + '!', c: '#ff5050', big: true }); st.ufo = null; st.shake = 4; return false; }
      return true;
    });
    bombs = bombs.filter(s => {
      if (s.y > H) return false;
      if (cellAt(s.x, s.y)) { hitCells(s.x, s.y, 3); return false; }
      if (Math.abs(s.x - st.px) < 10 && Math.abs(s.y - 214) < 6) { snd('arcade.boom', { vol: 0.7, pitch: 0.6 }); if (st.lives <= 1) snd('fail', { delay: 0.4 }); st.lives--; st.dead = 1.4; st.shake = 8; burst(st.px, 214, '#6ee7a0', 24); st.banner = st.lives > 0 ? 'Segfault. Core dumped.' : 'Game over'; st.bannerT = 1.4; emit('banner', st.banner); return false; }
      return true;
    });
    for (const b of alive) { if (b.y > 170) hitCells(b.x, b.y, 6); if (b.y > 206) { if (st.lives > 0) snd('fail'); st.lives = 0; st.dead = 1.4; st.banner = 'Bugs in prod'; st.bannerT = 2; emit('banner', st.banner); } }
    st.ufoT -= dt; if (!st.ufo && st.ufoT <= 0) { st.ufo = { x: -30, v: 60 }; st.ufoT = 14 + rand() * 10; }
    if (st.ufo) { st.ufo.x += st.ufo.v * dt; if (st.ufo.x > W + 30) st.ufo = null; }
  }
  // cached art at 1x: glowing bug sprites (row x frame), the backdrop (nebula, stars, grid floor)
  const sprite = (w, h, f) => { const c = document.createElement('canvas'); c.width = w; c.height = h; f(/** @type {CanvasRenderingContext2D} */ (c.getContext('2d'))); return c; };
  const bugPix = (g, bx, by, row, fr) => {
    g.fillStyle = COLORS[row]; g.fillRect(bx - 4, by - 3, 8, 6); g.fillRect(bx - 2, by - 5, 4, 2); g.fillRect(bx - 3, by - 7, 1, 2); g.fillRect(bx + 2, by - 7, 1, 2);
    const l = fr ? 1 : -1; for (const dy of [-2, 0, 2]) { g.fillRect(bx - 7, by + dy + (dy === 0 ? 0 : l), 3, 1); g.fillRect(bx + 4, by + dy + (dy === 0 ? 0 : -l), 3, 1); }
    g.fillStyle = 'rgba(255,255,255,0.45)'; g.fillRect(bx - 4, by - 3, 8, 1);
    g.fillStyle = '#0a0a12'; g.fillRect(bx - 2, by - 4, 1, 1); g.fillRect(bx + 1, by - 4, 1, 1); g.fillRect(bx, by - 2, 1, 5);
  };
  const BUGS = [0, 1, 2, 3].map(row => [0, 1].map(fr => sprite(24, 24, g => bugPix(g, 12, 12, row, fr))));
  const glow = (g, gx, gy, r, c, a) => { const gr = g.createRadialGradient(gx, gy, 0, gx, gy, r); gr.addColorStop(0, c); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.globalAlpha = a; g.fillStyle = gr; g.fillRect(gx - r, gy - r, r * 2, r * 2); g.globalAlpha = 1; };
  const BACK = sprite(W, H, g => {
    const v = g.createRadialGradient(W / 2, H * 0.4, 10, W / 2, H / 2, W * 0.7); v.addColorStop(0, '#16102a'); v.addColorStop(0.6, '#0a0816'); v.addColorStop(1, '#030308'); g.fillStyle = v; g.fillRect(0, 0, W, H);
    glow(g, 70, 70, 90, '#ff4fd8', 0.10); glow(g, 260, 150, 110, '#3a7aff', 0.10);
    let s = 9; const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < 70; i++) { g.fillStyle = r() < 0.2 ? '#ffe8f4' : r() < 0.5 ? '#6a7ab8' : '#2a3a5a'; g.fillRect(Math.floor(r() * W), Math.floor(r() * H), 1, 1); }
    const fg = g.createLinearGradient(0, 226, 0, H); fg.addColorStop(0, '#2a0a2a'); fg.addColorStop(1, '#08040c'); g.fillStyle = fg; g.fillRect(0, 226, W, H - 226);
    g.fillStyle = '#ff4fd8'; g.fillRect(0, 226, W, 1); g.globalAlpha = 0.35; for (let i = -10; i <= 10; i++) { g.strokeStyle = '#ff4fd8'; g.beginPath(); g.moveTo(W / 2 + i * 8, 227); g.lineTo(W / 2 + i * 40, H); g.stroke(); } g.globalAlpha = 1;
  });
  function bug(bx, by, row, fr) { x.drawImage(BUGS[row][fr], bx - 12, by - 12); }
  function ship(px, py) {
    x.fillStyle = '#0f3a22'; x.fillRect(px - 9, py + 1, 18, 3);
    x.fillStyle = '#3ddc84'; x.fillRect(px - 9, py - 2, 18, 4); x.fillRect(px - 5, py - 5, 10, 3); x.fillRect(px - 1, py - 9, 2, 4);
    x.fillStyle = '#b8ffd8'; x.fillRect(px - 8, py - 2, 16, 1); x.fillRect(px - 1, py - 9, 1, 3);
  }
  /** @param {number} t */
  function draw(t) {
    x.save(); x.drawImage(BACK, 0, 0);
    if (st.shake) x.translate(Math.round((rand() - 0.5) * st.shake), Math.round((rand() - 0.5) * st.shake));
    x.fillStyle = '#4a5a8a'; for (let i = 0; i < 24; i++) x.fillRect((i * 73) % W, (i * 41 + Math.floor(t * 12)) % 226, 1, 2);
    for (const b of bugs) if (b.alive) bug(Math.round(b.x), Math.round(b.y), b.row, st.frame);
    x.fillStyle = '#3ddc84'; for (const k of cells) { const i = k.indexOf(','); x.fillRect(+k.slice(0, i), +k.slice(i + 1), 2, 2); }
    for (const s of shots) { const sx = Math.round(s.x), sy = Math.round(s.y); x.fillStyle = 'rgba(200,255,220,0.35)'; x.fillRect(sx - 1, sy, 2, 8); x.fillStyle = '#e8ffe8'; x.fillRect(sx, sy, 1, 2); x.fillRect(sx, sy + 3, 1, 3); x.fillRect(sx - 1, sy + 5, 1, 1); }
    for (const s of bombs) { const sx = Math.round(s.x), sy = Math.round(s.y); x.fillStyle = (sy % 6) < 3 ? '#ff5050' : '#ffb36b'; x.fillRect(sx - 1, sy - 3, 2, 6); x.fillRect(sx - 2, sy + ((sy % 4) < 2 ? -1 : 1), 4, 1); }
    if (st.mode === 'play' && !(st.dead > 0)) ship(Math.round(st.px), 216);
    for (const p of parts) { x.globalAlpha = 1 - p.t / 0.5; x.fillStyle = p.c; x.fillRect(p.x | 0, p.y | 0, 2, 2); } x.globalAlpha = 1;
    if (st.ufo && st.mode === 'play') { const u = Math.round(st.ufo.x); x.fillStyle = '#5a1020'; x.fillRect(u - 14, 17, 28, 6); x.fillStyle = '#ff5050'; x.fillRect(u - 12, 15, 24, 6); x.fillRect(u - 6, 11, 12, 4); x.fillStyle = '#ffb3b3'; x.fillRect(u - 5, 12, 10, 1); x.fillStyle = Math.sin(t * 4) > 0 ? '#ffe08a' : '#ffb36b'; for (let i = -2; i <= 2; i++) x.fillRect(u + i * 5, 18, 2, 2); }
    x.restore();
    return [];
  }
  return { update, draw, tap: k => { taps.add(k); }, hover: () => {}, get mode() { return st.mode; }, get score() { return st.score; }, get lives() { return st.lives; }, get wave() { return st.wave; }, get hi() { return Math.max(hi, st.score); }, replay: () => newGame(), W, H };
}
