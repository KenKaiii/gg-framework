// @ts-check
// Activities for Hawkins Living Room: talk through the Christmas-lights alphabet, and roll a d20 at the campaign table.
import { loop, text, mouse } from './util.js';
import { typer } from './films-a-crt.js';
import { SFX } from '../sfx.js';
import { PAL, bg, panel, badge, button, banner, title, glow, noise, particles, shaker, shade } from './art.js';

// one Christmas bulb flaring: a warm electric buzz + soft glassy tick
SFX.define('hawkins.bulb', (o, t, p, K) => { K.tone(o, t, { type: 'sawtooth', f: 120 * p, v: 0.05, a: 0.01, d: 0.25 }); K.bell(o, t, { f: 1400 * p, ratio: 2.7, idx: 0.8, v: 0.06, d: 0.2 }); });

const ROWS = ['ABCDEFGH', 'IJKLMNOPQ', 'RSTUVWXYZ'];
const COLS = ['#ff4040', '#ffd040', '#40c060', '#4080ff', '#ff70d0', '#ff9a30'];
const STEP = 0.75, IDLE = 7;
const on = (id) => (it, R) => R.id === 'hawkins' && it.id === id;

/** The alphabet wall (Stranger Things): type a word, the bulbs spell it out; leave it alone and it talks back.
 *  Drawn as a lamp-lit corner of the Byers' living room: floral wallpaper, letters hand-painted in black house paint
 *  (with drips), a sagging green wire with C9 bulbs that light up and throw coloured light onto the wall.
 *  @param {any} ctx */
