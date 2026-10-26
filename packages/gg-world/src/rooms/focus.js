// @ts-check
// Hover focus: put the hover ring / glow ON the thing you can use, not on its hotspot. Hotspots (R.interact x/z) are
// where the player stands to use something, often a metre in front of it; the owner saw rings floating beside tables.
// Runs from R.finish() (before the static merge): for every hotspot, find the object it belongs to among the room's
// pieces (static + live), and store it.vx / it.vz (room coords), it.vr (ring radius) and it.vh (top height).
//  - small/medium objects: the ring circles the object (its footprint centre and size)
//  - long things (a bar counter, a bookshelf wall): the ring sits on the part of it nearest the hotspot
//  - nothing near (an empty-floor hotspot): unchanged, the ring stays on the hotspot
import * as THREE from 'three';

const solid = o => { if (!o.isMesh || o.isSkinnedMesh) return false; for (let a = o; a; a = a.parent) if (a.visible === false) return false;
  const ms = Array.isArray(o.material) ? o.material : [o.material]; return ms.some(m => m && m.visible !== false && !(m.transparent && m.depthWrite === false) && m.blending === THREE.NormalBlending); };

/** @param {any} R room (before bake) */
export function focusHotspots(R) {
  if (!R.interact?.length) return;
  R.root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(R.root.matrixWorld).invert(), m4 = new THREE.Matrix4(), bb = new THREE.Box3();
  const pieces = [];
  const boxOf = obj => { const box = new THREE.Box3(); let any = false;
    obj.traverse(o => { if (!solid(o) || o.isInstancedMesh) return; const g = o.geometry; if (!g?.attributes?.position) return; if (!g.boundingBox) g.computeBoundingBox();
      bb.copy(g.boundingBox).applyMatrix4(m4.multiplyMatrices(inv, o.matrixWorld)); box.union(bb); any = true; }); return any ? box : null; };
  const keep = b => { const sx = b.max.x - b.min.x, sz = b.max.z - b.min.z, h = b.max.y - b.min.y;
    return !(h < 0.05 && b.max.y < 0.08) && sx < R.w * 0.8 && sz < R.d * 0.8 && Math.max(sx, sz, h) > 0.25; };
  const visit = (obj, depth) => {
    if (!obj.visible || obj.userData?.floor) return;
    if (obj.isInstancedMesh) { if (!solid(obj)) return; const g = obj.geometry; if (!g.boundingBox) g.computeBoundingBox();
      for (let k = 0; k < obj.count; k++) { const im = new THREE.Matrix4(); obj.getMatrixAt(k, im); const b = g.boundingBox.clone().applyMatrix4(m4.multiplyMatrices(inv, new THREE.Matrix4().multiplyMatrices(obj.matrixWorld, im))); if (keep(b)) pieces.push(b); } return; }
    const b = boxOf(obj);
    // a bundle of many pieces (a whole corner of props): look inside it instead
    if (!obj.isMesh && depth < 3 && obj.children.length && (!b || (b.max.x - b.min.x) * (b.max.z - b.min.z) > 3.5)) { for (const ch of obj.children) visit(ch, depth + 1); return; }
    if (b && keep(b)) pieces.push(b);
    for (const ch of obj.children) if (ch.isInstancedMesh) visit(ch, depth + 1);
  };
  for (const ch of [...(R.static?.children || []), ...(R.live?.children || [])]) visit(ch, 0);
  // things hung on the walls (dartboards, posters, signs) live in the wall groups
  for (const ch of R.root.children) if (ch !== R.static && ch !== R.live && ch.isGroup) for (const g of ch.children) if (!g.userData?.floor) { const bx = boxOf(g); if (bx && keep(bx) && Math.min(bx.max.x - bx.min.x, bx.max.z - bx.min.z) < 0.4 && bx.min.y > 0.3) pieces.push(bx); }
  R._focusPieces = pieces; // plain boxes (a few KB): extras add hotspots after the merge, focusLate() places those
  placeHotspots(R);
}

