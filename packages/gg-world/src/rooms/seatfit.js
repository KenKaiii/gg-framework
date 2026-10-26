// @ts-check
// Seat fitting: put every sitting slot ON its furniture instead of inside it.
// Runs from R.finish() (before the static merge), for every room, for members and the player alike.
// Measured from the KayKit poses (tools/sit-measure.mjs and pose probes):
//   Sit_Chair_Idle: the body's underside (butt + thighs) is 0.31 m above the character root, centred 0.34 m BEHIND the
//                   root (the character faces +z; the root is near the knees); the back reaches 0.58 m behind the root.
//   Sit_Floor_Idle: underside 0.05 m above the root, centred on it.
// For each slot (authored at the seat centre): find the seat top under it, slide forward if a backrest is closer than
// the body's back, then place the root so the butt rests on the seat (soft seats sink a little).
// Works on world-space bounding boxes of the furniture pieces (not triangle raycasts: those kept ~8.6 MB alive).
// Each slot gets slot.fit = { top, dy, push, back } for debugging (tools/seat-fit-report.mjs).
import * as THREE from 'three';

const POSE = {
  Sit_Chair_Idle: { under: 0.31, butt: -0.34, backBody: 0.58 },
  Sit_Floor_Idle: { under: 0.05, butt: 0, backBody: 0 },
};
const MAXTOP = { stool: 0.95, beanbag: 0.75, bench: 0.62, sofa: 0.64, armchair: 0.64, chair: 0.66, booth: 0.62, crate: 0.62, floor: 0.4, bed: 0.7, hammock: 0.7, lounger: 0.6 };
const SOFT = { sofa: 0.035, armchair: 0.03, beanbag: 0.07, booth: 0.025, bed: 0.04, floor: 0.02, couch: 0.035, hammock: 0.05, cushion: 0.03, ottoman: 0.02 };

const solid = o => { if (!o.isMesh || o.isSkinnedMesh) return false; for (let a = o; a; a = a.parent) if (a.visible === false) return false;
  const ms = Array.isArray(o.material) ? o.material : [o.material]; return ms.every(m => m && !(m.transparent && m.depthWrite === false) && m.blending === THREE.NormalBlending && m.colorWrite !== false) && !o.userData.floor && !o.userData.noGround; };

