// @ts-check
// The Overlook Hall props: hex carpet, cream wainscot partitions with numbered doors, sconces, Jack's typewriter desk,
// the hedge-maze model, the Big Wheel trike and the lounge armchairs. Floor at y=0, local origin.
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh, rng } from './kit.js';
import * as TX from './tex.js';

const cyl = (rt, rb, h, m, seg = 16) => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
export const CREAM = mat('#a08c6a', { roughness: 0.85 }), WAIN = mat('#4a2e22', { roughness: 0.6 }), TRIM = mat('#2e1c16', { roughness: 0.55 });
export const DOOR = mat('#5e3a26', { roughness: 0.55 }), BRASS = mat('#b08a4a', { metalness: 0.8, roughness: 0.3 });
const DARK = mat('#141016', { roughness: 0.6 }), PAPER = mat('#d8cfb8', { roughness: 0.9 });

/** The famous hotel carpet: orange ground, interlocking brown hexes with red cores (tiles seamlessly). */
export function hexCarpet() {
  return TX.canvasTex('overlook-hex', 256, 222, (x, w, h) => {
    x.fillStyle = '#b8561e'; x.fillRect(0, 0, w, h);
    const r = 37, hw = Math.sqrt(3) * r;
    const hex = (cx, cy, rr) => { x.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; x.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } x.closePath(); };
    for (let row = -1; row <= 4; row++) for (let col = -1; col <= 4; col++) {
      const cx = col * w / 4 + (row % 2 ? hw / 2 : 0), cy = row * h / 4;
      hex(cx, cy, r * 0.94); x.fillStyle = '#5a2a16'; x.fill();
      hex(cx, cy, r * 0.74); x.fillStyle = '#d27a2a'; x.fill();
      hex(cx, cy, r * 0.56); x.fillStyle = '#5a2a16'; x.fill();
      hex(cx, cy, r * 0.36); x.fillStyle = '#8e1f16'; x.fill();
    }
    const g = TX.rand(9); for (let i = 0; i < 2500; i++) { x.fillStyle = `rgba(0,0,0,${0.12 * g()})`; x.fillRect(g() * w, g() * h, 1.5, 1.5); }
  }, { repeat: true });
}

/** Wall sconce: brass backplate, arm, cream fabric shade (bulb glow is added live by the room). */
export function sconce() {
  const g = new THREE.Group();
  put(g, rbox(0.1, 0.18, 0.03, BRASS, 0.01), 0, 0, 0.015);
  const arm = cyl(0.012, 0.012, 0.16, BRASS, 6); arm.rotation.x = Math.PI / 2; put(g, arm, 0, 0.02, 0.09);
  put(g, cyl(0.07, 0.1, 0.14, glowMat('#ffcf8a', 1.1), 14), 0, 0.12, 0.16);
  return g;
}

/** Number plaque texture. */
const plaque = (n, fg = '#e8c87a') => new THREE.MeshBasicMaterial({ map: TX.label(n, fg, '#2a1a12', 128, 64, '60px m5x7') });

