// @ts-check
// The director: who says what, when, and to whom.
//  - every room has a running THREAD (its last ~10 lines). People react to it: someone answers the last line, roasts it,
//    escalates it, and the first speaker sometimes comes back; players and NPCs both take part.
//  - lines come from (best first): the connected AI model (ai.js: whole scenes, written from the thread), the
//    combinatorial generator (grammar.js: thousands of combos + replies that echo what was said), each persona's own
//    written lines, room lines, time / weather lines, and the scripted conversations
//  - pacing: one shared speech budget (~1 line / 2.4 s in view), nobody twice within ~20 s, chatty personas more
//  - only people the player can see speak out loud; everyone keeps living (status, routines)
import { draw, fill, styled, rand, chance, pickOne, hourText, weatherText } from './talk.js';
import { PERSONAS, ROOM_LINES, CONVOS } from './index.js';
import { genLine, genReply, genFollow, keyWord } from './grammar.js';
import { askCrowd, aiConnected } from './ai.js';

export function makeDirector(S) {
  const byId = Object.fromEntries(PERSONAS.map(p => [p.id, p]));
  const personaOf = m => byId[m.persona] || PERSONAS[0];
  // a speaker = a member (player) or a resident (npc), wrapped the same way
  const wrapM = m => ({ key: m, name: m.d.name, agent: m.agent, room: m.room, kind: 'player', P: personaOf(m), m });
  const wrapN = n => ({ key: n, name: n.def.name, agent: n.agent, room: n.R, kind: 'npc', P: null, n });
  const speakers = () => [...S.members.filter(m => m.active && m.agent.root.visible && m.room.floorId === S.floor).map(wrapM),
    ...(S.residents?.list || []).filter(n => n.R.floorId === S.floor && n.agent.root.visible && S.ui?.talkingTo !== n).map(wrapN)];
  const threads = new Map(); const thread = R => threads.get(R) || threads.set(R, []).get(R);
  const lastSaid = new Map(); let nextT = 4, chain = null, lastSpeaker = null, queue = [], aiBusy = false, aiNext = 6;
  const st = () => S.outside?.state || {};
  const ctxBase = () => ({ player: S.player?.name || 'you', hour: hourText(st().hour ?? new Date().getUTCHours()), weather: weatherText(st().weather) });
  const paceOf = s => s.kind === 'npc' ? 0.7 : (s.P?.pace || 1);
  const canTalk = (s, t, gap = 20) => t - (lastSaid.get(s.key) ?? -99) > gap / paceOf(s);

  // shared budget: bursts of 2, refills one line per 2.4 s
  let tokens = 2, lastTok = 0; const spend = (t, need = 1) => { tokens = Math.min(2, tokens + (t - lastTok) / 2.4); lastTok = t; if (tokens < need) return false; tokens -= need; return true; };

  /** say a line out loud: bubble + chat log + thread */
  const say = (s, raw, t, o = {}) => { if (!raw) return null; const txt = (s.P && !o.ai ? styled : x => x)(fill(raw, { ...ctxBase(), me: s.name, room: s.room.meta?.name || s.room.id, other: o.other || '', ver: o.ver || 'v1' }), s.P?.style);
    if (!txt) return null; S.ui?.bubble(s.agent, txt, Math.min(6.5, 2.6 + txt.length * 0.06), o.cls || ''); /* the chat log is for REAL players only (owner): simulated members and NPCs speak in bubbles; real players' chat arrives through net.js */
    lastSaid.set(s.key, t); lastSpeaker = s.key; const th = thread(s.room); th.push({ name: s.name, text: txt, t, key: s.key }); if (th.length > 10) th.shift(); return txt; };
  const faceEach = (a, b) => { if (!a?.agent || !b?.agent || a.agent.sitting) return; a.agent.face = Math.atan2(b.agent.pos.x - a.agent.pos.x, b.agent.pos.z - a.agent.pos.z); };

  /** a fresh line from s (no reply): AI-free mix */
  const fresh = s => { const P = s.P, x = Math.random(), hr = st().hour ?? new Date().getUTCHours();
    if (s.kind === 'npc') return x < 0.55 ? draw(s.n.def.ambient) : x < 0.75 && ROOM_LINES[s.room.id] ? draw(ROOM_LINES[s.room.id]) : genLine();
    if (x < 0.34) return genLine();
    if (x < 0.62) return draw(P.idle);
    if (x < 0.76 && ROOM_LINES[s.room.id]) return draw(ROOM_LINES[s.room.id]);
    if (x < 0.84 && (hr >= 23 || hr < 5) && P.late) return draw(P.late);
    if (x < 0.84 && hr >= 6 && hr < 11 && P.morning) return draw(P.morning);
    if (x < 0.9 && st().weather === 'rain' && P.rain) return draw(P.rain);
    if (x < 0.9 && st().weather === 'clear' && P.clear) return draw(P.clear);
    return draw(P.idle); };

  /** start a reactive exchange in a room: someone says something, 1-3 others react, the first may come back */
  const startChain = (list, t) => {
    const byRoom = new Map(); for (const s of list) if (canTalk(s, t, 12)) (byRoom.get(s.room) || byRoom.set(s.room, []).get(s.room)).push(s);
    const rooms = [...byRoom.entries()].filter(([, ss]) => ss.length >= 2); if (!rooms.length) return false;
    const [R, ss] = pickOne(rooms); const th = thread(R), last = th[th.length - 1];
    const opener = last && t - last.t < 25 && ss.find(s => s.key !== last.key) ? null : pickOne(ss);
    // react to what's already in the thread, or open with something new; sometimes a written script instead
    if (!opener && last) { chain = { R, steps: [{ react: last }], cast: ss, i: 0, t: t + rand(0.8, 1.6) }; return true; }
    if (chance(0.25)) { const tagged = CONVOS.filter(c => c.room === R.id), pool = tagged.length && chance(0.5) ? tagged : CONVOS.filter(c => !c.room); const sc = draw(pool);
      if (sc) { const a = opener, rest = ss.filter(o => o !== a); chain = { R, script: sc, cast: { A: a, B: pickOne(rest), C: pickOne(rest) }, i: 0, t: t + 0.2 }; return true; } }
    chain = { R, steps: [{ open: opener }], cast: ss, i: 0, t: t + 0.2, turns: 1 + Math.floor(Math.random() * 3) }; return true; };
  const stepChain = t => {
    if (!chain || t < chain.t) return; const c = chain;
    if (c.script) { const [who, line] = c.script.lines[c.i]; const s = c.cast[who] || c.cast.A; if (!s || !s.agent.root.visible) { chain = null; return; }
      faceEach(s, who === 'A' ? c.cast.B : c.cast.A); const txt = say(s, fill(line, { A: c.cast.A?.name, B: c.cast.B?.name }), t); c.i++; c.t = t + rand(1.6, 2.6) + (txt?.length || 20) * 0.03;
      if (c.i >= c.script.lines.length) { chain = null; nextT = t + rand(3, 7); } return; }
    const th = thread(c.R), last = th[th.length - 1];
    if (c.i === 0 && c.steps[0].open) { say(c.steps[0].open, fresh(c.steps[0].open), t); c.first = c.steps[0].open; }
    else { // a reaction: someone other than the last speaker answers the last line
      const cands = c.cast.filter(s => s.key !== last?.key && s.agent.root.visible && canTalk(s, t, 6)); if (!cands.length || !last) { chain = null; return; }
      const back = c.first && c.first.key !== last.key && chance(0.35) && canTalk(c.first, t, 4) ? c.first : null; const s = back || pickOne(cands);
      faceEach(s, c.cast.find(x => x.key === last.key));
      const line = back ? genFollow(last.text, last.name)
        : c.cheer != null && c.i === 1 && s.kind === 'player' ? draw(c.cheer ? s.P.cheer : s.P.console)
        : c.cheer != null && c.i === 1 && s.kind === 'npc' ? draw(s.n.def.reactShip)
        : s.kind === 'npc' && chance(0.3) ? draw(s.n.def.ambient) : genReply(last.text, last.name);
      say(s, line, t, { other: last.name }); c.first = c.first || s; }
    c.i++; c.t = t + rand(1.4, 2.6); if (c.i > (c.turns ?? 1)) { chain = null; nextT = t + rand(3, 8); } };

  /** the connected model writes a scene for the player's room */
  const aiTick = async t => {
    if (aiBusy || t < aiNext || !aiConnected() || !S.room) return; const here = speakers().filter(s => s.room === S.room); if (here.length < 2) { aiNext = t + 5; return; }
    aiBusy = true; aiNext = t + rand(15, 25);
    const ppl = here.slice(0, 6).map(s => s.kind === 'npc' ? { name: s.name, kind: 'npc', role: s.n.def.role, about: s.n.def.personality } : { name: s.name, kind: 'player', about: s.P?.label || 'vibe coder', status: s.m.statusText });
    const ctx = { room: S.room.meta?.name || S.room.id, roomAbout: S.room.meta?.desc || '', ...ctxBase(), people: ppl, recent: thread(S.room).slice(-8).map(r => ({ name: r.name, text: r.text })), event: S.lastShip ? S.lastShip + ' shipped' : '' };
    const lines = await askCrowd(ctx); aiBusy = false; if (lines?.length) { const room = S.room; queue = lines.map(l => ({ ...l, room })); }
  };
  const playQueue = t => { if (!queue.length || t < nextT) return false; const q = queue[0]; const s = speakers().find(x => x.name === q.name && x.room === q.room);
    if (!s) { queue.shift(); return true; } if (!spend(t)) return true; queue.shift(); const th = thread(s.room), last = th[th.length - 1]; if (last) faceEach(s, speakers().find(x => x.key === last.key));
    say(s, q.text, t, { ai: true }); nextT = t + rand(1.6, 3.2); return true; };

  let greetT = 0; const greeted = new Set();
  return {
    personaOf, spend: (t, need = 1) => spend(t, need), thread,
    /** status change from the coding app (Member.event) */
    status(m, type, ev, t) {
      if (!m.active || !m.agent.root.visible) return; const s = wrapM(m), P = s.P;
      const pool = type === 'deploying' ? P.deploying : type === 'shipped' ? P.shipped : type === 'failed' ? P.failed : type === 'idle' ? P.breakTime : type === 'thinking' ? P.thinking : type === 'prompting' ? P.prompting : null;
      const loud = type === 'shipped' || type === 'failed';
      if (!pool || (type === 'deploying' && !chance(0.4)) || (!loud && type !== 'deploying' && (!chance(0.22) || !canTalk(s, t, 40)))) return;
      if (!spend(t, loud ? 0.5 : 1)) return;
      say(s, draw(pool), t, { ver: ev?.version || 'v1', cls: type === 'thinking' ? 'think' : '' });
      // a ship / fail starts an exchange: someone reacts (persona cheer / console or a generated reply), maybe more
      if (loud && !chain) { const near = speakers().filter(o => o.key !== m && o.room === m.room && canTalk(o, t, 8)); if (near.length) chain = { R: m.room, steps: [{ react: true }], cast: [s, ...near], i: 1, t: t + rand(0.9, 1.6), turns: 1 + Math.floor(Math.random() * 2), first: s,
        cheer: type === 'shipped' }; }
    },
    update(dt, t) {
      // runs 4x a second, not every frame (speech timing needs ~0.25 s precision at most)
      if (t < (this._nt || 0)) return; this._nt = t + 0.25;
      aiTick(t);
      if (chain) { stepChain(t); return; }
      if (playQueue(t)) return;
      if (t > greetT) { const near = speakers().filter(s => s.kind === 'player' && s.room === S.room && s.agent.pos.distanceTo(S.me.pos) < 1.8 && !greeted.has(s.key));
        if (near.length && chance(0.5)) { const s = near[0]; greeted.add(s.key); setTimeout(() => greeted.delete(s.key), 180000); greetT = t + 20; say(s, draw(s.P.greet), t); return; } }
      if (t < nextT) return; if (!spend(t)) { nextT = t + 1; return; }
      const list = speakers(); if (!list.length) { nextT = t + 3; return; }
      nextT = t + rand(3.5, 8) * (list.length < 4 ? 1.4 : 1);
      // mostly exchanges (people reacting to each other), sometimes a lone line that hangs in the air
      if (!queue.length && chance(0.7) && startChain(list, t)) return;
      const cands = list.filter(s => s.key !== lastSpeaker && canTalk(s, t)); if (!cands.length) return;
      let sum = 0; for (const s of cands) sum += paceOf(s); let x = Math.random() * sum;
      for (const s of cands) { x -= paceOf(s); if (x <= 0) { say(s, fresh(s), t); break; } }
    },
  };
}
