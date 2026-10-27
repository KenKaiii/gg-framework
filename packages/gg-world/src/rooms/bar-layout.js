// @ts-check
// The Terminal (v2): wall decor on the shared walls, slots, Dex's routine and interactables.
import * as THREE from 'three';
import { mat, mesh } from './kit.js';
import * as TX from './tex.js';

const pic = (kind, title, w = 0.6, h = 0.85) => mesh(new THREE.PlaneGeometry(w, h), mat('#ffffff', { map: TX.poster(kind, title) }));

/** Decor on the walls. e/s are shared (drawn by the bar) so only flat onWall decor there; it hides with the wall. */
export function dressWalls(R) {
  // n (exterior, back) posters between jukebox and payphone are taken by the door; a few on the free stretches
  R.onWall('n', pic('band', 'SEGFAULT'), 2.35, 2.35, 0.03);
  R.onWall('n', mesh(new THREE.PlaneGeometry(0.18, 0.08), mat('#ffffff', { map: TX.label('follow the white rabbit', '#e8e8e8', '#111', 256, 96, '30px m5x7') })), 4.75, 0.75, 0.03);
  // w (exterior)
  R.onWall('w', pic('retro', 'IT WORKS ON MY MACHINE', 0.5, 0.7), -1.6, 2.0, 0.03);
  R.onWall('w', pic('movie', 'ROLLBACK', 0.55, 0.75), -4.1, 2.25, 0.03);
  // e (shared with the den): u = world z. Opening z -2.5..2.5
  R.onWall('e', pic('wave', 'SHIP IT FRIDAY'), -4.3, 1.9, 0.03);
  R.onWall('e', pic('space', 'LGTM'), 4.2, 1.8, 0.03);
  // s (shared with the bedroom): u = -world x. Opening x -4.2..-1.8
  R.onWall('s', pic('maze', 'NO TESTS NO MERCY'), -2.6, 1.8, 0.03);
  R.onWall('s', pic('dragon', 'HERE BE LEGACY', 0.55, 0.75), -8.0, 1.9, 0.03);
  R.onWall('s', pic('cat', '404 SLEEP'), 6.6, 1.8, 0.03);
  const happy = mesh(new THREE.PlaneGeometry(1.4, 0.35), new THREE.MeshBasicMaterial({ map: TX.neon('HAPPY HOUR 2-4AM', '#ff4fd8', 512, 128), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  happy.castShadow = false; R.onWall('s', happy, -0.8, 2.6, 0.05);
}

/** 25 places: 8 stools, 6 booth seats, 2 pool, 1 darts, DJ + mic, 6 at the high-tops. */
export function barSlots({ STOOL_X, BOOTH_Z, HT }) {
  const slots = STOOL_X.map((x, i) => ({ id: 'bar-stool-' + (i + 1), kind: 'stool', x, z: -3.45, y: 0.32, face: Math.PI, anim: 'Sit_Chair_Idle', prop: i % 3 === 1 ? 'beer' : i % 3 === 2 ? 'cocktail' : 'laptop', label: 'Bar stool' }));
  BOOTH_Z.forEach((z, i) => {
    slots.push({ id: `bar-booth-${i + 1}a`, kind: 'booth', x: -8.0, z: z - 0.68, y: 0.06, face: 0, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Booth' });
    slots.push({ id: `bar-booth-${i + 1}b`, kind: 'booth', x: -8.0, z: z + 0.68, y: 0.06, face: Math.PI, anim: 'Sit_Chair_Idle', prop: i === 1 ? 'beer' : 'laptop', label: 'Booth' });
  });
  slots.push({ id: 'bar-pool-1', kind: 'stand', x: 2.35, z: 1.25, face: -Math.PI / 2, anim: 'Idle', prop: 'beer', label: 'By the pool table' });
  slots.push({ id: 'bar-pool-2', kind: 'stand', x: -0.7, z: 2.3, face: 2.5, anim: 'Idle', prop: 'beer', label: 'By the pool table' });
  slots.push({ id: 'bar-darts', kind: 'stand', x: -6.2, z: 4.95, face: -Math.PI / 2, anim: 'Idle', prop: 'beer', label: 'Darts' });
  slots.push({ id: 'bar-dj', kind: 'stand', x: 7.1, z: -5.2, y: 0.24, face: 0, anim: 'Idle', prop: 'phone', label: 'DJ decks' });
  slots.push({ id: 'bar-mic', kind: 'stand', x: 6.2, z: -3.85, y: 0.24, face: 0.5, anim: 'Idle', prop: 'beer', label: 'Open mic' });
  HT.forEach(([x, z], i) => {
    slots.push({ id: `bar-high-${i + 1}a`, kind: 'stand', x: x - 0.75, z, face: Math.PI / 2, anim: 'Idle', prop: 'beer', label: 'High-top' });
    slots.push({ id: `bar-high-${i + 1}b`, kind: 'stand', x: x + 0.45, z: z + 0.62, face: Math.atan2(-0.45, -0.62), anim: 'Idle', prop: i === 1 ? 'phone' : 'beer', label: 'High-top' });
  });
  return slots;
}

/** Dex the bartender walks the lane behind the long counter. */
export function barNpc() {
  const N = Math.PI;
  return { x: -3.6, z: -5.0, face: 0, path: [
    { x: -3.6, z: -5.0, face: 0, act: 'Use_Item', say: 'wiping down the counter' },
    { x: -4.6, z: -5.0, face: 0, act: 'Interact', say: 'one Rollback IPA, coming up' },
    { x: -6.6, z: -5.05, face: N, act: 'Interact' },
    { x: -1.4, z: -5.0, face: 0, act: 'Interact', say: 'pint of Hotfix?' },
    { x: -0.6, z: -5.0, face: 0, act: 'Idle', say: 'tab stays open till prod is green' },
    { x: 1.0, z: -4.6, face: N, act: 'Idle', say: 'who put this on?' },
  ] };
}

export function barInteract() {
  return [
    { id: 'jukebox', x: 1.55, z: -4.8, r: 0.9, label: 'Change track', kind: 'jukebox' },
    { id: 'payphone', x: 4.75, z: -5.2, r: 0.8, label: 'Pick up the payphone', kind: 'payphone' },
    { id: 'tv', x: -8.0, z: -3.3, r: 1.0, label: 'Watch TV', kind: 'tv' },
    { id: 'dartboard', x: -6.4, z: 4.95, r: 0.9, label: 'Throw darts', kind: 'darts', vx: -6.85, vz: 4.95, vr: 0.45, vh: 2.0 }, // ring under the board on the wall
    { id: 'decks', x: 7.1, z: -3.5, r: 1.0, label: 'Spin the decks', kind: 'decks' },
  ];
}
