// @ts-check
// Doc's Garage: gear (ghost-busting kit, workbench, pegboard, stools, dog bed + sleeping dog).
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh, rng } from './kit.js';
import { black, gunmetal, steel } from './garage-props.js';

const wood = () => mat('#5a3c26', { roughness: 0.8 });

/** Proton pack on a little rack (faces +z). */
export function protonPack() {
  const g = new THREE.Group(), olive = mat('#3a3f34', { roughness: 0.7 });
  put(g, rbox(0.7, 0.9, 0.06, gunmetal(), 0.02), 0, 1.0, -0.12); for (const x of [-0.32, 0.32]) put(g, rbox(0.05, 1.0, 0.05, gunmetal()), x, 0.5, -0.12);
  put(g, rbox(0.5, 0.62, 0.24, olive, 0.04), 0, 1.0, 0.02);
  const cyc = mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 20), black()); cyc.rotation.x = Math.PI / 2; put(g, cyc, 0, 0.7, 0.1);
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.78; put(g, rbox(0.06, 0.06, 0.03, glowMat('#ff3a2a', 1.2), 0.01), Math.cos(a) * 0.13, 0.7 + Math.sin(a) * 0.13, 0.17); }
  put(g, rbox(0.12, 0.3, 0.1, mat('#7a7d84', { metalness: 0.6 }), 0.02), 0.18, 1.2, 0.18);
  const hose = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(-0.22, 0.8, 0.12), new THREE.Vector3(-0.4, 0.5, 0.25), new THREE.Vector3(-0.42, 0.85, 0.32)]), 12, 0.025, 6), black());
  g.add(hose); put(g, rbox(0.08, 0.1, 0.42, olive, 0.02), -0.42, 0.95, 0.32);
  return g;
}

/** Ghost trap with two lids (live, returned) + pedal on a cable. */
export function ghostTrap() {
  const g = new THREE.Group(); put(g, rbox(0.46, 0.14, 0.26, mat('#2c2e34', { metalness: 0.5 }), 0.03), 0, 0.09, 0);
  for (const x of [-0.24, 0.24]) put(g, rbox(0.03, 0.08, 0.2, mat('#d8b23a', { roughness: 0.5 }), 0.01), x, 0.1, 0);
  const lids = [-1, 1].map(s => { const l = new THREE.Group(); l.position.set(0, 0.17, s * 0.12); l.userData.live = true; put(l, rbox(0.42, 0.025, 0.12, mat('#4a4d54', { metalness: 0.6 }), 0.01), 0, 0, -s * 0.06); l.userData.s = s; g.add(l); return l; });
  const led = rbox(0.04, 0.03, 0.02, glowMat('#ff3a2a', 1.2), 0.01); led.position.set(0.16, 0.12, 0.135); led.userData.live = true; g.add(led);
  const cable = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(-0.23, 0.05, 0), new THREE.Vector3(-0.5, 0.01, 0.2), new THREE.Vector3(-0.8, 0.01, 0.1)]), 10, 0.012, 5), black());
  g.add(cable); put(g, rbox(0.14, 0.05, 0.2, mat('#d8b23a'), 0.02), -0.85, 0.03, 0.1);
  return { g, lids, led };
}

/** Containment unit (tall, faces +z): red/green lights live. */
export function containment() {
  const g = new THREE.Group(), body = mat('#6a6c70', { metalness: 0.5, roughness: 0.5 });
  put(g, rbox(1.0, 2.0, 0.55, body, 0.04), 0, 1.0, 0); put(g, rbox(0.6, 0.5, 0.04, mat('#2c2e34'), 0.02), 0, 1.35, 0.28);
  put(g, rbox(0.3, 0.12, 0.08, mat('#d8b23a'), 0.02), 0, 0.85, 0.3); const lever = rbox(0.04, 0.3, 0.04, mat('#a8342a'), 0.01); put(g, lever, 0.32, 1.0, 0.32).rotation.z = 0.4;
  for (let i = 0; i < 6; i++) put(g, rbox(0.9, 0.02, 0.02, mat('#d8b23a'), 0.005), 0, 0.15 + i * 0.05, 0.285);
  const lights = [glowMat('#ff3a2a', 2.21), glowMat('#3ddc84', 2.21)];
  for (let i = 0; i < 6; i++) { const red = i < 3; put(g, rbox(0.07, 0.07, 0.03, lights[red ? 0 : 1], 0.015), -0.2 + (i % 3) * 0.2, red ? 1.75 : 1.65, 0.285); }
  const pipe = mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 8), gunmetal()); put(g, pipe, -0.45, 2.2, 0); return { g, lights };
}

