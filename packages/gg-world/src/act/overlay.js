// @ts-check
// Full-screen activity overlay. Activities draw into it (a 2D canvas, or their own WebGL canvas, or HTML).
// Opening it hides the HUD, stops world input and pauses the world render loop's input. Every overlay has the app's
// own leave button at the bottom (Stand up / Hang up / Log off...: leaveLabel below), never an "esc to close" hint;
// Esc still works as a quiet shortcut (registry.js).
import { SFX } from '../sfx.js';
import { FONT } from '../fonts.js';
import { makeHi, crispFit, setRenderScale } from './hires.js';
/** Room the bottom dock (help bar + leave button) takes (the help can wrap on narrow windows). @param {HTMLElement} help */
export const bottomOf = help => { const d = /** @type {HTMLElement | null} */ (help?.closest?.('.dock')) || help; return d && d.style.display !== 'none' && d.offsetHeight ? innerHeight - d.getBoundingClientRect().top + 10 : 16; };

/** What the leave button says, by what you're using (seated: Stand up). */
const LEAVE_BY = [
  [/payphone|phone/, 'Hang up'], [/typewriter|window|lights/, 'Step back'],
  [/arcade|pinball|game|pool|dart|duel|loot|raid|race|maze|totem|spar|gibson|slip|plat|snake|mine|d20|crt/, 'Step back'],
  [/board|poster|sign|tome|book|shelf|menu|map|note|card|plan|catalog|rules|quest/, 'Done reading'],
  [/pc|terminal|computer|server|monitor|screen|rack|wopr|hal\b|mother|neo|handle|prompt|trail/, 'Log off'],
  [/tv|cinema|screening|trailer/, 'Stop watching'], [/telescope|scope/, 'Look away'],
  [/food|fridge|vending|popcorn|counter|pie|soap|coffee|kitchen/, 'All done'],
  [/jukebox|radio/, 'Step back'],
];
/** @param {any} it interactable @param {string} actId @param {boolean} seated */
export function leaveLabel(it, actId, seated) {
  if (seated) return 'Stand up';
  const key = [it?.kind, it?.id, actId].filter(Boolean).join(' ').toLowerCase();
  for (const [re, label] of LEAVE_BY) if (/** @type {RegExp} */ (re).test(key)) return /** @type {string} */ (label);
  return 'Step away';
}
/** Pull the "<kbd>esc</kbd> verb" hint out of a help line: returns the line without it and the verb, if one is given. */
function takeEsc(h) {
  let verb = '';
  const out = String(h || '').replace(/(\s*(·|&middot;|&nbsp;)\s*)?<kbd>esc<\/kbd>\s*((?!<kbd>)[a-z][a-z ]*[a-z])?(\s*(·|&middot;))?/gi, (_m, a, _b, v, z) => { if (v && !verb) verb = v.trim(); return a && z ? ' · ' : ' '; });
  return { help: out.replace(/\s{2,}/g, ' ').replace(/^(\s*(&nbsp;|·))+|((&nbsp;|·)\s*)+$/g, '').trim(), verb };
}
const cap1 = s => s.charAt(0).toUpperCase() + s.slice(1);
/** Space kept clear at the top (the app's Back + window buttons sit there when embedded) and bottom (help bar). */
export const TOP = () => document.documentElement.classList.contains('embedded') ? 72 : 60;

