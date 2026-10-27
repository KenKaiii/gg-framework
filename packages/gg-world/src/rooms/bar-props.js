// @ts-check
// Props for "The Terminal" bar. Each builder returns a Group built around its own origin (floor at y=0).
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh, rng } from './kit.js';
import * as TX from './tex.js';

const WOOD = () => mat('#3b2418', { roughness: 0.7 });
const WOOD_D = () => mat('#24150f', { roughness: 0.8 });
const TOP = () => mat('#5a3622', { roughness: 0.45 });
const BRASS = () => mat('#c99a4a', { metalness: 0.85, roughness: 0.3 });
const CHROME = () => mat('#9aa0ac', { metalness: 0.9, roughness: 0.25 });
const DARK = () => mat('#141014', { roughness: 0.5, metalness: 0.3 });
const METAL = () => mat('#3a3a40', { metalness: 0.6, roughness: 0.4 });
const LEATHER = () => mat('#2a1714', { roughness: 0.55 });
const cyl = (rt, rb, h, m, s = 16) => mesh(new THREE.CylinderGeometry(rt, rb, h, s), m);
const tube = (pts, r, m, s = 8) => mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 8, r, s, false), m);

/** Bar counter along z (length len), customer side +x. */
export function counter(len) {
  const g = new THREE.Group();
  put(g, rbox(0.62, 1.0, len, WOOD(), 0.03), 0, 0.5, 0);
  for (let i = 0; i < Math.floor(len / 0.6); i++) put(g, rbox(0.03, 0.62, 0.46, WOOD_D(), 0.01), 0.32, 0.52, -len / 2 + 0.3 + i * 0.6 + (len % 0.6) / 2);
  put(g, rbox(0.66, 0.1, len + 0.04, WOOD_D(), 0.02), 0.02, 0.05, 0);
  put(g, rbox(0.86, 0.07, len + 0.12, TOP(), 0.03), 0.06, 1.04, 0);
  put(g, rbox(0.05, 0.05, len + 0.12, TOP(), 0.02), 0.49, 1.04, 0);
  const rail = cyl(0.025, 0.025, len - 0.1, BRASS(), 10); rail.rotation.x = Math.PI / 2; put(g, rail, 0.48, 0.22, 0);
  for (let i = 0; i < 5; i++) { const b = cyl(0.015, 0.015, 0.18, BRASS(), 6); b.rotation.z = Math.PI / 2; put(g, b, 0.4, 0.22, -len / 2 + 0.2 + i * (len - 0.4) / 4); }
  // bartender-side well shelf
  put(g, rbox(0.25, 0.04, len - 0.2, WOOD_D(), 0.01), -0.42, 0.75, 0);
  return g;
}

export function stool() {
  const g = new THREE.Group();
  put(g, cyl(0.2, 0.22, 0.03, CHROME(), 18), 0, 0.015, 0);
  put(g, cyl(0.03, 0.03, 0.66, CHROME(), 8), 0, 0.35, 0);
  const ring = mesh(new THREE.TorusGeometry(0.16, 0.014, 6, 18), CHROME()); ring.rotation.x = Math.PI / 2; put(g, ring, 0, 0.3, 0);
  put(g, cyl(0.2, 0.18, 0.09, LEATHER(), 18), 0, 0.72, 0);
  put(g, cyl(0.21, 0.21, 0.02, LEATHER(), 18), 0, 0.77, 0);
  return g;
}

