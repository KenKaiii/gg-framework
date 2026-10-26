// @ts-check
// Lab 426: a dim sci-fi research lab (Alien + Jurassic Park homage). Grated floor, green/teal emergency light,
// specimen tubes, an egg in a cryo stand, the MOTHER terminal, an embryo cold case and a scratched-up security door.
// n wall (garage) and w wall (hawkins) are drawn by neighbours: everything along them is free-standing.
import * as THREE from 'three';
import { makeRoom, lightRig, mat, glowMat, rbox, put, mesh, rng } from './kit.js';
import * as FX from './kit-fx.js';
import { SFX } from '../sfx.js';
import { poker } from './screening-poke.js';
// claws down a steel door: two descending scrapes
SFX.define('biolab.scratch', (o, t, p, K) => { for (const k of [0, 0.22]) K.hiss(o, t + k, { ft: 'bandpass', f: 2600 * p, f1: 900 * p, q: 6, v: 0.18, a: 0.01, d: 0.2 }); });
// a soft steam vent puff
SFX.define('biolab.steam', (o, t, p, K) => K.hiss(o, t, { ft: 'highpass', f: 1800 * p, f1: 3000 * p, q: 0.7, v: 0.12, a: 0.06, d: 0.5 }));

/** Soft light (additive) or shade (dark) decals, one instanced draw per call, static: can't flicker.
 *  item = [x, y, z, w, h, face, colour, strength]; face 'f' = floor, 'n'/'s'/'e'/'w' = the way a wall plane faces. */
const SOFT_ROT = { f: [-Math.PI / 2, 0], s: [0, 0], n: [0, Math.PI], e: [0, Math.PI / 2], w: [0, -Math.PI / 2] };
function softPlanes(parent, items, shade = false) {
  const m = new THREE.MeshBasicMaterial({ map: TX.dotTex(), color: shade ? '#000000' : '#ffffff', transparent: true, opacity: shade ? 0.5 : 1, blending: shade ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), m, items.length), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color(), p = new THREE.Vector3(), s = new THREE.Vector3();
  items.forEach(([x, y, z, w, h, f, col, k], i) => { const [rx, ry] = SOFT_ROT[f]; e.set(rx, ry, 0, 'YXZ'); q.setFromEuler(e); m4.compose(p.set(x, y, z), q, s.set(w, h, 1)); im.setMatrixAt(i, m4); if (!shade) im.setColorAt(i, c.set(col).multiplyScalar(k)); });
  im.castShadow = im.receiveShadow = false; im.frustumCulled = false; im.renderOrder = shade ? -4 : -6; // light under the contact shade (-5), so pools don't wash grounding out im.userData.live = true; im.userData.noGround = true; parent.add(im); return im;
}

