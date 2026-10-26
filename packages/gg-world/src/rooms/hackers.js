// @ts-check
// Club Cyberdelia: a 90s cyber rave club / hacker den (homage to Hackers, 1995). Graffiti brick, CRT monitor wall,
// DJ booth, payphones, rollerblade rack, translucent laptops, arcade corner, sofas, beanbags and a high bar.
// Local frame x -11..11, z -7..7. n wall = overlook's (free-standing only, opening x=0). w = exterior (u = -z).
// e wall drawn (opening to computer at z=0), s wall drawn (opening to inception at x=0, cut by camera).
import * as THREE from 'three';
import { makeRoom, lightRig, mat, put, rbox, glowMat } from './kit.js';
import * as FX from './kit-fx.js';
import * as TX from './tex.js';
import * as P from './hackers-props.js';
import { addClub } from './hackers-club.js';
import { poker } from './screening-poke.js';
import { SFX } from '../sfx.js';

// spray can: rattle-ball clicks then a soft hiss
SFX.define('cyb.spray', (o, t, p, K) => { K.tone(o, t, { type: 'square', f: 1400 * p, v: 0.03, d: 0.02 }); K.tone(o, t + 0.09, { type: 'square', f: 1500 * p, v: 0.03, d: 0.02 }); K.hiss(o, t + 0.22, { ft: 'highpass', f: 3000 * p, v: 0.07, a: 0.04, d: 0.5 }); });
// record scratch: quick filtered sweep up and down
SFX.define('cyb.scratch', (o, t, p, K) => { K.hiss(o, t, { ft: 'bandpass', f: 600 * p, f1: 2400 * p, q: 3, v: 0.1, a: 0.01, d: 0.12 }); K.hiss(o, t + 0.14, { ft: 'bandpass', f: 2200 * p, f1: 500 * p, q: 3, v: 0.1, a: 0.01, d: 0.14 }); });

