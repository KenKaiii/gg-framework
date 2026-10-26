// @ts-check
// The Basement: prop builders (server rack, mining rig, monitor wall, workbench, seating, fridge, whiteboard).
import * as THREE from 'three';
import { mat as kmat, glowMat, rbox, put, mesh, rng } from './kit.js';

// Small shared palette: every untextured colour snaps to one of these, so the bake makes few draw calls.
const PAL = [['#15161c', { roughness: 0.55 }], ['#2e3038', { metalness: 0.6, roughness: 0.45 }], ['#3a2a22', { roughness: 0.85 }],
  ['#4e3d34', { roughness: 0.95 }], ['#b8b09a', { roughness: 0.6 }], ['#2d6a3a', { metalness: 0.4, roughness: 0.45 }],
  ['#3a2a54', { roughness: 0.9 }], ['#a8342a', { roughness: 0.6 }],
  // v2: a little more colour (each entry is one baked draw call)
  ['#2a4a6a', { roughness: 0.8 }], ['#9a7a2e', { roughness: 0.7 }], ['#2a4a3a', { roughness: 0.95 }], ['#5a2a3a', { roughness: 0.85 }], ['#7a5236', { roughness: 0.5 }]];
const rgbOf = c => { const k = new THREE.Color(c); return [k.r, k.g, k.b]; };
const PALRGB = PAL.map(([c]) => rgbOf(c));
/** Palette material (opts only honoured when textured). @param {string} c @param {object} [o] */
export function mat(c, o = {}) {
  if (o.map) return kmat(c, o);
  const v = rgbOf(c); let best = 0, bd = 1e9;
  PALRGB.forEach((p, i) => { const d = (p[0] - v[0]) ** 2 + (p[1] - v[1]) ** 2 + (p[2] - v[2]) ** 2; if (d < bd) { bd = d; best = i; } });
  return kmat(PAL[best][0], PAL[best][1]);
}
/** Screen atlas: 4x2 cells of 192x120 holding the terminal/code screens, one material for every screen. */
const CELLS = () => [TX.termScreen(1, '#3ddc84'), TX.termScreen(5, '#3ddc84'), TX.termScreen(9, '#6ee7a0'), TX.codeScreen(3, '#6ee7a0'),
  TX.codeScreen(7, '#b04fd8'), TX.codeScreen(11, '#3ddc84'), TX.termScreen(13, '#6ee7a0'), TX.codeScreen(17, '#3ddc84')];
export function atlasMat() {
  const t = TX.canvasTex('bsmt-atlas', 768, 240, (x) => { CELLS().forEach((c, i) => x.drawImage(c.image, (i % 4) * 192, Math.floor(i / 4) * 120, 192, 120)); });
  return glowMat('#ffffff', 1.5, { map: t });
}
/** Plane showing atlas cell i. */
export function screenPlane(w, h, i) {
  const g = new THREE.PlaneGeometry(w, h); const uv = g.attributes.uv; const u0 = (i % 4) / 4, v0 = 1 - (Math.floor(i / 4) + 1) / 2;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, u0 + uv.getX(k) / 4, v0 + uv.getY(k) / 2);
  return new THREE.Mesh(g, atlasMat());
}
import * as TX from './tex.js';
import * as FX from './kit-fx.js';

const metal = () => mat('#2a2d36', { metalness: 0.6, roughness: 0.45 });
const black = () => mat('#121318', { roughness: 0.6 });

/** Whiteboard canvas: scribbles + a network diagram. */
export function wbTex() {
  return TX.canvasTex('bsmt-wb', 384, 256, (x, w, h) => {
    x.fillStyle = '#d8dccf'; x.fillRect(0, 0, w, h); x.lineWidth = 3; x.font = '27px m5x7';
    const box = (bx, by, t, c) => { x.strokeStyle = c; x.strokeRect(bx, by, 74, 34); x.fillStyle = c; x.fillText(t, bx + 6, by + 23); };
    box(20, 30, 'LAPTOP', '#1f4fa0'); box(150, 30, 'RACK', '#1d7a44'); box(280, 30, 'CLOUD?', '#b02a2a');
    box(150, 120, 'RIG', '#1d7a44'); x.strokeStyle = '#333'; x.beginPath();
    x.moveTo(94, 47); x.lineTo(150, 47); x.moveTo(224, 47); x.lineTo(280, 47); x.moveTo(187, 64); x.lineTo(187, 120); x.stroke();
    x.strokeStyle = '#b02a2a'; x.beginPath(); x.moveTo(275, 30); x.lineTo(360, 66); x.stroke();
    x.fillStyle = '#222'; x.font = '22px m5x7';
    ['THE PLAN:', '1. ship it', '2. ???', '3. uptime 99.9%'].forEach((s, i) => x.fillText(s, 20, 190 + i * 17 - 10));
    x.fillStyle = '#1d7a44'; x.fillText('follow the', 270, 200); x.fillText('white rabbit', 262, 218);
    x.fillStyle = '#b02a2a'; x.fillText('DO NOT reboot', 150, 245);
  });
}

