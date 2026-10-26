// @ts-check
// Shared presentation helpers for the Paper Street / Inception / Tavern overlays, built on the art kit (art.js):
// themed surfaces (cardboard + duct tape, parchment), key chips, an offscreen cache for static backdrops, and a
// title-card -> play -> result-card flow (buttons drawn with button(), clickable, Enter/Space keyboard).
import { PAL, panel, button, title, glow, noise, shine, ease, clamp, particles, rr } from './art.js';
import { CFONT } from '../fonts.js';
import { SFX } from '../sfx.js';

/** Draw once onto an offscreen canvas; returns a blitter. */
export function cached(W, H, draw) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const cx = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d')); cx.imageSmoothingEnabled = false; draw(cx);
  return (/** @type {CanvasRenderingContext2D} */ x, X = 0, Y = 0) => x.drawImage(cv, X, Y);
}

/** a strip of grey duct tape */
export function tape(x, X, Y, w, a = 0, h = 10) {
  x.save(); x.translate(Math.round(X), Math.round(Y)); x.rotate(a);
  x.fillStyle = 'rgba(0,0,0,0.3)'; x.fillRect(-w / 2 + 1, -h / 2 + 2, w, h);
  const g = x.createLinearGradient(0, -h / 2, 0, h / 2); g.addColorStop(0, '#b8bcc0'); g.addColorStop(1, '#868a90'); x.fillStyle = g; x.fillRect(-w / 2, -h / 2, w, h);
  x.fillStyle = 'rgba(255,255,255,0.25)'; x.fillRect(-w / 2, -h / 2, w, 1); x.fillStyle = 'rgba(0,0,0,0.12)'; for (let i = -w / 2 + 3; i < w / 2; i += 4) x.fillRect(Math.round(i), -h / 2, 1, h);
  x.fillStyle = '#9a9ea4'; for (let k = -h / 2; k < h / 2; k += 2) { x.fillRect(-w / 2 - 1, k, 1, 1); x.fillRect(w / 2, k + 1, 1, 1); } // torn ends
  x.restore();
}
/** grimy kraft cardboard panel with corrugation and tape on the corners */
export function cardboard(x, X, Y, W, H, o = {}) {
  const p = panel(x, X, Y, W, H, { style: 'paper', r: 2 });
  x.save(); rr(x, p.x + 1, p.y + 1, p.w - 2, p.h - 2, 2); x.clip();
  x.globalCompositeOperation = 'multiply'; const g = x.createLinearGradient(0, Y, 0, Y + H); g.addColorStop(0, o.tint || '#d8a868'); g.addColorStop(1, '#a87a48'); x.fillStyle = g; x.fillRect(X, Y, W, H);
  x.globalCompositeOperation = 'source-over'; x.fillStyle = 'rgba(80,50,20,0.10)'; for (let i = X + 3; i < X + W; i += 5) x.fillRect(i, Y, 2, H);
  x.fillStyle = 'rgba(60,40,20,0.18)'; x.beginPath(); x.ellipse(X + W * 0.75, Y + H * 0.7, W * 0.12, H * 0.1, 0.4, 0, 7); x.fill(); // a stain
  noise(x, X, Y, W, H, 0.06, X * 3 + Y); x.restore();
  if (o.tape !== false) { tape(x, X + 8, Y + 4, 30, -0.6); tape(x, X + W - 8, Y + 4, 30, 0.6); if (H > 60) { tape(x, X + 8, Y + H - 4, 30, 0.6); tape(x, X + W - 8, Y + H - 4, 30, -0.6); } }
  return { ...p, text: '#2a1a0c' };
}
/** tavern parchment with burnt edges */
export function parchment(x, X, Y, W, H) {
  const p = panel(x, X, Y, W, H, { style: 'paper', r: 3 });
  x.save(); rr(x, p.x + 1, p.y + 1, p.w - 2, p.h - 2, 3); x.clip();
  const v = x.createRadialGradient(X + W / 2, Y + H / 2, Math.min(W, H) * 0.3, X + W / 2, Y + H / 2, Math.max(W, H) * 0.7); v.addColorStop(0, 'rgba(120,70,20,0)'); v.addColorStop(1, 'rgba(110,60,20,0.45)'); x.fillStyle = v; x.fillRect(X, Y, W, H);
  x.restore(); return p;
}
/** a keyboard key chip; returns its width */
export function keyChip(x, X, Y, label) {
  x.save(); x.font = CFONT.body(16); const w = Math.max(16, Math.ceil(x.measureText(label).width) + 10); X = Math.round(X); Y = Math.round(Y);
  x.fillStyle = '#1a141e'; rr(x, X, Y + 2, w, 16, 3); x.fill();
  const g = x.createLinearGradient(0, Y, 0, Y + 15); g.addColorStop(0, '#f6efe0'); g.addColorStop(1, '#c8bca6'); x.fillStyle = g; rr(x, X, Y, w, 15, 3); x.fill();
  x.strokeStyle = PAL.ink; x.lineWidth = 1; rr(x, X + 0.5, Y + 0.5, w - 1, 14, 3); x.stroke();
  x.fillStyle = PAL.ink; x.textAlign = 'center'; x.fillText(label, X + w / 2, Y + 12); x.restore(); return w;
}
/** a row of chips and words: ['←', '→', 'stir', '|', 'click', 'halves']: words in plain text, '|' a gap; chips are tokens wrapped in [] */
export function chipRow(x, cx, Y, items, color = PAL.cream) {
  x.save(); x.font = CFONT.body(16); let w = 0; const parts = items.map(s => { const chip = s.startsWith('['); const t = chip ? s.slice(1, -1) : s; const ww = chip ? Math.max(16, Math.ceil(x.measureText(t).width) + 10) : s === '|' ? 10 : Math.ceil(x.measureText(t).width); w += ww + 4; return { chip, t, ww }; });
  let X = Math.round(cx - w / 2); x.restore();
  for (const p of parts) { if (p.chip) keyChip(x, X, Y - 12, p.t); else if (p.t !== '|') title(x, p.t, X, Y, { size: 16, body: true, align: 'left', color }); X += p.ww + 4; }
}

