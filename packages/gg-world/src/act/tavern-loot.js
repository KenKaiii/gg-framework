// @ts-check
// Loot roll: an item drops, you pick Need / Greed / Pass, three tavern NPCs roll d100. Need beats Greed. Collection saved.
import { SFX } from '../sfx.js';
import { loop, text, rng } from './util.js';
import { panel, backdrop, button, onClick, onKey, hit, load, save, pops, lootCard, RARITY, INK, GOLDC } from './tavern-ui.js';

const ITEMS = ['Boots of Escaping Meetings', 'Helm of Merge Conflicts', 'Staff of Stack Overflow', 'Gloves of Ctrl+Z', 'Ring of the 10x Dev',
  'Amulet of Works On My Machine', 'Shoulderpads of Scope Creep', 'Belt of Tech Debt', 'Tome of Undocumented APIs', 'Dagger of Hotfix', 'Grog-Stained Tabard', 'Cloak of Dark Mode'];
const NPCS = [['Grumbold (dwarf)', 0.7], ['Shadowsneak (rogue)', 0.95], ['Healbot (priest)', 0.3]];

/** @param {any} ctx */
export function startLoot(ctx) {
  const ov = ctx.overlay({ title: 'Loot Roll', sub: 'dice table · something dropped!', help: '<kbd>N</kbd> need <kbd>G</kbd> greed <kbd>P</kbd> pass <kbd>space</kbd> next drop <kbd>click</kbd> buttons <kbd>esc</kbd> leave' });
  const W = 480, H = 270; const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const col = load('loot', { items: {}, rolls: 0 });
  const r = rng((Date.now() & 0xffff) + 7); const P = pops();
  let t = 0, drop = null, b = {};
  const newDrop = () => { const rr = r(), rar = rr < 0.3 ? 0 : rr < 0.6 ? 2 : rr < 0.85 ? 3 : rr < 0.97 ? 4 : 5;
    drop = { item: ITEMS[Math.floor(r() * ITEMS.length)], rar, phase: 'choose', t: 0, rolls: [], win: -1, shown: 0 }; SFX.play(rar >= 4 ? 'sparkle' : 'magic', { vol: 0.7 }); };
  const choose = kind => { if (!drop || drop.phase !== 'choose') return;
    SFX.play(kind === 'need' ? 'dice' : kind === 'greed' ? 'tick' : 'ui.back');
    const me = kind === 'pass' ? null : { who: 'You', kind, v: 1 + Math.floor(r() * 100) };
    drop.rolls = NPCS.map(([who, greed]) => { const k = r() < greed * (drop.rar >= 3 ? 1 : 0.6) ? (r() < 0.5 ? 'need' : 'greed') : 'pass'; return { who, kind: k, v: k === 'pass' ? 0 : 1 + Math.floor(r() * 100) }; });
    if (me) drop.rolls.unshift(me); else drop.rolls.unshift({ who: 'You', kind: 'pass', v: 0 });
    const score = q => q.kind === 'need' ? 1000 + q.v : q.kind === 'greed' ? q.v : -1;
    let best = -1; drop.rolls.forEach((q, i) => { if (score(q) > (best < 0 ? -1 : score(drop.rolls[best]))) best = i; });
    drop.win = best >= 0 && score(drop.rolls[best]) >= 0 ? best : -1; drop.phase = 'roll'; drop.t = 0;
    col.rolls++; if (drop.win === 0) { col.items[drop.item] = Math.max(col.items[drop.item] || 0, drop.rar); }
    save('loot', col); };
  newDrop();
  onKey(ov, code => { if (code === 'KeyN') choose('need'); else if (code === 'KeyG') choose('greed'); else if (code === 'KeyP') choose('pass'); else if (code === 'Space' && drop.phase === 'done') newDrop(); });
  onClick(ov, c, W, H, (px, py) => { for (const k of ['need', 'greed', 'pass']) if (hit(b[k], px, py)) choose(k); if (hit(b.next, px, py) && drop.phase === 'done') newDrop(); });
  loop(ov, dt => {
    t += dt; drop.t += dt; backdrop(x, W, H, t);
    lootCard(x, W, 150, drop.item, drop.rar, Math.min(1, drop.t * 3 + (drop.phase === 'choose' ? 0 : 1)));
    if (drop.phase === 'choose') { const k = 1 + Math.sin(t * 6) * 0.04;
      b.need = button(x, 'Need (dice)', 92, 120, 92, 24, { on: true }); b.greed = button(x, 'Greed (coin)', 194, 120, 92, 24); b.pass = button(x, 'Pass', 296, 120, 92, 24);
      text(x, 'Need beats Greed. Ties go to whoever yells first.', W / 2, 165 * k / k, { color: '#c8a878', align: 'center' }); }
    else { panel(x, 110, 112, 260, 96);
      drop.rolls.forEach((q, i) => { const show = drop.t > 0.4 + i * 0.45, y = 130 + i * 20; if (show && i >= drop.shown) { drop.shown = i + 1; if (q.kind !== 'pass') SFX.play('dice', { vol: 0.5, pitch: 1 + i * 0.05 }); } const spin = 1 + Math.floor((t * 37 + i * 13) % 100);
        text(x, q.who, 120, y, { color: INK }); text(x, q.kind === 'pass' ? 'passed' : q.kind, 270, y, { color: q.kind === 'need' ? '#a8302a' : '#5a5a2a' });
        text(x, q.kind === 'pass' ? '-' : String(show ? q.v : spin), 360, y, { color: show && i === drop.win && drop.phase === 'done' ? '#1a8a1a' : INK, align: 'right' }); });
      if (drop.phase === 'roll' && drop.t > 0.4 + drop.rolls.length * 0.45) { drop.phase = 'done'; drop.t2 = 0;
        SFX.play(drop.win === 0 ? 'win' : 'fail', { vol: drop.win === 0 ? 1 : 0.6 });
        if (drop.win === 0) P.add('LOOT GET!', W / 2, 34, RARITY[drop.rar][1]); else P.add(drop.win < 0 ? 'Everyone passed. It rots.' : drop.rolls[drop.win].who + ' wins', W / 2, 34, '#ff8a6a'); }
      if (drop.phase === 'done') { b.next = button(x, 'Next drop (space)', 170, 218, 140, 24, { on: true });
        if (drop.win === 0) { x.fillStyle = `rgba(255,210,58,${Math.max(0, 0.4 - (drop.t2 = (drop.t2 || 0) + dt))})`; x.fillRect(0, 0, W, H); } } }
    const have = Object.values(col.items); const by = RARITY.map((_, i) => have.filter(v => v === i).length);
    text(x, `Collection ${have.length}/${ITEMS.length}`, 12, 260, { color: GOLDC });
    RARITY.forEach(([n, cc], i) => { if (i === 1) return; text(x, `${by[i]}`, 150 + i * 40, 260, { color: cc }); x.fillStyle = cc; x.fillRect(140 + i * 40, 252, 6, 6); });
    text(x, `rolls: ${col.rolls}`, 468, 260, { color: '#8a7a6a', align: 'right' });
    P.draw(x, dt);
  });
}