/** Panelled hotel door (local: z=0 is the door face plane, width 1.0, height 2.15). opts.split = axe hole. */
export function door(num, o = {}) {
  const g = new THREE.Group();
  for (const [x, y, w, h] of [[-0.56, 1.1, 0.1, 2.25], [0.56, 1.1, 0.1, 2.25], [0, 2.26, 1.22, 0.12]]) put(g, rbox(w, h, 0.08, TRIM, 0.015), x, y, 0.02);
  const slab = put(g, rbox(1.0, 2.15, 0.06, o.mat || DOOR, 0.01), 0, 1.075, -0.01);
  for (const [y, hh] of [[0.55, 0.7], [1.55, 0.8]]) for (const x of [-0.22, 0.22]) put(g, rbox(0.32, hh, 0.02, TRIM, 0.01), x, y, 0.025);
  void slab;
  if (!o.noKnob) { put(g, new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), BRASS), 0.38, 1.0, 0.07); put(g, rbox(0.05, 0.14, 0.012, BRASS, 0.005), 0.38, 1.0, 0.035); }
  if (num) put(g, new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.13), plaque(num)), 0, 1.78, 0.04);
  if (o.split) { // splintered hole in the upper-left panel
    const hole = new THREE.Shape(); const r = rng(7); const pts = 11;
    for (let i = 0; i < pts; i++) { const a = i / pts * Math.PI * 2, rr = 0.14 + r() * 0.1 * (i % 2 ? 1 : 0.4); i ? hole.lineTo(Math.cos(a) * rr * 0.8, Math.sin(a) * rr * 1.3) : hole.moveTo(Math.cos(a) * rr * 0.8, Math.sin(a) * rr * 1.3); }
    put(g, new THREE.Mesh(new THREE.ShapeGeometry(hole), new THREE.MeshBasicMaterial({ color: '#07050a' })), -0.2, 1.5, 0.04);
    for (let i = 0; i < 6; i++) { const s = rbox(0.025, 0.1 + r() * 0.08, 0.02, mat('#8a6a4a'), 0.005); s.rotation.z = (i / 6) * Math.PI * 2; put(g, s, -0.2 + Math.cos(i) * 0.16, 1.5 + Math.sin(i) * 0.22, 0.06); }
  }
  return g;
}

/** Free-standing corridor partition: cream upper, dark wainscot + chair rail, len along x, face at +z. */
export function partition(len, h = 2.7) {
  const g = new THREE.Group();
  put(g, rbox(len, h, 0.14, CREAM, 0.01), 0, h / 2, 0);
  put(g, rbox(len, 0.95, 0.03, WAIN, 0.01), 0, 0.5, 0.08);
  for (let x = -len / 2 + 0.35; x < len / 2 - 0.2; x += 0.7) put(g, rbox(0.5, 0.6, 0.015, TRIM, 0.01), x, 0.5, 0.1);
  put(g, rbox(len, 0.06, 0.06, TRIM, 0.01), 0, 1.0, 0.09); put(g, rbox(len, 0.12, 0.05, TRIM, 0.01), 0, 0.06, 0.09);
  put(g, rbox(len + 0.04, 0.1, 0.2, TRIM, 0.02), 0, h, 0);
  return g;
}

/** Jack's desk with the typewriter, a page stack, an ashtray and a lamp. */
export function typewriterDesk() {
  const g = new THREE.Group(); const W = mat('#3e2618', { roughness: 0.55 });
  put(g, rbox(1.5, 0.06, 0.8, W, 0.02), 0, 0.76, 0);
  for (const [x, z] of [[-0.68, -0.33], [0.68, -0.33], [-0.68, 0.33], [0.68, 0.33]]) put(g, rbox(0.06, 0.74, 0.06, W, 0.015), x, 0.37, z);
  put(g, rbox(1.4, 0.12, 0.04, W, 0.01), 0, 0.68, -0.36);
  // typewriter
  const tw = new THREE.Group(); put(g, tw, 0.05, 0.79, 0.05);
  put(tw, rbox(0.46, 0.12, 0.34, DARK, 0.04), 0, 0.06, 0);
  put(tw, rbox(0.4, 0.06, 0.14, DARK, 0.03), 0, 0.15, -0.08);
  const plat = cyl(0.035, 0.035, 0.52, mat('#222', { roughness: 0.4 }), 12); plat.rotation.z = Math.PI / 2; put(tw, plat, 0, 0.2, -0.1);
  for (const s of [-1, 1]) put(tw, new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), BRASS), s * 0.28, 0.2, -0.1);
  const sheet = put(tw, mesh(new THREE.PlaneGeometry(0.22, 0.28), mat('#e4dcc4', { side: THREE.DoubleSide })), 0, 0.33, -0.12); sheet.rotation.x = -0.25;
  const keys = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.012, 0.012, 0.01, 8), mat('#d8d0b8'), 33); let k = 0; const m4 = new THREE.Matrix4();
  for (let row = 0; row < 3; row++) for (let i = 0; i < 11; i++) { m4.makeTranslation(-0.17 + i * 0.034 + row * 0.01, 0.125 + row * 0.012, 0.13 - row * 0.035); keys.setMatrixAt(k++, m4); }
  tw.add(keys);
  // page stack, loose pages, ashtray, coffee
  for (let i = 0; i < 8; i++) put(g, rbox(0.22, 0.012, 0.29, PAPER, 0.002), -0.48 + (i % 3) * 0.004, 0.8 + i * 0.012, -0.05, (i % 4) * 0.03);
  put(g, mesh(new THREE.PlaneGeometry(0.22, 0.29), PAPER), 0.5, 0.795, 0.12, 0.4).rotation.x = -Math.PI / 2;
  put(g, cyl(0.06, 0.05, 0.03, mat('#5a6a6a', { metalness: 0.5, roughness: 0.3 }), 14), 0.55, 0.8, -0.22);
  put(g, cyl(0.04, 0.035, 0.09, mat('#ece4d0'), 12), 0.38, 0.835, -0.25);
  // banker's lamp (green shade)
  put(g, cyl(0.07, 0.08, 0.03, BRASS, 14), -0.6, 0.805, -0.25); put(g, cyl(0.01, 0.01, 0.3, BRASS, 6), -0.6, 0.95, -0.25);
  const sh = cyl(0.03, 0.1, 0.09, mat('#1f5a3a', { roughness: 0.3, metalness: 0.2 }), 14); put(g, sh, -0.6, 1.1, -0.2);
  put(g, cyl(0.06, 0.09, 0.005, glowMat('#ffcf8a', 2.2), 14), -0.6, 1.052, -0.2);
  return g;
}

