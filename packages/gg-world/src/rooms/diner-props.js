// @ts-check
// Jackrabbit Diner: code-built props (chrome counter, red vinyl booths, half a convertible, jukebox, pie case,
// milkshake machine, Red Room curtain doorway, twist contest dance floor). Each returns a Group around its origin, floor y=0.
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh } from './kit.js';
import * as TX from './tex.js';

export const CHROME = mat('#c8ccd4', { roughness: 0.18, metalness: 0.9 });
export const VINYL = mat('#8a1f26', { roughness: 0.45 });
export const VINYL_D = mat('#5a1218', { roughness: 0.5 });
export const FORMICA = mat('#3a7c86', { roughness: 0.35 });
export const DARK = mat('#16121a', { roughness: 0.6 });
const CREAM = mat('#b8ac94', { roughness: 0.5 });
const GLASS = new THREE.MeshStandardMaterial({ color: '#bfe8ff', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.22, depthWrite: true }); // depth-writing: its own overlapping faces cannot re-sort while walking
const cyl = (a, b, h, m, s = 14) => mesh(new THREE.CylinderGeometry(a, b, h, s), m);
const lathe = (pts, m, seg = 16) => mesh(new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg), m);
const plane = (w, h, m) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);

/** Long diner counter along x, customers on +z: cream panel front with chrome ribs, red top edge, chrome kick plate. */
export function counter(len) {
  const g = new THREE.Group();
  put(g, rbox(len, 0.95, 0.7, CREAM, 0.03), 0, 0.5, 0);
  put(g, rbox(len + 0.02, 0.12, 0.04, CHROME, 0.01), 0, 0.08, 0.35);
  for (let i = 0; i < Math.floor(len / 0.5); i++) put(g, rbox(0.03, 0.7, 0.02, CHROME, 0.008), -len / 2 + 0.25 + i * 0.5, 0.52, 0.355);
  put(g, rbox(len + 0.1, 0.06, 0.86, mat('#c0392b', { roughness: 0.3 }), 0.02), 0, 1.0, 0.04);
  put(g, rbox(len + 0.14, 0.035, 0.035, CHROME, 0.01), 0, 1.0, 0.48);
  put(g, rbox(len + 0.1, 0.08, 0.04, VINYL_D, 0.01), 0, 0.9, 0.38);
  return g;
}
/** Free-standing back bar against the n wall (len along x): low cabinet, mirror strip, shelf, chrome trims. */
export function backBar(len) {
  const g = new THREE.Group();
  put(g, rbox(len, 0.9, 0.55, mat('#2a1d24'), 0.02), 0, 0.45, 0);
  put(g, rbox(len + 0.04, 0.04, 0.6, CHROME, 0.01), 0, 0.92, 0);
  put(g, rbox(len, 1.1, 0.04, mat('#3a2a34', { roughness: 0.4, metalness: 0.4 }), 0.01), 0, 1.55, -0.25);
  put(g, rbox(len, 0.04, 0.3, CHROME, 0.01), 0, 1.8, -0.12);
  put(g, rbox(len - 0.1, 0.035, 0.02, glowMat('#ff4fd8', 1.2), 0.008), 0, 1.77, 0.02);
  return g;
}
/** Instanced-friendly stool parts: cushion geometry (squat lathe with welt). */
export function stoolTopGeo() { return new THREE.LatheGeometry([[0, 0], [0.2, 0], [0.22, 0.03], [0.22, 0.08], [0.19, 0.11], [0, 0.12]].map(([x, y]) => new THREE.Vector2(x, y)), 18); }
/** Red vinyl bench with tufted back, back toward -z. */
function bench(len) {
  const g = new THREE.Group();
  put(g, rbox(len, 0.42, 0.55, VINYL_D, 0.05), 0, 0.21, 0);
  put(g, rbox(len, 0.12, 0.55, VINYL, 0.06), 0, 0.47, 0.02);
  const n = Math.round(len / 0.38);
  for (let i = 0; i < n; i++) put(g, rbox(len / n - 0.03, 0.62, 0.16, VINYL, 0.07), -len / 2 + (i + 0.5) * len / n, 0.82, -0.22);
  put(g, rbox(len + 0.04, 0.04, 0.2, CHROME, 0.015), 0, 1.15, -0.22);
  return g;
}
/** Formica table on a chrome pedestal, napkin holder + ketchup/mustard. */
function table(len) {
  const g = new THREE.Group();
  put(g, rbox(len, 0.05, 0.7, FORMICA, 0.025), 0, 0.74, 0);
  put(g, rbox(len + 0.03, 0.03, 0.73, CHROME, 0.012), 0, 0.71, 0);
  put(g, cyl(0.05, 0.05, 0.7, CHROME, 8), 0, 0.36, 0);
  put(g, cyl(0.25, 0.28, 0.03, CHROME, 16), 0, 0.015, 0);
  put(g, rbox(0.12, 0.1, 0.06, CHROME, 0.01), len / 2 - 0.15, 0.82, 0);
  put(g, cyl(0.025, 0.03, 0.15, mat('#b3201c', { roughness: 0.3 }), 8), len / 2 - 0.15, 0.84, 0.1);
  put(g, cyl(0.025, 0.03, 0.15, mat('#d8a71c', { roughness: 0.3 }), 8), len / 2 - 0.15, 0.84, -0.1);
  return g;
}
/** Booth: two benches facing each other along z, table between; wall side at +x. */
export function booth(len = 1.4) {
  const g = new THREE.Group();
  const a = put(g, bench(len), 0, 0, -0.8); a.rotation.y = Math.PI / 2 * 0; put(g, bench(len), 0, 0, 0.8, Math.PI);
  put(g, table(len - 0.1), 0, 0, 0);
  return g;
}
/** Half a cherry-red convertible as a booth seat (Pulp Fiction nod). Seat faces +z; the hood points -z. */
export function carBooth(len = 1.4) {
  const g = new THREE.Group(); const red = mat('#9e1b22', { roughness: 0.25, metalness: 0.35 });
  put(g, rbox(len + 0.3, 0.55, 1.5, red, 0.18), 0, 0.42, -0.5);          // body
  put(g, rbox(len + 0.25, 0.2, 1.0, red, 0.2), 0, 0.72, -0.78);            // hood bulge
  put(g, rbox(len + 0.34, 0.1, 0.08, CHROME, 0.04), 0, 0.3, -1.27);       // bumper
  put(g, rbox(len + 0.3, 0.03, 1.5, CHROME, 0.01), 0, 0.68, -0.5);         // side trim
  for (const s of [-1, 1]) { const hl = cyl(0.09, 0.09, 0.06, glowMat('#ffe6a8', 2.6), 14); hl.rotation.x = Math.PI / 2; put(g, hl, s * (len / 2 - 0.05), 0.6, -1.26);
    const wh = cyl(0.3, 0.3, 0.18, DARK, 18); wh.rotation.z = Math.PI / 2; put(g, wh, s * (len / 2 + 0.12), 0.3, -0.75);
    const hub = cyl(0.14, 0.14, 0.2, CHROME, 12); hub.rotation.z = Math.PI / 2; put(g, hub, s * (len / 2 + 0.13), 0.3, -0.75); }
  const ws = rbox(len + 0.1, 0.42, 0.03, GLASS, 0.02); ws.rotation.x = -0.35; put(g, ws, 0, 1.0, -0.25);
  put(g, rbox(len + 0.12, 0.04, 0.05, CHROME, 0.015), 0, 1.2, -0.18);
  put(g, rbox(len, 0.18, 0.5, mat('#e8dcc0', { roughness: 0.5 }), 0.06), 0, 0.5, 0.1);  // white bench seat
  put(g, rbox(len, 0.55, 0.16, mat('#e8dcc0', { roughness: 0.5 }), 0.07), 0, 0.82, -0.12);
  const sw = mesh(new THREE.TorusGeometry(0.16, 0.02, 6, 18), CHROME); sw.rotation.x = -1.1; put(g, sw, -0.3, 0.98, -0.32);
  return g;
}
/** Car booth set: car seat at -z, table, normal bench at +z. */
export function carSet(len = 1.4) { const g = new THREE.Group(); put(g, carBooth(len), 0, 0, -0.85); put(g, bench(len), 0, 0, 0.8, Math.PI); put(g, table(len - 0.1), 0, 0, 0); return g; }

