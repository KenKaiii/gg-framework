// @ts-check
// The Basement v2: extra zone props (hackathon table, office chair, storage cage, stairwell up to the den).
import * as THREE from 'three';
import { glowMat, rbox, put, mesh } from './kit.js';
import { mat } from './basement-props.js';
import * as FX from './kit-fx.js';

const metal = () => mat('#2e3038', { metalness: 0.6, roughness: 0.45 });

/** Long hackathon table made of two folding tables, along x. len = total length. */
export function hackTable(len = 3.6) {
  const g = new THREE.Group(); const top = mat('#7a5236'), leg = metal();
  put(g, rbox(len, 0.05, 0.95, top, 0.02), 0, 0.74, 0);
  for (let i = 1; i < 6; i++) put(g, rbox(len - 0.02, 0.002, 0.006, mat('#4a3020'), 0.001), 0, 0.766, -0.475 + i * 0.158); // plank seams
  put(g, rbox(len - 0.1, 0.06, 0.04, leg, 0.01), 0, 0.68, 0);
  for (const x of [-len / 2 + 0.12, -0.05, 0.05, len / 2 - 0.12]) for (const z of [-0.38, 0.38]) put(g, rbox(0.04, 0.7, 0.04, leg, 0.01), x, 0.35, z);
  for (const x of [-len / 2 + 0.12, len / 2 - 0.12]) put(g, rbox(0.04, 0.04, 0.8, leg, 0.01), x, 0.1, 0); // foot rails
  put(g, rbox(len * 0.6, 0.06, 0.16, mat('#2a2d34', { metalness: 0.5, roughness: 0.5 }), 0.01), 0, 0.6, 0); // under-desk cable tray
  for (const [x, z, c] of [[-1.2, 0.25, '#d8d2c4'], [1.1, -0.28, '#a8342a']]) { put(g, mesh(new THREE.CylinderGeometry(0.04, 0.037, 0.1, 12), mat(c, { roughness: 0.4 })), x, 0.815, z); put(g, mesh(new THREE.TorusGeometry(0.025, 0.007, 5, 10), mat(c)), x + 0.045, 0.815, z); }
  // power strip + cable run down the middle
  put(g, rbox(0.5, 0.04, 0.08, mat('#15161c'), 0.01), 0.2, 0.785, 0);
  const led = mesh(new THREE.BoxGeometry(0.02, 0.01, 0.02), glowMat('#ff5a3a', 2)); led.position.set(-0.03, 0.81, 0); g.add(led);
  return g;
}

/** Office chair (seat ~0.47), front +z, accent colour c. */
export function officeChair(c = '#2a4a6a') {
  const g = new THREE.Group(); const f = mat(c), m = metal();
  put(g, rbox(0.48, 0.09, 0.46, f, 0.04), 0, 0.47, 0); put(g, rbox(0.44, 0.5, 0.08, f, 0.04), 0, 0.8, -0.22);
  const post = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.36, 8), m); post.position.y = 0.25; g.add(post);
  for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2; const l = rbox(0.28, 0.03, 0.04, m, 0.01); l.position.set(Math.cos(a) * 0.13, 0.06, Math.sin(a) * 0.13); l.rotation.y = -a; g.add(l); }
  return g;
}