let bottleGeo = null;
function bottle() {
  if (bottleGeo) return bottleGeo;
  const p = [[0, 0], [0.045, 0], [0.05, 0.02], [0.05, 0.17], [0.04, 0.21], [0.016, 0.25], [0.016, 0.31], [0.02, 0.32], [0, 0.32]].map(([x, y]) => new THREE.Vector2(x, y));
  return (bottleGeo = new THREE.LatheGeometry(p, 10));
}
/** Backlit back-bar shelving along z against a wall at x=0, facing +x. */
export function backbar(len, seed = 7) {
  const g = new THREE.Group(), r = rng(seed);
  put(g, rbox(0.06, 2.1, len, DARK(), 0.01), 0.03, 1.55, 0);
  put(g, rbox(0.45, 0.9, len, WOOD(), 0.03), 0.22, 0.45, 0);
  put(g, rbox(0.5, 0.05, len + 0.04, TOP(), 0.02), 0.24, 0.92, 0);
  for (let i = 0; i < 4; i++) put(g, rbox(0.45, 0.06, len - 0.05 * 0, WOOD_D(), 0.01), 0.22, 1.25 + i * 0.5 - 0.3, 0);
  for (const z of [-len / 2, len / 2]) put(g, rbox(0.45, 2.2, 0.08, WOOD_D(), 0.02), 0.22, 1.6, z);
  put(g, rbox(0.5, 0.12, len + 0.1, WOOD_D(), 0.02), 0.24, 2.7, 0);
  const strip = glowMat('#ffb36b', 1.0);
  for (let i = 0; i < 3; i++) put(g, rbox(0.07, 0.012, len - 0.1, strip, 0), 0.41, 1.0 + i * 0.5 - 0.024, 0);
  const cols = ['#c27a1e', '#8a4b12', '#2f7a3a', '#3ddc84', '#a8641c', '#5a8a2a', '#d9a441', '#6b2a1a'];
  const per = Math.floor(len / 0.13), n = per * 4;
  const im = new THREE.InstancedMesh(bottle(), mat('#ffffff', { roughness: 0.45, metalness: 0.05, emissive: '#3a1c06', emissiveIntensity: 0.6 }), n);
  const m4 = new THREE.Matrix4(), c = new THREE.Color(); let k = 0;
  for (let s = 0; s < 4; s++) for (let i = 0; i < per; i++) {
    const y = s === 0 ? 0.95 : 0.98 + (s - 1) * 0.5, sc = 0.75 + r() * 0.45;
    if (r() < 0.1) continue;
    m4.makeScale(sc, sc * (0.8 + r() * 0.4), sc).setPosition(0.18 + r() * 0.12, y, -len / 2 + 0.1 + i * 0.13 + r() * 0.02);
    im.setMatrixAt(k, m4); im.setColorAt(k, c.set(cols[Math.floor(r() * cols.length)])); k++;
  }
  im.count = k; im.castShadow = true; g.add(im);
  return g;
}

export function taps() {
  const g = new THREE.Group();
  put(g, rbox(0.12, 0.3, 0.6, BRASS(), 0.04), 0, 0.15, 0);
  put(g, rbox(0.3, 0.02, 0.6, DARK(), 0.01), 0.12, 0.01, 0);
  const hc = ['#1a1a1a', '#6b2a1a', '#2f7a3a', '#c27a1e'];
  for (let i = 0; i < 4; i++) {
    const z = -0.22 + i * 0.147; const sp = cyl(0.012, 0.012, 0.1, BRASS(), 6); sp.rotation.z = Math.PI / 2; put(g, sp, 0.1, 0.22, z);
    put(g, rbox(0.035, 0.16, 0.035, mat(hc[i], { roughness: 0.4 }), 0.012), 0.06, 0.38, z);
  }
  return g;
}

export function register() {
  const g = new THREE.Group();
  put(g, rbox(0.36, 0.14, 0.42, METAL(), 0.03), 0, 0.07, 0);
  const key = rbox(0.24, 0.12, 0.3, METAL(), 0.03); key.rotation.z = 0.35; put(g, key, 0.04, 0.17, 0);
  const sc = mesh(new THREE.PlaneGeometry(0.22, 0.08), glowMat('#3ddc84', 1.6)); sc.rotation.y = Math.PI / 2; sc.rotation.x = 0; put(g, sc, -0.06, 0.32, 0);
  put(g, rbox(0.06, 0.12, 0.26, METAL(), 0.02), -0.09, 0.3, 0);
  return g;
}

/** Instanced glasses (pint + tumbler) at positions [x,y,z]. */
export function glasses(pos) {
  const geo = new THREE.CylinderGeometry(0.045, 0.035, 0.15, 10);
  const im = new THREE.InstancedMesh(geo, mat('#bfe8d0', { roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.5 }), pos.length);
  const m4 = new THREE.Matrix4(); pos.forEach((p, i) => im.setMatrixAt(i, m4.makeTranslation(p[0], p[1] + 0.075, p[2]))); return im;
}

