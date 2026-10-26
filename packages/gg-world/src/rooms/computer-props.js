// @ts-check
// The Computer Lab props: beige CRT PC stations (instanced), long desks, server rack, dot-matrix printer, whiteboard,
// vending machine, desk lamps, floppy boxes. Floor at y=0, local origin.
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh } from './kit.js';
import * as TX from './tex.js';

export const BEIGE = mat('#cfc4a2', { roughness: 0.7 }), BEIGE2 = mat('#b3a785', { roughness: 0.7 });
export const WOOD = mat('#8a6440', { roughness: 0.6 }), METAL = mat('#3a3a44', { metalness: 0.6, roughness: 0.4 }), DARK = mat('#1c1a22', { roughness: 0.6 });
const cyl = (rt, rb, h, m, seg = 14) => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);

/** Light lino-tile lab floor (readable, warm grey with a teal accent tile). */
export function labFloor() {
  return TX.canvasTex('computer-floor', 256, 256, (x, w, h) => {
    const n = 4, s = w / n; const g = TX.rand(31);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      x.fillStyle = (i + j) % 2 ? '#8c8478' : '#9e9688'; if ((i * 7 + j * 3) % 11 === 0) x.fillStyle = '#5f8a84';
      x.fillRect(i * s, j * s, s, s);
      for (let k = 0; k < 40; k++) { x.fillStyle = `rgba(40,30,20,${0.12 * g()})`; x.fillRect(i * s + g() * s, j * s + g() * s, 2, 2); }
    }
    x.strokeStyle = 'rgba(40,34,30,0.55)'; x.lineWidth = 2; for (let i = 0; i <= n; i++) { x.beginPath(); x.moveTo(i * s, 0); x.lineTo(i * s, h); x.moveTo(0, i * s); x.lineTo(w, i * s); x.stroke(); }
  }, { repeat: true });
}

/** Retro OS screen (teal desktop, icons, window). */
export function osScreen(k = 0) {
  return TX.canvasTex('computer-os' + k, 128, 96, (x, w, h) => {
    x.fillStyle = k ? '#0a2a1a' : '#1f7a7a'; x.fillRect(0, 0, w, h);
    if (k) { x.fillStyle = '#6ee7a0'; for (let i = 0; i < 9; i++) x.fillRect(6, 8 + i * 9, 20 + ((i * 37) % 80), 4); return; }
    x.fillStyle = '#c8c8c8'; x.fillRect(0, h - 10, w, 10); x.fillStyle = '#3a8a3a'; x.fillRect(2, h - 8, 18, 6);
    for (let i = 0; i < 4; i++) { x.fillStyle = ['#f1c453', '#e8e8e8', '#e63946', '#8fd0ff'][i]; x.fillRect(6, 6 + i * 18, 10, 9); }
    x.fillStyle = '#d0d0d0'; x.fillRect(34, 16, 80, 56); x.fillStyle = '#1a2a8a'; x.fillRect(34, 16, 80, 8); x.fillStyle = '#fff'; x.fillRect(38, 30, 72, 38);
    x.fillStyle = '#3ddc84'; for (let i = 0; i < 5; i++) x.fillRect(44 + i * 6, 46, 5, 5);
  });
}

/** CRT back: a 4-sided frustum (wide at the bezel, narrow at the back), axis along z. */
function crtBackGeo(wf, hf, wb, hb, d) { const g = new THREE.CylinderGeometry(Math.SQRT1_2, Math.SQRT1_2, 1, 4, 1); g.rotateY(Math.PI / 4); g.rotateX(Math.PI / 2);
  const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const front = p.getZ(i) > 0, sx = front ? wf : wb, sy = front ? hf : hb; p.setXYZ(i, p.getX(i) * sx, p.getY(i) * sy, p.getZ(i) * d); } g.computeVertexNormals(); return g; }
/** Keyboard top texture: rows of beige keycaps with dark gaps. */
function keysTex() { return TX.canvasTex('computer-keys', 128, 48, (x, w, h) => { x.fillStyle = '#6e6650'; x.fillRect(0, 0, w, h);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 15; c++) { const kx = 3 + c * 8.2 + (r % 2) * 3, ky = 3 + r * 11; if (kx > w - 9) continue; x.fillStyle = '#e4dabc'; x.fillRect(kx, ky, 7, 9); x.fillStyle = '#fff6dc'; x.fillRect(kx, ky, 7, 1); x.fillStyle = '#a89c7c'; x.fillRect(kx, ky + 8, 7, 1); }
  x.fillStyle = '#e4dabc'; x.fillRect(30, 3 + 4 * 11 - 1 > h - 3 ? h - 5 : 47, 60, 3); }); }

