// @ts-check
// A walking/sitting character on the grid (used by members, the NPC and the player).
import * as THREE from 'three';
import { Avatar } from './avatar.js';

export class Agent {
  constructor(A, W, look, x, z) {
    this.W = W; this.av = new Avatar(A, look); this.root = this.av.root; this.root.position.set(x, 0, z); W.scene.add(this.root);
    this.path = null; this.onArrive = null; this.speed = 2.1; this.sitting = false; this.busyUntil = 0; this.face = null; this.lockAnim = 0;
  }
  get pos() { return this.root.position; }
  walkTo(x, z, cb, speed = 2.1) {
    this.stand(); this.speed = speed; const p = this.W.grid.path(this.pos.x, this.pos.z, x, z);
    this.path = p && p.length ? p : [{ x, z }]; this.onArrive = cb || null;
  }
  stand() { if (this.sitting) { this.sitting = false; this.root.position.y = 0; } }
  sit(seat, face) { this.path = null; this.sitting = true; this.root.position.set(seat.x, 0, seat.z); this.root.rotation.y = face; this.av.play('Sit_Chair_Idle', { fade: 0.35 }); }
  /** Play a one-shot reaction (cheer, interact...). Ignored while walking: feet moving always means the walk clip. */
  once(name, secs) { if (this.path && this.path.length) return; this.av.play(name, { once: true, fade: 0.2 }); this.lockAnim = secs; }
  turnTo(angle, dt, k = 8) { let d = angle - this.root.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d)); this.root.rotation.y += d * Math.min(1, dt * k); }
  /** @param {number} dt @param {boolean} [anim] false = off-screen: move along the path but skip the mixer */
  update(dt, anim = true) {
    if (this.lockAnim > 0) this.lockAnim -= dt;
    if (this.path && this.path.length) {
      const tgt = this.path[0], dx = tgt.x - this.pos.x, dz = tgt.z - this.pos.z, d = Math.hypot(dx, dz);
      const step = this.speed * dt;
      if (d <= step) { this.pos.x = tgt.x; this.pos.z = tgt.z; this.path.shift(); }
      else { this.pos.x += dx / d * step; this.pos.z += dz / d * step; this.turnTo(Math.atan2(dx, dz), dt, 10); }
      // moving always plays the walk/run clip and cancels any reaction lock (a sit or cheer pose must never slide)
      this.lockAnim = 0; if (this.av.em) this.av.endEmote?.(); /* clicking to walk ends an emote */ const run = this.speed > 3; const a = this.av.play(run ? 'Running_A' : 'Walking_A', { fade: 0.2 }); if (a) a.timeScale = Math.max(1, this.speed / (run ? 4.6 : 2.4)); // faster player (level) = faster stride
      this.av.fx.type = 0; this.av.fx.think = 0; this.av.rig.rotation.x = 0; // seated-only layers off while walking
      if (!this.path.length) { this.path = null; const cb = this.onArrive; this.onArrive = null; this.av.play('Idle'); cb && cb(); }
    } else if (!this.sitting && this.lockAnim <= 0) {
      if (this.face != null) this.turnTo(this.face, dt, 6);
      this.av.play('Idle');
    }
    if (anim) this.av.update(dt);
  }
}
