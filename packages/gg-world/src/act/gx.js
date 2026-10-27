// @ts-check
// GX: the mini-game kit (owner: "everything needs a redesign... clean, properly done versions, not this pixelated
// nonsense"). Every game is the real object, close up, drawn at screen resolution (SVG / DOM / hi-DPI canvas), lit by
// its room, and wrapped in GG Coder's own UI: Sora, the app's keys, plates, cards and buttons. No pixel fonts, no pixel
// panels, no small canvases stretched up. Concepts the owner approved: goals/gaming/showcase/minigames/ (index.html).
//
//   const K = gx(ov);                                  // ov = ctx.overlay({...})
//   const scene = K.scene({ aspect: 16 / 9 });         // the object's box: fits between the HUD and the dock
//   const hud = K.hud([{ id: 'score', label: 'Score' }, { id: 'best', label: 'Best', tone: 'gold' }], [{ id: 'turn', label: 'Turn' }]);
//   hud.set('score', 120, { count: true });
//   K.card({ title: 'Darts', text: 'Three darts a round.', how: [[['Mouse'], 'aim'], [['Click', 'Space'], 'throw']], cta: 'Throw', onGo });
//   K.result({ title: 'Round over', big: 87, line: 'Solid round.', stats: [[best, 'Best round']], again: 'Throw again', onAgain });
//   K.pop(x, y, '+60', 'gold'); K.swell();           // feedback: a floating number, the room light swells
//   const s = K.svg('svg', { viewBox: '0 0 100 100' }, scene); // SVG helper
import { FONT } from '../fonts.js';
import { TOP, bottomOf } from './overlay.js';
import { SFX } from '../sfx.js';

const NS = 'http://www.w3.org/2000/svg';
let styled = false;

/** App tokens (gg-app/src/App.css, dark theme) and the world's light. */
export const GX = {
  bg: '#15171a', s1: '#1f2226', s2: '#2a2e33', s3: '#33383e', text: '#e8ebef', text2: '#c2c7ce', muted: '#a1a8b1',
  primary: '#8fa3ff', primaryHi: '#a9b8ff', onPrimary: '#050a2e', success: '#7fdc95', warning: '#f0c75e', error: '#ff7d70',
  key: '#2c3035', lamp: '#ffd29a', lampDeep: '#f2a35a', pink: '#ff5fd2', teal: '#44e3cf', violet: '#9b7bff',
};
const TONE = { gold: GX.warning, up: GX.success, bad: GX.error, cool: GX.primary, teal: GX.teal, pink: GX.pink };

