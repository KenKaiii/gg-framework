// @ts-check
// TV activities: 'tv-watch' (sit on a TV-facing seat, camera over the shoulder, channel-surf in a big TV overlay) and
// 'den-crt' (the den CRT's "Change the game": a playable retro platformer close-up).
import { setView, clearView, hideOccluders, worldOf } from './view.js';
import { sitPlayer } from './sit.js';
import { keys, loop } from './util.js';
import { makeTV } from './tv-screen.js';
import { startWindow } from './tv-window.js';
import { CHANNELS } from './tv-channels.js';
import { makePlatformer } from './tv-plat.js';
import { SFX } from '../sfx.js';

/** Screen centre (room-local), camera direction from the screen toward the seat (+ up), set type. */
const TVS = {
  studio: { at: [-6.05, 1.15, 2.5], dir: { x: 1, y: 0.5, z: 0.3 }, zoom: 1.35, kind: 'flat', name: 'studio big screen' },
  den: { at: [-2.22, 1.13, -5.24], dir: { x: 0.3, y: 0.5, z: 1 }, zoom: 1.2, kind: 'crt', name: 'den CRT' },
  bedroom: { at: [-4.3, 0.9, -3.03], dir: { x: 1, y: 0.55, z: 0.3 }, zoom: 1.15, kind: 'crt', name: 'bedroom CRT' },
};
const BLEND = 700;

/** Shared: camera on the set, overlay hidden until the blend is done, then shown over a dimmed room. */
function openSet(ctx, cfg, o) {
  const { S, R } = ctx;
  setView(S, { target: worldOf(R, cfg.at[0], cfg.at[1], cfg.at[2]), dir: cfg.dir, zoom: cfg.zoom }); hideOccluders(S);
  const ov = ctx.overlay(o); ov.onClose(() => clearView(S));
  const fix = () => ov.stage.querySelectorAll('canvas').forEach(c => { c.style.boxShadow = 'none'; c.style.borderRadius = '0'; }); requestAnimationFrame(fix);
  ov.el.style.background = 'transparent'; ov.stage.style.opacity = '0';
  const tm = setTimeout(() => { ov.el.style.transition = 'background-color .4s'; ov.el.style.background = 'rgba(6,6,10,.5)'; ov.stage.style.transition = 'opacity .35s'; ov.stage.style.opacity = '1'; }, BLEND);
  ov.onClose(() => clearTimeout(tm));
  return ov;
}

const watch = {
  id: 'tv-watch', label: () => 'Watch TV',
  match: (it, R) => it.kind === 'seat' && it.act === 'tv-watch' && !!TVS[R.id],
  start(ctx) {
    const { S, R, it } = ctx, cfg = TVS[R.id];
    const stand = sitPlayer(S, R, it.slot);
    const ov = openSet(ctx, cfg, { title: 'Watch TV', sub: cfg.name + ' · ' + CHANNELS[0].name, help: '<kbd>&larr;</kbd><kbd>&rarr;</kbd> or click: channel &nbsp; <kbd>esc</kbd> stand up' });
    ov.onClose(stand);
    const tv = makeTV(cfg.kind), { c, x } = ov.canvas(tv.CW, tv.CH);
    let ch = 0, changed = -9, t0 = 0;
    const zap = d => { ch = (ch + d + CHANNELS.length) % CHANNELS.length; changed = t0; SFX.play('static', { vol: 0.25 }); SFX.play('blip', { vol: 0.3, delay: 0.25 }); ov.setSub(cfg.name + ' · ' + (ch + 1) + ' ' + CHANNELS[ch].name); };
    const kd = e => { if (e.code === 'ArrowRight' || e.code === 'ArrowUp') { e.preventDefault(); zap(1); } else if (e.code === 'ArrowLeft' || e.code === 'ArrowDown') { e.preventDefault(); zap(-1); } };
    addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd));
    c.style.cursor = 'pointer'; c.addEventListener('click', e => { const r = c.getBoundingClientRect(); zap(e.clientX - r.left < r.width / 2 ? -1 : 1); });
    loop(ov, (dt, t) => {
      t0 = t; const since = t - changed;
      tv.b.imageSmoothingEnabled = false; CHANNELS[ch].draw(tv.b, tv.W, tv.H, t, S);
      tv.present(x, t, { ch: ch + 1, osd: 2.2 - since, stat: since < 0.35 ? 1 - since / 0.5 : 0, glow: CHANNELS[ch].glow, shake: since < 0.2 ? 4 : 0 });
    });
  },
};

const denCrt = {
  id: 'den-crt',
  match: (it, R) => R.id === 'den' && it.id === 'tv',
  start(ctx) {
    const cfg = { ...TVS.den, dir: { x: 0.1, y: 0.25, z: 1 }, zoom: 0.8 };
    const ov = openSet(ctx, cfg, { title: 'Super Commit Bros', sub: 'den CRT · level 1-2 · grab the coins, reach the flag', help: '<kbd>&larr;</kbd><kbd>&rarr;</kbd> run &nbsp; <kbd>space</kbd>/<kbd>click</kbd> jump &nbsp; <kbd>esc</kbd> leave' });
    SFX.play('crt.on', { vol: 0.5 }); const tv = makeTV('crt'), { c, x } = ov.canvas(tv.CW, tv.CH), k = keys(ov), game = makePlatformer();
    // mouse: hold click = jump (space)
    c.addEventListener('pointerdown', e => { if (e.button === 0) { e.preventDefault(); k.add('Space'); c.setPointerCapture?.(e.pointerId); } }); const up = () => k.delete('Space'); c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    let start = -1;
    loop(ov, (dt, t) => {
      if (start < 0) start = t; const age = t - start;
      if (age > BLEND / 1000) game.step(dt, k);
      tv.b.imageSmoothingEnabled = false; game.draw(tv.b, t);
      tv.present(x, t, { ch: 3, osd: 0, stat: age < 1 ? 1 - age : 0, glow: '#7fc8ff' });
    });
  },
};

const lookOut = { id: 'tv-window', label: () => 'Look outside', match: (it, R) => (R?.id === 'den' || R?.id === 'bedroom') && it?.id === 'window', start: startWindow };
export default [watch, denCrt, lookOut];