/** Instanced PC stations: per-station [x, z, ry]; each = beige CRT + screen + tower + keyboard + mouse + chair. */
export function stations(list) {
  const g = new THREE.Group();
  const parts = [
    [rbox(0.52, 0.44, 0.2, BEIGE, 0.035).geometry, BEIGE, 0, 1.02, 0.08],                    // bezel (rounded)
    [crtBackGeo(0.48, 0.4, 0.3, 0.26, 0.36), BEIGE2, 0, 1.02, -0.2],                          // tapered tube back
    [new THREE.CylinderGeometry(0.12, 0.16, 0.06, 16), BEIGE2, 0, 0.79, -0.05],               // swivel foot
    [rbox(0.2, 0.44, 0.44, BEIGE, 0.02).geometry, BEIGE, 0.62, 0.22, -0.1],                   // tower
    [rbox(0.46, 0.03, 0.16, BEIGE, 0.008).geometry, BEIGE, 0, 0.775, 0.3],                    // keyboard base
    [new THREE.PlaneGeometry(0.43, 0.13).rotateX(-Math.PI / 2 + 0.08), mat('#ffffff', { map: keysTex(), roughness: 0.6 }), 0, 0.792, 0.3], // keycaps
    [rbox(0.06, 0.025, 0.1, BEIGE2, 0.012).geometry, BEIGE2, 0.34, 0.77, 0.3],                // mouse
    [new THREE.BoxGeometry(0.44, 0.34, 0.01), DARK, 0, 1.04, 0.176],                          // screen recess
    [new THREE.BoxGeometry(0.12, 0.012, 0.01), DARK, 0.62, 0.36, 0.125],                      // floppy slot
    [new THREE.BoxGeometry(0.025, 0.012, 0.006), glowMat('#6eff7a', 2), 0.2, 0.84, 0.181],     // power LED
    // chair: seat, back, post, base
    [new THREE.BoxGeometry(0.46, 0.08, 0.44), mat('#3a4a7a', { roughness: 0.8 }), 0, 0.46, 0.9],
    [new THREE.BoxGeometry(0.44, 0.48, 0.07), mat('#3a4a7a', { roughness: 0.8 }), 0, 0.78, 1.12],
    [new THREE.CylinderGeometry(0.035, 0.035, 0.4, 8), METAL, 0, 0.22, 0.9],
    [new THREE.CylinderGeometry(0.26, 0.26, 0.04, 10), METAL, 0, 0.04, 0.9],
  ];
  const scr = [new THREE.PlaneGeometry(0.4, 0.31), 0, 1.04, 0.184];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  const fill = (im, ox, oy, oz) => { list.forEach(([x, z, ry], i) => { q.setFromAxisAngle(up, ry); const p = new THREE.Vector3(ox, oy, oz).applyQuaternion(q).add(new THREE.Vector3(x, 0, z)); m4.compose(p, q, one); im.setMatrixAt(i, m4); }); im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); };
  for (const [geo, m, ox, oy, oz] of parts) { const im = new THREE.InstancedMesh(geo, m, list.length); im.castShadow = false; im.receiveShadow = true; fill(im, ox, oy, oz); im.userData.live = true; g.add(im); }
  const sm = new THREE.MeshBasicMaterial({ map: osScreen(0), toneMapped: false });
  const sim = new THREE.InstancedMesh(scr[0], sm, list.length); fill(sim, 0, 1.04, 0.184); sim.userData.live = true; g.add(sim);
  g.userData.live = true; g.userData.screens = sim;
  return g;
}

/** Long lab desk, len along x, top at 0.75. */
export function desk(len) {
  const g = new THREE.Group();
  put(g, rbox(len, 0.05, 1.0, WOOD, 0.02), 0, 0.73, 0);
  put(g, rbox(len - 0.1, 0.5, 0.03, mat('#5a4030'), 0.01), 0, 0.42, -0.45);
  for (const x of [-len / 2 + 0.08, len / 2 - 0.08]) put(g, rbox(0.06, 0.72, 0.9, METAL, 0.02), x, 0.36, 0);
  return g;
}

