// @ts-check
// Lab 426: the MOTHER terminal. Green-on-black chat; cold corporate replies, then Special Order 937.
import { loop, text } from './util.js';
import { typer, wrap } from './films-a-crt.js';
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
  const ov = ctx.overlay({ title: 'MOTHER', sub: 'MU-TH-UR 6000 · interface 2037', help: '<kbd>type</kbd> an inquiry <kbd>enter</kbd> send <kbd>esc</kbd> log off' });
  const W = 480, H = 270; const { x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
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
  loop(ov, dt => {
    st.t += dt; const t = st.t;
    for (const l of log) if (l.who !== 'U' && !l.heard && t >= l.at) { l.heard = 1; if (l.who === 'X') SFX.play('sting', { vol: 0.5 }); else SFX.play('beep', { vol: 0.5, pitch: l.s.startsWith('SPECIAL') ? 0.7 : 1 }); }
    const red = st.order > 0 && t > st.order + 3.6 && (t * 2) % 1 < 0.5;
    x.fillStyle = red ? '#120404' : '#020a05'; x.fillRect(0, 0, W, H);
    x.strokeStyle = '#1d5a36'; x.strokeRect(10.5, 10.5, W - 21, H - 21);
    text(x, 'MU-TH-UR 6000', 22, 30, { color: '#3ddc84' }); text(x, 'THE COMPANY · LAB 426 · QUARANTINE', W - 22, 30, { color: '#1d5a36', align: 'right' });
    const lines = [];
    for (const l of log) { if (t < l.at) { if (l.who !== 'U') { lines.push({ s: '.'.repeat(1 + ((t * 3) | 0) % 3), c: '#2a7a4a' }); break; } continue; }
      const n = Math.min(l.s.length, ((t - l.at) * 40) | 0);
      for (const [k, w] of wrap(x, (l.who === 'U' ? '> ' : '') + l.s.slice(0, n), 430).entries()) lines.push({ s: (k ? '  ' : '') + w, c: l.who === 'U' ? '#b8c8b0' : l.who === 'X' ? '#ff5a4a' : '#6ee7a0' }); }
    lines.push({ s: '> ' + inp.buf.toUpperCase() + ((t * 2) % 1 < 0.5 ? '_' : ''), c: '#6ee7a0' });
    lines.slice(-12).forEach((l, k) => text(x, l.s, 22, 58 + k * 16, { color: l.c }));
    x.fillStyle = 'rgba(0,0,0,0.22)'; for (let y = 0; y < H; y += 2) x.fillRect(0, y, W, 1);
  });
}

export default [
  { id: 'biolab-mother', match: (it, R) => R.id === 'biolab' && it.id === 'mother', label: () => 'Talk to MOTHER', sfx: 'crt.on', start: startMother },
];
