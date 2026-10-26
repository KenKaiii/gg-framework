// @ts-check
// Grounding: soft contact shadows + wall-base shading, so furniture SITS in the room instead of floating on it.
// Runs automatically from R.finish() (before the static merge), for every room. One merged mesh per room = 1 draw call,
// no lights, no shadow-map cost, never changes at runtime (so it can't flicker).
//  - every opaque object standing on (or just above) the floor gets a soft rounded-rect shadow a bit larger than its
//    footprint; darker the closer its bottom is to the floor (a table top 0.75 m up still shades the floor faintly)
//  - instanced furniture gets one shadow per instance
//  - a soft dark strip runs along the base of every wall (inside the room), skipping openings
// Opt out per object: obj.userData.noGround = true. Tune per object: obj.userData.ground = { k: 0..2 (strength), pad: m }.
import * as THREE from 'three';

let ATLAS = null;
function atlas() {
  if (ATLAS) return ATLAS;
  const c = document.createElement('canvas'); c.width = 128; c.height = 64; const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  // left: soft rounded rect (alpha = shade), right: vertical gradient for wall bases
  const img = x.createImageData(128, 64);
  for (let y = 0; y < 64; y++) for (let i = 0; i < 64; i++) {
    const u = Math.abs(i - 31.5) / 32, v = Math.abs(y - 31.5) / 32; const m = Math.pow(Math.pow(u, 4) + Math.pow(v, 4), 0.25); // superellipse
    const a = Math.max(0, Math.min(1, (1 - m) / 0.55)); const k = (y * 128 + i) * 4; img.data[k + 3] = Math.round(255 * a * a * (3 - 2 * a));
    const g = 1 - y / 63; const k2 = (y * 128 + 64 + i) * 4; img.data[k2 + 3] = Math.round(255 * g * g);
  }
  x.putImageData(img, 0, 0);
  ATLAS = new THREE.CanvasTexture(c); ATLAS.colorSpace = THREE.NoColorSpace; return ATLAS;
}

const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _b = new THREE.Box3(), _v = new THREE.Vector3();
const opaque = o => { const ms = Array.isArray(o.material) ? o.material : [o.material]; return ms.every(m => m && !m.transparent && m.blending === THREE.NormalBlending && m.visible !== false && m.colorWrite !== false); };

/** footprint of obj in its own frame (x/z extents, y bottom/top), from opaque meshes only; null if nothing solid */
function localBox(obj) {
  obj.updateMatrixWorld(true); _inv.copy(obj.matrixWorld).invert(); const box = new THREE.Box3(); let any = false;
  obj.traverse(o => { if (!o.isMesh || o.isInstancedMesh || o.userData.noGround || !o.visible || !opaque(o)) return; const g = o.geometry; if (!g.boundingBox) g.computeBoundingBox();
    _b.copy(g.boundingBox).applyMatrix4(_m.multiplyMatrices(_inv, o.matrixWorld)); box.union(_b); any = true; });
  return any ? box : null;
}

