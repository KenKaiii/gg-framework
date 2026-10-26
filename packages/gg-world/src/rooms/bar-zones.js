// @ts-check
// v2 zone props for "The Terminal": booths, high-tops, DJ stage, stairwell. Each returns a Group around its origin (floor y=0).
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh } from './kit.js';
import * as TX from './tex.js';

const WOOD = () => mat('#3b2418', { roughness: 0.7 });
const WOOD_D = () => mat('#24150f', { roughness: 0.8 });
const TOP = () => mat('#5a3622', { roughness: 0.45 });
const CHROME = () => mat('#9aa0ac', { metalness: 0.9, roughness: 0.25 });
const DARK = () => mat('#141014', { roughness: 0.5, metalness: 0.3 });
const METAL = () => mat('#3a3a40', { metalness: 0.6, roughness: 0.4 });
const LEATHER = () => mat('#2a1714', { roughness: 0.55 });
const OX = () => mat('#4a1c22', { roughness: 0.55 });
const cyl = (rt, rb, h, m, s = 16) => mesh(new THREE.CylinderGeometry(rt, rb, h, s), m);

/** Booth bench, long along x, seat facing +z, high back at -z. */
function bench(len) {
  const g = new THREE.Group();
  put(g, rbox(len, 0.42, 0.55, LEATHER(), 0.05), 0, 0.21, 0);
  put(g, rbox(len - 0.06, 0.1, 0.5, OX(), 0.05), 0, 0.46, 0.02);
  put(g, rbox(len, 1.2, 0.16, LEATHER(), 0.06), 0, 0.6, -0.3);
  const n = Math.max(2, Math.round(len / 0.45));
  for (let i = 0; i < n; i++) put(g, rbox(len / n - 0.04, 0.62, 0.06, OX(), 0.03), -len / 2 + (i + 0.5) * len / n, 0.82, -0.2);
  put(g, rbox(len + 0.04, 0.06, 0.2, WOOD_D(), 0.02), 0, 1.22, -0.3);
  return g;
}
/** A booth against a wall at -x: two benches face each other across a table, along z. Centre at origin. */
export function booth(len = 1.5) {
  const g = new THREE.Group();
  put(g, bench(len), 0, 0, -0.78); put(g, bench(len), 0, 0, 0.78, Math.PI);
  put(g, rbox(len - 0.1, 0.06, 0.72, TOP(), 0.025), 0, 0.74, 0);
  put(g, cyl(0.05, 0.05, 0.7, METAL(), 8), 0, 0.36, 0);
  put(g, rbox(0.5, 0.03, 0.4, METAL(), 0.01), 0, 0.015, 0);
  // brass lamp shade on the table
  put(g, cyl(0.03, 0.06, 0.2, mat('#c99a4a', { metalness: 0.85, roughness: 0.3 }), 10), -len / 2 + 0.2, 0.87, 0);
  return g;
}

/** Barrel high-top table (bar height). */
export function highTable() {
  const g = new THREE.Group();
  put(g, cyl(0.3, 0.3, 0.95, WOOD(), 14), 0, 0.475, 0);
  for (const y of [0.15, 0.8]) { const r = mesh(new THREE.TorusGeometry(0.305, 0.018, 4, 18), METAL()); r.rotation.x = Math.PI / 2; put(g, r, 0, y, 0); }
  put(g, cyl(0.45, 0.45, 0.05, TOP(), 18), 0, 1.07, 0);
  put(g, cyl(0.36, 0.36, 0.08, WOOD_D(), 14), 0, 1.0, 0);
  return g;
}

/** Low stage platform w x d with a lit front edge. */
export function stage(w, d) {
  const g = new THREE.Group();
  put(g, rbox(w, 0.24, d, WOOD_D(), 0.03), 0, 0.12, 0);
  put(g, rbox(w - 0.04, 0.02, d - 0.04, mat('#1a1418', { roughness: 0.95 }), 0.01), 0, 0.245, 0);
  const strip = rbox(w - 0.1, 0.05, 0.03, glowMat('#ff4fd8', 1.3), 0); strip.castShadow = false; put(g, strip, 0, 0.2, d / 2 + 0.005);
  return g;
}

/** DJ desk (facing +z) with two turntables and a mixer. Returns { g, platters }. */
export function djDecks() {
  const g = new THREE.Group();
  put(g, rbox(1.6, 0.9, 0.6, DARK(), 0.03), 0, 0.45, 0);
  put(g, rbox(1.5, 0.5, 0.02, mat('#2a1430', { roughness: 0.6 }), 0.005), 0, 0.5, 0.31);
  const logo = mesh(new THREE.PlaneGeometry(0.9, 0.22), new THREE.MeshBasicMaterial({ map: TX.neon('DJ /dev/null', '#b04fd8', 512, 128), transparent: true, depthWrite: false, toneMapped: false })); logo.castShadow = false; put(g, logo, 0, 0.55, 0.325);
  const platters = [];
  for (const x of [-0.5, 0.5]) {
    put(g, rbox(0.46, 0.08, 0.4, METAL(), 0.02), x, 0.94, 0);
    const p = new THREE.Group(); p.userData.live = true;
    put(p, cyl(0.17, 0.17, 0.02, mat('#0c0a0c', { roughness: 0.3 }), 20), 0, 0, 0);
    put(p, rbox(0.04, 0.005, 0.12, glowMat('#ff4fd8', 1.6), 0), 0.08, 0.012, 0);
    put(p, cyl(0.05, 0.05, 0.024, mat('#c8322a', { roughness: 0.5 }), 12), 0, 0.002, 0);
    p.position.set(x, 0.99, 0); platters.push(p);
  }
  put(g, rbox(0.4, 0.1, 0.36, DARK(), 0.02), 0, 0.95, 0);
  const knobs = glowMat('#3ddc84', 1.8);
  for (let i = 0; i < 6; i++) put(g, rbox(0.03, 0.02, 0.03, knobs, 0.005), -0.12 + (i % 3) * 0.12, 1.01, -0.08 + Math.floor(i / 3) * 0.14);
  // laptop on the corner
  put(g, rbox(0.3, 0.015, 0.22, METAL(), 0.005), 0.62, 0.91, 0.14, 0.3);
  return { g, platters };
}