/** Hedge maze scale model on a table (seeded backtracker maze). */
export function mazeTable() {
  const g = new THREE.Group(); const W = mat('#3a2418', { roughness: 0.6 });
  put(g, rbox(1.9, 0.06, 1.1, W, 0.02), 0, 0.82, 0);
  for (const [x, z] of [[-0.85, -0.45], [0.85, -0.45], [-0.85, 0.45], [0.85, 0.45]]) put(g, cyl(0.035, 0.03, 0.8, W, 8), x, 0.4, z);
  put(g, rbox(1.7, 0.05, 0.92, mat('#4a5a34', { roughness: 0.95 }), 0.01), 0, 0.875, 0);
  const C = 9, Rw = 5, cs = 0.17, hedge = mat('#2a4a24', { roughness: 1 }); const r = rng(237);
  const vis = new Set(), wallsH = new Set(), wallsV = new Set();
  for (let i = 0; i <= C; i++) for (let j = 0; j < Rw; j++) wallsV.add(i + ',' + j);
  for (let i = 0; i < C; i++) for (let j = 0; j <= Rw; j++) wallsH.add(i + ',' + j);
  const st = [[0, 0]]; vis.add('0,0');
  while (st.length) { const [i, j] = st[st.length - 1]; const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([a, b]) => i + a >= 0 && i + a < C && j + b >= 0 && j + b < Rw && !vis.has((i + a) + ',' + (j + b)));
    if (!n.length) { st.pop(); continue; } const [a, b] = n[Math.floor(r() * n.length)];
    if (a) wallsV.delete(Math.max(i, i + a) + ',' + j); else wallsH.delete(i + ',' + Math.max(j, j + b));
    vis.add((i + a) + ',' + (j + b)); st.push([i + a, j + b]); }
  wallsV.delete('0,2'); wallsV.delete(C + ',2');
  const ox = -C * cs / 2, oz = -Rw * cs / 2, hh = 0.07, y = 0.9 + hh / 2;
  for (const k of wallsV) { const [i, j] = k.split(',').map(Number); put(g, rbox(0.028, hh, cs + 0.028, hedge, 0.01), ox + i * cs, y, oz + (j + 0.5) * cs); }
  for (const k of wallsH) { const [i, j] = k.split(',').map(Number); put(g, rbox(cs + 0.028, hh, 0.028, hedge, 0.01), ox + (i + 0.5) * cs, y, oz + j * cs); }
  put(g, rbox(0.14, 0.004, 0.14, mat('#9a8a6a'), 0.002), 0, 0.902, 0);
  return g;
}

