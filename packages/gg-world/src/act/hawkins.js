// @ts-check
// Activities for Hawkins Living Room: talk through the Christmas-lights alphabet, and roll a d20 at the campaign table.
import { loop } from './util.js';
import { typer } from './films-a-crt.js';
import { SFX } from '../sfx.js';
import { gx, svg as S, GX } from './gx.js';

// one Christmas bulb flaring: a warm electric buzz + soft glassy tick
SFX.define('hawkins.bulb', (o, t, p, K) => { K.tone(o, t, { type: 'sawtooth', f: 120 * p, v: 0.05, a: 0.01, d: 0.25 }); K.bell(o, t, { f: 1400 * p, ratio: 2.7, idx: 0.8, v: 0.06, d: 0.2 }); });

const ROWS = ['ABCDEFGH', 'IJKLMNOPQ', 'RSTUVWXYZ'];
const GLYPH = {A:'M5 80L30 0L55 80M14 52L46 52',B:'M8 80L8 0Q50 0 48 20Q46 38 8 38Q56 40 52 60Q48 80 8 80',C:'M52 12Q30-6 10 20Q0 50 14 70Q32 88 54 68',D:'M8 0L8 80Q56 80 54 40Q52 0 8 0',E:'M50 0L8 0L8 80L52 80M8 40L40 40',F:'M50 0L8 0L8 80M8 40L40 40',G:'M52 12Q30-6 10 20Q0 50 14 70Q34 88 52 66L52 46L32 46',H:'M8 0L8 80M52 0L52 80M8 40L52 40',I:'M30 0L30 80M16 0L44 0M16 80L44 80',J:'M48 0L48 60Q46 84 26 80Q10 76 8 60',K:'M8 0L8 80M52 0L8 48M22 34L54 80',L:'M8 0L8 80L50 80',M:'M4 80L8 0L30 50L52 0L56 80',N:'M8 80L8 0L52 80L52 0',O:'M30 0Q0 2 4 40Q6 80 30 80Q56 80 56 40Q56 0 30 0',P:'M8 80L8 0Q52 0 50 22Q48 44 8 42',Q:'M30 0Q0 2 4 40Q6 80 30 80Q56 80 56 40Q56 0 30 0M34 58L58 84',R:'M8 80L8 0Q52 0 50 22Q48 44 8 42M24 42L54 80',S:'M50 10Q30-6 12 8Q0 24 26 38Q56 50 48 68Q36 88 6 70',T:'M2 2L58 2M30 2L30 80',U:'M8 0L8 56Q10 82 30 80Q52 80 52 56L52 0',V:'M4 0L30 80L56 0',W:'M2 0L14 80L30 30L46 80L58 0',X:'M6 0L54 80M54 0L6 80',Y:'M4 0L30 40L56 0M30 40L30 80',Z:'M6 2L54 2L6 78L56 78'};

const COLS = ['#ff4a3d', '#3fdc6a', '#4a8dff', '#ffb43a', '#ff6fb5'];
const STEP = 0.75, IDLE = 7;
const on = (id) => (it, R) => R.id === 'hawkins' && it.id === id;

/** The alphabet wall (Stranger Things), rebuilt on GX after concepts/hawkins.html: floral wallpaper, letters brushed
 *  in black house paint, a green wire of C9 bulbs that bloom and throw coloured light. @param {any} ctx */
