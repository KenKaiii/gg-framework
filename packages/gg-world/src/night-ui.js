// @ts-check
// DOM UI for Night Rooms: HUD, who-is-where, terminal feed, nameplates, bubbles, E interactions, chat, emotes, map.
import * as THREE from 'three';
import { CSS } from './ui.css.js';
import { portrait } from './portrait.js';
import { makeFX } from './fx.js';
import { NPC, npcReply } from './brain.js';
import { openCreator, wallet } from './creator.js';
import { initEdit } from './edit.js';
import { ROOM_IDS } from './rooms/index.js';
import { initActivities } from './act/registry.js';
import { plateHTML, plateClass, tierOf } from './nameplate.js';
import { passagesWorld, ROOM_NAMES } from './rooms/floorplan.js';
const PASSAGES_W = passagesWorld(); const _pv = new THREE.Vector3();
import { installDev } from './act/dev.js';
import { FLOOR_ORDER } from './roomset.js';
import { initPointer } from './pointer.js';
import { makeMarker } from './marker.js';
import { SFX } from './sfx.js';
import { installCursors } from './cursors.js';
import { ICONS, pxMask } from './ui.css.js';
import { sitPlayer } from './act/sit.js';

const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** @param {any} S @param {any} W */
export function initUI(S, W) {
  const root = /** @type {HTMLElement} */ (document.getElementById('ui')); const st = h('style'); st.textContent = CSS; document.head.appendChild(st);
  const fx = makeFX(S.scene, []);
  const U = { blocking: false, talking: false, editing: false, history: [], memory: {}, fx };
  // HUD (owner's pick: "Alloy" keys from the app + critter-paper chat; body font only)
  const top = h('div', 'hud-top'); root.appendChild(top);
  const meP = h('div', 'key lvk'); top.appendChild(meP);
  const online = /** @type {HTMLButtonElement} */ (h('button', 'key onk who')); online.type = 'button'; online.setAttribute('aria-expanded', 'false'); online.title = "Who's where (Tab)"; top.appendChild(online);
  const where = h('div', 'card where'); root.appendChild(where); where.style.display = 'none';
  const toggleWhere = () => { const open = where.style.display === 'none'; where.style.display = open ? 'block' : 'none'; online.setAttribute('aria-expanded', String(open)); };
  online.addEventListener('click', () => { toggleWhere(); online.blur(); });
  addEventListener('keydown', e => { if (e.code === 'Tab' && !/INPUT|TEXTAREA/.test(/** @type {HTMLElement} */ (document.activeElement)?.tagName || '')) { e.preventDefault(); toggleWhere(); } });
  // room bar: every room always one click away (plus doors and the M map)
  // floor tabs: hidden (owner); the roof / basement are reached by the stairs and the map. Kept built so the map and
  // the who's-where list can still travel between floors with the same code.
  const tabs = h('nav', 'key rooms'); tabs.setAttribute('aria-label', 'Floors'); tabs.style.display = 'none'; root.appendChild(tabs);
  const tabBtns = {};
  for (const f of FLOOR_ORDER) { const b = /** @type {HTMLButtonElement} */ (h('button', 'rt')); b.type = 'button'; b.dataset.f = f; tabs.appendChild(b); tabBtns[f] = b;
    b.addEventListener('click', () => { if (U.blocking || S.fade || S.floor === f) return; W.travel(S.floors[f].rooms[0].id); b.blur(); }); }
  const wp = new THREE.Vector3(), wq = new THREE.Vector3();
  const wdist = (a, b) => a.root.getWorldPosition(wp).distanceTo(b.root.getWorldPosition(wq));
  const roomsOf = f => S.floors[f].rooms;
  where.addEventListener('click', e => { const el = /** @type {HTMLElement} */ (e.target).closest('[data-r]'); if (!el || U.blocking || S.fade) return; const id = /** @type {HTMLElement} */ (el).dataset.r; if (S.rooms[id] && S.rooms[id] !== S.room) W.travel(id); });
  const people = (R, on) => on.filter(m => m.room === R).length + (R.id === 'bar' ? 1 : 0) + (R === S.room ? 1 : 0);
  // (controls panel removed at the owner's request)
  const prompt = h('div', 'prompt'); root.appendChild(prompt);
  const toastEl = h('div', 'card toast'); root.appendChild(toastEl);
  const chat = h('div', 'chatp', '<div class="clog" aria-live="polite"></div><label class="cin"><input maxlength="120" placeholder="say something..." aria-label="Chat message"><kbd>Enter</kbd></label>'); root.appendChild(chat);
  const clog = /** @type {HTMLElement} */ (chat.querySelector('.clog'));
  // not chatting: only a chat key shows (with an unread count); Enter or a click opens the panel
  const chatBtn = /** @type {HTMLButtonElement} */ (h('button', 'key ib chatbtn')); chatBtn.type = 'button'; chatBtn.title = 'Chat (Enter)'; chatBtn.setAttribute('aria-label', 'Open chat');
  chatBtn.innerHTML = '<i class="pxi"></i><b class="unread"></b>'; /** @type {HTMLElement} */ (chatBtn.firstChild).style.setProperty('--m', pxMask(ICONS.chat)); root.appendChild(chatBtn);
  let unread = 0; const setUnread = n => { unread = n; const u = /** @type {HTMLElement} */ (chatBtn.querySelector('.unread')); u.textContent = n > 9 ? '9+' : n ? String(n) : ''; };
  const openChat = () => { if (U.blocking) return; SFX.play('ui.open'); chat.classList.add('typing'); chatBtn.classList.add('hid'); setUnread(0); clog.scrollTop = clog.scrollHeight; /* open at the newest */ U.blocking = true; setTimeout(() => chatIn.focus(), 10); };
  chatBtn.addEventListener('click', () => { chatBtn.blur(); openChat(); });
  const chatIn = /** @type {HTMLInputElement} */ (chat.querySelector('input'));
  const prof = h('div', 'card modal profile'); root.appendChild(prof);
  const mapP = h('div', 'card modal mapp'); root.appendChild(mapP);
  // DM panel: takes the chat's place (bottom left) in the same critter-paper style; portrait with the name under it
  const dlg = h('div', 'modal dlg', `<div class="who"><div class="portrait"><img alt=""></div><span class="nm">${NPC.name}</span></div><div class="dm"><div class="log" aria-live="polite"></div><label class="cin"><input maxlength="160" placeholder="say something..." aria-label="Message"><kbd>Enter</kbd></label></div><button class="x" type="button" aria-label="Close"><i></i></button>`); root.appendChild(dlg);
  const log = /** @type {HTMLElement} */ (dlg.querySelector('.log')); const dIn = /** @type {HTMLInputElement} */ (dlg.querySelector('input'));
  let creatorEl = null, toastT = 0;
  const toast = txt => { toastEl.textContent = txt; toastEl.style.display = 'block'; toastT = 2.8; SFX.play('ui.toast'); };
  // nameplates
  const plates = new Map();
  const plate = (agent, cls) => { let p = plates.get(agent); if (!p) { p = h('div', 'np ' + cls); root.appendChild(p); plates.set(agent, p); } return p; };
  const bubbles = [];
  // several lines from one person stack upward (newest lowest, nearest the head); at most 3 show, older ones shrink and fade
  U.bubble = (agent, txt, secs = 3, cls = '') => { if (!agent || !agent.root.parent?.visible || agent.root.parent.parent?.visible === false) return; const b = h('div', 'bub ' + cls, esc(txt)); root.appendChild(b); const uk = U.uiScale || 1; bubbles.push({ b, agent, t: Math.max(secs, 4), y: 0, w0: b.offsetWidth * uk, h0: b.offsetHeight * uk }); // on-screen size (scaled) // measured once (no per-frame layout reads)
    const mine = bubbles.filter(q => q.agent === agent); while (mine.length > 3) { const old = mine.shift(); old.b.remove(); bubbles.splice(bubbles.indexOf(old), 1); } };
  // chat log: what people say (plus ships), newest at the bottom, last 6 kept
  // the log scrolls (wheel / trackpad, native and smooth); a new line keeps it pinned to the bottom unless you've
  // scrolled up to read older ones; 60 lines kept
  // names in the chat look like the nameplates: the title font, coloured by level tier (owner: names must stand out)
  const levelOfName = who => { if (!who) return 0; if (who === 'You' || who === S.player?.name) return S.player?.level || 1;
    const m = S.members.find(x => x.d.name === who); if (m) return m.d.level; return S.residents?.list.some(n => n.def.name === who) || who === 'Dex' ? -1 : 0; };
  const chatLine = (who, txt, cls = '') => { const pinned = clog.scrollHeight - clog.scrollTop - clog.clientHeight < 24;
    const lv = levelOfName(who), tc = lv === -1 ? 'npc' : lv > 0 ? 't' + tierOf(lv) : '';
    const d = h('div', 'cm ' + cls, `${who ? `<u class="${tc}">${esc(who)}</u>` : ''}${esc(txt)}`); clog.appendChild(d); if (!chat.classList.contains('typing') && cls !== 'me') setUnread(unread + 1);
    while (clog.children.length > 60) clog.firstChild?.remove(); if (pinned || cls === 'me') clog.scrollTop = clog.scrollHeight; };
  U.chatLine = chatLine;
  U.feed = () => {}; // the chat is for chat only (owner): ships are celebrated in the world, not posted here
  U.celebrate = m => { fx.confetti(m.agent.pos.clone()); }; // the line itself comes from the person (director), not a fixed 'shipped vX!'
  U.toast = toast;
  const closeAll = () => { if (U.blocking && !document.body.classList.contains('in-act')) SFX.play('ui.close'); prof.style.display = mapP.style.display = 'none'; dlg.style.display = 'none'; talkingTo = null; U.talkingTo = null; chatBtn.classList.remove('hid'); chat.classList.remove('typing'); chatBtn.classList.remove('hid'); chatIn.blur(); U.talking = false; if (creatorEl) { creatorEl.remove(); creatorEl = null; S.me.av.setLook(S.player.look); } U.blocking = false; /** @type {HTMLElement} */ (document.activeElement)?.blur?.(); };
  U.closeAll = closeAll;
  // close buttons on the profile / map panels
  root.addEventListener('click', e => { if (/** @type {HTMLElement} */ (e.target)?.closest?.('.modal .x')) closeAll(); });
  const showProfile = m => { SFX.play('ui.open');
    const d = m.d; prof.innerHTML = `<button class="x" type="button" aria-label="Close"><i></i></button><div class="head"><div class="portrait"><img src="${portrait(S.A, d.look, '#0e1014')}"></div><div><h2>${esc(d.name)}</h2><div class="title">${esc(d.title)}</div><span class="lvl">Lv ${d.level}</span></div></div>
      <div class="xp"><i style="width:${(d.level * 37) % 90 + 8}%"></i></div><div class="badges">${d.badges.map(b => `<span>${esc(b)}</span>`).join('')}</div>
      <div class="row"><span>status</span><span>${esc(m.statusText)}</span></div><div class="row"><span>room</span><span>${esc(m.room.meta.name)}</span></div><div class="row"><span>shipped</span><span>${d.shipped}</span></div>`;
    prof.style.display = 'block'; U.blocking = true;
  };
  const ctxFor = () => { const on = S.members.filter(m => m.status !== 'offline'); return { memory: U.memory, online: on.length, lastShip: S.lastShip, deploying: on.filter(m => m.status === 'deploying').map(m => m.d.name), level: S.player.level,
    where: ROOM_IDS.map(id => { const n = on.filter(m => m.room.id === id).map(m => m.d.name); return n.length ? `${S.rooms[id].meta.name}: ${n.join(', ')}.` : ''; }).join(' ') }; };
  const say = (who, txt) => { const p = h('p', who, esc(txt)); log.appendChild(p); log.scrollTop = 1e6; return p; };
  // talk to Dex (n = undefined) or a resident NPC (n = resident). Each keeps its own chat history.
  const histories = new Map(); let talkingTo = null;
  const talk = (n) => { talkingTo = n || null; U.talkingTo = talkingTo; U.history = histories.get(n || 'dex') || []; histories.set(n || 'dex', U.history);
    const nm = /** @type {HTMLElement} */ (dlg.querySelector('.nm'));
    const nmT = n ? n.def.name : NPC.name; nm.textContent = nmT; nm.classList.toggle('long', nmT.length > 7); nm.classList.toggle('xlong', nmT.length > 11); dIn.placeholder = `say something to ${nmT}...`;
    chat.classList.remove('typing'); chatBtn.classList.add('hid'); // the DM replaces the normal chat while it's open
    dlg.style.display = 'flex'; U.talking = true; U.blocking = true; const img = /** @type {HTMLImageElement} */ (dlg.querySelector('img')); img.src = portrait(S.A, n ? n.def.look : NPC.look, '#0e1014');
    log.innerHTML = ''; for (const hh of U.history) say(hh.role === 'user' ? 'u' : 'n', hh.text);
    if (!U.history.length) { const first = n ? (S.residents?.opening(n) || 'Hey.') : `Dex. ${S.lastShip ? S.lastShip + ' just shipped, so the shots are out. ' : ''}What are we drinking?`; say('n', first); U.history.push({ role: 'npc', text: first }); }
    setTimeout(() => dIn.focus(), 30); };
  dIn.addEventListener('keydown', async e => {
    e.stopPropagation(); if (e.key === 'Escape') { closeAll(); return; } if (e.key !== 'Enter' || !dIn.value.trim()) return;
    const txt = dIn.value.trim(); dIn.value = ''; say('u', txt); U.history.push({ role: 'user', text: txt });
    const ty = say('n typing', ''); ty.innerHTML = '<i></i><i></i><i></i>';
    const r = talkingTo ? await S.residents.reply(talkingTo, U.history) : await npcReply(U.history, ctxFor()); ty.remove(); U.history.push({ role: 'npc', text: r });
    const p = say('n', ''); let i = 0; const iv = setInterval(() => { p.textContent = r.slice(0, i += 2); log.scrollTop = 1e6; if (i >= r.length) clearInterval(iv); }, 18);
  });
  chatIn.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') closeAll(); if (e.key === 'Enter') { const v = chatIn.value.trim(); chatIn.value = ''; if (v) { SFX.play('ui.send'); U.bubble(S.me, v, 4); chatLine('You', v, 'me'); } closeAll(); } });
  const openMap = () => { SFX.play('paper');
    mapP.innerHTML = '<button class="x" type="button" aria-label="Close"><i></i></button><h3>map</h3>' + FLOOR_ORDER.map(f => `<h4 class="fl${f === S.floor ? ' cur' : ''}">${esc(S.floors[f].name)}</h4>` + '<div class="grid">' + roomsOf(f).map(R => { const id = R.id; const n = S.members.filter(m => m.room === R && m.status !== 'offline').map(m => m.d.name); if (id === 'bar') n.unshift('dex'); if (R === S.room) n.unshift('you');
      const who = n.length > 6 ? n.slice(0, 6).join(', ') + ` +${n.length - 6}` : n.join(', ');
      return `<div class="rm ${R === S.room ? 'cur' : ''}" data-r="${id}"><b>${esc(R.meta.name)}</b><div>${esc(R.meta.blurb || '')}</div><div>${n.length ? esc(who) : 'empty'}</div></div>`; }).join('') + '</div>').join('');
    mapP.style.display = 'block'; U.blocking = true;
    mapP.querySelectorAll('[data-r]').forEach(el => el.addEventListener('click', () => { closeAll(); W.travel(/** @type {HTMLElement} */ (el).dataset.r); }));
  };
  // interactions: nearest of Dex, room interactables, members
  // Everything you can use on this floor. Static parts (objects, seats) are rebuilt at most every 0.4 s (seats free up /
  // fill as members come and go); Dex and members move, so their positions are read live.
  const SEAT_WORD = { sofa: 'Sit on the sofa', armchair: 'Sit in the armchair', chair: 'Take a seat', stool: 'Grab a stool', booth: 'Slide into the booth', beanbag: 'Flop on the beanbag', floor: 'Sit on the floor', pc: 'Sit at the desk' };
  let tCache = [], tAt = -1, tFloor = '';
  const targets = () => {
    if (S.t - tAt > 0.4 || tFloor !== S.floor) { tAt = S.t; tFloor = S.floor; tCache = [];
      for (const Rm of roomsOf(S.floor)) { const o = Rm.root.position;
        for (const it of Rm.interact || []) tCache.push({ kind: 'item', it, R: Rm, label: it.label, wx: it.x + o.x, wz: it.z + o.z, r: it.r || 1, pos: new THREE.Vector3(it.x + o.x, 1.6, it.z + o.z),
          // the object itself (rooms/focus.js), for the hover ring / glow / click marker
          vx: (it.vx ?? it.x) + o.x, vz: (it.vz ?? it.z) + o.z, vr: it.vr, vh: it.vh });
        for (const sl of Rm.slots || []) { if (Rm.taken?.has(sl.id)) continue; const wx = sl.x + o.x, wz = sl.z + o.z, pos = new THREE.Vector3(wx, 1.4, wz);
          if (sl.act) tCache.push({ kind: 'item', it: { id: sl.id, kind: 'seat', act: sl.act, slot: sl, x: sl.x, z: sl.z, label: sl.actLabel || 'Sit down' }, R: Rm, label: sl.actLabel || 'Sit down', wx, wz, r: 0.55, pos, slot: sl });
          else if (/^Sit_/.test(sl.anim || '')) tCache.push({ kind: 'seat', slot: sl, R: Rm, label: SEAT_WORD[sl.kind] || 'Sit down', wx, wz, r: 0.5, pos }); } } }
    const out = tCache.slice();
    for (const n of S.residents?.list || []) if (n.R.floorId === S.floor && n.agent.root.visible) { const p = n.agent.root.getWorldPosition(new THREE.Vector3()); out.push({ kind: 'npc', res: n, label: 'Talk to ' + n.def.name, at: n.agent, wx: p.x, wz: p.z, r: 0.6 }); }
    if (S.floor === S.rooms.bar.floorId && S.dex) { const p = S.dex.agent.root.getWorldPosition(new THREE.Vector3()); out.push({ kind: 'npc', label: 'Talk to Dex', at: S.dex.agent, wx: p.x, wz: p.z, r: 0.6 }); }
    return out;
  };
  const peopleT = () => S.members.filter(m => m.active && m.agent.root.visible && m.agent.root.parent?.visible).map(m => ({ kind: 'member', m, label: m.d.name, at: m.agent, r: 0.45 }));
  const meWorld = () => S.me.root.getWorldPosition(new THREE.Vector3());
  const distTo = (n, me = meWorld()) => { const p = n.at ? n.at.root.getWorldPosition(wq) : wq.set(n.wx, 0, n.wz); return Math.hypot(p.x - me.x, p.z - me.z) - (n.r || 1) + (n.kind === 'seat' ? 0.2 : 0); };
  const inReach = n => distTo(n) < 0.8;
  /** nearest thing you can use with E (members are click-only: no more E-profiles) */
  const near = () => { const me = meWorld(); let best = null, bd = 0.8; for (const n of targets()) { const d = distTo(n, me); if (d < bd) { bd = d; best = n; } } return best; };
  const sitFree = (Rm, sl) => { if (Rm !== S.room) { W.shift(S.me, S.room, Rm); W.setRoom(Rm); }
    (Rm.taken = Rm.taken || new Set()).add(sl.id); tAt = -1; const up = sitPlayer(S, Rm, sl); S.seated = { Rm, sl, up }; SFX.play(/sofa|beanbag|armchair|booth|bed/.test(sl.kind || '') ? 'cushion' : 'sit'); };
  const standUp = () => { const s2 = S.seated; if (!s2) return; S.seated = null; SFX.play('stand'); s2.Rm.taken?.delete(s2.sl.id); tAt = -1; s2.up(); };
  U.standUp = standUp;
  const ACT = initActivities(S, U); S.act = ACT; installDev(S);
  // cooldown: after using something its prompt / tooltip stays hidden for a bit, and E / clicks on it are ignored
  const tkey = n => n ? (n.it?.id || n.slot?.id || n.m?.d?.name || n.label) + '@' + (n.R?.id || '') : '';
  const cool = new Map(); U.cool = cool; U.tkey = tkey; const COOL = 2.5;
  const cooling = n => (cool.get(tkey(n)) || 0) > S.t;
  U.cooling = cooling;
  const interactWith = n => {
    if (n && n.kind !== 'member' && cooling(n)) return; if (n && n.kind !== 'member' && n.kind !== 'seat') cool.set(tkey(n), S.t + COOL);
    if (U.blocking || !n) return; if (S.seated) standUp();
    if (n.kind === 'seat') { if (!n.R.taken?.has(n.slot.id)) sitFree(n.R, n.slot); return; }
    if (n.kind === 'item' && ACT.tryStart(n.it, n.R, { toast, bubble: t => U.bubble(S.me, t, 3) })) return;
    if (n.kind === 'npc') talk(n.res); else if (n.kind === 'member') showProfile(n.m);
    else { SFX.forItem(n.it, n.R); try { if (n.R.onInteract) n.R.onInteract(n.it.id, { toast, bubble: t => U.bubble(S.me, t, 3) }); else toast(n.it.label); } catch (e) { console.warn('onInteract', e); } }
  };
  const interact = () => { if (U.blocking) return; if (S.seated) { standUp(); return; } S.pending = null; interactWith(near()); };
  installCursors();
  // UI scale follows the window (owner: small windows must not drown in big bubbles; big ones not too small):
  // 1.0 at ~1280 x 760, clamped 0.72 (always readable) .. 1.25 (never huge)
  const setUiScale = () => { const k = Math.max(0.72, Math.min(1.25, Math.min(innerWidth / 1280, innerHeight / 760))); document.documentElement.style.setProperty('--ui', k.toFixed(3)); U.uiScale = k;
    // chat / DMs: a gentler curve with a higher floor (0.95), so the text stays readable in small windows
    document.documentElement.style.setProperty('--ui-chat', Math.max(0.95, Math.min(1.2, 0.6 + k * 0.5)).toFixed(3)); };
  setUiScale(); addEventListener('resize', setUiScale);
  // inside the app, its Back button and the window's traffic lights sit over our top-left: start the HUD below them
  if (window.parent !== window) document.documentElement.classList.add('embedded');
  // DOM buttons click / hover softly (overlay close buttons play their own close sound)
  const BTN = 'button,.rt,.go,.rm,.opt,.sw,.btn,[data-r],.who';
  let hovEl = null;
  document.addEventListener('click', e => { const el = /** @type {HTMLElement} */ (e.target)?.closest?.(BTN); if (el && !el.closest('.act .x') && !el.classList.contains('x')) SFX.play('ui.click'); }, true);
  let hovT = 0; document.addEventListener('mouseover', e => { const el = /** @type {HTMLElement} */ (e.target)?.closest?.(BTN); if (el && el !== hovEl && performance.now() - hovT > 120) { hovT = performance.now(); SFX.play('ui.hover', { vol: 0.8 }); } hovEl = el; }, true);
  // sound on/off: speaker button in the top bar (remembered)
  const snd = /** @type {HTMLButtonElement} */ (h('button', 'card pill who snd')); snd.type = 'button'; snd.title = 'Sound on/off';
  const sndIcon = () => { snd.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" style="image-rendering:pixelated" fill="currentColor"><path d="M2 6h3l4-3v10l-4-3H2z"/>${SFX.muted ? '<path d="M11 6l4 4M15 6l-4 4" stroke="currentColor" stroke-width="1.6"/>' : '<path d="M11 5.5c1.2 1.2 1.2 3.8 0 5M12.8 4c2 2 2 6 0 8" stroke="currentColor" stroke-width="1.3" fill="none"/>'}</svg>`; snd.style.color = SFX.muted ? '#8a978c' : '#6ee7a0'; };
  snd.addEventListener('click', () => { SFX.setMuted(!SFX.muted); sndIcon(); if (!SFX.muted) SFX.play('ui.toast'); snd.blur(); }); sndIcon();
  const ibar = h('div', 'ibar'); root.appendChild(ibar);
  const ib = (title, rows, fn) => { const b = /** @type {HTMLButtonElement} */ (h('button', 'key ib')); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.innerHTML = '<i class="pxi"></i>'; /** @type {HTMLElement} */ (b.firstChild).style.setProperty('--m', pxMask(rows)); b.addEventListener('click', () => { b.blur(); if (!U.blocking) fn(); }); ibar.appendChild(b); return b; };
  ib('Map (M)', ICONS.map, () => openMap());
  ib('Wardrobe (C)', ICONS.shirt, () => { U.blocking = true; creatorEl = openCreator(S, root, () => { creatorEl?.remove(); creatorEl = null; U.blocking = false; }); });
  snd.className = 'key ib snd'; ibar.appendChild(snd);
  const MK = makeMarker(S); U.marker = MK;
  const PTR = initPointer(S, U, W, { targets, people: peopleT, interactWith, showProfile: m => showProfile(m), standUp, inReach });
  const EMO = { Digit1: ['facepalm', 'ugh.'], Digit2: ['slowclap', 'wow. amazing.'], Digit3: ['flip', '(╯°□°)╯︵ ┻━┻'], Digit4: ['cringe', '*cringe dance*'] };
  const edit = initEdit(S, U, root);
  // room name: fades in at the top middle when you walk into a room (and on stairs / travel), then fades out
  const roomCard = h('div', 'roomcard'); root.appendChild(roomCard); let rcT = 0, rcId = '';
  const showRoom = R => { if (!R || R.id === rcId) return; rcId = R.id; roomCard.textContent = R.meta?.name || ROOM_NAMES[R.id] || R.id; roomCard.classList.remove('on'); void roomCard.offsetWidth; roomCard.classList.add('on'); clearTimeout(rcT); rcT = setTimeout(() => roomCard.classList.remove('on'), 2200); };
  S.hooks.push((kind, e) => {
    if (kind === 'room') { edit.stop(); showRoom(e); return; }
    if (kind === 'enter') { showRoom(e); closeAll(); edit.stop(); for (const [, p] of plates) p.style.display = 'none'; return; }
    if (kind !== 'key') return;
    if (e.code === 'Escape') { closeAll(); edit.stop(); return; }
    if (U.blocking) return;
    if (e.code === 'KeyE') interact();
    if (e.code === 'Enter') { e.preventDefault(); openChat(); }
    if (e.code === 'KeyM') openMap();
    if (e.code === 'KeyC') { U.blocking = true; creatorEl = openCreator(S, root, () => { creatorEl?.remove(); creatorEl = null; U.blocking = false; }); }
    if (e.code === 'KeyB') edit.toggle();
    const em = EMO[e.code]; if (em) { SFX.play('pop'); S.me.path = null; S.me.av.startEmote(em[0]); S.me.lockAnim = 2.5; U.bubble(S.me, em[1], 2.5); }
  });
  // click-to-walk
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
  S.renderer.domElement.addEventListener('click', e => {
    ndc.set(e.clientX / innerWidth * 2 - 1, -e.clientY / innerHeight * 2 + 1); ray.setFromCamera(ndc, S.cam);
    if (U.editing) { edit.click(ray); return; } if (U.blocking || S.fade) return;
    const tgt = PTR.pickAt(e.clientX, e.clientY); if (tgt) { PTR.go(tgt); return; }
    S.pending = null; if (S.seated) standUp();
    if (ray.ray.intersectPlane(plane, hit) && !W.locate(hit.x, hit.z)) { SFX.play('ui.deny'); return; }
    if (ray.ray.intersectPlane(plane, hit)) { SFX.play('ui.tap', { vol: 0.5 }); const T = W.locate(hit.x, hit.z) || S.room, o = T.root.position; const p = T.grid.nearestFree(hit.x - o.x, hit.z - o.z); MK.show(p.x + o.x, p.z + o.z, 'move'); W.route({ get room() { return S.room; } }, S.me, T, p.x, p.z, null, 4.6); }
  });
  const v = new THREE.Vector3();
  const scr = (o, y, R) => { v.copy(o); if (R) v.add(R.root.position); v.setY(o.y + y).project(S.cam); return [(v.x + 1) / 2 * innerWidth, (1 - v.y) / 2 * innerHeight]; };
  let hudT = 0; U.refreshHud = () => { hudT = 0; }; // the app sent the real level: redraw the HUD next frame
  U.update = (dt, t) => {
    fx.update(dt, t);
    if ((toastT -= dt) < 0) toastEl.style.display = 'none';
    let n = U.blocking || S.seated ? null : near(); // seated: no prompt (E or moving still stands you up)
    if (n && (cooling(n) || (U.hoverKey && U.hoverKey === tkey(n)))) n = null; // no duplicate with the hover tooltip; nothing while cooling down
    PTR.update(dt, t); MK.update(dt);
    // openings between rooms on this floor: show where the nearest one leads (within 2.2 m of it)
    let pass = null; if (false) { // doorway prompts replaced by the room-name card const rp = S.room.root.position, px = S.me.pos.x + rp.x, pz = S.me.pos.z + rp.z; let bd = 2.2;
      for (const P of PASSAGES_W) { if (P.floor !== S.floor || (P.a !== S.room.id && P.b !== S.room.id)) continue; const d = Math.hypot(px - P.x, pz - P.z); if (d < bd) { bd = d; pass = { x: P.x, z: P.z, to: P.a === S.room.id ? P.b : P.a }; } } }
    let door = null; if (false) { let bd = 2.4; for (const ex of S.room.exits || []) { const d = Math.hypot(S.me.pos.x - ex.door.x, S.me.pos.z - ex.door.z); if (d < bd) { bd = d; door = ex; } } }
    // the prompt glides to its target (~0.12 s) and fades in, instead of snapping when the nearest object changes
    const placePrompt = (x, y, html) => { const was = prompt.style.display === 'block';
      if (!was || prompt._x == null || prompt.dataset.h !== html) { prompt._x = x; prompt._y = y; prompt.classList.remove('in'); void prompt.offsetWidth; prompt.classList.add('in'); }
      else { const k = Math.min(1, dt * 14); prompt._x += (x - prompt._x) * k; prompt._y += (y - prompt._y) * k; }
      prompt.style.display = 'block'; prompt.style.left = prompt._x + 'px'; prompt.style.top = prompt._y + 'px'; if (prompt.dataset.h !== html) { prompt.innerHTML = html; prompt.dataset.h = html; } };
    if (n) { const [x, y] = n.at ? scr(n.at.root.getWorldPosition(wq), 2.3) : scr(n.pos, 0.4); placePrompt(x, y, `<span class="pi"><kbd>E</kbd><span>${esc(n.label)}</span></span>`); }
    else if (door) { const [x, y] = scr(new THREE.Vector3(door.door.x, 0, door.door.z), 2.6, S.room); placePrompt(x, y, `<span class="pi"><span>walk in</span><i class="ico arr"></i><span>${esc(S.rooms[door.to]?.meta.name || door.to)}</span></span>`); }
    else { prompt.style.display = 'none'; prompt._x = null; }
    const list = [[S.me, 'me', S.player.name, S.player.level, ''], ...(S.floor === S.rooms.bar.floorId && S.dex ? [[S.dex.agent, 'npc', 'Dex', 'bar', 'bartender']] : []), ...(S.residents?.list || []).filter(n => n.R.floorId === S.floor).map(n => [n.agent, 'npc', n.def.name, 'npc', n.def.role]), ...S.members.map(m => [m.agent, '', m.d.name, m.d.level, m.statusText, m])];
    // Minimal-style plates (nameplate.js): full = level orb + name (+ title from Elite); compact = name only
    const placed = [];
    const meWp = S.me.root.getWorldPosition(wp).clone(); // (not 'meP': that's the HUD pill element)
    const keyed = []; for (const it of list) { const a = it[0], m = it[5]; if (!a.root.visible || (m && !m.active) || !a.root.parent?.visible) { keyed.push([it, 3]); continue; }
      keyed.push([it, a === S.me ? 0 : a.root.getWorldPosition(wq).distanceTo(meWp) < 2.6 ? 1 : 2]); }
    keyed.sort((A, B) => A[1] - B[1] || (Number(B[0][3]) || 0) - (Number(A[0][3]) || 0)); list.length = 0; for (const k of keyed) list.push(k[0]);
    // keep nameplates out of the E prompt: if a plate would sit on the prompt, push it above it (or below if no room)
    const pr = prompt.style.display === 'block' ? prompt.getBoundingClientRect() : null;
    const hitsPrompt = (x, y) => pr && x + 60 > pr.left && x - 60 < pr.right && y > pr.top - 2 && y - 20 < pr.bottom + 2;
    for (const [a, cls, name, lv, stt, m] of list) {
      const p = plate(a, cls); const vis = a.root.visible && (!m || m.active) && a.root.parent?.visible;
      p.style.display = vis ? 'flex' : 'none'; if (!vis) { p._off = null; continue; }
      const full = a === S.me || wdist(a, S.me) < 2.6 || n?.at === a;
      const hw = (p._w || 80) / 2 + 6; // half the plate's last measured width (+ gap)
      const clash = (x, y) => placed.some(q => Math.abs(q[0] - x) < hw + q[2] && Math.abs(q[1] - y) < 19);
      let [x, y] = scr(a.root.getWorldPosition(wq), 2.15); for (let k = 0; k < 8 && clash(x, y); k++) y -= 20;
      if (hitsPrompt(x, y)) { y = pr.top - 4; for (let k = 0; k < 8 && clash(x, y); k++) y -= 20; } placed.push([x, y, hw]);
      // ease the stacking / step-aside offset (critically damped, ~0.15 s) so plates glide instead of jumping
      const baseY = scr(a.root.getWorldPosition(wq), 2.15)[1], want = y - baseY; const prevOff = p._off ?? want, fresh = p._off == null;
      const off = fresh ? want : prevOff + (want - prevOff) * Math.min(1, dt * 12); p._off = off; y = baseY + off;
      p.style.left = x + 'px'; p.style.top = y + 'px'; const pc = plateClass(lv, full, cls); if (p.className !== pc) p.className = pc;
      /* owner: no status ("prompting") or title next to names; NPCs: their role in place of a level (so you can tell them from players) */
      const html = cls === 'npc' ? `<span class="nm">${esc(name)}</span>${full ? `<span class="role">${esc(stt)}</span>` : ''}` : plateHTML({ lv, name, full }); if (p.dataset.h !== html) { p.innerHTML = html; p.dataset.h = html; p._w = p.offsetWidth; }
      if (m) p.style.setProperty('--a', m.d.accent);
    }
    for (let i = bubbles.length - 1; i >= 0; i--) { const b = bubbles[i]; b.t -= dt; if (b.t <= 0 || !b.agent.root.parent?.visible || b.agent.root.parent.parent?.visible === false) { b.b.remove(); bubbles.splice(i, 1); continue; } const [x, y0] = scr(b.agent.root.getWorldPosition(wq), 2.15); const pl = plates.get(b.agent); const lift = pl && pl.style.display !== 'none' ? (pl._off || 0) - 24 : -22;
      // stack: sum the heights of this person's newer bubbles; ease into place so a new line pushes the others up smoothly
      let up = 0, rank = 0; for (let j = i + 1; j < bubbles.length; j++) if (bubbles[j].agent === b.agent) { up += (bubbles[j].h || 34) + 8; rank++; }
      b.h = b.h0 * (rank ? 0.86 : 1); b.y += (up - b.y) * Math.min(1, dt * 12);
      b.sx = x; b.sy = y0 + lift - b.y; b.w = b.w0; b.hh = b.h0 * (rank ? 0.86 : 1); b.rank = rank;
      b.b.style.left = x + 'px'; b.b.style.top = (b.sy - (b.push || 0)) + 'px'; b.b.style.setProperty('--k', rank ? '0.86' : '1'); if (b.stk !== rank > 0) { b.stk = rank > 0; b.b.classList.toggle('stk', b.stk); } /* only the newest keeps the tail */ b.b.style.opacity = String(Math.min(1, b.t / 0.5) * (rank === 0 ? 1 : rank === 1 ? 0.75 : 0.5)); }
    // each person's stack is one block; blocks of different people that overlap on screen are lifted apart (lowest stays)
    { const G = new Map(); for (const q of bubbles) { if (q.sx == null) continue; let g = G.get(q.agent); if (!g) G.set(q.agent, g = { list: [], x0: 1e9, x1: -1e9, top: 1e9, bot: -1e9 }); g.list.push(q);
        g.x0 = Math.min(g.x0, q.sx - q.w / 2); g.x1 = Math.max(g.x1, q.sx + q.w / 2); g.top = Math.min(g.top, q.sy - q.hh); g.bot = Math.max(g.bot, q.sy); }
      const blocks = [...G.values()].sort((a2, b2) => b2.bot - a2.bot), placed = [];
      for (const g of blocks) { let want = 0; for (let pass = 0; pass < 4; pass++) { let moved = false;
          for (const o of placed) if (g.x0 < o.x1 + 6 && o.x0 < g.x1 + 6 && g.top - want < o.bot - o.want + 6 && g.bot - want > o.top - o.want - 6) { want = g.bot - (o.top - o.want - 8); moved = true; }
          if (!moved) break; }
        g.want = want; for (const q of g.list) { q.push = (q.push || 0) + (want - (q.push || 0)) * Math.min(1, dt * 12); q.b.style.top = (q.sy - q.push) + 'px'; } placed.push(g); } }
    if ((hudT -= dt) < 0) {
      hudT = 0.5; const on = S.members.filter(m => m.status !== 'offline');
      const oh = `<span class="dot"></span>${on.length} <span class="mu">online</span>`; if (online.dataset.h !== oh) { online.innerHTML = oh; online.dataset.h = oh; }
      const lh = `<span class="n">${S.player.level}</span><span class="xw"><span class="t"><span class="mu">Level ${S.player.level}</span><span class="c">${wallet(S).coins}c</span></span><span class="xpbar"><i style="width:${Math.round(S.player.xp * 100)}%"></i></span></span>`;
      if (meP.dataset.h !== lh) { meP.innerHTML = lh; meP.dataset.h = lh; }
      where.innerHTML = FLOOR_ORDER.map(f => `<div class="fl${f === S.floor ? ' cur' : ''}">${esc(S.floors[f].name)}</div>` + roomsOf(f).map(R => { const id = R.id; const SC = { prompting: 'p', thinking: 't', deploying: 'd', idle: 'i' };
        const ns = on.filter(m => m.room === R).slice(0, 7).map(m => `${esc(m.d.name)}<span class="s ${SC[m.status] || 'i'}">●</span>`); if (id === 'bar') ns.unshift('dex'); const more = on.filter(m => m.room === R).length - 7; if (more > 0) ns.push(`+${more}`);
        return `<div class="${R === S.room ? 'cur' : 'go'}" data-r="${id}"><b>${esc(R.meta.name.replace(/ \(placeholder\)/, ''))}</b> <i>${ns.length ? ns.join(' ') : '-'}</i></div>`; }).join('')).join('')
        + '<div class="lg"><span class="s p">●</span> coding <span class="s t">●</span> thinking <span class="s d">●</span> deploying <span class="s i">●</span> break</div>';
      for (const f of FLOOR_ORDER) { const b = tabBtns[f]; const cnt = roomsOf(f).reduce((n, R) => n + people(R, on), 0);
        const html = `${esc(S.floors[f].name)}<span>${cnt}</span>`; if (b.dataset.h !== html) { b.innerHTML = html; b.dataset.h = html; }
        b.classList.toggle('cur', f === S.floor); b.setAttribute('aria-current', f === S.floor ? 'true' : 'false'); }
    }
    edit.update(dt);
  };
  return U;
}
