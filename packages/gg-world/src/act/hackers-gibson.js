// @ts-check
// Hack the Gibson: fly through the neon data city (a tiny three.js scene: translucent code towers, grid, fog) and
// find the garbage file before the trace closes in. Scanner pings hotter as you near it. On find: download bar,
// glitch flash, HACK THE PLANET banner. Best time saved; first win of the day pays coins.
import { SFX } from '../sfx.js';
import { loop, rng, keys, coins } from './util.js';
import { PAL, panel, title, glow, badge, banner, particles, shaker, rr } from './art.js';
import { scan, load, save, today, howTo, btns } from './hackers-util.js';
import { gibsonScene } from './hackers-gibson-scene.js';

const W = 480, H = 270, GW = 30, GH = 24, TRACE = 75, PAY = 5, DL = 2.2;

/** @param {any} ctx */
export function startGibson(ctx) {
  const { S } = ctx; ctx.R.hackers?.fire('gibson');
  const ov = ctx.overlay({ title: 'Hack the Gibson', sub: 'find the garbage file', help: '<kbd>←→</kbd> turn <kbd>↑↓</kbd> fly <kbd>space</kbd> boost <kbd>hold click</kbd> fly, pointer turns <kbd>esc</kbd> jack out' });
  const day = today(); let tries = 0;
  /** @type {any} */ let g = null; /** @type {any} */ let sc = null;
  const hud = ov.canvas(W, H); const x = hud.x; x.imageSmoothingEnabled = false;
  hud.c.style.position = 'absolute'; hud.c.style.left = '0'; hud.c.style.top = '0'; hud.c.style.boxShadow = 'none';
  const K = keys(ov); const fx = particles(), sh = shaker(), B2 = btns(hud.c, W, H); let endT = 0, introT = 0;
  const reset = () => {
    const r = rng(day * 13 + tries++ * 101); const tow = new Uint8Array(GW * GH);
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) tow[j * GW + i] = (i % 3 && j % 3 && r() < 0.85) ? 1 + Math.floor(r() * 4) : 0;
    let fi, fj; do { fi = 2 + Math.floor(r() * (GW - 4)); fj = 2 + Math.floor(r() * (GH - 4)); } while (tow[fj * GW + fi] || Math.hypot(fi - 1, fj - 1) < 14);
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) tow[j * GW + i] = 0;
    sc?.dispose(); sc = gibsonScene(tow, GW, GH, fi, fj);
    const c = sc.canvas; c.style.imageRendering = 'pixelated'; c.style.display = 'block'; c.style.borderRadius = '6px'; hud.c.before(c);
    endT = 0; introT = 0; g = { tow, fi, fj, px: 0.5, pz: 0.5, yaw: 0.25, t: 0, state: 'play', ping: 0, pings: [], best: load('cyb-gibson-best', 0), msg: '', dl: 0, glitch: 0, bob: 0, wonT: 0 };
    ctx.R.hackersDbg = { ...(ctx.R.hackersDbg || {}), gibson: () => g };
  };
  reset();
  ov.onClose(() => { sc?.dispose(); sc = null; if (ctx.R.hackersDbg) delete ctx.R.hackersDbg.gibson; });
  const solid = (px, pz) => { const i = Math.floor(px), j = Math.floor(pz); return i < 0 || j < 0 || i >= GW || j >= GH || g.tow[j * GW + i] > 0; };
  const again = () => { reset(); SFX.play('pc.boot', { vol: 0.6 }); };
  const onKey = e => { if (e.code === 'Space' && (g.state === 'won' || g.state === 'lost')) { e.preventDefault(); again(); } };
  // mouse: hold the button to fly forward; while held, the pointer's offset from centre turns (same max turn rate as
  // the keys). Click to hack again after a win / bust.
  const ms = { x: W / 2, down: false };
  const mx = e => { const r = hud.c.getBoundingClientRect(); return (e.clientX - r.left) / r.width * W; };
  const pm = e => { ms.x = mx(e); }, pd = e => { if (e.button !== 0) return; e.preventDefault(); ms.x = mx(e); if (g.state === 'won' || g.state === 'lost') again(); else ms.down = true; }, pu = () => { ms.down = false; };
  hud.c.addEventListener('pointermove', pm); hud.c.addEventListener('pointerdown', pd); addEventListener('pointerup', pu); hud.c.addEventListener('pointerleave', pu);
  ov.onClose(() => { hud.c.removeEventListener('pointermove', pm); hud.c.removeEventListener('pointerdown', pd); removeEventListener('pointerup', pu); hud.c.removeEventListener('pointerleave', pu); });
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  loop(ov, (dt, t) => {
    if (!sc) return;
    sc.canvas.style.width = hud.c.style.width; sc.canvas.style.height = hud.c.style.height;
    const d = Math.hypot(g.px - g.fi - 0.5, g.pz - g.fj - 0.5), near = Math.max(0, 1 - d / 14);
    if (g.state === 'play') {
      g.t += dt;
      let turn = (K.has('ArrowRight') || K.has('KeyD') ? 1 : 0) - (K.has('ArrowLeft') || K.has('KeyA') ? 1 : 0);
      if (!turn && ms.down) { const o = (ms.x - W / 2) / (W * 0.3); turn = Math.abs(o) < 0.08 ? 0 : Math.max(-1, Math.min(1, o)); }
      g.yaw += turn * dt * 2.2;
      const mv = ((K.has('ArrowUp') || K.has('KeyW') || ms.down ? 1 : 0) - (K.has('ArrowDown') || K.has('KeyS') ? 0.6 : 0)) * (K.has('Space') ? 4.2 : 2.6) * dt;
      const nx = g.px + Math.cos(g.yaw) * mv, nz = g.pz + Math.sin(g.yaw) * mv;
      if (!solid(nx, g.pz)) g.px = nx; if (!solid(g.px, nz)) g.pz = nz; g.bob += Math.abs(mv);
      g.ping -= dt; if (g.ping <= 0) { g.ping = Math.max(0.18, d / 10); g.pings.push({ a: 1, hot: near }); SFX.play('ping', { vol: 0.15 + near * 0.35, pitch: 0.7 + near * 0.7 }); }
      if (d < 0.75) { g.state = 'dl'; g.dl = 0; SFX.play('magic'); SFX.play('typewriter', { delay: 0.2, vol: 0.5 }); }
      if (g.t > TRACE - 10 && Math.floor(g.t) !== Math.floor(g.t - dt)) SFX.play('countdown', { vol: 0.5 });
      if (g.t >= TRACE) { g.state = 'lost'; g.glitch = 0.8; sh.kick(8); SFX.play('static'); SFX.play('fail', { delay: 0.2 }); }
    } else if (g.state === 'dl') {
      g.dl += dt / DL; g.t += dt * 0.0; if (Math.random() < dt * 0.2) g.glitch = 0.25; // rare glitch event (was ~5x per second)
      if (g.dl >= 1) { g.state = 'won'; g.glitch = 1; fx.confetti(W); fx.burst(W / 2, H / 2, { n: 50, colors: ['#ff4fd8', '#3ff0ff', '#9dff3d'], speed: 120 }); SFX.play('win'); SFX.play('zap', { vol: 0.5 }); const tm = Math.round(g.t * 10) / 10;
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
    // HUD (art kit): trace meter, timer badges, radar scanner, download card, results
    x.clearRect(0, 0, W, H); introT += dt; if (g.state === 'won' || g.state === 'lost') endT += dt;
    x.save(); sh.apply(x, dt);
    const v = x.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, W * 0.7); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(10,0,20,0.55)'); x.fillStyle = v; x.fillRect(0, 0, W, H);
    const tr = Math.min(1, g.t / TRACE), hotT = tr > 0.75;
    const tp = panel(x, 8, 8, 236, 34, { style: 'neon', r: 3 });
    title(x, 'TRACE', tp.x + 8, tp.y + 14, { size: 16, body: true, align: 'left', color: '#ff9ad8' });
    x.fillStyle = '#0a0414'; rr(x, tp.x + 8, tp.y + 19, tp.w - 16, 9, 2); x.fill();
    const tg = x.createLinearGradient(tp.x + 8, 0, tp.x + tp.w - 8, 0); tg.addColorStop(0, '#ff4fd8'); tg.addColorStop(1, '#ff3a5a'); x.fillStyle = hotT ? (0.5 + 0.5 * Math.sin(t * 5) > 0.5 ? '#ff3a5a' : '#ff9a3a') : tg;
    rr(x, tp.x + 8, tp.y + 19, Math.max(4, (tp.w - 16) * tr), 9, 2); x.fill(); x.fillStyle = 'rgba(255,255,255,0.35)'; x.fillRect(tp.x + 9, tp.y + 20, Math.max(2, (tp.w - 18) * tr), 1);
    title(x, Math.ceil(TRACE - g.t) + 's left', tp.x + tp.w - 8, tp.y + 14, { size: 16, body: true, align: 'right', color: hotT ? PAL.red : PAL.cream });
    badge(x, W - 162, 8, 'time', g.t.toFixed(1) + 's', { w: 76, color: '#9dff3d', style: 'neon' }); badge(x, W - 82, 8, 'best', g.best ? g.best.toFixed(1) + 's' : '--', { w: 74, color: '#3ff0ff', style: 'neon' });
    if (g.state === 'play' || g.state === 'dl') {
      const sx = 48, sy = H - 48; x.fillStyle = 'rgba(0,0,0,0.45)'; x.beginPath(); x.arc(sx + 2, sy + 4, 38, 0, 7); x.fill();
      const rg = x.createRadialGradient(sx, sy, 2, sx, sy, 36); rg.addColorStop(0, '#0c2a14'); rg.addColorStop(1, '#040c08'); x.fillStyle = rg; x.beginPath(); x.arc(sx, sy, 36, 0, 7); x.fill();
      x.strokeStyle = '#9dff3d'; x.lineWidth = 2; x.globalAlpha = 0.9; x.beginPath(); x.arc(sx, sy, 36, 0, 7); x.stroke(); x.lineWidth = 1; x.globalAlpha = 0.25; x.beginPath(); x.arc(sx, sy, 24, 0, 7); x.moveTo(sx - 36, sy); x.lineTo(sx + 36, sy); x.moveTo(sx, sy - 36); x.lineTo(sx, sy + 36); x.stroke(); x.globalAlpha = 1;
      for (const p of g.pings) { x.strokeStyle = `rgba(157,255,61,${p.a})`; x.beginPath(); x.arc(sx, sy, 36 * (1 - p.a), 0, 7); x.stroke(); }
      const ang = Math.atan2(g.fj + 0.5 - g.pz, g.fi + 0.5 - g.px) - g.yaw - Math.PI / 2, hc = near > 0.7 ? '#ffcf8a' : '#9dff3d';
      x.save(); x.translate(sx, sy); x.rotate(ang); x.fillStyle = hc; x.shadowColor = hc; x.shadowBlur = 8; x.beginPath(); x.moveTo(0, -30); x.lineTo(7, -16); x.lineTo(-7, -16); x.fill(); x.restore();
      glow(x, sx, sy, 40, hc, 0.12 + near * 0.3);
      title(x, d.toFixed(1), sx, sy + 5, { size: 16, body: true, color: '#eaffd0' });
      const heat = near > 0.8 ? 'HOT' : near > 0.5 ? 'WARM' : 'COLD'; title(x, heat, sx + 46, sy + 30, { size: 16, align: 'left', color: near > 0.8 ? '#ffcf8a' : near > 0.5 ? '#e0e070' : '#6aa8c8', glow: near > 0.8 ? '#ff9a3a' : undefined });
      if (g.state === 'play' && introT < 4) { x.globalAlpha = Math.min(1, (4 - introT) * 1.5); const ip = panel(x, W / 2 - 150, H - 58, 300, 46, { style: 'glass' });
        title(x, 'Find the garbage file before the trace.', W / 2, ip.y + 17, { size: 16, body: true, color: '#ffcf8a' }); howTo(x, W, ip.y + 37, [['←→', 'turn'], ['↑', 'fly'], ['space', 'boost'], ['hold click', 'fly']]); x.globalAlpha = 1; }
    }
    if (tr > 0.6 && g.state === 'play') { x.fillStyle = `rgba(255,30,60,${(tr - 0.6) * 0.6 * (0.6 + 0.4 * Math.sin(t * 4))})`; x.fillRect(0, 0, W, 5); x.fillRect(0, H - 5, W, 5); x.fillRect(0, 0, 5, H); x.fillRect(W - 5, 0, 5, H); }
    if (g.state === 'dl') { const dp = panel(x, W / 2 - 120, 96, 240, 52, { style: 'crt' });
      title(x, 'DOWNLOADING garbage.dat', W / 2, dp.y + 18, { size: 16, body: true, color: '#ffcf8a', ink: '#020a04' });
      x.fillStyle = '#031006'; rr(x, dp.x + 12, dp.y + 26, dp.w - 24, 14, 2); x.fill(); x.fillStyle = '#9dff3d'; for (let k = 0; k < Math.floor((dp.w - 28) / 6 * Math.min(1, g.dl)); k++) x.fillRect(dp.x + 14 + k * 6, dp.y + 28, 5, 10);
      glow(x, W / 2, dp.y + 33, 90, '#9dff3d', 0.15); }
    fx.draw(x, dt);
    x.restore();
    if (g.state === 'won' || g.state === 'lost') { const won = g.state === 'won';
      if (endT < 1.5) banner(x, W, H, won ? 'HACK THE PLANET' : 'BUSTED', won ? `${g.t.toFixed(1)}s ${g.msg}` : 'trace complete', endT, { color: won ? '#ff4fd8' : PAL.red });
      else { const rp = panel(x, W / 2 - 110, 74, 220, 122, { style: 'neon' });
        title(x, won ? 'garbage.dat COPIED' : 'TRACE COMPLETE', W / 2, rp.y + 24, { size: 16, color: won ? '#9dff3d' : PAL.red, glow: won ? '#9dff3d' : PAL.red, glowR: 8 });
        badge(x, rp.x + 22, rp.y + 36, 'time', won ? g.t.toFixed(1) + 's' : '--', { w: 84, color: '#9dff3d' }); badge(x, rp.x + rp.w - 106, rp.y + 36, 'best', g.best ? g.best.toFixed(1) + 's' : '--', { w: 84, color: '#3ff0ff' });
        if (g.msg && won) title(x, g.msg.trim(), W / 2, rp.y + 86, { size: 16, body: true, color: PAL.gold });
        B2.draw(x, W / 2 - 50, rp.y + 96, 100, 20, 'HACK AGAIN', { primary: true }); } }
    scan(x, W, H);
  });
}
