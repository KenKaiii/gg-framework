// @ts-check
// Wardrobe / shop (C). XP -> level -> coins. Items have prices + level locks; owned items are free to switch.
import { portrait } from './portrait.js';
import { saveSoon } from './bridge.js';

const ITEMS = {
  body: [['rogue', 'Hoodie', 0, 1], ['knight', 'Jacket', 0, 1], ['mage', 'Robe', 250, 15], ['barbarian', 'Vest', 400, 30]],
  head: [['rogue', 'Messy', 0, 1], ['knight', 'Swept', 0, 1], ['mage', 'Long', 120, 5], ['barbarian', 'Shaggy', 200, 12], ['hooded', 'Hood', 300, 20]],
  acc: [['none', 'None', 0, 1], ['glasses', 'Glasses', 0, 1], ['headphones', 'Headphones', 150, 5], ['wizard', 'Wizard hat', 450, 30], ['fur', 'Fur hat', 300, 25]],
  silly: [['cone', 'Traffic cone', 80, 3], ['tinfoil', 'Tinfoil hat', 120, 8], ['clown', 'Clown nose', 60, 2], ['moustache', 'Giant moustache', 200, 15], ['duck', 'Rubber duck', 350, 25], ['sunglasses', 'Night shades', 150, 10], ['cape', 'Cape of Prod', 500, 40], ['shades', 'Round black shades', 150, 10], ['coat', 'Long dark coat', 400, 25]],
};
const COL = {
  skin: ['#f9dcc4', '#f2c6a0', '#e0ac69', '#c68a5e', '#8d5a3b', '#5c3a24', '#7ed957', '#6ec6ff', '#c77dff'],
  hair: ['#1a1a1a', '#5a3825', '#d4a373', '#f4f1de', '#c1121f', '#ffafcc', '#7bdff2', '#9d4edd'],
  top: ['#15161b', '#23262e', '#2d3a2e', '#3a2a34', '#4a2c2a', '#1e2240', '#2a2440'],
  bottom: ['#111216', '#1b1b2f', '#2b2d42', '#2a2440', '#3a2a24', '#263228'],
  accColor: ['#111111', '#3ddc84', '#e0a458', '#b04fd8', '#2d3a2e'],
};
const WEIRD_SKIN = new Set(['#7ed957', '#6ec6ff', '#c77dff']);
const NAMES = { body: 'Outfit', head: 'Hair style', acc: 'Headwear', silly: 'Ridiculous props', skin: 'Skin tone (weird ones 100c)', hair: 'Hair colour', top: 'Top colour', bottom: 'Bottom colour', accColor: 'Accessory colour' };

/** Wallet persisted in localStorage. */
export function wallet(S) {
  if (!S.wallet) { let w = null; try { w = JSON.parse(localStorage.getItem('night-rooms-wallet') || 'null'); } catch { /* ignore */ } S.wallet = w && typeof w.spent === 'number' ? w : { spent: 0, owned: [] }; }
  const W = S.wallet; const coins = () => S.player.level * 80 - W.spent;
  return { get coins() { return coins(); }, owns: id => W.owned.includes(id), spend(n, id) { if (n > 0 && coins() < n) return false; W.spent += n; if (id) W.owned.push(id); saveSoon(S); try { localStorage.setItem('night-rooms-wallet', JSON.stringify(W)); } catch { /* ignore */ } return true; } };
}

