// @ts-check
// The Restricted Section: prop builders (free-standing bookcases, study table, banker lamp, armchair, hearth,
// rolling ladder, globe, sorting hat on a stool, the ring under glass, chained book lectern, the golden snitch).
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh } from './kit.js';
import * as TX from './tex.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const WOOD = () => mat('#3a2418', { roughness: 0.8 });
export const DARK = () => mat('#24160f', { roughness: 0.85 });
export const BRASS = () => mat('#9a7a2e', { metalness: 0.7, roughness: 0.35 });
export const IRON = () => mat('#2a2a30', { metalness: 0.6, roughness: 0.5 });
const LEATHER = () => mat('#4a1e1c', { roughness: 0.55 });
const SPINE_PAL = ['#5a1e1e', '#2a4a3a', '#6a4a22', '#2a3050', '#4a2440', '#7a6a4a', '#3a2a1a', '#1e3a2e'];
const spineMat = s => mat('#ffffff', { map: TX.spines(900 + s, SPINE_PAL), roughness: 0.8 });

/** Free-standing double-sided bookcase, length along local x. */
export function bookcase(len = 2, h = 2.6, seed = 0) {
  const g = new THREE.Group(), D = 0.5, w = WOOD(), dk = DARK();
  for (const sx of [-1, 1]) put(g, rbox(0.08, h, D, w, 0.02), sx * (len / 2 - 0.04), h / 2, 0);
  put(g, rbox(len + 0.12, 0.1, D + 0.1, dk, 0.03), 0, h + 0.05, 0); // crown
  put(g, rbox(len + 0.06, 0.12, D + 0.04, dk, 0.02), 0, 0.06, 0);  // plinth
  put(g, rbox(len - 0.1, h - 0.15, 0.03, dk, 0), 0, h / 2, 0);     // spine board between the two faces
  const n = 5, step = (h - 0.25) / n;
  for (let i = 0; i <= n; i++) put(g, rbox(len - 0.1, 0.04, D - 0.02, w, 0.01), 0, 0.14 + i * step, 0);
  for (let i = 0; i < n; i++) for (const sz of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(len - 0.14, step * 0.82), spineMat((seed + i + (sz > 0 ? 3 : 0)) % 3));
    p.position.set(0, 0.16 + i * step + step * 0.41, sz * 0.2); if (sz < 0) p.rotation.y = Math.PI; g.add(p);
  }
  return g;
}

/** Long study table (along x) with turned legs. */
export function studyTable(len = 2.6, dep = 0.95) {
  const g = new THREE.Group(), w = WOOD();
  put(g, rbox(len, 0.07, dep, w, 0.02), 0, 0.76, 0);
  put(g, rbox(len - 0.3, 0.1, dep - 0.2, DARK(), 0.02), 0, 0.68, 0);
  const lg = new THREE.LatheGeometry([[0.05, 0], [0.06, 0.05], [0.035, 0.15], [0.055, 0.35], [0.03, 0.55], [0.045, 0.7]].map(([r, y]) => new THREE.Vector2(r, y)), 10);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(g, mesh(lg, w), sx * (len / 2 - 0.12), 0, sz * (dep / 2 - 0.1));
  return g;
}

/** Windsor-ish study chair facing +z (seat 0.45). */
export function chair() {
  const g = new THREE.Group(), w = WOOD();
  put(g, rbox(0.46, 0.06, 0.44, w, 0.02), 0, 0.45, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(g, rbox(0.04, 0.45, 0.04, w, 0.01), sx * 0.19, 0.22, sz * 0.18);
  for (const sx of [-1, 0, 1]) put(g, rbox(0.03, 0.5, 0.03, w, 0.01), sx * 0.16, 0.72, -0.2);
  put(g, rbox(0.46, 0.07, 0.05, w, 0.02), 0, 0.98, -0.2);
  return g;
}

/** Green-shaded banker's lamp; returns { g, shade } (shade is live-able glow). */
export function bankerLamp() {
  const g = new THREE.Group(), b = BRASS();
  put(g, mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.03, 14), b), 0, 0.015, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 6), b), 0, 0.17, 0);
  const sh = mesh(new THREE.CylinderGeometry(0.06, 0.13, 0.09, 16, 1, true, 0, Math.PI), mat('#1d6a3a', { roughness: 0.3, metalness: 0.2, side: THREE.DoubleSide, emissive: '#1d7a44', emissiveIntensity: 0.5 }));
  sh.rotation.set(0, Math.PI / 2, Math.PI / 2); sh.position.set(0, 0.33, 0.02); g.add(sh);
  const bulb = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.2, 6), glowMat('#ffcf8a', 1.2)); bulb.rotation.x = Math.PI / 2; bulb.rotation.z = Math.PI / 2; bulb.position.set(0, 0.3, 0.03); g.add(bulb);
  return g;
}

