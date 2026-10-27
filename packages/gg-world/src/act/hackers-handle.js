// @ts-check
// HANDLE.EXE: generate and pick a 90s hacker handle (parody style). Saved in localStorage, shown in a toast,
// and used on the SLIPSTREAM high-score table. GX: a real green-phosphor CRT terminal (DOM at screen resolution)
// with the app's buttons and key chips around it.
import { SFX } from '../sfx.js';
import { rng } from './util.js';
import { gx, GX } from './gx.js';
import { load, save, today } from './hackers-util.js';

const A = ['Crash', 'Acid', 'Zero', 'Null', 'Phantom', 'Cereal', 'Lord', 'Neon', 'Glitch', 'Razor', 'Static', 'Byte', 'Root', 'Cyber', 'Turbo', 'Ghost'];
const B = ['Overdrive', 'Burn', 'Cool', 'Pointer', 'Phreak', 'Port', 'Nikon', 'Daemon', 'Packet', 'Blade', 'Kernel', 'Vector', 'Overflow', 'Socket', 'Wire', 'Joy'];
const G = '#9dff3d';

/** @param {() => number} r */
const gen = r => A[Math.floor(r() * A.length)] + ' ' + B[Math.floor(r() * B.length)];

/** @param {any} ctx */
export function startHandle(ctx) {
  const ov = ctx.overlay({ title: 'HANDLE.EXE', sub: 'every legend needs a name', help: '<kbd>↑↓</kbd> pick <kbd>R</kbd> reroll <kbd>enter</kbd>/<kbd>click</kbd> save' });
  const K = gx(ov);
  const hud = K.hud([{ id: 'cur', label: 'Current handle', value: load('cyb-handle', null) || 'none yet', tone: 'up' }], [{ id: 'rolls', label: 'Rerolls', value: load('cyb-rolls', 0) | 0 }]);
  const scene = K.scene({ aspect: 4 / 3, maxW: 760 });
  const st0 = document.createElement('style');
  st0.textContent = `.hh-mon{position:absolute;inset:0;border-radius:4.5cqw;background:linear-gradient(160deg,#3a3d44,#1d1f24 60%,#121317);box-shadow:inset 0 2px 0 rgba(255,255,255,.12),0 0 0 1px rgba(255,255,255,.05),0 40px 80px -30px #000,0 0 60px -20px ${GX.pink}}
.hh-glass{position:absolute;inset:6cqw 6cqw 13cqw;border-radius:3.6cqw/4.4cqw;background:radial-gradient(ellipse at 50% 45%,#0f2a0c,#061206 70%,#020602);box-shadow:inset 0 0 4cqw rgba(0,0,0,.9),inset 0 0 0 .5cqw #0a0b0d;overflow:hidden;padding:5cqw 6cqw;color:${G};font-family:'Sora',sans-serif;text-shadow:0 0 1.2cqw rgba(157,255,61,.55)}
.hh-glass:after{content:'';position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(0,0,0,.22) 0 1px,transparent 1px 3px),radial-gradient(ellipse 70% 40% at 30% 10%,rgba(255,255,255,.08),transparent 70%)}
.hh-h{font-size:2.4cqw;font-weight:700;letter-spacing:.2em;opacity:.75;margin-bottom:2.4cqw}
.hh-row{position:relative;font-size:4.6cqw;font-weight:600;line-height:1;padding:1.5cqw 2cqw;border-radius:1cqw;cursor:pointer;color:#6aa850;transition:background-color .15s,color .15s}
.hh-row.on{background:rgba(157,255,61,.16);color:#eaffd0;box-shadow:inset .5cqw 0 0 ${G}}
.hh-row.saved:after{content:'saved';position:absolute;right:2cqw;top:50%;transform:translateY(-50%);font-size:2cqw;letter-spacing:.15em;text-transform:uppercase;color:${G}}
.hh-acts{position:absolute;left:0;right:0;bottom:3.4cqw;display:flex;justify-content:center;gap:12px}
.hh-led{position:absolute;right:7cqw;bottom:5.5cqw;width:1.2cqw;height:1.2cqw;border-radius:50%;background:${G};box-shadow:0 0 1.5cqw ${G}}`;
  scene.appendChild(st0);
  const mon = document.createElement('div'); mon.className = 'hh-mon';
  mon.innerHTML = `<div class="hh-glass"><div class="hh-h">CHOOSE YOUR HANDLE</div><div class="hh-list"></div></div><div class="hh-acts"><button class="gx-btn" type="button">${K.keys('R')} Reroll</button><button class="gx-btn pri" type="button">Save handle</button></div>`;
  scene.appendChild(mon);
  const listEl = /** @type {HTMLElement} */ (mon.querySelector('.hh-list'));
  const [rb, sb] = mon.querySelectorAll('button');
  let seed = today() + (load('cyb-rolls', 0) | 0) * 7919;
  const st = { list: /** @type {string[]} */ ([]), sel: 0, saved: load('cyb-handle', null) };
  const draw = () => { [...listEl.children].forEach((r, i) => { r.classList.toggle('on', i === st.sel); r.classList.toggle('saved', st.list[i] === st.saved); r.textContent = (i === st.sel ? '> ' : '  ') + st.list[i]; }); };
  const roll = () => {
    const r = rng(seed++); const s = new Set(); while (s.size < 5) s.add(gen(r)); st.list = [...s]; st.sel = 0;
    save('cyb-rolls', (load('cyb-rolls', 0) | 0) + 1); hud.set('rolls', load('cyb-rolls', 0) | 0);
    listEl.replaceChildren(...st.list.map((_, i) => { const d = document.createElement('div'); d.className = 'hh-row';
      d.addEventListener('pointerenter', () => { if (st.sel !== i) { st.sel = i; SFX.play('ui.select'); draw(); } });
      d.addEventListener('click', () => { st.sel = i; pick(); }); return d; }));
    draw();
  };
  roll();
  function reroll() { roll(); SFX.play('blip'); SFX.play('key', { delay: 0.05 }); }
  function pick() {
    st.saved = st.list[st.sel]; save('cyb-handle', st.saved); draw(); hud.set('cur', st.saved);
    const r = listEl.children[st.sel]?.getBoundingClientRect(); if (r) K.pop(r.left + r.width / 2, r.top, 'Registered', 'up');
    K.swell(); SFX.play('success'); ctx.api.toast(`Handle registered: ${st.saved}. Hack the planet.`);
  }
  rb.addEventListener('click', reroll); sb.addEventListener('click', pick);
  const onKey = e => {
    if (e.code === 'ArrowDown') { st.sel = (st.sel + 1) % st.list.length; SFX.play('ui.select'); draw(); }
    else if (e.code === 'ArrowUp') { st.sel = (st.sel + st.list.length - 1) % st.list.length; SFX.play('ui.select'); draw(); }
    else if (e.code === 'KeyR') reroll();
    else if (e.code === 'Enter' || e.code === 'Space') pick();
    else return; e.preventDefault();
  };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
}