function ensureStyle() {
  if (styled) return; styled = true;
  const st = document.createElement('style'); st.id = 'gx-style';
  st.textContent = `
.gx-scene{position:absolute;container-type:size;font-family:${FONT.app};color:${GX.text};-webkit-font-smoothing:antialiased;user-select:none}
.gx-scene svg{display:block}
.gx-lamp{position:absolute;inset:-25% -15%;pointer-events:none;mix-blend-mode:screen;background:radial-gradient(ellipse 46% 52% at 50% 36%,rgba(255,210,154,.26),rgba(255,190,120,.07) 48%,transparent 72%);transition:filter .6s}
.gx-lamp.swell{animation:gx-swell 1.2s cubic-bezier(.22,1,.36,1)}
@keyframes gx-swell{30%{filter:brightness(1.9)}}
.gx-hud{position:fixed;left:22px;right:22px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;z-index:3;pointer-events:none;font-family:${FONT.app};-webkit-font-smoothing:antialiased}
.gx-hud .grp{flex-wrap:wrap}
@media (max-width:760px),(max-height:520px){.gx-hud .gx-plate{min-width:0;padding:5px 9px 6px;border-radius:9px}.gx-hud .gx-plate .l{font-size:9.5px}.gx-hud .gx-plate .v{font-size:15px;margin-top:0}.gx-hud{left:12px;right:12px;gap:8px}.gx-hud .grp{gap:6px}}
@media (max-width:620px){.gx-hud .grp:last-child{justify-content:flex-end}}
.gx-hud .grp{display:flex;gap:10px}
.gx-plate{min-width:104px;padding:9px 14px 11px;border-radius:12px;background:rgba(21,23,26,.74);-webkit-backdrop-filter:blur(12px) saturate(1.2);backdrop-filter:blur(12px) saturate(1.2);box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 0 0 1px rgba(255,255,255,.07),0 10px 24px -12px rgba(0,0,0,.8);color:${GX.text}}
.gx-plate .l{display:block;font-size:11px;line-height:1.3;font-weight:600;color:${GX.muted}}
.gx-plate .v{display:block;margin-top:2px;font-size:24px;line-height:1.1;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.gx-layer{position:fixed;inset:0;z-index:5;display:grid;place-items:center;padding:var(--gx-top,60px) 16px 64px;box-sizing:border-box;overflow:auto;background:rgba(8,7,14,.34);animation:gx-fade .28s cubic-bezier(.22,1,.36,1);font-family:${FONT.app};-webkit-font-smoothing:antialiased}
.gx-card{width:min(420px,calc(100vw - 40px));max-height:100%;overflow:auto;padding:26px 26px 22px;border-radius:18px;background:${GX.s1};color:${GX.text};text-align:center;box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 0 0 1px rgba(255,255,255,.07),0 16px 44px -12px rgba(0,0,0,.7);animation:gx-pop .36s cubic-bezier(.3,1.6,.6,1)}
.gx-card .k{margin:0 0 6px;font-size:11px;line-height:1.3;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${GX.muted}}
.gx-card h2{margin:0;font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-.02em}
.gx-card p{margin:8px 0 0;font-size:13px;line-height:1.5;color:${GX.text2}}
.gx-card .how{display:flex;flex-wrap:wrap;justify-content:center;gap:8px 16px;margin:16px 0 0;font-size:12px;line-height:1.3;color:${GX.text2}}
.gx-card .how span{display:inline-flex;align-items:center;gap:6px}
.gx-card .big{margin:14px 0 0;font-size:56px;line-height:1;font-weight:800;letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.gx-card .stats{display:flex;justify-content:center;flex-wrap:wrap;gap:10px;margin:16px 0 0}
.gx-card .stat{min-width:96px;padding:8px 12px 10px;border-radius:10px;background:${GX.s2};color:${GX.text}}
.gx-card .stat b{display:block;font-size:18px;line-height:1.2;font-weight:700;font-variant-numeric:tabular-nums}
.gx-card .stat small{display:block;margin-top:2px;font-size:11px;line-height:1.3;color:${GX.muted}}
.gx-card .acts{display:flex;justify-content:center;gap:10px;margin:20px 0 0}
.gx-card .best{color:${GX.warning};font-weight:700}
.gx-key{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;border-radius:6px;background:${GX.key};color:${GX.text};font:600 11px/1.3 ${FONT.app};box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 1px 0 #0b0c0e,0 2px 4px -2px rgba(0,0,0,.6)}
.gx-btn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:8px;padding:9px 18px 10px;font:600 13px/1.25 ${FONT.app};letter-spacing:-.005em;cursor:pointer;white-space:nowrap;background:${GX.key};color:${GX.text};box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 1px 0 #0b0c0e,0 2px 4px -2px rgba(0,0,0,.6);transition:background-color .24s,color .24s}
.gx-btn:hover{background:${GX.s3};transition:background-color .12s}
.gx-btn:active{scale:.96}
.gx-btn.pri{background:${GX.primary};color:${GX.onPrimary}}
.gx-btn.pri:hover{background:${GX.primaryHi}}
.gx-btn.lg{padding:12px 24px 13px;font-size:15px}
.gx-btn:focus-visible{outline:2px solid ${GX.primary};outline-offset:2px}
.gx-pop{position:fixed;z-index:6;pointer-events:none;transform:translate(-50%,-50%);font:800 20px/1.2 ${FONT.app};letter-spacing:-.01em;color:#fff;white-space:nowrap;text-shadow:0 2px 10px rgba(0,0,0,.6);animation:gx-popup .95s cubic-bezier(.22,1,.36,1) forwards}
@media (max-height:520px){.gx-card{padding:16px 18px 14px}.gx-card h2{font-size:19px}.gx-card .big{font-size:40px;margin-top:8px}.gx-card .how{margin-top:10px}.gx-card .acts{margin-top:12px}.gx-card p{margin-top:4px}}
@keyframes gx-fade{from{opacity:0}}
@keyframes gx-pop{from{opacity:0;transform:translateY(10px) scale(.96)}}
@keyframes gx-popup{0%{opacity:0;transform:translate(-50%,-30%) scale(.8)}18%{opacity:1;transform:translate(-50%,-60%) scale(1.06)}100%{opacity:0;transform:translate(-50%,-150%) scale(1)}}
@media (prefers-reduced-motion: reduce){.gx-layer,.gx-card,.gx-pop,.gx-lamp.swell{animation:none}.gx-pop{opacity:0}}
`;
  document.head.appendChild(st);
}

