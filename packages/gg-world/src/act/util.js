// @ts-check
// Small shared helpers for activities: crisp pixel text on canvas, a wallet bridge, seeded RNG, simple input map.
import { SFX } from '../sfx.js';
import { CFONT } from '../fonts.js';
import { wallet } from '../creator.js';

/** Draw crisp pixel text. align: 'left'|'center'|'right'. size multiple of 16 for m5x7 (16, 32, 48). */
export function text(x, s, px, py, o = {}) {
  x.save(); x.font = CFONT.body(o.size || 16); x.textAlign = o.align || 'left'; x.textBaseline = 'alphabetic';
  if (o.shadow) { x.fillStyle = o.shadow; x.fillText(s, Math.round(px), Math.round(py) + 2); }
  x.fillStyle = o.color || '#d8dccf'; x.fillText(s, Math.round(px), Math.round(py)); x.restore();
}
/** Coins: read balance, spend (returns false if not enough). Same wallet as the wardrobe. */
export function coins(S) { const w = wallet(S); return { get balance() { return w.coins; }, spend: (n, what) => { const ok = w.spend(n, null); if (ok && n) SFX.play(n < 0 ? 'coin' : 'buy'); else if (!ok) SFX.play('ui.deny'); return ok; } }; }
export function rng(seed = 1) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
/** Key state for an activity (auto-removed on close). @param {{onClose:(f:()=>void)=>void}} ov */
export function keys(ov) { const k = new Set(); const d = e => { k.add(e.code); if (/Arrow|Space/.test(e.code)) e.preventDefault(); }, u = e => k.delete(e.code); addEventListener('keydown', d); addEventListener('keyup', u); ov.onClose(() => { removeEventListener('keydown', d); removeEventListener('keyup', u); }); return k; }
/** rAF loop that stops when the overlay closes. dt in seconds, clamped. */
export function loop(ov, f) { let on = true, last = performance.now(); const step = now => { if (!on) return; const dt = Math.min(0.05, (now - last) / 1000); last = now; f(dt, now / 1000); requestAnimationFrame(step); }; requestAnimationFrame(step); ov.onClose(() => { on = false; }); }

/**
 * Smooth scrolling for a list drawn on an overlay canvas (owner: "smooth scroll for anything that scrolls").
 * Wheel / trackpad deltas move a target offset in pixels (trackpads give many small deltas, mice give line steps);
 * the drawn offset eases toward it every frame, so both feel smooth. Also: drag the scrollbar thumb, and
 * ensureVisible(i) for keyboard selection. Coordinates are canvas pixels.
 * @param {HTMLCanvasElement} c @param {{ x: number, y: number, w: number, h: number, rowH: number, W: number, H: number }} box list area
 */
export function scroller(c, box) {
  const st = { off: 0, target: 0, count: 0, drag: -1 };
  const max = () => Math.max(0, st.count * box.rowH - box.h);
  const clamp = v => Math.max(0, Math.min(max(), v));
  const toCanvas = e => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * box.W, (e.clientY - r.top) / r.height * box.H]; };
  const thumb = () => { const h = Math.max(14, box.h * box.h / Math.max(box.h, st.count * box.rowH)); return { h, y: box.y + (max() ? st.off / max() : 0) * (box.h - h) }; };
  c.addEventListener('wheel', e => {
    e.preventDefault(); const r = c.getBoundingClientRect();
    // to canvas pixels: pixel deltas scale with the canvas' on-screen size; line / page deltas become rows
    const k = e.deltaMode === 1 ? box.rowH * 0.9 : e.deltaMode === 2 ? box.h : box.H / r.height;
    st.target = clamp(st.target + e.deltaY * k);
  }, { passive: false });
  c.addEventListener('pointerdown', e => { const [px, py] = toCanvas(e); if (max() && px >= box.x + box.w - 10 && px <= box.x + box.w + 6 && py >= box.y && py <= box.y + box.h) {
    const th = thumb(); st.drag = py >= th.y && py <= th.y + th.h ? py - th.y : th.h / 2; c.setPointerCapture(e.pointerId); st.target = clamp((py - st.drag - box.y) / (box.h - th.h) * max()); e.stopImmediatePropagation(); } }, true);
  c.addEventListener('pointermove', e => { if (st.drag < 0) return; const [, py] = toCanvas(e), th = thumb(); st.target = st.off = clamp((py - st.drag - box.y) / (box.h - th.h) * max()); });
  c.addEventListener('pointerup', () => { st.drag = -1; });
  return {
    get off() { return st.off; },
    /** list length (call when it changes) */ setCount(n) { st.count = n; st.target = clamp(st.target); st.off = clamp(st.off); },
    /** keep row i in view (keyboard) */ ensureVisible(i) { const top = i * box.rowH, bot = top + box.rowH; if (top < st.target) st.target = top; else if (bot > st.target + box.h) st.target = bot - box.h; st.target = clamp(st.target); },
    /** row under a canvas y, or -1 */ rowAt(py) { if (py < box.y || py >= box.y + box.h) return -1; return Math.floor((py - box.y + st.off) / box.rowH); },
    /** ease (call once per frame) */ update(dt) { const d = st.target - st.off; st.off = Math.abs(d) < 0.3 ? st.target : st.off + d * (1 - Math.exp(-dt / 0.07)); },
    /** draw the scrollbar (only when the list overflows) */ drawBar(x, track = '#3a3248', fill = '#a89cb8') { if (!max()) return; const th = thumb(); x.fillStyle = track; x.fillRect(box.x + box.w - 6, box.y, 4, box.h); x.fillStyle = fill; x.fillRect(box.x + box.w - 6, Math.round(th.y), 4, Math.round(th.h)); },
    /** clip drawing to the list area */ clip(x, f) { x.save(); x.beginPath(); x.rect(box.x, box.y, box.w, box.h); x.clip(); f(); x.restore(); },
  };
}

/**
 * Mouse for keyboard-driven overlay screens (owner: "mouse must always be usable"). Declare clickable areas in canvas
 * pixels each frame (or once); hovering highlights through onHover, clicking calls onPick. Cursor turns to a hand
 * over an area. For lists: mouse.rows(i => ({ x, y, w, h }), count, { hover: i => sel = i, pick: i => choose(i) }).
 * @param {any} ov overlay @param {HTMLCanvasElement} c @param {number} W @param {number} H
 */
export function mouse(ov, c, W, H) {
  /** @type {{ x: number, y: number, w: number, h: number, hover?: () => void, pick?: () => void }[]} */
  let areas = [];
  const at = e => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H]; };
  const find = (px, py) => areas.find(a => px >= a.x && px <= a.x + a.w && py >= a.y && py <= a.y + a.h);
  let last = null;
  const move = e => { const a = find(...at(e)); c.style.cursor = a ? 'pointer' : ''; if (a && a !== last) a.hover?.(); last = a || null; };
  const down = e => { if (e.button !== 0) return; const a = find(...at(e)); if (a?.pick) { e.preventDefault(); a.hover?.(); a.pick(); } };
  c.addEventListener('pointermove', move); c.addEventListener('pointerdown', down);
  ov.onClose?.(() => { c.removeEventListener('pointermove', move); c.removeEventListener('pointerdown', down); });
  return {
    /** replace all areas */ set(list) { areas = list; },
    /** a list: rect(i) gives each row's box */ rows(rect, n, o) { areas = Array.from({ length: n }, (_, i) => ({ ...rect(i), hover: () => o.hover?.(i), pick: () => o.pick?.(i) })); },
    /** add one area (buttons) */ add(a) { areas.push(a); },
    clear() { areas = []; },
  };
}
