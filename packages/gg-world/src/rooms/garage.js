// @ts-check
// Doc's Garage: a cluttered inventor's garage at night. Stainless gull-wing time car (88 MPH: fire trails, vanish,
// smoke), a wall of clocks all ticking out of step, a giant amp (crank it: shockwave blows you back), a proton pack,
// ghost trap + containment unit (a ghost escapes, laughs, gets sucked back), workbenches, oil stains, a sleeping dog.
// n (diner) and w (library) walls belong to the neighbours: only free-standing pieces there. We draw s and e.
import * as THREE from 'three';
import { makeRoom, lightRig, glowMat, mat, rbox, put, mesh, bake } from './kit.js';
import * as TX from './tex.js';
import * as FX from './kit-fx.js';
import * as P from './garage-props.js';
import * as G from './garage-gear.js';
import { makeFX } from './garage-fx.js';
import { SFX } from '../sfx.js';
import { poker, solidify } from './screening-poke.js';

// one huge (but soft-capped) power chord: stacked detuned saws, low-passed by the bus
SFX.define('gr.kraang', (o, t, p, K) => { for (const [f, v] of [[82, 0.22], [123, 0.16], [165, 0.12], [83.5, 0.14]]) K.tone(o, t, { type: 'sawtooth', f: f * p, f1: f * p * 0.97, v, a: 0.005, d: 0.55 }); K.hiss(o, t, { f: 900, q: 0.6, v: 0.1, d: 0.25 }); });
// flux capacitor charging: a rising buzz
SFX.define('gr.flux', (o, t, p, K) => { K.tone(o, t, { type: 'square', f: 90 * p, f1: 360 * p, v: 0.05, a: 0.2, d: 0.7 }); K.tone(o, t, { type: 'sine', f: 180 * p, f1: 720 * p, v: 0.08, a: 0.2, d: 0.7 }); });
import { softQuads } from './screening-props.js';