/** Wingback armchair facing +z. */
export function armchair() {
  const g = new THREE.Group(), l = LEATHER();
  put(g, rbox(0.85, 0.3, 0.8, l, 0.08), 0, 0.3, 0);
  put(g, rbox(0.85, 0.85, 0.2, l, 0.08), 0, 0.75, -0.32);
  for (const sx of [-1, 1]) { put(g, rbox(0.16, 0.32, 0.72, l, 0.06), sx * 0.38, 0.6, 0.02); put(g, rbox(0.14, 0.4, 0.3, l, 0.06), sx * 0.36, 1.0, -0.26); }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(g, rbox(0.06, 0.15, 0.06, DARK(), 0.02), sx * 0.34, 0.075, sz * 0.3);
  return g;
}

/** Free-standing stone hearth facing +z; returns { g, fire:Mesh[] } (fire meshes go live). */
export function hearth() {
  const g = new THREE.Group(), st = mat('#4a4048', { roughness: 0.95 }), st2 = mat('#3a3038', { roughness: 0.95 });
  put(g, rbox(1.9, 0.12, 0.9, st2, 0.03), 0, 0.06, 0.1);
  for (const sx of [-1, 1]) put(g, rbox(0.4, 1.2, 0.6, st, 0.04), sx * 0.7, 0.72, 0);
  put(g, rbox(1.9, 0.14, 0.75, DARK(), 0.03), 0, 1.38, 0.02); // mantel
  put(g, rbox(1.0, 0.25, 0.6, st, 0.03), 0, 1.2, 0);
  put(g, rbox(1.0, 1.0, 0.1, mat('#120c0c'), 0.02), 0, 0.62, -0.24); // firebox back
  put(g, rbox(1.2, 1.5, 0.55, st, 0.04), 0, 2.2, -0.05); // chimney breast
  put(g, rbox(1.3, 0.1, 0.62, st2, 0.03), 0, 2.95, -0.05);
  for (let i = 0; i < 3; i++) { const lg = mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.6, 8), mat('#2a1a10')); lg.rotation.z = Math.PI / 2; lg.rotation.y = (i - 1) * 0.4; lg.position.set(0, 0.2 + (i === 1 ? 0.08 : 0), 0); g.add(lg); }
  const fire = [0, 1, 2].map(i => { const f = new THREE.Mesh(new THREE.ConeGeometry(0.13 - i * 0.025, 0.42 - i * 0.08, 8), glowMat(['#ff7a2a', '#ffb36b', '#ffe0a0'][i], 1.3, { transparent: true, opacity: 0.85, depthWrite: false })); f.position.set((i - 1) * 0.12, 0.42, 0.02); f.userData.live = true; return f; });
  // candlesticks + a skull-ish curio on the mantel
  for (const sx of [-0.75, 0.75]) { put(g, mesh(new THREE.CylinderGeometry(0.025, 0.04, 0.2, 8), BRASS()), sx, 1.55, 0.1); put(g, mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.12, 8), mat('#d8c8a0')), sx, 1.71, 0.1); }
  return { g, fire };
}

