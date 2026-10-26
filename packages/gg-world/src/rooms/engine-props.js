// @ts-check
// The Engine Room props: GG Coder's parts made physical (boiler daemon, gear-train agent loop, model switchboard,
// tool pegboard, tape-reel memory, goal conveyor, XP forge). Each builder returns { g, ...moving parts }.
// Moving parts are returned separately so the room can put them in R.live; everything else is static.
import * as THREE from 'three';
import { mat, glowMat, rbox, put, mesh } from './kit.js';
import * as TX from './tex.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const IRON = mat('#4a4f5c', { metalness: 0.6, roughness: 0.4 });
export const IRON_D = mat('#2c3038', { metalness: 0.6, roughness: 0.4 });
export const BRASS = mat('#c8963a', { metalness: 0.6, roughness: 0.4 });
export const COPPER = mat('#b8643a', { metalness: 0.6, roughness: 0.4 });
export const WOOD = mat('#7a5034');
export const WOOD_D = mat('#4e3222');
export const GREEN = mat('#2f9e63');
export const cyl = (rt, rb, h, m, seg = 16) => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);

/** a toothed gear (extruded), centred, facing +z */
export function gearGeo(r, teeth, depth = 0.12, hole = 0.25) {
  const s = new THREE.Shape(), n = teeth * 4;
  for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2, k = i % 4, rr = k === 1 || k === 2 ? r : r * 0.86; const x = Math.cos(a) * rr, y = Math.sin(a) * rr; i ? s.lineTo(x, y) : s.moveTo(x, y); }
  const h = new THREE.Path(); h.absarc(0, 0, r * hole, 0, Math.PI * 2, true); s.holes.push(h);
  for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2, p = new THREE.Path(); p.absarc(Math.cos(a) * r * 0.56, Math.sin(a) * r * 0.56, r * 0.14, 0, Math.PI * 2, true); s.holes.push(p); }
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelSize: 0.015, bevelThickness: 0.015, bevelSegments: 1, curveSegments: 6 }); g.translate(0, 0, -depth / 2); return g;
}

const PLAQUES = ['The Daemon', 'The Agent Loop', 'The Model Router', 'The Tool Bench', 'Memory & Sessions', 'The Goal Farm', 'The XP Forge'];
let plaqueM = null;
/** brass plaque with a station name: all names share ONE atlas material (they bake into one draw call) */
export function plaque(text) {
  const g = new THREE.Group(), i = Math.max(0, PLAQUES.indexOf(text)), n = PLAQUES.length;
  put(g, rbox(1.5, 0.36, 0.05, BRASS, 0.02), 0, 0, 0);
  plaqueM = plaqueM || new THREE.MeshBasicMaterial({ toneMapped: false, map: TX.canvasTex('eng-plaques', 512, 112 * n, (x, w) => { x.fillStyle = '#2a1a10'; x.fillRect(0, 0, w, 112 * n); x.font = '96px m5x7'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = '#ffe2a0'; PLAQUES.forEach((s, k) => x.fillText(s, w / 2, k * 112 + 58)); }) });
  const geo = new THREE.PlaneGeometry(1.4, 0.3), uv = geo.attributes.uv;
  for (let k = 0; k < uv.count; k++) uv.setY(k, (n - 1 - i + uv.getY(k)) / n);
  const p = new THREE.Mesh(geo, plaqueM); p.position.z = 0.03; p.castShadow = false; g.add(p); return g;
}