/** HTML for key chips: keys('Space') or keys(['1','2','3']). @param {string|string[]} k */
export const keys = k => (Array.isArray(k) ? k : [k]).map(s => `<span class="gx-key">${esc(s)}</span>`).join(' ');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] || c);

/** SVG element helper. @param {string} tag @param {Record<string, any>} [attrs] @param {Element} [parent] */
export function svg(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(e);
  return /** @type {any} */ (e);
}

/** Count a number up in an element. @param {HTMLElement} el @param {number} to @param {number} [ms] */
export function countUp(el, to, ms = 650) {
  const from = Number(el.dataset.v || 0); el.dataset.v = String(to);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || from === to) { el.textContent = to.toLocaleString(); return; }
  const t0 = performance.now();
  const step = now => { const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3); el.textContent = Math.round(from + (to - from) * e).toLocaleString(); if (k < 1 && el.isConnected) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

/**
 * The kit, bound to an overlay. @param {any} ov ctx.overlay(...)
 */
export function gx(ov) {
  ensureStyle();
  const help = /** @type {HTMLElement} */ (ov.el.querySelector('.help'));
  let hudEl = /** @type {HTMLElement | null} */ (null), lamp = /** @type {HTMLElement | null} */ (null);
  const hudH = () => (hudEl ? hudEl.offsetHeight + 12 : 0);

  /** The object's box, fitted to the free area (keeps its aspect). @param {{ aspect?: number, maxW?: number, lamp?: boolean, pad?: number }} [o] */
  function scene(o = {}) {
    const aspect = o.aspect ?? 16 / 9, pad = o.pad ?? 20;
    const el = document.createElement('div'); el.className = 'gx-scene';
    if (o.lamp !== false) { lamp = document.createElement('div'); lamp.className = 'gx-lamp'; el.appendChild(lamp); }
    ov.stage.style.position = 'fixed'; ov.stage.style.inset = '0'; ov.stage.style.display = 'block';
    ov.stage.appendChild(el);
    const fit = () => {
      const top = TOP() + hudH() + 4, bot = bottomOf(help) + 4, availW = innerWidth - pad * 2, availH = innerHeight - top - bot;
      let w = Math.min(availW, o.maxW ?? 1400), h = w / aspect; if (h > availH) { h = availH; w = h * aspect; }
      Object.assign(el.style, { width: Math.round(w) + 'px', height: Math.round(h) + 'px', left: Math.round((innerWidth - w) / 2) + 'px', top: Math.round(top + (availH - h) / 2) + 'px' });
    };
    fit(); requestAnimationFrame(fit); addEventListener('resize', fit); ov.onClose(() => removeEventListener('resize', fit));
    /** @type {any} */ (el).fit = fit;
    return el;
  }

  /**
   * Score plates along the top. @param {{id:string,label:string,value?:any,tone?:string}[]} left @param {{id:string,label:string,value?:any,tone?:string}[]} [right]
   */
  function hud(left, right = []) {
    hudEl = document.createElement('div'); hudEl.className = 'gx-hud'; hudEl.style.top = TOP() + 'px';
    const vals = /** @type {Record<string, HTMLElement>} */ ({});
    const grp = items => { const g = document.createElement('div'); g.className = 'grp';
      for (const it of items) { const p = document.createElement('div'); p.className = 'gx-plate'; p.innerHTML = `<span class="l">${esc(it.label)}</span><span class="v"></span>`;
        const v = /** @type {HTMLElement} */ (p.querySelector('.v')); v.textContent = it.value == null ? '0' : String(it.value); v.dataset.v = String(Number(it.value) || 0); if (it.tone) v.style.color = TONE[it.tone] || it.tone; vals[it.id] = v; g.appendChild(p); }
      return g; };
    hudEl.append(grp(left), grp(right)); ov.el.appendChild(hudEl);
    return {
      el: hudEl,
      /** @param {string} id @param {any} v @param {{count?: boolean, tone?: string}} [o] */
      set(id, v, o = {}) { const e = vals[id]; if (!e) return; if (o.tone) e.style.color = TONE[o.tone] || o.tone; if (o.count && typeof v === 'number') countUp(e, v); else { e.textContent = String(v); e.dataset.v = String(Number(v) || 0); } },
      /** @param {string} id */ node: id => vals[id],
    };
  }

  /** A card over the game (start / result / anything). Returns { el, close }. */
  function layer(inner, onOpen) {
    const L = document.createElement('div'); L.className = 'gx-layer'; L.style.setProperty('--gx-top', TOP() + 'px'); /* keep clear of the app's Back + window buttons */ L.innerHTML = `<div class="gx-card" role="dialog" aria-modal="true">${inner}</div>`;
    ov.el.appendChild(L); onOpen?.(L);
    const first = /** @type {HTMLElement | null} */ (L.querySelector('.gx-btn.pri'));
    requestAnimationFrame(() => first?.focus({ preventScroll: true }));
    return { el: L, close: () => L.remove() };
  }
  /**
   * Start card. @param {{ title: string, kicker?: string, text?: string, how?: [string|string[], string][], cta?: string, onGo: () => void }} o
   */
  function card(o) {
    const how = (o.how || []).map(([k, l]) => `<span>${keys(k)} ${esc(l)}</span>`).join('');
    const c = layer(`${o.kicker ? `<p class="k">${esc(o.kicker)}</p>` : ''}<h2>${esc(o.title)}</h2>${o.text ? `<p>${esc(o.text)}</p>` : ''}${how ? `<div class="how">${how}</div>` : ''}<div class="acts"><button class="gx-btn pri lg" type="button">${esc(o.cta || 'Play')}</button></div>`);
    const go = () => { c.close(); removeEventListener('keydown', onKey, true); SFX.play('ui.select'); o.onGo(); };
    const onKey = e => { if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); e.stopPropagation(); go(); } };
    addEventListener('keydown', onKey, true); ov.onClose(() => removeEventListener('keydown', onKey, true));
    c.el.querySelector('.gx-btn.pri')?.addEventListener('click', go);
    return c;
  }
  /**
   * Result card. @param {{ title: string, big?: number|string, line?: string, best?: boolean, stats?: [any, string][], again?: string, onAgain: () => void, leave?: string }} o
   */
  function result(o) {
    const stats = (o.stats || []).map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><small>${esc(l)}</small></div>`).join('');
    const leave = o.leave || ov.el.querySelector('.x')?.textContent || 'Step back';
    const c = layer(`<h2>${esc(o.title)}</h2>${o.big != null ? `<div class="big"></div>` : ''}${o.best ? `<p class="best">New best</p>` : o.line ? `<p>${esc(o.line)}</p>` : ''}${stats ? `<div class="stats">${stats}</div>` : ''}<div class="acts"><button class="gx-btn pri" type="button">${esc(o.again || 'Play again')}</button><button class="gx-btn leave" type="button">${esc(leave)}</button></div>`);
    const big = /** @type {HTMLElement | null} */ (c.el.querySelector('.big')); if (big) { if (typeof o.big === 'number') { big.dataset.v = '0'; countUp(big, o.big, 900); } else big.textContent = String(o.big); }
    const again = () => { c.close(); removeEventListener('keydown', onKey, true); SFX.play('ui.select'); o.onAgain(); };
    const onKey = e => { if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); e.stopPropagation(); again(); } };
    addEventListener('keydown', onKey, true); ov.onClose(() => removeEventListener('keydown', onKey, true));
    c.el.querySelector('.gx-btn.pri')?.addEventListener('click', again);
    c.el.querySelector('.gx-btn.leave')?.addEventListener('click', () => ov.close());
    if (o.best) SFX.play('win', { vol: 0.6 });
    return c;
  }

  /** Floating number / word at a screen point. @param {number} x @param {number} y @param {string} text @param {string} [tone] */
  function pop(x, y, text, tone) {
    const p = document.createElement('div'); p.className = 'gx-pop'; p.textContent = text; p.style.left = x + 'px'; p.style.top = y + 'px';
    if (tone) p.style.color = TONE[tone] || tone; ov.el.appendChild(p); setTimeout(() => p.remove(), 1000);
  }
  /** The room light swells (a big hit, a win). */
  function swell() { if (!lamp) return; lamp.classList.remove('swell'); void lamp.offsetWidth; lamp.classList.add('swell'); }

  return { scene, hud, card, result, pop, swell, svg, keys, countUp };
}
