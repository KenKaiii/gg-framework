// @ts-check
// Lab 426: prop builders (specimen tube, alien egg cryo stand, MOTHER console, embryo cold case, raptor door, benches).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mat, glowMat, rbox, put, mesh } from './kit.js';

export const STEEL = () => mat('#4a5250', { metalness: 0.7, roughness: 0.45 });
export const DARK = () => mat('#1a1e20', { metalness: 0.5, roughness: 0.6 });
export const HAZ = () => mat('#ffffff', { map: hazardTex(), roughness: 0.7 });

/** @param {number} w @param {number} h @param {(x: CanvasRenderingContext2D) => void} draw */
function canvasTex(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')); draw(x);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; }

/** Dark steel grating, tiles 1 m. */
export function grateTex() { return canvasTex(128, 128, x => {
  x.fillStyle = '#4a5a5a'; x.fillRect(0, 0, 128, 128);
  for (let j = 0; j < 8; j++) for (let i = 0; i < 4; i++) { x.fillStyle = '#1e2828'; x.fillRect(i * 32 + 4, j * 16 + 4, 24, 8); x.fillStyle = '#7a8a88'; x.fillRect(i * 32 + 4, j * 16 + 12, 24, 1); }
  x.strokeStyle = '#2a3434'; x.lineWidth = 2; x.strokeRect(1, 1, 126, 126);
  for (let k = 0; k < 40; k++) { x.fillStyle = `rgba(90,70,40,${0.05 + (k % 5) * 0.02})`; x.fillRect((k * 37) % 128, (k * 59) % 128, 6, 3); }
}); }
let hz = null;
/** Yellow/black hazard stripes. */
export function hazardTex() { if (hz) return hz; hz = canvasTex(64, 16, x => { x.fillStyle = '#f0c030'; x.fillRect(0, 0, 64, 16);
  x.fillStyle = '#16181a'; for (let i = -2; i < 6; i++) { x.beginPath(); x.moveTo(i * 16, 16); x.lineTo(i * 16 + 8, 16); x.lineTo(i * 16 + 16, 0); x.lineTo(i * 16 + 8, 0); x.fill(); }
  x.fillStyle = 'rgba(0,0,0,0.35)'; for (let k = 0; k < 30; k++) x.fillRect((k * 23) % 64, (k * 7) % 16, 3, 1); }); hz.wrapS = THREE.RepeatWrapping; return hz; }

/** One merged facehugger geometry (body, 8 finger legs, tail), about 0.5 long. */
export function huggerGeo() {
  const body = new THREE.SphereGeometry(0.1, 14, 10); body.scale(1, 0.45, 1.15);
  const parts = [body];
  for (let i = 0; i < 8; i++) { const s = i < 4 ? -1 : 1, k = i % 4, a = -0.9 + k * 0.6;
    const ox = s * 0.07, oz = Math.sin(a) * 0.08;
    const pts = [new THREE.Vector3(ox, 0, oz), new THREE.Vector3(s * 0.17, 0.05, oz + Math.sin(a) * 0.08), new THREE.Vector3(s * 0.25, 0.0, oz + Math.sin(a) * 0.14), new THREE.Vector3(s * 0.27, -0.07, oz + Math.sin(a) * 0.17)];
    parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 8, 0.012, 5)); }
  const tail = [0, 1, 2, 3, 4, 5].map(i => new THREE.Vector3(Math.sin(i * 1.3) * 0.06, -0.01, -0.1 - i * 0.07));
  parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(tail), 16, 0.018, 6));
  return /** @type {THREE.BufferGeometry} */ (mergeGeometries(parts));
}
export const fleshMat = () => mat('#b49c74', { roughness: 0.4, metalness: 0.1 });

/** Specimen tube (static parts). Fluid is transparent so it stays live/unbaked. Returns { g, fluid }. */
export function specimenTube(fluidMat) {
  const g = new THREE.Group();
  put(g, mesh(new THREE.CylinderGeometry(0.42, 0.48, 0.32, 20), STEEL()), 0, 0.16, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.04, 20), glowMat('#3ddc84', 1.4)), 0, 0.34, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.44, 0.4, 0.26, 20), STEEL()), 0, 2.2, 0);
  for (let i = 0; i < 3; i++) { const a = i * 2.1; put(g, mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.8, 6), DARK()), Math.cos(a) * 0.37, 1.22, Math.sin(a) * 0.37); }
  put(g, mesh(new THREE.TorusGeometry(0.36, 0.03, 6, 20), DARK()), 0, 1.2, 0).rotation.x = Math.PI / 2;
  const fluid = mesh(new THREE.CylinderGeometry(0.35, 0.35, 1.72, 20, 1, true), fluidMat); fluid.position.y = 1.22; fluid.userData.live = true;
  fluid.castShadow = false; g.add(fluid);
  return { g, fluid };
}

