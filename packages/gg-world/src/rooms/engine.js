// @ts-check
// The Engine Room: GG Coder itself as a cozy-industrial machine hall under the house. Seven stations, each a real part
// of the app made physical: the Daemon (boiler the windows pipe into), the Agent Loop (gear train), the Model Router
// (switchboard), the Tool Bench (pegboard), Memory & Sessions (tape reels + files), the Goal Farm (worker conveyor)
// and the XP Forge. Ken (resident, people/residents-engine.js) wanders between them fixing things: when he stops at a
// station the room answers with a spark or steam puff. Local frame x -11..11, z -7..7. The w wall belongs to the
// basement (never mount there; opening at w z=0, kept clear). Only the n wall is ours to mount on.
import * as THREE from 'three';
import { makeRoom, lightRig, mat, glowMat, rbox, put, mesh } from './kit.js';
import * as FX from './kit-fx.js';
import * as TX from './tex.js';
import * as P from './engine-props.js';
import { roomGlow } from './bar-glow.js';

const H = Math.PI / 2;
/** station spots (room-local): where the machine is + where you stand to use it */
export const STATIONS = {
  daemon: { x: -7.6, z: -3.3, label: 'The Daemon', fx: 'steam', at: [-7.6, 2.4, -4.6] },
  loop: { x: -1.5, z: -5.5, label: 'The Agent Loop', fx: 'spark', at: [-1.5, 1.6, -6.5] },
  router: { x: 3.6, z: -4.9, label: 'The Model Router', fx: 'spark', at: [3.6, 1.5, -6.2] },
  tools: { x: 8.3, z: -5.4, label: 'The Tool Bench', fx: 'spark', at: [8.3, 1.1, -6.4] },
  memory: { x: -6.0, z: 4.7, label: 'Memory & Sessions', fx: 'steam', at: [-6.4, 1.5, 3.6] },
  goals: { x: 1.0, z: 4.9, label: 'The Goal Farm', fx: 'spark', at: [1.0, 1.0, 3.5] },
  forge: { x: 8.5, z: 4.9, label: 'The XP Forge', fx: 'spark', at: [8.5, 1.0, 3.9] },
};

