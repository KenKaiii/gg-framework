// @ts-check
// Films B: "PC LOAD LETTER?!" printer-smashing mini-game (overlay, 320x180 pixel canvas).
import { SFX } from '../sfx.js';
import { text, loop, rng } from './util.js';
import { PAL, bg, panel, badge, button, banner, title, glow, particles } from './art.js';

/** Cached office: cubicle-grey wall, carpet tiles, a flickerless fluorescent pool (drawn once). */
function office() {
  const cv = document.createElement('canvas'); cv.width = W + 20; cv.height = H + 20; const x = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
  bg.room(x, W + 20, H + 20, { wall: '#4a5260', floor: '#2a3048', horizon: 0.74, light: '#e8f4ff', lightY: 30 });
  x.fillStyle = '#6a7280'; x.fillRect(10, 40, 70, 90); x.fillStyle = '#5a6270'; for (let i = 14; i < 80; i += 4) x.fillRect(i, 42, 1, 86); // cubicle partition
  x.fillStyle = '#e8e0c8'; x.fillRect(24, 56, 24, 30); x.fillStyle = PAL.red; x.fillRect(26, 60, 20, 3); x.fillStyle = '#8a8478'; for (let i = 0; i < 4; i++) x.fillRect(26, 66 + i * 4, 16, 1); // memo: TPS REPORTS
  x.fillStyle = '#f0f4ff'; x.fillRect(110, 10, 120, 4); return cv;
}

const W = 320, H = 180, PX = 160, PY = 112;