/** Worn leather sofa along z, facing +x... built facing -x (back at +x). */
export function sofa(len = 2.0) {
  const g = new THREE.Group(), L = LEATHER(), L2 = mat('#3a221c', { roughness: 0.55 });
  put(g, rbox(0.8, 0.3, len, L, 0.06), 0, 0.2, 0);
  for (let i = 0; i < 2; i++) put(g, rbox(0.62, 0.14, len / 2 - 0.08, L2, 0.06), -0.06, 0.41, -len / 4 + i * len / 2);
  put(g, rbox(0.22, 0.6, len, L, 0.08), 0.3, 0.6, 0);
  for (let i = 0; i < 2; i++) put(g, rbox(0.14, 0.42, len / 2 - 0.1, L2, 0.07), 0.16, 0.66, -len / 4 + i * len / 2);
  for (const s of [-1, 1]) put(g, rbox(0.8, 0.5, 0.18, L, 0.08), 0, 0.38, s * (len / 2 + 0.06));
  for (const x of [-0.32, 0.32]) for (const s of [-1, 1]) put(g, cyl(0.03, 0.025, 0.06, WOOD_D(), 6), x, 0.03, s * (len / 2));
  // patch of tape on cushion
  put(g, rbox(0.12, 0.01, 0.2, METAL(), 0.003), -0.1, 0.485, 0.35);
  return g;
}

export function lowTable() {
  const g = new THREE.Group();
  put(g, rbox(0.6, 0.06, 1.0, TOP(), 0.02), 0, 0.42, 0);
  for (const x of [-0.24, 0.24]) for (const z of [-0.42, 0.42]) put(g, rbox(0.05, 0.4, 0.05, WOOD_D(), 0.01), x, 0.2, z);
  put(g, rbox(0.5, 0.03, 0.9, WOOD_D(), 0.01), 0, 0.12, 0);
  return g;
}

/** Pool table along x. Returns group; balls and cues included. */
export function poolTable() {
  const g = new THREE.Group(), W = 2.3, D = 1.25;
  put(g, rbox(W - 0.2, 0.28, D - 0.2, WOOD(), 0.04), 0, 0.66, 0);
  for (const x of [-0.9, 0.9]) for (const z of [-0.45, 0.45]) put(g, cyl(0.08, 0.06, 0.55, WOOD_D(), 10), x, 0.28, z);
  put(g, rbox(W - 0.24, 0.04, D - 0.24, mat('#1f5a3a', { roughness: 1 }), 0.01), 0, 0.81, 0);
  for (const s of [-1, 1]) { put(g, rbox(W, 0.1, 0.13, WOOD(), 0.03), 0, 0.83, s * (D / 2 - 0.06)); put(g, rbox(0.13, 0.1, D, WOOD(), 0.03), s * (W / 2 - 0.06), 0.83, 0); }
  for (const x of [-W / 2 + 0.12, 0, W / 2 - 0.12]) for (const s of [-1, 1]) put(g, cyl(0.055, 0.055, 0.02, DARK(), 10), x, 0.885, s * (D / 2 - 0.12));
  const cols = ['#f0e8d8', '#e8c33a', '#2a4fa8', '#c8322a', '#5a2a8a', '#e07a2a', '#2a7a4a', '#7a2a1a', '#111111', '#e8c33a', '#2a4fa8', '#c8322a'];
  const im = new THREE.InstancedMesh(new THREE.SphereGeometry(0.04, 12, 8), mat('#ffffff', { roughness: 0.2 }), cols.length);
  const r = rng(11), m4 = new THREE.Matrix4(), c = new THREE.Color();
  cols.forEach((col, i) => { const x = i === 0 ? -0.6 : 0.3 + (i % 4) * 0.07 + r() * 0.2, z = i === 0 ? 0.1 : (Math.floor(i / 4) - 1) * 0.09 + r() * 0.1; im.setMatrixAt(i, m4.makeTranslation(x, 0.87, z)); im.setColorAt(i, c.set(col)); });
  im.castShadow = true; g.add(im);
  const cue = cyl(0.008, 0.016, 1.45, TOP(), 6); cue.rotation.z = Math.PI / 2 - 0.05; cue.rotation.y = 0.3; put(g, cue, -0.1, 0.92, 0.25);
  return g;
}

/** Hanging pool lamp: long shade + bulbs. Returns {g, bulbs} (g is live). */
export function poolLamp() {
  const g = new THREE.Group();
  put(g, rbox(1.3, 0.14, 0.36, mat('#2f7a4a', { roughness: 0.4, emissive: '#1f6a3a', emissiveIntensity: 0.9 }), 0.06), 0, 0, 0);
  put(g, rbox(1.36, 0.03, 0.4, BRASS(), 0.01), 0, -0.07, 0);
  put(g, rbox(1.2, 0.02, 0.26, glowMat('#ffcf8a', 2.6), 0.01), 0, -0.06, 0);
  for (const x of [-0.5, 0.5]) put(g, cyl(0.004, 0.004, 1.0, DARK(), 4), x, 0.55, 0);
  return g;
}

