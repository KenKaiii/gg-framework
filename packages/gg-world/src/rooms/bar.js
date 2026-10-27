// @ts-check
// The Terminal (v2): the big back room of the ground floor. Long bar on the north wall, booths on the west wall,
// pool in the middle, darts in the SW corner, a DJ stage in the NE corner, high-tops by the den opening.
import { SFX } from '../sfx.js';
import { roomGlow } from './bar-glow.js';
import * as THREE from 'three';
import { makeRoom, lightRig, mat, glowMat, rbox, put, mesh } from './kit.js';
import { roomInfo } from './floorplan.js';
import * as FX from './kit-fx.js';
import * as TX from './tex.js';
import * as P from './bar-props.js';
import * as Z from './bar-zones.js';
import { dressWalls, barSlots, barNpc, barInteract } from './bar-layout.js';
import { rickTex, tickRick } from './rick-screen.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** @param {any} ctx */
export function build(ctx) {
  const st = roomInfo('bar').stairs[0];
  const DOOR_X = 3.4;
  const R = makeRoom({ id: 'bar', floor: TX.planks('#2e1f18', '#24170f', 9), floorRepeat: 2.2,
    wall: TX.brick('#5a2e26', '#2a1a18', 8), trim: '#2a1a14', base: '#140d0c', slab: '#120c14',
    doors: [{ side: 'n', at: DOOR_X, to: st.to, label: st.label, glow: '#8fa8ff' }] });
  const S = R.static, L = R.live, F0 = -Math.PI / 2;

  // ---- stairwell behind the roof door: drop the flat door glow so the steps show ----
  const gone = []; R.walls.n.full.traverse(o => { if (o.isMesh && o.geometry.type === 'PlaneGeometry' && o.position.z < -0.15) gone.push(o); });
  for (const o of gone) o.parent.remove(o);
  put(S, Z.stairwell(1.1), DOOR_X, 0, -6);
  put(L, FX.glow('#8fa8ff', 1.8, 0.45), DOOR_X, 1.6, -6.9); pool(DOOR_X, -5.4, 1.1, '#8fa8ff', 0.25);

  // ---- the long bar along the north wall ----
  const BL = 9.2, BX = -4.15; // back bar x -8.75..0.45
  put(S, P.backbar(BL), BX, 0, -6, F0); R.block(-8.8, -6, 0.5, -5.45);
  const CL = 7.6, CX = -3.65; // counter x -7.45..0.15
  put(S, P.counter(CL), CX, 0, -4.25, F0); R.block(CX - CL / 2, -4.7, CX + CL / 2, -3.75);
  put(S, P.taps(), -4.6, 1.075, -4.35, F0); put(S, P.taps(), -1.4, 1.075, -4.35, F0);
  put(S, P.register(), -0.6, 1.075, -4.35, F0);
  put(S, P.tipJar(), -6.9, 1.075, -4.3);
  const gl = []; for (let i = 0; i < 14; i++) gl.push([-7.1 + i * 0.52 + (i % 3) * 0.07, 1.075, -4.0 - (i % 2) * 0.35]);
  for (let i = 0; i < 6; i++) gl.push([-8.2 + i * 0.12, 0.94, -5.7]);
  S.add(P.glasses(gl));
  const STOOL_X = [-6.8, -5.85, -4.9, -3.95, -3.0, -2.05, -1.1, -0.15];
  for (const x of STOOL_X) put(S, P.stool(), x, 0, -3.45);
  const strip = rbox(CL, 0.03, 0.03, glowMat('#ffb36b', 2.8), 0); strip.castShadow = false; put(S, strip, CX, 0.98, -3.77);
  const neonM = new THREE.MeshBasicMaterial({ map: TX.neon('THE TERMINAL', '#3ddc84', 512, 128, '96px m5x7'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const neon = mesh(new THREE.PlaneGeometry(2.6, 0.65), neonM); neon.castShadow = false; neon.userData.live = true; neon.name = 'rx-neon';
  R.onWall('n', neon, -4.2, 2.86, 0.08);
  const neonGlow = FX.glow('#3ddc84', 2.0, 0.18); put(L, neonGlow, -4.2, 2.8, -5.7);
  put(S, P.tv(rickTex()), -8.3, 2.55, -5.3, 0.7); // every TV plays Never Gonna Give You Up (rick-screen.js)

  // ---- north wall east of the bar: jukebox, stair door, payphone ----
  const jb = P.jukebox(); put(S, jb.g, 1.55, 0, -5.62); R.block(1.05, -6, 2.05, -5.3);
  const archGlow = FX.glow('#ff4fd8', 1.6, 0.35); put(L, archGlow, 1.55, 1.1, -5.2);
  const pp = P.payphone(); R.onWall('n', pp.g, 4.75, 1.45, 0.1);

  // ---- booth row on the west wall ----
  const BOOTH_Z = [-2.1, 0.35, 2.8];
  for (const z of BOOTH_Z) { put(S, Z.booth(1.5), -8.2, 0, z); R.block(-9, z - 0.4, -7.5, z + 0.4); R.block(-9, z - 1.1, -7.45, z - 0.95); R.block(-9, z + 0.95, -7.45, z + 1.1); put(S, P.pendant(), -8.2, 2.2, z); }
  R.onWall('w', P.chalkboard(), 2.1, 1.95, 0.03);

  // ---- darts corner (SW) ----
  R.onWall('w', P.dartboard(), -4.95, 1.7, 0.03);
  R.onWall('w', mesh(new THREE.PlaneGeometry(0.5, 0.36), mat('#ffffff', { map: TX.label('DARTS  301', '#f2ead8', '#1c2220', 256, 180, '51px m5x7') })), -5.75, 1.75, 0.03);
  const oche = rbox(0.05, 0.01, 1.0, mat('#c99a4a', { metalness: 0.6, roughness: 0.4 }), 0.003); put(S, oche, -6.4, 0.006, 4.95);
  const cue = rbox(0.06, 1.3, 0.04, mat('#5a3622', { roughness: 0.45 }), 0.01); cue.rotation.z = 0.12; put(S, cue, -8.8, 0.65, 4.1);
  const cue2 = cue.clone(); cue2.rotation.z = 0.2; put(S, cue2, -8.75, 0.65, 4.25);

  // ---- pool table ----
  put(S, P.poolTable(), 0.6, 0, 1.0); R.block(-0.55, 0.4, 1.75, 1.6);
  const lamp = P.poolLamp(); lamp.userData.live = true; put(L, lamp, 0.6, 1.75, 1.0);
  const rug = mesh(new THREE.PlaneGeometry(3.6, 2.6), mat('#ffffff', { map: TX.rug('stripe', '#2a1c30', '#3a2440', '#6a4a3a'), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 })); rug.rotation.x = -Math.PI / 2; put(S, rug, 0.6, 0.014, 1.0);

  // ---- DJ stage (NE corner) ----
  put(S, Z.stage(3.2, 2.2), 7.2, 0, -4.9);
  const dj = Z.djDecks(); put(S, dj.g, 7.1, 0.24, -4.55); for (const p of dj.platters) { p.position.add(V(7.1, 0.24, -4.55)); L.add(p); }
  R.block(6.25, -4.9, 7.95, -4.2);
  for (const x of [5.95, 8.4]) { put(S, Z.speakerStack(), x, 0.24, -5.6); R.block(x - 0.4, -6, x + 0.4, -5.3); }
  put(S, Z.micStand(), 6.0, 0.24, -4.15, 0.5);
  put(S, Z.chalkSign('OPEN MIC\nthurs\nbring\nyour\nbugs'), 5.0, 0, -3.3, 0.6); R.block(4.75, -3.55, 5.25, -3.05);

  // ---- high-tops by the den opening ----
  const HT = [[5.8, -2.3], [6.1, 0.5], [5.5, 3.3]];
  for (const [x, z] of HT) { put(S, Z.highTable(), x, 0, z); put(S, P.pendant(), x, 2.3, z); R.block(x - 0.4, z - 0.4, x + 0.4, z + 0.4); put(S, mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.14, 10), mat('#2f7a3a', { metalness: 0.7, roughness: 0.3 })), x + 0.12, 1.16, z - 0.05); }

  // ---- clutter ----
  S.add(P.caps([[-5.2, 1.075, -3.95], [-2.3, 1.075, -4.1], [-2.0, 0, -2.4], [2.6, 0, 2.6], [3.6, 0, -1.2], [-6.2, 0, 1.4], [6.8, 0, 4.4], [-1.0, 0, 3.6], [1.8, 0, 5.2]]));
  for (const [x, z, y] of [[8.2, 5.3, 0], [8.6, 4.75, 0], [8.4, 5.05, 0.6]]) put(S, P.keg(), x, y, z);
  R.block(7.8, 4.4, 9, 6);
  put(S, P.bin(), 2.4, 0, 5.6); R.block(2.15, 5.35, 2.65, 5.9);
  put(S, P.coatRack(), 0.4, 0, 5.55); R.block(0.15, 5.3, 0.65, 5.85);
  dressWalls(R);

  // ---- ceiling pipes + string lights along the back walls ----
  S.add(P.pipe(V(-8.8, 3.0, -5.8), V(8.8, 3.0, -5.8), 0.06));
  S.add(P.pipe(V(-8.8, 2.86, -5.65), V(8.8, 2.86, -5.65), 0.035, '#5a4a44'));
  S.add(P.pipe(V(-8.8, 3.0, -5.8), V(-8.8, 3.0, 6), 0.06));
  L.add(P.stringLights(V(-8.6, 2.8, -5.6), V(0.4, 2.8, -5.6), 26, 0.25));
  L.add(P.stringLights(V(5.4, 2.8, -5.6), V(8.7, 2.8, -5.6), 10, 0.2));
  L.add(P.stringLights(V(-8.7, 2.75, 5.8), V(-8.7, 2.75, -5.2), 30, 0.3));
  L.add(FX.motes(50, V(-3, 0.8, -2), V(4, 2.6, 3), '#ffcf8a', 0.04));

  // ---- fake light: floor pools + halos ----
  function pool(x, z, r, c, o) { const m = mesh(new THREE.CircleGeometry(r, 28), new THREE.MeshBasicMaterial({ map: TX.dotTex(), color: c, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })); m.rotation.x = -Math.PI / 2; m.castShadow = m.receiveShadow = false; m.userData.live = true; put(L, m, x, 0.012, z); return m; }
  pool(0.6, 1.0, 2.2, '#ffe0a0', 0.25); pool(-3.6, -3.4, 2.6, '#ffb36b', 0.3);
  for (const z of BOOTH_Z) pool(-7.8, z, 1.3, '#ffb36b', 0.3);
  for (const [x, z] of HT) { pool(x, z, 1.2, '#ffcf8a', 0.28); put(L, FX.glow('#ffcf8a', 0.8, 0.4), x, 2.22, z); }
  const stagePool = pool(7.0, -4.2, 2.0, '#ff4fd8', 0.3);
  pool(-6.4, 4.9, 1.2, '#ffcf8a', 0.2);
  put(L, FX.glow('#ffe0a0', 1.0, 0.25), 0.6, 1.65, 1.0);
  for (const z of BOOTH_Z) put(L, FX.glow('#ffcf8a', 0.9, 0.45), -8.2, 2.12, z);

  // ---- lights: bar, pool, booths, stage ----
  R.rig = lightRig(R.root, { room: R, sky: '#3a2f5a', ground: '#1c1218', ambient: 2.6, moonI: 0.5, moonFrom: [6, 10, 8],
    points: [{ x: -3.8, y: 2.2, z: -4.2, color: '#ffb36b', i: 10, d: 8 }, { x: 0.6, y: 1.6, z: 1.0, color: '#ffe0a0', i: 8, d: 5.5 },
      { x: -7.6, y: 2.0, z: 0.4, color: '#ffb36b', i: 9, d: 7 }, { x: 7.0, y: 2.4, z: -3.8, color: '#e060e0', i: 8, d: 7 }] });

  R.meta = { id: 'bar', name: 'The Terminal', blurb: 'The big back bar: drinks, pool, darts, booths and an open-mic stage.' };
  R.spawn = { x: 3.4, z: 3.6, face: Math.PI };
  R.slots = barSlots({ STOOL_X, BOOTH_Z, HT });
  R.npc = barNpc();
  R.interact = barInteract();

  // ---- interactions + animation ----
  const arch = ['#ff4fd8', '#3ddc84', '#ffb36b', '#8fa8ff']; let track = 0, ringT = -9, noteT = -9, dropT = -9;
  const notes = []; const noteTex = TX.label('\u266A', '#ffffff', null, 64, 64, '78px m5x7');
  for (let i = 0; i < 6; i++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: noteTex, color: arch[0], transparent: true, depthWrite: false, opacity: 0 })); s.scale.setScalar(0.25); s.userData.live = true; L.add(s); notes.push(s); }
  let now = 0;
  R.onInteract = (id, api) => {
    if (id === 'jukebox') { track = (track + 1) % arch.length; noteT = now; api.toast(['Track 2: lo-fi for merge conflicts', 'Track 3: synthwave deploy', 'Track 4: rain on a CRT', 'Track 1: basement jazz'][track]); }
    else if (id === 'payphone') { ringT = now; api.bubble('wrong number... or is it?'); }
    else if (id === 'tv') api.toast('deploy ok. 214/214 tests green.');
    else if (id === 'dartboard') api.bubble('bullseye. (not really)');
    else if (id === 'decks') { dropT = now; api.toast('the drop hits. git push --force (on the dance floor)'); }
  };  // reaction sounds, timed to the animations (the default keyword guess is silenced for these)
  /** @type {Record<string, () => void>} */
  const RSND = {
    jukebox: (at) => { SFX.play('vinyl', { at, vol: 0.6 }); SFX.play('chord', { at, vol: 0.5, delay: 0.45 }); },
    payphone: (at) => { SFX.play('phone.ring', { at, vol: 0.5 }); SFX.play('phone.pickup', { at, delay: 0.9 }); SFX.play('static', { at, vol: 0.2, delay: 1.1 }); },
    decks: (at) => { SFX.play('vinyl', { at, vol: 0.5, pitch: 1.4 }); SFX.play('thud', { at, vol: 0.6, delay: 0.35 }); SFX.play('chord', { at, vol: 0.5, delay: 0.4 }); },
  };
  for (const it of R.interact) if (RSND[it.id]) it.sfx = false;
  { const oi = R.onInteract; R.onInteract = (id, api) => { const it = R.interact.find(e => e.id === id), o = R.root.position; if (it) RSND[id]?.({ x: o.x + it.x, y: 1, z: o.z + it.z }); oi(id, api); }; }

  const pts = R.rig.points;
  R.tick = (t) => {
    now = t;
    const f = (1 - 0.08 * (0.5 + 0.5 * Math.sin(t * 2.03)));
    neonM.opacity = f; neonGlow.material.opacity = 0.25 * f;
    const c = new THREE.Color(arch[track]); jb.arches.color.copy(c).multiplyScalar(2.2 + 0.4 * Math.sin(t * 2)); archGlow.material.color.copy(c);
    pts[0].intensity = 10 * (1 - 0.04 * (0.5 + 0.5 * Math.sin(t * 1.57)));
    const dk = t - dropT, beat = dk < 6 ? 0.7 + 0.3 * Math.sin(t * 3.5) : 0.85 + 0.15 * Math.sin(t * 2.2);
    pts[3].intensity = 8 * beat; stagePool.material.opacity = 0.3 * beat;
    for (const p of dj.platters) p.rotation.y = t * 3.5;
    tickRick(t);
    const k = t - noteT;
    notes.forEach((s, i) => { const u = (k - i * 0.25) / 2; if (u < 0 || u > 1) { s.visible = false; return; } s.visible = true; s.material.color.copy(c); s.material.opacity = Math.sin(u * Math.PI); s.position.set(1.55 + Math.sin(u * 6 + i) * 0.3, 1.4 + u * 1.2, -5.3); });
    const rk = t - ringT; pp.handset.rotation.z = rk < 2.5 ? Math.sin(t * 60) * 0.12 * (1 - rk / 2.5) : 0;
    for (const o of L.children) if (o.userData.tick) o.userData.tick(t);
  };
  R.camera = { zoom: 6.5, target: V(0, 1.4, 0) };
  roomGlow(R, [{ at: [-4.2, 2.7, 0], w: 3.2, h: 1.6, c: '#3ddc84', a: 0.12, face: 'n' }, { at: [1.55, 0.03, -4.6], w: 1.8, h: 1.4, c: '#ff4fd8', a: 0.12 }]);
  R.finish();
  const keep = new Set([mat('#3b2418', { roughness: 0.7 }), mat('#24150f', { roughness: 0.8 }), mat('#2a1714', { roughness: 0.55 })]);
  R.root.traverse(o => { if (o.isMesh && !keep.has(o.material)) o.castShadow = false; });
  return R;
}
