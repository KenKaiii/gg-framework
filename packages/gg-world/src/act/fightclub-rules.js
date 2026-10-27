// @ts-check
// Rules board close-up (GX kit: a real slate chalkboard in an oak frame + a taped index card): eight rules, the first two bleeped (try to read them: 1/2 or click), plus today's homework card
// (date-seeded dare). Mark it done once a day for a streak and 15 coins.
import { coins } from './util.js';
import { SFX } from '../sfx.js';

// the TV-censor bleep: a soft 1 kHz sine, short
SFX.define('fc.bleep', (o, t, p, K) => K.tone(o, t, { type: 'sine', f: 1000 * p, v: 0.12, a: 0.01, d: 0.32 }));
import { setView, clearView, hideOccluders, worldOf } from './view.js';
import { load, save, today } from './fightclub-util.js';
import { gx } from './gx.js';

const RULES = ['You do not ████ about ██.', 'You DO NOT ████ about ██.', 'Someone yells stop, it\'s over.', 'Only two guys to a fight.', 'One fight at a time.', 'No shirts, no shoes.', 'Fights go on as long as needed.', 'First night here? You fight.'];
const BLEEPS = ['*BLEEP*', 'nice try.', 'rule two is rule one.', 'we said NO.', 'that is classified.', 'read the room.'];
const DARES = ['Ship a commit before midnight.', 'Delete 50 lines you are proud of.', 'Write one test that fails first.', 'Close 10 browser tabs. Now.', 'Rename one terrible variable.', 'Drink a glass of water. Then code.', 'Push to prod. Then go to bed.', 'Read an error message to the end.', 'Comment why, not what, once.', 'Fix the oldest TODO you own.', 'Pair with someone in the bar.', 'Say no to one new dependency.'];

const NOISE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .07 0'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)'/%3E%3C/svg%3E")`;
const CSS = `
.fr-wrap{position:absolute;inset:0;display:flex;gap:3cqw;align-items:center}
.fr-board{position:relative;flex:1.9;height:100%;border-radius:14px;padding:2.4cqw;box-sizing:border-box;background:linear-gradient(#6b4026,#3e2312);box-shadow:inset 0 2px 0 rgba(255,220,180,.2),0 30px 60px -20px rgba(0,0,0,.85)}
.fr-slate{position:relative;height:100%;border-radius:4px;padding:2.6cqw 3cqw;box-sizing:border-box;background:${NOISE},radial-gradient(ellipse at 45% 25%,#3b4d40,#1e2a22 75%);box-shadow:inset 0 4px 14px rgba(0,0,0,.6);color:#eef2ea;text-shadow:0 0 1px rgba(255,255,255,.4)}
.fr-slate h2{margin:0 0 1.4cqw;font-size:3.6cqw;font-weight:800;letter-spacing:.06em;text-align:center;opacity:.92}
.fr-rule{display:block;width:100%;all:unset;box-sizing:border-box;display:block;width:100%;padding:.35cqw .8cqw;border-radius:6px;font-size:1.85cqw;line-height:1.45;font-weight:600;opacity:.88;transition:background-color .5s}
.fr-rule.red{color:#ffb0bc;cursor:pointer}.fr-rule.red:hover{background:rgba(255,255,255,.05)}
.fr-rule.on{background:rgba(255,107,107,.75);color:#fff;transition:none}
.fr-foot{position:absolute;left:0;right:0;bottom:2.2cqw;text-align:center;font-size:1.4cqw;opacity:.55}
.fr-tray{position:absolute;left:3%;right:3%;bottom:-1.4cqw;height:1.4cqw;border-radius:0 0 6px 6px;background:linear-gradient(#5a3820,#2e1a0c)}
.fr-tray i{position:absolute;top:-.6cqw;height:.7cqw;width:2.4cqw;border-radius:3px;background:#f0ece0}
.fr-card{position:relative;flex:1;height:82%;padding:2.2cqw 1.8cqw 1.6cqw;box-sizing:border-box;rotate:2deg;cursor:pointer;color:#2a2020;text-align:center;display:flex;flex-direction:column;
 background:repeating-linear-gradient(transparent 0 calc(2.6cqw - 1px),rgba(90,140,200,.35) calc(2.6cqw - 1px) 2.6cqw) 0 5.5cqw/100% calc(100% - 7cqw) no-repeat,linear-gradient(90deg,transparent 2.2cqw,rgba(220,80,80,.45) 2.2cqw calc(2.2cqw + 1px),transparent 0),#f6f1e4;box-shadow:0 20px 30px -14px rgba(0,0,0,.75);transition:transform .25s}
.fr-card:hover{transform:translateY(-4px)}
.fr-card::before{content:"";position:absolute;top:-1cqw;left:50%;width:7cqw;height:2.2cqw;margin-left:-3.5cqw;rotate:-3deg;background:rgba(190,190,180,.75);box-shadow:0 1px 2px rgba(0,0,0,.3)}
.fr-card h3{margin:0;font-size:2cqw;letter-spacing:.12em;color:#5a2034}
.fr-card .d{font-size:1.3cqw;color:#7a6a50}
.fr-card .dare{margin:2cqw 0 0;font-size:2.1cqw;line-height:1.25;font-weight:700}
.fr-card .s{margin-top:auto;font-size:1.3cqw;color:#5a4a30}
.fr-card .gx-btn{margin-top:1cqw;font-size:max(11px,1.3cqw)}
.fr-stamp{position:absolute;left:50%;top:52%;padding:.4cqw 1.6cqw;border:.35cqw double #c02a3a;color:#c02a3a;font-size:3cqw;font-weight:800;letter-spacing:.1em;translate:-50% -50%;rotate:-12deg;opacity:.85;pointer-events:none}
.fr-stamp.new{animation:fr-st .4s cubic-bezier(.3,1.6,.6,1)}@keyframes fr-st{from{scale:2.2;opacity:0}}
@media (prefers-reduced-motion:reduce){.fr-stamp.new{animation:none}}
`;

