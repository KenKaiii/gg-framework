// @ts-check
// The Studio: code-modelled props (stands, panels, desk, chairs, sofa, TV unit, whiteboard...). Floor at y=0, front = +z.
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh } from './kit.js';
import * as TX from './tex.js';

const METAL = () => mat('#2a2a34', { metalness: 0.6, roughness: 0.35 });
const DARK = () => mat('#1b1822', { roughness: 0.6 });
const cyl = (r0, r1, h, m, seg = 12) => mesh(new THREE.CylinderGeometry(r0, r1, h, seg), m);

/** Light stand: tripod legs + pole of height h. */
export function stand(h = 1.6) {
  const g = new THREE.Group(), m = METAL();
  put(g, cyl(0.018, 0.022, h, m, 8), 0, h / 2, 0);
  for (let i = 0; i < 3; i++) { const a = i * 2.09, l = cyl(0.012, 0.012, 0.5, m, 6); l.position.set(Math.sin(a) * 0.17, 0.18, Math.cos(a) * 0.17); l.rotation.set(Math.cos(a) * 0.75, 0, -Math.sin(a) * 0.75); g.add(l); }
  put(g, cyl(0.03, 0.03, 0.06, m, 8), 0, 0.36, 0);
  return g;
}
/** Ring light on a stand; returns { g, ring } (ring is a separate live mesh). */
export function ringLight() {
  const g = stand(1.5); const ring = mesh(new THREE.TorusGeometry(0.28, 0.035, 8, 32), glowMat('#fff1dc', 2.2)); ring.position.y = 1.62; g.add(ring);
  put(g, rbox(0.08, 0.14, 0.01, DARK(), 0.005), 0, 1.6, 0.01); // phone in the middle
  return { g, ring };
}
/** RGB LED panel on a stand; returns { g, face } (face material is animated). */
export function ledPanel() {
  const g = stand(1.4), face = new THREE.MeshBasicMaterial({ color: '#b04fd8', toneMapped: false });
  put(g, rbox(0.5, 0.34, 0.06, DARK(), 0.02), 0, 1.6, 0);
  const f = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.28), face); f.position.set(0, 1.6, 0.032); f.userData.live = true; g.add(f);
  return { g, face };
}
/** ON AIR light box on a stand; returns { g, sign } (sign material toggles). */
export function onAir() {
  const g = stand(1.7); put(g, rbox(0.62, 0.24, 0.12, DARK(), 0.03), 0, 1.86, 0);
  const sign = new THREE.MeshBasicMaterial({ map: TX.label('ON AIR', '#ffdede', '#c4142a', 256, 96, '87px m5x7'), toneMapped: false, color: '#552222' });
  const p = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.19), sign); p.position.set(0, 1.86, 0.062); p.userData.live = true; g.add(p);
  return { g, sign };
}
/** Camera on a tripod. */
export function tripodCam() {
  const g = stand(1.2); put(g, rbox(0.22, 0.14, 0.14, DARK(), 0.03), 0, 1.3, 0);
  const lens = cyl(0.05, 0.05, 0.12, mat('#0d0d12', { metalness: 0.5, roughness: 0.2 }), 16); lens.rotation.x = Math.PI / 2; lens.position.set(0, 1.3, 0.12); g.add(lens);
  put(g, rbox(0.03, 0.03, 0.01, glowMat('#ff3040', 3), 0.005), 0.08, 1.36, 0.071);
  return g;
}
/** Desk with two monitors (screen textures supplied) and a mic on a boom arm. */
export function streamDesk(texL, texR) {
  const g = new THREE.Group(), top = mat('#2b2230', { roughness: 0.5 }), m = METAL();
  put(g, rbox(1.8, 0.05, 0.75, top, 0.02), 0, 0.74, 0);
  for (const x of [-0.82, 0.82]) put(g, rbox(0.06, 0.72, 0.6, m, 0.02), x, 0.36, 0);
  put(g, rbox(1.4, 0.04, 0.02, glowMat('#ff4fd8', 2.4), 0.01), 0, 0.71, 0.36); // under-desk strip
  [[-0.38, texL, 0.18], [0.42, texR, -0.25]].forEach(([x, t, ry]) => {
    const mon = new THREE.Group(); put(g, mon, /** @type {number} */ (x), 0.77, -0.15, /** @type {number} */ (ry));
    put(mon, rbox(0.2, 0.02, 0.16, m, 0.01), 0, 0.01, 0); put(mon, rbox(0.04, 0.3, 0.03, m, 0.01), 0, 0.16, -0.02);
    put(mon, rbox(0.66, 0.4, 0.04, DARK(), 0.015), 0, 0.42, 0);
    const s = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.36), new THREE.MeshBasicMaterial({ map: /** @type {any} */ (t), toneMapped: false })); s.position.set(0, 0.42, 0.021); s.userData.live = true; mon.add(s);
  });
  put(g, rbox(0.46, 0.02, 0.15, mat('#3a2a4a'), 0.01), 0, 0.775, 0.18); // keyboard
  // boom arm + mic
  const arm1 = cyl(0.012, 0.012, 0.6, m, 6); arm1.position.set(-0.72, 1.0, -0.1); arm1.rotation.z = -0.5; g.add(arm1);
  const arm2 = cyl(0.012, 0.012, 0.5, m, 6); arm2.position.set(-0.45, 1.18, 0.05); arm2.rotation.set(0.6, 0, 1.3); g.add(arm2);
  put(g, cyl(0.04, 0.035, 0.16, mat('#111', { metalness: 0.4, roughness: 0.4 }), 10), -0.24, 1.12, 0.18);
  put(g, rbox(0.06, 0.06, 0.04, DARK(), 0.01), 0.75, 0.8, 0.2); put(g, cyl(0.04, 0.035, 0.11, mat('#c4142a'), 10), 0.65, 0.83, 0.1); // energy can
  return g;
}
/** Gaming chair (faces +z). */
export function gamingChair(accent = '#b04fd8') {
  const g = new THREE.Group(), b = mat('#1a1620', { roughness: 0.55 }), a = mat(accent, { roughness: 0.5 });
  for (let i = 0; i < 5; i++) { const ang = i * 1.256; put(g, rbox(0.05, 0.04, 0.3, METAL(), 0.015), Math.sin(ang) * 0.14, 0.05, Math.cos(ang) * 0.14, ang); }
  put(g, cyl(0.03, 0.03, 0.34, METAL(), 8), 0, 0.24, 0);
  put(g, rbox(0.52, 0.1, 0.5, b, 0.04), 0, 0.44, 0);
  put(g, rbox(0.5, 0.85, 0.1, b, 0.05), 0, 0.92, -0.24); put(g, rbox(0.2, 0.75, 0.11, a, 0.04), 0, 0.92, -0.235);
  put(g, rbox(0.3, 0.12, 0.08, b, 0.04), 0, 1.25, -0.18);
  for (const x of [-0.27, 0.27]) put(g, rbox(0.06, 0.04, 0.3, b, 0.015), x, 0.66, 0);
  return g;
}
/** Small round podcast table with two mics on stands facing +-x. */
export function podTable() {
  const g = new THREE.Group(), w = mat('#5a3424', { roughness: 0.6 });
  put(g, cyl(0.5, 0.5, 0.05, w, 24), 0, 0.72, 0); put(g, cyl(0.04, 0.05, 0.7, METAL(), 8), 0, 0.36, 0); put(g, cyl(0.25, 0.28, 0.03, METAL(), 16), 0, 0.015, 0);
  for (const s of [-1, 1]) { put(g, cyl(0.06, 0.07, 0.02, METAL(), 10), s * 0.25, 0.755, 0); put(g, cyl(0.01, 0.01, 0.2, METAL(), 6), s * 0.25, 0.85, 0);
    const mic = cyl(0.035, 0.03, 0.13, mat('#111', { metalness: 0.4 }), 10); mic.rotation.z = s * 1.1; mic.position.set(s * 0.3, 0.97, 0); g.add(mic); }
  put(g, cyl(0.035, 0.03, 0.1, mat('#e8e0d0'), 10), 0.05, 0.8, 0.25); // mug
  return g;
}
/** Simple padded chair (faces +z). */
export function chair(c = '#3a2440') {
  const g = new THREE.Group(), m = mat(c, { roughness: 0.8 });
  for (const [x, z] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) put(g, cyl(0.02, 0.02, 0.42, METAL(), 6), x, 0.21, z);
  put(g, rbox(0.5, 0.08, 0.48, m, 0.03), 0, 0.44, 0); put(g, rbox(0.48, 0.5, 0.07, m, 0.03), 0, 0.72, -0.22);
  return g;
}
/** Sofa section (seat ~0.45) of length L, back at -z, faces +z. arm: [left, right]. */
export function sofa(L, c = '#3b2a5a', arm = [true, true]) {
  const g = new THREE.Group(), m = mat(c, { roughness: 0.95 }), cm = mat('#4a3670', { roughness: 0.95 });
  put(g, rbox(L, 0.3, 0.9, m, 0.06), 0, 0.17, 0);
  const n = Math.max(1, Math.round(L / 0.8)); for (let i = 0; i < n; i++) put(g, rbox(L / n - 0.03, 0.14, 0.72, cm, 0.06), -L / 2 + (i + 0.5) * L / n, 0.38, 0.06);
  put(g, rbox(L, 0.5, 0.22, m, 0.08), 0, 0.55, -0.35);
  if (arm[0]) put(g, rbox(0.2, 0.28, 0.9, m, 0.08), -L / 2 + 0.1, 0.45, 0);
  if (arm[1]) put(g, rbox(0.2, 0.28, 0.9, m, 0.08), L / 2 - 0.1, 0.45, 0);
  return g;
}
/** Low TV unit + big TV (screen texture supplied); faces +z. */
export function tvUnit(tex) {
  const g = new THREE.Group(), w = mat('#2a1d24', { roughness: 0.6 });
  put(g, rbox(2.2, 0.42, 0.5, w, 0.03), 0, 0.23, 0); for (const x of [-0.75, 0, 0.75]) put(g, rbox(0.66, 0.3, 0.02, mat('#3a2a34', { roughness: 0.5 }), 0.01), x, 0.23, 0.25);
  put(g, rbox(0.4, 0.04, 0.25, METAL(), 0.01), 0, 0.46, -0.05); put(g, rbox(0.08, 0.2, 0.05, METAL(), 0.01), 0, 0.56, -0.1);
  put(g, rbox(1.9, 1.1, 0.06, DARK(), 0.02), 0, 1.15, -0.1);
  const s = new THREE.Mesh(new THREE.PlaneGeometry(1.82, 1.02), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })); s.position.set(0, 1.15, -0.065); s.userData.live = true; g.add(s);
  return g;
}
/** Vinyl shelf (cube crates of records) + turntable on top; returns { g, platter }. Faces +z. */
export function vinylShelf() {
  const g = new THREE.Group(), w = mat('#4a2c2a', { roughness: 0.7 });
  put(g, rbox(1.3, 0.9, 0.42, w, 0.02), 0, 0.45, 0);
  const sp = mat('#ffffff', { map: TX.spines(11) });
  for (const [x, y] of [[-0.32, 0.25], [0.32, 0.25], [-0.32, 0.67], [0.32, 0.67]]) { put(g, rbox(0.56, 0.36, 0.03, mat('#160f14'), 0.01), x, y, 0.2); put(g, rbox(0.5, 0.32, 0.3, sp, 0.005), x, y, 0.06); }
  put(g, rbox(0.5, 0.1, 0.38, mat('#1f1a1a', { roughness: 0.4 }), 0.02), -0.2, 0.95, 0);
  const platter = new THREE.Group(); platter.position.set(-0.24, 1.01, 0); platter.userData.live = true;
  put(platter, cyl(0.15, 0.15, 0.012, mat('#0c0a0c', { roughness: 0.3 }), 24)); put(platter, cyl(0.05, 0.05, 0.014, mat('#e0457b'), 12), 0, 0.001, 0);
  put(platter, rbox(0.03, 0.016, 0.02, mat('#f0e0c0'), 0.004), 0.1, 0.004, 0);
  g.add(platter);
  const tone = cyl(0.006, 0.006, 0.26, METAL(), 6); tone.rotation.x = Math.PI / 2; tone.rotation.z = 0.3; tone.position.set(-0.02, 1.03, 0.02); g.add(tone);
  put(g, rbox(0.3, 0.3, 0.02, mat('#ffffff', { map: TX.poster('wave') }), 0.005), 0.35, 1.05, -0.05, 0.1); // sleeve leaning
  return { g, platter };
}
/** Whiteboard on wheels with MRR scribbles; faces +z. */
export function whiteboard() {
  const g = new THREE.Group(), m = METAL();
  const tex = TX.canvasTex('studio-wb', 256, 160, (x, w, h) => { x.fillStyle = '#c9c6cf'; x.fillRect(0, 0, w, h); x.lineWidth = 3; x.strokeStyle = '#2a4fa8'; x.fillStyle = '#2a4fa8'; x.font = '39px m5x7';
    x.fillText('MRR: $0 -> $10k?', 14, 36); x.strokeStyle = '#c4142a'; x.beginPath(); x.moveTo(20, 140); x.lineTo(80, 132); x.lineTo(130, 138); x.lineTo(170, 90); x.lineTo(230, 50); x.stroke();
    x.fillStyle = '#c4142a'; x.font = '27px m5x7'; x.fillText('hockey stick (trust me)', 40, 76); x.fillStyle = '#2a7a4a'; x.fillText('1. ship  2. tweet  3. ???', 14, 104); });
  put(g, rbox(1.5, 1.0, 0.04, mat('#d8d4dc'), 0.01), 0, 1.4, 0);
  const s = new THREE.Mesh(new THREE.PlaneGeometry(1.42, 0.92), mat('#ffffff', { map: tex, roughness: 0.4 })); s.position.set(0, 1.4, 0.022); g.add(s);
  for (const x of [-0.74, 0.74]) { put(g, rbox(0.04, 1.85, 0.04, m, 0.01), x, 0.98, 0); put(g, rbox(0.05, 0.04, 0.55, m, 0.01), x, 0.07, 0);
    for (const z of [-0.25, 0.25]) put(g, cyl(0.035, 0.035, 0.03, mat('#111'), 10), x, 0.035, z).rotation.z = Math.PI / 2; }
  put(g, rbox(1.2, 0.03, 0.06, m, 0.01), 0, 0.88, 0.04);
  return g;
}
/** Green screen on a stand, half pulled down; faces +z. */
export function greenScreen() {
  const g = new THREE.Group(), m = METAL();
  for (const x of [-0.8, 0.8]) put(g, stand(2.1), x, 0, 0);
  put(g, cyl(0.05, 0.05, 1.8, DARK(), 12), 0, 2.08, 0).rotation.z = Math.PI / 2;
  put(g, rbox(1.66, 1.1, 0.01, mat('#2f8a3a', { roughness: 0.95 }), 0.005), 0, 1.5, 0.03);
  put(g, rbox(1.68, 0.03, 0.03, m, 0.01), 0, 0.95, 0.03);
  return g;
}
/** Free-standing acoustic foam divider on feet (length L along x). */
export function foamDivider(L = 2.2) {
  const g = new THREE.Group(), f = mat('#2a1d3a', { roughness: 1 }), f2 = mat('#3a2450', { roughness: 1 });
  put(g, rbox(L, 1.7, 0.08, DARK(), 0.02), 0, 1.0, 0);
  const n = Math.floor(L / 0.3); for (let i = 0; i < n; i++) for (let j = 0; j < 5; j++) { const p = mesh(new THREE.ConeGeometry(0.12, 0.08, 4), (i + j) % 2 ? f : f2); p.rotation.set(Math.PI / 2, 0, Math.PI / 4); p.position.set(-L / 2 + 0.15 + i * 0.3, 0.3 + j * 0.3, 0.07); g.add(p); }
  for (const x of [-L / 2 + 0.1, L / 2 - 0.1]) put(g, rbox(0.08, 0.04, 0.5, METAL(), 0.01), x, 0.02, 0);
  return g;
}
/** Neon sign plaque on a short stand. */
export function neonStand(text, color) {
  const g = stand(1.3); put(g, rbox(0.9, 0.3, 0.04, mat('#120c18'), 0.02), 0, 1.45, 0);
  const p = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.22), new THREE.MeshBasicMaterial({ map: TX.neon(text, color), transparent: true, toneMapped: false })); p.position.set(0, 1.45, 0.025); p.userData.live = true; g.add(p);
  return g;
}
/** Floor lamp with a warm shade. */
export function floorLamp() {
  const g = new THREE.Group(); put(g, cyl(0.16, 0.18, 0.03, METAL(), 16), 0, 0.015, 0); put(g, cyl(0.015, 0.015, 1.5, METAL(), 6), 0, 0.75, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.16, 0.24, 0.3, 18, 1, true), glowMat('#ffb36b', 1.3, { side: THREE.DoubleSide })), 0, 1.55, 0);
  return g;
}
/** Potted money plant (round leaves). */
export function moneyPlant(seed = 1) {
  const g = new THREE.Group(); put(g, cyl(0.17, 0.13, 0.32, mat('#6a3a2c'), 14), 0, 0.16, 0);
  const lm = mat('#3d7a3a', { roughness: 0.7 }), lg = new THREE.SphereGeometry(0.07, 8, 6); lg.scale(1, 0.3, 1);
  let s = seed; const r = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  for (let i = 0; i < 22; i++) { const a = r() * 6.28, h = 0.35 + r() * 0.55, d = 0.05 + r() * 0.2; const l = mesh(lg, lm); l.position.set(Math.cos(a) * d, h, Math.sin(a) * d); l.rotation.set(r() - 0.5, a, r() - 0.5); g.add(l); }
  put(g, cyl(0.008, 0.008, 0.6, mat('#4a5a2a'), 5), 0, 0.6, 0);
  return g;
}