/** Speaker stack (two cabinets). */
export function speakerStack() {
  const g = new THREE.Group(), cone = mat('#0a0a0c', { roughness: 0.9 }), rim = METAL();
  for (const [y, h] of [[0, 0.9], [0.9, 0.7]]) {
    put(g, rbox(0.7, h - 0.02, 0.55, DARK(), 0.03), 0, y + h / 2, 0);
    const n = h > 0.8 ? 2 : 1;
    for (let i = 0; i < n; i++) { const cy = y + (n === 2 ? 0.25 + i * 0.4 : h / 2), r = n === 2 ? 0.16 : 0.2;
      const c = cyl(r, r, 0.04, cone, 18); c.rotation.x = Math.PI / 2; put(g, c, 0, cy, 0.275);
      const t = mesh(new THREE.TorusGeometry(r, 0.015, 4, 18), rim); put(g, t, 0, cy, 0.29); }
  }
  return g;
}

/** Mic on a tripod stand. */
export function micStand() {
  const g = new THREE.Group(), m = METAL();
  for (let i = 0; i < 3; i++) { const l = cyl(0.012, 0.012, 0.4, m, 6); l.rotation.z = 0.9; const h = new THREE.Group(); h.add(l); l.position.set(0.15, 0.1, 0); h.rotation.y = i * 2.094; g.add(h); }
  put(g, cyl(0.014, 0.014, 1.45, m, 6), 0, 0.85, 0);
  const head = cyl(0.03, 0.022, 0.12, DARK(), 10); head.rotation.x = 0.9; put(g, head, 0, 1.6, 0.05);
  put(g, mesh(new THREE.SphereGeometry(0.035, 10, 8), CHROME()), 0, 1.64, 0.09);
  return g;
}

/** A-frame chalk sign. */
export function chalkSign(text) {
  const g = new THREE.Group(), face = mat('#ffffff', { map: TX.label(text, '#f2ead8', '#1c2220', 256, 320, '51px m5x7') });
  for (const s of [-1, 1]) { const p = new THREE.Group(); put(p, rbox(0.56, 0.86, 0.04, WOOD(), 0.015), 0, 0, 0); const f = mesh(new THREE.PlaneGeometry(0.48, 0.74), face); f.position.z = 0.025; p.add(f); p.position.set(0, 0.42, s * 0.14); p.rotation.x = -s * 0.17; if (s < 0) p.rotation.y = Math.PI; g.add(p); }
  return g;
}

/** Stairwell behind a door in a wall (wall face at z=0, door width w): steps rise away from the room (-z). */
export function stairwell(w = 1.1) {
  const g = new THREE.Group(), side = mat('#2a1a18', { roughness: 0.9 }), step = WOOD(), nose = mat('#c99a4a', { metalness: 0.7, roughness: 0.35 }); const led = glowMat('#8fa8ff', 1.1);
  const D = 3.2, z0 = -0.2;
  for (let i = 0; i < 9; i++) { const h = 0.18 * (i + 1); put(g, rbox(w + 0.07, h, 0.3, step, 0.015), 0, h / 2, z0 - 0.4 - i * 0.3); put(g, rbox(w + 0.06, 0.025, 0.04, nose, 0.005), 0, h, z0 - 0.27 - i * 0.3); put(g, rbox(w - 0.1, 0.02, 0.025, led, 0), 0, h - 0.04, z0 - 0.245 - i * 0.3); }
  for (const s of [-1, 1]) put(g, rbox(0.1, 3.4, D, side, 0), s * (w / 2 + 0.1), 1.7, z0 - D / 2);
  put(g, rbox(w + 0.3, 0.1, D, side, 0), 0, 3.4, z0 - D / 2);
  put(g, rbox(w + 0.3, 3.4, 0.1, side, 0), 0, 1.7, z0 - D);
  put(g, rbox(w + 0.07, 0.02, 0.6, step, 0), 0, 0.012, z0 - 0.3);
  // handrail + a cool moonlit glow at the top landing
  const rail = mesh(new THREE.CylinderGeometry(0.02, 0.02, 3.1, 6), nose); rail.rotation.x = Math.PI / 2 - 0.54; put(g, rail, w / 2 - 0.02, 1.85, z0 - 1.6);
  const top = mesh(new THREE.PlaneGeometry(w, 1.1), new THREE.MeshBasicMaterial({ color: '#8fa8ff', transparent: true, opacity: 0.35, toneMapped: false })); top.castShadow = false; put(g, top, 0, 2.6, z0 - D + 0.06);
  return g;
}
