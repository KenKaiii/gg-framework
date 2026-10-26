// @ts-check
// The Computer Lab: a late-night retro LAN-party lab. Two rows of beige CRT PCs on long desks (instanced), a server
// rack with blinking LEDs, a dot-matrix printer, Prompt School terminal, whiteboard, vending machine, beanbag LAN corner.
// Local frame x -9..9, z -7..7. n (hawkins) + w (hackers) walls belong to the neighbours: free-standing pieces only.
import * as THREE from 'three';
import { makeRoom, lightRig, mat, put, rbox } from './kit.js';
import * as FX from './kit-fx.js';
import * as TX from './tex.js';
import * as P from './computer-props.js';
import { glowPlanes } from './hackers-props.js';
import { poker } from './screening-poke.js';
import { solid1 } from './hackers-solid.js';
import { SFX } from '../sfx.js';

// dot-matrix printer: a quick run of soft buzzy needle bursts
SFX.define('lab.print', (o, t, p, K) => { for (let i = 0; i < 6; i++) K.hiss(o, t + i * 0.11, { ft: 'bandpass', f: 1800 * p, q: 4, v: 0.08, a: 0.005, d: 0.08 }); });

const PI = Math.PI;
const ROW1 = -3.6, ROW2 = 1.8, XS = [-6.2, -4.6, -3.0, 3.0, 4.6, 6.2];