/** Rolling library ladder leaning on a shelf face (rails along y, leaning toward -z). */
export function ladder(h = 2.7) {
  const g = new THREE.Group(), w = mat('#5a3a22', { roughness: 0.7 }), lean = 0.32;
  for (const sx of [-1, 1]) { const r = rbox(0.05, h, 0.06, w, 0.015); r.position.set(sx * 0.22, h / 2, 0); r.rotation.x = -lean; g.add(r); }
  for (let i = 1; i < 9; i++) { const dy = i * h / 9.4 - h / 2; put(g, mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.44, 6), w), 0, h / 2 + dy * Math.cos(lean), -dy * Math.sin(lean)).rotation.z = Math.PI / 2; }
  for (const sx of [-1, 1]) put(g, mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 10), BRASS()), sx * 0.22, 0.04, Math.sin(lean) * h / 2).rotation.z = Math.PI / 2;
  return g;
}

/** Floor globe on a tripod; returns { g, ball } (ball live, spins). */
export function globe() {
  const g = new THREE.Group(), w = WOOD();
  for (let i = 0; i < 3; i++) { const l = rbox(0.05, 0.7, 0.05, w, 0.015); const a = i * Math.PI * 2 / 3; l.position.set(Math.cos(a) * 0.18, 0.35, Math.sin(a) * 0.18); l.rotation.set(Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25); g.add(l); }
  const ring = mesh(new THREE.TorusGeometry(0.34, 0.02, 6, 28), BRASS()); ring.position.y = 0.95; ring.rotation.y = 0.4; g.add(ring);
  put(g, mesh(new THREE.TorusGeometry(0.33, 0.025, 6, 28), w), 0, 0.72, 0).rotation.x = Math.PI / 2;
  const tex = TX.canvasTex('lib-globe', 256, 128, (x, W, H) => { x.fillStyle = '#2a3a4a'; x.fillRect(0, 0, W, H); x.fillStyle = '#8a7a4a'; const r = TX.rand(42);
    for (let i = 0; i < 9; i++) { x.beginPath(); x.ellipse(r() * W, 20 + r() * (H - 40), 12 + r() * 26, 8 + r() * 18, r() * 3, 0, 7); x.fill(); } x.strokeStyle = 'rgba(220,200,150,.25)'; for (let i = 1; i < 8; i++) { x.beginPath(); x.moveTo(i * W / 8, 0); x.lineTo(i * W / 8, H); x.stroke(); } });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 16), mat('#ffffff', { map: tex, roughness: 0.5 })); ball.position.y = 0.95; ball.rotation.z = 0.4; ball.userData.live = true; ball.castShadow = true;
  return { g, ball };
}

/** Three-legged stool. */
export function stool(h = 0.55) {
  const g = new THREE.Group(), w = WOOD();
  put(g, mesh(new THREE.CylinderGeometry(0.22, 0.2, 0.06, 16), w), 0, h, 0);
  for (let i = 0; i < 3; i++) { const a = i * 2.09; const l = rbox(0.04, h, 0.04, w, 0.01); l.position.set(Math.cos(a) * 0.14, h / 2, Math.sin(a) * 0.14); l.rotation.set(Math.sin(a) * 0.15, 0, -Math.cos(a) * 0.15); g.add(l); }
  return g;
}

/**
 * The old patched pointy hat (sits at y=0, ~0.55 tall). Face crease toward +z.
 * One swept body: rings follow a spine that slouches back then flops forward at the tip, the radius dips in creases
 * (soft cloth folds) and a wavy floppy brim; brow / mouth folds are dark tubes sunk into the cloth with a few
 * stitches and a patch. 3 draw calls (cloth, dark folds + stitches, patch); the mouth stays its own mesh (animated).
 */
