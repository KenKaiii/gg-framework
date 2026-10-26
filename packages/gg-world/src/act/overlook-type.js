// @ts-check
// Jack's typewriter close-up: a page filling live with the same line, slightly off-kilter, typos and all.
// Hold Space (or mash any key) to type faster; a full page slides out onto the stack.
import { loop, text, rng, keys } from './util.js';
import { SFX } from '../sfx.js';
import { PAL, panel, badge, button, title, glow, noise, particles, shaker, clamp } from './art.js';

/** Cached desk: dark wood grain under a lamp pool, Overlook carpet hexes at the edges. */
function desk(W, H) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const x = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
  const g = x.createRadialGradient(W * 0.35, 30, 10, W / 2, H / 2, W * 0.7); g.addColorStop(0, '#5a3824'); g.addColorStop(1, '#0c0808'); x.fillStyle = g; x.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y += 5) { x.fillStyle = `rgba(0,0,0,${0.08 + (y * 37 % 11) / 100})`; x.fillRect(0, y, W, 1); }
  for (let i = 0; i < 40; i++) { x.fillStyle = 'rgba(255,200,140,0.05)'; x.fillRect((i * 97) % W, (i * 53) % H, 30 + i % 20, 1); }
  noise(x, 0, 0, W, H, 0.04, 21);
  const v = x.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.7); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.6)'); x.fillStyle = v; x.fillRect(0, 0, W, H);
  return cv;
}
/** Cached sheet of paper: aged edges, faint ruled margin, drop shadow. */
function paper() {
  const cv = document.createElement('canvas'); cv.width = 308; cv.height = 240; const x = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
  x.fillStyle = 'rgba(0,0,0,0.45)'; x.fillRect(6, 8, 300, 230);
  const g = x.createLinearGradient(0, 0, 0, 232); g.addColorStop(0, '#f2e8d0'); g.addColorStop(1, '#d8caa8'); x.fillStyle = g; x.fillRect(2, 2, 300, 230);
  x.fillStyle = 'rgba(200,60,60,0.25)'; x.fillRect(20, 2, 1, 230); x.fillStyle = 'rgba(120,90,50,0.15)'; x.fillRect(2, 2, 6, 230); x.fillRect(296, 2, 6, 230);
  noise(x, 2, 2, 300, 230, 0.05, 4); return cv;
}
/** Cached typewriter: black enamel body with gold pinstripe, chrome carriage, two rows of round keys. */
function typewriter(W) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = 280; const x = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
  x.fillStyle = 'rgba(0,0,0,0.5)'; x.fillRect(36, 210, W - 72, 70);
  let g = x.createLinearGradient(0, 214, 0, 280); g.addColorStop(0, '#2a2630'); g.addColorStop(1, '#0a080c'); x.fillStyle = g; x.fillRect(40, 214, W - 80, 66);
  x.fillStyle = 'rgba(255,255,255,0.15)'; x.fillRect(42, 215, W - 84, 1); x.fillStyle = PAL.goldD; x.fillRect(50, 224, W - 100, 1);
  g = x.createLinearGradient(0, 204, 0, 220); g.addColorStop(0, '#e8ecf2'); g.addColorStop(0.5, '#6a707a'); g.addColorStop(1, '#2a2e36'); x.fillStyle = g; x.fillRect(30, 204, W - 60, 14); // platen
  for (let i = 0; i < W - 60; i += 4) { x.fillStyle = 'rgba(0,0,0,0.15)'; x.fillRect(30 + i, 204, 1, 14); }
  for (const kx of [20, W - 34]) { g = x.createRadialGradient(kx + 7, 209, 1, kx + 7, 211, 9); g.addColorStop(0, PAL.goldHi); g.addColorStop(1, PAL.goldD); x.fillStyle = g; x.beginPath(); x.arc(kx + 7, 211, 8, 0, 7); x.fill(); }
  title(x, 'ROYAL', W / 2, 238, { size: 16, color: PAL.gold });
  for (let row = 0; row < 2; row++) for (let i = 0; i < 14 - row; i++) { const kx = 84 + i * 24 + row * 12, ky = 254 + row * 16 - 8;
    x.fillStyle = '#0a080c'; x.beginPath(); x.arc(kx, ky + 2, 8, 0, 7); x.fill(); x.fillStyle = '#c8ccd4'; x.beginPath(); x.arc(kx, ky, 8, 0, 7); x.fill();
    x.fillStyle = '#f0ead8'; x.beginPath(); x.arc(kx, ky, 6, 0, 7); x.fill(); x.fillStyle = '#2a2420'; x.font = '8px monospace'; x.fillRect(kx - 1, ky - 1, 2, 2); }
  return cv;
}

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
  const st = { burst: 0, t: 0, lines: [mkLine()], n: 0, acc: 0, page: 1, ding: 0, slide: 0, jolt: 0 };
  const PER = 12, LH = 16, fx = particles(), shake = shaker(), back = desk(W, H), sheet = paper(), machine = typewriter(W); let typed = 0, hov = false;
  c.addEventListener('pointermove', e => { const q = c.getBoundingClientRect(), px = (e.clientX - q.left) / q.width * W, py = (e.clientY - q.top) / q.height * H; hov = px > W - 74 && py > 46 && py < 70; }); c.style.cursor = 'pointer';
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
    if (st.slide > 0 && !st.burst) { st.burst = 1; fx.burst(W / 2, 40, { n: 18, colors: [PAL.paper, PAL.cream, '#c8b890'], speed: 60, up: 60 }); shake.kick(2); }
    if (st.slide === 0) st.burst = 0;
    typed += dt * cps * (st.slide ? 0 : 1);
    x.drawImage(back, 0, 0); glow(x, 120, 20, 160, '#ffcf8a', 0.16 + 0.03 * Math.sin(st.t * 1.3));
    x.save(); shake.apply(x, dt);
    // paper (slides up and out when full)
    const off = st.slide > 0 ? (1 - st.slide) * -260 : 0;
    x.save(); x.translate(W / 2, 12 + off); x.rotate(-0.012);
    x.drawImage(sheet, -152, -2);
    st.lines.forEach((l, i) => { const last = i === st.lines.length - 1 && st.slide === 0; const s = last ? l.s.slice(0, st.n) : l.s;
      x.globalAlpha = l.ink; text(x, s, -138 + l.dx, 20 + i * LH + l.dy, { color: '#1a1410' }); x.globalAlpha = 1; });
    text(x, '- ' + st.page + ' -', 0, 222, { color: '#6a5a44', align: 'center' });
    x.restore();
    // typewriter: drawn machine (cached), the carriage jolts on each key
    const jy = st.jolt > 0.5 ? 1 : 0; x.drawImage(machine, 0, jy);
    const cur = st.lines[st.lines.length - 1], carX = 40 + (cur ? st.n / cur.s.length : 0) * 22;
    x.fillStyle = '#c8ccd4'; x.fillRect(Math.round(carX), 200 + jy, 18, 3); x.fillStyle = '#fff'; x.fillRect(Math.round(carX), 200 + jy, 18, 1);
    const hk = Math.floor(st.t * cps) % 14; if (fast || st.jolt > 0) { x.fillStyle = 'rgba(255,207,138,0.5)'; x.beginPath(); x.arc(84 + hk * 24, 247, 7, 0, 7); x.fill(); }
    if (st.ding > 0) title(x, 'ding!', W - 60, 194 - (1 - st.ding) * 12, { size: 16, color: PAL.goldHi, glow: PAL.gold });
    fx.draw(x, dt); x.restore();
    // HUD: pages + keystrokes + typing speed, the hold-to-type button
    badge(x, 8, 8, 'page', st.page, { style: 'wood', color: PAL.goldHi, w: 58 });
    badge(x, 8, 46, 'keys', Math.floor(typed), { style: 'wood', color: PAL.cream, w: 58 });
    badge(x, W - 74, 8, 'speed', fast ? 'FAST' : 'slow', { style: 'wood', color: fast ? PAL.red : PAL.dim, w: 66 });
    button(x, W - 74, 46, 66, 24, 'TYPE', { primary: true, hot: hov || held, down: held });
    if (st.page > 2) title(x, 'Wendy? ...darling?', 76, 100, { size: 16, body: true, align: 'left', color: `rgba(224,164,88,${0.6 + 0.3 * Math.sin(st.t * 2)})` });
    // start card: how to play, fades after a few seconds or on the first key
    const ca = clamp(3.2 - st.t, 0, 1) * (typed > 30 ? 0 : 1);
    if (ca > 0) { x.globalAlpha = ca; const p = panel(x, W / 2 - 120, 92, 240, 66, { style: 'paper' }); title(x, 'THE TYPEWRITER', W / 2, p.y + 24, { size: 16, color: '#7a1a14', ink: 'rgba(255,246,224,0.7)' });
      title(x, 'hold SPACE or hold click: type faster', W / 2, p.y + 42, { size: 16, body: true, color: PAL.paperInk, ink: 'rgba(255,246,224,0.6)' }); title(x, 'ESC: leave', W / 2, p.y + 57, { size: 16, body: true, color: '#7a5a48', ink: 'rgba(255,246,224,0.6)' }); x.globalAlpha = 1; }
  });
}
