// @ts-check
// Watching a TV plays the real thing (owner: "play youtubes rick roll for all of em"): Rick Astley, "Never Gonna Give
// You Up", in a big TV set over the room. The video comes from YouTube's privacy-enhanced player, framed through a tiny
// page on our World server (gg-royale apps/world-server src/tv.ts): YouTube refuses embeds without a Referer and the
// desktop app (tauri://localhost) sends none. The app's CSP allows that one origin in frame-src.
// Nothing loads until a player chooses to watch; closing the TV removes the player. While it plays, world sounds dip
// and the app radio pauses (it comes back on close). TVs that used to host an app keep it one click away.
// The player shows no YouTube controls (the /tv page sets controls=0 and keeps the mouse off it while it plays).
import { setView, clearView, hideOccluders, worldOf } from './view.js';
import { sitPlayer } from './sit.js';
import { TOP, bottomOf } from './overlay.js';
import { makeHi, crispFit } from './hires.js';
import { RADIO } from './radio.js';
import { tellApp, fromApp, EMBED } from '../bridge.js';
import { SFX } from '../sfx.js';

export const TV_PAGE = 'https://gg-world.buzzbeamaustralia.workers.dev/tv';
const TV_ORIGIN = new URL(TV_PAGE).origin;

/** Every TV: screen centre (room-local), camera direction from the screen toward the viewer, zoom, set style, and the
 * app that used to live on it (still reachable from the TV). */
const SETS = {
  studio: { at: [-6.05, 1.15, 2.5], dir: { x: 1, y: 0.5, z: 0.3 }, zoom: 1.35, kind: 'flat', name: 'studio big screen', alt: { label: 'The Chart', act: 'screens-chart' } },
  den: { at: [-2.22, 1.13, -5.24], dir: { x: 0.3, y: 0.5, z: 1 }, zoom: 1.2, kind: 'crt', name: 'den CRT', alt: { label: 'Super Commit Bros', act: 'den-crt' } },
  bedroom: { at: [-4.3, 0.9, -3.03], dir: { x: 1, y: 0.55, z: 0.3 }, zoom: 1.15, kind: 'crt', name: 'bedroom CRT' },
  bar: { at: [-8.3, 2.55, -5.3], dir: { x: 0.64, y: 0.1, z: 0.76 }, zoom: 1.0, kind: 'crt', name: 'bar TV', alt: { label: 'Deploy News', act: 'screens-deploy' } },
  fightclub: { at: [-9.6, 0.96, 4.66], dir: { x: 1, y: 0.3, z: 0.1 }, zoom: 0.9, kind: 'crt', name: 'the old TV' },
  hawkins: { at: [-6.57, 0.55, 2.72], dir: { x: 1, y: 0.35, z: 0.15 }, zoom: 1.0, kind: 'wood', name: 'the console TV' },
};
const BLEND = 600;

