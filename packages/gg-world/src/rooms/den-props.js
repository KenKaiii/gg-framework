// @ts-check
// The Den: furniture & clutter props (code-modelled). Each returns a Group placed at origin, floor at y=0.
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh, rng } from './kit.js';
import * as TX from './tex.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const WOOD = () => mat('#6a3f2c', { roughness: 0.7 }), WOOD_D = () => mat('#4a2a20', { roughness: 0.75 });
const PAL = ['#e63946', '#f1c453', '#2a9d8f', '#8d6cab', '#ff4fd8', '#457b9d', '#3ddc84', '#b04fd8', '#f4a261'];

const palTex = () => TX.canvasTex('den-pal', 16, 1, (x) => { PAL.forEach((c, i) => { x.fillStyle = c; x.fillRect(i, 0, 1, 1); }); }, { nearest: true });
/** Row of game boxes as ONE mesh (colour via UV into a palette strip, so bake() merges them all). */
export function gameBoxes(n, len, h, d, seed) {
  const r = rng(seed), gs = []; let x = -len / 2;
  for (let i = 0; i < n && x < len / 2 - 0.04; i++) {
    const w = 0.035 + r() * 0.03, hh = h * (0.8 + r() * 0.2), tilt = r() < 0.08 ? 0.25 : 0, u = (Math.floor(r() * PAL.length) + 0.5) / 16;
    const b = new THREE.BoxGeometry(w, hh, d * (0.85 + r() * 0.15)); const uv = b.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setXY(k, u, 0.5);
    b.rotateZ(tilt); b.translate(x + w / 2, hh / 2, 0); gs.push(b); x += w + 0.006 + (tilt ? 0.05 : 0);
  }
  return mesh(mergeGeometries(gs), mat('#c0c0c0', { map: palTex(), roughness: 0.55 }));
}

/** Low wooden TV cabinet with 3 cubbies (game boxes, a console). */
export function tvCabinet() {
  const g = new THREE.Group(), W = 2.4, H = 0.62, D = 0.62, wm = WOOD(), dm = WOOD_D();
  put(g, rbox(W + 0.08, 0.06, D + 0.06, wm, 0.025), 0, H, 0);
  put(g, rbox(W, 0.05, D, dm, 0.01), 0, 0.06, 0);
  put(g, rbox(W, 0.04, 0.04, dm, 0.01), 0, 0.02, D / 2 - 0.05);
  for (const x of [-W / 2, -0.4, 0.4, W / 2]) put(g, rbox(0.05, H - 0.04, D, x === -W / 2 || x === W / 2 ? wm : dm, 0.012), x, H / 2, 0);
  put(g, rbox(W, H, 0.03, mat('#2a1a18'), 0.005), 0, H / 2, -D / 2 + 0.02);
  put(g, rbox(0.75, 0.03, D - 0.05, dm, 0.01), 0, 0.3, 0);
  put(g, gameBoxes(28, 0.72, 0.42, 0.36, 3), -0.8, 0.09, 0.05);
  put(g, gameBoxes(28, 0.72, 0.42, 0.36, 8), 0.8, 0.09, 0.05);
  const con = consoleBox('#57536a'); con.scale.setScalar(0.85); put(g, con, 0, 0.09, 0.02);
  put(g, rbox(0.5, 0.08, 0.36, mat('#2b2a33', { roughness: 0.5 }), 0.02), 0, 0.36, 0); // VCR
  put(g, rbox(0.06, 0.02, 0.01, glowMat('#3ddc84', 2), 0.004), 0.16, 0.37, 0.18);
  return g;
}

