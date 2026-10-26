// @ts-check
// Cars for the outside: proper low-poly models instead of boxes. Four kinds (sedan, hatchback, van, taxi), each built
// from an extruded side profile with real wheel arches, a glass cabin, roof + pillars, bumpers, lights, mirrors and wheels
// with rims. Two meshes per kind: "paint" (white, shaded; the instance colour paints it) and "fixed" (glass, tyres, lights,
// trims keep their own colours). Shading is baked into vertex colours (the outside uses unlit materials).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const LDIR = new THREE.Vector3(0.45, 1, 0.3).normalize();
const shadeOf = (nx, ny, nz) => 0.55 + 0.45 * Math.max(0, nx * LDIR.x + ny * LDIR.y + nz * LDIR.z) + (ny > 0.9 ? 0.05 : 0);
/** bake colour * light into vertex colours (needs normals); returns non-indexed geometry with position + color */
export function bake(g, hex) { const c = new THREE.Color(hex); g = g.index ? g.toNonIndexed() : g; g.computeVertexNormals(); const N = g.attributes.normal, n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const k = shadeOf(N.getX(i), N.getY(i), N.getZ(i)); a[i * 3] = c.r * k; a[i * 3 + 1] = c.g * k; a[i * 3 + 2] = c.b * k; }
  g.deleteAttribute('normal'); if (g.attributes.uv) g.deleteAttribute('uv'); g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; }

/** extrude a side profile (pts: [along, up], front at along < 0) across the width; car faces +z, width along x */
function side(pts, width, bevel = 0.04, holes = []) {
  const sh = new THREE.Shape(pts.map(([a, b]) => new THREE.Vector2(a, b)));
  for (const h of holes) sh.holes.push(new THREE.Path(h.map(([a, b]) => new THREE.Vector2(a, b))));
  const g = new THREE.ExtrudeGeometry(sh, { depth: Math.max(0.01, width - 2 * bevel), bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 8 });
  g.rotateY(Math.PI / 2); g.translate(-(width - 2 * bevel) / 2, 0, 0); return g; // shape x -> -z (front at +z), extrusion -> x
}
/** bottom edge with two wheel arches (rear -> front) */
function underside(rear, front, axles, r, y) {
  const out = [[rear, y]]; for (const ax of axles) { out.push([ax + r + 0.02, y]); for (let k = 0; k <= 10; k++) { const t = k / 10 * Math.PI; out.push([ax + Math.cos(t) * (r + 0.02), y + Math.sin(t) * (r + 0.06)]); } out.push([ax - r - 0.02, y]); }
  out.push([front, y]); return out; }
const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
function wheel(x, z, r = 0.33, w = 0.22) {
  const tyre = new THREE.CylinderGeometry(r, r, w, 14).rotateZ(Math.PI / 2).translate(x, r, z);
  const rim = new THREE.CylinderGeometry(r * 0.58, r * 0.58, 0.02, 12).rotateZ(Math.PI / 2).translate(x + Math.sign(x) * (w / 2 + 0.012), r, z);
  const hub = new THREE.CylinderGeometry(r * 0.18, r * 0.18, 0.03, 8).rotateZ(Math.PI / 2).translate(x + Math.sign(x) * (w / 2 + 0.028), r, z);
  return { tyre, rim, hub };
}

const KINDS = {
  sedan: { L: 4.5, W: 1.82, axles: [1.38, -1.4], body: [[2.2, 0.62], [2.12, 0.86], [1.4, 0.95], [-0.72, 0.93], [-2.08, 0.8], [-2.26, 0.62], [-2.22, 0.34]], rearBottom: 2.16,
    cabin: [[1.42, 0.94], [0.95, 1.4], [-0.08, 1.42], [-0.74, 0.92]], pillars: [0.48], roof: [[0.96, 1.38], [-0.1, 1.4]] },
  hatch: { L: 3.95, W: 1.76, axles: [1.2, -1.25], body: [[1.92, 0.62], [1.95, 0.92], [1.62, 0.98], [-0.6, 0.94], [-1.82, 0.8], [-1.99, 0.62], [-1.96, 0.34]], rearBottom: 1.9,
    cabin: [[1.82, 0.96], [1.55, 1.44], [-0.02, 1.46], [-0.62, 0.93]], pillars: [0.6], roof: [[1.56, 1.42], [-0.04, 1.44]] },
  van: { L: 4.9, W: 1.95, axles: [1.55, -1.5], body: [[2.42, 0.6], [2.42, 1.0], [-1.6, 1.0], [-2.32, 0.95], [-2.45, 0.62], [-2.42, 0.34]], rearBottom: 2.36,
    cabin: [[2.4, 0.99], [2.38, 1.96], [-1.35, 1.98], [-1.85, 1.0]], pillars: [-0.55, 0.6, 1.5], roof: [[2.38, 1.94], [-1.36, 1.96]], panel: true },
  taxi: null,
};
KINDS.taxi = { ...KINDS.sedan, sign: true };

