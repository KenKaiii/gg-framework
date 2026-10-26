// @ts-check
// The Prancing Murloc props: chunky hand-painted fantasy inn pieces (tables, benches, barrels, hearth, bar, quest board,
// mailbox, dice table, banners, lanterns, the fish-man mascot). Floor at y=0, local origin. Templates for repeats are
// turned into InstancedMeshes by instanceAll().
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mat, glowMat, rbox, put, mesh } from './kit.js';
import * as TX from './tex.js';

export const cyl = (rt, rb, h, m, seg = 12) => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
export const WOOD = mat('#8a5a32', { roughness: 0.8 }), WOOD_D = mat('#5e3a20', { roughness: 0.8 }), WOOD_L = mat('#b07a44', { roughness: 0.75 });
export const IRON = mat('#3a3436', { metalness: 0.5, roughness: 0.5 }), GOLD = mat('#d8a43a', { metalness: 0.7, roughness: 0.35 });
export const STONE = mat('#8a8070', { roughness: 0.95 }), STONE_D = mat('#5e564c', { roughness: 0.95 });
const CLOTH_R = mat('#a8302a', { roughness: 0.9 }), CLOTH_B = mat('#2e4a8a', { roughness: 0.9 }), PARCH = mat('#e8d6a8', { roughness: 0.9 });

/** Warm wide plank floor, light enough to read. */
export const floorTex = () => TX.planks('#b88654', '#9c6c40', 31);
export const wallTex = () => TX.plaster('#c8a878', 37);

/** Turn a template group into one InstancedMesh per material. placements: [x, z, ry, y?]. */
export function instanceAll(parent, template, placements, cast = false) {
  template.updateMatrixWorld(true);
  const byMat = new Map();
  template.traverse(o => { if (!o.isMesh) return; let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.applyMatrix4(o.matrixWorld); if (!byMat.has(o.material)) byMat.set(o.material, []); byMat.get(o.material).push(g); });
  const p = new THREE.Matrix4(), out = [];
  for (const [m, gs] of byMat) {
    const im = new THREE.InstancedMesh(/** @type {THREE.BufferGeometry} */ (mergeGeometries(gs, false)), m, placements.length);
    placements.forEach(([x, z, ry, y = 0], i) => { p.makeRotationY(ry); p.setPosition(x, y, z); im.setMatrixAt(i, p); });
    im.castShadow = cast; im.receiveShadow = true; im.userData.live = true; parent.add(im); out.push(im);
  }
  return out;
}

