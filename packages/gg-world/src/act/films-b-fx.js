// @ts-check
// Films B: shared "moment" helper (short in-world close-up with a caption) and screen-space juice (slime, golden tint).
import { CFONT } from '../fonts.js';
import { PAL, panel, title, glow, particles, ease, clamp } from './art.js';
import { setView, clearView, hideOccluders, worldOf, hideBlockers } from './view.js';

const CSS = `
.fb-cap{position:fixed;left:50%;bottom:40px;transform:translate(-50%,8px);opacity:0;transition:opacity .25s,transform .25s;z-index:41;pointer-events:auto;cursor:pointer;
 width:min(92vw,960px);image-rendering:pixelated;filter:drop-shadow(0 12px 30px rgba(0,0,0,.5))}
.fb-cap.on{opacity:1;transform:translate(-50%,0)}
.fb-bars{position:fixed;inset:0;z-index:38;pointer-events:none}
.fb-bars::before,.fb-bars::after{content:'';position:absolute;left:0;right:0;height:7vh;background:#000;transition:transform .5s cubic-bezier(.2,.8,.2,1)}
.fb-bars::before{top:0;transform:translateY(-100%)}.fb-bars::after{bottom:0;transform:translateY(100%)}
.fb-bars.on::before,.fb-bars.on::after{transform:none}
.fb-scr{position:fixed;inset:0;z-index:39;pointer-events:none;image-rendering:pixelated;width:100vw;height:100vh}
`;
function css() { if (document.getElementById('fb-css')) return; const st = document.createElement('style'); st.id = 'fb-css'; st.textContent = CSS; document.head.appendChild(st); }

/** Room themes for the caption card (kit panel style + accent colour). */
const THEME = { garage: ['metal', PAL.cyan], diner: ['neon', PAL.pink], library: ['wood', PAL.goldHi], screening: ['neon', PAL.gold],
  roof: ['glass', PAL.blue], bar: ['wood', PAL.gold], den: ['wood', PAL.red], bedroom: ['paper', PAL.red], basement: ['metal', PAL.green] };
