// @ts-check
// World extras for 'films-b' (classic + comedy film homages). Props, one character, hotspots; state for the
// activities in films-b.js lives on rooms[id].fbx (no module state).
//   roof:     The Dude on a deck lounger (rug, White Russian), E.T. bike crossing the moon every ~40 s
//   bar:      briefcase on a booth table, glass of water rippling on the counter
//   den:      hex-pattern hallway carpet in front of the bar passage, hoverboard leaning on the north wall
//   bedroom:  standing mirror with REDRUM
//   basement: red stapler on the hack table, smashed printer in the south-east corner, proton pack by the posters
import * as THREE from 'three';
import { Avatar } from '../avatar.js';
import { mat, put } from '../rooms/kit.js';
import * as TX from '../rooms/tex.js';
import * as P from './films-b-props.js';

const spot = (R, id, x, z, r, label) => R.interact.push({ id, x, z, r, label, kind: 'film' });
const onFloor = (S, R) => R.floorId == null || S.floor === R.floorId;

/** Moon centres on the roof backdrop (see rooms/roof-sky.js: moonU 0.38 on n, 0.6 on s; disc at 352/600 of a 16-high plane). */
export function moonLocal(side) { return { x: side === 'n' ? -7.27 : 5.04, y: 6.5 - 352 / 600 * 16, z: -7.95 }; }