/**
 * Title card -> play -> result card. Captures clicks on its own buttons and Enter/Space while a card is up (so the
 * game's handlers don't also fire). Game loop: `if (F.phase === 'play') update...; draw...; F.draw(x, dt)`.
 * @param {any} ov @param {HTMLCanvasElement} c @param {number} W @param {number} H
 * @param {{ start?: () => void, again?: () => void, style?: string, surface?: (x:any,X:number,Y:number,W:number,H:number)=>void, accent?: string }} o
 */
export function cardFlow(ov, c, W, H, o = {}) {
  const F = { phase: 'title', t: 0, mx: -1, my: -1, /** @type {any} */ card: null, /** @type {any} */ res: null, fx: particles(), btns: /** @type {{x:number,y:number,w:number,h:number,act:()=>void}[]} */ ([]) };
  const at = e => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H]; };
  const hit = (b, px, py) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
  const mv = e => { [F.mx, F.my] = at(e); if (F.phase !== 'play') c.style.cursor = F.btns.some(b => hit(b, F.mx, F.my)) ? 'pointer' : ''; };
  const dn = e => { if (F.phase === 'play' || e.button !== 0) return; e.stopImmediatePropagation(); e.preventDefault(); const [px, py] = at(e); const b = F.btns.find(b => hit(b, px, py)); if (b) b.act(); };
  const kd = e => { if (F.phase === 'play') return; if (e.code === 'Enter' || e.code === 'Space') { e.stopImmediatePropagation(); e.preventDefault(); F.btns[0]?.act(); } };
  c.addEventListener('pointermove', mv); c.addEventListener('pointerdown', dn, true); addEventListener('keydown', kd, true);
  ov.onClose(() => { c.removeEventListener('pointermove', mv); c.removeEventListener('pointerdown', dn, true); removeEventListener('keydown', kd, true); });
  const surf = (x, X, Y, w, h) => o.surface ? o.surface(x, X, Y, w, h) : panel(x, X, Y, w, h, { style: o.style || 'wood' });
  const btn = (x, X, Y, w, h, label, primary, act) => { const b = { x: X, y: Y, w, h, act }; const hot = hit(b, F.mx, F.my); button(x, X, Y, w, h, label, { primary, hot }); F.btns.push(b); };
  const api = {
    get phase() { return F.phase; }, get t() { return F.t; },
    /** @param {{title:string, sub?:string, lines?:string[], chips?:string[][]}} card */
    setCard(card) { F.card = card; },
    begin() { F.phase = 'play'; F.t = 0; c.style.cursor = ''; SFX.play('go'); o.start?.(); },
    /** @param {{title:string, sub?:string, color?:string, stats?:[string, number, string?, string?][], win?:boolean}} r stats: [label, value, color, suffix] */
    finish(r) { if (F.phase === 'result') return; F.phase = 'result'; F.t = 0; F.res = r; if (r.win) { F.fx.confetti(W); F.fx.burst(W / 2, H / 2 - 30, { n: 30 }); } },
    title() { F.phase = 'title'; F.t = 0; },
    draw(x, dt) {
      F.t += dt; F.btns = []; const k = ease.outBack(clamp(F.t / 0.4, 0, 1)), a = clamp(F.t / 0.2, 0, 1);
      if (F.phase === 'title' && F.card) {
        const C = F.card, lines = C.lines || [], chips = C.chips || [], bw = 300, bh = 96 + lines.length * 16 + chips.length * 20, X = (W - bw) / 2, Y = (H - bh) / 2;
        x.save(); x.globalAlpha = a * 0.5; x.fillStyle = '#000'; x.fillRect(0, 0, W, H); x.globalAlpha = a; x.translate(W / 2, H / 2); x.scale(k, k); x.translate(-W / 2, -H / 2);
        surf(x, X, Y, bw, bh); glow(x, W / 2, Y + 24, 110, o.accent || PAL.gold, 0.12 + Math.sin(F.t * 2) * 0.04);
        title(x, C.title, W / 2, Y + 34, { size: 32, color: o.accent || PAL.gold });
        if (C.sub) title(x, C.sub, W / 2, Y + 52, { size: 16, body: true, color: PAL.cream });
        let yy = Y + 72; for (const l of lines) { title(x, l, W / 2, yy, { size: 16, body: true, color: PAL.cream }); yy += 16; }
        yy += 4; for (const r of chips) { chipRow(x, W / 2, yy, r); yy += 20; }
        btn(x, W / 2 - 50, Y + bh - 34, 100, 24, 'START', true, () => api.begin()); shine(x, W / 2 - 50, Y + bh - 34, 100, 24, F.t);
        x.restore();
      } else if (F.phase === 'result' && F.res) {
        const R = F.res, st = R.stats || [], bw = 320, bh = 132, X = (W - bw) / 2, Y = (H - bh) / 2, col = R.color || PAL.gold;
        x.save(); x.globalAlpha = a * 0.55; x.fillStyle = '#000'; x.fillRect(0, 0, W, H); x.globalAlpha = a; x.translate(W / 2, H / 2); x.scale(k, k); x.translate(-W / 2, -H / 2);
        surf(x, X, Y, bw, bh); glow(x, W / 2, Y + 28, 140, col, 0.25);
        title(x, R.title, W / 2, Y + 38, { size: 32, color: col, glow: col, glowR: 10 });
        if (R.sub) title(x, R.sub, W / 2, Y + 56, { size: 16, body: true, color: PAL.cream });
        const cw = Math.min(90, (bw - 20) / Math.max(1, st.length)), sx = W / 2 - cw * st.length / 2, cu = ease.outCubic(clamp((F.t - 0.3) / 0.8, 0, 1));
        st.forEach(([lab, val, c2, suf], i) => { const bx = sx + i * cw + 3; panel(x, bx, Y + 62, cw - 6, 34, { style: 'glass', r: 3 });
          title(x, String(lab).toUpperCase(), bx + (cw - 6) / 2, Y + 75, { size: 16, body: true, color: PAL.dim });
          title(x, (Number.isInteger(val) ? Math.round(val * cu) : (val * cu).toFixed(1)) + (suf || ''), bx + (cw - 6) / 2, Y + 93, { size: 16, color: c2 || PAL.gold }); });
        btn(x, W / 2 - 104, Y + bh - 30, 100, 22, 'PLAY AGAIN', true, () => { SFX.play('ui.select'); F.phase = 'play'; F.t = 0; o.again?.(); });
        btn(x, W / 2 + 4, Y + bh - 30, 100, 22, 'LEAVE', false, () => ov.close());
        x.restore();
      }
      F.fx.draw(x, dt);
    },
  };
  return api;
}
