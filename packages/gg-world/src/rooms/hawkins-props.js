// @ts-check
// Hawkins Living Room props (code-modelled, 80s suburban). Each returns a Group at origin, floor y = 0, front = +z.
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh, rng } from './kit.js';
import * as TX from './tex.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const WOOD = () => mat('#6b4426', { roughness: 0.7 }), WOOD_D = () => mat('#45291a', { roughness: 0.75 });
export const LETTERS = ['ABCDEFGH', 'IJKLMNOPQ', 'RSTUVWXYZ'];
export const BULB_COLS = ['#ff4040', '#ffd040', '#40c060', '#4080ff', '#ff70d0', '#ff9a30'];

/** Plaid 80s fabric. */
const plaid = (a, b, c) => TX.canvasTex('hk-plaid' + a + b, 64, 64, (x, w, h) => { x.fillStyle = a; x.fillRect(0, 0, w, h);
  x.fillStyle = b; for (let i = 0; i < w; i += 16) { x.globalAlpha = 0.55; x.fillRect(i, 0, 6, h); x.fillRect(0, i, w, 6); }
  x.globalAlpha = 0.5; x.fillStyle = c; for (let i = 8; i < w; i += 16) { x.fillRect(i, 0, 1, h); x.fillRect(0, i, w, 1); } x.globalAlpha = 1; }, { repeat: true });

/** Long brown-plaid 3-seat sofa. */
export function sofa() {
  const g = new THREE.Group(), f = mat('#ffffff', { map: plaid('#6a4a2e', '#8a6a3a', '#c09a5a'), roughness: 0.9 }), leg = WOOD_D();
  put(g, rbox(2.7, 0.3, 0.9, f, 0.08), 0, 0.27, 0);
  for (let i = 0; i < 3; i++) put(g, rbox(0.82, 0.14, 0.78, f, 0.07), (i - 1) * 0.84, 0.47, 0.05);
  put(g, rbox(2.7, 0.62, 0.24, f, 0.1), 0, 0.62, -0.36);
  for (let i = 0; i < 3; i++) put(g, rbox(0.8, 0.42, 0.14, f, 0.07), (i - 1) * 0.84, 0.66, -0.2).rotation.x = -0.12;
  for (const s of [-1, 1]) put(g, rbox(0.22, 0.56, 0.9, f, 0.1), s * 1.36, 0.42, 0);
  for (const x of [-1.25, 1.25]) for (const z of [-0.36, 0.36]) put(g, mesh(new THREE.CylinderGeometry(0.03, 0.02, 0.12, 8), leg), x, 0.06, z);
  put(g, rbox(0.38, 0.32, 0.12, mat('#9a3a2a', { roughness: 0.95 }), 0.06), -1.0, 0.68, -0.12).rotation.z = 0.2; // throw pillow
  put(g, rbox(0.7, 0.04, 0.6, mat('#2e5a4a', { roughness: 0.95 }), 0.02), 0.95, 0.58, -0.05).rotation.z = -0.06; // afghan
  return g;
}

/** Orange-brown recliner armchair. */
export function armchair() {
  const g = new THREE.Group(), f = mat('#8a4a22', { roughness: 0.85 });
  put(g, rbox(0.95, 0.42, 0.9, f, 0.12), 0, 0.25, 0);
  put(g, rbox(0.95, 0.72, 0.26, f, 0.12), 0, 0.72, -0.34).rotation.x = -0.14;
  for (const s of [-1, 1]) put(g, rbox(0.2, 0.3, 0.86, f, 0.09), s * 0.46, 0.55, 0);
  put(g, rbox(0.6, 0.12, 0.66, mat('#9a5a2a', { roughness: 0.85 }), 0.06), 0, 0.5, 0.06);
  return g;
}

