// @ts-check
// Warm-up while the loading screen is up. three.js compiles a shader, uploads a texture and uploads a model the first
// time each one is drawn, so walking into a part of World you hadn't seen yet hitched while it did that work (owner:
// "it kinda stutters as I roam around, like it's loading"). Each floor is drawn here once, offscreen, through the real
// pipeline (composer, bloom, shadow pass) with frustum culling off and every hidden piece shown, so all of that work is
// done before World fades in. Everything it changes is put back exactly as it was.
import * as THREE from 'three';

const drawn = (/** @type {THREE.Object3D} */ o) => /** @type {any} */ (o).isMesh || /** @type {any} */ (o).isPoints || /** @type {any} */ (o).isLine || /** @type {any} */ (o).isSprite;

/**
 * @param {any} S game state: floors, floor, W (play.js), renderer, scene, cam, comp
 * @param {(i: number, n: number) => void} [onFloor] progress, after each floor
 */
export async function warmUp(S, onFloor) {
  const { renderer, scene } = S;
  const home = S.floor;
  const ids = Object.keys(S.floors).sort();
  /** @type {THREE.Object3D[]} */ const culled = [];
  scene.traverse((/** @type {THREE.Object3D} */ o) => { if (drawn(o) && o.frustumCulled) { o.frustumCulled = false; culled.push(o); } });
  try {
    for (let i = 0; i < ids.length; i++) {
      const id = /** @type {string} */ (ids[i]);
      S.W.showFloor(id); // also builds the floor's lights, so the shaders compile for the light setup they'll draw with
      // hidden pieces (wall stubs, live props, alternate states) get drawn once too; lights stay as they are (the
      // rooms' own lamps are virtual and must never join the render list)
      /** @type {THREE.Object3D[]} */ const shown = [];
      S.floors[id].root.traverse((/** @type {THREE.Object3D} */ o) => { if (!o.visible && !(/** @type {any} */ (o).isLight)) { o.visible = true; shown.push(o); } });
      try {
        renderer.shadowMap.needsUpdate = true; // the shadow pass has its own (depth) shaders
        S.comp.render();
      } finally { for (const o of shown) o.visible = false; }
      onFloor?.(i + 1, ids.length);
      await new Promise(r => setTimeout(r, 0)); // let the app paint its loading screen between floors
    }
  } finally {
    for (const o of culled) o.frustumCulled = true;
    S.W.showFloor(home);
  }
}
