// @ts-check
// HAL-style red eye in the basement rack: a calm chat where every request is politely refused.
import { SFX } from '../sfx.js';
import { loop, text } from './util.js';
import { typer, wrap, blinkOn, titleCard } from './films-a-crt.js';
import { panel, glow, title, noise } from './art.js';
import { rng } from './util.js';

const EX = 94, EY = 146;
/** Static faceplate (brushed metal, screws, silver name plate, lens rings) and the lens gloss, drawn once. @param {number} W @param {number} H */
function plates(W, H) {
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return { c, x: /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')) }; };
  const A = mk(), x = A.x, R = rng(9);
  const bg = x.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#24262c'); bg.addColorStop(1, '#0c0d10'); x.fillStyle = bg; x.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y++) { x.fillStyle = `rgba(255,255,255,${(R() * 0.035).toFixed(3)})`; x.fillRect(0, y, W, 1); }
  // faceplate: black glass slab with a brushed-silver header
  panel(x, 26, 16, 136, 238, { style: 'metal', r: 6 }); x.fillStyle = '#07080a'; x.fillRect(32, 50, 124, 198);
  const sv = x.createLinearGradient(30, 0, 158, 0); sv.addColorStop(0, '#7d838c'); sv.addColorStop(0.45, '#e2e6ec'); sv.addColorStop(1, '#8a9099'); x.fillStyle = sv; x.fillRect(32, 22, 124, 26);
  for (let i = 0; i < 26; i++) { x.fillStyle = `rgba(0,0,0,${(R() * 0.08).toFixed(3)})`; x.fillRect(32, 22 + i, 124, 1); }
  x.fillStyle = '#0a0a0c'; x.fillRect(58, 27, 72, 16); title(x, 'HAL 9000', 94, 40, { size: 16, body: true, color: '#e8ecf2', ink: '#000' });
  for (const [sx, sy] of [[34, 238], [154, 238]]) { x.fillStyle = '#5a5f68'; x.beginPath(); x.arc(sx, sy, 3, 0, 7); x.fill(); x.fillStyle = '#20232a'; x.fillRect(sx - 2, sy, 4, 1); }
  // lens rings: brushed chrome, black gap, dark glass
  const ch = x.createLinearGradient(EX - 44, EY - 44, EX + 44, EY + 44); ch.addColorStop(0, '#f0f3f7'); ch.addColorStop(0.5, '#6c727c'); ch.addColorStop(1, '#2a2d33');
  x.fillStyle = ch; x.beginPath(); x.arc(EX, EY, 44, 0, 7); x.fill();
  x.fillStyle = '#16181c'; x.beginPath(); x.arc(EX, EY, 39, 0, 7); x.fill();
  const ch2 = x.createLinearGradient(EX + 36, EY + 36, EX - 36, EY - 36); ch2.addColorStop(0, '#c8ccd2'); ch2.addColorStop(1, '#3a3e46'); x.strokeStyle = ch2; x.lineWidth = 2; x.beginPath(); x.arc(EX, EY, 36, 0, 7); x.stroke();
  x.fillStyle = '#040405'; x.beginPath(); x.arc(EX, EY, 34, 0, 7); x.fill();
  // chat screen
  panel(x, 178, 16, 282, 238, { style: 'metal', r: 6 }); x.fillStyle = '#0a0606'; x.fillRect(184, 44, 270, 204);
  title(x, 'CONSOLE  /  DAVE', 192, 37, { size: 16, body: true, align: 'left', color: '#ffb0a0' }); x.fillStyle = '#ff3a20'; x.beginPath(); x.arc(446, 31, 3, 0, 7); x.fill();
  for (let y = 44; y < 248; y += 2) { x.fillStyle = 'rgba(255,40,20,0.025)'; x.fillRect(184, y, 270, 1); }
  noise(x, 0, 0, W, H, 0.02, 5);
  const G = mk(), y = G.x; // lens gloss: curved highlight + small specular + rim reflection
  y.save(); y.beginPath(); y.arc(EX, EY, 34, 0, 7); y.clip();
  const hl = y.createLinearGradient(0, EY - 34, 0, EY); hl.addColorStop(0, 'rgba(255,255,255,0.32)'); hl.addColorStop(1, 'rgba(255,255,255,0)'); y.fillStyle = hl; y.beginPath(); y.ellipse(EX - 4, EY - 18, 26, 13, -0.35, 0, 7); y.fill();
  y.fillStyle = 'rgba(255,255,255,0.7)'; y.beginPath(); y.ellipse(EX - 15, EY - 19, 4, 2, -0.6, 0, 7); y.fill();
  y.strokeStyle = 'rgba(255,255,255,0.12)'; y.lineWidth = 1; y.beginPath(); y.arc(EX, EY, 24, 0.3, 1.4); y.stroke(); y.restore();
  return { back: A.c, gloss: G.c };
}

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
  const st = { t: 0, n: 0, talk: 0 }; const { back, gloss } = plates(W, H);
  const inp = typer(ov, v => {
    if (!v) return; log.push({ who: 'YOU', s: v, at: st.t });
    const lv = v.toLowerCase(); const hit = REPLIES.find(([re]) => /** @type {RegExp} */ (re).test(lv));
    const s = /** @type {string} */ (hit ? hit[1] : FALLBACK[st.n++ % FALLBACK.length]); SFX.play('hum', { vol: 0.3, delay: 0.3 });
    log.push({ who: 'HAL', s, at: st.t + 0.9 }); if (log.length > 30) log.splice(0, log.length - 30);
  }, 36);
  loop(ov, dt => {
    st.t += dt; const t = st.t;
    x.drawImage(back, 0, 0);
    const speaking = log.some(l => l.who === 'HAL' && t > l.at && t < l.at + 1.6);
    const pulse = 0.78 + 0.18 * Math.sin(t * 1.4) + (speaking ? 0.15 + 0.1 * Math.sin(t * 3.5) : 0);
    glow(x, EX, EY, 60 + 10 * pulse, '#ff2a10', 0.25 * pulse);
    const g = x.createRadialGradient(EX, EY, 1, EX, EY, 30); g.addColorStop(0, '#fff6c8'); g.addColorStop(0.1, `rgba(255,${(150 * pulse) | 0},60,1)`); g.addColorStop(0.32, `rgba(${(230 * pulse) | 0},20,10,1)`); g.addColorStop(0.7, `rgba(${(110 * pulse) | 0},0,0,0.85)`); g.addColorStop(1, 'rgba(20,0,0,0)');
    x.fillStyle = g; x.beginPath(); x.arc(EX, EY, 30, 0, 7); x.fill();
    x.drawImage(gloss, 0, 0);
    // chat log
    const lines = [];
    for (const l of log) { if (t < l.at) { if (l.who === 'HAL') lines.push({ s: 'HAL: ' + '...', c: '#7a3030' }); continue; }
      for (const [k, w] of wrap(x, (l.who === 'HAL' ? 'HAL: ' : 'you: ') + l.s, 256).entries()) lines.push({ s: (k ? '  ' : '') + w, c: l.who === 'HAL' ? '#ff6b5a' : '#d8dccf' }); }
    lines.push({ s: '> ' + inp.buf + (blinkOn(t) ? '_' : ''), c: '#e0a458' });
    lines.slice(-12).forEach((l, k) => text(x, l.s, 192, 62 + k * 15, { color: l.c }));
    titleCard(x, W, H, t, { name: 'The Red Eye', sub: 'ask it anything. it will say no.', keys: [['type', 'request'], ['enter', 'ask'], ['esc', 'leave']], color: '#ff6b5a' });
  });
}
