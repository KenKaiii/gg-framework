// @ts-check
// Quest board (GX kit): a cork board in an oak frame with three pinned parchment notes. 3 date-seeded daily quests (coding chores as MMO quests). Accept, check in progress, turn in for coins + loot.
import { SFX } from '../sfx.js';
import { coins } from './util.js';
import { load, save, today, RARITY } from './tavern-ui.js';
import { gx } from './gx.js';

const POOL = [
  ['Slay the Bugs', 'Squash 3 bugs in the Forest of Legacy Code.', 3],
  ['Return to the Elder', 'Bring a pull request to the Elder Reviewer.', 1],
  ['Tame the Linter', 'Silence 5 angry linter warnings.', 5],
  ['Commit to the Cause', 'Push 4 commits before the candles burn out.', 4],
  ['The Lost Semicolon', 'Find the semicolon the gnomes stole.', 1],
  ['Deploy at Dusk', 'Ship 1 deploy. Not on a Friday. Probably.', 1],
  ['Prompt Whisperer', 'Send 6 prompts to the oracle in the tower.', 6],
  ['Clear the Backlog Crypt', 'Close 2 ancient tickets.', 2],
  ['Test of Courage', 'Write 3 tests before the boss pull.', 3],
];
const LOOT = ['Rubber Duck of Debugging', 'Mug of Infinite Coffee', 'Hoodie of Night Shifts', 'Sword of a Thousand Merges', 'Cloak of Dark Mode', 'Keyboard of the Old Gods'];

const CSS = `
.tq-board{position:absolute;inset:0;border-radius:18px;padding:3.2cqw;box-sizing:border-box;background:linear-gradient(#7a4a2a,#4a2a16);box-shadow:inset 0 2px 0 rgba(255,220,180,.25),0 30px 60px -20px rgba(0,0,0,.8)}
.tq-cork{position:relative;width:100%;height:100%;border-radius:8px;display:flex;gap:2.6cqw;align-items:center;justify-content:center;padding:0 3cqw;box-sizing:border-box;
 background:radial-gradient(ellipse at 50% 25%,rgba(255,210,154,.28),transparent 65%),url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.75' numOctaves='3'/%3E%3CfeColorMatrix values='0 0 0 0 .25 0 0 0 0 .14 0 0 0 0 .05 0 0 0 .9 0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E"),#b98a55;box-shadow:inset 0 0 0 3px rgba(0,0,0,.35),inset 0 10px 30px rgba(0,0,0,.45)}
.tq-note{position:relative;flex:1;max-width:30%;height:78%;padding:3.4cqw 1.8cqw 1.6cqw;box-sizing:border-box;cursor:pointer;color:#3a2412;display:flex;flex-direction:column;
 background:linear-gradient(160deg,#f6ead0,#e2cc9c 70%,#d4b880);box-shadow:0 14px 22px -10px rgba(0,0,0,.7),inset 0 0 30px rgba(140,90,40,.25);transition:transform .25s cubic-bezier(.22,1,.36,1),box-shadow .25s}
.tq-note::before{content:"";position:absolute;top:1.1cqw;left:50%;width:1.6cqw;height:1.6cqw;margin-left:-.8cqw;border-radius:50%;background:radial-gradient(circle at 35% 30%,#ff9a8a,#b8261c 60%,#6a1008);box-shadow:0 3px 4px rgba(0,0,0,.5)}
.tq-note.sel{transform:translateY(-1.2cqw) rotate(0deg)!important;box-shadow:0 26px 32px -12px rgba(0,0,0,.75),0 0 0 3px #ffd29a,inset 0 0 30px rgba(140,90,40,.25)}
.tq-note.done{filter:saturate(.5) brightness(.85)}
.tq-note .m{font-size:3.4cqw;line-height:1;font-weight:800;color:#c98a10}.tq-note.done .m{color:#5a7a3a}
.tq-note h3{margin:.8cqw 0 0;font-size:1.9cqw;line-height:1.2;font-weight:800}
.tq-note p{margin:.8cqw 0 0;font-size:1.3cqw;line-height:1.45;color:#5a3a1e}
.tq-note .st{margin-top:auto;font-size:1.15cqw;font-weight:700;color:#7a3a1a}
.tq-note .bar{height:.7cqw;margin:.6cqw 0 1cqw;border-radius:9px;background:rgba(90,60,30,.25);overflow:hidden}.tq-note .bar i{display:block;height:100%;background:#4aa83a;transition:width .4s}
.tq-note .gx-btn{width:100%;font-size:max(11px,1.25cqw)}
`;

