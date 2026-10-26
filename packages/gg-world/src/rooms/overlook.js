// @ts-check
// The Overlook Hall: a long hotel corridor homage to The Shining. Hex carpet, cream walls with wainscot, dim flickering
// sconces, numbered doors on free-standing partitions (the n wall belongs to the neighbours), Room 237, the twins at the
// far (west) end, Jack's typewriter, a split "Johnny" door, the hedge-maze model and a Big Wheel that rolls by now and then.
import * as THREE from 'three';
import { makeRoom, lightRig, mat, put, rbox } from './kit.js';
import * as FX from './kit-fx.js';
import { SFX } from '../sfx.js';
import { poker } from './screening-poke.js';

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
import * as P from './overlook-props.js';
import { Avatar } from '../avatar.js';

const TWIN = { body: 'rogue', head: 'rogue', skin: '#e8cfc0', hair: '#5a3a22', top: '#9bbbd8', bottom: '#9bbbd8', acc: 'none', accColor: '#9bbbd8' };

/** @param {any} ctx */
export function build(ctx) {
  const R = /** @type {any} */ (makeRoom({ id: 'overlook', floor: P.hexCarpet(), floorRepeat: 2.4, wall: TX.plaster('#a08c6c', 23), trim: '#2e1c16', base: '#1a100c' }));
  // local frame: x -11..11, z -5..5. n wall = neighbours' (skipped; opening to kitchen at x=3). w = exterior back wall (u = -z). e = shared with hawkins (opening at z=0).
  const S = R.static, H = Math.PI / 2;
  const st = (o, x, y, z, ry = 0, block = false) => { put(S, o, x, y, z, ry); if (block) R.blockObj(o); return o; };
  const live = (o, x, y, z, ry = 0) => { put(R.live, o, x, y, z, ry); o.traverse(c => { c.userData.live = true; }); return o; };
  // ----- west wall: wainscot, Room 217 door, sconces
  const wl = R.walls.w.len;
  R.onWall('w', P.partition(wl, 0.02).children[1].clone(), 0, 0.5, 0.03);
  { const rail = rbox(wl, 0.06, 0.06, P.TRIM, 0.01); R.onWall('w', rail, 0, 1.0, 0.04); }
  R.onWall('w', P.door('217'), 2.6, 0, 0.02);
  for (const u of [-3.4, 0.9, 4.2]) R.onWall('w', P.sconce(), u, 1.9, 0.02);
  // ----- corridor partitions along the north (free-standing in front of the neighbours' wall), gap for the kitchen opening (x 1.8..4.2)
  const PZ = -4.78;
  st(P.partition(12.6), -4.6, 0, PZ); st(P.partition(6.6), 7.6, 0, PZ);
  const doors = { 233: -8.6, 237: -4.6, 239: -0.4, 241: 7.0 };
  st(P.door('233'), doors[233], 0, PZ + 0.09); st(P.door('239'), doors[239], 0, PZ + 0.09);
  const d237 = st(P.door('237', { noKnob: true }), doors[237], 0, PZ + 0.09);
  st(P.door('241', { split: true }), doors[241], 0, PZ + 0.09);
  const scX = [-10.2, -6.6, -2.5, 1.2, 5.0, 9.4];
  for (const x of scX) st(P.sconce(), x, 1.9, PZ + 0.08);
  void d237;
  // hallway runner trim + a framed old photo (July 4th ball homage) on the partition
  { const ph = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.6), new THREE.MeshBasicMaterial({ map: TX.canvasTex('overlook-photo', 128, 86, (x, w, h) => {
      x.fillStyle = '#2a241c'; x.fillRect(0, 0, w, h); x.fillStyle = '#6e6450'; x.fillRect(6, 6, w - 12, h - 18);
      for (let i = 0; i < 26; i++) { x.fillStyle = i % 3 ? '#3a3226' : '#a89c80'; x.beginPath(); x.arc(12 + (i % 13) * 8.5, 30 + Math.floor(i / 13) * 22 + (i % 2) * 3, 4, 0, 7); x.fill(); }
      x.fillStyle = '#c8bc9c'; x.font = '14px m5x7'; x.fillText('Overlook Hotel  July 4th Ball  1921', 8, h - 4); }) }));
    const fr = new THREE.Group(); put(fr, rbox(1.0, 0.7, 0.04, mat('#3a2a14', { metalness: 0.4, roughness: 0.5 }), 0.01), 0, 0, 0); put(fr, ph, 0, 0, 0.025); st(fr, 4.9, 1.85, PZ + 0.1); fr.userData.live = true; fr.traverse(o => { o.castShadow = false; }); R.ovPhoto = fr; }
  // ----- Room 237: cold blue light under the door + handle that rattles
  const leakM = new THREE.MeshBasicMaterial({ color: '#5f8cff', transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, map: TX.dotTex() });
  const leak = live(new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.9), leakM), doors[237], 0.012, PZ + 0.45); leak.rotation.x = -H;
  const knob = live(new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), P.BRASS), doors[237] + 0.38, 1.0, PZ + 0.16);
  const g237 = live(FX.glow('#6f9bff', 0.9, 0.35), doors[237], 0.08, PZ + 0.2);
  // ----- Jack's typewriter desk (west half, mid-corridor)
  const twd = st(P.typewriterDesk(), -6.2, 0, 1.2, H, true); twd.userData.ground = { k: 1.6, pad: 0.05 };
  const twSheet = twd.children[6].children[5]; twSheet.userData.live = true; twSheet.castShadow = false; // the page flutters
  const chair = P.armchair('#3a2a22'); chair.scale.setScalar(0.85); st(chair, -5.3, 0, 1.2, -H, true);
  for (let i = 0; i < 9; i++) { const pg = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.29), mat('#d8cfb8', { roughness: 0.9 })); pg.rotation.set(-H, 0, i * 1.7); st(pg, -6.9 + Math.sin(i * 2.3) * 0.9, 0.006 + i * 0.001, 2.2 + Math.cos(i * 1.3) * 0.6); }
  // ----- hedge-maze model
  st(P.mazeTable(), -1.8, 0, 2.3, 0, true).userData.ground = { k: 1.7, pad: 0.08 };
  const kid = live(new THREE.Mesh(new THREE.CapsuleGeometry(0.014, 0.03, 2, 6), mat('#d8c8a8')), -2.57, 0.94, 2.74); kid.visible = false; kid.castShadow = false; // tiny runner on E
  // ----- lounge (east, front): armchairs, coffee table, laptops, lamp
  st(P.coffeeTable(), 7.0, 0, 3.0, 0, true).userData.ground = { k: 1.6 };
  st(P.armchair('#5a1e1a'), 5.6, 0, 3.0, H, true); st(P.armchair('#5a1e1a'), 8.4, 0, 3.0, -H, true);
  st(P.armchair('#141216', true), 7.0, 0, 1.75, 0, true);
  st(P.floorLamp(), 9.9, 0, 1.6, 0, true); st(P.floorLamp(), -10.3, 0, 4.2, 0, true);
  // bench between 237 and 239
  { const b = new THREE.Group(); const v = mat('#5a1a1e', { roughness: 0.9 }); put(b, rbox(1.5, 0.12, 0.5, v, 0.05), 0, 0.42, 0); put(b, rbox(1.5, 0.5, 0.1, v, 0.05), 0, 0.72, -0.22);
    for (const x of [-0.65, 0.65]) put(b, rbox(0.08, 0.36, 0.42, P.TRIM, 0.02), x, 0.18, 0); st(b, -2.5, 0, -4.35, 0, true); }
  // ----- the twins at the far (west) end, very still
  const twins = [-0.33, 0.33].map((z, i) => { const av = new Avatar(ctx.A, TWIN); av.root.position.set(-10.15, 0, z + 0.2); av.root.rotation.y = H; av.play('Idle'); av.root.userData.live = true; R.live.add(av.root); av.update(0.5 + i * 0.0); return av; });
  R.block(-10.6, -0.4, -9.7, 0.85);
  // ----- Big Wheel (rolls across every ~25 s)
  const trike = live(P.bigWheel(), -12, 0, -2.2, 0); trike.visible = false;
  // ----- glows
  const scGlows = scX.map(x => put(R.live, FX.glow('#ffcf8a', 0.75, 0.45), x, 2.0, PZ + 0.3));
  const wGlows = [-3.4, 0.9, 4.2].map(u => put(R.live, FX.glow('#ffcf8a', 0.75, 0.45), -10.7, 2.0, -u));
  const lampG = [put(R.live, FX.glow('#ffb36b', 0.9, 0.35), 9.9, 1.6, 1.6), put(R.live, FX.glow('#ffb36b', 1.2, 0.45), -10.3, 1.6, 4.2), put(R.live, FX.glow('#ffcf8a', 0.6, 0.4), -6.0, 1.05, 1.8)];
  const flashM = new THREE.MeshBasicMaterial({ color: '#fff2d0', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, map: TX.dotTex() });
  const flash = live(new THREE.Mesh(new THREE.PlaneGeometry(3, 3), flashM), doors[241] - 0.2, 1.5, PZ + 0.3);
  const johnnyTxt = new THREE.Sprite(new THREE.SpriteMaterial({ map: TX.label("HERE'S JOHNNY!", '#fff2d0', 'rgba(40,8,8,0.85)', 512, 96, '78px m5x7'), transparent: true, depthWrite: false, toneMapped: false }));
  johnnyTxt.scale.set(2.2, 0.41, 1); live(johnnyTxt, doors[241], 2.75, PZ + 0.5); johnnyTxt.visible = false;
  const playTxt = new THREE.Sprite(new THREE.SpriteMaterial({ map: TX.label('come play with us', '#cfe0ff', 'rgba(10,14,30,0.8)', 512, 96, 'italic 69px m5x7'), transparent: true, depthWrite: false, toneMapped: false }));
  playTxt.scale.set(2.0, 0.375, 1); live(playTxt, -9.9, 2.35, 0.2); playTxt.visible = false;
  R.live.add(FX.motes(30, new THREE.Vector3(-10.5, 0.3, -4.5), new THREE.Vector3(10.5, 2.4, 4.5), '#ffe0b0', 0.035));
  // ----- lights: 4 key lamps
  R.rig = lightRig(R.root, { room: R, sky: '#6a5a8a', ground: '#3a2018', ambient: 3.2, moon: '#8fa8ff', moonI: 1.0, moonFrom: [-9, 8, -2], points: [
    { x: -10.3, y: 2.0, z: -0.9, color: '#ffcf8a', i: 4, d: 7 },
    { x: doors[237], y: 0.4, z: -3.9, color: '#5f8cff', i: 3, d: 3.5 },
    { x: 9.6, y: 1.7, z: 1.9, color: '#ffb36b', i: 7, d: 7 },
    { x: -5.6, y: 1.4, z: 1.6, color: '#ffcf8a', i: 4, d: 5 }] });
  R.meta = { id: 'overlook', name: 'The Overlook Hall', blurb: 'All work and no play. Mind Room 237.' };
  R.spawn = { x: 3.0, z: -2.2, face: 2.4 };
  R.slots = [
    { id: 'arm-w', kind: 'armchair', x: 5.6, z: 3.0, y: 0.0, face: H, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Wingback armchair' },
    { id: 'arm-e', kind: 'armchair', x: 8.4, z: 3.0, y: 0.0, face: -H, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Armchair by the lamp' },
    { id: 'arm-leather', kind: 'armchair', x: 7.0, z: 1.75, y: 0.0, face: 0, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Black leather armchair' },
    { id: 'bench-a', kind: 'bench', x: -2.9, z: -4.3, face: 0, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Velvet bench' },
    { id: 'bench-b', kind: 'bench', x: -2.1, z: -4.3, face: 0, anim: 'Sit_Chair_Idle', prop: 'phone', label: 'Velvet bench' },
    { id: 'desk-chair', kind: 'chair', x: -5.3, z: 1.2, face: -H, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Next to the typewriter' },
    { id: 'typewriter', kind: 'stand', x: -6.2, z: 2.25, face: Math.PI, anim: 'Idle', prop: 'mug', label: 'Reading over Jack\'s shoulder' },
    { id: 'maze', kind: 'stand', x: -0.45, z: 2.3, face: -H, anim: 'Idle', prop: 'beer', label: 'Studying the hedge maze' },
    { id: 'hall', kind: 'stand', x: 1.8, z: 0.8, face: -2.2, anim: 'Idle', prop: 'phone', label: 'Middle of the hall' }];
  R.interact = [
    { id: 'room237', x: doors[237], z: -3.7, r: 1.0, label: 'Try Room 237', kind: 'door' },
    { id: 'twins', x: -9.2, z: 0.2, r: 1.1, label: 'Approach the twins', kind: 'npc' },
    { id: 'typewriter', x: -6.2, z: 2.1, r: 0.9, label: 'Read the pages', kind: 'pc', sfx: false },
    { id: 'johnny', x: doors[241], z: -3.7, r: 1.0, label: 'Knock on 241', kind: 'door' },
    { id: 'maze', x: -1.8, z: 3.3, r: 1.0, label: 'Look at the maze', kind: 'gadget' },
    { id: 'photo', x: 4.9, z: -3.9, r: 0.9, label: 'Look at the old photo', kind: 'poster', sfx: false },
    { id: 'lamp', x: 9.4, z: 1.0, r: 0.8, label: 'Click the lamp', kind: 'lamp' },
    { id: 'door217', x: -10.0, z: -2.6, r: 0.9, label: 'Knock on 217', kind: 'door' },
    { id: 'door233', x: doors[233], z: -3.7, r: 0.9, label: 'Knock on 233', kind: 'door' }];
  for (const it of R.interact) it.sfx = false; // every reaction plays its own sounds below
  const snd = (n, x, z, o = {}) => SFX.play(n, { ...o, at: { x: x + R.root.position.x, z: z + R.root.position.z } });
  const later = (ms, f) => setTimeout(f, ms);
  const poke = live(FX.glow('#ffcf8a', 0.8, 0), 0, 0, 0); let pokeAt = -99, lampOff = -99;
  const flashAt = (x, y, z, c) => { poke.position.set(x, y, z); poke.material.color.set(c); pokeAt = now; };
  R.npc = null;
  R.camera = { zoom: 6.5, target: new THREE.Vector3(0, 0.8, 0) };
  const pkr = poker();
  let now = 0, rattle = -99, dim = -99, johnny = -99, run = -99, trikeAt = 6;
  R.onInteract = (id, api) => {
    if (id === 'room237') { rattle = now; api.bubble('...'); snd('rattle', doors[237], PZ, { vol: 0.7 }); snd('eerie', doors[237], PZ, { vol: 0.45, delay: 0.7 }); }
    else if (id === 'twins') { dim = now; api.toast('"Come play with us."'); snd('eerie', -10, 0.2, { vol: 0.6 }); snd('chime', -10, 0.2, { vol: 0.35, pitch: 0.8, delay: 1.0 }); }
    else if (id === 'johnny') { johnny = now; api.bubble("HERE'S JOHNNY!"); snd('thud', doors[241], PZ); later(260, () => snd('thud', doors[241], PZ, { pitch: 0.9 })); snd('sting', doors[241], PZ, { vol: 0.4, delay: 0.35 }); }
    else if (id === 'maze') { run = now; api.toast('A tiny figure is moving in the maze. Probably nothing.'); snd('wind', -1.8, 2.3, { vol: 0.5 }); for (let i = 0; i < 6; i++) later(i * 230 + (i > 3 ? 900 : 0), () => snd('step.grass', -1.8, 2.3, { vol: 0.35, pitch: 1.8 })); }
    else if (id === 'typewriter') { pkr.poke(twSheet, 'swing', 1.4, 1.2); for (let i = 0; i < 4; i++) snd('typewriter', -6.2, 1.2, { vol: 0.5, delay: i * 0.12 }); api.toast('All work and no play...'); snd('typewriter.ding', -6.2, 1.2, { delay: 0.55 }); }
    else if (id === 'photo') { pkr.poke(R.ovPhoto, 'wiggle', 1.4, 0.8); flashAt(4.9, 1.85, PZ + 0.3, '#fff2d0'); api.toast('July 4th, 1921. Is that... you? Front row.'); snd('paper', 4.9, PZ, { vol: 0.5 }); snd('eerie', 4.9, PZ, { vol: 0.4, delay: 0.4 }); }
    else if (id === 'lamp') { lampOff = now; snd('ui.click', 9.9, 1.6); later(500, () => snd('ui.click', 9.9, 1.6, { pitch: 1.1 })); snd('hum', 9.9, 1.6, { vol: 0.3, delay: 0.55 }); api.bubble('Lights stay on in this hotel.'); }
    else if (id === 'door217') { for (let i = 0; i < 3; i++) later(i * 220, () => snd('thud', -10.9, -2.6, { vol: 0.6, pitch: 1.3 })); api.toast('Room 217. Nobody answers. Good.'); }
    else if (id === 'door233') { for (let i = 0; i < 2; i++) later(i * 240, () => snd('thud', doors[233], PZ, { vol: 0.6, pitch: 1.3 })); snd('creak', doors[233], PZ, { vol: 0.4, delay: 0.9 }); api.bubble('*creak*  ...just the building settling.'); }
  };
  const base = R.rig.points.map(p => p.intensity);
  // light realism: sconce washes on the partition + west wall, floor pools under sconces and lamps, shade behind the photo
  softPlanes(R.live, [
    ...scX.flatMap(x => [[x, 1.75, PZ + 0.13, 1.7, 1.9, 's', '#ffcf8a', 0.2], [x, 0.024, PZ + 0.9, 2.2, 1.5, 'f', '#ffcf8a', 0.1]]),
    ...[-3.4, 0.9, 4.2].flatMap(u => [[-10.66, 1.75, -u, 1.7, 1.9, 'e', '#ffcf8a', 0.18], [-9.9, 0.024, -u, 1.5, 2.0, 'f', '#ffcf8a', 0.09]]),
    [9.9, 0.024, 1.6, 2.8, 2.8, 'f', '#ffb36b', 0.2], [-10.3, 0.024, 4.2, 2.8, 2.8, 'f', '#ffb36b', 0.2], [-10.66, 1.4, 4.2, 1.8, 2.2, 'e', '#ffb36b', 0.18],
    [-6.2, 0.024, 1.2, 1.8, 2.4, 'f', '#ffcf8a', 0.1]]);
  softPlanes(R.live, [[4.95, 1.8, PZ + 0.085, 1.35, 1.05, 's']], true);
  R.finish();
  R.root.traverse(o => { if (o.isMesh && o.parent === R.static) o.castShadow = false; });
  const fw = trike.userData.front, bw = trike.userData.back;
  R.tick = (t, dt) => {
    now = t; pkr.tick(t);
    for (const av of twins) { av.update(dt); }
    // dims: twins dim everything for a moment
    const ds = t - dim, d = ds >= 0 && ds < 2.2 ? 0.15 + 0.85 * Math.min(1, Math.abs(ds - 1.1) / 1.1) ** 2 : 1;
    playTxt.visible = ds >= 0 && ds < 2.8; if (playTxt.visible) playTxt.material.opacity = Math.min(1, (2.8 - ds) * 2);
    const L = R.rig.points;
    L[0].intensity = base[0] * d * soft(t, 2, 0.5, 1.4); L[2].intensity = base[2] * d; L[3].intensity = base[3] * d * soft(t, 5, 0.06);
    R.rig.hemi.intensity = 3.2 * (0.4 + 0.6 * d);
    scGlows.forEach((g, i) => { const bad = i === 1 || i === 4; g.material.opacity = 0.45 * d * (bad ? (0.55 + 0.45 * Math.pow(0.5 + 0.5 * Math.sin(t * 0.7 + i * 1.9), 2)) : soft(t, i, 0.08)); });
    wGlows.forEach((g, i) => { g.material.opacity = 0.45 * d * soft(t, 10 + i, i === 1 ? 0.6 : 0.08, 1.5); });
    { const lo = t - lampOff; lampG.forEach((g, i) => { g.material.opacity = 0.42 * d * (i === 0 && lo >= 0 && lo < 0.55 ? 0.1 : 1); }); L[2].intensity *= lo >= 0 && lo < 0.55 ? 0.3 : 1; }
    { const pk = t - pokeAt; poke.material.opacity = pk >= 0 && pk < 1.2 ? 0.7 * (1 - pk / 1.2) : 0; }
    // 237: breathing blue leak; rattle on E
    const rs = t - rattle, rat = rs >= 0 && rs < 1.4;
    const pulse = 0.38 + 0.15 * Math.sin(t * 0.9) + (rat ? 0.35 : 0);
    leakM.opacity = pulse; g237.material.opacity = pulse * 0.7; L[1].intensity = base[1] * (0.7 + pulse) * (rat ? 1.5 : 1);
    knob.rotation.z = rat ? Math.sin(rs * 60) * 0.5 * (1 - rs / 1.4) : 0; knob.position.x = doors[237] + 0.38 + (rat ? Math.sin(rs * 45) * 0.008 : 0);
    // Johnny flash
    const js = t - johnny, jo = js >= 0 && js < 1.8;
    flashM.opacity = jo ? Math.max(0, 1 - js * 3) * 0.9 : 0; johnnyTxt.visible = jo; if (jo) johnnyTxt.position.x = doors[241] + Math.sin(js * 70) * 0.04 * Math.max(0, 1 - js * 2);
    // maze: a tiny figure scurries along the hedge edge, pauses, then darts off
    { const k = t - run, on = k >= 0 && k < 3.6; kid.visible = on; if (on) { const u = k < 1.6 ? k / 1.6 * 0.55 : k < 2.4 ? 0.55 : 0.55 + (k - 2.4) / 1.2 * 0.45; kid.position.x = -2.57 + u * 1.54; kid.position.y = 0.94 + Math.abs(Math.sin(k * 22)) * 0.01 * (k < 1.6 || k > 2.4 ? 1 : 0); } }
    // Big Wheel: rolls slowly across the hall every ~25 s
    const ts = t - trikeAt, dur = 14;
    if (ts > dur) trikeAt = t + 12 + (Math.sin(t) * 0.5 + 0.5) * 8;
    trike.visible = ts >= 0 && ts <= dur;
    if (trike.visible) { const x = -10.4 + ts / dur * 20.6; trike.position.x = x; fw.rotation.z = -x / 0.26; for (const w of bw) w.rotation.y = -x / 0.09; }
  };
  return R;
}
