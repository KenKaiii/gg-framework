// @ts-check
// Night Shift: the player's own messy 90s bedroom. CRT platformer, green-phosphor terminal, moonbeam through blinds.
import { SFX } from '../sfx.js';
import { roomGlow, liveProp } from './bar-glow.js';
import * as THREE from 'three';
import { makeRoom, lightRig, mat, put, rng, bake, rbox } from './kit.js';
import * as FX from './kit-fx.js';
import * as TX from './tex.js';
import * as P from './bedroom-props.js';
import { rickTex, tickRick } from './rick-screen.js';

/** @param {any} ctx */
export function build(ctx) {
  const wallTex = TX.plaster('#262a52');
  const R = /** @type {any} */ (makeRoom({ id: 'bedroom', floor: TX.planks('#33241e', '#2a1d18'), wall: wallTex, trim: '#2a2440', base: '#141022',
    windows: [{ side: 'w', at: 0.9, w: 1.5, h: 1.3, y: 1.1, blinds: '#b8b4c8', frame: '#4a4660', rain: true, view: TX.nightView({ seed: 21 }) }] }));
  // local frame: x -5..5, z -4..4. North wall (bar's) skipped; opening at x=1. West wall = main back wall (onWall u = -z).
  const S = R.static, r = rng(42);
  const st = (o, x, y, z, ry = 0, block = false) => { put(S, o, x, y, z, ry); if (block) R.blockObj(o); return o; };
  const H = Math.PI / 2;
  // ----- editables (live, merged per item)
  R.editables = [];
  const ed = (o, x, z, ry = 0, block = true) => { bake(o); o.userData.live = true; put(R.live, o, x, 0, z, ry); if (block) R.blockObj(o); R.editables.push(o); return o; };
  const bedO = ed(P.bed(), -3.95, -0.9, H);
  ed(P.rugMesh(), -0.7, 0.9, 0.08, false).position.y = 0.012;
  const chairO = ed(P.chair(), -3.7, 2.6, H - 0.15);
  ed(P.beanbag(), 3.2, 0.2, 1.2);
  ed(P.beanbag(), 1.6, 2.7, 0.6);
  const lampO = ed(P.floorLamp(), 4.5, -2.3);
  ed(P.plant(), 4.45, 3.4);
  ed(P.boombox(), -2.3, -3.65, 0.1);
  // ----- TV corner (north-west)
  st(P.tvCabinet(r), -4.6, 0, -3.0, 0, true);
  const tv = st(P.crt(), -4.55, 0.555, -3.0, H); tv.rotation.y = H + 0.25;
  st(P.console16(), -3.7, 0, -2.75, 0.3, true);
  st(P.pad(), -3.0, 0, -2.3, -0.9); st(P.pad(), -3.4, 0, -1.9, 0.6);
  st(P.cable([[-3.9, 0.03, -2.7], [-3.5, 0.01, -2.4], [-3.2, 0.01, -2.35], [-3.05, 0.02, -2.28]]));
  st(P.cable([[-4.45, 0.4, -2.6], [-4.3, 0.01, -2.4], [-3.95, 0.02, -2.75]]));
  for (const [x, z, ry, c] of [[-3.3, -3.4, 0.4, '#1a1a22'], [-3.15, -3.35, 1.1, '#e9e2d0'], [-2.7, -1.6, -0.3, '#1f2a3a']]) st(P.vhs(/** @type {string} */ (c)), /** @type {number} */ (x), 0, /** @type {number} */ (z), /** @type {number} */ (ry));
  // ----- desk (west wall, south end)
  const dx = -4.55, dz = 2.3; st(P.desk(), dx, 0, dz, H, true);
  const pc = st(P.pc(), dx - 0.1, 0.77, dz + 0.3, H - 0.1);
  st(P.keyboard(), dx + 0.27, 0.77, dz + 0.35, H - 0.05);
  st(P.deskLamp(), dx - 0.12, 0.77, dz - 0.7, H + 2.6);
  st(P.can(false, false, '#2f6fd1'), dx + 0.1, 0.77, dz + 0.85); st(P.can(false, true), dx + 0.25, 0.77, dz - 0.3);
  for (const [z, c] of [[dz + 0.95, '#e23b3b'], [dz + 1.01, '#3b6fe2']]) st(new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.025, 4, 8), mat(c, { roughness: 0.3 })), dx + 0.3, 0.785, z).rotation.x = Math.PI / 2;
  // ----- shelves, posters (west wall only: n is the bar's, s/e are cut down)
  R.onWall('w', P.shelf(r, 1.3), 3.0, 1.85); R.onWall('w', P.posterOn('retro', '', 0.5, 0.06), 3.1, 2.55);
  R.onWall('w', P.posterOn('maze', '', 0.4, 0.04), -0.55, 2.3);
  R.onWall('w', P.posterOn('band', 'THE NULL POINTERS', 0.62, 0.05), -1.6, 1.95);
  R.onWall('w', P.shelf(r, 1.0), -2.4, 2.6);
  R.onWall('w', P.posterOn('ship', 'IT WORKS ON MY MACHINE', 0.48, -0.03), -3.25, 1.75);
  R.onWall('w', P.posterOn('movie', 'NIGHT DRIVE', 0.5, -0.05), 1.95, 2.45);
  // ----- floor mess
  st(P.pizzaBox(), -0.6, 0, 0.4, 0.5);
  for (const [x, z, l, c] of [[0.0, 1.0, 1, 0], [-1.2, 1.6, 0, 1], [0.6, 0.0, 1, 0], [-2.4, 1.3, 0, 0], [2.4, -1.2, 0, 1], [-1.6, -1.2, 1, 1]]) st(P.can(!!l, !!c, ['#c23b3b', '#2f6fd1', '#3ddc84'][Math.floor(r() * 3)]), x, 0, z, r() * 6);
  st(P.cloth(0.6, 0.5, '#4a3a5e', 5, [0.2, 0.15], 0.1, 0.05), 0.4, 0.04, 1.7, 0.6);
  st(P.cloth(0.5, 0.45, '#2a2a33', 7, [0.15, 0.15], 0.1, 0.05), -1.9, 0.04, -0.4, 1.2);
  st(P.cloth(0.7, 0.5, '#6b2a2a', 11, [0.2, 0.15], 0.12, 0.06), -0.8, 0.05, 3.2, 2.0);
  st(P.vhs('#1f2a3a'), -2.2, 0, 2.9, 0.7); st(P.can(true, false, '#3ddc84'), 3.0, 0, 2.2, 1);
  st(P.pizzaBox(), -3.0, 0, 3.4, -0.4); st(P.cloth(0.8, 0.6, '#2e3a5e', 13, [0.25, 0.2], 0.12, 0.07), 0.3, 0.05, 3.4, 0.3);
  st(P.backpack(), 3.3, 0, 3.5, 2.6, true); st(P.can(false, true, '#c23b3b'), -2.6, 0, 3.6); st(P.vhs('#e9e2d0'), 2.3, 0, 3.4, -0.5);
  st(P.laundry(), -1.5, 0, 3.55, 0, true); st(P.amp(), 4.6, 0, -1.3, -1.5, true); { const gt = P.guitar(); liveProp(gt, 'rx-guitar'); put(R.live, gt, 4.65, 0, -0.5, -1.6); R.blockObj(gt); }
  st(P.fridge(), 4.6, 0, -3.4, -1.6, true); st(P.pizzaStack(3), 4.4, 0, 1.4, 0.3, true);
  st(P.skateboard(), 3.4, 0, -3.65, 0.1); st(P.backpack(), -2.2, 0, -2.8, -0.5, true);
  { // floor cushion
    const cu = new THREE.Group(); const cm = mat('#5a2a4a', { roughness: 0.95 });
    put(cu, rbox(0.62, 0.14, 0.62, cm, 0.07), 0, 0.07, 0); st(cu, -1.7, 0, 2.2, 0.4); }
  { const t = TX.canvasTex('bed-stripe', 64, 128, (x, w, h) => { x.clearRect(0, 0, w, h); for (let i = 0; i < 8; i++) { const gr = x.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gr; x.fillRect(0, i * 16 + 2, w, 9); } });
    const q = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.6), new THREE.MeshBasicMaterial({ map: t, color: '#8fa8ff', transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    q.rotation.set(-Math.PI / 2, 0, H); q.position.set(-2.25, 0.015, -0.6); q.userData.live = true; R.live.add(q); }
  // ----- light: moonbeam + motes
  const beam = FX.beam(new THREE.Vector3(-4.85, 2.1, -0.9), new THREE.Vector3(-2.3, 0, -0.6), 1.2, 1.4, '#8fa8ff', 0.035); R.live.add(beam);
  const beam2 = FX.beam(new THREE.Vector3(-4.85, 2.1, -0.9), new THREE.Vector3(-2.3, 0, -0.6), 1.6, 2.0, '#8fa8ff', 0.025); R.live.add(beam2);
  R.live.add(FX.motes(40, new THREE.Vector3(-4.7, 0.3, -1.6), new THREE.Vector3(-2.2, 2.0, -0.1), '#cfdcff', 0.04));
  const halo = FX.glow('#ffcf8a', 0.9, 0.5); put(R.live, halo, -4.65, 1.2, 1.6);
  const lampHalo = FX.glow('#ffb36b', 1.2, 0.45); R.live.add(lampHalo);
  const tvHalo = FX.glow('#7fd0ff', 1.3, 0.25); put(R.live, tvHalo, -4.1, 0.9, -3.0);
  R.rig = lightRig(R.root, { room: R, sky: '#6a7ad0', ground: '#2a2040', ambient: 2.6, moon: '#8fa8ff', moonI: 1.2, moonFrom: [-9, 7, -2], points: [
    { x: -4.4, y: 1.15, z: 1.7, color: '#ffb36b', i: 5, d: 5 },
    { x: -3.8, y: 1.0, z: -3.0, color: '#8fc4ff', i: 3, d: 4.5 },
    { x: 4.5, y: 1.6, z: -2.3, color: '#ffb36b', i: 4, d: 6 },
    { x: -4.2, y: 1.2, z: 2.6, color: '#3ddc84', i: 1.4, d: 2.5 }] });
  R.meta = { id: 'bedroom', name: 'Night Shift', blurb: 'Your own room: CRT glow, rain on the blinds, terminal still blinking.' };
  R.spawn = { x: 1.0, z: -1.5, face: -2.4 };
  R.slots = [
    { id: 'bed-edge', kind: 'bed', x: -3.6, z: 0.05, y: 0.08, face: 0.3, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Edge of the bed' },
    { id: 'desk', kind: 'chair', x: -3.7, z: 2.6, face: -H, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Desk chair' },
    { id: 'floor-tv', kind: 'floor', x: -3.0, z: -3.0, face: -H - 0.2, anim: 'Sit_Floor_Idle', prop: 'controller', label: 'Floor, in front of the TV' },
    { id: 'beanbag', kind: 'beanbag', x: 3.2, z: 0.2, y: 0.22, face: -1.62, anim: 'Sit_Floor_Idle', prop: 'laptop', label: 'Beanbag' },
    { id: 'beanbag-2', kind: 'beanbag', x: 1.6, z: 2.7, y: 0.22, face: -2.36, anim: 'Sit_Floor_Idle', prop: 'controller', label: 'Second beanbag' },
    { id: 'cushion', kind: 'floor', x: -1.7, z: 2.2, y: 0.1, face: -2.6, anim: 'Sit_Floor_Idle', prop: 'laptop', label: 'Floor cushion' }];
  R.interact = [
    { id: 'bed', x: -3.4, z: -0.9, r: 1.1, label: 'Sleep it off', kind: 'bed' },
    { id: 'pc', x: -3.9, z: 2.0, r: 0.9, label: 'Check terminal', kind: 'pc' },
    { id: 'window', x: -4.2, z: 0.3, r: 0.8, label: 'Look outside', kind: 'window' }];
  R.npc = null;
  R.camera = { zoom: 5, target: new THREE.Vector3(-0.3, 0.8, 0) };
  const msgs = ['> wake up, neo...', '> build passed. go to sleep.', '> 3 commits ahead of origin', '> knock, knock.'];
  let now = 0, dimUntil = -1, mi = 0;
  R.onInteract = (id, api) => {
    if (id === 'bed') { dimUntil = now + 3; api.toast('Zzz... five more minutes.'); }
    else if (id === 'pc') api.bubble(msgs[mi++ % msgs.length]);
    else if (id === 'window') api.toast('Rain on the glass. The city is still awake.');
  };  // reaction sounds, timed to the animations (the default keyword guess is silenced for these)
  /** @type {Record<string, () => void>} */
  const RSND = {
    bed: (at) => { SFX.play('cushion', { at }); SFX.play('creak', { at, vol: 0.4, delay: 0.2 }); },
  };
  for (const it of R.interact) if (RSND[it.id]) it.sfx = false;
  { const oi = R.onInteract; R.onInteract = (id, api) => { const it = R.interact.find(e => e.id === id), o = R.root.position; if (it) RSND[id]?.({ x: o.x + it.x, y: 1, z: o.z + it.z }); oi(id, api); }; }

  const base = R.rig.points.map(p => p.intensity);
  roomGlow(R, [], { pools: 1.5 }); // dim room: lamp/desk pools read clearly without lifting the ambient
  R.finish();
  // shadow budget: only big wood/beige/wall/blind surfaces cast moon shadows
  const big = new Set([P.WOOD, P.DWOOD, P.BEIGE]); const wallImg = wallTex.image;
  const keep = o => big.has(o.material) || o.material.map?.image === wallImg || (o.material.color && o.material.color.getHexString() === 'b8b4c8');
  for (const g of [R.static, ...Object.values(R.walls).map(w => w.full)]) g.traverse(o => { if (o.isMesh) o.castShadow = keep(o); });
  for (const e of R.editables) if (e !== bedO && e !== chairO) e.traverse(o => { o.castShadow = false; });
  const ticks = []; R.root.traverse(o => { if (o.userData.tick) ticks.push(o.userData.tick); });
  void bedO; void chairO;
  R.tick = (t, dt) => {
    beam.visible = beam2.visible = R.walls.w.full.visible;
    now = t; for (const f of ticks) f(t, dt);
    tickRick(t); tv.userData.screen.map = rickTex();
    
    const dim = t < dimUntil ? 0.25 + 0.75 * Math.min(1, Math.abs(t - dimUntil + 1.5) / 1.5) : 1;
    const L = R.rig.points; L[0].intensity = base[0] * dim * 1; L[1].intensity = base[1] * dim * (1 - 0.15 * (0.5 + 0.5 * Math.sin(t * 2.86)));
    L[2].intensity = base[2] * dim; L[3].intensity = base[3] * dim; R.rig.hemi.intensity = 2.6 * (0.5 + 0.5 * dim);
    L[2].position.set(lampO.position.x, 1.6, lampO.position.z); lampHalo.position.set(lampO.position.x, 1.58, lampO.position.z);
    tvHalo.material.opacity = 0.25 * (1 - 0.15 * (0.5 + 0.5 * Math.sin(t * 2.86)));
  };
  return R;
}