/** Wood-veneer coffee table with a lower shelf. */
export function coffeeTable() {
  const g = new THREE.Group(), w = WOOD(), d = WOOD_D();
  put(g, rbox(1.5, 0.06, 0.75, w, 0.03), 0, 0.42, 0);
  put(g, rbox(1.36, 0.03, 0.62, d, 0.01), 0, 0.12, 0);
  for (const x of [-0.68, 0.68]) for (const z of [-0.32, 0.32]) put(g, rbox(0.06, 0.42, 0.06, d, 0.015), x, 0.21, z);
  put(g, rbox(0.3, 0.04, 0.22, mat('#c9b28a', { roughness: 0.8 }), 0.01), -0.4, 0.165, 0.05); // magazines
  put(g, rbox(0.24, 0.05, 0.18, mat('#3a5a8a', { roughness: 0.8 }), 0.01), 0.35, 0.165, -0.05);
  return g;
}

/** Floor-standing walnut console TV with rabbit ears. Returns { g, screen }. */
export function consoleTV() {
  const g = new THREE.Group(), w = WOOD(), d = WOOD_D();
  put(g, rbox(1.25, 0.82, 0.62, w, 0.05), 0, 0.5, 0);
  for (const x of [-0.55, 0.55]) put(g, rbox(0.06, 0.1, 0.06, d, 0.02), x, 0.05, 0);
  put(g, rbox(0.86, 0.62, 0.04, mat('#2a2622', { roughness: 0.4 }), 0.06), -0.12, 0.55, 0.31);
  put(g, rbox(0.24, 0.62, 0.02, mat('#3a2a1e', { roughness: 0.9 }), 0.02), 0.47, 0.55, 0.315); // speaker grille
  for (let i = 0; i < 2; i++) put(g, mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 12), mat('#c9b28a', { metalness: 0.5 })), 0.47, 0.8 - i * 0.12, 0.33).rotation.x = Math.PI / 2;
  const ant = mat('#bfbfbf', { metalness: 0.8, roughness: 0.3 });
  put(g, mesh(new THREE.SphereGeometry(0.07, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat('#222')), 0, 0.91, -0.05);
  for (const s of [-1, 1]) { const a = mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.75, 5), ant); a.position.set(s * 0.2, 1.25, -0.05); a.rotation.z = -s * 0.55; g.add(a); }
  const geo = new THREE.PlaneGeometry(0.74, 0.52, 6, 4), p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i) / 0.37, y = p.getY(i) / 0.26; p.setZ(i, 0.025 * (1 - x * x * 0.5 - y * y * 0.5)); }
  const sm = new THREE.MeshBasicMaterial({ toneMapped: false }); sm.color.setScalar(1.3);
  const screen = new THREE.Mesh(geo, sm); screen.position.set(-0.12, 0.55, 0.335); screen.userData.live = true; g.add(screen);
  return { g, screen };
}
/** n frames of grey CRT static. */
export const staticFrames = (n = 4) => Array.from({ length: n }, (_, k) => TX.canvasTex('hk-static' + k, 64, 48, (x, w, h) => { const r = rng(17 + k * 31);
  for (let y = 0; y < h; y++) for (let i = 0; i < w; i++) { const v = 40 + r() * 150 | 0; x.fillStyle = `rgb(${v},${v},${v + 10})`; x.fillRect(i, y, 1, 1); }
  x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillRect(0, (k * 13) % h, w, 5); }, { nearest: true }));

/** Floor lamp with a pleated cone shade. Returns { g, shade } (shade material is the flickery bit). */
export function floorLamp() {
  const g = new THREE.Group(), brass = mat('#9a7a3a', { metalness: 0.7, roughness: 0.35 });
  put(g, mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.04, 20), brass), 0, 0.02, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.016, 0.016, 1.5, 8), brass), 0, 0.77, 0);
  const shade = glowMat('#ffcf8a', 1.0, { side: THREE.DoubleSide });
  put(g, mesh(new THREE.CylinderGeometry(0.18, 0.3, 0.34, 16, 1, true), shade), 0, 1.6, 0);
  return { g, shade };
}

