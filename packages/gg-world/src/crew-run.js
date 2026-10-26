// @ts-check
// Wires simulator -> members, celebrations, ambient chatter and the bartender into the world loop.
import { Member, tickFrame } from './crew.js';
import { Simulator, MEMBERS } from './simulator.js';
import { makeDex } from './npc.js';
import { PERSONAS } from './people/index.js';
import { lookFor } from './people/looks.js';
import { makeDirector } from './people/director.js';
import { makeResidents } from './people/residents-run.js';

/** @param {any} S @param {any} W */
export function initCrew(S, W) {
  const hooks = {
    feed: s => S.ui?.feed(s),
    bubble: (m, txt, secs, think) => S.ui?.bubble(m.agent, txt, secs, think ? 'think' : ''),
    celebrate: (m, v) => {
      S.ui?.feed(`${m.d.name} shipped ${v}`); S.lastShip = m.d.name;
      if (!m.active) return;
      S.ui?.celebrate(m);
      // everyone nearby reacts: seated people clap in their seat (arm layer), standing people cheer; walkers keep walking
      for (const o of S.members) if (o !== m && o.room === m.room && o.active && !o.agent.path && o.agent.av.currentName !== 'Cheer') { /* already cheering: restarting the clip would fade it in from 0 (T-pose dip) */ if (o.agent.sitting) o.agent.av.fx.clap = 2.2; else o.agent.once('Cheer', 2.4); }
      dir.status(m, 'shipped', { version: v }, S.t); S.residents?.shipped(m);
    },
  };
  // every member: a persona (how they talk / dress) + a unique look built from it (seeded by their name)
  for (const [i, d] of MEMBERS.entries()) { const P = PERSONAS[(i * 7 + d.id.length) % Math.max(1, PERSONAS.length)]; d.persona = P?.id; if (P) d.look = lookFor(P, d.id); }
  hooks.status = (m, type, ev) => dir.status(m, type, ev, S.t);
  // fake players until real people join (owner: ~25). Picked round-robin over home rooms so every room stays lived-in;
  // ?members=N overrides (A/B tests of crowd size)
  const maxM = +(location.search.match(/[?&]members=(\d+)/)?.[1] ?? 25);
  const byHome = new Map(); for (const d of MEMBERS) (byHome.get(d.home) || byHome.set(d.home, []).get(d.home)).push(d);
  S.homeRooms = byHome.size;
  const crowd = []; for (let k = 0; crowd.length < Math.min(maxM, MEMBERS.length); k++) for (const list of byHome.values()) if (list[k] && crowd.length < maxM) crowd.push(list[k]);
  if (!crowd.some(d => d.id === 'kai') && MEMBERS.find(d => d.id === 'kai') && crowd.length) crowd[crowd.length - 1] = MEMBERS.find(d => d.id === 'kai'); // the opening deploy
  S.members = crowd.map((d, i) => { const m = new Member(S.A, S, W, d, hooks, i); m.persona = d.persona; return m; });
  const dir = makeDirector(S); S.director = dir;
  S.residents = makeResidents(S, W);
  S.dex = makeDex(S, W);
  const sim = new Simulator(42); S.sim = sim;
  sim.on(ev => { const m = S.members.find(x => x.d.id === ev.memberId); if (m) m.event(ev); });
  for (const m of S.members) if (sim.offline.has(m.d.id)) m.event({ memberId: m.d.id, type: 'offline', at: 0 });
  S.hooks.push((kind, a, b) => {
    if (kind !== 'tick') return; const dt = a, t = b;
    sim.tick(dt, id => S.members.find(m => m.d.id === id)?.busy);
    tickFrame();
    for (const m of S.members) { m.update(dt, t); if (m.active) m.agent.av.fx.look = m.room === S.room && m.agent.pos.distanceTo(S.me.pos) < 2.8 ? S.me.pos : null; }
    S.dex.tick(dt, t);
    dir.update(dt, t); S.residents.tick(dt, t);
  });
}