/** Chain-link storage cage (w along x, d along z, open front at +z with a door ajar). Returns the group. */
export function storageCage(w = 2.4, d = 2.2) {
  const g = new THREE.Group(); const m = metal(), H = 2.3;
  const tex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
    x.strokeStyle = '#8a8f98'; x.lineWidth = 3; x.beginPath(); for (let i = -64; i < 128; i += 16) { x.moveTo(i, 0); x.lineTo(i + 64, 64); x.moveTo(i + 64, 0); x.lineTo(i, 64); } x.stroke();
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const meshM = new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, metalness: 0.5, roughness: 0.5 });
  const panel = (pw, x, z, ry) => { const t = tex.clone(); t.repeat.set(pw * 3, H * 3); t.needsUpdate = true; const pm = meshM.clone(); pm.map = t; const p = new THREE.Mesh(new THREE.PlaneGeometry(pw, H), pm); p.position.set(x, H / 2, z); p.rotation.y = ry; g.add(p); };
  panel(d, w / 2, 0, Math.PI / 2); panel(w - 0.9, -0.45, d / 2, 0);
  for (const [x, z] of [[w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2], [w / 2 - 0.9, d / 2]]) put(g, rbox(0.05, H, 0.05, m, 0.01), x, H / 2, z);
  put(g, rbox(0.05, 0.05, d, m, 0.01), w / 2, H, 0); put(g, rbox(w, 0.05, 0.05, m, 0.01), 0, H, d / 2);
  // contents: stacked crates, spare drives box, old CRT
  for (const [x, y, z, s, c] of [[-0.6, 0.25, -0.5, 0.5, '#4e3d34'], [-0.6, 0.72, -0.5, 0.44, '#9a7a2e'], [0.2, 0.22, -0.6, 0.44, '#2a4a6a'], [-0.1, 0.2, 0.2, 0.4, '#4e3d34']]) put(g, rbox(s * 1.3, s, s, mat(c), 0.02), x, y, z, x * 0.3);
  put(g, rbox(0.5, 0.42, 0.45, mat('#b8b09a'), 0.06), 0.25, 0.65, -0.6, -0.2);
  return g;
}

/**
 * Stairwell behind the north-wall door: steps rising away from the room up to the den, side walls, a bulb at the top.
 * Replaces the kit door's flat glow plane (removed here) so you see real steps through the frame.
 * @param {any} R room  @param {number} x door centre (world x)  @param {number} w door width
 */
export function stairwell(R, x, w = 1.2) {
  R.walls.n.full.traverse(o => { if (o.isMesh && o.geometry?.parameters?.height === 2.2 && o.material?.isMeshBasicMaterial && o.position.z < -0.2) o.visible = false; });
  const g = new THREE.Group(); const z0 = -R.d / 2 - 0.2, n = 9, rise = 0.21, run = 0.32;
  const stepM = mat('#4e3d34'), nose = mat('#9a7a2e'), wallM = mat('#3a2a54');
  for (let i = 0; i < n; i++) { const h = rise * (i + 1); put(g, rbox(w, h, run, stepM, 0.01), x, h / 2, z0 - run * (i + 0.5)); put(g, rbox(w, 0.02, 0.04, nose, 0.005), x, h + 0.01, z0 - run * i - 0.03); }
  const L = run * n + 0.6;
  for (const s of [-1, 1]) put(g, rbox(0.12, 3.2, L, wallM, 0.01), x + s * (w / 2 + 0.06), 1.6, z0 - L / 2);
  put(g, rbox(w + 0.24, 3.2, 0.12, glowMat('#3a1f52', 0.6), 0.01), x, 1.6, z0 - L);
  // handrail
  const rail = mesh(new THREE.CylinderGeometry(0.02, 0.02, Math.hypot(run * n, rise * n), 8), mat('#7a5236'));
  rail.position.set(x + w / 2 - 0.05, rise * n / 2 + 0.9, z0 - run * n / 2); rail.rotation.x = -Math.atan2(rise * n, run * n) - Math.PI / 2 + Math.PI; g.add(rail);
  rail.rotation.x = Math.PI / 2 - Math.atan2(rise * n, run * n);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), glowMat('#ffcf8a', 3)); bulb.position.set(x, 2.95, z0 - L + 0.4);
  const halo = FX.glow('#ffb36b', 1.0, 0.4); halo.position.copy(bulb.position);
  return { g, bulb, halo };
}

/** Beanbag in another colour. @param {string} c */
export function tintBeanbag(c) {
  const geo = new THREE.SphereGeometry(0.5, 20, 12); geo.scale(1, 0.55, 1); geo.translate(0, 0.25, 0);
  const g = new THREE.Group(); g.add(mesh(geo, mat(c))); return g;
}
