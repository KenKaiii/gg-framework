// @ts-check
// Residents: one NPC per room (content in residents-*.js). Each walks a routine round its room (stop -> act -> maybe a
// line -> wait -> next, randomised order and timing), turns to look at the player when near, greets now and then,
// reacts to ships in its room, and can be talked to (the dialog panel). Talking uses window.__npcBrain if the app
// connects an AI (with the resident's personality + context), else the resident's own talk table.
import { Agent } from '../agent.js';
import { RESIDENTS } from './index.js';
import { draw, fill, rand, chance, pickOne, hourText, weatherText } from './talk.js';

const ACTS = new Set(['Idle', 'Interact', 'PickUp', 'Use_Item', 'Spellcasting', 'Cheer', 'Unarmed_Idle']);

/** find a spot in room R matching a word (interactables / slots by id or label), else a random free cell */
function spotFor(R, word) {
  const w = String(word || 'any').toLowerCase();
  if (w !== 'any') {
    const hits = [...(R.interact || []).map(i => ({ x: i.x, z: i.z, r: i.r || 0.8, key: (i.id + ' ' + (i.label || '')).toLowerCase() })),
      ...(R.slots || []).map(s => ({ x: s.x, z: s.z, r: 0.5, key: (s.id + ' ' + (s.kind || '') + ' ' + (s.actLabel || '')).toLowerCase() }))].filter(h => h.key.includes(w));
    if (hits.length) { const h = pickOne(hits); const a = Math.random() * Math.PI * 2; const p = R.grid.nearestFree(h.x + Math.cos(a) * (h.r + 0.4), h.z + Math.sin(a) * (h.r + 0.4)); return { x: p.x, z: p.z, look: [h.x, h.z] }; }
  }
  for (let k = 0; k < 12; k++) { const x = rand(-R.w / 2 + 1, R.w / 2 - 1), z = rand(-R.d / 2 + 1, R.d / 2 - 1); if (R.grid.free(x, z)) return { x, z, look: null }; }
  const p = R.grid.nearestFree(R.spawn.x, R.spawn.z); return { x: p.x, z: p.z, look: null };
}