/** @param {any} ctx */
export function startRules(ctx) {
  const ov = ctx.overlay({ title: 'The Rules', sub: 'chalkboard by the workbench', help: '<kbd>1</kbd> <kbd>2</kbd> /<kbd>click</kbd> try reading the first rules <kbd>enter</kbd>/<kbd>click card</kbd> homework done' });
  setView(ctx.S, { target: worldOf(ctx.R, 8.4, 1.3, -6.0), dir: { x: 0.15, y: 0.35, z: 1 }, zoom: 1.1 }); hideOccluders(ctx.S); ov.onClose(() => clearView(ctx.S));
  const K = gx(ov);
  if (!document.getElementById('fr-style')) { const s = document.createElement('style'); s.id = 'fr-style'; s.textContent = CSS; document.head.appendChild(s); }
  const day = today(), dare = DARES[(day * 2654435761 >>> 0) % DARES.length];
  const rec = load('rules', { last: 0, streak: 0, done: 0, bleeps: 0 });
  const yest = today(new Date(Date.now() - 864e5)), doneToday = () => rec.last === day;
  const hud = K.hud([{ id: 'streak', label: 'Streak', value: rec.streak, tone: 'gold' }, { id: 'done', label: 'Homework done', value: rec.done }], [{ id: 'bleeps', label: 'Bleeped', value: rec.bleeps + 'x', tone: 'bad' }]);
  const scene = K.scene({ aspect: 1.75, maxW: 1200 });
  const w = document.createElement('div'); w.className = 'fr-wrap'; scene.appendChild(w);
  w.innerHTML = `<div class="fr-board"><div class="fr-slate"><h2>THE RULES</h2><div class="rules"></div><div class="fr-foot"></div></div><div class="fr-tray"><i style="left:12%"></i><i style="left:22%;background:#f2a6c0;width:1.8cqw"></i></div></div>
   <div class="fr-card" role="button" tabindex="-1"><h3>HOMEWORK</h3><div class="d">${String(day).replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3')}</div><p class="dare"></p><div class="s"></div><button class="gx-btn pri" type="button"></button></div>`;
  const q = s => /** @type {HTMLElement} */ (w.querySelector(s));
  const rows = RULES.map((s2, i) => { const b = document.createElement('button'); b.className = 'fr-rule' + (i < 2 ? ' red' : ''); b.type = 'button'; b.textContent = `${i + 1}. ${s2}`; if (i < 2) b.onclick = () => tryRead(i); q('.rules').appendChild(b); return b; });
  q('.dare').textContent = dare;
  const card = q('.fr-card');
  const draw = (fresh = false) => { q('.fr-foot').textContent = `bleeped ${rec.bleeps}x`; q('.s').textContent = `streak ${rec.streak} · total ${rec.done}`;
    const b = /** @type {HTMLElement} */ (card.querySelector('.gx-btn')); b.textContent = doneToday() ? 'See you tomorrow' : 'I did it'; b.classList.toggle('pri', !doneToday());
    if (doneToday() && !card.querySelector('.fr-stamp')) { const st = document.createElement('div'); st.className = 'fr-stamp' + (fresh ? ' new' : ''); st.textContent = 'DONE'; card.appendChild(st); }
    hud.set('streak', rec.streak); hud.set('done', rec.done); hud.set('bleeps', rec.bleeps + 'x'); };
  const tryRead = (/** @type {number} */ i) => { const r = rows[i]; r.classList.add('on'); requestAnimationFrame(() => setTimeout(() => r.classList.remove('on'), 300));
    SFX.play('fc.bleep'); rec.bleeps++; const msg = BLEEPS[rec.bleeps % BLEEPS.length]; const b = r.getBoundingClientRect(); K.pop(b.left + b.width / 2, b.top, msg, 'bad'); save('rules', rec); ctx.R?.fc?.flash(); draw(); };
  const homework = () => { if (doneToday()) { SFX.play('ui.deny'); return; }
    rec.streak = rec.last === yest ? rec.streak + 1 : 1; rec.last = day; rec.done++; save('rules', rec); coins(ctx.S).spend(-15, null);
    SFX.play('thud', { delay: 0.12 }); SFX.play('success', { delay: 0.2 }); const b = card.getBoundingClientRect(); K.pop(b.left + b.width / 2, b.top + b.height * 0.4, '+15 coins', 'gold'); K.swell(); draw(true); };
  card.addEventListener('click', homework);
  const kd = (/** @type {KeyboardEvent} */ e) => {
    if (e.code === 'Digit1' || e.code === 'Numpad1') tryRead(0); else if (e.code === 'Digit2' || e.code === 'Numpad2') tryRead(1);
    else if (e.code === 'Enter') { e.preventDefault(); homework(); }
  };
  addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd));
  draw();
}
