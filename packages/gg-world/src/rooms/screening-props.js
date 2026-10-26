// @ts-check
// The Screening Room: code-modelled props (seats, curtains, booth, candy counter, popcorn machine, standee, reels).
// Each returns a Group with its floor at y=0, front facing -z unless noted.
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh, rng } from './kit.js';
import * as TX from './tex.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const VELVET = ['#7a1622', '#6a1420'];
const METAL = () => mat('#2a2228', { metalness: 0.6, roughness: 0.45 });

/** Worn red velvet flip seat facing -z (sit point about y 0.45, z +0.02). */
export function seat(seed = 1) {
  const g = new THREE.Group(), r = rng(seed), v = mat(VELVET[Math.floor(r() * VELVET.length)], { roughness: 0.95 }), m = METAL();
  put(g, rbox(0.54, 0.12, 0.5, v, 0.05), 0, 0.42, 0);
  const back = put(g, rbox(0.54, 0.66, 0.13, v, 0.05), 0, 0.82, 0.25); back.rotation.x = -0.12;
  for (const s of [-1, 1]) {
    put(g, rbox(0.06, 0.05, 0.5, mat('#3a2a22', { roughness: 0.6 }), 0.02), s * 0.31, 0.64, 0.02);
    put(g, rbox(0.05, 0.6, 0.08, m, 0.015), s * 0.31, 0.32, 0.12);
    put(g, rbox(0.14, 0.03, 0.2, m, 0.01), s * 0.31, 0.015, 0.12);
  }
  return g;
}

/** A wavy hanging velvet curtain panel (w x h), hung from y=h. */
export function curtain(w, h, seed = 3, color = '#6e1220') {
  const geo = new THREE.PlaneGeometry(w, h, 28, 1), p = geo.attributes.position, r = rng(seed), ph = r() * 6;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i); p.setZ(i, Math.sin(x / w * 26 + ph) * 0.07 + Math.sin(x * 9.1) * 0.015); }
  geo.computeVertexNormals(); geo.translate(0, h / 2, 0);
  const g = new THREE.Group(); const c = mesh(geo, mat(color, { roughness: 0.92, side: THREE.DoubleSide })); g.add(c);
  put(g, rbox(w * 0.3, 0.08, 0.12, mat('#c9a227', { metalness: 0.6, roughness: 0.4 }), 0.03), 0, h * 0.42, 0.08); // tie-back
  return g;
}

/** Projector booth: brick cabin with a glowing (green-tinted) window facing -z and +x. Footprint w x d. */
export function booth(w, d, H = 2.9) {
  const g = new THREE.Group(), wm = mat('#ffffff', { map: TX.brick('#4a2c2a', '#24161a', 11), roughness: 0.95 }), trim = mat('#2a1a1e');
  put(g, rbox(w, H, d, wm, 0.03), 0, H / 2, 0);
  put(g, rbox(w + 0.1, 0.1, d + 0.1, trim, 0.03), 0, H + 0.05, 0);
  const win = glowMat('#ffcf8a', 1.6), glass = new THREE.MeshBasicMaterial({ color: '#3ddc84', transparent: true, opacity: 0.25, toneMapped: false });
  put(g, rbox(1.0, 0.55, 0.04, win, 0.01), 0.1, 2.15, -d / 2 - 0.005);
  const gl = put(g, new THREE.Mesh(new THREE.PlaneGeometry(0.98, 0.53), glass), 0.1, 2.15, -d / 2 - 0.03); gl.rotation.y = Math.PI; gl.userData.live = true;
  put(g, rbox(1.12, 0.07, 0.12, trim, 0.02), 0.1, 1.85, -d / 2 - 0.05);
  put(g, rbox(0.04, 0.5, 0.75, win, 0.01), w / 2 + 0.005, 2.2, -0.2); // side port, seen from the camera
  put(g, rbox(0.06, 0.07, 0.86, trim, 0.02), w / 2 + 0.03, 1.92, -0.2);
  put(g, rbox(0.04, 2.0, 0.8, trim, 0.02), w / 2 + 0.01, 1.0, d / 2 - 0.55); // door
  put(g, rbox(0.03, 0.05, 0.12, mat('#c9a227', { metalness: 0.6, roughness: 0.4 }), 0.01), w / 2 + 0.04, 1.0, d / 2 - 0.85);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.18), new THREE.MeshBasicMaterial({ map: TX.label('PROJECTION', '#e0a458', '#1a1014', 256, 64), toneMapped: false }));
  sign.rotation.y = Math.PI / 2; put(g, sign, w / 2 + 0.03, 2.2, d / 2 - 0.55);
  return g;
}

