// @ts-check
// Club Cyberdelia props: graffiti brick, CRT monitor wall (instanced), DJ booth, payphones, rollerblade rack,
// translucent 90s laptops, arcade cabinets, sofas, beanbags, high bar with stools. Floor y=0, local origin.
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh } from './kit.js';
import * as TX from './tex.js';

const cyl = (rt, rb, h, m, seg = 14) => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
export const METAL = mat('#4a4c5c', { metalness: 0.7, roughness: 0.35 }), DARK = mat('#22202c', { roughness: 0.6 });
export const BLACK = mat('#15141a', { roughness: 0.5 }), VINYL = mat('#6a2a7a', { roughness: 0.55 }), TEAL = mat('#1f6a72', { roughness: 0.6 });
export const CYAN = glowMat('#3ff0ff', 1.6), MAG = glowMat('#ff4fd8', 1.6), ACID = glowMat('#9dff3d', 1.6);
const BEIGE = mat('#8a8470', { roughness: 0.7 });

/** Light concrete floor with paint splats + scuffs (readable). */
export function floorTex() {
  return TX.canvasTex('cyb-floor', 256, 256, (x, w, h) => {
    x.fillStyle = '#6a6878'; x.fillRect(0, 0, w, h); const r = TX.rand(31);
    for (let i = 0; i < 900; i++) { x.fillStyle = `rgba(${r() < 0.5 ? '255,255,255' : '0,0,0'},${0.06 * r()})`; x.fillRect(r() * w, r() * h, 2 + r() * 4, 2 + r() * 4); }
    x.strokeStyle = 'rgba(30,26,40,0.5)'; x.lineWidth = 2; x.strokeRect(1, 1, w - 2, h - 2);
    for (const c of ['#ff4fd8', '#3ff0ff', '#9dff3d']) { x.fillStyle = c; x.globalAlpha = 0.18; x.beginPath(); x.arc(r() * w, r() * h, 6 + r() * 10, 0, 7); x.fill(); }
    x.globalAlpha = 1;
  }, { repeat: true });
}
/** Brick wall with graffiti tags sprayed on. */
export function wallTex() {
  return TX.brick('#6a3a44', '#2e2230', 33);
}
/** Big graffiti mural canvas (transparent). */
export function graffiti(text, a, b, w = 1024, h = 256) {
  return TX.canvasTex('cyb-graf' + text, w, h, (x) => {
    x.font = `italic ${Math.round((Math.floor(h * 0.42)) * 1.5)}px m5x7`; x.textAlign = 'center'; x.textBaseline = 'middle';
    const g = x.createLinearGradient(0, 0, w, 0); g.addColorStop(0, a); g.addColorStop(1, b);
    x.lineWidth = 14; x.strokeStyle = '#120a1a'; x.strokeText(text, w / 2, h / 2);
    x.shadowColor = a; x.shadowBlur = 24; x.fillStyle = g; x.fillText(text, w / 2, h / 2);
    x.shadowBlur = 0; x.fillStyle = 'rgba(255,255,255,0.5)'; for (let i = 0; i < 40; i++) x.fillRect((i * 97) % w, h * 0.5 + ((i * 53) % 90), 2, 10 + (i % 5) * 6);
  });
}
/** Soft additive glow quads (wall washes behind neon/screens, floor pools) as ONE instanced mesh = 1 draw call, static.
 * items: [x, y, z, ry, w, h, color, flat?] in room coords; flat = lies on the floor. Opacity is the shared o. */
export function glowPlanes(items, o = 0.32) {
  const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), additive(TX.dotTex(), '#ffffff', o), items.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color();
  items.forEach(([x, y, z, ry, w, h, col, flat], i) => { e.set(flat ? -Math.PI / 2 : 0, +ry, 0, 'YXZ'); q.setFromEuler(e); im.setMatrixAt(i, m.compose(v.set(+x, +y, +z), q, s.set(+w, +h, 1))); im.setColorAt(i, c.set(String(col))); });
  im.renderOrder = 2; im.castShadow = im.receiveShadow = false; im.userData.noGround = true; im.frustumCulled = false; return im;
}
export const additive = (map, color = '#ffffff', o = 1) => new THREE.MeshBasicMaterial({ map, color, transparent: true, opacity: o, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending });

/** CRT monitor wall: rows of chunky monitors (instanced bodies + instanced screens with tinted shared texture). */
export function crtWall(cols, rows, screenTex) {
  const g = new THREE.Group(); const n = cols * rows;
  const body = new THREE.InstancedMesh(new THREE.BoxGeometry(0.62, 0.52, 0.5), mat('#3a3848', { roughness: 0.6 }), n);
  const scr = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.5, 0.4), new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false }), n);
  const m = new THREE.Matrix4(), c = new THREE.Color(), tints = ['#6ee7a0', '#3ff0ff', '#ff4fd8', '#9dff3d', '#8fa8ff', '#ffcf8a'];
  let i = 0;
  for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
    const x = (k - (cols - 1) / 2) * 0.66, y = 0.32 + r * 0.56;
    m.makeTranslation(x, y, 0); body.setMatrixAt(i, m); m.makeTranslation(x, y, 0.252); scr.setMatrixAt(i, m);
    scr.setColorAt(i, c.set(tints[(k * 7 + r * 3) % tints.length])); i++;
  }
  g.add(body, scr); g.userData.screens = scr;
  const racks = new THREE.Group(); const rack = rbox(cols * 0.66 + 0.2, 0.08, 0.6, METAL, 0.02); for (let r = 0; r <= rows; r++) put(racks, rack.clone(), 0, 0.04 + r * 0.56, 0);
  g.userData.racks = racks; return g;
}

const RECORD = new THREE.MeshBasicMaterial({ toneMapped: false, map: TX.canvasTex('cyb-rec', 64, 64, (x) => { x.fillStyle = '#101014'; x.fillRect(0, 0, 64, 64); x.strokeStyle = '#2a2a34'; for (let r = 12; r < 32; r += 3) { x.beginPath(); x.arc(32, 32, r, 0, 7); x.stroke(); } x.fillStyle = '#ff4fd8'; x.beginPath(); x.arc(32, 32, 10, 0, 7); x.fill(); x.fillStyle = '#fff'; x.fillRect(30, 24, 4, 6); }) });
/** DJ booth: graffiti front, two decks + mixer, speaker stacks. Decks returned as userData.platters. */
export function djBooth() {
  const g = new THREE.Group();
  put(g, rbox(2.6, 1.05, 0.9, DARK, 0.05), 0, 0.525, 0);
  const front = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 0.9), new THREE.MeshBasicMaterial({ map: graffiti('CYBERDELIA', '#ff4fd8', '#3ff0ff', 1024, 320), transparent: true, toneMapped: false }));
  put(g, front, 0, 0.55, 0.47);
  put(g, rbox(2.7, 0.05, 1.0, METAL, 0.02), 0, 1.07, 0);
  const plats = [];
  for (const x of [-0.75, 0.75]) { put(g, rbox(0.62, 0.08, 0.5, BLACK, 0.02), x, 1.13, 0); const p = cyl(0.21, 0.21, 0.02, RECORD, 24); put(g, p, x, 1.18, 0); put(g, rbox(0.03, 0.02, 0.3, METAL, 0.005), x + 0.22, 1.2, 0.02); plats.push(p); }
  put(g, rbox(0.4, 0.07, 0.45, mat('#30303c'), 0.02), 0, 1.13, 0);
  for (let i = 0; i < 4; i++) put(g, rbox(0.05, 0.02, 0.05, i % 2 ? CYAN : ACID, 0.01), -0.12 + i * 0.08, 1.175, 0.12);
  for (const x of [-1.75, 1.75]) { put(g, rbox(0.8, 1.6, 0.7, BLACK, 0.04), x, 0.8, -0.05); for (const y of [0.45, 1.15]) { const cone = cyl(0.26, 0.26, 0.03, mat('#2a2a34', { roughness: 0.9 }), 20); cone.rotation.x = Math.PI / 2; put(g, cone, x, y, 0.31); const ring = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.03, 8, 28), CYAN); put(g, ring, x, y, 0.33); } }
  g.userData.platters = plats; return g;
}

