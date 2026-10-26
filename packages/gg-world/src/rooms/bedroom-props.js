// @ts-check
// Night Shift props: code-modelled furniture and clutter for the bedroom (floor at y=0, local origin).
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh, rng } from './kit.js';
import * as TX from './tex.js';

export const cyl = (rt, rb, h, m, seg = 16) => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
export const WOOD = mat('#5a3a2a', { roughness: 0.7 }), DWOOD = mat('#3a2620', { roughness: 0.75 });
export const BEIGE = mat('#b9ad8c', { roughness: 0.6 }), DARK = mat('#1c1a22', { roughness: 0.5 }), METAL = mat('#5b5e6b', { metalness: 0.6, roughness: 0.35 });

/** Rumpled cloth: a plane draped in a box (w x d) with folds; edges beyond `flat` hang down. */
export function cloth(w, d, color, seed = 1, flat = [w / 2, d / 2], hang = 0.3, amp = 0.05) {
  const g = new THREE.PlaneGeometry(w, d, 28, 28); g.rotateX(-Math.PI / 2); const p = g.attributes.position; const r = rng(seed);
  const k = [r() * 6, r() * 6, r() * 6, 3 + r() * 4, 2 + r() * 3];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i); let y = amp * (Math.sin(x * k[3] + k[0]) * Math.cos(z * k[4] + k[1]) + 0.6 * Math.sin((x + z) * 7 + k[2]));
    const ox = Math.max(0, Math.abs(x) - flat[0]), oz = Math.max(0, Math.abs(z) - flat[1]); const o = Math.max(ox, oz);
    if (o > 0) { y -= Math.min(o, hang) * 1.0; const s = Math.min(o, hang) * 0.9; p.setX(i, x - Math.sign(x) * (ox > 0 ? s * 0.6 : 0)); p.setZ(i, z - Math.sign(z) * (oz > 0 ? s * 0.6 : 0)); }
    p.setY(i, y);
  }
  g.computeVertexNormals(); return mesh(g, mat(color, { roughness: 0.95, side: THREE.DoubleSide }));
}

export function bed() {
  const g = new THREE.Group();
  for (const [x, z] of [[-0.5, -0.98], [0.5, -0.98], [-0.5, 0.98], [0.5, 0.98]]) put(g, rbox(0.08, 0.32, 0.08, WOOD, 0.02), x, 0.16, z);
  put(g, rbox(1.08, 0.14, 2.04, WOOD, 0.03), 0, 0.28, 0);
  put(g, rbox(1.12, 0.95, 0.08, WOOD, 0.03), 0, 0.5, -1.02); put(g, rbox(1.2, 0.07, 0.12, DWOOD, 0.03), 0, 0.99, -1.02);
  for (let i = -2; i <= 2; i++) put(g, rbox(0.06, 0.45, 0.04, DWOOD, 0.015), i * 0.2, 0.62, -0.97);
  put(g, rbox(1.12, 0.5, 0.08, WOOD, 0.03), 0, 0.3, 1.02);
  put(g, rbox(0.98, 0.2, 1.94, mat('#b9bfd8', { roughness: 0.9 }), 0.07), 0, 0.45, 0);
  const pil = rbox(0.72, 0.14, 0.38, mat('#d4d8ea', { roughness: 0.95 }), 0.07); pil.rotation.set(0.25, 0.12, 0.05); put(g, pil, -0.04, 0.63, -0.72, 0.12);
  const bl = cloth(1.2, 1.5, '#3b54a8', 3, [0.5, 0.75], 0.32, 0.055); bl.position.set(0.04, 0.58, 0.22); bl.rotation.y = 0.06; g.add(bl);
  const sh = cloth(0.7, 0.5, '#7c86b8', 9, [0.3, 0.25], 0.1, 0.04); sh.position.set(-0.15, 0.63, -0.35); sh.rotation.y = 0.5; g.add(sh);
  return g;
}

