// @ts-check
// Limbo props (part 2): the city that folds up over itself, the Limbo coast with a sandcastle, the drafting table.
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh, rng } from './kit.js';
import * as TX from './tex.js';
import { cyl, WOOD, BRASS, CREAM } from './inception-props.js';

const winTex = () => TX.canvasTex('limbo-windows', 64, 128, (x, w, h) => {
  x.fillStyle = '#8a8698'; x.fillRect(0, 0, w, h); const g = TX.rand(5);
  for (let r = 0; r < 16; r++) for (let c = 0; c < 4; c++) { x.fillStyle = g() < 0.4 ? '#ffd9a0' : '#4a4a5e'; x.fillRect(4 + c * 15, 4 + r * 8, 9, 5); }
});

/**
 * A strip of city that starts on the floor and curls up the wall and over the top (arc radius rad, along x for width).
 * Buildings are one InstancedMesh. Returns { group, inst } (group is static-safe; ground strips are rbox).
 */
export function foldCity(width = 7, rad = 1.6) {
  const g = new THREE.Group(), r = rng(77), ground = mat('#6e6a80', { roughness: 0.8 });
  const steps = 18, A = Math.PI * 1.05, pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * A, y = rad - rad * Math.cos(a), z = -rad * Math.sin(a);
    const strip = rbox(width, 0.04, rad * A / steps + 0.02, ground, 0.0); strip.position.set(0, y, z); strip.rotation.x = a; g.add(strip);
    for (let k = 0; k < 7; k++) pts.push({ a, y, z, x: -width / 2 + 0.35 + r() * (width - 0.7), h: 0.15 + r() * 0.55, s: 0.18 + r() * 0.16 });
  }
  const bm = new THREE.MeshStandardMaterial({ map: winTex(), emissive: '#ffffff', emissiveMap: winTex(), emissiveIntensity: 0.35, roughness: 0.7 });
  const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), bm, pts.length);
  const o = new THREE.Object3D();
  pts.forEach((p, i) => { const up = new THREE.Vector3(0, Math.cos(p.a), -Math.sin(p.a)).multiplyScalar(-1);
    // inward normal of the arc (towards its centre)
    const n = new THREE.Vector3(0, rad - p.y, -p.z).normalize(); void up;
    o.position.set(p.x, p.y + n.y * p.h / 2, p.z + n.z * p.h / 2); o.rotation.set(p.a, 0, 0); o.scale.set(p.s, p.h, p.s); o.updateMatrix(); inst.setMatrixAt(i, o.matrix); });
  inst.castShadow = false; g.add(inst);
  return { group: g, inst };
}

/** Limbo coast: sand patch, shallow lit water strip, a crumbling sandcastle, driftwood. */
export function coast() {
  const g = new THREE.Group();
  const sand = mesh(new THREE.CircleGeometry(3.2, 32), mat('#e0caa0', { roughness: 0.95 })); sand.rotation.x = -Math.PI / 2; sand.scale.set(1.25, 1, 1); put(g, sand, 0, 0.012, 0); sand.castShadow = false;
  const sm = mat('#d4b888', { roughness: 0.95 });
  put(g, rbox(0.9, 0.3, 0.9, sm, 0.04), 0.4, 0.15, -0.2);
  for (const [x, z] of [[-0.05, -0.65], [0.85, -0.65], [-0.05, 0.25], [0.85, 0.25]]) { put(g, cyl(0.14, 0.17, 0.55, sm, 10), x, 0.28, z); put(g, mesh(new THREE.ConeGeometry(0.17, 0.25, 10), sm), x, 0.67, z); }
  put(g, cyl(0.2, 0.26, 0.5, sm, 12), 0.4, 0.55, -0.2); put(g, mesh(new THREE.ConeGeometry(0.24, 0.34, 12), sm), 0.4, 0.97, -0.2);
  put(g, rbox(0.08, 0.3, 0.03, mat('#b04a3a'), 0.01), 0.4, 1.25, -0.2); // tiny flag
  put(g, cyl(0.06, 0.08, 1.4, mat('#8a7458'), 7), -1.6, 0.06, 1.0, 0.6).rotation.z = Math.PI / 2;
  put(g, rbox(0.4, 0.3, 0.3, mat('#b08048'), 0.06), -1.2, 0.15, -1.0); // bucket
  return g;
}

/** Drafting table: tilted board with a blueprint maze, stool beside it. */
export function draftTable() {
  const g = new THREE.Group();
  for (const s of [-1, 1]) put(g, rbox(0.06, 0.9, 0.06, BRASS, 0.02), s * 0.6, 0.45, 0);
  const bp = TX.canvasTex('limbo-blueprint', 128, 96, (x, w, h) => {
    x.fillStyle = '#2a4a8a'; x.fillRect(0, 0, w, h); x.strokeStyle = '#cfe0ff'; x.lineWidth = 2;
    for (let i = 1; i < 6; i++) { x.beginPath(); x.arc(w / 2, h / 2, i * 8, i * 0.9, i * 0.9 + 5.2); x.stroke(); }
    x.strokeStyle = 'rgba(207,224,255,0.3)'; x.lineWidth = 1; for (let i = 0; i < w; i += 8) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, h); x.stroke(); }
  });
  const board = new THREE.Group(); put(board, rbox(1.4, 0.04, 1.0, WOOD, 0.02), 0, 0, 0);
  const paper = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.85), new THREE.MeshStandardMaterial({ map: bp, emissive: '#ffffff', emissiveMap: bp, emissiveIntensity: 0.45 }));
  paper.rotation.x = -Math.PI / 2; put(board, paper, 0, 0.025, 0); board.rotation.x = 0.45; put(g, board, 0, 0.98, 0);
  put(g, rbox(0.04, 0.04, 0.9, CREAM, 0.01), 0, 0.9, 0.45);
  const lamp = new THREE.Group(); put(lamp, cyl(0.01, 0.01, 0.6, BRASS, 6), 0, 0.3, 0); put(lamp, cyl(0.04, 0.12, 0.12, glowMat('#ffd9a0', 1.2), 12), 0, 0.62, 0.05);
  put(g, lamp, 0.62, 0.9, -0.3);
  return g;
}
