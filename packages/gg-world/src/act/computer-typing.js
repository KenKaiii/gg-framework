// @ts-check
// Typing race: 30 seconds of dev/AI words, WPM + accuracy, best WPM saved. A ghost bar races your best.
import { SFX } from '../sfx.js';
import { loop, text, mouse } from './util.js';
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
  const DUR = 30, BEST = () => best('wpm');
  const onKey = e => {
    if (e.code === 'Enter') { reset(); SFX.play('ui.click'); return; } if (g.end) return;
    if (e.key === ' ') { e.preventDefault(); if (!g.buf) return; if (g.buf === g.list[g.i]) { g.ok++; g.chars += g.buf.length + 1; g.pop = 0.4; SFX.play('tick', { vol: 0.6 }); } else { g.bad++; g.shake = 0.3; SFX.play('ui.deny', { vol: 0.5 }); } g.i++; g.buf = ''; return; }
    if (e.key === 'Backspace') { g.buf = g.buf.slice(0, -1); SFX.play('key', { vol: 0.4, pitch: 0.8 }); return; }
    if (e.key.length === 1 && /[a-z]/i.test(e.key)) { if (g.t < 0) { g.t = 0; SFX.play('go', { vol: 0.6 }); } g.buf += e.key.toLowerCase(); SFX.play('key', { vol: 0.5, jitter: 0.1 }); }
  };
  const cap = e => { if (e.code !== 'Escape') { e.stopPropagation(); onKey(e); } };
  addEventListener('keydown', cap, true); ov.onClose(() => removeEventListener('keydown', cap, true));
  // mouse: typing needs the keyboard; once the race ends, clicking the result card races again
  const M = mouse(ov, c, W, H);
  loop(ov, (dt, t) => { if (g.end) M.set([{ x: 100, y: 80, w: 280, h: 110, pick: () => { reset(); SFX.play('ui.click'); } }]); else M.clear();
    if (g.t >= 0 && !g.end) { g.t += dt; if (g.t >= DUR) { g.end = true; const w = Math.round(g.chars / 5 / (DUR / 60)); g.wpm = w; g.rec = w > 0 && saveBest('wpm', w); SFX.play('typewriter.ding'); SFX.play(g.rec ? 'win' : 'score', { delay: 0.3 }); }
      else if (g.t > DUR - 5 && Math.floor(g.t) !== Math.floor(g.t - dt)) SFX.play('countdown', { vol: 0.5 }); }
    g.pop = Math.max(0, g.pop - dt); g.shake = Math.max(0, g.shake - dt);
    x.fillStyle = '#1e2240'; x.fillRect(0, 0, W, H);
    win(x, 20, 12, W - 40, H - 24, 'TYPE RACER 3000   best ' + BEST() + ' wpm');
    const wpm = g.t > 0.5 ? Math.round(g.chars / 5 / (g.t / 60)) : 0;
    // race track: you vs ghost of your best
    const tx = 40, tw = W - 120;
    for (const [lab, y, frac, col] of [['YOU', 46, Math.min(1, g.t < 0 ? 0 : g.chars / 5 / Math.max(1, BEST() || 40) / (DUR / 60)), '#3ddc84'], ['BEST', 66, Math.min(1, Math.max(0, g.t) / DUR), '#b04fd8']]) {
      x.fillStyle = '#8a8a8a'; x.fillRect(tx, /** @type {number} */ (y), tw, 10); x.fillStyle = /** @type {string} */ (col); x.fillRect(tx + /** @type {number} */ (frac) * (tw - 14), /** @type {number} */ (y) - 2, 14, 14);
      text(x, /** @type {string} */ (lab), tx + tw + 8, /** @type {number} */ (y) + 10, { color: '#000' });
    }
    // words
    x.fillStyle = '#0a1a10'; x.fillRect(40, 92, W - 80, 70);
    let px = 50, py = 112, ox = g.shake > 0 ? Math.sin(t * 80) * 3 : 0;
    for (let k = g.i; k < g.i + 14 && py < 160; k++) { const w = g.list[k]; x.font = '16px m5x7'; const ww = x.measureText(w + ' ').width;
      if (px + ww > W - 50) { px = 50; py += 22; if (py >= 160) break; }
      const cur = k === g.i, typed = cur && !w.startsWith(g.buf);
      text(x, w, px + (cur ? ox : 0), py, { color: cur ? (typed ? '#ff8080' : '#ffcf8a') : '#6ee7a0', size: 16 }); px += ww; }
    x.fillStyle = '#fff'; x.fillRect(40, 172, W - 80, 24); text(x, '> ' + g.buf + ((t * 2) % 1 < 0.5 ? '_' : ''), 48, 189, { color: '#000' });
    text(x, 'time ' + Math.max(0, DUR - Math.max(0, g.t)).toFixed(1) + 's   wpm ' + wpm + '   ok ' + g.ok + '  typos ' + g.bad, 40, 216, { color: '#000' });
    if (g.pop > 0) text(x, '+1', 60 + g.pop * 40, 100, { color: '#3ddc84' });
    if (g.t < 0) text(x, 'start typing to begin', W / 2, 240, { align: 'center', color: '#1a2a8a' });
    if (g.end) { x.fillStyle = 'rgba(10,10,20,0.85)'; x.fillRect(100, 80, 280, 110);
      text(x, g.wpm + ' WPM', W / 2, 128, { size: 48, align: 'center', color: g.rec ? '#ffcf8a' : '#6ee7a0', title: true });
      text(x, g.rec ? 'NEW PERSONAL BEST!' : 'best ' + BEST() + ' wpm', W / 2, 152, { align: 'center', color: '#e0a458' });
      text(x, 'enter: race again', W / 2, 176, { align: 'center', color: '#aaa' }); }
  });
}