/** place every hotspot that isn't placed yet (from the boxes kept by focusHotspots) */
export function placeHotspots(R) {
  const pieces = R._focusPieces || []; if (!pieces.length || !R.interact?.length) return;
  const WALL = /\b(tv|screen|monitor|poster|window|mirror|sign|neon|tag|graffiti|board|whiteboard|painting|photo|frame|clock|dartboard|map|menu|shelf|wall)s?\b/i;
  const FLOOR = /\b(dance|twist|floor|rug|carpet|mat)\b/i;
  for (const it of R.interact) {
    if (it.vx != null) continue; // set by hand in the room
    const words = `${it.id} ${it.label || ''} ${it.kind || ''}`.replace(/[-_]/g, ' ');
    const want = WALL.test(words) ? 'wall' : FLOOR.test(words) ? 'floor' : 'any';
    if (want === 'floor') continue; // a floor zone: the hotspot itself is the right place for the ring
    const reach = Math.max(1.3, (it.r || 1) * 1.4);
    let best = null, bestScore = 1e9;
    for (const b of pieces) {
      const cx = Math.max(b.min.x, Math.min(it.x, b.max.x)), cz = Math.max(b.min.z, Math.min(it.z, b.max.z)); // nearest point of the footprint
      const d = Math.hypot(cx - it.x, cz - it.z); if (d > reach) continue;
      const area = (b.max.x - b.min.x) * (b.max.z - b.min.z);
      // closest wins; among equally close ones (the hotspot inside several boxes), the smaller, specific object wins
      const thin = Math.min(b.max.x - b.min.x, b.max.z - b.min.z), high = b.min.y > 0.6;
      // wall things: mounted (high or thin + tall) pieces win by a lot; ordinary things: low clutter loses a little
      const fit = want === 'wall' ? ((high || (thin < 0.35 && b.max.y > 1.0)) ? -0.8 : 0.9) : (b.max.y < 0.25 ? 0.5 : 0);
      const size = Math.max(b.max.x - b.min.x, b.max.z - b.min.z, b.max.y - b.min.y);
      const centreD = Math.hypot((b.min.x + b.max.x) / 2 - it.x, (b.min.z + b.max.z) / 2 - it.z);
      if (want === 'wall' && centreD > reach + 0.6) continue; // a long wall piece whose middle is far away is another object
      const score = d * 1.2 + fit - Math.min(0.5, size * 0.25) + (centreD > 2.5 ? 0.6 : 0);
      if (score < bestScore) { bestScore = score; best = { b, cx, cz }; }
    }
    if (!best) continue;
    const { b } = best, hx = (b.max.x - b.min.x) / 2, hz = (b.max.z - b.min.z) / 2;
    if (want === 'wall') { it.vx = (b.min.x + b.max.x) / 2; it.vz = (b.min.z + b.max.z) / 2; it.vr = Math.max(0.4, Math.min(1.1, Math.max(hx, hz) * 0.8 + 0.15)); it.vh = Math.max(0.6, Math.min(2.4, b.max.y)); continue; }
    if (Math.max(hx, hz) > 1.4) { // long piece: ring on the bit nearest the hotspot, nudged into the piece
      const mx = (b.min.x + b.max.x) / 2, mz = (b.min.z + b.max.z) / 2;
      it.vx = hx > hz ? best.cx : best.cx + Math.sign(mx - best.cx) * Math.min(hx, 0.4); it.vz = hz > hx ? best.cz : best.cz + Math.sign(mz - best.cz) * Math.min(hz, 0.4);
      it.vr = 0.65;
    } else { it.vx = (b.min.x + b.max.x) / 2; it.vz = (b.min.z + b.max.z) / 2; it.vr = Math.max(0.35, Math.min(1.4, Math.max(hx, hz) + 0.18)); }
    it.vh = Math.max(0.3, Math.min(2.4, b.max.y));
  }
}