/** Chunky CRT. Returns { g, screen }. Screen faces +z. */
export function crt() {
  const g = new THREE.Group(), shell = mat('#2b2838', { roughness: 0.45 }), dark = mat('#16141e', { roughness: 0.5 });
  put(g, rbox(1.05, 0.82, 0.18, shell, 0.06), 0, 0.43, 0.27);
  put(g, rbox(0.92, 0.72, 0.42, shell, 0.12), 0, 0.42, 0.0);
  put(g, rbox(0.62, 0.5, 0.3, dark, 0.12), 0, 0.42, -0.3);
  put(g, rbox(0.84, 0.6, 0.02, mat('#0d0c12', { roughness: 0.2 }), 0.05), -0.04, 0.47, 0.36);
  for (let i = 0; i < 3; i++) put(g, rbox(0.04, 0.04, 0.03, mat('#5a5668'), 0.015), 0.3 + i * 0.07, 0.09, 0.37);
  put(g, rbox(0.03, 0.02, 0.01, glowMat('#ff4f4f', 3), 0.004), 0.42, 0.1, 0.37);
  put(g, rbox(0.9, 0.03, 0.06, dark, 0.012), 0, 0.03, 0.2);
  // slightly bulged screen
  const geo = new THREE.PlaneGeometry(0.76, 0.54, 8, 6); const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i) / 0.38, y = p.getY(i) / 0.27; p.setZ(i, 0.03 * (1 - x * x * 0.5 - y * y * 0.5)); }
  geo.computeVertexNormals();
  const sm = new THREE.MeshBasicMaterial({ map: TX.gameScreen(0), toneMapped: false }); sm.color.setScalar(1.6);
  const screen = new THREE.Mesh(geo, sm); screen.position.set(-0.04, 0.47, 0.37); screen.userData.live = true; g.add(screen);
  return { g, screen };
}

/** Grey 16-bit console. */
export function consoleBox(c = '#8f8aa6') {
  const g = new THREE.Group(), m = mat(c, { roughness: 0.55 }), d = mat('#3d3a4c', { roughness: 0.5 });
  put(g, rbox(0.62, 0.1, 0.48, m, 0.04), 0, 0.05, 0);
  put(g, rbox(0.4, 0.05, 0.3, m, 0.02), 0, 0.12, -0.03);
  put(g, rbox(0.22, 0.02, 0.12, d, 0.008), 0, 0.15, -0.05);
  for (const x of [-0.18, 0.18]) put(g, rbox(0.08, 0.04, 0.03, d, 0.01), x, 0.11, 0.18);
  put(g, rbox(0.06, 0.03, 0.03, mat('#c4364a'), 0.01), -0.05, 0.13, 0.15);
  return g;
}

/** Controller lying on the floor. */
export function controller(c = '#cfcbe0') {
  const g = new THREE.Group(), m = mat(c, { roughness: 0.5 });
  put(g, rbox(0.3, 0.05, 0.12, m, 0.025), 0, 0.03, 0);
  for (const s of [-1, 1]) put(g, rbox(0.11, 0.06, 0.13, m, 0.05), s * 0.12, 0.03, 0.02);
  put(g, rbox(0.06, 0.012, 0.02, mat('#2a2833'), 0.005), -0.11, 0.06, 0.0); put(g, rbox(0.02, 0.012, 0.06, mat('#2a2833'), 0.005), -0.11, 0.06, 0.0);
  for (const [x, z, col] of [[0.1, -0.02, '#3ddc84'], [0.14, 0.01, '#b04fd8']]) put(g, mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.02, 10), mat(col, { metalness: 0.6, roughness: 0.35 })), x, 0.06, z);
  return g;
}

/** Curly cable from a to b along the floor (Vector3s). */
export function cable(a, b, curls = 3, seed = 1) {
  const r = rng(seed), pts = [], n = 40;
  const dir = new THREE.Vector3().subVectors(b, a), side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
  for (let i = 0; i <= n; i++) {
    const t = i / n, p = a.clone().lerp(b, t);
    p.addScaledVector(side, Math.sin(t * Math.PI * curls + seed) * 0.18 * Math.sin(t * Math.PI) + (r() - 0.5) * 0.02);
    p.y = Math.max(0.015, p.y * (1 - Math.min(1, t * 4)) + 0.015); pts.push(p);
  }
  return mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 80, 0.012, 5), mat('#14121a', { roughness: 0.5 }));
}

