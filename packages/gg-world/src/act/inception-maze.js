// @ts-check
// Dream architect: "a maze that takes one minute to solve". A date-seeded circular maze that slowly rotates (the
// dream folds); reach the centre against the clock. Best time saved per day and overall; under a minute pays coins.
import { SFX } from '../sfx.js';
import { loop, coins, rng } from './util.js';
import { hook, loadNum, saveNum, today, pops } from './inception-util.js';
import { PAL, panel, badge, title, glow, particles, shaker } from './art.js';
import { cardFlow, cached } from './fightclub-ui.js';

// soft stone slide when a ring step lands
SFX.define('limbo.slide', (o, t, p, K) => K.hiss(o, t, { ft: 'bandpass', f: 500 * p, f1: 350 * p, q: 2, v: 0.07, a: 0.005, d: 0.08 }));
const RINGS = 8, secs = r => (r < 2 ? 8 : r < 5 ? 16 : 32);

/** Build the maze: open[r][s] = { cw: bool, in: bool } passages. @param {number} seed */
export function makeMaze(seed) {
  const g = rng(seed), open = [], seen = [];
  for (let r = 0; r < RINGS; r++) { open.push(Array.from({ length: secs(r) }, () => ({ cw: false, in: false }))); seen.push(Array(secs(r)).fill(false)); }
  const nb = (r, s) => { const n = secs(r), out = [[r, (s + 1) % n, 'cw'], [r, (s + n - 1) % n, 'ccw']];
    if (r > 0) out.push([r - 1, Math.floor(s * secs(r - 1) / n), 'in']);
    if (r < RINGS - 1) { const k = secs(r + 1) / n; for (let i = 0; i < k; i++) out.push([r + 1, s * k + i, 'out']); } return out; };
  const stack = [[RINGS - 1, Math.floor(g() * secs(RINGS - 1))]]; seen[stack[0][0]][stack[0][1]] = true;
  while (stack.length) { const [r, s] = stack[stack.length - 1]; const c = nb(r, s).filter(([a, b]) => !seen[a][b]);
    if (!c.length) { stack.pop(); continue; } const [a, b, d] = c[Math.floor(g() * c.length)]; seen[a][b] = true;
    if (d === 'cw') open[r][s].cw = true; else if (d === 'ccw') open[a][b].cw = true; else if (d === 'in') open[r][s].in = true; else open[a][b].in = true;
    stack.push([a, b]); }
  // outward moves take the first open child; if a cell opens to both children, join the siblings so both stay reachable
  for (let r = 0; r < RINGS - 1; r++) { const k = secs(r + 1) / secs(r); if (k < 2) continue;
    for (let s = 0; s < secs(r); s++) if (open[r + 1][s * 2].in && open[r + 1][s * 2 + 1].in) open[r + 1][s * 2].cw = true; }
  return { open, start: [RINGS - 1, Math.floor(g() * 32)] };
}

