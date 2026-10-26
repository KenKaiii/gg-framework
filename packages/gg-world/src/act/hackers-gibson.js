// @ts-check
// Hack the Gibson: fly through the neon data city (a tiny three.js scene: translucent code towers, grid, fog) and
// find the garbage file before the trace closes in. Scanner pings hotter as you near it. On find: download bar,
// glitch flash, HACK THE PLANET banner. Best time saved; first win of the day pays coins.
import { SFX } from '../sfx.js';
import { text, loop, rng, keys, coins } from './util.js';
import { scan, load, save, today } from './hackers-util.js';
import { gibsonScene } from './hackers-gibson-scene.js';

const W = 480, H = 270, GW = 30, GH = 24, TRACE = 75, PAY = 5, DL = 2.2;

/** @param {any} ctx */
export function startGibson(ctx) {
  const { S } = ctx; ctx.R.hackers?.fire('gibson');
  const ov = ctx.overlay({ title: 'Hack the Gibson', sub: 'find the garbage file', help: '<kbd>←→</kbd> turn <kbd>↑↓</kbd> fly <kbd>space</kbd> boost <kbd>esc</kbd> jack out' });
  const day = today(); let tries = 0;
  /** @type {any} */ let g = null; /** @type {any} */ let sc = null;
  const hud = ov.canvas(W, H); const x = hud.x; x.imageSmoothingEnabled = false;
  hud.c.style.position = 'absolute'; hud.c.style.left = '0'; hud.c.style.top = '0'; hud.c.style.boxShadow = 'none';
  const K = keys(ov);
  const reset = () => {
    const r = rng(day * 13 + tries++ * 101); const tow = new Uint8Array(GW * GH);
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) tow[j * GW + i] = (i % 3 && j % 3 && r() < 0.85) ? 1 + Math.floor(r() * 4) : 0;
    let fi, fj; do { fi = 2 + Math.floor(r() * (GW - 4)); fj = 2 + Math.floor(r() * (GH - 4)); } while (tow[fj * GW + fi] || Math.hypot(fi - 1, fj - 1) < 14);
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) tow[j * GW + i] = 0;
    sc?.dispose(); sc = gibsonScene(tow, GW, GH, fi, fj);
    const c = sc.canvas; c.style.imageRendering = 'pixelated'; c.style.display = 'block'; c.style.borderRadius = '6px'; hud.c.before(c);
    g = { tow, fi, fj, px: 0.5, pz: 0.5, yaw: 0.25, t: 0, state: 'play', ping: 0, pings: [], best: load('cyb-gibson-best', 0), msg: '', dl: 0, glitch: 0, bob: 0, wonT: 0 };
    ctx.R.hackersDbg = { ...(ctx.R.hackersDbg || {}), gibson: () => g };
  };
  reset();
  ov.onClose(() => { sc?.dispose(); sc = null; if (ctx.R.hackersDbg) delete ctx.R.hackersDbg.gibson; });
  const solid = (px, pz) => { const i = Math.floor(px), j = Math.floor(pz); return i < 0 || j < 0 || i >= GW || j >= GH || g.tow[j * GW + i] > 0; };
  const onKey = e => { if (e.code === 'Space' && (g.state === 'won' || g.state === 'lost')) { e.preventDefault(); reset(); SFX.play('pc.boot', { vol: 0.6 }); } };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  loop(ov, (dt, t) => {
    if (!sc) return;
    sc.canvas.style.width = hud.c.style.width; sc.canvas.style.height = hud.c.style.height;
    const d = Math.hypot(g.px - g.fi - 0.5, g.pz - g.fj - 0.5), near = Math.max(0, 1 - d / 14);
    if (g.state === 'play') {
      g.t += dt;
      g.yaw += ((K.has('ArrowRight') || K.has('KeyD') ? 1 : 0) - (K.has('ArrowLeft') || K.has('KeyA') ? 1 : 0)) * dt * 2.2;
      const mv = ((K.has('ArrowUp') || K.has('KeyW') ? 1 : 0) - (K.has('ArrowDown') || K.has('KeyS') ? 0.6 : 0)) * (K.has('Space') ? 4.2 : 2.6) * dt;
      const nx = g.px + Math.cos(g.yaw) * mv, nz = g.pz + Math.sin(g.yaw) * mv;
      if (!solid(nx, g.pz)) g.px = nx; if (!solid(g.px, nz)) g.pz = nz; g.bob += Math.abs(mv);
      g.ping -= dt; if (g.ping <= 0) { g.ping = Math.max(0.18, d / 10); g.pings.push({ a: 1, hot: near }); SFX.play('ping', { vol: 0.15 + near * 0.35, pitch: 0.7 + near * 0.7 }); }
      if (d < 0.75) { g.state = 'dl'; g.dl = 0; SFX.play('magic'); SFX.play('typewriter', { delay: 0.2, vol: 0.5 }); }
      if (g.t > TRACE - 10 && Math.floor(g.t) !== Math.floor(g.t - dt)) SFX.play('countdown', { vol: 0.5 });
      if (g.t >= TRACE) { g.state = 'lost'; g.glitch = 0.8; SFX.play('static'); SFX.play('fail', { delay: 0.2 }); }
    } else if (g.state === 'dl') {
      g.dl += dt / DL; g.t += dt * 0.0; if (Math.random() < dt * 0.2) g.glitch = 0.25; // rare glitch event (was ~5x per second)
      if (g.dl >= 1) { g.state = 'won'; g.glitch = 1; SFX.play('win'); SFX.play('zap', { vol: 0.5 }); const tm = Math.round(g.t * 10) / 10;
        if (!g.best || tm < g.best) { g.best = tm; save('cyb-gibson-best', tm); g.msg = 'NEW BEST'; }
        if (load('cyb-gibson-paid', 0) !== day) { save('cyb-gibson-paid', day); coins(S).spend(-PAY); g.msg += ` +${PAY} coins`; ctx.api.toast(`Garbage file downloaded. +${PAY} coins`); } }
    }
    g.glitch = Math.max(0, g.glitch - dt * 1.5);
    for (const p of g.pings) p.a -= dt * 1.4; g.pings = g.pings.filter(p => p.a > 0);
    // camera: flying low through the canyons; orbit up to admire the file once won
    const cam = sc.cam;
    if (g.state === 'won') { // zoom out of the city: rise and pull back, looking down at the file
      g.wonT += dt; const k0 = Math.min(1, g.wonT / 1.8), k = k0 * k0 * (3 - 2 * k0), f = sc.fileAt;
      cam.position.set(g.px - Math.cos(g.yaw) * 5 * k, 0.55 + 10 * k, g.pz - Math.sin(g.yaw) * 5 * k);
      cam.lookAt(f.x + (g.px - f.x) * (1 - k), 0.5, f.z + (g.pz - f.z) * (1 - k)); sc.fog(18 + 22 * k);
    } else { const fy = 0.55 + Math.sin(g.bob * 6) * 0.02; sc.fog(18);
      cam.position.set(g.px, fy, g.pz); cam.lookAt(g.px + Math.cos(g.yaw), fy + (g.state === 'dl' ? -0.15 : 0.08), g.pz + Math.sin(g.yaw)); }
    cam.rotation.z += Math.sin(t * 0.7) * 0.01 + (g.glitch ? (Math.random() - 0.5) * 0.08 * g.glitch : 0);
    sc.render(t, near);
    // HUD
    x.clearRect(0, 0, W, H);
    const tr = Math.min(1, g.t / TRACE); x.fillStyle = 'rgba(40,10,30,0.8)'; x.fillRect(10, 8, 220, 10); x.fillStyle = tr > 0.75 ? ((t * 6) % 1 < 0.5 ? '#ff3a5a' : '#ff9a3a') : '#ff4fd8'; x.fillRect(10, 8, 220 * tr, 10);
    text(x, 'TRACE', 236, 18, { color: '#ff9ad8', shadow: '#000' }); text(x, `${g.t.toFixed(1)}s  best ${g.best ? g.best.toFixed(1) + 's' : '--'}`, W - 10, 18, { align: 'right', color: '#9dff3d', shadow: '#000' });
    // scanner (bottom-left): rings + heat + arrow to the file
    if (g.state === 'play' || g.state === 'dl') {
    const sx = 44, sy = H - 44; x.fillStyle = 'rgba(5,4,12,0.7)'; x.beginPath(); x.arc(sx, sy, 32, 0, 7); x.fill();
    for (const p of g.pings) { x.strokeStyle = `rgba(157,255,61,${p.a})`; x.beginPath(); x.arc(sx, sy, 32 * (1 - p.a), 0, 7); x.stroke(); }
    const ang = Math.atan2(g.fj + 0.5 - g.pz, g.fi + 0.5 - g.px) - g.yaw - Math.PI / 2;
    x.save(); x.translate(sx, sy); x.rotate(ang); x.fillStyle = near > 0.7 ? '#ffcf8a' : '#9dff3d'; x.beginPath(); x.moveTo(0, -24); x.lineTo(6, -12); x.lineTo(-6, -12); x.fill(); x.restore();
    text(x, `${d.toFixed(1)} blk`, sx, sy + 5, { align: 'center', color: '#c8ffd0' });
    text(x, near > 0.8 ? 'HOT' : near > 0.5 ? 'warm' : 'cold', sx + 40, sy + 26, { color: near > 0.8 ? '#ffcf8a' : '#6aa850', shadow: '#000' }); }
    if (tr > 0.6 && g.state === 'play') { x.fillStyle = `rgba(255,30,60,${(tr - 0.6) * 0.6 * (0.6 + 0.4 * Math.sin(t * 10))})`; x.fillRect(0, 0, W, 5); x.fillRect(0, H - 5, W, 5); x.fillRect(0, 0, 5, H); x.fillRect(W - 5, 0, 5, H); }
    if (g.state === 'dl' || g.state === 'won') {
      x.fillStyle = 'rgba(8,6,16,0.8)'; x.fillRect(120, 100, 240, 46);
      text(x, g.state === 'dl' ? 'DOWNLOADING garbage.dat' : 'garbage.dat  COPIED', W / 2, 118, { align: 'center', color: '#ffcf8a' });
      x.strokeStyle = '#9dff3d'; x.strokeRect(134.5, 126.5, 212, 12); x.fillStyle = '#9dff3d'; x.fillRect(136, 128, 209 * Math.min(1, g.dl), 9);
    }
    if (g.state === 'won') {
      const k = Math.sin(t * 8) * 0.5 + 0.5;
      text(x, 'HACK THE PLANET', W / 2 + (g.glitch ? (Math.random() - 0.5) * 10 : 0), 78, { size: 32, title: true, align: 'center', color: k > 0.5 ? '#ff4fd8' : '#3ff0ff', shadow: '#000' });
      text(x, `${g.t.toFixed(1)}s  ${g.msg}`, W / 2, 166, { align: 'center', color: '#9dff3d', shadow: '#000' }); text(x, 'space: hack again', W / 2, 182, { align: 'center', color: '#c8c0d8', shadow: '#000' });
    }
    if (g.state === 'lost') { x.fillStyle = 'rgba(30,0,10,0.75)'; x.fillRect(100, 100, 280, 60); text(x, 'TRACE COMPLETE. BUSTED.', W / 2, 124, { title: true, align: 'center', color: '#ff6b6b' }); text(x, 'space: hack again', W / 2, 146, { align: 'center', color: '#c8c0d8' }); }
    if (g.glitch > 0) { for (let i = 0; i < 6; i++) { const y = Math.random() * H; x.fillStyle = i % 2 ? `rgba(255,79,216,${g.glitch * 0.5})` : `rgba(63,240,255,${g.glitch * 0.5})`; x.fillRect(0, y, W, 2 + Math.random() * 8); } x.fillStyle = `rgba(255,255,255,${g.glitch * 0.25})`; x.fillRect(0, 0, W, H); }
    scan(x, W, H);
  });
}