/** Big squashy beanbag (seat dent at +z top). */
export function beanbag(color = '#5b2a86', size = 1) {
  const geo = new THREE.SphereGeometry(0.75, 28, 18); const p = geo.attributes.position, r = rng(5);
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    y = y < -0.25 ? -0.25 - (y + 0.25) * 0.05 : y; // flat bottom
    const dent = Math.exp(-((x * x) / 0.18 + ((z - 0.25) ** 2) / 0.12)) * 0.42 * Math.max(0, (y + 0.1) / 0.85);
    y -= dent; z -= dent * 0.4; const sag = 1 + (y < 0 ? -y * 0.35 : 0);
    p.setXYZ(i, x * 1.1 * sag, y * 0.78 + Math.sin(x * 9 + z * 7) * 0.012, z * sag);
  }
  geo.computeVertexNormals();
  const g = new THREE.Group(); const b = mesh(geo, mat(color, { roughness: 0.62 })); b.position.y = 0.2; b.scale.setScalar(size); g.add(b);
  return g;
}

/** Tall bookcase full of games. Back at z=0, faces +z. */
export function bookcase(W = 1.1, H = 2.3, D = 0.36) {
  const g = new THREE.Group(), wm = WOOD(), dm = WOOD_D(); const n = 6;
  for (const x of [-W / 2, W / 2]) put(g, rbox(0.05, H, D, wm, 0.015), x, H / 2, D / 2);
  put(g, rbox(W, H, 0.03, mat('#2a1a18'), 0.005), 0, H / 2, 0.02);
  for (let i = 0; i <= n; i++) { const y = 0.05 + i * (H - 0.08) / n; put(g, rbox(W, 0.04, D, i === n ? wm : dm, 0.01), 0, y, D / 2); if (i < n) put(g, gameBoxes(30, W - 0.1 - (i % 3) * 0.12, 0.26, 0.26, 20 + i), -(i % 3) * 0.06, y + 0.02, D / 2 + 0.02); }
  return g;
}

/** Arcade cabinet. Returns { g, screen, marquee }. Faces +z. */
export function arcade() {
  const g = new THREE.Group(), body = mat('#24183a', { roughness: 0.5 }), side = mat('#5a2a86', { roughness: 0.5 });
  const sh = new THREE.Shape(); sh.moveTo(0, 0); sh.lineTo(0.75, 0); sh.lineTo(0.75, 0.95); sh.lineTo(0.55, 1.05); sh.lineTo(0.62, 1.55); sh.lineTo(0.5, 1.85); sh.lineTo(0.42, 1.95); sh.lineTo(0, 1.95); sh.lineTo(0, 0);
  for (const x of [-0.4, 0.34]) { const e = mesh(new THREE.ExtrudeGeometry(sh, { depth: 0.06, bevelEnabled: true, bevelSize: 0.015, bevelThickness: 0.015, bevelSegments: 1 }), side); e.rotation.y = -Math.PI / 2; e.position.set(x + 0.06, 0, -0.38); g.add(e); }
  put(g, rbox(0.68, 0.95, 0.7, body, 0.02), 0, 0.48, 0);
  put(g, rbox(0.68, 0.08, 0.32, mat('#1a1226'), 0.02), 0, 1.02, 0.24).rotation.x = 0.25;
  put(g, rbox(0.68, 0.9, 0.5, body, 0.02), 0, 1.45, -0.1);
  for (let i = 0; i < 4; i++) put(g, mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.03, 10), glowMat(['#ff4fd8', '#3ddc84', '#ffcf8a', '#8fa8ff'][i], 1.6)), 0.05 + i * 0.07, 1.08, 0.26);
  put(g, mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.1, 8), mat('#111')), -0.15, 1.11, 0.24); put(g, mesh(new THREE.SphereGeometry(0.03, 10, 8), mat('#e63946', { roughness: 0.3 })), -0.15, 1.17, 0.24);
  put(g, rbox(0.12, 0.16, 0.02, mat('#2a2a2a', { metalness: 0.6, roughness: 0.3 }), 0.01), 0, 0.6, 0.355);
  put(g, rbox(0.05, 0.08, 0.01, glowMat('#ffb36b', 1.3), 0.004), 0, 0.6, 0.37);
  const stex = TX.canvasTex('attract', 128, 128, (x, w, h) => { x.fillStyle = '#0a0620'; x.fillRect(0, 0, w, h); x.fillStyle = '#2b6cff'; for (let i = 0; i < 9; i++) x.fillRect(10 + (i * 37) % 100, 20 + (i * 53) % 80, 18, 4); x.fillStyle = '#ffd166'; x.beginPath(); x.moveTo(64, 70); x.arc(64, 70, 14, 0.6, 5.7); x.fill(); x.fillStyle = '#ff4fd8'; x.font = '20px m5x7'; x.textAlign = 'center'; x.fillText('INSERT COIN', 64, 112); x.fillStyle = '#3ddc84'; x.fillText('HI 31337', 64, 16); for (let y = 0; y < h; y += 2) { x.fillStyle = 'rgba(0,0,0,0.2)'; x.fillRect(0, y, w, 1); } }, { nearest: true });
  const sm = new THREE.MeshBasicMaterial({ map: stex, toneMapped: false }); sm.color.setScalar(1.1);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.46), sm); screen.position.set(0, 1.42, 0.205); screen.rotation.x = -0.18; screen.userData.live = true; g.add(screen);
  const mm = new THREE.MeshBasicMaterial({ map: TX.label('NIGHT RUN', '#ffe0f8', '#7a1f8f', 256, 64, 'italic 51px m5x7'), toneMapped: false }); mm.color.setScalar(1.2);
  const marquee = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.17), mm); marquee.position.set(0, 1.86, 0.17); marquee.userData.live = true; g.add(marquee);
  return { g, screen, marquee };
}

