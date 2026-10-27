// @ts-check
// Hack the Gibson: fly through the neon data city (a tiny three.js scene: translucent code towers, grid, fog) and
// find the garbage file before the trace closes in. Scanner pings hotter as you near it. On find: download bar,
// glitch flash, HACK THE PLANET banner. Best time saved; first win of the day pays coins.
import { SFX } from '../sfx.js';
import { loop, rng, keys, coins } from './util.js';
import { gx, GX } from './gx.js';
import { load, save, today } from './hackers-util.js';
import { gibsonScene } from './hackers-gibson-scene.js';

const W = 480, GW = 30, GH = 24, TRACE = 75, PAY = 5, DL = 2.2;
const CSS = `.gb-3d{position:absolute;inset:0;width:100%!important;height:100%!important;border-radius:14px;box-shadow:0 0 0 1px rgba(255,255,255,.08),0 30px 70px -24px #000,0 0 50px -16px ${GX.pink}}
.gb-ui{position:absolute;inset:0;pointer-events:none;font-family:'Sora',sans-serif}
.gb-radar{position:absolute;left:18px;bottom:18px;width:min(150px,22cqw);height:auto;filter:drop-shadow(0 6px 14px rgba(0,0,0,.6))}
.gb-trace{position:absolute;left:50%;top:16px;translate:-50% 0;width:min(360px,40cqw);height:8px;border-radius:4px;background:rgba(10,4,20,.7);box-shadow:0 0 0 1px rgba(255,255,255,.1)}.gb-trace i{display:block;height:100%;border-radius:4px;width:0}
.gb-edge{position:absolute;inset:0;border-radius:14px;box-shadow:inset 0 0 40px 6px rgba(255,30,60,.7);opacity:0;transition:opacity .4s}
.gb-dl{position:absolute;left:50%;top:50%;translate:-50% -50%;padding:14px 18px 16px;border-radius:12px;background:rgba(21,23,26,.82);backdrop-filter:blur(10px);box-shadow:0 0 0 1px rgba(255,255,255,.08);font-size:13px;color:${GX.text}}
.gb-dl .bar{margin-top:10px;width:240px;height:8px;border-radius:4px;background:${GX.s3}}.gb-dl .bar i{display:block;height:100%;border-radius:4px;background:${GX.success};width:0}`;
const RADAR = `<svg class="gb-radar" viewBox="-44 -44 88 104"><defs><radialGradient id="gb-rg"><stop offset="0" stop-color="#0c2a14"/><stop offset="1" stop-color="#040c08"/></radialGradient></defs>
<circle r="40" fill="url(#gb-rg)" stroke="#9dff3d" stroke-width="2"/><circle r="26" fill="none" stroke="#9dff3d" stroke-opacity=".25"/><path d="M-40 0H40M0 -40V40" stroke="#9dff3d" stroke-opacity=".25"/>
<circle class="ping" r="0" fill="none" stroke="#9dff3d" stroke-opacity="0"/><circle class="ping" r="0" fill="none" stroke="#9dff3d" stroke-opacity="0"/><circle class="ping" r="0" fill="none" stroke="#9dff3d" stroke-opacity="0"/>
<path class="arrow" d="M0 -33 L8 -18 L-8 -18Z" fill="#9dff3d"/><text class="dist" y="5" text-anchor="middle" font-family="Sora" font-weight="700" font-size="13" fill="#eaffd0">0</text>
<text class="heat" y="56" text-anchor="middle" font-family="Sora" font-weight="800" font-size="13" fill="#8fc8e8">Cold</text></svg>`;

