// @ts-check
// The Roof: hand-modelled props (all built at the origin, place with put()).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mat, glowMat, rbox, mesh, put } from './kit.js';
import * as TX from './tex.js';

const cyl = (rt, rb, h, m, s = 14) => mesh(new THREE.CylinderGeometry(rt, rb, h, s), m);
const metal = (c, r = 0.45) => mat(c, { metalness: 0.6, roughness: r });

/** Worn outdoor sofa, seat top ~0.45, faces +z. */
export function sofa(len = 2.2) {
  const g = new THREE.Group(), fab = mat('#4a3a4e', { roughness: 1 }), cush = mat('#5a4558', { roughness: 1 }), wood = mat('#3b2a22');
  put(g, rbox(len, 0.12, 0.9, wood, 0.03), 0, 0.14, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(g, rbox(0.08, 0.14, 0.08, wood, 0.01), sx * (len / 2 - 0.08), 0.07, sz * 0.36);
  for (let i = 0; i < 2; i++) put(g, rbox(len / 2 - 0.2, 0.2, 0.7, cush, 0.08), (i - 0.5) * (len / 2 - 0.15), 0.33, 0.07);
  put(g, rbox(len, 0.6, 0.2, fab, 0.08), 0, 0.5, -0.36);
  for (const sx of [-1, 1]) put(g, rbox(0.18, 0.5, 0.86, fab, 0.07), sx * (len / 2 - 0.09), 0.42, 0);
  for (let i = 0; i < 2; i++) put(g, rbox(len / 2 - 0.25, 0.4, 0.14, cush, 0.07), (i - 0.5) * (len / 2 - 0.15), 0.64, -0.22);
  for (const sx of [-1, 1]) { const a = mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.86, 14), fab); a.rotation.x = Math.PI / 2; put(g, a, sx * (len / 2 - 0.09), 0.68, 0); }
  for (let i = 0; i < 2; i++) put(g, rbox(len / 2 - 0.22, 0.004, 0.005, mat('#2a2030'), 0.001), (i - 0.5) * (len / 2 - 0.15), 0.432, 0.42);
  const pil = put(g, rbox(0.42, 0.36, 0.14, mat('#7a3e34', { roughness: 1 }), 0.07), -len / 2 + 0.42, 0.62, -0.2); pil.rotation.z = 0.25;
  return g;
}
/** Folding camp chair / plastic chair; seat ~0.45, faces +z. */
export function chair(color = '#2d4a5a') {
  const g = new THREE.Group(), m = mat(color, { roughness: 0.7 }), f = metal('#3a3a44');
  put(g, rbox(0.56, 0.06, 0.52, m, 0.03), 0, 0.42, 0);
  const b = put(g, rbox(0.56, 0.5, 0.05, m, 0.03), 0, 0.72, -0.26); b.rotation.x = -0.15;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const l = put(g, cyl(0.018, 0.018, 0.44, f, 6), sx * 0.24, 0.21, sz * 0.22); l.rotation.x = sz * 0.12; }
  for (const sx of [-1, 1]) put(g, rbox(0.05, 0.04, 0.46, f, 0.015), sx * 0.29, 0.62, 0);
  return g;
}
/** Old office chair someone dragged up. */
export function officeChair() {
  const g = new THREE.Group(), blk = mat('#1e1c24', { roughness: 0.6 }), m = metal('#55545e', 0.35);
  for (let i = 0; i < 5; i++) { const a = i * Math.PI * 2 / 5; const leg = put(g, rbox(0.34, 0.04, 0.05, m, 0.015), Math.cos(a) * 0.17, 0.06, Math.sin(a) * 0.17); leg.rotation.y = -a; put(g, mesh(new THREE.SphereGeometry(0.035, 8, 6), blk), Math.cos(a) * 0.32, 0.035, Math.sin(a) * 0.32); }
  put(g, cyl(0.03, 0.03, 0.3, m, 8), 0, 0.22, 0);
  put(g, rbox(0.52, 0.09, 0.5, blk, 0.04), 0, 0.41, 0);
  const bk = put(g, rbox(0.46, 0.62, 0.08, blk, 0.05), 0, 0.84, -0.27); bk.rotation.x = -0.25;
  put(g, rbox(0.4, 0.12, 0.06, mat('#3a2a34'), 0.03), 0.02, 0.78, -0.22); // duct tape patch
  return g;
}
/** Oil drum fire. Returns { g, fire } where fire is a live group (flames). */
export function drum() {
  const g = new THREE.Group(), rust = mat('#5a2c1e', { metalness: 0.35, roughness: 0.8 });
  const pts = []; for (let i = 0; i <= 10; i++) { const y = i * 0.07; pts.push(new THREE.Vector2(0.3 + ((i % 3 === 0) ? 0.015 : 0), y)); }
  const body = mesh(new THREE.LatheGeometry(pts, 20), mat('#5a2c1e', { metalness: 0.35, roughness: 0.8, side: THREE.DoubleSide })); g.add(body);
  for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; put(g, rbox(0.06, 0.12, 0.03, glowMat('#ff7a2a', 1.6), 0.01), Math.cos(a) * 0.31, 0.25, Math.sin(a) * 0.31, -a + Math.PI / 2); }
  put(g, cyl(0.29, 0.29, 0.02, mat('#140c0c')), 0, 0.62, 0);
  for (let i = 0; i < 5; i++) { const l = put(g, cyl(0.04, 0.04, 0.5, mat('#2a1a14'), 6), (i - 2) * 0.08, 0.68, (i % 2) * 0.08 - 0.04); l.rotation.z = Math.PI / 2; l.rotation.y = i; }
  void rust;
  const fire = new THREE.Group(); fire.userData.live = true; fire.position.y = 0.7; g.add(fire);
  for (let i = 0; i < 4; i++) { const f = mesh(new THREE.ConeGeometry(0.12 - i * 0.015, 0.4 + i * 0.05, 7), glowMat(i % 2 ? '#ffb347' : '#ff6a1f', 2.4)); f.castShadow = false; f.position.set(Math.sin(i * 2) * 0.08, 0.2, Math.cos(i * 2) * 0.08); fire.add(f); }
  return { g, fire };
}
/** Cooler full of beers (lid open). */
export function cooler() {
  const g = new THREE.Group(), shell = mat('#2b5a6e', { roughness: 0.55 }), lid = mat('#d8d2c4', { roughness: 0.6 });
  put(g, rbox(0.8, 0.45, 0.5, shell, 0.06), 0, 0.225, 0);
  put(g, rbox(0.72, 0.02, 0.42, mat('#9fc2cf', { roughness: 0.4 }), 0.005), 0, 0.47, 0);
  const l = put(g, rbox(0.82, 0.08, 0.52, lid, 0.04), 0, 0.6, -0.36); l.rotation.x = -1.2;
  const can = new THREE.CylinderGeometry(0.035, 0.035, 0.14, 10), cans = new THREE.InstancedMesh(can, mat('#c9a640', { metalness: 0.4, roughness: 0.55 }), 14), m4 = new THREE.Matrix4();
  for (let i = 0; i < 14; i++) { m4.makeRotationX(i % 3 ? 0.3 : 0).setPosition(-0.3 + (i % 7) * 0.1, 0.5, -0.1 + Math.floor(i / 7) * 0.16); cans.setMatrixAt(i, m4); }
  cans.castShadow = false; g.add(cans);
  for (const sx of [-1, 1]) put(g, rbox(0.04, 0.06, 0.2, mat('#1c1c22'), 0.01), sx * 0.41, 0.34, 0);
  return g;
}
/** Kettle grill on legs. */
export function grill() {
  const g = new THREE.Group(), blk = metal('#1d1b22', 0.5);
  const bowl = mesh(new THREE.SphereGeometry(0.3, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), mat('#1d1b22', { metalness: 0.6, roughness: 0.5, side: THREE.DoubleSide })); bowl.position.y = 0.72; g.add(bowl);
  const lid = mesh(new THREE.SphereGeometry(0.3, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), blk); lid.position.set(0.18, 0.78, 0); lid.rotation.z = -1.3; g.add(lid);
  for (let i = 0; i < 3; i++) { const a = i * 2.1; const l = put(g, cyl(0.02, 0.02, 0.75, blk, 6), Math.cos(a) * 0.17, 0.36, Math.sin(a) * 0.17); l.rotation.set(Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3); }
  put(g, cyl(0.27, 0.27, 0.02, glowMat('#ff5a1a', 0.9)), 0, 0.68, 0);
  return g;
}
/** Bucket plant. */
export function bucketPlant(seed = 1) {
  const g = new THREE.Group(), r = TX.rand(seed);
  const b = mesh(new THREE.CylinderGeometry(0.2, 0.16, 0.36, 14, 1, true), mat(r() < 0.5 ? '#6e7480' : '#7a4a2a', { metalness: 0.4, roughness: 0.6, side: THREE.DoubleSide })); b.position.y = 0.18; g.add(b);
  put(g, cyl(0.19, 0.19, 0.02, mat('#2a1e18')), 0, 0.33, 0);
  const leaf = mat(r() < 0.5 ? '#2f4a2c' : '#3a5530', { roughness: 0.9 });
  for (let i = 0; i < 7; i++) { const s = put(g, mesh(new THREE.SphereGeometry(0.1 + r() * 0.06, 7, 5), leaf), (r() - 0.5) * 0.25, 0.42 + r() * 0.35, (r() - 0.5) * 0.25); s.scale.y = 1.6; }
  return g;
}
/** Hammock on a frame, along x. */
export function hammock(len = 2.6) {
  const g = new THREE.Group(), wood = mat('#4a2c2a'), cloth = mat('#7a3e5a', { roughness: 1, side: THREE.DoubleSide });
  for (const sx of [-1, 1]) { const p = put(g, rbox(0.1, 1.3, 0.1, wood, 0.02), sx * len / 2, 0.65, 0); p.rotation.z = -sx * 0.2; }
  put(g, rbox(len + 0.4, 0.08, 0.12, wood, 0.02), 0, 0.04, 0);
  const geo = new THREE.PlaneGeometry(len - 0.4, 0.8, 16, 4); const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) { const u = p.getX(i) / (len - 0.4), v = p.getY(i) / 0.8; p.setZ(i, -(1 - 4 * u * u) * 0.45 + (1 - 4 * v * v) * -0.1); }
  geo.rotateX(-Math.PI / 2); geo.translate(0, 0.9, 0); geo.computeVertexNormals(); g.add(mesh(geo, cloth));
  for (const sx of [-1, 1]) { const rope = put(g, cyl(0.012, 0.012, 0.42, mat('#c8b896'), 4), sx * (len / 2 - 0.1), 1.0, 0); rope.rotation.z = sx * 1.1; }
  return g;
}
/** Satellite dish on a stand. */
export function dish() {
  const g = new THREE.Group(), w = mat('#8a8794', { metalness: 0.3, roughness: 0.5, side: THREE.DoubleSide });
  put(g, rbox(0.4, 0.06, 0.4, metal('#3a3a44'), 0.02), 0, 0.03, 0); put(g, cyl(0.03, 0.03, 0.9, metal('#55545e'), 8), 0, 0.48, 0);
  const d = mesh(new THREE.SphereGeometry(0.45, 18, 6, 0, Math.PI * 2, 0, 0.7), w); d.position.set(0, 1.0, 0); d.rotation.x = Math.PI / 2 + 0.6; g.add(d);
  const arm = put(g, cyl(0.012, 0.012, 0.5, metal('#55545e'), 5), 0, 1.15, 0.24); arm.rotation.x = 0.9;
  put(g, rbox(0.07, 0.07, 0.1, mat('#22222a'), 0.02), 0, 1.3, 0.42);
  const ant = put(g, cyl(0.01, 0.015, 1.6, metal('#55545e'), 5), 0.3, 0.8, -0.1);
  for (let i = 0; i < 4; i++) put(g, rbox(0.5 - i * 0.08, 0.015, 0.015, metal('#55545e'), 0), 0.3, 1.2 + i * 0.12, -0.1);
  void ant; return g;
}
/** Telescope on a tripod, tilted toward -z/-x (the moon). */
export function telescope() {
  const g = new THREE.Group(), m = metal('#c9c4b8', 0.35), blk = metal('#1d1b22', 0.4);
  for (let i = 0; i < 3; i++) { const a = i * 2.1; const l = put(g, cyl(0.015, 0.02, 1.0, blk, 6), Math.cos(a) * 0.18, 0.47, Math.sin(a) * 0.18); l.rotation.set(Math.sin(a) * 0.38, 0, -Math.cos(a) * 0.38); }
  const head = put(g, new THREE.Group(), 0, 0.95, 0, Math.PI * 0.75);
  const tube = mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.9, 14), m); tube.rotation.x = -Math.PI / 2 + 0.6; head.add(tube);
  const cap = mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.12, 14), blk); cap.position.set(0, 0.25, -0.38); cap.rotation.x = tube.rotation.x; head.add(cap);
  const lens = mesh(new THREE.CircleGeometry(0.06, 14), glowMat('#8fa8ff', 1.2)); lens.position.set(0, 0.31, -0.43); lens.rotation.x = 0.6 - Math.PI; head.add(lens);
  return g;
}
/** Server-fan exhaust vent glowing phosphor green (the Matrix touch). Returns { g, fans } (fans live). */
export function vent() {
  const g = new THREE.Group(), steel = metal('#4a4c58', 0.5);
  put(g, rbox(1.0, 0.8, 0.6, steel, 0.04), 0, 0.4, 0);
  put(g, rbox(1.04, 0.05, 0.64, metal('#5d6070'), 0.02), 0, 0.82, 0);
  for (let i = 0; i < 6; i++) put(g, rbox(0.86, 0.025, 0.04, metal('#2a2c34'), 0.01), 0, 0.15 + i * 0.1, 0.31);
  put(g, rbox(0.8, 0.6, 0.01, glowMat('#3ddc84', 1.3), 0), 0, 0.42, 0.295);
  const fans = []; for (const sx of [-0.25, 0.25]) { const f = new THREE.Group(); f.userData.live = true; f.position.set(sx, 0.84, 0); g.add(f); const bl = mesh(mergeGeometries([0, 1, 2, 3].map(k => new THREE.BoxGeometry(0.34, 0.012, 0.07).rotateY(k * Math.PI / 4))), mat('#20222a')); bl.castShadow = false; f.add(bl); fans.push(f); put(g, cyl(0.2, 0.2, 0.01, glowMat('#3ddc84', 1.8), 18), sx, 0.835, 0); }
  for (let i = 0; i < 3; i++) put(g, rbox(0.03, 0.03, 0.01, glowMat(i ? '#3ddc84' : '#ff3b3b', 2.5), 0.005), 0.4 - i * 0.06, 0.74, 0.305);
  const lbl = mesh(new THREE.PlaneGeometry(0.42, 0.1), new THREE.MeshBasicMaterial({ map: TX.label('ZION-EXHAUST-02', '#3ddc84', '#101418', 256, 64, '36px m5x7') })); lbl.position.set(-0.22, 0.76, 0.306); g.add(lbl);
  return { g, fans };
}
/** Pole with a small cap, height h. */
export function pole(h = 2.6) { const g = new THREE.Group(); put(g, rbox(0.08, h, 0.08, mat('#3b2a22'), 0.02), 0, h / 2, 0); put(g, cyl(0.16, 0.2, 0.2, mat('#3a3640'), 10), 0, 0.1, 0); return g; }
