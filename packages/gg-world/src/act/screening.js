// @ts-check
// Screening Room activity 'cinema': sit on a tagged seat, the camera settles behind the rows framing the big screen,
// and the screen plays procedural parody trailers (screening-films.js). Left/right or click skips; Esc stands up.
import { setView, clearView, hideOccluders, worldOf } from './view.js';
import { sitPlayer } from './sit.js';
import { loop } from './util.js';
import { PAL, panel, button, title, glow, ease, clamp, noise } from './art.js';
import { FILMS } from './screening-films.js';
import { moment } from './films-b-fx.js';
import { SFX } from '../sfx.js';

const W = 320, H = 136, CW = 360, CH = 176, BLEND = 700;

/** Static auditorium frame (cached once): velvet curtains with folds and a gilt edge around the 320x136 screen. */
function auditorium() {
  const cv = document.createElement('canvas'); cv.width = CW; cv.height = CH; const x = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
  for (const side of [0, 1]) { const X0 = side ? CW - 24 : 0;
    for (let k = 0; k < 24; k++) { const f = Math.sin(k / 24 * Math.PI * 3), v = 0.5 + 0.5 * f; x.fillStyle = `rgb(${Math.round(70 + v * 90)},${Math.round(10 + v * 18)},${Math.round(20 + v * 20)})`; x.fillRect(X0 + k, 0, 1, CH); }
    const g = x.createLinearGradient(0, 120, 0, CH); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.6)'); x.fillStyle = g; x.fillRect(X0, 120, 24, CH - 120);
    x.fillStyle = PAL.goldD; for (let yy = 30; yy < CH; yy += 46) { x.fillRect(X0 + 4, yy, 16, 2); x.fillStyle = PAL.gold; x.fillRect(X0 + 4, yy, 16, 1); x.fillStyle = PAL.goldD; } }
  // valance across the top
  for (let k = 0; k < CW; k++) { const v = 0.5 + 0.5 * Math.sin(k / 10); x.fillStyle = `rgb(${Math.round(90 + v * 70)},16,28)`; x.fillRect(k, 0, 1, 5 + Math.round(v * 2)); }
  x.fillStyle = PAL.gold; x.fillRect(0, 6, CW, 1);
  // gilt edge around the screen
  x.strokeStyle = PAL.goldD; x.lineWidth = 2; x.strokeRect(19, 5, 322, 138); x.strokeStyle = 'rgba(255,232,160,0.5)'; x.lineWidth = 1; x.strokeRect(17.5, 3.5, 325, 141);
  noise(x, 0, 0, 24, CH, 0.05, 3); noise(x, CW - 24, 0, 24, CH, 0.05, 4); return cv;
}

