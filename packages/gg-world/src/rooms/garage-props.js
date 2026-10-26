// @ts-check
// Doc's Garage: big props (the stainless time car, the wall of clocks, the giant amp + guitar).
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh, rng } from './kit.js';
import * as TX from './tex.js';

export const steel = () => mat('#c4c8ce', { metalness: 0.5, roughness: 0.36 });
export const black = () => mat('#141418', { roughness: 0.6 });
export const gunmetal = () => mat('#3a3d44', { metalness: 0.65, roughness: 0.45 });
const glass = () => mat('#0d1420', { metalness: 0.4, roughness: 0.12 });

/** Side profile (x along the car, y up) extruded across z. */
function profile(pts, depth, m, bevel = 0.04) {
  const s = new THREE.Shape(); s.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) s.lineTo(p[0], p[1]);
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2 });
  geo.translate(0, 0, -depth / 2); return mesh(geo, m);
}

/** Display texture for the time circuits (dashboard). @param {string} txt @param {string} col */
export function circuitTex(txt, col = '#ff5a3a') {
  return TX.canvasTex('gar-tc-' + txt, 256, 64, x => {
    x.fillStyle = '#0a0606'; x.fillRect(0, 0, 256, 64); x.strokeStyle = '#3a3d44'; x.lineWidth = 4; x.strokeRect(2, 2, 252, 60);
    x.font = '57px m5x7'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.shadowColor = col; x.shadowBlur = 10; x.fillStyle = col; x.fillText(txt, 128, 34);
  });
}

