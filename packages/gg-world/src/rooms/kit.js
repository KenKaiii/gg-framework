// @ts-check
// Room kit, part 1: shared art direction for the cozy night rooms.
// Materials (cached so identical colours share one material), rounded boxes, the room shell
// (floor slab, walls with windows/doors, dollhouse cut-away), the fixed light rig, and bake() to merge statics.
// Coordinates: every room is built around (0,0,0); floor top at y=0; x in [-w/2,w/2], z in [-d/2,d/2].
// Walls: 'n' at z=-d/2, 's' at z=+d/2, 'w' at x=-w/2, 'e' at x=+w/2. Default iso camera looks from +x,+z,
// so 'n' and 'w' are the back walls you see; 'e' and 's' are cut down to a low stub.
import * as THREE from 'three';
import { groundShade } from './ground.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Grid } from '../grid.js';
import * as FX from './kit-fx.js';
import { roomInfo, FLOORS, floorOf } from './floorplan.js';
import { fitSeats } from './seatfit.js';
import { autoBlock } from './autoblock.js';
import { focusHotspots } from './focus.js';

const matCache = new Map();
/** Cached standard material. @param {string} color @param {object} [o] */
export function mat(color, o = {}) {
  const key = color + JSON.stringify(o, (k, v) => (v && v.isTexture ? v.uuid : v));
  let m = matCache.get(key);
  if (!m) { m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...o }); matCache.set(key, m); }
  return m;
}
/** Self-lit material for screens, bulbs, neon. power > 1 makes it bloom. @param {string} color @param {number} [power] */
export function glowMat(color, power = 2.2, o = {}) {
  const key = 'glow' + color + power + JSON.stringify(o, (k, v) => (v && v.isTexture ? v.uuid : v));
  let m = matCache.get(key);
  if (!m) { m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(power), ...o }); matCache.set(key, m); }
  return m;
}
const boxCache = new Map();
/** Rounded box mesh, centred. @param {number} w @param {number} h @param {number} d @param {THREE.Material} m @param {number} [r] */
export function rbox(w, h, d, m, r = 0.04) {
  r = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3); if (r < 0.01) r = 0; /* sub-cm bevels are invisible at room zoom but cost ~900 verts each once baked */
  const key = [w, h, d, r].map(v => v.toFixed(3)).join();
  let g = boxCache.get(key);
  if (!g) { g = r ? new RoundedBoxGeometry(w, h, d, 2, r) : new THREE.BoxGeometry(w, h, d); boxCache.set(key, g); }
  const mesh = new THREE.Mesh(g, m); mesh.castShadow = mesh.receiveShadow = true; return mesh;
}
/** Place helper: set position/rotation and add to parent; returns the object. */
export function put(parent, obj, x = 0, y = 0, z = 0, ry = 0) { obj.position.set(x, y, z); obj.rotation.y = ry; parent.add(obj); return obj; }
/** Mesh from any geometry with shadows on. */
export function mesh(geo, m) { const o = new THREE.Mesh(geo, m); o.castShadow = o.receiveShadow = true; return o; }

/** Seeded RNG (deterministic layouts). */
export function rng(seed = 1) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/**
 * Merge every static, opaque mesh under `root` into one mesh per material (huge draw-call saver).
 * Mark anything that moves/animates with obj.userData.live = true (it and its children are kept as-is).
 * @param {THREE.Object3D} root
 */