const CW = 480, CH = 104;
/** Caption sprites built once per theme / colour and reused every frame (no per-frame gradients). */
const SPRITES = new Map();
function sprite(key, w, h, draw) { let cv = SPRITES.get(key); if (!cv) { cv = document.createElement('canvas'); cv.width = w; cv.height = h; draw(/** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'))); SPRITES.set(key, cv); } return cv; }
const chip = (x, s, X) => { panel(x, X, 70, 18 + s.length * 6, 16, { style: 'metal', r: 2 }); title(x, s, X + 9 + s.length * 3, 82, { size: 16, body: true, color: PAL.cream }); return X + 22 + s.length * 6; };
const CHIPS_END = CW / 2 - 84 + 28 + 52;
const cardOf = style => sprite('card:' + style, CW, CH, x => { panel(x, 8, 6, CW - 16, CH - 16, { style }); chip(x, 'SPACE', chip(x, 'E', CW / 2 - 84)); });
const glowOf = col => sprite('glow:' + col, 340, 340, x => glow(x, 170, 170, 170, col, 1));
const sweep = sprite('sweep', 40, 1, x => { const g = x.createLinearGradient(0, 0, 40, 0); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.18)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, 40, 1); });

/**
 * Caption card at the bottom of the screen, drawn with the mini-game kit (art.js): a themed framed panel that pops in,
 * Alagard title with a glow, the line, key chips + click hint, a time bar, letterbox bars, and a pop + sparks
 * whenever the title changes. o.progress() (0..1) drives the time bar.
 * @param {string} head @param {string} line @param {{ style?: string, color?: string, progress?: () => number }} [o]
 */
export function caption(head, line, o = {}) {
  css(); const el = document.createElement('canvas'); el.className = 'fb-cap'; el.setAttribute('role', 'status'); el.width = CW; el.height = CH;
  const box = document.createElement('div'); box.className = 'fb-bars'; document.body.appendChild(box);
  el.setAttribute('aria-label', head + '. ' + line);
  const x = /** @type {CanvasRenderingContext2D} */ (el.getContext('2d')); x.imageSmoothingEnabled = false;
  const style = o.style || 'glass', col = o.color || PAL.gold, fx = particles(), card = cardOf(style), halo = glowOf(col);
  let T = head, L = line, t = 0, pop = 0, on = true, last = performance.now(), hot = false;
  el.addEventListener('pointermove', () => { hot = true; }); el.addEventListener('pointerleave', () => { hot = false; });
  const draw = now => {
    if (!on) return; const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt; pop = Math.max(0, pop - dt * 3);
    x.clearRect(0, 0, CW, CH); const k = ease.outBack(clamp(t / 0.4, 0, 1)), sc = k * (1 + pop * 0.06);
    x.save(); x.translate(CW / 2, CH / 2); x.scale(sc, sc); x.translate(-CW / 2, -CH / 2);
    x.drawImage(card, 0, 0); const p = { text: style === 'paper' ? PAL.paperInk : PAL.cream };
    x.save(); x.globalCompositeOperation = 'lighter'; x.globalAlpha = clamp(0.10 + 0.05 * Math.sin(t * 2.4) + pop * 0.25, 0, 1); x.drawImage(halo, CW / 2 - 170, 30 - 170); x.restore();
    x.font = CFONT.title(32); const tw = x.measureText(T).width; title(x, T, CW / 2, tw > CW - 60 ? 34 : 38, { size: tw > CW - 60 ? 16 : 32, color: col, glow: col, glowR: 8 + pop * 10 });
    title(x, L, CW / 2, 62, { size: 16, body: true, color: p.text === PAL.paperInk ? PAL.paperInk : PAL.cream, ink: p.text === PAL.paperInk ? 'rgba(255,246,224,0.6)' : PAL.ink });
    // controls: key chips + click hint, and the time bar
    title(x, hot ? 'or click: carry on' : 'or click', CHIPS_END + 2, 82, { size: 16, body: true, align: 'left', color: hot ? PAL.goldHi : PAL.dim });
    const pr = clamp(o.progress?.() ?? 0, 0, 1); x.fillStyle = 'rgba(0,0,0,0.45)'; x.fillRect(20, CH - 16, CW - 40, 2); x.fillStyle = col; x.fillRect(20, CH - 16, Math.round((CW - 40) * (1 - pr)), 2);
    if (t < 1.2) { const sp = ((t + 0.85) * 0.6 % 2) - 0.5; if (sp >= 0 && sp <= 1) { x.save(); x.beginPath(); x.rect(8, 6, CW - 16, CH - 16); x.clip(); x.drawImage(sweep, 8 + sp * (CW + 24) - 40, 6, 40, CH - 16); x.restore(); } }
    fx.draw(x, dt); x.restore(); requestAnimationFrame(draw);
  };
  document.body.appendChild(el); requestAnimationFrame(() => { el.classList.add('on'); box.classList.add('on'); }); requestAnimationFrame(draw);
  return { el, set(tt, ll) { if (tt != null && tt !== T) { T = tt; pop = 1; fx.burst(CW / 2, 30, { n: 22, colors: [col, PAL.goldHi, PAL.cream], speed: 90 }); } if (ll != null) { L = ll; if (tt == null) pop = Math.max(pop, 0.4); } el.setAttribute('aria-label', T + '. ' + L); },
    remove() { el.classList.remove('on'); box.classList.remove('on'); setTimeout(() => { on = false; el.remove(); box.remove(); }, 300); } };
}

/**
 * A short in-world close-up: blends the camera onto a prop, shows a caption, runs tick(dt, t, api) each frame and ends
 * after `secs`, on E/Space/Enter, or when Esc ends the activity. Always restores the view and calls done().
 * @param {any} ctx activity ctx
 * @param {{ at:[number,number,number], dir:{x:number,y:number,z:number}, up?:{x:number,y:number,z:number}, zoom:number, walls?:boolean,
 *   title:string, line:string, secs?:number, style?:string, color?:string, tick?:(dt:number,t:number,api:any)=>void, end?:()=>void }} o
 */
export function moment(ctx, o) {
  const { S, R } = ctx, me = S.act?.current, base = worldOf(R, o.at[0], o.at[1], o.at[2]);
  setView(S, { target: base, dir: o.dir, up: o.up, zoom: o.zoom }); if (o.walls !== false) hideOccluders(S);
  const blk = hideBlockers(S, S.scene || R.root, base, o.dir, { me: o.hideMe !== false });
  const th = THEME[R.id] || [], cap = caption(o.title, o.line, { style: o.style || th[0], color: o.color || th[1], progress: () => t / (o.secs || 4) }); let on = true, t = 0, last = performance.now(), shakeA = 0;
  const api = { cap, shake: a => { shakeA = Math.max(shakeA, a); }, stop: () => stop() };
  const stop = () => {
    if (!on) return; on = false; removeEventListener('keydown', key, true); cap.el.removeEventListener('pointerdown', click); clearView(S); cap.remove(); blk.restore();
    try { o.end?.(); } catch (e) { console.warn(e); }
    if (S.act?.current === me) ctx.done();
  };
  const key = e => { if (t > 0.35 && (e.code === 'KeyE' || e.code === 'Space' || e.code === 'Enter')) { e.preventDefault(); e.stopPropagation(); stop(); } };
  const click = e => { if (t > 0.35 && e.button === 0) { e.preventDefault(); e.stopPropagation(); stop(); } };
  addEventListener('keydown', key, true); cap.el.addEventListener('pointerdown', click);
  const step = now => {
    if (!on) return; if (S.act?.current !== me) { stop(); return; }
    const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
    blk.tick(dt);
    try { o.tick?.(dt, t, api); } catch (e) { console.warn(e); }
    if (S.view) { shakeA *= Math.exp(-dt * 7); S.view.target.set(base.x + (Math.random() - 0.5) * shakeA, base.y + (Math.random() - 0.5) * shakeA, base.z + (Math.random() - 0.5) * shakeA); }
    if (t >= (o.secs || 4)) { stop(); return; }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return api;
}

/** Full-screen low-res canvas effect layer that removes itself after `secs`. draw(x, k 0..1, t). */
function screenFx(w, h, secs, draw, smooth = false) {
  css(); const c = document.createElement('canvas'); c.width = w; c.height = h; c.className = 'fb-scr'; if (smooth) c.style.imageRendering = 'auto'; document.body.appendChild(c);
  const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')); x.imageSmoothingEnabled = false; const t0 = performance.now();
  const step = now => { const t = (now - t0) / 1000; if (t > secs) { c.remove(); return; } x.clearRect(0, 0, w, h); draw(x, t / secs, t); requestAnimationFrame(step); };
  requestAnimationFrame(step); return c;
}

/** Green slime splat on the "camera lens": blobs, drips running down, fades out. */
export function slime(seed = 1) {
  let s = seed >>> 0 || 1; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const W = 160, H = 90, blobs = [], drips = [];
  const cx = 60 + r() * 40, cy = 28 + r() * 20;
  for (let i = 0; i < 14; i++) { const a = r() * 7, d = r() * 18; blobs.push([cx + Math.cos(a) * d * 1.4, cy + Math.sin(a) * d, 4 + r() * 9]); }
  for (let i = 0; i < 8; i++) { const a = r() * 7; blobs.push([cx + Math.cos(a) * (26 + r() * 10), cy + Math.sin(a) * (18 + r() * 8), 1.5 + r() * 2.5]); }
  for (let i = 0; i < 7; i++) drips.push([cx - 22 + r() * 44, cy + 4 + r() * 8, 2 + r() * 2, 8 + r() * 30]);
  return screenFx(W, H, 3.2, (x, k, t) => {
    x.globalAlpha = k < 0.75 ? 0.92 : 0.92 * (1 - (k - 0.75) / 0.25); const pop = Math.min(1, t * 8);
    for (const pass of [['#1f7a2a', 1.15], ['#5be35a', 1], ['#b8ff9a', 0.35]]) {
      x.fillStyle = /** @type {string} */ (pass[0]); const m = /** @type {number} */ (pass[1]);
      for (const [bx, by, br] of blobs) { x.beginPath(); x.arc(bx - (m < 1 ? br * 0.3 : 0), by - (m < 1 ? br * 0.3 : 0), Math.max(0.5, br * m * pop), 0, 7); x.fill(); }
      if (m >= 1) for (const [dx, dy, dw, dl] of drips) { const len = dl * Math.min(1, t / 2.2) * pop; x.fillRect(Math.round(dx), dy, dw, len); x.beginPath(); x.arc(dx + dw / 2, dy + len, dw * 0.8, 0, 7); x.fill(); }
    }
  });
}

/** Warm golden wash from below (briefcase glow on the face). */
export function goldWash(secs = 4) {
  return screenFx(64, 36, secs, (x, k) => {
    const a = Math.min(1, k * 6) * (k > 0.8 ? (1 - k) / 0.2 : 1);
    const g = x.createRadialGradient(32, 40, 2, 32, 40, 40); g.addColorStop(0, `rgba(255,200,90,${0.45 * a})`); g.addColorStop(1, 'rgba(255,170,60,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 36);
  }, true);
}
