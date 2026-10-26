// @ts-check
// Full-screen activity overlay. Activities draw into it (a 2D canvas, or their own WebGL canvas, or HTML).
// Opening it hides the HUD, stops world input and pauses the world render loop's input; Esc or the close button exits.
import { SFX } from '../sfx.js';
import { FONT } from '../fonts.js';

const CSS = `
.act{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(6,6,10,.0);transition:background-color .25s;font-family:${FONT.body};color:#d8dccf;-webkit-font-smoothing:none}
.act.on{background:rgba(6,6,10,.82)}
.act .stage{position:relative;display:flex;align-items:center;justify-content:center;opacity:0;transform:scale(.97);transition:opacity .25s,transform .25s}
.act.on .stage{opacity:1;transform:none}
.act canvas{display:block;image-rendering:pixelated;border-radius:6px;box-shadow:0 0 0 1px #263228,0 20px 60px rgba(0,0,0,.6)}
.act .top{position:fixed;top:14px;left:14px;right:14px;display:flex;align-items:center;gap:12px;pointer-events:none}
.act .ttl{font-family:${FONT.title};font-size:32px;line-height:32px;color:#e0a458;text-shadow:0 2px 0 #3a2410}
.act .sub{font-size:16px;line-height:16px;color:#8e9a88}
.act .x{all:unset;pointer-events:auto;margin-left:auto;cursor:pointer;font:16px/16px ${FONT.body};padding:8px 12px;border-radius:6px;background:rgba(14,16,20,.9);box-shadow:inset 0 0 0 1px #263228;color:#c9d1c4}
.act .x:hover{box-shadow:inset 0 0 0 1px #3d7a52;color:#e8efe4}.act .x:focus-visible{outline:2px solid #6ee7a0;outline-offset:2px}
.act .help{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);font-size:16px;line-height:16px;color:#8e9a88;background:rgba(14,16,20,.9);padding:8px 12px;border-radius:6px;box-shadow:inset 0 0 0 1px #263228;white-space:nowrap}
.act .help kbd{font:inherit;color:#6ee7a0;padding:0 4px;border-radius:3px;box-shadow:inset 0 0 0 1px #2f5a3d;margin-right:4px}
body.in-act #ui{opacity:0;pointer-events:none;transition:opacity .2s}
@media (prefers-reduced-motion: reduce){.act,.act .stage{transition:none}}
`;
let styled = false;
/** Inject the overlay/HUD-fade CSS (idempotent). Called by the registry at init so in-world activities (no overlay,
 *  e.g. films-b moment()) also fade the HUD via body.in-act. */
export function ensureStyle() { if (!styled) { const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); styled = true; } }

/**
 * @param {{ title: string, sub?: string, help?: string }} o
 * @returns {{ el: HTMLDivElement, stage: HTMLDivElement, canvas: (w:number,h:number,scale?:number)=>{c:HTMLCanvasElement,x:CanvasRenderingContext2D}, setHelp:(h:string)=>void, setSub:(s:string)=>void, close:()=>void, onClose:(f:()=>void)=>void }}
 */
export function overlay(o) {
  ensureStyle();
  const el = document.createElement('div'); el.className = 'act'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', o.title);
  el.innerHTML = `<div class="top"><div><div class="ttl"></div><div class="sub"></div></div><button class="x" type="button">esc &middot; leave</button></div><div class="stage"></div><div class="help"></div>`;
  /** @type {HTMLDivElement} */ const stage = /** @type {any} */ (el.querySelector('.stage'));
  const ttl = /** @type {HTMLElement} */ (el.querySelector('.ttl')), sub = /** @type {HTMLElement} */ (el.querySelector('.sub')), help = /** @type {HTMLElement} */ (el.querySelector('.help'));
  ttl.textContent = o.title; sub.textContent = o.sub || ''; help.innerHTML = o.help || ''; help.style.display = o.help ? '' : 'none';
  document.body.appendChild(el); requestAnimationFrame(() => el.classList.add('on'));
  const closers = []; let closed = false;
  SFX.play('ui.open');
  const close = () => { if (closed) return; closed = true; SFX.play('ui.close'); el.classList.remove('on'); for (const f of closers) try { f(); } catch (e) { console.warn(e); } setTimeout(() => el.remove(), 260); };
  /** @type {HTMLButtonElement} */ (el.querySelector('.x')).addEventListener('click', close);
  return {
    el, stage, close, onClose: f => closers.push(f),
    setHelp: h => { help.innerHTML = h; help.style.display = h ? '' : 'none'; },
    setSub: s => { sub.textContent = s; },
    canvas(w, h, scale) {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const fit = () => { const k = scale || Math.max(1, Math.floor(Math.min((innerWidth - 40) / w, (innerHeight - 120) / h) * 4) / 4); c.style.width = w * k + 'px'; c.style.height = h * k + 'px'; };
      fit(); addEventListener('resize', fit); closers.push(() => removeEventListener('resize', fit));
      stage.appendChild(c); return { c, x: /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')) };
    },
  };
}