/** Alien egg on a cryo stand with a glass dome. Returns { g, petals:[{pivot,axis}], hugger, lamp }. */
export function eggStand(glassMat, hugGeo) {
  const g = new THREE.Group();
  put(g, mesh(new THREE.CylinderGeometry(0.62, 0.7, 0.4, 24), STEEL()), 0, 0.2, 0);
  const ring = mesh(new THREE.CylinderGeometry(0.66, 0.66, 0.06, 24), HAZ()); put(g, ring, 0, 0.36, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.2, 24), STEEL()), 0, 2.0, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.02, 24), glowMat('#6ee7a0', 0.9)), 0, 1.89, 0);
  const prof = []; for (let i = 0; i <= 12; i++) { const t = i / 12; prof.push(new THREE.Vector2(0.01 + Math.sin(Math.PI * Math.pow(t, 0.8)) * 0.26 * (1 - t * 0.25), t * 0.78)); }
  const eggM = mat('#5c5a3e', { roughness: 0.35, metalness: 0.15 });
  const base = mesh(new THREE.LatheGeometry(prof.slice(0, 9), 18), eggM); put(g, base, 0, 0.4, 0);
  const top = prof.slice(8), r0 = top[0].x, y0 = top[0].y, petals = [];
  for (let i = 0; i < 4; i++) { const ph = i * Math.PI / 2, mid = ph + Math.PI / 4, dx = Math.sin(mid), dz = Math.cos(mid);
    const geo = new THREE.LatheGeometry(top, 6, ph, Math.PI / 2); geo.translate(-dx * r0, -y0, -dz * r0);
    const pivot = new THREE.Group(); pivot.position.set(dx * r0, 0.4 + y0, dz * r0); const pm = mesh(geo, eggM); pm.castShadow = false; pivot.add(pm); pivot.userData.live = true;
    g.add(pivot); petals.push({ pivot, axis: new THREE.Vector3(dz, 0, -dx) }); }
  const hugger = mesh(hugGeo, fleshMat()); hugger.position.set(0, 0.9, 0); hugger.rotation.x = -Math.PI / 2; hugger.scale.setScalar(0.7); hugger.visible = false; hugger.userData.live = true; g.add(hugger);
  const dome = mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.52, 24, 1, true), glassMat); dome.position.y = 1.14; dome.castShadow = false; dome.userData.live = true; g.add(dome);
  const lamp = mesh(new THREE.SphereGeometry(0.09, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat('#3a0a0a', { emissive: '#ff2a1a', emissiveIntensity: 0.2 })); lamp.position.y = 2.1; lamp.userData.live = true; g.add(lamp);
  return { g, petals, hugger, lamp };
}

/** "MOTHER" console: angled desk with a green CRT and keyboard. Returns { g, screen }. */
export function motherConsole() {
  const g = new THREE.Group(), body = mat('#c8c2a8', { roughness: 0.6 });
  put(g, rbox(1.6, 0.8, 0.8, body, 0.04), 0, 0.4, 0);
  const desk = rbox(1.6, 0.06, 0.55, DARK(), 0.02); desk.rotation.x = 0.25; put(g, desk, 0, 0.86, 0.12);
  for (let i = 0; i < 18; i++) put(g, rbox(0.06, 0.03, 0.06, i % 5 ? mat('#2a2c30') : glowMat(i % 2 ? '#ff4a3a' : '#e0a458', 1.3), 0.01), -0.6 + (i % 9) * 0.15, 0.9 + (i > 8 ? 0.02 : 0), 0.22 - (i > 8 ? 0.1 : 0));
  put(g, rbox(0.7, 0.62, 0.6, body, 0.06), 0, 1.22, -0.12);
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.42), new THREE.MeshBasicMaterial({ map: moTex(), toneMapped: false }));
  scr.position.set(0, 1.24, 0.185); scr.userData.live = true; g.add(scr);
  put(g, rbox(1.0, 1.7, 0.4, body, 0.04), 0, 0.85, -0.55);
  for (let i = 0; i < 12; i++) put(g, rbox(0.04, 0.04, 0.02, glowMat(i % 3 ? '#3ddc84' : '#e0a458', 1.8), 0.01), -0.38 + (i % 6) * 0.15, 1.35 + Math.floor(i / 6) * 0.15, -0.34);
  return { g, screen: scr };
}
function moTex() { return canvasTex(128, 96, x => { x.fillStyle = '#021006'; x.fillRect(0, 0, 128, 96); x.fillStyle = '#6ee7a0'; x.font = '15px m5x7';
  ['MU-TH-UR 6000', 'INTERFACE 2037', '', '> READY.', '> CREW STATUS:', '  NOMINAL', '> _'].forEach((s, i) => x.fillText(s, 6, 14 + i * 11));
  x.fillStyle = 'rgba(0,0,0,0.25)'; for (let y = 0; y < 96; y += 2) x.fillRect(0, y, 128, 1); }); }

