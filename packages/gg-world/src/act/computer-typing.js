// @ts-check
// Typing race: 30 seconds of dev/AI words, WPM + accuracy, best WPM saved. A ghost bar races your best.
// GX rebuild: a beige lab monitor (DOM at screen resolution) with a green-phosphor word stream, two race lanes
// (you vs your best) and an input line; HUD plates for time / WPM / typos / best; a result card at the bell.
import { SFX } from '../sfx.js';
import { loop } from './util.js';
import { gx, GX } from './gx.js';
import { best, saveBest, seat, closeUp, today } from './computer-util.js';

const WORDS = 'prompt context agent diff commit deploy refactor token model tests review branch merge rebase lint build cache async await promise schema vector embed latency stack trace bug patch rollback env secret config hotfix sprint ship vibe pipeline docker kernel npm yarn json regex lambda'.split(' ');
const CSS = `.tr-mon{position:absolute;inset:0;box-sizing:border-box;border-radius:3.4cqw;background:linear-gradient(180deg,#ece3cf,#d9ceb4 55%,#b9ad92);box-shadow:inset 0 2px 0 #fffaf0,0 30px 70px -26px #000;padding:3.2cqw 3.6cqw 6cqw}
.tr-mon:after{content:'GG·93  TYPE RACER 3000';position:absolute;left:0;right:0;bottom:1.8cqw;text-align:center;font:800 1.5cqw/1 'Sora',sans-serif;letter-spacing:.3em;color:#6a604c}
.tr-scr{position:relative;box-sizing:border-box;height:100%;border-radius:1.6cqw;background:radial-gradient(ellipse at 50% 40%,#0f2a26,#081614 75%);box-shadow:inset 0 0 0 .4cqw #7f7562,inset 0 0 3cqw #000;padding:3cqw 3.4cqw;overflow:hidden;color:#6ee7a0;font-family:'Sora',sans-serif}
.tr-scr:after{content:'';position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(0,0,0,.18) 0 1px,transparent 1px 3px),linear-gradient(160deg,rgba(255,255,255,.09),transparent 30%)}
.tr-lane{display:grid;grid-template-columns:5cqw 1fr;align-items:center;gap:1.4cqw;margin-bottom:1.2cqw;font:700 1.5cqw/1 'Sora';letter-spacing:.12em}
.tr-track{position:relative;height:1.3cqw;border-radius:1cqw;background:rgba(255,255,255,.07)}.tr-fill{position:absolute;inset:0 auto 0 0;border-radius:1cqw;opacity:.35}.tr-car{position:absolute;top:50%;width:2.2cqw;height:2.2cqw;margin:-1.1cqw 0 0 -1.1cqw;border-radius:.6cqw;box-shadow:0 0 1.4cqw currentColor}
.tr-words{margin-top:2.6cqw;height:13cqw;font:600 3cqw/1.5 'Sora';display:flex;flex-wrap:wrap;align-content:flex-start;gap:0 1.6cqw;overflow:hidden;text-shadow:0 0 1cqw rgba(110,231,160,.45)}
.tr-words .cur{color:#ffcf8a;background:rgba(255,207,138,.14);border-radius:.6cqw;padding:0 .5cqw;margin:0 -.5cqw}.tr-words .cur b{color:#fff;font-weight:600}.tr-words .cur.bad{color:#ff8080;background:rgba(255,90,90,.2)}
.tr-words.shake{animation:tr-sh .3s}@keyframes tr-sh{25%{translate:-6px 0}75%{translate:6px 0}}
.tr-in{margin-top:2cqw;padding:1.2cqw 1.6cqw;border-radius:1cqw;background:rgba(0,0,0,.35);box-shadow:inset 0 0 0 1px rgba(110,231,160,.3);font:600 2.6cqw/1.2 'Sora';color:#eaffd0}
.tr-in i{display:inline-block;width:1.2cqw;height:2.6cqw;vertical-align:-.4cqw;margin-left:.3cqw;background:#6ee7a0;animation:tr-bl 1.6s steps(1) infinite}@keyframes tr-bl{50%{opacity:0}}
.tr-hint{margin-top:1.4cqw;font:500 1.6cqw/1.3 'Sora';color:rgba(110,231,160,.6)}
@media (prefers-reduced-motion: reduce){.tr-words.shake,.tr-in i{animation:none}}`;

