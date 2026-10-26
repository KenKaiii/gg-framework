// @ts-check
// Limbo props (part 1): pale stone floor, dream chairs, the silver briefcase, Penrose steps, spinning-top table,
// mirrors with an infinite tunnel texture, floor lamp. Floor at y=0, local origin.
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh } from './kit.js';
import * as TX from './tex.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const cyl = (rt, rb, h, m, seg = 16) => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
export const STONE = mat('#c9c2b4', { roughness: 0.7 }), CHROME = mat('#c8ccd4', { metalness: 0.75, roughness: 0.45 });
export const LEATHER = mat('#2c2a34', { roughness: 0.55 }), CREAM = mat('#d8ccb0', { roughness: 0.8 }), WOOD = mat('#6a4a34', { roughness: 0.55 });
export const BRASS = mat('#c09a58', { metalness: 0.8, roughness: 0.3 }), DARK = mat('#1a1820', { roughness: 0.6 });

/** Pale marble-ish stone tiles with a fine grid (reads bright at default zoom). */
export function stoneFloor() {
  return TX.canvasTex('limbo-floor', 256, 256, (x, w, h) => {
    const g = TX.rand(31);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { const v = 176 + Math.floor(g() * 22); x.fillStyle = `rgb(${v},${v - 6},${v - 14})`; x.fillRect(i * 64, j * 64, 64, 64); }
    x.strokeStyle = 'rgba(255,255,255,0.10)'; for (let i = 0; i < 40; i++) { x.beginPath(); x.moveTo(g() * w, g() * h); x.bezierCurveTo(g() * w, g() * h, g() * w, g() * h, g() * w, g() * h); x.stroke(); }
    x.fillStyle = '#7a7268'; for (let i = 0; i <= 4; i++) { x.fillRect(i * 64 - 1, 0, 2, h); x.fillRect(0, i * 64 - 1, w, 2); }
  }, { repeat: true });
}

/** merge geometries (converted to non-indexed) after placing each; one draw call per material */
const bake = (list) => mergeGeometries(list.map(([geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0]) => { const g = geo.index ? geo.toNonIndexed() : geo.clone(); g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)).setPosition(x, y, z)); return g; }));
const rgeo = (w, h, d, r) => /** @type {any} */ (rbox(w, h, d, CHROME, r)).geometry;

/** Reclining dream chair (seen big in the Go Under close-up): turned chrome pedestal (lathe), a padded leather recliner
 * in tufted segments with cream piping, padded armrests on chrome brackets, a cream headrest pillow. 3 draw calls. */
export function dreamChair() {
  const g = new THREE.Group();
  // chrome: lathe pedestal + armrest brackets + footrest bar
  const ped = new THREE.LatheGeometry([[0, 0], [0.34, 0], [0.35, 0.02], [0.33, 0.05], [0.12, 0.08], [0.06, 0.12], [0.05, 0.3], [0.08, 0.34], [0.08, 0.37], [0, 0.37]].map(([x, y]) => new THREE.Vector2(x, y)), 28);
  const chromeG = [[ped]];
  for (const sx of [-1, 1]) { chromeG.push([new THREE.CylinderGeometry(0.018, 0.018, 0.22, 8), sx * 0.34, 0.47, 0.1]); chromeG.push([new THREE.CylinderGeometry(0.018, 0.018, 0.22, 8), sx * 0.34, 0.47, -0.2]); }
  chromeG.push([new THREE.CylinderGeometry(0.015, 0.015, 0.6, 8), 0, 0.2, 0.86, 0, 0, Math.PI / 2]);
  g.add(mesh(bake(chromeG), CHROME));
  // leather: seat, back and leg rest each split into tufted cushions (small gaps read as stitching)
  const leatherG = [];
  for (let i = 0; i < 2; i++) leatherG.push([rgeo(0.6, 0.13, 0.34, 0.05), 0, 0.43, -0.12 + i * 0.35]);
  for (let i = 0; i < 3; i++) { const t = -0.2 - i * 0.29; leatherG.push([rgeo(0.6, 0.12, 0.28, 0.05), 0, 0.56 - t * 0.68, -0.32 + t * 0.62, 0.95]); }
  for (let i = 0; i < 2; i++) leatherG.push([rgeo(0.56, 0.1, 0.27, 0.045), 0, 0.37 - i * 0.09, 0.47 + i * 0.27, 0.35]);
  for (const sx of [-1, 1]) leatherG.push([rgeo(0.1, 0.07, 0.5, 0.03), sx * 0.34, 0.6, -0.05]);
  g.add(mesh(bake(leatherG), LEATHER));
  // cream: headrest pillow + piping along the seams
  const creamG = [[rgeo(0.38, 0.1, 0.22, 0.05), 0, 1.1, -0.84, 0.95]];
  for (const sx of [-1, 1]) { creamG.push([new THREE.CylinderGeometry(0.012, 0.012, 0.7, 6), sx * 0.3, 0.5, 0.06, Math.PI / 2]); }
  g.add(mesh(bake(creamG), CREAM));
  return g;
}

