// @ts-check
// Limbo props (part 3): marble floor, lounge rug, real Penrose stairs, exploding café, rotated hallway, sunk door frame,
// potted plants, upside-down bookcase.
import * as THREE from 'three';
import { mat, rbox, put, mesh, rng } from './kit.js';
import * as TX from './tex.js';
import { cyl, WOOD, BRASS, CREAM } from './inception-props.js';

/** Warm marble with veins and a brass-inlaid diamond per 2x2 tiles. */
export function marbleFloor() {
  return TX.canvasTex('limbo-marble', 512, 512, (x, w, h) => {
    const g = TX.rand(41);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { const v = 200 + Math.floor(g() * 16), d = (i + j) % 2; x.fillStyle = d ? `rgb(${v - 30},${v - 34},${v - 22})` : `rgb(${v},${v - 8},${v - 20})`; x.fillRect(i * 128, j * 128, 128, 128); }
    for (let i = 0; i < 60; i++) { x.strokeStyle = `rgba(${g() < 0.5 ? '120,110,130' : '255,255,255'},${0.12 + g() * 0.2})`; x.lineWidth = 0.5 + g() * 1.6;
      x.beginPath(); let px = g() * w, py = g() * h; x.moveTo(px, py); for (let k = 0; k < 6; k++) { px += (g() - 0.4) * 60; py += (g() - 0.5) * 40; x.lineTo(px, py); } x.stroke(); }
    x.strokeStyle = '#a8864a'; x.lineWidth = 3;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { const cx = i * 256 + 128, cy = j * 256 + 128; x.beginPath(); x.moveTo(cx, cy - 34); x.lineTo(cx + 34, cy); x.lineTo(cx, cy + 34); x.lineTo(cx - 34, cy); x.closePath(); x.stroke(); }
    x.fillStyle = '#6a6070'; for (let i = 0; i <= 4; i++) { x.fillRect(i * 128 - 1, 0, 2, h); x.fillRect(0, i * 128 - 1, w, 2); }
  }, { repeat: true });
}

/** Big round patterned rug: concentric rings + a maze-like spiral (the dream architect's motif). */
export function loungeRug(r = 3.8) {
  const t = TX.canvasTex('limbo-rug', 512, 512, (x, w) => {
    const c = w / 2; const cols = ['#5a3a6a', '#c8945a', '#3a2a50', '#8a5a8a', '#d8b878', '#4a3060'];
    for (let i = 0; i < 12; i++) { x.fillStyle = cols[i % cols.length]; x.beginPath(); x.arc(c, c, c - i * 20, 0, 7); x.fill(); }
    x.strokeStyle = '#e8d0a0'; x.lineWidth = 3; for (let i = 1; i < 11; i++) { x.beginPath(); x.arc(c, c, c - i * 20 - 10, i * 0.7, i * 0.7 + 5.4); x.stroke(); }
    for (let i = 0; i < 24; i++) { const a = i / 24 * 6.283; x.fillStyle = '#e8d0a0'; x.beginPath(); x.arc(c + Math.cos(a) * (c - 10), c + Math.sin(a) * (c - 10), 5, 0, 7); x.fill(); }
  });
  const m = mesh(new THREE.CircleGeometry(r, 48), mat('#ffffff', { map: t, roughness: 0.95 })); m.rotation.x = -Math.PI / 2; m.castShadow = false; return m;
}

/** Penrose stairs: four flights of real steps (tread + riser + stringer) around a square, each rising, plus a rail. */
export function penroseStairs() {
  const g = new THREE.Group(), tread = mat('#cfc8bc', { roughness: 0.8 }), riser = mat('#a49cb8', { roughness: 0.7 }), wall = mat('#6a6488', { roughness: 0.75 });
  const n = 6, L = 2.6, s = L / n, rise = 0.11, Wd = 0.7; let k = 0; const rail = [];
  put(g, rbox(L + Wd + 0.2, 0.16, L + Wd + 0.2, mat('#3e3858'), 0.05), 0, 0.08, 0);
  for (let f = 0; f < 4; f++) {
    // each flight is a hair narrower than the last so the overlapping corner blocks never share a face plane (z-fight)
    const ry = -f * Math.PI / 2, fl = new THREE.Group(), W = Wd - f * 0.024; fl.rotation.y = ry; g.add(fl);
    for (let i = 0; i < n; i++, k++) {
      const top = 0.3 + k * rise, x = -L / 2 + (i + 0.5) * s;
      put(fl, rbox(s, top, W, wall, 0.0), x, top / 2, -L / 2);            // solid stringer block under the step
      put(fl, rbox(s + 0.02, 0.04, W + 0.04, tread, 0.01), x, top + 0.003, -L / 2); // tread with nosing
      // riser stands 6 mm proud of the block face (it used to be flush = two coplanar faces z-fighting: the steps 'flickered')
      put(fl, rbox(0.02, rise, W - 0.01, riser, 0.0), x - s / 2 - 0.006, top - rise / 2, -L / 2);
      const p = new THREE.Vector3(x, top + 0.55, -L / 2 - Wd / 2 + 0.04).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry); rail.push(p);
      put(fl, cyl(0.028, 0.028, 0.55, BRASS, 8), x, top + 0.27, -L / 2 - Wd / 2 + 0.04).castShadow = false;
    }
  }
  put(g, mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rail), 96, 0.04, 8), BRASS), 0, 0, 0).castShadow = false;
  // the "impossible" join: the last flight's top step meets the first one's bottom with a dark seam shadow
  return g;
}