/** CRT TV; returns group with userData.screen material. */
export function crt() {
  const g = new THREE.Group(); const sm = new THREE.MeshBasicMaterial({ map: TX.gameScreen(0), toneMapped: false });
  put(g, rbox(0.78, 0.62, 0.42, DARK, 0.06), 0, 0.31, 0.06);
  put(g, rbox(0.6, 0.48, 0.32, DARK, 0.08), 0, 0.3, -0.26);
  put(g, rbox(0.7, 0.04, 0.03, DARK, 0.01), 0, 0.06, 0.28);
  const sc = mesh(new THREE.PlaneGeometry(0.58, 0.44), sm); put(g, sc, -0.04, 0.34, 0.272);
  for (let i = 0; i < 3; i++) put(g, cyl(0.018, 0.018, 0.02, METAL, 10), 0.32, 0.45 - i * 0.07, 0.28).rotation.x = Math.PI / 2;
  put(g, glowRect(0.02, 0.02, '#ff3b3b', 3), 0.32, 0.12, 0.282);
  const stk = mesh(new THREE.PlaneGeometry(0.12, 0.06), new THREE.MeshBasicMaterial({ map: TX.label('NO CARRIER', '#3ddc84', '#111', 256, 128, '60px m5x7') })); stk.rotation.z = 0.15; put(g, stk, 0.27, 0.56, 0.276);
  for (const s of [-1, 1]) { const a = cyl(0.006, 0.006, 0.5, METAL, 5); a.rotation.z = s * 0.5; put(g, a, s * 0.12, 0.82, -0.2); }
  g.userData.screen = sm; return g;
}
export function glowRect(w, h, c, p = 2.5) { return mesh(new THREE.PlaneGeometry(w, h), glowMat(c, p)); }

export function tvCabinet(r = rng(5)) {
  const g = new THREE.Group();
  put(g, rbox(0.62, 0.05, 1.4, WOOD, 0.02), 0, 0.53, 0); put(g, rbox(0.6, 0.04, 1.36, WOOD, 0.01), 0, 0.27, 0); put(g, rbox(0.6, 0.04, 1.36, WOOD, 0.01), 0, 0.05, 0);
  for (const z of [-0.68, 0, 0.68]) put(g, rbox(0.6, 0.53, 0.04, DWOOD, 0.01), 0, 0.27, z);
  put(g, rbox(0.04, 0.5, 1.36, DWOOD, 0), -0.29, 0.28, 0);
  vhsRow(g, r, -0.6, 0.07, 0.3, 9); vhsRow(g, r, 0.06, 0.07, 0.3, 6);
  put(g, rbox(0.42, 0.08, 0.5, DARK, 0.02), 0, 0.33, 0.34); // VCR
  put(g, glowRect(0.08, 0.02, '#3ddc84', 2.4), 0.212, 0.34, 0.24).rotation.y = Math.PI / 2;
  return g;
}
function vhsRow(g, r, z0, y, x, n) {
  const cols = ['#1a1a22', '#1a1a22', '#e9e2d0', '#1f2a3a'];
  for (let i = 0; i < n; i++) { const b = rbox(0.4, 0.19, 0.035, mat(cols[Math.floor(r() * 4)]), 0.006); b.rotation.z = (r() - 0.5) * 0.05; put(g, b, 0.02, y + 0.095, z0 + i * 0.06); put(g, rbox(0.012, 0.14, 0.03, mat('#e9e2d0'), 0), x - 0.08, y + 0.095, z0 + i * 0.06); }
}
export function vhs(c = '#1a1a22') { const g = new THREE.Group(); put(g, rbox(0.19, 0.035, 0.11, mat(c), 0.008), 0, 0.018, 0); put(g, rbox(0.13, 0.002, 0.07, mat('#e9e2d0'), 0), 0, 0.037, 0); return g; }

export function console16() {
  const g = new THREE.Group(); const gr = mat('#9b9aa3', { roughness: 0.5 });
  put(g, rbox(0.42, 0.07, 0.3, gr, 0.03), 0, 0.035, 0); put(g, rbox(0.2, 0.03, 0.12, METAL, 0.01), 0, 0.08, -0.03);
  put(g, rbox(0.14, 0.04, 0.03, mat('#4f3fa6'), 0.01), -0.06, 0.08, 0.1); put(g, rbox(0.14, 0.04, 0.03, mat('#4f3fa6'), 0.01), 0.1, 0.08, 0.1);
  return g;
}
export function pad() {
  const g = new THREE.Group(); put(g, rbox(0.2, 0.035, 0.09, mat('#8f8e98', { roughness: 0.5 }), 0.03), 0, 0.02, 0);
  put(g, rbox(0.04, 0.012, 0.04, DARK, 0.005), -0.05, 0.04, 0); for (let i = 0; i < 4; i++) put(g, cyl(0.009, 0.009, 0.012, mat('#d94f4f'), 8), 0.04 + (i % 2) * 0.025, 0.04, -0.012 + (i > 1 ? 0.025 : 0));
  return g;
}
/** Floor cable as a tube through points. */
export function cable(pts, r = 0.008) { return mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p))), 40, r, 5), DARK); }

