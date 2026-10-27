// @ts-check
// Screening Room activity 'cinema': sit on a tagged seat, the camera settles behind the rows framing the big screen,
// and the screen plays procedural parody trailers (screening-films.js). Left/right or click skips; Esc stands up.
import { makeHi } from './hires.js';
import { setView, clearView, hideOccluders, worldOf } from './view.js';
import { sitPlayer } from './sit.js';
import { loop } from './util.js';
import { gx, svg as S, GX } from './gx.js';
import { FONT } from '../fonts.js';
import { FILMS } from './screening-films.js';
import { moment } from './films-b-fx.js';
import { SFX } from '../sfx.js';

const W = 320, H = 136, BLEND = 700;

const CSS = `
.scr-room{position:absolute;inset:0;font-family:${FONT.app}}
.scr-room>svg{position:absolute;inset:0;width:100%;height:100%}
.scr-film{position:absolute;left:8.5%;top:5%;width:83%;height:auto;aspect-ratio:${W}/${H};border-radius:3px;box-shadow:0 0 60px 4px rgba(160,180,255,.18),0 0 0 2px rgba(0,0,0,.6)}
.scr-bar{position:absolute;left:8.5%;right:8.5%;bottom:3%;display:flex;align-items:center;gap:12px}
.scr-bar .gx-btn{flex:none}
.scr-mid{flex:1;min-width:0;text-align:center}
.scr-mid b{display:block;font-size:clamp(14px,3.4cqh,22px);line-height:1.2;font-weight:700;letter-spacing:-.01em;color:${GX.warning};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 0 18px rgba(240,199,94,.35)}
.scr-mid small{display:block;margin-top:2px;font-size:12px;line-height:1.3;color:${GX.muted};font-variant-numeric:tabular-nums}
.scr-prog{position:absolute;left:8.5%;right:8.5%;top:73.3%;height:3px;border-radius:2px;background:rgba(255,255,255,.08);overflow:hidden}
.scr-prog i{display:block;height:100%;width:100%;background:${GX.warning};transform-origin:left;transform:scaleX(0)}
`;