/** Server rack; returns { g, leds:InstancedMesh, n } (LEDs in a front grid). */
export function serverRack(seed = 1) {
  const g = new THREE.Group(); const H = 2.0, W = 0.62, D = 0.7;
  put(g, rbox(W, H, D, black(), 0.03), 0, H / 2, 0);
  for (const sx of [-1, 1]) put(g, rbox(0.03, H - 0.06, 0.03, metal(), 0.008), sx * (W / 2 - 0.05), H / 2, D / 2 + 0.01);
  const r = rng(seed); const units = [];
  let y = 0.12; while (y < H - 0.2) { const uh = r() < 0.3 ? 0.18 : 0.09; units.push([y + uh / 2, uh]); y += uh + 0.025; }
  for (const [uy, uh] of units) { put(g, rbox(W - 0.14, uh, 0.04, mat(r() < 0.5 ? '#23262e' : '#1b1d24', { metalness: 0.5, roughness: 0.5 }), 0.01), 0, uy, D / 2 + 0.01); }
  // detail: rounded side panels, top vent slots, rack ears with screws, handles, a cable comb + patch cables down the side
  const side = mat('#1d2026', { metalness: 0.45, roughness: 0.55 }), ear = metal();
  for (const sx of [-1, 1]) put(g, rbox(0.02, H, D - 0.02, side, 0.008), sx * (W / 2 + 0.005), H / 2, 0);
  for (let k = 0; k < 6; k++) put(g, rbox(W - 0.16, 0.006, 0.03, mat('#0c0d10'), 0.002), 0, H + 0.002, -0.25 + k * 0.1);
  for (const [uy, uh] of units) for (const sx of [-1, 1]) { put(g, rbox(0.012, uh * 0.6, 0.02, ear, 0.004), sx * (W / 2 - 0.09), uy, D / 2 + 0.04);
    if (uh > 0.1) put(g, rbox(0.1, 0.012, 0.012, ear, 0.004), sx * 0.12, uy - uh * 0.3, D / 2 + 0.04); }
  const cols = ['#2a6ad8', '#e8c43a', '#3ddc84', '#d8443a'];
  for (let k = 0; k < 4; k++) { const x = W / 2 - 0.1 - k * 0.012, top = H - 0.3 - r() * 0.6;
    put(g, mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(x - 0.12, top, D / 2 + 0.05), new THREE.Vector3(x, top - 0.1, D / 2 + 0.07), new THREE.Vector3(x + 0.01, 0.3, D / 2 + 0.06), new THREE.Vector3(x, 0.02, D / 2 - 0.1)]), 16, 0.006, 4), mat(cols[k], { roughness: 0.5 })), 0, 0, 0); }
  put(g, rbox(0.012, H - 0.3, 0.008, mat('#103020', { emissive: '#3ddc84', emissiveIntensity: 0.6 }), 0.003), -W / 2 + 0.08, H / 2, D / 2 + 0.03); // status strip
  const n = units.length * 6; const leds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.022, 0.016, 0.01), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), n);
  const m4 = new THREE.Matrix4(); let i = 0;
  for (const [uy] of units) for (let k = 0; k < 6; k++) { m4.makeTranslation(-0.2 + k * 0.035 + (k > 2 ? 0.16 : 0), uy, D / 2 + 0.04); leds.setMatrixAt(i++, m4); }
  leds.userData.live = true; leds.userData.ph = Array.from({ length: n }, () => r()); leds.userData.y = units.flatMap(u => Array(6).fill(u[0]));
  g.add(leds); return { g, leds, n };
}

