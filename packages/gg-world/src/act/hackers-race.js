// @ts-check
// SLIPSTREAM: a pseudo-3D night-road racer cabinet (homage to the club race scene). Dodge traffic, grab boost
// arrows, distance = score. Local top-5 table with your handle (HANDLE.EXE). GX rebuild: the arcade picture stays
// pixel art (320x180) but is shown at an integer scale with smoothing off, inside a black-and-chrome cabinet bezel
// with pink/teal neon trim; all text (distance, speed, high scores) is the kit's Sora UI.
import { SFX } from '../sfx.js';
import { loop, keys, rng } from './util.js';
import { gx, GX } from './gx.js';
import { load, save, handle } from './hackers-util.js';

const W = 320, H = 180, HOR = 70;
const CSS = `.sr-cab{position:absolute;inset:0;border-radius:22px;background:linear-gradient(180deg,#24222c,#121118 70%,#0b0a10);box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 0 0 1px rgba(255,255,255,.05),0 30px 70px -24px #000,-14px 0 40px -18px ${GX.pink},14px 0 40px -18px ${GX.teal}}
.sr-cab:before{content:'SLIPSTREAM';position:absolute;left:0;right:0;top:1.4cqh;text-align:center;font:800 3.6cqh/1 'Sora',sans-serif;letter-spacing:.5em;color:#ffd9f3;text-shadow:0 0 8px ${GX.pink},0 0 22px ${GX.pink}}
.sr-bez{position:absolute;left:3.5cqw;right:3.5cqw;top:7cqh;bottom:4cqh;border-radius:14px;background:#050407;box-shadow:inset 0 0 0 2px #2c2a33,inset 0 0 30px #000;display:grid;place-items:center;overflow:hidden}
.sr-bez canvas{image-rendering:pixelated;display:block;border-radius:6px;box-shadow:0 0 40px -6px rgba(255,79,216,.35)}
.sr-bez:after{content:'';position:absolute;inset:0;pointer-events:none;background:linear-gradient(160deg,rgba(255,255,255,.08),transparent 30%)}
.sr-tb{margin:14px auto 0;width:100%;max-width:300px;display:grid;gap:4px;font-size:13px;font-variant-numeric:tabular-nums;text-align:left}
.sr-tb div{display:flex;justify-content:space-between;padding:6px 10px;border-radius:8px;background:${GX.s2}}.sr-tb div.me{background:rgba(255,95,210,.22);color:#fff}.sr-tb div:first-child b{color:${GX.warning}}`;