/** @param {any} R room */
export function groundShade(R) {
  if (R.noGround) return;
  const pos = [], uv = [], col = [], idx = []; let n = 0;
  const quad = (cx, cz, hx, hz, ry, a, u0, u1, y = 0.022) => { // a = shade 0..1, uvs in atlas; ry = yaw
    const c = Math.cos(ry), s = Math.sin(ry);
    for (const [px, pz, uu, vv] of [[-hx, -hz, u0, 1], [hx, -hz, u1, 1], [hx, hz, u1, 0], [-hx, hz, u0, 0]]) { pos.push(cx + px * c + pz * s, y, cz - px * s + pz * c); uv.push(uu, vv); col.push(a, a, a); }
    idx.push(n, n + 2, n + 1, n, n + 3, n + 2); n += 4; };
  const roomInv = new THREE.Matrix4(); R.root.updateMatrixWorld(true); roomInv.copy(R.root.matrixWorld).invert();
  const yaw = m => { const e = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().extractRotation(m), 'YXZ'); return e.y; };
  const shadeFor = (bx, ex, bottom, height, k) => { // footprint half-extents -> quad size + strength
    if (height < 0.06 && bottom < 0.06) return null;                 // rugs, decals, floor paint
    if (bottom > 1.1 || bx * ex * 4 > 40) return null;                // wall shelves / ceiling stuff, giant platforms
    const lift = Math.max(0, bottom); const a = Math.min(0.78, (0.7 - lift * 0.5) * k) * Math.min(1, 0.4 + height * 1.2);
    const pad = 0.12 + lift * 0.35; return a > 0.04 ? { hx: bx + pad, hz: ex + pad, a } : null; };
  const add = (obj, depth) => {
    if (obj.userData.noGround || obj.userData.floor || !obj.visible) return;
    if (obj.isInstancedMesh) { if (!opaque(obj)) return; const g = obj.geometry; if (!g.boundingBox) g.computeBoundingBox(); obj.updateMatrixWorld(true);
      for (let i = 0; i < obj.count; i++) { obj.getMatrixAt(i, _m); const wm = new THREE.Matrix4().multiplyMatrices(obj.matrixWorld, _m); const lm = new THREE.Matrix4().multiplyMatrices(roomInv, wm);
        const bb = g.boundingBox, sc = new THREE.Vector3().setFromMatrixScale(lm); _v.set((bb.min.x + bb.max.x) / 2, bb.min.y, (bb.min.z + bb.max.z) / 2).applyMatrix4(lm);
        const sh = shadeFor((bb.max.x - bb.min.x) / 2 * sc.x, (bb.max.z - bb.min.z) / 2 * sc.z, _v.y, (bb.max.y - bb.min.y) * sc.y, 1); if (sh) quad(_v.x, _v.z, sh.hx, sh.hz, yaw(lm), sh.a, 0, 0.5); }
      return; }
    // plain groups that just bundle many pieces (a whole zone) -> look inside instead
    if (!obj.isMesh && depth < 2 && obj.children.length > 6) { const lb = localBox(obj); if (!lb || (lb.max.x - lb.min.x) * (lb.max.z - lb.min.z) > 6) { for (const ch of obj.children) add(ch, depth + 1); return; } }
    const lb = localBox(obj); if (!lb) { if (!obj.isMesh) for (const ch of obj.children) if (ch.isInstancedMesh) add(ch, depth + 1); return; }
    const lm = new THREE.Matrix4().multiplyMatrices(roomInv, obj.matrixWorld); const sc = new THREE.Vector3().setFromMatrixScale(lm);
    _v.set((lb.min.x + lb.max.x) / 2, lb.min.y, (lb.min.z + lb.max.z) / 2).applyMatrix4(lm);
    const k = obj.userData.ground?.k ?? 1, sh = shadeFor((lb.max.x - lb.min.x) / 2 * sc.x, (lb.max.z - lb.min.z) / 2 * sc.z, _v.y, (lb.max.y - lb.min.y) * sc.y, k);
    if (sh) quad(_v.x, _v.z, sh.hx + (obj.userData.ground?.pad || 0), sh.hz + (obj.userData.ground?.pad || 0), yaw(lm), sh.a, 0, 0.5);
    for (const ch of obj.children) if (ch.isInstancedMesh) add(ch, depth + 1);
  };
  for (const ch of [...R.static.children, ...R.live.children]) add(ch, 0);
  // wall bases: every side, inside the room, minus floor-level openings
  const w = R.w, d = R.d, ops = [...(R.passages || []), ...(R.doors || []), ...((R.info?.passages || []).filter(p => R.info.shared?.[p.side] && !R.info.shared[p.side].draw))];
  for (const side of ['n', 's', 'w', 'e']) {
    const len = side === 'n' || side === 's' ? w : d; const cuts = ops.filter(p => p.side === side).map(p => [p.at - p.w / 2 - 0.15, p.at + p.w / 2 + 0.15]).sort((a, b) => a[0] - b[0]);
    const runs = []; let c = -len / 2; for (const [a, b] of cuts) { if (a > c) runs.push([c, a]); c = Math.max(c, b); } if (len / 2 > c) runs.push([c, len / 2]);
    const W2 = 0.55; // strip depth into the room
    for (const [a0, a1] of runs) { if (a1 - a0 < 0.1) continue; const m = (a0 + a1) / 2, hl = (a1 - a0) / 2;
      // along-wall coordinate `at` follows floorplan.js: n/s walls run along x (s reversed), e/w along z (w reversed)
      if (side === 'n') quad(m, -d / 2 + W2 / 2, hl, W2 / 2, 0, 0.42, 0.5, 1, 0.021);
      if (side === 's') quad(-m, d / 2 - W2 / 2, hl, W2 / 2, Math.PI, 0.42, 0.5, 1, 0.021);
      if (side === 'e') quad(w / 2 - W2 / 2, m, hl, W2 / 2, -Math.PI / 2, 0.42, 0.5, 1, 0.021);
      if (side === 'w') quad(-w / 2 + W2 / 2, -m, hl, W2 / 2, Math.PI / 2, 0.42, 0.5, 1, 0.021); }
  }
  if (!n) return;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeBoundingSphere();
  // shade strength rides in the vertex colour (r); the shader multiplies the atlas alpha by it
  const mtl = new THREE.MeshBasicMaterial({ color: '#05030a', map: atlas(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, toneMapped: false });
  mtl.onBeforeCompile = sh => { sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 color;\nvarying float vShade;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvShade = color.r;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vShade;').replace('#include <map_fragment>', 'diffuseColor.a *= texture2D( map, vMapUv ).a * vShade;'); };
  mtl.customProgramCacheKey = () => 'ground-shade';
  const mesh = new THREE.Mesh(g, mtl); mesh.name = 'ground-shade'; mesh.renderOrder = -5; mesh.castShadow = mesh.receiveShadow = false; mesh.userData.noGround = true;
  mesh.matrixAutoUpdate = false; R.root.add(mesh); R.groundShade = mesh;
}