export default {
  id: 'films-b',
  /** @param {{A:any, rooms:Record<string, any>, THREE:any}} ctx */
  install({ A, rooms }) {
    const ticks = [];
    // ---------- ROOF: The Dude + E.T. ----------
    const roof = rooms.roof;
    if (roof) {
      const fx = roof.fbx = {}, L = roof.live;
      roof.slots = roof.slots.filter(s => s.id !== 'roof-deck-b');
      const rm = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 1.9), mat('#ffffff', { map: TX.rug('persian', '#5a2a1e', '#a0582d', '#e0b080', 11), roughness: 1 }));
      rm.rotation.x = -Math.PI / 2; rm.position.set(-7.2, 0.012, 2.35); rm.receiveShadow = true; L.add(rm);
      const av = new Avatar(A, { body: 'rogue', head: 'rogue', skin: '#e8b890', hair: '#5a3e2a', top: '#d8cdb8', bottom: '#7a8a96', acc: 'none', silly: ['coat', 'sunglasses', 'moustache'] });
      av.root.traverse(o => { const m = /** @type {any} */ (o).material; if (m && m.side === THREE.DoubleSide && m.color) { m.color.set('#a08a6c'); m.roughness = 0.95; } });
      const [, shades, tache] = av.parts.slice(-3);
      shades?.traverse(o => { const m = /** @type {any} */ (o).material; if (m) { m.metalness = 0; m.roughness = 0.7; } });
      if (tache) { tache.scale.setScalar(0.62); tache.position.set(0, 0.16, 0.2); tache.traverse(o => { const m = /** @type {any} */ (o).material; if (m) m.color.set('#4a3020'); }); }
      av.root.position.set(-7.2, -0.1, 2.5); av.root.rotation.y = 0; av.play('Sit_Chair_Idle'); L.add(av.root);
      const hand = av.bone('handslot.r') || av.rig; const wr = P.whiteRussian(); hand.add(wr);
      fx.dude = av; fx.dudeI = 0;
      spot(roof, 'fb-dude', -7.2, 3.35, 0.8, 'Talk to the guy in the robe');
      // E.T. bike crossing the moon: one plane per backdrop side, visible with that side
      const bm = new THREE.MeshBasicMaterial({ map: P.bikeTex(), transparent: true, depthWrite: false, fog: false });
      const bikes = {}; const sideOK = { n: true, s: false };
      for (const side of /** @type {const} */ (['n', 's'])) {
        const g = new THREE.Group(); g.position.set(0, 0, side === 'n' ? -roof.d / 2 : roof.d / 2); g.rotation.y = side === 'n' ? 0 : Math.PI; g.userData.live = true; L.add(g);
        const b = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.55), bm); b.visible = false; b.userData.live = true; g.add(b); bikes[side] = { g, b, m: moonLocal(side) };
      }
      const cut = roof.cutaway; roof.cutaway = dir => { cut(dir); sideOK.n = dir.z < -0.2; sideOK.s = dir.z > 0.2; };
      fx.bikeAt = -99; fx.moonSide = () => (sideOK.s ? 's' : 'n'); fx.bikeGroup = side => bikes[side].g;
      spot(roof, 'fb-moon', -1.2, -6.0, 0.7, 'Watch the moon');
      ticks.push((t, dt, S) => {
        if (!onFloor(S, roof)) return;
        av.update(dt); if ((t % 23) < dt) av.fx.sip = 1.6;
        const cyc = 40, cross = 7; const since = fx.bikeAt > t - cross ? t - fx.bikeAt : ((t + 12) % cyc);
        const p = since / cross;
        for (const side of /** @type {const} */ (['n', 's'])) {
          const { b, m } = bikes[side]; b.visible = sideOK[side] && p >= 0 && p <= 1;
          if (b.visible) b.position.set(m.x - 2.6 + p * 5.2, m.y - 0.75 + p * 1.5 + Math.sin(p * Math.PI) * 0.15, m.z);
        }
      });
    }
    // ---------- BAR: briefcase + glass of water ----------
    const bar = rooms.bar;
    if (bar) {
      const fx = bar.fbx = {}, L = bar.live;
      const bc = P.briefcase(); put(L, bc.g, -7.85, 0.77, 2.8, -0.25); fx.case = bc; fx.open = 0; fx.openWant = 0;
      spot(bar, 'fb-case', -7.15, 2.8, 0.6, 'Open the briefcase');
      const wg = P.waterGlass(); put(L, wg.g, -3.45, 1.075, -3.95); fx.water = wg; fx.quake = 0;
      spot(bar, 'fb-water', -3.45, -3.25, 0.45, 'Glass of water');
      ticks.push((t, dt, S) => {
        if (!onFloor(S, bar)) return;
        fx.open += (fx.openWant - fx.open) * Math.min(1, dt * (fx.openWant ? 3 : 6)); const o = fx.open;
        bc.lid.rotation.x = -1.9 * o; bc.inside.visible = o > 0.05; bc.cone.material.opacity = 0.13 * o * (0.85 + 0.15 * Math.sin(t * 9)); bc.halo.material.opacity = 0.45 * o;
        bc.cone.visible = o > 0.02;
        // ripples: two rings every ~3.4 s (a thump-thump), faster while quaking
        const per = fx.quake > 0 ? 1.0 : 3.4; fx.quake = Math.max(0, fx.quake - dt);
        wg.rings.forEach((r, i) => { const k = ((t + i * 0.32) % per) / 0.9; const on = k < 1; r.visible = on; if (on) { r.scale.setScalar(0.15 + k * 0.85); r.material.opacity = (1 - k) * 0.9; } });
      });
    }
    // ---------- DEN: hex carpet + hoverboard ----------
    const den = rooms.den;
    if (den) {
      const fx = den.fbx = {}, L = den.live;
      const rug = P.hexRug(3.6, 1.5); rug.rotation.z = Math.PI / 2; rug.position.set(-4.7, 0.007, 0.1); rug.receiveShadow = true; rug.userData.live = true; L.add(rug);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), mat('#d8e04a', { roughness: 0.9 })); ball.visible = false; ball.userData.live = true; L.add(ball); fx.ball = ball; fx.ballT = -1;
      spot(den, 'fb-carpet', -4.7, 0.1, 0.9, 'Odd carpet');
      const hb = P.hoverboard(); put(L, hb.g, 1.6, 0, -5.72); fx.hover = hb; fx.lift = 0; fx.liftWant = 0;
      den.block(1.4, -6, 1.8, -5.5);
      spot(den, 'fb-hover', 1.6, -4.95, 0.45, 'Hoverboard');
      ticks.push((t, dt, S) => {
        if (!onFloor(S, den)) return;
        fx.lift += (fx.liftWant - fx.lift) * Math.min(1, dt * 3); const k = fx.lift;
        hb.board.rotation.x = 0.16 * (1 - k) - Math.PI / 2 * k; hb.board.position.set(0, k * (0.35 + Math.sin(t * 2.4) * 0.05), k * 0.55); hb.halo.material.opacity = 0.55 * k + 0.08;
        if (fx.ballT >= 0) { fx.ballT += dt; const u = Math.min(1, fx.ballT / 2.4), e = 1 - (1 - u) * (1 - u); ball.visible = fx.ballT < 5; ball.position.set(-6.3 + e * 2.6, 0.065, 0.1 + Math.sin(e * 3) * 0.12); ball.rotation.z = -e * 30; if (fx.ballT > 5) fx.ballT = -1; }
      });
    }
    // ---------- BEDROOM: REDRUM mirror ----------
    const bed = rooms.bedroom;
    if (bed) {
      const fx = bed.fbx = {};
      const mr = P.standingMirror(); put(bed.live, mr.g, -1.0, 0, -3.62, 0.12); bed.block(-1.4, -3.95, -0.6, -3.45); fx.mirror = mr; fx.flip = 0; fx.flipWant = 0;
      spot(bed, 'fb-mirror', -1.0, -2.9, 0.5, 'Standing mirror');
      ticks.push((t, dt, S) => {
        if (!onFloor(S, bed)) return;
        fx.flip += (fx.flipWant - fx.flip) * Math.min(1, dt * 5);
        const k = fx.flip; mr.word.scale.x = Math.abs(Math.cos(k * Math.PI)) + 0.001; mr.word.material.map = k > 0.5 ? mr.murder : mr.redrum;
      });
    }
    // ---------- BASEMENT: stapler, printer, proton pack ----------
    const bs = rooms.basement;
    if (bs) {
      const fx = bs.fbx = {}, L = bs.live;
      const st = P.stapler(); put(L, st, -0.75, 0.765, 0.6, 0.4); fx.stapler = st;
      spot(bs, 'fb-stapler', -0.15, 0.6, 0.45, 'Red stapler');
      const pr = P.smashedPrinter(); put(L, pr.g, 7.15, 0, 4.7, -0.5); bs.block(6.6, 4.25, 7.8, 5.5); fx.printer = pr;
      spot(bs, 'fb-printer', 6.5, 3.9, 0.6, 'Smash the printer');
      const pp = P.protonPack(); put(L, pp.g, 3.3, 0, -5.12); bs.block(3.0, -5.5, 3.7, -4.85); fx.pack = pp; fx.packHot = 0;
      spot(bs, 'fb-pack', 3.3, -4.45, 0.5, 'Proton pack');
      const m4 = new THREE.Matrix4();
      ticks.push((t, dt, S) => {
        if (!onFloor(S, bs)) return;
        pr.err.visible = (t % 1.2) < 0.6; pr.spark.material.opacity = Math.sin(t * 0.7) > 0.93 ? 0.6 * Math.random() : 0;
        fx.packHot = Math.max(0, fx.packHot - dt); const spin = t * (fx.packHot > 0 ? 9 : 1.2);
        for (let i = 0; i < 4; i++) { const a = spin + i * Math.PI / 2, s = 0.6 + 0.4 * Math.max(0, Math.cos(a * 2)); m4.makeScale(s, s, s).setPosition(Math.cos(a) * 0.11, 0.27 + Math.sin(a) * 0.11, 0.14); pp.lights.setMatrixAt(i, m4); }
        pp.lights.instanceMatrix.needsUpdate = true; pp.halo.material.opacity = fx.packHot > 0 ? 0.7 : 0.3;
      });
    }
    const all = [roof, bar, den, bed, bs].filter(Boolean);
    return (t, dt, S) => { for (const R of all) R.fbx.now = t; for (const f of ticks) f(t, dt, S); };
  },
};