/** Jukebox facing +z. Returns {g, arches:THREE.Material} */
export function jukebox() {
  const g = new THREE.Group();
  put(g, rbox(0.9, 1.0, 0.55, WOOD(), 0.06), 0, 0.5, 0);
  const dome = mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.55, 20, 1, false, -Math.PI / 2, Math.PI), WOOD()); dome.rotation.x = Math.PI / 2; dome.rotation.z = Math.PI / 2; put(g, dome, 0, 1.0, 0);
  const archM = glowMat('#ff4fd8', 2.6).clone();
  for (const [rad, th] of [[0.43, 0.03], [0.34, 0.025]]) { const a = new THREE.Mesh(new THREE.TorusGeometry(rad, th, 6, 24, Math.PI), archM); put(g, a, 0, 1.0, 0.28); }
  for (const s of [-1, 1]) put(g, rbox(0.05, 0.95, 0.04, archM, 0.02), s * 0.43, 0.5, 0.28);
  put(g, rbox(0.55, 0.3, 0.03, glowMat('#ffcf8a', 1.4), 0.02), 0, 0.82, 0.28);
  put(g, rbox(0.6, 0.4, 0.03, BRASS(), 0.02), 0, 0.35, 0.28);
  for (let i = 0; i < 6; i++) put(g, rbox(0.55, 0.015, 0.02, DARK(), 0), 0, 0.2 + i * 0.05, 0.3);
  return { g, arches: archM };
}

function boardTex() {
  return TX.canvasTex('dartboard', 128, 128, (x, w) => { const c = w / 2; const rings = [[60, '#111'], [56, '#c8322a'], [52, '#111'], [36, '#2a7a4a'], [32, '#111'], [8, '#2a7a4a'], [4, '#c8322a']];
    for (const [r, col] of rings) { x.fillStyle = col; x.beginPath(); x.arc(c, c, r, 0, 7); x.fill(); }
    for (let i = 0; i < 20; i++) { x.fillStyle = i % 2 ? '#e8dcc0' : '#151515'; x.globalAlpha = 0.85; x.beginPath(); x.moveTo(c, c); x.arc(c, c, 50, i * Math.PI / 10, (i + 1) * Math.PI / 10); x.fill(); x.globalAlpha = 1; }
    x.fillStyle = '#c8322a'; x.beginPath(); x.arc(c, c, 6, 0, 7); x.fill(); });
}
export function dartboard() {
  const g = new THREE.Group();
  put(g, rbox(0.7, 0.7, 0.04, WOOD_D(), 0.02), 0, 0, 0);
  const b = mesh(new THREE.CircleGeometry(0.24, 28), mat('#ffffff', { map: boardTex() })); put(g, b, 0, 0, 0.04);
  for (const [x, y] of [[0.05, 0.06], [-0.08, -0.02], [0.02, -0.1]]) { const d = cyl(0.004, 0.004, 0.12, BRASS(), 4); d.rotation.x = Math.PI / 2; put(g, d, x, y, 0.1); }
  return g;
}

export function chalkboard() {
  const t = TX.canvasTex('barmenu2', 512, 640, (x, w, h) => {
    x.fillStyle = '#1d2420'; x.fillRect(0, 0, w, h); x.fillStyle = 'rgba(255,255,255,0.05)'; for (let i = 0; i < 40; i++) x.fillRect(Math.random() * w, Math.random() * h, 40, 6);
    x.textAlign = 'center'; x.fillStyle = '#efe6d0'; x.font = '96px m5x7'; x.fillText('ON TAP', w / 2, 72);
    const items = [['RED PILL shot', '4c', '#ff6b5a'], ['BLUE PILL shot', '4c', '#7aa8ff'], ['Rollback IPA', '6c', '#efe6d0'], ['Merge Conflict', 'Negroni 9c', '#efe6d0'], ['Hotfix Espresso', 'Martini 9c', '#efe6d0']];
    x.font = '60px m5x7';
    items.forEach(([a, b, c], i) => { x.fillStyle = c; x.textAlign = 'left'; x.fillText(a, 22, 150 + i * 92); x.textAlign = 'right'; x.fillText(b, w - 20, 194 + i * 92); });
    x.fillStyle = '#6ee7a0'; x.font = '39px m5x7'; x.textAlign = 'center'; x.fillText('no deploys after 2 drinks', w / 2, h - 18);
  });
  const g = new THREE.Group();
  put(g, rbox(1.1, 1.36, 0.05, WOOD(), 0.02), 0, 0, 0);
  put(g, mesh(new THREE.PlaneGeometry(1.0, 1.25), mat('#ffffff', { map: t, roughness: 1 })), 0, 0, 0.03);
  return g;
}