/** Long trestle table, length along x. */
export function longTable(len = 3.6) {
  const g = new THREE.Group();
  put(g, rbox(len, 0.12, 1.0, WOOD_L, 0.04), 0, 0.76, 0);
  for (const z of [-0.33, 0, 0.33]) put(g, rbox(len - 0.04, 0.02, 0.02, WOOD_D, 0.005), 0, 0.825, z + 0.16);
  for (const s of [-1, 1]) { const x = s * (len / 2 - 0.35);
    put(g, rbox(0.14, 0.7, 0.14, WOOD_D, 0.03), x, 0.35, -0.3); put(g, rbox(0.14, 0.7, 0.14, WOOD_D, 0.03), x, 0.35, 0.3);
    put(g, rbox(0.16, 0.1, 0.9, WOOD_D, 0.03), x, 0.06, 0); }
  put(g, rbox(len - 0.6, 0.1, 0.1, WOOD_D, 0.03), 0, 0.3, 0);
  return g;
}
/** Bench along x. */
export function bench(len = 3.4) {
  const g = new THREE.Group();
  put(g, rbox(len, 0.1, 0.38, WOOD, 0.04), 0, 0.44, 0);
  for (const s of [-1, 1]) { put(g, rbox(0.1, 0.4, 0.32, WOOD_D, 0.03), s * (len / 2 - 0.3), 0.2, 0); }
  return g;
}
/** Barrel with iron hoops. */
export function barrel() {
  const g = new THREE.Group();
  const pts = []; for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push(new THREE.Vector2(0.3 + Math.sin(t * Math.PI) * 0.06, t * 0.95)); }
  put(g, mesh(new THREE.LatheGeometry(pts, 14), WOOD), 0, 0, 0);
  put(g, cyl(0.31, 0.31, 0.02, WOOD_D, 14), 0, 0.94, 0);
  for (const y of [0.12, 0.83]) put(g, cyl(0.335, 0.335, 0.05, IRON, 14), 0, y, 0);
  for (const y of [0.36, 0.59]) put(g, cyl(0.362, 0.362, 0.05, IRON, 14), 0, y, 0);
  return g;
}
/** Round dice table with a felt top. */
export function diceTable() {
  const g = new THREE.Group();
  put(g, cyl(0.8, 0.8, 0.1, WOOD_L, 20), 0, 0.78, 0);
  put(g, cyl(0.68, 0.68, 0.02, mat('#2f6a3a', { roughness: 1 }), 20), 0, 0.84, 0);
  put(g, cyl(0.12, 0.2, 0.74, WOOD_D, 10), 0, 0.37, 0); put(g, cyl(0.45, 0.5, 0.06, WOOD_D, 14), 0, 0.03, 0);
  return g;
}
/** Small square table (card duel). */
export function cardTable() {
  const g = new THREE.Group();
  put(g, rbox(1.2, 0.1, 1.2, WOOD_L, 0.04), 0, 0.76, 0);
  put(g, rbox(0.8, 0.012, 0.8, mat('#6a2a3a', { roughness: 1 }), 0.004), 0, 0.815, 0);
  for (const [x, z] of [[-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45]]) put(g, rbox(0.1, 0.72, 0.1, WOOD_D, 0.02), x, 0.36, z);
  // two card fans
  for (const s of [-1, 1]) for (let i = 0; i < 3; i++) { const c = rbox(0.12, 0.01, 0.17, PARCH, 0.003); c.rotation.y = (i - 1) * 0.3; put(g, c, (i - 1) * 0.1, 0.83 + i * 0.011, s * 0.32); }
  return g;
}
/** Stool. */
export function stool() {
  const g = new THREE.Group(); put(g, cyl(0.22, 0.22, 0.08, WOOD, 12), 0, 0.46, 0);
  for (let i = 0; i < 3; i++) { const a = i * 2.09, l = rbox(0.06, 0.46, 0.06, WOOD_D, 0.02); l.rotation.set(Math.cos(a) * 0.12, 0, -Math.sin(a) * 0.12); put(g, l, Math.sin(a) * 0.13, 0.22, Math.cos(a) * 0.13); }
  return g;
}

/** Big stone hearth (front faces +z). Fire bits are added live by the room. */
export function hearth() {
  const g = new THREE.Group();
  put(g, rbox(3.4, 0.25, 1.4, STONE_D, 0.06), 0, 0.12, 0.1);
  for (const s of [-1, 1]) put(g, rbox(0.8, 1.6, 1.0, STONE, 0.1), s * 1.1, 0.9, 0);
  put(g, rbox(3.0, 0.5, 1.1, STONE, 0.1), 0, 1.9, 0);
  put(g, rbox(3.3, 0.16, 1.3, WOOD_D, 0.04), 0, 2.2, 0.05); // mantel
  put(g, rbox(2.0, 1.0, 0.8, STONE, 0.12), 0, 2.78, -0.1);
  put(g, rbox(1.4, 1.2, 0.2, mat('#1a1210'), 0.02), 0, 0.85, -0.4); // soot back
  // stones texture-ish: bumps
  for (let i = 0; i < 14; i++) put(g, rbox(0.34, 0.2, 0.06, i % 2 ? STONE_D : STONE, 0.05), ((i * 0.73) % 3.0) - 1.5, 0.4 + ((i * 0.37) % 2.4), 0.52);
  // logs + mantel candles + trophy (a fish on a plaque)
  for (const [x, r] of [[-0.25, 0.4], [0.2, -0.3], [0, 0]]) { const l = cyl(0.09, 0.09, 0.9, WOOD_D, 8); l.rotation.set(0, r, Math.PI / 2); put(g, l, x * 0.4, 0.34 + (x === 0 ? 0.12 : 0), 0.05); }
  put(g, rbox(0.7, 0.4, 0.06, WOOD, 0.03), 0, 2.6, 0.32);
  const fish = mesh(new THREE.SphereGeometry(0.16, 10, 8), mat('#4a9a7a')); fish.scale.set(1.6, 0.8, 0.4); put(g, fish, 0, 2.6, 0.38);
  return g;
}