/** Side table with a rotary phone + long coiled cord trailing to the floor. */
export function phoneTable() {
  const g = new THREE.Group(), w = WOOD();
  put(g, mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 20), w), 0, 0.56, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.54, 10), WOOD_D()), 0, 0.27, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.03, 16), WOOD_D()), 0, 0.015, 0);
  const ph = mat('#c8b48a', { roughness: 0.45 }), base = new THREE.Group(); put(g, base, -0.04, 0.58, 0.02, 0.3);
  put(base, rbox(0.24, 0.1, 0.22, ph, 0.05), 0, 0.05, 0);
  put(base, mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.015, 16), mat('#efe6d0')), 0, 0.105, 0.03).rotation.x = -0.25;
  const hs = put(base, rbox(0.3, 0.05, 0.06, ph, 0.025), 0, 0.15, -0.04);
  for (const s of [-1, 1]) put(hs, rbox(0.07, 0.05, 0.08, ph, 0.025), s * 0.13, -0.02, 0);
  const pts = []; for (let i = 0; i <= 140; i++) { const k = i / 140, a = k * 40 * Math.PI; const c = new THREE.Vector3(0.12 + k * 0.9, 0.6 - Math.sin(Math.min(1, k * 2.5) * Math.PI / 2) * 0.58, 0.05 + Math.sin(k * 3) * 0.4);
    pts.push(c.add(new THREE.Vector3(0, Math.cos(a) * 0.012, Math.sin(a) * 0.012))); }
  g.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 400, 0.005, 4), ph));
  return g;
}

/** Kids' BMX-ish bike with a front basket, on its kickstand. Front = +x. */
export function bike(c = '#b02a2a') {
  const g = new THREE.Group(), fr = mat(c, { metalness: 0.4, roughness: 0.4 }), tyre = mat('#141414', { roughness: 0.8 }), chrome = mat('#cfcfcf', { metalness: 0.9, roughness: 0.25 });
  for (const x of [-0.5, 0.5]) { put(g, mesh(new THREE.TorusGeometry(0.3, 0.035, 8, 28), tyre), x, 0.33, 0);
    // spokes read as a soft matte disc + hub (4 mm chrome cylinders shimmered while the camera moved)
    put(g, mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.006, 24), mat('#4a4844', { roughness: 0.7 })), x, 0.33, 0).rotation.x = Math.PI / 2;
    put(g, mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 10), chrome), x, 0.33, 0).rotation.x = Math.PI / 2; }
  const tube = (a, b, r = 0.022, m = fr) => { const v = new THREE.Vector3().subVectors(b, a), o = mesh(new THREE.CylinderGeometry(r, r, v.length(), 8), m);
    o.position.copy(a).addScaledVector(v, 0.5); o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize()); g.add(o); };
  const V = (x, y, z = 0) => new THREE.Vector3(x, y, z), bb = V(0, 0.32), seat = V(-0.15, 0.72), head = V(0.38, 0.78);
  tube(bb, seat); tube(seat, head); tube(bb, head); tube(bb, V(-0.5, 0.33)); tube(seat, V(-0.5, 0.33)); tube(head, V(0.5, 0.33), 0.018, chrome);
  tube(head, V(0.36, 0.98), 0.018, chrome); tube(V(0.36, 0.98, -0.25), V(0.36, 0.98, 0.25), 0.016, chrome);
  for (const s of [-1, 1]) put(g, mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.1, 8), mat('#222')), 0.36, 0.98, s * 0.27).rotation.x = Math.PI / 2;
  put(g, rbox(0.24, 0.06, 0.12, mat('#1c1a18', { roughness: 0.6 }), 0.03), -0.16, 0.76, 0);
  tube(bb, V(-0.12, 0.02, 0.1), 0.012, chrome); // kickstand
  const bk = new THREE.Group(); put(g, bk, 0.56, 0.88, 0); const wick = mat('#a0784a', { roughness: 0.9 });
  put(bk, rbox(0.3, 0.02, 0.32, wick, 0.01), 0, 0, 0);
  for (const [w, d, x, z] of [[0.3, 0.02, 0, 0.16], [0.3, 0.02, 0, -0.16], [0.02, 0.32, 0.15, 0], [0.02, 0.32, -0.15, 0]]) put(bk, rbox(w, 0.2, d, wick, 0.008), x, 0.1, z);
  put(bk, mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.16, 12), mat('#e8dcc0')), 0.04, 0.12, 0.04); // flashlight
  put(bk, mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.01, 12), glowMat('#fff2c0', 1.5)), 0.04, 0.2, 0.04);
  return g;
}