/** Wall payphone (front at +z). */
export function payphone() {
  const g = new THREE.Group(); const steel = mat('#8a8e9a', { metalness: 0.8, roughness: 0.3 });
  put(g, rbox(0.42, 0.75, 0.16, steel, 0.04), 0, 0, 0);
  put(g, rbox(0.3, 0.2, 0.02, mat('#1a1c22'), 0.01), 0, 0.12, 0.085);
  const keys = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.2), new THREE.MeshBasicMaterial({ map: TX.canvasTex('cyb-keys', 32, 40, (x) => { x.fillStyle = '#222'; x.fillRect(0, 0, 32, 40); x.fillStyle = '#ccc'; for (let i = 0; i < 12; i++) x.fillRect(3 + (i % 3) * 10, 3 + Math.floor(i / 3) * 9, 6, 6); }) }));
  put(g, keys, 0.03, -0.1, 0.09);
  const hs = rbox(0.08, 0.34, 0.08, BLACK, 0.03); put(g, hs, -0.15, 0.0, 0.13);
  put(g, rbox(0.06, 0.02, 0.02, ACID, 0.005), 0.1, 0.3, 0.085);
  g.userData.handset = hs; return g;
}

/** Rollerblade rack: rail (static group) + 4 skate boots and 16 wheels as instanced meshes (animated by the room). */
export function bladeRack() {
  const g = new THREE.Group(); put(g, rbox(1.8, 0.06, 0.4, METAL, 0.02), 0, 0.9, 0); for (const x of [-0.85, 0.85]) put(g, rbox(0.06, 1.6, 0.06, METAL, 0.01), x, 0.8, 0);
  put(g, rbox(1.8, 0.06, 0.4, METAL, 0.02), 0, 0.2, 0);
  const boots = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 0.26, 0.3), mat('#ffffff', { roughness: 0.4 }), 4);
  const wheels = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.04, 0.04, 0.03, 10).rotateZ(Math.PI / 2), BLACK, 16);
  const c = new THREE.Color(); ['#ff4fd8', '#3ff0ff', '#9dff3d', '#f5d33a'].forEach((h, i) => boots.setColorAt(i, c.set(h)));
  return { rail: g, boots, wheels };
}
/** Pose skates: i-th boot at (x0+i*0.4, y) with tilt rz. */
export function poseSkates(k, x0, y, z, f) {
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
  for (let i = 0; i < 4; i++) { const [dy, rz] = f(i); e.set(0, 0, rz); q.setFromEuler(e);
    m.compose(v.set(x0 + i * 0.4, y + dy + 0.2, z), q, one); k.boots.setMatrixAt(i, m);
    for (let w = 0; w < 4; w++) { const o = new THREE.Vector3(0, -0.17, -0.12 + w * 0.08).applyQuaternion(q); m.compose(v.set(x0 + i * 0.4 + o.x, y + dy + 0.2 + o.y, z + o.z), q, one); k.wheels.setMatrixAt(i * 4 + w, m); } }
  k.boots.instanceMatrix.needsUpdate = true; k.wheels.instanceMatrix.needsUpdate = true;
}

/** Arcade cabinet (front +z), screen material passed in. */
export function cabinet(screenMat, side) {
  const g = new THREE.Group(); put(g, rbox(0.85, 1.85, 0.8, BLACK, 0.04), 0, 0.925, 0);
  for (const s of [-0.43, 0.43]) put(g, rbox(0.02, 1.7, 0.75, side, 0.01), s, 0.9, 0.02);
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.5), screenMat); scr.rotation.x = -0.15; put(g, scr, 0, 1.35, 0.38);
  put(g, rbox(0.8, 0.1, 0.35, mat('#2a2834'), 0.03), 0, 0.98, 0.5);
  put(g, rbox(0.78, 0.2, 0.04, side, 0.01), 0, 1.75, 0.41);
  const stick = cyl(0.02, 0.02, 0.12, METAL, 6); put(g, stick, -0.15, 1.08, 0.5); put(g, mesh(new THREE.SphereGeometry(0.04, 8, 6), MAG), -0.15, 1.15, 0.5);
  return g;
}