/** @param {any} ctx */
export function startGibson(ctx) {
  const { S } = ctx; ctx.R.hackers?.fire('gibson');
  const ov = ctx.overlay({ title: 'Hack the Gibson', sub: 'find the garbage file', help: '<kbd>←→</kbd> turn <kbd>↑↓</kbd> fly <kbd>space</kbd> boost <kbd>hold click</kbd> fly, pointer turns' });
  let started = false;
  const day = today(); let tries = 0;
  /** @type {any} */ let g = null; /** @type {any} */ let sc = null;
  const K = keys(ov), X = gx(ov); let endT = 0, shown = false;
  const hud = X.hud([{ id: 'time', label: 'Time', value: '0.0s', tone: 'up' }, { id: 'best', label: 'Best', value: load('cyb-gibson-best', 0) ? load('cyb-gibson-best', 0).toFixed(1) + 's' : '--', tone: 'teal' }], [{ id: 'trace', label: 'Trace', value: TRACE + 's left', tone: 'pink' }]);
  const box = X.scene({ aspect: 16 / 9, lamp: false, maxW: 1500 });
  const st0 = document.createElement('style'); st0.textContent = CSS; box.appendChild(st0);
  const ui = document.createElement('div'); ui.className = 'gb-ui'; box.appendChild(ui);
  ui.innerHTML = RADAR + '<div class="gb-trace"><i></i></div><div class="gb-edge"></div><div class="gb-dl" hidden><b>Downloading garbage.dat</b><div class="bar"><i></i></div></div>';
  const $ = q => /** @type {HTMLElement} */ (ui.querySelector(q));
  const arrow = $('.arrow'), heat = $('.heat'), dist = $('.dist'), traceI = $('.gb-trace i'), edge = $('.gb-edge'), dlEl = $('.gb-dl'), dlI = $('.gb-dl i'), pingC = /** @type {any[]} */ ([...ui.querySelectorAll('.ping')]);
  const reset = () => {
    const r = rng(day * 13 + tries++ * 101); const tow = new Uint8Array(GW * GH);
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) tow[j * GW + i] = (i % 3 && j % 3 && r() < 0.85) ? 1 + Math.floor(r() * 4) : 0;
    let fi, fj; do { fi = 2 + Math.floor(r() * (GW - 4)); fj = 2 + Math.floor(r() * (GH - 4)); } while (tow[fj * GW + fi] || Math.hypot(fi - 1, fj - 1) < 14);
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) tow[j * GW + i] = 0;
    sc?.dispose(); sc = gibsonScene(tow, GW, GH, fi, fj);
    const c = sc.canvas; c.className = 'gb-3d'; box.insertBefore(c, ui); sc.fit(box.clientWidth || 960);
    endT = 0; shown = false; g = { tow, fi, fj, px: 0.5, pz: 0.5, yaw: 0.25, t: 0, state: started ? 'play' : 'ready', ping: 0, pings: [], best: load('cyb-gibson-best', 0), msg: '', dl: 0, glitch: 0, bob: 0, wonT: 0 };
    ctx.R.hackersDbg = { ...(ctx.R.hackersDbg || {}), gibson: () => g };
  };
  reset();
  ov.onClose(() => { sc?.dispose(); sc = null; if (ctx.R.hackersDbg) delete ctx.R.hackersDbg.gibson; });
  const solid = (px, pz) => { const i = Math.floor(px), j = Math.floor(pz); return i < 0 || j < 0 || i >= GW || j >= GH || g.tow[j * GW + i] > 0; };
  const again = () => { reset(); SFX.play('pc.boot', { vol: 0.6 }); };
  const onKey = () => {};
  // mouse: hold the button to fly forward; while held, the pointer's offset from centre turns (same max turn rate as
  // the keys). Click to hack again after a win / bust.
  const ms = { x: W / 2, down: false };
  const mx = e => { const r = box.getBoundingClientRect(); return (e.clientX - r.left) / r.width * W; };
  const pm = e => { ms.x = mx(e); }, pd = e => { if (e.button !== 0) return; e.preventDefault(); ms.x = mx(e); if (g.state === 'play' || g.state === 'dl') ms.down = true; }, pu = () => { ms.down = false; };
  box.addEventListener('pointermove', pm); box.addEventListener('pointerdown', pd); addEventListener('pointerup', pu); box.addEventListener('pointerleave', pu);
  ov.onClose(() => removeEventListener('pointerup', pu));
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  let hudT = 0;
  loop(ov, (dt, t) => {
    if (!sc) return;
    sc.fit(box.clientWidth || 960);
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
      if (g.t >= TRACE) { g.state = 'lost'; g.glitch = 0.8; SFX.play('static'); SFX.play('fail', { delay: 0.2 }); }
    } else if (g.state === 'dl') {
      g.dl += dt / DL; g.t += dt * 0.0; if (Math.random() < dt * 0.2) g.glitch = 0.25; // rare glitch event (was ~5x per second)
      if (g.dl >= 1) { g.state = 'won'; g.glitch = 1; X.swell(); SFX.play('win'); SFX.play('zap', { vol: 0.5 }); const tm = Math.round(g.t * 10) / 10;
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
    // HUD (GX kit): plates, a trace meter, the radar scanner (SVG), the download card, the result card
    hudT -= dt;
    if (hudT <= 0) { hudT = 0.1; const left = Math.max(0, Math.ceil(TRACE - g.t)); hud.set('time', g.t.toFixed(1) + 's'); hud.set('trace', left + 's left', { tone: left <= 15 ? 'bad' : 'pink' }); }
    const tr = Math.min(1, g.t / TRACE); traceI.style.width = (tr * 100) + '%'; traceI.style.background = tr > 0.8 ? GX.error : `linear-gradient(90deg,${GX.pink},#ff3a5a)`;
    edge.style.opacity = tr > 0.6 && g.state === 'play' ? String((tr - 0.6) * 2) : '0';
    const ang = (Math.atan2(g.fj + 0.5 - g.pz, g.fi + 0.5 - g.px) - g.yaw) * 180 / Math.PI + 90, hc = near > 0.7 ? '#ffcf8a' : '#9dff3d';
    arrow.setAttribute('transform', `rotate(${ang.toFixed(1)})`); arrow.setAttribute('fill', hc); dist.textContent = d.toFixed(1);
    heat.textContent = near > 0.8 ? 'Hot' : near > 0.5 ? 'Warm' : 'Cold'; heat.setAttribute('fill', near > 0.8 ? '#ffcf8a' : near > 0.5 ? '#e0e070' : '#8fc8e8');
    pingC.forEach((c, i) => { const p = g.pings[g.pings.length - 1 - i]; if (p) { c.setAttribute('r', String(36 * (1 - p.a))); c.setAttribute('stroke-opacity', String(p.a)); } else c.setAttribute('stroke-opacity', '0'); });
    dlEl.hidden = g.state !== 'dl'; if (g.state === 'dl') dlI.style.width = Math.min(100, g.dl * 100) + '%';
    if ((g.state === 'won' || g.state === 'lost') && !shown) { endT += dt; if (endT > 1.6) { shown = true; const won = g.state === 'won';
      X.result({ title: won ? 'Hack the planet' : 'Busted', big: won ? g.t.toFixed(1) + 's' : 'Trace complete', best: won && g.msg.startsWith('NEW BEST'), line: won ? 'garbage.dat copied.' + (g.msg.includes('coins') ? ` +${PAY} coins.` : '') : 'They traced you. Jack back in.',
        stats: [[won ? g.t.toFixed(1) + 's' : '--', 'Time'], [g.best ? g.best.toFixed(1) + 's' : '--', 'Best']], again: 'Hack again', onAgain: again });
      hud.set('best', g.best ? g.best.toFixed(1) + 's' : '--'); } }
  });
  X.card({ title: 'Hack the Gibson', text: `Fly the city of towers and find the garbage file before the trace completes (${TRACE}s). Follow the radar.`, how: [[['←', '→'], 'turn'], [['↑', '↓'], 'fly'], [['Space'], 'boost'], [['Hold click'], 'fly, pointer turns']], cta: 'Jack in', onGo: () => { started = true; g.state = 'play'; } });
}