/** Drop a baked geometry's CPU-side arrays right after its first GPU upload (bounds are computed first). */
export function releaseAfterUpload(geo) {
  geo.computeBoundingSphere(); geo.computeBoundingBox();
  for (const k in geo.attributes) geo.attributes[k].onUpload(function () { this.array = new this.array.constructor(1); });
  if (geo.index) geo.index.onUpload(function () { this.array = new this.array.constructor(1); });
  return geo;
}
export function bake(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map(); const drop = [];
  const visit = o => {
    if (o.userData.live) return;
    if (o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh && !Array.isArray(o.material) && !o.material.transparent && o.visible) {
      const m4 = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      if (!g.attributes.normal) g.computeVertexNormals();
      g.morphAttributes = {}; g.applyMatrix4(m4);
      const k = o.material.uuid; if (!groups.has(k)) groups.set(k, { m: o.material, gs: [], cast: false });
      const e = groups.get(k); e.gs.push(g); e.cast = e.cast || o.castShadow; drop.push(o);
    }
    for (const c of o.children) visit(c);
  };
  for (const c of root.children) visit(c);
  for (const o of drop) { o.removeFromParent(); }
  // prune now-empty groups
  const empties = []; root.traverse(o => { if (o !== root && !o.isMesh && !o.isLight && !o.isPoints && !o.isSprite && !o.isLine && !o.userData.live && o.children.length === 0) empties.push(o); });
  for (const o of empties) o.removeFromParent();
  for (const { m, gs, cast } of groups.values()) {
    const merged = mergeGeometries(gs, false); if (!merged) continue;
    const out = new THREE.Mesh(releaseAfterUpload(merged), m); out.castShadow = cast; out.receiveShadow = true; out.matrixAutoUpdate = false; out.userData.baked = true; root.add(out);
  }
  return root;
}

const vcCache = new Map();
const q05 = v => Math.round(v * 20) / 20;
/** Signature for plain coloured standard materials that can share one vertex-colour material, else null. @param {any} m */
function plainSig(m) {
  if (!m || m.type !== 'MeshStandardMaterial' || m.map || m.emissiveMap || m.normalMap || m.alphaMap || m.roughnessMap || m.metalnessMap || m.aoMap || m.lightMap || m.bumpMap || m.displacementMap || m.envMap) return null;
  if (m.transparent || m.opacity !== 1 || m.alphaTest || m.vertexColors || m.wireframe || m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile || m.userData.noMerge) return null;
  if (m.emissive.r || m.emissive.g || m.emissive.b || !m.toneMapped || !m.visible || !m.depthWrite || !m.depthTest || m.polygonOffset) return null;
  return [q05(m.roughness), q05(m.metalness), m.side, m.flatShading ? 1 : 0].join('|');
}
/** Shared vertex-colour material for a signature. @param {string} sig */
function vcMat(sig) {
  let m = vcCache.get(sig);
  if (!m) { const [roughness, metalness, side, flat] = sig.split('|').map(Number); m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness, metalness, side: /** @type {THREE.Side} */ (side), flatShading: !!flat }); vcCache.set(sig, m); }
  return m;
}
/**
 * Second bake stage: merge the per-material meshes bake() left directly under each root across colours
 * (colour goes into a per-vertex attribute). Grouped by signature + cast/receive, so per-room shadow choices survive.
 * Materials also used by any other mesh under `scope` (live, ticked, unbaked) are left alone so runtime colour changes keep working.
 * @param {THREE.Object3D[]} roots @param {THREE.Object3D} scope
 */
export function bakeColours(roots, scope) {
  const used = new Set(); scope.traverse(o => { const m = /** @type {any} */ (o).material; if (m && !o.userData.baked) for (const x of [m].flat()) used.add(x); });
  for (const root of roots) {
    const groups = new Map();
    for (const o of root.children) {
      const mm = /** @type {any} */ (o); if (!mm.isMesh || !o.userData.baked || !o.visible || used.has(mm.material)) continue;
      const sig = plainSig(mm.material); if (!sig) continue;
      const k = sig + '|' + o.castShadow + '|' + o.receiveShadow; if (!groups.has(k)) groups.set(k, { sig, list: [] }); groups.get(k).list.push(mm);
    }
    for (const { sig, list } of groups.values()) {
      if (list.length < 2) continue;
      const gs = list.map(o => {
        const g = o.geometry, n = g.attributes.position.count, c = o.material.color, a = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; } // linear, as the shader reads it
        g.setAttribute('color', new THREE.BufferAttribute(a, 3));
        /* normalise so mergeGeometries never rejects the group: same attribute set (position/normal/uv/color) on every part */
        for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
        if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
        if (!g.attributes.normal) g.computeVertexNormals();
        return g;
      });
      if (gs.some(g => !!g.index) !== gs.every(g => !!g.index)) { for (const g of gs) g.deleteAttribute('color'); continue; }
      const merged = mergeGeometries(gs, false); if (!merged) { for (const g of gs) g.deleteAttribute('color'); continue; }
      const out = new THREE.Mesh(releaseAfterUpload(merged), vcMat(sig)); out.castShadow = list[0].castShadow; out.receiveShadow = list[0].receiveShadow; out.matrixAutoUpdate = false; out.userData.baked = true;
      for (const o of list) { o.removeFromParent(); o.geometry.dispose(); } root.add(out);
    }
  }
}

