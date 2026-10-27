// @ts-check
// Oregon Commit: get your feature from Localhost to Production in 6 legs. Each leg pick 1 of 3; random fates.
// Wins counted and saved; "You died of a merge conflict." GX rebuild: a beige LAN-corner CRT (DOM + SVG at screen
// resolution): the trail across green-phosphor hills with the wagon rolling stop to stop, the log, three choices.
import { SFX } from '../sfx.js';
import { rng } from './util.js';
import { gx, svg as S, GX } from './gx.js';
import { store, closeUp } from './computer-util.js';

const STOPS = ['Localhost', 'Feature Branch', 'Code Review', 'CI Pipeline', 'Staging', 'Friday Deploy', 'PRODUCTION'];
const OPTS = [['Rest (write tests)', 0.1], ['Push on (small commit)', 0.22], ['Ford the river (force push)', 0.55]];
const DEATHS = ['You died of a merge conflict.', 'You died of dysentery (npm install).', 'Your oxen ate the lockfile.', 'You died of scope creep.', 'Lost in node_modules. Forever.'];
const CSS = `.oc-mon{position:absolute;inset:0;box-sizing:border-box;border-radius:3.4cqw;background:linear-gradient(180deg,#ece3cf,#d9ceb4 55%,#b9ad92);box-shadow:inset 0 2px 0 #fffaf0,0 30px 70px -26px #000;padding:3.2cqw 3.6cqw 6cqw}
.oc-mon:after{content:'OREGON COMMIT  LAN-PC';position:absolute;left:0;right:0;bottom:1.9cqw;text-align:center;font:800 1.5cqw/1 'Sora',sans-serif;letter-spacing:.3em;color:#6a604c}
.oc-scr{position:relative;box-sizing:border-box;height:100%;border-radius:1.6cqw;background:radial-gradient(ellipse at 50% 40%,#0f2a26,#081614 75%);box-shadow:inset 0 0 0 .4cqw #7f7562,inset 0 0 3cqw #000;padding:2cqw 3cqw;overflow:hidden;color:#6ee7a0;font-family:'Sora',sans-serif;display:flex;flex-direction:column}
.oc-scr:after{content:'';position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(0,0,0,.18) 0 1px,transparent 1px 3px),linear-gradient(160deg,rgba(255,255,255,.09),transparent 30%)}
.oc-scr.hurt{animation:oc-hurt .6s}@keyframes oc-hurt{20%{box-shadow:inset 0 0 0 .4cqw #7f7562,inset 0 0 6cqw rgba(255,90,90,.7);translate:-5px 0}50%{translate:5px 0}}
.oc-trail{width:100%;height:auto;flex:none}.oc-wagon{transition:transform .8s cubic-bezier(.22,1,.36,1)}
.oc-row{display:flex;justify-content:space-between;align-items:center;margin-top:.6cqw;font:700 2cqw/1.2 'Sora'}.oc-cof{display:flex;gap:.8cqw}.oc-cof span{font-size:2.4cqw;filter:grayscale(1) brightness(.4)}.oc-cof span.on{filter:none}
.oc-log{flex:1;margin-top:1.2cqw;font:500 1.9cqw/1.5 'Sora';color:#3aa86e}.oc-log div:last-child{color:#ffcf8a}
.oc-opts{display:grid;grid-template-columns:repeat(3,1fr);gap:1.2cqw}
.oc-o{all:unset;box-sizing:border-box;padding:1.2cqw 1.4cqw;border-radius:1cqw;background:rgba(110,231,160,.07);box-shadow:inset 0 0 0 1px rgba(110,231,160,.28);cursor:pointer;transition:background-color .15s,transform .1s}
.oc-o:hover{background:rgba(110,231,160,.2)}.oc-o:active{transform:translateY(2px)}.oc-o b{display:flex;align-items:center;gap:1cqw;font:700 1.9cqw/1.2 'Sora';color:#d8ffe4}.oc-o small{display:block;margin-top:.6cqw;font:500 1.5cqw/1.3 'Sora';color:#a8c8b0}
.oc-risk{margin-left:auto;display:flex;gap:.3cqw}.oc-risk i{width:.6cqw;height:1.4cqw;border-radius:.2cqw;background:rgba(255,255,255,.12)}
@media (prefers-reduced-motion: reduce){.oc-scr.hurt{animation:none}.oc-wagon{transition:none}}`;