/** The Daemon: a squat boiler with a pressure gauge, valve wheel and three pipes up to window frames. */
export function boiler() {
  const g = new THREE.Group();
  const pts = []; for (let i = 0; i <= 10; i++) { const t = i / 10; pts.push(new THREE.Vector2(0.95 + Math.sin(t * Math.PI) * 0.06, t * 2.0)); }
  put(g, mesh(new THREE.LatheGeometry(pts, 24), COPPER), 0, 0.25, 0);
  put(g, mesh(new THREE.SphereGeometry(0.97, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), COPPER), 0, 2.25, 0);
  for (const y of [0.4, 1.25, 2.1]) put(g, cyl(1.03, 1.03, 0.08, BRASS, 24), 0, y, 0);
  put(g, cyl(1.1, 1.15, 0.25, IRON_D, 24), 0, 0.12, 0);
  // firebox door + window
  put(g, rbox(0.7, 0.45, 0.12, IRON_D, 0.04), 0.0, 0.62, 0.95);
  const fire = put(g, new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.22), glowMat('#ff8a3a', 2.4)), 0, 0.62, 1.02);
  // gauge (needle animated)
  const gauge = new THREE.Group(); put(gauge, cyl(0.24, 0.24, 0.06, BRASS, 20), 0, 0, 0).rotation.x = Math.PI / 2;
  put(gauge, new THREE.Mesh(new THREE.CircleGeometry(0.2, 20), mat('#f3e6cc')), 0, 0, 0.032);
  put(gauge, new THREE.Mesh(new THREE.RingGeometry(0.12, 0.19, 12, 1, -0.5, 1.0), glowMat('#e8645a', 1.2)), 0, 0, 0.034);
  const ng = new THREE.BoxGeometry(0.025, 0.17, 0.01); ng.translate(0, 0.075, 0); const needle = new THREE.Mesh(ng, mat('#1a1a1a', { roughness: 0.84 })); needle.castShadow = false;
  put(g, gauge, 0.55, 1.65, 0.83, 0.55);
  // valve wheel
  const wheel = put(g, mesh(new THREE.TorusGeometry(0.2, 0.035, 8, 20), mat('#c8302a')), -0.62, 1.7, 0.78, -0.65);
  put(g, cyl(0.05, 0.05, 0.3, IRON, 8), -0.55, 1.7, 0.7).rotation.x = Math.PI / 2; void wheel;
  // chimney pipe
  put(g, cyl(0.16, 0.16, 0.8, IRON, 12), 0, 3.0, -0.3);
  return { g, fire, needle };
}

/** The Agent Loop: four gears on a riveted backplate (wall-mounted). Returns gears (live) with spin rates. */
export function gearWall() {
  const g = new THREE.Group();
  put(g, rbox(4.2, 2.3, 0.1, IRON_D, 0.05), 0, 1.75, 0);
  for (let i = 0; i < 12; i++) put(g, mesh(new THREE.SphereGeometry(0.035, 6, 4), BRASS), -2.0 + (i % 6) * 0.8, i < 6 ? 2.82 : 0.68, 0.06);
  const spec = [[-1.35, 1.95, 0.62, 14, BRASS], [-0.1, 1.45, 0.5, 11, COPPER], [0.95, 2.05, 0.42, 9, BRASS], [1.6, 1.2, 0.3, 7, COPPER]];
  const GM = [mat('#c8963a', { metalness: 0.75, roughness: 0.31 }), mat('#b8643a', { metalness: 0.7, roughness: 0.33 })];
  const gears = spec.map(([x, y, r, n], i) => { const ge = mesh(gearGeo(/** @type {number} */ (r), /** @type {number} */ (n)), GM[i % 2]); ge.position.set(/** @type {number} */ (x), /** @type {number} */ (y), 0.14); ge.userData.rate = (i % 2 ? -1 : 1) * 0.5 * 0.62 / /** @type {number} */ (r); ge.castShadow = false; return ge; });
  // hubs
  for (const [x, y] of spec) put(g, cyl(0.08, 0.08, 0.3, IRON, 10), /** @type {number} */ (x), /** @type {number} */ (y), 0.14).rotation.x = Math.PI / 2;
  // 4 stage lamps under the gears: prompt / model / tools / result
  const lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 12, 8), new THREE.MeshBasicMaterial({ toneMapped: false }), 4); lamps.castShadow = false;
  [-1.5, -0.5, 0.5, 1.5].forEach((x, i) => { lamps.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, 0.62, 0.12)); lamps.setColorAt(i, new THREE.Color('#3a2a1a')); });
  for (const x of [-1.5, -0.5, 0.5, 1.5]) put(g, cyl(0.12, 0.12, 0.06, BRASS, 12), x, 0.62, 0.07).rotation.x = Math.PI / 2;
  const tags = new THREE.Mesh(new THREE.PlaneGeometry(4, 0.22), new THREE.MeshBasicMaterial({ map: stageTex(), transparent: true, toneMapped: false })); tags.position.set(0, 0.88, 0.07); tags.castShadow = false; g.add(tags);
  return { g, gears, lamps };
}
function stageTex() { return TX.canvasTex('eng-stages', 1024, 56, (x, w, h) => { x.font = '52px m5x7'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = '#ffe2a0'; ['PROMPT', 'MODEL', 'TOOLS', 'RESULT'].forEach((s, i) => x.fillText(s, (i + 0.5) * w / 4, h / 2)); }); }