const SIDES = {
  n: (w, d) => ({ pos: [0, -d / 2], ry: 0, len: w, n: [0, 1] }),
  s: (w, d) => ({ pos: [0, d / 2], ry: Math.PI, len: w, n: [0, -1] }),
  w: (w, d) => ({ pos: [-w / 2, 0], ry: Math.PI / 2, len: d, n: [1, 0] }),
  e: (w, d) => ({ pos: [w / 2, 0], ry: -Math.PI / 2, len: d, n: [-1, 0] }),
};

/**
 * Build the room shell.
 * @param {{ w:number, d:number, h?:number,
 *   floor?: THREE.Texture|string, floorRepeat?: number,
 *   wall?: THREE.Texture|string, trim?: string, base?: string, slab?: string,
 *   windows?: {side:'n'|'s'|'w'|'e', at:number, w?:number, h?:number, y?:number, view?: THREE.Texture, blinds?: boolean, curtains?: string}[],
 *   doors?: {side:'n'|'s'|'w'|'e', at:number, w?:number, to?:string, glow?: string}[] }} o
 */
export function makeRoom(o) {
  // o.id: when given, size and archways come from floorplan.js (o.w / o.d still override for tests)
  const info = o.id ? roomInfo(o.id) : null;
  const w = o.w ?? info?.w, d = o.d ?? info?.d, H = o.h ?? 3.2, T = 0.2;
  const root = new THREE.Group(); root.name = 'room';
  const grid = new Grid(-w / 2, -d / 2, w / 2, d / 2);
  const R = { root, id: o.id, info, w, d, h: H, grid, walls: {}, windows: [], doors: [], passages: [], static: new THREE.Group(), live: new THREE.Group() };
  root.add(R.static, R.live);
  // floor + diorama slab
  const fm = typeof o.floor === 'string' || !o.floor ? mat(/** @type {string} */ (o.floor || '#6b4a3a')) : mat('#ffffff', { map: o.floor });
  if (o.floor && typeof o.floor !== 'string') { o.floor.wrapS = o.floor.wrapT = THREE.RepeatWrapping; o.floor.repeat.set(w / (o.floorRepeat || 2.5), d / (o.floorRepeat || 2.5)); }
  const floor = mesh(new THREE.PlaneGeometry(w, d), fm); floor.rotation.x = -Math.PI / 2; floor.castShadow = false; floor.userData.floor = true; root.add(floor); R.floor = floor;
  if (!info?.joined) { // joined floors get one shared slab from floorSlab()
    const slab = rbox(w + 0.5, 0.6, d + 0.5, mat(o.slab || '#17121f', { roughness: 0.9 }), 0.12); slab.position.y = -0.31; R.static.add(slab);
    const lip = rbox(w + 0.62, 0.08, d + 0.62, mat(o.trim || '#3d3240'), 0.03); lip.position.y = -0.03; R.static.add(lip);
  }
  // walls
  const wm = typeof o.wall === 'string' || !o.wall ? mat(/** @type {string} */ (o.wall || '#3b4a7a')) : null;
  for (const side of /** @type {const} */ (['n', 's', 'w', 'e'])) {
    const S = SIDES[side](w, d);
    // a wall shared with a neighbour is drawn by only one of the two rooms (see floorplan.js roomInfo().shared)
    if (info?.shared?.[side] && !info.shared[side].draw) { const e = new THREE.Group(); R.walls[side] = { g: e, full: e, stub: e, decor: e, len: S.len, n: new THREE.Vector3(S.n[0], 0, S.n[1]), skipped: true }; continue; }
    const g = new THREE.Group(); g.position.set(S.pos[0], 0, S.pos[1]); g.rotation.y = S.ry; root.add(g);
    // wall ends: extend by the wall thickness only at real building corners. Where the wall line continues into a
    // neighbour room (collinear walls), both rooms used to extend into each other: two coplanar boxes overlapping by
    // 2T = z-fighting, a vertical strip that flickered as the camera moved (owner: "walls flicker as I move").
    const ext = sgn => { if (!info) return T; const fl = FLOORS[floorOf(o.id)]; const cx = info.x + S.pos[0], cz = info.z + S.pos[1], u = sgn * (S.len / 2 + 0.3);
      const px = cx + u * Math.cos(S.ry), pz = cz - u * Math.sin(S.ry);
      for (const [rid, r] of Object.entries(fl.rooms)) { if (rid === o.id) continue; if (px > r.x - r.w / 2 - 0.05 && px < r.x + r.w / 2 + 0.05 && pz > r.z - r.d / 2 - 0.05 && pz < r.z + r.d / 2 + 0.05) return 0; }
      return T; };
    const e0 = ext(-1), e1 = ext(1);
    const full = new THREE.Group(), stub = new THREE.Group(), decor = new THREE.Group(); g.add(full, stub); full.add(decor);
    const ops = [...(o.windows || []).filter(x => x.side === side).map(x => ({ ...x, kind: 'window', w: x.w ?? 1.6, h: x.h ?? 1.3, y: x.y ?? 1.0 })),
      ...(o.doors || []).filter(x => x.side === side).map(x => ({ ...x, kind: 'door', w: x.w ?? 1.1, h: 2.2, y: 0 })),
      ...(info?.passages || []).filter(x => x.side === side).map(x => ({ ...x, from: o.id, kind: 'passage', h: 2.6, y: 0 }))].sort((a, b) => a.at - b.at);
    const wallMat = wm || (() => { const t = /** @type {THREE.Texture} */ (o.wall).clone(); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(S.len / 2.4, H / 2.4); t.needsUpdate = true; return mat('#ffffff', { map: t }); })();
    const seg = (x0, x1, y0, y1) => { if (x1 - x0 < 0.01 || y1 - y0 < 0.01) return; const b = rbox(x1 - x0, y1 - y0, T, wallMat, 0.0); b.position.set((x0 + x1) / 2, (y0 + y1) / 2, -T / 2); full.add(b); };
    let cur = -S.len / 2 - e0;
    for (const op of ops) {
      const a = op.at - op.w / 2, b = op.at + op.w / 2; seg(cur, a, 0, H); seg(a, b, 0, op.y); seg(a, b, op.y + op.h, H); cur = b;
      const info = { side, at: op.at, w: op.w, h: op.h, y: op.y, group: full, ...op };
      if (op.kind === 'window') { FX.windowUnit(full, op, T); R.windows.push(info); }
      else if (op.kind === 'passage') { FX.archUnit(full, op, T, g); R.passages.push(info); }
      else { FX.doorUnit(full, op, T); R.doors.push(info); }
    }
    seg(cur, S.len / 2 + e1, 0, H);
    // trims
    const cap = rbox(S.len + e0 + e1, 0.08, T + 0.06, mat(o.trim || '#3d3240'), 0.02); cap.position.set((e1 - e0) / 2, H + 0.04, -T / 2); full.add(cap);
    // runs between the floor-level openings (passages + doors), so nothing low crosses a doorway
    const gaps = ops.filter(x => x.kind !== 'window').map(x => [x.at - x.w / 2 - (x.kind === 'passage' ? 0.2 : 0.05), x.at + x.w / 2 + (x.kind === 'passage' ? 0.2 : 0.05)]).sort((p, q) => p[0] - q[0]);
    const runs = []; { let c = -S.len / 2 - e0; for (const [a, b] of gaps) { if (a > c) runs.push([c, a]); c = Math.max(c, b); } if (S.len / 2 + e1 > c) runs.push([c, S.len / 2 + e1]); }
    for (const [a0, a1] of runs) { const L = a1 - a0; if (L < 0.02) continue; const mid = (a0 + a1) / 2;
      const bL = Math.min(L, Math.max(0.02, Math.min(a1, S.len / 2) - Math.max(a0, -S.len / 2)));
      if (bL > 0.02) { const base = rbox(bL, 0.16, 0.05, mat(o.base || '#15111c'), 0.01); base.position.set((Math.max(a0, -S.len / 2) + Math.min(a1, S.len / 2)) / 2, 0.08, 0.025); full.add(base); }
      const st = rbox(L, 0.32, T, wallMat, 0); st.position.set(mid, 0.16, -T / 2); stub.add(st);
      const stc = rbox(L, 0.06, T + 0.06, mat(o.trim || '#3d3240'), 0.02); stc.position.set(mid, 0.35, -T / 2); stub.add(stc); }
    stub.visible = false;
    R.walls[side] = { g, full, stub, decor, len: S.len, n: new THREE.Vector3(S.n[0], 0, S.n[1]) };
  }
  // keep a strip along the walls unwalkable
  grid.rect(-w / 2, -d / 2, w / 2, -d / 2 + 0.3); grid.rect(-w / 2, d / 2 - 0.3, w / 2, d / 2);
  grid.rect(-w / 2, -d / 2, -w / 2 + 0.3, d / 2); grid.rect(w / 2 - 0.3, -d / 2, w / 2, d / 2);
  for (const p of [...R.passages, ...(info?.passages || []).filter(q => info.shared?.[q.side] && !info.shared[q.side].draw)]) {
    if (p.side === 'e' || p.side === 'w') { const z = p.side === 'e' ? p.at : -p.at, x = p.side === 'e' ? w / 2 : -w / 2; grid.rect(x - 0.6, z - p.w / 2 + 0.25, x + 0.6, z + p.w / 2 - 0.25, 0); }
    else { const x = p.side === 'n' ? p.at : -p.at, z = p.side === 'n' ? -d / 2 : d / 2; grid.rect(x - p.w / 2 + 0.25, z - 0.6, x + p.w / 2 - 0.25, z + 0.6, 0); }
  }
  /** Hang something on a wall's inner face. u = position along the wall (left->right seen from inside), y = height of its centre. */
  R.onWall = (side, obj, u, y, out = 0.02) => { obj.position.set(u, y, out); R.walls[side].decor.add(obj); return obj; };
  /** Block a floor rectangle for walking. */
  R.block = (x0, z0, x1, z1) => grid.rect(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1));
  /** Block the footprint of an object (after it is placed in R.static or R.live). */
  R.blockObj = (obj, pad = 0.05) => { obj.updateMatrixWorld(true); const b = new THREE.Box3().setFromObject(obj); grid.rect(b.min.x + pad, b.min.z + pad, b.max.x - pad, b.max.z - pad); };
  /** Hide walls between camera and room. camDir = camera->target, flattened. */
  R.cutaway = camDir => { for (const k in R.walls) { const wl = R.walls[k]; if (wl.skipped) continue; const hide = wl.n.dot(camDir) > 0.2; wl.full.visible = !hide; wl.stub.visible = hide; } };
  /** Call once at the end of build: merges statics (and each wall) for speed. */
  // The colour merge runs in a microtask so per-room shadow tweaks made right after finish() (by material) still apply.
  // After baking, nothing under R.static (or the wall shells) ever moves: freeze their local matrices so three.js stops
  // recomputing them every frame. World matrices still follow the room root (it's placed once by the floor plan).
  const freeze = g => g.traverse(o => { o.updateMatrix(); o.matrixAutoUpdate = false; });
  R.finish = () => { try { fitSeats(R); } catch (e) { console.warn('fitSeats ' + R.id, e); } try { autoBlock(R); } catch (e) { console.warn('autoBlock ' + R.id, e); } try { focusHotspots(R); } catch (e) { console.warn('focusHotspots ' + R.id, e); } try { groundShade(R); } catch (e) { console.warn('groundShade ' + R.id, e); } bake(R.static); for (const k in R.walls) { bake(R.walls[k].full); } queueMicrotask(() => { bakeColours([R.static, ...Object.values(R.walls).map(x => x.full)], R.root); freeze(R.static); for (const k in R.walls) { const w = R.walls[k]; if (w.full) freeze(w.full); if (w.stub) freeze(w.stub); } }); };
  return R;
}