export function desk() {
  const g = new THREE.Group();
  put(g, rbox(1.9, 0.06, 0.78, WOOD, 0.02), 0, 0.74, 0);
  put(g, rbox(0.05, 0.71, 0.7, DWOOD, 0.01), -0.9, 0.355, 0);
  put(g, rbox(0.5, 0.71, 0.7, DWOOD, 0.02), 0.66, 0.355, 0);
  for (let i = 0; i < 3; i++) { put(g, rbox(0.46, 0.2, 0.02, WOOD, 0.01), 0.66, 0.15 + i * 0.22, 0.355); put(g, rbox(0.12, 0.02, 0.02, METAL, 0.005), 0.66, 0.2 + i * 0.22, 0.37); }
  put(g, rbox(1.3, 0.4, 0.02, DWOOD, 0), -0.2, 0.5, -0.36);
  return g;
}
/** Beige 90s PC; userData.screen = terminal material, userData.cursor = mesh. */
export function pc() {
  const g = new THREE.Group(); const sm = new THREE.MeshBasicMaterial({ map: TX.termScreen(3, '#6ee7a0'), toneMapped: false });
  put(g, rbox(0.56, 0.16, 0.44, BEIGE, 0.02), 0, 0.08, 0);
  put(g, rbox(0.18, 0.02, 0.01, DARK, 0.004), -0.12, 0.1, 0.222); put(g, glowRect(0.015, 0.015, '#3ddc84', 3), 0.2, 0.06, 0.222);
  put(g, rbox(0.46, 0.4, 0.36, BEIGE, 0.04), 0, 0.37, -0.02); put(g, rbox(0.34, 0.3, 0.2, BEIGE, 0.06), 0, 0.37, -0.24);
  put(g, rbox(0.4, 0.31, 0.01, DARK, 0.01), 0, 0.38, 0.162);
  put(g, mesh(new THREE.PlaneGeometry(0.36, 0.27), sm), 0, 0.38, 0.168);
  const cur = glowRect(0.022, 0.012, '#6ee7a0', 3); cur.userData.live = true; put(g, cur, -0.135, 0.285, 0.17);
  const st = mesh(new THREE.PlaneGeometry(0.1, 0.035), new THREE.MeshBasicMaterial({ map: TX.label('follow the white rabbit', '#1a1a1a', '#e9e5da', 256, 64, '30px m5x7') })); put(g, st, 0.15, 0.2, 0.181);
  g.userData.screen = sm; g.userData.cursor = cur; return g;
}
export function keyboard() { const g = new THREE.Group(); put(g, rbox(0.46, 0.03, 0.16, BEIGE, 0.01), 0, 0.015, 0); put(g, rbox(0.42, 0.012, 0.11, mat('#d8cfb4'), 0.004), 0, 0.034, 0.005); put(g, rbox(0.06, 0.025, 0.09, BEIGE, 0.012), 0.33, 0.012, 0.02); return g; }
export function deskLamp() {
  const g = new THREE.Group(); const m = DARK;
  put(g, cyl(0.08, 0.09, 0.03, m, 20), 0, 0.015, 0); const a = rbox(0.025, 0.4, 0.025, m, 0.01); a.rotation.z = -0.35; put(g, a, 0.07, 0.2, 0);
  const b = rbox(0.025, 0.3, 0.025, m, 0.01); b.rotation.z = 1.1; put(g, b, 0.0, 0.43, 0);
  const sh = mesh(new THREE.ConeGeometry(0.09, 0.14, 20, 1, true), mat('#1d1d24', { side: THREE.DoubleSide })); sh.rotation.z = -0.6; put(g, sh, -0.15, 0.48, 0);
  put(g, mesh(new THREE.SphereGeometry(0.035, 10, 8), glowMat('#ffcf8a', 4)), -0.17, 0.44, 0);
  return g;
}
export function chair() {
  const g = new THREE.Group(); 
  for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2; const leg = rbox(0.04, 0.03, 0.3, METAL, 0.01); leg.rotation.y = a; put(g, leg, Math.sin(a) * 0.14, 0.07, Math.cos(a) * 0.14).rotation.y = a; put(g, mesh(new THREE.SphereGeometry(0.03, 8, 6), DARK), Math.sin(a) * 0.28, 0.03, Math.cos(a) * 0.28); }
  put(g, cyl(0.025, 0.025, 0.32, METAL), 0, 0.24, 0);
  put(g, rbox(0.48, 0.08, 0.46, mat('#2b3a6e', { roughness: 0.9 }), 0.04), 0, 0.44, 0);
  put(g, rbox(0.44, 0.5, 0.07, mat('#2b3a6e', { roughness: 0.9 }), 0.035), 0, 0.82, 0.24).rotation.x = -0.1;
  put(g, rbox(0.04, 0.3, 0.04, METAL, 0.01), 0, 0.55, 0.25);
  const h = cloth(0.56, 0.62, '#2f7a52', 12, [0.24, 0.05], 0.4, 0.03); h.position.set(0, 1.08, 0.26); g.add(h);
  const sl = rbox(0.1, 0.45, 0.1, mat('#2f7a52', { roughness: 0.95 }), 0.05); sl.rotation.z = 0.15; put(g, sl, 0.25, 0.82, 0.3);
  return g;
}
export function shelf(r, len = 1.3) {
  const g = new THREE.Group(); put(g, rbox(len, 0.04, 0.24, WOOD, 0.01), 0, 0, 0.12);
  for (const s of [-1, 1]) put(g, rbox(0.03, 0.16, 0.18, DWOOD, 0.01), s * (len / 2 - 0.12), -0.09, 0.09);
  const cols = ['#7a2e2e', '#2e4a7a', '#c9a24a', '#3e6b48', '#7a2e2e', '#d9d2c0', '#2e4a7a', '#3e6b48']; let x = -len / 2 + 0.06;
  while (x < len / 2 - 0.1) { if (r() < 0.12) { x += 0.12; continue; } const bw = 0.03 + r() * 0.035, bh = 0.16 + r() * 0.1; const b = rbox(bw, bh, 0.16 + r() * 0.04, mat(cols[Math.floor(r() * 8)]), 0.006); if (r() < 0.1) b.rotation.z = 0.3; put(g, b, x + bw / 2, 0.02 + bh / 2, 0.12); x += bw + 0.004; }
  return g;
}
export function posterOn(kind, title, w = 0.6, tilt = 0) {
  const g = new THREE.Group(); const p = mesh(new THREE.PlaneGeometry(w, w * 1.5), mat('#ffffff', { map: TX.poster(kind, title), roughness: 0.9 })); g.add(p);
  for (const [x, y] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) { const t = mesh(new THREE.PlaneGeometry(0.08, 0.03), mat('#c8c0a0', { roughness: 0.9 })); t.position.set(x * w / 2, y * w * 0.75, 0.002); t.rotation.z = x * y * 0.6; g.add(t); }
  g.rotation.z = tilt; return g;
}
export function skateboard() {
  const g = new THREE.Group(); const b = new THREE.Group(); b.rotation.x = -0.28; g.add(b);
  put(b, rbox(0.22, 0.8, 0.025, mat('#7b3fa8', { roughness: 0.6 }), 0.01), 0, 0.4, 0); put(b, rbox(0.12, 0.3, 0.004, mat('#3ddc84'), 0), 0, 0.42, -0.014);
  for (const y of [0.15, 0.65]) for (const s of [-1, 1]) { const w = cyl(0.03, 0.03, 0.03, mat('#e3c34a'), 10); w.rotation.z = Math.PI / 2; put(b, w, s * 0.08, y, 0.05); }
  return g;
}
export function boombox() {
  const g = new THREE.Group(); put(g, rbox(0.62, 0.3, 0.16, DARK, 0.03), 0, 0.16, 0);
  for (const s of [-1, 1]) { const sp = cyl(0.1, 0.1, 0.02, DARK, 20); sp.rotation.x = Math.PI / 2; put(g, sp, s * 0.19, 0.15, 0.08); put(g, cyl(0.03, 0.03, 0.024, METAL, 12), s * 0.19, 0.15, 0.08).rotation.x = Math.PI / 2; }
  put(g, rbox(0.14, 0.09, 0.01, METAL, 0.005), 0, 0.17, 0.082); put(g, glowRect(0.1, 0.02, '#ff9f4a', 2.2), 0, 0.27, 0.082);
  const h = mesh(new THREE.TorusGeometry(0.22, 0.015, 6, 20, Math.PI), METAL); put(g, h, 0, 0.31, 0);
  return g;
}
export function pizzaBox() {
  const g = new THREE.Group(); const c = mat('#b48a5a', { roughness: 0.95 });
  put(g, rbox(0.5, 0.04, 0.5, c, 0.01), 0, 0.02, 0); const lid = rbox(0.5, 0.012, 0.5, c, 0.004); lid.rotation.x = -1.25; put(g, lid, 0, 0.24, -0.33);
  for (let i = 0; i < 2; i++) { const s = mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 3, 1, false, 0, Math.PI / 4), mat('#d98c3a')); put(g, s, 0, 0.05, 0, i * 1.6 + 0.3); put(g, cyl(0.025, 0.025, 0.006, mat('#c23b3b', { metalness: 0.5, roughness: 0.35 }), 10), Math.sin(i * 1.6 + 0.7) * 0.11, 0.063, Math.cos(i * 1.6 + 0.7) * 0.11); }
  return g;
}
export function can(lying = false, crushed = false, c = '#c23b3b') { const g = new THREE.Group(); const m = cyl(0.033, 0.033, crushed ? 0.07 : 0.12, mat(c, { metalness: 0.5, roughness: 0.35 }), 12); if (crushed) m.scale.x = 0.6; if (lying) { m.rotation.z = Math.PI / 2; m.position.y = 0.033; } else m.position.y = crushed ? 0.035 : 0.06; g.add(m); return g; }
export function backpack() { const g = new THREE.Group(); const m = mat('#3a3f52', { roughness: 0.9 }); const b = rbox(0.34, 0.42, 0.2, m, 0.09); b.rotation.x = -0.35; put(g, b, 0, 0.18, 0); put(g, rbox(0.24, 0.16, 0.08, mat('#b04f4f', { roughness: 0.9 }), 0.04), 0, 0.12, 0.12).rotation.x = -0.35; return g; }
export function beanbag() {
  // squashed teardrop: wide soft base, narrower slumped top, leaning back
  const pts = []; for (let i = 0; i <= 16; i++) { const t = i / 16, a = -Math.PI / 2 + t * Math.PI; const rr = Math.cos(a) * (0.52 - 0.22 * t * t); pts.push(new THREE.Vector2(Math.max(rr, 0.001), 0.3 + Math.sin(a) * 0.3 + t * t * 0.2)); }
  const g = new THREE.Group(); const fab = mat('#6a2f8a', { roughness: 0.95 });
  const m = mesh(new THREE.LatheGeometry(pts, 24), fab); m.scale.set(1, 0.9, 0.85); m.rotation.x = 0.25; g.add(m);
  const dent = mesh(new THREE.SphereGeometry(0.3, 16, 10), mat('#4e2266', { roughness: 0.95 })); dent.scale.set(1, 0.3, 0.9); put(g, dent, 0, 0.5, -0.1);
  const seam = mesh(new THREE.TorusGeometry(0.4, 0.012, 5, 32), mat('#b04fd8', { roughness: 0.8 })); seam.rotation.x = Math.PI / 2 + 0.25; seam.scale.set(1, 0.85, 1); put(g, seam, 0, 0.36, 0.05);
  return g;
}
export function laundry() {
  const g = new THREE.Group(); put(g, mesh(new THREE.CylinderGeometry(0.24, 0.2, 0.42, 16, 1, true), mat('#8a7a5a', { roughness: 1, side: THREE.DoubleSide })), 0, 0.21, 0);
  const c = cloth(0.6, 0.6, '#3b54a8', 4, [0.18, 0.18], 0.2, 0.06); c.position.y = 0.44; g.add(c);
  const sl = cloth(0.4, 0.3, '#6b2a2a', 6, [0.1, 0.1], 0.1, 0.04); sl.position.set(0.25, 0.04, 0.2); g.add(sl); return g;
}
export function guitar() {
  const g = new THREE.Group(); const b = new THREE.Group(); b.rotation.x = -0.2; g.add(b);
  for (const [y, r] of [[0.3, 0.2], [0.55, 0.15]]) { const c = cyl(r, r, 0.08, mat('#8a2a2a', { roughness: 0.4 }), 20); c.rotation.x = Math.PI / 2; put(b, c, 0, y, 0); }
  put(b, rbox(0.06, 0.55, 0.03, DWOOD, 0.01), 0, 0.95, 0); put(b, rbox(0.09, 0.14, 0.03, DARK, 0.01), 0, 1.27, 0);
  put(b, cyl(0.05, 0.05, 0.01, DARK, 14), 0, 0.42, 0.045).rotation.x = Math.PI / 2;
  for (const s of [-1, 1]) { const l = rbox(0.03, 0.32, 0.03, DARK, 0.01); l.rotation.z = s * 0.4; put(g, l, s * 0.1, 0.15, 0.05); }
  return g;
}
export function amp() { const g = new THREE.Group(); put(g, rbox(0.5, 0.45, 0.28, DARK, 0.03), 0, 0.225, 0); put(g, rbox(0.42, 0.28, 0.01, mat('#3a3442', { roughness: 1 }), 0), 0, 0.19, 0.142); put(g, rbox(0.46, 0.06, 0.01, BEIGE, 0.005), 0, 0.39, 0.142); return g; }
export function fridge() {
  const g = new THREE.Group(); put(g, rbox(0.5, 0.7, 0.5, mat('#3a3f48', { roughness: 0.5 }), 0.04), 0, 0.35, 0); put(g, rbox(0.03, 0.3, 0.03, METAL, 0.01), 0.2, 0.45, 0.26);
  put(g, rbox(0.12, 0.12, 0.004, mat('#3ddc84'), 0), -0.08, 0.5, 0.252); put(g, can(false, false, '#2f6fd1'), -0.1, 0.7, 0); put(g, can(false, false, '#c23b3b'), 0.08, 0.7, 0.05); return g;
}
export function pizzaStack(n = 3, r = rng(3)) { const g = new THREE.Group(); const c = mat('#b48a5a', { roughness: 0.95 }); for (let i = 0; i < n; i++) put(g, rbox(0.5, 0.045, 0.5, c, 0.01), (r() - 0.5) * 0.05, 0.025 + i * 0.05, (r() - 0.5) * 0.05, (r() - 0.5) * 0.3); return g; }
export function floorLamp() {
  const g = new THREE.Group(); const m = DARK; put(g, cyl(0.14, 0.16, 0.04, m, 20), 0, 0.02, 0); put(g, cyl(0.015, 0.015, 1.5, m, 8), 0, 0.77, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.13, 0.2, 0.26, 20, 1, true), glowMat('#ffb36b', 1.3, { side: THREE.DoubleSide })), 0, 1.55, 0); return g;
}
export function plant() {
  const g = new THREE.Group(); put(g, cyl(0.15, 0.11, 0.26, mat('#8a4a32'), 16), 0, 0.13, 0); put(g, cyl(0.14, 0.14, 0.02, DWOOD, 16), 0, 0.25, 0);
  const lm = mat('#2f6b45', { roughness: 0.8, side: THREE.DoubleSide }); const r = rng(8);
  for (let i = 0; i < 9; i++) { const l = mesh(new THREE.SphereGeometry(0.12, 8, 6), lm); l.scale.set(0.4, 1.4, 0.12); const a = i * 2.4; l.rotation.set(Math.cos(a) * 0.6, a, Math.sin(a) * 0.6); put(g, l, Math.sin(a) * 0.06, 0.4 + r() * 0.15, Math.cos(a) * 0.06); }
  return g;
}
export function rugMesh() { const t = TX.rug('stripes', '#4a3550', '#7a4a3a', '#a08a6a'); return mesh(new THREE.BoxGeometry(2.0, 0.02, 1.4), mat('#ffffff', { map: t, roughness: 1 })); }