/** @param {any} ctx */
export function printerGame(ctx) {
  const ov = ctx.overlay({ title: 'PC LOAD LETTER?!', sub: 'the printer had it coming', help: '<kbd>space</kbd>/<kbd>click</kbd> smash &nbsp; <kbd>r</kbd>/<kbd>click</kbd> new printer (after) &nbsp; <kbd>esc</kbd> leave' });
  const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const r = rng(7);
  const st = { hp: 100, hits: 0, shake: 0, flash: 0, swing: 0, parts: [], pops: [], dead: 0, best: 0, t0: 0, time: 0 };
  const reset = () => { st.hp = 100; st.hits = 0; st.parts = []; st.pops = []; st.dead = 0; st.t0 = 0; st.time = 0; };
  const COL = ['#bdb6a2', '#8e8878', '#2a2a2e', '#2e6a3a', '#ece6d8', '#c99a4a'];
  const burst = (n, big) => { for (let i = 0; i < n; i++) { const a = -Math.PI * (0.1 + r() * 0.8); const v = (big ? 90 : 50) + r() * (big ? 160 : 90);
    st.parts.push({ x: PX + (r() - 0.5) * 50, y: PY - 20 - r() * 20, vx: Math.cos(a) * v * (r() < 0.5 ? -1 : 1), vy: Math.sin(a) * v, s: 2 + (r() * 4 | 0), c: COL[(r() * COL.length) | 0], rot: r() * 6, life: 2.5 }); } };
  const hit = () => {
    if (st.dead) return; if (!st.t0) st.t0 = performance.now();
    const dmg = 5 + (r() * 7 | 0); st.hp = Math.max(0, st.hp - dmg); st.hits++; st.shake = 5; st.flash = 1; st.swing = 1; SFX.play('punch', { vol: 0.5, jitter: 0.1 }); SFX.play('rattle', { vol: 0.3, delay: 0.05 });
    burst(5 + (r() * 5 | 0), false); st.pops.push({ x: PX + (r() - 0.5) * 60, y: PY - 50, v: '-' + dmg, t: 0.9 });
    if (st.hp <= 0) { fx.burst(PX, PY - 30, { n: 40, speed: 120 }); st.dead = 1; st.time = (performance.now() - st.t0) / 1000; burst(60, true); SFX.play('arcade.boom', { vol: 0.6, pitch: 0.6 }); SFX.play('win', { delay: 0.4 }); st.shake = 12; st.flash = 2; st.best = st.best ? Math.min(st.best, st.time) : st.time; ov.setSub('printer: 0. you: 1.'); }
  };
  const kd = e => { if (e.code === 'Escape') return; if (e.code === 'KeyR') { SFX.play('pc.boot', { vol: 0.4 }); reset(); ov.setSub('the printer had it coming'); e.preventDefault(); return; } if (!e.repeat && /Space|Enter|Key[A-Z]|Digit/.test(e.code)) { e.preventDefault(); hit(); } };
  addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd));
  c.style.cursor = 'pointer';
  const BA = { x: W / 2 - 92, y: 128, w: 88, h: 24 }, BL = { x: W / 2 + 4, y: 128, w: 88, h: 24 }; let hot = -1, mx = 0, my = 0;
  const inB = (b, px, py) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
  const at = e => { const q = c.getBoundingClientRect(); return [(e.clientX - q.left) / q.width * W, (e.clientY - q.top) / q.height * H]; };
  c.addEventListener('pointermove', e => { [mx, my] = at(e); hot = st.dead ? (inB(BA, mx, my) ? 0 : inB(BL, mx, my) ? 1 : -1) : -1; });
  c.addEventListener('pointerdown', e => { if (e.button !== 0) return; const [px, py] = at(e);
    if (st.dead) { if ((performance.now() - st.t0) / 1000 - st.time < 0.8) return; if (inB(BL, px, py)) { ov.close(); return; } if (inB(BA, px, py)) { SFX.play('pc.boot', { vol: 0.4 }); reset(); ov.setSub('the printer had it coming'); } return; } hit(); });
  const room = office(), fx = particles(); let hpShown = 100, deadT = 0, best0 = 0;

  /** Pixel printer, more broken as hp drops. */
  const printer = (t) => {
    const dmg = 1 - st.hp / 100, tilt = dmg * 0.25;
    x.save(); x.translate(PX, PY); x.rotate(tilt * Math.sin(st.hits));
    x.fillStyle = '#5a5648'; x.fillRect(-62, -6, 124, 30);                           // base shadow side
    x.fillStyle = '#bdb6a2'; x.fillRect(-60, -50, 120, 50);                          // body
    x.fillStyle = '#d4ceba'; x.fillRect(-60, -50, 120, 6);
    x.fillStyle = '#2a2a2e'; x.fillRect(-46, -34, 92, 8);                            // paper slot
    if (st.hp > 30) { x.fillStyle = '#ece6d8'; x.fillRect(-36, -26 + Math.sin(t * 3) * 2, 72, 12); }  // paper tongue
    x.fillStyle = '#9c967f'; x.fillRect(-60, 0, 120, 22);                            // tray
    x.fillStyle = '#1c2a1c'; x.fillRect(-4, -48, 62, 13);                            // LCD
    text(x, (t * 2 | 0) % 2 && !st.dead ? 'PC LOAD' : 'LETTER', 27, -38, { color: '#8fe08a', align: 'center' });
    x.fillStyle = (t * 3 | 0) % 2 ? '#ff3a2a' : '#5a1a14'; x.fillRect(-52, -45, 4, 4);   // error light
    x.strokeStyle = '#2a2a2e'; x.lineWidth = 1; x.beginPath();                        // cracks
    const n = Math.floor(dmg * 10); for (let i = 0; i < n; i++) { const cx = -50 + ((i * 37) % 100), cy = -48 + ((i * 23) % 44); x.moveTo(cx, cy); x.lineTo(cx + 6 - (i % 3) * 5, cy + 7); x.lineTo(cx + 2, cy + 14); }
    x.stroke();
    if (dmg > 0.5) { x.fillStyle = '#16120c'; x.fillRect(-58, -18, 18, 14); }        // hole
    if (dmg > 0.75) { x.fillStyle = '#2e6a3a'; x.fillRect(-56, -16, 12, 8); x.fillStyle = '#c99a4a'; x.fillRect(-54, -14, 2, 2); x.fillRect(-49, -12, 2, 2); }
    x.restore();
  };
  loop(ov, (dt, t) => {
    st.shake = Math.max(0, st.shake - dt * 30); st.flash = Math.max(0, st.flash - dt * 4); st.swing = Math.max(0, st.swing - dt * 5);
    x.save(); x.translate((Math.random() - 0.5) * st.shake, (Math.random() - 0.5) * st.shake);
    x.drawImage(room, -10, -10); glow(x, PX, 40, 130, '#d8f0ff', 0.10 + 0.02 * Math.sin(t * 1.3));
    if (!st.dead) printer(t); else { x.fillStyle = '#2a2a2e'; x.fillRect(PX - 50, PY + 8, 100, 10); x.fillStyle = '#9c967f'; x.fillRect(PX - 30, PY + 2, 30, 8); x.fillStyle = '#bdb6a2'; x.fillRect(PX + 6, PY, 22, 10); }
    for (const p of st.parts) { p.vy += 260 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += dt * 8; if (p.y > 150) { p.y = 150; p.vy *= -0.35; p.vx *= 0.6; } p.life -= dt; x.fillStyle = p.c; x.fillRect(Math.round(p.x), Math.round(p.y), p.s, p.s); }
    st.parts = st.parts.filter(p => p.life > 0 || st.dead);
    // the bat
    const a = 0.45 - st.swing * 1.25; x.save(); x.translate(PX + 104, PY + 14); x.rotate(a);
    x.fillStyle = '#8a5a32'; x.fillRect(-4, -70, 9, 52); x.fillStyle = '#6a4224'; x.fillRect(-3, -18, 7, 26); x.fillStyle = '#2a1a10'; x.fillRect(-4, 6, 9, 4); x.restore();
    for (const p of st.pops) { p.t -= dt; p.y -= dt * 30; title(x, p.v, p.x, p.y, { size: 16, color: PAL.gold }); }
    st.pops = st.pops.filter(p => p.t > 0);
    x.restore();
    if (st.flash > 0) { x.fillStyle = `rgba(255,240,220,${Math.min(0.6, st.flash * 0.3)})`; x.fillRect(0, 0, W, H); }
    fx.draw(x, dt);
    // HUD: printer health bar on a metal plate, hits + best chips
    hpShown += (st.hp - hpShown) * Math.min(1, dt * 10);
    panel(x, 6, 6, 128, 30, { style: 'metal', r: 3 }); title(x, 'PRINTER', 12, 19, { size: 16, body: true, align: 'left', color: PAL.dim });
    x.fillStyle = '#0e1014'; x.fillRect(12, 23, 116, 8); const hc = st.hp > 50 ? PAL.green : st.hp > 20 ? PAL.gold : PAL.red;
    x.fillStyle = PAL.cream; x.fillRect(13, 24, Math.round(hpShown * 1.14), 6); x.fillStyle = hc; x.fillRect(13, 24, Math.round(st.hp * 1.14), 6); x.fillStyle = 'rgba(255,255,255,0.35)'; x.fillRect(13, 24, Math.round(st.hp * 1.14), 1);
    badge(x, W - 128, 6, 'hits', st.hits, { style: 'metal', color: PAL.cream, w: 58, h: 30 }); badge(x, W - 66, 6, 'best', st.best ? st.best.toFixed(1) + 's' : '-', { style: 'metal', color: PAL.cyan, w: 60, h: 30 });
    if (st.dead) {
      if (!deadT) { best0 = st.best; fx.confetti(W); } deadT += dt;
      banner(x, W, H - 40, 'DESTROYED', `${st.hits} hits in ${st.time.toFixed(1)}s` + (st.time <= best0 ? '  ·  new best!' : ''), deadT, { color: PAL.gold, style: 'metal' });
      if (deadT > 0.5) { button(x, BA.x, BA.y, BA.w, BA.h, 'AGAIN (R)', { primary: true, hot: hot === 0 }); button(x, BL.x, BL.y, BL.w, BL.h, 'LEAVE (ESC)', { hot: hot === 1 }); }
    } else { deadT = 0; if (!st.hits) { const p = panel(x, W / 2 - 104, 40, 208, 44, { style: 'paper' });
      title(x, 'PC LOAD LETTER?!', W / 2, p.y + 19, { size: 16, color: '#8a1a14', ink: 'rgba(255,246,224,0.7)' });
      title(x, 'SPACE or click: smash it', W / 2, p.y + 36, { size: 16, body: true, color: PAL.paperInk, ink: 'rgba(255,246,224,0.6)' }); } }
  });
}