/** slow smooth breathing (period >= ~3 s) instead of fast flicker: no strobing */
const soft = (t, seed = 0, amp = 0.15) => 1 - amp * 0.45 * (0.5 + 0.5 * (0.6 * Math.sin(t * 1.7 + seed) + 0.4 * Math.sin(t * 0.9 + seed * 2.1)));
import * as TX from './tex.js';
import * as P from './biolab-props.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** @param {any} ctx */
export function build(ctx) {
  const R = makeRoom({ id: 'biolab', floor: P.grateTex(), floorRepeat: 1.2, wall: '#3a5050', trim: '#2a3a3a', base: '#0e1214' });
  const S = R.static, L = R.live, W2 = R.w / 2, D2 = R.d / 2, H = Math.PI;
  const lift = g => { R.root.updateMatrixWorld(true); const ls = []; g.traverse(o => { if (o !== g && o.userData.live) ls.push(o); }); for (const o of ls) L.attach(o); };
  const fluidM = new THREE.MeshStandardMaterial({ color: '#0c3a28', emissive: '#22c27a', emissiveIntensity: 0.85, transparent: true, opacity: 0.6, roughness: 0.1, depthWrite: false });
  const glassM = new THREE.MeshStandardMaterial({ color: '#9fe8d0', emissive: '#0d3a30', transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0.2, depthWrite: false, side: THREE.DoubleSide });
  const hugGeo = P.huggerGeo(), fgs = [];

  // --- hazard stripes on the floor (instanced strips): around the egg, in front of the door, along the n opening
  const strips = [[-4.5, 2.35, 1.9, 0], [-4.5, -0.35, 1.9, 0], [-5.85, 1.0, 1.9, H / 2], [-3.15, 1.0, 1.9, H / 2], [9.3, -3.7, 2.2, 0], [3.5, -4.3, 0.1, 0]].filter(s => s[2] > 0.5);
  const hm = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 0.16), P.HAZ(), strips.length); const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  strips.forEach(([x, z, w, ry], i) => { e.set(-H / 2, 0, ry); q.setFromEuler(e); m4.compose(new THREE.Vector3(x, 0.012, z), q, new THREE.Vector3(w, 1, 1)); hm.setMatrixAt(i, m4); }); hm.receiveShadow = true; S.add(hm);

  // --- specimen tubes (nw), facehuggers floating
  const tubes = [-9.7, -8.4, -7.1].map((x, i) => { const t = P.specimenTube(fluidM); t.g.remove(t.fluid); t.fluid.geometry.translate(x, 1.22, -D2 + 0.65); fgs.push(t.fluid.geometry); put(S, t.g, x, 0, -D2 + 0.65); R.block(x - 0.5, -D2, x + 0.5, -D2 + 1.15);
    const hg = mesh(hugGeo, P.fleshMat()); hg.position.set(x, 1.3, -D2 + 0.65); hg.rotation.set(-0.4 + i * 0.3, i * 2, 0.3); hg.userData.live = true; hg.castShadow = false; L.add(hg); return { t, hg, x }; });
  const fl = mesh(mergeGeometries(fgs), fluidM); fl.castShadow = false; fl.userData.live = true; L.add(fl);
  // --- MOTHER console
  const mo = P.motherConsole(); put(S, mo.g, -3.6, 0, -D2 + 0.85); R.block(-4.45, -D2, -2.75, -D2 + 1.3); lift(mo.g);
  // --- embryo cold case + raptor door (east of the n opening at x 3.5)
  const ec = P.embryoCase(); put(S, ec, 6.7, 0, -D2 + 0.4); const vials = /** @type {any} */ (ec.children[2]); vials.userData.live = true; R.blockObj(ec);
  const dr = P.raptorDoor(); put(S, dr.g, 9.3, 0, -D2 + 0.22); R.block(8.3, -D2, 10.3, -D2 + 0.45); lift(dr.g);
  // --- alien egg in its cryo stand
  const egg = P.eggStand(glassM, hugGeo); put(S, egg.g, -4.5, 0, 1.0); R.block(-5.2, 0.3, -3.8, 1.7); lift(egg.g);
  const alarmGlow = FX.glow('#ff2a1a', 2.6, 0); alarmGlow.position.set(-4.5, 2.2, 1.0); L.add(alarmGlow);

  // --- lab benches + stools + laptops (two islands)
  const benches = [{ x: 1.4, z: 1.6 }, { x: 6.6, z: 1.6 }], stools = [];
  benches.forEach((b, bi) => { const bn = P.labBench(3.0); put(S, bn, b.x, 0, b.z); bn.userData.ground = { k: 1.5 }; R.block(b.x - 1.5, b.z - 0.48, b.x + 1.5, b.z + 0.48);
    for (const dx of [-0.75, 0.75]) for (const sd of [-1, 1]) { put(S, P.labStool(), b.x + dx, 0, b.z + sd * 0.82); stools.push({ x: b.x + dx, z: b.z + sd * 0.82, face: sd < 0 ? 0 : H });
      if ((dx > 0) === (sd > 0)) put(S, P.laptop(bi ? '#8fe0ff' : '#6ee7a0'), b.x + dx, 0.955, b.z + sd * 0.25, sd < 0 ? 0 : H); } });
  // bench A: mosquito in amber on a little stand; bench B: petri dish with a red and a blue pill
  const am = rbox(0.12, 0.08, 0.09, mat('#d88a1a', { emissive: '#7a3a00', emissiveIntensity: 0.6, roughness: 0.15 }), 0.03); am.userData.live = true; put(L, am, 1.4, 1.0, 1.6, 0.4); const amM = /** @type {any} */ (am.material);
  put(S, mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.03, 10), P.DARK()), 1.4, 0.97, 1.6);
  put(S, mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.015, 16), P.STEEL()), 6.6, 0.965, 1.55);
  const pillM = []; for (const [dx, c] of [[-0.025, '#c8302a'], [0.025, '#2a5ac8']]) pillM.push(put(L, mesh(new THREE.CapsuleGeometry(0.01, 0.025, 3, 6), mat(c, { roughness: 0.3 })), 6.6 + dx, 0.985, 1.55)); for (const p of pillM) { p.rotation.z = H / 2; p.castShadow = false; } // the chosen pill pops up
  for (const [x, z] of [[0.6, 1.4], [5.8, 1.8], [7.3, 1.4]]) put(S, mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.18, 10), glowMat('#3ddc84', 0.7)), x, 1.05, z); // flasks

  // --- crates and a hazard barrel cluster (se, low), cryo canisters by the w opening
  for (const [x, z, s, r] of [[9.9, 3.9, 0.8, 0.2], [9.0, 4.2, 0.6, -0.3], [9.9, 3.9, 0.55, 0.5]]) { const c = rbox(s, s * 0.8, s, P.STEEL(), 0.03); put(S, c, x, (s === 0.55 ? 0.64 : 0) + s * 0.4, z, r); }
  R.block(8.6, 3.4, 10.4, 4.6);
  const barrels = [[-9.8, 3.6], [-9.2, 4.2]].map(([x, z], i) => { const b = new THREE.Group(); put(i ? S : L, b, x, 0, z); put(b, mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.85, 16), P.STEEL()), 0, 0.425, 0); put(b, mesh(new THREE.CylinderGeometry(0.285, 0.285, 0.12, 16), P.HAZ()), 0, 0.6, 0); return b; }); const barrel = barrels[0]; // the front barrel wobbles when shaken
  R.block(-10.2, 3.2, -8.8, 4.6);

  // --- floor cables (one material, a few tubes)
  const cm = mat('#0c0e10', { roughness: 0.6 });
  for (const pts of [[[-3.6, -3.7], [-4.8, -3.0], [-7.0, -3.2], [-8.4, -3.9]], [[-3.0, -3.8], [-1.5, -1.0], [0.2, 0.6], [1.0, 1.4]], [[-3.9, -3.7], [-4.3, -1.5], [-4.6, 0.5]], [[1.8, 2.0], [4.0, 3.2], [6.0, 2.2]]]) {
    const c = new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0.03, z))); const tm = mesh(new THREE.TubeGeometry(c, 40, 0.03, 5), cm); tm.castShadow = false; S.add(tm); }
  // --- steam vents (floor grates) + overhead pipes on cables
  const vents = [[-0.8, -2.6], [4.0, 3.8]].map(([x, z]) => { put(S, rbox(0.6, 0.03, 0.6, mat('#0a0c0d'), 0.01), x, 0.015, z); const s = FX.steam(new THREE.Vector3(x, 0.05, z), '#b8f0d8', 3, 1.6); L.add(s); return s; });
  // hanging cage lamps over the benches (teal) + a green emergency bar over the tubes
  const lamps = [...benches.map(b => ({ x: b.x, y: 2.95, z: b.z, c: '#7ff0d8' })), { x: -8.4, y: 2.75, z: -D2 + 0.65, c: '#3ddc84' }].map((p, i) => {
    put(S, mesh(new THREE.CylinderGeometry(0.008, 0.008, 3.4 - p.y, 4), cm), p.x, (3.4 + p.y) / 2, p.z);
    put(S, rbox(i < 2 ? 1.6 : 0.6, 0.08, 0.18, P.DARK(), 0.02), p.x, p.y + 0.05, p.z);
    const tb = rbox(i < 2 ? 1.4 : 0.5, 0.03, 0.1, glowMat(p.c, 1.8), 0.01); put(S, tb, p.x, p.y, p.z);
    const h = FX.glow(p.c, 0.8, 0.25); h.position.set(p.x, p.y - 0.1, p.z); L.add(h); return { h }; });
  // west-half clutter
  const cl = P.clutter(); put(S, cl, -8.6, 0, 0.6); for (const c of [cl, ...cl.children]) c.userData.ground = { k: 1.7, pad: 0.05 }; /* gurney/crates on the bright grate */ R.block(-9.7, -0.1, -7.5, 1.3); R.block(-9.2, 2.8, -7.8, 3.6); R.block(-7.4, 1.6, -6.6, 2.4); // (these were stuck inside the comment before: walkable gurney)
  for (const pts of [[[-9.6, -2.5], [-8.8, -0.6], [-8.0, 2.0], [-6.2, 3.8]], [[-5.6, 3.9], [-3.0, 3.5], [-1.5, 4.2]]]) {
    const c = new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0.03, z))); const tm = mesh(new THREE.TubeGeometry(c, 40, 0.03, 5), cm); tm.castShadow = false; S.add(tm); }
  // emergency glow strips at the wall bases + along a walkway (one instanced mesh) and additive floor pools (one instanced mesh)
  const gs = [[0, -D2 + 0.06, 21.6, 0], [-W2 + 0.06, 0, 9.6, H / 2], [-6, 4.6, 8, 0], [5, 4.6, 8, 0]];
  const sm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.04, 0.06), glowMat('#3ddc84', 1.05), gs.length);
  gs.forEach(([x, z, w, ry], i) => { e.set(0, ry, 0); q.setFromEuler(e); m4.compose(new THREE.Vector3(x, 0.03, z), q, new THREE.Vector3(w, 1, 1)); sm.setMatrixAt(i, m4); }); sm.castShadow = false; S.add(sm);
  const pools = [[-8.4, -3.0, 4.5], [-4.5, 1.0, 3.6], [1.4, 1.6, 5], [6.6, 1.6, 5], [9.3, -3.2, 3], [-3.6, -3.0, 3], [-8.0, 2.0, 4], [0, -D2 + 1.6, 3.2], [-W2 + 1.6, 0, 3.2]];
  const pm = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: TX.dotTex(), color: new THREE.Color('#2fbf8a').multiplyScalar(0.55), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), pools.length);
  pools.forEach(([x, z, s], i) => { e.set(-H / 2, 0, 0); q.setFromEuler(e); m4.compose(new THREE.Vector3(x, 0.02, z), q, new THREE.Vector3(s, s, 1)); pm.setMatrixAt(i, m4); }); pm.userData.live = true; pm.renderOrder = -6; L.add(pm);
  L.add(FX.motes(30, new THREE.Vector3(-10, 0.4, -4), new THREE.Vector3(10, 2.6, 4), '#9fe8d0', 0.04));

  R.rig = lightRig(R.root, { room: R, sky: '#5a8a88', ground: '#2a3a3a', ambient: 4.2, moon: '#8fc8c0', moonI: 0.9, points: [
    { x: -8.4, y: 2.2, z: -3.2, color: '#3ddc84', i: 14, d: 8 },
    { x: 4.0, y: 2.4, z: 1.6, color: '#7ff0d8', i: 22, d: 12 },
    { x: 8.0, y: 2.0, z: -3.0, color: '#8fe0ff', i: 12, d: 7 },
    { x: -4.5, y: 2.3, z: 1.0, color: '#ff3a24', i: 2, d: 7 }] });
  R.meta = { id: 'biolab', name: 'Lab 426', blurb: 'Quarantined research lab. Do not tap the glass.' };
  R.spawn = { x: 0, z: -1.5, face: 0.5 };
  R.slots = [
    ...stools.map((s, i) => ({ id: 'bl-stool-' + i, kind: 'stool', x: s.x, z: s.z, y: 0.23, face: s.face, anim: 'Sit_Chair_Idle', prop: i % 4 === 3 ? 'mug' : 'laptop', label: 'Lab bench' })),
    { id: 'bl-tube-a', kind: 'stand', x: -9.0, z: -2.9, face: H, anim: 'Idle', prop: 'phone', label: 'Specimen tubes' },
    { id: 'bl-tube-b', kind: 'stand', x: -7.6, z: -2.7, face: H + 0.4, anim: 'Idle', prop: 'mug', label: 'Specimen tubes' },
    { id: 'bl-egg', kind: 'stand', x: -2.9, z: 2.6, face: -2.2, anim: 'Idle', prop: 'phone', label: 'The egg' },
  ];
  R.interact = [
    { id: 'egg', x: -4.5, z: 2.2, r: 1.3, label: 'Look closer at the egg', kind: 'egg' },
    { id: 'tubes', x: -8.4, z: -3.0, r: 1.3, label: 'Tap the glass', kind: 'tank' },
    { id: 'mother', x: -3.6, z: -3.2, r: 1.1, label: 'Talk to MOTHER', kind: 'terminal' },
    { id: 'door', x: 9.3, z: -3.5, r: 1.1, label: 'Try the keypad', kind: 'door' },
    { id: 'embryos', x: 6.7, z: -3.6, r: 1.0, label: 'Check the cold storage', kind: 'case' },
    { id: 'amber', x: 1.4, z: 2.6, r: 0.9, label: 'Inspect the amber', kind: 'prop' },
    { id: 'pills', x: 6.6, z: 2.5, r: 0.8, label: 'Red pill or blue pill', kind: 'prop' },
    { id: 'vent', x: -0.8, z: -2.0, r: 0.8, label: 'Step on the vent', kind: 'prop' },
    { id: 'barrels', x: -8.6, z: 3.6, r: 0.9, label: 'Shake the barrel', kind: 'prop' },
  ];
  R.npc = null;
  for (const it of R.interact) it.sfx = false; // each reaction plays its own sounds below
  const snd = (n, x, z, o = {}) => SFX.play(n, { ...o, at: { x: x + R.root.position.x, z: z + R.root.position.z } });
  const later = (ms, f) => setTimeout(f, ms);
  const pkr = poker(); let pill = 0, pokeAt = -99; const poke = FX.glow('#ff3020', 0.7, 0); poke.userData.live = true; L.add(poke);
  const flashAt = (x, y, z, c) => { poke.position.set(x, y, z); poke.material.color.set(c); pokeAt = ev.now; };
  const ev = { now: 0, egg: -99, tap: -99, door: -99, cold: -99, amber: -99, want: '' };
  R.onInteract = (id, api) => {
    if (id === 'egg') { ev.want = 'egg'; setTimeout(() => api.bubble('GAME OVER, MAN!'), 900); snd('creak', -4.5, 1.0, { vol: 0.5, pitch: 0.7 }); snd('sting', -4.5, 1.0, { vol: 0.35, delay: 0.7 }); snd('heartbeat', -4.5, 1.0, { vol: 0.5, delay: 1.2 }); }
    else if (id === 'pills') { const red = pill++ % 2 === 0; pkr.poke(pillM[red ? 0 : 1], 'hop', 0.9, 1.2); flashAt(6.6, 1.1, 1.55, red ? '#ff4030' : '#3a7aff'); snd(red ? 'magic' : 'chime', 6.6, 1.55, { vol: 0.6 }); api.bubble(red ? 'Red: wonderland. Wrong movie, though.' : 'Blue: you wake up in your bed. Nope.'); }
    else if (id === 'vent') { pkr.poke(vents[0], 'puff', 1.6, 1); flashAt(-0.8, 0.4, -2.6, '#b8f0d8'); snd('biolab.steam', -0.8, -2.6); api.bubble('*pssshh*  Warm. Smells like bad decisions.'); }
    else if (id === 'barrels') { pkr.poke(barrel, 'wiggle', 1.4, 0.8); flashAt(-9.5, 0.9, 3.9, '#ffd040'); snd('thud', -9.5, 3.9, { vol: 0.6, pitch: 0.8 }); snd('gurgle', -9.5, 3.9, { vol: 0.5, delay: 0.2 }); api.toast('Do not shake. (You shook it.)'); }
    else if (id === 'tubes') { ev.want = 'tap'; api.bubble('*tap tap*  ...it twitched.'); snd('glass', -8.4, -3.9, { vol: 0.5, pitch: 1.4 }); later(180, () => snd('glass', -8.4, -3.9, { vol: 0.5, pitch: 1.5 })); snd('bubble', -8.4, -3.9, { vol: 0.6, delay: 0.4 }); }
    else if (id === 'door') { ev.want = 'door'; api.bubble('*skrrrtch*  Clever girl.'); snd('beep', 9.3, -4.6, { vol: 0.5 }); snd('biolab.scratch', 9.3, -4.6, { delay: 0.3 }); later(400, () => snd('ui.deny', 9.3, -4.6, { vol: 0.6 })); }
    else if (id === 'embryos') { ev.want = 'cold'; snd('fridge', 6.7, -4.4); snd('rattle', 6.7, -4.4, { vol: 0.4, pitch: 1.6, delay: 0.25 }); api.bubble('15 embryos. One can of shaving cream. Hmm.'); }
    else if (id === 'amber') { ev.want = 'amber'; snd('magic', 1.4, 1.6); snd('sparkle', 1.4, 1.6, { vol: 0.6, delay: 0.8 }); api.bubble('Mosquito in amber. Life finds a way.'); }
    else if (id === 'mother') { api.toast('MOTHER is listening.'); snd('crt.on', -3.6, -4.0); }
  };
  R.camera = { zoom: 7, target: new THREE.Vector3(0, 0.8, 0.5) };

  const red = new THREE.Color('#ff2a1a'), green = new THREE.Color('#3ddc84'), up = new THREE.Vector3(), hq = new THREE.Quaternion(), r = rng(9);
  const bub = new THREE.InstancedMesh(new THREE.SphereGeometry(0.025, 6, 4), glowMat('#b8ffe0', 1.2), 36); bub.userData.live = true; bub.castShadow = false; L.add(bub);
  const bph = Array.from({ length: 36 }, () => [r(), r() * 0.5 - 0.25, r() * 0.5 - 0.25, 0.5 + r()]);
  const eggHome = egg.hugger.position.clone(); const one = new THREE.Vector3(1, 1, 1);
  R.tick = (t, dt) => {
    ev.now = t; pkr.tick(t); { const pk = t - pokeAt; poke.material.opacity = pk >= 0 && pk < 1.2 ? 0.6 * (1 - pk / 1.2) : 0; }
    if (ev.want) { ev[ev.want === 'tap' ? 'tap' : ev.want] = t; ev.want = ''; }
    tubes.forEach((tb, i) => { const k = t - ev.tap < 1.2 ? Math.sin((t - ev.tap) * 30) * 0.08 * (1.2 - (t - ev.tap)) : 0;
      tb.hg.position.y = 1.3 + Math.sin(t * 0.6 + i * 2) * 0.12; tb.hg.rotation.y = i * 2 + t * 0.15 + k * 3; tb.hg.position.x = tb.x + k; });
    bph.forEach(([ph, ox, oz, sp], i) => { const tb = tubes[i % 3]; const y = 0.4 + ((t * 0.35 * sp + ph) % 1) * 1.75; m4.compose(up.set(tb.x + ox + Math.sin(t * 3 + i) * 0.02, y, -D2 + 0.65 + oz), hq.identity(), one); bub.setMatrixAt(i, m4); });
    bub.instanceMatrix.needsUpdate = true;
    // egg: petals open, hugger lunges at the glass, red alarm pulses
    const a = t - ev.egg, open = a < 6 ? Math.min(1, a / 0.6) * (a > 4.5 ? Math.max(0, (6 - a) / 1.5) : 1) : 0;
    egg.petals.forEach((p, i) => p.pivot.quaternion.setFromAxisAngle(p.axis, open * (1.1 + i * 0.08) + Math.sin(t * 0.9 + i) * 0.02));
    egg.hugger.visible = a > 0.5 && a < 4.8;
    if (egg.hugger.visible) { const l = Math.min(1, Math.max(0, (a - 0.7) / 0.18)), back = Math.max(0, (a - 2.4) / 2);
      egg.hugger.position.set(-4.5 + l * 0.33 * (1 - back), 1.0 + eggHome.y + l * 0.35 - back * 0.6, 1.0 + l * 0.33 * (1 - back)); egg.hugger.rotation.set(-H / 2 + l * 1.2, 0.8, 0); }
    const al = a < 5 ? 0.5 - 0.5 * Math.cos(a * 2.6) : 0;
    egg.lamp.material.emissiveIntensity = 0.2 + al * 4; alarmGlow.material.opacity = al * 0.6; egg.hugger.castShadow = false; R.rig.points[3].intensity = 2 + al * 30;
    // keypad light: green, flicks red after the door scratch
    const d = t - ev.door; dr.light.material.color.copy(d < 2.5 && d > 0.3 ? red : green).multiplyScalar(2);
    mo.screen.material.color.setScalar(soft(t, 3, 0.12));
    lamps.forEach((l, i) => { const f = soft(t, i * 5, i === 2 ? 0.5 : 0.12, 0.6); l.h.material.opacity = 0.3 * f; });
    // cold case: vials ripple bright left to right, the vials rattle; amber rises, turns, glows
    { const k = t - ev.cold, on = k < 2.4; vials.material.color.set('#8fe0ff').multiplyScalar(1.3 * (on ? 1 + 1.6 * Math.sin(Math.PI * k / 2.4) : 1));
      vials.position.y = on ? Math.abs(Math.sin(k * 30)) * 0.006 * (1 - k / 2.4) : 0; }
    { const k = t - ev.amber, u = k < 4 ? Math.sin(Math.min(1, k / 4) * Math.PI) : 0, e = Math.min(1, u * 2.5); am.position.y = 1.0 + e * 0.14; am.rotation.y = 0.4 + (k < 4 ? k * 1.6 : 0); amM.emissiveIntensity = 0.6 + e * 1.8; }
    for (const v of vents) v.userData.tick(t);
  };
  // light realism: green spill in front of the specimen tubes, MOTHER's screen glow on the floor (n wall belongs to the neighbours)
  softPlanes(L, [[-8.4, 0.024, -D2 + 1.5, 4.2, 1.6, 'f', '#3ddc84', 0.16], [-3.6, 0.024, -D2 + 1.8, 2.0, 1.3, 'f', '#6ee7a0', 0.14]]);
  R.finish();
  // glowing/emissive-only pieces never need to cast moon shadows (saves shadow draw calls)
  R.root.traverse(o => { if (o.isMesh && o.parent === R.static && (o.material.isMeshBasicMaterial || o.material.transparent)) o.castShadow = false; });
  return R;
}
