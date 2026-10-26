// @ts-check
// The Screening Room: a small grungy-cozy indie cinema. Tiered rows of worn red velvet seats face a big screen on the
// n wall between heavy red curtains; a brick projector booth (green-tinted glass, Matrix touch) throws a dusty beam;
// candy counter with a glowing popcorn machine and a red pill / blue pill sweet jar (Matrix touch); sticky carpet,
// aisle step lights, film reels, an usher's torch. References: JAWZ shark standee (E), parody poster wall (E),
// popcorn (E). Seats tagged act 'cinema' start act/screening.js (watch parody trailers).
import * as THREE from 'three';
import { makeRoom, lightRig, mat, glowMat, rbox, put, mesh } from './kit.js';
import * as FX from './kit-fx.js';
import * as TX from './tex.js';
import * as P from './screening-props.js';
import { SFX } from '../sfx.js';
import { poker, solidify } from './screening-poke.js';

// the two-note shark theme, low and soft
SFX.define('scr.duhdum', (o, t, p, K) => { K.tone(o, t, { type: 'triangle', f: 82 * p, v: 0.22, a: 0.01, d: 0.22 }); K.tone(o, t + 0.28, { type: 'triangle', f: 87 * p, v: 0.25, a: 0.01, d: 0.3 }); });
// projector reel clatter (a few soft ticks)
SFX.define('scr.reel', (o, t, p, K) => { for (let i = 0; i < 6; i++) K.hiss(o, t + i * 0.055, { ft: 'bandpass', f: 1800 * p, q: 3, v: 0.07, d: 0.025 }); });
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Small looping screen frames for the in-room big screen (the activity draws the real trailers). */
function screenFrames() {
  return [0, 1, 2, 3].map(i => TX.canvasTex('scr-big' + i, 128, 54, (x, w, h) => {
    x.fillStyle = '#0a0c14'; x.fillRect(0, 0, w, h);
    if (i < 2) { x.fillStyle = '#1d4a6a'; x.fillRect(0, 34, w, 20); x.fillStyle = '#9aa4ac'; const fx = 40 + i * 14; x.beginPath(); x.moveTo(fx, 35); x.lineTo(fx + 8, 20); x.lineTo(fx + 12, 35); x.fill(); x.fillStyle = '#cfe6ff'; for (let k = 0; k < 8; k++) x.fillRect((k * 17 + i * 5) % w, 36 + (k % 3) * 5, 6, 1); }
    else { x.fillStyle = '#e0a458'; x.font = '20px m5x7'; x.textAlign = 'center'; x.fillText(i === 2 ? 'NOW SHOWING' : 'PLEASE SILENCE', w / 2, 24); x.font = '14px m5x7'; x.fillStyle = '#d8ccb8'; x.fillText(i === 2 ? 'JAWZ · DEPLOY ON FRIDAY' : 'YOUR PAGERS', w / 2, 40); }
  }, { nearest: true }));
}