/** Chunky translucent 90s laptop (open). */
export function laptop(shell) {
  const g = new THREE.Group(); put(g, rbox(0.42, 0.05, 0.3, shell, 0.02), 0, 0.025, 0);
  const lid = new THREE.Group(); put(lid, rbox(0.42, 0.3, 0.03, shell, 0.02), 0, 0.15, 0); put(lid, new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.22), glowMat('#6ee7a0', 1.2)), 0, 0.16, 0.017);
  lid.rotation.x = -0.25; put(g, lid, 0, 0.04, -0.14); lid.rotation.y = Math.PI; return g;
}
export const shells = () => [mat('#3ff0ff', { transparent: true, opacity: 0.75, roughness: 0.2 }), mat('#ff4fd8', { transparent: true, opacity: 0.75, roughness: 0.2 }), mat('#9dff3d', { transparent: true, opacity: 0.75, roughness: 0.2 })];

/** Vinyl sofa (seat facing +z), length L. */
export function sofa(L, m) {
  const g = new THREE.Group(); put(g, rbox(L, 0.42, 0.85, m, 0.1), 0, 0.21, 0); put(g, rbox(L, 0.55, 0.22, m, 0.1), 0, 0.65, -0.32);
  for (const s of [-1, 1]) put(g, rbox(0.2, 0.3, 0.85, m, 0.08), s * (L / 2 - 0.1), 0.55, 0);
  put(g, rbox(L - 0.4, 0.04, 0.02, CYAN, 0.01), 0, 0.05, 0.43); return g;
}
export function beanbag(m) { const b = mesh(new THREE.SphereGeometry(0.45, 14, 10), m); b.scale.set(1, 0.55, 1); b.position.y = 0.24; const g = new THREE.Group(); g.add(b); return g; }
/** Low cable-spool table with clutter. */
export function spoolTable() {
  const g = new THREE.Group(); const wood = mat('#8a6a4a', { roughness: 0.8 });
  put(g, cyl(0.55, 0.55, 0.06, wood, 20), 0, 0.42, 0); put(g, cyl(0.2, 0.2, 0.36, wood, 12), 0, 0.21, 0); put(g, cyl(0.5, 0.5, 0.05, wood, 20), 0, 0.03, 0);
  for (let i = 0; i < 3; i++) put(g, cyl(0.035, 0.035, 0.12, [CYAN, MAG, ACID][i], 8), -0.25 + i * 0.12, 0.51, 0.2);
  put(g, rbox(0.4, 0.04, 0.4, mat('#c8a060'), 0.01), 0.15, 0.47, -0.1); return g;
}
/** High bar counter with neon strip (length L along x). */
export function highBar(L) {
  const g = new THREE.Group(); put(g, rbox(L, 1.0, 0.6, DARK, 0.04), 0, 0.5, 0); put(g, rbox(L + 0.1, 0.05, 0.75, mat('#5a5a6a', { metalness: 0.5, roughness: 0.3 }), 0.02), 0, 1.03, 0);
  put(g, rbox(L - 0.1, 0.03, 0.02, MAG, 0.01), 0, 0.9, 0.31); return g;
}
export function stool() { const g = new THREE.Group(); put(g, cyl(0.2, 0.2, 0.07, VINYL, 14), 0, 0.72, 0); put(g, cyl(0.03, 0.03, 0.7, METAL, 6), 0, 0.36, 0); put(g, cyl(0.2, 0.22, 0.03, METAL, 12), 0, 0.015, 0); return g; }
export { BEIGE };