/** The gull-wing time car, nose toward +x, open door on the -z side. Baked inside; glowing bits returned live. */
export function timeCar() {
  const g = new THREE.Group(), st = steel(), bk = black();
  g.add(profile([[-2.05, 0.3], [2.0, 0.3], [2.12, 0.52], [1.98, 0.68], [0.6, 0.84], [-1.85, 0.9], [-2.08, 0.78]], 1.62, st));
  g.add(profile([[0.5, 0.84], [-0.25, 1.22], [-1.15, 1.22], [-1.8, 0.9]], 1.34, glass(), 0.03));
  put(g, rbox(0.95, 0.04, 1.36, st, 0.02), -0.7, 1.25, 0);                        // roof skin
  put(g, rbox(4.12, 0.13, 1.72, bk, 0.04), 0, 0.37, 0);                            // black lower trim
  for (let i = 0; i < 6; i++) put(g, rbox(0.05, 0.03, 1.2, bk, 0.01), -1.25 - i * 0.11, 1.08 - i * 0.033, 0); // rear louvres
  put(g, rbox(0.06, 0.1, 1.4, glowMat('#ff3a2a', 1.6), 0.02), -2.12, 0.6, 0);      // tail lights
  for (const z of [-0.55, 0.55]) put(g, rbox(0.04, 0.09, 0.32, glowMat('#fff2d0', 1.4), 0.02), 2.13, 0.48, z);
  const fusion = mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.3, 14), mat('#d8d4c8', { roughness: 0.4 })); put(g, fusion, -1.7, 1.06, 0.35);
  for (const z of [-0.5, 0.5]) { const v = mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.5, 10), gunmetal()); v.rotation.z = Math.PI / 2; put(g, v, -2.25, 0.72, z); }
  for (const z of [-0.6, -0.2, 0.2]) { const c = mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.4, 8), mat('#7a5236', { metalness: 0.6 })); c.rotation.z = Math.PI / 2; put(g, c, -1.55, 0.98, z); }
  for (const [x, z] of [[1.35, -0.82], [1.35, 0.82], [-1.35, -0.82], [-1.35, 0.82]]) {
    const w = mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 22), bk); w.rotation.x = Math.PI / 2; put(g, w, x, 0.34, z);
    const h = mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.26, 12), st); h.rotation.x = Math.PI / 2; put(g, h, x, 0.34, z);
  }
  // interior: two seats, the bulkhead, steering wheel
  for (const z of [-0.36, 0.36]) { put(g, rbox(0.5, 0.14, 0.46, bk, 0.05), -0.45, 0.62, z); put(g, rbox(0.14, 0.55, 0.46, bk, 0.06), -0.75, 0.9, z, 0).rotation.z = 0.25; }
  put(g, rbox(0.06, 0.5, 1.2, gunmetal(), 0.02), -1.12, 0.95, 0);
  const sw = mesh(new THREE.TorusGeometry(0.13, 0.02, 6, 16), bk); sw.rotation.y = Math.PI / 2; sw.rotation.x = 0.4; put(g, sw, 0.05, 0.92, -0.36);
  // gull-wing door, hinged at the roof edge, swung up and out
  const door = new THREE.Group(); door.position.set(-0.7, 1.22, -0.68); door.rotation.x = 2.15;
  put(door, rbox(1.15, 0.3, 0.04, glass(), 0.02), 0, -0.15, 0); put(door, rbox(1.17, 0.34, 0.05, st, 0.02), 0, -0.47, 0); g.add(door);
  // flux capacitor on the bulkhead (between the seats), facing the open door
  const flux = new THREE.Group(); flux.position.set(-1.0, 1.0, -0.2); flux.userData.live = true; g.add(flux);
  put(flux, rbox(0.06, 0.36, 0.3, mat('#5a5e66', { metalness: 0.6, roughness: 0.4 }), 0.02), 0, 0, 0);
  const fm = glowMat('#ffe9a8', 1.6); const arm = (a) => { const b = mesh(new THREE.BoxGeometry(0.012, 0.13, 0.02), fm); b.position.set(0.035, Math.cos(a) * 0.065, Math.sin(a) * 0.065); b.rotation.x = -a; flux.add(b); };
  arm(0); arm(2.1); arm(-2.1);
  const display = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.1), new THREE.MeshBasicMaterial({ map: circuitTex('OCT 26 1985', '#ff5a3a'), toneMapped: false }));
  display.position.set(0.35, 0.98, -0.3); display.rotation.set(-0.5, -Math.PI / 2 + 0.6, 0, 'YXZ'); display.userData.live = true; g.add(display);
  // blue undercar glow
  const under = new THREE.Mesh(new THREE.PlaneGeometry(5.0, 2.6), new THREE.MeshBasicMaterial({ map: TX.dotTex(), color: '#3a9cff', transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  under.rotation.x = -Math.PI / 2; under.position.y = 0.025; under.userData.live = true; g.add(under);
  const strip = rbox(3.3, 0.04, 1.3, glowMat('#4fb8ff', 2.2), 0.02); strip.position.y = 0.2; strip.userData.live = true; g.add(strip);
  return { g, flux, fm, display, under, strip };
}

/** Clock face texture (shared). */
function faceTex() {
  return TX.canvasTex('gar-clockface', 128, 128, x => {
    x.fillStyle = '#e8dcc0'; x.beginPath(); x.arc(64, 64, 63, 0, 7); x.fill();
    x.fillStyle = '#2a2018'; for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; x.save(); x.translate(64, 64); x.rotate(a); x.fillRect(-2, -58, 4, i % 3 ? 9 : 15); x.restore(); }
    x.beginPath(); x.arc(64, 64, 5, 0, 7); x.fill();
  });
}

/** Free-standing pegboard panel with ~14 clocks; hands are instanced and ticked by the room. */
export function clockWall() {
  const g = new THREE.Group(), wood = mat('#4a3022', { roughness: 0.85 });
  put(g, rbox(3.5, 2.5, 0.08, wood, 0.03), 0, 1.5, 0);
  for (const x of [-1.6, 1.6]) put(g, rbox(0.1, 0.25, 0.4, wood, 0.02), x, 0.12, 0.1);
  put(g, rbox(3.6, 0.08, 0.14, mat('#2a1c14'), 0.02), 0, 2.78, 0.02);
  const r = rng(26), C = [];
  const spots = [[-1.25, 2.3, 0.26], [-0.55, 2.4, 0.18], [0.1, 2.0, 0.42], [0.85, 2.4, 0.2], [1.4, 2.15, 0.24], [-1.4, 1.55, 0.2], [-0.75, 1.7, 0.3],
    [0.85, 1.6, 0.3], [1.45, 1.35, 0.16], [-1.2, 0.85, 0.28], [-0.45, 1.0, 0.18], [0.15, 1.15, 0.22], [0.75, 0.9, 0.2], [1.35, 0.7, 0.18]];
  for (const [x, y, rad] of spots) C.push({ x, y, rad, rate: 0.5 + r() * 3, ph: r() * 6, tick: r() > 0.4 });
  const one = new THREE.Vector3(1, 1, 1), m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
  const faces = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 24), mat('#ffffff', { map: faceTex(), roughness: 0.6 }), C.length);
  const rims = new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.12, 6, 24), mat('#ffffff', { metalness: 0.6, roughness: 0.4 }), C.length);
  const rimCols = ['#9a7a2e', '#2a2a30', '#7a3a2a', '#b8b09a', '#3a5a4a'].map(c => new THREE.Color(c));
  C.forEach((c, i) => { m4.compose(new THREE.Vector3(c.x, c.y, 0.07), q, new THREE.Vector3(c.rad, c.rad, 1)); faces.setMatrixAt(i, m4);
    m4.compose(new THREE.Vector3(c.x, c.y, 0.08), q, new THREE.Vector3(c.rad, c.rad, c.rad)); rims.setMatrixAt(i, m4); rims.setColorAt(i, rimCols[i % rimCols.length]); });
  const hg = new THREE.BoxGeometry(1, 1, 1); hg.translate(0, 0.5, 0);
  const hands = new THREE.InstancedMesh(hg, mat('#1a1410'), C.length * 2);
  for (const o of [faces, rims, hands]) { o.userData.live = true; g.add(o); }
  const z = new THREE.Vector3(0, 0, 1), p = new THREE.Vector3(), s = new THREE.Vector3();
  // set: 0..1 blends every clock to 10:04 (minute hand k=0, hour hand k=1); spin adds a whirl while they swing over
  const TGT = [-(4 / 60) * Math.PI * 2, -((10 + 4 / 60) / 12) * Math.PI * 2];
  const update = (t, set = 0, spin = 0) => { C.forEach((c, i) => { const sec = c.tick ? Math.floor(t * c.rate) : t * c.rate;
    for (let k = 0; k < 2; k++) { const a0 = -(k ? sec / 12 + c.ph : sec + c.ph * 3) * (Math.PI * 2 / 60) - spin * (k ? 1 : 4) * (1 + (i % 3) * 0.3);
      const T = TGT[k] + Math.round((a0 - TGT[k]) / (Math.PI * 2)) * Math.PI * 2, a = a0 + (T - a0) * set; q.setFromAxisAngle(z, a);
      p.set(c.x, c.y, 0.1 + k * 0.01); s.set(c.rad * (k ? 0.1 : 0.06), c.rad * (k ? 0.55 : 0.85), 0.01); m4.compose(p, q, s); hands.setMatrixAt(i * 2 + k, m4); } });
    hands.instanceMatrix.needsUpdate = true; };
  update(0);
  return { g, update };
}