/** Wall payphone facing +z. Handset is returned for the ring shake. */
export function payphone() {
  const g = new THREE.Group(), body = METAL();
  put(g, rbox(0.34, 0.6, 0.16, body, 0.04), 0, 0, 0);
  put(g, rbox(0.4, 0.08, 0.2, mat('#7a1c1c', { roughness: 0.5 }), 0.03), 0, 0.34, 0.01);
  put(g, rbox(0.14, 0.18, 0.02, DARK(), 0.01), 0.03, -0.04, 0.085);
  const hs = new THREE.Group(); hs.userData.live = true;
  put(hs, rbox(0.06, 0.3, 0.07, DARK(), 0.025), 0, 0, 0);
  for (const s of [-1, 1]) put(hs, rbox(0.08, 0.07, 0.08, DARK(), 0.03), 0, s * 0.15, 0.01);
  put(g, hs, -0.12, 0.02, 0.12);
  put(g, tube([new THREE.Vector3(-0.12, -0.15, 0.12), new THREE.Vector3(-0.1, -0.35, 0.16), new THREE.Vector3(-0.02, -0.38, 0.14), new THREE.Vector3(0.0, -0.2, 0.09)], 0.008, DARK(), 5), 0, 0, 0);
  put(g, mesh(new THREE.PlaneGeometry(0.2, 0.06), glowMat('#3ddc84', 1.4)), 0.03, 0.18, 0.085);
  return { g, handset: hs };
}

/** Scrolling green deploy-feed texture for the TV. */
export function feedTex() {
  const t = TX.canvasTex('barfeed', 128, 256, (x, w, h) => {
    x.fillStyle = '#04140a'; x.fillRect(0, 0, w, h); x.font = '14px m5x7'; x.fillStyle = '#6ee7a0';
    const L = ['$ gg deploy --prod', 'build ok 2.1s', 'tests 214/214', '> push main', 'rolling out 3/3', 'health: green', 'xp +120', '$ git merge', 'CONFLICT (lol)', 'fixed by agent', 'deploy ok'];
    for (let i = 0; i < 24; i++) x.fillText(L[i % L.length], 4, 10 + i * 10.5);
    for (let y = 0; y < h; y += 2) { x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(0, y, w, 1); }
  }, { repeat: true });
  return t;
}
export function tv(tex) {
  const g = new THREE.Group();
  put(g, rbox(0.62, 0.48, 0.42, METAL(), 0.06), 0, 0, 0);
  const sm = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  put(g, mesh(new THREE.PlaneGeometry(0.46, 0.36), sm), -0.03, 0.01, 0.215);
  put(g, rbox(0.05, 0.05, 0.4, DARK(), 0.01), 0, -0.3, -0.25);
  return g;
}

/** String lights hanging between points. Returns Group (bulbs instanced, glowing). */
export function stringLights(a, b, n = 12, sag = 0.25) {
  const g = new THREE.Group(), pts = [];
  for (let i = 0; i <= 16; i++) { const t = i / 16; const p = new THREE.Vector3().lerpVectors(a, b, t); p.y -= Math.sin(t * Math.PI) * sag; pts.push(p); }
  const w = tube(pts, 0.013, DARK(), 4); w.castShadow = false; g.add(w);
  const im = new THREE.InstancedMesh(new THREE.SphereGeometry(0.045, 8, 6), glowMat('#ffcf8a', 1.25), n), m4 = new THREE.Matrix4();
  for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; const p = new THREE.Vector3().lerpVectors(a, b, t); p.y -= Math.sin(t * Math.PI) * sag + 0.04; im.setMatrixAt(i, m4.makeTranslation(p.x, p.y, p.z)); }
  im.castShadow = false; g.add(im); return g;
}
export function pipe(a, b, r = 0.05, color = '#5a4a44') {
  const g = new THREE.Group(), d = new THREE.Vector3().subVectors(b, a), len = d.length();
  const p = cyl(r, r, len, mat(color, { metalness: 0.6, roughness: 0.5 }), 10); p.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); p.position.lerpVectors(a, b, 0.5); g.add(p);
  for (let i = 1; i < len / 1.2; i++) { const c = cyl(r * 1.35, r * 1.35, 0.06, METAL(), 10); c.quaternion.copy(p.quaternion); c.position.lerpVectors(a, b.clone(), 0).addScaledVector(d, i * 1.2); g.add(c); }
  return g;
}

