// @ts-check
// The Kitchen: the late-night house-party kitchen where everyone ends up. Island under a pendant, magnet-covered fridge,
// ramen steaming on the stove, a microwave clock forever blinking 12:00, and a green-glowing kettle (the Matrix touch).
// Local frame x -4..4, z -4..4. n wall (bar's) and w wall (bedroom's) are NOT ours: free-standing pieces only there.
import { SFX } from '../sfx.js';
import { roomGlow, liveProp } from './bar-glow.js';
import * as THREE from 'three';
import { makeRoom, lightRig, mat, glowMat, put, rng, bake } from './kit.js';
import * as FX from './kit-fx.js';
import * as TX from './tex.js';
import * as P from './kitchen-props.js';

const H = Math.PI / 2;

/** InstancedMesh from [x,y,z,ry,s?] rows (no shadows: small stuff). */
function inst(parent, geo, m, rows) {
  const im = new THREE.InstancedMesh(geo, m, rows.length); const o = new THREE.Object3D();
  rows.forEach((r, i) => { o.position.set(r[0], r[1], r[2]); o.rotation.set(r[5] || 0, r[3] || 0, 0); o.scale.setScalar(r[4] || 1); o.updateMatrix(); im.setMatrixAt(i, o.matrix); });
  im.castShadow = false; im.receiveShadow = true; im.userData.live = true; parent.add(im); return im;
}

