// @ts-check
// Extra MMO-inn flavour: candle chandelier, two rugs, a bard stage with a lute, a free-standing trophy plaque.
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh } from './kit.js';
import { solid1 } from './hackers-solid.js';
import * as FX from './kit-fx.js';
import * as TX from './tex.js';
import { WOOD, WOOD_D, WOOD_L, IRON, GOLD, cyl } from './tavern-props.js';

/** @param {any} R @param {(o:any,x:number,y:number,z:number,ry?:number,b?:boolean)=>any} st @param {(o:any,x:number,y:number,z:number,ry?:number)=>any} live */
export function addFlavour(R, st, live) {
  // rugs (one material each, flat, no shadow)
  const rug = (tex, x, z, w, d) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat('#ffffff', { map: tex, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 })); m.rotation.x = -Math.PI / 2; m.userData.noGround = true; m.receiveShadow = true; st(m, x, 0.008, z); };
  rug(TX.rug('persian', '#8a2a22', '#d8a43a', '#e8d6a8', 11), -1, -5.3, 4.2, 2.4);
  rug(TX.rug('stripes', '#2e4a8a', '#c8902a', '#e8d6a8', 12), -7.5, 0.1, 3.4, 2.0);
  // chandelier: wagon-wheel ring with candles, hanging on chains (sways live)
  const ch = new THREE.Group();
  const ring = mesh(new THREE.TorusGeometry(0.75, 0.06, 6, 20), WOOD_D); ring.rotation.x = Math.PI / 2; put(ch, ring, 0, 0, 0);
  for (let i = 0; i < 3; i++) { const sp = rbox(1.5, 0.05, 0.06, WOOD_D, 0.02); put(ch, sp, 0, 0, 0, i * Math.PI / 3); }
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2, c = cyl(0.022, 0.022, 1.6, IRON, 6); c.rotation.set(Math.cos(a) * 0.4, 0, Math.sin(a) * 0.4); put(ch, c, Math.sin(a) * 0.38, 0.75, Math.cos(a) * 0.38); }
  for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, x = Math.sin(a) * 0.75, z = Math.cos(a) * 0.75;
    put(ch, cyl(0.04, 0.04, 0.16, mat('#f0e6c8'), 6), x, 0.12, z); put(ch, mesh(new THREE.SphereGeometry(0.035, 6, 4), glowMat('#ffb050', 3)), x, 0.24, z); }
  st(ch, 1.2, 3.1, 3.0);
  live(FX.glow('#ffc070', 2.6, 0.45), 1.2, 3.3, 3.0);
  // bard stage + lute on a stand + stool
  st(rbox(3.2, 0.3, 1.5, WOOD, 0.05), -7.5, 0.15, 7.9, 0, true);
  for (let i = 0; i < 6; i++) st(rbox(0.03, 0.02, 1.45, WOOD_D, 0.01), -8.9 + i * 0.55, 0.31, 7.9);
  st(rbox(3.3, 0.08, 0.1, GOLD, 0.03), -7.5, 0.28, 7.15);
  const lute = new THREE.Group(); const body = mesh(new THREE.SphereGeometry(0.22, 12, 8), WOOD_L); body.scale.set(1, 1.25, 0.45); put(lute, body, 0, 0.3, 0);
  put(lute, mesh(new THREE.CircleGeometry(0.06, 10), mat('#2a1a10')), 0, 0.36, 0.108); put(lute, rbox(0.07, 0.55, 0.04, WOOD_D, 0.015), 0, 0.75, 0);
  const pg = rbox(0.12, 0.16, 0.05, WOOD_D, 0.02); pg.rotation.x = -0.6; put(lute, pg, 0, 1.06, -0.04); lute.rotation.z = 0.15;
  live(solid1((lute)), -6.6, 0.3, 7.95, 0.3); st(rbox(0.3, 0.05, 0.25, IRON, 0.02), -6.6, 0.33, 7.95);
  const stool = new THREE.Group(); put(stool, cyl(0.2, 0.2, 0.06, WOOD, 10), 0, 0.46, 0); put(stool, cyl(0.05, 0.08, 0.44, WOOD_D, 6), 0, 0.22, 0); st(stool, -7.6, 0.3, 8.0);
  // trophy plaque on a post (no wall of ours is visible): a tusked boar head
  const tr = new THREE.Group(); put(tr, rbox(0.14, 2.4, 0.14, WOOD_D, 0.03), 0, 1.2, 0); put(tr, rbox(0.5, 0.1, 0.5, WOOD_D, 0.04), 0, 0.05, 0);
  put(tr, rbox(0.9, 0.7, 0.08, WOOD, 0.05), 0, 2.1, 0.1); const hd = mesh(new THREE.SphereGeometry(0.26, 10, 8), mat('#6a4a3a')); hd.scale.set(1, 0.9, 1.2); put(tr, hd, 0, 2.1, 0.32);
  put(tr, rbox(0.2, 0.16, 0.2, mat('#c88a7a'), 0.06), 0, 2.02, 0.6);
  for (const s of [-1, 1]) { const tu = mesh(new THREE.ConeGeometry(0.035, 0.22, 6), mat('#f0e6c8')); tu.rotation.z = s * -0.6; put(tr, tu, s * 0.13, 2.05, 0.58);
    const ear = mesh(new THREE.ConeGeometry(0.07, 0.18, 5), mat('#6a4a3a')); ear.rotation.z = s * -0.7; put(tr, ear, s * 0.2, 2.32, 0.25); }
  st(tr, 9.6, 0, -8.3, 0, true);
  return { lute, tick: (/** @type {number} */ t) => { void t; } };
}
