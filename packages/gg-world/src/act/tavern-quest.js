// @ts-check
// Quest board: 3 date-seeded daily quests (coding chores as MMO quests). Accept, check in progress, turn in for coins + loot.
import { SFX } from '../sfx.js';
import { loop, text, coins } from './util.js';
import { panel, backdrop, button, onClick, onKey, hit, load, save, today, pops, lootCard, RARITY, INK, GOLDC } from './tavern-ui.js';

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

/** @param {any} ctx */
export function startQuests(ctx) {
  const ov = ctx.overlay({ title: 'Quest Log', sub: 'The Prancing Murloc · daily quests', help: '<kbd>↑↓</kbd> pick <kbd>enter</kbd> accept / check in / turn in <kbd>click</kbd> pick / button <kbd>esc</kbd> leave' });
  const W = 480, H = 270; const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const { key, r } = today(); const idx = [...POOL.keys()].sort((a, b) => ((a * 7 + key.length) % 3) - ((b * 7) % 3) || r() - 0.5).slice(0, 3);
  const quests = idx.map(i => POOL[i]);
  let st = load('quests', null); if (!st || st.day !== key) st = { day: key, q: [0, 1, 2].map(() => ({ s: 'new', n: 0 })) };
  let sel = 0, t = 0, loot = null; const P = pops(); const btns = [];
  const act = i => { const q = st.q[i], [, , need] = quests[i];
    if (q.s === 'new') { q.s = 'on'; SFX.play('paper'); SFX.play('chime', { delay: 0.15, vol: 0.6 }); P.add('Quest accepted!', 330, 200, GOLDC); }
    else if (q.s === 'on' && q.n < need) { q.n++; P.add(`${q.n}/${need}`, 330, 200, '#1eff00'); SFX.play('tick'); if (q.n >= need) { P.add('Complete!', 330, 180, GOLDC); SFX.play('success', { delay: 0.1 }); } }
    else if (q.s === 'done') SFX.play('ui.deny', { vol: 0.5 });
    else if (q.s === 'on') { q.s = 'done'; const rar = 1 + Math.floor(r() * 3 + i * 0.6) % 5, gold = 10 + rar * 10; coins(ctx.S).spend(-gold);
      loot = { item: LOOT[(i + key.length + rar) % LOOT.length], rar, t: 0 }; SFX.play('levelup', { delay: 0.1 }); SFX.play('sparkle', { delay: 0.4 }); P.add(`+${gold} coins`, 330, 200, GOLDC); }
    save('quests', st); };
  onKey(ov, code => { if (loot && loot.t > 0.4 && /Enter|Space/.test(code)) { loot = null; SFX.play('ui.click'); return; }
    if (code === 'ArrowUp') { sel = (sel + 2) % 3; SFX.play('ui.select'); } else if (code === 'ArrowDown') { sel = (sel + 1) % 3; SFX.play('ui.select'); } else if (code === 'Enter' || code === 'Space') act(sel); });
  onClick(ov, c, W, H, (px, py) => { if (loot) { loot = null; return; } btns.forEach((b, i) => { if (hit(b.row, px, py) && sel !== i) { sel = i; SFX.play('ui.select'); } if (hit(b.btn, px, py)) { sel = i; act(i); } }); });
  // mouse hover picks a quest row (click already picks / presses the button)
  const mv = e => { if (loot) return; const b = c.getBoundingClientRect(), px = (e.clientX - b.left) * W / b.width, py = (e.clientY - b.top) * H / b.height; btns.forEach((bb, i) => { if (hit(bb.row, px, py) && sel !== i) { sel = i; SFX.play('ui.select'); } }); };
  c.addEventListener('pointermove', mv); ov.onClose(() => c.removeEventListener('pointermove', mv));
  loop(ov, dt => {
    t += dt; backdrop(x, W, H, t);
    panel(x, 16, 22, 196, 230); panel(x, 232, 22, 232, 230);
    text(x, 'Daily Quests', 114, 44, { title: true, color: INK, align: 'center' });
    quests.forEach(([name], i) => { const q = st.q[i], y = 62 + i * 58, on = i === sel;
      x.fillStyle = on ? 'rgba(168,48,42,0.18)' : 'rgba(0,0,0,0.04)'; x.fillRect(22, y, 184, 50);
      const mark = q.s === 'new' ? '!' : q.s === 'on' ? (q.n >= quests[i][2] ? '?' : '…') : '✓';
      text(x, mark, 34, y + 30 + Math.sin(t * 4 + i) * (q.s === 'new' ? 2 : 0), { size: 32, color: q.s === 'done' ? '#6a8a4a' : GOLDC, align: 'center', shadow: '#5a3a10' });
      text(x, name, 52, y + 22, { color: q.s === 'done' ? '#8a7a6a' : INK }); text(x, q.s === 'new' ? 'available' : q.s === 'done' ? 'turned in' : `${q.n}/${quests[i][2]}`, 52, y + 40, { color: '#7a5a3a' });
      btns[i] = { row: { x: 22, y, w: 184, h: 50 }, btn: btns[i]?.btn }; });
    const [name, desc, need] = quests[sel], q = st.q[sel];
    text(x, name, 348, 46, { title: true, color: INK, align: 'center' });
    const words = desc.split(' '); let line = '', ly = 72; for (const w of words) { if ((line + w).length > 30) { text(x, line, 244, ly, { color: INK }); ly += 16; line = ''; } line += w + ' '; } text(x, line, 244, ly, { color: INK });
    text(x, 'Rewards:', 244, 140, { color: '#7a3a1a' }); text(x, '20-50 coins + a loot drop', 244, 156, { color: INK });
    x.fillStyle = '#c8b488'; x.fillRect(244, 170, 208, 8); x.fillStyle = '#4aa83a'; x.fillRect(244, 170, 208 * Math.min(1, q.n / need), 8);
    const lab = q.s === 'new' ? 'Accept' : q.s === 'done' ? 'Done for today' : q.n >= need ? 'Turn in' : 'Check in (+1)';
    btns[sel].btn = button(x, lab, 288, 196, 120, 26, { on: q.s !== 'done', dim: q.s === 'done' });
    text(x, 'self-reported. the Elder trusts you.', 348, 240, { color: '#9a7a5a', align: 'center' });
    if (!loot) P.draw(x, dt);
    if (loot) { loot.t += dt; x.fillStyle = 'rgba(10,6,4,0.82)'; x.fillRect(0, 0, W, H); lootCard(x, W, H, loot.item, loot.rar, Math.min(1, loot.t * 3));
      text(x, 'Click or Enter to continue', W / 2, H / 2 + 60, { color: '#c8a878', align: 'center' }); text(x, 'You receive loot:', W / 2, H / 2 - 50, { color: RARITY[loot.rar][1], align: 'center', shadow: '#000' }); }
  });
}
