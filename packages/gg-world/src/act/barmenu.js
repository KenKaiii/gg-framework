// @ts-check
// 'bar-menu': a 2-page bar menu card (bar counter) and a 1-page cooler card (roof). Order with coins; Dex reacts,
// you get the right prop in hand, and a few drinks do something.
import { coins } from './util.js';
import { gx } from './gx.js';
import { holdProp } from '../rooms/props-hand.js';
import { DRINKS, BITES, COOLER } from './barmenu-data.js';
import { startDarts } from './barmenu-darts.js';
import { SFX } from '../sfx.js';
import { startDrink } from '../tipsy.js';

const BROKE = ['card declined. dex is judging you.', 'not enough coins. ship something first.', 'tab says no. tab says go code.', 'you can afford water. from the tap.'];

/** Remove any held prop from an avatar. @param {any} av */
function dropProps(av) { holdProp(av, null); }

/** Brief green tint over the whole screen (red pill). */
function greenTint() {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:0;z-index:35;pointer-events:none;background:radial-gradient(ellipse at center,rgba(61,220,132,.18),rgba(20,80,40,.45));mix-blend-mode:screen;transition:opacity 0.6s;opacity:1';
  document.body.appendChild(d); setTimeout(() => { d.style.opacity = '0'; }, 1600); setTimeout(() => d.remove(), 2300);
}

/** Apply an order in the world after the menu closed. */
function serve(S, U, item, cooler) {
  const me = S.me, dex = !cooler && S.dex?.agent, say = (a, t, s = 3) => { const B = S.ui?.bubble || U?.bubble; B?.(a, t, s); }; // once (bubble() returns nothing, so `a() ?? b()` said every line twice)
  if (dex) { dex.face = Math.atan2(me.pos.x - dex.pos.x, me.pos.z - dex.pos.z); dex.root.rotation.y = dex.face; try { dex.once('Interact', 1.6); } catch { /* anim missing */ } say(dex, item.say, 3.5); }
  else say(me, item.say, 3);
  try { me.once?.('Interact', 1.2); } catch { /* ignore */ }
  const at = me.pos, snd = cooler ? 'can' : /beer|ale|lager|soda|cola|fizz|tonic/i.test(item.name) ? 'fizz' : /fries|nacho|burger|toast|bite|snack|wing|pizza/i.test(item.name) ? 'ui.tap' : 'pour';
  SFX.play('register', { vol: 0.5, at }); SFX.play(snd, { delay: dex ? 0.4 : 0.1, at }); SFX.play('glass', { vol: 0.5, delay: dex ? 0.75 : 0.35, at });
  if (item.fx === 'red') SFX.play('eerie', { delay: 0.9, vol: 0.5 });
  if (item.fx === 'round') SFX.play('success', { delay: 0.9 });
  setTimeout(() => { holdProp(me.av, item.prop); startDrink(S, item.id, item.prop, p => holdProp(me.av, p)); }, dex ? 700 : 300);
  if (item.fx === 'red') { setTimeout(greenTint, 900); setTimeout(() => say(me, 'whoa.', 2.5), 1600); }
  if (item.fx === 'blue') setTimeout(() => say(me, 'nothing happened. comfy.', 3), 1800);
  if (item.fx === 'round') {
    const inBar = (S.members || []).filter(m => m.agent?.root?.parent === S.rooms.bar.root);
    inBar.forEach((m, i) => setTimeout(() => { try { m.agent.once('Cheer', 2); } catch { /* ignore */ } say(m.agent, i % 3 ? 'shots!' : 'SHOTS!', 2.5); }, 900 + i * 180));
    setTimeout(() => { try { me.once?.('Cheer', 2); } catch { /* ignore */ } say(me, 'shots!', 2.5); }, 900);
    U?.feed?.(`${S.player?.name || 'you'} bought a round for the bar. legend.`);
  }
}

