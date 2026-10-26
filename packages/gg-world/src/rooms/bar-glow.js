// @ts-check
// Fake light bounce for the ground-floor rooms, roof + basement (shared helper, owned with bar/den/bedroom/kitchen/
// studio/roof/basement): every light in the room's lightRig gets a soft additive pool on the floor (and a wall wash when
// it hangs near a wall), every window drops a moonlight patch, plus per-room extras (screen/neon glows). Wall-hung
// items can get a soft dark shadow plane. Everything is ONE static mesh per kind (glow: additive, shade: dark), so it
// costs 1-2 draw calls, never changes at runtime and cannot flicker. No lights added.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

let TEX = null;
function tex() {
  if (TEX) return TEX;
  const c = document.createElement('canvas'); c.width = c.height = 64; const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  const img = x.createImageData(64, 64);
  for (let y = 0; y < 64; y++) for (let i = 0; i < 64; i++) { const r = Math.min(1, Math.hypot(i - 31.5, y - 31.5) / 32), a = (1 - r) * (1 - r) * (1 + r * 0.5);
    const k = (y * 64 + i) * 4; img.data[k] = img.data[k + 1] = img.data[k + 2] = 255; img.data[k + 3] = Math.round(255 * Math.min(1, a)); }
  x.putImageData(img, 0, 0); TEX = new THREE.CanvasTexture(c); TEX.colorSpace = THREE.NoColorSpace; return TEX;
}

/**
 * @typedef {{ at: number[], w: number, h: number, c?: string, a: number, face?: 'up'|'n'|'s'|'e'|'w'|number, shade?: boolean }} Spot
 *  at = centre (room-local), face: 'up' = floor/desk (default), n/s/e/w = on that wall's inner face, number = yaw of a vertical plane
 */
