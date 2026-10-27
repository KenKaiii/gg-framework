// @ts-check
// Hawkins Living Room (Stranger Things homage): 80s wood-panelled suburban living room that's slightly wrong.
// Hero piece: a free-standing panelled partition with the painted Christmas-lights alphabet (bulbs spell words) and a
// glowing red rift with drifting spores. Plaid sofa + console TV with static, shag rug, walkie-talkie and frozen waffles
// on the coffee table, rotary phone with a long cord, flickering floor lamp, a D&D table with a toothy monster mini,
// a kid's bike with a basket by the west opening. Every so often all the lights flicker together.
import * as THREE from 'three';
import { makeRoom, lightRig, mat, glowMat, put, mesh, rbox } from './kit.js';
import * as FX from './kit-fx.js';
import { SFX } from '../sfx.js';
import { poker, solidify } from './screening-poke.js';
SFX.define('hawkins.bell', (o, t, p, K) => { K.bell(o, t, { f: 2100 * p, ratio: 1.41, idx: 1.5, v: 0.12, d: 0.4 }); K.bell(o, t + 0.12, { f: 2100 * p, ratio: 1.41, idx: 1.5, v: 0.1, d: 0.5 }); });

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
import * as P from './hawkins-props.js';
import { rickTex, tickRick } from './rick-screen.js';

