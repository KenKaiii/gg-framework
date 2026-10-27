// @ts-check
// GIT PUSH --FORCE: a small real pinball table (240x400 playfield units). Physics here; the table is SVG built once
// (chrome rails, bumpers, flippers, glass) with only transforms/fills updated per frame, under a backbox score plate.
import { svg as S } from './gx.js';
import { SFX } from '../sfx.js';

const W = 240, PH = 400, TOP = 32, BR = 5, GRAV = 430, HI_KEY = 'nightrooms.pinball.hi';
const WORD = 'DEPLOY';

/** @typedef {{x1:number,y1:number,x2:number,y2:number,e:number,kick?:number,gate?:number,id?:number,flash?:number}} Seg */
function buildTable() {
  /** @type {Seg[]} */ const segs = [];
  const S = (x1, y1, x2, y2, o = {}) => { segs.push({ x1, y1, x2, y2, e: 0.45, ...o }); };
  const n = 20; let px = 10, py = 120;
  for (let i = 1; i <= n; i++) { const a = Math.PI + Math.PI * i / n; const x = 120 + 110 * Math.cos(a), y = 120 + 110 * Math.sin(a); S(px, py, x, y); px = x; py = y; }
  S(10, 120, 10, 300); S(10, 300, 70, 350);
  S(230, 120, 230, 392); S(210, 160, 210, 300); S(210, 300, 150, 350);
  S(210, 392, 230, 392);
  S(210, 160, 230, 141, { gate: 1 });
  // slingshots (kick face first)
  S(34, 262, 60, 320, { kick: 1, id: 0 }); S(34, 262, 34, 304); S(34, 304, 60, 320);
  S(186, 262, 160, 320, { kick: 1, id: 1 }); S(186, 262, 186, 304); S(186, 304, 160, 320);
  // top lane guides
  for (let i = 0; i < 5; i++) { const x = 66 + i * 22; S(x, 58, x, 74, { e: 0.3 }); }
  const bumpers = [{ x: 80, y: 150, r: 13, c: '#ff4fd8', t: 'GIT', f: 0 }, { x: 140, y: 150, r: 13, c: '#3ddc84', t: 'NPM', f: 0 }, { x: 110, y: 196, r: 13, c: '#ffb36b', t: 'CSS', f: 0 }];
  const posts = [{ x: 40, y: 120, r: 4 }, { x: 180, y: 120, r: 4 }, { x: 110, y: 270, r: 3 }];
  return { segs, bumpers, posts };
}

/** Closest point on segment. */
function closest(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l = dx * dx + dy * dy || 1; const u = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l));
  return [x1 + dx * u, y1 + dy * u];
}

