// @ts-check
// Renders bust portraits of a look into a data URL with a small offscreen renderer (cached).
import * as THREE from 'three';
import { Avatar } from './avatar.js';

let R = null; const cache = new Map();
/** @param {any} A @param {any} look @param {string} bg */
export function portrait(A, look, bg = '#f6dfe8') {
  const key = JSON.stringify(look) + bg; if (cache.has(key)) return cache.get(key);
  if (!R) { R = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); R.setSize(256, 256); R.setPixelRatio(1); R.toneMapping = THREE.ACESFilmicToneMapping; R.outputColorSpace = THREE.SRGBColorSpace; }
  const sc = new THREE.Scene(); sc.add(new THREE.HemisphereLight('#fff6ee', '#c9a9b8', 1.6));
  const k = new THREE.DirectionalLight('#fff1dc', 2.2); k.position.set(1.5, 2.5, 3); sc.add(k);
  const rim = new THREE.DirectionalLight('#ffb3c7', 1.4); rim.position.set(-2, 2, -2); sc.add(rim);
  const av = new Avatar(A, look); av.play('Idle'); av.mixer.update(0.4); av.root.rotation.y = 0.35; sc.add(av.root); av.root.updateMatrixWorld(true);
  const hp = new THREE.Vector3(); av.bones.head.getWorldPosition(hp); const fy = hp.y + 0.38 * (look.scale?.head || 1);
  const cam = new THREE.PerspectiveCamera(24, 1, 0.1, 20); cam.position.set(0.25, fy + 0.1, 2.9); cam.lookAt(0, fy, 0);
  R.setClearColor(0x000000, 0); R.render(sc, cam);
  const url = R.domElement.toDataURL('image/png'); cache.set(key, url);
  av.root.traverse(o => { if (o.isMesh) o.material.dispose(); });
  return url;
}
