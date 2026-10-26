// @ts-check
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
// Collapse a prop group into as few meshes as possible so poking it (screening-poke.js) costs ~1 draw call:
// plain-coloured parts that share a material type/emissive/transparency become ONE vertex-coloured mesh; textured parts
// keep their own material. No shadow casting (static props here don't cast either). Used by hackers/computer/tavern/inception.

/** @param {any} g @returns {any} */
export function solid1(g) {
  g.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(g.matrixWorld).invert(), by = new Map(), drop = [];
  g.traverse((/** @type {any} */ o) => { if (!o.isMesh || o === g) return; const m = o.material;
    const key = m.map ? m.uuid : [m.type, m.emissive ? m.emissive.getHexString() : '', m.transparent, m.side, m.toneMapped].join('|');
    const geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    const n = geo.attributes.position.count;
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
    if (!m.map) { const c = new Float32Array(n * 3); for (let i = 0; i < n; i++) { c[i * 3] = m.color.r; c[i * 3 + 1] = m.color.g; c[i * 3 + 2] = m.color.b; } geo.setAttribute('color', new THREE.Float32BufferAttribute(c, 3)); }
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    if (!by.has(key)) by.set(key, { m, gs: [] }); by.get(key).gs.push(geo); drop.push(o); });
  for (const o of drop) o.removeFromParent();
  for (const c of [...g.children]) if (!c.isMesh) g.remove(c);
  for (const { m, gs } of by.values()) {
    let mm = m; if (!m.map) { mm = m.clone(); mm.vertexColors = true; mm.color = new THREE.Color('#ffffff'); }
    const out = new THREE.Mesh(mergeGeometries(gs, false), mm); out.castShadow = false; out.receiveShadow = true; g.add(out); }
  g.userData.live = true; return g;
}
