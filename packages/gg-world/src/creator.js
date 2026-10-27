// @ts-check
// Wardrobe / shop (C). XP -> level -> coins. Items have prices + level locks; owned items are free to switch.
// Layout copied from the usual game "locker": live full-body preview on the left, category tabs on the right, each tab
// a fixed-height grid of tiles; Randomise / Undo / Reset / Save along the bottom.
import { saveSoon } from './bridge.js';
import { findProblem } from './chat-guard.js';
/** Set once the first-visit wardrobe has been saved (or the player already had a name / an online save). */
export const FIRST_KEY = 'night-rooms-setup';

/** The same name rules as the World server (gg-royale shared avatar.ts nameProblem), plus no links or ads. '' = fine. */
const RESERVED = ['bot', 'the bug', 'bug', 'dealer', 'the dealer', 'house', 'the house', 'admin', 'administrator', 'mod', 'moderator', 'staff', 'support', 'gg', 'gg coder', 'gg royale', 'system', 'server', 'you', 'player', 'anonymous'];
/** @param {unknown} raw */
export function nameProblem(raw) {
  const n = String(raw || '').trim(), lo = n.toLowerCase();
  if (!n) return 'Pick a name first';
  if (n.length < 3) return 'At least 3 characters';
  if (n.length > 14) return 'Up to 14 characters';
  if (!/^[A-Za-z0-9 ]+$/.test(n)) return 'Letters, numbers and one space only';
  if ((n.match(/ /g) || []).length > 1) return 'Only one space';
  if (!/[A-Za-z]/.test(n)) return 'Needs at least one letter';
  if (/(.)\1{3}/i.test(n.replace(/ /g, ''))) return 'Try another name'; // "aaaaaa", "xxxxx
  if (RESERVED.includes(lo) || lo.startsWith('bot ') || lo.startsWith('gg ')) return 'That name is reserved. Try another';
  if (findProblem(n)) return 'Try another name';
  return '';
}
import { makePreview } from './creator-preview.js';

const ITEMS = {
  body: [['rogue', 'Hoodie', 0, 1], ['knight', 'Jacket', 0, 1], ['mage', 'Robe', 250, 15], ['barbarian', 'Vest', 400, 30]],
  head: [['rogue', 'Messy', 0, 1], ['knight', 'Swept', 0, 1], ['mage', 'Long', 0, 1], ['barbarian', 'Shaggy', 200, 12], ['hooded', 'Hood', 300, 20]],
  acc: [['none', 'None', 0, 1], ['glasses', 'Glasses', 0, 1], ['headphones', 'Headphones', 150, 5], ['wizard', 'Wizard hat', 450, 30], ['fur', 'Fur hat', 300, 25], ['helmet', 'Helmet', 350, 20]],
  silly: [['cone', 'Traffic cone', 80, 3], ['tinfoil', 'Tinfoil hat', 120, 8], ['clown', 'Clown nose', 60, 2], ['moustache', 'Giant moustache', 200, 15], ['duck', 'Rubber duck', 350, 25], ['sunglasses', 'Night shades', 150, 10], ['cape', 'Cape of Prod', 500, 40], ['shades', 'Round shades', 150, 10], ['coat', 'Long dark coat', 400, 25]],
};
const COL = {
  skin: ['#f9dcc4', '#f2c6a0', '#e0ac69', '#c68a5e', '#8d5a3b', '#5c3a24', '#7ed957', '#6ec6ff', '#c77dff'],
  hair: ['#1a1a1a', '#5a3825', '#925240', '#d4a373', '#f4f1de', '#c1121f', '#ffafcc', '#7bdff2', '#9d4edd'],
  top: ['#15161b', '#23262e', '#2b2d42', '#6fa8dc', '#2d3a2e', '#3a2a34', '#4a2c2a', '#1e2240', '#2a2440', '#c1121f', '#e0a458', '#f4f1de'],
  bottom: ['#111216', '#1b1b2f', '#2b2d42', '#4a4e69', '#2a2440', '#3a2a24', '#263228', '#5a5f6b'],
  accColor: ['#111111', '#3ddc84', '#e0a458', '#b04fd8', '#f28b82', '#6fa8dc', '#f4f1de', '#2d3a2e'],
};
const WEIRD_SKIN = new Set(['#7ed957', '#6ec6ff', '#c77dff']);
/** Gender presets: pick the body model, default hair and proportions; everything stays free to mix afterwards. */
const GENDER = [
  ['masc', 'Masc', { body: 'knight', head: 'knight', scale: { head: 1, width: 1.1, height: 1.04 } }],
  ['fem', 'Fem', { body: 'rogue', head: 'mage', scale: { head: 1.05, width: 0.88, height: 0.97 } }],
  ['neutral', 'Neutral', { body: 'rogue', head: 'rogue', scale: { head: 1, width: 1, height: 1 } }],
];
const TABS = [['body', 'Body'], ['hair', 'Hair'], ['outfit', 'Outfit'], ['gear', 'Gear'], ['fun', 'Fun']];
const SLIDERS = [['height', 'Height', 0.8, 1.25], ['width', 'Build', 0.8, 1.35], ['head', 'Head size', 0.8, 1.6]];