/** Bar counter along x (customer side +z) with a back shelf (at -z) of bottles and kegs. */
export function barCounter(len = 4.6) {
  const g = new THREE.Group();
  put(g, rbox(len, 1.0, 0.7, WOOD, 0.05), 0, 0.5, 0);
  put(g, rbox(len + 0.2, 0.1, 0.9, WOOD_L, 0.04), 0, 1.05, 0);
  for (let i = 0; i < 5; i++) put(g, rbox(0.06, 0.8, 0.04, WOOD_D, 0.02), -len / 2 + 0.4 + i * (len - 0.8) / 4, 0.48, 0.37);
  put(g, rbox(len, 0.05, 0.05, GOLD, 0.02), 0, 0.15, 0.48);
  // back shelf
  put(g, rbox(len, 2.4, 0.4, WOOD_D, 0.04), 0, 1.2, -1.45);
  for (const y of [1.3, 1.85]) put(g, rbox(len - 0.1, 0.06, 0.45, WOOD, 0.02), 0, y, -1.3);
  const bm = [mat('#3a7a3a'), mat('#8a2a2a'), mat('#c8902a'), mat('#2a4a8a')];
  for (let i = 0; i < 22; i++) { const b = cyl(0.05, 0.06, 0.3, bm[i % 4], 8); put(g, b, -len / 2 + 0.3 + (i % 11) * (len - 0.6) / 10, (i < 11 ? 1.48 : 2.03), -1.3); }
  for (const x of [-len / 2 + 0.5, len / 2 - 0.5]) { const k = barrel(); k.rotation.z = Math.PI / 2; put(k, cyl(0.03, 0.03, 0.15, GOLD, 6), 0, 0.98, 0); put(g, k, x, 0.65, -1.2); k.rotation.z = Math.PI / 2; k.position.x = x + (x < 0 ? -0.45 : 0.45); }
  // tankards on the counter
  for (let i = 0; i < 4; i++) put(g, cyl(0.07, 0.07, 0.16, mat('#9a9a9e', { metalness: 0.6, roughness: 0.4 }), 10), -1.2 + i * 0.8, 1.18, 0.1);
  return g;
}

