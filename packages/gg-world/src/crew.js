// @ts-check
// Members: home room + slot, driven by simulator events. Members on the visible floor animate (far ones at half rate),
// walk between rooms through archways and now and then take the stairs to another floor.
import { Agent } from './agent.js';
import { holdProp } from './rooms/props-hand.js';

const standPoint = (R, s) => R.grid.nearestFree(s.x + Math.sin(s.face || 0) * 0.75, s.z + Math.cos(s.face || 0) * 0.75);
let frame = 0; // shared frame counter for half-rate updates (advanced by tickFrame)
export const tickFrame = () => { frame++; };

export class Member {
  /** @param {any} A @param {any} S @param {any} W @param {any} d @param {any} hooks @param {number} idx */
  constructor(A, S, W, d, hooks, idx = 0) {
    this.S = S; this.W = W; this.d = d; this.hooks = hooks; this.status = 'prompting'; this.lastSeen = 1 + (d.level % 5); this.idx = idx; this.acc = 0;
    this.homeRoom = S.rooms[d.home] || S.rooms.bar; this.room = this.homeRoom; this.home = this.claim(this.homeRoom, true);
    this.slot = this.home; this.slotRoom = this.homeRoom; this.phase = 'seated'; this.timer = 0; this.prop = null;
    this.agent = new Agent(A, { scene: this.room.root, grid: this.room.grid }, d.look, 0, 0); W.put(this.agent, this.room);
    this.seat(this.home, 'laptop', this.homeRoom); this.apply('prompting');
  }
  get active() { return this.room.floorId === this.S.floor && this.status !== 'offline' && !this.liveHidden; } // liveHidden: real players took this spot (net.js top-up)
  get busy() { return this.phase !== 'seated'; }
  /** real players took this spot (net.js top-up): free the avatar entirely (not just hidden); unpark() rebuilds it */
  park() { if (this.parked) return; this.parked = true; this.phase = 'seated'; this.release(this.slot); this.glide = null; const a = this.agent; if (a) { a.av.dispose(); } this.agent = /** @type {any} */ (null); this.prop = null; }
  unpark() { if (!this.parked) return; this.parked = false; this.room = this.homeRoom; this.slot = this.home; this.slotRoom = this.homeRoom; this.phase = 'seated';
    this.agent = new Agent(this.S.A, { scene: this.room.root, grid: this.room.grid }, this.d.look, 0, 0); this.W.put(this.agent, this.room);
    this.homeRoom.taken?.add(this.home.id); this.seat(this.home, 'laptop', this.homeRoom); const st = this.status; this.apply(st === 'offline' ? 'offline' : st === 'deploying' ? 'prompting' : st); this.agent.root.visible = st !== 'offline'; }
  /** pick a free slot in room R (laptop-friendly first for home) */
  claim(R, laptop) {
    R.taken = R.taken || new Set(); const sl = R.slots.filter(s => !R.taken.has(s.id) && !s.act); // activity seats stay free for the player
    const pref = laptop ? sl.filter(s => s.prop === 'laptop' || s.anim !== 'Idle') : sl.filter(s => s.prop !== 'laptop');
    const pool = pref.length ? pref : sl; const s = pool[(this.idx * 7 + (this.S.sim?.t | 0)) % Math.max(1, pool.length)];
    if (!s) { const p = R.grid.nearestFree(R.spawn.x + ((this.idx % 5) - 2) * 0.8, R.spawn.z + ((this.idx % 3) - 1) * 0.8); return { id: 'free-' + this.d.id, x: p.x, z: p.z, face: (this.idx % 8) * 0.8, anim: 'Idle' }; }
    R.taken.add(s.id); return s;
  }
  release(s, R = this.slotRoom) { R.taken?.delete(s.id); }
  setProp(kind) {
    const av = this.agent.av; if (this.prop === kind) return;
    this.prop = kind; try { holdProp(av, kind); } catch (e) { /* prop optional */ }
  }
  seat(s, prop, R = this.slotRoom) {
    const a = this.agent; if (a.root.parent !== R.root) this.W.put(a, R); this.room = R;
    a.path = null; a.sitting = s.anim !== 'Idle'; a.root.position.set(s.x, s.y || 0, s.z); a.root.rotation.y = s.face || 0; a.face = s.face || 0;
    a.av.play(s.anim || 'Idle', { fade: 0.35 }); this.setProp(prop === undefined ? s.prop || null : prop);
  }
  apply(st) { this.status = st; const a = this.agent, fx = a.av.fx, seated = a.sitting && !a.path; fx.type = seated && st === 'prompting' ? 1 : 0; fx.think = seated && st === 'thinking' ? 1 : 0; a.av.rig.rotation.x = seated && st === 'thinking' ? -0.12 : 0; }
  /** walk to slot s of room R (through archways, or the stairs for another floor); off-screen moves are instant */
  goTo(R, s, prop, then) {
    const a = this.agent, done = () => { this.seat(s, prop, R); then && then(); };
    if (!this.active) { done(); return; }
    a.stand();
    if (R.floorId !== this.room.floorId) {
      const ex = this.room.exits.find(e => e.stairs) || this.room.exits[0];
      if (!ex) { done(); return; }
      this.W.route(this, a, this.room, ex.door.x, ex.door.z, done, 1.9); return;
    }
    const p = standPoint(R, s); this.W.route(this, a, R, p.x, p.z, done, 1.8);
  }
  moveTo(R, s, prop, then) { this.release(this.slot); this.slot = s; this.slotRoom = R; this.phase = 'walk'; this.goTo(R, s, prop, then); }
  event(ev) {
    if (this.parked) { if (ev.type === 'offline' || ev.type === 'online') this.status = ev.type === 'offline' ? 'offline' : 'prompting'; else if (this.status !== 'offline' && /^(prompting|thinking|idle)$/.test(ev.type)) this.status = ev.type; return; } // no avatar: only remember online / status
    const a = this.agent; const t = ev.type;
    if (t === 'offline') { this.apply('offline'); a.root.visible = false; this.phase = 'seated'; this.release(this.slot); this.slot = this.home; this.slotRoom = this.homeRoom; this.seat(this.home, 'laptop', this.homeRoom); this.lastSeen = 1 + (this.d.level % 4); this.hooks.feed(`${this.d.name} logged off`); return; }
    if (t === 'online') {
      a.root.visible = true; this.homeRoom.taken?.add(this.home.id); this.slot = this.home; this.slotRoom = this.homeRoom; this.apply('prompting'); this.hooks.feed(`${this.d.name} came online`);
      const ex = this.room.exits[0];
      if (this.active && ex) { a.stand(); a.root.position.set(ex.inside.x, 0, ex.inside.z); this.setProp(null); this.phase = 'walk'; this.goTo(this.homeRoom, this.home, 'laptop', () => { this.phase = 'seated'; this.apply('prompting'); }); }
      else this.seat(this.home, 'laptop', this.homeRoom);
      return;
    }
    if (this.status === 'offline') return;
    if (t === 'prompting' || t === 'thinking') {
      if (this.slot !== this.home || this.room !== this.homeRoom) { this.moveTo(this.homeRoom, this.home, 'laptop', () => { this.phase = 'seated'; }); this.homeRoom.taken?.add(this.home.id); }
      else { this.setProp('laptop'); if (!a.sitting && this.home.anim !== 'Idle') this.seat(this.home, 'laptop', this.homeRoom); }
      this.apply(t); this.hooks.status?.(this, t, ev);
    }
    if (t === 'deploying') { this.apply('deploying'); this.phase = 'deploy-watch'; this.timer = 2.4; this.version = ev.version || 'v1'; this.hooks.status?.(this, 'deploying', ev); }
    if (t === 'idle') {
      this.apply('idle'); const x = ((this.idx * 37 + (this.S.sim?.t | 0) * 13) % 100) / 100;
      const cur = this.room, same = this.S.floors[cur.floorId].rooms.filter(o => o === cur || (Math.hypot(o.root.position.x - cur.root.position.x, o.root.position.z - cur.root.position.z) < 20 && this.W.legs(cur, o).length <= 2)), all = Object.values(this.S.rooms); // nearby rooms only on the 62 m floor const all = Object.values(this.S.rooms);
      const R = x < 0.55 ? this.room : x < 0.9 ? same[(this.idx + (this.S.sim?.t | 0)) % same.length] : all[(this.idx * 3 + (this.S.sim?.t | 0)) % all.length];
      const s = this.claim(R, false); if (String(s.id).startsWith('free-') && R === this.room) { this.setProp('beer'); return; }
      const prop = s.prop && s.prop !== 'laptop' ? s.prop : (s.kind || '').match(/arcade|game|tv/) ? 'controller' : 'beer';
      this.homeRoom.taken?.add(this.home.id);
      this.moveTo(R, s, prop, () => { this.phase = 'seated'; });
      this.hooks.status?.(this, 'idle', ev);
    }
  }
  update(dt, t) {
    const a = this.agent; this.timer -= dt;
    if (this.liveHidden || !a) { if (a && a.root.visible) a.root.visible = false; return; } // a real player took this spot (net.js)
    if (this.phase === 'deploy-watch' && this.timer <= 0) {
      this.phase = 'deploy-cheer'; this.timer = 2.8; this.d.shipped++;
      if (this.active) { const y0 = a.root.position.y; a.stand(); a.root.position.y = y0; const p = standPoint(this.room, this.slot); this.glide = { fx: a.root.position.x, fz: a.root.position.z, tx: p.x, tz: p.z, t: 0, fy: y0, y: 0 }; a.once('Cheer', 2.6); this.setProp(null); }
      this.hooks.celebrate(this, this.version);
    } else if (this.phase === 'deploy-cheer' && this.timer <= 0) { this.phase = 'seated'; const s = this.slot, p0 = a.root.position; this.seat(s, this.slot === this.home ? 'laptop' : undefined); if (this.active) this.glide = { fx: p0.x, fz: p0.z, tx: s.x, tz: s.z, t: 0, fy: 0, y: s.y || 0 }; this.apply('prompting'); }
    if (!this.active) return;
    // short position glides (out of / back into a seat) so nobody teleports: 0.3 s ease
    if (this.glide) { const g = this.glide; g.t = Math.min(1, g.t + dt / 0.3); const k = g.t * g.t * (3 - 2 * g.t); a.root.position.x = g.fx + (g.tx - g.fx) * k; a.root.position.z = g.fz + (g.tz - g.fz) * k; if (g.y != null) a.root.position.y = (g.fy || 0) + (g.y - (g.fy || 0)) * k; if (g.t >= 1) this.glide = null; }
    // far from the camera target: animate at half rate
    this.acc += dt; const wp = this.S.wpos(a), tg = this.S.target;
    // off-screen (frustum + margin): hidden, no mixer; walking still advances so routes and room crossings stay right
    const seen = this.S.cull ? this.S.cull.sees(wp) : true; if (a.root.visible !== seen) a.root.visible = seen;
    if (!seen) { this.culled = true; const st = this.acc; this.acc = 0; if (a.path) { a.update(st, false); this.room = this.W.cross(a, this.room); } else if (a.lockAnim > 0) a.lockAnim -= st; return; }
    if (this.culled) { this.culled = false; a.av.update(0.5); } // back in view: settle crossfades that were frozen off-screen
    const dd = Math.hypot(wp.x - tg.x, wp.z - tg.z), far = dd > 11 && !a.path;
    if (far && (frame + this.idx) % 2) return;
    const step = this.acc; this.acc = 0;
    if (a.sitting && !a.path) { if (a.lockAnim <= 0 && a.av.currentName !== this.slot.anim) a.av.play(this.slot.anim, { fade: 0.3 }); a.av.update(step); }
    else { a.update(step); if (a.path) this.room = this.W.cross(a, this.room); }
    // status layers only while sitting at the slot (walking clears them in agent.update)
    if (a.sitting && !a.path) { a.av.fx.type = this.status === 'prompting' && this.prop === 'laptop' ? 1 : 0; a.av.fx.think = this.status === 'thinking' ? 1 : 0; a.av.rig.rotation.x = this.status === 'thinking' ? -0.12 : 0; }
  }
  get statusText() {
    return { prompting: 'prompting', thinking: 'thinking...', deploying: 'deploying', idle: 'on a break', offline: `last seen ${this.lastSeen}h ago` }[this.status] || this.status;
  }
}