function lights(ctx) {
  const { R } = ctx;
  const ov = ctx.overlay({ title: 'The Lights', sub: 'Hawkins · someone is listening', help: '<kbd>type</kbd> a word <kbd>enter</kbd> spell it <kbd>click</kbd> a letter to light it' });
  const K = gx(ov), reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scene = K.scene({ aspect: 16 / 9 });
  const root = S('svg', { viewBox: '0 0 1600 900', width: '100%', height: '100%', 'aria-label': 'Alphabet wall' }, scene);
  Object.assign(root.style, { position: 'absolute', inset: '0', borderRadius: '14px', boxShadow: '0 30px 60px -20px rgba(0,0,0,.8)' });
  if (!document.getElementById('hwk-style')) { const s = document.createElement('style'); s.id = 'hwk-style'; s.textContent = `
.hwk .glow,.hwk .lit{opacity:0;transition:opacity .18s ease-out}.hwk .glow{mix-blend-mode:plus-lighter}.hwk .on .glow,.hwk .on .lit{opacity:1}
.hwk .letter{cursor:pointer}.hwk .letter:hover .paint{stroke:#2a1a12}
.hwk #hwk-lights.dim{animation:hwk-dim 1.8s ease-in-out}@keyframes hwk-dim{0%,100%{opacity:1}35%{opacity:.25}55%{opacity:.85}75%{opacity:.35}}
.hwk-typer{position:absolute;left:50%;bottom:3%;translate:-50% 0;min-width:min(440px,70%);padding:10px 16px;border-radius:12px;background:rgba(21,23,26,.78);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 0 0 1px rgba(255,255,255,.07),0 10px 24px -12px #000;display:flex;align-items:center;gap:12px}
.hwk-typer small{font-size:11px;font-weight:600;color:${GX.muted}}.hwk-typer b{flex:1;font-size:20px;font-weight:600;letter-spacing:.18em;min-height:26px}
.hwk-typer b::after{content:"";display:inline-block;width:2px;height:20px;margin-left:3px;vertical-align:-3px;background:${GX.lamp};animation:hwk-bl 1.6s steps(1) infinite}.hwk-typer b.ghost{color:#ff7a5a}
@keyframes hwk-bl{50%{opacity:0}}@media (prefers-reduced-motion:reduce){.hwk .glow,.hwk .lit{transition:none}.hwk #hwk-lights.dim,.hwk-typer b::after{animation:none}}`; document.head.appendChild(s); }
  scene.classList.add('hwk');
  root.innerHTML = `<defs>
  <pattern id="hwk-paper" width="96" height="120" patternUnits="userSpaceOnUse"><rect width="96" height="120" fill="#6e5233"/><rect width="30" height="120" fill="#614629"/><rect x="31" width="3" height="120" fill="#8a6c47" opacity=".6"/><rect x="92" width="3" height="120" fill="#8a6c47" opacity=".6"/>
  <g transform="translate(63 34)" fill="#8f6e45" opacity=".75"><circle r="5"/><circle cy="-9" r="5"/><circle cx="8.5" cy="-3" r="5"/><circle cx="5" cy="7" r="5"/><circle cx="-5" cy="7" r="5"/><circle cx="-8.5" cy="-3" r="5"/><circle r="3" fill="#6e4f2e"/><path d="M0 12 q4 18 -2 32 M-1 26 q-10 -2 -14 6 M0 34 q10 -4 13 3" stroke="#6f5a32" stroke-width="2" fill="none"/></g>
  <g transform="translate(15 94) scale(.6)" fill="#7c5f3b"><circle r="5"/><circle cy="-9" r="5"/><circle cx="8.5" cy="-3" r="5"/><circle cx="5" cy="7" r="5"/><circle cx="-5" cy="7" r="5"/><circle cx="-8.5" cy="-3" r="5"/></g></pattern>
  <linearGradient id="hwk-wood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5a3a22"/><stop offset=".08" stop-color="#7a5232"/><stop offset=".2" stop-color="#4a2f1b"/><stop offset="1" stop-color="#2a190e"/></linearGradient>
  <pattern id="hwk-grain" width="300" height="40" patternUnits="userSpaceOnUse"><path d="M0 10 q80 -6 150 2 t150 -1 M0 24 q90 5 160 -2 t140 3 M0 34 q70 -3 140 1 t160 0" stroke="#000" stroke-opacity=".18" fill="none"/></pattern>
  <radialGradient id="hwk-lamp" cx=".5" cy=".18" r=".75"><stop offset="0" stop-color="#ffd29a" stop-opacity=".18"/><stop offset=".5" stop-color="#f2a35a" stop-opacity=".08"/><stop offset="1" stop-color="#0b0710" stop-opacity=".82"/></radialGradient>
  <filter id="hwk-brush" x="-20%" y="-20%" width="140%" height="140%"><feTurbulence type="fractalNoise" baseFrequency=".045" numOctaves="2" seed="3" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="5" result="d"/><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="1" seed="9" result="f"/><feColorMatrix in="f" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -0.7 1.35" result="m"/><feComposite in="d" in2="m" operator="in"/></filter>
  <filter id="hwk-bloom" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="6"/><feMerge><feMergeNode/><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <radialGradient id="hwk-glass" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".4" stop-color="#fff" stop-opacity=".05"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></radialGradient>
  <clipPath id="hwk-clip"><rect width="1600" height="900" rx="20"/></clipPath></defs>
  <g clip-path="url(#hwk-clip)"><rect width="1600" height="900" fill="url(#hwk-paper)"/><rect width="1600" height="900" fill="#0c0610" opacity=".38"/><g id="hwk-letters"></g><g id="hwk-lights"></g>
  <rect width="1600" height="900" fill="url(#hwk-lamp)" pointer-events="none"/><rect y="800" width="1600" height="100" fill="url(#hwk-wood)"/><rect y="800" width="1600" height="100" fill="url(#hwk-grain)"/><rect y="796" width="1600" height="6" fill="#000" opacity=".35"/></g>`;
  const defs = /** @type {Element} */ (root.querySelector('defs')), Lg = /** @type {Element} */ (root.querySelector('#hwk-letters')), Bg = /** @type {Element} */ (root.querySelector('#hwk-lights'));
  COLS.forEach((c, i) => { const g = S('radialGradient', { id: 'hwk-gl' + i }, defs); S('stop', { offset: 0, 'stop-color': c, 'stop-opacity': 0.95 }, g); S('stop', { offset: 0.3, 'stop-color': c, 'stop-opacity': 0.38 }, g); S('stop', { offset: 1, 'stop-color': c, 'stop-opacity': 0 }, g); });
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  /** @type {Record<string, Element>} */ const bulbs = {};
  ROWS.forEach((row, r) => {
    const step = 150, x0 = 800 - (row.length - 1) * step / 2, y = [188, 400, 612][r], by = y - 58;
    const pts = [...row].map(() => [0, 0]).map((_, i) => [x0 + i * step + (rnd() - 0.5) * 14, by + (rnd() - 0.5) * 10]);
    let d = `M${pts[0][0] - step / 2} ${by - 38}`; pts.forEach(([x, yy], i) => { d += ` Q${x} ${yy + 22} ${x + step / 2} ${by - 38 + (i % 2 ? 4 : -3)}`; });
    const gw = S('g', {}, Bg);
    S('path', { d, fill: 'none', stroke: '#0e1f10', 'stroke-width': 6, 'stroke-linecap': 'round' }, gw);
    S('path', { d, fill: 'none', stroke: '#2f5a2c', 'stroke-width': 3.4, 'stroke-dasharray': '5 4' }, gw);
    S('path', { d, fill: 'none', stroke: '#6f9a5a', 'stroke-width': 1, 'stroke-dasharray': '2 7', 'stroke-opacity': 0.6 }, gw);
    [pts[0][0] - step / 2, ...pts.map(p => p[0] + step / 2)].forEach((nx, i) => { const ny = by - 38 + (i === 0 ? 0 : ((i - 1) % 2 ? 4 : -3)); S('circle', { cx: nx, cy: ny, r: 4, fill: '#b9b2a4' }, gw); S('circle', { cx: nx - 1, cy: ny - 1, r: 1.5, fill: '#fff', opacity: 0.6 }, gw); });
    [...row].forEach((ch, i) => {
      const [x, yy] = pts[i], ci = (r * 3 + i) % 5, c = COLS[ci], rot = (rnd() - 0.5) * 22, sock = yy + 12;
      const g = S('g', { class: 'bulb' }, Bg);
      S('circle', { class: 'glow', cx: x, cy: sock + 34, r: 170, fill: `url(#hwk-gl${ci})` }, g);
      const t = S('g', { transform: `rotate(${rot} ${x} ${sock - 6})` }, g);
      S('rect', { x: x - 7, y: sock - 8, width: 14, height: 20, rx: 3, fill: '#1d3a1c' }, t);
      S('rect', { x: x - 6, y: sock - 6, width: 3, height: 16, fill: '#4c7a40', opacity: 0.6 }, t);
      const shape = `M${x - 6} ${sock + 12}C${x - 15} ${sock + 24} ${x - 13} ${sock + 46} ${x} ${sock + 58}C${x + 13} ${sock + 46} ${x + 15} ${sock + 24} ${x + 6} ${sock + 12}Z`;
      S('path', { d: shape, fill: c, opacity: 0.32 }, t); S('path', { d: shape, fill: '#120c0c', opacity: 0.55 }, t);
      S('path', { class: 'lit', d: shape, fill: c, filter: 'url(#hwk-bloom)' }, t);
      S('path', { class: 'lit', d: `M${x - 2} ${sock + 22}C${x - 4} ${sock + 32} ${x - 2} ${sock + 42} ${x} ${sock + 48}C${x + 3} ${sock + 40} ${x + 3} ${sock + 30} ${x + 2} ${sock + 22}Z`, fill: '#fff', opacity: 0.8 }, t);
      S('path', { d: shape, fill: 'url(#hwk-glass)' }, t);
      S('path', { d: `M${x - 6} ${sock + 22}q-3 10 1 18`, stroke: '#fff', 'stroke-opacity': 0.55, 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round' }, t);
      bulbs[ch] = g;
      const lg = S('g', { class: 'letter', role: 'button', 'aria-label': ch, transform: `translate(${x - 30} ${y + 16}) rotate(${(rnd() - 0.5) * 8} 30 40) scale(${0.95 + rnd() * 0.12})` }, Lg);
      S('rect', { x: -14, y: -12, width: 88, height: 106, fill: 'transparent' }, lg);
      const pg = S('g', { filter: 'url(#hwk-brush)' }, lg);
      S('path', { class: 'paint', d: GLYPH[ch], fill: 'none', stroke: '#0d0807', 'stroke-width': 10, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, pg);
      if (rnd() < 0.55) { const dx = 10 + rnd() * 40, len = 10 + rnd() * 26; S('path', { d: `M${dx} 78L${dx + 0.5} ${80 + len}`, stroke: '#161010', 'stroke-width': 3, 'stroke-linecap': 'round', opacity: 0.85 }, pg); S('circle', { cx: dx + 0.5, cy: 82 + len, r: 3.2, fill: '#161010' }, pg); }
      lg.addEventListener('click', () => { if (!playing) return; st.last = st.t; spell(ch); });
    });
  });
  const lightsG = /** @type {Element} */ (root.querySelector('#hwk-lights'));
  const typerEl = document.createElement('div'); typerEl.className = 'hwk-typer'; typerEl.innerHTML = '<small>You</small><b></b>'; scene.appendChild(typerEl);
  const who = /** @type {HTMLElement} */ (typerEl.querySelector('small')), typed = /** @type {HTMLElement} */ (typerEl.querySelector('b'));
  const hud = K.hud([{ id: 'n', label: 'Words spelled' }]);
  const st = { t: 0, seq: /** @type {string[]} */ ([]), t0: 0, last: 0, word: '', idleN: 0, ghost: false, n: 0, lit: '' };
  let playing = false;
  const spell = (w, ghost = false) => { const s = w.toUpperCase().replace(/[^A-Z ]/g, '').slice(0, 14); if (!s.trim()) return; st.word = s; st.seq = [...s]; st.t0 = st.t; st.ghost = ghost; R.hawk?.spell(s);
    if (ghost && !reduce) { lightsG.classList.remove('dim'); void (/** @type {any} */ (lightsG)).getBBox(); lightsG.classList.add('dim'); }
    if (!ghost && s.length > 1) { st.n++; hud.set('n', st.n, { count: true }); } };
  const sh = typer(ov, v => { st.last = st.t; if (!v) SFX.play('ui.deny'); spell(v); }, 14, () => { st.last = st.t; });
  sh.on = false;
  loop(ov, dt => {
    if (!playing) return;
    st.t += dt; const t = st.t;
    const busy = st.seq.length > 0 && t - st.t0 < st.seq.length * STEP + 0.6;
    if (!busy && sh.buf === '' && t - st.last > IDLE) { st.last = t; spell(st.idleN++ % 2 ? 'RIGHT HERE' : 'RUN', true); SFX.play('eerie', { vol: 0.5 }); K.swell(); }
    const i = Math.floor((t - st.t0) / STEP), ph = ((t - st.t0) % STEP) / STEP;
    const lit = busy && i < st.seq.length && ph < 0.75 ? st.seq[i] : '';
    if (lit !== st.lit) { if (st.lit && bulbs[st.lit]) bulbs[st.lit].classList.remove('on'); if (lit && bulbs[lit]) { bulbs[lit].classList.add('on'); SFX.play('hawkins.bulb', { pitch: 0.85 + (ROWS.join('').indexOf(lit) % 9) * 0.04 }); } st.lit = lit; }
    const txt = busy ? st.word.slice(0, Math.min(st.word.length, i + 1)) : sh.buf.toUpperCase();
    typed.classList.toggle('ghost', busy && st.ghost); who.textContent = busy && st.ghost ? 'The wall' : 'You';
    if (typed.textContent !== txt) typed.textContent = txt;
  });
  K.card({ title: 'The Lights Wall', text: 'Spell something to the wall and the lights answer, one bulb at a time. Leave it alone and it might talk back.', how: [[['A–Z'], 'type a word'], [['Enter'], 'spell it'], [['Click'], 'a letter']], cta: 'Plug in the lights',
    onGo: () => { playing = true; sh.on = true; st.last = 0; setTimeout(() => ov.el.isConnected && spell('HELLO', true), 900); } });
}

/** d20 at the campaign table: a red resin die on green felt, a dungeon map and a character sheet. @param {any} ctx */
function d20(ctx) {
  const ov = ctx.overlay({ title: 'Roll for initiative', sub: 'The campaign table · a monster mini watches', help: '<kbd>space</kbd>/<kbd>click</kbd> roll' });
  const K = gx(ov), reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hud = K.hud([{ id: 'n', label: 'Rolls' }, { id: 'best', label: 'Best', value: '-', tone: 'gold' }], [{ id: 'last', label: 'Last roll', value: '-' }]);
  const scene = K.scene({ aspect: 16 / 9 });
  const root = S('svg', { viewBox: '0 0 1600 900', width: '100%', height: '100%', 'aria-label': 'Campaign table' }, scene);
  Object.assign(root.style, { position: 'absolute', inset: '0', cursor: 'pointer' });
  root.innerHTML = `<defs>
  <filter id="hd-felt"><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" seed="5"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .35 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
  <filter id="hd-grain"><feTurbulence type="fractalNoise" baseFrequency=".008 .3" numOctaves="3" seed="2"/><feColorMatrix values="0 0 0 0 .1  0 0 0 0 .05  0 0 0 0 .02  0 0 0 .4 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
  <radialGradient id="hd-feltG" cx=".5" cy=".4" r=".7"><stop offset="0" stop-color="#2f6b45"/><stop offset="1" stop-color="#143320"/></radialGradient>
  <linearGradient id="hd-wood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7a5232"/><stop offset="1" stop-color="#3a2414"/></linearGradient>
  <radialGradient id="hd-lamp" cx=".5" cy=".3" r=".7"><stop offset="0" stop-color="#ffd29a" stop-opacity=".22"/><stop offset="1" stop-color="#000" stop-opacity=".5"/></radialGradient>
  <filter id="hd-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>
  <filter id="hd-glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="30"/></filter></defs>
  <rect x="20" y="20" width="1560" height="860" rx="40" fill="url(#hd-wood)"/><rect x="20" y="20" width="1560" height="860" rx="40" fill="#000" filter="url(#hd-grain)"/>
  <rect x="70" y="70" width="1460" height="760" rx="18" fill="url(#hd-feltG)"/><rect x="70" y="70" width="1460" height="760" rx="18" fill="#000" filter="url(#hd-felt)"/>
  <g transform="translate(1150 170) rotate(7)"><rect x="8" y="12" width="300" height="230" fill="#000" opacity=".35" filter="url(#hd-soft)"/><rect width="300" height="230" fill="#e9dcbc"/>
   <g fill="none" stroke="#3a2414" stroke-width="3"><rect x="24" y="24" width="90" height="62"/><rect x="164" y="40" width="100" height="80"/><rect x="40" y="136" width="74" height="64"/><path d="M114 56L164 78M76 86V136M214 120V170H114"/></g><circle cx="214" cy="80" r="9" fill="#b0262f"/>
   <text x="150" y="222" text-anchor="middle" font-family="Sora" font-size="16" font-weight="600" fill="#3a2414" opacity=".8">The Upside Down</text></g>
  <g transform="translate(170 230) rotate(-6)"><rect x="8" y="12" width="230" height="300" fill="#000" opacity=".35" filter="url(#hd-soft)"/><rect width="230" height="300" fill="#efe4c8"/>
   <text x="20" y="44" font-family="Sora" font-size="22" font-weight="700" fill="#3a2414">Will the Wise</text><text x="20" y="72" font-family="Sora" font-size="15" fill="#6a5034">Cleric · level 3</text>
   <g stroke="#6a5034" stroke-opacity=".4" stroke-width="2"><path d="M20 110h150M20 140h180M20 170h120M20 200h160M20 230h140"/></g><text x="20" y="278" font-family="Sora" font-size="26" font-weight="800" fill="#b0262f">HP 7</text></g>
  <rect x="70" y="70" width="1460" height="760" rx="18" fill="url(#hd-lamp)" pointer-events="none"/>
  <ellipse class="hd-sh" cx="800" cy="620" rx="150" ry="26" fill="#000" opacity=".5" filter="url(#hd-soft)"/>
  <circle class="hd-gl" cx="800" cy="440" r="210" fill="#ffd060" opacity="0" filter="url(#hd-glow)"/>
  <g class="hd-die"></g>`;
  const die = /** @type {SVGGElement} */ (root.querySelector('.hd-die')), dieGl = /** @type {Element} */ (root.querySelector('.hd-gl')), shadow = /** @type {Element} */ (root.querySelector('.hd-sh'));
  // icosahedron silhouette: hexagon outline, central triangle face, six side facets
  const Rr = 150, hex = [...Array(6)].map((_, k) => [Math.cos(k * Math.PI / 3 - Math.PI / 2) * Rr, Math.sin(k * Math.PI / 3 - Math.PI / 2) * Rr]);
  const tri = [[0, -Rr * 0.62], [Rr * 0.54, Rr * 0.31], [-Rr * 0.54, Rr * 0.31]];
  const P = a => a.map(p => p.join(' ')).join(' L');
  const facets = [[hex[0], hex[1], tri[0]], [hex[1], tri[1], tri[0]], [hex[1], hex[2], tri[1]], [hex[2], hex[3], tri[1]], [hex[3], tri[2], tri[1]], [hex[3], hex[4], tri[2]], [hex[4], hex[5], tri[2]], [hex[5], tri[0], tri[2]], [hex[5], hex[0], tri[0]]];
  const shades = ['#c33a4c', '#9a2236', '#7a1628', '#5e0f1e', '#6a1424', '#7e1a2c', '#a02a3c', '#b8344a', '#d0485a'];
  facets.forEach((f, k) => S('path', { d: 'M' + P(f) + 'Z', fill: shades[k], stroke: '#ff9aa8', 'stroke-opacity': 0.35, 'stroke-width': 2, 'stroke-linejoin': 'round' }, die));
  S('path', { d: 'M' + P(tri) + 'Z', fill: '#c8304a', stroke: '#ffb0bc', 'stroke-opacity': 0.5, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }, die);
  S('path', { d: 'M' + P(hex) + 'Z', fill: 'none', stroke: '#3a0610', 'stroke-width': 4, 'stroke-linejoin': 'round' }, die);
  S('path', { d: `M${-Rr * 0.3} ${-Rr * 0.7} L${-Rr * 0.75} ${-Rr * 0.4}`, stroke: '#fff', 'stroke-opacity': 0.4, 'stroke-width': 6, 'stroke-linecap': 'round' }, die);
  const num = S('text', { y: 18, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'Sora', 'font-weight': 800, 'font-size': 64, fill: '#fbeee0' }, die); num.textContent = '20';
  const verdict = document.createElement('div'); Object.assign(verdict.style, { position: 'absolute', left: '50%', bottom: '4%', translate: '-50% 0', padding: '10px 18px', borderRadius: '12px', background: 'rgba(21,23,26,.78)', backdropFilter: 'blur(12px)', font: '600 16px/1.3 Sora', color: GX.text, whiteSpace: 'nowrap', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.09),0 0 0 1px rgba(255,255,255,.07)' });
  verdict.textContent = 'Roll for initiative...'; scene.appendChild(verdict);
  const line = n => n === 20 ? 'NAT 20! The Demogorgon flees.' : n === 1 ? 'Nat 1. It got you. (it always does)' : n >= 15 ? 'Fireball! Solid hit.' : n >= 8 ? 'You hit it. It is annoyed.' : 'Miss. Should have cast protection.';
  const st = { roll: 0, res: 0, best: 0, n: 0, playing: false, t0: 0 };
  const go = () => { if (!st.playing || st.roll) return; st.roll = 1; st.t0 = performance.now(); st.res = 1 + Math.floor(Math.random() * 20); SFX.play('dice'); SFX.play('dice', { delay: 0.45, vol: 0.6 }); verdict.textContent = 'Rolling...'; verdict.style.color = GX.text; dieGl.setAttribute('opacity', '0'); };
  const kd = e => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); go(); } };
  addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd)); root.addEventListener('click', go);
  die.setAttribute('transform', 'translate(800 440)');
  loop(ov, () => {
    if (!st.roll) return;
    const k = Math.min(1, (performance.now() - st.t0) / 1100), e = 1 - Math.pow(1 - k, 3);
    const x = 800 + (reduce ? 0 : Math.sin(k * 9) * 160 * (1 - e)), y = 440 - (reduce ? 0 : Math.abs(Math.sin(k * 11)) * 120 * (1 - e)), rot = reduce ? 0 : (1 - e) * 900;
    die.setAttribute('transform', `translate(${x} ${y}) rotate(${rot})`); shadow.setAttribute('cx', String(x));
    if (k < 1) { const v = 1 + ((k * 40) | 0) % 20; if (num.textContent !== String(v)) num.textContent = String(v); return; }
    st.roll = 0; num.textContent = String(st.res); st.n++; st.best = Math.max(st.best, st.res);
    hud.set('n', st.n, { count: true }); hud.set('best', st.best); hud.set('last', st.res, { tone: st.res === 20 ? 'up' : st.res === 1 ? 'bad' : undefined });
    if (st.res !== 20 && st.res !== 1) hud.set('last', st.res, { tone: GX.text });
    SFX.play(st.res === 20 ? 'win' : st.res === 1 ? 'fail' : st.res >= 15 ? 'success' : st.res >= 8 ? 'score' : 'ui.deny');
    verdict.textContent = line(st.res); verdict.style.color = st.res === 20 ? GX.success : st.res === 1 ? GX.error : st.res >= 15 ? GX.warning : GX.text;
    const r = die.getBoundingClientRect(); K.pop(r.left + r.width / 2, r.top - 10, st.res === 20 ? 'NAT 20!' : st.res === 1 ? 'Nat 1' : String(st.res), st.res === 20 ? 'up' : st.res === 1 ? 'bad' : st.res >= 15 ? 'gold' : undefined);
    if (st.res >= 15) { dieGl.setAttribute('fill', st.res === 20 ? GX.success : '#ffd060'); dieGl.setAttribute('opacity', '0.35'); }
    if (st.res === 20) K.swell();
    if (st.res === 1 && !reduce) scene.animate([{ transform: 'translate(0)' }, { transform: 'translate(-8px,3px)' }, { transform: 'translate(7px,-2px)' }, { transform: 'translate(0)' }], { duration: 420 });
  });
  K.card({ title: 'Roll for initiative', text: 'One d20. Beat the monster mini.', how: [[['Space', 'Click'], 'roll']], cta: 'Roll', onGo: () => { st.playing = true; go(); } });
}

/** @type {any[]} */
export default [

  { id: 'hawkins-lights', match: on('alphabet'), label: () => 'Talk through the lights', sfx: 'hawkins.bulb', start: lights },
  { id: 'hawkins-d20', match: on('dnd'), label: () => 'Roll a d20', sfx: 'cards', start: d20 },
];
