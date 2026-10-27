// @ts-check
// DOM UI for Night Rooms: HUD, who-is-where, terminal feed, nameplates, bubbles, E interactions, chat, emotes, map.
import * as THREE from 'three';
import { CSS } from './ui.css.js';
import { portrait } from './portrait.js';
import { makeFX } from './fx.js';
import { NPC, npcReply } from './brain.js';
import { openCreator, wallet, FIRST_KEY } from './creator.js';
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
import { createGuard, GUARD_KEY } from './chat-guard.js';
import { slur, blurt, tipsyLevel } from './tipsy.js';
import { EMBED, tellApp, fromApp } from './bridge.js';

const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
/** the real-player marker: a ringed dot (shape, not only colour) + hidden text for screen readers */
const LVM = '<i class="lvm" aria-hidden="true" title="real player"></i><span class="sr">(real player)</span>';
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
  const roomsOf = f => S.floors[f].rooms;
  where.addEventListener('click', e => { const el = /** @type {HTMLElement} */ (e.target).closest('[data-r]'); if (!el || U.blocking || S.fade) return; const id = /** @type {HTMLElement} */ (el).dataset.r; if (S.rooms[id] && S.rooms[id] !== S.room) W.travel(id); });
  const people = (R, on) => on.filter(m => m.room === R).length + (R.id === 'bar' ? 1 : 0) + (R === S.room ? 1 : 0);
  // (controls panel removed at the owner's request)
  const prompt = h('div', 'prompt'); root.appendChild(prompt);
  const toastEl = h('div', 'card toast'); root.appendChild(toastEl);
  const chat = h('div', 'chatp', '<div class="clog" aria-live="polite"></div><label class="cin"><input maxlength="120" placeholder="say something..." aria-label="Chat message"><kbd>Enter</kbd></label><div class="mutel" id="nr-mutel" aria-live="polite" hidden></div>'); root.appendChild(chat);
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
  // chat guard (chat-guard.js): no links, contact details, ads or spam. Caught = not posted + muted (2 min, 5 min, 1 h,
  // 1 day, 1 week; a step back down per clean day). No rules are shown: just the mute and how long is left.
  const guard = createGuard({
    load: () => { try { return JSON.parse(localStorage.getItem(GUARD_KEY) || 'null'); } catch { return null; } },
    save: st => { try { localStorage.setItem(GUARD_KEY, JSON.stringify(st)); } catch { /* storage off */ } },
  });
  const PH = new WeakMap(); // each input's normal placeholder
  const mmss = ms => { const sec = Math.max(0, Math.ceil(ms / 1000)); if (sec >= 3600 * 24) return `${Math.ceil(sec / 86400)}d`; if (sec >= 3600) return `${Math.ceil(sec / 3600)}h`; return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
  let srvMute = 0, srvBy = 'rules'; // the server's mute (multiplayer): same countdown in the input; by: 'admin' | 'rules'
  const muteL = /** @type {HTMLElement} */ (chat.querySelector('.mutel'));
  const muteEnd = () => { const now = Date.now(), g = guard.mutedUntil(); return Math.max(g, srvMute > now ? srvMute : 0); };
  U.serverMute = (until, by) => { srvMute = Math.max(0, Number(until) || 0); srvBy = by === 'admin' ? 'admin' : 'rules'; SFX.play('ui.deny'); const min = Math.max(1, Math.round((srvMute - Date.now()) / 60000)); toast(`Muted for ${min >= 1440 ? Math.round(min / 1440) + (min >= 2880 ? ' days' : ' day') : min >= 60 ? Math.round(min / 60) + (min >= 120 ? ' hours' : ' hour') : min + (min === 1 ? ' minute' : ' minutes')}`); showMute(); };
  const showMute = () => { const until = muteEnd(), now = Date.now();
    for (const inp of [chatIn, dIn]) { if (!PH.has(inp)) PH.set(inp, inp.placeholder);
      if (until) { inp.value = ''; inp.readOnly = true; inp.placeholder = `Muted · ${mmss(until - now)}`; inp.classList.add('muted'); }
      else if (inp.readOnly) { inp.readOnly = false; inp.placeholder = PH.get(inp) || ''; inp.classList.remove('muted'); } }
    // a visible line under the chat input says why (never the rules): who muted you and how long is left
    if (until) { const txt = `${srvMute > now && srvMute >= until && srvBy === 'admin' ? 'An admin muted you' : 'Muted'} · ${mmss(until - now)}`; if (muteL.textContent !== txt) muteL.textContent = txt; muteL.hidden = false; chatIn.setAttribute('aria-describedby', 'nr-mutel'); }
    else if (!muteL.hidden) { muteL.hidden = true; muteL.textContent = ''; chatIn.removeAttribute('aria-describedby'); } };
  U.guard = guard; U.openDm = n => talk(n); // talk: used by tests and the NPC interaction
  /** Run a message past the guard. Returns the text to post, or null (dropped; muted if it broke the rules). @param {string} v */
  const guardSay = v => { if (srvMute > Date.now()) { showMute(); return null; } const r = guard.check(v);
    if (r.ok) return r.text;
    if (r.muted) { if (r.fresh) { SFX.play('ui.deny'); toast(`Muted for ${r.minutes >= 1440 ? Math.round(r.minutes / 1440) + (r.minutes >= 2880 ? ' days' : ' day') : r.minutes >= 60 ? Math.round(r.minutes / 60) + (r.minutes >= 120 ? ' hours' : ' hour') : r.minutes + ' minutes'}`); } showMute(); }
    return null; };
  let creatorEl = null, toastT = 0;
  // live world closed for a reason the player should know (once per reason; consent / offline say nothing here)
  const LIVE_OFF = { kicked: 'You were removed from the live world', banned: "This account can't join the live world", elsewhere: 'You opened World somewhere else', deleted: 'Your account was deleted' };
  const liveBar = h('div', 'card livebar'); liveBar.setAttribute('role', 'alert'); liveBar.hidden = true; root.appendChild(liveBar); let liveBarT = 0;
  U.liveOff = why => { const t = LIVE_OFF[why]; if (!t) return; liveBar.innerHTML = `<span>${esc(t)}</span><button type="button" class="btn lbx" aria-label="Dismiss">OK</button>`; liveBar.hidden = false;
    /** @type {HTMLElement} */ (liveBar.querySelector('.lbx')).onclick = () => { liveBar.hidden = true; }; clearTimeout(liveBarT); liveBarT = setTimeout(() => { liveBar.hidden = true; }, 12000); };
  const toast = txt => { toastEl.textContent = txt; toastEl.style.display = 'block'; toastT = 2.8; SFX.play('ui.toast'); };
  // nameplates
  const plates = new Map();
  U.dropPlate = agent => { const p = plates.get(agent); if (p) { p.remove(); plates.delete(agent); } for (let i = bubbles.length - 1; i >= 0; i--) if (bubbles[i].agent === agent) { bubbles[i].b.remove(); bubbles.splice(i, 1); } };
  const plate = (agent, cls) => { let p = plates.get(agent); if (!p) { p = h('div', 'np ' + cls); root.appendChild(p); plates.set(agent, p); } return p; };
  const bubbles = [];
  // several lines from one person stack upward (newest lowest, nearest the head); at most 3 show, older ones shrink and fade
  U.bubble = (agent, txt, secs = 3, cls = '') => { if (!agent || !agent.root.parent?.visible || agent.root.parent.parent?.visible === false) return; const b = h('div', 'bub ' + cls, esc(txt)); root.appendChild(b); const uk = U.uiScale || 1; bubbles.push({ b, agent, t: Math.max(secs, 4), y: 0, w0: b.offsetWidth * uk, h0: b.offsetHeight * uk }); // on-screen size (scaled) // measured once (no per-frame layout reads)
    const mine = bubbles.filter(q => q.agent === agent); while (mine.length > 3) { const old = mine.shift(); old.b.remove(); bubbles.splice(bubbles.indexOf(old), 1); } };
  // chat log: what people say (plus ships), newest at the bottom, last 6 kept
  // the log scrolls (wheel / trackpad, native and smooth); a new line keeps it pinned to the bottom unless you've
  // scrolled up to read older ones; the last 100 lines kept, this visit only (never saved)
  // names in the chat look like the nameplates: the title font, coloured by level tier (owner: names must stand out)
  const levelOfName = who => { if (!who) return 0; if (who === 'You' || who === S.player?.name) return S.player?.level || 1;
    const m = S.members.find(x => x.d.name === who); if (m) return m.d.level; const lp = S.net?.byName(who); if (lp) return lp.level; return S.residents?.list.some(n => n.def.name === who) || who === 'Dex' ? -1 : 0; };
  const CHAT_KEEP = 100;
  const chatLine = (who, txt, cls = '') => { const pinned = clog.scrollHeight - clog.scrollTop - clog.clientHeight < 24;
    const lv = levelOfName(who), tc = lv === -1 ? 'npc' : lv > 0 ? 't' + tierOf(lv) : '';
    const d = h('div', 'cm ' + cls, `${who ? `<u class="${tc}">${esc(who)}${cls === 'live' ? LVM : ''}</u>` : ''}${esc(txt)}`); clog.appendChild(d); if (!chat.classList.contains('typing') && cls !== 'me') setUnread(unread + 1);
    while (clog.children.length > CHAT_KEEP) clog.firstChild?.remove(); /* only the last CHAT_KEEP lines, in memory only: nothing old is ever stored or reloaded */ if (pinned || cls === 'me') clog.scrollTop = clog.scrollHeight; };
  U.chatLine = chatLine;
  U.feed = () => {}; // the chat is for chat only (owner): ships are celebrated in the world, not posted here
  U.celebrate = m => { fx.confetti(m.agent.pos.clone()); }; // the line itself comes from the person (director), not a fixed 'shipped vX!'
  U.toast = toast;
  let profRet = /** @type {HTMLElement|null} */ (null), sureT = 0;
  prof.setAttribute('role', 'dialog'); prof.setAttribute('aria-modal', 'true');
  prof.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeAll(); } });
  const openProf = () => { const ae = /** @type {HTMLElement|null} */ (document.activeElement); profRet = ae && ae !== document.body && !prof.contains(ae) ? ae : null;
    prof.style.display = 'block'; U.blocking = true; /** @type {HTMLElement|null} */ (prof.querySelector('.x'))?.focus(); };
  const closeAll = () => { if (U.firstSetup) return; clearTimeout(sureT); const ret = prof.style.display === 'block' ? profRet : null; profRet = null; /* first visit: nothing closes the wardrobe but saving a name */ if (U.blocking && !document.body.classList.contains('in-act')) SFX.play('ui.close'); prof.style.display = mapP.style.display = 'none'; dlg.style.display = 'none'; talkingTo = null; U.talkingTo = null; chatBtn.classList.remove('hid'); chat.classList.remove('typing'); chatBtn.classList.remove('hid'); chatIn.blur(); U.talking = false; if (creatorEl) { creatorEl.remove(); creatorEl = null; S.me.av.setLook(S.player.look); } U.blocking = false; /** @type {HTMLElement} */ (document.activeElement)?.blur?.(); if (ret?.isConnected) ret.focus(); };
  U.closeAll = closeAll;
  // close buttons on the profile / map panels
  root.addEventListener('click', e => { if (/** @type {HTMLElement} */ (e.target)?.closest?.('.modal .x')) closeAll(); });
  const showProfile = m => { SFX.play('ui.open'); if (m.live) { liveProfile(m); return; }
    const d = m.d; prof.innerHTML = `<button class="x" type="button" aria-label="Close"><i></i></button><div class="head"><div class="portrait"><img src="${portrait(S.A, d.look, '#0e1014')}"></div><div><h2 id="nr-pname">${esc(d.name)}</h2><div class="title">${esc(d.title)}</div><span class="lvl">Lv ${d.level}</span></div></div>
      <div class="xp"><i style="width:${(d.level * 37) % 90 + 8}%"></i></div><div class="badges">${d.badges.map(b => `<span>${esc(b)}</span>`).join('')}</div>
      <div class="row"><span>status</span><span>${esc(m.statusText)}</span></div><div class="row"><span>room</span><span>${esc(m.room.meta.name)}</span></div><div class="row"><span>shipped</span><span>${d.shipped}</span></div>`;
    prof.setAttribute('aria-labelledby', 'nr-pname'); openProf();
  };
  // a real player's card (multiplayer): name, level, room, and Block / Report (report sends a reason to the server)
  const REASONS = ['Spam or ads', 'Harassment or hate', 'Sexual content', 'Cheating or exploits', 'Other'];
  const liveProfile = v => { const N = S.net, d = v.d, R = v.agent ? v.room : null, bl = N?.isBlocked(v.id), nm = esc(d.name);
    prof.innerHTML = `<button class="x" type="button" aria-label="Close"><i></i></button><div class="head"><div class="portrait"><img alt="" src="${portrait(S.A, { ...v.agent?.av?.look, ...d.look }, '#0e1014')}"></div><div><h2 id="nr-pname">${nm} ${LVM}${d.admin ? ' <b class="adm">admin</b>' : ''}</h2><div class="title">${esc(d.title)}</div><span class="lvl">Lv ${d.level}</span></div></div>
      <div class="row"><span>room</span><span>${esc(R?.meta?.name || '-')}</span></div><div class="row"><span>status</span><span>${v.p?.s?.coding ? 'coding at a PC' : 'hanging out'}</span></div>
      <div class="lvact"><button type="button" class="btn blk">${bl ? 'Unblock' : 'Block'}</button><button type="button" class="btn rep" aria-expanded="false" aria-controls="nr-rep">Report</button></div>
      <section class="lvrep" id="nr-rep" aria-labelledby="nr-why" hidden><h3 id="nr-why">Why are you reporting?</h3><div class="opts" role="radiogroup" aria-labelledby="nr-why">${REASONS.map((r2, i) => `<button type="button" class="btn opt" role="radio" aria-checked="false" tabindex="${i ? -1 : 0}" data-why="${esc(r2)}">${esc(r2)}</button>`).join('')}</div>
        <div class="lvrow"><button type="button" class="btn send" disabled>Send report</button><button type="button" class="btn cancel">Cancel</button></div></section>
      <div class="lvdone" hidden><p role="status">Sent. Thanks, we'll take a look.</p>${bl ? '' : '<button type="button" class="btn also">Also block</button>'}</div>
      ${N?.admin ? `<div class="lvadm"><span>Admin</span><button type="button" class="btn" data-mod="mute" data-min="60">Mute 1 h</button><button type="button" class="btn" data-mod="unmute">Unmute</button><button type="button" class="btn" data-mod="kick">Kick</button><button type="button" class="btn danger" data-mod="ban">Ban</button></div>
      <div class="lvsure" role="alertdialog" aria-labelledby="nr-sure" hidden><span id="nr-sure"></span><button type="button" class="btn no">Cancel</button><button type="button" class="btn danger go"></button></div>` : ''}`;
    prof.setAttribute('aria-labelledby', 'nr-pname');
    const $ = sel => /** @type {HTMLElement} */ (prof.querySelector(sel));
    const block = () => { if (!N) return; if (N.isBlocked(v.id)) { N.unblock(v.id); toast(`${d.name} unblocked`); } else { N.block(v.id); toast(`${d.name} blocked: you won't see their chat`); } closeAll(); };
    $('.blk').addEventListener('click', block);
    // report: a section asks why (one reason, radio-like), then Send / Cancel; sent = a thank-you and "Also block"
    const rep = $('.rep'), sec = $('.lvrep'), send = /** @type {HTMLButtonElement} */ ($('.send')), opts = [...prof.querySelectorAll('.opt')].map(o => /** @type {HTMLElement} */ (o)); let why = '';
    const pick = (o, focus) => { why = o.dataset.why || ''; for (const x of opts) { const on = x === o; x.setAttribute('aria-checked', String(on)); x.tabIndex = on ? 0 : -1; x.classList.toggle('on', on); } send.disabled = false; if (focus) o.focus(); };
    const closeRep = () => { sec.hidden = true; rep.setAttribute('aria-expanded', 'false'); rep.focus(); };
    rep.addEventListener('click', () => { const open = sec.hidden; if (!open) { closeRep(); return; } sec.hidden = false; rep.setAttribute('aria-expanded', 'true'); (opts.find(o => o.tabIndex === 0) || opts[0])?.focus(); });
    opts.forEach((o, i) => { o.addEventListener('click', () => pick(o, false));
      o.addEventListener('keydown', e => { const k = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0; if (!k) return; e.preventDefault(); const to = opts[(i + k + opts.length) % opts.length]; if (to) pick(to, true); }); });
    $('.cancel').addEventListener('click', closeRep);
    send.addEventListener('click', () => { if (!why || !N) return; N.report(v.id, why); sec.hidden = true; rep.hidden = true; rep.setAttribute('aria-expanded', 'false'); const done = $('.lvdone'); done.hidden = false; const also = /** @type {HTMLElement|null} */ (done.querySelector('.also')); (also || /** @type {HTMLElement} */ ($('.x'))).focus(); also?.addEventListener('click', block); });
    // admin tools (the owner's account): Kick and Ban ask in their own row (Cancel focused), disarmed after 4 s
    const sure = /** @type {HTMLElement|null} */ (prof.querySelector('.lvsure'));
    const disarm = (back) => { clearTimeout(sureT); if (!sure || sure.hidden) return; const hadFocus = sure.contains(document.activeElement); sure.hidden = true; if (hadFocus && back) back.focus(); };
    prof.querySelectorAll('[data-mod]').forEach(b => b.addEventListener('click', () => { const B = /** @type {HTMLElement} */ (b), act = /** @type {any} */ (B.dataset.mod);
      const run = () => { N?.mod(v.id, act, Number(B.dataset.min) || undefined); toast({ mute: `${d.name} muted for 1 hour`, unmute: `${d.name} unmuted`, kick: `${d.name} removed`, ban: `${d.name} banned` }[act] || 'Done'); closeAll(); };
      if ((act === 'kick' || act === 'ban') && sure) { const word = act === 'ban' ? 'Ban' : 'Kick'; $('#nr-sure').textContent = `${word} ${d.name}?`; const go = $('.lvsure .go'); go.textContent = word; go.className = 'btn go' + (act === 'ban' ? ' danger' : '');
        go.onclick = run; $('.lvsure .no').onclick = () => disarm(B); sure.hidden = false; $('.lvsure .no').focus(); clearTimeout(sureT); sureT = setTimeout(() => disarm(B), 4000); return; }
      run(); }));
    openProf(); };
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
    const txt = guardSay(dIn.value.trim()); dIn.value = ''; if (!txt) return; say('u', txt); U.history.push({ role: 'user', text: txt });
    const ty = say('n typing', ''); ty.innerHTML = '<i></i><i></i><i></i>';
    const r = talkingTo ? await S.residents.reply(talkingTo, U.history) : await npcReply(U.history, ctxFor()); ty.remove(); U.history.push({ role: 'npc', text: r }); if (U.history.length > 40) U.history.splice(0, U.history.length - 40); /* a DM keeps its last 40 lines, this visit only */
    const p = say('n', ''); let i = 0; const iv = setInterval(() => { p.textContent = r.slice(0, i += 2); log.scrollTop = 1e6; if (i >= r.length) clearInterval(iv); }, 18);
  });
  chatIn.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') closeAll(); if (e.key === 'Enter') { const v = chatIn.value.trim(); chatIn.value = ''; const ok0 = v ? guardSay(v) : null; const ok = ok0 ? slur(ok0, tipsyLevel(S)) : null; if (ok) { SFX.play('ui.send'); if (S.net?.online) S.net.chat(ok0); /* only what the player typed goes to the server (no drunk slur) */ /* online: the server's echo is what shows (net.js) */ else { U.bubble(S.me, ok, 4); chatLine('You', ok, 'me'); } } closeAll(); } });
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
  const peopleT = () => [...S.members, ...(S.net?.list || [])].filter(m => m.active && m.agent && m.agent.root.visible && m.agent.root.parent?.visible).map(m => ({ kind: 'member', m, label: m.d.name, at: m.agent, r: 0.45 }));
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
  // online save (owner: with the other icon buttons). The menu itself is the app's (it holds the save); this button asks
  // the app to open it just above the button, and the app tells us whether online save is on / failing ({t:'cloud'}).
  if (EMBED) {
    const cloud = ib('Online save', ICONS.cloudOff, () => { const r = cloud.getBoundingClientRect(); tellApp({ t: 'cloud-menu', rect: { x: r.left, y: r.top, w: r.width, h: r.height } }); });
    cloud.classList.add('cloud'); cloud.setAttribute('aria-haspopup', 'menu'); cloud.insertAdjacentHTML('beforeend', '<b class="dot" aria-hidden="true"></b>');
    U.setCloud = (/** @type {boolean} */ on, /** @type {string} */ status) => {
      cloud.classList.toggle('on', on); cloud.classList.toggle('err', on && status === 'error');
      /** @type {HTMLElement} */ (cloud.firstChild).style.setProperty('--m', pxMask(on ? ICONS.cloud : ICONS.cloudOff));
      const t = !on ? 'Online save (off)' : status === 'error' ? "Online save (can't reach the server)" : 'Online save (on)'; cloud.title = t; cloud.setAttribute('aria-label', t);
    };
  }
  // the app keeps the cloud button in step with the online save ({ gg:'world', t:'cloud', on, status })
  addEventListener('message', e => { if (!fromApp(e) || e.data?.gg !== 'world' || e.data.t !== 'cloud') return; U.setCloud?.(e.data.on === true, typeof e.data.status === 'string' ? e.data.status : ''); });
  ib('Map (M)', ICONS.map, () => openMap());
  ib('Wardrobe (C)', ICONS.shirt, () => { if (creatorEl) return; U.blocking = true; creatorEl = openCreator(S, root, () => { creatorEl?.remove(); creatorEl = null; U.blocking = false; }); });
  snd.className = 'key ib snd'; ibar.appendChild(snd);
  const MK = makeMarker(S); U.marker = MK;
  const PTR = initPointer(S, U, W, { targets, people: peopleT, interactWith, showProfile: m => showProfile(m), standUp, inReach });
  // emotes, keys 1-5 (owner): each a different funny thing. [emote, what the bubble says]
  let emoteAt = -1e9, emoteSaidAt = -1e9; // emote cooldowns (see the key handler)
  const EMO = { Digit1: ['wave', 'heyyy!'], Digit2: ['dance', '*hits the floss*'], Digit3: ['kiss', 'mwah'], Digit4: ['sleep', 'zzz... five more minutes'], Digit5: ['worm', '*does the worm*'] };
  const edit = initEdit(S, U, root);
  // room name: fades in at the top middle when you walk into a room (and on stairs / travel), then fades out
  const roomCard = h('div', 'roomcard'); root.appendChild(roomCard); let rcT = 0, rcId = '';
  const showRoom = R => { if (!R || R.id === rcId) return; rcId = R.id; roomCard.textContent = R.meta?.name || ROOM_NAMES[R.id] || R.id; roomCard.classList.remove('on'); void roomCard.offsetWidth; roomCard.classList.add('on'); clearTimeout(rcT); rcT = setTimeout(() => roomCard.classList.remove('on'), 2200); };
  S.hooks.push((kind, e) => {
    if (kind === 'room') { edit.stop(); showRoom(e); return; }
    if (kind === 'enter') { showRoom(e); closeAll(); edit.stop(); for (const [, p] of plates) { p.style.display = 'none'; p._vis = false; } return; }
    if (kind !== 'key') return;
    if (e.code === 'Escape') { closeAll(); edit.stop(); return; }
    if (U.blocking) return;
    if (e.code === 'KeyE') interact();
    if (e.code === 'Enter') { e.preventDefault(); openChat(); }
    if (e.code === 'KeyM') openMap();
    if (e.code === 'KeyC' && !creatorEl && !U.firstSetup) { U.blocking = true; creatorEl = openCreator(S, root, () => { creatorEl?.remove(); creatorEl = null; U.blocking = false; }); }
    if (e.code === 'KeyB') edit.toggle();
    // emotes (owner: no spamming 1-5): a new one only once the current one has had 1.5 s, and the line over your head at
    // most every 6 s; holding the key down does nothing extra. The emote you see is what others see (net.js sends it).
    const em = EMO[e.code];
    if (em && !S.seated && !e.repeat) { const now = performance.now();
      if (now - emoteAt < 1500) return;
      emoteAt = now; SFX.play('pop'); S.me.path = null; S.me.av.endEmote?.(); S.me.av.startEmote(em[0]); S.me.lockAnim = S.me.av.emT;
      if (now - emoteSaidAt > 6000) { emoteSaidAt = now; U.bubble(S.me, em[1], 2.5); } }
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
  const _scr = new THREE.Vector3(); let _sx = 0, _sy = 0;
  const scrXY = (o, y) => { _scr.copy(o); _scr.y = o.y + y; _scr.project(S.cam); _sx = (_scr.x + 1) / 2 * innerWidth; _sy = (1 - _scr.y) / 2 * innerHeight; };
  // cached plate entries (one per character on this floor), rebuilt only when S.plateGen / the floor changes
  /** @type {any[]} */ const ents = []; let entFloor = '', entGen = -1; const _meW = new THREE.Vector3();
  const ent = (a, cls, name, lv, stt, m) => ({ a, cls, name, lv, stt, m, wp: new THREE.Vector3(), vis: false, k: 3, dist: 0, lvN: 0 });
  const buildEnts = () => { entFloor = S.floor; entGen = S.plateGen | 0; ents.length = 0; ents.push(ent(S.me, 'me', '', 0, ''));
    if (S.floor === S.rooms.bar.floorId && S.dex) ents.push(ent(S.dex.agent, 'npc', 'Dex', 'bar', 'bartender'));
    for (const r2 of S.residents?.list || []) if (r2.R.floorId === S.floor) ents.push(ent(r2.agent, 'npc', r2.def.name, 'npc', r2.def.role));
    for (const m of S.members) if (m.agent) ents.push(ent(m.agent, '', '', 0, '', m));
    for (const v2 of S.net?.list || []) if (v2.agent) ents.push(ent(v2.agent, 'live', '', 0, '', v2));
    for (const [a, p] of plates) if (!ents.some(e => e.a === a)) { p._vis = false; p.style.display = 'none'; } };
  const entCmp = (A, B) => A.k - B.k || B.lvN - A.lvN;
  // coarse screen grid for plate overlap: 320 x 20 px cells, a linked list per cell (typed arrays, reused every frame)
  const GW = 320, GH = 20, GC = 16, GR = 64, MAXP = 512; const head = new Int16Array(GC * GR), nxt = new Int16Array(MAXP), PX = new Float32Array(MAXP), PY = new Float32Array(MAXP), PW = new Float32Array(MAXP); let nPl = 0;
  const cellX = x => Math.max(0, Math.min(GC - 1, Math.floor(x / GW))), cellY = y => Math.max(0, Math.min(GR - 1, Math.floor(y / GH)));
  const clash = (x, y, hw) => { const cx = cellX(x), cy = cellY(y);
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(GR - 1, cy + 1); gy++) for (let gx = Math.max(0, cx - 1); gx <= Math.min(GC - 1, cx + 1); gx++)
      for (let i = head[gy * GC + gx]; i >= 0; i = nxt[i]) if (Math.abs(PX[i] - x) < hw + PW[i] && Math.abs(PY[i] - y) < 19) return true;
    return false; };
  const place = (x, y, hw) => { if (nPl >= MAXP) return; const c = cellY(y) * GC + cellX(x); PX[nPl] = x; PY[nPl] = y; PW[nPl] = hw; nxt[nPl] = head[c]; head[c] = nPl++; };
  let hudT = 0; U.refreshHud = () => { hudT = 0; }; // the app sent the real level: redraw the HUD next frame
  let muteTick = 0, blurtT = 20;
  U.update = (dt, t) => {
    // drunk (level 3+): every so often you blurt something out loud on your own
    { const lv = tipsyLevel(S); if (lv >= 3 && !U.blocking) { blurtT -= dt; if (blurtT <= 0) { blurtT = 26 - lv * 4 + Math.random() * 10; const b = blurt(lv); if (b) { U.bubble(S.me, b, 3.5); chatLine('You', b, 'me'); } } } else blurtT = Math.max(blurtT, 12); }
    if ((muteTick -= dt) <= 0) { muteTick = 1; if (chatIn.readOnly || muteEnd()) showMute(); }
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
    // nameplates: the list is cached (rebuilt when who's on this floor changes), sorted in place, overlap checked on a
    // coarse screen grid, one transform write per plate (and only when it moved): no per-frame arrays or closures
    if (S.floor !== entFloor || (S.plateGen | 0) !== entGen) buildEnts();
    const meWp = S.me.root.getWorldPosition(_meW);
    for (const e of ents) { const a = e.a, m = e.m; e.vis = !!(a && a.root.visible && (!m || m.active) && a.root.parent?.visible);
      if (!e.vis) { e.k = 3; continue; } a.root.getWorldPosition(e.wp); e.dist = a === S.me ? 0 : e.wp.distanceTo(meWp); e.k = a === S.me ? 0 : e.dist < 2.6 ? 1 : 2;
      e.lvN = e.cls === 'me' ? S.player.level : Number(m ? m.d.level : e.lv) || 0; }
    ents.sort(entCmp);
    const pr = prompt.style.display === 'block' ? prompt.getBoundingClientRect() : null;
    head.fill(-1); nPl = 0;
    for (const e of ents) { const a = e.a, m = e.m, p = plate(a, e.cls);
      if (!e.vis) { if (p._vis !== false) { p._vis = false; p.style.display = 'none'; } p._off = null; continue; }
      if (p._vis !== true) { p._vis = true; p.style.display = 'flex'; }
      const full = a === S.me || e.dist < 2.6 || n?.at === a;
      const hw = (p._w || 80) / 2 + 6; // half the plate's last measured width (+ gap)
      scrXY(e.wp, 2.15); const x = _sx, baseY = _sy; let y = baseY;
      for (let k = 0; k < 8 && clash(x, y, hw); k++) y -= 20;
      if (pr && x + 60 > pr.left && x - 60 < pr.right && y > pr.top - 2 && y - 20 < pr.bottom + 2) { y = pr.top - 4; for (let k = 0; k < 8 && clash(x, y, hw); k++) y -= 20; }
      place(x, y, hw);
      // ease the stacking / step-aside offset (critically damped, ~0.15 s) so plates glide instead of jumping
      const want = y - baseY, fresh = p._off == null, off = fresh ? want : p._off + (want - p._off) * Math.min(1, dt * 12); p._off = off; y = baseY + off;
      const tx = Math.round(x * 2) / 2, ty = Math.round(y * 2) / 2; if (tx !== p._tx || ty !== p._ty) { p._tx = tx; p._ty = ty; p.style.transform = `translate(${tx}px,${ty}px) translate(-50%,-100%) scale(var(--ui,1))`; }
      const name = e.cls === 'me' ? S.player.name : m ? m.d.name : e.name, lv = e.cls === 'me' ? S.player.level : m ? m.d.level : e.lv, adm = e.cls === 'live' && !!m?.d?.admin;
      if (full !== p._hf || lv !== p._hl || name !== p._hn || adm !== p._ha) { p._hf = full; p._hl = lv; p._hn = name; p._ha = adm; const pc = plateClass(lv, full, e.cls); if (p.className !== pc) p.className = pc;
        /* owner: no status ("prompting") or title next to names; NPCs: their role in place of a level (so you can tell them from players) */
        p.innerHTML = e.cls === 'npc' ? `<span class="nm">${esc(name)}</span>${full ? `<span class="role">${esc(e.stt)}</span>` : ''}` : plateHTML({ lv, name, full }) + (e.cls === 'live' ? LVM : '') + (adm ? '<b class="adm">admin</b>' : ''); p._w = p.offsetWidth; }
      if (m && p._acc !== m.d.accent) { p._acc = m.d.accent; p.style.setProperty('--a', m.d.accent); }
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
      hudT = 0.5; const on = S.members.filter(m => m.status !== 'offline' && !m.liveHidden);
      // honest status: green "N online" only when connected (real players only), amber while (re)connecting, grey offline
      const NN = S.net, oc = NN?.online ? 'on' : NN?.state === 'connecting' ? 'wait' : 'off';
      const oh = oc === 'on' ? `<span class="dot"></span>${NN.count} <span class="mu">online</span>` : oc === 'wait' ? `<span class="dot"></span><span class="mu">${NN.retry ? 'reconnecting…' : 'connecting…'}</span>` : '<span class="dot"></span><span class="mu">offline</span>';
      if (online.dataset.h !== oh) { online.innerHTML = oh; online.dataset.h = oh; online.classList.remove('on', 'wait', 'off'); online.classList.add(oc); }
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
  // First visit (owner): the wardrobe opens by itself, titled "Welcome to World", and closes only with a name. Skipped when
  // the player already has a name here or from their online save. Waits for the world to be on screen first.
  U.maybeFirstSetup = () => {
    let done0 = false; try { done0 = !!localStorage.getItem(FIRST_KEY); } catch { /* storage off */ }
    if (done0 || creatorEl || U.blocking) return;
    if (S.player.namedHere) { try { localStorage.setItem(FIRST_KEY, '1'); } catch { /* storage off */ } return; }
    U.firstSetup = true; U.blocking = true;
    creatorEl = openCreator(S, root, () => { creatorEl?.remove(); creatorEl = null; U.blocking = false; U.firstSetup = false; }, { first: true });
  };
  return U;
}