/** Open-frame mining rig with spinning fans and an RGB strip; returns { g, fans, rgb }. */
export function miningRig() {
  const g = new THREE.Group(); const al = mat('#8a8f9a', { metalness: 0.8, roughness: 0.35 });
  for (const [x, z] of [[-0.45, -0.2], [0.45, -0.2], [-0.45, 0.2], [0.45, 0.2]]) put(g, rbox(0.04, 0.9, 0.04, al, 0.01), x, 0.45, z);
  for (const y of [0.04, 0.5, 0.88]) for (const z of [-0.2, 0.2]) put(g, rbox(0.94, 0.03, 0.04, al, 0.01), 0, y, z);
  put(g, rbox(0.8, 0.03, 0.36, mat('#1a3a24', { roughness: 0.6 }), 0.01), 0, 0.52, 0); // motherboard
  const fanPos = [];
  for (let k = 0; k < 5; k++) {
    const x = -0.36 + k * 0.18; put(g, rbox(0.06, 0.3, 0.34, mat(k % 2 ? '#2b2e38' : '#3a2f44', { metalness: 0.5 }), 0.02), x, 0.7, 0);
    for (const fy of [0.66, 0.8]) fanPos.push(new THREE.Vector3(x + 0.035, fy, 0.08));
  }
  const rgb = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.015, 0.015), new THREE.MeshBasicMaterial({ color: '#ff4fd8', toneMapped: false }));
  rgb.position.set(0, 0.55, 0.22); rgb.userData.live = true; g.add(rgb);
  put(g, rbox(0.3, 0.14, 0.2, metal(), 0.02), -0.2, 0.12, 0); // PSU
  const bg = new THREE.CylinderGeometry(0.075, 0.075, 0.01, 6); bg.rotateZ(Math.PI / 2);
  const fans = new THREE.InstancedMesh(bg, black(), fanPos.length); fans.userData.live = true; fans.userData.pos = fanPos; g.add(fans);
  return { g, fans, rgb };
}

/** Desk with a wall of mismatched monitors + CRT. Returns { g, screens } (screen meshes, for flicker). */
export function monitorWall() {
  const g = new THREE.Group(); const wood = mat('#3a2a22', { roughness: 0.8 });
  put(g, rbox(2.2, 0.06, 0.7, wood, 0.02), 0, 0.74, 0);
  for (const x of [-1.02, 1.02]) put(g, rbox(0.06, 0.72, 0.62, wood, 0.01), x, 0.36, 0);
  const screens = [];
  const mon = (x, y, w, h, tex, ry = 0) => { const m = new THREE.Group(); put(m, rbox(w + 0.06, h + 0.06, 0.05, black(), 0.015), 0, 0, 0);
    const s = screenPlane(w, h, tex); s.position.z = 0.027; m.add(s); screens.push(s); m.position.set(x, y, -0.22); m.rotation.y = ry; g.add(m); };
  put(g, rbox(0.06, 1.2, 0.06, metal(), 0.01), -0.2, 1.3, -0.3); put(g, rbox(1.6, 0.05, 0.05, metal(), 0.01), -0.2, 1.55, -0.28);
  mon(-0.55, 1.15, 0.62, 0.36, 3, 0.12); mon(0.12, 1.12, 0.54, 0.32, 1);
  mon(-0.6, 1.62, 0.5, 0.3, 2, 0.12); mon(0.05, 1.66, 0.4, 0.26, 4);
  // CRT on the right end
  const crt = new THREE.Group(); put(crt, rbox(0.56, 0.48, 0.5, mat('#bdb59c', { roughness: 0.7 }), 0.06), 0, 0, -0.05);
  put(crt, rbox(0.42, 0.34, 0.3, mat('#a9a189'), 0.08), 0, 0.01, -0.3);
  const cs = screenPlane(0.42, 0.34, 0); cs.position.set(0, 0.02, 0.205); crt.add(cs); screens.push(cs);
  crt.position.set(0.8, 1.02, 0); crt.rotation.y = -0.25; g.add(crt);
  put(g, rbox(0.5, 0.025, 0.16, black(), 0.008), -0.2, 0.785, 0.15); // keyboard
  const key = mat('#2a2c34', { roughness: 0.6 }); for (let r = 0; r < 4; r++) for (let c = 0; c < 12; c++) put(g, rbox(0.03, 0.012, 0.028, key, 0.004), -0.42 + c * 0.04, 0.802, 0.1 + r * 0.034);
  put(g, rbox(0.26, 0.004, 0.22, mat('#1a2a3a', { roughness: 1 }), 0.002), 0.28, 0.772, 0.15); // mouse pad + mouse
  const ms = put(g, mesh(new THREE.SphereGeometry(0.035, 10, 6), black()), 0.28, 0.78, 0.15); ms.scale.set(0.8, 0.45, 1.2);
  for (const x of [-0.95, 0.5]) { put(g, rbox(0.12, 0.2, 0.12, black(), 0.02), x, 0.87, -0.2); put(g, mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.01, 12).rotateX(Math.PI / 2), mat('#3a3d44', { metalness: 0.5 })), x, 0.88, -0.138); } // speakers
  put(g, rbox(0.5, 0.6, 0.6, wood, 0.015), 0.7, 0.4, 0); for (const y of [0.2, 0.42, 0.62]) { put(g, rbox(0.46, 0.005, 0.005, mat('#1a120e'), 0.001), 0.7, y + 0.08, 0.301); put(g, rbox(0.1, 0.02, 0.02, metal(), 0.005), 0.7, y, 0.31); } // drawer pedestal
  put(g, rbox(0.22, 0.48, 0.48, black(), 0.02), -0.7, 0.24, -0.02); put(g, rbox(0.012, 0.012, 0.005, glowMat('#3ddc84', 2), 0.003), -0.62, 0.42, 0.22); // tower PC
  put(g, mesh(new THREE.CylinderGeometry(0.04, 0.037, 0.1, 12), mat('#d8d2c4', { roughness: 0.4 })), -0.75, 0.82, 0.2); // mug
  put(g, mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[-0.2, 0.9, -0.33], [-0.25, 0.77, -0.33], [-0.4, 0.5, -0.32], [-0.6, 0.3, -0.25]].map(v => new THREE.Vector3(...v))), 12, 0.025, 6), black()), 0, 0, 0); // cable bundle
  return { g, screens };
}

