// @ts-check
// Jack's typewriter close-up: a page filling live with the same line, slightly off-kilter, typos and all.
// Hold Space (or mash any key) to type faster; a full page slides out onto the stack.
import { loop, rng, keys } from './util.js';
import { SFX } from '../sfx.js';
import { gx, svg as S, GX } from './gx.js';

const LINE = 'All work and no play makes Jack a dull boy.';
const VARIANTS = [LINE, LINE, LINE, 'All work and no play makes Jack a dull boy', 'ALL WORK AND NO PLAY MAKES JACK A DULL BOY.',
  'All work and no play makes Jack a dull  boy.', 'All work and no play makes jack a dull boy.', 'All work and no ply makes Jack a dull boy.', 'Allwork and no play makes Jack a dull boy.'];

/** @param {any} ctx */
export function startTypewriter(ctx) {
  const ov = ctx.overlay({ title: 'The Typewriter', sub: 'Overlook Hall · page 1', help: '<kbd>hold space</kbd> type faster <kbd>hold click</kbd> type faster' });
  const G = gx(ov), reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hud = G.hud([{ id: 'page', label: 'Page', value: 1, tone: 'gold' }, { id: 'keys', label: 'Keystrokes' }], [{ id: 'speed', label: 'Speed', value: 'Slow' }]);
  const scene = G.scene({ aspect: 4 / 3, maxW: 900 }); scene.style.cursor = 'pointer';
  if (!document.getElementById('ovt-style')) { const s = document.createElement('style'); s.id = 'ovt-style'; s.textContent = `
.ovt-paper{position:absolute;left:21%;width:58%;top:0;height:66%;overflow:hidden;background:linear-gradient(#f4ecd6,#e3d5b4);box-shadow:0 18px 30px -12px rgba(0,0,0,.7),inset 0 0 40px rgba(140,100,50,.18);transform:rotate(-.7deg);transform-origin:50% 100%}
.ovt-paper::before{content:"";position:absolute;inset:0 auto 0 8%;width:1px;background:rgba(200,60,60,.3)}
.ovt-lines{position:absolute;left:11%;right:5%;top:7%;font:400 2.4cqh/1.6 "Courier Prime","Courier New",Courier,monospace;color:#1a1410;white-space:pre}
.ovt-lines div{transition:none}
.ovt-pg{position:absolute;bottom:3%;left:0;right:0;text-align:center;font:500 1.8cqh "Courier New",monospace;color:#6a5a44}
.ovt-paper.out{transition:translate .62s cubic-bezier(.5,0,.75,0),opacity .62s;translate:0 -120%;opacity:0}
.ovt-wendy{position:absolute;left:3%;top:30%;font:600 2.4cqh Sora;color:${GX.lampDeep};opacity:0;transition:opacity 2s}
.ovt-ding{position:absolute;right:6%;top:52%;font:700 2.6cqh Sora;color:${GX.warning};opacity:0}
.ovt-ding.on{animation:ovt-d .7s ease-out}@keyframes ovt-d{0%{opacity:1;translate:0 0}100%{opacity:0;translate:0 -2cqh}}
@media (prefers-reduced-motion:reduce){.ovt-paper.out{transition:none}.ovt-ding.on{animation:none}}`; document.head.appendChild(s); }
  const paperEl = document.createElement('div'); paperEl.className = 'ovt-paper'; paperEl.innerHTML = '<div class="ovt-lines"></div><div class="ovt-pg"></div>';
  const linesEl = /** @type {HTMLElement} */ (paperEl.querySelector('.ovt-lines')), pgEl = /** @type {HTMLElement} */ (paperEl.querySelector('.ovt-pg'));
  scene.appendChild(paperEl);
  // the machine: a black enamel Royal with chrome carriage, gold pinstripes and four rows of glass-topped keys
  const m = S('svg', { viewBox: '0 0 1000 420', width: '100%', role: 'img', 'aria-label': 'Typewriter' }, scene);
  Object.assign(m.style, { position: 'absolute', left: '0', bottom: '0', overflow: 'visible' });
  m.innerHTML = `<defs>
  <linearGradient id="ovt-body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34303a"/><stop offset=".25" stop-color="#1c1a20"/><stop offset="1" stop-color="#08070a"/></linearGradient>
  <linearGradient id="ovt-chrome" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f6fa"/><stop offset=".45" stop-color="#8a9099"/><stop offset=".55" stop-color="#4a4f57"/><stop offset="1" stop-color="#c8ccd2"/></linearGradient>
  <linearGradient id="ovt-platen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3a3e"/><stop offset=".4" stop-color="#121214"/><stop offset="1" stop-color="#050506"/></linearGradient>
  <radialGradient id="ovt-knob" cx=".35" cy=".3"><stop offset="0" stop-color="#ffe6a8"/><stop offset=".6" stop-color="#b8862e"/><stop offset="1" stop-color="#5a3c10"/></radialGradient>
  <radialGradient id="ovt-key" cx=".4" cy=".3"><stop offset="0" stop-color="#fffaf0"/><stop offset=".7" stop-color="#e8dfc8"/><stop offset="1" stop-color="#b8ad94"/></radialGradient>
  <radialGradient id="ovt-lamp" cx=".35" cy="0" r=".9"><stop offset="0" stop-color="#ffd29a" stop-opacity=".22"/><stop offset="1" stop-color="#ffd29a" stop-opacity="0"/></radialGradient>
  <filter id="ovt-sh" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="16"/></filter></defs>
  <ellipse cx="500" cy="405" rx="470" ry="22" fill="#000" opacity=".6" filter="url(#ovt-sh)"/>
  <path d="M110 130 L890 130 L960 390 Q960 408 940 408 L60 408 Q40 408 40 390 Z" fill="url(#ovt-body)"/>
  <path d="M118 140 L882 140 L948 384 L52 384 Z" fill="none" stroke="#b8862e" stroke-opacity=".55" stroke-width="2"/>
  <path d="M110 130 L890 130 L960 390 Q960 408 940 408 L60 408 Q40 408 40 390 Z" fill="url(#ovt-lamp)"/>
  <text x="500" y="190" text-anchor="middle" font-family="Sora" font-weight="800" font-size="30" letter-spacing="14" fill="#d8aa52">ROYAL</text>
  <g class="ovt-keys"></g>
  <g class="ovt-car"><rect x="20" y="58" width="960" height="18" rx="9" fill="url(#ovt-chrome)"/><rect x="60" y="76" width="880" height="54" rx="27" fill="url(#ovt-platen)"/>
   <rect x="60" y="82" width="880" height="6" rx="3" fill="#fff" opacity=".08"/><circle cx="34" cy="103" r="34" fill="url(#ovt-knob)"/><circle cx="966" cy="103" r="34" fill="url(#ovt-knob)"/>
   <path d="M940 60 L1000 20 L1010 32 L956 72 Z" fill="url(#ovt-chrome)"/></g>`;
  const keysG = /** @type {Element} */ (m.querySelector('.ovt-keys')), car = /** @type {Element} */ (m.querySelector('.ovt-car'));
  /** @type {Element[]} */ const keyEls = [];
  [[11, 236], [11, 278], [10, 320], [9, 360]].forEach(([n, y], row) => { for (let i = 0; i < n; i++) { const x = 500 + (i - (n - 1) / 2) * 66 + row * 6;
    const g = S('g', { transform: `translate(${x} ${y})` }, keysG); S('ellipse', { cy: 6, rx: 24, ry: 12, fill: '#000', opacity: 0.6 }, g);
    const top = S('g', {}, g); S('circle', { r: 23, fill: 'url(#ovt-chrome)' }, top); S('circle', { r: 18, fill: 'url(#ovt-key)' }, top);
    S('text', { y: 6, 'text-anchor': 'middle', 'font-family': 'Sora', 'font-weight': 700, 'font-size': 15, fill: '#2a2420' }, top).textContent = 'QWERTYUIOPASDFGHJKLZXCVBNM.,;:?!-'[(row * 11 + i) % 33];
    keyEls.push(top); } });
  const space = S('rect', { x: 330, y: 386, width: 340, height: 14, rx: 7, fill: 'url(#ovt-chrome)' }, keysG);
  const wendy = document.createElement('div'); wendy.className = 'ovt-wendy'; wendy.textContent = 'Wendy? ...darling?';
  const ding = document.createElement('div'); ding.className = 'ovt-ding'; ding.textContent = 'ding!'; scene.append(wendy, ding);
  const fitM = () => { const h = scene.clientWidth * 0.42; m.style.height = h + 'px'; paperEl.style.height = (scene.clientHeight - h * 0.72) + 'px'; };
  fitM(); addEventListener('resize', fitM); ov.onClose(() => removeEventListener('resize', fitM));

  const K = keys(ov); let mash = 0; const onKey = e => { if (e.code !== 'Escape') mash = 0.4; }; addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  let held = false; scene.addEventListener('pointerdown', e => { if (e.button === 0) { held = true; scene.setPointerCapture?.(e.pointerId); } }); const up = () => { held = false; }; scene.addEventListener('pointerup', up); scene.addEventListener('pointercancel', up);
  const r = rng(237);
  const mkLine = () => ({ s: VARIANTS[Math.floor(r() * VARIANTS.length)], dx: Math.round((r() - 0.5) * 14), dy: Math.round((r() - 0.5) * 2), ink: 0.75 + r() * 0.25 });
  const st = { t: 0, lines: [mkLine()], n: 0, acc: 0, page: 1, slide: 0, playing: false, fast: false, lastKey: -1 };
  const PER = 12; let typed = 0, curEl = /** @type {HTMLElement | null} */ (null);
  const newLineEl = l => { const d = document.createElement('div'); d.style.cssText = `opacity:${l.ink};translate:${l.dx * 0.12}cqh ${l.dy * 0.1}cqh`; linesEl.appendChild(d); curEl = d; };
  const newPage = () => { linesEl.replaceChildren(); st.lines = [mkLine()]; st.n = 0; newLineEl(st.lines[0]); pgEl.textContent = '- ' + st.page + ' -'; };
  newPage();
  loop(ov, dt => {
    if (!st.playing) return;
    st.t += dt; mash = Math.max(0, mash - dt);
    const fast = K.has('Space') || held || mash > 0; const cps = fast ? 55 : 16;
    if (fast !== st.fast) { st.fast = fast; hud.set('speed', fast ? 'Fast' : 'Slow', { tone: fast ? 'bad' : GX.text }); }
    if (st.slide > 0) { st.slide -= dt * 1.6; if (st.slide <= 0) { st.slide = 0; SFX.play('paper'); if (st.page === 2) { SFX.play('eerie', { vol: 0.5, delay: 0.3 }); G.swell(); } st.page++; hud.set('page', st.page); ov.setSub('Overlook Hall · page ' + st.page);
      paperEl.classList.remove('out'); newPage(); if (st.page > 2) wendy.style.opacity = '1'; } return; }
    st.acc += dt * cps;
    while (st.acc >= 1) { st.acc--; const cur = st.lines[st.lines.length - 1]; st.n++; typed++;
      const ch = cur.s[st.n - 1]; if (ch && ch !== ' ') SFX.play('typewriter', { vol: 0.6, jitter: 0.08 });
      if (curEl) curEl.textContent = cur.s.slice(0, st.n);
      const k = ch === ' ' ? -2 : Math.floor(r() * keyEls.length);
      if (st.lastKey >= 0) keyEls[st.lastKey].setAttribute('transform', ''); space.setAttribute('transform', '');
      if (k >= 0) { keyEls[k].setAttribute('transform', 'translate(0 5) scale(.94)'); st.lastKey = k; } else space.setAttribute('transform', 'translate(0 4)');
      if (st.n > cur.s.length) { SFX.play('typewriter.ding', { vol: 0.7 }); ding.classList.remove('on'); void ding.offsetWidth; ding.classList.add('on');
        if (st.lines.length >= PER) { st.slide = 1; if (!reduce) paperEl.classList.add('out'); break; } const l = mkLine(); st.lines.push(l); st.n = 0; newLineEl(l); } }
    const cur = st.lines[st.lines.length - 1], f = cur ? Math.min(1, st.n / cur.s.length) : 0;
    car.setAttribute('transform', `translate(${(0.5 - f) * 120} 0)`); paperEl.style.translate = `${(0.5 - f) * 12}% 0`;
    hud.set('keys', Math.floor(typed));
  });
  G.card({ title: 'The Typewriter', text: 'All work and no play. Keep the pages coming.', how: [[['Hold Space'], 'type faster'], [['Hold click'], 'type faster']], cta: 'Sit down', onGo: () => { st.playing = true; } });
}