/** Model Router: an old telephone switchboard. Lamps are one InstancedMesh (colours changed by the room). */
export function switchboard() {
  const g = new THREE.Group();
  put(g, rbox(2.6, 0.85, 0.9, WOOD, 0.04), 0, 0.42, 0.15);                 // desk
  put(g, rbox(2.7, 0.06, 1.0, WOOD_D, 0.02), 0, 0.88, 0.15);
  put(g, rbox(2.6, 1.6, 0.25, WOOD, 0.04), 0, 1.7, -0.25);                 // upright
  put(g, rbox(2.3, 1.3, 0.04, mat('#1a1410'), 0.01), 0, 1.7, -0.11);
  const names = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 0.2), new THREE.MeshBasicMaterial({ map: TX.canvasTex('eng-prov', 1024, 88, (x, w, h) => { x.font = '64px m5x7'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = '#f3e6cc'; ['CLAUDE', 'GPT', 'GEMINI', 'GROK', 'KIMI', 'LOCAL'].forEach((s, i) => x.fillText(s, (i + 0.5) * w / 6, h / 2)); }), transparent: true, toneMapped: false }));
  names.position.set(0, 2.25, -0.085); names.castShadow = false; g.add(names);
  // jacks (static) + lamps (instanced, live)
  const jm = mat('#0a0a0a'), n = 18;
  const lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshBasicMaterial({ toneMapped: false }), n);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < n; i++) { const c = i % 6, r = Math.floor(i / 6), x = -0.96 + c * 0.384, y = 1.95 - r * 0.32;
    put(g, cyl(0.04, 0.04, 0.03, jm, 8), x, y - 0.12, -0.08).rotation.x = Math.PI / 2;
    m4.makeTranslation(x, y, -0.07); lamps.setMatrixAt(i, m4); lamps.setColorAt(i, new THREE.Color('#3a2a1a')); }
  // patch cords: a few drooping cables from desk plugs up to jacks
  const cols = ['#e8645a', '#62e8d8', '#f5bd63', '#6ee7a0'];
  cols.forEach((c, i) => { const x0 = -0.8 + i * 0.5, x1 = -0.96 + ((i * 2 + 1) % 6) * 0.384, y1 = 1.83 - (i % 3) * 0.32;
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(x0, 0.95, 0.35), new THREE.Vector3((x0 + x1) / 2, 1.0, 0.25), new THREE.Vector3(x1, y1 - 0.15, 0.0), new THREE.Vector3(x1, y1, -0.07)]);
    const tm = mesh(new THREE.TubeGeometry(curve, 16, 0.018, 5), mat(c)); tm.castShadow = false; g.add(tm);
    put(g, cyl(0.035, 0.035, 0.14, BRASS, 8), x0, 0.96, 0.35); });
  return { g, lamps };
}

