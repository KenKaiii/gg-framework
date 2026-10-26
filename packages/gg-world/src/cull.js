// @ts-check
// View culling for the big floor: which rooms and characters are inside the camera frustum (+ margin) this frame.
// Off-screen rooms skip R.tick and hide R.live; off-screen characters hide and skip their mixer (state still runs).
import * as THREE from 'three';

/** @param {THREE.Camera} cam */
export function makeCuller(cam) {
  const fr = new THREE.Frustum(), m = new THREE.Matrix4(), sph = new THREE.Sphere(), box = new THREE.Box3();
  const C = {
    /** call after the camera matrices are final for the frame */
    update() { cam.updateMatrixWorld(); m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); fr.setFromProjectionMatrix(m); },
    /** world point with a radius (character: ~1.6 covers the head + nameplate) */
    sees(p, r = 1.6) { sph.center.copy(p); sph.center.y += 1; sph.radius = r; return fr.intersectsSphere(sph); },
    /** room footprint (R.box, world) as a 3.6 m tall box, grown by margin */
    seesRoom(R, margin = 1) { const b = R.box; box.min.set(b.x0 - margin, -0.5, b.z0 - margin); box.max.set(b.x1 + margin, 3.8, b.z1 + margin); return fr.intersectsBox(box); },
  };
  // ?cull=0 turns culling off (A/B checks)
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('cull') === '0') { C.sees = () => true; C.seesRoom = () => true; }
  return C;
}