function lights(ctx) {
  const { R } = ctx;
  const ov = ctx.overlay({ title: 'The Lights', sub: 'Hawkins · someone is listening', help: '<kbd>type</kbd> a word <kbd>enter</kbd> spell it <kbd>click</kbd> a letter to light it <kbd>esc</kbd> leave' });
  const W = 480, H = 270, { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const st = { t: 0, seq: /** @type {number[]} */ ([]), t0: 0, last: 0, word: '', shake: 0, idleN: 0 };
  const ABC = ROWS.join('');
  const spell = w => { const s = w.toUpperCase().replace(/[^A-Z ]/g, '').slice(0, 14); if (!s.trim()) return; st.word = s; st.seq = [...s].map(c => ABC.indexOf(c)); st.t0 = st.t; R.hawk?.spell(s); };
  const sh = typer(ov, v => { st.last = st.t; if (!v) SFX.play('ui.deny'); spell(v); }, 14);
  const rnd = (k) => { const v = Math.sin(k * 12.9898 + 78.233) * 43758.5453; return v - Math.floor(v); };
  // layout: three rows of letters under three sagging wires
  const ROW_Y = [74, 132, 190], SAG = 7;
  const wireY = (ri, px) => ROW_Y[ri] - 34 + Math.sin(((px - 24) / (W - 48)) * Math.PI) * SAG + Math.sin(px * 0.11 + ri) * 1.2;
  const pos = []; ROWS.forEach((row, ri) => [...row].forEach((_, i) => { const px = 44 + (i + 0.5) * (W - 88) / row.length + (rnd(ri * 9 + i) - 0.5) * 6; pos.push({ x: px, y: ROW_Y[ri] + (rnd(ri * 9 + i + 50) - 0.5) * 4, ri, wy: wireY(ri, px), tilt: (rnd(ri * 9 + i + 90) - 0.5) * 0.12 }); }));
  // mouse: click a painted letter (or its bulb) and it lights up, like spelling a one-letter word
  const m = mouse(ov, c, W, H);
  const colOf = k => COLS[(k * 5 + Math.floor(k / 9)) % COLS.length];

  // ---- static backdrop, drawn once: wallpaper, lamp light, painted letters, wires -------------------------------------
  const bg = document.createElement('canvas'); bg.width = W; bg.height = H; const b = /** @type {CanvasRenderingContext2D} */ (bg.getContext('2d')); b.imageSmoothingEnabled = false;
  // wallpaper: warm stripes with a small repeating flower
  b.fillStyle = '#5a4630'; b.fillRect(0, 0, W, H);
  for (let xx = 0; xx < W; xx += 16) { b.fillStyle = '#624d35'; b.fillRect(xx, 0, 8, H); b.fillStyle = '#4e3c29'; b.fillRect(xx + 8, 0, 1, H); }
  for (let yy = 6; yy < H; yy += 22) for (let xx = (yy / 22) % 2 ? 4 : 12; xx < W; xx += 16) {
    b.fillStyle = '#7a5a3a'; b.fillRect(xx, yy, 3, 1); b.fillRect(xx + 1, yy - 1, 1, 3); b.fillStyle = '#8a3a2a'; b.fillRect(xx + 1, yy, 1, 1); b.fillStyle = '#4a5a32'; b.fillRect(xx + 2, yy + 2, 2, 1); }
  // stains + wear
  for (let k = 0; k < 160; k++) { b.fillStyle = `rgba(30,18,10,${0.05 + rnd(k) * 0.08})`; b.fillRect(rnd(k + 3) * W, rnd(k + 7) * H, 1 + rnd(k + 11) * 3, 1 + rnd(k + 13) * 3); }
  // painted letters (black house paint): slight tilt, a few drips
  b.save(); b.font = '32px Alagard'; b.textAlign = 'center'; b.textBaseline = 'alphabetic';
  pos.forEach((p, k) => { b.save(); b.translate(Math.round(p.x), Math.round(p.y)); b.rotate(p.tilt);
    b.fillStyle = 'rgba(20,10,6,0.35)'; b.fillText(ABC[k], 1, 1); b.fillStyle = '#120a06'; b.fillText(ABC[k], 0, 0); b.restore();
    for (let d = 0; d < 1 + Math.floor(rnd(k + 200) * 3); d++) { const dx = Math.round(p.x - 8 + rnd(k * 7 + d) * 16), len = 3 + Math.floor(rnd(k * 5 + d + 1) * 9); b.fillStyle = '#120a06'; b.fillRect(dx, Math.round(p.y) + 1, 1, len); b.fillRect(dx, Math.round(p.y) + len, 2, 2); } });
  b.restore();
  // wires: two twisted strands, dark green, nailed at the ends
  ROWS.forEach((_, ri) => { for (const [off, col] of [[0, '#1c2e1a'], [1, '#2c4428']]) { b.strokeStyle = col; b.lineWidth = 1.4; b.beginPath();
      for (let px = 22; px <= W - 22; px += 3) { const py = wireY(ri, px) + off + Math.sin(px * 0.5) * 0.7 * (off ? -1 : 1); px === 22 ? b.moveTo(px, py) : b.lineTo(px, py); } b.stroke(); }
    for (const nx of [22, W - 22]) { b.fillStyle = '#9a9086'; b.fillRect(nx - 1, wireY(ri, nx) - 1, 3, 3); b.fillStyle = '#5a524a'; b.fillRect(nx, wireY(ri, nx), 2, 2); } });
  // bulb sockets
  pos.forEach(p => { b.fillStyle = '#1a2418'; b.fillRect(Math.round(p.x) - 2, Math.round(p.wy), 4, 4); b.fillStyle = '#2e3c2a'; b.fillRect(Math.round(p.x) - 2, Math.round(p.wy), 4, 1); });
  // lamp light from the left + a dark vignette, baked in
  let g = b.createRadialGradient(W * 0.18, H * 0.25, 10, W * 0.18, H * 0.25, W * 0.75); g.addColorStop(0, 'rgba(255,190,110,0.22)'); g.addColorStop(1, 'rgba(255,190,110,0)'); b.fillStyle = g; b.fillRect(0, 0, W, H);
  g = b.createRadialGradient(W / 2, H * 0.45, H * 0.35, W / 2, H * 0.45, W * 0.7); g.addColorStop(0, 'rgba(10,4,6,0)'); g.addColorStop(1, 'rgba(10,4,6,0.7)'); b.fillStyle = g; b.fillRect(0, 0, W, H);
  // C9 bulb (teardrop) at p: colour c, lit 0..1
  const bulb = (p, c, lit) => { const bx = Math.round(p.x), by = Math.round(p.wy) + 4;
    x.fillStyle = shade(c, 0.38 + 0.62 * lit); x.beginPath(); x.moveTo(bx - 3, by); x.lineTo(bx + 3, by); x.lineTo(bx + 4, by + 5); x.quadraticCurveTo(bx + 3, by + 10, bx, by + 11); x.quadraticCurveTo(bx - 3, by + 10, bx - 4, by + 5); x.closePath(); x.fill();
    x.fillStyle = `rgba(255,246,224,${0.22 + 0.78 * lit})`; x.fillRect(bx - 2, by + 2, 1, 4); if (lit > 0.5) { x.fillRect(bx - 1, by + 3, 2, 3); } };
  const shade = (c, k) => { const n = parseInt(c.slice(1), 16), r = (n >> 16) & 255, gg = (n >> 8) & 255, bl = n & 255; return `rgb(${Math.round(r * k)},${Math.round(gg * k)},${Math.round(bl * k)})`; };

  loop(ov, dt => {
    st.t += dt; const t = st.t;
    const busy = st.seq.length && t - st.t0 < st.seq.length * STEP + 0.6;
    if (!busy && sh.buf === '' && t - st.last > IDLE) { st.last = t; spell(st.idleN++ % 2 ? 'RIGHT HERE' : 'RUN'); st.shake = 0.4; SFX.play('eerie', { vol: 0.5 }); }
    if (busy && Math.floor((t - st.t0) / STEP) !== Math.floor((t - dt - st.t0) / STEP)) { const c = st.seq[Math.floor((t - st.t0) / STEP)]; if (c >= 0) SFX.play('hawkins.bulb', { pitch: 0.85 + (c % 9) * 0.04 }); }
    st.shake = Math.max(0, st.shake - dt);
    const i = Math.floor((t - st.t0) / STEP), ph = (t - st.t0) % STEP / STEP, litNow = busy && i < st.seq.length && ph < 0.75 ? st.seq[i] : -1;
    // brightness of the lit bulb: quick rise, hold, soft fade (no random flicker)
    const litK = litNow < 0 ? 0 : Math.min(1, ph / 0.08) * (ph > 0.6 ? Math.max(0, 1 - (ph - 0.6) / 0.15) : 1);
    // all bulbs breathe faintly; while the house "listens" (idle) they swell together, slowly
    const idleK = busy ? 0 : Math.max(0, Math.sin(t * 0.7)) * 0.12;
    const ox = st.shake ? Math.round(Math.sin(t * 60) * 2) : 0;
    m.rows(k => ({ x: pos[k].x - 12 + ox, y: pos[k].wy, w: 24, h: pos[k].y + 6 - pos[k].wy }), pos.length, { pick: k => { st.last = st.t; spell(ABC[k]); } });
    x.save(); if (ox) x.translate(ox, 0);
    x.drawImage(bg, 0, 0);
    // light: lit bulb throws its colour onto the wall + its letter
    if (litNow >= 0) { const p = pos[litNow], c = colOf(litNow); x.save(); x.globalCompositeOperation = 'lighter';
      const gg = x.createRadialGradient(p.x, p.wy + 8, 1, p.x, p.y - 8, 46); gg.addColorStop(0, c); gg.addColorStop(0.35, shade(c, 0.45)); gg.addColorStop(1, 'rgba(0,0,0,0)');
      x.globalAlpha = 0.75 * litK; x.fillStyle = gg; x.fillRect(p.x - 50, p.wy - 40, 100, 100); x.restore(); }
    pos.forEach((p, k) => bulb(p, colOf(k), k === litNow ? litK : idleK));
    // halo on the lit bulb itself
    if (litNow >= 0) { const p = pos[litNow]; x.save(); x.globalCompositeOperation = 'lighter'; const gh = x.createRadialGradient(p.x, p.wy + 9, 0, p.x, p.wy + 9, 14); gh.addColorStop(0, 'rgba(255,250,230,0.9)'); gh.addColorStop(1, 'rgba(255,250,230,0)'); x.globalAlpha = litK; x.fillStyle = gh; x.fillRect(p.x - 14, p.wy - 5, 28, 28); x.restore(); }
    x.restore();
    // bottom strip: a framed wood panel with the spelled message and your typing
    const sp = panel(x, 8, 218, W - 16, 46, { style: 'wood' });
    const shown = busy ? st.word.slice(0, Math.min(st.word.length, i + 1)) : '';
    if (shown) title(x, shown, W / 2, 244, { size: 32, color: '#ff7a5a', glow: 'rgba(255,90,60,0.7)', glowR: 10 });
    else title(x, '> ' + sh.buf + ((t * 2.2) % 1 < 0.55 ? '_' : ''), 20, 238, { size: 16, body: true, align: 'left', color: PAL.goldHi });
    if (!busy && !sh.buf) title(x, 'type a word + ENTER, or click a letter. leave it alone and it talks back', W / 2, sp.y + 40, { size: 16, body: true, color: PAL.dim });
  });
}

/** d20 at the campaign table. @param {any} ctx */
function d20(ctx) {
  const ov = ctx.overlay({ title: 'Roll for initiative', sub: 'The campaign table · a monster mini watches', help: '<kbd>space</kbd>/<kbd>click</kbd> roll <kbd>esc</kbd> leave' });
  const W = 320, H = 180, { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const st = { t: 0, roll: 0, res: 0, shown: 1, best: 0, n: 0, pops: /** @type {{x:number,y:number,vx:number,vy:number,c:string,l:number}[]} */ ([]) };
  const go = () => { if (st.roll > 0) return; st.roll = 1.1; st.res = 1 + Math.floor(Math.random() * 20); SFX.play('dice'); SFX.play('dice', { delay: 0.45, vol: 0.6 }); };
  const kd = e => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); go(); } };
  addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd)); go();
  mouse(ov, c, W, H).set([{ x: 0, y: 0, w: W, h: H, pick: go }]); // click anywhere on the table = roll
  const line = n => n === 20 ? 'NAT 20! The Demogorgon flees.' : n === 1 ? 'Nat 1. It got you. (it always does)' : n >= 15 ? 'Fireball! Solid hit.' : n >= 8 ? 'You hit it. It is annoyed.' : 'Miss. Should have cast protection.';
  const fx = particles(), shk = shaker(), table = feltTable(W, H); let hot = false, shownN = 0, bannerT = -1;
  c.addEventListener('pointermove', e => { const q = c.getBoundingClientRect(), px = (e.clientX - q.left) / q.width * W, py = (e.clientY - q.top) / q.height * H; hot = px > W - 80 && py > H - 34; });
  loop(ov, dt => {
    st.t += dt; const t = st.t;
    if (st.roll > 0) { st.roll -= dt; st.shown = 1 + Math.floor(Math.random() * 20); if (st.roll <= 0) { st.shown = st.res; st.n++; st.best = Math.max(st.best, st.res); SFX.play(st.res === 20 ? 'win' : st.res === 1 ? 'fail' : st.res >= 15 ? 'success' : st.res >= 8 ? 'score' : 'ui.deny');
      const col = st.res === 20 ? PAL.green : st.res === 1 ? PAL.red : PAL.gold; fx.burst(160, 80, { n: st.res === 20 ? 50 : 16, colors: [col, PAL.goldHi, PAL.cream], speed: 90 });
      if (st.res === 20) { fx.confetti(W); bannerT = 0; } if (st.res === 1) { shk.kick(6); bannerT = 0; } } }
    shownN += (st.n - shownN) * Math.min(1, dt * 10);
    x.drawImage(table, 0, 0); glow(x, 160, 70, 110, '#ffcf8a', 0.12 + 0.03 * Math.sin(t * 1.4));
    x.save(); shk.apply(x, dt);
    const rolling = st.roll > 0, rot = rolling ? t * 14 : 0, R = 38 + (rolling ? Math.sin(t * 30) * 3 : 0), cx = 160 + (rolling ? Math.sin(t * 9) * 30 : 0), cy = 80 + (rolling ? -Math.abs(Math.sin(t * 11)) * 18 : 0);
    x.fillStyle = 'rgba(0,0,0,0.45)'; x.beginPath(); x.ellipse(cx, 124, 34, 6, 0, 0, 7); x.fill();
    if (!rolling && st.n && (st.res === 20 || st.res >= 15)) glow(x, cx, cy, 60, st.res === 20 ? PAL.green : PAL.gold, 0.3 + 0.1 * Math.sin(t * 2));
    const hex = []; for (let k = 0; k < 6; k++) hex.push([cx + Math.cos(rot + k * Math.PI / 3 + Math.PI / 6) * R, cy + Math.sin(rot + k * Math.PI / 3 + Math.PI / 6) * R]);
    // faceted die: six triangles from the centre, lit from the top-left
    for (let k = 0; k < 6; k++) { const [a1, b1] = hex[k], [a2, b2] = hex[(k + 1) % 6], lit = 0.5 + 0.5 * Math.cos(rot + k * Math.PI / 3 + Math.PI / 6 + Math.PI * 0.75 + Math.PI / 6);
      x.fillStyle = shade('#a01c30', lit * 0.5 - 0.25); x.beginPath(); x.moveTo(cx, cy); x.lineTo(a1, b1); x.lineTo(a2, b2); x.closePath(); x.fill(); }
    x.fillStyle = '#c8304a'; x.beginPath(); for (const k of [0, 2, 4]) x.lineTo(cx + (hex[k][0] - cx) * 0.62, cy + (hex[k][1] - cy) * 0.62); x.closePath(); x.fill();
    x.strokeStyle = '#ff8a9a'; x.lineWidth = 1; x.stroke(); x.strokeStyle = '#3a0610'; x.lineWidth = 2; x.beginPath(); hex.forEach(([a, b], k) => k ? x.lineTo(a, b) : x.moveTo(a, b)); x.closePath(); x.stroke();
    title(x, String(st.shown), cx, cy + 8, { size: 32, color: st.n && !rolling && st.res === 20 ? PAL.goldHi : PAL.cream });
    fx.draw(x, dt); x.restore();
    // HUD: rolls + best chips, the roll button, the verdict strip
    badge(x, 8, 8, 'rolls', Math.round(shownN), { style: 'wood', color: PAL.cream, w: 58 }); badge(x, W - 66, 8, 'best', st.best || '-', { style: 'wood', color: PAL.gold, w: 58 });
    const vp = panel(x, 8, H - 34, W - 96, 26, { style: 'paper' });
    title(x, !st.n ? 'roll for initiative...' : rolling ? 'rolling...' : line(st.res), vp.x + vp.w / 2, vp.y + 18, { size: 16, body: true, color: !rolling && st.res === 1 ? '#a01c1c' : !rolling && st.res === 20 ? '#1a6a3a' : PAL.paperInk, ink: 'rgba(255,246,224,0.6)' });
    button(x, W - 80, H - 34, 72, 26, 'ROLL', { primary: true, hot, disabled: rolling, down: rolling });
    if (bannerT >= 0) { bannerT += dt; banner(x, W, H, st.res === 20 ? 'NAT 20!' : 'NAT 1', st.res === 20 ? 'the Demogorgon flees' : 'it got you', bannerT, { color: st.res === 20 ? PAL.green : PAL.red, style: st.res === 20 ? 'neon' : 'wood' }); if (bannerT > 1.6) bannerT = -1; }
  });
}

