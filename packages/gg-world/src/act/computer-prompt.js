// @ts-check
// Prompt School: a daily (date-seeded) 5-question lesson on using coding agents well. After each answer a short
// "why"; at the end a summary card of the 5 tips (ticked if you got them), best score saved, +25 coins for a
// perfect run once per day. Questions are practical habits, not trivia.
import { SFX } from '../sfx.js';
import { loop, text, coins, mouse } from './util.js';
import { crt } from './films-a-crt.js';
import { today, store, wrap, closeUp } from './computer-util.js';

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

/** @param {any} ctx */
export function startPrompt(ctx) {
  const d = today(), qs = pick(d.seed);
  const ov = ctx.overlay({ title: 'Prompt School', sub: 'Daily lesson · ' + d.s + ' · new one tomorrow', help: '<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd>/<kbd>click</kbd> answer <kbd>enter</kbd>/<kbd>click</kbd> next <kbd>esc</kbd> leave' });
  closeUp(ctx, ov, -3.1, 1.2, -6.4, 1.2);
  const W = 480, H = 270; const { x, c } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const st = { i: 0, pick: -1, score: 0, t: 0, flash: 0, shake: 0, done: false, reward: '', got: /** @type {boolean[]} */ ([]) };
  const answer = n => { if (st.done || st.pick >= 0 || n >= 3) return; st.pick = n; const ok = n === qs[st.i][2]; st.got[st.i] = ok; SFX.play('key'); if (ok) { st.score++; st.flash = 0.6; SFX.play('success', { delay: 0.08 }); } else { st.shake = 0.5; SFX.play('ui.deny', { delay: 0.08 }); } ov.setHelp('<kbd>enter</kbd>/<kbd>click</kbd> ' + (st.i === N - 1 ? 'results' : 'next question') + ' <kbd>esc</kbd> leave'); };
  const next = () => { if (st.done) { restart(); return; } if (st.pick < 0) return; st.i++; st.pick = -1; SFX.play('page'); if (st.i >= N) finish(); else ov.setHelp('<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd>/<kbd>click</kbd> answer <kbd>esc</kbd> leave'); };
  const restart = () => { SFX.play('pc.boot', { vol: 0.5 }); Object.assign(st, { i: 0, pick: -1, score: 0, done: false, reward: '', got: [] }); ov.setHelp('<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd>/<kbd>click</kbd> answer <kbd>esc</kbd> leave'); };
  const finish = () => { st.done = true; const b = Number(store('promptBest')) || 0; if (st.score > b) store('promptBest', st.score);
    if (st.score === N) { if (store('promptPaid') !== d.s) { store('promptPaid', d.s); try { coins(ctx.S).spend(-25); st.reward = '+25 coins for a perfect lesson!'; } catch { st.reward = 'Perfect lesson!'; } } else st.reward = 'Perfect again (coins paid today).'; }
    else st.reward = '5/5 pays 25 coins. Retry: enter.';
    SFX.play(st.score === N ? 'win' : st.score >= 3 ? 'score' : 'fail', { delay: 0.1 }); if (st.score === N) SFX.play('sparkle', { delay: 0.5 });
    ov.setHelp('<kbd>enter</kbd>/<kbd>click</kbd> retry <kbd>esc</kbd> leave'); };
  const onKey = e => { const m = /^(Digit|Numpad)([1-3])$/.exec(e.code); if (m) answer(+m[2] - 1); if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); next(); } };
  const cap = e => { if (e.code !== 'Escape') { e.stopPropagation(); onKey(e); } };
  addEventListener('keydown', cap, true); ov.onClose(() => removeEventListener('keydown', cap, true));
  // mouse: click an answer (same boxes as the drawn rows); after answering / on the results card, click anywhere = enter
  const SX = 66, SY = 26, SW = 348; const M = mouse(ov, c, W, H);
  const areas = () => { if (st.done || st.pick >= 0) M.set([{ x: 0, y: 0, w: W, h: H, pick: next }]); else M.rows(k => ({ x: SX + 6, y: SY + 70 + k * 18 - 13, w: SW - 12, h: 17 }), 3, { pick: answer }); };
  loop(ov, dt => { areas();
    st.t += dt; st.flash = Math.max(0, st.flash - dt * 1.5); st.shake = Math.max(0, st.shake - dt);
    x.save(); x.translate(st.shake > 0 ? Math.round(Math.sin(st.t * 90) * 4 * st.shake) : 0, 0);
    crt(x, W, H, (sx, sy, sw) => {
      const G = '#6ee7a0', D = '#2f9a62';
      if (st.done) {
        text(x, 'TODAY\'S TIPS', sx + 10, sy + 18, { color: G }); text(x, st.score + '/' + N, sx + sw - 10, sy + 18, { align: 'right', color: st.score === N ? '#ffcf8a' : G });
        qs.forEach((q, k) => text(x, (st.got[k] ? '+ ' : '- ') + q[4], sx + 10, sy + 42 + k * 18, { color: st.got[k] ? '#b8f5d0' : '#ff9a8a' }));
        text(x, st.reward, sx + 10, sy + 142, { color: '#ffcf8a' });
        text(x, 'best ' + (store('promptBest') || 0) + '/' + N + ' · new lesson tomorrow', sx + 10, sy + 160, { color: D });
        return;
      }
      const q = qs[st.i]; text(x, 'LESSON ' + (st.i + 1) + '/' + N, sx + 10, sy + 16, { color: D }); text(x, 'score ' + st.score, sx + sw - 10, sy + 16, { align: 'right', color: D });
      wrap(x, /** @type {string} */ (q[0]), sw - 24).forEach((l, k) => text(x, l, sx + 10, sy + 36 + k * 16, { color: G }));
      /** @type {string[]} */ (q[1]).forEach((a, k) => {
        const y = sy + 70 + k * 18, ok = k === q[2], sel = k === st.pick;
        if (st.pick >= 0 && (ok || sel)) { x.fillStyle = ok ? 'rgba(61,220,132,0.25)' : 'rgba(255,90,90,0.25)'; x.fillRect(sx + 6, y - 13, sw - 12, 17); }
        text(x, (k + 1) + ') ' + a, sx + 12, y, { color: st.pick >= 0 ? (ok ? '#b8f5d0' : sel ? '#ff8080' : D) : G });
      });
      if (st.pick >= 0) { const ok = st.pick === q[2];
        text(x, ok ? 'CORRECT' : 'NOT QUITE', sx + 10, sy + 132, { color: ok ? '#ffcf8a' : '#ff8080' });
        wrap(x, /** @type {string} */ (q[3]), sw - 24).slice(0, 2).forEach((l, k) => text(x, l, sx + 10, sy + 148 + k * 15, { color: '#e0d6b8' })); }
    }, { flash: st.flash * 0.3 });
    x.restore();
  });
}
