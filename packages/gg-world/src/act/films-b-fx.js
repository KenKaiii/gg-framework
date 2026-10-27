// @ts-check
// Films B: shared "moment" helper (short in-world close-up with a caption) and screen-space juice (slime, golden tint).
import { FONT } from '../fonts.js';
import { GX, keys } from './gx.js';
import { setView, clearView, hideOccluders, worldOf, hideBlockers } from './view.js';

const CSS = `
.fb-cap{position:fixed;left:50%;bottom:calc(7vh + 14px);transform:translate(-50%,10px);opacity:0;transition:opacity .28s,transform .32s cubic-bezier(.22,1,.36,1);z-index:41;pointer-events:auto;cursor:pointer;
 width:min(calc(100vw - 40px),620px);box-sizing:border-box;padding:16px 22px 14px;border-radius:16px;background:rgba(21,23,26,.82);-webkit-backdrop-filter:blur(14px) saturate(1.2);backdrop-filter:blur(14px) saturate(1.2);
 box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 0 0 1px rgba(255,255,255,.07),0 18px 40px -14px rgba(0,0,0,.8);font-family:${FONT.app};color:${GX.text};text-align:center;-webkit-font-smoothing:antialiased;overflow:hidden}
.fb-cap.on{opacity:1;transform:translate(-50%,0)}
.fb-cap h3{margin:0;font-size:20px;line-height:1.25;font-weight:700;letter-spacing:-.02em;color:var(--ac);transition:transform .3s cubic-bezier(.3,1.6,.6,1)}
.fb-cap h3.pop{transform:scale(1.06)}
.fb-cap p{margin:5px 0 0;font-size:14px;line-height:1.45;color:${GX.text2};min-height:1.45em}
.fb-cap .ks{display:flex;justify-content:center;align-items:center;gap:6px;margin:11px 0 0;font-size:12px;line-height:1.3;color:${GX.muted}}
.fb-cap .gx-key{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;border-radius:6px;background:${GX.key};color:${GX.text};font:600 11px/1.3 ${FONT.app};box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 1px 0 #0b0c0e,0 2px 4px -2px rgba(0,0,0,.6)}
.fb-cap .ks span:last-child{margin-left:4px}
.fb-cap:hover .ks{color:${GX.text}}
.fb-cap .bar{position:absolute;left:0;bottom:0;height:3px;width:100%;background:var(--ac);opacity:.7;transform-origin:left}
.fb-bars{position:fixed;inset:0;z-index:38;pointer-events:none}
.fb-bars::before,.fb-bars::after{content:'';position:absolute;left:0;right:0;height:7vh;background:#000;transition:transform .5s cubic-bezier(.2,.8,.2,1)}
.fb-bars::before{top:0;transform:translateY(-100%)}.fb-bars::after{bottom:0;transform:translateY(100%)}
.fb-bars.on::before,.fb-bars.on::after{transform:none}
.fb-scr{position:fixed;inset:0;z-index:39;pointer-events:none;width:100vw;height:100vh}
@media (prefers-reduced-motion: reduce){.fb-cap,.fb-cap h3{transition:none}}
`;
function css() { if (document.getElementById('fb-css')) return; const st = document.createElement('style'); st.id = 'fb-css'; st.textContent = CSS; document.head.appendChild(st); }

/** Room accent for the caption title (the room's light). */
const THEME = { garage: GX.teal, diner: GX.pink, library: GX.lamp, screening: GX.warning, roof: GX.primary, bar: GX.lamp, den: GX.error, bedroom: GX.error, basement: GX.success };

/**
 * App-style caption card at the bottom of the screen (Sora): title in the room's accent, a one-line quote, the action
 * keys as kit chips, a time bar, and letterbox bars. o.progress() (0..1) drives the time bar.
 * @param {string} head @param {string} line @param {{ style?: string, color?: string, progress?: () => number }} [o]
 */
export function caption(head, line, o = {}) {
  css(); const el = document.createElement('div'); el.className = 'fb-cap'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
  el.style.setProperty('--ac', o.color || GX.lamp);
  el.innerHTML = `<h3></h3><p></p><div class="ks">${keys(['E', 'Space'])}<span>or click to carry on</span></div><div class="bar"></div>`;
  const h = /** @type {HTMLElement} */ (el.querySelector('h3')), pEl = /** @type {HTMLElement} */ (el.querySelector('p')), bar = /** @type {HTMLElement} */ (el.querySelector('.bar'));
  h.textContent = head; pEl.textContent = line;
  const box = document.createElement('div'); box.className = 'fb-bars'; document.body.appendChild(box);
  let on = true; let T = head;
  const draw = () => { if (!on) return; bar.style.transform = `scaleX(${Math.max(0, Math.min(1, 1 - (o.progress?.() ?? 0)))})`; requestAnimationFrame(draw); };
  document.body.appendChild(el); requestAnimationFrame(() => { el.classList.add('on'); box.classList.add('on'); }); requestAnimationFrame(draw);
  return { el, set(tt, ll) { if (tt != null && tt !== T) { T = tt; h.textContent = tt; h.classList.add('pop'); setTimeout(() => h.classList.remove('pop'), 300); } if (ll != null) pEl.textContent = ll; },
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
  const cap = caption(o.title, o.line, { color: o.color || THEME[R.id], progress: () => t / (o.secs || 4) }); let on = true, t = 0, last = performance.now(), shakeA = 0;
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
function screenFx(w, h, secs, draw, smooth = false, k = 1) {
  css(); const c = document.createElement('canvas'); c.width = w * k; c.height = h * k; c.className = 'fb-scr'; if (smooth) c.style.imageRendering = 'auto'; document.body.appendChild(c);
  const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')); x.imageSmoothingEnabled = false; x.scale(k, k); const t0 = performance.now();
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
  }, true, 8);
}

/** Warm golden wash from below (briefcase glow on the face). */
export function goldWash(secs = 4) {
  return screenFx(64, 36, secs, (x, k) => {
    const a = Math.min(1, k * 6) * (k > 0.8 ? (1 - k) / 0.2 : 1);
    const g = x.createRadialGradient(32, 40, 2, 32, 40, 40); g.addColorStop(0, `rgba(255,200,90,${0.45 * a})`); g.addColorStop(1, 'rgba(255,170,60,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 36);
  }, true);
}
