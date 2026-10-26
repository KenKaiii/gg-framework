// @ts-check
// One hemisphere + one shadow moon per floor and a FIXED pool of real
// PointLights. Every room's lightRig points are virtual lamps: they stay out of the render list (visible = false) and
// the pool is handed to the lamps nearest the camera target, fading in/out so nothing pops. three.js shades every
// fragment against every visible light, so the shader light count is the pool size, not 4 x rooms, and never changes
// at runtime (no recompiles) except when the quality level changes the pool's lit size.
import * as THREE from 'three';

export const POOL = 16; // real point lights per floor (the most any quality level uses, see perf.js LEVELS.lamps)
// Game-wide brightness on top of each room's own values (owner: "way too dark"). Still night, but readable.
export const LOOK = { ambient: 1.9, lift: 0.34, moon: 1.9, points: 1.55 };
const LIFT = new THREE.Color('#9aa0c8'), LIFTG = new THREE.Color('#5a4a52');

/** @param {any} floor */
export function makeFloorLights(floor) {
  const hemi = new THREE.HemisphereLight('#3a4374', '#1c1424', 0.85);
  const moon = new THREE.DirectionalLight('#8fa8ff', 0.6); moon.castShadow = true; moon.shadow.mapSize.set(2048, 2048);
  moon.shadow.bias = -0.0005; moon.shadow.normalBias = 0.02;
  // shadow box covering the whole floor
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const R of floor.rooms) { x0 = Math.min(x0, R.box.x0); x1 = Math.max(x1, R.box.x1); z0 = Math.min(z0, R.box.z0); z1 = Math.max(z1, R.box.z1); }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, s = Math.max(x1 - x0, z1 - z0) * 0.62 + 2; const c = moon.shadow.camera;
  c.left = -s; c.right = s; c.top = s; c.bottom = -s; c.near = 0.5; c.far = 80;
  // bias scales with the shadow texel: the v5 ground floor stretched one 2048 map over ~80 m (4 cm texels); a fixed small
  // normalBias left 'shadow acne' on steps / slanted faces, which crawled (flickered) as the view moved by a pixel
  const texel = (2 * s) / 2048; moon.shadow.normalBias = Math.max(0.02, texel * 1.6); moon.shadow.bias = -0.0008;
  moon.target.position.set(cx, 0, cz); floor.root.add(hemi, moon, moon.target);
  // HOUSE AMBIENCE: one fixed ambience + moon per floor, decided once here. It used to crossfade to whichever room you
  // stood in; rooms were tuned with very different fills (bar ~0.06 .. library ~1.05, moon from 4 directions), so the
  // WHOLE visible floor brightened/darkened up to ~5x and shadows swung ~90 degrees as you walked through a doorway.
  // Rooms now differ only by their own lamps, glows and emissives. Single-room floors keep that room's values.
  const lum = c => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const rigs = floor.rooms.map(R => R.rig).filter(r => r?.hemi);
  const sky = new THREE.Color(0, 0, 0), gnd = new THREE.Color(0, 0, 0); const effs = [], moonIs = [];
  for (const r of rigs) { const a = r.hemi.color.clone().lerp(LIFT, LOOK.lift), g = r.hemi.groundColor.clone().lerp(LIFTG, LOOK.lift);
    effs.push(r.hemi.intensity * LOOK.ambient * (lum(a) + lum(g)) / 2); sky.add(a.multiplyScalar(1 / rigs.length)); gnd.add(g.multiplyScalar(1 / rigs.length)); if (r.moon) moonIs.push(r.moon.intensity * LOOK.moon); }
  const median = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
  const HOUSE = { sky, gnd, intensity: rigs.length ? median(effs) / Math.max(1e-3, (lum(sky) + lum(gnd)) / 2) : 1, moonI: moonIs.length ? median(moonIs) : 1, moonDir: new THREE.Vector3() };
  { const r0 = rigs[0]?.moon; if (r0) HOUSE.moonDir.copy(r0.position).sub(r0.target.position); if (HOUSE.moonDir.lengthSq() < 1e-4) HOUSE.moonDir.set(-6, 9, -4); HOUSE.moonDir.normalize().multiplyScalar(30); }
  hemi.color.copy(HOUSE.sky); hemi.groundColor.copy(HOUSE.gnd); hemi.intensity = HOUSE.intensity;
  moon.intensity = HOUSE.moonI; moon.position.copy(moon.target.position).add(HOUSE.moonDir);
  /** virtual lamps: the rooms' own lights, never rendered */
  const lamps = [];
  for (const R of floor.rooms) {
    const rig = R.rig; if (!rig) continue;
    if (rig.hemi) rig.hemi.visible = false;
    if (rig.moon) { rig.moon.visible = false; rig.moon.castShadow = false; }
    for (const l of rig.points || []) { l.castShadow = false; l.visible = false; lamps.push({ l, R, wp: new THREE.Vector3(), d: 0, slot: -1, i: lamps.length }); }
  }
  const pool = [];
  for (let i = 0; i < POOL; i++) { const p = new THREE.PointLight('#ffffff', 0, 6, 1.7); p.name = 'lamp-pool-' + i; floor.root.add(p); pool.push({ p, lamp: /** @type {any} */ (null), w: 0 }); }
  floor.root.updateMatrixWorld(true);
  const tc = new THREE.Color(), tg = new THREE.Color(), wp = new THREE.Vector3(), mdir = new THREE.Vector3(), inv = new THREE.Matrix4();
  let first = true, frame = 0, lit = POOL; const order = lamps.slice(); const lastMoon = new THREE.Vector3(); const lastRank = new THREE.Vector3(1e9, 0, 0); let cutD = Infinity;
  const want = new Set();
  return {
    lamps, pool, moon,
    /** shader light count of this floor (pool size visible) */
    get lit() { return lit; },
    /** true while the moon is still moving (crossfade after a room change) -> shadow map must refresh */
    moonMoving() { const m = moon.position.distanceToSquared(lastMoon) > 1e-4; lastMoon.copy(moon.position); return m; },
    /** kept for the loop's call order; rooms' own intensities are never touched now */
    pre() {},
    /** after room ticks: crossfade ambience to room R, hand the pool to the lamps nearest target */
    post(dt, R, target, maxLit = POOL) {
      // ambience + moon are fixed per floor (set above): nothing to do here when you change rooms
      // pool size by quality: lights past maxLit leave the render list (one recompile per quality change only)
      const n = Math.max(1, Math.min(POOL, maxLit | 0)); if (n !== lit) { lit = n; for (let i = 0; i < POOL; i++) pool[i].p.visible = i < n; }
      // re-rank every 6 frames (lamps are near-static; fading hides the latency)
      ++frame; if (first || (frame % 6 === 0 && lastRank.distanceToSquared(target) > 2.25)) { lastRank.copy(target);
        for (const L of lamps) { L.l.getWorldPosition(L.wp); L.d = L.l.intensity > 0 ? L.wp.distanceToSquared(target) * (L.slot >= 0 ? 0.45 : 1) : 1e12; }
        order.sort((a, b) => a.d - b.d || a.i - b.i);
        want.clear(); for (let i = 0; i < n && i < order.length; i++) if (order[i].d < 1e12) want.add(order[i]);
        cutD = order.length > n && order[n].d < 1e12 ? order[n].wp.distanceTo(target) : Infinity;
        // free slots whose lamp has faded out; hand them to wanted lamps without a slot
        for (const L of order) { if (!want.has(L) || L.slot >= 0) continue;
          let best = -1; for (let i = 0; i < n; i++) { const q = pool[i]; if (!q.lamp) { best = i; break; } if (!want.has(q.lamp) && q.w < 0.03 && best < 0) best = i; }
          if (best < 0) break; const q = pool[best]; if (q.lamp) q.lamp.slot = -1; q.lamp = L; q.w = 0; L.slot = best; }
      }
      first = false;
      inv.copy(floor.root.matrixWorld).invert();
      const kp = 1 - Math.exp(-dt / 0.8);
      for (let i = 0; i < POOL; i++) { const q = pool[i], L = q.lamp; if (!L) { q.p.intensity = 0; continue; }
        let sw = 1; if (cutD < Infinity) { const x = Math.min(1, Math.max(0, (cutD - L.wp.distanceTo(target)) / (cutD * 0.45))); sw = x * x * (3 - 2 * x); }
        const on = i < n && want.has(L); q.w += ((on ? sw : 0) - q.w) * kp;
        if (!on && q.w < 0.03) { L.slot = -1; q.lamp = null; q.p.intensity = 0; continue; }
        // rooms animate their lamp intensities (candles, bad bulbs, scares). A lamp lights a whole patch of floor, so fast
        // swings read as the AREA strobing. Low-pass each lamp (~0.25 s): gentle breathing stays, strobing doesn't.
        const l = L.l; L.s = L.s == null ? l.intensity : L.s + (l.intensity - L.s) * (1 - Math.exp(-dt / 0.25));
        q.p.position.copy(L.wp).applyMatrix4(inv); q.p.color.copy(l.color); q.p.distance = l.distance; q.p.decay = l.decay; q.p.intensity = L.s * q.w * LOOK.points; }
    },
  };
}
