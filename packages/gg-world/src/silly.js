// @ts-check
// Ridiculous bone-attached props built in code (head-bone local space, head mesh spans y≈0..1.1).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Merged geometry per (prop key, material slot): identical for every avatar, so built once and shared (never disposed). */
const geoCache = new Map();
/**
 * Collapse every mesh under `g` into one mesh per material (geometry baked into g's local space). Children are replaced.
 * @param {THREE.Object3D} g @param {string} [key] cache key: same key => same geometry, reused across calls
 */
export function mergeGroup(g, key) {
  /** @type {Map<THREE.Material, THREE.Mesh[]>} */ const by = new Map();
  g.traverse(o => { const m = /** @type {any} */ (o); if (m.isMesh && o !== g) { if (!by.has(m.material)) by.set(m.material, []); by.get(m.material).push(m); } });
  const out = []; let slot = 0;
  for (const [mat, ms] of by) {
    const ck = key && key + '#' + slot++; let geo = ck && geoCache.get(ck);
    if (!geo) {
      let gs = ms.map(m => {
        const M = new THREE.Matrix4(); for (let o = /** @type {THREE.Object3D|null} */ (m); o && o !== g; o = o.parent) { o.updateMatrix(); M.premultiply(o.matrix); }
        const c = m.geometry.clone().applyMatrix4(M); for (const n of Object.keys(c.attributes)) if (!['position', 'normal', 'uv'].includes(n)) c.deleteAttribute(n); return c;
      });
      if (gs.some(x => x.index) && gs.some(x => !x.index)) gs = gs.map(x => x.index ? x.toNonIndexed() : x);
      geo = gs.length === 1 ? gs[0] : mergeGeometries(gs, false);
      if (ms.length > 1) gs.forEach(x => x !== geo && x.dispose());
      if (ck) geoCache.set(ck, geo);
    }
    const o = new THREE.Mesh(geo, mat); o.castShadow = false; o.receiveShadow = false; out.push(o);
  }
  while (g.children.length) g.remove(g.children[0]);
  for (const o of out) g.add(o);
  return g;
}

/** @param {string} kind @param {any} bones @returns {THREE.Object3D[]} */
export function sillyProp(kind, bones) {
  // materials are per avatar (activities recolour them on a single avatar), but same colour+params within a prop share one
  const local = new Map();
  const M = (c, o = {}) => { const k = c + JSON.stringify(o); if (!local.has(k)) local.set(k, new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, ...o })); return local.get(k); };
  const g = new THREE.Group(); const out = [g]; let parent = bones.head;
  if (kind === 'cone') {
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.0, 20), M('#ff6b1a')); c.position.y = 1.55; g.add(c);
    for (const y of [1.35, 1.65]) { const s = new THREE.Mesh(new THREE.CylinderGeometry(0.42 - (y - 1.05) * 0.42, 0.42 - (y - 1.1) * 0.42, 0.1, 20), M('#ffffff')); s.position.y = y; g.add(s); }
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.07, 0.95), M('#ff6b1a')); b.position.y = 1.05; g.add(b); g.rotation.z = 0.15;
  } else if (kind === 'tinfoil') {
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.62, 0.8, 7, 2), M('#d8dde6', { metalness: 0.9, roughness: 0.35, flatShading: true })); c.position.y = 1.35; c.rotation.y = 0.4; g.add(c);
  } else if (kind === 'clown') {
    const n = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), M('#ff1e1e', { roughness: 0.2 })); n.position.set(0, 0.5, 0.6); g.add(n);
  } else if (kind === 'moustache') {
    for (const s of [-1, 1]) { const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.42, 4, 10), M('#3a2416')); m.rotation.z = s * 1.25; m.position.set(s * 0.26, 0.36 + 0.02, 0.58); g.add(m); const c = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.05, 6, 10, Math.PI * 1.3), M('#3a2416')); c.position.set(s * 0.52, 0.47, 0.55); c.rotation.z = s > 0 ? 0 : Math.PI * 0.7; g.add(c); }
  } else if (kind === 'duck') {
    const y = M('#ffd60a', { roughness: 0.3 }); const b = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), y); b.scale.set(1.2, 0.85, 1); b.position.y = 1.3; g.add(b);
    const hd = new THREE.Mesh(new THREE.SphereGeometry(0.19, 16, 12), y); hd.position.set(0, 1.62, 0.18); g.add(hd);
    const bk = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.2, 10), M('#ff8c1a')); bk.rotation.x = Math.PI / 2; bk.position.set(0, 1.6, 0.42); g.add(bk);
    for (const s of [-1, 1]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.035), M('#111')); e.position.set(s * 0.09, 1.68, 0.33); g.add(e); }
  } else if (kind === 'sunglasses') {
    const k = M('#111', { roughness: 0.15, metalness: 0.4 });
    for (const s of [-1, 1]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.18, 0.05), k); l.position.set(s * 0.22, 0.64, 0.56); g.add(l); }
    const br = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.05, 0.05), k); br.position.set(0, 0.7, 0.56); g.add(br);
  } else if (kind === 'shades') {
    const k = M('#050505', { roughness: 0.1, metalness: 0.6 });
    for (const sx of [-1, 1]) { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.04, 20), k); l.rotation.x = Math.PI / 2; l.position.set(sx * 0.2, 0.7, 0.57); g.add(l); }
    const br = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.015, 6, 12, Math.PI), k); br.position.set(0, 0.72, 0.58); g.add(br);
  } else if (kind === 'coat') {
    parent = bones.chest; const cm = M('#16171c', { side: THREE.DoubleSide, roughness: 0.55 });
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.78, 1.7, 14, 1, true, Math.PI * 0.62, Math.PI * 1.76), cm); c.position.set(0, -0.75, -0.02); g.add(c);
    const col = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.07, 6, 16), cm); col.rotation.x = Math.PI / 2; col.position.y = 0.15; g.add(col);
  } else if (kind === 'cape') {
    parent = bones.chest; const c = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.5, 1, 4), M('#c1121f', { side: THREE.DoubleSide })); c.position.set(0, -0.2, -0.45); c.rotation.x = 0.18; g.add(c);
    const col = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.06, 6, 16), M('#ffd60a')); col.rotation.x = Math.PI / 2; col.position.set(0, 0.5, -0.05); g.add(col);
  }
  mergeGroup(g, 'silly-' + kind); g.userData.ownMaterials = [...local.values()]; parent.add(g); return out;
}
export const SILLY = ['cone', 'tinfoil', 'clown', 'moustache', 'duck', 'sunglasses', 'cape', 'shades', 'coat'];