/** Workbench (faces +z) with a vise, toolbox and scattered parts. */
export function workbench(len = 2.6, seed = 1) {
  const g = new THREE.Group(), r = rng(seed); put(g, rbox(len, 0.09, 0.8, wood(), 0.02), 0, 0.92, 0);
  for (const x of [-len / 2 + 0.1, len / 2 - 0.1]) for (const z of [-0.32, 0.32]) put(g, rbox(0.08, 0.9, 0.08, gunmetal(), 0.01), x, 0.45, z);
  put(g, rbox(len - 0.2, 0.04, 0.7, wood(), 0.01), 0, 0.25, 0);
  put(g, rbox(0.5, 0.3, 0.3, mat('#a8342a', { roughness: 0.5 }), 0.03), -len / 2 + 0.4, 0.42, -0.05);   // toolbox under
  put(g, rbox(0.2, 0.14, 0.18, gunmetal(), 0.02), len / 2 - 0.25, 1.04, 0.25);                          // vise
  put(g, rbox(0.14, 0.04, 0.04, steel(), 0.01), len / 2 - 0.25, 1.06, 0.38);
  for (let i = 0; i < 5; i++) { const w = 0.08 + r() * 0.16; put(g, rbox(w, 0.04 + r() * 0.08, w, [gunmetal(), mat('#7a5236', { metalness: 0.6 }), black()][i % 3], 0.01), -len / 2 + 0.3 + r() * (len - 0.6), 0.99, -0.25 + r() * 0.15, r() * 3); }
  const lamp = mesh(new THREE.ConeGeometry(0.1, 0.14, 12, 1, true), mat('#2d6a3a', { metalness: 0.4, side: THREE.DoubleSide })); put(g, lamp, len / 2 - 0.6, 1.35, -0.2).rotation.z = 0.5;
  put(g, rbox(0.02, 0.4, 0.02, gunmetal()), len / 2 - 0.5, 1.15, -0.25);
  return g;
}

/** Free-standing pegboard (faces +z) with tool silhouettes. */
export function pegboard(w = 2.6) {
  const g = new THREE.Group(); put(g, rbox(w, 1.3, 0.04, mat('#6a5038', { roughness: 0.9 }), 0.01), 0, 1.75, 0);
  for (const x of [-w / 2 + 0.05, w / 2 - 0.05]) put(g, rbox(0.06, 2.4, 0.06, wood(), 0.01), x, 1.2, -0.03);
  const r = rng(9);
  for (let i = 0; i < 9; i++) { const x = -w / 2 + 0.25 + i * (w - 0.5) / 8, m = i % 3 === 0 ? mat('#a8342a') : steel(), L = 0.3 + r() * 0.25;
    put(g, rbox(0.035, L, 0.025, m, 0.01), x, 1.75 + (r() - 0.5) * 0.3, 0.04, 0).rotation.z = (r() - 0.5) * 0.3;
    if (i % 2) put(g, rbox(0.12, 0.05, 0.03, m, 0.01), x, 1.75 + L / 2, 0.04); }
  const coil = mesh(new THREE.TorusGeometry(0.15, 0.03, 6, 16), mat('#d8b23a')); put(g, coil, w / 2 - 0.3, 2.15, 0.06);
  return g;
}

/** Shop stool at seat height h. */
export function stool(h = 0.65, c = '#5a2a3a') {
  const g = new THREE.Group(); put(g, mesh(new THREE.CylinderGeometry(0.2, 0.19, 0.07, 16), mat(c, { roughness: 0.5 })), 0, h, 0);
  for (let i = 0; i < 3; i++) { const a = i * 2.1, l = mesh(new THREE.CylinderGeometry(0.018, 0.022, h, 6), gunmetal()); l.position.set(Math.cos(a) * 0.12, h / 2, Math.sin(a) * 0.12); l.rotation.set(Math.sin(a) * 0.15, 0, -Math.cos(a) * 0.15); g.add(l); }
  return g;
}

/** Dog bed + a sleeping shaggy dog (dog group returned to breathe). */
export function dogBed() {
  const g = new THREE.Group(); const rim = mesh(new THREE.TorusGeometry(0.42, 0.13, 8, 22), mat('#5a2a3a', { roughness: 1 })); rim.rotation.x = Math.PI / 2; rim.scale.set(1.15, 1, 1); put(g, rim, 0, 0.12, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.08, 20), mat('#3a2a54', { roughness: 1 })), 0, 0.06, 0).scale.set(1.15, 1, 1);
  const dog = new THREE.Group(); dog.position.set(0, 0.1, 0); dog.userData.live = true; g.add(dog);
  const fur = mat('#b8b09a', { roughness: 1 }), dark = mat('#4a4048', { roughness: 1 });
  put(dog, mesh(new THREE.SphereGeometry(0.3, 14, 10), fur), 0, 0.15, 0).scale.set(1.3, 0.62, 0.95);
  put(dog, mesh(new THREE.SphereGeometry(0.2, 12, 8), dark), -0.12, 0.2, -0.06).scale.set(1.1, 0.7, 0.9);
  put(dog, mesh(new THREE.SphereGeometry(0.15, 12, 10), fur), 0.3, 0.14, 0.14).scale.set(1.15, 0.85, 1);
  put(dog, mesh(new THREE.SphereGeometry(0.06, 8, 6), dark), 0.45, 0.12, 0.17);
  for (const z of [0.04, 0.25]) put(dog, mesh(new THREE.SphereGeometry(0.06, 8, 6), dark), 0.27, 0.2, z).scale.set(0.8, 1.4, 0.6);
  put(dog, mesh(new THREE.SphereGeometry(0.08, 8, 6), fur), -0.38, 0.1, 0.18).scale.set(1.6, 0.7, 0.8);
  return { g, dog };
}
