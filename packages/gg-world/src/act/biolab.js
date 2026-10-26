// @ts-check
// Lab 426: the MOTHER terminal. Green-on-black chat; cold corporate replies, then Special Order 937.
import { loop, text, mouse } from './util.js';
import { PAL, bg, panel, button, title, glow, noise, shaker } from './art.js';
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
  const ov = ctx.overlay({ title: 'MOTHER', sub: 'MU-TH-UR 6000 · interface 2037', help: '<kbd>type</kbd> an inquiry <kbd>enter</kbd> send <kbd>click</kbd> a canned inquiry <kbd>esc</kbd> log off' });
  const W = 480, H = 270; const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
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
  // mouse: canned inquiries as clickable chips under the screen
  const ASK = ['HELLO MOTHER', 'WHAT IS THE ORGANISM', 'REQUEST RESCUE', 'SPECIAL ORDER 937'];
  const send = v => { const k = new KeyboardEvent('keydown', { key: 'Enter' }); inp.buf = v; dispatchEvent(k); };
  let hot = -1; const chipX = [16, 128, 268, 380], chipW = [104, 132, 104, 88];
  mouse(ov, c, W, H).set(ASK.map((q, i) => ({ x: chipX[i], y: H - 30, w: chipW[i], h: 22, hover: () => { hot = i; }, pick: () => send(q) })));
  c.addEventListener('pointerleave', () => { hot = -1; });
  const frame = bezel(W, H), shk = shaker(); let alarmed = false;
  loop(ov, dt => {
    st.t += dt; const t = st.t;
    for (const l of log) if (l.who !== 'U' && !l.heard && t >= l.at) { l.heard = 1; if (l.who === 'X') { SFX.play('sting', { vol: 0.5 }); shk.kick(5); } else SFX.play('beep', { vol: 0.5, pitch: l.s.startsWith('SPECIAL') ? 0.7 : 1 }); }
    const alarm = st.order > 0 && t > st.order + 3.6, red = alarm && Math.sin(t * 4) > 0; if (alarm && !alarmed) alarmed = true;
    x.drawImage(frame, 0, 0);
    x.save(); shk.apply(x, dt);
    const sc = panel(x, 16, 16, W - 32, H - 58, { style: 'crt', r: 10 });
    if (alarm) { x.fillStyle = `rgba(255,30,20,${0.10 + 0.08 * Math.sin(t * 4)})`; x.fillRect(sc.x + 2, sc.y + 2, sc.w - 4, sc.h - 4); }
    glow(x, W / 2, 110, 220, red ? '#ff3a2a' : '#3aff8a', 0.06 + 0.02 * Math.sin(t * 1.2));
    title(x, 'MU-TH-UR 6000', 30, 36, { size: 16, align: 'left', color: alarm ? '#ff6a5a' : '#6eff9e', glow: alarm ? '#ff3a2a' : '#2aff7a', glowR: 6 });
    title(x, alarm ? '!! PRIORITY ONE !!' : 'LAB 426 · QUARANTINE', W - 30, 36, { size: 16, body: true, align: 'right', color: alarm ? '#ff6a5a' : '#2a9a5a' });
    x.fillStyle = alarm ? '#7a2a20' : '#1d5a36'; x.fillRect(28, 42, W - 56, 1);
    const lines = [];
    for (const l of log) { if (t < l.at) { if (l.who !== 'U') { lines.push({ s: '.'.repeat(1 + ((t * 3) | 0) % 3), c: '#2a7a4a' }); break; } continue; }
      const n = Math.min(l.s.length, ((t - l.at) * 40) | 0);
      for (const [k, w] of wrap(x, (l.who === 'U' ? '> ' : '') + l.s.slice(0, n), 410).entries()) lines.push({ s: (k ? '  ' : '') + w, c: l.who === 'U' ? '#c8e8c0' : l.who === 'X' ? '#ff5a4a' : '#6eff9e', x: l.who === 'X' }); }
    lines.push({ s: '> ' + inp.buf.toUpperCase() + ((t * 2) % 1 < 0.5 ? '_' : ''), c: '#b8ffcc' });
    lines.slice(-10).forEach((l, k) => { if (l.x) glow(x, 120, 56 + k * 16, 60, '#ff3a2a', 0.2); x.save(); x.shadowColor = l.c; x.shadowBlur = 4; text(x, l.s, 30, 60 + k * 16, { color: l.c }); x.restore(); });
    x.restore();
    ASK.forEach((q, i) => button(x, chipX[i], H - 30, chipW[i], 22, i === 3 ? 'ORDER 937' : q, { hot: hot === i, primary: i === 3 && !alarm }));
  });
}

/** Cached console: grey Nostromo metal with hazard stripe, screws and a status lamp row. */
function bezel(W, H) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const x = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
  bg.vignette(x, W, H, '#2a2e34', '#4a5058');
  panel(x, 4, 4, W - 8, H - 42, { style: 'metal', r: 12 });
  for (const [sx, sy] of [[10, 10], [W - 14, 10], [10, H - 46], [W - 14, H - 46]]) { x.fillStyle = PAL.metalHi; x.fillRect(sx, sy, 4, 4); x.fillStyle = '#20252c'; x.fillRect(sx + 1, sy + 2, 2, 1); }
  for (let i = 0; i < W; i += 12) { x.fillStyle = (i / 12) % 2 ? '#e8b830' : '#1a1a1a'; x.beginPath(); x.moveTo(i, H - 36); x.lineTo(i + 12, H - 36); x.lineTo(i + 6, H - 34); x.lineTo(i - 6, H - 34); x.fill(); }
  noise(x, 0, 0, W, H, 0.03, 8); return cv;
}

export default [
  { id: 'biolab-mother', match: (it, R) => R.id === 'biolab' && it.id === 'mother', label: () => 'Talk to MOTHER', sfx: 'crt.on', start: startMother },
];