export function makeResidents(S, W) {
  const list = [];
  for (const def of (/[?&]nores/.test(location.search) ? [] : RESIDENTS)) { // ?nores: A/B perf
    const R = S.rooms[def.room]; if (!R || def.room === 'bar') continue;
    const st = spotFor(R, 'any'); const a = new Agent(S.A, { scene: R.root, grid: R.grid }, def.look, st.x, st.z); W.put(a, R); a.face = Math.random() * 6.28;
    list.push({ def, R, agent: a, i: Math.floor(Math.random() * Math.max(1, def.routine?.length || 1)), wait: rand(1, 5), walking: false, greetT: -99, sayT: rand(8, 30), seenT: 0, mem: { n: 0, name: null } });
  }
  const ctx = (n) => { const st = S.outside?.state || {}; return { me: n.def.name, player: S.player?.name || 'you', room: n.R.meta?.name || n.R.id, hour: hourText(st.hour ?? new Date().getUTCHours()), weather: weatherText(st.weather) }; };
  const speak = (n, pool, secs, force = false) => { if (!force && S.director && !S.director.spend(S.t, 1)) return; const line = draw(pool); if (!line) return; const txt = fill(line, ctx(n)); S.ui?.bubble(n.agent, txt, secs ?? Math.min(6.5, 2.6 + txt.length * 0.06)); };

  const api = {
    list,
    /** world-loop tick */
    tick(dt, t) {
      for (const n of list) {
        const a = n.agent, R = n.R, here = R.floorId === S.floor;
        if (!here) continue;
        const wp = S.wpos(a), seen = S.cull ? S.cull.sees(wp) : true; if (a.root.visible !== seen) a.root.visible = seen;
        // off-screen and idle: nothing to animate; just count down the wait (walking still advances so routes stay right)
        if (!seen && !a.path) { n.wait -= dt; n.acc = 0; continue; }
        const talkingToMe = S.ui?.talkingTo === n;
        const d = S.room === R ? a.pos.distanceTo(S.me.pos) : 99;
        if (talkingToMe) { a.path = null; n.walking = false; a.face = Math.atan2(S.me.pos.x - a.pos.x, S.me.pos.z - a.pos.z); a.update(dt, seen); continue; }
        a.av.fx.look = d < 3.2 ? S.me.pos : null;
        // greet when the player comes close (not every time)
        if (d < 2.0 && !n.walking && t - n.greetT > 45) { n.greetT = t; a.face = Math.atan2(S.me.pos.x - a.pos.x, S.me.pos.z - a.pos.z); if (seen && chance(0.7)) speak(n, n.def.greet, undefined, true); }
        // routine
        if (!n.walking && (n.wait -= dt) < 0 && d > 1.6) {
          const R2 = n.def.routine?.length ? n.def.routine : [{ at: 'any', act: 'Idle' }];
          n.i = chance(0.3) ? Math.floor(Math.random() * R2.length) : (n.i + 1) % R2.length; const stop = R2[n.i], sp = spotFor(R, stop.at);
          n.walking = true;
          a.walkTo(sp.x, sp.z, () => { n.walking = false; if (sp.look) a.face = Math.atan2(sp.look[0] - a.pos.x, sp.look[1] - a.pos.z);
            const act = ACTS.has(stop.act) ? stop.act : 'Idle'; if (act !== 'Idle') a.once(act, act === 'Cheer' ? 2.4 : 2.0);
            if (seen && stop.say?.length && chance(0.3)) setTimeout(() => speak(n, stop.say), 500);
            n.wait = rand(4, 11); }, rand(1.2, 1.7));
        }
        // ambient lines: rare, only in view, not while the player is chatting nearby
        // (ambient talk now comes from the director, so residents join in the room's conversation instead of monologuing)
        // far from the camera target: animate at half rate (like members); off-screen: no mixer at all
        n.acc = (n.acc || 0) + dt; const tg = S.target, far = seen && !a.path && Math.hypot(wp.x - tg.x, wp.z - tg.z) > 9;
        if (far && ((n.fr = (n.fr || 0) + 1) % 2)) continue; a.update(n.acc, seen); n.acc = 0;
      }
    },
    /** first line when the player opens a chat with a resident */
    opening(n) { const T = n.def.talk || {}; return fill(draw(T.hello || n.def.greet || ['Hey.']), ctx(n)); },
    /** someone shipped: the resident of that room reacts */
    shipped(m) { const n = list.find(x => x.R === m.room); if (n && n.agent.root.visible && chance(0.7)) setTimeout(() => { const line = draw(n.def.reactShip); if (line) S.ui?.bubble(n.agent, fill(line, { ...ctx(n), other: m.d.name }), 3.6); }, 1600); },
    /** the dialog: reply to the player */
    async reply(n, history) {
      const def = n.def, msg = (history.filter(h => h.role === 'user').pop()?.text || '').toLowerCase();
      // @ts-ignore
      if (typeof window.__npcBrain === 'function') { try { return String(await window.__npcBrain(history, { npc: { name: def.name, role: def.role, personality: def.personality, room: n.R.meta?.name }, ...ctx(n), online: S.members.filter(m => m.active).length })); } catch { /* fall back */ } }
      const T = def.talk || {}, has = (...w) => w.some(x => new RegExp('\\b' + x + '\\b', 'i').test(msg));
      const nameM = msg.match(/(?:my name is|i am|i'm|call me)\s+([a-z]{2,12})\b/i); if (nameM && !/^(fine|good|ok|tired|here|back|not|just|so|new|bored)$/.test(nameM[1])) { n.mem.name = nameM[1][0].toUpperCase() + nameM[1].slice(1); return `${n.mem.name}. Got it.`; }
      for (const [, tp] of Object.entries(T.topics || {})) if (tp.keys?.some(k => msg.includes(String(k).toLowerCase()))) return fill(draw(tp.lines), ctx(n));
      const c = { ...ctx(n), player: n.mem.name || ctx(n).player };
      const q = (...ps) => ps.some(r => r.test(msg));
      if (q(/\b(bye|later|cya|see ya|goodnight|good night|gotta go)\b/)) return fill(draw(T.bye), c);
      if (q(/\b(who are you|your name|about you|your story|who r u|yourself)\b/, /\bwho('s| is) (this|that)\b/)) return fill(draw(T.who), c);
      if (q(/\b(joke|funny|make me laugh)\b/)) return fill(draw(T.joke), c);
      if (q(/\b(this place|this room|in here|around here|what is this|what's this place)\b/)) return fill(draw(T.room), c);
      if (q(/\b(work|job|doing|busy|shift|recommend|suggest|what should i|what do you have|menu|special)\b/)) return fill(draw(T.work), c);
      if (q(/^(hi|hey|hello|yo|sup|evening|morning|hiya|howdy)\b/, /\b(how are you|how's it going|hows it going)\b/)) return fill(draw(T.hello), c);
      return fill(draw(T.unknown || ['Hm.']), c);
    },
  };
  return api;
}