/** Green-shade banker's desk lamp (bulb glow added live). */
export function deskLamp() {
  const g = new THREE.Group();
  put(g, cyl(0.08, 0.1, 0.03, mat('#b08a4a', { metalness: 0.8, roughness: 0.3 })), 0, 0.015, 0);
  put(g, cyl(0.012, 0.012, 0.32, mat('#b08a4a', { metalness: 0.8, roughness: 0.3 }), 6), 0, 0.17, 0);
  const sh = cyl(0.05, 0.12, 0.1, mat('#2f7a52', { roughness: 0.4 })); put(g, sh, 0, 0.34, 0.04);
  put(g, cyl(0.045, 0.045, 0.02, glowMat('#ffcf8a', 2)), 0, 0.29, 0.04);
  return g;
}

/** Server rack (live LED panel attached as userData.leds plane). */
export function rack() {
  const g = new THREE.Group();
  put(g, rbox(0.9, 2.1, 0.8, DARK, 0.03), 0, 1.05, 0);
  for (let i = 0; i < 7; i++) put(g, rbox(0.8, 0.22, 0.02, mat(i % 3 ? '#2c2c36' : '#3a3a48', { metalness: 0.5 }), 0.01), 0, 0.3 + i * 0.26, 0.41);
  return g;
}
export function ledTex() {
  return TX.canvasTex('computer-led', 32, 64, (x, w, h) => { x.clearRect(0, 0, w, h); for (let r = 0; r < 14; r++) for (let c = 0; c < 4; c++) { if ((r * 5 + c * 3) % 4 === 0) continue; x.fillStyle = (r + c) % 5 === 0 ? '#ffb36b' : (r * c) % 7 === 3 ? '#ff4f6b' : '#3ddc84'; x.fillRect(4 + c * 7, 3 + r * 4.4, 3, 2); } });
}

/** Dot-matrix printer on a little stand with a fan-fold paper stack. */
export function printerStand() {
  const g = new THREE.Group();
  put(g, rbox(1.0, 0.7, 0.6, METAL, 0.03), 0, 0.35, 0);
  put(g, rbox(0.7, 0.2, 0.42, BEIGE, 0.04), 0, 0.8, 0);
  put(g, rbox(0.5, 0.04, 0.1, DARK, 0.01), 0, 0.91, -0.08);
  put(g, rbox(0.42, 0.14, 0.3, mat('#e8e2cc', { roughness: 0.9 }), 0.01), 0, 0.07 + 0.0, 0.5);
  return g;
}

/** Whiteboard on wheels with marker scribbles. */
export function whiteboard() {
  const g = new THREE.Group();
  const tex = TX.canvasTex('computer-wb', 256, 140, (x, w, h) => {
    x.fillStyle = '#eef0ea'; x.fillRect(0, 0, w, h); x.lineWidth = 3; x.font = '27px m5x7';
    x.fillStyle = '#2a5ad8'; x.fillText('LAN PARTY FRI 23:00', 10, 24); x.fillStyle = '#d83a3a'; x.fillText('DO NOT git push -f', 10, 50);
    x.fillStyle = '#2a8a4a'; x.fillText('context > vibes', 10, 76); x.fillText('ask for tests!', 10, 100);
    x.strokeStyle = '#2a5ad8'; x.strokeRect(170, 60, 70, 60); x.beginPath(); x.moveTo(170, 60); x.lineTo(240, 120); x.stroke();
    x.fillStyle = '#555'; x.font = '21px m5x7'; x.fillText('bugs: ||||| |||', 10, 128);
  });
  put(g, rbox(1.9, 1.15, 0.05, mat('#9aa0a8', { metalness: 0.5 }), 0.02), 0, 1.45, 0);
  put(g, new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.05), new THREE.MeshBasicMaterial({ map: tex, color: '#d8d8d0' })), 0, 1.45, 0.04);
  for (const x of [-0.85, 0.85]) { put(g, rbox(0.05, 0.9, 0.05, METAL, 0.01), x, 0.45, 0); put(g, rbox(0.06, 0.04, 0.5, METAL, 0.01), x, 0.04, 0); }
  return g;
}

