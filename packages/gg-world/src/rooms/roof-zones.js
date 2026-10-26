// @ts-check
// The Roof v2: props for the extra zones (deck lounge, bar cart, garden corner). Built at the origin, place with put().
import * as THREE from 'three';
import { mat, glowMat, rbox, mesh, put, bake } from './kit.js';

const cyl = (rt, rb, h, m, s = 12) => mesh(new THREE.CylinderGeometry(rt, rb, h, s), m);
const WOOD = () => mat('#5a4030', { roughness: 0.95 }), DARK = () => mat('#3b2a22');

/** Slouchy beanbag, seat ~0.3, faces +z. */
export function beanbag(color = '#4a2a5a') {
  const pts = []; for (let i = 0; i <= 12; i++) { const a = i / 12 * Math.PI; pts.push(new THREE.Vector2(Math.sin(a) * (0.42 + 0.06 * Math.sin(a * 2)), 0.28 - Math.cos(a) * 0.28)); }
  const g = new THREE.Group(), b = mesh(new THREE.LatheGeometry(pts, 18), mat(color, { roughness: 1 })); b.scale.set(1, 1, 0.95); g.add(b);
  const back = put(g, mesh(new THREE.SphereGeometry(0.3, 14, 8), mat(color, { roughness: 1 })), 0, 0.5, -0.24); back.scale.set(1.25, 0.9, 0.6);
  return g;
}
/** Wooden deck lounger with a striped sling; seat ~0.35, faces +z (back at -z). */
export function deckChair(cloth = '#7a3e34') {
  const g = new THREE.Group(), w = WOOD(), c = mat(cloth, { roughness: 1, side: THREE.DoubleSide });
  for (const sx of [-1, 1]) { const r = put(g, rbox(0.05, 0.05, 1.2, w, 0.015), sx * 0.3, 0.3, 0); r.rotation.x = 0.0; const bk = put(g, rbox(0.05, 0.05, 0.75, w, 0.015), sx * 0.3, 0.6, -0.75); bk.rotation.x = 0.9;
    for (const lz of [-0.5, 0.5]) put(g, rbox(0.05, 0.3, 0.05, w, 0.012), sx * 0.3, 0.15, lz); }
  put(g, rbox(0.56, 0.03, 1.1, c, 0.01), 0, 0.33, 0.05);
  const bs = put(g, rbox(0.56, 0.03, 0.72, c, 0.01), 0, 0.62, -0.72); bs.rotation.x = 0.9;
  return g;
}
/** Rolling bar cart with bottles, a bucket of ice and a little lamp. Returns { g, lampAt }. */
export function barCart() {
  const g = new THREE.Group(), steel = mat('#8a6a3a', { metalness: 0.7, roughness: 0.35 }), top = mat('#2a1a14', { roughness: 0.5 });
  for (const y of [0.32, 0.86]) put(g, rbox(1.3, 0.05, 0.6, top, 0.02), 0, y, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(g, cyl(0.02, 0.02, 0.92, steel, 6), sx * 0.62, 0.47, sz * 0.27);
  for (const sx of [-1, 1]) { const wh = put(g, cyl(0.08, 0.08, 0.04, mat('#141218'), 12), sx * 0.62, 0.08, 0.27); wh.rotation.x = Math.PI / 2; }
  put(g, rbox(0.06, 0.04, 0.6, steel, 0.015), 0.72, 0.95, 0);
  for (const y of [0.4, 0.94]) for (const sz of [-1, 1]) put(g, rbox(1.26, 0.012, 0.012, steel, 0.004), 0, y, sz * 0.29);
  put(g, rbox(0.3, 0.2, 0.004, mat('#d8cfb8', { roughness: 0.9 }), 0.001), -0.25, 0.6, 0.3); // menu card
  const prof = []; for (const [r, y] of [[0, 0], [0.06, 0], [0.065, 0.02], [0.065, 0.2], [0.03, 0.26], [0.022, 0.34], [0.022, 0.36], [0, 0.36]]) prof.push(new THREE.Vector2(r, y));
  const bg = new THREE.LatheGeometry(prof, 10); const glass = [mat('#1e5a3a', { roughness: 0.15, metalness: 0.2 }), mat('#6a3a1a', { roughness: 0.15 }), mat('#2a2a4a', { roughness: 0.15 })];
  [[-0.5, 0], [-0.35, 0.1], [-0.2, -0.05], [0.25, 0.12], [0.4, -0.06]].forEach(([x, z], i) => put(g, mesh(bg, glass[i % 3]), x, 0.885, z));
  [[-0.4, 0], [-0.2, 0.05], [0.2, -0.05]].forEach(([x, z], i) => put(g, mesh(bg, glass[(i + 1) % 3]), x, 0.345, z));
  put(g, cyl(0.13, 0.1, 0.18, mat('#9a9aa4', { metalness: 0.8, roughness: 0.25 }), 14), 0.05, 0.98, 0); // ice bucket
  put(g, cyl(0.05, 0.07, 0.2, DARK(), 10), 0.5, 0.98, 0.14); put(g, cyl(0.05, 0.1, 0.12, glowMat('#ffcf8a', 2.2), 12), 0.5, 1.14, 0.14);
  return { g, lampAt: new THREE.Vector3(0.5, 1.15, 0.14) };
}
/** Raised wooden planter box with veg, tomato stakes; length along x. */
export function planter(len = 2, seed = 1) {
  const g = new THREE.Group(), w = WOOD(), soil = mat('#2a1e18', { roughness: 1 }), leaf = [mat('#2f4a2c', { roughness: 0.9 }), mat('#3a5530', { roughness: 0.9 })];
  for (let i = 0; i < 3; i++) put(g, rbox(len, 0.17, 0.6, i % 2 ? DARK() : w, 0.02), 0, 0.09 + i * 0.18, 0);
  put(g, rbox(len - 0.1, 0.02, 0.5, soil, 0.005), 0, 0.53, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(g, rbox(0.08, 0.6, 0.08, DARK(), 0.015), sx * (len / 2 - 0.02), 0.3, sz * 0.28);
  for (const sz of [-1, 1]) put(g, rbox(len + 0.08, 0.04, 0.1, w, 0.012), 0, 0.56, sz * 0.28); // cap rail
  for (const sx of [-1, 1]) put(g, rbox(0.1, 0.04, 0.62, w, 0.012), sx * (len / 2 - 0.02), 0.56, 0);
  let s = seed; const r = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  for (let i = 0; i < len * 5; i++) { const b = put(g, mesh(new THREE.SphereGeometry(0.09 + r() * 0.07, 7, 5), leaf[i % 2]), -len / 2 + 0.15 + r() * (len - 0.3), 0.62 + r() * 0.15, (r() - 0.5) * 0.35); b.scale.y = 1.4; }
  for (let i = 0; i < Math.floor(len * 1.5); i++) { const x = -len / 2 + 0.3 + i * 0.6; put(g, cyl(0.012, 0.012, 0.8, mat('#8a7a5a'), 4), x, 0.9, 0); put(g, mesh(new THREE.SphereGeometry(0.04, 8, 6), mat('#b8402a', { roughness: 0.5 })), x + 0.06, 0.95, 0.05); }
  return g;
}
/** Low pallet bench, seat ~0.42, faces +z. */
export function bench(len = 1.4) {
  const g = new THREE.Group(), w = WOOD(), d = DARK();
  for (let i = 0; i < 4; i++) put(g, rbox(len, 0.035, 0.1, i % 2 ? w : d, 0.01), 0, 0.42, -0.18 + i * 0.12);
  for (const sx of [-1, 1]) put(g, rbox(0.1, 0.4, 0.44, d, 0.02), sx * (len / 2 - 0.08), 0.2, 0);
  return g;
}
/** Wooden crate seat (h 0.36, 0.5 x 0.4): slatted sides with gaps, corner posts, nail heads, a stencil on the front. */
export function crate() {
  const g = new THREE.Group(), w = mat('#7a5634', { roughness: 0.95 }), w2 = mat('#5e4128', { roughness: 0.95 }), nail = mat('#2a2622', { metalness: 0.6, roughness: 0.5 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(g, rbox(0.06, 0.36, 0.06, w2, 0.012), sx * 0.22, 0.18, sz * 0.17); // corner posts
  for (let i = 0; i < 3; i++) { const y = 0.06 + i * 0.12; // slats with 2 cm gaps
    for (const sz of [-1, 1]) { put(g, rbox(0.46, 0.1, 0.022, i % 2 ? w2 : w, 0.008), 0, y, sz * 0.19); for (const sx of [-1, 1]) put(g, cyl(0.007, 0.007, 0.006, nail, 6).rotateX(Math.PI / 2), sx * 0.21, y, sz * 0.202); }
    for (const sx of [-1, 1]) put(g, rbox(0.022, 0.1, 0.36, i % 2 ? w : w2, 0.008), sx * 0.24, y, 0); }
  for (let i = 0; i < 4; i++) put(g, rbox(0.5, 0.022, 0.085, i % 2 ? w2 : w, 0.008), 0, 0.35, -0.15 + i * 0.1); // lid boards
  for (let i = 0; i < 8; i++) put(g, cyl(0.007, 0.007, 0.006, nail, 6), (i % 2 ? 0.22 : -0.22), 0.362, -0.15 + (i >> 1) * 0.1);
  put(g, rbox(0.18, 0.06, 0.004, mat('#2a1e14', { roughness: 1 }), 0.001), 0.04, 0.18, 0.202); // stencil mark
  bake(g); return g;
}
