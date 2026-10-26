// @ts-check
// Rules board close-up: eight rules, the first two bleeped (try to read them: 1/2 or click), plus today's homework card
// (date-seeded dare). Mark it done once a day for a streak and 15 coins.
import { loop, coins, mouse } from './util.js';
import { SFX } from '../sfx.js';

// the TV-censor bleep: a soft 1 kHz sine, short
SFX.define('fc.bleep', (o, t, p, K) => K.tone(o, t, { type: 'sine', f: 1000 * p, v: 0.12, a: 0.01, d: 0.32 }));
import { setView, clearView, hideOccluders, worldOf } from './view.js';
import { load, save, today, pops, PINK, AMBER, GREEN, RED } from './fightclub-util.js';
import { PAL, panel, title, glow, noise, particles, shaker } from './art.js';
import { cached, cardboard, tape } from './fightclub-ui.js';

const RULES = ['You do not ████ about ██.', 'You DO NOT ████ about ██.', 'Someone yells stop, it\'s over.', 'Only two guys to a fight.', 'One fight at a time.', 'No shirts, no shoes.', 'Fights go on as long as needed.', 'First night here? You fight.'];
const BLEEPS = ['*BLEEP*', 'nice try.', 'rule two is rule one.', 'we said NO.', 'that is classified.', 'read the room.'];
const DARES = ['Ship a commit before midnight.', 'Delete 50 lines you are proud of.', 'Write one test that fails first.', 'Close 10 browser tabs. Now.', 'Rename one terrible variable.', 'Drink a glass of water. Then code.', 'Push to prod. Then go to bed.', 'Read an error message to the end.', 'Comment why, not what, once.', 'Fix the oldest TODO you own.', 'Pair with someone in the bar.', 'Say no to one new dependency.'];