/** @param {any} ctx */
export function build(ctx) {
  const wallTex = TX.plaster('#2a2440', 11);
  const R = /** @type {any} */ (makeRoom({ id: 'kitchen', floor: TX.tiles('#3a3442', '#4a4250', 8), floorRepeat: 2, wall: wallTex, trim: '#2a2440', base: '#141022' }));
  const S = R.static, r = rng(7);
  const st = (o, x, y, z, ry = 0, block = false) => { put(S, o, x, y, z, ry); if (block) R.blockObj(o); return o; };
  // ----- west run: fridge, sink counter, stove, prep counter, hutch with strip light (all free-standing)
  st(P.fridge(), -3.55, 0, -3.45, H, true);
  st(P.counter(1.6, true), -3.62, 0, -2.05, H, true);
  st(P.stove(), -3.62, 0, -0.94, H, true);
  st(P.counter(2.0), -3.62, 0, 0.37, H, true);
  st(P.hutch(4.24), -3.62, 0, -0.74, H);
  // ----- north run east of the bar opening: coffee corner
  st(P.counter(2.0), 2.9, 0, -3.62, 0, true);
  st(P.espresso(), 2.3, 0.88, -3.65);
  st(P.microwave(), 3.35, 0.88, -3.68);
  st(P.kettle(), -3.55, 0.88, 0.75, 0.6);
  st(P.toaster(), -3.6, 0.88, 1.15, H);
  for (const [z, c, s] of [[-1.8, '#c23b3b', 0], [-1.5, '#e9a43a', 1], [0.6, '#2f6fd1', 0]]) st(P.cereal(/** @type {string} */ (c), s), -3.66, 1.625, /** @type {number} */ (z), H);
  // ----- island + pendant
  st(P.island(), 0, 0, 0.3, 0, true);
  st(P.pendant(2.2), 0, 0, 0.35);
  st(P.pendant(2.0), 2.2, 0, 2.8);
  st(P.pizzaBox(), -0.4, 0.935, 0.35, 0.3); st(P.pizzaBox(false), 0.5, 0.935, 0.15, -0.2); st(P.pizzaBox(false), 0.5, 0.975, 0.17, 0.1);
  st(P.noodleBowl(), 0.95, 0.935, 0.55);
  // ----- dining table with mismatched chairs
  st(P.roundTable(), 2.2, 0, 2.8, 0, true);
  st(P.chair('#6b2a2a'), 1.4, 0, 2.8, H); st(P.chair('#2f4a5e'), 3.0, 0, 2.8, -H); st(P.chair('#5a4a2a'), 2.2, 0, 3.55, Math.PI);
  st(P.pizzaBox(), 2.0, 0.765, 2.95, 2.4);
  // ----- easel, bin, plants, floor pizza stack
  st(P.whiteboard(), -3.1, 0, 3.2, H / 2 + 0.1, true);
  st(P.bin(), 3.6, 0, -2.55, 0, true);
  for (const [o, x, z, n] of /** @type {[any, number, number, string][]} */ ([[P.plant(1.2, 3), -1.95, -3.6, 'rx-plant'], [P.plant(0.9, 5), 3.6, 3.6, 'rx-plant2']])) { liveProp(o, n); put(R.live, o, x, 0, z); R.blockObj(o); }
  st(P.plant(0.7, 8), -3.55, 1.625, -2.6);
  st(P.pizzaBox(false), -2.25, 0, 3.55, 0.4); st(P.pizzaBox(false), -2.25, 0.04, 3.55, 0.7); st(P.pizzaBox(false), -2.25, 0.08, 3.55, 0.2);
  // ----- instanced stools, cans, mugs
  const stools = [[-0.75, 1.25], [0, 1.25], [0.75, 1.25], [1.65, 0.35]];
  inst(R.live, P.stoolGeo(), mat('#1c1a20', { roughness: 0.5 }), stools.map(([x, z]) => [x, 0.72, z]));
  inst(R.live, new THREE.CylinderGeometry(0.025, 0.025, 0.7, 6), P.STEEL, stools.map(([x, z]) => [x, 0.35, z]));
  inst(R.live, new THREE.TorusGeometry(0.14, 0.012, 4, 14), P.STEEL, stools.map(([x, z]) => [x, 0.25, z, 0, 1, H]));
  inst(R.live, new THREE.CylinderGeometry(0.2, 0.22, 0.03, 14), P.STEEL, stools.map(([x, z]) => [x, 0.015, z]));
  for (const [x, z] of stools) R.block(x - 0.15, z - 0.15, x + 0.15, z + 0.15);
  const cans = [[-0.9, 0.995, 0.1], [-0.75, 0.995, 0.6], [0.1, 0.995, 0.6], [1.0, 0.995, 0.15], [2.5, 0.825, 2.6], [1.9, 0.825, 2.5],
    [3.45, 0.7, -2.55], [3.62, 0.71, -2.45], [3.55, 0.74, -2.62], [3.7, 0.69, -2.6, 0, 1, 1.4], [3.4, 0.03, -2.2, 0, 1, H], [3.2, 0.03, -2.0, 1, 1, H],
    [-3.5, 2.285, -1.0], [-3.5, 2.285, -0.85], [-3.5, 2.285, -0.7], [-1.9, 0.03, 3.1, 2, 1, H], [-2.4, 0.06, 1.9]];
  const canM = mat('#2f6fd1', { roughness: 0.3, metalness: 0.6 });
  const cim = inst(R.live, P.canGeo(), canM, cans);
  const cc = ['#3ddc84', '#c23b3b', '#2f6fd1', '#e9c46a', '#b04fd8']; const col = new THREE.Color();
  cans.forEach((_, i) => cim.setColorAt(i, col.set(cc[Math.floor(r() * cc.length)])));
  const mugs = [[-3.55, 0.88, -2.15], [-3.7, 0.88, -1.95], [-3.5, 0.98, -2.05, 0, 1, 1.2], [-3.68, 0.88, -2.3], [-3.6, 1.625, 0.0], [-3.6, 1.625, 0.2], [-3.6, 1.625, 0.4],
    [0.3, 0.935, 0.5], [2.45, 0.765, 3.05], [2.65, 0.88, -3.5], [-3.5, 0.88, -0.2]];
  const mim = inst(R.live, P.mugGeo(), mat('#e8e0d0', { roughness: 0.4, side: THREE.DoubleSide }), mugs);
  mugs.forEach((_, i) => mim.setColorAt(i, col.set(['#e8e0d0', '#1a1a1a', '#c23b3b', '#3a5a8a'][i % 4])));
  { // "there is no spoon" mug label next to the kettle
    const lab = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.055), new THREE.MeshBasicMaterial({ map: TX.label('there is no spoon', '#6ee7a0', '#101a14', 256, 64, '36px m5x7'), toneMapped: false }));
    lab.position.set(-3.27, 0.935, 1.25); lab.rotation.set(-H, 0, H); lab.userData.live = true; R.live.add(lab); }
  // ----- live glows: microwave clock, fridge crack glow, kettle halo, interior microwave light
  const clock = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.03), new THREE.MeshBasicMaterial({ map: TX.label('12:00', '#5dff9a', '#050805', 128, 48, '51px m5x7'), toneMapped: false }));
  clock.position.set(3.54, 1.11, -3.495); clock.userData.live = true; R.live.add(clock);
  const mwGlow = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.2), glowMat('#ffb36b', 1.8)); mwGlow.position.set(3.28, 1.03, -3.49); mwGlow.visible = false; mwGlow.userData.live = true; R.live.add(mwGlow);
  const fridgeHalo = FX.glow('#e8f4ff', 1.4, 0.35); put(R.live, fridgeHalo, -3.05, 1.0, -3.0);
  const kettleHalo = FX.glow('#3ddc84', 0.6, 0.5); put(R.live, kettleHalo, -3.45, 1.03, 0.85);
  put(R.live, FX.glow('#ffcf8a', 1.0, 0.45), 0, 2.25, 0.35); put(R.live, FX.glow('#ffb36b', 0.9, 0.4), 2.2, 2.05, 2.8);
  R.live.add(FX.steam(new THREE.Vector3(-3.5, 1.06, -0.79), '#ffffff', 7, 0.7));
  const espSteam = FX.steam(new THREE.Vector3(2.34, 1.0, -3.4), '#ffffff', 5, 0.4); espSteam.visible = false; R.live.add(espSteam);
  R.rig = lightRig(R.root, { room: R, sky: '#5a62b0', ground: '#2a2040', ambient: 3.0, moon: '#8fa8ff', moonI: 0.7, moonFrom: [6, 9, 8], points: [
    { x: 0, y: 2.1, z: 0.35, color: '#ffb36b', i: 9, d: 7 },
    { x: -3.25, y: 1.5, z: -0.7, color: '#ffcf8a', i: 6, d: 5 },
    { x: -2.9, y: 1.0, z: -3.2, color: '#d8ecff', i: 3, d: 4 },
    { x: 2.2, y: 1.9, z: 2.8, color: '#ffb36b', i: 4, d: 4.5 }] });
  R.meta = { id: 'kitchen', name: 'The Kitchen', blurb: 'Where every party ends up: ramen steaming, fridge humming, someone ate your leftovers.' };
  R.spawn = { x: 1.0, z: -1.8, face: 2.4 };
  R.slots = [
    { id: 'stool-1', kind: 'stool', x: -0.75, z: 1.25, y: 0.3, face: Math.PI, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Island stool' },
    { id: 'stool-2', kind: 'stool', x: 0, z: 1.25, y: 0.3, face: Math.PI, anim: 'Sit_Chair_Idle', prop: 'beer', label: 'Island stool, middle' },
    { id: 'stool-3', kind: 'stool', x: 0.75, z: 1.25, y: 0.3, face: Math.PI, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Island stool by the noodles' },
    { id: 'stool-end', kind: 'stool', x: 1.65, z: 0.35, y: 0.3, face: -H, anim: 'Sit_Chair_Idle', prop: 'mug', label: 'End of the island' },
    { id: 'table-w', kind: 'chair', x: 1.4, z: 2.8, face: H, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Dining table, red chair' },
    { id: 'table-e', kind: 'chair', x: 3.0, z: 2.8, face: -H, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Dining table, blue chair' },
    { id: 'table-s', kind: 'chair', x: 2.2, z: 3.55, face: Math.PI, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Dining table, wobbly chair' },
    { id: 'counter', kind: 'stand', x: -2.75, z: 0.7, face: -H, anim: 'Idle', prop: 'mug', label: 'Leaning on the counter' },
    { id: 'fridge', kind: 'stand', x: -2.55, z: -3.0, face: 1.2, anim: 'Idle', prop: 'phone', label: 'Leaning by the fridge' },
    { id: 'coffee', kind: 'stand', x: 2.6, z: -2.7, face: Math.PI, anim: 'Idle', prop: 'beer', label: 'Waiting for the coffee' }];
  R.interact = [
    { id: 'fridge', x: -2.9, z: -3.3, r: 0.9, label: 'Raid the fridge', kind: 'fridge' },
    { id: 'espresso', x: 2.3, z: -3.0, r: 0.7, label: 'Make a coffee', kind: 'espresso' },
    { id: 'microwave', x: 3.35, z: -3.0, r: 0.7, label: 'Nuke leftovers', kind: 'microwave' }];
  R.npc = null;
  R.camera = { zoom: 5, target: new THREE.Vector3(0, 0.8, 0) };
  let now = 0, fridgeUntil = -1, espUntil = -1, mwUntil = -1, fi = 0;
  const raids = ['Half a lime, three hot sauces and someone\'s labelled yogurt.', 'You found cold pizza. Nobody saw anything.', 'The kombucha looked back at you.'];
  R.onInteract = (id, api) => {
    if (id === 'fridge') { fridgeUntil = now + 2.5; api.bubble(raids[fi++ % raids.length]); }
    else if (id === 'espresso') { espUntil = now + 4; api.toast('Double shot pulled. Ship it.'); }
    else if (id === 'microwave') { mwUntil = now + 3.5; api.toast('Nuking leftovers... do not open until the beep.'); }
  };  // reaction sounds, timed to the animations (the default keyword guess is silenced for these)
  /** @type {Record<string, () => void>} */
  const RSND = {
    fridge: (at) => { SFX.play('fridge', { at }); SFX.play('glass', { at, vol: 0.35, delay: 0.6 }); SFX.play('door', { at, vol: 0.4, delay: 2.2 }); },
    espresso: (at) => { SFX.play('espresso', { at }); SFX.play('pour', { at, vol: 0.4, delay: 1.6 }); SFX.play('ping', { at, vol: 0.3, delay: 3.6 }); },
    microwave: (at) => { SFX.play('microwave', { at }); [3400, 3600, 3800].forEach(ms => setTimeout(() => SFX.play('beep', { at, vol: 0.3, pitch: 1.2 }), ms)); },
  };
  for (const it of R.interact) if (RSND[it.id]) it.sfx = false;
  { const oi = R.onInteract; R.onInteract = (id, api) => { const it = R.interact.find(e => e.id === id), o = R.root.position; if (it) RSND[id]?.({ x: o.x + it.x, y: 1, z: o.z + it.z }); oi(id, api); }; }

  roomGlow(R, [ // fridge + stove/hood wash on the west wall, warm pool on the island top, shade behind the hutch shelves
    { at: [0, 1.1, -3.4], w: 1.3, h: 2.0, c: '#d8ecff', a: 0.08, face: 'w' }, { at: [0, 1.5, -0.94], w: 1.1, h: 1.6, c: '#ff8a3d', a: 0.07, face: 'w' },
    { at: [0, 1.95, -0.74], w: 4.3, h: 0.9, a: 0.32, face: 'w', shade: true }, { at: [0, 0.95, 0.3], w: 1.8, h: 1.1, c: '#ffcf8a', a: 0.07 },
    { at: [2.2, 0.78, 2.8], w: 1.3, h: 1.3, c: '#ffb36b', a: 0.06 }, { at: [2.9, 0.89, -3.5], w: 2.0, h: 0.5, c: '#ffcf8a', a: 0.05 }]);
  R.finish();
  const big = new Set([P.WOOD, P.CAB, P.TOP]); const wallImg = wallTex.image;
  for (const g of [R.static, ...Object.values(R.walls).map(w => w.full)]) g.traverse(o => { if (o.isMesh) o.castShadow = big.has(o.material) || o.material.map?.image === wallImg || o.material.color?.getHexString() === '46504f'; });
  const ticks = []; R.root.traverse(o => { if (o.userData.tick) ticks.push(o.userData.tick); });
  const L = R.rig.points, base = L.map(p => p.intensity);
  R.tick = (t, dt) => {
    now = t; for (const f of ticks) f(t, dt);
    const mw = t < mwUntil;
    clock.material.color.setScalar(mw ? 1 : 0.6 + 0.4 * Math.sin(t * 2.4)); mwGlow.visible = mw;
    espSteam.visible = t < espUntil;
    const open = t < fridgeUntil ? 2.2 : 1; const hum = 0.9 + 0.1 * Math.sin(t * 1.4);
    L[2].intensity = base[2] * hum * open; fridgeHalo.material.opacity = 0.12 * hum * open;
    L[0].intensity = base[0]; L[1].intensity = base[1] * (1 - 0.03 * (0.5 + 0.5 * Math.sin(t * 1.26)));
    kettleHalo.material.opacity = 0.4 + 0.15 * Math.sin(t * 1.3);
  };
  return R;
}