/** Vending machine: dark body, lit window with snack rows (live glow panel is part of it, emissive). */
export function vending() {
  const g = new THREE.Group();
  put(g, rbox(1.0, 1.95, 0.8, mat('#7a2a3a', { roughness: 0.5 }), 0.04), 0, 0.975, 0);
  const tex = TX.canvasTex('computer-vend', 64, 96, (x, w, h) => {
    x.fillStyle = '#2a2a3a'; x.fillRect(0, 0, w, h);
    const c = ['#3ddc84', '#ffb36b', '#ff4fd8', '#8fd0ff', '#f1c453'];
    for (let r = 0; r < 5; r++) for (let i = 0; i < 4; i++) { x.fillStyle = c[(r + i) % 5]; x.fillRect(5 + i * 14, 6 + r * 18, 10, 12); x.fillStyle = '#888'; x.fillRect(4 + i * 14, 19 + r * 18, 12, 2); }
  });
  put(g, new THREE.Mesh(new THREE.PlaneGeometry(0.62, 1.25), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })), -0.1, 1.15, 0.41);
  put(g, rbox(0.2, 0.5, 0.03, DARK, 0.01), 0.36, 1.25, 0.41);
  put(g, rbox(0.6, 0.18, 0.04, DARK, 0.02), -0.1, 0.3, 0.41);
  put(g, new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.16), new THREE.MeshBasicMaterial({ map: TX.label('BYTES & BITES', '#ffcf8a', '#3a1018', 256, 48), toneMapped: false })), 0, 1.83, 0.41);
  return g;
}

/** Floppy-disk box with a few colourful disks. */
export function floppies() {
  const g = new THREE.Group();
  put(g, rbox(0.3, 0.1, 0.18, mat('#2a2a30'), 0.01), 0, 0.05, 0);
  ['#e63946', '#2a6ad8', '#f1c453', '#3ddc84', '#222'].forEach((c, i) => { const d = rbox(0.02, 0.14, 0.14, mat(c), 0.003); d.rotation.z = 0.15 - i * 0.04; put(g, d, -0.1 + i * 0.05, 0.12, 0); });
  const loose = rbox(0.14, 0.006, 0.14, mat('#2a6ad8'), 0.003); put(g, loose, 0.3, 0.003, 0.05, 0.4);
  return g;
}

/** One proper beige CRT (bezel + tapered back + recess + LED + keyboard) facing +z, screen material given. Base at y=0. */
export function crtPC(screenMat, o = {}) {
  const g = new THREE.Group(), w = o.w ?? 0.52, h = o.h ?? 0.44;
  put(g, rbox(w, h, 0.2, BEIGE, 0.035), 0, h / 2 + 0.06, 0.08);
  put(g, mesh(crtBackGeo(w - 0.04, h - 0.04, w * 0.58, h * 0.6, 0.36), BEIGE2), 0, h / 2 + 0.06, -0.2);
  put(g, cyl(0.12, 0.16, 0.06, BEIGE2, 16), 0, 0.03, -0.05);
  put(g, new THREE.Mesh(new THREE.BoxGeometry(w - 0.08, h - 0.1, 0.01), DARK), 0, h / 2 + 0.08, 0.176);
  put(g, new THREE.Mesh(new THREE.PlaneGeometry(w - 0.12, h - 0.13), screenMat), 0, h / 2 + 0.08, 0.184);
  put(g, new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.012, 0.006), glowMat('#6eff7a', 2)), w / 2 - 0.06, 0.1, 0.181);
  if (o.keys !== false) { put(g, rbox(0.46, 0.03, 0.16, BEIGE, 0.008), 0, 0.015, 0.36); const k = new THREE.Mesh(new THREE.PlaneGeometry(0.43, 0.13).rotateX(-Math.PI / 2 + 0.08), mat('#ffffff', { map: keysTex(), roughness: 0.6 })); put(g, k, 0, 0.032, 0.36); }
  return g;
}

/** Helpdesk terminal on a stand (Prompt School): green phosphor CRT. */
export function terminalStand() {
  const g = new THREE.Group();
  put(g, rbox(0.9, 0.95, 0.6, WOOD, 0.03), 0, 0.475, 0);
  put(g, crtPC(new THREE.MeshBasicMaterial({ map: TX.termScreen(7, '#6ee7a0'), toneMapped: false }), { w: 0.55, h: 0.48 }), 0, 0.95, -0.12);
  put(g, new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.14), new THREE.MeshBasicMaterial({ map: TX.label('PROMPT SCHOOL', '#6ee7a0', '#0a1a10', 256, 48), toneMapped: false })), 0, 1.62, 0.0);
  return g;
}
