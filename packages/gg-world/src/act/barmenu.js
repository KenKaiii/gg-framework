// @ts-check
// 'bar-menu': a 2-page bar menu card (bar counter) and a 1-page cooler card (roof). Order with coins; Dex reacts,
// you get the right prop in hand, and a few drinks do something.
import { text, coins, loop } from './util.js';
import { holdProp } from '../rooms/props-hand.js';
import { DRINKS, BITES, COOLER, icon } from './barmenu-data.js';
import { startDarts } from './barmenu-darts.js';
import { SFX } from '../sfx.js';

const W = 480, H = 270;
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
  const me = S.me, dex = !cooler && S.dex?.agent, say = (a, t, s = 3) => S.ui?.bubble?.(a, t, s) ?? U?.bubble?.(a, t, s);
  if (dex) { dex.face = Math.atan2(me.pos.x - dex.pos.x, me.pos.z - dex.pos.z); dex.root.rotation.y = dex.face; try { dex.once('Interact', 1.6); } catch { /* anim missing */ } say(dex, item.say, 3.5); }
  else say(me, item.say, 3);
  try { me.once?.('Interact', 1.2); } catch { /* ignore */ }
  const at = me.pos, snd = cooler ? 'can' : /beer|ale|lager|soda|cola|fizz|tonic/i.test(item.name) ? 'fizz' : /fries|nacho|burger|toast|bite|snack|wing|pizza/i.test(item.name) ? 'ui.tap' : 'pour';
  SFX.play('register', { vol: 0.5, at }); SFX.play(snd, { delay: dex ? 0.4 : 0.1, at }); SFX.play('glass', { vol: 0.5, delay: dex ? 0.75 : 0.35, at });
  if (item.fx === 'red') SFX.play('eerie', { delay: 0.9, vol: 0.5 });
  if (item.fx === 'round') SFX.play('success', { delay: 0.9 });
  setTimeout(() => { holdProp(me.av, item.prop); }, dex ? 700 : 300);
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
  const pages = cooler ? [{ name: 'COOLER', items: COOLER }] : [{ name: 'DRINKS', items: DRINKS }, { name: 'BITES & SPECIALS', items: BITES }];
  const tab = S.barTab || (S.barTab = []);
  const ov = ctx.overlay({ title: cooler ? 'The Cooler' : 'The Terminal', sub: cooler ? 'roof bar cart, self service' : 'bar menu, ask Dex', help: `<kbd>&uarr;&darr;</kbd>pick ${cooler ? '' : '<kbd>&larr;&rarr;</kbd>page '}<kbd>enter</kbd>order <kbd>esc</kbd>leave` });
  const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const wal = coins(S);
  let page = 0, sel = 0, flip = 0, shake = 0, msg = '', msgT = 0, hover = -1, closed = false;
  ov.onClose(() => { closed = true; });
  const cols = 2, colW = 212, top = 74;
  const rowHOf = () => cooler ? 44 : items().length > 8 ? 30 : 36;
  const items = () => pages[page].items;
  const pos = i => { const n = items().length, per = Math.ceil(n / cols), col = Math.floor(i / per), row = i % per; return { x: 24 + col * (colW + 8), y: top + row * rowHOf() }; };
  const go = p => { if (p < 0 || p >= pages.length || p === page) return; page = p; sel = 0; flip = 1; SFX.play('page'); };
  const order = i => {
    const it = items()[i]; if (!it) return;
    if (wal.balance < it.price || !wal.spend(it.price, it.name)) { shake = 0.35; SFX.play('ui.deny'); msg = BROKE[(tab.length + i) % BROKE.length]; msgT = 2.5; return; }
    tab.push({ name: it.name, price: it.price }); ov.close(); serve(S, U, it, cooler);
  };
  const tabs = () => pages.map((p, i) => ({ i, x: 24 + i * 140, w: 132, y: 44, h: 18 }));
  const onKey = e => {
    if (closed) return; const n = items().length, per = Math.ceil(n / cols);
    if (e.code === 'ArrowDown') { sel = (sel + 1) % n; SFX.play('ui.select'); } else if (e.code === 'ArrowUp') { sel = (sel + n - 1) % n; SFX.play('ui.select'); }
    else if (e.code === 'ArrowRight') { if (sel + per < n && !cooler && page === pages.length - 1) sel += per; else if (page < pages.length - 1) go(page + 1); else if (sel + per < n) sel += per; }
    else if (e.code === 'ArrowLeft') { if (sel >= per) sel -= per; else go(page - 1); }
    else if (e.code === 'Enter' || e.code === 'Space') order(sel); else return;
    e.preventDefault(); e.stopPropagation();
  };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  const local = e => { const b = c.getBoundingClientRect(); return { mx: (e.clientX - b.left) * W / b.width, my: (e.clientY - b.top) * H / b.height }; };
  const hit = (mx, my) => items().findIndex((_, i) => { const p = pos(i); return mx >= p.x - 4 && mx < p.x + colW && my >= p.y - 4 && my < p.y + rowHOf() - 4; });
  c.addEventListener('mousemove', e => { const { mx, my } = local(e); hover = hit(mx, my); if (hover >= 0) sel = hover; c.style.cursor = hover >= 0 || tabs().some(t => mx >= t.x && mx < t.x + t.w && my >= t.y && my < t.y + t.h) ? 'pointer' : ''; });
  c.addEventListener('mouseleave', () => { hover = -1; });
  c.addEventListener('click', e => { const { mx, my } = local(e); const t = tabs().find(t => mx >= t.x && mx < t.x + t.w && my >= t.y && my < t.y + t.h); if (t) return go(t.i); const i = hit(mx, my); if (i >= 0) order(i); });

  loop(ov, (dt, t) => {
    flip = Math.max(0, flip - dt * 4); shake = Math.max(0, shake - dt); msgT = Math.max(0, msgT - dt);
    const sx = shake ? Math.round(Math.sin(t * 80) * 3 * shake / 0.35) : 0;
    x.setTransform(1, 0, 0, 1, sx, 0);
    // leather card
    x.fillStyle = '#17110f'; x.fillRect(-4, 0, W + 8, H);
    x.fillStyle = '#241a16'; x.fillRect(6, 6, W - 12, H - 12);
    for (let i = 0; i < 260; i++) { const a = (i * 7919) % (W - 16), b = (i * 104729) % (H - 16); x.fillStyle = i % 3 ? 'rgba(0,0,0,.18)' : 'rgba(255,220,180,.04)'; x.fillRect(8 + a, 8 + b, 2, 1); }
    x.strokeStyle = '#7a5a2e'; x.lineWidth = 1; x.strokeRect(10.5, 10.5, W - 21, H - 21);
    x.strokeStyle = '#3a2a18'; x.strokeRect(13.5, 13.5, W - 27, H - 27);
    for (const [a, b] of [[10, 10], [W - 14, 10], [10, H - 14], [W - 14, H - 14]]) { x.fillStyle = '#e0a458'; x.fillRect(a, b, 4, 4); }
    // header
    text(x, cooler ? 'THE COOLER' : 'THE TERMINAL', 24, 36, { title: true, size: 32, color: '#e0a458', shadow: '#3a2410' });
    text(x, cooler ? 'honour system. mostly.' : 'est. localhost', W - 24, 22, { align: 'right', color: '#8e7a5e' });
    const blink = Math.sin(t * 6) > 0 ? '#ffb36b' : '#e0a458';
    x.fillStyle = blink; x.fillRect(W - 120, 28, 6, 6); x.fillStyle = '#7a4a22'; x.fillRect(W - 119, 29, 4, 4);
    text(x, `${wal.balance} coins`, W - 24, 36, { align: 'right', color: '#ffd08a' });
    // tabs
    for (const tb of tabs()) {
      const on = tb.i === page; x.fillStyle = on ? '#3a2a1c' : '#1c1512'; x.fillRect(tb.x, tb.y, tb.w, tb.h);
      x.fillStyle = on ? '#e0a458' : '#4a3a28'; x.fillRect(tb.x, tb.y + tb.h - 2, tb.w, 2);
      text(x, pages[tb.i].name, tb.x + tb.w / 2, tb.y + 13, { align: 'center', color: on ? '#ffd08a' : '#8e7a5e' });
    }
    if (!cooler) text(x, `${page + 1}/2  \u2190 \u2192`, W - 24, 57, { align: 'right', color: '#6b5a44' });
    x.fillStyle = '#4a3a28'; x.fillRect(24, 66, W - 48, 1);
    // items (slide in on page flip)
    const off = Math.round(flip * flip * 40);
    x.globalAlpha = 1 - flip * 0.8;
    items().forEach((it, i) => {
      const p = pos(i), px = p.x + off, py = p.y, can = wal.balance >= it.price, isSel = i === sel;
      if (isSel) { x.fillStyle = can ? 'rgba(224,164,88,.14)' : 'rgba(200,56,44,.12)'; x.fillRect(px - 4, py - 4, colW, rowHOf() - 4); x.fillStyle = can ? '#e0a458' : '#c8382c'; x.fillRect(px - 4, py - 4, 2, rowHOf() - 4); }
      x.globalAlpha = (1 - flip * 0.8) * (can ? 1 : 0.45);
      icon(x, it.icon, px, py + (isSel ? Math.round(Math.sin(t * 8)) : 0), it.tint);
      text(x, it.name, px + 22, py + 11, { color: isSel ? '#fff1d6' : '#e8d8b8' });
      text(x, it.desc, px + 22, py + 24, { color: '#8e7a5e' });
      x.fillStyle = '#ffd08a'; x.fillRect(px + colW - 30, py + 4, 5, 5); x.fillStyle = '#b07a30'; x.fillRect(px + colW - 29, py + 5, 3, 3);
      text(x, String(it.price), px + colW - 12, py + 11, { align: 'right', color: can ? '#ffd08a' : '#c8382c' });
      x.globalAlpha = 1 - flip * 0.8;
    });
    x.globalAlpha = 1;
    // footer: tab on page 2, else hint
    const fy = H - 46;
    x.fillStyle = '#4a3a28'; x.fillRect(24, fy, W - 48, 1);
    if (page === 1 || cooler) {
      const total = tab.reduce((s, o) => s + o.price, 0);
      const last = tab.slice(-3).map(o => o.name).join(', ');
      text(x, "TONIGHT'S TAB", 24, fy + 16, { title: true, color: '#e0a458' });
      text(x, tab.length ? `${tab.length} item${tab.length > 1 ? 's' : ''}: ${last}${tab.length > 3 ? '...' : ''}` : "empty. suspiciously sober.", 144, fy + 16, { color: '#c8b898' });
      text(x, `${total} coins`, W - 24, fy + 16, { align: 'right', color: '#ffd08a' });
    } else text(x, 'all drinks served with a side of judgement', W / 2, fy + 16, { align: 'center', color: '#6b5a44' });
    const line = msgT ? msg : (wal.balance < items()[sel]?.price ? "can't afford that one. dex saw." : '');
    if (line) text(x, line, W / 2, fy + 30, { align: 'center', color: '#ff6b5a' });
    else text(x, 'enter / click to order', W / 2, fy + 30, { align: 'center', color: '#5a4a36' });
    x.setTransform(1, 0, 0, 1, 0, 0);
  });
}

export default [
  { id: 'bar-menu', label: () => 'Order a drink', match: (it, R) => R?.id === 'bar' && it?.id === 'order', start: ctx => openMenu(ctx, false) },
  { id: 'cooler-menu', label: () => 'Grab a beer', match: (it, R) => R?.id === 'roof' && it?.id === 'cooler', start: ctx => openMenu(ctx, true) },
  { id: 'bar-darts', label: () => 'Throw darts', match: (it, R) => R?.id === 'bar' && it?.id === 'dartboard', start: startDarts },
];
