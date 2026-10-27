// @ts-check
// Loot roll, rebuilt on the GX kit: a felt dice table under the tavern lamp. An item drops, you pick Need / Greed /
// Pass, three tavern NPCs roll d100 with real dice. Need beats Greed. Collection saved (tavern-loot, as before).
import { SFX } from '../sfx.js';
import { rng } from './util.js';
import { load, save, RARITY } from './tavern-ui.js';
import { gx, svg as S, GX } from './gx.js';

const ITEMS = ['Boots of Escaping Meetings', 'Helm of Merge Conflicts', 'Staff of Stack Overflow', 'Gloves of Ctrl+Z', 'Ring of the 10x Dev',
  'Amulet of Works On My Machine', 'Shoulderpads of Scope Creep', 'Belt of Tech Debt', 'Tome of Undocumented APIs', 'Dagger of Hotfix', 'Grog-Stained Tabard', 'Cloak of Dark Mode'];
const NPCS = [['Grumbold (dwarf)', 0.7], ['Shadowsneak (rogue)', 0.95], ['Healbot (priest)', 0.3]];
const DIE = ['#c9b48a', '#7a1f1f', '#26324a', '#2c4a2c'];

/** @param {any} ctx */
export function startLoot(ctx) {
  const ov = ctx.overlay({ title: 'Loot Roll', sub: 'dice table · something dropped!', help: '<kbd>N</kbd> need <kbd>G</kbd> greed <kbd>P</kbd> pass <kbd>space</kbd> next drop <kbd>click</kbd> buttons' });
  const K = gx(ov), reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const col = load('loot', { items: {}, rolls: 0 });
  const r = rng((Date.now() & 0xffff) + 7);
  const hud = K.hud([{ id: 'col', label: 'Collection', value: `${Object.keys(col.items).length} / ${ITEMS.length}`, tone: 'gold' }], [{ id: 'rolls', label: 'Rolls', value: col.rolls }]);
  const scene = K.scene({ aspect: 16 / 9 });
  const root = S('svg', { viewBox: '0 0 1600 900', width: '100%', height: '100%' }, scene); root.style.position = 'absolute'; root.style.inset = '0'; root.style.overflow = 'visible';
  root.innerHTML = `<defs>
    <filter id="tl-felt"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.25 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
    <filter id="tl-grain"><feTurbulence type="fractalNoise" baseFrequency="0.01 0.3" numOctaves="3" seed="9"/><feColorMatrix values="0 0 0 0 0.1  0 0 0 0 0.05  0 0 0 0 0.02  0 0 0 0.4 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
    <radialGradient id="tl-feltg" cx="0.5" cy="0.35" r="0.75"><stop offset="0" stop-color="#2f7a4a"/><stop offset="0.6" stop-color="#1d5434"/><stop offset="1" stop-color="#0e2c1b"/></radialGradient>
    <linearGradient id="tl-oak" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7a4a2a"/><stop offset="1" stop-color="#3e2312"/></linearGradient>
    <linearGradient id="tl-parch" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3e6c4"/><stop offset="1" stop-color="#d9c08e"/></linearGradient>
    <radialGradient id="tl-lamp" cx="0.5" cy="0.3" r="0.6"><stop offset="0" stop-color="#ffd29a" stop-opacity="0.22"/><stop offset="1" stop-color="#000" stop-opacity="0.35"/></radialGradient>
    <filter id="tl-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"/></filter></defs>
    <rect x="30" y="40" width="1540" height="840" rx="70" fill="#000" opacity="0.5" filter="url(#tl-soft)"/>
    <rect x="20" y="20" width="1560" height="840" rx="70" fill="url(#tl-oak)"/><rect x="20" y="20" width="1560" height="840" rx="70" fill="#000" filter="url(#tl-grain)"/>
    <rect x="70" y="70" width="1460" height="740" rx="40" fill="url(#tl-feltg)"/><rect x="70" y="70" width="1460" height="740" rx="40" fill="#000" filter="url(#tl-felt)"/>
    <rect x="70" y="70" width="1460" height="740" rx="40" fill="none" stroke="#000" stroke-opacity="0.5" stroke-width="6"/>
    <rect x="70" y="70" width="1460" height="740" rx="40" fill="url(#tl-lamp)"/>`;
  const item = S('g', {}, root);
  S('rect', { x: 508, y: 108, width: 600, height: 230, rx: 16, fill: '#000', opacity: 0.45, filter: 'url(#tl-soft)' }, item);
  S('rect', { x: 500, y: 100, width: 600, height: 220, rx: 14, fill: 'url(#tl-parch)' }, item);
  const rim = S('rect', { x: 512, y: 112, width: 576, height: 196, rx: 10, fill: 'none', 'stroke-width': 4 }, item);
  const T = (o, p) => S('text', { 'font-family': 'Sora', 'text-anchor': 'middle', ...o }, p);
  const rarT = T({ x: 800, y: 170, 'font-size': 24, 'font-weight': 700, 'letter-spacing': 3 }, item);
  const nameT = T({ x: 800, y: 230, 'font-size': 38, 'font-weight': 800, fill: '#3a2412' }, item);
  const statusT = T({ x: 800, y: 285, 'font-size': 22, 'font-weight': 500, fill: '#6b4a2a' }, item);
  const rows = [0, 1, 2, 3].map(i => {
    const y = 420 + i * 92, g = S('g', {}, root);
    const plate = S('rect', { x: 300, y: y - 36, width: 1000, height: 72, rx: 14, fill: '#000', opacity: 0.22 }, g);
    const who = S('text', { x: 330, y: y + 10, 'font-family': 'Sora', 'font-size': 28, 'font-weight': 600, fill: '#eef3ea' }, g);
    const kind = S('text', { x: 800, y: y + 10, 'font-family': 'Sora', 'font-size': 26, 'font-weight': 700, 'text-anchor': 'middle' }, g);
    const dice = [0, 1].map(j => { const d = S('g', { transform: `translate(${1140 + j * 80} ${y})` }, g);
      S('ellipse', { cx: 4, cy: 30, rx: 30, ry: 8, fill: '#000', opacity: 0.4, filter: 'url(#tl-soft)' }, d);
      const body = S('g', {}, d);
      S('path', { d: 'M0 -32 L30 -6 L18 28 L-18 28 L-30 -6 Z', fill: DIE[i], stroke: '#000', 'stroke-opacity': 0.4, 'stroke-width': 2 }, body);
      S('path', { d: 'M0 -32 L30 -6 L0 6 L-30 -6 Z', fill: '#fff', opacity: 0.18 }, body);
      const n = S('text', { y: 18, 'font-family': 'Sora', 'font-size': 24, 'font-weight': 800, 'text-anchor': 'middle', fill: i === 0 ? '#3a2412' : '#f3e6c4' }, body);
      return { d, body, n }; });
    return { g, plate, who, kind, dice };
  });
  const btns = document.createElement('div'); Object.assign(btns.style, { position: 'absolute', left: '0', right: '0', bottom: '6%', display: 'flex', justifyContent: 'center', gap: '12px' }); scene.appendChild(btns);
  const mk = (l, f, pri) => { const b = document.createElement('button'); b.className = 'gx-btn lg' + (pri ? ' pri' : ''); b.type = 'button'; b.innerHTML = l; b.onclick = f; btns.appendChild(b); return b; };
  let drop = /** @type {any} */ (null), playing = false, timers = /** @type {any[]} */ ([]);
  ov.onClose(() => timers.forEach(clearTimeout));
  const setButtons = () => { btns.replaceChildren();
    if (!playing || !drop) return;
    if (drop.phase === 'choose') { mk('Need <span class="gx-key">N</span>', () => choose('need'), true); mk('Greed <span class="gx-key">G</span>', () => choose('greed')); mk('Pass <span class="gx-key">P</span>', () => choose('pass')); }
    else if (drop.phase === 'done') mk('Next drop <span class="gx-key">Space</span>', newDrop, true); };
  const setDie = (dd, v, show) => { const s = show ? v % 100 : 0; dd.dice[0].n.textContent = String(Math.floor(s / 10) * 10).padStart(2, '0'); dd.dice[1].n.textContent = String(s % 10); };
  const render = () => {
    const [rn, rc] = RARITY[drop.rar];
    rarT.textContent = rn.toUpperCase(); rarT.setAttribute('fill', drop.rar === 1 ? '#6b4a2a' : rc); rim.setAttribute('stroke', drop.rar <= 1 ? '#a88a5a' : rc);
    nameT.textContent = drop.item;
    rows.forEach((row, i) => { const q = drop.rolls[i]; row.g.setAttribute('opacity', q && i < drop.shown ? '1' : drop.phase === 'choose' ? '0' : '0.35');
      row.who.textContent = q ? q.who : ''; row.kind.textContent = q ? (q.kind === 'pass' ? 'passed' : q.kind) : '';
      row.kind.setAttribute('fill', q?.kind === 'need' ? '#ff9a8a' : q?.kind === 'greed' ? GX.warning : '#a9b8a9');
      row.plate.setAttribute('fill', drop.phase === 'done' && i === drop.win ? (i === 0 ? GX.success : GX.error) : '#000'); row.plate.setAttribute('opacity', drop.phase === 'done' && i === drop.win ? '0.3' : '0.22');
      row.dice.forEach(d => d.d.style.display = q && q.kind !== 'pass' ? '' : 'none'); if (q) setDie(row, q.v, i < drop.shown); });
    statusT.textContent = drop.phase === 'choose' ? 'Need beats Greed. Ties go to whoever yells first.' : drop.phase === 'roll' ? 'Rolling…' : drop.win === 0 ? 'Loot get! It’s yours.' : drop.win < 0 ? 'Everyone passed. It rots.' : drop.rolls[drop.win].who + ' wins';
    setButtons();
  };
  const newDrop = () => { const rr = r(), rar = rr < 0.3 ? 0 : rr < 0.6 ? 2 : rr < 0.85 ? 3 : rr < 0.97 ? 4 : 5;
    drop = { item: ITEMS[Math.floor(r() * ITEMS.length)], rar, phase: 'choose', rolls: [], win: -1, shown: 0 }; SFX.play(rar >= 4 ? 'sparkle' : 'magic', { vol: 0.7 }); render(); };
  const choose = kind => { if (!drop || drop.phase !== 'choose') return;
    SFX.play(kind === 'need' ? 'dice' : kind === 'greed' ? 'tick' : 'ui.back');
    const me = kind === 'pass' ? null : { who: 'You', kind, v: 1 + Math.floor(r() * 100) };
    drop.rolls = NPCS.map(([who, greed]) => { const k = r() < Number(greed) * (drop.rar >= 3 ? 1 : 0.6) ? (r() < 0.5 ? 'need' : 'greed') : 'pass'; return { who, kind: k, v: k === 'pass' ? 0 : 1 + Math.floor(r() * 100) }; });
    if (me) drop.rolls.unshift(me); else drop.rolls.unshift({ who: 'You', kind: 'pass', v: 0 });
    const score = q => q.kind === 'need' ? 1000 + q.v : q.kind === 'greed' ? q.v : -1;
    let best = -1; drop.rolls.forEach((q, i) => { if (score(q) > (best < 0 ? -1 : score(drop.rolls[best]))) best = i; });
    drop.win = best >= 0 && score(drop.rolls[best]) >= 0 ? best : -1; drop.phase = 'roll';
    col.rolls++; if (drop.win === 0) { col.items[drop.item] = Math.max(col.items[drop.item] || 0, drop.rar); }
    save('loot', col); render();
    drop.rolls.forEach((q, i) => timers.push(setTimeout(() => { drop.shown = i + 1; if (q.kind !== 'pass') { SFX.play('dice', { vol: 0.5, pitch: 1 + i * 0.05 });
      if (!reduce) rows[i].dice.forEach((d, j) => d.body.animate([{ transform: `translate(${-60 - j * 30}px,-20px) rotate(-200deg)` }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.22,1,.36,1)' })); }
      render(); }, 400 + i * 450)));
    timers.push(setTimeout(finish, 400 + drop.rolls.length * 450));
  };
  const finish = () => { drop.phase = 'done'; render();
    SFX.play(drop.win === 0 ? 'win' : 'fail', { vol: drop.win === 0 ? 1 : 0.6 });
    const b = root.getBoundingClientRect();
    if (drop.win === 0) { K.swell(); K.pop(b.left + b.width / 2, b.top + b.height * 0.12, 'Loot get!', 'gold'); }
    hud.set('col', `${Object.keys(col.items).length} / ${ITEMS.length}`); hud.set('rolls', col.rolls); };
  const onKey = e => { if (!playing || !drop) return; const c = e.code;
    if (c === 'KeyN') choose('need'); else if (c === 'KeyG') choose('greed'); else if (c === 'KeyP') choose('pass'); else if (c === 'Space' && drop.phase === 'done') { e.preventDefault(); newDrop(); } };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  newDrop();
  K.card({ title: 'Loot Roll', text: 'Something dropped! Need beats Greed; highest roll wins.', how: [[['N'], 'need'], [['G'], 'greed'], [['P'], 'pass'], [['Space'], 'next drop']], cta: 'Roll for it', onGo: () => { playing = true; setButtons(); } });
}
