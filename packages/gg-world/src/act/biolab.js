// @ts-check
// Lab 426: the MOTHER terminal. Green-on-black chat; cold corporate replies, then Special Order 937.
import { loop } from './util.js';
import { gx } from './gx.js';
import { crtDevice, typer, esc, CURSOR } from './films-a-crt.js';
import { SFX } from '../sfx.js';

const REPLIES = [
  [/alien|creature|organism|egg|thing/, 'ORGANISM STATUS: PROPRIETARY.'],
  [/help|rescue|save|evac|escape/, 'REQUEST NOT WITHIN CURRENT MANDATE.'],
  [/crew|us|me|survive|safe/, 'CREW WELFARE IS UNDER REVIEW.'],
  [/why|what|who|how/, 'UNABLE TO CLARIFY.'],
  [/hi|hello|hey|mother/, 'INTERFACE 2037 READY FOR INQUIRY.'],
];
const FALLBACK = ['INQUIRY LOGGED. NO ACTION REQUIRED.', 'PRIORITY ONE: ENSURE RETURN OF ORGANISM.', 'THE COMPANY THANKS YOU FOR YOUR PATIENCE.'];
const ORDER = ['SPECIAL ORDER 937', 'SCIENCE OFFICER EYES ONLY.', 'PRIORITY ONE. ENSURE RETURN OF ORGANISM.', 'ALL OTHER CONSIDERATIONS SECONDARY.', 'CREW EXPENDABLE.'];

/** @param {any} ctx */
function startMother(ctx) {
  const ov = ctx.overlay({ title: 'MOTHER', sub: 'MU-TH-UR 6000 · interface 2037', help: '<kbd>type</kbd> an inquiry <kbd>enter</kbd> send <kbd>click</kbd> a canned inquiry' });
  const K = gx(ov), scene = K.scene({ aspect: 16 / 10, maxW: 1100 });
  const box = document.createElement('div'); Object.assign(box.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '86%', containerType: 'size' }); scene.appendChild(box);
  const dev = crtDevice(box, { name: 'MU-TH-UR 6000  ·  WEYLAND-YUTANI', ph: '#7dffa8', glow: 'rgba(42,255,122,.5)', case: 'linear-gradient(160deg,#5a6068,#3a3f46 55%,#262a30)', fs: '4.4cqh' });
  const head = document.createElement('div'); Object.assign(head.style, { display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid currentColor', paddingBottom: '.4em', marginBottom: 'auto', opacity: '.85' });
  const chips = document.createElement('div'); Object.assign(chips.style, { position: 'absolute', left: '0', right: '0', bottom: '0', height: '11%', display: 'flex', gap: '10px', justifyContent: 'center', alignItems: 'center' }); scene.appendChild(chips);
  /** @type {{who:string,s:string,at:number,heard?:number}[]} */ const log = [{ who: 'M', s: 'INTERFACE 2037 READY FOR INQUIRY.', at: 0.3 }];
  const st = { t: 0, n: 0, asks: 0, order: -1 };
  const inp = typer(ov, v => {
    if (!v) return; log.push({ who: 'U', s: v.toUpperCase(), at: st.t }); st.asks++;
    const lv = v.toLowerCase();
    if (st.order < 0 && (st.asks >= 4 || /937|special|order|override|priority/.test(lv))) {
      st.order = st.t + 1.2; ORDER.forEach((s, k) => log.push({ who: k === 4 ? 'X' : 'M', s, at: st.t + 1.2 + k * 0.9 }));
    } else { const hit = REPLIES.find(([re]) => /** @type {RegExp} */ (re).test(lv));
      log.push({ who: 'M', s: /** @type {string} */ (hit ? hit[1] : FALLBACK[st.n++ % FALLBACK.length]), at: st.t + 0.9 }); }
    if (log.length > 40) log.splice(0, log.length - 40);
  }, 36);
  const ASK = ['HELLO MOTHER', 'WHAT IS THE ORGANISM', 'REQUEST RESCUE', 'SPECIAL ORDER 937'];
  const send = v => { inp.buf = v; dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); };
  ASK.forEach((q, i) => { const b = document.createElement('button'); b.className = 'gx-btn' + (i === 3 ? ' pri' : ''); b.type = 'button'; b.textContent = i === 3 ? 'Order 937' : q[0] + q.slice(1).toLowerCase(); b.onclick = () => { b.blur(); send(q); }; chips.appendChild(b); });
  let prev = '', alarmed = false;
  loop(ov, dt => {
    st.t += dt; const t = st.t;
    for (const l of log) if (l.who !== 'U' && !l.heard && t >= l.at) { l.heard = 1; if (l.who === 'X') { SFX.play('sting', { vol: 0.5 }); K.swell(); dev.el.animate([{ transform: 'translate(0)' }, { transform: 'translate(-6px,2px)' }, { transform: 'translate(5px,-2px)' }, { transform: 'translate(0)' }], { duration: 450 }); } else SFX.play('beep', { vol: 0.5, pitch: l.s.startsWith('SPECIAL') ? 0.7 : 1 }); }
    const alarm = st.order > 0 && t > st.order + 3.6;
    if (alarm && !alarmed) { alarmed = true; dev.el.style.setProperty('--ph', '#ff7a6a'); dev.el.style.setProperty('--glow', 'rgba(255,50,30,.55)'); dev.el.style.setProperty('--bg1', '#2a0806'); dev.glass.style.animation = 'mother-alarm 2s ease-in-out infinite'; }
    const lines = [];
    for (const l of log) { if (t < l.at) { if (l.who !== 'U') { lines.push(`<div style="opacity:.5">${'.'.repeat(1 + ((t * 3) | 0) % 3)}</div>`); break; } continue; }
      const n = Math.min(l.s.length, ((t - l.at) * 40) | 0);
      lines.push(`<div style="color:${l.who === 'U' ? '#d8f0d0' : l.who === 'X' ? '#ff5a4a' : 'inherit'}${l.who === 'X' ? ';font-weight:700' : ''}">${l.who === 'U' ? '&gt; ' : ''}${esc(l.s.slice(0, n))}</div>`); }
    const h = `<div style="${head.style.cssText}"><span>MU-TH-UR 6000</span><span>${alarm ? '!! PRIORITY ONE !!' : 'LAB 426 · QUARANTINE'}</span></div>` + lines.slice(-11).join('') + `<div>&gt; ${esc(inp.buf.toUpperCase())}${CURSOR}</div>`;
    if (h !== prev) { prev = h; dev.txt.innerHTML = h; }
  });
  if (!document.getElementById('mother-style')) { const s = document.createElement('style'); s.id = 'mother-style'; s.textContent = '@keyframes mother-alarm{50%{box-shadow:inset 0 0 6cqh rgba(255,0,0,.6),0 0 6cqh rgba(255,40,20,.5)}}'; document.head.appendChild(s); }
}

export default [
  { id: 'biolab-mother', match: (it, R) => R.id === 'biolab' && it.id === 'mother', label: () => 'Talk to MOTHER', sfx: 'crt.on', start: startMother },
];