/** Glass-fronted candy counter (length L along x), customers on -z side. */
export function candyCounter(L) {
  const g = new THREE.Group(), wood = mat('#3a1e1a', { roughness: 0.6 }), top = mat('#5a2a24', { roughness: 0.35, metalness: 0.1 });
  put(g, rbox(L, 0.55, 0.7, wood, 0.03), 0, 0.275, 0);
  put(g, rbox(L + 0.06, 0.05, 0.76, top, 0.02), 0, 1.05, 0);
  for (const x of [-L / 2 + 0.04, L / 2 - 0.04]) put(g, rbox(0.06, 0.5, 0.7, wood, 0.02), x, 0.8, 0);
  put(g, rbox(L - 0.1, 0.03, 0.62, mat('#2a1612'), 0.01), 0, 0.57, 0);
  put(g, rbox(L - 0.12, 0.03, 0.03, glowMat('#ffb36b', 1.4), 0.01), 0, 1.0, -0.3); // display light strip
  // candy boxes (palette strip UVs so they merge)
  const PAL = ['#e63946', '#f1c453', '#3ddc84', '#b04fd8', '#457b9d', '#f4a261', '#ff4fd8', '#e9edc9'];
  const pal = TX.canvasTex('scr-candy', 8, 1, x => PAL.forEach((c, i) => { x.fillStyle = c; x.fillRect(i, 0, 1, 1); }), { nearest: true });
  const r = rng(5), gs = [];
  for (let x = -L / 2 + 0.15; x < L / 2 - 0.12; x += 0.17) for (const z of [-0.12, 0.12]) {
    const b = new THREE.BoxGeometry(0.13, 0.18 + r() * 0.08, 0.05); const u = (Math.floor(r() * 8) + 0.5) / 8, uv = b.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setXY(k, u, 0.5);
    b.rotateX(-0.3); b.translate(x, 0.7, z); gs.push(b); }
  g.add(mesh(mergeGeometries(gs), mat('#ffffff', { map: pal, roughness: 0.5 })));
  const glass = new THREE.Mesh(new THREE.BoxGeometry(L - 0.1, 0.44, 0.66), new THREE.MeshStandardMaterial({ color: '#9fd8c0', transparent: true, opacity: 0.16, roughness: 0.05, depthWrite: false }));
  glass.position.y = 0.8; glass.userData.live = true; g.add(glass);
  return g;
}
/** Popcorn machine (cart top): red frame, glass case (live), warm lamp, heap of popcorn. Returns { g, lamp, kernels }. */
export function popcornMachine() {
  const g = new THREE.Group(), red = mat('#9a1a22', { roughness: 0.45 }), chrome = mat('#b8a890', { metalness: 0.8, roughness: 0.25 });
  put(g, rbox(0.7, 0.14, 0.55, red, 0.03), 0, 0.07, 0);
  put(g, rbox(0.74, 0.18, 0.58, red, 0.04), 0, 0.92, 0);
  for (const x of [-0.33, 0.33]) for (const z of [-0.25, 0.25]) put(g, rbox(0.04, 0.72, 0.04, chrome, 0.012), x, 0.5, z);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.13), new THREE.MeshBasicMaterial({ map: TX.label('POPCORN', '#ffd166', '#7a1018', 256, 56), toneMapped: false }));
  sign.rotation.y = Math.PI; put(g, sign, 0, 0.92, -0.296); const s2 = sign.clone(); s2.rotation.y = Math.PI / 2; put(g, s2, 0.376, 0.92, 0);
  const kettle = mesh(new THREE.CylinderGeometry(0.12, 0.09, 0.12, 14), chrome); put(g, kettle, 0, 0.72, 0);
  const lamp = put(g, rbox(0.4, 0.03, 0.2, glowMat('#ffcf8a', 2.2), 0.01), 0, 0.82, 0); lamp.userData.live = true;
  const heap = mesh(new THREE.SphereGeometry(0.3, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat('#f3d27a', { roughness: 0.9 })); heap.scale.set(1.05, 0.5, 0.78); put(g, heap, 0, 0.14, 0);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.68, 0.5), new THREE.MeshStandardMaterial({ color: '#ffe0b0', transparent: true, opacity: 0.12, roughness: 0.05, depthWrite: false, emissive: '#ff9a40', emissiveIntensity: 0.25 }));
  glass.position.y = 0.49; glass.userData.live = true; g.add(glass);
  // popping kernels (instanced; burst on E)
  const k = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.03, 0), mat('#fff1c4', { roughness: 0.9 }), 40); k.userData.live = true; k.castShadow = false; g.add(k);
  return { g, lamp, kernels: k };
}

