// @ts-check
// Films B: shared "moment" helper (short in-world close-up with a caption) and screen-space juice (slime, golden tint).
import { FONT } from '../fonts.js';
import { setView, clearView, hideOccluders, worldOf } from './view.js';

const CSS = `
.fb-cap{position:fixed;left:50%;bottom:56px;transform:translate(-50%,8px);opacity:0;transition:opacity .25s,transform .25s;z-index:41;pointer-events:none;
 background:rgba(14,16,20,.92);box-shadow:inset 0 0 0 1px #263228,0 12px 40px rgba(0,0,0,.5);border-radius:6px;padding:10px 18px 12px;text-align:center;-webkit-font-smoothing:none;max-width:80vw}
.fb-cap.on{opacity:1;transform:translate(-50%,0)}
.fb-cap .t{font:32px/32px ${FONT.title};color:#e0a458;text-shadow:0 2px 0 #3a2410}
.fb-cap .l{font:32px/32px ${FONT.body};color:#d8dccf;margin-top:6px}
.fb-cap .h{font:16px/16px ${FONT.body};color:#8e9a88;margin-top:8px}
.fb-scr{position:fixed;inset:0;z-index:39;pointer-events:none;image-rendering:pixelated;width:100vw;height:100vh}
`;
function css() { if (document.getElementById('fb-css')) return; const st = document.createElement('style'); st.id = 'fb-css'; st.textContent = CSS; document.head.appendChild(st); }

/** Caption card at the bottom of the screen. */
export function caption(title, line) {
  css(); const el = document.createElement('div'); el.className = 'fb-cap'; el.setAttribute('role', 'status');
  const t = document.createElement('div'); t.className = 't'; t.textContent = title;
  const l = document.createElement('div'); l.className = 'l'; l.textContent = line;
  const h = document.createElement('div'); h.className = 'h'; h.textContent = 'E / esc to carry on';
  el.append(t, l, h); document.body.appendChild(el); requestAnimationFrame(() => el.classList.add('on'));
  return { el, set(tt, ll) { if (tt != null) t.textContent = tt; if (ll != null) l.textContent = ll; }, remove() { el.classList.remove('on'); setTimeout(() => el.remove(), 260); } };
}

/**
 * A short in-world close-up: blends the camera onto a prop, shows a caption, runs tick(dt, t, api) each frame and ends
 * after `secs`, on E/Space/Enter, or when Esc ends the activity. Always restores the view and calls done().
 * @param {any} ctx activity ctx
 * @param {{ at:[number,number,number], dir:{x:number,y:number,z:number}, up?:{x:number,y:number,z:number}, zoom:number, walls?:boolean,
 *   title:string, line:string, secs?:number, tick?:(dt:number,t:number,api:any)=>void, end?:()=>void }} o
 */
export function moment(ctx, o) {
  const { S, R } = ctx, me = S.act?.current, base = worldOf(R, o.at[0], o.at[1], o.at[2]);
  setView(S, { target: base, dir: o.dir, up: o.up, zoom: o.zoom }); if (o.walls !== false) hideOccluders(S);
  const cap = caption(o.title, o.line); let on = true, t = 0, last = performance.now(), shakeA = 0;
  const api = { cap, shake: a => { shakeA = Math.max(shakeA, a); }, stop: () => stop() };
  const stop = () => {
    if (!on) return; on = false; removeEventListener('keydown', key, true); clearView(S); cap.remove();
    try { o.end?.(); } catch (e) { console.warn(e); }
    if (S.act?.current === me) ctx.done();
  };
  const key = e => { if (t > 0.35 && (e.code === 'KeyE' || e.code === 'Space' || e.code === 'Enter')) { e.preventDefault(); e.stopPropagation(); stop(); } };
  addEventListener('keydown', key, true);
  const step = now => {
    if (!on) return; if (S.act?.current !== me) { stop(); return; }
    const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
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
