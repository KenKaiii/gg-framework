// @ts-check
// The Den: purple retro gaming den. CRT on a game-box cabinet, consoles + curly cables on a shag rug, beanbags,
// arcade cabinet, bookcase of games, posters, lava lamp + LED strip, snack mess. Matrix touch: black leather
// armchair with round black shades on the side table.
import { SFX } from '../sfx.js';
import { roomGlow, liveProp } from './bar-glow.js';
import * as THREE from 'three';
import { roomInfo } from './floorplan.js';
import { makeRoom, lightRig, mat, glowMat, rbox, put, mesh, bake } from './kit.js';
import * as FX from './kit-fx.js';
import * as TX from './tex.js';
import * as P from './den-props.js';
import * as D from './den-decor.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rickTex, tickRick } from './rick-screen.js';

/** @param {any} ctx */
export function build(ctx) {
  const info = roomInfo('den'); const stair = info?.stairs?.[0] || { to: 'basement', label: '↓ The Basement' };
  const R = makeRoom({ id: 'den', floor: TX.planks('#5e3a46', '#4a2c3a'), wall: TX.plaster('#3c2f68', 9), trim: '#3a2a4a', base: '#160f1e', slab: '#140e1c',
    windows: [{ side: 'e', at: -3.2, w: 1.4, h: 1.1, y: 1.2, view: TX.nightView({ seed: 21, sky: ['#120a2a', '#2c1a5a', '#5a2a7a'] }), frame: '#2a1f36', blinds: '#4a3a5a' }],
    doors: [{ side: 'n', at: -5.6, to: stair.to, label: stair.label, glow: '#b04fd8', frame: '#2a1f36' }] });
  const S = R.static, L = R.live;
  const live = o => { o.userData.live = true; L.add(o); return o; };
  const plane = (w, h, m) => { const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m); p.rotation.x = -Math.PI / 2; p.receiveShadow = true; return p; };

  // stairwell dressing: hazard strip, handrail going down, neon arrow
  put(S, plane(1.1, 0.22, mat('#c9a227', { roughness: 0.8 })), -5.6, 0.006, -5.75);
  const rail = mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.6, 8), mat('#7a6a8a', { metalness: 0.7, roughness: 0.3 })); rail.rotation.z = 1.15; R.onWall('n', rail, -4.55, 1.05, 0.08);
  for (const [u, y] of [[-4.0, 1.3], [-5.0, 0.85]]) R.onWall('n', rbox(0.04, 0.04, 0.1, mat('#7a6a8a', { metalness: 0.7 }), 0.01), u, y, 0.04);
  const arrow = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.2), new THREE.MeshBasicMaterial({ map: TX.neon('▼ B1', '#b04fd8'), toneMapped: false, transparent: true })); R.onWall('n', arrow, -5.6, 2.95, 0.04);

  // ZONE 1: main CRT couch area (north-west)
  put(S, plane(4.8, 3.9, mat('#ffffff', { map: TX.rug('persian', '#4a2470', '#c0559a', '#e0a8ff'), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 })), -2.3, 0.014, -3.3);
  const cab = put(S, P.tvCabinet(), -2.2, 0, -5.55); R.blockObj(cab);
  const tv = P.crt(); tv.g.position.set(-2.2, 0.66, -5.6); tv.g.rotation.y = 0.06; S.add(tv.g);
  const tvGlow = live(FX.glow('#7fc8ff', 2.4, 0.35)); tvGlow.position.set(-2.15, 1.15, -5.1);
  const ledM = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff4fd8').multiplyScalar(2.4), toneMapped: false });
  const led = new THREE.Mesh(mergeGeometries([new THREE.BoxGeometry(2.3, 0.03, 0.03), new THREE.BoxGeometry(0.03, 1.0, 0.03).translate(-1.15, -0.5, 0), new THREE.BoxGeometry(0.03, 1.0, 0.03).translate(1.15, -0.5, 0)]), ledM); led.userData.live = true; R.onWall('n', led, -2.2, 1.72, 0.12);
  const ledGlow = live(FX.glow('#ff4fd8', 3.4, 0.22)); ledGlow.position.set(-2.2, 1.7, -5.8);
  const lava = P.lavaLamp(); lava.g.name = 'rx-lava'; lava.g.position.set(-3.15, 0.69, -5.5); L.add(lava.g); lava.g.userData.live = true;
  const lavaGlow = FX.glow('#ff4fd8', 0.9, 0.5); lavaGlow.position.y = 0.35; lava.g.add(lavaGlow);
  put(S, P.consoleBox('#57536a'), -1.35, 0.68, -5.5, -0.1);
  const bc = put(S, P.bookcase(), -4.15, 0, -5.82); R.blockObj(bc);
  const c1 = put(S, P.consoleBox(), -2.0, 0, -4.4, 0.15); R.blockObj(c1, 0);
  S.add(P.cable(new THREE.Vector3(-2.0, 0.05, -4.6), new THREE.Vector3(-2.2, 0.1, -5.2), 2, 3));
  S.add(P.cable(new THREE.Vector3(-1.8, 0.06, -4.2), new THREE.Vector3(-1.5, 0.03, -2.7), 3, 2));
  const tvP = new THREE.Vector2(-2.2, -5.4), faceTo = (x, z, p = tvP) => Math.atan2(p.x - x, p.y - z);
  const bbs = [[-3.6, -3.7, '#5b2a86', 1.1], [-0.8, -3.8, '#7a2a6a', 0.95]].map(([x, z, c, s]) => { const f = faceTo(x, z); const o = put(S, P.beanbag(c, s), x, 0, z, f); R.blockObj(o, 0.3); return { x: x + Math.sin(f) * 0.3, z: z + Math.cos(f) * 0.3, f }; });
  const sofa = put(S, D.loveseat(), -2.3, 0, -1.3, Math.PI); R.blockObj(sofa);
  put(S, P.cushion('#5a2a4a'), -1.6, 0, -2.6, -0.4);
  put(S, P.controller(), -2.3, 0, -3.1, 0.5); put(S, P.controller('#bdb6d6'), -1.0, 0, -2.9, -0.4);
  put(S, P.snacks(), -2.3, 0, -2.3, 0.4);

  // ZONE 2: fighting-game TV, two players standing (north centre)
  const cab2 = put(S, P.tvCabinet(), 0.7, 0, -5.6); cab2.scale.set(0.6, 1, 0.8); R.blockObj(cab2);
  const tv2 = P.crt(); tv2.g.position.set(0.7, 0.66, -5.65); tv2.g.scale.setScalar(0.85); S.add(tv2.g);
  const scr2 = /** @type {THREE.MeshBasicMaterial} */ (tv2.screen.material); scr2.map = rickTex();
  put(S, P.controller('#2b2838'), 0.3, 0.67, -5.35, 0.2);

  // ZONE 3: arcade row of 3 cabinets (north-east)
  const ar = P.arcade(); const arcs = [2.5, 3.5, 4.5].map((x, i) => { const g = i ? ar.g.clone(true) : ar.g; g.position.set(x, 0, -5.5); g.rotation.y = (i - 1) * -0.06; S.add(g); R.blockObj(g, 0.05); return g; });
  const arGlow = live(FX.glow('#ff4fd8', 2.6, 0.3)); arGlow.position.set(3.5, 1.4, -5.0);
  const bc2 = put(S, P.bookcase(0.8, 1.6), 5.75, 0, -5.82); R.blockObj(bc2);
  put(S, plane(3.4, 1.4, mat('#2a1a36', { roughness: 0.95 })), 3.5, 0.004, -4.6);

  // ZONE 4: table-top games corner (south-east), low table + floor cushions
  put(S, plane(3.0, 2.6, mat('#ffffff', { map: TX.rug('stripes', '#3a2440', '#6a3a5a', '#b04fd8'), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 })), 4.4, 0.014, 3.3);
  const tt = put(S, D.coffeeTable(), 4.4, 0, 3.3); tt.scale.set(1.15, 1, 1.4); R.blockObj(tt);
  put(S, rbox(0.5, 0.02, 0.5, mat('#2e5a3a', { roughness: 0.8 }), 0.01), 4.3, 0.4, 3.4, 0.2); // game board
  for (const [x, z, c] of [[3.35, 3.3, '#3a2a5a'], [5.45, 3.3, '#5a2a4a'], [4.4, 4.35, '#2a3a5a']]) put(S, P.cushion(c), x, 0, z);
  const pend = new THREE.Group(); put(S, pend, 4.4, 0, 3.3);
  put(pend, mesh(new THREE.CylinderGeometry(0.008, 0.008, 1.2, 6), mat('#111')), 0, 2.6, 0);
  put(pend, mesh(new THREE.ConeGeometry(0.32, 0.26, 20, 1, true), glowMat('#ffb36b', 1.2, { side: THREE.DoubleSide })), 0, 1.95, 0);
  live(FX.glow('#ffb36b', 0.9, 0.25)).position.set(4.4, 1.9, 3.3);

  // Matrix corner (south-west, clear of the bar opening): black leather armchair + shades on the side table
  const fC = Math.atan2(1, -1) ; const ch = put(S, P.armchair(), -4.9, 0, 4.6, 2.4); R.blockObj(ch);
  const st = put(S, P.sideTable(), -5.85, 0, 3.6); R.blockObj(st);
  put(R.live, liveProp(D.tableLamp(), 'rx-lamp'), -5.85, 0.6, 3.75); live(FX.glow('#ffb36b', 0.8, 0.5)).position.set(-5.85, 0.82, 3.75);
  const pl = put(R.live, liveProp(P.plant(), 'rx-plant'), -5.9, 0, 5.5); R.blockObj(pl);
  put(S, P.plant(7), 6.0, 0, 5.5).scale.setScalar(0.8); R.block(5.8, 5.3, 6.2, 5.7);

  // clutter
  put(S, D.hoodie('#2b3a5a'), 0.6, 0, -1.2, 0.7); put(S, D.hoodie('#3a2430'), 5.6, 0, 1.6, 2.2).scale.setScalar(0.8);
  S.add(D.floorClutter([[-0.6, -2.4], [-0.4, -2.2], [2.4, 1.6], [5.5, -2.5], [-4.2, 2.9]], [[-0.5, -1.7, 0], [1.4, -3.0, 1], [5.3, 4.4, 1], [-3.9, -2.3, 0], [3.0, 5.4, 1], [5.8, -1.8, 0], [-5.3, 5.3, 1]]));
  put(S, D.figureShelf(), -0.6, 1.4, -5.9);
  const fairy = D.stringLights([[-6.36, 2.9, -5.86], [-4.4, 2.85, -5.86], [-2.2, 2.95, -5.86], [0, 2.85, -5.86], [2.2, 2.95, -5.86], [4.4, 2.85, -5.86], [6.36, 2.9, -5.86]].map(v => new THREE.Vector3(...v)));
  L.add(fairy); fairy.userData.live = true;
  const poster = (side, kind, u, y, s = 1, rot = 0) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(0.7 * s, 1.05 * s), mat('#ffffff', { map: TX.poster(kind), roughness: 0.7 })); m.rotation.z = rot; R.onWall(side, m, u, y, 0.03);
    const fr = rbox(0.76 * s, 1.11 * s, 0.03, mat('#1a1420'), 0.01); fr.rotation.z = rot; R.onWall(side, fr, u, y, 0.012); };
  poster('n', 'maze', -0.6, 2.35, 0.8); poster('n', 'space', 1.8, 2.25, 0.9, 0.03); poster('n', 'dragon', 5.75, 2.35, 0.8);
  poster('e', 'retro', 1.5, 2.0);

  R.rig = lightRig(R.root, { room: R, sky: '#7a5a9a', ground: '#3a2430', ambient: 3.0, moon: '#8fa8ff', moonI: 0.7, moonFrom: [9, 8, -5],
    points: [{ x: -2.2, y: 1.3, z: -4.4, color: '#8fc8ff', i: 8, d: 8 }, { x: 0.7, y: 1.8, z: -4.6, color: '#ff4fd8', i: 9, d: 8 },
      { x: 3.5, y: 1.8, z: -4.2, color: '#d05fff', i: 8, d: 7 }, { x: 4.4, y: 1.8, z: 3.3, color: '#ffb36b', i: 12, d: 9 }] });
  live(FX.motes(50, new THREE.Vector3(-5, 0.4, -5), new THREE.Vector3(5, 2.6, 5), '#e0c8ff', 0.04));

  R.meta = { id: 'den', name: 'The Den', blurb: 'Purple retro gaming den: CRT couch, arcade row, fight night, cold pizza.' };
  R.spawn = { x: 0.5, z: 1.5, face: Math.PI };
  const N = Math.PI;
  R.slots = [
    { id: 'den-beanbag', kind: 'beanbag', x: bbs[0].x, z: bbs[0].z, y: 0.28, face: bbs[0].f, anim: 'Sit_Floor_Idle', prop: 'controller', label: 'Big beanbag' },
    { id: 'den-beanbag2', kind: 'beanbag', x: bbs[1].x, z: bbs[1].z, y: 0.25, face: bbs[1].f, anim: 'Sit_Floor_Idle', prop: 'laptop', label: 'Plum beanbag' },
    { id: 'den-sofa-l', kind: 'sofa', x: -2.75, z: -1.45, face: N, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Loveseat' },
    { id: 'den-sofa-r', kind: 'sofa', x: -1.85, z: -1.45, face: N, anim: 'Sit_Chair_Idle', prop: 'beer', label: 'Loveseat' },
    { id: 'den-cushion2', kind: 'floor', x: -1.6, z: -2.6, y: 0.16, face: faceTo(-1.6, -2.6), anim: 'Sit_Floor_Idle', prop: 'laptop', label: 'Floor cushion' },
    { id: 'den-fight1', kind: 'stand', x: 0.35, z: -4.1, face: N, anim: 'Idle', prop: 'controller', label: 'Fight night P1' },
    { id: 'den-fight2', kind: 'stand', x: 1.1, z: -4.1, face: N, anim: 'Idle', prop: 'controller', label: 'Fight night P2' },
    { id: 'den-arcade1', kind: 'stand', x: 2.5, z: -4.6, face: N, anim: 'Idle', prop: 'beer', label: 'Arcade' },
    { id: 'den-arcade2', kind: 'stand', x: 3.5, z: -4.6, face: N, anim: 'Idle', prop: 'phone', label: 'Arcade' },
    { id: 'den-arcade3', kind: 'stand', x: 4.5, z: -4.6, face: N, anim: 'Idle', prop: 'beer', label: 'Arcade' },
    { id: 'den-table1', kind: 'floor', x: 3.35, z: 3.3, y: 0.16, face: N / 2, anim: 'Sit_Floor_Idle', prop: 'laptop', label: 'Games table' },
    { id: 'den-table2', kind: 'floor', x: 5.45, z: 3.3, y: 0.16, face: -N / 2, anim: 'Sit_Floor_Idle', prop: 'laptop', label: 'Games table' },
    { id: 'den-table3', kind: 'floor', x: 4.4, z: 4.35, y: 0.16, face: N, anim: 'Sit_Floor_Idle', prop: 'laptop', label: 'Games table' },
    { id: 'den-armchair', kind: 'chair', x: -4.85, z: 4.55, y: 0.05, face: 2.4, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Leather armchair' },
  ];
  void fC;
  R.interact = [
    { id: 'arcade', x: 3.5, z: -4.6, r: 1.6, label: 'Insert coin', kind: 'arcade' },
    { id: 'tv', x: -2.2, z: -4.5, r: 1.1, label: 'Watch TV', kind: 'tv' },
    { id: 'window', x: 5.8, z: -3.2, r: 1.0, label: 'Look outside', kind: 'window' },
  ];
  const st8 = { flash: -9, tvOff: 0 };
  R.onInteract = (id, api) => {
    if (id === 'arcade') { st8.flash = st8.t ?? 0; api.bubble('*clink* PLAYER 1 READY'); }
    else if (id === 'tv') { st8.tvOff += 3; api.toast('Level 1-2. Again.'); }
    else if (id === 'window') api.toast('City lights. Someone else is shipping too.');
  };  // reaction sounds, timed to the animations (the default keyword guess is silenced for these)
  /** @type {Record<string, () => void>} */
  const RSND = {
    arcade: (at) => { SFX.play('arcade.coin', { at }); SFX.play('blip', { at, delay: 0.4 }); },
  };
  for (const it of R.interact) if (RSND[it.id]) it.sfx = false;
  { const oi = R.onInteract; R.onInteract = (id, api) => { const it = R.interact.find(e => e.id === id), o = R.root.position; if (it) RSND[id]?.({ x: o.x + it.x, y: 1, z: o.z + it.z }); oi(id, api); }; }

  R.npc = null;
  R.camera = { zoom: 6, target: new THREE.Vector3(0, 0.8, -0.3) };
  const scr = /** @type {THREE.MeshBasicMaterial} */ (tv.screen.material), arM = /** @type {THREE.MeshBasicMaterial} */ (ar.screen.material);
  R.tick = (t) => {
    st8.t = t;
    tickRick(t); if (scr.map !== rickTex()) scr.map = rickTex();
    const f = (1 - 0.06 * (0.5 + 0.5 * Math.sin(t * 2.42))); scr.color.setScalar(1.05 * f); scr2.color.setScalar(1.0); tvGlow.material.opacity = 0.3 * f;
    R.rig.points[0].intensity = 8 * f; const bm = /** @type {any} */ (fairy.userData.bulbs).material; bm.color.setScalar(0.85 + 0.15 * Math.sin(t * 1.7));
    const pulse = 0.85 + 0.15 * Math.sin(t * 0.8); ledM.color.set('#ff4fd8').multiplyScalar(2.4 * pulse); R.rig.points[1].intensity = 9 * pulse * (0.9 + 0.1 * Math.sin(t * 9));
    lava.blobs.forEach((bl, i) => { bl.position.y = 0.33 + Math.sin(t * 0.4 + i * 2.1) * 0.12; bl.position.x = Math.sin(t * 0.3 + i) * 0.015; bl.scale.setScalar(1 + 0.3 * Math.sin(t * 0.7 + i)); });
    const k = Math.max(0, 1 - (t - st8.flash) / 0.8); arM.color.setScalar(1.1 + k * 2 + 0.06 * Math.sin(t * 2.2)); R.rig.points[2].intensity = 8 + k * 10;
  };
  // small details don't need to cast moon shadows (saves shadow-pass draw calls once baked per material)
  const bx = new THREE.Box3(), sz = new THREE.Vector3(); S.updateMatrixWorld(true);
  S.traverse(o => { if (/** @type {any} */ (o).isMesh) { bx.setFromObject(o).getSize(sz); if (Math.max(sz.x, sz.y, sz.z) < 0.9) o.castShadow = false; } });
  const cut = R.cutaway; R.cutaway = dir => { cut(dir); fairy.visible = ledGlow.visible = R.walls.n.full.visible; };
  roomGlow(R, [{ at: [-2.15, 0.03, -4.1], w: 2.4, h: 1.8, c: '#7fc8ff', a: 0.12 }, { at: [3.5, 0.03, -4.5], w: 3.6, h: 1.6, c: '#d05fff', a: 0.1 }]);
  R.finish();
  return R;
}