/** @param {any} ctx */
export function startQuests(ctx) {
  const ov = ctx.overlay({ title: 'Quest Log', sub: 'The Prancing Murloc · daily quests', help: '<kbd>↑↓</kbd> pick <kbd>enter</kbd> accept / check in / turn in <kbd>click</kbd> pick / button' });
  const K = gx(ov);
  if (!document.getElementById('tq-style')) { const s = document.createElement('style'); s.id = 'tq-style'; s.textContent = CSS; document.head.appendChild(s); }
  const { key, r } = today(); const idx = [...POOL.keys()].sort((a, b) => ((a * 7 + key.length) % 3) - ((b * 7) % 3) || r() - 0.5).slice(0, 3);
  const quests = idx.map(i => POOL[i]);
  let st = load('quests', null); if (!st || st.day !== key) st = { day: key, q: [0, 1, 2].map(() => ({ s: 'new', n: 0 })) };
  let sel = 0, playing = false, loot = /** @type {any} */ (null);
  const doneN = () => st.q.filter(q => q.s === 'done').length;
  const hud = K.hud([{ id: 'done', label: 'Turned in', value: `${doneN()} / 3`, tone: 'gold' }], [{ id: 'day', label: 'Today', value: key.slice(5) }]);
  const scene = K.scene({ aspect: 16 / 9, maxW: 1200 });
  const board = document.createElement('div'); board.className = 'tq-board'; board.innerHTML = '<div class="tq-cork"></div>'; scene.appendChild(board);
  const cork = /** @type {HTMLElement} */ (board.firstChild);
  const notes = quests.map(([name, desc], i) => { const n = document.createElement('div'); n.className = 'tq-note'; n.style.transform = `rotate(${[-2.2, 1.4, -1][i]}deg)`;
    n.innerHTML = `<div class="m"></div><h3></h3><p></p><div class="st"></div><div class="bar"><i></i></div><button class="gx-btn pri" type="button"></button>`;
    /** @type {HTMLElement} */ (n.querySelector('h3')).textContent = name; /** @type {HTMLElement} */ (n.querySelector('p')).textContent = desc + ' Reward: 20-50 coins + a loot drop.';
    n.addEventListener('pointerenter', () => { if (playing && !loot && sel !== i) { sel = i; SFX.play('ui.select'); draw(); } });
    n.addEventListener('click', e => { if (!playing || loot) return; if (sel !== i) { sel = i; SFX.play('ui.select'); draw(); } if (/** @type {HTMLElement} */ (e.target).closest('.gx-btn')) act(i, n); });
    cork.appendChild(n); return n; });
  const draw = () => notes.forEach((n, i) => { const q = st.q[i], need = quests[i][2];
    n.classList.toggle('sel', i === sel && playing); n.classList.toggle('done', q.s === 'done');
    /** @type {HTMLElement} */ (n.querySelector('.m')).textContent = q.s === 'new' ? '!' : q.s === 'on' ? (q.n >= need ? '?' : '…') : '✓';
    /** @type {HTMLElement} */ (n.querySelector('.st')).textContent = q.s === 'new' ? 'Available' : q.s === 'done' ? 'Turned in' : `${q.n} / ${need}`;
    /** @type {HTMLElement} */ (n.querySelector('.bar i')).style.width = `${Math.min(1, q.n / need) * 100}%`;
    const b = /** @type {HTMLButtonElement} */ (n.querySelector('.gx-btn')); b.textContent = q.s === 'new' ? 'Accept' : q.s === 'done' ? 'Done for today' : q.n >= need ? 'Turn in' : 'Check in (+1)';
    b.classList.toggle('pri', q.s !== 'done'); });
  const at = (n, dy = 0) => { const b = n.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height * 0.4 + dy]; };
  const act = (i, n = notes[i]) => { const q = st.q[i], [, , need] = quests[i];
    if (q.s === 'new') { q.s = 'on'; SFX.play('paper'); SFX.play('chime', { delay: 0.15, vol: 0.6 }); K.pop(...at(n), 'Quest accepted!', 'gold'); }
    else if (q.s === 'on' && q.n < need) { q.n++; K.pop(...at(n), `${q.n}/${need}`, 'up'); SFX.play('tick'); if (q.n >= need) { K.pop(...at(n, -30), 'Complete!', 'gold'); SFX.play('success', { delay: 0.1 }); } }
    else if (q.s === 'done') SFX.play('ui.deny', { vol: 0.5 });
    else if (q.s === 'on') { q.s = 'done'; const rar = 1 + Math.floor(r() * 3 + i * 0.6) % 5, gold = 10 + rar * 10; coins(ctx.S).spend(-gold);
      loot = { item: LOOT[(i + key.length + rar) % LOOT.length], rar }; SFX.play('levelup', { delay: 0.1 }); SFX.play('sparkle', { delay: 0.4 }); K.swell();
      K.result({ title: 'You receive loot', big: loot.item, line: `${RARITY[rar][0]} · +${gold} coins`, stats: [[`+${gold}`, 'Coins'], [RARITY[rar][0], 'Rarity']], again: 'Continue', onAgain: () => { loot = null; } });
      const big = /** @type {HTMLElement | null} */ (ov.el.querySelector('.gx-card .big')); if (big) { big.style.fontSize = '26px'; big.style.letterSpacing = '-.01em'; big.style.color = RARITY[rar][1] === '#ffffff' ? '' : RARITY[rar][1]; } }
    save('quests', st); hud.set('done', `${doneN()} / 3`); draw(); };
  const onKey = e => { if (!playing || loot) return;
    if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') { sel = (sel + 2) % 3; SFX.play('ui.select'); draw(); } else if (e.code === 'ArrowDown' || e.code === 'ArrowRight') { sel = (sel + 1) % 3; SFX.play('ui.select'); draw(); }
    else if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); act(sel); } };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  draw();
  K.card({ title: 'Quest Board', text: 'Three daily quests from the Elder. Accept, check in as you go, turn in for coins + loot.', how: [[['↑', '↓'], 'pick'], [['Enter'], 'accept / check in / turn in'], [['Click'], 'a note']], cta: 'Read the board', onGo: () => { playing = true; draw(); } });
}