/** Workbench: soldering iron, breadboard, magnifier lamp, 3D printer. Built along local x, front = +z. */
export function workbench() {
  const g = new THREE.Group(); const wood = mat('#4a3426', { roughness: 0.85 });
  put(g, rbox(2.0, 0.07, 0.75, wood, 0.02), 0, 0.88, 0);
  for (const x of [-0.92, 0.92]) for (const z of [-0.3, 0.3]) put(g, rbox(0.06, 0.86, 0.06, metal(), 0.01), x, 0.43, z);
  put(g, rbox(1.9, 0.03, 0.65, wood, 0.01), 0, 0.25, 0);
  put(g, rbox(2.0, 0.9, 0.04, mat('#5a4a36', { roughness: 0.9 }), 0.01), 0, 1.5, -0.36); // pegboard
  for (let i = 0; i < 6; i++) put(g, rbox(0.03, 0.22, 0.03, mat(['#c23a2a', '#e0b030', '#2a6ac2'][i % 3], { roughness: 0.6 }), 0.01), -0.8 + i * 0.13, 1.55, -0.32);
  // breadboard + wires
  put(g, rbox(0.3, 0.02, 0.12, mat('#e8e4d8'), 0.005), -0.2, 0.93, 0.1);
  for (let i = 0; i < 4; i++) put(g, rbox(0.12, 0.012, 0.01, glowMat('#3ddc84', 2), 0.003), -0.25 + i * 0.04, 0.95, 0.07 + i * 0.02);
  // soldering iron in stand
  put(g, rbox(0.12, 0.04, 0.12, metal(), 0.01), 0.25, 0.94, 0.1);
  const iron = mesh(new THREE.CylinderGeometry(0.015, 0.008, 0.26, 8), mat('#2a6ac2')); iron.rotation.z = 0.9; iron.position.set(0.28, 1.02, 0.1); g.add(iron);
  // magnifier lamp (arm + ring with lens)
  put(g, rbox(0.14, 0.03, 0.14, black(), 0.01), -0.6, 0.93, -0.1);
  const arm = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.55, 6), metal()); arm.rotation.z = -0.5; arm.position.set(-0.47, 1.17, -0.1); g.add(arm);
  const ring = mesh(new THREE.TorusGeometry(0.11, 0.022, 8, 20), mat('#d8d8d0')); ring.rotation.x = -1.1; ring.position.set(-0.32, 1.38, 0.0); g.add(ring);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.1, 20), glowMat('#ffcf8a', 3)); lens.rotation.x = Math.PI / 2 + 0.47; lens.position.set(-0.32, 1.365, 0.0); g.add(lens);
  // 3D printer
  const p = new THREE.Group(); put(p, rbox(0.5, 0.06, 0.45, black(), 0.01), 0, 0.03, 0);
  for (const x of [-0.23, 0.23]) put(p, rbox(0.04, 0.6, 0.04, metal(), 0.01), x, 0.33, -0.15);
  put(p, rbox(0.5, 0.04, 0.04, metal(), 0.01), 0, 0.5, -0.15); put(p, rbox(0.08, 0.08, 0.08, mat('#c23a2a'), 0.01), 0.05, 0.47, -0.1);
  put(p, rbox(0.36, 0.015, 0.34, mat('#3a3a40', { metalness: 0.5 }), 0.004), 0, 0.12, 0);
  const benchy = mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.09, 8), mat('#3ddc84', { roughness: 0.5 })); benchy.position.set(0, 0.17, 0); p.add(benchy);
  const spool = mesh(new THREE.TorusGeometry(0.08, 0.035, 8, 16), mat('#b04fd8')); spool.position.set(-0.3, 0.45, -0.15); p.add(spool);
  p.position.set(0.65, 0.915, -0.05); g.add(p);
  for (let i = 0; i < 3; i++) put(g, rbox(0.06, 0.12, 0.06, mat(i ? '#2d6a3a' : '#1b4fa0', { metalness: 0.5, roughness: 0.4 }), 0.02), -0.9 + i * 0.09, 0.98, 0.25); // cans
  return g;
}

