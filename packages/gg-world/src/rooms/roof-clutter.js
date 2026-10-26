// @ts-check
// The Roof: floor fill: pallet deck + outdoor rug under the seating, crates, a bike, cans,
// a speaker with an extension cord, and string-light reflections in the puddles.
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh } from './kit.js';
import * as TX from './tex.js';
import { crate as mkCrate } from './roof-zones.js';

/** @param {THREE.Group} S @param {THREE.Group} L @param {any} R @param {number} fx @param {number} fz fire-pit centre */
export function clutter(S, L, R, fx, fz) {
  // pallet deck under the fire lounge (low, walkable): one merged material pair
  const wood = mat('#5a4030', { roughness: 0.95 }), wood2 = mat('#4a3426', { roughness: 0.95 });
  for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) { const px = fx + gx * 1.2, pz = fz + gz * 1.2;
    for (let i = 0; i < 5; i++) put(S, rbox(0.2, 0.03, 1.15, i % 2 ? wood : wood2, 0.008), px - 0.48 + i * 0.24, 0.045, pz);
    for (const sz of [-0.5, 0, 0.5]) put(S, rbox(1.15, 0.03, 0.09, wood2, 0.006), px, 0.015, pz + sz); }
  const rug = mesh(new THREE.PlaneGeometry(2.6, 2.0), mat('#ffffff', { map: TX.rug('stripes', '#3a2a34', '#7a3e34', '#b08a5a', 12), roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
  rug.rotation.x = -Math.PI / 2; rug.position.set(fx, 0.065, fz + 0.9); S.add(rug);
  // speaker on a crate stack by the west parapet + green power LED
  const crate = mat('#6a4a2e', { roughness: 1 }), slat = mat('#4a3020');
  const mk = (x, y, z, ry) => put(S, mkCrate(), x, y, z, ry); void crate; void slat;
  const SX = -9.3, SZ = -1.2; mk(SX, 0, SZ, 0.2); mk(SX, 0.36, SZ + 0.02, -0.1); mk(SX + 0.5, 0, SZ + 0.3, 0.6); R.block(SX - 0.3, SZ - 0.3, SX + 0.85, SZ + 0.6);
  const spk = put(S, new THREE.Group(), SX, 0, SZ, 0.8); put(spk, rbox(0.32, 0.46, 0.28, mat('#1a181f', { roughness: 0.6 }), 0.04), 0, 0.95, 0);
  for (const [y, rr] of [[1.05, 0.09], [0.84, 0.06]]) { const c = mesh(new THREE.CylinderGeometry(rr, rr, 0.02, 16), mat('#2c2a34', { roughness: 0.4 })); c.rotation.x = Math.PI / 2; c.position.set(0, y, 0.14); spk.add(c); }
  put(spk, rbox(0.03, 0.03, 0.02, glowMat('#3ddc84', 3), 0.005), 0.1, 1.14, 0.14);
  // extension cord from the stairwell to the speaker
  const pts = [[-7.6, 0.02, -6.7], [-8.6, 0.02, -6.2], [-9.5, 0.02, -4.5], [-9.4, 0.02, -2.6], [-9.5, 0.6, -1.4]].map(p => new THREE.Vector3(...p));
  S.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 30, 0.018, 5), mat('#c86a1e', { roughness: 0.6 })));
  // bike leaning on the east parapet
  bike(S, 9.5, 1.6, Math.PI / 2); R.block(9.2, 0.6, 9.8, 2.6);
  // scattered cans (one instanced mesh)
  const cans = [[fx - 1.3, fz + 1.4, 1], [fx + 1.4, fz + 1.2, 0], [fx - 0.4, fz - 0.9, 1], [-5.5, 2.2, 0], [-3.9, 4.4, 1], [4.4, -1.1, 0], [5.9, -0.9, 1], [2.4, -5.9, 0], [3.6, -6.2, 1], [-1.3, -5.6, 0], [6.6, 4.4, 1], [-7.4, 5.0, 0]];
  const im = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.035, 0.035, 0.13, 10), mat('#9a3a2a', { metalness: 0.6, roughness: 0.35 }), cans.length), m4 = new THREE.Matrix4();
  cans.forEach(([x, z, lay], i) => { m4.makeRotationFromEuler(new THREE.Euler(0, i, lay ? Math.PI / 2 : 0)).setPosition(x, lay ? 0.035 : 0.065, z); im.setMatrixAt(i, m4); }); im.userData.noGround = true;
  S.add(im);
  // puddles + string-light reflections in them (instanced)
  const pm = mat('#141226', { roughness: 0.12, metalness: 0.5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }), refl = [];
  for (const [x, z, sx, sz] of [[-4.2, -3.2, 1.0, 0.55], [3.0, 2.6, 0.8, 0.45], [-3.0, 1.8, 0.6, 0.35], [1.2, -3.6, 0.7, 0.3], [6.0, 5.8, 0.6, 0.3]]) {
    const p = mesh(new THREE.CircleGeometry(1, 24), pm); p.rotation.x = -Math.PI / 2; p.scale.set(sx, sz, 1); p.position.set(x, 0.014, z); p.castShadow = false; p.userData.noGround = true; S.add(p);
    refl.push([x - sx * 0.3, z], [x + sx * 0.2, z - sz * 0.2], [x, z + sz * 0.3]); }
  const rm = new THREE.InstancedMesh(new THREE.CircleGeometry(0.05, 8), glowMat('#ffb36b', 1.4), refl.length);
  refl.forEach(([x, z], i) => { m4.makeRotationX(-Math.PI / 2).setPosition(x, 0.03, z); m4.scale(new THREE.Vector3(1, 1.8, 1)); rm.setMatrixAt(i, m4); }); rm.userData.noGround = true;
  S.add(rm);
}
function bike(S, x, z, ry) {
  const g = put(S, new THREE.Group(), x, 0, z, ry); const frame = mat('#2d6a6a', { metalness: 0.5, roughness: 0.4 }), tyre = mat('#141218', { roughness: 0.8 });
  for (const wx of [-0.5, 0.5]) { const t = mesh(new THREE.TorusGeometry(0.3, 0.03, 6, 20), tyre); t.position.set(wx, 0.33, 0); g.add(t); const hub = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.08, 8), frame); hub.rotation.x = Math.PI / 2; hub.position.set(wx, 0.33, 0); g.add(hub); }
  const bar = (a, b) => { const p = new THREE.Vector3(...a), q = new THREE.Vector3(...b), c = mesh(new THREE.CylinderGeometry(0.02, 0.02, p.distanceTo(q), 6), frame); c.position.copy(p).add(q).multiplyScalar(0.5); c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), q.clone().sub(p).normalize()); g.add(c); };
  bar([-0.5, 0.33, 0], [-0.05, 0.33, 0]); bar([-0.05, 0.33, 0], [-0.2, 0.75, 0]); bar([-0.05, 0.33, 0], [0.35, 0.75, 0]); bar([-0.2, 0.75, 0], [0.35, 0.75, 0]); bar([-0.5, 0.33, 0], [-0.2, 0.75, 0]); bar([0.5, 0.33, 0], [0.38, 0.85, 0]);
  put(g, rbox(0.22, 0.05, 0.1, tyre, 0.02), -0.22, 0.8, 0); put(g, rbox(0.04, 0.04, 0.45, tyre, 0.015), 0.38, 0.88, 0);
  g.rotation.x = -0.08;
}