const CSS = `
.tvset{display:flex;flex-direction:column;align-items:center;gap:10px;font-family:Sora,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;color:#e8ebef;opacity:0;transform:translateY(8px);transition:opacity .35s,transform .35s}
.tvset.on{opacity:1;transform:none}
.tvset .tv-np{align-self:center;font-size:13px;line-height:1.3;font-weight:600;padding:4px 14px;border-radius:12px;background:rgba(20,14,18,.92);box-shadow:inset 0 0 0 1px rgba(255,214,170,.18),0 6px 18px rgba(0,0,0,.35);white-space:nowrap;max-width:calc(100vw - 32px);overflow:hidden;text-overflow:ellipsis}
.tvset .tv-np b{font-weight:normal;color:#ff6b7a;margin-right:10px}
.tvset .bezel{position:relative;box-sizing:content-box;box-shadow:0 22px 50px rgba(0,0,0,.55)}
.tvset .glass{position:relative;overflow:hidden;background:#000}
.tvset .glass iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}
.tvset .glass canvas{position:absolute;inset:0;width:100%;height:100%;transition:opacity .5s}
.tvset .glass canvas.gone{opacity:0;pointer-events:none}
.tvset .k-crt{background:linear-gradient(180deg,#d8cfbd,#b3a891 60%,#9c917b);border-radius:30px;box-shadow:inset 0 2px 0 rgba(255,255,255,.5),inset 0 -3px 0 rgba(0,0,0,.25),0 22px 50px rgba(0,0,0,.55)}
.tvset .k-crt .glass{border-radius:22px;box-shadow:0 0 0 6px #2a2622}
.tvset .k-flat{background:#0c0c11;border-radius:12px;box-shadow:inset 0 0 0 1px #2a2a36,0 22px 50px rgba(0,0,0,.55)}
.tvset .k-flat .glass{border-radius:3px}
.tvset .k-wood{background:repeating-linear-gradient(90deg,rgba(0,0,0,.08) 0 2px,transparent 2px 9px),linear-gradient(180deg,#7a4a2a,#5a341c 55%,#43260f);border-radius:18px;box-shadow:inset 0 2px 0 rgba(255,220,180,.25),0 22px 50px rgba(0,0,0,.55)}
.tvset .k-wood .glass{border-radius:16px;box-shadow:0 0 0 5px #1c140e}
.tvset .brand{position:absolute;left:0;right:0;text-align:center;font-size:16px;line-height:16px;color:rgba(40,30,20,.75);letter-spacing:2px}
.tvset .k-flat .brand{color:rgba(255,255,255,.28)} .tvset .k-wood .brand{color:rgba(255,220,170,.55)}
.tvset .row{display:flex;gap:10px}
.tvset button{font:600 13px/1.25 Sora,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;color:#e8ebef;background:#2c3035;border:0;border-radius:8px;padding:9px 18px 10px;cursor:pointer;box-shadow:0 3px 0 #8a5a22,0 8px 16px rgba(0,0,0,.35)}
.tvset button.ghost{color:#efe6d2;background:rgba(20,14,18,.92);box-shadow:inset 0 0 0 1px rgba(255,214,170,.25),0 6px 14px rgba(0,0,0,.35)}
.tvset button:hover{filter:brightness(1.08)}
`;

/**
 * Open the TV: camera onto the set, the video in a big TV over the room.
 * @param {any} ctx activity ctx @param {keyof typeof SETS} roomId @param {{ seated?: boolean }} [o]
 */