/** @param {any} ctx */
export function build(ctx) {
  void ctx;
  const R = makeRoom({ id: 'hawkins', floor: TX.planks('#8a5a36', '#6e4628', 31), wall: TX.panels('#7a4e2c', '#94603a'), trim: '#2a1a10', base: '#1a100a',
    windows: [{ side: 'e', at: -3.2, w: 1.5, h: 1.1, y: 1.1, view: TX.nightView({ seed: 44, sky: ['#0a0a18', '#1a1430', '#3a1a2a'] }), frame: '#2a1a10', blinds: '#6a5a40' },
      { side: 's', at: 2.5, w: 1.8, h: 1.1, y: 1.1, view: TX.nightView({ seed: 45, sky: ['#0a0a18', '#1a1430', '#3a1a2a'] }), frame: '#2a1a10', blinds: '#6a5a40' }] });
  const S = R.static, L = R.live;
  const live = o => { o.userData.live = true; L.add(o); return o; };
  const plane = (w, h, m) => { const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m); p.rotation.x = -Math.PI / 2; p.receiveShadow = true; return p; };
  const faceTo = (x, z, tx, tz) => Math.atan2(tx - x, tz - z);

  // HERO: alphabet partition (free-standing, faces the camera) + the rift on its right end
  const AW = P.alphabetWall(); const ab = put(S, AW.g, 0.3, 0, -4.3); R.block(-2.95, -4.75, 3.55, -4.05); void ab;
  AW.bulbs.position.set(0.3, 0, -4.3); live(AW.bulbs);
  const litGlow = live(FX.glow('#ffd070', 0.5, 0)); const lit2 = live(FX.glow('#ffd070', 1.4, 0));
  const rift = live(P.rift(0.9, 1.9)); rift.position.set(2.8, 1.25, -4.29);
  const riftGlow = live(FX.glow('#ff3020', 2.6, 0.35)); riftGlow.position.set(2.8, 1.25, -4.1);
  put(S, plane(1.6, 1.1, mat('#1a0808', { roughness: 1, transparent: true, opacity: 0.6 })), 2.8, 0.004, -3.6); // scorched floor
  const spores = live(FX.motes(40, new THREE.Vector3(1.6, 0.2, -4.1), new THREE.Vector3(4.0, 2.6, -2.4), '#ffb0a0', 0.05));
  const sporesRoom = live(FX.motes(45, new THREE.Vector3(-8, 0.3, -4.5), new THREE.Vector3(8, 2.8, 4.5), '#d8c8c0', 0.035));
  const vine = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[2.6, 0.02, -4.2], [2.9, 0.3, -4.22], [2.7, 0.6, -4.22], [3.1, 0.15, -3.9], [3.5, 0.02, -3.5]].map(v => new THREE.Vector3(...v))), 30, 0.025, 5);
  S.add(mesh(vine, mat('#2a1a1e', { roughness: 0.6 })));

  // TV corner (west): shag rug, plaid sofa facing the console TV, coffee table, armchair, floor cushions
  put(S, plane(4.8, 3.4, mat('#ffffff', { map: TX.rug('shag', '#7a5a2a', '#a07a3a') })), -4.4, 0.005, 2.6);
  const tv = P.consoleTV(); put(S, tv.g, -6.9, 0, 2.6, Math.PI / 2); R.blockObj(tv.g);
  const tvGlow = live(FX.glow('#c8d8ff', 2.0, 0.25)); tvGlow.position.set(-6.3, 0.9, 2.75);
  const scr = /** @type {THREE.MeshBasicMaterial} */ (tv.screen.material); scr.map = rickTex();
  for (let i = 0; i < 4; i++) put(S, rbox(0.2, 0.035, 0.11, mat(['#1a1a1a', '#3a2a5a', '#1a1a1a', '#5a1a1a'][i], { roughness: 0.6 }), 0.008), -6.9, 0.93 + i * 0.037, 2.15, i * 0.2); // VHS on the TV
  const sofa = put(S, P.sofa(), -2.7, 0, 2.6, -Math.PI / 2); R.blockObj(sofa);
  const ct = put(S, P.coffeeTable(), -4.3, 0, 2.6, Math.PI / 2); ct.userData.ground = { k: 1.5 }; R.blockObj(ct);
  const wk = put(S, P.walkie(), -4.2, 0.45, 2.05, 0.4), wfl = put(S, P.waffles(), -4.35, 0.45, 3.05); // only the LED and the top waffle (+butter) stay live
  const wLed = wk.children[3], wTop = wfl.children[3]; wLed.userData.live = true; wTop.userData.live = true; wTop.attach(wfl.children[4]); // live: buzz / pop on E
  put(S, rbox(0.06, 0.12, 0.06, mat('#c03030', { roughness: 0.4 }), 0.025), -4.1, 0.51, 2.6);
  const ac = put(S, P.armchair(), -4.6, 0, 0.4, faceTo(-4.6, 0.4, -6.9, 2.6)); R.blockObj(ac);
  const cush = [[-5.6, 3.95], [-5.75, 1.45]].map(([x, z], i) => { put(S, rbox(0.62, 0.14, 0.62, mat(['#7a3a2a', '#3a5a4a'][i], { roughness: 0.95 }), 0.06), x, 0.07, z, 0.3); return { x, z }; });
  const lamp = P.floorLamp(); put(S, lamp.g, -2.4, 0, 4.4); R.block(-2.6, 4.2, -2.2, 4.6);
  const lampGlow = live(FX.glow('#ffcf8a', 1.6, 0.4)); lampGlow.position.set(-2.4, 1.6, 4.4);
  const pt = put(S, P.phoneTable(), -2.6, 0, 0.75, -0.6); R.block(-2.9, 0.45, -2.3, 1.05);
  const bk = put(S, P.bike(), -8.35, 0, -2.9, -Math.PI / 2 + 0.15); R.blockObj(bk); void pt;
  const basket = solidify(bk.children.find(c => c.isGroup)); // the basket rattles when the bell rings
  put(S, rbox(0.42, 0.34, 0.08, mat('#3a4a8a', { roughness: 0.7 }), 0.04), -7.9, 0.17, -4.4, 0.3); // backpack
  put(S, rbox(0.3, 0.2, 0.14, mat('#6a6a6a', { metalness: 0.6, roughness: 0.4 }), 0.03), -7.5, 0.1, -4.5, -0.4); // lunchbox

  // D&D corner (east): round table, 4 chairs, pendant lamp
  const DX = 5.6, DZ = 2.2, dd = P.dndTable(); put(S, dd.g, DX, 0, DZ);
  const dice = dd.g.children.filter(c => c.geometry?.type === 'IcosahedronGeometry').slice(0, 1); for (const d of dice) d.userData.live = true; // two dice tumble on a roll dd.g.userData.ground = { k: 1.5 }; R.block(DX - 0.85, DZ - 0.85, DX + 0.85, DZ + 0.85);
  put(S, plane(3.2, 3.2, mat('#ffffff', { map: TX.rug('round', '#3a2a1a', '#6a4a2a', '#8a6a3a') })), DX, 0.005, DZ);
  const seats = [0, 1, 2, 3].map(k => { const a = k * Math.PI / 2 + Math.PI / 4, x = DX + Math.sin(a) * 1.05, z = DZ + Math.cos(a) * 1.05, f = a + Math.PI; put(S, P.chair(), x, 0, z, f); return { x, z, f }; });
  const pend = new THREE.Group(); put(S, pend, DX, 0, DZ);
  put(pend, mesh(new THREE.CylinderGeometry(0.008, 0.008, 1.1, 6), mat('#111')), 0, 2.65, 0);
  put(pend, mesh(new THREE.SphereGeometry(0.4, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2.4), glowMat('#e0a050', 0.9, { side: THREE.DoubleSide })), 0, 1.75, 0);
  const pendGlow = live(FX.glow('#ffb36b', 1.2, 0.3)); pendGlow.position.set(DX, 1.8, DZ);
  // the middle: hutch (free-standing, back to the alphabet partition side), ottoman, laundry basket
  const hu = put(S, P.hutch(), 0.6, 0, 1.6, Math.PI / 2); R.blockObj(hu);
  put(S, P.ottoman(), -0.6, 0, 3.4); R.block(-1.0, 3.0, -0.2, 3.8);
  put(S, P.laundry(), 2.3, 0, 3.9); R.block(2.0, 3.6, 2.6, 4.2);
  put(S, P.floorLamp().g, 0.6, 0.92, 2.25).scale.setScalar(0.35); live(FX.glow('#ffcf8a', 0.6, 0.5)).position.set(0.6, 1.5, 2.25);
  const pools = [[-2.6, 3.4, '#ffb36b', 1.6, 0.32], [DX, DZ, '#ffb36b', 2.0, 0.3], [2.8, -3.2, '#ff3a22', 1.7, 0.35], [0.5, -3.2, '#ffd8a0', 2.6, 0.18], [0.6, 2.0, '#ffcf8a', 1.8, 0.22]]
    .map(([x, z, c, rr, op]) => { const o = live(P.pool(c, rr, op)); o.position.set(x, 0.012, z); o.renderOrder = -6; o.userData.op = op; return o; });
  // clutter
  for (const [x, z, r] of [[1.2, 3.8, 0.3], [-0.6, -2.2, 1.2], [7.6, 4.1, 2], [3.9, 0.3, 0.8]]) put(S, rbox(0.06, 0.12, 0.06, mat(['#c03030', '#d0d0d0', '#3a8a3a'][Math.floor(x + 9) % 3], { roughness: 0.4 }), 0.025), x, 0.06, z, r);
  const pizzaBox = put(L, rbox(0.5, 0.06, 0.5, mat('#c8a060', { roughness: 0.9 }), 0.02), 7.7, 0.03, 3.3, 0.4); // pizza box (live: hops when checked)
  put(S, rbox(0.7, 0.05, 0.45, mat('#2a4a6a', { roughness: 0.95 }), 0.02), 0.9, 0.025, 2.4, 1.1); // dropped jacket

  R.rig = lightRig(R.root, { room: R, sky: '#9a86b8', ground: '#5a3a2a', ambient: 5.5, moon: '#8fa8ff', moonI: 1.1, moonFrom: [9, 8, 6],
    points: [{ x: -2.4, y: 1.7, z: 4.1, color: '#ffb36b', i: 10, d: 8 }, { x: DX, y: 1.6, z: DZ, color: '#ffb36b', i: 11, d: 8 },
      { x: 2.8, y: 1.3, z: -3.5, color: '#ff3a22', i: 9, d: 6 }, { x: -0.4, y: 2.9, z: -1.6, color: '#ffc890', i: 8, d: 7 }] });

  R.meta = { id: 'hawkins', name: 'Hawkins Living Room', blurb: '80s wood panelling, Christmas lights that spell things, and a crack in the wall.' };
  R.spawn = { x: 0.5, z: 0.5, face: Math.PI };
  const N = Math.PI;
  R.slots = [
    { id: 'hk-sofa1', kind: 'sofa', x: -2.6, z: 1.75, y: 0.08, face: -N / 2, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Plaid sofa' },
    { id: 'hk-sofa2', kind: 'sofa', x: -2.6, z: 2.6, y: 0.08, face: -N / 2, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Plaid sofa' },
    { id: 'hk-sofa3', kind: 'sofa', x: -2.6, z: 3.45, y: 0.08, face: -N / 2, anim: 'Sit_Chair_Idle', prop: 'beer', label: 'Plaid sofa' },
    { id: 'hk-arm', kind: 'chair', x: -4.6, z: 0.45, y: 0.05, face: faceTo(-4.6, 0.4, -6.9, 2.6), anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Recliner' },
    ...cush.map((c, i) => ({ id: 'hk-cush' + i, kind: 'floor', x: c.x, z: c.z, y: 0.14, face: faceTo(c.x, c.z, -6.9, 2.6), anim: 'Sit_Floor_Idle', prop: i ? 'laptop' : 'controller', label: 'Floor cushion' })),
    ...seats.map((s, i) => ({ id: 'hk-dnd' + i, kind: 'chair', x: s.x, z: s.z, face: s.f, anim: 'Sit_Chair_Idle', prop: ['laptop', 'mug', 'laptop', 'laptop'][i], label: 'Campaign table' })),
    { id: 'hk-rift', kind: 'stand', x: 2.6, z: -2.9, face: N, anim: 'Idle', prop: 'phone', label: 'Staring at the crack' },
    { id: 'hk-ottoman', kind: 'stool', x: -0.6, z: 3.4, y: 0.0, face: faceTo(-0.6, 3.4, -2.7, 2.6), anim: 'Sit_Chair_Idle', prop: 'mug', label: 'Ottoman' },
    { id: 'hk-abc', kind: 'stand', x: -0.9, z: -3.0, face: N + 0.2, anim: 'Idle', prop: 'beer', label: 'The lights wall' },
  ];
  R.interact = [
    { id: 'alphabet', x: -0.7, z: -3.3, r: 1.5, label: 'Talk through the lights', kind: 'lights' },
    { id: 'rift', x: 2.8, z: -3.3, r: 1.0, label: 'Touch the crack', kind: 'rift' },
    { id: 'walkie', x: -4.2, z: 1.9, r: 0.9, label: 'Walkie-talkie', kind: 'radio' },
    { id: 'waffles', x: -4.4, z: 3.3, r: 0.9, label: 'Frozen waffles', kind: 'food' },
    { id: 'dnd', x: DX, z: DZ, r: 1.7, label: 'Roll a d20', kind: 'dice' },
    { id: 'phone', x: -2.6, z: 0.6, r: 0.8, label: 'Pick up the phone', kind: 'phone' },
    { id: 'tv', x: -6.1, z: 2.6, r: 1.0, label: 'Watch TV', kind: 'tv' },
    { id: 'bike', x: -7.6, z: -2.4, r: 0.9, label: 'Ring the bike bell', kind: 'bike' },
    { id: 'lamp', x: -2.4, z: 3.9, r: 0.7, label: 'Click the lamp', kind: 'lamp' },
    { id: 'pizza', x: 7.7, z: 3.3, r: 0.8, label: 'Check the pizza box', kind: 'food' },
  ];

  // spelling state: R.hawk.spell('word') blinks bulbs letter by letter; idle it spells RUN / RIGHT HERE now and then
  const ABC = P.LETTERS.join(''), col = new THREE.Color(), hk = { seq: /** @type {number[]} */ ([]), t0: 0, now: 0, next: 12, idle: 0, pulse: -9, flick: 6 + Math.random() * 4, flickT: -9, tvOff: 0, walk: -9, waff: -9 };
  const STEP = 0.75;
  R.hawk = { spell(w) { hk.seq = [...String(w).toUpperCase()].map(c => ABC.indexOf(c)); hk.t0 = hk.now; hk.next = hk.now + hk.seq.length * STEP + 14; return hk.seq.length * STEP; }, ABC, cols: AW.cols, get t() { return hk.now; } };
  const WALKIE = ['*kssht* Do you copy? Over.', '*krrk* ...Mike? Code red. Over.', '*static* Is anybody out there? Over.', '*kssht* Mouth-breathers, over and out.'];
  for (const it of R.interact) it.sfx = false; // each reaction plays its own sounds below
  const snd = (n, x, z, o = {}) => SFX.play(n, { ...o, at: { x: x + R.root.position.x, z: z + R.root.position.z } });
  const later = (ms, f) => setTimeout(f, ms);
  let lampOff = -9; const pk = poker();
  R.onInteract = (id, api) => {
    if (id === 'bike') { api.bubble('*ring ring* Bikes are for the Upside Down.'); pk.poke(basket, 'wiggle', 1.0, 1.4); snd('hawkins.bell', -8.35, -2.9); }
    else if (id === 'lamp') { lampOff = hk.now; snd('ui.click', -2.4, 4.4); later(450, () => snd('ui.click', -2.4, 4.4, { pitch: 1.1 })); snd('hum', -2.4, 4.4, { vol: 0.3, delay: 0.5 }); api.toast('The lamp flickers back on. It always does here.'); }
    else if (id === 'pizza') { pk.poke(pizzaBox, 'lift', 0.8, 0.6); snd('paper', 7.7, 3.3); later(700, () => snd('thud', 7.7, 3.3, { vol: 0.3, pitch: 1.4 })); api.bubble('One slice left. Nobody touches the last slice.'); }
    else if (id === 'walkie') { hk.walk = hk.now; api.bubble(WALKIE[hk.idle++ % WALKIE.length]); snd('radio', -4.2, 2.05); snd('static', -4.2, 2.05, { vol: 0.5, delay: 0.1 }); later(1300, () => snd('blip', -4.2, 2.05, { vol: 0.6 })); }
    else if (id === 'waffles') { hk.waff = hk.now; api.bubble('Eggo?'); snd('pop', -4.35, 3.05); snd('whoosh', -4.35, 3.05, { vol: 0.3, pitch: 1.4, delay: 0.1 }); later(880, () => snd('thud', -4.35, 3.05, { vol: 0.4, pitch: 1.5 })); }
    else if (id === 'rift') { hk.pulse = hk.now; api.toast('It is warm. It breathes. You let go.'); snd('heartbeat', 2.8, -4.2, { vol: 0.7 }); snd('eerie', 2.8, -4.2, { vol: 0.5, delay: 0.2 }); }
    else if (id === 'phone') { hk.pulse = hk.now; api.bubble('...heavy breathing... *click*'); snd('phone.pickup', -2.6, 0.75); snd('wind', -2.6, 0.75, { vol: 0.3, pitch: 0.7, delay: 0.4 }); later(1700, () => snd('ui.click', -2.6, 0.75)); }
    else if (id === 'tv') { hk.tvOff += 2; snd('thud', -6.9, 2.6, { vol: 0.6 }); snd('static', -6.9, 2.6, { delay: 0.12 }); later(500, () => snd('blip', -6.9, 2.6, { vol: 0.5 })); api.toast('*thunk* Still just static. Friends don\'t lie.'); }
    else if (id === 'alphabet') { R.hawk.spell('HI'); snd('hawkins.bulb', 0.3, -4.3); later(750, () => snd('hawkins.bulb', 0.3, -4.3, { pitch: 1.1 })); }
    else if (id === 'dnd') { dice.forEach((d, i) => pk.poke(d, 'roll', 0.8 + i * 0.15)); snd('dice', DX, DZ); api.toast('It\'s the Demogorgon! Roll for initiative.'); }
  };
  R.npc = null;
  R.camera = { zoom: 7, target: new THREE.Vector3(0, 0.8, 0) };
  const pts = R.rig.points, base = [10, 11, 9, 8];
  R.tick = (t, dt) => {
    hk.now = t; pk.tick(t);
    if (t > hk.next) R.hawk.spell(Math.random() < 0.6 ? 'RUN' : 'RIGHT HERE');
    // the house-wide flicker: every 8-14 s all lights stutter together for ~0.7 s
    if (t > hk.flick) { hk.flickT = t; hk.flick = t + 8 + Math.random() * 6; }
    const fu = t - hk.flickT; const fk = fu < 1.2 ? 1 - 0.55 * Math.pow(Math.sin(Math.PI * fu / 0.6), 2) : 1; // two soft dips, no strobe
    const lampF = soft(t, 3, 0.25) * fk * (t - lampOff < 0.5 ? 0.08 : 1), k = t - hk.pulse, pulse = (0.75 + 0.25 * Math.sin(t * 1.3)) * (1 + 2.5 * Math.max(0, 1 - k / 1.5)) * (1 + 0.8 * Math.pow(Math.max(0, Math.sin(t * 0.37)), 12));
    pts[0].intensity = base[0] * lampF; lamp.shade.emissiveIntensity = lampF; lampGlow.material.opacity = 0.4 * lampF;
    pts[1].intensity = base[1] * fk; pools.forEach((o, n) => { o.material.opacity = o.userData.op * (n === 2 ? pulse * 0.8 : n === 0 ? lampF : fk); }); pendGlow.material.opacity = 0.3 * fk;
    pts[2].intensity = base[2] * pulse; riftGlow.material.opacity = 0.3 * pulse; /** @type {any} */ (rift.material).color.setScalar(1.2 * pulse);
    const tf = soft(t, 7, 0.3, 2); pts[3].intensity = base[3] * fk * (0.9 + 0.1 * Math.sin(t * 1.7)); tickRick(t); scr.color.setScalar(0.95 * tf * fk); tvGlow.material.opacity = 0.25 * tf * fk;
    // bulbs
    const i = Math.floor((t - hk.t0) / STEP), on = i < hk.seq.length ? hk.seq[i] : -1;
    for (let b = 0; b < AW.pos.length; b++) { const g = b === on ? 3.5 : (0.35 + 0.08 * Math.sin(t * 0.8 + b)) * (fk < 1 ? 0.3 + 1.6 * (1 - fk) : 1); AW.bulbs.setColorAt(b, col.set(AW.cols[b]).multiplyScalar(g)); }
    if (AW.bulbs.instanceColor) AW.bulbs.instanceColor.needsUpdate = true;
    if (on >= 0) { const p = AW.pos[on]; litGlow.position.set(p.x + 0.3, p.y - 0.04, -4.2); lit2.position.copy(litGlow.position); litGlow.material.color.set(AW.cols[on]); lit2.material.color.set(AW.cols[on]); litGlow.material.opacity = 0.9; lit2.material.opacity = 0.35; }
    else litGlow.material.opacity = lit2.material.opacity = 0;
    // walkie: LED blinks while it talks; waffles: the top one pops up, flips and lands
    { const k = t - hk.walk, on = k < 1.6, a = on ? (1 - k / 1.6) : 0; void a; wLed.scale.setScalar(on ? 1 + 1.2 * Math.sin(Math.PI * k / 1.6) : 1); }
    { const k = t - hk.waff, u = Math.min(1, Math.max(0, k / 0.9)); wTop.position.y = 0.064 + Math.sin(u * Math.PI) * 0.32; wTop.rotation.x = u < 1 ? u * Math.PI * 2 : 0; }
    spores.userData.tick(t); sporesRoom.userData.tick(t); void dt;
  };
  const bx = new THREE.Box3(), sz = new THREE.Vector3(); S.updateMatrixWorld(true);
  S.traverse(o => { if (/** @type {any} */ (o).isMesh) { bx.setFromObject(o).getSize(sz); if (Math.max(sz.x, sz.y, sz.z) < 0.9) o.castShadow = false; } });
  // light realism: TV glow on the rug, rift wash on the partition, lamp wash, moonlight patches under both windows
  softPlanes(L, [[-5.9, 0.024, 2.6, 2.4, 2.0, 'f', '#a8c0ff', 0.18], [2.8, 1.3, -4.21, 2.4, 2.6, 's', '#ff3a22', 0.22], [0.3, 1.6, -4.21, 5.5, 1.6, 's', '#ffd8a0', 0.08],
    [R.w / 2 - 1.1, 0.024, -3.2, 2.0, 1.8, 'f', '#8fa8ff', 0.16], [-2.5, 0.024, R.d / 2 - 1.1, 2.2, 1.8, 'f', '#8fa8ff', 0.16]]);
  R.finish();
  return R;
}