/** @returns {{ paint: THREE.BufferGeometry, fixed: THREE.BufferGeometry }} geometries for one car kind (origin: ground, centre) */
export function carGeometry(kind, o = {}) {
  const K = KINDS[kind], W = K.W, paint = [], fixed = [];
  const lower = [...K.body, ...underside(K.rearBottom, K.body[K.body.length - 1][0], K.axles, 0.33, 0.3)];
  paint.push(bake(side(lower, W, 0.05), '#ffffff'));
  // glass cabin, a little narrower than the body; roof slab + pillars in paint, 1.5 cm proud of the glass (no z-fight)
  const gw = W - 0.2;
  fixed.push(bake(side(K.cabin, gw, 0.03), '#3a4c62'));
  const [r0, r1] = K.roof; const roof = [[r0[0] + 0.02, r0[1] - 0.04], [r0[0] + 0.01, r0[1] + 0.05], [r1[0] - 0.01, r1[1] + 0.05], [r1[0] - 0.02, r1[1] - 0.04]];
  paint.push(bake(side(roof, gw + 0.06, 0.02), '#ffffff'));
  if (K.panel) { const c = K.cabin; paint.push(bake(side([[c[0][0] - 0.02, c[0][1] + 0.02], [c[1][0] - 0.02, c[1][1] - 0.06], [c[2][0] + 0.9, c[2][1] - 0.06], [c[2][0] + 0.9, c[3][1] + 0.02]], gw + 0.03, 0.01), '#ffffff')); } // van: solid cargo side
  for (const sx of [-1, 1]) {
    const px = sx * (gw / 2 + 0.015);
    const a0 = K.cabin[3], a1 = K.cabin[2], c0 = K.cabin[0], c1 = K.cabin[1];
    const pillar = (p0, p1, t = 0.07) => { const dx = p1[0] - p0[0], dy = p1[1] - p0[1], l = Math.hypot(dx, dy), nx = -dy / l * t, ny = dx / l * t; return side([[p0[0], p0[1]], [p1[0], p1[1]], [p1[0] + nx, p1[1] + ny], [p0[0] + nx, p0[1] + ny]], 0.03, 0); };
    for (const g of [pillar(a0, a1), pillar(c1, c0), ...K.pillars.map(x => pillar([x + 0.04, (a0[1] + c0[1]) / 2], [x + 0.04, a1[1] - 0.02], 0.08))]) paint.push(bake(g.translate(px, 0, 0), '#ffffff'));
    // mirrors
    paint.push(bake(box(0.16, 0.1, 0.12, sx * (W / 2 + 0.06), a0[1] + 0.1, -a0[0] - 0.08), '#ffffff'));
  }
  // bumpers + grille + plates + lights
  const zf = -Math.min(...K.body.map(p => p[0])), zr = -Math.max(...K.body.map(p => p[0]));
  fixed.push(bake(box(W - 0.06, 0.16, 0.12, 0, 0.42, zf - 0.03), '#2a2c30'), bake(box(W - 0.06, 0.16, 0.12, 0, 0.42, zr + 0.03), '#2a2c30'));
  fixed.push(bake(box(W * 0.42, 0.12, 0.04, 0, 0.6, zf + 0.0), '#1a1c20'), bake(box(0.44, 0.11, 0.03, 0, 0.42, zf + 0.04), '#e8e6dc'), bake(box(0.44, 0.11, 0.03, 0, 0.5, zr - 0.04), '#e8e6dc'));
  for (const sx of [-1, 1]) { fixed.push(bake(box(0.34, 0.12, 0.05, sx * (W / 2 - 0.26), 0.66, zf + 0.0), '#fff4d4'), bake(box(0.3, 0.12, 0.05, sx * (W / 2 - 0.24), 0.7, zr - 0.0), '#d8262a')); }
  if (K.sign) fixed.push(bake(box(0.62, 0.18, 0.26, 0, K.roof[0][1] + 0.16, -0.4), '#ffe082'));
  if (o.bakedWheels !== false) for (const ax of K.axles) for (const sx of [-1, 1]) { const wg = wheelGeometry().clone(); if (sx < 0) wg.rotateY(Math.PI); wg.translate(sx * (W / 2 - 0.14), 0.33, -ax); fixed.push(wg); }
  const wheels = K.axles.flatMap(ax => [-1, 1].map(sx => [sx * (W / 2 - 0.14), 0.33, -ax])); // wheel centres (wheelGeometry() is drawn per wheel so it can turn)
  return { paint: mergeGeometries(paint), fixed: mergeGeometries(fixed), wheels };
}
export const CAR_KINDS = ['sedan', 'hatch', 'van', 'taxi'];

/** one wheel centred on its axle (axle = x, rim face on +x): tyre with tread, rim, 5 spokes, hub. Mirror via a 180 deg yaw. */
export function wheelGeometry(r = 0.33, w = 0.22) {
  const parts = [bake(new THREE.CylinderGeometry(r, r, w, 16).rotateZ(Math.PI / 2), '#17181b'),
    bake(new THREE.CylinderGeometry(r * 0.94, r * 0.94, w * 0.9, 16).rotateZ(Math.PI / 2).translate(0.006, 0, 0), '#222327'),
    bake(new THREE.CylinderGeometry(r * 0.62, r * 0.62, 0.02, 14).rotateZ(Math.PI / 2).translate(w / 2 + 0.008, 0, 0), '#8e939c'),
    bake(new THREE.CylinderGeometry(r * 0.2, r * 0.2, 0.04, 10).rotateZ(Math.PI / 2).translate(w / 2 + 0.03, 0, 0), '#c4c8d0')];
  for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI * 2; parts.push(bake(new THREE.BoxGeometry(0.03, r * 0.5, 0.07).translate(0, r * 0.32, 0).rotateX(a).translate(w / 2 + 0.024, 0, 0), '#d4d8de')); }
  return mergeGeometries(parts);
}
