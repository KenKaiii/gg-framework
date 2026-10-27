// @ts-check
// Paper Street: the basement of a crumbling house (Fight Club homage). Stained concrete, peeling wallpaper partitions,
// a bare-bulb-lit ring taped on the floor, pink soap shelves, the workbench, an old sofa and crates around the ring,
// the rules board, a punching bag, a TV with a subliminal flicker and a catalogue-perfect corner as a gag.
// Local frame x -11..11, z -7..7. n (biolab, opening x=0) and w (computer, opening z=0) are drawn by the neighbours:
// only free-standing pieces there. s (tavern, opening x=+4) and e are front walls (cut down).
import * as THREE from 'three';
import { makeRoom, lightRig, mat, put } from './kit.js';
import * as FX from './kit-fx.js';
import { SFX } from '../sfx.js';
import { poker, solidify } from './screening-poke.js';

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
import * as P from './fightclub-props.js';
import * as J from './fightclub-junk.js';
import { rickTex, tickRick } from './rick-screen.js';

export const RING = { x: -2.5, z: 1.0, s: 4.6 };
const H = Math.PI / 2;

/** @param {any} ctx */
export function build(ctx) {
  void ctx;
  const R = /** @type {any} */ (makeRoom({ id: 'fightclub', floor: P.concrete(), floorRepeat: 3.2, wall: TX.plaster('#6a5a48', 41), trim: '#3a2a20', base: '#2a1e18' }));
  const S = R.static; let soapBars = /** @type {any} */ (null); const SOAP_I = 43; // shelf 0, level 2, bar 3, top of its pair
  const st = (o, x, y, z, ry = 0, block = false) => { put(S, o, x, y, z, ry); if (block) R.blockObj(o); return o; };
  const live = (o, x, y, z, ry = 0) => { put(R.live, o, x, y, z, ry); o.traverse(c => { c.userData.live = true; }); return o; };
  // ----- partitions in front of the neighbours' walls (gaps at the openings)
  st(P.partition(9.3), -6.25, 0, -6.78); st(P.partition(9.3), 6.25, 0, -6.78);
  st(P.partition(5.3), -10.78, 0, -4.25, H); st(P.partition(5.3), -10.78, 0, 4.25, H);
  // ----- soap shelves (north-west) + instanced bars
  const shelves = [-8.4, -5.7];
  for (const x of shelves) st(P.shelf(2.4, 2.2), x, 0, -6.35, 0, true);
  { const bars = []; for (const sx of shelves) for (let lv = 0; lv < 4; lv++) for (let i = 0; i < 9; i++) for (let k = 0; k < (lv === 3 ? 1 : 2); k++) bars.push([sx - 1.0 + i * 0.25, 0.18 + lv * 0.667 + k * 0.09, -6.35 + ((i + lv) % 2) * 0.08]);
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.08, 0.3), P.SOAP, bars.length); const m = new THREE.Matrix4();
    bars.forEach((b, i) => { m.makeTranslation(b[0], b[1], b[2]); im.setMatrixAt(i, m); }); live(im, 0, 0, 0); soapBars = im; }
  { const l = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.4), new THREE.MeshBasicMaterial({ map: TX.label('PAPER ST. SOAP CO.', '#ffd6e4', '#5a2034', 512, 128, '78px m5x7'), toneMapped: false })); st(l, -7.05, 2.45, -6.7); }
  // ----- workbench (soap station) + rules board (north-east)
  st(P.workbench(), 4.3, 0, -6.2, 0, true);
  st(P.rulesBoard(), 8.4, 0, -6.1, 0, true);
  const monkey = live(P.helmet(), 5.4, 1.0, -6.0, -0.4);
  // ----- the ring
  st(P.ringTape(RING.s), RING.x, 0.012, RING.z);
  const ringBulb = live(P.bulb(0.9), RING.x, 3.2, RING.z);
  const wbBulb = live(P.bulb(0.7), 4.3, 3.2, -5.4);
  // a cooler bulb here: the hot 2.4x core bloomed into a tiny pixel-popping hotspot right in front of the bright wash
  /** @type {any} */ (wbBulb.children[2]).material = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffe2a8').multiplyScalar(1.3) });
  // ----- sofa + crates around the ring
  st(P.sofa(2.4), -9.85, 0, -4.2, H, true);
  const crates = [[-5.5, -0.4, H], [-5.5, 2.4, H], [0.5, -0.4, -H], [0.5, 2.4, -H], [-3.3, 4.2, Math.PI], [-1.7, 4.2, Math.PI], [-4.0, -2.2, 0]];
  for (const [x, z] of crates) st(P.crate(0.5), x, 0, z, 0, true);
  st(P.crate(0.6), -8.2, 0, -3.0, 0.3, true); // side table crate with a can on it
  const can = put(R.live, new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.12, 12), mat('#c8c0b0', { metalness: 0.6, roughness: 0.4 })), -8.15, 0.6, -2.95); // hops when cracked
  // ----- TV corner (south-west): TV on crates, a shrine for Bob
  st(P.crate(0.7), -9.9, 0, 4.6, 0, true);
  const T = P.tv(); st(T.g, -9.9, 0.63, 4.6, H);
  T.scr.userData.live = true; S.remove(T.g); live(T.g, -9.9, 0.63, 4.6, H);
  st(P.crate(0.5), -9.9, 0, 2.6, 0, true);
  const candle = live(FX.glow('#ffb36b', 0.5, 0.6), -9.9, 0.62, 2.6);
  { const ph = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.34), new THREE.MeshBasicMaterial({ map: TX.label('R.P.', '#2a1e18', '#d8cfb8', 128, 160, '60px m5x7') })); st(ph, -10.05, 0.65, 2.6, H); ph.userData.live = true; R.fcPhoto = ph; }
  // ----- punching bag (east)
  const bag = live(P.bag(), 8.8, 3.1, -2.6); R.block(8.4, -3.0, 9.2, -2.2);
  // ----- catalogue corner (south-east)
  st(P.catalogue(), 8.2, 0, 4.2, 0); R.block(7.0, 3.3, 9.5, 5.4);
  // ----- basement life (south-east half)
  const boil = st(J.boiler(), 10.1, 0, -0.6, -H, true), wash = st(J.washer(), 10.15, 0, 0.9, -H, true);
  solidify(wash); wash.traverse(o => { o.castShadow = false; }); // the washer shakes when kicked
  const valve = boil.children[boil.children.length - 1]; valve.userData.live = true; valve.castShadow = false; // the bleed valve turns
  st(J.drum(), 3.3, 0, 3.0, 0, true); st(J.drum(), 3.95, 0, 3.55, 0.6, true); st(J.drum(true), 5.6, 0, 1.7, 0.4, true);
  st(J.tyres(4), -6.9, 0, 5.9, 0, true);
  st(J.grime(4.2, 2.4), 5.4, 0.014, -1.4); st(J.grime(3.2, 2.0), -6.5, 0.014, 3.6, 1.2);
  { const pts = [[4.6, -1.0], [5.1, -1.6], [6.2, -0.9], [3.9, -1.9], [6.6, -2.0], [1.8, 3.2]];
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.08, 0.3), P.SOAP, pts.length); const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    pts.forEach(([x, z], i) => { q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), i * 1.3); m4.compose(new THREE.Vector3(x, 0.04, z), q, new THREE.Vector3(1, 1, 1)); im.setMatrixAt(i, m4); }); live(im, 0, 0, 0); }
  live(FX.glow('#4fa8ff', 0.35, 0.6), 9.7, 0.33, -0.6);
  // ----- floor glow pools + bulb halos (readability)
  const poolM = new THREE.MeshBasicMaterial({ color: '#ffd59a', transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, map: TX.dotTex() });
  const pool = live(new THREE.Mesh(new THREE.PlaneGeometry(7, 7), poolM), RING.x, 0.02, RING.z); pool.rotation.x = -H; pool.renderOrder = -6;
  const halo = live(FX.glow('#ffe2a8', 1.4, 0.6), RING.x, 2.15, RING.z);
  live(FX.glow('#ffb36b', 1.0, 0.5), 4.3, 2.35, -5.4);
  live(FX.glow('#fff0d0', 0.9, 0.5), 6.9, 1.6, 5.1);
  const tvGlow = live(FX.glow('#9ab8c8', 1.0, 0.4), -9.4, 1.0, 4.6);
  R.live.add(FX.motes(24, new THREE.Vector3(-6, 0.5, -2), new THREE.Vector3(1, 3, 4), '#ffe0b0', 0.035));
  // ----- lights: 4 key lamps
  R.rig = lightRig(R.root, { room: R, sky: '#8a7a9a', ground: '#4a3a30', ambient: 3.4, moon: '#8fa8ff', moonI: 0.9, moonFrom: [-9, 9, -4], points: [
    { x: RING.x, y: 2.0, z: RING.z, color: '#ffe2a8', i: 10, d: 9 },
    { x: 4.3, y: 2.3, z: -5.0, color: '#ffb36b', i: 6, d: 7 },
    { x: -8.8, y: 1.6, z: 3.6, color: '#ffcf8a', i: 5, d: 7 },
    { x: 7.2, y: 1.8, z: 4.6, color: '#fff0d0', i: 5, d: 6 }] });
  R.meta = { id: 'fightclub', name: 'Paper Street', blurb: 'You do not talk about it. Soap for sale.' };
  R.spawn = { x: 2.6, z: 0.8, face: -H };
  R.slots = [
    { id: 'sofa-a', kind: 'sofa', x: -9.75, z: -4.9, y: 0.05, face: H, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Old sofa' },
    { id: 'sofa-b', kind: 'sofa', x: -9.75, z: -4.2, y: 0.05, face: H, anim: 'Sit_Chair_Idle', prop: 'beer', label: 'Old sofa' },
    { id: 'ring-e', kind: 'stand', x: 1.7, z: 1.0, face: -H, anim: 'Idle', prop: 'beer', label: 'Ringside, east' },
    { id: 'sofa-c', kind: 'sofa', x: -9.75, z: -3.5, y: 0.05, face: H, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Old sofa' },
    ...crates.map(([x, z, f], i) => ({ id: 'crate-' + i, kind: 'crate', x, z, y: 0.0, face: f, anim: 'Sit_Chair_Idle', prop: i % 2 ? 'beer' : 'laptop', label: 'Crate by the ring' })),
    { id: 'bagwatch', kind: 'stand', x: 7.6, z: -1.6, face: 0.9, anim: 'Idle', prop: 'beer', label: 'Watching the bag' },
    { id: 'ring-n', kind: 'stand', x: -2.4, z: -1.9, face: 0, anim: 'Idle', prop: 'phone', label: 'Ringside, north' },
    { id: 'drums', kind: 'stand', x: 2.5, z: 2.4, face: -2.2, anim: 'Idle', prop: 'beer', label: 'Leaning on the oil drums' },
    { id: 'catalogue', kind: 'armchair', x: 7.5, z: 3.7, y: 0.0, face: 0.3 + Math.PI, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'The catalogue chair' }];
  R.interact = [
    { id: 'ring', x: RING.x, z: RING.z, r: 1.6, label: 'Spar in the ring', kind: 'game' },
    { id: 'soap', x: 4.3, z: -5.2, r: 1.0, label: 'Make soap', kind: 'gadget' },
    { id: 'rules', x: 8.4, z: -5.2, r: 1.0, label: 'Read the rules', kind: 'gadget' },
    { id: 'catalogue', x: 8.2, z: 2.8, r: 1.1, label: 'Take the furniture quiz', kind: 'gadget' },
    { id: 'bag', x: 8.0, z: -2.0, r: 1.0, label: 'Hit the bag', kind: 'gadget' },
    { id: 'tv', x: -8.8, z: 4.0, r: 1.0, label: 'Watch TV', kind: 'tv' },
    { id: 'paulson', x: -9.0, z: 2.6, r: 0.9, label: 'Look at the photo', kind: 'gadget' },
    { id: 'monkey', x: 5.4, z: -5.3, r: 0.8, label: 'Poke the helmet', kind: 'gadget' },
    { id: 'washer', x: 9.3, z: 0.9, r: 0.8, label: 'Kick the washer', kind: 'machine' },
    { id: 'boiler', x: 9.3, z: -0.6, r: 0.8, label: 'Bleed the boiler', kind: 'machine' },
    { id: 'cans', x: -7.6, z: -2.4, r: 0.7, label: 'Crack a can', kind: 'drink' },
    { id: 'shelves', x: -7.05, z: -5.6, r: 1.0, label: 'Sniff the soap', kind: 'shelf' }];
  for (const it of R.interact) it.sfx = false; // each reaction plays its own sounds below
  const snd = (n, x, z, o = {}) => SFX.play(n, { ...o, at: { x: x + R.root.position.x, z: z + R.root.position.z } });
  const later = (ms, f) => setTimeout(f, ms);

  R.npc = null;
  R.camera = { zoom: 7, target: new THREE.Vector3(0, 0.8, 0) };
  const pkr = poker(); let puffAt = -99, soapAt = -99; const sm4 = new THREE.Matrix4();
  let now = 0, hit = -99, flash = -99, mk = -99, pokeAt = -99;
  const poke = live(FX.glow('#ffd59a', 0.8, 0), 0, 0, 0); const flashAt = (x, y, z, c) => { poke.position.set(x, y, z); poke.material.color.set(c); pokeAt = now; };
  R.onInteract = (id, api) => {
    if (id === 'bag') { hit = now; api.bubble('Hit me as hard as you can.'); snd('punch', 8.8, -2.6); snd('creak', 8.8, -2.6, { vol: 0.4, pitch: 1.3, delay: 0.25 }); }
    else if (id === 'tv') { flash = now; api.toast('Did you see that? ...No.'); snd('crt.on', -9.9, 4.6); snd('static', -9.9, 4.6, { vol: 0.4, delay: 0.2 }); later(1200, () => snd('blip', -9.9, 4.6, { vol: 0.6 })); }
    else if (id === 'paulson') { pkr.poke(R.fcPhoto, 'tip', 1.6, 0.5); api.bubble('His name was Robert Paulson.'); flashAt(-9.9, 0.7, 2.6, '#ffb36b'); snd('chime', -9.9, 2.6, { vol: 0.35, pitch: 0.75 }); }
    else if (id === 'monkey') { mk = now; api.toast('Space monkey ready to be launched into space.'); snd('whoosh', 5.4, -6.0, { pitch: 1.3 }); later(1450, () => snd('thud', 5.4, -6.0, { vol: 0.4, pitch: 1.6 })); }
    else if (id === 'washer') { pkr.poke(wash, 'wiggle', 1.6, 0.5); flashAt(10.0, 0.6, 0.9, '#9ab8c8'); snd('thud', 10.15, 0.9, { vol: 0.6 }); snd('rattle', 10.15, 0.9, { vol: 0.5, delay: 0.1 }); snd('gurgle', 10.15, 0.9, { vol: 0.4, delay: 0.5 }); api.bubble('It spins. Somebody\'s khakis are in there.'); }
    else if (id === 'boiler') { pkr.poke(valve, 'spin', 1.2, 1); puffAt = now; flashAt(9.8, 0.5, -0.6, '#4fa8ff'); snd('fizz', 10.1, -0.6, { vol: 0.6 }); snd('hum', 10.1, -0.6, { vol: 0.3, delay: 0.3 }); api.bubble('*hssss*  The house is held together by this thing.'); }
    else if (id === 'cans') { pkr.poke(can, 'squash', 0.8, 1.5); flashAt(-8.2, 0.75, -3.0, '#ffd59a'); snd('can', -8.2, -3.0); snd('fizz', -8.2, -3.0, { vol: 0.5, delay: 0.1 }); api.bubble('Warm. Flat. Perfect.'); }
    else if (id === 'shelves') { soapAt = now; flashAt(-7.05, 1.2, -6.1, '#f2a6c0'); snd('bubble', -7.05, -6.35); snd('sparkle', -7.05, -6.35, { vol: 0.4, delay: 0.25 }); api.toast('Rose, lavender, and a hint of something you should not ask about.'); }
  };
  /** activities can trigger the room gags */
  R.fc = { hit: () => { hit = now; }, flash: () => { flash = now; } };
  const scrM = /** @type {THREE.MeshBasicMaterial} */ (T.scr.material); scrM.map = rickTex(); scrM.needsUpdate = true;
  // light realism: workbench bulb pool + wash on the partition, TV glow, candle wash, catalogue lamp pool
  softPlanes(R.live, [[4.3, 0.024, -5.2, 3.0, 2.6, 'f', '#ffb36b', 0.2], [4.3, 1.7, -6.68, 2.8, 2.4, 's', '#ffb36b', 0.16], [-8.9, 0.024, 4.6, 2.0, 1.8, 'f', '#9ab8c8', 0.18],
    [-10.66, 0.9, 2.6, 1.0, 1.0, 'e', '#ffb36b', 0.25], [-9.3, 0.024, 2.6, 1.2, 1.2, 'f', '#ffb36b', 0.15], [6.9, 0.024, 4.6, 2.4, 2.0, 'f', '#fff0d0', 0.15], [-7.05, 2.45, -6.66, 2.2, 1.0, 's', '#ffd6e4', 0.1]]);
  R.finish();
  R.root.traverse(o => { if (o.isMesh && o.parent === R.static) o.castShadow = false; });
  R.tick = (t) => {
    now = t; pkr.tick(t);
    const L = R.rig.points;
    L[0].intensity = 10 * soft(t, 3, 0.08);
    const sw = Math.sin(t * 0.7) * 0.05; ringBulb.rotation.z = sw; ringBulb.rotation.x = sw * 0.6;
    halo.material.opacity = 0.6 * soft(t, 3, 0.08); poolM.opacity = 0.32 * soft(t, 3, 0.08);
    candle.material.opacity = 0.5 * soft(t, 7, 0.5, 2);
    const hs = t - hit; bag.rotation.x = hs >= 0 && hs < 3 ? Math.sin(hs * 7) * 0.45 * Math.exp(-hs * 1.2) : Math.sin(t * 0.6) * 0.01;
    const fs = t - flash, sub = fs >= 0 && fs < 3 && Math.abs(fs - 1.2) < 0.5;
    const c = 0.55 + 0.12 * Math.sin(t * 1.4) + 0.06 * Math.sin(t * 0.8);
    tickRick(t); scrM.color.setScalar(0.95 * c); tvGlow.material.opacity = 0.35 * c * (sub ? 1.6 : 1);
    { const pk = t - pokeAt; poke.material.opacity = pk >= 0 && pk < 1.2 ? 0.6 * (1 - pk / 1.2) : 0; }
    { const u = (t - puffAt) / 1.6; if (u >= 0 && u < 1) { poke.position.set(9.85, 1.3 + u * 1.2, -0.45); poke.scale.setScalar(1 + u * 2.5); poke.material.color.set(0xd8e4f0); poke.material.opacity = 0.5 * Math.sin(u * Math.PI); } else if (u >= 1 && u < 1.2) poke.scale.setScalar(1); } // steam puff rises from the boiler
    { const u = (t - soapAt) / 1.2; if (u >= 0 && u < 1.1) { const k = u < 1 ? Math.sin(u * Math.PI) : 0; sm4.makeTranslation(-8.65, 0.18 + 2 * 0.667 + 0.09 + k * 0.06, -6.27 + k * 0.25); soapBars.setMatrixAt(SOAP_I, sm4); soapBars.instanceMatrix.needsUpdate = true; } } // a soap bar slides out to be sniffed
    const ms = t - mk; monkey.position.y = 1.0 + (ms >= 0 && ms < 1.5 ? Math.sin(ms / 1.5 * Math.PI) * 1.2 : 0); monkey.rotation.y = -0.4 + (ms >= 0 && ms < 1.5 ? ms * 8 : 0);
  };
  return R;
}
