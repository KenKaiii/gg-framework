// @ts-check
// Films B: "PC LOAD LETTER?!" printer smashing, rebuilt on the GX kit. A beige office laser printer on a desk under
// the fluorescent strip; a baseball bat; each hit cracks it more until it's scrap. Best time kept for the session.
import { SFX } from '../sfx.js';
import { loop, rng } from './util.js';
import { gx, svg as S, GX } from './gx.js';

/** @param {any} ctx */
export function printerGame(ctx) {
  const ov = ctx.overlay({ title: 'PC LOAD LETTER?!', sub: 'the printer had it coming', help: '<kbd>space</kbd>/<kbd>click</kbd> smash <kbd>r</kbd> new printer (after)' });
  const K = gx(ov), reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hud = K.hud([{ id: 'hp', label: 'Printer', value: '100%', tone: 'up' }, { id: 'hits', label: 'Hits' }], [{ id: 'best', label: 'Best time', value: '-', tone: 'teal' }]);
  const scene = K.scene({ aspect: 16 / 10, maxW: 1100 }); scene.style.cursor = 'pointer';
  const root = S('svg', { viewBox: '0 0 1600 1000', width: '100%', height: '100%', role: 'img', 'aria-label': 'Office printer' }, scene);
  Object.assign(root.style, { position: 'absolute', inset: '0', overflow: 'visible' });
  root.innerHTML = `<defs>
  <linearGradient id="pr-body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e4ddc8"/><stop offset=".5" stop-color="#cdc5ad"/><stop offset="1" stop-color="#a69e86"/></linearGradient>
  <linearGradient id="pr-top" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2ecda"/><stop offset="1" stop-color="#d6cfb9"/></linearGradient>
  <linearGradient id="pr-desk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a8f98"/><stop offset=".1" stop-color="#5f646c"/><stop offset="1" stop-color="#363a40"/></linearGradient>
  <linearGradient id="pr-lcd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2c4a2a"/><stop offset="1" stop-color="#16281a"/></linearGradient>
  <linearGradient id="pr-bat" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6a4224"/><stop offset=".4" stop-color="#c08a52"/><stop offset="1" stop-color="#7a4c28"/></linearGradient>
  <radialGradient id="pr-fluo" cx=".5" cy="0" r=".8"><stop offset="0" stop-color="#e8f4ff" stop-opacity=".25"/><stop offset="1" stop-color="#e8f4ff" stop-opacity="0"/></radialGradient>
  <linearGradient id="pr-sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".10"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".16"/></linearGradient>
  <filter id="pr-tex"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="7"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .18 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
  <filter id="pr-soft" x="-30%" y="-50%" width="160%" height="200%"><feGaussianBlur stdDeviation="18"/></filter>
  <filter id="pr-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
  <ellipse cx="800" cy="300" rx="760" ry="420" fill="url(#pr-fluo)"/>
  <path d="M140 720 L1460 720 L1520 800 L80 800 Z" fill="url(#pr-desk)"/><rect x="80" y="800" width="1440" height="26" fill="#2a2d32"/>
  <ellipse cx="780" cy="720" rx="420" ry="30" fill="#000" opacity=".55" filter="url(#pr-soft)"/>
  <g class="pr-wrap"><g class="pr-printer">
   <path d="M420 380 L1140 380 L1160 700 Q1160 716 1144 716 L416 716 Q400 716 400 700 Z" fill="url(#pr-body)"/>
   <path d="M420 380 L1140 380 L1160 700 Q1160 716 1144 716 L416 716 Q400 716 400 700 Z" fill="url(#pr-sheen)"/>
   <path d="M440 300 L1120 300 L1140 380 L420 380 Z" fill="url(#pr-top)"/>
   <rect x="500" y="330" width="560" height="26" rx="6" fill="#26262a"/>
   <path class="pr-paper" d="M530 340 L1030 340 L1050 210 L510 210 Z" fill="#f6f2e6"/>
   <rect x="440" y="600" width="680" height="80" rx="8" fill="#9c947c"/><rect x="460" y="612" width="640" height="10" rx="5" fill="#000" opacity=".2"/>
   <rect x="800" y="420" width="290" height="80" rx="10" fill="#3a3a3e"/><rect x="814" y="432" width="262" height="56" rx="6" fill="url(#pr-lcd)"/>
   <text class="pr-lcdT" x="945" y="470" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-weight="700" font-size="30" fill="#9cf596" style="text-shadow:0 0 8px rgba(156,245,150,.7)">PC LOAD</text>
   <circle cx="480" cy="440" r="20" fill="#ff3a2a" opacity=".22"/><circle class="pr-err" cx="480" cy="440" r="11" fill="#ff3a2a"/>
   <g fill="#5c584c"><rect x="510" y="430" width="56" height="22" rx="11"/><rect x="580" y="430" width="56" height="22" rx="11"/></g>
   <g class="pr-cracks" fill="none" stroke="#2a2620" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></g>
   <g class="pr-hole" opacity="0"><path d="M450 500 l60 -10 l20 40 l-30 50 l-50 -10 z" fill="#14100c"/><rect x="465" y="520" width="38" height="22" fill="#2e6a3a"/><circle cx="475" cy="530" r="4" fill="#c99a4a"/><circle cx="492" cy="534" r="4" fill="#c99a4a"/></g>
  </g></g>
  <g class="pr-scrap" opacity="0"><rect x="560" y="660" width="460" height="56" rx="8" fill="#9c947c"/><path d="M600 660 L700 600 L780 640 L900 590 L990 660 Z" fill="#cdc5ad"/><rect x="1060" y="690" width="80" height="26" fill="#bdb6a2" transform="rotate(12 1100 700)"/></g>
  <g class="pr-parts"></g>
  <g class="pr-bat" transform="translate(1340 760) rotate(25)"><rect x="-22" y="-470" width="44" height="300" rx="22" fill="url(#pr-bat)"/><rect x="-14" y="-190" width="28" height="170" rx="10" fill="#7a4c28"/><rect x="-20" y="-24" width="40" height="18" rx="8" fill="#2a1a10"/></g>`;
  const q = s => /** @type {any} */ (root.querySelector(s));
  const printer = q('.pr-printer'), paper = q('.pr-paper'), lcd = q('.pr-lcdT'), err = q('.pr-err'), cracks = q('.pr-cracks'), hole = q('.pr-hole'), scrap = q('.pr-scrap'), parts = q('.pr-parts'), bat = q('.pr-bat'), wrap = q('.pr-wrap');
  const r = rng(7), COL = ['#bdb6a2', '#8e8878', '#2a2a2e', '#2e6a3a', '#ece6d8', '#c99a4a'];
  const st = { hp: 100, hits: 0, dead: false, best: 0, t0: 0, time: 0, swing: 0, playing: false, shake: 0 };
  /** @type {{el:any,x:number,y:number,vx:number,vy:number,rot:number,life:number}[]} */ let ps = [];
  const burst = (n, big) => { for (let i = 0; i < n; i++) { const a = -Math.PI * (0.1 + r() * 0.8), v = (big ? 500 : 300) + r() * (big ? 900 : 500), s = 10 + r() * 22;
    const el = S('rect', { x: -s / 2, y: -s / 2, width: s, height: s * (0.5 + r()), rx: 2, fill: COL[(r() * COL.length) | 0] }, parts);
    ps.push({ el, x: 780 + (r() - 0.5) * 300, y: 460 - r() * 100, vx: Math.cos(a) * v * (r() < 0.5 ? -1 : 1), vy: Math.sin(a) * v, rot: r() * 360, life: 2.5 }); } };
  const crackAt = i => { const cx = 440 + ((i * 137) % 640), cy = 400 + ((i * 89) % 280); S('path', { d: `M${cx} ${cy} l${30 - (i % 3) * 25} 35 l-12 40 l${18 + (i % 2) * 12} 30`, opacity: 0.85 }, cracks); };
  const reset = () => { st.hp = 100; st.hits = 0; st.dead = false; st.t0 = 0; st.time = 0; cracks.replaceChildren(); parts.replaceChildren(); ps = [];
    printer.setAttribute('opacity', '1'); scrap.setAttribute('opacity', '0'); hole.setAttribute('opacity', '0'); hud.set('hp', '100%', { tone: 'up' }); hud.set('hits', 0); ov.setSub('the printer had it coming'); st.playing = true; };
  const hit = () => {
    if (!st.playing || st.dead) return; if (!st.t0) st.t0 = performance.now();
    const dmg = 5 + (r() * 7 | 0); st.hp = Math.max(0, st.hp - dmg); st.hits++; st.swing = 1; st.shake = 1;
    SFX.play('punch', { vol: 0.5, jitter: 0.1 }); SFX.play('rattle', { vol: 0.3, delay: 0.05 });
    burst(5 + (r() * 5 | 0), false); crackAt(st.hits); if (st.hp <= 50) hole.setAttribute('opacity', '1');
    hud.set('hp', st.hp + '%', { tone: st.hp > 50 ? 'up' : st.hp > 20 ? 'gold' : 'bad' }); hud.set('hits', st.hits, { count: true });
    const b = printer.getBoundingClientRect(); K.pop(b.left + b.width * (0.3 + r() * 0.4), b.top + b.height * 0.2, '-' + dmg, 'gold');
    if (st.hp <= 0) {
      st.dead = true; st.playing = false; st.time = (performance.now() - st.t0) / 1000; burst(60, true); printer.setAttribute('opacity', '0'); scrap.setAttribute('opacity', '1');
      SFX.play('arcade.boom', { vol: 0.6, pitch: 0.6 }); SFX.play('win', { delay: 0.4 }); K.swell(); ov.setSub('printer: 0. you: 1.');
      const nb = !st.best || st.time < st.best; st.best = nb ? st.time : st.best; hud.set('best', st.best.toFixed(1) + 's');
      setTimeout(() => ov.el.isConnected && K.result({ title: 'Destroyed', big: st.time.toFixed(1) + 's', best: nb, line: 'Printer: 0. You: 1.', stats: [[st.hits, 'Hits'], [st.best.toFixed(1) + 's', 'Best time']], again: 'New printer', onAgain: () => { SFX.play('pc.boot', { vol: 0.4 }); reset(); } }), 900);
    }
  };
  const kd = e => { if (e.code === 'Escape') return; if (e.code === 'KeyR' && st.dead) { SFX.play('pc.boot', { vol: 0.4 }); reset(); e.preventDefault(); return; } if (!e.repeat && /Space|Enter|Key[A-Z]|Digit/.test(e.code) && st.playing) { e.preventDefault(); hit(); } };
  addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd));
  scene.addEventListener('pointerdown', e => { if (e.button === 0) hit(); });
  let lcdOn = true, lt = 0, errOn = true;
  loop(ov, (dt, t) => {
    st.swing = Math.max(0, st.swing - dt * 5); st.shake = Math.max(0, st.shake - dt * 6);
    bat.setAttribute('transform', `translate(1340 760) rotate(${25 - st.swing * 70})`);
    const dmg = 1 - st.hp / 100, sx = reduce ? 0 : Math.sin(t * 70) * 14 * st.shake;
    wrap.setAttribute('transform', `translate(${sx} 0) rotate(${dmg * 6 * Math.sin(st.hits)} 780 716)`);
    paper.setAttribute('opacity', st.hp > 30 ? '1' : '0');
    if (t - lt > 1.6) { lt = t; lcdOn = !lcdOn; lcd.textContent = lcdOn ? 'PC LOAD' : 'LETTER'; errOn = !errOn; err.setAttribute('opacity', errOn ? '1' : '.25'); }
    for (const p of ps) { p.vy += 1600 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += dt * 400; if (p.y > 740) { p.y = 740; p.vy *= -0.35; p.vx *= 0.6; p.rot *= 0.9; } p.life -= dt; p.el.setAttribute('transform', `translate(${p.x} ${p.y}) rotate(${p.rot})`); }
    ps = ps.filter(p => { if (p.life > 0 || st.dead) return true; p.el.remove(); return false; });
  });
  K.card({ title: 'PC LOAD LETTER?!', text: 'The printer had it coming. Smash it to scrap as fast as you can.', how: [[['Space', 'Click'], 'smash']], cta: 'Grab the bat', onGo: reset });
}