/**
 * The fixed night light rig. Always 1 hemisphere + 1 moon (shadow) + exactly 4 point lights so every room
 * compiles the same shaders. Unused points get intensity 0.
 * @param {THREE.Object3D} parent
 * @param {{ sky?:string, ground?:string, ambient?:number, moon?:string, moonI?:number, moonFrom?:number[], room?: {w:number,d:number},
 *   points?: {x:number,y:number,z:number,color:string,i:number,d?:number}[] }} o
 */
export function lightRig(parent, o = {}) {
  const hemi = new THREE.HemisphereLight(o.sky || '#3a4374', o.ground || '#1c1424', o.ambient ?? 0.85); parent.add(hemi);
  const moon = new THREE.DirectionalLight(o.moon || '#8fa8ff', o.moonI ?? 0.6);
  const f = o.moonFrom || [-6, 9, -4]; moon.position.set(f[0], f[1], f[2]); moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048); const s = Math.max(o.room?.w || 10, o.room?.d || 10) * 0.75; const c = moon.shadow.camera;
  c.left = -s; c.right = s; c.top = s; c.bottom = -s; c.near = 0.5; c.far = 40; moon.shadow.bias = -0.0005; moon.shadow.normalBias = 0.02;
  parent.add(moon, moon.target);
  const points = [];
  for (let i = 0; i < 4; i++) {
    const p = o.points?.[i]; const l = new THREE.PointLight(p?.color || '#ffffff', p ? p.i : 0, p?.d ?? 6, 1.7);
    if (p) l.position.set(p.x, p.y, p.z); parent.add(l); points.push(l);
  }
  return { hemi, moon, points };
}