/** @param {any} ctx */
export function build(ctx) {
  void ctx;
  const R = /** @type {any} */ (makeRoom({ id: 'computer', floor: P.labFloor(), floorRepeat: 3, wall: TX.plaster('#4a4a6a', 41), trim: '#2a2440', base: '#1e1a28' }));
  const S = R.static;
  const st = (o, x, y, z, ry = 0, block = true) => { put(S, o, x, y, z, ry); if (block) R.blockObj(o); return o; };
  const live = (o, x, y, z, ry = 0) => { put(R.live, o, x, y, z, ry); o.traverse(c => { c.userData.live = true; }); return o; };
  const flatM = (o, x, y, z, ry = 0) => { live(o, x, y, z, ry); o.castShadow = false; return o; };
  // ----- desks + instanced PC stations (screens face +z, chairs on the +z side)
  for (const z of [ROW1, ROW2]) for (const x of [-4.6, 4.6]) st(P.desk(4.8), x, 0, z);
  const list = []; for (const z of [ROW1, ROW2]) for (const x of XS) list.push([x, z, 0]);
  const pcs = P.stations(list); R.live.add(pcs);
  for (const z of [ROW1, ROW2]) for (const x of XS) R.block(x - 0.25, z + 0.7, x + 0.25, z + 1.1);
  // desk lamps + floppies + cans on the desks
  const lampAt = [[-7.0, ROW1], [-2.3, ROW1], [2.3, ROW1], [7.0, ROW1], [-7.0, ROW2], [-2.3, ROW2], [2.3, ROW2], [7.0, ROW2]];
  for (const [x, z] of lampAt) st(P.deskLamp(), x, 0.755, z - 0.1, 0, false);
  for (const [x, z] of [[-5.4, ROW1], [3.8, ROW2], [5.4, ROW1]]) st(P.floppies(), x, 0.755, z + 0.25, 0.3, false);
  { const can = mat('#3ddc84', { metalness: 0.6, roughness: 0.3 }), can2 = mat('#e63946', { metalness: 0.6, roughness: 0.3 });
    const g = new THREE.CylinderGeometry(0.035, 0.035, 0.12, 10);
    [[-3.8, ROW1, can], [5.4, ROW2, can2], [-5.4, ROW2, can], [3.8, ROW1, can2], [-1.0, 5.6, can], [-6.6, 5.3, can2]].forEach(([x, z, m]) => st(new THREE.Mesh(g, m), x, (z > 4 ? 0.06 : 0.82), z + (z > 4 ? 0 : 0.3), 0, false)); }
  // ----- back zone: server racks, printer, Prompt School terminal, whiteboard, vending
  const racks = new THREE.Group(); put(racks, P.rack(), -0.5, 0, 0); put(racks, P.rack(), 0.5, 0, 0); live(solid1((racks)), -7.6, 0, -6.3); R.blockObj(racks);
  const ledM = new THREE.MeshBasicMaterial({ map: P.ledTex(), transparent: true, toneMapped: false, blending: THREE.AdditiveBlending, depthWrite: false });
  const leds = [-8.1, -7.1].map(x => { const m = live(new THREE.Mesh(new THREE.PlaneGeometry(0.7, 1.7), ledM), x, 1.1, -5.85); return m; });
  st(P.printerStand(), -5.4, 0, -6.4);
  const paper = live(rbox(0.4, 0.01, 0.5, mat('#f0ead4', { roughness: 0.9 }), 0.004), -5.4, 0.92, -6.1); paper.visible = false;
  st(P.terminalStand(), -3.1, 0, -6.4);
  const wbd = live(solid1((P.whiteboard())), 3.4, 0, -6.5); R.blockObj(wbd);
  st(P.vending(), 7.9, 0, -6.4);
  // IT Helpdesk: a proper free-standing sign board (framed, two legs, lit face) by the east desks
  { const sg = new THREE.Group(), fr = mat('#2a2440', { roughness: 0.5 });
    for (const x of [-0.6, 0.6]) { put(sg, rbox(0.07, 1.9, 0.07, P.METAL, 0.02), x, 0.95, 0); put(sg, rbox(0.12, 0.05, 0.5, P.METAL, 0.02), x, 0.025, 0); }
    put(sg, rbox(1.45, 0.62, 0.1, fr, 0.04), 0, 1.6, 0);
    put(sg, new THREE.Mesh(new THREE.PlaneGeometry(1.32, 0.5), new THREE.MeshBasicMaterial({ map: TX.label('IT HELPDESK', '#ffcf8a', '#3a2a5a', 512, 192, '96px m5x7'), toneMapped: false })), 0, 1.6, 0.062);
    put(sg, rbox(0.9, 0.22, 0.06, mat('#c8b890'), 0.02), 0, 1.13, 0.0);
    put(sg, new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.17), new THREE.MeshBasicMaterial({ map: TX.label('off & on again?', '#2a2440', '#e8dcb8', 256, 52, '45px m5x7') })), 0, 1.13, 0.042);
    st(sg, 8.1, 0, -2.6, 0.75); }
  // which lab PCs are playable: small lit tent cards on the desk
  const tent = (txt, x, z) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.14), new THREE.MeshBasicMaterial({ map: TX.label(txt, '#0a1a10', '#6ee7a0', 256, 72, '60px m5x7'), toneMapped: false })); m.rotation.x = -0.5; st(m, x, 0.84, z, 0, false); };
  tent('GAMES', -3.0, ROW2 + 0.42); tent('TYPE RACE', 3.0, ROW2 + 0.42);
  // ----- front LAN corner: low table, pizza boxes, beanbags (low, front is cut)
  const pizza = mat('#c8a070', { roughness: 0.9 });
  st(rbox(2.4, 0.38, 1.1, P.WOOD, 0.05), -5.0, 0.19, 5.3);
  st(rbox(0.55, 0.06, 0.55, pizza, 0.01), -5.6, 0.41, 5.2, 0.2, false); const pzTop = flatM(rbox(0.55, 0.06, 0.55, pizza, 0.01), -5.5, 0.47, 5.25, -0.1);
  { const tp = P.crtPC(new THREE.MeshBasicMaterial({ map: P.osScreen(1), toneMapped: false }), { w: 0.46, h: 0.38, keys: false }); st(tp, -4.4, 0.38, 5.12, 0, false); } // Oregon Commit LAN PC (close-up)
  const bean = (c, x, z) => { const b = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 10), mat(c, { roughness: 0.95 })); b.scale.set(1, 0.55, 1); st(b, x, 0.25, z); };
  bean('#b04fd8', -7.2, 4.8); bean('#3d6ad8', -2.8, 4.8); bean('#e0a458', -1.0, 6.0);
  // rug under the LAN corner
  { const rg = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), mat('#ffffff', { map: TX.rug('stripe', '#3a2a5a', '#5a3a7a') })); rg.rotation.x = -PI / 2; rg.material.polygonOffset = true; rg.material.polygonOffsetFactor = -1; rg.material.polygonOffsetUnits = -2; st(rg, -4.8, 0.01, 5.3, 0, false); }
  // ----- ceiling-ish pendant glows over the desk rows + floor pools (readable, not dark)
  // one instanced additive mesh: warm pools under the desk rows, CRT spill on the desk tops + floor in front of every
  // screen, rack LED wash on floor, vending glow, LAN corner pool, whiteboard wash (static: cannot flicker)
  { const gl = []; for (const z of [ROW1 + 1.2, ROW2 + 1.2]) for (const x of [-4.6, 4.6]) gl.push([x, 0.012, z, 0, 5, 5, '#a08a5a', true]);
    for (const [x, z] of list) gl.push([x, 0.762, z + 0.3, 0, 0.9, 0.7, '#3aa0a0', true], [x, 0.013, z + 1.0, 0, 1.4, 1.2, '#1f6a6a', true]);
    gl.push([-7.6, 0.012, -5.2, 0, 3, 3, '#2a9a5c', true], [7.9, 0.012, -5.4, 0, 2.6, 2.6, '#a03a8a', true], [-4.8, 0.012, 5.3, 0, 4, 4, '#a0703a', true], [-7.6, 0.012, -5.6, 0, 2.2, 1.0, '#3ddc84', true]);
    live(glowPlanes(gl, 0.42), 0, 0, 0); }
  const lampG = lampAt.map(([x, z]) => put(R.live, FX.glow('#ffcf8a', 0.7, 0.5), x, 1.05, z));
  live(FX.glow('#3ddc84', 1.4, 0.35), -7.6, 1.2, -5.7); live(FX.glow('#ff8fd8', 1.3, 0.3), 7.8, 1.2, -5.9);
  R.live.add(FX.motes(24, new THREE.Vector3(-8.5, 0.4, -6.5), new THREE.Vector3(8.5, 2.6, 6.5), '#ffe0b0', 0.03));
  // ----- lights
  R.rig = lightRig(R.root, { room: R, sky: '#8a86b8', ground: '#4a3a40', ambient: 3.6, moon: '#8fa8ff', moonI: 1.0, moonFrom: [-9, 10, -4], points: [
    { x: -4.6, y: 2.4, z: -1.6, color: '#ffcf8a', i: 9, d: 10 },
    { x: 4.6, y: 2.4, z: 1.0, color: '#ffcf8a', i: 9, d: 10 },
    { x: -7.4, y: 1.6, z: -5.2, color: '#3ddc84', i: 4, d: 5 },
    { x: -4.8, y: 1.8, z: 5.0, color: '#ffb36b', i: 6, d: 7 }] });
  R.meta = { id: 'computer', name: 'The Computer Lab', blurb: 'Beige CRTs, LAN parties and Prompt School.' };
  R.spawn = { x: 0, z: 0, face: PI };
  // ----- slots: 12 PCs; two are activities (desktop + typing race), the rest are member seats
  R.slots = [];
  list.forEach(([x, z], i) => {
    const s = { id: 'pc-' + i, kind: 'chair', x, z: z + 0.9, y: 0.03, face: PI, anim: 'Sit_Chair_Idle', label: 'Lab PC ' + (i + 1) };
    if (i === 8) Object.assign(s, { act: 'computer-desktop', actLabel: 'Use the PC' });
    else if (i === 9) Object.assign(s, { act: 'computer-typing', actLabel: 'Typing race' });
    R.slots.push(s);
  });
  R.slots.push({ id: 'bean-a', kind: 'beanbag', x: -7.2, z: 4.8, y: 0.2, face: 1.2, anim: 'Sit_Floor_Idle', prop: 'controller', label: 'Beanbag' },
    { id: 'vend', kind: 'stand', x: 6.9, z: -5.2, face: 2.6, anim: 'Idle', prop: 'phone', label: 'By the vending machine' },
    { id: 'bean-b', kind: 'beanbag', x: -2.8, z: 4.8, y: 0.2, face: -1.2, anim: 'Sit_Floor_Idle', label: 'Beanbag' },
    { id: 'bean-c', kind: 'beanbag', x: -1.0, z: 6.0, y: 0.2, face: -2.2, anim: 'Sit_Floor_Idle', label: 'Beanbag' },
    { id: 'wb', kind: 'stand', x: 2.4, z: -5.4, face: 2.6, anim: 'Idle', prop: 'mug', label: 'Reading the whiteboard' });
  R.interact = [
    { id: 'prompt', x: -3.1, z: -5.6, r: 1.0, label: 'Prompt School', kind: 'pc' },
    { id: 'printer', x: -5.4, z: -5.6, r: 0.9, label: 'Print something', kind: 'gadget', sfx: false },
    { id: 'rack', x: -7.6, z: -5.5, r: 1.0, label: 'Check the servers', kind: 'gadget', sfx: false },
    { id: 'vending', x: 7.9, z: -5.5, r: 1.0, label: 'Vending machine', kind: 'gadget', sfx: false },
    { id: 'helpdesk', x: 7.6, z: -1.8, r: 1.0, label: 'IT Helpdesk', kind: 'gadget', sfx: false },
    { id: 'whiteboard', x: 3.4, z: -5.6, r: 1.0, label: 'Doodle on the whiteboard', kind: 'gadget', sfx: false },
    { id: 'pizza', x: -5.5, z: 4.5, r: 0.8, label: 'Grab a cold slice', kind: 'gadget', sfx: false },
    { id: 'trail', x: -4.4, z: 4.4, r: 1.0, label: 'Play Oregon Commit', kind: 'pc' }];
  R.npc = null;
  R.camera = { zoom: 7, target: new THREE.Vector3(0, 0.8, 0) };
  let now = 0, printAt = -99, rackAt = -99, vendAt = -99, rebootAt = -99;
  const can = live(rbox(0.07, 0.12, 0.07, mat('#3ddc84', { metalness: 0.6 }), 0.02), 7.8, 0.35, -5.9); can.visible = false;
  const PK = poker(), POKE = { rack: [racks, 'wiggle', 1.0, 0.3], whiteboard: [wbd, 'wiggle', 0.9, 0.35], pizza: [pzTop, 'lift', 1.0, 1] };
  R.onInteract = (id, api) => {
    if (POKE[id]) { const [o, k, d, a] = POKE[id]; PK.poke(o, /** @type {any} */ (k), d, a); }
    const at = (x, z) => ({ at: { x: x + R.root.position.x, z: z + R.root.position.z } });
    if (id === 'printer') { SFX.play('lab.print', at(-5.4, -6.2)); SFX.play('paper', { ...at(-5.4, -6.2), delay: 0.8 }); printAt = now; api.bubble('KRRZZT KRRZZT KRRZZT'); }
    else if (id === 'rack') { rackAt = now; SFX.play('hum', at(-7.6, -6.2)); SFX.play('blip', { ...at(-7.6, -6.2), delay: 0.2 }); SFX.play('blip', { ...at(-7.6, -6.2), delay: 0.45, pitch: 1.3 }); api.toast('Uptime 9,999 days. Do not touch the red cable.'); }
    else if (id === 'vending') { vendAt = now; SFX.play('ui.click', at(7.9, -6.2)); SFX.play('thud', { ...at(7.9, -6.2), delay: 0.35 }); SFX.play('can', { ...at(7.9, -6.2), delay: 0.7 }); api.bubble('*clunk* Club-Mate dispensed.'); }
    else if (id === 'helpdesk') { rebootAt = now; SFX.play('ping', at(8.1, -2.6)); SFX.play('crt.off', { delay: 0.1 }); SFX.play('pc.boot', { delay: 0.9, vol: 0.7 }); api.toast('Have you tried turning it off and on again?'); }
    else if (id === 'whiteboard') { SFX.play('squeak', at(3.4, -6.4)); SFX.play('squeak', { ...at(3.4, -6.4), delay: 0.25, pitch: 1.2 }); api.bubble('Draws a box. Labels it "the cloud".'); }
    else if (id === 'pizza') { SFX.play('paper', at(-5.5, 5.2)); SFX.play('pop', { ...at(-5.5, 5.2), delay: 0.3 }); api.bubble('Cold pizza. Peak LAN cuisine.'); }
  };
  R.computer = { fire: id => R.onInteract(id, { toast() {}, bubble() {} }) };
  const base = R.rig.points.map(p => p.intensity);
  R.finish();
  R.root.traverse(o => { if (o.isMesh && o.parent === R.static) o.castShadow = false; });
  const scr = pcs.userData.screens;
  R.tick = (t) => {
    now = t; PK.tick(t);
    const L = R.rig.points; L[2].intensity = base[2] * (0.88 + 0.12 * Math.sin(t * 2.4));
    ledM.opacity = 0.8 + 0.2 * Math.sin(t * 2.4); // gentle shared pulse (was a fast blink + texture jump)
    const rk = t - rackAt; if (rk >= 0 && rk < 2) ledM.color.setHSL(rk * 2 % 1, 1, 0.6); else ledM.color.set('#ffffff');
    lampG.forEach((g, i) => { g.material.opacity = 0.45; void i; });
    const ps = t - printAt; paper.visible = ps >= 0 && ps < 4; if (paper.visible) { paper.scale.z = Math.min(3, ps * 1.2); paper.position.z = -6.1 + paper.scale.z * 0.25; }
    const vs = t - vendAt; can.visible = vs >= 0 && vs < 3; if (can.visible) can.position.y = Math.max(0.35, 1.4 - vs * 3);
    const rb = t - rebootAt; scr.visible = !(rb >= 0 && rb < 0.9); // one clean off/on, no strobe
  };
  return R;
}
