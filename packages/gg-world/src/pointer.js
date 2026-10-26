// @ts-check
// Mouse layer for the 3D world: hover highlight + click to use.
//  - hover: whatever you can use (objects, activity seats, free seats, Dex, members) under the cursor gets a soft warm
//    halo behind it + a glow ring on the floor, the hand cursor and a small label by the cursor
//  - click: members -> profile; anything else -> if in reach, use it now; else the player runs over and uses it on arrival
//    (cancelled by WASD or another click). Empty floor -> walk there (old behaviour). Off the building -> no-entry cursor.
// Picking is screen-space (each target is a short vertical capsule projected to the screen): no raycasts against the
// baked room meshes, ~400 tiny projections at most once per frame. Two extra meshes, drawn only while hovering.
import * as THREE from 'three';
import { CURSOR } from './cursors.js';
import { FONT } from './fonts.js';
import { SFX } from './sfx.js';

const glowTex = (inner, k = 0) => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  if (k) { g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.55, 'rgba(255,255,255,0.05)'); g.addColorStop(0.78, 'rgba(255,255,255,0.9)'); g.addColorStop(0.86, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)'); }
  else { g.addColorStop(0, `rgba(255,255,255,${inner})`); g.addColorStop(0.4, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)'); }
  x.fillStyle = g; x.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); };

