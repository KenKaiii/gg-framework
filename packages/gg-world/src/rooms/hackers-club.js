// @ts-check
// Club Cyberdelia centre dressing: light-up dance floor (instanced, pulses with the DJ), overhead cable runs and neon
// tubes, a grind box + rail, flight cases, flyers on the floor, extra graffiti and a third payphone.
import * as THREE from 'three';
import { mat, rbox, put, mesh } from './kit.js';
import { solid1 } from './hackers-solid.js';
import * as TX from './tex.js';
import * as P from './hackers-props.js';

const DX0 = -7.9, DZ0 = -5.4, NX = 6, NZ = 4, TS = 0.8;
export const DANCE = { x0: DX0, z0: DZ0, x1: DX0 + NX * TS, z1: DZ0 + NZ * TS };

/** @param {any} R @param {(o:any,x:number,y:number,z:number,ry?:number,b?:boolean)=>any} st @param {(o:any,x:number,y:number,z:number,ry?:number)=>any} live */
export function addClub(R, st, live) {
  const H = Math.PI / 2;
  // ----- dance floor: frame + instanced glowing tiles
  st(rbox(NX * TS + 0.2, 0.06, NZ * TS + 0.2, P.BLACK, 0.02), DX0 + NX * TS / 2, 0.03, DZ0 + NZ * TS / 2);
  const tiles = new THREE.InstancedMesh(new THREE.BoxGeometry(TS - 0.06, 0.03, TS - 0.06), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), NX * NZ);
  const m = new THREE.Matrix4(); let k = 0;
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) { m.makeTranslation(DX0 + (i + 0.5) * TS, 0.075, DZ0 + (j + 0.5) * TS); tiles.setMatrixAt(k++, m); }
  live(tiles, 0, 0, 0); tiles.castShadow = false;
  const COLS = ['#ff4fd8', '#3ff0ff', '#9dff3d', '#ffcf8a', '#8f6aff'].map(c => new THREE.Color(c)), C = new THREE.Color();
  // ----- overhead: sagging cable runs + neon tubes on hangers
  // short pale cable runs from the back wall to the booth / tubes only (no long dark lines across the view)
  // (thin sagging cable tubes removed: they aliased/crawled while walking)
  const tubes = [['#3ff0ff', -5.5, -4.6, 3.6, 0], ['#ff4fd8', -5.5, -2.4, 3.6, 0], ['#9dff3d', 2.0, -1.5, 3.0, H], ['#ff4fd8', 7.5, 1.6, 3.0, 0], ['#3ff0ff', -2.0, 4.0, 3.0, 0.3]];
  for (const [c, x, z, L, ry] of tubes) { const g = new THREE.Group(); const tb = mesh(new THREE.CylinderGeometry(0.055, 0.055, +L, 10), ({ '#3ff0ff': P.CYAN, '#ff4fd8': P.MAG, '#9dff3d': P.ACID })[String(c)]); tb.rotation.z = H; g.add(tb);
    for (const s of [-1, 1]) put(g, rbox(0.025, 0.5, 0.025, P.METAL, 0.005), s * (+L / 2 - 0.2), 0.25, 0); g.traverse(o => { o.castShadow = false; }); g.userData.noGround = true; st(g, +x, 2.75, +z, +ry); }
  // ----- grind box + rail (centre-south), flyers
  { const g = new THREE.Group(); put(g, rbox(2.2, 0.4, 0.9, mat('#3a5a8a', { roughness: 0.6 }), 0.04), 0, 0.2, 0);
    for (const s of [-1, 1]) {
      const w = new THREE.Shape(); w.moveTo(0, 0); w.lineTo(0.8 * s, 0); w.lineTo(0, 0.4); const e = mesh(new THREE.ExtrudeGeometry(w, { depth: 0.9, bevelEnabled: false }), mat('#5a6a9a', { roughness: 0.6 })); /* no negative scale: it flipped the winding (inside-out dark wedge) */ put(g, e, s * 1.1, 0, -0.45); }
    put(g, rbox(2.2, 0.04, 0.05, P.ACID, 0.01), 0, 0.42, 0.46); g.userData.ground = { k: 1.3, pad: 0.15 };
    live(solid1((g)), -3.6, 0, 2.2); R.blockObj(g); R.grindBox = g; }
  { const g = new THREE.Group(); put(g, mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.6, 10).rotateZ(H), P.METAL), 0, 0.42, 0);
    for (const s of [-1.1, 1.1]) put(g, rbox(0.06, 0.42, 0.3, P.METAL, 0.01), s, 0.21, 0); st(g, 0.6, 0, -2.6, 0.5, true); }
  const fly = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.21, 0.3).rotateX(-H), new THREE.MeshBasicMaterial({ map: flyerTex(), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), 14);
  { const r = TX.rand(77), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3(), cc = ['#ff9ff0', '#9ff6ff', '#d0ff9f', '#ffe39f'];
    for (let i = 0; i < 14; i++) { e.set(0, r() * 6.28, 0); q.setFromEuler(e); m.compose(v.set(-9 + r() * 17, 0.012 + i * 0.0015, -2 + r() * 8), q, s); fly.setMatrixAt(i, m); fly.setColorAt(i, C.set(cc[i % 4])); } }
  st(fly, 0, 0, 0);
  // ----- flight cases (stacked by the booth and bar)
  const caseM = P.DARK, edge = P.METAL;
  const fcase = (w, h, d) => { const g = new THREE.Group(); put(g, rbox(w, h, d, caseM, 0.03), 0, h / 2, 0); for (const y of [0.02, h - 0.02]) put(g, rbox(w + 0.02, 0.03, d + 0.02, edge, 0.01), 0, y, 0); put(g, rbox(0.2, 0.05, 0.02, edge, 0.01), 0, h * 0.6, d / 2 + 0.01); return g; };
  st(fcase(0.9, 0.6, 0.6), -2.4, 0, -6.3, 0, true); st(fcase(0.7, 0.5, 0.5), -2.4, 0.6, -6.3, 0.2); st(fcase(0.8, 0.55, 0.55), -9.4, 0, -6.2, 0.1, true);
  st(fcase(0.9, 0.6, 0.6), 10.2, 0, 6.2, 0, true); st(fcase(0.6, 0.45, 0.5), 10.2, 0.6, 6.2, -0.3);
  // ----- extra graffiti + third payphone on the east wall (e wall drawn by us)
  R.onWall('w', new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.45), new THREE.MeshBasicMaterial({ map: P.graffiti('PHREAK', '#3ff0ff', '#9dff3d', 512, 160), transparent: true, depthWrite: false, toneMapped: false })), -0.5, 2.15, 0.03);
  R.onWall('w', P.payphone(), -1.55, 1.35, 0.1);
  /** @param {number} t @param {number} boost */
  return (t, boost) => {
    // slow smooth wave across the tiles (period ~2.4 s, faster when the decks are spun); fixed colour per tile
    const ph = t * 2.6 * (0.8 + 0.2 * boost);
    for (let i = 0; i < NX * NZ; i++) { const a = i % NX, b = Math.floor(i / NX), s = 0.5 + 0.5 * Math.sin(ph - (a + b) * 0.9), k = s * s * (3 - 2 * s);
      C.copy(COLS[(a + b * 2) % COLS.length]).multiplyScalar(0.3 + 1.0 * k); tiles.setColorAt(i, C); }
    if (tiles.instanceColor) tiles.instanceColor.needsUpdate = true;
  };
}

function flyerTex() {
  return TX.canvasTex('cyb-flyer', 42, 60, x => { x.fillStyle = '#f0f0f0'; x.fillRect(0, 0, 42, 60); x.fillStyle = '#1a1024'; x.fillRect(3, 3, 36, 30); x.fillStyle = '#ff4fd8'; x.fillRect(6, 8, 30, 4); x.fillStyle = '#3ff0ff'; x.fillRect(6, 16, 22, 3); x.fillRect(6, 23, 26, 3); x.fillStyle = '#333'; for (let i = 0; i < 5; i++) x.fillRect(4, 38 + i * 4, 20 + (i * 7) % 14, 2); });
}