/** Round D&D table, dice, DM screen, figurines (incl. the toothy monster mini). Returns { g, figure }. */
export function dndTable() {
  const g = new THREE.Group(), w = WOOD(), d = WOOD_D();
  put(g, mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.06, 32), w), 0, 0.74, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.7, 12), d), 0, 0.38, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.4, 0.45, 0.05, 20), d), 0, 0.025, 0);
  const map = TX.canvasTex('hk-dmap', 128, 128, (x, W) => { x.fillStyle = '#d8c9a0'; x.fillRect(0, 0, W, W); x.strokeStyle = '#6a5030'; x.lineWidth = 3;
    for (const [a, b, c, e] of [[10, 20, 50, 40], [60, 20, 50, 60], [20, 70, 40, 40], [80, 80, 30, 30]]) x.strokeRect(a, b, c, e); x.beginPath(); x.moveTo(35, 60); x.lineTo(35, 70); x.moveTo(110, 60); x.lineTo(95, 80); x.stroke();
    x.fillStyle = '#8a2a1a'; x.font = '21px m5x7'; x.fillText('X', 88, 100); }, { nearest: true });
  put(g, rbox(0.6, 0.005, 0.5, mat('#ffffff', { map, roughness: 0.9 }), 0.002), 0.05, 0.775, 0.1, 0.2);
  const scr = new THREE.Group(); put(g, scr, -0.05, 0.77, -0.5); const sm = mat('#5a2a2a', { roughness: 0.7 });
  for (let i = -1; i <= 1; i++) put(scr, rbox(0.3, 0.26, 0.015, sm, 0.005), i * 0.29, 0.13, Math.abs(i) * 0.06, -i * 0.35);
  const dc = ['#c03030', '#e0b020', '#3060c0', '#30a060', '#8040c0'];
  dc.forEach((c, i) => put(g, mesh(new THREE.IcosahedronGeometry(0.035, 0), mat(c, { roughness: 0.3 })), -0.4 + i * 0.12, 0.805, 0.45 - (i % 2) * 0.1, i));
  for (const [x, z, c] of [[0.1, 0.0, '#5a7a9a'], [0.25, 0.2, '#9a7a3a'], [-0.1, 0.25, '#4a8a4a']]) { put(g, mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.012, 10), mat('#222')), x, 0.783, z);
    put(g, mesh(new THREE.CapsuleGeometry(0.018, 0.04, 3, 8), mat(c)), x, 0.82, z); }
  const figure = new THREE.Group(); put(g, figure, 0.3, 0.78, -0.12); const sk = mat('#5a4a52', { roughness: 0.6 });
  put(figure, mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.012, 10), mat('#222')), 0, 0.006, 0);
  put(figure, mesh(new THREE.CapsuleGeometry(0.02, 0.07, 3, 8), sk), 0, 0.07, 0);
  for (let i = 0; i < 5; i++) { const p = mesh(new THREE.ConeGeometry(0.016, 0.04, 4), mat('#a04a5a')); const a = i / 5 * Math.PI * 2; p.position.set(Math.cos(a) * 0.022, 0.135, Math.sin(a) * 0.022); p.rotation.set(Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9); figure.add(p); }
  for (const s of [-1, 1]) put(figure, mesh(new THREE.CapsuleGeometry(0.008, 0.06, 2, 6), sk), s * 0.03, 0.07, 0).rotation.z = s * 0.4;
  put(g, rbox(0.2, 0.012, 0.28, mat('#e8dcc0'), 0.004), 0.55, 0.785, 0.3, -0.3); // character sheet
  put(g, rbox(0.06, 0.12, 0.06, mat('#d04030', { roughness: 0.4 }), 0.025), -0.5, 0.83, 0.05); // soda can
  return { g, figure };
}
/** Plain kitchen chair with a vinyl seat. */
export function chair() {
  const g = new THREE.Group(), w = WOOD_D(), s = mat('#7a3a24', { roughness: 0.6 });
  put(g, rbox(0.44, 0.07, 0.42, s, 0.03), 0, 0.45, 0);
  for (const x of [-0.18, 0.18]) for (const z of [-0.17, 0.17]) put(g, rbox(0.035, 0.44, 0.035, w, 0.01), x, 0.22, z);
  for (const x of [-0.18, 0.18]) put(g, rbox(0.035, 0.5, 0.035, w, 0.01), x, 0.72, -0.18);
  put(g, rbox(0.4, 0.12, 0.03, w, 0.012), 0, 0.88, -0.18);
  return g;
}

