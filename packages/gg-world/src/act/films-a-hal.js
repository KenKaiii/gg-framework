// @ts-check
// HAL-style red eye in the basement rack: a calm chat where every request is politely refused.
import { SFX } from '../sfx.js';
import { loop, text } from './util.js';
import { typer, wrap } from './films-a-crt.js';

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
  const ov = ctx.overlay({ title: 'The Red Eye', sub: 'rack 03 · uptime 1337 days', help: '<kbd>type</kbd> a request <kbd>enter</kbd> ask <kbd>esc</kbd> leave' });
  const W = 480, H = 270; const { x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const log = [{ who: 'HAL', s: 'Good evening, Dave. How can I help?', at: 0 }];
  const st = { t: 0, n: 0, talk: 0 };
  const inp = typer(ov, v => {
    if (!v) return; log.push({ who: 'YOU', s: v, at: st.t });
    const lv = v.toLowerCase(); const hit = REPLIES.find(([re]) => /** @type {RegExp} */ (re).test(lv));
    const s = /** @type {string} */ (hit ? hit[1] : FALLBACK[st.n++ % FALLBACK.length]); SFX.play('hum', { vol: 0.3, delay: 0.3 });
    log.push({ who: 'HAL', s, at: st.t + 0.9 }); if (log.length > 30) log.splice(0, log.length - 30);
  }, 36);
  loop(ov, dt => {
    st.t += dt; const t = st.t;
    x.fillStyle = '#08080c'; x.fillRect(0, 0, W, H);
    // panel
    x.fillStyle = '#1a1b20'; x.fillRect(24, 20, 140, 230); x.fillStyle = '#9aa0aa'; x.fillRect(24, 20, 140, 26);
    text(x, 'H A L', 94, 38, { color: '#14151a', align: 'center' });
    const speaking = log.some(l => l.who === 'HAL' && t > l.at && t < l.at + 1.6);
    const pulse = 0.75 + 0.25 * Math.sin(t * 1.6) + (speaking ? 0.2 * Math.sin(t * 18) : 0);
    const ex = 94, ey = 140;
    x.fillStyle = '#5a5e66'; x.beginPath(); x.arc(ex, ey, 46, 0, 7); x.fill();
    x.fillStyle = '#050505'; x.beginPath(); x.arc(ex, ey, 40, 0, 7); x.fill();
    const g = x.createRadialGradient(ex, ey, 2, ex, ey, 38); g.addColorStop(0, '#fff3c0'); g.addColorStop(0.12, `rgba(255,${(80 * pulse) | 0},40,1)`); g.addColorStop(0.45, `rgba(${(190 * pulse) | 0},10,10,0.9)`); g.addColorStop(1, 'rgba(20,0,0,0)');
    x.fillStyle = g; x.beginPath(); x.arc(ex, ey, 38, 0, 7); x.fill();
    x.fillStyle = 'rgba(255,255,255,0.25)'; x.beginPath(); x.ellipse(ex - 14, ey - 18, 9, 4, -0.6, 0, 7); x.fill();
    // chat log
    x.fillStyle = '#0e0f14'; x.fillRect(180, 20, 276, 230);
    const lines = [];
    for (const l of log) { if (t < l.at) { if (l.who === 'HAL') lines.push({ s: 'HAL: ' + '.'.repeat(1 + ((t * 3) | 0) % 3), c: '#7a3030' }); continue; }
      for (const [k, w] of wrap(x, (l.who === 'HAL' ? 'HAL: ' : 'you: ') + l.s, 256).entries()) lines.push({ s: (k ? '  ' : '') + w, c: l.who === 'HAL' ? '#ff6b5a' : '#d8dccf' }); }
    lines.push({ s: '> ' + inp.buf + ((t * 2) % 1 < 0.5 ? '_' : ''), c: '#e0a458' });
    lines.slice(-13).forEach((l, k) => text(x, l.s, 190, 40 + k * 16, { color: l.c }));
  });
}
