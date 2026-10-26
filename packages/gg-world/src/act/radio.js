// @ts-check
// The jukebox plays the GG Coder app's radio (owner: "the radios we have in the GG app, selectable via the jukebox,
// same stations; only plays locally for that user"). The app owns the player (the same app-wide radio as its title
// bar button), the game just shows the stations and asks the app to play / stop / change the volume:
//   game -> app: { gg:'world', t:'radio-get' } | { t:'radio-set', station: id | 'off' } | { t:'radio-volume', volume 0..100 }
//   app -> game: { gg:'world', t:'radio', stations:[{id,name,description}], current: id|null, volume }
// Standalone (no app) the jukeboxes keep their old in-world reaction (this activity doesn't match).
import { text, loop, scroller } from './util.js';
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

const W = 480, H = 270, ROW = 30, TOP = 46, VIS = 6;
const C = { bg: '#14101c', panel: '#1f1a2a', row: '#2a2338', on: '#3a2f52', ink: '#f3e6cc', dim: '#a89cb8', gold: '#f5bd63', green: '#6ee7a0', pink: '#ff7ab8' };

/** @param {any} ctx */
function openRadio(ctx) {
  const { R, it } = ctx;
  try { R.onInteract?.(it.id, { toast: () => {}, bubble: () => {} }); } catch { /* the room's own jukebox animation is optional */ }
  askRadio();
  const ov = ctx.overlay({ title: 'Jukebox', sub: 'the GG Coder radio, plays just for you', help: '<kbd>&uarr;&darr;</kbd>pick <kbd>enter</kbd>play <kbd>&larr;&rarr;</kbd>volume <kbd>s</kbd>stop <kbd>esc</kbd>leave' });
  const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  let sel = 0, t = 0, pending = '', pendingT = 0, volDrag = false;
  const sc = scroller(c, { x: 12, y: TOP, w: W - 24, h: VIS * ROW, rowH: ROW, W, H }); /** @type {any} */ (c)._sc = sc; // smooth wheel / trackpad / thumb drag (tests read _sc)
  const st = () => RADIO.state;
  const curIdx = () => { const s = st(); return s ? s.stations.findIndex(q => q.id === s.current) : -1; };
  const sync = () => { const i = curIdx(); if (i >= 0 && !pending) sel = i; pending = ''; };
  RADIO.listeners.add(sync); ov.onClose(() => RADIO.listeners.delete(sync));
  if (st()) sync();
  const play = i => { const s = st(); if (!s || !s.stations[i]) return; const id = s.current === s.stations[i].id ? 'off' : s.stations[i].id;
    pending = id; pendingT = t; SFX.play(id === 'off' ? 'ui.back' : 'ui.select'); tellApp({ t: 'radio-set', station: id }); };
  const setVol = v => { const s = st(); if (!s) return; s.volume = Math.max(0, Math.min(100, Math.round(v))); tellApp({ t: 'radio-volume', volume: s.volume }); };
  const onKey = e => { const s = st(); if (!s) return; const n = s.stations.length;
    if (e.code === 'ArrowDown') { sel = Math.min(n - 1, sel + 1); sc.ensureVisible(sel); SFX.play('ui.hover'); }
    else if (e.code === 'ArrowUp') { sel = Math.max(0, sel - 1); sc.ensureVisible(sel); SFX.play('ui.hover'); }
    else if (e.code === 'Enter' || e.code === 'Space') play(sel);
    else if (e.code === 'ArrowRight') setVol(s.volume + 5);
    else if (e.code === 'ArrowLeft') setVol(s.volume - 5);
    else if (e.code === 'KeyS' && s.current) { pending = 'off'; pendingT = t; tellApp({ t: 'radio-set', station: 'off' }); SFX.play('ui.back'); }
    else return; e.preventDefault(); };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  // mouse: click a row to play / stop it; drag the volume bar
  const at = e => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H]; };
  const VX = 300, VY = 236, VW = 160;
  c.addEventListener('pointerdown', e => { const [px, py] = at(e); const s = st(); if (!s) return;
    if (py >= VY - 8 && py <= VY + 14 && px >= VX - 4 && px <= VX + VW + 4) { volDrag = true; setVol((px - VX) / VW * 100); return; }
    const i = sc.rowAt(py); if (i >= 0 && i < s.stations.length && px > 12 && px < W - 18) { sel = i; play(i); } });
  c.addEventListener('pointermove', e => { const [px, py] = at(e); if (volDrag) { setVol((px - VX) / VW * 100); return; } const s = st(); if (!s) return;
    const i = sc.rowAt(py); c.style.cursor = i >= 0 && i < s.stations.length && px < W - 18 ? 'pointer' : ''; });
  addEventListener('pointerup', () => { volDrag = false; });
  // (wheel: the scroller)

  loop(ov, dt => {
    t += dt; if (pending && t - pendingT > 6) pending = ''; // the app didn't answer: stop showing "tuning"
    x.fillStyle = C.bg; x.fillRect(0, 0, W, H);
    // chrome jukebox arch + neon trim
    const g = x.createLinearGradient(0, 0, W, 0); g.addColorStop(0, '#ff7ab8'); g.addColorStop(0.5, '#f5bd63'); g.addColorStop(1, '#8fa3ff');
    x.fillStyle = g; x.fillRect(8, 8, W - 16, 3); x.fillRect(8, H - 11, W - 16, 3);
    const s = st();
    if (!s) { text(x, 'tuning in to the app radio...', W / 2, H / 2, { size: 16, color: C.dim, align: 'center' }); return; }
    if (!s.stations.length) { text(x, 'no stations in the app radio', W / 2, H / 2, { size: 16, color: C.dim, align: 'center' }); return; }
    sc.setCount(s.stations.length); sc.update(dt);
    const cur = s.current; text(x, cur ? 'NOW PLAYING' : 'RADIO OFF', 16, 32, { size: 16, title: true, color: cur ? C.green : C.dim });
    if (cur) text(x, s.stations.find(q => q.id === cur)?.name || '', 140, 32, { size: 16, color: C.ink });
    sc.clip(x, () => { const first = Math.floor(sc.off / ROW); for (let i = first; i < Math.min(s.stations.length, first + VIS + 1); i++) { const q = s.stations[i], y = Math.round(TOP + i * ROW - sc.off), on = q.id === cur, isSel = i === sel;
      x.fillStyle = isSel ? C.on : C.row; x.fillRect(12, y + 2, W - 34, ROW - 4);
      if (isSel) { x.fillStyle = C.gold; x.fillRect(12, y + 2, 3, ROW - 4); }
      // equaliser for the playing station, a play arrow for the selected one
      if (on) for (let b = 0; b < 4; b++) { const h = 4 + Math.round((Math.sin(t * (5 + b * 1.7) + b) * 0.5 + 0.5) * 12); x.fillStyle = C.green; x.fillRect(24 + b * 5, y + ROW - 7 - h, 3, h); }
      else if (pending === q.id) { text(x, '...', 24, y + 20, { size: 16, color: C.gold }); }
      else if (isSel) { x.fillStyle = C.gold; x.beginPath(); x.moveTo(26, y + 9); x.lineTo(34, y + 15); x.lineTo(26, y + 21); x.fill(); }
      text(x, q.name, 50, y + 14, { size: 16, color: on ? C.green : C.ink });
      text(x, q.description, 50, y + 25, { size: 16, color: C.dim }); } });
    sc.drawBar(x);
    // volume
    text(x, 'volume', VX - 52, VY + 6, { size: 16, color: C.dim });
    x.fillStyle = '#2a2338'; x.fillRect(VX, VY - 2, VW, 8); x.fillStyle = C.gold; x.fillRect(VX, VY - 2, Math.round(VW * s.volume / 100), 8);
    text(x, String(s.volume), VX + VW + 8, VY + 6, { size: 16, color: C.ink });
    text(x, 'plays on your computer only', 16, VY + 6, { size: 16, color: C.dim });
  });
}

export default [
  { id: 'radio', label: () => 'Pick a station', sfx: 'arcade.coin', match: (it) => EMBED && it?.kind === 'jukebox' && !!RADIO.state?.stations.length, start: openRadio },
];
