// @ts-check
// Night Rooms resource control. Owned by the game loop (main.js).
//  - frame cap: never render faster than 60 fps (ProMotion / 120-240 Hz screens would double the work), 30 fps when the
//    window is not focused (game open beside the code editor), nothing when hidden or paused (main.js already stops).
//  - static shadow map: the shadow pass only re-renders when something marked dirty (floor/room change, edit mode,
//    moon crossfade, resize) and every 4 s as a safety net. Moving things never cast into it (roomset.js), so it's stable.
//  - blob shadows: characters don't cast into the shadow map; one instanced soft blob per visible character instead.
//  - adaptive quality: if frames run long for a few seconds, step down (bloom off -> pixel ratio 1.0 -> 0.75 + fewer
//    lamps: the floor light pool, floorlights.js POOL); step back up after a long stretch of headroom. The chosen level is remembered per machine.
import * as THREE from 'three';

const Q_KEY = 'night-rooms-quality';
/** Quality levels, best first. */
// div: render at devicePixelRatio / div. Always a whole number of SCREEN pixels per canvas pixel: at e.g. 1.5x on a 2x
// Retina screen the browser resamples the canvas by 1.33, so every 1 px camera step lands on a different sub-pixel phase
// and fine textures / edges shimmer while walking (tools/screen-shift.mjs: 0.61% of the screen per step vs 0.04% native).
export const LEVELS = [
  { name: 'high', div: 1, bloom: true, lamps: 16 },
  { name: 'balanced', div: 1, bloom: false, lamps: 16 },
  { name: 'low', div: 2, bloom: false, lamps: 12 },
  { name: 'lowest', div: 2, bloom: false, lamps: 8 },
];
/** canvas pixel ratio for a level: native, or half native (2 screen px per canvas px). Huge screens (DPR > 2) cap at 2. */
export const ratioFor = L => { const d = devicePixelRatio || 1; const native = d > 2 ? d / Math.ceil(d / 2) : d; return native / L.div; };

/** @param {{renderer:THREE.WebGLRenderer, bloom:any, scene:THREE.Scene, onRatio?:()=>void}} o */
export function makePerf(o) {
  const { renderer } = o;
  renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true;
  const P = {
    level: 0, forced: /** @type {number|null} */ (null), lastFrame: 0, shadowT: 0, dirty: true,
    intervalEma: 16.7, slowT: 0, fastT: 0, warm: 0, maxLamps: 16,
    /** mark the shadow map stale (something that casts moved, floor changed, etc.) */
    shadowDirty() { P.dirty = true; },
    /** call at the top of the animation loop; false = skip this frame entirely */
    gate(now) {
      const cap = /[?&]fps=30/.test(location.search) ? 31 : 61; // ?fps=30: A/B test of a 30 fps cap
      const minGap = document.hasFocus() ? 1000 / cap : 1000 / 31;
      if (now - P.lastFrame < minGap) return false;
      const gap = Math.min(250, now - P.lastFrame); P.lastFrame = now;
      if (document.hasFocus() && gap < 200) { P.intervalEma += (gap - P.intervalEma) * 0.05; }
      return true;
    },
    /** call once per rendered frame, before rendering */
    frame(dt) {
      // shadows: refresh on demand, plus a 2 Hz safety net
      P.shadowT += dt; if (P.dirty || P.shadowT > 4) { renderer.shadowMap.needsUpdate = true; P.dirty = false; P.shadowT = 0; }
      // adaptive quality (skip the first seconds: shader compiles and asset uploads)
      P.warm += dt; if (P.forced != null || P.warm < 5 || !document.hasFocus()) return;
      if (P.intervalEma > 1000 / 45) { P.slowT += dt; P.fastT = 0; } else if (P.intervalEma < 1000 / 57) { P.fastT += dt; P.slowT = 0; } else { P.slowT = 0; P.fastT = 0; }
      if (P.slowT > 2.5 && P.level < LEVELS.length - 1) { P.set(P.level + 1); P.slowT = 0; P.intervalEma = 16.7; }
      else if (P.fastT > 20 && P.level > 0) { P.set(P.level - 1); P.fastT = 0; }
    },
    /** apply a quality level (0 = best) */
    set(l, persist = true) {
      P.level = Math.max(0, Math.min(LEVELS.length - 1, l)); const L = LEVELS[P.level];
      renderer.setPixelRatio(ratioFor(L)); o.onRatio?.(); if (o.bloom) o.bloom.enabled = L.bloom; P.maxLamps = L.lamps;
      P.dirty = true; if (persist) try { localStorage.setItem(Q_KEY, String(P.level)); } catch { /* storage off */ }
    },
  };
  // start at the remembered level; ?quality=high|balanced|low|lowest forces one (and disables auto)
  const q = new URLSearchParams(location.search).get('quality'); const qi = LEVELS.findIndex(x => x.name === q);
  if (qi >= 0) { P.forced = qi; P.set(qi, false); } else { let s = 0; try { s = Number(localStorage.getItem(Q_KEY) || 0) || 0; } catch { /* storage off */ } P.set(s, false); }
  addEventListener('resize', () => { P.dirty = true; });
  return P;
}

/** Soft round blob under each visible character: one InstancedMesh, one draw call. */
export function makeBlobs(scene, max = 96) {
  const c = document.createElement('canvas'); c.width = c.height = 64; const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.6, 'rgba(0,0,0,0.28)'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  const geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const im = new THREE.InstancedMesh(geo, mat, max); im.count = 0; im.frustumCulled = false; im.renderOrder = 1; im.name = 'blob-shadows'; scene.add(im);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const visible = o => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true; };
  return {
    /** @param {Iterable<any>} avatars objects with .root (THREE.Object3D) */
    update(avatars) {
      let n = 0;
      for (const av of avatars) { if (n >= max) break; const r = av.root; if (!r || !visible(r)) continue;
        r.getWorldPosition(p); const k = Math.max(r.scale.x, r.scale.z) * 0.95; s.set(k, 1, k); p.y = Math.max(0.012, p.y < 0.35 ? 0.012 : p.y - 0.4);
        m4.compose(p, q, s); im.setMatrixAt(n++, m4); }
      im.count = n; im.instanceMatrix.needsUpdate = true;
    },
  };
}
