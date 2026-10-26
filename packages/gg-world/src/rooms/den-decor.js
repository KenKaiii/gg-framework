// @ts-check
// The Den, part 3: coffee table, loveseat, string lights, figure shelf, floor clutter (instanced / merged).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mat, glowMat, rbox, put, mesh, rng } from './kit.js';
import * as P from './den-props.js';

const WOOD = () => mat('#6a3f2c', { roughness: 0.7 }), WOOD_D = () => mat('#4a2a20', { roughness: 0.75 });

/** Low coffee table with controllers, cans, chips. */
export function coffeeTable() {
  const g = new THREE.Group(), w = WOOD(), d = WOOD_D();
  put(g, rbox(1.3, 0.06, 0.66, w, 0.025), 0, 0.36, 0);
  put(g, rbox(1.16, 0.03, 0.54, d, 0.01), 0, 0.1, 0);
  for (const x of [-0.58, 0.58]) for (const z of [-0.27, 0.27]) put(g, rbox(0.06, 0.36, 0.06, d, 0.015), x, 0.18, z);
  put(g, P.controller(), -0.3, 0.38, 0.1, 0.3); put(g, P.controller('#7a4fd8'), 0.2, 0.38, -0.12, -0.6);
  const cg = new THREE.CylinderGeometry(0.035, 0.035, 0.12, 12), cm = mat('#3ddc84', { metalness: 0.6, roughness: 0.35 });
  put(g, mesh(cg, cm), 0.45, 0.45, 0.15); put(g, mesh(cg, mat('#b04fd8', { metalness: 0.6, roughness: 0.35 })), 0.52, 0.45, -0.05);
  put(g, rbox(0.24, 0.05, 0.3, mat('#e63946', { roughness: 0.4, metalness: 0.3 }), 0.025), -0.4, 0.415, -0.15, 0.4);
  put(g, rbox(0.3, 0.04, 0.2, mat('#2a2a33', { roughness: 0.4, metalness: 0.3 }), 0.01), -0.3, 0.13, 0.05); // magazine/game on lower shelf
  return g;
}

/** Worn plum loveseat facing +z, seat top ~0.45. */
export function loveseat() {
  const g = new THREE.Group(), f = mat('#4a2440', { roughness: 0.95 }), f2 = mat('#5a2d4e', { roughness: 0.95 });
  put(g, rbox(1.9, 0.3, 0.85, f, 0.08), 0, 0.22, 0);
  for (const x of [-0.42, 0.42]) put(g, rbox(0.8, 0.16, 0.66, f2, 0.07), x, 0.43, 0.07);
  put(g, rbox(1.9, 0.5, 0.22, f, 0.1), 0, 0.6, -0.33).rotation.x = -0.12;
  for (const s of [-1, 1]) put(g, rbox(0.2, 0.32, 0.85, f, 0.09), s * 0.88, 0.48, 0);
  put(g, rbox(0.38, 0.32, 0.12, f2, 0.06), -0.55, 0.65, -0.18).rotation.set(-0.3, 0.3, 0.1);
  return g;
}

/** Fairy lights draped along a polyline of hooks (world coords). One tube + one instanced bulb mesh. */
export function stringLights(hooks, color = '#ffcf8a', per = 9) {
  const pts = []; for (let i = 0; i < hooks.length - 1; i++) for (let k = 0; k < per; k++) { const t = k / per; const p = hooks[i].clone().lerp(hooks[i + 1], t); p.y -= Math.sin(t * Math.PI) * 0.18; pts.push(p); }
  pts.push(hooks[hooks.length - 1].clone());
  const g = new THREE.Group();
  g.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 4, 0.013, 4), mat('#1a1420')));
  const im = new THREE.InstancedMesh(new THREE.SphereGeometry(0.042, 8, 6), glowMat('#ffffff', 1), pts.length);
  const m4 = new THREE.Matrix4(), c = new THREE.Color(), cols = [color, '#ff4fd8', '#b04fd8', color];
  pts.forEach((p, i) => { m4.makeTranslation(p.x, p.y - 0.03, p.z); im.setMatrixAt(i, m4); im.setColorAt(i, c.set(cols[i % 4]).multiplyScalar(1.2)); });
  im.userData.live = true; g.add(im); g.userData.bulbs = im; return g;
}

/** Wall shelf with little figures and a mini console (faces +z, back at z=0). */
export function figureShelf() {
  const g = new THREE.Group(), r = rng(9), w = WOOD();
  put(g, rbox(0.9, 0.04, 0.22, w, 0.01), 0, 0, 0.11);
  for (const x of [-0.38, 0.38]) put(g, rbox(0.03, 0.12, 0.12, WOOD_D(), 0.005), x, -0.07, 0.06);
  const cols = ['#3ddc84', '#b04fd8', '#3ddc84', '#b04fd8'];
  for (let i = 0; i < 4; i++) { const m = mat(cols[i], { metalness: 0.6, roughness: 0.35 }), x = -0.36 + i * 0.13; put(g, mesh(new THREE.CapsuleGeometry(0.025, 0.06, 4, 8), m), x, 0.07, 0.12); put(g, mesh(new THREE.SphereGeometry(0.03, 10, 8), m), x, 0.15, 0.12); }
  const c = P.consoleBox('#8f8aa6'); c.scale.setScalar(0.35); put(g, c, 0.25, 0.02, 0.11, -0.2);
  r(); return g;
}

/** Scattered floor clutter: game cases + energy cans (one mesh each, merged) + a hoodie. Positions in world xz. */
export function floorClutter(cases, cans) {
  const g = new THREE.Group(), r = rng(13);
  const cg = cases.map(([x, z]) => new THREE.BoxGeometry(0.19, 0.025, 0.26).rotateY(r() * 6.28).translate(x, 0.013, z));
  g.add(mesh(mergeGeometries(cg), mat('#2b6cff', { roughness: 0.5 })));
  const ng = cans.map(([x, z, lying]) => { const c = new THREE.CylinderGeometry(0.035, 0.035, 0.12, 10); if (lying) { c.rotateZ(Math.PI / 2); c.rotateY(r() * 6.28); c.translate(x, 0.035, z); } else c.translate(x, 0.06, z); return c; });
  g.add(mesh(mergeGeometries(ng), mat('#3ddc84', { metalness: 0.6, roughness: 0.35 })));
  return g;
}

/** Crumpled hoodie on the floor. */
export function hoodie(color = '#2b2d42') {
  const geo = new THREE.SphereGeometry(0.4, 20, 10); const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i); p.setXYZ(i, x * 1.2, Math.max(0, p.getY(i)) * 0.18 + Math.sin(x * 14) * Math.cos(z * 11) * 0.02 + 0.01, z); }
  geo.computeVertexNormals(); const g = new THREE.Group(); g.add(mesh(geo, mat(color, { roughness: 1 })));
  for (const s of [-1, 1]) { const a = mesh(new THREE.CapsuleGeometry(0.07, 0.4, 4, 8), mat(color, { roughness: 1 })); a.rotation.set(Math.PI / 2, 0, s * 0.9); a.position.set(s * 0.45, 0.05, 0.25); g.add(a); }
  return g;
}

/** Small table lamp (shade glows). */
export function tableLamp() {
  const g = new THREE.Group();
  put(g, mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.14, 12), mat('#3a2a34')), 0, 0.07, 0);
  const s = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.14, 16, 1, true), glowMat('#ffb36b', 1.3, { side: THREE.DoubleSide })); s.position.y = 0.2; g.add(s);
  return g;
}
