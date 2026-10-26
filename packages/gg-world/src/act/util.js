// @ts-check
// Small shared helpers for activities: crisp pixel text on canvas, a wallet bridge, seeded RNG, simple input map.
import { SFX } from '../sfx.js';
import { CFONT } from '../fonts.js';
import { wallet } from '../creator.js';

/** Draw crisp pixel text. align: 'left'|'center'|'right'. size multiple of 16 for m5x7 (16, 32, 48). */
export function text(x, s, px, py, o = {}) {
  x.save(); x.font = o.title ? CFONT.title(o.size || 16) : CFONT.body(o.size || 16); x.textAlign = o.align || 'left'; x.textBaseline = 'alphabetic';
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
