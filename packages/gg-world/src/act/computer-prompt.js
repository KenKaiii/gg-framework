// @ts-check
// Prompt School: a daily (date-seeded) 5-question lesson on using coding agents well. After each answer a short
// "why"; at the end a summary card of the 5 tips (ticked if you got them), best score saved, +25 coins for a
// perfect run once per day. Questions are practical habits, not trivia.
// GX rebuild: a beige lab CRT (DOM, screen resolution) with a green-phosphor lesson; answers are real buttons.
import { SFX } from '../sfx.js';
import { coins } from './util.js';
import { gx, GX } from './gx.js';
import { today, store, closeUp } from './computer-util.js';

/** [question, [answers], correct, why (shown after answering), tip (summary card, <= ~44 chars)] */
export const BANK = [
  ['Your agent keeps guessing wrong. Best fix?', ['Say it louder, in CAPS', 'Give it the files, error and goal', 'Start over and hope'], 1, 'It only knows what you show it. Point at files, paste the exact error, say the goal.', 'Give context: files, error, goal'],
  ['Big feature to build. How do you ask?', ['One giant prompt for all of it', 'Plan first, then small steps', 'Let it run all night alone'], 1, 'Ask for a plan, then do one step at a time. Small diffs are easy to check and undo.', 'Plan first, then small steps'],
  ['How do you know the change works?', ['It compiled, ship it', 'Ask for tests and run them', 'The agent said "done"'], 1, '"Done" is a claim. A test you ran is proof. Ask it to add or run tests.', 'Ask for tests, run them yourself'],
  ['The agent edited 14 files. Next?', ['Review the diff first', 'git push --force', 'Merge with eyes closed'], 0, 'Read the diff before you commit. Look for deleted code and surprise files.', 'Always review the diff'],
  ['The bug repro needs your API key. You...', ['Paste the key in the prompt', 'Use an env var / placeholder', 'Post it in chat'], 1, 'Prompts get logged and shared. Keep secrets in env vars; rotate any you leaked.', 'Never paste secrets'],
  ['Agent says library has function X.', ['Trust it', 'Check docs or the source', 'Rewrite the library'], 1, 'Agents can invent APIs that look right. Verify in the docs or installed source.', 'Verify APIs it claims exist'],
  ['Best way to report a bug to it?', ['"it broke"', 'Steps, expected vs actual, error', 'A screenshot of your face'], 1, 'Repro steps + expected vs actual + the exact error lets it find the cause, not guess.', 'Repro steps + expected vs actual'],
  ['Output style is wrong. You...', ['Show one short example', 'Retry 20 times', 'Rage-quit'], 0, 'One concrete example beats ten adjectives. Show the shape you want.', 'Show an example of what you want'],
  ['It keeps failing the same fix.', ['Let it keep trying', 'Stop: new info or smaller ask', 'Delete the repo'], 1, 'Loops mean it is missing something. Add a log, narrow the task, or reset the chat.', 'Stuck loop? Stop and re-scope'],
  ['Before a risky refactor you...', ['Commit a clean checkpoint', 'Refactor on main, live', 'Hope'], 0, 'A clean commit first means any mess is one git command away from gone.', 'Commit a checkpoint first'],
  ['You don\'t understand code it wrote.', ['Ship it anyway', 'Ask it to explain, then decide', 'Pretend you do'], 1, 'You own what you merge. Ask why, ask for simpler, or reject it.', 'Understand it before you merge'],
  ['Where do project rules live?', ['Repeat them each prompt', 'A rules file it reads (AGENTS.md)', 'Nowhere, vibes'], 1, 'Write conventions once in a file the agent loads: style, test command, no-go zones.', 'Keep rules in a project file'],
  ['Asking for a new function. Add...', ['Nothing, it knows', 'Inputs, outputs, edge cases', 'Lots of emoji'], 1, 'Spell out inputs, outputs and the weird cases. Vague asks give vague code.', 'State inputs, outputs, edge cases'],
  ['Long chat, answers getting worse.', ['Keep going forever', 'Fresh chat with a short summary', 'Type faster'], 1, 'Old context clutters it. Start fresh with a summary of what matters now.', 'Long chat? Fresh start + summary'],
];
const N = 5;

