// @ts-check
// The Roof: an apartment rooftop at night, the not-gaming chill spot. Low parapet over the suburb (outside.js),
// stairwell hut (door to The Terminal), festoon lights, oil-drum fire, hammock, telescope, green server exhaust.
import { SFX } from '../sfx.js';
import { roomGlow, liveProp } from './bar-glow.js';
import * as THREE from 'three';
import { makeRoom, lightRig, mat, glowMat, rbox, put, mesh, bake } from './kit.js';
import * as FX from './kit-fx.js';
import * as TX from './tex.js';
import * as P from './roof-props.js';
import { clutter } from './roof-clutter.js';
import { gravel, stucco } from './roof-sky.js';
import * as Z from './roof-zones.js';
import { roomInfo } from './floorplan.js';

const FACTS = [
  'The light from the moon left it 1.3 seconds ago. Your last deploy took longer.',
  'Betelgeuse is so big it would swallow Jupiter\'s orbit.',
  'There are more stars in the universe than grains of sand on every beach on Earth.',
  'A day on Venus is longer than its year. Like a Friday deploy.',
  'Neutron stars spin up to 700 times a second. Faster than your fans right now.',
];

/** @param {any} ctx */
export function build(ctx) {
  const DOOR_X = -6, stairs = roomInfo('roof').stairs[0];
  const R = makeRoom({ id: 'roof', h: 1.1, floor: gravel(), floorRepeat: 3, wall: stucco(), trim: '#4a3a40', base: '#1a141c', slab: '#16111c',
    doors: [{ side: 'n', at: DOOR_X, to: stairs.to, label: stairs.label, glow: '#3ddc84' }] });
  const W = R.w, D = R.d, S = R.static, L = R.live, big = new Set();
  const cast = o => { big.add(o); return o; };
  const cyl = (rt, rb, h, m, n = 12) => mesh(new THREE.CylinderGeometry(rt, rb, h, n), m);

  // stairwell hut behind the north parapet (the kit door frame is its doorway), stairs going down inside
  const hutM = mat('#ffffff', { map: stucco() }), hx0 = DOOR_X - 1.4, hx1 = DOOR_X + 2.5, HH = 3.0, dz = -D / 2;
  const hut = cast(put(S, new THREE.Group()));
  put(hut, rbox(hx1 - hx0, HH, 1.6, hutM, 0.03), (hx0 + hx1) / 2, HH / 2, dz - 0.25 - 0.8);
  const front = (x0, x1, y0, y1) => put(hut, rbox(x1 - x0, y1 - y0, 0.12, hutM, 0.01), (x0 + x1) / 2, (y0 + y1) / 2, dz - 0.06);
  front(hx0, DOOR_X - 0.6, 1.1, HH); front(DOOR_X + 0.6, hx1, 1.1, HH); front(DOOR_X - 0.6, DOOR_X + 0.6, 2.35, HH);
  { // corrugated metal roof sloping back, with a drip edge, corner trim boards, a meter box and stickers by the door
    const RW = hx1 - hx0 + 0.3, RD = 2.0, cg = new THREE.PlaneGeometry(RW, RD, 64, 1), cp = cg.attributes.position;
    for (let i = 0; i < cp.count; i++) cp.setZ(i, Math.sin(cp.getX(i) * 40) * 0.018);
    cg.rotateX(-Math.PI / 2 + 0.08); cg.computeVertexNormals();
    const tin = mat('#5a5048', { metalness: 0.3, roughness: 0.7, side: THREE.DoubleSide });
    put(hut, mesh(cg, tin), (hx0 + hx1) / 2, HH + 0.08, dz - 0.9);
    put(hut, rbox(RW, 0.06, 0.06, mat('#5a5e64', { metalness: 0.5, roughness: 0.5 }), 0.02), (hx0 + hx1) / 2, HH + 0.13, dz + 0.1); // drip edge
    const trim = mat('#d8cfc0', { roughness: 0.8 });
    for (const x of [hx0 + 0.04, hx1 - 0.04]) put(hut, rbox(0.1, HH, 0.06, trim, 0.015), x, HH / 2, dz - 0.03);
    put(hut, rbox(hx1 - hx0, 0.1, 0.06, trim, 0.015), (hx0 + hx1) / 2, HH - 0.05, dz - 0.03);
    for (const [x, y] of [[DOOR_X - 0.62, 1.2], [DOOR_X + 0.62, 1.2]]) put(hut, rbox(0.08, 2.4, 0.08, trim, 0.02), x, y, dz + 0.0); // door casing
    put(hut, rbox(1.32, 0.1, 0.08, trim, 0.02), DOOR_X, 2.4, dz);
    put(hut, rbox(0.3, 0.42, 0.14, mat('#6a6e74', { metalness: 0.4, roughness: 0.6 }), 0.03), DOOR_X - 1.05, 1.4, dz + 0.07); // meter box
    put(hut, cyl(0.06, 0.06, 0.02, mat('#d8e0e8', { roughness: 0.2 }), 14).rotateX(Math.PI / 2), DOOR_X - 1.05, 1.45, dz + 0.15);
    put(hut, cyl(0.02, 0.02, 1.4, mat('#4a4e54', { metalness: 0.5 }), 6), DOOR_X - 1.05, 0.5, dz + 0.04); // conduit down
    const stk = [['#ff4fd8', 0.16, 0.1], ['#3ddc84', 0.12, 0.12], ['#ffe14f', 0.14, 0.08], ['#4fa8ff', 0.1, 0.1]];
    stk.forEach(([c, w, h], i) => put(hut, rbox(/** @type {number} */ (w), /** @type {number} */ (h), 0.004, mat(/** @type {string} */ (c), { roughness: 0.6 }), 0.001), DOOR_X - 0.88 + (i % 2) * 0.15, 0.62 + i * 0.11, dz + 0.005, 0).rotation.z = (i - 1.5) * 0.25);
  }
  for (let i = 0; i < 4; i++) put(S, rbox(1.0, 0.06, 0.26, mat('#2a2230'), 0.01), DOOR_X, -0.1 - i * 0.18, dz - 0.25 - i * 0.26);
  const spray = mesh(new THREE.PlaneGeometry(1.75, 1.2), new THREE.MeshBasicMaterial({ map: sprayTex(), transparent: true, depthWrite: false, color: '#e8d8e8' }));
  spray.position.set(DOOR_X + 1.55, 1.85, dz + 0.005); spray.rotation.z = 0.03; L.add(spray);
  put(S, rbox(0.22, 0.12, 0.14, mat('#2a2a30'), 0.03), DOOR_X, 2.55, dz + 0.05);
  put(S, rbox(0.14, 0.06, 0.08, glowMat('#ffcf8a', 3), 0.02), DOOR_X, 2.48, dz + 0.1);
  const lg = FX.glow('#ffb36b', 1.0, 0.5); lg.position.set(DOOR_X, 2.48, dz + 0.2); L.add(lg);

  // zone 1: fire-pit circle on the pallet deck
  const FX0 = -1, FZ = -0.3;
  const dr = P.drum(); put(S, cast(dr.g), FX0, 0, FZ); dr.g.remove(dr.fire); dr.fire.position.set(FX0, 0.7, FZ); L.add(dr.fire); dr.fire.name = 'rx-fire'; R.block(FX0 - 0.35, FZ - 0.35, FX0 + 0.35, FZ + 0.35);
  R.blockObj(put(S, cast(P.sofa(2.2)), FX0, 0, FZ - 1.75));
  const seat = (o, x, z, ry) => { R.blockObj(put(S, o, x, 0, z, ry), 0.12); };
  seat(P.chair('#2d4a5a'), FX0 + 1.75, FZ, -Math.PI / 2);
  seat(P.chair('#6a4a2a'), FX0, FZ + 1.75, Math.PI);
  seat(P.officeChair(), FX0 - 1.75, FZ + 0.2, Math.PI / 2 - 0.2);
  seat(Z.crate(), FX0 - 1.3, FZ + 1.3, 2.36); seat(Z.crate(), FX0 + 1.3, FZ + 1.3, -2.36);
  put(S, rbox(0.4, 0.05, 0.4, mat('#8a6a3a', { roughness: 1 }), 0.01), FX0 + 0.9, 0.09, FZ - 0.9, 0.4); // pizza box

  // zone 2: deck lounge (loungers, beanbags, hammock) in the south-west
  seat(Z.deckChair('#7a3e34'), -8.4, 2.4, 0); seat(Z.deckChair('#2d4a5a'), -7.2, 2.4, 0);
  seat(Z.beanbag('#4a2a5a'), -4.9, 3.4, 0.4); seat(Z.beanbag('#2a3a5a'), -3.7, 4.7, -0.6);
  { const hm = P.hammock(2.6); liveProp(hm, 'rx-hammock'); put(L, hm, -6.6, 0, 5.7); } R.block(-8.0, 5.4, -5.2, 6.0);
  R.blockObj(put(S, Z.crate(), -7.8, 0, 3.6, 0.3));

  // zone 3: bar cart + cooler + grill (standing group)
  const cart = Z.barCart(); R.blockObj(put(S, cart.g, 5.5, 0, -2.2));
  R.blockObj(put(S, P.cooler(), 7.0, 0, -2.3, -0.2));
  R.blockObj(put(S, P.grill(), 8.6, 0, -0.4));

  // zone 4: parapet row, telescope, vent + dish in the north-east
  R.blockObj(put(S, P.telescope(), -2.8, 0, -6.0), 0.1);
  const v = P.vent(); put(S, v.g, 8.3, 0, -6.2); for (const f of v.fans) { v.g.remove(f); f.position.add(new THREE.Vector3(8.3, 0, -6.2)); L.add(f); } R.block(7.8, -6.5, 8.8, -5.9);
  const vg = FX.glow('#3ddc84', 1.6, 0.35); vg.position.set(8.3, 0.6, -5.7); L.add(vg);
  R.blockObj(put(S, cast(P.dish()), 6.4, 0, -6.3, -0.6));

  // zone 5: garden corner in the south-east
  for (const p of [put(S, Z.planter(2.6, 3), 6.6, 0, 6.35), put(S, Z.planter(2.0, 7), 9.35, 0, 4.0, Math.PI / 2)]) { p.userData.ground = { k: 1.6, pad: 0.1 }; R.blockObj(p); }
  seat(Z.bench(1.4), 6.6, 4.6, 0);
  [[-9.4, -3.5], [-9.4, 0.6], [4.0, 6.5], [9.4, -2.6], [2.0, -6.4], [-9.4, 4.4]].forEach(([x, z], i) => R.blockObj(put(S, P.bucketPlant(i + 3), x, 0, z, i)));
  clutter(S, L, R, FX0, FZ);

  // festoon string lights on corner poles + the hut
  const tops = { ne: new THREE.Vector3(9.5, 2.9, -6.6), se: new THREE.Vector3(9.5, 2.9, 6.6), sw: new THREE.Vector3(-9.5, 2.9, 6.6), nw: new THREE.Vector3(-9.5, 2.9, -6.6), hut: new THREE.Vector3(hx1, HH, dz - 0.05) };
  for (const k of ['ne', 'se', 'sw', 'nw']) { const t = tops[k]; put(S, cast(P.pole(t.y)), t.x, 0, t.z); R.block(t.x - 0.15, t.z - 0.15, t.x + 0.15, t.z + 0.15); }
  const bulbs = festoon(S, L, [[tops.hut, tops.ne], [tops.ne, tops.se], [tops.sw, tops.se], [tops.nw, tops.sw], [tops.ne, tops.sw]]);
  // only big pieces cast shadows
  S.traverse(o => { if (o.isMesh) { let p = o, c = false; while (p && !c) { c = big.has(p); p = p.parent; } o.castShadow = c; } });

  // sparks + smoke
  const N = 18, sp = new Float32Array(N * 3), sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  const sparks = new THREE.Points(sg, new THREE.PointsMaterial({ color: '#ffb347', size: 0.06, map: TX.dotTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); sparks.userData.live = true; L.add(sparks);
  const fg = FX.glow('#ff8a3a', 2.2, 0.5); fg.position.set(FX0, 1.0, FZ); L.add(fg);
  const smoke = FX.steam(new THREE.Vector3(FX0, 1.2, FZ), '#6a5a70', 6, 1.4); L.add(smoke);

  R.rig = lightRig(R.root, { room: R, sky: '#3a4374', ground: '#1c1424', ambient: 2.2, moonI: 1.2, moonFrom: [-8, 12, -10], points: [
    { x: FX0, y: 1.3, z: FZ, color: '#ff8a3a', i: 10, d: 7 },
    { x: 0, y: 3.0, z: 0.5, color: '#ffcf8a', i: 16, d: 16 },
    { x: 6.0, y: 1.5, z: -2.0, color: '#ffb36b', i: 5, d: 6 },
    { x: DOOR_X, y: 2.3, z: dz + 0.6, color: '#ffb36b', i: 4, d: 6 }] });
  R.meta = { id: 'roof', name: 'The Roof', blurb: 'Fire drum, string lights, cold beers and the whole street below. No laptops required (but welcome).' };
  R.spawn = { x: DOOR_X, z: dz + 1.0, face: 0 };
  const sit = (id, kind, x, z, face, prop, label, y) => ({ id: 'roof-' + id, kind, x, z, ...(y ? { y } : {}), face, anim: 'Sit_Chair_Idle', prop, label });
  const stand = (id, x, z, face, prop, label) => ({ id: 'roof-' + id, kind: 'stand', x, z, face, anim: 'Idle', prop, label });
  R.slots = [
    sit('sofa-l', 'sofa', FX0 - 0.5, FZ - 1.65, 0, 'laptop', 'Sofa by the fire'), sit('sofa-r', 'sofa', FX0 + 0.5, FZ - 1.65, 0, 'laptop', 'Sofa by the fire'),
    sit('chair-e', 'chair', FX0 + 1.75, FZ, -Math.PI / 2, 'beer', 'Camp chair'), sit('chair-s', 'chair', FX0, FZ + 1.75, Math.PI, 'laptop', 'Rusty chair'),
    sit('office', 'chair', FX0 - 1.75, FZ + 0.2, Math.PI / 2 - 0.2, 'laptop', 'Dragged-up office chair'),
    sit('crate-sw', 'crate', FX0 - 1.3, FZ + 1.3, 2.36, 'beer', 'Crate by the fire', -0.09), sit('crate-se', 'crate', FX0 + 1.3, FZ + 1.3, -2.36, 'laptop', 'Crate by the fire', -0.09),
    sit('deck-a', 'lounger', -8.4, 2.5, 0, 'laptop', 'Deck lounger', -0.1), sit('deck-b', 'lounger', -7.2, 2.5, 0, 'cocktail', 'Deck lounger', -0.1),
    sit('bean-a', 'beanbag', -4.9, 3.45, 0.4, 'laptop', 'Beanbag', -0.17), sit('bean-b', 'beanbag', -3.7, 4.75, -0.6, 'laptop', 'Beanbag', -0.17),
    { id: 'roof-hammock', kind: 'hammock', x: -6.6, z: 5.7, y: 0.5, face: Math.PI, anim: 'Sit_Floor_Idle', prop: 'phone', label: 'Hammock' },
    stand('cart-a', 5.1, -1.3, Math.PI - 0.3, 'beer', 'At the bar cart'), stand('cart-b', 6.3, -1.2, Math.PI + 0.4, 'cocktail', 'At the bar cart'),
    stand('para-a', 0.6, -6.25, Math.PI, 'beer', 'Leaning on the parapet'), stand('para-b', 1.7, -6.25, Math.PI, 'phone', 'Leaning on the parapet'), stand('para-c', 3.4, -6.25, Math.PI, 'beer', 'Leaning on the parapet'),
    sit('bench', 'bench', 6.6, 4.6, 0, 'laptop', 'Garden bench'),
  ];
  R.interact = [{ id: 'telescope', x: -2.8, z: -6.0, r: 1.0, label: 'Look up', kind: 'telescope' }, { id: 'cooler', x: 7.0, z: -2.3, r: 0.9, label: 'Grab a beer', kind: 'cooler' }];
  let fi = 0;
  R.onInteract = (id, api) => { if (id === 'telescope') api.bubble(FACTS[fi++ % FACTS.length]); else if (id === 'cooler') api.toast('Cold one acquired. +0 XP, +1 vibe.'); };
  // reaction sounds, timed to the animations (the default keyword guess is silenced for these)
  /** @type {Record<string, () => void>} */
  const RSND = {
    cooler: (at) => { SFX.play('can', { at }); SFX.play('fizz', { at, vol: 0.4, delay: 0.3 }); },
  };
  for (const it of R.interact) if (RSND[it.id]) it.sfx = false;
  { const oi = R.onInteract; R.onInteract = (id, api) => { const it = R.interact.find(e => e.id === id), o = R.root.position; if (it) RSND[id]?.({ x: o.x + it.x, y: 1, z: o.z + it.z }); oi(id, api); }; }
  R.npc = null;
  R.camera = { zoom: 6.5, target: new THREE.Vector3(0, 0.5, 0) };
  const pts = R.rig.points;
  R.tick = (t) => {
    const f = 0.8 + 0.12 * Math.sin(t * 2.3) + 0.08 * Math.sin(t * 3.7 + 1); pts[0].intensity = 10 * f; fg.material.opacity = 0.35 + 0.25 * f;
    dr.fire.children.forEach((c, i) => { c.scale.set(1, 0.95 + 0.15 * Math.sin(t * (2.2 + i * 0.4) + i * 2), 1); c.rotation.y = t * (1 + i * 0.3); });
    for (let i = 0; i < N; i++) { const k = (t * 0.45 + i / N) % 1; sp[i * 3] = FX0 + Math.sin(i * 7.1 + t) * 0.15 * (1 + k); sp[i * 3 + 1] = 0.9 + k * 1.8; sp[i * 3 + 2] = FZ + Math.cos(i * 3.3 + t * 0.8) * 0.15 * (1 + k); }
    sg.attributes.position.needsUpdate = true; smoke.userData.tick(t);
    bulbs(t);
    for (const fan of v.fans) fan.rotation.y = t * 1.1;
    vg.material.opacity = 0.3 * (1 - 0.12 * (0.5 + 0.5 * Math.sin(t * 1.85)));
  };
  roomGlow(R, [ // fire light on the faces of the seats around the drum, string-light pools along the edges
    { at: [FX0, 0.55, FZ - 1.45], w: 2.4, h: 0.8, c: '#ff8a3a', a: 0.08, face: 0 }, { at: [FX0, 0.03, FZ], w: 3.6, h: 3.6, c: '#ff8a3a', a: 0.05 },
    { at: [8.7, 0.03, 0], w: 1.8, h: 10, c: '#ffcf8a', a: 0.05 }, { at: [-8.7, 0.03, 0], w: 1.8, h: 10, c: '#ffcf8a', a: 0.05 }, { at: [0, 0.03, 5.9], w: 15, h: 1.6, c: '#ffcf8a', a: 0.05 }]);
  R.finish();
  return R;
}

function sprayTex() {
  return TX.canvasTex('roof-spray2', 700, 480, (x, w, h) => {
    const r = TX.rand(2); x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = '168px m5x7';
    const lines = [['DO NOT', 110, '#ff4fd8'], ['DEPLOY ON', 240, '#ff4fd8'], ['FRIDAYS', 375, '#ffe14f']];
    for (const [t, y, c] of lines) {
      x.save(); x.translate(w / 2, /** @type {number} */ (y)); x.rotate((r() - 0.5) * 0.06);
      x.shadowColor = /** @type {string} */ (c); x.shadowBlur = 22; x.fillStyle = /** @type {string} */ (c); x.globalAlpha = 0.35; x.fillText(/** @type {string} */ (t), 3, 3);
      x.shadowBlur = 4; x.globalAlpha = 1; x.fillText(/** @type {string} */ (t), 0, 0); x.restore();
      x.fillStyle = /** @type {string} */ (c); for (let i = 0; i < 7; i++) { const dx = 70 + r() * (w - 140), dl = 14 + r() * 50; x.fillRect(dx, /** @type {number} */ (y) + 40, 4, dl); x.beginPath(); x.arc(dx + 2, /** @type {number} */ (y) + 40 + dl, 4, 0, 7); x.fill(); }
    }
    x.fillStyle = 'rgba(255,79,216,0.5)'; for (let i = 0; i < 260; i++) x.fillRect(r() * w, r() * h, 2, 2); // overspray
    x.font = '45px m5x7'; x.fillStyle = '#3ddc84'; x.fillText('- ops', w - 90, h - 30);
  });
}
/** Sagging wires with warm bulbs; returns a tick(t) that sways the bulbs. */
function festoon(S, L, spans) {
  const list = [], wm = mat('#141018');
  for (const [a, b] of spans) {
    const pts = []; for (let i = 0; i <= 16; i++) { const u = i / 16; const p = a.clone().lerp(b, u); p.y -= Math.sin(u * Math.PI) * 0.8; pts.push(p); }
    S.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 32, 0.012, 4), wm));
    const per = Math.max(6, Math.round(a.distanceTo(b) / 0.8));
    for (let i = 1; i < per; i++) { const u = i / per; const p = a.clone().lerp(b, u); p.y -= Math.sin(u * Math.PI) * 0.8 + 0.07; list.push({ p, w: Math.sin(u * Math.PI), s: list.length }); }
  }
  const im = new THREE.InstancedMesh(new THREE.SphereGeometry(0.05, 8, 6), glowMat('#ffcf8a', 3), list.length); im.userData.live = true; L.add(im);
  const m4 = new THREE.Matrix4();
  return (t) => { list.forEach((b, i) => { const sw = Math.sin(t * 0.9 + b.s * 0.15) * 0.04 * b.w; m4.makeTranslation(b.p.x + sw, b.p.y - Math.abs(sw) * 0.3, b.p.z + sw * 0.6); im.setMatrixAt(i, m4); }); im.instanceMatrix.needsUpdate = true; };
}