/** Walkie-talkie lying on a table (antenna toward +x). */
export function walkie() {
  const g = new THREE.Group(), b = mat('#2a2a2a', { roughness: 0.5 });
  put(g, rbox(0.09, 0.05, 0.2, b, 0.015), 0, 0.025, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.2, 6), b), 0.03, 0.03, -0.18).rotation.x = Math.PI / 2;
  put(g, rbox(0.06, 0.006, 0.06, mat('#555'), 0.004), 0, 0.052, 0.04);
  put(g, rbox(0.012, 0.006, 0.012, glowMat('#ff3030', 3), 0.003), 0.025, 0.054, -0.07);
  return g;
}
/** Plate of toaster waffles with a syrup bottle. */
export function waffles() {
  const g = new THREE.Group(), wf = TX.canvasTex('hk-waffle', 32, 32, (x, w) => { x.fillStyle = '#d89a48'; x.fillRect(0, 0, w, w); x.fillStyle = '#9a6020'; for (let i = 0; i < w; i += 6) { x.fillRect(i, 0, 2, w); x.fillRect(0, i, w, 2); } }, { nearest: true });
  put(g, mesh(new THREE.CylinderGeometry(0.16, 0.12, 0.02, 20), mat('#e8e0d0', { roughness: 0.4 })), 0, 0.01, 0);
  const wm = mat('#ffffff', { map: wf, roughness: 0.8 });
  for (let i = 0; i < 3; i++) put(g, mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.016, 18), wm), (i - 1) * 0.012, 0.03 + i * 0.017, i * 0.01, i * 0.7);
  put(g, rbox(0.03, 0.006, 0.03, mat('#f0e08a'), 0.004), 0.01, 0.08, 0.01); // butter pat
  return g;
}

/**
 * The Christmas-lights alphabet: free-standing wood-panelled partition, painted letters in 3 rows, a sagging wire of
 * bulbs above each letter (one InstancedMesh). Returns { g, bulbs, pos (bulb local positions by letter), base colours }.
 */