/** @param {any} R @param {Spot[]} extra @param {{ pools?: number, moon?: number, skip?: number[], auto?: boolean }} [o] */
export function roomGlow(R, extra = [], o = {}) {
  const w = R.w, d = R.d, spots = /** @type {Spot[]} */ ([]);
  const pk = o.pools ?? 1;
  (R.rig?.points || []).forEach((p, i) => { if (!p.intensity || o.skip?.includes(i)) return;
    const c = '#' + p.color.getHexString(), r = Math.min(2.4, p.distance * 0.3), a = Math.min(0.2, 0.05 + p.intensity * 0.008) * pk;
    spots.push({ at: [p.position.x, 0.03, p.position.z], w: r * 2, h: r * 2, c, a });
    const near = [['n', p.position.z + d / 2], ['s', d / 2 - p.position.z], ['w', p.position.x + w / 2], ['e', w / 2 - p.position.x]].filter(([, k]) => /** @type {number} */ (k) < 1.3);
    for (const [side] of near) spots.push({ at: [p.position.x, Math.max(1.1, p.position.y), p.position.z], w: r * 1.6, h: 2.4, c, a: a * 0.8, face: /** @type {any} */ (side) }); });
  for (const win of R.windows || []) { const s = win.side, ww = win.w, a = 0.1 * (o.moon ?? 1); if (!a) continue;
    const at = s === 'n' ? [win.at, 0.03, -d / 2 + 1.1] : s === 's' ? [-win.at, 0.03, d / 2 - 1.1] : s === 'e' ? [w / 2 - 1.1, 0.03, win.at] : [-w / 2 + 1.1, 0.03, -win.at];
    const along = s === 'n' || s === 's'; spots.push({ at, w: along ? ww * 1.3 : 1.8, h: along ? 1.8 : ww * 1.3, c: '#8fa8ff', a }); }
  spots.push(...extra);
  if (o.auto !== false) spots.push(...autoSpots(R, spots));
  const build = (list, shade) => {
    if (!list.length) return;
    const pos = [], uv = [], col = [], idx = []; let n = 0; const col3 = new THREE.Color(), v = new THREE.Vector3();
    for (const s of list) {
      const f = s.face ?? 'up', hw = s.w / 2, hh = s.h / 2; let [x, y, z] = s.at;
      // wall faces: snap onto the inner wall surface (2 cm off) so the wash sits ON the wall
      let ry = 0; if (f === 'n') { z = -d / 2 + 0.02; ry = 0; } else if (f === 's') { z = d / 2 - 0.02; ry = Math.PI; } else if (f === 'w') { x = -w / 2 + 0.02; ry = Math.PI / 2; } else if (f === 'e') { x = w / 2 - 0.02; ry = -Math.PI / 2; } else if (typeof f === 'number') ry = f;
      col3.set(s.c || '#000000'); const k = shade ? 1 : s.a;
      for (const [u, vv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        if (f === 'up') v.set(u * hw, 0, -vv * hh); else v.set(u * hw, vv * hh, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
        pos.push(x + v.x, y + v.y, z + v.z); uv.push((u + 1) / 2, (vv + 1) / 2);
        if (shade) col.push(0.02, 0.012, 0.04, s.a); else col.push(col3.r * k, col3.g * k, col3.b * k, 1); }
      idx.push(n, n + 1, n + 2, n, n + 2, n + 3); n += 4;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4)); g.setIndex(idx); g.computeBoundingSphere();
    const m = new THREE.MeshBasicMaterial({ map: tex(), vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, toneMapped: !shade,
      blending: shade ? THREE.NormalBlending : THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 });
    const mesh = new THREE.Mesh(g, m); mesh.name = shade ? 'wall-shade' : 'light-glow'; mesh.renderOrder = shade ? -4 : -3; mesh.userData.noGround = true;
    mesh.castShadow = mesh.receiveShadow = false; mesh.matrixAutoUpdate = false; mesh.raycast = () => {}; R.root.add(mesh); return mesh;
  };
  // floor/desk glows: one mesh. Wall washes + wall shades: one mesh per wall, parented to that wall so they hide with it
  // when the camera cuts the wall away (otherwise they'd float in mid-air).
  const isWall = s => typeof s.face === 'string' && s.face !== 'up';
  build(spots.filter(s => !s.shade && !isWall(s)), false); build(spots.filter(s => s.shade && !isWall(s)), true);
  for (const side of ['n', 's', 'e', 'w']) for (const sh of [false, true]) {
    const m = build(spots.filter(s => isWall(s) && s.face === side && !!s.shade === sh), sh); const wall = R.walls?.[side]?.full; if (!m || !wall) continue;
    // after finish()'s bake/colour-merge microtask, so the wall merge never swallows it
    queueMicrotask(() => queueMicrotask(() => { R.root.updateMatrixWorld(true); m.matrixAutoUpdate = true; wall.attach(m); m.updateMatrix(); m.matrixAutoUpdate = false; }));
  }
}

/**
 * Depth pass, derived from what the room already has (no hand-placed numbers):
 *  - every wall-hung item (R.walls[side].decor) is nudged >= 3 cm off the wall and gets a soft dark shadow plane behind
 *    it, offset down a little (light comes from above); glowing items (additive / emissive planes) get a coloured wash instead
 *  - every halo sprite low enough to be a lamp/screen (FX.glow) gets a warm/coloured floor pool under it, plus a wall
 *    wash when it sits near a wall, unless a rig light already pools there
 * @param {any} R @param {Spot[]} have @returns {Spot[]}
 */
function autoSpots(R, have) {
  const out = /** @type {Spot[]} */ ([]), w = R.w, d = R.d, inv = new THREE.Matrix4(), b = new THREE.Box3(), v = new THREE.Vector3(), c = new THREE.Color();
  R.root.updateMatrixWorld(true); inv.copy(R.root.matrixWorld).invert();
  const glowy = o => { const ms = Array.isArray(o.material) ? o.material : [o.material]; return ms.some(m => m && (m.blending === THREE.AdditiveBlending || (m.emissiveIntensity > 0.8 && m.emissive?.getHex()) || (m.isMeshBasicMaterial && m.toneMapped === false))); };
  for (const side of ['n', 's', 'e', 'w']) {
    const decor = R.walls?.[side]?.decor; if (!decor) continue;
    for (const obj of decor.children) {
      if (obj.position.z < 0.03) obj.position.z = 0.03;
      b.makeEmpty(); let lit = null, solid = false; obj.updateMatrixWorld(true);
      obj.traverse(m => { if (!m.isMesh || !m.visible) return; if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        b.union(m.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)));
        if (glowy(m)) lit = lit || (m.material.color ? '#' + m.material.color.getHexString() : null); else solid = true; });
      if (b.isEmpty()) continue; b.getCenter(v); const sx = b.max.x - b.min.x, sz = b.max.z - b.min.z, sy = b.max.y - b.min.y, along = side === 'n' || side === 's' ? sx : sz;
      if (along > 4 || sy > 2.6) continue;
      if (solid) out.push({ at: [v.x, v.y - 0.05, v.z], w: along + 0.22, h: sy + 0.24, a: 0.42, face: /** @type {any} */ (side), shade: true });
      if (lit && !solid) { c.set(lit); out.push({ at: [v.x, v.y, v.z], w: along * 1.5 + 0.4, h: sy * 1.6 + 0.5, c: '#' + c.getHexString(), a: 0.08, face: /** @type {any} */ (side) }); }
    }
  }
  const pooled = have.filter(s => (s.face ?? 'up') === 'up').map(s => s.at);
  R.root.traverse(sp => {
    if (!sp.isSprite || sp.material.blending !== THREE.AdditiveBlending || !sp.visible) return;
    v.setFromMatrixPosition(sp.matrixWorld).applyMatrix4(inv); const size = sp.scale.x; if (size < 0.5 || v.y < 0.3 || v.y > 2.4) return;
    if (pooled.some(p => Math.hypot(p[0] - v.x, p[2] - v.z) < 0.7)) return; pooled.push([v.x, 0, v.z]);
    const r = Math.min(1.5, 0.5 + size * 0.6), col = '#' + sp.material.color.getHexString(), a = Math.min(0.1, 0.12 * (sp.material.opacity ?? 0.5));
    out.push({ at: [v.x, 0.03, v.z], w: r * 2, h: r * 2, c: col, a });
    for (const [side, k] of [['n', v.z + d / 2], ['s', d / 2 - v.z], ['w', v.x + w / 2], ['e', w / 2 - v.x]]) if (/** @type {number} */ (k) < 0.9) out.push({ at: [v.x, v.y, v.z], w: r * 1.4, h: 1.8, c: col, a: a * 0.7, face: /** @type {any} */ (side) });
  });
  return out;
}

