// @ts-check
// 3D bits for the pool game: a fresh table top (covers the baked cue), 16 numbered balls, cue stick, aim line,
// ghost ball and a pocket flash ring. All in one group placed at the table centre (room-local). ~23 draw calls.
import * as THREE from 'three';
import { BR, BX, BZ, POCKETS, HEAD_U, STRIPE } from './pool-phys.js';

export const TOP = 1.0;                      // y of our felt (just above the baked cue lying on the table)
export const COLORS = ['#f2ead8', '#e8c33a', '#2a55b8', '#c8322a', '#6a3aa0', '#e07a2a', '#2a8a4a', '#8a2a1e', '#141414'];
export const colorOf = n => COLORS[n === 8 ? 8 : n > 8 ? n - 8 : n];

function feltTex() {
  const k = 200, c = document.createElement('canvas'); c.width = 2.3 * k; c.height = 1.25 * k; const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  const X = u => (u + 1.15) * k, Y = v => (v + 0.625) * k;
  x.fillStyle = '#4a2a18'; x.fillRect(0, 0, c.width, c.height);
  const gw = x.createLinearGradient(0, 0, 0, c.height); gw.addColorStop(0, '#6a3e22'); gw.addColorStop(0.5, '#4e2c18'); gw.addColorStop(1, '#6a3e22');
  x.fillStyle = gw; x.fillRect(4, 4, c.width - 8, c.height - 8);
  x.fillStyle = '#16452c'; x.fillRect(X(-BX - 0.02), Y(-BZ - 0.02), (BX + 0.02) * 2 * k, (BZ + 0.02) * 2 * k); // cushions
  const g = x.createRadialGradient(c.width / 2, c.height / 2, 20, c.width / 2, c.height / 2, c.width * 0.55); g.addColorStop(0, '#2a7a4e'); g.addColorStop(1, '#1b5a38');
  x.fillStyle = g; x.fillRect(X(-BX), Y(-BZ), BX * 2 * k, BZ * 2 * k);
  for (let i = 0; i < 2500; i++) { x.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '120,200,150'},0.05)`; x.fillRect(X(-BX) + Math.random() * BX * 2 * k, Y(-BZ) + Math.random() * BZ * 2 * k, 2, 2); }
  x.strokeStyle = 'rgba(220,240,220,0.18)'; x.lineWidth = 1.5; x.beginPath(); x.moveTo(X(HEAD_U), Y(-BZ)); x.lineTo(X(HEAD_U), Y(BZ)); x.stroke();
  x.fillStyle = 'rgba(230,240,230,0.35)'; for (const u of [HEAD_U, -HEAD_U]) { x.beginPath(); x.arc(X(u), Y(0), 2.5, 0, 7); x.fill(); }
  x.fillStyle = '#9a8a60'; for (const u of [-0.75, -0.5, -0.25, 0.25, 0.5, 0.75]) for (const v of [-0.565, 0.565]) { x.beginPath(); x.arc(X(u * BX), Y(v), 2.5, 0, 7); x.fill(); }
  for (const v of [-0.25, 0.25]) for (const u of [-1.09, 1.09]) { x.beginPath(); x.arc(X(u), Y(v * 2 * BZ), 2.5, 0, 7); x.fill(); }
  for (const [u, v, r] of POCKETS) { x.fillStyle = '#2a1a10'; x.beginPath(); x.arc(X(u), Y(v), (r - 0.002) * k, 0, 7); x.fill(); x.fillStyle = '#050505'; x.beginPath(); x.arc(X(u), Y(v), (r - 0.012) * k, 0, 7); x.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
function ballTex(n) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128; const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  const col = colorOf(n); x.fillStyle = STRIPE(n) || n === 0 ? COLORS[0] : col; x.fillRect(0, 0, 256, 128);
  if (STRIPE(n)) { x.fillStyle = col; x.fillRect(0, 30, 256, 68); }
  if (n === 0) { x.fillStyle = '#c8322a'; for (const cx of [64, 192]) { x.beginPath(); x.arc(cx, 64, 6, 0, 7); x.fill(); } return tex(c); }
  for (const cx of [64, 192]) { x.fillStyle = '#fbf6ea'; x.beginPath(); x.ellipse(cx, 64, 30, 28, 0, 0, 7); x.fill();
    x.fillStyle = '#111'; x.font = '700 50px Sora, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(n), cx, 62); }
  return tex(c);
}
const tex = c => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; };

/** @param {THREE.Object3D} parent room-local group (R.live) */
export function buildView(parent) {
  const g = new THREE.Group(); g.position.set(0.6, 0, 1.0); g.userData.live = true; parent.add(g);
  const disp = [];
  const own = o => { disp.push(o); return o; };
  const top = new THREE.Mesh(own(new THREE.PlaneGeometry(2.3, 1.25)), own(new THREE.MeshStandardMaterial({ map: own(feltTex()), roughness: 0.95 })));
  top.rotation.x = -Math.PI / 2; top.position.y = TOP; top.receiveShadow = true; g.add(top);
  const sg = own(new THREE.SphereGeometry(BR, 20, 14));
  const balls = []; for (let n = 0; n < 16; n++) { const m = new THREE.Mesh(sg, own(new THREE.MeshStandardMaterial({ map: own(ballTex(n)), color: '#c8c8c8', roughness: 0.55, metalness: 0 })));
    m.castShadow = true; m.rotation.set(-0.3 + (n * 0.7) % 0.6, n * 1.3, 0); g.add(m); balls[n] = m; }
  // cue stick: shaft + butt, pointing +u from its tip at the origin of the group
  const cue = new THREE.Group(); g.add(cue);
  const shaft = new THREE.Mesh(own(new THREE.CylinderGeometry(0.007, 0.011, 0.8, 8)), own(new THREE.MeshStandardMaterial({ color: '#e0c08a', roughness: 0.5 })));
  shaft.rotation.z = Math.PI / 2; shaft.position.x = -0.4; cue.add(shaft);
  const butt = new THREE.Mesh(own(new THREE.CylinderGeometry(0.011, 0.016, 0.55, 8)), own(new THREE.MeshStandardMaterial({ color: '#3a1e12', roughness: 0.4, emissive: '#1a0a06' })));
  butt.rotation.z = Math.PI / 2; butt.position.x = -1.075; cue.add(butt);
  // aim line (dashed) + object-ball direction line
  const lm = own(new THREE.LineDashedMaterial({ color: '#e8f4e0', dashSize: 0.025, gapSize: 0.02, transparent: true, opacity: 0.75, depthWrite: false }));
  const mkLine = () => { const geo = own(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)])); const l = new THREE.Line(geo, lm); l.renderOrder = 3; g.add(l); return l; };
  const aim = mkLine(), aim2 = mkLine();
  const ghost = new THREE.Mesh(sg, own(new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.28, depthWrite: false }))); g.add(ghost);
  const ring = new THREE.Mesh(own(new THREE.RingGeometry(0.6, 1, 24)), own(new THREE.MeshBasicMaterial({ color: '#ffcf8a', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })));
  ring.rotation.x = -Math.PI / 2; ring.position.y = TOP + 0.002; ring.renderOrder = 4; g.add(ring);
  const setLine = (l, u0, v0, u1, v1) => { const p = l.geometry.attributes.position; p.setXYZ(0, u0, TOP + 0.003, v0); p.setXYZ(1, u1, TOP + 0.003, v1); p.needsUpdate = true; l.geometry.computeBoundingSphere(); l.computeLineDistances(); };
  // soft contact shadows: one instanced blob per ball
  const sc = document.createElement('canvas'); sc.width = sc.height = 32; const sx = /** @type {CanvasRenderingContext2D} */ (sc.getContext('2d'));
  const sgr = sx.createRadialGradient(16, 16, 2, 16, 16, 16); sgr.addColorStop(0, 'rgba(0,0,0,.75)'); sgr.addColorStop(1, 'rgba(0,0,0,0)'); sx.fillStyle = sgr; sx.fillRect(0, 0, 32, 32);
  const sh = new THREE.InstancedMesh(own(new THREE.PlaneGeometry(BR * 3.2, BR * 3.2).rotateX(-Math.PI / 2)), own(new THREE.MeshBasicMaterial({ map: own(tex(sc)), transparent: true, depthWrite: false })), 16);
  sh.renderOrder = 2; sh.frustumCulled = false; g.add(sh); const m4 = new THREE.Matrix4();
  const shadows = (B, sinking) => { for (const b of B) { const show = b.on || sinking.some(s => s.b === b); m4.makeScale(show ? 1 : 0, 1, show ? 1 : 0); m4.setPosition(b.u + BR * 0.25, TOP + 0.001, b.v + BR * 0.3); sh.setMatrixAt(b.n, m4); } sh.instanceMatrix.needsUpdate = true; };
  return {
    g, balls, shadows, cue, aim, aim2, ghost, ring, setLine,
    dispose() { g.removeFromParent(); for (const d of disp) d.dispose?.(); },
  };
}
export { BX, BZ };
