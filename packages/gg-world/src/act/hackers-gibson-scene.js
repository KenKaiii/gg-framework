// @ts-check
// Tiny three.js scene for Hack the Gibson: instanced translucent data towers with scrolling code faces, horizon grid,
// fog, the garbage file. Everything is disposed by dispose().
import * as THREE from 'three';

/** Scrolling code texture for the tower faces. */
function codeTex() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 128; const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  x.fillStyle = '#000'; x.fillRect(0, 0, 64, 128); let s = 7; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let row = 0; row < 32; row++) for (let col = 0; col < 10; col++) if (r() < 0.6) { x.fillStyle = `rgba(255,255,255,${0.35 + r() * 0.6})`; x.fillRect(4 + col * 6, row * 4, 4, 2); }
  x.fillStyle = '#fff'; x.fillRect(0, 0, 2, 128); x.fillRect(62, 0, 2, 128);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace; t.repeat.set(2, 3); return t;
}

/** @param {Uint8Array} tow @param {number} GW @param {number} GH @param {number} fi @param {number} fj */
export function gibsonScene(tow, GW, GH, fi, fj) {
  const W = 480, H = 270;
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1); renderer.setSize(W, H, false); renderer.setClearColor('#05040c');
  const scene = new THREE.Scene(); scene.fog = new THREE.Fog('#100a22', 2, 18); scene.background = new THREE.Color('#100a22');
  const cam = new THREE.PerspectiveCamera(70, W / H, 0.05, 40);
  const tex = codeTex();
  let n = 0; for (let k = 0; k < tow.length; k++) if (tow[k]) n++;
  const geo = new THREE.BoxGeometry(0.82, 1, 0.82); geo.translate(0, 0.5, 0);
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
  const towers = new THREE.InstancedMesh(geo, m, n);
  const core = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: '#0a0818', fog: true }), n);
  const M = new THREE.Matrix4(), C = new THREE.Color(), tints = ['#3ff0ff', '#ff4fd8', '#9dff3d', '#8fa8ff'];
  let i = 0;
  for (let j = 0; j < GH; j++) for (let q = 0; q < GW; q++) { const h = tow[j * GW + q]; if (!h) continue;
    const hh = 1.2 + h * 1.1 + ((q * 7 + j * 3) % 5) * 0.3;
    M.makeScale(1, hh, 1).setPosition(q + 0.5, 0, j + 0.5); towers.setMatrixAt(i, M);
    M.makeScale(0.96, hh * 0.995, 0.96).setPosition(q + 0.5, 0, j + 0.5); core.setMatrixAt(i, M);
    towers.setColorAt(i, C.set(tints[(q + j) % 4])); i++; }
  scene.add(core, towers);
  const grid = new THREE.GridHelper(80, 80, '#ff4fd8', '#3a2a6a'); grid.position.set(GW / 2, 0.001, GH / 2); scene.add(grid);
  const file = new THREE.Mesh(new THREE.OctahedronGeometry(0.22), new THREE.MeshBasicMaterial({ color: '#ffcf8a', wireframe: true, fog: false }));
  file.position.set(fi + 0.5, 0.6, fj + 0.5); scene.add(file);
  const beamM = new THREE.MeshBasicMaterial({ color: '#ffcf8a', transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 30, 6, 1, true), beamM); beam.position.set(fi + 0.5, 15, fj + 0.5); scene.add(beam);
  return {
    canvas: renderer.domElement, cam, fileAt: file.position,
    /** match the on-screen size (sharp, not a stretched 480x270), capped at ~2.1 MP so it stays cheap @param {number} cssW */
    fit(cssW) { const dpr = Math.min(2, devicePixelRatio || 1); let w = Math.round(cssW * dpr); w = Math.max(W, Math.min(w, 1920)); const h = Math.round(w * H / W); if (renderer.domElement.width !== w) renderer.setSize(w, h, false); },
    /** @param {number} far */ fog(far) { /** @type {THREE.Fog} */ (scene.fog).far = far; },
    /** @param {number} t @param {number} near 0..1 how hot the scanner is */
    render(t, near) { tex.offset.y = -t * 0.25; file.rotation.y = t * 2; file.position.y = 0.6 + Math.sin(t * 3) * 0.08; beamM.opacity = 0.1 + near * 0.5; m.opacity = 0.7 + 0.1 * Math.sin(t * 2); renderer.render(scene, cam); },
    dispose() { scene.traverse(o => { const a = /** @type {any} */ (o); a.geometry?.dispose(); if (a.material) [].concat(a.material).forEach(mm => mm.dispose()); }); tex.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); },
  };
}