/** The Tool Bench: pegboard on the wall with labelled tool silhouettes + a workbench under it. */
export function toolBench() {
  const g = new THREE.Group();
  put(g, rbox(3.0, 0.08, 0.8, WOOD_D, 0.02), 0, 0.92, 0.42);
  for (const x of [-1.35, 1.35]) for (const z of [0.1, 0.72]) put(g, rbox(0.08, 0.9, 0.08, IRON_D, 0.01), x, 0.45, z);
  put(g, rbox(2.8, 0.05, 0.6, WOOD, 0.01), 0, 0.25, 0.42);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.5), mat('#ffffff', { map: pegTex(), roughness: 0.9 })); board.position.set(0, 1.85, 0.03); board.receiveShadow = true; g.add(board);
  put(g, rbox(3.1, 1.6, 0.04, WOOD_D, 0.01), 0, 1.85, 0.0);
  // a few real tools hanging in front: wrench (edit), magnifier (grep), book (read), terminal (bash)
  const wr = wrench(); wr.position.set(-1.05, 1.95, 0.08); wr.rotation.z = 0.3; g.add(wr);
  const mag = new THREE.Group(); put(mag, mesh(new THREE.TorusGeometry(0.13, 0.03, 8, 18), BRASS), 0, 0, 0); put(mag, new THREE.Mesh(new THREE.CircleGeometry(0.12, 16), mat('#9fd8ff', { roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.6 })), 0, 0, 0); put(mag, rbox(0.05, 0.3, 0.04, WOOD_D, 0.01), 0, -0.27, 0); mag.position.set(-0.35, 2.0, 0.08); g.add(mag);
  put(g, rbox(0.3, 0.38, 0.08, mat('#8a2a2a'), 0.02), 0.35, 1.95, 0.08);
  put(g, rbox(0.42, 0.3, 0.05, IRON_D, 0.02), 1.05, 1.95, 0.08);
  const term = put(g, new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.24), new THREE.MeshBasicMaterial({ map: TX.termScreen(7, '#6ee7a0'), toneMapped: false })), 1.05, 1.95, 0.11); term.castShadow = false;
  // bench clutter
  put(g, rbox(0.5, 0.2, 0.3, mat('#c8302a', { metalness: 0.6, roughness: 0.4 }), 0.03), -0.9, 1.06, 0.45);
  put(g, cyl(0.06, 0.06, 0.14, mat('#e8e0d0'), 10), 0.9, 1.03, 0.5);
  return { g };
}
/** a hand wrench (also held by Ken) */
export function wrench() {
  const g = new THREE.Group(); const m = mat('#b8bcc8', { metalness: 0.6, roughness: 0.4 });
  put(g, rbox(0.05, 0.36, 0.02, m, 0.008), 0, 0, 0);
  const head = mesh(new THREE.TorusGeometry(0.06, 0.022, 6, 12, Math.PI * 1.5), m); head.position.y = 0.21; head.rotation.z = -Math.PI * 0.25; g.add(head);
  return g;
}
function pegTex() {
  return TX.canvasTex('eng-peg', 512, 256, (x, w, h) => {
    x.fillStyle = '#c8a878'; x.fillRect(0, 0, w, h); x.fillStyle = 'rgba(60,40,20,0.55)';
    for (let yy = 8; yy < h; yy += 16) for (let xx = 8; xx < w; xx += 16) { x.beginPath(); x.arc(xx, yy, 2.2, 0, 7); x.fill(); }
    x.font = '30px m5x7'; x.textAlign = 'center'; x.fillStyle = '#3a2414';
    [['edit', 0.15], ['grep', 0.38], ['read', 0.62], ['bash', 0.85]].forEach(([s, u]) => { x.fillStyle = 'rgba(58,36,20,0.85)'; x.fillRect(/** @type {number} */ (u) * w - 34, h - 50, 68, 26); x.fillStyle = '#f3e6cc'; x.fillText(/** @type {string} */ (s), /** @type {number} */ (u) * w, h - 30); });
    x.fillStyle = '#3a2414'; x.font = '26px m5x7'; x.fillText('find  ls  web  ask  plan  skills  mcp ...', w / 2, 30);
  });
}

