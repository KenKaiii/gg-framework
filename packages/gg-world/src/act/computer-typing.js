// @ts-check
// Typing race: 30 seconds of dev/AI words, WPM + accuracy, best WPM saved. A ghost bar races your best.
import { SFX } from '../sfx.js';
import { loop, text, mouse } from './util.js';
import { PAL, bg, panel, title, glow, badge, banner, particles, shaker, rr } from './art.js';
import { howTo, btns } from './hackers-util.js';
import { best, saveBest, seat, closeUp, win, today } from './computer-util.js';

const WORDS = 'prompt context agent diff commit deploy refactor token model tests review branch merge rebase lint build cache async await promise schema vector embed latency stack trace bug patch rollback env secret config hotfix sprint ship vibe pipeline docker kernel npm yarn json regex lambda'.split(' ');

/** @param {any} ctx */
export function startTyping(ctx) {
  const stand = seat(ctx);
  const ov = ctx.overlay({ title: 'TYPE RACER 3000', sub: '30 seconds · dev words', help: '<kbd>type</kbd> the words <kbd>space</kbd> next word <kbd>enter</kbd>/<kbd>click</kbd> restart <kbd>esc</kbd> leave' });
  ov.onClose(stand); { const sl = ctx.it?.slot; closeUp(ctx, ov, sl ? sl.x : 3, 1.0, sl ? sl.z - 0.9 : 1.8); }
  const W = 480, H = 270; const { x, c } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  let s = today().seed; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  let g; const reset = () => { g = { list: Array.from({ length: 80 }, () => WORDS[Math.floor(r() * WORDS.length)]), i: 0, buf: '', ok: 0, bad: 0, chars: 0, t: -1, end: false, pop: 0, rec: false, shake: 0 }; };
  reset();
  const back = document.createElement('canvas'); back.width = 480; back.height = 270; bg.vignette(/** @type {CanvasRenderingContext2D} */ (back.getContext('2d')), 480, 270, '#1e2240');
  const fx = particles(), sh = shaker(), B2 = btns(c, 480, 270); let endT = 0, wpmShown = 0;
  const DUR = 30, BEST = () => best('wpm');
  const onKey = e => {
    if (e.code === 'Enter') { reset(); SFX.play('ui.click'); return; } if (g.end) return;
    if (e.key === ' ') { e.preventDefault(); if (!g.buf) return; if (g.buf === g.list[g.i]) { g.ok++; g.chars += g.buf.length + 1; g.pop = 0.4; fx.sparkle(60, 120, '#6ee7a0'); SFX.play('tick', { vol: 0.6 }); } else { g.bad++; g.shake = 0.3; sh.kick(3); SFX.play('ui.deny', { vol: 0.5 }); } g.i++; g.buf = ''; return; }
    if (e.key === 'Backspace') { g.buf = g.buf.slice(0, -1); SFX.play('key', { vol: 0.4, pitch: 0.8 }); return; }
    if (e.key.length === 1 && /[a-z]/i.test(e.key)) { if (g.t < 0) { g.t = 0; SFX.play('go', { vol: 0.6 }); } g.buf += e.key.toLowerCase(); SFX.play('key', { vol: 0.5, jitter: 0.1 }); }
  };
  const cap = e => { if (e.code !== 'Escape') { e.stopPropagation(); onKey(e); } };
  addEventListener('keydown', cap, true); ov.onClose(() => removeEventListener('keydown', cap, true));
  // mouse: typing needs the keyboard; once the race ends, clicking the result card races again
  const M = mouse(ov, c, W, H);
  loop(ov, (dt, t) => { if (g.end) M.set([{ x: W / 2 - 50, y: 176, w: 100, h: 20, pick: () => { reset(); SFX.play('ui.click'); } }]); else M.clear();
    if (g.t >= 0 && !g.end) { g.t += dt; if (g.t >= DUR) { g.end = true; const w = Math.round(g.chars / 5 / (DUR / 60)); g.wpm = w; g.rec = w > 0 && saveBest('wpm', w); endT = 0; wpmShown = 0; if (g.rec) fx.confetti(W); SFX.play('typewriter.ding'); SFX.play(g.rec ? 'win' : 'score', { delay: 0.3 }); }
      else if (g.t > DUR - 5 && Math.floor(g.t) !== Math.floor(g.t - dt)) SFX.play('countdown', { vol: 0.5 }); }
    g.pop = Math.max(0, g.pop - dt); g.shake = Math.max(0, g.shake - dt);
    x.save(); sh.apply(x, dt); x.drawImage(back, 0, 0);
    win(x, 20, 10, W - 40, H - 20, 'TYPE RACER 3000');
    x.fillStyle = '#e8e4d8'; x.fillRect(26, 30, W - 52, H - 46);
    const wpm = g.t > 0.5 ? Math.round(g.chars / 5 / (g.t / 60)) : 0, left = Math.max(0, DUR - Math.max(0, g.t));
    badge(x, 32, 36, 'time', left.toFixed(1), { w: 70, color: left < 5 && g.t >= 0 ? PAL.red : PAL.gold, style: 'metal' });
    badge(x, 106, 36, 'wpm', wpm, { w: 62, color: PAL.green, style: 'metal' });
    badge(x, 172, 36, 'ok', g.ok, { w: 52, color: PAL.cyan, style: 'metal' }); badge(x, 228, 36, 'typos', g.bad, { w: 62, color: PAL.red, style: 'metal' });
    badge(x, W - 106, 36, 'best', BEST() + ' wpm', { w: 74, color: PAL.goldHi, style: 'metal' });
    // race track: you vs ghost of your best
    const tx = 42, tw = W - 120;
    for (const [lab, y, frac, col] of [['YOU', 80, Math.min(1, g.t < 0 ? 0 : g.chars / 5 / Math.max(1, BEST() || 40) / (DUR / 60)), '#3ddc84'], ['BEST', 96, Math.min(1, Math.max(0, g.t) / DUR), '#b04fd8']]) {
      const Y = +y, F = +frac, C = String(col);
      x.fillStyle = '#3a3a48'; rr(x, tx, Y, tw, 8, 4); x.fill(); x.fillStyle = 'rgba(255,255,255,0.15)'; for (let d = tx + 6; d < tx + tw; d += 12) x.fillRect(d, Y + 4, 6, 1);
      x.fillStyle = C; x.globalAlpha = 0.35; rr(x, tx, Y, Math.max(8, F * tw), 8, 4); x.fill(); x.globalAlpha = 1;
      const cx = tx + F * (tw - 14); glow(x, cx + 7, Y + 4, 14, C, 0.5); x.fillStyle = C; rr(x, cx, Y - 3, 14, 14, 4); x.fill(); x.fillStyle = 'rgba(255,255,255,0.6)'; x.fillRect(cx + 3, Y - 2, 8, 1);
      x.fillStyle = '#000'; x.fillRect(tx + tw - 2, Y - 3, 2, 14);
      title(x, String(lab), tx + tw + 10, Y + 9, { size: 16, body: true, align: 'left', color: C }); }
    // words on a CRT
    const cp = panel(x, 36, 112, W - 72, 66, { style: 'crt' });
    let px = 48, py = 132, ox = g.shake > 0 ? Math.sin(t * 80) * 3 : 0;
    for (let k = g.i; k < g.i + 14 && py < 176; k++) { const w = g.list[k]; x.font = '16px m5x7'; const ww = x.measureText(w + ' ').width;
      if (px + ww > W - 48) { px = 48; py += 20; if (py >= 176) break; }
      const cur = k === g.i, typed = cur && !w.startsWith(g.buf);
      if (cur) { x.fillStyle = typed ? 'rgba(255,90,90,0.25)' : 'rgba(255,207,138,0.18)'; rr(x, px - 3 + ox, py - 12, ww - 2, 16, 3); x.fill();
        const n = typed ? 0 : g.buf.length; title(x, w.slice(0, n), px + ox, py, { size: 16, body: true, align: 'left', color: '#ffffff', ink: '#020a04' }); x.font = '16px m5x7';
        title(x, w.slice(n), px + ox + x.measureText(w.slice(0, n)).width, py, { size: 16, body: true, align: 'left', color: typed ? '#ff8080' : '#ffcf8a', ink: '#020a04' }); }
      else title(x, w, px, py, { size: 16, body: true, align: 'left', color: '#6ee7a0', ink: '#020a04' });
      px += ww; } void cp;
    // input line
    x.fillStyle = '#fff'; rr(x, 36, 186, W - 72, 22, 3); x.fill(); x.strokeStyle = '#808080'; rr(x, 36.5, 186.5, W - 73, 21, 3); x.stroke(); x.fillStyle = '#c0c0c0'; x.fillRect(38, 188, W - 76, 1);
    x.font = '16px m5x7'; x.fillStyle = '#1a2a8a'; x.textAlign = 'left'; x.fillText('> ' + g.buf, 44, 202); if ((t % 1.6) < 0.8) { x.fillStyle = '#1a2a8a'; x.fillRect(44 + x.measureText('> ' + g.buf).width + 1, 191, 6, 12); }
    if (g.pop > 0) title(x, '+1', 60 + (0.4 - g.pop) * 60, 128 - (0.4 - g.pop) * 20, { size: 16, color: PAL.green });
    howTo(x, W, 232, [['a-z', 'type the word'], ['space', 'next'], ['enter', 'restart']], { dark: '#2a2a3a' });
    fx.draw(x, dt); x.restore();
    if (g.end) { endT += dt; wpmShown += (g.wpm - wpmShown) * Math.min(1, dt * 6);
      x.fillStyle = `rgba(0,0,0,${Math.min(0.55, endT)})`; x.fillRect(0, 0, W, H);
      const rp = panel(x, W / 2 - 110, 70, 220, 132, { style: 'crt' });
      title(x, g.rec ? 'NEW BEST!' : 'TIME!', W / 2, rp.y + 22, { size: 16, color: g.rec ? PAL.gold : PAL.cream, glow: g.rec ? PAL.gold : undefined });
      title(x, Math.round(wpmShown) + ' WPM', W / 2, rp.y + 64, { size: 32, color: g.rec ? PAL.goldHi : '#6ee7a0', glow: '#3aff8a', glowR: 10 });
      title(x, 'ok ' + g.ok + '   typos ' + g.bad + '   best ' + BEST(), W / 2, rp.y + 86, { size: 16, body: true, color: PAL.cream, ink: '#020a04' });
      B2.draw(x, W / 2 - 50, 176, 100, 20, 'RACE AGAIN', { primary: true });
      if (endT < 1.4) banner(x, W, H, g.rec ? 'NEW BEST' : g.wpm + ' WPM', g.rec ? g.wpm + ' wpm' : 'enter or click to race again', endT, { color: g.rec ? PAL.gold : PAL.green }); }
  });
}