export function sortingHat() {
  const g = new THREE.Group(), cl = mat('#5e4230', { roughness: 0.95, side: THREE.DoubleSide }), cr = mat('#20140e', { roughness: 0.95 }), pt = mat('#3e4a2a', { roughness: 0.95, side: THREE.DoubleSide });
  // spine: up, leaning back, the top third folding over toward the face
  const N = 16, SEG = 18, spine = [], rad = [];
  for (let i = 0; i <= N; i++) { const k = i / N, fold = Math.max(0, k - 0.55) / 0.45;
    spine.push(new THREE.Vector3(Math.sin(fold * 2.2) * 0.17 + k * 0.02, k * 0.44 - fold * fold * 0.12, -0.04 * k + fold * 0.08));
    rad.push(0.2 * Math.pow(1 - k, 0.85) * (1 - 0.08 * Math.sin(k * 15)) + 0.004); }
  const pos = [], idx = [];
  for (let i = 0; i <= N; i++) { const p = spine[i], q = spine[Math.min(N, i + 1)], o = spine[Math.max(0, i - 1)], tan = q.clone().sub(o).normalize();
    const side = new THREE.Vector3(0, 0, 1).cross(tan).normalize(), up = tan.clone().cross(side).normalize();
    for (let j = 0; j <= SEG; j++) { const a = j / SEG * Math.PI * 2, crease = 1 - 0.07 * Math.max(0, Math.sin(a * 5 + i * 0.7)) - (i < 6 ? 0.05 * Math.max(0, Math.cos(a - Math.PI / 2)) * Math.sin(i) : 0), r = rad[i] * crease;
      pos.push(p.x + (side.x * Math.cos(a) + up.x * Math.sin(a)) * r, p.y + (side.y * Math.cos(a) + up.y * Math.sin(a)) * r, p.z + (side.z * Math.cos(a) + up.z * Math.sin(a)) * r); } }
  for (let i = 0; i < N; i++) for (let j = 0; j < SEG; j++) { const a = i * (SEG + 1) + j, b = a + SEG + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  const body = new THREE.BufferGeometry(); body.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); body.setIndex(idx); body.computeVertexNormals();
  // brim: a wavy, drooping annulus
  const brim = new THREE.RingGeometry(0.17, 0.33, 28, 2), bp = brim.attributes.position;
  for (let v = 0; v < bp.count; v++) { const X = bp.getX(v), Y = bp.getY(v), r = Math.hypot(X, Y), a = Math.atan2(Y, X), droop = (r - 0.17) / 0.16;
    bp.setXYZ(v, X, 0.03 + droop * (Math.sin(a * 3 + 0.6) * 0.03 - 0.02), Y); }
  brim.computeVertexNormals();
  const brimN = brim.toNonIndexed(); brimN.deleteAttribute('uv'); const cloth = mesh(mergeGeometries([body.toNonIndexed(), brimN]), cl); g.add(cloth);
  // face folds: sunken creases for brows + eye slits, a stitched seam and stitches; merged into one dark mesh
  const tube = (pts, r) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(([x, y, z]) => new THREE.Vector3(x, y, z))), 8, r, 4, false);
  const zf = y => 0.2 * Math.pow(1 - y / 0.44, 0.85) - 0.012;
  const folds = [tube([[-0.13, 0.2, zf(0.2) - 0.02], [-0.07, 0.225, zf(0.22)], [-0.01, 0.205, zf(0.2)]], 0.012), tube([[0.02, 0.21, zf(0.21)], [0.07, 0.232, zf(0.23)], [0.12, 0.215, zf(0.21) - 0.02]], 0.012),
    tube([[-0.09, 0.17, zf(0.17)], [-0.06, 0.175, zf(0.17) + 0.004], [-0.03, 0.168, zf(0.17)]], 0.008), tube([[0.04, 0.172, zf(0.17)], [0.07, 0.178, zf(0.17) + 0.004], [0.1, 0.17, zf(0.17)]], 0.008),
    tube([[0.16, 0.06, 0.02], [0.13, 0.16, 0.0], [0.09, 0.27, -0.03]], 0.004)];
  for (let i = 0; i < 6; i++) { const y = 0.07 + i * 0.035, st = new THREE.BoxGeometry(0.03, 0.006, 0.008); st.rotateZ(0.6); st.translate(0.15 - i * 0.01, y, 0.03 - i * 0.008); folds.push(st); }
  g.add(mesh(mergeGeometries(folds.map(f => { const n = f.index ? f.toNonIndexed() : f; for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k); return n; })), cr));
  const patch = new THREE.PlaneGeometry(0.07, 0.06); patch.rotateY(-1.2); patch.translate(-0.16, 0.14, -0.06); g.add(mesh(patch, pt));
  // mouth: a dark wide fold that opens when the hat speaks
  const mouth = mesh(new THREE.CapsuleGeometry(0.012, 0.13, 3, 6).rotateZ(Math.PI / 2), cr); mouth.position.set(0, 0.11, zf(0.11) + 0.004); g.add(mouth);
  return { g, mouth };
}