/** Embryo cold-storage case with rows of glowing vials + a shaving-cream can on top. */
export function embryoCase() {
  const g = new THREE.Group();
  put(g, rbox(1.1, 1.3, 0.6, mat('#9aa4a2', { metalness: 0.6, roughness: 0.4 }), 0.05), 0, 0.65, 0);
  put(g, rbox(0.9, 0.95, 0.04, mat('#0a1a22', { roughness: 0.1, metalness: 0.3 }), 0.02), 0, 0.72, 0.29);
  const vial = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.025, 0.025, 0.14, 8), glowMat('#8fe0ff', 1.3), 24); const m = new THREE.Matrix4();
  for (let i = 0; i < 24; i++) { m.makeTranslation(-0.35 + (i % 8) * 0.1, 0.42 + Math.floor(i / 8) * 0.3, 0.24); vial.setMatrixAt(i, m); } g.add(vial);
  put(g, rbox(1.12, 0.12, 0.62, HAZ(), 0.02), 0, 1.36, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.22, 12), mat('#7a8ea0', { metalness: 0.6, roughness: 0.3 })), 0.3, 1.53, 0.05);
  put(g, mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.05, 12), mat('#b84030')), 0.3, 1.665, 0.05);
  put(g, rbox(0.3, 0.06, 0.06, glowMat('#8fe0ff', 1.6), 0.01), -0.25, 1.24, 0.31);
  return g;
}

/** Locked security door in a free-standing bulkhead frame, claw scratches, keypad. Returns { g, light }. */
export function raptorDoor() {
  const g = new THREE.Group();
  put(g, rbox(2.0, 2.8, 0.35, mat('#3a403e', { metalness: 0.6, roughness: 0.5 }), 0.06), 0, 1.4, -0.05);
  const slab = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 2.3), mat('#ffffff', { map: scratchTex(), metalness: 0.5, roughness: 0.5 })); slab.position.set(0, 1.18, 0.13); g.add(slab);
  put(g, rbox(1.36, 0.14, 0.04, HAZ(), 0.01), 0, 2.38, 0.14);
  put(g, rbox(0.22, 0.32, 0.06, DARK(), 0.02), 0.84, 1.25, 0.15);
  for (let i = 0; i < 9; i++) put(g, rbox(0.04, 0.035, 0.02, mat('#8a9290', { metalness: 0.6 }), 0.008), 0.78 + (i % 3) * 0.06, 1.18 + Math.floor(i / 3) * 0.05, 0.19);
  const light = mesh(new THREE.BoxGeometry(0.12, 0.04, 0.02), new THREE.MeshBasicMaterial({ color: new THREE.Color('#3ddc84').multiplyScalar(2), toneMapped: false })); light.position.set(0.84, 1.35, 0.19); light.userData.live = true; g.add(light);
  return { g, light };
}
function scratchTex() { return canvasTex(128, 224, x => {
  x.fillStyle = '#56605c'; x.fillRect(0, 0, 128, 224); x.fillStyle = '#4a524f'; for (let y = 0; y < 224; y += 28) x.fillRect(0, y, 128, 2);
  x.fillStyle = '#2a302e'; x.fillRect(62, 0, 4, 224);
  for (const [cx, cy] of [[40, 70], [86, 120]]) for (let k = 0; k < 3; k++) { x.strokeStyle = '#1a1e1c'; x.lineWidth = 3; x.beginPath(); x.moveTo(cx + k * 10, cy); x.quadraticCurveTo(cx + k * 10 + 6, cy + 30, cx + k * 10 - 4, cy + 58); x.stroke();
    x.strokeStyle = '#a8b0aa'; x.lineWidth = 1; x.beginPath(); x.moveTo(cx + k * 10 + 2, cy); x.quadraticCurveTo(cx + k * 10 + 8, cy + 30, cx + k * 10 - 2, cy + 58); x.stroke(); }
}); }