/** Black leather armchair facing +z, seat top ~0.45. */
export function armchair() {
  const g = new THREE.Group(), L = mat('#141218', { roughness: 0.32, metalness: 0.05 }), L2 = mat('#1c1a22', { roughness: 0.38 });
  put(g, rbox(0.95, 0.3, 0.85, L, 0.08), 0, 0.22, 0);
  put(g, rbox(0.68, 0.16, 0.68, L2, 0.07), 0, 0.42, 0.06);
  put(g, rbox(0.95, 0.75, 0.2, L, 0.09), 0, 0.68, -0.34).rotation.x = -0.12;
  for (const s of [-1, 1]) put(g, rbox(0.17, 0.32, 0.85, L, 0.08), s * 0.4, 0.5, 0.0);
  for (const s of [-1, 1]) for (const z of [-0.35, 0.35]) put(g, mesh(new THREE.CylinderGeometry(0.03, 0.02, 0.08, 8), WOOD_D()), s * 0.4, 0.04, z);
  return g;
}

/** Round side table with the black round shades + a mug. */
export function sideTable() {
  const g = new THREE.Group(), w = WOOD_D(), k = mat('#0c0c10', { roughness: 0.15, metalness: 0.5 });
  put(g, mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.04, 24), w), 0, 0.58, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.56, 10), w), 0, 0.29, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.03, 20), w), 0, 0.015, 0);
  const sh = new THREE.Group(); sh.position.set(-0.04, 0.6, 0.06); sh.rotation.y = 0.9; sh.scale.setScalar(1.9); g.add(sh);
  for (const s of [-1, 1]) { const lens = mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.01, 20), k); lens.rotation.x = Math.PI / 2 - 0.2; lens.position.set(s * 0.055, 0.035, 0); sh.add(lens); const arm = rbox(0.008, 0.008, 0.16, k, 0); arm.position.set(s * 0.1, 0.008, -0.08); sh.add(arm); }
  const br = mesh(new THREE.TorusGeometry(0.02, 0.004, 4, 8, Math.PI), k); br.position.set(0, 0.05, 0); sh.add(br);
  const mug = mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.1, 14), mat('#3ddc84', { roughness: 0.5 })); put(g, mug, 0.16, 0.65, -0.14);
  return g;
}

