// @ts-check
// Placeholder room used until a real room module exists. Valid against the room contract (see ROOMS-BRIEF.md).
import * as THREE from 'three';
import { makeRoom, lightRig, mat, rbox, put } from './kit.js';
import * as TX from './tex.js';
import { roomInfo } from './floorplan.js';

/** @param {any} ctx @param {{id:string,name:string,to:string[]}} o */
export function stubRoom(ctx, o) {
  // rooms listed in floorplan.js get their real size and openings; anything else is a 9 x 7 box with doors
  const R = roomInfo(o.id) ? makeRoom({ id: o.id, floor: TX.planks('#3a2a24', '#2e211c'), wall: TX.plaster('#2c2f4a') })
    : makeRoom({ w: 9, d: 7, floor: TX.planks('#3a2a24', '#2e211c'), wall: TX.plaster('#2c2f4a'),
      windows: [{ side: 'n', at: 1.5, view: TX.nightView({ seed: o.id.length }) }],
      doors: o.to.map((to, i) => ({ side: /** @type {'w'} */ ('w'), at: -1.5 + i * 2.2, to })) });
  put(R.static, rbox(2.2, 0.8, 0.9, mat('#4a3b52')), 0, 0.4, 0);
  R.rig = lightRig(R.root, { room: R, points: [{ x: 0, y: 2.4, z: 0, color: '#ffb36b', i: 6, d: 7 }] });
  R.meta = { id: o.id, name: o.name + ' (placeholder)', blurb: 'not built yet' };
  R.spawn = { x: 1.5, z: 1.5, face: Math.PI };
  R.slots = [{ id: o.id + '-a', kind: 'stand', x: -1.5, z: 1.5, face: 0, anim: 'Idle', prop: 'drink' }];
  R.interact = []; R.npc = null; R.camera = { zoom: 5.2, target: new THREE.Vector3(0, 0.6, 0) };
  R.tick = () => {}; R.finish(); return R;
}
