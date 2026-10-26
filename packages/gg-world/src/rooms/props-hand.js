// @ts-check
// Small props characters hold or use in slots: laptop (on lap, screen glows), controller, beer, cocktail, phone, mug.
// Attached to KayKit Rig_Medium bones (hips / handslot.r / handslot.l). Sizes are in rig units (rig is scaled 0.72).
import * as THREE from 'three';
import { mat, glowMat, rbox } from './kit.js';
import * as TX from './tex.js';
import { mergeGroup } from '../silly.js';

/** Shared materials (same for every holder); kit's mat/glowMat already cache, these are the extra ones. */
const shared = new Map();
const once = (k, f) => { if (!shared.has(k)) shared.set(k, f()); return shared.get(k); };
const SCREENS = 4;

/** @param {any} av Avatar @param {'laptop'|'controller'|'beer'|'drink'|'cocktail'|'phone'|'mug'|string} kind */
/**
 * Show one hand prop on an avatar, hiding the others. Props are built once per avatar and kind, then reused
 * (swapping laptop -> beer -> laptop used to rebuild and leak geometry every time).
 * @param {any} av @param {string|null} kind null = hide all
 */
export function holdProp(av, kind) {
  const cache = av.root.userData.props || (av.root.userData.props = {});
  for (const k in cache) cache[k].visible = k === kind;
  if (kind && !cache[kind]) { const g = attachProp(av, kind); if (g) cache[kind] = g; }
  return kind ? cache[kind] : null;
}
export function attachProp(av, kind) {
  const g = new THREE.Group(); g.name = 'prop-' + kind;
  if (kind === 'laptop') {
    const base = rbox(0.62, 0.035, 0.42, mat('#2a2a33', { roughness: 0.4, metalness: 0.3 }), 0.015); g.add(base);
    const lid = new THREE.Group(); lid.position.set(0, 0.02, -0.2); lid.rotation.x = -1.85; g.add(lid);
    const lb = rbox(0.62, 0.42, 0.025, mat('#2a2a33', { roughness: 0.4, metalness: 0.3 }), 0.012); lb.position.y = 0.21; lid.add(lb);
    const v = Math.abs(av.t * 100 | 0) % SCREENS;
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.36), once('scr' + v, () => new THREE.MeshBasicMaterial({ map: TX.codeScreen(v * 37 + 5, '#3ddc84') }))); scr.position.set(0, 0.21, 0.014); lid.add(scr);
    g.position.set(0, 0.62, 0.55); (av.bones.hips || av.rig).add(g);
  } else if (kind === 'controller') {
    const body = rbox(0.34, 0.07, 0.16, mat('#d8d4e8', { roughness: 0.5 }), 0.03); g.add(body);
    for (const s of [-1, 1]) { const grip = rbox(0.1, 0.08, 0.16, mat('#d8d4e8', { roughness: 0.5 }), 0.04); grip.position.set(s * 0.15, -0.01, 0.05); g.add(grip); }
    const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.02, 10), mat('#7b5cff')); btn.position.set(0.09, 0.045, -0.02); g.add(btn);
    g.position.set(-0.1, 0.05, 0.05); g.rotation.set(0, 0, Math.PI / 2); ((av.bones['handslot.r'] || av.bones['handslotr']) || av.rig).add(g);
  } else if (kind === 'beer' || kind === 'drink') {
    const glass = once('beer', () => new THREE.MeshStandardMaterial({ color: '#3e6b2e', roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.85 }));
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.07, 0.3, 14), glass); b.position.y = 0.1; g.add(b);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.06, 0.12, 12), glass); neck.position.y = 0.31; g.add(neck);
    const lab = new THREE.Mesh(new THREE.CylinderGeometry(0.071, 0.071, 0.1, 14, 1, true), mat('#e9d8a6')); lab.position.y = 0.08; g.add(lab);
    ((av.bones['handslot.r'] || av.bones['handslotr']) || av.rig).add(g);
  } else if (kind === 'cocktail') {
    const gm = once('cocktail', () => new THREE.MeshStandardMaterial({ color: '#cfe8ff', roughness: 0.05, transparent: true, opacity: 0.45 }));
    const cup = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.13, 16, 1, true), gm); cup.rotation.x = Math.PI; cup.position.y = 0.2; g.add(cup);
    const liquid = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.1, 16), glowMat('#3ddc84', 0.9)); liquid.rotation.x = Math.PI; liquid.position.y = 0.21; g.add(liquid);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.14, 8), gm); stem.position.y = 0.07; g.add(stem);
    ((av.bones['handslot.r'] || av.bones['handslotr']) || av.rig).add(g);
  } else if (kind === 'phone') {
    const p = rbox(0.09, 0.18, 0.015, mat('#111'), 0.01); g.add(p); const s = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.16), glowMat('#8fd3ff', 0.8)); s.position.z = 0.009; g.add(s);
    g.rotation.x = -0.6; ((av.bones['handslot.l'] || av.bones['handslotl']) || av.rig).add(g);
  } else if (kind === 'mug') {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.065, 0.14, 14), mat('#1f2a24')); m.position.y = 0.07; g.add(m);
    ((av.bones['handslot.r'] || av.bones['handslotr']) || av.rig).add(g);
  }
  // one mesh per material, geometry shared across holders (laptop screens: one per variant)
  mergeGroup(g, 'hand-' + kind);
  return g;
}
