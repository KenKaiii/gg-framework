// @ts-check
// The Restricted Section: candle-lit wizard library for coders reading docs at 3am. Fully interior: n (screening) and
// w (studio) walls belong to the neighbours, so every tall piece is a free-standing bookcase, hearth or lectern.
// References: the Sorting Hat (E: sorts you into a coder house), the Ring under glass (E: "my precious", you vanish),
// the chained Restricted Section aisle, a golden snitch fluttering under the ceiling.
import * as THREE from 'three';
import { makeRoom, lightRig, mat, glowMat, rbox, put, mesh, rng } from './kit.js';
import * as TX from './tex.js';
import * as FX from './kit-fx.js';
import * as P from './library-props.js';
import { softQuads } from './screening-props.js';
import { SFX } from '../sfx.js';
import { poker } from './screening-poke.js';

const H = Math.PI;

/** @param {any} ctx */
export function build(ctx) {
  const R = makeRoom({ id: 'library', floor: TX.planks('#2e1e16', '#24170f', 61), floorRepeat: 3, wall: TX.panels('#2e1c16', '#22140f'),
    trim: '#3a2418', base: '#140c08' });
  const S = R.static, L = R.live, W2 = R.w / 2, D2 = R.d / 2;
  const add = (o, x, y, z, ry = 0, block = true, pad = 0.05) => { put(S, o, x, y, z, ry); if (block) R.blockObj(o, pad); return o; };
  // rugs
  for (const [x, z, w, d, a, b, c, sd] of [[-5.6, -1.9, 3.2, 2.2, '#3a1a1e', '#5a2a2a', '#9a7a2e', 3], [-1.0, 1.6, 9.4, 2.6, '#1e2440', '#2a3050', '#8a6a3a', 8]]) {
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat('#ffffff', { map: TX.rug('persian', a, b, c, sd) })); rug.rotation.x = -H / 2; rug.position.set(x, 0.01, z); rug.receiveShadow = true; S.add(rug); }

  // --- the stacks (NE): three free-standing double-sided rows running n-s; the middle aisle is the Restricted Section
  const ROWS = [2.6, 4.4, 6.2]; ROWS.forEach((x, i) => add(P.bookcase(2.2, 2.6, i), x, 0, -2.55, H / 2));
  add(P.bookcase(1.6, 2.4, 4), -2.9, 0, -3.5);
  const lad = P.ladder(2.6); put(S, lad, 3.27, 0, -2.0, H / 2); R.block(2.9, -2.3, 3.8, -1.7);
  for (const x of [4.75, 5.85]) add(P.post(), x, 0, -1.25, 0, false);
  R.block(4.6, -1.45, 6.0, -1.05); // the chain bars the aisle
  S.add(P.chain(new THREE.Vector3(4.75, 0.9, -1.25), new THREE.Vector3(5.85, 0.9, -1.25), 14));
  const sign = new THREE.Group();
  put(sign, rbox(0.9, 0.3, 0.03, P.DARK(), 0.02), 0, 0, 0);
  const st = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.24), mat('#ffffff', { map: TX.label('RESTRICTED SECTION', '#e0a458', '#2a140e', 512, 128, 'italic 78px m5x7') }));
  st.position.z = 0.017; sign.add(st); put(S, sign, 5.3, 1.4, -1.22); sign.userData.live = true; // swings on its chains when read
  const pullBook = put(L, rbox(0.18, 0.24, 0.05, mat('#6a1e22', { roughness: 0.7 }), 0.01), 4.56, 1.24, -1.75); // the book you pull
  for (const x of [4.9, 5.7]) S.add(P.chain(new THREE.Vector3(x, 1.55, -1.24), new THREE.Vector3(x + (x < 5.3 ? -0.15 : 0.15), 2.55, -1.24), 8));
  add(P.chainedLectern(), 5.3, 0, -3.1);
  const evil = FX.glow('#3ddc84', 0.9, 0.5); evil.position.set(5.3, 1.25, -3.05); L.add(evil); // the book glows green (Matrix nod)
  // the ring, under glass, behind the stacks
  const rc = P.ringCase(); add(rc.g, 7.2, 0, -3.0); rc.dome.position.set(7.2, 1.0, -3.0); rc.ring.position.set(7.2, 1.09, -3.0); L.add(rc.dome, rc.ring);
  const rglow = FX.glow('#ffcf5a', 0.35, 0.4); rglow.position.set(7.2, 1.1, -3.0); L.add(rglow);

  // --- hearth corner (NW): free-standing fireplace + two wingbacks
  const hr = P.hearth(); add(hr.g, -5.6, 0, -3.45); hr.fire.forEach(f => { f.position.x += -5.6; f.position.z += -3.45; L.add(f); });
  const fglow = FX.glow('#ff9a4a', 1.6, 0.55); fglow.position.set(-5.6, 0.5, -3.2); L.add(fglow);
  const arms = [[-6.75, -2.05, 2.44], [-4.45, -2.05, -2.44]];
  for (const [x, z, f] of arms) add(P.armchair(), x, 0, z, f, true, 0.1);
  put(S, P.stool(0.5), -5.6, 0, -1.6); put(S, rbox(0.3, 0.05, 0.22, mat('#2a3050'), 0.01), -5.6, 0.55, -1.6, 0.3);
  // sorting hat on its stool by the north bookcase
  add(P.stool(0.62), -2.9, 0, -2.55, 0, true, 0.0);
  const hat = P.sortingHat(); hat.g.position.set(-2.9, 0.65, -2.55); hat.g.rotation.y = 0.5; hat.g.userData.live = true; L.add(hat.g);

  // --- study tables (south): long tables, chairs, banker lamps, open books
  const T = [[-4.6, 1.6], [2.6, 1.6]], seats = [];
  T.forEach(([tx, tz], ti) => {
    add(P.studyTable(2.4), tx, 0, tz);
    for (const dx of [-0.6, 0.6]) for (const sd of [-1, 1]) { put(S, P.chair(), tx + dx, 0, tz + sd * 0.68, sd < 0 ? 0 : H); seats.push({ x: tx + dx, z: tz + sd * 0.68, face: sd < 0 ? 0 : H, ti }); }
    put(S, P.bankerLamp(), tx - 1.0, 0.8, tz, 0); put(S, P.bankerLamp(), tx + 1.0, 0.8, tz, H);
    for (const [dx, h] of [[0, 0.3], [0.25, 0.18]]) put(S, rbox(0.22, h, 0.3, mat('#4a2440'), 0.02), tx + dx, 0.8 + h / 2, tz + 0.05, 0.2);
  });
  // books: instanced loose books on tables, floor piles and the mantel
  const r = rng(11), bookSpots = [];
  for (const [tx, tz] of T) for (let i = 0; i < 6; i++) bookSpots.push([tx - 0.8 + r() * 1.6, 0.81 + (i % 3) * 0.05, tz - 0.25 + r() * 0.5]);
  for (const [x, z, n] of [[-7.3, 3.4, 5], [7.4, 3.3, 6], [1.6, -3.6, 4], [-1.6, 3.5, 3], [7.5, -0.4, 0]]) for (let i = 0; i < n; i++) bookSpots.push([x + (r() - 0.5) * 0.06, 0.03 + i * 0.06, z + (r() - 0.5) * 0.06]);
  const cols = ['#5a1e1e', '#2a4a3a', '#6a4a22', '#2a3050', '#4a2440'];
  const books = new THREE.InstancedMesh(new THREE.BoxGeometry(0.26, 0.055, 0.19), mat('#ffffff', { roughness: 0.8 }), bookSpots.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1), c = new THREE.Color();
  bookSpots.forEach(([x, y, z], i) => { e.set(0, r() * 6, 0); q.setFromEuler(e); m4.compose(new THREE.Vector3(x, y, z), q, one); books.setMatrixAt(i, m4); books.setColorAt(i, c.set(cols[i % 5])); });
  books.castShadow = true; L.add(books); for (const [x, z] of [[-7.3, 3.4], [7.4, 3.3]]) R.block(x - 0.25, z - 0.25, x + 0.25, z + 0.25);
  // globe (SW) + a candelabra (SE)
  const gl = P.globe(); add(gl.g, -6.9, 0, 2.9, 0, true, 0.15); gl.ball.position.set(-6.9, 0.95, 2.9); L.add(gl.ball);
  const cand = new THREE.Group(); put(cand, mesh(new THREE.CylinderGeometry(0.15, 0.2, 0.05, 14), P.BRASS()), 0, 0.025, 0);
  put(cand, mesh(new THREE.CylinderGeometry(0.025, 0.03, 1.4, 8), P.BRASS()), 0, 0.72, 0);
  for (const a of [0, 2.09, 4.19]) { put(cand, mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.18, 8), mat('#d8c8a0')), Math.cos(a) * 0.15, 1.5, Math.sin(a) * 0.15); }
  put(cand, mesh(new THREE.TorusGeometry(0.15, 0.015, 6, 20), P.BRASS()), 0, 1.4, 0).rotation.x = H / 2;
  add(cand, 6.4, 0, 3.2);

  // --- floating candles (instanced wax + flames)
  const NC = 34, cpos = [];
  for (let i = 0; i < NC; i++) cpos.push(new THREE.Vector3(-7 + r() * 14, 2.75 + r() * 0.35, -3.2 + r() * 6.6));
  const wax = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.03, 0.032, 0.2, 8), mat('#e6d8b8', { roughness: 0.6, emissive: '#3a2a10' }), NC);
  const flames = new THREE.InstancedMesh(new THREE.SphereGeometry(0.022, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), NC);
  wax.userData.live = flames.userData.live = true; L.add(wax, flames);
  // the snitch
  const sn = P.snitch(); L.add(sn.g); const sglow = FX.glow('#ffd24a', 0.35, 0.5); L.add(sglow);
  // sorting sparkles
  const NS = 40, sp = new Float32Array(NS * 3), sv = [];
  for (let i = 0; i < NS; i++) sv.push(new THREE.Vector3(r() - 0.5, r() * 1.4 + 0.4, r() - 0.5).multiplyScalar(1.6));
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  const spark = new THREE.Points(sg, new THREE.PointsMaterial({ color: '#ffd98a', size: 0.09, map: TX.dotTex(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })); spark.userData.live = true; spark.frustumCulled = false; L.add(spark);
  // warm additive floor pools (no lights) so the planks, rug and stacks read; plus a spot pool under the hat stool
  // one merged static light mesh: candle-glow wash, stacks, hat spot, banker-lamp pools on the tables + floor, hearth pool, candelabra
  softQuads(R, [{ x: -0.6, y: 0.02, z: 0.6, w: 13, h: 7, c: '#ffb36b', a: 0.3 }, { x: 4.8, y: 0.02, z: -1.6, w: 7, h: 5, c: '#ffcf8a', a: 0.26 }, { x: -2.9, y: 0.02, z: -2.4, w: 2.4, h: 2.4, c: '#ffd98a', a: 0.38 },
    ...T.flatMap(([x, z]) => [{ x, y: 0.815, z, w: 2.9, h: 1.3, c: '#ffcf8a', a: 0.28 }, { x, y: 0.022, z, w: 4.2, h: 2.6, c: '#ffb36b', a: 0.14 }]),
    { x: -5.6, y: 0.024, z: -2.5, w: 3.6, h: 2.6, c: '#ff8a3a', a: 0.32 }, { x: 6.4, y: 0.024, z: 3.2, w: 1.8, h: 1.8, c: '#ffcf8a', a: 0.18 }]);
  const hatSpot = FX.glow('#ffd98a', 1.3, 0.45); hatSpot.position.set(-2.9, 1.0, -2.7); L.add(hatSpot);
  L.add(FX.motes(30, new THREE.Vector3(-7, 0.5, -3.5), new THREE.Vector3(7, 2.6, 3.5), '#ffd9a0', 0.035));

  R.rig = lightRig(R.root, { room: R, sky: '#8a74a8', ground: '#6a4434', ambient: 7.5, moonI: 0.9, points: [
    { x: -5.6, y: 0.9, z: -2.7, color: '#ff8a3a', i: 22, d: 9 },
    { x: T[0][0], y: 1.5, z: T[0][1], color: '#ffcf8a', i: 11, d: 6.5 },
    { x: T[1][0], y: 1.5, z: T[1][1], color: '#ffcf8a', i: 11, d: 6.5 },
    { x: 5.3, y: 1.5, z: -2.6, color: '#3ddc84', i: 3.5, d: 3.5 }] });
  R.meta = { id: 'library', name: 'The Restricted Section', blurb: 'Candle-lit stacks for reading docs at 3am. Mind the hat.' };
  R.spawn = { x: -0.6, z: -0.2, face: H * 0.8 };
  R.slots = [
    ...seats.map((s, i) => ({ id: 'lib-table-' + i, kind: 'chair', x: s.x, z: s.z, y: 0.02, face: s.face, anim: 'Sit_Chair_Idle', prop: i % 4 === 3 ? 'mug' : 'laptop', label: s.ti ? 'Study table' : 'Long table' })),
    { id: 'lib-arm-a', kind: 'chair', x: arms[0][0], z: arms[0][1], y: 0.0, face: arms[0][2], anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Wingback by the fire' },
    { id: 'lib-arm-b', kind: 'chair', x: arms[1][0], z: arms[1][1], y: 0.0, face: arms[1][2], anim: 'Sit_Chair_Idle', prop: 'mug', label: 'Wingback by the fire' },
    { id: 'lib-fire-stool', kind: 'stool', x: -5.6, z: -1.6, y: 0.05, face: H, anim: 'Sit_Chair_Idle', label: 'Footstool by the fire' },
    { id: 'lib-browse-a', kind: 'stand', x: 3.5, z: -3.2, face: H / 2, anim: 'Idle', prop: 'phone', label: 'Browsing the stacks' },
    { id: 'lib-browse-b', kind: 'stand', x: 1.9, z: -2.4, face: H / 2, anim: 'Idle', label: 'Browsing the stacks' },
    { id: 'lib-browse-c', kind: 'stand', x: 7.1, z: -1.7, face: -H / 2, anim: 'Idle', prop: 'mug', label: 'Browsing the stacks' },
  ];
  R.interact = [
    { id: 'hat', x: -2.9, z: -2.0, r: 1.1, label: 'Try on the old hat', kind: 'hat' },
    { id: 'ring', x: 7.2, z: -2.3, r: 1.0, label: 'Look at the ring', kind: 'ring', sfx: false },
    { id: 'restricted', x: 5.3, z: -0.8, r: 1.0, label: 'Read the sign', kind: 'sign' },
    { id: 'globe', x: -6.9, z: 2.2, r: 1.0, label: 'Spin the globe', kind: 'globe', sfx: false },
    { id: 'books', x: 4.4, z: -1.7, r: 0.8, label: 'Pull a book', kind: 'book', sfx: false },
    { id: 'fire', x: -5.6, z: -2.4, r: 0.7, label: 'Warm your hands', kind: 'fire', sfx: false },
    { id: 'evil-book', x: 5.3, z: -2.2, r: 0.6, label: 'Touch the glowing book', kind: 'tome', sfx: false },
  ];
  R.npc = null;
  let spin = 0, fireT = -9, evilT = -9, ringT = -9; const pkr = poker();
  const lib = R.lib = { hat, rc, now: 0, sortT: -9, wobble: 0, burst: () => { lib.sortT = lib.now; } };
  R.onInteract = (id, api) => {
    const at = (x, z) => ({ x: x + R.root.position.x, z: z + R.root.position.z });
    if (id === 'restricted') { pkr.poke(sign, 'swing', 1.8, 0.6); api.toast('Restricted. So obviously that is where the good docs are.'); SFX.play('creak', { at: at(5.3, -1.22), vol: 0.4, delay: 0.15 }); }
    else if (id === 'globe') { spin = 9; api.bubble('Somewhere it is 9 to 5. Not here.'); const a = at(-6.9, 2.9); SFX.play('whoosh', { at: a }); for (let i = 0; i < 5; i++) SFX.play('tick', { at: a, vol: 0.4 - i * 0.06, delay: 0.25 + i * i * 0.05 }); }
    else if (id === 'books') { pkr.poke(pullBook, 'pull', 1.6, 1); const a = at(4.4, -2.55); SFX.play('paper', { at: a }); SFX.play('page', { at: a, delay: 0.3 }); api.bubble(['"Regex: A Love Story." Short book.', '"Docs Nobody Read", vol. 3.', '"Vim: How to Exit", 900 pages.'][(lib.bk = (lib.bk ?? -1) + 1) % 3]); }
    else if (id === 'fire') { fireT = lib.now; SFX.play('fire', { at: at(-5.6, -3.2) }); SFX.play('snap', { at: at(-5.6, -3.2), vol: 0.4, delay: 0.4 }); api.bubble('Toasty. The fire crackles approvingly.'); }
    else if (id === 'evil-book') { evilT = lib.now; SFX.play('eerie', { at: at(5.3, -3.05), vol: 0.6 }); SFX.play('zap', { at: at(5.3, -3.05), vol: 0.3, delay: 0.3 }); api.bubble('It whispers: "there is no spoon... only callbacks."'); }
    else if (id === 'hat') { lib.wobble = 2; api.bubble('Hmm... difficult. Very difficult.'); }
    else if (id === 'ring') { ringT = lib.now; api.bubble('One ring to merge them all.'); SFX.play('chime', { at: at(7.2, -3.0), vol: 0.35 }); }
  };
  R.camera = { zoom: 6.5, target: new THREE.Vector3(0, 0.8, 0.3) };

  const v = new THREE.Vector3(), sq = new THREE.Quaternion(), FL = new THREE.Color();
  R.tick = (t, dt) => {
    lib.now = t; pkr.tick(t);
    const fireK = 1 + 0.6 * Math.max(0, Math.sin(Math.min(1, (t - fireT) / 1.8) * Math.PI)), evilK = Math.max(0, Math.sin(Math.min(1, (t - evilT) / 1.8) * Math.PI)), ringK = Math.max(0, Math.sin(Math.min(1, (t - ringT) / 1.6) * Math.PI));
    for (let i = 0; i < NC; i++) { const p = cpos[i]; v.set(p.x, p.y + Math.sin(t * 0.8 + i * 1.7) * 0.05, p.z); m4.compose(v, sq, one); wax.setMatrixAt(i, m4);
      v.y += 0.13; const f = 0.92 + 0.08 * Math.sin(t * 1.9 + i * 2.3); m4.compose(v, sq, one.set(f, 1 + f * 0.6, f)); flames.setMatrixAt(i, m4); one.set(1, 1, 1);
      flames.setColorAt(i, FL.setRGB(1.25 * f, 0.85 * f, 0.4 * f)); }
    wax.instanceMatrix.needsUpdate = flames.instanceMatrix.needsUpdate = true; if (flames.instanceColor) flames.instanceColor.needsUpdate = true;
    hr.fire.forEach((f, i) => { const k = 0.9 + 0.1 * Math.sin(t * (2.2 + i * 0.5) + i * 2); f.scale.set(k * fireK, (0.7 + k * 0.5) * fireK, k * fireK); });
    fglow.material.opacity = (0.46 + 0.06 * Math.sin(t * 1.7)) * (0.6 + 0.4 * fireK); evil.material.opacity = 0.35 + 0.15 * Math.sin(t * 1.3) + 0.5 * evilK; evil.scale.setScalar(1 + 0.8 * evilK);
    // snitch: darting lissajous under the ceiling, wings a blur
    const sx = Math.sin(t * 0.53) * 6.2 + Math.sin(t * 1.9) * 0.6, sy = 2.55 + Math.sin(t * 1.3) * 0.25, sz = Math.sin(t * 0.71 + 1) * 2.6;
    sn.g.position.set(sx, sy, sz); sn.g.rotation.y = Math.atan2(Math.cos(t * 0.53) * 3.3, Math.cos(t * 0.71 + 1) * 1.8) + H / 2; sglow.position.copy(sn.g.position);
    sn.wings.forEach((w, i) => { w.rotation.z = (i ? 1 : -1) * Math.sin(t * 40) * 0.7; });
    rc.ring.rotation.z = t * 0.6; rc.ring.position.y = 1.09 + Math.sin(t * 1.5) * 0.01 + 0.06 * ringK; rglow.material.opacity = 0.32 + 0.1 * Math.sin(t * 1.2) + 0.5 * ringK; rglow.scale.setScalar(1 + 1.5 * ringK);
    spin = Math.max(0, spin - dt * 3); gl.ball.rotation.y += dt * (0.1 + spin);
    lib.wobble = Math.max(0, lib.wobble - dt); hat.g.rotation.z = Math.sin(t * 9) * 0.12 * Math.min(1, lib.wobble); hat.mouth.scale.y = 1 + (lib.wobble > 0 ? Math.abs(Math.sin(t * 14)) * 2.5 : 0);
    const k = t - lib.sortT; spark.material.opacity = k >= 0 && k < 2 ? 1 - k / 2 : 0;
    if (spark.material.opacity > 0) { for (let i = 0; i < NS; i++) { const s = sv[i]; sp[i * 3] = -2.9 + s.x * k; sp[i * 3 + 1] = 0.9 + s.y * k - 0.6 * k * k; sp[i * 3 + 2] = -2.55 + s.z * k; } sg.attributes.position.needsUpdate = true; }
  };
  R.finish();
  return R;
}