/** @param {{root:SVGElement, keys:Set<string>, rand:()=>number, onSub:(s:string)=>void, on?:(ev:string,a?:any)=>void}} o */
export function pinball(o) {
  const { keys, rand } = o; const emit = (ev, a) => o.on?.(ev, a);
  const T = buildTable();
  let hi = 0; try { hi = Number(localStorage.getItem(HI_KEY)) || 0; } catch { /* private mode */ }
  const fl = [
    { px: 72, py: 352, a: 0.5, w: 0, rest: 0.5, up: -0.45, side: 1 },
    { px: 148, py: 352, a: 0.5, w: 0, rest: 0.5, up: -0.45, side: -1 },
  ];
  const FL = 30;
  const ball = { x: 220, y: 386, vx: 0, vy: 0, out: false };
  const st = { score: 0, balls: 3, ballNo: 1, mult: 1, lit: [0, 0, 0, 0, 0, 0], power: 0, save: 0, tilt: 0, tilted: false, state: 'ready', shake: 0, flash: 0,
    msg: 'Pull the plunger', msgT: 3, spin: 0, spinA: 0, laneCd: [0, 0, 0, 0, 0, 0], sling: [0, 0], newHi: false, over: 0 };
  /** @type {{x:number,y:number,vx:number,vy:number,t:number,c:string}[]} */ const parts = [];
  const prev = new Set(); let noSave = false;
  /** @type {Set<string>} */ const taps = new Set();
  const say = (m, t = 2) => { st.msg = m; st.msgT = t; };
  const add = (n, px, py, c = '#ffe2b0') => { if (st.tilted) return; const v = n * st.mult; st.score += v; emit('pop', { x: px, y: py, s: '+' + v, c }); };
  const burst = (px, py, c, n = 8) => { for (let i = 0; i < n; i++) { const a = rand() * 6.28, s = 40 + rand() * 90; parts.push({ x: px, y: py, vx: Math.cos(a) * s, vy: Math.sin(a) * s, t: 0, c }); } };
  const resetBall = () => { ball.x = 220; ball.y = 386; ball.vx = ball.vy = 0; ball.out = false; st.state = 'ready'; st.tilted = false; st.tilt = 0; };
  const newGame = () => { st.score = 0; st.balls = 3; st.ballNo = 1; st.mult = 1; st.lit = [0, 0, 0, 0, 0, 0]; st.newHi = false; resetBall(); say('Ball 1. Ship it.', 2); };

  function flipTip(f) { return [f.px + Math.cos(f.a) * FL * f.side, f.py + Math.sin(f.a) * FL]; }
  function hit(cx, cy, vsx, vsy, e) {
    const dx = ball.x - cx, dy = ball.y - cy, d = Math.hypot(dx, dy); if (d >= BR || d < 1e-6) return null;
    const nx = dx / d, ny = dy / d; ball.x = cx + nx * BR; ball.y = cy + ny * BR;
    const rvx = ball.vx - vsx, rvy = ball.vy - vsy, vn = rvx * nx + rvy * ny;
    if (vn < 0) { ball.vx = vsx + rvx - (1 + e) * vn * nx; ball.vy = vsy + rvy - (1 + e) * vn * ny; }
    return [nx, ny, -vn];
  }
  function step(h) {
    for (const f of fl) {
      const hk = k => keys.has(k) || taps.has(k); const btn = !st.tilted && (f.side > 0 ? hk('ArrowLeft') || hk('KeyZ') : hk('ArrowRight') || hk('KeyM') || hk('Slash'));
      const target = btn ? f.up : f.rest, sp = 22; const old = f.a;
      if (btn !== !!f.btn) { f.btn = btn; if (btn) SFX.play('flipper', { vol: 0.5, pitch: f.side > 0 ? 1 : 1.06 }); }
      f.a = target < f.a ? Math.max(target, f.a - sp * h) : Math.min(target, f.a + sp * h * 0.6); f.w = (f.a - old) / h;
    }
    ball.vy += GRAV * h; ball.x += ball.vx * h; ball.y += ball.vy * h;
    if (ball.y < 100 && ball.x < 205) ball.out = true;
    for (const s of T.segs) {
      if (s.gate && !(ball.out && ball.vy > 0)) continue;
      const [cx, cy] = closest(ball.x, ball.y, s.x1, s.y1, s.x2, s.y2); const r = hit(cx, cy, 0, 0, s.e);
      if (r && s.kick && r[2] > 40 && s.id !== undefined) { ball.vx += r[0] * 260; ball.vy += r[1] * 260; st.sling[s.id] = 1; SFX.play('bumper', { vol: 0.35, pitch: 1.4 }); st.shake = 2; add(50, cx, cy - 8, '#6ee7a0'); burst(cx, cy, '#6ee7a0', 6); }
    }
    for (const p of T.posts) { const dx = ball.x - p.x, dy = ball.y - p.y, d = Math.hypot(dx, dy) || 1; if (d < BR + p.r) hit(p.x + dx / d * p.r, p.y + dy / d * p.r, 0, 0, 0.5); }
    for (const b of T.bumpers) {
      const dx = ball.x - b.x, dy = ball.y - b.y, d = Math.hypot(dx, dy) || 1;
      if (d < BR + b.r) { const nx = dx / d, ny = dy / d; ball.x = b.x + nx * (b.r + BR); ball.y = b.y + ny * (b.r + BR); const vn = ball.vx * nx + ball.vy * ny; const k = Math.max(340, -vn * 0.9); ball.vx += (k - vn) * nx; ball.vy += (k - vn) * ny; b.f = 1; st.shake = 3; SFX.play('bumper', { vol: 0.5, pitch: 0.9 + b.x / 400 }); add(100, b.x, b.y - 18, b.c); burst(b.x + nx * b.r, b.y + ny * b.r, b.c, 10); }
    }
    for (const f of fl) {
      const [tx, ty] = flipTip(f); const [cx, cy] = closest(ball.x, ball.y, f.px, f.py, tx, ty);
      const rx = cx - f.px, ry = cy - f.py, ux = -ry * f.w * f.side, uy = rx * f.w * f.side;
      const dx = ball.x - cx, dy = ball.y - cy, d = Math.hypot(dx, dy);
      if (d < BR + 4 && d > 1e-6) {
        const nx = dx / d, ny = dy / d; ball.x = cx + nx * (BR + 4); ball.y = cy + ny * (BR + 4);
        const rvx = ball.vx - ux, rvy = ball.vy - uy, vn = rvx * nx + rvy * ny;
        if (vn < 0) { ball.vx = ux + rvx - 1.35 * vn * nx; ball.vy = uy + rvy - 1.35 * vn * ny; }
      }
    }
    // spinner on the left orbit
    if (ball.x < 34 && Math.abs(ball.y - 210) < 5 && Math.abs(ball.vy) > 60) { if (st.spin < 1) SFX.play('tick', { vol: 0.4 }); if (st.spin < 1) add(25, 30, 196, '#ffb36b'); st.spin = Math.min(30, st.spin + Math.abs(ball.vy) / 30); }
    // DEPLOY rollovers
    for (let i = 0; i < 6; i++) {
      const lx = 55 + i * 22, ly = 66;
      if (st.laneCd[i] <= 0 && Math.abs(ball.x - lx) < 8 && Math.abs(ball.y - ly) < 8) {
        st.laneCd[i] = 0.6; if (!st.lit[i]) { st.lit[i] = 1; SFX.play('blip', { vol: 0.4, pitch: 1 + i * 0.1 }); add(250, lx, ly + 16, '#ffb36b'); burst(lx, ly, '#ffb36b', 6); }
        if (st.lit.every(Boolean)) { st.mult = Math.min(6, st.mult + 1); st.lit = [0, 0, 0, 0, 0, 0]; st.flash = 1; st.shake = 5; SFX.play('levelup'); say('Deployed! x' + st.mult, 2.5); add(2000, 110, 110, '#ff4fd8'); emit('swell'); }
      }
    }
    const sp = Math.hypot(ball.vx, ball.vy); if (sp > 950) { ball.vx *= 950 / sp; ball.vy *= 950 / sp; }
  }
  function drain() {
    if (st.save > 0 && !st.tilted) { SFX.play('chime', { vol: 0.5 }); say('Ball saved. Rollback ok.', 2); resetBall(); return; }
    SFX.play('fail', { vol: 0.5 }); st.balls--; st.flash = 0.6; st.shake = 6;
    if (st.balls <= 0) { st.state = 'over'; st.over = 0; if (st.score > hi) { hi = st.score; st.newHi = true; if (!noSave) try { localStorage.setItem(HI_KEY, String(hi)); } catch { /* ignore */ } } say(st.newHi ? 'New high score' : 'Game over. Prod is down.', 99); emit('over', { score: st.score, hi, best: st.newHi }); return; }
    st.ballNo++; resetBall(); say('Drained to prod. Ball ' + st.ballNo, 2.2);
  }

  /** @param {number} dt */
  function update(dt) {
    const pressed = k => taps.has(k) || (keys.has(k) && !prev.has(k));
    if (st.state === 'over') { st.over += dt; if (st.over > 1 && pressed('Space')) { SFX.play('go'); newGame(); } }
    else {
      if (pressed('ArrowLeft') || pressed('KeyZ') || pressed('ArrowRight') || pressed('KeyM')) { // lane change
        if (!st.tilted && st.state === 'play') { const r = pressed('ArrowRight') || pressed('KeyM'); st.lit = r ? [st.lit[5], ...st.lit.slice(0, 5)] : [...st.lit.slice(1), st.lit[0]]; }
      }
      const inLane = ball.x > 211 && ball.y > 360;
      if ((keys.has('Space') || taps.has('Space')) && inLane) st.power = Math.min(1, st.power + dt * 1.4);
      else if (st.power > 0) { if (inLane) { SFX.play('whoosh', { vol: 0.3 + st.power * 0.5 }); ball.vy = -(380 + 720 * st.power); if (st.state === 'ready') { st.state = 'play'; st.save = 8; } } st.power = 0; }
      if (pressed('ArrowUp') && st.state === 'play' && !st.tilted) {
        ball.vx += (rand() - 0.5) * 140; ball.vy -= 90 + rand() * 40; st.tilt += 1.3; st.shake = 7;
        SFX.play('thud', { vol: 0.5 }); if (st.tilt > 4) { SFX.play('ui.deny'); st.tilted = true; say('Tilt. Hands off the prod box.', 3); st.flash = 0.8; } else if (st.tilt > 2.2) say('Danger. Easy there.', 1.2);
      }
      st.tilt = Math.max(0, st.tilt - dt * 0.6); st.save = Math.max(0, st.save - dt);
      const n = 8; for (let i = 0; i < n; i++) step(dt / n);
      if (ball.y > PH + 12) drain();
    }
    for (const k of [...prev]) if (!keys.has(k)) prev.delete(k); for (const k of keys) prev.add(k); taps.clear();
    for (const b of T.bumpers) b.f = Math.max(0, b.f - dt * 5);
    st.sling = st.sling.map(v => Math.max(0, v - dt * 6)); st.laneCd = st.laneCd.map(v => v - dt);
    st.shake = Math.max(0, st.shake - dt * 25); st.flash = Math.max(0, st.flash - dt * 1.5); st.msgT -= dt;
    if (st.spin > 0) { st.spinA += st.spin * dt * 6; const before = Math.floor(st.spin); st.spin = Math.max(0, st.spin - dt * 8); if (Math.floor(st.spin) < before && !st.tilted) st.score += 10 * st.mult; }
    for (const p of parts) { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 200 * dt; } while (parts.length && parts[0].t > 0.6) parts.shift();
  }

  // ---- the table, SVG built once ----
  const root = o.root;
  root.innerHTML = `<defs>
    <linearGradient id="pb-field" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2c2448"/><stop offset=".6" stop-color="#1e2244"/><stop offset="1" stop-color="#140f24"/></linearGradient>
    <radialGradient id="pb-gp" cx=".46" cy=".42" r=".5"><stop offset="0" stop-color="#ff5fd2" stop-opacity=".22"/><stop offset="1" stop-color="#ff5fd2" stop-opacity="0"/></radialGradient>
    <radialGradient id="pb-gb" cx=".46" cy=".82" r=".4"><stop offset="0" stop-color="#5b7bff" stop-opacity=".2"/><stop offset="1" stop-color="#5b7bff" stop-opacity="0"/></radialGradient>
    <radialGradient id="pb-lamp" cx=".5" cy=".1" r=".75"><stop offset="0" stop-color="#ffd29a" stop-opacity=".16"/><stop offset=".6" stop-color="#ffd29a" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></radialGradient>
    <linearGradient id="pb-chrome" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4f6fb"/><stop offset=".45" stop-color="#8b90a2"/><stop offset=".55" stop-color="#d9dce6"/><stop offset="1" stop-color="#5a5f70"/></linearGradient>
    <linearGradient id="pb-cab" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#9b7bff" stop-opacity=".6"/><stop offset=".05" stop-color="#241634"/><stop offset=".95" stop-color="#241634"/><stop offset="1" stop-color="#ff5fd2" stop-opacity=".6"/></linearGradient>
    <linearGradient id="pb-flip" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff2c9"/><stop offset=".45" stop-color="#f5bd63"/><stop offset="1" stop-color="#b9772a"/></linearGradient>
    <radialGradient id="pb-ball" cx=".35" cy=".3" r=".75"><stop offset="0" stop-color="#fff"/><stop offset=".4" stop-color="#cdd1de"/><stop offset=".8" stop-color="#5a5f72"/><stop offset="1" stop-color="#2a2d38"/></radialGradient>
    <linearGradient id="pb-glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".09"/><stop offset=".35" stop-color="#fff" stop-opacity="0"/><stop offset=".62" stop-color="#fff" stop-opacity="0"/><stop offset=".68" stop-color="#fff" stop-opacity=".05"/><stop offset=".74" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="pb-box" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a2552"/><stop offset="1" stop-color="#160c24"/></linearGradient>
    <filter id="pb-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6"/></filter>
    <filter id="pb-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="4"/></filter><radialGradient id="pb-halo"><stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="0.45" stop-color="#fff" stop-opacity="0.35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient><radialGradient id="pb-shadow"><stop offset="0" stop-color="#000" stop-opacity="0.6"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient><mask id="pb-halo-m"><rect x="-50" y="-50" width="100" height="100" fill="url(#pb-halo)"/></mask>
    <clipPath id="pb-clip"><rect x="0" y="0" width="${W}" height="${PH}" rx="4"/></clipPath></defs>`;
  // cabinet + backbox plate
  S('rect', { x: -14, y: -76, width: W + 28, height: PH + 90, rx: 12, fill: 'url(#pb-cab)' }, root);
  S('rect', { x: -8, y: -70, width: W + 16, height: 62, rx: 8, fill: 'url(#pb-box)', stroke: '#ffd29a', 'stroke-opacity': 0.25 }, root);
  S('rect', { x: -2, y: -64, width: W + 4, height: 50, rx: 5, fill: '#0a0610', stroke: '#000', 'stroke-opacity': 0.6 }, root);
  const T0 = { 'font-family': 'Sora, sans-serif' };
  S('text', { ...T0, x: 6, y: -50, 'font-size': 7, 'font-weight': 700, 'letter-spacing': 1.4, fill: '#ff9fe6', 'fill-opacity': 0.75 }, root).textContent = 'GIT PUSH --FORCE';
  const tScore = S('text', { ...T0, x: 6, y: -24, 'font-size': 22, 'font-weight': 800, fill: '#ffb36b', 'letter-spacing': -0.5, style: 'text-shadow:0 0 6px rgba(255,138,48,.6)' }, root);
  const tBall = S('text', { ...T0, x: W - 6, y: -48, 'font-size': 8, 'font-weight': 600, fill: '#ffcf8a', 'text-anchor': 'end' }, root);
  const tMult = S('text', { ...T0, x: W - 6, y: -36, 'font-size': 8, 'font-weight': 600, fill: '#b07a3a', 'text-anchor': 'end' }, root);
  const tMsg = S('text', { ...T0, x: W - 6, y: -22, 'font-size': 7.5, 'font-weight': 500, fill: '#e8ebef', 'fill-opacity': 0.85, 'text-anchor': 'end' }, root);
  const field = S('g', { 'clip-path': 'url(#pb-clip)' }, root);
  const shakeG = S('g', {}, field);
  S('rect', { x: 0, y: 0, width: W, height: PH, fill: 'url(#pb-field)' }, shakeG);
  S('rect', { x: 0, y: 0, width: W, height: PH, fill: 'url(#pb-gp)' }, shakeG); S('rect', { x: 0, y: 0, width: W, height: PH, fill: 'url(#pb-gb)' }, shakeG);
  const grid = S('path', { d: '', stroke: '#7fdc95', 'stroke-opacity': 0.06, 'stroke-width': 0.5 }, shakeG);
  let gd = ''; for (let i = 10; i < W; i += 10) gd += `M${i} 0V${PH}`; for (let i = 10; i < PH; i += 10) gd += `M0 ${i}H${W}`; grid.setAttribute('d', gd);
  const art = S('g', { ...T0, 'text-anchor': 'middle', 'font-weight': 700 }, shakeG);
  for (let i = 0; i < 4; i++) S('path', { d: `M110 ${284 - i * 12}l-6 10h12z`, fill: ['#3a2a5a', '#4a2a6a', '#5a2a7a', '#6a2a8a'][i] }, art);
  const lbl = (t, x0, y0, sz, c, o2 = {}) => { S('text', { x: x0, y: y0, 'font-size': sz, fill: c, ...o2 }, art).textContent = t; };
  lbl('MERGE CONFLICT', 110, 234, 9, '#ff5fd2', { 'letter-spacing': 1 }); lbl('// TODO: fix', 110, 118, 7, '#6a7a9a', { 'font-weight': 500 });
  lbl('SPIN', 22, 190, 6, '#a07a4a'); lbl('PROD', 110, 394, 14, '#8a1a2a', { 'font-weight': 800, 'letter-spacing': 2 }); lbl('SHIP', 220, 344, 6, '#4a7a5a');
  lbl('works on my machine', 110, 330, 6.5, '#4a4a6a', { 'font-weight': 500 });
  // chrome rails
  const railD = T.segs.filter(sg => !sg.gate && !sg.kick).map(sg => `M${sg.x1} ${sg.y1}L${sg.x2} ${sg.y2}`).join('');
  S('path', { d: railD, stroke: '#000', 'stroke-width': 5, 'stroke-linecap': 'round', transform: 'translate(0.8 2)', 'stroke-opacity': 0.3 }, shakeG);
  S('path', { d: railD, stroke: 'url(#pb-chrome)', 'stroke-width': 3.4, 'stroke-linecap': 'round' }, shakeG);
  S('path', { d: railD, stroke: '#fff', 'stroke-opacity': 0.8, 'stroke-width': 0.8, 'stroke-linecap': 'round', transform: 'translate(0 -0.7)' }, shakeG);
  S('path', { d: 'M210 160L230 141', stroke: '#c9ccd8', 'stroke-width': 1 }, shakeG);
  for (const pp of T.posts) { S('circle', { cx: pp.x + 0.8, cy: pp.y + 1.6, r: pp.r + 1.6, fill: 'url(#pb-shadow)' }, shakeG); S('circle', { cx: pp.x, cy: pp.y, r: pp.r + 1, fill: '#ff8ad8', stroke: '#6a1a5a', 'stroke-width': 0.8 }, shakeG); S('circle', { cx: pp.x - 1, cy: pp.y - 1, r: 1, fill: '#fff' }, shakeG); }
  // slingshots: white rubber over a plastic triangle
  const slings = T.segs.filter(sg => sg.kick).map(sg => {
    const tri = sg.id === 0 ? 'M34 262L60 320L34 304Z' : 'M186 262L160 320L186 304Z';
    S('path', { d: tri, fill: '#0f2a1c', stroke: '#2a6a4a', 'stroke-width': 1 }, shakeG);
    const glowL = S('path', { d: `M${sg.x1} ${sg.y1}L${sg.x2} ${sg.y2}`, stroke: '#7fdc95', 'stroke-width': 8, 'stroke-linecap': 'round', opacity: 0, 'stroke-opacity': 0.55 }, shakeG);
    S('path', { d: `M${sg.x1} ${sg.y1}L${sg.x2} ${sg.y2}`, stroke: '#e8fff0', 'stroke-width': 3, 'stroke-linecap': 'round' }, shakeG);
    return glowL;
  });
  // DEPLOY lamps
  const lamps = [...WORD].map((ch, i) => { const g = S('g', { transform: `translate(${55 + i * 22} 66)` }, shakeG);
    const halo = S('circle', { r: 14, fill: '#ffb36b', opacity: 0, mask: 'url(#pb-halo-m)', transform: 'scale(0.28)' }, g); /* gradient glow, no live blur */
    const c = S('circle', { r: 8, fill: '#2a1a10', stroke: '#5a4a3a', 'stroke-width': 1 }, g);
    const t = S('text', { ...T0, y: 3.2, 'font-size': 9, 'font-weight': 800, 'text-anchor': 'middle', fill: '#8a6a4a' }, g); t.textContent = ch; return { halo, c, t, on: -1 }; });
  // spinner
  const spin = S('rect', { x: 12, y: 209, width: 22, height: 2, fill: '#e8ecf8' }, shakeG);
  // bumpers
  const bumps = T.bumpers.map(bp => { const g = S('g', { transform: `translate(${bp.x} ${bp.y})` }, shakeG);
    const halo = S('circle', { r: bp.r * 2.2, fill: bp.c, opacity: 0.3, mask: 'url(#pb-halo-m)', transform: `scale(${(bp.r * 2.2 / 50).toFixed(3)})` }, g); /* gradient glow, no live blur */
    S('circle', { cx: 1, cy: 3, r: bp.r + 4, fill: 'url(#pb-shadow)' }, g);
    const inner = S('g', {}, g);
    S('circle', { r: bp.r + 3, fill: 'url(#pb-chrome)' }, inner);
    const cap = S('circle', { r: bp.r, fill: bp.c, stroke: '#000', 'stroke-opacity': 0.35 }, inner);
    S('circle', { r: bp.r - 5, fill: '#1a1424' }, inner);
    S('path', { d: `M${-(bp.r - 2)} -3A${bp.r - 2} ${bp.r - 2} 0 0 1 3 ${-(bp.r - 2)}`, stroke: '#fff', 'stroke-opacity': 0.7, 'stroke-width': 1.2, 'stroke-linecap': 'round' }, inner);
    const t = S('text', { ...T0, y: 2.6, 'font-size': 6.5, 'font-weight': 800, 'text-anchor': 'middle', fill: bp.c }, inner); t.textContent = bp.t;
    return { halo, inner, cap, t }; });
  const saveT = S('text', { ...T0, x: 110, y: 314, 'font-size': 8, 'font-weight': 700, 'text-anchor': 'middle', fill: '#7fdc95', opacity: 0 }, shakeG); saveT.textContent = 'BALL SAVE';
  // flippers (drawn pointing along +x from the pivot, rotated per frame)
  const flips = fl.map(f => { const g = S('g', {}, shakeG);
    S('path', { d: `M0 -5L${FL} -2.4A2.4 2.4 0 0 1 ${FL} 2.4L0 5A5 5 0 0 1 0 -5Z`, fill: '#000', opacity: 0.3, transform: 'translate(1 3)' }, g);
    const body = S('path', { d: `M0 -5L${FL} -2.4A2.4 2.4 0 0 1 ${FL} 2.4L0 5A5 5 0 0 1 0 -5Z`, fill: 'url(#pb-flip)', stroke: '#5a2a0a', 'stroke-width': 1.2 }, g);
    S('circle', { r: 2.6, fill: 'url(#pb-chrome)' }, g); return { g, body }; });
  // plunger + power gauge
  const plunger = S('g', {}, shakeG);
  S('rect', { x: 216, y: -2, width: 8, height: 4, rx: 1, fill: 'url(#pb-chrome)' }, plunger);
  S('path', { d: Array.from({ length: 8 }, (_, i) => `M217 ${4 + i * 3}h6`).join(''), stroke: '#8a8ea0', 'stroke-width': 1 }, plunger);
  const gaugeBg = S('rect', { x: 231, y: 331, width: 6, height: 62, rx: 2, fill: '#1a0a1a', opacity: 0 }, shakeG);
  const gauge = S('rect', { x: 232, y: 392, width: 4, height: 0, rx: 1.5, fill: '#7fdc95' }, shakeG);
  const tiltBar = S('rect', { x: 4, y: 380, width: 3, height: 0, fill: '#e0a458' }, shakeG);
  // ball
  const ballG = S('g', {}, shakeG);
  S('ellipse', { cx: 2, cy: 3, rx: BR * 1.4, ry: BR, fill: 'url(#pb-shadow)', opacity: 0.7 }, ballG);
  S('circle', { r: BR, fill: 'url(#pb-ball)' }, ballG); S('circle', { cx: -1.6, cy: -1.8, r: 1.2, fill: '#fff', opacity: 0.9 }, ballG);
  // lamp, flash, glass
  S('rect', { x: 0, y: 0, width: W, height: PH, fill: 'url(#pb-lamp)', 'pointer-events': 'none' }, field);
  const flash = S('rect', { x: 0, y: 0, width: W, height: PH, fill: '#ff5fd2', opacity: 0, 'pointer-events': 'none' }, field);
  S('rect', { x: 0, y: 0, width: W, height: PH, fill: 'url(#pb-glass)', 'pointer-events': 'none' }, field);
  S('rect', { x: 0, y: 0, width: W, height: PH, rx: 4, fill: 'none', stroke: 'url(#pb-chrome)', 'stroke-width': 2 }, root);

  let shown = -1, lastMsg = '', lastHud = '';
  /** @param {number} t */
  function draw(t) {
    if (st.score !== shown) { shown = st.score; tScore.textContent = st.score.toLocaleString('en-US'); }
    const hud = Math.min(3, st.ballNo) + '|' + st.mult + '|' + hi;
    if (hud !== lastHud) { lastHud = hud; tBall.textContent = `Ball ${Math.min(3, st.ballNo)} / 3`; tMult.textContent = `x${st.mult}   Hi ${hi.toLocaleString('en-US')}`; tMult.setAttribute('fill', st.mult > 1 ? '#ff5fd2' : '#b07a3a'); }
    const m = st.msgT > 0 ? st.msg : st.state === 'ready' ? 'Hold space / click to launch' : '';
    if (m !== lastMsg) { lastMsg = m; tMsg.textContent = m; tMsg.setAttribute('fill', st.tilted ? '#ff7d70' : '#e8ebef'); }
    const sh = st.shake; shakeG.setAttribute('transform', sh ? `translate(${((rand() - 0.5) * sh).toFixed(2)} ${((rand() - 0.5) * sh).toFixed(2)})` : '');
    slings.forEach((g, i) => g.setAttribute('opacity', String(st.sling[i] * 0.9)));
    lamps.forEach((L, i) => { const on = st.lit[i]; if (on === L.on) return; L.on = on; L.c.setAttribute('fill', on ? '#ffb36b' : '#2a1a10'); L.c.setAttribute('stroke', on ? '#ffe8a0' : '#5a4a3a'); L.t.setAttribute('fill', on ? '#3a1a08' : '#8a6a4a'); L.halo.setAttribute('opacity', on ? '0.6' : '0'); });
    spin.setAttribute('y', String(210 - Math.abs(Math.cos(st.spinA)) * 2 - 1)); spin.setAttribute('height', String(Math.abs(Math.cos(st.spinA)) * 4 + 1));
    T.bumpers.forEach((bp, i) => { const B = bumps[i]; B.halo.setAttribute('opacity', String(0.18 + bp.f * 0.6)); B.inner.setAttribute('transform', `scale(${1 + bp.f * 0.18})`); B.cap.setAttribute('fill', bp.f > 0.3 ? '#fff' : bp.c); B.t.setAttribute('fill', bp.f > 0.3 ? bp.c : bp.c); });
    saveT.setAttribute('opacity', st.save > 0 ? String(st.save > 2 ? 0.9 : 0.5) : '0');
    fl.forEach((f, i) => { const deg = (f.side > 0 ? f.a : Math.PI - f.a) * 180 / Math.PI; flips[i].g.setAttribute('transform', `translate(${f.px} ${f.py}) rotate(${deg.toFixed(2)})`); flips[i].body.setAttribute('fill', st.tilted ? '#6a5a4a' : 'url(#pb-flip)'); });
    plunger.setAttribute('transform', `translate(0 ${394 + st.power * 18})`);
    gaugeBg.setAttribute('opacity', st.power > 0 ? '1' : '0'); gauge.setAttribute('y', String(392 - st.power * 60)); gauge.setAttribute('height', String(st.power * 60)); gauge.setAttribute('fill', st.power > 0.85 ? '#ff5fd2' : st.power > 0.5 ? '#ffb36b' : '#7fdc95');
    tiltBar.setAttribute('height', String(st.tilt > 0.1 ? Math.min(4, st.tilt) * 10 : 0)); tiltBar.setAttribute('y', String(380 - (st.tilt > 0.1 ? Math.min(4, st.tilt) * 10 : 0))); tiltBar.setAttribute('fill', st.tilt > 2.2 ? '#ff5050' : '#e0a458');
    ballG.setAttribute('transform', `translate(${ball.x.toFixed(2)} ${ball.y.toFixed(2)})`);
    flash.setAttribute('opacity', String(st.flash * 0.22));
    void t; return [];
  }
  return { update, draw, tap: k => { taps.add(k); }, hover: () => {}, endNow: () => { noSave = true; st.save = 0; st.balls = 1; st.score = Math.max(st.score, 4200); drain(); }, get over() { return st.state === 'over'; }, get score() { return st.score; }, get hi() { return hi; }, replay: () => { SFX.play('go'); newGame(); }, W, H: PH };
}