/** @param {any} S @param {any} U @param {any} W @param {{ targets:()=>any[], people:()=>any[], interactWith:(n:any)=>void, showProfile:(m:any)=>void, standUp:()=>void, inReach:(n:any)=>boolean }} api */
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export function initPointer(S, U, W, api) {
  const cv = S.renderer.domElement;
  // glow meshes (world space, in the scene root)
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(0.75), transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, opacity: 0 }));
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: glowTex(0, 1), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }));
  halo.renderOrder = 8; ring.renderOrder = 7; halo.visible = ring.visible = false; S.scene.add(halo, ring);
  // the glow itself: one real light that warms up the hovered thing. Always in the scene (intensity 0 when idle) so the
  // shader light count never changes (no recompiles); it only costs one more light in the lighting loop.
  const lamp = new THREE.PointLight("#ffd2a0", 0, 3.2, 1.2); lamp.name = 'hover-light'; S.scene.add(lamp);
  const tip = document.createElement('div'); tip.className = 'hovertip';
  // styled in ui.css.js (.hovertip: the critter speech-bubble look)
  document.body.appendChild(tip);

  const a = new THREE.Vector3(), b = new THREE.Vector3(), fwd = new THREE.Vector3(), tmp = new THREE.Vector3(), wq = new THREE.Vector3();
  let mx = -1, my = -1, dirty = false, hover = /** @type {any} */ (null), glowK = 0, last = null;
  const COL = { item: new THREE.Color('#ffc98a'), seat: new THREE.Color('#ffe7c4'), npc: new THREE.Color('#ffc98a'), member: new THREE.Color('#7ef0b0') };
  /** world anchor of a target (members / Dex move) */
  // where a target IS on screen (the object itself: rooms/focus.js); reach / E prompts still use the hotspot (wx, wz)
  const anchor = n => n.at ? n.at.root.getWorldPosition(wq) : wq.set(n.vx ?? n.wx, 0, n.vz ?? n.wz);
  const segDist = (px, py, ax, ay, bx, by) => { const vx = bx - ax, vy = by - ay, l = vx * vx + vy * vy || 1; let t = ((px - ax) * vx + (py - ay) * vy) / l; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - ax - vx * t, py - ay - vy * t); };

  /** what's under screen point (x, y)? */
  const pickAt = (x, y) => {
    if (U.blocking || U.editing || S.fade || S.view) return null;
    const cam = S.cam, ppw = innerHeight / (cam.top - cam.bottom); cam.getWorldDirection(fwd);
    let best = null, bs = 1e9;
    const test = (n, h, rad, bias) => { const p = anchor(n); if (n.R && n.R.inView === false) return;
      a.set(p.x, 0.05, p.z).project(cam); b.set(p.x, h, p.z).project(cam); if (Math.abs(a.x) > 1.2 || Math.abs(a.y) > 1.2) return;
      const d = segDist(x, y, (a.x + 1) / 2 * innerWidth, (1 - a.y) / 2 * innerHeight, (b.x + 1) / 2 * innerWidth, (1 - b.y) / 2 * innerHeight), rp = rad * ppw;
      if (d > rp) return; const depth = tmp.set(p.x, h / 2, p.z).sub(cam.position).dot(fwd); const s = d / rp + bias + depth * 0.004; if (s < bs) { bs = s; best = n; } };
    for (const n of api.people()) test(n, 1.75, 0.36, -0.25);       // people first: they stand in front of things
    for (const n of api.targets()) if (n.kind === 'npc') test(n, 1.75, 0.4, -0.25); else if (n.kind === 'seat') test(n, 0.85, 0.34, 0.05); else test(n, n.vh ?? 1.15, n.vr != null ? Math.max(0.32, Math.min(1.0, n.vr * 0.9)) : Math.max(0.32, Math.min(0.85, (n.r || 1) * 0.6)), 0);
    return best;
  };
  const rc = new THREE.Raycaster(), ndc = new THREE.Vector2(), ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
  const floorAt = (x, y) => { rc.setFromCamera(ndc.set(x / innerWidth * 2 - 1, -y / innerHeight * 2 + 1), S.cam); if (!rc.ray.intersectPlane(ground, hit)) return null; const R = W.locate(hit.x, hit.z); return R ? { R, hit } : null; };

  let movedAt = 0, hovKey = null, hovSince = 0, hovPlayed = true, hovLast = 0; cv.addEventListener('pointermove', e => { mx = e.clientX; my = e.clientY; dirty = true; movedAt = performance.now(); });
  cv.addEventListener('pointerleave', () => { mx = my = -1; dirty = true; });

  /** run over to a target and use it (or use it now if in reach) */
  const go = n => { SFX.play('ui.click');
    if (n.kind === 'member') { api.showProfile(n.m); return; }
    if (S.seated) { if (n.slot && S.seated.sl === n.slot) return; api.standUp(); }
    if (api.inReach(n)) { S.pending = null; api.interactWith(n); return; }
    // walk to the hotspot (where you use it from), not the object's centre: you must end up in reach
    const p = (n.at ? anchor(n) : wq.set(n.wx, 0, n.wz)).clone(); const T = n.R || W.locate(p.x, p.z) || S.room, o = T.root.position, lx = p.x - o.x, lz = p.z - o.z;
    // the free spot around the target that's closest to the player (so you walk up from your side, not round the back)
    const me = S.me.root.getWorldPosition(new THREE.Vector3()); let bx = 0, bz = 0, bd = 1e9; const r0 = n.kind === 'seat' ? 0.35 : Math.max(0.35, (n.r || 0.8) * 0.75);
    for (const rr of [r0, r0 + 0.25, r0 + 0.5]) for (let k = 0; k < 16; k++) { const an = k / 16 * Math.PI * 2, px = lx + Math.cos(an) * rr, pz = lz + Math.sin(an) * rr;
      if (!T.grid.free(px, pz)) continue; const d = Math.hypot(px + o.x - me.x, pz + o.z - me.z); if (d < bd) { bd = d; bx = px; bz = pz; } }
    if (bd === 1e9) { const f = T.grid.nearestFree(lx, lz); bx = f.x; bz = f.z; }
    S.pending = n; { const pw = anchor(n); U.marker?.show(pw.x, pw.z, 'use', n.vr ?? n.r ?? 0.6, n.at || null); }
    W.route({ get room() { return S.room; } }, S.me, T, bx, bz, () => { if (S.pending !== n) return; S.pending = null; const q = anchor(n), m = S.me.root.getWorldPosition(tmp);
      S.me.root.rotation.y = Math.atan2(q.x - m.x, q.z - m.z); api.interactWith(n); }, 4.6);
  };

  return {
    pickAt, go,
    /** call once per frame (after the camera is final) */
    update(dt, t) {
      dirty = false; hover = mx < 0 ? null : pickAt(mx, my); if (hover && hover.kind !== 'member' && U.cooling?.(hover)) hover = null; U.hoverKey = hover ? U.tkey?.(hover) : ''; // every frame: the camera follows the player, so what's under the cursor changes
      if (U.blocking || U.editing) hover = null;
      // cursor + tooltip
      let cur = CURSOR.default;
      if (U.editing) cur = CURSOR.grab; else if (hover) cur = CURSOR.pointer; else if (mx >= 0 && !U.blocking && !floorAt(mx, my)) cur = CURSOR.no;
      if (cv.style.cursor !== cur) cv.style.cursor = cur;
      if (hover && mx >= 0) { const far = hover.kind !== 'member' && !api.inReach(hover);
        const html = hover.kind === 'member' ? `<span class="pi"><span>View</span><span class="nm">${esc(hover.label)}</span></span>` : `<span class="pi"><span>${esc(hover.label)}</span></span>`;
        if (tip.dataset.h !== html) { tip.innerHTML = html; tip.dataset.h = html; } tip.classList.toggle('talk', hover.kind === 'member'); tip.style.display = 'block'; tip.style.left = mx + 'px'; tip.style.top = my + 'px'; }
      else tip.style.display = 'none';
      // glow eases in/out (~0.15 s), breathes gently
      // hover sound: only when YOU moved onto a new thing and rested on it ~90 ms (not for every target the cursor sweeps
      // across, not when the camera slides things under a still mouse), and at most ~3 a second
      const key = hover ? (hover.it?.id || hover.slot?.id || hover.label) + '@' + (hover.R?.id || '') : null;
      if (key !== hovKey) { hovKey = key; hovSince = performance.now(); hovPlayed = false; }
      if (key && !hovPlayed && performance.now() - hovSince > 90 && performance.now() - movedAt < 600 && performance.now() - hovLast > 320) { hovPlayed = true; hovLast = performance.now(); SFX.play('ui.hover.world'); } if (hover) last = hover;
      glowK += ((hover ? 1 : 0) - glowK) * (1 - Math.exp(-dt / 0.12));
      const n = hover || last; if (!n || glowK < 0.01) { halo.visible = ring.visible = false; lamp.intensity = 0; return; }
      const p = anchor(n), isP = n.kind === 'member' || n.kind === 'npc', h = isP ? 1.75 : n.kind === 'seat' ? 0.8 : (n.vh ?? 1.1);
      const rad = isP ? 0.42 : n.kind === 'seat' ? 0.38 : n.vr != null ? n.vr : Math.max(0.35, Math.min(0.95, (n.r || 1) * 0.65)); S.cam.getWorldDirection(fwd);
      const br = 0.9 + 0.1 * Math.sin(t * 2.4); const c = COL[n.kind] || COL.item;
      halo.visible = ring.visible = true; halo.material.color.copy(c); ring.material.color.copy(c);
      halo.position.set(p.x, h * 0.55, p.z).addScaledVector(fwd, rad + 0.5); halo.scale.setScalar(rad * 2.2 + h * 0.9); halo.material.opacity = 0.3 * glowK * br;
      ring.position.set(p.x, 0.03, p.z); ring.scale.setScalar(rad * 2.2 + 0.3); ring.material.opacity = 0.55 * glowK * br;
      // light sits a little above and in front of the target (camera side), so the face you see lights up
      lamp.color.copy(c); lamp.position.set(p.x, h * 0.7 + 0.45, p.z).addScaledVector(fwd, -0.75); lamp.intensity = (isP ? 26 : 38) * glowK * br;
    },
  };
}