/** Black leather armchair (front +z). */
export function armchair() {
  const g = new THREE.Group(); const lth = mat('#141218', { roughness: 0.35, metalness: 0.1 });
  put(g, rbox(0.95, 0.3, 0.85, lth, 0.08), 0, 0.27, 0); put(g, rbox(0.75, 0.14, 0.7, lth, 0.07), 0, 0.46, 0.05);
  put(g, rbox(0.95, 0.75, 0.2, lth, 0.09), 0, 0.72, -0.33); for (const x of [-0.42, 0.42]) put(g, rbox(0.16, 0.5, 0.82, lth, 0.07), x, 0.48, 0);
  for (const x of [-0.38, 0.38]) for (const z of [-0.33, 0.33]) put(g, rbox(0.06, 0.12, 0.06, mat('#5a4030'), 0.01), x, 0.06, z);
  return g;
}

/** Beat-up couch (front +z, width 2.0). */
export function couch() {
  const g = new THREE.Group(); const f = mat('#4a3a32', { roughness: 0.95 }), c = mat('#5a463a', { roughness: 0.95 });
  put(g, rbox(2.1, 0.3, 0.9, f, 0.08), 0, 0.25, 0); for (const x of [-0.48, 0.48]) put(g, rbox(0.94, 0.14, 0.74, c, 0.07), x, 0.45, 0.06);
  put(g, rbox(2.1, 0.62, 0.22, f, 0.1), 0, 0.7, -0.35); for (const x of [-0.98, 0.98]) put(g, rbox(0.2, 0.58, 0.9, f, 0.09), x, 0.45, 0);
  put(g, rbox(0.38, 0.32, 0.12, mat('#2a4a3a', { roughness: 0.95 }), 0.06), -0.7, 0.66, -0.18); // pillow
  put(g, rbox(0.3, 0.06, 0.2, mat('#7a6a5a'), 0.02), 0.3, 0.83, -0.3); // duct-tape patch
  for (const x of [-0.48, 0.48]) put(g, rbox(0.9, 0.42, 0.14, c, 0.07), x, 0.72, -0.22); // back cushions
  for (const x of [-0.98, 0.98]) { const roll = mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.9, 14), f); roll.rotation.x = Math.PI / 2; put(g, roll, x, 0.74, 0); }
  const btn = mat('#2a201a'); for (const x of [-0.75, -0.25, 0.25, 0.75]) put(g, mesh(new THREE.SphereGeometry(0.016, 6, 4), btn), x, 0.78, -0.145);
  for (const x of [-0.95, 0.95]) for (const z of [-0.35, 0.35]) put(g, mesh(new THREE.CylinderGeometry(0.03, 0.022, 0.1, 8), mat('#2a1a10')), x, 0.05, z);
  const bl = put(g, rbox(0.5, 0.04, 0.7, mat('#7a3a2a', { roughness: 1 }), 0.02), 0.72, 0.54, 0.05); bl.rotation.z = 0.1; // throw blanket
  return g;
}