/** @param {any} ctx */
export function startTrail(ctx) {
  const ov = ctx.overlay({ title: 'Oregon Commit', sub: 'LAN corner PC', help: '<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd>/<kbd>click</kbd> choose <kbd>enter</kbd>/<kbd>click</kbd> new run' });
  closeUp(ctx, ov, -4.6, 0.6, 5.2, 1.6);
  const K = gx(ov), wins = () => Number(store('trailWins')) || 0;
  const hud = K.hud([{ id: 'leg', label: 'Leg', value: '0 / 6' }, { id: 'cof', label: 'Coffees', value: 3, tone: 'gold' }], [{ id: 'wins', label: 'Shipped', value: wins(), tone: 'up' }]);
  const scene = K.scene({ aspect: 16 / 9.6, maxW: 1100 });
  const st0 = document.createElement('style'); st0.textContent = CSS; scene.appendChild(st0);
  const mon = document.createElement('div'); mon.className = 'oc-mon'; scene.appendChild(mon);
  const risky = ['#6ee7a0', '#8fa3ff', '#e8645a'];
  mon.innerHTML = `<div class="oc-scr"><svg class="oc-trail" viewBox="0 0 700 120"></svg><div class="oc-row"><span class="nx"></span><span class="oc-cof"><span>☕</span><span>☕</span><span>☕</span></span></div><div class="oc-log"></div><div class="oc-opts">${OPTS.map(([o, risk], i) => { const [a, b] = String(o).split(' (');
    return `<button class="oc-o" type="button" data-i="${i}"><b>${K.keys(String(i + 1))}${a}<span class="oc-risk">${[0, 1, 2].map(k => `<i style="${+risk > k * 0.2 ? 'background:' + risky[i] : ''}"></i>`).join('')}</span></b><small>(${b}</small></button>`; }).join('')}</div></div>`;
  const $ = s => /** @type {HTMLElement} */ (mon.querySelector(s));
  const scr = $('.oc-scr'), tr = $('.oc-trail'), logEl = $('.oc-log'), nx = $('.nx'), cups = [...mon.querySelectorAll('.oc-cof span')];
  // the trail (built once)
  let hill = 'M0 120 L0 60'; for (let k = 0; k <= 28; k++) hill += ` L${k * 25} ${58 - Math.abs(Math.sin(k * 1.7)) * 26}`; hill += ' L700 120Z';
  S('path', { d: hill, fill: '#123a22' }, tr); S('rect', { x: 30, y: 88, width: 640, height: 4, rx: 2, fill: '#2f7a52' }, tr);
  const X = i => 40 + i * 620 / 6, dots = STOPS.map((n, i) => { const g = S('g', {}, tr); S('circle', { cx: X(i), cy: 90, r: 7, fill: '#2f7a52' }, g);
    S('text', { x: X(i), y: 114, 'text-anchor': 'middle', 'font-family': 'Sora', 'font-size': 11, 'font-weight': 600, fill: '#3aa86e' }, g).textContent = n; return g; });
  S('path', { d: `M${X(6)} 83 V56 l16 6 l-16 6`, fill: GX.warning, stroke: GX.warning, 'stroke-width': 2 }, tr);
  const wagon = S('g', { class: 'oc-wagon' }, tr);
  S('path', { d: 'M-22 72 Q0 44 22 72Z', fill: '#f0e6c8' }, wagon); S('rect', { x: -24, y: 70, width: 48, height: 9, rx: 2, fill: '#8a5a3a' }, wagon);
  S('circle', { cx: -14, cy: 82, r: 6, fill: '#1a1a1a', stroke: '#8a5a3a', 'stroke-width': 2 }, wagon); S('circle', { cx: 14, cy: 82, r: 6, fill: '#1a1a1a', stroke: '#8a5a3a', 'stroke-width': 2 }, wagon);
  const r = rng((Date.now() & 0xffffff) + 1);
  /** @type {any} */ let g; let res = /** @type {any} */ (null);
  const render = () => {
    wagon.setAttribute('transform', `translate(${X(g.leg)} 0)`);
    dots.forEach((d, i) => { const on = i <= g.leg; d.children[0].setAttribute('fill', on ? '#6ee7a0' : '#2f7a52'); d.children[1].setAttribute('fill', on ? '#6ee7a0' : '#3aa86e'); });
    nx.textContent = 'Next: ' + (STOPS[g.leg + 1] || 'done'); cups.forEach((c, k) => c.classList.toggle('on', k < g.hp));
    logEl.innerHTML = g.log.map(l => `<div>${l}</div>`).join(''); hud.set('leg', g.leg + ' / 6'); hud.set('cof', g.hp);
  };
  const reset = () => { res?.close(); res = null; g = { leg: 0, hp: 3, log: ['Your party: you, an agent, 3 coffees.'], over: '' }; render(); };
  const newRun = () => { reset(); SFX.play('pc.boot', { vol: 0.5 }); };
  const choose = n => {
    if (g.over) return; const [, risk] = OPTS[n]; SFX.play('key');
    const b = mon.querySelector(`[data-i="${n}"]`)?.getBoundingClientRect();
    if (n === 0) g.hp = Math.min(3, g.hp + 1);
    if (r() < +risk) { g.hp--; SFX.play(n === 2 ? 'splash' : 'arcade.boom', { vol: 0.5, delay: 0.1 }); g.log.push(['A wild bug appears! -1 coffee.', 'Flaky test bites you. -1 coffee.', 'Reviewer: "nit". -1 coffee.'][Math.floor(r() * 3)]);
      scr.classList.remove('hurt'); void scr.offsetWidth; scr.classList.add('hurt'); if (b) K.pop(b.left + b.width / 2, b.top, '-1 coffee', 'bad'); }
    else { g.leg++; SFX.play(n === 0 ? 'espresso' : 'blip', { delay: 0.1, vol: 0.6 }); g.log.push('You reach ' + STOPS[g.leg] + '.'); if (b) K.pop(b.left + b.width / 2, b.top, STOPS[g.leg], 'up'); }
    if (g.log.length > 5) g.log.shift();
    if (g.hp <= 0) { g.over = DEATHS[Math.floor(r() * DEATHS.length)]; SFX.play('fail', { delay: 0.35 }); }
    else if (g.leg >= STOPS.length - 1) { g.over = 'win'; SFX.play('win', { delay: 0.35 }); store('trailWins', wins() + 1); hud.set('wins', wins(), { count: true }); K.swell(); }
    render();
    if (g.over) setTimeout(() => { if (!ov.el.isConnected || res) return; const won = g.over === 'win';
      res = K.result({ title: won ? 'Shipped to production' : 'You died', big: won ? 'PRODUCTION' : undefined, line: won ? 'The feature made it. Ring the bell.' : g.over, stats: [[g.leg + ' / 6', 'Legs'], [wins(), 'Runs shipped']], again: 'New run', onAgain: () => { res = null; newRun(); } });
      const big = /** @type {HTMLElement | null} */ (res.el.querySelector('.big')); if (big) { big.style.fontSize = '34px'; big.style.color = GX.warning; } }, 700);
  };
  mon.querySelectorAll('.oc-o').forEach(b => b.addEventListener('click', () => choose(Number(/** @type {HTMLElement} */ (b).dataset.i))));
  const onKey = e => { const m = /^(Digit|Numpad)([1-3])$/.exec(e.code); if (m) choose(+m[2] - 1); if (e.code === 'Enter' && !res) newRun(); };
  const cap = e => { if (e.code !== 'Escape') { if (!res) e.stopPropagation(); onKey(e); } };
  addEventListener('keydown', cap, true); ov.onClose(() => removeEventListener('keydown', cap, true));
  reset();
}
