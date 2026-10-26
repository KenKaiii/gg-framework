// @ts-check
// Floors: all rooms of a floor visible together, walking across archways switches room, stairs change floor (fade).
import { makeFloorLights } from './floorlights.js';

/** @param {any} S */
export function initWorld(S) {
  const fadeEl = document.createElement('div');
  fadeEl.style.cssText = 'position:fixed;inset:0;background:#05060a;opacity:0;pointer-events:none;transition:opacity 250ms;z-index:50';
  document.body.appendChild(fadeEl);
  let doorCool = 0;
  const lights = {};
  const inBox = (R, x, z, m = 0) => x >= R.box.x0 - m && x <= R.box.x1 + m && z >= R.box.z0 - m && z <= R.box.z1 + m;
  const W = {
    lights,
    /** place an agent in a room (keeps its local position) */
    put(agent, R) { R.root.add(agent.root); agent.W = { scene: R.root, grid: R.grid }; },
    /** room on floor f containing world point */
    locate(x, z, f = S.floor) { for (const R of S.floors[f].rooms) if (inBox(R, x, z)) return R; return null; },
    /** world position of an agent standing in room R */
    world(agent, R) { return { x: agent.pos.x + R.root.position.x, z: agent.pos.z + R.root.position.z }; },
    /** move agent from room A to B keeping its world position (and its path) */
    shift(agent, A, B) {
      const dx = A.root.position.x - B.root.position.x, dz = A.root.position.z - B.root.position.z;
      agent.pos.x += dx; agent.pos.z += dz; if (agent.path) for (const p of agent.path) { p.x += dx; p.z += dz; }
      W.put(agent, B);
    },
    /** is local point (x,z) of room R walkable, here or in the neighbour room it falls into */
    freeAt(R, x, z) {
      if (R.grid.free(x, z)) return true;
      const wx = x + R.root.position.x, wz = z + R.root.position.z; if (inBox(R, wx, wz, -0.05)) return false;
      const O = W.locate(wx, wz, R.floorId); return !!O && O !== R && O.grid.free(wx - O.root.position.x, wz - O.root.position.z);
    },
    /** if the agent walked out of room R into a neighbour, re-home it; returns the room it is in */
    cross(agent, R) {
      const wx = agent.pos.x + R.root.position.x, wz = agent.pos.z + R.root.position.z;
      if (inBox(R, wx, wz)) return R; const O = W.locate(wx, wz, R.floorId); if (!O || O === R) return R;
      W.shift(agent, R, O); return O;
    },
    /** archways from room A to room B on the same floor (BFS), as world legs */
    legs(A, B) {
      if (A === B || A.floorId !== B.floorId) return [];
      const links = S.floors[A.floorId].links, prev = { [A.id]: null }, q = [A.id];
      while (q.length) { const id = q.shift(); if (id === B.id) break; for (const l of links) { const n = l.a === id ? l.b : l.b === id ? l.a : null; if (n && !(n in prev)) { prev[n] = { from: id, l }; q.push(n); } } }
      const out = []; for (let id = B.id; prev[id]; id = prev[id].from) { const { from, l } = prev[id]; const s = from === l.a ? 1 : -1; out.unshift({ to: id, ax: l.x - l.nx * 0.8 * s, az: l.z - l.nz * 0.8 * s, bx: l.x + l.nx * 0.9 * s, bz: l.z + l.nz * 0.9 * s }); }
      return out;
    },
    /** walk an agent (owned by mover with .room) to local (x,z) of room T across archways */
    route(mover, agent, T, x, z, cb, speed = 2.1) {
      const legs = W.legs(mover.room, T); let i = 0;
      const step = () => {
        const R = mover.room;
        if (i >= legs.length || R === T) { agent.walkTo(x, z, cb, speed); return; }
        const L = legs[i++], ox = R.root.position.x, oz = R.root.position.z;
        agent.walkTo(L.ax - ox, L.az - oz, () => { agent.path = [{ x: L.bx - ox, z: L.bz - oz }]; agent.onArrive = step; agent.speed = speed; }, speed);
      };
      step();
    },
    setRoom(R) { if (S.room === R) return; S.room = R; for (const f of S.hooks) f('room', R); },
    /** show floor f */
    showFloor(f) {
      for (const k in S.floors) S.floors[k].root.visible = k === f;
      S.floor = f; if (!lights[f]) lights[f] = makeFloorLights(S.floors[f]); S.perfCtl?.shadowDirty();
    },
    /** @param {string} id @param {string|null} from */
    enter(id, from) {
      const R = S.rooms[id]; if (!R) return; const me = S.me;
      W.showFloor(R.floorId);
      S.room = R; W.put(me, R); me.path = null; me.stand();
      const ex = from && R.exits.find(e => e.to === from);
      if (ex) { me.pos.set(ex.inside.x, 0, ex.inside.z); me.root.rotation.y = ex.face; }
      else if (id === 'bar' && !from && R.npc && !W.started) { const p = R.grid.nearestFree(R.npc.x + 0.4, R.npc.z + 1.9); me.pos.set(p.x, 0, p.z); me.root.rotation.y = Math.atan2(R.npc.x - p.x, R.npc.z - p.z); }
      else { me.pos.set(R.spawn.x, 0, R.spawn.z); me.root.rotation.y = R.spawn.face || 0; }
      W.started = true;
      S.target.set(me.pos.x + R.root.position.x, 0.6, me.pos.z + R.root.position.z); doorCool = 0.8;
      for (const f of S.hooks) f('enter', R);
    },
    /** go to a room: walk if it's on this floor, else fade to the other floor */
    travel(id, viaStairs) {
      const T = S.rooms[id]; if (S.fade || !T) return;
      // same floor and close (<= 2 archways, < 24 m): walk there; far rooms on the big floor: fade + teleport to its spawn
      const far = T.floorId === S.floor && (W.legs(S.room, T).length > 2 || Math.hypot(T.root.position.x - S.room.root.position.x, T.root.position.z - S.room.root.position.z) > 24);
      if (T.floorId === S.floor && !viaStairs && !far) { W.route({ get room() { return S.room; } }, S.me, T, T.spawn.x, T.spawn.z, null, 2.4); return; }
      const from = S.room.id; S.fade = true; fadeEl.style.opacity = '1';
      setTimeout(() => { W.enter(id, S.room.exits.some(e => e.to === id) ? from : null); fadeEl.style.opacity = '0'; setTimeout(() => { S.fade = null; }, 250); }, 250);
    },
    key(e) { for (const f of S.hooks) f('key', e); },
    update(dt, t) {
      const me = S.me; const R2 = W.cross(me, S.room); if (R2 !== S.room) W.setRoom(R2);
      const R = S.room;
      if ((doorCool -= dt) <= 0 && !S.fade) for (const ex of R.exits) if (Math.hypot(me.pos.x - ex.door.x, me.pos.z - ex.door.z) < 0.6) { W.travel(ex.to, true); break; }
      for (const f of S.hooks) f('tick', dt, t);
    },
  };
  return W;
}