/** Wallet persisted in localStorage. */
export function wallet(S) {
  if (!S.wallet) { let w = null; try { w = JSON.parse(localStorage.getItem('night-rooms-wallet') || 'null'); } catch { /* ignore */ } S.wallet = w && typeof w.spent === 'number' ? w : { spent: 0, owned: [] }; }
  const W = S.wallet; const coins = () => S.player.level * 80 - W.spent;
  return { get coins() { return coins(); }, owns: id => W.owned.includes(id), spend(n, id) { if (W.owned.includes(id)) return true; if (n > 0 && coins() < n) return false; W.spent += n; if (id) W.owned.push(id); saveSoon(S); try { localStorage.setItem('night-rooms-wallet', JSON.stringify(W)); } catch { /* ignore */ } return true; } };
}

const clone = l => ({ ...l, silly: [...(l.silly || [])], scale: { head: 1, width: 1, height: 1, ...(l.scale || {}) } });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] || c);
const tabMem = { cur: 'body' };

/** @param {any} S @param {HTMLElement} root @param {() => void} done @param {{ first?: boolean }} [o] first visit: welcome + a name is needed */
export function openCreator(S, root, done, o = {}) {
  const el = document.createElement('div'); el.className = 'card modal creator' + (o.first ? ' first' : ''); el.style.display = 'flex'; root.appendChild(el);
  const saved = clone(S.player.look); let look = clone(saved); const hist = [];
  const wl = wallet(S); const lvl = S.player.level; let name = S.player.namedHere ? S.player.name : (o.first && S.player.appName) || '';
  const priceOf = (k, v) => { const it = ITEMS[k]?.find(i => i[0] === v); if (it) return it[2]; if (k === 'skin' && WEIRD_SKIN.has(v)) return 100; return 0; };
  const lockOf = (k, v) => ITEMS[k]?.find(i => i[0] === v)?.[3] || 1;
  const wearing = (k, v) => k === 'silly' ? saved.silly.includes(v) : saved[k] === v; // already worn (e.g. the default headphones): never charged
  const owned = (k, v) => priceOf(k, v) === 0 || wl.owns(k + ':' + v) || wearing(k, v);
  const cart = () => { const ids = []; for (const k of ['body', 'head', 'acc', 'skin']) if (!owned(k, look[k])) ids.push([k, look[k]]); for (const s of look.silly) if (!owned('silly', s)) ids.push(['silly', s]); return ids; };
  const total = () => cart().reduce((a, [k, v]) => a + priceOf(k, v), 0);

  el.innerHTML = `<div class="cl"><div class="cpw"></div><input id="cn" maxlength="14" placeholder="Your name" aria-label="Name" aria-describedby="cnhint" autocomplete="off" spellcheck="false"><div class="cnhint" id="cnhint" aria-live="polite"></div></div>
    <div class="cr"><div class="chd"><h3>${o.first ? 'Welcome to World' : 'Wardrobe'}</h3><span class="coins"></span></div>${o.first ? '<p class="cfirst">Pick a name and a look. You can change them any time in the wardrobe (C).</p>' : ''}<div class="ctabs" role="tablist">${TABS.map(([k, n]) => `<button class="ctab" role="tab" data-t="${k}">${n}</button>`).join('')}</div>
    <div class="cpane"></div><div class="cft"><button class="btn" data-x="rand">Randomise</button><button class="btn" data-x="undo">Undo</button><button class="btn" data-x="reset">Reset</button>${o.first ? '' : '<button class="btn" data-x="cancel">Cancel</button>'}<button class="btn p" data-x="save"></button></div></div>`;
  const pv = makePreview(S.A, look, /** @type {HTMLElement} */ (el.querySelector('.cpw')));
  const pane = /** @type {HTMLElement} */ (el.querySelector('.cpane'));
  const nm = /** @type {HTMLInputElement} */ (el.querySelector('#cn')); nm.value = name;
  const hint = /** @type {HTMLElement} */ (el.querySelector('#cnhint'));
  /** Under the name box: what the name still needs (3-14 letters/numbers, one space), or a tick once it's fine. */
  const showHint = () => { const n = nm.value.trim(); const np = n ? nameProblem(n) : '';
    hint.textContent = !n ? (o.first ? '3 to 14 letters or numbers, one space' : '') : np || `${n.length}/14`; hint.classList.toggle('bad', !!np && n.length > 0); hint.classList.toggle('ok', !!n && !np); };
  showHint();
  nm.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') cancel(); if (e.key === 'Enter') nm.blur(); }); nm.addEventListener('input', () => { let v = nm.value.replace(/[^A-Za-z0-9 ]/g, '').replace(/^ +/, '').replace(/ {2,}/g, ' '); const sp = v.indexOf(' '); if (sp >= 0) v = v.slice(0, sp + 1) + v.slice(sp + 1).replace(/ /g, ''); v = v.slice(0, 14); if (v !== nm.value) nm.value = v; name = nm.value; showHint(); });

  const tile = (k, v, n, on) => { const lk = lockOf(k, v) > lvl; const tag = lk ? `<small class="lk">Lv ${lockOf(k, v)}</small>` : !owned(k, v) ? `<small>${priceOf(k, v)}c</small>` : owned(k, v) && priceOf(k, v) ? '<small class="own">owned</small>' : '';
    return `<button class="ct ${on ? 'on' : ''}" ${lk ? 'disabled' : ''} data-k="${k}" data-v="${v}"><span>${esc(n)}</span>${tag}</button>`; };
  const items = k => `<div class="cgrid">${ITEMS[k].map(([v, n]) => tile(k, v, n, k === 'silly' ? look.silly.includes(v) : look[k] === v)).join('')}</div>`;
  const sw = k => `<div class="cswg">${COL[k].map(c => `<button class="csw ${look[k] === c ? 'on' : ''}" style="background:${c}" data-k="${k}" data-v="${c}" aria-label="${c}">${k === 'skin' && WEIRD_SKIN.has(c) && !owned('skin', c) ? '<small>100c</small>' : ''}</button>`).join('')}</div>`;
  const h4 = t => `<h4>${t}</h4>`;
  const PANES = {
    body: () => h4('Body type') + `<div class="cgrid">${GENDER.map(([g, n]) => `<button class="ct ${look.gender === g ? 'on' : ''}" data-g="${g}"><span>${n}</span></button>`).join('')}</div>` + h4('Skin tone') + sw('skin')
      + h4('Proportions') + SLIDERS.map(([k, n, a, b]) => `<div class="csl"><span>${n}</span><input type="range" min="${a}" max="${b}" step="0.01" value="${look.scale[k]}" data-s="${k}"></div>`).join(''),
    hair: () => h4('Style') + items('head') + h4('Colour') + sw('hair'),
    outfit: () => h4('Outfit') + items('body') + h4('Top colour') + sw('top') + h4('Bottom colour') + sw('bottom'),
    gear: () => h4('Headwear') + items('acc') + h4('Colour') + sw('accColor'),
    fun: () => h4('Ridiculous props (stack them)') + items('silly'),
  };
  const change = fn => { hist.push(clone(look)); if (hist.length > 50) hist.shift(); fn(); pv.set(look); render(); };
  const render = () => {
    el.querySelectorAll('.ctab').forEach(b => { const on = /** @type {HTMLElement} */ (b).dataset.t === tabMem.cur; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    const st = pane.scrollTop; pane.innerHTML = PANES[tabMem.cur](); pane.scrollTop = st;
    /** @type {HTMLElement} */ (el.querySelector('.coins')).innerHTML = `<b>${wl.coins}c</b> · Lv ${lvl}`;
    const t = total(), sv = /** @type {HTMLButtonElement} */ (el.querySelector('[data-x=save]')); sv.textContent = t ? `Buy & wear · ${t}c` : 'Save'; sv.disabled = t > wl.coins;
    /** @type {HTMLButtonElement} */ (el.querySelector('[data-x=undo]')).disabled = !hist.length;
  };
  el.addEventListener('click', e => {
    const b = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('button')); if (!b || !el.contains(b) || /** @type {HTMLButtonElement} */ (b).disabled) return;
    const d = b.dataset;
    if (d.t) { tabMem.cur = d.t; pane.scrollTop = 0; render(); return; }
    if (d.g) { const p = /** @type {any} */ (GENDER.find(x => x[0] === d.g))[2]; change(() => { look.gender = d.g; look.body = p.body; look.head = p.head; look.scale = { ...p.scale }; }); return; }
    if (d.k) { const k = d.k, v = d.v || ''; change(() => { if (k === 'silly') { const i = look.silly.indexOf(v); if (i >= 0) look.silly.splice(i, 1); else if (look.silly.length < 4) look.silly.push(v); } else look[k] = v; }); return; }
    if (d.x === 'undo') { const p = hist.pop(); if (p) { look = p; pv.set(look); render(); } }
    else if (d.x === 'reset') change(() => { look = clone(saved); });
    else if (d.x === 'rand') change(() => {
      const pick = a => a[Math.floor(Math.random() * a.length)]; const ok = k => ITEMS[k].filter(([v, , , lv]) => lv <= lvl && owned(k, v)).map(i => i[0]);
      const g = pick(GENDER); look.gender = g[0]; look.scale = { ...g[2].scale };
      look.body = pick(ok('body')); look.head = pick(ok('head')); look.acc = pick(ok('acc'));
      look.skin = pick(COL.skin.filter(c => owned('skin', c))); look.hair = pick(COL.hair); look.top = pick(COL.top); look.bottom = pick(COL.bottom); look.accColor = pick(COL.accColor);
      look.silly = Math.random() < 0.3 ? [pick(ok('silly'))].filter(Boolean) : [];
    });
    else if (d.x === 'cancel') cancel();
    else if (d.x === 'save') save();
  });
  el.addEventListener('input', e => { const B = /** @type {HTMLInputElement} */ (e.target); if (!B.dataset?.s) return; look.scale[B.dataset.s] = +B.value; pv.set(look); });
  el.addEventListener('pointerdown', e => { const B = /** @type {HTMLInputElement} */ (e.target); if (B.dataset?.s) { hist.push(clone(look)); render(); } });
  function cancel() { if (o.first) return; /* the first visit ends with a name */ S.me.av.setLook(S.player.look); done(); }
  function save() {
    if (total() > wl.coins) return;
    // the name first, before anything is paid for: a bad name keeps the wardrobe open so it can be fixed
    const n = name.trim().replace(/\s+/g, ' ').slice(0, 14), np = n ? nameProblem(n) : o.first ? 'Pick a name first' : '';
    if (np) { S.ui?.toast?.(np); nm.focus(); return; }
    for (const [k, v] of cart()) wl.spend(priceOf(k, v), k + ':' + v);
    for (const k of ['body', 'head', 'acc', 'skin']) if (priceOf(k, saved[k]) > 0) wl.spend(0, k + ':' + saved[k]); for (const v of saved.silly || []) if (priceOf('silly', v) > 0) wl.spend(0, 'silly:' + v); /* already-worn items become owned, never charged later */
    const L = clone(look); for (const k of ['head', 'width', 'height']) L.scale[k] = Math.min(2, Math.max(0.5, Math.round(L.scale[k] * 100) / 100));
    S.player.look = L; S.player.namedHere = !!n; S.player.name = n || S.player.name || 'You';
    S.me.av.setLook(L); S.me.av.fx.wave = 1.5;
    try { localStorage.setItem('night-rooms-look', JSON.stringify({ ...L, name: n || undefined })); } catch { /* ignore */ }
    try { localStorage.setItem(FIRST_KEY, '1'); } catch { /* storage off */ }
    saveSoon(S); S.ui?.refreshHud?.(); S.ui?.toast?.(o.first ? `Welcome, ${S.player.name}` : 'Look saved'); done();
  }
  render(); return el;
}
