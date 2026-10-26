// @ts-check
// GIT PUSH --FORCE: a small real pinball table (240x400 playfield + 32px score display), drawn on a 2D canvas.
import { text } from './util.js';
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

/** @param {{x:CanvasRenderingContext2D, keys:Set<string>, rand:()=>number, onSub:(s:string)=>void}} o */
export function pinball(o) {
  const { x, keys, rand } = o;
  const T = buildTable();
  let hi = 0; try { hi = Number(localStorage.getItem(HI_KEY)) || 0; } catch { /* private mode */ }
  const fl = [
    { px: 72, py: 352, a: 0.5, w: 0, rest: 0.5, up: -0.45, side: 1 },
    { px: 148, py: 352, a: 0.5, w: 0, rest: 0.5, up: -0.45, side: -1 },
  ];
  const FL = 30;
  const ball = { x: 220, y: 386, vx: 0, vy: 0, out: false };
  const st = { score: 0, balls: 3, ballNo: 1, mult: 1, lit: [0, 0, 0, 0, 0, 0], power: 0, save: 0, tilt: 0, tilted: false, state: 'ready', shake: 0, flash: 0,
    msg: 'PULL THE PLUNGER', msgT: 3, spin: 0, spinA: 0, laneCd: [0, 0, 0, 0, 0, 0], sling: [0, 0], newHi: false, over: 0 };
  /** @type {{x:number,y:number,s:string,c:string,t:number,big?:boolean}[]} */ const pops = [];
  /** @type {{x:number,y:number,vx:number,vy:number,t:number,c:string}[]} */ const parts = [];
  const prev = new Set();
  /** @type {Set<string>} */ const taps = new Set();
  const say = (m, t = 2) => { st.msg = m; st.msgT = t; };
  const add = (n, px, py, c = '#ffe2b0') => { if (st.tilted) return; const v = n * st.mult; st.score += v; pops.push({ x: px, y: py, s: '+' + v, c, t: 0 }); };
  const burst = (px, py, c, n = 8) => { for (let i = 0; i < n; i++) { const a = rand() * 6.28, s = 40 + rand() * 90; parts.push({ x: px, y: py, vx: Math.cos(a) * s, vy: Math.sin(a) * s, t: 0, c }); } };
  const resetBall = () => { ball.x = 220; ball.y = 386; ball.vx = ball.vy = 0; ball.out = false; st.state = 'ready'; st.tilted = false; st.tilt = 0; };
  const newGame = () => { st.score = 0; st.balls = 3; st.ballNo = 1; st.mult = 1; st.lit = [0, 0, 0, 0, 0, 0]; st.newHi = false; resetBall(); say('BALL 1 · SHIP IT', 2); };

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
        if (st.lit.every(Boolean)) { st.mult = Math.min(6, st.mult + 1); st.lit = [0, 0, 0, 0, 0, 0]; st.flash = 1; st.shake = 5; SFX.play('levelup'); say('DEPLOYED! x' + st.mult, 2.5); add(2000, 110, 110, '#ff4fd8'); pops[pops.length - 1].big = true; }
      }
    }
    const sp = Math.hypot(ball.vx, ball.vy); if (sp > 950) { ball.vx *= 950 / sp; ball.vy *= 950 / sp; }
  }
  function drain() {
    if (st.save > 0 && !st.tilted) { SFX.play('chime', { vol: 0.5 }); say('BALL SAVED · rollback ok', 2); resetBall(); return; }
    SFX.play('fail', { vol: 0.5 }); st.balls--; st.flash = 0.6; st.shake = 6;
    if (st.balls <= 0) { st.state = 'over'; st.over = 0; if (st.score > hi) { hi = st.score; st.newHi = true; try { localStorage.setItem(HI_KEY, String(hi)); } catch { /* ignore */ } } say(st.newHi ? 'NEW HIGH SCORE' : 'GAME OVER · PROD IS DOWN', 99); return; }
    st.ballNo++; resetBall(); say('DRAINED TO PROD · BALL ' + st.ballNo, 2.2);
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
        SFX.play('thud', { vol: 0.5 }); if (st.tilt > 4) { SFX.play('ui.deny'); st.tilted = true; say('TILT · hands off the prod box', 3); st.flash = 0.8; } else if (st.tilt > 2.2) say('DANGER · easy there', 1.2);
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
    for (const p of pops) p.t += dt; while (pops.length && pops[0].t > 1.1) pops.shift();
    for (const p of parts) { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 200 * dt; } while (parts.length && parts[0].t > 0.6) parts.shift();
  }

  // static printed field, rendered once
  const bg = document.createElement('canvas'); bg.width = W; bg.height = PH; const b = /** @type {CanvasRenderingContext2D} */ (bg.getContext('2d'));
  {
    const g = b.createLinearGradient(0, 0, 0, PH); g.addColorStop(0, '#2a2440'); g.addColorStop(0.6, '#1e2240'); g.addColorStop(1, '#140f22'); b.fillStyle = g; b.fillRect(0, 0, W, PH);
    b.fillStyle = 'rgba(110,231,160,0.07)'; for (let i = 10; i < W; i += 10) b.fillRect(i, 0, 1, PH); for (let i = 0; i < PH; i += 10) b.fillRect(0, i, W, 1);
    const tri = (cx, cy, c) => { b.fillStyle = c; b.beginPath(); b.moveTo(cx, cy - 6); b.lineTo(cx - 6, cy + 4); b.lineTo(cx + 6, cy + 4); b.fill(); };
    for (let i = 0; i < 4; i++) tri(110, 290 - i * 12, ['#3a2a5a', '#4a2a6a', '#5a2a7a', '#6a2a8a'][i]);
    tri(26, 240, '#4a3a2a'); tri(26, 228, '#4a3a2a');
    text(b, 'MERGE CONFLICT', 110, 232, { color: '#ff4fd8', align: 'center', shadow: '#2a0a2a' });
    text(b, '// TODO: fix', 110, 118, { color: '#5a6a8a', align: 'center' });
    text(b, 'SPIN', 14, 186, { color: '#8a6a3a' });
    text(b, 'PROD', 110, 396, { title: true, color: '#7a1a2a', align: 'center' });
    text(b, 'SHIP', 213, 340, { color: '#3a5a4a' });
    text(b, 'works on my machine', 110, 330, { color: '#3a3a5a', align: 'center' });
    b.strokeStyle = '#c9ccd8'; b.lineWidth = 2; b.lineCap = 'round';
    for (const s of T.segs) { if (s.gate || s.kick) continue; b.beginPath(); b.moveTo(s.x1, s.y1); b.lineTo(s.x2, s.y2); b.stroke(); }
    b.fillStyle = '#c9ccd8'; for (const p of T.posts) { b.beginPath(); b.arc(p.x, p.y, p.r, 0, 7); b.fill(); }
  }

  function draw(t) {
    x.save(); x.fillStyle = '#0c0a12'; x.fillRect(0, 0, W, PH + TOP);
    // display
    x.fillStyle = '#1a0e06'; x.fillRect(0, 0, W, TOP); x.fillStyle = 'rgba(255,138,48,0.08)'; for (let i = 0; i < W; i += 2) x.fillRect(i, 0, 1, TOP);
    text(x, String(st.score).replace(/\B(?=(\d{3})+(?!\d))/g, ','), 6, 22, { size: 32, color: '#ffb36b' });
    text(x, 'BALL ' + Math.min(3, st.ballNo) + '/3', 234, 13, { color: '#e0a458', align: 'right' });
    text(x, 'x' + st.mult + '  HI ' + hi, 234, 27, { color: '#8a5a2a', align: 'right' });
    const sh = st.shake; x.translate(Math.round((rand() - 0.5) * sh), TOP + Math.round((rand() - 0.5) * sh));
    x.drawImage(bg, 0, 0);
    // slings
    for (const [i, s] of T.segs.filter(s => s.kick).entries()) { x.strokeStyle = st.sling[i] > 0 ? '#ffffff' : '#6ee7a0'; x.lineWidth = 3; x.beginPath(); x.moveTo(s.x1, s.y1); x.lineTo(s.x2, s.y2); x.stroke(); if (st.sling[i] > 0) { x.strokeStyle = 'rgba(110,231,160,0.5)'; x.lineWidth = 7; x.stroke(); } }
    // gate
    x.strokeStyle = '#8a8ea0'; x.lineWidth = 1; x.beginPath(); x.moveTo(210, 160); x.lineTo(230, 141); x.stroke();
    // bumpers
    for (const bp of T.bumpers) {
      const r = bp.r + bp.f * 3; x.fillStyle = bp.f > 0 ? '#ffffff' : bp.c; x.globalAlpha = 0.25 + bp.f * 0.5; x.beginPath(); x.arc(bp.x, bp.y, r + 4, 0, 7); x.fill(); x.globalAlpha = 1;
      x.fillStyle = '#1a1424'; x.beginPath(); x.arc(bp.x, bp.y, r, 0, 7); x.fill(); x.strokeStyle = bp.f > 0 ? '#fff' : bp.c; x.lineWidth = 2; x.stroke();
      text(x, bp.t, bp.x, bp.y + 4, { color: bp.f > 0 ? '#fff' : bp.c, align: 'center' });
    }
    // DEPLOY lanes
    for (let i = 0; i < 6; i++) { const lx = 55 + i * 22, on = st.lit[i]; if (on) { x.fillStyle = 'rgba(255,179,107,0.35)'; x.beginPath(); x.arc(lx, 66, 9, 0, 7); x.fill(); } text(x, WORD[i], lx, 71, { color: on ? '#ffe2b0' : '#5a4a3a', align: 'center' }); }
    // spinner
    { const c = Math.cos(st.spinA); x.fillStyle = '#c9ccd8'; x.fillRect(12, 210 - Math.abs(c) * 2 - 1, 22, Math.abs(c) * 4 + 1); x.fillStyle = '#ffb36b'; x.fillRect(11, 209, 2, 2); x.fillRect(33, 209, 2, 2); }
    // ball save lamp
    if (st.save > 0 && (st.save > 2 || Math.sin(t * 20) > 0)) text(x, 'BALL SAVE', 110, 314, { color: '#6ee7a0', align: 'center' });
    // flippers
    for (const f of fl) {
      const [tx, ty] = flipTip(f); x.lineCap = 'round'; x.strokeStyle = '#3a2410'; x.lineWidth = 10; x.beginPath(); x.moveTo(f.px, f.py + 1); x.lineTo(tx, ty + 1); x.stroke();
      x.strokeStyle = st.tilted ? '#5a4a3a' : '#ffb36b'; x.lineWidth = 8; x.beginPath(); x.moveTo(f.px, f.py); x.lineTo(tx, ty); x.stroke();
      x.fillStyle = '#fff'; x.beginPath(); x.arc(f.px, f.py, 2, 0, 7); x.fill();
    }
    // plunger
    { const py = 394 + st.power * 18; x.fillStyle = '#6a6e80'; x.fillRect(216, py - 2, 8, 4); x.fillStyle = '#3a3e50'; for (let y = py + 2; y < 420; y += 3) x.fillRect(217, y, 6, 1); if (st.power > 0) { x.fillStyle = '#ff4fd8'; x.fillRect(232, 392 - st.power * 60, 4, st.power * 60); } }
    // ball
    { const g = x.createRadialGradient(ball.x - 2, ball.y - 2, 0.5, ball.x, ball.y, BR); g.addColorStop(0, '#ffffff'); g.addColorStop(0.5, '#b8bccc'); g.addColorStop(1, '#4a4e60'); x.fillStyle = g; x.beginPath(); x.arc(ball.x, ball.y, BR, 0, 7); x.fill(); }
    for (const p of parts) { x.globalAlpha = 1 - p.t / 0.6; x.fillStyle = p.c; x.fillRect(p.x | 0, p.y | 0, 2, 2); } x.globalAlpha = 1;
    for (const p of pops) { const k = p.t / 1.1; x.globalAlpha = 1 - k * k; text(x, p.s, p.x, p.y - k * 24 - (k < 0.15 ? (0.15 - k) * -20 : 0), { size: p.big ? 32 : 16, color: p.c, align: 'center', shadow: '#000' }); } x.globalAlpha = 1;
    // tilt meter
    if (st.tilt > 0.1) { x.fillStyle = st.tilt > 2.2 ? '#ff5050' : '#e0a458'; x.fillRect(4, 380, 3, -Math.min(4, st.tilt) * 10); }
    x.restore();
    if (st.flash > 0) { x.fillStyle = `rgba(255,79,216,${st.flash * 0.25})`; x.fillRect(0, TOP, W, PH); }
    if (st.msgT > 0 || st.state !== 'play') {
      const m = st.state === 'ready' && st.msgT <= 0 ? 'HOLD SPACE · RELEASE' : st.msg;
      x.fillStyle = 'rgba(10,6,16,0.8)'; x.fillRect(0, TOP + 236, W, 26); text(x, m, W / 2, TOP + 254, { color: st.tilted ? '#ff5050' : '#ffe2b0', align: 'center' });
      if (st.state === 'over') { x.fillStyle = 'rgba(10,6,16,0.85)'; x.fillRect(20, TOP + 140, 200, 80); text(x, 'GAME OVER', W / 2, TOP + 172, { title: true, size: 32, color: '#ff4fd8', align: 'center' }); text(x, 'SCORE ' + st.score + '   HI ' + hi, W / 2, TOP + 192, { color: '#ffb36b', align: 'center' }); if (st.over > 1 && Math.sin(t * 6) > -0.3) text(x, 'SPACE · force push again', W / 2, TOP + 210, { color: '#6ee7a0', align: 'center' }); }
    }
  }
  return { update, draw, tap: k => { taps.add(k); }, W, H: PH + TOP };
}
