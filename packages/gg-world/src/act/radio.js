// @ts-check
// The jukebox plays the GG Coder app's radio (owner: "the radios we have in the GG app, selectable via the jukebox,
// same stations; only plays locally for that user"). The app owns the player (the same app-wide radio as its title
// bar button), the game just shows the stations and asks the app to play / stop / change the volume:
//   game -> app: { gg:'world', t:'radio-get' } | { t:'radio-set', station: id | 'off' } | { t:'radio-volume', volume 0..100 }
//   app -> game: { gg:'world', t:'radio', stations:[{id,name,description}], current: id|null, volume }
// Standalone (no app) the jukeboxes keep their old in-world reaction (this activity doesn't match).
import { gx, svg as S, GX } from './gx.js';
import { FONT } from '../fonts.js';
import { EMBED, tellApp } from '../bridge.js';
import { SFX } from '../sfx.js';

/** latest radio state from the app (null until it answers) */
export const RADIO = { state: /** @type {null | { stations: {id:string,name:string,description:string}[], current: string|null, volume: number }} */ (null), listeners: new Set() };
const ascii = t => String(t).replace(/[\u00b7\u2022]/g, '-').replace(/[\u2013\u2014]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[^\x20-\x7e]/g, '');
/** app -> game */
export function onRadio(d) {
  if (!Array.isArray(d.stations)) return;
  const stations = d.stations.filter(s => s && typeof s.id === 'string' && typeof s.name === 'string').slice(0, 40)
    // the pixel font is ASCII: middle dots / dashes / curly quotes become plain ones
    .map(s => ({ id: s.id.slice(0, 60), name: ascii(s.name).slice(0, 40), description: ascii(String(s.description || '')).slice(0, 90) }));
  RADIO.state = { stations, current: typeof d.current === 'string' ? d.current : null, volume: Math.max(0, Math.min(100, Math.round(Number(d.volume) || 0))) };
  for (const f of RADIO.listeners) f();
}
/** ask the app for the stations once the game is up (and again when a jukebox opens, another window may have changed it) */
export const askRadio = () => tellApp({ t: 'radio-get' });

const CSS = `
.jb{position:absolute;inset:0;font-family:${FONT.app};color:${GX.text}}
.jb>svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.jb-face{position:absolute;left:15%;right:15%;top:24%;bottom:9%;display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:14px;background:rgba(14,12,20,.86);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),inset 0 0 0 1px rgba(255,255,255,.06),inset 0 10px 30px rgba(0,0,0,.6)}
.jb-now{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;background:${GX.s1};box-shadow:inset 0 1px 0 rgba(255,255,255,.07)}
.jb-now .l{font-size:11px;line-height:1.3;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${GX.muted}}
.jb-now .l.on{color:${GX.success}}
.jb-now b{display:block;font-size:15px;line-height:1.3;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jb-now>div{min-width:0;flex:1}
.jb-eq{display:flex;align-items:flex-end;gap:3px;height:20px;flex:none}
.jb-eq i{width:4px;height:100%;border-radius:2px;background:${GX.success};transform-origin:bottom;animation:jb-eq 1.6s ease-in-out infinite}
.jb-eq i:nth-child(2){animation-delay:-.5s}.jb-eq i:nth-child(3){animation-delay:-1s}.jb-eq i:nth-child(4){animation-delay:-.25s}
.jb-eq.off i{animation:none;transform:scaleY(.2);background:${GX.muted}}
@keyframes jb-eq{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}
.jb-list{flex:1;min-height:0;overflow-y:auto;scroll-behavior:smooth;display:flex;flex-direction:column;gap:6px;padding-right:4px;scrollbar-width:thin;scrollbar-color:${GX.s3} transparent}
.jb-st{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:12px;padding:9px 12px;border-radius:10px;background:${GX.key};cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 1px 0 #0b0c0e;transition:background-color .2s}
.jb-st:hover{background:${GX.s3}}
.jb-st.sel{box-shadow:inset 0 0 0 1.5px ${GX.lamp},0 1px 0 #0b0c0e}
.jb-st.on{background:rgba(127,220,149,.14)}
.jb-st:active{scale:.98}
.jb-st .ic{flex:none;width:22px;text-align:center;font-size:12px;color:${GX.lamp}}
.jb-st.on .ic{color:${GX.success}}
.jb-st .tx{min-width:0;flex:1}
.jb-st b{display:block;font-size:14px;line-height:1.3;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jb-st.on b{color:${GX.success}}
.jb-st small{display:block;font-size:12px;line-height:1.35;color:${GX.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jb-vol{display:flex;align-items:center;gap:10px;font-size:12px;line-height:1.3;color:${GX.muted}}
.jb-vol input{flex:1;accent-color:${GX.lamp};cursor:pointer}
.jb-vol output{min-width:28px;text-align:right;color:${GX.text};font-weight:600;font-variant-numeric:tabular-nums}
.jb-msg{margin:auto;font-size:14px;color:${GX.muted}}
@media (prefers-reduced-motion: reduce){.jb-eq i{animation:none}}
`;

