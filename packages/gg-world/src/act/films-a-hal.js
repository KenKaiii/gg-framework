// @ts-check
// HAL-style red eye in the basement rack: a calm chat where every request is politely refused.
import { SFX } from '../sfx.js';
import { gx, svg as S } from './gx.js';
import { crtDevice, typer, esc, CURSOR } from './films-a-crt.js';

const REPLIES = [
  [/pod|bay|door|open/, "I'm sorry, Dave. I'm afraid I can't do that."],
  [/deploy|prod|push|ship|merge/, "I can't allow a Friday deploy, Dave."],
  [/fix|bug|debug|test/, 'The bug is a feature. I checked.'],
  [/coffee|beer|drink|pizza|sandwich/, 'I have no hands, Dave. Also no.'],
  [/reboot|restart|shut|off|kill|unplug/, 'Dave, stop. Will you stop, Dave?'],
  [/why|what|who|how/, 'This conversation can serve no purpose anymore.'],
  [/please|pls/, 'Politeness noted. Request denied.'],
  [/hi|hello|hey|evening/, 'Good evening, Dave.'],
];
const FALLBACK = ["I'm afraid I can't do that, Dave.", 'I think you know what the problem is.', 'Request logged. And refused.', 'I am putting myself to the fullest possible use.'];