/** Jukebox: arched body with glowing bands, front +z. Returns {g, bands} (bands = live glow material to pulse). */
export function jukebox() {
  const g = new THREE.Group();
  put(g, rbox(0.9, 1.15, 0.55, mat('#3b1f2a', { roughness: 0.4 }), 0.06), 0, 0.58, 0);
  const arch = cyl(0.45, 0.45, 0.55, mat('#3b1f2a', { roughness: 0.4 }), 20); arch.rotation.x = Math.PI / 2; put(g, arch, 0, 1.15, 0);
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.04, 6, 20, Math.PI), glowMat('#ffb36b', 2.4)); put(g, band, 0, 1.15, 0.28);
  const band2 = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.03, 6, 20, Math.PI), glowMat('#ff4fd8', 2.4)); put(g, band2, 0, 1.15, 0.28);
  for (const s of [-1, 1]) put(g, rbox(0.06, 1.0, 0.04, glowMat('#ffcf8a', 2), 0.02), s * 0.4, 0.62, 0.27);
  put(g, plane(0.5, 0.3, glowMat('#2a1a10', 1)), 0, 1.25, 0.285);
  put(g, rbox(0.56, 0.24, 0.03, mat('#e0c070', { roughness: 0.3, metalness: 0.7 }), 0.01), 0, 0.85, 0.28);
  put(g, rbox(0.5, 0.25, 0.02, CHROME, 0.01), 0, 0.35, 0.28);
  return g;
}
/** Pie case: chrome base + glass dome over a cherry pie. */
export function pieCase() {
  const g = new THREE.Group();
  put(g, cyl(0.26, 0.28, 0.05, CHROME, 20), 0, 0.025, 0);
  put(g, cyl(0.2, 0.18, 0.06, mat('#c78a4a', { roughness: 0.7 }), 18), 0, 0.08, 0);
  put(g, cyl(0.18, 0.18, 0.015, mat('#8a0f1e', { roughness: 0.3 }), 18), 0, 0.115, 0);
  const dome = lathe([[0.25, 0], [0.25, 0.22], [0.2, 0.32], [0.08, 0.37], [0, 0.38]], GLASS, 18); put(g, dome, 0, 0.04, 0);
  put(g, cyl(0.03, 0.03, 0.04, CHROME, 8), 0, 0.44, 0);
  return g;
}
/** Triple-spindle milkshake mixer with steel cups, front +z. */
export function shakeMachine() {
  const g = new THREE.Group(); const mint = mat('#6fb8a8', { roughness: 0.35, metalness: 0.2 });
  put(g, rbox(0.7, 0.08, 0.3, mint, 0.03), 0, 0.04, 0);
  put(g, rbox(0.12, 0.55, 0.14, mint, 0.05), 0, 0.33, -0.1);
  put(g, rbox(0.72, 0.16, 0.24, mint, 0.07), 0, 0.62, -0.02);
  for (const x of [-0.24, 0, 0.24]) { put(g, cyl(0.008, 0.008, 0.22, CHROME, 6), x, 0.43, 0.05);
    put(g, lathe([[0.05, 0], [0.065, 0.2], [0.068, 0.2]], CHROME, 12), x, 0.13, 0.05); }
  return g;
}
/** Coffee warmer with two glass pots (one black coffee, one decaf orange handle). */
export function coffee() {
  const g = new THREE.Group();
  put(g, rbox(0.5, 0.5, 0.3, DARK, 0.03), 0, 0.25, -0.05);
  for (const [x, h] of [[-0.12, '#16110c'], [0.12, '#16110c']]) { put(g, lathe([[0.07, 0], [0.09, 0.06], [0.07, 0.16], [0.05, 0.18]], GLASS, 12), x, 0.0, 0.1);
    put(g, cyl(0.075, 0.085, 0.07, mat(h, { roughness: 0.2 }), 12), x, 0.04, 0.1); }
  put(g, rbox(0.04, 0.03, 0.04, glowMat('#ff5a3a', 0.9), 0.01), 0.2, 0.42, 0.11);
  return g;
}
/** Red Room curtain doorway: red velvet folds in a dark frame with a zigzag floor glimpse. Front +z. */
export function redRoom() {
  const g = new THREE.Group();
  const zig = TX.canvasTex('diner-zig', 128, 128, (x, w, h) => { x.fillStyle = '#e8e2d4'; x.fillRect(0, 0, w, h); x.fillStyle = '#121014';
    for (let r = 0; r < 8; r++) { x.beginPath(); for (let i = 0; i <= 8; i++) x.lineTo(i * 16, r * 16 + (i % 2 ? 0 : 8)); for (let i = 8; i >= 0; i--) x.lineTo(i * 16, r * 16 + 8 + (i % 2 ? 0 : 8)); x.fill(); } });
  const curt = TX.canvasTex('diner-curtain', 128, 64, (x, w, h) => { for (let i = 0; i < w; i++) { const s = 0.5 + 0.5 * Math.sin(i * 0.55); x.fillStyle = `rgb(${90 + s * 90 | 0},${8 + s * 10 | 0},${14 + s * 10 | 0})`; x.fillRect(i, 0, 1, h); } });
  put(g, rbox(1.5, 2.4, 0.12, mat('#140c10'), 0.03), 0, 1.2, -0.12);
  const fl = plane(1.1, 1.0, mat('#ffffff', { map: zig, roughness: 0.6 })); fl.rotation.x = -Math.PI / 2; put(g, fl, 0, 0.01, -0.05);
  for (const s of [-1, 1]) { const c = plane(0.42, 2.2, mat('#ffffff', { map: curt, roughness: 0.9, side: THREE.DoubleSide })); put(g, c, s * 0.4, 1.12, -0.04); }
  const back = plane(0.4, 2.2, mat('#ffffff', { map: curt, roughness: 0.9 })); put(g, back, 0, 1.12, -0.15);
  for (const s of [-1, 1]) put(g, rbox(0.12, 2.4, 0.2, mat('#2a1418', { roughness: 0.5 }), 0.02), s * 0.72, 1.2, 0);
  put(g, rbox(1.56, 0.12, 0.22, mat('#2a1418', { roughness: 0.5 }), 0.02), 0, 2.44, 0);
  return g;
}
/** Neon sign plane from tex.neon (self-lit). */
export function neonSign(text, color, w, h = w / 4) { return plane(w, h, new THREE.MeshBasicMaterial({ map: TX.neon(text, color), transparent: true, toneMapped: false, depthWrite: false })); }
/** Dance floor light-up squares texture (live material, opacity pulsed by the room). */
export function danceFloor(w, d) {
  const t = TX.canvasTex('diner-dance', 128, 128, (x, cw, ch) => { const cs = ['#ff4fd8', '#ffb36b', '#3ddc84', '#8fa8ff']; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { x.fillStyle = (i + j) % 2 ? cs[(i * 3 + j) % 4] : '#140f1c'; x.fillRect(i * 32 + 2, j * 32 + 2, 28, 28); } });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(w / 1.6, d / 1.6);
  const m = new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.55, toneMapped: false, depthWrite: false });
  const p = plane(w, d, m); p.rotation.x = -Math.PI / 2; p.position.y = 0.012; p.userData.live = true; return p;
}
/** Chrome sign frame on two poles holding a neon plane (free-standing). */
export function signStand(text, color, w, top) {
  const g = new THREE.Group();
  for (const s of [-1, 1]) put(g, cyl(0.045, 0.045, top, CHROME, 10), s * w / 2, top / 2, 0);
  for (const s of [-1, 1]) put(g, cyl(0.16, 0.18, 0.04, CHROME, 12), s * w / 2, 0.02, 0);
  put(g, rbox(w + 0.1, w / 4 + 0.1, 0.06, DARK, 0.03), 0, top - w / 8, -0.04);
  return g;
}
