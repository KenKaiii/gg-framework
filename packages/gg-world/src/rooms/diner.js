// @ts-check
// Jackrabbit Diner: a late-night 50s diner with a dark neon twist. Chrome counter with spinning stools, red vinyl
// booths (one is half a cherry convertible), checkerboard floor, pie case, milkshake mixer, jukebox, a light-up
// TWIST CONTEST floor and, in the corner, a red curtain with a zigzag floor behind it.
// Local frame x -7.5..7.5, z -6..6. w wall (screening's) is NOT ours: free-standing only. s opens to the garage.
import * as THREE from 'three';
import { makeRoom, lightRig, mat, glowMat, put, rbox, mesh } from './kit.js';
import * as FX from './kit-fx.js';
import * as TX from './tex.js';
import * as P from './diner-props.js';
import { softQuads } from './screening-props.js';
import { SFX } from '../sfx.js';
import { poker } from './screening-poke.js';

// low backwards-ish whoosh for the Red Room
SFX.define('din.redroom', (o, t, p, K) => { K.hiss(o, t, { ft: 'bandpass', f: 300 * p, f1: 900 * p, q: 1.2, v: 0.12, a: 0.35, d: 0.3 }); K.tone(o, t + 0.1, { type: 'sine', f: 110 * p, f1: 98 * p, v: 0.12, a: 0.2, d: 0.6 }); });

const H = Math.PI / 2, PI = Math.PI;
/** InstancedMesh from [x,y,z,ry] rows, no shadows. */
function inst(parent, geo, m, rows) {
  const im = new THREE.InstancedMesh(geo, m, rows.length); const o = new THREE.Object3D();
  rows.forEach((r, i) => { o.position.set(r[0], r[1], r[2]); o.rotation.set(0, r[3] || 0, 0); o.updateMatrix(); im.setMatrixAt(i, o.matrix); });
  im.castShadow = false; im.receiveShadow = true; im.userData.live = true; parent.add(im); return im;
}

