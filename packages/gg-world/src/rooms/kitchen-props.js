// @ts-check
// The Kitchen: code-built props (counters, fridge, appliances, island, table, clutter).
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh } from './kit.js';
import * as TX from './tex.js';

export const WOOD = mat('#4a2f22', { roughness: 0.8 });
export const CAB = mat('#2c3a3a', { roughness: 0.7 });
export const TOP = mat('#6a5e52', { roughness: 0.5 });
export const STEEL = mat('#8a8e96', { roughness: 0.35, metalness: 0.6 });
export const DARK = mat('#18161c', { roughness: 0.6 });
const CREAM = mat('#c9bfa8', { roughness: 0.5 });
const lathe = (pts, m, seg = 16) => mesh(new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg), m);

/** Base cabinet run with counter top, doors and handles; length along x. */
export function counter(len, withSink = false) {
  const g = new THREE.Group();
  put(g, rbox(len, 0.8, 0.58, CAB, 0.02), 0, 0.42, 0);
  put(g, rbox(len, 0.08, 0.06, DARK, 0.01), 0, 0.04, 0.24);
  put(g, rbox(len + 0.04, 0.06, 0.64, TOP, 0.015), 0, 0.85, 0.02);
  const n = Math.max(1, Math.round(len / 0.6));
  for (let i = 0; i < n; i++) { const x = -len / 2 + (i + 0.5) * len / n;
    put(g, rbox(len / n - 0.05, 0.66, 0.02, CAB, 0.01), x, 0.44, 0.295);
    put(g, rbox(0.12, 0.02, 0.03, STEEL, 0.008), x, 0.7, 0.31); }
  if (withSink) { put(g, rbox(0.62, 0.02, 0.44, STEEL, 0.01), 0, 0.885, 0);
    put(g, rbox(0.54, 0.02, 0.36, DARK, 0.005), 0, 0.89, 0);
    const tap = mesh(new THREE.TorusGeometry(0.12, 0.015, 6, 12, Math.PI), STEEL); tap.position.set(0, 0.89, -0.2); g.add(tap); }
  return g;
}
/** Free-standing hutch back: tall panel with an open shelf (under-shelf strip light added by the room). */
export function hutch(len) {
  const g = new THREE.Group();
  put(g, rbox(len, 1.5, 0.05, WOOD, 0.01), 0, 1.65, -0.27);
  put(g, rbox(len, 0.05, 0.34, WOOD, 0.01), 0, 1.6, -0.1);
  put(g, rbox(len, 0.05, 0.3, WOOD, 0.01), 0, 2.2, -0.12);
  for (const s of [-1, 1]) put(g, rbox(0.05, 1.5, 0.34, WOOD, 0.01), s * (len / 2 - 0.025), 1.65, -0.1);
  put(g, rbox(len - 0.1, 0.02, 0.03, glowMat('#ffcf8a', 2.4), 0.005), 0, 1.565, 0.0);
  return g;
}
function magnetTex() {
  return TX.canvasTex('k-fridge', 128, 256, (x, w, h) => {
    x.fillStyle = '#3d4a4c'; x.fillRect(0, 0, w, h);
    const r = TX.rand(9); const cs = ['#e63946', '#f1c453', '#3ddc84', '#b04fd8', '#457b9d', '#f4a261', '#ff4fd8'];
    for (let i = 0; i < 26; i++) { x.fillStyle = cs[i % cs.length]; const s = 6 + r() * 12; x.save(); x.translate(r() * w, r() * h); x.rotate(r() - 0.5); x.fillRect(-s / 2, -s / 2, s, s * (0.6 + r())); x.restore(); }
    x.save(); x.translate(64, 120); x.rotate(-0.06); x.fillStyle = '#efe6b0'; x.fillRect(-40, -34, 80, 68);
    x.fillStyle = '#2a2230'; x.font = '18px m5x7'; x.textAlign = 'center';
    ['WHO ATE MY', 'LEFTOVERS??', 'I KNOW.', '- the', 'git blame'].forEach((t, i) => x.fillText(t, 0, -18 + i * 12)); x.restore();
    x.fillStyle = '#e63946'; x.beginPath(); x.arc(64, 88, 5, 0, 7); x.fill();
    x.fillStyle = '#fff'; x.fillRect(16, 190, 46, 24); x.fillStyle = '#111'; x.font = '14px m5x7'; x.fillText('DEPLOY ON', 18, 200); x.fillText('FRIDAY: NO', 18, 210);
  });
}
/** Tall fridge, door facing +z; ajar crack shows light. */
export function fridge() {
  const g = new THREE.Group(); const body = mat('#46504f', { roughness: 0.55 });
  put(g, rbox(0.8, 1.95, 0.72, body, 0.05), 0, 0.99, 0);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.74, 1.88), mat('#ffffff', { map: magnetTex(), roughness: 0.6 })); face.position.set(0, 0.99, 0.372); g.add(face);
  put(g, rbox(0.76, 0.02, 0.02, DARK, 0.005), 0, 1.35, 0.365);
  for (const y of [1.0, 1.65]) put(g, rbox(0.03, 0.3, 0.04, STEEL, 0.01), 0.31, y, 0.39);
  put(g, rbox(0.045, 1.8, 0.03, glowMat('#ffe7b8', 0.8), 0.005), -0.38, 0.95, 0.37);
  for (let i = 0; i < 3; i++) put(g, rbox(0.12, 0.28 - i * 0.04, 0.1, mat(['#c23b3b', '#e9c46a', '#2a6fdb'][i], { roughness: 0.6 }), 0.01), -0.22 + i * 0.16, 2.1 - i * 0.02, 0);
  return g;
}
export function stove() {
  const g = new THREE.Group();
  put(g, rbox(0.62, 0.86, 0.6, mat('#2a2a2e', { roughness: 0.4, metalness: 0.3 }), 0.02), 0, 0.43, 0);
  put(g, rbox(0.5, 0.36, 0.02, mat('#0d0c10', { roughness: 0.2 }), 0.01), 0, 0.4, 0.3);
  for (const [x, z] of [[-0.15, -0.13], [0.15, -0.13], [-0.15, 0.12], [0.15, 0.12]]) { const r = mesh(new THREE.TorusGeometry(0.08, 0.01, 4, 16), DARK); r.rotation.x = Math.PI / 2; r.position.set(x, 0.87, z); g.add(r); }
  for (let i = 0; i < 4; i++) put(g, rbox(0.04, 0.04, 0.03, STEEL, 0.01), -0.21 + i * 0.14, 0.78, 0.31);
  const pot = lathe([[0, 0], [0.13, 0], [0.14, 0.02], [0.14, 0.16], [0.15, 0.17], [0.13, 0.17], [0.13, 0.03], [0, 0.03]], mat('#b0523a', { roughness: 0.4 }));
  pot.position.set(-0.15, 0.87, 0.12); g.add(pot);
  put(g, rbox(0.3, 0.015, 0.02, DARK, 0.005), -0.15 + 0.25, 1.02, 0.12);
  return g;
}
export function microwave() {
  const g = new THREE.Group();
  put(g, rbox(0.52, 0.3, 0.36, mat('#3a3a40', { roughness: 0.4, metalness: 0.3 }), 0.02), 0, 0.15, 0);
  put(g, rbox(0.34, 0.22, 0.01, mat('#100d0a', { roughness: 0.15 }), 0.005), -0.07, 0.15, 0.18);
  put(g, rbox(0.1, 0.22, 0.01, DARK, 0.005), 0.19, 0.15, 0.18);
  return g;
}
export function espresso() {
  const g = new THREE.Group();
  put(g, rbox(0.34, 0.38, 0.32, mat('#7a1f22', { roughness: 0.35, metalness: 0.3 }), 0.04), 0, 0.19, 0);
  put(g, rbox(0.26, 0.04, 0.12, STEEL, 0.01), 0, 0.27, 0.19);
  put(g, rbox(0.03, 0.03, 0.14, DARK, 0.01), 0.04, 0.23, 0.27);
  put(g, rbox(0.22, 0.02, 0.1, STEEL, 0.005), 0, 0.03, 0.2);
  for (let i = 0; i < 3; i++) put(g, rbox(0.03, 0.03, 0.01, glowMat(i ? '#ffb36b' : '#3ddc84', 2), 0.005), -0.08 + i * 0.05, 0.33, 0.165);
  return g;
}
/** Matrix touch: kettle with a green-phosphor glass window. */
export function kettle() {
  const g = new THREE.Group();
  put(g, lathe([[0, 0], [0.1, 0], [0.11, 0.05], [0.09, 0.22], [0.05, 0.25], [0, 0.25]], DARK), 0, 0.03, 0);
  put(g, lathe([[0.12, 0], [0.13, 0.03], [0, 0.03]], DARK), 0, 0, 0);
  put(g, rbox(0.03, 0.16, 0.03, glowMat('#3ddc84', 2.6), 0.01), 0.0, 0.13, 0.1);
  const h = mesh(new THREE.TorusGeometry(0.07, 0.015, 6, 10, Math.PI), DARK); h.rotation.z = -Math.PI / 2; h.position.set(-0.1, 0.15, 0); h.rotation.y = 0; g.add(h);
  return g;
}
export function toaster() {
  const g = new THREE.Group();
  put(g, rbox(0.26, 0.18, 0.15, CREAM, 0.04), 0, 0.09, 0);
  put(g, rbox(0.1, 0.05, 0.02, mat('#c08a4a'), 0.01), -0.05, 0.19, 0);
  return g;
}
export function island() {
  const g = new THREE.Group();
  put(g, rbox(2.2, 0.86, 0.8, WOOD, 0.03), 0, 0.43, 0);
  put(g, rbox(2.5, 0.07, 1.1, mat('#3a2a24', { roughness: 0.55 }), 0.02), 0, 0.9, 0.1);
  for (let i = 0; i < 4; i++) put(g, rbox(0.5, 0.7, 0.02, mat('#3e2a20', { roughness: 0.8 }), 0.01), -0.82 + i * 0.55, 0.45, -0.41);
  return g;
}
/** Pendant lamp hanging at y (cord to ceiling). */
export function pendant(y) {
  const g = new THREE.Group();
  put(g, rbox(0.012, 3.3 - y, 0.012, DARK, 0), 0, (3.3 + y) / 2, 0);
  const sh = lathe([[0.02, 0.22], [0.08, 0.2], [0.2, 0.04], [0.26, 0], [0.25, -0.01], [0.19, 0.03], [0.07, 0.18], [0.02, 0.2]], mat('#1f4a3a', { roughness: 0.5, metalness: 0.4, side: THREE.DoubleSide }), 20);
  sh.position.y = y; g.add(sh);
  put(g, new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), glowMat('#ffcf8a', 3)), 0, y + 0.04, 0);
  return g;
}
export function roundTable() {
  const g = new THREE.Group();
  put(g, lathe([[0, 0], [0.28, 0], [0.26, 0.04], [0.05, 0.08], [0.04, 0.7], [0, 0.7]], DARK), 0, 0, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.05, 28), mat('#5a3a28', { roughness: 0.6 })), 0, 0.74, 0);
  return g;
}
/** Mismatched chair; seat at 0.46, back towards -z. */
export function chair(color) {
  const g = new THREE.Group(); const m = mat(color, { roughness: 0.75 });
  put(g, rbox(0.46, 0.05, 0.44, m, 0.02), 0, 0.46, 0);
  for (const [x, z] of [[-0.19, -0.18], [0.19, -0.18], [-0.19, 0.18], [0.19, 0.18]]) put(g, rbox(0.04, 0.44, 0.04, m, 0.01), x, 0.22, z);
  put(g, rbox(0.46, 0.4, 0.04, m, 0.02), 0, 0.72, -0.2);
  return g;
}
export function whiteboard() {
  const g = new THREE.Group();
  const t = TX.canvasTex('k-rules', 256, 192, (x, w, h) => { x.fillStyle = '#d8d6cc'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#c23b3b'; x.font = '33px m5x7'; x.fillText('FRIDGE RULES', 14, 28);
    x.fillStyle = '#1f2a5a'; x.font = '22px m5x7';
    ['1. label your food', '2. labels are not legally binding', '3. no fish in the microwave', '4. milk > 3 days = prod incident', '5. the kombucha is alive. let it be'].forEach((s, i) => x.fillText(s, 12, 58 + i * 26));
    x.strokeStyle = '#3ddc84'; x.lineWidth = 2; x.strokeRect(5, 5, w - 10, h - 10); });
  const board = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.68), mat('#ffffff', { map: t, roughness: 0.4 })); board.position.set(0, 1.35, 0.03); board.rotation.x = -0.12; g.add(board);
  const fr = rbox(0.96, 0.74, 0.03, mat('#9a9aa2', { metalness: 0.4, roughness: 0.4 }), 0.01); fr.position.set(0, 1.35, 0); fr.rotation.x = -0.12; g.add(fr);
  for (const s of [-1, 1]) { const l = rbox(0.04, 1.75, 0.04, WOOD, 0.01); l.position.set(s * 0.38, 0.86, 0.1); l.rotation.set(-0.12, 0, s * 0.06); g.add(l); }
  const b = rbox(0.04, 1.6, 0.04, WOOD, 0.01); b.position.set(0, 0.78, -0.35); b.rotation.x = 0.35; g.add(b);
  put(g, rbox(0.8, 0.04, 0.08, WOOD, 0.01), 0, 0.98, 0.15);
  return g;
}
export function pizzaBox(open = true) {
  const g = new THREE.Group(); const c = mat('#b08a5a', { roughness: 0.9 });
  put(g, rbox(0.42, 0.04, 0.42, c, 0.005), 0, 0.02, 0);
  if (open) { const lid = rbox(0.42, 0.02, 0.42, c, 0.005); lid.position.set(0, 0.2, -0.22); lid.rotation.x = -1.35; g.add(lid);
    const p = mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.02, 6, 1, false, 0, 4.2), mat('#c8752a', { roughness: 0.7 })); p.position.y = 0.05; g.add(p); }
  return g;
}
export function cereal(color, seed) {
  const g = new THREE.Group();
  put(g, rbox(0.2, 0.3, 0.07, mat(color, { roughness: 0.6 }), 0.005), 0, 0.15, 0);
  put(g, rbox(0.14, 0.08, 0.072, mat(seed ? '#f1c453' : '#ffffff', { roughness: 0.6 }), 0.005), 0, 0.2, 0);
  return g;
}
export function noodleBowl() {
  const g = new THREE.Group();
  put(g, lathe([[0, 0], [0.06, 0], [0.11, 0.08], [0.1, 0.08], [0, 0.02]], mat('#d84a3a', { roughness: 0.5, side: THREE.DoubleSide })), 0, 0, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.01, 14), mat('#e2c27a')), 0, 0.065, 0);
  return g;
}
export function bin() {
  const g = new THREE.Group();
  put(g, lathe([[0, 0], [0.2, 0], [0.24, 0.62], [0.25, 0.64], [0, 0.64]], mat('#3a4a3a', { roughness: 0.6, metalness: 0.2 })), 0, 0, 0);
  return g;
}
export function plant(scale = 1, seed = 1) {
  const g = new THREE.Group();
  put(g, lathe([[0, 0], [0.16, 0], [0.2, 0.3], [0.18, 0.3], [0, 0.28]], mat('#7a3e2a', { roughness: 0.85 })), 0, 0, 0);
  const lm = mat('#2f5a3a', { roughness: 0.8, side: THREE.DoubleSide }); const r = TX.rand(seed);
  for (let i = 0; i < 9; i++) { const l = mesh(new THREE.ConeGeometry(0.07, 0.6 + r() * 0.4, 4), lm); const a = i / 9 * 6.28; l.position.set(Math.cos(a) * 0.08, 0.55, Math.sin(a) * 0.08); l.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5); g.add(l); }
  g.scale.setScalar(scale); return g;
}
/** Bar stool, seat at ~0.75. */
export function stoolGeo() { return new THREE.CylinderGeometry(0.19, 0.17, 0.06, 14); }
export function mugGeo() { return new THREE.LatheGeometry([[0, 0], [0.04, 0], [0.042, 0.1], [0.036, 0.1], [0.034, 0.01], [0, 0.01]].map(([x, y]) => new THREE.Vector2(x, y)), 10); }
export function canGeo() { return new THREE.CylinderGeometry(0.033, 0.033, 0.12, 10); }