/** @param {any} ctx */
export function build(ctx) {
  const R = makeRoom({ id: 'garage', floor: TX.plaster('#5e5c64', 38), floorRepeat: 3, wall: TX.brick('#4a3434', '#241a1e', 38), trim: '#2a2228', base: '#141016' });
  const S = R.static, L = R.live, H = Math.PI;
  // --- the time car (live so it can vanish; baked inside)
  const CAR = { x: 3.9, z: 0.7 }, car = P.timeCar(); car.g.position.set(CAR.x, 0, CAR.z); car.g.rotation.y = H; car.g.userData.live = true;
  bake(car.flux); bake(car.g);
  L.add(car.g); R.block(CAR.x - 2.2, CAR.z - 0.9, CAR.x + 2.5, CAR.z + 0.9);
  // --- wall of clocks (free-standing, along the north wall, west of the diner opening)
  const clocks = P.clockWall(); put(S, clocks.g, -5.2, 0, -3.72); R.block(-7.0, -4, -3.4, -3.45);
  // --- north workbench + pegboard + stools, proton pack, containment unit, trap
  const wb = G.workbench(2.8, 3); put(S, wb, 3.2, 0, -3.45); R.blockObj(wb);
  put(S, G.pegboard(2.8), 3.2, 0, -3.88);
  const BX = [2.4, 3.2, 4.0]; BX.forEach((x, i) => put(S, G.stool(0.66, ['#5a2a3a', '#2a4a6a', '#3a2a54'][i]), x, 0, -2.75));
  const crt = new THREE.Group(); put(crt, rbox(0.42, 0.36, 0.4, mat('#cfc6b0', { roughness: 0.6 }), 0.04), 0, 0.18, 0);
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.25), glowMat('#ffffff', 1.4, { map: TX.termScreen(4, '#3ddc84') })); scr.position.set(0, 0.2, 0.212); scr.userData.live = true; crt.add(scr);
  put(S, crt, 4.15, 0.965, -3.55, -0.2); crt.userData.live = true; crt.traverse(o => { o.castShadow = false; }); // jolts when typed on
  const pack = G.protonPack(); put(S, pack, 5.4, 0, -3.7);
  const cyc = new THREE.Group(); put(pack, cyc, 0, 0.7, 0.1); for (const c of pack.children.slice(4, 9)) cyc.attach(c); solidify(cyc); cyc.traverse(o => { o.castShadow = false; }); // cyclotron + its 4 lights spin up R.block(5.0, -4, 5.8, -3.35);
  const cu = G.containment(); put(S, cu.g, 6.75, 0, -3.62); R.block(6.2, -4, 7.5, -3.3); 
  const TRAP = { x: 6.1, z: -2.2 }, trap = G.ghostTrap(); trap.g.position.set(TRAP.x, 0, TRAP.z); trap.g.rotation.y = -0.3; trap.g.userData.live = true; bake(trap.g); L.add(trap.g); R.block(TRAP.x - 0.3, TRAP.z - 0.2, TRAP.x + 0.3, TRAP.z + 0.2);
  // --- west: giant amp + guitar, tyre stack seat, island bench with stools
  const AMP = { x: -6.85, z: 2.75 }, amp = P.ampStack(); put(S, amp, AMP.x, 0, AMP.z, H / 2); R.block(-7.5, 1.4, -6.45, 3.5);
  const tyre = new THREE.TorusGeometry(0.3, 0.13, 8, 18), tm = mat('#18181c', { roughness: 0.9 });
  for (let i = 0; i < 3; i++) { const t = mesh(tyre, tm); t.rotation.x = H / 2; put(S, t, -6.75 + (i % 2) * 0.04, 0.13 + i * 0.25, -2.5); } R.block(-7.15, -2.9, -6.35, -2.1);
  const crate = rbox(0.6, 0.45, 0.5, mat('#6a4a2a', { roughness: 0.9 }), 0.03); put(S, crate, -4.6, 0.225, -2.75); R.blockObj(crate, 0.1);
  const isl = G.workbench(2.6, 8); put(S, isl, -3.6, 0, 2.55, H); R.blockObj(isl);
  [-4.2, -3.0].forEach((x, i) => put(S, G.stool(0.66, i ? '#2a4a3a' : '#7a3a2a'), x, 0, 1.75));
  // --- dog bed (Einstein, asleep) + oil drum + rolling jack
  const dog = G.dogBed(); put(S, dog.g, 6.4, 0, 3.1); dog.dog.removeFromParent(); dog.dog.position.set(6.4, 0.1, 3.1); bake(dog.dog); L.add(dog.dog); R.block(5.8, 2.6, 7.0, 3.6);
  const drum = mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 16), mat('#2a4a6a', { metalness: 0.5, roughness: 0.6 })); put(S, drum, 7.0, 0.45, 1.9); R.block(6.7, 1.6, 7.3, 2.2);
  for (const y of [0.15, 0.75]) put(S, mesh(new THREE.TorusGeometry(0.3, 0.015, 5, 20), mat('#1a2a3a')), 7.0, y, 1.9).rotation.x = H / 2;
  // oil stains (instanced decals)
  const stains = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: TX.dotTex(), color: '#000000', transparent: true, opacity: 0.55, depthWrite: false }), 6);
  [[3.6, 0.5, 1.8], [4.6, 1.0, 1.1], [-1.0, -1.2, 1.3], [-3.4, 1.2, 0.9], [1.2, 2.2, 0.7], [5.6, -1.4, 1.0]].forEach(([x, z, s], i) => { const m4 = new THREE.Matrix4().compose(new THREE.Vector3(x, 0.012, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(-H / 2, 0, i)), new THREE.Vector3(s, s * 0.7, 1)); stains.setMatrixAt(i, m4); });
  stains.userData.live = true; L.add(stains);
  // decor on the walls we draw (s, e)
  R.onWall('s', new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.95), mat('#ffffff', { map: TX.poster('retro', 'OUTATIME') })), -4.5, 1.7);
  R.onWall('s', new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.85), mat('#ffffff', { map: TX.poster('movie', 'WHO YA GONNA CALL') })), 4.5, 1.6);
  const neon = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.3), new THREE.MeshBasicMaterial({ map: TX.neon('1.21 GIGAWATTS', '#6ee7a0'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  neon.userData.live = true; R.onWall('e', neon, -2.0, 2.2, 0.04);
  // --- hanging bulbs
  const bulbs = [[-3.6, 2.75, 2.5], [CAR.x - 1.2, 2.85, CAR.z + 1.6], [3.2, 2.6, -2.9]].map(([x, y, z]) => {
    const cord = mesh(new THREE.CylinderGeometry(0.008, 0.008, 3.2 - y, 4), mat('#111')); cord.position.set(x, (3.2 + y) / 2, z); S.add(cord);
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), glowMat('#ffcf8a', 1.05)); b.position.set(x, y, z); b.userData.live = true; L.add(b);
    const h = FX.glow('#ffb36b', 0.6, 0.3); h.position.set(x, y, z); L.add(h); return h; });
  const fluxGlow = FX.glow('#ffe9a8', 0.5, 0.5); fluxGlow.position.set(CAR.x + 1.0, 1.0, CAR.z + 0.2); L.add(fluxGlow);
  L.add(FX.motes(30, new THREE.Vector3(-6, 0.5, -3.5), new THREE.Vector3(6, 2.6, 3.5), '#e0d0b0', 0.04));
  L.traverse(o => { if (o.isMesh && o !== car.g.children.find(c => c.castShadow && c.material === P.steel())) o.castShadow = false; });
  // warm workshop glow pools + a blue rim under the car (one instanced additive disc mesh, coloured per instance)
  const POOLS = [[-3.6, 2.5, 3.6, '#ffb36b', 0.55], [CAR.x - 1.2, CAR.z + 1.6, 3.4, '#ffcf8a', 0.4], [3.2, -2.9, 3.2, '#ffb36b', 0.5], [-5.2, -2.6, 3.0, '#ff9a5a', 0.35],
    [-1.0, -0.6, 3.6, '#e0a070', 0.3], [0.6, 2.6, 3.0, '#e0a070', 0.28], [6.2, -2.2, 2.4, '#ff6a5a', 0.3], [6.2, 2.9, 2.2, '#ffb36b', 0.3], [CAR.x, CAR.z, 6.0, '#3a9cff', 0.9]];
  const pm = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: TX.dotTex(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), POOLS.length);
  POOLS.forEach(([x, z, sz, c, a], i) => { pm.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(+x, 0.018, +z), new THREE.Quaternion().setFromEuler(new THREE.Euler(-H / 2, 0, 0)), new THREE.Vector3(+sz * (i === 8 ? 1.15 : 1), +sz * (i === 8 ? 0.62 : 1), 1))); pm.setColorAt(i, new THREE.Color(String(c)).multiplyScalar(+a)); });
  pm.userData.live = true; pm.renderOrder = -1; L.add(pm);
  // static soft light: CRT spill on the bench, containment-unit glow, neon wash on the e wall; soft shade behind the posters
  softQuads(R, [{ x: 4.0, y: 0.97, z: -3.35, w: 1.2, h: 0.8, c: '#3ddc84', a: 0.16 }, { x: 4.0, z: -2.7, w: 1.6, h: 1.4, c: '#3ddc84', a: 0.07 }, { x: 6.75, z: -3.0, w: 1.8, h: 1.4, c: '#ff5a4a', a: 0.12 }]);
  softQuads(R, [{ u: -2.0, y: 2.2, w: 2.4, h: 1.3, c: '#6ee7a0', a: 0.18 }], 'add', 'e');
  softQuads(R, [{ u: -4.5, y: 1.65, w: 0.95, h: 1.2, a: 0.4, out: 0.01 }, { u: 4.5, y: 1.55, w: 0.85, h: 1.1, a: 0.4, out: 0.01 }], 'shade', 's');
  const fx = makeFX(L, { car, carPos: CAR, trap, trapPos: TRAP, ampPos: AMP });
  R.gx = fx.st;
  R.gx.clockAt = -99; R.gx.dogAt = -99; R.gx.now = 0;

  R.rig = lightRig(R.root, { room: R, sky: '#7a74a8', ground: '#4a3a3e', ambient: 3.6, moonI: 0.6, points: [
    { x: -3.6, y: 2.4, z: 2.5, color: '#ffb36b', i: 10, d: 8 },
    { x: CAR.x - 1.2, y: 2.7, z: CAR.z + 1.6, color: '#ffcf8a', i: 10, d: 8 },
    { x: 3.2, y: 2.2, z: -2.8, color: '#ffb36b', i: 9, d: 6 },
    { x: CAR.x, y: 0.12, z: CAR.z, color: '#4fa8ff', i: 7, d: 4 }] });
  R.meta = { id: 'garage', name: "Doc's Garage", blurb: 'Clocks, a stainless time car, and an amp that goes to eleven.' };
  R.spawn = { x: 0, z: 0, face: 0.8 };
  R.slots = [
    ...BX.map((x, i) => ({ id: 'gr-bench-' + i, kind: 'stool', x, z: -2.75, y: 0.2, face: H, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Workbench stool' })),
    ...[-4.2, -3.0].map((x, i) => ({ id: 'gr-island-' + i, kind: 'stool', x, z: 1.75, y: 0.2, face: 0, anim: 'Sit_Chair_Idle', prop: i ? 'mug' : 'laptop', label: 'Parts bench' })),
    { id: 'gr-crate', kind: 'chair', x: -4.6, z: -2.75, y: 0.0, face: 0.3, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Crate by the clocks' },
    { id: 'gr-tyres', kind: 'floor', x: -6.75, z: -2.5, y: 0.62, face: H / 2, anim: 'Sit_Floor_Idle', prop: 'laptop', label: 'Tyre stack' },
    { id: 'gr-amp', kind: 'stand', x: -5.8, z: 2.75, face: -H / 2, anim: 'Idle', prop: 'beer', label: 'By the amp' },
    { id: 'gr-car-a', kind: 'stand', x: 3.0, z: 2.3, face: H, anim: 'Idle', prop: 'phone', label: 'Leaning on the car' },
    { id: 'gr-car-b', kind: 'stand', x: 5.6, z: 2.2, face: -2.7, anim: 'Idle', prop: 'beer', label: 'Leaning on the car' },
  ];
  R.interact = [
    { id: 'car', x: CAR.x - 0.6, z: CAR.z + 1.5, r: 1.5, label: 'Hit 88 MPH', kind: 'car' },
    { id: 'clocks', x: -5.2, z: -3.0, r: 1.3, label: 'Check the time', kind: 'clock' },
    { id: 'amp', x: -5.9, z: 2.75, r: 1.1, label: 'Crank it to 11', kind: 'amp' },
    { id: 'trap', x: TRAP.x, z: TRAP.z + 0.5, r: 1.0, label: 'Open the ghost trap', kind: 'trap' },
    { id: 'dog', x: 6.0, z: 2.4, r: 0.9, label: 'Pet the dog', kind: 'dog' },
    { id: 'pack', x: 5.3, z: -3.05, r: 0.5, label: 'Power up the proton pack', kind: 'pack', sfx: false },
    { id: 'terminal', x: 4.6, z: -2.3, r: 0.45, label: 'Tap the old terminal', kind: 'terminal', sfx: false },
  ];
  const pkr = poker();
  R.onInteract = (id, api) => {
    const at = (x, z) => ({ x: x + R.root.position.x, z: z + R.root.position.z });
    if (id === 'car') { fx.st.carWant = true; api.toast('88 MPH!'); SFX.play('engine', { at: at(CAR.x, CAR.z) }); SFX.play('thunder', { delay: 0.6, vol: 0.6 }); }
    else if (id === 'amp') { fx.st.ampWant = true; api.toast('Rock and roll!'); SFX.play('gr.kraang', { at: at(AMP.x, AMP.z) }); }
    else if (id === 'trap') { fx.st.ghostWant = true; api.toast("Don't cross the streams."); SFX.play('snap', { at: at(TRAP.x, TRAP.z) }); SFX.play('eerie', { at: at(TRAP.x, TRAP.z), delay: 0.3 }); }
    else if (id === 'pack') { pkr.poke(cyc, 'wheel', 2.4, 3); const a = at(5.4, -3.7); SFX.play('gr.flux', { at: a }); SFX.play('hum', { at: a, vol: 0.4, delay: 0.7 }); api.bubble("Whoa. Don't cross the streams."); }
    else if (id === 'terminal') { pkr.poke(crt, 'hop', 0.7, 0.5); const a = at(4.15, -3.55); for (let i = 0; i < 5; i++) SFX.play('key', { at: a, vol: 0.5, delay: i * 0.09, jitter: 0.1 }); SFX.play('beep', { at: a, vol: 0.4, delay: 0.55 }); api.toast('> DESTINATION TIME: OCT 21 2015 _'); }
  };
  R.npc = null;
  R.camera = { zoom: 6.5, target: new THREE.Vector3(0, 0.8, 0) };
  // Einstein's reaction: a heart sprite over his head (one draw call, hidden until petted)
  const hc = document.createElement('canvas'); hc.width = hc.height = 16; const hx = /** @type {CanvasRenderingContext2D} */ (hc.getContext('2d'));
  hx.fillStyle = '#ff4f7a'; ['0110110', '1111111', '1111111', '0111110', '0011100', '0001000'].forEach((row, y) => [...row].forEach((v, x) => { if (v === '1') hx.fillRect(1 + x * 2, 2 + y * 2, 2, 2); }));
  const ht = new THREE.CanvasTexture(hc); ht.magFilter = THREE.NearestFilter; ht.colorSpace = THREE.SRGBColorSpace;
  const heart = new THREE.Sprite(new THREE.SpriteMaterial({ map: ht, transparent: true, depthWrite: false, toneMapped: false })); heart.scale.setScalar(0.3); heart.visible = false; heart.userData.live = true; L.add(heart);
  const DH = { x: 6.4, z: 3.1 }, DC = { x: 6.4, z: 2.6 }, ease = k => k * k * (3 - 2 * k);
  /** Dog routine (s since petted): wake 0-0.5, trot a loop 0.5-3.1, sit + wag + heart 3.1-5.6, settle back. */
  const dogTick = (t, s) => {
    const d = dog.dog; d.position.set(DH.x, 0.1, DH.z); d.rotation.set(0, 0, 0); heart.visible = false;
    if (s < 0 || s > 6.2) { d.scale.set(1, 1 + 0.04 * Math.sin(t * 1.6), 1); return; }
    if (s < 0.5) { const k = ease(s / 0.5); d.scale.set(1, 1 + 0.35 * k, 1); d.position.y = 0.1 + 0.08 * k; return; }
    if (s < 3.1) { const k = (s - 0.5) / 2.6, th = ease(k) * Math.PI * 2, r = 0.5;
      d.position.set(DC.x + Math.sin(th) * r, 0.18 + Math.abs(Math.sin(s * 14)) * 0.06, DC.z + Math.cos(th) * r);
      d.rotation.y = Math.atan2(-(-Math.sin(th)), Math.cos(th)); d.rotation.z = Math.sin(s * 14) * 0.08; d.scale.set(1, 1.35, 1); return; }
    const k = Math.min(1, (s - 3.1) / 0.3), out = s > 5.6 ? ease((s - 5.6) / 0.6) : 0;
    d.position.y = 0.18 - 0.08 * out; d.scale.set(1, 1.35 - 0.35 * out, 1); d.rotation.z = (0.35 * k) * (1 - out); d.rotation.y = Math.PI / 2 + Math.sin(s * 22) * 0.18 * (1 - out);
    if (s < 5.8) { heart.visible = true; const h = s - 3.1; heart.position.set(DH.x, 0.95 + h * 0.18, DH.z); heart.scale.setScalar(0.26 + 0.05 * Math.abs(Math.sin(h * 8))); heart.material.opacity = Math.min(1, (5.8 - s) * 3); }
  };
  R.tick = (t) => {
    pkr.tick(t); const g = R.gx; g.now = t; const cs = t - g.clockAt;
    const set = cs < 0 || cs > 7.5 ? 0 : cs < 0.4 ? 0 : cs < 1.8 ? ease((cs - 0.4) / 1.4) : cs < 6.5 ? 1 : 1 - ease((cs - 6.5) / 1);
    const spin = cs >= 0 && cs < 1.8 ? cs * cs * 6 : 0;
    clocks.update(t, set, spin); fx.update(t); dogTick(t, t - g.dogAt);
    // slow smooth pulses only (no on/off blinking, no per-frame noise)
    cu.lights.forEach((m, i) => m.color.copy(m.userData.base || (m.userData.base = m.color.clone())).multiplyScalar(0.6 + 0.4 * Math.sin(t * (i ? 1.1 : 1.6) + i * 1.7)));
    bulbs.forEach((h, i) => { h.material.opacity = 0.28 + 0.02 * Math.sin(t * 1.3 + i * 2); });
    neon.material.opacity = 0.88 + 0.12 * Math.sin(t * 1.1);
  };
  R.finish();
  return R;
}