/** Big Wheel trike (live; built facing +x). */
export function bigWheel() {
  const g = new THREE.Group(); const red = mat('#b8261c', { roughness: 0.4 }), yel = mat('#e0a82a', { roughness: 0.45 }), blk = mat('#151515', { roughness: 0.7 });
  const fw = new THREE.Group(); put(g, fw, 0.42, 0.26, 0);
  const tire = mesh(new THREE.TorusGeometry(0.22, 0.045, 8, 22), blk); fw.add(tire);
  const hub = cyl(0.17, 0.17, 0.07, yel, 18); hub.rotation.x = Math.PI / 2; fw.add(hub);
  for (const s of [-1, 1]) { const ped = rbox(0.12, 0.03, 0.05, blk, 0.01); ped.position.set(0, 0, s * 0.1); fw.add(ped); }
  put(g, rbox(0.5, 0.08, 0.16, red, 0.04), 0.06, 0.22, 0).rotation.z = -0.35;
  put(g, rbox(0.28, 0.06, 0.24, yel, 0.03), -0.12, 0.2, 0);
  put(g, rbox(0.06, 0.24, 0.24, yel, 0.03), -0.25, 0.32, 0);
  const fork = rbox(0.05, 0.36, 0.05, red, 0.02); fork.rotation.z = 0.35; put(g, fork, 0.36, 0.45, 0);
  const bar = cyl(0.018, 0.018, 0.44, blk, 8); bar.rotation.x = Math.PI / 2; put(g, bar, 0.3, 0.63, 0);
  const bws = []; for (const s of [-1, 1]) { const w = mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.05, 14), blk); w.rotation.x = Math.PI / 2; put(g, w, -0.28, 0.09, s * 0.2); bws.push(w); }
  const axle = cyl(0.012, 0.012, 0.42, blk, 6); axle.rotation.x = Math.PI / 2; put(g, axle, -0.28, 0.09, 0);
  g.userData.front = fw; g.userData.back = bws;
  return g;
}

/** Wingback armchair (faces +z). */
export function armchair(color, leather = false) {
  const g = new THREE.Group(); const m = mat(color, { roughness: leather ? 0.35 : 0.9, metalness: leather ? 0.1 : 0 });
  for (const [x, z] of [[-0.3, -0.28], [0.3, -0.28], [-0.3, 0.28], [0.3, 0.28]]) put(g, cyl(0.025, 0.02, 0.14, TRIM, 6), x, 0.07, z);
  put(g, rbox(0.76, 0.2, 0.72, m, 0.06), 0, 0.24, 0); put(g, rbox(0.6, 0.1, 0.56, m, 0.05), 0, 0.38, 0.05);
  put(g, rbox(0.76, 0.75, 0.16, m, 0.07), 0, 0.6, -0.3);
  for (const s of [-1, 1]) { put(g, rbox(0.12, 0.28, 0.66, m, 0.05), s * 0.33, 0.45, 0.02); put(g, rbox(0.16, 0.4, 0.2, m, 0.06), s * 0.32, 0.78, -0.24); }
  return g;
}

/** Low round coffee table + standing lamp with a pleated shade. */
export function coffeeTable() {
  const g = new THREE.Group(); const W = mat('#3a2418', { roughness: 0.5 });
  put(g, cyl(0.45, 0.45, 0.05, W, 24), 0, 0.42, 0); put(g, cyl(0.06, 0.08, 0.4, W, 10), 0, 0.2, 0); put(g, cyl(0.25, 0.28, 0.03, W, 18), 0, 0.015, 0);
  return g;
}
export function floorLamp() {
  const g = new THREE.Group();
  put(g, cyl(0.16, 0.18, 0.04, BRASS, 16), 0, 0.02, 0); put(g, cyl(0.015, 0.015, 1.5, BRASS, 6), 0, 0.77, 0);
  put(g, cyl(0.16, 0.26, 0.3, glowMat('#ffb36b', 0.6), 16, ), 0, 1.6, 0);
  return g;
}
