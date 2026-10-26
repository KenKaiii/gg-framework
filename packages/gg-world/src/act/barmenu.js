// @ts-check
// 'bar-menu': a 2-page bar menu card (bar counter) and a 1-page cooler card (roof). Order with coins; Dex reacts,
// you get the right prop in hand, and a few drinks do something.
import { coins, loop } from './util.js';
import { holdProp } from '../rooms/props-hand.js';
import { DRINKS, BITES, COOLER, icon } from './barmenu-data.js';
import { startDarts } from './barmenu-darts.js';
import { SFX } from '../sfx.js';
import { PAL, panel, title, coin, shine, rr } from './art.js';

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
  const tabs = () => cooler ? [] : pages.map((p, i) => ({ i, x: 236 + i * 64, w: 60, y: 46, h: 18 }));
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

  // cached card: a wooden menu board (bar) or a crate lid (cooler) holding a cream paper menu with brass corners
  const BACK = document.createElement('canvas'); BACK.width = W; BACK.height = H; {
    const g = /** @type {CanvasRenderingContext2D} */ (BACK.getContext('2d'));
    const gr = g.createRadialGradient(W / 2, H / 2, 20, W / 2, H / 2, W * 0.7); gr.addColorStop(0, '#3a2418'); gr.addColorStop(1, '#120a08'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
    panel(g, 4, 4, W - 8, H - 8, { style: cooler ? 'metal' : 'wood', r: 6 });
    panel(g, 14, 12, W - 28, H - 24, { style: 'paper', r: 3 });
    g.strokeStyle = 'rgba(90,58,34,0.45)'; g.lineWidth = 1; g.strokeRect(19.5, 17.5, W - 39, H - 35);
    for (const [a2, b2] of [[14, 12], [W - 22, 12], [14, H - 20], [W - 22, H - 20]]) { g.fillStyle = PAL.goldD; g.fillRect(a2, b2, 8, 8); g.fillStyle = PAL.goldHi; g.fillRect(a2 + 1, b2 + 1, 6, 1); g.fillStyle = '#3a2410'; g.fillRect(a2 + 3, b2 + 3, 2, 2); }
    g.fillStyle = 'rgba(90,58,34,0.5)'; g.fillRect(24, 66, W - 48, 1); g.fillRect(24, H - 52, W - 48, 1);
    // little ornament under the title
    g.fillStyle = 'rgba(120,70,30,0.35)'; for (let i = 0; i < 3; i++) g.fillRect(W / 2 - 6 + i * 5, 62, 2, 2);
  }
  const INK = PAL.paperInk, SOFT = '#7a5a3a', LIGHT = 'rgba(255,248,230,0.6)';
  loop(ov, (dt, t) => {
    flip = Math.max(0, flip - dt * 4); shake = Math.max(0, shake - dt); msgT = Math.max(0, msgT - dt);
    const sx = shake ? Math.round(Math.sin(t * 80) * 3 * shake / 0.35) : 0;
    x.setTransform(1, 0, 0, 1, sx, 0); x.drawImage(BACK, 0, 0);
    // header
    title(x, cooler ? 'THE COOLER' : 'THE TERMINAL', 28, 42, { size: 32, align: 'left', color: '#a8401a', ink: '#3a1a08' });
    title(x, cooler ? 'honour system. mostly.' : 'est. localhost', 30, 58, { size: 16, body: true, align: 'left', color: SOFT, ink: LIGHT });
    // wallet chip
    panel(x, W - 120, 22, 96, 22, { style: 'wood', r: 3 }); coin(x, W - 106, 33, 6, t * 0.4); title(x, `${wal.balance}`, W - 32, 38, { size: 16, align: 'right', color: PAL.gold });
    // tabs: paper tabs, the open one sits forward
    if (!cooler) for (const tb of tabs()) {
      const on = tb.i === page; x.save(); x.fillStyle = on ? '#a8401a' : '#d8c296'; rr(x, tb.x, tb.y + 2, tb.w, tb.h - 2, 3); x.fill(); x.restore();
      title(x, pages[tb.i].name.split(' ')[0], tb.x + tb.w / 2, tb.y + 15, { size: 16, body: true, color: on ? PAL.cream : SOFT, ink: on ? '#3a1a08' : LIGHT });
    }
    // items (slide in on page flip)
    const off = Math.round(flip * flip * 40);
    x.globalAlpha = 1 - flip * 0.8;
    items().forEach((it, i) => {
      const p = pos(i), px = p.x + off, py = p.y, can = wal.balance >= it.price, isSel = i === sel, rh = rowHOf() - 4;
      if (isSel) { x.fillStyle = can ? 'rgba(245,189,99,.35)' : 'rgba(200,56,44,.18)'; rr(x, px - 4, py - 4, colW, rh, 3); x.fill(); x.fillStyle = can ? '#a8401a' : '#c8382c'; x.fillRect(px - 4, py - 4, 3, rh); if (can) shine(x, px - 4, py - 4, colW, rh, t); }
      x.globalAlpha = (1 - flip * 0.8) * (can ? 1 : 0.45);
      icon(x, it.icon, px, py + (isSel ? Math.round(Math.sin(t * 4)) : 0), it.tint);
      title(x, it.name, px + 22, py + 11, { size: 16, body: true, align: 'left', color: INK, ink: LIGHT });
      if (rowHOf() > 30) title(x, it.desc, px + 22, py + 24, { size: 16, body: true, align: 'left', color: SOFT, ink: 'rgba(0,0,0,0)' });
      else title(x, (it.desc.length > 26 ? it.desc.slice(0, 25) + '.' : it.desc), px + 22, py + 22, { size: 16, body: true, align: 'left', color: SOFT, ink: 'rgba(0,0,0,0)' });
      title(x, String(it.price), px + colW - 12, py + 12, { size: 16, align: 'right', color: can ? '#a8401a' : '#c8382c', ink: LIGHT });
      x.globalAlpha = 1 - flip * 0.8;
    });
    x.globalAlpha = 1;
    // footer: tonight's tab, the hint / the decline
    const fy = H - 52;
    if (page === 1 || cooler) {
      const total = tab.reduce((s, o) => s + o.price, 0), last = tab.slice(-2).map(o => o.name).join(', ');
      title(x, "TAB", 28, fy + 17, { size: 16, align: 'left', color: '#a8401a', ink: LIGHT });
      title(x, tab.length ? `${tab.length}: ${last}${tab.length > 2 ? '...' : ''}` : 'empty. suspiciously sober.', 66, fy + 16, { size: 16, body: true, align: 'left', color: INK, ink: 'rgba(0,0,0,0)' });
      title(x, `${total} coins`, W - 28, fy + 16, { size: 16, body: true, align: 'right', color: '#a8401a', ink: 'rgba(0,0,0,0)' });
    } else title(x, 'all drinks served with a side of judgement', W / 2, fy + 16, { size: 16, body: true, color: SOFT, ink: 'rgba(0,0,0,0)' });
    const line = msgT ? msg : (wal.balance < items()[sel]?.price ? "can't afford that one. dex saw." : '');
    if (line) title(x, line, W / 2, fy + 31, { size: 16, body: true, color: '#c8382c', ink: LIGHT });
    else title(x, cooler ? 'arrows pick, enter / click to grab' : 'arrows pick + page, enter / click to order', W / 2, fy + 31, { size: 16, body: true, color: SOFT, ink: 'rgba(0,0,0,0)' });
    x.setTransform(1, 0, 0, 1, 0, 0);
  });
}

export default [
  { id: 'bar-menu', label: () => 'Order a drink', match: (it, R) => R?.id === 'bar' && it?.id === 'order', start: ctx => openMenu(ctx, false) },
  { id: 'cooler-menu', label: () => 'Grab a beer', match: (it, R) => R?.id === 'roof' && it?.id === 'cooler', start: ctx => openMenu(ctx, true) },
  { id: 'bar-darts', label: () => 'Throw darts', match: (it, R) => R?.id === 'bar' && it?.id === 'dartboard', start: startDarts },
];