const PROP_MATS = new Map();
/**
 * Make a prop animatable for ~1 draw call: every plain opaque Standard mesh is merged into ONE vertex-coloured mesh (one
 * shared material per roughness/metalness pair); glowing/transparent/textured parts stay as they are. Marks it live and
 * names it so extras-rooms.js can find it. Returns the same group.
 * @param {THREE.Object3D} o @param {string} name
 */
export function liveProp(o, name) {
  o.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(o.matrixWorld).invert(), gs = [], drop = [], c = new THREE.Color(), m4 = new THREE.Matrix4();
  o.traverse(m => { const mt = /** @type {any} */ (m).material;
    if (!m.isMesh || m.isInstancedMesh || Array.isArray(mt) || !mt?.isMeshStandardMaterial || mt.map || mt.transparent || (mt.emissiveIntensity > 0 && mt.emissive.getHex())) return;
    let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone(); g.applyMatrix4(m4.multiplyMatrices(inv, m.matrixWorld));
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    c.copy(mt.color); const n = g.attributes.position.count, col = new Float32Array(n * 3); for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3)); gs.push(g); drop.push(m); });
  if (gs.length > 1) {
    const merged = mergeGeometries(gs, false);
    if (merged) { const key = 'p'; let mt = PROP_MATS.get(key); if (!mt) { mt = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.05 }); PROP_MATS.set(key, mt); }
      for (const m of drop) m.removeFromParent();
      const out = new THREE.Mesh(merged, mt); out.castShadow = false; out.receiveShadow = true; o.add(out); }
  }
  o.traverse(m => { m.castShadow = false; }); o.userData.live = true; o.name = name; return o; // small props: contact shadow from ground.js, no shadow-map pass
}