/** @param {any} ctx */
export function build(ctx) {
  void ctx;
  const R = /** @type {any} */ (makeRoom({ id: 'hackers', floor: P.floorTex(), floorRepeat: 3, wall: P.wallTex(), trim: '#2a1e34', base: '#15111c' }));
  const S = R.static, H = Math.PI / 2, PI = Math.PI;
  const st = (o, x, y, z, ry = 0, block = false) => { put(S, o, x, y, z, ry); if (block) R.blockObj(o); return o; };
  const live = (o, x, y, z, ry = 0) => { put(R.live, o, x, y, z, ry); o.traverse(c => { c.userData.live = true; }); return o; };
  const flatM = (o, x, y, z, ry = 0) => { live(o, x, y, z, ry); o.castShadow = false; return o; };
  // ----- animated shared screen texture (CRT wall + cabinets tint it)
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 48; const cx = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
  const scrTex = new THREE.CanvasTexture(cv); scrTex.colorSpace = THREE.SRGBColorSpace; scrTex.magFilter = THREE.NearestFilter;
  let frame = 0;
  const drawScr = () => { frame++; cx.fillStyle = '#0a0f14'; cx.fillRect(0, 0, 64, 48); cx.fillStyle = '#ffffff';
    for (let r = 0; r < 8; r++) { const L = 8 + ((r * 13 + frame * 7) % 40); cx.globalAlpha = 0.5 + 0.5 * ((r + frame) % 3) / 2; cx.fillRect(4, 4 + r * 5, L, 2); }
    cx.globalAlpha = 1; cx.fillRect(4 + (frame * 5) % 54, 44, 6, 2); scrTex.needsUpdate = true; };
  drawScr();
  // ----- west wall: CRT monitor wall, payphones, HACK THE PLANET graffiti
  const crt = live(P.crtWall(7, 4, scrTex), -10.5, 0, -3.2, H); st(crt.userData.racks, -10.5, 0, -3.2, H); R.block(-11, -5.6, -10.1, -0.8);
  const ppL = [0.15, 0.85].map(z => R.onWall('w', P.payphone(), -z, 1.35, 0.1));
  R.block(-11, -0.3, -10.4, 1.8);
  const grafM = new THREE.MeshBasicMaterial({ map: P.graffiti('HACK THE PLANET', '#9dff3d', '#3ff0ff'), transparent: true, toneMapped: false, depthWrite: false });
  R.onWall('w', new THREE.Mesh(new THREE.PlaneGeometry(4.4, 1.1), grafM), -3.6, 2.45, 0.03);
  // ----- east wall: "mess with the best" tag + neon
  R.onWall('w', new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.8), new THREE.MeshBasicMaterial({ map: P.graffiti('MESS WITH THE BEST', '#ff4fd8', '#ffcf8a'), transparent: true, toneMapped: false, depthWrite: false })), -4.6, 1.5, 0.03);
  R.onWall('e', new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), P.additive(TX.neon('cyberdelia', '#3ff0ff'))), 4.2, 2.4, 0.04);
  // ----- north (free-standing): DJ booth + dance floor, arcade corner, handle kiosk, rollerblade rack
  const dj = st(P.djBooth(), -5.5, 0, -6.2, 0, true);
  const plats = dj.userData.platters;
  for (const p of plats) { const wp = p.position.clone(); dj.remove(p); live(p, -5.5 + wp.x, wp.y, -6.2 + wp.z); }
  const clubTick = addClub(R, st, live);
  const cabScr = new THREE.MeshBasicMaterial({ map: scrTex, color: '#c87ab8', toneMapped: false });
  const termScr = new THREE.MeshBasicMaterial({ map: TX.termScreen(4), toneMapped: false });
  st(P.cabinet(cabScr, mat('#b0308f', { roughness: 0.4 })), 3.4, 0, -6.4, 0, true); st(P.cabinet(cabScr, P.VINYL), 4.4, 0, -6.4, 0, true);
  st(P.cabinet(termScr, mat('#3a8a2a', { roughness: 0.4 })), 6.2, 0, -6.4, 0, true);
  st(new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.55), P.additive(TX.neon('SLIPSTREAM', '#ff4fd8'))), 3.9, 2.25, -6.88);
  st(new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.35), P.additive(TX.neon('HANDLE.EXE', '#9dff3d'))), 6.2, 2.15, -6.88);
  const sk = P.bladeRack(); st(sk.rail, 9.0, 0, -6.5, 0, true); live(sk.boots, 0, 0, 0); live(sk.wheels, 0, 0, 0); P.poseSkates(sk, 8.4, 0.93, -6.5, () => [0, 0]);
  // ----- lounge west: sofa along the wall, beanbags, spool table, laptops
  const SH = P.shells();
  st(P.sofa(2.4, P.VINYL), -10.2, 0, 4.5, H, true);
  st(P.spoolTable(), -8.8, 0, 4.5, 0, true);
  st(P.laptop(SH[0]), -8.85, 0.45, 4.25, -H);
  st(P.beanbag(P.TEAL), -7.6, 0, 3.6, 0, true); st(P.beanbag(mat('#8a2a6a', { roughness: 0.8 })), -7.6, 0, 5.4, 0, true);
  // ----- lounge south: sofa facing north, spool table
  st(P.sofa(2.6, P.TEAL), 3.6, 0, 6.1, PI, true);
  st(P.spoolTable(), 3.6, 0, 4.8, 0, true); st(P.laptop(SH[1]), 3.3, 0.45, 4.8, PI);
  // ----- high bar east
  st(P.highBar(3.6), 8.0, 0, 3.2, 0, true);
  for (const x of [6.8, 8.0, 9.2]) st(P.stool(), x, 0, 3.95);
  st(P.laptop(SH[2]), 6.8, 1.05, 3.2, PI); st(P.laptop(SH[0]), 9.2, 1.05, 3.2, PI);
  // clutter: pizza box, cans (scattered), cable runs
  const can = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.035, 0.035, 0.12, 8), mat('#c8d0d8', { metalness: 0.7, roughness: 0.3 }), 10);
  { const m = new THREE.Matrix4(), r = TX.rand(5); for (let i = 0; i < 10; i++) { m.makeTranslation(-9 + r() * 18, 0.06, -2 + r() * 8); can.setMatrixAt(i, m); } st(can, 0, 0, 0); }
  const pzBox = flatM(rbox(0.45, 0.05, 0.45, mat('#c8a060'), 0.01), -6.6, 0.025, 6.2, 0.4);
  const sodaCan = flatM(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.12, 8), mat('#e63946', { metalness: 0.6, roughness: 0.3 })), 8.0, 1.11, 3.0);
  // ----- glows + pools (readability)
  const pools = [[-5.5, -3.6, '#ff4fd8', 3], [-9, -3, '#3ff0ff', 3.4], [8, 3.6, '#ffb36b', 3.4], [-8.6, 4.5, '#ffcf8a', 3.2], [3.6, 5, '#9dff3d', 2.6], [4.6, -4.8, '#ff4fd8', 2.6]];
  const lampG = [live(FX.glow('#ffcf8a', 1.0, 0.5), -8.6, 2.2, 4.5), live(FX.glow('#ffb36b', 1.0, 0.5), 8.0, 2.4, 3.2)];
  for (const [x, z] of [[-8.6, 4.5], [8.0, 3.2]]) { st(new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 1.0, 4), P.METAL), x, 2.7, z); st(new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.25, 14, 1, true), mat('#3ff0ff', { side: THREE.DoubleSide })), x, 2.2, z); }
  // wall washes behind neon/graffiti/CRTs, arcade + DJ spill on the floor (1 draw call, static)
  live(P.glowPlanes([
    [3.9, 2.2, -6.93, 0, 3.4, 1.5, '#ff4fd8'], [6.2, 2.1, -6.93, 0, 2.2, 1.1, '#9dff3d'], [-10.9, 2.45, 3.6, H, 5.5, 2.0, '#9dff3d'], [-10.9, 1.5, 4.6, H, 4, 1.4, '#ff4fd8'],
    [-9.4, 0.03, -3.2, 0, 2.6, 5.2, '#3ff0ff', true], [3.9, 0.03, -5.4, 0, 1.8, 1.6, '#c87ab8', true], [6.2, 0.03, -5.4, 0, 1.2, 1.4, '#9dff3d', true],
    [-5.5, 0.03, -5.2, 0, 3.4, 1.4, '#ff4fd8', true], [-3.6, 0.03, 2.2, 0, 2.8, 1.6, '#9dff3d', true],
    ...pools.filter(p => p[0] !== -5.5).map(([x, z, c, s]) => [x, 0.011, z, 0, s, s, c, true])], 0.3), 0, 0, 0);
  R.live.add(FX.motes(24, new THREE.Vector3(-10, 0.4, -6), new THREE.Vector3(10, 2.6, 6), '#ff9ff0', 0.04));
  // ----- lights: 4 keys
  R.rig = lightRig(R.root, { room: R, sky: '#8a7ab8', ground: '#4a3a5a', ambient: 3.6, moon: '#8fa8ff', moonI: 1.0, moonFrom: [-9, 8, -2], points: [
    { x: -5.5, y: 2.4, z: -4.2, color: '#ff4fd8', i: 8, d: 8 },
    { x: -8.6, y: 1.8, z: -3.0, color: '#3ff0ff', i: 7, d: 8 },
    { x: 8.0, y: 2.2, z: 3.4, color: '#ffb36b', i: 8, d: 8 },
    { x: -8.6, y: 2.0, z: 4.5, color: '#ffcf8a', i: 7, d: 8 }] });
  R.meta = { id: 'hackers', name: 'Club Cyberdelia', blurb: 'Hack the planet. Rollerblades optional.' };
  R.spawn = { x: 0, z: 0.5, face: 0 };
  const sit = (id, x, z, face, prop, label, y = 0, anim = 'Sit_Chair_Idle') => ({ id, kind: anim === 'Idle' ? 'stand' : 'seat', x, z, y, face, anim, prop, label });
  R.slots = [
    sit('sofa-w1', -9.95, 3.8, H, 'laptop', 'Vinyl sofa'), sit('sofa-w2', -9.95, 4.5, H, 'laptop', 'Vinyl sofa'), sit('sofa-w3', -9.95, 5.2, H, 'beer', 'Vinyl sofa'),
    sit('bean-1', -7.6, 3.6, -H, 'laptop', 'Beanbag', 0.15, 'Sit_Floor_Idle'), sit('bean-2', -7.6, 5.4, -H, 'controller', 'Beanbag', 0.15, 'Sit_Floor_Idle'),
    sit('sofa-s1', 2.8, 5.85, PI, 'laptop', 'Teal sofa'), sit('sofa-s2', 3.6, 5.85, PI, 'laptop', 'Teal sofa'), sit('sofa-s3', 4.4, 5.85, PI, 'phone', 'Teal sofa'),
    sit('stool-1', 6.8, 3.95, PI, 'laptop', 'Bar stool', 0.28), sit('stool-2', 8.0, 3.95, PI, 'beer', 'Bar stool', 0.28), sit('stool-3', 9.2, 3.95, PI, 'laptop', 'Bar stool', 0.28),
    sit('arcade-watch', 4.9, -4.9, PI, 'beer', 'Watching the race', 0, 'Idle'), sit('dance-1', -6.9, -4.2, PI, 'phone', 'On the dance floor', 0.09, 'Idle'), sit('dance-2', -5.3, -3.0, -2.6, 'beer', 'On the dance floor', 0.09, 'Idle'),
    sit('dance-3', -4.1, -4.4, 2.8, 'beer', 'On the dance floor', 0.09, 'Idle'), sit('dance-4', -6.3, -2.6, 2.6, 'phone', 'Dancing near the decks', 0.09, 'Idle'),
    sit('bean-free', -6.7, 4.5, -H, null, 'Beanbag pile', 0.12, 'Sit_Floor_Idle'),
    sit('rail', -3.6, 3.2, PI, 'beer', 'Watching the grind box', 0, 'Idle')];
  R.interact = [
    { id: 'gibson', x: -9.4, z: -3.2, r: 1.4, label: 'Hack the Gibson', kind: 'pc' },
    { id: 'slipstream', x: 3.9, z: -5.5, r: 1.1, label: 'Play SLIPSTREAM', kind: 'arcade' },
    { id: 'payphone', x: -9.9, z: 0.5, r: 1.0, label: 'Phreak the payphone', kind: 'gadget' },
    { id: 'handle', x: 6.2, z: -5.5, r: 0.9, label: 'Pick a handle', kind: 'pc' },
    { id: 'blades', x: 9.0, z: -5.6, r: 1.0, label: 'Grab rollerblades', kind: 'gadget', sfx: false },
    { id: 'decks', x: -5.5, z: -5.3, r: 1.1, label: 'Spin the decks', kind: 'gadget', sfx: false },
    { id: 'mess', x: -9.3, z: 2.6, r: 1.2, label: 'Read the tag', kind: 'gadget', sfx: false },
    { id: 'crts', x: -9.6, z: -1.2, r: 0.8, label: 'Whack a CRT', kind: 'gadget', sfx: false },
    { id: 'grind', x: -3.6, z: 1.5, r: 1.0, label: 'Grind the box', kind: 'gadget', sfx: false },
    { id: 'cans', x: 8.0, z: 2.5, r: 0.9, label: 'Crack a soda', kind: 'gadget', sfx: false },
    { id: 'pizzabox', x: -6.6, z: 6.0, r: 0.7, label: 'Check the pizza box', kind: 'gadget', sfx: false }];
  R.npc = null;
  R.camera = { zoom: 7.5, target: new THREE.Vector3(0, 0.8, 0) };
  // in-world reactions (also fired by act/hackers.js)
  let now = 0; const fx = { blades: -99, decks: -99, mess: -99, phone: -99, gibson: -99 };
  const at = (x, z, o = {}) => ({ ...o, at: { x: x + R.root.position.x, z: z + R.root.position.z } });
  const SND = {
    blades: () => { SFX.play('rattle', at(9, -6.5)); SFX.play('swoosh', at(9, -6.5, { delay: 0.3 })); SFX.play('thud', at(9, -6.5, { delay: 0.7, vol: 0.5 })); },
    decks: () => { SFX.play('cyb.scratch', at(-5.5, -6.2)); SFX.play('vinyl', at(-5.5, -6.2, { delay: 0.35 })); SFX.play('chord', at(-5.5, -6.2, { delay: 0.6, vol: 0.6 })); },
    mess: () => { SFX.play('cyb.spray', at(-10.5, 3.6)); },
    gibson: () => { SFX.play('crt.on', at(-10.5, -3.2)); SFX.play('hum', at(-10.5, -3.2, { delay: 0.2, vol: 0.6 })); },
    phone: () => { SFX.play('phone.pickup', at(-10.5, 0.5)); SFX.play('dial', at(-10.5, 0.5, { delay: 0.3, vol: 0.6 })); },
  };
  R.hackers = { fire: id => { fx[id] = now; SND[id]?.(); } };
  const EXTRA = {
    crts: ['static', 'crt.on', 'Thwack. Picture fixed itself.', 'gibson'], grind: ['swoosh', 'thud', 'Kickflip... nailed it. Mostly.', null],
    cans: ['can', 'fizz', 'Tssk. Jolt Cola, maximum caffeine.', null], pizzabox: ['paper', 'sting', 'Empty. Someone ate the last slice.', null],
  };
  const EXAT = { crts: [-10.5, -1.5], grind: [-3.6, 2.2], cans: [8, 3.2], pizzabox: [-6.6, 6.2] };
  const PK = poker(), POKE = { crts: [crt, 'wiggle', 0.8, 0.25], grind: [R.grindBox, 'hop', 0.9, 2], cans: [sodaCan, 'spin', 0.9, 1], pizzabox: [pzBox, 'lift', 1.0, 1] };
  R.onInteract = (id, api) => {
    if (POKE[id]) { const [o, k, d, a] = POKE[id]; PK.poke(o, /** @type {any} */ (k), d, a); }
    if (id in fx) { fx[id] = now; SND[id]?.(); api.bubble(id === 'mess' ? 'Mess with the best...' : id === 'decks' ? 'Wicka-wicka!' : 'Rollerblades on.'); return; }
    const e = EXTRA[id]; if (!e) return; const [x, z] = EXAT[id];
    SFX.play(e[0], at(x, z)); SFX.play(e[1], at(x, z, { delay: 0.3, vol: 0.6 })); if (e[3]) fx[e[3]] = now; api.bubble(e[2]);
  };
  const base = R.rig.points.map(p => p.intensity);
  R.finish();
  R.root.traverse(o => { if (o.isMesh && o.parent === R.static) o.castShadow = false; });
  for (const o of [crt.userData.screens, sk.boots, sk.wheels, ...plats]) o.castShadow = false;
  let acc = 0; const scr = crt.userData.screens; void glowMat;
  R.tick = (t, dt) => {
    now = t; PK.tick(t); acc += dt; if (acc > 0.6) { acc = 0; drawScr(); }
    const L = R.rig.points, beat = 0.5 + 0.5 * Math.sin(t * 3.1);
    const dk = t - fx.decks < 3 ? 2.6 : 1;
    for (const p of plats) p.rotation.y -= dt * 3.5 * dk;
    clubTick(t, dk > 1 ? 1.8 : 1); L[0].intensity = base[0] * (0.75 + 0.35 * beat * dk);
    L[1].intensity = base[1] * (0.95 + 0.05 * Math.sin(t * 1.9)) * (t - fx.gibson < 2 ? 1.6 : 1);
    const bs = t - fx.blades; if (bs < 2.1) P.poseSkates(sk, 8.4, 0.93, -6.5, i => bs < 2 ? [Math.abs(Math.sin(bs * 10 + i)) * 0.12 * (1 - bs / 2), Math.sin(bs * 14 + i) * 0.35 * (1 - bs / 2)] : [0, 0]);
    const ps = t - fx.phone; for (const p of ppL) p.position.x = ps < 1 ? (p === ppL[0] ? -0.15 : -0.85) + Math.sin(ps * 80) * 0.01 : (p === ppL[0] ? -0.15 : -0.85);
    grafM.opacity = t - fx.mess < 2 ? 0.6 + 0.4 * Math.cos((t - fx.mess) * 3.4) : 1;
    for (const g of lampG) g.material.opacity = 0.45;
    void scr;
  };
  return R;
}