/** One continuous slab + rim under every room of a joined floor (rooms on joined floors skip their own). Add to the floor's root. */
export function floorSlab(rooms, o = {}) {
  const g = new THREE.Group(); g.name = 'floor-slab';
  // each room's slab only sticks out on sides with NO neighbour: neighbouring slabs used to overlap by 0.4 m, so along
  // the building's outer edge two identical faces sat on top of each other and flickered as the camera moved
  const touches = (r, side) => rooms.some(q => q !== r && (
    side === 'w' ? Math.abs((q.x + q.w / 2) - (r.x - r.w / 2)) < 0.05 && Math.min(q.z + q.d / 2, r.z + r.d / 2) - Math.max(q.z - q.d / 2, r.z - r.d / 2) > 0.5 :
    side === 'e' ? Math.abs((q.x - q.w / 2) - (r.x + r.w / 2)) < 0.05 && Math.min(q.z + q.d / 2, r.z + r.d / 2) - Math.max(q.z - q.d / 2, r.z - r.d / 2) > 0.5 :
    side === 'n' ? Math.abs((q.z + q.d / 2) - (r.z - r.d / 2)) < 0.05 && Math.min(q.x + q.w / 2, r.x + r.w / 2) - Math.max(q.x - q.w / 2, r.x - r.w / 2) > 0.5 :
                   Math.abs((q.z - q.d / 2) - (r.z + r.d / 2)) < 0.05 && Math.min(q.x + q.w / 2, r.x + r.w / 2) - Math.max(q.x - q.w / 2, r.x - r.w / 2) > 0.5));
  for (const r of rooms) {
    const ext = e => ({ w: touches(r, 'w') ? 0 : e, e: touches(r, 'e') ? 0 : e, n: touches(r, 'n') ? 0 : e, s: touches(r, 's') ? 0 : e });
    const a = ext(0.2), b = ext(0.25);
    const slab = rbox(r.w + a.w + a.e, 0.6, r.d + a.n + a.s, mat(o.slab || '#17121f', { roughness: 0.9 }), 0.02); slab.position.set(r.x + (a.e - a.w) / 2, -0.31, r.z + (a.s - a.n) / 2); slab.castShadow = false; g.add(slab);
    const lip = rbox(r.w + b.w + b.e, 0.06, r.d + b.n + b.s, mat(o.trim || '#3d3240'), 0.01); lip.position.set(r.x + (b.e - b.w) / 2, -0.05, r.z + (b.s - b.n) / 2); lip.castShadow = false; g.add(lip);
  }
  bake(g); bakeColours([g], g); return g;
}