/** The silver briefcase device (PASIV): ribbed brushed-aluminium case on a dark plinth, open lid with a padded
 * foam lining, brass latches + handle, a control panel of three brass dials, a warm amber readout, and coiled drip
 * lines running off the sides. Baked per material (5 draw calls). */
export function briefcase() {
  const g = new THREE.Group();
  g.add(mesh(bake([[rgeo(0.9, 0.42, 0.5, 0.05), 0, 0.21, 0], [rgeo(0.94, 0.04, 0.54, 0.02), 0, 0.02, 0]]), mat('#2a2830', { roughness: 0.6 })));
  const ALU = mat('#c8ccd4', { metalness: 0.8, roughness: 0.32 });
  const alu = [[rgeo(0.72, 0.15, 0.46, 0.035), 0, 0.495, 0]];
  for (let i = 0; i < 4; i++) alu.push([rgeo(0.73, 0.012, 0.47, 0.004), 0, 0.45 + i * 0.03, 0]); // ribs
  alu.push([rgeo(0.72, 0.44, 0.05, 0.025), 0, 0.77, -0.26, -0.25]);                                 // lid
  for (let i = 0; i < 3; i++) alu.push([rgeo(0.73, 0.01, 0.055, 0.004), 0, 0.62 + i * 0.12, -0.225 - i * 0.03, -0.25]);
  g.add(mesh(bake(alu), ALU));
  const brass = [];
  for (const sx of [-1, 1]) brass.push([rgeo(0.06, 0.05, 0.02, 0.008), sx * 0.24, 0.52, 0.235]);                 // latches
  brass.push([new THREE.TorusGeometry(0.07, 0.014, 6, 14, Math.PI), 0, 0.5, 0.25, 0, 0, 0]);                    // handle
  for (let i = 0; i < 3; i++) { brass.push([new THREE.CylinderGeometry(0.042, 0.046, 0.025, 16), -0.18 + i * 0.12, 0.585, -0.05]); brass.push([rgeo(0.008, 0.01, 0.03, 0.002), -0.18 + i * 0.12, 0.602, -0.07, 0, i * 0.9, 0]); }
  g.add(mesh(bake(brass), BRASS));
  g.add(mesh(bake([[rgeo(0.64, 0.02, 0.38, 0.01), 0, 0.57, 0.02], [rgeo(0.64, 0.36, 0.02, 0.01), 0, 0.78, -0.23, -0.25]]), mat('#1a1820', { roughness: 0.95 }))); // foam lining
  put(g, rbox(0.14, 0.025, 0.1, glowMat('#ffb36b', 1.0), 0.01), 0.2, 0.585, 0.06);
  // coiled drip lines: two helix tubes leading off the sides, one draw call
  const coil = (sx) => { const pts = []; for (let i = 0; i <= 60; i++) { const t = i / 60, a = t * Math.PI * 12; pts.push(new THREE.Vector3(sx * (0.36 + t * 0.3), 0.5 - t * 0.38 + Math.sin(a) * 0.025, 0.05 + Math.cos(a) * 0.025)); } return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 90, 0.009, 5); };
  g.add(mesh(bake([[coil(-1)], [coil(1)]]), mat('#e8e4dc', { roughness: 0.4 })));
  return g;
}