export function openTV(ctx, roomId, o = {}) {
  const { S, R } = ctx, cfg = SETS[roomId];
  if (!document.getElementById('tvset-css')) { const st = document.createElement('style'); st.id = 'tvset-css'; st.textContent = CSS; document.head.appendChild(st); }
  setView(S, { target: worldOf(R, cfg.at[0], cfg.at[1], cfg.at[2]), dir: cfg.dir, zoom: cfg.zoom }); hideOccluders(S);
  const ov = ctx.overlay({ title: 'Watch TV', sub: cfg.name, leave: o.seated ? 'Stand up' : 'Stop watching', help: cfg.alt && !o.seated ? '<kbd>c</kbd> change channel' : '' });
  ov.onClose(() => clearView(S));
  ov.el.style.background = 'transparent';
  const tm = setTimeout(() => { ov.el.style.transition = 'background-color .4s'; ov.el.style.background = 'rgba(6,6,10,.55)'; set.classList.add('on'); setTimeout(() => { if (!frame && tvN) tellApp({ t: 'tv-rect', n: tvN, rect: glassRect() }); }, 420); }, BLEND);
  ov.onClose(() => clearTimeout(tm));
  SFX.play('crt.on', { vol: 0.5 });

  // ---- the set ----
  const set = document.createElement('div'); set.className = 'tvset';
  const brand = { crt: 'GOLDSTAR', flat: 'VIBESONIC', wood: 'ZENITH-ish' }[cfg.kind] || '';
  set.innerHTML = `<div class="tv-np"><b>NOW PLAYING</b>Rick Astley - Never Gonna Give You Up</div><div class="bezel k-${cfg.kind}"><div class="glass"></div><div class="brand">${brand}</div></div><div class="row"></div>`;
  ov.stage.appendChild(set);
  const bezel = /** @type {HTMLElement} */ (set.querySelector('.bezel')), glass = /** @type {HTMLElement} */ (set.querySelector('.glass')), brandEl = /** @type {HTMLElement} */ (set.querySelector('.brand'));
  const np = /** @type {HTMLElement} */ (set.querySelector('.tv-np')), row = /** @type {HTMLElement} */ (set.querySelector('.row'));
  const help = /** @type {HTMLElement} */ (ov.el.querySelector('.help'));
  // Inside the app World is sealed (boot.js) and a sealed frame can't play YouTube, so the APP shows the video over
  // this glass (WorldScreen.tsx: 'tv' messages carry where the glass is). Standalone (tests) World frames it itself.
  const frame = EMBED ? null : document.createElement('iframe');
  if (frame) { frame.title = 'Rick Astley - Never Gonna Give You Up'; frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'; frame.referrerPolicy = 'strict-origin-when-cross-origin'; glass.appendChild(frame); }
  const glassRect = () => { const r = glass.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), radius: parseFloat(getComputedStyle(glass).borderTopLeftRadius) || 0 }; };
  let tvN = 0;
  // status screen over the glass until the player is up (tuning in / no signal)
  const sc = document.createElement('canvas'); glass.appendChild(sc); const SW = 480, SH = 270; const sx = makeHi(sc, SW, SH, 2);
  let state = 'tuning', t0 = performance.now();
  const drawStatus = () => {
    if (state === 'ready') return; const t = (performance.now() - t0) / 1000; sx.clearRect(0, 0, SW, SH);
    const g = sx.createLinearGradient(0, 0, 0, SH); g.addColorStop(0, '#15121c'); g.addColorStop(1, '#08070b'); sx.fillStyle = g; sx.fillRect(0, 0, SW, SH);
    sx.fillStyle = 'rgba(255,255,255,0.035)'; for (let y = (t * 12) % 4; y < SH; y += 4) sx.fillRect(0, y, SW, 1); // slow scanline drift
    sx.textAlign = 'center'; sx.textBaseline = 'middle';
    if (state === 'tuning') { sx.font = '600 22px Sora, sans-serif'; sx.fillStyle = '#e8ebef'; sx.fillText('Tuning in' + '...'.slice(0, 1 + (Math.floor(t / 0.5) % 3)), SW / 2, SH / 2); }
    else { sx.font = '700 26px Sora, sans-serif'; sx.fillStyle = '#ff7d70'; sx.fillText('No signal', SW / 2, SH / 2 - 14);
      sx.font = '500 14px Sora, sans-serif'; sx.fillStyle = '#c2c7ce'; sx.fillText('The TV needs internet to play.', SW / 2, SH / 2 + 16); }
  };
  const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Try again'; retry.style.display = 'none';
  const tune = () => { state = 'tuning'; t0 = performance.now(); sc.classList.remove('gone'); retry.style.display = 'none'; tvN++; if (frame) frame.src = TV_PAGE + '?t=' + Date.now(); else tellApp({ t: 'tv', open: true, n: tvN, rect: glassRect() }); clearTimeout(slow); slow = setTimeout(() => { if (state === 'tuning') { state = 'offline'; retry.style.display = ''; } }, navigator.onLine === false ? 600 : 12000); };
  let slow = 0;
  retry.addEventListener('click', tune); row.appendChild(retry);
  const hint = document.createElement('div'); hint.className = 'tv-np'; hint.textContent = 'Click the screen to play'; hint.style.display = 'none'; row.appendChild(hint);
  /** TV page events: from the TV page itself (standalone) or relayed by the app as { gg:'world', t:'tv-event', ev } */
  const onMsg = e => { let d = null;
    if (frame) { if (e.origin === TV_ORIGIN && e.source === frame.contentWindow && e.data?.gg === 'tv') d = e.data; }
    else if (fromApp(e) && e.data?.gg === 'world' && e.data.t === 'tv-event' && e.data.n === tvN && e.data.ev?.gg === 'tv') d = e.data.ev;
    if (!d) return; e = { data: d };
    if (e.data.t === 'ready') { state = 'ready'; clearTimeout(slow); sc.classList.add('gone'); }
    else if (e.data.t === 'blocked') { hint.style.display = ''; layout(); } // autoplay blocked: one click on the screen starts it
    else if (e.data.t === 'state' && e.data.s === 1) {
      if (hint.style.display !== 'none') { hint.style.display = 'none'; layout(); }
      // a click on the screen (autoplay fallback) moved keyboard focus into YouTube's frame: take it back so Esc / C work
      if (frame && document.activeElement === frame) { frame.blur(); /** @type {HTMLElement} */ (document.activeElement)?.blur?.(); window.focus(); }
    } };
  addEventListener('message', onMsg); ov.onClose(() => { removeEventListener('message', onMsg); clearTimeout(slow); if (frame) { frame.src = 'about:blank'; frame.remove(); } else tellApp({ t: 'tv', open: false }); });
  // change channel: back to the app this TV used to show
  const alt = cfg.alt && !o.seated ? cfg.alt : null;
  const toAlt = () => { if (!alt) return; const it = { ...ctx.it, id: 'tv-app' }, R0 = ctx.R, api = ctx.api; ctx.done(); setTimeout(() => S.act?.tryStart(it, R0, api), 0); };
  if (alt) { const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost'; b.textContent = 'Change channel: ' + alt.label; b.addEventListener('click', toAlt); row.appendChild(b); }
  const onKey = e => { if (e.code === 'KeyC' && alt) { e.preventDefault(); toAlt(); } };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));

  // ---- sound: world dips, app radio pauses while the TV plays ----
  SFX.duck?.(true); ov.onClose(() => SFX.duck?.(false));
  const radioWas = RADIO.state?.current || null; if (radioWas) tellApp({ t: 'radio-set', station: 'off' });
  ov.onClose(() => { if (radioWas) tellApp({ t: 'radio-set', station: radioWas }); });
  // leaving World (or hiding the window) must not leave a video playing in the background
  const watchPause = setInterval(() => { if (document.hidden || /** @type {any} */ (window).__game?.paused) ctx.done(); }, 400);
  ov.onClose(() => clearInterval(watchPause));

  // ---- layout: biggest 16:9 picture that fits between the app's buttons and the help bar, at any window size ----
  const layout = () => {
    const vw = innerWidth, vh = innerHeight, top = TOP(), bot = bottomOf(help);
    ov.el.style.padding = `${top}px 0 ${bot}px`; ov.el.style.boxSizing = 'border-box';
    const small = vw < 700 || vh < 480, bz = cfg.kind === 'flat' ? (small ? 6 : 10) : (small ? 14 : 26), brandH = cfg.kind === 'flat' ? 0 : (small ? 0 : 18);
    const extra = np.offsetHeight + (row.childElementCount && [...row.children].some(c => /** @type {HTMLElement} */ (c).style.display !== 'none') ? row.offsetHeight + 10 : 0) + 10;
    const availW = vw - 32 - bz * 2, availH = vh - top - bot - extra - bz * 2 - brandH - 8;
    const w = Math.max(160, Math.floor(Math.min(availW, availH * 16 / 9))), h = Math.round(w * 9 / 16);
    glass.style.width = w + 'px'; glass.style.height = h + 'px'; bezel.style.padding = `${bz}px ${bz}px ${bz + brandH}px`;
    brandEl.style.bottom = Math.max(2, (bz + brandH - 16) / 2) + 'px'; brandEl.style.display = brandH ? '' : 'none';
    /** @type {any} */ (sc).__rescale(Math.min(4, (w / SW) * (devicePixelRatio || 1))); void crispFit;
    if (!frame && tvN) requestAnimationFrame(() => tellApp({ t: 'tv-rect', n: tvN, rect: glassRect() }));
  };
  layout(); addEventListener('resize', layout); ov.onClose(() => removeEventListener('resize', layout)); requestAnimationFrame(layout);
  let raf = 0; const tick = () => { drawStatus(); raf = requestAnimationFrame(tick); }; tick(); ov.onClose(() => cancelAnimationFrame(raf));
  tune();
  return ov;
}

/** Any TV in the world (the room's TV hotspot). Sofas facing a TV start the same thing via tv-watch (tv.js). */
const watchTV = {
  id: 'tv-rickroll', label: () => 'Watch TV', sfx: false,
  match: (it, R) => it?.id === 'tv' && !!SETS[R?.id],
  start(ctx) { openTV(ctx, ctx.R.id); },
};

/** Sitting on a TV-facing seat: sit, then watch. @param {any} ctx */
export function watchSeated(ctx) {
  const { S, R, it } = ctx; const stand = sitPlayer(S, R, it.slot);
  const ov = openTV(ctx, R.id, { seated: true }); ov.onClose(stand);
}
export const hasTV = id => !!SETS[id];

export default [watchTV];