const cinema = {
  id: 'cinema', label: () => 'Watch the film',
  match: (it, R) => R.id === 'screening' && it.kind === 'seat' && it.act === 'cinema',
  /** @param {any} ctx */
  start(ctx) {
    const { S, R, it } = ctx;
    const stand = sitPlayer(S, R, it.slot);
    setView(S, { target: worldOf(R, 0, 1.55, -5.4), dir: { x: 0, y: 0.32, z: 1 }, zoom: 2.3 }); hideOccluders(S);
    const ov = ctx.overlay({ title: 'The Screening Room', sub: 'Now showing', help: '<kbd>&larr;</kbd><kbd>&rarr;</kbd> or click prev / next: change trailer &nbsp; <kbd>esc</kbd> stand up' });
    ov.onClose(() => clearView(S)); ov.onClose(stand);
    const { c, x } = ov.canvas(CW, CH);
    c.style.boxShadow = 'none'; c.style.borderRadius = '0';
    ov.el.style.background = 'transparent'; ov.stage.style.opacity = '0';
    const tm = setTimeout(() => { ov.el.style.transition = 'background-color .4s'; ov.el.style.background = 'rgba(6,4,8,.45)'; ov.stage.style.transition = 'opacity .35s'; ov.stage.style.opacity = '1'; }, BLEND);
    ov.onClose(() => clearTimeout(tm));
    const film = document.createElement('canvas'); film.width = W; film.height = H; const fx = /** @type {CanvasRenderingContext2D} */ (film.getContext('2d'));
    let i = 0, t0 = -1, now = 0, cut = -9; const lt0 = t => t - t0;
    const go = d => { i = (i + d + FILMS.length) % FILMS.length; t0 = now; cut = now; ov.setSub('Now showing · ' + FILMS[i].name); const sp = worldOf(R, 0, 0, -5.4); SFX.play('static', { vol: 0.35, at: sp }); SFX.play('scr.reel', { delay: 0.12, at: sp }); SFX.play('blip', { delay: 0.3, vol: 0.5 }); };
    const kd = e => { if (e.code === 'ArrowRight' || e.code === 'ArrowUp') { e.preventDefault(); go(1); } else if (e.code === 'ArrowLeft' || e.code === 'ArrowDown') { e.preventDefault(); go(-1); } };
    addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd));
    let hov = -1; const frame = auditorium();
    c.addEventListener('pointermove', e => { const r = c.getBoundingClientRect(); hov = (e.clientX - r.left) / r.width < 0.5 ? 0 : 1; }); c.addEventListener('pointerleave', () => { hov = -1; });
    c.style.cursor = 'pointer'; c.addEventListener('click', e => { const r = c.getBoundingClientRect(); go(e.clientX - r.left < r.width / 2 ? -1 : 1); });
    let dd = -1; SFX.play('scr.reel', { delay: 0.3 }); SFX.play('hum', { vol: 0.3, delay: 0.5 });
    loop(ov, (dt, t) => {
      now = t; if (t0 < 0) t0 = t;
      if (FILMS[i].name === 'JAWZ' && lt0(t) < 8.2) { const b = Math.floor(lt0(t) / Math.max(0.6, 1.4 - lt0(t) * 0.12)); if (b !== dd) { dd = b; SFX.play('scr.duhdum', { vol: 0.5, pitch: 1 + Math.min(0.2, lt0(t) * 0.02) }); } } else dd = -1; const lt = t - t0; if (lt > FILMS[i].dur) go(1);
      fx.imageSmoothingEnabled = false; FILMS[i].draw(fx, W, H, t - t0);
      // projector feel: flicker, grain, dust specks, a light burst on cuts
      const fl = 0.04 + 0.04 * Math.sin(t * 47); fx.fillStyle = `rgba(255,230,190,${fl})`; fx.fillRect(0, 0, W, H);
      for (let k = 0; k < 6; k++) { fx.fillStyle = 'rgba(20,14,10,.6)'; fx.fillRect((Math.sin(t * 91 + k * 13) * 0.5 + 0.5) * W, (Math.cos(t * 73 + k * 7) * 0.5 + 0.5) * H, 1 + (k % 2), 1); }
      if (Math.sin(t * 3.3) > 0.97) { fx.fillStyle = 'rgba(30,20,10,.35)'; fx.fillRect((t * 1000) % W, 0, 1, H); }
      const burst = Math.max(0, 1 - (t - cut) / 0.3); if (burst) { fx.fillStyle = `rgba(255,240,210,${burst * 0.8})`; fx.fillRect(0, 0, W, H); }
      // frame: the auditorium (cached curtains + gilt frame), the film, a marquee strip with prev / next buttons
      x.imageSmoothingEnabled = false; x.clearRect(0, 0, CW, CH);
      glow(x, CW / 2, 74, 210, '#a0b4ff', 0.10 + burst * 0.2);
      x.drawImage(film, 20, 6); x.drawImage(frame, 0, 0);
      const k = ease.outBack(clamp((t - cut) / 0.35, 0, 1)), name = FILMS[i].name.toUpperCase();
      const m = panel(x, CW / 2 - 92, 148, 184, 24, { style: 'neon', r: 3 });
      for (let b = 0; b < 22; b++) { const on = (b + Math.floor(t * 3)) % 4 === 0; x.fillStyle = on ? PAL.goldHi : '#6a4a20'; x.fillRect(m.x + 6 + b * 8, m.y - 3, 2, 2); }
      x.save(); x.translate(CW / 2, 166); x.scale(k, k); title(x, name, 0, 0, { size: 16, color: PAL.gold, glow: PAL.gold, glowR: 6 }); x.restore();
      button(x, 22, 149, 46, 22, '< prev', { hot: hov === 0 }); button(x, CW - 68, 149, 46, 22, 'next >', { hot: hov === 1, primary: true });
      title(x, (i + 1) + '/' + FILMS.length, CW / 2 + 82, 164, { size: 16, body: true, align: 'right', color: PAL.dim });
      // reel progress under the film
      const pr = clamp(lt / FILMS[i].dur, 0, 1); x.fillStyle = 'rgba(0,0,0,0.6)'; x.fillRect(20, 143, 320, 2); x.fillStyle = PAL.gold; x.fillRect(20, 143, Math.round(320 * pr), 2);
    });
  },
};

const POSTERS = [['JAWZ', 'Just when you thought it was safe to push.'], ['DEPLOY ON FRIDAY', 'The pager rings from inside the house.'],
  ['REPO WARS', 'A long time ago, on a branch far, far away.'], ['THE MERGE', 'There is no main.']];
/** Poster wall: close-up on the two west posters, then the lobby card cycles through what's showing. */
const posters = {
  id: 'scr-posters', label: () => 'Read the posters',
  match: (it, R) => R.id === 'screening' && (it.id === 'posters' || it.id === 'posters-e'),
  /** @param {any} ctx */
  start(ctx) {
    const me = ctx.S.me?.root; if (me) me.visible = false; const east = ctx.it.x > 0, pair = east ? [2, 3] : [0, 1], x = east ? 6.2 : -6.2; let shown = -1;
    moment(ctx, { at: [x, 1.85, -5.7], dir: { x: 0, y: 0.5, z: 1 }, zoom: 1.0, walls: false, title: 'Now showing', line: '', secs: 6,
      tick: (dt, t, api) => { const k = t < 3 ? 0 : 1; if (k !== shown) { shown = k; const [n, tag] = POSTERS[pair[k]]; api.cap.set('Now showing: ' + n, tag); api.shake(0.02); SFX.play(k ? 'page' : 'sting', { vol: k ? 0.7 : 0.4 }); } }, end: () => { if (me) me.visible = true; } });
  },
};

export default [cinema, posters];