/** Penrose "impossible" staircase: a square ring of four rising flights on a pale plinth. */
export function penrose() {
  const g = new THREE.Group(), m = mat('#d6d0c4', { roughness: 0.6 }), side = mat('#9c94a8', { roughness: 0.7 });
  put(g, rbox(3.2, 0.2, 3.2, mat('#5a5470'), 0.06), 0, 0.1, 0);
  const n = 7, L = 2.4, step = L / n; let k = 0;
  for (let f = 0; f < 4; f++) for (let i = 0; i < n; i++, k++) {
    const h = 0.4 + k * 0.07, a = -L / 2 + (i + 0.5) * step;
    const b = rbox(f % 2 ? 0.5 : step, h, f % 2 ? step : 0.5, k % 2 ? m : side, 0.02);
    const pos = [[a, -L / 2], [L / 2, a], [-a, L / 2], [-L / 2, -a]][f]; put(g, b, pos[0], 0.2 + h / 2, pos[1]);
  }
  return g;
}

/** Small round side table for the spinning top: polished walnut with a turned edge, a green leather inset, a brass
 *  ring, a turned brass column and a three-footed base. (It's seen up close in the totem game.) */
export function topTable() {
  const g = new THREE.Group();
  const walnut = mat('#5a3420', { roughness: 0.32, metalness: 0.05 }), leather = mat('#1f4a3a', { roughness: 0.75 });
  // top: a turned profile (chamfered underside, rounded lip), leather inset sitting 2 mm proud of the wood
  const prof = [[0, 0.68], [0.38, 0.68], [0.42, 0.69], [0.435, 0.705], [0.435, 0.73], [0.425, 0.745], [0, 0.745]].map(p => new THREE.Vector2(p[0], p[1]));
  put(g, mesh(new THREE.LatheGeometry(prof, 40), walnut), 0, 0, 0);
  put(g, cyl(0.37, 0.37, 0.004, leather, 40), 0, 0.747, 0);
  put(g, mesh(new THREE.TorusGeometry(0.372, 0.006, 6, 48).rotateX(Math.PI / 2), BRASS), 0, 0.748, 0);
  // turned column: bead, waist, collar
  const col = [[0, 0.06], [0.05, 0.06], [0.06, 0.1], [0.035, 0.18], [0.03, 0.45], [0.045, 0.5], [0.03, 0.55], [0.035, 0.66], [0.06, 0.68], [0, 0.68]].map(p => new THREE.Vector2(p[0], p[1]));
  put(g, mesh(new THREE.LatheGeometry(col, 20), BRASS), 0, 0, 0);
  // three curved feet
  for (let k = 0; k < 3; k++) { const a = k / 3 * Math.PI * 2, f = rbox(0.05, 0.05, 0.3, walnut, 0.02); f.position.set(Math.sin(a) * 0.14, 0.035, Math.cos(a) * 0.14); f.rotation.set(0.12, a, 0); g.add(f); }
  return g;
}

/** The totem: a small turned-brass spinning top (live; spun by the room / activity). Smooth lathe profile, a darker
 *  engraved band and a steel tip so the spin reads, and a tiny cap on the stem. */
