// @ts-check
// Auto-collision: anything solid standing on the floor blocks walking, so nobody walks through furniture.
// Runs from R.finish() (before the static merge), for every room. Hand-written R.block() calls stay; this fills the gaps
// (the owner found a hospital bed / keyboard stand you could walk through, and asked for every instance to be fixed).
// What counts: an opaque mesh (or instance) whose world box starts low (bottom < 0.5 m, so tables/beds/stands count but
// shelves and lamps on the wall don't), is tall enough to bump into (top > 0.18 m) and has a real footprint.
// What doesn't: rugs/decals/floor paint, thin flat things, transparent/additive glow, anything under R.live that moves,
// things tagged userData.walkable = true (e.g. a stage you step onto), and seat cells (slots must stay reachable).
// Each box is shrunk by a margin so characters can still squeeze alongside furniture; cells are 0.5 m (grid.js).
import * as THREE from 'three';

const solid = o => { if (!o.isMesh || o.isSkinnedMesh) return false; for (let a = o; a; a = a.parent) if (a.visible === false || a.userData?.walkable || a.userData?.noBlock) return false;
  const ms = Array.isArray(o.material) ? o.material : [o.material]; return ms.every(m => m && !m.transparent && m.blending === THREE.NormalBlending && m.colorWrite !== false) && !o.userData.floor; };

/** @param {any} R room (before bake) */
export function autoBlock(R) {
  if (/[?&]noblock/.test(location.search)) return; // A/B
  if (!R.grid || !R.static) return;
  R.root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(R.root.matrixWorld).invert(), m4 = new THREE.Matrix4(), bb = new THREE.Box3();
  const keepFree = (R.slots || []).map(s => [s.x, s.z]); // seats + standing spots stay walkable
  const exits = (R.exits || []).map(e => [e.door.x, e.door.z]);
  const boxes = [];
  // one footprint per piece of FURNITURE (a top-level group: a bed = top + legs + mattress), not per mesh: a table top
  // sits 0.75 m up on thin legs, so per-mesh it looked like "wall-hung" + "thin rails" and got skipped (owner's bed bug)
  const boxOf = (obj) => { const box = new THREE.Box3(); let any = false;
    obj.traverse(o => { if (!solid(o)) return; const g = o.geometry; if (!g?.attributes?.position) return; if (!g.boundingBox) g.computeBoundingBox();
      if (o.isInstancedMesh) return; // instances are handled one by one below
      bb.copy(g.boundingBox).applyMatrix4(m4.multiplyMatrices(inv, o.matrixWorld)); box.union(bb); any = true; });
    return any ? box : null; };
  const consider = (b) => { const h = b.max.y - b.min.y, sx = b.max.x - b.min.x, sz = b.max.z - b.min.z;
    if (b.min.y > 0.5 || b.max.y < 0.18 || h < 0.12) return;            // wall-hung / floor decals / flat
    if (sx < 0.12 && sz < 0.12) return;                                  // tiny bits (cans, cups)
    if (sx > R.w * 0.8 || sz > R.d * 0.8) return;                        // room-sized slabs
    if (Math.min(sx, sz) < 0.05 && h < 1.2) return;                      // thin cables / rails at ankle height
    boxes.push(b); };
  const visit = (obj, depth) => { if (!obj.visible || obj.userData?.walkable || obj.userData?.noBlock || obj.userData?.floor) return;
    if (obj.isInstancedMesh) { if (!solid(obj)) return; const g = obj.geometry; if (!g.boundingBox) g.computeBoundingBox();
      for (let k = 0; k < obj.count; k++) { const im = new THREE.Matrix4(); obj.getMatrixAt(k, im); consider(g.boundingBox.clone().applyMatrix4(m4.multiplyMatrices(inv, new THREE.Matrix4().multiplyMatrices(obj.matrixWorld, im)))); } return; }
    const b = boxOf(obj);
    // big bundles (a whole zone of props in one group) -> look at their children instead
    if (!obj.isMesh && depth < 3 && obj.children.length && (!b || (b.max.x - b.min.x) * (b.max.z - b.min.z) > 4.5)) { for (const ch of obj.children) visit(ch, depth + 1); return; }
    if (b) consider(b);
    for (const ch of obj.children) if (ch.isInstancedMesh) visit(ch, depth + 1); };
  for (const ch of R.static.children) visit(ch, 0);
  const G = R.grid, CELL = 0.5; let n = 0;
  for (const b of boxes) {
    const m = 0.12; // margin: shrink the footprint so edges don't over-block
    const x0 = b.min.x + m, x1 = b.max.x - m, z0 = b.min.z + m, z1 = b.max.z - m; if (x1 <= x0 && z1 <= z0) continue;
    for (let j = G.iz(Math.min(z0, z1)); j <= G.iz(Math.max(z0, z1)); j++) for (let i = G.ix(Math.min(x0, x1)); i <= G.ix(Math.max(x0, x1)); i++) {
      if (i < 0 || j < 0 || i >= G.w || j >= G.h) continue; const k = j * G.w + i; if (G.block[k]) continue;
      const cx = G.cx(i), cz = G.cz(j);
      // the cell must actually overlap the footprint by a fair share (not just graze it)
      const ox = Math.min(cx + CELL / 2, Math.max(x0, x1)) - Math.max(cx - CELL / 2, Math.min(x0, x1)), oz = Math.min(cz + CELL / 2, Math.max(z0, z1)) - Math.max(cz - CELL / 2, Math.min(z0, z1));
      if (ox < CELL * 0.35 || oz < CELL * 0.35) continue;
      if (keepFree.some(([sx, sz]) => Math.abs(sx - cx) < 0.3 && Math.abs(sz - cz) < 0.3)) continue;
      if (exits.some(([ex, ez]) => Math.hypot(ex - cx, ez - cz) < 1.0)) continue;
      G.block[k] = 1; n++; }
  }
  // the room's spawn point must stay free
  if (R.spawn && !G.free(R.spawn.x, R.spawn.z)) { const i = G.ix(R.spawn.x), j = G.iz(R.spawn.z); G.block[j * G.w + i] = 0; }
  R.autoBlocked = n;
}
