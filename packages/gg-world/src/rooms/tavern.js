// @ts-check
// The Prancing Murloc: a warm, chunky fantasy-MMO inn (parody/homage). Stone hearth, long tables, the bar with an
// innkeeper, quest board with floating '!', mailbox, dice and card tables, a raid-plan easel and the fish-man mascot.
// Local frame x -16..16, z -9..9. n and w walls belong to neighbours (never mount there); openings n x=-11, n x=9, w z=0.
import * as THREE from 'three';
import { makeRoom, lightRig, mat, glowMat, put } from './kit.js';
import * as FX from './kit-fx.js';
import * as TX from './tex.js';
import * as P from './tavern-props.js';
import { glowPlanes } from './hackers-props.js';
import { addFlavour } from './tavern-extra.js';
import { Avatar } from '../avatar.js';
import { poker } from './screening-poke.js';
import { solid1 } from './hackers-solid.js';
import { SFX } from '../sfx.js';

// lute strum: plucked notes rolling up a chord
SFX.define('tav.lute', (o, t, p, K) => { [196, 247, 294, 392].forEach((f, i) => K.tone(o, t + i * 0.05, { type: 'triangle', f: f * p, v: 0.08, a: 0.004, d: 0.6 })); });

const KEEP = { body: 'barbarian', head: 'barbarian', skin: '#d8a888', hair: '#6a3a1a', top: '#7a4a2a', bottom: '#4a3a2a', acc: 'none', accColor: '#e8d6a8' };
const DANCER = { body: 'knight', head: 'knight', skin: '#c89878', hair: '#2a1a12', top: '#2e4a8a', bottom: '#5a4a3a', acc: 'none', accColor: '#d8a43a' };
const H = Math.PI / 2;