/** @param {any} ctx */
export function startRace(ctx) {
  const ov = ctx.overlay({ title: 'SLIPSTREAM', sub: 'insert coin. mess with the best.', help: '<kbd>←→</kbd> steer <kbd>↑</kbd> throttle <kbd>space</kbd> start <kbd>mouse</kbd> steer <kbd>hold click</kbd> throttle' });
  const Kx = gx(ov), K = keys(ov);
  const table0 = load('cyb-race-top', []);
  const hud = Kx.hud([{ id: 'dist', label: 'Distance', value: '0 m', tone: 'up' }, { id: 'spd', label: 'km/h', value: 0, tone: 'gold' }], [{ id: 'top', label: 'Record', value: table0[0] ? `${table0[0].s} m` : '--', tone: 'pink' }]);
  const scene = Kx.scene({ aspect: 16 / 10.4, maxW: 1200 });
  const st0 = document.createElement('style'); st0.textContent = CSS; scene.appendChild(st0);
  const cab = document.createElement('div'); cab.className = 'sr-cab'; cab.innerHTML = '<div class="sr-bez"><canvas></canvas></div>'; scene.appendChild(cab);
  const bez = /** @type {HTMLElement} */ (cab.querySelector('.sr-bez')), c = /** @type {HTMLCanvasElement} */ (cab.querySelector('canvas'));
  c.width = W; c.height = H; const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')); x.imageSmoothingEnabled = false;
  // crisp: integer device-pixel scale of the 320x180 picture
  const fit = () => { const d = devicePixelRatio || 1, k = Math.max(1, Math.floor(Math.min(bez.clientWidth * d / W, bez.clientHeight * d / H))); c.style.width = (W * k / d) + 'px'; c.style.height = (H * k / d) + 'px'; };
  const ro = new ResizeObserver(fit); ro.observe(bez); ov.onClose(() => ro.disconnect()); fit();
  let me = handle(ctx.S), seed = 1;
  /** @type {any} */ let g;
  const reset = state => { me = handle(ctx.S); g = { state, lane: 0, spd: 0, dist: 0, z: 0, cars: [], next: 1, shake: 0, flash: 0, r: rng(seed++ * 977 + Date.now() % 1000), rank: -1, table: load('cyb-race-top', []) }; };
  reset('title');
  ctx.R.hackersDbg = { ...(ctx.R.hackersDbg || {}), race: () => g }; ov.onClose(() => { if (ctx.R.hackersDbg) delete ctx.R.hackersDbg.race; });
  const start = () => { reset('play'); SFX.play('arcade.coin'); SFX.play('go', { delay: 0.25 }); };
  // mouse: the pointer steers (bike heads for the pointer's x at the normal steer rate), hold the button to throttle
  const ms = { x: -1, down: false };
  const mx = e => { const r = c.getBoundingClientRect(); return (e.clientX - r.left) / r.width * W; };
  const pm = e => { ms.x = mx(e); }, pd = e => { if (e.button !== 0) return; e.preventDefault(); ms.x = mx(e); if (g.state === 'play') ms.down = true; }, pu = () => { ms.down = false; }, pl = () => { ms.x = -1; ms.down = false; };
  cab.addEventListener('pointermove', pm); cab.addEventListener('pointerdown', pd); addEventListener('pointerup', pu); cab.addEventListener('pointerleave', pl);
  ov.onClose(() => removeEventListener('pointerup', pu));
  const tableHTML = (tb, rank) => '<div class="sr-tb">' + Array.from({ length: 5 }, (_, i) => { const e = tb[i]; return `<div class="${i === rank ? 'me' : ''}"><span>${i + 1}. ${e ? String(e.n).replace(/[<>&]/g, '') : '---'}</span><b>${e ? e.s + ' m' : ''}</b></div>`; }).join('') + '</div>';
  const over = () => {
    const sc = Math.floor(g.dist), res = Kx.result({ title: g.rank === 0 ? 'New record' : 'Wipeout', big: `${sc} m`, line: g.rank >= 0 ? `${me} made the table at #${g.rank + 1}.` : `${me}, not this time.`, again: 'Race again', onAgain: start });
    const acts = res.el.querySelector('.acts'); acts?.insertAdjacentHTML('beforebegin', tableHTML(g.table, g.rank));
    if (g.rank === 0) Kx.swell();
    hud.set('top', g.table[0] ? `${g.table[0].s} m` : '--');
  };
  const proj = (lx, z) => { const s = 1 / (z * 0.02 + 1), y = HOR + (H - HOR) * s; return { x: W / 2 + lx * 140 * s - g.lane * 140 * s, y, s }; };
  // static sky cached once (gradient, stars, banded sun, skyline)
  const sky = document.createElement('canvas'); sky.width = W; sky.height = HOR; { const s = /** @type {CanvasRenderingContext2D} */ (sky.getContext('2d'));
    let gr = s.createLinearGradient(0, 0, 0, HOR); gr.addColorStop(0, '#07061a'); gr.addColorStop(0.7, '#2a0f44'); gr.addColorStop(1, '#5a1a62'); s.fillStyle = gr; s.fillRect(0, 0, W, HOR);
    let r = 9; const rnd = () => (r = (r * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < 50; i++) { s.fillStyle = `rgba(255,255,255,${0.2 + rnd() * 0.5})`; s.fillRect(Math.floor(rnd() * W), Math.floor(rnd() * HOR * 0.7), 1, 1); }
    gr = s.createLinearGradient(0, HOR - 34, 0, HOR); gr.addColorStop(0, '#ffd56a'); gr.addColorStop(1, '#ff4fd8'); s.fillStyle = gr; s.beginPath(); s.arc(W / 2, HOR, 34, Math.PI, 0); s.fill();
    s.fillStyle = '#2a0f44'; for (let k = 0; k < 5; k++) s.fillRect(W / 2 - 34, HOR - 3 - k * 5 - k * k * 0.4, 68, 1 + k * 0.5); }
  let shown = 0, hudT = 0;
  loop(ov, (dt, t) => {
    if (g.state === 'play') {
      let steer = (K.has('ArrowRight') ? 1 : 0) - (K.has('ArrowLeft') ? 1 : 0);
      if (!steer && ms.x >= 0) { const want = Math.max(-1.1, Math.min(1.1, (ms.x - W / 2) / 140)), d = want - g.lane; steer = Math.abs(d) < 0.03 ? 0 : Math.max(-1, Math.min(1, d / (dt * 1.8))); }
      g.lane = Math.max(-1.1, Math.min(1.1, g.lane + steer * dt * 1.8));
      const top = 60 + g.dist / 120; g.spd += ((K.has('ArrowUp') || K.has('Space') || ms.down ? top : top * 0.6) - g.spd) * dt * 0.8;
      g.dist += g.spd * dt; g.z += g.spd * dt;
      g.next -= dt; if (g.next <= 0) { g.next = Math.max(0.35, 1.2 - g.dist / 4000) * (0.6 + g.r() * 0.8); const boost = g.r() < 0.18; g.cars.push({ lx: [-0.75, 0, 0.75][Math.floor(g.r() * 3)], z: 120, c: ['#ff4fd8', '#3ff0ff', '#f5d33a', '#9dff3d'][Math.floor(g.r() * 4)], boost }); }
      for (const car of g.cars) { car.z -= (g.spd - (car.boost ? 0 : 25)) * dt * 0.6;
        if (car.z < 3 && car.z > -1 && Math.abs(car.lx - g.lane) < 0.38 && !car.hit) { car.hit = true;
          const r = c.getBoundingClientRect();
          if (car.boost) { g.spd += 30; g.flash = 0.5; Kx.pop(r.left + r.width / 2, r.top + r.height * 0.75, 'Boost', 'up'); SFX.play('arcade.jump'); SFX.play('whoosh', { vol: 0.6 }); }
          else { g.state = 'over'; g.shake = 0.6; g.flash = 1; SFX.play('arcade.boom');
            const sc = Math.floor(g.dist); const tb = g.table.concat([{ n: me, s: sc }]).sort((a, b) => b.s - a.s).slice(0, 5); g.rank = tb.findIndex(e => e.n === me && e.s === sc); g.table = tb; save('cyb-race-top', tb); SFX.play(g.rank === 0 ? 'win' : g.rank >= 0 ? 'score' : 'fail', { delay: 0.4 });
            setTimeout(() => { if (ov.el.isConnected) over(); }, 900); } } }
      g.cars = g.cars.filter(car => car.z > -4 && !(car.hit && car.boost));
    }
    g.shake = Math.max(0, g.shake - dt); g.flash = Math.max(0, g.flash - dt * 2);
    shown += (g.dist - shown) * Math.min(1, dt * 10); hudT -= dt; if (hudT <= 0) { hudT = 0.1; hud.set('dist', Math.floor(shown) + ' m'); hud.set('spd', Math.floor(g.spd * 2)); }
    x.save(); if (g.shake) x.translate(Math.round(Math.sin(t * 90) * 4 * g.shake), 0);
    x.drawImage(sky, 0, 0);
    for (let i = 0; i < 24; i++) { const bw = 10 + (i * 7) % 9, bh = 10 + (i * 13) % 28, bx = Math.round((i * 15 - g.lane * 10) % (W + 20) - 10); x.fillStyle = '#140c24'; x.fillRect(bx, HOR - bh, bw, bh); x.fillStyle = '#3ff0ff'; if (i % 3 === 0) x.fillRect(bx + 3, HOR - bh + 4, 2, 2); }
    x.fillStyle = '#120a1c'; x.fillRect(0, HOR, W, H - HOR); x.fillStyle = '#ff4fd8'; x.fillRect(0, HOR, W, 1);
    for (let k = 0; k < 40; k++) { const z0 = k * 3 - (g.z % 6), a = proj(-1.4, z0), b = proj(-1.4, z0 + 3), c2 = proj(1.4, z0), d = proj(1.4, z0 + 3); if (z0 < 0) continue;
      x.fillStyle = (Math.floor((k * 3 + g.z - (g.z % 6)) / 3) % 2) ? '#221a34' : '#1c1630'; x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(c2.x, c2.y); x.lineTo(d.x, d.y); x.lineTo(b.x, b.y); x.fill();
      if (k % 2 === 0) for (const lx of [-0.375, 0.375]) { const p = proj(lx, z0); x.fillStyle = '#ffcf8a'; x.fillRect(p.x - 1, p.y - 1, Math.max(1, 3 * p.s), Math.max(1, 2 * p.s)); }
      for (const lx of [-1.4, 1.4]) { const p = proj(lx, z0); x.fillStyle = k % 2 ? '#3ff0ff' : '#ff4fd8'; x.fillRect(p.x - 2 * p.s, p.y - 1, 4 * p.s, 2 * p.s + 1); } }
    for (const car of [...g.cars].sort((a, b) => b.z - a.z)) { if (car.z < 0) continue; const p = proj(car.lx, car.z), w = 46 * p.s, h = 20 * p.s;
      if (car.boost) { x.fillStyle = '#9dff3d'; x.beginPath(); x.moveTo(p.x, p.y - h * 1.4); x.lineTo(p.x + w * 0.4, p.y - h * 0.4); x.lineTo(p.x - w * 0.4, p.y - h * 0.4); x.fill(); continue; }
      x.fillStyle = car.c; x.fillRect(p.x - w / 2, p.y - h, w, h); x.fillStyle = '#0b0a16'; x.fillRect(p.x - w * 0.35, p.y - h * 0.9, w * 0.7, h * 0.35); x.fillStyle = '#ff3a3a'; x.fillRect(p.x - w / 2, p.y - h * 0.4, w * 0.15, h * 0.15); x.fillRect(p.x + w * 0.35, p.y - h * 0.4, w * 0.15, h * 0.15); }
    const by = H - 18, lean = ((K.has('ArrowRight') ? 1 : 0) - (K.has('ArrowLeft') ? 1 : 0)) * 2, M = W / 2;
    x.fillStyle = 'rgba(63,240,255,0.18)'; x.fillRect(M - 18, by - 2, 36, 10); x.fillStyle = 'rgba(0,0,0,0.5)'; x.fillRect(M - 13, by + 5, 26, 3);
    x.fillStyle = '#0b0a16'; x.fillRect(M - 4, by - 2, 8, 9); x.fillStyle = '#ff3a5a'; x.fillRect(M - 3, by + 4, 6, 2);
    x.fillStyle = '#5fe6f5'; x.beginPath(); x.moveTo(M - 9 + lean, by + 1); x.lineTo(M - 6 + lean, by - 10); x.lineTo(M + 6 + lean, by - 10); x.lineTo(M + 9 + lean, by + 1); x.fill();
    x.fillStyle = '#e8e0f8'; x.fillRect(M - 3 + lean * 1.5, by - 18, 6, 7); x.fillStyle = '#ff4fd8'; x.fillRect(M - 3 + lean * 1.5, by - 15, 6, 2); x.fillStyle = '#fff'; x.fillRect(M - 5 + lean, by - 10, 10, 1);
    x.restore();
    if (g.flash) { x.fillStyle = `rgba(255,255,255,${g.flash * 0.4})`; x.fillRect(0, 0, W, H); }
    if (g.state === 'title') { x.fillStyle = 'rgba(5,3,14,0.45)'; x.fillRect(0, 0, W, H); }
  });
  const c0 = Kx.card({ title: 'SLIPSTREAM', kicker: 'Insert coin', text: 'Dodge the traffic, grab the green boost arrows. Distance is your score; the top five go on the board.', how: [[['←', '→'], 'steer'], [['↑'], 'throttle'], [['Mouse'], 'steer, hold to throttle']], cta: 'Insert coin', onGo: start });
  c0.el.querySelector('.acts')?.insertAdjacentHTML('beforebegin', tableHTML(table0, -1));
}