/** @param {any} ctx @param {boolean} cooler */
function openMenu(ctx, cooler) {
  const { S, U } = ctx;
  const pages = cooler ? [{ name: 'Cooler', items: COOLER }] : [{ name: 'Drinks', items: DRINKS }, { name: 'Bites & specials', items: BITES }];
  const tab = S.barTab || (S.barTab = []);
  const ov = ctx.overlay({ title: cooler ? 'The Cooler' : 'The Terminal', sub: cooler ? 'roof bar cart, self service' : 'bar menu, ask Dex', help: `<kbd>&uarr;&darr;</kbd>pick ${cooler ? '' : '<kbd>&larr;&rarr;</kbd>page '}<kbd>enter</kbd>order` });
  const K = gx(ov), wal = coins(S);
  const hud = K.hud([{ id: 'coins', label: 'Coins', value: wal.balance, tone: 'gold' }], [{ id: 'tab', label: 'Tonight\'s tab', value: tab.reduce((s, o) => s + o.price, 0) }]);
  const scene = K.scene({ aspect: cooler ? 1.05 : 1.45, maxW: 980 });
  let page = 0, sel = 0, closed = false;
  ov.onClose(() => { closed = true; });
  const st = document.createElement('style'); st.textContent = `
.bm{position:absolute;inset:0;border-radius:22px;padding:2.2%;background:${cooler ? 'linear-gradient(160deg,#6d757e,#3b4148 60%,#2a2e33)' : 'linear-gradient(160deg,#5a2f1b,#3a1d10 55%,#26130a)'};box-shadow:inset 0 1px 0 rgba(255,255,255,.18),inset 0 0 0 2px rgba(0,0,0,.35),0 30px 60px -20px rgba(0,0,0,.85)}
.bm::before{content:'';position:absolute;inset:0;border-radius:inherit;opacity:.35;mix-blend-mode:overlay;background:repeating-linear-gradient(${cooler ? '90deg,#fff 0 1px,transparent 1px 3px' : '2deg,#000 0 2px,transparent 2px 7px'})}
.bm .pp{position:relative;height:100%;box-sizing:border-box;border-radius:8px;padding:3.2cqh 4cqw;display:flex;flex-direction:column;color:#2b1a0e;background:radial-gradient(ellipse at 50% 20%,#fbf3df,#efe0bd 70%,#e2cc9e);box-shadow:inset 0 0 0 1px rgba(90,58,34,.35),inset 0 0 40px rgba(120,80,30,.25),0 4px 10px rgba(0,0,0,.4)}
.bm .pp::after{content:'';position:absolute;inset:10px;border:1px solid rgba(120,70,30,.4);border-radius:4px;pointer-events:none}
.bm header{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;border-bottom:1px solid rgba(90,58,34,.4);padding-bottom:1.6cqh}
.bm h1{margin:0;font:800 clamp(20px,6cqh,46px)/1 Sora;letter-spacing:-.02em;color:#9b3a16}
.bm .tag{font:500 clamp(11px,2.3cqh,15px)/1.3 Sora;color:#7a5a3a;margin-top:4px}
.bm .tabs{display:flex;gap:6px}
.bm .tabs button{all:unset;cursor:pointer;padding:6px 12px;border-radius:999px;font:600 clamp(11px,2.2cqh,14px)/1.2 Sora;color:#7a5a3a;background:rgba(120,70,30,.12)}
.bm .tabs button.on{background:#9b3a16;color:#fbf3df}
.bm ul{list-style:none;margin:1.6cqh 0 0;padding:0;flex:1;display:grid;grid-template-columns:${cooler ? 'minmax(0,1fr)' : 'minmax(0,1fr) minmax(0,1fr)'};grid-auto-flow:column;grid-template-rows:repeat(var(--rows),1fr);column-gap:3cqw;min-height:0}
.bm li{display:flex;align-items:center;gap:8px;padding:0 8px;border-radius:8px;cursor:pointer;min-height:0;min-width:0;overflow:hidden;transition:background-color .15s}
.bm li .t{flex:1;min-width:0}
.bm li b{display:block;font:700 clamp(12px,2.6cqh,17px)/1.2 Sora;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bm li small{display:block;font:400 clamp(10px,2cqh,13px)/1.25 Sora;color:#7a5a3a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bm li .dot{width:12px;height:12px;border-radius:50%;flex:none;box-shadow:inset 0 -2px 3px rgba(0,0,0,.3)}
.bm li .pr{flex:none;display:inline-flex;align-items:center;gap:5px;font:700 clamp(12px,2.5cqh,16px)/1 Sora;color:#9b3a16;font-variant-numeric:tabular-nums}
.bm li .pr i{width:.9em;height:.9em;border-radius:50%;background:radial-gradient(circle at 35% 30%,#ffe9a8,#e0a632 60%,#9a6a14);box-shadow:0 1px 1px rgba(0,0,0,.3)}
.bm li .ob{all:unset;flex:none;font:600 11px/1 Sora;padding:5px 9px;border-radius:6px;background:#2b1a0e;color:#fbf3df;display:none}
.bm li.sel{background:rgba(240,170,80,.3)}.bm li.sel .ob{display:inline-block}.bm li.sel .pr{display:none}
.bm li.no{opacity:.45}.bm li.no.sel{background:rgba(200,56,44,.15)}
.bm footer{display:flex;justify-content:space-between;gap:12px;border-top:1px solid rgba(90,58,34,.4);padding-top:1.4cqh;font:500 clamp(11px,2.1cqh,14px)/1.3 Sora;color:#7a5a3a}
.bm footer .m{color:#c0392b;font-weight:600}
.bm.shake{animation:bm-sh .35s}@keyframes bm-sh{25%{translate:-6px}75%{translate:6px}}
@media (prefers-reduced-motion: reduce){.bm.shake{animation:none}}`;
  ov.el.appendChild(st);
  const card = document.createElement('div'); card.className = 'bm';
  card.innerHTML = `<div class="pp"><header><div><h1>${cooler ? 'The Cooler' : 'The Terminal'}</h1><div class="tag">${cooler ? 'Honour system. Mostly.' : 'Est. localhost'}</div></div><div class="tabs"></div></header><ul></ul><footer><span class="f"></span><span class="m"></span></footer></div>`;
  scene.appendChild(card);
  const ul = /** @type {HTMLElement} */ (card.querySelector('ul')), tabsEl = /** @type {HTMLElement} */ (card.querySelector('.tabs'));
  const foot = /** @type {HTMLElement} */ (card.querySelector('.f')), msgEl = /** @type {HTMLElement} */ (card.querySelector('.m'));
  const items = () => pages[page].items;
  const per = () => cooler ? items().length : Math.ceil(items().length / 2);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] || c);
  let msgTimer = 0;
  const say = m => { msgEl.textContent = m; clearTimeout(msgTimer); msgTimer = /** @type {any} */ (setTimeout(() => { msgEl.textContent = ''; }, 2500)); };
  const mark = () => [...ul.children].forEach((li, i) => li.classList.toggle('sel', i === sel));
  const render = () => {
    tabsEl.innerHTML = cooler ? '' : pages.map((p, i) => `<button type="button" class="${i === page ? 'on' : ''}">${esc(p.name)}</button>`).join('');
    [...tabsEl.children].forEach((b, i) => b.addEventListener('click', () => go(i)));
    ul.style.setProperty('--rows', String(per()));
    ul.innerHTML = items().map(it => `<li class="${wal.balance >= it.price ? '' : 'no'}"><span class="dot" style="background:${it.tint || '#c0803a'}"></span><span class="t"><b>${esc(it.name)}</b><small>${esc(it.desc)}</small></span><span class="pr">${it.price}<i></i></span><button class="ob" type="button" tabindex="-1">Order</button></li>`).join('');
    [...ul.children].forEach((li, i) => { li.addEventListener('mouseenter', () => { sel = i; mark(); }); li.addEventListener('click', () => order(i)); });
    const total = tab.reduce((s, o) => s + o.price, 0);
    foot.textContent = page === 1 || cooler ? (tab.length ? `Tab: ${tab.length} (${tab.slice(-2).map(o => o.name).join(', ')}${tab.length > 2 ? '...' : ''}), ${total} coins` : 'Tab: empty. Suspiciously sober.') : 'All drinks served with a side of judgement.';
    mark();
  };
  const go = p => { if (p < 0 || p >= pages.length || p === page) return; page = p; sel = 0; SFX.play('page'); render(); };
  const order = i => {
    const it = items()[i]; if (!it) return;
    if (wal.balance < it.price || !wal.spend(it.price, it.name)) { card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); SFX.play('ui.deny'); say(BROKE[(tab.length + i) % BROKE.length]); return; }
    tab.push({ name: it.name, price: it.price }); hud.set('coins', wal.balance); ov.close(); serve(S, U, it, cooler);
  };
  const onKey = e => {
    if (closed) return; const n = items().length, pp = per();
    if (e.code === 'ArrowDown') { sel = (sel + 1) % n; SFX.play('ui.select'); } else if (e.code === 'ArrowUp') { sel = (sel + n - 1) % n; SFX.play('ui.select'); }
    else if (e.code === 'ArrowRight') { if (sel + pp < n && !cooler && page === pages.length - 1) sel += pp; else if (page < pages.length - 1) return go(page + 1), e.preventDefault(); else if (sel + pp < n) sel += pp; }
    else if (e.code === 'ArrowLeft') { if (sel >= pp && !cooler) sel -= pp; else return go(page - 1), e.preventDefault(); }
    else if (e.code === 'Enter' || e.code === 'Space') order(sel); else return;
    e.preventDefault(); e.stopPropagation(); mark();
    if (wal.balance < (items()[sel]?.price ?? 0)) say("Can't afford that one. Dex saw.");
  };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  render();
}

export default [
  { id: 'bar-menu', label: () => 'Order a drink', match: (it, R) => R?.id === 'bar' && it?.id === 'order', start: ctx => openMenu(ctx, false) },
  { id: 'cooler-menu', label: () => 'Grab a beer', match: (it, R) => R?.id === 'roof' && it?.id === 'cooler', start: ctx => openMenu(ctx, true) },
  { id: 'bar-darts', label: () => 'Throw darts', match: (it, R) => R?.id === 'bar' && it?.id === 'dartboard', start: startDarts },
];