export function spinTop() {
  const g = new THREE.Group();
  const brass = mat('#d8a85a', { metalness: 0.9, roughness: 0.22 }), band = mat('#7a5220', { metalness: 0.8, roughness: 0.35 }), steel = mat('#c8ccd4', { metalness: 1, roughness: 0.15 });
  const prof = [[0, 0.004], [0.006, 0.008], [0.03, 0.03], [0.055, 0.052], [0.068, 0.066], [0.071, 0.074], [0.066, 0.082], [0.045, 0.094], [0.016, 0.104], [0.011, 0.11], [0.011, 0.152], [0.016, 0.158], [0, 0.162]].map(p => new THREE.Vector2(p[0], p[1]));
  put(g, mesh(new THREE.LatheGeometry(prof, 40), brass), 0, 0, 0);
  put(g, mesh(new THREE.TorusGeometry(0.069, 0.004, 6, 40).rotateX(Math.PI / 2), band), 0, 0.072, 0);
  put(g, mesh(new THREE.TorusGeometry(0.05, 0.003, 6, 40).rotateX(Math.PI / 2), band), 0, 0.09, 0);
  put(g, mesh(new THREE.ConeGeometry(0.007, 0.012, 10).rotateX(Math.PI), steel), 0, 0.004, 0);
  return g;
}

/** Infinite mirror tunnel texture: nested frames shrinking by 0.8 each step (so zooming by 1/0.8 loops). */
export function tunnelTex() {
  return TX.canvasTex('limbo-tunnel', 256, 384, (x, w, h) => {
    x.fillStyle = '#20263a'; x.fillRect(0, 0, w, h);
    let s = 1; for (let i = 0; i < 18; i++, s *= 0.8) {
      const fw = w * s, fh = h * s; x.fillStyle = i % 2 ? '#8fa8ff' : '#c9b48a'; x.globalAlpha = 0.25 + 0.6 * s;
      x.fillRect((w - fw) / 2, (h - fh) / 2, fw, fh); x.globalAlpha = 1; x.fillStyle = `rgb(${40 + 60 * s},${48 + 70 * s},${70 + 90 * s})`;
      x.fillRect((w - fw) / 2 + 6 * s, (h - fh) / 2 + 6 * s, fw - 12 * s, fh - 12 * s);
    }
  });
}

/** Tall mirror: brass frame + live tunnel surface (returned as userData.glass). */
export function mirror(stand = false) {
  const g = new THREE.Group(), w = 1.3, h = 2.2;
  put(g, rbox(w + 0.14, h + 0.14, 0.06, BRASS, 0.02), 0, h / 2 + (stand ? 0.25 : 0.2), 0);
  if (stand) { for (const s of [-1, 1]) put(g, rbox(0.08, 0.3, 0.5, BRASS, 0.02), s * 0.6, 0.15, 0); }
  const t = tunnelTex(); t.wrapS = t.wrapT = THREE.RepeatWrapping;
  const gl = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t, toneMapped: false }));
  gl.position.set(0, h / 2 + (stand ? 0.25 : 0.2), 0.045); g.userData.glass = gl;
  return g;
}

/** Floor lamp: brass pole, cream drum shade (bulb glow added live). */
export function floorLamp() {
  const g = new THREE.Group();
  put(g, cyl(0.18, 0.2, 0.04, BRASS, 16), 0, 0.02, 0); put(g, cyl(0.02, 0.02, 1.6, BRASS, 6), 0, 0.82, 0);
  put(g, cyl(0.22, 0.28, 0.32, glowMat('#ffd9a0', 1.05), 18), 0, 1.65, 0);
  return g;
}

/** Low sofa (for the tilted set and the lounge). */
export function sofa(color = '#6a5a7a') {
  const g = new THREE.Group(), m = mat(color, { roughness: 0.85 });
  put(g, rbox(1.9, 0.36, 0.8, m, 0.08), 0, 0.26, 0); put(g, rbox(1.9, 0.5, 0.2, m, 0.08), 0, 0.62, -0.3);
  for (const s of [-1, 1]) put(g, rbox(0.18, 0.5, 0.8, m, 0.07), s * 0.92, 0.38, 0);
  for (const s of [-1, 1]) for (const z of [-0.3, 0.3]) put(g, cyl(0.03, 0.02, 0.1, BRASS, 6), s * 0.85, 0.05, z);
  return g;
}