/** @param {any} ctx */
export function build(ctx) {
  const wallTex = TX.stripes('#3a2434', '#47293e', 21);
  const R = /** @type {any} */ (makeRoom({ id: 'diner', floor: TX.tiles('#17141c', '#7d7568', 8), floorRepeat: 3.2, wall: wallTex, trim: '#8a1f26', base: '#c8ccd4',
    windows: [{ side: 'n', at: 5.9, w: 1.8, h: 1.2, y: 1.2 }, { side: 'e', at: 3.0, w: 1.6, h: 1.1, y: 1.3 }, { side: 'e', at: -4.1, w: 1.6, h: 1.1, y: 1.3 }] }));
  const S = R.static, pkr = poker();
  const st = (o, x, y, z, ry = 0, block = false) => { put(S, o, x, y, z, ry); if (block) R.blockObj(o); return o; };
  // ----- counter + back bar (n side)
  st(P.backBar(7.4), 0.5, 0, -5.6, 0, true);
  st(P.counter(7), 0.5, 0, -3.95, 0, true);
  st(P.shakeMachine(), 1.6, 0.94, -5.55);
  const cof = st(P.coffee(), -1.4, 0.94, -5.55), pot = new THREE.Group(); put(cof, pot, -0.12, 0, 0.1); pot.attach(cof.children[1]); pot.attach(cof.children[1]); pot.userData.live = true; // left pot lifts to pour
  st(P.pieCase(), -2.5, 1.03, -3.95);
  const pieDome = st(P.pieCase(), 3.4, 1.03, -3.95).children[3]; pieDome.userData.live = true; // glass dome lifts
  for (const x of [-2, 0.5, 3]) { const sh = mesh(new THREE.LatheGeometry([[0, 0], [0.12, 0.02], [0.2, 0.2], [0, 0.2]].map(([a, b]) => new THREE.Vector2(a, b)), 14), mat('#2a1d24', { roughness: 0.3, metalness: 0.5 }));
    sh.rotation.x = PI; st(sh, x, 2.55, -3.9); put(S, mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.65, 4), P.CHROME), x, 2.88, -3.9); }
  // ----- stools (instanced, spin a little in tick)
  const STOOL_X = [-2.4, -1.2, 0, 1.2, 2.4, 3.6], SZ = -3.1;
  const stoolTops = inst(R.live, P.stoolTopGeo(), P.VINYL, STOOL_X.map(x => [x, 0.66, SZ]));
  inst(R.live, new THREE.CylinderGeometry(0.035, 0.035, 0.66, 8), P.CHROME, STOOL_X.map(x => [x, 0.33, SZ]));
  inst(R.live, new THREE.CylinderGeometry(0.17, 0.2, 0.04, 16), P.CHROME, STOOL_X.map(x => [x, 0.02, SZ]));
  inst(R.live, new THREE.TorusGeometry(0.2, 0.012, 4, 18).rotateX(H), P.CHROME, STOOL_X.map(x => [x, 0.68, SZ]));
  for (const x of STOOL_X) R.block(x - 0.15, SZ - 0.15, x + 0.15, SZ + 0.15);
  // milkshakes + mugs on the counter
  const shakes = [[-1.8, 1.03, -3.75], [1.0, 1.03, -3.8], [2.6, 1.03, -3.75], [1.75, 0.94, -5.45]];
  inst(R.live, new THREE.LatheGeometry([[0, 0], [0.05, 0], [0.02, 0.03], [0.03, 0.1], [0.06, 0.24], [0, 0.24]].map(([a, b]) => new THREE.Vector2(a, b)), 10), mat('#f0c6d4', { roughness: 0.3 }), shakes);
  inst(R.live, new THREE.SphereGeometry(0.02, 6, 4), mat('#c0101e', { roughness: 0.2 }), shakes.map(s => [s[0], s[1] + 0.28, s[2]]));
  inst(R.live, new THREE.CylinderGeometry(0.045, 0.04, 0.09, 10), mat('#e8e0d0', { roughness: 0.4 }), [[-0.6, 1.075, -3.8], [0.1, 1.075, -3.75], [-2.0, 0.985, -5.5]]);
  // ----- booths along the e wall, the middle one is half a convertible
  const BZ = [-3.0, 4.1], CZ = 1.2, BX = 6.75;
  for (const z of BZ) { st(P.booth(1.3), BX, 0, z, 0); R.block(6.05, z - 1.1, 7.5, z + 1.1); }
  st(P.carSet(1.3), BX, 0, CZ, 0); R.block(5.9, CZ - 2.15, 7.5, CZ + 1.1);
  // ----- dance floor + TWIST CONTEST sign + jukebox (west side, all free-standing)
  const dance = P.danceFloor(4, 3.2); dance.position.set(-4.4, 0.03, 3.5); R.live.add(dance);
  st(rbox(4.1, 0.025, 3.3, P.CHROME, 0.01), -4.4, 0, 3.5);
  st(P.signStand('TWIST CONTEST', '#ff4fd8', 2.4, 2.5), -4.4, 0, 1.75); R.block(-5.7, 1.6, -5.5, 1.9); R.block(-3.3, 1.6, -3.1, 1.9);
  const twist = P.neonSign('TWIST CONTEST', '#ff4fd8', 2.4); put(R.live, twist, -4.4, 2.2, 1.78); twist.userData.live = true;
  st(P.jukebox(), -7.0, 0, 4.0, H, true);
  const jbGlow = FX.glow('#ff9a5a', 1.6, 0.45); put(R.live, jbGlow, -6.6, 1.1, 4.0);
  // ----- Red Room curtain in the nw corner, flanked by a lamp and a chair nobody sits on
  st(P.redRoom(), -6.0, 0, -5.78, 0, true);
  const redGlow = FX.glow('#ff2a3a', 1.8, 0.35); put(R.live, redGlow, -6.0, 1.2, -5.4);
  const zigLamp = mesh(new THREE.LatheGeometry([[0, 0], [0.15, 0], [0.2, 0.3], [0, 0.3]].map(([a, b]) => new THREE.Vector2(a, b)), 12), glowMat('#ffcf8a', 1.1));
  { // the Red Room chair: red velvet seat, black lacquer frame, angled to face the room
    const ch = new THREE.Group(), lac = mat('#120c0e', { roughness: 0.35 }), vel = mat('#7a1020', { roughness: 0.9 });
    for (const [x, z] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) put(ch, rbox(0.05, 0.44, 0.05, lac, 0.01), x, 0.22, z);
    put(ch, rbox(0.5, 0.08, 0.5, vel, 0.03), 0, 0.48, 0); put(ch, rbox(0.5, 0.6, 0.07, lac, 0.02), 0, 0.82, -0.23); put(ch, rbox(0.4, 0.46, 0.03, vel, 0.01), 0, 0.82, -0.19);
    st(ch, -4.85, 0, -5.2, 0.35, true);
  }
  st(zigLamp, -7.05, 1.3, -5.45); st(mesh(new THREE.CylinderGeometry(0.02, 0.1, 1.3, 8), P.DARK), -7.05, 0.65, -5.45);
  // ----- neon on the n wall + a tiny white rabbit
  const neonRow = [['JACKRABBIT', '#ff4fd8', 3.2, 0.5, 2.6], ['EAT', '#ff6b3a', 2.0, 4.4, 2.55], ['PIE', '#ffcf8a', 1.8, -2.4, 2.6]];
  const neons = neonRow.map(([t, c, w, u, y]) => R.onWall('n', P.neonSign(t, c, w), u, y, 0.03));
  const rab = P.neonSign('follow the white rabbit', '#e8f4ff', 0.7); R.onWall('n', rab, -4.4, 1.4, 0.03);
  // light where the sources are (static merged soft quads, cannot flicker): neon washes on the n wall, booth lamp pools,
  // moonlight patches under the windows, counter + dance floor + jukebox spill
  softQuads(R, [{ u: 0.5, y: 2.6, w: 4.6, h: 1.9, c: '#ff4fd8', a: 0.3 }, { u: 4.4, y: 2.55, w: 2.8, h: 1.4, c: '#ff6b3a', a: 0.26 }, { u: -2.4, y: 2.6, w: 2.6, h: 1.4, c: '#ffcf8a', a: 0.22 },
    { u: -4.4, y: 1.4, w: 1.4, h: 0.8, c: '#e8f4ff', a: 0.14 }, { u: 5.9, y: 1.8, w: 2.6, h: 2.2, c: '#8fa8ff', a: 0.08 }], 'add', 'n');
  softQuads(R, [...[...BZ, CZ].flatMap(z => [{ x: BX - 0.2, y: 0.77, z, w: 1.3, h: 1.6, c: '#ffb36b', a: 0.22 }, { x: BX - 0.6, z, w: 2.6, h: 2.8, c: '#ffb36b', a: 0.16 }]),
    { x: 5.9, z: -4.9, w: 2.0, h: 1.8, c: '#8fa8ff', a: 0.14 }, { x: 6.0, z: 3.0, w: 1.8, h: 2.0, c: '#8fa8ff', a: 0.08 }, { x: 6.0, z: -4.1, w: 1.8, h: 2.0, c: '#8fa8ff', a: 0.08 },
    { x: 0.5, z: -2.9, w: 7.5, h: 2.0, c: '#ffb36b', a: 0.14 }, { x: 0.5, y: 1.04, z: -3.95, w: 7.4, h: 0.9, c: '#ffb36b', a: 0.1 },
    { x: -4.4, z: 3.5, w: 5.4, h: 4.4, c: '#ff4fd8', a: 0.1 }, { x: -6.4, z: 4.0, w: 2.0, h: 2.2, c: '#ff9a5a', a: 0.2 }, { x: -6.0, z: -4.9, w: 2.2, h: 1.6, c: '#ff2a3a', a: 0.14 }]);
  // ----- lights
  R.rig = lightRig(R.root, { room: R, sky: '#5a4c9a', ground: '#2a1830', ambient: 3.8, moon: '#8fa8ff', moonI: 0.6, moonFrom: [8, 9, -6], points: [
    { x: 0.5, y: 2.3, z: -3.6, color: '#ffb36b', i: 14, d: 9 },
    { x: 5.9, y: 2.0, z: 0.5, color: '#ff8a6a', i: 10, d: 8 },
    { x: -4.4, y: 2.0, z: 3.4, color: '#ff4fd8', i: 9, d: 7 },
    { x: -6.0, y: 1.6, z: -4.6, color: '#ff2a3a', i: 3, d: 3.5 }] });
  R.meta = { id: 'diner', name: 'Jackrabbit Diner', blurb: 'Retro all-night diner: $5 shakes, cherry pie, a twist contest and a curtain you should not open.' };
  R.spawn = { x: -5.4, z: -0.2, face: H };
  const lap = i => (i % 2 ? 'cocktail' : 'laptop');
  R.slots = [
    ...STOOL_X.map((x, i) => ({ id: 'stool-' + i, kind: 'stool', x, z: SZ, y: 0.24, face: PI, anim: 'Sit_Chair_Idle', prop: i === 5 ? 'mug' : lap(i), label: 'Counter stool' })),
    ...BZ.flatMap((z, i) => [
      { id: `booth${i}-n`, kind: 'booth', x: 6.6, z: z - 0.68, face: 0, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Red vinyl booth' },
      { id: `booth${i}-s`, kind: 'booth', x: 6.6, z: z + 0.68, face: PI, anim: 'Sit_Chair_Idle', prop: i ? 'cocktail' : 'laptop', label: 'Red vinyl booth' }]),
    { id: 'car-front', kind: 'booth', x: 6.6, z: CZ - 0.72, y: 0.08, face: 0, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Convertible booth' },
    { id: 'car-back', kind: 'booth', x: 6.6, z: CZ + 0.68, face: PI, anim: 'Sit_Chair_Idle', prop: 'cocktail', label: 'Convertible booth' },
    { id: 'jukebox', kind: 'stand', x: -6.1, z: 4.0, face: -H, anim: 'Idle', prop: 'phone', label: 'Picking a song' },
    { id: 'dance', kind: 'stand', x: -3.4, z: 4.2, face: -0.9, anim: 'Idle', prop: 'cocktail', label: 'Waiting for the twist contest' },
    { id: 'red-chair', kind: 'chair', x: -4.85, z: -5.2, face: 0.35, anim: 'Sit_Chair_Idle', label: 'The Red Room chair' },
    { id: 'counter-end', kind: 'stand', x: 4.7, z: -3.4, face: -2.3, anim: 'Idle', prop: 'mug', label: 'Leaning on the counter end' }];
  R.interact = [
    { id: 'shake', x: 1.6, z: -3.2, r: 1.1, label: 'Order the $5 shake', kind: 'counter' },
    { id: 'pie', x: -2.5, z: -3.2, r: 1.0, label: 'Cherry pie + black coffee', kind: 'counter' },
    { id: 'twist', x: -4.4, z: 3.5, r: 1.8, label: 'Enter the twist contest', kind: 'dance' },
    { id: 'jukebox', x: -6.3, z: 4.0, r: 0.9, label: 'Play the jukebox', kind: 'jukebox', sfx: false },
    { id: 'curtain', x: -6.0, z: -4.9, r: 1.0, label: 'Peek behind the red curtain', kind: 'curtain', sfx: false },
    { id: 'pie-e', x: 3.4, z: -3.2, r: 0.6, label: 'Eye the pie case', kind: 'pie-case', sfx: false },
    { id: 'coffee', x: -1.0, z: -3.25, r: 0.5, label: 'Ask for a refill', kind: 'coffee', sfx: false }];
  R.npc = null;
  R.camera = { zoom: 6.5, target: new THREE.Vector3(0, 0.8, 0) };
  let now = 0, scareUntil = -1, songUntil = -1, si = 0, ci = 0;
  const SONGS = ['Now spinning: a surf-rock guitar track. Everyone wants to twist.', 'Now spinning: a slow doo-wop number. The neon hums along.', 'Now spinning: something that sounds backwards.'];
  const CURT = ['The floor goes zig. Then zag. Someone in there talks backwards.', 'A voice: "This is the water... and this is the well."', 'You blink. The curtain is closed. Was it ever open?'];
  R.onInteract = (id, api) => {
    const at = (x, z) => ({ x: x + R.root.position.x, z: z + R.root.position.z });
    if (id === 'jukebox') { songUntil = now + 20; api.toast(SONGS[si++ % SONGS.length]); const a = at(-7.0, 4.0); SFX.play('arcade.coin', { at: a, vol: 0.5 }); SFX.play('vinyl', { at: a, delay: 0.3 }); SFX.play('chord', { at: a, delay: 0.9, pitch: [1, 0.84, 0.75][(si - 1) % 3] }); }
    else if (id === 'curtain') { scareUntil = now + 1.6; api.bubble(CURT[ci++ % CURT.length]); const a = at(-6.0, -5.6); SFX.play('swoosh', { at: a, vol: 0.6 }); SFX.play('din.redroom', { at: a, delay: 0.15 }); SFX.play('eerie', { at: a, vol: 0.5, delay: 0.5 }); }
    else if (id === 'pie-e') { pkr.poke(pieDome, 'lift', 1.1, 0.7); SFX.play('glass', { at: at(3.4, -3.95), vol: 0.4 }); api.bubble('Cherry. Always cherry.'); }
    else if (id === 'coffee') { pkr.poke(pot, 'tip', 1.2, -1.2); const a = at(-1.4, -4.2); SFX.play('pour', { at: a }); SFX.play('glass', { at: a, vol: 0.4, delay: 0.7 }); api.bubble('Damn fine refill. On the house.'); }
  };
  R.finish();
  const big = new Set([P.VINYL, P.VINYL_D]);
  R.static.traverse(o => { if (o.isMesh) o.castShadow = big.has(o.material); });
  const L = R.rig.points, base = L.map(p => p.intensity);
  R.tick = (t, dt) => {
    now = t; pkr.tick(t); const song = t < songUntil, scare = t < scareUntil;
    const beat = song ? 0.5 + 0.4 * Math.sin(t * 4.2) : 0.5 + 0.2 * Math.sin(t * 1.5); // smooth, >= 1.5 s period
    dance.material.opacity = 0.55 + 0.4 * beat; dance.material.map.offset.x = song ? Math.floor(t / 1.5) * 0.25 : 0;
    jbGlow.material.opacity = 0.3 + 0.25 * beat; L[2].intensity = base[2] * (0.7 + 0.5 * beat);
    twist.material.opacity = 0.85 + 0.15 * Math.sin(t * 1.3); // slow neon breathing, no on/off
    neons.forEach((n, i) => { n.material.opacity = 0.9 + 0.1 * Math.sin(t * (0.8 + i * 0.23) + i * 2); });
    L[3].intensity = scare ? base[3] * (3.2 + 2.6 * Math.sin(t * 4.2)) : base[3] * (0.85 + 0.15 * Math.sin(t * 1.1));
    redGlow.material.opacity = scare ? 0.9 : 0.3;
    L[1].intensity = scare ? base[1] * 0.2 : base[1];
    
  };
  return R;
}