/** @param {any} ctx */
export function build(ctx) { void ctx;
  const R = /** @type {any} */ (makeRoom({ id: 'engine', floor: TX.plaster('#8a7e70', 52), floorRepeat: 3, wall: TX.brick('#8a5a44', '#3a2620', 53), trim: '#3a2a22', base: '#241a16' }));
  const S = R.static, L = R.live, D2 = R.d / 2;
  const st = (o, x, y, z, ry = 0, block = false) => { put(S, o, x, y, z, ry); if (block) R.blockObj(o); return o; };
  const live = (o, x, y, z, ry = 0) => { put(L, o, x, y, z, ry); o.traverse(c => { c.userData.live = true; }); return o; };
  const glows = /** @type {any[]} */ ([]), noShadow = /** @type {any[]} */ ([]);

  // ----- floor: hazard-striped walkway + drain plates
  const walk = new THREE.Mesh(new THREE.PlaneGeometry(19, 2.2), mat('#ffffff', { map: walkTex(), roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
  walk.rotation.x = -H; walk.position.set(0.5, 0.012, 0.6); walk.receiveShadow = true; walk.castShadow = false; S.add(walk);

  // ----- ceiling pipes + cable tray along the north wall
  for (const [y, out, r, m] of [[2.95, 0.14, 0.07, P.COPPER], [2.72, 0.1, 0.04, P.IRON], [2.55, 0.26, 0.05, P.IRON_D]]) { const p = mesh(new THREE.CylinderGeometry(/** @type {number} */ (r), /** @type {number} */ (r), R.w, 10), /** @type {any} */ (m)); p.rotation.z = H; p.castShadow = false; R.onWall('n', p, 0, /** @type {number} */ (y), /** @type {number} */ (out)); }
  for (let i = 0; i < 9; i++) R.onWall('n', rbox(0.06, 0.2, 0.3, P.BRASS, 0.01), -10 + i * 2.5, 2.85, 0.15);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.6), new THREE.MeshBasicMaterial({ map: TX.neon('GG CODER · ENGINE ROOM', '#6ee7a0', 1024, 160, 'italic 700 92px sans-serif'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  sign.userData.live = true; sign.castShadow = false; R.onWall('n', sign, 5.9, 2.75, 0.06);

  // ----- 1. the Daemon: boiler + three pipes up to window frames (the app windows it serves)
  const B = P.boiler(); st(B.g, -7.6, 0, -4.7, 0, true);
  const winX = [-9.6, -7.6, -5.6];
  winX.forEach(x => {
    const fr = new THREE.Group(); put(fr, rbox(0.9, 0.62, 0.06, P.WOOD_D, 0.02), 0, 0, 0);
    put(fr, new THREE.Mesh(new THREE.PlaneGeometry(0.76, 0.46), glowMat('#8fd8ff', 0.9)), 0, 0, 0.035); put(fr, rbox(0.76, 0.06, 0.02, mat('#2a3a4a'), 0.01), 0, 0.2, 0.04);
    R.onWall('n', fr, x, 2.2, 0.05);
  });
  // pipes: boiler top -> wall -> each window (vertical risers)
  for (const x of winX) { const v = P.cyl(0.05, 0.05, 0.75, P.COPPER, 8); put(S, v, x, 1.52, -6.85); }
  const run = P.cyl(0.055, 0.055, 4.2, P.COPPER, 8); run.rotation.z = H; put(S, run, -7.6, 1.15, -6.85);
  const feed = P.cyl(0.055, 0.055, 1.2, P.COPPER, 8); feed.rotation.x = H; put(S, feed, -7.6, 1.15, -6.3);
  const packets = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3)), new THREE.PointsMaterial({ color: '#8fd8ff', size: 0.3, map: TX.dotTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  packets.frustumCulled = false; live(packets, 0, 0, 0);
  live(B.needle, -7.6 + 0.55 + 0.04 * Math.sin(0.55), 1.65, -4.7 + 0.83 + 0.04 * Math.cos(0.55), 0.55);
  const fireG = live(FX.glow('#ff8a3a', 1.4, 0.5), -7.6, 0.65, -3.6);

  // ----- 2. the Agent Loop: gear wall
  const GW = P.gearWall(); R.onWall('n', GW.g, -1.5, 0, 0.06);
  const gears = GW.gears.map(g => { g.userData.live = true; GW.g.add(g); return g; });
  GW.lamps.userData.live = true; GW.g.add(GW.lamps);
  R.block(-3.7, -D2, 0.7, -D2 + 0.5);

  // ----- 3. Model Router: switchboard
  const SB = P.switchboard(); st(SB.g, 3.6, 0, -6.4, 0, true); const sbL = live(SB.lamps, 3.6, 0, -6.4);
  const stool = new THREE.Group(); put(stool, P.cyl(0.22, 0.22, 0.06, P.WOOD, 14), 0, 0.62, 0); put(stool, P.cyl(0.04, 0.12, 0.6, P.IRON_D, 8), 0, 0.3, 0); st(stool, 2.6, 0, -5.2);

  // ----- 4. Tool Bench (pegboard on the wall + bench)
  const TB = P.toolBench(); put(S, TB.g, 8.3, 0, -D2 + 0.02); R.block(6.7, -D2, 9.9, -D2 + 0.95);

  // ----- 5. Memory & Sessions: tape deck + filing cabinet, facing the camera
  const TD = P.tapeDeck(); st(TD.g, -6.4, 0, 3.4, 0, true);
  const reels = TD.reels.map(r => live(r, r.position.x - 6.4, r.position.y, r.position.z + 3.4));
  TD.g.remove(TD.vu); const vu = live(TD.vu, -6.4, 0.62, 3.72);
  // a little shelf of skill manuals by the tape deck
  const shelf = new THREE.Group(); put(shelf, rbox(1.1, 1.2, 0.4, P.WOOD, 0.03), 0, 0.6, 0);
  const sp = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.95), mat('#ffffff', { map: TX.spines(54) })); sp.position.set(0, 0.62, 0.205); shelf.add(sp); st(shelf, -8.8, 0, 3.4, 0, true);

  // ----- 6. Goal Farm: conveyor with crates (instanced)
  const CV = P.conveyor(5); st(CV.g, 1.0, 0, 3.5, 0, true); const crates = live(CV.crates, 1.0, 0, 3.5); const bayL = live(CV.lamp, 1.0, 0, 3.5);
  const hopG = live(FX.glow('#6ee7a0', 1.1, 0.45), 1.0 - 2.9, 1.3, 3.95);

  // ----- 7. XP Forge
  const FG = P.forge(); st(FG.g, 8.5, 0, 3.5, 0, true); FG.g.remove(FG.coals); const coals = live(FG.coals, 8.5, 0.75, 4.16);
  const fill = live(FG.fill, 8.0, 0.23, 2.915);
  const forgeG = live(FX.glow('#ff8a3a', 2.2, 0.55), 8.5, 0.9, 4.3);
  const coin = live(mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.03, 16), mat('#f5bd63', { metalness: 0.8, roughness: 0.26 })), 9.85, 0.62, 4.1); coin.castShadow = false;

  // ----- plaques on posts for every station
  for (const [id, s] of Object.entries(STATIONS)) {
    const post = new THREE.Group(); put(post, P.cyl(0.04, 0.05, 1.2, P.IRON_D, 8), 0, 0.6, 0); put(post, P.cyl(0.18, 0.2, 0.05, P.IRON_D, 12), 0, 0.025, 0);
    const pl = P.plaque(s.label); pl.scale.setScalar(1.25); pl.rotation.x = -0.45; put(post, pl, 0, 1.38, 0);
    const off = { daemon: [1.4, 0.5], loop: [2.6, 0.2], router: [-1.6, 0.4], tools: [-1.9, 0.6], memory: [1.6, -0.2], goals: [-2.8, -0.2], forge: [-1.8, -0.4] }[id] || [1, 0];
    st(post, s.x + off[0], 0, s.z + off[1], 0.3); noShadow.push(post); R.block(s.x + off[0] - 0.2, s.z + off[1] - 0.2, s.x + off[0] + 0.2, s.z + off[1] + 0.2);
  }
  // ----- corner clutter: oil drums + spare crates
  for (const [x, z] of [[10.3, -0.8], [10.3, 0.1], [-10.3, -6.2], [10.3, 6.3]]) { const d = P.cyl(0.3, 0.3, 0.9, mat(x > 0 ? '#2f6a8a' : '#8a3a2a', { metalness: 0.6, roughness: 0.4 }), 14); st(d, x, 0.45, z, 0, true); }
  for (const [x, z, y] of [[-10.2, 6.2, 0.25], [-9.6, 6.3, 0.25], [-9.9, 6.25, 0.75]]) st(rbox(0.5, 0.5, 0.5, P.WOOD, 0.03), x, y, z, y * 0.4, true);

  // ----- Ken's fix-it effects: one Points cloud for sparks, one for steam (2 draw calls, only while visible)
  const fxPts = (n, color, size, blend) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({ color, size, map: TX.dotTex(), transparent: true, depthWrite: false, blending: blend, toneMapped: false, opacity: 0 })); p.visible = false; p.frustumCulled = false; p.userData.live = true; L.add(p); return p; };
  const spark = fxPts(16, '#ffd070', 0.12, THREE.AdditiveBlending), puff = fxPts(10, '#f0ece4', 0.45, THREE.NormalBlending);
  const sparkV = Array.from({ length: 16 }, (_, i) => [Math.cos(i * 2.4) * (0.6 + (i % 3) * 0.3), 1.2 + (i % 4) * 0.4, Math.sin(i * 2.4) * (0.6 + (i % 3) * 0.3)]);
  let fxT = -99, fxKind = 'spark', fxAt = [0, 0, 0]; const fixed = {};
  const burst = (id) => { const s = STATIONS[id]; if (!s) return; fxT = now; fxKind = s.fx; fxAt = s.at; fixed[id] = now; };

  // ----- lights (exactly 4) + glow pools
  R.rig = lightRig(R.root, { room: R, sky: '#e8c8a0', ground: '#6a4a38', ambient: 2.9, moon: '#ffe0b8', moonI: 0.9, moonFrom: [6, 12, 8], points: [
    { x: -6.5, y: 2.6, z: -2.5, color: '#ffb36b', i: 11, d: 11 },
    { x: 1.0, y: 2.7, z: -2.0, color: '#ffd8a0', i: 10, d: 11 },
    { x: 7.5, y: 2.6, z: -2.5, color: '#ffc890', i: 10, d: 11 },
    { x: 4.0, y: 2.0, z: 3.5, color: '#ff9a50', i: 10, d: 11 }] });
  roomGlow(R, [
    { at: [-7.6, 0.03, -3.4], w: 3, h: 2.4, c: '#ff8a3a', a: 0.22 },
    { at: [8.5, 0.03, 4.6], w: 3.4, h: 2.4, c: '#ff7a2a', a: 0.28 },
    { at: [1.0, 0.03, 3.5], w: 6, h: 2.2, c: '#6ee7a0', a: 0.08 },
    { at: [-1.5, 1.7, 0], w: 4.6, h: 2.6, c: '#ffd890', a: 0.12, face: 'n' },
    { at: [5.9, 2.6, 0], w: 4, h: 1.2, c: '#6ee7a0', a: 0.14, face: 'n' },
    { at: [-7.6, 2.2, 0], w: 5, h: 1.4, c: '#8fd8ff', a: 0.1, face: 'n' }]);
  glows.push(fireG, forgeG);

  R.meta = { id: 'engine', name: 'The Engine Room', blurb: 'How GG Coder actually runs. Mind the gears.' };
  R.spawn = { x: -8.8, z: 0.6, face: H };
  const stand = (id, x, z, face, label, prop) => ({ id, kind: 'stand', x, z, face, anim: 'Idle', label, prop });
  const seat = (id, x, z, face, label, prop) => ({ id, kind: 'bench', x, z, y: 0.5, face, anim: 'Sit_Chair_Idle', label, prop });
  st(rbox(1.6, 0.45, 0.5, P.WOOD_D, 0.04), -2.0, 0.225, -2.2, 0, true); st(rbox(1.6, 0.45, 0.5, P.WOOD_D, 0.04), 5.6, 0.225, -1.6, 0, true);
  R.slots = [
    seat('bench-a', -2.5, -2.2, Math.PI, 'Watching the gears', 'mug'), seat('bench-b', -1.5, -2.2, Math.PI, 'Watching the gears', 'laptop'),
    seat('bench-c', 5.1, -1.6, Math.PI, 'Watching the switchboard', 'laptop'), seat('bench-d', 6.1, -1.6, Math.PI, 'Watching the switchboard', 'drink'),
    stand('rail-a', -3.6, 5.6, Math.PI, 'Watching the conveyor', 'mug'), stand('rail-b', 5.6, 5.8, 2.6, 'Warming up at the forge', 'drink'),
    stand('rail-c', -4.2, -4.4, Math.PI * 0.8, 'Listening to the boiler', 'mug'), stand('rail-d', 10.0, -3.2, -2.4, 'Admiring the tools', 'drink')];
  R.interact = Object.entries(STATIONS).map(([id, s]) => ({ id, x: s.x, z: s.z, r: 1.2, label: s.label, kind: 'board' }));
  R.npc = null;
  R.camera = { zoom: 8, target: new THREE.Vector3(0, 0.8, 0) };
  R.onInteract = (id) => { if (STATIONS[id]) burst(id); };

  // ----- Ken: found by his look tag; gets a wrench in hand; when he stops at a station the station answers
  let ken = null, kenHand = false, kenStill = 0, kenAt = '', lastPos = new THREE.Vector3(), seek = 0;
  const findKen = () => { for (const c of R.root.children) { const av = c.userData?.avatar; if (av?.look?.tag === 'ken') return av; } return null; };
  const giveWrench = (av) => { const b = Object.keys(av.bones || {}).find(k => /hand.*r$|handslotr|wrist.*r$/i.test(k.replace(/[._]/g, ''))); if (!b) return true; const w = P.wrench(); w.scale.setScalar(1.6); w.rotation.x = H; w.traverse(o => { o.userData.live = true; o.castShadow = false; }); av.bones[b].add(w); return true; };

  let now = 0;
  L.traverse(o => { if (o !== crates) o.castShadow = false; });
  R.walls.n.decor.traverse(o => { o.castShadow = false; }); for (const o of noShadow) o.traverse(c => { c.castShadow = false; });
  R.finish();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), col = new THREE.Color();
  const DIM = new THREE.Color('#3a2a1a'), LAMP = ['#6ee7a0', '#f5bd63', '#62e8d8', '#e8645a', '#b07aff', '#ffd890'].map(c => new THREE.Color(c));
  let sbStep = -1, bayStep = -1, lpStep = -1;
  R.tick = (t, dt) => {
    now = t;
    // daemon: breathing firebox, needle sway, packets rising to the windows (one every ~2 s each)
    const br = 0.5 + 0.5 * Math.sin(t * 1.6);
    fireG.material.opacity = 0.35 + 0.2 * br; B.needle.rotation.z = -0.6 + Math.sin(t * 0.7) * 0.25 + (t - (fixed.daemon ?? -99) < 2 ? -0.5 : 0);
    { const a = packets.geometry.attributes.position; winX.forEach((x, i) => { const k = ((t * 0.4 + i * 0.33) % 1); a.setXYZ(i, x, 1.15 + k * 0.85, -6.72); }); a.needsUpdate = true; }
    // agent loop: gears turn; the lamp under the current stage glows (2 s per stage)
    const boost = t - (fixed.loop ?? -99) < 3 ? 2.5 : 1;
    gears.forEach(g => { g.rotation.z += g.userData.rate * dt * boost; g.updateMatrix(); });
    const stage = Math.floor(t / 2) % 4; if (stage !== lpStep) { lpStep = stage; for (let i = 0; i < 4; i++) GW.lamps.setColorAt(i, i === stage ? col.set('#ffd070') : DIM); GW.lamps.instanceColor.needsUpdate = true; }
    // switchboard: a lamp lights every 1.6 s (calls routed to a provider)
    const s2 = Math.floor(t / 1.6); if (s2 !== sbStep) { sbStep = s2; for (let i = 0; i < 18; i++) sbL.setColorAt(i, ((i * 7 + s2 * 5) % 18) < 4 ? LAMP[(i + s2) % 6] : DIM); sbL.instanceColor.needsUpdate = true; }
    // tape reels: slow turn; vu breathes
    reels.forEach((r, i) => { r.rotation.z -= dt * (0.9 + i * 0.5) * (t - (fixed.memory ?? -99) < 3 ? 3 : 1); });
    vu.material.color.setScalar(0.9 + 0.5 * (0.5 + 0.5 * Math.sin(t * 1.3)));
    // conveyor: 6 crates ride from the hopper to the bays and back down (loop every ~12 s)
    const len = CV.len, sp = t - (fixed.goals ?? -99) < 3 ? 0.7 : 0.4;
    for (let i = 0; i < 6; i++) { const k = ((t * sp / len) + i / 6) % 1; v.set(-len / 2 + 0.3 + k * (len - 0.6), 0.97, ((i % 3) - 1) * 0.12); q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, i * 0.4); m4.compose(v, q, one); crates.setMatrixAt(i, m4); }
    crates.instanceMatrix.needsUpdate = true;
    const b2 = Math.floor(t / 2); if (b2 !== bayStep) { bayStep = b2; for (let i = 0; i < 3; i++) bayL.setColorAt(i, (b2 + i) % 3 === 0 ? col.set('#6ee7a0') : (b2 + i) % 3 === 1 ? col.set('#f5bd63') : DIM); bayL.instanceColor.needsUpdate = true; }
    hopG.material.opacity = 0.3 + 0.15 * Math.sin(t * 1.2);
    // forge: coals breathe, level column slowly fills and resets (a level-up every ~16 s), coin flips
    const fb = 0.85 + 0.15 * Math.sin(t * 1.4) + (t - (fixed.forge ?? -99) < 2 ? 0.4 : 0);
    coals.material.color.setRGB(2.6 * fb, 1.25 * fb, 0.42 * fb); forgeG.material.opacity = 0.45 * fb;
    fill.scale.y = 0.05 + 0.95 * ((t / 16) % 1); coin.rotation.x = t * 1.2; coin.position.y = 0.62 + Math.abs(Math.sin(t * 0.8)) * 0.15;
    // Ken: find him (cheap, every second until found), stick a wrench in his hand, fire an effect when he stops at a station
    if (!ken && (seek -= dt) < 0) { seek = 1; ken = findKen(); if (ken && !kenHand) kenHand = giveWrench(ken); }
    if (ken && ken.root.parent === R.root) {
      const p = ken.root.position, moved = p.distanceTo(lastPos) > 0.01; lastPos.copy(p);
      if (moved) { kenStill = 0; kenAt = ''; } else kenStill += dt;
      if (kenStill > 0.6 && !kenAt) { let best = '', bd = 2.4; for (const [id, s] of Object.entries(STATIONS)) { const d = Math.hypot(p.x - s.x, p.z - s.z); if (d < bd) { bd = d; best = id; } } kenAt = best || '-'; if (best) burst(best); }
    } else if (ken && !ken.root.parent) ken = null;
    // effects
    const e = t - fxT, on = e >= 0 && e < 1.6;
    spark.visible = on && fxKind === 'spark'; puff.visible = on && fxKind === 'steam';
    if (on) { const pts = fxKind === 'spark' ? spark : puff, a = pts.geometry.attributes.position, n = a.count;
      for (let i = 0; i < n; i++) { if (fxKind === 'spark') { const [vx, vy, vz] = sparkV[i]; a.setXYZ(i, fxAt[0] + vx * e, fxAt[1] + vy * e - 2.2 * e * e, fxAt[2] + vz * e); }
        else { const k = (e * 0.6 + i / n) % 1; a.setXYZ(i, fxAt[0] + Math.sin(i * 2.1) * 0.25 * k, fxAt[1] + k * 1.1, fxAt[2] + Math.cos(i * 1.7) * 0.25 * k); } }
      a.needsUpdate = true; pts.material.opacity = (fxKind === 'spark' ? 1 : 0.4) * Math.min(1, (1.6 - e) * 1.5); }
  };
  return R;
}

function walkTex() {
  return TX.canvasTex('eng-walk', 1024, 128, (x, w, h) => {
    x.fillStyle = '#6a625a'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 2; i++) { const y = i ? h - 14 : 0; for (let xx = -20; xx < w; xx += 28) { x.fillStyle = '#e0b030'; x.beginPath(); x.moveTo(xx, y); x.lineTo(xx + 14, y); x.lineTo(xx + 28, y + 14); x.lineTo(xx + 14, y + 14); x.fill(); } x.fillStyle = 'rgba(20,16,12,0.7)'; x.fillRect(0, i ? h - 14 : 0, w, 0); }
    x.fillStyle = 'rgba(0,0,0,0.18)'; for (let xx = 0; xx < w; xx += 64) x.fillRect(xx, 14, 2, h - 28);
    x.fillStyle = 'rgba(255,255,255,0.05)'; for (let i = 0; i < 400; i++) x.fillRect((i * 97) % w, (i * 53) % h, 2, 2);
  });
}
