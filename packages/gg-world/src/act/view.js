// @ts-check
// Camera close-ups for activities. The main camera stays orthographic; a view = where to look, from which direction,
// how much of the world fits (zoom = half the visible height in world units), and the up vector.
//
//   import { setView, clearView, worldOf } from './view.js';
//   setView(S, { target: worldOf(R, x, 0.8, z), dir: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: -1 }, zoom: 1.6 }); // straight down
//   setView(S, { target: worldOf(R, tvX, 1.2, tvZ), dir: { x: 0.2, y: 0.35, z: 1 }, zoom: 1.4 });                 // over the shoulder
//   clearView(S);  // blends back to the iso camera (always call on exit)
//
// The blend takes ~0.6 s. While a view is set the walls between the camera and the target should not block it:
// call hideOccluders(S, target) to drop every wall on the floor to its low stub until clearView.
import * as THREE from 'three';

/** Room-local point -> world point. */
export function worldOf(R, x, y, z) { return new THREE.Vector3(x + R.root.position.x, y, z + R.root.position.z); }
/** @param {any} S @param {{target:THREE.Vector3, dir:{x:number,y:number,z:number}, up?:{x:number,y:number,z:number}, zoom:number}} v */
export function setView(S, v) { S.view = { target: v.target.clone(), dir: new THREE.Vector3(v.dir.x, v.dir.y, v.dir.z), up: v.up, zoom: v.zoom }; }
export function clearView(S) { S.view = null; S.wallsDown = false; }
/** Lower every wall on the current floor while a close-up is active (the main loop restores normal cutaways). */
export function hideOccluders(S) { S.wallsDown = true; }