/** Memory & Sessions: a reel-to-reel tape cabinet next to filing drawers. Returns the two reels (live). */
export function tapeDeck() {
  const g = new THREE.Group();
  put(g, rbox(1.4, 1.9, 0.6, mat('#d8cfb8'), 0.05), 0, 0.95, 0);
  put(g, rbox(1.25, 0.8, 0.04, mat('#2a2a30', { metalness: 0.6, roughness: 0.4 }), 0.02), 0, 1.4, 0.31);
  for (let i = 0; i < 4; i++) put(g, cyl(0.04, 0.04, 0.04, i === 0 ? mat('#c8302a') : IRON_D, 10), -0.4 + i * 0.27, 0.82, 0.31).rotation.x = Math.PI / 2;
  const vu = put(g, new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.14), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffb36b').multiplyScalar(1.3), toneMapped: false })), 0, 0.62, 0.32);
  const reelGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.04, 20), reelM = mat('#9aa4b2', { metalness: 0.7, roughness: 0.29 }), tapeM = mat('#3a2a1a');
  void tapeM; const reels = [-0.33, 0.33].map((x) => { const parts = [reelGeo.clone()];
    for (let k = 0; k < 3; k++) { const s = new THREE.BoxGeometry(0.05, 0.06, 0.16); s.rotateY(-k * 2.09); s.translate(Math.cos(k * 2.09) * 0.13, 0.03, Math.sin(k * 2.09) * 0.13); parts.push(s); }
    const geo = mergeGeometries(parts.map(p => p.index ? p.toNonIndexed() : p)); geo.rotateX(Math.PI / 2);
    const r = new THREE.Mesh(geo, reelM); r.castShadow = false; r.position.set(x, 1.45, 0.36); return r; });
  // filing cabinet beside it
  const fc = new THREE.Group(); put(fc, rbox(0.7, 1.4, 0.65, mat('#5a6a5a', { metalness: 0.6, roughness: 0.4 }), 0.03), 0, 0.7, 0);
  for (let i = 0; i < 3; i++) { put(fc, rbox(0.6, 0.38, 0.03, mat('#6a7a6a', { metalness: 0.6, roughness: 0.4 }), 0.01), 0, 0.28 + i * 0.44, 0.33); put(fc, rbox(0.2, 0.04, 0.04, BRASS, 0.01), 0, 0.38 + i * 0.44, 0.36); put(fc, rbox(0.16, 0.07, 0.01, mat('#f3e6cc'), 0.004), 0, 0.3 + i * 0.44, 0.35); }
  put(g, fc, 1.15, 0, 0.0);
  return { g, reels, vu };
}

