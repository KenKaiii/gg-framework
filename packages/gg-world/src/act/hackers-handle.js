// @ts-check
// HANDLE.EXE: generate and pick a 90s hacker handle (parody style). Saved in localStorage, shown in a toast,
// and used on the SLIPSTREAM high-score table. Drawn with the art kit: synthwave backdrop, CRT terminal panel.
import { SFX } from '../sfx.js';
import { loop, rng, mouse } from './util.js';
import { panel, title, glow, shine, banner, particles } from './art.js';
import { scan, load, save, today, neonBg, howTo, btns } from './hackers-util.js';

const A = ['Crash', 'Acid', 'Zero', 'Null', 'Phantom', 'Cereal', 'Lord', 'Neon', 'Glitch', 'Razor', 'Static', 'Byte', 'Root', 'Cyber', 'Turbo', 'Ghost'];
const B = ['Overdrive', 'Burn', 'Cool', 'Pointer', 'Phreak', 'Port', 'Nikon', 'Daemon', 'Packet', 'Blade', 'Kernel', 'Vector', 'Overflow', 'Socket', 'Wire', 'Joy'];
const G = '#9dff3d';

/** @param {() => number} r */
const gen = r => A[Math.floor(r() * A.length)] + ' ' + B[Math.floor(r() * B.length)];

/** @param {any} ctx */
export function startHandle(ctx) {
  const ov = ctx.overlay({ title: 'HANDLE.EXE', sub: 'every legend needs a name', help: '<kbd>↑↓</kbd> pick <kbd>R</kbd> reroll <kbd>enter</kbd>/<kbd>click</kbd> save <kbd>esc</kbd> leave' });
  const W = 320, H = 180; const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  let seed = today() + (load('cyb-rolls', 0) | 0) * 7919; const st = { list: /** @type {string[]} */ ([]), sel: 0, flash: 0, saved: load('cyb-handle', null), rollT: 0, selY: 0 };
  const roll = () => { const r = rng(seed++); const s = new Set(); while (s.size < 5) s.add(gen(r)); st.list = [...s]; st.sel = 0; st.flash = 0.4; st.rollT = 0; save('cyb-rolls', (load('cyb-rolls', 0) | 0) + 1); };
  roll();
  const bg = neonBg(W, H, G, 0.62), fx = particles(), B2 = btns(c, W, H); let bannerT = -1;
  const onKey = e => {
    if (e.code === 'ArrowDown') { st.sel = (st.sel + 1) % st.list.length; SFX.play('ui.select'); }
    else if (e.code === 'ArrowUp') { st.sel = (st.sel + st.list.length - 1) % st.list.length; SFX.play('ui.select'); }
    else if (e.code === 'KeyR') reroll();
    else if (e.code === 'Enter' || e.code === 'Space') pick();
    else return; e.preventDefault();
  };
  function reroll() { roll(); SFX.play('blip'); SFX.play('key', { delay: 0.05 }); }
  function pick() { st.saved = st.list[st.sel]; save('cyb-handle', st.saved); st.flash = 1; bannerT = 0; fx.burst(W / 2, 50 + st.sel * 16, { n: 30, colors: [G, '#eaffd0', '#3ff0ff'] }); SFX.play('success'); ctx.api.toast(`Handle registered: ${st.saved}. Hack the planet.`); }
  const RB = { x: 52, y: 134, w: 100, h: 18 }, SB = { x: 168, y: 134, w: 100, h: 18 };
  const m = mouse(ov, c, W, H);
  m.rows(i => ({ x: 60, y: 42 + i * 16, w: 200, h: 16 }), 5, { hover: i => { if (st.sel !== i) { st.sel = i; SFX.play('ui.select'); } }, pick: () => pick() });
  m.add({ ...RB, pick: reroll }); m.add({ ...SB, pick: () => pick() });
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  loop(ov, (dt, t) => {
    st.flash = Math.max(0, st.flash - dt * 2); st.rollT += dt; st.selY += (st.sel * 16 - st.selY) * Math.min(1, dt * 18);
    bg.draw(x, t);
    title(x, 'CHOOSE YOUR HANDLE', W / 2, 22, { size: 16, color: G, glow: 'rgba(157,255,61,0.7)', glowR: 8 });
    const p = panel(x, 50, 32, 220, 96, { style: 'crt' });
    // selection bar slides to the pick
    const sy = 42 + st.selY; x.fillStyle = 'rgba(157,255,61,0.2)'; x.fillRect(p.x + 4, sy, p.w - 8, 16); x.fillStyle = G; x.fillRect(p.x + 4, sy, 2, 16); glow(x, W / 2, sy + 8, 80, G, 0.12);
    st.list.forEach((h, i) => { const y = 54 + i * 16, on = i === st.sel, k = Math.min(1, Math.max(0, (st.rollT - i * 0.06) / 0.25));
      const shown = k < 1 ? h.slice(0, Math.ceil(h.length * k)) + (k > 0 ? '_' : '') : h;  // typed out on reroll
      title(x, (on ? '> ' : '  ') + shown, p.x + 12, y, { size: 16, body: true, align: 'left', color: on ? '#eaffd0' : '#6aa850', ink: '#03100a' });
      if (on && (t % 1.6) < 0.8) title(x, '_', p.x + p.w - 16, y, { size: 16, body: true, color: G, ink: '#03100a' }); });
    B2.draw(x, RB.x, RB.y, RB.w, RB.h, 'REROLL');
    B2.draw(x, SB.x, SB.y, SB.w, SB.h, 'SAVE', { primary: true }); shine(x, SB.x, SB.y, SB.w, SB.h, t * 0.5);
    howTo(x, W, 172, [['↑↓', 'pick'], ['R', 'reroll'], ['enter', 'save']]);
    fx.draw(x, dt);
    if (st.flash > 0) { x.fillStyle = `rgba(200,255,160,${st.flash * 0.25})`; x.fillRect(0, 0, W, H); }
    if (bannerT >= 0) { bannerT += dt; banner(x, W, H, 'REGISTERED', String(st.saved), bannerT, { color: G }); if (bannerT > 1.6) bannerT = -1; }
    scan(x, W, H);
  });
}
