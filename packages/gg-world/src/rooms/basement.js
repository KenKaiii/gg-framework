// @ts-check
// The Basement: hacker den / homelab. Concrete, cinder block, pipes, server racks, a mining rig,
// a wall of monitors + green CRT, workbench, leather armchair, couch, energy-drink fridge.
import { SFX } from '../sfx.js';
import { roomGlow } from './bar-glow.js';
import * as THREE from 'three';
import { makeRoom, lightRig, glowMat, rbox, put, mesh, rng } from './kit.js';
import * as TX from './tex.js';
import * as FX from './kit-fx.js';
import * as P from './basement-props.js';
import * as Z from './basement-zones.js';
import { roomInfo } from './floorplan.js';
const mat = P.mat;

/** @param {any} ctx */
export function build(ctx) {
  const info = /** @type {any} */ (roomInfo('basement')); const up = info.stairs[0], SX = 1.8;
  const R = makeRoom({ id: 'basement', floor: TX.plaster('#4a4850', 21), floorRepeat: 3, wall: TX.brick('#4a4050', '#262030', 31),
    trim: '#2a2530', base: '#141218', slab: '#141019',
    doors: [{ side: 'n', at: SX, w: 1.2, to: up.to, label: up.label, glow: '#b04fd8' }] });
  const S = R.static, L = R.live, pipeM = mat('#5a4a40', { metalness: 0.6, roughness: 0.4 }), W2 = R.w / 2, D2 = R.d / 2;
  // --- stairwell up to the den, seen through the door
  const sw = Z.stairwell(R, SX, 1.2); sw.g.add(sw.bulb); sw.g.position.z = R.d / 2; R.walls.n.full.add(sw.g); // hides with the wall's cut-away
  sw.halo.position.z += R.d / 2; R.walls.n.full.add(sw.halo);
  R.onWall('n', rbox(0.5, 0.12, 0.02, glowMat('#3ddc84', 1.6), 0.01), SX + 1.0, 1.6, 0.03); // EXIT-ish green tag
  // --- ceiling-edge pipes + cable tray on the back walls
  for (const [side, len] of [['n', R.w], ['w', R.d]]) {
    for (const [y, out, r] of [[2.95, 0.12, 0.06], [2.75, 0.1, 0.035]]) { const p = mesh(new THREE.CylinderGeometry(r, r, len, 10), pipeM); p.rotation.z = Math.PI / 2; R.onWall(side, p, 0, y, out); }
    R.onWall(side, rbox(len, 0.05, 0.22, mat('#3a3d44', { metalness: 0.6, roughness: 0.5 }), 0.01), 0, 2.55, 0.16);
    for (let i = 0; i < 3; i++) { const c = mesh(new THREE.CylinderGeometry(0.02, 0.02, len, 6), mat(['#1a1a1a', '#2a4a6a', '#2d6a3a'][i])); c.rotation.z = Math.PI / 2; R.onWall(side, c, 0, 2.6, 0.1 + i * 0.05); }
  }
  // --- small high windows at lawn level (window wells): grass blades against the sky; outside.js tints them to the time of day
  const wellT = TX.canvasTex('bs-well', 256, 96, (x, w, h) => { const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#ffffff'); g.addColorStop(0.6, '#c8d0d8'); x.fillStyle = g; x.fillRect(0, 0, w, h);
    const r = TX.rand(7); x.fillStyle = '#4a6a3a'; x.fillRect(0, h * 0.72, w, h); for (let i = 0; i < 220; i++) { const bx = r() * w, bh = 10 + r() * 30; x.strokeStyle = r() < 0.5 ? '#3a5a2e' : '#5a7a44'; x.lineWidth = 1.5; x.beginPath(); x.moveTo(bx, h); x.quadraticCurveTo(bx + (r() - 0.5) * 6, h - bh * 0.6, bx + (r() - 0.5) * 12, h - bh - h * 0.2); x.stroke(); }
    x.fillStyle = '#6a6460'; x.fillRect(0, h * 0.9, w, h); });
  const frameM = mat('#3a3a40', { roughness: 0.9 }), sillM = mat('#7a7670', { roughness: 1 }), glassM = new THREE.MeshBasicMaterial({ map: wellT, color: '#3a4258', toneMapped: false });
  for (const wx of [-1.0, 3.2, 6.5]) { const wg = new THREE.Group();
    put(wg, rbox(0.98, 0.42, 0.1, frameM, 0.02), 0, 0, 0.0); const gl = put(wg, mesh(new THREE.PlaneGeometry(0.86, 0.3), glassM), 0, 0, 0.052); gl.name = 'basement-window'; gl.castShadow = false;
    put(wg, rbox(0.03, 0.3, 0.03, frameM, 0.005), 0, 0, 0.06); put(wg, rbox(1.06, 0.05, 0.2, sillM, 0.01), 0, -0.235, 0.06);
    R.onWall('n', wg, wx, 2.2, 0.03); }
  const winGlow = FX.glow('#9fb4d8', 1.4, 0.12); winGlow.position.set(3.2, 2.0, -D2 + 0.4); L.add(winGlow);
  // --- floor cable runs: racks to the hack table, bundled and taped down
  const cab = (pts, c, rr = 0.018) => S.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p))), 40, rr, 6), mat(c, { roughness: 0.6 })));
  for (const [i, c] of [[0, '#1a1a1a'], [1, '#2a4a6a'], [2, '#c86a1e']]) cab([[-6.1 + i * 0.1, 0.02, -D2 + 1.0], [-5.6, 0.02, -4.0 + i * 0.05], [-4.6, 0.02, -2.0 + i * 0.08], [-3.4, 0.02, -0.1 + i * 0.06], [-2.6 + i * 0.05, 0.02, 0.45]], c);
  for (const [x, z] of [[-5.3, -3.4], [-4.1, -1.2]]) put(S, rbox(0.12, 0.012, 0.26, mat('#8a8070', { roughness: 1 }), 0.002), x, 0.03, z, 0.6); // gaffer tape
  // --- rugs: lounge + beanbag corner
  for (const [x, z, w, d, k, a, b, c, sd] of [[3.4, 2.9, 4.2, 3.2, 'persian', '#3a2430', '#5a3a3a', '#8a6a4a', 9], [-3.0, 4.3, 2.6, 1.8, 'persian', '#1e2a44', '#2a4a6a', '#9a7a2e', 4]]) {
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat('#ffffff', { map: TX.rug(k, a, b, c, sd), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 })); rug.rotation.x = -Math.PI / 2; rug.position.set(x, 0.014, z); rug.userData.noGround = true; rug.receiveShadow = true; S.add(rug); }

  // --- server racks: a row on the north wall + a second row on the west wall
  const racks = [];
  [-7.3, -6.66, -6.02].forEach((x, i) => { const r = P.serverRack(3 + i * 5); put(S, r.g, x, 0, -D2 + 0.48); R.blockObj(r.g); racks.push(r); });
  [-3.7, -3.06, -2.42].forEach((z, i) => { const r = P.serverRack(21 + i * 4); put(S, r.g, -W2 + 0.48, 0, z, Math.PI / 2); R.blockObj(r.g); racks.push(r); });
  // --- monitor wall desk + chair
  const mw = P.monitorWall(); put(S, mw.g, -3.8, 0, -D2 + 0.52); R.blockObj(mw.g);
  put(S, Z.officeChair('#2a4a3a'), -3.9, 0, -4.25, Math.PI);
  const neon = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.28), new THREE.MeshBasicMaterial({ map: TX.neon('follow the white rabbit', '#6ee7a0'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  neon.userData.live = true; R.onWall('n', neon, -3.8, 2.25, 0.04);
  // --- mining rig on a crate
  put(S, rbox(1.0, 0.3, 0.5, mat('#4a3a2a', { roughness: 0.9 }), 0.02), -1.0, 0.15, -D2 + 0.45);
  const rig = P.miningRig(); put(S, rig.g, -1.0, 0.3, -D2 + 0.45); R.block(-1.55, -D2, -0.45, -D2 + 0.8);
  // --- fridge corner + poster
  const fr = P.fridge(); put(S, fr.g, 6.9, 0, -D2 + 0.45); R.blockObj(fr.g);
  R.onWall('n', new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.85), mat('#ffffff', { map: TX.poster('movie', 'THERE IS NO SPOON') })), 5.4, 1.75, 0.032);
  R.onWall('n', new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.78), mat('#ffffff', { map: TX.poster('retro', 'SUDO MAKE ME A SANDWICH') })), 4.3, 1.6, 0.032);
  for (const [x, w, h, y] of [[5.4, 0.6, 0.85, 1.75], [4.3, 0.55, 0.78, 1.6]]) { R.onWall('n', rbox(w + 0.06, h + 0.06, 0.02, mat('#141218', { roughness: 0.5 }), 0.005), x, y, 0.01); // black poster frames + tape
    put(R.walls.n.decor, rbox(0.08, 0.03, 0.004, mat('#d8d0b0', { roughness: 1 }), 0.001), x - w / 2 + 0.02, y + h / 2, 0.03).rotation.z = 0.6; }
  for (const [x, z, h] of [[6.1, -D2 + 0.4, 0.5], [6.1, -D2 + 0.4, 0.9]]) { const b = rbox(0.55, 0.4, 0.45, mat(h > 0.6 ? '#9a7a2e' : '#4e3d34'), 0.02); put(S, b, x, h - 0.3, z, h * 0.2); R.blockObj(b); }

  // --- workbench (west wall) + stool + whiteboard
  const wb = P.workbench(); put(S, wb, -W2 + 0.5, 0, 0.3, Math.PI / 2); R.blockObj(wb);
  put(S, stool(0.65, '#5a2a3a'), -W2 + 1.2, 0, 0.3);
  const board = new THREE.Group(); put(board, rbox(1.5, 1.0, 0.04, mat('#a9acb2', { metalness: 0.5 }), 0.02), 0, 0, 0);
  const bs = new THREE.Mesh(new THREE.PlaneGeometry(1.42, 0.92), mat('#ffffff', { map: P.wbTex(), roughness: 0.4 })); bs.position.z = 0.022; board.add(bs);
  R.onWall('w', board, 1.4, 1.6, 0.04);
  // --- storage cage (south-west corner) + dehumidifier
  const cage = Z.storageCage(2.2, 2.4); put(S, cage, -W2 + 1.25, 0, D2 - 1.15, Math.PI / 2); R.block(-W2, D2 - 2.3, -W2 + 2.5, D2);
  const dh = P.dehumidifier(); put(S, dh, -W2 + 2.9, 0, D2 - 0.4); R.blockObj(dh);

  // --- hackathon table (centre)
  const HT = { x: -2.3, z: 0.9 }; const ht = Z.hackTable(3.6); put(S, ht, HT.x, 0, HT.z); R.blockObj(ht);
  const seats = [[-0.9, -1, '#2a4a6a'], [0.9, -1, '#a8342a'], [-0.9, 1, '#9a7a2e'], [0.9, 1, '#2a4a3a']];
  seats.forEach(([dx, sd, c], i) => { put(S, Z.officeChair(/** @type {string} */ (c)), HT.x + dx, 0, HT.z + sd * 0.72, sd < 0 ? 0 : Math.PI); if (i % 2) put(S, P.laptop(i + 2), HT.x + dx + 0.6 * sd, 0.77, HT.z + sd * 0.2, sd < 0 ? 0.3 : Math.PI - 0.3); });
  put(S, rbox(0.42, 0.05, 0.42, mat('#c9a46a', { roughness: 0.9 }), 0.01), HT.x, 0.79, HT.z, 0.3); // pizza box
  put(S, rbox(0.42, 0.05, 0.42, mat('#c9a46a', { roughness: 0.9 }), 0.01), HT.x + 0.05, 0.84, HT.z + 0.02, 0.1);
  const hb = { x: HT.x, y: 2.75, z: HT.z };

  // --- lounge: couch, armchair, side table (pills), crate coffee table
  const co = P.couch(); put(S, co, 3.2, 0, 4.45, Math.PI); R.blockObj(co);
  const ac = P.armchair(); put(S, ac, 6.0, 0, 2.5, -Math.PI / 2); R.blockObj(ac);
  const st = P.sideTable(); put(S, st, 6.05, 0, 3.65); R.blockObj(st);
  const ct = rbox(1.1, 0.36, 0.6, mat('#3a2c22', { roughness: 0.9 }), 0.02); put(S, ct, 3.2, 0.18, 2.9); R.blockObj(ct);
  put(S, P.laptop(5), 3.5, 0.37, 2.9, Math.PI + 0.3);
  // --- beanbag corner + crt on a crate
  const bbs = [[-3.6, 4.3], [-2.3, 4.75]].map(([x, z], i) => { const b = i ? Z.tintBeanbag('#5a2a3a') : P.beanbag(); put(S, b, x, 0, z); R.blockObj(b, 0.2); return b; });
  put(S, rbox(0.6, 0.4, 0.5, mat('#4e3d34'), 0.02), -1.2, 0.2, 5.0); R.block(-1.5, 4.75, -0.9, 5.25);

  // clutter: cans (instanced, two colours)
  const r = rng(5), one = new THREE.Vector3(1, 1, 1), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const spots = [[3.0, 0.425, 2.8], [2.8, 0.425, 3.0], [-3.0, 0.805, 1.0], [-1.6, 0.805, 0.7], [-2.9, 0.065, 3.4], [-1.9, 0.065, 3.9], [4.8, 0.065, 4.9], [-5.0, 0.065, -1.5],
    [-2.8, 0.805, -D2 + 0.4], [6.1, 0.62, 3.6], [5.0, 0.065, -1.0], [1.2, 0.065, 4.6], [1.5, 0.065, 0.4], [-4.2, 0.065, 2.4], [0.2, 0.065, -3.4], [6.4, 0.065, -3.0], [-4.6, 0.805, -D2 + 0.4], [2.2, 0.065, 1.4]];
  for (const [ci, col] of [[0, '#2d6a3a'], [1, '#2a4a6a']]) { const sub = spots.filter((_, i) => i % 2 === ci);
    const cans = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.035, 0.035, 0.13, 10), mat(col, { metalness: 0.6, roughness: 0.35 }), sub.length);
    sub.forEach(([x, y, z], i) => { const down = y < 0.1 && i % 3 === 0; e.set(down ? Math.PI / 2 : 0, r() * 6, 0); q.setFromEuler(e); m4.compose(new THREE.Vector3(x, down ? 0.035 : y, z), q, one); cans.setMatrixAt(i, m4); }); S.add(cans); }
  for (let i = 0; i < 2; i++) { const pc = rbox(0.2, 0.45, 0.45, mat('#15161c'), 0.02); put(S, pc, 0.6 + i * 0.25, 0.225, -D2 + 0.5, 0.1); R.blockObj(pc); put(S, rbox(0.02, 0.02, 0.01, glowMat('#3ddc84', 2), 0.005), 0.6 + i * 0.25, 0.4, -D2 + 0.73); }
  const coil = mesh(new THREE.TorusGeometry(0.18, 0.03, 6, 18), mat('#15161c')); coil.rotation.x = Math.PI / 2; put(S, coil, -0.4, 0.03, 3.4);
  // --- bare bulb pendants (lounge + hack table)
  const bulbs = [{ x: 3.4, y: 2.6, z: 2.9 }, hb].map(p => { const cord = mesh(new THREE.CylinderGeometry(0.008, 0.008, 3.2 - p.y, 4), mat('#111')); cord.position.set(p.x, (3.2 + p.y) / 2 + 0.06, p.z); S.add(cord);
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), glowMat('#ffcf8a', 1.2)); b.position.set(p.x, p.y, p.z); b.userData.live = true; L.add(b);
    const h = FX.glow('#ffb36b', 0.9, 0.35); h.position.copy(b.position); L.add(h); return h; });
  const halo = bulbs[0];
  L.add(FX.motes(40, new THREE.Vector3(-6, 0.5, -4), new THREE.Vector3(6, 2.6, 4.5), '#cfe0c0', 0.04));

  R.rig = lightRig(R.root, { room: R, sky: '#4a4a7a', ground: '#2a2030', ambient: 2.6, moonI: 0.5, points: [
    { x: 3.4, y: 2.4, z: 2.9, color: '#ffb36b', i: 22, d: 10 },
    { x: hb.x, y: 2.2, z: hb.z, color: '#ffcf8a', i: 13, d: 9 },
    { x: -3.8, y: 1.4, z: -4.2, color: '#3ddc84', i: 8, d: 6 },
    { x: -6.4, y: 1.3, z: -3.4, color: '#3ddc84', i: 7, d: 5.5 }] });
  R.meta = { id: 'basement', name: 'The Basement', blurb: 'Homelab den: blinking racks, green CRTs, cold drinks.' };
  R.spawn = { x: SX, z: -3.9, face: 0.4 };
  const H = Math.PI;
  R.slots = [
    { id: 'bs-couch-l', kind: 'sofa', x: 2.75, z: 4.35, y: 0.07, face: H, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Couch' },
    { id: 'bs-couch-r', kind: 'sofa', x: 3.65, z: 4.35, y: 0.07, face: H, anim: 'Sit_Chair_Idle', prop: 'beer', label: 'Couch' },
    { id: 'bs-armchair', kind: 'chair', x: 5.95, z: 2.5, y: 0.03, face: -H / 2, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Leather armchair' },
    ...seats.map(([dx, sd], i) => ({ id: 'bs-hack-' + i, kind: 'chair', x: HT.x + /** @type {number} */ (dx), z: HT.z + /** @type {number} */ (sd) * 0.72, y: 0.02, face: /** @type {number} */ (sd) < 0 ? 0 : H, anim: 'Sit_Chair_Idle', prop: i === 3 ? 'mug' : 'laptop', label: 'Hackathon table' })),
    { id: 'bs-bench', kind: 'stool', x: -W2 + 1.2, z: 0.3, y: 0.2, face: -H / 2, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Workbench stool' },
    { id: 'bs-desk', kind: 'chair', x: -3.9, z: -4.25, y: 0.02, face: H, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Monitor wall' },
    { id: 'bs-beanbag', kind: 'floor', x: -3.6, z: 4.3, y: 0.22, face: H * 0.85, anim: 'Sit_Floor_Idle', prop: 'controller', label: 'Beanbag' },
    { id: 'bs-fridge-a', kind: 'stand', x: 5.7, z: -3.6, face: 2.3, anim: 'Idle', prop: 'beer', label: 'By the fridge' },
    { id: 'bs-fridge-b', kind: 'stand', x: 6.9, z: -3.3, face: -2.6, anim: 'Idle', prop: 'phone', label: 'By the fridge' },
  ];
  R.interact = [
    { id: 'rack', x: -6.0, z: -3.6, r: 1.2, label: 'Check uptime', kind: 'server' },
    { id: 'whiteboard', x: -6.9, z: -1.2, r: 1.0, label: 'Read the plan', kind: 'board' },
    { id: 'fridge', x: 6.7, z: -4.3, r: 0.9, label: 'Grab an energy drink', kind: 'fridge' },
  ];
  R.npc = null;
  let ripple = -1, wantRipple = false, fridgeOpen = -1, wantFridge = false;
  R.onInteract = (id, api) => {
    if (id === 'rack') { wantRipple = true; api.toast('Uptime: 1337 days. Nobody touch anything.'); }
    else if (id === 'whiteboard') api.bubble('1. ship it  2. ???  3. uptime 99.9%');
    else if (id === 'fridge') { wantFridge = true; api.toast('Cracked open an energy drink. +10 focus'); }
  };  // reaction sounds, timed to the animations (the default keyword guess is silenced for these)
  /** @type {Record<string, () => void>} */
  const RSND = {
    rack: (at) => { SFX.play('hum', { at, vol: 0.4 }); SFX.play('beep', { at, vol: 0.3, delay: 0.5 }); setTimeout(() => SFX.play('beep', { at, vol: 0.3, pitch: 1.3 }), 700); },
    fridge: (at) => { SFX.play('fridge', { at }); SFX.play('can', { at, delay: 0.7 }); SFX.play('fizz', { at, vol: 0.4, delay: 0.95 }); },
  };
  for (const it of R.interact) if (RSND[it.id]) it.sfx = false;
  { const oi = R.onInteract; R.onInteract = (id, api) => { const it = R.interact.find(e => e.id === id), o = R.root.position; if (it) RSND[id]?.({ x: o.x + it.x, y: 1, z: o.z + it.z }); oi(id, api); }; }

  R.camera = { zoom: 6, target: new THREE.Vector3(0, 0.8, 0.5) };

  const col = new THREE.Color(), G = new THREE.Color('#3ddc84'), A = new THREE.Color('#ffb02e'), OFF = new THREE.Color('#0a2014'), W = new THREE.Color('#d8ffe8');
  const fq = new THREE.Quaternion(), fm = new THREE.Matrix4(), XAX = new THREE.Vector3(1, 0, 0);
  R.tick = (t, dt) => {
    if (wantRipple) { ripple = t; wantRipple = false; } if (wantFridge) { fridgeOpen = t; wantFridge = false; }
    for (const { leds, n } of racks) {
      const ph = leds.userData.ph, ys = leds.userData.y;
      for (let i = 0; i < n; i++) {
        const amber = ph[i] > 0.85, on = Math.sin(t * (0.5 + ph[i] * 2.2) + ph[i] * 40) > (amber ? 0.3 : -0.4);
        col.copy(on ? (amber ? A : G) : OFF);
        if (ripple >= 0) { const k = (t - ripple) * 1.6 - ys[i]; if (k > 0 && k < 0.25) col.copy(W).multiplyScalar(2); }
        leds.setColorAt(i, col.multiplyScalar(on ? 2.2 : 1));
      }
      if (leds.instanceColor) leds.instanceColor.needsUpdate = true;
    }
    if (ripple >= 0 && t - ripple > 2) ripple = -1;
    { const F = rig.fans, ps = F.userData.pos; for (let i = 0; i < ps.length; i++) { fq.setFromAxisAngle(XAX, t * 18 + i); fm.compose(ps[i], fq, one); F.setMatrixAt(i, fm); } F.instanceMatrix.needsUpdate = true; }
    rig.rgb.material.color.setHSL((t * 0.1) % 1, 1, 0.55).multiplyScalar(2);
    mw.screens[0].material.color.setScalar(1.5 * (0.97 + 0.03 * Math.sin(t * 1.9)));
    neon.material.opacity = 0.82 + 0.1 * Math.sin(t * 1.3);
    halo.material.opacity = 0.5 * (0.96 + 0.04 * Math.sin(t * 0.9));
    fr.light.material.color.setScalar(fridgeOpen >= 0 && t - fridgeOpen < 1.5 ? 2.5 : 0.5);
  };
  { // shadow-map casters: big furniture only; small clutter (< 0.9 m) relies on the soft contact shadows
    const bx = new THREE.Box3(), sz = new THREE.Vector3(); R.static.updateMatrixWorld(true);
    R.static.traverse(o => { if (/** @type {any} */ (o).isMesh) { bx.setFromObject(o).getSize(sz); if (Math.max(sz.x, sz.y, sz.z) < 0.9) o.castShadow = false; } }); }
  roomGlow(R, []);
  R.finish();
  return R;
}

/** Round stool / chair seat at height h. */
function stool(h, c) {
  const g = new THREE.Group(); const m = mat(c, { roughness: 0.5 });
  const seat = mesh(new THREE.CylinderGeometry(0.22, 0.2, 0.08, 18), m); seat.position.y = h; g.add(seat);
  const post = mesh(new THREE.CylinderGeometry(0.03, 0.03, h, 8), mat('#3a3d44', { metalness: 0.7, roughness: 0.4 })); post.position.y = h / 2; g.add(post);
  const ring = mesh(new THREE.TorusGeometry(0.17, 0.015, 6, 16), mat('#3a3d44', { metalness: 0.7 })); ring.rotation.x = Math.PI / 2; ring.position.y = h * 0.35; g.add(ring);
  const foot = mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.03, 16), mat('#2a2d34', { metalness: 0.6 })); foot.position.y = 0.015; g.add(foot);
  return g;
}