/** @param {any} R room (before bake) */
export function fitSeats(R) {
  if (/[?&]nofit/.test(location.search)) return; // A/B: ?nofit
  const seats = (R.slots || []).filter(s => POSE[s.anim]); if (!seats.length) return;
  R.root.updateMatrixWorld(true);
  // pieces = world boxes (+ the mesh and its world matrix, for exact triangle tests on compound one-mesh furniture)
  const pieces = [], m4 = new THREE.Matrix4(), bb = new THREE.Box3();
  const keep = b => !(b.max.y < 0.06 && b.min.y > -0.05); // skip floor slabs / decals
  R.root.traverse(o => { if (!solid(o)) return; const g = o.geometry; if (!g?.attributes?.position) return; if (!g.boundingBox) g.computeBoundingBox();
    if (o.isInstancedMesh) { for (let k = 0; k < o.count; k++) { o.getMatrixAt(k, m4); const mw = m4.clone().premultiply(o.matrixWorld); bb.copy(g.boundingBox).applyMatrix4(mw); if (keep(bb)) pieces.push({ b: bb.clone(), g, m: mw, tri: null }); } return; }
    bb.copy(g.boundingBox).applyMatrix4(o.matrixWorld); if (keep(bb)) pieces.push({ b: bb.clone(), g, m: o.matrixWorld.clone(), tri: null }); });
  if (!pieces.length) return;
  // world-space triangles of a piece, built on first use (temporary: dropped when fitSeats returns)
  const tv = new THREE.Vector3();
  const tris = pc => { if (pc.tri) return pc.tri; const pos = pc.g.attributes.position, idx = pc.g.index, n = idx ? idx.count : pos.count, out = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) { tv.fromBufferAttribute(pos, idx ? idx.getX(k) : k).applyMatrix4(pc.m); out[k * 3] = tv.x; out[k * 3 + 1] = tv.y; out[k * 3 + 2] = tv.z; } return (pc.tri = out); };
  const rq = new THREE.Quaternion(); R.root.getWorldQuaternion(rq); const o0 = R.root.getWorldPosition(new THREE.Vector3());
  const toW = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(rq).add(o0);
  const dir = new THREE.Vector3();
  /** highest surface under local (x, z) below `start` (0 = floor / nothing): exact, per triangle */
  const downAt = (x, z, start) => { const p = toW(x, 0, z), px = p.x, pz = p.z; let top = 0;
    for (const pc of pieces) { const b = pc.b; if (px < b.min.x || px > b.max.x || pz < b.min.z || pz > b.max.z || b.min.y >= start || b.max.y <= top) continue; const T = tris(pc);
      for (let k = 0; k < T.length; k += 9) { const ax = T[k], ay = T[k + 1], az = T[k + 2], bx = T[k + 3], by = T[k + 4], bz = T[k + 5], cx = T[k + 6], cy = T[k + 7], cz = T[k + 8];
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(d) < 1e-9) continue;
        const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / d, l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / d, l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue; const y = l1 * ay + l2 * by + l3 * cy; if (y < start && y > top) top = y; } }
    return top; };
  /** seat top around (x, z): 3 x 3 probes 8 cm apart, median of the ones on furniture (> 6 cm) */
  const topAt = (x, z, start, fx, fz) => { const hs = []; for (const a of [-0.08, 0, 0.08]) for (const b of [-0.08, 0, 0.08]) { const y = downAt(x + fx * a + fz * b, z + fz * a - fx * b, start); if (y > 0.06) hs.push(y); }
    hs.sort((p, q) => p - q); return hs.length >= 3 ? hs[Math.floor(hs.length / 2)] : null; };
  /** distance along a horizontal ray to the nearest triangle (Möller-Trumbore), null if none within far */
  const castFrom = (O, D, far) => { let best = far + 1; const ox = O.x, oy = O.y, oz = O.z, dx = D.x, dy = D.y, dz = D.z;
    for (const pc of pieces) { const b = pc.b; // quick box reject along the ray
      const ex = ox + dx * far, ez = oz + dz * far; if (oy < b.min.y || oy > b.max.y || Math.max(ox, ex) < b.min.x || Math.min(ox, ex) > b.max.x || Math.max(oz, ez) < b.min.z || Math.min(oz, ez) > b.max.z) continue; const T = tris(pc);
      for (let k = 0; k < T.length; k += 9) { const e1x = T[k + 3] - T[k], e1y = T[k + 4] - T[k + 1], e1z = T[k + 5] - T[k + 2], e2x = T[k + 6] - T[k], e2y = T[k + 7] - T[k + 1], e2z = T[k + 8] - T[k + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz; if (Math.abs(det) < 1e-9) continue; const inv = 1 / det;
        const sx = ox - T[k], sy = oy - T[k + 1], sz = oz - T[k + 2], u = (sx * px + sy * py + sz * pz) * inv; if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x, v = (dx * qx + dy * qy + dz * qz) * inv; if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv; if (t > 0.01 && t < best) best = t; } }
    return best <= far ? best : null; };
  for (const s of seats) {
    const P = POSE[s.anim], f = s.face || 0, fx = Math.sin(f), fz = Math.cos(f);
    const y0 = s.y || 0, start = Math.min(1.4, y0 + P.under + 0.5);
    // where is the seat? slots are authored at the seat centre (or, rarely, already a butt-length in front of it)
    let cx = s.x, cz = s.z, top = topAt(cx, cz, start, fx, fz), how = 'centre';
    if (P.butt && top == null) { const bx = s.x + fx * P.butt, bz = s.z + fz * P.butt, t2 = topAt(bx, bz, start, fx, fz); if (t2 != null) { cx = bx; cz = bz; top = t2; how = 'offset'; } }
    // too high for this kind of seat = we're under a backrest / arm: step forward until we find the cushion
    const maxTop = MAXTOP[s.kind] ?? 0.66;
    if (top != null && top > maxTop) for (const st of [0.12, 0.24, 0.36]) { const qx = s.x + fx * st, qz = s.z + fz * st, t3 = topAt(qx, qz, Math.min(start, maxTop + 0.02), fx, fz); if (t3 != null && t3 > 0.15) { cx = qx; cz = qz; top = t3; how = 'stepped'; break; } }
    if (top == null) { s.fit = { top: null, why: 'no seat surface' }; continue; }
    // backrest at shoulder height behind the seat centre: the body's back sticks out 0.24 m behind the butt centre
    let push = 0, back = null;
    if (P.backBody) { dir.set(-fx, 0, -fz).applyQuaternion(rq); back = castFrom(toW(cx, top + 0.38, cz), dir, 1.0);
      const room = P.backBody + P.butt; if (back != null && back < room + 0.02) push = Math.min(0.3, room + 0.02 - back); }
    const bx = cx + fx * push, bz = cz + fz * push, topB = topAt(bx, bz, start, fx, fz) ?? top;
    const want = topB - P.under - (SOFT[s.kind] ?? 0.006), dy = Math.max(-0.15, Math.min(0.45, want - y0));
    s.x = +(bx - fx * P.butt).toFixed(3); s.z = +(bz - fz * P.butt).toFixed(3); s.y = +(y0 + dy).toFixed(3);
    s.fit = { top: +topB.toFixed(3), dy: +dy.toFixed(3), push: +push.toFixed(2), back: back == null ? null : +back.toFixed(2), how };
  }
}