/** @param {any} ctx */
export function startMaze(ctx) {
  const ov = ctx.overlay({ title: 'Dream Architect', sub: 'design a maze that takes one minute to solve', help: '<kbd>&larr;&rarr;</kbd> around <kbd>&uarr;</kbd> inward <kbd>&darr;</kbd> outward <kbd>enter</kbd> start / play again <kbd>click</kbd> step toward the pointer <kbd>esc</kbd> leave' });
  const W = 480, H = 270, { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const day = today(), M = makeMaze(day.seed), P = pops();
  const st = { r: M.start[0], s: M.start[1], t: 0, run: 0, done: false, paid: loadNum('maze-paid-' + day.key), trail: [] };
  let bestDay = loadNum('maze-day-' + day.key, 0), bestAll = loadNum('maze-best', 0);
  const CX = 300, CY = 138, R0 = 14, RW = 14;
  const move = d => { if (st.done) return; const { r, s } = st, n = secs(r), o = M.open;
    if (d === 'cw' && o[r][s].cw) st.s = (s + 1) % n;
    else if (d === 'ccw' && o[r][(s + n - 1) % n].cw) st.s = (s + n - 1) % n;
    else if (d === 'in') { if (r === 0) { win(); return; } if (o[r][s].in) { st.r = r - 1; st.s = Math.floor(s * secs(r - 1) / n); } else return bump(); }
    else if (d === 'out' && r < RINGS - 1) { const k = secs(r + 1) / n; let ok = false; for (let i = 0; i < k; i++) if (o[r + 1][s * k + i].in) { st.r = r + 1; st.s = s * k + i; ok = true; break; } if (!ok) return bump(); }
    else if (d === 'cw' || d === 'ccw' || d === 'out') return bump();
    SFX.play('limbo.slide', { pitch: d === 'in' ? 1.25 : d === 'out' ? 0.85 : 1, jitter: 0.08 }); st.trail.push([st.r, st.s]); if (st.trail.length > 40) st.trail.shift(); };
  let shake = 0; const bump = () => { shake = 0.3; sh.kick(3); SFX.play('thud', { vol: 0.5 }); };
  // ring 0 opens into the centre at one sector only
  const core = M.start[1] % 8;
  const win = () => { if (st.s !== core) return bump(); st.done = true; const tm = st.run; SFX.play('magic'); SFX.play(tm < 60 ? 'win' : 'success', { delay: 0.3 });
    if (!bestDay || tm < bestDay) { bestDay = tm; saveNum('maze-day-' + day.key, tm); } if (!bestAll || tm < bestAll) { bestAll = tm; saveNum('maze-best', tm); }
    P.add(tm.toFixed(1) + 's', CX, CY + 52, '#ffd98a');
    let got = 0; if (tm < 60 && !st.paid) { coins(ctx.S).spend(-15); st.paid = 1; got = 15; saveNum('maze-paid-' + day.key, 1); P.add('+15 coins', CX, CY + 70, '#6ee7a0'); }
    fx.burst(CX, CY, { n: 40, colors: [PAL.goldHi, PAL.cyan, '#fff'] });
    setTimeout(() => F.finish({ title: tm < 60 ? 'ELEGANT' : 'TOO SLOW', sub: tm < 60 ? 'dream bigger' : 'a minute, Ariadne. again?', color: tm < 60 ? PAL.gold : PAL.red, win: tm < 60,
      stats: [['time', tm, PAL.gold, 's'], ['today', bestDay, PAL.cream, 's'], ['best', bestAll, PAL.cyan, 's'], ['coins', got, PAL.green, 'c']] }), 700); };
  const kd = e => { const m = { ArrowLeft: 'ccw', ArrowRight: 'cw', ArrowUp: 'in', ArrowDown: 'out', KeyA: 'ccw', KeyD: 'cw', KeyW: 'in', KeyS: 'out' }[e.code];
    if (F.phase !== 'play') return; if (m) { e.preventDefault(); move(m); } };
  const again = () => { st.r = M.start[0]; st.s = M.start[1]; st.run = 0; st.done = false; st.trail = []; SFX.play('page'); };
  const fx = particles(), sh = shaker();
  const F = cardFlow(ov, c, W, H, { style: 'neon', accent: PAL.cyan, again });
  F.setCard({ title: 'DREAM ARCHITECT', sub: 'a maze that takes one minute to solve', lines: ['Reach the glowing centre. Under 60s pays 15 coins.'], chips: [['[←]', '[→]', 'around', '|', '[↑]', 'in', '|', '[↓]', 'out'], ['[click]', 'step toward the pointer']] });
  addEventListener('keydown', kd); ov.onClose(() => { removeEventListener('keydown', kd); hook({ maze: null }); });
  // test hook (tools/review-inception.mjs): BFS from the current cell to the centre, as arrow-key codes
  hook({ maze: { get done() { return st.done; }, get time() { return st.run; }, solve() {
    const key = (r, s) => r + ':' + s, prev = new Map([[key(st.r, st.s), null]]), q = [[st.r, st.s]], o = M.open; let end = null;
    while (q.length) { const [r, s] = q.shift(); if (r === 0 && s === core) { end = [r, s]; break; } const n = secs(r), nx = [];
      if (o[r][s].cw) nx.push([r, (s + 1) % n, 'ArrowRight']); if (o[r][(s + n - 1) % n].cw) nx.push([r, (s + n - 1) % n, 'ArrowLeft']);
      if (r > 0 && o[r][s].in) nx.push([r - 1, Math.floor(s * secs(r - 1) / n), 'ArrowUp']);
      if (r < RINGS - 1) { const k = secs(r + 1) / n; for (let i = 0; i < k; i++) if (o[r + 1][s * k + i].in) { nx.push([r + 1, s * k + i, 'ArrowDown']); break; } }
      for (const [a, b, c] of nx) if (!prev.has(key(a, b))) { prev.set(key(a, b), [r, s, c]); q.push([a, b]); } }
    const out = ['ArrowUp']; let cur = end; while (cur) { const p = prev.get(key(cur[0], cur[1])); if (!p) break; out.unshift(p[2]); cur = p; } return out; } } });
  // mouse: click steps one cell toward the pointer (inner ring = in, outer = out, same ring = around); click again when done
  let rotNow = 0;
  const md = e => { if (e.button !== 0 || F.phase !== 'play' || st.done) return; e.preventDefault();
    const b = c.getBoundingClientRect(), px = (e.clientX - b.left) / b.width * W - CX, py = (e.clientY - b.top) / b.height * H - CY;
    const ring = Math.floor((Math.hypot(px, py) - R0) / RW);
    if (ring < st.r) { move('in'); return; } if (ring > st.r) { move('out'); return; }
    const n = secs(st.r), a = ((Math.atan2(py, px) - rotNow) / (Math.PI * 2) * n % n + n) % n, d = ((a - (st.s + 0.5)) % n + n * 1.5) % n - n / 2;
    if (Math.abs(d) >= 0.5) move(d > 0 ? 'cw' : 'ccw'); };
  c.addEventListener('pointerdown', md); c.style.cursor = 'pointer'; ov.onClose(() => c.removeEventListener('pointerdown', md));
  // dream-blueprint backdrop: deep blue, a faint grid, Penrose-ish rings, vignette (static, cached)
  const back = cached(W, H, b => { const g = b.createRadialGradient(CX, CY, 10, CX, CY, 320); g.addColorStop(0, '#2c4a86'); g.addColorStop(0.6, '#182850'); g.addColorStop(1, '#0a1024'); b.fillStyle = g; b.fillRect(0, 0, W, H);
    b.strokeStyle = 'rgba(180,200,255,0.07)'; b.lineWidth = 1; for (let i = 0.5; i < W; i += 12) { b.beginPath(); b.moveTo(i, 0); b.lineTo(i, H); b.stroke(); } for (let i = 0.5; i < H; i += 12) { b.beginPath(); b.moveTo(0, i); b.lineTo(W, i); b.stroke(); }
    b.strokeStyle = 'rgba(180,200,255,0.12)'; for (let k = 1; k < 4; k++) { b.beginPath(); b.arc(CX, CY, R0 + RINGS * RW + k * 14, 0, 7); b.stroke(); }
    const v = b.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, W * 0.7); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.5)'); b.fillStyle = v; b.fillRect(0, 0, W, H); });
  const ang = (s, r) => (s / secs(r)) * Math.PI * 2;
  loop(ov, dt => {
    st.t += dt; if (!st.done && F.phase === 'play') st.run += dt; shake = Math.max(0, shake - dt);
    const rot = rotNow = st.t * 0.06; // the dream slowly folds
    back(x, 0, 0); x.save(); sh.apply(x, dt);
    glow(x, CX, CY, 40, '#ffd98a', 0.35 + Math.sin(st.t * 2) * 0.1);
    x.translate(CX, CY);
    x.fillStyle = 'rgba(255,217,138,0.5)'; x.beginPath(); x.arc(0, 0, R0 - 3, 0, 7); x.fill();
    x.strokeStyle = '#dbe6ff'; x.lineWidth = 2; x.lineCap = 'round'; x.shadowColor = '#8fb8ff'; x.shadowBlur = 6;
    for (let r = 0; r < RINGS; r++) { const n = secs(r), ri = R0 + r * RW, ro = ri + RW;
      for (let s = 0; s < n; s++) { const a0 = ang(s, r) + rot, a1 = ang(s + 1, r) + rot, o = M.open[r][s];
        const inOpen = r === 0 ? s === core : o.in; if (!inOpen) { x.beginPath(); x.arc(0, 0, ri, a0, a1); x.stroke(); }
        if (!o.cw) { x.beginPath(); x.moveTo(Math.cos(a1) * ri, Math.sin(a1) * ri); x.lineTo(Math.cos(a1) * ro, Math.sin(a1) * ro); x.stroke(); }
        if (r === RINGS - 1 && s !== M.start[1]) { x.beginPath(); x.arc(0, 0, ro, a0, a1); x.stroke(); } } }
    x.shadowBlur = 0;
    const pos = (r, s) => { const a = ang(s + 0.5, r) + rot, rr = R0 + (r + 0.5) * RW; return [Math.cos(a) * rr, Math.sin(a) * rr]; };
    st.trail.forEach(([r, s], i) => { const [px, py] = pos(r, s); x.fillStyle = `rgba(110,231,160,${i / st.trail.length * 0.5})`; x.fillRect(px - 2, py - 2, 4, 4); });
    const [px, py] = pos(st.r, st.s); glow(x, px, py, 16, '#6ee7a0', 0.5); x.fillStyle = PAL.ink; x.beginPath(); x.arc(px, py, 5.5 + Math.sin(st.t * 3) * 0.5, 0, 7); x.fill(); x.fillStyle = '#6ee7a0'; x.beginPath(); x.arc(px, py, 4 + Math.sin(st.t * 3) * 0.5, 0, 7); x.fill(); x.fillStyle = '#fff'; x.fillRect(Math.round(px - 2), Math.round(py - 2), 2, 2);
    x.restore();
    panel(x, 8, 10, 150, 72, { style: 'neon' }); title(x, 'TIME', 18, 30, { size: 16, body: true, align: 'left', color: PAL.dim });
    title(x, st.run.toFixed(1) + 's', 18, 62, { size: 32, align: 'left', color: st.run < 60 ? PAL.gold : PAL.red, glow: st.run < 60 ? undefined : PAL.red });
    title(x, 'par 60s', 148, 30, { size: 16, body: true, align: 'right', color: PAL.cyan });
    x.fillStyle = '#0a0716'; x.fillRect(18, 68, 130, 5); x.fillStyle = st.run < 60 ? PAL.cyan : PAL.red; x.fillRect(18, 68, 130 * Math.min(1, st.run / 60), 5);
    badge(x, 8, 88, 'today', bestDay ? bestDay.toFixed(1) : '--', { w: 72, color: PAL.cream }); badge(x, 86, 88, 'best', bestAll ? bestAll.toFixed(1) : '--', { w: 72, color: PAL.cyan });
    panel(x, 8, 130, 150, 56, { style: 'glass' }); title(x, 'Maze #' + day.key, 18, 150, { size: 16, body: true, align: 'left', color: PAL.purple });
    title(x, st.paid ? 'paid today' : '<60s = 15 coins', 18, 172, { size: 16, body: true, align: 'left', color: st.paid ? PAL.green : PAL.gold });
    fx.draw(x, dt);
    P.draw(x, dt); F.draw(x, dt);
  });
}