const cinema = {
  id: 'cinema', label: () => 'Watch the film',
  match: (it, R) => R.id === 'screening' && it.kind === 'seat' && it.act === 'cinema',
  /** @param {any} ctx */
  start(ctx) {
    const { S: St, R, it } = ctx;
    const stand = sitPlayer(St, R, it.slot);
    setView(St, { target: worldOf(R, 0, 1.55, -5.4), dir: { x: 0, y: 0.32, z: 1 }, zoom: 2.3 }); hideOccluders(St);
    const ov = ctx.overlay({ title: 'The Screening Room', sub: 'Now showing', help: '<kbd>&larr;</kbd><kbd>&rarr;</kbd> or click prev / next: change trailer' });
    ov.onClose(() => clearView(St)); ov.onClose(stand);
    if (!document.getElementById('scr-css')) { const st = document.createElement('style'); st.id = 'scr-css'; st.textContent = CSS; document.head.appendChild(st); }
    const K = gx(ov), scene = K.scene({ aspect: 1.9, lamp: false });
    scene.style.opacity = '0'; scene.style.transition = 'opacity .35s';
    const tm = setTimeout(() => { scene.style.opacity = '1'; }, BLEND); ov.onClose(() => clearTimeout(tm));
    const room = document.createElement('div'); room.className = 'scr-room'; scene.appendChild(room);
    // the auditorium: velvet curtains with folds, a valance and a gilt frame (SVG, drawn once)
    const v = S('svg', { viewBox: '0 0 1900 1000', preserveAspectRatio: 'none' }, room);
    v.innerHTML = `<defs>
      <linearGradient id="scr-fold" x1="0" x2="1"><stop offset="0" stop-color="#3c0a12"/><stop offset=".25" stop-color="#8e1a2a"/><stop offset=".5" stop-color="#5a0e19"/><stop offset=".75" stop-color="#a42236"/><stop offset="1" stop-color="#400b14"/></linearGradient>
      <pattern id="scr-vel" width="70" height="1000" patternUnits="userSpaceOnUse"><rect width="70" height="1000" fill="url(#scr-fold)"/></pattern>
      <linearGradient id="scr-shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".1"/><stop offset=".7" stop-color="#000" stop-opacity=".15"/><stop offset="1" stop-color="#000" stop-opacity=".7"/></linearGradient>
      <linearGradient id="scr-gilt" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f7dc8f"/><stop offset=".5" stop-color="#a87a2c"/><stop offset="1" stop-color="#f0c75e"/></linearGradient>
      <filter id="scr-nap"><feTurbulence type="fractalNoise" baseFrequency=".9 .02" numOctaves="2" seed="3"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .25 0"/><feComposite in2="SourceGraphic" operator="in"/></filter></defs>
      <rect x="0" y="0" width="1900" height="1000" rx="18" fill="#0b090d" opacity=".72"/>
      <g><rect x="0" y="0" width="160" height="1000" fill="url(#scr-vel)"/><rect x="1740" y="0" width="160" height="1000" fill="url(#scr-vel)"/>
      <rect x="0" y="0" width="160" height="1000" fill="#000" filter="url(#scr-nap)"/><rect x="1740" y="0" width="160" height="1000" fill="#000" filter="url(#scr-nap)"/>
      <rect x="0" y="0" width="160" height="1000" fill="url(#scr-shade)"/><rect x="1740" y="0" width="160" height="1000" fill="url(#scr-shade)"/></g>
      <path d="M0 0H1900V34Q1805 62 1710 34Q1615 62 1520 34Q1425 62 1330 34Q1235 62 1140 34Q1045 62 950 34Q855 62 760 34Q665 62 570 34Q475 62 380 34Q285 62 190 34Q95 62 0 34Z" fill="url(#scr-vel)"/>
      <path d="M0 34Q95 62 190 34Q285 62 380 34Q475 62 570 34Q665 62 760 34Q855 62 950 34Q1045 62 1140 34Q1235 62 1330 34Q1425 62 1520 34Q1615 62 1710 34Q1805 62 1900 34" fill="none" stroke="url(#scr-gilt)" stroke-width="4"/>
      <rect x="153" y="38" width="1594" height="684" fill="none" stroke="url(#scr-gilt)" stroke-width="8" rx="4"/>`;
    const film = document.createElement('canvas'); film.className = 'scr-film'; makeHi(film, W, H); room.appendChild(film);
    const fx = /** @type {CanvasRenderingContext2D} */ (film.getContext('2d'));
    const prog = document.createElement('div'); prog.className = 'scr-prog'; prog.innerHTML = '<i></i>'; room.appendChild(prog);
    const progI = /** @type {HTMLElement} */ (prog.firstChild);
    const bar = document.createElement('div'); bar.className = 'scr-bar';
    bar.innerHTML = `<button class="gx-btn" type="button">&larr; Prev</button><div class="scr-mid"><b></b><small></small></div><button class="gx-btn pri" type="button">Next &rarr;</button>`;
    room.appendChild(bar);
    const [prevB, nextB] = bar.querySelectorAll('button'), nameEl = /** @type {HTMLElement} */ (bar.querySelector('b')), numEl = /** @type {HTMLElement} */ (bar.querySelector('small'));
    let i = 0, t0 = -1, now = 0, cut = -9; const lt0 = t => t - t0;
    const label = () => { nameEl.textContent = FILMS[i].name; numEl.textContent = `Trailer ${i + 1} of ${FILMS.length}`; };
    const go = d => { i = (i + d + FILMS.length) % FILMS.length; t0 = now; cut = now; label(); ov.setSub('Now showing · ' + FILMS[i].name); const sp = worldOf(R, 0, 0, -5.4); SFX.play('static', { vol: 0.35, at: sp }); SFX.play('scr.reel', { delay: 0.12, at: sp }); SFX.play('blip', { delay: 0.3, vol: 0.5 }); };
    label();
    const kd = e => { if (e.code === 'ArrowRight' || e.code === 'ArrowUp') { e.preventDefault(); go(1); } else if (e.code === 'ArrowLeft' || e.code === 'ArrowDown') { e.preventDefault(); go(-1); } };
    addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd));
    prevB.addEventListener('click', () => go(-1)); nextB.addEventListener('click', () => go(1));
    film.style.cursor = 'pointer'; film.addEventListener('click', e => { const r = film.getBoundingClientRect(); go(e.clientX - r.left < r.width / 2 ? -1 : 1); });
    let dd = -1; SFX.play('scr.reel', { delay: 0.3 }); SFX.play('hum', { vol: 0.3, delay: 0.5 });
    loop(ov, (dt, t) => {
      now = t; if (t0 < 0) t0 = t;
      if (FILMS[i].name === 'JAWZ' && lt0(t) < 8.2) { const b = Math.floor(lt0(t) / Math.max(0.6, 1.4 - lt0(t) * 0.12)); if (b !== dd) { dd = b; SFX.play('scr.duhdum', { vol: 0.5, pitch: 1 + Math.min(0.2, lt0(t) * 0.02) }); } } else dd = -1; const lt = t - t0; if (lt > FILMS[i].dur) go(1);
      fx.imageSmoothingEnabled = false; FILMS[i].draw(fx, W, H, t - t0);
      // projector feel: a slow warm breath, dust specks, a light burst on cuts
      const fl = 0.05 + 0.02 * Math.sin(t * 2.2); fx.fillStyle = `rgba(255,230,190,${fl})`; fx.fillRect(0, 0, W, H);
      for (let k = 0; k < 4; k++) { fx.fillStyle = 'rgba(20,14,10,.5)'; fx.fillRect((Math.sin(t * 0.9 + k * 13) * 0.5 + 0.5) * W, (Math.cos(t * 0.7 + k * 7) * 0.5 + 0.5) * H, 1, 1); }
      const burst = Math.max(0, 1 - (t - cut) / 0.3); if (burst) { fx.fillStyle = `rgba(255,240,210,${burst * 0.8})`; fx.fillRect(0, 0, W, H); }
      progI.style.transform = `scaleX(${Math.min(1, lt / FILMS[i].dur)})`;
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