/** Cached campaign table: wood rim, green felt, a hand-drawn dungeon map and a DM screen edge. */
function feltTable(W, H) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const x = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
  bg.vignette(x, W, H, '#2a1810', '#4a3020');
  panel(x, 4, 4, W - 8, H - 8, { style: 'felt', r: 8 });
  x.save(); x.translate(232, 46); x.rotate(0.12); x.fillStyle = 'rgba(0,0,0,0.3)'; x.fillRect(2, 3, 64, 50); x.fillStyle = PAL.paper; x.fillRect(0, 0, 64, 50); noise(x, 0, 0, 64, 50, 0.06, 2);
  x.strokeStyle = PAL.paperInk; x.lineWidth = 1; x.strokeRect(6, 6, 20, 14); x.strokeRect(36, 10, 22, 18); x.strokeRect(10, 30, 16, 14); x.beginPath(); x.moveTo(26, 13); x.lineTo(36, 18); x.moveTo(18, 20); x.lineTo(18, 30); x.stroke(); x.fillStyle = PAL.red; x.fillRect(46, 18, 3, 3); x.restore();
  x.save(); x.translate(20, 50); x.rotate(-0.08); x.fillStyle = 'rgba(0,0,0,0.3)'; x.fillRect(2, 3, 52, 40); x.fillStyle = '#e8dcc0'; x.fillRect(0, 0, 52, 40); for (let i = 0; i < 6; i++) { x.fillStyle = 'rgba(58,36,20,0.4)'; x.fillRect(4, 6 + i * 5, 30 + (i * 7) % 14, 1); } title(x, 'HP 7', 26, 38, { size: 16, body: true, color: PAL.red }); x.restore();
  return cv;
}

/** @type {any[]} */
export default [
  { id: 'hawkins-lights', match: on('alphabet'), label: () => 'Talk through the lights', sfx: 'hawkins.bulb', start: lights },
  { id: 'hawkins-d20', match: on('dnd'), label: () => 'Roll a d20', sfx: 'cards', start: d20 },
];
