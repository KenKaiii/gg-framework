// @ts-check
// Loads the inlined KayKit GLBs (meshopt) and exposes character parts, shared clips and furniture templates.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import knight from './assets/knight.glb';
import mage from './assets/mage.glb';
import rogue from './assets/rogue.glb';
import barbarian from './assets/barbarian.glb';
import hooded from './assets/rogue_hooded.glb';
import furniture from './assets/furniture.glb';

const SRC = { knight, mage, rogue, barbarian, hooded };

/** @param {GLTFLoader} loader @param {Uint8Array} bytes */
function parse(loader, bytes) {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Promise((res, rej) => loader.parse(buf, '', res, rej));
}

/** @returns {Promise<{chars: Record<string, any>, clips: THREE.AnimationClip[], furniture: Record<string, THREE.Object3D>}>} */
export async function loadAssets() {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const chars = {};
  for (const k of Object.keys(SRC).sort()) chars[k] = await parse(loader, SRC[k]);
  const clips = chars.knight.animations;
  const f = await parse(loader, furniture);
  const fur = {};
  for (const c of f.scene.children) {
    c.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    fur[c.name] = c;
  }
  return { chars, clips, furniture: fur };
}

/** Clone a furniture template. @param {Record<string, THREE.Object3D>} fur @param {string} name */
export function furn(fur, name) {
  const t = fur[name];
  if (!t) throw new Error('no furniture ' + name);
  const o = t.clone(true);
  o.position.set(0, 0, 0); o.rotation.set(0, 0, 0);
  return o;
}
