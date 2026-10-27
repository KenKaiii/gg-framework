// @ts-check
// Camera close-ups for activities. The main camera stays orthographic; a view = where to look, from which direction,
// how much of the world fits (zoom = half the visible height in world units), and the up vector.
//
//   import { setView, clearView, worldOf } from './view.js';
//   setView(S, { target: worldOf(R, x, 0.8, z), dir: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: -1 }, zoom: 1.6 }); // straight down
//   setView(S, { target: worldOf(R, tvX, 1.2, tvZ), dir: { x: 0.2, y: 0.35, z: 1 }, zoom: 1.4 });                 // over the shoulder
//   clearView(S);  // blends back to the iso camera (always call on exit)
//
// The blend takes ~0.6 s. While a view is set the walls between the camera and the target should not block it:
// call hideOccluders(S, target) to drop every wall on the floor to its low stub until clearView.
import * as THREE from 'three';

/** Room-local point -> world point. */
export function worldOf(R, x, y, z) { return new THREE.Vector3(x + R.root.position.x, y, z + R.root.position.z); }
/** @param {any} S @param {{target:THREE.Vector3, dir:{x:number,y:number,z:number}, up?:{x:number,y:number,z:number}, zoom:number}} v */
export function setView(S, v) { S.view = { target: v.target.clone(), dir: new THREE.Vector3(v.dir.x, v.dir.y, v.dir.z), up: v.up, zoom: v.zoom, speed: /** @type {any} */ (v).speed ?? 5 }; }
export function clearView(S) { S.view = null; S.wallsDown = false; }
/** Lower every wall on the current floor while a close-up is active (the main loop restores normal cutaways). */
export function hideOccluders(S) { S.wallsDown = true; }

/**
 * Hide people (NPCs, visitors and optionally the player) standing on the line between a close-up camera and its target.
 * Avatars are glTF 'Scene' nodes holding a rig with a 'head' bone; the inner node is hidden because the world culler drives the outer root.
 * Rescans once a second. Call tick(dt) each frame and restore() on close.
 * @param {any} S @param {any} root scene to search @param {THREE.Vector3} camT target @param {{x:number,y:number,z:number}} camD view dir (target -> camera)
 * @param {{ me?: boolean, radius?: number }} [o] me: also hide the player whatever their position
 */
export function hideBlockers(S, root, camT, camD, o = {}) {
  const r = o.radius ?? 1.5, L0 = Math.hypot(camD.x, camD.y, camD.z) || 1, dx = camD.x / L0, dy = camD.y / L0, dz = camD.z / L0;
  /** @type {Set<any>} */ const hidden = new Set(); const p = new THREE.Vector3(); let people = [], scanT = 0;
  const meRoot = S.me?.root, meVis = meRoot ? meRoot.visible : true;
  const scan = () => { const L = []; root.traverse(m => { if (m.name !== 'head') return; let n = m; while (n.parent && n.name !== 'Scene') n = n.parent; if (n.name !== 'Scene' || L.some(q => q.o === n)) return; let mine = false; for (let q = n; q; q = q.parent) if (q === meRoot) mine = true; if (!mine) L.push({ o: n, h: m }); }); people = L; };
  const tick = (dt = 1) => {
    if ((scanT -= dt) <= 0) { scanT = 1; scan(); }
    for (const { o: n, h } of people) {
      if (n.parent == null) continue; h.getWorldPosition(p);
      const vx = p.x - camT.x, vy = p.y - camT.y, vz = p.z - camT.z, along = vx * dx + vy * dy + vz * dz;
      const perp = Math.sqrt(Math.max(0, vx * vx + vy * vy + vz * vz - along * along)), block = along > (o.minAlong ?? 0.05) && perp < r; /* ortho camera: anything just in front of the target plane covers it */
      if (block && !hidden.has(n)) { hidden.add(n); n.visible = false; } else if (!block && hidden.has(n)) { n.visible = true; hidden.delete(n); }
    }
  };
  if (o.me && meRoot) meRoot.visible = false;
  tick();
  return { tick, restore() { for (const n of hidden) n.visible = true; hidden.clear(); if (o.me && meRoot) meRoot.visible = meVis; } };
}