export function openCreator(S, root, done) {
  const el = document.createElement('div'); el.className = 'card modal creator'; el.style.display = 'block'; root.appendChild(el);
  const look = { ...S.player.look, silly: [...(S.player.look.silly || [])], scale: { head: 1, width: 1, height: 1, ...(S.player.look.scale || {}) } };
  const wl = wallet(S); const lvl = S.player.level; let name = S.player.name;
  const priceOf = (k, v) => { const it = ITEMS[k]?.find(i => i[0] === v); if (it) return it[2]; if (k === 'skin' && WEIRD_SKIN.has(v)) return 100; return 0; };
  const lockOf = (k, v) => ITEMS[k]?.find(i => i[0] === v)?.[3] || 1;
  const owned = (k, v) => priceOf(k, v) === 0 || wl.owns(k + ':' + v);
  const cart = () => { const ids = []; for (const k of ['body', 'head', 'acc', 'skin']) if (!owned(k, look[k])) ids.push([k, look[k]]); for (const s of look.silly) if (!owned('silly', s)) ids.push(['silly', s]); return ids; };
  const total = () => cart().reduce((a, [k, v]) => a + priceOf(k, v), 0);
  const tag = (k, v) => { if (lockOf(k, v) > lvl) return `<small>Lv ${lockOf(k, v)}</small>`; if (!owned(k, v)) return `<small>${priceOf(k, v)}c</small>`; return ''; };
  const render = () => {
    let html = `<h3>Wardrobe</h3><div class="sub"><b>${wl.coins}c</b> | Lv ${lvl} | coins = level x 80 - spent</div><div style="display:flex;gap:10px;align-items:center"><div class="portrait"><img src="${portrait(S.A, look)}"></div><div style="flex:1"><label>Name</label><input id="cn" maxlength="14" value="${name.replace(/"/g, '')}" ></div></div>`;
    for (const k of ['body', 'head', 'acc', 'silly']) html += `<label>${NAMES[k]}</label><div class="opts">${ITEMS[k].map(([v, n]) => { const on = k === 'silly' ? look.silly.includes(v) : look[k] === v; const lk = lockOf(k, v) > lvl; return `<button class="opt ${on ? 'on' : ''}" ${lk ? 'disabled style="opacity:.45;filter:grayscale(1)"' : ''} data-k="${k}" data-v="${v}">${n} ${tag(k, v)}</button>`; }).join('')}</div>`;
    for (const k of ['skin', 'hair', 'top', 'bottom', 'accColor']) html += `<label>${NAMES[k]}</label><div class="opts">${COL[k].map(c => `<button class="sw ${look[k] === c ? 'on' : ''}" style="background:${c}" data-k="${k}" data-v="${c}"></button>`).join('')}</div>`;
    html += `<label>Proportions (free, regret included)</label>${[['head', 'Head size', 0.7, 1.8], ['width', 'Body width', 0.75, 1.5], ['height', 'Height', 0.75, 1.3]].map(([k, n, a, b]) => `<div style="display:flex;align-items:center;gap:8px;line-height:16px"><span style="width:96px">${n}</span><input type="range" min="${a}" max="${b}" step="0.05" value="${look.scale[k]}" data-s="${k}" style="flex:1;accent-color:#6ee7a0"></div>`).join('')}`;
    const t = total();
    html += `<div class="btns"><button class="btn" data-x="cancel">Cancel</button><button class="btn p" data-x="save" ${t > wl.coins ? 'disabled style="opacity:.5"' : ''}>${t ? `Buy & wear | ${t}c` : 'Save look'}</button></div>`;
    el.innerHTML = html;
    const nm = /** @type {HTMLInputElement} */ (el.querySelector('#cn')); nm.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') done(); }); nm.addEventListener('input', () => { name = nm.value; });
    el.querySelectorAll('[data-k]').forEach(b => b.addEventListener('click', () => { const B = /** @type {HTMLElement} */ (b); const k = B.dataset.k || '', v = B.dataset.v;
      if (k === 'silly') { const i = look.silly.indexOf(v); if (i >= 0) look.silly.splice(i, 1); else look.silly.push(v); } else look[k] = v;
      S.me.av.setLook(look); render(); }));
    el.querySelectorAll('[data-s]').forEach(b => b.addEventListener('input', () => { const B = /** @type {HTMLInputElement} */ (b); look.scale[B.dataset.s || ''] = +B.value; S.me.av.setLook(look); }));
    el.querySelectorAll('[data-s]').forEach(b => b.addEventListener('change', render));
    el.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', () => {
      if (/** @type {HTMLElement} */ (b).dataset.x === 'save') {
        for (const [k, v] of cart()) wl.spend(priceOf(k, v), k + ':' + v);
        S.player.look = look; S.player.name = (name.trim() || 'You').slice(0, 14); S.player.namedHere = !!name.trim(); saveSoon(S); try { localStorage.setItem('night-rooms-look', JSON.stringify({ ...look, name: S.player.name })); } catch { /* ignore */ } S.me.av.fx.wave = 1.5;
      } else S.me.av.setLook(S.player.look);
      done();
    }));
  };
  render(); return el;
}