/** Cardboard standee: a flat cutout on a kickstand, faces +z. tex = alpha canvas. */
export function standee(tex, w, h) {
  const g = new THREE.Group();
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: '#ffffff', emissiveIntensity: 0.35, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9 }));
  face.position.y = h / 2 + 0.02; face.castShadow = true; g.add(face);
  const leg = rbox(0.04, h * 0.7, 0.02, mat('#8a6a4a', { roughness: 1 }), 0.005); leg.position.set(0, h * 0.35, -0.22); leg.rotation.x = 0.33; g.add(leg);
  return g;
}

/** Stack of film canisters + loose reels (flat on the floor). */
export function reels(seed = 2) {
  const g = new THREE.Group(), r = rng(seed), tin = mat('#7a7068', { metalness: 0.6, roughness: 0.5 }), dark = mat('#3a3430', { metalness: 0.5, roughness: 0.6 });
  for (let i = 0; i < 4; i++) { const c = mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.06, 22), i % 2 ? tin : dark); put(g, c, (r() - 0.5) * 0.06, 0.03 + i * 0.065, (r() - 0.5) * 0.06); }
  const reel = new THREE.Group(); const rim = mesh(new THREE.TorusGeometry(0.26, 0.02, 6, 24), tin); reel.add(rim);
  const hub = mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 10), dark); hub.rotation.x = Math.PI / 2; reel.add(hub);
  for (let i = 0; i < 3; i++) { const s = rbox(0.03, 0.42, 0.02, tin, 0.005); s.rotation.z = i * Math.PI / 3; reel.add(s); }
  const film = mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.035, 20), mat('#1a1410', { roughness: 0.4 })); film.rotation.x = Math.PI / 2; reel.add(film);
  reel.rotation.set(0, 0.5, 0.28); put(g, reel, 0.42, 0.27, 0.05);
  return g;
}

/** Parody film poster canvas (2:3). */
export function filmPoster(i) {
  const P = [['JAWZ', 'YOU WILL NEED A BIGGER REPO', '#0e2a40', '#e8e0c8'], ['DEPLOY ON FRIDAY', 'NOBODY ROLLS BACK ALIVE', '#2a0a10', '#ff3a3a'],
    ['REPO WARS', 'EPISODE IV: A NEW BRANCH', '#08081a', '#ffd166'], ['THE MERGE', 'FREE YOUR MAIN', '#04140a', '#6ee7a0']][i];
  return TX.canvasTex('scr-poster' + i, 120, 180, (x, w, h) => {
    x.fillStyle = P[2]; x.fillRect(0, 0, w, h); const r = rng(i + 7);
    if (i === 0) { x.fillStyle = '#1d5a7a'; x.fillRect(0, 70, w, h); x.fillStyle = '#c8c4bc'; x.beginPath(); x.moveTo(30, 175); x.lineTo(60, 80); x.lineTo(90, 175); x.fill(); x.fillStyle = '#fff'; for (let k = 0; k < 6; k++) { x.beginPath(); x.moveTo(42 + k * 6, 128); x.lineTo(45 + k * 6, 138); x.lineTo(48 + k * 6, 128); x.fill(); } x.fillStyle = '#e8d0a0'; x.fillRect(52, 66, 16, 4); }
    if (i === 1) { x.fillStyle = '#5a0a14'; x.beginPath(); x.arc(60, 95, 40, 0, 7); x.fill(); x.fillStyle = '#d8d0c0'; x.fillRect(58, 60, 4, 50); x.fillRect(52, 108, 16, 6); x.fillStyle = '#ff3a3a'; x.fillRect(20, 130, 80, 2); }
    if (i === 2) { for (let k = 0; k < 60; k++) { x.fillStyle = '#fff'; x.fillRect(r() * w, r() * h, 1, 1); } x.fillStyle = '#ffd166'; x.beginPath(); x.moveTo(20, 170); x.lineTo(50, 70); x.lineTo(70, 70); x.lineTo(100, 170); x.fill(); x.fillStyle = '#08081a'; for (let k = 0; k < 6; k++) x.fillRect(20, 80 + k * 15, 80, 2); }
    if (i === 3) { x.fillStyle = '#3ddc84'; for (let k = 0; k < 12; k++) x.fillRect(6 + k * 9, 40 + (k * 37) % 50, 2, 60); x.fillStyle = '#111'; x.beginPath(); x.ellipse(60, 110, 22, 30, 0, 0, 7); x.fill(); x.fillStyle = '#000'; x.fillRect(42, 102, 15, 7); x.fillRect(63, 102, 15, 7); }
    x.textAlign = 'center'; x.fillStyle = P[3]; x.font = `${Math.round((P[0].length > 8 ? 13 : 20) * 1.5)}px m5x7`; x.fillText(P[0], w / 2, 26);
    x.font = '10px m5x7'; x.fillStyle = '#d8ccb8'; x.fillText(P[1], w / 2, h - 10);
    x.strokeStyle = 'rgba(255,255,255,0.18)'; x.lineWidth = 3; x.strokeRect(2, 2, w - 4, h - 4);
  });
}