/** @param {any} ctx */
export function startTyping(ctx) {
  const stand = seat(ctx);
  const ov = ctx.overlay({ title: 'TYPE RACER 3000', sub: '30 seconds · dev words', help: '<kbd>type</kbd> the words <kbd>space</kbd> next word <kbd>enter</kbd>/<kbd>click</kbd> restart' });
  ov.onClose(stand); { const sl = ctx.it?.slot; closeUp(ctx, ov, sl ? sl.x : 3, 1.0, sl ? sl.z - 0.9 : 1.8); }
  const K = gx(ov), DUR = 30, BEST = () => best('wpm');
  const hud = K.hud([{ id: 'time', label: 'Time', value: '30.0' }, { id: 'wpm', label: 'WPM', value: 0, tone: 'up' }, { id: 'ok', label: 'Words', value: 0, tone: 'teal' }, { id: 'bad', label: 'Typos', value: 0, tone: 'bad' }], [{ id: 'best', label: 'Best', value: BEST() + ' wpm', tone: 'gold' }]);
  const scene = K.scene({ aspect: 16 / 8.6, maxW: 1100 });
  const st0 = document.createElement('style'); st0.textContent = CSS; scene.appendChild(st0);
  const mon = document.createElement('div'); mon.className = 'tr-mon'; scene.appendChild(mon);
  const lane = (n, col) => `<div class="tr-lane" style="color:${col}"><span>${n}</span><div class="tr-track"><div class="tr-fill" style="background:${col}"></div><div class="tr-car" style="background:${col}"></div></div></div>`;
  mon.innerHTML = `<div class="tr-scr">${lane('YOU', GX.success)}${lane('BEST', GX.violet)}<div class="tr-words"></div><div class="tr-in">&gt; <span></span><i></i></div><div class="tr-hint">Start typing to start the clock.</div></div>`;
  const $ = s => /** @type {HTMLElement} */ (mon.querySelector(s));
  const [fYou, fBest] = /** @type {HTMLElement[]} */ ([...mon.querySelectorAll('.tr-fill')]), [cYou, cBest] = /** @type {HTMLElement[]} */ ([...mon.querySelectorAll('.tr-car')]);
  const wordsEl = $('.tr-words'), inEl = $('.tr-in span'), hint = $('.tr-hint');
  let s = today().seed; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  /** @type {any} */ let g; let res = /** @type {any} */ (null);
  const renderWords = () => {
    const w = g.list[g.i], bad = !w.startsWith(g.buf), n = bad ? 0 : g.buf.length;
    wordsEl.innerHTML = g.list.slice(g.i, g.i + 18).map((x, k) => k ? `<span>${x}</span>` : `<span class="cur${bad ? ' bad' : ''}"><b>${x.slice(0, n)}</b>${x.slice(n)}</span>`).join('');
    inEl.textContent = g.buf;
  };
  const reset = () => { res?.close(); res = null; g = { list: Array.from({ length: 80 }, () => WORDS[Math.floor(r() * WORDS.length)]), i: 0, buf: '', ok: 0, bad: 0, chars: 0, t: -1, end: false, rec: false };
    hud.set('ok', 0); hud.set('bad', 0); hud.set('wpm', 0); hud.set('time', '30.0'); hint.textContent = 'Start typing to start the clock.'; renderWords(); };
  reset();
  const finish = () => {
    g.end = true; const w = Math.round(g.chars / 5 / (DUR / 60)); g.wpm = w; g.rec = w > 0 && saveBest('wpm', w); hud.set('best', BEST() + ' wpm'); hud.set('wpm', w);
    SFX.play('typewriter.ding'); SFX.play(g.rec ? 'win' : 'score', { delay: 0.3 }); if (g.rec) K.swell();
    const acc = g.ok + g.bad ? Math.round(g.ok / (g.ok + g.bad) * 100) : 0;
    res = K.result({ title: g.rec ? 'New best' : 'Time!', big: w, line: 'words per minute', stats: [[g.ok, 'Words'], [g.bad, 'Typos'], [acc + '%', 'Accuracy'], [BEST(), 'Best WPM']], again: 'Race again', onAgain: () => { res = null; reset(); } });
  };
  const onKey = e => {
    if (e.code === 'Enter') { reset(); SFX.play('ui.click'); return; } if (g.end) return;
    if (e.key === ' ') { e.preventDefault(); if (!g.buf) return; const cur = wordsEl.firstElementChild?.getBoundingClientRect();
      if (g.buf === g.list[g.i]) { g.ok++; g.chars += g.buf.length + 1; if (cur) K.pop(cur.left + cur.width / 2, cur.top, '+1', 'up'); SFX.play('tick', { vol: 0.6 }); hud.set('ok', g.ok); }
      else { g.bad++; hud.set('bad', g.bad); SFX.play('ui.deny', { vol: 0.5 }); wordsEl.classList.remove('shake'); void wordsEl.offsetWidth; wordsEl.classList.add('shake'); }
      g.i++; g.buf = ''; renderWords(); return; }
    if (e.key === 'Backspace') { g.buf = g.buf.slice(0, -1); SFX.play('key', { vol: 0.4, pitch: 0.8 }); renderWords(); return; }
    if (e.key.length === 1 && /[a-z]/i.test(e.key)) { if (g.t < 0) { g.t = 0; hint.textContent = 'Space for the next word. Enter restarts.'; SFX.play('go', { vol: 0.6 }); } g.buf += e.key.toLowerCase(); SFX.play('key', { vol: 0.5, jitter: 0.1 }); renderWords(); }
  };
  const cap = e => { if (e.code !== 'Escape') { e.stopPropagation(); if (res && (e.code === 'Enter' || e.code === 'Space')) return; onKey(e); } };
  addEventListener('keydown', cap, true); ov.onClose(() => removeEventListener('keydown', cap, true));
  let hudT = 0;
  loop(ov, dt => {
    if (g.t >= 0 && !g.end) { g.t += dt; if (g.t >= DUR) finish(); else if (g.t > DUR - 5 && Math.floor(g.t) !== Math.floor(g.t - dt)) SFX.play('countdown', { vol: 0.5 }); }
    const fy = Math.min(1, g.t < 0 ? 0 : g.chars / 5 / Math.max(1, BEST() || 40) / (DUR / 60)), fb = Math.min(1, Math.max(0, g.t) / DUR);
    fYou.style.width = fy * 100 + '%'; cYou.style.left = fy * 100 + '%'; fBest.style.width = fb * 100 + '%'; cBest.style.left = fb * 100 + '%';
    hudT -= dt; if (hudT <= 0 && !g.end) { hudT = 0.1; const left = Math.max(0, DUR - Math.max(0, g.t)); hud.set('time', left.toFixed(1), { tone: left < 5 && g.t >= 0 ? 'bad' : GX.text }); hud.set('wpm', g.t > 0.5 ? Math.round(g.chars / 5 / (g.t / 60)) : 0); }
  });
}