/** Giant amp stack (faces +z) + a guitar on a stand next to it. */
export function ampStack() {
  const g = new THREE.Group(), tol = mat('#17161a', { roughness: 0.8 }), cloth = mat('#2e2a24', { roughness: 1 }), gold = mat('#b8943e', { metalness: 0.8, roughness: 0.35 });
  put(g, rbox(1.4, 1.5, 0.72, tol, 0.06), 0, 0.8, 0); put(g, rbox(1.22, 1.3, 0.02, cloth, 0.01), 0, 0.8, 0.365);
  for (const [x, y] of [[-0.3, 1.12], [0.3, 1.12], [-0.3, 0.48], [0.3, 0.48]]) { const c = mesh(new THREE.TorusGeometry(0.23, 0.025, 6, 20), mat('#24211c')); put(g, c, x, y, 0.38); }
  put(g, rbox(1.44, 0.03, 0.03, gold, 0.01), 0, 1.47, 0.37); put(g, rbox(1.44, 0.03, 0.03, gold, 0.01), 0, 0.13, 0.37);
  put(g, rbox(1.44, 0.46, 0.66, tol, 0.05), 0, 1.79, -0.02);                   // head
  put(g, rbox(1.2, 0.18, 0.02, gold, 0.01), 0, 1.79, 0.32);
  for (let i = 0; i < 8; i++) { const k = mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 10), black()); k.rotation.x = Math.PI / 2; put(g, k, -0.48 + i * 0.12, 1.79, 0.35); }
  for (const x of [-0.6, 0.6]) { const ft = mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.06, 8), black()); put(g, ft, x, 0.03, 0.25); }
  put(g, rbox(0.08, 0.035, 0.02, glowMat('#ff3a2a', 1.2), 0.01), 0.6, 1.95, 0.33);
  // guitar on a stand, right of the amp
  const gt = new THREE.Group(); gt.position.set(1.05, 0, 0.2); gt.rotation.set(-0.15, -0.4, 0); g.add(gt);
  const sh = new THREE.Shape(); sh.absarc(0, 0.32, 0.2, -0.2, Math.PI + 0.2, true); sh.absarc(0, 0.62, 0.15, Math.PI + 0.4, -0.4, true);
  const body = mesh(new THREE.ExtrudeGeometry(sh, { depth: 0.07, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2 }), mat('#8a2a24', { roughness: 0.35 }));
  body.position.set(0, 0.0, -0.035); gt.add(body);
  put(gt, rbox(0.06, 0.7, 0.04, mat('#3a2a1a'), 0.01), 0, 1.1, 0.03); put(gt, rbox(0.09, 0.18, 0.04, mat('#15161c'), 0.02), 0, 1.5, 0.03);
  put(gt, rbox(0.22, 0.05, 0.02, mat('#e8dcc0'), 0.01), 0, 0.38, 0.06);
  const stand = mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.9, 6), gunmetal()); put(g, stand, 1.05, 0.45, 0.05).rotation.x = -0.15;
  put(g, rbox(0.4, 0.03, 0.3, gunmetal(), 0.01), 1.05, 0.02, 0.2);
  return g;
}
