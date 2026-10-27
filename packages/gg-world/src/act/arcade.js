// @ts-check
// Arcade activity: the den's arcade row plays BUG INVADERS. Rebuilt on the GX kit (concept: showcase/minigames/
// concepts/arcade.html): a real cabinet (neon marquee, bezel, CRT under glass, 7-segment LED readouts, stick and
// buttons that move) drawn in DOM/SVG at screen res; the game picture stays pixel art, scaled crisp onto the CRT.
import { keys, loop, rng } from './util.js';
import { bugInvaders } from './arcade-game.js';
import { gx } from './gx.js';

const SEG = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abcdfg'];
const SP = { a: 'M2 0h8l-1.5 1.5h-5z', b: 'M10.5 .5v8l-1.5-1v-6z', c: 'M10.5 9.5v8l-1.5-1.5v-5.5z', d: 'M2 18h8l-1.5-1.5h-5z',
  e: 'M1.5 9.5v8l1.5-1.5v-5.5z', f: 'M1.5 .5v8l1.5-1v-6z', g: 'M2.5 9h7l-1 -.9h-5z M2.5 9h7l-1 .9h-5z' };
/** @param {SVGElement} el @param {number} n */
function led(el, n, digits = 6) {
  const s = String(n).padStart(digits, ' ').slice(-digits); let h = '';
  [...s].forEach((ch, i) => { const on = ch === ' ' ? '' : SEG[+ch]; for (const k of 'abcdefg') h += `<path transform="translate(${i * 13} 0) skewX(-6)" class="${on.includes(k) ? 'on' : 'off'}" d="${SP[k]}"/>`; });
  el.setAttribute('viewBox', `-1 -1 ${digits * 13 + 1} 20`); el.innerHTML = h;
}
const CSS = `
.ac{position:absolute;inset:0;--u:calc(100cqh/80)}
.ac .side{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.ac .body{position:absolute;left:8.5%;right:8.5%;top:0;bottom:0;display:flex;flex-direction:column}
.ac .mq{position:relative;height:calc(11*var(--u));border-radius:calc(1.2*var(--u)) calc(1.2*var(--u)) 0 0;background:linear-gradient(180deg,#2a1640,#1a0f2b);display:grid;place-items:center;overflow:hidden;box-shadow:inset 0 0 0 calc(.35*var(--u)) #3b2556,inset 0 calc(-.6*var(--u)) 0 #0c0716,0 0 calc(5*var(--u)) rgba(255,95,210,.35)}
.ac .mq::before{content:"";position:absolute;inset:calc(.9*var(--u));border-radius:calc(.8*var(--u));background:radial-gradient(ellipse 80% 120% at 50% 0%,rgba(255,210,154,.16),transparent 60%),repeating-linear-gradient(90deg,rgba(155,123,255,.07) 0 2px,transparent 2px 14px),#160b24;box-shadow:inset 0 0 calc(2*var(--u)) rgba(155,123,255,.4)}
.ac .mq svg{position:relative;width:92%;height:80%;overflow:visible}
.ac .tube{font:800 46px/1 Sora,sans-serif;letter-spacing:.04em;fill:none;stroke-linecap:round;stroke-linejoin:round}
.ac .tube.halo{stroke:#ff5fd2;stroke-width:7;opacity:.55;filter:url(#ac-bloom)}.ac .tube.core{stroke:#ffe3f6;stroke-width:1.6}.ac .tube.mid{stroke:#ff5fd2;stroke-width:3.4}
.ac .hum{animation:ac-hum 4s ease-in-out infinite}@keyframes ac-hum{50%{opacity:.86}}
.ac .bz{position:relative;flex:1;margin:0 calc(.6*var(--u));padding:calc(3*var(--u)) calc(3.2*var(--u)) calc(3.6*var(--u));background:linear-gradient(180deg,#120a1d,#0b0713);box-shadow:inset 0 calc(1.4*var(--u)) calc(2*var(--u)) rgba(0,0,0,.8);display:flex;flex-direction:column}
.ac .art{position:absolute;inset:calc(1*var(--u));border-radius:calc(1*var(--u));pointer-events:none;background:radial-gradient(circle at 6% 92%,rgba(255,95,210,.35) 0 2%,transparent 2.4%),radial-gradient(circle at 94% 8%,rgba(155,123,255,.4) 0 1.6%,transparent 2%),linear-gradient(135deg,rgba(155,123,255,.22),transparent 30%,transparent 70%,rgba(255,95,210,.22)),#1b1030;box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)}
.ac .art::after{content:"INSERT COIN  ·  1 PLAYER  ·  25¢";position:absolute;left:0;right:0;bottom:calc(.5*var(--u));text-align:center;font:600 calc(1.25*var(--u))/1 Sora,sans-serif;letter-spacing:.32em;color:rgba(255,190,240,.55)}
.ac .crt{position:relative;flex:1;border-radius:calc(2.4*var(--u))/calc(2*var(--u));overflow:hidden;background:#05040a;box-shadow:0 0 0 calc(.5*var(--u)) #07050c,0 0 0 calc(.8*var(--u)) rgba(155,123,255,.25),inset 0 0 calc(4*var(--u)) rgba(0,0,0,.9)}
.ac .bn{position:absolute;left:4%;right:4%;top:58%;text-align:center;pointer-events:none;font:800 calc(2.4*var(--u))/1.2 Sora,sans-serif;color:#ffe3f6;text-shadow:0 0 12px rgba(255,95,210,.8),0 2px 8px rgba(0,0,0,.7);animation:ac-bn 1.6s cubic-bezier(.22,1,.36,1) forwards}
@keyframes ac-bn{0%{opacity:0;translate:0 30%}15%{opacity:1;translate:0 0}75%{opacity:1}100%{opacity:0;translate:0 -40%}}
.ac .crt canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.ac .scan{position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(180deg,rgba(0,0,0,.22) 0 1px,transparent 1px 3px);mix-blend-mode:multiply}
.ac .glass{position:absolute;inset:0;pointer-events:none;border-radius:inherit;background:radial-gradient(ellipse 70% 40% at 30% 8%,rgba(255,255,255,.10),transparent 60%),linear-gradient(115deg,transparent 55%,rgba(255,255,255,.04) 62%,transparent 70%);box-shadow:inset 0 0 calc(5*var(--u)) rgba(0,0,0,.85),inset 0 0 calc(1.2*var(--u)) rgba(155,123,255,.25)}
.ac .leds{position:relative;display:flex;justify-content:space-between;align-items:center;gap:calc(1*var(--u));margin-top:calc(1.6*var(--u))}
.ac .led{display:flex;align-items:center;gap:calc(.8*var(--u));padding:calc(.5*var(--u)) calc(.9*var(--u));border-radius:calc(.6*var(--u));background:#07040c;box-shadow:inset 0 1px 3px rgba(0,0,0,.9),0 0 0 1px rgba(255,255,255,.05)}
.ac .led small{font:600 calc(1.1*var(--u))/1 Sora,sans-serif;letter-spacing:.14em;color:rgba(255,190,240,.7)}
.ac .led svg{height:calc(2.6*var(--u));width:calc(10.5*var(--u));display:block}
.ac .led .on{fill:#ff6fd8;filter:drop-shadow(0 0 2px rgba(255,95,210,.9))}.ac .led .off{fill:rgba(255,95,210,.07)}
.ac .led.hi .on{fill:#b9a4ff;filter:drop-shadow(0 0 2px rgba(155,123,255,.9))}
.ac .lives{display:flex;gap:calc(.5*var(--u))}
.ac .lives i{width:calc(1.2*var(--u));height:calc(1.2*var(--u));border-radius:50%;background:#44e3cf;box-shadow:0 0 6px #44e3cf}.ac .lives i.off{background:rgba(68,227,207,.12);box-shadow:none}
.ac .pn{position:relative;height:calc(13*var(--u));margin:0 calc(-1.2*var(--u));border-radius:calc(.6*var(--u)) calc(.6*var(--u)) calc(1.4*var(--u)) calc(1.4*var(--u));background:linear-gradient(180deg,#3a2552 0,#24163a 18%,#1a102a 70%,#0f0919);box-shadow:inset 0 1px 0 rgba(255,255,255,.18),inset 0 calc(.4*var(--u)) 0 rgba(155,123,255,.25),0 calc(2*var(--u)) calc(4*var(--u)) -1px rgba(0,0,0,.8)}
.ac .pn::before{content:"";position:absolute;left:4%;right:4%;top:22%;bottom:18%;border-radius:calc(1*var(--u));background:linear-gradient(100deg,rgba(155,123,255,.18),rgba(255,95,210,.12)),#140c22;box-shadow:inset 0 1px 2px rgba(0,0,0,.8),0 1px 0 rgba(255,255,255,.06)}
.ac .stick{position:absolute;left:22%;top:52%;width:calc(5.6*var(--u));height:calc(3*var(--u));translate:-50% -50%;border-radius:50%;background:radial-gradient(ellipse at 50% 40%,#2b2b33,#0a0a0e);box-shadow:inset 0 1px 0 rgba(255,255,255,.12)}
.ac .shaft{position:absolute;left:50%;bottom:50%;width:calc(.9*var(--u));height:calc(5.5*var(--u));translate:-50% 0;transform-origin:50% 100%;background:linear-gradient(90deg,#666,#ddd 40%,#777);border-radius:2px;transition:rotate .12s cubic-bezier(.22,1,.36,1)}
.ac .ball{position:absolute;left:50%;top:calc(-3.2*var(--u));width:calc(4.4*var(--u));height:calc(4.4*var(--u));translate:-50% 0;border-radius:50%;background:radial-gradient(circle at 36% 30%,#fff 0 6%,#ff9fe6 14%,#ff4fc8 45%,#8a1067 100%);box-shadow:0 calc(.6*var(--u)) calc(1*var(--u)) rgba(0,0,0,.6),0 0 calc(2*var(--u)) rgba(255,95,210,.35)}
.ac .btns{position:absolute;left:58%;top:52%;translate:0 -50%;display:flex;gap:calc(2.4*var(--u))}
.ac .pb{width:calc(4.6*var(--u));height:calc(4.6*var(--u));border-radius:50%;position:relative;background:radial-gradient(circle at 50% 50%,#0b0710 60%,#2b1f3a 66%,#0b0710 72%)}
.ac .pb::after{content:"";position:absolute;inset:14%;border-radius:50%;background:radial-gradient(circle at 50% 62%,var(--c1) 0 30%,var(--c2) 70%),var(--c2);box-shadow:inset 0 calc(.5*var(--u)) calc(.6*var(--u)) rgba(0,0,0,.45),inset 0 calc(-.3*var(--u)) 0 rgba(255,255,255,.25),0 calc(.5*var(--u)) 0 var(--c3),0 0 calc(1.6*var(--u)) var(--c2);transition:translate .06s,box-shadow .06s}
.ac .pb.a{--c1:#c9b8ff;--c2:#8d6bff;--c3:#3d2a86}.ac .pb.b{--c1:#ffc6ee;--c2:#ff5fd2;--c3:#8a1a6c}
.ac .pb.down::after{translate:0 calc(.45*var(--u));box-shadow:inset 0 calc(.7*var(--u)) calc(.8*var(--u)) rgba(0,0,0,.55),0 0 0 var(--c3),0 0 calc(2.6*var(--u)) var(--c2)}
.ac .kick{height:calc(3*var(--u));margin:0 calc(.4*var(--u));background:linear-gradient(180deg,#0e0818,#07040c);border-radius:0 0 calc(.6*var(--u)) calc(.6*var(--u))}
.ac .floor{position:absolute;left:50%;bottom:calc(-2*var(--u));width:110%;height:calc(5*var(--u));translate:-50% 0;border-radius:50%;background:radial-gradient(ellipse,rgba(0,0,0,.7),transparent 70%);z-index:-1}
@media (prefers-reduced-motion: reduce){.ac .hum,.ac .bn{animation:none}.ac .shaft{transition:none}}`;