/** Instanced bottle caps / coasters scattered. */
export function caps(pts, seed = 3) {
  const im = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.02, 0.02, 0.008, 8), mat('#ffffff', { metalness: 0.7, roughness: 0.4 }), pts.length);
  const m4 = new THREE.Matrix4(), c = new THREE.Color(), r = rng(seed), cl = ['#c8322a', '#d9a441', '#2a7a4a', '#c0c0c0'];
  pts.forEach((p, i) => { im.setMatrixAt(i, m4.makeTranslation(p[0], p[1] + 0.004, p[2])); im.setColorAt(i, c.set(cl[Math.floor(r() * 4)])); });
  return im;
}
export function tipJar() {
  const g = new THREE.Group();
  put(g, cyl(0.07, 0.065, 0.18, mat('#bfe8d0', { roughness: 0.05, transparent: true, opacity: 0.45 }), 14), 0, 0.09, 0);
  put(g, cyl(0.06, 0.06, 0.06, mat('#2f7a3a'), 10), 0, 0.04, 0);
  const l = mesh(new THREE.PlaneGeometry(0.12, 0.05), mat('#ffffff', { map: TX.label('TIPS', '#222', '#e8dcc0', 128, 48, '39px m5x7'), transparent: true })); l.rotation.y = Math.PI / 2; put(g, l, 0.072, 0.1, 0);
  return g;
}

/** Booth pendant: cord + dome shade + bulb. */
export function pendant() {
  const g = new THREE.Group();
  put(g, cyl(0.005, 0.005, 0.9, DARK(), 4), 0, 0.45, 0);
  const sh = mesh(new THREE.CylinderGeometry(0.06, 0.24, 0.2, 18, 1, true), mat('#8a5a2a', { metalness: 0.6, roughness: 0.4, side: THREE.DoubleSide, emissive: '#5a3010', emissiveIntensity: 0.6 })); put(g, sh, 0, 0, 0);
  put(g, mesh(new THREE.SphereGeometry(0.06, 10, 8), glowMat('#ffcf8a', 3)), 0, -0.06, 0);
  return g;
}
export function coatRack() {
  const g = new THREE.Group();
  put(g, cyl(0.025, 0.025, 1.75, WOOD(), 8), 0, 0.875, 0);
  for (let i = 0; i < 3; i++) { const l = cyl(0.015, 0.02, 0.4, WOOD(), 6); l.rotation.z = 1.1; l.rotation.y = i * 2.09; put(g, l, Math.cos(i * 2.09) * 0.12, 0.08, -Math.sin(i * 2.09) * 0.12); }
  for (const [ry, c] of [[0.3, '#2a2a34'], [2.5, '#5a2a22']]) { const j = rbox(0.36, 0.7, 0.14, mat(c, { roughness: 0.9 }), 0.06); j.rotation.y = ry; put(g, j, Math.sin(ry) * 0.09, 1.3, Math.cos(ry) * 0.09); }
  put(g, cyl(0.12, 0.13, 0.08, mat('#141014', { roughness: 0.5 }), 14), 0.1, 1.8, 0);
  return g;
}
export function keg() {
  const g = new THREE.Group(), m = mat('#9aa0ac', { metalness: 0.85, roughness: 0.3 });
  put(g, cyl(0.22, 0.22, 0.58, m, 18), 0, 0.29, 0);
  for (const y of [0.04, 0.54]) put(g, mesh(new THREE.TorusGeometry(0.22, 0.025, 6, 18), m), 0, y, 0).rotation.x = Math.PI / 2;
  put(g, cyl(0.04, 0.04, 0.06, BRASS(), 8), 0, 0.6, 0);
  return g;
}
export function bin() {
  const g = new THREE.Group();
  put(g, cyl(0.2, 0.17, 0.55, METAL(), 14), 0, 0.275, 0);
  for (const [x, z, c] of [[0.05, 0, '#c8322a'], [-0.06, 0.04, '#3ddc84']]) { const k = cyl(0.03, 0.03, 0.12, mat(c, { metalness: 0.7, roughness: 0.3 }), 8); k.rotation.z = 0.6; put(g, k, x, 0.58, z); }
  return g;
}
