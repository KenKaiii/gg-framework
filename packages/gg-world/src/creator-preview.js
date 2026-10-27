// @ts-check
// Live full-body wardrobe preview: the player's avatar in a tiny scene, idle-animated, slowly turning (drag to spin).
// One small renderer is kept for the page (no context churn); everything per-open is freed when the panel leaves the DOM.
import * as THREE from 'three';
import { Avatar } from './avatar.js';

let R = null;
/** @param {any} A assets @param {any} look @param {HTMLElement} host */
export function makePreview(A, look, host) {
  if (!R) { R = new THREE.WebGLRenderer({ antialias: true, alpha: true }); R.toneMapping = THREE.ACESFilmicToneMapping; R.toneMappingExposure = 1.15; R.outputColorSpace = THREE.SRGBColorSpace; R.setClearColor(0x000000, 0); }
  const cv = R.domElement; cv.className = 'cpv'; host.appendChild(cv);
  const sc = new THREE.Scene(); sc.add(new THREE.HemisphereLight('#f4f2ff', '#3a3550', 1.7));
  const key = new THREE.DirectionalLight('#fff1dc', 2.3); key.position.set(1.5, 3, 3); sc.add(key);
  const rim = new THREE.DirectionalLight('#8fa3ff', 1.6); rim.position.set(-2, 2.5, -2.5); sc.add(rim);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.55, 40), new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.35 })); disc.rotation.x = -Math.PI / 2; sc.add(disc);
  const av = new Avatar(A, look); Avatar.all.delete(av); av.play('Idle'); sc.add(av.root);
  const cam = new THREE.PerspectiveCamera(26, 1, 0.1, 30);
  let yaw = 0.5, spin = 1, drag = null, raf = 0, last = performance.now(), w = 0, h = 0;
  cv.addEventListener('pointerdown', e => { drag = e.clientX; spin = 0; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', e => { if (drag === null) return; yaw += (e.clientX - drag) * 0.012; drag = e.clientX; });
  const up = () => { drag = null; spin = 1; }; cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  const frame = now => {
    if (!host.isConnected) { dispose(); return; }
    // World paused (the app switched away) or the tab hidden: stop drawing, check again shortly (no busy loop)
    if (/** @type {any} */ (window).__game?.paused || document.hidden) { last = now; raf = /** @type {any} */ (setTimeout(() => { raf = requestAnimationFrame(frame); }, 400)); return; }
    raf = requestAnimationFrame(frame); const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const cw = host.clientWidth, ch = host.clientHeight; if (cw !== w || ch !== h) { w = cw; h = ch; R.setPixelRatio(Math.min(2, devicePixelRatio || 1)); R.setSize(w, h, false); cv.style.width = '100%'; cv.style.height = '100%'; cam.aspect = w / Math.max(1, h); cam.updateProjectionMatrix(); }
    if (spin && drag === null) yaw += dt * 0.45;
    av.root.rotation.y = yaw; av.update(dt);
    const sy = av.root.scale.y, H = 1.75 * sy + 0.6 * (av.headScale || 1); // feet to top of head (+hats)
    const dist = (H * 0.62) / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) / Math.min(1, cam.aspect * 1.6);
    cam.position.set(0, H * 0.55 + 0.15, dist); cam.lookAt(0, H * 0.5, 0);
    R.render(sc, cam);
  };
  raf = requestAnimationFrame(frame);
  function dispose() { cancelAnimationFrame(raf); clearTimeout(raf); av.dispose(); disc.geometry.dispose(); disc.material.dispose(); cv.remove(); }
  return { set: l => av.setLook(l), wave: () => { av.fx.wave = 1.4; }, dispose };
}