export function alphabetWall(W = 6.4, H = 2.75) {
  const g = new THREE.Group(), LW = 4.9, x0 = -W / 2 + 0.25;
  const tex = TX.canvasTex('hk-abc', 1024, 440, (x, w, h) => {
    x.fillStyle = '#5a4a36'; x.fillRect(0, 0, w, h); const r = rng(5);
    for (let i = 0; i < 260; i++) { x.fillStyle = `rgba(${r() < 0.5 ? '90,60,40' : '120,100,70'},0.35)`; const px = r() * w, py = r() * h * 0.7; x.beginPath(); x.arc(px, py, 3 + r() * 5, 0, 7); x.fill(); }
    for (let i = 0; i < w; i += 32) { x.fillStyle = 'rgba(40,28,20,0.18)'; x.fillRect(i, 0, 2, h * 0.68); }
    const pg = x.createLinearGradient(0, h * 0.68, 0, h); pg.addColorStop(0, '#5a3a22'); pg.addColorStop(1, '#3a2416'); x.fillStyle = pg; x.fillRect(0, h * 0.68, w, h);
    for (let i = 0; i < w; i += 46) { x.fillStyle = 'rgba(0,0,0,0.3)'; x.fillRect(i, h * 0.68, 3, h); }
    x.fillStyle = '#2a1a10'; x.fillRect(0, h * 0.67, w, 8);
    x.fillStyle = 'rgba(12,8,6,1)'; x.font = '96px m5x7'; x.textAlign = 'center';
    LETTERS.forEach((row, ri) => [...row].forEach((ch, i) => { const u = (x0 + (i + 0.5) * LW / row.length + W / 2) / W * w, v = (1 - (1.95 - ri * 0.55 - 0.08) / H) * h;
      x.save(); x.translate(u, v); x.rotate((r() - 0.5) * 0.18); x.fillText(ch, 0, 20); x.restore(); }));
    x.fillStyle = 'rgba(16,12,10,0.6)'; for (let i = 0; i < 30; i++) x.fillRect(80 + r() * 600, 60 + r() * 180, 2, 6 + r() * 14); // drips
  });
  put(g, rbox(W, H, 0.14, mat('#4a2e1c', { roughness: 0.8 }), 0.02), 0, H / 2, -0.08);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.08, H - 0.08), mat('#ffffff', { map: tex, roughness: 0.85, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.3 })); face.position.set(0, H / 2, 0.0); face.receiveShadow = true; g.add(face);
  put(g, rbox(W + 0.1, 0.08, 0.2, mat('#2e1c12'), 0.02), 0, H + 0.04, -0.08);
  for (const s of [-1, 1]) { put(g, rbox(0.1, 0.1, 0.9, mat('#2e1c12'), 0.02), s * (W / 2 - 0.3), 0.05, -0.2); }
  const pos = [], cols = [], wires = [];
  LETTERS.forEach((row, ri) => { const y = 1.95 - ri * 0.55 + 0.27, pts = [];
    [...row].forEach((ch, i) => { const px = x0 + (i + 0.5) * LW / row.length, py = y - Math.sin((i + 0.5) / row.length * Math.PI) * 0.05 + (i % 2) * 0.02; pos.push(new THREE.Vector3(px, py, 0.06)); cols.push(BULB_COLS[(pos.length * 5 + ri) % BULB_COLS.length]); });
    for (let i = 0; i <= 24; i++) { const k = i / 24, px = x0 - 0.05 + k * (LW + 0.1); pts.push(new THREE.Vector3(px, y + 0.06 - Math.sin(k * Math.PI) * 0.05 + Math.sin(k * 40) * 0.01, 0.04)); }
    wires.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.008, 4)); });
  g.add(mesh(mergeGeometries(wires), mat('#1a2a18', { roughness: 0.6 })));
  const bg = new THREE.SphereGeometry(0.04, 10, 8); bg.scale(1, 1.5, 1);
  const bulbs = new THREE.InstancedMesh(bg, new THREE.MeshBasicMaterial({ toneMapped: false }), pos.length); const m4 = new THREE.Matrix4();
  pos.forEach((p, i) => { bulbs.setMatrixAt(i, m4.makeTranslation(p.x, p.y - 0.04, p.z)); bulbs.setColorAt(i, new THREE.Color(cols[i]).multiplyScalar(0.4)); });
  bulbs.userData.live = true;
  return { g, bulbs, pos, cols };
}

/** Glowing red crack (Upside Down rift) as an additive decal. Returns a Mesh. */
export function rift(w = 1.0, h = 1.9) {
  const tex = TX.canvasTex('hk-rift', 128, 256, (x, W, H) => { const r = rng(9);
    const draw = (lw, a) => { x.strokeStyle = `rgba(255,${60 + a * 80},${40 + a * 40},${a})`; x.lineWidth = lw; x.lineCap = 'round'; x.beginPath(); let px = W / 2, py = 8; x.moveTo(px, py);
      const rr = rng(3); while (py < H - 8) { px = W / 2 + (rr() - 0.5) * 40 * Math.sin(py / H * Math.PI); py += 10 + rr() * 14; x.lineTo(px, py); } x.stroke(); };
    x.filter = 'blur(10px)'; draw(30, 0.5); x.filter = 'blur(3px)'; draw(10, 0.8); x.filter = 'none'; draw(3, 1);
    for (let i = 0; i < 9; i++) { x.strokeStyle = 'rgba(255,90,60,0.7)'; x.lineWidth = 1.5; const sy = 30 + r() * 190; x.beginPath(); x.moveTo(W / 2, sy); x.lineTo(W / 2 + (r() - 0.5) * 70, sy + (r() - 0.5) * 30); x.stroke(); } });
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  m.color.setScalar(1.6); const o = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m); o.userData.live = true; return o;
}