/** Shark-rising standee texture (homage cutout). */
export function sharkTex() {
  return TX.canvasTex('scr-shark', 160, 220, (x, w, h) => {
    x.clearRect(0, 0, w, h);
    x.fillStyle = '#1a4a6a'; x.beginPath(); x.moveTo(0, 180); for (let i = 0; i <= 16; i++) x.lineTo(i * 10, 172 + Math.sin(i * 1.3) * 6); x.lineTo(w, h); x.lineTo(0, h); x.fill();
    x.fillStyle = '#6f7a84'; x.beginPath(); x.moveTo(30, 185); x.quadraticCurveTo(20, 60, 80, 20); x.quadraticCurveTo(140, 60, 130, 185); x.fill();
    x.fillStyle = '#d8d8d0'; x.beginPath(); x.moveTo(45, 185); x.quadraticCurveTo(60, 120, 80, 112); x.quadraticCurveTo(100, 120, 115, 185); x.fill();
    x.fillStyle = '#3a0a10'; x.beginPath(); x.ellipse(80, 120, 30, 34, 0, 0, 7); x.fill();
    x.fillStyle = '#fff'; for (let k = 0; k < 7; k++) { const a = Math.PI + k / 6 * Math.PI; x.beginPath(); const cx = 80 + Math.cos(a) * 28, cy = 120 + Math.sin(a) * 32; x.moveTo(cx - 4, cy); x.lineTo(cx + 4, cy); x.lineTo(80 + Math.cos(a) * 18, 120 + Math.sin(a) * 22); x.fill(); }
    x.fillStyle = '#111'; x.beginPath(); x.arc(56, 70, 4, 0, 7); x.arc(104, 70, 4, 0, 7); x.fill();
    x.fillStyle = '#e8e0c8'; x.font = '39px m5x7'; x.textAlign = 'center'; x.fillText('JAWZ', w / 2, 212);
    x.strokeStyle = '#2a1a10'; x.lineWidth = 2; x.stroke();
  });
}

/**
 * Soft light / shade quads merged into ONE static mesh (1 draw call, never animates, so it cannot flicker).
 * Shared by screening, diner, library and garage. Floor items: { x, y, z, w, h, c, a } (horizontal, w along x, h along z).
 * Wall items are passed per wall (the mesh goes into that wall's decor so it hides with the cutaway): { u, y, w, h, c, a, out }.
 * mode 'add' = additive light (colour * a), 'shade' = dark soft shadow (alpha a).
 * @param {any} R @param {any[]} items @param {'add'|'shade'} [mode] @param {string} [side] wall side, omit for floor
 */
export function softQuads(R, items, mode = 'add', side) {
  if (!items.length) return null;
  const gs = items.map(it => {
    const g = new THREE.PlaneGeometry(it.w, it.h); const c = new THREE.Color(it.c || '#000000'), n = g.attributes.position.count, col = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) col.set(mode === 'add' ? [c.r * it.a, c.g * it.a, c.b * it.a, 1] : [0, 0, 0, it.a], i * 4);
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    if (side) g.translate(it.u, it.y, it.out ?? 0.015); else { g.rotateX(-Math.PI / 2); if (it.ry) g.rotateY(it.ry); g.translate(it.x, it.y ?? 0.014, it.z); }
    return g; });
  const m = new THREE.MeshBasicMaterial({ map: TX.dotTex(), vertexColors: true, transparent: true, depthWrite: false, toneMapped: false,
    blending: mode === 'add' ? THREE.AdditiveBlending : THREE.NormalBlending, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
  const mesh = new THREE.Mesh(mergeGeometries(gs), m); mesh.name = 'soft-' + mode; mesh.renderOrder = mode === 'add' ? 4 : -4;
  mesh.castShadow = mesh.receiveShadow = false; mesh.userData.noGround = true; mesh.userData.live = true; mesh.matrixAutoUpdate = true;
  if (side) R.walls[side].decor.add(mesh); else R.root.add(mesh);
  return mesh;
}
