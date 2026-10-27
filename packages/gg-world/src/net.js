// @ts-check
// GG World multiplayer, game side (docs/MULTIPLAYER.md sections 3-4). The app owns the socket and relays:
//   app -> game { t:'live', m } (server message) | { t:'live-status', state, world?, count? }
//   game -> app { t:'live', m } (client message)
// Sends our own state (throttled, only on change + a 5 s keepalive), draws other real players on our floor
// (interpolated ~120 ms behind), runs public chat through the server, the block list, report, and the
// simulated-members top-up. Pure parts live in net-core.js.
import * as THREE from 'three';
import { fromApp, tellApp, profileOf } from './bridge.js';
import { Agent } from './agent.js';
import { DEFAULT_LOOK } from './avatar.js';
import { leanBody, tipsyLevel } from './tipsy.js';
import { holdProp } from './rooms/props-hand.js';
import { packState, makeSender, cleanServer, makeTrack, pushSample, sampleAt, parseBlocked, addBlocked, removeBlocked, simTarget, othersOnly, BLOCK_KEY, EMOTES } from './net-core.js';

const CLIP = { idle: 'Idle', walk: 'Walking_A', run: 'Running_A', sit: 'Sit_Chair_Idle' };
/** one soft glow texture for "coding at a PC", shared by everyone */
let glowMat = /** @type {THREE.SpriteMaterial|null} */ (null);
const codingGlow = () => {
  if (!glowMat) { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); if (g) { const gr = g.createRadialGradient(32, 32, 2, 32, 32, 30); gr.addColorStop(0, 'rgba(160,255,200,.95)'); gr.addColorStop(0.35, 'rgba(61,220,132,.55)'); gr.addColorStop(1, 'rgba(61,220,132,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      g.fillStyle = '#0b0a12'; g.font = 'bold 18px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('</>', 32, 33); }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; glowMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }); }
  const sp = new THREE.Sprite(glowMat); sp.scale.set(0.55, 0.55, 1); sp.position.y = 2.05; sp.renderOrder = 5; return sp;
};

/** @param {any} S @param {any} W */
export function initNet(S, W) {
  /** @type {Map<string, any>} */ const players = new Map();
  const tx = makeSender(); let lookJson = '', lookAt = 0, stAt = 0;
  let blocked = parseBlocked((() => { try { return localStorage.getItem(BLOCK_KEY); } catch { return null; } })());
  const saveBlocked = () => { try { localStorage.setItem(BLOCK_KEY, JSON.stringify(blocked)); } catch { /* storage off */ } };
  const _o = { x: 0, z: 0, face: 0 }, _w = new THREE.Vector3();
  const N = {
    state: 'off', retry: false, reason: '', you: '', world: '', count: 0,
    get online() { return N.state === 'online'; },
    /** member-like views of the real players with an avatar (for nameplates, clicks): kept, not rebuilt per frame */
    list: /** @type {any[]} */ ([]),
    players,
    isBlocked: (/** @type {string} */ id) => blocked.includes(id),
    block(/** @type {string} */ id) { blocked = addBlocked(blocked, id); saveBlocked(); },
    unblock(/** @type {string} */ id) { blocked = removeBlocked(blocked, id); saveBlocked(); },
    report(/** @type {string} */ id, /** @type {string} */ reason) { send({ t: 'report', id, reason: String(reason).slice(0, 200) }); },
    chat(/** @type {string} */ text) { send({ t: 'chat', text: String(text).slice(0, 120) }); },
    /** admin only (the server ignores it from anyone else) @param {string} id @param {'mute'|'unmute'|'kick'|'ban'} act @param {number} [minutes] */
    mod(id, act, minutes) { send({ t: 'mod', id, act, ...(minutes ? { minutes } : {}) }); },
    admin: false,
    /** a real player's level by name (chat names) */
    byName(/** @type {string} */ name) { for (const p of players.values()) if (p.name === name) return p; return null; },
  };
  const send = (/** @type {any} */ m) => { if (N.online) tellApp({ t: 'live', m }); };

  // ── own state ──────────────────────────────────────────────────────────────────────────────
  const heldProp = () => { const c = S.me.root.userData.props; if (c) for (const k in c) if (c[k].visible) return k; return null; };
  const ownState = () => { const me = S.me, an = me.av.currentName || '';
    return packState({ floor: S.floor, room: S.room.id, x: me.pos.x, z: me.pos.z, face: me.root.rotation.y,
      anim: me.sitting ? 'sit' : /Running/.test(an) ? 'run' : /Walking/.test(an) ? 'walk' : 'idle', emote: EMOTES.includes(me.av.em) ? me.av.em : null,
      tipsy: tipsyLevel(S), prop: heldProp(), coding: !!S.coding }); };
  const lookNow = () => profileOf(S).look;
  const hello = () => { tx.reset(); const s = ownState(), look = lookNow(); lookJson = JSON.stringify(look); tx.want(s, performance.now()); tellApp({ t: 'live', m: { t: 'hello', look, level: S.player.level, s } }); };

  // ── other players ──────────────────────────────────────────────────────────────────────────
  const view = (/** @type {any} */ p) => ({ live: true, id: p.id, p, agent: null, room: null, statusText: '', active: true,
    d: { name: p.name, level: p.level, look: p.look, accent: '#3ddc84', title: p.admin ? 'admin' : 'online', admin: !!p.admin, badges: [], shipped: 0 } });
  const drop = (/** @type {any} */ p) => { if (!p.v?.agent) return; const a = p.v.agent; S.ui?.dropPlate?.(a); a.av.dispose(); p.v.agent = null; p.glow = null; p.propNow = undefined; p.v.room = null; const i = N.list.indexOf(p.v); if (i >= 0) N.list.splice(i, 1); S.plateGen = (S.plateGen | 0) + 1; };
  const add = (/** @type {any} */ P) => { const old = players.get(P.id); if (old) { drop(old); } const p = { ...P, track: makeTrack(), v: /** @type {any} */ (null), emote: null, phase: Math.random() * 6 };
    p.v = view(p); players.set(p.id, p); if (P.s) pushSample(p.track, performance.now(), P.s.x, P.s.z, P.s.face); return p; };
  const remove = (/** @type {string} */ id) => { const p = players.get(id); if (!p) return; drop(p); players.delete(id); };
  const clear = () => { for (const id of [...players.keys()]) remove(id); };
  /** an avatar only for players on our floor, in a room that exists */
  let budget = 0; // avatars created this frame (at most 2: 50 arriving at once must not stall a frame)
  const sync = (/** @type {any} */ p) => { const s = p.s, R = s && S.rooms[s.room];
    if (!s || !R || s.floor !== S.floor || R.floorId !== S.floor) { drop(p); return; }
    if (!p.v.agent) { if (budget >= 2) return; budget++; const a = new Agent(S.A, { scene: R.root, grid: R.grid }, { ...DEFAULT_LOOK, ...p.look }, s.x, s.z); a.root.rotation.y = s.face; a.isLive = true;
      p.v.agent = a; p.v.room = R; p.track.length = 0; pushSample(p.track, performance.now(), s.x, s.z, s.face); N.list.push(p.v); S.plateGen = (S.plateGen | 0) + 1; }
    else if (p.v.room !== R) { W.put(p.v.agent, R); p.v.room = R; p.track.length = 0; pushSample(p.track, performance.now(), s.x, s.z, s.face); } };

  const onServer = (/** @type {any} */ raw) => { const m = cleanServer(raw); if (!m) return; const now = performance.now();
    if (m.t === 'welcome') { clear(); N.you = m.you; N.world = m.world; N.admin = !!m.admin; /* only shows the admin tools: the server checks every action */ for (const P of m.players) if (P.id !== m.you) add(P); N.count = m.count; topUp(); }
    else if (m.t === 'join') { if (othersOnly(m.p.id, N.you)) add(m.p); }
    else if (m.t === 'leave') remove(m.id);
    else if (m.t === 'count') { N.count = m.n; topUp(); }
    else if (m.t === 'states') for (const [id, s] of m.u) { if (!othersOnly(id, N.you)) continue; /* the server includes our own entry: never an avatar for ourselves */ const p = players.get(id); if (!p) continue; const sameRoom = p.s && p.s.room === s.room; p.s = s; if (sameRoom) pushSample(p.track, now, s.x, s.z, s.face); else { p.track.length = 0; pushSample(p.track, now, s.x, s.z, s.face); } }
    else if (m.t === 'look') { const p = players.get(m.id); if (p) { p.look = m.look; p.v.d.look = m.look; p.v.agent?.av.setLook?.({ ...DEFAULT_LOOK, ...m.look }); } }
    else if (m.t === 'chat') { if (blocked.includes(m.id)) return; const U = S.ui; if (!U) return;
      if (m.id === N.you) { U.bubble(S.me, m.text, 4); U.chatLine('You', m.text, 'me'); }
      else { const p = players.get(m.id); if (p?.v.agent) U.bubble(p.v.agent, m.text, Math.min(6.5, 2.6 + m.text.length * 0.06)); U.chatLine(m.name, m.text, 'live'); } }
    else if (m.t === 'muted') S.ui?.serverMute?.(m.until, m.by); };

  // ── simulated members top up: max(0, 25 - real) visible, residents always stay ─────────────
  const topUp = () => { const ms = S.members || []; const keep = N.online ? simTarget(N.count) : ms.length;
    ms.forEach((/** @type {any} */ m, /** @type {number} */ i) => { const hide = i >= keep; if (!!m.liveHidden === hide) return; m.liveHidden = hide;
      // hidden = avatar disposed (GPU + mixer freed, plates dropped), rebuilt when they come back
      if (hide) { if (m.agent) S.ui?.dropPlate?.(m.agent); m.park?.(); } else m.unpark?.(); S.plateGen = (S.plateGen | 0) + 1; }); };

  addEventListener('message', e => { if (!fromApp(e)) return; const d = e.data; if (!d || d.gg !== 'world') return;
    if (d.t === 'live' && N.online) onServer(d.m);
    else if (d.t === 'live-status') { const st = d.state === 'online' || d.state === 'connecting' ? d.state : 'off', was = N.state; N.state = st;
      N.retry = st === 'connecting' && d.retry === true; const why = st === 'off' && typeof d.reason === 'string' ? d.reason.slice(0, 16) : '';
      if (why !== N.reason) { N.reason = why; if (why) S.ui?.liveOff?.(why); } /* once per reason: kicked / banned / elsewhere / deleted say why */
      if (typeof d.world === 'string') N.world = d.world.slice(0, 24); if (Number.isInteger(d.count)) N.count = Math.max(0, d.count);
      if (st === 'online' && was !== 'online') hello();
      if (st !== 'online' && was === 'online') { clear(); N.count = 0; }
      topUp(); S.ui?.refreshHud?.(); } });

  let netFrame = 0, lastShown = 0;
  // ── per frame ──────────────────────────────────────────────────────────────────────────────
  S.hooks.push((/** @type {string} */ kind, /** @type {number} */ dt, /** @type {number} */ t) => {
    if (kind !== 'tick' || !N.online) return; const now = performance.now();
    if (now - stAt >= 100) { stAt = now; const s = ownState(); if (tx.want(s, now)) tellApp({ t: 'live', m: { t: 'state', s } }); }
    if (now - lookAt > 2000) { lookAt = now; const L = lookNow(), j = JSON.stringify(L); if (j !== lookJson) { lookJson = j; send({ t: 'look', look: L }); } }
    budget = 0; const tg = S.target; netFrame++; let shown = 0;
    // crowded (more than 12 real players visible): those beyond 7 m from the camera target animate at half rate, on
    // alternating frames, with a double step (the simulated members already do this). Close players stay full rate.
    const crowded = lastShown > 12;
    for (const p of players.values()) { sync(p); const a = p.v.agent; if (!a) continue; const s = p.s, av = a.av;
      if (sampleAt(p.track, now, _o)) { a.pos.x = _o.x; a.pos.z = _o.z; a.root.rotation.y = _o.face; }
      // off-screen or far (> ~18 m from the camera target): invisible, no mixer (position still follows the server)
      a.root.getWorldPosition(_w); const seen = (!tg || Math.hypot(_w.x - tg.x, _w.z - tg.z) < 18) && (S.cull ? S.cull.sees(_w) : true);
      if (a.root.visible !== seen) a.root.visible = seen; if (!seen) { p.culled = true; continue; }
      if (p.culled) { p.culled = false; p.emote = undefined; }
      shown++; p.acc = (p.acc || 0) + dt;
      if (crowded && Math.hypot(_w.x - tg.x, _w.z - tg.z) > 7 && ((netFrame + p.phase * 10) | 0) % 2) continue;
      const step = p.acc; p.acc = 0;
      if (s.emote !== p.emote) { p.emote = s.emote; av.endEmote?.(); if (s.emote) av.startEmote(s.emote); }
      a.sitting = s.anim === 'sit';
      if (!av.em) { const c = av.play(CLIP[s.anim] || 'Idle', { fade: 0.2 }); if (c && (s.anim === 'walk' || s.anim === 'run')) c.timeScale = 1; }
      av.update(step);
      if (s.tipsy) leanBody(av, Math.sin(t * (0.55 + s.tipsy * 0.08) + p.phase) * (s.tipsy / 5) * 0.22);
      if (p.propNow !== s.prop) { p.propNow = s.prop; try { holdProp(av, s.prop); } catch { /* prop optional */ } }
      if (s.coding && !p.glow) { p.glow = codingGlow(); a.root.add(p.glow); }
      if (p.glow) p.glow.visible = s.coding; }
    lastShown = shown;
  });
  /** Dev/perf only (window.__fakeLive(n) in tools): feed n fake real players through the same path as the server. */
  /** @type {any} */ (window).__fakeLive = (/** @type {number} */ n = 50) => {
    const sp = S.room?.spawn || { x: 0, z: 0 }, P = [];
    for (let i = 0; i < n; i++) P.push({ id: 'f' + i, name: 'P' + i, level: 1 + i, look: {}, s: { floor: 'main', room: 'bar', x: sp.x + (i % 10) - 5, z: sp.z + Math.floor(i / 10) - 2, face: 0, anim: 'walk' } });
    N.state = 'online'; onServer({ t: 'welcome', you: 'me', world: 'w1', players: P, count: n + 1 });
    let k = 0; setInterval(() => { k += 0.1; onServer({ t: 'states', u: P.map((p, i) => [p.id, { ...p.s, x: p.s.x + Math.sin(k + i) * 2, z: p.s.z + Math.cos(k * 0.7 + i) * 1.5, face: k + i }]) }); }, 100);
  };
  return N;
}