/** Free-standing walnut hutch: cabinet base, open shelves with plates, a little lamp glow is added by the room. */
export function hutch() {
  const g = new THREE.Group(), w = WOOD(), d = WOOD_D();
  put(g, rbox(1.5, 0.85, 0.5, w, 0.03), 0, 0.45, 0);
  for (const s of [-1, 1]) put(g, rbox(0.66, 0.66, 0.02, d, 0.02), s * 0.36, 0.47, 0.25);
  for (const s of [-1, 1]) put(g, mesh(new THREE.SphereGeometry(0.025, 8, 6), mat('#c9a050', { metalness: 0.7 })), s * 0.08, 0.5, 0.27);
  put(g, rbox(1.56, 0.05, 0.56, d, 0.02), 0, 0.9, 0);
  put(g, rbox(1.4, 0.95, 0.03, d, 0.01), 0, 1.4, -0.2);
  for (const s of [-1, 1]) put(g, rbox(0.05, 0.95, 0.32, w, 0.01), s * 0.72, 1.4, -0.06);
  for (const y of [1.25, 1.62]) put(g, rbox(1.4, 0.03, 0.3, w, 0.01), 0, y, -0.06);
  put(g, rbox(1.5, 0.06, 0.36, d, 0.02), 0, 1.9, -0.06);
  const pm = mat('#d8cdb0', { roughness: 0.4 });
  for (let i = 0; i < 4; i++) { const p = mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.015, 18), pm); p.rotation.x = Math.PI / 2 - 0.2; p.position.set(-0.5 + i * 0.33, 1.4, -0.15); g.add(p); }
  for (let i = 0; i < 5; i++) put(g, mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.1, 8), mat(['#4a6a8a', '#8a5a3a', '#6a8a5a'][i % 3], { roughness: 0.4 })), -0.55 + i * 0.27, 1.69, -0.06);
  return g;
}
/** Round tufted ottoman. */
export function ottoman() {
  const g = new THREE.Group();
  put(g, mesh(new THREE.CylinderGeometry(0.4, 0.38, 0.36, 22), mat('#7a3a2a', { roughness: 0.9 })), 0, 0.22, 0);
  put(g, mesh(new THREE.TorusGeometry(0.38, 0.05, 8, 24), mat('#6a3020', { roughness: 0.9 })), 0, 0.4, 0).rotation.x = Math.PI / 2;
  for (const s of [-1, 1]) for (const t of [-1, 1]) put(g, mesh(new THREE.CylinderGeometry(0.025, 0.02, 0.05, 6), WOOD_D()), s * 0.24, 0.025, t * 0.24);
  return g;
}
/** Wicker laundry basket overflowing with clothes. */
export function laundry() {
  const g = new THREE.Group();
  put(g, mesh(new THREE.CylinderGeometry(0.3, 0.25, 0.5, 18, 1, true), mat('#b08a5a', { roughness: 0.95, side: THREE.DoubleSide })), 0, 0.25, 0);
  put(g, mesh(new THREE.TorusGeometry(0.3, 0.025, 6, 20), mat('#8a6a40')), 0, 0.5, 0).rotation.x = Math.PI / 2;
  for (const [x, z, c, r] of [[0, 0, '#3a5a8a', 0.2], [0.1, 0.08, '#a03a3a', 0.6], [-0.12, -0.05, '#d8c8a0', 1]]) put(g, mesh(new THREE.SphereGeometry(0.2, 10, 6), mat(c, { roughness: 1 })), x, 0.5, z, r).scale.set(1, 0.45, 0.8);
  put(g, rbox(0.5, 0.04, 0.2, mat('#2a6a4a', { roughness: 1 }), 0.02), 0.32, 0.02, 0.2, 0.7); // dropped sweater
  return g;
}
/** Additive floor light pool. */
export function pool(color, r = 1.6, op = 0.35) {
  const m = new THREE.MeshBasicMaterial({ map: TX.dotTex(), color, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const o = new THREE.Mesh(new THREE.PlaneGeometry(r * 2, r * 2), m); o.rotation.x = -Math.PI / 2; o.userData.live = true; return o;
}