/** Café table + 2 chairs (static). */
export function cafeSet() {
  const g = new THREE.Group(), iron = mat('#2a2830', { metalness: 0.6, roughness: 0.4 }), top = mat('#e8e0d0', { roughness: 0.4 });
  put(g, cyl(0.38, 0.38, 0.04, top, 20), 0, 0.74, 0); put(g, cyl(0.03, 0.03, 0.72, iron, 8), 0, 0.37, 0); put(g, cyl(0.22, 0.25, 0.03, iron, 14), 0, 0.015, 0);
  for (const s of [-1, 1]) { const c = new THREE.Group(); put(c, cyl(0.2, 0.2, 0.04, mat('#7a3a3a'), 14), 0, 0.46, 0);
    for (const a of [0.8, 2.4, 3.9, 5.5]) put(c, cyl(0.015, 0.015, 0.46, iron, 5), Math.cos(a) * 0.15, 0.23, Math.sin(a) * 0.15);
    put(c, rbox(0.38, 0.4, 0.03, iron, 0.01), 0, 0.7, -0.18); put(g, c, s * 0.62, 0, 0, s * Math.PI / 2 + Math.PI); } // both chairs face the table
  return g;
}

/** Floating café debris: one InstancedMesh of shards + one of cups. Returns { group, items } (items = base transforms). */
export function cafeDebris(n = 46) {
  const r = rng(91), grp = new THREE.Group(), items = [];
  const shards = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(0.09), mat('#d8cfc0', { roughness: 0.6 }), n);
  const cups = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.04, 0.09, 10), mat('#f0e8dc', { roughness: 0.4 }), 8);
  for (let i = 0; i < n + 8; i++) { const a = r() * 6.283, d = 0.3 + r() * 1.0;
    items.push({ m: i < n ? shards : cups, i: i < n ? i : i - n, x: Math.cos(a) * d, y: 0.5 + r() * 1.3, z: Math.sin(a) * d, s: 0.5 + r() * 1.4, rx: r() * 6, ry: r() * 6, ph: r() * 6.283 }); }
  shards.castShadow = cups.castShadow = false; grp.add(shards, cups);
  return { group: grp, items, meshes: [shards, cups] };
}

/** A stretch of hotel hallway rotated 90deg (its floor is a wall): two panels + a carpet strip + a sconce row. */
export function sideHall() {
  const g = new THREE.Group(), pan = mat('#8a6a5a', { roughness: 0.8 }), carp = mat('#8a3a3a', { roughness: 0.95 });
  put(g, rbox(0.12, 1.6, 2.4, carp, 0.02), 0, 0.8, 0);              // "floor" standing vertical
  put(g, rbox(1.2, 0.08, 2.4, pan, 0.02), 0.6, 1.6, 0);               // wall lying flat on top
  put(g, rbox(1.2, 0.08, 2.4, pan, 0.02), 0.6, 0.04, 0);              // wall on the floor
  for (const z of [-1, 0.4]) { const d = rbox(0.9, 0.05, 0.7, WOOD, 0.02); put(g, d, 0.6, 0.1, z * 0.8); }
  return g;
}

/** Door frame sunk into the floor at an angle. */
export function sunkDoor() {
  const g = new THREE.Group(), f = mat('#e8dcc8', { roughness: 0.6 });
  const inner = new THREE.Group(); put(inner, rbox(0.12, 2.2, 0.16, f, 0.02), -0.5, 1.1, 0); put(inner, rbox(0.12, 2.2, 0.16, f, 0.02), 0.5, 1.1, 0);
  put(inner, rbox(1.12, 0.12, 0.16, f, 0.02), 0, 2.2, 0); put(inner, rbox(0.88, 2.0, 0.05, WOOD, 0.02), 0.08, 1.02, 0.2).rotation.y = -0.5;
  put(inner, cyl(0.03, 0.03, 0.04, BRASS, 8), 0.4, 1.0, 0.36);
  inner.rotation.z = 0.45; inner.position.y = -0.55; g.add(inner); return g;
}

/** Potted plant: ceramic pot, layered leaf fan. */
export function plant(seed = 1, h = 1.2) {
  const g = new THREE.Group(), r = rng(seed), leaf = mat('#4a8a5a', { roughness: 0.7 });
  put(g, cyl(0.26, 0.2, 0.42, CREAM, 14), 0, 0.21, 0); put(g, cyl(0.24, 0.24, 0.03, mat('#3a2a20'), 14), 0, 0.41, 0);
  for (let i = 0; i < 9; i++) { const l = mesh(new THREE.SphereGeometry(0.16, 6, 4), leaf); l.scale.set(0.6, h * 2.2, 0.25); l.rotation.set((r() - 0.5) * 0.9, r() * 6, (r() - 0.5) * 0.9); put(g, l, (r() - 0.5) * 0.15, 0.42 + h * 0.3, (r() - 0.5) * 0.15); }
  return g;
}

/** Bookcase hanging upside down (books "falling" up). */
export function bookcaseUpside() {
  const g = new THREE.Group(), wd = mat('#5a3e2c', { roughness: 0.6 });
  const b = new THREE.Group(); put(b, rbox(1.4, 2.0, 0.36, wd, 0.03), 0, 1.0, -0.02);
  const sp = new THREE.Mesh(new THREE.PlaneGeometry(1.24, 0.4), new THREE.MeshStandardMaterial({ map: TX.spines(7), roughness: 0.8 }));
  for (const y of [0.4, 0.95, 1.5]) put(b, sp.clone(), 0, y, 0.17);
  b.rotation.z = Math.PI; b.position.y = 3.0; g.add(b); return g;
}