const CSS = `
.act{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(6,6,10,.0);transition:background-color .25s;font-family:${FONT.body};color:#d8dccf;-webkit-font-smoothing:none}
.act.on{background:rgba(6,6,10,.82)}
/* lean (every activity opened from an object): the room stays, lit, around the game; a soft vignette instead of a dark box */
.act.lean,.act.lean.on{background:transparent;transition:opacity .3s} /* an activity's own inline background (the totem's fade to black) still wins */
.act.lean::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse 75% 70% at 50% 50%,rgba(6,6,10,.18),rgba(6,6,10,.62) 100%);opacity:0;transition:opacity .45s .2s}
.act.lean.on::before{opacity:1}
.act.lean:not(.arrived) .stage,.act.lean.closing .stage{transform-origin:50% 50%;transform:scale(.22);opacity:0}
.act.lean .stage{transform-origin:50% 50%;transition:transform .5s cubic-bezier(.22,1,.36,1),opacity .28s} /* opens once the camera has arrived (.arrived, registry.js) */
.act.lean.arrived .stage{transform:none;opacity:1}
.act.lean .dock,.act.lean .top{opacity:0;transition:opacity .3s .3s}
.act.lean.arrived .dock,.act.lean.arrived .top{opacity:1}
.act.lean.closing .stage{transform:scale(.22);opacity:0;transition:transform .3s cubic-bezier(.4,0,1,1),opacity .24s .06s}
.act.lean.closing .dock,.act.lean.closing .top,.act.lean.closing::before{opacity:0;transition:opacity .18s}
.act .stage{position:relative;display:flex;align-items:center;justify-content:center;opacity:0;transform:scale(.97);transition:opacity .25s,transform .25s}
.act.on .stage{opacity:1;transform:none}
.act canvas.hi{image-rendering:auto}
.act canvas{display:block;image-rendering:pixelated;border-radius:6px;box-shadow:0 0 0 1px #263228,0 20px 60px rgba(0,0,0,.6)}
.act .top{position:fixed;top:14px;right:14px;display:flex;align-items:center;gap:12px;pointer-events:none;z-index:2}.embedded .act .top{top:18px}
.act .ttl,.act .sub{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap} /* visually hidden: screen readers still get the name */
.act .dock{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:10px;max-width:calc(100vw - 32px);z-index:7} /* above game cards (gx-layer z 5): you can always leave */
/* the leave button: the GG Coder app's own button (the computer's Stand up), same font, size and colours */
.act .x{all:unset;box-sizing:border-box;pointer-events:auto;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font:600 12px/1 ${FONT.app};letter-spacing:-0.005em;padding:3.4px 12px 4.6px;border-radius:8px;background:rgba(255,255,255,.25);color:rgba(255,255,255,.85);white-space:nowrap;-webkit-font-smoothing:antialiased;box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 1px 0 #0b0c0e,0 2px 4px -2px rgba(0,0,0,.6);transition:background-color .2s,color .2s}
.act .x:hover{background:rgba(255,255,255,.33);color:#fff;transition:background-color .12s,color .12s}.act .x:active{scale:.96}.act .x:focus-visible{outline:2px solid #8fa3ff;outline-offset:2px}
.act .help{position:static;display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:6px 6px;font:500 12px/1.3 ${FONT.app};-webkit-font-smoothing:antialiased;color:#c2c7ce;background:rgba(21,23,26,.72);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);padding:6px 12px;border-radius:10px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);width:max-content;max-width:calc(100vw - 32px);box-sizing:border-box;text-align:center}
.act .help kbd{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;margin:0 2px 0 8px;border-radius:6px;background:#2c3035;color:#e8ebef;font:600 11px/1.3 ${FONT.app};box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 1px 0 #0b0c0e,0 2px 4px -2px rgba(0,0,0,.6)}.act .help kbd:first-child{margin-left:0} /* the app's own key chips */
/* while a start/result card is up it lists the controls itself: the help line steps aside */
.act:has(.gx-layer) .help{opacity:0;pointer-events:none}
/* small windows: the help line keeps to one row (the start card already lists every control) */
@media (max-width:760px),(max-height:520px){.act .help{flex-wrap:nowrap;justify-content:flex-start;overflow:hidden;white-space:nowrap;max-width:calc(100vw - 24px);font-size:11px;padding:4px 10px;-webkit-mask-image:linear-gradient(90deg,#000 88%,transparent);mask-image:linear-gradient(90deg,#000 88%,transparent)}.act .help kbd{height:19px;min-width:19px;font-size:10px}}
body.in-act #ui{opacity:0;pointer-events:none;transition:opacity .2s}
@media (prefers-reduced-motion: reduce){.act,.act .stage,.act.lean .stage,.act.lean .dock,.act.lean::before{transition:none}.act.lean .stage{transform:none;opacity:1}.act.lean .dock,.act.lean .top{opacity:1}}
`;
let styled = false;
/** Inject the overlay/HUD-fade CSS (idempotent). Called by the registry at init so in-world activities (no overlay,
 *  e.g. films-b moment()) also fade the HUD via body.in-act. */