/** The Goal Farm: a roller conveyor from a dispatch hopper to three worker bays. Crates are instanced (live). */
export function conveyor(len = 5) {
  const g = new THREE.Group();
  put(g, rbox(len, 0.12, 0.8, IRON, 0.02), 0, 0.66, 0);
  for (const s of [-1, 1]) put(g, rbox(len, 0.1, 0.06, mat('#d8a43a', { metalness: 0.6, roughness: 0.4 }), 0.01), 0, 0.75, s * 0.42);
  for (let i = 0; i < 5; i++) { const x = -len / 2 + 0.3 + i * (len - 0.6) / 4; for (const s of [-1, 1]) put(g, rbox(0.08, 0.62, 0.08, IRON_D, 0.01), x, 0.31, s * 0.32); }
  const roll = new THREE.CylinderGeometry(0.05, 0.05, 0.76, 8); roll.rotateX(Math.PI / 2);
  for (let i = 0; i < 18; i++) put(g, mesh(roll, mat('#9aa4b2', { metalness: 0.6, roughness: 0.4 })), -len / 2 + 0.15 + i * (len - 0.3) / 17, 0.74, 0);
  // dispatch hopper (GG Goals) at the start, three worker bays at the end
  put(g, rbox(0.9, 1.4, 0.9, mat('#2f9e63'), 0.05), -len / 2 - 0.4, 0.7, 0);
  put(g, rbox(0.7, 0.04, 0.02, glowMat('#6ee7a0', 1.6), 0.01), -len / 2 - 0.4, 1.2, 0.46);
  for (let i = 0; i < 3; i++) { const bx = len / 2 + 0.5, bz = (i - 1) * 0.7; put(g, rbox(0.6, 0.55, 0.6, WOOD, 0.03), bx, 0.28, bz); }
  const lamp = new THREE.InstancedMesh(new THREE.SphereGeometry(0.07, 10, 6), new THREE.MeshBasicMaterial({ toneMapped: false }), 3);
  const m4 = new THREE.Matrix4(); for (let i = 0; i < 3; i++) { m4.makeTranslation(len / 2 + 0.5, 0.62, (i - 1) * 0.7); lamp.setMatrixAt(i, m4); lamp.setColorAt(i, new THREE.Color('#3a2a1a')); }
  const crates = new THREE.InstancedMesh(rbox(0.42, 0.34, 0.42, IRON, 0.04).geometry, mat('#c89a5a'), 6); crates.castShadow = true;
  return { g, crates, lamp, len };
}

/** The XP Forge: brick furnace with glowing coals, an anvil and a stack of coins. */
export function forge() {
  const g = new THREE.Group(); const brick = mat('#ffffff', { map: TX.brick('#8a4a34', '#3a2018', 41), roughness: 0.9 });
  put(g, rbox(1.6, 1.1, 1.2, brick, 0.04), 0, 0.55, 0);
  put(g, rbox(1.0, 0.4, 0.2, mat('#1a0e0a'), 0.02), 0, 0.75, 0.55);
  const coals = put(g, new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.32), new THREE.MeshBasicMaterial({ color: '#ff7a2a', toneMapped: false })), 0, 0.75, 0.66);
  const hood = mesh(new THREE.CylinderGeometry(0.25, 0.75, 0.7, 4, 1), IRON_D); hood.rotation.y = Math.PI / 4; put(g, hood, 0, 1.45, 0);
  put(g, cyl(0.2, 0.2, 1.2, IRON_D, 10), 0, 2.4, 0);
  // anvil
  const an = new THREE.Group(); put(an, rbox(0.3, 0.45, 0.3, IRON_D, 0.03), 0, 0.22, 0); put(an, rbox(0.7, 0.18, 0.28, IRON, 0.04), 0.05, 0.54, 0);
  const horn = mesh(new THREE.ConeGeometry(0.11, 0.3, 10), IRON); horn.rotation.z = Math.PI / 2; horn.position.set(-0.43, 0.55, 0); an.add(horn); put(g, an, 1.35, 0, 0.6, 0.3);
  // coin stacks + level gauge column
  for (const [x, z, n] of [[-1.15, 0.6, 6], [-1.4, 0.35, 4], [-1.0, 0.25, 8]]) for (let i = 0; i < n; i++) put(g, cyl(0.1, 0.1, 0.03, mat('#f5bd63', { metalness: 0.6, roughness: 0.4 }), 14), x + (i % 2) * 0.01, 0.015 + i * 0.032, z);
  const col = new THREE.Group(); put(col, rbox(0.3, 1.8, 0.3, BRASS, 0.04), 0, 0.9, 0); put(col, rbox(0.16, 1.5, 0.02, mat('#1a1410'), 0.01), 0, 0.95, 0.16); put(g, col, -0.5, 0, -0.75);
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 1.44), glowMat('#6ee7a0', 1.8)); fill.geometry.translate(0, 0.72, 0); fill.position.set(-0.5, 0.23, -0.585); fill.castShadow = false;
  return { g, coals, fill };
}