export default [{
  id: 'arcade', label: () => 'Insert coin',
  match: (it, R) => R?.id === 'den' && it.id === 'arcade',
  /** @param {any} ctx */
  start(ctx) {
    const ov = ctx.overlay({ title: 'Bug Invaders', sub: 'den arcade, 1 credit on the house',
      help: '<kbd>←</kbd><kbd>→</kbd> move <kbd>space</kbd> fire semicolons <kbd>hold left/right side</kbd> move <kbd>click</kbd> fire' });
    const K = gx(ov), k = keys(ov);
    const hud = K.hud([{ id: 'score', label: 'Score' }, { id: 'best', label: 'Best', tone: 'gold' }], [{ id: 'wave', label: 'Wave', value: 1 }, { id: 'lives', label: 'Lives', value: 3 }]);
    const scene = K.scene({ aspect: 62 / 80 });
    const st = document.createElement('style'); st.textContent = CSS; ov.el.appendChild(st);
    const cab = document.createElement('div'); cab.className = 'ac';
    cab.innerHTML = `<div class="floor"></div>
<svg class="side" viewBox="0 0 620 860" preserveAspectRatio="none" aria-hidden="true"><defs>
<linearGradient id="ac-sideL" x1="0" x2="1"><stop offset="0" stop-color="#9b7bff" stop-opacity=".55"/><stop offset=".12" stop-color="#2a1a3d"/><stop offset="1" stop-color="#140c20"/></linearGradient>
<linearGradient id="ac-sideR" x1="1" x2="0"><stop offset="0" stop-color="#ff5fd2" stop-opacity=".5"/><stop offset=".12" stop-color="#2a1a3d"/><stop offset="1" stop-color="#140c20"/></linearGradient>
<linearGradient id="ac-art" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5fd2"/><stop offset="1" stop-color="#9b7bff"/></linearGradient></defs>
<path d="M0 0 H60 V860 H8 V560 L0 540 Z" fill="url(#ac-sideL)"/><path d="M620 0 H560 V860 H612 V560 L620 540 Z" fill="url(#ac-sideR)"/>
<g fill="none" stroke="url(#ac-art)" stroke-width="3" stroke-linecap="round" opacity=".9"><path d="M18 120 q22 40 0 80 q-10 30 14 60 M20 330 l28 26 l-28 26 M30 420 v80"/><path d="M602 120 q-22 40 0 80 q10 30 -14 60 M600 330 l-28 26 l28 26 M590 420 v80"/></g>
<g fill="url(#ac-art)" opacity=".85"><circle cx="36" cy="290" r="5"/><circle cx="584" cy="290" r="5"/><circle cx="30" cy="620" r="4"/><circle cx="590" cy="620" r="4"/></g>
<path d="M1 0 V540" stroke="#c8b6ff" stroke-width="2.5" opacity=".9"/><path d="M619 0 V540" stroke="#ffb3ea" stroke-width="2.5" opacity=".9"/><path d="M60 0 H560" stroke="#ffd29a" stroke-width="2" opacity=".35"/></svg>
<div class="body"><div class="mq"><svg viewBox="0 0 520 70" aria-label="Bug Invaders"><defs><filter id="ac-bloom" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="5"/></filter></defs>
<g class="hum"><text class="tube halo" x="260" y="52" text-anchor="middle">BUG INVADERS</text><text class="tube mid" x="260" y="52" text-anchor="middle">BUG INVADERS</text><text class="tube core" x="260" y="52" text-anchor="middle">BUG INVADERS</text></g></svg></div>
<div class="bz"><div class="art"></div><div class="crt"><canvas></canvas><div class="scan"></div><div class="glass"></div></div>
<div class="leds"><div class="led"><small>1UP</small><svg class="ls"></svg></div><div class="lives"><i></i><i></i><i></i></div><div class="led hi"><small>HI</small><svg class="lh"></svg></div></div></div>
<div class="pn"><div class="stick"><div class="shaft"><div class="ball"></div></div></div><div class="btns"><div class="pb a"></div><div class="pb b"></div></div></div><div class="kick"></div></div>`;
    scene.appendChild(cab);
    const q = s => /** @type {any} */ (cab.querySelector(s));
    const cv = /** @type {HTMLCanvasElement} */ (q('.crt canvas')), cx = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
    const art = document.createElement('canvas'); art.width = 320; art.height = 240;
    const ax = /** @type {CanvasRenderingContext2D} */ (art.getContext('2d'));
    const shaft = q('.shaft'), bA = q('.pb.a'), bB = q('.pb.b'), lives = [...cab.querySelectorAll('.lives i')], ls = q('.ls'), lh = q('.lh');
    // screen-res canvas, the 320x240 art scaled with nearest-neighbour (integer, or >=4x)
    let sc = 1, ox = 0, oy = 0, up = 0; const pre = document.createElement('canvas'), px = /** @type {CanvasRenderingContext2D} */ (pre.getContext('2d'));
    const fit = () => { const d = devicePixelRatio || 1; cv.width = Math.max(1, Math.round(cv.offsetWidth * d)); cv.height = Math.max(1, Math.round(cv.offsetHeight * d));
      const f = Math.min(cv.width / 320, cv.height / 240) * 0.97; sc = f >= 2.5 || f < 1.5 ? (f >= 2.5 ? f : Math.max(1, Math.floor(f))) : f; up = f >= 2.5 || f < 1.5 ? 0 : Math.ceil(f); /* >= 2.5 device px per art px: fractional nearest-neighbour; 1.5-2.5: sharp-bilinear (integer nearest pre-scale, then a smooth step down) so the picture still fills the glass */ if (up) { pre.width = 320 * up; pre.height = 240 * up; } ox = Math.floor((cv.width - 320 * sc) / 2); oy = Math.floor((cv.height - 240 * sc) / 2); };
    fit(); const ro = new ResizeObserver(fit); ro.observe(cv); ov.onClose(() => ro.disconnect());
    const toScreen = (px, py) => { const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1; return [r.left + (ox + px * sc) / d, r.top + (oy + py * sc) / d]; };
    let result = /** @type {any} */ (null);
    const game = bugInvaders({ x: ax, keys: k, rand: rng((Date.now() & 0xffff) + 7), on: (ev, a) => {
      if (ev === 'pop') { const [sx, sy] = toScreen(a.x, a.y); K.pop(sx, sy, a.s, a.c); if (a.big) K.swell(); }
      else if (ev === 'banner') { const b = document.createElement('div'); b.className = 'bn'; b.textContent = a; q('.crt').appendChild(b); setTimeout(() => b.remove(), 1600); }
      else if (ev === 'over') setTimeout(() => { if (!ov.el.isConnected || game.mode !== 'over') return; if (a.best) K.swell();
        result = K.result({ title: a.best ? 'New high score' : 'Game over', big: a.score, best: a.best, line: 'Works on my machine.', stats: [[a.hi, 'Best'], [a.wave, 'Wave']], again: 'Insert coin', onAgain: () => { result = null; game.replay(); } }); }, 1200);
    } });
    const tap = e => { if (game.mode !== 'play') return; game.tap(e.code); }; addEventListener('keydown', tap); ov.onClose(() => removeEventListener('keydown', tap));
    // mouse: click fires; holding on the left / right third of the screen steers like the arrow keys
    let held = '';
    const steer = e => { if (held) k.delete(held); held = ''; if (!(e.buttons & 1) || game.mode !== 'play') return; const r = cv.getBoundingClientRect(), f = (e.clientX - r.left) / r.width; held = f < 1 / 3 ? 'ArrowLeft' : f > 2 / 3 ? 'ArrowRight' : ''; if (held) k.add(held); };
    cv.style.cursor = 'pointer';
    cv.addEventListener('pointerdown', e => { if (e.button === 0 && game.mode === 'play') game.tap('Space'); steer(e); });
    cv.addEventListener('pointermove', steer); addEventListener('pointerup', steer); ov.onClose(() => removeEventListener('pointerup', steer));
    let last = { s: -1, h: -1, l: -1, w: -1 };
    loop(ov, (dt, t) => {
      game.update(dt); game.draw(t);
      if (cv.width !== Math.max(1, Math.round(cv.offsetWidth * (devicePixelRatio || 1)))) fit();
      cx.setTransform(1, 0, 0, 1, 0, 0); cx.fillStyle = '#05040a'; cx.fillRect(0, 0, cv.width, cv.height); if (up) { px.imageSmoothingEnabled = false; px.drawImage(art, 0, 0, pre.width, pre.height); cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high'; cx.drawImage(pre, ox, oy, 320 * sc, 240 * sc); } else { cx.imageSmoothingEnabled = false; cx.drawImage(art, ox, oy, 320 * sc, 240 * sc); }
      const mv = (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0); shaft.style.rotate = mv * 18 + 'deg';
      bA.classList.toggle('down', k.has('Space') || k.has('ArrowUp')); bB.classList.toggle('down', k.has('Enter'));
      const s = game.score, h = game.hi, l = game.lives, w = game.wave;
      if (s !== last.s) { led(ls, s); hud.set('score', s, { count: s > 0 }); }
      if (h !== last.h) { led(lh, h); hud.set('best', h); }
      if (l !== last.l) { lives.forEach((e, i) => e.classList.toggle('off', i >= l)); hud.set('lives', Math.max(0, l)); }
      if (w !== last.w) hud.set('wave', w);
      last = { s, h, l, w };
    });
    K.card({ title: 'Bug Invaders', kicker: '1 credit, on the house', text: 'They compiled. They multiplied. Fire semicolons before they reach prod.', how: [[['←', '→'], 'move'], [['Space', 'Click'], 'fire']], cta: 'Insert coin', onGo: () => game.replay() });
    void result;
  },
}];
