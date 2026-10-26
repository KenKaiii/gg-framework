// @ts-check
// Rules board close-up: eight rules, the first two bleeped (try to read them: 1/2 or click), plus today's homework card
// (date-seeded dare). Mark it done once a day for a streak and 15 coins.
import { loop, text, coins } from './util.js';
import { SFX } from '../sfx.js';

// the TV-censor bleep: a soft 1 kHz sine, short
SFX.define('fc.bleep', (o, t, p, K) => K.tone(o, t, { type: 'sine', f: 1000 * p, v: 0.12, a: 0.01, d: 0.32 }));
import { setView, clearView, hideOccluders, worldOf } from './view.js';
import { load, save, today, pops, INK, PINK, AMBER, GREEN, RED } from './fightclub-util.js';

const RULES = ['You do not ████ about ██.', 'You DO NOT ████ about ██.', 'Someone yells stop, it\'s over.', 'Only two guys to a fight.', 'One fight at a time.', 'No shirts, no shoes.', 'Fights go on as long as needed.', 'First night here? You fight.'];
const BLEEPS = ['*BLEEP*', 'nice try.', 'rule two is rule one.', 'we said NO.', 'that is classified.', 'read the room.'];
const DARES = ['Ship a commit before midnight.', 'Delete 50 lines you are proud of.', 'Write one test that fails first.', 'Close 10 browser tabs. Now.', 'Rename one terrible variable.', 'Drink a glass of water. Then code.', 'Push to prod. Then go to bed.', 'Read an error message to the end.', 'Comment why, not what, once.', 'Fix the oldest TODO you own.', 'Pair with someone in the bar.', 'Say no to one new dependency.'];

/** @param {any} ctx */
export function startRules(ctx) {
  const ov = ctx.overlay({ title: 'The Rules', sub: 'chalkboard by the workbench', help: '<kbd>1</kbd> <kbd>2</kbd> try reading the first rules <kbd>enter</kbd> homework done <kbd>esc</kbd> leave' });
  setView(ctx.S, { target: worldOf(ctx.R, 8.4, 1.3, -6.0), dir: { x: 0.15, y: 0.35, z: 1 }, zoom: 1.1 }); hideOccluders(ctx.S); ov.onClose(() => clearView(ctx.S));
  const W = 480, H = 270; const { x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const day = today(), dare = DARES[(day * 2654435761 >>> 0) % DARES.length];
  const rec = load('rules', { last: 0, streak: 0, done: 0, bleeps: 0 });
  const yest = today(new Date(Date.now() - 864e5)), doneToday = () => rec.last === day;
  const P = pops(); let shake = 0, bleepT = 0, bleepRow = -1, msg = '', stamp = doneToday() ? 1 : 0;
  const tryRead = (/** @type {number} */ i) => { bleepRow = i; bleepT = 0.8; SFX.play('fc.bleep'); shake = 0.3; rec.bleeps++; msg = BLEEPS[rec.bleeps % BLEEPS.length]; P.add(msg, 230, 92 + i * 22, RED); save('rules', rec); ctx.R?.fc?.flash(); };
  const kd = (/** @type {KeyboardEvent} */ e) => {
    if (e.code === 'Digit1' || e.code === 'Numpad1') tryRead(0); else if (e.code === 'Digit2' || e.code === 'Numpad2') tryRead(1);
    else if (e.code === 'Enter' && doneToday()) SFX.play('ui.deny');
    else if (e.code === 'Enter' && !doneToday()) { rec.streak = rec.last === yest ? rec.streak + 1 : 1; rec.last = day; rec.done++; save('rules', rec); coins(ctx.S).spend(-15, null); stamp = 0.01; SFX.play('thud', { delay: 0.12 }); SFX.play('success', { delay: 0.2 }); P.add('+15c', 380, 150, '#ffe14a'); }
  };
  addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd));
  loop(ov, (dt, t) => {
    shake = Math.max(0, shake - dt); bleepT = Math.max(0, bleepT - dt); if (stamp > 0 && stamp < 1) stamp = Math.min(1, stamp + dt * 3);
    x.save(); x.translate(shake > 0 ? Math.round(Math.sin(t * 90) * 3) : 0, 0);
    x.fillStyle = '#3a2a22'; x.fillRect(-4, 0, W + 8, H);
    x.fillStyle = '#5a3e2a'; x.fillRect(10, 10, 290, 250); x.fillStyle = '#2e3a30'; x.fillRect(18, 18, 274, 234);
    text(x, 'THE RULES', 155, 46, { size: 32, title: true, color: INK, align: 'center' });
    RULES.forEach((s, i) => { const red = i < 2; const on = red && bleepRow === i && bleepT > 0;
      if (on) { x.fillStyle = `rgba(255,107,107,${bleepT})`; x.fillRect(22, 58 + i * 22, 266, 20); }
      text(x, `${i + 1}. ${s}`, 28, 74 + i * 22, { color: on ? '#fff' : red ? '#ff9aa8' : '#d8dccf' }); });
    text(x, `bleeped ${rec.bleeps}x`, 155, 248, { color: '#8a9a8a', align: 'center' });
    // homework card
    x.save(); x.translate(318, 40); x.rotate(0.04);
    x.fillStyle = '#efe6c8'; x.fillRect(0, 0, 150, 190); x.fillStyle = '#c8b890'; for (let k = 0; k < 9; k++) x.fillRect(8, 48 + k * 16, 134, 1);
    x.fillStyle = PINK; x.fillRect(64, -6, 22, 12);
    text(x, 'HOMEWORK', 75, 26, { title: true, color: '#5a2034', align: 'center' });
    text(x, String(day).replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3'), 75, 42, { color: '#7a6a50', align: 'center' });
    const words = dare.split(' '); const lines = ['']; for (const w of words) { if ((lines[lines.length - 1] + ' ' + w).length > 18) lines.push(w); else lines[lines.length - 1] += (lines[lines.length - 1] ? ' ' : '') + w; }
    lines.forEach((l, k) => text(x, l, 75, 76 + k * 16, { color: '#2a2020', align: 'center' }));
    text(x, `streak ${rec.streak}  total ${rec.done}`, 75, 176, { color: '#5a4a30', align: 'center' });
    x.restore();
    if (stamp > 0) { const k = stamp < 0.6 ? 2 : 1; x.globalAlpha = Math.min(1, stamp * 1.5); x.save(); x.translate(390, 170); x.scale(k, k);
      x.fillStyle = '#c02a3a'; x.fillRect(-36, -14, 72, 2); x.fillRect(-36, 10, 72, 2); x.fillRect(-36, -14, 2, 26); x.fillRect(34, -14, 2, 26);
      text(x, 'DONE', 0, 6, { size: 16, color: '#c02a3a', align: 'center' }); x.restore(); x.globalAlpha = 1; }
    text(x, doneToday() ? 'see you tomorrow.' : 'enter: I did it (honour system)', 393, 252, { color: doneToday() ? GREEN : AMBER, align: 'center' });
    P.draw(x, dt); x.restore();
  });
}