/** Steel lab bench (top + legs + lower shelf). */
export function labBench(w) {
  const g = new THREE.Group();
  put(g, rbox(w, 0.07, 0.95, mat('#5e6866', { metalness: 0.6, roughness: 0.35 }), 0.02), 0, 0.92, 0);
  put(g, rbox(w - 0.2, 0.04, 0.75, DARK(), 0.01), 0, 0.3, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(g, rbox(0.06, 0.9, 0.06, STEEL(), 0.01), sx * (w / 2 - 0.12), 0.45, sz * 0.38);
  return g;
}
/** Lab stool, seat at h. */
export function labStool(h = 0.68) {
  const g = new THREE.Group();
  put(g, mesh(new THREE.CylinderGeometry(0.2, 0.18, 0.07, 14), mat('#2a2c30', { roughness: 0.5 })), 0, h, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.025, 0.025, h, 6), STEEL()), 0, h / 2, 0);
  const f = mesh(new THREE.TorusGeometry(0.16, 0.014, 5, 14), STEEL()); f.rotation.x = Math.PI / 2; put(g, f, 0, h * 0.35, 0);
  put(g, mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.03, 14), DARK()), 0, 0.015, 0);
  return g;
}
/** Small laptop (closed-ish, screen glowing). */
export function laptop(c = '#6ee7a0') {
  const g = new THREE.Group(); put(g, rbox(0.34, 0.02, 0.24, DARK(), 0.008), 0, 0.01, 0);
  const s = rbox(0.34, 0.22, 0.012, DARK(), 0.006); s.rotation.x = -0.25; put(g, s, 0, 0.12, -0.13);
  const sc = mesh(new THREE.PlaneGeometry(0.3, 0.18), glowMat(c, 1.1)); sc.rotation.x = -0.25; put(g, sc, 0, 0.12, -0.122); return g;
}

/** West-half clutter (gurney, fallen chair, crate stack), all in shared steel/dark materials so it bakes into existing calls. */
export function clutter() {
  const g = new THREE.Group(), gu = new THREE.Group();
  put(gu, rbox(1.9, 0.1, 0.7, STEEL(), 0.03), 0, 0.82, 0);
  put(gu, rbox(1.8, 0.08, 0.62, mat('#c8c2a8', { roughness: 0.6 }), 0.04), 0, 0.9, 0);
  put(gu, rbox(0.4, 0.08, 0.5, mat('#c8c2a8', { roughness: 0.6 }), 0.04), -0.7, 0.98, 0).rotation.z = -0.3;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { put(gu, mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.75, 6), STEEL()), sx * 0.85, 0.42, sz * 0.3);
    put(gu, mesh(new THREE.SphereGeometry(0.05, 8, 6), DARK()), sx * 0.85, 0.05, sz * 0.3); }
  put(gu, rbox(1.7, 0.03, 0.03, DARK(), 0.01), 0, 1.0, 0.33);
  put(g, gu, 0, 0, 0, 0.25);
  const ch = new THREE.Group(); put(ch, rbox(0.42, 0.05, 0.42, DARK(), 0.02), 0, 0.45, 0); put(ch, rbox(0.42, 0.45, 0.05, DARK(), 0.02), 0, 0.7, -0.2);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(ch, rbox(0.03, 0.45, 0.03, STEEL(), 0.01), sx * 0.18, 0.22, sz * 0.18);
  ch.rotation.set(H2, 0, 0.3); ch.position.set(1.6, 0.21, 1.4); g.add(ch);
  for (const [x, y, z, s, ry] of [[-0.3, 0, 2.6, 0.7, 0.3], [0.5, 0, 2.7, 0.6, -0.2], [0.1, 0.56, 2.6, 0.5, 0.8]]) { const c = rbox(s, s * 0.8, s, STEEL(), 0.03); put(g, c, x, y + s * 0.4, z, ry);
    put(g, rbox(s + 0.01, 0.06, s + 0.01, HAZ(), 0.01), x, y + s * 0.62, z, ry); }
  return g;
}
const H2 = Math.PI / 2;
