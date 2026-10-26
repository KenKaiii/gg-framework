// @ts-check
// Jack's typewriter close-up: a page filling live with the same line, slightly off-kilter, typos and all.
// Hold Space (or mash any key) to type faster; a full page slides out onto the stack.
import { loop, text, rng, keys } from './util.js';
import { SFX } from '../sfx.js';

const LINE = 'All work and no play makes Jack a dull boy.';
const VARIANTS = [LINE, LINE, LINE, 'All work and no play makes Jack a dull boy', 'ALL WORK AND NO PLAY MAKES JACK A DULL BOY.',
  'All work and no play makes Jack a dull  boy.', 'All work and no play makes jack a dull boy.', 'All work and no ply makes Jack a dull boy.', 'Allwork and no play makes Jack a dull boy.'];

/** @param {any} ctx */
export function startTypewriter(ctx) {
  const ov = ctx.overlay({ title: 'The Typewriter', sub: 'Overlook Hall · page 1', help: '<kbd>hold space</kbd> type faster <kbd>hold click</kbd> type faster <kbd>esc</kbd> leave' });
  const W = 480, H = 270; const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const K = keys(ov); let mash = 0; const onKey = e => { if (e.code !== 'Escape') mash = 0.4; }; addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  let held = false; c.addEventListener('pointerdown', e => { if (e.button === 0) { held = true; c.setPointerCapture?.(e.pointerId); } }); const up = () => { held = false; }; c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
  const r = rng(237);
  const mkLine = () => ({ s: VARIANTS[Math.floor(r() * VARIANTS.length)], dx: Math.round((r() - 0.5) * 14), dy: Math.round((r() - 0.5) * 2), ink: 0.75 + r() * 0.25 });
  const st = { t: 0, lines: [mkLine()], n: 0, acc: 0, page: 1, ding: 0, slide: 0, jolt: 0 };
  const PER = 12, LH = 16;
  loop(ov, dt => {
    st.t += dt; mash = Math.max(0, mash - dt);
    const fast = K.has('Space') || held || mash > 0; const cps = fast ? 55 : 16;
    if (st.slide > 0) { st.slide -= dt * 1.6; if (st.slide <= 0) { st.slide = 0; SFX.play('paper'); if (st.page === 2) SFX.play('eerie', { vol: 0.5, delay: 0.3 }); st.lines = [mkLine()]; st.n = 0; st.page++; ov.setSub('Overlook Hall · page ' + st.page); } }
    else {
      st.acc += dt * cps;
      while (st.acc >= 1) { st.acc--; const cur = st.lines[st.lines.length - 1]; st.n++; st.jolt = 1; if (cur.s[st.n - 1] !== ' ') SFX.play('typewriter', { vol: 0.6, jitter: 0.08 });
        if (st.n > cur.s.length) { st.ding = 1; SFX.play('typewriter.ding', { vol: 0.7 }); if (st.lines.length >= PER) { st.slide = 1; break; } st.lines.push(mkLine()); st.n = 0; } }
    }
    st.ding = Math.max(0, st.ding - dt * 2); st.jolt = Math.max(0, st.jolt - dt * 12);
    // backdrop: dark desk + lamp pool
    const bg = x.createRadialGradient(W * 0.35, 30, 10, W / 2, H / 2, W * 0.7); bg.addColorStop(0, '#4a3020'); bg.addColorStop(1, '#0c0808'); x.fillStyle = bg; x.fillRect(0, 0, W, H);
    // paper (slides up and out when full)
    const off = st.slide > 0 ? (1 - st.slide) * -260 : 0;
    x.save(); x.translate(W / 2, 12 + off); x.rotate(-0.012);
    x.fillStyle = 'rgba(0,0,0,0.4)'; x.fillRect(-148, 4, 300, 230);
    x.fillStyle = '#e6dcc2'; x.fillRect(-150, 0, 300, 230); x.fillStyle = 'rgba(120,90,50,0.12)'; x.fillRect(-150, 0, 6, 230);
    st.lines.forEach((l, i) => { const last = i === st.lines.length - 1 && st.slide === 0; const s = last ? l.s.slice(0, st.n) : l.s;
      x.globalAlpha = l.ink; text(x, s, -138 + l.dx, 20 + i * LH + l.dy, { color: '#1a1410' }); x.globalAlpha = 1; });
    text(x, '- ' + st.page + ' -', 0, 222, { color: '#6a5a44', align: 'center' });
    x.restore();
    // typewriter body + platen across the bottom
    const jy = st.jolt > 0.5 ? 1 : 0;
    x.fillStyle = '#16131a'; x.fillRect(40, 214 + jy, W - 80, 60); x.fillStyle = '#2a2630'; x.fillRect(30, 206 + jy, W - 60, 14);
    x.fillStyle = '#b08a4a'; x.fillRect(22, 208 + jy, 10, 10); x.fillRect(W - 32, 208 + jy, 10, 10);
    for (let i = 0; i < 14; i++) { x.fillStyle = '#d8d0b8'; x.beginPath(); x.arc(84 + i * 24, 246 + jy, 7, 0, 7); x.fill(); x.fillStyle = '#16131a'; x.beginPath(); x.arc(84 + i * 24, 246 + jy, 4, 0, 7); x.fill(); }
    if (st.ding > 0) text(x, 'ding!', W - 70, 196 - (1 - st.ding) * 10, { color: '#ffcf8a', shadow: true });
    if (st.page > 2) text(x, 'Wendy? ...darling?', 16, 26, { color: `rgba(224,164,88,${0.5 + 0.3 * Math.sin(st.t * 2)})` });
  });
}