/** Today's questions (deterministic for the date). @param {number} seed */
export function pick(seed) { const idx = BANK.map((_, i) => i); let s = seed; for (let i = idx.length - 1; i > 0; i--) { s = (s * 1664525 + 1013904223) >>> 0; const j = s % (i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; } return idx.slice(0, N).map(i => BANK[i]); }

const CSS = `.ps-mon{position:absolute;inset:0;box-sizing:border-box;border-radius:3.4cqw;background:linear-gradient(180deg,#ece3cf,#d9ceb4 55%,#b9ad92);box-shadow:inset 0 2px 0 #fffaf0,0 30px 70px -26px #000;padding:3.2cqw 3.6cqw 6cqw}
.ps-mon:after{content:'PROMPT SCHOOL  CRT-93';position:absolute;left:0;right:0;bottom:1.9cqw;text-align:center;font:800 1.5cqw/1 'Sora',sans-serif;letter-spacing:.3em;color:#6a604c}
.ps-scr{position:relative;box-sizing:border-box;height:100%;border-radius:1.6cqw;background:radial-gradient(ellipse at 50% 40%,#0f2a26,#081614 75%);box-shadow:inset 0 0 0 .4cqw #7f7562,inset 0 0 3cqw #000;padding:2.6cqw 3.4cqw;overflow:hidden;color:#6ee7a0;font-family:'Sora',sans-serif}
.ps-scr:after{content:'';position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(0,0,0,.18) 0 1px,transparent 1px 3px),linear-gradient(160deg,rgba(255,255,255,.09),transparent 30%)}
.ps-top{display:flex;align-items:center;gap:1.2cqw;font:700 1.5cqw/1 'Sora';letter-spacing:.12em;color:#3aa86e}.ps-top .sp{flex:1}.ps-dot{width:2.2cqw;height:1cqw;border-radius:.5cqw;background:#1a3a24}
.ps-q{margin:2.2cqw 0 2cqw;font:700 3.1cqw/1.25 'Sora';color:#d8ffe4;text-shadow:0 0 1cqw rgba(110,231,160,.4);letter-spacing:-.01em}
.ps-a{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:1.4cqw;width:100%;margin-bottom:1.1cqw;padding:1.2cqw 1.4cqw;border-radius:1cqw;background:rgba(110,231,160,.07);box-shadow:inset 0 0 0 1px rgba(110,231,160,.25);font:600 2.2cqw/1.2 'Sora';color:#6ee7a0;cursor:pointer;transition:background-color .15s,transform .1s}
.ps-a:hover:not([disabled]){background:rgba(110,231,160,.2);color:#fff}.ps-a:active:not([disabled]){transform:translateY(2px)}.ps-a .gx-key{flex:none}
.ps-a.ok{background:rgba(61,220,132,.28);box-shadow:inset 0 0 0 1px #3ddc84;color:#d8ffe4}.ps-a.no{background:rgba(255,90,90,.25);box-shadow:inset 0 0 0 1px #e8645a;color:#ffb0a0}.ps-a[disabled]{cursor:default}.ps-a.dim{opacity:.45}
.ps-why{margin-top:1.4cqw;display:flex;gap:1.6cqw;align-items:baseline;font:500 1.9cqw/1.4 'Sora';color:#f0e6c8}.ps-why b{flex:none;font-weight:800;letter-spacing:.06em}.ps-why .next{margin-left:auto;flex:none}
.ps-tips{text-align:left;margin:14px 0 0;display:grid;gap:6px;font-size:13px}.ps-tips div{display:flex;gap:8px;align-items:center;padding:7px 10px;border-radius:8px;background:${GX.s2}}.ps-tips i{font-style:normal;font-weight:800;width:14px}`;
const HELP_Q = '<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd>/<kbd>click</kbd> answer <kbd>enter</kbd>/<kbd>click</kbd> next';

/** @param {any} ctx */
export function startPrompt(ctx) {
  const d = today(), qs = pick(d.seed);
  const ov = ctx.overlay({ title: 'Prompt School', sub: 'Daily lesson · ' + d.s + ' · new one tomorrow', help: HELP_Q });
  closeUp(ctx, ov, -3.1, 1.2, -6.4, 1.2);
  const K = gx(ov);
  const hud = K.hud([{ id: 'q', label: 'Lesson', value: '1 / ' + N }, { id: 'score', label: 'Score', value: 0, tone: 'up' }], [{ id: 'best', label: 'Best', value: (Number(store('promptBest')) || 0) + ' / ' + N, tone: 'gold' }]);
  const scene = K.scene({ aspect: 16 / 9.4, maxW: 1100 });
  const st0 = document.createElement('style'); st0.textContent = CSS; scene.appendChild(st0);
  const mon = document.createElement('div'); mon.className = 'ps-mon'; mon.innerHTML = '<div class="ps-scr"></div>'; scene.appendChild(mon);
  const scr = /** @type {HTMLElement} */ (mon.querySelector('.ps-scr'));
  const st = { i: 0, pick: -1, score: 0, done: false, reward: '', got: /** @type {boolean[]} */ ([]) };
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] || c);
  const render = () => {
    const q = qs[st.i]; hud.set('q', (st.i + 1) + ' / ' + N); hud.set('score', st.score);
    const dots = Array.from({ length: N }, (_, k) => `<span class="ps-dot" style="background:${k < st.i ? (st.got[k] ? '#3ddc84' : '#e8645a') : k === st.i ? '#ffcf8a' : '#1a3a24'}"></span>`).join('');
    const ans = /** @type {string[]} */ (q[1]).map((a, k) => { const cls = st.pick < 0 ? '' : k === q[2] ? 'ok' : k === st.pick ? 'no' : 'dim';
      return `<button class="ps-a ${cls}" type="button" data-k="${k}" ${st.pick >= 0 ? 'disabled' : ''}>${K.keys(String(k + 1))}<span>${esc(a)}</span></button>`; }).join('');
    const ok = st.pick === q[2];
    const why = st.pick >= 0 ? `<div class="ps-why"><b style="color:${ok ? GX.warning : GX.error}">${ok ? 'Correct' : 'Not quite'}</b><span>${esc(q[3])}</span><button class="gx-btn pri next" type="button">${st.i === N - 1 ? 'Results' : 'Next'}</button></div>` : '';
    scr.innerHTML = `<div class="ps-top">${dots}<span>LESSON ${st.i + 1}/${N}</span><span class="sp"></span><span>${d.s}</span></div><div class="ps-q">${esc(q[0])}</div>${ans}${why}`;
    scr.querySelectorAll('.ps-a').forEach(b => b.addEventListener('click', () => answer(Number(/** @type {HTMLElement} */ (b).dataset.k))));
    scr.querySelector('.next')?.addEventListener('click', next);
  };
  const answer = n => {
    if (st.done || st.pick >= 0 || n >= 3) return; st.pick = n; const ok = n === qs[st.i][2]; st.got[st.i] = ok; SFX.play('key');
    if (ok) { st.score++; SFX.play('success', { delay: 0.08 }); } else SFX.play('ui.deny', { delay: 0.08 });
    render(); const b = scr.querySelector(`[data-k="${n}"]`)?.getBoundingClientRect(); if (b) K.pop(b.left + b.width * 0.7, b.top, ok ? '+1' : 'Nope', ok ? 'up' : 'bad');
    ov.setHelp('<kbd>enter</kbd>/<kbd>click</kbd> ' + (st.i === N - 1 ? 'results' : 'next question'));
  };
  const next = () => { if (st.done || st.pick < 0) return; st.i++; st.pick = -1; SFX.play('page'); if (st.i >= N) finish(); else { ov.setHelp(HELP_Q); render(); } };
  const restart = () => { SFX.play('pc.boot', { vol: 0.5 }); Object.assign(st, { i: 0, pick: -1, score: 0, done: false, reward: '', got: [] }); ov.setHelp(HELP_Q); render(); };
  const finish = () => {
    st.done = true; st.i = N - 1; const b = Number(store('promptBest')) || 0; if (st.score > b) store('promptBest', st.score);
    hud.set('best', (Number(store('promptBest')) || 0) + ' / ' + N); hud.set('score', st.score);
    if (st.score === N) { if (store('promptPaid') !== d.s) { store('promptPaid', d.s); try { coins(ctx.S).spend(-25); st.reward = '+25 coins for a perfect lesson!'; } catch { st.reward = 'Perfect lesson!'; } } else st.reward = 'Perfect again (coins paid today).'; K.swell(); }
    else st.reward = '5/5 pays 25 coins. New lesson tomorrow.';
    SFX.play(st.score === N ? 'win' : st.score >= 3 ? 'score' : 'fail', { delay: 0.1 }); if (st.score === N) SFX.play('sparkle', { delay: 0.5 });
    ov.setHelp('<kbd>enter</kbd>/<kbd>click</kbd> retry');
    const r = K.result({ title: st.score === N ? 'Perfect' : "Today's tips", big: st.score + ' / ' + N, line: st.reward, again: 'Retry', onAgain: restart });
    r.el.querySelector('.acts')?.insertAdjacentHTML('beforebegin', '<div class="ps-tips">' + qs.map((q, k) => `<div><i style="color:${st.got[k] ? GX.success : GX.error}">${st.got[k] ? '✓' : '✗'}</i>${esc(q[4])}</div>`).join('') + '</div>');
    const ln = r.el.querySelector('p'); if (ln && st.score === N) ln.style.color = GX.warning;
  };
  const onKey = e => { if (st.done) return; const m = /^(Digit|Numpad)([1-3])$/.exec(e.code); if (m) answer(+m[2] - 1); if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); next(); } };
  const cap = e => { if (e.code !== 'Escape') { if (!st.done) e.stopPropagation(); onKey(e); } };
  addEventListener('keydown', cap, true); ov.onClose(() => removeEventListener('keydown', cap, true));
  render();
}