/** Lava lamp: returns { g, blobs[] } (blobs are live). */
export function lavaLamp() {
  const g = new THREE.Group(), chrome = mat('#8a7fa0', { metalness: 0.8, roughness: 0.3 });
  put(g, mesh(new THREE.CylinderGeometry(0.05, 0.1, 0.16, 16), chrome), 0, 0.08, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.035, 0.06, 0.08, 16), chrome), 0, 0.55, 0);
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.075, 0.34, 16), glowMat('#b04fd8', 0.9, { transparent: true, opacity: 0.55 })); glass.position.y = 0.33; glass.userData.live = true; g.add(glass);
  const blobs = []; for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), glowMat('#ff4fd8', 2.6)); b.userData.live = true; b.position.y = 0.25 + i * 0.08; g.add(b); blobs.push(b); }
  return { g, blobs };
}

/** Potted plant (leafy). */
export function plant(seed = 2) {
  const g = new THREE.Group(), r = rng(seed);
  put(g, mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.36, 16), mat('#3a2a34')), 0, 0.18, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.02, 16), mat('#20160f')), 0, 0.35, 0);
  const lg = new THREE.SphereGeometry(0.12, 8, 6); lg.scale(0.5, 0.12, 1.4); lg.translate(0, 0, 0.15);
  const lm = mat('#2f5e3a', { roughness: 0.7, side: THREE.DoubleSide });
  for (let i = 0; i < 16; i++) { const l = mesh(lg, i % 3 ? lm : mat('#3f7a48', { roughness: 0.7 })); l.position.set(0, 0.36 + r() * 0.5, 0); l.rotation.set(-0.3 - r() * 0.7, r() * 6.28, 0, 'YXZ'); g.add(l); }
  return g;
}

/** Pizza box (one slice missing), cans, chip bag. Floor-level cluster. */
export function snacks() {
  const g = new THREE.Group();
  put(g, rbox(0.5, 0.04, 0.5, mat('#c9a77a', { roughness: 0.9 }), 0.01), 0, 0.02, 0);
  const lid = rbox(0.5, 0.02, 0.5, mat('#bf9b6c', { roughness: 0.9 }), 0.01); lid.position.set(0, 0.2, -0.3); lid.rotation.x = 1.25; g.add(lid);
  const pz = mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.025, 24, 1, false, 0.8, Math.PI * 2 - Math.PI / 3), mat('#e0a040', { roughness: 0.8 })); put(g, pz, 0, 0.05, 0);
  for (let i = 0; i < 6; i++) put(g, mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.008, 10), mat('#a8322a')), Math.cos(i * 1.3 + 2) * 0.12, 0.066, Math.sin(i * 1.3 + 2) * 0.12);
  const cm = [mat('#3ddc84', { metalness: 0.6, roughness: 0.35 }), mat('#b04fd8', { metalness: 0.6, roughness: 0.35 }), mat('#c0c0cc', { metalness: 0.7, roughness: 0.3 })];
  const cg = new THREE.CylinderGeometry(0.035, 0.035, 0.12, 12);
  [[0.38, 0.06, 0.1, 0], [0.45, 0.06, -0.12, 1], [-0.4, 0.035, 0.25, 2]].forEach(([x, y, z, k], i) => { const c = mesh(cg, cm[k]); c.position.set(x, y, z); if (i === 2) c.rotation.z = Math.PI / 2; g.add(c); });
  const bag = rbox(0.28, 0.06, 0.36, mat('#e63946', { roughness: 0.4, metalness: 0.3 }), 0.03); bag.position.set(-0.4, 0.03, -0.15); bag.rotation.y = 0.6; g.add(bag);
  return g;
}

/** Floor cushion. */
export function cushion(c) { const g = new THREE.Group(); put(g, rbox(0.7, 0.16, 0.7, mat(c, { roughness: 0.9 }), 0.07), 0, 0.08, 0); return g; }
