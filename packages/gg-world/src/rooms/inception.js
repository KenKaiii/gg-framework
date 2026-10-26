// @ts-check
// Limbo: a dream architect's space (homage to Inception). Pale stone floor, a city that folds up over itself (NW),
// the Penrose steps (N), furniture defying gravity (NE), facing mirrors (W), a lounge of dream chairs around the
// silver briefcase (centre), the spinning-top table (E) and the Limbo coast with a sandcastle (SW).
import * as THREE from 'three';
import { glowPlanes } from './hackers-props.js';
import { makeRoom, lightRig, mat, put } from './kit.js';
import * as FX from './kit-fx.js';
import * as TX from './tex.js';
import * as P from './inception-props.js';
import * as Q from './inception-props2.js';
import * as Z from './inception-props3.js';
import { poker } from './screening-poke.js';
import { solid1 } from './hackers-solid.js';
import { SFX } from '../sfx.js';

/** @param {any} ctx */
export function build(ctx) { void ctx;
  const R = /** @type {any} */ (makeRoom({ id: 'inception', floor: Z.marbleFloor(), floorRepeat: 6, wall: TX.plaster('#7a7290', 41), trim: '#4a4460', base: '#3a3450' }));
  // local frame: x -15..15, z -9..9. n wall = neighbour's (opening to hackers at x=-4). w = exterior (u = -z). e = ours (opening to tavern at z=0).
  const S = R.static, H = Math.PI / 2;
  const st = (o, x, y, z, ry = 0, block = false) => { put(S, o, x, y, z, ry); if (block) R.blockObj(o); return o; };
  const live = (o, x, y, z, ry = 0) => { put(R.live, o, x, y, z, ry); o.traverse(c => { c.userData.live = true; }); return o; };
  const glows = [];
  const gl = (c, s, o, x, y, z) => { const g = put(R.live, FX.glow(c, s, o), x, y, z); glows.push([g, o]); return g; };
  // floor pools collected into one static instanced additive mesh (opacity folded into the colour) after the build
  const pools = []; const pool = (c, s, o, x, z) => { pools.push([x, 0.015, z, 0, s, s, '#' + new THREE.Color(c).multiplyScalar(o / 0.3).getHexString(), true]); };
  // ----- folding city (NW)
  const city = Q.foldCity(7, 1.7); live(solid1((city.group)), -10.5, 0, -6.6); R.block(-14.2, -8.8, -6.8, -5.9);
  gl('#ffd9a0', 3.0, 0.25, -10.5, 2.4, -7.6);
  // ----- Penrose steps (N)
  const pen = st(Z.penroseStairs(), 4, 0, -5.6, 0.0, true);
  pool('#b8a8ff', 4.5, 0.22, 4, -5.6);
  const walker = live(new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshBasicMaterial({ color: '#fff2d0', toneMapped: false })), 4, 1, -5.6); walker.visible = false;
  // ----- gravity-defying set (NE): sofa tilted mid-air, a chair upside-down above, a table on the wall
  const tilt = new THREE.Group(); live(tilt, 10.5, 0, -6.2);
  const sofaT = P.sofa('#7a5a8a'); put(tilt, sofaT, 0, 0.55, 0); sofaT.rotation.z = 0.32;
  const chairT = P.dreamChair(); put(tilt, chairT, 2.3, 2.1, 0.3); chairT.rotation.set(Math.PI, 0.6, 0.2);
  const tbl = P.topTable(); put(tilt, tbl, -2.0, 1.4, -0.4); tbl.rotation.set(0.5, 0, 0.9);
  const lampT = P.floorLamp(); put(tilt, lampT, 1.0, 1.0, -1.3); lampT.rotation.z = -1.2;
  R.block(8.4, -7.6, 13.4, -5.2); pool('#ffb36b', 3, 0.18, 10.5, -6);
  // ----- facing mirrors (W)
  const m1 = P.mirror(); R.onWall('w', m1, 1.2, 0, 0.03); const m1g = m1.userData.glass; m1.add(m1g);
  const MY = 0.75; const m2 = P.mirror(true); st(m2, -11.6, 0, -1.2, MY); R.block(-11.9, -2.0, -11.3, -0.4);
  const m2g = m2.userData.glass; live(m2g, -11.6 + Math.sin(MY) * 0.045, m2g.position.y, -1.2 + Math.cos(MY) * 0.045, MY);
  const mirT = [m1g.material.map, m2g.material.map];
  // ----- drafting table (dream architect)
  st(Q.draftTable(), -8.2, 0, -3.0, 0.3, true);
  // ----- lounge: six dream chairs around the briefcase
  const C = { x: 0, z: 1.6 }, RAD = 2.4, ang = [0.5, 1.55, 2.6, 3.7, 4.75, 5.8];
  const brief = live(solid1((P.briefcase())), C.x, 0, C.z, 0.4); R.blockObj(brief);
  const lines = mat('#3a3a48');
  ang.forEach(a => { const x = C.x + Math.sin(a) * RAD, z = C.z + Math.cos(a) * RAD; const ch = st(P.dreamChair(), x, 0, z, a); R.blockObj(ch, 0.12);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(new THREE.Vector3(C.x, 0.5, C.z), new THREE.Vector3((x + C.x) / 2, 0.02, (z + C.z) / 2), new THREE.Vector3(C.x + Math.sin(a) * (RAD - 0.4), 0.6, C.z + Math.cos(a) * (RAD - 0.4))), 12, 0.03, 6), lines); tube.castShadow = false; tube.userData.noGround = true;
    st(tube, 0, 0, 0); });
  st(Z.loungeRug(3.9), C.x, 0.008, C.z);
  pool('#ffcf8a', 6, 0.18, C.x, C.z);
  const caseGlow = gl('#ffb36b', 0.8, 0.5, C.x + 0.2, 0.7, C.z);
  // ----- spinning-top table (E) with two sofas
  st(P.topTable(), 9.2, 0, 4.2, 0, true);
  const top = live(P.spinTop(), 9.2, 0.749, 4.2); // resting on the leather inset
  st(P.sofa('#5a6a8a'), 9.2, 0, 6.6, Math.PI, true); st(P.sofa('#5a6a8a'), 11.7, 0, 4.2, -H, true);
  pool('#ffb36b', 4, 0.25, 9.6, 4.8);
  // ----- Limbo coast (SW) with a lit water strip
  st(Q.coast(), -10.6, 0, 5.8); R.block(-10.3, 5.0, -9.2, 6.2);
  const waterM = new THREE.MeshBasicMaterial({ color: '#6fb8d8', transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const water = live(new THREE.Mesh(new THREE.PlaneGeometry(8.5, 1.4), waterM), -10.6, 0.02, 8.1); water.rotation.x = -H;
  // ----- frozen exploding café (S centre): debris + cups hang mid-air, drifting
  st(Z.cafeSet(), -2.4, 0, 6.8, 0.3, true);
  const deb = Z.cafeDebris(); live(deb.group, -2.4, 0, 6.8); const dO = new THREE.Object3D();
  gl('#ffe8c0', 3.2, 0.18, -2.4, 1.4, 6.8); pool('#ffe0b0', 3.4, 0.2, -2.4, 6.8);
  // ----- dream oddities: rotated hallway, sunk door frame, upside-down bookcase, plants
  st(Z.sunkDoor(), 5.6, 0, 7.4, 0.5); R.block(4.8, 7.0, 6.4, 7.8); gl('#ffe8c0', 1.4, 0.3, 5.6, 1.0, 7.6);
  st(Z.bookcaseUpside(), 14.55, 0, -4.2, -H); R.block(14.2, -5.0, 15, -3.4);
  [[13.9, 7.9], [-6.8, -8.2], [0.6, -8.2], [-13.9, 1.6], [12.6, 2.4], [7.4, -2.4], [-0.6, 8.0]].forEach(([x, z], i) => st(Z.plant(i + 3, 0.9 + (i % 3) * 0.25), x, 0, z, i, true));
  // ----- lamps + glows
  const lamps = [[-6.2, 7.2], [5.6, -1.8], [13.2, 6.0], [-13.6, -4.4], [-4.6, 3.6], [4.6, 4.4]];
  for (const [x, z] of lamps) { st(P.floorLamp(), x, 0, z, 0, true); gl('#ffd9a0', 1.2, 0.5, x, 1.65, z); pool('#ffcf8a', 3, 0.22, x, z); }
  live(glowPlanes(pools, 0.3), 0, 0, 0);
  R.live.add(FX.motes(40, new THREE.Vector3(-14, 0.3, -8), new THREE.Vector3(14, 3, 8), '#ffe8c0', 0.04));
  // ----- lights: 4 key lamps
  R.rig = lightRig(R.root, { room: R, sky: '#9a94c0', ground: '#5a4a48', ambient: 3.4, moon: '#a8b8ff', moonI: 1.1, moonFrom: [-12, 12, -4], points: [
    { x: C.x, y: 2.4, z: C.z, color: '#ffcf8a', i: 9, d: 9 },
    { x: -10.5, y: 2.4, z: 5.0, color: '#ffe0b0', i: 7, d: 9 },
    { x: 4, y: 3.8, z: -3.4, color: '#c0b0ff', i: 5, d: 8 }, // higher + softer: the top steps were blown out (bloom popping while walking)
    { x: 9.6, y: 2.2, z: 4.6, color: '#ffb36b', i: 7, d: 7 }] });
  R.meta = { id: 'inception', name: 'Limbo', blurb: 'Dream bigger. Check your totem.' };
  R.spawn = { x: -4, z: -6.5, face: Math.PI * 0.8 };
  const sl = (id, x, z, face, anim, prop, label, kind = 'chair', y = 0) => ({ id, kind, x, z, y, face, anim, prop, label });
  R.slots = [
    ...ang.map((a, i) => ({ ...sl('dream-' + i, C.x + Math.sin(a) * RAD, C.z + Math.cos(a) * RAD, a, 'Sit_Chair_Idle', i % 3 === 2 ? 'mug' : 'laptop', 'Dream chair', 'chair', 0.02),
      ...(i === 0 ? { act: 'inception-under', actLabel: 'Go under' } : {}) })),
    sl('sofa-s', 8.7, 6.55, Math.PI, 'Sit_Chair_Idle', 'laptop', 'Sofa by the totem', 'sofa'),
    sl('sofa-e', 11.65, 3.7, -H, 'Sit_Chair_Idle', 'cocktail', 'Sofa by the totem', 'sofa'),
    sl('sofa-s2', 9.7, 6.55, Math.PI, 'Sit_Chair_Idle', null, 'Sofa by the totem', 'sofa'),
    sl('sofa-e2', 11.65, 4.7, -H, 'Sit_Chair_Idle', null, 'Sofa by the totem', 'sofa'),
    sl('cafe-a', -1.81, 6.62, -H + 0.3, 'Sit_Chair_Idle', null, 'Paris café chair', 'chair', 0.02),
    sl('sand-a', -8.2, 4.4, -2.2, 'Sit_Floor_Idle', 'laptop', 'Limbo beach', 'floor'),
    sl('sand-b', -12.8, 4.6, 2.4, 'Sit_Floor_Idle', 'beer', 'Building sandcastles', 'floor'),
    sl('pen-a', 4, -3.3, Math.PI, 'Idle', 'phone', 'Puzzling over the steps', 'stand'),
    sl('pen-b', 6.2, -3.7, -2.4, 'Idle', 'beer', 'Admiring the paradox', 'stand'),
    sl('mirror', -12.8, -0.2, -H, 'Idle', 'phone', 'Between the mirrors', 'stand'),
    sl('draft', -7.4, -1.9, -2.6, 'Idle', 'mug', 'Watching the architect', 'stand')];
  R.interact = [
    { id: 'totem', x: 9.2, z: 3.4, r: 1.1, label: 'Spin the top', kind: 'gadget' },
    { id: 'draft', x: -8.0, z: -2.0, r: 1.1, label: 'Design a maze', kind: 'gadget' },
    { id: 'mirror', x: -13.3, z: -1.2, r: 1.2, label: 'Look into the mirrors', kind: 'gadget', sfx: false },
    { id: 'city', x: -10.5, z: -5.2, r: 1.6, label: 'Fold the city', kind: 'gadget', sfx: false },
    { id: 'penrose', x: 4, z: -3.4, r: 1.3, label: 'Climb the Penrose steps', kind: 'gadget', sfx: false },
    { id: 'tilt', x: 10.5, z: -4.6, r: 1.5, label: 'Touch the floating sofa', kind: 'gadget', sfx: false },
    { id: 'castle', x: -10.2, z: 4.4, r: 1.2, label: 'Look at the sandcastle', kind: 'gadget', sfx: false },
    { id: 'case', x: C.x + 0.9, z: C.z + 0.9, r: 0.8, label: 'Check the PASIV case', kind: 'gadget', sfx: false }];
  R.npc = null;
  R.camera = { zoom: 8.5, target: new THREE.Vector3(0, 0.8, 0) };
  let now = 0; const fx = { mirror: -99, city: -99, penrose: -99, tilt: -99, castle: -99 };
  const lines2 = { mirror: 'Infinity, give or take a reflection.', city: 'The city folds. Physics shrugs.', penrose: 'Up, up, up... and back again.', tilt: '"Dream a little bigger, darling."', castle: 'Washed away. Like all of Limbo.' };
  const at = (x, z, o = {}) => ({ ...o, at: { x: x + R.root.position.x, z: z + R.root.position.z } });
  const SND = {
    mirror: () => { SFX.play('chime', at(-13.3, -1.2)); SFX.play('eerie', at(-13.3, -1.2, { delay: 0.2, vol: 0.6 })); },
    city: () => { SFX.play('thunder', at(-10.5, -5.2, { vol: 0.35 })); SFX.play('creak', at(-10.5, -5.2, { delay: 0.4 })); SFX.play('eerie', at(-10.5, -5.2, { delay: 0.8, vol: 0.5 })); },
    penrose: () => { for (let i = 0; i < 6; i++) SFX.play('step.marble', at(4, -5.6, { delay: i * 0.25, pitch: 1 + i * 0.04 })); SFX.play('magic', at(4, -5.6, { delay: 1.6, vol: 0.5 })); },
    tilt: () => { SFX.play('whoosh', at(10.5, -4.6)); SFX.play('cushion', at(10.5, -4.6, { delay: 0.5 })); SFX.play('magic', at(10.5, -4.6, { delay: 0.8, vol: 0.5 })); },
    castle: () => { SFX.play('wind', at(-10.2, 5.5)); SFX.play('splash', at(-10.2, 5.5, { delay: 0.9 })); SFX.play('gurgle', at(-10.2, 5.5, { delay: 1.4, vol: 0.5 })); },
  };
  const PK = poker(), vW = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  R.onInteract = (id, api) => {
    if (id in fx) { fx[id] = now; SND[id]?.(); api.toast(lines2[id]); return; }
    if (id === 'case') { PK.poke(brief, 'hop', 0.9, 1.5); SFX.play('snap', at(C.x, C.z)); SFX.play('hum', at(C.x, C.z, { delay: 0.2, vol: 0.6 })); SFX.play('heartbeat', at(C.x, C.z, { delay: 0.6, vol: 0.5 })); api.bubble('Somnacin, 3 doses. Dreams, sold separately.'); }
  };
  // shared state for the activities (src/act/inception*.js)
  R.inception = { top, topSpin: { on: true, speed: 30, tilt: 0, wob: 0 }, chair: { x: C.x + Math.sin(ang[0]) * RAD, z: C.z + Math.cos(ang[0]) * RAD, face: ang[0] }, caseAt: C, pen, fx };
  R.finish();
  R.root.traverse(o => { if (o.isMesh && o.parent === R.static) o.castShadow = false; });
  const cityBase = city.group.scale.y;
  R.tick = (t, dt) => {
    now = t; PK.tick(t); const I = R.inception, ts = I.topSpin;
    if (ts.on) { top.rotation.y += ts.speed * dt; top.rotation.x = ts.tilt * Math.sin(t * 5); top.rotation.z = ts.tilt * Math.cos(t * 5) + ts.wob; } else { top.rotation.z = ts.wob; }
    // mirrors: an endless zoom into the tunnel (faster on E)
    const ms = t - fx.mirror, fast = ms >= 0 && ms < 4 ? 1.6 : 0.12;
    I.mz = ((I.mz || 0) + dt * fast) % 1; const k = Math.pow(0.8, I.mz);
    for (const tx of mirT) { tx.repeat.set(k, k); tx.offset.set((1 - k) / 2, (1 - k) / 2); }
    // city: folds further on E
    const cs = t - fx.city, cf = cs >= 0 && cs < 3 ? Math.sin(cs / 3 * Math.PI) : 0;
    city.group.scale.y = cityBase * (1 + cf * 0.5); city.group.rotation.x = -cf * 0.25;
    // penrose walker loops for 8 s
    const ps = t - fx.penrose; walker.visible = ps >= 0 && ps < 8;
    if (walker.visible) { const u = (ps * 0.5) % 1, f = Math.floor(u * 4), a = (u * 4 % 1) * 2.4 - 1.2, L = 1.2;
      const v = vW.set(a * 1.083, 0, -1.3).applyAxisAngle(UP, -f * H); walker.position.set(4 + v.x, 0.42 + u * 24 * 0.11, -5.6 + v.z); }
    // floating set bobs; E spins it
    const tsx = t - fx.tilt, spin = tsx >= 0 && tsx < 3 ? (1 - Math.cos(tsx / 3 * Math.PI * 2)) * 0.5 : 0;
    tilt.position.y = 0.12 * Math.sin(t * 0.7); sofaT.rotation.z = 0.32 + spin * 1.2; chairT.rotation.y = 0.6 + t * 0.15; tbl.rotation.y = -t * 0.1;
    // coast: waves; E sends a big wave over the castle
    const cw = t - fx.castle, big = cw >= 0 && cw < 2.5 ? Math.sin(cw / 2.5 * Math.PI) : 0;
    water.position.z = 8.1 - big * 2.6 + Math.sin(t * 0.8) * 0.15; water.scale.y = 1 + big * 1.5; waterM.opacity = 0.4 + 0.1 * Math.sin(t * 1.3) + big * 0.2;
    deb.items.forEach(d => { dO.position.set(d.x * (1 + 0.04 * Math.sin(t * 0.3 + d.ph)), d.y + 0.08 * Math.sin(t * 0.5 + d.ph), d.z); dO.rotation.set(d.rx + t * 0.1, d.ry + t * 0.07, 0); dO.scale.setScalar(d.s); dO.updateMatrix(); d.m.setMatrixAt(d.i, dO.matrix); });
    for (const m of deb.meshes) m.instanceMatrix.needsUpdate = true;
    caseGlow.material.opacity = 0.4 + 0.2 * Math.sin(t * 2.2);
  };
  return R;
}