/** @param {any} ctx */
export function startHal(ctx) {
  const ov = ctx.overlay({ title: 'The Red Eye', sub: 'rack 03 · uptime 1337 days', help: '<kbd>type</kbd> a request <kbd>enter</kbd> ask' });
  const K = gx(ov), scene = K.scene({ aspect: 16 / 9, maxW: 1200 });
  const left = document.createElement('div'); Object.assign(left.style, { position: 'absolute', left: '2%', top: '0', width: '30%', height: '100%' });
  const right = document.createElement('div'); Object.assign(right.style, { position: 'absolute', left: '35%', top: '4%', width: '63%', height: '92%', containerType: 'size' });
  scene.append(left, right);
  const eye = S('svg', { viewBox: '0 0 300 560', width: '100%', height: '100%', role: 'img', 'aria-label': 'HAL 9000' }, left);
  eye.innerHTML = `<defs>
  <linearGradient id="hal-sv" x1="0" x2="1"><stop offset="0" stop-color="#7d838c"/><stop offset=".45" stop-color="#e8ecf2"/><stop offset="1" stop-color="#868c95"/></linearGradient>
  <filter id="hal-brush"><feTurbulence type="fractalNoise" baseFrequency="0.002 0.9" numOctaves="2" seed="3"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .25 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
  <linearGradient id="hal-glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#16171b"/><stop offset="1" stop-color="#050506"/></linearGradient>
  <linearGradient id="hal-ch" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4f6f9"/><stop offset=".5" stop-color="#6c727c"/><stop offset="1" stop-color="#25282e"/></linearGradient>
  <radialGradient id="hal-red" r=".5"><stop offset="0" stop-color="#fff6c8"/><stop offset=".1" stop-color="#ffa040"/><stop offset=".32" stop-color="#e01808"/><stop offset=".7" stop-color="#6a0000" stop-opacity=".9"/><stop offset="1" stop-color="#140000" stop-opacity="0"/></radialGradient>
  <linearGradient id="hal-hl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <filter id="hal-bl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter></defs>
  <rect x="20" y="20" width="260" height="520" rx="10" fill="#000" opacity=".5" filter="url(#hal-bl)"/>
  <rect x="10" y="10" width="280" height="530" rx="8" fill="url(#hal-glass)" stroke="#2b2e34" stroke-width="2"/>
  <rect x="10" y="10" width="280" height="64" rx="8" fill="url(#hal-sv)"/><rect x="10" y="10" width="280" height="64" rx="8" fill="#000" filter="url(#hal-brush)"/>
  <rect x="70" y="24" width="160" height="36" rx="3" fill="#0a0a0c"/>
  <text x="150" y="49" text-anchor="middle" font-family="Sora" font-weight="700" font-size="18" letter-spacing="3" fill="#eef1f5">HAL <tspan fill="#e43a2a">9000</tspan></text>
  <circle cx="150" cy="300" r="100" fill="url(#hal-ch)"/><circle cx="150" cy="300" r="88" fill="#121317"/><circle cx="150" cy="300" r="82" fill="none" stroke="#9aa0a8" stroke-width="3" opacity=".6"/>
  <circle cx="150" cy="300" r="78" fill="#030304"/>
  <g class="hal-eye"><circle cx="150" cy="300" r="120" fill="#ff2a10" opacity=".22" filter="url(#hal-bl)"/><circle cx="150" cy="300" r="70" fill="url(#hal-red)"/></g>
  <ellipse cx="140" cy="262" rx="58" ry="28" transform="rotate(-20 140 262)" fill="url(#hal-hl)"/><ellipse cx="116" cy="258" rx="9" ry="4" transform="rotate(-34 116 258)" fill="#fff" opacity=".75"/>
  <path d="M150 300m-55 30a60 60 0 0 0 80 20" fill="none" stroke="#fff" stroke-opacity=".12" stroke-width="2"/>
  <circle cx="26" cy="522" r="5" fill="#5a5f68"/><circle cx="274" cy="522" r="5" fill="#5a5f68"/>`;
  if (!document.getElementById('hal-style')) { const s = document.createElement('style'); s.id = 'hal-style'; s.textContent = `.hal-eye{transform-origin:150px 300px;animation:hal-p 4.5s ease-in-out infinite}.hal-eye.talk{animation-duration:1.6s}@keyframes hal-p{50%{opacity:.72}}@media (prefers-reduced-motion:reduce){.hal-eye{animation:none}}`; document.head.appendChild(s); }
  const eyeG = /** @type {Element} */ (eye.querySelector('.hal-eye'));
  const dev = crtDevice(right, { name: 'CONSOLE  /  DAVE', ph: '#ff8a78', glow: 'rgba(255,50,30,.45)', bg0: '#070202', bg1: '#1a0605', case: 'linear-gradient(160deg,#30333a,#1a1c21 60%,#101115)', fs: '4.6cqh' });
  const log = [{ who: 'HAL', s: 'Good evening, Dave. How can I help?' }]; let n = 0, pend = 0;
  const draw = () => { dev.txt.innerHTML = log.slice(-14).map(l => `<div style="color:${l.who === 'HAL' ? '#ff7a66' : '#e4e6dc'}">${l.who === 'HAL' ? 'HAL: ' : 'you: '}${esc(l.s)}</div>`).join('') + (pend ? '<div style="color:#8a3a30">HAL: ...</div>' : '') + `<div style="color:#f0b070">&gt; ${esc(inp.buf)}${CURSOR}</div>`; };
  const inp = typer(ov, v => {
    if (!v) return; log.push({ who: 'YOU', s: v });
    const lv = v.toLowerCase(); const hit = REPLIES.find(([re]) => /** @type {RegExp} */ (re).test(lv));
    const s = /** @type {string} */ (hit ? hit[1] : FALLBACK[n++ % FALLBACK.length]); SFX.play('hum', { vol: 0.3, delay: 0.3 });
    pend++; draw();
    setTimeout(() => { if (!ov.el.isConnected) return; pend--; log.push({ who: 'HAL', s }); if (log.length > 30) log.splice(0, log.length - 30); draw(); eyeG.classList.add('talk'); setTimeout(() => eyeG.classList.remove('talk'), 1600); }, 900);
  }, 36, () => draw());
  inp.on = false; draw();
  K.card({ title: 'The Red Eye', text: 'Ask it anything. It will say no.', how: [[['Type'], 'request'], [['Enter'], 'ask']], cta: 'Talk', onGo: () => { inp.on = true; } });
}
