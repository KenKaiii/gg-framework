// @ts-check
// Paper Street basement life: water heater with pipes, an old washing machine, oil drums, a tyre stack and a floor
// strip of rags, stains and dropped soap. Floor y=0, local origin; reuse shared materials to keep draw calls low.
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh } from './kit.js';
import * as TX from './tex.js';
import { METAL, DWOOD } from './fightclub-props.js';

const cyl = (rt, rb, h, m, seg = 18) => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
const TANK = mat('#c8c0a8', { roughness: 0.55 }), COPPER = mat('#b8743a', { metalness: 0.7, roughness: 0.35 }), RUST = mat('#9a4a2a', { roughness: 0.8 });
const DRUM = mat('#3a6a8a', { roughness: 0.6 }), TYRE = mat('#2a2628', { roughness: 0.9 });

/** Tall water heater with copper pipes running up into the ceiling and a little pilot glow. */
export function boiler() {
  const g = new THREE.Group();
  put(g, cyl(0.38, 0.38, 1.6, TANK), 0, 0.85, 0);
  put(g, cyl(0.39, 0.39, 0.06, METAL), 0, 1.66, 0); put(g, cyl(0.39, 0.39, 0.1, METAL), 0, 0.05, 0);
  put(g, cyl(0.1, 0.14, 0.3, METAL, 10), 0, 1.84, 0);
  for (const [x, z] of [[-0.14, 0.12], [0.14, 0.12]]) { put(g, cyl(0.035, 0.035, 1.6, COPPER, 8), x, 2.4, z); }
  const run = cyl(0.035, 0.035, 0.8, COPPER, 8); run.rotation.x = Math.PI / 2; put(g, run, -0.14, 3.16, 0.5);
  put(g, rbox(0.18, 0.14, 0.04, mat('#3a3434'), 0.01), 0, 0.35, 0.38);
  put(g, rbox(0.05, 0.03, 0.02, glowMat('#4fa8ff', 2), 0.005), 0, 0.33, 0.405);
  put(g, rbox(0.2, 0.06, 0.06, RUST, 0.02), 0.2, 1.2, 0.36);
  return g;
}
/** Old top-loader washing machine with a porthole of murky water. */
export function washer() {
  const g = new THREE.Group();
  put(g, rbox(0.7, 0.9, 0.65, TANK, 0.06), 0, 0.45, 0);
  put(g, rbox(0.7, 0.14, 0.06, METAL, 0.02), 0, 0.97, -0.3);
  const ring = mesh(new THREE.TorusGeometry(0.2, 0.035, 8, 20), METAL); put(g, ring, 0, 0.5, 0.33);
  put(g, mesh(new THREE.CircleGeometry(0.19, 20), mat('#5a7a8a', { roughness: 0.1, metalness: 0.3 })), 0, 0.5, 0.33);
  put(g, rbox(0.4, 0.04, 0.3, mat('#8a9a6a', { roughness: 1 }), 0.02), 0.05, 0.92, 0.05); // folded rag on top
  return g;
}
export function drum(tipped = false) {
  const g = new THREE.Group(); const d = new THREE.Group();
  put(d, cyl(0.3, 0.3, 0.88, DRUM), 0, 0.44, 0);
  for (const y of [0.22, 0.66]) put(d, cyl(0.31, 0.31, 0.04, METAL), 0, y, 0);
  put(d, cyl(0.3, 0.3, 0.02, RUST), 0, 0.885, 0);
  if (tipped) { d.rotation.z = Math.PI / 2; d.position.set(0.44, 0.3, 0); }
  g.add(d); return g;
}
export function tyres(n = 4) {
  const g = new THREE.Group(); const geo = new THREE.TorusGeometry(0.3, 0.12, 8, 18);
  for (let i = 0; i < n; i++) { const t = mesh(geo, TYRE); t.rotation.x = Math.PI / 2; t.rotation.z = i * 0.7; put(g, t, (i % 2) * 0.05, 0.12 + i * 0.22, 0); }
  const lean = mesh(geo, TYRE); lean.rotation.set(0.25, 0.4, 0); put(g, lean, 0.62, 0.42, 0.1);
  put(g, rbox(0.9, 0.08, 0.5, DWOOD, 0.02), 1.2, 0.04, 0.0); // car door panel on the floor
  return g;
}
/** Floor decal: oil stains, scattered rags and a soap-scum trail. */
export function grime(w = 4, d = 2.4) {
  const tex = TX.canvasTex('fc-grime', 256, 160, (x, W, H) => {
    x.clearRect(0, 0, W, H); const g = TX.rand(77);
    for (let i = 0; i < 6; i++) { const r = 10 + g() * 22, cx = g() * W, cy = g() * H; const gr = x.createRadialGradient(cx, cy, 1, cx, cy, r); gr.addColorStop(0, 'rgba(40,30,22,0.5)'); gr.addColorStop(1, 'rgba(40,30,22,0)'); x.fillStyle = gr; x.fillRect(cx - r, cy - r, 2 * r, 2 * r); }
    for (let i = 0; i < 5; i++) { x.save(); x.translate(20 + g() * (W - 40), 20 + g() * (H - 40)); x.rotate(g() * 3); x.fillStyle = ['#c8b890', '#8a9a6a', '#a05a4a'][i % 3]; x.fillRect(-14, -8, 28, 16); x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(-14, 4, 28, 4); x.restore(); }
    for (let i = 0; i < 20; i++) { x.fillStyle = 'rgba(242,166,192,0.45)'; x.beginPath(); x.arc(30 + i * 10 + g() * 6, 120 + Math.sin(i) * 12, 3 + g() * 3, 0, 7); x.fill(); }
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.9 }));
  m.rotation.x = -Math.PI / 2; return m;
}