/** Mini fridge with energy drinks; returns { g, light } (light = interior glow mesh). */
export function fridge() {
  const g = new THREE.Group(); const body = mat('#2b2f36', { metalness: 0.3, roughness: 0.5 });
  put(g, rbox(0.6, 0.9, 0.34, body, 0.04), 0, 0.45, -0.13); for (const [x, y, w, h] of [[-0.27, 0.45, 0.06, 0.9], [0.27, 0.45, 0.06, 0.9], [0, 0.04, 0.6, 0.08], [0, 0.86, 0.6, 0.08]]) put(g, rbox(w, h, 0.3, body, 0.02), x, y, 0.15);
  for (const y of [0.33, 0.64]) put(g, rbox(0.48, 0.015, 0.26, mat('#b8b09a'), 0.005), 0, y - 0.08, 0.17);
  const inner = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.74), glowMat('#cfffe0', 0.5)); inner.position.set(0, 0.47, 0.17); inner.userData.live = true; g.add(inner);
  // glass door: drinks behind
  for (let r = 0; r < 2; r++) for (let k = 0; k < 4; k++) { const can = mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.13, 10), mat(k % 2 ? '#3ddc84' : '#1a1a1a', { metalness: 0.6, roughness: 0.35 })); can.position.set(-0.16 + k * 0.105, 0.22 + r * 0.32, 0.25); g.add(can); }
  put(g, rbox(0.03, 0.3, 0.04, metal(), 0.01), 0.24, 0.55, 0.32);
  put(g, rbox(0.6, 0.02, 0.6, mat('#1a1c20'), 0.01), 0, 0.91, 0);
  return { g, light: inner };
}

/** Small round side table with red/blue pill saucer. */
export function sideTable() {
  const g = new THREE.Group(); const wood = mat('#2e211c', { roughness: 0.7 });
  const top = mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 24), wood); top.position.y = 0.55; g.add(top);
  const leg = mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.53, 10), wood); leg.position.y = 0.27; g.add(leg);
  const base = mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.03, 20), wood); base.position.y = 0.015; g.add(base);
  const sau = mesh(new THREE.CylinderGeometry(0.09, 0.06, 0.015, 20), mat('#e8e2d4', { roughness: 0.3 })); sau.position.set(-0.08, 0.58, 0.05); g.add(sau);
  const pill = new THREE.CapsuleGeometry(0.012, 0.028, 4, 8);
  for (const [c, x] of [['#e02020', -0.11], ['#2050e0', -0.05]]) { const p = mesh(pill, glowMat(c, 1.2)); p.rotation.z = Math.PI / 2; p.position.set(x, 0.6, 0.05); g.add(p); }
  const shades = mesh(new THREE.TorusGeometry(0.035, 0.008, 6, 12), black()); shades.rotation.x = Math.PI / 2; shades.position.set(0.12, 0.575, -0.05); g.add(shades);
  const s2 = shades.clone(); s2.position.x = 0.2; g.add(s2);
  return g;
}

/** Laptop (open) as a static prop. */
export function laptop(tex) {
  const g = new THREE.Group(); put(g, rbox(0.34, 0.02, 0.24, metal(), 0.008), 0, 0.01, 0);
  const lid = new THREE.Group(); put(lid, rbox(0.34, 0.22, 0.015, metal(), 0.006), 0, 0.11, 0);
  const s = screenPlane(0.3, 0.19, tex); s.position.set(0, 0.11, 0.009); lid.add(s);
  lid.position.z = -0.12; lid.rotation.x = -0.25; g.add(lid); return g;
}

/** Beanbag. */
export function beanbag() {
  const geo = new THREE.SphereGeometry(0.5, 20, 12); geo.scale(1, 0.55, 1); geo.translate(0, 0.25, 0);
  const g = new THREE.Group(); g.add(mesh(geo, mat('#3a2a54', { roughness: 0.9 }))); return g;
}

/** Dehumidifier. */
export function dehumidifier() {
  const g = new THREE.Group(); put(g, rbox(0.38, 0.6, 0.28, mat('#c9c6bc', { roughness: 0.6 }), 0.06), 0, 0.3, 0);
  put(g, rbox(0.3, 0.14, 0.02, mat('#8a877e'), 0.01), 0, 0.42, 0.14);
  put(g, rbox(0.04, 0.02, 0.01, glowMat('#3ddc84', 2), 0.005), 0.1, 0.54, 0.145); return g;
}

export { FX };