/** @param {any} ctx */
export function build(ctx) {
  const R = /** @type {any} */ (makeRoom({ id: 'tavern', floor: P.floorTex(), floorRepeat: 3, wall: P.wallTex(), trim: '#4a2c1a', base: '#3a2214' }));
  const S = R.static;
  const st = (o, x, y, z, ry = 0, block = false) => { put(S, o, x, y, z, ry); if (block) R.blockObj(o); return o; };
  const live = (o, x, y, z, ry = 0) => { put(R.live, o, x, y, z, ry); o.traverse(c => { c.userData.live = true; }); return o; };
  // floor pools: one static instanced additive mesh for the whole room (opacity folded into the colour)
  const pools = []; const pool = (x, z, s, color, op = 0.35) => { pools.push([x, 0.015, z, 0, s, s, '#' + new THREE.Color(color).multiplyScalar(op / 0.3).getHexString(), true]); };
  // ----- hearth (north, between the two openings)
  const HX = -1;
  st(P.hearth(), HX, 0, -8.1, 0, true);
  st(P.banner('red'), -4.2, 0, -8.4, 0, true); st(P.banner('blue'), 2.0, 0, -8.4, 0, true);
  const flames = [[-0.3, 0.9, 0.5], [0.25, 0.8, 0.45], [0, 1.1, 0.6]].map(([dx, h, r], i) => {
    const f = new THREE.Mesh(new THREE.ConeGeometry(r * 0.5, h, 7), glowMat(i === 2 ? '#ffd070' : '#ff7a2a', 2.4)); return live(f, HX + dx, 0.35 + h / 2, -7.9); });
  const fireG = live(FX.glow('#ff9a40', 3.2, 0.7), HX, 0.9, -7.5);
  pool(HX, -6.4, 6, '#ff8a3a', 0.4);
  // ----- the bar (north-east): counter, back shelf, stools, innkeeper
  const BX = 13.3;
  st(P.barCounter(4.6), BX, 0, -6.0, 0, true); R.block(BX - 2.6, -8.7, BX + 2.6, -6.5);
  P.instanceAll(R.live, P.stool(), [[BX - 1.5, -5.15, 0], [BX, -5.15, 0], [BX + 1.5, -5.15, 0], [7.4, 4.8, 0], [8.6, 6.2, 0]]);
  const keeper = new Avatar(ctx.A, KEEP); keeper.root.position.set(BX, 0, -6.95); keeper.play('Idle'); keeper.root.traverse(c => { c.userData.live = true; }); R.live.add(keeper.root);
  pool(BX, -5.6, 5, '#ffb36b', 0.3);
  // ----- long tables + benches (instanced)
  const tables = [[-7, -3.4], [-7, 3.6], [1.2, 3.0], [6.0, -2.6]];
  P.instanceAll(R.live, P.longTable(3.6), tables.map(([x, z]) => [x, z, 0]), true);
  P.instanceAll(R.live, P.bench(3.4), tables.flatMap(([x, z]) => [[x, z - 0.85, 0], [x, z + 0.85, 0]]));
  for (const [x, z] of tables) R.block(x - 1.85, z - 1.05, x + 1.85, z + 1.05);
  P.instanceAll(R.live, P.candle(), tables.map(([x, z]) => [x + 0.2, z, 0, 0.82]));
  P.instanceAll(R.live, P.tankard(), tables.flatMap(([x, z], i) => [[x - 1.1, z - 0.2, 0, 0.82], [x + 0.9, z + 0.25, 0, 0.82], [x - 0.4 + i * 0.1, z + 0.3, 0, 0.82]]));
  for (const [x, z] of tables) { live(FX.glow('#ffb050', 0.9, 0.55), x + 0.2, 1.05, z); pool(x, z, 4.2, '#ffb36b', 0.22); }
  // ----- barrels (instanced)
  P.instanceAll(R.live, P.barrel(), [[15.2, -2.4, 0], [15.2, -1.6, 0.5], [15.2, -2.0, 0, 0.96], [-15.2, -8.2, 0], [-14.5, -8.3, 1], [-15.2, 8.2, 0], [-14.5, 8.25, 2], [-15.2, 8.2, 1, 0.96], [5.0, -8.3, 0], [5.7, -8.2, 2], [15.2, 8.2, 0]], true);
  for (const [x0, z0, x1, z1] of [[14.1, -2.9, 15.6, -1.1], [-15.6, -8.7, -14.1, -7.8], [-15.6, 7.7, -14.1, 8.7], [4.6, -8.7, 6.1, -7.8], [14.8, 7.8, 15.6, 8.7]]) R.block(x0, z0, x1, z1);
  // ----- west wall zone: quest board, mailbox, raid plan
  st(P.questBoard(), -15.0, 0, -5.0, H, true);
  const bangs = [-0.5, 0.05, 0.5].map((dz, i) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: TX.label('!', '#ffd23a', null, 64, 96, '132px m5x7'), transparent: true, depthWrite: false, toneMapped: false })); s.scale.set(0.35, 0.52, 1); return live(s, -14.85, 2.75 + i * 0.05, -5.0 + dz); });
  live(FX.glow('#ffd23a', 1.6, 0.4), -14.8, 2.8, -5.0);
  const mailbox = live(solid1((P.mailbox())), -14.9, 0, 4.4, H); R.blockObj(mailbox);
  const tapBarrel = live(solid1((P.barrel())), 14.5, 0, -2.0, 1); R.blockObj(tapBarrel);
  st(P.raidBoard(), -15.0, 0, 7.0, H, true);
  // ----- dice table + card duel table (east / front)
  st(P.diceTable(), 12.8, 0, 3.6, 0, true);
  const dice = [0, 1].map(i => live(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), mat(i ? '#f0e6c8' : '#c8302a')), 12.6 + i * 0.3, 0.92, 3.6));
  st(P.cardTable(), 8.0, 0, 5.5, 0, true);
  // ----- lantern posts + ceiling-less warmth
  const lanterns = [[-3.0, 0.2], [4.0, 0.4], [10.5, 0.0], [-11.0, 0.2], [-2.5, 7.5], [11.5, 7.6]];
  for (const [x, z] of lanterns) { st(P.lanternPost(2.3), x, 0, z, 0); R.block(x - 0.25, z - 0.25, x + 0.25, z + 0.25); }
  const lantG = lanterns.map(([x, z]) => live(FX.glow('#ffc070', 1.4, 0.55), x + 0.42, 2.0, z));
  for (const [x, z] of lanterns) pool(x + 0.4, z, 3.0, '#ffc070', 0.2);
  // ----- the fish-man mascot by the hearth + a table dancer
  const fish = live(P.fishMan(), 2.4, 0, -6.5, -0.3); R.block(2.0, -6.9, 2.8, -6.1);
  const fHead = fish.getObjectByName('head'), fMouth = fish.getObjectByName('mouth'), fArms = [fish.getObjectByName('armL'), fish.getObjectByName('armR')];
  const dancer = new Avatar(ctx.A, DANCER); dancer.root.position.set(1.2, 0.82, 3.0); dancer.root.rotation.y = 0.6; dancer.play('Idle'); dancer.root.traverse(c => { c.userData.live = true; }); R.live.add(dancer.root);
  const mrgl = new THREE.Sprite(new THREE.SpriteMaterial({ map: TX.label('Mrglglglgl!', '#c8ffb0', 'rgba(20,40,20,0.85)', 512, 96, '78px m5x7'), transparent: true, depthWrite: false, toneMapped: false }));
  mrgl.scale.set(1.8, 0.34, 1); live(mrgl, 2.4, 1.8, -6.3); mrgl.visible = false;
  const flav = addFlavour(R, st, live);
  pool(1.2, 3.0, 5, '#ffb050', 0.18); // chandelier pool
  live(glowPlanes(pools, 0.3), 0, 0, 0);
  R.live.add(FX.motes(30, new THREE.Vector3(-4, 0.4, -8), new THREE.Vector3(2, 2.6, -5), '#ffb050', 0.05));
  // ----- lights: hearth, bar, west hall, east hall
  R.rig = lightRig(R.root, { room: R, sky: '#c8a078', ground: '#6a4028', ambient: 2.6, moon: '#ffd8a8', moonI: 0.9, moonFrom: [-8, 12, -4], points: [
    { x: HX, y: 1.3, z: -6.6, color: '#ff9a40', i: 14, d: 11 },
    { x: BX, y: 2.4, z: -4.8, color: '#ffc070', i: 9, d: 9 },
    { x: -7, y: 2.6, z: 0.2, color: '#ffcf8a', i: 9, d: 11 },
    { x: 7, y: 2.6, z: 3.0, color: '#ffcf8a', i: 9, d: 11 }] });
  R.meta = { id: 'tavern', name: 'The Prancing Murloc', blurb: 'Hearth, ale, quests. Mrglglgl.' };
  R.spawn = { x: -11, z: 0, face: H };
  const bs = (id, x, z, face, prop, label) => ({ id, kind: 'bench', x, z, y: 0.04, face, anim: 'Sit_Chair_Idle', prop, label });
  R.slots = [];
  const props = ['laptop', 'beer', 'laptop', 'mug'];
  tables.forEach(([x, z], ti) => { if (ti === 2) return; // table 2 is the dancer's stage
    R.slots.push(bs(`t${ti}-a`, x - 1.0, z - 0.85, 0, props[0], 'Long table bench'), bs(`t${ti}-b`, x + 1.0, z - 0.85, 0, props[(ti + 1) % 4], 'Long table bench'),
      bs(`t${ti}-c`, x - 1.0, z + 0.85, Math.PI, props[2], 'Long table bench'), bs(`t${ti}-d`, x + 1.0, z + 0.85, Math.PI, props[(ti + 3) % 4], 'Long table bench')); });
  R.slots.push(
    { id: 'stool-a', kind: 'stool', x: BX - 1.5, z: -5.15, y: 0.06, face: Math.PI, anim: 'Sit_Chair_Idle', prop: 'beer', label: 'Bar stool' },
    { id: 'stool-b', kind: 'stool', x: BX, z: -5.15, y: 0.06, face: Math.PI, anim: 'Sit_Chair_Idle', label: 'Bar stool' },
    { id: 'stool-c', kind: 'stool', x: BX + 1.5, z: -5.15, y: 0.06, face: Math.PI, anim: 'Sit_Chair_Idle', label: 'Bar stool' },
    { id: 'stool-d', kind: 'stool', x: 7.4, z: 4.8, y: 0.06, face: 0.6, anim: 'Sit_Chair_Idle', label: 'Card table stool' },
    { id: 'fire', kind: 'stand', x: HX - 1.6, z: -5.6, face: Math.PI - 0.3, anim: 'Idle', prop: 'mug', label: 'Warming up at the hearth' });
  R.interact = [
    { id: 'quests', x: -13.8, z: -5.0, r: 1.2, label: 'Quest board', kind: 'board' },
    { id: 'loot', x: 12.8, z: 4.8, r: 1.2, label: 'Roll for loot', kind: 'game' },
    { id: 'duel', x: 8.0, z: 6.7, r: 1.1, label: 'Card duel vs the innkeeper', kind: 'game' },
    { id: 'raid', x: -13.8, z: 7.0, r: 1.1, label: 'Raid plan', kind: 'board' },
    { id: 'murloc', x: 2.4, z: -5.6, r: 1.1, label: 'Pat the mascot', kind: 'npc', sfx: false },
    { id: 'hearth', x: HX, z: -6.3, r: 1.3, label: 'Bind your hearth stone', kind: 'gadget', sfx: false },
    { id: 'dancer', x: 1.2, z: 4.4, r: 1.2, label: 'Cheer the table dancer', kind: 'npc', sfx: false },
    { id: 'keeper', x: BX, z: -4.6, r: 1.0, label: 'Talk to the innkeeper', kind: 'npc', sfx: false },
    { id: 'mail', x: -13.9, z: 4.4, r: 0.9, label: 'Check the mailbox', kind: 'gadget', sfx: false },
    { id: 'barrel', x: 14.2, z: -1.4, r: 0.9, label: 'Tap a barrel', kind: 'gadget', sfx: false },
    { id: 'lute', x: -6.6, z: 7.0, r: 0.9, label: 'Strum the lute', kind: 'gadget', sfx: false }];
  R.npc = null;
  R.camera = { zoom: 8.5, target: new THREE.Vector3(0, 0.8, 0) };
  let now = 0, gurgle = -99, bound = -99, dance = -99;
  const at = (x, z, o = {}) => ({ ...o, at: { x: x + R.root.position.x, z: z + R.root.position.z } });
  const PK = poker(), POKE = { mail: [mailbox, 'wiggle', 0.9, 1], barrel: [tapBarrel, 'squash', 1.0, 0.8], lute: [flav.lute, 'tip', 1.1, -0.6] };
  let greet = -99;
  R.onInteract = (id, api) => {
    if (POKE[id]) { const [o, k, d, a] = POKE[id]; PK.poke(o, /** @type {any} */ (k), d, a); }
    if (id === 'keeper') greet = now;
    if (id === 'murloc') { SFX.play('gurgle', at(2.4, -6.5)); SFX.play('bubble', at(2.4, -6.5, { delay: 0.25 })); SFX.play('gurgle', at(2.4, -6.5, { delay: 0.5, pitch: 1.3 })); gurgle = now; api.bubble('Mrglglglgl!'); }
    else if (id === 'hearth') { SFX.play('fire', at(HX, -7.8)); SFX.play('magic', at(HX, -7.8, { delay: 0.2 })); bound = now; api.toast('Hearth stone bound to: The Prancing Murloc.'); }
    else if (id === 'dancer') { SFX.play('creak', at(1.2, 3.0)); SFX.play('tav.lute', at(1.2, 3.0, { delay: 0.2 })); SFX.play('thud', at(1.2, 3.0, { delay: 0.6, vol: 0.5 })); SFX.play('creak', at(1.2, 3.0, { delay: 1.1, pitch: 0.8 })); dance = now; api.toast('/dance  (the table creaks ominously)'); }
    else if (id === 'keeper') { SFX.play('glass', at(BX, -6.0)); SFX.play('pour', at(BX, -6.0, { delay: 0.3 })); }
    if (id === 'keeper') api.bubble('You are not prepared... for this ale.');
    else if (id === 'mail') { SFX.play('creak', at(-14.5, 4.4)); SFX.play('paper', at(-14.5, 4.4, { delay: 0.3 })); api.toast('No mail. Just an IOU from a rogue.'); }
    else if (id === 'barrel') { SFX.play('thud', at(15, -2)); SFX.play('pour', at(15, -2, { delay: 0.25 })); api.bubble('Glug glug. Dwarven stout, aged 3 days.'); }
    else if (id === 'lute') { SFX.play('tav.lute', at(-6.6, 7.95)); api.bubble('Strums... one chord. The crowd goes mild.'); }
  };
  R.fireBurst = () => { bound = now; SFX.play('fire', at(HX, -7.8)); };
  const base = R.rig.points.map(p => p.intensity);
  R.finish();
  R.tick = (t, dt) => {
    now = t; PK.tick(t); flav.tick(t);
    const kg = t - greet, kn = kg >= 0 && kg < 2.4;
    if (kn && keeper.cur !== 'Cheer') { keeper.play('Cheer'); keeper.cur = 'Cheer'; } else if (!kn && keeper.cur === 'Cheer') { keeper.play('Idle'); keeper.cur = 'Idle'; } keeper.update(dt); dancer.update(dt);
    const L = R.rig.points, b = t - bound, boost = b >= 0 && b < 1.5 ? 1 + (1.5 - b) : 1;
    const slow = (s) => 0.5 + 0.25 * Math.sin(t * 1.7 + s) + 0.25 * Math.sin(t * 2.9 + s * 1.7); // slow smooth fire breathing (>= 2 s)
    L[0].intensity = base[0] * (0.9 + 0.1 * slow(1)) * boost;
    flames.forEach((f, i) => { const k = 0.88 + 0.12 * slow(i * 3); f.scale.set(k * boost, (0.8 + 0.3 * k) * boost, k * boost); });
    fireG.material.opacity = 0.6 * (0.88 + 0.12 * slow(4)) * Math.min(1.4, boost);
    lantG.forEach((g, i) => { g.material.opacity = 0.5 * (0.95 + 0.05 * Math.sin(t * 1.3 + i)); });
    bangs.forEach((s, i) => { s.position.y = 2.75 + Math.sin(t * 2.2 + i * 1.1) * 0.08; });
    const gs = t - gurgle, gu = gs >= 0 && gs < 2.2;
    mrgl.visible = gu; fHead.rotation.z = gu ? Math.sin(gs * 18) * 0.25 : Math.sin(t * 1.3) * 0.05; fMouth.scale.y = gu ? 1 + Math.abs(Math.sin(gs * 14)) * 0.8 : 1;
    fArms.forEach((a, i) => { a.rotation.x = gu ? Math.sin(gs * 16 + i * 3) * 0.9 : 0; });
    const ds = t - dance, dn = ds >= 0 && ds < 5;
    if (dn && dancer.cur !== 'Cheer') { dancer.play('Cheer'); dancer.cur = 'Cheer'; } else if (!dn && dancer.cur === 'Cheer') { dancer.play('Idle'); dancer.cur = 'Idle'; }
    dancer.root.position.y = 0.82 + (dn ? Math.abs(Math.sin(ds * 6)) * 0.12 : 0); dancer.root.rotation.y = 0.6 + (dn ? ds * 2.5 : 0);
    dice.forEach((d, i) => { d.rotation.set(0.4 + i, i * 0.7, 0.2); });
  };
  return R;
}