/** Stone pedestal with a glass dome and a gold ring; returns { g, ring, glint }. */
export function ringCase() {
  const g = new THREE.Group(), st = mat('#4a4048', { roughness: 0.9 });
  put(g, mesh(new THREE.CylinderGeometry(0.28, 0.32, 0.1, 16), st), 0, 0.05, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.85, 12), st), 0, 0.5, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.26, 0.24, 0.08, 16), st), 0, 0.96, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.03, 16), mat('#3a1018', { roughness: 0.9 })), 0, 1.015, 0);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.2, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#9fe8c0', transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0.3, depthWrite: false }));
  dome.position.y = 1.0; dome.userData.live = true;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 10, 28), new THREE.MeshStandardMaterial({ color: '#ffcf5a', metalness: 1, roughness: 0.15, emissive: '#7a5010', emissiveIntensity: 0.6 }));
  ring.position.y = 1.09; ring.rotation.x = 1.2; ring.userData.live = true;
  return { g, dome, ring };
}

/** Lectern with a chained black book. */
export function chainedLectern() {
  const g = new THREE.Group(), w = DARK();
  put(g, rbox(0.4, 0.06, 0.4, w, 0.02), 0, 0.03, 0); put(g, rbox(0.12, 1.0, 0.12, w, 0.03), 0, 0.55, 0);
  const top = rbox(0.55, 0.05, 0.42, w, 0.02); top.position.set(0, 1.08, 0); top.rotation.x = 0.35; g.add(top);
  const book = rbox(0.44, 0.07, 0.32, mat('#140e10', { roughness: 0.6 }), 0.02); book.position.set(0, 1.13, 0.02); book.rotation.x = 0.35; g.add(book);
  const links = chain(new THREE.Vector3(0.18, 1.12, 0.1), new THREE.Vector3(0.1, 0.06, 0.3), 9); g.add(links);
  return g;
}

/** Instanced chain links from a to b (a slight sag). */
export function chain(a, b, n = 10) {
  const im = new THREE.InstancedMesh(new THREE.TorusGeometry(0.028, 0.008, 5, 10), IRON(), n), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1);
  const dir = b.clone().sub(a), yaw = Math.atan2(dir.x, dir.z);
  for (let i = 0; i < n; i++) { const k = (i + 0.5) / n, p = a.clone().lerp(b, k); p.y -= Math.sin(k * Math.PI) * 0.12 * dir.length(); e.set(0, yaw + Math.PI / 2, i % 2 ? Math.PI / 2 : 0); q.setFromEuler(e); m4.compose(p, q, one); im.setMatrixAt(i, m4); }
  return im;
}

/** Brass rope post. */
export function post() {
  const g = new THREE.Group(), b = BRASS();
  put(g, mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.04, 14), b), 0, 0.02, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.9, 8), b), 0, 0.47, 0);
  put(g, mesh(new THREE.SphereGeometry(0.05, 10, 8), b), 0, 0.94, 0);
  return g;
}

/** The golden ball with flapping wings; returns { g, wings }. */
export function snitch() {
  const g = new THREE.Group(); g.userData.live = true;
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 14, 10), new THREE.MeshStandardMaterial({ color: '#ffd24a', metalness: 1, roughness: 0.2, emissive: '#a07010', emissiveIntensity: 0.8 })));
  const wm = new THREE.MeshBasicMaterial({ color: '#f4ecd8', transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false });
  const wings = [-1, 1].map(s => { const p = new THREE.Group(); const w = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.07), wm); w.position.x = s * 0.13; w.rotation.z = s * 0.25; p.add(w); g.add(p); return p; });
  return { g, wings };
}
