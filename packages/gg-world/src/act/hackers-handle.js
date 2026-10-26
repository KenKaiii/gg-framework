// @ts-check
// HANDLE.EXE: generate and pick a 90s hacker handle (parody style). Saved in localStorage, shown in a toast,
// and used on the SLIPSTREAM high-score table.
import { SFX } from '../sfx.js';
import { text, loop, rng, mouse } from './util.js';
import { backdrop, scan, load, save, today } from './hackers-util.js';

const A = ['Crash', 'Acid', 'Zero', 'Null', 'Phantom', 'Cereal', 'Lord', 'Neon', 'Glitch', 'Razor', 'Static', 'Byte', 'Root', 'Cyber', 'Turbo', 'Ghost'];
const B = ['Overdrive', 'Burn', 'Cool', 'Pointer', 'Phreak', 'Port', 'Nikon', 'Daemon', 'Packet', 'Blade', 'Kernel', 'Vector', 'Overflow', 'Socket', 'Wire', 'Joy'];

/** @param {() => number} r */
const gen = r => A[Math.floor(r() * A.length)] + ' ' + B[Math.floor(r() * B.length)];

/** @param {any} ctx */
export function startHandle(ctx) {
  const ov = ctx.overlay({ title: 'HANDLE.EXE', sub: 'every legend needs a name', help: '<kbd>↑↓</kbd> pick <kbd>R</kbd> reroll <kbd>enter</kbd>/<kbd>click</kbd> save <kbd>esc</kbd> leave' });
  const W = 320, H = 180; const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  let seed = today() + (load('cyb-rolls', 0) | 0) * 7919; const st = { list: /** @type {string[]} */ ([]), sel: 0, flash: 0, saved: load('cyb-handle', null) };
  const roll = () => { const r = rng(seed++); const s = new Set(); while (s.size < 5) s.add(gen(r)); st.list = [...s]; st.sel = 0; st.flash = 0.4; save('cyb-rolls', (load('cyb-rolls', 0) | 0) + 1); };
  roll();
  const onKey = e => {
    if (e.code === 'ArrowDown') { st.sel = (st.sel + 1) % st.list.length; SFX.play('ui.select'); }
    else if (e.code === 'ArrowUp') { st.sel = (st.sel + st.list.length - 1) % st.list.length; SFX.play('ui.select'); }
    else if (e.code === 'KeyR') reroll();
    else if (e.code === 'Enter' || e.code === 'Space') pick();
    else return; e.preventDefault();
  };
  function reroll() { roll(); SFX.play('blip'); SFX.play('key', { delay: 0.05 }); }
  function pick() { st.saved = st.list[st.sel]; save('cyb-handle', st.saved); st.flash = 1; SFX.play('success'); ctx.api.toast(`Handle registered: ${st.saved}. Hack the planet.`); }
  // mouse: hover a handle to pick it, click to save; a reroll button under the list
  const RB = { x: W / 2 - 40, y: 134, w: 80, h: 15 };
  const m = mouse(ov, c, W, H);
  m.rows(i => ({ x: 60, y: 54 + i * 18 - 13, w: 200, h: 17 }), 5, { hover: i => { if (st.sel !== i) { st.sel = i; SFX.play('ui.select'); } }, pick: () => pick() });
  m.add({ ...RB, pick: reroll });
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  loop(ov, (dt, t) => {
    st.flash = Math.max(0, st.flash - dt * 2);
    backdrop(x, W, H, t, '#9dff3d');
    text(x, 'CHOOSE YOUR HANDLE', W / 2, 26, { size: 16, title: true, color: '#9dff3d', align: 'center', shadow: '#0a3a10' });
    st.list.forEach((h, i) => { const y = 54 + i * 18, on = i === st.sel;
      if (on) { x.fillStyle = 'rgba(157,255,61,0.18)'; x.fillRect(60, y - 13, 200, 17); }
      text(x, (on ? '> ' : '  ') + h, 70, y, { color: on ? '#eaffd0' : '#6aa850' }); });
    x.strokeStyle = '#6aa850'; x.strokeRect(RB.x + 0.5, RB.y + 0.5, RB.w - 1, RB.h - 1); text(x, '[R] reroll', W / 2, RB.y + 12, { color: '#9dff3d', align: 'center' });
    text(x, st.saved ? `current: ${st.saved}` : 'current: (none)', W / 2, 160, { color: '#ff4fd8', align: 'center' });
    if (st.flash > 0) { x.fillStyle = `rgba(200,255,160,${st.flash * 0.35})`; x.fillRect(0, 0, W, H); }
    scan(x, W, H);
  });
}