/** Quest board on legs (front +z), with parchment notes. */
export function questBoard() {
  const g = new THREE.Group();
  for (const s of [-1, 1]) put(g, rbox(0.14, 2.3, 0.14, WOOD_D, 0.03), s * 0.85, 1.15, 0);
  put(g, rbox(1.6, 1.2, 0.08, WOOD, 0.03), 0, 1.45, 0);
  put(g, rbox(1.9, 0.14, 0.26, WOOD_D, 0.04), 0, 2.2, 0.03); // little roof
  const notes = [[-0.45, 1.7, 0.1], [0.05, 1.75, -0.08], [0.5, 1.62, 0.12], [-0.3, 1.25, -0.06], [0.35, 1.2, 0.05]];
  for (const [x, y, r] of notes) { const n = rbox(0.36, 0.42, 0.01, PARCH, 0.004); n.rotation.z = r; put(g, n, x, y, 0.05); put(g, cyl(0.02, 0.02, 0.02, CLOTH_R, 6), x, y + 0.17, 0.065).rotation.x = Math.PI / 2; }
  return g;
}
/** Post mailbox: stone base, wooden box with a dome. */
export function mailbox() {
  const g = new THREE.Group();
  put(g, rbox(0.6, 0.3, 0.6, STONE, 0.05), 0, 0.15, 0); put(g, rbox(0.15, 0.6, 0.15, IRON, 0.03), 0, 0.6, 0);
  put(g, rbox(0.62, 0.5, 0.5, mat('#6a4a9a'), 0.05), 0, 1.1, 0);
  const d = mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.62, 12, 1, false, 0, Math.PI), mat('#6a4a9a')); d.rotation.z = Math.PI / 2; put(g, d, 0, 1.35, 0);
  put(g, rbox(0.3, 0.05, 0.04, mat('#151018'), 0.01), 0, 1.2, 0.26); put(g, rbox(0.12, 0.12, 0.02, GOLD, 0.02), 0, 1.0, 0.26);
  return g;
}
/** Banner on a pole stand: two-tone heraldic cloth with a gold emblem. */
export function banner(color = 'red') {
  const g = new THREE.Group();
  put(g, rbox(0.1, 3.0, 0.1, WOOD_D, 0.03), 0, 1.5, 0); put(g, rbox(0.5, 0.12, 0.5, WOOD_D, 0.04), 0, 0.06, 0);
  put(g, rbox(1.0, 0.07, 0.07, WOOD_D, 0.03), 0.45, 2.85, 0);
  const c = color === 'red' ? CLOTH_R : CLOTH_B;
  const cl = new THREE.Shape(); cl.moveTo(0, 0); cl.lineTo(0.8, 0); cl.lineTo(0.8, -1.5); cl.lineTo(0.4, -1.25); cl.lineTo(0, -1.5); cl.closePath();
  put(g, mesh(new THREE.ExtrudeGeometry(cl, { depth: 0.03, bevelEnabled: false }), c), 0.07, 2.8, 0);
  put(g, rbox(0.3, 0.3, 0.02, GOLD, 0.1), 0.47, 2.3, 0.035);
  return g;
}
/** Lantern on a post (glow added live). */
export function lanternPost(h = 2.2) {
  const g = new THREE.Group();
  put(g, rbox(0.14, h, 0.14, WOOD_D, 0.03), 0, h / 2, 0); put(g, rbox(0.4, 0.1, 0.4, WOOD_D, 0.03), 0, 0.05, 0);
  put(g, rbox(0.5, 0.06, 0.06, IRON, 0.02), 0.22, h - 0.05, 0);
  put(g, rbox(0.2, 0.26, 0.2, glowMat('#ffc070', 1.6), 0.03), 0.42, h - 0.3, 0); put(g, rbox(0.26, 0.06, 0.26, IRON, 0.02), 0.42, h - 0.14, 0);
  return g;
}
/** Raid plan board on an easel (front +z). */
export function raidBoard() {
  const g = new THREE.Group();
  for (const s of [-1, 1]) { const l = rbox(0.08, 2.0, 0.08, WOOD_D, 0.02); l.rotation.z = s * 0.08; put(g, l, s * 0.6, 1.0, 0); }
  put(g, rbox(1.5, 1.0, 0.05, PARCH, 0.02), 0, 1.4, 0.05);
  const plan = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.9), new THREE.MeshBasicMaterial({ map: TX.canvasTex('tavern-raid', 128, 82, (x, w, h) => {
    x.fillStyle = '#e8d6a8'; x.fillRect(0, 0, w, h); x.strokeStyle = '#7a3a2a'; x.lineWidth = 2;
    x.beginPath(); x.arc(84, 40, 16, 0, 7); x.stroke(); x.fillStyle = '#a8302a'; x.font = '15px m5x7'; x.fillText('BOSS', 72, 44);
    x.strokeStyle = '#2e4a8a'; for (const [a, b] of [[14, 20], [14, 60], [30, 40]]) { x.beginPath(); x.moveTo(a, b); x.lineTo(64, 40); x.stroke(); }
    x.fillStyle = '#2a1a12'; x.font = '14px m5x7'; x.fillText('PLAN A', 4, 10); x.fillText('dont pull early!!', 30, 78); }) }));
  put(g, plan, 0, 1.4, 0.08);
  return g;
}
/** Wooden tankard on a table (small static detail). */
export const tankard = () => { const g = new THREE.Group(); put(g, cyl(0.07, 0.08, 0.17, WOOD, 10), 0, 0.085, 0); put(g, cyl(0.075, 0.085, 0.02, IRON, 10), 0, 0.03, 0); put(g, cyl(0.06, 0.06, 0.01, mat('#f0e0b0'), 10), 0, 0.17, 0); return g; };
/** Candle (stick) + holder; flame glow added by instancing glowMat. */
export const candle = () => { const g = new THREE.Group(); put(g, cyl(0.07, 0.07, 0.03, IRON, 8), 0, 0.015, 0); put(g, cyl(0.03, 0.03, 0.16, mat('#f0e6c8'), 8), 0, 0.11, 0); put(g, mesh(new THREE.SphereGeometry(0.025, 6, 5), glowMat('#ffb050', 3)), 0, 0.21, 0); return g; };