/** @param {any} ctx */
export function startRules(ctx) {
  const ov = ctx.overlay({ title: 'The Rules', sub: 'chalkboard by the workbench', help: '<kbd>1</kbd> <kbd>2</kbd> /<kbd>click</kbd> try reading the first rules <kbd>enter</kbd>/<kbd>click card</kbd> homework done <kbd>esc</kbd> leave' });
  setView(ctx.S, { target: worldOf(ctx.R, 8.4, 1.3, -6.0), dir: { x: 0.15, y: 0.35, z: 1 }, zoom: 1.1 }); hideOccluders(ctx.S); ov.onClose(() => clearView(ctx.S));
  const W = 480, H = 270; const { x, c } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const day = today(), dare = DARES[(day * 2654435761 >>> 0) % DARES.length];
  const rec = load('rules', { last: 0, streak: 0, done: 0, bleeps: 0 });
  const yest = today(new Date(Date.now() - 864e5)), doneToday = () => rec.last === day;
  const P = pops(); let bleepT = 0, bleepRow = -1, msg = '', stamp = doneToday() ? 1 : 0;
  const tryRead = (/** @type {number} */ i) => { sh.kick(4); bleepRow = i; bleepT = 0.8; SFX.play('fc.bleep'); rec.bleeps++; msg = BLEEPS[rec.bleeps % BLEEPS.length]; P.add(msg, 230, 92 + i * 22, RED); save('rules', rec); ctx.R?.fc?.flash(); };
  const kd = (/** @type {KeyboardEvent} */ e) => {
    if (e.code === 'Digit1' || e.code === 'Numpad1') tryRead(0); else if (e.code === 'Digit2' || e.code === 'Numpad2') tryRead(1);
    else if (e.code === 'Enter') homework();
  };
  const homework = () => { if (doneToday()) { SFX.play('ui.deny'); return; } { rec.streak = rec.last === yest ? rec.streak + 1 : 1; rec.last = day; rec.done++; save('rules', rec); coins(ctx.S).spend(-15, null); stamp = 0.01; SFX.play('thud', { delay: 0.12 }); SFX.play('success', { delay: 0.2 }); P.add('+15c', 380, 150, '#ffe14a'); fx.burst(390, 170, { n: 30 }); }
  };
  // mouse: click rule 1 / 2 to try reading it, click the homework card to mark it done
  mouse(ov, c, W, H).set([0, 1].map(i => ({ x: 22, y: 58 + i * 22, w: 266, h: 20, pick: () => tryRead(i) })).concat([{ x: 314, y: 34, w: 160, h: 200, pick: homework }]));
  addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd));
  const fx = particles(), sh = shaker();
  // the chalkboard: wooden frame, slate with chalk dust smudges, chalk tray (static, cached)
  const board = cached(W, H, b => {
    const g = b.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#3a2c26'); g.addColorStop(1, '#1a1210'); b.fillStyle = g; b.fillRect(0, 0, W, H);
    for (let r = 0; r < 16; r++) for (let k = 0; k < 13; k++) { b.fillStyle = (r * 7 + k * 3) % 5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.12)'; b.fillRect(k * 40 - (r % 2) * 20 + 1, r * 18 + 1, 38, 16); }
    panel(b, 8, 8, 296, 254, { style: 'wood', r: 3 });
    const sg = b.createRadialGradient(150, 120, 20, 150, 130, 200); sg.addColorStop(0, '#36463a'); sg.addColorStop(1, '#1e2a22'); b.fillStyle = sg; b.fillRect(18, 18, 276, 228);
    b.fillStyle = 'rgba(0,0,0,0.5)'; b.fillRect(18, 18, 276, 2); b.fillRect(18, 18, 2, 228);
    for (let i = 0; i < 9; i++) { b.fillStyle = 'rgba(230,240,230,0.035)'; b.beginPath(); b.ellipse(40 + i * 31 % 250, 40 + i * 53 % 190, 30, 8, i, 0, 7); b.fill(); } // erased smudges
    noise(b, 18, 18, 276, 228, 0.04, 9);
    b.fillStyle = '#4a3020'; b.fillRect(14, 246, 284, 8); b.fillStyle = '#6a4630'; b.fillRect(14, 246, 284, 2); b.fillStyle = '#f0ece0'; b.fillRect(60, 242, 16, 4); b.fillStyle = '#f2a6c0'; b.fillRect(90, 242, 12, 4);
    const v = b.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, W * 0.7); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.5)'); b.fillStyle = v; b.fillRect(0, 0, W, H); });
  const chalk = { ink: 'rgba(20,30,24,0.9)' };
  loop(ov, (dt, t) => {
    bleepT = Math.max(0, bleepT - dt); if (stamp > 0 && stamp < 1) stamp = Math.min(1, stamp + dt * 3);
    x.save(); sh.apply(x, dt); board(x, 0, 0);
    title(x, 'THE RULES', 155, 46, { size: 32, color: '#f0ece0', ink: chalk.ink });
    RULES.forEach((s2, i) => { const red = i < 2, on = red && bleepRow === i && bleepT > 0;
      if (on) { glow(x, 155, 68 + i * 22, 140, '#ff6b6b', bleepT * 0.5); x.fillStyle = `rgba(255,107,107,${bleepT * 0.8})`; x.fillRect(22, 58 + i * 22, 266, 20); }
      title(x, `${i + 1}. ${s2}`, 28, 74 + i * 22, { size: 16, body: true, align: 'left', color: on ? '#fff' : red ? '#ff9aa8' : '#e8ece0', ink: chalk.ink }); });
    title(x, `bleeped ${rec.bleeps}x`, 155, 240, { size: 16, body: true, color: '#9aaa9a', ink: chalk.ink });
    // homework card: cardboard index card, duct-taped, ruled lines
    x.save(); x.translate(318, 40); x.rotate(0.04);
    panel(x, 0, 0, 150, 190, { style: 'paper', r: 1 }); x.fillStyle = 'rgba(90,140,200,0.35)'; for (let k = 0; k < 9; k++) x.fillRect(8, 48 + k * 16, 134, 1); x.fillStyle = 'rgba(220,80,80,0.4)'; x.fillRect(20, 4, 1, 182);
    tape(x, 75, 0, 40, -0.05, 10);
    title(x, 'HOMEWORK', 75, 28, { size: 16, color: '#5a2034', ink: 'rgba(0,0,0,0)' });
    title(x, String(day).replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3'), 75, 43, { size: 16, body: true, color: '#7a6a50', ink: 'rgba(0,0,0,0)' });
    const words = dare.split(' '); const lines = ['']; for (const w of words) { if ((lines[lines.length - 1] + ' ' + w).length > 18) lines.push(w); else lines[lines.length - 1] += (lines[lines.length - 1] ? ' ' : '') + w; }
    lines.forEach((l, k) => title(x, l, 75, 76 + k * 16, { size: 16, body: true, color: '#2a2020', ink: 'rgba(0,0,0,0)' }));
    title(x, `streak ${rec.streak}  total ${rec.done}`, 75, 176, { size: 16, body: true, color: '#5a4a30', ink: 'rgba(0,0,0,0)' });
    x.restore();
    if (stamp > 0) { const k = stamp < 0.6 ? 2 : 1; x.globalAlpha = Math.min(1, stamp * 1.5); x.save(); x.translate(390, 170); x.rotate(-0.15); x.scale(k, k);
      x.strokeStyle = '#c02a3a'; x.lineWidth = 3; x.strokeRect(-38, -16, 76, 28); x.lineWidth = 1; x.strokeRect(-34, -12, 68, 20);
      title(x, 'DONE', 0, 5, { size: 16, color: '#c02a3a', ink: 'rgba(0,0,0,0)' }); x.restore(); x.globalAlpha = 1; }
    const hot = !doneToday(); cardboard(x, 322, 236, 142, 26, { tape: false, tint: hot ? '#f0c070' : '#b8c890' });
    title(x, doneToday() ? 'see you tomorrow' : 'ENTER: I did it', 393, 254, { size: 16, body: true, color: doneToday() ? GREEN : PAL.goldHi });
    fx.draw(x, dt);
    P.draw(x, dt); x.restore();
  });
}