export function ensureStyle() { if (!styled) { const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); styled = true; } }

/**
 * @param {{ title: string, sub?: string, help?: string, leave?: string, lean?: boolean, _for?: { it: any, actId: string, seated: () => boolean } }} o
 * @returns {{ el: HTMLDivElement, stage: HTMLDivElement, canvas: (w:number,h:number,scale?:number)=>{c:HTMLCanvasElement,x:CanvasRenderingContext2D}, setHelp:(h:string)=>void, setSub:(s:string)=>void, close:()=>void, onClose:(f:()=>void)=>void }}
 */
export function overlay(o) {
  ensureStyle();
  setRenderScale(crispFit(480, 270, innerWidth - 32, innerHeight - TOP() - 80) * (devicePixelRatio || 1)); // until ov.canvas() knows the real size
  const el = document.createElement('div'); el.className = o.lean ? 'act lean' : 'act'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', o.title);
  el.innerHTML = `<div class="top"><div><div class="ttl"></div><div class="sub"></div></div></div><div class="stage"></div><div class="dock"><div class="help"></div><button class="x" type="button"></button></div>`;
  /** @type {HTMLDivElement} */ const stage = /** @type {any} */ (el.querySelector('.stage'));
  const ttl = /** @type {HTMLElement} */ (el.querySelector('.ttl')), sub = /** @type {HTMLElement} */ (el.querySelector('.sub')), help = /** @type {HTMLElement} */ (el.querySelector('.help'));
  const xb = /** @type {HTMLButtonElement} */ (el.querySelector('.x'));
  // the button's words: given, or the help line's own "esc <verb>" (hang up, log off, wake up...), or by what this is
  let verb = '';
  const label = () => { const v = o.leave || (verb && !/^(leave|close|quit|exit|back|stop)$/i.test(verb) ? cap1(verb) : '') || leaveLabel(o._for?.it, o._for?.actId || '', !!o._for?.seated()); if (xb.textContent !== v) xb.textContent = v; };
  const setHelp = h => { const t = takeEsc(h); if (t.verb) verb = t.verb; help.innerHTML = t.help; help.style.display = t.help ? '' : 'none'; label(); };
  ttl.textContent = o.title; sub.textContent = o.sub || ''; setHelp(o.help || '');
  requestAnimationFrame(label); // the activity may sit the player down right after opening
  document.body.appendChild(el); requestAnimationFrame(() => el.classList.add('on'));
  const closers = []; let closed = false;
  SFX.play('ui.open');
  const close = () => { if (closed) return; closed = true; SFX.play('ui.close'); el.classList.add('closing'); el.classList.remove('on'); for (const f of closers) try { f(); } catch (e) { console.warn(e); } setTimeout(() => el.remove(), 340); };
  xb.addEventListener('click', close);
  return {
    el, stage, close, onClose: f => closers.push(f),
    setHelp,
    setSub: s => { sub.textContent = s; },
    canvas(w, h, scale) {
      const c = document.createElement('canvas');
      // fit inside the free area (below the app's Back/window buttons, above the help bar), at a crisp whole-pixel scale
      const kOf = () => scale ? crispFit(w, h, w * scale, h * scale) : crispFit(w, h, innerWidth - 32, innerHeight - TOP() - bottomOf(help));
      const k0 = kOf(); const x = makeHi(c, w, h, k0 * (devicePixelRatio || 1)); // stored at screen resolution
      setRenderScale(k0 * (devicePixelRatio || 1)); // the game's cached layers (backdrops, sprites) made after this match it
      const fit = () => { el.style.padding = `${TOP()}px 0 ${bottomOf(help)}px`; el.style.boxSizing = 'border-box'; const k = kOf(); c.style.width = Math.round(w * k) + 'px'; c.style.height = Math.round(h * k) + 'px'; /** @type {any} */ (c).__rescale(k * (devicePixelRatio || 1)); };
      fit(); addEventListener('resize', fit); closers.push(() => removeEventListener('resize', fit));
      stage.appendChild(c); requestAnimationFrame(fit); return { c, x };
    },
  };
}
