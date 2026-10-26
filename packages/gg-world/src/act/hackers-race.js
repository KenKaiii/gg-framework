// @ts-check
// SLIPSTREAM: a pseudo-3D night-road racer cabinet (homage to the club race scene). Dodge traffic, grab boost
// arrows, distance = score. Local top-5 table with your handle (HANDLE.EXE).
import { SFX } from '../sfx.js';
import { loop, keys, rng } from './util.js';
import { PAL, panel, title, glow, badge, banner, particles, shaker, shine } from './art.js';
import { scan, load, save, handle, neonBg, howTo, btns } from './hackers-util.js';

const W = 320, H = 180, HOR = 70;

/** @param {any} ctx */
export function startRace(ctx) {
  const ov = ctx.overlay({ title: 'SLIPSTREAM', sub: 'insert coin. mess with the best.', help: '<kbd>←→</kbd> steer <kbd>↑</kbd> throttle <kbd>space</kbd> start <kbd>mouse</kbd> steer <kbd>hold click</kbd> throttle <kbd>esc</kbd> leave' });
  const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false; const K = keys(ov);
  let me = handle(ctx.S), seed = 1;
  /** @type {any} */ let g;
  const reset = state => { me = handle(ctx.S); g = { state, lane: 0, spd: 0, dist: 0, z: 0, cars: [], next: 1, shake: 0, flash: 0, r: rng(seed++ * 977 + Date.now() % 1000), rank: -1, table: load('cyb-race-top', []) }; };
  reset('title');
  const bg = neonBg(W, HOR + 1, '#ff4fd8', 1), fx = particles(), sh = shaker(), B2 = btns(c, W, H); let overT = 0, distShown = 0;
  ctx.R.hackersDbg = { ...(ctx.R.hackersDbg || {}), race: () => g }; ov.onClose(() => { if (ctx.R.hackersDbg) delete ctx.R.hackersDbg.race; });
  const start = () => { reset('play'); SFX.play('arcade.coin'); SFX.play('go', { delay: 0.25 }); };
  const onKey = e => { if (e.code === 'Space' && g.state !== 'play') { e.preventDefault(); start(); } };
  // mouse: the pointer steers (bike heads for the pointer's x at the normal steer rate), hold the button to throttle,
  // click to start / race again
  const ms = { x: -1, down: false };
  const mx = e => { const r = c.getBoundingClientRect(); return (e.clientX - r.left) / r.width * W; };
  const pm = e => { ms.x = mx(e); }, pd = e => { if (e.button !== 0) return; e.preventDefault(); ms.x = mx(e); if (g.state !== 'play') start(); else ms.down = true; }, pu = () => { ms.down = false; }, pl = () => { ms.x = -1; ms.down = false; };
  c.addEventListener('pointermove', pm); c.addEventListener('pointerdown', pd); addEventListener('pointerup', pu); c.addEventListener('pointerleave', pl);
  ov.onClose(() => { c.removeEventListener('pointermove', pm); c.removeEventListener('pointerdown', pd); removeEventListener('pointerup', pu); c.removeEventListener('pointerleave', pl); });
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  const proj = (lx, z) => { const s = 1 / (z * 0.02 + 1), y = HOR + (H - HOR) * s; return { x: W / 2 + lx * 140 * s - g.lane * 140 * s, y, s }; };
  loop(ov, (dt, t) => {
    if (g.state === 'play') {
      let steer = (K.has('ArrowRight') ? 1 : 0) - (K.has('ArrowLeft') ? 1 : 0);
      if (!steer && ms.x >= 0) { const want = Math.max(-1.1, Math.min(1.1, (ms.x - W / 2) / 140)), d = want - g.lane; steer = Math.abs(d) < 0.03 ? 0 : Math.max(-1, Math.min(1, d / (dt * 1.8))); }
      g.lane = Math.max(-1.1, Math.min(1.1, g.lane + steer * dt * 1.8));
      const top = 60 + g.dist / 120; g.spd += ((K.has('ArrowUp') || K.has('Space') || ms.down ? top : top * 0.6) - g.spd) * dt * 0.8;
      g.dist += g.spd * dt; g.z += g.spd * dt;
      g.next -= dt; if (g.next <= 0) { g.next = Math.max(0.35, 1.2 - g.dist / 4000) * (0.6 + g.r() * 0.8); const boost = g.r() < 0.18; g.cars.push({ lx: [-0.75, 0, 0.75][Math.floor(g.r() * 3)], z: 120, c: ['#ff4fd8', '#3ff0ff', '#f5d33a', '#9dff3d'][Math.floor(g.r() * 4)], boost }); }
      for (const c of g.cars) { c.z -= (g.spd - (c.boost ? 0 : 25)) * dt * 0.6;
        if (c.z < 3 && c.z > -1 && Math.abs(c.lx - g.lane) < 0.38 && !c.hit) { c.hit = true;
          if (c.boost) { g.spd += 30; g.flash = 0.5; fx.burst(W / 2, H - 24, { n: 20, colors: ['#9dff3d', '#eaffd0'] }); SFX.play('arcade.jump'); SFX.play('whoosh', { vol: 0.6 }); } else { g.state = 'over'; g.shake = 0.6; g.flash = 1; overT = 0; sh.kick(7); fx.burst(W / 2, H - 20, { n: 40, colors: ['#ff4fd8', '#ffcf8a', '#fff'], speed: 110 }); SFX.play('arcade.boom');
            const sc = Math.floor(g.dist); const tb = g.table.concat([{ n: me, s: sc }]).sort((a, b) => b.s - a.s).slice(0, 5); g.rank = tb.findIndex(e => e.n === me && e.s === sc); g.table = tb; save('cyb-race-top', tb); SFX.play(g.rank === 0 ? 'win' : g.rank >= 0 ? 'score' : 'fail', { delay: 0.4 }); } } }
      g.cars = g.cars.filter(c => c.z > -4 && !(c.hit && c.boost));
    }
    g.shake = Math.max(0, g.shake - dt); g.flash = Math.max(0, g.flash - dt * 2);
    overT += dt; distShown += (g.dist - distShown) * Math.min(1, dt * 10);
    x.save(); sh.apply(x, dt); if (g.shake) x.translate(Math.round(Math.sin(t * 90) * 4 * g.shake), 0);
    // sky + city skyline
    x.save(); x.beginPath(); x.rect(0, 0, W, HOR); x.clip(); bg.draw(x, 0); x.restore();
    for (let i = 0; i < 24; i++) { const bw = 10 + (i * 7) % 9, bh = 10 + (i * 13) % 28, bx = (i * 15 - g.lane * 10) % (W + 20) - 10; x.fillStyle = '#140c24'; x.fillRect(bx, HOR - bh, bw, bh); x.fillStyle = '#3ff0ff'; if (i % 3 === 0) x.fillRect(bx + 3, HOR - bh + 4, 2, 2); }
    x.fillStyle = '#120a1c'; x.fillRect(0, HOR, W, H - HOR);
    // road stripes
    for (let k = 0; k < 40; k++) { const z0 = k * 3 - (g.z % 6), a = proj(-1.4, z0), b = proj(-1.4, z0 + 3), c2 = proj(1.4, z0), d = proj(1.4, z0 + 3); if (z0 < 0) continue;
      x.fillStyle = (Math.floor((k * 3 + g.z - (g.z % 6)) / 3) % 2) ? '#221a34' : '#1c1630'; x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(c2.x, c2.y); x.lineTo(d.x, d.y); x.lineTo(b.x, b.y); x.fill();
      if (k % 2 === 0) for (const lx of [-0.375, 0.375]) { const p = proj(lx, z0); x.fillStyle = '#ffcf8a'; x.fillRect(p.x - 1, p.y - 1, Math.max(1, 3 * p.s), Math.max(1, 2 * p.s)); }
      for (const lx of [-1.4, 1.4]) { const p = proj(lx, z0); x.fillStyle = k % 2 ? '#3ff0ff' : '#ff4fd8'; x.fillRect(p.x - 2 * p.s, p.y - 1, 4 * p.s, 2 * p.s + 1); } }
    // traffic (far first)
    for (const c of [...g.cars].sort((a, b) => b.z - a.z)) { if (c.z < 0) continue; const p = proj(c.lx, c.z), w = 46 * p.s, h = 20 * p.s;
      if (c.boost) { x.fillStyle = '#9dff3d'; x.beginPath(); x.moveTo(p.x, p.y - h * 1.4); x.lineTo(p.x + w * 0.4, p.y - h * 0.4); x.lineTo(p.x - w * 0.4, p.y - h * 0.4); x.fill(); continue; }
      x.fillStyle = c.c; x.fillRect(p.x - w / 2, p.y - h, w, h); x.fillStyle = '#0b0a16'; x.fillRect(p.x - w * 0.35, p.y - h * 0.9, w * 0.7, h * 0.35); x.fillStyle = '#ff3a3a'; x.fillRect(p.x - w / 2, p.y - h * 0.4, w * 0.15, h * 0.15); x.fillRect(p.x + w * 0.35, p.y - h * 0.4, w * 0.15, h * 0.15); }
    // player bike (racing blades homage: a sleek neon bike)
    const by = H - 18, lean = Math.round((ms.x >= 0 || K.has('ArrowLeft') || K.has('ArrowRight') ? ((K.has('ArrowRight') ? 1 : 0) - (K.has('ArrowLeft') ? 1 : 0)) : 0) * 2);
    glow(x, W / 2, by + 4, 26, '#3ff0ff', 0.35); x.fillStyle = 'rgba(0,0,0,0.5)'; x.beginPath(); x.ellipse(W / 2, by + 6, 14, 3, 0, 0, 7); x.fill();
    x.fillStyle = '#0b0a16'; x.fillRect(W / 2 - 4, by - 2, 8, 9); x.fillStyle = '#ff3a5a'; x.fillRect(W / 2 - 3, by + 4, 6, 2); glow(x, W / 2, by + 5, 10, '#ff3a5a', 0.6);
    const bk = x.createLinearGradient(0, by - 12, 0, by + 2); bk.addColorStop(0, '#9ffcff'); bk.addColorStop(1, '#1a8aa8'); x.fillStyle = bk; x.beginPath(); x.moveTo(W / 2 - 9 + lean, by + 1); x.lineTo(W / 2 - 6 + lean, by - 10); x.lineTo(W / 2 + 6 + lean, by - 10); x.lineTo(W / 2 + 9 + lean, by + 1); x.fill();
    x.fillStyle = '#e8e0f8'; x.fillRect(W / 2 - 3 + lean * 1.5, by - 18, 6, 7); x.fillStyle = '#ff4fd8'; x.fillRect(W / 2 - 3 + lean * 1.5, by - 15, 6, 2); x.fillStyle = '#fff'; x.fillRect(W / 2 - 5 + lean, by - 10, 10, 1);
    fx.draw(x, dt);
    x.restore();
    if (g.flash) { x.fillStyle = `rgba(255,255,255,${g.flash * 0.4})`; x.fillRect(0, 0, W, H); }
    if (g.state === 'play') { badge(x, 6, 6, 'dist', Math.floor(distShown) + ' m', { w: 78, color: '#9dff3d' }); badge(x, W - 84, 6, 'km/h', Math.floor(g.spd * 2), { w: 78, color: PAL.gold }); }
    if (g.state !== 'play') { x.fillStyle = 'rgba(5,3,14,0.55)'; x.fillRect(0, 0, W, H);
      const p = panel(x, 56, 6, 208, 156, { style: 'neon' });
      title(x, g.state === 'title' ? 'SLIPSTREAM' : 'WIPEOUT', W / 2, 34, { size: 16, color: g.state === 'title' ? '#ff4fd8' : PAL.red, glow: '#ff4fd8', glowR: 8 });
      if (g.state === 'over') title(x, Math.floor(g.dist) + ' m', W / 2, 52, { size: 16, color: '#9dff3d' }); else title(x, 'HIGH SCORES', W / 2, 52, { size: 16, body: true, color: '#3ff0ff' });
      for (let i = 0; i < 5; i++) { const e = g.table[i], yy = 70 + i * 14, hl = i === g.rank; if (hl) { x.fillStyle = 'rgba(255,79,216,0.25)'; x.fillRect(p.x + 8, yy - 11, p.w - 16, 14); }
        title(x, `${i + 1}. ${e ? e.n : '---'}`, p.x + 14, yy, { size: 16, body: true, align: 'left', color: hl ? '#fff' : i === 0 ? PAL.gold : PAL.cream });
        title(x, e ? String(e.s) : '', p.x + p.w - 14, yy, { size: 16, body: true, align: 'right', color: hl ? '#fff' : '#9dff3d' }); }
      B2.draw(x, W / 2 - 50, 136, 100, 20, g.state === 'title' ? 'INSERT COIN' : 'RACE AGAIN', { primary: true }); shine(x, W / 2 - 50, 136, 100, 20, t * 0.5);
      if (g.state === 'title') howTo(x, W, 177, [['←→', 'steer'], ['↑', 'gas'], ['space', 'go']]);
      if (g.state === 'over' && overT < 1.4) banner(x, W, H, g.rank === 0 ? 'NEW RECORD' : 'WIPEOUT', `${me}  ${Math.floor(g.dist)} m`, overT, { color: g.rank === 0 ? PAL.gold : PAL.red });
    }
    scan(x, W, H);
  });
}