/** The fish-man mascot (a chubby green murloc-ish blob with fins, big mouth). Front +z. */
export function fishMan() {
  const g = new THREE.Group(), skin = mat('#5aa86a', { roughness: 0.6 }), belly = mat('#c8d890'), fin = mat('#d86a4a');
  const body = mesh(new THREE.SphereGeometry(0.36, 14, 10), skin); body.scale.set(1, 1.15, 0.9); put(g, body, 0, 0.62, 0);
  const b2 = mesh(new THREE.SphereGeometry(0.28, 12, 8), belly); b2.scale.set(1, 1.1, 0.6); put(g, b2, 0, 0.56, 0.16);
  const head = new THREE.Group(); head.name = 'head'; put(g, head, 0, 1.0, 0.06);
  const hd = mesh(new THREE.SphereGeometry(0.3, 14, 10), skin); hd.scale.set(1.1, 0.9, 1); put(head, hd, 0, 0, 0);
  const mouth = mesh(new THREE.SphereGeometry(0.2, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat('#5a1a2a')); mouth.rotation.x = Math.PI / 2 + 0.3; mouth.scale.set(1.1, 1, 0.5); put(head, mouth, 0, -0.08, 0.2); mouth.name = 'mouth';
  for (const s of [-1, 1]) { put(head, mesh(new THREE.SphereGeometry(0.08, 10, 8), mat('#f8f0d8')), s * 0.14, 0.12, 0.22); put(head, mesh(new THREE.SphereGeometry(0.04, 8, 6), mat('#1a1a1a')), s * 0.14, 0.13, 0.29);
    const f = mesh(new THREE.ConeGeometry(0.12, 0.35, 6), fin); f.rotation.z = s * 1.2; put(head, f, s * 0.32, 0.05, -0.05); }
  const crest = mesh(new THREE.ConeGeometry(0.1, 0.4, 6), fin); crest.rotation.x = -0.4; put(head, crest, 0, 0.3, -0.08);
  for (const s of [-1, 1]) { const a = cyl(0.06, 0.07, 0.35, skin, 8); a.rotation.z = s * 0.9; put(g, a, s * 0.42, 0.62, 0.05).name = s < 0 ? 'armL' : 'armR';
    put(g, cyl(0.08, 0.09, 0.3, skin, 8), s * 0.16, 0.15, 0); }
  return g;
}