/** @param {any} ctx */
function openRadio(ctx) {
  const { R, it } = ctx;
  try { R.onInteract?.(it.id, { toast: () => {}, bubble: () => {} }); } catch { /* the room's own jukebox animation is optional */ }
  askRadio();
  const ov = ctx.overlay({ title: 'Jukebox', sub: 'the GG Coder radio, plays just for you', help: '<kbd>&uarr;&darr;</kbd> pick <kbd>enter</kbd> play <kbd>&larr;&rarr;</kbd> volume <kbd>s</kbd> stop' });
  if (!document.getElementById('jb-css')) { const st = document.createElement('style'); st.id = 'jb-css'; st.textContent = CSS; document.head.appendChild(st); }
  const K = gx(ov), scene = K.scene({ aspect: 0.82, maxW: 560 });
  const jb = document.createElement('div'); jb.className = 'jb'; scene.appendChild(jb);
  // the cabinet: walnut body, chrome arch, bubbling neon tubes (pink -> lamp -> violet), drawn once
  const v = S('svg', { viewBox: '0 0 820 1000', preserveAspectRatio: 'none' }, jb);
  v.innerHTML = `<defs>
    <linearGradient id="jb-wal" x1="0" x2="1"><stop offset="0" stop-color="#2a160c"/><stop offset=".5" stop-color="#5a3219"/><stop offset="1" stop-color="#26130a"/></linearGradient>
    <filter id="jb-grain"><feTurbulence type="fractalNoise" baseFrequency=".015 .4" numOctaves="3" seed="5"/><feColorMatrix values="0 0 0 0 .1  0 0 0 0 .05  0 0 0 0 .02  0 0 0 .4 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
    <linearGradient id="jb-chrome" x1="0" x2="1"><stop offset="0" stop-color="#5d636b"/><stop offset=".3" stop-color="#f1f4f7"/><stop offset=".55" stop-color="#9aa1aa"/><stop offset=".8" stop-color="#e2e6ea"/><stop offset="1" stop-color="#4a4f56"/></linearGradient>
    <linearGradient id="jb-neon" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${GX.violet}"/><stop offset=".5" stop-color="${GX.lampDeep}"/><stop offset="1" stop-color="${GX.pink}"/></linearGradient>
    <radialGradient id="jb-key" cx=".5" cy=".1" r=".9"><stop offset="0" stop-color="#ffd29a" stop-opacity=".28"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></radialGradient>
    <filter id="jb-glow" x="-30%" y="-10%" width="160%" height="120%"><feGaussianBlur stdDeviation="9"/></filter>
    <filter id="jb-soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="18"/></filter></defs>
    <ellipse cx="410" cy="985" rx="380" ry="22" fill="#000" opacity=".5" filter="url(#jb-soft)"/>
    <path id="jb-body" d="M40 1000V330Q40 20 410 20Q780 20 780 330V1000Z" fill="url(#jb-wal)"/>
    <path d="M40 1000V330Q40 20 410 20Q780 20 780 330V1000Z" fill="#000" filter="url(#jb-grain)"/>
    <path d="M70 1000V335Q70 50 410 50Q750 50 750 335V1000" fill="none" stroke="url(#jb-neon)" stroke-width="16" filter="url(#jb-glow)" opacity=".9"/>
    <path d="M70 1000V335Q70 50 410 50Q750 50 750 335V1000" fill="none" stroke="url(#jb-neon)" stroke-width="10" stroke-linecap="round"/>
    <path d="M70 1000V335Q70 50 410 50Q750 50 750 335V1000" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="2.5"/>
    <path d="M105 1000V340Q105 85 410 85Q715 85 715 340V1000" fill="none" stroke="url(#jb-chrome)" stroke-width="12"/>
    <path d="M140 225Q190 110 410 108Q630 110 680 225Z" fill="#1a1220"/>
    <g fill="url(#jb-chrome)">${Array.from({ length: 9 }, (_, k) => `<rect x="${236 + k * 40}" y="140" width="8" height="74" rx="4"/>`).join('')}</g>
    <path d="M40 1000V330Q40 20 410 20Q780 20 780 330V1000Z" fill="url(#jb-key)"/>`;
  const face = document.createElement('div'); face.className = 'jb-face'; jb.appendChild(face);
  face.innerHTML = `<div class="jb-now"><div class="jb-eq off"><i></i><i></i><i></i><i></i></div><div><span class="l">Radio off</span><b></b></div><button class="gx-btn" type="button">Stop</button></div>
    <div class="jb-list" role="listbox" aria-label="Stations"></div>
    <label class="jb-vol"><span>Volume</span><input type="range" min="0" max="100" step="1"><output>0</output></label>
    <div class="jb-vol"><span>Plays on your computer only</span></div>`;
  const q = sel => /** @type {any} */ (face.querySelector(sel));
  const eq = q('.jb-eq'), nowL = q('.jb-now .l'), nowB = q('.jb-now b'), stopB = q('.jb-now button'), list = q('.jb-list'), vol = q('input'), volO = q('output');
  let sel = 0, pending = '', pendingT = 0, t = 0, built = '';
  const st = () => RADIO.state;
  const curIdx = () => { const s = st(); return s ? s.stations.findIndex(x => x.id === s.current) : -1; };
  const render = () => {
    const s = st();
    if (!s || !s.stations.length) { list.innerHTML = `<p class="jb-msg">${s ? 'No stations in the app radio' : 'Tuning in to the app radio...'}</p>`; built = ''; return; }
    const sig = s.stations.map(x => x.id).join('|');
    if (sig !== built) { built = sig; list.replaceChildren(...s.stations.map((x, i) => { const b = document.createElement('button'); b.type = 'button'; b.tabIndex = -1; b.className = 'jb-st'; b.setAttribute('role', 'option');
      b.innerHTML = '<span class="ic"></span><span class="tx"><b></b><small></small></span>'; b.querySelector('b').textContent = x.name; b.querySelector('small').textContent = x.description;
      b.addEventListener('click', () => { sel = i; play(i); render(); }); return b; })); }
    [...list.children].forEach((b, i) => { const x = s.stations[i], on = x.id === s.current; b.classList.toggle('on', on); b.classList.toggle('sel', i === sel); b.setAttribute('aria-selected', String(i === sel));
      b.querySelector('.ic').textContent = on ? '\u266A' : pending === x.id ? '...' : i === sel ? '\u25B6' : ''; });
    const cur = s.stations.find(x => x.id === s.current);
    nowL.textContent = cur ? 'Now playing' : 'Radio off'; nowL.classList.toggle('on', !!cur); nowB.textContent = cur ? cur.name : 'Pick a station'; eq.classList.toggle('off', !cur); stopB.disabled = !cur; stopB.style.opacity = cur ? '1' : '.4';
    if (document.activeElement !== vol) vol.value = String(s.volume); volO.textContent = String(s.volume);
  };
  const ensure = () => { const b = /** @type {HTMLElement | undefined} */ (list.children[sel]); b?.scrollIntoView({ block: 'nearest' }); };
  const sync = () => { const i = curIdx(); if (i >= 0 && !pending) sel = i; pending = ''; render(); ensure(); };
  RADIO.listeners.add(sync); ov.onClose(() => RADIO.listeners.delete(sync));
  if (st()) sync(); else render();
  const play = i => { const s = st(); if (!s || !s.stations[i]) return; const id = s.current === s.stations[i].id ? 'off' : s.stations[i].id;
    pending = id; pendingT = t; SFX.play(id === 'off' ? 'ui.back' : 'ui.select'); tellApp({ t: 'radio-set', station: id }); };
  const setVol = v => { const s = st(); if (!s) return; s.volume = Math.max(0, Math.min(100, Math.round(v))); tellApp({ t: 'radio-volume', volume: s.volume }); render(); };
  const stop = () => { const s = st(); if (!s?.current) return; pending = 'off'; pendingT = t; tellApp({ t: 'radio-set', station: 'off' }); SFX.play('ui.back'); render(); };
  vol.addEventListener('input', () => setVol(Number(vol.value)));
  vol.addEventListener('keydown', e => { if (e.code.startsWith('Arrow')) e.preventDefault(); });
  stopB.tabIndex = -1; stopB.addEventListener('click', stop);
  const onKey = e => { const s = st(); if (!s) return; const n = s.stations.length;
    if (e.code === 'ArrowDown') { sel = Math.min(n - 1, sel + 1); ensure(); SFX.play('ui.hover'); }
    else if (e.code === 'ArrowUp') { sel = Math.max(0, sel - 1); ensure(); SFX.play('ui.hover'); }
    else if (e.code === 'Enter' || e.code === 'Space') play(sel);
    else if (e.code === 'ArrowRight') setVol(s.volume + 5);
    else if (e.code === 'ArrowLeft') setVol(s.volume - 5);
    else if (e.code === 'KeyS' && s.current) stop();
    else return; e.preventDefault(); render(); };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  // the app didn't answer within 6 s: stop showing "tuning"
  const iv = setInterval(() => { t += 0.5; if (pending && t - pendingT > 6) { pending = ''; render(); } }, 500); ov.onClose(() => clearInterval(iv));
}

export default [
  { id: 'radio', label: () => 'Pick a station', sfx: 'arcade.coin', match: (it) => EMBED && it?.kind === 'jukebox' && !!RADIO.state?.stations.length, start: openRadio },
];