/** @param {any} ctx */
export function build(ctx) {
  const floorTex = TX.canvasTex('scr-carpet', 256, 256, (x, w, h) => {
    x.fillStyle = '#3a1418'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) { x.fillStyle = (i + j) % 2 ? '#4a1a20' : '#2e1016'; x.beginPath(); x.arc(i * 32 + 16, j * 32 + 16, 8, 0, 7); x.fill(); x.strokeStyle = '#6a4a2a'; x.lineWidth = 1; x.strokeRect(i * 32 + 4, j * 32 + 4, 24, 24); }
    const r = TX.rand(9); for (let i = 0; i < 26; i++) { x.fillStyle = `rgba(10,4,6,${0.25 + r() * 0.3})`; x.beginPath(); x.ellipse(r() * w, r() * h, 6 + r() * 14, 4 + r() * 9, r() * 3, 0, 7); x.fill(); } // sticky stains
  }, { repeat: true });
  const R = makeRoom({ id: 'screening', floor: floorTex, floorRepeat: 3, wall: TX.plaster('#3a2a34', 13), trim: '#2a1a20', base: '#140c10' });
  const S = R.static, L = R.live, N = Math.PI;
  const live = o => { o.userData.live = true; L.add(o); return o; };

  // --- screen wall: stage, screen, curtains, valance
  const stage = put(S, rbox(8.6, 0.3, 0.9, mat('#2a1612', { roughness: 0.7 }), 0.03), 0, 0.15, -5.45); R.blockObj(stage, 0);
  put(S, rbox(8.6, 0.04, 0.05, mat('#c9a227', { metalness: 0.6, roughness: 0.4 }), 0.01), 0, 0.3, -5.0);
  R.onWall('n', rbox(5.9, 2.65, 0.06, mat('#0c0a10', { roughness: 0.9 }), 0.02), 0, 1.9, 0.03);
  const frames = screenFrames();
  const scrM = new THREE.MeshBasicMaterial({ map: frames[2], toneMapped: false }); scrM.color.setScalar(1.25);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 2.3), scrM); screen.userData.live = true; R.onWall('n', screen, 0, 1.9, 0.07);
  const curt = []; for (const s of [-1, 1]) { curt.push(put(S, P.curtain(1.25, 3.0, s + 3), s * 3.55, 0.05, -5.72)); put(S, P.curtain(0.7, 2.6, s + 7), s * 4.05, 0.45, -5.6).rotation.y = s * 0.3; }
  put(S, P.curtain(8.8, 0.5, 11), 0, 2.7, -5.7);
  const curtFab = curt[1].children[0]; curtFab.userData.live = true; // the right curtain sways when tugged
  put(S, rbox(8.9, 0.08, 0.2, mat('#c9a227', { metalness: 0.6, roughness: 0.4 }), 0.02), 0, 3.12, -5.72);

  // --- parody poster wall (n wall, both sides of the screen) + EXIT neon over the diner opening
  const atlas = TX.canvasTex('scr-poster-atlas', 480, 180, x => { for (let i = 0; i < 4; i++) x.drawImage(P.filmPoster(i).image, i * 120, 0); });
  const posterM = mat('#ffffff', { map: atlas, roughness: 0.6 }), goldM = mat('#c9a227', { metalness: 0.6, roughness: 0.4 });
  [[-6.9, 0], [-5.55, 1], [5.55, 2], [6.9, 3]].forEach(([u, i]) => {
    R.onWall('n', rbox(0.92, 1.32, 0.05, goldM, 0.02), u, 1.85, 0.03);
    const pg = new THREE.PlaneGeometry(0.8, 1.2), uv = pg.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setX(k, (i + uv.getX(k)) / 4);
    R.onWall('n', new THREE.Mesh(pg, posterM), u, 1.85, 0.066); });
  for (const u of [-6.2, 6.2]) R.onWall('n', rbox(0.18, 0.12, 0.1, glowMat('#ffcf8a', 2), 0.03), u, 2.7, 0.06);
  const exit = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.24), new THREE.MeshBasicMaterial({ map: TX.neon('EXIT', '#3ddc84'), toneMapped: false, transparent: true })); exit.userData.live = true; R.onWall('e', exit, 0, 2.9, 0.04);

  // --- tiered seating: 3 rows x 2 blocks of 5, risers step up toward the back, centre aisle to the library
  const ROWS = [{ z: -2.0, y: 0 }, { z: -0.3, y: 0.16 }, { z: 1.4, y: 0.32 }], XS = [1.05, 1.73, 2.41, 3.09, 3.77];
  const riserM = mat('#2a1614', { roughness: 0.8 }), nose = mat('#4a2a1e', { roughness: 0.6 }), stepM = glowMat('#ffb36b', 1.0);
  let seed = 1;
  ROWS.forEach((row, ri) => { for (const s of [-1, 1]) {
    if (row.y) { put(S, rbox(3.4, row.y, 1.2, riserM, 0.02), s * 2.41, row.y / 2, row.z + 0.05); put(S, rbox(3.4, 0.03, 0.06, nose, 0.01), s * 2.41, row.y, row.z - 0.53); }
    for (const x of XS) put(S, P.seat(seed++), s * x, row.y, row.z);
    put(S, rbox(0.1, 0.04, 0.05, stepM, 0.01), s * 0.68, row.y + 0.05, row.z - 0.5); // aisle step light
    put(S, rbox(0.05, 0.04, 0.1, stepM, 0.01), s * 4.2, row.y + 0.05, row.z - 0.3);
    R.block(s * 0.7, row.z - 0.32, s * 4.1, row.z + 0.45); } });
  for (let z = -1.6; z < 3.4; z += 1.2) for (const s of [-1, 1]) put(S, rbox(0.04, 0.012, 0.3, stepM, 0.004), s * 0.55, 0.006, z);

  // --- projector booth (south-west) + beam + motes
  const bo = put(S, P.booth(2.4, 2.4), -6.8, 0, 4.8); R.blockObj(bo, 0);
  const beam = live(FX.beam(new THREE.Vector3(-6.7, 2.15, 3.55), new THREE.Vector3(0, 1.9, -5.85), 0.25, 3.6, '#ffe2b0', 0.13));
  live(FX.motes(70, new THREE.Vector3(-6, 1.4, -5), new THREE.Vector3(0, 2.6, 3.2), '#ffe6c0', 0.04));
  const rl = put(S, P.reels(2), -5.0, 0, 5.3), reel = rl.children.find(c => c.isGroup);
  reel.children[1].material = reel.children[0].material; solidify(reel); // upright reel spins (tin + film = 2 calls)
  put(S, P.reels(5), -4.5, 0, 4.5).scale.setScalar(0.8); R.block(-5.35, 4.2, -4.2, 5.7);

  // --- candy counter (south-east): popcorn machine, red pill / blue pill sweet jars, usher's torch
  const cc = put(S, P.candyCounter(3.4), 5.6, 0, 4.9); R.blockObj(cc, 0);
  const pop = P.popcornMachine(); pop.g.position.set(6.6, 1.075, 4.9); S.add(pop.g);
  const jarM = new THREE.MeshStandardMaterial({ color: '#cfe8e0', transparent: true, opacity: 0.25, roughness: 0.05, depthWrite: false });
  const jars = mesh(mergeGeometries([4.2, 4.55].map(x => new THREE.CylinderGeometry(0.11, 0.11, 0.26, 16).translate(x, 1.21, 4.85))), jarM); jars.userData.live = true; jars.userData.noGround = true; S.add(jars);
  [[4.2, '#d8202a'], [4.55, '#2a5ad8']].forEach(([x, c]) => {
    put(S, mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.13, 14), mat(String(c), { roughness: 0.3 })), Number(x), 1.14, 4.85);
    put(S, mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.04, 16), mat('#2a2228', { metalness: 0.6, roughness: 0.45 })), Number(x), 1.36, 4.85); });
  const torch = new THREE.Group(); put(torch, mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.28, 10), mat('#2a2228', { metalness: 0.6, roughness: 0.45 })), 0, 0, 0).rotation.z = N / 2;
  put(torch, mesh(new THREE.CylinderGeometry(0.05, 0.035, 0.06, 12), mat('#2a2228', { metalness: 0.6, roughness: 0.45 })), -0.16, 0, 0).rotation.z = N / 2;
  const tcone = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.9, 14, 1, true), new THREE.MeshBasicMaterial({ color: '#ffd9a0', transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  tcone.rotation.z = -N / 2; tcone.position.x = -0.64; torch.add(tcone); tcone.userData.live = true; torch.position.set(5.2, 1.115, 4.75); torch.rotation.y = -0.4; S.add(torch);
  const menu = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.5), new THREE.MeshBasicMaterial({ map: TX.label('POPCORN · NACHOS · BEER', '#ffcf8a', '#1a0e10', 512, 96), toneMapped: false }));
  R.onWall('s', menu, -5.6, 2.4, 0.04);

  // --- JAWZ standee (north-east, by the poster wall)
  const shark = P.standee(P.sharkTex(), 1.25, 1.7); shark.position.set(5.9, 0, -3.4); shark.rotation.y = 0.55; live(shark); R.block(5.4, -3.8, 6.4, -3.0);

  // --- clutter: spilled popcorn, cups, a lost shoe
  const cup = mat('#c8202a', { roughness: 0.6 }), corn = mat('#f3d27a', { roughness: 0.9 });
  for (const [x, y, z] of [[1.6, 0.16, -0.75], [-2.7, 0.32, 0.95], [3.3, 0, -2.6], [-1.3, 0, 2.6]]) put(S, mesh(new THREE.CylinderGeometry(0.06, 0.045, 0.16, 10), cup), x, y + 0.08, z);
  const kr = TX.rand(4); for (let i = 0; i < 30; i++) put(S, mesh(new THREE.IcosahedronGeometry(0.03, 0), corn), (kr() - 0.5) * 7, 0.02, -2.6 + kr() * 5.6);

  R.rig = lightRig(R.root, { room: R, sky: '#a07a9a', ground: '#6a3a3a', ambient: 6.5, moon: '#8fa8ff', moonI: 0.5, moonFrom: [6, 9, -4],
    points: [{ x: 0, y: 1.8, z: -3.6, color: '#a8c0ff', i: 10, d: 10 }, { x: 6.4, y: 1.9, z: 4.1, color: '#ffb36b', i: 10, d: 6 },
      { x: -6.4, y: 2.6, z: 2.8, color: '#ffcf8a', i: 7, d: 6 }, { x: 2.5, y: 2.7, z: 0.5, color: '#ff8a6a', i: 9, d: 10 }] });

  // warm wall sconces + additive floor pools (one merged mesh) so carpet, seats and walls read
  const scM = glowMat('#ffcf8a', 2.2), capM = mat('#c9a227', { metalness: 0.6, roughness: 0.4 });
  // light the room the way its sources would: one merged additive floor mesh + one per wall (static, cannot flicker)
  const WARM = '#ff9a50', SCR = '#9fb4ff', floorL = [], wallL = { e: [], s: [], n: [] };
  const sconce = (side, u, wx, wz) => { R.onWall(side, rbox(0.16, 0.26, 0.08, scM, 0.04), u, 2.15, 0.06); R.onWall(side, rbox(0.22, 0.05, 0.12, capM, 0.02), u, 2.3, 0.07);
    floorL.push({ x: wx, z: wz, w: 2.8, h: 2.8, c: WARM, a: 0.16 }); wallL[side].push({ u, y: 2.0, w: 1.5, h: 2.6, c: '#ffb070', a: 0.2 }); };
  for (const u of [-4.2, 4.2]) sconce('e', u, 6.5, u);
  for (const u of [-6.4, -2.2, 2.2, 6.4]) sconce('s', u, -u, 4.5);
  for (const u of [-6.2, 6.2]) wallL.n.push({ u, y: 2.4, w: 2.2, h: 2.4, c: '#ffb070', a: 0.18 });
  for (const x of [-4.7, 4.7]) floorL.push({ x, z: -4.4, w: 3.2, h: 3.2, c: WARM, a: 0.16 });
  for (const [x, z] of [[-2.4, -0.3], [2.4, -0.3], [0, 2.2], [-3.2, 3.2]]) floorL.push({ x, y: 0.35, z, w: 4.2, h: 4.2, c: WARM, a: 0.16 });
  // the projected film lights the room: bright hotspot where the beam lands, soft wash on wall/curtains, spill on stage, floor and seats
  wallL.n.push({ u: 0, y: 1.9, w: 5.6, h: 2.5, c: '#fff2dc', a: 0.42, out: 0.085 }, { u: 0.3, y: 1.85, w: 3.2, h: 1.6, c: '#fff6e8', a: 0.22, out: 0.086 },
    { u: 0, y: 1.9, w: 11, h: 4.6, c: SCR, a: 0.2, out: 0.012 });
  floorL.push({ x: 0, y: 0.315, z: -5.4, w: 8.4, h: 1.4, c: SCR, a: 0.3 }, { x: 0, z: -3.6, w: 9, h: 3.4, c: SCR, a: 0.26 }, { x: 0, z: -1.6, w: 10, h: 2.4, c: SCR, a: 0.12 },
    { x: 0, y: 0.175, z: -0.3, w: 9, h: 1.6, c: SCR, a: 0.08 }, { x: -3.4, z: 1.0, w: 7, h: 2.2, c: '#ffe2b0', a: 0.05, ry: 0.85 },
    { x: -6.7, z: 3.1, w: 2.6, h: 1.8, c: '#ffcf8a', a: 0.22 }, { x: 6.5, z: 3.9, w: 2.4, h: 2.0, c: '#ffb36b', a: 0.24 }, { x: 5.6, y: 1.08, z: 4.9, w: 3.4, h: 0.8, c: '#ffb36b', a: 0.12 });
  P.softQuads(R, floorL); for (const k of ['n', 'e', 's']) P.softQuads(R, wallL[k], 'add', k);

  R.meta = { id: 'screening', name: 'The Screening Room', blurb: 'Sticky-floor indie cinema: red velvet rows, parody trailers, popcorn.' };
  R.spawn = { x: 0, z: 3.4, face: N };
  const seatSlot = (id, ri, s, k, o) => ({ id, kind: 'seat', x: s * XS[k], z: ROWS[ri].z + 0.02, y: ROWS[ri].y, face: N, anim: 'Sit_Chair_Idle', label: 'Cinema seat', ...o });
  const watch = { act: 'cinema', actLabel: 'Watch the film' };
  R.slots = [
    seatSlot('scr-best-l', 1, -1, 0, watch), seatSlot('scr-best-r', 1, 1, 0, watch), seatSlot('scr-best-l2', 1, -1, 1, watch), seatSlot('scr-best-r2', 1, 1, 1, watch),
    seatSlot('scr-f1', 0, -1, 2, { prop: 'laptop' }), seatSlot('scr-f2', 0, 1, 3, { prop: 'laptop' }), seatSlot('scr-f3', 0, 1, 0, { prop: 'laptop' }),
    seatSlot('scr-m1', 1, -1, 4, { prop: 'laptop' }), seatSlot('scr-m2', 1, 1, 3, { prop: 'laptop' }),
    seatSlot('scr-b1', 2, -1, 1, { prop: 'laptop' }), seatSlot('scr-b2', 2, 1, 2, { prop: 'laptop' }), seatSlot('scr-b3', 2, -1, 3, { prop: 'laptop', label: 'Back row' }),
    { id: 'scr-counter1', kind: 'stand', x: 4.6, z: 3.95, face: 0, anim: 'Idle', prop: 'beer', label: 'Candy counter' },
    { id: 'scr-counter2', kind: 'stand', x: 5.6, z: 3.95, face: 0, anim: 'Idle', prop: 'phone', label: 'Candy counter' },
    { id: 'scr-counter3', kind: 'stand', x: 6.5, z: 3.85, face: -0.3, anim: 'Idle', prop: 'cocktail', label: 'Popcorn queue' },
    { id: 'scr-standee', kind: 'stand', x: 5.0, z: -2.3, face: 0.9, anim: 'Idle', prop: 'phone', label: 'Selfie with the shark' },
  ];
  R.interact = [
    { id: 'popcorn', x: 6.3, z: 3.9, r: 1.3, label: 'Grab popcorn', kind: 'popcorn', sfx: false },
    { id: 'standee', x: 5.4, z: -2.5, r: 1.3, label: 'Poke the shark', kind: 'standee', sfx: false },
    { id: 'posters', x: -6.2, z: -4.6, r: 1.5, label: 'Read the posters', kind: 'poster' },
    { id: 'posters-e', x: 6.2, z: -4.6, r: 1.2, label: 'Read the posters', kind: 'poster' },
    { id: 'booth', x: -5.4, z: 3.9, r: 1.0, label: 'Knock on the booth', kind: 'booth-door', sfx: false },
    { id: 'curtain', x: 0, z: -4.5, r: 1.4, label: 'Tug the curtain', kind: 'curtain', sfx: false },
    { id: 'reels', x: -4.7, z: 3.7, r: 0.7, label: 'Spin a film reel', kind: 'reel', sfx: false },
  ];
  const QUOTES = ["You're gonna need a bigger repo.", 'Duh-dum. Duh-dum. Merge conflict.', 'Smile, you son of a... sandbox.'];
  const TAGS = ['JAWZ: just when you thought it was safe to push.', 'DEPLOY ON FRIDAY: the pager rings from inside the house.', 'REPO WARS: a long time ago, on a branch far, far away.', 'THE MERGE: there is no main.'];
  const pkr = poker();
  const st = { t: 0, pop: -9, wob: -9, q: 0, p: 0 };
  const at = (x, z) => ({ x: x + R.root.position.x, z: z + R.root.position.z });
  R.onInteract = (id, api) => {
    if (id === 'popcorn') { st.pop = st.t; api.bubble("Here's popcorn! *pop pop pop*"); const a = at(6.6, 4.9);
      for (let i = 0; i < 7; i++) SFX.play('pop', { at: a, vol: 0.5, delay: 0.05 + i * 0.11 + (i % 3) * 0.03, pitch: 0.8 + (i % 4) * 0.12, jitter: 0.1 }); SFX.play('paper', { at: a, vol: 0.5, delay: 0.95 }); }
    else if (id === 'standee') { st.wob = st.t; api.bubble(QUOTES[st.q++ % QUOTES.length]); const a = at(5.9, -3.4); SFX.play('thud', { at: a, vol: 0.5 }); SFX.play('creak', { at: a, vol: 0.4, delay: 0.1 }); SFX.play('scr.duhdum', { at: a, delay: 0.3 }); }
    else if (id === 'booth') { pkr.poke(reel, 'wheel', 1.4, 1); const a = at(-6.8, 4.8); SFX.play('thud', { at: a, vol: 0.4 }); SFX.play('thud', { at: a, vol: 0.4, delay: 0.18 }); SFX.play('scr.reel', { at: a, delay: 0.5 }); api.bubble('From inside: "Shh! Reel change!"'); }
    else if (id === 'curtain') { pkr.poke(curtFab, 'swing', 1.6, 0.5); SFX.play('swoosh', { at: at(0, -5.6), vol: 0.6 }); api.bubble('Velvet. Dusty velvet.'); }
    else if (id === 'reels') { pkr.poke(reel, 'wheel', 2.2, 3); SFX.play('scr.reel', { at: at(-5.0, 5.3) }); SFX.play('whoosh', { at: at(-5.0, 5.3), vol: 0.4 }); api.toast('The reel spins. Somewhere, a director weeps.'); }
    else if (id === 'posters' || id === 'posters-e') api.toast(TAGS[st.p++ % TAGS.length]);
  };
  R.npc = null;
  R.camera = { zoom: 6.8, target: new THREE.Vector3(0, 0.8, 0.2) };
  const dummy = new THREE.Object3D(), kv = Array.from({ length: 40 }, (_, i) => ({ a: i * 2.4, s: 0.6 + (i * 37 % 10) / 20 }));
  const lampM = /** @type {any} */ (pop.lamp).material;
  R.tick = (t) => {
    st.t = t; pkr.tick(t); const f = 0.97 + 0.03 * Math.sin(t * 2.1); // slow, gentle projector breathing (no strobe)
    const fi = Math.floor(t / 3.2) % 4; scrM.map = frames[fi < 2 ? (Math.floor(t / 1.6) % 2) : fi];
    scrM.color.setScalar(1.25 * f); R.rig.points[0].intensity = 10 * f; beam.material.opacity = 0.11 * f;
    const pf = 0.94 + 0.06 * Math.sin(t * 2.2); R.rig.points[1].intensity = 10 * pf; lampM.color.set('#ffcf8a').multiplyScalar(2.2 * pf);
    const pk = t - st.pop, burst = pk < 1.6;
    kv.forEach((k, i) => { const ph = burst ? pk * k.s * 1.4 : ((t * k.s + i * 0.13) % 1);
      const r = burst ? 0.1 + ph * 0.9 : 0.12 + ph * 0.1, y = burst ? 0.4 + ph * 1.6 - ph * ph * 1.4 : 0.2 + Math.abs(Math.sin(ph * N)) * 0.35;
      dummy.position.set(Math.cos(k.a) * r * (burst ? 1 : 1.5), y, Math.sin(k.a) * r); dummy.scale.setScalar(burst || i < 14 ? 1 : 0); dummy.updateMatrix(); pop.kernels.setMatrixAt(i, dummy.matrix); });
    pop.kernels.instanceMatrix.needsUpdate = true;
    const wk = t - st.wob; shark.rotation.z = wk < 1.2 ? Math.sin(wk * 18) * 0.12 * (1.2 - wk) : 0;
    tcone.material.opacity = 0.1 + 0.03 * Math.sin(t * 0.7);
  };
  const bx = new THREE.Box3(), sz = new THREE.Vector3(); S.updateMatrixWorld(true);
  S.traverse(o => { if (/** @type {any} */ (o).isMesh) { bx.setFromObject(o).getSize(sz); if (Math.max(sz.x, sz.y, sz.z) < 1.2) o.castShadow = false; } });
  R.finish();
  return R;
}
